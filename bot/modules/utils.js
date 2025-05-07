const moment = require("moment-timezone")

// Constantes y configuración
const MEDIA_TYPES = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  DOCUMENT: "document",
  STICKER: "sticker",
}

const SPAM_PATTERNS = [
  "spam",
  "publicidad",
  "promo",
  "gana dinero",
  "investment",
  "casino",
  "lottery",
  "premio",
  "ganaste",
  "bitcoin",
  "crypto",
  "prestamo",
  "loan",
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // Email pattern
  /(?:https?:\/\/)?(?:[\w-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?/, // URL pattern
]

const PANAMA_TIMEZONE = "America/Panama"
const PAUSE_DURATION = 60 * 60 * 1000
const MAX_RETRIES = 3
const MESSAGE_TIMEOUT = 60000 // 60 segundos

// Sistema de rate limiting
const MESSAGE_RATE_LIMIT = {
  WINDOW_MS: 60000, // 1 minuto
  MAX_MESSAGES: 10, // máximo 10 mensajes por minuto
}

// Sistema de mensajes mejorado
const SYSTEM_MESSAGES = {
  WELCOME: `¡Hola! 👋 Soy Electra, el asistente virtual de ElectronicsJS. Estoy aquí para ayudarte con información sobre nuestros productos y servicios. 

Si en cualquier momento deseas hablar con un representante humano, puedes escribir "agente" o "hablar con persona real".

¿En qué puedo ayudarte hoy?`,

  HUMAN_REQUEST: `Entiendo que prefieres hablar con un representante humano. Voy a conectarte con uno de nuestros agentes.

⏳ Por favor, ten en cuenta que puede haber un tiempo de espera. Mientras tanto, ¿hay algo específico en lo que pueda ayudarte?

Para volver al asistente virtual en cualquier momento, escribe "volver al bot".`,

  STORE_CLOSED: `¡Bienvenido a ElectronicsJS! 👋

    Estamos disponibles 24/7 para ayudarte con:
    - Información sobre productos
    - Información sobre la empresa
    - Preguntas frecuentes
    - Soporte técnico

    Para consultas más complejas, puedes escribir "agente" para hablar con un representante humano.
    
    ¿En qué puedo ayudarte hoy?`,

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
    Atención disponible 24 horas al día, 7 días a la semana.
    ¡Estamos siempre listos para ayudarte!`,

  WEB_PAGE: `Para más información, visita nuestra página web: https://irvin-benitez.software. Estamos aquí para ayudarte con cualquier consulta que tengas sobre nuestros productos y servicios. ¡Gracias por elegir ElectronicsJS!`,
}

// Función mejorada para verificar horario
function getStoreStatus() {
  const panamaTime = moment().tz(PANAMA_TIMEZONE)
  const day = panamaTime.day()
  const hour = panamaTime.hour()

  const schedule = {
    weekday: { start: 6, end: 22 },
    weekend: { start: 7, end: 20 },
  }

  const isWeekday = day >= 1 && day <= 5
  const { start, end } = isWeekday ? schedule.weekday : schedule.weekend

  const isOpen = hour >= start && hour < end
  const nextOpeningTime = isOpen
    ? null
    : panamaTime
        .clone()
        .startOf("day")
        .add(isWeekday ? start : day === 6 ? 10 : 9, "hours")

  return {
    isOpen,
    nextOpeningTime,
  }
}

module.exports = {
  MEDIA_TYPES,
  SPAM_PATTERNS,
  PANAMA_TIMEZONE,
  PAUSE_DURATION,
  MAX_RETRIES,
  MESSAGE_TIMEOUT,
  MESSAGE_RATE_LIMIT,
  SYSTEM_MESSAGES,
  getStoreStatus,
}
