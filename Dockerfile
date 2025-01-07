# Use Node.js Bullseye slim image as base
FROM node:18-bullseye-slim

# Set working directory
WORKDIR /usr/src/app

# Update the system and install Chromium and required dependencies
RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    curl \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set environment variables (remove Puppeteer environment variables)
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=2048" \
    TZ=America/Panama

# Copy package files from root
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy project files
COPY . .

# Create directory for session data
RUN mkdir -p .wwebjs_auth/session-client && \
    chown -R node:node .wwebjs_auth

# Create bot directory if it doesn't exist and set permissions
RUN mkdir -p bot/web && \
    chown -R node:node bot

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application with garbage collection enabled
CMD ["node", "--expose-gc", "bot/bot.js"]
