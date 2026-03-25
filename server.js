require('dotenv').config();
const express      = require('express');
const fetch        = require('node-fetch');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const { jsonrepair } = require('jsonrepair'); // top-level so Vercel bundles it correctly

const app = express();

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));

// ── Static files — must be FIRST before any auth routes ──────────────
// Explicitly serve PWA files so they never hit auth middleware
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public', 'manifest.json')));
app.get('/sw.js',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'sw.js')));
app.use(express.static(path.join(__dirname, 'public')));

const API_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU   = 'claude-haiku-4-5-20251001';
const SONNET  = 'claude-sonnet-4-6';
const OPUS    = 'claude-opus-4-6';

// ─────────────────────────────────────────────
// GITHUB STORAGE — persistent across deploys
// ─────────────────────────────────────────────
const GH_TOKEN  = process.env.GH_DB_TOKEN;
const GH_REPO   = 'Matxh/priceaction-db';
const GH_API    = 'https://api.github.com';

// In-memory cache — eliminates GitHub read latency on every request
const _cache = {};
const CACHE_TTL = 120000; // 2 minutes — reduces GitHub API calls, speeds up all requests

async function ghRead(file) {
  // Return cached value if fresh (30s TTL — avoids hammering GitHub on every request)
  if (_cache[file] && Date.now() - _cache[file].ts < CACHE_TTL) return _cache[file].val;
  try {
    const r = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${file}`, {
      headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
      timeout: 6000   // ← CRITICAL: without this, GitHub hangs block every request
    });
    if (!r.ok) return _cache[file]?.val || null;
    const d = await r.json();
    const val = { data: JSON.parse(Buffer.from(d.content, 'base64').toString()), sha: d.sha };
    _cache[file] = { val, ts: Date.now() };
    return val;
  } catch { return _cache[file]?.val || null; }
}

async function ghWrite(file, data, sha) {
  // Update cache immediately so next read is instant
  _cache[file] = { val: { data, sha }, ts: Date.now() };
  try {
    await fetch(`${GH_API}/repos/${GH_REPO}/contents/${file}`, {
      method: 'PUT',
      headers: { Authorization: `token ${GH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `update ${file}`, content: Buffer.from(JSON.stringify(data)).toString('base64'), sha }),
      timeout: 8000
    });
  } catch(e) { console.warn('[GH] write failed:', e.message); }
}

async function getUserByEmail(email) {
  const r = await ghRead('users.json');
  return r ? (r.data[email.toLowerCase()] || null) : null;
}
async function getUserById(id) {
  const r = await ghRead('users.json');
  if (!r) return null;
  return Object.values(r.data).find(u => u.id === id) || null;
}
async function saveUser(user) {
  const r = await ghRead('users.json');
  const data = r ? r.data : {};
  data[user.email.toLowerCase()] = user;
  await ghWrite('users.json', data, r?.sha);
}
async function getAllUsers() {
  const r = await ghRead('users.json');
  return r ? Object.values(r.data) : [];
}
async function getTrades() {
  const r = await ghRead('trades.json');
  return r ? r.data : [];
}
async function saveTrades(t) {
  const r = await ghRead('trades.json');
  await ghWrite('trades.json', t, r?.sha);
}
async function getSubs() {
  const r = await ghRead('subs.json');
  return r ? r.data : [];
}
async function saveSubs(s) {
  const r = await ghRead('subs.json');
  await ghWrite('subs.json', s, r?.sha);
}

// ─────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'priceaction-change-me-in-vercel';

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

async function verifyPassword(password, stored) {
  const [salt, key] = stored.split(':');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString('hex') === key);
    });
  });
}

// ─────────────────────────────────────────────
// WHITELIST — free access for owner & team
// ─────────────────────────────────────────────
const WHITELIST = new Set([
  ...(process.env.WHITELISTED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
  'llakorr10@gmail.com',
  'matthewbrouard20@gmail.com'
]);
function isWhitelisted(user) { return WHITELIST.has((user.email || '').toLowerCase()); }

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

// In-memory user cache — avoids hitting GitHub on every single request
const _userCache = {};
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function authMiddleware(req, res, next) {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized — please log in' });

  // Serve from user cache if fresh — skips GitHub entirely
  const cached = _userCache[payload.userId];
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL) {
    req.user = cached.user;
    return next();
  }

  const user = await getUserById(payload.userId);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  _userCache[payload.userId] = { user, ts: Date.now() };
  req.user = user;
  next();
}

function requirePlan(req, res, next) {
  const user = req.user;
  if (isWhitelisted(user)) return next();
  if (!user.plan || user.subscriptionStatus !== 'active') {
    return res.status(403).json({ error: 'subscription_required', message: 'An active subscription is required.' });
  }
  const today = new Date().toISOString().split('T')[0];
  const usage = user.dailyUsage || { date: '', count: 0 };
  if (usage.date !== today) { usage.date = today; usage.count = 0; }
  if (user.plan === 'basic' && usage.count >= 10) {
    return res.status(403).json({ error: 'limit_reached', message: 'Daily limit of 10 analyses reached. Upgrade to Pro.' });
  }
  if (user.plan === 'pro' && usage.count >= 30) {
    return res.status(403).json({ error: 'limit_reached', message: 'Daily limit of 30 analyses reached. Resets at midnight UTC.' });
  }
  next();
}

// ─────────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────────
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('[Stripe] Initialized ✓');
  } else {
    console.log('[Stripe] STRIPE_SECRET_KEY not set — payments disabled');
  }
} catch(e) {
  console.log('[Stripe] Package not installed — run: npm install stripe');
}

// ─────────────────────────────────────────────
// PING
// ─────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ ok: true }));
app.get('/api/dbping', (req, res) => res.json({ ok: true, storage: 'Vercel KV — persistent storage' }));

// ── LIVE DIAGNOSTIC — tests each step and returns timing ────────────────────
app.get('/api/test-live', async (req, res) => {
  const sym = (req.query.sym || 'SPY').toUpperCase();
  const key = process.env.ANTHROPIC_API_KEY;
  const out = { sym, steps: {} };
  const t0 = Date.now();
  try {
    // Step 1: OHLCV
    try {
      const d = await withTimeout(fetchOHLCV(sym, '15m', 10), 8000);
      out.steps.ohlcv = d ? `OK — ${d.candles.length} candles from ${d.source}` : 'FAIL — no data';
    } catch(e) { out.steps.ohlcv = 'FAIL — ' + e.message; }
    // Step 2: Claude
    if (!key) { out.steps.claude = 'SKIP — ANTHROPIC_API_KEY not set'; }
    else {
      try {
        const r = await withTimeout(claude(key, HAIKU, 'Reply with only valid JSON: {"ok":true}', [{ type:'text', text:'ping' }], 20), 15000);
        out.steps.claude = r?.ok === true ? 'OK' : 'FAIL — unexpected response: ' + JSON.stringify(r);
      } catch(e) { out.steps.claude = 'FAIL — ' + e.message; }
    }
    out.totalMs = Date.now() - t0;
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message, out }); }
});

// ─────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = await getUserByEmail(email);
  if (existing) return res.status(400).json({ error: 'Email already registered — please log in' });

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
  saveUser(user);
  console.log(`[Auth] New signup: ${user.email}`);
  const token = signToken({ userId: user.id });
  res.json({ token, user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = await getUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  console.log(`[Auth] Login: ${user.email}`);
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

  const user = req.user;
  const BASE = process.env.BASE_URL || 'https://nexttrade-pro.vercel.app';
  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${BASE}/?checkout=success&plan=${plan}`,
    cancel_url:  `${BASE}/?checkout=cancel`,
    metadata: { userId: user.id },
    subscription_data: { metadata: { userId: user.id } },
    allow_promotion_codes: true,
  };
  if (user.stripeCustomerId) params.customer = user.stripeCustomerId;
  else params.customer_email = user.email;

  try {
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch(err) {
    console.error('[Stripe] Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkout/portal', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured' });
  const user = req.user;
  if (!user.stripeCustomerId) return res.status(400).json({ error: 'No subscription found' });
  const BASE = process.env.BASE_URL || 'https://nexttrade-pro.vercel.app';
  try {
    const session = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: BASE + '/' });
    res.json({ url: session.url });
  } catch(err) {
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
  } catch(err) {
    return res.status(400).send('Webhook error: ' + err.message);
  }

  try {
    switch(event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata?.userId;
        if (userId && session.subscription) {
          const sub  = await stripe.subscriptions.retrieve(session.subscription);
          const pid  = sub.items.data[0]?.price?.id;
          const plan = pid === process.env.STRIPE_PRO_PRICE_ID ? 'pro' : 'basic';
          const user = await getUserById(userId);
          if (user) { Object.assign(user, { plan, stripeCustomerId: session.customer, stripeSubscriptionId: session.subscription, subscriptionStatus: 'active' }); await saveUser(user); }
          console.log(`[Webhook] checkout.session.completed → ${userId} now on ${plan}`);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub  = event.data.object;
        const pid  = sub.items.data[0]?.price?.id;
        const plan = pid === process.env.STRIPE_PRO_PRICE_ID ? 'pro' : 'basic';
        const status = sub.status === 'active' ? 'active' : sub.status;
        const allUsers1 = await getAllUsers();
        const user1  = allUsers1.find(u => u.stripeSubscriptionId === sub.id || u.stripeCustomerId === sub.customer);
        if (user1) { Object.assign(user1, { plan, subscriptionStatus: status }); await saveUser(user1); }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub  = event.data.object;
        const allUsers2 = await getAllUsers();
        const user2  = allUsers2.find(u => u.stripeSubscriptionId === sub.id || u.stripeCustomerId === sub.customer);
        if (user2) { Object.assign(user2, { plan: null, subscriptionStatus: 'canceled', stripeSubscriptionId: null }); await saveUser(user2); }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const allUsers3 = await getAllUsers();
        const user3 = allUsers3.find(u => u.stripeCustomerId === invoice.customer);
        if (user3) { user3.subscriptionStatus = 'past_due'; await saveUser(user3); }
        break;
      }
    }
  } catch(err) { console.error('[Webhook] Handler error:', err.message); }

  res.json({ received: true });
});

// ─────────────────────────────────────────────
// LIVE PRICE
// ─────────────────────────────────────────────
async function fetchLivePrice(symbol) {
  if (!symbol || symbol === 'Unknown') return null;
  const sym = symbol.toUpperCase().replace('/','').replace(' ','').replace('-','');
  const sources = [
    async () => {
      const coinMap = { BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple',ADA:'cardano',DOGE:'dogecoin',AVAX:'avalanche-2',MATIC:'matic-network',DOT:'polkadot',LINK:'chainlink',UNI:'uniswap',ATOM:'cosmos',LTC:'litecoin' };
      const base   = sym.replace('USDT','').replace('USD','').replace('BUSD','');
      const coinId = coinMap[base]; if (!coinId) return null;
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`, { timeout:5000 });
      const d = await r.json(); if (!d[coinId]) return null;
      return { price: d[coinId].usd, change24h: d[coinId].usd_24h_change?.toFixed(2), source:'CoinGecko' };
    },
    async () => {
      const pairs = { EURUSD:'EUR',GBPUSD:'GBP',USDJPY:'USD',AUDUSD:'AUD',USDCAD:'USD' };
      if (!pairs[sym]) return null;
      const base  = sym.substring(0,3), quote = sym.substring(3,6);
      const r = await fetch(`https://open.er-api.com/v6/latest/${base}`, { timeout:5000 });
      const d = await r.json(); if (!d.rates?.[quote]) return null;
      return { price: d.rates[quote].toFixed(5), source:'ExchangeRate-API' };
    }
  ];
  for (const src of sources) { try { const r = await src(); if (r) return r; } catch { continue; } }
  return null;
}

function getMarketContext(symbol) {
  const ctx  = { session:'', risk_events:[], market_hours:'' };
  const hour = new Date().getUTCHours();
  const day  = new Date().getDay();
  if (hour >= 22 || hour < 8)        ctx.session = 'Asia Session (22:00-08:00 UTC) — Lower liquidity';
  else if (hour >= 8 && hour < 12)   ctx.session = 'London Session Open (08:00-12:00 UTC) — High liquidity';
  else if (hour >= 12 && hour < 17)  ctx.session = 'London/NY Overlap (12:00-17:00 UTC) — HIGHEST liquidity';
  else if (hour >= 17 && hour < 20)  ctx.session = 'New York Session (17:00-20:00 UTC) — Good liquidity';
  else                                ctx.session = 'End of NY / Pre-Asia (20:00-22:00 UTC) — Low liquidity';
  if (day === 1)       ctx.market_hours = 'Monday — Watch for gaps';
  else if (day === 5)  ctx.market_hours = 'Friday — Close positions before weekend';
  else if (day === 0 || day === 6) ctx.market_hours = 'Weekend — Low institutional volume';
  else                 ctx.market_hours = 'Mid-week — Optimal trading conditions';
  const sym = (symbol || '').toUpperCase();
  if (sym.includes('BTC') || sym.includes('ETH')) ctx.risk_events.push('Crypto: Best during NY/London overlap');
  if (sym.includes('USD')) ctx.risk_events.push('USD: Watch for NFP, CPI, FOMC');
  if (sym.includes('EUR') || sym.includes('GBP')) ctx.risk_events.push('EUR/GBP: Watch ECB/BOE meetings');
  return ctx;
}

// ─────────────────────────────────────────────
// CLAUDE HELPER
// ─────────────────────────────────────────────
async function claude(apiKey, model, system, content, tokens = 2000) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model, max_tokens:tokens, system, messages:[{ role:'user', content }] }),
    timeout: 30000   // 30s hard cap — prevents silent AI hangs
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
  const d   = await r.json();
  const raw = (d.content || []).map(c => c.text || '').join('').trim();
  // Strip markdown fences
  let s = raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
  // Extract first JSON object if wrapped in text
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try { return JSON.parse(jsonrepair(s)); }
  catch(e) {
    console.error('[JSON parse failed]', s.slice(0,300));
    throw new Error('JSON parse failed: ' + e.message);
  }
}
const img = (b64, mime) => ({ type:'image', source:{ type:'base64', media_type:mime||'image/png', data:b64 } });

// ─────────────────────────────────────────────
// PASS 1A — CHART STRUCTURE & SMC (Haiku)
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// SCALP FAST PATH — 2 passes, Haiku only, ~2s
// ─────────────────────────────────────────────
async function scalpFast(charts, sym, livePrice, mktCtx, key) {
  const lp = livePrice ? `Live: $${livePrice.price}` : '';
  const sys = `You are an elite scalp trader. Analyze these charts and give an instant BUY/SELL/WAIT signal. Be fast and decisive.

SCALP RULES:
- Only BUY if: clear bullish displacement candle, price at support/OB/FVG, 1m and 5m aligned bullish
- Only SELL if: clear bearish displacement candle, price at resistance/OB/FVG, 1m and 5m aligned bearish
- WAIT if: unclear structure, ranging, no displacement, or conflicting timeframes
- SL: just below/above the displacement candle
- TP: nearest liquidity (equal highs/lows or next key level)
- Min R:R 1:1.5 or WAIT

Return ONLY valid raw JSON — no markdown:
{"verdict":"BUY/SELL/WAIT","confidence":<40-95>,"signal_grade":"A/B/C/D",
"entry":"<price>","sl":"<price>","tp1":"<price>","tp2":"<price>",
"rr":"1:<X.X>","entry_trigger":"<exact candle/pattern to confirm>",
"wait_reason":"<if WAIT>","bias":"<1-2 sentences>",
"fullAnalysis":"<5-8 sentences: what you see, why this signal, entry trigger, SL logic, TP targets, risk>"}`;

  const content = [
    ...charts.map((c,i) => [{ type:'text', text:`Chart ${i+1} (${c.label||'?'}):` }, img(c.base64, c.mime)]).flat(),
    { type:'text', text:`Scalp ${sym} NOW. ${lp} Session: ${mktCtx.session}. Give instant signal.` }
  ];
  const raw = await claude(key, HAIKU, sys, content, 900);
  // Normalise to pass3 shape so the rest of the route works unchanged
  return {
    verdict: raw.verdict, confidence: raw.confidence, signal_grade: raw.signal_grade,
    entry: raw.entry, sl: raw.sl, tp1: raw.tp1, tp2: raw.tp2,
    rr_tp1: raw.rr, entry_trigger: raw.entry_trigger,
    wait_reason: raw.wait_reason || '', market_phase: 'Scalp',
    price_position: 'N/A', gates_passed: [], gates_failed: [],
    alignment_score: raw.confidence || 0,
    factors: [], patterns: [], smart_money: {},
    fullAnalysis: raw.fullAnalysis || raw.bias || ''
  };
}

// Model selector based on trade mode
// live=true uses reduced tokens since text data is more concise than images
function getModels(tradeMode, live=false) {
  if (live) {
    // Live mode — text-based, needs fewer tokens, faster models where possible
    if (tradeMode === 'scalp')    return { p1a: HAIKU,  p1b: HAIKU, p2: HAIKU,  p3: HAIKU,  tokens: { p1a:700,  p1b:250, p2:600,  p3:700  } };
    if (tradeMode === 'swing')    return { p1a: SONNET, p1b: HAIKU, p2: SONNET, p3: OPUS,   tokens: { p1a:1200, p1b:300, p2:900,  p3:1400 } };
    /* dayTrade live */           return { p1a: SONNET, p1b: HAIKU, p2: HAIKU,  p3: SONNET, tokens: { p1a:1000, p1b:300, p2:700,  p3:1200 } };
  }
  // Screenshot mode — needs more tokens for image interpretation
  if (tradeMode === 'scalp') return { p1a: SONNET, p1b: HAIKU, p2: HAIKU,  p3: SONNET, tokens: { p1a:1200, p1b:400, p2:800,  p3:1000 } };
  if (tradeMode === 'swing') return { p1a: OPUS,   p1b: HAIKU, p2: OPUS,   p3: OPUS,   tokens: { p1a:3000, p1b:600, p2:2000, p3:2500 } };
  /* dayTrade default */     return { p1a: SONNET, p1b: HAIKU, p2: SONNET, p3: OPUS,   tokens: { p1a:2000, p1b:500, p2:1500, p3:2000 } };
}

async function pass1A(charts, sym, key, tradeMode='dayTrade') {
  const { p1a, tokens } = getModels(tradeMode);
  const n = charts.length;
  const sys = `You are an ICT/SMC chart reading machine. Objective, bias-free reading of price structure and smart money concepts only.

DEFINITIONS:
- Order Block (OB): LAST up-candle before strong bearish displacement, or LAST down-candle before strong bullish displacement. Must have caused a BOS.
- Fair Value Gap (FVG): 3-candle pattern where candle 1's high doesn't overlap candle 3's low (bullish), or candle 1's low doesn't overlap candle 3's high (bearish).
- BOS: Price closes beyond most recent swing high (bullish) or swing low (bearish) in direction of trend.
- CHOCH: First BOS AGAINST current trend — signals potential reversal.
- Liquidity: BSL = equal highs, prior swing highs above. SSL = equal lows, prior swing lows below.
- Premium Zone: Above 50% equilibrium. Discount Zone: Below 50% equilibrium.
${n > 1 ? 'MTF RULE: Highest timeframe bias is law. Conflicting timeframes = Wait.' : ''}

Return ONLY valid raw JSON:
{"timeframes":[${charts.map((_,i) => `{"chart_index":${i+1},"detected_tf":"<>","trend":"Bullish/Bearish/Sideways","structure":"HH+HL/LH+LL/Ranging","wyckoff_phase":"Accumulation/Markup/Distribution/Markdown/Unknown","swing_high":"<price>","swing_low":"<price>","last_bos":"<price and direction>","last_choch":"<price or None>","key_ob":{"type":"Bullish/Bearish/None","zone":"<low>-<high>","fresh":true},"fvg":{"type":"Bullish/Bearish/None","range":"<low>-<high>"},"liquidity":{"bsl":"<price>","ssl":"<price>","last_swept":"<BSL/SSL/None>"},"price_position":"Premium/Discount/Equilibrium","bias":"Bullish/Bearish/Neutral","notes":"<key observations>"}`).join(',')}],
"htf_bias":"Bullish/Bearish/Neutral","htf_key_ob":{"zone":"<low>-<high>","type":"Bullish/Bearish/None","fresh":true},"htf_fvg":"<range or None>",
"htf_support":"<price>","htf_resistance":"<price>",
"mtf_alignment":"Perfect Bull/Perfect Bear/Partial Bull/Partial Bear/Mixed/Conflicting",
"alignment_score":<0-100>,"tradeable_direction":"Long/Short/Wait",
"current_price":"<estimate>","price_position":"Premium/Discount/Equilibrium","equilibrium":"<50% price>",
"range_high":"<highest price>","range_low":"<lowest price>",
"institutional_bias":"Bullish/Bearish/Neutral","liquidity_target":"<next likely grab>",
"key_levels":[{"price":"<exact>","type":"Resistance/Support/OB/FVG/Liquidity","strength":"Major/Minor","reason":"<ICT reason>"}],
"indicators":{"ema_stack":"<>","rsi":"<>","macd":"<>","volume":"<>"},
"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","location":"<price>"}],
"reading_confidence":<0-100>,
"volume_analysis":{"current_volume":"Above/Below/Average","volume_trend":"Increasing/Decreasing/Flat","volume_confirms_move":true,"volume_note":"<>"},
"premarket_bias":{"gap_direction":"Up/Down/Flat","gap_size_pct":"<number>","overnight_range":"<low>-<high>","bias_note":"<how this affects intraday direction>"},
"at_key_level":true,"nearest_key_level":"<price and type>","distance_from_key_level":"<pips/points>",
"summary":"<5 sentences: HTF bias, structure phase, key OB/FVG, liquidity, volume, setup quality>"}`;
  const content = [
    ...charts.map((c, i) => [{ type:'text', text:`Chart ${i+1}:` }, img(c.base64, c.mime)]).flat(),
    { type:'text', text:`Read all ${n} chart${n>1?'s':''} for ${sym}. Report exact prices. Analyze volume bars if visible. Check if price is AT a key level or in the middle of a range.` }
  ];
  return claude(key, p1a, sys, content, tokens.p1a);
}

// ─────────────────────────────────────────────
// PASS 1B — TIMING & CONTEXT (Haiku)
// ─────────────────────────────────────────────
async function pass1B(charts, sym, livePrice, mktCtx, winStats, key, tradeMode='dayTrade') {
  const { p1b, tokens } = getModels(tradeMode);
  const lp = livePrice ? `Live price: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)` : 'Live price: unavailable';
  const ws = winStats  ? `Journal: ${winStats.winRate}% win rate / ${winStats.total} trades` : 'No journal history yet.';
  const sys = `You are a trading session and context filter. Assess if NOW is a good time to trade based on session, news risk, and day-of-week.

SESSION QUALITY:
- London/NY Overlap (12:00-17:00 UTC): Excellent
- London Open (08:00-12:00 UTC): Good
- NY Session (17:00-20:00 UTC): Good
- Asia Session (22:00-08:00 UTC): Poor
- End of NY / Pre-Asia (20:00-22:00 UTC): Avoid

DAY RISK: Monday=Caution, Tue-Thu=Low, Friday=Medium, Weekend=High for non-crypto
NEWS FILTER: High impact events (CPI, FOMC, NFP, GDP, earnings) → block 5 min before AND after. Medium impact → Caution.
PRE-MARKET: Check if there's a significant gap from previous close. Gap >0.5% = wider stops needed. Gap >1% = Caution.

Return ONLY valid raw JSON:
{"session":"<name>","session_quality":"Excellent/Good/Poor/Avoid","session_note":"<why>",
"live_price_note":"<is price near key level>","news_risk":"High/Medium/Low","news_note":"<reason>",
"day_of_week_risk":"High/Medium/Low","day_note":"<reason>","weekend_risk":false,
"historical_edge":"<what journal stats suggest>","context_score":<0-100>,
"context_bias":"Proceed/Caution/Wait/Avoid","risk_multiplier":<0.5-1.5>,
"summary":"<3 sentences: session quality, news/day risk, timing verdict>"}`;
  // charts may be empty for live analysis — only include image if available
  const content = charts && charts.length
    ? [img(charts[0].base64, charts[0].mime), { type:'text', text:`Asset: ${sym}\n${lp}\nSession: ${mktCtx.session}\nDay: ${mktCtx.market_hours}\nRisk events: ${mktCtx.risk_events.join('; ')||'None'}\n${ws}\n\nIs NOW a good time to trade ${sym}?` }]
    : [{ type:'text', text:`Asset: ${sym}\n${lp}\nSession: ${mktCtx.session}\nDay: ${mktCtx.market_hours}\nRisk events: ${mktCtx.risk_events.join('; ')||'None'}\n${ws}\n\nIs NOW a good time to trade ${sym}? (Live data analysis — no chart image)` }];
  return claude(key, p1b, sys, content, tokens.p1b);
}

// ─────────────────────────────────────────────
// PASS 2 — ENTRY ARCHITECT (Sonnet)
// ─────────────────────────────────────────────
async function pass2(charts, sym, reading, ctx, livePrice, key, tradeMode='dayTrade') {
  const { p2, tokens } = getModels(tradeMode);
  const lp  = livePrice ? `Live price: $${livePrice.price}` : 'Live price: N/A';
  const dir = reading.tradeable_direction;
  const sys = `You are an elite ICT entry specialist. Find the SINGLE best entry setup at institutional price levels.

ENTRY HIERARCHY:
1. OB + FVG confluence at discount/premium = A+
2. Fresh OB at HTF level = A
3. FVG fill at structure level = A
4. Key S/R with displacement = B
5. Anything else = C/D

STOP LOSS: Below OB low (longs) or above OB high (shorts) with 0.5-1% buffer. Never at round numbers.
TAKE PROFIT: TP1 = nearest liquidity. TP2 = next major structure. TP3 = max extension. MIN 1:2.5 R:R to TP1.

Return ONLY valid raw JSON:
{"entry_type":"Limit/Stop-Limit/Market/Wait","entry_price":"<exact>","entry_zone":"<low>-<high>",
"entry_trigger":"<specific candle confirmation needed>","entry_quality":"A+/A/B/C/D",
"entry_rationale":"<why this price>","sl_price":"<exact>","sl_reason":"<structural reason>","sl_pct":"<% from entry>",
"tp1_price":"<exact>","tp1_reason":"<>","tp1_rr":"1:<X.X>",
"tp2_price":"<exact>","tp2_reason":"<>","tp2_rr":"1:<X.X>",
"tp3_price":"<exact>","tp3_rr":"1:<X.X>",
"obstacles_to_tp1":"<S/R between entry and TP1>","obstacles_to_tp2":"<>",
"trade_management":{"move_to_be":"<when>","partial_at_tp1":"50%","trail_after_tp1":"<method>","max_hold_time":"<>"},
"position_size_guidance":"<% account risk>","invalidation":"<price that kills setup>",
"summary":"<4 sentences: entry location, stop rationale, TP targets, trade management>"}`;
  return claude(key, p2, sys, [
    img(charts[0].base64, charts[0].mime),
    { type:'text', text:`Find best ${dir} entry for ${sym}.\n${lp}\nHTF bias: ${reading.htf_bias} | Alignment: ${reading.alignment_score}/100 | Position: ${reading.price_position}\nOB: ${JSON.stringify(reading.htf_key_ob)}\nFVG: ${reading.htf_fvg}\nLiquidity target: ${reading.liquidity_target}\nKey levels: ${JSON.stringify(reading.key_levels?.slice(0,5))}\nContext: ${ctx.context_bias} | Session: ${ctx.session_quality}` }
  ], tokens.p2);
}

// ─────────────────────────────────────────────
// PASS 3 — FINAL VERDICT (Opus)
// ─────────────────────────────────────────────
async function pass3(charts, sym, tf, reading, ctx, entry, livePrice, mktCtx, winStats, key, tradeMode='dayTrade', personalEdge=null) {
  const lp = livePrice ? `Live: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)` : 'Live: N/A';
  const ws = winStats  ? `Journal: ${winStats.winRate}% WR / ${winStats.total} trades` : 'No history';
  const edgeNote = personalEdge ? `\nPERSONALIZED EDGE: ${personalEdge.summary}` : '';
  const modeCtx = tradeMode==='scalp'
    ? 'TRADE MODE: SCALP — Tight SL/TP. Trade lasts 2–15 mins. Prefer 1:1.5+ R:R minimum. Only signal during high-liquidity (NY open first 30 min). Require clear momentum candle.'
    : tradeMode==='swing'
    ? 'TRADE MODE: SWING — Wide SL/TP. Trade lasts 1–5 days. Prefer 1:3+ R:R. Session timing less critical. Require strong daily/4H structure alignment.'
    : `TRADE MODE: DAY TRADE — Standard SL/TP. Trade lasts 30 mins–3 hrs. Require 1:2.5+ R:R.
DAY TRADE STRICT RULES:
- ONLY signal in NY session (13:30-20:00 UTC / 9:30am-4pm EST)
- BEST windows: 9:30-11:30am EST (open) OR 2:00-4:00pm EST (afternoon)
- DEAD ZONE 11:30am-2:00pm EST → WAIT unless A+ setup
- Pre-market gap analysis: if price gapped up, look for shorts back to fill; if gapped down, look for longs
- Volume required: entry candle MUST have above-average volume (look for volume spike on chart)
- Key levels only: never enter in the MIDDLE of a range — must be at clear S/R, OB, or FVG
- News: avoid 5 min before/after any scheduled news event (CPI, FOMC, NFP, earnings)
- If pre-market range > 1%: CAUTION — wider stops needed, reduce size`;
  const sys = `You are the Chief Trading Officer of a top-tier hedge fund. You receive a full ICT/SMC analysis and make the FINAL trading decision. Apply 12 strict quality gates.

${modeCtx}

12 QUALITY GATES — ALL must pass for BUY/SELL:
G1:  alignment_score < 65 → WAIT
G2:  tradeable_direction is "Wait" → WAIT
G3:  session_quality is "Poor" or "Avoid" → WAIT
G4:  news_risk is "High" → WAIT
G5:  day_of_week_risk is "High" → WAIT
G6:  entry_quality is "C" or "D" → WAIT
G7:  tp1_rr < 1:2.5 → WAIT
G8:  major obstacle between entry and TP1 → WAIT
G9:  price_position is "Premium" for Long → WAIT
G10: price_position is "Discount" for Short → WAIT
G11: No displacement candle / no entry trigger → WAIT
G12: context_bias is "Avoid" → WAIT
DAY TRADE EXTRA GATES (apply if tradeMode=dayTrade):
G13: Entry candle has NO volume spike / below-average volume → WAIT
G14: Price is in the MIDDLE of a range (not at key level) → WAIT
G15: Time is in dead zone 11:30am-2:00pm EST AND grade < A → WAIT

GRADING:
A+: All 12 pass + 6+ confluences + 1:3+ R:R + alignment ≥ 80
A:  All 12 pass + 4-5 confluences + 1:2.5+ R:R + alignment ≥ 70
B:  All 12 pass + 3 confluences + 1:2.5 R:R + alignment ≥ 65
C:  Borderline — lower conviction
D:  Multiple concerns — WAIT preferred

Return ONLY valid raw JSON:
{"verdict":"BUY/SELL/WAIT","confidence":<40-95>,"signal_grade":"A+/A/B/C/D",
"gates_passed":["G1 ✓"],"gates_failed":["G8 ✗ — reason"],
"wait_reason":"<if WAIT>","market_phase":"<Wyckoff>","price_position":"Premium/Discount/Equilibrium",
"market_bias":"Strongly Bullish/Bullish/Neutral/Bearish/Strongly Bearish",
"summary":"<10-12 sentences: HTF bias, MTF alignment, price position, SMC confluences, gate results, session/news, entry plan, SL/TP levels, position sizing, trade thesis>",
"entry":"<exact>","entry_trigger":"<confirmation>","entry_zone":"<low>-<high>","entry_available_now":true,
"sl":"<exact>","sl_reason":"<structural>",
"tp1":"<exact>","tp1_reason":"<>","tp2":"<exact>","tp2_reason":"<>","tp3":"<exact>",
"rr_tp1":"1:<X.X>","rr_tp2":"1:<X.X>","rrLabel":"Poor/Acceptable/Good/Excellent",
"position_size":"<e.g. 1% account risk>",
"confluences":["<1 with price>","<2>","<3>","<4>","<5>"],
"key_levels":{"major_resistance":"<>","minor_resistance":"<>","equilibrium":"<>","major_support":"<>","minor_support":"<>"},
"smart_money":{"bullish_ob":"<zone>","bearish_ob":"<zone>","bullish_fvg":"<zone>","bearish_fvg":"<zone>","bsl":"<price>","ssl":"<price>","last_sweep":"<>","bos_choch":"<>","displacement":"<>","next_target":"<>"},
"factors":[{"name":"HTF Trend","score":<0-100>,"note":"<>"},{"name":"MTF Alignment","score":<0-100>,"note":"<>"},{"name":"Entry Quality","score":<0-100>,"note":"<>"},{"name":"Risk/Reward","score":<0-100>,"note":"<>"},{"name":"Session Timing","score":<0-100>,"note":"<>"},{"name":"SMC Confluence","score":<0-100>,"note":"<>"},{"name":"Price Position","score":<0-100>,"note":"<>"}],
"patterns":[{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","significance":"<>","price":"<>"}],
"indicators":{"ema":"<>","rsi":"<>","macd":"<>","volume":"<>"},
"invalidation":{"immediate":"<price>","warning":"<price>","full_scenario":"<>"},
"trade_management":{"move_to_be":"<condition>","partial_tp1":"50%","trail_method":"<>","max_hold":"<>","scale_in":"<>"},
"candle_analysis":"<last 3-5 candles>","best_case":"<>","worst_case":"<>",
"fullAnalysis":"<20-25 sentences elite HTML with strong tags covering: institutional context, HTF bias, MTF alignment, price position, SMC setup, all 12 gates, session/news, entry plan, SL/TP levels, position sizing, trade management, invalidation, probability assessment>"}`;

  const { p3, tokens } = getModels(tradeMode);
  return claude(key, p3, sys, [
    ...charts.map(c => img(c.base64, c.mime)),
    { type:'text', text:`FINAL DECISION — ${sym} ${tf}\n${lp}\nSession: ${mktCtx.session}\nTrade Mode: ${tradeMode||'dayTrade'}\n${ws}${edgeNote}\n\nPASS 1A:\n${JSON.stringify(reading)}\n\nPASS 1B:\n${JSON.stringify(ctx)}\n\nPASS 2:\n${JSON.stringify(entry)}\n\nVolume: ${JSON.stringify(reading.volume_analysis)}\nPre-market: ${JSON.stringify(reading.premarket_bias)}\nAt key level: ${reading.at_key_level} — ${reading.nearest_key_level}\n\nApply all 12 gates strictly. Apply G13/G14/G15 if dayTrade mode.` }
  ], tokens.p3);
}

function getWinStats(allTrades) {
  const trades = (allTrades || []).filter(t => t.outcome);
  if (!trades.length) return null;
  const wins  = trades.filter(t => t.outcome === 'win').length;
  const avgRR = trades.filter(t => t.actual_rr).reduce((s,t) => s + t.actual_rr, 0) / (trades.filter(t => t.actual_rr).length || 1);
  const byGrade = {};
  trades.forEach(t => { if (!byGrade[t.grade]) byGrade[t.grade] = { wins:0, losses:0 }; byGrade[t.grade][t.outcome==='win'?'wins':'losses']++; });
  return { total:trades.length, wins, losses:trades.length-wins, winRate:Math.round(wins/trades.length*100), avgRR:avgRR.toFixed(2), byGrade };
}

// ─────────────────────────────────────────────
// FEATURE 1: PERSONALIZED EDGE ANALYZER
// ─────────────────────────────────────────────
function getPersonalizedEdge(allTrades) {
  const trades = (allTrades || []).filter(t => t.outcome);
  if (trades.length < 3) return null;

  // Win rate by hour
  const byHour = {};
  trades.forEach(t => {
    if (!t.timestamp) return;
    const h = new Date(t.timestamp).getHours();
    if (!byHour[h]) byHour[h] = { wins:0, losses:0 };
    byHour[h][t.outcome === 'win' ? 'wins' : 'losses']++;
  });
  let bestHour = null, bestHourWR = -1;
  Object.entries(byHour).forEach(([h, d]) => {
    const total = d.wins + d.losses;
    if (total >= 2) {
      const wr = d.wins / total;
      if (wr > bestHourWR) { bestHourWR = wr; bestHour = parseInt(h); }
    }
  });

  // Win rate by symbol
  const bySymbol = {};
  trades.forEach(t => {
    const s = t.symbol || 'Unknown';
    if (!bySymbol[s]) bySymbol[s] = { wins:0, losses:0 };
    bySymbol[s][t.outcome === 'win' ? 'wins' : 'losses']++;
  });
  let bestSymbol = null, bestSymbolWR = -1;
  Object.entries(bySymbol).forEach(([s, d]) => {
    const total = d.wins + d.losses;
    if (total >= 2) {
      const wr = d.wins / total;
      if (wr > bestSymbolWR) { bestSymbolWR = wr; bestSymbol = s; }
    }
  });

  // Win rate by grade
  const byGrade = {};
  trades.forEach(t => {
    const g = t.grade || 'B';
    if (!byGrade[g]) byGrade[g] = { wins:0, losses:0 };
    byGrade[g][t.outcome === 'win' ? 'wins' : 'losses']++;
  });
  let bestGrade = null, bestGradeWR = -1;
  Object.entries(byGrade).forEach(([g, d]) => {
    const total = d.wins + d.losses;
    if (total >= 2) {
      const wr = d.wins / total;
      if (wr > bestGradeWR) { bestGradeWR = wr; bestGrade = g; }
    }
  });

  // Win rate by verdict (BUY vs SELL)
  const byVerdict = {};
  trades.forEach(t => {
    const v = t.verdict || 'WAIT';
    if (!byVerdict[v]) byVerdict[v] = { wins:0, losses:0 };
    byVerdict[v][t.outcome === 'win' ? 'wins' : 'losses']++;
  });
  const buyStats = byVerdict['BUY'] || { wins:0, losses:0 };
  const sellStats = byVerdict['SELL'] || { wins:0, losses:0 };
  const buyWR = (buyStats.wins + buyStats.losses) >= 2 ? Math.round(buyStats.wins / (buyStats.wins + buyStats.losses) * 100) : null;
  const sellWR = (sellStats.wins + sellStats.losses) >= 2 ? Math.round(sellStats.wins / (sellStats.wins + sellStats.losses) * 100) : null;

  // Best session: morning (before 12 UTC) vs afternoon (12-17 UTC) vs evening (17+ UTC)
  const bySession = { morning:{wins:0,losses:0}, afternoon:{wins:0,losses:0}, evening:{wins:0,losses:0} };
  trades.forEach(t => {
    if (!t.timestamp) return;
    const h = new Date(t.timestamp).getUTCHours();
    const sess = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    bySession[sess][t.outcome === 'win' ? 'wins' : 'losses']++;
  });
  let worstSession = null, worstSessionWR = 2;
  ['morning','afternoon','evening'].forEach(s => {
    const d = bySession[s];
    const total = d.wins + d.losses;
    if (total >= 2) {
      const wr = d.wins / total;
      if (wr < worstSessionWR) { worstSessionWR = wr; worstSession = s; }
    }
  });

  // Build summary string
  const parts = [];
  const totalWins = trades.filter(t => t.outcome === 'win').length;
  const overallWR = Math.round(totalWins / trades.length * 100);
  parts.push(`Overall ${overallWR}% WR over ${trades.length} trades`);
  if (bestGrade && bestGradeWR > 0) parts.push(`${bestGrade} grade: ${Math.round(bestGradeWR*100)}% WR`);
  if (buyWR !== null && sellWR !== null) {
    parts.push(buyWR >= sellWR ? `BUY signals stronger (${buyWR}% vs ${sellWR}% for SELL)` : `SELL signals stronger (${sellWR}% vs ${buyWR}% for BUY)`);
  } else if (buyWR !== null) {
    parts.push(`BUY: ${buyWR}% WR`);
  } else if (sellWR !== null) {
    parts.push(`SELL: ${sellWR}% WR`);
  }
  if (bestHour !== null) {
    const h12 = bestHour % 12 || 12;
    const ampm = bestHour >= 12 ? 'pm' : 'am';
    const hNext = (bestHour + 1) % 12 || 12;
    const ampmNext = (bestHour + 1) >= 12 ? 'pm' : 'am';
    parts.push(`Best hour: ${h12}:00–${hNext}:00${ampm}`);
  }
  if (worstSession) parts.push(`Worst: ${worstSession} trades`);

  return {
    summary: 'Your edge: ' + parts.join(' | '),
    overallWR, totalTrades: trades.length,
    byGrade: Object.entries(byGrade).map(([g,d]) => ({ grade:g, wr: (d.wins+d.losses)>=1 ? Math.round(d.wins/(d.wins+d.losses)*100) : null, wins:d.wins, losses:d.losses })),
    buyWR, sellWR,
    bestHour, bestGrade, bestGradeWR: Math.round(bestGradeWR*100),
    worstSession
  };
}

// ─────────────────────────────────────────────
// MAIN ANALYZE ENDPOINT
// ─────────────────────────────────────────────
app.post('/api/analyze', authMiddleware, requirePlan, async (req, res) => {
  const { charts, imageBase64, imageMime, symbol, timeframe, tradeMode } = req.body;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  let chartList = [];
  if (charts && charts.length) chartList = charts;
  else if (imageBase64) chartList = [{ base64:imageBase64, mime:imageMime||'image/png', label:timeframe||'Chart' }];
  else return res.status(400).json({ error: 'No image provided' });

  const sym = symbol || 'Unknown';
  const tf  = timeframe || chartList[0]?.label || '1H';

  try {
    console.log(`\n[PriceAction] ═══ ${sym} ${tf} — ${chartList.length} chart(s) — ${req.user.email} ═══`);
    const t0 = Date.now();

    const [livePrice, allTrades] = await Promise.all([fetchLivePrice(sym).catch(() => null), getTrades()]);
    const winStats    = getWinStats(allTrades);
    const personalEdge = getPersonalizedEdge(allTrades.filter(t => t.userId === req.user.id));
    const mktCtx      = getMarketContext(sym);

    let result;
    if ((tradeMode||'dayTrade') === 'scalp') {
      // ⚡ SCALP FAST PATH — single Haiku call ~2s
      console.log(`[SCALP] Fast path — Haiku single pass`);
      result = await scalpFast(chartList, sym, livePrice, mktCtx, key);
    } else {
      // 📈 STANDARD 4-PASS PATH
      const [reading, ctx] = await Promise.all([
        pass1A(chartList, sym, key, tradeMode||'dayTrade'),
        pass1B(chartList, sym, livePrice, mktCtx, winStats, key, tradeMode||'dayTrade')
      ]);
      console.log(`[1A] Bias:${reading.htf_bias} Align:${reading.alignment_score} Dir:${reading.tradeable_direction}`);
      console.log(`[1B] Session:${ctx.session_quality} News:${ctx.news_risk} Bias:${ctx.context_bias}`);

      let entry = { entry_quality:'D', tp1_rr:'0:0', summary:'Skipped — conditions not met' };
      const shouldRunEntry = reading.alignment_score >= 55
        && reading.tradeable_direction !== 'Wait'
        && ctx.context_bias !== 'Avoid'
        && ctx.news_risk !== 'High'
        && ctx.session_quality !== 'Avoid';

      if (shouldRunEntry) {
        entry = await pass2(chartList, sym, reading, ctx, livePrice, key, tradeMode||'dayTrade');
        console.log(`[Pass 2] Entry:${entry.entry_price} SL:${entry.sl_price} Quality:${entry.entry_quality}`);
      }
      result = await pass3(chartList, sym, tf, reading, ctx, entry, livePrice, mktCtx, winStats, key, tradeMode||'dayTrade', personalEdge);
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[Pass 3] ${result.verdict} Grade:${result.signal_grade} Conf:${result.confidence}% — ${elapsed}s`);

    // Update daily usage
    const user = req.user;
    if (!isWhitelisted(user)) {
      const today = new Date().toISOString().split('T')[0];
      const usage = user.dailyUsage || { date:'', count:0 };
      if (usage.date !== today) { usage.date = today; usage.count = 0; }
      usage.count++;
      user.dailyUsage = usage;
      await saveUser(user);
    }

    // Save trade to journal
    if (result.verdict === 'BUY' || result.verdict === 'SELL') {
      const trades  = await getTrades();
      const tradeId = Date.now().toString();
      const chartSrc = chartList[0] ? `data:${chartList[0].mime||'image/jpeg'};base64,${chartList[0].base64}` : null;
      trades.push({ id:tradeId, symbol:sym, timeframe:tf, verdict:result.verdict, grade:result.signal_grade, confidence:result.confidence, entry:result.entry, sl:result.sl, tp1:result.tp1, tp2:result.tp2, rr_tp1:result.rr_tp1, timestamp:new Date().toISOString(), outcome:null, actual_rr:null, userId:user.id, chartSrc });
      await saveTrades(trades);
      result._trade_id = tradeId;
    }

    result._meta = { analysis_time_seconds:parseFloat(elapsed), charts_analyzed:chartList.length, live_price:livePrice, market_context:mktCtx, win_stats:winStats };
    res.json(result);
  } catch(err) {
    console.error('[PriceAction] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

// ─────────────────────────────────────────────
// EMAIL SUBSCRIPTION
// ─────────────────────────────────────────────
app.post('/api/subscribe', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  const subs = await getSubs();
  if (subs.find(s => s.email === email)) return res.json({ success:true, message:'Already subscribed' });
  subs.push({ email, active:true, subscribedAt:new Date().toISOString() });
  await saveSubs(subs);
  res.json({ success:true });
});

// ─────────────────────────────────────────────
// TRADE JOURNAL
// ─────────────────────────────────────────────
app.get('/api/trades', authMiddleware, async (req, res) => {
  const trades = await getTrades();
  res.json(trades.filter(t => !t.userId || t.userId === req.user.id));
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  const trades = await getTrades();
  res.json(getWinStats(trades) || { message:'No completed trades yet' });
});

app.post('/api/trades/:id/outcome', authMiddleware, async (req, res) => {
  const { outcome, actual_rr, notes } = req.body;
  const trades = await getTrades();
  const trade  = trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  trade.outcome   = outcome;
  trade.actual_rr = actual_rr;
  trade.notes     = notes || '';
  trade.closed_at = new Date().toISOString();
  await saveTrades(trades);
  res.json({ success:true, stats:getWinStats(trades) });
});

app.delete('/api/trades/:id', authMiddleware, async (req, res) => {
  const trades = await getTrades();
  await saveTrades(trades.filter(t => t.id !== req.params.id));
  res.json({ success:true });
});

// ─────────────────────────────────────────────
// PUBLIC STATS (no auth)
// ─────────────────────────────────────────────
app.get('/api/stats/public', async (req, res) => {
  try {
    const trades = await getTrades();
    const today  = new Date().toISOString().split('T')[0];
    const completed = trades.filter(t => t.outcome);
    const wins      = completed.filter(t => t.outcome === 'win').length;
    const winRate   = completed.length ? Math.round(wins / completed.length * 100) : 74;
    const todayAnalyses = trades.filter(t => t.timestamp && t.timestamp.startsWith(today)).length;
    res.json({ totalAnalyses: trades.length, winRate, todayAnalyses });
  } catch(e) {
    res.json({ totalAnalyses: 0, winRate: 74, todayAnalyses: 0 });
  }
});

// ─────────────────────────────────────────────
// ALERT PREFERENCES
// ─────────────────────────────────────────────
app.post('/api/alerts/preferences', authMiddleware, async (req, res) => {
  const { emailAlerts, alertEmail, dailyBriefing, weeklyRecap } = req.body;
  const user = req.user;
  user.alertPrefs = { emailAlerts: !!emailAlerts, alertEmail: alertEmail || '', dailyBriefing: !!dailyBriefing, weeklyRecap: !!weeklyRecap, updatedAt: new Date().toISOString() };
  await saveUser(user);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// LIVE OHLCV DATA FETCHER
// ─────────────────────────────────────────────
const FUTURES_MAP = {
  'ES1!':'ES=F','ES':'ES=F','NQ1!':'NQ=F','NQ':'NQ=F',
  'YM1!':'YM=F','YM':'YM=F','RTY1!':'RTY=F','CL1!':'CL=F',
  'GC1!':'GC=F','SI1!':'SI=F','NG1!':'NG=F','ZB1!':'ZB=F'
};
const TF_MAP_YAHOO = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1H':'1h','4H':'1h','1D':'1d','1W':'1wk' };
const TF_MAP_12    = { '1m':'1min','5m':'5min','15m':'15min','30m':'30min','1H':'1h','4H':'4h','1D':'1day','1W':'1week' };
const TF_RANGE     = { '1m':'1d','5m':'2d','15m':'5d','30m':'5d','1H':'1mo','4H':'3mo','1D':'1y','1W':'5y' };

async function fetchOHLCV(symbol, timeframe, bars=100) {
  const sym = symbol.toUpperCase().trim();
  const yahooSym = FUTURES_MAP[sym];

  // Try Yahoo Finance first (futures + stocks)
  try {
    const yTF    = TF_MAP_YAHOO[timeframe] || '15m';
    const yRange = TF_RANGE[timeframe] || '5d';
    const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym||sym)}?interval=${yTF}&range=${yRange}`;
    const r      = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0' }, timeout:5000 });
    const d      = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) throw new Error('No data');
    const ts   = result.timestamp || [];
    const q    = result.indicators?.quote?.[0] || {};
    const candles = ts.map((t,i) => ({
      datetime: new Date(t*1000).toISOString().replace('T',' ').substring(0,16),
      open: q.open?.[i]?.toFixed(2), high: q.high?.[i]?.toFixed(2),
      low:  q.low?.[i]?.toFixed(2),  close: q.close?.[i]?.toFixed(2),
      volume: q.volume?.[i] || 0
    })).filter(c => c.open && c.close);
    if (candles.length < 10) throw new Error('Not enough candles');
    return { candles: candles.slice(-bars), source:'Yahoo', symbol: yahooSym||sym, tf: timeframe };
  } catch {}

  // Fallback: TwelveData (stocks/forex/crypto)
  try {
    const tdKey = process.env.TWELVE_DATA_KEY;
    if (!tdKey) throw new Error('No key');
    const tdTF = TF_MAP_12[timeframe] || '15min';
    const url  = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${tdTF}&outputsize=${bars}&apikey=${tdKey}`;
    const r    = await fetch(url, { timeout:5000 });
    const d    = await r.json();
    if (d.status !== 'ok' || !d.values) throw new Error(d.message || 'No data');
    const candles = d.values.reverse().map(v => ({
      datetime:v.datetime, open:v.open, high:v.high, low:v.low, close:v.close, volume:v.volume||0
    }));
    return { candles, source:'TwelveData', symbol:sym, tf: timeframe };
  } catch {}

  return null;
}

function ohlcvToText(data) {
  if (!data) return 'No data available';
  const c = data.candles;
  const last = c[c.length-1];
  const prev = c[c.length-2];
  const avgVol = c.slice(-20).reduce((s,x)=>s+(+x.volume||0),0)/20;
  const lastVol = +last?.volume||0;
  const volNote = lastVol > avgVol*1.5 ? 'HIGH VOLUME' : lastVol < avgVol*0.5 ? 'LOW VOLUME' : 'AVERAGE VOLUME';

  // Calculate basic EMAs
  const closes = c.map(x=>+x.close);
  const ema = (arr,p) => arr.reduce((a,v,i)=>i===0?[v]:[...a,v*(2/(p+1))+a[i-1]*(1-2/(p+1))],[]);
  const ema20 = ema(closes,20); const ema50 = ema(closes,50);
  const e20 = ema20[ema20.length-1]?.toFixed(2); const e50 = ema50[ema50.length-1]?.toFixed(2);

  // Swing highs/lows
  const highs = c.map(x=>+x.high); const lows = c.map(x=>+x.low);
  const swingH = Math.max(...highs.slice(-20)).toFixed(2);
  const swingL = Math.min(...lows.slice(-20)).toFixed(2);

  const header = `LIVE ${data.tf} DATA — ${data.symbol} (${c.length} candles, source: ${data.source})
Current Price: ${last?.close} | Prev Close: ${prev?.close}
EMA20: ${e20} | EMA50: ${e50}
20-bar Swing High: ${swingH} | Swing Low: ${swingL}
Last Candle Volume: ${volNote} (${lastVol.toLocaleString()} vs avg ${Math.round(avgVol).toLocaleString()})

Recent candles (newest last):
Datetime            | Open    | High    | Low     | Close   | Volume
`;
  const rows = c.slice(-40).map(x=>
    `${x.datetime} | ${String(x.open).padStart(7)} | ${String(x.high).padStart(7)} | ${String(x.low).padStart(7)} | ${String(x.close).padStart(7)} | ${String(x.volume).padStart(8)}`
  ).join('\n');
  return header + rows;
}

// ─────────────────────────────────────────────
// ANALYZE LIVE ENDPOINT
// ─────────────────────────────────────────────

// Wraps a promise with a hard timeout so background fetches never hang forever
function withTimeout(promise, ms) {
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms));
  return Promise.race([promise, timer]);
}

app.post('/api/analyze-live', authMiddleware, requirePlan, async (req, res) => {
  const { symbol, timeframes, tradeMode } = req.body;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set — add it in Vercel env vars' });
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });

  const sym  = symbol.toUpperCase().trim();
  const mode = tradeMode || 'dayTrade';
  const tfs  = timeframes || (mode==='scalp' ? ['15m','5m','1m'] : mode==='swing' ? ['1D','4H','1H'] : ['4H','1H','15m']);

  // Guarantee a response within 55s no matter what
  const masterTimer = setTimeout(() => {
    if (!res.headersSent) res.status(500).json({ error: 'Analysis timed out after 55s — please try again' });
  }, 55000);

  try {
    console.log(`[LIVE] ${sym} ${mode} ${tfs.join('+')}`);

    // Fetch all timeframes in parallel, 7s cap each
    const ohlcvResults = await Promise.all(
      tfs.map(tf => withTimeout(fetchOHLCV(sym, tf, 50), 7000).catch(e => { console.warn(`[LIVE] OHLCV ${tf} failed:`, e.message); return null; }))
    );

    const available = ohlcvResults.filter(Boolean);
    console.log(`[LIVE] OHLCV: ${available.length}/${tfs.length} TFs, sources: ${available.map(d=>d.source).join(',')}`);

    if (!available.length) {
      clearTimeout(masterTimer);
      return res.status(400).json({ error: `No data for "${sym}". Try: ES1!, NQ1!, SPY, AAPL, BTC/USD, EUR/USD` });
    }

    const livePrice  = { price: available[0].candles.slice(-1)[0]?.close, source: available[0].source };
    const mktCtx     = getMarketContext(sym);
    const chartTexts = available.map(d => ohlcvToText(d));

    // Single Claude call — 35s hard cap
    console.log(`[LIVE] Calling Claude (${mode})`);
    const result = await withTimeout(
      analyzeOneLive(chartTexts, sym, tfs[tfs.length-1], livePrice, mktCtx, null, null, key, mode),
      35000
    );
    console.log(`[LIVE] Signal: ${result?.verdict} ${result?.signal_grade||''} ${result?.confidence||'?'}%`);

    clearTimeout(masterTimer);
    if (!res.headersSent) {
      res.json({ ...result, dataSource: available.map(d=>d.source).join('+'), tfsUsed: available.map(d=>d.tf), _newsSentiment: null, _correlatedAssets: null });
    }

    // Fire-and-forget journal save after response sent
    if (result?.verdict && result.verdict !== 'WAIT') {
      getTrades().then(trades => {
        const tradeId = Date.now().toString();
        trades.push({ id:tradeId, symbol:sym, timeframe:tfs[tfs.length-1], verdict:result.verdict, grade:result.signal_grade, confidence:result.confidence, entry:result.entry, sl:result.sl, tp1:result.tp1, tp2:result.tp2, rr_tp1:result.rr_tp1, timestamp:new Date().toISOString(), outcome:null, actual_rr:null, userId:req.user.id, notes:'', source:'live', chartSrc:null });
        return saveTrades(trades);
      }).catch(e => console.warn('[LIVE] Journal save failed:', e.message));
    }

  } catch(e) {
    clearTimeout(masterTimer);
    console.error('[LIVE] Error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Live analysis failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE-PASS LIVE ANALYSIS — one Claude call for all modes, always returns signal
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeOneLive(chartTexts, sym, tf, livePrice, mktCtx, winStats, personalEdge, key, tradeMode) {
  const lp   = livePrice ? `Live price: $${livePrice.price}` : 'Live price: N/A';
  const ws   = winStats  ? `Win rate: ${winStats.winRate}% over ${winStats.total} trades` : '';
  const edge = personalEdge ? `User edge: ${personalEdge.summary}` : '';
  const session = mktCtx.session || 'Unknown session';

  const modeInstructions = tradeMode === 'scalp'
    ? `SCALP TRADE — hold 2–15 min. Use tight SL. Min 1:1.5 R:R. Entry on 1m/5m momentum candle.`
    : tradeMode === 'swing'
    ? `SWING TRADE — hold 1–5 days. Wide SL beyond structure. Min 1:3 R:R. Daily/4H level entries.`
    : `DAY TRADE — hold 30 min–3 hrs. Min 1:2.5 R:R. Enter at key OB/FVG/S-R levels.`;

  const model  = tradeMode === 'swing' ? SONNET : HAIKU;
  const tokens = tradeMode === 'swing' ? 1600   : 1100;

  const sys = `You are an elite ICT/SMC trading analyst. Analyze LIVE OHLCV price data and deliver a complete trading signal.

${modeInstructions}

IMPORTANT RULES:
- ALWAYS give a directional verdict (BUY, SELL, or WAIT). Never leave fields empty.
- ALWAYS provide exact entry, sl, tp1, tp2 price levels — even on WAIT, show the next key setup.
- Session timing affects confidence score, NOT the verdict. Analyze price action objectively.
- ICT concepts: Order Blocks (last candle before displacement), FVG (3-candle gap), BOS/CHOCH, liquidity grabs, premium/discount zones.
- BUY if: bullish structure (HH+HL), price at discount/OB/FVG, clear upside target above.
- SELL if: bearish structure (LH+LL), price at premium/OB/FVG, clear downside target below.
- WAIT if: price in middle of range with no clear OB/FVG, conflicting timeframes, no liquidity target.

Return ONLY valid raw JSON (no markdown, no text outside JSON):
{
  "verdict": "BUY or SELL or WAIT",
  "confidence": <40-95>,
  "signal_grade": "A+ or A or B or C or D",
  "market_bias": "Strongly Bullish or Bullish or Neutral or Bearish or Strongly Bearish",
  "entry": "<exact price>",
  "entry_trigger": "<what to wait for before entering>",
  "entry_zone": "<low>-<high>",
  "sl": "<exact stop loss price>",
  "sl_reason": "<why this stop placement>",
  "tp1": "<exact TP1 price>",
  "tp1_reason": "<what level>",
  "tp2": "<exact TP2 price>",
  "tp3": "<exact TP3 or same as tp2>",
  "rr_tp1": "1:<X.X>",
  "rr_tp2": "1:<X.X>",
  "invalidation": "<price that kills the setup>",
  "wait_reason": "<if WAIT, explain what needs to happen for a signal>",
  "summary": "<5 sentences: overall bias, key structure, best entry setup, risk levels, session note>",
  "fullAnalysis": "<10 sentences: HTF bias, structure analysis, OB/FVG locations, liquidity, entry plan, SL logic, TP targets, confluences, session context, trade management>",
  "confluences": ["<confluence 1>", "<confluence 2>", "<confluence 3>"],
  "key_levels": { "major_resistance": "<price>", "major_support": "<price>", "equilibrium": "<price>" },
  "factors": [
    { "name": "HTF Trend",     "score": <0-100>, "note": "<brief>" },
    { "name": "Entry Quality", "score": <0-100>, "note": "<brief>" },
    { "name": "Risk/Reward",   "score": <0-100>, "note": "<brief>" },
    { "name": "Session",       "score": <0-100>, "note": "<brief>" },
    { "name": "Volume",        "score": <0-100>, "note": "<brief>" }
  ],
  "gates_passed": ["<gate> ✓"],
  "gates_failed": ["<gate> ✗ — reason"],
  "position_size": "1% risk"
}`;

  // Trim each TF to first 12 lines of header + last 20 candle rows to keep input small & fast
  const trimTF = (t) => {
    const lines = t.split('\n');
    const headerEnd = lines.findIndex(l => l.startsWith('---') || l.includes('| Open')) + 1;
    const header = lines.slice(0, Math.max(headerEnd, 8)).join('\n');
    const rows   = lines.slice(headerEnd).slice(-20).join('\n');
    return header + '\n' + rows;
  };
  const dataBlock = chartTexts.map((t, i) => `=== TF ${i+1} ===\n${trimTF(t)}`).join('\n\n');
  const userMsg = `${sym} ${tradeMode} | ${lp} | ${session}${ws ? ' | '+ws : ''}${edge ? ' | '+edge : ''}\n\n${dataBlock}`;

  return claude(key, model, sys, [{ type:'text', text: userMsg }], tokens);
}

// ─────────────────────────────────────────────
// FEATURE 2: MULTI-SYMBOL SCANNER
// ─────────────────────────────────────────────
app.post('/api/scanner', authMiddleware, requirePlan, async (req, res) => {
  const { symbols, tradeMode } = req.body;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  const syms = (symbols || ['ES1!','NQ1!','CL1!','GC1!']).slice(0, 8);
  const mode = tradeMode || 'dayTrade';

  try {
    console.log(`[SCANNER] Scanning ${syms.join(',')} — ${mode}`);
    const tf = mode === 'scalp' ? '15m' : mode === 'swing' ? '4H' : '1H';

    // Fetch all symbols in parallel
    const results = await Promise.all(syms.map(async (sym) => {
      try {
        const data = await fetchOHLCV(sym.toUpperCase().trim(), tf, 60);
        if (!data) return { symbol: sym, error: 'No data' };
        const ohlcvText = ohlcvToText(data);
        const livePrice = data.candles.slice(-1)[0]?.close;

        // Fast single-pass Haiku analysis
        const scanResult = await claude(key, HAIKU, `You are a fast trading signal scanner. Analyze OHLCV data and return a quick signal.
Return ONLY valid raw JSON:
{"verdict":"BUY/SELL/WAIT","grade":"A+/A/B/C/D","confidence":<40-95>,"entry":"<price>","sl":"<price>","tp1":"<price>","rr_tp1":"1:<X.X>","summary":"<2 sentences max>"}`,
          [{ type:'text', text:`Quick scan ${sym} ${tf}. Live: ${livePrice}. Mode: ${mode}.\n${ohlcvText.substring(0,2000)}` }],
          400);

        return {
          symbol: sym,
          verdict: scanResult.verdict || 'WAIT',
          grade: scanResult.grade || 'C',
          confidence: scanResult.confidence || 50,
          entry: scanResult.entry,
          sl: scanResult.sl,
          tp1: scanResult.tp1,
          rr_tp1: scanResult.rr_tp1,
          summary: scanResult.summary || '',
          livePrice
        };
      } catch(e) {
        return { symbol: sym, verdict: 'WAIT', grade: 'D', confidence: 0, summary: 'Error: ' + e.message };
      }
    }));

    // Sort by grade (A+ first), then confidence
    const gradeOrder = { 'A+':0, 'A':1, 'B':2, 'C':3, 'D':4 };
    results.sort((a,b) => {
      const ga = gradeOrder[a.grade] ?? 5;
      const gb = gradeOrder[b.grade] ?? 5;
      if (ga !== gb) return ga - gb;
      return (b.confidence||0) - (a.confidence||0);
    });

    res.json({ results });
  } catch(e) {
    console.error('[SCANNER] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// FEATURE 3: MORNING MARKET BRIEFING
// ─────────────────────────────────────────────
app.get('/api/briefing', authMiddleware, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    // Fetch ES and NQ live data
    const [esData, nqData] = await Promise.all([
      fetchOHLCV('ES1!', '1H', 30).catch(() => null),
      fetchOHLCV('NQ1!', '1H', 30).catch(() => null)
    ]);

    const today = new Date();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[today.getDay()];
    const dateStr = today.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
    const isFriday = today.getDay() === 5;
    const isMonday = today.getDay() === 1;

    const esText = esData ? ohlcvToText(esData).substring(0, 1500) : 'ES data unavailable';
    const nqText = nqData ? ohlcvToText(nqData).substring(0, 1500) : 'NQ data unavailable';

    const briefing = await claude(key, HAIKU, `You are a professional market analyst. Write a morning briefing for futures traders. Be concise and specific with price levels. Return ONLY valid raw JSON.`,
      [{ type:'text', text:`Generate a morning market briefing for ${dayName}, ${dateStr}.

ES1! DATA:\n${esText}

NQ1! DATA:\n${nqText}

${isFriday ? 'NOTE: It is FRIDAY — NFP risk if first Friday of month, position risk before weekend.' : ''}
${isMonday ? 'NOTE: It is MONDAY — Watch for weekend gaps. Caution on gap fills.' : ''}

Return JSON: {"bias":"Bullish/Bearish/Neutral","bias_note":"<1 sentence>","es_key_levels":"<support and resistance levels>","nq_key_levels":"<support and resistance levels>","best_windows":"<best times to trade today>","caution_notes":"<any specific warnings for today>","briefing":"<full formatted briefing text with sections: MARKET BIAS, ES KEY LEVELS, NQ KEY LEVELS, BEST WINDOWS, CAUTION — 150-200 words total>"}` }],
      800);

    res.json({ briefing: briefing.briefing, meta: { bias: briefing.bias, generatedAt: new Date().toISOString(), day: dayName } });
  } catch(e) {
    console.error('[BRIEFING] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// FEATURE 5: CORRELATED ASSETS
// ─────────────────────────────────────────────
const EQUITY_SYMBOLS = new Set(['ES','ES1!','NQ','NQ1!','SPY','QQQ','YM','YM1!','RTY','RTY1!','AAPL','NVDA','MSFT','AMZN','META','TSLA']);

async function fetchCorrelatedAssets(symbol) {
  const sym = (symbol || '').toUpperCase().replace('!','');
  // Only fetch correlations for equity-adjacent instruments
  if (!EQUITY_SYMBOLS.has(sym) && !EQUITY_SYMBOLS.has(sym.replace('1',''))) return null;

  try {
    const [vixData, uupData, tltData] = await Promise.all([
      fetchOHLCV('^VIX', '1D', 5).catch(() => null),
      fetchOHLCV('UUP', '1D', 5).catch(() => null),
      fetchOHLCV('TLT', '1D', 5).catch(() => null)
    ]);

    const getLatest = (d) => {
      if (!d?.candles?.length) return null;
      const c = d.candles;
      const last = c[c.length-1];
      const prev = c[c.length-2];
      const price = parseFloat(last?.close);
      const prevPrice = parseFloat(prev?.close);
      const change = prevPrice ? ((price - prevPrice)/prevPrice*100).toFixed(2) : null;
      return { price: price?.toFixed(2), change };
    };

    const vix = getLatest(vixData);
    const dxy = getLatest(uupData);
    const bonds = getLatest(tltData);

    const vixLevel = vix ? (parseFloat(vix.price) > 25 ? 'HIGH FEAR' : parseFloat(vix.price) > 18 ? 'ELEVATED' : 'LOW FEAR') : null;

    // Build a 1-sentence interpretation
    let note = '';
    if (vix && dxy && bonds) {
      const vixNum = parseFloat(vix.price);
      const dxyChange = parseFloat(dxy.change);
      const bondsChange = parseFloat(bonds.change);

      if (vixNum > 25) note = 'High VIX indicates fear — reduce size, use wider stops.';
      else if (vixNum < 15 && dxyChange < 0 && bondsChange > 0) note = 'Risk-on environment: low VIX + weak DXY + rising bonds favor longs.';
      else if (dxyChange > 0.3) note = 'Strong DXY may pressure equities — watch for headwinds on ES/NQ.';
      else if (bondsChange < -0.3) note = 'Falling bonds (TLT) signals risk-off — caution on equity longs.';
      else note = 'Neutral macro backdrop — trade price action setups directly.';
    }

    return {
      vix: vix ? { ...vix, level: vixLevel } : null,
      dxy: dxy || null,
      bonds: bonds || null,
      note
    };
  } catch(e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// FEATURE 7: BACKTEST
// ─────────────────────────────────────────────
app.post('/api/backtest', authMiddleware, requirePlan, async (req, res) => {
  const { symbol, tradeMode, days } = req.body;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });

  const sym = symbol.toUpperCase().trim();
  const numDays = Math.min(parseInt(days) || 5, 10); // Cap at 10 days
  const mode = tradeMode || 'dayTrade';

  try {
    console.log(`[BACKTEST] ${sym} ${numDays} days — ${mode}`);

    // Fetch daily data to identify trading days
    const dailyData = await fetchOHLCV(sym, '1D', 30);
    if (!dailyData) return res.status(400).json({ error: `Could not fetch data for ${sym}` });

    // Get last N trading day dates
    const tradingDays = dailyData.candles.slice(-numDays).map(c => c.datetime.split(' ')[0]);

    // For each day, fetch intraday 15m data and run analysis
    const dayResults = await Promise.all(tradingDays.map(async (date) => {
      try {
        // Fetch 15m data for that day
        const intradayData = await fetchOHLCV(sym, '15m', 100);
        if (!intradayData) return { date, result: 'no_data', grade: 'N/A', verdict: 'N/A', entry: null, sl: null, tp1: null, rr: null };

        // Filter candles to morning session of that date (9:30-11:30am approximate)
        const dayCandles = intradayData.candles.filter(c => c.datetime.startsWith(date));
        const morningCandles = dayCandles.slice(0, 8); // First 8 × 15min = 2 hours
        if (morningCandles.length < 3) return { date, result: 'insufficient_data', grade: 'N/A', verdict: 'N/A' };

        // Build a text summary
        const candleText = morningCandles.map(c =>
          `${c.datetime} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
        ).join('\n');

        const analysis = await claude(key, HAIKU, `You are a backtest AI. Analyze morning session candles and determine if there was a tradeable signal.
Return ONLY valid raw JSON: {"verdict":"BUY/SELL/WAIT","grade":"A+/A/B/C/D","entry":"<price or null>","sl":"<price or null>","tp1":"<price or null>","rr":"1:<X.X or null>","reason":"<1 sentence>"}`,
          [{ type:'text', text:`Backtest: ${sym} morning session on ${date} (15m candles)\n${candleText}\n\nWas there a BUY, SELL, or WAIT signal? If BUY/SELL, provide entry, SL, TP1.` }],
          300);

        // Simulate outcome: check remaining candles to see if TP1 or SL was hit
        let result = 'open';
        if (analysis.verdict !== 'WAIT' && analysis.entry && analysis.sl && analysis.tp1) {
          const entry = parseFloat(analysis.entry);
          const sl = parseFloat(analysis.sl);
          const tp1 = parseFloat(analysis.tp1);
          const remainingCandles = dayCandles.slice(8);

          for (const c of remainingCandles) {
            const high = parseFloat(c.high);
            const low = parseFloat(c.low);
            if (analysis.verdict === 'BUY') {
              if (high >= tp1) { result = 'win'; break; }
              if (low <= sl) { result = 'loss'; break; }
            } else if (analysis.verdict === 'SELL') {
              if (low <= tp1) { result = 'win'; break; }
              if (high >= sl) { result = 'loss'; break; }
            }
          }
        }

        return {
          date, verdict: analysis.verdict, grade: analysis.grade || 'C',
          entry: analysis.entry, sl: analysis.sl, tp1: analysis.tp1,
          rr: analysis.rr, result, reason: analysis.reason || ''
        };
      } catch(e) {
        return { date, result: 'error', grade: 'N/A', verdict: 'N/A', error: e.message };
      }
    }));

    // Calculate stats
    const signals = dayResults.filter(d => d.verdict && d.verdict !== 'WAIT' && d.verdict !== 'N/A');
    const wins = signals.filter(d => d.result === 'win').length;
    const losses = signals.filter(d => d.result === 'loss').length;
    const winRate = signals.length > 0 ? Math.round(wins / signals.length * 100) : 0;

    res.json({
      trades: dayResults,
      totalSignals: signals.length,
      wins, losses,
      winRate,
      profitFactor: losses > 0 ? (wins / losses).toFixed(2) : wins > 0 ? '∞' : 'N/A',
      symbol: sym, days: numDays, mode
    });
  } catch(e) {
    console.error('[BACKTEST] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// FEATURE 1: LIVE TRADE MONITOR
// ─────────────────────────────────────────────
app.get('/api/trade-monitor/:tradeId', authMiddleware, async (req, res) => {
  const { tradeId } = req.params;
  const symbol = req.query.symbol || 'ES1!';

  try {
    // Get trade from DB
    const trades = await getTrades();
    const trade = trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    // Fetch current live price (latest candle)
    const tf = trade.timeframe || '15m';
    const ohlcv = await fetchOHLCV(symbol, tf, 5);
    if (!ohlcv || !ohlcv.candles.length) return res.status(400).json({ error: 'Could not fetch live price' });

    const lastCandle = ohlcv.candles[ohlcv.candles.length - 1];
    const currentPrice = parseFloat(lastCandle.close);

    const entry = parseFloat(trade.entry);
    const sl    = parseFloat(trade.sl);
    const tp1   = parseFloat(trade.tp1);
    const tp2   = parseFloat(trade.tp2) || null;

    if (!entry || !sl || !tp1 || isNaN(entry) || isNaN(sl) || isNaN(tp1)) {
      return res.json({ currentPrice, status: 'in_progress', pnlR: 0, action: 'hold', actionNote: 'Trade levels not available', percentToTP1: 0, percentToSL: 0 });
    }

    const isBuy = trade.verdict === 'BUY';
    const slDist  = Math.abs(entry - sl);
    const tp1Dist = Math.abs(tp1 - entry);

    // P&L in R
    const priceMoveRaw = isBuy ? currentPrice - entry : entry - currentPrice;
    const pnlR = slDist > 0 ? parseFloat((priceMoveRaw / slDist).toFixed(2)) : 0;

    // % moved toward TP1
    const moveToTP1 = isBuy ? currentPrice - entry : entry - currentPrice;
    const percentToTP1 = tp1Dist > 0 ? Math.max(0, Math.min(100, (moveToTP1 / tp1Dist) * 100)) : 0;

    // % moved toward SL
    const moveToSL = isBuy ? entry - currentPrice : currentPrice - entry;
    const percentToSL = slDist > 0 ? Math.max(0, Math.min(100, (moveToSL / slDist) * 100)) : 0;

    // Determine status and action
    let status = 'in_progress';
    let action = 'hold';
    let actionNote = 'Hold — trade progressing normally';

    const slHit  = isBuy ? currentPrice <= sl  : currentPrice >= sl;
    const tp1Hit = isBuy ? currentPrice >= tp1 : currentPrice <= tp1;
    const tp2Hit = tp2 && (isBuy ? currentPrice >= tp2 : currentPrice <= tp2);

    if (slHit) {
      status = 'sl_hit'; action = 'close'; actionNote = 'SL hit — close trade';
    } else if (tp2Hit) {
      status = 'tp2_hit'; action = 'trail_stop'; actionNote = 'TP2 hit — trail stop below last swing low';
    } else if (tp1Hit) {
      status = 'tp1_hit'; action = 'take_partial'; actionNote = 'TP1 hit — close 50%, move SL to BE';
    } else if (percentToSL >= 90) {
      status = 'in_progress'; action = 'caution'; actionNote = 'Price approaching SL — watch closely';
    } else if (percentToTP1 >= 50) {
      status = 'at_be'; action = 'move_to_be'; actionNote = 'Move SL to breakeven now';
    }

    res.json({ currentPrice, status, pnlR, action, actionNote, percentToTP1: Math.round(percentToTP1), percentToSL: Math.round(percentToSL), symbol, tradeId, entry, sl, tp1, tp2, verdict: trade.verdict });
  } catch(e) {
    console.error('[TradeMonitor] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// FEATURE 3: NEWS SENTIMENT
// ─────────────────────────────────────────────
async function fetchNewsSentiment(symbol) {
  try {
    const sym = symbol.replace('1!','').replace('/','').toUpperCase();
    // Map futures/crypto to Yahoo Finance tickers
    const symMap = { 'ES':'ES=F','NQ':'NQ=F','CL':'CL=F','GC':'GC=F','BTC':'BTC-USD','ETH':'ETH-USD' };
    const yahooSym = symMap[sym] || sym;

    const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooSym)}&region=US&lang=en-US`;
    const r = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 });
    if (!r.ok) throw new Error('RSS fetch failed');
    const xml = await r.text();

    // Parse headlines from RSS with regex
    const titleMatches = xml.match(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<\/item>/g) || [];
    const headlines = titleMatches.slice(0, 5).map(item => {
      const m = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
      return m ? m[1].trim() : '';
    }).filter(Boolean);

    // Also try plain title tags
    if (!headlines.length) {
      const plain = xml.match(/<title>(?!\s*<!\[CDATA\[)(.*?)<\/title>/g) || [];
      headlines.push(...plain.slice(1, 6).map(t => t.replace(/<\/?title>/g,'').trim()).filter(h => h.length > 10));
    }

    if (!headlines.length) return { sentiment: 'Neutral', score: 50, headlines: [], note: 'No recent news found' };

    // Score sentiment with Claude Haiku
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { sentiment: 'Neutral', score: 50, headlines, note: 'API not configured' };

    const sentResult = await claude(key, HAIKU,
      `You are a financial news sentiment analyzer. Given headlines about a trading instrument, determine overall sentiment and return ONLY valid JSON.`,
      [{ type: 'text', text: `Headlines for ${symbol}:\n${headlines.map((h,i) => `${i+1}. ${h}`).join('\n')}\n\nReturn JSON: {"sentiment":"Bullish/Bearish/Neutral","score":<0-100>,"note":"<1 sentence summary>"}` }],
      200
    );

    return {
      sentiment: sentResult.sentiment || 'Neutral',
      score: sentResult.score || 50,
      headlines: headlines.slice(0, 3),
      note: sentResult.note || ''
    };
  } catch(e) {
    return { sentiment: 'Neutral', score: 50, headlines: [], note: 'News unavailable' };
  }
}

// ─────────────────────────────────────────────
// FEATURE 4: AI POST-TRADE REVIEW
// ─────────────────────────────────────────────
app.post('/api/trade-review/:tradeId', authMiddleware, async (req, res) => {
  const { tradeId } = req.params;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const trades = await getTrades();
    const trade = trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    if (!trade.outcome) return res.status(400).json({ error: 'Trade must have an outcome before review' });

    // Fetch historical data around trade time
    let ohlcvText = 'Historical data unavailable';
    try {
      const sym = (trade.symbol || 'ES1!').toUpperCase();
      const tf = trade.timeframe || '15m';
      const ohlcv = await fetchOHLCV(sym, tf, 50);
      if (ohlcv) ohlcvText = ohlcvToText(ohlcv).substring(0, 2000);
    } catch(e) {}

    const review = await claude(key, SONNET,
      `You are an elite trading coach reviewing a completed trade. Analyze the trade execution objectively. Return ONLY valid JSON.`,
      [{ type: 'text', text: `Review this completed trade:
Symbol: ${trade.symbol} | Timeframe: ${trade.timeframe} | Mode: ${trade.source || 'N/A'}
Signal: ${trade.verdict} | Grade: ${trade.grade} | Confidence: ${trade.confidence}%
Entry: ${trade.entry} | SL: ${trade.sl} | TP1: ${trade.tp1} | TP2: ${trade.tp2 || 'N/A'}
Expected R:R: ${trade.rr_tp1} | Actual R:R: ${trade.actual_rr || 'N/A'}
Outcome: ${trade.outcome.toUpperCase()} | Notes: ${trade.notes || 'None'}
Opened: ${trade.timestamp} | Closed: ${trade.closed_at || 'N/A'}

Recent OHLCV context:
${ohlcvText}

Grade the trade EXECUTION (not just the signal). Return JSON:
{"executionGrade":"A/B/C/D","whatWorked":"<2-3 sentences>","whatWentWrong":"<2-3 sentences or none>","keyLesson":"<1 powerful lesson>","improvementTip":"<specific actionable tip for next time>"}` }],
      600
    );

    // Save review to trade
    const tradeIdx = trades.findIndex(t => t.id === tradeId);
    if (tradeIdx !== -1) {
      trades[tradeIdx].aiReview = { ...review, reviewedAt: new Date().toISOString() };
      await saveTrades(trades);
    }

    res.json(review);
  } catch(e) {
    console.error('[TradeReview] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// FEATURE 7: BROKER INTEGRATION PLACEHOLDER
// ─────────────────────────────────────────────
app.post('/api/broker/execute', authMiddleware, async (req, res) => {
  const { broker, symbol, direction, entry, sl, tp1, size } = req.body;
  console.log('[BROKER] Order received:', { broker, symbol, direction, entry, sl, tp1, size, user: req.user.email });
  res.json({
    success: false,
    message: 'Broker execution coming soon — order details logged',
    order: req.body
  });
});

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://nexttrade-pro.vercel.app/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>`);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  PriceAction AI — /tmp storage (no MongoDB needed)`);
  console.log(`  Pipeline: Haiku(x2 parallel) → Sonnet → Opus`);
  console.log(`  Stripe: ${stripe ? 'ACTIVE ✓' : 'disabled'}`);
  console.log(`  http://localhost:${PORT}\n`);
});
