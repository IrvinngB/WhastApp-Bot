# Usamos la imagen base de Puppeteer que ya incluye Chrome y la mayoría de dependencias necesarias
FROM ghcr.io/puppeteer/puppeteer:21.5.2

# Establece el directorio donde se colocará y ejecutará la aplicación
WORKDIR /usr/src/app

# Cambia temporalmente al usuario root para poder instalar paquetes
USER root

# Elimina los archivos de configuración conflictivos de Google Chrome
RUN rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google.list

# Instala las dependencias adicionales necesarias sin depender del repositorio de Google
RUN apt-get update && apt-get install -y \
    xvfb \
    libgbm-dev \
    procps \
    htop \
    net-tools \
    && rm -rf /var/lib/apt/lists/*

# Copia los archivos de dependencias de Node.js
COPY package*.json ./

# Instala las dependencias de Node.js en modo producción
RUN npm install

# Instala PM2 globalmente
RUN npm install pm2 -g

# Copia todo el código fuente de la aplicación
COPY . .

# Configura las variables de entorno necesarias
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_OPTIONS="--max-old-space-size=512" \
    # Variables para gestión de memoria de Puppeteer
    CHROMIUM_FLAGS="--disable-dev-shm-usage --no-sandbox --disable-gpu --disable-software-rasterizer --js-flags='--expose-gc'" \
    # Variables para el sistema de estabilidad
    MAX_RECONNECT_ATTEMPTS=10 \
    RECONNECT_DELAY=10000 \
    HEALTH_CHECK_INTERVAL=120000

# Crea y configura el directorio para la sesión de WhatsApp
RUN mkdir -p .wwebjs_auth/session-client \
    && chown -R pptruser:pptruser .wwebjs_auth

# Expone el puerto que usará la aplicación
EXPOSE 3000

# Cambia al usuario no privilegiado pptruser por seguridad
USER pptruser

# Comando para iniciar la aplicación con PM2
CMD ["pm2-runtime", "bot/bot.js"]