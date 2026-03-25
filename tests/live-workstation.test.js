const test = require('node:test');
const assert = require('node:assert/strict');

const liveWorkstation = require('../public/live-workstation.js');

test('classifies major markets correctly', () => {
  assert.equal(liveWorkstation.classifyLiveSymbol('ES1!'), 'futures');
  assert.equal(liveWorkstation.classifyLiveSymbol('BTC/USD'), 'crypto');
  assert.equal(liveWorkstation.classifyLiveSymbol('EUR/USD'), 'forex');
  assert.equal(liveWorkstation.classifyLiveSymbol('AAPL'), 'equity');
});

test('maps futures symbols to TradingView contracts', () => {
  assert.equal(liveWorkstation.getLiveChartExchangeSymbol('ES1!'), 'CME_MINI:ES1!');
  assert.equal(liveWorkstation.getLiveChartExchangeSymbol('MES'), 'CME_MINI:MES1!');
  assert.equal(liveWorkstation.getLiveChartExchangeSymbol('6E1!'), 'CME:6E1!');
  assert.equal(liveWorkstation.getLiveChartExchangeSymbol('GC'), 'COMEX:GC1!');
});

test('uses native chart path for futures only', () => {
  assert.equal(liveWorkstation.useCustomLiveChart('NQ1!'), true);
  assert.equal(liveWorkstation.useCustomLiveChart('BTC/USD'), false);
  assert.equal(liveWorkstation.useCustomLiveChart('EUR/USD'), false);
});

test('returns mode-aware best-time cards', () => {
  const scalp = liveWorkstation.getBestTimeCards('scalp', 'ES1!');
  assert.equal(scalp.badge, 'Fastest edge');
  assert.equal(scalp.cards[0].text, '9:30am-10:30am EST');

  const forex = liveWorkstation.getBestTimeCards('dayTrade', 'EUR/USD');
  assert.equal(forex.badge, 'London-led');
  assert.match(forex.cards[0].sub, /London open/i);
});

test('builds chart URLs with the right interval for mode', () => {
  const url = liveWorkstation.buildLiveChartUrl('SPY', 'swing');
  assert.match(url, /interval=60/);
  assert.match(url, /symbol=AMEX%3ASPY/);
});
