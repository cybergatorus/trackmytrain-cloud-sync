const { chromium } = require('playwright');

const SYNC_TOKEN = process.env.SYNC_TOKEN || 'tmt_live_sync_71e412b8_2026';
const TARGET_HOST = process.env.TARGET_HOST || 'https://trackmytrain.com.pk';
const PUSH_ENDPOINT = `${TARGET_HOST}/api/push_stream.php?token=${SYNC_TOKEN}`;
const DURATION_SECONDS = parseInt(process.env.SYNC_DURATION_SECONDS || '290', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '14000', 10);
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

async function run() {
  console.log('='.repeat(65));
  console.log(' [Cloud 24/7 Engine] TrackMyTrain Live Telemetry Sync');
  console.log(` Target Endpoint: ${PUSH_ENDPOINT}`);
  console.log(` Duration: ${DURATION_SECONDS}s | Interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log('='.repeat(65));

  const startTime = Date.now();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();
    console.log('[Cloud] Navigating to paktrainlive.com ...');
    await page.goto('https://paktrainlive.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('[Cloud] Waiting 5s for Cloudflare clearance ...');
    await page.waitForTimeout(5000);

    let syncCount = 0;

    while (true) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      if (!RUN_ONCE && elapsedSeconds >= DURATION_SECONDS) {
        console.log(`[Cloud] Reached duration limit (${DURATION_SECONDS}s). Clean handoff.`);
        break;
      }

      syncCount++;
      try {
        const streamResult = await page.evaluate(async () => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 9000);

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

            if (pushRes.ok) {
              const km = normalized.find(t => t.trainNumber === '1' || (t.trainName && t.trainName.includes('Khyber Mail 1UP')));
              const kmInfo = km ? `Khyber Mail 1UP: ${km.speed} km/h, ${km.delayMinutes}m delay, next: ${km.nextStation}` : 'OK';
              console.log(`[Cloud #${syncCount}] ${nowIso} | ${normalized.length} trains (${movingCount} moving, ${atStationCount} at station) | ${kmInfo} => PUSHED OK`);
            } else {
              console.warn(`[Cloud #${syncCount}] Push returned HTTP ${pushRes.status}`);
            }
          }
        } else {
          console.warn(`[Cloud #${syncCount}] Stream extraction notice:`, streamResult?.error || 'empty');
        }
      } catch (loopErr) {
        console.error(`[Cloud #${syncCount}] Error during cycle:`, loopErr.message);
      }

      if (RUN_ONCE) break;
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }
  } catch (fatalErr) {
    console.error('[Cloud FATAL]', fatalErr);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

run();
