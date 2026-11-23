FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Copy package descriptors and install dependencies
COPY package*.json ./
RUN npm ci
RUN npx playwright install chromium

# Copy application source code
COPY . .

# Set cloud environment defaults (sensitive values are injected via Environment Variables)
ENV PORT=7860
ENV NODE_ENV=production
ENV SYNC_DURATION_SECONDS=0
ENV POLL_INTERVAL_MS=12000

EXPOSE 7860

# Start 24/7 cloud sync worker
CMD ["node", "sync.js"]
