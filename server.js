require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const fs       = require('fs');

const app = express();
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_URL    = 'https://api.anthropic.com/v1/messages';
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-20250514';
const MODEL_OPUS   = 'claude-opus-4-5';

// ─────────────────────────────────────────────
// FILE SYSTEM — safe read/write for Vercel
// Vercel has a read-only filesystem except /tmp
// We use /tmp for writable storage
// ─────────────────────────────────────────────
const TMP = '/tmp';
const DB_FILE    = path.join(TMP, 'trades.json');
const SUBS_FILE  = path.join(TMP, 'subscribers.json');
const USERS_FILE = path.join(TMP, 'users.json');

function safeRead(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function safeWrite(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; }
  catch(e) { console.warn(`[Storage] Could not write ${file}: ${e.message}`); return false; }
}

function loadTrades() { return safeRead(DB_FILE, []); }
function saveTrades(t) { safeWrite(DB_FILE, t); }
function loadSubs() { return safeRead(SUBS_FILE, []); }
function saveSubs(s) { safeWrite(SUBS_FILE, s); }
function loadUsers() { return safeRead(USERS_FILE, {}); }
function saveUsers(u) { safeWrite(USERS_FILE, u); }

const PLANS = {
  basic: { name:'Basic', price:14.99, priceId:process.env.STRIPE_BASIC_PRICE_ID, dailyLimit:10 },
  pro:   { name:'Pro',   price:39.99, priceId:process.env.STRIPE_PRO_PRICE_ID,   dailyLimit:999 }
};

// ─────────────────────────────────────────────
// USER HELPERS
// ─────────────────────────────────────────────
function getUser(email) { return loadUsers()[email] || null; }
function upsertUser(email, data) {
  const users = loadUsers();
  users[email] = { ...users[email], ...data, email, updatedAt: new Date().toISOString() };
  if(!users[email].createdAt) users[email].createdAt = new Date().toISOString();
  saveUsers(users); return users[email];
}
function checkDailyLimit(email) {
  const user = getUser(email); if(!user) return false;
  if(user.plan === 'pro') return true;
  const today = new Date().toDateString();
  const limit = PLANS[user.plan]?.dailyLimit || 10;
  const used = (user.usageDate === today) ? (user.usageCount || 0) : 0;
  return used < limit;
}
function incrementUsage(email) {
  const users = loadUsers(); const today = new Date().toDateString();
  if(!users[email]) return;
  if(users[email].usageDate !== today) { users[email].usageDate = today; users[email].usageCount = 0; }
  users[email].usageCount = (users[email].usageCount || 0) + 1;
  saveUsers(users);
}
function getUsageInfo(email) {
  const user = getUser(email); if(!user) return { used:0, limit:0, plan:'none' };
  const today = new Date().toDateString();
  const limit = PLANS[user.plan]?.dailyLimit || 10;
  const used = (user.usageDate === today) ? (user.usageCount || 0) : 0;
  return { used, limit, plan:user.plan, isPro:user.plan==='pro' };
}
function getWinStats() {
  const trades = loadTrades().filter(t=>t.outcome); if(!trades.length) return null;
  const wins = trades.filter(t=>t.outcome==='win').length;
  const avgRR = trades.filter(t=>t.actual_rr).reduce((s,t)=>s+t.actual_rr,0) / (trades.filter(t=>t.actual_rr).length||1);
  const byGrade = {};
  trades.forEach(t=>{ if(!byGrade[t.grade])byGrade[t.grade]={wins:0,losses:0}; byGrade[t.grade][t.outcome==='win'?'wins':'losses']++; });
  return { total:trades.length, wins, losses:trades.length-wins, winRate:Math.round(wins/trades.length*100), avgRR:avgRR.toFixed(2), byGrade };
}

// ─────────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────────
async function stripeRequest(endpoint, method, body) {
  const key = process.env.STRIPE_SECRET_KEY;
  if(!key) throw new Error('STRIPE_SECRET_KEY not set');
  const params = new URLSearchParams();
  if(body) Object.entries(body).forEach(([k,v]) => {
    if(typeof v === 'object') Object.entries(v).forEach(([k2,v2]) => params.append(`${k}[${k2}]`,v2));
    else params.append(k,v);
  });
  const r = await fetch(`https://api.stripe.com/v1/${endpoint}`, { method, headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded'}, body:method!=='GET'?params.toString():undefined });
  const d = await r.json(); if(d.error) throw new Error(d.error.message); return d;
}

// ─────────────────────────────────────────────
// LIVE PRICE
// ─────────────────────────────────────────────
async function fetchLivePrice(symbol) {
  if(!symbol||symbol==='Unknown') return null;
  const sym = symbol.toUpperCase().replace(/[\/\-\s]/g,'');
  try {
    const coinMap={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple',ADA:'cardano',DOGE:'dogecoin',AVAX:'avalanche-2',MATIC:'matic-network',LINK:'chainlink',LTC:'litecoin'};
    const base=sym.replace('USDT','').replace('USD','').replace('BUSD','');
    if(coinMap[base]){const r=await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinMap[base]}&vs_currencies=usd&include_24hr_change=true`,{timeout:4000});const d=await r.json();if(d[coinMap[base]])return{price:d[coinMap[base]].usd,change24h:d[coinMap[base]].usd_24h_change?.toFixed(2)};}
    const fxPairs={EURUSD:'EUR',GBPUSD:'GBP',USDJPY:'USD',AUDUSD:'AUD'};
    if(fxPairs[sym]){const r=await fetch(`https://open.er-api.com/v6/latest/${sym.substring(0,3)}`,{timeout:4000});const d=await r.json();if(d.rates?.[sym.substring(3,6)])return{price:d.rates[sym.substring(3,6)].toFixed(5)};}
  }catch{return null;}
  return null;
}

function getMarketContext(symbol) {
  const hour=new Date().getUTCHours(), day=new Date().getDay();
  let session;
  if(hour>=22||hour<8) session='Asia Session';
  else if(hour>=8&&hour<12) session='London Open';
  else if(hour>=12&&hour<17) session='London/NY Overlap — peak liquidity';
  else if(hour>=17&&hour<20) session='New York Session';
  else session='Pre-Asia';
  return { session, dayRisk:day===5?'High':'Low', hour };
}

// ─────────────────────────────────────────────
// CLAUDE HELPER
// ─────────────────────────────────────────────
async function claude(model, apiKey, system, content, tokens=1000) {
  const r = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'}, body:JSON.stringify({model, max_tokens:tokens, system, messages:[{role:'user',content}]}) });
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error?.message||`HTTP ${r.status}`);}
  const d = await r.json();
  const raw = (d.content||[]).map(c=>c.text||'').join('').trim();
  try{return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim());}
  catch{const m=raw.match(/\{[\s\S]*\}/);if(m)return JSON.parse(m[0]);throw new Error('JSON parse failed');}
}
const imgBlock = (b64,mime) => ({type:'image',source:{type:'base64',media_type:mime||'image/png',data:b64}});

// ─────────────────────────────────────────────
// PASS 1A — CHART STRUCTURE (Haiku)
// ─────────────────────────────────────────────
async function pass1a(charts, sym, key) {
  const sys = `Read this trading chart and extract data. Return ONLY raw JSON:
{"current_price":"<>","trend":"Bullish/Bearish/Sideways","strength":"Strong/Moderate/Weak","structure":"HH+HL/LH+LL/Ranging","phase":"Accumulation/Markup/Distribution/Markdown/Consolidation","swing_high":"<>","swing_low":"<>","bos":"<or none>","choch":"<or none>","price_position":"Premium/Discount/Equilibrium","range_high":"<>","range_low":"<>","range_mid":"<>","htf_bias":"Bullish/Bearish/Neutral","alignment_score":<0-100>,"tradeable_direction":"Long/Short/Neutral","key_levels":[{"price":"<>","type":"Resistance/Support","strength":"Major/Minor","reason":"<>"}],"candles":"<last 5 candles>","patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High"}],"confidence":<0-100>}`;
  const content = [...charts.map((c,i)=>[{type:'text',text:`Chart ${i+1}:`},imgBlock(c.base64,c.mime)]).flat(),{type:'text',text:`Extract all chart data for ${sym}.`}];
  return claude(MODEL_HAIKU, key, sys, content, 1000);
}

// ─────────────────────────────────────────────
// PASS 1B — SMC (Haiku)
// ─────────────────────────────────────────────
async function pass1b(charts, sym, key) {
  const sys = `Identify Smart Money Concepts on this chart. Return ONLY raw JSON:
{"order_blocks":{"bullish":"<price or none>","bearish":"<price or none>"},"fvg":{"bullish":"<range or none>","bearish":"<range or none>"},"liquidity":{"buy_side":"<level>","sell_side":"<level>"},"recent_sweep":"<or none>","institutional_bias":"Bullish/Bearish/Neutral","next_target":"<where price goes next>","volume":{"trend":"Increasing/Decreasing/Flat/NotVisible","notes":"<>"},"indicators":{"ema":"<alignment>","rsi":"<value if visible>","macd":"<state if visible>","other":"<>"}}`;
  return claude(MODEL_HAIKU, key, sys, [imgBlock(charts[0].base64,charts[0].mime),{type:'text',text:`Find SMC elements on this ${sym} chart.`}], 800);
}

// ─────────────────────────────────────────────
// PASS 2 — ENTRY (Sonnet)
// ─────────────────────────────────────────────
async function pass2(charts, sym, structure, smc, livePrice, key) {
  const sys = `You are a trading entry specialist. Find the single best trade setup on this chart. Always find an entry. Return ONLY raw JSON:
{"entry_type":"Limit/Stop/Market/Retest","entry_price":"<specific price>","entry_zone":"<range>","entry_trigger":"<what confirms it>","entry_quality":"A+/A/B/C","direction":"Long/Short","sl_price":"<specific price>","sl_reason":"<why>","tp1_price":"<specific price>","tp1_reason":"<why>","tp1_rr":"<e.g. 1:2.1>","tp2_price":"<specific price>","tp2_reason":"<why>","tp2_rr":"<>","tp3_price":"<>","tp3_rr":"<>","obstacles_tp1":"<or none>","trade_management":{"move_to_be":"<when>","partial_at_tp1":"50%","trail_after_tp1":"<how>","max_hold":"<time>"}}`;
  const lp = livePrice ? `Current price: $${livePrice.price}` : '';
  return claude(MODEL_SONNET, key, sys, [
    imgBlock(charts[0].base64,charts[0].mime),
    {type:'text',text:`Find the best trade on this ${sym} chart.\n${lp}\nTrend: ${structure.trend} (${structure.strength})\nKey levels: ${JSON.stringify(structure.key_levels)}\nOBs: ${JSON.stringify(smc.order_blocks)}\nFVGs: ${JSON.stringify(smc.fvg)}\nNext target: ${smc.next_target}`}
  ], 1000);
}

// ─────────────────────────────────────────────
// PASS 3 — FINAL VERDICT (Opus)
// ─────────────────────────────────────────────
async function pass3(charts, sym, tf, structure, smc, entry, mktCtx, livePrice, winStats, key) {
  const sys = `You are a professional trading signal generator. Generate a BUY or SELL signal with full analysis.

RULES:
- BUY when price is more likely to go up
- SELL when price is more likely to go down
- WAIT only when the chart is completely flat with zero direction — should be rare (under 10% of charts)
- Any visible trend, key level, or pattern = BUY or SELL signal
- Grade A+ to D based on how many things align

Return ONLY raw JSON:
{"verdict":"BUY/SELL/WAIT","confidence":<40-95>,"signal_grade":"A+/A/B/C/D","wait_reason":"<only if WAIT>","market_phase":"<>","price_position":"Premium/Discount/Equilibrium","market_bias":"Strongly Bullish/Bullish/Neutral/Bearish/Strongly Bearish","summary":"<5-6 sentences: what you see, why bullish/bearish, the setup, entry plan, main risk>","entry":"<exact price>","entry_trigger":"<confirmation>","entry_zone":"<range>","sl":"<exact stop>","sl_reason":"<why>","tp1":"<first target>","tp1_reason":"<>","tp2":"<second target>","tp2_reason":"<>","tp3":"<extended target>","rr_tp1":"<R:R>","rr_tp2":"<R:R>","rrLabel":"Acceptable/Good/Excellent","position_size":"<1% max>","confluences":["<every reason supporting the trade>"],"key_levels":{"major_resistance":"<>","minor_resistance":"<>","major_support":"<>","minor_support":"<>","equilibrium":"<>"},"smart_money":{"order_blocks":"<>","fvg":"<>","liquidity_pools":"<>","recent_sweep":"<>","bos_choch":"<>","next_target":"<>"},"factors":[{"name":"Trend","score":<0-100>,"note":"<>"},{"name":"Volume","score":<0-100>,"note":"<>"},{"name":"Momentum","score":<0-100>,"note":"<>"},{"name":"Structure","score":<0-100>,"note":"<>"},{"name":"Price Action","score":<0-100>,"note":"<>"},{"name":"Confluence","score":<0-100>,"note":"<>"},{"name":"Risk/Reward","score":<0-100>,"note":"<>"}],"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","significance":"<>"}],"indicators":{"ema":"<>","rsi":"<>","macd":"<>","volume":"<>","other":"<>"},"invalidation":{"immediate":"<kills trade>","warning":"<warning level>","scenario":"<exit signal>"},"trade_management":{"move_to_be":"<when>","partial_tp1":"50% at TP1","trail_method":"<how>","max_hold":"<time>"},"candle_analysis":"<last 5 candles>","best_case":"<ideal path>","worst_case":"<failure path>","fullAnalysis":"<10-14 sentences professional HTML with strong tags>"}`;

  const lp = livePrice ? `Live: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)` : '';
  const ws = winStats ? `Track record: ${winStats.winRate}% win rate over ${winStats.total} signals` : '';

  return claude(MODEL_OPUS, key, sys, [
    ...charts.map(c=>imgBlock(c.base64,c.mime)),
    {type:'text',text:`Generate trading signal for ${sym} ${tf}.\n\n${lp}\nSession: ${mktCtx.session}\n${ws}\n\nTrend: ${structure.trend} (${structure.strength}) | Structure: ${structure.structure} | HTF: ${structure.htf_bias} | Position: ${structure.price_position} | Alignment: ${structure.alignment_score}/100\n\nSMC: OBs:${JSON.stringify(smc.order_blocks)} FVGs:${JSON.stringify(smc.fvg)} Inst:${smc.institutional_bias} Target:${smc.next_target}\n\nBest entry: ${entry.direction} @ ${entry.entry_price} (${entry.entry_quality}) SL:${entry.sl_price} TP1:${entry.tp1_price} R:R:${entry.tp1_rr}\n\nGive BUY or SELL unless truly flat with zero direction.`}
  ], 3500);
}

// ─────────────────────────────────────────────
// PASS 4 — CONFIRMATION (Sonnet)
// Looks at the chart fresh + the signal from Pass 3
// Confirms direction, sharpens entry/SL/TP levels
// Boosts confidence if it agrees, lowers if it disagrees
// NEVER blocks the signal — only improves it
// ─────────────────────────────────────────────
async function pass4(charts, sym, tf, signal, structure, smc, key) {
  // If WAIT, skip confirmation — nothing to confirm
  if(signal.verdict === 'WAIT') return signal;

  const sys = `You are a senior trading analyst doing a final review of a trading signal. Your job is to:
1. Confirm the signal direction is correct by looking at the chart yourself
2. Sharpen the exact entry, stop loss, and take profit levels
3. Add any confluences the first analyst may have missed
4. Adjust the confidence score up or down based on what you see
5. Improve the fullAnalysis with any additional insights

IMPORTANT: Do NOT change BUY to SELL or vice versa unless the signal is completely wrong. Your job is to IMPROVE the signal, not reject it.

Return ONLY raw JSON with the improved signal:
{"verdict":"<keep same as input unless completely wrong>","confidence":<adjusted 40-95>,"signal_grade":"<adjust if needed>","confirmation":"Confirmed/Partially Confirmed/Adjusted","confirmation_note":"<what you confirmed or changed and why>","entry":"<sharpened entry price>","entry_trigger":"<sharpened confirmation>","sl":"<sharpened stop loss>","sl_reason":"<why>","tp1":"<sharpened TP1>","tp1_reason":"<why>","tp2":"<sharpened TP2>","tp2_reason":"<why>","tp3":"<sharpened TP3>","rr_tp1":"<updated R:R>","rr_tp2":"<updated R:R>","rrLabel":"Acceptable/Good/Excellent","additional_confluences":["<any extra confluences found>"],"missed_risks":"<any risks the first analyst missed>","candle_analysis":"<fresh look at last 5 candles>","fullAnalysis":"<12-16 sentences of elite HTML analysis with strong tags — the most complete analysis possible covering everything: trend, structure, all SMC elements, every confluence, precise entry/SL/TP reasoning, trade management, invalidation levels, and complete trade thesis>"}`;

  const improved = await claude(MODEL_SONNET, key, sys, [
    ...charts.map(c=>imgBlock(c.base64,c.mime)),
    {type:'text',text:`Review and improve this ${signal.verdict} signal for ${sym} ${tf}.\n\nOriginal signal:\nVerdict: ${signal.verdict}\nConfidence: ${signal.confidence}%\nGrade: ${signal.signal_grade}\nEntry: ${signal.entry}\nSL: ${signal.sl}\nTP1: ${signal.tp1} (${signal.rr_tp1})\nTP2: ${signal.tp2}\nSummary: ${signal.summary}\n\nChart data:\nTrend: ${structure.trend} (${structure.strength})\nStructure: ${structure.structure}\nSMC: OBs:${JSON.stringify(smc.order_blocks)} FVGs:${JSON.stringify(smc.fvg)}\nInstitutional bias: ${smc.institutional_bias}\n\nConfirm the direction, sharpen the levels, add any missed confluences.`}
  ], 2500);

  // Merge improvements back into original signal
  return {
    ...signal,
    verdict:        improved.verdict        || signal.verdict,
    confidence:     improved.confidence     || signal.confidence,
    signal_grade:   improved.signal_grade   || signal.signal_grade,
    entry:          improved.entry          || signal.entry,
    entry_trigger:  improved.entry_trigger  || signal.entry_trigger,
    sl:             improved.sl             || signal.sl,
    sl_reason:      improved.sl_reason      || signal.sl_reason,
    tp1:            improved.tp1            || signal.tp1,
    tp1_reason:     improved.tp1_reason     || signal.tp1_reason,
    tp2:            improved.tp2            || signal.tp2,
    tp2_reason:     improved.tp2_reason     || signal.tp2_reason,
    tp3:            improved.tp3            || signal.tp3,
    rr_tp1:         improved.rr_tp1         || signal.rr_tp1,
    rr_tp2:         improved.rr_tp2         || signal.rr_tp2,
    rrLabel:        improved.rrLabel        || signal.rrLabel,
    candle_analysis:improved.candle_analysis|| signal.candle_analysis,
    fullAnalysis:   improved.fullAnalysis   || signal.fullAnalysis,
    confluences:    [
      ...(signal.confluences||[]),
      ...(improved.additional_confluences||[])
    ].filter(Boolean),
    _pass4: {
      confirmation: improved.confirmation,
      note: improved.confirmation_note,
      missed_risks: improved.missed_risks
    }
  };
}

// ─────────────────────────────────────────────
// EMAIL ALERTS
// ─────────────────────────────────────────────
async function sendEmailAlert(signal) {
  const subs=loadSubs().filter(s=>s.active);
  if(!subs.length||!['A+','A'].includes(signal.signal_grade)) return;
  const key=process.env.SENDGRID_API_KEY; if(!key) return;
  const body=`${signal.signal_grade} Grade Signal — ${signal.verdict} ${signal.symbol}\n\nConfidence: ${signal.confidence}%\nEntry: ${signal.entry}\nSL: ${signal.sl}\nTP1: ${signal.tp1} (${signal.rr_tp1})\n\n${signal.summary}\n\nNot financial advice — nexttrade-pro.vercel.app`;
  for(const sub of subs){try{await fetch('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({personalizations:[{to:[{email:sub.email}]}],from:{email:process.env.FROM_EMAIL||'signals@nexttrade-ai.com',name:'NexTrade AI'},subject:`${signal.verdict} ${signal.symbol} — Grade ${signal.signal_grade}`,content:[{type:'text/plain',value:body}]})});}catch(e){console.error('[Email]',e.message);}}
}

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
app.post('/api/auth/signup',(req,res)=>{
  const{email,password}=req.body;
  if(!email||!password||password.length<6) return res.status(400).json({error:'Invalid email or password (min 6 chars)'});
  const users=loadUsers(); if(users[email]) return res.status(400).json({error:'Account already exists'});
  upsertUser(email,{password,plan:'free',active:true});
  res.json({success:true});
});
app.post('/api/auth/login',(req,res)=>{
  const{email,password}=req.body;
  const user=getUser(email);
  if(!user||user.password!==password) return res.status(401).json({error:'Invalid email or password'});
  res.json({success:true,user:{email,plan:user.plan,active:user.active,...getUsageInfo(email)}});
});
app.get('/api/auth/me',(req,res)=>{
  const email=req.headers['x-user-email']; if(!email) return res.status(401).json({error:'Not authenticated'});
  const user=getUser(email); if(!user) return res.status(404).json({error:'User not found'});
  res.json({email,plan:user.plan,active:user.active,...getUsageInfo(email)});
});

// ─────────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────────
app.post('/api/stripe/checkout',async(req,res)=>{
  const{email,plan}=req.body;
  if(!email||!plan||!PLANS[plan]) return res.status(400).json({error:'Invalid request'});
  const priceId=PLANS[plan].priceId;
  if(!priceId) return res.status(500).json({error:`STRIPE_${plan.toUpperCase()}_PRICE_ID not set in Vercel environment variables`});
  try{
    let user=getUser(email); let customerId=user?.stripeCustomerId;
    if(!customerId){const c=await stripeRequest('customers','POST',{email,metadata:{plan}});customerId=c.id;upsertUser(email,{stripeCustomerId:customerId});}
    const baseUrl=process.env.BASE_URL||'https://nexttrade-pro.vercel.app';
    const session=await stripeRequest('checkout/sessions','POST',{'customer':customerId,'line_items[0][price]':priceId,'line_items[0][quantity]':'1','mode':'subscription','success_url':`${baseUrl}/?payment=success&plan=${plan}`,'cancel_url':`${baseUrl}/?payment=cancelled`,'metadata[email]':email,'metadata[plan]':plan});
    res.json({url:session.url});
  }catch(err){res.status(500).json({error:err.message});}
});
app.post('/api/stripe/portal',async(req,res)=>{
  const{email}=req.body; const user=getUser(email);
  if(!user?.stripeCustomerId) return res.status(400).json({error:'No subscription found'});
  try{const baseUrl=process.env.BASE_URL||'https://nexttrade-pro.vercel.app';const s=await stripeRequest('billing_portal/sessions','POST',{customer:user.stripeCustomerId,return_url:baseUrl});res.json({url:s.url});}
  catch(err){res.status(500).json({error:err.message});}
});
app.post('/api/webhook',async(req,res)=>{
  let event; try{event=JSON.parse(req.body.toString());}catch{return res.status(400).send('error');}
  const obj=event.data.object;
  if(event.type==='checkout.session.completed'){const email=obj.metadata?.email||obj.customer_details?.email;const plan=obj.metadata?.plan||'basic';if(email){upsertUser(email,{plan,active:true,stripeCustomerId:obj.customer,subscriptionId:obj.subscription});console.log(`[Stripe] ✓ ${email} → ${plan}`);}}
  if(event.type==='invoice.payment_succeeded'){const users=loadUsers();const user=Object.values(users).find(u=>u.stripeCustomerId===obj.customer);if(user)upsertUser(user.email,{active:true});}
  if(event.type==='customer.subscription.deleted'||event.type==='invoice.payment_failed'){const users=loadUsers();const user=Object.values(users).find(u=>u.stripeCustomerId===obj.customer);if(user)upsertUser(user.email,{active:false,plan:'none'});}
  res.json({received:true});
});

// ─────────────────────────────────────────────
// MAIN ANALYZE
// ─────────────────────────────────────────────
app.post('/api/analyze',async(req,res)=>{
  const{charts,imageBase64,imageMime,symbol,timeframe}=req.body;
  const email=req.headers['x-user-email'];
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key) return res.status(500).json({error:'ANTHROPIC_API_KEY not set'});

  // No subscription required — open access
  if(charts?.length>1) {
    // Multi-chart allowed for everyone
  }

  let chartList=[];
  if(charts?.length) chartList=charts;
  else if(imageBase64) chartList=[{base64:imageBase64,mime:imageMime||'image/png',label:timeframe||'Chart'}];
  else return res.status(400).json({error:'No image provided'});

  const sym=symbol||'Unknown', tf=timeframe||chartList[0]?.label||'1H';

  try{
    console.log(`\n[NexTrade] ⚡ ${sym} ${tf} | Haiku→Sonnet→Opus`);
    const t0=Date.now();

    const[structure,smc,livePrice,winStats]=await Promise.all([
      pass1a(chartList,sym,key),
      pass1b(chartList,sym,key),
      fetchLivePrice(sym).catch(()=>null),
      Promise.resolve(getWinStats())
    ]);
    const mktCtx=getMarketContext(sym);
    console.log(`[Step 1] ✓ Trend:${structure.trend} Align:${structure.alignment_score} SMC:${smc.institutional_bias}`);

    const entry=await pass2(chartList,sym,structure,smc,livePrice,key);
    console.log(`[Step 2] ✓ ${entry.direction} @ ${entry.entry_price} Quality:${entry.entry_quality}`);

    const signal=await pass3(chartList,sym,tf,structure,smc,entry,mktCtx,livePrice,winStats,key);
    console.log(`[Step 3] ✓ ${signal.verdict} Grade:${signal.signal_grade} Conf:${signal.confidence}%`);

    // Pass 4 — confirmation (runs in parallel with nothing, sharpens the signal)
    console.log('[Step 4] Confirming and sharpening signal...');
    const result=await pass4(chartList,sym,tf,signal,structure,smc,key);
    console.log(`[Step 4] ✓ ${result.verdict} Grade:${result.signal_grade} Conf:${result.confidence}% (${result._pass4?.confirmation||'confirmed'})`);

    const elapsed=((Date.now()-t0)/1000).toFixed(1);
    console.log(`[NexTrade] ⚡ Done in ${elapsed}s\n`);

    if(email) incrementUsage(email);

    // Save trade — won't crash if filesystem fails
    if(result.verdict==='BUY'||result.verdict==='SELL'){
      try {
        const trades=loadTrades(); const id=Date.now().toString();
        trades.push({id,symbol:sym,timeframe:tf,verdict:result.verdict,grade:result.signal_grade,confidence:result.confidence,entry:result.entry,sl:result.sl,tp1:result.tp1,tp2:result.tp2,rr_tp1:result.rr_tp1,timestamp:new Date().toISOString(),outcome:null,actual_rr:null,userEmail:email});
        saveTrades(trades); result._trade_id=id;
      } catch(e) { console.warn('[Trades] Could not save trade:', e.message); }
      sendEmailAlert({...result,symbol:sym,tf}).catch(()=>{});
    }

    result._meta={analysis_time_seconds:parseFloat(elapsed),charts_analyzed:chartList.length,live_price:livePrice,market_context:mktCtx,win_stats:winStats};
    res.json(result);

  }catch(err){
    console.error('[NexTrade] Error:',err.message);
    res.status(500).json({error:err.message||'Analysis failed'});
  }
});

// ─────────────────────────────────────────────
// MANUAL PAYMENT (crypto / bank transfer)
// Saves pending payment, sends you an email to verify
// ─────────────────────────────────────────────
app.post('/api/manual-payment', async(req,res)=>{
  const{email,plan,type,reference}=req.body;
  if(!email||!plan||!reference) return res.status(400).json({error:'Missing fields'});

  // Save pending payment to /tmp
  const pending = safeRead(path.join(TMP,'pending-payments.json'),[]);
  pending.push({ email, plan, type, reference, submittedAt: new Date().toISOString(), status:'pending' });
  safeWrite(path.join(TMP,'pending-payments.json'), pending);

  // Email YOU (the owner) to verify and manually activate
  const sgKey = process.env.SENDGRID_API_KEY;
  if(sgKey) {
    const prices = { basic:'$14.99', pro:'$39.99' };
    const body = `New manual payment received!\n\nEmail: ${email}\nPlan: ${plan} (${prices[plan]||'?'})\nMethod: ${type}\nReference: ${reference}\nTime: ${new Date().toISOString()}\n\nTo activate this account, call this URL:\n${process.env.BASE_URL||'https://nexttrade-pro.vercel.app'}/api/activate-manual?email=${encodeURIComponent(email)}&plan=${plan}&secret=${process.env.ADMIN_SECRET||'changeme'}\n\nOr reply to ${email} to ask for more info.`;
    try {
      await fetch('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{'Authorization':`Bearer ${sgKey}`,'Content-Type':'application/json'},body:JSON.stringify({personalizations:[{to:[{email:process.env.ADMIN_EMAIL||process.env.FROM_EMAIL||'admin@nexttrade-ai.com'}]}],from:{email:process.env.FROM_EMAIL||'noreply@nexttrade-ai.com',name:'NexTrade AI'},subject:`Manual Payment: ${email} wants ${plan}`,content:[{type:'text/plain',value:body}]})});
      console.log(`[ManualPayment] Alert sent for ${email} (${plan} via ${type})`);
    } catch(e) { console.warn('[ManualPayment] Could not send email:', e.message); }
  }

  console.log(`[ManualPayment] New: ${email} | ${plan} | ${type} | ref: ${reference}`);
  res.json({success:true});
});

// Manual activation URL (you open this to activate an account after verifying payment)
app.get('/api/activate-manual',(req,res)=>{
  const{email,plan,secret}=req.query;
  const adminSecret = process.env.ADMIN_SECRET||'changeme';
  if(secret!==adminSecret) return res.status(403).send('Invalid secret');
  if(!email||!plan) return res.status(400).send('Missing email or plan');
  upsertUser(email,{plan,active:true,activatedAt:new Date().toISOString(),activationMethod:'manual'});
  console.log(`[ManualPayment] ✓ Activated: ${email} → ${plan}`);
  res.send(`<html><body style="font-family:monospace;background:#06080d;color:#00e5b4;padding:40px"><h2>✓ Account Activated</h2><p>Email: ${email}</p><p>Plan: ${plan}</p><p>Status: Active</p></body></html>`);
});
app.post('/api/subscribe',(req,res)=>{
  const{email}=req.body; if(!email||!email.includes('@')) return res.status(400).json({error:'Invalid email'});
  const subs=loadSubs(); if(subs.find(s=>s.email===email)) return res.json({success:true});
  subs.push({email,active:true,subscribedAt:new Date().toISOString()}); saveSubs(subs);
  res.json({success:true});
});
app.get('/api/trades',(req,res)=>{
  const email=req.headers['x-user-email'];
  res.json(loadTrades().filter(t=>!email||t.userEmail===email||!t.userEmail));
});
app.get('/api/stats',(req,res)=>res.json(getWinStats()||{message:'No completed trades yet'}));
app.post('/api/trades/:id/outcome',(req,res)=>{
  const{outcome,actual_rr}=req.body; const trades=loadTrades();
  const t=trades.find(t=>t.id===req.params.id); if(!t) return res.status(404).json({error:'Not found'});
  t.outcome=outcome; t.actual_rr=actual_rr; t.closed_at=new Date().toISOString();
  saveTrades(trades); res.json({success:true});
});
app.delete('/api/trades/:id',(req,res)=>{
  saveTrades(loadTrades().filter(t=>t.id!==req.params.id)); res.json({success:true});
});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`\n  NexTrade AI ⚡`);
  console.log(`  Storage: /tmp (Vercel compatible)`);
  console.log(`  Pipeline: Haiku(x2) → Sonnet → Opus`);
  console.log(`  http://localhost:${PORT}\n`);
});
