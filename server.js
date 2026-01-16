// scrapper.js - CLEAN REWRITE FOR SINGLE SERIES TEST
// Tests container persistence on Railway free tier

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const cors = require('cors');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');

// ===================
// CONFIGURATION
// ===================
const app = express();
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST'], credentials: true }));

const CONFIG = {
  port: 3000,
  refreshIntervalHours: 10,
  webhook: 'https://flixstream.ca/api/webhook/stream-links',
  telegram: {
    botToken: '8591460817:AAFfvWMhzzdVSyQNQ-yTz_gh8JRpilaWYUY',
    chatId: '8254382347'
  },
  maxConcurrentPages: 3,
  batchSize: 3
};

// Episode check schedule (day: 0=Sun, 1=Mon, ..., 6=Sat)
const episodeCheckSchedule = {
  283123: { name: 'Esref Ruya', day: 2, hour: 3 }  // Tuesday at 3 AM
};

// Single series for testing
const seriesConfig = {
  283123: {
    name: 'Esref Ruya',
    title: 'Esref Ruya',
    urlPattern: 'https://hds.turkish123.com/esref-ruya-episode-{episode}/',
    mediaType: 'tv',
    seasons: {
      1: { startEpisode: 1, count: 13 },
      2: { startEpisode: 14, count: 12 }
    }
  }
};

// ===================
// STATE
// ===================
let state = {
  isRefreshing: false,
  lastRefreshTime: null,
  nextRefreshTime: null,
  refreshTimer: null,
  browser: null,
  activePages: new Set(),
  failedEpisodes: [],
  stats: { success: 0, failed: 0 }
};

// ===================
// LOGGING
// ===================
const log = {
  info: (msg) => console.log(`INFO  [${new Date().toISOString()}] ${msg}`),
  success: (msg) => console.log(`OK    [${new Date().toISOString()}] ${msg}`),
  error: (msg) => console.error(`ERROR [${new Date().toISOString()}] ${msg}`),
  warn: (msg) => console.warn(`WARN  [${new Date().toISOString()}] ${msg}`),
  debug: (msg) => console.log(`DEBUG [${new Date().toISOString()}] ${msg}`)
};

// ===================
// TELEGRAM TEMPLATES
// ===================
const telegram = {
  startup: () => {
    const series = Object.values(seriesConfig).map(s => s.title).join(', ');
    return `🚀 <b>Scrapper Started</b>\n\n` +
      `📡 Port: ${CONFIG.port}\n` +
      `⏰ Refresh: Every ${CONFIG.refreshIntervalHours}h\n` +
      `📺 Series: ${series}\n` +
      `🧠 GC: ${global.gc ? 'Enabled' : 'Disabled'}\n\n` +
      `<i>${new Date().toUTCString()}</i>`;
  },

  refreshStart: (isManual) => {
    const totalEps = Object.values(seriesConfig).reduce((sum, s) => 
      sum + Object.values(s.seasons).reduce((sSum, season) => sSum + season.count, 0), 0);
    return `🔄 <b>Refresh ${isManual ? '(Manual)' : '(Auto)'}</b>\n\n` +
      `📺 Series: ${Object.keys(seriesConfig).length}\n` +
      `🎬 Episodes: ${totalEps}\n\n` +
      `<i>Started at ${new Date().toUTCString()}</i>`;
  },

  refreshComplete: (stats, duration, isManual) => {
    const successRate = stats.success + stats.failed > 0 
      ? Math.round((stats.success / (stats.success + stats.failed)) * 100) 
      : 0;
    const emoji = successRate >= 90 ? '✅' : successRate >= 70 ? '⚠️' : '❌';
    return `${emoji} <b>Refresh Complete</b>\n\n` +
      `📊 <b>Results:</b>\n` +
      `   ✓ Success: ${stats.success}\n` +
      `   ✗ Failed: ${stats.failed}\n` +
      `   📈 Rate: ${successRate}%\n\n` +
      `⏱ Duration: ${duration}s\n` +
      `🔄 Type: ${isManual ? 'Manual' : 'Auto'}\n\n` +
      `<i>${new Date().toUTCString()}</i>`;
  },

  refreshError: (error) => {
    return `❌ <b>Refresh Failed</b>\n\n` +
      `🚨 Error: ${error}\n\n` +
      `<i>${new Date().toUTCString()}</i>`;
  },

  newEpisode: (series, episodeNum, seasonNum, episodeInSeason) => {
    return `🆕 <b>New Episode Found!</b>\n\n` +
      `📺 ${series.title}\n` +
      `🎬 Episode ${episodeNum}\n` +
      `📁 Season ${seasonNum}, Episode ${episodeInSeason}\n\n` +
      `<i>${new Date().toUTCString()}</i>`;
  },

  noNewEpisode: (seriesTitle) => {
    return `📭 <b>Episode Check</b>\n\n` +
      `📺 ${seriesTitle}\n` +
      `Status: No new episodes\n\n` +
      `<i>${new Date().toUTCString()}</i>`;
  },

  cleanup: (memBefore, memAfter) => {
    return `🧹 <b>Cleanup Complete</b>\n\n` +
      `💾 Memory: ${memBefore}MB → ${memAfter}MB\n` +
      `📉 Freed: ${memBefore - memAfter}MB\n\n` +
      `<i>${new Date().toUTCString()}</i>`;
  },

  crash: (error) => {
    return `💥 <b>CRASH</b>\n\n` +
      `🚨 ${error}\n\n` +
      `⚠️ Server will restart...\n\n` +
      `<i>${new Date().toUTCString()}</i>`;
  },

  highMemory: (heapMB, rssMB) => {
    return `⚠️ <b>High Memory Warning</b>\n\n` +
      `💾 Heap: ${heapMB}MB\n` +
      `💾 RSS: ${rssMB}MB\n\n` +
      `🧹 Running cleanup...\n\n` +
      `<i>${new Date().toUTCString()}</i>`;
  }
};

// ===================
// TELEGRAM NOTIFICATIONS
// ===================
async function sendTelegram(message) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        chat_id: CONFIG.telegram.chatId,
        text: message,
        parse_mode: 'HTML'
      });

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${CONFIG.telegram.botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(res.statusCode === 200));
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

// ===================
// BROWSER MANAGEMENT
// ===================
async function getBrowser() {
  if (!state.browser || !state.browser.isConnected()) {
    log.info('Launching new browser instance...');
    
    state.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--mute-audio',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
        '--js-flags="--max-old-space-size=256"'
      ],
      timeout: 60000,
      protocolTimeout: 30000
    });

    state.browser.on('disconnected', () => {
      log.warn('Browser disconnected');
      state.browser = null;
    });

    state.browser.on('error', (err) => {
      log.error(`Browser error: ${err.message}`);
    });

    log.success('Browser launched');
  }
  return state.browser;
}

async function cleanupBrowser() {
  log.info('Cleaning up browser...');
  
  if (state.browser && state.browser.isConnected()) {
    try {
      const pages = await state.browser.pages();
      await Promise.all(pages.map(p => p.close().catch(() => {})));
    } catch (e) {
      log.error(`Page cleanup error: ${e.message}`);
    }
  }

  if (state.browser) {
    try {
      await state.browser.close();
    } catch (e) {
      log.error(`Browser close error: ${e.message}`);
    }
    state.browser = null;
  }

  state.activePages.clear();

  // Kill any orphaned chrome processes
  await new Promise((resolve) => {
    exec('pkill -9 chrome || pkill -9 chromium || true', () => resolve());
  });

  log.success('Cleanup complete');
}

// ===================
// WEBHOOK
// ===================
async function sendToWebhook(payload) {
  return new Promise((resolve) => {
    try {
      const isHttps = CONFIG.webhook.startsWith('https');
      const client = isHttps ? https : http;
      const url = new URL(CONFIG.webhook);

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(JSON.stringify(payload));
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

// ===================
// M3U8 EXTRACTION
// ===================
async function fetchM3u8(seriesId, seasonNum, episodeNum) {
  const series = seriesConfig[seriesId];
  if (!series) {
    log.error(`Series ${seriesId} not found`);
    return null;
  }

  const seasonData = series.seasons[seasonNum];
  if (!seasonData) {
    log.error(`Season ${seasonNum} not found for ${series.title}`);
    return null;
  }

  const actualEpisode = seasonData.startEpisode + episodeNum - 1;
  const url = series.urlPattern.replace('{episode}', actualEpisode);
  const taskId = `${series.title} S${seasonNum}E${episodeNum}`;

  // Wait if too many pages open
  const waitStart = Date.now();
  while (state.activePages.size >= CONFIG.maxConcurrentPages) {
    if (Date.now() - waitStart > 30000) {
      log.warn(`${taskId} - Timeout waiting for available slot`);
      return null;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  let page = null;
  const pageId = `page-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    state.activePages.add(pageId);
    const browser = await getBrowser();
    page = await browser.newPage();

    // Block unnecessary resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const blocked = ['image', 'stylesheet', 'font', 'media', 'websocket', 'manifest'];
      if (blocked.includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Capture m3u8 URL
    let m3u8Url = null;
    page.on('response', async (response) => {
      const responseUrl = response.url();
      if (responseUrl.includes('.m3u8') && !responseUrl.includes('bumper')) {
        m3u8Url = responseUrl;
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    log.info(`${taskId} - Fetching: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Click play button if exists
    try {
      await page.waitForSelector('.jw-icon-display, .vjs-big-play-button, [class*="play"]', { timeout: 5000 });
      await page.click('.jw-icon-display, .vjs-big-play-button, [class*="play"]').catch(() => {});
    } catch (e) {
      // No play button, continue
    }

    // Wait for m3u8 to load
    await new Promise(r => setTimeout(r, 5000));

    if (m3u8Url) {
      log.success(`${taskId} - Found: ${m3u8Url.substring(0, 60)}...`);
      return m3u8Url;
    }

    log.warn(`${taskId} - No m3u8 found`);
    return null;

  } catch (error) {
    log.error(`${taskId} - Error: ${error.message}`);
    return null;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    state.activePages.delete(pageId);
  }
}

// ===================
// REFRESH LOGIC
// ===================
async function refreshAllEpisodes(isManual = false) {
  if (state.isRefreshing) {
    log.warn('Refresh already in progress');
    return { success: false, reason: 'Already refreshing' };
  }

  state.isRefreshing = true;
  state.stats = { success: 0, failed: 0 };
  const startTime = Date.now();

  log.info(`========================================`);
  log.info(`${isManual ? 'MANUAL' : 'AUTO'} REFRESH STARTED`);
  log.info(`========================================`);

  await sendTelegram(telegram.refreshStart(isManual));

  try {
    for (const seriesId in seriesConfig) {
      const series = seriesConfig[seriesId];
      log.info(`Processing: ${series.title}`);

      for (const seasonNum in series.seasons) {
        const seasonData = series.seasons[seasonNum];
        log.info(`  Season ${seasonNum}: ${seasonData.count} episodes`);

        // Process in batches
        for (let i = 0; i < seasonData.count; i += CONFIG.batchSize) {
          const batch = [];

          for (let j = 0; j < CONFIG.batchSize && (i + j) < seasonData.count; j++) {
            const episodeNum = i + j + 1;
            
            batch.push(
              fetchM3u8(parseInt(seriesId), parseInt(seasonNum), episodeNum)
                .then(async (m3u8Url) => {
                  if (m3u8Url) {
                    const payload = {
                      movieId: parseInt(seriesId),
                      mediaType: series.mediaType,
                      m3u8Url: m3u8Url,
                      title: `${series.title} S${seasonNum}E${episodeNum}`,
                      season: parseInt(seasonNum),
                      episode: episodeNum,
                      quality: 'auto',
                      notes: isManual ? 'Manual' : 'Auto',
                      timestamp: new Date().toISOString()
                    };

                    const sent = await sendToWebhook(payload);
                    if (sent) {
                      state.stats.success++;
                      log.success(`  ✓ ${series.title} S${seasonNum}E${episodeNum}`);
                    } else {
                      state.stats.failed++;
                      state.failedEpisodes.push({ seriesId, seasonNum, episodeNum, reason: 'Webhook failed' });
                    }
                  } else {
                    state.stats.failed++;
                    state.failedEpisodes.push({ seriesId, seasonNum, episodeNum, reason: 'No m3u8' });
                  }
                })
                .catch((err) => {
                  state.stats.failed++;
                  state.failedEpisodes.push({ seriesId, seasonNum, episodeNum, reason: err.message });
                })
            );
          }

          await Promise.allSettled(batch);

          // Run GC occasionally
          if (global.gc && Math.random() < 0.1) {
            global.gc();
          }

          // Delay between batches
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info(`========================================`);
    log.success(`REFRESH COMPLETE: ${state.stats.success} OK, ${state.stats.failed} failed (${duration}s)`);
    log.info(`========================================`);

    state.lastRefreshTime = new Date();

    await sendTelegram(telegram.refreshComplete(state.stats, duration, isManual));

  } catch (error) {
    log.error(`Refresh error: ${error.message}`);
    await sendTelegram(telegram.refreshError(error.message));
  } finally {
    state.isRefreshing = false;
    
    // Cleanup and schedule next
    await cleanupBrowser();
    if (global.gc) global.gc();
    
    const mem = process.memoryUsage();
    log.info(`Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`);
    
    scheduleNextRefresh();
  }

  return { success: true, stats: state.stats };
}

// ===================
// NEW EPISODE DETECTION
// ===================
async function checkForNewEpisodes(seriesId = null) {
  log.info('Checking for new episodes...');
  const results = [];
  const seriesToCheck = seriesId ? [seriesId] : Object.keys(episodeCheckSchedule).map(Number);

  for (const id of seriesToCheck) {
    const series = seriesConfig[id];
    if (!series) {
      log.warn(`Series ${id} not in config, skipping`);
      continue;
    }

    let page = null;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();

      // Block unnecessary resources
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const blocked = ['image', 'stylesheet', 'font', 'media', 'websocket', 'manifest'];
        if (blocked.includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

      // Get current last season
      const seasonKeys = Object.keys(series.seasons).map(Number);
      const lastSeason = Math.max(...seasonKeys);
      const lastSeasonData = series.seasons[lastSeason];
      const currentLastEp = lastSeasonData.startEpisode + lastSeasonData.count - 1;

      // Check next episode
      const nextEp = currentLastEp + 1;
      const checkUrl = series.urlPattern.replace('{episode}', nextEp);

      log.info(`${series.title}: Checking episode ${nextEp} at ${checkUrl}`);

      const response = await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = response.status();

      // Check if page has video player (indicates valid episode)
      const hasPlayer = await page.evaluate(() => {
        return !!(
          document.querySelector('.jw-video') ||
          document.querySelector('video') ||
          document.querySelector('[class*="player"]') ||
          document.querySelector('iframe[src*="embed"]')
        );
      });

      if (status === 200 && hasPlayer) {
        // New episode found!
        log.success(`${series.title}: NEW EPISODE ${nextEp} FOUND!`);

        // Update series config
        lastSeasonData.count += 1;

        await sendTelegram(telegram.newEpisode(series, nextEp, lastSeason, lastSeasonData.count));

        results.push({
          seriesId: id,
          title: series.title,
          status: 'updated',
          season: lastSeason,
          newEpisode: nextEp,
          newCount: lastSeasonData.count
        });
      } else {
        log.info(`${series.title}: No new episode yet`);
        results.push({
          seriesId: id,
          title: series.title,
          status: 'up_to_date'
        });
      }

    } catch (error) {
      log.error(`Check failed for ${series?.title || id}: ${error.message}`);
      results.push({
        seriesId: id,
        status: 'error',
        error: error.message
      });
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  await cleanupBrowser();
  return results;
}

function scheduleDailyEpisodeCheck() {
  const check = () => {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();

    for (const [id, schedule] of Object.entries(episodeCheckSchedule)) {
      if (schedule.day === day && hour === schedule.hour) {
        log.info(`Scheduled episode check for ${schedule.name}`);
        checkForNewEpisodes(parseInt(id));
      }
    }
  };

  // Check every hour
  setInterval(check, 60 * 60 * 1000);
  
  // Run initial check
  check();
  
  log.info('Daily episode check scheduler started');
}

// ===================
// SCHEDULING
// ===================
function scheduleNextRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  const intervalMs = CONFIG.refreshIntervalHours * 60 * 60 * 1000;
  state.nextRefreshTime = new Date(Date.now() + intervalMs);

  log.info(`Next refresh scheduled: ${state.nextRefreshTime.toISOString()}`);
  log.info(`Time until next: ${CONFIG.refreshIntervalHours} hours`);

  state.refreshTimer = setTimeout(() => {
    if (!state.isRefreshing) {
      refreshAllEpisodes(false);
    } else {
      scheduleNextRefresh();
    }
  }, intervalMs);
}

// ===================
// API ROUTES
// ===================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    isRefreshing: state.isRefreshing,
    uptime: process.uptime()
  });
});

app.get('/api/status', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    server: {
      status: state.isRefreshing ? 'Refreshing' : 'Ready',
      uptime: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`
    },
    refresh: {
      isRefreshing: state.isRefreshing,
      lastRefreshTime: state.lastRefreshTime?.toISOString() || 'Never',
      nextRefreshTime: state.nextRefreshTime?.toISOString() || 'Not scheduled'
    },
    memory: {
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`
    },
    series: Object.keys(seriesConfig).length,
    failedEpisodes: state.failedEpisodes.length
  });
});

app.post('/api/refresh', async (req, res) => {
  res.json({ success: true, message: 'Refresh started' });
  refreshAllEpisodes(true);
});

app.get('/api/refresh', async (req, res) => {
  res.json({ success: true, message: 'Refresh started' });
  refreshAllEpisodes(true);
});

app.post('/api/cleanup', async (req, res) => {
  const memBefore = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  await cleanupBrowser();
  if (global.gc) global.gc();
  const memAfter = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  
  res.json({
    success: true,
    message: 'Cleanup complete',
    memoryBefore: `${memBefore}MB`,
    memoryAfter: `${memAfter}MB`
  });
});

app.get('/api/failed', (req, res) => {
  res.json({
    count: state.failedEpisodes.length,
    episodes: state.failedEpisodes
  });
});

app.post('/api/failed/clear', (req, res) => {
  state.failedEpisodes = [];
  res.json({ success: true, message: 'Failed episodes cleared' });
});

app.post('/api/check-new', async (req, res) => {
  try {
    const results = await checkForNewEpisodes();
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/check-new/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!seriesConfig[id]) {
    return res.status(404).json({ success: false, error: 'Series not found' });
  }
  try {
    const results = await checkForNewEpisodes(id);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Error handler
app.use((err, req, res, next) => {
  log.error(`Express error: ${err.message}`);
  res.status(500).json({ success: false, error: 'Server error' });
});

// ===================
// MEMORY MONITOR
// ===================
setInterval(async () => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  
  log.debug(`Memory: Heap=${heapMB}MB, RSS=${rssMB}MB`);
  
  if (heapMB > 400 && !state.isRefreshing) {
    log.warn('High memory detected, running cleanup...');
    await sendTelegram(telegram.highMemory(heapMB, rssMB));
    await cleanupBrowser();
    if (global.gc) global.gc();
  }
}, 60000);

// ===================
// SERVER STARTUP
// ===================
const server = app.listen(CONFIG.port, () => {
  log.info(`========================================`);
  log.info(`SCRAPPER SERVER STARTED`);
  log.info(`Port: ${CONFIG.port}`);
  log.info(`Refresh interval: ${CONFIG.refreshIntervalHours} hours`);
  log.info(`Series: ${Object.keys(seriesConfig).length}`);
  log.info(`GC available: ${!!global.gc}`);
  log.info(`========================================`);

  // Schedule refresh loop
  scheduleNextRefresh();
  
  // Start daily episode check scheduler
  scheduleDailyEpisodeCheck();
  
  // Send startup notification
  sendTelegram(telegram.startup());
});

// ===================
// GRACEFUL SHUTDOWN
// ===================
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down...');
  await cleanupBrowser();
  server.close(() => {
    log.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, shutting down...');
  await cleanupBrowser();
  server.close(() => {
    log.info('Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', async (err) => {
  log.error(`Uncaught exception: ${err.message}`);
  await sendTelegram(telegram.crash(err.message));
  await cleanupBrowser();
  setTimeout(() => process.exit(1), 3000);
});

process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});

module.exports = { app, refreshAllEpisodes, fetchM3u8 };
