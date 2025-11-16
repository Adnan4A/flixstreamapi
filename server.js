// server.js - SIMPLIFIED TEST: 1 Series | Flag to Prevent Double Run | Railway Safe
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST'], credentials: true }));

// ============================================
// CONFIG (HARDCODED, 1 SERIES FOR TEST)
// ============================================
const FIRESTORE_WEBHOOK = 'https://flixstream.ca/api/webhook/stream-links';
const REFRESH_INTERVAL = 1; // hours
const PORT = process.env.PORT || 3000;
const ENV = 'production';
const FLAG_FILE = '/tmp/last-refresh.txt';

const TELEGRAM_BOT_TOKEN = '8368699861:AAFVzZdPT_1_TGA7VWL7VQQAdyOyQH-vQm8';
const TELEGRAM_CHAT_ID = '8254382347';

// TEST: ONLY 1 SERIES (Mehmed - 57 eps total)
const seriesConfig = {
    246621: {
        name: 'Mehmed: Sultan of Conquests',
        title: 'Mehmed: Sultan of Conquests',
        urlPattern: 'https://hds.turkish123.com/mehmed-fetihler-sultani-episode-{episode}/',
        mediaType: 'tv',
        seasons: {
            1: { startEpisode: 1, count: 15 }
            
        }
    }
};

// ============================================
// SIMPLE LOGGING (MINIMAL)
// ============================================
const log = {
    info: (msg) => console.log(`[INFO ${new Date().toISOString()}] ${msg}`),
    success: (msg) => console.log(`[SUCCESS ${new Date().toISOString()}] ${msg}`),
    error: (msg) => console.error(`[ERROR ${new Date().toISOString()}] ${msg}`),
    warn: (msg) => console.warn(`[WARN ${new Date().toISOString()}] ${msg}`)
};

// ============================================
// HELPERS: FLAG, TELEGRAM, CLEANUP
// ============================================
async function readFlag() {
    try {
        const data = await fs.readFile(FLAG_FILE, 'utf8');
        return new Date(data.trim());
    } catch {
        return null; // No flag = cold start
    }
}

async function writeFlag() {
    await fs.writeFile(FLAG_FILE, new Date().toISOString());
}

async function sendTelegramMessage(message) {
    return new Promise((resolve) => {
        try {
            const postData = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                timeout: 5000 // Faster for test
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(res.statusCode === 200));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(postData);
            req.end();
        } catch {
            resolve(false);
        }
    });
}

async function forceCleanupBrowsers() {
    try {
        if (global.gc) global.gc();
        await new Promise((resolve) => exec('pkill -9 chrome || pkill -9 chromium || true', () => resolve()));
        await new Promise(r => setTimeout(r, 1000));
        log.info('Cleanup done');
    } catch {
        // Silent fail
    }
}

// ============================================
// FETCH M3U8 (SIMPLIFIED, NO DEBUG LOGS)
// ============================================
const activeBrowsers = new Set();

async function fetchM3u8(movieId, season, episode, retries = 1) {
    const series = seriesConfig[movieId];
    if (!series || !series.seasons[season]) return null;

    const actualEpisodeNumber = series.seasons[season].startEpisode + episode - 1;
    const url = series.urlPattern.replace('{episode}', actualEpisodeNumber);

    if (activeBrowsers.size >= 1) await new Promise(r => setTimeout(r, 500));

    const browserId = Date.now();
    activeBrowsers.add(browserId);
    let browser, page;

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-gpu', '--no-zygote', '--memory-pressure-off',
                '--disable-background-timer-throttling'
            ],
            timeout: 15000
        });
        page = await browser.newPage();
        page.setDefaultNavigationTimeout(10000);
        await page.setRequestInterception(true);

        const videoUrls = [];
        let linkFound = false;

        page.on('request', (req) => {
            const u = req.url();
            const t = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media', 'websocket'].includes(t)) return req.abort();
            if (t === 'xhr' && u.includes('.m3u8')) {
                videoUrls.push(u);
                linkFound = true;
            }
            req.continue();
        });

        page.on('response', (res) => {
            const u = res.url();
            if (u.includes('.m3u8') && !videoUrls.includes(u)) {
                videoUrls.push(u);
                linkFound = true;
            }
        });

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
        await page.evaluate(() => {
            const video = document.querySelector('video');
            if (video && video.src.includes('.m3u8')) videoUrls.push(video.src); // Global leak, but simple
        });

        await new Promise(r => setTimeout(r, 1000)); // Wait for loads

        page.off('request');
        return videoUrls[0] || (retries > 0 ? fetchM3u8(movieId, season, episode, retries - 1) : null);
    } catch {
        return retries > 0 ? fetchM3u8(movieId, season, episode, retries - 1) : null;
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) {
            await browser.close().catch(() => {});
            browser.process()?.kill('SIGKILL');
        }
        activeBrowsers.delete(browserId);
        if (global.gc) global.gc();
    }
}

// ============================================
// SEND TO FIRESTORE (UNCHANGED)
// ============================================
async function sendToFirestore(payload) {
    return new Promise((resolve) => {
        try {
            const url = new URL(FIRESTORE_WEBHOOK);
            const options = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(JSON.stringify(payload));
            req.end();
        } catch {
            resolve(false);
        }
    });
}

// ============================================
// AUTO-REFRESH (SIMPLIFIED LOGS)
// ============================================
let isRefreshing = false;
let nextRefreshTime = null;

async function autoRefreshM3u8s(isManual = false) {
    if (isRefreshing) return false;
    isRefreshing = true;
    log.info(`${isManual ? 'Manual' : 'Auto'} refresh started`);

    const startTime = Date.now();
    const stats = { success: 0, failed: 0 };

    try {
        for (const movieId in seriesConfig) {
            const series = seriesConfig[movieId];
            log.info(`Refreshing: ${series.title}`);

            for (const season in series.seasons) {
                const count = series.seasons[season].count;
                for (let ep = 1; ep <= count; ep++) {
                    const m3u8Url = await fetchM3u8(parseInt(movieId), parseInt(season), ep);
                    if (m3u8Url) {
                        const payload = {
                            movieId: parseInt(movieId),
                            mediaType: series.mediaType,
                            m3u8Url,
                            title: `${series.title} S${season}E${ep}`,
                            season: parseInt(season),
                            episode: ep,
                            quality: 'auto',
                            notes: isManual ? 'Manual' : 'Auto',
                            timestamp: new Date().toISOString()
                        };
                        if (await sendToFirestore(payload)) stats.success++; else stats.failed++;
                    } else stats.failed++;
                    await new Promise(r => setTimeout(r, 100)); // Faster for test
                }
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log.success(`Refresh complete: ${stats.success} success, ${stats.failed} failed (${duration}s)`);

        // Telegram
        const msg = `<b>Refresh Done</b>\nSuccess: ${stats.success}\nFailed: ${stats.failed}\nTime: ${duration}s\nRestarting...`;
        await sendTelegramMessage(msg);

        // Write flag
        await writeFlag();

        // Cleanup & exit
        await forceCleanupBrowsers();
        log.info('Exiting to restart');
        process.exit(0); // Exit 0 = success, Railway won't "crash" it

    } catch (error) {
        log.error(`Refresh error: ${error.message}`);
        await sendTelegramMessage(`<b>Refresh Failed</b>\n${error.message}`);
        await forceCleanupBrowsers();
        process.exit(1);
    } finally {
        isRefreshing = false;
    }
}

// ============================================
// ROUTES (SIMPLIFIED STATUS)
// ============================================
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/api/status', async (req, res) => {
    const lastRun = await readFlag();
    const now = Date.now();
    const msInterval = REFRESH_INTERVAL * 60 * 60 * 1000;
    const timeSinceLast = lastRun ? (now - lastRun.getTime()) / 1000 / 60 : null; // Minutes
    let nextIn = 'Calculating...';
    if (lastRun) {
        const msToNext = msInterval - (now - lastRun.getTime());
        if (msToNext > 0) {
            const mins = Math.floor(msToNext / 1000 / 60);
            nextIn = `${mins} minutes`;
        } else nextIn = 'Now';
    }
    res.json({
        isRefreshing,
        lastRunMinutesAgo: timeSinceLast?.toFixed(0) || 'Never',
        nextRefresh: nextIn,
        message: timeSinceLast && timeSinceLast < 5 ? 'Just ran - waiting 1hr' : 'Ready for initial run'
    });
});

app.post('/api/refresh', async (req, res) => {
    if (isRefreshing) return res.status(429).json({ error: 'Busy' });
    res.json({ message: 'Manual started' });
    autoRefreshM3u8s(true);
});

// ============================================
// STARTUP: FLAG CHECK → RUN OR WAIT
// ============================================
const server = app.listen(PORT, async () => {
    log.info(`Server started on port ${PORT}, interval ${REFRESH_INTERVAL}h`);

    // Check flag
    const lastRun = await readFlag();
    const now = new Date();
    const msInterval = REFRESH_INTERVAL * 60 * 60 * 1000;
    nextRefreshTime = lastRun ? new Date(lastRun.getTime() + msInterval) : new Date(now.getTime() + msInterval);

    if (!lastRun || (now.getTime() - lastRun.getTime()) > msInterval) {
        log.info('Cold start - running initial refresh');
        await autoRefreshM3u8s(false);
    } else {
        log.info(`Recent run (${(now.getTime() - lastRun.getTime()) / 1000 / 60 | 0} min ago) - waiting until ${nextRefreshTime.toLocaleString()}`);
    }

    // Always schedule recurring
    setInterval(() => {
        if (!isRefreshing) {
            log.info('Interval trigger - running refresh');
            autoRefreshM3u8s(false);
        }
    }, msInterval);
});

// Graceful exit
process.on('SIGTERM', async () => {
    await forceCleanupBrowsers();
    server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
    log.error(`Uncaught: ${err.message}`);
    process.exit(1);
});

module.exports = app;
