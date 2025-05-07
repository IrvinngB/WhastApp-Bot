const { GoogleGenerativeAI } = require("@google/generative-ai")
const { loadFile } = require("./file-manager")
const { SYSTEM_MESSAGES, MESSAGE_TIMEOUT, MAX_RETRIES } = require("./utils")

// Estado global con gestión de memoria mejorada
const contextStore = new Map()

// Verificación de variables de entorno
if (!process.env.GEMINI_API_KEY) {
  throw new Error("La variable de entorno GEMINI_API_KEY no está configurada.")
}

// Inicializar Google Generative AI con manejo de errores
let genAI
try {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
} catch (error) {
  console.error("Error inicializando Google Generative AI:", error)
  process.exit(1)
}

// --- Selección de dataset relevante preguntando a la IA ---
async function selectRelevantDatasetWithAI(userMessage) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })
  // Descripciones breves de cada dataset
  const datasets = [
    {
      name: "Laptops1.txt",
      description: "Listado de laptops, componentes, accesorios y servicios disponibles en ElectronicsJS.",
    },
    {
      name: "info_empresa.txt",
      description: "Información sobre la empresa, misión, visión, políticas, horarios y contacto.",
    },
  ]
  const datasetsList = datasets.map((ds) => `- ${ds.name}: ${ds.description}`).join("\n")
  const selectionPrompt = `Tengo los siguientes datasets de información para responder preguntas de clientes.\n${datasetsList}\n\n¿Según la siguiente consulta de usuario, cuál dataset es el más relevante para responder?\nConsulta: \"${userMessage}\"\n\nResponde solo el nombre del archivo más relevante, sin explicación extra.`
  try {
    const result = await model.generateContent(selectionPrompt)
    const text = result.response.text().toLowerCase()
    if (text.includes("laptops1")) return "Laptops1.txt"
    if (text.includes("info_empresa")) return "info_empresa.txt"
    // fallback
    return "info_empresa.txt"
  } catch (e) {
    console.error("Error seleccionando dataset relevante con IA:", e)
    return "info_empresa.txt"
  }
}

// Función mejorada para generar respuestas
async function generateResponse(userMessage, contactId, retryCount = 0) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

  try {
    const userContext = contextStore.get(contactId) || ""

    // --- Selección dinámica del dataset relevante ---
    const relevantDatasetFile = await selectRelevantDatasetWithAI(userMessage)
    const datasetContext = loadFile(relevantDatasetFile)

    const customPrompt = `
        Eres un asistente virtual llamado Electra amigable y profesional de ElectronicsJS. Tu objetivo es proporcionar la mejor atención posible siguiendo estas pautas:
        \nCONTEXTO RELEVANTE:\n${datasetContext}
        \nHistorial del usuario: ${userContext}
        \nRESPONDE A: \"${userMessage}\"\n
        FORMATO DE RESPUESTA:
        - Mantén las respuestas concisas (máximo 4-5 líneas)
        - Usa viñetas para listas largas
        - Incluye emojis relevantes ocasionalmente`

    const result = await Promise.race([
      model.generateContent(customPrompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), MESSAGE_TIMEOUT)),
    ])

    let text = result.response.text()

    // Verificar si el cliente ha expresado interés en comprar o cotizar
    const purchaseKeywords = ["comprar", "cotizar", "llevar", "adquirir", "quiero comprar", "precio", "costo"]
    const isPurchaseIntent = purchaseKeywords.some((keyword) => userMessage.toLowerCase().includes(keyword))

    // Solo agregar el mensaje de compra si el cliente ha expresado interés en comprar
    if (isPurchaseIntent) {
      text += `\n\n¿Te gustaría comprar esta laptop? Aquí tienes las opciones disponibles:
            - 🗣️ Hablar con un agente real: Escribe "agente" para conectarte con un representante.
            - 🌐 Comprar en línea: Visita nuestra página web: https://irvin-benitez.software
            - 🏬 Visitar la tienda: Estamos ubicados en La chorrera. ¡Te esperamos!`
    }

    // Actualizar contexto con límite de memoria
    const newContext = `${userContext.slice(-1000)}\nUsuario: ${userMessage}\nBot: ${text}`.trim()
    contextStore.set(contactId, newContext)

    return text
  } catch (error) {
    console.error("Error generando la respuesta:", error)

    if (error.message === "TIMEOUT" && retryCount < MAX_RETRIES) {
      console.log(`Reintentando generación de respuesta (${retryCount + 1}/${MAX_RETRIES})...`)
      return generateResponse(userMessage, contactId, retryCount + 1)
    }

    return SYSTEM_MESSAGES.ERROR
  }
}

module.exports = {
  genAI,
  contextStore,
  selectRelevantDatasetWithAI,
  generateResponse,
}
