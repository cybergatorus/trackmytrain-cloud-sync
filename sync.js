process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const http = require('http');
const { chromium } = require('playwright');

const SYNC_TOKEN = process.env.SYNC_TOKEN || 'tmt_live_sync_71e412b8_2026';
const TARGET_HOST = process.env.TARGET_HOST || 'https://trackmytrain.com.pk';
const PUSH_ENDPOINT = `${TARGET_HOST}/api/push_stream.php?token=${SYNC_TOKEN}`;
const DURATION_SECONDS = parseInt(process.env.SYNC_DURATION_SECONDS || '0', 10); // 0 = continuous 24/7
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '12000', 10);
const PORT = parseInt(process.env.PORT || '7860', 10);
const RUN_ONCE = process.argv.includes('--once');

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
  targetHost: TARGET_HOST
};

// Start lightweight Health Check Server for 24/7 Cloud Hosting (Render, Koyeb, HuggingFace, Fly.io)
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/health' || req.url === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
      app: 'TrackMyTrain 24/7 Real-Time Cloud Telemetry Engine',
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
  console.log(' [Cloud 24/7 Engine] TrackMyTrain 1:1 Live Telemetry Streamer');
  console.log(` Target Endpoint: ${PUSH_ENDPOINT}`);
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
        if (launchErr.message && launchErr.message.includes("Executable doesn't exist")) {
          console.log('[Browser] Bundled chromium not found, trying system channel "chrome"...');
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
      console.log('[Browser] Navigating to paktrainlive.com ...');
      await page.goto('https://paktrainlive.com/', { waitUntil: 'domcontentloaded', timeout: 50000 });
      console.log('[Browser] Waiting 5s for Cloudflare clearance ...');
      await page.waitForTimeout(5000);

      while (true) {
        if (DURATION_SECONDS > 0) {
          const elapsed = (Date.now() - processStartTime) / 1000;
          if (elapsed >= DURATION_SECONDS) {
            console.log(`[Cloud] Reached bounded duration limit (${DURATION_SECONDS}s). Exiting cleanly.`);
            if (browser) await browser.close().catch(() => {});
            process.exit(0);
          }
        }

        try {
          const streamResult = await page.evaluate(async () => {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 9500);

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

              while (Date.now() - t0 < 8000) {
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
              return { error: 'No rides:snapshot event found' };
            } catch (err) {
              return { error: err.message };
            }
          });

          if (streamResult && streamResult.success && Array.isArray(streamResult.data)) {
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
                data: normalized
              };

              const pushRes = await fetch(PUSH_ENDPOINT, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Sync-Token': SYNC_TOKEN
                },
                body: JSON.stringify(payload)
              });

              syncStats.totalSyncs++;
              syncStats.lastSyncTime = nowIso;
              syncStats.totalLive = normalized.length;
              syncStats.moving = movingCount;
              syncStats.atStation = atStationCount;
              syncStats.status = 'transmitting_live';

              const km = normalized.find(t => t.trainNumber === '1' || (t.trainName && t.trainName.includes('Khyber Mail 1UP')));
              const kmInfo = km ? `Khyber Mail 1UP: ${km.speed} km/h, ${km.delayMinutes}m delay, next: ${km.nextStation}` : 'OK';
              console.log(`[Cloud #${syncStats.totalSyncs}] ${nowIso} | ${normalized.length} trains (${movingCount} moving, ${atStationCount} at station) | ${kmInfo} => PUSHED ${pushRes.status}`);
            }
          } else {
            console.warn(`[Cloud Notice] Stream extraction notice:`, streamResult?.error || 'empty');
          }
        } catch (cycleErr) {
          console.error('[Cloud Cycle Error]:', cycleErr.message);
        }

        if (RUN_ONCE) {
          if (browser) await browser.close().catch(() => {});
          process.exit(0);
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
