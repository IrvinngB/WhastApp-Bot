// Importar las dependencias necesarias
const axios = require('axios');  // Para hacer peticiones HTTP
const URL = require('url').URL;  // Para manejar URLs de forma segura

// Definición de la clase principal
class StabilityManager {
    constructor(whatsappClient) {
        // Cliente de WhatsApp que se pasa como parámetro
        this.whatsappClient = whatsappClient;
        
        // Intervalo para el sistema de keepAlive
        this.keepAliveInterval = null;
        
        // Contador de intentos de reconexión
        this.reconnectAttempts = 0;
        
        // Constantes de configuración
        this.MAX_RECONNECT_ATTEMPTS = 5;  // Máximo número de intentos de reconexión
        this.RECONNECT_DELAY = 5000;      // Delay base para reconexión (5 segundos)
        
        // URL fija para el ping
        this.PING_URL = 'https://whastapp-bot-muv1.onrender.com';
        
        // Objeto para monitorear la salud del sistema
        this.healthCheck = {
            lastPing: Date.now(),      // Último ping exitoso
            lastMessage: Date.now(),    // Último mensaje procesado
            isHealthy: true            // Estado de salud del sistema
        };

        // Inicializar los manejadores de eventos
        this.setupEventHandlers();
    }

    // Configurar los manejadores de eventos del cliente WhatsApp
    setupEventHandlers() {
        // Evento cuando el cliente se desconecta
        this.whatsappClient.on('disconnected', async (reason) => {
            console.log('Cliente desconectado:', reason);
            
            // Si la razón es LOGOUT, limpiar la sesión
            if (reason === 'LOGOUT') {
                try {
                    await this.clearSession();
                } catch (error) {
                    console.error('Error limpiando sesión:', error);
                }
            }

            // Intentar reconectar
            await this.handleReconnection(reason);
        });

        // Evento cuando falla la autenticación
        this.whatsappClient.on('auth_failure', async (error) => {
            console.log('Error de autenticación:', error);
            await this.clearSession();
            await this.handleReconnection('AUTH_FAILURE');
        });

        // Evento cuando el cliente está listo
        this.whatsappClient.on('ready', () => {
            console.log('Cliente WhatsApp Web listo');
            this.reconnectAttempts = 0; // Resetear contador de intentos
        });
    }

    // Método para limpiar la sesión de WhatsApp
    async clearSession() {
        const sessionPath = '.wwebjs_auth/session-client';
        const fs = require('fs').promises;
        
        try {
            // Eliminar directorio de sesión de forma recursiva
            await fs.rm(sessionPath, { recursive: true, force: true });
            console.log('Sesión eliminada correctamente');
        } catch (error) {
            console.error('Error eliminando sesión:', error);
        }
    }

    // Manejar el proceso de reconexión
    async handleReconnection(reason) {
        // Verificar si se alcanzó el máximo de intentos
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.error('Máximo número de intentos de reconexión alcanzado');
            process.exit(1); // Forzar reinicio del servicio
            return;
        }

        // Incrementar contador y calcular delay
        this.reconnectAttempts++;
        const delay = this.RECONNECT_DELAY * this.reconnectAttempts;

        console.log(`Intento de reconexión ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} en ${delay/1000}s...`);
        
        // Esperar el tiempo de delay
        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            // Intentar inicializar el cliente
            await this.whatsappClient.initialize();
        } catch (error) {
            console.error('Error en la reconexión:', error);
            await this.handleReconnection(reason);
        }
    }

    // Método para realizar el ping con reintentos
    async keepAliveWithRetry() {
        try {
            // Realizar petición HTTP GET
            const response = await axios.get(this.PING_URL, {
                timeout: 5000,  // Timeout de 5 segundos
                validateStatus: function (status) {
                    return status >= 200 && status < 500;
                }
            });
            
            // Actualizar timestamp del último ping exitoso
            this.healthCheck.lastPing = Date.now();
            console.log(`Ping exitoso: ${response.status}`);
        } catch (error) {
            // Loggear error detallado
            console.error('Error en ping:', {
                message: error.message,
                url: this.PING_URL,
                code: error.code,
                response: error.response?.status
            });
            
            // Calcular delay para reintento con backoff exponencial
            const backoffDelay = Math.min(30000 * Math.pow(2, this.reconnectAttempts), 300000);
            console.log(`Reintentando en ${backoffDelay/1000}s...`);
            setTimeout(() => this.keepAliveWithRetry(), backoffDelay);
        }
    }

    // Iniciar el sistema de keepAlive
    startKeepAlive() {
        // Limpiar intervalo existente si lo hay
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }
        
        // Realizar primer ping inmediatamente
        this.keepAliveWithRetry();
        
        // Configurar intervalo para pings posteriores (cada 10 minutos)
        this.keepAliveInterval = setInterval(() => this.keepAliveWithRetry(), 10 * 60 * 1000);
        console.log('Sistema keepAlive iniciado');
    }

    // Actualizar estado de salud del sistema
    updateHealth() {
        const now = Date.now();
        const MAX_SILENCE = 30 * 60 * 1000; // 30 minutos

        // Verificar si el sistema está saludable
        this.healthCheck.isHealthy = (now - this.healthCheck.lastPing) < MAX_SILENCE && 
                                   (now - this.healthCheck.lastMessage) < MAX_SILENCE;

        // Si no está saludable, reiniciar servicios
        if (!this.healthCheck.isHealthy) {
            console.warn('Sistema posiblemente inactivo, reiniciando servicios...');
            this.restartServices();
        }
    }

    // Reiniciar todos los servicios
    async restartServices() {
        try {
            await this.clearSession();
            this.startKeepAlive();
            await this.whatsappClient.initialize();
            console.log('Servicios reiniciados exitosamente');
        } catch (error) {
            console.error('Error reiniciando servicios:', error);
            process.exit(1);
        }
    }

    // Configurar endpoint de health check
    setupHealthEndpoint(app) {
        app.get('/health', (req, res) => {
            res.json({
                status: this.healthCheck.isHealthy ? 'healthy' : 'unhealthy',
                lastPing: new Date(this.healthCheck.lastPing).toISOString(),
                lastMessage: new Date(this.healthCheck.lastMessage).toISOString(),
                reconnectAttempts: this.reconnectAttempts
            });
        });
    }

    // Actualizar timestamp del último mensaje
    updateLastMessage() {
        this.healthCheck.lastMessage = Date.now();
    }

    // Iniciar todo el sistema de estabilidad
    async startStabilitySystem(app) {
        // Configurar endpoint de health
        this.setupHealthEndpoint(app);
        
        // Iniciar sistema de keepAlive
        this.startKeepAlive();
        
        try {
            // Inicializar cliente de WhatsApp
            await this.whatsappClient.initialize();
        } catch (error) {
            console.error('Error en la inicialización inicial:', error);
            await this.handleReconnection('INITIAL_FAILURE');
        }

        // Configurar chequeo de salud cada 5 minutos
        setInterval(() => this.updateHealth(), 5 * 60 * 1000);
    }
}

// Exportar la clase para su uso en otros archivos
module.exports = StabilityManager;