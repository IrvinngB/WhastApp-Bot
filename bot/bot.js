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
const cron = require('node-cron');

// Manejo de memoria optimizado
let used = process.memoryUsage();
console.log('Uso de memoria inicial:', {
    rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`
});

// Control de estado global y rate limiting
let isProcessingMessage = false;
let messageQueue = [];
const MAX_QUEUE_SIZE = 100;
const MESSAGE_TIMEOUT = 60000; // 60 segundos

// Sistema de rate limiting
const MESSAGE_RATE_LIMIT = {
    WINDOW_MS: 60000, // 1 minuto
    MAX_MESSAGES: 10  // máximo 10 mensajes por minuto
};

const userMessageCounts = new Map();

// Constantes y configuración
const MEDIA_TYPES = {
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    DOCUMENT: 'document',
    STICKER: 'sticker'
};

const SPAM_PATTERNS = [
    'spam',
    'publicidad',
    'promo',
    'gana dinero',
    'investment',
    'casino',
    'lottery',
    'premio',
    'ganaste',
    'bitcoin',
    'crypto',
    'prestamo',
    'loan',
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // Email pattern
    /(?:https?:\/\/)?(?:[\w\-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?/, // URL pattern
];

const PANAMA_TIMEZONE = "America/Panama";
const PORT = process.env.PORT || 3000;
const PAUSE_DURATION = 60 * 60 * 1000;
const MAX_RETRIES = 3;

// Estado global con gestión de memoria mejorada
const pausedUsers = new Map();
const contextStore = new Map();
const userRequestsHuman = new Map();
const lastUserMessages = new Map(); // Para detectar mensajes repetidos
const spamCooldown = new Map(); // Para manejar el cooldown después de detectar spam

// Sistema de mensajes mejorado
const SYSTEM_MESSAGES = {
    WELCOME: `¡Hola! 👋 Soy Electra, el asistente virtual de ElectronicsJS. Estoy aquí para ayudarte con información sobre nuestros productos y servicios. 

Si en cualquier momento deseas hablar con un representante humano, puedes escribir "agente" o "hablar con persona real".

¿En qué puedo ayudarte hoy?`,
    
    HUMAN_REQUEST: `Entiendo que prefieres hablar con un representante humano. Voy a conectarte con uno de nuestros agentes.

⏳ Por favor, ten en cuenta que puede haber un tiempo de espera. Mientras tanto, ¿hay algo específico en lo que pueda ayudarte?

Para volver al asistente virtual en cualquier momento, escribe "volver al bot".`,
    
    STORE_CLOSED: `🕒 Nuestra tienda está cerrada en este momento.

    Horario de atención:
    - Lunes a Viernes: 6:00 AM - 10:00 PM
    - Sábados y Domingos: 7:00 AM - 8:00 PM
    (Hora de Panamá)

    Aunque la tienda está cerrada, puedo ayudarte con:
    - Información básica sobre productos
    - Información sobre la empresa
    - Preguntas frecuentes

    Para consultas más complejas, como hacer reclamos o realizar compras, te recomiendo visitar nuestra página web: https://irvin-benitez.software o contactarnos durante nuestro horario de atención.

    ¿En qué puedo ayudarte?`,

    ERROR: `Lo siento, estamos experimentando dificultades técnicas. Por favor, intenta nuevamente en unos momentos.

Si el problema persiste, puedes escribir "agente" para hablar con una persona real.`,

    TIMEOUT: `Lo siento, tu mensaje está tomando más tiempo del esperado. Por favor, intenta nuevamente o escribe "agente" para hablar con una persona real.`,

    MEDIA_RECEIVED: `¡Gracias por compartir este contenido! 📁

Para brindarte una mejor atención, te conectaré con uno de nuestros representantes que podrá revisar tu archivo y ayudarte personalmente.

⏳ Un agente se pondrá en contacto contigo pronto. Mientras tanto, ¿hay algo específico que quieras mencionar sobre el archivo compartido?`,

    SPAM_WARNING: `⚠️ Has enviado demasiados mensajes repetidos. Por favor, espera 2 minutos antes de enviar más mensajes.`,

    RATE_LIMIT: `⚠️ Has enviado demasiados mensajes en poco tiempo. 

Por favor, espera un momento antes de enviar más mensajes. Esto nos ayuda a mantener una conversación más efectiva. 

Si tienes una urgencia, escribe "agente" para hablar con una persona real.`,

    REPEATED_MESSAGE: `Parece que estás enviando el mismo mensaje repetidamente. 

¿Hay algo específico en lo que pueda ayudarte? Si necesitas hablar con un agente humano, solo escribe "agente".`,

HORARIO: `Horario de atención:
    - Lunes a Viernes: 6:00 AM - 10:00 PM
    - Sábados y Domingos: 7:00 AM - 8:00 PM
    (Hora de Panamá)`,
    WEB_PAGE: `Para más información, visita nuestra página web: https://irvin-benitez.software. Estamos aquí para ayudarte con cualquier consulta que tengas sobre nuestros productos y servicios. ¡Gracias por elegir ElectronicsJS!`
};

// Verificación de variables de entorno
if (!process.env.GEMINI_API_KEY) {
    throw new Error('La variable de entorno GEMINI_API_KEY no está configurada.');
}

// Inicializar Google Generative AI con manejo de errores
let genAI;
try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} catch (error) {
    console.error('Error inicializando Google Generative AI:', error);
    process.exit(1);
}

// Función mejorada para cargar archivos con caché
const fileCache = new Map();
function loadFile(filePath, defaultValue = '') {
    try {
        if (fileCache.has(filePath)) {
            return fileCache.get(filePath);
        }

        const fullPath = path.join(__dirname, filePath);
        if (!fs.existsSync(fullPath)) {
            console.warn(`Archivo no encontrado: ${filePath}`);
            return defaultValue;
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        fileCache.set(filePath, content);
        return content;
    } catch (error) {
        console.error(`Error leyendo el archivo ${filePath}:`, error);
        return defaultValue;
    }
}

// Cargar información desde archivos con manejo de errores
let laptops, companyInfo, promptInstructions;
try {
    laptops = loadFile('Laptops1.txt');
    companyInfo = loadFile('info_empresa.txt');
    promptInstructions = loadFile('promt.txt');
} catch (error) {
    console.error('Error cargando archivos de configuración:', error);
    process.exit(1);
}

// Sistema de rate limiting mejorado
function checkRateLimit(userId) {
    const now = Date.now();
    const userCount = userMessageCounts.get(userId) || { count: 0, timestamp: now };

    // Limpiar contadores antiguos
    if (now - userCount.timestamp > MESSAGE_RATE_LIMIT.WINDOW_MS) {
        userCount.count = 1;
        userCount.timestamp = now;
    } else {
        userCount.count++;
    }

    userMessageCounts.set(userId, userCount);
    return userCount.count > MESSAGE_RATE_LIMIT.MAX_MESSAGES;
}

// Función para detectar mensajes repetidos
function isRepeatedMessage(userId, message) {
    const lastMessage = lastUserMessages.get(userId);
    const currentMessage = message.toLowerCase().trim();
    
    if (lastMessage && lastMessage.text === currentMessage) {
        lastMessage.count++;
        if (lastMessage.count >= 4) { // Si el usuario envía 4 mensajes iguales
            lastMessage.count = 0; // Reiniciar el contador
            return true; // Indicar que se debe aplicar el cooldown
        }
    } else {
        lastUserMessages.set(userId, {
            text: currentMessage,
            count: 1,
            timestamp: Date.now()
        });
    }
    
    return false;
}

// Función para detectar spam
function isSpamMessage(message) {
    const messageText = message.body.toLowerCase();
    
    // Verificar patrones de spam
    const containsSpamPattern = SPAM_PATTERNS.some(pattern => {
        if (pattern instanceof RegExp) {
            return pattern.test(messageText);
        }
        return messageText.includes(pattern);
    });

    // Verificar características sospechosas
    const hasMultipleUrls = (messageText.match(/https?:\/\//g) || []).length > 1;
    const hasMultiplePhoneNumbers = (messageText.match(/\b\d{8,}\b/g) || []).length > 1;
    const hasExcessivePunctuation = (messageText.match(/[!?]/g) || []).length > 5;
    
    return containsSpamPattern || hasMultipleUrls || hasMultiplePhoneNumbers || hasExcessivePunctuation;
}

// Función mejorada para generar respuestas
async function generateResponse(userMessage, contactId, retryCount = 0) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    try {
        const userContext = contextStore.get(contactId) || '';

        const customPrompt = `
        Eres Electra, asistente virtual de ElectronicsJS. Sé amable, profesional y usa emojis ocasionalmente.
        
        FUNCIONES:
        - Información de productos/laptops: ${laptops}
        - Información de la empresa: ${companyInfo}
        - Servicio al cliente (garantías, compras, devoluciones)
        
        CONTEXTO:
        ${userContext}
        
        No compartas información confidencial ni hagas promesas sobre precios o disponibilidad.
        
        RESPONDE A: "${userMessage}"
        
        Mantén respuestas concisas (máximo 5 líneas) y usa viñetas para listas.`;

        const result = await Promise.race([
            model.generateContent(customPrompt),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('TIMEOUT')), MESSAGE_TIMEOUT)
            )
        ]);

        let text = result.response.text();

        // Verificar si el cliente ha expresado interés en comprar o cotizar
        const purchaseKeywords = ['comprar', 'cotizar', 'llevar', 'adquirir', 'quiero comprar', 'precio', 'costo'];
        const isPurchaseIntent = purchaseKeywords.some(keyword => userMessage.toLowerCase().includes(keyword));

        // Solo agregar el mensaje de compra si el cliente ha expresado interés en comprar
        if (isPurchaseIntent) {
            text += `\n\n¿Te gustaría comprar esta laptop? Aquí tienes las opciones disponibles:
            - 🗣️ Hablar con un agente real: Escribe "agente" para conectarte con un representante.
            - 🌐 Comprar en línea: Visita nuestra página web: https://irvin-benitez.software
            - 🏬 Visitar la tienda: Estamos ubicados en La chorrera. ¡Te esperamos!`;
        }

        // Actualizar contexto con límite de memoria
        const newContext = `${userContext.slice(-1000)}\nUsuario: ${userMessage}\nBot: ${text}`.trim();
        contextStore.set(contactId, newContext);

        return text;
    } catch (error) {
        console.error('Error generando la respuesta:', error);

        if (error.message === 'TIMEOUT' && retryCount < MAX_RETRIES) {
            console.log(`Reintentando generación de respuesta (${retryCount + 1}/${MAX_RETRIES})...`);
            return generateResponse(userMessage, contactId, retryCount + 1);
        }

        return SYSTEM_MESSAGES.ERROR;
    }
}

// === NUEVO: Decisión de acción por IA ===
async function decideAction(userMessage, contactId) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const lowPrompt = `Eres un sistema de control de flujo para un bot de atención al cliente de ElectronicsJS. Analiza el mensaje del usuario y decide SOLO UNA de las siguientes acciones, devolviendo SIEMPRE un JSON válido con la estructura { "action": "accion", "file": "archivo" }:

- "to_human": Si el usuario pide hablar con un humano o el caso lo requiere.
- "freeze": Si el usuario debe ser bloqueado/congelado temporalmente (por spam, medios, etc).
- "info_empresa": Si la mejor respuesta es enviar la información de la empresa.
- "info_laptops": Si la mejor respuesta es enviar la información de laptops/productos.
- "continue": Si se debe continuar con el prompt final de IA (respuesta personalizada).

El campo "file" debe ser uno de: "info_empresa.txt", "Laptops1.txt", "" (vacío si no aplica).

Ejemplo de salida: { "action": "info_empresa", "file": "info_empresa.txt" }

Mensaje del usuario: "${userMessage}"
`;
    try {
        const result = await Promise.race([
            model.generateContent(lowPrompt),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 15000))
        ]);
        const text = result.response.text();
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]);
        }
        // fallback seguro
        return { action: "continue", file: "" };
    } catch (e) {
        return { action: "continue", file: "" };
    }
}

// Función para manejar mensajes con medios
async function handleMediaMessage(message) {
    const mediaType = message.type;
    let responseText = SYSTEM_MESSAGES.MEDIA_RECEIVED;

    // Personalizar mensaje según el tipo de medio
    switch (mediaType) {
        case MEDIA_TYPES.IMAGE:
            responseText = `${responseText}\n\n📸 He notado que has compartido una imagen.`;
            break;
        case MEDIA_TYPES.AUDIO:
            responseText = `${responseText}\n\n🎵 He notado que has compartido un mensaje de voz.`;
            break;
        case MEDIA_TYPES.VIDEO:
            responseText = `${responseText}\n\n🎥 He notado que has compartido un video.`;
            break;
        case MEDIA_TYPES.DOCUMENT:
            responseText = `${responseText}\n\n📄 He notado que has compartido un documento.`;
            break;
    }

    try {
        await message.reply(responseText);
        pausedUsers.set(message.from, true);
        userRequestsHuman.set(message.from, true);

        // Programar la limpieza después del período de pausa
        setTimeout(() => {
            if (pausedUsers.get(message.from)) {
                pausedUsers.delete(message.from);
                userRequestsHuman.delete(message.from);
                whatsappClient.sendMessage(message.from, 'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?');
            }
        }, PAUSE_DURATION);

    } catch (error) {
        console.error('Error handling media message:', error);
        await message.reply(SYSTEM_MESSAGES.ERROR);
    }
}

// Función mejorada para verificar horario
function getStoreStatus() {
    const panamaTime = moment().tz(PANAMA_TIMEZONE);
    const day = panamaTime.day();
    const hour = panamaTime.hour();

    const schedule = {
        weekday: { start: 6, end: 22 },
        weekend: { start: 7, end: 20 }
    };

    const isWeekday = day >= 1 && day <= 5;
    const { start, end } = isWeekday ? schedule.weekday : schedule.weekend;

    const isOpen = hour >= start && hour < end;
    const nextOpeningTime = isOpen ? null : 
        panamaTime.clone().startOf('day').add(isWeekday ? start : (day === 6 ? 10 : 9), 'hours');

    return {
        isOpen,
        nextOpeningTime
    };
}

// Funciones para verificar mensajes
function isRequestingHuman(message) {
    const humanKeywords = ['agente', 'persona real', 'humano', 'representante', 'asesor', 'hablar con alguien'];
    return humanKeywords.some(keyword => message.toLowerCase().includes(keyword));
}

function isReturningToBot(message) {
    const botKeywords = ['volver al bot', 'bot', 'asistente virtual', 'chatbot'];
    return botKeywords.some(keyword => message.toLowerCase().includes(keyword));
}

// Manejador de mensajes principal mejorado
async function handleMessage(message) {
    stabilityManager.updateLastMessage();
    const contactId = message.from;
    const messageText = message.body.toLowerCase();

    // Verificar rate limiting
    if (checkRateLimit(contactId)) {
        await message.reply(SYSTEM_MESSAGES.RATE_LIMIT);
        return;
    }

    // Verificar mensajes repetidos
    if (isRepeatedMessage(contactId, messageText)) {
        if (lastUserMessages.get(contactId).count === 0) { // Si es el cuarto mensaje repetido
            await message.reply(SYSTEM_MESSAGES.SPAM_WARNING);
            spamCooldown.set(contactId, Date.now() + 120000); // 2 minutos de cooldown
            return;
        } else {
            await message.reply(SYSTEM_MESSAGES.REPEATED_MESSAGE);
            return;
        }
    }

    // Verificar si el usuario está en cooldown por spam
    if (spamCooldown.has(contactId)) {
        const cooldownEnd = spamCooldown.get(contactId);
        if (Date.now() < cooldownEnd) {
            return; // No responder durante el cooldown
        } else {
            spamCooldown.delete(contactId); // Eliminar el cooldown si ha expirado
        }
    }

    // Verificar si el mensaje es spam
    if (isSpamMessage(message)) {
        await message.reply(SYSTEM_MESSAGES.SPAM_WARNING);
        spamCooldown.set(contactId, Date.now() + 180000); // 3 minutos de cooldown
        return;
    }

    // Verificar si el usuario está solicitando atención humana
    if (isRequestingHuman(messageText)) {
        const storeStatus = getStoreStatus();
        if (!storeStatus.isOpen) {
            await message.reply('Lo siento, fuera del horario de atención no podemos conectarte con un agente. Por favor, intenta durante nuestro horario de atención.');
            return;
        }

        await message.reply(SYSTEM_MESSAGES.HUMAN_REQUEST);
        pausedUsers.set(contactId, true);
        userRequestsHuman.set(contactId, true);

        setTimeout(() => {
            if (pausedUsers.get(contactId)) {
                pausedUsers.delete(contactId);
                userRequestsHuman.delete(contactId);
                whatsappClient.sendMessage(contactId, 'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?');
            }
        }, PAUSE_DURATION);

        return;
    }

    // Verificar si el usuario quiere volver al bot
    if (isReturningToBot(messageText) && userRequestsHuman.get(contactId)) {
        pausedUsers.delete(contactId);
        userRequestsHuman.delete(contactId);
        await message.reply('¡Bienvenido de vuelta! ¿En qué puedo ayudarte?');
        return;
    }

    if (pausedUsers.get(contactId)) {
        return;
    }

    // Verificar si el mensaje contiene medios
    if (message.hasMedia) {
        await handleMediaMessage(message);
        return;
    }

    // === NUEVO FLUJO: Decisión de acción por IA ===
    try {
        const storeStatus = getStoreStatus();
        let responseText;

        // Mensajes directos de bienvenida y horario
        if (messageText === 'hola') {
            responseText = SYSTEM_MESSAGES.WELCOME;
            await message.reply(responseText);
            return;
        } else if (messageText === 'horario') {
            responseText = SYSTEM_MESSAGES.HORARIO;
            await message.reply(responseText);
            return;
        } else if (/web|página web|pagina web/i.test(messageText)) {
            responseText = SYSTEM_MESSAGES.WEB_PAGE;
            await message.reply(responseText);
            return;
        }

        // Decisión IA
        const decision = await decideAction(message.body, contactId);
        if (decision.action === "to_human") {
            if (!storeStatus.isOpen) {
                await message.reply('Lo siento, fuera del horario de atención no podemos conectarte con un agente. Por favor, intenta durante nuestro horario de atención.');
                return;
            }
            await message.reply(SYSTEM_MESSAGES.HUMAN_REQUEST);
            pausedUsers.set(contactId, true);
            userRequestsHuman.set(contactId, true);
            setTimeout(() => {
                if (pausedUsers.get(contactId)) {
                    pausedUsers.delete(contactId);
                    userRequestsHuman.delete(contactId);
                    whatsappClient.sendMessage(contactId, 'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?');
                }
            }, PAUSE_DURATION);
            return;
        } else if (decision.action === "freeze") {
            pausedUsers.set(contactId, true);
            setTimeout(() => {
                if (pausedUsers.get(contactId)) {
                    pausedUsers.delete(contactId);
                    whatsappClient.sendMessage(contactId, 'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?');
                }
            }, PAUSE_DURATION);
            await message.reply('Tu chat ha sido pausado temporalmente por motivos de seguridad o moderación.');
            return;
        } else if (decision.action === "info_empresa") {
            const info = loadFile('info_empresa.txt');
            await message.reply(info.slice(0, 2000)); // WhatsApp limita el tamaño
            return;
        } else if (decision.action === "info_laptops") {
            const info = loadFile('Laptops1.txt');
            await message.reply(info.slice(0, 2000));
            return;
        }
        // Si la acción es "continue" o no reconocida, flujo normal:
        if (storeStatus.isOpen) {
            responseText = await generateResponse(message.body, contactId);
        } else {
            responseText = `🕒 Nuestra tienda está cerrada en este momento. El horario de atención es de Lunes a Viernes de 6:00 AM a 10:00 PM y Sábados y Domingos de 7:00 AM a 8:00 PM (Hora de Panamá).\n\n🌐 Visita nuestra web: https://irvin-benitez.software`;
        }
        await message.reply(responseText);
    } catch (error) {
        console.error('Error procesando mensaje:', error);
        await message.reply(SYSTEM_MESSAGES.ERROR);
    }
}

// Sistema de cola de mensajes mejorado
async function processMessageQueue() {
    if (isProcessingMessage || messageQueue.length === 0) return;

    isProcessingMessage = true;
    const { message, resolve, reject } = messageQueue.shift();

    try {
        await handleMessage(message);
        resolve();
    } catch (error) {
        console.error('Error procesando mensaje en cola:', error);
        reject(error);
    } finally {
        isProcessingMessage = false;
        if (messageQueue.length > 0) {
            processMessageQueue();
        }
    }
}

// Función para agregar mensaje a la cola
function queueMessage(message) {
    return new Promise((resolve, reject) => {
        if (messageQueue.length >= MAX_QUEUE_SIZE) {
            messageQueue.shift(); // Eliminar el mensaje más antiguo
        }
        messageQueue.push({ message, resolve, reject });
        processMessageQueue();
    });
}

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

// Manejadores de eventos de WhatsApp mejorados
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

// Evento de mensaje mejorado con cola
whatsappClient.on('message', async (message) => {
    try {
        await queueMessage(message);
    } catch (error) {
        console.error('Error en cola de mensajes:', error);
    }
});

// Limpieza periódica de datos
setInterval(() => {
    const now = Date.now();
    
    // Limpiar contadores de mensajes antiguos
    for (const [userId, data] of userMessageCounts.entries()) {
        if (now - data.timestamp > MESSAGE_RATE_LIMIT.WINDOW_MS * 2) {
            userMessageCounts.delete(userId);
        }
    }
    
    // Limpiar mensajes repetidos antiguos
    for (const [userId, data] of lastUserMessages.entries()) {
        if (now - data.timestamp > MESSAGE_RATE_LIMIT.WINDOW_MS) {
            lastUserMessages.delete(userId);
        }
    }

    // Limpiar cooldowns expirados
    for (const [userId, cooldownEnd] of spamCooldown.entries()) {
        if (now > cooldownEnd) {
            spamCooldown.delete(userId);
        }
    }
}, MESSAGE_RATE_LIMIT.WINDOW_MS);

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