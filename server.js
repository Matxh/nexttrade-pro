require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const app = express();

// ── Stripe webhook needs raw body BEFORE json middleware ──
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_URL = 'https://api.anthropic.com/v1/messages';
// Model routing: speed where it doesn't matter, power where it does
const HAIKU  = 'claude-haiku-4-5-20251001'; // Pass 1A + 1B (fast, parallel)
const SONNET = 'claude-sonnet-4-6';          // Pass 2 — entry precision
const OPUS   = 'claude-opus-4-6';            // Pass 3 — final verdict (max accuracy)

// ── FILE STORAGE (/tmp survives warm instances on Vercel) ──
const USERS_FILE  = '/tmp/nt_users.json';
const TRADES_FILE = '/tmp/nt_trades.json';
const SUBS_FILE   = '/tmp/nt_subscribers.json';

function loadUsers()  { try { return JSON.parse(fs.readFileSync(USERS_FILE,'utf8')); }  catch { return []; } }
function saveUsers(u)  { fs.writeFileSync(USERS_FILE,  JSON.stringify(u,  null, 2)); }
function loadTrades() { try { return JSON.parse(fs.readFileSync(TRADES_FILE,'utf8')); } catch { return []; } }
function saveTrades(t) { fs.writeFileSync(TRADES_FILE, JSON.stringify(t,  null, 2)); }
function loadSubs()   { try { return JSON.parse(fs.readFileSync(SUBS_FILE,'utf8'));  }  catch { return []; } }
function saveSubs(s)   { fs.writeFileSync(SUBS_FILE,   JSON.stringify(s,  null, 2)); }

// ── AUTH HELPERS ──
const JWT_SECRET = process.env.JWT_SECRET || 'nexttrade-change-me-in-vercel';

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const dot  = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  const [salt, key] = stored.split(':');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString('hex') === key);
    });
  });
}

// ── MIDDLEWARE ──
function authMiddleware(req, res, next) {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized — please log in' });
  const users = loadUsers();
  const user  = users.find(u => u.id === payload.userId);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  req.user  = user;
  req.users = users; // pass loaded array so requirePlan can save
  next();
}

function requirePlan(req, res, next) {
  const user = req.user;
  if (isWhitelisted(user)) return next(); // owner/team bypass
  if (!user.plan || user.subscriptionStatus !== 'active') {
    return res.status(403).json({
      error: 'subscription_required',
      message: 'An active subscription is required to run analyses.'
    });
  }
  if (user.plan === 'basic') {
    const today = new Date().toISOString().split('T')[0];
    const usage = user.dailyUsage || { date: '', count: 0 };
    if (usage.date !== today) { usage.date = today; usage.count = 0; }
    if (usage.count >= 10) {
      return res.status(403).json({
        error: 'limit_reached',
        message: 'Daily limit of 10 analyses reached. Upgrade to Pro for unlimited access.'
      });
    }
  }
  next();
}

// ── WHITELIST — free access for owner & team ──
// Add emails to WHITELISTED_EMAILS env var (comma-separated) or hard-code below
const WHITELIST = new Set([
  ...(process.env.WHITELISTED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
]);

function isWhitelisted(user) {
  return WHITELIST.has(user.email.toLowerCase());
}

// ── STRIPE ──
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('[Stripe] Initialized ✓');
  } else {
    console.log('[Stripe] STRIPE_SECRET_KEY not set — payments disabled');
  }
} catch (e) {
  console.log('[Stripe] Package not installed — run: npm install stripe');
}

// ─────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  if (!password || password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const users = loadUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Email already registered — please log in' });
  }

  const passwordHash = await hashPassword(password);
  const user = {
    id: crypto.randomBytes(16).toString('hex'),
    email: email.toLowerCase(),
    passwordHash,
    plan: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    dailyUsage: { date: '', count: 0 },
    createdAt: new Date().toISOString()
  };
  users.push(user);
  saveUsers(users);
  console.log(`[Auth] New signup: ${user.email}`);

  const token = signToken({ userId: user.id });
  res.json({ token, user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const users = loadUsers();
  const user  = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid)  return res.status(401).json({ error: 'Invalid email or password' });

  console.log(`[Auth] Login: ${user.email} (plan: ${user.plan || 'none'})`);
  const token = signToken({ userId: user.id });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const u     = req.user;
  const today = new Date().toISOString().split('T')[0];
  const usage = u.dailyUsage || { date: '', count: 0 };
  res.json({ ...safeUser(u), dailyUsageToday: usage.date === today ? usage.count : 0 });
});

function safeUser(u) {
  const whitelisted = isWhitelisted(u);
  return {
    id: u.id,
    email: u.email,
    plan: whitelisted ? 'pro' : u.plan,
    subscriptionStatus: whitelisted ? 'active' : u.subscriptionStatus
  };
}

// ─────────────────────────────────────────────
// STRIPE CHECKOUT & PORTAL
// ─────────────────────────────────────────────
app.post('/api/checkout/create', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured on the server' });
  const { plan } = req.body;
  const priceId  = plan === 'pro' ? process.env.STRIPE_PRO_PRICE_ID : process.env.STRIPE_BASIC_PRICE_ID;
  if (!priceId)  return res.status(500).json({ error: 'Price ID not configured for this plan' });

  const user    = req.user;
  const BASE    = process.env.BASE_URL || 'https://nexttrade-pro.vercel.app';
  const params  = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${BASE}/?checkout=success&plan=${plan}`,
    cancel_url:  `${BASE}/?checkout=cancel`,
    metadata:    { userId: user.id },
    subscription_data: { metadata: { userId: user.id } },
    allow_promotion_codes: true,
  };
  if (user.stripeCustomerId) {
    params.customer = user.stripeCustomerId;
  } else {
    params.customer_email = user.email;
  }

  try {
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkout/portal', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured on the server' });
  const user = req.user;
  if (!user.stripeCustomerId) return res.status(400).json({ error: 'No subscription found' });

  const BASE    = process.env.BASE_URL || 'https://nexttrade-pro.vercel.app';
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: BASE + '/',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// STRIPE WEBHOOK
// ─────────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[Webhook] Parse error:', err.message);
    return res.status(400).send('Webhook error: ' + err.message);
  }

  const users = loadUsers();
  let changed = false;

  const findUser = (fn) => users.find(fn);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata?.userId;
        const user    = findUser(u => u.id === userId);
        if (user && session.subscription) {
          const sub   = await stripe.subscriptions.retrieve(session.subscription);
          const pid   = sub.items.data[0]?.price?.id;
          user.plan                 = pid === process.env.STRIPE_PRO_PRICE_ID ? 'pro' : 'basic';
          user.stripeCustomerId      = session.customer;
          user.stripeSubscriptionId  = session.subscription;
          user.subscriptionStatus    = 'active';
          changed = true;
          console.log(`[Webhook] checkout.session.completed → ${user.email} now on ${user.plan}`);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub  = event.data.object;
        const user = findUser(u => u.stripeSubscriptionId === sub.id || u.stripeCustomerId === sub.customer);
        if (user) {
          const pid = sub.items.data[0]?.price?.id;
          user.plan               = pid === process.env.STRIPE_PRO_PRICE_ID ? 'pro' : 'basic';
          user.subscriptionStatus = sub.status === 'active' ? 'active' : sub.status;
          changed = true;
          console.log(`[Webhook] subscription.updated → ${user.email} plan=${user.plan} status=${user.subscriptionStatus}`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub  = event.data.object;
        const user = findUser(u => u.stripeSubscriptionId === sub.id || u.stripeCustomerId === sub.customer);
        if (user) {
          user.plan                = null;
          user.subscriptionStatus  = 'canceled';
          user.stripeSubscriptionId = null;
          changed = true;
          console.log(`[Webhook] subscription.deleted → ${user.email} access revoked`);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user    = findUser(u => u.stripeCustomerId === invoice.customer);
        if (user) {
          user.subscriptionStatus = 'past_due';
          changed = true;
          console.log(`[Webhook] payment_failed → ${user.email} marked past_due`);
        }
        break;
      }
    }
  } catch (err) {
    console.error('[Webhook] Handler error:', err.message);
  }

  if (changed) saveUsers(users);
  res.json({ received: true });
});

// ─────────────────────────────────────────────
// LIVE PRICE FETCHER
// ─────────────────────────────────────────────
async function fetchLivePrice(symbol) {
  if (!symbol || symbol === 'Unknown') return null;
  const sym = symbol.toUpperCase().replace('/','').replace(' ','').replace('-','');
  const sources = [
    async () => {
      const coinMap = { BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple',ADA:'cardano',DOGE:'dogecoin',AVAX:'avalanche-2',MATIC:'matic-network',DOT:'polkadot',LINK:'chainlink',UNI:'uniswap',ATOM:'cosmos',LTC:'litecoin' };
      const base = sym.replace('USDT','').replace('USD','').replace('BUSD','');
      const coinId = coinMap[base]; if (!coinId) return null;
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`, { timeout:5000 });
      const d = await r.json(); if (!d[coinId]) return null;
      return { price: d[coinId].usd, change24h: d[coinId].usd_24h_change?.toFixed(2), source:'CoinGecko' };
    },
    async () => {
      const pairs = { EURUSD:'EUR',GBPUSD:'GBP',USDJPY:'USD',AUDUSD:'AUD',USDCAD:'USD' };
      if (!pairs[sym]) return null;
      const base = sym.substring(0,3), quote = sym.substring(3,6);
      const r = await fetch(`https://open.er-api.com/v6/latest/${base}`, { timeout:5000 });
      const d = await r.json(); if (!d.rates?.[quote]) return null;
      return { price: d.rates[quote].toFixed(5), source:'ExchangeRate-API' };
    }
  ];
  for (const src of sources) { try { const r = await src(); if (r) return r; } catch { continue; } }
  return null;
}

// ─────────────────────────────────────────────
// MARKET CONTEXT
// ─────────────────────────────────────────────
function getMarketContext(symbol) {
  const ctx = { session:'', risk_events:[], market_hours:'' };
  const hour = new Date().getUTCHours();
  const day  = new Date().getDay();
  if (hour >= 22 || hour < 8)   ctx.session = 'Asia Session (22:00-08:00 UTC) — Lower liquidity';
  else if (hour >= 8 && hour < 12)  ctx.session = 'London Session Open (08:00-12:00 UTC) — High liquidity, major moves start here';
  else if (hour >= 12 && hour < 17) ctx.session = 'London/NY Overlap (12:00-17:00 UTC) — HIGHEST liquidity, best time to trade';
  else if (hour >= 17 && hour < 20) ctx.session = 'New York Session (17:00-20:00 UTC) — Good liquidity';
  else ctx.session = 'End of NY / Pre-Asia (20:00-22:00 UTC) — Low liquidity, avoid new positions';
  if (day === 1) ctx.market_hours = 'Monday — Watch for gaps, lower volume early';
  else if (day === 5) ctx.market_hours = 'Friday — End of week, close positions before weekend';
  else if (day === 0 || day === 6) ctx.market_hours = 'Weekend — Crypto open but low institutional volume';
  else ctx.market_hours = 'Mid-week — Optimal trading conditions';
  const sym = (symbol || '').toUpperCase();
  if (sym.includes('BTC') || sym.includes('ETH')) ctx.risk_events.push('Crypto: Best signals during NY/London overlap (12:00-17:00 UTC)');
  if (sym.includes('USD')) ctx.risk_events.push('USD: Watch for NFP (first Friday), CPI (mid-month), FOMC (every 6 weeks)');
  if (sym.includes('EUR') || sym.includes('GBP')) ctx.risk_events.push('EUR/GBP: ECB/BOE meetings can cause sharp moves');
  return ctx;
}

// ─────────────────────────────────────────────
// EMAIL ALERT SENDER
// ─────────────────────────────────────────────
async function sendEmailAlert(signal) {
  const subs = loadSubs().filter(s => s.active);
  if (!subs.length) return;
  if (!['A+','A'].includes(signal.signal_grade)) return;
  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  if (!SENDGRID_KEY) { console.log('[Email] No SENDGRID_API_KEY — skipping'); return; }
  const subject = `PriceAction AI Signal: ${signal.verdict} ${signal.symbol} — Grade ${signal.signal_grade} (${signal.confidence}% confidence)`;
  const body = `New ${signal.signal_grade} Grade Signal from PriceAction AI\n\nAsset: ${signal.symbol} ${signal.tf}\nSignal: ${signal.verdict}\nConfidence: ${signal.confidence}%\nGrade: ${signal.signal_grade}\n\nEntry: ${signal.entry}\nStop Loss: ${signal.sl}\nTP1: ${signal.tp1}\nTP2: ${signal.tp2 || 'N/A'}\nRisk/Reward: ${signal.rr_tp1 || 'N/A'}\n\nSummary:\n${signal.summary}\n\n---\nNot financial advice. Educational use only.\nPriceAction AI — nexttrade-pro.vercel.app`.trim();
  for (const sub of subs) {
    try {
      await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalizations:[{ to:[{ email:sub.email }] }], from:{ email: process.env.FROM_EMAIL||'signals@priceaction-ai.com', name:'PriceAction AI' }, subject, content:[{ type:'text/plain', value:body }] })
      });
    } catch (err) { console.error(`[Email] Failed for ${sub.email}:`, err.message); }
  }
}

// ─────────────────────────────────────────────
// CLAUDE API HELPER
// ─────────────────────────────────────────────
async function claude(apiKey, model, system, content, tokens = 2000) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model, max_tokens:tokens, system, messages:[{ role:'user', content }] })
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
  const d   = await r.json();
  const raw = (d.content || []).map(c => c.text || '').join('').trim();
  try { return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim()); }
  catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('JSON parse failed'); }
}
const img = (b64, mime) => ({ type:'image', source:{ type:'base64', media_type:mime||'image/png', data:b64 } });

// ─────────────────────────────────────────────
// PASS 1A — CHART STRUCTURE & SMC READING (Haiku — fast)
// Runs in PARALLEL with Pass 1B
// ─────────────────────────────────────────────
async function pass1A(charts, sym, key) {
  const n = charts.length;
  const sys = `You are an ICT/SMC chart reading machine. Your ONLY job is objective, bias-free reading of price structure and smart money concepts. No trading decisions — pure reading only.

DEFINITIONS YOU MUST APPLY PRECISELY:
- Order Block (OB): The LAST up-candle (bullish OB) before a strong bearish displacement, or LAST down-candle (bearish OB) before a strong bullish displacement. Must have caused a Break of Structure.
- Fair Value Gap (FVG): A 3-candle pattern where candle 1's high does NOT overlap candle 3's low (bullish FVG), or candle 1's low does NOT overlap candle 3's high (bearish FVG). Body-to-body, not wick.
- Break of Structure (BOS): Price closes BEYOND the most recent swing high (bullish BOS) or swing low (bearish BOS) in the DIRECTION of the current trend.
- Change of Character (CHOCH): First BOS AGAINST the current trend — signals potential reversal.
- Liquidity: Buy-side liquidity (BSL) = equal highs, prior swing highs, stop clusters above. Sell-side liquidity (SSL) = equal lows, prior swing lows, stops below.
- Displacement: A strong, impulsive move with large-bodied candles, minimal wicks, closing near extremes. Creates FVGs.
- Premium Zone: Above the 50% equilibrium of the current trading range. Institutional sellers.
- Discount Zone: Below the 50% equilibrium. Institutional buyers.
- Wyckoff Phases: Accumulation (spring/shakeout at lows) / Distribution (upthrust at highs) / Markup / Markdown.
${n > 1 ? 'CRITICAL MULTI-TF RULE: The HIGHEST timeframe bias is THE LAW. MTF alignment required. If HTF is bearish, you cannot call tradeable_direction Long. Conflicting timeframes = Wait.' : ''}

Return ONLY valid raw JSON — no markdown, no explanation:
{"timeframes":[${charts.map((_,i) => `{"chart_index":${i+1},"detected_tf":"<e.g. 1H>","trend":"Bullish/Bearish/Sideways","structure":"HH+HL/LH+LL/Ranging/Transitioning","wyckoff_phase":"Accumulation/Markup/Distribution/Markdown/Re-accumulation/Unknown","swing_high":"<exact price>","swing_low":"<exact price>","last_bos":"<price and direction>","last_choch":"<price or None>","key_ob":{"type":"Bullish/Bearish/None","zone":"<low>-<high>","caused_by":"<what displacement>","fresh":true},"fvg":{"type":"Bullish/Bearish/None","range":"<low>-<high>","filled_pct":"<0-100>%"},"liquidity":{"bsl":"<price — equal highs or prior swing high>","ssl":"<price — equal lows or prior swing low>","last_swept":"<BSL/SSL/None> at <price>"},"price_position":"Premium/Discount/Equilibrium","bias":"Bullish/Bearish/Neutral","notes":"<2-3 key observations>"}`).join(',')}],
"htf_bias":"Bullish/Bearish/Neutral",
"htf_key_ob":{"zone":"<low>-<high>","type":"Bullish/Bearish/None","fresh":true},
"htf_fvg":"<range or None>",
"htf_support":"<exact price>","htf_resistance":"<exact price>",
"mtf_alignment":"Perfect Bull/Perfect Bear/Partial Bull/Partial Bear/Mixed/Conflicting",
"alignment_score":<0-100>,
"tradeable_direction":"Long/Short/Wait",
"current_price":"<best estimate from chart>",
"price_position":"Premium/Discount/Equilibrium",
"equilibrium":"<exact 50% price of visible range>",
"range_high":"<highest visible price>","range_low":"<lowest visible price>",
"displacement_present":true,
"institutional_bias":"Bullish/Bearish/Neutral",
"liquidity_target":"<next likely liquidity grab — price and type>",
"key_levels":[{"price":"<exact>","type":"Resistance/Support/OB/FVG/Liquidity","strength":"Major/Minor","reason":"<specific ICT reason>"}],
"indicators":{"ema_stack":"<e.g. price above 20/50/200 EMA or below>","rsi":"<value and condition>","macd":"<signal>","volume":"<above/below average, notable spikes>"},
"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","location":"<price>"}],
"reading_confidence":<0-100>,
"summary":"<5 sentences: HTF bias, current structure phase, key OB/FVG locations, liquidity situation, overall setup quality>"}`;
  const content = [
    ...charts.map((c, i) => [
      { type:'text', text:`Chart ${i+1} — ${charts.length > 1 ? c.label : sym}:` },
      img(c.base64, c.mime)
    ]).flat(),
    { type:'text', text:`Read all ${n} chart${n>1?'s':''} for ${sym}. Apply ICT/SMC definitions exactly. Report exact prices. No fabrication.` }
  ];
  return claude(key, HAIKU, sys, content, 3000);
}

// ─────────────────────────────────────────────
// PASS 1B — TIMING & CONTEXT FILTER (Haiku — fast)
// Runs in PARALLEL with Pass 1A — does NOT need 1A output
// ─────────────────────────────────────────────
async function pass1B(charts, sym, livePrice, mktCtx, winStats, key) {
  const lp = livePrice ? `Live price: $${livePrice.price} (${livePrice.change24h||'?'}% 24h change)` : 'Live price: unavailable';
  const ws = winStats  ? `Journal stats: ${winStats.winRate}% win rate over ${winStats.total} completed trades. Best grade: ${Object.entries(winStats.byGrade||{}).sort((a,b)=>(b[1].wins/(b[1].wins+b[1].losses||1))-(a[1].wins/(a[1].wins+a[1].losses||1)))[0]?.[0]||'N/A'}.` : 'No journal history yet.';
  const sys = `You are a trading session and context filter. Assess whether RIGHT NOW is an appropriate time to enter a trade based on session, news risk, and day-of-week conditions. You have NO trading bias — just filter timing.

SESSION QUALITY RULES:
- London/NY Overlap (12:00-17:00 UTC): Excellent — highest institutional activity
- London Open (08:00-12:00 UTC): Good — major moves begin
- NY Session (17:00-20:00 UTC): Good — continued institutional flow
- Asia Session (22:00-08:00 UTC): Poor — low institutional volume, choppy
- End of NY / Pre-Asia (20:00-22:00 UTC): Avoid — dead zone

DAY RISK RULES:
- Monday: Caution — gaps possible, volume ramps up slowly
- Tuesday-Thursday: Low risk — optimal trading days
- Friday: Medium risk — close positions before weekend, avoid new entries after 17:00 UTC
- Saturday/Sunday: High risk for non-crypto (markets closed); crypto only with reduced size

NEWS RISK: If it's a major central bank decision day (FOMC, ECB, BOE) or NFP Friday → High. Otherwise assess from context.

Return ONLY valid raw JSON:
{"session":"<current session name>","session_quality":"Excellent/Good/Poor/Avoid","session_note":"<why>",
"live_price_note":"<is live price near key level, extended from range, etc>",
"news_risk":"High/Medium/Low","news_note":"<reason>",
"day_of_week_risk":"High/Medium/Low","day_note":"<reason>",
"weekend_risk":false,
"historical_edge":"<what journal stats suggest about current conditions>",
"context_score":<0-100>,"context_bias":"Proceed/Caution/Wait/Avoid",
"risk_multiplier":<0.5-1.5>,
"summary":"<3 sentences: session quality, news/day risk, overall timing verdict>"}`;
  return claude(key, HAIKU, sys, [
    img(charts[0].base64, charts[0].mime),
    { type:'text', text:`Asset: ${sym}\n${lp}\nCurrent UTC session: ${mktCtx.session}\nDay: ${mktCtx.market_hours}\nRisk events: ${mktCtx.risk_events.join('; ') || 'None identified'}\n${ws}\n\nIs NOW a good time to trade ${sym}?` }
  ], 1000);
}

// ─────────────────────────────────────────────
// PASS 2 — PRECISION ENTRY ARCHITECT (Sonnet)
// Runs after 1A + 1B complete
// ─────────────────────────────────────────────
async function pass2(charts, sym, reading, ctx, livePrice, key) {
  const lp = livePrice ? `Live price: $${livePrice.price}` : 'Live price: N/A';
  const dir = reading.tradeable_direction;
  const sys = `You are an elite ICT entry specialist. Your job: find the SINGLE best entry setup given the chart reading and context. Entries must be at institutional price levels — NOT random.

ENTRY HIERARCHY (use highest available):
1. OB + FVG confluence at discount (longs) or premium (shorts) = A+ entry
2. Fresh OB alone at key HTF level = A entry
3. FVG fill at structure level = A entry
4. Key support/resistance reaction with displacement candle = B entry
5. Anything else = C/D — do NOT force it

STOP LOSS RULES:
- Stop goes BELOW the OB low (longs) or ABOVE the OB high (shorts), with a 0.5-1% buffer
- NEVER place stop at a round number or equal low/high (that's where stops get hunted)
- Tight stops only when OB is well-defined

TAKE PROFIT RULES:
- TP1 = nearest liquidity pool (equal highs/lows, prior swing) — must be cleared by price
- TP2 = next major structural level or HTF OB
- TP3 = maximum extension / opposite liquidity
- MINIMUM 1:2.5 R:R to TP1 required. If not achievable → entry_quality must be C or D.

ENTRY TRIGGER:
- For limit orders: specify the exact candle confirmation needed (e.g. "bullish engulfing on 15m within OB zone", "pin bar rejection at FVG")
- For market: only if price is currently AT the zone with active displacement

Return ONLY valid raw JSON:
{"entry_type":"Limit/Stop-Limit/Market/Wait","entry_price":"<exact>","entry_zone":"<low>-<high>",
"entry_trigger":"<specific candle/pattern confirmation required before entering>",
"entry_quality":"A+/A/B/C/D",
"entry_rationale":"<why this specific price — OB, FVG, confluence>",
"sl_price":"<exact>","sl_reason":"<structural reason — below OB, below swing, etc>",
"sl_pct":"<% distance from entry>",
"tp1_price":"<exact>","tp1_reason":"<liquidity target or structure>","tp1_rr":"1:<X.X>",
"tp2_price":"<exact>","tp2_reason":"<>","tp2_rr":"1:<X.X>",
"tp3_price":"<exact>","tp3_rr":"1:<X.X>",
"obstacles_to_tp1":"<any S/R, OBs, FVGs between entry and TP1>",
"obstacles_to_tp2":"<>",
"trade_management":{"move_to_be":"<when — e.g. after TP1 hit or +1R>","partial_at_tp1":"<% to close>","trail_after_tp1":"<method>","max_hold_time":"<>"},
"position_size_guidance":"<% account risk — max 1% for B, max 2% for A+>",
"invalidation":"<exact price that kills the setup>",
"summary":"<4 sentences: entry location and why, stop rationale, TP targets, trade management>"}`;
  return claude(key, SONNET, sys, [
    img(charts[0].base64, charts[0].mime),
    { type:'text', text:`Find best ${dir} entry for ${sym}.\n${lp}\nHTF bias: ${reading.htf_bias} | Alignment: ${reading.alignment_score}/100 | Price position: ${reading.price_position}\nKey OB: ${JSON.stringify(reading.htf_key_ob)}\nFVG: ${reading.htf_fvg}\nLiquidity target: ${reading.liquidity_target}\nKey levels: ${JSON.stringify(reading.key_levels?.slice(0,5))}\nContext: ${ctx.context_bias} | Session: ${ctx.session_quality} | Risk: ${ctx.news_risk}` }
  ], 2500);
}

// ─────────────────────────────────────────────
// PASS 3 — FINAL VERDICT + FULL ANALYSIS (Opus — max accuracy)
// ─────────────────────────────────────────────
async function pass3(charts, sym, tf, reading, ctx, entry, livePrice, mktCtx, winStats, key) {
  const lp = livePrice ? `Live: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)` : 'Live: N/A';
  const ws = winStats  ? `Journal: ${winStats.winRate}% WR / ${winStats.total} trades` : 'No history';
  const sys = `You are the Chief Trading Officer of a top-tier hedge fund. You receive a full ICT/SMC analysis and make the FINAL trading decision. You apply 12 strict quality gates. Your reputation depends on only issuing A+ and A signals on genuinely elite setups.

══ 12 QUALITY GATES — ALL must pass for BUY/SELL. ANY failure → WAIT ══
G1:  MTF alignment_score < 65 → WAIT (need strong agreement across timeframes)
G2:  tradeable_direction is "Wait" → WAIT (conflicting timeframes)
G3:  session_quality is "Poor" or "Avoid" → WAIT (wrong session)
G4:  news_risk is "High" → WAIT (central bank / NFP / major event)
G5:  day_of_week_risk is "High" → WAIT (weekend, Monday gap risk)
G6:  entry_quality is "C" or "D" → WAIT (no valid institutional entry found)
G7:  tp1_rr < 1:2.5 → WAIT (R:R too low for institutional standard)
G8:  major obstacle (unfilled OB or FVG) between entry and TP1 → WAIT (will act as resistance/support)
G9:  price_position is "Premium" for Long entries → WAIT (buying at institutional sell zone)
G10: price_position is "Discount" for Short entries → WAIT (selling at institutional buy zone)
G11: No displacement candle / no clear entry trigger → WAIT (no institutional footprint)
G12: context_bias is "Avoid" → WAIT (market timing is wrong)

══ GRADING ══
A+: All 12 pass + 6+ confluences + 1:3+ R:R + alignment ≥ 80 + Excellent session + fresh OB
A:  All 12 pass + 4-5 confluences + 1:2.5+ R:R + alignment ≥ 70
B:  All 12 pass + 3 confluences + 1:2.5 R:R + alignment ≥ 65
C:  Borderline pass — lower conviction, smaller size
D:  Multiple concerns — WAIT preferred

Return ONLY valid raw JSON (no markdown):
{"verdict":"BUY/SELL/WAIT","confidence":<40-95>,"signal_grade":"A+/A/B/C/D",
"gates_passed":["G1 ✓ — alignment 78/100","G2 ✓"],"gates_failed":["G8 ✗ — unfilled FVG at 43200 between entry and TP1"],
"wait_reason":"<specific reason if WAIT, empty string if BUY/SELL>",
"market_phase":"<Wyckoff phase>","price_position":"Premium/Discount/Equilibrium",
"market_bias":"Strongly Bullish/Bullish/Neutral/Bearish/Strongly Bearish",
"summary":"<10-12 sentences covering: HTF institutional bias and why, MTF alignment details with prices, price position in range and significance, all SMC/ICT confluences with exact prices, gate results summary, session and news context, live price confirmation, exact entry plan with trigger, complete SL/TP levels with structural reasoning, position sizing, full trade thesis and probability assessment>",
"entry":"<exact price>","entry_trigger":"<specific confirmation needed>","entry_zone":"<low>-<high>","entry_available_now":true,
"sl":"<exact price>","sl_reason":"<structural reason>",
"tp1":"<exact price>","tp1_reason":"<liquidity/structure>",
"tp2":"<exact price>","tp2_reason":"<>",
"tp3":"<exact price>",
"rr_tp1":"1:<X.X>","rr_tp2":"1:<X.X>","rrLabel":"Poor/Acceptable/Good/Excellent",
"position_size":"<e.g. 1% account risk>",
"confluences":["<1 — specific with price>","<2>","<3>","<4>","<5>","<6>","<7 if A+>"],
"key_levels":{"major_resistance":"<price>","minor_resistance":"<price>","equilibrium":"<price>","major_support":"<price>","minor_support":"<price>"},
"smart_money":{"bullish_ob":"<zone>","bearish_ob":"<zone>","bullish_fvg":"<zone>","bearish_fvg":"<zone>","bsl":"<price>","ssl":"<price>","last_sweep":"<what was swept>","bos_choch":"<latest BOS or CHOCH price and direction>","displacement":"<describe the key displacement>","next_target":"<most likely next liquidity grab>"},
"factors":[{"name":"HTF Trend","score":<0-100>,"note":"<>"},{"name":"MTF Alignment","score":<0-100>,"note":"<>"},{"name":"Entry Quality","score":<0-100>,"note":"<>"},{"name":"Risk/Reward","score":<0-100>,"note":"<>"},{"name":"Session Timing","score":<0-100>,"note":"<>"},{"name":"SMC Confluence","score":<0-100>,"note":"<>"},{"name":"Price Position","score":<0-100>,"note":"<>"}],
"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","significance":"<>","price":"<>"}],
"indicators":{"ema":"<stack and significance>","rsi":"<value and divergence if any>","macd":"<signal>","volume":"<notable observations>"},
"invalidation":{"immediate":"<price that invalidates instantly — close below/above>","warning":"<early warning level>","full_scenario":"<full invalidation scenario>"},
"trade_management":{"move_to_be":"<condition>","partial_tp1":"<% — typically 50%>","trail_method":"<e.g. trail stop below each new HL>","max_hold":"<time>","scale_in":"<if applicable>"},
"candle_analysis":"<last 3-5 candles description and what they indicate>",
"best_case":"<maximum bullish/bearish scenario>","worst_case":"<what happens if setup fails>",
"fullAnalysis":"<20-25 sentences of elite institutional-grade HTML. Use <strong> for key prices and concepts. Structure: [1-3] Institutional context and HTF bias with exact OB/FVG prices. [4-6] MTF alignment assessment with each timeframe's bias and key level. [7-9] Price position and range analysis — where we are relative to equilibrium, premium/discount zones. [10-13] Full SMC/ICT setup breakdown — OBs, FVGs, liquidity pools, sweep, BOS/CHOCH, displacement candle details. [14-15] All 12 gate results with pass/fail. [16-17] Session, news, and timing context. [18-19] Entry plan — exact price, trigger, zone, rationale. [20-21] SL and all TP levels with structural justification and R:R. [22-23] Position sizing, trade management plan step by step. [24-25] Invalidation levels, probability assessment, and final trade thesis.>"}`;

  return claude(key, OPUS, sys, [
    ...charts.map(c => img(c.base64, c.mime)),
    { type:'text', text:`FINAL DECISION — ${sym} ${tf}\n${lp}\nSession: ${mktCtx.session}\n${ws}\n\nPASS 1A (Structure):\n${JSON.stringify(reading)}\n\nPASS 1B (Context):\n${JSON.stringify(ctx)}\n\nPASS 2 (Entry):\n${JSON.stringify(entry)}\n\nApply all 12 gates. Be strict. Only issue BUY/SELL if this is a genuinely elite setup.` }
  ], 6000);
}

function getWinStats() {
  const trades = loadTrades().filter(t => t.outcome);
  if (!trades.length) return null;
  const wins   = trades.filter(t => t.outcome === 'win').length;
  const avgRR  = trades.filter(t => t.actual_rr).reduce((s,t) => s + t.actual_rr, 0) / trades.filter(t => t.actual_rr).length || 0;
  const byGrade = {};
  trades.forEach(t => { if (!byGrade[t.grade]) byGrade[t.grade] = { wins:0, losses:0 }; byGrade[t.grade][t.outcome === 'win' ? 'wins' : 'losses']++; });
  return { total:trades.length, wins, losses:trades.length-wins, winRate:Math.round(wins/trades.length*100), avgRR:avgRR.toFixed(2), byGrade };
}

// ─────────────────────────────────────────────
// MAIN ANALYZE ENDPOINT — requires auth + active plan
// ─────────────────────────────────────────────
app.post('/api/analyze', authMiddleware, requirePlan, async (req, res) => {
  const { charts, imageBase64, imageMime, symbol, timeframe } = req.body;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  let chartList = [];
  if (charts && charts.length)  chartList = charts;
  else if (imageBase64) chartList = [{ base64:imageBase64, mime:imageMime||'image/png', label:timeframe||'Chart' }];
  else return res.status(400).json({ error: 'No image provided' });

  const sym = symbol || 'Unknown';
  const tf  = timeframe || chartList[0]?.label || '1H';

  try {
    console.log(`\n[PriceAction] ═══ ${sym} ${tf} — ${chartList.length} chart(s) — user:${req.user.email} ═══`);
    const t0 = Date.now();

    // ── Phase 1: Fetch external data (parallel) ──
    const [livePrice, winStats] = await Promise.all([
      fetchLivePrice(sym).catch(() => null),
      Promise.resolve(getWinStats())
    ]);
    const mktCtx = getMarketContext(sym);
    console.log(`[Data] ✓ Price:${livePrice ? '$'+livePrice.price : 'N/A'} | Session: ${mktCtx.session.split('(')[0].trim()}`);

    // ── Phase 2: Pass 1A + 1B in PARALLEL (both use Haiku — fast) ──
    console.log('[Pass 1A+1B] Chart structure + context filter running in parallel…');
    const [reading, ctx] = await Promise.all([
      pass1A(chartList, sym, key),
      pass1B(chartList, sym, livePrice, mktCtx, winStats, key)
    ]);
    console.log(`[Pass 1A] ✓ Bias:${reading.htf_bias} | Alignment:${reading.alignment_score}/100 | Dir:${reading.tradeable_direction} | Conf:${reading.reading_confidence}%`);
    console.log(`[Pass 1B] ✓ Session:${ctx.session_quality} | News:${ctx.news_risk} | Context:${ctx.context_bias} | Score:${ctx.context_score}/100`);

    // ── Phase 3: Entry architecture (Sonnet) — skip if conditions clearly wrong ──
    let entry = { entry_quality:'D', tp1_rr:'0:0', summary:'Skipped — conditions not met for entry search' };
    const shouldRunEntry = reading.alignment_score >= 55
      && reading.tradeable_direction !== 'Wait'
      && ctx.context_bias !== 'Avoid'
      && ctx.news_risk !== 'High'
      && ctx.session_quality !== 'Avoid';

    if (shouldRunEntry) {
      console.log('[Pass 2] Entry architecture (Sonnet)…');
      entry = await pass2(chartList, sym, reading, ctx, livePrice, key);
      console.log(`[Pass 2] ✓ Entry:${entry.entry_price} | SL:${entry.sl_price} | TP1:${entry.tp1_price} | R:R:${entry.tp1_rr} | Quality:${entry.entry_quality}`);
    } else {
      console.log('[Pass 2] Skipped — alignment/session/context conditions not met');
    }

    // ── Phase 4: Final verdict (Opus — max accuracy) ──
    console.log('[Pass 3] Final verdict (Opus)…');
    const result  = await pass3(chartList, sym, tf, reading, ctx, entry, livePrice, mktCtx, winStats, key);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[Pass 3] ✓ VERDICT:${result.verdict} | Grade:${result.signal_grade} | Conf:${result.confidence}% | ${elapsed}s total`);

    // Track daily usage for basic plan
    const user  = req.user;
    const users = req.users;
    if (user.plan === 'basic') {
      const today = new Date().toISOString().split('T')[0];
      const usage = user.dailyUsage || { date:'', count:0 };
      if (usage.date !== today) { usage.date = today; usage.count = 0; }
      usage.count++;
      user.dailyUsage = usage;
      saveUsers(users);
    }

    // Auto-save to journal
    if (result.verdict === 'BUY' || result.verdict === 'SELL') {
      const trades  = loadTrades();
      const tradeId = Date.now().toString();
      trades.push({ id:tradeId, symbol:sym, timeframe:tf, verdict:result.verdict, grade:result.signal_grade, confidence:result.confidence, entry:result.entry, sl:result.sl, tp1:result.tp1, tp2:result.tp2, rr_tp1:result.rr_tp1, timestamp:new Date().toISOString(), outcome:null, actual_rr:null });
      saveTrades(trades);
      result._trade_id = tradeId;
      sendEmailAlert({ ...result, symbol:sym, tf }).catch(console.error);
    }

    result._meta = { analysis_time_seconds:parseFloat(elapsed), charts_analyzed:chartList.length, live_price:livePrice, market_context:mktCtx, win_stats:winStats };
    res.json(result);
  } catch (err) {
    console.error('[PriceAction] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

// ─────────────────────────────────────────────
// EMAIL SUBSCRIPTION ENDPOINTS
// ─────────────────────────────────────────────
app.post('/api/subscribe', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  const subs = loadSubs();
  if (subs.find(s => s.email === email)) return res.json({ success:true, message:'Already subscribed' });
  subs.push({ email, active:true, subscribedAt:new Date().toISOString() });
  saveSubs(subs);
  res.json({ success:true, message:'Subscribed successfully' });
});

app.get('/api/subscribers', (req, res) => {
  const subs = loadSubs();
  res.json({ total:subs.length, active:subs.filter(s=>s.active).length });
});

app.delete('/api/subscribe/:email', (req, res) => {
  const subs = loadSubs();
  const sub  = subs.find(s => s.email === decodeURIComponent(req.params.email));
  if (sub) { sub.active = false; saveSubs(subs); }
  res.json({ success:true });
});

// ─────────────────────────────────────────────
// TRADE JOURNAL ENDPOINTS (auth required)
// ─────────────────────────────────────────────
app.get('/api/trades',  authMiddleware, (req, res) => res.json(loadTrades()));
app.get('/api/stats',   authMiddleware, (req, res) => res.json(getWinStats() || { message:'No completed trades yet' }));

app.post('/api/trades/:id/outcome', authMiddleware, (req, res) => {
  const { outcome, actual_rr, notes } = req.body;
  const trades = loadTrades();
  const trade  = trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  trade.outcome   = outcome;
  trade.actual_rr = actual_rr;
  trade.notes     = notes || '';
  trade.closed_at = new Date().toISOString();
  saveTrades(trades);
  res.json({ success:true, stats:getWinStats() });
});

app.delete('/api/trades/:id', authMiddleware, (req, res) => {
  let trades = loadTrades();
  trades = trades.filter(t => t.id !== req.params.id);
  saveTrades(trades);
  res.json({ success:true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   PriceAction AI — Auth + Stripe Edition    ║`);
  console.log(`  ║   Payments: ${stripe ? 'ACTIVE ✓' : 'DISABLED (no key)'}              ║`);
  console.log(`  ║   http://localhost:${PORT}                  ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
