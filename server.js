require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-5';

async function callClaude(apiKey, system, userContent, maxTokens = 2000) {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] })
  });
  if (!response.ok) {
    const e = await response.json().catch(() => ({}));
    throw new Error(e.error?.message || `API error ${response.status}`);
  }
  const data = await response.json();
  const raw = (data.content || []).map(c => c.text || '').join('').trim();
  try {
    return JSON.parse(raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim());
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Could not parse AI response as JSON');
  }
}

// ═══════════════════════════════════════════════
// PASS 1 — PURE OBJECTIVE CHART READING
// No bias. Facts only. What is literally on the chart.
// ═══════════════════════════════════════════════
async function pass1_objectiveReading(img, mime, symbol, tf, apiKey) {
  const system = `You are a pure data extraction system. You read charts like a machine — only facts, zero opinions, zero trade bias. Your job is to extract every piece of objective information from this chart.

Return ONLY raw JSON starting with { and ending with }. No markdown.

{
  "timeframe": "<detected timeframe>",
  "asset_type": "Crypto" or "Forex" or "Stock" or "Index" or "Commodity",
  "current_price": "<last visible price>",
  "price_range": {"high": "<highest>", "low": "<lowest>"},
  "trend": {"direction": "Up" or "Down" or "Sideways", "strength": "Strong" or "Moderate" or "Weak", "duration": "<how long trending>"},
  "structure": {"type": "HH+HL" or "LH+LL" or "Ranging", "last_hh": "<price>", "last_hl": "<price>", "last_lh": "<price>", "last_ll": "<price>", "recent_bos": "<describe>", "recent_choch": "<describe>"},
  "key_levels": [
    {"price": "<level>", "type": "Resistance" or "Support", "strength": "Major" or "Minor", "touches": "<how many times tested>", "notes": "<why important>"}
  ],
  "price_in_range": "Premium" or "Discount" or "Equilibrium",
  "range_high": "<top>", "range_low": "<bottom>", "range_mid": "<50% level>",
  "candle_data": {"last_candle": "<color, size, wicks description>", "last_5_story": "<what the last 5 candles show>", "notable": "<any key candle patterns>"},
  "volume": {"visible": true or false, "trend": "<increasing/decreasing/flat>", "last_bar": "<high/low/avg>", "anomalies": "<spikes, dry-up, climax>"},
  "indicators": {"moving_averages": "<any MAs visible, alignment, price vs MAs>", "rsi": "<value if visible, direction, divergence>", "macd": "<state if visible>", "other": "<any other indicators>"},
  "smc_elements": {"order_blocks": "<any OBs visible with levels>", "fvg": "<any FVGs with levels>", "liquidity": "<equal highs/lows, obvious stops>", "sweeps": "<any recent sweeps>"},
  "patterns": [{"name": "<pattern>", "type": "bull/bear/neutral", "completion": "<forming/complete>"}],
  "raw_observations": ["<fact 1>","<fact 2>","<fact 3>","<fact 4>","<fact 5>"]
}`;

  return callClaude(apiKey, system, [
    { type: 'image', source: { type: 'base64', media_type: mime, data: img } },
    { type: 'text', text: `Extract all objective data from this ${tf} chart for ${symbol}. Facts only — no trade opinion.` }
  ], 2000);
}

// ═══════════════════════════════════════════════
// PASS 2A — BULL ANALYST
// Only looks for reasons to buy.
// Finds the strongest possible long setup.
// ═══════════════════════════════════════════════
async function pass2a_bullAnalyst(img, mime, reading, symbol, tf, apiKey) {
  const system = `You are a specialist BULL analyst. Your job is to find the strongest possible reason to go LONG on this chart. You believe in buying opportunities. Look for every bullish reason.

But you are also honest — if there is genuinely no bull case, score it low. You are biased toward bulls but not blind.

Return ONLY raw JSON.

{
  "bull_verdict": "Strong Buy" or "Buy" or "Weak Buy" or "No Bull Case",
  "bull_confidence": <0-100>,
  "bull_entry": "<ideal long entry>",
  "bull_sl": "<stop for long>",
  "bull_tp1": "<first target>",
  "bull_tp2": "<second target>",
  "bull_rr": "<R:R to TP1>",
  "bull_confluences": ["<bull reason 1>","<bull reason 2>","<bull reason 3>","<bull reason 4>","<bull reason 5>"],
  "bull_key_level": "<the most important support the bull case relies on>",
  "bull_invalidation": "<price that kills the bull case>",
  "bull_pattern": "<bullish pattern or setup name>",
  "bull_timing": "<is now the right time to buy, or should bulls wait for a better entry?>",
  "bull_score": <0-100 — overall score of how strong the bull case is>,
  "bull_summary": "<3-4 sentences on the full bull case>"
}`;

  return callClaude(apiKey, system, [
    { type: 'image', source: { type: 'base64', media_type: mime, data: img } },
    { type: 'text', text: `Chart data: ${JSON.stringify(reading)}\n\nFind the strongest possible LONG setup on this ${tf} ${symbol} chart. What is the bull case?` }
  ], 1200);
}

// ═══════════════════════════════════════════════
// PASS 2B — BEAR ANALYST
// Only looks for reasons to sell.
// Finds the strongest possible short setup.
// ═══════════════════════════════════════════════
async function pass2b_bearAnalyst(img, mime, reading, symbol, tf, apiKey) {
  const system = `You are a specialist BEAR analyst. Your job is to find the strongest possible reason to go SHORT on this chart. You believe in selling opportunities. Look for every bearish reason.

But you are also honest — if there is genuinely no bear case, score it low.

Return ONLY raw JSON.

{
  "bear_verdict": "Strong Sell" or "Sell" or "Weak Sell" or "No Bear Case",
  "bear_confidence": <0-100>,
  "bear_entry": "<ideal short entry>",
  "bear_sl": "<stop for short>",
  "bear_tp1": "<first target>",
  "bear_tp2": "<second target>",
  "bear_rr": "<R:R to TP1>",
  "bear_confluences": ["<bear reason 1>","<bear reason 2>","<bear reason 3>","<bear reason 4>","<bear reason 5>"],
  "bear_key_level": "<the most important resistance the bear case relies on>",
  "bear_invalidation": "<price that kills the bear case>",
  "bear_pattern": "<bearish pattern or setup name>",
  "bear_timing": "<is now the right time to sell, or should bears wait?>",
  "bear_score": <0-100 — overall score of how strong the bear case is>,
  "bear_summary": "<3-4 sentences on the full bear case>"
}`;

  return callClaude(apiKey, system, [
    { type: 'image', source: { type: 'base64', media_type: mime, data: img } },
    { type: 'text', text: `Chart data: ${JSON.stringify(reading)}\n\nFind the strongest possible SHORT setup on this ${tf} ${symbol} chart. What is the bear case?` }
  ], 1200);
}

// ═══════════════════════════════════════════════
// PASS 3 — RISK MANAGER (Devil's Advocate)
// Reads both bull and bear cases.
// Finds the traps, false signals, and dangers.
// ═══════════════════════════════════════════════
async function pass3_riskManager(img, mime, reading, bullCase, bearCase, symbol, tf, apiKey) {
  const system = `You are the head risk manager at a top prop trading firm. You have been given a chart reading, a bull case, and a bear case. Your ONLY job is to protect capital.

Find every trap, false signal, fake-out, and danger. Challenge both the bull AND bear case. Your goal is to reduce losses, not find trades.

Return ONLY raw JSON.

{
  "overall_risk": "Very High" or "High" or "Medium" or "Low",
  "dominant_case": "Bull" or "Bear" or "Neither — too close to call",
  "case_strength_gap": <0-100 — how much stronger is the dominant case vs the other>,
  "bull_case_flaws": ["<flaw 1>","<flaw 2>","<flaw 3>"],
  "bear_case_flaws": ["<flaw 1>","<flaw 2>","<flaw 3>"],
  "false_signal_risk": "High" or "Medium" or "Low",
  "false_signal_reason": "<specific reason this could be a trap>",
  "chop_risk": "High" or "Medium" or "Low",
  "chop_reason": "<is the market ranging or choppy? Would this signal get chopped out?>",
  "hidden_dangers": ["<danger 1>","<danger 2>","<danger 3>"],
  "liquidity_trap_risk": "Yes" or "No" or "Possible",
  "liquidity_trap_detail": "<is price near a liquidity trap — equal highs/lows being targeted?>",
  "news_risk": "<any obvious news or session risk to consider>",
  "minimum_rr_achievable": "<is the minimum 1:2 R:R actually achievable or is there an obstacle in the way?>",
  "recommendation": "Trade the dominant case" or "Wait for better entry" or "Avoid — too risky" or "Reduce size — high risk",
  "risk_summary": "<3-4 sentences on overall risk assessment>"
}`;

  return callClaude(apiKey, system, [
    { type: 'image', source: { type: 'base64', media_type: mime, data: img } },
    { type: 'text', text: `Chart: ${JSON.stringify(reading)}\nBull case: ${JSON.stringify(bullCase)}\nBear case: ${JSON.stringify(bearCase)}\n\nAssess all risks. What are the dangers? What could go wrong with both cases?` }
  ], 1500);
}

// ═══════════════════════════════════════════════
// PASS 4 — SUPREME COURT (Final Consensus)
// Sees everything. Makes the final call.
// Highest quality signal possible.
// ═══════════════════════════════════════════════
async function pass4_supremeCourt(img, mime, reading, bullCase, bearCase, riskAssessment, symbol, tf, apiKey) {
  const system = `You are the final decision maker — the Chief Trading Officer of the world's most profitable prop firm. You have received:
1. An objective chart reading
2. The strongest possible bull case
3. The strongest possible bear case
4. A full risk assessment

Your job is to make the single highest-quality trading decision possible. You have all the information. You are objective, unemotional, and focused only on probability and risk-adjusted returns.

STRICT RULES:
- Only signal BUY if bull_score > bear_score by at least 20 points AND overall_risk is not "Very High" AND false_signal_risk is not "High" AND R:R >= 1:2
- Only signal SELL if bear_score > bull_score by at least 20 points AND same conditions
- If the case_strength_gap < 20, return WAIT — too close to call
- If overall_risk is "Very High", return WAIT
- If false_signal_risk is "High" AND case_strength_gap < 35, return WAIT
- If minimum_rr_achievable shows an obstacle, return WAIT
- Confidence must reflect ALL risks — never above 85 unless it's a textbook perfect setup
- Signal grade A+ is extremely rare — only for setups where everything perfectly aligns

Return ONLY raw JSON starting with { ending with }.

{
  "verdict": "BUY" or "SELL" or "HOLD" or "WAIT",
  "confidence": <integer 40-92>,
  "signal_grade": "A+" or "A" or "B" or "C" or "D",
  "decision_reason": "<why this verdict — what tipped the scales>",
  "bull_score_final": <0-100>,
  "bear_score_final": <0-100>,
  "score_gap": <bull minus bear score>,
  "market_phase": "Accumulation" or "Markup" or "Distribution" or "Markdown" or "Consolidation",
  "price_position": "Premium" or "Discount" or "Equilibrium",
  "market_bias": "Strongly Bullish" or "Bullish" or "Neutral" or "Bearish" or "Strongly Bearish",
  "summary": "<7-8 sentence elite summary: market structure and phase, price position in range, which case won and why, the specific setup with all confluences, entry plan, risk management, what kills the trade, and the overall thesis>",
  "entry": "<exact price or entry condition>",
  "entry_trigger": "<what must happen before entering>",
  "sl": "<exact stop loss>",
  "sl_reason": "<structural reason>",
  "tp1": "<first target>",
  "tp1_reason": "<why>",
  "tp2": "<second target>",
  "tp2_reason": "<why>",
  "tp3": "<third target>",
  "rr_tp1": "<R:R>",
  "rr_tp2": "<R:R>",
  "rrLabel": "Poor" or "Acceptable" or "Good" or "Excellent",
  "position_size": "<max risk % — be conservative if risk is medium/high>",
  "confluences": ["<top confluence 1>","<top confluence 2>","<top confluence 3>","<top confluence 4>","<top confluence 5>"],
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
    "recent_sweep": "<recent sweep>",
    "bos_choch": "<most recent BOS/CHOCH>",
    "displacement": "<institutional moves>"
  },
  "factors": [
    {"name":"Trend","score":<0-100>,"note":"<specific>"},
    {"name":"Volume","score":<0-100>,"note":"<specific>"},
    {"name":"Momentum","score":<0-100>,"note":"<RSI MACD divergence>"},
    {"name":"Structure","score":<0-100>,"note":"<HH/HL BOS CHOCH>"},
    {"name":"Price Action","score":<0-100>,"note":"<candles patterns>"},
    {"name":"Confluence","score":<0-100>,"note":"<how many align>"},
    {"name":"Risk/Reward","score":<0-100>,"note":"<R:R quality>"}
  ],
  "patterns": [{"name":"<pattern>","type":"bull" or "bear" or "neutral","reliability":"Low" or "Medium" or "High","significance":"<why it matters>"}],
  "indicators": {
    "ema": "<alignment>",
    "rsi": "<value divergence>",
    "macd": "<state>",
    "volume": "<analysis>",
    "other": "<other>"
  },
  "risks_acknowledged": ["<risk 1 from risk manager>","<risk 2>","<risk 3>"],
  "why_still_valid": "<why the trade is worth taking despite the risks>",
  "invalidation": {
    "immediate": "<price that kills trade immediately>",
    "warning": "<warning level>",
    "scenario": "<price action to exit>"
  },
  "trade_management": "<how to manage — when to move SL to BE, partial profits, scaling>",
  "candle_analysis": "<last 5 candles story>",
  "best_case": "<ideal path if trade works>",
  "worst_case": "<path if trade fails>",
  "fullAnalysis": "<12-15 sentences of elite institutional HTML with <strong> tags. This is a full professional trade report. Cover: complete market structure analysis with specific prices, price position in range, full SMC/ICT breakdown, every confluence with specific prices, exact entry/SL/TP with reasons, risks acknowledged and why trade survives them, trade management plan, and the complete trade thesis with confidence assessment>"
}`;

  return callClaude(apiKey, system, [
    { type: 'image', source: { type: 'base64', media_type: mime, data: img } },
    { type: 'text', text: `Make the final trading decision.\n\nChart reading: ${JSON.stringify(reading)}\nBull case (score: ${bullCase.bull_score}): ${JSON.stringify(bullCase)}\nBear case (score: ${bearCase.bear_score}): ${JSON.stringify(bearCase)}\nRisk assessment: ${JSON.stringify(riskAssessment)}\n\nApply all rules strictly. Only signal if the dominant case wins by 20+ points, risk is not Very High, and R:R >= 1:2. Otherwise return WAIT.` }
  ], 4500);
}

// ═══════════════════════════════════════════════
// MAIN ENDPOINT
// ═══════════════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  const { imageBase64, imageMime, symbol, timeframe } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const sym = symbol || 'Unknown';
  const tf  = timeframe || '1H';
  const mime = imageMime || 'image/png';

  try {
    console.log(`\n[NexTrade 4-Pass] Starting analysis: ${sym} ${tf}`);
    const t0 = Date.now();

    // Run Pass 1 first (sequential — others depend on it)
    console.log('[Pass 1] Objective chart reading...');
    const reading = await pass1_objectiveReading(imageBase64, mime, sym, tf, apiKey);
    console.log(`[Pass 1] Done. Trend: ${reading.trend?.direction}, Structure: ${reading.structure?.type}`);

    // Run Pass 2A and 2B in PARALLEL (saves time)
    console.log('[Pass 2A+2B] Running bull and bear analysts in parallel...');
    const [bullCase, bearCase] = await Promise.all([
      pass2a_bullAnalyst(imageBase64, mime, reading, sym, tf, apiKey),
      pass2b_bearAnalyst(imageBase64, mime, reading, sym, tf, apiKey)
    ]);
    console.log(`[Pass 2A] Bull score: ${bullCase.bull_score} | [Pass 2B] Bear score: ${bearCase.bear_score}`);

    // Pass 3 — Risk assessment (needs both cases)
    console.log('[Pass 3] Risk manager assessment...');
    const riskAssessment = await pass3_riskManager(imageBase64, mime, reading, bullCase, bearCase, sym, tf, apiKey);
    console.log(`[Pass 3] Risk: ${riskAssessment.overall_risk} | False signal: ${riskAssessment.false_signal_risk} | Dominant: ${riskAssessment.dominant_case}`);

    // Pass 4 — Final verdict (needs everything)
    console.log('[Pass 4] Supreme court final verdict...');
    const result = await pass4_supremeCourt(imageBase64, mime, reading, bullCase, bearCase, riskAssessment, sym, tf, apiKey);
    console.log(`[Pass 4] VERDICT: ${result.verdict} | Grade: ${result.signal_grade} | Confidence: ${result.confidence}%`);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[NexTrade 4-Pass] Complete in ${elapsed}s\n`);

    // Attach all passes for transparency
    result._analysis_passes = {
      pass1_chart_reading: reading,
      pass2a_bull_case: bullCase,
      pass2b_bear_case: bearCase,
      pass3_risk_assessment: riskAssessment,
      analysis_time_seconds: parseFloat(elapsed)
    };

    res.json(result);

  } catch (err) {
    console.error('[NexTrade] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  NexTrade AI — 4-Pass Engine`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});
