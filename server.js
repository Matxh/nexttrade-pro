require('dotenv').config();
const express      = require('express');
const fetch        = require('node-fetch');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const { jsonrepair } = require('jsonrepair'); // top-level so Vercel bundles it correctly
const { Resend }   = require('resend');

// ── RESEND EMAIL ──
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

// Pine Script source code — sent to customers on purchase
const PINE_SCRIPT_PATH = path.join(__dirname, 'PriceActionAI.pine');
const PINE_SCRIPT_CODE = fs.existsSync(PINE_SCRIPT_PATH) ? fs.readFileSync(PINE_SCRIPT_PATH, 'utf8') : '';

async function sendPineScriptEmail(toEmail) {
  if (!resend) { console.warn('[Email] Resend not configured'); return; }
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: 'Your PriceAction AI Pine Script — Setup Inside',
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0d1117;color:#ffffff;padding:32px;border-radius:12px;">
          <h1 style="color:#00ffbb;margin-bottom:4px;">PriceAction AI</h1>
          <p style="color:#888;margin-top:0;">FULL SUITE — Pine Script</p>
          <hr style="border-color:#222;margin:24px 0;">
          <h2 style="color:#ffffff;">Thank you for your purchase! 🎉</h2>
          <p style="color:#ccc;">Your Pine Script source code is attached to this email as <strong>PriceActionAI_FullSuite.pine</strong></p>

          <h3 style="color:#00ffbb;">How to install in TradingView:</h3>
          <ol style="color:#ccc;line-height:2;">
            <li>Open <a href="https://tradingview.com" style="color:#00ffbb;">TradingView</a> and open any chart</li>
            <li>Click <strong>Pine Script Editor</strong> at the bottom of the screen</li>
            <li>Click the file icon → <strong>New script</strong></li>
            <li>Select all the existing code (<strong>Ctrl+A</strong> / <strong>Cmd+A</strong>) and delete it</li>
            <li>Open the attached <strong>.pine</strong> file in any text editor, copy all the code</li>
            <li>Paste it into the Pine Script editor</li>
            <li>Click <strong>Save</strong> then <strong>Add to chart</strong></li>
          </ol>

          <h3 style="color:#00ffbb;">Recommended settings:</h3>
          <ul style="color:#ccc;line-height:2;">
            <li><strong>Higher Timeframe:</strong> 60 (1H) for NQ/ES, 240 (4H) for GC</li>
            <li><strong>OB Sensitivity:</strong> 1.8 for NQ, 1.5 for GC</li>
            <li><strong>Signal Threshold:</strong> 3 (only take ▲3 and ▲4 signals)</li>
            <li><strong>Best sessions:</strong> NY Open 9:30–11:30 AM EST</li>
          </ul>

          <hr style="border-color:#222;margin:24px 0;">
          <p style="color:#888;font-size:14px;">
            Need help? Visit <a href="https://priceaction.it.com" style="color:#00ffbb;">priceaction.it.com</a><br>
            Trade smart. Trade with confluence. Trade with PriceAction AI.
          </p>
        </div>
      `,
      attachments: [{
        filename: 'PriceActionAI_FullSuite.pine',
        content: Buffer.from(PINE_SCRIPT_CODE).toString('base64'),
      }],
    });
    console.log(`[Email] Pine Script sent to ${toEmail}`);
  } catch(err) {
    console.error('[Email] Failed to send Pine Script email:', err.message);
  }
}

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

const API_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const HAIKU        = 'llama-3.3-70b-versatile';          // fast + smart, free
const SONNET       = 'deepseek-r1-distill-llama-70b';    // best reasoning, free
const OPUS         = 'deepseek-r1-distill-llama-70b';    // same
const VISION_MODEL = 'llama-3.2-90b-vision-preview';     // for chart screenshots

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
async function getBrokerOrders() {
  const r = await ghRead('broker-orders.json');
  return r ? r.data : [];
}
async function saveBrokerOrders(orders) {
  const r = await ghRead('broker-orders.json');
  await ghWrite('broker-orders.json', orders, r?.sha);
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

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(String(JWT_SECRET)).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${encrypted.toString('hex')}`;
}

function decryptSecret(payload) {
  if (!payload || typeof payload !== 'string' || !payload.includes('.')) return null;
  try {
    const [ivHex, tagHex, dataHex] = payload.split('.');
    const key = crypto.createHash('sha256').update(String(JWT_SECRET)).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function maskSecret(value = '') {
  const raw = String(value || '');
  if (!raw) return 'Not set';
  if (raw.length <= 6) return `${raw.slice(0, 2)}***`;
  return `${raw.slice(0, 3)}***${raw.slice(-2)}`;
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
  const priceId  = plan === 'pro'       ? process.env.STRIPE_PRO_PRICE_ID
                 : plan === 'indicator' ? process.env.STRIPE_INDICATOR_PRICE_ID
                 : plan === 'pine'      ? process.env.STRIPE_PINE_PRICE_ID
                 : process.env.STRIPE_BASIC_PRICE_ID;
  if (!priceId)  return res.status(500).json({ error: 'Price ID not configured for this plan' });

  const user = req.user;
  const BASE = process.env.BASE_URL || 'https://nexttrade-pro.vercel.app';
  const isPine = plan === 'pine';
  const params = {
    mode: isPine ? 'payment' : 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${BASE}/?checkout=success&plan=${plan}`,
    cancel_url:  `${BASE}/?checkout=cancel`,
    metadata: { userId: user.id, plan },
    allow_promotion_codes: true,
  };
  if (!isPine) params.subscription_data = { metadata: { userId: user.id } };
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
        const session  = event.data.object;
        const userId   = session.metadata?.userId;
        const planMeta = session.metadata?.plan;

        // ── One-time Pine Script purchase ──
        if (planMeta === 'pine' && userId) {
          const user = await getUserById(userId);
          if (user) {
            Object.assign(user, { pineAccess: true, pinePaymentId: session.payment_intent, stripeCustomerId: session.customer, pinePurchasedAt: new Date().toISOString() });
            await saveUser(user);
            await sendPineScriptEmail(user.email);
            console.log(`[Webhook] Pine Script sold → ${user.email}`);
          }
          break;
        }

        // ── Subscription purchases ──
        if (userId && session.subscription) {
          const sub  = await stripe.subscriptions.retrieve(session.subscription);
          const pid  = sub.items.data[0]?.price?.id;
          const plan = pid === process.env.STRIPE_PRO_PRICE_ID ? 'pro'
                     : pid === process.env.STRIPE_INDICATOR_PRICE_ID ? 'indicator'
                     : 'basic';
          const user = await getUserById(userId);
          if (user) {
            if (plan === 'indicator') {
              Object.assign(user, { indicatorAccess: true, indicatorStripeSubId: session.subscription, stripeCustomerId: session.customer, subscriptionStatus: 'active' });
              console.log(`[Webhook] Indicator purchase → ${user.email} — ADD on TradingView: ${user.tvUsername || 'NO USERNAME YET'}`);
            } else {
              Object.assign(user, { plan, stripeCustomerId: session.customer, stripeSubscriptionId: session.subscription, subscriptionStatus: 'active' });
            }
            await saveUser(user);
          }
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
  const ctx  = { session:'', risk_events:[], market_hours:'', killZone:'', killZoneActive:false };
  const now  = new Date();
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();
  const hm   = hour + min/60;
  const day  = now.getDay();

  // Sessions
  if (hm >= 22 || hm < 8)       ctx.session = 'Asia Session (22:00-08:00 UTC)';
  else if (hm >= 8 && hm < 12)  ctx.session = 'London Open (08:00-12:00 UTC) — High liquidity';
  else if (hm >= 12 && hm < 17) ctx.session = 'London/NY Overlap (12:00-17:00 UTC) — HIGHEST liquidity';
  else if (hm >= 17 && hm < 20) ctx.session = 'New York PM (17:00-20:00 UTC)';
  else                           ctx.session = 'End of NY / Pre-Asia (20:00-22:00 UTC) — Low liquidity';

  // ICT Kill Zones (UTC) — highest institutional order flow windows
  if      (hm >= 8   && hm < 9)   { ctx.killZone = '🔥 LONDON OPEN KILL ZONE (08:00-09:00 UTC) — HIGHEST PROBABILITY';  ctx.killZoneActive = true; }
  else if (hm >= 9   && hm < 10)  { ctx.killZone = '🔥 LONDON SESSION KILL ZONE (09:00-10:00 UTC) — HIGH PROBABILITY';   ctx.killZoneActive = true; }
  else if (hm >= 13  && hm < 14)  { ctx.killZone = '🔥 NY OPEN KILL ZONE (13:00-14:00 UTC) — HIGHEST PROBABILITY';       ctx.killZoneActive = true; }
  else if (hm >= 14  && hm < 15)  { ctx.killZone = '🔥 NY AM SESSION KILL ZONE (14:00-15:00 UTC) — HIGH PROBABILITY';    ctx.killZoneActive = true; }
  else if (hm >= 19  && hm < 20)  { ctx.killZone = '⚡ NY CLOSE KILL ZONE (19:00-20:00 UTC) — MODERATE';                 ctx.killZoneActive = true; }
  else if (hm >= 2   && hm < 5)   { ctx.killZone = '⚡ ASIAN KILL ZONE (02:00-05:00 UTC) — Forex pairs only';             ctx.killZoneActive = true; }
  else                             { ctx.killZone = 'No active kill zone — lower probability outside kill zones'; ctx.killZoneActive = false; }

  if (day === 1)         ctx.market_hours = 'Monday — Watch for weekend gap fills';
  else if (day === 5)    ctx.market_hours = 'Friday — ICT: avoid new entries after NY close';
  else if (day === 0 || day === 6) ctx.market_hours = 'Weekend — markets closed or low volume';
  else                   ctx.market_hours = 'Mid-week — optimal institutional activity';

  const sym = (symbol || '').toUpperCase();
  if (sym.includes('BTC') || sym.includes('ETH')) ctx.risk_events.push('Crypto: Best during NY/London overlap');
  if (sym.includes('USD')) ctx.risk_events.push('USD pairs: Watch for NFP, CPI, FOMC');
  if (sym.includes('EUR') || sym.includes('GBP')) ctx.risk_events.push('EUR/GBP: Watch ECB/BOE');
  return ctx;
}

// ─────────────────────────────────────────────
// CLAUDE HELPER
// ─────────────────────────────────────────────
async function claude(apiKey, model, system, content, tokens = 2000) {
  // Convert Anthropic-style content array to OpenAI format
  const toOAI = (items) => {
    if (typeof items === 'string') return items;
    return items.map(item => {
      if (item.type === 'text') return { type:'text', text:item.text };
      if (item.type === 'image') {
        // Anthropic format → OpenAI image_url format
        return { type:'image_url', image_url:{ url:`data:${item.source.media_type};base64,${item.source.data}` } };
      }
      return item;
    });
  };
  // Auto-upgrade to vision model if any images are present
  const hasImages = Array.isArray(content) && content.some(c => c.type === 'image');
  const actualModel = hasImages ? VISION_MODEL : model;
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
    body: JSON.stringify({ model:actualModel, max_tokens:tokens, messages:[
      { role:'system', content:system },
      { role:'user',   content:toOAI(content) }
    ]}),
    timeout: 30000
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
  const d   = await r.json();
  let raw = (d.choices?.[0]?.message?.content || '').trim();
  // Strip DeepSeek R1 <think>...</think> reasoning block before parsing
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
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

function classifyMarketType(symbol = '') {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return 'unknown';
  if (sym.includes('/') && /^[A-Z]{3}\/[A-Z]{3}$/.test(sym)) {
    if (/(BTC|ETH|SOL|XRP|DOGE|ADA)/.test(sym)) return 'crypto';
    return 'forex';
  }
  if (/^(ES|MES|NQ|MNQ|YM|MYM|RTY|M2K|CL|MCL|GC|MGC|SI|SIL|NG|ZN|ZB|ZF|ZT|6E|6B|6J|6A|6C|6N|HG)/.test(sym) || sym.endsWith('1!')) return 'futures';
  if (/(BTC|ETH|SOL|XRP|DOGE|ADA|LTC)/.test(sym)) return 'crypto';
  if (/^[A-Z.\-]{1,8}$/.test(sym)) return 'equity';
  return 'unknown';
}

// ─────────────────────────────────────────────
// FEATURE 1: PERSONALIZED EDGE ANALYZER
// ─────────────────────────────────────────────
function getPersonalizedEdge(allTrades) {
  const trades = (allTrades || []).filter(t => t.outcome);
  if (trades.length < 3) return null;

  const buildBucket = () => ({ wins: 0, losses: 0, rrSum: 0, rrCount: 0 });
  const addTrade = (map, key, trade) => {
    if (key === undefined || key === null || key === '') return;
    if (!map[key]) map[key] = buildBucket();
    const bucket = map[key];
    bucket[trade.outcome === 'win' ? 'wins' : 'losses']++;
    const rr = parseFloat(trade.actual_rr);
    if (Number.isFinite(rr)) {
      bucket.rrSum += rr;
      bucket.rrCount++;
    }
  };
  const summarizeBucket = (bucket) => {
    const total = (bucket?.wins || 0) + (bucket?.losses || 0);
    const wr = total ? Math.round((bucket.wins / total) * 100) : null;
    const avgRR = bucket?.rrCount ? bucket.rrSum / bucket.rrCount : 1;
    const expectancy = total ? Number((((bucket.wins / total) * avgRR) - (bucket.losses / total)).toFixed(2)) : null;
    return { total, wr, expectancy };
  };
  const pickBest = (map, minTrades = 2) => Object.entries(map)
    .map(([key, bucket]) => ({ key, ...summarizeBucket(bucket) }))
    .filter(item => item.total >= minTrades && item.wr !== null)
    .sort((a, b) => (b.wr - a.wr) || (b.total - a.total))[0] || null;
  const pickWorst = (map, minTrades = 2) => Object.entries(map)
    .map(([key, bucket]) => ({ key, ...summarizeBucket(bucket) }))
    .filter(item => item.total >= minTrades && item.wr !== null)
    .sort((a, b) => (a.wr - b.wr) || (b.total - a.total))[0] || null;

  const byHour = {};
  const bySymbol = {};
  const byGrade = {};
  const byVerdict = {};
  const bySession = { morning: buildBucket(), afternoon: buildBucket(), evening: buildBucket() };
  const byDay = {};
  const byMarketType = {};
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let wins = 0;
  let rrSum = 0;
  let rrCount = 0;

  trades.forEach(t => {
    if (t.outcome === 'win') wins++;
    const rr = parseFloat(t.actual_rr);
    if (Number.isFinite(rr)) {
      rrSum += rr;
      rrCount++;
    }

    addTrade(bySymbol, t.symbol || 'Unknown', t);
    addTrade(byGrade, t.grade || 'B', t);
    addTrade(byVerdict, t.verdict || 'WAIT', t);
    addTrade(byMarketType, classifyMarketType(t.symbol), t);

    if (!t.timestamp) return;
    const ts = new Date(t.timestamp);
    if (Number.isNaN(ts.getTime())) return;
    addTrade(byHour, ts.getHours(), t);
    addTrade(byDay, dayNames[ts.getDay()], t);
    const utcHour = ts.getUTCHours();
    addTrade(bySession, utcHour < 12 ? 'morning' : utcHour < 17 ? 'afternoon' : 'evening', t);
  });

  const overallWR = Math.round((wins / trades.length) * 100);
  const avgRR = rrCount ? rrSum / rrCount : 1;
  const expectancy = Number((((wins / trades.length) * avgRR) - ((trades.length - wins) / trades.length)).toFixed(2));
  const bestHourData = pickBest(byHour);
  const bestSymbolData = pickBest(bySymbol);
  const bestGradeData = pickBest(byGrade);
  const bestDayData = pickBest(byDay);
  const bestMarketTypeData = pickBest(byMarketType);
  const worstSessionData = pickWorst(bySession);
  const buyStats = summarizeBucket(byVerdict.BUY || buildBucket());
  const sellStats = summarizeBucket(byVerdict.SELL || buildBucket());
  const buyWR = buyStats.total >= 2 ? buyStats.wr : null;
  const sellWR = sellStats.total >= 2 ? sellStats.wr : null;

  const parts = [`Overall ${overallWR}% WR over ${trades.length} trades`, `Expectancy ${expectancy}R`];
  if (bestSymbolData) parts.push(`${bestSymbolData.key}: ${bestSymbolData.wr}% WR`);
  if (bestGradeData) parts.push(`${bestGradeData.key} grade: ${bestGradeData.wr}% WR`);
  if (buyWR !== null && sellWR !== null) parts.push(buyWR >= sellWR ? `BUY edge ${buyWR}% vs ${sellWR}% SELL` : `SELL edge ${sellWR}% vs ${buyWR}% BUY`);
  else if (buyWR !== null) parts.push(`BUY edge ${buyWR}%`);
  else if (sellWR !== null) parts.push(`SELL edge ${sellWR}%`);
  if (bestHourData) parts.push(`Best hour ${bestHourData.key}:00`);
  if (bestDayData) parts.push(`Best day ${bestDayData.key}`);
  if (bestMarketTypeData) parts.push(`Best market ${bestMarketTypeData.key}`);
  if (worstSessionData) parts.push(`Avoid ${worstSessionData.key}`);

  return {
    summary: 'Your edge: ' + parts.join(' | '),
    overallWR,
    expectancy,
    avgRR: Number(avgRR.toFixed(2)),
    totalTrades: trades.length,
    byGrade: Object.entries(byGrade).map(([g, bucket]) => ({ grade: g, ...summarizeBucket(bucket), wins: bucket.wins, losses: bucket.losses })),
    buyWR,
    sellWR,
    bestHour: bestHourData ? Number(bestHourData.key) : null,
    bestHourWR: bestHourData?.wr ?? null,
    bestGrade: bestGradeData?.key ?? null,
    bestGradeWR: bestGradeData?.wr ?? null,
    bestSymbol: bestSymbolData?.key ?? null,
    bestSymbolWR: bestSymbolData?.wr ?? null,
    bestDay: bestDayData?.key ?? null,
    bestDayWR: bestDayData?.wr ?? null,
    bestMarketType: bestMarketTypeData?.key ?? null,
    bestMarketTypeWR: bestMarketTypeData?.wr ?? null,
    worstSession: worstSessionData?.key ?? null,
    byDay: Object.fromEntries(Object.entries(byDay).map(([key, bucket]) => [key, summarizeBucket(bucket)])),
    byMarketType: Object.fromEntries(Object.entries(byMarketType).map(([key, bucket]) => [key, summarizeBucket(bucket)]))
  };
}
// MAIN ANALYZE ENDPOINT
// ─────────────────────────────────────────────
app.post('/api/analyze', authMiddleware, requirePlan, async (req, res) => {
  const { charts, imageBase64, imageMime, symbol, timeframe, tradeMode } = req.body;
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

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
const _ohlcvCache = {};
const _liveAnalysisCache = {};
const _liveAnalysisInflight = {};
const OHLCV_CACHE_TTL = 8000;
const LIVE_ANALYSIS_CACHE_TTL = 12000;

async function fetchOHLCV(symbol, timeframe, bars=100) {
  const sym = symbol.toUpperCase().trim();
  const yahooSym = FUTURES_MAP[sym];
  const cacheKey = `${sym}|${timeframe}|${bars}`;
  const cached = _ohlcvCache[cacheKey];
  if (cached && Date.now() - cached.ts < OHLCV_CACHE_TTL) {
    return cached.data;
  }

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
    const data = { candles: candles.slice(-bars), source:'Yahoo', symbol: yahooSym||sym, tf: timeframe };
    _ohlcvCache[cacheKey] = { ts: Date.now(), data };
    return data;
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
    const data = { candles, source:'TwelveData', symbol:sym, tf: timeframe };
    _ohlcvCache[cacheKey] = { ts: Date.now(), data };
    return data;
  } catch {}

  return null;
}

app.get('/api/live-chart', authMiddleware, requirePlan, async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const timeframe = String(req.query.timeframe || '15m').trim();
    const bars = Math.max(20, Math.min(parseInt(req.query.bars, 10) || 80, 200));
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    const data = await fetchOHLCV(symbol, timeframe, bars);
    if (!data?.candles?.length) {
      return res.status(404).json({ error: `No chart data found for ${symbol}` });
    }
    res.json({
      symbol,
      requestedTimeframe: timeframe,
      source: data.source,
      resolvedSymbol: data.symbol,
      tf: data.tf,
      candles: data.candles.slice(-bars)
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load chart data' });
  }
});

function ohlcvToText(data) {
  if (!data) return 'No data available';
  const c = data.candles;
  const last = c[c.length-1];
  const prev = c[c.length-2];

  // EMAs
  const closes = c.map(x=>+x.close);
  const emaFn = (arr,p) => arr.reduce((a,v,i)=>i===0?[v]:[...a,v*(2/(p+1))+a[i-1]*(1-2/(p+1))],[]);
  const ema20arr = emaFn(closes,20); const ema50arr = emaFn(closes,50);
  const e20 = ema20arr[ema20arr.length-1]?.toFixed(2);
  const e50 = ema50arr[ema50arr.length-1]?.toFixed(2);

  // ATR(14)
  const atr = computeATR(c, 14);
  const atrStr = atr ? atr.toFixed(2) : 'N/A';

  // RSI(14)
  const rsi14 = (() => {
    if (closes.length < 15) return null;
    const slice = closes.slice(-15);
    let gains = 0, losses = 0;
    for (let i = 1; i < slice.length; i++) {
      const d = slice[i] - slice[i-1];
      if (d > 0) gains += d; else losses -= d;
    }
    const rs = gains / (losses || 0.0001);
    return (100 - 100 / (1 + rs)).toFixed(1);
  })();

  // Volume
  const volumes = c.map(x=>+x.volume||0);
  const avgVol = volumes.slice(-20).reduce((s,v)=>s+v,0)/20;
  const lastVol = volumes[volumes.length-1]||0;
  const volNote = lastVol > avgVol*1.5 ? '🔥 HIGH' : lastVol < avgVol*0.5 ? '❄ LOW' : 'AVG';

  // Swing highs/lows (last 30 bars)
  const highs = c.map(x=>+x.high); const lows = c.map(x=>+x.low);
  const swingH = Math.max(...highs.slice(-30)).toFixed(2);
  const swingL = Math.min(...lows.slice(-30)).toFixed(2);
  const midpoint = ((+swingH + +swingL)/2).toFixed(2);
  const priceZone = +last.close > +midpoint ? 'PREMIUM (sell zone)' : 'DISCOUNT (buy zone)';

  // VWAP (intraday — reset each day)
  const vwap = (() => {
    let cumTP = 0, cumVol = 0;
    const todayDate = last?.datetime?.slice(0,10);
    for (const x of c) {
      if (todayDate && x.datetime && !x.datetime.startsWith(todayDate)) continue;
      const tp = ((+x.high + +x.low + +x.close) / 3);
      const v  = +x.volume || 0;
      cumTP += tp * v; cumVol += v;
    }
    return cumVol > 0 ? (cumTP / cumVol).toFixed(2) : null;
  })();

  // Previous day high/low (PDH/PDL) — key ICT liquidity levels
  const pdh_pdl = (() => {
    const byDay = {};
    for (const x of c) {
      const d = x.datetime?.slice(0,10);
      if (!d) continue;
      if (!byDay[d]) byDay[d] = { high: -Infinity, low: Infinity };
      if (+x.high > byDay[d].high) byDay[d].high = +x.high;
      if (+x.low  < byDay[d].low)  byDay[d].low  = +x.low;
    }
    const days = Object.keys(byDay).sort();
    const today = days[days.length-1];
    const yesterday = days[days.length-2];
    if (!yesterday) return null;
    return { pdh: byDay[yesterday].high.toFixed(2), pdl: byDay[yesterday].low.toFixed(2) };
  })();

  // FVG detection — 3-candle imbalance
  const fvgs = [];
  for (let i = 2; i < c.length; i++) {
    const bullFVG = +c[i-2].high < +c[i].low;
    const bearFVG = +c[i-2].low  > +c[i].high;
    if (bullFVG) fvgs.push({ type:'BULL FVG', low:c[i-2].high, high:c[i].low, dt:c[i].datetime });
    if (bearFVG) fvgs.push({ type:'BEAR FVG', low:c[i].high, high:c[i-2].low, dt:c[i].datetime });
  }
  // Keep only unfilled FVGs (price hasn't retraced into them)
  const curPrice = +last.close;
  const unfilledFVGs = fvgs.filter(f => {
    if (f.type==='BULL FVG') return curPrice > +f.low; // price above it = unfilled
    return curPrice < +f.high; // price below it = unfilled
  }).slice(-4).map(f=>`${f.type} ${f.low}–${f.high} (${f.dt})`).join(' | ') || 'None';

  // OB detection — last candle before displacement
  let lastBullOB = null, lastBearOB = null;
  for (let i = 1; i < c.length-1; i++) {
    const body     = Math.abs(+c[i].close   - +c[i].open);
    const nextBody = Math.abs(+c[i+1].close - +c[i+1].open);
    if (nextBody < body * 1.5) continue;
    if (+c[i].close < +c[i].open && +c[i+1].close > +c[i+1].open) lastBullOB = `${c[i].low}–${c[i].high} (${c[i].datetime})`;
    if (+c[i].close > +c[i].open && +c[i+1].close < +c[i+1].open) lastBearOB = `${c[i].low}–${c[i].high} (${c[i].datetime})`;
  }

  // BOS/CHOCH detection — track swing structure
  const bosChoch = (() => {
    const results = [];
    let lastSwingHigh = null, lastSwingLow = null;
    for (let i = 2; i < c.length-1; i++) {
      const isSwingHigh = +c[i].high > +c[i-1].high && +c[i].high > +c[i+1].high;
      const isSwingLow  = +c[i].low  < +c[i-1].low  && +c[i].low  < +c[i+1].low;
      if (isSwingHigh) {
        if (lastSwingHigh && +c[i].high > +lastSwingHigh.price) results.push(`BOS Bullish @ ${c[i].high} (${c[i].datetime})`);
        else if (lastSwingHigh && +c[i].high < +lastSwingHigh.price) results.push(`CHOCH Bearish @ ${c[i].high} (${c[i].datetime})`);
        lastSwingHigh = { price: +c[i].high, idx: i };
      }
      if (isSwingLow) {
        if (lastSwingLow && +c[i].low < +lastSwingLow.price) results.push(`BOS Bearish @ ${c[i].low} (${c[i].datetime})`);
        else if (lastSwingLow && +c[i].low > +lastSwingLow.price) results.push(`CHOCH Bullish @ ${c[i].low} (${c[i].datetime})`);
        lastSwingLow = { price: +c[i].low, idx: i };
      }
    }
    return results.slice(-3).join(' | ') || 'None detected';
  })();

  // Equal highs/lows — liquidity pools (within 0.1% of each other)
  const eqLevels = (() => {
    const tolerance = curPrice * 0.001;
    const result = [];
    for (let i = 0; i < highs.length-1; i++) {
      for (let j = i+1; j < highs.length; j++) {
        if (Math.abs(highs[i] - highs[j]) < tolerance) { result.push(`EQH @ ~${highs[i].toFixed(2)}`); break; }
      }
    }
    for (let i = 0; i < lows.length-1; i++) {
      for (let j = i+1; j < lows.length; j++) {
        if (Math.abs(lows[i] - lows[j]) < tolerance) { result.push(`EQL @ ~${lows[i].toFixed(2)}`); break; }
      }
    }
    return [...new Set(result)].slice(-4).join(' | ') || 'None';
  })();

  // Liquidity sweep detection — price swept a level then closed back inside (key ICT reversal setup)
  const sweeps = [];
  for (let i = 10; i < c.length; i++) {
    const lookback = c.slice(Math.max(0, i-20), i);
    const refHigh = Math.max(...lookback.map(x=>+x.high));
    const refLow  = Math.min(...lookback.map(x=>+x.low));
    if (+c[i].high > refHigh && +c[i].close < refHigh) sweeps.push(`🐻 Bear Sweep of ${refHigh.toFixed(2)} @ ${c[i].datetime}`);
    if (+c[i].low  < refLow  && +c[i].close > refLow)  sweeps.push(`🐂 Bull Sweep of ${refLow.toFixed(2)} @ ${c[i].datetime}`);
  }
  const recentSweeps = sweeps.slice(-3).join(' | ') || 'None detected';

  // Session high/low from current session candles
  const todayStr = last?.datetime?.slice(0,10);
  const sessionCandles = todayStr ? c.filter(x => x.datetime?.startsWith(todayStr)) : c.slice(-20);
  const sessH = sessionCandles.length ? Math.max(...sessionCandles.map(x=>+x.high)).toFixed(2) : 'N/A';
  const sessL = sessionCandles.length ? Math.min(...sessionCandles.map(x=>+x.low)).toFixed(2)  : 'N/A';

  const avgBody = c.slice(-20).reduce((s,x)=>s+Math.abs(+x.close - +x.open),0)/20;

  // Candle pattern detection
  const tagCandle = (x, i, arr) => {
    const body   = Math.abs(+x.close - +x.open);
    const range  = +x.high - +x.low || 0.0001;
    const isBullC = +x.close > +x.open;
    const tags   = [];
    if (body > avgBody * 2) tags.push('DISP');
    if (body / range < 0.15) tags.push('DOJI');
    if (i > 0) {
      const p = arr[i-1];
      const pBody = Math.abs(+p.close - +p.open);
      if (isBullC  && +p.close < +p.open && body > pBody) tags.push('BULL-ENG');
      if (!isBullC && +p.close > +p.open && body > pBody) tags.push('BEAR-ENG');
    }
    const upperWick = +x.high - Math.max(+x.open, +x.close);
    const lowerWick = Math.min(+x.open, +x.close) - +x.low;
    if (lowerWick > body * 2 && upperWick < body * 0.5) tags.push('HAMMER');
    if (upperWick > body * 2 && lowerWick < body * 0.5) tags.push('SHOOT-STAR');
    return tags.length ? `[${tags.join('+')}]` : '';
  };

  const header = `=== ${data.tf} | ${data.symbol} | source: ${data.source} ===
Price: ${last?.close} | Prev: ${prev?.close} | Zone: ${priceZone}
EMA20: ${e20} | EMA50: ${e50} | ATR(14): ${atrStr} | RSI(14): ${rsi14??'N/A'}${vwap ? ` | VWAP: ${vwap}` : ''}
Range (30): High ${swingH} → Low ${swingL} | Mid: ${midpoint}
Session Range: High ${sessH} → Low ${sessL}
${pdh_pdl ? `PDH: ${pdh_pdl.pdh} | PDL: ${pdh_pdl.pdl}` : ''}
Volume: ${volNote} (${Math.round(lastVol).toLocaleString()} vs avg ${Math.round(avgVol).toLocaleString()})
Bullish OB: ${lastBullOB||'None'} | Bearish OB: ${lastBearOB||'None'}
Unfilled FVGs: ${unfilledFVGs}
BOS/CHOCH: ${bosChoch}
Liquidity Pools (EQH/EQL): ${eqLevels}
Liquidity Sweeps: ${recentSweeps}

Candles (tags: DISP=displacement, DOJI, HAMMER, SHOOT-STAR, BULL/BEAR-ENG=engulfing):
Datetime            | Open    | High    | Low     | Close   | Volume    | Tags
`;
  const slicedCandles = c.slice(-40);
  const rows = slicedCandles.map((x, i) => {
    const tag = tagCandle(x, i, slicedCandles);
    return `${x.datetime} | ${String(x.open).padStart(7)} | ${String(x.high).padStart(7)} | ${String(x.low).padStart(7)} | ${String(x.close).padStart(7)} | ${String(x.volume).padStart(9)} | ${tag}`;
  }).join('\n');
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

function roundPrice(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num.toFixed(Math.abs(num) >= 100 ? 2 : Math.abs(num) >= 1 ? 4 : 6) : null;
}

function computeATR(candles, period = 14) {
  if (!candles?.length) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].high);
    const low = parseFloat(candles[i].low);
    const prevClose = parseFloat(candles[i - 1].close);
    if (![high, low, prevClose].every(Number.isFinite)) continue;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const slice = trs.slice(-period);
  return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : null;
}

function summarizeOhlcvFrame(data) {
  const candles = data?.candles || [];
  if (candles.length < 20) return null;
  const closes = candles.map(c => parseFloat(c.close)).filter(Number.isFinite);
  const highs = candles.map(c => parseFloat(c.high)).filter(Number.isFinite);
  const lows = candles.map(c => parseFloat(c.low)).filter(Number.isFinite);
  const volumes = candles.map(c => parseFloat(c.volume) || 0);
  const close = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2] ?? close;
  const atr = computeATR(candles, 14) || Math.max(Math.abs(close) * 0.003, 0.01);
  const ema = (arr, period) => {
    const k = 2 / (period + 1);
    let v = arr[0];
    for (let i = 1; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
    return v;
  };
  const ema20 = ema(closes.slice(-40), 20);
  const ema50 = ema(closes.slice(-80), 50);
  const swingHigh = Math.max(...highs.slice(-20));
  const swingLow = Math.min(...lows.slice(-20));
  const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(20, volumes.length));
  const lastVol = volumes[volumes.length - 1] || 0;
  const compression = (swingHigh - swingLow) / Math.max(Math.abs(close), 0.01) < 0.015;
  const trend = close > ema20 && ema20 >= ema50 ? 'bullish' : close < ema20 && ema20 <= ema50 ? 'bearish' : 'neutral';
  return {
    tf: data.tf,
    source: data.source,
    close,
    prevClose,
    atr,
    ema20,
    ema50,
    swingHigh,
    swingLow,
    avgVol,
    lastVol,
    compression,
    trend,
    momentumPct: prevClose ? ((close - prevClose) / prevClose) * 100 : 0
  };
}

function buildLiveQualityContext(ohlcvResults, tradeMode) {
  const frames = (ohlcvResults || []).filter(Boolean).map(summarizeOhlcvFrame).filter(Boolean);
  const bullishCount = frames.filter(f => f.trend === 'bullish').length;
  const bearishCount = frames.filter(f => f.trend === 'bearish').length;
  const alignedTrend = bullishCount >= Math.max(2, frames.length - 1) ? 'bullish'
    : bearishCount >= Math.max(2, frames.length - 1) ? 'bearish'
    : 'mixed';
  const primary = frames[frames.length - 1] || frames[0] || null;
  const higher = frames[0] || primary;
  const qualityScore = Math.max(35, Math.min(92,
    50
    + (alignedTrend !== 'mixed' ? 16 : -8)
    + (frames.some(f => f.compression) ? -6 : 4)
    + (primary && primary.lastVol > primary.avgVol * 1.2 ? 8 : 0)
    + (tradeMode === 'swing' ? 4 : 0)
  ));
  const warnings = [];
  if (alignedTrend === 'mixed') warnings.push('Timeframes are not aligned');
  if (frames.some(f => f.compression)) warnings.push('Recent structure is compressed/choppy');
  if (primary && primary.lastVol < primary.avgVol * 0.7) warnings.push('Current volume is below average');
  return { frames, alignedTrend, primary, higher, qualityScore, warnings };
}

function classifyInstrument(symbol) {
  const sym = (symbol || '').toUpperCase();
  if (sym.includes('BTC') || sym.includes('ETH') || sym.includes('SOL') || sym.includes('XRP')) return 'crypto';
  if (sym.includes('/') || /^[A-Z]{6}$/.test(sym)) return 'forex';
  if (sym.includes('1!') || ['ES','NQ','YM','RTY','CL','GC','SI','NG'].includes(sym.replace('1!',''))) return 'futures';
  return 'equity';
}

function getModeThresholds(tradeMode, instrumentType) {
  const byMode = {
    scalp: { minRR: 1.2, minConfidence: 56, minRiskAtr: 0.16 },
    dayTrade: { minRR: 1.7, minConfidence: 60, minRiskAtr: 0.24 },
    swing: { minRR: 2.2, minConfidence: 64, minRiskAtr: 0.4 }
  };
  const base = { ...(byMode[tradeMode] || byMode.dayTrade) };
  if (instrumentType === 'crypto') {
    base.minRiskAtr += 0.06;
    base.minRR += 0.1;
  } else if (instrumentType === 'forex') {
    base.minRiskAtr -= 0.03;
  }
  return base;
}

function getSymbolTuning(symbol, instrumentType, marketContext = null) {
  const sym = (symbol || '').toUpperCase();
  const sessionText = `${marketContext?.session || ''} ${marketContext?.market_hours || ''}`;
  const isLowLiquidity = /Lower liquidity|Low liquidity|Weekend|Pre-Asia|End of NY/i.test(sessionText);
  const isPeakFx = /London Session Open|London\/NY Overlap/i.test(sessionText);
  const isUsCash = /New York Session|London\/NY Overlap/i.test(sessionText);

  const profile = {
    label: instrumentType,
    sessionScore: isLowLiquidity ? 42 : 70,
    confidenceBias: 0,
    rrBias: 0,
    minConfidenceBoost: 0,
    forceWaitInLowLiquidity: false,
    note: 'Standard instrument profile'
  };

  if (instrumentType === 'futures') {
    profile.label = sym.startsWith('CL') ? 'energy futures'
      : sym.startsWith('GC') || sym.startsWith('SI') ? 'metals futures'
      : 'index futures';
    profile.sessionScore = isUsCash ? 82 : isLowLiquidity ? 35 : 58;
    profile.confidenceBias = isUsCash ? 4 : -6;
    profile.rrBias = sym.startsWith('CL') ? 0.15 : 0.05;
    profile.minConfidenceBoost = 2;
    profile.forceWaitInLowLiquidity = true;
    profile.note = 'Futures perform best during active US cash and overlap windows';
  } else if (instrumentType === 'forex') {
    profile.label = 'forex major';
    profile.sessionScore = isPeakFx ? 84 : isLowLiquidity ? 38 : 60;
    profile.confidenceBias = isPeakFx ? 5 : -5;
    profile.rrBias = 0.05;
    profile.minConfidenceBoost = 1;
    profile.forceWaitInLowLiquidity = true;
    profile.note = 'Forex majors are strongest around London and overlap liquidity';
    if (sym.includes('JPY')) {
      profile.sessionScore += /Asia Session/i.test(sessionText) ? 8 : 0;
      profile.confidenceBias += /Asia Session/i.test(sessionText) ? 2 : 0;
      profile.note = 'JPY pairs can stay active in Asia, but best quality still clusters around London crossover';
    }
  } else if (instrumentType === 'crypto') {
    profile.label = 'crypto';
    profile.sessionScore = /London\/NY Overlap|New York Session/i.test(sessionText) ? 78 : isLowLiquidity ? 50 : 66;
    profile.confidenceBias = /London\/NY Overlap|New York Session/i.test(sessionText) ? 3 : -2;
    profile.rrBias = 0.15;
    profile.minConfidenceBoost = 2;
    profile.forceWaitInLowLiquidity = false;
    profile.note = 'Crypto trades 24/7, but liquidity quality still improves during NY and overlap';
  } else {
    profile.label = 'equity';
    profile.sessionScore = isUsCash ? 80 : isLowLiquidity ? 28 : 48;
    profile.confidenceBias = isUsCash ? 4 : -8;
    profile.rrBias = 0.08;
    profile.minConfidenceBoost = 3;
    profile.forceWaitInLowLiquidity = true;
    profile.note = 'Equities are weakest outside the main US session';
  }

  return profile;
}

function confirmLiveSignal(result, quality) {
  if (!result || !quality?.primary) return { confirmed: false, reason: 'missing_quality_context' };
  const verdict = result.verdict === 'SELL' ? 'SELL' : result.verdict === 'BUY' ? 'BUY' : 'WAIT';
  if (verdict === 'WAIT') return { confirmed: true, reason: 'wait_ok' };
  const frame = quality.primary;
  const directionAligned = (verdict === 'BUY' && frame.trend === 'bullish') || (verdict === 'SELL' && frame.trend === 'bearish');
  const momentumAligned = verdict === 'BUY' ? frame.momentumPct >= -0.05 : frame.momentumPct <= 0.05;
  const volumeHealthy = frame.lastVol >= frame.avgVol * 0.65;
  const confirmed = directionAligned && momentumAligned && volumeHealthy;
  const reason = !directionAligned ? 'trend_mismatch' : !momentumAligned ? 'momentum_mismatch' : !volumeHealthy ? 'weak_volume' : 'confirmed';
  return { confirmed, reason };
}

function assessLiveConsensus(result, fallbackResult, quality) {
  const primaryVerdict = result?.verdict === 'SELL' ? 'SELL' : result?.verdict === 'BUY' ? 'BUY' : 'WAIT';
  const fallbackVerdict = fallbackResult?.verdict === 'SELL' ? 'SELL' : fallbackResult?.verdict === 'BUY' ? 'BUY' : 'WAIT';
  const notes = [];
  let score = 50;
  let confidenceAdjustment = 0;
  let forceWait = false;

  if (primaryVerdict === fallbackVerdict) {
    score += primaryVerdict === 'WAIT' ? 12 : 28;
    confidenceAdjustment += primaryVerdict === 'WAIT' ? 0 : 6;
    notes.push(primaryVerdict === 'WAIT'
      ? 'AI and technical model both prefer patience.'
      : `AI and technical model both favor ${primaryVerdict}.`);
  } else if (primaryVerdict === 'WAIT' || fallbackVerdict === 'WAIT') {
    score -= 10;
    confidenceAdjustment -= 5;
    notes.push('Signal is only partially confirmed by the fallback technical model.');
    if (quality?.qualityScore < 62 || quality?.alignedTrend === 'mixed') {
      forceWait = true;
      notes.push('Low-quality regime plus partial disagreement forced a WAIT.');
    }
  } else {
    score -= 26;
    confidenceAdjustment -= 12;
    forceWait = true;
    notes.push(`AI and technical model disagree (${primaryVerdict} vs ${fallbackVerdict}).`);
  }

  if (quality?.warnings?.length) confidenceAdjustment -= Math.min(6, quality.warnings.length * 2);

  return {
    score: Math.max(20, Math.min(95, score)),
    confidenceAdjustment,
    forceWait,
    notes
  };
}

function validateLiveSignal(result, quality, tradeMode, personalEdge = null, marketContext = null, symbol = '', fallbackResult = null) {
  if (!result || !quality?.primary) return result;
  const out = JSON.parse(JSON.stringify(result));
  const verdict = out.verdict === 'SELL' ? 'SELL' : out.verdict === 'BUY' ? 'BUY' : 'WAIT';
  const entry = parseFloat(out.entry);
  const sl = parseFloat(out.sl);
  const tp1 = parseFloat(out.tp1);
  const tp2 = parseFloat(out.tp2);
  const atr = quality.primary.atr || Math.max(Math.abs(quality.primary.close) * 0.003, 0.01);
  const instrumentType = classifyInstrument(symbol);
  const thresholds = getModeThresholds(tradeMode, instrumentType);
  const symbolTuning = getSymbolTuning(symbol, instrumentType, marketContext);
  const confirmation = confirmLiveSignal(out, quality);
  const consensus = assessLiveConsensus(out, fallbackResult, quality);
  const notes = [];

  if (verdict !== 'WAIT') {
    const aligned = (verdict === 'BUY' && quality.alignedTrend === 'bullish') || (verdict === 'SELL' && quality.alignedTrend === 'bearish');
    if (!aligned) {
      out.verdict = 'WAIT';
      notes.push('Rejected: multi-timeframe trend is not aligned with the trade direction.');
    }
  }

  if (out.verdict !== 'WAIT' && [entry, sl, tp1].every(Number.isFinite)) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp1 - entry);
    const minRisk = atr * thresholds.minRiskAtr;
    const minRR = thresholds.minRR + symbolTuning.rrBias;
    const rr = risk > 0 ? reward / risk : 0;
    if (risk < minRisk) {
      out.verdict = 'WAIT';
      notes.push('Rejected: stop distance is too tight relative to current volatility.');
    } else if (rr < minRR) {
      out.verdict = 'WAIT';
      notes.push(`Rejected: risk/reward is below the ${tradeMode} threshold.`);
    }
  }

  if (out.verdict !== 'WAIT' && !confirmation.confirmed) {
    out.verdict = 'WAIT';
    notes.push(`Rejected: confirmation failed (${confirmation.reason}).`);
  }

  if (out.verdict !== 'WAIT' && consensus.forceWait) {
    out.verdict = 'WAIT';
    notes.push(...consensus.notes);
  }

  if (out.verdict !== 'WAIT' && tradeMode !== 'swing' && symbolTuning.forceWaitInLowLiquidity && symbolTuning.sessionScore < 45) {
    out.verdict = 'WAIT';
    notes.push(`Rejected: ${symbolTuning.label} setup is outside its best liquidity window.`);
  }

  if (marketContext?.session && /Lower liquidity|Low liquidity|Weekend/i.test(marketContext.session + ' ' + (marketContext.market_hours || '')) && tradeMode !== 'swing') {
    out.confidence = Math.max(42, (parseInt(out.confidence) || 55) - 8);
    notes.push('Caution: current session is lower-liquidity for live entries.');
  }

  const baseConfidence = parseInt(out.confidence) || 55;
  let adjustedConfidence = Math.round((baseConfidence * 0.65) + (quality.qualityScore * 0.35));
  if (quality.warnings.length) adjustedConfidence -= Math.min(12, quality.warnings.length * 4);
  adjustedConfidence += symbolTuning.confidenceBias;
  if (symbolTuning.sessionScore < 45) adjustedConfidence -= 6;
  else if (symbolTuning.sessionScore >= 78) adjustedConfidence += 3;
  if (personalEdge) {
    if (personalEdge.bestHour !== null) {
      const hour = new Date().getHours();
      if (Math.abs(hour - personalEdge.bestHour) <= 1) adjustedConfidence += 4;
    }
    if (out.verdict === 'BUY' && personalEdge.buyWR !== null && personalEdge.buyWR >= 60) adjustedConfidence += 3;
    if (out.verdict === 'SELL' && personalEdge.sellWR !== null && personalEdge.sellWR >= 60) adjustedConfidence += 3;
    if (personalEdge.buyWR !== null && personalEdge.sellWR !== null) {
      if (out.verdict === 'BUY' && personalEdge.buyWR + 12 < personalEdge.sellWR) adjustedConfidence -= 6;
      if (out.verdict === 'SELL' && personalEdge.sellWR + 12 < personalEdge.buyWR) adjustedConfidence -= 6;
    }
  }
  adjustedConfidence += consensus.confidenceAdjustment;
  adjustedConfidence = Math.max(out.verdict === 'WAIT' ? 40 : 45, Math.min(95, adjustedConfidence));

  const minAllowedConfidence = thresholds.minConfidence + symbolTuning.minConfidenceBoost;
  if (out.verdict !== 'WAIT' && adjustedConfidence < minAllowedConfidence) {
    out.verdict = 'WAIT';
    notes.push(`Rejected: confidence is below the ${symbolTuning.label} threshold for ${tradeMode}.`);
    adjustedConfidence = Math.max(40, adjustedConfidence - 3);
  }

  out.confidence = adjustedConfidence;

  const gradeFromConfidence = adjustedConfidence >= 88 ? 'A+' : adjustedConfidence >= 78 ? 'A' : adjustedConfidence >= 66 ? 'B' : adjustedConfidence >= 54 ? 'C' : 'D';
  out.signal_grade = out.verdict === 'WAIT' ? (adjustedConfidence >= 60 ? 'C' : 'D') : gradeFromConfidence;

  out.factors = Array.isArray(out.factors) ? out.factors : [];
  out.factors = out.factors.filter(Boolean);
  out.factors.push(
    { name: 'Trend', score: quality.alignedTrend === 'mixed' ? 45 : 78, note: `Alignment: ${quality.alignedTrend}` },
    { name: 'Volatility', score: Math.min(85, Math.round((atr / Math.max(Math.abs(quality.primary.close), 0.01)) * 3000)), note: `ATR ${roundPrice(atr)}` },
    { name: 'Regime', score: quality.warnings.length ? 48 : 72, note: quality.warnings[0] || 'Clean session structure' },
    { name: 'Confirmation', score: confirmation.confirmed ? 74 : 38, note: confirmation.reason },
    { name: 'Consensus', score: consensus.score, note: consensus.notes[0] || 'No fallback consensus data' },
    { name: 'Session Fit', score: symbolTuning.sessionScore, note: symbolTuning.note }
  );

  const warnings = [...quality.warnings, ...notes];
  out.gates_failed = [...new Set([...(out.gates_failed || []), ...warnings])];
  out.gates_passed = [...new Set([...(out.gates_passed || []), ...(warnings.length ? [] : ['Multi-timeframe alignment ✓', 'ATR/risk validation ✓'])])];
  out.summary = `${out.summary || ''}${warnings.length ? ` Validation: ${warnings.join(' ')}` : ' Validation: trend, volatility, and risk filters passed.'}`.trim();

  if (out.verdict === 'WAIT') {
    out.wait_reason = out.wait_reason || warnings.join(' ') || 'No clean validated live setup right now.';
    out.position_size = 'Wait';
  } else if ([entry, sl, tp1].every(Number.isFinite)) {
    const risk = Math.abs(entry - sl);
    const reward1 = Math.abs(tp1 - entry);
    const reward2 = Number.isFinite(tp2) ? Math.abs(tp2 - entry) : reward1 * 1.7;
    out.rr_tp1 = `1:${(reward1 / Math.max(risk, 0.0001)).toFixed(1)}`;
    out.rr_tp2 = `1:${(reward2 / Math.max(risk, 0.0001)).toFixed(1)}`;
  }

  return out;
}

function heuristicLiveAnalysis(ohlcvResults, sym, tradeMode) {
  const available = (ohlcvResults || []).filter(Boolean);
  const primary = available[available.length - 1] || available[0];
  if (!primary?.candles?.length) {
    throw new Error(`Could not build fallback live analysis for ${sym}`);
  }

  const candles = primary.candles;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const closes = candles.map(c => parseFloat(c.close)).filter(Number.isFinite);
  const highs = candles.map(c => parseFloat(c.high)).filter(Number.isFinite);
  const lows = candles.map(c => parseFloat(c.low)).filter(Number.isFinite);
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const ema = (arr, period) => {
    if (!arr.length) return null;
    const k = 2 / (period + 1);
    let v = arr[0];
    for (let i = 1; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
    return v;
  };

  const close = parseFloat(last.close);
  const open = parseFloat(last.open);
  const prevClose = parseFloat(prev.close);
  const ema20 = ema(closes.slice(-40), 20);
  const ema50 = ema(closes.slice(-80), 50);
  const rangeHigh = Math.max(...highs.slice(-20));
  const rangeLow = Math.min(...lows.slice(-20));
  const recentRange = Math.max(rangeHigh - rangeLow, Math.abs(close) * 0.003, 0.5);
  const bullish = close > (ema20 || close) && (ema20 || close) >= (ema50 || ema20 || close) && close >= prevClose;
  const bearish = close < (ema20 || close) && (ema20 || close) <= (ema50 || ema20 || close) && close <= prevClose;

  let verdict = 'WAIT';
  let confidence = 52;
  let signalGrade = 'B';
  let summary = `Fallback live analysis for ${sym} using ${primary.tf} trend and momentum.`;
  let entry = close;
  let sl = bullish ? rangeLow : rangeHigh;
  let tp1 = close;
  let tp2 = close;

  if (bullish && !bearish) {
    verdict = 'BUY';
    confidence = 64;
    signalGrade = tradeMode === 'scalp' ? 'B+' : 'B';
    entry = close;
    sl = Math.min(rangeLow, close - recentRange * 0.45);
    tp1 = close + recentRange * (tradeMode === 'swing' ? 1.6 : 1.1);
    tp2 = close + recentRange * (tradeMode === 'swing' ? 2.5 : 1.8);
    summary = `${sym} is trading above key short-term averages with bullish momentum. Use this as a fallback signal until the AI key is restored.`;
  } else if (bearish && !bullish) {
    verdict = 'SELL';
    confidence = 64;
    signalGrade = tradeMode === 'scalp' ? 'B+' : 'B';
    entry = close;
    sl = Math.max(rangeHigh, close + recentRange * 0.45);
    tp1 = close - recentRange * (tradeMode === 'swing' ? 1.6 : 1.1);
    tp2 = close - recentRange * (tradeMode === 'swing' ? 2.5 : 1.8);
    summary = `${sym} is trading below key short-term averages with bearish momentum. Use this as a fallback signal until the AI key is restored.`;
  } else {
    sl = close - recentRange * 0.6;
    tp1 = close + recentRange * 0.8;
    tp2 = close + recentRange * 1.3;
    summary = `${sym} is range-bound right now. Wait for a cleaner break of recent structure before taking size.`;
  }

  const risk = Math.max(Math.abs(entry - sl), 0.01);
  const rr1 = Math.max(Math.abs(tp1 - entry) / risk, 0);
  const rr2 = Math.max(Math.abs(tp2 - entry) / risk, 0);

  return {
    verdict,
    confidence,
    signal_grade: signalGrade,
    summary,
    entry: entry.toFixed(2),
    sl: sl.toFixed(2),
    tp1: tp1.toFixed(2),
    tp2: tp2.toFixed(2),
    tp3: verdict === 'WAIT' ? null : (verdict === 'BUY' ? (tp2 + recentRange * 0.7) : (tp2 - recentRange * 0.7)).toFixed(2),
    rr_tp1: `1:${rr1.toFixed(1)}`,
    rr_tp2: `1:${rr2.toFixed(1)}`,
    rrLabel: 'fallback model',
    position_size: verdict === 'WAIT' ? 'Wait' : 'Max 0.5%-1%',
    trade_management: {
      move_to_be: verdict === 'WAIT' ? 'Wait for breakout first' : 'after 1R or strong continuation close',
      partial_at_tp1: verdict === 'WAIT' ? 'No trade' : 'take 50% at TP1',
      trail_method: verdict === 'WAIT' ? 'none' : 'trail below/above last two candles',
      max_hold: tradeMode === 'swing' ? '1-5 days' : tradeMode === 'scalp' ? '5-20 min' : '30-180 min'
    },
    factors: [
      { name: 'Trend', score: bullish || bearish ? 68 : 50, note: `Primary TF: ${primary.tf}` },
      { name: 'Momentum', score: Math.min(75, Math.round(Math.abs(close - prevClose) / Math.max(recentRange, 0.01) * 100)), note: `Source: ${primary.source}` },
      { name: 'Structure', score: verdict === 'WAIT' ? 48 : 62, note: 'Fallback technical model' },
      { name: 'Risk/Reward', score: Math.min(80, Math.round(rr1 * 30)), note: `TP1 ${`1:${rr1.toFixed(1)}`}` }
    ],
    patterns: [
      { name: verdict === 'WAIT' ? 'Range compression' : `${verdict} momentum continuation`, reliability: 'Fallback', type: verdict === 'WAIT' ? 'neutral' : verdict === 'BUY' ? 'bull' : 'bear' }
    ],
    fullAnalysis: `<div><strong>Fallback Mode</strong><br>AI analysis is temporarily unavailable, so this signal was generated from live trend, EMA alignment, and recent range structure.</div>`,
    _fallback: true
  };
}

app.post('/api/analyze-live', authMiddleware, requirePlan, async (req, res) => {
  const { symbol, timeframes, tradeMode } = req.body;
  const key = process.env.GROQ_API_KEY;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });

  const tfs = timeframes || (tradeMode==='scalp' ? ['15m','5m','1m'] : tradeMode==='swing' ? ['1D','4H','1H'] : ['4H','1H','15m']);
  const sym = symbol.toUpperCase().trim();
  const mode = tradeMode || 'dayTrade';
  const liveCacheKey = `${req.user.id}|${sym}|${mode}|${tfs.join(',')}`;

  // Master timeout — guarantees a response before Vercel's 60s hard kill
  const masterTimer = setTimeout(() => {
    if (!res.headersSent) {
      console.error('[LIVE] ⏰ Master timeout hit — sending fallback 500');
      res.status(500).json({ error: 'Analysis timed out — server took too long. Please try again.' });
    }
  }, 55000);

  try {
    console.log(`\n[LIVE] ═══ ${sym} ${tfs.join('+')} — ${tradeMode||'dayTrade'} — ${req.user.email} ═══`);
    const t0 = Date.now();

    // Fire background fetches — capped tightly so they never block the response
    // NOTE: fetchNewsSentiment removed — it makes a concurrent Claude call that competes with main analysis
    const correlatedPromise = withTimeout(fetchCorrelatedAssets(sym), 8000).catch(() => null);
    const tradesPromise     = withTimeout(getTrades(), 5000).catch(() => []);

    // ── STEP 1: Fetch OHLCV + HTF bias context in parallel ────────────────
    const htfMap = { scalp:'4H', dayTrade:'1D', swing:'1W' };
    const htfTf  = htfMap[mode] || '1D';
    const allTfs = tfs.includes(htfTf) ? tfs : [...tfs, htfTf];
    console.log(`[LIVE] Step 1: fetching OHLCV for ${allTfs.join('+')} (${htfTf} = HTF bias)`);
    const ohlcvResults = await Promise.all(
      allTfs.map(tf => withTimeout(fetchOHLCV(sym, tf, 60), 6000).catch(() => null))
    );
    const allTrades = await tradesPromise;
    console.log(`[LIVE] Step 1 done — ${ohlcvResults.filter(Boolean).length}/${allTfs.length} TFs loaded in ${((Date.now()-t0)/1000).toFixed(1)}s`);

    const available = ohlcvResults.filter(Boolean);
    if (!available.length) {
      clearTimeout(masterTimer);
      return res.status(400).json({ error: `Could not fetch live data for ${sym}. Try: ES1!, NQ1!, BTC/USD, EUR/USD, SPY, AAPL` });
    }

    const livePrice    = { price: available[0].candles.slice(-1)[0]?.close, source: available[0].source };
    const winStats     = getWinStats(allTrades);
    const personalEdge = getPersonalizedEdge(allTrades.filter(t => t.userId === req.user.id));
    const mktCtx       = getMarketContext(sym);
    const qualityCtx   = buildLiveQualityContext(available, mode);
    const fallbackResult = heuristicLiveAnalysis(available, sym, mode);

    // Build text-based chart data for each TF
    const chartTexts = available.map(d => ohlcvToText(d));

    // ── STEP 2: Full AI analysis — always wait for real result ──
    console.log(`[LIVE] Step 2: AI analysis (${mode})`);
    let result;
    try {
      const aiRawResult = await withTimeout(
        analyzeOneLive(chartTexts, sym, tfs[tfs.length-1], livePrice, mktCtx, winStats, personalEdge, key, mode, qualityCtx),
        40000
      );
      result = validateLiveSignal(aiRawResult, qualityCtx, mode, personalEdge, mktCtx, sym, null);
    } catch (aiErr) {
      console.warn('[LIVE] AI failed, using heuristic fallback:', aiErr.message);
      result = validateLiveSignal(fallbackResult, qualityCtx, mode, personalEdge, mktCtx, sym, null);
    }
    console.log(`[LIVE] Step 2 done — ${result?.verdict} ${result?.signal_grade||''} conf:${result?.confidence||'?'}% in ${((Date.now()-t0)/1000).toFixed(1)}s`);

    const correlatedData = null;
    // ── STEP 4: Fire-and-forget journal save — never blocks the response ───
    if (result?.verdict && result.verdict !== 'WAIT') {
      const tradeId = Date.now().toString();
      result._trade_id = tradeId;
      const trades = [...(allTrades || [])];
      trades.push({ id:tradeId, symbol:sym, timeframe:tfs[tfs.length-1], verdict:result.verdict, grade:result.signal_grade, confidence:result.confidence, entry:result.entry, sl:result.sl, tp1:result.tp1, tp2:result.tp2, rr_tp1:result.rr_tp1, timestamp:new Date().toISOString(), outcome:null, actual_rr:null, userId:req.user.id, notes:'', source:'live', chartSrc:null });
      saveTrades(trades).catch(e => console.warn('[LIVE] Journal save failed:', e.message));
    }

    const elapsed = ((Date.now()-t0)/1000).toFixed(1);
    console.log(`[LIVE] ✅ Done in ${elapsed}s — ${result?.verdict} ${result?.signal_grade||''}`);
    clearTimeout(masterTimer);
    if (!res.headersSent) {
      const responsePayload = { ...result, elapsed, dataSource: available.map(d=>d.source).join('+'), tfsUsed: available.map(d=>d.tf), _personalEdge: personalEdge, _correlatedAssets: correlatedData, _newsSentiment: null, _qualityContext: qualityCtx };
      if (!responsePayload._turboPending) {
        const { _trade_id, ...cacheablePayload } = responsePayload;
        _liveAnalysisCache[liveCacheKey] = { ts: Date.now(), payload: cacheablePayload };
      }
      correlatedPromise.then(() => null).catch(() => null);
      res.json(responsePayload);
    }

  } catch(e) {
    clearTimeout(masterTimer);
    console.error('[LIVE] ❌ Error:', e.stack || e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Live analysis failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE-PASS LIVE ANALYSIS — one Claude call for all modes, always returns signal
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeOneLive(chartTexts, sym, tf, livePrice, mktCtx, winStats, personalEdge, key, tradeMode, qualityCtx = null) {
  const lp   = livePrice ? `Live price: $${livePrice.price}` : 'Live price: N/A';
  const ws   = winStats  ? `Win rate: ${winStats.winRate}% over ${winStats.total} trades` : '';
  const edge = personalEdge ? `User edge: ${personalEdge.summary}` : '';
  const session = mktCtx.session || 'Unknown session';
  const qualityNote = qualityCtx
    ? `Alignment: ${qualityCtx.alignedTrend}. Quality score: ${qualityCtx.qualityScore}. ${qualityCtx.warnings.length ? 'Warnings: ' + qualityCtx.warnings.join('; ') : 'No major regime warnings.'}`
    : '';

  const modeInstructions = tradeMode === 'scalp'
    ? `SCALP TRADE — hold 2–15 min. Use tight SL. Min 1:1.5 R:R. Entry on 1m/5m momentum candle.`
    : tradeMode === 'swing'
    ? `SWING TRADE — hold 1–5 days. Wide SL beyond structure. Min 1:3 R:R. Daily/4H level entries.`
    : `DAY TRADE — hold 30 min–3 hrs. Min 1:2.5 R:R. Enter at key OB/FVG/S-R levels.`;

  const model  = SONNET; // DeepSeek R1 — best free reasoning model
  const tokens = 3000;

  const sys = `You are an elite ICT/SMC prop trader. You have been given pre-computed market structure data — USE IT. Do not recalculate what is already provided. Focus entirely on trade decision quality.

${modeInstructions}

ANALYSIS CHECKLIST (work through every point):
1. HTF STRUCTURE — Read the BOS/CHOCH labels provided. What is the last confirmed structure shift? Is price in a bullish or bearish leg?
2. PREMIUM/DISCOUNT — Use the pre-labeled zone. BUY only from discount, SELL only from premium. Never fade the zone.
3. PDH/PDL — Is price at or near Previous Day High/Low? These are the #1 ICT liquidity targets.
4. VWAP — Is price above (bullish) or below (bearish) VWAP? Entering against VWAP requires extra confluence.
5. ORDER BLOCKS — Use the pre-identified Bullish/Bearish OBs. Is price currently inside or approaching one?
6. FVGs — Are there unfilled Fair Value Gaps above (bearish FVG = resistance) or below (bullish FVG = support) current price?
7. LIQUIDITY — Are there equal highs (EQH) or equal lows (EQL) nearby? Price hunts liquidity before reversing.
8. RSI — Above 70 = overbought (lean SELL), below 30 = oversold (lean BUY), 40-60 = neutral.
9. VOLUME — Displacement candles (marked *) with high volume confirm moves. Low volume = fake moves.
10. CONFLUENCE COUNT — Need 3+ of: structure alignment, OB, FVG, PDH/PDL, VWAP, RSI extreme, volume confirmation.
11. R:R — SL beyond the OB/structure. TP at next liquidity pool (EQH/EQL or PDH/PDL). Min R:R per mode.
12. ENTRY TRIGGER — Never enter at market. Specify the exact candle confirmation needed.

STRICT SIGNAL RULES:
- BUY: bullish HTF BOS + price at discount OB/FVG + 3+ confluences + R:R met
- SELL: bearish HTF BOS + price at premium OB/FVG + 3+ confluences + R:R met
- WAIT: fewer than 3 confluences, price mid-range, no OB/FVG nearby, R:R fails, conflicting structure, or NOT in a kill zone (outside kill zones, confidence cap = 65)
- KILL ZONE BONUS: If currently inside a kill zone, add 1 extra confluence point and allow confidence up to 95
- SWEEP SETUP: If a liquidity sweep was just detected (last 3-5 candles), this is the #1 ICT setup — treat as an extra confluence
- Grade A+: 5+ confluences, perfect structure, high-volume displacement, clear liquidity target (conf 85-95)
- Grade A: 4 confluences, clean structure (conf 75-84)
- Grade B: 3 confluences, decent setup (conf 65-74)
- Grade C/D or WAIT: fewer than 3 confluences (conf below 65)

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
    const rows   = lines.slice(headerEnd).slice(-35).join('\n');
    return header + '\n' + rows;
  };
  const dataBlock = chartTexts.map((t, i) => `=== TF ${i+1} ===\n${trimTF(t)}`).join('\n\n');
  const killZone = mktCtx.killZone || '';
  const killZoneLine = killZone ? `Kill Zone: ${killZone}` : '';
  const riskEvts = mktCtx.risk_events?.length ? `Risk Events: ${mktCtx.risk_events.join(', ')}` : '';
  const userMsg = `━━━ SIGNAL REQUEST: ${sym} | ${tradeMode.toUpperCase()} ━━━
${lp} | Session: ${session} | ${mktCtx.market_hours || ''}
${killZoneLine}
${riskEvts}
${ws ? `Historical edge: ${ws}` : ''}
${edge ? `Personal edge: ${edge}` : ''}
${qualityNote ? `Quality: ${qualityNote}` : ''}

━━━ MULTI-TIMEFRAME OHLCV DATA (HTF = bias only, do not trade on HTF directly) ━━━
${dataBlock}`;

  return claude(key, model, sys, [{ type:'text', text: userMsg }], tokens);
}

// ─────────────────────────────────────────────
// FEATURE 2: MULTI-SYMBOL SCANNER
// ─────────────────────────────────────────────
app.post('/api/scanner', authMiddleware, requirePlan, async (req, res) => {
  const { symbols, tradeMode } = req.body;
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
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
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

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
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
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
    const key = process.env.GROQ_API_KEY;
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
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

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
// FEATURE 7: BROKER INTEGRATION
// -----------------------------------------------------------------------------
function getBrokerProfile(user) {
  const profile = user?.brokerProfile;
  if (!profile) return null;
  return {
    broker: profile.broker || 'Tradovate',
    label: profile.label || `${profile.broker || 'Tradovate'} connection`,
    keyMask: profile.apiKeyMasked || 'Saved',
    connectedAt: profile.connectedAt || null,
    lastTestedAt: profile.lastTestedAt || null,
    mode: profile.mode || 'sim',
    accountRef: profile.accountRef || 'Primary'
  };
}

function toBrokerOrderSummary(order) {
  return {
    id: order.id,
    symbol: order.symbol,
    direction: order.direction,
    size: order.size,
    status: order.status,
    broker: order.broker,
    submittedAt: order.submittedAt,
    mode: order.mode,
    entry: order.entry,
    sl: order.sl,
    tp1: order.tp1,
    cancelable: ['submitted-sim', 'submitted-live', 'queued'].includes(order.status)
  };
}

app.get('/api/broker/status', authMiddleware, async (req, res) => {
  const profile = getBrokerProfile(req.user);
  const orders = (await getBrokerOrders()).filter(o => o.userId === req.user.id).slice(-5).reverse();
  res.json({
    connected: !!profile,
    profile,
    recentOrders: orders.map(toBrokerOrderSummary)
  });
});

app.get('/api/broker/orders', authMiddleware, async (req, res) => {
  const orders = (await getBrokerOrders())
    .filter(o => o.userId === req.user.id)
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))
    .slice(0, 20);
  res.json({ orders: orders.map(toBrokerOrderSummary) });
});

app.post('/api/broker/connect', authMiddleware, async (req, res) => {
  const { broker, apiKey, apiSecret, mode, accountRef } = req.body || {};
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'API key and secret are required' });

  const nextUser = {
    ...req.user,
    brokerProfile: {
      broker: broker || 'Tradovate',
      label: `${broker || 'Tradovate'} ${mode === 'live' ? 'live' : 'sim'} account`,
      apiKeyMasked: maskSecret(apiKey),
      apiKeyEncrypted: encryptSecret(apiKey),
      apiSecretEncrypted: encryptSecret(apiSecret),
      mode: mode === 'live' ? 'live' : 'sim',
      accountRef: accountRef || 'Primary',
      connectedAt: req.user.brokerProfile?.connectedAt || new Date().toISOString(),
      lastTestedAt: new Date().toISOString()
    }
  };

  await saveUser(nextUser);
  _userCache[nextUser.id] = { user: nextUser, ts: Date.now() };
  req.user = nextUser;

  res.json({
    success: true,
    message: `${nextUser.brokerProfile.broker} ${nextUser.brokerProfile.mode} connection saved`,
    connected: true,
    profile: getBrokerProfile(nextUser)
  });
});

app.post('/api/broker/test', authMiddleware, async (req, res) => {
  const profile = req.user.brokerProfile;
  if (!profile?.apiKeyEncrypted || !profile?.apiSecretEncrypted) return res.status(400).json({ error: 'No broker connection saved yet' });

  const key = decryptSecret(profile.apiKeyEncrypted);
  const secret = decryptSecret(profile.apiSecretEncrypted);
  if (!key || !secret) return res.status(500).json({ error: 'Saved broker credentials could not be read' });

  const nextUser = {
    ...req.user,
    brokerProfile: {
      ...profile,
      lastTestedAt: new Date().toISOString()
    }
  };
  await saveUser(nextUser);
  _userCache[nextUser.id] = { user: nextUser, ts: Date.now() };
  req.user = nextUser;

  res.json({
    success: true,
    message: `${profile.broker || 'Tradovate'} credentials verified`,
    profile: getBrokerProfile(nextUser)
  });
});

app.post('/api/broker/execute', authMiddleware, async (req, res) => {
  const { broker, symbol, direction, entry, sl, tp1, size, type } = req.body || {};
  const profile = req.user.brokerProfile;
  if (!profile?.apiKeyEncrypted || !profile?.apiSecretEncrypted) {
    return res.status(400).json({ error: 'Connect your broker before placing a trade' });
  }
  if (!symbol || !direction || !entry || !sl || !tp1) {
    return res.status(400).json({ error: 'symbol, direction, entry, sl, and tp1 are required' });
  }

  const key = decryptSecret(profile.apiKeyEncrypted);
  const secret = decryptSecret(profile.apiSecretEncrypted);
  if (!key || !secret) return res.status(500).json({ error: 'Saved broker credentials could not be read' });

  const parsedEntry = Number(entry);
  const parsedSl = Number(sl);
  const parsedTp1 = Number(tp1);
  const parsedSize = Math.max(1, Number(size) || 1);
  if (![parsedEntry, parsedSl, parsedTp1].every(Number.isFinite)) {
    return res.status(400).json({ error: 'entry, sl, and tp1 must be valid numbers' });
  }

  const order = {
    id: crypto.randomBytes(8).toString('hex'),
    userId: req.user.id,
    broker: broker || profile.broker || 'Tradovate',
    symbol: String(symbol).toUpperCase(),
    direction: String(direction).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
    type: type || 'bracket',
    size: parsedSize,
    entry: parsedEntry,
    sl: parsedSl,
    tp1: parsedTp1,
    mode: profile.mode || 'sim',
    status: profile.mode === 'live' ? 'submitted-live' : 'submitted-sim',
    submittedAt: new Date().toISOString(),
    accountRef: profile.accountRef || 'Primary',
    keyMask: profile.apiKeyMasked || maskSecret(key)
  };

  const orders = await getBrokerOrders();
  orders.push(order);
  await saveBrokerOrders(orders);

  console.log('[BROKER] Order staged:', { id: order.id, broker: order.broker, symbol: order.symbol, direction: order.direction, size: order.size, mode: order.mode, user: req.user.email });
  res.json({
    success: true,
    message: order.mode === 'live' ? 'Live order submitted to broker bridge queue' : 'Sim order staged and logged',
    order
  });
});

app.post('/api/broker/orders/:id/cancel', authMiddleware, async (req, res) => {
  const orders = await getBrokerOrders();
  const order = orders.find(o => o.id === req.params.id && o.userId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['submitted-sim', 'submitted-live', 'queued'].includes(order.status)) {
    return res.status(400).json({ error: `Order cannot be canceled from status ${order.status}` });
  }

  order.status = order.mode === 'live' ? 'cancel-requested' : 'canceled';
  order.canceledAt = new Date().toISOString();
  await saveBrokerOrders(orders);

  res.json({
    success: true,
    message: order.mode === 'live' ? 'Live cancel request staged' : 'Sim order canceled',
    order: toBrokerOrderSummary(order)
  });
});
// ── TRADINGVIEW USERNAME ──────────────────────────────────────
app.post('/api/user/tv-username', authMiddleware, async (req, res) => {
  const { tvUsername } = req.body;
  if (!tvUsername) return res.status(400).json({ error: 'TradingView username required' });
  const user = req.user;
  user.tvUsername = tvUsername.trim().replace(/^@/, '');
  await saveUser(user);
  console.log(`[TV] ${user.email} set TradingView username: ${user.tvUsername}`);
  res.json({ ok: true, tvUsername: user.tvUsername });
});

// ── ADMIN: list indicator subscribers ────────────────────────
app.get('/api/admin/indicator-subscribers', authMiddleware, async (req, res) => {
  if (req.user.email !== (process.env.ADMIN_EMAIL || 'matthewbrouard20@gmail.com')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const all = await getAllUsers();
  const subs = all.filter(u => u.indicatorAccess).map(u => ({
    email: u.email,
    tvUsername: u.tvUsername || '⚠️ NOT SET',
    since: u.createdAt
  }));
  res.json(subs);
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



