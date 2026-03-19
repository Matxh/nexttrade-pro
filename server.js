require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-opus-4-5';

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

function img(base64, mime) {
  return { type: 'image', source: { type: 'base64', media_type: mime||'image/png', data: base64 } };
}

// ═══════════════════════════════════════════════════════════════
// PASS 1 — INSTITUTIONAL ORDER FLOW ANALYST
// Reads the chart through the lens of what INSTITUTIONS are doing.
// Banks and smart money leave footprints. This finds them.
// ═══════════════════════════════════════════════════════════════
async function pass1_orderFlow(b64, mime, sym, tf, key) {
  const sys = `You are a former Goldman Sachs institutional order flow analyst with 15 years on a trading desk. You understand exactly how banks and institutional players move markets. You read charts by looking for WHERE institutions accumulated or distributed positions, and where they will TARGET next.

INSTITUTIONAL FOOTPRINT CHECKLIST — find ALL of these:
1. ACCUMULATION ZONES: Tight consolidation before a big move up — where institutions were quietly buying
2. DISTRIBUTION ZONES: Tight consolidation before a big move down — where institutions were selling
3. STOP HUNTS: Moves below obvious support or above obvious resistance to grab retail stops, then reverse
4. ORDER BLOCKS: The last down candle before a strong up move (bullish OB) or last up candle before strong down move (bearish OB)
5. FAIR VALUE GAPS: 3-candle patterns where price moved so fast it left an imbalance — institutions return to fill these
6. BREAKER BLOCKS: Former support that broke down becomes resistance, or former resistance that broke up becomes support
7. PREMIUM vs DISCOUNT: Price above the 50% level of the range = premium (institutions SELL here). Price below = discount (institutions BUY here)
8. LIQUIDITY POOLS: Equal highs/lows, previous day/week highs/lows, round numbers — institutions TARGET these to fill their orders
9. DISPLACEMENT: A strong, impulsive move with large candles and gaps — shows institutional involvement and intent
10. CONSOLIDATION AFTER IMPULSE: After a big move, price consolidates — this is institutions building positions for the next leg

Return ONLY raw JSON. No markdown.

{
  "current_price": "<price>",
  "institutional_bias": "Bullish" or "Bearish" or "Neutral",
  "market_phase": "Accumulation" or "Manipulation" or "Distribution" or "Markup" or "Markdown" or "Re-accumulation" or "Re-distribution",
  "price_in_range": "Premium" or "Discount" or "Equilibrium",
  "range_high": "<price>", "range_low": "<price>", "range_50pct": "<price>",
  "structure": {
    "trend": "Bullish" or "Bearish" or "Ranging",
    "pattern": "HH+HL" or "LH+LL" or "Mixed",
    "last_bos": "<price and direction of last break of structure>",
    "last_choch": "<change of character if any>",
    "swing_high": "<most recent swing high price>",
    "swing_low": "<most recent swing low price>"
  },
  "institutional_footprints": {
    "accumulation_zones": "<where did institutions accumulate? specific price zone>",
    "distribution_zones": "<where did institutions distribute? specific price zone>",
    "stop_hunts": "<any recent stop hunts visible? describe>",
    "order_blocks": {
      "bullish": "<price level of bullish OB if visible>",
      "bearish": "<price level of bearish OB if visible>"
    },
    "fair_value_gaps": {
      "bullish_fvg": "<price range of unfilled bullish FVG if visible>",
      "bearish_fvg": "<price range of unfilled bearish FVG if visible>"
    },
    "breaker_blocks": "<any breaker blocks visible?>",
    "displacement_moves": "<any strong institutional displacement moves? direction and approximate price>",
    "liquidity_targets": {
      "buy_side": "<where is buy-side liquidity — equal highs, previous highs>",
      "sell_side": "<where is sell-side liquidity — equal lows, previous lows>"
    }
  },
  "key_levels": [
    {"price": "<level>", "type": "Resistance" or "Support" or "OB" or "FVG" or "Liquidity", "strength": "Major" or "Minor", "why": "<reason>"}
  ],
  "volume_analysis": {
    "visible": true or false,
    "institutional_activity": "<high volume areas suggesting institutional buying or selling>",
    "climax_bars": "<any volume climax visible>",
    "dry_up": "<any volume dry-up before reversal>"
  },
  "next_institutional_target": "<where institutions will likely take price next — and why>",
  "confidence_in_reading": <0-100>,
  "order_flow_summary": "<3-4 sentences on what institutions are doing and where they are likely to take price next>"
}`;

  return claude(key, sys, [img(b64,mime), {type:'text', text:`Analyze institutional order flow on this ${tf} chart for ${sym}. Where are the institutions? What are they doing? Where will they take price next?`}], 2000);
}

// ═══════════════════════════════════════════════════════════════
// PASS 2 — MULTI-TIMEFRAME CONTEXT ANALYST
// Reads the chart at 3 different "zoom levels" simultaneously.
// The highest timeframe always wins.
// ═══════════════════════════════════════════════════════════════
async function pass2_multiTimeframe(b64, mime, sym, tf, orderFlow, key) {
  const sys = `You are a multi-timeframe analysis expert. You understand that the highest timeframe ALWAYS dictates the direction of the trade. Lower timeframes only provide entries.

THE GOLDEN RULE: Only trade in the direction of the higher timeframe trend. Trading against the higher timeframe is the #1 reason retail traders lose.

From a single chart, you can infer the multi-timeframe picture by:
- The OVERALL structure of the whole chart = Higher Timeframe (HTF) view
- The RECENT structure (last 30-40% of chart) = Intermediate Timeframe (ITF) view
- The MOST RECENT candles (last 5-10%) = Lower Timeframe (LTF) view

ALIGNMENT SCORING:
- HTF Bullish + ITF Bullish + LTF Bullish = PERFECT ALIGNMENT (highest probability longs)
- HTF Bullish + ITF Bullish + LTF Bearish = WAIT for LTF to turn bullish (pullback entry)
- HTF Bullish + ITF Bearish = CAUTION — only take longs at major HTF support
- HTF Bearish + ITF Bullish = COUNTER-TREND — very risky, avoid
- All three pointing same direction = MAXIMUM PROBABILITY SIGNAL

Return ONLY raw JSON.

{
  "htf_bias": "Bullish" or "Bearish" or "Neutral",
  "htf_structure": "<what the overall chart structure looks like — major trend>",
  "htf_key_level": "<most important level on the full chart>",
  "itf_bias": "Bullish" or "Bearish" or "Neutral",
  "itf_structure": "<what the recent portion of chart shows>",
  "itf_key_level": "<most important recent level>",
  "ltf_bias": "Bullish" or "Bearish" or "Neutral",
  "ltf_structure": "<what the most recent candles show>",
  "ltf_momentum": "Accelerating" or "Decelerating" or "Reversing" or "Flat",
  "alignment": "Perfect Bull" or "Perfect Bear" or "Partial Bull" or "Partial Bear" or "Mixed" or "No Alignment",
  "alignment_score": <0-100 — 100 = all 3 perfectly aligned>,
  "tradeable_direction": "Long" or "Short" or "Wait — no alignment" or "Wait — counter-trend risk",
  "optimal_entry_zone": "<where to enter for best HTF+ITF+LTF alignment>",
  "htf_support_resistance": {
    "major_resistance": "<HTF resistance>",
    "major_support": "<HTF support>"
  },
  "pullback_opportunity": "<is there a pullback entry available? where?>",
  "trend_age": "Young" or "Mature" or "Extended" or "Exhausted",
  "trend_age_reason": "<why — how far has price moved from origin?>",
  "counter_trend_risk": "High" or "Medium" or "Low",
  "mtf_summary": "<3-4 sentences on the multi-timeframe picture and what it means for trading direction>"
}`;

  return claude(key, sys, [img(b64,mime), {type:'text', text:`Analyze the multi-timeframe structure of this ${tf} ${sym} chart. Order flow context: ${JSON.stringify(orderFlow)}. What does HTF, ITF, and LTF all say? Are they aligned?`}], 1800);
}

// ═══════════════════════════════════════════════════════════════
// PASS 3 — PRECISE ENTRY ARCHITECT
// Only runs if bias is clear from Pass 1 and 2.
// Finds the EXACT entry with the absolute best risk/reward.
// ═══════════════════════════════════════════════════════════════
async function pass3_entryArchitect(b64, mime, sym, tf, orderFlow, mtf, key) {
  const direction = mtf.tradeable_direction;
  
  const sys = `You are a precision entry specialist. You have been given a clear directional bias. Your ONLY job now is to find the EXACT BEST entry point — the one with the tightest stop, highest R:R, and most confirmation.

THE PERFECT ENTRY has ALL of these:
1. Entry AT a key level (not chasing — waiting for price to come to you)
2. Entry confirmed by a trigger candle (pin bar, engulfing, inside bar break)
3. Stop loss at a LOGICAL structural level — below a swing low for longs, above swing high for shorts
4. At least 1:3 R:R to the first major target
5. Entry in DISCOUNT for longs (below 50% of range) or PREMIUM for shorts (above 50%)
6. No major resistance within 1R of the entry (for longs) or support (for shorts)

ENTRY TYPES (in order of quality):
1. LIMIT ORDER at OB/FVG/Support — best R:R, patience required
2. STOP ORDER on break of consolidation — good for breakouts
3. MARKET ORDER on trigger candle confirmation — faster but slightly worse R:R
4. SCALED ENTRY — split into 2 entries for better average

STOP LOSS PLACEMENT RULES:
- Always place stop BEYOND the structure (not at it — give it breathing room)
- For longs: stop below the swing low that would invalidate the setup, plus a small buffer
- For shorts: stop above the swing high that would invalidate the setup, plus a buffer
- NEVER use round number stops — place them just beyond structure

TARGET CALCULATION:
- TP1: Previous swing high (for longs) or previous swing low (for shorts) — 1:1.5 to 1:2 minimum
- TP2: Major key level or measured move target — 1:3 minimum
- TP3: Full trend extension — 1:5+

Return ONLY raw JSON.

{
  "entry_type": "Limit" or "Stop" or "Market" or "Scaled",
  "entry_price": "<exact price>",
  "entry_zone": "<range of acceptable entry — e.g. 43,100-43,200>",
  "entry_trigger": "<exact candle or price action needed to confirm entry>",
  "entry_quality": "A+" or "A" or "B" or "C",
  "entry_rationale": "<why this specific entry — what makes it the best possible>",
  "sl_price": "<exact stop loss price>",
  "sl_placement": "<structural reason — below/above what specific level>",
  "sl_buffer": "<how much buffer beyond the structural level>",
  "tp1_price": "<first target>",
  "tp1_rationale": "<why this level>",
  "tp2_price": "<second target>",
  "tp2_rationale": "<why>",
  "tp3_price": "<third target>",
  "tp3_rationale": "<why>",
  "rr_tp1": "<R:R ratio to TP1>",
  "rr_tp2": "<R:R ratio to TP2>",
  "rr_tp3": "<R:R ratio to TP3>",
  "risk_per_trade": "<recommended % of account to risk — conservative given conditions>",
  "obstacles_to_tp1": "<any S/R levels between entry and TP1 that could block the move>",
  "obstacles_to_tp2": "<any levels between TP1 and TP2>",
  "entry_timing": "<is the entry available NOW or does price need to come back to a level?>",
  "patience_required": true or false,
  "invalidation_before_entry": "<if price does X before the entry, the setup is cancelled>",
  "trade_management": {
    "move_sl_to_be": "<when to move stop to breakeven — after price reaches X>",
    "partial_tp": "<take X% off at TP1, let the rest run to TP2>",
    "trail_method": "<how to trail the stop after TP1 is hit>",
    "add_to_winner": "<can we add to the position? at what level?>"
  },
  "entry_summary": "<3-4 sentences on the exact entry plan — what to do step by step>"
}`;

  return claude(key, sys, [img(b64,mime), {type:'text', text:`Find the perfect entry for a ${direction} trade on this ${tf} ${sym} chart.\n\nOrder flow: ${JSON.stringify(orderFlow)}\nMTF alignment: ${JSON.stringify(mtf)}\n\nFind the EXACT best entry with maximum R:R. Be extremely specific with prices.`}], 2000);
}

// ═══════════════════════════════════════════════════════════════
// PASS 4 — FINAL VERDICT WITH CONSENSUS CHECK
// Combines all 3 passes. Applies strict quality gates.
// Only outputs signals that pass ALL filters.
// ═══════════════════════════════════════════════════════════════
async function pass4_finalVerdict(b64, mime, sym, tf, orderFlow, mtf, entry, key) {
  const sys = `You are the Chief Risk Officer and final decision maker. You have received:
1. Institutional order flow analysis
2. Multi-timeframe alignment analysis  
3. Precision entry architecture

Your job: Apply strict quality gates and output the final signal. You are the last line of defense against bad trades.

MANDATORY QUALITY GATES — if ANY fail, return WAIT:
✗ GATE 1: MTF alignment_score < 60 → WAIT
✗ GATE 2: Institutional bias conflicts with MTF tradeable_direction → WAIT
✗ GATE 3: Entry R:R to TP1 is less than 1:2 → WAIT
✗ GATE 4: obstacles_to_tp1 contains a major level → reduce confidence or WAIT
✗ GATE 5: trend_age is "Exhausted" → WAIT (never enter an exhausted trend)
✗ GATE 6: price_in_range is "Premium" for a long → WAIT (don't buy premium)
✗ GATE 7: price_in_range is "Discount" for a short → WAIT (don't sell discount)
✗ GATE 8: entry_quality is "C" or lower → WAIT
✗ GATE 9: confidence_in_reading < 55 → WAIT

CONFIDENCE FORMULA:
- Base: alignment_score / 100 * 70 (max 70 from alignment)
- +10 if institutional bias matches direction
- +5 if entry at OB or FVG
- +5 if entry in correct premium/discount zone
- +5 if R:R > 1:3
- -10 if trend_age is "Mature"
- -15 if any major obstacle to TP1
- Cap at 92 (never 95+ — markets are uncertain)

SIGNAL GRADING:
A+: alignment 90+, inst bias matches, correct zone, R:R 1:3+, no obstacles
A:  alignment 75+, inst bias matches, R:R 1:2.5+
B:  alignment 60+, R:R 1:2+
C:  alignment 50-60, some confluence
D:  weak setup — communicate clearly this is low quality

Return ONLY raw JSON. The fullAnalysis must be the most detailed, professional trade report ever written.

{
  "verdict": "BUY" or "SELL" or "WAIT",
  "confidence": <integer 40-92>,
  "signal_grade": "A+" or "A" or "B" or "C" or "D",
  "gates_passed": ["<gate 1 status>","<gate 2>","<gate 3>","<gate 4>","<gate 5>","<gate 6>","<gate 7>","<gate 8>","<gate 9>"],
  "gates_failed": ["<any failed gates — empty array if none>"],
  "wait_reason": "<if WAIT — exactly why>",
  "market_phase": "<from order flow>",
  "price_position": "<premium/discount/equilibrium>",
  "market_bias": "Strongly Bullish" or "Bullish" or "Neutral" or "Bearish" or "Strongly Bearish",
  "mtf_alignment": "<alignment score and direction>",
  "summary": "<8-10 sentence elite summary: institutional context, MTF alignment, price position, specific setup with all confluences, why each quality gate passed, exact trade plan, risk management, the single biggest risk, and the complete trade thesis>",
  "entry": "<from entry architect>",
  "entry_trigger": "<exact confirmation>",
  "entry_zone": "<acceptable range>",
  "sl": "<exact stop>",
  "sl_reason": "<structural reason>",
  "tp1": "<first target>",
  "tp1_reason": "<why>",
  "tp2": "<second target>",
  "tp2_reason": "<why>",
  "tp3": "<third target>",
  "rr_tp1": "<R:R>",
  "rr_tp2": "<R:R>",
  "rrLabel": "Poor" or "Acceptable" or "Good" or "Excellent",
  "position_size": "<% to risk — scale down if any concerns>",
  "confluences": ["<top 5-7 strongest confluences that make this a valid trade>"],
  "key_levels": {
    "major_resistance": "<price>",
    "minor_resistance": "<price>",
    "major_support": "<price>",
    "minor_support": "<price>",
    "equilibrium": "<50% of range>"
  },
  "smart_money": {
    "order_blocks": "<OBs>",
    "fvg": "<FVGs>",
    "liquidity_pools": "<where stops rest>",
    "recent_sweep": "<recent sweep>",
    "bos_choch": "<BOS/CHOCH>",
    "displacement": "<institutional moves>",
    "next_target": "<where institutions will take price>"
  },
  "factors": [
    {"name":"Trend","score":<0-100>,"note":"<specific>"},
    {"name":"Volume","score":<0-100>,"note":"<specific>"},
    {"name":"Momentum","score":<0-100>,"note":"<RSI MACD divergence>"},
    {"name":"Structure","score":<0-100>,"note":"<HH/HL BOS CHOCH phase>"},
    {"name":"Price Action","score":<0-100>,"note":"<candles patterns wicks>"},
    {"name":"Confluence","score":<0-100>,"note":"<total count of aligned factors>"},
    {"name":"Risk/Reward","score":<0-100>,"note":"<R:R quality and obstacles>"}
  ],
  "patterns": [
    {"name":"<pattern>","type":"bull" or "bear" or "neutral","reliability":"Low" or "Medium" or "High","significance":"<why this matters for the trade>"}
  ],
  "indicators": {
    "ema": "<alignment and price position>",
    "rsi": "<value, direction, divergence>",
    "macd": "<state, crossover, histogram>",
    "volume": "<analysis>",
    "other": "<other indicators>"
  },
  "invalidation": {
    "immediate": "<price that kills trade immediately>",
    "warning": "<early warning level>",
    "scenario": "<price action that signals the trade is failing>"
  },
  "trade_management": {
    "move_sl_to_be": "<when>",
    "partial_tp": "<take X% at TP1>",
    "trail_method": "<trailing method>",
    "add_to_winner": "<scale in conditions>"
  },
  "candle_analysis": "<last 5-7 key candles — what story do they tell?>",
  "best_case": "<ideal scenario if trade works perfectly>",
  "worst_case": "<what happens if trade fails — path and next setup opportunity>",
  "fullAnalysis": "<15-18 sentences of the most professional institutional trade report ever written. Use <strong> tags for key prices and terms. Structure: (1) Institutional order flow and what smart money is doing (2) Multi-timeframe analysis — HTF/ITF/LTF alignment with specific prices (3) Price position in range and why it matters (4) The specific setup — every confluence numbered and explained (5) Quality gates — which passed and why the trade is valid (6) Exact entry with trigger and rationale (7) Stop loss placement with structural reasoning (8) TP1, TP2, TP3 levels with specific reasons (9) Risk management rules — position size, BE, partials (10) The one thing that would kill this trade and the level to watch (11) Overall trade thesis and probability assessment>"
}`;

  return claude(key, sys, [img(b64,mime), {type:'text', text:`Apply all quality gates and make the final decision for ${tf} ${sym}.\n\nOrder Flow: ${JSON.stringify(orderFlow)}\nMTF: ${JSON.stringify(mtf)}\nEntry: ${JSON.stringify(entry)}\n\nBe strict. Apply every gate. Only signal if this is genuinely a high-quality setup.`}], 5000);
}

// ═══════════════════════════════════════════════════════════════
// MAIN API ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  const { imageBase64, imageMime, symbol, timeframe } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  const key  = process.env.ANTHROPIC_API_KEY;
  if (!key)  return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const sym  = symbol    || 'Unknown';
  const tf   = timeframe || '1H';
  const mime = imageMime || 'image/png';

  try {
    console.log(`\n[NexTrade] ═══ Starting 4-Pass Analysis: ${sym} ${tf} ═══`);
    const t0 = Date.now();

    // Pass 1 — Order flow (must run first)
    console.log('[Pass 1] Institutional order flow...');
    const orderFlow = await pass1_orderFlow(imageBase64, mime, sym, tf, key);
    console.log(`[Pass 1] ✓ Bias: ${orderFlow.institutional_bias} | Phase: ${orderFlow.market_phase} | Next target: ${orderFlow.next_institutional_target}`);

    // Pass 2 — Multi-timeframe (needs pass 1)
    console.log('[Pass 2] Multi-timeframe analysis...');
    const mtf = await pass2_multiTimeframe(imageBase64, mime, sym, tf, orderFlow, key);
    console.log(`[Pass 2] ✓ Alignment: ${mtf.alignment} (${mtf.alignment_score}/100) | Direction: ${mtf.tradeable_direction}`);

    // Pass 3 — Entry (needs 1+2, but only if direction is clear)
    let entry = {};
    if (mtf.tradeable_direction !== 'Wait — no alignment' && mtf.alignment_score >= 50) {
      console.log('[Pass 3] Precision entry architecture...');
      entry = await pass3_entryArchitect(imageBase64, mime, sym, tf, orderFlow, mtf, key);
      console.log(`[Pass 3] ✓ Entry: ${entry.entry_price} | SL: ${entry.sl_price} | TP1: ${entry.tp1_price} | R:R: ${entry.rr_tp1}`);
    } else {
      console.log('[Pass 3] Skipped — no clear alignment');
      entry = { entry_quality: 'D', entry_summary: 'No clear direction — skipped entry analysis' };
    }

    // Pass 4 — Final verdict (needs all passes)
    console.log('[Pass 4] Final verdict with quality gates...');
    const result = await pass4_finalVerdict(imageBase64, mime, sym, tf, orderFlow, mtf, entry, key);
    console.log(`[Pass 4] ✓ VERDICT: ${result.verdict} | Grade: ${result.signal_grade} | Confidence: ${result.confidence}%`);
    if (result.gates_failed?.length > 0) console.log(`[Pass 4] Gates failed: ${result.gates_failed.join(', ')}`);

    const elapsed = ((Date.now()-t0)/1000).toFixed(1);
    console.log(`[NexTrade] ═══ Complete in ${elapsed}s ═══\n`);

    result._meta = {
      analysis_time_seconds: parseFloat(elapsed),
      passes_completed: entry.entry_quality === 'D' ? 3 : 4,
      order_flow: orderFlow,
      mtf_analysis: mtf,
      entry_analysis: entry
    };

    res.json(result);

  } catch (err) {
    console.error('[NexTrade] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════╗`);
  console.log(`  ║   NexTrade AI — 4-Pass Engine     ║`);
  console.log(`  ║   http://localhost:${PORT}           ║`);
  console.log(`  ╚═══════════════════════════════════╝\n`);
});
