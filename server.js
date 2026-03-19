require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const fs       = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_URL   = 'https://api.anthropic.com/v1/messages';
const MODEL     = 'claude-opus-4-5';
const DB_FILE   = path.join(__dirname, 'trades.json');
const SUBS_FILE = path.join(__dirname, 'subscribers.json');

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
// LIVE PRICE FETCHER
// ─────────────────────────────────────────────
async function fetchLivePrice(symbol) {
  if(!symbol||symbol==='Unknown') return null;
  const sym = symbol.toUpperCase().replace('/','').replace(' ','').replace('-','');
  const sources = [
    async()=>{
      const coinMap={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple',ADA:'cardano',DOGE:'dogecoin',AVAX:'avalanche-2',MATIC:'matic-network',DOT:'polkadot',LINK:'chainlink',UNI:'uniswap',ATOM:'cosmos',LTC:'litecoin'};
      const base=sym.replace('USDT','').replace('USD','').replace('BUSD','');
      const coinId=coinMap[base]; if(!coinId) return null;
      const r=await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`,{timeout:5000});
      const d=await r.json(); if(!d[coinId]) return null;
      return {price:d[coinId].usd,change24h:d[coinId].usd_24h_change?.toFixed(2),source:'CoinGecko'};
    },
    async()=>{
      const pairs={EURUSD:'EUR',GBPUSD:'GBP',USDJPY:'USD',AUDUSD:'AUD',USDCAD:'USD'};
      if(!pairs[sym]) return null;
      const base=sym.substring(0,3),quote=sym.substring(3,6);
      const r=await fetch(`https://open.er-api.com/v6/latest/${base}`,{timeout:5000});
      const d=await r.json(); if(!d.rates?.[quote]) return null;
      return {price:d.rates[quote].toFixed(5),source:'ExchangeRate-API'};
    }
  ];
  for(const src of sources){try{const r=await src();if(r)return r;}catch{continue;}}
  return null;
}

// ─────────────────────────────────────────────
// MARKET CONTEXT
// ─────────────────────────────────────────────
function getMarketContext(symbol) {
  const ctx={session:'',risk_events:[],market_hours:''};
  const hour=new Date().getUTCHours();
  const day=new Date().getDay();
  if(hour>=22||hour<8) ctx.session='Asia Session (22:00-08:00 UTC) — Lower liquidity';
  else if(hour>=8&&hour<12) ctx.session='London Session Open (08:00-12:00 UTC) — High liquidity, major moves start here';
  else if(hour>=12&&hour<17) ctx.session='London/NY Overlap (12:00-17:00 UTC) — HIGHEST liquidity, best time to trade';
  else if(hour>=17&&hour<20) ctx.session='New York Session (17:00-20:00 UTC) — Good liquidity';
  else ctx.session='End of NY / Pre-Asia (20:00-22:00 UTC) — Low liquidity, avoid new positions';
  if(day===1) ctx.market_hours='Monday — Watch for gaps, lower volume early';
  else if(day===5) ctx.market_hours='Friday — End of week, close positions before weekend';
  else if(day===0||day===6) ctx.market_hours='Weekend — Crypto open but low institutional volume';
  else ctx.market_hours='Mid-week — Optimal trading conditions';
  const sym=(symbol||'').toUpperCase();
  if(sym.includes('BTC')||sym.includes('ETH')) ctx.risk_events.push('Crypto: Best signals during NY/London overlap (12:00-17:00 UTC)');
  if(sym.includes('USD')) ctx.risk_events.push('USD: Watch for NFP (first Friday), CPI (mid-month), FOMC (every 6 weeks)');
  if(sym.includes('EUR')||sym.includes('GBP')) ctx.risk_events.push('EUR/GBP: ECB/BOE meetings can cause sharp moves');
  return ctx;
}

// ─────────────────────────────────────────────
// EMAIL ALERT SENDER (via Anthropic API text)
// Note: Add SendGrid/Mailgun keys to .env for real emails
// ─────────────────────────────────────────────
async function sendEmailAlert(signal) {
  const subs = loadSubs().filter(s=>s.active);
  if(!subs.length) return;
  // Only alert for A+ and A grade signals
  if(!['A+','A'].includes(signal.signal_grade)) return;
  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  if(!SENDGRID_KEY) { console.log('[Email] No SENDGRID_API_KEY set — skipping email alerts'); return; }
  const subject = `NexTrade AI Signal: ${signal.verdict} ${signal.symbol} — Grade ${signal.signal_grade} (${signal.confidence}% confidence)`;
  const body = `
New ${signal.signal_grade} Grade Signal from NexTrade AI

Asset: ${signal.symbol} ${signal.tf}
Signal: ${signal.verdict}
Confidence: ${signal.confidence}%
Grade: ${signal.signal_grade}

Entry: ${signal.entry}
Stop Loss: ${signal.sl}
TP1: ${signal.tp1}
TP2: ${signal.tp2 || 'N/A'}
Risk/Reward: ${signal.rr_tp1 || 'N/A'}

Summary:
${signal.summary}

Trade Management:
${JSON.stringify(signal.trade_management || {}, null, 2)}

---
Not financial advice. Educational use only.
Manage your risk. Never risk more than you can afford to lose.

Unsubscribe: Reply to this email with "unsubscribe"
NexTrade AI — nexttrade-pro.vercel.app
  `.trim();

  for(const sub of subs) {
    try {
      await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: sub.email }] }],
          from: { email: process.env.FROM_EMAIL || 'signals@nexttrade-ai.com', name: 'NexTrade AI' },
          subject,
          content: [{ type: 'text/plain', value: body }]
        })
      });
      console.log(`[Email] Alert sent to ${sub.email}`);
    } catch(err) {
      console.error(`[Email] Failed for ${sub.email}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────
// CLAUDE API HELPER
// ─────────────────────────────────────────────
async function claude(apiKey, system, content, tokens=2000) {
  const r = await fetch(API_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:MODEL,max_tokens:tokens,system,messages:[{role:'user',content}]})
  });
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error?.message||`HTTP ${r.status}`);}
  const d=await r.json();
  const raw=(d.content||[]).map(c=>c.text||'').join('').trim();
  try{return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim());}
  catch{const m=raw.match(/\{[\s\S]*\}/);if(m)return JSON.parse(m[0]);throw new Error('JSON parse failed');}
}
const img=(b64,mime)=>({type:'image',source:{type:'base64',media_type:mime||'image/png',data:b64}});

// ─────────────────────────────────────────────
// PASS 1 — MULTI-TIMEFRAME CHART READING
// ─────────────────────────────────────────────
async function pass1(charts,sym,key){
  const n=charts.length;
  const sys=`You are an elite multi-timeframe chart analyst. You are analyzing ${n} chart screenshot${n>1?'s':''} of the same asset.
${n>1?'CRITICAL: The HIGHEST timeframe is THE LAW. Only trade in its direction. If timeframes conflict → tradeable_direction must be "Wait".':'Analyze this single chart thoroughly.'}
Return ONLY raw JSON.
{"timeframes":[${charts.map((_,i)=>`{"chart_index":${i+1},"detected_tf":"<tf>","trend":"Bullish/Bearish/Sideways","structure":"HH+HL/LH+LL/Ranging","key_support":"<price>","key_resistance":"<price>","price_position":"Premium/Discount/Equilibrium","bias":"Bullish/Bearish/Neutral","phase":"<phase>","notes":"<key obs>"}`).join(',')}],
"htf_bias":"Bullish/Bearish/Neutral","htf_support":"<price>","htf_resistance":"<price>",
"mtf_alignment":"Perfect Bull/Perfect Bear/Partial Bull/Partial Bear/Mixed/No Alignment",
"alignment_score":<0-100>,"tradeable_direction":"Long/Short/Wait",
"current_price":"<price>","price_position":"Premium/Discount/Equilibrium",
"range_high":"<>","range_low":"<>","range_midpoint":"<>",
"structure":{"swing_high":"<>","swing_low":"<>","bos":"<>","choch":"<>"},
"smart_money":{"order_blocks":"<>","fvg":"<>","liquidity":"<>","sweeps":"<>","institutional_bias":"Bullish/Bearish/Neutral"},
"key_levels":[{"price":"<>","type":"Resistance/Support","strength":"Major/Minor","reason":"<>"}],
"indicators":{"ema":"<>","rsi":"<>","macd":"<>","volume":"<>","other":"<>"},
"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High"}],
"reading_confidence":<0-100>,"summary":"<4-5 sentences>"}`;
  const content=[...charts.map((c,i)=>[{type:'text',text:`Chart ${i+1}${charts.length>1?' ('+c.label+')':''}:`},img(c.base64,c.mime)]).flat(),{type:'text',text:`Analyze ${n>1?'all '+n+' timeframe charts':'this chart'} for ${sym}.`}];
  return claude(key,sys,content,2500);
}

// ─────────────────────────────────────────────
// PASS 2 — CONTEXT ANALYST
// ─────────────────────────────────────────────
async function pass2(charts,sym,reading,livePrice,mktCtx,winStats,key){
  const sys=`You are an elite trading context analyst. Assess whether NOW is the right time to trade based on session, live price, and historical performance.
Return ONLY raw JSON.
{"live_price_confirms":true,"live_price_note":"<>","session_quality":"Excellent/Good/Poor/Avoid","session_note":"<>","news_risk":"High/Medium/Low","day_risk":"High/Medium/Low","day_note":"<>","historical":{"win_rate":"<>","best_grade":"<>","recommendation":"<>"},"context_bias":"Proceed/Caution/Wait/Avoid","risk_multiplier":<0.5-1.5>,"summary":"<3-4 sentences>"}`;
  const lp=livePrice?`Live: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)`:'Live price: N/A';
  const ws=winStats?`Win rate: ${winStats.winRate}% over ${winStats.total} trades`:'No history yet';
  return claude(key,sys,[img(charts[0].base64,charts[0].mime),{type:'text',text:`${sym} context:\n${lp}\nSession: ${mktCtx.session}\nDay: ${mktCtx.market_hours}\nRisks: ${mktCtx.risk_events.join(', ')||'None'}\n${ws}\nChart bias: ${reading.htf_bias}\nAlignment: ${reading.alignment_score}/100\n\nAssess if NOW is right to trade.`}],1500);
}

// ─────────────────────────────────────────────
// PASS 3 — ENTRY ARCHITECT
// ─────────────────────────────────────────────
async function pass3(charts,sym,reading,ctx,livePrice,key){
  const sys=`You are a precision entry specialist. Find the EXACT best entry with tightest stop and highest R:R. Minimum 1:2 R:R required.
Return ONLY raw JSON.
{"entry_type":"Limit/Stop/Market/Wait","entry_price":"<>","entry_zone":"<>","entry_trigger":"<>","entry_quality":"A+/A/B/C/D","entry_rationale":"<>","sl_price":"<>","sl_reason":"<>","tp1_price":"<>","tp1_reason":"<>","tp1_rr":"<>","tp2_price":"<>","tp2_reason":"<>","tp2_rr":"<>","tp3_price":"<>","tp3_rr":"<>","obstacles_tp1":"<>","obstacles_tp2":"<>","trade_management":{"move_to_be":"<>","partial_at_tp1":"<>","trail_after_tp1":"<>","max_hold_time":"<>"},"invalidation":"<>","summary":"<3-4 sentences>"}`;
  const lp=livePrice?`Current live price: $${livePrice.price}`:'Live price: N/A';
  return claude(key,sys,[img(charts[0].base64,charts[0].mime),{type:'text',text:`Find perfect entry for ${reading.tradeable_direction} on ${sym}.\n${lp}\nBias: ${reading.htf_bias}\nAlignment: ${reading.alignment_score}/100\nKey levels: ${JSON.stringify(reading.key_levels)}\nSMC: ${JSON.stringify(reading.smart_money)}\nContext: ${ctx.context_bias}\nSession: ${ctx.session_quality}`}],2000);
}

// ─────────────────────────────────────────────
// PASS 4 — FINAL VERDICT (9 Quality Gates)
// ─────────────────────────────────────────────
async function pass4(charts,sym,tf,reading,ctx,entry,livePrice,mktCtx,winStats,key){
  const sys=`You are the Chief Trading Officer. Apply 9 strict quality gates and make the final decision.

GATES — if ANY fail → WAIT:
G1: alignment_score < 60 → WAIT
G2: session_quality is Poor or Avoid → WAIT
G3: news_risk is High → WAIT
G4: day_risk is High → WAIT
G5: entry_quality is C or D → WAIT
G6: tp1_rr < 1:2 → WAIT
G7: major obstacle between entry and TP1 → WAIT
G8: price_position is Premium for longs → WAIT
G9: price_position is Discount for shorts → WAIT

Return ONLY raw JSON.
{"verdict":"BUY/SELL/WAIT","confidence":<40-92>,"signal_grade":"A+/A/B/C/D",
"gates_passed":["G1 ✓","G2 ✓"],"gates_failed":["Gx ✗: reason"],"wait_reason":"<if WAIT>",
"market_phase":"<>","price_position":"Premium/Discount/Equilibrium","market_bias":"Strongly Bullish/Bullish/Neutral/Bearish/Strongly Bearish",
"summary":"<9-10 sentence elite summary covering institutional context, MTF alignment, price position, setup confluences, all gates, session/news context, exact entry plan, risk management, and trade thesis>",
"entry":"<>","entry_trigger":"<>","entry_zone":"<>","entry_available_now":true,
"sl":"<>","sl_reason":"<>","tp1":"<>","tp1_reason":"<>","tp2":"<>","tp2_reason":"<>","tp3":"<>",
"rr_tp1":"<>","rr_tp2":"<>","rrLabel":"Poor/Acceptable/Good/Excellent","position_size":"<% to risk>",
"confluences":["<1>","<2>","<3>","<4>","<5>","<6>"],
"key_levels":{"major_resistance":"<>","minor_resistance":"<>","major_support":"<>","minor_support":"<>","equilibrium":"<>"},
"smart_money":{"order_blocks":"<>","fvg":"<>","liquidity_pools":"<>","recent_sweep":"<>","bos_choch":"<>","displacement":"<>","next_target":"<>"},
"factors":[{"name":"Trend","score":<0-100>,"note":"<>"},{"name":"Volume","score":<0-100>,"note":"<>"},{"name":"Momentum","score":<0-100>,"note":"<>"},{"name":"Structure","score":<0-100>,"note":"<>"},{"name":"Price Action","score":<0-100>,"note":"<>"},{"name":"Confluence","score":<0-100>,"note":"<>"},{"name":"Risk/Reward","score":<0-100>,"note":"<>"}],
"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","significance":"<>"}],
"indicators":{"ema":"<>","rsi":"<>","macd":"<>","volume":"<>","other":"<>"},
"invalidation":{"immediate":"<>","warning":"<>","scenario":"<>"},
"trade_management":{"move_to_be":"<>","partial_tp1":"<>","trail_method":"<>","max_hold":"<>"},
"candle_analysis":"<>","best_case":"<>","worst_case":"<>",
"fullAnalysis":"<15-18 sentences of elite institutional HTML with strong tags covering: institutional order flow, MTF alignment with prices, price position in range, full SMC/ICT setup with every confluence and price, all 9 gates and status, session and news context, live price confirmation, exact entry/SL/TP1/TP2/TP3 with structural reasons, position sizing calculation, complete trade management plan, invalidation levels, and full trade thesis with probability assessment>"}`;
  const lp=livePrice?`Live: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)`:'Live: N/A';
  const ws=winStats?`History: ${winStats.winRate}% WR, ${winStats.total} trades`:'No history';
  return claude(key,sys,[...charts.map(c=>img(c.base64,c.mime)),{type:'text',text:`Final verdict for ${sym} ${tf}.\n${lp}\nSession: ${mktCtx.session}\n${ws}\nReading: ${JSON.stringify(reading)}\nContext: ${JSON.stringify(ctx)}\nEntry: ${JSON.stringify(entry)}\nApply all 9 gates strictly.`}],5000);
}

// ─────────────────────────────────────────────
// MAIN ANALYZE ENDPOINT
// ─────────────────────────────────────────────
app.post('/api/analyze', async(req,res)=>{
  const{charts,imageBase64,imageMime,symbol,timeframe}=req.body;
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key) return res.status(500).json({error:'ANTHROPIC_API_KEY not set'});
  let chartList=[];
  if(charts&&charts.length) chartList=charts;
  else if(imageBase64) chartList=[{base64:imageBase64,mime:imageMime||'image/png',label:timeframe||'Chart'}];
  else return res.status(400).json({error:'No image provided'});
  const sym=symbol||'Unknown',tf=timeframe||chartList[0]?.label||'1H';
  try{
    console.log(`\n[NexTrade] ═══ ${sym} ${tf} — ${chartList.length} chart(s) ═══`);
    const t0=Date.now();
    console.log('[Data] Fetching external data...');
    const[livePrice,winStats]=await Promise.all([fetchLivePrice(sym).catch(()=>null),Promise.resolve(getWinStats())]);
    const mktCtx=getMarketContext(sym);
    console.log(`[Data] ✓ Price:${livePrice?'$'+livePrice.price:'N/A'} Session:${mktCtx.session.split(' ')[0]}`);
    console.log('[Pass 1] Multi-TF reading...');
    const reading=await pass1(chartList,sym,key);
    console.log(`[Pass 1] ✓ Bias:${reading.htf_bias} Alignment:${reading.alignment_score}/100 Dir:${reading.tradeable_direction}`);
    console.log('[Pass 2] Context analysis...');
    const ctx=await pass2(chartList,sym,reading,livePrice,mktCtx,winStats,key);
    console.log(`[Pass 2] ✓ Session:${ctx.session_quality} News:${ctx.news_risk} Bias:${ctx.context_bias}`);
    let entry={entry_quality:'D',tp1_rr:'0',summary:'Skipped — no clear direction'};
    if(reading.alignment_score>=50&&ctx.session_quality!=='Avoid'&&ctx.news_risk!=='High'){
      console.log('[Pass 3] Entry architecture...');
      entry=await pass3(chartList,sym,reading,ctx,livePrice,key);
      console.log(`[Pass 3] ✓ Entry:${entry.entry_price} SL:${entry.sl_price} TP1:${entry.tp1_price} R:R:${entry.tp1_rr}`);
    }else{console.log('[Pass 3] Skipped — conditions not met');}
    console.log('[Pass 4] Final verdict...');
    const result=await pass4(chartList,sym,tf,reading,ctx,entry,livePrice,mktCtx,winStats,key);
    console.log(`[Pass 4] ✓ VERDICT:${result.verdict} Grade:${result.signal_grade} Conf:${result.confidence}%`);
    const elapsed=((Date.now()-t0)/1000).toFixed(1);
    console.log(`[NexTrade] ═══ Complete in ${elapsed}s ═══\n`);
    // Auto-save to journal
    if(result.verdict==='BUY'||result.verdict==='SELL'){
      const trades=loadTrades();
      const tradeId=Date.now().toString();
      trades.push({id:tradeId,symbol:sym,timeframe:tf,verdict:result.verdict,grade:result.signal_grade,confidence:result.confidence,entry:result.entry,sl:result.sl,tp1:result.tp1,tp2:result.tp2,rr_tp1:result.rr_tp1,timestamp:new Date().toISOString(),outcome:null,actual_rr:null});
      saveTrades(trades);
      result._trade_id=tradeId;
      // Send email alerts (async — don't wait)
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
// EMAIL SUBSCRIPTION ENDPOINTS
// ─────────────────────────────────────────────
app.post('/api/subscribe', (req,res)=>{
  const{email}=req.body;
  if(!email||!email.includes('@')) return res.status(400).json({error:'Invalid email'});
  const subs=loadSubs();
  if(subs.find(s=>s.email===email)) return res.json({success:true,message:'Already subscribed'});
  subs.push({email,active:true,subscribedAt:new Date().toISOString()});
  saveSubs(subs);
  console.log(`[Email] New subscriber: ${email} (total: ${subs.length})`);
  res.json({success:true,message:'Subscribed successfully'});
});

app.get('/api/subscribers', (req,res)=>{
  const subs=loadSubs();
  res.json({total:subs.length,active:subs.filter(s=>s.active).length,subscribers:subs.map(s=>({email:s.email,active:s.active,date:s.subscribedAt}))});
});

app.delete('/api/subscribe/:email', (req,res)=>{
  const subs=loadSubs();
  const sub=subs.find(s=>s.email===decodeURIComponent(req.params.email));
  if(sub){sub.active=false;saveSubs(subs);}
  res.json({success:true});
});

// ─────────────────────────────────────────────
// TRADE JOURNAL ENDPOINTS
// ─────────────────────────────────────────────
app.get('/api/trades',(req,res)=>res.json(loadTrades()));
app.get('/api/stats',(req,res)=>res.json(getWinStats()||{message:'No completed trades yet'}));

app.post('/api/trades/:id/outcome',(req,res)=>{
  const{outcome,actual_rr,notes}=req.body;
  const trades=loadTrades();
  const trade=trades.find(t=>t.id===req.params.id);
  if(!trade) return res.status(404).json({error:'Trade not found'});
  trade.outcome=outcome;trade.actual_rr=actual_rr;trade.notes=notes||'';trade.closed_at=new Date().toISOString();
  saveTrades(trades);
  console.log(`[Journal] Trade ${req.params.id}: ${outcome} R:R:${actual_rr}`);
  res.json({success:true,stats:getWinStats()});
});

app.delete('/api/trades/:id',(req,res)=>{
  let trades=loadTrades();trades=trades.filter(t=>t.id!==req.params.id);saveTrades(trades);
  res.json({success:true});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   NexTrade AI — Ultimate Engine          ║`);
  console.log(`  ║   Landing + Analyzer + Journal + Email   ║`);
  console.log(`  ║   http://localhost:${PORT}                  ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
