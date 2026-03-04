/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                     SolBot v4.0 — Production Build                     ║
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
const SPL_TOKEN  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_2022   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const JITO_TIP_WALLET = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
const VERSION    = '4.0.0';

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
        const w = baseMs * 2 ** i;
        log('warn', `${label} retry ${i + 1}/${tries - 1} in ${w}ms — ${err.message}`);
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
      };
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
    if (this.sellFailures >= CFG.MAX_SELL_RETRIES) {
      const msg = `Circuit-breaker actif (${this.sellFailures} échecs consécutifs)`;
      log('error', msg); return { success: false, error: msg };
    }
    const release = await this.mutex.lock();
    try {
      const dec = await getDecimals(mint, this.rpc.conn);
      const raw = BigInt(Math.floor(amount * 10 ** dec));
      const res = useJito
        ? await this._buildAndSendJito({ inputMint: mint, outputMint: SOL_MINT, amountRaw: raw, slippageBps })
        : await this._buildAndSendTx({ inputMint: mint, outputMint: SOL_MINT, amountRaw: raw, slippageBps, priorityMode: 'high' });
      const solOut = Number(res.quote.outAmount) / 1e9;
      this.sellFailures = 0;
      log('success', '✅ Vente confirmée', { mint: mint.slice(0, 8), solOut: solOut.toFixed(6), reason, sig: res.sig });
      return { success: true, sig: res.sig, txUrl: res.txUrl, solOut, amountSold: amount };
    } catch (err) {
      this.sellFailures++;
      log('error', '❌ Vente échouée', { err: err.message, failures: this.sellFailures, reason });
      return { success: false, error: err.message };
    } finally { release(); }
  }

  async getSolBalance() {
    try { return await this.rpc.conn.getBalance(this.wallet.publicKey) / 1e9; }
    catch { return null; }
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
    } else {
      this.analytics.totalSoldSol = +(this.analytics.totalSoldSol + solOut).toFixed(6);
    }
    return { pnlSol, pnlPct, holdMs };
  }

  recordTrade(entry) {
    this.history.unshift({ ...entry, ts: Date.now() });
    if (this.history.length > 500) this.history.length = 500;
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
      if (markSLDone) this.positions.markSLDone(mint);
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

    if (pendingFirst) this.positions.clearSLPending(mint);
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
        if (info.mint === SOL_MINT) return false;
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
      const tv = tokens.reduce((s, t) => s + t.value, 0);
      log('debug', 'Cycle done', { tokens: tokens.length, total: `$${tv.toFixed(2)}`, cycle: this.cycle });

      if (this.cycle % 10 === 0) this.persist();
    } catch (err) {
      log('error', 'Tick error', { err: err.message });
      this.rpc.failover();
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
      },
      negCacheSize:       _negCache.size,
      sellCircuitBreaker: this.swap.sellFailures,
      lastUpdate:         new Date().toISOString(),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §14  API EXPRESS — 35 routes organisées par domaine
// ═══════════════════════════════════════════════════════════════════════════════

function startApi(bot, wallet) {
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
    const bal = await bot.swap.getSolBalance();
    res.json({ balance: bal, formatted: bal != null ? bal.toFixed(6) + ' SOL' : null });
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
    const { mint, solAmount, slippageBps = CFG.DEFAULT_SLIPPAGE, ignoreScore = false } = req.body;
    if (!mint || !solAmount) return res.status(400).json({ error: 'mint et solAmount requis' });
    const sol = parseFloat(solAmount);
    if (isNaN(sol) || sol <= 0 || sol > 100) return res.status(400).json({ error: 'solAmount invalide (0-100)' });
    if (bot.portfolio.length >= CFG.MAX_POSITIONS)
      return res.status(400).json({ error: `Max positions (${CFG.MAX_POSITIONS}) atteint` });

    if (!ignoreScore && CFG.MIN_SCORE > 0) {
      await prefetchPrices([mint]);
      const score = bot.scorer.score(getPrice(mint));
      if (score < CFG.MIN_SCORE)
        return res.status(400).json({ error: `Score trop faible: ${score}/${CFG.MIN_SCORE}`, score });
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
    log('info', `Helius scan — ${booted.length} positions bootstrappées`);

    for (const mint of booted) {
      try {
        const url = `https://api.helius.xyz/v0/addresses/${walletStr}/transactions?api-key=${CFG.HELIUS_KEY}&limit=100&type=SWAP`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) { results.push({ mint: mint.slice(0, 8), status: 'error', error: `HTTP ${r.status}` }); continue; }
        const txs = await r.json();
        let found = null;
        for (const tx of Array.isArray(txs) ? txs : []) {
          const recv = (tx.tokenTransfers || []).find(t => t.mint === mint && t.toUserAccount === walletStr && t.tokenAmount > 0);
          if (!recv) continue;
          const solOut = (tx.nativeTransfers || []).filter(n => n.fromUserAccount === walletStr).reduce((s, n) => s + (n.amount || 0), 0) / 1e9;
          if (solOut > 0 && recv.tokenAmount > 0) { found = { solSpent: solOut, tokReceived: recv.tokenAmount, entryPrice: solOut / recv.tokenAmount, ts: tx.timestamp }; break; }
        }
        if (found?.entryPrice > 0) {
          const old = bot.positions.entries.get(mint)?.price;
          bot.positions.setEntryPrice(mint, found.entryPrice);
          if (!bot.costBasis.has(mint))
            bot.costBasis.set(mint, { solSpent: found.solSpent, tokBought: found.tokReceived, buyTs: (found.ts || Date.now() / 1000) * 1000 });
          results.push({ mint: mint.slice(0, 8), status: 'fixed', entryPrice: found.entryPrice, priceBefore: old });
          log('success', `Entry corrigé ${mint.slice(0, 8)}`, { price: found.entryPrice.toPrecision(4) });
        } else { results.push({ mint: mint.slice(0, 8), status: 'not_found' }); }
        await sleep(250);
      } catch (err) { results.push({ mint: mint.slice(0, 8), status: 'error', error: err.message }); }
    }
    const fixed = results.filter(r => r.status === 'fixed').length;
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
    log('info', 'Circuit-breaker reset');
    res.json({ success: true });
  });

  // ─── §14.13 · 404 ─────────────────────────────────────────────────────────
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
  });

  const wallet = loadWallet();
  const rpc    = createRpc();
  const state  = loadState();
  const bot    = new BotLoop(wallet, rpc, state);

  log('info', 'Premier tick…');
  await bot.tick();

  setInterval(
    () => bot.tick().catch(err => log('error', 'Loop error', { err: err.message })),
    CFG.INTERVAL_SEC * 1000,
  );

  startApi(bot, wallet);

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
