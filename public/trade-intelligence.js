(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TradeIntelligence = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  function toNumber(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }

  function marketTypeFor(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return 'unknown';
    if (sym.includes('/') && /^[A-Z]{3}\/[A-Z]{3}$/.test(sym)) {
      return /(BTC|ETH|SOL|XRP|DOGE|ADA)/.test(sym) ? 'crypto' : 'forex';
    }
    if (/^(ES|MES|NQ|MNQ|YM|MYM|RTY|M2K|CL|MCL|GC|MGC|SI|SIL|NG|ZN|ZB|ZF|ZT|6E|6B|6J|6A|6C|6N|HG)/.test(sym) || sym.endsWith('1!')) return 'futures';
    if (/(BTC|ETH|SOL|XRP|DOGE|ADA|LTC)/.test(sym)) return 'crypto';
    if (/^[A-Z.\-]{1,8}$/.test(sym)) return 'equity';
    return 'unknown';
  }

  function buildWinRateMap(trades, selector, minTrades = 2) {
    const buckets = {};
    trades.forEach((trade) => {
      const key = selector(trade);
      if (!key) return;
      if (!buckets[key]) buckets[key] = { wins: 0, total: 0 };
      buckets[key].total++;
      if (trade.outcome === 'win') buckets[key].wins++;
    });
    return Object.entries(buckets)
      .filter(([, value]) => value.total >= minTrades)
      .map(([key, value]) => ({
        key,
        wins: value.wins,
        total: value.total,
        wr: Math.round((value.wins / value.total) * 100)
      }))
      .sort((a, b) => (b.wr - a.wr) || (b.total - a.total));
  }

  function summarizeMonths(trades) {
    const monthly = {};
    trades.forEach((trade) => {
      if (!trade.timestamp) return;
      const month = new Date(trade.timestamp).toISOString().slice(0, 7);
      if (!monthly[month]) monthly[month] = { wins: 0, total: 0 };
      monthly[month].total++;
      if (trade.outcome === 'win') monthly[month].wins++;
    });
    return Object.entries(monthly)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([month, value]) => ({
        month,
        wins: value.wins,
        total: value.total,
        wr: Math.round((value.wins / value.total) * 100)
      }));
  }

  function summarizeGradeMix(trades) {
    const grades = ['A+', 'A', 'B', 'C', 'D'];
    const counts = {};
    trades.forEach((trade) => {
      const grade = trade.grade || 'B';
      counts[grade] = (counts[grade] || 0) + 1;
    });
    return grades.map((grade) => ({
      grade,
      count: counts[grade] || 0,
      pct: trades.length ? Math.round(((counts[grade] || 0) / trades.length) * 100) : 0
    }));
  }

  function analyzeTradeJournal(trades) {
    const completed = (trades || []).filter((trade) => trade && trade.outcome);
    const wins = completed.filter((trade) => trade.outcome === 'win');
    const rrTrades = completed
      .map((trade) => ({ ...trade, rr: toNumber(trade.actual_rr) }))
      .filter((trade) => trade.rr !== null);

    const winRate = completed.length ? wins.length / completed.length : 0;
    const avgRR = rrTrades.length ? rrTrades.reduce((sum, trade) => sum + trade.rr, 0) / rrTrades.length : null;
    const expectancy = avgRR !== null && completed.length ? (winRate * avgRR) - (1 - winRate) : null;
    const topSymbols = buildWinRateMap(completed, (trade) => trade.symbol || 'Unknown');
    const topMarketTypes = buildWinRateMap(completed, (trade) => marketTypeFor(trade.symbol));
    const byDirection = buildWinRateMap(completed, (trade) => trade.verdict === 'SELL' ? 'SELL' : 'BUY', 1);
    const recentTrades = completed.slice(-10);
    const recentWR = recentTrades.length ? Math.round((recentTrades.filter((trade) => trade.outcome === 'win').length / recentTrades.length) * 100) : null;
    const momentum = recentWR === null ? 'insufficient' : recentWR >= Math.round(winRate * 100) ? 'improving' : 'cooling';

    let focus = 'Keep logging clean executions so the coach can isolate your strongest setup.';
    const buyEntry = byDirection.find((row) => row.key === 'BUY');
    const sellEntry = byDirection.find((row) => row.key === 'SELL');
    if (expectancy !== null && expectancy < 0) {
      focus = 'Expectancy is negative. Tighten to A and A+ setups, reduce frequency, and stabilize before increasing risk again.';
    } else if (topSymbols[0] && topSymbols[0].wr >= 60) {
      focus = `Your strongest market is ${topSymbols[0].key}. Build the next 10-trade sample around that symbol instead of spreading focus.`;
    } else if (buyEntry && sellEntry && Math.abs(buyEntry.wr - sellEntry.wr) >= 15) {
      focus = buyEntry.wr > sellEntry.wr
        ? `Longs are outperforming shorts by ${buyEntry.wr - sellEntry.wr} points. Lean into BUY setups until the edge normalizes.`
        : `Shorts are outperforming longs by ${sellEntry.wr - buyEntry.wr} points. Lean into SELL setups until the edge normalizes.`;
    } else if (avgRR !== null && avgRR < 1.2) {
      focus = 'Execution quality is decent, but realized reward is compressed. Let winners push into structure instead of cutting too early.';
    }

    return {
      totalCompleted: completed.length,
      totalWins: wins.length,
      overallWR: Math.round(winRate * 100),
      expectancy,
      avgRR,
      topSymbol: topSymbols[0] || null,
      topSymbols: topSymbols.slice(0, 5),
      topMarketType: topMarketTypes[0] || null,
      buyWR: buyEntry ? buyEntry.wr : null,
      sellWR: sellEntry ? sellEntry.wr : null,
      recentWR,
      recentTrades: recentTrades.length,
      momentum,
      monthly: summarizeMonths(completed),
      gradeMix: summarizeGradeMix(completed),
      focus
    };
  }

  return {
    analyzeTradeJournal,
    marketTypeFor
  };
});
