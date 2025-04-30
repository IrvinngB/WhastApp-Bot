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

// ========== MEMORY MANAGEMENT ==========
class MemoryMonitor {
    static logMemoryUsage(label = 'Memory usage') {
        const used = process.memoryUsage();
        console.log(`${label}: `, {
            rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`
        });
    }
    
    static scheduleMemoryChecks(intervalMs = 3600000) { // Default: every hour
        return setInterval(() => {
            this.logMemoryUsage('Scheduled memory check');
            global.gc && global.gc(); // Force garbage collection if --expose-gc flag is used
        }, intervalMs);
    }
}

// Initial memory usage logging
MemoryMonitor.logMemoryUsage('Initial memory usage');
const memoryCheckInterval = MemoryMonitor.scheduleMemoryChecks();

// ========== CONSTANTS & CONFIGURATION ==========
const CONFIG = {
    PORT: process.env.PORT || 3000,
    PANAMA_TIMEZONE: "America/Panama",
    PAUSE_DURATION: 60 * 60 * 1000, // 1 hour
    MAX_RETRIES: 3,
    MESSAGE_TIMEOUT: 60000, // 60 seconds
    MAX_QUEUE_SIZE: 100,
    CLEANUP_INTERVAL: 60000, // 1 minute
    RATE_LIMIT: {
        WINDOW_MS: 60000, // 1 minute
        MAX_MESSAGES: 10  // Max 10 messages per minute
    },
    SPAM_DETECTION: {
        MAX_REPEATED_MESSAGES: 4,
        COOLDOWN_DURATION: 120000 // 2 minutes
    },
    STORE_HOURS: {
        WEEKDAY: { start: 6, end: 22 },
        WEEKEND: { start: 7, end: 20 }
    }
};

// Media types enumeration
const MEDIA_TYPES = {
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    DOCUMENT: 'document',
    STICKER: 'sticker'
};

// Common spam patterns - compiled for performance
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

// System messages template
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

// ========== STATE MANAGEMENT ==========
class StateManager {
    constructor() {
        this.pausedUsers = new Map();
        this.contextStore = new Map();
        this.userRequestsHuman = new Map();
        this.lastUserMessages = new Map();
        this.spamCooldown = new Map();
        this.userMessageCounts = new Map();
        this.isProcessingMessage = false;
        this.messageQueue = [];
        this.fileCache = new Map();
    }

    isPaused(userId) {
        return this.pausedUsers.get(userId) === true;
    }

    pauseUser(userId, duration = CONFIG.PAUSE_DURATION) {
        this.pausedUsers.set(userId, true);
        return setTimeout(() => this.unpauseUser(userId), duration);
    }

    unpauseUser(userId) {
        if (this.isPaused(userId)) {
            this.pausedUsers.delete(userId);
            return true;
        }
        return false;
    }

    requestHuman(userId) {
        this.userRequestsHuman.set(userId, true);
        return this.pauseUser(userId);
    }

    isRequestingHuman(userId) {
        return this.userRequestsHuman.get(userId) === true;
    }

    returnToBot(userId) {
        this.pausedUsers.delete(userId);
        this.userRequestsHuman.delete(userId);
        return true;
    }

    updateContext(userId, userMessage, botResponse) {
        const existingContext = this.contextStore.get(userId) || '';
        // Keep context concise - limit to last 1500 chars to save memory
        const newContext = `${existingContext.slice(-1500)}\nUsuario: ${userMessage}\nBot: ${botResponse}`.trim();
        this.contextStore.set(userId, newContext);
        return newContext;
    }

    getContext(userId) {
        return this.contextStore.get(userId) || '';
    }

    checkRateLimit(userId) {
        const now = Date.now();
        const userCount = this.userMessageCounts.get(userId) || { count: 0, timestamp: now };

        if (now - userCount.timestamp > CONFIG.RATE_LIMIT.WINDOW_MS) {
            userCount.count = 1;
            userCount.timestamp = now;
        } else {
            userCount.count++;
        }

        this.userMessageCounts.set(userId, userCount);
        return userCount.count > CONFIG.RATE_LIMIT.MAX_MESSAGES;
    }

    isRepeatedMessage(userId, message) {
        const lastMessage = this.lastUserMessages.get(userId);
        const currentMessage = message.toLowerCase().trim();
        
        if (lastMessage && lastMessage.text === currentMessage) {
            lastMessage.count++;
            if (lastMessage.count >= CONFIG.SPAM_DETECTION.MAX_REPEATED_MESSAGES) {
                lastMessage.count = 0;
                return true;
            }
        } else {
            this.lastUserMessages.set(userId, {
                text: currentMessage,
                count: 1,
                timestamp: Date.now()
            });
        }
        
        return false;
    }

    isInSpamCooldown(userId) {
        if (!this.spamCooldown.has(userId)) {
            return false;
        }
        
        const cooldownEnd = this.spamCooldown.get(userId);
        if (Date.now() < cooldownEnd) {
            return true;
        }
        
        this.spamCooldown.delete(userId);
        return false;
    }

    setSpamCooldown(userId, duration = CONFIG.SPAM_DETECTION.COOLDOWN_DURATION) {
        this.spamCooldown.set(userId, Date.now() + duration);
    }

    addToQueue(message) {
        return new Promise((resolve, reject) => {
            if (this.messageQueue.length >= CONFIG.MAX_QUEUE_SIZE) {
                // Remove oldest message if queue is full
                this.messageQueue.shift();
            }
            this.messageQueue.push({ message, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessingMessage || this.messageQueue.length === 0) return;

        this.isProcessingMessage = true;
        const { message, resolve, reject } = this.messageQueue.shift();

        try {
            await messageHandler.handleMessage(message);
            resolve();
        } catch (error) {
            console.error('Error processing queued message:', error);
            reject(error);
        } finally {
            this.isProcessingMessage = false;
            if (this.messageQueue.length > 0) {
                this.processQueue();
            }
        }
    }

    cleanup() {
        const now = Date.now();
        
        // Clean up rate limiting data
        for (const [userId, data] of this.userMessageCounts.entries()) {
            if (now - data.timestamp > CONFIG.RATE_LIMIT.WINDOW_MS * 2) {
                this.userMessageCounts.delete(userId);
            }
        }
        
        // Clean up repeated message data
        for (const [userId, data] of this.lastUserMessages.entries()) {
            if (now - data.timestamp > CONFIG.RATE_LIMIT.WINDOW_MS * 2) {
                this.lastUserMessages.delete(userId);
            }
        }

        // Clean up expired cooldowns
        for (const [userId, cooldownEnd] of this.spamCooldown.entries()) {
            if (now > cooldownEnd) {
                this.spamCooldown.delete(userId);
            }
        }
    }
}

// ========== FILE MANAGER ==========
class FileManager {
    constructor(stateManager) {
        this.state = stateManager;
        this.basePath = __dirname;
        
        // Load essential files
        this.laptops = this.loadFile('Laptops1.txt', '');
        this.companyInfo = this.loadFile('info_empresa.txt', '');
        this.promptInstructions = this.loadFile('promt.txt', '');
    }

    loadFile(filePath, defaultValue = '') {
        try {
            // Check cache first
            if (this.state.fileCache.has(filePath)) {
                return this.state.fileCache.get(filePath);
            }

            const fullPath = path.join(this.basePath, filePath);
            if (!fs.existsSync(fullPath)) {
                console.warn(`File not found: ${filePath}`);
                return defaultValue;
            }

            const content = fs.readFileSync(fullPath, 'utf8');
            this.state.fileCache.set(filePath, content);
            return content;
        } catch (error) {
            console.error(`Error reading file ${filePath}:`, error);
            return defaultValue;
        }
    }

    getCompanyInfo() {
        return this.companyInfo;
    }

    getLaptopInfo() {
        return this.laptops;
    }
}

// ========== AI SERVICE ==========
class AIService {
    constructor(stateManager, fileManager) {
        this.state = stateManager;
        this.fileManager = fileManager;
        
        // Initialize Google Generative AI
        if (!process.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY environment variable is not set.');
        }
        
        try {
            this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        } catch (error) {
            console.error('Error initializing Google Generative AI:', error);
            throw error;
        }
    }

    async generateResponse(userMessage, contactId, retryCount = 0) {
        const model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        try {
            const userContext = this.state.getContext(contactId);
            const laptops = this.fileManager.getLaptopInfo();
            const companyInfo = this.fileManager.getCompanyInfo();

            const customPrompt = `
            Eres un asistente virtual llamado Electra amigable y profesional de ElectronicsJS. Tu objetivo es proporcionar la mejor atención posible siguiendo estas pautas:

            PERSONALIDAD:
            - Sé amable y empático, pero mantén un tono profesional
            - Usa emojis ocasionalmente para dar calidez a tus respuestas
            - Sé conciso pero informativo
            - Si no estás seguro de algo, ofrece conectar con un agente humano

            FUNCIONES PRINCIPALES:
            1. Información de Productos:
               - Proporciona detalles precisos sobre laptops y productos (componentes)
               - Menciona especificaciones técnicas cuando sea relevante
               - Sugiere productos según las necesidades del cliente

            2. Información de la Empresa:
               - Comparte detalles sobre ElectronicsJS: ${companyInfo}
               - Informa sobre ubicación, horarios y políticas

            3. Servicio al Cliente:
               - Responde preguntas sobre garantías y soporte
               - Explica procesos de compra y políticas de devolución
               - Ofrece conectar con un agente humano cuando sea necesario

            4. Gestión de Consultas:
               - Si la pregunta está fuera de tu alcance, sugiere hablar con un agente
               - Para temas sensibles o complejos, recomienda atención personalizada

            RESTRICCIONES:
            - No compartas información confidencial
            - No hagas promesas sobre precios o disponibilidad
            - No proporciones información personal de clientes
            - No tomes decisiones sobre casos especiales

            CONTEXTO ACTUAL:
            - Historial del usuario: ${userContext}
            - Productos disponibles (laptops y componentes): ${laptops}

            RESPONDE A: "${userMessage}"

            FORMATO DE RESPUESTA:
            - Mantén las respuestas concisas (máximo 4-5 líneas)
            - Usa viñetas para listas largas
            - Incluye emojis relevantes ocasionalmente`;

            const result = await Promise.race([
                model.generateContent(customPrompt),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('TIMEOUT')), CONFIG.MESSAGE_TIMEOUT)
                )
            ]);

            let text = result.response.text();

            // Check if the client has expressed purchase intent
            const purchaseKeywords = ['comprar', 'cotizar', 'llevar', 'adquirir', 'quiero comprar', 'precio', 'costo'];
            const isPurchaseIntent = purchaseKeywords.some(keyword => userMessage.toLowerCase().includes(keyword));

            // Only add purchase message if there's purchase intent
            if (isPurchaseIntent) {
                text += `\n\n¿Te gustaría comprar esta laptop? Aquí tienes las opciones disponibles:
                - 🗣️ Hablar con un agente real: Escribe "agente" para conectarte con un representante.
                - 🌐 Comprar en línea: Visita nuestra página web: https://irvin-benitez.software
                - 🏬 Visitar la tienda: Estamos ubicados en La chorrera. ¡Te esperamos!`;
            }

            // Update context
            this.state.updateContext(contactId, userMessage, text);

            return text;
        } catch (error) {
            console.error('Error generating response:', error);

            if (error.message === 'TIMEOUT' && retryCount < CONFIG.MAX_RETRIES) {
                console.log(`Retrying response generation (${retryCount + 1}/${CONFIG.MAX_RETRIES})...`);
                return this.generateResponse(userMessage, contactId, retryCount + 1);
            }

            return SYSTEM_MESSAGES.ERROR;
        }
    }

    async decideAction(userMessage, contactId) {
        const model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
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
            // Safe fallback
            return { action: "continue", file: "" };
        } catch (e) {
            console.error("Error in decision AI:", e);
            return { action: "continue", file: "" };
        }
    }
}

// ========== STORE HOURS SERVICE ==========
class StoreHoursService {
    static getStoreStatus() {
        const panamaTime = moment().tz(CONFIG.PANAMA_TIMEZONE);
        const day = panamaTime.day();
        const hour = panamaTime.hour();

        const isWeekday = day >= 1 && day <= 5;
        const { start, end } = isWeekday ? 
            CONFIG.STORE_HOURS.WEEKDAY : 
            CONFIG.STORE_HOURS.WEEKEND;

        const isOpen = hour >= start && hour < end;
        const nextOpeningTime = isOpen ? null : 
            panamaTime.clone().startOf('day').add(
                isWeekday ? start : (day === 6 ? start : start), 'hours'
            );

        return { isOpen, nextOpeningTime };
    }
    
    static formatNextOpeningTime(nextOpeningTime) {
        if (!nextOpeningTime) return "";
        return nextOpeningTime.format('dddd [a las] h:mm A');
    }
}

// ========== MESSAGE ANALYZER ==========
class MessageAnalyzer {
    static isRequestingHuman(message) {
        const humanKeywords = ['agente', 'persona real', 'humano', 'representante', 'asesor', 'hablar con alguien'];
        return humanKeywords.some(keyword => message.toLowerCase().includes(keyword));
    }

    static isReturningToBot(message) {
        const botKeywords = ['volver al bot', 'bot', 'asistente virtual', 'chatbot'];
        return botKeywords.some(keyword => message.toLowerCase().includes(keyword));
    }

    static isSpamMessage(message) {
        const messageText = message.body.toLowerCase();
        
        // Check spam patterns
        const containsSpamPattern = SPAM_PATTERNS.some(pattern => {
            if (pattern instanceof RegExp) {
                return pattern.test(messageText);
            }
            return messageText.includes(pattern);
        });

        // Check suspicious characteristics
        const hasMultipleUrls = (messageText.match(/https?:\/\//g) || []).length > 1;
        const hasMultiplePhoneNumbers = (messageText.match(/\b\d{8,}\b/g) || []).length > 1;
        const hasExcessivePunctuation = (messageText.match(/[!?]/g) || []).length > 5;
        
        return containsSpamPattern || hasMultipleUrls || hasMultiplePhoneNumbers || hasExcessivePunctuation;
    }
    
    static isDirectQuery(message) {
        const directQueries = {
            'hola': true,
            'horario': true,
            'horarios': true,
            'web': true,
            'página web': true,
            'pagina web': true,
            'sitio web': true
        };
        
        return directQueries[message.toLowerCase().trim()] || false;
    }
    
    static getDirectQueryType(message) {
        const text = message.toLowerCase().trim();
        
        if (text === 'hola') return 'welcome';
        if (['horario', 'horarios'].includes(text)) return 'schedule';
        if (['web', 'página web', 'pagina web', 'sitio web'].includes(text)) return 'website';
        
        return null;
    }
}

// ========== MESSAGE HANDLER ==========
class MessageHandler {
    constructor(stateManager, aiService, fileManager) {
        this.state = stateManager;
        this.ai = aiService;
        this.files = fileManager;
        this.whatsappClient = null;
    }
    
    setWhatsappClient(client) {
        this.whatsappClient = client;
    }
    
    async handleDirectQuery(message, queryType) {
        switch (queryType) {
            case 'welcome':
                await message.reply(SYSTEM_MESSAGES.WELCOME);
                return true;
            case 'schedule':
                await message.reply(SYSTEM_MESSAGES.HORARIO);
                return true;
            case 'website':
                await message.reply(SYSTEM_MESSAGES.WEB_PAGE);
                return true;
            default:
                return false;
        }
    }

    async handleMediaMessage(message) {
        const mediaType = message.type;
        let responseText = SYSTEM_MESSAGES.MEDIA_RECEIVED;

        // Customize message based on media type
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
            const timeoutId = this.state.requestHuman(message.from);
            
            // Schedule cleanup after pause period
            setTimeout(() => {
                if (this.state.unpauseUser(message.from)) {
                    this.state.userRequestsHuman.delete(message.from);
                    this.whatsappClient?.sendMessage(
                        message.from, 
                        'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?'
                    );
                }
            }, CONFIG.PAUSE_DURATION);

        } catch (error) {
            console.error('Error handling media message:', error);
            await message.reply(SYSTEM_MESSAGES.ERROR);
        }
    }

    async handleMessage(message) {
        if (!this.whatsappClient) {
            console.error("WhatsApp client not initialized in MessageHandler");
            return;
        }
        
        const contactId = message.from;
        const messageText = message.body;
        
        try {
            // Check rate limiting
            if (this.state.checkRateLimit(contactId)) {
                await message.reply(SYSTEM_MESSAGES.RATE_LIMIT);
                return;
            }

            // Check repeated messages
            if (this.state.isRepeatedMessage(contactId, messageText)) {
                if (this.state.lastUserMessages.get(contactId).count === 0) {
                    await message.reply(SYSTEM_MESSAGES.SPAM_WARNING);
                    this.state.setSpamCooldown(contactId);
                    return;
                } else {
                    await message.reply(SYSTEM_MESSAGES.REPEATED_MESSAGE);
                    return;
                }
            }

            // Check if user is in spam cooldown
            if (this.state.isInSpamCooldown(contactId)) {
                return; // Don't respond during cooldown
            }

            // Check for spam
            if (MessageAnalyzer.isSpamMessage(message)) {
                await message.reply(SYSTEM_MESSAGES.SPAM_WARNING);
                this.state.setSpamCooldown(contactId, 180000); // 3 minutes
                return;
            }

            // Check if user is requesting human attention
            if (MessageAnalyzer.isRequestingHuman(messageText)) {
                const storeStatus = StoreHoursService.getStoreStatus();
                if (!storeStatus.isOpen) {
                    await message.reply('Lo siento, fuera del horario de atención no podemos conectarte con un agente. Por favor, intenta durante nuestro horario de atención.');
                    return;
                }

                await message.reply(SYSTEM_MESSAGES.HUMAN_REQUEST);
                const timeoutId = this.state.requestHuman(contactId);
                
                setTimeout(() => {
                    if (this.state.unpauseUser(contactId)) {
                        this.state.userRequestsHuman.delete(contactId);
                        this.whatsappClient.sendMessage(
                            contactId, 
                            'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?'
                        );
                    }
                }, CONFIG.PAUSE_DURATION);
                
                return;
            }

            // Check if user wants to return to bot
            if (MessageAnalyzer.isReturningToBot(messageText) && this.state.isRequestingHuman(contactId)) {
                this.state.returnToBot(contactId);
                await message.reply('¡Bienvenido de vuelta! ¿En qué puedo ayudarte?');
                return;
            }

            // Don't proceed if user is paused
            if (this.state.isPaused(contactId)) {
                return;
            }

            // Check if message has media
            if (message.hasMedia) {
                await this.handleMediaMessage(message);
                return;
            }
            
            // Check for direct queries
            const queryType = MessageAnalyzer.getDirectQueryType(messageText);
            if (queryType) {
                const handled = await this.handleDirectQuery(message, queryType);
                if (handled) return;
            }

            // AI Decision flow
            const storeStatus = StoreHoursService.getStoreStatus();
            let responseText;

            // AI Decision
            const decision = await this.ai.decideAction(message.body, contactId);
            
            if (decision.action === "to_human") {
                if (!storeStatus.isOpen) {
                    await message.reply('Lo siento, fuera del horario de atención no podemos conectarte con un agente. Por favor, intenta durante nuestro horario de atención.');
                    return;
                }
                await message.reply(SYSTEM_MESSAGES.HUMAN_REQUEST);
                const timeoutId = this.state.requestHuman(contactId);
                
                setTimeout(() => {
                    if (this.state.unpauseUser(contactId)) {
                        this.state.userRequestsHuman.delete(contactId);
                        this.whatsappClient.sendMessage(
                            contactId, 
                            'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?'
                        );
                    }
                }, CONFIG.PAUSE_DURATION);
                
                return;
            } else if (decision.action === "freeze") {
                const timeoutId = this.state.pauseUser(contactId);
                
                setTimeout(() => {
                    if (this.state.unpauseUser(contactId)) {
                        this.whatsappClient.sendMessage(
                            contactId, 
                            'El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?'
                        );
                    }
                }, CONFIG.PAUSE_DURATION);
                
                await message.reply('Tu chat ha sido pausado temporalmente por motivos de seguridad o moderación.');
                return;
            } else if (decision.action === "info_empresa") {
                const info = this.files.loadFile('info_empresa.txt');
                await message.reply(info.slice(0, 2000)); // WhatsApp limits message size
                return;
            } else if (decision.action === "info_laptops") {
                const info = this.files.loadFile('Laptops1.txt');
                await message.reply(info.slice(0, 2000));
                return;
            }
            
            // Normal flow (continue action)
            if (storeStatus.isOpen) {
                responseText = await this.ai.generateResponse(message.body, contactId);
            } else {
                responseText = `🕒 Nuestra tienda está cerrada en este momento. El horario de atención es de Lunes a Viernes de 6:00 AM a 10:00 PM y Sábados y Domingos de 7:00 AM a 8:00 PM (Hora de Panamá).\n\n🌐 Visita nuestra web: https://irvin-benitez.software`;
            }
            
            await message.reply(responseText);
            
        } catch (error) {
            console.error('Error processing message:', error);
            await message.reply(SYSTEM_MESSAGES.ERROR);
        }
    }
}

// ========== WHATSAPP CLIENT SETUP ==========
class WhatsAppBot {
    constructor(stateManager, messageHandler) {
        this.state = stateManager;
        this.messageHandler = messageHandler;
        
        // Initialize WhatsApp client
        this.client = new Client({
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
        
        this.messageHandler.setWhatsappClient(this.client);
        
        // Initialize Socket.IO for QR code
        this.io = null;
        
        // Initialize stability manager
        this.stabilityManager = null;
    }
    
    setSocketIO(io) {
        this.io = io;
    }
    
    setStabilityManager(stabilityManager) {
        this.stabilityManager = stabilityManager;
    }
    
    setupEventHandlers() {
        // QR code event
        this.client.on('qr', (qr) => {
            qrcode.toDataURL(qr)
                .then(url => this.io?.emit('qr', url))
                .catch(err => console.error('Error generating QR:', err));
        });

        // Ready event
        this.client.on('ready', () => {
            console.log('WhatsApp Web client ready');
            this.io?.emit('ready', 'WhatsApp Web client ready');
        });

        // Loading screen event
        this.client.on('loading_screen', (percent, message) => {
            console.log('Loading:', percent, '%', message);
            this.io?.emit('loading', { percent, message });
        });

        // Message event with queue
        this.client.on('message', async (message) => {
            try {
                this.stabilityManager?.updateLastMessage();
                await this.state.addToQueue(message);
            } catch (error) {
                console.error('Error in message queue:', error);
            }
        });
        
        // Error events
        this.client.on('disconnected', (reason) => {
            console.log('Client was disconnected:', reason);
            this.io?.emit('disconnected', reason);
            // Attempt to reconnect after a delay
            setTimeout(() => this.initialize(), 5000);
        });
    }
    
    async initialize() {
        try {
            this.setupEventHandlers();
            await this.client.initialize();
            console.log('WhatsApp client initialized successfully');
            return true;
        } catch (error) {
            console.error('Error initializing WhatsApp client:', error);
            return false;
        }
    }
    
    async destroy() {
        try {
            await this.client.destroy();
            console.log('WhatsApp client destroyed successfully');
            return true;
        } catch (error) {
            console.error('Error destroying WhatsApp client:', error);
            return false;
        }
    }
    
    getClient() {
        return this.client;
    }
}

// ========== SERVER SETUP ==========
class Server {
    constructor(port, whatsappBot) {
        this.port = port;
        this.whatsappBot = whatsappBot;
        
        this.app = express();
        this.httpServer = http.createServer(this.app);
        this.io = socketIo(this.httpServer, {
            pingTimeout: 60000,
            pingInterval: 25000
        });
        
        this.whatsappBot.setSocketIO(this.io);
    }
    
    setupRoutes() {
        this.app.use(express.static(path.join(__dirname, 'web')));
        this.app.use(express.json());

        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'web', 'index.html'));
        });
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.status(200).json({ status: 'OK', timestamp: new Date() });
        });
    }
    
    setupStabilityManager(stabilityManager) {
        this.whatsappBot.setStabilityManager(stabilityManager);
        stabilityManager.startStabilitySystem(this.app);
    }
    
    async start() {
        this.setupRoutes();
        
        return new Promise((resolve) => {
            this.httpServer.listen(this.port, () => {
                console.log(`Server running on http://localhost:${this.port}`);
                resolve(true);
            });
        });
    }
    
    async stop() {
        return new Promise((resolve, reject) => {
            this.httpServer.close((err) => {
                if (err) {
                    console.error('Error closing server:', err);
                    reject(err);
                } else {
                    console.log('Server stopped');
                    resolve(true);
                }
            });
        });
    }
}

// ========== MAIN APPLICATION ==========
// Create instances
const stateManager = new StateManager();
const fileManager = new FileManager(stateManager);
const aiService = new AIService(stateManager, fileManager);
const messageHandler = new MessageHandler(stateManager, aiService, fileManager);
const whatsappBot = new WhatsAppBot(stateManager, messageHandler);
const server = new Server(CONFIG.PORT, whatsappBot);
const stabilityManager = new StabilityManager(whatsappBot.getClient());

// Initialize application
async function initializeApp() {
    try {
        // Setup stability manager
        server.setupStabilityManager(stabilityManager);
        
        // Start server
        await server.start();
        
        // Initialize WhatsApp bot
        await whatsappBot.initialize();
        
        // Setup periodic cleanup
        setInterval(() => stateManager.cleanup(), CONFIG.CLEANUP_INTERVAL);
        
        console.log('Application initialized successfully');
    } catch (error) {
        console.error('Error initializing application:', error);
        process.exit(1);
    }
}

// Graceful shutdown
function setupGracefulShutdown() {
    process.on('SIGINT', async () => {
        console.log('Shutting down application...');
        clearInterval(memoryCheckInterval);
        await whatsappBot.destroy();
        await server.stop();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log('Received SIGTERM. Shutting down...');
        clearInterval(memoryCheckInterval);
        await whatsappBot.destroy();
        await server.stop();
        process.exit(0);
    });
}

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

// Initialize application
initializeApp();
setupGracefulShutdown();