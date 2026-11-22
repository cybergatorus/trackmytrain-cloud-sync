# TrackMyTrain.com.pk - 24/7 Cloud Live Telemetry Engine

This repository runs a fully automated, independent cloud sync engine via GitHub Actions.
It ensures that **https://trackmytrain.com.pk** always has 100% genuine, 1:1 real-time telemetry parity with upstream Pakistan Railways live feeds 24 hours a day, 7 days a week, 365 days a year — completely independent of any local computers or laptops.

## How It Works
- Runs every 5 minutes on GitHub's Ubuntu cloud runners via scheduled cron.
- Launches headless Chromium via Playwright, bypassing Cloudflare bot challenges with genuine browser fingerprints.
- Extracts live train snapshots (`rides:snapshot`) containing speed, delays, GPS lat/lng, and station halts.
- Calculates velocities via Haversine distance formulas.
- Pushes directly to `https://trackmytrain.com.pk/api/push_stream.php`.
