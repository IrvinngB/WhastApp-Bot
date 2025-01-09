const axios = require('axios');
const URL = require('url').URL;
const fs = require('fs').promises;
const path = require('path');

class StabilityManager {
    constructor(whatsappClient) {
        this.whatsappClient = whatsappClient;
        this.keepAliveInterval = null;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        
        // Constantes optimizadas
        this.MAX_RECONNECT_ATTEMPTS = 10;    // Aumentado para mayor resistencia
        this.RECONNECT_DELAY = 10000;        // Delay base aumentado a 10 segundos
        this.PING_INTERVAL = 5 * 60 * 1000;  // 5 minutos
        this.HEALTH_CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutos
        this.MAX_SILENCE = 60 * 60 * 1000;   // 1 hora
        
        // URL para el ping usando variable de entorno con fallback
        this.PING_URL = process.env.APP_URL || 'https://whastapp-bot-muv1.onrender.com';
        
        // Sistema de monitoreo mejorado
        this.healthCheck = {
            lastPing: Date.now(),
            lastMessage: Date.now(),
            isHealthy: true,
            metrics: {
                totalReconnects: 0,
                lastRestart: null,
                uptime: Date.now(),
                errors: []
            }
        };

        // Manejo de memoria
        this.setupMemoryMonitoring();
        
        // Inicializar eventos
        this.setupEventHandlers();
    }

    setupMemoryMonitoring() {
        // Monitorear uso de memoria cada 5 minutos
        setInterval(() => {
            const used = process.memoryUsage();
            const metrics = {
                rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
                heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
                heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`
            };

            // Si el uso de memoria es alto, forzar GC si está disponible
            if (used.heapUsed > 500 * 1024 * 1024) { // 500MB
                try {
                    if (global.gc) {
                        global.gc();
                        console.log('Garbage collection ejecutado');
                    }
                } catch (e) {
                    console.log('GC no disponible');
                }
            }

            console.log('Métricas de memoria:', metrics);
        }, 5 * 60 * 1000);
    }

    setupEventHandlers() {
        this.whatsappClient.on('disconnected', async (reason) => {
            console.log('Cliente desconectado:', reason);
            
            // Registrar el evento
            this.logError('disconnect', reason);
            
            if (reason === 'LOGOUT') {
                await this.clearSession();
            }

            // Prevenir múltiples intentos simultáneos de reconexión
            if (!this.isReconnecting) {
                this.isReconnecting = true;
                await this.handleReconnection(reason);
                this.isReconnecting = false;
            }
        });

        this.whatsappClient.on('auth_failure', async (error) => {
            console.log('Error de autenticación:', error);
            this.logError('auth_failure', error);
            await this.clearSession();
            await this.handleReconnection('AUTH_FAILURE');
        });

        this.whatsappClient.on('ready', () => {
            console.log('Cliente WhatsApp Web listo');
            this.reconnectAttempts = 0;
            this.healthCheck.metrics.lastRestart = null;
            this.healthCheck.isHealthy = true;
        });

        // Manejo de errores de puppeteer
        this.whatsappClient.on('chrome_error', async (error) => {
            console.error('Error de Chrome:', error);
            this.logError('chrome_error', error);
            await this.handleReconnection('CHROME_ERROR');
        });
    }

    logError(type, error) {
        const errorLog = {
            type,
            timestamp: new Date().toISOString(),
            message: error.toString(),
            stack: error.stack
        };

        this.healthCheck.metrics.errors.push(errorLog);
        
        // Mantener solo los últimos 50 errores
        if (this.healthCheck.metrics.errors.length > 50) {
            this.healthCheck.metrics.errors.shift();
        }
    }

    async clearSession() {
        const sessionPath = path.join(process.cwd(), '.wwebjs_auth/session-client');
        
        try {
            await fs.rm(sessionPath, { recursive: true, force: true });
            console.log('Sesión eliminada correctamente');
        } catch (error) {
            console.error('Error eliminando sesión:', error);
            this.logError('session_clear', error);
        }
    }

    async handleReconnection(reason) {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.error('Máximo número de intentos de reconexión alcanzado');
            this.healthCheck.metrics.lastRestart = Date.now();
            this.healthCheck.isHealthy = false;
            
            // Reiniciar el proceso después de limpiar
            await this.cleanupBeforeExit();
            process.exit(1);
            return;
        }

        this.reconnectAttempts++;
        this.healthCheck.metrics.totalReconnects++;
        
        // Backoff exponencial con jitter
        const baseDelay = this.RECONNECT_DELAY * Math.pow(1.5, this.reconnectAttempts - 1);
        const jitter = Math.random() * 1000;
        const delay = Math.min(baseDelay + jitter, 300000); // máximo 5 minutos

        console.log(`Intento de reconexión ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} en ${delay/1000}s...`);
        
        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            await this.whatsappClient.initialize();
        } catch (error) {
            console.error('Error en la reconexión:', error);
            this.logError('reconnection', error);
            await this.handleReconnection(reason);
        }
    }

    async cleanupBeforeExit() {
        try {
            // Limpiar intervalos
            if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
            
            // Cerrar cliente de WhatsApp
            await this.whatsappClient.destroy();
            
            // Limpiar sesión
            await this.clearSession();
            
            console.log('Limpieza completada antes de salir');
        } catch (error) {
            console.error('Error en limpieza:', error);
        }
    }

    async keepAliveWithRetry() {
        try {
            const response = await axios.get(this.PING_URL, {
                timeout: 10000,  // Aumentado a 10 segundos
                validateStatus: status => status >= 200 && status < 500,
                headers: {
                    'User-Agent': 'WhatsAppBot/1.0 HealthCheck'
                }
            });
            
            this.healthCheck.lastPing = Date.now();
            console.log(`Ping exitoso: ${response.status}`);
            
            // Resetear intentos si el ping es exitoso
            this.reconnectAttempts = 0;
        } catch (error) {
            console.error('Error en ping:', {
                message: error.message,
                url: this.PING_URL,
                code: error.code,
                response: error.response?.status
            });
            
            const backoffDelay = Math.min(
                15000 * Math.pow(1.5, this.reconnectAttempts), 
                180000
            );
            
            console.log(`Reintentando ping en ${backoffDelay/1000}s...`);
            setTimeout(() => this.keepAliveWithRetry(), backoffDelay);
        }
    }

    startKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }
        
        this.keepAliveWithRetry();
        this.keepAliveInterval = setInterval(
            () => this.keepAliveWithRetry(), 
            this.PING_INTERVAL
        );
        console.log('Sistema keepAlive iniciado');
    }

    updateHealth() {
        const now = Date.now();
        
        // Verificar salud del sistema
        this.healthCheck.isHealthy = 
            (now - this.healthCheck.lastPing) < this.MAX_SILENCE && 
            (now - this.healthCheck.lastMessage) < this.MAX_SILENCE;

        // Actualizar uptime
        this.healthCheck.metrics.uptime = now - this.healthCheck.metrics.uptime;

        if (!this.healthCheck.isHealthy && !this.isReconnecting) {
            console.warn('Sistema posiblemente inactivo, reiniciando servicios...');
            this.restartServices();
        }
    }

    async restartServices() {
        try {
            this.healthCheck.metrics.lastRestart = Date.now();
            
            // Limpiar recursos existentes
            await this.cleanupBeforeExit();
            
            // Reiniciar servicios
            this.startKeepAlive();
            await this.whatsappClient.initialize();
            
            console.log('Servicios reiniciados exitosamente');
        } catch (error) {
            console.error('Error reiniciando servicios:', error);
            this.logError('service_restart', error);
            
            // Si falla el reinicio, forzar reinicio del proceso
            process.exit(1);
        }
    }

    setupHealthEndpoint(app) {
        app.get('/health', (req, res) => {
            const health = {
                status: this.healthCheck.isHealthy ? 'healthy' : 'unhealthy',
                lastPing: new Date(this.healthCheck.lastPing).toISOString(),
                lastMessage: new Date(this.healthCheck.lastMessage).toISOString(),
                metrics: {
                    ...this.healthCheck.metrics,
                    uptime: `${Math.floor(this.healthCheck.metrics.uptime / 1000 / 60)} minutes`,
                    reconnectAttempts: this.reconnectAttempts,
                    memory: process.memoryUsage()
                }
            };

            res.json(health);
        });

        // Endpoint para forzar GC
        app.post('/gc', (req, res) => {
            try {
                if (global.gc) {
                    global.gc();
                    res.json({ success: true, message: 'Garbage collection ejecutado' });
                } else {
                    res.status(400).json({ 
                        success: false, 
                        message: 'GC no disponible. Ejecute Node.js con --expose-gc' 
                    });
                }
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
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
            this.logError('initial_startup', error);
            await this.handleReconnection('INITIAL_FAILURE');
        }

        setInterval(() => this.updateHealth(), this.HEALTH_CHECK_INTERVAL);
        
        // Manejar señales de terminación
        process.on('SIGTERM', async () => {
            console.log('Recibida señal SIGTERM');
            await this.cleanupBeforeExit();
            process.exit(0);
        });

        process.on('SIGINT', async () => {
            console.log('Recibida señal SIGINT');
            await this.cleanupBeforeExit();
            process.exit(0);
        });
    }
}

module.exports = StabilityManager;