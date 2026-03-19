require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// PASS 1 — RAW CHART READING
// Reads the chart like a fresh set of eyes.
// No bias. Just facts.
// ─────────────────────────────────────────────
async function pass1_readChart(imageBase64, imageMime, symbol, timeframe, apiKey) {
  const system = `You are a pure chart reader with zero bias. Your only job is to read exactly what is on the chart — nothing more. You do NOT give trade recommendations in this step. You only report what you see as hard facts.

Report ONLY raw JSON. No markdown, no code fences.

{
  "timeframe_detected": "<what timeframe you think this is>",
  "asset_type": "Crypto" or "Forex" or "Stock" or "Index" or "Commodity",
  "price_range": {"high": "<highest price visible>", "low": "<lowest price visible>", "current": "<current/last price>"},
  "trend_direction": "Uptrend" or "Downtrend" or "Sideways",
  "trend_strength": "Strong" or "Moderate" or "Weak",
  "structure": {
    "pattern": "HH+HL" or "LH+LL" or "Mixed" or "Ranging",
    "last_swing_high": "<price>",
    "last_swing_low": "<price>",
    "bos_recent": "<describe any recent break of structure>",
    "choch_recent": "<describe any change of character>"
  },
  "key_levels": [
    {"level": "<price>", "type": "Resistance" or "Support", "strength": "Strong" or "Weak", "reason": "<why this level matters>"},
    {"level": "<price>", "type": "Resistance" or "Support", "strength": "Strong" or "Weak", "reason": "<why>"},
    {"level": "<price>", "type": "Resistance" or "Support", "strength": "Strong" or "Weak", "reason": "<why>"},
    {"level": "<price>", "type": "Resistance" or "Support", "strength": "Strong" or "Weak", "reason": "<why>"}
  ],
  "candles": {
    "last_5_description": "<describe the last 5 candles — size, color, wicks, what they show>",
    "notable_candles": "<any pinbars, engulfing, doji, marubozu, inside bars visible>",
    "momentum": "Bullish" or "Bearish" or "Neutral"
  },
  "volume": {
    "visible": true or false,
    "trend": "Increasing" or "Decreasing" or "Flat" or "Not visible",
    "last_bar": "High" or "Low" or "Average" or "Not visible",
    "notes": "<any volume spikes, climax, dry-up>"
  },
  "indicators_visible": {
    "ema_sma": "<describe any moving averages — how many, alignment, price relative to them>",
    "rsi": "<RSI value if visible, direction, any divergence>",
    "macd": "<MACD state if visible — bullish/bearish, crossover, histogram>",
    "bollinger": "<BB state if visible — expansion, contraction, price position>",
    "other": "<any other indicators and their readings>"
  },
  "patterns_visible": [
    {"name": "<pattern name>", "location": "<where on chart>", "type": "bull" or "bear" or "neutral"}
  ],
  "smart_money": {
    "order_blocks": "<any visible OBs — location, type, tested or untested>",
    "fvg": "<any fair value gaps — location, filled or unfilled>",
    "liquidity": "<equal highs/lows, previous day high/low, obvious stop clusters>",
    "sweeps": "<any recent liquidity sweeps visible>"
  },
  "price_position": "Premium" or "Discount" or "Equilibrium",
  "range_high": "<top of current range>",
  "range_low": "<bottom of current range>",
  "range_midpoint": "<50% of current range>",
  "observations": "<3-5 key objective observations about this chart — no trade bias, just facts>"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } },
        { type: 'text', text: `Read this ${timeframe || '1H'} chart for ${symbol || 'unknown asset'}. Report only facts — no trade recommendation yet. What do you see exactly?` }
      ]}]
    })
  });

  if (!response.ok) {
    const e = await response.json().catch(() => ({}));
    throw new Error(e.error?.message || `Pass 1 API error ${response.status}`);
  }

  const data = await response.json();
  const raw  = (data.content || []).map(c => c.text || '').join('').trim();
  return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim());
}

// ─────────────────────────────────────────────
// PASS 2 — DEVIL'S ADVOCATE
// Tries to DISPROVE the obvious trade.
// Looks for everything that could go wrong.
// ─────────────────────────────────────────────
async function pass2_devilsAdvocate(imageBase64, imageMime, chartReading, symbol, timeframe, apiKey) {
  const system = `You are a professional risk manager and devil's advocate for trading. You have been given a chart reading and your job is to challenge it — find every reason the obvious trade could FAIL.

You are NOT trying to find a trade. You are trying to protect capital by finding all the risks, weaknesses, and reasons NOT to take the obvious setup.

Think like a short seller challenging a bull case, or a bull challenging a bear case.

Return ONLY raw JSON. No markdown, no code fences.

{
  "obvious_trade": "<what the obvious trade direction is based on the chart reading>",
  "counter_arguments": [
    "<reason 1 the obvious trade could fail — be specific with price levels>",
    "<reason 2>",
    "<reason 3>",
    "<reason 4 if applicable>",
    "<reason 5 if applicable>"
  ],
  "hidden_risks": [
    "<hidden risk 1 — something easy to miss>",
    "<hidden risk 2>",
    "<hidden risk 3>"
  ],
  "weakness_of_setup": "<what is the biggest weakness of the current setup — be brutal>",
  "opposing_scenario": "<describe the full opposing scenario — if the market goes the other way, what does that look like?>",
  "false_signal_risk": "High" or "Medium" or "Low",
  "false_signal_reason": "<why this signal could be a fake-out or trap>",
  "key_levels_against": "<what levels, if reached, would confirm the trade is failing>",
  "verdict_challenge": "Strong Challenge" or "Moderate Challenge" or "Weak Challenge",
  "verdict_challenge_reason": "<overall assessment of how risky this trade is>"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } },
        { type: 'text', text: `Here is what was read from this ${timeframe || '1H'} ${symbol || ''} chart:\n\n${JSON.stringify(chartReading, null, 2)}\n\nNow challenge it. What could go wrong? Why might the obvious trade fail? Be brutally honest.` }
      ]}]
    })
  });

  if (!response.ok) {
    const e = await response.json().catch(() => ({}));
    throw new Error(e.error?.message || `Pass 2 API error ${response.status}`);
  }

  const data = await response.json();
  const raw  = (data.content || []).map(c => c.text || '').join('').trim();
  return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim());
}

// ─────────────────────────────────────────────
// PASS 3 — FINAL VERDICT
// Has both the bullish and bearish case.
// Makes the final high-conviction decision.
// ─────────────────────────────────────────────
async function pass3_finalVerdict(imageBase64, imageMime, chartReading, riskAssessment, symbol, timeframe, apiKey) {
  const system = `You are the head of a top-tier proprietary trading desk. You have received a detailed chart analysis AND a devil's advocate risk assessment. Your job is to make the final, highest-quality trading decision.

You have seen both sides — the bull case and the bear case. Now you must decide: is this worth trading, and if so, exactly how?

GOLDEN RULES for your final verdict:
1. If the devil's advocate raised 3+ strong counter-arguments, confidence must be below 65
2. If false signal risk is "High", you must either say WAIT or reduce confidence significantly
3. Only signal BUY/SELL if there are at least 3 strong confluences AND minimum 1:2 R:R
4. The stop loss must be at a LOGICAL structural level — never arbitrary
5. Be honest about grade — A+ is rare, reserved for textbook perfect setups only

Return ONLY raw JSON. No markdown, no code fences.

{
  "verdict": "BUY" or "SELL" or "HOLD" or "WAIT",
  "confidence": <integer 40-95>,
  "signal_grade": "A+" or "A" or "B" or "C" or "D",
  "market_phase": "Accumulation" or "Markup" or "Distribution" or "Markdown" or "Consolidation",
  "price_position": "Premium" or "Discount" or "Equilibrium",
  "bull_case_strength": "Strong" or "Moderate" or "Weak",
  "bear_case_strength": "Strong" or "Moderate" or "Weak",
  "winning_case": "Bull" or "Bear" or "Neither",
  "summary": "<6-7 sentences: (1) overall market structure and phase, (2) price position in range, (3) the specific high-probability setup, (4) why the bull/bear case wins over the other, (5) exact entry and confirmation needed, (6) trade plan, (7) the #1 thing that kills this trade>",
  "entry": "<exact price or precise entry condition>",
  "entry_trigger": "<specific confirmation before entering>",
  "sl": "<exact stop loss price>",
  "sl_reason": "<structural reason>",
  "tp1": "<first target>",
  "tp1_reason": "<why>",
  "tp2": "<second target>",
  "tp2_reason": "<why>",
  "tp3": "<third target — full move>",
  "rr_tp1": "<R:R to TP1>",
  "rr_tp2": "<R:R to TP2>",
  "rrLabel": "Poor" or "Acceptable" or "Good" or "Excellent",
  "position_size": "<max risk % recommendation>",
  "market_bias": "Strongly Bullish" or "Bullish" or "Neutral" or "Bearish" or "Strongly Bearish",
  "confluences": ["<confluence 1>","<confluence 2>","<confluence 3>","<confluence 4>","<confluence 5>"],
  "key_levels": {
    "major_resistance": "<price>",
    "minor_resistance": "<price>",
    "major_support": "<price>",
    "minor_support": "<price>",
    "equilibrium": "<50% of range>"
  },
  "smart_money": {
    "order_blocks": "<OBs and prices>",
    "fvg": "<fair value gaps>",
    "liquidity_pools": "<where stops rest>",
    "recent_sweep": "<recent sweep if any>",
    "bos_choch": "<most recent BOS/CHOCH>",
    "displacement": "<institutional moves>"
  },
  "factors": [
    {"name":"Trend","score":<0-100>,"note":"<specific observation>"},
    {"name":"Volume","score":<0-100>,"note":"<volume analysis>"},
    {"name":"Momentum","score":<0-100>,"note":"<RSI MACD divergence>"},
    {"name":"Structure","score":<0-100>,"note":"<HH/HL or LH/LL BOS CHOCH>"},
    {"name":"Price Action","score":<0-100>,"note":"<candles patterns wicks>"},
    {"name":"Confluence","score":<0-100>,"note":"<count of aligned factors>"},
    {"name":"Risk/Reward","score":<0-100>,"note":"<R:R quality>"}
  ],
  "patterns": [{"name":"<pattern>","type":"bull" or "bear" or "neutral","reliability":"Low" or "Medium" or "High","significance":"<why it matters>"}],
  "indicators": {
    "ema": "<EMA alignment>",
    "rsi": "<RSI value and divergence>",
    "macd": "<MACD state>",
    "volume": "<volume bars>",
    "other": "<other indicators>"
  },
  "risks_acknowledged": ["<risk from devil's advocate 1>","<risk 2>","<risk 3>"],
  "why_trade_wins": "<specific reasons the bull/bear case is stronger than the opposing case>",
  "invalidation": {
    "immediate": "<price that immediately kills trade>",
    "warning": "<warning level>",
    "scenario": "<price action to exit immediately>"
  },
  "trade_management": "<how to manage — stop to BE, partial profits>",
  "candle_analysis": "<last 5 significant candles story>",
  "best_case": "<best case path>",
  "worst_case": "<worst case path>",
  "fullAnalysis": "<10-12 sentences of elite institutional HTML with <strong> tags. Read like a professional trade report. Cover: complete market structure, all key levels, full SMC/ICT setup with every confluence, why bull/bear case wins, exact entry/SL/TP with reasoning, risks acknowledged and why trade still valid, risk management rules, full trade thesis>"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } },
        { type: 'text', text: `Make the final trading decision for this ${timeframe || '1H'} ${symbol || ''} chart.

CHART READING (Pass 1):
${JSON.stringify(chartReading, null, 2)}

DEVIL'S ADVOCATE RISK ASSESSMENT (Pass 2):
${JSON.stringify(riskAssessment, null, 2)}

You have both sides. Now make the highest-quality final decision. Be objective — let the evidence decide. If the risks outweigh the setup, say WAIT. If the setup is strong enough to overcome the risks, give the signal with full detail.` }
      ]}]
    })
  });

  if (!response.ok) {
    const e = await response.json().catch(() => ({}));
    throw new Error(e.error?.message || `Pass 3 API error ${response.status}`);
  }

  const data = await response.json();
  const raw  = (data.content || []).map(c => c.text || '').join('').trim();
  return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim());
}

// ─────────────────────────────────────────────
// MAIN ENDPOINT
// ─────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { imageBase64, imageMime, symbol, timeframe } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    console.log(`[NexTrade] Starting 3-pass analysis for ${symbol || 'unknown'} ${timeframe || '1H'}...`);

    // PASS 1 — Read the chart
    console.log('[NexTrade] Pass 1: Reading chart...');
    const chartReading = await pass1_readChart(imageBase64, imageMime, symbol, timeframe, apiKey);

    // PASS 2 — Devil's advocate
    console.log('[NexTrade] Pass 2: Devil\'s advocate...');
    const riskAssessment = await pass2_devilsAdvocate(imageBase64, imageMime, chartReading, symbol, timeframe, apiKey);

    // PASS 3 — Final verdict
    console.log('[NexTrade] Pass 3: Final verdict...');
    const finalResult = await pass3_finalVerdict(imageBase64, imageMime, chartReading, riskAssessment, symbol, timeframe, apiKey);

    // Attach metadata
    finalResult._passes = {
      chart_reading: chartReading,
      risk_assessment: riskAssessment
    };

    console.log(`[NexTrade] Complete. Verdict: ${finalResult.verdict} | Grade: ${finalResult.signal_grade} | Confidence: ${finalResult.confidence}%`);
    res.json(finalResult);

  } catch (err) {
    console.error('[NexTrade] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n  NexTrade AI (3-pass engine) running at http://localhost:${PORT}\n`));
