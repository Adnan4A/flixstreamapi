// server.js - Fully Updated with Hardcoded Config & One-Time Initial Refresh
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST'], credentials: true }));

// =============================================
// CONFIG
// =============================================
const FIRESTORE_WEBHOOK = 'https://flixstream.ca/api/webhook/stream-links';
const REFRESH_INTERVAL = 1; // hours
const PORT = 8080;
const ENV = 'production';

// Telegram
const TELEGRAM_BOT_TOKEN = '8368699861:AAFVzZdPT_1_TGA7VWL7VQQAdyOyQH-vQm8';
const TELEGRAM_CHAT_ID = '8254382347';

// FIRST RUN FLAG
let FIRST_RUN = true; // hardcoded for first-run refresh on deploy

// Series config
const seriesConfig = {
    302063: {
        name: 'tasacak-bu-denizr',
        title: 'Deep in Love',
        urlPattern: 'https://hds.turkish123.com/tasacak-bu-deniz-episode-{episode}/',
        mediaType: 'tv',
        seasons: { 1: { startEpisode: 1, count: 6 } }
    }
};

// =============================================
// LOGGING
// =============================================
const log = {
    info: msg => console.log(`ℹ️  ${msg}`),
    success: msg => console.log(`✅ ${msg}`),
    error: msg => console.log(`❌ ${msg}`),
    warn: msg => console.log(`⚠️  ${msg}`),
    debug: msg => console.log(`🔍 ${msg}`)
};

// =============================================
// TELEGRAM
// =============================================
async function sendTelegramMessage(message) {
    return new Promise(resolve => {
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
                headers: { 'Content-Type': 'application/json' }
            };

            const req = https.request(options, res => {
                res.on('end', () => resolve(true));
            });

            req.on('error', () => resolve(false));
            req.write(postData);
            req.end();
        } catch (err) {
            resolve(false);
        }
    });
}

// =============================================
// CLEANUP
// =============================================
async function forceCleanupBrowsers() {
    try {
        exec('pkill -9 chrome || pkill -9 chromium || true');
        await new Promise(r => setTimeout(r, 2000));
        log.success('Browser cleanup done.');
    } catch {}
}

// =============================================
// FETCH M3U8
// =============================================
async function fetchM3u8(movieId, season, episode, retries = 2) {
    const series = seriesConfig[movieId];
    if (!series) return null;

    const seasonData = series.seasons[season];
    if (!seasonData) return null;

    const actualEpisode = seasonData.startEpisode + episode - 1;
    const url = series.urlPattern.replace('{episode}', actualEpisode);

    let browser;

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
            timeout: 15000
        });

        const page = await browser.newPage();
        await page.setRequestInterception(true);

        const found = [];

        page.on('request', req => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font'].includes(type)) return req.abort();
            if (req.url().includes('.m3u8')) found.push(req.url());
            req.continue();
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));

        if (found.length) return found[0];
        if (retries > 0) return await fetchM3u8(movieId, season, episode, retries - 1);
        return null;
    } catch {
        if (retries > 0) return await fetchM3u8(movieId, season, episode, retries - 1);
        return null;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// =============================================
// SEND TO FIRESTORE
// =============================================
async function sendToFirestore(payload) {
    return new Promise(resolve => {
        try {
            const url = new URL(FIRESTORE_WEBHOOK);
            const client = url.protocol === 'https:' ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            };

            const req = client.request(options, res => {
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            });

            req.write(JSON.stringify(payload));
            req.end();
        } catch {
            resolve(false);
        }
    });
}

// =============================================
// AUTO REFRESH
// =============================================
let isRefreshing = false;

async function autoRefreshM3u8s(isManual = false) {
    if (isRefreshing) return;

    isRefreshing = true;
    log.info(`Starting ${isManual ? 'manual' : 'auto'} refresh…`);

    let success = 0;
    let failed = 0;

    try {
        for (const movieId in seriesConfig) {
            const series = seriesConfig[movieId];

            for (const season in series.seasons) {
                const count = series.seasons[season].count;

                for (let ep = 1; ep <= count; ep++) {
                    const m3u8 = await fetchM3u8(Number(movieId), Number(season), ep);
                    if (!m3u8) { failed++; continue; }

                    const payload = {
                        movieId: Number(movieId),
                        mediaType: series.mediaType,
                        title: `${series.title} S${season}E${ep}`,
                        season: Number(season),
                        episode: ep,
                        m3u8Url: m3u8,
                        timestamp: new Date().toISOString()
                    };

                    const ok = await sendToFirestore(payload);
                    ok ? success++ : failed++;
                }
            }
        }

        // Send Telegram summary
        await sendTelegramMessage(
            `<b>Refresh Completed</b>\nSuccess: ${success}\nFailed: ${failed}`
        );

        await forceCleanupBrowsers();

        // Restart container
        setTimeout(() => process.exit(1), 1500);

    } catch (err) {
        await sendTelegramMessage(`<b>Error:</b>\n${err.message}`);
        setTimeout(() => process.exit(1), 1500);
    } finally {
        isRefreshing = false;
    }
}

// =============================================
// ROUTES
// =============================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), isRefreshing });
});

app.post('/api/refresh', async (req, res) => {
    if (isRefreshing)
        return res.status(429).json({ success: false, error: 'Already refreshing' });

    res.json({ success: true, message: 'Manual refresh started' });

    autoRefreshM3u8s(true);
});

// =============================================
// STARTUP
// =============================================
app.listen(PORT, () => {
    log.info(`Server running on port ${PORT}`);

    // FIRST RUN REFRESH
    if (FIRST_RUN) {
        setTimeout(() => {
            log.info('Running FIRST RUN refresh…');
            autoRefreshM3u8s(false);
            FIRST_RUN = false;
        }, 5000);
    }

    // Scheduled refresh
    setInterval(() => {
        if (!isRefreshing) autoRefreshM3u8s(false);
    }, REFRESH_INTERVAL * 60 * 60 * 1000);
});

// =============================================
// ERROR HANDLERS
// =============================================
process.on('uncaughtException', err => {
    log.error(err);
    process.exit(1);
});
process.on('unhandledRejection', err => {
    log.error(err);
    process.exit(1);
});
