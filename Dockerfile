# Use Puppeteer's base image
FROM ghcr.io/puppeteer/puppeteer:21.5.2

# Set working directory
WORKDIR /usr/src/app

# Switch to root for installations
USER root

# Install additional dependencies including PM2
RUN apt-get update && apt-get install -y \
    xvfb \
    libgbm-dev \
    procps \
    htop \
    net-tools \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pm2

# Copy dependency files
COPY package*.json ./
COPY ecosystem.config.js ./

# Install Node.js dependencies
RUN npm install

# Copy source code
COPY . .

# Create log directory for PM2
RUN mkdir -p logs

# Configure environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_OPTIONS="--max-old-space-size=512" \
    CHROMIUM_FLAGS="--disable-dev-shm-usage --no-sandbox --disable-gpu --disable-software-rasterizer --js-flags='--expose-gc'" \
    MAX_RECONNECT_ATTEMPTS=10 \
    RECONNECT_DELAY=10000 \
    HEALTH_CHECK_INTERVAL=120000

# Create and configure WhatsApp session directory
RUN mkdir -p .wwebjs_auth/session-client \
    && chown -R pptruser:pptruser .wwebjs_auth \
    && chown -R pptruser:pptruser logs

# Expose port
EXPOSE 3000

# Switch to non-root user
USER pptruser

# Start the application using PM2
CMD ["pm2-runtime", "ecosystem.config.js"]