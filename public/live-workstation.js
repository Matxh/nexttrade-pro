(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LiveWorkstation = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  function getLiveChartInterval(mode) {
    return mode === 'scalp' ? '5' : mode === 'swing' ? '60' : '15';
  }

  function getLiveChartTimeframeCode(mode) {
    return mode === 'scalp' ? '5m' : mode === 'swing' ? '1H' : '15m';
  }

  function classifyLiveSymbol(rawSymbol) {
    const sym = (rawSymbol || '').trim().toUpperCase();
    if (!sym) return 'futures';
    if (sym.includes('BTC') || sym.includes('ETH') || sym.includes('SOL') || sym.includes('XRP')) return 'crypto';
    if (sym.includes('/') || /^[A-Z]{6}$/.test(sym) || /^(6E|6B|6J|6C|6A|6S)/.test(sym)) return 'forex';
    if (sym.includes('1!') || /^(ES|MES|NQ|MNQ|YM|MYM|RTY|M2K|CL|MCL|GC|MGC|SI|NG|HG|ZB|ZN|ZF|ZT|6E|6B|6J|6C|6A|6S)/.test(sym)) return 'futures';
    return 'equity';
  }

  function useCustomLiveChart(rawSymbol) {
    return classifyLiveSymbol(rawSymbol) === 'futures';
  }

  function getBestTimeCards(mode, rawSymbol) {
    const symbolType = classifyLiveSymbol(rawSymbol);
    if (symbolType === 'crypto') {
      return {
        badge: '24/7 market',
        meta: `${rawSymbol || 'BTC/USD'} · crypto timing`,
        cards: [
          { title: 'Prime Window', text: '8:00am-12:00pm EST', sub: 'London/NY overlap gives the cleanest crypto liquidity and best continuation moves.' },
          { title: 'Secondary Window', text: '1:30pm-4:00pm EST', sub: 'NY afternoon can still trend well, especially on BTC and ETH.' },
          { title: 'Avoid', text: '2:00am-5:00am EST on weekends', sub: 'Thin books and erratic spikes make live entries much less reliable.' }
        ]
      };
    }
    if (symbolType === 'forex') {
      return {
        badge: 'London-led',
        meta: `${rawSymbol || 'EUR/USD'} · forex timing`,
        cards: [
          { title: 'Prime Window', text: '3:00am-6:00am EST', sub: 'London open is the cleanest window for EUR, GBP, and JPY pairs.' },
          { title: 'Best US Follow-Through', text: '8:00am-11:00am EST', sub: 'London/NY overlap gives the strongest continuation and reversal setups.' },
          { title: 'Avoid', text: '12:00pm-6:00pm EST', sub: 'Volume fades hard after overlap unless major news is in play.' }
        ]
      };
    }
    if (mode === 'swing') {
      return {
        badge: 'Patient entries',
        meta: `${rawSymbol || 'ES1!'} · swing timing`,
        cards: [
          { title: 'Best Entry Window', text: '9:30am-11:30am EST', sub: 'NY open sets direction and gives the cleanest 1H/4H confirmations.' },
          { title: 'Daily Close Window', text: '3:30pm-4:00pm EST', sub: 'Great for entering after the daily candle confirms bias.' },
          { title: 'Avoid', text: 'Friday 1:00pm onward', sub: 'Weekend gap risk makes new swing entries lower quality.' }
        ]
      };
    }
    if (mode === 'scalp') {
      return {
        badge: 'Fastest edge',
        meta: `${rawSymbol || 'ES1!'} · scalp timing`,
        cards: [
          { title: 'Prime Window', text: '9:30am-10:30am EST', sub: 'Best for ES, NQ, CL, and index momentum right after NY open.' },
          { title: 'Secondary Window', text: '2:00pm-3:30pm EST', sub: 'Power hour brings volume back and improves continuation quality.' },
          { title: 'Avoid', text: '11:00am-2:00pm EST', sub: 'Midday chop kills scalp expectancy. Sit out unless it is exceptional.' }
        ]
      };
    }
    return {
      badge: 'Core session',
      meta: `${rawSymbol || 'ES1!'} · day trade timing`,
      cards: [
        { title: 'Prime Window', text: '9:30am-11:30am EST', sub: 'Best general session for futures and US equities.' },
        { title: 'Secondary Window', text: '2:00pm-4:00pm EST', sub: 'Power hour works well for continuation or closing range expansion.' },
        { title: 'Avoid', text: '11:30am-2:00pm EST', sub: 'False breaks and low conviction are much more common here.' }
      ]
    };
  }

  function getLiveChartExchangeSymbol(rawSymbol) {
    const sym = (rawSymbol || 'ES1!').trim().toUpperCase();
    if (!sym) return 'CME_MINI:ES1!';
    if (sym.includes(':')) return sym;

    const futuresMap = {
      ES: 'CME_MINI:ES1!',
      MES: 'CME_MINI:MES1!',
      NQ: 'CME_MINI:NQ1!',
      MNQ: 'CME_MINI:MNQ1!',
      YM: 'CBOT_MINI:YM1!',
      MYM: 'CBOT_MINI:MYM1!',
      RTY: 'CME_MINI:RTY1!',
      M2K: 'CME_MINI:M2K1!',
      CL: 'NYMEX:CL1!',
      MCL: 'NYMEX:MCL1!',
      NG: 'NYMEX:NG1!',
      RB: 'NYMEX:RB1!',
      HO: 'NYMEX:HO1!',
      GC: 'COMEX:GC1!',
      MGC: 'COMEX:MGC1!',
      SI: 'COMEX:SI1!',
      SIL: 'COMEX:SIL1!',
      HG: 'COMEX:HG1!',
      PA: 'NYMEX:PA1!',
      PL: 'NYMEX:PL1!',
      ZB: 'CBOT:ZB1!',
      ZN: 'CBOT:ZN1!',
      ZF: 'CBOT:ZF1!',
      ZT: 'CBOT:ZT1!',
      '6E': 'CME:6E1!',
      '6B': 'CME:6B1!',
      '6J': 'CME:6J1!',
      '6C': 'CME:6C1!',
      '6A': 'CME:6A1!',
      '6S': 'CME:6S1!'
    };

    const compact = sym.replace(/\s+/g, '').replace(/=F$/, '').replace(/!$/, '');
    const explicitRoot = compact.endsWith('1') ? compact.slice(0, -1) : compact;
    if (futuresMap[compact]) return futuresMap[compact];
    if (futuresMap[explicitRoot]) return futuresMap[explicitRoot];
    if (/^[A-Z0-9]{1,4}1!$/.test(sym)) {
      const root = sym.replace('1!', '');
      if (futuresMap[root]) return futuresMap[root];
    }
    if (sym.includes('/')) {
      const pair = sym.replace('/', '');
      if (pair.endsWith('USD')) {
        const base = pair.slice(0, -3);
        if (['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LTC'].includes(base)) {
          return `BINANCE:${base}USDT`;
        }
        return `FX:${pair}`;
      }
      return `FX:${pair}`;
    }
    if (/^[A-Z]{6}$/.test(sym)) return `FX:${sym}`;
    if (['SPY', 'QQQ', 'DIA', 'IWM'].includes(sym)) return `AMEX:${sym}`;
    return `NASDAQ:${sym}`;
  }

  function buildLiveChartOpenUrl(rawSymbol) {
    return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(getLiveChartExchangeSymbol(rawSymbol))}`;
  }

  function buildLiveChartUrl(rawSymbol, mode) {
    const params = new URLSearchParams({
      symbol: getLiveChartExchangeSymbol(rawSymbol),
      interval: getLiveChartInterval(mode),
      theme: 'dark',
      style: '1',
      timezone: 'America/New_York',
      withdateranges: '1',
      hide_side_toolbar: '0',
      allow_symbol_change: '1',
      saveimage: '0',
      details: '1',
      hotlist: '0',
      calendar: '0'
    });
    return `https://s.tradingview.com/widgetembed/?${params.toString()}`;
  }

  function renderBestTradingTimes(config) {
    const { symbol, mode, getEl } = config;
    const body = getEl('bestTimesBody');
    if (!body) return;
    const rawSymbol = (symbol || getEl('liveSymInput')?.value || 'ES1!').trim().toUpperCase();
    const data = getBestTimeCards(mode || 'dayTrade', rawSymbol);
    const meta = getEl('bestTimesMeta');
    const badge = getEl('bestTimesBadge');
    if (meta) meta.textContent = data.meta;
    if (badge) badge.textContent = data.badge;
    body.innerHTML = data.cards.map((card) => `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-family:var(--mono);font-size:9px;color:var(--text3);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">${card.title}</div>
        <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:5px">${card.text}</div>
        <div style="font-size:12px;color:var(--text2);line-height:1.55">${card.sub}</div>
      </div>
    `).join('');
  }

  async function fetchCustomLiveChartData(config) {
    const { rawSymbol, mode, token, fetchFn } = config;
    if (!token) throw new Error('Login required to load live chart');
    const params = new URLSearchParams({
      symbol: rawSymbol,
      timeframe: getLiveChartTimeframeCode(mode),
      bars: '80'
    });
    const response = await fetchFn(`/api/live-chart?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || 'Failed to load live chart');
    return json;
  }

  function renderCustomLiveChartSvg(config) {
    const { host, data, rawSymbol, escapeHtml, mode } = config;
    const candles = (data?.candles || []).map((c) => ({
      t: c.datetime,
      o: parseFloat(c.open),
      h: parseFloat(c.high),
      l: parseFloat(c.low),
      c: parseFloat(c.close),
      v: parseFloat(c.volume) || 0
    })).filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
    if (candles.length < 10) throw new Error(`Not enough chart data for ${rawSymbol}`);

    const width = 960;
    const height = 380;
    const pad = { top: 18, right: 74, bottom: 34, left: 18 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const highs = candles.map(c => c.h);
    const lows = candles.map(c => c.l);
    const volumes = candles.map(c => c.v);
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const priceRange = Math.max(maxPrice - minPrice, Math.abs(maxPrice) * 0.003, 0.25);
    const topPrice = maxPrice + priceRange * 0.08;
    const bottomPrice = minPrice - priceRange * 0.08;
    const maxVol = Math.max(...volumes, 1);
    const candleSlot = plotWidth / candles.length;
    const candleWidth = Math.max(3, Math.min(10, candleSlot * 0.55));
    const yFor = (price) => pad.top + ((topPrice - price) / (topPrice - bottomPrice)) * plotHeight;
    const xFor = (i) => pad.left + candleSlot * i + candleSlot / 2;

    const priceLabels = [topPrice, topPrice - (topPrice - bottomPrice) * 0.25, topPrice - (topPrice - bottomPrice) * 0.5, topPrice - (topPrice - bottomPrice) * 0.75, bottomPrice];
    const latest = candles[candles.length - 1];
    const prev = candles[candles.length - 2] || latest;
    const delta = latest.c - prev.c;
    const deltaPct = prev.c ? (delta / prev.c) * 100 : 0;

    host.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text)">${escapeHtml(rawSymbol)} Live Futures Chart</div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:3px">${escapeHtml(data.resolvedSymbol || rawSymbol)} · ${escapeHtml(data.tf || getLiveChartTimeframeCode(mode))} · ${escapeHtml(data.source || 'Data feed')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:800;color:${delta >= 0 ? '#00e676' : '#ff5c7a'}">${latest.c.toFixed(2)}</div>
          <div style="font-family:var(--mono);font-size:10px;color:${delta >= 0 ? '#00e676' : '#ff5c7a'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)} · ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%</div>
        </div>
      </div>
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" style="display:block;border-radius:10px;background:rgba(255,255,255,.01)">
        <defs>
          <linearGradient id="chartBgFade" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="rgba(61,158,255,.08)" />
            <stop offset="100%" stop-color="rgba(0,0,0,0)" />
          </linearGradient>
        </defs>
        <rect x="${pad.left}" y="${pad.top}" width="${plotWidth}" height="${plotHeight}" fill="url(#chartBgFade)" />
        ${priceLabels.map((price) => {
          const y = yFor(price);
          return `
            <line x1="${pad.left}" x2="${pad.left + plotWidth}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.08)" stroke-dasharray="4 6" />
            <text x="${pad.left + plotWidth + 10}" y="${y + 4}" fill="rgba(230,236,244,.72)" font-size="11" font-family="monospace">${price.toFixed(2)}</text>
          `;
        }).join('')}
        ${candles.map((candle, i) => {
          const x = xFor(i);
          const wickTop = yFor(candle.h);
          const wickBottom = yFor(candle.l);
          const openY = yFor(candle.o);
          const closeY = yFor(candle.c);
          const bodyY = Math.min(openY, closeY);
          const bodyHeight = Math.max(Math.abs(closeY - openY), 1.5);
          const color = candle.c >= candle.o ? '#00e676' : '#ff5c7a';
          const volHeight = Math.max(2, (candle.v / maxVol) * 58);
          return `
            <line x1="${x}" x2="${x}" y1="${wickTop}" y2="${wickBottom}" stroke="${color}" stroke-width="1.3" />
            <rect x="${x - candleWidth / 2}" y="${bodyY}" width="${candleWidth}" height="${bodyHeight}" rx="1.2" fill="${color}" />
            <rect x="${x - candleWidth / 2}" y="${pad.top + plotHeight - volHeight}" width="${candleWidth}" height="${volHeight}" fill="${candle.c >= candle.o ? 'rgba(0,230,118,.18)' : 'rgba(255,92,122,.18)'}" />
          `;
        }).join('')}
        <line x1="${pad.left}" x2="${pad.left + plotWidth}" y1="${yFor(latest.c)}" y2="${yFor(latest.c)}" stroke="${delta >= 0 ? 'rgba(0,230,118,.65)' : 'rgba(255,92,122,.65)'}" stroke-dasharray="5 5" />
        <text x="${pad.left}" y="${height - 10}" fill="rgba(230,236,244,.55)" font-size="11" font-family="monospace">${escapeHtml(candles[Math.max(0, candles.length - 1)].t || '')}</text>
        <text x="${pad.left + plotWidth - 120}" y="${height - 10}" fill="rgba(230,236,244,.55)" font-size="11" font-family="monospace">Source ${escapeHtml(data.source || '')}</text>
      </svg>
    `;
  }

  async function renderNativeLiveChart(config) {
    const { rawSymbol, mode, getEl, fetchFn, token, escapeHtml } = config;
    const host = getEl('customLiveChart');
    const iframe = getEl('liveChartFrame');
    const hint = getEl('liveChartHint');
    if (!host || !iframe) return;
    host.style.display = 'block';
    iframe.style.display = 'none';
    host.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;color:var(--text3)">Loading ${escapeHtml(rawSymbol)} chart...</div>`;
    try {
      const data = await fetchCustomLiveChartData({ rawSymbol, mode, token, fetchFn });
      renderCustomLiveChartSvg({ host, data, rawSymbol, escapeHtml, mode });
      if (hint) hint.innerHTML = `Native futures chart powered by your backend market data feed. If you want the broker-style chart too, use <strong style="color:var(--text2)">Open Full Chart</strong>.`;
    } catch (e) {
      host.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:24px">
          <div style="font-size:14px;font-weight:700;color:var(--text)">Chart unavailable</div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text3);max-width:460px">${escapeHtml(e.message || 'Could not load native futures chart')}</div>
        </div>
      `;
      if (hint) hint.innerHTML = `We couldn't load native futures data for this symbol yet. Try <strong style="color:var(--text2)">Open Full Chart</strong> or refresh once more.`;
    }
  }

  async function renderLiveChart(config) {
    const { symbol, mode, getEl, fetchFn, token, escapeHtml, getRefreshToken, setRefreshToken } = config;
    const rawSymbol = (symbol || getEl('liveSymInput')?.value || 'ES1!').trim().toUpperCase() || 'ES1!';
    const iframe = getEl('liveChartFrame');
    const customChart = getEl('customLiveChart');
    const hint = getEl('liveChartHint');
    if (!iframe || !customChart) return;
    const resolved = getLiveChartExchangeSymbol(rawSymbol);
    const meta = getEl('liveChartMeta');
    if (meta) meta.textContent = `${rawSymbol} -> ${resolved} · ${getLiveChartInterval(mode)}m · ${useCustomLiveChart(rawSymbol) ? 'Native Futures Chart' : 'TradingView'}`;
    const openLink = getEl('liveChartOpenLink');
    if (openLink) openLink.href = buildLiveChartOpenUrl(rawSymbol);
    renderBestTradingTimes({ symbol: rawSymbol, mode, getEl });
    if (useCustomLiveChart(rawSymbol)) {
      await renderNativeLiveChart({ rawSymbol, mode, getEl, fetchFn, token, escapeHtml });
      return;
    }
    customChart.style.display = 'none';
    iframe.style.display = 'block';
    const nextRefreshToken = (getRefreshToken ? getRefreshToken() : 0) + 1;
    if (setRefreshToken) setRefreshToken(nextRefreshToken);
    iframe.src = buildLiveChartUrl(rawSymbol, mode) + `#${nextRefreshToken}`;
    if (hint) hint.innerHTML = `If the embed says a symbol is only available on TradingView, use <strong style="color:var(--text2)">Open Full Chart</strong>. Some futures contracts are restricted in the lightweight embed but still open correctly in the full TradingView chart.`;
  }

  function cleanupServiceWorkers(serviceWorkerApi, consoleApi) {
    if (!serviceWorkerApi?.getRegistrations) return Promise.resolve([]);
    return serviceWorkerApi.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((reg) => reg.unregister())))
      .catch((e) => {
        if (consoleApi?.warn) consoleApi.warn('[SW] Cleanup failed:', e);
        return [];
      });
  }

  return {
    getLiveChartInterval,
    getLiveChartTimeframeCode,
    classifyLiveSymbol,
    useCustomLiveChart,
    getBestTimeCards,
    getLiveChartExchangeSymbol,
    buildLiveChartOpenUrl,
    buildLiveChartUrl,
    renderBestTradingTimes,
    fetchCustomLiveChartData,
    renderCustomLiveChartSvg,
    renderNativeLiveChart,
    renderLiveChart,
    cleanupServiceWorkers
  };
});
