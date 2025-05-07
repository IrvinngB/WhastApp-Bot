const fs = require("fs")
const path = require("path")

// Caché para archivos
const fileCache = new Map()

// Función mejorada para cargar archivos con caché
function loadFile(filePath, defaultValue = "") {
  try {
    if (fileCache.has(filePath)) {
      return fileCache.get(filePath)
    }

    const fullPath = path.join(__dirname, "..", filePath)
    if (!fs.existsSync(fullPath)) {
      console.warn(`Archivo no encontrado: ${filePath}`)
      return defaultValue
    }

    const content = fs.readFileSync(fullPath, "utf8")
    fileCache.set(filePath, content)
    return content
  } catch (error) {
    console.error(`Error leyendo el archivo ${filePath}:`, error)
    return defaultValue
  }
}

// Función para limpiar la caché
function clearFileCache() {
  fileCache.clear()
}

// Función para recargar un archivo específico
function reloadFile(filePath) {
  fileCache.delete(filePath)
  return loadFile(filePath)
}

module.exports = {
  fileCache,
  loadFile,
  clearFileCache,
  reloadFile,
}
