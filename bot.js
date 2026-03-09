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
  } catch (err) { log('warn', 'Chargement état échoué — démarrage propre', { err: err.m
