# Usa la imagen oficial de Node.js
FROM node:18-bullseye-slim

# Establece el directorio de trabajo
WORKDIR /usr/src/app

# Instala las dependencias necesarias
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
       fonts-ipafont-gothic \
       fonts-wqy-zenhei \
       fonts-thai-tlwg \
       fonts-khmeros-core \
       fonts-liberation \
       libxss1 \
       libxtst6 \
       libatk-bridge2.0-0 \
       libgtk-3-0 \
       libasound2 \
       libgbm1 \
       xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /src/*.deb

# Copia los archivos del proyecto
COPY package*.json ./

# Instala las dependencias de Node.js
RUN npm install

# Copia el resto de los archivos
COPY . .

# Variables de entorno para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

# Expone el puerto
EXPOSE 3000

# Inicia la aplicación con Xvfb
CMD ["xvfb-run", "--server-args='-screen 0 1280x800x24'", "node", "bot.js"]