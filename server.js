require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── ANALYZE endpoint ── */
app.post('/api/analyze', async (req, res) => {
  const { imageBase64, imageMime, symbol, timeframe } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env file' });
  }

  const systemPrompt = `You are an expert technical analyst with 20+ years of trading experience.
Analyze the trading chart screenshot and return ONLY a raw JSON object — no markdown fences, no preamble.

Required JSON:
{
  "verdict": "BUY" or "SELL" or "HOLD" or "WAIT",
  "confidence": <integer 40-95>,
  "summary": "<2-3 sentence plain English signal explanation>",
  "entry": "<price or descriptive level>",
  "sl": "<stop loss level>",
  "tp1": "<take profit level>",
  "rr": "<e.g. 1:2.5>",
  "rrLabel": "<e.g. Favorable>",
  "factors": [
    {"name":"Trend","score":<0-100>},
    {"name":"Volume","score":<0-100>},
    {"name":"Momentum","score":<0-100>},
    {"name":"Structure","score":<0-100>},
    {"name":"Price Action","score":<0-100>}
  ],
  "patterns": [{"name":"<pattern name>","type":"bull" or "bear" or "neutral"}],
  "fullAnalysis": "<3-5 sentences detailed HTML analysis with <strong> tags covering trend, key levels, momentum, patterns, and trade rationale>"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: imageMime || 'image/png', data: imageBase64 }
            },
            {
              type: 'text',
              text: `Analyze this ${timeframe || '1H'} chart for ${symbol || 'this asset'}. Identify the trend, key levels, patterns, and provide a precise trade signal with entry, stop loss, and take profit.`
            }
          ]
        }]
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
      if (m) parsed = JSON.parse(m[0]);
      else throw new Error('Could not parse AI response as JSON');
    }

    res.json(parsed);

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

/* ── Catch-all → serve index.html ── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  NexTrade AI running at http://localhost:${PORT}\n`);
});
