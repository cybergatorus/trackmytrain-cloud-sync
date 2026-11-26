process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const http = require('http');
const { chromium } = require('playwright');

const SYNC_TOKEN = process.env.SYNC_TOKEN;
const TARGET_HOST = process.env.TARGET_HOST;
const DURATION_SECONDS = parseInt(process.env.SYNC_DURATION_SECONDS || '0', 10); // 0 = continuous 24/7
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '12000', 10);
const PORT = parseInt(process.env.PORT || '7860', 10);
const RUN_ONCE = process.argv.includes('--once');

if (!SYNC_TOKEN || !TARGET_HOST) {
  console.warn('[Config Warning] TARGET_HOST and SYNC_TOKEN should be set via environment variables.');
}

const PUSH_ENDPOINT = TARGET_HOST && SYNC_TOKEN 
  ? `${TARGET_HOST}/api/push_stream.php?token=${SYNC_TOKEN}` 
  : null;

const PUSH_7DAY_ENDPOINT = TARGET_HOST && SYNC_TOKEN 
  ? `${TARGET_HOST}/api/push_7day.php?token=${SYNC_TOKEN}` 
  : null;

let last7DaySyncTime = 0;
let cached7DayDelays = null;

try {
  const fs = require('fs');
  const path = require('path');
  const initialDelaysPath = path.join(__dirname, 'train7DayDelays.json');
  if (fs.existsSync(initialDelaysPath)) {
    cached7DayDelays = JSON.parse(fs.readFileSync(initialDelaysPath, 'utf8'));
    console.log(`[Config] Loaded initial ${Object.keys(cached7DayDelays).length} 7-day delays from train7DayDelays.json`);
  }
} catch (e) {
  console.warn('[Config] Could not load initial train7DayDelays.json:', e.message);
}

async function sync7DayDelays() {
  try {
    console.log('[Cloud 7-Day Sync] Fetching authentic 7-day average delays from upstream...');
    const dirRes = await fetch('https://paktrainlive.com/trains', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!dirRes.ok) return;
    const html = await dirRes.text();
    const slugs = [...new Set(Array.from(html.matchAll(/\/trains\/([a-z0-9\-]+)/g)).map(m => m[1]))];

    const validDelays = {};
    const chunkSize = 8;
    for (let i = 0; i < slugs.length; i += chunkSize) {
      const chunk = slugs.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async slug => {
        try {
          const res = await fetch('https://paktrainlive.com/trains/' + slug, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          if (res.status === 200) {
            const pageHtml = await res.text();
            const match = pageHtml.match(/<p[^>]*>([0-9.]+[mh]?\s*(?:late|early)?|On time)<\/p>\s*<p[^>]*>7-day avg delay<\/p>/i);
            if (match) {
              const val = match[1].trim();
              validDelays[slug] = val;
              const base = slug.replace(/-(?:1up|2dn|\d+up|\d+dn|\d+)$/i, '');
              validDelays[base] = val;
              validDelays[`${base}-1up`] = val;
              validDelays[`${base}-2dn`] = val;
            }
          }
        } catch {}
      }));
    }

    if (Object.keys(validDelays).length > 0) {
      cached7DayDelays = { ...(cached7DayDelays || {}), ...validDelays };
      last7DaySyncTime = Date.now();
      console.log(`[Cloud 7-Day Sync] Updated ${Object.keys(validDelays).length} authentic 7-day delays in cache.`);

      if (PUSH_7DAY_ENDPOINT) {
        try {
          const pushRes = await fetch(PUSH_7DAY_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Sync-Token': SYNC_TOKEN
            },
            body: JSON.stringify({
              updatedAt: new Date().toISOString(),
              delays: cached7DayDelays
            })
          });
          console.log(`[Cloud 7-Day Sync] Pushed to ${PUSH_7DAY_ENDPOINT} => Status ${pushRes.status}`);
        } catch (pushErr) {
          console.warn('[Cloud 7-Day Sync Notice]: Direct endpoint push skipped:', pushErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[Cloud 7-Day Sync Error]:', err.message);
  }
}

const previousPositions = new Map();

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

let syncStats = {
  status: 'initializing',
  totalSyncs: 0,
  lastSyncTime: null,
  totalLive: 0,
  moving: 0,
  atStation: 0,
  targetConfigured: Boolean(TARGET_HOST && SYNC_TOKEN)
};

// Start lightweight Health Check Server for 24/7 Cloud Hosting
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/health' || req.url === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
      app: 'Transit Telemetry Cloud Streamer',
      version: '2.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      ...syncStats
    }, null, 2));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Health Server] 24/7 Cloud Health Check listening on 0.0.0.0:${PORT}`);
});

async function mainLoop() {
  console.log('='.repeat(70));
  console.log(' [Cloud 24/7 Engine] Transit Telemetry Live Streamer');
  console.log(` Mode: ${DURATION_SECONDS === 0 ? 'CONTINUOUS 24/7 (Non-stop)' : DURATION_SECONDS + 's bounded'}`);
  console.log(` Poll Interval: ${POLL_INTERVAL_MS / 1000}s | HTTP Port: ${PORT}`);
  console.log('='.repeat(70));

  const processStartTime = Date.now();

  while (true) {
    let browser = null;
    try {
      console.log('[Browser] Launching Headless Chromium with genuine fingerprint...');
      const launchOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1280,800'
        ]
      };

      try {
        browser = await chromium.launch(launchOptions);
      } catch (launchErr) {
        if (launchErr.message && launchErr.message.includes("Executable doesn't exist") && process.platform === 'win32') {
          console.log('[Browser] Bundled chromium not found on Windows, trying system channel "chrome"...');
          launchOptions.channel = 'chrome';
          browser = await chromium.launch(launchOptions);
        } else {
          throw launchErr;
        }
      }

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
      });

      const page = await context.newPage();
      console.log('[Browser] Connecting to upstream transit provider...');
      await page.goto('https://paktrainlive.com/', { waitUntil: 'domcontentloaded', timeout: 50000 });
      console.log('[Browser] Waiting 5s for clearance...');
      await page.waitForTimeout(5000);

      const sessionStartTime = Date.now();
      let consecutiveFailures = 0;

      while (true) {
        if (DURATION_SECONDS > 0) {
          const elapsed = (Date.now() - processStartTime) / 1000;
          if (elapsed >= DURATION_SECONDS) {
            console.log(`[Cloud] Reached bounded duration limit (${DURATION_SECONDS}s). Exiting cleanly.`);
            if (browser) await browser.close().catch(() => {});
            process.exit(0);
          }
        }

        // Proactive session rotation every 45 minutes to keep browser fresh and prevent memory/socket staleness
        if (Date.now() - sessionStartTime > 45 * 60 * 1000) {
          console.log('[Cloud Watchdog] 45 minutes elapsed. Proactively rotating browser session to maintain peak freshness...');
          throw new Error('Proactive session rotation');
        }

        try {
          const streamResult = await page.evaluate(async () => {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 14000);

              const res = await fetch('/api/stream', {
                signal: controller.signal,
                headers: {
                  'Accept': 'text/event-stream, */*',
                  'Cache-Control': 'no-cache'
                }
              });

              if (!res.ok) {
                clearTimeout(timeout);
                return { error: 'HTTP_' + res.status };
              }

              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              const t0 = Date.now();

              while (Date.now() - t0 < 12000) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                if (buffer.includes('event: rides:snapshot')) {
                  const m = buffer.match(/event: rides:snapshot\ndata: (.*)\n/);
                  if (m) {
                    clearTimeout(timeout);
                    try { await reader.cancel(); } catch {}
                    return { success: true, data: JSON.parse(m[1].trim()) };
                  }
                }
              }

              clearTimeout(timeout);
              try { await reader.cancel(); } catch {}
              return { error: 'No snapshot event found' };
            } catch (err) {
              return { error: err.message };
            }
          });

          if (streamResult && streamResult.success && Array.isArray(streamResult.data) && streamResult.data.length > 0) {
            consecutiveFailures = 0;
            const rawList = streamResult.data;
            const nowIso = new Date().toISOString();
            const nowMs = Date.now();

            const normalized = rawList.map(train => {
              let speed = train.speed;
              const curLat = Number(train.currentLat);
              const curLon = Number(train.currentLon);
              const key = String(train.id || (train.trainNumber + '_' + (train.departureTime || '')));

              if (speed != null && !isNaN(Number(speed)) && Number(speed) > 0) {
                speed = Number(speed);
              } else {
                const prev = previousPositions.get(key);
                if (prev && curLat && curLon && prev.lat && prev.lon) {
                  const distKm = haversine(prev.lat, prev.lon, curLat, curLon);
                  const elapsedHours = (nowMs - prev.time) / (1000 * 3600);
                  if (elapsedHours > 0 && distKm > 0.03) {
                    const v = Math.round(distKm / elapsedHours);
                    if (v > 0 && v <= 130) speed = v;
                  } else {
                    speed = 0;
                  }
                } else {
                  speed = 0;
                }
              }

              if (curLat && curLon) {
                previousPositions.set(key, { lat: curLat, lon: curLon, time: nowMs, speed: Number(speed) || 0 });
              }

              return {
                ...train,
                speed: Number(speed) || 0,
                extractedAt: nowIso,
                source: 'cloud_relay_stream',
                lastUpdateTime: train.lastUpdateTime || nowIso
              };
            });

            if (normalized.length > 0) {
              const movingCount = normalized.filter(t => (Number(t.speed) || 0) > 0).length;
              const activeCount = normalized.filter(t => t.isActive !== false).length;
              const atStationCount = Math.max(0, activeCount - movingCount);

              const payload = {
                success: true,
                provider: 'cloud_relay',
                updatedAt: nowIso,
                totalLive: normalized.length,
                activeTrains: activeCount,
                movingTrains: movingCount,
                atStationTrains: atStationCount,
                sevenDayDelays: cached7DayDelays,
                data: normalized
              };

              let pushStatus = 'Skipped (No destination configured)';
              if (PUSH_ENDPOINT) {
                const pushRes = await fetch(PUSH_ENDPOINT, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Sync-Token': SYNC_TOKEN
                  },
                  body: JSON.stringify(payload)
                });
                pushStatus = `PUSHED ${pushRes.status}`;
              }

              syncStats.totalSyncs++;
              syncStats.lastSyncTime = nowIso;
              syncStats.totalLive = normalized.length;
              syncStats.moving = movingCount;
              syncStats.atStation = atStationCount;
              syncStats.status = 'transmitting_live';

              console.log(`[Cloud #${syncStats.totalSyncs}] ${nowIso} | ${normalized.length} units (${movingCount} active, ${atStationCount} idle) => ${pushStatus}`);
            }
          } else {
            consecutiveFailures++;
            console.warn(`[Cloud Notice] Snapshot extraction notice (${consecutiveFailures} consecutive):`, streamResult?.error || 'empty');
            if (consecutiveFailures >= 3) {
              console.warn('[Cloud Watchdog] 3 consecutive empty cycles. Reloading page...');
              try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(5000); } catch {}
            }
            if (consecutiveFailures >= 5) {
              console.warn('[Cloud Watchdog] 5 consecutive failures. Forcing clean browser relaunch...');
              throw new Error('Watchdog triggered: SSE stream stalled');
            }
          }
        } catch (cycleErr) {
          console.error('[Cloud Cycle Error]:', cycleErr.message);
        }

        if (RUN_ONCE) {
          if (browser) await browser.close().catch(() => {});
          process.exit(0);
        }

        // Periodic 7-Day Average Delay Synchronization (runs on startup & every 30 mins)
        if (Date.now() - last7DaySyncTime > 30 * 60 * 1000) {
          sync7DayDelays().catch(e => console.error('[7-Day Background Error]:', e.message));
        }

        await page.waitForTimeout(POLL_INTERVAL_MS);
      }
    } catch (browserErr) {
      console.error('[Cloud Worker Session Error]:', browserErr.message);
      syncStats.status = 'reconnecting';
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
        browser = null;
      }
    }

    console.log('[Cloud Worker] Auto-recovering session in 4 seconds...');
    await new Promise(r => setTimeout(r, 4000));
  }
}

mainLoop().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
