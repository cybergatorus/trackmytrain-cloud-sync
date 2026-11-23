# High-Performance Transit Telemetry Streamer

A cloud-native telemetry ingestion and streaming engine designed for high-frequency GPS positioning and transit data normalization.

## Overview
- Automated continuous ingestion via headless browser automation.
- Resilient session auto-recovery and Cloudflare-compatible browsing fingerprints.
- Velocity calculation via spherical Haversine formulas.
- Zero-downtime health monitoring endpoint (`/health`).

## Configuration
All configuration parameters are supplied via environment variables:

| Variable | Description |
| :--- | :--- |
| `TARGET_HOST` | Remote destination base URL |
| `SYNC_TOKEN` | Secure authentication token |
| `POLL_INTERVAL_MS` | Ingestion poll frequency in milliseconds (default: 12000) |
| `SYNC_DURATION_SECONDS` | Bounded execution time in seconds (0 for non-stop 24/7) |
| `PORT` | Health check HTTP port (default: 7860) |

## Deployment
Can be deployed via Docker, Kubernetes, Render, Koyeb, or serverless scheduled workflows.
