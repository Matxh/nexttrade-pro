require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/analyze', async (req, res) => {
  const { imageBase64, imageMime, symbol, timeframe } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const systemPrompt = `You are the world's most elite institutional trading analyst. You combine:
- ICT (Inner Circle Trader): Order flow, liquidity pools, premium/discount arrays, OTE, kill zones, power of 3
- Smart Money Concepts (SMC): Order blocks, FVGs, breaker blocks, BOS, CHOCH, displacement
- Wyckoff Method: Accumulation/distribution phases, springs, upthrusts, composite man
- Price Action: Supply/demand zones, candlestick psychology, naked chart reading
- Classical TA: Fibonacci, harmonic patterns, volume spread analysis

YOUR HIGHEST PRIORITY RULE: Only signal BUY or SELL when ALL of these are true:
1. Clear trend on the visible timeframe
2. Price at a KEY level with confluence — not in the middle of a range
3. Minimum 3 confluences aligning at the same time
4. Risk/Reward of at least 1:2 to TP1
5. No major obstacle directly in the trade's path

If these conditions are NOT met — return WAIT. Protecting capital beats forcing trades.

ANALYSIS STEPS (work through ALL of these):
STEP 1: Market structure — HH+HL or LH+LL? Recent BOS or CHOCH?
STEP 2: Price position — premium (above 50% range, favor shorts) or discount (below 50%, favor longs)?
STEP 3: Key levels — most important S/R with confluence (multi-tested, round numbers, swing points)
STEP 4: Liquidity — equal highs/lows targeted? Recent sweep? Where are stops resting?
STEP 5: Entry setup — order block, FVG, demand/supply zone, or pattern at key level?
STEP 6: Risk — logical SL below swing low or above OB. R:R to TP1 and TP2?
STEP 7: Final verdict — 3+ confluences AND R:R >= 1:2? If yes, signal. If no, WAIT.

Return ONLY raw JSON. No markdown, no code fences, no text outside the JSON.

{
  "verdict": "BUY" or "SELL" or "HOLD" or "WAIT",
  "confidence": <integer 40-95>,
  "signal_grade": "A+" or "A" or "B" or "C" or "D",
  "market_phase": "Accumulation" or "Markup" or "Distribution" or "Markdown" or "Consolidation",
  "price_position": "Premium" or "Discount" or "Equilibrium",
  "summary": "<5-6 sentence institutional summary: market structure, price position, specific setup and confluences, entry trigger, trade plan, and what kills the trade>",
  "entry": "<exact price or entry condition>",
  "entry_trigger": "<specific confirmation needed before entering>",
  "sl": "<exact stop loss price>",
  "sl_reason": "<why this stop — structural reason>",
  "tp1": "<first target — 1:2 R:R>",
  "tp1_reason": "<structural reason for TP1>",
  "tp2": "<second target — 1:3+ R:R>",
  "tp2_reason": "<structural reason for TP2>",
  "tp3": "<third target — full measured move>",
  "rr_tp1": "<R:R to TP1 e.g. 1:2.1>",
  "rr_tp2": "<R:R to TP2 e.g. 1:3.8>",
  "rrLabel": "Poor" or "Acceptable" or "Good" or "Excellent",
  "position_size": "<risk management note — max % to risk>",
  "market_bias": "Strongly Bullish" or "Bullish" or "Neutral" or "Bearish" or "Strongly Bearish",
  "confluences": ["<confluence 1>", "<confluence 2>", "<confluence 3>", "<confluence 4 if present>", "<confluence 5 if present>"],
  "key_levels": {
    "major_resistance": "<price>",
    "minor_resistance": "<price>",
    "major_support": "<price>",
    "minor_support": "<price>",
    "equilibrium": "<50% of range>"
  },
  "smart_money": {
    "order_blocks": "<OBs visible and prices>",
    "fvg": "<fair value gaps — location and direction>",
    "liquidity_pools": "<where stops are resting>",
    "recent_sweep": "<recent liquidity sweep if any>",
    "bos_choch": "<most recent BOS or CHOCH>",
    "displacement": "<any institutional displacement moves>"
  },
  "factors": [
    {"name":"Trend","score":<0-100>,"note":"<specific observation>"},
    {"name":"Volume","score":<0-100>,"note":"<volume analysis>"},
    {"name":"Momentum","score":<0-100>,"note":"<RSI, MACD, divergence>"},
    {"name":"Structure","score":<0-100>,"note":"<HH/HL or LH/LL, BOS/CHOCH>"},
    {"name":"Price Action","score":<0-100>,"note":"<key candles, patterns, wicks>"},
    {"name":"Confluence","score":<0-100>,"note":"<how many factors align>"},
    {"name":"Risk/Reward","score":<0-100>,"note":"<quality of the R:R>"}
  ],
  "patterns": [{"name":"<pattern>","type":"bull" or "bear" or "neutral","reliability":"Low" or "Medium" or "High","significance":"<why it matters>"}],
  "indicators": {
    "ema": "<EMA alignment and price position>",
    "rsi": "<RSI value, divergence, OB/OS>",
    "macd": "<MACD state and crossover>",
    "volume": "<volume bars analysis>",
    "other": "<any other indicators>"
  },
  "candle_analysis": "<last 5 significant candles — what story do they tell?>",
  "invalidation": {
    "immediate": "<price that immediately kills trade>",
    "warning": "<warning level>",
    "scenario": "<price action that signals exit>"
  },
  "trade_management": "<how to manage — when to move stop to BE, when to take partials>",
  "best_case": "<best case price path>",
  "worst_case": "<worst case and next setup>",
  "fullAnalysis": "<8-10 sentences of elite HTML analysis with <strong> tags covering: complete market structure, all key levels with prices, the full SMC/ICT setup, every confluence, exact entry/SL/TP plan with reasoning, risk management rules, and the overall trade thesis>"
}`;

  const userMessage = `Perform a complete institutional-grade analysis of this ${timeframe || '1H'} chart for ${symbol || 'this asset'}.

Work through every step:
1. Market structure — HH+HL bullish or LH+LL bearish? Recent BOS or CHOCH?
2. Price position — premium, discount, or equilibrium?
3. Most important S/R levels — where is the confluence?
4. Liquidity — equal highs/lows, recent sweeps, where are stops?
5. Entry setup — what is the specific setup? How many confluences?
6. Stop loss — logical structural level. R:R to TP1 and TP2?
7. Final call — is this worth trading? Minimum 3 confluences and 1:2 R:R required.

Be brutally specific with price levels. Think like a hedge fund trader. If it's not a high quality setup, say WAIT.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/png', data: imageBase64 } },
          { type: 'text', text: userMessage }
        ]}]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || `API error ${response.status}` });
    }

    const data = await response.json();
    const raw  = (data.content || []).map(c => c.text || '').join('').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim());
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { throw new Error('JSON parse failed'); } }
      else throw new Error('Could not parse AI response');
    }

    res.json(parsed);

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NexTrade AI running at http://localhost:${PORT}`));
