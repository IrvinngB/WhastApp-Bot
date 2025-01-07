# Usa la imagen oficial de Node.js
FROM node:18-bullseye

# Establece el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copia el archivo package.json y package-lock.json al directorio de trabajo
COPY package*.json ./ 

# Instala las dependencias
RUN npm install

# Copia todo el contenido del proyecto al directorio de trabajo
COPY . .

# Instala Chromium y dependencias adicionales para puppeteer
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
  libxkbfile1 && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

# Expone el puerto en el que corre tu aplicación (3000 en tu caso)
EXPOSE 3000

# Usa PM2 para ejecutar tu bot (si prefieres PM2)
CMD ["pm2-runtime", "bot/bot.js"]

# O usa node directamente (sin PM2)
# CMD ["node", "bot/bot.js"]
