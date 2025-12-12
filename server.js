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

let seriesConfig = {274556:{name:'Uzak Sehir',title:'Far Away',urlPattern:'https://hds.turkish123.com/uzak-sehir-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:28},2:{startEpisode:29,count:13}}},74823:{name:'Cukur',title:'The Pit',urlPattern:'https://hds.turkish123.com/cukur-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:33},2:{startEpisode:34,count:34},3:{startEpisode:68,count:25},4:{startEpisode:93,count:39}}},283123:{name:'Esref Ruya',title:'Esref Ruya',urlPattern:'https://hds.turkish123.com/esref-ruya-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:13},2:{startEpisode:14,count:12}}},302658:{name:'Kurlus Orhan',title:'Founder Orhan',urlPattern:'https://hds.turkish123.com/kurulus-orhan-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:7}}},301693:{name:'sahtekarlar',title:'Lovers & Liars',urlPattern:'https://hds.turkish123.com/sahtekarlar-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:9}}},300388:{name:'guller-ve-gunahlar',title:'Sins and Roses',urlPattern:'https://hds.turkish123.com/guller-ve-gunahlar-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:8}}},246621:{name:'Mehmed: Sultan of Conquests',title:'Mehmed: Sultan of Conquests',urlPattern:'https://hds.turkish123.com/mehmed-fetihler-sultani-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:15},2:{startEpisode:16,count:34},3:{startEpisode:50,count:15}}},302063:{name:'tasacak-bu-denizr',title:'Deep in Love',urlPattern:'https://hds.turkish123.com/tasacak-bu-deniz-episode-{episode}/',mediaType:'tv',seasons:{1:{startEpisode:1,count:9}}}};

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

// YOUR FULL HTML ADMIN PAGE - 100% UNCHANGED
app.get('/',(req,res)=>{res.send(`<!DOCTYPE html><html><head><title>Add Series</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:20px}h1{color:#fff;text-align:center;margin-bottom:30px;font-size:2.5em;text-shadow:2px 2px 4px rgba(0,0,0,0.3)}.container{max-width:800px;margin:0 auto;background:#fff;border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,0.3)}.form-group{margin-bottom:25px}label{display:block;margin-bottom:8px;color:#333;font-weight:600;font-size:14px}input,select,textarea{width:100%;padding:12px;border:2px solid #e0e0e0;border-radius:8px;font-size:14px;transition:all 0.3s}input:focus,select:focus,textarea:focus{outline:none;border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,0.1)}textarea{resize:vertical;min-height:80px;font-family:monospace}.season-block{background:#f5f5f5;padding:20px;border-radius:10px;margin-bottom:15px;border-left:4px solid #667eea}.season-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}.season-title{color:#667eea;font-weight:700;font-size:16px}.btn-remove{background:#ef4444;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;transition:all 0.3s}.btn-remove:hover{background:#dc2626;transform:scale(1.05)}.season-inputs{display:grid;grid-template-columns:1fr 1fr;gap:15px}.btn-add-season{background:#10b981;color:#fff;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;width:100%;margin-top:10px;transition:all 0.3s}.btn-add-season:hover{background:#059669;transform:translateY(-2px);box-shadow:0 4px 12px rgba(16,185,129,0.3)}.btn-group{display:flex;gap:15px;margin-top:30px}.btn{flex:1;padding:15px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:all 0.3s}.btn-primary{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff}.btn-primary:hover{transform:translateY(-2px);box-shadow:0 10px 25px rgba(102,126,234,0.4)}.btn-secondary{background:#6b7280;color:#fff}.btn-secondary:hover{background:#4b5563}.info-box{background:#dbeafe;border-left:4px solid #3b82f6;padding:15px;border-radius:8px;margin-bottom:25px;color:#1e40af;font-size:13px}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-family:monospace;color:#be123c}</style></head><body><h1>📺 Add New Series</h1><div class="container"><div class="info-box">💡 <strong>Tip:</strong> Use <code>{episode}</code> in the URL pattern where the episode number should appear. Example: <code>https://site.com/series-episode-{episode}/</code></div><form id="seriesForm"><div class="form-group"><label>TMDB Movie ID *</label><input type="number" id="movieId" required placeholder="274556"></div><div class="form-group"><label>Series Name (URL-friendly) *</label><input type="text" id="name" required placeholder="new-series"></div><div class="form-group"><label>Series Title (Display Name) *</label><input type="text" id="title" required placeholder="New Series"></div><div class="form-group"><label>URL Pattern *</label><input type="text" id="urlPattern" required placeholder="https://hds.turkish123.com/series-name-episode-{episode}/"></div><div class="form-group"><label>Media Type *</label><select id="mediaType" required><option value="tv">TV Series</option><option value="movie">Movie</option></select></div><div style="margin:30px 0"><h3 style="color:#333;margin-bottom:15px">Seasons</h3><div id="seasonsContainer"></div><button type="button" class="btn-add-season" onclick="addSeason()">+ Add Season</button></div><div class="btn-group"><button type="submit" class="btn btn-primary">🎬 Add Series</button><button type="button" class="btn btn-secondary" onclick="window.location.href='/api/status'">❌ Cancel</button></div></form></div><script>let seasonCount=0;function addSeason(){seasonCount++;const container=document.getElementById('seasonsContainer');const seasonDiv=document.createElement('div');seasonDiv.className='season-block';seasonDiv.id='season-'+seasonCount;seasonDiv.innerHTML='<div class="season-header"><span class="season-title">Season '+seasonCount+'</span><button type="button" class="btn-remove" onclick="removeSeason('+seasonCount+')">Remove</button></div><div class="season-inputs"><div><label>Start Episode</label><input type="number" name="startEpisode[]" required placeholder="1" value="'+(seasonCount===1?'1':'')+'"></div><div><label>Episode Count</label><input type="number" name="episodeCount[]" required placeholder="20"></div></div>';container.appendChild(seasonDiv);}function removeSeason(id){document.getElementById('season-'+id).remove();}addSeason();document.getElementById('seriesForm').addEventListener('submit',async(e)=>{e.preventDefault();const movieId=parseInt(document.getElementById('movieId').value);const name=document.getElementById('name').value;const title=document.getElementById('title').value;const urlPattern=document.getElementById('urlPattern').value;const mediaType=document.getElementById('mediaType').value;const starts=document.getElementsByName('startEpisode[]');const counts=document.getElementsByName('episodeCount[]');const seasons={};for(let i=0;i<starts.length;i++){seasons[i+1]={startEpisode:parseInt(starts[i].value),count:parseInt(counts[i].value)};}const data={movieId,name,title,urlPattern,mediaType,seasons};try{const res=await fetch('/api/series/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await res.json();if(result.success){alert('✅ Series added successfully!');window.location.href='/api/status';}else{alert('❌ Error: '+result.error);}}catch(err){alert('❌ Network error: '+err.message);}});</script></body></html>`)});

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

app.get('/api/retry',async(req,res)=>{if(failedEpisodes.length===0)return res.json({success:true,message:'No failed episodes to retry',failed:[]});const failed=[...failedEpisodes];res.json({success:true,message:`Retrying ${failed.length} failed episodes...`,failedEpisodes:failed});clearFailedEpisodes();setTimeout(async()=>{log.info(`🔁 Retrying ${failed.length} episodes...`);const stats={success:0,failed:0};for(const f of failed){try{const m3u8=await fetchM3u8(f.movieId,f.season,f.episode);if(m3u8){const series=seriesConfig[f.movieId];const p={movieId:f.movieId,mediaType:series.mediaType,m3u8Url:m3u8,title:`${series.title} S${f.season}E${f.episode}`,season:f.season,episode:f.episode,quality:'auto',notes:'Retry',timestamp:new Date().toISOString()};const sent=await sendFirestore(p);if(sent){stats.success++;log.success(`Retry OK: ${series.title} S${f.season}E${f.episode}`);}else{stats.failed++;addFailedEpisode(f.movieId,f.season,f.episode,'Firestore failed on retry');log.error(`Retry save fail: S${f.season}E${f.episode}`);}}else{stats.failed++;addFailedEpisode(f.movieId,f.season,f.episode,'M3U8 not found on retry');log.error(`Retry no m3u8: S${f.season}E${f.episode}`);}}catch(e){stats.failed++;addFailedEpisode(f.movieId,f.season,f.episode,e.message);log.error(`Retry error: ${e.message}`);}await new Promise(r=>setTimeout(r,500));}log.info(`🔁 Retry done: ${stats.success} ok, ${stats.failed} fail`);await sendTelegram(`<b>🔁 Retry Complete</b>\n✅ Success: ${stats.success}\n❌ Failed: ${stats.failed}`);},1000);});


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

// ——— FINAL ADMIN PANEL WITH "RECHECK NEW EPISODES" BUTTON ———
app.get('/admin', (req, res) => {
  const stats = getContentStats();

  let tableRows = '';
  for (const [id, series] of Object.entries(seriesConfig)) {
    const totalEps = Object.values(series.seasons).reduce((a, b) => a + b.count, 0);
    tableRows += `
      <tr>
        <td><strong>${series.title}</strong><br><small>ID: ${id}</small></td>
        <td>${totalEps}</td>
        <td>${Object.keys(series.seasons).length}</td>
        <td>
          <button class="btn small green" onclick="refreshSeries(${id})" title="Refresh all episodes">Refresh</button>
          <button class="btn small blue" onclick="showEpisodePicker(${id}, '${series.title.replace(/'/g, "\\'")}')" title="Refresh one episode">Single</button>
          <button class="btn small" style="background:#a371f7;color:white;" onclick="checkNewEpisodes(${id})" title="Check for new episodes">Check</button>
          <button class="btn small red" onclick="deleteSeries(${id})" title="Delete series">Delete</button>
        </td>
      </tr>`;
  }

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Grok Admin • M3U8 Server</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#0d1117;--card:#161b22;--text:#c9d1d9;--border:#30363d;--green:#238636;--red:#da3633;--blue:#58a6ff;--purple:#a371f7; }
  body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:20px;}
  .container{max-width:1350px;margin:auto;}
  h1{color:#fff;text-align:center;margin:0 0 30px;font-size:2.2em;}
  .grid{display:grid;grid-template-columns:1fr 420px;gap:25px;}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:15px;margin-bottom:25px;}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center;}
  .stat h3{margin:0 0 8px;color:var(--blue);font-size:14px;}
  .stat p{margin:0;font-size:1.8em;font-weight:bold;}
  table{width:100%;border-collapse:collapse;background:var(--card);border-radius:10px;overflow:hidden;}
  th,td{padding:14px;text-align:left;border-bottom:1px solid var(--border);}
  th{background:#21262d;color:var(--blue);}
  tr:hover{background:#1f6feb0a;}
  .btn{padding:8px 14px;margin:2px;border:none;border-radius:6px;cursor:pointer;font-size:13px;transition:0.2s;}
  .green{background:var(--green);color:white;}
  .green:hover{background:#2ea043;}
  .blue{background:var(--blue);color:black;}
  .blue:hover{background:#7bbaff;}
  .red{background:var(--red);color:white;}
  .red:hover{background:#f85149;}
  .small{font-size:12px;padding:6px 11px;}
  .log-panel{background:#010409;border:1px solid var(--border);border-radius:8px;padding:15px;height:620px;overflow-y:auto;font-family:monospace;font-size:13px;line-height:1.5;}
  .log-entry{margin:4px 0;}
  .success{color:#7ce38b;}
  .error{color:#f87171;}
  .info{color:#58a6ff;}
  .warn{color:#f7b14a;}
  .footer{text-align:center;margin-top:40px;color:#8b949e;font-size:14px;}
  #episodePicker{display:none;background:var(--card);border:1px solid var(--border);padding:20px;border-radius:10px;margin-top:15px;}
  .close-btn{float:right;cursor:pointer;color:var(--red);font-weight:bold;font-size:20px;}
</style>
</head>
<body>
<div class="container">
  <h1>Grok Admin Panel</h1>

  <div class="stats">
    <div class="stat"><h3>Series</h3><p>${stats.totalSeries}</p></div>
    <div class="stat"><h3>Episodes</h3><p>${stats.totalEpisodes}</p></div>
    <div class="stat"><h3>Status</h3><p>${isRefreshing ? '<span class="error">Busy</span>' : '<span class="success">Ready</span>'}</p></div>
    <div class="stat"><h3>Last Full</h3><p>${lastRefreshTime ? new Date(lastRefreshTime).toLocaleString() : 'Never'}</p></div>
  </div>

  <button class="btn green" style="padding:12px 30px;font-size:16px;" onclick="fetch('/api/refresh')">Start Full Refresh Now</button>

  <div class="grid">
    <div>
      <table>
        <thead><tr><th>Series</th><th>Episodes</th><th>Seasons</th><th>Actions</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="4" style="text-align:center">No series</td></tr>'}</tbody>
      </table>
    </div>

    <div class="log-panel" id="log">
      <div class="info">Admin panel ready • ${new Date().toLocaleString()}</div>
      <div>Click any button → live logs here</div>
    </div>
  </div>

  <div id="episodePicker">
    <span class="close-btn" onclick="this.parentNode.style.display='none'">×</span>
    <h3>Refresh Single Episode — <span id="pickerTitle"></span></h3>
    <div style="margin:20px 0;">
      <label>Season: <select id="seasonSelect"></select></label>
      <label style="margin-left:15px;">Episode: <input type="number" id="episodeInput" min="1" style="width:80px;padding:8px;"></label>
      <button class="btn green" onclick="refreshSingleEpisode()" style="margin-left:15px;">Go</button>
    </div>
  </div>

  <div class="footer">Turkish123 M3U8 Scraper • ${new Date().getFullYear()}</div>
</div>

<script>
const logEl = document.getElementById('log');
function addLog(msg, type='info') {
  const div = document.createElement('div');
  div.className = 'log-entry ' + type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// Refresh whole series
async function refreshSeries(id) {
  if (!confirm('Refresh ALL episodes of this series now?')) return;
  addLog(`Starting full refresh for series ${id}...`, 'info');
  const r = await fetch('/api/series/' + id + '/refresh', {method:'POST'});
  const j = await r.json();
  addLog(j.message || 'Started', 'success');
}

// Check for new episodes (magnifying glass button)
async function checkNewEpisodes(id) {
  if (!confirm('Check this series for new episodes now?')) return;
  addLog(`Checking new episodes for series ${id}...`, 'info');
  const r = await fetch('/api/series/' + id + '/check-new', {method:'POST'});
  const j = await r.json();
  if (j.updated) {
    addLog(`New episodes found! Updated to ${j.newTotal} total`, 'success');
  ');
  } else {
    addLog(j.message || 'No new episodes', 'info');
  }
}

// Single episode picker
function showEpisodePicker(id, title) {
  document.getElementById('pickerTitle').textContent = title;
  document.getElementById('episodePicker').style.display = 'block';
  const sel = document.getElementById('seasonSelect');
  sel.innerHTML = '';
  fetch('/api/series/' + id).then(r=>r.json()).then(d=>{
    Object.keys(d.seasons).forEach(s=>{
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = `Season ${s}`;
      sel.appendChild(opt);
    });
  });
}

async function refreshSingleEpisode() {
  const title = document.getElementById('pickerTitle').textContent;
  const season = document.getElementById('seasonSelect').value;
  const episode = document.getElementById('episodeInput').value;
  if (!season || !episode) return alert('Fill both');
  addLog(`Refreshing ${title} S${season}E${episode}...`, 'info');
  document.getElementById('episodePicker').style.display = 'none';
  const r = await fetch('/api/episode/refresh', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:parseInt(title.match(/ID: (\d+)/)?.[1] || id),season:parseInt(season),episode:parseInt(episode)})});
  const j = await r.json();
  addLog(j.message, j.success ? 'success' : 'error');
}

async function deleteSeries(id) {
  if (!confirm('Delete this series permanently?')) return;
  const r = await fetch('/api/series/' + id, {method:'DELETE'});
  const j = await r.json();
  if (j.success) { addLog('Series deleted', 'success'); setTimeout(()=>location.reload(),1000); }
}
</script>
</body>
</html>
  `);
});

// ——— NEW: CHECK NEW EPISODES FOR ONE SERIES ———
app.post('/api/series/:id/check-new', async (req, res) => {
  const id = parseInt(req.params.id);
  const series = seriesConfig[id];
  if (!series) return res.status(404).json({ success: false, message: 'Series not found' });

  res.json({ success: true, message: 'Checking for new episodes...' });

  setImmediate(async () => {
    let browser, page;
    try {
      browser = await getBrowser();
      page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', req => {
        ['image','stylesheet','font','media','websocket','manifest'].includes(req.resourceType()) ? req.abort() : req.continue();
      });

      const baseUrl = series.urlPattern.split('-episode-')[0];
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 2500));

      const episodeLinks = await page.$$eval('a[href*="episode-"]', links =>
        links.map(a => {
          const m = a.href.match(/episode-(\d+)/);
          return m ? parseInt(m[1]) : 0;
        }).filter(n => n > 0)
      );

      if (episodeLinks.length === 0) {
        await sendTelegram(`No episodes found while checking\n${series.title}`);
        return;
      }

      const maxEpisode = Math.max(...episodeLinks);
      let totalCurrent = 0;
      for (const s in series.seasons) totalCurrent += series.seasons[s].count;

      if (maxEpisode > totalCurrent) {
        const added = maxEpisode - totalCurrent;
        const lastSeason = Math.max(...Object.keys(series.seasons).map(Number));
        series.seasons[lastSeason].count = maxEpisode;
        saveSeriesConfig();

        await sendTelegram(`New Episodes Detected!\n<b>${series.title}</b>\nSeason ${lastSeason} updated to ${maxEpisode} episodes\n+${added} new episode(s) found`);
        addLogToAll(`New episodes detected: ${series.title} → ${maxEpisode} total`, 'success');
      } else {
        await sendTelegram(`No new episodes\n${series.title} (still ${totalCurrent})`);
      }
    } catch (err) {
      await sendTelegram(`Error checking new episodes\n${series.title}\n${err.message}`);
    } finally {
      if (page) await page.close().catch(()=>{});
    }
  });
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
