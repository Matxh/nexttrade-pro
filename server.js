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
const MODEL_FAST = 'claude-sonnet-4-20250514';
const MODEL_BEST = 'claude-opus-4-5';
const DB_FILE    = path.join(__dirname, 'trades.json');
const SUBS_FILE  = path.join(__dirname, 'subscribers.json');
const USERS_FILE = path.join(__dirname, 'users.json');

const PLANS = {
  basic: { name:'Basic', price:14.99, priceId:process.env.STRIPE_BASIC_PRICE_ID, dailyLimit:10 },
  pro:   { name:'Pro',   price:39.99, priceId:process.env.STRIPE_PRO_PRICE_ID,   dailyLimit:999 }
};

// ─────────────────────────────────────────────
// DATABASES
// ─────────────────────────────────────────────
function loadTrades() { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { return []; } }
function saveTrades(t) { fs.writeFileSync(DB_FILE,JSON.stringify(t,null,2)); }
function loadSubs() { try { return JSON.parse(fs.readFileSync(SUBS_FILE,'utf8')); } catch { return []; } }
function saveSubs(s) { fs.writeFileSync(SUBS_FILE,JSON.stringify(s,null,2)); }
function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE,'utf8')); } catch { return {}; } }
function saveUsers(u) { fs.writeFileSync(USERS_FILE,JSON.stringify(u,null,2)); }
function getUser(email) { return loadUsers()[email] || null; }
function upsertUser(email, data) {
  const users = loadUsers();
  users[email] = { ...users[email], ...data, email, updatedAt: new Date().toISOString() };
  if(!users[email].createdAt) users[email].createdAt = new Date().toISOString();
  saveUsers(users); return users[email];
}
function checkDailyLimit(email) {
  const user = getUser(email);
  if(!user) return false;
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
  const avgRR = trades.filter(t=>t.actual_rr).reduce((s,t)=>s+t.actual_rr,0)/trades.filter(t=>t.actual_rr).length||0;
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
  const r = await fetch(`https://api.stripe.com/v1/${endpoint}`, { method, headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded'}, body: method!=='GET'?params.toString():undefined });
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
  let session, sessionQuality;
  if(hour>=22||hour<8){session='Asia Session';sessionQuality='Low';}
  else if(hour>=8&&hour<12){session='London Open';sessionQuality='High';}
  else if(hour>=12&&hour<17){session='London/NY Overlap';sessionQuality='High';}
  else if(hour>=17&&hour<20){session='New York';sessionQuality='High';}
  else{session='Pre-Asia';sessionQuality='Low';}
  const dayRisk = day===5?'High':'Low';
  return {session, sessionQuality, dayRisk, hour};
}

// ─────────────────────────────────────────────
// CLAUDE HELPER
// ─────────────────────────────────────────────
async function claude(model, apiKey, system, content, tokens=1500) {
  const r = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'}, body:JSON.stringify({model, max_tokens:tokens, system, messages:[{role:'user',content}]}) });
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error?.message||`HTTP ${r.status}`);}
  const d = await r.json();
  const raw = (d.content||[]).map(c=>c.text||'').join('').trim();
  try{return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim());}
  catch{const m=raw.match(/\{[\s\S]*\}/);if(m)return JSON.parse(m[0]);throw new Error('JSON parse failed');}
}
const imgBlock = (b64,mime) => ({type:'image',source:{type:'base64',media_type:mime||'image/png',data:b64}});

// ─────────────────────────────────────────────
// PASS 1A — CHART STRUCTURE (fast, parallel)
// ─────────────────────────────────────────────
async function pass1a(charts, sym, key) {
  const sys = `You are an expert technical analyst. Analyze this trading chart and identify the trend, structure, and key levels. Always provide a clear directional bias — do NOT say "wait" or "unclear" unless the chart is genuinely sideways with no trend at all.

Return ONLY raw JSON:
{"current_price":"<>","trend":"Bullish/Bearish/Sideways","strength":"Strong/Moderate/Weak","structure":"HH+HL/LH+LL/Ranging","phase":"Accumulation/Markup/Distribution/Markdown/Consolidation","swing_high":"<>","swing_low":"<>","bos":"<recent BOS if any, or none>","choch":"<CHOCH if any, or none>","price_position":"Premium/Discount/Equilibrium","range_high":"<>","range_low":"<>","range_mid":"<>","htf_bias":"Bullish/Bearish/Neutral","alignment_score":<0-100>,"tradeable_direction":"Long/Short/Neutral","key_levels":[{"price":"<>","type":"Resistance/Support","strength":"Major/Minor","reason":"<>"}],"candles":"<last 5 candles story>","patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High"}],"confidence":<0-100>}`;
  const content = [...charts.map((c,i)=>[{type:'text',text:`Chart ${i+1}:`},imgBlock(c.base64,c.mime)]).flat(), {type:'text',text:`Analyze the trend and structure of this ${sym} chart. Give me a clear directional bias.`}];
  return claude(MODEL_FAST, key, sys, content, 1200);
}

// ─────────────────────────────────────────────
// PASS 1B — SMC ANALYSIS (fast, parallel)
// ─────────────────────────────────────────────
async function pass1b(charts, sym, key) {
  const sys = `You are a Smart Money Concepts expert. Identify all SMC elements visible on this chart. Return ONLY raw JSON:
{"order_blocks":{"bullish":"<price or none>","bearish":"<price or none>"},"fvg":{"bullish":"<price range or none>","bearish":"<price range or none>"},"liquidity":{"buy_side":"<equal highs or level>","sell_side":"<equal lows or level>"},"recent_sweep":"<describe or none>","institutional_bias":"Bullish/Bearish/Neutral","next_target":"<most likely next price target>","volume":{"trend":"Increasing/Decreasing/Flat/NotVisible","notes":"<>"},"indicators":{"ema":"<alignment>","rsi":"<value and state if visible>","macd":"<state if visible>","other":"<>"}}`;
  return claude(MODEL_FAST, key, sys, [imgBlock(charts[0].base64,charts[0].mime), {type:'text',text:`Identify Smart Money Concepts on this ${sym} chart.`}], 1000);
}

// ─────────────────────────────────────────────
// PASS 2 — ENTRY ARCHITECT (fast)
// ─────────────────────────────────────────────
async function pass2(charts, sym, structure, smc, livePrice, key) {
  // Only skip if truly no direction
  if(structure.tradeable_direction==='Neutral'&&structure.alignment_score<30) {
    return {entry_quality:'C', skip_reason:'Genuinely no clear direction', tp1_rr:'1:1.5'};
  }
  const sys = `You are a precision entry specialist. Find the best possible entry on this chart. Even in ranging markets, find the highest probability setup. Return ONLY raw JSON:
{"entry_type":"Limit/Stop/Market/Wait for retest","entry_price":"<>","entry_zone":"<acceptable range>","entry_trigger":"<what confirms entry>","entry_quality":"A+/A/B/C","sl_price":"<>","sl_reason":"<structural reason>","tp1_price":"<>","tp1_reason":"<>","tp1_rr":"<e.g. 1:2.1>","tp2_price":"<>","tp2_reason":"<>","tp2_rr":"<>","tp3_price":"<>","tp3_rr":"<>","obstacles_tp1":"<any major S/R between entry and TP1, or none>","trade_management":{"move_to_be":"<when to move stop to breakeven>","partial_at_tp1":"<% to close at TP1>","trail_after_tp1":"<how to trail>","max_hold":"<max time to hold>"}}`;
  const lp = livePrice ? `Current live price: $${livePrice.price}` : '';
  return claude(MODEL_FAST, key, sys, [
    imgBlock(charts[0].base64, charts[0].mime),
    {type:'text', text:`Find the best ${structure.tradeable_direction} entry for ${sym}.\n${lp}\nTrend: ${structure.trend} Strength: ${structure.strength}\nAlignment: ${structure.alignment_score}/100\nKey levels: ${JSON.stringify(structure.key_levels)}\nOrder blocks: ${JSON.stringify(smc.order_blocks)}\nFVGs: ${JSON.stringify(smc.fvg)}\nNext target: ${smc.next_target}`}
  ], 1200);
}

// ─────────────────────────────────────────────
// PASS 3 — FINAL VERDICT (Opus — best quality)
// LOOSENED GATES — gives real signals
// ─────────────────────────────────────────────
async function pass3(charts, sym, tf, structure, smc, entry, mktCtx, livePrice, winStats, key) {
  const sys = `You are an elite trading analyst making the final signal decision. Your job is to give ACTIONABLE signals — BUY, SELL, or WAIT. Only say WAIT if there is genuinely no clear setup.

QUALITY GATES (apply these but don't be overly strict):
- If trend is clear (Bullish/Bearish) and alignment_score > 35 → lean toward signaling
- Only say WAIT if: price is completely choppy with no direction AND no key level nearby
- A C-grade entry is acceptable if the trend is strong
- Session quality does NOT block signals — traders use this 24/7
- Friday only reduces position size recommendation, does NOT block signal

SIGNAL RULES:
- BUY: Bullish trend/structure, price near support or order block, reasonable R:R
- SELL: Bearish trend/structure, price near resistance or order block, reasonable R:R  
- WAIT: Only if chart is genuinely sideways with NO clear bias and NO good entry
- Minimum R:R for signaling: 1:1.5 (not 1:2 — be realistic)
- Confidence: base it on how many things align, not on perfection

BE DECISIVE. Traders need clear signals. If the chart shows a trend, signal it.

Return ONLY raw JSON:
{"verdict":"BUY/SELL/WAIT","confidence":<40-92>,"signal_grade":"A+/A/B/C/D","wait_reason":"<only if WAIT — specific reason>","market_phase":"<>","price_position":"Premium/Discount/Equilibrium","market_bias":"Strongly Bullish/Bullish/Neutral/Bearish/Strongly Bearish","summary":"<5-6 sentences: what you see on the chart, why you are bullish/bearish, the specific setup, entry plan, and risk>","entry":"<exact price or condition>","entry_trigger":"<what must happen to confirm>","entry_zone":"<acceptable range>","sl":"<exact stop loss>","sl_reason":"<why this level>","tp1":"<first target>","tp1_reason":"<>","tp2":"<second target>","tp2_reason":"<>","tp3":"<extended target>","rr_tp1":"<e.g. 1:2.1>","rr_tp2":"<e.g. 1:3.4>","rrLabel":"Acceptable/Good/Excellent","position_size":"<max % to risk — reduce on Friday or low session>","confluences":["<1>","<2>","<3>","<4>","<5>"],"key_levels":{"major_resistance":"<>","minor_resistance":"<>","major_support":"<>","minor_support":"<>","equilibrium":"<>"},"smart_money":{"order_blocks":"<>","fvg":"<>","liquidity_pools":"<>","recent_sweep":"<>","bos_choch":"<>","next_target":"<>"},"factors":[{"name":"Trend","score":<0-100>,"note":"<>"},{"name":"Volume","score":<0-100>,"note":"<>"},{"name":"Momentum","score":<0-100>,"note":"<>"},{"name":"Structure","score":<0-100>,"note":"<>"},{"name":"Price Action","score":<0-100>,"note":"<>"},{"name":"Confluence","score":<0-100>,"note":"<>"},{"name":"Risk/Reward","score":<0-100>,"note":"<>"}],"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","significance":"<>"}],"indicators":{"ema":"<>","rsi":"<>","macd":"<>","volume":"<>","other":"<>"},"invalidation":{"immediate":"<price that kills trade>","warning":"<early warning level>","scenario":"<price action to exit>"},"trade_management":{"move_to_be":"<>","partial_tp1":"<>","trail_method":"<>","max_hold":"<>"},"candle_analysis":"<last 5 candles story>","best_case":"<ideal path>","worst_case":"<failure path>","fullAnalysis":"<10-14 sentences of professional HTML analysis with strong tags covering: what you see on the chart, trend and structure, key levels with prices, SMC elements, the specific setup, all confluences, exact entry/SL/TP plan with reasoning, risk management, and the complete trade thesis>"}`;

  const lp = livePrice ? `Live price: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)` : 'Live price: N/A';
  const ws = winStats ? `Historical: ${winStats.winRate}% win rate over ${winStats.total} trades` : 'No history yet';
  return claude(MODEL_BEST, key, sys, [
    ...charts.map(c=>imgBlock(c.base64,c.mime)),
    {type:'text', text:`Analyze this ${tf} chart for ${sym} and give me your signal.\n\n${lp}\nSession: ${mktCtx.session} (${mktCtx.sessionQuality} liquidity)\nDay risk: ${mktCtx.dayRisk}\n${ws}\n\nChart structure:\n- Trend: ${structure.trend} (${structure.strength})\n- Structure: ${structure.structure}\n- HTF Bias: ${structure.htf_bias}\n- Alignment Score: ${structure.alignment_score}/100\n- Direction: ${structure.tradeable_direction}\n- Price Position: ${structure.price_position}\n- Phase: ${structure.phase}\n\nSMC:\n- Order Blocks: ${JSON.stringify(smc.order_blocks)}\n- FVGs: ${JSON.stringify(smc.fvg)}\n- Liquidity: ${JSON.stringify(smc.liquidity)}\n- Institutional Bias: ${smc.institutional_bias}\n- Next Target: ${smc.next_target}\n\nBest entry found:\n- Type: ${entry.entry_type}\n- Price: ${entry.entry_price}\n- Quality: ${entry.entry_quality}\n- SL: ${entry.sl_price}\n- TP1: ${entry.tp1_price} (${entry.tp1_rr})\n\nGive me a clear signal. If there is a trend, signal it. Only say WAIT if the chart is genuinely choppy with no direction at all.`}
  ], 4000);
}

// ─────────────────────────────────────────────
// EMAIL ALERTS
// ─────────────────────────────────────────────
async function sendEmailAlert(signal) {
  const subs=loadSubs().filter(s=>s.active);
  if(!subs.length||!['A+','A'].includes(signal.signal_grade)) return;
  const key=process.env.SENDGRID_API_KEY; if(!key){console.log('[Email] No SENDGRID_API_KEY');return;}
  const body=`New ${signal.signal_grade} Grade Signal\n\n${signal.symbol} ${signal.tf} — ${signal.verdict}\nConfidence: ${signal.confidence}%\nEntry: ${signal.entry} | SL: ${signal.sl} | TP1: ${signal.tp1} (${signal.rr_tp1})\n\n${signal.summary}\n\nNot financial advice.\nnexttrade-pro.vercel.app`;
  for(const sub of subs){try{await fetch('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({personalizations:[{to:[{email:sub.email}]}],from:{email:process.env.FROM_EMAIL||'signals@nexttrade-ai.com',name:'NexTrade AI'},subject:`NexTrade AI: ${signal.verdict} ${signal.symbol} — Grade ${signal.signal_grade}`,content:[{type:'text/plain',value:body}]})});console.log(`[Email] Sent to ${sub.email}`);}catch(e){console.error(`[Email] Failed:`,e.message);}}
}

// ─────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────
app.post('/api/auth/signup', (req,res)=>{
  const{email,password}=req.body;
  if(!email||!password||password.length<6) return res.status(400).json({error:'Invalid email or password (min 6 chars)'});
  const users=loadUsers(); if(users[email]) return res.status(400).json({error:'Account already exists'});
  upsertUser(email,{password,plan:'none',active:false});
  res.json({success:true});
});

app.post('/api/auth/login', (req,res)=>{
  const{email,password}=req.body;
  const user=getUser(email);
  if(!user||user.password!==password) return res.status(401).json({error:'Invalid email or password'});
  const usage=getUsageInfo(email);
  res.json({success:true,user:{email,plan:user.plan,active:user.active,stripeCustomerId:user.stripeCustomerId,...usage}});
});

app.get('/api/auth/me', (req,res)=>{
  const email=req.headers['x-user-email']; if(!email) return res.status(401).json({error:'Not authenticated'});
  const user=getUser(email); if(!user) return res.status(404).json({error:'User not found'});
  res.json({email,plan:user.plan,active:user.active,...getUsageInfo(email)});
});

// ─────────────────────────────────────────────
// STRIPE ENDPOINTS
// ─────────────────────────────────────────────
app.post('/api/stripe/checkout', async(req,res)=>{
  const{email,plan}=req.body;
  if(!email||!plan||!PLANS[plan]) return res.status(400).json({error:'Invalid request'});
  const priceId=PLANS[plan].priceId;
  if(!priceId) return res.status(500).json({error:`STRIPE_${plan.toUpperCase()}_PRICE_ID not set in Vercel environment variables`});
  try{
    let user=getUser(email); let customerId=user?.stripeCustomerId;
    if(!customerId){const customer=await stripeRequest('customers','POST',{email,metadata:{plan}});customerId=customer.id;upsertUser(email,{stripeCustomerId:customerId});}
    const baseUrl=process.env.BASE_URL||'https://nexttrade-pro.vercel.app';
    const session=await stripeRequest('checkout/sessions','POST',{'customer':customerId,'line_items[0][price]':priceId,'line_items[0][quantity]':'1','mode':'subscription','success_url':`${baseUrl}/?payment=success&plan=${plan}`,'cancel_url':`${baseUrl}/?payment=cancelled`,'metadata[email]':email,'metadata[plan]':plan});
    res.json({url:session.url});
  }catch(err){console.error('[Stripe]',err.message);res.status(500).json({error:err.message});}
});

app.post('/api/stripe/portal', async(req,res)=>{
  const{email}=req.body; const user=getUser(email);
  if(!user?.stripeCustomerId) return res.status(400).json({error:'No subscription found'});
  try{const baseUrl=process.env.BASE_URL||'https://nexttrade-pro.vercel.app';const session=await stripeRequest('billing_portal/sessions','POST',{customer:user.stripeCustomerId,return_url:baseUrl});res.json({url:session.url});}
  catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/webhook', async(req,res)=>{
  let event;
  try{event=JSON.parse(req.body.toString());}catch{return res.status(400).send('Webhook error');}
  const obj=event.data.object;
  console.log(`[Webhook] ${event.type}`);
  if(event.type==='checkout.session.completed'){
    const email=obj.metadata?.email||obj.customer_details?.email; const plan=obj.metadata?.plan||'basic';
    if(email){upsertUser(email,{plan,active:true,stripeCustomerId:obj.customer,subscriptionId:obj.subscription,subscribedAt:new Date().toISOString()});console.log(`[Webhook] ✓ ${email} → ${plan}`);}
  }
  if(event.type==='invoice.payment_succeeded'){
    const users=loadUsers(); const user=Object.values(users).find(u=>u.stripeCustomerId===obj.customer);
    if(user){upsertUser(user.email,{active:true});console.log(`[Webhook] ✓ Payment ok: ${user.email}`);}
  }
  if(event.type==='customer.subscription.deleted'||event.type==='invoice.payment_failed'){
    const users=loadUsers(); const user=Object.values(users).find(u=>u.stripeCustomerId===obj.customer);
    if(user){upsertUser(user.email,{active:false,plan:'none'});console.log(`[Webhook] ✗ Access revoked: ${user.email}`);}
  }
  res.json({received:true});
});

// ─────────────────────────────────────────────
// MAIN ANALYZE ENDPOINT
// ─────────────────────────────────────────────
app.post('/api/analyze', async(req,res)=>{
  const{charts,imageBase64,imageMime,symbol,timeframe}=req.body;
  const email=req.headers['x-user-email'];
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key) return res.status(500).json({error:'ANTHROPIC_API_KEY not set'});

  // Auth check (skip if no email header — allows direct testing)
  if(email) {
    const user=getUser(email);
    if(!user||!user.active) return res.status(403).json({error:'SUBSCRIPTION_REQUIRED'});
    if(!checkDailyLimit(email)) return res.status(429).json({error:'DAILY_LIMIT_REACHED',plan:user.plan});
    if(charts?.length>1&&user.plan!=='pro') return res.status(403).json({error:'UPGRADE_REQUIRED',feature:'Multi-timeframe upload is Pro only'});
  }

  let chartList=[];
  if(charts?.length) chartList=charts;
  else if(imageBase64) chartList=[{base64:imageBase64,mime:imageMime||'image/png',label:timeframe||'Chart'}];
  else return res.status(400).json({error:'No image provided'});

  const sym=symbol||'Unknown', tf=timeframe||chartList[0]?.label||'1H';

  try{
    console.log(`\n[NexTrade] ⚡ ${sym} ${tf} — ${chartList.length} chart(s)`);
    const t0=Date.now();

    // All fast tasks in parallel
    const [structure, smc, livePrice, winStats] = await Promise.all([
      pass1a(chartList, sym, key),
      pass1b(chartList, sym, key),
      fetchLivePrice(sym).catch(()=>null),
      Promise.resolve(getWinStats())
    ]);
    const mktCtx = getMarketContext(sym);
    console.log(`[Step 1] ✓ Trend:${structure.trend} Align:${structure.alignment_score} Dir:${structure.tradeable_direction}`);

    const entry = await pass2(chartList, sym, structure, smc, livePrice, key);
    console.log(`[Step 2] ✓ Entry:${entry.entry_price} Quality:${entry.entry_quality} R:R:${entry.tp1_rr}`);

    const result = await pass3(chartList, sym, tf, structure, smc, entry, mktCtx, livePrice, winStats, key);
    console.log(`[Step 3] ✓ ${result.verdict} Grade:${result.signal_grade} Conf:${result.confidence}%`);

    const elapsed=((Date.now()-t0)/1000).toFixed(1);
    console.log(`[NexTrade] ⚡ Done in ${elapsed}s\n`);

    if(email) incrementUsage(email);

    if(result.verdict==='BUY'||result.verdict==='SELL'){
      const trades=loadTrades(); const id=Date.now().toString();
      trades.push({id,symbol:sym,timeframe:tf,verdict:result.verdict,grade:result.signal_grade,confidence:result.confidence,entry:result.entry,sl:result.sl,tp1:result.tp1,tp2:result.tp2,rr_tp1:result.rr_tp1,timestamp:new Date().toISOString(),outcome:null,actual_rr:null,userEmail:email});
      saveTrades(trades); result._trade_id=id;
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
app.post('/api/subscribe',(req,res)=>{const{email}=req.body;if(!email||!email.includes('@'))return res.status(400).json({error:'Invalid email'});const subs=loadSubs();if(subs.find(s=>s.email===email))return res.json({success:true});subs.push({email,active:true,subscribedAt:new Date().toISOString()});saveSubs(subs);console.log(`[Email] New subscriber: ${email}`);res.json({success:true});});
app.get('/api/trades',(req,res)=>{const email=req.headers['x-user-email'];res.json(loadTrades().filter(t=>!email||t.userEmail===email||!t.userEmail));});
app.get('/api/stats',(req,res)=>res.json(getWinStats()||{message:'No completed trades yet'}));
app.post('/api/trades/:id/outcome',(req,res)=>{const{outcome,actual_rr}=req.body;const trades=loadTrades();const t=trades.find(t=>t.id===req.params.id);if(!t)return res.status(404).json({error:'Not found'});t.outcome=outcome;t.actual_rr=actual_rr;t.closed_at=new Date().toISOString();saveTrades(trades);res.json({success:true,stats:getWinStats()});});
app.delete('/api/trades/:id',(req,res)=>{saveTrades(loadTrades().filter(t=>t.id!==req.params.id));res.json({success:true});});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{console.log(`\n  NexTrade AI — Running on port ${PORT}\n  Fixed: AI now gives real signals instead of always WAIT\n`);});
