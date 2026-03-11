      ageHours: +((now - (bot.positions.entries.get(tok.mintFull)?.ts || now)) / 3_600_000).toFixed(1),
    }));
    res.json({ total: bot.portfolio.length, dead: dead.length, deadTokens: dead, negCacheSize: _negCache.size });
  });

  app.post('/api/dead-tokens/purge', (req, res) => {
    const { mints: targeted, all = false, dryRun = false } = req.body || {};
    const now   = Date.now();
    const purge = all
      ? bot.portfolio.filter(t => { const f = _failCount.get(t.mintFull) || 0; const ageH = (now - (bot.positions.entries.get(t.mintFull)?.ts || now)) / 3_600_000; return (f >= 10 || (t.value < 0.01 && f >= 3)) && ageH > 12; }).map(t => t.mintFull)
      : (Array.isArray(targeted) ? targeted : []);
    if (!purge.length) return res.json({ success: true, purged: 0 });
    const done = [], skipped = [];
    for (const mint of purge) {
      const tok = bot.portfolio.find(t => t.mintFull === mint);
      if (tok?.value > 0.50) { skipped.push(mint.slice(0,8)); continue; }
      if (!dryRun) {
        for (const m of [bot.positions.entries, bot.positions.triggered, bot.positions.sold,
                         bot.positions.peak, bot.costBasis, priceCache]) m.delete(mint);
        bot.positions.slHit.delete(mint); bot.positions.slPending.delete(mint);
        _failCount.delete(mint); _negCache.delete(mint);
      }
      done.push(mint.slice(0,8));
    }
    if (!dryRun && done.length) bot.persist();
    res.json({ success: true, dryRun, purged: done.length, skipped: skipped.length });
  });

  app.post('/api/neg-cache/reset', (req, res) => {
    const { mint, all = false } = req.body || {};
    if (all) { const n = _negCache.size; _negCache.clear(); _failCount.clear(); return res.json({ success: true, cleared: n }); }
    if (!mint) return res.status(400).json({ error: 'mint ou all:true requis' });
    _negCache.delete(mint); _failCount.delete(mint);
    res.json({ success: true, mint });
  });

  app.post('/api/reset-circuit-breaker', (_, res) => {
    bot.swap.sellFailures = 0; bot.swap._cbTrippedAt = null;
    log('info', 'Circuit-breaker reset');
    res.json({ success: true });
  });

  app.get('/api/auto-buys', (_, res) => {
    const rows = [];
    for (const [mint, e] of bot.positions.entries) {
      const pd  = getPrice(mint);
      const pnl = bot.positions.getPnl(mint, pd?.price || 0);
      rows.push({
        mint, symbol: pd?.symbol || mint.slice(0,8),
        pnl: pnl !== null ? +pnl.toFixed(2) : null,
        pyramidDone: Array.from(bot.positions.pyramidDone.get(mint) || []),
        addedSol:    bot.positions.addedSol.get(mint) || 0,
        dcadDone:    bot.positions.dcadDone.get(mint) || 0,
      });
    }
    res.json({ pyramidEnabled: CFG.PYRAMID_ENABLED, dcadEnabled: CFG.DCAD_ENABLED, positions: rows });
  });

  app.get('/api/reentry', async (_, res) => {
    const rows = [];
    for (const mint of bot.positions.slHit) {
      const exitTs    = bot.positions.slExitTs.get(mint);
      const exitPrice = bot.positions.slExitPrice.get(mint);
      await prefetchPrices([mint]);
      const pd      = getPrice(mint);
      const price   = pd?.price || 0;
      const rebound = exitPrice && price > 0 ? ((price - exitPrice) / exitPrice) * 100 : null;
      const delayDone = exitTs ? (Date.now() - exitTs) >= CFG.REENTRY_DELAY_MIN * 60_000 : false;
      rows.push({ mint, symbol: pd?.symbol || mint.slice(0,8),
        exitTs: exitTs ? new Date(exitTs).toISOString() : null,
        exitPrice, currentPrice: price, reboundPct: rebound !== null ? +rebound.toFixed(2) : null,
        delayDone, score: bot.scorer.score(pd),
        eligible: delayDone && bot.scorer.score(pd) >= CFG.REENTRY_MIN_SCORE && rebound !== null && rebound >= CFG.REENTRY_MIN_GAIN,
      });
    }
    res.json({ reentryEnabled: CFG.REENTRY_ENABLED, stoppedTokens: rows });
  });

  app.post('/api/reentry/clear', (req, res) => {
    const { mint } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    bot.positions.clearReentryBlock(mint);
    res.json({ success: true, mint });
  });

  app.get('/api/smart-size/:score', (req, res) => {
    const score = parseFloat(req.params.score);
    if (isNaN(score)) return res.status(400).json({ error: 'score invalide' });
    res.json({ score, smartSizeEnabled: CFG.SMART_SIZE_ENABLED, solAmount: bot.calcSmartSize(score) });
  });

  app.get('/api/scanner/status',  (_, res) => res.json(scanner ? scanner.getStatus() : { enabled: false, running: false }));
  app.get('/api/scanner/seen',    (_, res) => res.json({ count: scanner?.seen.size || 0, mints: Array.from(scanner?.seen || []).slice(-100) }));

  app.post('/api/scanner/config', (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) CFG.SCANNER_ENABLED = !!b.enabled;
    const s = num(b.minScore, 0, 100); if (s !== null) CFG.SCANNER_MIN_SCORE = s;
    const l = num(b.minLiq, 0, 1e7);  if (l !== null) CFG.SCANNER_MIN_LIQ   = l;
    const x = num(b.maxLiq, 0, 1e8);  if (x !== null) CFG.SCANNER_MAX_LIQ   = x;
    const a = num(b.solAmount, 0.001, 10); if (a !== null) CFG.SCANNER_SOL_AMOUNT = a;
    if (scanner && b.enabled === true  && !scanner.running) scanner.start();
    if (scanner && b.enabled === false && scanner.running)  scanner.stop();
    res.json({ success: true });
  });

  app.post('/api/scanner/reset-seen', (_, res) => { if (scanner) scanner.seen.clear(); res.json({ success: true }); });

  app.get('/api/daily-loss', (_, res) => res.json({
    enabled: CFG.DAILY_LOSS_ENABLED, limit: CFG.DAILY_LOSS_LIMIT,
    today: bot.dailyLoss.date, realizedSol: +bot.dailyLoss.realizedSol.toFixed(6),
    paused: bot.dailyLoss.paused,
  }));
  app.post('/api/daily-loss/config', (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) CFG.DAILY_LOSS_ENABLED = !!b.enabled;
    const n = parseFloat(b.limit); if (!isNaN(n) && n <= 0 && n >= -100) CFG.DAILY_LOSS_LIMIT = n;
    res.json({ success: true });
  });
  app.post('/api/daily-loss/reset', (_, res) => {
    bot.dailyLoss.paused = false; bot.dailyLoss.realizedSol = 0; bot.dailyLoss.date = bot._today();
    log('info', 'Daily Loss reset'); res.json({ success: true });
  });

  app.get('/api/portfolio-history', (_, res) => {
    const h = bot.valueHistory;
    const v = h.map(x => x.valueSol).filter(x => x > 0);
    const first = v[0] || 0, last = v[v.length-1] || 0;
    res.json({ history: h, points: h.length, summary: {
      first: +first.toFixed(4), last: +last.toFixed(4),
      max: v.length ? +Math.max(...v).toFixed(4) : 0,
      min: v.length ? +Math.min(...v).toFixed(4) : 0,
      change: first > 0 ? +(((last - first) / first) * 100).toFixed(2) : 0,
    }});
  });

  app.get('/api/token-stats', (_, res) => {
    const byToken = {};
    for (const t of bot.history) {
      if (!t.mint) continue;
      if (!byToken[t.mint]) byToken[t.mint] = { mint: t.mint, symbol: t.symbol || t.mint.slice(0,8), buys: 0, sells: 0, totalSolIn: 0, totalSolOut: 0, pnlSol: 0, pnlPcts: [] };
      const e = byToken[t.mint];
      if (t.type === 'buy')  { e.buys++;  e.totalSolIn  += (t.solSpent || 0); }
      if (t.type === 'sell') { e.sells++; e.totalSolOut += (t.solOut || 0); if (t.pnlSol != null) e.pnlSol += t.pnlSol; if (t.pnlPct != null) e.pnlPcts.push(t.pnlPct); }
    }
    const rows = Object.values(byToken).map(e => ({
      mint: e.mint, symbol: e.symbol, buys: e.buys, sells: e.sells,
      totalSolIn: +e.totalSolIn.toFixed(6), totalSolOut: +e.totalSolOut.toFixed(6), pnlSol: +e.pnlSol.toFixed(6),
      avgPnlPct: e.pnlPcts.length ? +(e.pnlPcts.reduce((a,b)=>a+b,0)/e.pnlPcts.length).toFixed(2) : null,
    })).sort((a,b) => b.pnlSol - a.pnlSol);
    res.json({ tokens: rows, summary: { totalRealizedSol: +rows.reduce((s,r)=>s+r.pnlSol,0).toFixed(6), uniqueTokens: rows.length }});
  });

  app.use((_, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(CFG.PORT, '0.0.0.0', () => log('info', `API démarrée sur :${CFG.PORT}`, { version: VERSION }));
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// §16  MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log('info', `SolBot v${VERSION} — Démarrage`, { env: CFG.NODE_ENV });

  const wallet  = loadWallet();
  const rpc     = createRpc();
  const state   = loadState();
  const bot     = new BotLoop(wallet, rpc, state);
  const scanner = new TokenScanner(bot);
  if (CFG.SCANNER_ENABLED) scanner.start();

  log('info', 'Vérification réseau avant premier tick...');
  let networkReady = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await fetch('https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50', { signal: AbortSignal.timeout(5000) });
      if (r.ok || r.status === 400) { networkReady = true; log('info', `Réseau OK (tentative ${attempt})`); break; }
    } catch {}
    log('warn', `Réseau non prêt (tentative ${attempt}/6) — attente 5s...`);
    await sleep(5000);
  }
  if (!networkReady) log('warn', 'Jupiter inaccessible — démarrage quand même');

  await bot.tick();
  setInterval(() => bot.tick().catch(err => log('error', 'Loop error', { err: err.message })), CFG.INTERVAL_SEC * 1000);
  startApi(bot, wallet, scanner);

  log('success', 'Bot opérationnel', {
    address:  wallet.publicKey.toString().slice(0, 8) + '...',
    interval: CFG.INTERVAL_SEC + 's',
    scanner:  CFG.SCANNER_ENABLED ? `ON (delay:${CFG.SCANNER_DELAY_MS/1000}s)` : 'OFF',
  });

  const exit = () => { bot.persist(); log('info', 'Arrêt propre'); process.exit(0); };
  process.on('SIGINT',  exit);
  process.on('SIGTERM', exit);
  process.on('uncaughtException',  err => log('error', 'Exception non catchée', { err: err.message }));
  process.on('unhandledRejection', r   => log('error', 'Rejection non gérée',   { reason: String(r).slice(0, 300) }));
}

main().catch(err => { console.error('Démarrage échoué:', err.message); process.exit(1); });
