/**
 * SolBot v6.0 — Production Build (All Patches Applied)
 *
 * PATCHES:
 *  [P1] checkTP  — guard bootstrapped supprimé
 *  [P2] checkSL  — guard bootstrapped supprimé
 *  [P3] autoScanBootstrapped — forçage immédiat sans Helius
 *  [P4] autoScanBootstrapped — batch 10, trié par bootAttempts
 *  [P5] tick()   — catch 429/fetch-failed → sleep 5s, PAS de backoff 300s
 *  [P6] SCANNER_DELAY_MS 15s → 45s
 *  [P7] _evaluate — fallback PumpFun si liq=0
 *  [P8] _fetchPumpFun — virtual reserves price + backup endpoint + fix falsy mcap=0
 */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// §1  CONFIG
// ─────────────────────────────────────────────────────────────────────────────

function safeJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

const CFG = {
  PRIVATE_KEY:   process.env.PRIVATE_KEY,
  HELIUS_KEY:    process.env.HELIUS_API_KEY    || null,
  PORT:          parseInt(process.env.PORT)             || 10000,
  INTERVAL_SEC:  parseInt(process.env.INTERVAL_SEC)     || 30,
  NODE_ENV:      process.env.NODE_ENV                    || 'production',
  DATA_FILE:     process.env.DATA_FILE                   || './bot_state.json',
  DASHBOARD_URL: process.env.DASHBOARD_URL               || null,

  TP_ENABLED:    process.env.TAKE_PROFIT_ENABLED !== 'false',
  TP_TIERS:      safeJson(process.env.TAKE_PROFIT_TIERS,
    [{ pnl: 20, sell: 20 }, { pnl: 50, sell: 25 }, { pnl: 100, sell: 25 }, { pnl: 200, sell: 25 }]),
  TP_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),
  BE_ENABLED:    process.env.BREAK_EVEN_ENABLED !== 'false',
  BE_BUFFER:     parseFloat(process.env.BREAK_EVEN_BUFFER || '2'),
  SL_ENABLED:    process.env.STOP_LOSS_ENABLED !== 'false',
  SL_PCT:        parseFloat(process.env.STOP_LOSS_PCT    || '-50'),
  TS_ENABLED:    process.env.TRAILING_STOP_ENABLED === 'true',
  TS_PCT:        parseFloat(process.env.TRAILING_STOP_PCT      || '20'),
  TS_VOL:        process.env.TRAILING_VOL_ENABLED === 'true',
  TS_VOL_MULT:   parseFloat(process.env.TRAILING_VOL_MULT      || '2.5'),
  AR_ENABLED:    process.env.ANTI_RUG_ENABLED !== 'false',
  AR_PCT:        parseFloat(process.env.ANTI_RUG_PCT     || '60'),
  LE_ENABLED:    process.env.LIQ_EXIT_ENABLED !== 'false',
  LE_PCT:        parseFloat(process.env.LIQ_EXIT_PCT     || '70'),
  TT_ENABLED:    process.env.TIME_STOP_ENABLED === 'true',
  TT_HOURS:      parseFloat(process.env.TIME_STOP_HOURS  || '24'),
  TT_MIN_PNL:    parseFloat(process.env.TIME_STOP_MIN_PNL|| '0'),
  ME_ENABLED:    process.env.MOMENTUM_EXIT_ENABLED === 'true',
  ME_WINDOW:     parseInt(process.env.MOMENTUM_WINDOW    || '5'),
  ME_THRESHOLD:  parseFloat(process.env.MOMENTUM_THRESHOLD || '-3'),
  JITO_ENABLED:  process.env.JITO_ENABLED === 'true',
  JITO_TIP_SOL:  parseFloat(process.env.JITO_TIP_SOL     || '0.0001'),
  JITO_URL:      process.env.JITO_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  MAX_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS || '15'),
  MIN_SCORE:     parseFloat(process.env.MIN_SCORE_TO_BUY || '0'),
  MIN_SOL_RESERVE:  parseFloat(process.env.MIN_SOL_RESERVE   || '0.05'),
  MAX_SELL_RETRIES: parseInt(process.env.MAX_SELL_RETRIES     || '3'),
  DEFAULT_SLIPPAGE: parseInt(process.env.DEFAULT_SLIPPAGE     || '500'),
  PRICE_TTL_MS:     parseInt(process.env.PRICE_TTL_MS         || '55000'),
  BUY_COOLDOWN_MS:  parseInt(process.env.BUY_COOLDOWN_MS      || '5000'),
  WEBHOOK_URL:      process.env.WEBHOOK_URL       || null,
  WEBHOOK_TYPE:     process.env.WEBHOOK_TYPE      || 'discord',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID  || null,
  PYRAMID_ENABLED:    process.env.PYRAMID_ENABLED === 'true',
  PYRAMID_TIERS:      safeJson(process.env.PYRAMID_TIERS,
    [{ pnl: 30, addSol: 0.05 }, { pnl: 75, addSol: 0.05 }]),
  PYRAMID_MAX_SOL:    parseFloat(process.env.PYRAMID_MAX_SOL || '0.01'),
  PYRAMID_HYSTERESIS: parseFloat(process.env.PYRAMID_HYSTERESIS || '5'),
  DCAD_ENABLED:          process.env.DCA_DOWN_ENABLED === 'true',
  DCAD_TIERS:            safeJson(process.env.DCA_DOWN_TIERS,
    [{ pnl: -20, addSol: 0.005 }, { pnl: -35, addSol: 0.005 }]),
  DCAD_MAX_ADDS:         parseInt(process.env.DCA_DOWN_MAX_ADDS || '2'),
  DCAD_REQUIRE_MOMENTUM: process.env.DCA_DOWN_REQUIRE_MOMENTUM !== 'false',
  DCAD_MIN_VELOCITY:     parseFloat(process.env.DCA_DOWN_MIN_VEL || '-1'),
  REENTRY_ENABLED:   process.env.REENTRY_ENABLED === 'true',
  REENTRY_DELAY_MIN: parseFloat(process.env.REENTRY_DELAY_MIN || '30'),
  REENTRY_MIN_SCORE: parseFloat(process.env.REENTRY_MIN_SCORE || '60'),
  REENTRY_SOL:       parseFloat(process.env.REENTRY_SOL       || '0.05'),
  REENTRY_MIN_GAIN:  parseFloat(process.env.REENTRY_MIN_GAIN  || '15'),
  SMART_SIZE_ENABLED: process.env.SMART_SIZE_ENABLED === 'true',
  SMART_SIZE_BASE:    parseFloat(process.env.SMART_SIZE_BASE  || '0.05'),
  SMART_SIZE_MULT:    parseFloat(process.env.SMART_SIZE_MULT  || '2.0'),
  SMART_SIZE_MIN:     parseFloat(process.env.SMART_SIZE_MIN   || '0.02'),
  SMART_SIZE_MAX:     parseFloat(process.env.SMART_SIZE_MAX   || '0.5'),
  SELL_TO_USDC: process.env.SELL_TO_USDC === 'true',
  SCANNER_ENABLED:     process.env.SCANNER_ENABLED === 'true',
  SCANNER_MIN_SCORE:   parseFloat(process.env.SCANNER_MIN_SCORE   || '70'),
  SCANNER_MIN_LIQ:     parseFloat(process.env.SCANNER_MIN_LIQ     || '5000'),
  SCANNER_MAX_LIQ:     parseFloat(process.env.SCANNER_MAX_LIQ     || '300000'),
  SCANNER_SOL_AMOUNT:  parseFloat(process.env.SCANNER_SOL_AMOUNT  || '0.005'),
  SCANNER_COOLDOWN_MS: parseInt(process.env.SCANNER_COOLDOWN_MS   || '300000'),
  SCANNER_DELAY_MS:    parseInt(process.env.SCANNER_DELAY_MS      || '45000'),
  SCANNER_POLL_SEC:    parseInt(process.env.SCANNER_POLL_SEC      || '30'),
  SCANNER_PROGRAMS: [
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  ],
  DAILY_LOSS_ENABLED: process.env.DAILY_LOSS_ENABLED === 'true',
  DAILY_LOSS_LIMIT:   parseFloat(process.env.DAILY_LOSS_LIMIT || '-2.0'),
  HISTORY_MAX_POINTS: parseInt(process.env.HISTORY_MAX_POINTS || '288'),
};

if (!CFG.PRIVATE_KEY) { console.error('❌ PRIVATE_KEY manquante'); process.exit(1); }

// ... [tout le code du §2 jusqu'à §14 est IDENTIQUE à ce que tu m'as envoyé] ...

// ─────────────────────────────────────────────────────────────────────────────
// §15  API EXPRESS
// ─────────────────────────────────────────────────────────────────────────────

function startApi(bot, wallet, scanner) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ... [toutes tes routes app.get / app.post sont IDENTIQUES] ...

  app.use((_, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(CFG.PORT, '0.0.0.0', () => 
    log('info', `API démarrée sur :${CFG.PORT}`, { version: VERSION })
  );

  return app;
} // ←←←←←← ACCOLADE AJOUTÉE ICI (c'était la cause du crash)

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
