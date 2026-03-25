const test = require('node:test');
const assert = require('node:assert/strict');
const intelligence = require('../public/trade-intelligence.js');

test('classifies market types across major symbols', () => {
  assert.equal(intelligence.marketTypeFor('ES1!'), 'futures');
  assert.equal(intelligence.marketTypeFor('EUR/USD'), 'forex');
  assert.equal(intelligence.marketTypeFor('BTC/USD'), 'crypto');
  assert.equal(intelligence.marketTypeFor('AAPL'), 'equity');
});

test('builds journal intelligence summary metrics', () => {
  const trades = [
    { symbol: 'ES1!', verdict: 'BUY', grade: 'A', outcome: 'win', actual_rr: '2.0', timestamp: '2026-03-01T14:00:00.000Z' },
    { symbol: 'ES1!', verdict: 'BUY', grade: 'A', outcome: 'win', actual_rr: '1.5', timestamp: '2026-03-02T14:00:00.000Z' },
    { symbol: 'NQ1!', verdict: 'SELL', grade: 'B', outcome: 'loss', actual_rr: '-1.0', timestamp: '2026-03-03T14:00:00.000Z' },
    { symbol: 'AAPL', verdict: 'BUY', grade: 'B', outcome: 'win', actual_rr: '1.2', timestamp: '2026-03-04T14:00:00.000Z' },
    { symbol: 'EUR/USD', verdict: 'SELL', grade: 'C', outcome: 'loss', actual_rr: '-1.0', timestamp: '2026-03-05T14:00:00.000Z' }
  ];

  const result = intelligence.analyzeTradeJournal(trades);
  assert.equal(result.totalCompleted, 5);
  assert.equal(result.overallWR, 60);
  assert.equal(result.topSymbol.key, 'ES1!');
  assert.equal(result.buyWR, 100);
  assert.equal(result.sellWR, 0);
  assert.ok(result.expectancy !== null);
  assert.equal(result.gradeMix.find((row) => row.grade === 'A').count, 2);
  assert.equal(result.monthly.length, 1);
});
