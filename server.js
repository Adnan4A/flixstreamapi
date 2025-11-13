// server.js - Production Ready M3U8 Server with Telegram Notifications
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
}));

// ============================================
// CONFIGURATION
// ============================================
const FIRESTORE_WEBHOOK = 'https://flixstream.ca/api/webhook/stream-links';
const REFRESH_INTERVAL = 10; // hours
const PORT = process.env.PORT || 8080;
const ENV = 'production';

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = '8368699861:AAFVzZdPT_1_TGA7VWL7VQQAdyOyQH-vQm8';
const TELEGRAM_CHAT_ID = '8254382347';

// Series configuration
const seriesConfig = {
    274556: {
        name: 'Uzak Sehir',
        title: 'Far Away',
        urlPattern: 'https://hds.turkish123.com/uzak-sehir-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 28 },
            2: { startEpisode: 29, count: 8 }
        }
    },
    74823: {
        name: 'Cukur',
        title: 'The Pit',
        urlPattern: 'https://hds.turkish123.com/cukur-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 33 },
            2: { startEpisode: 34, count: 34 },
            3: { startEpisode: 68, count: 25 },
            4: { startEpisode: 93, count: 39 }
        }
    },
    283123: {
        name: 'Esref Ruya',
        title: 'Esref Ruya',
        urlPattern: 'https://hds.turkish123.com/esref-ruya-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 13 },
            2: { startEpisode: 14, count: 8 }
        }
    },
    
   302658: {
        name: 'Kurlus Orhan',
        title: 'Founder Orhan',
        urlPattern: 'https://hds.turkish123.com/kurulus-orhan-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 2 }
        }
    },
   301693: {
        name: 'sahtekarlar',
        title: 'Lovers & Liars',
        urlPattern: 'https://hds.turkish123.com/sahtekarlar-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 5 }
            
        }
    },
    300388: {
        name: 'guller-ve-gunahlar',
        title: 'Sins and Roses',
        urlPattern: 'https://hds.turkish123.com/guller-ve-gunahlar-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 5 }
        }
    },
    246621: {
        name: 'Mehmed: Sultan of Conquests',
        title: 'Mehmed: Sultan of Conquests',
        urlPattern: 'https://hds.turkish123.com/mehmed-fetihler-sultani-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 15 },
            2: { startEpisode: 16, count: 34 },
            3: { startEpisode: 50, count: 8 }
          }
    },
     302063: {
        name: 'tasacak-bu-denizr',
        title: 'Deep in Love',
        urlPattern: 'https://hds.turkish123.com/tasacak-bu-deniz-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 5 }
          
        }
    }

};

// ============================================
// LOGGING
// ============================================
const log = {
    info: (msg) => console.log(`ℹ️  [${new Date().toISOString()}] ${msg}`),
    success: (msg) => console.log(`✅ [${new Date().toISOString()}] ${msg}`),
    error: (msg) => console.error(`❌ [${new Date().toISOString()}] ${msg}`),
    warn: (msg) => console.warn(`⚠️  [${new Date().toISOString()}] ${msg}`),
    debug: (msg) => ENV === 'development' && console.log(`🔍 [${new Date().toISOString()}] ${msg}`)
};

// ============================================
// TELEGRAM NOTIFICATION SENDER
// ============================================
async function sendTelegramMessage(message) {
    return new Promise((resolve) => {
        try {
            const postData = JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });

            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 10000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        log.success(`Telegram notification sent`);
                        resolve(true);
                    } else {
                        log.warn(`Telegram returned ${res.statusCode}`);
                        resolve(false);
                    }
                });
            });

            req.on('error', (error) => {
                log.error(`Error sending Telegram message: ${error.message}`);
                resolve(false);
            });

            req.on('timeout', () => {
                log.error(`Telegram request timeout`);
                req.destroy();
                resolve(false);
            });

            req.write(postData);
            req.end();
        } catch (error) {
            log.error(`Error preparing Telegram request: ${error.message}`);
            resolve(false);
        }
    });
}

// ============================================
// PUPPETEER BROWSER POOL
// ============================================
let browserPool = [];
const MAX_BROWSERS = 1;

async function getBrowser() {
    if (browserPool.length > 0) {
        return browserPool.pop();
    }
    
    let launchRetries = 3;
    while (launchRetries > 0) {
        try {
            return await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-renderer-backgrounding',
                    '--disable-breakpad',
                    '--disable-component-update',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--disable-web-resources',
                    '--disable-features=TranslateUI',
                    '--no-first-run',
                    '--disable-blink-features=AutomationControlled',
                ],
                timeout: 120000,
                protocolTimeout: 300000
            });
        } catch (error) {
            launchRetries--;
            if (launchRetries > 0) {
                log.warn(`Browser launch failed, retrying... (${launchRetries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                throw error;
            }
        }
    }
}

async function returnBrowser(browser) {
    try {
        if (browserPool.length < MAX_BROWSERS) {
            browserPool.push(browser);
        } else {
            await browser.close().catch(e => log.debug(`Error closing browser: ${e.message}`));
        }
    } catch (error) {
        log.error(`Error returning browser: ${error.message}`);
    }
}

// ============================================
// PUPPETEER M3U8 FETCHER
// ============================================
async function fetchM3u8(movieId, season, episode, retries = 3) {
    const series = seriesConfig[movieId];
    if (!series) {
        log.error(`Series ${movieId} not found`);
        return null;
    }
    
    const seasonData = series.seasons[season];
    if (!seasonData) {
        log.error(`Season ${season} not found for series ${movieId}`);
        return null;
    }
    
    const actualEpisodeNumber = seasonData.startEpisode + episode - 1;
    const url = series.urlPattern.replace('{episode}', actualEpisodeNumber);
    
    let browser;
    try {
        browser = await getBrowser();
        
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);
        await page.setDefaultTimeout(60000);
        await page.setRequestInterception(true);
        
        const blockedResourceTypes = ['image', 'stylesheet', 'font', 'media', 'other'];
        const videoUrls = [];
        let linkFound = false;
        
        const handler = (request) => {
            const urlStr = request.url();
            const resourceType = request.resourceType();
            
            if (blockedResourceTypes.includes(resourceType)) {
                return request.abort();
            }
            
            if (resourceType === 'xhr' && request.method() === 'GET') {
                if (urlStr.includes('.m3u8') || urlStr.includes('stream')) {
                    videoUrls.push(urlStr);
                    linkFound = true;
                    request.continue();
                    return;
                }
            }
            
            request.continue();
        };
        
        page.on('request', handler);
        
        try {
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
        } catch (navError) {
            log.debug(`Navigation timeout, continuing to check for m3u8...`);
        }
        
        let waitTime = 0;
        while (!linkFound && waitTime < 5000) {
            await new Promise(resolve => setTimeout(resolve, 100));
            waitTime += 100;
        }
        
        page.off('request', handler);
        
        if (videoUrls.length > 0) {
            log.debug(`Found m3u8: ${videoUrls[0].substring(0, 80)}...`);
            await returnBrowser(browser);
            return videoUrls[0];
        } else {
            if (retries > 0) {
                log.warn(`No m3u8 found, retrying... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                return fetchM3u8(movieId, season, episode, retries - 1);
            }
            log.error(`Failed to fetch m3u8 after retries`);
            await returnBrowser(browser);
            return null;
        }
        
    } catch (error) {
        log.error(`Error fetching m3u8: ${error.message}`);
        try {
            if (browser) {
                await browser.close().catch(e => log.debug(`Error closing browser: ${e.message}`));
            }
        } catch (closeError) {
            log.debug(`Close error: ${closeError.message}`);
        }
        if (retries > 0) {
            return fetchM3u8(movieId, season, episode, retries - 1);
        }
        return null;
    }
}

// ============================================
// FIRESTORE WEBHOOK SENDER
// ============================================
async function sendToFirestore(payload) {
    return new Promise((resolve) => {
        try {
            const isHttps = FIRESTORE_WEBHOOK.startsWith('https');
            const client = isHttps ? https : http;
            const url = new URL(FIRESTORE_WEBHOOK);
            
            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'M3U8-Server/1.0'
                },
                timeout: 10000
            };
            
            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(true);
                    } else {
                        log.warn(`Firestore webhook returned ${res.statusCode}`);
                        resolve(false);
                    }
                });
            });
            
            req.on('error', (error) => {
                log.error(`Error sending to Firestore: ${error.message}`);
                resolve(false);
            });
            
            req.on('timeout', () => {
                log.error(`Firestore webhook timeout`);
                req.destroy();
                resolve(false);
            });
            
            req.write(JSON.stringify(payload));
            req.end();
        } catch (error) {
            log.error(`Error preparing Firestore request: ${error.message}`);
            resolve(false);
        }
    });
}

// ============================================
// AUTO-REFRESH SCHEDULER
// ============================================
let isRefreshing = false;

async function autoRefreshM3u8s() {
    if (isRefreshing) {
        log.warn(`Refresh already in progress, skipping...`);
        return;
    }
    
    isRefreshing = true;
    log.info(`🔄 Auto-refresh started`);
    
    const startTime = Date.now();
    const stats = { success: 0, failed: 0, skipped: 0 };
    
    try {
        for (const movieId in seriesConfig) {
            const series = seriesConfig[movieId];
            log.info(`📺 Refreshing: ${series.title}`);
            
            for (const season in series.seasons) {
                const episodeCount = series.seasons[season].count;
                
                for (let ep = 1; ep <= episodeCount; ep++) {
                    try {
                        const m3u8Url = await fetchM3u8(parseInt(movieId), parseInt(season), ep);
                        
                        if (m3u8Url) {
                            const payload = {
                                movieId: parseInt(movieId),
                                mediaType: series.mediaType,
                                m3u8Url: m3u8Url,
                                title: `${series.title} `,
                                season: parseInt(season),
                                episode: ep,
                                quality: 'auto',
                                notes: 'Auto-refreshed by scheduler',
                                timestamp: new Date().toISOString()
                            };
                            
                            const sent = await sendToFirestore(payload);
                            if (sent) {
                                stats.success++;
                                log.success(`${series.title} S${season}E${ep}`);
                            } else {
                                stats.skipped++;
                                log.warn(`Failed to send S${season}E${ep} to Firestore`);
                            }
                        } else {
                            stats.failed++;
                            log.error(`${series.title} S${season}E${ep} - m3u8 fetch failed`);
                        }
                        
                        await new Promise(resolve => setTimeout(resolve, 100));
                    } catch (error) {
                        stats.failed++;
                        log.error(`Error processing S${season}E${ep}: ${error.message}`);
                    }
                }
            }
        }
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        log.success(`Auto-refresh completed in ${duration}s | Success: ${stats.success}, Failed: ${stats.failed}, Skipped: ${stats.skipped}`);
        
        const telegramMessage = `
<b>✅ M3U8 Auto-Refresh Completed</b>

<b>Stats:</b>
✅ Success: ${stats.success}
❌ Failed: ${stats.failed}
⏭️  Skipped: ${stats.skipped}

⏱️  Duration: ${duration}s
🕒 Timestamp: ${new Date().toLocaleString()}
        `.trim();
        
        await sendTelegramMessage(telegramMessage);
        
    } catch (error) {
        log.error(`Auto-refresh failed: ${error.message}`);
        
        const errorMessage = `
<b>❌ M3U8 Auto-Refresh Failed</b>

<b>Error:</b>
${error.message}

🕒 Timestamp: ${new Date().toLocaleString()}
        `.trim();
        
        await sendTelegramMessage(errorMessage);
    } finally {
        isRefreshing = false;
    }
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
    res.status(200).send('OK');
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        environment: ENV,
        timestamp: new Date().toISOString(),
        isRefreshing
    });
});

// Fetch single episode
app.post('/api/fetch-and-save/:movieId/:season/:episode', async (req, res) => {
    try {
        const { movieId, season, episode } = req.params;
        const series = seriesConfig[movieId];
        
        if (!series) {
            return res.status(404).json({
                success: false,
                error: 'Series not found'
            });
        }
        
        log.info(`Fetching: movieId=${movieId}, S${season}E${episode}`);
        
        const m3u8Url = await fetchM3u8(parseInt(movieId), parseInt(season), parseInt(episode));
        
        if (!m3u8Url) {
            return res.status(500).json({
                success: false,
                error: 'Could not fetch m3u8 URL'
            });
        }
        
        const payload = {
            movieId: parseInt(movieId),
            mediaType: series.mediaType,
            m3u8Url: m3u8Url,
            title: `${series.title} `,
            season: parseInt(season),
            episode: parseInt(episode),
            quality: 'auto',
            notes: 'Manual fetch via API',
            timestamp: new Date().toISOString()
        };
        
        const saved = await sendToFirestore(payload);
        
        res.json({
            success: saved,
            payload: saved ? payload : null
        });
        
    } catch (error) {
        log.error(`Error in fetch-and-save: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Fetch entire season
app.post('/api/fetch-all/:movieId/:season', async (req, res) => {
    try {
        const { movieId, season } = req.params;
        const series = seriesConfig[movieId];
        
        if (!series || !series.seasons[season]) {
            return res.status(404).json({
                success: false,
                error: 'Series or season not found'
            });
        }
        
        const episodes = series.seasons[season].count;
        log.info(`Fetching season: ${series.title} S${season} (${episodes} episodes)`);
        
        const results = [];
        
        for (let ep = 1; ep <= episodes; ep++) {
            const m3u8Url = await fetchM3u8(parseInt(movieId), parseInt(season), ep);
            
            if (m3u8Url) {
                const payload = {
                    movieId: parseInt(movieId),
                    mediaType: series.mediaType,
                    m3u8Url: m3u8Url,
                    title: `${series.title} `,
                    season: parseInt(season),
                    episode: ep,
                    quality: 'auto',
                    notes: 'Batch fetch via API',
                    timestamp: new Date().toISOString()
                };
                
                await sendToFirestore(payload);
                results.push({ episode: ep, success: true });
                log.success(`S${season}E${ep}`);
            } else {
                results.push({ episode: ep, success: false });
                log.error(`S${season}E${ep} failed`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        res.json({
            success: true,
            season: season,
            results: results
        });
        
    } catch (error) {
        log.error(`Error in fetch-all: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Trigger manual refresh
app.post('/api/refresh', async (req, res) => {
    if (isRefreshing) {
        return res.status(429).json({
            success: false,
            error: 'Refresh already in progress'
        });
    }
    
    autoRefreshM3u8s().catch(error => log.error(`Refresh error: ${error.message}`));
    
    res.json({
        success: true,
        message: 'Refresh started'
    });
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
    log.error(`Unhandled error: ${err.message}`);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ============================================
// STARTUP
// ============================================
const server = app.listen(PORT, () => {
    log.info(`═══════════════════════════════════════`);
    log.info(`🚀 M3U8 Server Started`);
    log.info(`Environment: ${ENV}`);
    log.info(`Port: ${PORT}`);
    log.info(`Refresh Interval: ${REFRESH_INTERVAL} hours`);
    log.info(`Firestore Webhook: ${FIRESTORE_WEBHOOK}`);
    log.info(`Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Enabled' : '❌ Disabled'}`);
    log.info(`═══════════════════════════════════════`);
    
    setImmediate(() => {
        autoRefreshM3u8s().catch(error => log.error(`Initial refresh error: ${error.message}`));
    });
    
    setInterval(() => {
        autoRefreshM3u8s().catch(error => log.error(`Scheduled refresh error: ${error.message}`));
    }, REFRESH_INTERVAL * 60 * 60 * 1000);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    log.info('SIGTERM received, shutting down gracefully...');
    server.close(async () => {
        log.info('Server closed');
        process.exit(0);
    });
    
    setTimeout(() => {
        log.error('Forced shutdown');
        process.exit(1);
    }, 30000);
});

module.exports = { app, fetchM3u8, sendToFirestore, sendTelegramMessage };