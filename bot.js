/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                     SolBot v6.0 — Production Build                     ║
 * ║              Réécriture complète depuis zéro — Mars 2026               ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Architecture modulaire en 14 sections :                                ║
 * ║   1  CONFIG           — Toutes les vars d'environnement + défauts       ║
 * ║   2  DEPS             — Imports et constantes globales                  ║
 * ║   3  UTILS            — Logger, sleep, retry, pLimit, Mutex, stddev     ║
 * ║   4  WEBHOOK          — Discord / Telegram / generic                    ║
 * ║   5  WALLET & RPC     — Chargement clé, failover 3 endpoints           ║
 * ║   6  PERSISTANCE      — Sauvegarde/restauration état JSON               ║
 * ║   7  PRICE ENGINE     — DexScreener→PumpFun→Birdeye                    ║
 * ║                          + Negative Cache (tokens morts)               ║
 * ║                          + Liquidity History                           ║
 * ║   8  SCORE ENGINE     — Score 0-100 qualité token                      ║
 * ║   9  MOMENTUM         — Tendance, vélocité, volatilité σ               ║
 * ║  10  POSITIONS        — TP/SL/Break-even/Trailing/AR/LiqExit/          ║
 * ║                          TimeStop/MomentumExit                         ║
 * ║  11  SWAP ENGINE      — Jupiter lite/api/quote + Jito bundles          ║
 * ║  12  ANALYTICS        — Sharpe, Sortino, MaxDD, heatmap horaire        ║
 * ║  13  BOT LOOP         — Tick principal, sell helper centralisé         ║
 * ║  14  API              — 35 routes Express organisées par domaine       ║
 * ║  15  MAIN             — Bootstrap + graceful shutdown                  ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Correctifs hérités v3.x :                                              ║
 * ║   [v3]    _executeSellAction() — helper unique, zéro duplication       ║
 * ║   [v3]    checkTP guard stopLossHit — circuit-breaker v2.2.1           ║
 * ║   [v3]    TP/SL/AR défaut ON — opt-out via =false                      ║
 * ║   [v3]    Prix entrée = prix réel swap (pas prix marché tardif)        ║
 * ║   [v3]    DCA prix moyen pondéré                                        ║
 * ║   [v3]    Retry quote refetch (expire ~60s)                            ║
 * ║   [v3]    stopLossHit persisté → pas de double-vente après restart     ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Nouveautés v6.0 (sur base v5.0) :                                      ║
 * ║   SCANNER  TokenScanner — détecte nouveaux tokens PumpFun+Raydium      ║
 * ║             via Helius WebSocket, score + achat automatique            ║
 * ║   RISQUE   Daily Loss Limit — pause bot si pertes/jour > seuil         ║
 * ║             Reset automatique minuit UTC                               ║
 * ║   STATS    Portfolio Value History — courbe valeur totale              ║
 * ║             Stats par token : meilleur/pire/durée holding              ║
 * ║             API /api/portfolio-history, /api/scanner/status            ║
 * ║             /api/scanner/seen, /api/daily-loss                         ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Nouveautés v5.0 (sur base v4.0) :                                      ║
 * ║   ENTRÉE  Pyramid In  — rachète sur montée (paliers configurables)      ║
 * ║           DCA-Down    — moyenne à la baisse (momentum-gated)            ║
 * ║           Re-entry    — rachat auto après SL (délai + score + rebond)   ║
 * ║           Smart Sizing — SOL auto calculé par score 0-100               ║
 * ║   API     /api/auto-buys  — état pyramid/DCA par position               ║
 * ║           /api/reentry    — tokens stoppés + éligibilité re-entry       ║
 * ║           /api/smart-size/:score — aperçu taille avant achat            ║
 * ║  Nouveautés v4.0 :                                                      ║
 * ║   PRIX    Negative cache progressif (3→5m / 6→30m / 10→6h)            ║
 * ║           PRICE_TTL_MS 55s (> 1.8×INTERVAL) — zéro re-fetch inutile   ║
 * ║           Dead token detection + purge API                             ║
 * ║   SORTIE  Break-even stop (SL → entry+buffer après TP1)                ║
 * ║           Liquidity exit (chute liquidité X%/cycle)                    ║
 * ║           Time-based stop (stagnation > N heures)                      ║
 * ║           Momentum exit (retournement tendance confirmé)               ║
 * ║           Trailing adaptatif volatilité σ                               ║
 * ║   ENTRÉE  Score engine min avant achat                                  ║
 * ║           Max positions ouvertes simultanées                           ║
 * ║   EXEC    Jito bundles (sells urgents anti-MEV)                        ║
 * ║           Priority fee adaptatif (auto/med/high/turbo)                 ║
 * ║           Slippage dynamique selon liquidité + urgence                 ║
 * ║   DATA    Sharpe ratio, Sortino ratio, Max Drawdown                    ║
 * ║           Heatmap horaire, streaks, profit factor                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// §1  CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

function safeJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

const CFG = {
  // ── Réseau & runtime ──────────────────────────────────────────────────────
  PRIVATE_KEY:   process.env.PRIVATE_KEY,
  HELIUS_KEY:    process.env.HELIUS_API_KEY    || null,
  PORT:          parseInt(process.env.PORT)             || 10000,
  INTERVAL_SEC:  parseInt(process.env.INTERVAL_SEC)     || 30,
  NODE_ENV:      process.env.NODE_ENV                    || 'production',
  DATA_FILE:     process.env.DATA_FILE                   || './bot_state.json',
  DASHBOARD_URL: process.env.DASHBOARD_URL               || null,

  // ── Take-profit paliers (défaut ON) ───────────────────────────────────────
  TP_ENABLED:    process.env.TAKE_PROFIT_ENABLED !== 'false',
  TP_TIERS:      safeJson(process.env.TAKE_PROFIT_TIERS,
    [{ pnl: 20, sell: 20 }, { pnl: 50, sell: 25 }, { pnl: 100, sell: 25 }, { pnl: 200, sell: 25 }]),
  TP_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),

  // ── Break-even stop : SL → entry+buffer après TP1 ────────────────────────
  BE_ENABLED:    process.env.BREAK_EVEN_ENABLED !== 'false',
  BE_BUFFER:     parseFloat(process.env.BREAK_EVEN_BUFFER || '2'),  // +2% au-dessus entry

  // ── Stop-Loss fixe (défaut ON) ────────────────────────────────────────────
  SL_ENABLED:    process.env.STOP_LOSS_ENABLED !== 'false',
  SL_PCT:        parseFloat(process.env.STOP_LOSS_PCT    || '-50'),

  // ── Trailing stop (défaut OFF — opt-in) ───────────────────────────────────
  TS_ENABLED:    process.env.TRAILING_STOP_ENABLED === 'true',
  TS_PCT:        parseFloat(process.env.TRAILING_STOP_PCT      || '20'),
  TS_VOL:        process.env.TRAILING_VOL_ENABLED === 'true',   // adaptatif σ
  TS_VOL_MULT:   parseFloat(process.env.TRAILING_VOL_MULT      || '2.5'),

  // ── Anti-rug prix (défaut ON) ─────────────────────────────────────────────
  AR_ENABLED:    process.env.ANTI_RUG_ENABLED !== 'false',
  AR_PCT:        parseFloat(process.env.ANTI_RUG_PCT     || '60'),

  // ── Liquidity exit (défaut ON) ────────────────────────────────────────────
  LE_ENABLED:    process.env.LIQ_EXIT_ENABLED !== 'false',
  LE_PCT:        parseFloat(process.env.LIQ_EXIT_PCT     || '70'),

  // ── Time-based stop (défaut OFF) ─────────────────────────────────────────
  TT_ENABLED:    process.env.TIME_STOP_ENABLED === 'true',
  TT_HOURS:      parseFloat(process.env.TIME_STOP_HOURS  || '24'),
  TT_MIN_PNL:    parseFloat(process.env.TIME_STOP_MIN_PNL|| '0'),   // exit si PnL < X%

  // ── Momentum exit (défaut OFF) ────────────────────────────────────────────
  ME_ENABLED:    process.env.MOMENTUM_EXIT_ENABLED === 'true',
  ME_WINDOW:     parseInt(process.env.MOMENTUM_WINDOW    || '5'),   // cycles
  ME_THRESHOLD:  parseFloat(process.env.MOMENTUM_THRESHOLD || '-3'), // %/cycle

  // ── Jito bundles (défaut OFF) ─────────────────────────────────────────────
  JITO_ENABLED:  process.env.JITO_ENABLED === 'true',
  JITO_TIP_SOL:  parseFloat(process.env.JITO_TIP_SOL     || '0.0001'),
  JITO_URL:      process.env.JITO_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',

  // ── Position sizing & risque ──────────────────────────────────────────────
  MAX_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS || '10'),
  MIN_SCORE:     parseFloat(process.env.MIN_SCORE_TO_BUY || '0'),   // 0 = désactivé

  // ── Exécution ─────────────────────────────────────────────────────────────
  MIN_SOL_RESERVE:  parseFloat(process.env.MIN_SOL_RESERVE   || '0.05'),
  MAX_SELL_RETRIES: parseInt(process.env.MAX_SELL_RETRIES     || '3'),
  DEFAULT_SLIPPAGE: parseInt(process.env.DEFAULT_SLIPPAGE     || '500'),
  PRICE_TTL_MS:     parseInt(process.env.PRICE_TTL_MS         || '55000'), // > 1.8 × INTERVAL_SEC
  BUY_COOLDOWN_MS:  parseInt(process.env.BUY_COOLDOWN_MS      || '5000'),

  // ── Webhook ────────────────────────────────────────────────────────────────
  WEBHOOK_URL:      process.env.WEBHOOK_URL       || null,
  WEBHOOK_TYPE:     process.env.WEBHOOK_TYPE      || 'discord',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID  || null,

  // ── §NEW  Pyramid In (add on rise) ────────────────────────────────────────
  PYRAMID_ENABLED:    process.env.PYRAMID_ENABLED === 'true',
  PYRAMID_TIERS:      safeJson(process.env.PYRAMID_TIERS,
    [{ pnl: 30, addSol: 0.05 }, { pnl: 75, addSol: 0.05 }]),
  PYRAMID_MAX_SOL:    parseFloat(process.env.PYRAMID_MAX_SOL || '0.5'),
  PYRAMID_HYSTERESIS: parseFloat(process.env.PYRAMID_HYSTERESIS || '5'),

  // ── §NEW  DCA-Down (moyenne à la baisse) ──────────────────────────────────
  DCAD_ENABLED:          process.env.DCA_DOWN_ENABLED === 'true',
  DCAD_TIERS:            safeJson(process.env.DCA_DOWN_TIERS,
    [{ pnl: -20, addSol: 0.05 }, { pnl: -35, addSol: 0.05 }]),
  DCAD_MAX_ADDS:         parseInt(process.env.DCA_DOWN_MAX_ADDS || '2'),
  DCAD_REQUIRE_MOMENTUM: process.env.DCA_DOWN_REQUIRE_MOMENTUM !== 'false',
  DCAD_MIN_VELOCITY:     parseFloat(process.env.DCA_DOWN_MIN_VEL || '-1'),

  // ── §NEW  Re-entry après SL ───────────────────────────────────────────────
  REENTRY_ENABLED:   process.env.REENTRY_ENABLED === 'true',
  REENTRY_DELAY_MIN: parseFloat(process.env.REENTRY_DELAY_MIN || '30'),
  REENTRY_MIN_SCORE: parseFloat(process.env.REENTRY_MIN_SCORE || '60'),
  REENTRY_SOL:       parseFloat(process.env.REENTRY_SOL       || '0.05'),
  REENTRY_MIN_GAIN:  parseFloat(process.env.REENTRY_MIN_GAIN  || '15'),

  // ── §NEW  Smart Sizing ────────────────────────────────────────────────────
  SMART_SIZE_ENABLED: process.env.SMART_SIZE_ENABLED === 'true',
  SMART_SIZE_BASE:    parseFloat(process.env.SMART_SIZE_BASE  || '0.05'),
  SMART_SIZE_MULT:    parseFloat(process.env.SMART_SIZE_MULT  || '2.0'),
  SMART_SIZE_MIN:     parseFloat(process.env.SMART_SIZE_MIN   || '0.02'),
  SMART_SIZE_MAX:     parseFloat(process.env.SMART_SIZE_MAX   || '0.5'),

  // ── §NEW  Sortie USDC (sell → USDC au lieu de SOL) ────────────────────────
  // Mettre SELL_TO_USDC=true dans les env vars Render pour activer
  SELL_TO_USDC: process.env.SELL_TO_USDC === 'true',

  // ── §v6  Token Scanner — détection automatique nouveaux tokens ────────────
  SCANNER_ENABLED:     process.env.SCANNER_ENABLED === 'true',
  SCANNER_MIN_SCORE:   parseFloat(process.env.SCANNER_MIN_SCORE   || '60'),
  SCANNER_MIN_LIQ:     parseFloat(process.env.SCANNER_MIN_LIQ     || '5000'),   // $ liquidité minimum
  SCANNER_MAX_LIQ:     parseFloat(process.env.SCANNER_MAX_LIQ     || '500000'), // $ liquidité maximum
  SCANNER_SOL_AMOUNT:  parseFloat(process.env.SCANNER_SOL_AMOUNT  || '0.05'),   // SOL par achat scanner
  SCANNER_COOLDOWN_MS: parseInt(process.env.SCANNER_COOLDOWN_MS   || '300000'), // 5 min cooldown par mint
  SCANNER_DELAY_MS:    parseInt(process.env.SCANNER_DELAY_MS      || '15000'),  // délai avant éval (laisser DexScreener indexer)
  SCANNER_POLL_SEC:    parseInt(process.env.SCANNER_POLL_SEC      || '30'),     // fréquence polling DexScreener
  SCANNER_PROGRAMS: [
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // PumpFun
  ],

  // ── §v6  Daily Loss Limit ─────────────────────────────────────────────────
  DAILY_LOSS_ENABLED: process.env.DAILY_LOSS_ENABLED === 'true',
  DAILY_LOSS_LIMIT:   parseFloat(process.env.DAILY_LOSS_LIMIT || '-2.0'), // SOL/jour (négatif)

  // ── §v6  Portfolio History ────────────────────────────────────────────────
  HISTORY_MAX_POINTS: parseInt(process.env.HISTORY_MAX_POINTS || '288'), // 24h à 5min
};

if (!CFG.PRIVATE_KEY) { console.error('❌ PRIVATE_KEY manquante'); process.exit(1); }

// ═══════════════════════════════════════════════════════════════════════════════
// §2  DÉPENDANCES & CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════════

const {
  Connection, Keypair, PublicKey, VersionedTransaction,
  TransactionMessage, SystemProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58    = require('bs58');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const fetch   = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const SOL_MINT   = 'So11111111111111111111111111111111111111112';
const USDC_MINT  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SPL_TOKEN  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_2022   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const JITO_TIP_WALLET = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
const VERSION    = '6.0.0';

// ═══════════════════════════════════════════════════════════════════════════════
// §3  UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Logger ────────────────────────────────────────────────────────────────────
const ICONS = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', debug: '🔍', success: '✅' };

function log(level, msg, data = null) {
  const safe = String(msg)
    .replace(/PRIVATE_KEY[=:]\S+/gi, 'PRIVATE_KEY=[REDACTED]')
    .replace(/api-key=[^&\s]+/gi,    'api-key=[REDACTED]');
  const sfx = data ? ' ' + JSON.stringify(data).slice(0, 500) : '';
  console.log(`${ICONS[level] ?? 'ℹ️ '} [${new Date().toISOString()}] ${safe}${sfx}`);
}

// ── Async helpers ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { tries = 3, baseMs = 600, label = '' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); }
    catch (err) {
      last = err;
      if (i < tries - 1) {
        // 429 → backoff beaucoup plus long
        const is429 = err.message?.includes('429') || err.message?.includes('Too Many Requests');
        const w = is429 ? Math.max(baseMs * 2 ** i, 3000) : baseMs * 2 ** i;
        if (is429) log('warn', `${label} rate-limited (429) — attente ${w}ms`);
        else       log('warn', `${label} retry ${i + 1}/${tries - 1} in ${w}ms — ${err.message}`);
        await sleep(w);
      }
    }
  }
  throw last;
}

function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const run = () => {
    while (active < concurrency && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => { active--; run(); });
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); run(); });
}

class Mutex {
  constructor() { this._chain = Promise.resolve(); }
  lock() {
    let release;
    const next = this._chain.then(() => release);
    this._chain = new Promise(r => { release = r; });
    return next;
  }
}

// ── Statistiques ──────────────────────────────────────────────────────────────
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// ═══════════════════════════════════════════════════════════════════════════════
// §4  WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════════

async function webhook(title, desc, color = 0x3b7eff, fields = []) {
  if (!CFG.WEBHOOK_URL) return;
  try {
    let body;
    if (CFG.WEBHOOK_TYPE === 'discord') {
      body = JSON.stringify({ embeds: [{ title, description: desc, color, fields,
        footer: { text: `SolBot v${VERSION}` }, timestamp: new Date().toISOString() }] });
    } else if (CFG.WEBHOOK_TYPE === 'telegram') {
      const text = `*${title}*\n${desc}` +
        (fields.length ? '\n' + fields.map(f => `• ${f.name}: ${f.value}`).join('\n') : '');
      body = JSON.stringify({ chat_id: CFG.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' });
    } else {
      body = JSON.stringify({ title, description: desc, fields, ts: Date.now() });
    }
    await fetch(CFG.WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(8000),
    });
  } catch (err) { log('warn', 'Webhook failed', { err: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §5  WALLET & RPC
// ═══════════════════════════════════════════════════════════════════════════════

function loadWallet() {
  try {
    const raw = CFG.PRIVATE_KEY.startsWith('[')
      ? Uint8Array.from(JSON.parse(CFG.PRIVATE_KEY))
      : bs58.decode(CFG.PRIVATE_KEY);
    const kp = Keypair.fromSecretKey(raw);
    log('info', 'Wallet chargé', { address: kp.publicKey.toBase58().slice(0, 8) + '…' });
    return kp;
  } catch (err) {
    log('error', 'Clé invalide', { err: err.message }); process.exit(1);
  }
}

function createRpc() {
  const eps = [
    CFG.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_KEY}` : null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.public.blastapi.io',
  ].filter(Boolean);

  const conns = eps.map(e => new Connection(e, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: false,
    confirmTransactionInitialTimeout: 60000,
    httpHeaders: { 'Content-Type': 'application/json' },
  }));
  let idx = 0;

  return {
    get conn() { return conns[idx]; },
    get endpoint() { return eps[idx]; },

    async healthCheck() {
      for (let i = 0; i < conns.length; i++) {
        try {
          const slot = await conns[i].getSlot();
          if (slot > 0) { idx = i; log('debug', 'RPC OK', { slot, ep: i }); return true; }
        } catch { log('warn', 'RPC down', { ep: eps[i].slice(0, 45) }); }
      }
      log('error', 'Tous les endpoints RPC hors ligne'); return false;
    },

    failover() {
      idx = (idx + 1) % conns.length;
      log('warn', 'RPC failover', { ep: eps[idx].slice(0, 45) });
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// §6  PERSISTANCE
// ═══════════════════════════════════════════════════════════════════════════════

function loadState() {
  try {
    if (fs.existsSync(CFG.DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CFG.DATA_FILE, 'utf8'));
      log('info', 'État restauré', {
        positions: Object.keys(raw.entryPrices || {}).length,
        trades:    (raw.trades || []).length,
      });
      return raw;
    }
  } catch (err) { log('warn', 'Chargement état échoué — démarrage propre', { err: err.message }); }
  return { entryPrices: {}, trades: [], stopLossHit: [], slPending: [], breakEven: [] };
}

function saveState(data) {
  try { fs.writeFileSync(CFG.DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch (err) { log('warn', 'Sauvegarde état échouée', { err: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §7  PRICE ENGINE
//     Cascade : DexScreener batch → DexScreener single → Pump.fun → Birdeye
//     Negative Cache : tokens introuvables ignorés de façon progressive
//     Liquidity History : suivi chute liquidité pour liquidity exit
// ═══════════════════════════════════════════════════════════════════════════════

// ── Caches globaux ────────────────────────────────────────────────────────────
const priceCache    = new Map(); // mint → { data: PriceData, ts: number }
const decimalsCache = new Map(); // mint → number
const liqHistory    = new Map(); // mint → Array<{ ts, liq }>

// ── Negative cache — tokens morts ignorés progressivement ────────────────────
const _failCount = new Map(); // mint → échecs consécutifs
const _negCache  = new Map(); // mint → { until: number, failures: number }

function _negTTL(n) {
  if (n >= 10) return 6 * 3_600_000;  // 6 heures
  if (n >= 6)  return 30 *   60_000;  // 30 minutes
  if (n >= 3)  return 5  *   60_000;  // 5 minutes
  return 0;
}

function isNegCached(mint) {
  const nc = _negCache.get(mint);
  if (!nc) return false;
  if (Date.now() < nc.until) return true;
  _negCache.delete(mint); return false;
}

function recordPriceFail(mint) {
  const n = (_failCount.get(mint) || 0) + 1;
  _failCount.set(mint, n);
  const ttl = _negTTL(n);
  if (ttl > 0) {
    _negCache.set(mint, { until: Date.now() + ttl, failures: n });
    if (n === 3 || n === 6 || n === 10) {
      const m = ttl / 60_000;
      log('warn', `Neg-cache: ${mint.slice(0, 8)}… (${n} échecs → ${m < 60 ? m + 'min' : (m / 60).toFixed(0) + 'h'})`);
    }
  }
}

function recordPriceSuccess(mint) {
  _failCount.delete(mint);
  _negCache.delete(mint);
}

// ── Suivi historique liquidité ────────────────────────────────────────────────
function trackLiq(mint, liq) {
  if (!(liq > 0)) return;
  const h = liqHistory.get(mint) || [];
  h.push({ ts: Date.now(), liq });
  if (h.length > 30) h.shift();
  liqHistory.set(mint, h);
}

function getLiqDrop(mint) {
  const h = liqHistory.get(mint);
  if (!h || h.length < 3) return 0;
  const oldest = h[0].liq;
  const latest = h[h.length - 1].liq;
  return oldest > 0 ? Math.max(0, ((oldest - latest) / oldest) * 100) : 0;
}

// ── Decimals cache ────────────────────────────────────────────────────────────
async function getDecimals(mint, conn) {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const dec  = info?.value?.data?.parsed?.info?.decimals;
    if (typeof dec === 'number') { decimalsCache.set(mint, dec); return dec; }
  } catch { /* use fallback */ }
  decimalsCache.set(mint, 6); return 6;
}

// ── Fetchers individuels ──────────────────────────────────────────────────────

/** Batch DexScreener — jusqu'à 30 mints par requête */
async function _fetchDexBatch(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!r.ok) { await sleep(600); continue; }
      const d = await r.json();
      for (const p of (d?.pairs || []).filter(p => p.chainId === 'solana')) {
        const mint = p.baseToken?.address;
        if (!mint || !p.priceUsd) continue;
        const liq = p.liquidity?.usd || 0;
        if (!out[mint] || liq > (out[mint].liquidity || 0)) {
          out[mint] = {
            price:     parseFloat(p.priceUsd),
            liquidity: liq,
            volume24h: p.volume?.h24     || 0,
            volume6h:  p.volume?.h6      || 0,
            volume1h:  p.volume?.h1      || 0,
            change24h: p.priceChange?.h24 || 0,
            change6h:  p.priceChange?.h6  || 0,
            change1h:  p.priceChange?.h1  || 0,
            fdv:       p.fdv             || 0,
            mcap:      p.marketCap       || 0,
            buys24h:   p.txns?.h24?.buys  || 0,
            sells24h:  p.txns?.h24?.sells || 0,
            txns24h:  (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
            logo:      p.info?.imageUrl   || null,
            symbol:    p.baseToken?.symbol || null,
            name:      p.baseToken?.name   || null,
            pairAddr:  p.pairAddress       || null,
            dex:       p.dexId             || null,
            createdAt: p.pairCreatedAt     || null,
            source:    'dex-batch',
          };
        }
      }
    } catch { /* skip chunk */ }
    if (i + 30 < mints.length) await sleep(350);
  }
  return out;
}

async function _fetchDexSingle(mint) {
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!r.ok) return null;
    const d    = await r.json();
    const best = (d?.pairs || [])
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!best?.priceUsd) return null;
    return {
      price:     parseFloat(best.priceUsd),
      liquidity: best.liquidity?.usd    || 0,
      volume24h: best.volume?.h24       || 0,
      volume6h:  best.volume?.h6        || 0,
      volume1h:  best.volume?.h1        || 0,
      change24h: best.priceChange?.h24  || 0,
      change6h:  best.priceChange?.h6   || 0,
      change1h:  best.priceChange?.h1   || 0,
      fdv:       best.fdv               || 0,
      mcap:      best.marketCap         || 0,
      buys24h:   best.txns?.h24?.buys   || 0,
      sells24h:  best.txns?.h24?.sells  || 0,
      txns24h:  (best.txns?.h24?.buys || 0) + (best.txns?.h24?.sells || 0),
      logo:      best.info?.imageUrl    || null,
      symbol:    best.baseToken?.symbol || null,
      name:      best.baseToken?.name   || null,
      pairAddr:  best.pairAddress       || null,
      dex:       best.dexId             || null,
      createdAt: best.pairCreatedAt     || null,
      source:    'dex-single',
    };
  } catch { return null; }
}

async function _fetchPumpFun(mint) {
  try {
    const r = await fetch(
      `https://frontend-api.pump.fun/coins/${mint}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!r.ok) return null;
    const c = await r.json();
    if (!c?.usd_market_cap || !c?.total_supply) return null;
    const price = c.usd_market_cap / c.total_supply;
    if (!(price > 0)) return null;
    return {
      price,
      liquidity: c.virtual_sol_reserves ? c.virtual_sol_reserves / 1e9 * 150 : 0,
      volume24h: 0, volume6h: 0, volume1h: 0,
      change24h: 0, change6h: 0, change1h: 0,
      fdv:       c.usd_market_cap || 0,
      mcap:      c.usd_market_cap || 0,
      buys24h:   0, sells24h: 0, txns24h: 0,
      logo:      c.image_uri || null,
      symbol:    c.symbol    || null,
      name:      c.name      || null,
      pairAddr:  null, dex: 'pumpfun', createdAt: null,
      pumpfun: {
        progress:    c.virtual_sol_reserves ? Math.min(100, c.virtual_sol_reserves / 1e9 / 85 * 100) : 0,
        complete:    !!c.complete,
        kingOfHill:  !!c.king_of_the_hill_timestamp,
        creator:     c.creator || null,
      },
      source: 'pumpfun',
    };
  } catch { return null; }
}

async function _fetchBirdeye(mint) {
  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${mint}`,
      { headers: { 'X-Chain': 'solana' }, signal: AbortSignal.timeout(8_000) },
    );
    if (!r.ok) return null;
    const price = parseFloat((await r.json())?.data?.value ?? 0);
    if (!(price > 0)) return null;
    return {
      price, liquidity: 0, volume24h: 0, volume6h: 0, volume1h: 0,
      change24h: 0, change6h: 0, change1h: 0, fdv: 0, mcap: 0,
      buys24h: 0, sells24h: 0, txns24h: 0,
      logo: null, symbol: null, name: null, pairAddr: null, dex: null, createdAt: null,
      source: 'birdeye',
    };
  } catch { return null; }
}

// ── Orchestrateur principal ────────────────────────────────────────────────────
async function prefetchPrices(mints) {
  const now = Date.now();

  // Filtrage : exclure tokens en neg-cache et encore frais en cache
  const toFetch = mints.filter(m => {
    if (isNegCached(m)) return false;
    const c = priceCache.get(m);
    return !c || now - c.ts > CFG.PRICE_TTL_MS;
  });

  if (!toFetch.length) return;
  log('debug', 'Price fetch', { count: toFetch.length, negSkipped: mints.length - toFetch.length });

  // Cascade de fetchers
  const found = await _fetchDexBatch(toFetch);
  log('debug', 'DexScreener batch', { asked: toFetch.length, found: Object.keys(found).length });

  const lim5 = pLimit(5);
  const lim4 = pLimit(4);

  // DexScreener individuel pour les manquants
  const miss1 = toFetch.filter(m => !found[m]);
  if (miss1.length) {
    await Promise.all(miss1.map(m => lim5(async () => { const d = await _fetchDexSingle(m); if (d) found[m] = d; })));
  }

  // Pump.fun
  const miss2 = toFetch.filter(m => !found[m]);
  if (miss2.length) {
    await Promise.all(miss2.map(m => lim5(async () => { const d = await _fetchPumpFun(m); if (d) found[m] = d; })));
  }

  // Birdeye
  const miss3 = toFetch.filter(m => !found[m]);
  if (miss3.length) {
    await Promise.all(miss3.map(m => lim4(async () => { const d = await _fetchBirdeye(m); if (d) found[m] = d; })));
  }

  // Merge dans le cache + compteurs succès/échec
  const ts = Date.now();
  const srcs = {};
  for (const m of toFetch) {
    const d = found[m];
    if (d?.price > 0) {
      priceCache.set(m, { data: d, ts });
      trackLiq(m, d.liquidity);
      recordPriceSuccess(m);
      srcs[d.source] = (srcs[d.source] || 0) + 1;
    } else {
      recordPriceFail(m);
    }
  }

  const ok    = toFetch.filter(m => priceCache.get(m)?.data?.price > 0).length;
  const negNow = mints.filter(m => isNegCached(m)).length;
  log('debug', 'Prices done', { ok, total: toFetch.length, missing: toFetch.length - ok, negCached: negNow, srcs });
}

function getPrice(mint) { return priceCache.get(mint)?.data ?? null; }

// ═══════════════════════════════════════════════════════════════════════════════
// §8  SCORE ENGINE — Qualité token 0-100
// ═══════════════════════════════════════════════════════════════════════════════

class ScoreEngine {
  /**
   * Score composite 0-100 :
   *   Liquidité       30 pts — zone idéale $20k-$300k
   *   Volume/MCap     25 pts — activité relative
   *   Pression achat  15 pts — buys/(buys+sells)
   *   Momentum 1h     15 pts — price change dernière heure
   *   Âge paire       10 pts — fraîcheur du token
   *   Pump.fun bonus   5 pts — graduation imminente
   */
  score(pd) {
    if (!pd) return 0;
    let s = 0;

    // Liquidité
    const liq = pd.liquidity || 0;
    if      (liq >= 50_000  && liq <= 300_000) s += 30;
    else if (liq >= 20_000  && liq <= 500_000) s += 22;
    else if (liq >= 10_000  && liq <= 700_000) s += 14;
    else if (liq >= 5_000)                     s += 7;
    else if (liq >= 1_000)                     s += 2;

    // Volume/MCap
    const mc = pd.mcap || pd.fdv || 0;
    if (mc > 0) {
      const r = (pd.volume24h || 0) / mc;
      if      (r >= 0.5)  s += 25;
      else if (r >= 0.2)  s += 20;
      else if (r >= 0.1)  s += 14;
      else if (r >= 0.05) s += 8;
      else if (r >= 0.02) s += 3;
    }

    // Pression achat
    const b = pd.buys24h || 0, sv = pd.sells24h || 0;
    if (b + sv > 0) {
      const r = b / (b + sv);
      if      (r >= 0.70) s += 15;
      else if (r >= 0.60) s += 11;
      else if (r >= 0.50) s += 7;
      else if (r >= 0.40) s += 3;
    }

    // Momentum 1h
    const c1 = pd.change1h || 0;
    if      (c1 >= 10) s += 15;
    else if (c1 >= 5)  s += 12;
    else if (c1 >= 2)  s += 8;
    else if (c1 >= 0)  s += 4;
    else if (c1 >= -5) s += 1;

    // Âge paire
    if (pd.createdAt) {
      const ageH = (Date.now() - pd.createdAt) / 3_600_000;
      if      (ageH <= 1)  s += 10;
      else if (ageH <= 6)  s += 8;
      else if (ageH <= 24) s += 5;
      else if (ageH <= 72) s += 2;
    }

    // Pump.fun graduation imminente
    if (pd.pumpfun?.progress >= 80 && !pd.pumpfun.complete) s += 5;
    else if (pd.pumpfun?.progress >= 50) s += 2;

    return Math.min(100, Math.round(s));
  }

  /** Slippage recommandé selon liquidité et urgence */
  slippage(liq, urgency = 'normal') {
    const base = urgency === 'emergency' ? 2000 : urgency === 'high' ? 1000 : CFG.DEFAULT_SLIPPAGE;
    if (!liq || liq > 100_000) return base;
    if (liq > 50_000)  return Math.max(base, 700);
    if (liq > 20_000)  return Math.max(base, 1000);
    if (liq > 5_000)   return Math.max(base, 1500);
    return Math.max(base, 2000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §9  MOMENTUM TRACKER
// ═══════════════════════════════════════════════════════════════════════════════

class MomentumTracker {
  constructor() { this._hist = new Map(); } // mint → [{ts, price}]

  addPrice(mint, price) {
    if (!(price > 0)) return;
    const h = this._hist.get(mint) || [];
    h.push({ ts: Date.now(), price });
    if (h.length > 20) h.shift();
    this._hist.set(mint, h);
  }

  /**
   * Tendance sur les N derniers cycles
   * @returns {{ trend: 'up'|'down'|'flat', changePct: number, velocity: number, accel: number }}
   */
  getTrend(mint, window = CFG.ME_WINDOW) {
    const h = this._hist.get(mint) || [];
    if (h.length < 3) return { trend: 'flat', changePct: 0, velocity: 0, accel: 0 };
    const pts   = h.slice(-Math.min(window + 1, h.length));
    const first = pts[0].price, last = pts[pts.length - 1].price;
    const chg   = first > 0 ? ((last - first) / first) * 100 : 0;
    const vel   = chg / (pts.length - 1);

    // Accélération = différence de vélocité 1ère vs 2ème moitié
    const mid = Math.floor(pts.length / 2);
    const v1  = pts[0].price > 0 ? ((pts[mid].price - pts[0].price) / pts[0].price * 100) / (mid || 1) : 0;
    const v2  = pts[mid].price > 0 ? ((last - pts[mid].price) / pts[mid].price * 100) / (pts.length - 1 - mid || 1) : 0;

    return {
      trend:     chg > 1 ? 'up' : chg < -1 ? 'down' : 'flat',
      changePct: +chg.toFixed(3),
      velocity:  +vel.toFixed(3),
      accel:     +(v2 - v1).toFixed(3),
    };
  }

  /** True si retournement baissier suffisant pour déclencher un momentum exit */
  isMomentumExit(mint, pnl) {
    if (!CFG.ME_ENABLED || pnl === null || pnl < 5) return false;
    const { trend, velocity, accel } = this.getTrend(mint);
    return trend === 'down' && velocity < CFG.ME_THRESHOLD && accel < -1;
  }

  /** Volatilité σ des rendements log cycle-par-cycle */
  getVolatility(mint) {
    const h = this._hist.get(mint) || [];
    if (h.length < 4) return null;
    const rets = [];
    for (let i = 1; i < h.length; i++) {
      if (h[i - 1].price > 0) rets.push(Math.log(h[i].price / h[i - 1].price) * 100);
    }
    return rets.length >= 3 ? stddev(rets) : null;
  }

  /** Trailing stop adapté à la volatilité (N × σ, borné entre TS_PCT/2 et TS_PCT×2) */
  volTrailingPct(mint) {
    const sigma = this.getVolatility(mint);
    if (!sigma) return CFG.TS_PCT;
    return Math.min(CFG.TS_PCT * 2, Math.max(CFG.TS_PCT / 2, sigma * CFG.TS_VOL_MULT));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §10  POSITION MANAGER
//      Gestion de toutes les stratégies de sortie automatiques
// ═══════════════════════════════════════════════════════════════════════════════

class PositionManager {
  constructor(tiers, hysteresis, state = {}) {
    this.tiers      = [...tiers].sort((a, b) => a.pnl - b.pnl);
    this.hysteresis = hysteresis;

    // Structures vives
    this.entries   = new Map(); // mint → EntryData
    this.triggered = new Map(); // mint → Set<tierIndex>
    this.sold      = new Map(); // mint → totalSold
    this.peak      = new Map(); // mint → maxPnl
    this.prevPrice = new Map(); // mint → lastPrice
    this.slHit     = new Set(state.stopLossHit || []);
    this.slPending = new Set(state.slPending   || []);
    this.breakEven = new Set(state.breakEven   || []);

    // Restauration depuis persistance
    for (const [mint, d] of Object.entries(state.entryPrices || {})) {
      this.entries.set(mint, d);
      this.triggered.set(mint, new Set(d.triggeredTiers || []));
      this.sold.set(mint, d.soldAmount   || 0);
      this.peak.set(mint, d.peakPnl      || 0);
    }
    log('info', 'Positions restaurées', {
      count:     this.entries.size,
      breakEven: this.breakEven.size,
      slHit:     this.slHit.size,
    });

    // §NEW — Pyramid / DCA-down / Re-entry state
    this.pyramidDone  = new Map(); // mint → Set<tierIdx>
    this.dcadDone     = new Map(); // mint → number (count of DCA-down execs)
    this.addedSol     = new Map(); // mint → totalExtraSOL spent (pyramid cap)
    this.slExitTs     = new Map(); // mint → ts of last SL exit (re-entry delay)
    this.slExitPrice  = new Map(); // mint → price at which SL was hit
    // Restore pyramid state from persisted entry data
    for (const [mint, d] of Object.entries(state.entryPrices || {})) {
      if (d.pyramidDone)  this.pyramidDone.set(mint, new Set(d.pyramidDone));
      if (d.dcadDone >= 0) this.dcadDone.set(mint, d.dcadDone);
      if (d.addedSol  > 0) this.addedSol.set(mint, d.addedSol);
    }
    for (const [mint, info] of Object.entries(state.slExits || {})) {
      this.slExitTs.set(mint, info.ts);
      this.slExitPrice.set(mint, info.price);
    }
  }

  // ── Lecture ────────────────────────────────────────────────────────────────

  getPnl(mint, price) {
    const e = this.entries.get(mint);
    return (e && price > 0) ? ((price - e.price) / e.price) * 100 : null;
  }

  getRemaining(mint) {
    const e = this.entries.get(mint);
    return e ? Math.max(0, e.originalBalance - (this.sold.get(mint) || 0)) : 0;
  }

  isLiquidated(mint) { return this.slHit.has(mint) || this.slPending.has(mint); }

  // ── Enregistrement ─────────────────────────────────────────────────────────

  /**
   * Crée une nouvelle position.
   * forcedPrice = prix réel du swap.
   * Si absent → bootstrappée (position existante au démarrage) → TP/SL inactifs
   * jusqu'à correction via /api/positions/set-entry ou scan Helius.
   */
  trackEntry(mint, marketPrice, balance, forcedPrice = null) {
    if (this.entries.has(mint)) return false;
    const price        = forcedPrice > 0 ? forcedPrice : marketPrice;
    const bootstrapped = !(forcedPrice > 0);
    if (!(price > 0) || !(balance > 0)) return false;

    this.entries.set(mint, {
      price, bootstrapped, ts: Date.now(),
      originalBalance: balance,
      triggeredTiers:  [], soldAmount: 0, peakPnl: 0,
    });
    this.triggered.set(mint, new Set());
    this.sold.set(mint, 0);
    this.peak.set(mint, 0);

    if (!bootstrapped) log('info', '✅ Position créée (swap réel)', {
      mint: mint.slice(0, 8), price: price.toPrecision(6),
    });
    return true;
  }

  setEntryPrice(mint, newPrice, newBalance = null) {
    const e = this.entries.get(mint);
    if (!e) return false;
    e.price        = newPrice;
    e.bootstrapped = false;
    this.triggered.set(mint, new Set());
    e.triggeredTiers = [];
    this.breakEven.delete(mint);
    if (newBalance > 0) { e.originalBalance = newBalance; this.sold.set(mint, 0); e.soldAmount = 0; }
    log('info', '📌 Prix entrée corrigé', { mint: mint.slice(0, 8), price: newPrice.toPrecision(6) });
    return true;
  }

  updatePeak(mint, pnl) {
    if (pnl === null) return;
    const prev = this.peak.get(mint) || 0;
    if (pnl > prev) { this.peak.set(mint, pnl); const e = this.entries.get(mint); if (e) e.peakPnl = pnl; }
  }

  updatePrevPrice(mint, price) { if (price > 0) this.prevPrice.set(mint, price); }

  // ── Checks de sortie ───────────────────────────────────────────────────────

  /** Take-profit — retourne [] si position liquidée (guard anti double-sell) */
  checkTP(mint, price) {
    if (this.isLiquidated(mint)) return [];
    const e    = this.entries.get(mint);
    const trig = this.triggered.get(mint);
    const pnl  = this.getPnl(mint, price);
    if (!e || !trig || pnl === null || e.bootstrapped) return [];

    const hits = [];
    for (let i = 0; i < this.tiers.length; i++) {
      if (trig.has(i)) continue;
      const tier = this.tiers[i];
      if (pnl < tier.pnl) continue;
      const rem  = this.getRemaining(mint);
      const sell = Math.min(e.originalBalance * (tier.sell / 100), rem);
      if (sell <= 0) continue;
      hits.push({ idx: i, pnlTarget: tier.pnl, currentPnl: pnl.toFixed(2), sellAmount: sell });
    }
    return hits;
  }

  /** Break-even stop OU stop-loss fixe */
  checkSL(mint, price) {
    if (!CFG.SL_ENABLED || this.isLiquidated(mint)) return null;
    const e   = this.entries.get(mint);
    if (!e || e.bootstrapped) return null;
    const pnl = this.getPnl(mint, price);
    if (pnl === null) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;

    if (this.breakEven.has(mint)) {
      // Break-even : exit si PnL tombe sous entry + buffer
      if (pnl < CFG.BE_BUFFER)
        return { type: 'break-even', pnl: pnl.toFixed(2), threshold: CFG.BE_BUFFER, sellAmount: rem };
    } else {
      if (pnl > CFG.SL_PCT) return null;
      return { type: 'stop-loss', pnl: pnl.toFixed(2), threshold: CFG.SL_PCT, sellAmount: rem };
    }
    return null;
  }

  /** Trailing stop (fixe ou adaptatif σ) — actif seulement après pic > 10% */
  checkTS(mint, price, momentum = null) {
    if (!CFG.TS_ENABLED || this.isLiquidated(mint)) return null;
    const pnl  = this.getPnl(mint, price);
    const peak = this.peak.get(mint) || 0;
    if (pnl === null || peak < 10) return null;

    const trailingPct = (CFG.TS_VOL && momentum)
      ? momentum.volTrailingPct(mint)
      : CFG.TS_PCT;

    if (pnl >= peak - trailingPct) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'trailing-stop', pnl: pnl.toFixed(2), peak: peak.toFixed(2), trailingPct, sellAmount: rem };
  }

  /** Anti-rug : chute de prix en un seul cycle */
  checkAR(mint, price) {
    if (!CFG.AR_ENABLED || this.isLiquidated(mint)) return null;
    const prev = this.prevPrice.get(mint);
    if (!(prev > 0)) return null;
    const drop = ((prev - price) / prev) * 100;
    if (drop < CFG.AR_PCT) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'anti-rug', drop: drop.toFixed(1), sellAmount: rem };
  }

  /** Liquidity exit : effondrement progressif de la liquidité */
  checkLE(mint) {
    if (!CFG.LE_ENABLED || this.isLiquidated(mint)) return null;
    const drop = getLiqDrop(mint);
    if (drop < CFG.LE_PCT) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'liq-exit', drop: drop.toFixed(1), sellAmount: rem };
  }

  /** Time-based stop : position stagnante depuis trop longtemps */
  checkTT(mint, pnl) {
    if (!CFG.TT_ENABLED || this.isLiquidated(mint)) return null;
    const e = this.entries.get(mint);
    if (!e || e.bootstrapped) return null;
    const holdH = (Date.now() - e.ts) / 3_600_000;
    if (holdH < CFG.TT_HOURS) return null;
    if (pnl !== null && pnl > CFG.TT_MIN_PNL) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'time-stop', holdHours: holdH.toFixed(1), pnl: pnl?.toFixed(2), sellAmount: rem };
  }

  /** Momentum exit : retournement de tendance confirmé en profit */
  checkME(mint, price, momentum) {
    if (!momentum || this.isLiquidated(mint)) return null;
    const pnl = this.getPnl(mint, price);
    if (!momentum.isMomentumExit(mint, pnl)) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'momentum-exit', pnl: pnl?.toFixed(2), trend: momentum.getTrend(mint), sellAmount: rem };
  }

  // ── Post-exécution ──────────────────────────────────────────────────────────

  markTierDone(mint, tierIdx, amountSold) {
    const trig = this.triggered.get(mint);
    const e    = this.entries.get(mint);
    if (!trig || !e) return;
    trig.add(tierIdx);
    const total = (this.sold.get(mint) || 0) + amountSold;
    this.sold.set(mint, total);
    e.triggeredTiers = Array.from(trig);
    e.soldAmount     = total;
    // Activer break-even après TP1
    if (CFG.BE_ENABLED && tierIdx === 0) {
      this.breakEven.add(mint);
      log('info', '🔒 Break-even activé (TP1 done)', { mint: mint.slice(0, 8) });
    }
    log('success', `TP palier ${tierIdx + 1} exécuté`, { mint: mint.slice(0, 8), sold: amountSold.toFixed(4) });
  }

  markSLDone(mint)    { this.slHit.add(mint); this.slPending.delete(mint); this.breakEven.delete(mint); }
  markSLPending(mint) { this.slPending.add(mint); log('warn', 'SL pending (vente échouée)', { mint: mint.slice(0, 8) }); }
  clearSLPending(mint){ this.slPending.delete(mint); }

  resetTiersIfNeeded(mint, pnl) {
    if (pnl === null) return;
    const trig = this.triggered.get(mint);
    const e    = this.entries.get(mint);
    if (!trig || !e) return;
    for (let i = 0; i < this.tiers.length; i++) {
      if (trig.has(i) && pnl < this.tiers[i].pnl - this.hysteresis) {
        trig.delete(i); e.triggeredTiers = Array.from(trig);
        log('debug', 'Tier réinitialisé (hystérésis)', { mint: mint.slice(0, 8), tier: i + 1 });
      }
    }
    if (pnl < 0) this.breakEven.delete(mint);
  }

  // ── §NEW  Checks d'entrée automatique ─────────────────────────────────────

  /**
   * Pyramid In — retourne les paliers à acheter (PnL monte).
   * Chaque palier ne se déclenche qu'une fois (sauf si hystérésis réarmé).
   */
  checkPyramid(mint, price) {
    if (!CFG.PYRAMID_ENABLED || this.isLiquidated(mint)) return [];
    const e    = this.entries.get(mint);
    const pnl  = this.getPnl(mint, price);
    if (!e || e.bootstrapped || pnl === null) return [];

    // Cap SOL global
    const alreadyAdded = this.addedSol.get(mint) || 0;
    if (alreadyAdded >= CFG.PYRAMID_MAX_SOL) return [];

    const done = this.pyramidDone.get(mint) || new Set();
    const hits = [];
    for (let i = 0; i < CFG.PYRAMID_TIERS.length; i++) {
      if (done.has(i)) continue;
      const tier = CFG.PYRAMID_TIERS[i];
      if (pnl < tier.pnl) continue;
      const canAdd = Math.min(tier.addSol, CFG.PYRAMID_MAX_SOL - alreadyAdded);
      if (canAdd <= 0) continue;
      hits.push({ idx: i, pnlTarget: tier.pnl, currentPnl: +pnl.toFixed(2), addSol: canAdd });
    }
    return hits;
  }

  /**
   * DCA-Down — retourne les paliers à racheter (PnL négatif).
   * S'arrête si le momentum est encore en chute (DCAD_REQUIRE_MOMENTUM).
   */
  checkDCADown(mint, price, momentumTracker) {
    if (!CFG.DCAD_ENABLED || this.isLiquidated(mint)) return [];
    const e   = this.entries.get(mint);
    const pnl = this.getPnl(mint, price);
    if (!e || e.bootstrapped || pnl === null || pnl >= 0) return [];

    const doneCount = this.dcadDone.get(mint) || 0;
    if (doneCount >= CFG.DCAD_MAX_ADDS) return [];

    // Vérif momentum si requis — n'achète que si la chute ralentit
    if (CFG.DCAD_REQUIRE_MOMENTUM && momentumTracker) {
      const { velocity } = momentumTracker.getTrend(mint);
      if (velocity < CFG.DCAD_MIN_VELOCITY) return []; // encore en free-fall
    }

    const hits = [];
    for (let i = 0; i < CFG.DCAD_TIERS.length; i++) {
      const tier = CFG.DCAD_TIERS[i];
      if (pnl > tier.pnl) continue; // pas encore assez bas
      // On utilise le tier indexé par doneCount pour ne déclencher qu'une fois
      if (i !== doneCount) continue; // déclenche dans l'ordre
      hits.push({ idx: i, pnlTarget: tier.pnl, currentPnl: +pnl.toFixed(2), addSol: tier.addSol });
    }
    return hits;
  }

  /**
   * Re-entry — vérifie si un token (stoppé) peut être racheté.
   * Conditions: délai écoulé + rebond suffisant depuis prix d'exit + score OK.
   */
  checkReentry(mint, currentPrice, score) {
    if (!CFG.REENTRY_ENABLED) return null;
    if (!this.slHit.has(mint)) return null; // n'a pas été stoppé

    const exitTs    = this.slExitTs.get(mint);
    const exitPrice = this.slExitPrice.get(mint);
    if (!exitTs || !exitPrice) return null;

    const delayMs = CFG.REENTRY_DELAY_MIN * 60_000;
    if (Date.now() - exitTs < delayMs) return null;

    const reboundPct = exitPrice > 0 ? ((currentPrice - exitPrice) / exitPrice) * 100 : 0;
    if (reboundPct < CFG.REENTRY_MIN_GAIN) return null;

    if (score < CFG.REENTRY_MIN_SCORE) return null;

    return {
      type:       're-entry',
      exitPrice,
      reboundPct: +reboundPct.toFixed(2),
      solAmount:  CFG.REENTRY_SOL,
      score,
    };
  }

  // ── §NEW  Post-exécution entrées auto ──────────────────────────────────────

  /**
   * Met à jour l'entrée après un Pyramid In réussi.
   * Recalcule la moyenne pondérée et étend originalBalance.
   */
  markPyramidDone(mint, tierIdx, tokBought, solSpent) {
    const e = this.entries.get(mint);
    if (!e) return;

    // Moyenne pondérée : (oldEntry × oldBal + newEntry × tokBought) / (oldBal + tokBought)
    const oldBal = e.originalBalance;
    const newBal = oldBal + tokBought;
    const oldEntrySOL = e.price * oldBal;
    const newEntrySOL = (solSpent / tokBought) * tokBought; // = solSpent
    if (newBal > 0) e.price = (oldEntrySOL + newEntrySOL) / newBal;
    e.originalBalance = newBal;

    // Tracking
    const done = this.pyramidDone.get(mint) || new Set();
    done.add(tierIdx);
    this.pyramidDone.set(mint, done);
    e.pyramidDone = Array.from(done);

    const total = (this.addedSol.get(mint) || 0) + solSpent;
    this.addedSol.set(mint, total);
    e.addedSol = total;

    // Reset TP tiers qui seraient déjà déclenchés (nouvelle base)
    this.triggered.set(mint, new Set());
    e.triggeredTiers = [];
    this.breakEven.delete(mint);

    log('success', `📈 PYRAMID T${tierIdx + 1} — entrée recalculée`, {
      mint: mint.slice(0, 8),
      newEntry: e.price.toPrecision(6),
      totalAdded: total.toFixed(4) + ' SOL',
    });
  }

  /**
   * Met à jour l'entrée après un DCA-Down réussi.
   * Recalcule la moyenne pondérée et réinitialise les paliers TP.
   */
  markDCADownDone(mint, tierIdx, tokBought, solSpent) {
    const e = this.entries.get(mint);
    if (!e) return;

    const oldBal = e.originalBalance;
    const newBal = oldBal + tokBought;
    const oldEntrySOL = e.price * oldBal;
    if (newBal > 0) e.price = (oldEntrySOL + solSpent) / newBal;
    e.originalBalance = newBal;

    const count = (this.dcadDone.get(mint) || 0) + 1;
    this.dcadDone.set(mint, count);
    e.dcadDone = count;

    // Reset TP tiers — nouvelle base d'entrée
    this.triggered.set(mint, new Set());
    e.triggeredTiers = [];
    this.breakEven.delete(mint);

    log('success', `📉 DCA-DOWN #${count} — entrée recalculée`, {
      mint: mint.slice(0, 8),
      newEntry: e.price.toPrecision(6),
      addsSoFar: count + '/' + CFG.DCAD_MAX_ADDS,
    });
  }

  /**
   * Enregistre le prix et timestamp lors d'un SL/exit pour la re-entry.
   */
  markExitForReentry(mint, price) {
    this.slExitTs.set(mint, Date.now());
    this.slExitPrice.set(mint, price);
  }

  /**
   * Réinitialise une position après re-entry (recrée l'entry).
   */
  clearForReentry(mint) {
    this.slHit.delete(mint);
    this.slPending.delete(mint);
    this.pyramidDone.delete(mint);
    this.dcadDone.delete(mint);
    this.addedSol.delete(mint);
    this.entries.delete(mint);
    this.triggered.delete(mint);
    this.sold.delete(mint);
    this.peak.delete(mint);
    log('info', 'Re-entry: position réinitialisée', { mint: mint.slice(0, 8) });
  }

  /**
   * Réinitialise le timer de re-entry (annulation manuelle).
   */
  clearReentryBlock(mint) {
    this.slExitTs.delete(mint);
    this.slExitPrice.delete(mint);
  }

  /**
   * Hystérésis pyramid : réarme un palier si le PnL redescend.
   */
  resetPyramidIfNeeded(mint, pnl) {
    if (pnl === null) return;
    const done = this.pyramidDone.get(mint);
    if (!done) return;
    const e = this.entries.get(mint);
    for (let i = 0; i < CFG.PYRAMID_TIERS.length; i++) {
      if (done.has(i) && pnl < CFG.PYRAMID_TIERS[i].pnl - CFG.PYRAMID_HYSTERESIS) {
        done.delete(i);
        if (e) e.pyramidDone = Array.from(done);
      }
    }
  }

  // ── Sérialisation ───────────────────────────────────────────────────────────

  serialize() {
    const out = {};
    for (const [mint, e] of this.entries) {
      out[mint] = {
        price:           e.price,
        bootstrapped:    e.bootstrapped || false,
        ts:              e.ts,
        originalBalance: e.originalBalance,
        triggeredTiers:  Array.from(this.triggered.get(mint) || []),
        soldAmount:      this.sold.get(mint) || 0,
        peakPnl:         this.peak.get(mint) || 0,
        // §NEW
        pyramidDone:     Array.from(this.pyramidDone.get(mint) || []),
        dcadDone:        this.dcadDone.get(mint) || 0,
        addedSol:        this.addedSol.get(mint) || 0,
      };
    }
    return out;
  }

  serializeSlExits() {
    const out = {};
    for (const [mint, ts] of this.slExitTs) {
      out[mint] = { ts, price: this.slExitPrice.get(mint) || null };
    }
    return out;
  }

  toApiRows() {
    const rows = [];
    for (const [mint, e] of this.entries) {
      const pd = getPrice(mint);
      rows.push({
        mint,           symbol: pd?.symbol || null,
        entryPrice:     e.price,
        bootstrapped:   !!e.bootstrapped,
        originalBalance:e.originalBalance,
        sold:           this.sold.get(mint) || 0,
        remaining:      this.getRemaining(mint),
        triggeredTiers: Array.from(this.triggered.get(mint) || []).map(i => this.tiers[i]?.pnl),
        stopLossHit:    this.slHit.has(mint),
        slPending:      this.slPending.has(mint),
        breakEven:      this.breakEven.has(mint),
        peakPnl:        this.peak.get(mint) || 0,
        entryTs:        e.ts,
        liqDrop:        getLiqDrop(mint),
      });
    }
    return rows;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §11  SWAP ENGINE — Jupiter (lite → api → quote) + Jito bundles
// ═══════════════════════════════════════════════════════════════════════════════

const QUOTE_EPS = [
  'https://lite-api.jup.ag/swap/v1/quote',
  'https://api.jup.ag/swap/v1/quote',
  'https://quote-api.jup.ag/v6/quote',
];
const SWAP_EPS = [
  'https://lite-api.jup.ag/swap/v1/swap',
  'https://api.jup.ag/swap/v1/swap',
  'https://quote-api.jup.ag/v6/swap',
];

class SwapEngine {
  constructor(wallet, rpc) {
    this.wallet       = wallet;
    this.rpc          = rpc;
    this.mutex        = new Mutex();
    this.sellFailures = 0;
    this.lastBuyTs    = 0;
  }

  async getQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
    const qs = `inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`;
    let last;
    for (const ep of QUOTE_EPS) {
      try {
        const r = await fetch(`${ep}?${qs}`, {
          headers: { 'User-Agent': `SolBot/${VERSION}`, Accept: 'application/json' },
          signal:  AbortSignal.timeout(15_000),
        });
        if (!r.ok) { last = new Error(`Quote HTTP ${r.status}`); continue; }
        const q = await r.json();
        if (q.error)    { last = new Error(q.error); continue; }
        if (!q.outAmount){ last = new Error('No outAmount'); continue; }
        return q;
      } catch (err) { last = err; }
    }
    throw last || new Error('Tous les endpoints Jupiter quote ont échoué');
  }

  async _buildAndSendTx({ inputMint, outputMint, amountRaw, slippageBps, priorityMode = 'auto' }) {
    return withRetry(async () => {
      // Quote refetch à chaque tentative (expire ~60s)
      const quote = await this.getQuote({ inputMint, outputMint, amountRaw, slippageBps });

      const priLamports = priorityMode === 'turbo'  ? 500_000
        : priorityMode === 'high'   ? 200_000
        : priorityMode === 'medium' ? 100_000
        : 'auto';

      const body = JSON.stringify({
        quoteResponse:             quote,
        userPublicKey:             this.wallet.publicKey.toString(),
        wrapAndUnwrapSol:          true,
        dynamicComputeUnitLimit:   true,
        prioritizationFeeLamports: priLamports,
      });

      let swapData = null, swapErr;
      for (const ep of SWAP_EPS) {
        try {
          const r = await fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': `SolBot/${VERSION}` },
            body, signal: AbortSignal.timeout(30_000),
          });
          if (!r.ok) { swapErr = new Error(`Swap HTTP ${r.status}`); continue; }
          const d = await r.json();
          if (d?.swapTransaction) { swapData = d; break; }
          swapErr = new Error('swapTransaction absent');
        } catch (err) { swapErr = err; }
      }
      if (!swapData) throw swapErr || new Error('Tous les endpoints swap ont échoué');

      const tx        = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      const blockhash = tx.message.recentBlockhash;
      const lbh       = await this.rpc.conn.getLatestBlockhash('confirmed');
      tx.sign([this.wallet]);

      const sig  = await this.rpc.conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
      });
      const conf = await this.rpc.conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight: lbh.lastValidBlockHeight },
        'confirmed',
      );
      if (conf.value.err) throw new Error(`Tx rejetée: ${JSON.stringify(conf.value.err)}`);
      return { sig, txUrl: `https://solscan.io/tx/${sig}`, quote };
    }, { tries: 3, baseMs: 800, label: `swap(${inputMint.slice(0, 8)})` });
  }

  async _buildAndSendJito({ inputMint, outputMint, amountRaw, slippageBps }) {
    if (!CFG.JITO_ENABLED)
      return this._buildAndSendTx({ inputMint, outputMint, amountRaw, slippageBps, priorityMode: 'turbo' });

    try {
      const quote = await this.getQuote({ inputMint, outputMint, amountRaw, slippageBps });
      const body  = JSON.stringify({
        quoteResponse: quote, userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 500_000,
      });

      let swapData = null;
      for (const ep of SWAP_EPS) {
        try {
          const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
          if (r.ok) { const d = await r.json(); if (d?.swapTransaction) { swapData = d; break; } }
        } catch {}
      }
      if (!swapData) throw new Error('Swap data manquante');

      const lbh   = await this.rpc.conn.getLatestBlockhash('confirmed');
      const swapTx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));

      // Tip transaction Jito
      const tipTx = new VersionedTransaction(new TransactionMessage({
        payerKey:       this.wallet.publicKey,
        recentBlockhash: lbh.blockhash,
        instructions:  [SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey:   new PublicKey(JITO_TIP_WALLET),
          lamports:   Math.floor(CFG.JITO_TIP_SOL * LAMPORTS_PER_SOL),
        })],
      }).compileToV0Message());

      swapTx.sign([this.wallet]); tipTx.sign([this.wallet]);

      await fetch(CFG.JITO_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [
          [Buffer.from(swapTx.serialize()).toString('base64'), Buffer.from(tipTx.serialize()).toString('base64')],
        ]}),
        signal: AbortSignal.timeout(20_000),
      });

      const sig  = await this.rpc.conn.sendRawTransaction(swapTx.serialize(), { skipPreflight: true, maxRetries: 2 });
      const conf = await this.rpc.conn.confirmTransaction({ signature: sig, blockhash: lbh.blockhash, lastValidBlockHeight: lbh.lastValidBlockHeight }, 'confirmed');
      if (conf.value.err) throw new Error('Tx Jito rejetée');
      log('info', '⚡ Jito bundle confirmé', { sig: sig.slice(0, 16) });
      return { sig, txUrl: `https://solscan.io/tx/${sig}`, quote };
    } catch (err) {
      log('warn', 'Jito échoué — fallback Jupiter', { err: err.message });
      return this._buildAndSendTx({ inputMint, outputMint, amountRaw, slippageBps, priorityMode: 'turbo' });
    }
  }

  // ── Public : Buy ──────────────────────────────────────────────────────────

  async buy(mint, solAmount, slippageBps = CFG.DEFAULT_SLIPPAGE) {
    const elapsed = Date.now() - this.lastBuyTs;
    if (elapsed < CFG.BUY_COOLDOWN_MS)
      throw new Error(`Cooldown: ${((CFG.BUY_COOLDOWN_MS - elapsed) / 1000).toFixed(1)}s restantes`);

    const bal = await this.getSolBalance();
    if (bal !== null && bal < solAmount + CFG.MIN_SOL_RESERVE)
      throw new Error(`Solde insuffisant: ${bal.toFixed(4)} SOL (besoin ${(solAmount + CFG.MIN_SOL_RESERVE).toFixed(4)})`);

    const raw = BigInt(Math.floor(solAmount * 1e9));
    const { sig, txUrl, quote } = await this._buildAndSendTx({ inputMint: SOL_MINT, outputMint: mint, amountRaw: raw, slippageBps });
    const dec = await getDecimals(mint, this.rpc.conn);
    const outAmount = Number(quote.outAmount) / 10 ** dec;
    this.lastBuyTs  = Date.now();
    log('success', '✅ Achat confirmé', { mint: mint.slice(0, 8), tokens: outAmount.toFixed(4), sig });
    return { success: true, sig, txUrl, outAmount, solSpent: solAmount };
  }

  async buyDCA(mint, totalSol, chunks, intervalSec, slippageBps = CFG.DEFAULT_SLIPPAGE) {
    const chunkSol = totalSol / chunks;
    const results  = [];
    log('info', '📊 DCA démarré', { mint: mint.slice(0, 8), totalSol, chunks, intervalSec });
    for (let i = 0; i < chunks; i++) {
      try {
        const r = await this.buy(mint, chunkSol, slippageBps);
        results.push({ chunk: i + 1, ...r });
        log('info', `DCA chunk ${i + 1}/${chunks}`, { out: r.outAmount?.toFixed(4) });
      } catch (err) {
        log('warn', `DCA chunk ${i + 1} échoué`, { err: err.message });
        results.push({ chunk: i + 1, success: false, error: err.message });
      }
      if (i < chunks - 1) await sleep(intervalSec * 1000);
    }
    return { results, succeeded: results.filter(r => r.success).length, total: chunks };
  }

  // ── Public : Sell (mutex — zéro double-sell) ──────────────────────────────

  async sell(mint, amount, reason = 'MANUAL', slippageBps = CFG.DEFAULT_SLIPPAGE, useJito = false) {
    // Circuit-breaker — auto-reset après 5 min (erreurs transitoires au démarrage)
    const CB_RESET_MS = 5 * 60 * 1000;
    if (this.sellFailures >= CFG.MAX_SELL_RETRIES) {
      const age = Date.now() - (this._cbTrippedAt || 0);
      if (age >= CB_RESET_MS) {
        log('info', `Circuit-breaker auto-reset (${Math.round(age / 60000)}min écoulées)`);
        this.sellFailures = 0;
        this._cbTrippedAt = null;
      } else {
        const msg = `Circuit-breaker actif (${this.sellFailures} échecs — reset dans ${Math.round((CB_RESET_MS - age) / 1000)}s)`;
        log('error', msg);
        // ⚠️ NE PAS clearSLPending ici — la position reste bloquée jusqu'au reset
        // pour éviter que pyramid/DCA re-tirent sur une position en cours de liquidation
        return { success: false, error: msg, cbBlocked: true };
      }
    }
    const release = await this.mutex.lock();
    try {
      const dec      = await getDecimals(mint, this.rpc.conn);
      const raw      = BigInt(Math.floor(amount * 10 ** dec));
      const outMint  = CFG.SELL_TO_USDC ? USDC_MINT : SOL_MINT;

      const res = useJito
        ? await this._buildAndSendJito({ inputMint: mint, outputMint: outMint, amountRaw: raw, slippageBps })
        : await this._buildAndSendTx({ inputMint: mint, outputMint: outMint, amountRaw: raw, slippageBps, priorityMode: 'high' });

      let solOut;
      let usdcOut = null;

      if (CFG.SELL_TO_USDC) {
        // USDC a 6 décimales
        usdcOut = Number(res.quote.outAmount) / 1e6;
        // Convertir USDC → SOL équivalent pour PnL (coût en SOL)
        // On utilise le prix SOL en cache, ou on estime depuis le prix du token
        const solPriceUSD = getPrice(SOL_MINT)?.price || getPrice('SOL')?.price || null;
        if (solPriceUSD && solPriceUSD > 0) {
          solOut = usdcOut / solPriceUSD;
        } else {
          // Fallback : utiliser le prix du token pour estimer la valeur SOL
          const tokenPriceUSD = getPrice(mint)?.price || 0;
          const tokenValueUSD = amount * tokenPriceUSD;
          // Estimer SOL à ~150 USD si pas disponible
          solOut = tokenValueUSD > 0 ? tokenValueUSD / 150 : usdcOut / 150;
          log('warn', '⚠️ Prix SOL indisponible, estimation PnL approximative', { solOut: solOut.toFixed(6) });
        }
        this.sellFailures = 0;
        log('success', '✅ Vente USDC confirmée', {
          mint: mint.slice(0, 8), usdcOut: usdcOut.toFixed(4),
          solEquiv: solOut.toFixed(6), reason, sig: res.sig,
        });
      } else {
        solOut = Number(res.quote.outAmount) / 1e9;
        this.sellFailures = 0;
        log('success', '✅ Vente SOL confirmée', { mint: mint.slice(0, 8), solOut: solOut.toFixed(6), reason, sig: res.sig });
      }

      return { success: true, sig: res.sig, txUrl: res.txUrl, solOut, usdcOut, amountSold: amount };
    } catch (err) {
      // Distinguer erreurs réseau (transitoires) des vrais échecs de swap
      const isNetworkError = (
        err.message?.includes('ENOTFOUND') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ECONNREFUSED') ||
        err.message?.includes('429') ||
        err.message?.includes('Too Many Requests') ||
        err.message?.includes('getaddrinfo') ||
        err.message?.includes('socket hang up') ||
        err.message?.includes('network timeout')
      );

      if (isNetworkError) {
        // Erreur réseau transitoire — ne pas incrémenter le CB, juste failover RPC
        log('warn', `⚡ Vente réseau erreur (non comptée CB): ${err.message.slice(0, 80)}`);
        try { this.rpc.failover(); } catch {} // tenter un autre endpoint
      } else {
        // Vrai échec de swap — compter
        this.sellFailures++;
        if (this.sellFailures >= CFG.MAX_SELL_RETRIES && !this._cbTrippedAt) {
          this._cbTrippedAt = Date.now();
          log('warn', `🔒 Circuit-breaker déclenché — auto-reset dans 5min`);
        }
        log('error', '❌ Vente échouée', { err: err.message, failures: this.sellFailures, reason });
      }
      return { success: false, error: err.message };
    } finally { release(); }
  }

  async getSolBalance() {
    try { return await this.rpc.conn.getBalance(this.wallet.publicKey) / 1e9; }
    catch { return null; }
  }

  async getUsdcBalance() {
    try {
      const accounts = await this.rpc.conn.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(USDC_MINT) }
      );
      if (!accounts.value.length) return 0;
      const info = accounts.value[0].account.data.parsed.info;
      return parseFloat(info.tokenAmount.uiAmount ?? '0');
    } catch { return null; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §12  ANALYTICS — Métriques avancées
// ═══════════════════════════════════════════════════════════════════════════════

class Analytics {
  constructor(state = {}) {
    const a = state.analytics || {};
    this.realizedPnlSol   = a.realizedPnlSol   || 0;
    this.totalBoughtSol   = a.totalBoughtSol   || 0;
    this.totalSoldSol     = a.totalSoldSol     || 0;
    this.winCount         = a.winCount         || 0;
    this.lossCount        = a.lossCount        || 0;
    this.totalTrades      = a.totalTrades      || 0;
    this.bestTradePct     = a.bestTradePct     ?? null;
    this.worstTradePct    = a.worstTradePct    ?? null;
    this.bestTradeSymbol  = a.bestTradeSymbol  || null;
    this.worstTradeSymbol = a.worstTradeSymbol || null;
    this.avgHoldMs        = a.avgHoldMs        || 0;
    this.tradePnls        = a.tradePnls        || [];
    this.dailyPnl         = a.dailyPnl         || [];
    this.pnlHistory       = a.pnlHistory       || [];
    this.hourly           = a.hourly           || Array.from({ length: 24 }, () => ({ trades: 0, pnlSol: 0, wins: 0 }));
    this.winStreak        = a.winStreak        || 0;
    this.lossStreak       = a.lossStreak       || 0;
    this.maxWinStreak     = a.maxWinStreak     || 0;
    this.maxLossStreak    = a.maxLossStreak    || 0;
  }

  record({ pnlSol, pnlPct, holdMs, symbol, solOut }) {
    this.totalTrades++;
    this.totalSoldSol    = +(this.totalSoldSol + solOut).toFixed(6);
    this.realizedPnlSol  = +(this.realizedPnlSol + pnlSol).toFixed(6);
    this.tradePnls.push(pnlPct ?? 0);
    if (this.tradePnls.length > 500) this.tradePnls.shift();

    if (pnlSol >= 0) {
      this.winCount++;
      this.winStreak++; this.lossStreak = 0;
      this.maxWinStreak = Math.max(this.maxWinStreak, this.winStreak);
      if (pnlPct !== null && (this.bestTradePct === null || pnlPct > this.bestTradePct)) {
        this.bestTradePct = pnlPct; this.bestTradeSymbol = symbol;
      }
    } else {
      this.lossCount++;
      this.lossStreak++; this.winStreak = 0;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.lossStreak);
      if (pnlPct !== null && (this.worstTradePct === null || pnlPct < this.worstTradePct)) {
        this.worstTradePct = pnlPct; this.worstTradeSymbol = symbol;
      }
    }

    this.avgHoldMs = Math.round((this.avgHoldMs * (this.totalTrades - 1) + holdMs) / this.totalTrades);

    const today = new Date().toISOString().slice(0, 10);
    const day   = this.dailyPnl.find(d => d.date === today);
    if (day) { day.pnlSol = +(day.pnlSol + pnlSol).toFixed(6); day.trades++; day.wins += pnlSol >= 0 ? 1 : 0; }
    else      { this.dailyPnl.push({ date: today, pnlSol: +pnlSol.toFixed(6), trades: 1, wins: pnlSol >= 0 ? 1 : 0 }); }
    if (this.dailyPnl.length > 90) this.dailyPnl.shift();

    this.pnlHistory.push({ ts: Date.now(), cumul: +this.realizedPnlSol.toFixed(6) });
    if (this.pnlHistory.length > 500) this.pnlHistory.shift();

    const hr = new Date().getHours();
    this.hourly[hr].trades++;
    this.hourly[hr].pnlSol = +(this.hourly[hr].pnlSol + pnlSol).toFixed(6);
    if (pnlSol >= 0) this.hourly[hr].wins++;
  }

  sharpe() {
    if (this.tradePnls.length < 5) return null;
    const s = stddev(this.tradePnls);
    return s > 0 ? +(mean(this.tradePnls) / s).toFixed(3) : null;
  }

  sortino() {
    if (this.tradePnls.length < 5) return null;
    const losses = this.tradePnls.filter(p => p < 0);
    if (!losses.length) return null;
    const ds = stddev(losses);
    return ds > 0 ? +(mean(this.tradePnls) / ds).toFixed(3) : null;
  }

  maxDrawdown() {
    let peak = 0, maxDD = 0;
    for (const { cumul } of this.pnlHistory) {
      if (cumul > peak) peak = cumul;
      const dd = peak - cumul;
      if (dd > maxDD) maxDD = dd;
    }
    return +maxDD.toFixed(6);
  }

  profitFactor() {
    const gross  = this.tradePnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const losses = Math.abs(this.tradePnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    return losses > 0 ? +(gross / losses).toFixed(3) : null;
  }

  bestDay()  { return this.dailyPnl.reduce((b, d) => d.pnlSol > (b?.pnlSol ?? -Infinity) ? d : b, null); }
  worstDay() { return this.dailyPnl.reduce((w, d) => d.pnlSol < (w?.pnlSol ??  Infinity) ? d : w, null); }
  bestHour() {
    return this.hourly.map((h, i) => ({ hour: i, ...h })).filter(h => h.trades >= 2)
      .sort((a, b) => b.pnlSol - a.pnlSol)[0] ?? null;
  }

  serialize() {
    return {
      realizedPnlSol: this.realizedPnlSol, totalBoughtSol: this.totalBoughtSol,
      totalSoldSol: this.totalSoldSol, winCount: this.winCount, lossCount: this.lossCount,
      totalTrades: this.totalTrades, bestTradePct: this.bestTradePct, worstTradePct: this.worstTradePct,
      bestTradeSymbol: this.bestTradeSymbol, worstTradeSymbol: this.worstTradeSymbol,
      avgHoldMs: this.avgHoldMs, tradePnls: this.tradePnls.slice(-500),
      dailyPnl: this.dailyPnl.slice(-90), pnlHistory: this.pnlHistory.slice(-200),
      hourly: this.hourly, winStreak: this.winStreak, lossStreak: this.lossStreak,
      maxWinStreak: this.maxWinStreak, maxLossStreak: this.maxLossStreak,
    };
  }

  toApi(history) {
    const n     = this.winCount + this.lossCount;
    const sells = history.filter(t => t.type === 'sell' && t.pnlPct != null);
    const wins  = sells.filter(t => t.pnlPct >= 0);
    const loses = sells.filter(t => t.pnlPct <  0);
    const h     = Math.floor(this.avgHoldMs / 3_600_000);
    const m     = Math.floor((this.avgHoldMs % 3_600_000) / 60_000);
    return {
      realizedPnlSol:  +this.realizedPnlSol.toFixed(4),
      totalBoughtSol:  +this.totalBoughtSol.toFixed(4),
      totalSoldSol:    +this.totalSoldSol.toFixed(4),
      roi: this.totalBoughtSol > 0 ? +((this.realizedPnlSol / this.totalBoughtSol) * 100).toFixed(2) : null,
      winCount: this.winCount, lossCount: this.lossCount, totalTrades: this.totalTrades,
      wins: this.winCount, losses: this.lossCount,
      buys: history.filter(t => t.type === 'buy').length,
      sells: sells.length,
      winRate: n > 0 ? +((this.winCount / n) * 100).toFixed(1) : null,
      avgWin:  wins.length  ? +(wins.reduce((s, t)  => s + t.pnlPct, 0) / wins.length).toFixed(1)  : null,
      avgLoss: loses.length ? +(loses.reduce((s, t) => s + t.pnlPct, 0) / loses.length).toFixed(1) : null,
      avgHold: this.avgHoldMs > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : null,
      bestTradePct: this.bestTradePct, bestTradeSymbol: this.bestTradeSymbol,
      worstTradePct: this.worstTradePct, worstTradeSymbol: this.worstTradeSymbol,
      sharpeRatio:    this.sharpe(),
      sortinoRatio:   this.sortino(),
      maxDrawdownSol: this.maxDrawdown(),
      profitFactor:   this.profitFactor(),
      winStreak: this.winStreak, maxWinStreak: this.maxWinStreak,
      lossStreak: this.lossStreak, maxLossStreak: this.maxLossStreak,
      bestDay: this.bestDay(), worstDay: this.worstDay(), bestHour: this.bestHour(),
      dailyPnl:   this.dailyPnl.slice(-30),
      pnlHistory: this.pnlHistory.slice(-200),
      hourlyStats: this.hourly,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §13  BOT LOOP
// ═══════════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor(wallet, rpc, state) {
    this.wallet    = wallet;
    this.rpc       = rpc;
    this.portfolio = [];
    this.startTime = Date.now();
    this.cycle     = 0;
    this.history   = state.trades || [];

    this.positions = new PositionManager(CFG.TP_TIERS, CFG.TP_HYSTERESIS, state);
    this.swap      = new SwapEngine(wallet, rpc);
    this.scorer    = new ScoreEngine();
    this.momentum  = new MomentumTracker();
    this.analytics = new Analytics(state);
    this.costBasis = new Map(Object.entries(state.costBasis || {}));

    // §v6 — Daily Loss Limit
    this.dailyLoss = {
      date:       this._today(),
      realizedSol: state.dailyLoss?.date === this._today() ? (state.dailyLoss?.realizedSol || 0) : 0,
      paused:     false,
    };

    // §v6 — Portfolio Value History
    this.valueHistory = state.valueHistory || []; // [{ ts, value }]
  }

  _today() {
    return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC
  }

  // ── Persistance ─────────────────────────────────────────────────────────────

  persist() {
    saveState({
      entryPrices: this.positions.serialize(),
      trades:      this.history.slice(0, 500),
      stopLossHit: Array.from(this.positions.slHit),
      slPending:   Array.from(this.positions.slPending),
      breakEven:   Array.from(this.positions.breakEven),
      analytics:   this.analytics.serialize(),
      costBasis:   Object.fromEntries(this.costBasis),
      slExits:     this.positions.serializeSlExits(),
      dailyLoss:   { date: this.dailyLoss.date, realizedSol: this.dailyLoss.realizedSol }, // §v6
      valueHistory: this.valueHistory.slice(-CFG.HISTORY_MAX_POINTS), // §v6
    });
  }

  // ── Comptabilité ─────────────────────────────────────────────────────────────

  recordBuy(mint, solSpent, tokBought) {
    const cb = this.costBasis.get(mint);
    if (cb) { cb.solSpent += solSpent; cb.tokBought += tokBought; }
    else    { this.costBasis.set(mint, { solSpent, tokBought, buyTs: Date.now() }); }
    this.analytics.totalBoughtSol = +(this.analytics.totalBoughtSol + solSpent).toFixed(6);
  }

  recordSell(mint, solOut, amountSold, symbol) {
    const cb = this.costBasis.get(mint);
    let pnlSol = null, pnlPct = null, holdMs = 0;

    if (cb?.solSpent > 0 && cb?.tokBought > 0) {
      const pct   = Math.min(amountSold / cb.tokBought, 1);
      const cost  = cb.solSpent * pct;
      pnlSol      = +(solOut - cost).toFixed(6);
      pnlPct      = cost > 0 ? +((pnlSol / cost) * 100).toFixed(2) : null;
      holdMs      = Date.now() - (cb.buyTs || Date.now());

      cb.solSpent  *= (1 - pct);
      cb.tokBought -= amountSold;
      if (cb.tokBought <= 0) this.costBasis.delete(mint);

      this.analytics.record({ pnlSol, pnlPct, holdMs, symbol, solOut });

      // §v6 — Daily Loss tracking
      this._trackDailyLoss(pnlSol);
    } else {
      this.analytics.totalSoldSol = +(this.analytics.totalSoldSol + solOut).toFixed(6);
    }
    return { pnlSol, pnlPct, holdMs };
  }

  // §v6 — Daily Loss helpers
  _trackDailyLoss(pnlSol) {
    const today = this._today();
    if (this.dailyLoss.date !== today) {
      // Nouveau jour — reset
      this.dailyLoss = { date: today, realizedSol: 0, paused: false };
      log('info', '📅 Daily Loss Limit reset (nouveau jour)');
    }
    this.dailyLoss.realizedSol = +(this.dailyLoss.realizedSol + pnlSol).toFixed(6);

    if (CFG.DAILY_LOSS_ENABLED && this.dailyLoss.realizedSol <= CFG.DAILY_LOSS_LIMIT && !this.dailyLoss.paused) {
      this.dailyLoss.paused = true;
      log('warn', `🛑 DAILY LOSS LIMIT atteint (${this.dailyLoss.realizedSol.toFixed(4)} SOL) — nouveaux achats suspendus`);
      webhook(
        '🛑 Daily Loss Limit atteint',
        `Pertes du jour : **${this.dailyLoss.realizedSol.toFixed(4)} SOL** (limite : ${CFG.DAILY_LOSS_LIMIT} SOL)\nNouveaux achats automatiques suspendus jusqu'à minuit UTC.`,
        0xff2d55,
        [{ name: 'Date', value: today, inline: true }],
      ).catch(() => {});
    }
  }

  isDailyLossPaused() {
    const today = this._today();
    if (this.dailyLoss.date !== today) {
      this.dailyLoss = { date: today, realizedSol: 0, paused: false };
    }
    return CFG.DAILY_LOSS_ENABLED && this.dailyLoss.paused;
  }

  recordTrade(entry) {
    this.history.unshift({ ...entry, ts: Date.now() });
    if (this.history.length > 500) this.history.length = 500;
  }

  // ── §NEW  Smart Sizing ─────────────────────────────────────────────────────
  /**
   * Calcule le montant SOL optimal en fonction du score.
   * Ex: score 80 avec BASE=0.05 et MULT=2 → 0.05 × (1 + (80-50)/50 × (2-1)) = 0.08 SOL
   */
  calcSmartSize(score) {
    if (!CFG.SMART_SIZE_ENABLED) return null;
    const normalized = Math.max(0, Math.min(100, score || 50));
    const factor = 1 + ((normalized - 50) / 50) * (CFG.SMART_SIZE_MULT - 1);
    const sol = CFG.SMART_SIZE_BASE * factor;
    return Math.max(CFG.SMART_SIZE_MIN, Math.min(CFG.SMART_SIZE_MAX, +sol.toFixed(4)));
  }

  // ── §NEW  Helper achat centralisé ────────────────────────────────────────
  /**
   * Exécute un achat automatique et met à jour toutes les structures.
   * Symétrique de _sell() — retourne true si l'achat a réussi.
   *
   * @param {string}  mint
   * @param {number}  solAmount
   * @param {string}  reason    — 'PYRAMID_T1', 'DCAD_T1', 'REENTRY', etc.
   * @param {object}  priceData — pd from getPrice()
   * @param {object}  opts
   *   onSuccess      — callback(result, tokBought)
   *   webhookTitle / webhookDesc / webhookColor / webhookFields
   */
  async _autoBuy(mint, solAmount, reason, priceData, opts = {}) {
    const {
      onSuccess    = null,
      webhookTitle = null,
      webhookDesc  = null,
      webhookColor = 0x3b7eff,
      webhookFields = [],
    } = opts;

    // Vérif SOL disponible
    const bal = await this.swap.getSolBalance();
    if (bal !== null && bal < solAmount + CFG.MIN_SOL_RESERVE) {
      log('warn', `_autoBuy: solde insuffisant pour ${reason}`, {
        available: bal?.toFixed(4), need: (solAmount + CFG.MIN_SOL_RESERVE).toFixed(4),
      });
      return false;
    }

    // §v6 — Daily Loss guard (sauf pour PYRAMID et DCA sur positions existantes)
    if (this.isDailyLossPaused() && !reason.startsWith('PYRAMID') && !reason.startsWith('DCAD')) {
      log('warn', `_autoBuy bloqué par Daily Loss Limit (${reason})`);
      return false;
    }

    const bps = this.scorer.slippage(priceData?.liquidity, 'normal');
    let result;
    try {
      result = await this.swap.buy(mint, solAmount, bps);
    } catch (err) {
      log('error', `_autoBuy échoué (${reason})`, { err: err.message });
      return false;
    }

    if (!result.success) {
      log('warn', `_autoBuy refusé (${reason})`, { err: result.error });
      return false;
    }

    const sym = priceData?.symbol || mint.slice(0, 8);
    const tokBought = result.outAmount || 0;

    // §FIX — Prix d'entrée exact = SOL dépensé / tokens reçus (pas le prix marché du tick suivant)
    const exactEntryPrice = tokBought > 0 ? solAmount / tokBought : (priceData?.price || 0);

    this.recordBuy(mint, solAmount, tokBought);

    // Enregistrer l'entrée IMMÉDIATEMENT avec le prix réel du swap
    // trackEntry ne fait rien si la position existe déjà (pyramid/DCA → setEntryPrice pondéré)
    if (!this.positions.entries.has(mint)) {
      // Nouvelle position — prix exact du swap
      this.positions.trackEntry(mint, exactEntryPrice, tokBought, exactEntryPrice);
    } else {
      // Position existante (pyramid/DCA) — recalculer prix moyen pondéré
      const e  = this.positions.entries.get(mint);
      const cb = this.costBasis.get(mint);
      if (e && cb && cb.tokBought > 0) {
        const avgPrice = cb.solSpent / cb.tokBought;
        e.price        = +avgPrice.toPrecision(10);
        e.bootstrapped = false;
        log('info', '📌 Prix moyen pondéré mis à jour', {
          mint: mint.slice(0, 8), avgPrice: avgPrice.toPrecision(6),
        });
      }
    }

    this.recordTrade({
      type: 'buy', mint, symbol: sym,
      solSpent: solAmount, outAmount: tokBought,
      entryPrice: exactEntryPrice,
      reason, txId: result.sig, txUrl: result.txUrl,
    });

    if (onSuccess) onSuccess(result, result.outAmount || 0);

    if (webhookTitle) {
      await webhook(
        `🟢 ${webhookTitle}`,
        `${webhookDesc || ''} | ${sym} +${result.outAmount?.toFixed(4)} tokens`,
        webhookColor,
        [...webhookFields,
          { name: 'SOL investis', value: solAmount.toFixed(4), inline: true },
          { name: 'Raison',       value: reason,               inline: true },
        ],
      );
    }
    return true;
  }

  // ── Helper vente centralisé ───────────────────────────────────────────────────
  /**
   * Exécute une vente automatique et met à jour toutes les structures.
   * Retourne true si la vente a réussi.
   *
   * @param {object} opts
   *   useJito        — bool
   *   slippage       — number|null (null = auto depuis scorer)
   *   pendingFirst   — marquer slPending AVANT la vente (SL/AR/LE)
   *   markSLDone     — marquer slHit après succès
   *   onSuccess      — callback(result) pour TP (markTierDone etc.)
   *   webhookTitle/Desc/Color/Fields
   */
  async _sell(mint, sellAmount, reason, priceData, opts = {}) {
    const {
      useJito = false,
      slippage = null,
      pendingFirst = false,
      markSLDone   = false,
      onSuccess    = null,
      webhookTitle = null,
      webhookDesc  = null,
      webhookColor = 0x3b7eff,
      webhookFields = [],
    } = opts;

    if (pendingFirst) this.positions.markSLPending(mint);

    const urgency = useJito ? 'emergency' : pendingFirst ? 'high' : 'normal';
    const bps     = slippage ?? this.scorer.slippage(priceData?.liquidity, urgency);

    const res = await this.swap.sell(mint, sellAmount, reason, bps, useJito);

    if (res.success) {
      const symbol = priceData?.symbol || mint.slice(0, 8);
      const { pnlSol, pnlPct } = this.recordSell(mint, res.solOut, sellAmount, symbol);
      this.recordTrade({
        type: 'sell', mint, symbol,
        amount: sellAmount, solOut: res.solOut, reason,
        txId: res.sig, txUrl: res.txUrl, pnlSol, pnlPct,
      });
      if (markSLDone) {
        // §NEW — enregistre prix d'exit pour éventuelle re-entry
        this.positions.markExitForReentry(mint, priceData?.price || 0);
        this.positions.markSLDone(mint);
      }
      if (onSuccess)  onSuccess(res);
      if (webhookTitle) {
        const ok    = pnlSol !== null && pnlSol >= 0;
        const pnlStr = pnlPct !== null ? ` | ${pnlPct >= 0 ? '+' : ''}${pnlPct}%` : '';
        await webhook(
          `${ok ? '✅' : '🔴'} ${webhookTitle}`,
          `${webhookDesc || ''}${pnlStr}`,
          ok ? 0x05d488 : webhookColor,
          [...webhookFields,
            { name: 'SOL reçu', value: res.solOut?.toFixed(6) || '?', inline: true },
            { name: 'Raison',   value: reason,                         inline: true },
          ],
        );
      }
      return true;
    }

    // Si CB a bloqué la vente : garder slPending actif pour bloquer pyramid/DCA
    // Si échec réel (slippage, etc.) : effacer slPending pour réessayer au prochain cycle
    if (pendingFirst && !res.cbBlocked) this.positions.clearSLPending(mint);
    return false;
  }

  // ── Tick principal ────────────────────────────────────────────────────────────

  async tick() {
    try {
      if (this.cycle % 10 === 0) await this.rpc.healthCheck();
      this.cycle++;

      // Lecture des comptes token (SPL + SPL-2022)
      const [r1, r2] = await Promise.all([
        this.rpc.conn.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(SPL_TOKEN) }),
        this.rpc.conn.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(SPL_2022)  }),
      ]);

      const accounts = [...r1.value, ...r2.value].filter(acc => {
        const info = acc.account.data.parsed.info;
        // Exclure SOL natif ET USDC — traités séparément en fin de tick
        if (info.mint === SOL_MINT)  return false;
        if (info.mint === USDC_MINT) return false;
        const ta = info.tokenAmount;
        return parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0') > 0;
      });

      await prefetchPrices(accounts.map(a => a.account.data.parsed.info.mint));

      const tokens = [];

      for (const acc of accounts) {
        const info  = acc.account.data.parsed.info;
        const mint  = info.mint;
        const ta    = info.tokenAmount;
        const bal   = parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0');
        if (!(bal > 0)) continue;

        const pd    = getPrice(mint);
        const price = pd?.price || 0;

        this.positions.trackEntry(mint, price, bal);

        const pnl = this.positions.getPnl(mint, price);
        if (pnl !== null) this.positions.updatePeak(mint, pnl);
        if (price > 0) this.momentum.addPrice(mint, price);

        // ── Stratégies de sortie (ordre de priorité décroissant) ─────────────

        if (price > 0) {
          const sym = pd?.symbol || mint.slice(0, 8);

          // 1. Anti-rug PRIX — urgence max, Jito si disponible
          const ar = this.positions.checkAR(mint, price);
          if (ar) {
            log('error', `🚨 ANTI-RUG -${ar.drop}%`, { mint: mint.slice(0, 8), sym });
            await this._sell(mint, ar.sellAmount, 'ANTI_RUG', pd, {
              useJito: true, pendingFirst: true, markSLDone: true,
              webhookTitle: 'Anti-Rug', webhookDesc: `Chute -${ar.drop}% sur **${sym}**`, webhookColor: 0xff2d55,
            });
          }

          // 2. Liquidity exit — rug via liquidité
          const le = this.positions.checkLE(mint);
          if (le) {
            log('error', `🚨 LIQUIDITY EXIT -${le.drop}%`, { mint: mint.slice(0, 8) });
            await this._sell(mint, le.sellAmount, 'LIQ_EXIT', pd, {
              useJito: true, pendingFirst: true, markSLDone: true,
              webhookTitle: 'Liquidity Exit', webhookDesc: `Liq -${le.drop}% sur **${sym}**`, webhookColor: 0xff4500,
            });
          }

          // 3. Take-profit paliers
          if (CFG.TP_ENABLED && pnl !== null) {
            for (const hit of this.positions.checkTP(mint, price)) {
              log('warn', `🎯 TP T${hit.idx + 1} +${hit.currentPnl}%`, { mint: mint.slice(0, 8), sell: hit.sellAmount.toFixed(4) });
              await this._sell(mint, hit.sellAmount, `TP_T${hit.idx + 1}`, pd, {
                onSuccess: () => this.positions.markTierDone(mint, hit.idx, hit.sellAmount),
                webhookTitle:  `Take-Profit T${hit.idx + 1}`,
                webhookDesc:   `+${hit.currentPnl}% sur **${sym}**`,
                webhookColor:  0x00d97e,
                webhookFields: [{ name: 'Vendu', value: hit.sellAmount.toFixed(4), inline: true }],
              });
            }
            this.positions.resetTiersIfNeeded(mint, pnl);
          }

          // 4. Break-even stop / Stop-loss fixe
          const sl = this.positions.checkSL(mint, price);
          if (sl) {
            const label = sl.type === 'break-even' ? 'Break-Even' : 'Stop-Loss';
            log('warn', `🔴 ${label.toUpperCase()} ${sl.pnl}%`, { mint: mint.slice(0, 8) });
            await this._sell(mint, sl.sellAmount, sl.type.toUpperCase().replace('-', '_'), pd, {
              pendingFirst: true, markSLDone: true,
              webhookTitle: label, webhookDesc: `**${sym}** à ${sl.pnl}%`, webhookColor: 0xff2d55,
            });
          }

          // 5. Trailing stop (adaptatif σ si activé)
          const ts = this.positions.checkTS(mint, price, this.momentum);
          if (ts) {
            log('warn', `📉 TRAILING pic:+${ts.peak}% actuel:${ts.pnl}% (seuil:-${ts.trailingPct.toFixed(1)}%)`, { mint: mint.slice(0, 8) });
            await this._sell(mint, ts.sellAmount, 'TRAILING_STOP', pd, {
              pendingFirst: true, markSLDone: true,
              webhookTitle: 'Trailing Stop',
              webhookDesc: `**${sym}** — Pic: +${ts.peak}%, Actuel: ${ts.pnl}%`, webhookColor: 0xff9800,
            });
          }

          // 6. Time-based stop
          const tt = this.positions.checkTT(mint, pnl);
          if (tt) {
            log('warn', `⏱ TIME STOP ${tt.holdHours}h`, { mint: mint.slice(0, 8) });
            await this._sell(mint, tt.sellAmount, 'TIME_STOP', pd, {
              pendingFirst: true, markSLDone: true,
              webhookTitle: 'Time Stop',
              webhookDesc: `**${sym}** stagnant depuis ${tt.holdHours}h`, webhookColor: 0x9b59b6,
            });
          }

          // 7. Momentum exit
          const me = this.positions.checkME(mint, price, this.momentum);
          if (me) {
            log('warn', `🔄 MOMENTUM EXIT vel:${me.trend.velocity}%/cycle`, { mint: mint.slice(0, 8) });
            await this._sell(mint, me.sellAmount, 'MOMENTUM_EXIT', pd, {
              pendingFirst: true, markSLDone: true,
              webhookTitle: 'Momentum Exit',
              webhookDesc: `**${sym}** — retournement (${me.trend.velocity}%/cycle)`, webhookColor: 0xff9800,
            });
          }
        }

        this.positions.updatePrevPrice(mint, price);
        const score = this.scorer.score(pd);

        // ── §NEW  Stratégies d'ENTRÉE automatique ───────────────────────────

        if (price > 0 && bal > 0) {
          const sym = pd?.symbol || mint.slice(0, 8);

          // 8. Pyramid In — ajoute quand le PnL monte
          if (CFG.PYRAMID_ENABLED) {
            const pyramidHits = this.positions.checkPyramid(mint, price);
            for (const hit of pyramidHits) {
              log('info', `📈 PYRAMID T${hit.idx + 1} +${hit.currentPnl}% — ajout ${hit.addSol} SOL`, { mint: mint.slice(0, 8) });
              await this._autoBuy(mint, hit.addSol, `PYRAMID_T${hit.idx + 1}`, pd, {
                onSuccess: (res, tokBought) => this.positions.markPyramidDone(mint, hit.idx, tokBought, hit.addSol),
                webhookTitle:  `Pyramid T${hit.idx + 1}`,
                webhookDesc:   `+${hit.currentPnl}% — renforcement sur **${sym}**`,
                webhookColor:  0x00bfff,
                webhookFields: [{ name: 'Ajout', value: hit.addSol.toFixed(4) + ' SOL', inline: true }],
              });
            }
            if (pyramidHits.length) this.positions.resetPyramidIfNeeded(mint, pnl);
          }

          // 9. DCA-Down — renforce quand le PnL plonge (si momentum ralentit)
          if (CFG.DCAD_ENABLED) {
            const dcadHits = this.positions.checkDCADown(mint, price, this.momentum);
            for (const hit of dcadHits) {
              log('info', `📉 DCA-DOWN T${hit.idx + 1} ${hit.currentPnl}% — ajout ${hit.addSol} SOL`, { mint: mint.slice(0, 8) });
              await this._autoBuy(mint, hit.addSol, `DCAD_T${hit.idx + 1}`, pd, {
                onSuccess: (res, tokBought) => this.positions.markDCADownDone(mint, hit.idx, tokBought, hit.addSol),
                webhookTitle:  `DCA-Down T${hit.idx + 1}`,
                webhookDesc:   `${hit.currentPnl}% — moyenne à la baisse **${sym}**`,
                webhookColor:  0xff9800,
                webhookFields: [{ name: 'Ajout', value: hit.addSol.toFixed(4) + ' SOL', inline: true }],
              });
            }
          }
        }

        tokens.push({
          mint:             mint.slice(0, 8) + '…' + mint.slice(-4),
          mintFull:         mint,
          balance:          parseFloat(bal.toFixed(6)),
          price:            price > 0  ? price : null,
          value:            parseFloat((bal * price).toFixed(4)),
          liquidity:        pd?.liquidity  || 0,
          volume24h:        pd?.volume24h  || 0,
          volume1h:         pd?.volume1h   || 0,
          change24h:        pd?.change24h  || 0,
          change1h:         pd?.change1h   || 0,
          fdv:              pd?.fdv         || 0,
          mcap:             pd?.mcap        || 0,
          logo:             pd?.logo        || null,
          symbol:           pd?.symbol      || null,
          name:             pd?.name        || null,
          pnl,
          peakPnl:          this.positions.peak.get(mint)              || null,
          entryPrice:       this.positions.entries.get(mint)?.price    || null,
          bootstrapped:     this.positions.entries.get(mint)?.bootstrapped || false,
          remainingBalance: this.positions.getRemaining(mint),
          triggeredTiers:   Array.from(this.positions.triggered.get(mint) || []).map(i => CFG.TP_TIERS[i]?.pnl),
          stopLossHit:      this.positions.slHit.has(mint),
          breakEven:        this.positions.breakEven.has(mint),
          liqDrop:          getLiqDrop(mint),
          score,
          momentum:         price > 0 ? this.momentum.getTrend(mint) : null,
          failCount:        _failCount.get(mint) || 0,
        });
      }

      this.portfolio = tokens.sort((a, b) => b.value - a.value);

      // ── Ajouter SOL natif au portfolio ────────────────────────────────────
      try {
        const solBal = await this.swap.getSolBalance();
        if (solBal !== null && solBal > 0) {
          // Chercher le prix SOL depuis DexScreener via priceCache
          await prefetchPrices([SOL_MINT]);
          const solPd    = getPrice(SOL_MINT);
          const solPrice = solPd?.price || null;
          tokens.push({
            mint:         SOL_MINT.slice(0, 8) + '…' + SOL_MINT.slice(-4),
            mintFull:     SOL_MINT,
            balance:      parseFloat(solBal.toFixed(6)),
            price:        solPrice,
            value:        solPrice ? parseFloat((solBal * solPrice).toFixed(4)) : null,
            liquidity:    solPd?.liquidity  || 0,
            volume24h:    solPd?.volume24h  || 0,
            symbol:       'SOL',
            name:         'Solana',
            logo:         'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
            pnl:          null,
            peakPnl:      null,
            entryPrice:   null,
            bootstrapped: false,
            isSol:        true,
            score:        null,
          });
        }
      } catch (err) { log('warn', 'SOL portfolio entry failed', { err: err.message }); }

      // ── Ajouter USDC au portfolio si solde > 0 ────────────────────────────
      try {
        const usdcBal = await this.swap.getUsdcBalance();
        if (usdcBal !== null && usdcBal > 0.01) {
          tokens.push({
            mint:         USDC_MINT.slice(0, 8) + '…' + USDC_MINT.slice(-4),
            mintFull:     USDC_MINT,
            balance:      parseFloat(usdcBal.toFixed(4)),
            price:        1.0,
            value:        parseFloat(usdcBal.toFixed(4)),
            liquidity:    0,
            volume24h:    0,
            symbol:       'USDC',
            name:         'USD Coin',
            logo:         'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
            pnl:          null,
            peakPnl:      null,
            entryPrice:   null,
            bootstrapped: false,
            isUsdc:       true,
            score:        null,
          });
        }
      } catch (err) { log('warn', 'USDC portfolio entry failed', { err: err.message }); }

      this.portfolio = tokens.sort((a, b) => (b.value || 0) - (a.value || 0));
      const tv = tokens.reduce((s, t) => s + t.value, 0);

      // ── §NEW  Re-entry sur tokens stoppés ─────────────────────────────────
      // On parcourt les tokens stoppés (slHit) qui NE sont plus dans le portfolio
      // (vendus complètement) et vérifie si les conditions de re-entry sont remplies.
      if (CFG.REENTRY_ENABLED) {
        const portfolioMints = new Set(tokens.map(t => t.mintFull));
        for (const mint of Array.from(this.positions.slHit)) {
          if (portfolioMints.has(mint)) continue; // encore en portefeuille, skip
          await prefetchPrices([mint]);
          const pd    = getPrice(mint);
          const price = pd?.price || 0;
          if (!(price > 0)) continue;

          const score   = this.scorer.score(pd);
          const reentry = this.positions.checkReentry(mint, price, score);
          if (!reentry) continue;

          log('info', `🔄 RE-ENTRY possible — rebond +${reentry.reboundPct}% score:${score}`, { mint: mint.slice(0, 8) });
          this.positions.clearForReentry(mint);

          const ok = await this._autoBuy(mint, reentry.solAmount, 'REENTRY', pd, {
            webhookTitle:  'Re-Entry automatique',
            webhookDesc:   `Rebond +${reentry.reboundPct}% depuis SL | Score: ${score}/100`,
            webhookColor:  0x7b68ee,
            webhookFields: [{ name: 'Montant', value: reentry.solAmount.toFixed(4) + ' SOL', inline: true }],
          });

          if (!ok) {
            // Échec re-entry — on réactive slHit pour éviter boucle infinie
            this.positions.slHit.add(mint);
          } else {
            // Attendre le prochain tick pour trackEntry avec le vrai prix
            await sleep(3000);
          }
        }
      }

      log('debug', 'Cycle done', { tokens: tokens.length, total: `$${tv.toFixed(2)}`, cycle: this.cycle });

      // §v6 — Portfolio Value History snapshot (toutes les 10 cycles)
      if (this.cycle % 10 === 0) {
        const solPd    = getPrice(SOL_MINT);
        const solPrice = solPd?.price || 0;
        this.valueHistory.push({ ts: Date.now(), valueSol: +tv.toFixed(4), solPriceUsd: +solPrice.toFixed(2) });
        if (this.valueHistory.length > CFG.HISTORY_MAX_POINTS) this.valueHistory.shift();
      }

      // §v6 — Reset Daily Loss à minuit UTC
      this._today(); // force le check (remet paused=false si nouveau jour)

      // §v6 — Auto-correction positions bootstrappées (cycle 1 + toutes les 20 cycles)
      if (this.cycle === 1 || this.cycle % 20 === 0) {
        const bootedCount = [...this.positions.entries.values()].filter(e => e.bootstrapped).length;
        if (bootedCount > 0) {
          this.autoScanBootstrapped().catch(err =>
            log('warn', 'autoScanBootstrapped error', { err: err.message })
          );
        }
      }

      if (this.cycle % 10 === 0) this.persist();
    } catch (err) {
      log('error', 'Tick error', { err: err.message });
      this.rpc.failover();
    }
  }

  // ── §v6  Auto-correction positions bootstrappées ──────────────────────────

  /**
   * Pour un mint donné, interroge l'historique Helius (SWAP) et retrouve
   * le dernier achat (SOL → token) pour en déduire le prix d'entrée exact.
   * Retourne { entryPrice, solSpent, tokReceived, ts } ou null.
   */
  async _heliusFindEntryPrice(mint, walletStr) {
    if (!CFG.HELIUS_KEY) return null;
    const base = `https://api.helius.xyz/v0/addresses/${walletStr}/transactions?api-key=${CFG.HELIUS_KEY}&limit=100`;
    let before = null;
    const MAX_PAGES = 5;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = base + (before ? `&before=${before}` : '');
      let txs;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
        if (!r.ok) break;
        txs = await r.json();
        if (!Array.isArray(txs) || !txs.length) break;
      } catch { break; }

      for (const tx of txs) {
        // Chercher un token transfer ENTRANT pour ce mint
        const recv = (tx.tokenTransfers || []).find(
          t => t.mint === mint && t.toUserAccount === walletStr && parseFloat(t.tokenAmount) > 0
        );
        if (!recv) continue;

        // SOL sorti du wallet dans cette tx
        const solOut = (tx.nativeTransfers || [])
          .filter(n => n.fromUserAccount === walletStr)
          .reduce((s, n) => s + (n.amount || 0), 0) / 1e9;

        const tokReceived = parseFloat(recv.tokenAmount);
        if (solOut > 0 && tokReceived > 0) {
          return {
            entryPrice: solOut / tokReceived,
            solSpent:   solOut,
            tokReceived,
            ts: (tx.timestamp || 0) * 1000,
          };
        }
      }

      // Pagination : reprendre depuis la dernière signature
      before = txs[txs.length - 1]?.signature;
      if (!before) break;
      await sleep(200);
    }
    return null;
  }

  /**
   * Scan toutes les positions bootstrappées et tente de corriger leur prix.
   * Appelé automatiquement au démarrage et toutes les 20 cycles.
   */
  async autoScanBootstrapped() {
    const walletStr = this.wallet.publicKey.toString();
    const booted = [...this.positions.entries.entries()]
      .filter(([, e]) => e.bootstrapped)
      .map(([m]) => m);

    if (!booted.length) return;
    if (!CFG.HELIUS_KEY) {
      log('warn', `⚠️  ${booted.length} positions bootstrappées — HELIUS_API_KEY manquant, correction impossible`);
      return;
    }

    log('info', `🔍 Auto-scan Helius — ${booted.length} positions bootstrappées à corriger`);
    let fixed = 0;

    for (const mint of booted) {
      try {
        const found = await this._heliusFindEntryPrice(mint, walletStr);

        if (found?.entryPrice > 0) {
          const old = this.positions.entries.get(mint)?.price;
          this.positions.setEntryPrice(mint, found.entryPrice);
          // Mettre à jour costBasis si absent ou incomplet
          if (!this.costBasis.has(mint) || this.costBasis.get(mint)?.solSpent === 0) {
            this.costBasis.set(mint, {
              solSpent:   found.solSpent,
              tokBought:  found.tokReceived,
              buyTs:      found.ts || Date.now(),
            });
          }
          log('success', `✅ Bootstrap corrigé ${mint.slice(0, 8)}`, {
            old: old?.toPrecision(4) || '?',
            new: found.entryPrice.toPrecision(4),
            sol: found.solSpent.toFixed(4),
          });
          fixed++;
        } else {
          // Helius n'a pas trouvé la tx — fallback : costBasis existant
          const cb = this.costBasis.get(mint);
          if (cb?.solSpent > 0 && cb?.tokBought > 0) {
            const fallbackPrice = cb.solSpent / cb.tokBought;
            this.positions.setEntryPrice(mint, fallbackPrice);
            log('info', `📌 Bootstrap corrigé (fallback costBasis) ${mint.slice(0, 8)}`, {
              price: fallbackPrice.toPrecision(4),
            });
            fixed++;
          } else {
            log('debug', `Bootstrap non résolu ${mint.slice(0, 8)} — tx introuvable`);
          }
        }
        await sleep(300); // rate limit Helius
      } catch (err) {
        log('warn', `Bootstrap scan error ${mint.slice(0, 8)}: ${err.message}`);
      }
    }

    if (fixed > 0) {
      this.persist();
      log('info', `✅ Bootstrap: ${fixed}/${booted.length} positions corrigées`);
    }
  }

  // ── Stats publiques ────────────────────────────────────────────────────────

  getStats() {
    const tv   = this.portfolio.reduce((s, t) => s + t.value, 0);
    const pnls = this.portfolio.filter(t => t.pnl !== null).map(t => t.pnl);
    const avg  = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
    return {
      version:    VERSION,
      uptime:     Math.round((Date.now() - this.startTime) / 1000),
      cycles:     this.cycle,
      tokens:     this.portfolio.length,
      totalValue: +tv.toFixed(4),
      pnlStats: {
        avg:      avg !== null ? +avg.toFixed(2) : null,
        best:     pnls.length ? +Math.max(...pnls).toFixed(2) : null,
        worst:    pnls.length ? +Math.min(...pnls).toFixed(2) : null,
        positive: pnls.filter(p => p >= 0).length,
        negative: pnls.filter(p => p  < 0).length,
      },
      strategy: {
        tp:        CFG.TP_ENABLED  ? `${CFG.TP_TIERS.length} paliers` : 'OFF',
        sl:        CFG.SL_ENABLED  ? `${CFG.SL_PCT}%` : 'OFF',
        breakEven: CFG.BE_ENABLED  ? `+${CFG.BE_BUFFER}%` : 'OFF',
        trailing:  CFG.TS_ENABLED  ? `${CFG.TS_PCT}%${CFG.TS_VOL ? ' σ-adaptatif' : ''}` : 'OFF',
        antiRug:   CFG.AR_ENABLED  ? `>${CFG.AR_PCT}%/cycle` : 'OFF',
        liqExit:   CFG.LE_ENABLED  ? `>${CFG.LE_PCT}% chute liq` : 'OFF',
        timeStop:  CFG.TT_ENABLED  ? `>${CFG.TT_HOURS}h stagnant` : 'OFF',
        momentum:  CFG.ME_ENABLED  ? `${CFG.ME_THRESHOLD}%/cycle` : 'OFF',
        jito:      CFG.JITO_ENABLED? `${CFG.JITO_TIP_SOL} SOL tip` : 'OFF',
        // §NEW
        pyramid:   CFG.PYRAMID_ENABLED ? `${CFG.PYRAMID_TIERS.length} paliers, max ${CFG.PYRAMID_MAX_SOL} SOL` : 'OFF',
        dcaDown:   CFG.DCAD_ENABLED    ? `${CFG.DCAD_TIERS.length} paliers, max ${CFG.DCAD_MAX_ADDS} adds` : 'OFF',
        reentry:   CFG.REENTRY_ENABLED ? `délai ${CFG.REENTRY_DELAY_MIN}min, rebond +${CFG.REENTRY_MIN_GAIN}%` : 'OFF',
        smartSize: CFG.SMART_SIZE_ENABLED ? `base ${CFG.SMART_SIZE_BASE}→${CFG.SMART_SIZE_MAX} SOL` : 'OFF',
      },
      negCacheSize:       _negCache.size,
      sellCircuitBreaker: this.swap.sellFailures,
      cbTrippedAt:        this.swap._cbTrippedAt ? new Date(this.swap._cbTrippedAt).toISOString() : null,
      cbAutoResetIn:      this.swap._cbTrippedAt ? Math.max(0, Math.round((5*60000 - (Date.now() - this.swap._cbTrippedAt)) / 1000)) : null,
      lastUpdate:         new Date().toISOString(),
      // §v6
      dailyLoss: {
        enabled:     CFG.DAILY_LOSS_ENABLED,
        limit:       CFG.DAILY_LOSS_LIMIT,
        today:       this.dailyLoss.date,
        realizedSol: +this.dailyLoss.realizedSol.toFixed(6),
        paused:      this.dailyLoss.paused,
        remaining:   +(CFG.DAILY_LOSS_LIMIT - this.dailyLoss.realizedSol).toFixed(6),
      },
      scannerEnabled: CFG.SCANNER_ENABLED,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §16  TOKEN SCANNER — Détection automatique nouveaux tokens
// ═══════════════════════════════════════════════════════════════════════════════

class TokenScanner {
  /**
   * Deux sources de détection :
   * 1. WebSocket Solana RPC standard (logsSubscribe) — temps réel via Helius RPC gratuit
   * 2. Polling DexScreener /token-profiles/latest — toutes les SCANNER_POLL_SEC secondes
   *
   * Les deux alimentent la même file d'évaluation (_processQueue).
   */
  constructor(bot) {
    this.bot       = bot;
    this.seen      = new Set();
    this.pending   = new Set();   // mints dans la queue non encore évalués
    this.cooldowns = new Map();
    this.queue     = [];
    this.ws        = null;
    this.wsId      = 0;
    this.running   = false;
    this.reconnects = 0;
    this.lastPollTs = 0;
    this.stats = { detected: 0, evaluated: 0, bought: 0, rejected: 0, errors: 0 };
  }

  start() {
    this.running = true;
    log('info', '🔍 TokenScanner démarré (WS + polling DexScreener)');
    this._connectWs();
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }

  // ── WebSocket RPC standard (logsSubscribe) ─────────────────────────────────

  _wsUrl() {
    // Helius RPC WS standard (gratuit) — pas atlas-mainnet (payant)
    if (CFG.HELIUS_KEY) return `wss://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_KEY}`;
    // Fallback public Solana
    return 'wss://api.mainnet-beta.solana.com';
  }

  _connectWs() {
    if (!this.running) return;
    const url = this._wsUrl();
    log('info', `🔗 Scanner WS connexion (tentative ${this.reconnects + 1})`);

    let WebSocket;
    try { WebSocket = require('ws'); } catch {
      log('warn', 'Module ws absent — scanner WebSocket désactivé');
      return;
    }

    try { this.ws = new WebSocket(url); } catch (e) {
      log('warn', `Scanner WS init error: ${e.message}`);
      this._scheduleWsReconnect();
      return;
    }

    this.ws.on('open', () => {
      log('success', '✅ Scanner WS connecté');
      this.reconnects = 0;
      for (const programId of CFG.SCANNER_PROGRAMS) {
        this.ws.send(JSON.stringify({
          jsonrpc: '2.0', id: ++this.wsId,
          method: 'logsSubscribe',
          params: [{ mentions: [programId] }, { commitment: 'confirmed' }],
        }));
      }
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'logsNotification') this._handleLogs(msg.params?.result?.value);
      } catch {}
    });

    this.ws.on('error', (e) => log('warn', `Scanner WS error: ${e.message}`));
    this.ws.on('close', () => {
      log('warn', 'Scanner WS fermé — reconnexion...');
      this._scheduleWsReconnect();
    });
  }

  _scheduleWsReconnect() {
    if (!this.running) return;
    this.reconnects++;
    // Après 3 échecs consécutifs (403 = endpoint payant), on arrête les tentatives WS
    // Le polling DexScreener prend le relais automatiquement
    if (this.reconnects >= 3) {
      log('warn', `Scanner WS abandonné après ${this.reconnects} échecs — polling DexScreener actif`);
      return; // pas de setTimeout → WS définitivement désactivé
    }
    const delay = Math.min(10000 * this.reconnects, 60000);
    setTimeout(() => this._connectWs(), delay);
  }

  // ── Validation d'une adresse mint Solana ──────────────────────────────────

  _isValidMint(addr) {
    // Une adresse Solana valide = 32-44 chars base58
    if (!addr || addr.length < 32 || addr.length > 44) return false;
    // Alphabet base58 strict (pas de 0, O, I, l)
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) return false;
    // Rejeter les faux positifs : données binaires encodées ont des runs de chars répétés
    // ex: AAAAAAAA, SQAAAAAA, eAAAAAAA — jamais dans une vraie adresse
    if (/(.)\1{4,}/.test(addr)) return false;
    // Rejeter si > 60% du string est un seul caractère (données nulles)
    const charCounts = {};
    for (const c of addr) charCounts[c] = (charCounts[c] || 0) + 1;
    const maxFreq = Math.max(...Object.values(charCounts));
    if (maxFreq / addr.length > 0.5) return false;
    // Rejeter les adresses connues non-token
    if (addr === SOL_MINT || addr === USDC_MINT) return false;
    if (CFG.SCANNER_PROGRAMS.includes(addr)) return false;
    // Rejeter les adresses système Solana communes
    const SYSTEM_ADDRS = new Set([
      '11111111111111111111111111111111',          // System program
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',  // ATA
      'ComputeBudget111111111111111111111111111111',
      'Sysvar1nstructions1111111111111111111111111',
      'SysvarRent111111111111111111111111111111111',
      'SysvarC1ock11111111111111111111111111111111',
    ]);
    if (SYSTEM_ADDRS.has(addr)) return false;
    return true;
  }

  _handleLogs(value) {
    if (!value?.logs || !value?.signature) return;
    const logs = value.logs;

    const isRaydiumInit = logs.some(l => l.includes('initialize2') || l.includes('InitializePool'));
    const isPumpGrad    = logs.some(l => l.includes('MigrateFunds') || l.includes('Migrate'));
    const isPumpCreate  = logs.some(l => l.includes('Create') && l.includes('Program log'));
    if (!isRaydiumInit && !isPumpGrad && !isPumpCreate) return;

    const mintCandidates = new Set();
    for (const l of logs) {
      // Chercher dans les logs "Program log: ..." des adresses mint explicitement mentionnées
      const matches = l.match(/[1-9A-HJ-NP-Za-km-z]{43,44}/g) || [];
      for (const m of matches) {
        if (this._isValidMint(m)) mintCandidates.add(m);
      }
    }

    const reason = isRaydiumInit ? 'RAYDIUM_NEW' : isPumpGrad ? 'PUMP_GRAD' : 'PUMP_NEW';
    for (const mint of mintCandidates) this._enqueue(mint, reason);
  }

  // ── Polling DexScreener /token-profiles/latest ─────────────────────────────

  async _pollDexScreener() {
    try {
      const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json' },
      });
      if (!r.ok) return;
      const items = await r.json();
      if (!Array.isArray(items)) return;

      for (const item of items) {
        const mint = item?.tokenAddress;
        const chain = item?.chainId;
        if (!mint || chain !== 'solana') continue;
        if (!this._isValidMint(mint)) continue;   // filtre adresses invalides
        this._enqueue(mint, 'DEX_LATEST');
      }
    } catch (err) {
      log('debug', `Scanner poll error: ${err.message}`);
    }
  }

  // ── Boucle principale ──────────────────────────────────────────────────────

  async _loop() {
    while (this.running) {
      await sleep(3000);

      // Polling DexScreener toutes les SCANNER_POLL_SEC (défaut 30s)
      const pollIntervalMs = (CFG.SCANNER_POLL_SEC || 30) * 1000;
      if (Date.now() - this.lastPollTs >= pollIntervalMs) {
        this.lastPollTs = Date.now();
        await this._pollDexScreener().catch(() => {});
      }

      // Traiter la file
      const now   = Date.now();
      const ready = this.queue.filter(e => e.ts <= now);
      this.queue  = this.queue.filter(e => e.ts > now);

      for (const entry of ready) {
        try { await this._evaluate(entry.mint, entry.reason); }
        catch (err) {
          this.stats.errors++;
          log('warn', `Scanner eval error: ${err.message}`);
        }
        await sleep(400);
      }
    }
  }

  // ── Enfile un mint (dédup strict : seen + pending + cooldown) ─────────────

  _enqueue(mint, reason) {
    if (!this._isValidMint(mint)) return;          // adresse invalide
    if (this.seen.has(mint))    return;            // déjà évalué
    if (this.pending.has(mint)) return;            // déjà dans la queue
    if (_negCache.has(mint))    return;            // token mort connu

    const last = this.cooldowns.get(mint) || 0;
    if (Date.now() - last < CFG.SCANNER_COOLDOWN_MS) return;

    this.seen.add(mint);
    this.pending.add(mint);
    this.stats.detected++;
    log('info', `🆕 Scanner détecté: ${mint.slice(0, 8)}… (${reason})`);
    this.queue.push({ mint, reason, ts: Date.now() + CFG.SCANNER_DELAY_MS });
  }

  // ── Évaluation et achat potentiel ─────────────────────────────────────────

  async _evaluate(mint, reason) {
    this.cooldowns.set(mint, Date.now());
    this.pending.delete(mint); // libérer même si on rejette

    const already = this.bot.portfolio.find(t => t.mintFull === mint);
    if (already) { this.stats.rejected++; return; }

    // Ne compter que les positions actives (valeur ≥ $0.10 et prix connu)
    // Les tokens morts/rugpullés à $0 ne bloquent pas les nouveaux achats du scanner
    const openPositions = this.bot.portfolio.filter(t =>
      !t.isSol && !t.isUsdc && t.balance > 0 && t.price > 0 && (t.value || 0) >= 0.10
    ).length;
    if (openPositions >= CFG.MAX_POSITIONS) {
      log('debug', `Scanner skip — max positions actives atteint (${openPositions}/${CFG.MAX_POSITIONS})`);
      this.stats.rejected++;
      return;
    }

    if (this.bot.isDailyLossPaused()) {
      log('warn', 'Scanner skip — Daily Loss Limit actif');
      this.stats.rejected++;
      return;
    }

    await prefetchPrices([mint]);
    const pd = getPrice(mint);

    if (!pd || !pd.price || pd.price <= 0) { this.stats.rejected++; return; }

    const liq = pd.liquidity || 0;
    if (liq < CFG.SCANNER_MIN_LIQ || liq > CFG.SCANNER_MAX_LIQ) {
      log('debug', `Scanner reject — liq $${liq.toFixed(0)} hors plage [$${CFG.SCANNER_MIN_LIQ}-$${CFG.SCANNER_MAX_LIQ}]`);
      this.stats.rejected++;
      return;
    }

    const score = this.bot.scorer.score(pd);
    this.stats.evaluated++;

    if (score < CFG.SCANNER_MIN_SCORE) {
      log('debug', `Scanner reject — score ${score} < ${CFG.SCANNER_MIN_SCORE}`, { mint: mint.slice(0, 8), sym: pd.symbol });
      this.stats.rejected++;
      return;
    }

    const solAmount = this.bot.calcSmartSize(score) || CFG.SCANNER_SOL_AMOUNT;
    log('info', `🟢 Scanner BUY — score:${score} liq:$${liq.toFixed(0)} sol:${solAmount}`, { mint: mint.slice(0, 8), sym: pd.symbol, reason });

    const ok = await this.bot._autoBuy(mint, solAmount, `SCANNER_${reason}`, pd, {
      webhookTitle:  'Scanner — Nouveau token',
      webhookDesc:   `**${pd.symbol || mint.slice(0, 8)}** | Score: **${score}/100** | Liq: $${liq.toFixed(0)}`,
      webhookColor:  0x00d9ff,
      webhookFields: [
        { name: 'Raison',    value: reason,               inline: true },
        { name: 'SOL',       value: solAmount.toFixed(4), inline: true },
        { name: 'Score',     value: `${score}/100`,       inline: true },
        { name: 'Liquidité', value: `$${liq.toFixed(0)}`, inline: true },
      ],
    });

    if (ok) { this.stats.bought++; log('success', `✅ Scanner acheté ${pd.symbol || mint.slice(0, 8)} (${score}/100)`); }
    else this.stats.errors++;
  }

  getStatus() {
    return {
      running:       this.running,
      wsConnected:   this.ws?.readyState === 1,
      wsUrl:         this._wsUrl().replace(/api-key=[^&]+/, 'api-key=[REDACTED]'),
      pollIntervalS: CFG.SCANNER_POLL_SEC || 30,
      enabled:       CFG.SCANNER_ENABLED,
      minScore:      CFG.SCANNER_MIN_SCORE,
      minLiq:        CFG.SCANNER_MIN_LIQ,
      maxLiq:        CFG.SCANNER_MAX_LIQ,
      solAmount:     CFG.SCANNER_SOL_AMOUNT,
      queueLength:   this.queue.length,
      pendingCount:  this.pending.size,
      seenCount:     this.seen.size,
      stats:         this.stats,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §14  API EXPRESS — 35 routes organisées par domaine
// ═══════════════════════════════════════════════════════════════════════════════

function startApi(bot, wallet, scanner) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // CORS universel
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Dashboard statique
  const idx = path.join(process.env.STATIC_DIR || __dirname, 'index.html');
  if (fs.existsSync(idx)) {
    app.use(express.static(path.dirname(idx)));
    app.get('/', (_, res) => res.sendFile(idx));
  } else {
    app.get('/', (_, res) => {
      if (CFG.DASHBOARD_URL) return res.redirect(302, CFG.DASHBOARD_URL);
      res.json({ bot: `SolBot v${VERSION}`, status: 'running', uptime: Math.round(process.uptime()) + 's' });
    });
  }

  // Helpers de validation
  const num  = (v, min, max) => { const n = parseFloat(v); return !isNaN(n) && n >= min && n <= max ? n : null; };
  const bool = v => v !== undefined ? !!v : undefined;

  // ─── §14.1 · Health & Debug ────────────────────────────────────────────────

  app.get('/health', (_, res) => res.json({ status: 'ok', version: VERSION, uptime: process.uptime() }));

  app.get('/api/debug/prices', (_, res) => {
    const rows = [];
    const allMints = new Set([...priceCache.keys(), ..._failCount.keys(), ...bot.portfolio.map(t => t.mintFull)]);
    for (const mint of allMints) {
      const c  = priceCache.get(mint);
      const f  = _failCount.get(mint) || 0;
      const nc = _negCache.get(mint);
      rows.push({
        mint:      mint.slice(0, 8) + '…',
        symbol:    c?.data?.symbol  || null,
        price:     c?.data?.price   || null,
        liquidity: c?.data?.liquidity || null,
        source:    c?.data?.source  || null,
        cacheAge:  c ? Math.round((Date.now() - c.ts) / 1000) + 's' : null,
        failures:  f > 0 ? f : null,
        negUntil:  nc ? Math.round((nc.until - Date.now()) / 60_000) + 'min' : null,
        status:    nc ? '🔴 neg-cached' : c ? '✅ live' : '⏳ no-data',
      });
    }
    const live = rows.filter(r => r.status.startsWith('✅')).length;
    const dead = rows.filter(r => r.status.startsWith('🔴')).length;
    res.json({
      summary: { total: rows.length, live, dead, noData: rows.length - live - dead },
      tokens:  rows.sort((a, b) => (b.failures || 0) - (a.failures || 0)).slice(0, 60),
    });
  });

  // ─── §14.2 · Portfolio & Stats ────────────────────────────────────────────

  app.get('/api/stats', (_, res) => res.json(bot.getStats()));

  app.get('/api/portfolio', (_, res) => res.json({
    address: wallet.publicKey.toString(),
    tokens:  bot.portfolio,
    timestamp: Date.now(),
  }));

  app.get('/api/wallet',      (_, res) => res.json({ address: wallet.publicKey.toString() }));
  app.get('/api/take-profit', (_, res) => res.json({
    enabled:    CFG.TP_ENABLED,
    tiers:      bot.positions.tiers.map((t, i) => ({ index: i + 1, pnl: t.pnl, sell: t.sell })),
    hysteresis: CFG.TP_HYSTERESIS,
    breakEven:  { enabled: CFG.BE_ENABLED, buffer: CFG.BE_BUFFER },
    tracked:    bot.positions.entries.size,
    entries:    bot.positions.toApiRows(),
  }));

  app.get('/api/trades',      (_, res) => res.json({ trades: bot.history }));
  app.get('/api/analytics',   (_, res) => res.json(bot.analytics.toApi(bot.history)));

  app.get('/api/sol-balance', async (_, res) => {
    const [sol, usdc] = await Promise.all([
      bot.swap.getSolBalance(),
      bot.swap.getUsdcBalance(),
    ]);
    res.json({
      balance:   sol,
      formatted: sol != null ? sol.toFixed(6) + ' SOL' : null,
      usdc:      usdc,
      sellToUsdc: CFG.SELL_TO_USDC,
    });
  });

  // ─── §14.3 · Config ──────────────────────────────────────────────────────

  app.get('/api/config', (_, res) => res.json({
    // TP
    takeProfitEnabled: CFG.TP_ENABLED, takeProfitTiers: CFG.TP_TIERS, hysteresis: CFG.TP_HYSTERESIS,
    // BE
    breakEvenEnabled: CFG.BE_ENABLED, breakEvenBuffer: CFG.BE_BUFFER,
    // SL
    stopLossEnabled: CFG.SL_ENABLED, stopLossPct: CFG.SL_PCT,
    // TS
    trailingEnabled: CFG.TS_ENABLED, trailingPct: CFG.TS_PCT, trailingVol: CFG.TS_VOL, trailingVolMult: CFG.TS_VOL_MULT,
    // AR
    antiRugEnabled: CFG.AR_ENABLED, antiRugPct: CFG.AR_PCT,
    // LE
    liqExitEnabled: CFG.LE_ENABLED, liqExitPct: CFG.LE_PCT,
    // TT
    timeStopEnabled: CFG.TT_ENABLED, timeStopHours: CFG.TT_HOURS, timeStopMinPnl: CFG.TT_MIN_PNL,
    // ME
    momentumEnabled: CFG.ME_ENABLED, momentumThreshold: CFG.ME_THRESHOLD, momentumWindow: CFG.ME_WINDOW,
    // Jito
    jitoEnabled: CFG.JITO_ENABLED, jitoTipSol: CFG.JITO_TIP_SOL,
    // Sizing
    maxPositions: CFG.MAX_POSITIONS, minScore: CFG.MIN_SCORE,
    // Execution
    defaultSlippage: CFG.DEFAULT_SLIPPAGE, minSolReserve: CFG.MIN_SOL_RESERVE, intervalSec: CFG.INTERVAL_SEC,
    // §NEW — Pyramid / DCA-Down / Re-entry / Smart Sizing
    pyramidEnabled: CFG.PYRAMID_ENABLED, pyramidTiers: CFG.PYRAMID_TIERS,
    pyramidMaxSol: CFG.PYRAMID_MAX_SOL, pyramidHysteresis: CFG.PYRAMID_HYSTERESIS,
    dcadEnabled: CFG.DCAD_ENABLED, dcadTiers: CFG.DCAD_TIERS,
    dcadMaxAdds: CFG.DCAD_MAX_ADDS, dcadRequireMomentum: CFG.DCAD_REQUIRE_MOMENTUM,
    dcadMinVelocity: CFG.DCAD_MIN_VELOCITY,
    reentryEnabled: CFG.REENTRY_ENABLED, reentryDelayMin: CFG.REENTRY_DELAY_MIN,
    reentryMinScore: CFG.REENTRY_MIN_SCORE, reentrySol: CFG.REENTRY_SOL,
    reentryMinGain: CFG.REENTRY_MIN_GAIN,
    smartSizeEnabled: CFG.SMART_SIZE_ENABLED, smartSizeBase: CFG.SMART_SIZE_BASE,
    smartSizeMult: CFG.SMART_SIZE_MULT, smartSizeMin: CFG.SMART_SIZE_MIN, smartSizeMax: CFG.SMART_SIZE_MAX,
    // §NEW — Sortie USDC
    sellToUsdc: CFG.SELL_TO_USDC,
    // §v6 — Scanner
    scannerEnabled: CFG.SCANNER_ENABLED, scannerMinScore: CFG.SCANNER_MIN_SCORE,
    scannerMinLiq: CFG.SCANNER_MIN_LIQ, scannerMaxLiq: CFG.SCANNER_MAX_LIQ,
    scannerSolAmount: CFG.SCANNER_SOL_AMOUNT,
    // §v6 — Daily Loss
    dailyLossEnabled: CFG.DAILY_LOSS_ENABLED, dailyLossLimit: CFG.DAILY_LOSS_LIMIT,
  }));

  app.post('/api/config', (req, res) => {
    const b = req.body;
    const applyBool = (key, target) => { if (b[key] !== undefined) target[key] = !!b[key]; };
    const applyNum  = (key, min, max, setter) => { const n = num(b[key], min, max); if (n !== null) setter(n); };

    if (b.takeProfitEnabled !== undefined)  CFG.TP_ENABLED = !!b.takeProfitEnabled;
    if (b.breakEvenEnabled  !== undefined)  CFG.BE_ENABLED = !!b.breakEvenEnabled;
    if (b.stopLossEnabled   !== undefined)  CFG.SL_ENABLED = !!b.stopLossEnabled;
    if (b.trailingEnabled   !== undefined)  CFG.TS_ENABLED = !!b.trailingEnabled;
    if (b.trailingVol       !== undefined)  CFG.TS_VOL     = !!b.trailingVol;
    if (b.antiRugEnabled    !== undefined)  CFG.AR_ENABLED = !!b.antiRugEnabled;
    if (b.liqExitEnabled    !== undefined)  CFG.LE_ENABLED = !!b.liqExitEnabled;
    if (b.timeStopEnabled   !== undefined)  CFG.TT_ENABLED = !!b.timeStopEnabled;
    if (b.momentumEnabled   !== undefined)  CFG.ME_ENABLED = !!b.momentumEnabled;
    if (b.jitoEnabled       !== undefined)  CFG.JITO_ENABLED = !!b.jitoEnabled;

    if (Array.isArray(b.takeProfitTiers) && b.takeProfitTiers.length) {
      const clean = b.takeProfitTiers
        .map(t => ({ pnl: parseFloat(t.pnl), sell: parseFloat(t.sell) }))
        .filter(t => t.pnl > 0 && t.sell > 0 && t.sell <= 100)
        .sort((a, c) => a.pnl - c.pnl);
      if (clean.length) { CFG.TP_TIERS = clean; bot.positions.tiers = clean; }
    }

    applyNum('stopLossPct',       -100, 0,      n => CFG.SL_PCT           = n);
    applyNum('breakEvenBuffer',     -5, 20,     n => CFG.BE_BUFFER        = n);
    applyNum('trailingPct',          1, 100,    n => CFG.TS_PCT           = n);
    applyNum('trailingVolMult',    0.5, 10,     n => CFG.TS_VOL_MULT      = n);
    applyNum('antiRugPct',           1, 100,    n => CFG.AR_PCT           = n);
    applyNum('liqExitPct',           1, 100,    n => CFG.LE_PCT           = n);
    applyNum('hysteresis',           0, 50,     n => CFG.TP_HYSTERESIS    = n);
    applyNum('timeStopHours',        1, 720,    n => CFG.TT_HOURS         = n);
    applyNum('timeStopMinPnl',    -100, 100,    n => CFG.TT_MIN_PNL       = n);
    applyNum('momentumThreshold', -100, 0,      n => CFG.ME_THRESHOLD     = n);
    applyNum('momentumWindow',       2, 20,     n => CFG.ME_WINDOW        = n);
    applyNum('jitoTipSol',      0.00001, 0.01,  n => CFG.JITO_TIP_SOL    = n);
    applyNum('defaultSlippage',     10, 5000,   n => CFG.DEFAULT_SLIPPAGE = n);
    applyNum('minSolReserve',        0, 10,     n => CFG.MIN_SOL_RESERVE  = n);
    applyNum('intervalSec',         10, 3600,   n => CFG.INTERVAL_SEC     = n);
    applyNum('maxPositions',         1, 50,     n => CFG.MAX_POSITIONS    = n);
    applyNum('minScore',             0, 100,    n => CFG.MIN_SCORE        = n);

    // §NEW — Pyramid
    if (b.pyramidEnabled !== undefined) CFG.PYRAMID_ENABLED = !!b.pyramidEnabled;
    if (Array.isArray(b.pyramidTiers) && b.pyramidTiers.length) {
      const pt = b.pyramidTiers.map(t => ({ pnl: parseFloat(t.pnl), addSol: parseFloat(t.addSol) }))
        .filter(t => t.pnl > 0 && t.addSol > 0 && t.addSol <= 10).sort((a, c) => a.pnl - c.pnl);
      if (pt.length) CFG.PYRAMID_TIERS = pt;
    }
    applyNum('pyramidMaxSol',         0.001, 100, n => CFG.PYRAMID_MAX_SOL    = n);
    applyNum('pyramidHysteresis',     0,     50,  n => CFG.PYRAMID_HYSTERESIS = n);

    // §NEW — DCA-Down
    if (b.dcadEnabled !== undefined) CFG.DCAD_ENABLED = !!b.dcadEnabled;
    if (Array.isArray(b.dcadTiers) && b.dcadTiers.length) {
      const dt = b.dcadTiers.map(t => ({ pnl: parseFloat(t.pnl), addSol: parseFloat(t.addSol) }))
        .filter(t => t.pnl < 0 && t.addSol > 0 && t.addSol <= 10).sort((a, c) => a.pnl - c.pnl);
      if (dt.length) CFG.DCAD_TIERS = dt;
    }
    applyNum('dcadMaxAdds',     1,   10,    n => CFG.DCAD_MAX_ADDS      = n);
    applyNum('dcadMinVelocity', -20, 0,     n => CFG.DCAD_MIN_VELOCITY  = n);
    if (b.dcadRequireMomentum !== undefined) CFG.DCAD_REQUIRE_MOMENTUM = !!b.dcadRequireMomentum;

    // §NEW — Re-entry
    if (b.reentryEnabled !== undefined) CFG.REENTRY_ENABLED = !!b.reentryEnabled;
    applyNum('reentryDelayMin', 1,    1440, n => CFG.REENTRY_DELAY_MIN  = n);
    applyNum('reentryMinScore', 0,    100,  n => CFG.REENTRY_MIN_SCORE  = n);
    applyNum('reentrySol',      0.01, 10,   n => CFG.REENTRY_SOL        = n);
    applyNum('reentryMinGain',  1,    200,  n => CFG.REENTRY_MIN_GAIN   = n);

    // §NEW — Smart Sizing
    if (b.smartSizeEnabled !== undefined) CFG.SMART_SIZE_ENABLED = !!b.smartSizeEnabled;
    applyNum('smartSizeBase', 0.001, 10, n => CFG.SMART_SIZE_BASE = n);
    applyNum('smartSizeMult', 1,      5, n => CFG.SMART_SIZE_MULT = n);
    applyNum('smartSizeMin',  0.001, 10, n => CFG.SMART_SIZE_MIN  = n);
    applyNum('smartSizeMax',  0.001, 10, n => CFG.SMART_SIZE_MAX  = n);

    // §NEW — Sortie USDC
    if (b.sellToUsdc !== undefined) CFG.SELL_TO_USDC = !!b.sellToUsdc;

    // §v6 — Scanner
    if (b.scannerEnabled   !== undefined) CFG.SCANNER_ENABLED   = !!b.scannerEnabled;
    applyNum('scannerMinScore',  0,    100,    n => CFG.SCANNER_MIN_SCORE  = n);
    applyNum('scannerMinLiq',    0,    1e7,    n => CFG.SCANNER_MIN_LIQ    = n);
    applyNum('scannerMaxLiq',    0,    1e8,    n => CFG.SCANNER_MAX_LIQ    = n);
    applyNum('scannerSolAmount', 0.001, 10,   n => CFG.SCANNER_SOL_AMOUNT  = n);

    // §v6 — Daily Loss
    if (b.dailyLossEnabled !== undefined) CFG.DAILY_LOSS_ENABLED = !!b.dailyLossEnabled;
    applyNum('dailyLossLimit', -100, 0, n => CFG.DAILY_LOSS_LIMIT = n);

    log('info', 'Config mise à jour');
    res.json({ success: true });
  });

  // ─── §14.4 · Quote ────────────────────────────────────────────────────────

  app.post('/api/quote', async (req, res) => {
    const { inputMint, outputMint, amount, slippageBps = CFG.DEFAULT_SLIPPAGE } = req.body;
    if (!inputMint || !outputMint || !amount)
      return res.status(400).json({ error: 'inputMint, outputMint, amount requis' });
    try {
      const q = await bot.swap.getQuote({
        inputMint, outputMint,
        amountRaw:   BigInt(Math.floor(Number(amount))),
        slippageBps: parseInt(slippageBps) || CFG.DEFAULT_SLIPPAGE,
      });
      res.json({ success: true, quote: q });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ─── §14.5 · Score token ─────────────────────────────────────────────────

  app.get('/api/score/:mint', async (req, res) => {
    const mint = req.params.mint;
    await prefetchPrices([mint]);
    const pd = getPrice(mint);
    if (!pd) return res.status(404).json({ error: 'Token introuvable' });
    res.json({
      mint, score: bot.scorer.score(pd),
      trend: bot.momentum.getTrend(mint),
      liqDrop: getLiqDrop(mint),
      data: pd,
    });
  });

  // ─── §14.6 · Buy ─────────────────────────────────────────────────────────

  app.post('/api/buy', async (req, res) => {
    const { mint, solAmount, slippageBps = CFG.DEFAULT_SLIPPAGE, ignoreScore = false, useSmartSize = false } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    if (bot.portfolio.length >= CFG.MAX_POSITIONS)
      return res.status(400).json({ error: `Max positions (${CFG.MAX_POSITIONS}) atteint` });

    await prefetchPrices([mint]);
    const pd    = getPrice(mint);
    const score = bot.scorer.score(pd);

    // §NEW Smart Sizing — calcule automatiquement si activé
    let sol;
    if (useSmartSize || (CFG.SMART_SIZE_ENABLED && !solAmount)) {
      sol = bot.calcSmartSize(score);
    } else {
      if (!solAmount) return res.status(400).json({ error: 'solAmount requis' });
      sol = parseFloat(solAmount);
    }
    if (isNaN(sol) || sol <= 0 || sol > 100) return res.status(400).json({ error: 'solAmount invalide (0-100)' });

    if (!ignoreScore && CFG.MIN_SCORE > 0) {
      if (score < CFG.MIN_SCORE)
        return res.status(400).json({ error: `Score trop faible: ${score}/${CFG.MIN_SCORE}`, score, smartSize: bot.calcSmartSize(score) });
    }

    try {
      const result = await bot.swap.buy(mint, sol, parseInt(slippageBps) || CFG.DEFAULT_SLIPPAGE);
      if (result.success) {
        const pd = getPrice(mint);
        const ep = result.outAmount > 0 ? sol / result.outAmount : (pd?.price || 0);
        bot.positions.trackEntry(mint, ep, result.outAmount, ep);
        bot.recordBuy(mint, sol, result.outAmount || 0);
        bot.recordTrade({ type: 'buy', mint, symbol: pd?.symbol || mint.slice(0, 8),
          solSpent: sol, outAmount: result.outAmount, entryPrice: ep, txId: result.sig, txUrl: result.txUrl });
        bot.persist();
        setTimeout(() => bot.tick().catch(() => {}), 4000);
        await webhook('✅ Achat', `${pd?.symbol || mint.slice(0, 8)} — ${sol} SOL`, 0x00d97e, [
          { name: 'Tokens',       value: result.outAmount?.toFixed(4), inline: true },
          { name: 'Prix entrée',  value: ep.toPrecision(6),            inline: true },
        ]);
      }
      res.json(result);
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ─── §14.7 · Buy DCA ─────────────────────────────────────────────────────

  app.post('/api/buy/dca', async (req, res) => {
    const { mint, totalSol, chunks = 3, intervalSec = 60, slippageBps = CFG.DEFAULT_SLIPPAGE } = req.body;
    if (!mint || !totalSol) return res.status(400).json({ error: 'mint et totalSol requis' });
    const sol = parseFloat(totalSol), n = Math.min(parseInt(chunks) || 3, 10);
    if (isNaN(sol) || sol <= 0) return res.status(400).json({ error: 'totalSol invalide' });

    try {
      const result = await bot.swap.buyDCA(mint, sol, n, parseInt(intervalSec) || 60, parseInt(slippageBps) || CFG.DEFAULT_SLIPPAGE);
      for (const r of result.results.filter(r => r.success)) {
        const pd = getPrice(mint);
        const cp = r.outAmount > 0 ? (sol / n) / r.outAmount : (pd?.price || 0);
        if (!bot.positions.entries.has(mint)) {
          bot.positions.trackEntry(mint, cp, r.outAmount, cp);
        } else {
          // DCA : moyenne pondérée du prix d'entrée
          const e  = bot.positions.entries.get(mint);
          const cb = bot.costBasis.get(mint) || { solSpent: 0, tokBought: 0 };
          const tot = cb.tokBought + r.outAmount;
          if (tot > 0) e.price = (cb.solSpent + sol / n) / tot;
        }
        bot.recordBuy(mint, sol / n, r.outAmount || 0);
        bot.recordTrade({ type: 'buy', mint, symbol: getPrice(mint)?.symbol || mint.slice(0, 8),
          solSpent: sol / n, outAmount: r.outAmount, txId: r.sig, txUrl: r.txUrl, tag: `DCA ${r.chunk}/${n}` });
      }
      bot.persist();
      setTimeout(() => bot.tick().catch(() => {}), 4000);
      res.json(result);
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ─── §14.8 · Sell ────────────────────────────────────────────────────────

  app.post('/api/sell', async (req, res) => {
    const { mint, amount, percent, slippageBps = CFG.DEFAULT_SLIPPAGE, reason = 'MANUAL', useJito = false } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    const tok = bot.portfolio.find(t => t.mintFull === mint || t.mintFull?.startsWith(mint.slice(0, 8)));
    if (!tok) return res.status(404).json({ error: 'Token non trouvé dans le portfolio' });
    let sellAmount = parseFloat(amount) || 0;
    if (percent !== undefined) sellAmount = tok.balance * (parseFloat(percent) / 100);
    if (sellAmount <= 0) return res.status(400).json({ error: 'Montant invalide' });
    sellAmount = Math.min(sellAmount, tok.balance);

    const result = await bot.swap.sell(tok.mintFull, sellAmount, reason, parseInt(slippageBps) || CFG.DEFAULT_SLIPPAGE, !!useJito);
    if (result.success) {
      const { pnlSol, pnlPct } = bot.recordSell(tok.mintFull, result.solOut, sellAmount, tok.symbol);
      bot.recordTrade({ type: 'sell', mint: tok.mintFull, symbol: tok.symbol, amount: sellAmount,
        solOut: result.solOut, reason, txId: result.sig, txUrl: result.txUrl, pnlSol, pnlPct });
      bot.persist();
      setTimeout(() => bot.tick().catch(() => {}), 4000);
    }
    res.json({ ...result, sellAmount });
  });

  // ─── §14.9 · Positions ───────────────────────────────────────────────────

  app.get('/api/positions', (_, res) => {
    const rows = bot.positions.toApiRows().map(row => {
      const tok = bot.portfolio.find(t => t.mintFull === row.mint);
      const cur = tok?.price || getPrice(row.mint)?.price || 0;
      const pnl = row.entryPrice > 0 && cur > 0 ? ((cur - row.entryPrice) / row.entryPrice) * 100 : null;
      return { ...row, currentPrice: cur, pnl: pnl !== null ? +pnl.toFixed(2) : null };
    });
    res.json({
      count:       rows.length,
      bootstrapped:rows.filter(r => r.bootstrapped).length,
      real:        rows.filter(r => !r.bootstrapped).length,
      positions:   rows.sort((a, b) => (b.pnl || 0) - (a.pnl || 0)),
    });
  });

  app.post('/api/positions/set-entry', (req, res) => {
    const { mint, entryPrice, balance } = req.body;
    if (!mint || entryPrice === undefined) return res.status(400).json({ error: 'mint et entryPrice requis' });
    const price = parseFloat(entryPrice);
    if (isNaN(price) || price <= 0) return res.status(400).json({ error: 'entryPrice invalide' });
    const bal = balance !== undefined ? parseFloat(balance) : null;
    const ok  = bot.positions.setEntryPrice(mint, price, bal);
    if (!ok) {
      const tok = bot.portfolio.find(t => t.mintFull === mint);
      if (!tok) return res.status(404).json({ error: 'Token non trouvé' });
      bot.positions.trackEntry(mint, price, bal || tok.balance, price);
    }
    bot.persist();
    res.json({ success: true, mint, entryPrice: price, message: 'TP/SL actifs, break-even reset' });
  });

  app.post('/api/positions/delete', (req, res) => {
    const { mint } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    if (!bot.positions.entries.has(mint)) return res.status(404).json({ error: 'Position non trouvée' });
    for (const map of [bot.positions.entries, bot.positions.triggered, bot.positions.sold,
                       bot.positions.peak, bot.costBasis]) map.delete(mint);
    bot.positions.slHit.delete(mint); bot.positions.slPending.delete(mint); bot.positions.breakEven.delete(mint);
    bot.persist();
    log('info', 'Position supprimée', { mint: mint.slice(0, 8) });
    res.json({ success: true, mint });
  });

  // ─── §14.10 · Helius history scan ────────────────────────────────────────

  app.get('/api/positions/scan-history', async (_, res) => {
    if (!CFG.HELIUS_KEY) return res.status(400).json({ error: 'HELIUS_API_KEY requis' });
    const booted = [...bot.positions.entries.entries()].filter(([, e]) => e.bootstrapped).map(([m]) => m);
    if (!booted.length) return res.json({ message: 'Aucune position bootstrappée', fixed: 0, total: 0 });

    const walletStr = wallet.publicKey.toString();
    const results   = [];
    log('info', `Helius scan (manuel) — ${booted.length} positions bootstrappées`);

    for (const mint of booted) {
      try {
        const found = await bot._heliusFindEntryPrice(mint, walletStr);
        if (found?.entryPrice > 0) {
          const old = bot.positions.entries.get(mint)?.price;
          bot.positions.setEntryPrice(mint, found.entryPrice);
          if (!bot.costBasis.has(mint) || bot.costBasis.get(mint)?.solSpent === 0) {
            bot.costBasis.set(mint, { solSpent: found.solSpent, tokBought: found.tokReceived, buyTs: found.ts || Date.now() });
          }
          results.push({ mint: mint.slice(0, 8), status: 'fixed', entryPrice: found.entryPrice, priceBefore: old });
        } else {
          const cb = bot.costBasis.get(mint);
          if (cb?.solSpent > 0 && cb?.tokBought > 0) {
            const fp = cb.solSpent / cb.tokBought;
            bot.positions.setEntryPrice(mint, fp);
            results.push({ mint: mint.slice(0, 8), status: 'fixed_fallback', entryPrice: fp });
          } else {
            results.push({ mint: mint.slice(0, 8), status: 'not_found' });
          }
        }
        await sleep(300);
      } catch (err) { results.push({ mint: mint.slice(0, 8), status: 'error', error: err.message }); }
    }

    const fixed = results.filter(r => r.status === 'fixed' || r.status === 'fixed_fallback').length;
    if (fixed > 0) bot.persist();
    log('info', `Scan terminé: ${fixed}/${booted.length}`);
    res.json({ total: booted.length, fixed, results });
  });

  // ─── §14.11 · Dead tokens & Negative cache ────────────────────────────────

  app.get('/api/dead-tokens', (_, res) => {
    const now  = Date.now();
    const dead = bot.portfolio.filter(tok => {
      const f    = _failCount.get(tok.mintFull) || 0;
      const ageH = (now - (bot.positions.entries.get(tok.mintFull)?.ts || now)) / 3_600_000;
      return (f >= 10 || (tok.value < 0.01 && f >= 3)) && ageH > 12;
    }).map(tok => ({
      mint:     tok.mintFull,
      symbol:   tok.symbol || tok.mintFull.slice(0, 8),
      value:    tok.value,
      failures: _failCount.get(tok.mintFull) || 0,
      ageHours: +((now - (bot.positions.entries.get(tok.mintFull)?.ts || now)) / 3_600_000).toFixed(1),
      negUntil: _negCache.get(tok.mintFull) ? new Date(_negCache.get(tok.mintFull).until).toISOString() : null,
    }));
    res.json({
      total: bot.portfolio.length, alive: bot.portfolio.length - dead.length,
      dead: dead.length, deadTokens: dead,
      negCacheSize: _negCache.size,
      tip: dead.length > 0 ? `POST /api/dead-tokens/purge { all: true }` : 'Aucun token mort',
    });
  });

  app.post('/api/dead-tokens/purge', (req, res) => {
    const { mints: targeted, all = false, dryRun = false } = req.body || {};
    const now   = Date.now();
    const purge = all
      ? bot.portfolio.filter(t => {
          const f = _failCount.get(t.mintFull) || 0;
          const ageH = (now - (bot.positions.entries.get(t.mintFull)?.ts || now)) / 3_600_000;
          return (f >= 10 || (t.value < 0.01 && f >= 3)) && ageH > 12;
        }).map(t => t.mintFull)
      : (Array.isArray(targeted) ? targeted : []);

    if (!purge.length) return res.json({ success: true, purged: 0 });

    const done = [], skipped = [];
    for (const mint of purge) {
      const tok = bot.portfolio.find(t => t.mintFull === mint);
      if (tok?.value > 0.50) { skipped.push({ mint: mint.slice(0, 8), reason: `$${tok.value.toFixed(2)} > $0.50` }); continue; }
      if (!dryRun) {
        for (const m of [bot.positions.entries, bot.positions.triggered, bot.positions.sold,
                         bot.positions.peak, bot.costBasis, priceCache]) m.delete(mint);
        bot.positions.slHit.delete(mint); bot.positions.slPending.delete(mint); bot.positions.breakEven.delete(mint);
        _failCount.delete(mint); _negCache.delete(mint);
      }
      done.push(mint.slice(0, 8) + '…');
    }
    if (!dryRun && done.length) { bot.persist(); log('info', `Dead tokens purgés: ${done.length}`); }
    res.json({ success: true, dryRun, purged: done.length, skipped: skipped.length, mints: done, skippedDetails: skipped,
      message: dryRun ? `DRY RUN — ${done.length} seraient purgés` : `${done.length} purgé(s)` });
  });

  app.post('/api/neg-cache/reset', (req, res) => {
    const { mint, all = false } = req.body || {};
    if (all) { const n = _negCache.size; _negCache.clear(); _failCount.clear(); return res.json({ success: true, cleared: n }); }
    if (!mint) return res.status(400).json({ error: 'mint ou all:true requis' });
    _negCache.delete(mint); _failCount.delete(mint);
    res.json({ success: true, mint, message: 'Neg-cache supprimé — sera retenté au prochain cycle' });
  });

  // ─── §14.12 · Circuit-breaker ─────────────────────────────────────────────

  app.post('/api/reset-circuit-breaker', (_, res) => {
    bot.swap.sellFailures = 0;
    bot.swap._cbTrippedAt = null;
    log('info', 'Circuit-breaker reset manuellement');
    res.json({ success: true });
  });

  // ─── §14.13 · 404 ─────────────────────────────────────────────────────────
  // ─── §NEW · Auto-Buys overview ──────────────────────────────────────────
  app.get('/api/auto-buys', (_, res) => {
    const rows = [];
    for (const [mint, e] of bot.positions.entries) {
      const pd  = getPrice(mint);
      const pnl = bot.positions.getPnl(mint, pd?.price || 0);
      rows.push({
        mint, symbol: pd?.symbol || mint.slice(0, 8),
        pnl: pnl !== null ? +pnl.toFixed(2) : null,
        // Pyramid state
        pyramidEnabled: CFG.PYRAMID_ENABLED,
        pyramidDone:    Array.from(bot.positions.pyramidDone.get(mint) || []),
        pyramidTiers:   CFG.PYRAMID_TIERS.map((t, i) => ({
          idx: i, pnl: t.pnl, addSol: t.addSol,
          triggered: (bot.positions.pyramidDone.get(mint) || new Set()).has(i),
          willTrigger: pnl !== null && pnl >= t.pnl,
        })),
        addedSol:       bot.positions.addedSol.get(mint) || 0,
        pyramidBudgetLeft: Math.max(0, CFG.PYRAMID_MAX_SOL - (bot.positions.addedSol.get(mint) || 0)),
        // DCA-Down state
        dcadEnabled:    CFG.DCAD_ENABLED,
        dcadDone:       bot.positions.dcadDone.get(mint) || 0,
        dcadTiers:      CFG.DCAD_TIERS.map((t, i) => ({
          idx: i, pnl: t.pnl, addSol: t.addSol,
          triggered: (bot.positions.dcadDone.get(mint) || 0) > i,
          willTrigger: pnl !== null && pnl <= t.pnl && (bot.positions.dcadDone.get(mint) || 0) === i,
        })),
        dcadAddsLeft:   Math.max(0, CFG.DCAD_MAX_ADDS - (bot.positions.dcadDone.get(mint) || 0)),
      });
    }
    res.json({
      pyramidEnabled: CFG.PYRAMID_ENABLED, pyramidMaxSol: CFG.PYRAMID_MAX_SOL,
      dcadEnabled: CFG.DCAD_ENABLED, dcadMaxAdds: CFG.DCAD_MAX_ADDS,
      positions: rows,
    });
  });

  // ─── §NEW · Re-entry management ──────────────────────────────────────────
  app.get('/api/reentry', async (_, res) => {
    const rows = [];
    for (const mint of bot.positions.slHit) {
      const exitTs    = bot.positions.slExitTs.get(mint);
      const exitPrice = bot.positions.slExitPrice.get(mint);
      await prefetchPrices([mint]);
      const pd        = getPrice(mint);
      const price     = pd?.price || 0;
      const score     = bot.scorer.score(pd);
      const rebound   = exitPrice && price > 0 ? ((price - exitPrice) / exitPrice) * 100 : null;
      const delayDone = exitTs ? (Date.now() - exitTs) >= CFG.REENTRY_DELAY_MIN * 60_000 : false;
      rows.push({
        mint, symbol: pd?.symbol || mint.slice(0, 8),
        exitTs: exitTs ? new Date(exitTs).toISOString() : null,
        exitPrice, currentPrice: price,
        reboundPct: rebound !== null ? +rebound.toFixed(2) : null,
        delayDone, delayRemainMin: exitTs ? Math.max(0, CFG.REENTRY_DELAY_MIN - (Date.now() - exitTs) / 60_000).toFixed(1) : null,
        score, scoreOk: score >= CFG.REENTRY_MIN_SCORE,
        gainOk: rebound !== null && rebound >= CFG.REENTRY_MIN_GAIN,
        eligible: delayDone && score >= CFG.REENTRY_MIN_SCORE && rebound !== null && rebound >= CFG.REENTRY_MIN_GAIN,
      });
    }
    res.json({
      reentryEnabled: CFG.REENTRY_ENABLED, reentryDelayMin: CFG.REENTRY_DELAY_MIN,
      reentryMinScore: CFG.REENTRY_MIN_SCORE, reentryMinGain: CFG.REENTRY_MIN_GAIN,
      stoppedTokens: rows,
    });
  });

  app.post('/api/reentry/clear', (req, res) => {
    const { mint } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    bot.positions.clearReentryBlock(mint);
    res.json({ success: true, mint, message: 'Timer re-entry effacé' });
  });

  // ─── §NEW · Smart sizing preview ──────────────────────────────────────────
  app.get('/api/smart-size/:score', (req, res) => {
    const score = parseFloat(req.params.score);
    if (isNaN(score)) return res.status(400).json({ error: 'score invalide' });
    const sol = bot.calcSmartSize(score);
    res.json({ score, smartSizeEnabled: CFG.SMART_SIZE_ENABLED, solAmount: sol,
      base: CFG.SMART_SIZE_BASE, mult: CFG.SMART_SIZE_MULT,
      min: CFG.SMART_SIZE_MIN, max: CFG.SMART_SIZE_MAX });
  });

  // ─── §v6 · Scanner ────────────────────────────────────────────────────────

  app.get('/api/scanner/status', (_, res) => {
    res.json(scanner ? scanner.getStatus() : { enabled: false, running: false, reason: 'no scanner' });
  });

  app.get('/api/scanner/seen', (_, res) => {
    res.json({
      count: scanner?.seen.size || 0,
      mints: Array.from(scanner?.seen || []).slice(-100),
    });
  });

  app.post('/api/scanner/config', (req, res) => {
    const b = req.body || {};
    const num = (v, mn, mx) => { const n = parseFloat(v); return (!isNaN(n) && n >= mn && n <= mx) ? n : null; };
    if (b.enabled !== undefined)    CFG.SCANNER_ENABLED   = !!b.enabled;
    const s = num(b.minScore, 0, 100); if (s !== null) CFG.SCANNER_MIN_SCORE = s;
    const l = num(b.minLiq, 0, 1e7);  if (l !== null) CFG.SCANNER_MIN_LIQ   = l;
    const x = num(b.maxLiq, 0, 1e8);  if (x !== null) CFG.SCANNER_MAX_LIQ   = x;
    const a = num(b.solAmount, 0.001, 10); if (a !== null) CFG.SCANNER_SOL_AMOUNT = a;
    if (scanner && b.enabled === true  && !scanner.running) scanner.start();
    if (scanner && b.enabled === false && scanner.running)  scanner.stop();
    res.json({ success: true, config: scanner?.getStatus() });
  });

  app.post('/api/scanner/reset-seen', (_, res) => {
    if (scanner) scanner.seen.clear();
    res.json({ success: true, message: 'Seen list effacée' });
  });

  // ─── §v6 · Daily Loss ─────────────────────────────────────────────────────

  app.get('/api/daily-loss', (_, res) => {
    res.json({
      enabled:     CFG.DAILY_LOSS_ENABLED,
      limit:       CFG.DAILY_LOSS_LIMIT,
      today:       bot.dailyLoss.date,
      realizedSol: +bot.dailyLoss.realizedSol.toFixed(6),
      paused:      bot.dailyLoss.paused,
      remaining:   +(CFG.DAILY_LOSS_LIMIT - bot.dailyLoss.realizedSol).toFixed(6),
      pct:         CFG.DAILY_LOSS_LIMIT !== 0
        ? +((bot.dailyLoss.realizedSol / Math.abs(CFG.DAILY_LOSS_LIMIT)) * 100).toFixed(1)
        : 0,
    });
  });

  app.post('/api/daily-loss/config', (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined)   CFG.DAILY_LOSS_ENABLED = !!b.enabled;
    const n = parseFloat(b.limit);
    if (!isNaN(n) && n <= 0 && n >= -100) CFG.DAILY_LOSS_LIMIT = n;
    res.json({ success: true });
  });

  app.post('/api/daily-loss/reset', (_, res) => {
    bot.dailyLoss.paused = false;
    bot.dailyLoss.realizedSol = 0;
    bot.dailyLoss.date = bot._today();
    log('info', 'Daily Loss reset manuellement');
    res.json({ success: true, message: 'Daily Loss remis à zéro, achats repris' });
  });

  // ─── §v6 · Portfolio History ───────────────────────────────────────────────

  app.get('/api/portfolio-history', (_, res) => {
    const history = bot.valueHistory;
    // Calculer stats sur la période
    const values = history.map(h => h.valueSol).filter(v => v > 0);
    const first  = values[0] || 0;
    const last   = values[values.length - 1] || 0;
    const max    = values.length ? Math.max(...values) : 0;
    const min    = values.length ? Math.min(...values) : 0;

    res.json({
      history,
      points: history.length,
      summary: {
        first:   +first.toFixed(4),
        last:    +last.toFixed(4),
        max:     +max.toFixed(4),
        min:     +min.toFixed(4),
        change:  first > 0 ? +(((last - first) / first) * 100).toFixed(2) : 0,
        spanH:   history.length > 1
          ? +((history[history.length - 1].ts - history[0].ts) / 3_600_000).toFixed(1)
          : 0,
      },
    });
  });

  // ─── §v6 · Stats avancées par token ───────────────────────────────────────

  app.get('/api/token-stats', (_, res) => {
    const trades = bot.history;
    const byToken = {};

    for (const t of trades) {
      if (!t.mint) continue;
      if (!byToken[t.mint]) byToken[t.mint] = {
        mint: t.mint, symbol: t.symbol || t.mint.slice(0, 8),
        buys: 0, sells: 0, totalSolIn: 0, totalSolOut: 0,
        pnlSol: 0, pnlPcts: [], holdTimes: [],
      };
      const e = byToken[t.mint];
      if (t.type === 'buy')  { e.buys++;  e.totalSolIn  += (t.solSpent || 0); }
      if (t.type === 'sell') {
        e.sells++;
        e.totalSolOut += (t.solOut || 0);
        if (t.pnlSol  != null) e.pnlSol += t.pnlSol;
        if (t.pnlPct  != null) e.pnlPcts.push(t.pnlPct);
        if (t.holdMs  != null && t.holdMs > 0) e.holdTimes.push(t.holdMs);
      }
    }

    const rows = Object.values(byToken).map(e => ({
      mint: e.mint, symbol: e.symbol,
      buys: e.buys, sells: e.sells,
      totalSolIn:  +e.totalSolIn.toFixed(6),
      totalSolOut: +e.totalSolOut.toFixed(6),
      pnlSol:      +e.pnlSol.toFixed(6),
      avgPnlPct:   e.pnlPcts.length ? +(e.pnlPcts.reduce((a, b) => a + b, 0) / e.pnlPcts.length).toFixed(2) : null,
      bestPnlPct:  e.pnlPcts.length ? +Math.max(...e.pnlPcts).toFixed(2) : null,
      worstPnlPct: e.pnlPcts.length ? +Math.min(...e.pnlPcts).toFixed(2) : null,
      avgHoldMs:   e.holdTimes.length ? Math.round(e.holdTimes.reduce((a, b) => a + b, 0) / e.holdTimes.length) : null,
    })).sort((a, b) => b.pnlSol - a.pnlSol);

    const best  = rows[0] || null;
    const worst = rows[rows.length - 1] || null;

    res.json({
      tokens: rows,
      summary: {
        best:  best  ? { symbol: best.symbol,  pnlSol: best.pnlSol,  pnlPct: best.bestPnlPct }  : null,
        worst: worst ? { symbol: worst.symbol, pnlSol: worst.pnlSol, pnlPct: worst.worstPnlPct } : null,
        totalRealizedSol: +rows.reduce((s, r) => s + r.pnlSol, 0).toFixed(6),
        uniqueTokens: rows.length,
      },
    });
  });

  app.use((_, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(CFG.PORT, '0.0.0.0', () =>
    log('info', `API démarrée sur :${CFG.PORT}`, { version: VERSION }));
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §15  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  log('info', `🚀 SolBot v${VERSION} — Démarrage`, { env: CFG.NODE_ENV });

  const tpStr = CFG.TP_TIERS.map(t => `+${t.pnl}%→${t.sell}%`).join(' | ');
  log('info', '═══ STRATÉGIE ACTIVE ═══', {
    TP:        CFG.TP_ENABLED ? `✅ [${tpStr}]` : '❌ OFF',
    SL:        CFG.SL_ENABLED ? `✅ [${CFG.SL_PCT}%]` : '❌ OFF',
    BE:        CFG.BE_ENABLED ? `✅ [+${CFG.BE_BUFFER}%]` : '❌ OFF',
    TS:        CFG.TS_ENABLED ? `✅ [-${CFG.TS_PCT}%${CFG.TS_VOL ? ' σ' : ''}]` : '❌ OFF',
    AR:        CFG.AR_ENABLED ? `✅ [>${CFG.AR_PCT}%/cycle]` : '❌ OFF',
    LE:        CFG.LE_ENABLED ? `✅ [>${CFG.LE_PCT}% liq chute]` : '❌ OFF',
    TT:        CFG.TT_ENABLED ? `✅ [>${CFG.TT_HOURS}h stagnant]` : '❌ OFF',
    ME:        CFG.ME_ENABLED ? `✅ [${CFG.ME_THRESHOLD}%/cycle]` : '❌ OFF',
    JITO:      CFG.JITO_ENABLED ? `✅ [${CFG.JITO_TIP_SOL} SOL tip]` : '❌ OFF',
    HYST:      CFG.TP_HYSTERESIS + '%',
    INTERVAL:  CFG.INTERVAL_SEC + 's',
    PRICE_TTL: CFG.PRICE_TTL_MS / 1000 + 's',
    SCANNER:   CFG.SCANNER_ENABLED ? `✅ [score≥${CFG.SCANNER_MIN_SCORE} liq$${CFG.SCANNER_MIN_LIQ}-$${CFG.SCANNER_MAX_LIQ}]` : '❌ OFF',
    DAILY_LOSS:CFG.DAILY_LOSS_ENABLED ? `✅ [limit ${CFG.DAILY_LOSS_LIMIT} SOL/j]` : '❌ OFF',
  });

  const wallet = loadWallet();
  const rpc    = createRpc();
  const state  = loadState();
  const bot    = new BotLoop(wallet, rpc, state);

  // §v6 — Token Scanner
  const scanner = new TokenScanner(bot);
  if (CFG.SCANNER_ENABLED) scanner.start();

  log('info', 'Premier tick…');
  await bot.tick();

  setInterval(
    () => bot.tick().catch(err => log('error', 'Loop error', { err: err.message })),
    CFG.INTERVAL_SEC * 1000,
  );

  startApi(bot, wallet, scanner);

  log('success', '✅ Bot opérationnel', {
    address:  wallet.publicKey.toString().slice(0, 8) + '…',
    interval: CFG.INTERVAL_SEC + 's',
    reserve:  CFG.MIN_SOL_RESERVE + ' SOL',
    webhook:  CFG.WEBHOOK_URL ? CFG.WEBHOOK_TYPE : 'off',
  });

  const exit = () => { bot.persist(); log('info', 'Arrêt propre — état sauvegardé'); process.exit(0); };
  process.on('SIGINT',  exit);
  process.on('SIGTERM', exit);
  process.on('uncaughtException',  err => log('error', 'Exception non catchée',  { err: err.message }));
  process.on('unhandledRejection', r   => log('error', 'Rejection non gérée',    { reason: String(r).slice(0, 300) }));
}

main().catch(err => { console.error('Démarrage échoué:', err.message); process.exit(1); });
