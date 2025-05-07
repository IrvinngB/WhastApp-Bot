const { generateResponse } = require("./ai-service")
const {
  SYSTEM_MESSAGES,
  MEDIA_TYPES,
  SPAM_PATTERNS,
  MESSAGE_RATE_LIMIT,
  PAUSE_DURATION,
  getStoreStatus,
} = require("./utils")

// Estado global
let isProcessingMessage = false
const messageQueue = []
const MAX_QUEUE_SIZE = 100

// Mapas para gestión de usuarios
const pausedUsers = new Map()
const userRequestsHuman = new Map()
const lastUserMessages = new Map() // Para detectar mensajes repetidos
const spamCooldown = new Map() // Para manejar el cooldown después de detectar spam
const userMessageCounts = new Map()

// Sistema de rate limiting mejorado
function checkRateLimit(userId) {
  const now = Date.now()
  const userCount = userMessageCounts.get(userId) || { count: 0, timestamp: now }

  // Limpiar contadores antiguos
  if (now - userCount.timestamp > MESSAGE_RATE_LIMIT.WINDOW_MS) {
    userCount.count = 1
    userCount.timestamp = now
  } else {
    userCount.count++
  }

  userMessageCounts.set(userId, userCount)
  return userCount.count > MESSAGE_RATE_LIMIT.MAX_MESSAGES
}

// Función para detectar mensajes repetidos
function isRepeatedMessage(userId, message) {
  const lastMessage = lastUserMessages.get(userId)
  const currentMessage = message.toLowerCase().trim()

  if (lastMessage && lastMessage.text === currentMessage) {
    lastMessage.count++
    if (lastMessage.count >= 4) {
      // Si el usuario envía 4 mensajes iguales
      lastMessage.count = 0 // Reiniciar el contador
      return true // Indicar que se debe aplicar el cooldown
    }
  } else {
    lastUserMessages.set(userId, {
      text: currentMessage,
      count: 1,
      timestamp: Date.now(),
    })
  }

  return false
}

// Función para detectar spam
function isSpamMessage(message) {
  const messageText = message.body.toLowerCase()

  // Verificar patrones de spam
  const containsSpamPattern = SPAM_PATTERNS.some((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern.test(messageText)
    }
    return messageText.includes(pattern)
  })

  // Verificar características sospechosas
  const hasMultipleUrls = (messageText.match(/https?:\/\//g) || []).length > 1
  const hasMultiplePhoneNumbers = (messageText.match(/\b\d{8,}\b/g) || []).length > 1
  const hasExcessivePunctuation = (messageText.match(/[!?]/g) || []).length > 5

  return containsSpamPattern || hasMultipleUrls || hasMultiplePhoneNumbers || hasExcessivePunctuation
}

// Función para manejar mensajes con medios
async function handleMediaMessage(message, whatsappClient) {
  const mediaType = message.type
  let responseText = SYSTEM_MESSAGES.MEDIA_RECEIVED

  // Personalizar mensaje según el tipo de medio
  switch (mediaType) {
    case MEDIA_TYPES.IMAGE:
      responseText = `${responseText}\n\n📸 He notado que has compartido una imagen.`
      break
    case MEDIA_TYPES.AUDIO:
      responseText = `${responseText}\n\n🎵 He notado que has compartido un mensaje de voz.`
      break
    case MEDIA_TYPES.VIDEO:
      responseText = `${responseText}\n\n🎥 He notado que has compartido un video.`
      break
    case MEDIA_TYPES.DOCUMENT:
      responseText = `${responseText}\n\n📄 He notado que has compartido un documento.`
      break
  }

  try {
    await message.reply(responseText)
    pausedUsers.set(message.from, true)
    userRequestsHuman.set(message.from, true)

    // Programar la limpieza después del período de pausa
    setTimeout(() => {
      if (pausedUsers.get(message.from)) {
        pausedUsers.delete(message.from)
        userRequestsHuman.delete(message.from)
        whatsappClient.sendMessage(
          message.from,
          "El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?",
        )
      }
    }, PAUSE_DURATION)
  } catch (error) {
    console.error("Error handling media message:", error)
    await message.reply(SYSTEM_MESSAGES.ERROR)
  }
}

// Funciones para verificar mensajes
function isRequestingHuman(message) {
  const humanKeywords = ["agente", "persona real", "humano", "representante", "asesor", "hablar con alguien"]
  return humanKeywords.some((keyword) => message.toLowerCase().includes(keyword))
}

function isReturningToBot(message) {
  const botKeywords = ["volver al bot", "bot", "asistente virtual", "chatbot"]
  return botKeywords.some((keyword) => message.toLowerCase().includes(keyword))
}

// Manejador de mensajes principal mejorado
async function handleMessage(message, whatsappClient, stabilityManager) {
  stabilityManager.updateLastMessage()

  const contactId = message.from
  const messageText = message.body.toLowerCase()

  // Verificar rate limiting
  if (checkRateLimit(contactId)) {
    await message.reply(SYSTEM_MESSAGES.RATE_LIMIT)
    return
  }

  // Verificar mensajes repetidos
  if (isRepeatedMessage(contactId, messageText)) {
    if (lastUserMessages.get(contactId).count === 0) {
      // Si es el cuarto mensaje repetido
      await message.reply(SYSTEM_MESSAGES.SPAM_WARNING)
      spamCooldown.set(contactId, Date.now() + 120000) // 2 minutos de cooldown
      return
    } else {
      await message.reply(SYSTEM_MESSAGES.REPEATED_MESSAGE)
      return
    }
  }

  // Verificar si el usuario está en cooldown por spam
  if (spamCooldown.has(contactId)) {
    const cooldownEnd = spamCooldown.get(contactId)
    if (Date.now() < cooldownEnd) {
      return // No responder durante el cooldown
    } else {
      spamCooldown.delete(contactId) // Eliminar el cooldown si ha expirado
    }
  }

  // Verificar si el mensaje es spam
  if (isSpamMessage(message)) {
    await message.reply(SYSTEM_MESSAGES.SPAM_WARNING)
    spamCooldown.set(contactId, Date.now() + 180000) // 3 minutos de cooldown
    return
  }

  // Verificar si el usuario está solicitando atención humana
  if (isRequestingHuman(messageText)) {
    // Eliminar verificación de horario y permitir solicitar agente en cualquier momento
    await message.reply(SYSTEM_MESSAGES.HUMAN_REQUEST)
    pausedUsers.set(contactId, true)
    userRequestsHuman.set(contactId, true)

    setTimeout(() => {
      if (pausedUsers.get(contactId)) {
        pausedUsers.delete(contactId)
        userRequestsHuman.delete(contactId)
        whatsappClient.sendMessage(
          contactId,
          "El asistente virtual está nuevamente disponible. ¿En qué puedo ayudarte?",
        )
      }
    }, PAUSE_DURATION)

    return
  }

  // Verificar si el usuario quiere volver al bot
  if (isReturningToBot(messageText) && userRequestsHuman.get(contactId)) {
    pausedUsers.delete(contactId)
    userRequestsHuman.delete(contactId)
    await message.reply("¡Bienvenido de vuelta! ¿En qué puedo ayudarte?")
    return
  }

  if (pausedUsers.get(contactId)) {
    return
  }

  // Verificar si el mensaje contiene medios
  if (message.hasMedia) {
    await handleMediaMessage(message, whatsappClient)
    return
  }

  //Mensajes de welcome y horario
  try {
    let responseText

    if (messageText === "hola") {
      responseText = SYSTEM_MESSAGES.WELCOME
    } else if (messageText === "horario") {
      responseText = SYSTEM_MESSAGES.HORARIO
    } else if (/web|página web|pagina web/i.test(messageText)) {
      responseText = SYSTEM_MESSAGES.WEB_PAGE
    } else {
      responseText = await generateResponse(message.body, contactId)
    }

    await message.reply(responseText)
  } catch (error) {
    console.error("Error procesando mensaje:", error)
    await message.reply(SYSTEM_MESSAGES.ERROR)
  }
}

// Sistema de cola de mensajes mejorado
async function processMessageQueue(handleMessage, whatsappClient, stabilityManager) {
  if (isProcessingMessage || messageQueue.length === 0) return

  isProcessingMessage = true
  const { message, resolve, reject } = messageQueue.shift()

  try {
    await handleMessage(message, whatsappClient, stabilityManager)
    resolve()
  } catch (error) {
    console.error("Error procesando mensaje en cola:", error)
    reject(error)
  } finally {
    isProcessingMessage = false
    if (messageQueue.length > 0) {
      processMessageQueue(handleMessage, whatsappClient, stabilityManager)
    }
  }
}

// Función para agregar mensaje a la cola
function queueMessage(message, handleMessage, whatsappClient, stabilityManager) {
  return new Promise((resolve, reject) => {
    if (messageQueue.length >= MAX_QUEUE_SIZE) {
      messageQueue.shift() // Eliminar el mensaje más antiguo
    }
    messageQueue.push({ message, resolve, reject })
    processMessageQueue(handleMessage, whatsappClient, stabilityManager)
  })
}

// Limpieza periódica de datos
setInterval(() => {
  const now = Date.now()

  // Limpiar contadores de mensajes antiguos
  for (const [userId, data] of userMessageCounts.entries()) {
    if (now - data.timestamp > MESSAGE_RATE_LIMIT.WINDOW_MS * 2) {
      userMessageCounts.delete(userId)
    }
  }

  // Limpiar mensajes repetidos antiguos
  for (const [userId, data] of lastUserMessages.entries()) {
    if (now - data.timestamp > MESSAGE_RATE_LIMIT.WINDOW_MS) {
      lastUserMessages.delete(userId)
    }
  }

  // Limpiar cooldowns expirados
  for (const [userId, cooldownEnd] of spamCooldown.entries()) {
    if (now > cooldownEnd) {
      spamCooldown.delete(userId)
    }
  }
}, MESSAGE_RATE_LIMIT.WINDOW_MS)

module.exports = {
  pausedUsers,
  userRequestsHuman,
  lastUserMessages,
  spamCooldown,
  userMessageCounts,
  checkRateLimit,
  isRepeatedMessage,
  isSpamMessage,
  handleMediaMessage,
  isRequestingHuman,
  isReturningToBot,
  handleMessage,
  processMessageQueue,
  queueMessage,
}
