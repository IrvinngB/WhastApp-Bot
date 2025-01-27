const axios = require('axios');
const URL = require('url').URL;
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron'); // Para reinicios programados

class StabilityManager {
    constructor(whatsappClient) {
        this.whatsappClient = whatsappClient;
        this.keepAliveInterval = null;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.initialized = false;
        this.pingFailures = 0;
        this.isDeployment = false;
        this.deploymentTimeout = null;

        // Constantes optimizadas
        this.MAX_RECONNECT_ATTEMPTS = 15; // Aumentado para más intentos de reconexión
        this.RECONNECT_DELAY = 10000; // 10 segundos entre intentos
        this.PING_INTERVAL = 10 * 60 * 1000; // 10 minutos entre pings
        this.HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutos entre verificaciones de salud
        this.MAX_SILENCE = 60 * 60 * 1000; // 1 hora de inactividad antes de reiniciar
        this.MAX_PING_FAILURES = 5; // Aumentado para más tolerancia a fallos
        this.DEPLOYMENT_TIMEOUT = 15 * 60 * 1000; // 15 minutos para despliegues
        this.PING_TIMEOUT = 15000; // 15 segundos de timeout para pings

        this.PING_URL = process.env.APP_URL || 'https://whastapp-bot-muv1.onrender.com';

        this.healthCheck = {
            lastPing: Date.now(),
            lastMessage: Date.now(),
            isHealthy: true,
            connectionState: 'disconnected',
            deploymentState: 'stable',
            metrics: {
                totalReconnects: 0,
                lastRestart: null,
                uptime: Date.now(),
                errors: [],
                lastSuccessfulConnection: null,
                deploymentAttempts: 0,
                lastDeploymentTime: null
            }
        };

        this.setupMemoryMonitoring();
        this.setupEventHandlers();
        this.scheduleDailyRestart(); // Programar reinicio diario
    }

    // Función para manejar el estado de despliegue
    handleDeploymentState(status) {
        if (status === 502) {
            if (!this.isDeployment) {
                console.log('Detectado posible despliegue en curso');
                this.isDeployment = true;
                this.healthCheck.deploymentState = 'in_progress';
                this.healthCheck.metrics.lastDeploymentTime = Date.now();
                this.healthCheck.metrics.deploymentAttempts++;

                // Limpiar timeout anterior si existe
                if (this.deploymentTimeout) {
                    clearTimeout(this.deploymentTimeout);
                }

                // Establecer nuevo timeout para el despliegue
                this.deploymentTimeout = setTimeout(() => {
                    if (this.isDeployment) {
                        console.log('Timeout de despliegue alcanzado, reiniciando servicios');
                        this.isDeployment = false;
                        this.healthCheck.deploymentState = 'failed';
                        this.restartServices();
                    }
                }, this.DEPLOYMENT_TIMEOUT);
            }
            return true;
        }

        if (this.isDeployment && status === 200) {
            console.log('Despliegue completado exitosamente');
            this.isDeployment = false;
            this.healthCheck.deploymentState = 'stable';
            if (this.deploymentTimeout) {
                clearTimeout(this.deploymentTimeout);
                this.deploymentTimeout = null;
            }
            return true;
        }

        return false;
    }

    // Programar el reinicio diario a una hora específica
  
    scheduleDailyRestart() {
        // Ejemplo: Reiniciar todos los días a las 3:00 AM
        cron.schedule('0 3 * * *', async () => {
            console.log('Reinicio programado: Cerrando sesión...');
            try {
                await this.restartServices();
                console.log('Reinicio programado: Sesión reiniciada exitosamente.');
            } catch (error) {
                console.error('Error durante el reinicio programado:', error);
                // Intentar reconectar después de un breve retraso
                setTimeout(() => this.restartServices(), 10000);
            }
        });
    }

    setupMemoryMonitoring() {
        setInterval(() => {
            const used = process.memoryUsage();
            const metrics = {
                rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
                heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
                heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`
            };

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
        }, 5 * 60 * 1000); // Cada 5 minutos
    }

    setupEventHandlers() {
        this.whatsappClient.on('disconnected', async (reason) => {
            console.log('Cliente desconectado:', reason);
            this.healthCheck.connectionState = 'disconnected';
            this.logError('disconnect', reason);

            const isIntentionalDisconnect = reason === 'NAVIGATION' || reason === 'LOGOUT';

            if (isIntentionalDisconnect) {
                await this.clearSession();
            }

            if (!this.isReconnecting && !isIntentionalDisconnect) {
                this.isReconnecting = true;
                await this.handleReconnection(reason);
                this.isReconnecting = false;
            }
        });

        this.whatsappClient.on('auth_failure', async (error) => {
            console.log('Error de autenticación:', error);
            this.healthCheck.connectionState = 'auth_failed';
            this.logError('auth_failure', error);
            await this.clearSession();
            await this.handleReconnection('AUTH_FAILURE');
        });

        this.whatsappClient.on('ready', () => {
            console.log('Cliente WhatsApp Web listo');
            this.healthCheck.connectionState = 'connected';
            this.healthCheck.metrics.lastSuccessfulConnection = Date.now();
            this.reconnectAttempts = 0;
            this.pingFailures = 0;
            this.initialized = true;
            this.healthCheck.isHealthy = true;
        });

        this.whatsappClient.on('loading_screen', (percent, message) => {
            console.log(`Cargando: ${percent}% - ${message}`);
            this.healthCheck.connectionState = 'loading';
        });

        this.whatsappClient.on('qr', () => {
            this.healthCheck.connectionState = 'waiting_for_qr';
        });
    }

    async keepAliveWithRetry() {
        try {
            const response = await axios.get(this.PING_URL, {
                timeout: this.PING_TIMEOUT,
                validateStatus: status => status >= 200 && status < 500,
                headers: {
                    'User-Agent': 'WhatsAppBot/1.0 HealthCheck'
                }
            });

            console.log('Respuesta del ping:', response.status);

            const isDeploymentRelated = this.handleDeploymentState(response.status);

            if (!isDeploymentRelated) {
                this.healthCheck.lastPing = Date.now();
                console.log(`Ping exitoso: ${response.status}`);
                this.pingFailures = 0;
                this.reconnectAttempts = 0;
            }
        } catch (error) {
            console.error('Error en ping:', {
                message: error.message,
                url: this.PING_URL,
                code: error.code,
                response: error.response?.status
            });

            if (error.response?.status === 502) {
                this.handleDeploymentState(502);
                return;
            }

            this.pingFailures++;

            if (this.pingFailures >= this.MAX_PING_FAILURES) {
                console.log(`Máximo de fallos de ping (${this.MAX_PING_FAILURES}) alcanzado, reiniciando servicios`);
                await this.restartServices();
                return;
            }

            const backoffDelay = Math.min(
                15000 * Math.pow(1.5, this.pingFailures),
                180000
            );

            console.log(`Reintentando ping en ${backoffDelay / 1000}s...`);
            setTimeout(() => this.keepAliveWithRetry(), backoffDelay);
        }
    }

    async handleReconnection(reason) {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.error('Máximo número de intentos de reconexión alcanzado');
            this.healthCheck.metrics.lastRestart = Date.now();
            this.healthCheck.isHealthy = false;

            await this.cleanupBeforeExit();
            process.exit(1);
            return;
        }

        this.reconnectAttempts++;
        this.healthCheck.metrics.totalReconnects++;

        const baseDelay = this.RECONNECT_DELAY * Math.pow(1.5, this.reconnectAttempts - 1);
        const jitter = Math.random() * 1000;
        const delay = Math.min(baseDelay + jitter, 300000);

        console.log(`Intento de reconexión ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} en ${delay / 1000}s...`);

        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            if (reason === 'AUTH_FAILURE' || this.reconnectAttempts > 3) {
                await this.clearSession();
            }

            if (this.initialized) {
                await this.whatsappClient.destroy();
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            await this.whatsappClient.initialize();
        } catch (error) {
            console.error('Error en la reconexión:', error);
            this.logError('reconnection', error);

            if (error.message.includes('ERR_FAILED') || error.message.includes('timeout')) {
                await this.clearSession();
            }

            await this.handleReconnection(reason);
        }
    }

    async clearSession() {
        const sessionPath = path.join(process.cwd(), '.wwebjs_auth/session-client');

        try {
            await fs.rm(sessionPath, { recursive: true, force: true });
            console.log('Sesión eliminada correctamente');
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            console.error('Error eliminando sesión:', error);
            this.logError('session_clear', error);
        }
    }

    logError(type, error) {
        const errorLog = {
            type,
            timestamp: new Date().toISOString(),
            message: error.toString(),
            stack: error.stack,
            deploymentState: this.healthCheck.deploymentState
        };

        this.healthCheck.metrics.errors.push(errorLog);

        if (this.healthCheck.metrics.errors.length > 50) {
            this.healthCheck.metrics.errors.shift();
        }
    }

    updateHealth() {
        const now = Date.now();

        const lastActivityDelta = Math.min(
            now - this.healthCheck.lastPing,
            now - this.healthCheck.lastMessage
        );

        this.healthCheck.isHealthy =
            lastActivityDelta < this.MAX_SILENCE &&
            this.healthCheck.connectionState === 'connected' &&
            this.healthCheck.deploymentState === 'stable';

        this.healthCheck.metrics.uptime = now - this.healthCheck.metrics.uptime;

        if (!this.healthCheck.isHealthy && !this.isReconnecting && !this.isDeployment) {
            console.warn('Sistema posiblemente inactivo, reiniciando servicios...');
            this.restartServices();
        }
    }

    async restartServices() {
        if (this.isReconnecting || this.isDeployment) {
            console.log('Ya hay una reconexión o despliegue en progreso, saltando reinicio de servicios');
            return;
        }

        try {
            this.isReconnecting = true;
            this.healthCheck.metrics.lastRestart = Date.now();

            await this.cleanupBeforeExit();

            await new Promise(resolve => setTimeout(resolve, 5000));

            this.startKeepAlive();
            await this.whatsappClient.initialize();

            this.isReconnecting = false;
            console.log('Servicios reiniciados exitosamente');
        } catch (error) {
            console.error('Error reiniciando servicios:', error);
            this.logError('service_restart', error);
            process.exit(1);
        }
    }

    async cleanupBeforeExit() {
        try {
            if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
            if (this.deploymentTimeout) clearTimeout(this.deploymentTimeout);

            await this.whatsappClient.destroy();
            await this.clearSession();

            console.log('Limpieza completada antes de salir');
        } catch (error) {
            console.error('Error en limpieza:', error);
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

    setupHealthEndpoint(app) {
        app.get('/health', (req, res) => {
            const health = {
                status: this.healthCheck.isHealthy ? 'healthy' : 'unhealthy',
                lastPing: new Date(this.healthCheck.lastPing).toISOString(),
                lastMessage: new Date(this.healthCheck.lastMessage).toISOString(),
                connectionState: this.healthCheck.connectionState,
                deploymentState: this.healthCheck.deploymentState,
                metrics: {
                    ...this.healthCheck.metrics,
                    uptime: `${Math.floor(this.healthCheck.metrics.uptime / 1000 / 60)} minutes`,
                    reconnectAttempts: this.reconnectAttempts,
                    pingFailures: this.pingFailures,
                    memory: process.memoryUsage()
                }
            };

            res.json(health);
        });

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

        // Manejo de señales de terminación
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

        // Manejo de errores no capturados
        process.on('unhandledRejection', (error) => {
            console.error('Promesa rechazada no manejada:', error);
            this.logError('unhandled_rejection', error);
            if (!this.isReconnecting && !this.isDeployment) {
                this.restartServices();
            }
        });

        process.on('uncaughtException', (error) => {
            console.error('Excepción no capturada:', error);
            this.logError('uncaught_exception', error);
            if (!this.isReconnecting && !this.isDeployment) {
                this.restartServices();
            }
        });
    }
}

module.exports = StabilityManager;