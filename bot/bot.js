require('dotenv').config(); // Cargar las variables de entorno

const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); // Añadido para manejar la zona horaria de manera precisa

const pausedUsers = {}; // Objeto para almacenar el estado pausado de cada usuario

// Verificar si la clave de API está configurada
if (!process.env.GEMINI_API_KEY) {
    throw new Error('La variable de entorno GEMINI_API_KEY no está configurada.');
}

// Inicializar Google Generative AI con la clave de API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Leer archivos necesarios
function loadFile(filePath, defaultValue = '') {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        console.error(`Error leyendo el archivo ${filePath}:`, error);
        return defaultValue;
    }
}

// Cargar información desde archivos
const laptops = loadFile(path.join(__dirname, 'Laptops1.txt'));
const companyInfo = loadFile(path.join(__dirname, 'info_empresa.txt'));
const promptInstructions = loadFile(path.join(__dirname, 'promt.txt'));

// Crear un objeto para almacenar el contexto de cada usuario
const contextStore = {};

// Función para generar contenido basado en un prompt
async function generateResponse(userMessage, contactId) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    try {
        // Recuperar el contexto existente o inicializarlo
        const userContext = contextStore[contactId] || '';

        // Combinar las instrucciones del archivo promt.txt con el mensaje del usuario y el contexto previo
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
        const response = await result.response;
        const text = response.text();

        // Actualizar el contexto del usuario
        contextStore[contactId] = `${userContext}\nUsuario: ${userMessage}\nBot: ${text}`;

        return text;
    } catch (error) {
        console.error('Error generando la respuesta:', error);
        return 'Lo siento, no pude procesar tu solicitud en este momento.';
    }
}

// Función para verificar si la tienda está abierta en horario de Panamá
function isStoreOpen() {
    const panamaTime = moment().tz("America/Panama");
    const day = panamaTime.day(); // 0: Domingo, 1: Lunes, ..., 6: Sábado
    const hour = panamaTime.hour();

    if (day >= 1 && day <= 5) {
        // Lunes a Viernes
        return hour >= 9 && hour < 20;
    } else if (day === 0 || day === 6) {
        // Sábado y Domingo
        return hour >= 10 && hour < 18;
    }
    return false;
}

// Configurar el cliente de WhatsApp Web
const whatsappClient = new Client();

whatsappClient.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, qrCodeUrl) => {
        if (err) {
            console.error('Error generando el QR:', err);
        } else {
            io.emit('qr', qrCodeUrl); // Emitir el QR al frontend
        }
    });
});

whatsappClient.on('ready', () => {
    console.log('El cliente de WhatsApp Web está listo!');
    io.emit('ready', 'El cliente de WhatsApp Web está listo!');
});

whatsappClient.on('message', async message => {
    const contactId = message.from;

    // Verificar si el usuario está pausado (pidió hablar con una persona real)
    if (pausedUsers[contactId]) {
        console.log(`Usuario ${contactId} está pausado, mensajes ignorados.`);
        return; // Ignorar todos los mensajes mientras el bot está pausado
    }

    console.log(`Mensaje recibido: ${message.body}`);

    if (message.hasMedia) {
        if (message.type === 'audio') {
            message.reply('Se te va a comunicar con un asistente real.');
            return;
        } else if (['sticker', 'image', 'video', 'document', 'location'].includes(message.type)) {
            return;
        }
    }

    const spamWords = ['spam', 'publicidad', 'promo'];
    const isSpam = spamWords.some(word => message.body.toLowerCase().includes(word));

    if (isSpam) {
        return;
    }

    let responseText;

    if (message.body.toLowerCase().includes('contactar persona real')) {
        // Pausar la interacción del bot y simular que se está contactando a una persona real
        message.reply('Conectándote con un asistente humano. Por favor, espera.');

        // Marcar al usuario como pausado
        pausedUsers[contactId] = true;

        // Reiniciar el bot después de 1 hora de inactividad
        setTimeout(() => {
            console.log(`Reiniciando el bot para el usuario ${contactId} después de 1 hora de inactividad.`);
            delete pausedUsers[contactId]; // Quitar la pausa del usuario
            whatsappClient.sendMessage(contactId, 'El asistente virtual está disponible de nuevo. ¿En qué más puedo ayudarte?');
        }, 60 * 60 * 1000); // 1 hora en milisegundos

        return; // Detener el procesamiento de mensajes
    }

    if (message.body.toLowerCase() === 'hola') {
        responseText = '¡Hola! ¿En qué puedo ayudarte con respecto a ElectronicsJS?';
    } else {
        // Verificar si la tienda está abierta en horario de Panamá
        if (isStoreOpen()) {
            // Generar una respuesta usando la IA
            responseText = await generateResponse(message.body, contactId);
        } else {
            responseText = 'Gracias por tu mensaje. Nuestra tienda está cerrada en este momento, pero responderemos tan pronto como volvamos a abrir.';
        }
    }

    message.reply(responseText);
});

whatsappClient.initialize();

// Configurar Express y Socket.IO
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Servir archivos estáticos desde la carpeta 'web'
app.use(express.static(path.join(__dirname, 'web')));

// Servir el archivo index.html en la ruta raíz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

server.listen(3000, () => {
    console.log('Servidor escuchando en http://localhost:3000');
});
