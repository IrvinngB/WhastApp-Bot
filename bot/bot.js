require('dotenv').config();

const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const StabilityManager = require('./stability');

// Manejo de memoria
const used = process.memoryUsage();
console.log('Uso de memoria:', {
    rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`
});

// Limpieza periódica de memoria
setInterval(() => {
    global.gc();
}, 30 * 60 * 1000); // Cada 30 minutos

// Constantes y configuración
const PANAMA_TIMEZONE = "America/Panama";
const PORT = process.env.PORT || 3000;
const PAUSE_DURATION = 60 * 60 * 1000; // 1 hora en milisegundos

// Estado global
const pausedUsers = {};
const contextStore = {};

// Verificar variables de entorno requeridas
if (!process.env.GEMINI_API_KEY) {
    throw new Error('La variable de entorno GEMINI_API_KEY no está configurada.');
}

// Inicializar Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Función mejorada para cargar archivos
function loadFile(filePath, defaultValue = '') {
    try {
        const fullPath = path.join(__dirname, filePath);
        if (!fs.existsSync(fullPath)) {
            console.warn(`Archivo no encontrado: ${filePath}`);
            return defaultValue;
        }
        return fs.readFileSync(fullPath, 'utf8');
    } catch (error) {
        console.error(`Error leyendo el archivo ${filePath}:`, error);
        return defaultValue;
    }
}

// Cargar información desde archivos
const laptops = loadFile('Laptops1.txt');
const companyInfo = loadFile('info_empresa.txt');
const promptInstructions = loadFile('promt.txt');

// Función mejorada para generar respuestas
async function generateResponse(userMessage, contactId) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    try {
        const userContext = contextStore[contactId] || '';
        
        const customPrompt = `
        Eres un asistente virtual especializado en atender a los clientes de ElectronicsJS. Tus funciones principales incluyen:

        1. **Proporcionar Información de la Empresa:** Ofrecer detalles sobre ElectronicsJS, como misión, visión, valores, productos, ubicación, horarios de atención y políticas de la tienda.

        2. **Responder Solicitudes de Información:** Atender preguntas sobre los productos disponibles, incluyendo componentes y especificaciones de las laptops listadas.

        3. **Verificar Horarios de Apertura:** Antes de responder preguntas sobre la tienda, verifica si está abierta según la zona horaria de Panamá.

        4. **Manejar Preguntas Generales:** Si recibes preguntas no relacionadas con ElectronicsJS, indica que solo puedes proporcionar información sobre la empresa y sus productos.

        5. **Respetar Privacidad:** No puedes divulgar información personal o sensible de los clientes ni información confidencial de la empresa.

        **Información de Referencia:**
        - **ElectronicsJS:** ${companyInfo}
        - **Laptops Disponibles:** ${laptops}
        - **Contexto del Usuario:** ${userContext}

        Responde de manera clara, directa y breve a la siguiente solicitud del cliente: "${userMessage}".`;

        const result = await model.generateContent(customPrompt);
        const text = result.response.text();

        // Actualizar contexto limitando su tamaño
        contextStore[contactId] = `${userContext.slice(-1000)}\nUsuario: ${userMessage}\nBot: ${text}`.trim();

        return text;
    } catch (error) {
        console.error('Error generando la respuesta:', error);
        return 'Lo siento, estamos experimentando dificultades técnicas. Por favor, intenta nuevamente en unos momentos.';
    }
}

// Función mejorada para verificar horario de apertura
function isStoreOpen() {
    const panamaTime = moment().tz(PANAMA_TIMEZONE);
    const day = panamaTime.day();
    const hour = panamaTime.hour();

    const schedule = {
        weekday: { start: 9, end: 20 },
        weekend: { start: 10, end: 18 }
    };

    const isWeekday = day >= 1 && day <= 5;
    const { start, end } = isWeekday ? schedule.weekday : schedule.weekend;

    return hour >= start && hour < end;
}

// Configurar el cliente de WhatsApp con opciones optimizadas para Render
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
            '--disable-gpu'
        ],
        headless: "new",
        timeout: 0
    }
});

// Configurar Express y Socket.IO
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Inicializar StabilityManager
const stabilityManager = new StabilityManager(whatsappClient);

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

// Manejador mejorado de mensajes
whatsappClient.on('message', async message => {
    stabilityManager.updateLastMessage();
    
    const contactId = message.from;

    if (pausedUsers[contactId]) {
        console.log(`Usuario ${contactId} en pausa`);
        return;
    }

    if (message.hasMedia) {
        if (message.type === 'audio') {
            await message.reply('Te conectaremos con un asistente humano.');
            pausedUsers[contactId] = true;
        }
        return;
    }

    const messageText = message.body.toLowerCase();
    
    if (['spam', 'publicidad', 'promo'].some(word => messageText.includes(word))) {
        return;
    }

    if (messageText.includes('contactar persona real')) {
        await message.reply('Conectando con un asistente humano. Por favor espera.');
        pausedUsers[contactId] = true;
        
        setTimeout(() => {
            if (pausedUsers[contactId]) {
                delete pausedUsers[contactId];
                whatsappClient.sendMessage(contactId, 'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?');
            }
        }, PAUSE_DURATION);
        
        return;
    }

    try {
        const responseText = messageText === 'hola' 
            ? '¡Hola! ¿En qué puedo ayudarte con respecto a ElectronicsJS?'
            : isStoreOpen()
                ? await generateResponse(message.body, contactId)
                : 'Nuestra tienda está cerrada en este momento. Horario: Lun-Vie 9am-8pm, Sáb-Dom 10am-6pm (hora de Panamá)';

        await message.reply(responseText);
    } catch (error) {
        console.error('Error procesando mensaje:', error);
        await message.reply('Lo siento, ocurrió un error. Por favor, intenta nuevamente.');
    }
});

// Configuración de rutas Express
app.use(express.static(path.join(__dirname, 'web')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// Iniciar el sistema de estabilidad
stabilityManager.startStabilitySystem(app);

// Iniciar servidor
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