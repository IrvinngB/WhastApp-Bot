# Usamos la imagen base de Puppeteer que ya incluye Chrome y la mayoría de dependencias necesarias
FROM ghcr.io/puppeteer/puppeteer:21.5.2

# Establece el directorio donde se colocará y ejecutará la aplicación
WORKDIR /usr/src/app

# Cambia temporalmente al usuario root para poder instalar paquetes
USER root

# Instala las dependencias adicionales necesarias
RUN apt-get update \
    && apt-get install -y \
        xvfb \
        libgbm-dev \
    && rm -rf /var/lib/apt/lists/*

# Copia los archivos de dependencias de Node.js
COPY package*.json ./

# Instala las dependencias de Node.js en modo producción
RUN npm ci

# Copia todo el código fuente de la aplicación
COPY . .

# Configura las variables de entorno necesarias para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Expone el puerto que usará la aplicación
EXPOSE 3000

# Cambia al usuario no privilegiado pptruser por seguridad
# Este usuario viene preconfigurado en la imagen base de Puppeteer
USER pptruser

# Comando para iniciar la aplicación
CMD ["node", "bot/bot.js"]