require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const fs       = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-opus-4-5';
const DB_FILE = path.join(__dirname, 'trades.json');

// ─────────────────────────────────────────────
// TRADE DATABASE (win/loss tracker)
// ─────────────────────────────────────────────
function loadTrades() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}
function saveTrades(trades) {
  fs.writeFileSync(DB_FILE, JSON.stringify(trades, null, 2));
}
function getWinStats() {
  const trades = loadTrades().filter(t => t.outcome);
  if (!trades.length) return null;
  const wins   = trades.filter(t => t.outcome === 'win').length;
  const losses = trades.filter(t => t.outcome === 'loss').length;
  const avgRR  = trades.filter(t=>t.actual_rr).reduce((s,t)=>s+t.actual_rr,0) / trades.filter(t=>t.actual_rr).length || 0;
  const byGrade = {};
  trades.forEach(t => {
    if (!byGrade[t.grade]) byGrade[t.grade] = { wins:0, losses:0 };
    byGrade[t.grade][t.outcome === 'win' ? 'wins' : 'losses']++;
  });
  return { total: trades.length, wins, losses, winRate: Math.round(wins/trades.length*100), avgRR: avgRR.toFixed(2), byGrade };
}

// ─────────────────────────────────────────────
// LIVE PRICE FETCHER
// ─────────────────────────────────────────────
async function fetchLivePrice(symbol) {
  if (!symbol || symbol === 'Unknown') return null;
  const sym = symbol.toUpperCase().replace('/','-').replace(' ','');
  const sources = [
    // Crypto via CoinGecko
    async () => {
      const coinMap = { 'BTC':'bitcoin','ETH':'ethereum','SOL':'solana','BNB':'binancecoin','XRP':'ripple','ADA':'cardano','DOGE':'dogecoin','AVAX':'avalanche-2','MATIC':'matic-network','DOT':'polkadot','LINK':'chainlink','UNI':'uniswap','ATOM':'cosmos','LTC':'litecoin' };
      const base = sym.replace('USDT','').replace('USD','').replace('BUSD','');
      const coinId = coinMap[base];
      if (!coinId) return null;
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`, { timeout: 5000 });
      const d = await r.json();
      if (!d[coinId]) return null;
      return { price: d[coinId].usd, change24h: d[coinId].usd_24h_change?.toFixed(2), volume24h: d[coinId].usd_24h_vol?.toFixed(0), source: 'CoinGecko' };
    },
    // Forex/Stocks via exchangerate
    async () => {
      const fxPairs = { 'EURUSD':'EUR','GBPUSD':'GBP','USDJPY':'USD','AUDUSD':'AUD','USDCAD':'USD','NZDUSD':'NZD' };
      const pair = sym.replace('-','').replace('/','');
      if (!fxPairs[pair]) return null;
      const base = pair.substring(0,3);
      const quote = pair.substring(3,6);
      const r = await fetch(`https://open.er-api.com/v6/latest/${base}`, { timeout: 5000 });
      const d = await r.json();
      if (!d.rates?.[quote]) return null;
      return { price: d.rates[quote].toFixed(5), change24h: null, volume24h: null, source: 'ExchangeRate-API' };
    }
  ];
  for (const src of sources) {
    try { const result = await src(); if (result) return result; }
    catch { continue; }
  }
  return null;
}

// ─────────────────────────────────────────────
// NEWS / ECONOMIC CALENDAR FETCHER
// ─────────────────────────────────────────────
async function fetchMarketContext(symbol) {
  const context = { news: [], session: '', risk_events: [], market_hours: '' };

  // Determine current trading session
  const hour = new Date().getUTCHours();
  if (hour >= 22 || hour < 8)  context.session = 'Asia Session (22:00-08:00 UTC) — Lower liquidity, JPY pairs most active';
  else if (hour >= 8 && hour < 12)  context.session = 'London Session Open (08:00-12:00 UTC) — High liquidity, EUR/GBP pairs most active, major moves start here';
  else if (hour >= 12 && hour < 17) context.session = 'London/NY Overlap (12:00-17:00 UTC) — HIGHEST liquidity of the day, all pairs active, best time to trade';
  else if (hour >= 17 && hour < 20) context.session = 'New York Session (17:00-20:00 UTC) — Good liquidity, USD pairs active';
  else context.session = 'End of NY / Pre-Asia (20:00-22:00 UTC) — Low liquidity, avoid new positions';

  // Day of week context
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const dayNum = new Date().getDay();
  if (dayNum === 1) context.market_hours = 'Monday — Markets reopening, watch for weekend gaps, lower volume early';
  else if (dayNum === 5) context.market_hours = 'Friday — End of week, positions being closed, avoid holding over weekend';
  else if (dayNum === 0 || dayNum === 6) context.market_hours = 'Weekend — Markets closed (crypto still open but lower institutional volume)';
  else context.market_hours = `${day} — Mid-week, optimal trading conditions`;

  // Crypto-specific context
  const sym = (symbol||'').toUpperCase();
  if (sym.includes('BTC') || sym.includes('ETH') || sym.includes('SOL')) {
    context.risk_events.push('Crypto: 24/7 market — watch for weekend low-liquidity moves and Monday opens');
    context.risk_events.push('Crypto: Major moves often happen during NY session overlap with London (12:00-17:00 UTC)');
  }

  // Forex context
  if (sym.includes('USD')) context.risk_events.push('USD pairs: Watch for US economic data releases (NFP first Friday of month, CPI mid-month, FOMC every 6 weeks)');
  if (sym.includes('EUR') || sym.includes('GBP')) context.risk_events.push('EUR/GBP: ECB/BOE meetings can cause sharp moves — check economic calendar before trading');
  if (sym.includes('JPY')) context.risk_events.push('JPY: BOJ interventions have been frequent — beware of sudden sharp reversals');

  return context;
}

// ─────────────────────────────────────────────
// CLAUDE API HELPER
// ─────────────────────────────────────────────
async function claude(apiKey, system, content, tokens = 2000) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: tokens, system, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
  const d = await r.json();
  const raw = (d.content||[]).map(c=>c.text||'').join('').trim();
  try { return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim()); }
  catch { const m = raw.match(/\{[\s\S]*\}/); if(m) return JSON.parse(m[0]); throw new Error('JSON parse failed'); }
}

function imgContent(b64, mime) {
  return { type: 'image', source: { type: 'base64', media_type: mime||'image/png', data: b64 } };
}

// ─────────────────────────────────────────────
// PASS 1 — MULTI-TIMEFRAME CHART READER
// Reads ALL uploaded charts simultaneously
// ─────────────────────────────────────────────
async function pass1_multiTFReading(charts, sym, key) {
  const chartCount = charts.length;
  const hasMTF = chartCount > 1;

  const sys = `You are an elite multi-timeframe chart analyst. You are being given ${chartCount} chart screenshot${chartCount > 1 ? 's' : ''} of the same asset on different timeframes.

${hasMTF ? `THE GOLDEN RULE OF MULTI-TIMEFRAME ANALYSIS:
- HIGHEST timeframe = THE LAW. Trade only in its direction.
- MIDDLE timeframe = confirmation. Must agree with HTF before signaling.
- LOWEST timeframe = entry. Use for precise entry timing only.
- If HTF and MTF conflict → WAIT. Never fight the higher timeframe.

Analyze each chart and extract the structure, trend, and key levels from each timeframe.` : `Analyze this single chart and extract all timeframe information you can infer.`}

Return ONLY raw JSON.

{
  "charts_analyzed": ${chartCount},
  "timeframes": [
    ${charts.map((_,i) => `{"chart_index": ${i+1}, "detected_tf": "<timeframe>", "trend": "Bullish/Bearish/Sideways", "structure": "HH+HL/LH+LL/Ranging", "key_support": "<price>", "key_resistance": "<price>", "price_position": "Premium/Discount/Equilibrium", "bias": "Bullish/Bearish/Neutral", "phase": "<Accumulation/Markup/Distribution/Markdown/Consolidation>", "notes": "<key observations>"}`).join(',\n    ')}
  ],
  "htf_bias": "${hasMTF ? 'Bullish/Bearish/Neutral — from highest timeframe chart' : 'Bullish/Bearish/Neutral — inferred from overall chart structure'}",
  "htf_key_support": "<most important support from highest TF>",
  "htf_key_resistance": "<most important resistance from highest TF>",
  "mtf_alignment": "Perfect Bull/Perfect Bear/Partial Bull/Partial Bear/Mixed/No Alignment",
  "alignment_score": <0-100>,
  "tradeable_direction": "Long/Short/Wait",
  "current_price": "<approximate current price>",
  "price_position": "Premium/Discount/Equilibrium",
  "range_high": "<top of range>",
  "range_low": "<bottom of range>",
  "range_midpoint": "<50% of range>",
  "structure": {
    "swing_high": "<most recent>",
    "swing_low": "<most recent>",
    "bos": "<recent break of structure>",
    "choch": "<change of character if any>"
  },
  "smart_money": {
    "order_blocks": "<OBs visible>",
    "fvg": "<fair value gaps>",
    "liquidity": "<buy/sell side pools>",
    "sweeps": "<recent sweeps>",
    "institutional_bias": "Bullish/Bearish/Neutral"
  },
  "key_levels": [
    {"price": "<>", "type": "Resistance/Support", "strength": "Major/Minor", "tf_origin": "<which timeframe this comes from>", "reason": "<why important>"}
  ],
  "indicators": {
    "ema": "<alignment across charts>",
    "rsi": "<readings and divergence>",
    "macd": "<state>",
    "volume": "<analysis>",
    "other": "<other>"
  },
  "patterns": [{"name": "<>", "type": "bull/bear/neutral", "timeframe": "<which TF>", "reliability": "Low/Medium/High"}],
  "candles": "<last significant candles story across timeframes>",
  "reading_confidence": <0-100>,
  "summary": "<4-5 sentences covering the multi-timeframe picture and overall bias>"
}`;

  const content = [
    ...charts.map((c,i) => [
      { type: 'text', text: `Chart ${i+1}${charts.length > 1 ? ` (${c.label || 'Timeframe ' + (i+1)})` : ''}:` },
      imgContent(c.base64, c.mime)
    ]).flat(),
    { type: 'text', text: `Analyze ${chartCount > 1 ? 'all ' + chartCount + ' timeframe charts' : 'this chart'} for ${sym}. ${hasMTF ? 'Read each timeframe and determine the multi-timeframe alignment.' : 'Extract all information visible.'}` }
  ];

  return claude(key, sys, content, 2500);
}

// ─────────────────────────────────────────────
// PASS 2 — CONTEXT-AWARE RISK ANALYST
// Uses live price + news + session + win stats
// ─────────────────────────────────────────────
async function pass2_contextAnalyst(charts, sym, reading, livePrice, marketContext, winStats, key) {
  const sys = `You are an elite trading risk analyst with access to real-time market context. Your job is to assess whether NOW is the right time to trade based on session, news risk, live price data, and historical performance.

Combine the chart reading with external context to:
1. Confirm or challenge the chart's signal with live price data
2. Assess news/session risk
3. Review win rate by signal grade to recommend minimum grade
4. Find the optimal entry zone using live price

Return ONLY raw JSON.

{
  "live_price_confirms_chart": true or false,
  "live_price_note": "<does live price match what chart shows? any discrepancy?>",
  "session_quality": "Excellent/Good/Poor/Avoid",
  "session_note": "<should we trade this session or wait?>",
  "news_risk": "High/Medium/Low/None",
  "news_risk_detail": "<any upcoming news or events that could affect this trade?>",
  "day_of_week_risk": "High/Medium/Low",
  "day_of_week_note": "<is today a good day to trade?>",
  "historical_performance": {
    "total_trades_tracked": <number>,
    "overall_win_rate": "<percentage>",
    "best_performing_grade": "<which grade has highest win rate>",
    "recommended_minimum_grade": "<only take A or A+ based on history? or B+ ok?>",
    "avg_rr_achieved": "<average actual R:R achieved>"
  },
  "optimal_entry_time": "<based on session and context, when is the best time to enter?>",
  "context_bias": "Proceed/Proceed with caution/Wait for better session/Avoid today",
  "risk_multiplier": <0.5-1.5 — multiply position size by this based on conditions>,
  "context_summary": "<3-4 sentences on whether external conditions support or hurt this trade>"
}`;

  const liveStr = livePrice ? `Live price data: $${livePrice.price} (24h change: ${livePrice.change24h || 'N/A'}%, Volume: ${livePrice.volume24h || 'N/A'})` : 'Live price data: Not available';
  const statsStr = winStats ? `Win stats: ${winStats.winRate}% win rate over ${winStats.total} tracked trades. By grade: ${JSON.stringify(winStats.byGrade)}` : 'Win stats: No trades tracked yet';

  return claude(key, sys, [
    ...charts.slice(0,1).map(c => imgContent(c.base64, c.mime)),
    { type: 'text', text: `Context analysis for ${sym}:\n\n${liveStr}\n\nMarket session: ${marketContext.session}\nDay context: ${marketContext.market_hours}\nRisk events: ${marketContext.risk_events.join(', ') || 'None identified'}\n\n${statsStr}\n\nChart reading summary: ${reading.summary}\nChart bias: ${reading.htf_bias}\nAlignment score: ${reading.alignment_score}/100\n\nAssess if NOW is the right time to trade this setup.` }
  ], 1500);
}

// ─────────────────────────────────────────────
// PASS 3 — PRECISION ENTRY ARCHITECT
// ─────────────────────────────────────────────
async function pass3_entryArchitect(charts, sym, reading, context, livePrice, key) {
  const sys = `You are a precision entry specialist. You have a clear directional bias and real market context. Find the EXACT best entry.

RULES:
- Entry must be at a KEY LEVEL — OB, FVG, support, resistance — not in the middle of nowhere
- Stop loss at a LOGICAL structural level — just beyond the last swing high/low
- Minimum 1:2 R:R to TP1, 1:3+ to TP2
- Entry in DISCOUNT for longs, PREMIUM for shorts
- Check for obstacles between entry and TP1 — if a major level is in the way, TP1 must be before it
- Use live price to determine if entry is available NOW or needs a pullback

Return ONLY raw JSON.

{
  "entry_available_now": true or false,
  "entry_type": "Limit/Stop/Market/Wait for pullback",
  "entry_price": "<exact price>",
  "entry_zone": "<acceptable range>",
  "entry_trigger": "<exact confirmation needed>",
  "entry_quality": "A+/A/B/C/D",
  "entry_rationale": "<why this is the best entry>",
  "sl_price": "<exact stop>",
  "sl_reason": "<structural reason>",
  "sl_pct_from_entry": "<% from entry to stop>",
  "tp1_price": "<first target>",
  "tp1_reason": "<why>",
  "tp1_rr": "<R:R>",
  "tp2_price": "<second target>",
  "tp2_reason": "<why>",
  "tp2_rr": "<R:R>",
  "tp3_price": "<third target>",
  "tp3_rr": "<R:R>",
  "obstacles_to_tp1": "<any S/R between entry and TP1>",
  "obstacles_to_tp2": "<any S/R between TP1 and TP2>",
  "trade_management": {
    "move_to_be": "<when to move SL to breakeven>",
    "partial_at_tp1": "<% to close at TP1>",
    "trail_after_tp1": "<how to trail>",
    "max_hold_time": "<if trade not working in X hours/candles, exit>"
  },
  "invalidation_before_entry": "<if price does X before entry, cancel the trade>",
  "entry_summary": "<3-4 sentences on the exact step-by-step entry plan>"
}`;

  const livePriceNote = livePrice ? `Current live price: $${livePrice.price}` : 'Live price: Not available';
  return claude(key, sys, [
    ...charts.slice(0,1).map(c => imgContent(c.base64, c.mime)),
    { type: 'text', text: `Find perfect entry for ${reading.tradeable_direction} on ${sym}.\n\n${livePriceNote}\nChart bias: ${reading.htf_bias}\nAlignment: ${reading.alignment_score}/100\nKey levels: ${JSON.stringify(reading.key_levels)}\nSmart money: ${JSON.stringify(reading.smart_money)}\nContext: ${context.context_bias}\nSession: ${context.session_quality}\n\nBe extremely specific with prices.` }
  ], 2000);
}

// ─────────────────────────────────────────────
// PASS 4 — SUPREME COURT FINAL VERDICT
// 9 quality gates + full signal generation
// ─────────────────────────────────────────────
async function pass4_finalVerdict(charts, sym, tf, reading, context, entry, livePrice, marketContext, winStats, key) {
  const sys = `You are the Chief Trading Officer. You have all the data. Apply 9 strict quality gates and make the final decision.

QUALITY GATES — if ANY fail → WAIT:
GATE 1: alignment_score < 60 → WAIT
GATE 2: session_quality is "Poor" or "Avoid" → WAIT  
GATE 3: news_risk is "High" → WAIT (protect capital before news)
GATE 4: day_of_week_risk is "High" → WAIT
GATE 5: entry_quality is "C" or "D" → WAIT
GATE 6: tp1_rr < 1:2 → WAIT
GATE 7: obstacles_to_tp1 contains a MAJOR level → WAIT
GATE 8: price_position is "Premium" for longs → WAIT
GATE 9: price_position is "Discount" for shorts → WAIT

POSITION SIZING:
- Base risk: 1% of account
- If grade A+: 1.5% max
- If grade A: 1% 
- If grade B: 0.75%
- Multiply by context risk_multiplier
- If news risk medium: halve position
- Friday: never risk more than 0.5%

CONFIDENCE FORMULA:
- Start: alignment_score * 0.7 (max 70)
- +8 if institutional bias matches
- +5 if correct premium/discount zone
- +5 if live price confirms entry zone
- +5 if session is Excellent
- +5 if historical win rate > 65%
- -8 if obstacles to TP1
- -10 if trend extended/exhausted
- -5 if context says "caution"
- Hard cap: 92

Return ONLY raw JSON.

{
  "verdict": "BUY" or "SELL" or "WAIT",
  "confidence": <40-92>,
  "signal_grade": "A+/A/B/C/D",
  "gates_passed": ["Gate 1 ✓","Gate 2 ✓","..."],
  "gates_failed": ["Gate X ✗: reason"],
  "wait_reason": "<if WAIT, exactly why>",
  "market_phase": "<phase>",
  "price_position": "Premium/Discount/Equilibrium",
  "market_bias": "Strongly Bullish/Bullish/Neutral/Bearish/Strongly Bearish",
  "session": "<current session and quality>",
  "live_price": "<current price if available>",
  "summary": "<9-10 sentence elite summary covering: institutional context, MTF alignment, price position, the specific setup with all confluences, which gates passed and why, session and news context, exact entry plan, risk management, and full trade thesis>",
  "entry": "<exact price>",
  "entry_trigger": "<exact confirmation>",
  "entry_zone": "<range>",
  "entry_available_now": true or false,
  "sl": "<exact stop>",
  "sl_reason": "<structural reason>",
  "tp1": "<first target>",
  "tp1_reason": "<why>",
  "tp2": "<second target>",
  "tp2_reason": "<why>",
  "tp3": "<third target>",
  "rr_tp1": "<R:R>",
  "rr_tp2": "<R:R>",
  "rrLabel": "Poor/Acceptable/Good/Excellent",
  "position_size": "<% of account to risk>",
  "confluences": ["<top 6-8 strongest confluences>"],
  "key_levels": {
    "major_resistance": "<>", "minor_resistance": "<>",
    "major_support": "<>", "minor_support": "<>",
    "equilibrium": "<>"
  },
  "smart_money": {
    "order_blocks": "<>", "fvg": "<>",
    "liquidity_pools": "<>", "recent_sweep": "<>",
    "bos_choch": "<>", "displacement": "<>",
    "next_institutional_target": "<>"
  },
  "factors": [
    {"name":"Trend","score":<0-100>,"note":"<>"},
    {"name":"Volume","score":<0-100>,"note":"<>"},
    {"name":"Momentum","score":<0-100>,"note":"<>"},
    {"name":"Structure","score":<0-100>,"note":"<>"},
    {"name":"Price Action","score":<0-100>,"note":"<>"},
    {"name":"Confluence","score":<0-100>,"note":"<>"},
    {"name":"Risk/Reward","score":<0-100>,"note":"<>"}
  ],
  "patterns": [{"name":"<>","type":"bull/bear/neutral","reliability":"Low/Medium/High","significance":"<>"}],
  "indicators": {"ema":"<>","rsi":"<>","macd":"<>","volume":"<>","other":"<>"},
  "invalidation": {
    "immediate": "<price that kills trade>",
    "warning": "<warning level>",
    "scenario": "<price action to exit>"
  },
  "trade_management": {
    "move_to_be": "<when>",
    "partial_tp1": "<% at TP1>",
    "trail_method": "<how to trail>",
    "max_hold": "<max time to hold if not moving>"
  },
  "candle_analysis": "<last 5-7 key candles>",
  "best_case": "<ideal path>",
  "worst_case": "<failure path and next opportunity>",
  "news_and_session": "<session quality and any news to watch>",
  "historical_context": "<what the win rate data says about setups like this>",
  "fullAnalysis": "<15-20 sentences of the most professional trade report possible. Use <strong> tags. Cover: (1) Institutional order flow and smart money positioning (2) Multi-timeframe alignment with specific prices from each TF (3) Price position in range and why it matters (4) Every confluence numbered and explained with prices (5) Quality gates — all 9 and their status (6) Session and news context (7) Live price confirmation (8) Exact entry with trigger (9) Stop loss structural reasoning (10) TP1, TP2, TP3 with reasons (11) Position sizing calculation (12) Trade management plan (13) What kills the trade (14) Historical performance context (15) Complete trade thesis and probability>"
}`;

  const liveStr = livePrice ? `Live: $${livePrice.price} (${livePrice.change24h||'?'}% 24h)` : 'Live price: N/A';
  const statsStr = winStats ? `Historical: ${winStats.winRate}% win rate, ${winStats.total} trades` : 'No history yet';

  return claude(key, sys, [
    ...charts.map(c => imgContent(c.base64, c.mime)),
    { type: 'text', text: `Final verdict for ${sym} ${tf}.\n\n${liveStr}\nSession: ${marketContext.session}\n${statsStr}\n\nReading: ${JSON.stringify(reading)}\nContext: ${JSON.stringify(context)}\nEntry: ${JSON.stringify(entry)}\n\nApply all 9 gates strictly.` }
  ], 5000);
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Main analyze endpoint
app.post('/api/analyze', async (req, res) => {
  const { charts, imageBase64, imageMime, symbol, timeframe } = req.body;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // Support both single image (backward compat) and multi-chart
  let chartList = [];
  if (charts && charts.length) {
    chartList = charts;
  } else if (imageBase64) {
    chartList = [{ base64: imageBase64, mime: imageMime||'image/png', label: timeframe||'Chart' }];
  } else {
    return res.status(400).json({ error: 'No image provided' });
  }

  const sym = symbol || 'Unknown';
  const tf  = timeframe || chartList[0]?.label || '1H';

  try {
    console.log(`\n[NexTrade] ═══ ${sym} ${tf} — ${chartList.length} chart(s) ═══`);
    const t0 = Date.now();

    // Fetch external data in parallel
    console.log('[Data] Fetching live price + market context...');
    const [livePrice, marketContext, winStats] = await Promise.all([
      fetchLivePrice(sym).catch(() => null),
      fetchMarketContext(sym),
      Promise.resolve(getWinStats())
    ]);
    console.log(`[Data] ✓ Price: ${livePrice ? '$'+livePrice.price : 'N/A'} | Session: ${marketContext.session.split(' ')[0]+' '+marketContext.session.split(' ')[1]} | Win rate: ${winStats ? winStats.winRate+'%' : 'No data'}`);

    // Pass 1 — Multi-TF reading
    console.log(`[Pass 1] Reading ${chartList.length} chart(s)...`);
    const reading = await pass1_multiTFReading(chartList, sym, key);
    console.log(`[Pass 1] ✓ Bias: ${reading.htf_bias} | Alignment: ${reading.alignment_score}/100 | Direction: ${reading.tradeable_direction}`);

    // Pass 2 — Context analyst
    console.log('[Pass 2] Context analysis...');
    const context = await pass2_contextAnalyst(chartList, sym, reading, livePrice, marketContext, winStats, key);
    console.log(`[Pass 2] ✓ Session: ${context.session_quality} | News: ${context.news_risk} | Verdict: ${context.context_bias}`);

    // Pass 3 — Entry (only if direction clear and context ok)
    let entry = { entry_quality: 'D', tp1_rr: '0', entry_summary: 'Skipped — no clear direction or poor conditions' };
    if (reading.alignment_score >= 50 && context.session_quality !== 'Avoid' && context.news_risk !== 'High') {
      console.log('[Pass 3] Entry architecture...');
      entry = await pass3_entryArchitect(chartList, sym, reading, context, livePrice, key);
      console.log(`[Pass 3] ✓ Entry: ${entry.entry_price} | SL: ${entry.sl_price} | TP1: ${entry.tp1_price} | R:R: ${entry.tp1_rr}`);
    } else {
      console.log('[Pass 3] Skipped — conditions not met');
    }

    // Pass 4 — Final verdict
    console.log('[Pass 4] Final verdict...');
    const result = await pass4_finalVerdict(chartList, sym, tf, reading, context, entry, livePrice, marketContext, winStats, key);
    console.log(`[Pass 4] ✓ VERDICT: ${result.verdict} | Grade: ${result.signal_grade} | Confidence: ${result.confidence}%`);

    const elapsed = ((Date.now()-t0)/1000).toFixed(1);
    console.log(`[NexTrade] ═══ Complete in ${elapsed}s ═══\n`);

    // Auto-save signal to trade log
    if (result.verdict === 'BUY' || result.verdict === 'SELL') {
      const trades = loadTrades();
      const tradeId = Date.now().toString();
      trades.push({
        id: tradeId,
        symbol: sym,
        timeframe: tf,
        verdict: result.verdict,
        grade: result.signal_grade,
        confidence: result.confidence,
        entry: result.entry,
        sl: result.sl,
        tp1: result.tp1,
        tp2: result.tp2,
        rr_tp1: result.rr_tp1,
        timestamp: new Date().toISOString(),
        outcome: null,
        actual_rr: null,
        notes: ''
      });
      saveTrades(trades);
      result._trade_id = tradeId;
    }

    result._meta = {
      analysis_time_seconds: parseFloat(elapsed),
      charts_analyzed: chartList.length,
      live_price: livePrice,
      market_context: marketContext,
      win_stats: winStats
    };

    res.json(result);

  } catch (err) {
    console.error('[NexTrade] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

// Win/loss tracker routes
app.get('/api/trades', (req, res) => res.json(loadTrades()));
app.get('/api/stats', (req, res) => res.json(getWinStats() || { message: 'No completed trades yet' }));

app.post('/api/trades/:id/outcome', (req, res) => {
  const { outcome, actual_rr, notes } = req.body;
  const trades = loadTrades();
  const trade  = trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  trade.outcome   = outcome;   // 'win' or 'loss'
  trade.actual_rr = actual_rr; // actual R:R achieved
  trade.notes     = notes || '';
  trade.closed_at = new Date().toISOString();
  saveTrades(trades);
  console.log(`[Tracker] Trade ${req.params.id} updated: ${outcome} | R:R: ${actual_rr}`);
  res.json({ success: true, stats: getWinStats() });
});

app.delete('/api/trades/:id', (req, res) => {
  let trades = loadTrades();
  trades = trades.filter(t => t.id !== req.params.id);
  saveTrades(trades);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ╔════════════════════════════════════════╗`);
  console.log(`  ║   NexTrade AI — Ultimate Engine        ║`);
  console.log(`  ║   Multi-TF + Live Data + News + Tracker║`);
  console.log(`  ║   http://localhost:${PORT}                ║`);
  console.log(`  ╚════════════════════════════════════════╝\n`);
});
