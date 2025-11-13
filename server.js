// server.js - Memory-Optimized M3U8 Server
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
const PORT = process.env.PORT || 3000;
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
    debug: (msg) => console.log(`🔍 [${new Date().toISOString()}] ${msg}`)
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
                    resolve(res.statusCode === 200);
                });
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.write(postData);
            req.end();
        } catch (error) {
            resolve(false);
        }
    });
}

// ============================================
// BROWSER MANAGEMENT - FRESH INSTANCE PER FETCH
// ============================================
// KEY CHANGE: Create new browser for each fetch, close immediately after
// This prevents memory accumulation from keeping browsers open

async function fetchM3u8(movieId, season, episode, retries = 2) {
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
    let page;
    
    try {
        // Launch fresh browser instance
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // Reduced processes
                '--disable-background-networking',
                '--disable-client-side-phishing-detection',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-default-search-infobar',
                '--disable-sync',
                '--disable-popup-blocking',
                '--disable-plugins',
                '--mute-audio'
            ],
            timeout: 20000
        });
        
        page = await browser.newPage();
        
        // Set memory-conscious timeouts
        page.setDefaultNavigationTimeout(15000);
        page.setDefaultTimeout(15000);
        
        // Set request interception BEFORE navigation
        await page.setRequestInterception(true);
        
        const videoUrls = [];
        let linkFound = false;
        
        // Ultra-lightweight request handler
        const handler = (request) => {
            const url = request.url();
            const type = request.resourceType();
            
            // Block everything unnecessary
            if (['image', 'stylesheet', 'font', 'media', 'websocket', 'manifest'].includes(type)) {
                request.abort().catch(() => {});
                return;
            }
            
            // Capture m3u8 URLs
            if (type === 'xhr' && url.includes('.m3u8')) {
                videoUrls.push(url);
                linkFound = true;
            }
            
            request.continue().catch(() => {});
        };
        
        page.on('request', handler);
        
        try {
            await page.goto(url, {
                waitUntil: 'networkidle0', // Changed from networkidle2
                timeout: 15000
            });
        } catch (navError) {
            log.debug(`Navigation timeout/error, checking for m3u8...`);
        }
        
        // Wait for m3u8 with timeout
        let waitCount = 0;
        while (!linkFound && waitCount < 20) {
            await new Promise(resolve => setTimeout(resolve, 50));
            waitCount++;
        }
        
        page.off('request', handler);
        
        if (videoUrls.length > 0) {
            log.debug(`Found m3u8 for S${season}E${episode}`);
            return videoUrls[0];
        } else {
            if (retries > 0) {
                log.warn(`No m3u8 found, retrying... (${retries} left)`);
                await new Promise(resolve => setTimeout(resolve, 500));
                return fetchM3u8(movieId, season, episode, retries - 1);
            }
            log.error(`Failed to fetch m3u8 after retries for S${season}E${episode}`);
            return null;
        }
        
    } catch (error) {
        log.error(`Error fetching m3u8: ${error.message}`);
        if (retries > 0) {
            return fetchM3u8(movieId, season, episode, retries - 1);
        }
        return null;
    } finally {
        // CRITICAL: Always close browser and page
        if (page) {
            await page.close().catch(() => {});
        }
        if (browser) {
            await browser.close().catch(() => {});
        }
        // Force garbage collection hint
        if (global.gc) global.gc();
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
                    'Content-Type': 'application/json'
                },
                timeout: 8000
            };
            
            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    resolve(res.statusCode >= 200 && res.statusCode < 300);
                });
            });
            
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            
            req.write(JSON.stringify(payload));
            req.end();
        } catch (error) {
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
        log.warn(`Refresh already in progress`);
        return;
    }
    
    isRefreshing = true;
    log.info(`🔄 Auto-refresh started`);
    
    const startTime = Date.now();
    const stats = { success: 0, failed: 0 };
    
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
                                title: `${series.title} S${season}E${ep}`,
                                season: parseInt(season),
                                episode: ep,
                                quality: 'auto',
                                notes: 'Auto-refreshed',
                                timestamp: new Date().toISOString()
                            };
                            
                            const sent = await sendToFirestore(payload);
                            if (sent) {
                                stats.success++;
                                log.success(`${series.title} S${season}E${ep}`);
                            } else {
                                stats.failed++;
                            }
                        } else {
                            stats.failed++;
                        }
                        
                        await new Promise(resolve => setTimeout(resolve, 200)); // More spacing
                    } catch (error) {
                        stats.failed++;
                        log.error(`S${season}E${ep}: ${error.message}`);
                    }
                }
            }
        }
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        log.success(`✅ Refresh done: ${stats.success} success, ${stats.failed} failed in ${duration}s`);
        
        const telegramMessage = `
<b>✅ M3U8 Refresh Completed</b>

✅ Success: ${stats.success}
❌ Failed: ${stats.failed}
⏱️  Duration: ${duration}s
🕒 ${new Date().toLocaleString()}
        `.trim();
        
        await sendTelegramMessage(telegramMessage);
        
    } catch (error) {
        log.error(`Auto-refresh failed: ${error.message}`);
        await sendTelegramMessage(`<b>❌ Refresh Failed</b>\n${error.message}`);
    } finally {
        isRefreshing = false;
    }
}

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        environment: ENV,
        timestamp: new Date().toISOString(),
        isRefreshing
    });
});

app.post('/api/fetch-and-save/:movieId/:season/:episode', async (req, res) => {
    try {
        const { movieId, season, episode } = req.params;
        const series = seriesConfig[movieId];
        
        if (!series) {
            return res.status(404).json({ success: false, error: 'Series not found' });
        }
        
        log.info(`Fetching: ${movieId} S${season}E${episode}`);
        const m3u8Url = await fetchM3u8(parseInt(movieId), parseInt(season), parseInt(episode));
        
        if (!m3u8Url) {
            return res.status(500).json({ success: false, error: 'Could not fetch m3u8' });
        }
        
        const payload = {
            movieId: parseInt(movieId),
            mediaType: series.mediaType,
            m3u8Url: m3u8Url,
            title: `${series.title} S${season}E${episode}`,
            season: parseInt(season),
            episode: parseInt(episode),
            quality: 'auto',
            timestamp: new Date().toISOString()
        };
        
        const saved = await sendToFirestore(payload);
        res.json({ success: saved, payload: saved ? payload : null });
        
    } catch (error) {
        log.error(`Error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/fetch-all/:movieId/:season', async (req, res) => {
    try {
        const { movieId, season } = req.params;
        const series = seriesConfig[movieId];
        
        if (!series || !series.seasons[season]) {
            return res.status(404).json({ success: false, error: 'Series/season not found' });
        }
        
        const episodes = series.seasons[season].count;
        log.info(`Fetching: ${series.title} S${season} (${episodes} eps)`);
        
        const results = [];
        
        for (let ep = 1; ep <= episodes; ep++) {
            const m3u8Url = await fetchM3u8(parseInt(movieId), parseInt(season), ep);
            
            if (m3u8Url) {
                const payload = {
                    movieId: parseInt(movieId),
                    mediaType: series.mediaType,
                    m3u8Url: m3u8Url,
                    title: `${series.title} S${season}E${ep}`,
                    season: parseInt(season),
                    episode: ep,
                    quality: 'auto',
                    timestamp: new Date().toISOString()
                };
                
                await sendToFirestore(payload);
                results.push({ episode: ep, success: true });
                log.success(`S${season}E${ep}`);
            } else {
                results.push({ episode: ep, success: false });
            }
            
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        res.json({ success: true, season, results });
        
    } catch (error) {
        log.error(`Error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/refresh', async (req, res) => {
    if (isRefreshing) {
        return res.status(429).json({ success: false, error: 'Already refreshing' });
    }
    
    autoRefreshM3u8s().catch(err => log.error(`Refresh error: ${err.message}`));
    res.json({ success: true, message: 'Refresh started' });
});

app.use((err, req, res) => {
    log.error(`Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Internal error' });
});

// ============================================
// STARTUP
// ============================================
const server = app.listen(PORT, () => {
    log.info(`═══════════════════════════════════════`);
    log.info(`🚀 M3U8 Server (Memory-Optimized)`);
    log.info(`Port: ${PORT}`);
    log.info(`Refresh Interval: ${REFRESH_INTERVAL}h`);
    log.info(`═══════════════════════════════════════`);
    
    setTimeout(() => {
        autoRefreshM3u8s().catch(err => log.error(`Initial refresh error: ${err.message}`));
    }, 5000);
    
    setInterval(() => {
        autoRefreshM3u8s().catch(err => log.error(`Scheduled refresh error: ${err.message}`));
    }, REFRESH_INTERVAL * 60 * 60 * 1000);
});

process.on('SIGTERM', async () => {
    log.info('Shutting down gracefully...');
    server.close(() => {
        log.info('Server closed');
        process.exit(0);
    });
    
    setTimeout(() => {
        log.error('Forced shutdown');
        process.exit(1);
    }, 30000);
});

module.exports = { app, fetchM3u8, sendToFirestore, sendTelegramMessage };
