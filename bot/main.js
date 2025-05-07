require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const qrcode = require('qrcode');
const { Client } = require('whatsapp-web.js');

// Importar módulos
const { initializeAI, generateResponse, selectRelevantDatasetWithAI } = require('./modules/ai-service');
const { handleMessage, queueMessage, processMessageQueue } = require('./modules/message-handler');
const { getStoreStatus, SYSTEM_MESSAGES } = require('./modules/utils');
const { loadFile, fileCache } = require('./modules/file-manager');
const StabilityManager = require('./modules/stability-manager');

// Constantes y configuración
const PORT = process.env.PORT || 3000;

// Configurar el cliente de WhatsApp con opciones optimizadas
const whatsappClient = new Client({
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--disable-features=site-per-process',
            '--js-flags="--max-old-space-size=512"'
        ],
        headless: "new",
        timeout: 0
    },
    clientId: 'electronics-js-bot',
    restartOnAuthFail: true
});

// Inicializar el StabilityManager
const stabilityManager = new StabilityManager(whatsappClient);

// Configurar Express y Socket.IO
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,
    pingInterval: 25000
});

// Configuración de rutas Express
app.use(express.static(path.join(__dirname, 'web')));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// Manejadores de eventos de WhatsApp
whatsappClient.on('qr', (qr) => {
    qrcode.toDataURL(qr)
        .then(url => io.emit('qr', url))
        .catch(err => console.error('Error generando QR:', err));
});

whatsappClient.on('ready', () => {
    console.log('Cliente WhatsApp Web listo');
    io.emit('ready', 'Cliente WhatsApp Web listo');
});

whatsappClient.on('loading_screen', (percent, message) => {
    console.log('Cargando:', percent, '%', message);
    io.emit('loading', { percent, message });
});

// Evento de mensaje con cola
whatsappClient.on('message', async (message) => {
    try {
        await queueMessage(message, handleMessage, whatsappClient, stabilityManager);
    } catch (error) {
        console.error('Error en cola de mensajes:', error);
    }
});

// Iniciar el sistema de estabilidad
stabilityManager.startStabilitySystem(app);

// Iniciar servidor con manejo de errores
server.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (error) => {
    console.error('Error no manejado:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Excepción no capturada:', error);
});

// Limpieza al cerrar
process.on('SIGINT', async () => {
    console.log('Cerrando aplicación...');
    await whatsappClient.destroy();
    process.exit();
});

// Exportar para uso en otros módulos
module.exports = {
    whatsappClient,
    io,
    stabilityManager
};
