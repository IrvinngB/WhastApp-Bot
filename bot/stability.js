const axios = require('axios');

class StabilityManager {
    constructor(whatsappClient) {
        this.whatsappClient = whatsappClient;
        this.keepAliveInterval = null;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT_ATTEMPTS = 5;
        this.RECONNECT_DELAY = 5000;
        this.healthCheck = {
            lastPing: Date.now(),
            lastMessage: Date.now(),
            isHealthy: true
        };

        // Configurar manejadores de eventos mejorados
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.whatsappClient.on('disconnected', async (reason) => {
            console.log('Cliente desconectado:', reason);
            
            // Limpiar la sesión si el motivo es LOGOUT
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

        this.whatsappClient.on('auth_failure', async (error) => {
            console.log('Error de autenticación:', error);
            await this.clearSession();
            await this.handleReconnection('AUTH_FAILURE');
        });

        this.whatsappClient.on('ready', () => {
            console.log('Cliente WhatsApp Web listo');
            this.reconnectAttempts = 0; // Resetear contador de intentos
        });
    }

    async clearSession() {
        const sessionPath = '.wwebjs_auth/session-client';
        const fs = require('fs').promises;
        
        try {
            await fs.rm(sessionPath, { recursive: true, force: true });
            console.log('Sesión eliminada correctamente');
        } catch (error) {
            console.error('Error eliminando sesión:', error);
            // Continuar incluso si hay error
        }
    }

    async handleReconnection(reason) {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.error('Máximo número de intentos de reconexión alcanzado');
            process.exit(1); // Forzar reinicio del servicio
            return;
        }

        this.reconnectAttempts++;
        const delay = this.RECONNECT_DELAY * this.reconnectAttempts; // Delay exponencial

        console.log(`Intento de reconexión ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} en ${delay/1000}s...`);
        
        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            // Reinicializar el cliente
            await this.whatsappClient.initialize();
        } catch (error) {
            console.error('Error en la reconexión:', error);
            await this.handleReconnection(reason); // Intentar nuevamente
        }
    }

    async keepAliveWithRetry() {
        if (!process.env.RENDER_EXTERNAL_URL) return;
        
        try {
            const response = await axios.get(`https://${process.env.RENDER_EXTERNAL_URL}`);
            this.healthCheck.lastPing = Date.now();
            console.log('Ping exitoso:', response.status);
        } catch (error) {
            console.error('Error en ping, reintentando en 30s:', error.message);
            setTimeout(() => this.keepAliveWithRetry(), 30000);
        }
    }

    startKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }
        this.keepAliveInterval = setInterval(() => this.keepAliveWithRetry(), 10 * 60 * 1000);
        console.log('Sistema keepAlive iniciado');
    }

    updateHealth() {
        const now = Date.now();
        const MAX_SILENCE = 30 * 60 * 1000;

        this.healthCheck.isHealthy = (now - this.healthCheck.lastPing) < MAX_SILENCE && 
                                   (now - this.healthCheck.lastMessage) < MAX_SILENCE;

        if (!this.healthCheck.isHealthy) {
            console.warn('Sistema posiblemente inactivo, reiniciando servicios...');
            this.restartServices();
        }
    }

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

    updateLastMessage() {
        this.healthCheck.lastMessage = Date.now();
    }

    async startStabilitySystem(app) {
        this.setupHealthEndpoint(app);
        this.startKeepAlive();
        
        try {
            await this.whatsappClient.initialize();
        } catch (error) {
            console.error('Error en la inicialización inicial:', error);
            await this.handleReconnection('INITIAL_FAILURE');
        }

        setInterval(() => this.updateHealth(), 5 * 60 * 1000);
    }
}

module.exports = StabilityManager;