const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { connect } = require('puppeteer-real-browser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

let pageglobal = null;
let lastTokenTime = 0;
const TOKEN_TIMEOUT = 120000; // 2 minutos

async function initializeBrowser() {
    console.log('Iniciando navegador...');
    
    try {
        const { browser, page } = await connect({
            headless: false, // Cambia a true para producción
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            customConfig: {},
            turnstile: true,
            connectOptions: {},
            disableXvfb: false,
        });
        
        pageglobal = page;
        
        // Configurar user-agent real
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Configurar viewport
        await page.setViewport({ width: 1366, height: 768 });
        
        console.log('Navegando a la página...');
        await page.goto('https://eldni.consultadatosreniec.online/', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Esperar a que cargue el captcha
        await page.waitForSelector('[name="cf-turnstile-response"]', { 
            timeout: 15000 
        }).catch(() => {
            console.log('Captcha no encontrado, continuando...');
        });
        
        console.log('Página cargada exitosamente');
        lastTokenTime = Date.now();
        
        return true;
    } catch (error) {
        console.error('Error al inicializar el navegador:', error);
        return false;
    }
}

async function refreshPageIfNeeded() {
    const now = Date.now();
    
    // Si ha pasado más de 2 minutos desde el último token o la página no está disponible
    if (!pageglobal || (now - lastTokenTime) > TOKEN_TIMEOUT) {
        console.log('Recargando página para obtener nuevo captcha...');
        
        if (pageglobal) {
            try {
                await pageglobal.reload({
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });
                
                // Esperar a que cargue el captcha
                await pageglobal.waitForSelector('[name="cf-turnstile-response"]', { 
                    timeout: 10000 
                }).catch(() => {
                    console.log('Captcha no encontrado después de recargar');
                });
                
                lastTokenTime = Date.now();
                return true;
            } catch (error) {
                console.error('Error al recargar página:', error);
                return false;
            }
        } else {
            return await initializeBrowser();
        }
    }
    
    return true;
}

async function getData(dni) {
    // Verificar y recargar si es necesario
    const isReady = await refreshPageIfNeeded();
    if (!isReady) {
        throw new Error('No se pudo inicializar el navegador');
    }
    
    const result = await pageglobal.evaluate(async (dni) => {
        console.log('Buscando captcha...');
        
        // Función para obtener el token del captcha
        function getCaptchaToken() {
            const captchaElement = document.querySelector('[name="cf-turnstile-response"]');
            if (captchaElement && captchaElement.value) {
                return captchaElement.value;
            }
            
            // Buscar en iframes
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const iframeCaptcha = iframeDoc.querySelector('[name="cf-turnstile-response"]');
                    if (iframeCaptcha && iframeCaptcha.value) {
                        return iframeCaptcha.value;
                    }
                } catch (e) {
                    // Ignorar errores de cross-origin
                }
            }
            
            return null;
        }
        
        // Obtener el token actual
        let token = getCaptchaToken();
        
        if (!token || token === '') {
            console.log('Token no encontrado, intentando resetear captcha...');
            
            // Intentar resetear el captcha si existe turnstile
            if (typeof turnstile !== 'undefined') {
                turnstile.reset();
            }
            
            // Esperar por el token
            token = await new Promise((resolve, reject) => {
                let attempts = 0;
                const maxAttempts = 30; // 30 segundos máximo
                
                function checkForToken() {
                    attempts++;
                    const newToken = getCaptchaToken();
                    
                    if (newToken && newToken !== '') {
                        console.log('Token encontrado después de', attempts, 'segundos');
                        resolve(newToken);
                    } else if (attempts >= maxAttempts) {
                        reject(new Error('No se pudo obtener el token del captcha'));
                    } else {
                        setTimeout(checkForToken, 1000);
                    }
                }
                
                checkForToken();
            });
        }
        
        console.log('Token obtenido:', token ? 'Sí' : 'No');
        
        if (!token) {
            return { success: false, message: 'No se pudo obtener token del captcha' };
        }
        
        // Hacer la petición
        try {
            const response = await fetch("https://eldni.consultadatosreniec.online/consultdni/" + dni + "?cf-turnstile-response=" + token, {
                "headers": {
                    "accept": "application/json, text/javascript;q=0.01",
                    "accept-language": "es-ES,es;q=0.9,en;q=0.8",
                    "content-type": "application/json; charset=UTF-8",
                    "sec-ch-ua": "\"Not_A_Brand\";v=\"1\", \"Chromium\";v=\"120\", \"Google Chrome\";v=\"120\"",
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": "\"Windows\"",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                    "x-requested-with": "XMLHttpRequest"
                }
            });
            
            const data = await response.json();
            console.log('Respuesta del servidor:', data);
            
            // Resetear el captcha después de usarlo
            if (typeof turnstile !== 'undefined') {
                setTimeout(() => turnstile.reset(), 1000);
            }
            
            return data;
            
        } catch (error) {
            console.error('Error en fetch:', error);
            return { success: false, message: 'Error en la consulta: ' + error.message };
        }
    }, dni);
    
    // Actualizar el tiempo del último token exitoso
    if (result && result.success) {
        lastTokenTime = Date.now();
    }
    
    return result;
}

// Ruta para consultar DNI
app.get('/get', async (req, res) => {
    const dni = req.query.dni;
    
    console.log(`\n=== Recibida solicitud para DNI: ${dni} ===`);
    
    if (!dni || !/^\d{8}$/.test(dni)) {
        return res.status(400).json({ 
            success: false, 
            message: 'DNI inválido. Debe tener 8 dígitos.' 
        });
    }
    
    try {
        console.log('Obteniendo datos...');
        const data = await getData(dni);
        console.log('Datos obtenidos:', data.success ? 'Éxito' : 'Fallo');
        res.json(data);
    } catch (error) {
        console.error('Error en /get:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error al obtener los datos',
            error: error.message 
        });
    }
});

// Ruta para recargar manualmente la página
app.get('/reload', async (req, res) => {
    try {
        const success = await refreshPageIfNeeded();
        res.json({ 
            success, 
            message: success ? 'Página recargada exitosamente' : 'Error al recargar página' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: 'Error: ' + error.message 
        });
    }
});

// Ruta para verificar estado
app.get('/status', (req, res) => {
    const now = Date.now();
    const minutesSinceLastToken = Math.floor((now - lastTokenTime) / 60000);
    
    res.json({
        success: true,
        browser_initialized: pageglobal !== null,
        last_token_time: new Date(lastTokenTime).toLocaleString(),
        minutes_since_last_token: minutesSinceLastToken,
        token_expired: minutesSinceLastToken > 2
    });
});

// Ruta de prueba
app.get('/test', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Servidor funcionando correctamente',
        timestamp: new Date().toISOString()
    });
});

// Iniciar servidor
app.listen(PORT, async () => {
    console.log(`\n=== Servidor iniciado ===`);
    console.log(`Puerto: ${PORT}`);
    console.log(`Test: http://localhost:${PORT}/test`);
    console.log(`Status: http://localhost:${PORT}/status`);
    console.log(`Recargar: http://localhost:${PORT}/reload`);
    console.log(`API: http://localhost:${PORT}/get?dni=12345678\n`);
    
    // Inicializar el navegador
    const initialized = await initializeBrowser();
    if (!initialized) {
        console.error('No se pudo inicializar el navegador. El servidor puede no funcionar correctamente.');
    }
});