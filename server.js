require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const fs       = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_URL    = 'https://api.anthropic.com/v1/messages';
const MODEL_FAST = 'claude-sonnet-4-20250514'; // Fast model for passes 1-3
const MODEL_BEST = 'claude-opus-4-5';           // Best model for final verdict only
const DB_FILE    = path.join(__dirname, 'trades.json');
const SUBS_FILE  = path.join(__dirname, 'subscribers.json');

// ─────────────────────────────────────────────
// DATABASES
// ─────────────────────────────────────────────
function loadTrades() { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { return []; } }
function saveTrades(t) { fs.writeFileSync(DB_FILE,JSON.stringify(t,null,2)); }
function loadSubs() { try { return JSON.parse(fs.readFileSync(SUBS_FILE,'utf8')); } catch { return []; } }
function saveSubs(s) { fs.writeFileSync(SUBS_FILE,JSON.stringify(s,null,2)); }

function getWinStats() {
  const trades = loadTrades().filter(t=>t.outcome);
  if(!trades.length) return null;
  const wins = trades.filter(t=>t.outcome==='win').length;
  const avgRR = trades.filter(t=>t.actual_rr).reduce((s,t)=>s+t.actual_rr,0)/trades.filter(t=>t.actual_rr).length||0;
  const byGrade = {};
  trades.forEach(t=>{ if(!byGrade[t.grade])byGrade[t.grade]={wins:0,losses:0}; byGrade[t.grade][t.outcome==='win'?'wins':'losses']++; });
  return { total:trades.length, wins, losses:trades.length-wins, winRate:Math.round(wins/trades.length*100), avgRR:avgRR.toFixed(2), byGrade };
}

// ─────────────────────────────────────────────
// LIVE PRICE (fast, parallel fetch)
// ─────────────────────────────────────────────
async function fetchLivePrice(symbol) {
  if(!symbol||symbol==='Unknown') return null;
  const sym = symbol.toUpperCase().replace(/[\/\-\s]/g,'');
  try {
    const coinMap={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple',ADA:'cardano',DOGE:'dogecoin',AVAX:'avalanche-2',MATIC:'matic-network',DOT:'polkadot',LINK:'chainlink',LTC:'litecoin'};
    const base = sym.replace('USDT','').replace('USD','').replace('BUSD','');
    const coinId = coinMap[base];
    if(coinId) {
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`,{timeout:4000});
      const d = await r.json();
      if(d[coinId]) return {price:d[coinId].usd,change24h:d[coinId].usd_24h_change?.toFixed(2),source:'CoinGecko'};
    }
    const fxPairs={EURUSD:'EUR',GBPUSD:'GBP',USDJPY:'USD',AUDUSD:'AUD'};
    if(fxPairs[sym]) {
      const base=sym.substring(0,3),quote=sym.substring(3,6);
      const r=await fetch(`https://open.er-api.com/v6/latest/${base}`,{timeout:4000});
      const d=await r.json();
      if(d.rates?.[quote]) return {price:d.rates[quote].toFixed(5),source:'ExchangeRate'};
    }
  } catch { return null; }
  return null;
}

// ─────────────────────────────────────────────
// MARKET CONTEXT (instant, no API call)
// ─────────────────────────────────────────────
function getMarketContext(symbol) {
  const hour=new Date().getUTCHours(), day=new Date().getDay();
  let session, sessionQuality;
  if(hour>=22||hour<8){session='Asia Session';sessionQuality='Poor';}
  else if(hour>=8&&hour<12){session='London Open';sessionQuality='Good';}
  else if(hour>=12&&hour<17){session='London/NY Overlap';sessionQuality='Excellent';}
  else if(hour>=17&&hour<20){session='New York Session';sessionQuality='Good';}
  else{session='Pre-Asia';sessionQuality='Poor';}
  const dayRisk=day===5?'High':day===1?'Medium':'Low';
  const sym=(symbol||'').toUpperCase();
  const risks=[];
  if(sym.includes('USD'))risks.push('Watch USD news events');
  if(sym.includes('BTC')||sym.includes('ETH'))risks.push('Crypto: best during NY/London overlap');
  return {session,sessionQuality,dayRisk,risks,hour,day};
}

// ─────────────────────────────────────────────
// CLAUDE HELPER
// ─────────────────────────────────────────────
async function claude(model, apiKey, system, content, tokens=1500) {
  const r = await fetch(API_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model,max_tokens:tokens,system,messages:[{role:'user',content}]})
  });
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error?.message||`HTTP ${r.status}`);}
  const d=await r.json();
  const raw=(d.content||[]).map(c=>c.text||'').join('').trim();
  try{return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim());}
  catch{const m=raw.match(/\{[\s\S]*\}/);if(m)return JSON.parse(m[0]);throw new Error('JSON parse failed');}
}
const imgBlock=(b64,mime)=>({type:'image',source:{type:'base64',media_type:mime||'image/png',data:b64}});

// ─────────────────────────────────────────────
// PASS 1A — CHART STRUCTURE READER (fast)
// Runs in parallel with 1B
// ─────────────────────────────────────────────
async function pass1a_structure(charts, sym, key) {
  const n = charts.length;
  const sys = `Expert chart analyst. Read ${n} chart(s) and extract structure data. Return ONLY raw JSON.
{"current_price":"<>","trend":"Bullish/Bearish/Sideways","strength":"Strong/Moderate/Weak",
"structure":"HH+HL/LH+LL/Ranging","phase":"Accumulation/Markup/Distribution/Markdown/Consolidation",
"swing_high":"<>","swing_low":"<>","bos":"<recent BOS if any>","choch":"<CHOCH if any>",
"price_position":"Premium/Discount/Equilibrium","range_high":"<>","range_low":"<>","range_mid":"<>",
"htf_bias":"Bullish/Bearish/Neutral","alignment_score":<0-100>,"tradeable_direction":"Long/Short/Wait",
"key_levels":[{"price":"<>","type":"Resistance/Support","strength":"Major/Minor","reason":"<>"}],
"candles":"<last 5 candles story>","patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High"}],
"confidence":<0-100>}`;
  const content=[...charts.map((c,i)=>[{type:'text',text:`Chart ${i+1}${n>1?' ('+c.label+')':''}:`},imgBlock(c.base64,c.mime)]).flat(),{type:'text',text:`Analyze structure of this ${sym} chart${n>1?'s':''}.`}];
  return claude(MODEL_FAST, key, sys, content, 1200);
}

// ─────────────────────────────────────────────
// PASS 1B — SMC READER (fast)
// Runs in parallel with 1A
// ─────────────────────────────────────────────
async function pass1b_smc(charts, sym, key) {
  const sys = `Smart Money Concepts expert. Identify all SMC elements. Return ONLY raw JSON.
{"order_blocks":{"bullish":"<price or none>","bearish":"<price or none>"},
"fvg":{"bullish":"<price range or none>","bearish":"<price range or none>"},
"liquidity":{"buy_side":"<equal highs or key level>","sell_side":"<equal lows or key level>"},
"recent_sweep":"<describe any liquidity sweep or none>",
"displacement":"<any strong institutional move or none>",
"institutional_bias":"Bullish/Bearish/Neutral",
"next_target":"<where smart money is likely taking price>",
"volume":{"trend":"Increasing/Decreasing/Flat/NotVisible","last_bar":"High/Low/Average/NotVisible","notes":"<>"},
"indicators":{"ema":"<alignment>","rsi":"<value and state>","macd":"<state>","other":"<>"}}`;
  const content=[...charts.slice(0,1).map(c=>[imgBlock(c.base64,c.mime)]).flat(),{type:'text',text:`Find all SMC elements on this ${sym} chart.`}];
  return claude(MODEL_FAST, key, sys, content, 1000);
}

// ─────────────────────────────────────────────
// PASS 2 — ENTRY ARCHITECT (fast)
// Uses structure + SMC from parallel passes
// ─────────────────────────────────────────────
async function pass2_entry(charts, sym, structure, smc, mktCtx, livePrice, key) {
  // Skip if no clear direction or bad conditions
  if(structure.tradeable_direction==='Wait'||structure.alignment_score<50||mktCtx.sessionQuality==='Poor') {
    return {entry_quality:'D',skip_reason:'No clear direction or poor session',tp1_rr:'0'};
  }
  const sys = `Precision entry specialist. Find the exact best entry. Minimum 1:2 R:R required. Return ONLY raw JSON.
{"entry_type":"Limit/Stop/Market/Wait","entry_price":"<>","entry_zone":"<>",
"entry_trigger":"<exact confirmation needed>","entry_quality":"A+/A/B/C/D",
"sl_price":"<>","sl_reason":"<structural reason>",
"tp1_price":"<>","tp1_reason":"<>","tp1_rr":"<e.g. 1:2.4>",
"tp2_price":"<>","tp2_reason":"<>","tp2_rr":"<>",
"tp3_price":"<>","tp3_rr":"<>",
"obstacles_tp1":"<any S/R between entry and TP1>",
"trade_management":{"move_to_be":"<when>","partial_at_tp1":"<% to close>","trail_after_tp1":"<how>","max_hold":"<time>"},
"invalidation":"<price that cancels setup before entry>"}`;
  const lp=livePrice?`Live price: $${livePrice.price}`:'';
  return claude(MODEL_FAST, key, sys, [
    imgBlock(charts[0].base64,charts[0].mime),
    {type:'text',text:`Find best ${structure.tradeable_direction} entry for ${sym}.\n${lp}\nTrend:${structure.trend} Alignment:${structure.alignment_score}/100\nKey levels:${JSON.stringify(structure.key_levels)}\nOBs:${JSON.stringify(smc.order_blocks)} FVGs:${JSON.stringify(smc.fvg)}\nLiquidity:${JSON.stringify(smc.liquidity)}`}
  ], 1200);
}

// ─────────────────────────────────────────────
// PASS 3 — FINAL VERDICT (Opus — best quality)
// Has all data, applies 9 gates, generates signal
// ─────────────────────────────────────────────
async function pass3_verdict(charts, sym, tf, structure, smc, entry, mktCtx, livePrice, winStats, key) {
  const sys = `Chief Trading Officer. Apply 9 quality gates and generate the final signal.

GATES (all must pass or return WAIT):
G1: alignment_score < 55 → WAIT
G2: sessionQuality is Poor → WAIT
G3: dayRisk is High → WAIT (Friday)
G4: entry_quality is C or D → WAIT
G5: tp1_rr less than 1:2 → WAIT
G6: major obstacle to TP1 → WAIT
G7: price_position is Premium for Long → WAIT
G8: price_position is Discount for Short → WAIT
G9: institutional_bias conflicts with direction → reduce confidence

CONFIDENCE: base=alignment_score*0.7, +8 inst bias matches, +5 correct zone, +5 live price confirms, +5 excellent session, -8 obstacle to TP1, cap 92.

Return ONLY raw JSON.
{"verdict":"BUY/SELL/WAIT","confidence":<40-92>,"signal_grade":"A+/A/B/C/D",
"gates_passed":["G1 ✓"],"gates_failed":["Gx ✗: reason"],"wait_reason":"<if WAIT>",
"market_phase":"<>","price_position":"<>","market_bias":"Strongly Bullish/Bullish/Neutral/Bearish/Strongly Bearish",
"summary":"<6-7 sentence summary: market structure, price position, setup confluences, why gates passed, entry plan, risk, thesis>",
"entry":"<>","entry_trigger":"<>","entry_zone":"<>","entry_available_now":true,
"sl":"<>","sl_reason":"<>",
"tp1":"<>","tp1_reason":"<>","tp2":"<>","tp2_reason":"<>","tp3":"<>",
"rr_tp1":"<>","rr_tp2":"<>","rrLabel":"Poor/Acceptable/Good/Excellent","position_size":"<% to risk>",
"confluences":["<1>","<2>","<3>","<4>","<5>"],
"key_levels":{"major_resistance":"<>","minor_resistance":"<>","major_support":"<>","minor_support":"<>","equilibrium":"<>"},
"smart_money":{"order_blocks":"<>","fvg":"<>","liquidity_pools":"<>","recent_sweep":"<>","bos_choch":"<>","next_target":"<>"},
"factors":[
{"name":"Trend","score":<0-100>,"note":"<>"},
{"name":"Volume","score":<0-100>,"note":"<>"},
{"name":"Momentum","score":<0-100>,"note":"<>"},
{"name":"Structure","score":<0-100>,"note":"<>"},
{"name":"Price Action","score":<0-100>,"note":"<>"},
{"name":"Confluence","score":<0-100>,"note":"<>"},
{"name":"Risk/Reward","score":<0-100>,"note":"<>"}],
"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","significance":"<>"}],
"indicators":{"ema":"<>","rsi":"<>","macd":"<>","volume":"<>","other":"<>"},
"invalidation":{"immediate":"<>","warning":"<>","scenario":"<>"},
"trade_management":{"move_to_be":"<>","partial_tp1":"<>","trail_method":"<>","max_hold":"<>"},
"candle_analysis":"<>","best_case":"<>","worst_case":"<>",
"fullAnalysis":"<12-15 sentences elite HTML with strong tags covering: institutional SMC analysis, MTF alignment, price position, all confluences with prices, gate results, session/news, entry/SL/TP reasoning, position sizing, trade management, invalidation, and full thesis>"}`;

  const lp=livePrice?`Live: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)`:'Live: N/A';
  const ws=winStats?`History: ${winStats.winRate}% WR over ${winStats.total} trades`:'No history';
  return claude(MODEL_BEST, key, sys, [
    ...charts.map(c=>imgBlock(c.base64,c.mime)),
    {type:'text',text:`Final verdict for ${sym} ${tf}.\n${lp}\nSession:${mktCtx.session}(${mktCtx.sessionQuality}) DayRisk:${mktCtx.dayRisk}\n${ws}\n\nSTRUCTURE:${JSON.stringify(structure)}\nSMC:${JSON.stringify(smc)}\nENTRY:${JSON.stringify(entry)}\n\nApply all 9 gates. Be strict.`}
  ], 4000);
}

// ─────────────────────────────────────────────
// EMAIL ALERTS
// ─────────────────────────────────────────────
async function sendEmailAlert(signal) {
  const subs=loadSubs().filter(s=>s.active);
  if(!subs.length||!['A+','A'].includes(signal.signal_grade)) return;
  const SENDGRID_KEY=process.env.SENDGRID_API_KEY;
  if(!SENDGRID_KEY){console.log('[Email] No SENDGRID_API_KEY — skipping alerts');return;}
  const subject=`NexTrade AI: ${signal.verdict} ${signal.symbol} — Grade ${signal.signal_grade} (${signal.confidence}% conf)`;
  const body=`New ${signal.signal_grade} Grade Signal\n\nAsset: ${signal.symbol} ${signal.tf}\nSignal: ${signal.verdict}\nConfidence: ${signal.confidence}%\nEntry: ${signal.entry}\nStop Loss: ${signal.sl}\nTP1: ${signal.tp1} (R:R ${signal.rr_tp1})\nTP2: ${signal.tp2||'N/A'}\n\n${signal.summary}\n\n---\nNot financial advice. Manage your risk.\nnexttrade-pro.vercel.app`;
  for(const sub of subs){
    try{
      await fetch('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{'Authorization':`Bearer ${SENDGRID_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({personalizations:[{to:[{email:sub.email}]}],from:{email:process.env.FROM_EMAIL||'signals@nexttrade-ai.com',name:'NexTrade AI'},subject,content:[{type:'text/plain',value:body}]})});
      console.log(`[Email] Sent to ${sub.email}`);
    }catch(e){console.error(`[Email] Failed ${sub.email}:`,e.message);}
  }
}

// ─────────────────────────────────────────────
// MAIN ENDPOINT — OPTIMIZED PARALLEL ENGINE
// ─────────────────────────────────────────────
app.post('/api/analyze', async(req,res)=>{
  const{charts,imageBase64,imageMime,symbol,timeframe}=req.body;
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key) return res.status(500).json({error:'ANTHROPIC_API_KEY not set'});
  let chartList=[];
  if(charts?.length) chartList=charts;
  else if(imageBase64) chartList=[{base64:imageBase64,mime:imageMime||'image/png',label:timeframe||'Chart'}];
  else return res.status(400).json({error:'No image provided'});
  const sym=symbol||'Unknown', tf=timeframe||chartList[0]?.label||'1H';

  try{
    console.log(`\n[NexTrade] ⚡ ${sym} ${tf} — ${chartList.length} chart(s) — PARALLEL ENGINE`);
    const t0=Date.now();

    // ── STEP 1: Run ALL fast tasks in parallel ──
    // Pass 1A (structure) + Pass 1B (SMC) + live price fetch all at the same time
    console.log('[Step 1] Running structure + SMC + live price in PARALLEL...');
    const [structure, smc, livePrice, winStats] = await Promise.all([
      pass1a_structure(chartList, sym, key),
      pass1b_smc(chartList, sym, key),
      fetchLivePrice(sym).catch(()=>null),
      Promise.resolve(getWinStats())
    ]);
    const mktCtx = getMarketContext(sym);
    console.log(`[Step 1] ✓ Trend:${structure.trend} Alignment:${structure.alignment_score}/100 Dir:${structure.tradeable_direction} SMC:${smc.institutional_bias} Price:${livePrice?'$'+livePrice.price:'N/A'}`);

    // ── STEP 2: Entry architecture (needs step 1 results) ──
    console.log('[Step 2] Entry architecture...');
    const entry = await pass2_entry(chartList, sym, structure, smc, mktCtx, livePrice, key);
    if(entry.skip_reason) console.log(`[Step 2] Skipped — ${entry.skip_reason}`);
    else console.log(`[Step 2] ✓ Entry:${entry.entry_price} SL:${entry.sl_price} TP1:${entry.tp1_price} R:R:${entry.tp1_rr} Quality:${entry.entry_quality}`);

    // ── STEP 3: Final verdict with Opus (needs all above) ──
    console.log('[Step 3] Final verdict (Opus)...');
    const result = await pass3_verdict(chartList, sym, tf, structure, smc, entry, mktCtx, livePrice, winStats, key);
    console.log(`[Step 3] ✓ VERDICT:${result.verdict} Grade:${result.signal_grade} Conf:${result.confidence}%`);

    const elapsed=((Date.now()-t0)/1000).toFixed(1);
    console.log(`[NexTrade] ⚡ Complete in ${elapsed}s\n`);

    // Save to journal
    if(result.verdict==='BUY'||result.verdict==='SELL'){
      const trades=loadTrades();
      const id=Date.now().toString();
      trades.push({id,symbol:sym,timeframe:tf,verdict:result.verdict,grade:result.signal_grade,confidence:result.confidence,entry:result.entry,sl:result.sl,tp1:result.tp1,tp2:result.tp2,rr_tp1:result.rr_tp1,timestamp:new Date().toISOString(),outcome:null,actual_rr:null});
      saveTrades(trades);
      result._trade_id=id;
      sendEmailAlert({...result,symbol:sym,tf}).catch(console.error);
    }

    result._meta={analysis_time_seconds:parseFloat(elapsed),charts_analyzed:chartList.length,live_price:livePrice,market_context:mktCtx,win_stats:winStats};
    res.json(result);

  }catch(err){
    console.error('[NexTrade] Error:',err.message);
    res.status(500).json({error:err.message||'Analysis failed'});
  }
});

// ─────────────────────────────────────────────
// OTHER ENDPOINTS
// ─────────────────────────────────────────────
app.post('/api/subscribe',(req,res)=>{
  const{email}=req.body;
  if(!email||!email.includes('@')) return res.status(400).json({error:'Invalid email'});
  const subs=loadSubs();
  if(subs.find(s=>s.email===email)) return res.json({success:true,message:'Already subscribed'});
  subs.push({email,active:true,subscribedAt:new Date().toISOString()});
  saveSubs(subs);
  console.log(`[Email] New subscriber: ${email} (total: ${subs.length})`);
  res.json({success:true});
});

app.get('/api/subscribers',(req,res)=>res.json({total:loadSubs().length,active:loadSubs().filter(s=>s.active).length}));
app.delete('/api/subscribe/:email',(req,res)=>{const subs=loadSubs();const s=subs.find(s=>s.email===decodeURIComponent(req.params.email));if(s){s.active=false;saveSubs(subs);}res.json({success:true});});
app.get('/api/trades',(req,res)=>res.json(loadTrades()));
app.get('/api/stats',(req,res)=>res.json(getWinStats()||{message:'No completed trades yet'}));
app.post('/api/trades/:id/outcome',(req,res)=>{const{outcome,actual_rr}=req.body;const trades=loadTrades();const t=trades.find(t=>t.id===req.params.id);if(!t) return res.status(404).json({error:'Not found'});t.outcome=outcome;t.actual_rr=actual_rr;t.closed_at=new Date().toISOString();saveTrades(trades);res.json({success:true,stats:getWinStats()});});
app.delete('/api/trades/:id',(req,res)=>{saveTrades(loadTrades().filter(t=>t.id!==req.params.id));res.json({success:true});});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  NexTrade AI — ⚡ Parallel Engine    ║`);
  console.log(`  ║  Passes 1A+1B+Price run in parallel  ║`);
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
