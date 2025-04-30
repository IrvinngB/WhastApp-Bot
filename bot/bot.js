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
        
        const content = fs.readFileSync(path.join(__dirname, filePath), 'utf-8');
        fileCache.set(filePath, content);
        return content;
    } catch (error) {
        console.error(`Error al cargar el archivo ${filePath}:`, error);
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

// NUEVA FUNCIÓN: Extraer información relevante de un texto según la consulta del usuario
async function extractRelevantInfo(fullText, userQuery, maxLength = 500) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `
        Basado en la siguiente consulta del usuario: "${userQuery}"
        
        Extrae SOLO la información más relevante del siguiente texto. 
        La respuesta debe ser concisa (máximo ${maxLength} caracteres) y directamente relacionada con la consulta.
        Si no hay información relevante, proporciona un breve resumen general.
        
        TEXTO:
        ${fullText.substring(0, 10000)} // Limitamos el tamaño para no sobrecargar la API
        `;
        
        const result = await model.generateContent(prompt);
        const response = result.response.text();
        
        // Si la respuesta es demasiado larga, cortarla
        return response.length > maxLength ? response.substring(0, maxLength) + "..." : response;
    } catch (error) {
        console.error("Error al extraer información relevante:", error);
        // En caso de error, devolver un fragmento del texto original
        return fullText.length > maxLength ? 
            fullText.substring(0, maxLength) + "..." : 
            fullText;
    }
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
        userCount.count += 1;
    }

    userMessageCounts.set(userId, userCount);
    return userCount.count > MESSAGE_RATE_LIMIT.MAX_MESSAGES;
}

// Función para detectar mensajes repetidos
function isRepeatedMessage(userId, message) {
    const lastMessage = lastUserMessages.get(userId);
    const currentMessage = message.toLowerCase().trim();
    
    if (lastMessage && lastMessage.text === currentMessage) {
        lastMessage.count += 1;
        lastMessage.lastSeen = Date.now();
        lastUserMessages.set(userId, lastMessage);
        return lastMessage.count >= 3;
    } else {
        lastUserMessages.set(userId, {
            text: currentMessage,
            count: 1,
            lastSeen: Date.now()
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
        // Recuperar o inicializar el contexto del usuario
        let userContext = contextStore.get(contactId) || [];
        
        // Limitar el tamaño del contexto para no sobrecargar la memoria
        if (userContext.length > 10) {
            userContext = userContext.slice(-10);
        }
        
        // Preparar el prompt con instrucciones mejoradas
        const prompt = `${promptInstructions}

Información sobre nuestra empresa:
${companyInfo.substring(0, 500)}...

Información sobre nuestras laptops:
${laptops.substring(0, 500)}...

Usa estos datos solo si son relevantes para la consulta del usuario. No menciones que tienes esta información a menos que sea necesario.

Contexto de la conversación:
${userContext.map(msg => `${msg.role === 'user' ? 'Cliente' : 'Bot'}: ${msg.parts}`).join('\n')}

Consulta del cliente: ${userMessage}

Responde de manera concisa, profesional y amigable. No inventes información que no tengas.`;

        const result = await model.generateContent(prompt);
        const response = result.response.text();
        
        // Actualizar el contexto con la nueva interacción
        userContext.push({ role: 'user', parts: userMessage });
        userContext.push({ role: 'model', parts: response });
        contextStore.set(contactId, userContext);
        
        return response;
    } catch (error) {
        console.error('Error generando respuesta:', error);
        
        // Implementar reintentos con límite
        if (retryCount < MAX_RETRIES) {
            console.log(`Reintentando generación de respuesta (${retryCount + 1}/${MAX_RETRIES})...`);
            return generateResponse(userMessage, contactId, retryCount + 1);
        }
        
        return SYSTEM_MESSAGES.ERROR;
    }
}

// === NUEVO: Decisión de acción por IA ===
async function decideAction(userMessage, contactId) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
    
    try {
        const prompt = `Analiza el siguiente mensaje de un usuario y decide qué acción tomar:

Mensaje del usuario: "${userMessage}"

Clasifica este mensaje en UNA SOLA de las siguientes categorías y devuelve ÚNICAMENTE el formato JSON indicado:

1. Si solicita información específica sobre laptops: {"action": "info_laptops", "relevant_query": "la consulta específica sobre laptops"}
2. Si solicita información general sobre la empresa: {"action": "info_empresa", "relevant_query": "la consulta específica sobre la empresa"}
3. Si es una pregunta o consulta general: {"action": "general_query"}
4. Si solicita hablar con un agente humano: {"action": "human_agent"}
5. Si es un saludo o mensaje inicial: {"action": "greeting"}
6. Si es un agradecimiento o despedida: {"action": "farewell"}

IMPORTANTE: Para las categorías 1 y 2, añade "relevant_query" con los términos específicos de búsqueda del usuario.
NO AÑADAS EXPLICACIONES. Devuelve ÚNICAMENTE el objeto JSON.`;

        const result = await model.generateContent(prompt);
        const response = result.response.text();
        
        try {
            // Intentar parsear la respuesta como JSON
            return JSON.parse(response.trim());
        } catch (jsonError) {
            console.error('Error parseando respuesta de clasificación:', jsonError);
            // Si falla, asumir consulta general
            return { action: "general_query" };
        }
    } catch (error) {
        console.error('Error en la clasificación del mensaje:', error);
        return { action: "general_query" };
    }
}

// Función para manejar mensajes con medios
async function handleMediaMessage(message) {
    try {
        // Implementación del manejo de medios
        // ...
    } catch (error) {
        console.error('Error manejando mensaje con medios:', error);
        return SYSTEM_MESSAGES.ERROR;
    }
}

// Función mejorada para verificar horario
function getStoreStatus() {
    // Implementación de la verificación de horario
    // ...
}

// Funciones para verificar mensajes
function isRequestingHuman(message) {
    const text = message.body.toLowerCase();
    return text.includes('agente') || 
           text.includes('humano') || 
           text.includes('persona') || 
           text.includes('representante') ||
           text.includes('hablar con alguien');
}

function isReturningToBot(message) {
    const text = message.body.toLowerCase();
    return text.includes('volver al bot') || 
           text.includes('hablar con bot') || 
           text.includes('asistente virtual');
}

// MODIFICADO: Manejador de mensajes principal mejorado
async function handleMessage(message) {
    try {
        const contactId = message.from;
        const userMessage = message.body;
        
        // Verificaciones previas
        if (isRepeatedMessage(contactId, userMessage)) {
            return SYSTEM_MESSAGES.REPEATED_MESSAGE;
        }
        
        if (checkRateLimit(contactId)) {
            return SYSTEM_MESSAGES.RATE_LIMIT;
        }
        
        if (isSpamMessage(message)) {
            // Manejar spam
            spamCooldown.set(contactId, Date.now() + 120000); // 2 minutos de cooldown
            return SYSTEM_MESSAGES.SPAM_WARNING;
        }
        
        // Manejo de solicitud de agente humano
        if (isRequestingHuman(message)) {
            userRequestsHuman.set(contactId, true);
            return SYSTEM_MESSAGES.HUMAN_REQUEST;
        }
        
        // Manejo de retorno al bot
        if (isReturningToBot(message) && userRequestsHuman.get(contactId)) {
            userRequestsHuman.delete(contactId);
            return SYSTEM_MESSAGES.WELCOME;
        }
        
        // Si el usuario está hablando con un humano, no procesar con el bot
        if (userRequestsHuman.get(contactId)) {
            // Simplemente registrar el mensaje para el agente humano
            console.log(`Mensaje para agente humano de ${contactId}: ${userMessage}`);
            return null; // No responder automáticamente
        }
        
        // Verificar si la tienda está cerrada
        const storeStatus = getStoreStatus();
        if (!storeStatus.isOpen) {
            // Durante horario cerrado, limitar funcionalidad
            return SYSTEM_MESSAGES.STORE_CLOSED;
        }
        
        // Determinar acción basada en análisis de IA
        const decision = await decideAction(userMessage, contactId);
        
        if (decision.action === "greeting") {
            return SYSTEM_MESSAGES.WELCOME;
        } else if (decision.action === "farewell") {
            return "¡Gracias por contactarnos! Si necesitas algo más, estamos aquí para ayudarte. ¡Que tengas un excelente día!";
        } else if (decision.action === "human_agent") {
            userRequestsHuman.set(contactId, true);
            return SYSTEM_MESSAGES.HUMAN_REQUEST;
        } 
        // MODIFICADO: Manejo mejorado de información de empresa y laptops
        else if (decision.action === "info_empresa") {
            const relevantInfo = await extractRelevantInfo(
                companyInfo, 
                decision.relevant_query || "información general", 
                800
            );
            return `${relevantInfo}\n\nSi necesitas más información específica, no dudes en preguntar.`;
        } else if (decision.action === "info_laptops") {
            const relevantInfo = await extractRelevantInfo(
                laptops, 
                decision.relevant_query || "laptops disponibles", 
                800
            );
            return `${relevantInfo}\n\nSi deseas conocer más detalles o tienes alguna otra pregunta, estoy aquí para ayudarte.`;
        } else {
            // Consulta general - usar Gemini para responder
            return await generateResponse(userMessage, contactId);
        }
    } catch (error) {
        console.error('Error manejando mensaje:', error);
        return SYSTEM_MESSAGES.ERROR;
    }
}

// Sistema de cola de mensajes mejorado
async function processMessageQueue() {
    if (isProcessingMessage || messageQueue.length === 0) return;
    
    isProcessingMessage = true;
    
    try {
        const { message, resolveCallback, timeoutId } = messageQueue.shift();
        
        // Cancelar el timeout ya que vamos a procesar el mensaje
        if (timeoutId) clearTimeout(timeoutId);
        
        console.log(`Procesando mensaje de ${message.from}: ${message.body.substring(0, 50)}${message.body.length > 50 ? '...' : ''}`);
        
        const response = await handleMessage(message);
        
        // Si hay una respuesta, enviarla
        if (response) {
            await message.reply(response);
        }
        
        resolveCallback(response);
    } catch (error) {
        console.error('Error procesando cola de mensajes:', error);
    } finally {
        isProcessingMessage = false;
        
        // Procesar el siguiente mensaje después de una pequeña pausa
        setTimeout(processMessageQueue, 500);
    }
}

// Función para agregar mensaje a la cola
function queueMessage(message) {
    return new Promise((resolve) => {
        // Verificar si la cola está llena
        if (messageQueue.length >= MAX_QUEUE_SIZE) {
            message.reply(SYSTEM_MESSAGES.RATE_LIMIT).catch(console.error);
            resolve(SYSTEM_MESSAGES.RATE_LIMIT);
            return;
        }
        
        // Configurar timeout para evitar esperas prolongadas
        const timeoutId = setTimeout(() => {
            message.reply(SYSTEM_MESSAGES.TIMEOUT).catch(console.error);
            resolve(SYSTEM_MESSAGES.TIMEOUT);
            
            // Eliminar este mensaje de la cola
            const index = messageQueue.findIndex(item => item.message.id === message.id);
            if (index !== -1) {
                messageQueue.splice(index, 1);
            }
        }, MESSAGE_TIMEOUT);
        
        // Agregar a la cola
        messageQueue.push({
            message,
            resolveCallback: resolve,
            timeoutId,
            timestamp: Date.now()
        });
        
        // Intentar procesar la cola
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
    // Manejo del código QR
});

whatsappClient.on('ready', () => {
    console.log('Cliente WhatsApp listo y conectado');
});

whatsappClient.on('loading_screen', (percent, message) => {
    console.log(`Cargando: ${percent}% - ${message}`);
});

// Evento de mensaje mejorado con cola
whatsappClient.on('message', async (message) => {
    // Manejar mensaje recibido
});

// Limpieza periódica de datos
setInterval(() => {
    // Limpieza de datos
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
    // Manejar ruta principal
});

// Iniciar el sistema de estabilidad
stabilityManager.startStabilitySystem(app);

// Iniciar servidor con manejo de errores
server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (error) => {
    console.error('Error no manejado (Promise):', error);
});

process.on('uncaughtException', (error) => {
    console.error('Excepción no capturada:', error);
});

// Limpieza al cerrar
process.on('SIGINT', async () => {
    // Limpieza de recursos
});