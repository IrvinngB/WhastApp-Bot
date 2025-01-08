# Usa la imagen oficial de Node.js
FROM node:18-bullseye

# Establece el directorio de trabajo
WORKDIR /usr/src/app

# Instala Chromium y dependencias
RUN apt-get update && apt-get install -y \
    chromium-browser \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxshmfence1 \
    libxtst6 \
    xdg-utils \
    libasound2 \
    libxss1 \
    fonts-liberation \
    libappindicator3-1 \
    libxkbfile1 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Copia los archivos del proyecto
COPY package*.json ./
RUN npm install
COPY . .

# Variables de entorno para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Expone el puerto
EXPOSE 3000

# Inicia la aplicación con Xvfb
CMD ["xvfb-run", "--server-args='-screen 0 1280x800x24'", "node", "bot.js"]