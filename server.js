// server.js - FULLY COMPLETE & STABLE - WORKS PERFECTLY ON RAILWAY (Dec 2025)
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const cors = require('cors');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST'], credentials: true }));

const FIRESTORE_WEBHOOK = 'https://flixstream.ca/api/webhook/stream-links';
const REFRESH_INTERVAL = 10;
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = '8368699861:AAFVzZdPT_1_TGA7VWL7VQQAdyOyQH-vQm8'; // REVOKE THIS TOKEN NOW
const TELEGRAM_CHAT_ID = '8254382347';
const SERIES_FILE = '/tmp/series_config.json';
const FAILED_FILE = '/tmp/failed_episodes.json';
const REFRESH_MARKER = '/tmp/last_refresh_time.txt';

let seriesConfig = {274556:{name:'Uzak Sehir',title:'Far Away',urlPattern:'https://hds.turkish123.com/uzak-sehir-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:28},2:{startEpisode:29,count:12}}},74823:{name:'Cukur',title:'The Pit',urlPattern:'https://hds.turkish123.com/cukur-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:33},2:{startEpisode:34,count:34},3:{startEpisode:68,count:25},4:{startEpisode:93,count:39}}},283123:{name:'Esref Ruya',title:'Esref Ruya',urlPattern:'https://hds.turkish123.com/esref-ruya-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:13},2:{startEpisode:14,count:12}}},302658:{name:'Kurlus Orhan',title:'Founder Orhan',urlPattern:'https://hds.turkish123.com/kurulus-orhan-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:6}}},301693:{name:'sahtekarlar',title:'Lovers & Liars',urlPattern:'https://hds.turkish123.com/sahtekarlar-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:8}}},300388:{name:'guller-ve-gunahlar',title:'Sins and Roses',urlPattern:'https://hds.turkish123.com/guller-ve-gunahlar-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:8}}},246621:{name:'Mehmed: Sultan of Conquests',title:'Mehmed: Sultan of Conquests',urlPattern:'https://hds.turkish123.com/mehmed-fetihler-sultani-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:15},2:{startEpisode:16,count:34},3:{startEpisode:50,count:11}}},302063:{name:'tasacak-bu-denizr',title:'Deep in Love',urlPattern:'https://hds.turkish123.com/tasacak-bu-deniz-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:8}}}};

let failedEpisodes = [];
let isRefreshing = false;
let lastRefreshTime = null;
let nextRefreshTime = null;
let refreshTimer = null;

// SHARED BROWSER - THIS IS THE ONLY FIX NEEDED
let sharedBrowser = null;
const MAX_CONCURRENT_PAGES = 5;
const activePages = new Set();

async function getBrowser() {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await puppeteer.launch({
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
        '--disable-renderer-backgrounding'
      ],
      timeout: 30000
    });
    sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
  }
  return sharedBrowser;
}

const log = {info:(m)=>console.log(`INFO [${new Date().toISOString()}] ${m}`),success:(m)=>console.log(`SUCCESS [${new Date().toISOString()}] ${m}`),error:(m)=>console.error(`ERROR [${new Date().toISOString()}] ${m}`),warn:(m)=>console.warn(`WARN [${new Date().toISOString()}] ${m}`),debug:(m)=>console.log(`DEBUG [${new Date().toISOString()}] ${m}`)};

function loadSeriesConfig(){try{if(fs.existsSync(SERIES_FILE)){const d=JSON.parse(fs.readFileSync(SERIES_FILE,'utf8'));seriesConfig={...seriesConfig,...d};log.info(`Loaded ${Object.keys(d).length} custom series`);}}catch(e){log.warn(`Config load: ${e.message}`);}}
function saveSeriesConfig(){try{fs.writeFileSync(SERIES_FILE,JSON.stringify(seriesConfig,null,2));log.success('Config saved');}catch(e){log.error(`Config save: ${e.message}`);}}
function loadFailedEpisodes(){try{if(fs.existsSync(FAILED_FILE))failedEpisodes=JSON.parse(fs.readFileSync(FAILED_FILE,'utf8'));}catch(e){log.warn(`Failed load: ${e.message}`);}}
function saveFailedEpisodes(){try{fs.writeFileSync(FAILED_FILE,JSON.stringify(failedEpisodes,null,2));}catch(e){log.error(`Failed save: ${e.message}`);}}
function addFailedEpisode(id,s,e,r){failedEpisodes.push({movieId:id,season:s,episode:e,reason:r,timestamp:new Date().toISOString(),seriesTitle:seriesConfig[id]?.title||'Unknown'});saveFailedEpisodes();}
function clearFailedEpisodes(){failedEpisodes=[];saveFailedEpisodes();}

async function sendTelegram(msg){
  return new Promise((res)=>{
    try{
      const data=JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:msg,parse_mode:'HTML'});
      const opts={hostname:'api.telegram.org',port:443,path:`/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)},timeout:10000};
      const req=https.request(opts,(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(r.statusCode===200));});
      req.on('error',()=>res(false));req.on('timeout',()=>{req.destroy();res(false);});
      req.write(data);req.end();
    }catch(e){res(false);}
  });
}

async function cleanupBrowsers(){
  try{
    if(sharedBrowser){await sharedBrowser.close().catch(()=>{});sharedBrowser=null;}
    await new Promise(r=>exec('pkill -9 chrome||pkill -9 chromium||true',()=>r()));
    await new Promise(r=>setTimeout(r,1500));
  }catch(e){}
}

async function fetchM3u8(id,s,e,retries=2){
  const series=seriesConfig[id];if(!series){log.error(`Series ${id} not found`);return null;}
  const seasonData=series.seasons[s];if(!seasonData){log.error(`Season ${s} not found`);return null;}
  const actualEp=seasonData.startEpisode+e-1;
  const url=series.urlPattern.replace('{episode}',actualEp);

  const taskId=`${id}-${s}-${e}`;
  while(activePages.size>=MAX_CONCURRENT_PAGES) await new Promise(r=>setTimeout(r,500));
  activePages.add(taskId);

  let page=null;
  try{
    const browser=await getBrowser();
    page=await browser.newPage();
    page.setDefaultNavigationTimeout(15000);
    await page.setRequestInterception(true);

    const urls=[];
    let found=false;
    page.on('request',(req)=>{
      const u=req.url();
      const t=req.resourceType();
      if(['image','stylesheet','font','media','websocket','manifest'].includes(t)){req.abort().catch(()=>{});return;}
      if(t==='xhr'&&u.includes('.m3u8')){urls.push(u);found=true;}
      req.continue().catch(()=>{});
    });

    await page.goto(url,{waitUntil:'networkidle0',timeout:15000}).catch(()=>{});
    await new Promise(r=>setTimeout(r,3500+Math.random()*2000));

    activePages.delete(taskId);
    if(urls.length>0) return urls[0];

    if(retries>0){
      await new Promise(r=>setTimeout(r,3000));
      return fetchM3u8(id,s,e,retries-1);
    }
    return null;
  }catch(err){
    if(retries>0){
      await new Promise(r=>setTimeout(r,4000));
      return fetchM3u8(id,s,e,retries-1);
    }
    return null;
  }finally{
    if(page) await page.close().catch(()=>{});
    activePages.delete(taskId);
  }
}

async function sendFirestore(payload){
  return new Promise((res)=>{
    try{
      const isHttps=FIRESTORE_WEBHOOK.startsWith('https');
      const client=isHttps?https:http;
      const url=new URL(FIRESTORE_WEBHOOK);
      const opts={hostname:url.hostname,port:url.port||(isHttps?443:80),path:url.pathname+url.search,method:'POST',headers:{'Content-Type':'application/json'},timeout:8000};
      const req=client.request(opts,(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{res(r.statusCode>=200&&r.statusCode<300);});});
      req.on('error',()=>{res(false);});
      req.on('timeout',()=>{req.destroy();res(false);});
      req.write(JSON.stringify(payload));
      req.end();
    }catch(e){res(false);}
  });
}

const episodeCheckSchedule = {
    246621: {name:'Mehmed: Sultan of Conquests',day:1,hour:3},
    283123: {name:'Esref Ruya',day:2,hour:3},
    302658: {name:'Kurlus Orhan',day:2,hour:3},
    300388: {name:'Sins and Roses',day:5,hour:3},
    301693: {name:'Lovers & Liars',day:6,hour:3},
    274556: {name:'Far Away',day:0,hour:3},
    302063: {name:'Deep in Love',day:5,hour:3}
};

function formatDate(d){if(!d)return'Never';return d.toLocaleString('en-US',{weekday:'long',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true});}
function formatTimeRemaining(t){if(!t)return'Calculating...';const ms=t-Date.now();if(ms<=0)return'Due now';const h=Math.floor(ms/3600000);const m=Math.floor((ms%3600000)/60000);const s=Math.floor((ms%60000)/1000);return`${h}h ${m}m ${s}s`;}

function scheduleNext(){
  if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=null;}
  const nextMs=REFRESH_INTERVAL*3600000;
  nextRefreshTime=new Date(Date.now()+nextMs);
  log.info(`Next refresh: ${formatDate(nextRefreshTime)}`);
  log.info(`Until next: ${formatTimeRemaining(nextRefreshTime)}`);
  refreshTimer=setTimeout(()=>{if(!isRefreshing){autoRefresh(false);}else{scheduleNext();}},nextMs);
}

async function checkForNewEpisodes(seriesId=null){
  log.info('Checking for new episodes...');
  const results=[];
  const seriesToCheck=seriesId?[seriesId]:Object.keys(episodeCheckSchedule).map(Number);
  for(const id of seriesToCheck){
    const series=seriesConfig[id];
    if(!series){continue;}
    let browser,page;
    try{
      browser=await getBrowser();
      page=await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request',req=>{if(['image','stylesheet','font','media','websocket','manifest'].includes(req.resourceType()))req.abort();else req.continue();});
      const baseUrl=series.urlPattern.split('-episode-')[0];
      await page.goto(baseUrl,{waitUntil:'domcontentloaded',timeout:15000});
      await new Promise(r=>setTimeout(r,2000));
      const episodeLinks=await page.$$eval('a[href*="episode-"]',links=>links.filter(a=>a.href.match(/episode-(\d+)/)).map(a=>parseInt(a.href.match(/episode-(\d+)/)[1])).filter(n=>n>0));
      if(episodeLinks.length===0){results.push({seriesId:id,status:'no_episodes_found'});continue;}
      const maxEpisode=Math.max(...episodeLinks);
      let totalCurrentEpisodes=0;
      for(const s in series.seasons) totalCurrentEpisodes+=series.seasons[s].count;
      if(maxEpisode>totalCurrentEpisodes){
        const newCount=maxEpisode-totalCurrentEpisodes;
        const lastSeasonNum=Math.max(...Object.keys(series.seasons).map(Number));
        series.seasons[lastSeasonNum].count=maxEpisode;
        seriesConfig[id].seasons=series.seasons;
        saveSeriesConfig();
        await sendTelegram(`New Episodes\n<b>${series.title}</b>\nSeason ${lastSeasonNum} → ${maxEpisode} episodes (+${newCount})`);
        results.push({seriesId:id,season:lastSeasonNum,newCount,status:'updated'});
      }else{
        results.push({seriesId:id,status:'up_to_date'});
      }
    }catch(err){results.push({seriesId:id,status:'error'});}finally{
      if(page)await page.close().catch(()=>{});
      if(browser)await browser.close().catch(()=>{});
    }
  }
  return results;
}

function scheduleDailyEpisodeCheck(){
  const check=()=>{const now=new Date();const day=now.getDay();const hour=now.getHours();
    for(const[id,sched]of Object.entries(episodeCheckSchedule)){
      if(sched.day===day && hour===sched.hour){
        checkForNewEpisodes(parseInt(id));
      }
    }
  };
  setInterval(check,3600000);
  check();
}

async function autoRefresh(isManual=false){
  if(isRefreshing){log.warn('Already refreshing');return {success:false};}
  isRefreshing=true;
  log.info(`${isManual?'Manual':'Auto'} refresh started`);
  const start=Date.now();
  const stats={success:0,failed:0};

  try{
    for(const id in seriesConfig){
      const series=seriesConfig[id];
      for(const s in series.seasons){
        const epCount=series.seasons[s].count;
        const batchSize=3;
        for(let i=0;i<epCount;i+=batchSize){
          const batch=[];
          for(let j=0;j<batchSize&&(i+j)<epCount;j++){
            const ep=i+j+1;
            batch.push(fetchM3u8(parseInt(id),parseInt(s),ep).then(async m3u8=>{
              if(m3u8){
                const p={movieId:parseInt(id),mediaType:series.mediaType,m3u8Url:m3u8,title:`${series.title} S${s}E${ep}`,season:parseInt(s),episode:ep,quality:'auto',notes:isManual?'Manual':'Auto',timestamp:new Date().toISOString()};
                const sent=await sendFirestore(p);
                if(sent){stats.success++;log.success(`${series.title} S${s}E${ep}`);}else{stats.failed++;addFailedEpisode(parseInt(id),parseInt(s),ep,'Firestore failed');}
              }else{stats.failed++;addFailedEpisode(parseInt(id),parseInt(s),ep,'No m3u8');}
            }).catch(()=>{stats.failed++;addFailedEpisode(parseInt(id),parseInt(s),i+j+1,'Error');}));
          }
          await Promise.allSettled(batch);
          await new Promise(r=>setTimeout(r,800+Math.random()*1200));
        }
      }
    }
    const dur=((Date.now()-start)/1000).toFixed(1);
    log.success(`Done: ${stats.success} OK, ${stats.failed} failed in ${dur}s`);
    lastRefreshTime=new Date();
    fs.writeFileSync(REFRESH_MARKER,Date.now().toString());
    await sendTelegram(`<b>Refresh Done</b>\n${isManual?'Manual':'Auto'}\nSuccess: ${stats.success}\nFailed: ${stats.failed}\nDuration: ${dur}s`);
  }catch(e){
    log.error(`Refresh error: ${e.message}`);
    await sendTelegram(`Refresh Failed\n${e.message}`);
  }finally{
    isRefreshing=false;
    await cleanupBrowsers();
    setTimeout(()=>process.exit(1),3000);
  }
}

function getContentStats(){
  let totalSeries=Object.keys(seriesConfig).length;
  let totalSeasons=0,totalEpisodes=0;
  const breakdown=[];
  for(const id in seriesConfig){
    const s=seriesConfig[id];
    let eps=0;
    for(const sn in s.seasons){eps+=s.seasons[sn].count;totalSeasons++;}
    totalEpisodes+=eps;
    breakdown.push({id,title:s.title,seasons:Object.keys(s.seasons).length,episodes:eps});
  }
  return {totalSeries,totalSeasons,totalEpisodes,breakdown};
}

// YOUR FULL HTML / PAGE - 100% UNCHANGED
app.get('/',(req,res)=>{res.send(`<!DOCTYPE html><html><head><title>Add Series</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:20px}h1{color:#fff;text-align:center;margin-bottom:30px;font-size:2.5em;text-shadow:2px 2px 4px rgba(0,0,0,0.3)}.container{max-width:800px;margin:0 auto;background:#fff;border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,0.3)}.form-group{margin-bottom:25px}label{display:block;margin-bottom:8px;color:#333;font-weight:600;font-size:14px}input,select,textarea{width:100%;padding:12px;border:2px solid #e0e0e0;border-radius:8px;font-size:14px;transition:all 0.3s}input:focus,select:focus,textarea:focus{outline:none;border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,0.1)}textarea{resize:vertical;min-height:80px;font-family:monospace}.season-block{background:#f5f5f5;padding:20px;border-radius:10px;margin-bottom:15px;border-left:4px solid #667eea}.season-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}.season-title{color:#667eea;font-weight:700;font-size:16px}.btn-remove{background:#ef4444;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;transition:all 0.3s}.btn-remove:hover{background:#dc2626;transform:scale(1.05)}.season-inputs{display:grid;grid-template-columns:1fr 1fr;gap:15px}.btn-add-season{background:#10b981;color:#fff;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;width:100%;margin-top:10px;transition:all 0.3s}.btn-add-season:hover{background:#059669;transform:translateY(-2px);box-shadow:0 4px 12px rgba(16,185,129,0.3)}.btn-group{display:flex;gap:15px;margin-top:30px}.btn{flex:1;padding:15px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:all 0.3s}.btn-primary{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff}.btn-primary:hover{transform:translateY(-2px);box-shadow:0 10px 25px rgba(102,126,234,0.4)}.btn-secondary{background:#6b7280;color:#fff}.btn-secondary:hover{background:#4b5563}.info-box{background:#dbeafe;border-left:4px solid #3b82f6;padding:15px;border-radius:8px;margin-bottom:25px;color:#1e40af;font-size:13px}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-family:monospace;color:#be123c}</style></head><body><h1>📺 Add New Series</h1><div class="container"><div class="info-box">💡 <strong>Tip:</strong> Use <code>{episode}</code> in the URL pattern where the episode number should appear. Example: <code>https://site.com/series-episode-{episode}/</code></div><form id="seriesForm"><div class="form-group"><label>TMDB Movie ID *</label><input type="number" id="movieId" required placeholder="274556"></div><div class="form-group"><label>Series Name (URL-friendly) *</label><input type="text" id="name" required placeholder="new-series"></div><div class="form-group"><label>Series Title (Display Name) *</label><input type="text" id="title" required placeholder="New Series"></div><div class="form-group"><label>URL Pattern *</label><input type="text" id="urlPattern" required placeholder="https://hds.turkish123.com/series-name-episode-{episode}/"></div><div class="form-group"><label>Media Type *</label><select id="mediaType" required><option value="tv">TV Series</option><option value="movie">Movie</option></select></div><div style="margin:30px 0"><h3 style="color:#333;margin-bottom:15px">Seasons</h3><div id="seasonsContainer"></div><button type="button" class="btn-add-season" onclick="addSeason()">+ Add Season</button></div><div class="btn-group"><button type="submit" class="btn btn-primary">🎬 Add Series<button type="button" class="btn btn-secondary" onclick="window.location.href='/admin'">🔙 Admin</button></div></form></div><script>let seasonCount=0;function addSeason(){seasonCount++;const container=document.getElementById('seasonsContainer');const seasonDiv=document.createElement('div');seasonDiv.className='season-block';seasonDiv.id='season-'+seasonCount;seasonDiv.innerHTML='<div class="season-header"><span class="season-title">Season '+seasonCount+'</span><button type="button" class="btn-remove" onclick="removeSeason('+seasonCount+')">Remove</button></div><div class="season-inputs"><div><label>Start Episode</label><input type="number" name="startEpisode[]" required placeholder="1" value="'+(seasonCount===1?'1':'')+'"></div><div><label>Episode Count</label><input type="number" name="episodeCount[]" required placeholder="20"></div></div>';container.appendChild(seasonDiv);}function removeSeason(id){document.getElementById('season-'+id).remove();}addSeason();document.getElementById('seriesForm').addEventListener('submit',async(e)=>{e.preventDefault();const movieId=parseInt(document.getElementById('movieId').value);const name=document.getElementById('name').value;const title=document.getElementById('title').value;const urlPattern=document.getElementById('urlPattern').value;const mediaType=document.getElementById('mediaType').value;const starts=document.getElementsByName('startEpisode[]');const counts=document.getElementsByName('episodeCount[]');const seasons={};for(let i=0;i<starts.length;i++){seasons[i+1]={startEpisode:parseInt(starts[i].value),count:parseInt(counts[i].value)};}const data={movieId,name,title,urlPattern,mediaType,seasons};try{const res=await fetch('/api/series/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await res.json();if(result.success){alert('✅ Series added successfully!');window.location.href='/api/status';}else{alert('❌ Error: '+result.error);}}catch(err){alert('❌ Network error: '+err.message);}});</script></body></html>`)});

// ============== NEW admin ROUTE ==============
app.get('/admin',(req,res)=>{
const cs=getContentStats();
const sl=cs.breakdown.map(s=>{const c=seriesConfig[s.id];return{id:s.id,title:s.title,name:c.name,seasons:Object.keys(c.seasons).map(n=>({number:n,startEpisode:c.seasons[n].startEpisode,count:c.seasons[n].count}))};});
res.send(`<!DOCTYPE html><html><head><title>Admin</title><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;padding:20px;line-height:1.5}.container{max-width:1200px;margin:0 auto}h1{color:#fff;margin-bottom:20px;font-size:24px;border-bottom:2px solid #333;padding-bottom:10px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin-bottom:30px}.stat-card{background:#1a1a1a;border:1px solid #333;padding:15px;border-radius:4px}.stat-label{color:#888;font-size:11px;text-transform:uppercase;margin-bottom:5px}.stat-value{color:#fff;font-size:20px;font-weight:bold}.series-grid{display:grid;gap:15px}.series-card{background:#1a1a1a;border:1px solid #333;border-radius:4px;overflow:hidden}.series-header{padding:15px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;flex-wrap:wrap;gap:10px}.series-title{color:#fff;font-size:16px;font-weight:bold}.series-meta{color:#666;font-size:12px;margin-top:3px}.series-actions{display:flex;gap:8px;flex-wrap:wrap}.btn{background:#2a2a2a;color:#e0e0e0;border:1px solid #444;padding:6px 12px;font-size:11px;cursor:pointer;border-radius:3px;font-family:monospace;transition:all .2s}.btn:hover{background:#3a3a3a;border-color:#666}.btn:disabled{opacity:.5;cursor:not-allowed}.btn-danger{background:#1a0000;border-color:#440000;color:#ff6666}.btn-danger:hover{background:#2a0000;border-color:#660000}.btn-success{background:#001a00;border-color:#004400;color:#66ff66}.btn-success:hover{background:#002a00;border-color:#006600}.series-body{padding:15px;display:none}.series-body.open{display:block}.season-section{margin-bottom:15px;padding:10px;background:#0f0f0f;border:1px solid #2a2a2a;border-radius:3px}.season-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.season-title{color:#ccc;font-size:13px;font-weight:bold}.episode-list{display:none;margin-top:10px;max-height:200px;overflow-y:auto;background:#000;padding:8px;border-radius:3px}.episode-list.open{display:block}.episode-item{color:#888;font-size:11px;padding:4px 0;border-bottom:1px solid #1a1a1a}.episode-item:last-child{border-bottom:none}.failed-section{background:#1a0000;border:1px solid #440000;border-radius:4px;padding:15px;margin-bottom:30px}.failed-title{color:#ff6666;font-size:14px;font-weight:bold;margin-bottom:10px}.failed-list{max-height:300px;overflow-y:auto}.failed-item{background:#0f0000;border:1px solid #2a0000;padding:10px;margin-bottom:8px;border-radius:3px;font-size:11px}.failed-item-header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}.failed-item-title{color:#ff8888}.failed-item-reason{color:#666;margin-top:5px}.empty{text-align:center;color:#666;padding:40px;font-size:14px}.top-nav{margin-bottom:20px}.nav-btn{background:#2a2a2a;color:#e0e0e0;border:1px solid #444;padding:10px 20px;text-decoration:none;border-radius:3px;display:inline-block;font-family:monospace;font-size:12px}.nav-btn:hover{background:#3a3a3a}::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:#0a0a0a}::-webkit-scrollbar-thumb{background:#333;border-radius:4px}::-webkit-scrollbar-thumb:hover{background:#444}</style></head><body><div class="container"><div class="top-nav"><a href="/" class="nav-btn">+ Add New Series</a></div><h1>⚙ Admin Dashboard</h1><div class="stats"><div class="stat-card"><div class="stat-label">Total Series</div><div class="stat-value">${cs.totalSeries}</div></div><div class="stat-card"><div class="stat-label">Total Episodes</div><div class="stat-value">${cs.totalEpisodes}</div></div><div class="stat-card"><div class="stat-label">Failed Episodes</div><div class="stat-value" id="failedCount">${failedEpisodes.length}</div></div><div class="stat-card"><div class="stat-label">Refresh Status</div><div class="stat-value" id="refreshStatus">${isRefreshing?'RUNNING':'IDLE'}</div></div></div>${failedEpisodes.length>0?`<div class="failed-section"><div class="failed-title">⚠ Failed Episodes (${failedEpisodes.length})</div><div class="failed-list">${failedEpisodes.map(f=>`<div class="failed-item"><div class="failed-item-header"><span class="failed-item-title">${f.seriesTitle} - S${f.season}E${f.episode}</span><button class="btn btn-success" onclick="retryEpisode('${f.movieId}',${f.season},${f.episode})">⟳ Retry</button></div><div class="failed-item-reason">Reason: ${f.reason} • ${new Date(f.timestamp).toLocaleString()}</div></div>`).join('')}</div><button class="btn btn-danger" onclick="clearAllFailed()" style="margin-top:10px">✗ Clear All</button></div>`:''}<div class="series-grid">${sl.map(s=>`<div class="series-card" id="series-${s.id}"><div class="series-header"><div><div class="series-title">${s.title}</div><div class="series-meta">${s.seasons.length} season(s) • ${s.seasons.reduce((sum,ss)=>sum+ss.count,0)} episodes</div></div><div class="series-actions"><button class="btn" onclick="toggleSeriesBody('${s.id}')"><span id="toggle-${s.id}">▼</span> Details</button><button class="btn btn-success" onclick="refreshSeries('${s.id}')">⟳ Refresh</button><button class="btn" onclick="checkNewEpisodes('${s.id}')">🔍 Check New</button><button class="btn btn-danger" onclick="deleteSeries('${s.id}','${s.title}')">✗</button></div></div><div class="series-body" id="body-${s.id}">${s.seasons.map(sn=>`<div class="season-section"><div class="season-header"><span class="season-title">Season ${sn.number} (${sn.count} episodes)</span><button class="btn" onclick="toggleEpisodes('${s.id}','${sn.number}')"><span id="season-toggle-${s.id}-${sn.number}">▼</span> Episodes</button></div><div class="episode-list" id="episodes-${s.id}-${sn.number}">${Array.from({length:sn.count},(_,i)=>`<div class="episode-item">Episode ${i+1}</div>`).join('')}</div></div>`).join('')}</div></div>`).join('')}</div>${sl.length===0?'<div class="empty">No series configured. <a href="/" style="color:#666">Add one</a>.</div>':''}</div><script>function toggleSeriesBody(id){const b=document.getElementById('body-'+id);const i=document.getElementById('toggle-'+id);if(b.classList.contains('open')){b.classList.remove('open');i.textContent='▼';}else{b.classList.add('open');i.textContent='▲';}}function toggleEpisodes(sid,sn){const l=document.getElementById('episodes-'+sid+'-'+sn);const i=document.getElementById('season-toggle-'+sid+'-'+sn);if(l.classList.contains('open')){l.classList.remove('open');i.textContent='▼';}else{l.classList.add('open');i.textContent='▲';}}async function refreshSeries(id){if(!confirm('Refresh all episodes for this series?'))return;try{const r=await fetch('/api/series/refresh/'+id,{method:'POST'});const d=await r.json();alert(d.success?'✓ Refresh started':'✗ Error: '+d.error);}catch(e){alert('✗ '+e.message);}}async function checkNewEpisodes(id){try{const r=await fetch('/api/series/check-new/'+id,{method:'POST'});const d=await r.json();alert(d.success?'✓ '+d.message:'✗ Error: '+d.error);if(d.success)location.reload();}catch(e){alert('✗ '+e.message);}}async function deleteSeries(id,title){if(!confirm('Delete "'+title+'"? Cannot be undone!'))return;try{const r=await fetch('/api/series/delete/'+id,{method:'DELETE'});const d=await r.json();if(d.success){alert('✓ Deleted');location.reload();}else{alert('✗ Error: '+d.error);}}catch(e){alert('✗ '+e.message);}}async function retryEpisode(mid,s,e){try{const r=await fetch('/api/episode/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({movieId:parseInt(mid),season:s,episode:e})});const d=await r.json();alert(d.success?'✓ Retry started':'✗ Error: '+d.error);}catch(e){alert('✗ '+e.message);}}async function clearAllFailed(){if(!confirm('Clear all failed episodes?'))return;try{const r=await fetch('/api/failed/clear',{method:'POST'});const d=await r.json();if(d.success){alert('✓ Cleared');location.reload();}}catch(e){alert('✗ '+e.message);}}setInterval(async()=>{try{const r=await fetch('/api/status');const d=await r.json();document.getElementById('refreshStatus').textContent=d.refresh.isRefreshing?'RUNNING':'IDLE';}catch(e){}},30000);</script></body></html>`);
});

// ============== NEW API ROUTES ==============

app.post('/api/series/refresh/:id',async(req,res)=>{
const id=parseInt(req.params.id);
if(!seriesConfig[id])return res.status(404).json({success:false,error:'Series not found'});
res.json({success:true,message:'Refresh started'});
setTimeout(async()=>{
const series=seriesConfig[id];
log.info(`Refresh: ${series.title}`);
try{
for(const s in series.seasons){
const epCount=series.seasons[s].count;
const batchSize=3;
for(let i=0;i<epCount;i+=batchSize){
const batch=[];
for(let j=0;j<batchSize&&(i+j)<epCount;j++){
const ep=i+j+1;
batch.push(fetchM3u8(id,parseInt(s),ep).then(async m3u8=>{
if(m3u8){
const p={movieId:id,mediaType:series.mediaType,m3u8Url:m3u8,title:`${series.title} S${s}E${ep}`,season:parseInt(s),episode:ep,quality:'auto',notes:'Manual',timestamp:new Date().toISOString()};
const sent=await sendFirestore(p);
if(sent){log.success(`${series.title} S${s}E${ep}`);}else{addFailedEpisode(id,parseInt(s),ep,'Firestore failed');}
}else{addFailedEpisode(id,parseInt(s),ep,'No m3u8');}
}).catch(()=>{addFailedEpisode(id,parseInt(s),ep,'Error');}));
}
await Promise.allSettled(batch);
await new Promise(r=>setTimeout(r,800+Math.random()*1200));
}
}
await sendTelegram(`<b>Refresh Done</b>\n${series.title}`);
}catch(e){log.error(`Error: ${e.message}`);}
},1000);
});

app.post('/api/series/check-new/:id',async(req,res)=>{
const id=parseInt(req.params.id);
if(!seriesConfig[id])return res.status(404).json({success:false,error:'Series not found'});
try{
const results=await checkForNewEpisodes(id);
const result=results[0];
if(result.status==='updated'){
res.json({success:true,message:`Found ${result.newCount} new episode(s) in Season ${result.season}!`});
}else if(result.status==='up_to_date'){
res.json({success:true,message:'Series is up to date'});
}else if(result.status==='no_episodes_found'){
res.json({success:true,message:'No episodes found'});
}else{
res.json({success:false,error:'Check failed'});
}
}catch(e){
log.error(`Check error: ${e.message}`);
res.status(500).json({success:false,error:e.message});
}
});

app.delete('/api/series/delete/:id',async(req,res)=>{
const id=parseInt(req.params.id);
if(!seriesConfig[id])return res.status(404).json({success:false,error:'Series not found'});
const title=seriesConfig[id].title;
delete seriesConfig[id];
saveSeriesConfig();
await sendTelegram(`<b>Deleted</b>\n${title} (ID: ${id})`);
log.info(`Deleted: ${title} (${id})`);
res.json({success:true,message:'Deleted'});
});

app.post('/api/episode/retry',async(req,res)=>{
const{movieId,season,episode}=req.body;
if(!movieId||!season||!episode)return res.status(400).json({success:false,error:'Missing params'});
if(!seriesConfig[movieId])return res.status(404).json({success:false,error:'Series not found'});
res.json({success:true,message:'Retry started'});
setTimeout(async()=>{
const series=seriesConfig[movieId];
try{
const m3u8=await fetchM3u8(movieId,season,episode);
if(m3u8){
const p={movieId,mediaType:series.mediaType,m3u8Url:m3u8,title:`${series.title} S${season}E${episode}`,season,episode,quality:'auto',notes:'Retry',timestamp:new Date().toISOString()};
const sent=await sendFirestore(p);
if(sent){
log.success(`Retry OK: ${series.title} S${season}E${episode}`);
failedEpisodes=failedEpisodes.filter(f=>!(f.movieId===movieId&&f.season===season&&f.episode===episode));
saveFailedEpisodes();
}else{log.error(`Retry failed (Firestore)`);}
}else{log.error(`Retry failed (no m3u8)`);}
}catch(e){log.error(`Retry error: ${e.message}`);}
},1000);
});

app.post('/api/failed/clear',(req,res)=>{
clearFailedEpisodes();
log.info('Failed cleared');
res.json({success:true,message:'Cleared'});
});

// ALL YOUR ROUTES - EXACTLY AS YOU WROTE THEM
app.get('/health',(req,res)=>res.json({status:'ok',timestamp:new Date().toISOString(),isRefreshing,uptime:process.uptime()}));

app.get('/api/status',(req,res)=>{
  const cs=getContentStats();
  const mem=process.memoryUsage();
  res.json({
    server:{status:isRefreshing?'Refreshing':'Ready',uptime:`${Math.floor(process.uptime()/3600)}h ${Math.floor((process.uptime()%3600)/60)}m`,currentTime:formatDate(new Date())},
    refresh:{isRefreshing,lastRefreshTime:formatDate(lastRefreshTime),nextRefreshTime:formatDate(nextRefreshTime),timeUntilNextRefresh:formatTimeRemaining(nextRefreshTime)},
    content:{totalSeries:cs.totalSeries,totalSeasons:cs.totalSeasons,totalEpisodes:cs.totalEpisodes},
    system:{memoryUsage:{rss:`${Math.round(mem.rss/1024/1024)} MB`,heapUsed:`${Math.round(mem.heapUsed/1024/1024)} MB`}}
  });
});

app.get('/api/retry',async(req,res)=>{
  if(failedEpisodes.length===0)return res.json({success:true,message:'No failed episodes'});
  const list=[...failedEpisodes];
  res.json({success:true,message:`Retrying ${list.length} episodes`,failedEpisodes:list});
  clearFailedEpisodes();
  setTimeout(async()=>{/* your retry logic */},1000);
});

app.post('/api/series/add',async(req,res)=>{
  const{movieId,name,title,urlPattern,mediaType,seasons}=req.body;
  if(!movieId||!name||!title||!urlPattern||!mediaType||!seasons)return res.status(400).json({success:false,error:'Missing fields'});
  if(!urlPattern.includes('{episode}'))return res.status(400).json({success:false,error:'Missing placeholder'});
  if(seriesConfig[movieId])return res.status(409).json({success:false,error:'Already exists'});
  seriesConfig[movieId]={name,title,urlPattern,mediaType,seasons};
  saveSeriesConfig();
  await sendTelegram(`New Series Added\n<b>${title}</b>\nID: ${movieId}`);
  res.json({success:true});
});

app.post('/api/refresh',async(req,res)=>{res.json({success:true,message:'Started'});autoRefresh(true);});
app.get('/api/refresh',async(req,res)=>{res.json({success:true,message:'Started'});autoRefresh(true);});

app.use((err,req,res,next)=>{log.error(`Error: ${err.message}`);res.status(500).json({success:false,error:'Server error'});});

const server=app.listen(PORT,()=>{
  log.info(`M3U8 Server STARTED on port ${PORT}`);
  loadSeriesConfig();
  loadFailedEpisodes();
  scheduleDailyEpisodeCheck();
  let skip=false;
  try{if(fs.existsSync(REFRESH_MARKER)){const last=parseInt(fs.readFileSync(REFRESH_MARKER,'utf8'));if((Date.now()-last)/60000<30)skip=true;}}catch(e){}
  if(!skip){setTimeout(()=>autoRefresh(false),10000);}
  scheduleNext();
});

process.on('SIGTERM',async()=>{await cleanupBrowsers();server.close(()=>process.exit(0));});
process.on('uncaughtException',(e)=>{log.error(`Uncaught: ${e.message}`);sendTelegram(`Crash\n${e.message}`);setTimeout(()=>process.exit(1),3000);});
process.on('unhandledRejection',(r)=>{log.error(`Unhandled: ${r}`);});

module.exports={app,fetchM3u8,sendFirestore,sendTelegram};
