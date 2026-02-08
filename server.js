// scrapper.js - CLEAN REWRITE FOR SINGLE SERIES TEST
// Tests container persistence on Railway free tier

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { exec } = require('child_process');
const { MongoClient } = require('mongodb');

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
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb+srv://theadnan4a:Wearefaimly1@flixstream.u4avnvo.mongodb.net/scraper?retryWrites=true&w=majority',
    database: 'scraper',
    collection: 'series_config'
  },
  maxConcurrentPages: 1,  // Sequential for stability on free tier
  batchSize: 1            // One at a time to prevent memory issues
};

// Episode check schedule (day: 0=Sun, 1=Mon, ..., 6=Sat)
const episodeCheckSchedule = {
  283123: { name: 'Esref Ruya', day: 2, hour: 3 },      // Tuesday 3 AM
  274556: { name: 'Far Away', day: 0, hour: 3 },        // Sunday 3 AM
  302063: { name: 'Deep in Love', day: 5, hour: 3 },    // Friday 3 AM
  306529: { name: 'A.B.I', day: 5, hour: 3 },          // Friday 3 AM
  302658: { name: 'Founder Orhan', day: 2, hour: 3 }   // Friday 3 AM  
  
};

// Series Configuration
const seriesConfig = {
  283123: {
    name: 'Esref Ruya',
    title: 'Esref Ruya',
    urlPattern: 'https://hds.turkish123.com/esref-ruya-episode-{episode}/',
    mediaType: 'tv',
    seasons: {
      1: { startEpisode: 1, count: 13 },
      2: { startEpisode: 14, count: 16 }
    }
  },
  306529: {
    name: 'A.B.I',
    title: 'A.B.I',
    urlPattern: 'https://hds.turkish123.com/abi-episode-{episode}/',
    mediaType: 'tv',
    seasons: {
      1: { startEpisode: 1, count: 2 },
    
    }
  },
  274556: {
    name: 'Uzak Sehir',
    title: 'Far Away',
    urlPattern: 'https://hds.turkish123.com/uzak-sehir-episode-{episode}/',
    mediaType: 'tv',
    seasons: {
      1: { startEpisode: 1, count: 28 },
      2: { startEpisode: 29, count: 18 }
    }
  },
  	
302658:{name:'Kurlus Orhan',title:'Founder Orhan',urlPattern:'https://hds.turkish123.com/kurulus-orhan-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:11}}},

302063:{name:'tasacak-bu-deniz',title:'Deep in Love',urlPattern:'https://hds.turkish123.com/tasacak-bu-deniz-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:15}}}};


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
// TELEGRAM BOT
// ===================
let lastUpdateId = 0;

// Fetch updates from Telegram
async function getTelegramUpdates() {
  return new Promise((resolve) => {
    try {
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${CONFIG.telegram.botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`,
        method: 'GET',
        timeout: 35000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.ok && result.result.length > 0) {
              resolve(result.result);
            } else {
              resolve([]);
            }
          } catch (e) {
            resolve([]);
          }
        });
      });

      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.end();
    } catch (e) {
      resolve([]);
    }
  });
}

// Process bot commands
async function processTelegramCommand(text, chatId) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/^\//, '');
  const args = parts.slice(1);

  log.info(`Bot command: /${cmd} ${args.join(' ')}`);

  try {
    switch (cmd) {
      case 'start':
        return `<b>👋 Welcome to Scraper Bot!</b>\n\n` +
          `I help you manage your series and episodes without touching any code.\n\n` +
          `<b>Quick Start:</b>\n` +
          `• Send /cmds to see all commands\n` +
          `• Send /list to see your series\n` +
          `• Send /status to check server health\n\n` +
          `💡 <b>Tip:</b> Each command shows usage examples if you use it wrong!\n\n` +
          `Ready to get started? Send /cmds 🚀`;

      case 'help':
      case 'cmds':
      case 'commands':
        return `<b>🤖 All Commands</b>\n\n` +
          `<b>📺 SERIES MANAGEMENT</b>\n` +
          `/list - Show all tracked series\n` +
          `/info <id> - Detailed series info\n` +
          `/add <id> <name> <url> <type>\n` +
          `/remove <id> - Delete a series\n\n` +
          `<b>🎬 EPISODES</b>\n` +
          `/episodes <id> <season>:<count>\n` +
          `/check <id> - Find new episodes\n` +
          `/checkall - Check all series\n\n` +
          `<b>⏰ SCHEDULES</b>\n` +
          `/schedule <id> <day> <hour>\n` +
          `/unschedule <id>\n` +
          `/schedules - View all schedules\n\n` +
          `<b>🔄 CONTROL</b>\n` +
          `/refresh - Re-scrape everything\n` +
          `/status - Server health\n` +
          `/help - Show this message\n\n` +
          `💡 <b>Hint:</b> Just type a command to see examples!`;

      case 'list':
        return await cmdList();

      case 'info':
        if (!args[0]) {
          return `❌ <b>Missing series ID</b>\n\n` +
            `<b>Usage:</b>\n` +
            `/info <id>\n\n` +
            `<b>Example:</b>\n` +
            `/info 283123\n\n` +
            `💡 Use /list to see all series IDs`;
        }
        return await cmdInfo(args[0]);

      case 'add':
        if (args.length < 4) {
          return `❌ <b>Missing parameters</b>\n\n` +
            `<b>Usage:</b>\n` +
            `/add <id> <name> <url> <type>\n\n` +
            `<b>Example:</b>\n` +
            `/add 283123 "Esref Ruya" "https://site.com/show-{episode}/" tv\n\n` +
            `<b>Parameters:</b>\n` +
            `• <b>id</b>: Unique series ID (numbers)\n` +
            `• <b>name</b>: Series title\n` +
            `• <b>url</b>: Must contain {episode}\n` +
            `• <b>type</b>: tv or movie`;
        }
        return await cmdAdd(args);

      case 'remove':
        if (!args[0]) {
          return `❌ <b>Missing series ID</b>\n\n` +
            `<b>Usage:</b>\n` +
            `/remove <id>\n\n` +
            `<b>Example:</b>\n` +
            `/remove 283123\n\n` +
            `⚠️ This will permanently delete the series!`;
        }
        return await cmdRemove(args[0]);

      case 'episodes':
        if (args.length < 2) {
          return `❌ <b>Missing parameters</b>\n\n` +
            `<b>Usage:</b>\n` +
            `/episodes <id> <season>:<count>\n\n` +
            `<b>Examples:</b>\n` +
            `/episodes 283123 1:45\n` +
            `/episodes 274556 2:20\n\n` +
            `<b>What it does:</b>\n` +
            `Sets the episode count for a specific season`;
        }
        return await cmdEpisodes(args[0], args[1]);

      case 'check':
        if (!args[0]) {
          return `❌ <b>Missing series ID</b>\n\n` +
            `<b>Usage:</b>\n` +
            `/check <id>\n\n` +
            `<b>Example:</b>\n` +
            `/check 283123\n\n` +
            `<b>What it does:</b>\n` +
            `Checks if new episodes are available and automatically scrapes them`;
        }
        return await cmdCheck(args[0]);

      case 'checkall':
        return await cmdCheckAll();

      case 'schedule':
        if (args.length < 3) {
          return `❌ <b>Missing parameters</b>\n\n` +
            `<b>Usage:</b>\n` +
            `/schedule <id> <day> <hour>\n\n` +
            `<b>Examples:</b>\n` +
            `/schedule 283123 tue 15\n` +
            `/schedule 274556 sun 3\n\n` +
            `<b>Days:</b> sun, mon, tue, wed, thu, fri, sat\n` +
            `<b>Hours:</b> 0-23 (24-hour format)\n\n` +
            `<b>What it does:</b>\n` +
            `Automatically checks for new episodes at the scheduled time`;
        }
        return await cmdSchedule(args[0], args[1], args[2]);

      case 'unschedule':
        if (!args[0]) {
          return `❌ <b>Missing series ID</b>\n\n` +
            `<b>Usage:</b>\n` +
            `/unschedule <id>\n\n` +
            `<b>Example:</b>\n` +
            `/unschedule 283123\n\n` +
            `<b>What it does:</b>\n` +
            `Removes the auto-check schedule for this series`;
        }
        return await cmdUnschedule(args[0]);

      case 'schedules':
        return await cmdSchedules();

      case 'refresh':
        return await cmdRefresh();

      case 'status':
        return await cmdStatus();

      default:
        return `❌ Unknown command. Send /help for available commands.`;
    }
  } catch (error) {
    log.error(`Command error: ${error.message}`);
    return `❌ Error: ${error.message}`;
  }
}

// Command handlers
async function cmdList() {
  if (Object.keys(seriesConfig).length === 0) {
    return `📺 <b>No series found</b>\n\n` +
      `Get started by adding a series:\n\n` +
      `<b>Example:</b>\n` +
      `/add 283123 "My Show" "https://site.com/episode-{episode}/" tv\n\n` +
      `Type /add for usage help`;
  }

  const seriesList = Object.entries(seriesConfig).map(([id, s]) => {
    const seasons = Object.keys(s.seasons).length;
    const totalEps = Object.values(s.seasons).reduce((sum, season) => sum + season.count, 0);
    const scheduled = episodeCheckSchedule[id] ? '⏰' : '';
    return `${scheduled} <b>${s.title}</b>\n   ID: ${id} | ${seasons} season(s) | ${totalEps} episodes`;
  }).join('\n\n');

  return `<b>📺 All Series (${Object.keys(seriesConfig).length})</b>\n\n${seriesList}\n\n` +
    `💡 Use /info <id> for details`;
}

async function cmdInfo(id) {
  const series = seriesConfig[id];
  if (!series) return `❌ Series ${id} not found`;

  const schedule = episodeCheckSchedule[id];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  let info = `<b>📺 ${series.title}</b>\n\n`;
  info += `🆔 ID: ${id}\n`;
  info += `🎬 Type: ${series.mediaType}\n`;
  info += `🔗 URL: ${series.urlPattern}\n\n`;
  info += `<b>Seasons:</b>\n`;
  
  for (const [seasonNum, seasonData] of Object.entries(series.seasons)) {
    info += `  S${seasonNum}: ${seasonData.count} episodes (starts at ${seasonData.startEpisode})\n`;
  }
  
  if (schedule) {
    info += `\n⏰ Auto-check: ${days[schedule.day]} at ${schedule.hour}:00`;
  } else {
    info += `\n⏰ Auto-check: Not scheduled`;
  }

  return info;
}

async function cmdAdd(args) {
  const [id, name, url, type] = args;
  
  if (seriesConfig[id]) {
    return `❌ <b>Series already exists</b>\n\n` +
      `Series ${id} is already in your list.\n\n` +
      `Use /info ${id} to view it\n` +
      `Use /remove ${id} to delete it first`;
  }

  // Validate URL pattern
  if (!url.includes('{episode}')) {
    return `❌ <b>Invalid URL pattern</b>\n\n` +
      `URL must contain {episode} placeholder\n\n` +
      `<b>Example:</b>\n` +
      `https://site.com/show-{episode}/\n\n` +
      `The {episode} part will be replaced with episode numbers (1, 2, 3...)`;
  }

  // Validate type
  if (type !== 'tv' && type !== 'movie') {
    return `❌ <b>Invalid type</b>\n\n` +
      `Type must be either:\n` +
      `• <b>tv</b> - for TV series\n` +
      `• <b>movie</b> - for movies`;
  }

  seriesConfig[id] = {
    name: name,
    title: name,
    urlPattern: url,
    mediaType: type,
    seasons: {
      1: { count: 0, startEpisode: 1 }
    }
  };

  saveSeriesConfig();
  
  return `✅ <b>Series Added Successfully!</b>\n\n` +
    `📺 ${name}\n` +
    `🆔 ID: ${id}\n` +
    `🎬 Type: ${type}\n\n` +
    `<b>Next Steps:</b>\n` +
    `1️⃣ Set episode count: /episodes ${id} 1:10\n` +
    `2️⃣ Set auto-check: /schedule ${id} fri 15\n` +
    `3️⃣ Check for episodes: /check ${id}`;
}

async function cmdRemove(id) {
  if (!seriesConfig[id]) {
    return `❌ Series ${id} not found`;
  }

  const name = seriesConfig[id].title;
  delete seriesConfig[id];
  delete episodeCheckSchedule[id];
  saveSeriesConfig();

  return `✅ Removed "${name}" (${id})`;
}

async function cmdEpisodes(id, seasonCount) {
  const series = seriesConfig[id];
  if (!series) return `❌ Series ${id} not found`;

  const match = seasonCount.match(/^(\d+):(\d+)$/);
  if (!match) return `❌ Format: <season>:<count>\nExample: 1:45`;

  const season = parseInt(match[1]);
  const count = parseInt(match[2]);

  if (!series.seasons[season]) {
    series.seasons[season] = { count: count, startEpisode: 1 };
  } else {
    series.seasons[season].count = count;
  }

  saveSeriesConfig();

  return `✅ <b>Updated!</b>\n\n` +
    `📺 ${series.title}\n` +
    `📁 Season ${season}: ${count} episodes`;
}

async function cmdCheck(id) {
  const series = seriesConfig[id];
  if (!series) return `❌ Series ${id} not found`;

  await sendTelegram(`🔍 Checking ${series.title} for new episodes...`);
  
  const results = await checkForNewEpisodes(parseInt(id));
  const result = results[0];

  if (result.status === 'updated') {
    return `✅ <b>Check Complete!</b>\n\n` +
      `📺 ${result.title}\n` +
      `🆕 ${result.newEpisodes} new episode(s) found\n` +
      `📁 Season ${result.season}: ${result.oldCount} → ${result.newCount}\n` +
      `✅ Scraped: ${result.scraped}/${result.newEpisodes}`;
  } else if (result.status === 'up_to_date') {
    return `✅ ${series.title} is up to date (no new episodes)`;
  } else {
    return `❌ Check failed: ${result.error}`;
  }
}

async function cmdCheckAll() {
  const count = Object.keys(episodeCheckSchedule).length;
  
  if (count === 0) {
    return `❌ <b>No scheduled series</b>\n\n` +
      `You don't have any series with schedules set.\n\n` +
      `<b>To check all series:</b>\n` +
      `First add schedules with /schedule\n\n` +
      `<b>To check a specific series:</b>\n` +
      `Use /check <id> instead\n\n` +
      `💡 Use /schedules to see scheduled series`;
  }
  
  await sendTelegram(`🔍 Checking ${count} scheduled series for new episodes...`);
  
  const results = await checkForNewEpisodes();
  const updated = results.filter(r => r.status === 'updated');
  const errors = results.filter(r => r.status === 'error');
  const upToDate = results.length - updated.length - errors.length;

  let msg = `✅ <b>Check Complete!</b>\n\n`;
  
  if (updated.length > 0) {
    msg += `🆕 <b>New Episodes Found:</b>\n`;
    updated.forEach(r => {
      msg += `  • ${r.title}: +${r.newEpisodes} ep (S${r.season})\n`;
    });
    msg += '\n';
  } else {
    msg += `✅ All series are up to date!\n\n`;
  }
  
  msg += `<b>Summary:</b>\n`;
  msg += `📊 Checked: ${results.length}\n`;
  msg += `✅ Up to date: ${upToDate}\n`;
  if (updated.length > 0) msg += `🆕 Updated: ${updated.length}\n`;
  if (errors.length > 0) msg += `❌ Errors: ${errors.length}\n`;
  
  if (errors.length > 0) {
    msg += `\n⚠️ Some checks failed. Use /check <id> to retry specific series.`;
  }

  return msg;
}

async function cmdSchedule(id, dayStr, hourStr) {
  const series = seriesConfig[id];
  if (!series) return `❌ Series ${id} not found`;

  const days = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const day = days[dayStr.toLowerCase()];
  const hour = parseInt(hourStr);

  if (day === undefined) {
    return `❌ Invalid day. Use: sun, mon, tue, wed, thu, fri, sat`;
  }
  if (isNaN(hour) || hour < 0 || hour > 23) {
    return `❌ Invalid hour. Use 0-23`;
  }

  episodeCheckSchedule[id] = {
    name: series.title,
    day: day,
    hour: hour
  };

  saveSeriesConfig();

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `✅ <b>Schedule Set!</b>\n\n` +
    `📺 ${series.title}\n` +
    `⏰ ${dayNames[day]} at ${hour}:00`;
}

async function cmdUnschedule(id) {
  const series = seriesConfig[id];
  if (!series) return `❌ Series ${id} not found`;

  if (!episodeCheckSchedule[id]) {
    return `❌ No schedule set for ${series.title}`;
  }

  delete episodeCheckSchedule[id];
  saveSeriesConfig();

  return `✅ Schedule removed for ${series.title}`;
}

async function cmdSchedules() {
  if (Object.keys(episodeCheckSchedule).length === 0) {
    return `📅 <b>No Scheduled Checks</b>\n\n` +
      `You haven't set up any auto-check schedules yet.\n\n` +
      `<b>Example:</b>\n` +
      `/schedule 283123 fri 15\n\n` +
      `This will automatically check for new episodes every Friday at 3 PM.\n\n` +
      `Type /schedule for usage help`;
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const now = new Date();
  const currentDay = now.getDay();
  const currentHour = now.getHours();
  
  let msg = `<b>📅 Scheduled Auto-Checks (${Object.keys(episodeCheckSchedule).length})</b>\n\n`;

  for (const [id, schedule] of Object.entries(episodeCheckSchedule)) {
    const isToday = schedule.day === currentDay;
    const isPast = isToday && schedule.hour < currentHour;
    const isCurrent = isToday && schedule.hour === currentHour;
    
    let indicator = '';
    if (isCurrent) indicator = '🔴 ';
    else if (isToday && !isPast) indicator = '🟡 ';
    
    msg += `${indicator}<b>${schedule.name}</b>\n`;
    msg += `   ⏰ ${dayNames[schedule.day]} at ${schedule.hour}:00`;
    
    if (isCurrent) msg += ` (Running now!)`;
    else if (isToday && !isPast) msg += ` (Today!)`;
    
    msg += `\n   🆔 ID: ${id}\n\n`;
  }
  
  msg += `💡 Use /unschedule <id> to remove a schedule`;

  return msg;
}

async function cmdRefresh() {
  if (state.isRefreshing) {
    const progress = state.stats.success + state.stats.failed;
    return `⏳ <b>Refresh Already Running</b>\n\n` +
      `📊 Progress: ${progress} episodes processed\n` +
      `✅ Success: ${state.stats.success}\n` +
      `❌ Failed: ${state.stats.failed}\n\n` +
      `Please wait for it to complete. You'll get a notification when done.`;
  }

  const totalSeries = Object.keys(seriesConfig).length;
  const totalEps = Object.values(seriesConfig).reduce((sum, s) => {
    return sum + Object.values(s.seasons).reduce((sSum, season) => sSum + season.count, 0);
  }, 0);

  refreshAllEpisodes(true);
  
  return `🔄 <b>Refresh Started!</b>\n\n` +
    `📺 Series: ${totalSeries}\n` +
    `🎬 Total Episodes: ${totalEps}\n\n` +
    `⏱ This will take a while (approx ${Math.ceil(totalEps / 60)} minutes)\n\n` +
    `You'll get a notification when it's complete.\n\n` +
    `💡 Use /status to check progress`;
}

async function cmdStatus() {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const uptime = Math.floor(process.uptime() / 3600);

  let msg = `<b>📊 Server Status</b>\n\n`;
  msg += `🟢 Running: ${uptime}h\n`;
  msg += `💾 Memory: ${heapMB}MB heap, ${rssMB}MB total\n`;
  msg += `📺 Series: ${Object.keys(seriesConfig).length}\n`;
  msg += `⏰ Scheduled: ${Object.keys(episodeCheckSchedule).length}\n\n`;

  if (state.isRefreshing) {
    msg += `🔄 Status: <b>Refreshing...</b>\n`;
    msg += `✅ Success: ${state.stats.success}\n`;
    msg += `❌ Failed: ${state.stats.failed}`;
  } else {
    msg += `🔄 Status: Idle\n`;
    if (state.lastRefreshTime) {
      const lastRefresh = Math.floor((Date.now() - state.lastRefreshTime) / 60000);
      msg += `⏱ Last refresh: ${lastRefresh}m ago\n`;
    }
    if (state.nextRefreshTime) {
      const nextRefresh = Math.floor((state.nextRefreshTime - Date.now()) / 60000);
      msg += `⏭ Next refresh: ${nextRefresh}m`;
    }
  }

  return msg;
}

// Bot polling loop
async function startTelegramBot() {
  log.info('Telegram bot started');
  
  const poll = async () => {
    try {
      const updates = await getTelegramUpdates();
      
      for (const update of updates) {
        lastUpdateId = update.update_id;
        
        if (update.message && update.message.text && update.message.text.startsWith('/')) {
          const chatId = update.message.chat.id;
          
          // Only respond to authorized chat
          if (chatId.toString() !== CONFIG.telegram.chatId) {
            log.warn(`Unauthorized bot access from ${chatId}`);
            continue;
          }

          const response = await processTelegramCommand(update.message.text, chatId);
          await sendTelegram(response);
        }
      }
    } catch (error) {
      log.error(`Bot polling error: ${error.message}`);
    }
    
    // Continue polling
    setTimeout(poll, 1000);
  };

  poll();
}

// ===================
// MONGODB
// ===================
let mongoClient = null;
let mongodb = null;

async function connectMongoDB() {
  if (mongodb) return mongodb;
  
  try {
    log.info('Connecting to MongoDB...');
    mongoClient = new MongoClient(CONFIG.mongodb.uri);
    await mongoClient.connect();
    mongodb = mongoClient.db(CONFIG.mongodb.database);
    log.success('MongoDB connected');
    return mongodb;
  } catch (error) {
    log.error(`MongoDB connection failed: ${error.message}`);
    return null;
  }
}

async function saveConfigToMongoDB() {
  try {
    const db = await connectMongoDB();
    if (!db) {
      log.warn('MongoDB not available, falling back to file');
      return saveConfigToFile();
    }

    const collection = db.collection(CONFIG.mongodb.collection);
    const configData = {
      _id: 'main_config',
      series: seriesConfig,
      schedules: episodeCheckSchedule,
      lastUpdated: new Date()
    };

    await collection.replaceOne(
      { _id: 'main_config' },
      configData,
      { upsert: true }
    );

    log.success('Config saved to MongoDB');
    
    // Also save to file as backup
    saveConfigToFile();
    
    return true;
  } catch (error) {
    log.error(`MongoDB save failed: ${error.message}`);
    // Fallback to file
    return saveConfigToFile();
  }
}

async function loadConfigFromMongoDB() {
  try {
    const db = await connectMongoDB();
    if (!db) {
      log.warn('MongoDB not available, loading from file');
      return loadConfigFromFile();
    }

    const collection = db.collection(CONFIG.mongodb.collection);
    const saved = await collection.findOne({ _id: 'main_config' });

    if (saved && saved.series) {
      // Load series
      for (const id in saved.series) {
        if (seriesConfig[id]) {
          seriesConfig[id].seasons = saved.series[id].seasons;
        } else {
          // Add completely new series from MongoDB
          seriesConfig[id] = saved.series[id];
        }
      }

      // Load schedules
      if (saved.schedules) {
        for (const id in saved.schedules) {
          episodeCheckSchedule[id] = saved.schedules[id];
        }
      }

      log.success(`Config loaded from MongoDB (updated: ${saved.lastUpdated?.toISOString() || 'unknown'})`);
      return true;
    } else {
      log.info('No config in MongoDB, loading from file');
      return loadConfigFromFile();
    }
  } catch (error) {
    log.error(`MongoDB load failed: ${error.message}`);
    // Fallback to file
    return loadConfigFromFile();
  }
}

// File-based fallback functions
function saveConfigToFile() {
  try {
    const data = {
      series: seriesConfig,
      schedules: episodeCheckSchedule
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
    log.success('Config saved to file (backup)');
    return true;
  } catch (e) {
    log.error(`File save failed: ${e.message}`);
    return false;
  }
}

function loadConfigFromFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      
      if (saved.series) {
        for (const id in saved.series) {
          if (seriesConfig[id]) {
            seriesConfig[id].seasons = saved.series[id].seasons;
          } else {
            seriesConfig[id] = saved.series[id];
          }
        }
        
        if (saved.schedules) {
          for (const id in saved.schedules) {
            episodeCheckSchedule[id] = saved.schedules[id];
          }
        }
      }
      
      log.success('Config loaded from file');
      return true;
    }
    return false;
  } catch (e) {
    log.warn(`File load failed: ${e.message}`);
    return false;
  }
}

// ===================
// BROWSER MANAGEMENT
// ===================
let browserLock = false;

async function getBrowser(retries = 3) {
  // Wait if another process is launching browser
  while (browserLock) {
    await new Promise(r => setTimeout(r, 500));
  }

  if (!state.browser || !state.browser.isConnected()) {
    browserLock = true;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log.info(`Launching browser (attempt ${attempt}/${retries})...`);
        
        // Kill any orphaned processes first
        await new Promise(resolve => {
          exec('pkill -9 chrome || pkill -9 chromium || true', () => resolve());
        });
        
        // Force GC before launching
        if (global.gc) global.gc();
        
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
            '--js-flags=--max-old-space-size=128'
          ],
          timeout: 60000,
          protocolTimeout: 60000
        });

        state.browser.on('disconnected', () => {
          log.warn('Browser disconnected - will reconnect on next request');
          state.browser = null;
        });

        state.browser.on('error', (err) => {
          log.error(`Browser error: ${err.message}`);
          state.browser = null;
        });

        log.success('Browser launched');
        browserLock = false;
        return state.browser;
        
      } catch (err) {
        log.error(`Browser launch failed (attempt ${attempt}): ${err.message}`);
        state.browser = null;
        
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    
    browserLock = false;
    throw new Error('Failed to launch browser after ' + retries + ' attempts');
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
async function fetchM3u8(seriesId, seasonNum, episodeNum, retryCount = 0) {
  const maxRetries = 2;
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

  let page = null;

  try {
    // Get browser (will reconnect if disconnected)
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

    // Capture m3u8 URL - resolve immediately when found
    let m3u8Url = null;
    let m3u8Resolve = null;
    const m3u8Promise = new Promise(resolve => { m3u8Resolve = resolve; });

    page.on('response', (response) => {
      const responseUrl = response.url();
      if (responseUrl.includes('.m3u8') && !responseUrl.includes('bumper') && !m3u8Url) {
        m3u8Url = responseUrl;
        m3u8Resolve(responseUrl);
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    log.info(`${taskId} - Fetching: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Quick check if m3u8 already captured
    if (m3u8Url) {
      log.success(`${taskId} - Found (instant): ${m3u8Url.substring(0, 60)}...`);
      return m3u8Url;
    }

    // Click play button if exists
    try {
      await page.waitForSelector('.jw-icon-display, .vjs-big-play-button, [class*="play"]', { timeout: 3000 });
      await page.click('.jw-icon-display, .vjs-big-play-button, [class*="play"]').catch(() => {});
    } catch (e) {
      // No play button, continue
    }

    // Race: wait for m3u8 or timeout (max 5 seconds after click)
    await Promise.race([
      m3u8Promise,
      new Promise(r => setTimeout(() => r(null), 5000))
    ]);

    if (m3u8Url) {
      log.success(`${taskId} - Found: ${m3u8Url.substring(0, 60)}...`);
      return m3u8Url;
    }

    log.warn(`${taskId} - No m3u8 found`);
    return null;

  } catch (error) {
    log.error(`${taskId} - Error: ${error.message}`);
    
    // Retry on browser disconnect or timeout
    if (retryCount < maxRetries && (error.message.includes('disconnect') || error.message.includes('timeout') || error.message.includes('Target closed'))) {
      log.info(`${taskId} - Retrying (${retryCount + 1}/${maxRetries})...`);
      
      // Clean up and wait before retry
      if (page) await page.close().catch(() => {});
      await cleanupBrowser();
      await new Promise(r => setTimeout(r, 2000));
      
      return fetchM3u8(seriesId, seasonNum, episodeNum, retryCount + 1);
    }
    
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // Page already closed, ignore
      }
    }
    
    // Run GC after each page to keep memory low
    if (global.gc) global.gc();
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
// CONFIG PERSISTENCE
// ===================
const CONFIG_FILE = '/tmp/series_config.json';

// Wrapper functions that use MongoDB with file fallback
function saveSeriesConfig() {
  saveConfigToMongoDB().catch(err => {
    log.error(`Save config error: ${err.message}`);
  });
}

async function loadSeriesConfig() {
  await loadConfigFromMongoDB().catch(err => {
    log.error(`Load config error: ${err.message}`);
  });
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
    let newEpisodesFound = 0;

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
      const originalCount = lastSeasonData.count;
      let currentLastEp = lastSeasonData.startEpisode + lastSeasonData.count - 1;

      // Keep checking until we find no more new episodes
      let keepChecking = true;
      while (keepChecking) {
        const nextEp = currentLastEp + 1;
        const checkUrl = series.urlPattern.replace('{episode}', nextEp);

        log.info(`${series.title}: Checking episode ${nextEp}...`);

        const response = await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const status = response.status();

        // Check if page has video player
        const hasPlayer = await page.evaluate(() => {
          return !!(
            document.querySelector('.jw-video') ||
            document.querySelector('video') ||
            document.querySelector('[class*="player"]') ||
            document.querySelector('iframe[src*="embed"]')
          );
        });

        if (status === 200 && hasPlayer) {
          newEpisodesFound++;
          lastSeasonData.count += 1;
          currentLastEp = nextEp;
          log.success(`${series.title}: Episode ${nextEp} FOUND! (${newEpisodesFound} new)`);
        } else {
          keepChecking = false;
        }
      }

      if (newEpisodesFound > 0) {
        // Save updated config
        saveSeriesConfig();

        await sendTelegram(
          `🆕 <b>New Episodes Found!</b>\n\n` +
          `📺 ${series.title}\n` +
          `🎬 ${newEpisodesFound} new episode${newEpisodesFound > 1 ? 's' : ''}\n` +
          `📁 Season ${lastSeason}: ${originalCount} → ${lastSeasonData.count}\n` +
          `🔄 Scraping new episodes...\n\n` +
          `<i>${new Date().toUTCString()}</i>`
        );

        // Scrape the new episodes
        log.info(`${series.title}: Scraping ${newEpisodesFound} new episodes...`);
        let scraped = 0;
        for (let i = 0; i < newEpisodesFound; i++) {
          const epNum = originalCount + i + 1;
          const m3u8Url = await fetchM3u8(id, lastSeason, epNum);
          if (m3u8Url) {
            await sendToWebhook({
              movieId: id,
              mediaType: series.mediaType,
              m3u8Url,
              title: `${series.title} S${lastSeason}E${epNum}`,
              season: lastSeason,
              episode: epNum,
              quality: 'auto',
              timestamp: new Date().toISOString()
            });
            scraped++;
          }
        }
        log.success(`${series.title}: Scraped ${scraped}/${newEpisodesFound} new episodes`);

        results.push({
          seriesId: id,
          title: series.title,
          status: 'updated',
          season: lastSeason,
          newEpisodes: newEpisodesFound,
          scraped: scraped,
          oldCount: originalCount,
          newCount: lastSeasonData.count
        });
      } else {
        log.info(`${series.title}: No new episodes`);
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

// Main UI Dashboard
app.get('/', (req, res) => {
  const mem = process.memoryUsage();
  const seriesList = Object.entries(seriesConfig).map(([id, s]) => {
    const totalEps = Object.values(s.seasons).reduce((sum, season) => sum + season.count, 0);
    return `<div class="series-card">
      <h3>${s.title}</h3>
      <p>ID: ${id} | Seasons: ${Object.keys(s.seasons).length} | Episodes: ${totalEps}</p>
      <div class="btn-group">
        <button onclick="checkNew(${id})">🔍 Check New</button>
        <button onclick="refreshSeries(${id})">🔄 Refresh</button>
      </div>
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Scrapper Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 20px; min-height: 100vh; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 30px; color: #fff; }
    .status-bar { background: #1a1a1a; padding: 15px 20px; border-radius: 10px; margin-bottom: 20px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
    .status-item { text-align: center; }
    .status-item span { display: block; font-size: 12px; color: #888; }
    .status-item strong { color: #4ade80; font-size: 18px; }
    .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px; }
    .actions button { padding: 15px; font-size: 16px; border: none; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
    .btn-check { background: #3b82f6; color: white; }
    .btn-refresh { background: #22c55e; color: white; }
    .btn-cleanup { background: #f59e0b; color: white; }
    .actions button:hover { transform: translateY(-2px); opacity: 0.9; }
    .actions button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .series-card { background: #1a1a1a; padding: 20px; border-radius: 10px; margin-bottom: 15px; }
    .series-card h3 { margin-bottom: 10px; color: #fff; }
    .series-card p { color: #888; margin-bottom: 15px; }
    .btn-group { display: flex; gap: 10px; }
    .btn-group button { padding: 8px 16px; font-size: 14px; border: none; border-radius: 6px; cursor: pointer; background: #333; color: #fff; }
    .btn-group button:hover { background: #444; }
    .log { background: #1a1a1a; padding: 20px; border-radius: 10px; margin-top: 20px; max-height: 400px; overflow-y: auto; }
    .log h3 { margin-bottom: 15px; }
    .log-entry { padding: 8px 12px; margin-bottom: 5px; border-radius: 6px; font-family: monospace; font-size: 13px; }
    .log-success { background: #064e3b; color: #4ade80; }
    .log-error { background: #450a0a; color: #f87171; }
    .log-info { background: #1e3a5f; color: #60a5fa; }
    .log-pending { background: #333; color: #888; }
    #logContainer { min-height: 100px; }
    .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; margin-right: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 Scrapper Dashboard</h1>
    
    <div class="status-bar">
      <div class="status-item"><span>Status</span><strong id="status">${state.isRefreshing ? '🔄 Refreshing' : '✅ Ready'}</strong></div>
      <div class="status-item"><span>Memory</span><strong>${Math.round(mem.heapUsed / 1024 / 1024)}MB</strong></div>
      <div class="status-item"><span>Uptime</span><strong>${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m</strong></div>
      <div class="status-item"><span>Next Refresh</span><strong>${state.nextRefreshTime ? new Date(state.nextRefreshTime).toLocaleTimeString() : 'N/A'}</strong></div>
    </div>

    <div class="actions">
      <button class="btn-check" onclick="checkAllNew()">🔍 Check All New Episodes</button>
      <button class="btn-refresh" onclick="refreshAll()">🔄 Refresh All Series</button>
      <button class="btn-cleanup" onclick="cleanup()">🧹 Cleanup Memory</button>
    </div>

    <h2 style="margin-bottom: 15px;">📺 Series</h2>
    ${seriesList}

    <div class="log">
      <h3>📋 Activity Log</h3>
      <div id="logContainer"></div>
    </div>
  </div>

  <script>
    const logContainer = document.getElementById('logContainer');
    
    function addLog(msg, type = 'info') {
      const entry = document.createElement('div');
      entry.className = 'log-entry log-' + type;
      entry.textContent = new Date().toLocaleTimeString() + ' - ' + msg;
      logContainer.insertBefore(entry, logContainer.firstChild);
      if (logContainer.children.length > 50) logContainer.removeChild(logContainer.lastChild);
    }

    async function checkAllNew() {
      addLog('Checking all series for new episodes...', 'pending');
      try {
        const res = await fetch('/api/check-new');
        const data = await res.json();
        if (data.success) {
          data.results.forEach(r => {
            if (r.status === 'updated') {
              addLog(r.title + ': ' + r.newEpisodes + ' NEW EPISODE(S)! (S' + r.season + ': ' + r.oldCount + ' → ' + r.newCount + ')', 'success');
            } else if (r.status === 'up_to_date') {
              addLog(r.title + ': Up to date', 'info');
            } else {
              addLog(r.title + ': Error - ' + r.error, 'error');
            }
          });
        }
      } catch (e) {
        addLog('Error: ' + e.message, 'error');
      }
    }

    async function checkNew(id) {
      addLog('Checking series ' + id + ' for new episodes...', 'pending');
      try {
        const res = await fetch('/api/check-new/' + id);
        const data = await res.json();
        if (data.success && data.results[0]) {
          const r = data.results[0];
          if (r.status === 'updated') {
            addLog(r.title + ': ' + r.newEpisodes + ' NEW EPISODE(S)! (S' + r.season + ': ' + r.oldCount + ' → ' + r.newCount + ')', 'success');
          } else if (r.status === 'up_to_date') {
            addLog(r.title + ': Up to date', 'info');
          } else {
            addLog(r.title + ': Error - ' + r.error, 'error');
          }
        }
      } catch (e) {
        addLog('Error: ' + e.message, 'error');
      }
    }

    async function refreshAll() {
      addLog('Starting full refresh...', 'pending');
      document.getElementById('status').textContent = '🔄 Refreshing';
      try {
        const res = await fetch('/api/refresh');
        const data = await res.json();
        addLog('Refresh started in background', 'success');
      } catch (e) {
        addLog('Error: ' + e.message, 'error');
      }
    }

    async function refreshSeries(id) {
      addLog('Refreshing series ' + id + '...', 'pending');
      try {
        const res = await fetch('/api/refresh/' + id, { method: 'POST' });
        const data = await res.json();
        addLog('Series refresh started', 'success');
      } catch (e) {
        addLog('Error: ' + e.message, 'error');
      }
    }

    async function cleanup() {
      addLog('Running cleanup...', 'pending');
      try {
        const res = await fetch('/api/cleanup', { method: 'POST' });
        const data = await res.json();
        addLog('Cleanup done: ' + data.memoryBefore + ' → ' + data.memoryAfter, 'success');
      } catch (e) {
        addLog('Error: ' + e.message, 'error');
      }
    }

    addLog('Dashboard loaded', 'info');
  </script>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    isRefreshing: state.isRefreshing,
    uptime: process.uptime()
  });
});

// Get all series config
app.get('/api/series', (req, res) => {
  const series = Object.entries(seriesConfig).map(([id, s]) => {
    const totalEps = Object.values(s.seasons).reduce((sum, season) => sum + season.count, 0);
    const schedule = episodeCheckSchedule[id];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return {
      id: parseInt(id),
      name: s.name,
      title: s.title,
      seasons: Object.keys(s.seasons).length,
      episodes: totalEps,
      checkDay: schedule ? days[schedule.day] : 'N/A',
      checkHour: schedule ? `${schedule.hour}:00` : 'N/A'
    };
  });
  res.json({ success: true, count: series.length, series });
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

// Refresh single series
app.post('/api/refresh/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const series = seriesConfig[id];
  if (!series) {
    return res.status(404).json({ success: false, error: 'Series not found' });
  }
  
  res.json({ success: true, message: `Refreshing ${series.title}` });
  
  // Refresh single series in background
  (async () => {
    log.info(`Single series refresh: ${series.title}`);
    for (const seasonNum in series.seasons) {
      const seasonData = series.seasons[seasonNum];
      for (let ep = 1; ep <= seasonData.count; ep++) {
        const m3u8Url = await fetchM3u8(id, parseInt(seasonNum), ep);
        if (m3u8Url) {
          await sendToWebhook({
            movieId: id,
            mediaType: series.mediaType,
            m3u8Url,
            title: `${series.title} S${seasonNum}E${ep}`,
            season: parseInt(seasonNum),
            episode: ep,
            quality: 'auto',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    await cleanupBrowser();
    log.success(`Single series refresh complete: ${series.title}`);
  })();
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

app.get('/api/check-new', async (req, res) => {
  try {
    const results = await checkForNewEpisodes();
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/check-new', async (req, res) => {
  try {
    const results = await checkForNewEpisodes();
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/check-new/:id', async (req, res) => {
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
const server = app.listen(CONFIG.port, async () => {
  log.info(`========================================`);
  log.info(`SCRAPPER SERVER STARTED`);
  log.info(`Port: ${CONFIG.port}`);
  log.info(`Refresh interval: ${CONFIG.refreshIntervalHours} hours`);
  log.info(`Series: ${Object.keys(seriesConfig).length}`);
  log.info(`GC available: ${!!global.gc}`);
  log.info(`========================================`);

  // Load saved series config from MongoDB (episode counts)
  await loadSeriesConfig();
  
  log.info(`Loaded ${Object.keys(seriesConfig).length} series`);
  
  // Start daily episode check scheduler
  scheduleDailyEpisodeCheck();
  
  // Start Telegram bot
  startTelegramBot();
  
  // Send startup notification
  sendTelegram(telegram.startup());
  
  // Run first refresh immediately on startup
  log.info('Starting initial refresh...');
  refreshAllEpisodes(false);
});

// ===================
// GRACEFUL SHUTDOWN
// ===================
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down...');
  await cleanupBrowser();
  if (mongoClient) {
    await mongoClient.close();
    log.info('MongoDB disconnected');
  }
  server.close(() => {
    log.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, shutting down...');
  await cleanupBrowser();
  if (mongoClient) {
    await mongoClient.close();
    log.info('MongoDB disconnected');
  }
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
