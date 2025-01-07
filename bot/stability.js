const axios = require('axios');

class StabilityManager {
    constructor(whatsappClient) {
        this.whatsappClient = whatsappClient;
        this.keepAliveInterval = null;
        this.healthCheck = {
            lastPing: Date.now(),
            lastMessage: Date.now(),
            isHealthy: true
        };
    }

    // Configuración de keepAlive mejorada
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
        this.keepAliveInterval = setInterval(() => this.keepAliveWithRetry(), 10 * 60 * 1000); // 10 minutos
        console.log('Sistema keepAlive iniciado');
    }

    async initializeWhatsAppWithReconnect() {
        let retryCount = 0;
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 5000;

        const initialize = async () => {
            try {
                await this.whatsappClient.initialize();
                retryCount = 0;
                console.log('WhatsApp cliente inicializado exitosamente');
            } catch (error) {
                console.error('Error inicializando WhatsApp:', error);
                
                if (retryCount < MAX_RETRIES) {
                    retryCount++;
                    console.log(`Reintentando inicialización (${retryCount}/${MAX_RETRIES}) en ${RETRY_DELAY/1000}s...`);
                    setTimeout(initialize, RETRY_DELAY);
                } else {
                    console.error('Máximo número de reintentos alcanzado');
                    process.exit(1);
                }
            }
        };

        // Manejar desconexiones
        this.whatsappClient.on('disconnected', async (reason) => {
            console.log('Cliente desconectado:', reason);
            await initialize();
        });

        await initialize();
    }

    updateHealth() {
        const now = Date.now();
        const MAX_SILENCE = 30 * 60 * 1000; // 30 minutos

        this.healthCheck.isHealthy = (now - this.healthCheck.lastPing) < MAX_SILENCE && 
                                   (now - this.healthCheck.lastMessage) < MAX_SILENCE;

        if (!this.healthCheck.isHealthy) {
            console.warn('Sistema posiblemente inactivo, reiniciando servicios...');
            this.restartServices();
        }
    }

    async restartServices() {
        try {
            this.startKeepAlive();
            await this.whatsappClient.resetState();
            await this.initializeWhatsAppWithReconnect();
            console.log('Servicios reiniciados exitosamente');
        } catch (error) {
            console.error('Error reiniciando servicios:', error);
            process.exit(1);
        }
    }

    // Método para configurar el endpoint de salud en Express
    setupHealthEndpoint(app) {
        app.get('/health', (req, res) => {
            res.json({
                status: this.healthCheck.isHealthy ? 'healthy' : 'unhealthy',
                lastPing: new Date(this.healthCheck.lastPing).toISOString(),
                lastMessage: new Date(this.healthCheck.lastMessage).toISOString()
            });
        });
    }

    // Método para iniciar todo el sistema de estabilidad
    startStabilitySystem(app) {
        this.setupHealthEndpoint(app);
        this.startKeepAlive();
        this.initializeWhatsAppWithReconnect();
        setInterval(() => this.updateHealth(), 5 * 60 * 1000); // Revisar cada 5 minutos
    }

    // Método para actualizar el último mensaje recibido
    updateLastMessage() {
        this.healthCheck.lastMessage = Date.now();
    }
}

module.exports = StabilityManager;