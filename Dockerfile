FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Copy package descriptors and install dependencies
COPY package*.json ./
RUN npm ci
RUN npx playwright install chromium

# Copy application source code
COPY . .

# Set cloud environment defaults
ENV PORT=7860
ENV NODE_ENV=production
ENV SYNC_DURATION_SECONDS=0
ENV POLL_INTERVAL_MS=12000
ENV TARGET_HOST=https://trackmytrain.com.pk
ENV SYNC_TOKEN=tmt_live_sync_71e412b8_2026

EXPOSE 7860

# Start 24/7 cloud sync worker
CMD ["node", "sync.js"]
