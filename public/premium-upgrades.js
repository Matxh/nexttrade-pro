(function () {
  const $ = window.$ || ((id) => document.getElementById(id));
  const STORAGE_KEYS = {
    draft: 'nt_analyzer_draft_v2',
    quick: 'nt_quick_symbols_v1',
    checklist: 'nt_checklist_state_v1',
    plans: 'nt_saved_signal_plans_v1'
  };

  const DEFAULT_QUICK = {
    scalp: ['ES1!', 'NQ1!', 'BTC/USD', 'ETH/USD', 'EUR/USD', 'GBP/USD'],
    dayTrade: ['ES1!', 'NQ1!', 'SPY', 'QQQ', 'AAPL', 'NVDA'],
    swing: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA']
  };

  const CHECKLIST_ITEMS = [
    { id: 'session', label: 'Trading in a valid session window', help: 'Avoid forcing trades in low-liquidity chop.' },
    { id: 'bias', label: 'Higher timeframe bias is clear', help: 'Direction should be obvious before looking for entries.' },
    { id: 'risk', label: 'Risk is pre-defined and acceptable', help: 'Know the loss before you know the win.' },
    { id: 'discipline', label: 'No revenge or impulsive trade motive', help: 'Trade the setup, not the emotion.' }
  ];
  let paletteIndex = 0;
  let paletteItems = [];
  let currentSignal = null;

  function parseJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function currentMode() {
    return window.tradeMode || 'scalp';
  }

  function currentSymbol() {
    return (($('sym') && $('sym').value) || ($('liveSymInput') && $('liveSymInput').value) || '').trim().toUpperCase();
  }

  function syncSymbols(sym) {
    const upper = (sym || '').trim().toUpperCase();
    if (!upper) return;
    if ($('sym')) $('sym').value = upper;
    if ($('liveSymInput')) $('liveSymInput').value = upper;
    if (typeof window.updateAnalyzeBar === 'function') window.updateAnalyzeBar();
    if (typeof window.renderLiveChart === 'function') window.renderLiveChart(upper);
  }

  function getQuickState() {
    return parseJSON(STORAGE_KEYS.quick, { pinned: [], recent: [] });
  }

  function setQuickState(next) {
    saveJSON(STORAGE_KEYS.quick, next);
  }

  function addRecentSymbol(sym) {
    const upper = (sym || '').trim().toUpperCase();
    if (!upper) return;
    const state = getQuickState();
    state.recent = [upper, ...state.recent.filter((s) => s !== upper)].slice(0, 6);
    setQuickState(state);
    renderQuickSymbols();
  }

  function pinCurrentSymbol() {
    const sym = currentSymbol();
    if (!sym) return;
    const state = getQuickState();
    if (!state.pinned.includes(sym)) {
      state.pinned = [sym, ...state.pinned].slice(0, 8);
      setQuickState(state);
    }
    renderQuickSymbols();
  }

  function removePinnedSymbol(sym) {
    const state = getQuickState();
    state.pinned = state.pinned.filter((s) => s !== sym);
    setQuickState(state);
    renderQuickSymbols();
  }

  function renderQuickSymbols() {
    const host = $('quickSymbolChips');
    if (!host) return;
    const state = getQuickState();
    const base = DEFAULT_QUICK[currentMode()] || [];
    const symbols = [...state.pinned, ...state.recent, ...base]
      .filter((sym, idx, arr) => sym && arr.indexOf(sym) === idx)
      .slice(0, 10);

    host.innerHTML = symbols.map((sym) => {
      const isPinned = state.pinned.includes(sym);
      return `
        <button
          type="button"
          data-sym="${sym}"
          style="background:${isPinned ? 'rgba(0,229,180,.12)' : 'var(--card)'};border:1px solid ${isPinned ? 'rgba(0,229,180,.35)' : 'var(--border)'};color:${isPinned ? 'var(--accent)' : 'var(--text2)'};border-radius:999px;padding:6px 10px;font-family:var(--mono);font-size:10px;cursor:pointer"
        >
          ${sym}${isPinned ? ' *' : ''}
        </button>
      `;
    }).join('');

    Array.from(host.querySelectorAll('button[data-sym]')).forEach((btn) => {
      btn.addEventListener('click', () => {
        const sym = btn.getAttribute('data-sym');
        syncSymbols(sym);
        addRecentSymbol(sym);
      });
      btn.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const sym = btn.getAttribute('data-sym');
        removePinnedSymbol(sym);
      });
    });
  }

  function getScanUniverse() {
    const state = getQuickState();
    const watchlist = Array.isArray(window.watchlist) ? window.watchlist : [];
    return [...state.pinned, ...state.recent, ...watchlist, ...(DEFAULT_QUICK[currentMode()] || [])]
      .filter((sym, idx, arr) => sym && arr.indexOf(sym) === idx)
      .slice(0, 10);
  }

  async function scanWatchlist() {
    const panel = $('premiumWatchlistScanPanel');
    const resultsEl = $('premiumWatchlistResults');
    const statusEl = $('premiumWatchlistStatus');
    const metaEl = $('premiumWatchlistMeta');
    if (!panel || !resultsEl || !statusEl || !metaEl) return;

    const symbols = getScanUniverse();
    panel.style.display = '';
    if (!symbols.length) {
      resultsEl.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text3)">Add or pin symbols first so the watchlist scan has something to rank.</div>';
      statusEl.textContent = 'No symbols';
      return;
    }

    statusEl.textContent = 'Scanning...';
    metaEl.textContent = `${symbols.length} symbols · ${currentMode()} mode`;
    resultsEl.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text3)">Running live scan across your watchlist...</div>';

    try {
      const res = await fetch('/api/scanner', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(window.authToken ? { Authorization: 'Bearer ' + window.authToken } : {})
        },
        body: JSON.stringify({ symbols, tradeMode: currentMode() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Watchlist scan failed');
      const ranked = (data.results || []).slice(0, 4);
      if (!ranked.length) {
        statusEl.textContent = 'No signals';
        resultsEl.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text3)">No high-quality setups found right now. Stay patient.</div>';
        return;
      }

      statusEl.textContent = 'Ready';
      resultsEl.innerHTML = ranked.map((item, idx) => {
        const tone = item.verdict === 'BUY' ? 'var(--green)' : item.verdict === 'SELL' ? 'var(--red)' : 'var(--text2)';
        return `
          <button type="button" data-scan-sym="${item.symbol}" style="width:100%;text-align:left;background:${idx === 0 ? 'rgba(0,229,180,.06)' : 'var(--bg3)'};border:1px solid ${idx === 0 ? 'rgba(0,229,180,.25)' : 'var(--border)'};border-radius:12px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;margin-bottom:8px">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:13px;font-weight:700;color:var(--text)">${item.symbol}</span>
                <span style="font-family:var(--mono);font-size:10px;color:${tone}">${item.verdict || 'WAIT'}</span>
                <span style="font-family:var(--mono);font-size:10px;color:var(--text3)">${item.grade || item.signal_grade || '—'}</span>
              </div>
              <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:4px">${item.summary || 'No summary available.'}</div>
            </div>
            <div style="text-align:right">
              <div style="font-family:var(--mono);font-size:11px;color:${tone};font-weight:700">${item.confidence || 0}%</div>
              <div style="font-family:var(--mono);font-size:9px;color:var(--text3)">${idx === 0 ? 'Best now' : 'Open chart'}</div>
            </div>
          </button>
        `;
      }).join('');

      Array.from(resultsEl.querySelectorAll('button[data-scan-sym]')).forEach((button) => {
        button.addEventListener('click', () => {
          const sym = button.getAttribute('data-scan-sym');
          syncSymbols(sym);
          addRecentSymbol(sym);
          if (window.showPage) window.showPage('analyzer');
        });
      });
    } catch (error) {
      statusEl.textContent = 'Error';
      resultsEl.innerHTML = `<div style="font-family:var(--mono);font-size:11px;color:var(--red)">${error.message}</div>`;
    }
  }

  function getSessionPlaybook() {
    const label = (($('sessionLabel') && $('sessionLabel').textContent) || '').toLowerCase();
    const mode = currentMode();
    const modeName = mode === 'scalp' ? 'Scalp' : mode === 'swing' ? 'Swing' : 'Day Trade';

    if (/prime|open|london/.test(label)) {
      return {
        score: 'A-Window',
        color: 'var(--green)',
        body: `${modeName} mode is currently in a high-quality session. Focus on clean confirmation only, let volume lead, and avoid chasing the first spike if structure has already expanded.`,
        meta: 'Best execution regime'
      };
    }
    if (/mid-session/.test(label)) {
      return {
        score: 'B-Window',
        color: 'var(--amber)',
        body: `${modeName} mode is in a slower session. Prioritize only A/A+ setups, reduce size on marginal trades, and lean toward managing existing positions over forcing new entries.`,
        meta: 'Selective execution only'
      };
    }
    if (/after hours|overnight/.test(label)) {
      return {
        score: 'Plan Mode',
        color: 'var(--blue)',
        body: `${modeName} mode is outside the best entry window. Mark levels, plan alerts, and prepare the next trade instead of pressing low-liquidity conditions.`,
        meta: 'Preparation over execution'
      };
    }
    return {
      score: 'Stand by',
      color: 'var(--text2)',
      body: `Use ${modeName} mode rules, verify checklist quality, and wait for the session timer to confirm a stronger execution window.`,
      meta: 'Awaiting session read'
    };
  }

  function renderPlaybook() {
    const body = $('premiumPlaybookBody');
    const score = $('premiumPlaybookScore');
    const meta = $('premiumPlaybookMeta');
    if (!body || !score || !meta) return;
    const data = getSessionPlaybook();
    body.textContent = data.body;
    score.textContent = data.score;
    score.style.color = data.color;
    meta.textContent = data.meta;
  }

  function getChecklistState() {
    return parseJSON(STORAGE_KEYS.checklist, {});
  }

  function setChecklistState(next) {
    saveJSON(STORAGE_KEYS.checklist, next);
  }

  function renderChecklist() {
    const host = $('premiumChecklistBody');
    if (!host) return;
    const state = getChecklistState();
    host.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
        ${CHECKLIST_ITEMS.map((item) => `
          <label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:10px;cursor:pointer">
            <input type="checkbox" data-check-id="${item.id}" ${state[item.id] ? 'checked' : ''} style="margin-top:2px">
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--text)">${item.label}</div>
              <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:3px">${item.help}</div>
            </div>
          </label>
        `).join('')}
      </div>
    `;

    Array.from(host.querySelectorAll('input[data-check-id]')).forEach((input) => {
      input.addEventListener('change', () => {
        const next = getChecklistState();
        next[input.getAttribute('data-check-id')] = input.checked;
        setChecklistState(next);
        updateChecklistStatus();
      });
    });

    updateChecklistStatus();
  }

  function updateChecklistStatus(signal) {
    const state = getChecklistState();
    const score = CHECKLIST_ITEMS.reduce((sum, item) => sum + (state[item.id] ? 1 : 0), 0);
    const scoreEl = $('checklistScore');
    if (scoreEl) {
      scoreEl.textContent = `${score} / ${CHECKLIST_ITEMS.length} ready`;
      scoreEl.style.color = score >= 3 ? 'var(--green)' : score >= 2 ? 'var(--amber)' : 'var(--red)';
    }

    const banner = $('premiumRiskBanner');
    if (!banner) return;

    const journalTrades = Array.isArray(window.allTrades) ? window.allTrades.filter((t) => t && t.outcome) : [];
    const wins = journalTrades.filter((t) => t.outcome === 'win').length;
    const winRate = journalTrades.length ? Math.round((wins / journalTrades.length) * 100) : null;
    const sessionText = (($('sessionLabel') && $('sessionLabel').textContent) || '').toLowerCase();
    const sessionWarning = /mid-session|after hours|overnight/.test(sessionText);

    const messages = [];
    if (score < 2) messages.push('Checklist score is too low. Slow down and validate the setup before firing.');
    else if (score < 4) messages.push('Checklist is partially complete. Good setups should still be selective.');
    else messages.push('Checklist is clean. Execution conditions look disciplined.');

    if (sessionWarning) messages.push('Current session regime is lower quality for fresh entries. Size down or wait for the better window.');
    if (winRate !== null && winRate < 45) messages.push(`Journal win rate is ${winRate}%. Tighten to your best markets and grades until performance improves.`);
    if (signal && signal.verdict && signal.verdict !== 'WAIT' && signal.confidence && parseInt(signal.confidence, 10) < 60) {
      messages.push('Signal confidence is modest. Treat this as a B-plan setup, not an aggressive entry.');
    }

    banner.style.display = '';
    banner.style.background = score >= 3 && !sessionWarning ? 'var(--green-dim)' : 'var(--amber-dim)';
    banner.style.color = score >= 3 && !sessionWarning ? 'var(--green)' : 'var(--amber)';
    banner.style.borderTopColor = score >= 3 && !sessionWarning ? 'rgba(0,230,118,.25)' : 'rgba(255,179,0,.25)';
    banner.textContent = messages.join(' ');
    renderPlaybook();
  }

  function renderExecutionPlan(signal) {
    const panel = $('rExecutionPlan');
    const body = $('executionPlanBody');
    if (!panel || !body) return;
    if (!signal || !signal.entry || !signal.verdict || signal.verdict === 'WAIT') {
      panel.style.display = 'none';
      body.innerHTML = '';
      return;
    }

    const verdict = signal.verdict === 'SELL' ? 'SELL' : 'BUY';
    const riskLine = signal.sl ? `${verdict === 'BUY' ? 'Invalidation below' : 'Invalidation above'} ${signal.sl}` : 'Use the invalidation level before entering.';
    const management = signal.trade_management || {};
    const steps = [
      `Wait for price to interact with the planned entry around ${signal.entry}.`,
      riskLine,
      management.move_to_be || management.move_sl_to_be ? `Move stop to breakeven when ${management.move_to_be || management.move_sl_to_be}.` : 'Move to breakeven only after the trade proves itself.',
      management.partial_at_tp1 || management.partial_tp1 || signal.tp1 ? `Take partials into TP1 at ${signal.tp1 || 'the first target'} and reassess momentum.` : 'Scale only if structure confirms continuation.',
      management.trail_method ? `Trail risk using: ${management.trail_method}.` : 'Trail behind fresh structure instead of guessing exits.'
    ];

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px">
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Primary Trigger</div>
          <div style="font-size:13px;color:var(--text)">${verdict} continuation with confirmation near ${signal.entry}</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Risk Frame</div>
          <div style="font-size:13px;color:var(--text)">${signal.rr_tp1 ? `Targeting ${signal.rr_tp1}` : 'Protect capital first'}${signal.signal_grade ? ` · Grade ${signal.signal_grade}` : ''}</div>
        </div>
      </div>
      <div style="display:grid;gap:8px">
        ${steps.map((step, idx) => `
          <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:10px">
            <div style="width:22px;height:22px;border-radius:999px;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:10px;flex-shrink:0">${idx + 1}</div>
            <div style="font-size:13px;color:var(--text2);line-height:1.6">${step}</div>
          </div>
        `).join('')}
      </div>
    `;
    panel.style.display = '';
  }

  function getSavedPlans() {
    return parseJSON(STORAGE_KEYS.plans, []);
  }

  function setSavedPlans(plans) {
    saveJSON(STORAGE_KEYS.plans, plans);
  }

  function renderSavedPlans() {
    const list = $('savedPlansList');
    const count = $('savedPlansCount');
    if (!list || !count) return;
    const plans = getSavedPlans();
    count.textContent = `${plans.length} plan${plans.length === 1 ? '' : 's'}`;
    if (!plans.length) {
      list.innerHTML = '<div class="hist-empty">Saved execution plans appear here</div>';
      return;
    }
    list.innerHTML = plans.map((plan, idx) => `
      <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <button type="button" data-plan-index="${idx}" style="background:none;border:none;padding:0;text-align:left;cursor:pointer;flex:1">
            <div style="font-size:12px;font-weight:700;color:var(--text)">${plan.symbol} · ${plan.verdict}</div>
            <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:4px">${plan.entry || '—'} / ${plan.sl || '—'} / ${plan.tp1 || '—'} · ${plan.grade || '—'}</div>
          </button>
          <button type="button" data-delete-plan="${idx}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text3);border-radius:8px;padding:4px 8px;font-family:var(--mono);font-size:10px;cursor:pointer">×</button>
        </div>
      </div>
    `).join('');

    Array.from(list.querySelectorAll('button[data-plan-index]')).forEach((button) => {
      button.addEventListener('click', () => {
        const plan = plans[parseInt(button.getAttribute('data-plan-index'), 10)];
        if (!plan) return;
        syncSymbols(plan.symbol);
        if (window.showPage) window.showPage('analyzer');
      });
    });
    Array.from(list.querySelectorAll('button[data-delete-plan]')).forEach((button) => {
      button.addEventListener('click', () => {
        const idx = parseInt(button.getAttribute('data-delete-plan'), 10);
        const next = getSavedPlans();
        next.splice(idx, 1);
        setSavedPlans(next);
        renderSavedPlans();
      });
    });
  }

  function saveSignalPlan() {
    if (!currentSignal || !currentSignal.symbol || !currentSignal.verdict || currentSignal.verdict === 'WAIT') return;
    const plans = getSavedPlans();
    const plan = {
      symbol: currentSignal.symbol,
      verdict: currentSignal.verdict,
      entry: currentSignal.entry || '',
      sl: currentSignal.sl || '',
      tp1: currentSignal.tp1 || '',
      grade: currentSignal.signal_grade || currentSignal.grade || '',
      confidence: currentSignal.confidence || '',
      ts: Date.now()
    };
    const deduped = [plan, ...plans.filter((p) => !(p.symbol === plan.symbol && p.entry === plan.entry && p.verdict === plan.verdict))].slice(0, 8);
    setSavedPlans(deduped);
    renderSavedPlans();
    if (typeof window.showToast === 'function') window.showToast(`Saved plan for ${plan.symbol}`, 'success');
  }

  function getPaletteActions() {
    const base = [
      { label: 'Go to Analyzer', hint: 'Open main workspace', run: () => window.showPage && window.showPage('analyzer') },
      { label: 'Go to Journal', hint: 'Review stats and trades', run: () => window.showPage && window.showPage('journal') },
      { label: 'Go to Calculator', hint: 'Size the next trade', run: () => window.showPage && window.showPage('calculator') },
      { label: 'Analyze Live', hint: 'Run live market analysis', run: () => window.analyzeLive && window.analyzeLive() },
      { label: 'Analyze Screenshots', hint: 'Run uploaded chart analysis', run: () => window.runAnalysis && window.runAnalysis() },
      { label: 'Switch to Scalp Mode', hint: '1m / 5m / 15m workflow', run: () => window.setMode && window.setMode('scalp', $('modeScalp')) },
      { label: 'Switch to Day Trade Mode', hint: '15m / 1H / 4H workflow', run: () => window.setMode && window.setMode('dayTrade', $('modeDayTrade')) },
      { label: 'Switch to Swing Mode', hint: '1H / 4H / 1D workflow', run: () => window.setMode && window.setMode('swing', $('modeSwing')) },
      { label: 'Pin Current Symbol', hint: 'Add current symbol to quick chips', run: () => pinCurrentSymbol() },
      { label: 'Scan Watchlist', hint: 'Rank current symbols by best live setup', run: () => scanWatchlist() },
      { label: 'Save Current Plan', hint: 'Store the current execution plan', run: () => saveSignalPlan() }
    ];
    const state = getQuickState();
    const dynamicSymbols = [...state.pinned, ...state.recent, ...(DEFAULT_QUICK[currentMode()] || [])]
      .filter((sym, idx, arr) => sym && arr.indexOf(sym) === idx)
      .slice(0, 8)
      .map((sym) => ({
        label: `Set Symbol ${sym}`,
        hint: 'Populate analyzer and live input',
        run: () => {
          syncSymbols(sym);
          addRecentSymbol(sym);
        }
      }));
    return [...dynamicSymbols, ...base];
  }

  function closePalette() {
    const overlay = $('commandPalette');
    if (!overlay) return;
    overlay.style.display = 'none';
  }

  function executePaletteIndex(index) {
    const item = paletteItems[index];
    if (!item) return;
    closePalette();
    item.run();
  }

  function renderPalette(query) {
    const list = $('commandPaletteList');
    if (!list) return;
    const q = (query || '').trim().toLowerCase();
    paletteItems = getPaletteActions().filter((item) => !q || `${item.label} ${item.hint}`.toLowerCase().includes(q));
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
    list.innerHTML = paletteItems.length ? paletteItems.map((item, idx) => `
      <button type="button" data-palette-index="${idx}" style="width:100%;text-align:left;background:${idx === paletteIndex ? 'rgba(0,229,180,.10)' : 'transparent'};border:1px solid ${idx === paletteIndex ? 'rgba(0,229,180,.28)' : 'transparent'};border-radius:12px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;color:var(--text)">
        <div>
          <div style="font-size:13px;font-weight:600">${item.label}</div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:3px">${item.hint}</div>
        </div>
        <div style="font-family:var(--mono);font-size:10px;color:${idx === paletteIndex ? 'var(--accent)' : 'var(--text3)'}">${idx === paletteIndex ? 'Enter' : ''}</div>
      </button>
    `).join('') : '<div style="padding:14px;font-family:var(--mono);font-size:11px;color:var(--text3)">No matching actions.</div>';

    Array.from(list.querySelectorAll('button[data-palette-index]')).forEach((button) => {
      button.addEventListener('click', () => executePaletteIndex(parseInt(button.getAttribute('data-palette-index'), 10)));
    });
  }

  function openPalette() {
    const overlay = $('commandPalette');
    const input = $('commandPaletteInput');
    if (!overlay || !input) return;
    overlay.style.display = 'block';
    paletteIndex = 0;
    renderPalette('');
    setTimeout(() => input.focus(), 0);
  }

  function getDraft() {
    return parseJSON(STORAGE_KEYS.draft, {});
  }

  function saveDraft() {
    const draft = {
      sym: ($('sym') && $('sym').value) || '',
      liveSym: ($('liveSymInput') && $('liveSymInput').value) || '',
      tradeMode: currentMode(),
      slotTF: Array.isArray(window.slotTF) ? window.slotTF.slice(0, 3) : [],
      checklist: getChecklistState(),
      ts: Date.now()
    };
    saveJSON(STORAGE_KEYS.draft, draft);
  }

  function restoreDraft() {
    const draft = getDraft();
    if (!draft || !draft.ts) return;
    if ($('sym') && !$('sym').value && draft.sym) $('sym').value = draft.sym;
    if ($('liveSymInput') && !$('liveSymInput').value && draft.liveSym) $('liveSymInput').value = draft.liveSym;

    if (draft.tradeMode && draft.tradeMode !== currentMode()) {
      const mapping = {
        scalp: $('modeScalp'),
        dayTrade: $('modeDayTrade'),
        swing: $('modeSwing')
      };
      const btn = mapping[draft.tradeMode];
      if (btn && typeof window.setMode === 'function') window.setMode(draft.tradeMode, btn);
    }
    if (draft.checklist) setChecklistState(draft.checklist);
  }

  function installHooks() {
    const origSetMode = window.setMode;
    if (typeof origSetMode === 'function') {
      window.setMode = function patchedSetMode(mode, btn) {
        const result = origSetMode.apply(this, arguments);
        saveDraft();
        renderQuickSymbols();
        updateChecklistStatus();
        return result;
      };
    }

    const origAnalyzeLive = window.analyzeLive;
    if (typeof origAnalyzeLive === 'function') {
      window.analyzeLive = async function patchedAnalyzeLive() {
        const sym = currentSymbol();
        if (sym) addRecentSymbol(sym);
        saveDraft();
        return origAnalyzeLive.apply(this, arguments);
      };
    }

    const origRunAnalysis = window.runAnalysis;
    if (typeof origRunAnalysis === 'function') {
      window.runAnalysis = async function patchedRunAnalysis() {
        const sym = currentSymbol();
        if (sym) addRecentSymbol(sym);
        saveDraft();
        return origRunAnalysis.apply(this, arguments);
      };
    }

    const origShowResult = window.showResult;
    if (typeof origShowResult === 'function') {
      window.showResult = function patchedShowResult(data) {
        const result = origShowResult.apply(this, arguments);
        currentSignal = data || null;
        updateChecklistStatus(data || {});
        renderExecutionPlan(data || {});
        saveDraft();
        return result;
      };
    }
  }

  function bindInputs() {
    ['sym', 'liveSymInput'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', saveDraft);
      el.addEventListener('change', saveDraft);
    });
    const paletteInput = $('commandPaletteInput');
    if (paletteInput) {
      paletteInput.addEventListener('input', () => {
        paletteIndex = 0;
        renderPalette(paletteInput.value);
      });
      paletteInput.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          paletteIndex = Math.min(paletteIndex + 1, Math.max(0, paletteItems.length - 1));
          renderPalette(paletteInput.value);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          paletteIndex = Math.max(0, paletteIndex - 1);
          renderPalette(paletteInput.value);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          executePaletteIndex(paletteIndex);
        } else if (event.key === 'Escape') {
          closePalette();
        }
      });
    }
    document.addEventListener('keydown', (event) => {
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openPalette();
      } else if (!typing && event.key === '/') {
        event.preventDefault();
        openPalette();
      } else if (event.key === 'Escape' && $('commandPalette') && $('commandPalette').style.display === 'block') {
        closePalette();
      }
    });
    const overlay = $('commandPalette');
    if (overlay) {
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closePalette();
      });
    }
  }

  function init() {
    if (!$('page-analyzer')) return;
    restoreDraft();
    bindInputs();
    installHooks();
    renderQuickSymbols();
    renderChecklist();
    renderPlaybook();
    renderExecutionPlan(null);
    renderSavedPlans();
    updateChecklistStatus();
    saveDraft();
  }

  window.ntPremium = {
    pinCurrentSymbol,
    renderQuickSymbols,
    renderChecklist,
    renderPlaybook,
    renderExecutionPlan,
    scanWatchlist,
    saveSignalPlan,
    renderSavedPlans,
    saveDraft,
    restoreDraft,
    openPalette,
    closePalette
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
