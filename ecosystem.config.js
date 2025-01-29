module.exports = {
    apps: [{
      name: 'whatsapp-bot',
      script: 'bot.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true',
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
        NODE_OPTIONS: '--max-old-space-size=512',
        CHROMIUM_FLAGS: '--disable-dev-shm-usage --no-sandbox --disable-gpu --disable-software-rasterizer --js-flags=--expose-gc'
      },
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      time: true,
      exp_backoff_restart_delay: 100
    }]
  };