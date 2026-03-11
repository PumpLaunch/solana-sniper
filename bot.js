/**
 * SolBot v6.0 — Production Build (All Patches Applied)
 *
 * PATCHES:
 *  [P1]  checkTP  — guard bootstrapped supprimé
 *  [P2]  checkSL  — guard bootstrapped supprimé
 *  [P3]  autoScanBootstrapped — forçage immédiat sans Helius
 *  [P4]  autoScanBootstrapped — batch 10, trié par bootAttempts
 *  [P5]  tick()   — catch 429/fetch-failed → sleep 5s, PAS de backoff 300s
 *  [P6]  SCANNER_DELAY_MS 15s → 45s
 *  [P7]  _evaluate — fallback PumpFun si liq=0
 *  [P8]  _fetchPumpFun — virtual reserves price + backup endpoint + fix falsy mcap=0
 *  [P9]  checkTP/SL/TS — garde-fou PnL > 100 000% = entrée corrompue → reset
 *  [P10] _connectWs — removeAllListeners() + close() avant reconnexion (fix détections dupliquées)
 *  [P11] _evaluate — requeue dans 30s si achat raté pour raison réseau
 *  [P12] setEntryPrice + checkTS — reset peak corrompu (trailing stop fantôme)
 *  [P13] _isValidMint — blacklist Memo v1/v2, Metaplex, Jupiter v6, Whirlpool, Serum
 *  [P14] _loop — batch prefetch prix avant évaluation + dedup WS 2s (_recentWs)
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

  TP_ENABLED:    process.env.TAKE_PROFIT_ENABLED !== 'true',
  TP_TIERS:      safeJson(process.env.TAKE_PROFIT_TIERS,
    [{ pnl: 20, sell: 20 }, { pnl: 50, sell: 25 }, { pnl: 100, sell: 25 }, { pnl: 200, sell: 25 }]),
  TP_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),
  BE_ENABLED:    process.env.BREAK_EVEN_ENABLED !== 'false',
  BE_BUFFER:     parseFloat(process.env.BREAK_EVEN_BUFFER || '2'),
  SL_ENABLED:    process.env.STOP_LOSS_ENABLED !== 'true',
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
  MAX_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS || '10'),
  MIN_SCORE:     parseFloat(process.env.MIN_SCORE_TO_BUY || '0'),
  MIN_SOL_RESERVE:  parseFloat(process.env.MIN_SOL_RESERVE   || '0.01'),
  MAX_SELL_RETRIES: parseInt(process.env.MAX_SELL_RETRIES     || '3'),
  DEFAULT_SLIPPAGE: parseInt(process.env.DEFAULT_SLIPPAGE     || '500'),
  PRICE_TTL_MS:     parseInt(process.env.PRICE_TTL_MS         || '55000'),
  BUY_COOLDOWN_MS:  parseInt(process.env.BUY_COOLDOWN_MS      || '5000'),
  WEBHOOK_URL:      process.env.WEBHOOK_URL       || null,
  WEBHOOK_TYPE:     process.env.WEBHOOK_TYPE      || 'discord',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID  || null,
  PYRAMID_ENABLED:    process.env.PYRAMID_ENABLED === 'true',
  PYRAMID_TIERS:      safeJson(process.env.PYRAMID_TIERS,
    [{ pnl: 30, addSol: 0.005 }, { pnl: 75, addSol: 0.005 }]),
  PYRAMID_MAX_SOL:    parseFloat(process.env.PYRAMID_MAX_SOL || '0.001'),
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
  REENTRY_SOL:       parseFloat(process.env.REENTRY_SOL       || '0.005'),
  REENTRY_MIN_GAIN:  parseFloat(process.env.REENTRY_MIN_GAIN  || '15'),
  SMART_SIZE_ENABLED: process.env.SMART_SIZE_ENABLED === 'true',
  SMART_SIZE_BASE:    parseFloat(process.env.SMART_SIZE_BASE  || '0.05'),
  SMART_SIZE_MULT:    parseFloat(process.env.SMART_SIZE_MULT  || '2.0'),
  SMART_SIZE_MIN:     parseFloat(process.env.SMART_SIZE_MIN   || '0.02'),
  SMART_SIZE_MAX:     parseFloat(process.env.SMART_SIZE_MAX   || '0.5'),
  SELL_TO_USDC: process.env.SELL_TO_USDC === 'true',
  SCANNER_ENABLED:     process.env.SCANNER_ENABLED === 'true',
  SCANNER_MIN_SCORE:   parseFloat(process.env.SCANNER_MIN_SCORE   || '60'),
  SCANNER_MIN_LIQ:     parseFloat(process.env.SCANNER_MIN_LIQ     || '5000'),
  SCANNER_MAX_LIQ:     parseFloat(process.env.SCANNER_MAX_LIQ     || '300000'),
  SCANNER_SOL_AMOUNT:  parseFloat(process.env.SCANNER_SOL_AMOUNT  || '0.005'),
  SCANNER_COOLDOWN_MS: parseInt(process.env.SCANNER_COOLDOWN_MS   || '300000'),
  SCANNER_DELAY_MS:    parseInt(process.env.SCANNER_DELAY_MS      || '45000'), // [P6] 15→45s
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

// ─────────────────────────────────────────────────────────────────────────────
// §2  DEPS & CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const {
  Connection, Keypair, PublicKey, VersionedTransaction,
  TransactionMessage, SystemProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58    = require('bs58');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const fetch   = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const SOL_MINT        = 'So11111111111111111111111111111111111111112';
const USDC_MINT       = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SPL_TOKEN       = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_2022        = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const JITO_TIP_WALLET = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
const VERSION         = '6.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// §3  UTILS
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = { info: 'i ', warn: '! ', error: 'X', debug: '?', success: '✅' };

function log(level, msg, data = null) {
  const safe = String(msg)
    .replace(/PRIVATE_KEY[=:]\S+/gi, 'PRIVATE_KEY=[REDACTED]')
    .replace(/api-key=[^&\s]+/gi,    'api-key=[REDACTED]');
  const sfx = data ? ' ' + JSON.stringify(data).slice(0, 500) : '';
  console.log(`${ICONS[level] ?? 'i '} [${new Date().toISOString()}] ${safe}${sfx}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { tries = 3, baseMs = 600, label = '' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); }
    catch (err) {
      last = err;
      if (i < tries - 1) {
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

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// §4  WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// §5  WALLET & RPC
// ─────────────────────────────────────────────────────────────────────────────

function loadWallet() {
  try {
    const raw = CFG.PRIVATE_KEY.startsWith('[')
      ? Uint8Array.from(JSON.parse(CFG.PRIVATE_KEY))
      : bs58.decode(CFG.PRIVATE_KEY);
    const kp = Keypair.fromSecretKey(raw);
    log('info', 'Wallet chargé', { address: kp.publicKey.toBase58().slice(0, 8) + '...' });
    return kp;
  } catch (err) { log('error', 'Clé invalide', { err: err.message }); process.exit(1); }
}

function createRpc() {
  const eps = [
    CFG.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_KEY}` : null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.public.blastapi.io',
  ].filter(Boolean);
  const conns = eps.map(e => new Connection(e, {
    commitment: 'confirmed', disableRetryOnRateLimit: false,
    confirmTransactionInitialTimeout: 60000,
    httpHeaders: { 'Content-Type': 'application/json' },
  }));
  let idx = 0;
  return {
    get conn()     { return conns[idx]; },
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

// ─────────────────────────────────────────────────────────────────────────────
// §6  PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

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
  } catch (err) { log('warn', 'Chargement état échoué', { err: err.message }); }
  return { entryPrices: {}, trades: [], stopLossHit: [], slPending: [], breakEven: [] };
}

function saveState(data) {
  try { fs.writeFileSync(CFG.DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch (err) { log('warn', 'Sauvegarde échouée', { err: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// §7  PRICE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const priceCache    = new Map();
const decimalsCache = new Map();
const liqHistory    = new Map();
const _failCount    = new Map();
const _negCache     = new Map();

function _negTTL(n) {
  if (n >= 10) return 6 * 3_600_000;
  if (n >= 6)  return 30 * 60_000;
  if (n >= 3)  return 5  * 60_000;
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
      log('warn', `Neg-cache: ${mint.slice(0,8)}... (${n} échecs → ${m < 60 ? m+'min' : (m/60).toFixed(0)+'h'})`);
    }
  }
}

function recordPriceSuccess(mint) { _failCount.delete(mint); _negCache.delete(mint); }

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
  const oldest = h[0].liq, latest = h[h.length - 1].liq;
  return oldest > 0 ? Math.max(0, ((oldest - latest) / oldest) * 100) : 0;
}

async function getDecimals(mint, conn) {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const dec  = info?.value?.data?.parsed?.info?.decimals;
    if (typeof dec === 'number') { decimalsCache.set(mint, dec); return dec; }
  } catch {}
  decimalsCache.set(mint, 6); return 6;
}

async function _fetchDexBatch(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { signal: AbortSignal.timeout(15_000) });
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
    } catch (err) {
      log('debug', 'DexBatch error', { err: err.message?.slice(0, 80) });
    }
    if (i + 30 < mints.length) await sleep(350);
  }
  return out;
}

async function _fetchDexSingle(mint) {
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(8_000) });
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

// [P8] _fetchPumpFun — virtual reserves price + backup endpoint + fix falsy mcap=0
// Les nouveaux tokens PumpFun ont toujours virtual_sol_reserves/virtual_token_reserves
// dès la création, mais usd_market_cap peut être 0 (falsy) pendant les premières secondes.
// Prix via réserves AMM virtuelles = fiable depuis le bloc 0.
async function _fetchPumpFun(mint) {
  const ENDPOINTS = [
    `https://frontend-api.pump.fun/coins/${mint}`,
    `https://frontend-api-v3.pump.fun/coins/${mint}`,
  ];
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': `SolBot/${VERSION}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) continue;
      const c = await r.json();
      if (!c || typeof c !== 'object') continue;

      // Prix via réserves AMM virtuelles (disponibles depuis le bloc 0)
      // virtual_sol_reserves   : lamports (1e9 = 1 SOL)
      // virtual_token_reserves : raw units (1e6 = 1 token, 6 décimales)
      let price = 0;
      const vsol = parseFloat(c.virtual_sol_reserves  || 0);
      const vtok = parseFloat(c.virtual_token_reserves || 0);
      if (vsol > 0 && vtok > 0) {
        const priceSol = (vsol / 1e9) / (vtok / 1e6);   // SOL par token
        const solUsd   = getPrice(SOL_MINT)?.price || 0;
        if (solUsd > 0) price = priceSol * solUsd;
      }
      // Fallback mcap/supply — != null car mcap peut légitimement valoir 0 (falsy)
      if (!(price > 0) && c.usd_market_cap != null && parseFloat(c.total_supply) > 0) {
        price = parseFloat(c.usd_market_cap) / parseFloat(c.total_supply);
      }
      if (!(price > 0)) continue;

      // Token gradué vers Raydium → réserves bonding curve vides, prix invalide
      // Laisser DexScreener gérer ces tokens
      if (c.complete === true) continue;

      // Liquidité = pool SOL virtuel × 2 × prix SOL/USD
      const solUsd = getPrice(SOL_MINT)?.price || 150;
      const liq    = vsol > 0 ? (vsol / 1e9) * solUsd * 2 : 0;

      return {
        price, liquidity: liq,
        volume24h: 0, volume6h: 0, volume1h: 0,
        change24h: 0, change6h: 0, change1h: 0,
        fdv:  parseFloat(c.usd_market_cap || 0) || price * parseFloat(c.total_supply || 1e9),
        mcap: parseFloat(c.usd_market_cap || 0),
        buys24h: 0, sells24h: 0, txns24h: 0,
        logo:   c.image_uri || null,
        symbol: c.symbol    || null,
        name:   c.name      || null,
        pairAddr: null, dex: 'pumpfun',
        createdAt: c.created_timestamp ? c.created_timestamp * 1000 : null,
        pumpfun: {
          progress:   vsol > 0 ? Math.min(100, vsol / 1e9 / 85 * 100) : 0,
          complete:   !!c.complete,
          kingOfHill: !!c.king_of_the_hill_timestamp,
          creator:    c.creator || null,
        },
        source: 'pumpfun',
      };
    } catch { continue; }
  }
  return null;
}

async function _fetchBirdeye(mint) {
  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${mint}`,
      { headers: { 'X-Chain': 'solana' }, signal: AbortSignal.timeout(8_000) });
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

async function prefetchPrices(mints) {
  const now = Date.now();
  const toFetch = mints.filter(m => {
    if (isNegCached(m)) return false;
    const c = priceCache.get(m);
    return !c || now - c.ts > CFG.PRICE_TTL_MS;
  });
  if (!toFetch.length) return;
  log('debug', 'Price fetch', { count: toFetch.length, negSkipped: mints.length - toFetch.length });

  const found = await _fetchDexBatch(toFetch);
  const lim5  = pLimit(5);
  const lim4  = pLimit(4);

  const miss1 = toFetch.filter(m => !found[m]);
  if (miss1.length) await Promise.all(miss1.map(m => lim5(async () => {
    const d = await _fetchDexSingle(m); if (d) found[m] = d;
  })));

  const miss2 = toFetch.filter(m => !found[m]);
  if (miss2.length) await Promise.all(miss2.map(m => lim5(async () => {
    const d = await _fetchPumpFun(m); if (d) found[m] = d;
  })));

  const miss3 = toFetch.filter(m => !found[m]);
  if (miss3.length) await Promise.all(miss3.map(m => lim4(async () => {
    const d = await _fetchBirdeye(m); if (d) found[m] = d;
  })));

  const ts = Date.now(); const srcs = {};
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
  const ok = toFetch.filter(m => priceCache.get(m)?.data?.price > 0).length;
  log('debug', 'Prices done', {
    ok, total: toFetch.length, missing: toFetch.length - ok,
    negCached: mints.filter(m => isNegCached(m)).length,
    sources: Object.keys(srcs).length ? srcs : undefined,
  });
}

function getPrice(mint) { return priceCache.get(mint)?.data ?? null; }

// ─────────────────────────────────────────────────────────────────────────────
// §8  SCORE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

class ScoreEngine {
  score(pd) {
    if (!pd) return 0;
    let s = 0;
    const liq = pd.liquidity || 0;
    if      (liq >= 50_000  && liq <= 300_000) s += 30;
    else if (liq >= 20_000  && liq <= 500_000) s += 22;
    else if (liq >= 10_000  && liq <= 700_000) s += 14;
    else if (liq >= 5_000)                     s += 7;
    else if (liq >= 1_000)                     s += 2;

    const mc = pd.mcap || pd.fdv || 0;
    if (mc > 0) {
      const r = (pd.volume24h || 0) / mc;
      if      (r >= 0.5)  s += 25;
      else if (r >= 0.2)  s += 20;
      else if (r >= 0.1)  s += 14;
      else if (r >= 0.05) s += 8;
      else if (r >= 0.02) s += 3;
    }

    const b = pd.buys24h || 0, sv = pd.sells24h || 0;
    if (b + sv > 0) {
      const r = b / (b + sv);
      if      (r >= 0.70) s += 15;
      else if (r >= 0.60) s += 11;
      else if (r >= 0.50) s += 7;
      else if (r >= 0.40) s += 3;
    }

    const c1 = pd.change1h || 0;
    if      (c1 >= 10) s += 15;
    else if (c1 >= 5)  s += 12;
    else if (c1 >= 2)  s += 8;
    else if (c1 >= 0)  s += 4;
    else if (c1 >= -5) s += 1;

    if (pd.createdAt) {
      const ageH = (Date.now() - pd.createdAt) / 3_600_000;
      if      (ageH <= 1)  s += 10;
      else if (ageH <= 6)  s += 8;
      else if (ageH <= 24) s += 5;
      else if (ageH <= 72) s += 2;
    }

    if (pd.pumpfun?.progress >= 80 && !pd.pumpfun.complete) s += 5;
    else if (pd.pumpfun?.progress >= 50) s += 2;

    return Math.min(100, Math.round(s));
  }

  slippage(liq, urgency = 'normal') {
    const base = urgency === 'emergency' ? 2000 : urgency === 'high' ? 1000 : CFG.DEFAULT_SLIPPAGE;
    if (!liq || liq > 100_000) return base;
    if (liq > 50_000)  return Math.max(base, 700);
    if (liq > 20_000)  return Math.max(base, 1000);
    if (liq > 5_000)   return Math.max(base, 1500);
    return Math.max(base, 2000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §9  MOMENTUM TRACKER
// ─────────────────────────────────────────────────────────────────────────────

class MomentumTracker {
  constructor() { this._hist = new Map(); }

  addPrice(mint, price) {
    if (!(price > 0)) return;
    const h = this._hist.get(mint) || [];
    h.push({ ts: Date.now(), price });
    if (h.length > 20) h.shift();
    this._hist.set(mint, h);
  }

  getTrend(mint, window = CFG.ME_WINDOW) {
    const h = this._hist.get(mint) || [];
    if (h.length < 3) return { trend: 'flat', changePct: 0, velocity: 0, accel: 0 };
    const pts   = h.slice(-Math.min(window + 1, h.length));
    const first = pts[0].price, last = pts[pts.length - 1].price;
    const chg   = first > 0 ? ((last - first) / first) * 100 : 0;
    const vel   = chg / (pts.length - 1);
    const mid   = Math.floor(pts.length / 2);
    const v1    = pts[0].price > 0 ? ((pts[mid].price - pts[0].price) / pts[0].price * 100) / (mid || 1) : 0;
    const v2    = pts[mid].price > 0 ? ((last - pts[mid].price) / pts[mid].price * 100) / (pts.length - 1 - mid || 1) : 0;
    return {
      trend:     chg > 1 ? 'up' : chg < -1 ? 'down' : 'flat',
      changePct: +chg.toFixed(3),
      velocity:  +vel.toFixed(3),
      accel:     +(v2 - v1).toFixed(3),
    };
  }

  isMomentumExit(mint, pnl) {
    if (!CFG.ME_ENABLED || pnl === null || pnl < 5) return false;
    const { trend, velocity, accel } = this.getTrend(mint);
    return trend === 'down' && velocity < CFG.ME_THRESHOLD && accel < -1;
  }

  getVolatility(mint) {
    const h = this._hist.get(mint) || [];
    if (h.length < 4) return null;
    const rets = [];
    for (let i = 1; i < h.length; i++) {
      if (h[i - 1].price > 0) rets.push(Math.log(h[i].price / h[i - 1].price) * 100);
    }
    return rets.length >= 3 ? stddev(rets) : null;
  }

  volTrailingPct(mint) {
    const sigma = this.getVolatility(mint);
    if (!sigma) return CFG.TS_PCT;
    return Math.min(CFG.TS_PCT * 2, Math.max(CFG.TS_PCT / 2, sigma * CFG.TS_VOL_MULT));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §10  POSITION MANAGER
// ─────────────────────────────────────────────────────────────────────────────

class PositionManager {
  constructor(tiers, hysteresis, state = {}) {
    this.tiers      = [...tiers].sort((a, b) => a.pnl - b.pnl);
    this.hysteresis = hysteresis;

    this.entries   = new Map();
    this.triggered = new Map();
    this.sold      = new Map();
    this.peak      = new Map();
    this.prevPrice = new Map();
    this.slHit     = new Set(state.stopLossHit || []);
    this.slPending = new Set(state.slPending   || []);
    this.breakEven = new Set(state.breakEven   || []);

    for (const [mint, d] of Object.entries(state.entryPrices || {})) {
      this.entries.set(mint, d);
      this.triggered.set(mint, new Set(d.triggeredTiers || []));
      this.sold.set(mint, d.soldAmount   || 0);
      this.peak.set(mint, d.peakPnl      || 0);
    }
    log('info', 'Positions restaurées', {
      count: this.entries.size, breakEven: this.breakEven.size, slHit: this.slHit.size,
    });

    this.pyramidDone = new Map();
    this.dcadDone    = new Map();
    this.addedSol    = new Map();
    this.slExitTs    = new Map();
    this.slExitPrice = new Map();

    for (const [mint, d] of Object.entries(state.entryPrices || {})) {
      if (d.pyramidDone)   this.pyramidDone.set(mint, new Set(d.pyramidDone));
      if (d.dcadDone >= 0) this.dcadDone.set(mint, d.dcadDone);
      if (d.addedSol  > 0) this.addedSol.set(mint, d.addedSol);
    }
    for (const [mint, info] of Object.entries(state.slExits || {})) {
      this.slExitTs.set(mint, info.ts);
      this.slExitPrice.set(mint, info.price);
    }
  }

  getPnl(mint, price) {
    const e = this.entries.get(mint);
    return (e && price > 0) ? ((price - e.price) / e.price) * 100 : null;
  }

  getRemaining(mint) {
    const e = this.entries.get(mint);
    return e ? Math.max(0, e.originalBalance - (this.sold.get(mint) || 0)) : 0;
  }

  isLiquidated(mint) { return this.slHit.has(mint) || this.slPending.has(mint); }

  trackEntry(mint, marketPrice, balance, forcedPrice = null) {
    if (this.entries.has(mint)) return false;
    const price        = forcedPrice > 0 ? forcedPrice : marketPrice;
    const bootstrapped = !(forcedPrice > 0);
    if (!(price > 0) || !(balance > 0)) return false;
    this.entries.set(mint, {
      price, bootstrapped, ts: Date.now(),
      originalBalance: balance,
      triggeredTiers: [], soldAmount: 0, peakPnl: 0, bootAttempts: 0,
    });
    this.triggered.set(mint, new Set());
    this.sold.set(mint, 0);
    this.peak.set(mint, 0);
    if (!bootstrapped) log('info', 'Position créée (swap réel)', {
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
    // Reset peak pour éviter trailing stop fantôme sur pic corrompu
    this.peak.set(mint, 0); e.peakPnl = 0;
    if (newBalance > 0) { e.originalBalance = newBalance; this.sold.set(mint, 0); e.soldAmount = 0; }
    log('info', 'Prix entrée corrigé', { mint: mint.slice(0, 8), price: newPrice.toPrecision(6) });
    return true;
  }

  updatePeak(mint, pnl) {
    if (pnl === null) return;
    const prev = this.peak.get(mint) || 0;
    if (pnl > prev) { this.peak.set(mint, pnl); const e = this.entries.get(mint); if (e) e.peakPnl = pnl; }
  }

  updatePrevPrice(mint, price) { if (price > 0) this.prevPrice.set(mint, price); }

  // [P1] guard bootstrapped supprimé — TP actif dès que entryPrice > 0
  checkTP(mint, price) {
    if (this.isLiquidated(mint)) return [];
    const e   = this.entries.get(mint);
    const trig = this.triggered.get(mint);
    const pnl  = this.getPnl(mint, price);
    if (!e || !trig || pnl === null || !(e.price > 0)) return [];
    // Garde-fou: PnL > 100 000% = prix d'entrée corrompu (SOL/token au lieu de USD/token)
    if (pnl > 100_000) {
      log('warn', `Prix d'entrée corrompu détecté — reset au prix courant`, { mint: mint.slice(0,8), pnl: pnl.toFixed(0) });
      this.setEntryPrice(mint, price);
      return [];
    }

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

  // [P2] guard bootstrapped supprimé — SL actif dès que entryPrice > 0
  checkSL(mint, price) {
    if (!CFG.SL_ENABLED || this.isLiquidated(mint)) return null;
    const e = this.entries.get(mint);
    if (!e || !(e.price > 0)) return null;
    const pnl = this.getPnl(mint, price);
    if (pnl === null) return null;
    if (pnl > 100_000) return null; // entrée corrompue — checkTP s'en occupe
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;

    if (this.breakEven.has(mint)) {
      if (pnl < CFG.BE_BUFFER)
        return { type: 'break-even', pnl: pnl.toFixed(2), threshold: CFG.BE_BUFFER, sellAmount: rem };
    } else {
      if (pnl > CFG.SL_PCT) return null;
      return { type: 'stop-loss', pnl: pnl.toFixed(2), threshold: CFG.SL_PCT, sellAmount: rem };
    }
    return null;
  }

  checkTS(mint, price, momentum = null) {
    if (!CFG.TS_ENABLED || this.isLiquidated(mint)) return null;
    const pnl  = this.getPnl(mint, price);
    const peak = this.peak.get(mint) || 0;
    if (pnl === null || peak < 10) return null;
    if (pnl > 100_000) return null; // entrée corrompue
    // Pic corrompu (entrée SOL/token) → reset et ignorer
    if (peak > 100_000) { this.peak.set(mint, Math.max(0, pnl || 0)); const e = this.entries.get(mint); if (e) e.peakPnl = 0; return null; }
    const trailingPct = (CFG.TS_VOL && momentum) ? momentum.volTrailingPct(mint) : CFG.TS_PCT;
    if (pnl >= peak - trailingPct) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'trailing-stop', pnl: pnl.toFixed(2), peak: peak.toFixed(2), trailingPct, sellAmount: rem };
  }

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

  checkLE(mint) {
    if (!CFG.LE_ENABLED || this.isLiquidated(mint)) return null;
    const drop = getLiqDrop(mint);
    if (drop < CFG.LE_PCT) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'liq-exit', drop: drop.toFixed(1), sellAmount: rem };
  }

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

  checkME(mint, price, momentum) {
    if (!momentum || this.isLiquidated(mint)) return null;
    const pnl = this.getPnl(mint, price);
    if (!momentum.isMomentumExit(mint, pnl)) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'momentum-exit', pnl: pnl?.toFixed(2), trend: momentum.getTrend(mint), sellAmount: rem };
  }

  markTierDone(mint, tierIdx, amountSold) {
    const trig = this.triggered.get(mint);
    const e    = this.entries.get(mint);
    if (!trig || !e) return;
    trig.add(tierIdx);
    const total = (this.sold.get(mint) || 0) + amountSold;
    this.sold.set(mint, total);
    e.triggeredTiers = Array.from(trig);
    e.soldAmount     = total;
    if (CFG.BE_ENABLED && tierIdx === 0) {
      this.breakEven.add(mint);
      log('info', 'Break-even activé (TP1)', { mint: mint.slice(0, 8) });
    }
    log('success', `TP palier ${tierIdx + 1} exécuté`, { mint: mint.slice(0, 8), sold: amountSold.toFixed(4) });
  }

  markSLDone(mint)     { this.slHit.add(mint); this.slPending.delete(mint); this.breakEven.delete(mint); }
  markSLPending(mint)  { this.slPending.add(mint); log('warn', 'SL pending', { mint: mint.slice(0, 8) }); }
  clearSLPending(mint) { this.slPending.delete(mint); }

  resetTiersIfNeeded(mint, pnl) {
    if (pnl === null) return;
    const trig = this.triggered.get(mint);
    const e    = this.entries.get(mint);
    if (!trig || !e) return;
    for (let i = 0; i < this.tiers.length; i++) {
      if (trig.has(i) && pnl < this.tiers[i].pnl - this.hysteresis) {
        trig.delete(i); e.triggeredTiers = Array.from(trig);
        log('debug', 'Tier réinitialisé', { mint: mint.slice(0, 8), tier: i + 1 });
      }
    }
    if (pnl < 0) this.breakEven.delete(mint);
  }

  checkPyramid(mint, price) {
    if (!CFG.PYRAMID_ENABLED || this.isLiquidated(mint)) return [];
    const e   = this.entries.get(mint);
    const pnl = this.getPnl(mint, price);
    if (!e || e.bootstrapped || pnl === null) return [];
    const alreadyAdded = this.addedSol.get(mint) || 0;
    if (alreadyAdded >= CFG.PYRAMID_MAX_SOL) return [];
    const done = this.pyramidDone.get(mint) || new Set();
    const hits = [];
    for (let i = 0; i < CFG.PYRAMID_TIERS.length; i++) {
      if (done.has(i)) continue;
      const tier  = CFG.PYRAMID_TIERS[i];
      if (pnl < tier.pnl) continue;
      const canAdd = Math.min(tier.addSol, CFG.PYRAMID_MAX_SOL - alreadyAdded);
      if (canAdd <= 0) continue;
      hits.push({ idx: i, pnlTarget: tier.pnl, currentPnl: +pnl.toFixed(2), addSol: canAdd });
    }
    return hits;
  }

  checkDCADown(mint, price, momentumTracker) {
    if (!CFG.DCAD_ENABLED || this.isLiquidated(mint)) return [];
    const e   = this.entries.get(mint);
    const pnl = this.getPnl(mint, price);
    if (!e || e.bootstrapped || pnl === null || pnl >= 0) return [];
    const doneCount = this.dcadDone.get(mint) || 0;
    if (doneCount >= CFG.DCAD_MAX_ADDS) return [];
    if (CFG.DCAD_REQUIRE_MOMENTUM && momentumTracker) {
      const { velocity } = momentumTracker.getTrend(mint);
      if (velocity < CFG.DCAD_MIN_VELOCITY) return [];
    }
    const hits = [];
    for (let i = 0; i < CFG.DCAD_TIERS.length; i++) {
      const tier = CFG.DCAD_TIERS[i];
      if (pnl > tier.pnl) continue;
      if (i !== doneCount) continue;
      hits.push({ idx: i, pnlTarget: tier.pnl, currentPnl: +pnl.toFixed(2), addSol: tier.addSol });
    }
    return hits;
  }

  checkReentry(mint, currentPrice, score) {
    if (!CFG.REENTRY_ENABLED || !this.slHit.has(mint)) return null;
    const exitTs    = this.slExitTs.get(mint);
    const exitPrice = this.slExitPrice.get(mint);
    if (!exitTs || !exitPrice) return null;
    if (Date.now() - exitTs < CFG.REENTRY_DELAY_MIN * 60_000) return null;
    const reboundPct = exitPrice > 0 ? ((currentPrice - exitPrice) / exitPrice) * 100 : 0;
    if (reboundPct < CFG.REENTRY_MIN_GAIN) return null;
    if (score < CFG.REENTRY_MIN_SCORE) return null;
    return { type: 're-entry', exitPrice, reboundPct: +reboundPct.toFixed(2), solAmount: CFG.REENTRY_SOL, score };
  }

  markPyramidDone(mint, tierIdx, tokBought, solSpent) {
    const e = this.entries.get(mint);
    if (!e) return;
    const newBal = e.originalBalance + tokBought;
    if (newBal > 0) e.price = (e.price * e.originalBalance + solSpent) / newBal;
    e.originalBalance = newBal;
    const done = this.pyramidDone.get(mint) || new Set();
    done.add(tierIdx); this.pyramidDone.set(mint, done); e.pyramidDone = Array.from(done);
    const total = (this.addedSol.get(mint) || 0) + solSpent;
    this.addedSol.set(mint, total); e.addedSol = total;
    this.triggered.set(mint, new Set()); e.triggeredTiers = []; this.breakEven.delete(mint);
    log('success', `PYRAMID T${tierIdx+1} — entrée recalculée`, { mint: mint.slice(0,8), newEntry: e.price.toPrecision(6) });
  }

  markDCADownDone(mint, tierIdx, tokBought, solSpent) {
    const e = this.entries.get(mint);
    if (!e) return;
    const newBal = e.originalBalance + tokBought;
    if (newBal > 0) e.price = (e.price * e.originalBalance + solSpent) / newBal;
    e.originalBalance = newBal;
    const count = (this.dcadDone.get(mint) || 0) + 1;
    this.dcadDone.set(mint, count); e.dcadDone = count;
    this.triggered.set(mint, new Set()); e.triggeredTiers = []; this.breakEven.delete(mint);
    log('success', `DCA-DOWN #${count} — entrée recalculée`, { mint: mint.slice(0,8) });
  }

  markExitForReentry(mint, price) { this.slExitTs.set(mint, Date.now()); this.slExitPrice.set(mint, price); }

  clearForReentry(mint) {
    for (const s of [this.slHit, this.slPending, this.breakEven]) s.delete(mint);
    for (const m of [this.pyramidDone, this.dcadDone, this.addedSol,
                     this.entries, this.triggered, this.sold, this.peak]) m.delete(mint);
    log('info', 'Re-entry: position réinitialisée', { mint: mint.slice(0,8) });
  }

  clearReentryBlock(mint) { this.slExitTs.delete(mint); this.slExitPrice.delete(mint); }

  resetPyramidIfNeeded(mint, pnl) {
    if (pnl === null) return;
    const done = this.pyramidDone.get(mint);
    if (!done) return;
    const e = this.entries.get(mint);
    for (let i = 0; i < CFG.PYRAMID_TIERS.length; i++) {
      if (done.has(i) && pnl < CFG.PYRAMID_TIERS[i].pnl - CFG.PYRAMID_HYSTERESIS) {
        done.delete(i); if (e) e.pyramidDone = Array.from(done);
      }
    }
  }

  serialize() {
    const out = {};
    for (const [mint, e] of this.entries) {
      out[mint] = {
        price: e.price, bootstrapped: e.bootstrapped || false, ts: e.ts,
        originalBalance: e.originalBalance,
        triggeredTiers:  Array.from(this.triggered.get(mint) || []),
        soldAmount:      this.sold.get(mint) || 0,
        peakPnl:         this.peak.get(mint) || 0,
        pyramidDone:     Array.from(this.pyramidDone.get(mint) || []),
        dcadDone:        this.dcadDone.get(mint) || 0,
        addedSol:        this.addedSol.get(mint) || 0,
      };
    }
    return out;
  }

  serializeSlExits() {
    const out = {};
    for (const [mint, ts] of this.slExitTs)
      out[mint] = { ts, price: this.slExitPrice.get(mint) || null };
    return out;
  }

  toApiRows() {
    const rows = [];
    for (const [mint, e] of this.entries) {
      const pd = getPrice(mint);
      rows.push({
        mint, symbol: pd?.symbol || null,
        entryPrice: e.price, bootstrapped: !!e.bootstrapped,
        originalBalance: e.originalBalance,
        sold:      this.sold.get(mint) || 0,
        remaining: this.getRemaining(mint),
        triggeredTiers: Array.from(this.triggered.get(mint) || []).map(i => this.tiers[i]?.pnl),
        stopLossHit: this.slHit.has(mint), slPending: this.slPending.has(mint),
        breakEven: this.breakEven.has(mint), peakPnl: this.peak.get(mint) || 0,
        entryTs: e.ts, liqDrop: getLiqDrop(mint),
      });
    }
    return rows;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §11  SWAP ENGINE
// ─────────────────────────────────────────────────────────────────────────────

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
    this._cbTrippedAt = null;
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
        if (q.error || !q.outAmount) { last = new Error(q.error || 'No outAmount'); continue; }
        return q;
      } catch (err) { last = err; }
    }
    throw last || new Error('Tous les endpoints Jupiter quote ont échoué');
  }

  async _buildAndSendTx({ inputMint, outputMint, amountRaw, slippageBps, priorityMode = 'auto' }) {
    return withRetry(async () => {
      const quote = await this.getQuote({ inputMint, outputMint, amountRaw, slippageBps });
      const priLamports = priorityMode === 'turbo'  ? 500_000
                        : priorityMode === 'high'   ? 200_000
                        : priorityMode === 'medium' ? 100_000
                        : 'auto';
      const body = JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priLamports,
      });
      let swapData = null, swapErr;
      for (const ep of SWAP_EPS) {
        try {
          const r = await fetch(ep, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `SolBot/${VERSION}` },
            body, signal: AbortSignal.timeout(30_000),
          });
          if (!r.ok) { swapErr = new Error(`Swap HTTP ${r.status}`); continue; }
          const d = await r.json();
          if (d?.swapTransaction) { swapData = d; break; }
          swapErr = new Error('swapTransaction absent');
        } catch (err) { swapErr = err; }
      }
      if (!swapData) throw swapErr || new Error('Tous les endpoints swap ont échoué');
      const tx  = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      const lbh = await this.rpc.conn.getLatestBlockhash('confirmed');
      tx.sign([this.wallet]);
      const sig  = await this.rpc.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });
      const conf = await this.rpc.conn.confirmTransaction({ signature: sig, blockhash: lbh.blockhash, lastValidBlockHeight: lbh.lastValidBlockHeight }, 'confirmed');
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
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 500_000,
      });
      let swapData = null;
      for (const ep of SWAP_EPS) {
        try {
          const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
          if (r.ok) { const d = await r.json(); if (d?.swapTransaction) { swapData = d; break; } }
        } catch {}
      }
      if (!swapData) throw new Error('Swap data manquante');
      const lbh    = await this.rpc.conn.getLatestBlockhash('confirmed');
      const swapTx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      const tipTx  = new VersionedTransaction(new TransactionMessage({
        payerKey: this.wallet.publicKey, recentBlockhash: lbh.blockhash,
        instructions: [SystemProgram.transfer({
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
      log('info', 'Jito bundle confirmé', { sig: sig.slice(0, 16) });
      return { sig, txUrl: `https://solscan.io/tx/${sig}`, quote };
    } catch (err) {
      log('warn', 'Jito échoué — fallback Jupiter', { err: err.message });
      return this._buildAndSendTx({ inputMint, outputMint, amountRaw, slippageBps, priorityMode: 'turbo' });
    }
  }

  async buy(mint, solAmount, slippageBps = CFG.DEFAULT_SLIPPAGE) {
    const elapsed = Date.now() - this.lastBuyTs;
    if (elapsed < CFG.BUY_COOLDOWN_MS)
      throw new Error(`Cooldown: ${((CFG.BUY_COOLDOWN_MS - elapsed) / 1000).toFixed(1)}s restantes`);
    const bal = await this.getSolBalance();
    if (bal !== null && bal < solAmount + CFG.MIN_SOL_RESERVE)
      throw new Error(`Solde insuffisant: ${bal.toFixed(4)} SOL`);
    const raw = BigInt(Math.floor(solAmount * 1e9));
    const { sig, txUrl, quote } = await this._buildAndSendTx({ inputMint: SOL_MINT, outputMint: mint, amountRaw: raw, slippageBps });
    const dec       = await getDecimals(mint, this.rpc.conn);
    const outAmount = Number(quote.outAmount) / 10 ** dec;
    this.lastBuyTs  = Date.now();
    log('success', 'Achat confirmé', { mint: mint.slice(0, 8), tokens: outAmount.toFixed(4), sig });
    return { success: true, sig, txUrl, outAmount, solSpent: solAmount };
  }

  async buyDCA(mint, totalSol, chunks, intervalSec, slippageBps = CFG.DEFAULT_SLIPPAGE) {
    const chunkSol = totalSol / chunks;
    const results  = [];
    log('info', 'DCA démarré', { mint: mint.slice(0, 8), totalSol, chunks, intervalSec });
    for (let i = 0; i < chunks; i++) {
      try {
        const r = await this.buy(mint, chunkSol, slippageBps);
        results.push({ chunk: i + 1, ...r });
      } catch (err) { results.push({ chunk: i + 1, success: false, error: err.message }); }
      if (i < chunks - 1) await sleep(intervalSec * 1000);
    }
    return { results, succeeded: results.filter(r => r.success).length, total: chunks };
  }

  async sell(mint, amount, reason = 'MANUAL', slippageBps = CFG.DEFAULT_SLIPPAGE, useJito = false) {
    const CB_RESET_MS = 5 * 60_000;
    if (this.sellFailures >= CFG.MAX_SELL_RETRIES) {
      const age = Date.now() - (this._cbTrippedAt || 0);
      if (age >= CB_RESET_MS) {
        log('info', `Circuit-breaker auto-reset (${Math.round(age / 60000)}min)`);
        this.sellFailures = 0; this._cbTrippedAt = null;
      } else {
        const msg = `Circuit-breaker actif — reset dans ${Math.round((CB_RESET_MS - age) / 1000)}s`;
        log('error', msg);
        return { success: false, error: msg, cbBlocked: true };
      }
    }
    const release = await this.mutex.lock();
    try {
      const dec    = await getDecimals(mint, this.rpc.conn);
      const raw    = BigInt(Math.floor(amount * 10 ** dec));
      const outMint = CFG.SELL_TO_USDC ? USDC_MINT : SOL_MINT;
      const res = useJito
        ? await this._buildAndSendJito({ inputMint: mint, outputMint: outMint, amountRaw: raw, slippageBps })
        : await this._buildAndSendTx({ inputMint: mint, outputMint: outMint, amountRaw: raw, slippageBps, priorityMode: 'high' });

      let solOut, usdcOut = null;
      if (CFG.SELL_TO_USDC) {
        usdcOut = Number(res.quote.outAmount) / 1e6;
        const solPriceUSD = getPrice(SOL_MINT)?.price || null;
        solOut = solPriceUSD ? usdcOut / solPriceUSD : usdcOut / 150;
        log('success', 'Vente USDC confirmée', { mint: mint.slice(0, 8), usdcOut: usdcOut.toFixed(4), reason });
      } else {
        solOut = Number(res.quote.outAmount) / 1e9;
        log('success', 'Vente SOL confirmée', { mint: mint.slice(0, 8), solOut: solOut.toFixed(6), reason });
      }
      this.sellFailures = 0;
      return { success: true, sig: res.sig, txUrl: res.txUrl, solOut, usdcOut, amountSold: amount };
    } catch (err) {
      this._lastBuyErr = err.message || '';
      const isNetwork = (
        err.message?.includes('fetch failed') ||
        err.message?.includes('ENOTFOUND')    ||
        err.message?.includes('ETIMEDOUT')    ||
        err.message?.includes('ECONNRESET')   ||
        err.message?.includes('ECONNREFUSED') ||
        err.message?.includes('429')          ||
        err.message?.includes('Too Many Requests') ||
        err.message?.includes('socket hang up')
      );
      if (isNetwork) {
        log('warn', `Vente réseau erreur (non comptée CB): ${err.message.slice(0, 80)}`);
        try { this.rpc.failover(); } catch {}
      } else {
        this.sellFailures++;
        if (this.sellFailures >= CFG.MAX_SELL_RETRIES && !this._cbTrippedAt) {
          this._cbTrippedAt = Date.now();
          log('warn', 'Circuit-breaker déclenché — auto-reset dans 5min');
        }
        log('error', 'Vente échouée', { err: err.message, failures: this.sellFailures, reason });
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
        this.wallet.publicKey, { mint: new PublicKey(USDC_MINT) });
      if (!accounts.value.length) return 0;
      return parseFloat(accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? '0');
    } catch { return null; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §12  ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

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
    this.totalSoldSol   = +(this.totalSoldSol + solOut).toFixed(6);
    this.realizedPnlSol = +(this.realizedPnlSol + pnlSol).toFixed(6);
    this.tradePnls.push(pnlPct ?? 0);
    if (this.tradePnls.length > 500) this.tradePnls.shift();
    if (pnlSol >= 0) {
      this.winCount++; this.winStreak++; this.lossStreak = 0;
      this.maxWinStreak = Math.max(this.maxWinStreak, this.winStreak);
      if (pnlPct !== null && (this.bestTradePct === null || pnlPct > this.bestTradePct))
        { this.bestTradePct = pnlPct; this.bestTradeSymbol = symbol; }
    } else {
      this.lossCount++; this.lossStreak++; this.winStreak = 0;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.lossStreak);
      if (pnlPct !== null && (this.worstTradePct === null || pnlPct < this.worstTradePct))
        { this.worstTradePct = pnlPct; this.worstTradeSymbol = symbol; }
    }
    this.avgHoldMs = Math.round((this.avgHoldMs * (this.totalTrades - 1) + holdMs) / this.totalTrades);
    const today = new Date().toISOString().slice(0, 10);
    const day   = this.dailyPnl.find(d => d.date === today);
    if (day) { day.pnlSol = +(day.pnlSol + pnlSol).toFixed(6); day.trades++; day.wins += pnlSol >= 0 ? 1 : 0; }
    else      this.dailyPnl.push({ date: today, pnlSol: +pnlSol.toFixed(6), trades: 1, wins: pnlSol >= 0 ? 1 : 0 });
    if (this.dailyPnl.length > 90) this.dailyPnl.shift();
    this.pnlHistory.push({ ts: Date.now(), cumul: +this.realizedPnlSol.toFixed(6) });
    if (this.pnlHistory.length > 500) this.pnlHistory.shift();
    const hr = new Date().getHours();
    this.hourly[hr].trades++;
    this.hourly[hr].pnlSol = +(this.hourly[hr].pnlSol + pnlSol).toFixed(6);
    if (pnlSol >= 0) this.hourly[hr].wins++;
  }

  sharpe()  { if (this.tradePnls.length < 5) return null; const s = stddev(this.tradePnls); return s > 0 ? +(mean(this.tradePnls) / s).toFixed(3) : null; }
  sortino() { if (this.tradePnls.length < 5) return null; const l = this.tradePnls.filter(p => p < 0); if (!l.length) return null; const ds = stddev(l); return ds > 0 ? +(mean(this.tradePnls) / ds).toFixed(3) : null; }
  maxDrawdown() { let peak = 0, dd = 0; for (const { cumul } of this.pnlHistory) { if (cumul > peak) peak = cumul; if (peak - cumul > dd) dd = peak - cumul; } return +dd.toFixed(6); }
  profitFactor() { const g = this.tradePnls.filter(p => p > 0).reduce((a, b) => a + b, 0); const l = Math.abs(this.tradePnls.filter(p => p < 0).reduce((a, b) => a + b, 0)); return l > 0 ? +(g / l).toFixed(3) : null; }
  bestDay()  { return this.dailyPnl.reduce((b, d) => d.pnlSol > (b?.pnlSol ?? -Infinity) ? d : b, null); }
  worstDay() { return this.dailyPnl.reduce((w, d) => d.pnlSol < (w?.pnlSol ??  Infinity) ? d : w, null); }
  bestHour() { return this.hourly.map((h, i) => ({ hour: i, ...h })).filter(h => h.trades >= 2).sort((a, b) => b.pnlSol - a.pnlSol)[0] ?? null; }

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
      realizedPnlSol: +this.realizedPnlSol.toFixed(4),
      totalBoughtSol: +this.totalBoughtSol.toFixed(4),
      totalSoldSol:   +this.totalSoldSol.toFixed(4),
      roi: this.totalBoughtSol > 0 ? +((this.realizedPnlSol / this.totalBoughtSol) * 100).toFixed(2) : null,
      winCount: this.winCount, lossCount: this.lossCount, totalTrades: this.totalTrades,
      wins: this.winCount, losses: this.lossCount,
      buys: history.filter(t => t.type === 'buy').length, sells: sells.length,
      winRate:  n > 0         ? +((this.winCount / n) * 100).toFixed(1) : null,
      avgWin:   wins.length   ? +(wins.reduce((s, t)  => s + t.pnlPct, 0) / wins.length).toFixed(1)  : null,
      avgLoss:  loses.length  ? +(loses.reduce((s, t) => s + t.pnlPct, 0) / loses.length).toFixed(1) : null,
      avgHold:  this.avgHoldMs > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : null,
      bestTradePct: this.bestTradePct, bestTradeSymbol: this.bestTradeSymbol,
      worstTradePct: this.worstTradePct, worstTradeSymbol: this.worstTradeSymbol,
      sharpeRatio: this.sharpe(), sortinoRatio: this.sortino(),
      maxDrawdownSol: this.maxDrawdown(), profitFactor: this.profitFactor(),
      winStreak: this.winStreak, maxWinStreak: this.maxWinStreak,
      lossStreak: this.lossStreak, maxLossStreak: this.maxLossStreak,
      bestDay: this.bestDay(), worstDay: this.worstDay(), bestHour: this.bestHour(),
      dailyPnl: this.dailyPnl.slice(-30), pnlHistory: this.pnlHistory.slice(-200),
      hourlyStats: this.hourly,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §13  BOT LOOP
// ─────────────────────────────────────────────────────────────────────────────

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

    this.dailyLoss = {
      date:        this._today(),
      realizedSol: state.dailyLoss?.date === this._today() ? (state.dailyLoss?.realizedSol || 0) : 0,
      paused:      false,
    };
    this.valueHistory = state.valueHistory || [];
  }

  _today() { return new Date().toISOString().slice(0, 10); }

  persist() {
    saveState({
      entryPrices:  this.positions.serialize(),
      trades:       this.history.slice(0, 500),
      stopLossHit:  Array.from(this.positions.slHit),
      slPending:    Array.from(this.positions.slPending),
      breakEven:    Array.from(this.positions.breakEven),
      analytics:    this.analytics.serialize(),
      costBasis:    Object.fromEntries(this.costBasis),
      slExits:      this.positions.serializeSlExits(),
      dailyLoss:    { date: this.dailyLoss.date, realizedSol: this.dailyLoss.realizedSol },
      valueHistory: this.valueHistory.slice(-CFG.HISTORY_MAX_POINTS),
    });
  }

  recordBuy(mint, solSpent, tokBought) {
    const cb = this.costBasis.get(mint);
    if (cb) { cb.solSpent += solSpent; cb.tokBought += tokBought; }
    else    this.costBasis.set(mint, { solSpent, tokBought, buyTs: Date.now() });
    this.analytics.totalBoughtSol = +(this.analytics.totalBoughtSol + solSpent).toFixed(6);
  }

  recordSell(mint, solOut, amountSold, symbol) {
    const cb = this.costBasis.get(mint);
    let pnlSol = null, pnlPct = null, holdMs = 0;
    if (cb?.solSpent > 0 && cb?.tokBought > 0) {
      const pct  = Math.min(amountSold / cb.tokBought, 1);
      const cost = cb.solSpent * pct;
      pnlSol     = +(solOut - cost).toFixed(6);
      pnlPct     = cost > 0 ? +((pnlSol / cost) * 100).toFixed(2) : null;
      holdMs     = Date.now() - (cb.buyTs || Date.now());
      cb.solSpent  *= (1 - pct);
      cb.tokBought -= amountSold;
      if (cb.tokBought <= 0) this.costBasis.delete(mint);
      this.analytics.record({ pnlSol, pnlPct, holdMs, symbol, solOut });
      this._trackDailyLoss(pnlSol);
    } else {
      this.analytics.totalSoldSol = +(this.analytics.totalSoldSol + solOut).toFixed(6);
    }
    return { pnlSol, pnlPct, holdMs };
  }

  _trackDailyLoss(pnlSol) {
    const today = this._today();
    if (this.dailyLoss.date !== today)
      this.dailyLoss = { date: today, realizedSol: 0, paused: false };
    this.dailyLoss.realizedSol = +(this.dailyLoss.realizedSol + pnlSol).toFixed(6);
    if (CFG.DAILY_LOSS_ENABLED && this.dailyLoss.realizedSol <= CFG.DAILY_LOSS_LIMIT && !this.dailyLoss.paused) {
      this.dailyLoss.paused = true;
      log('warn', `DAILY LOSS LIMIT atteint (${this.dailyLoss.realizedSol.toFixed(4)} SOL) — achats suspendus`);
      webhook('Daily Loss Limit atteint',
        `Pertes du jour : **${this.dailyLoss.realizedSol.toFixed(4)} SOL** (limite : ${CFG.DAILY_LOSS_LIMIT} SOL)`,
        0xff2d55, [{ name: 'Date', value: today, inline: true }]).catch(() => {});
    }
  }

  isDailyLossPaused() {
    const today = this._today();
    if (this.dailyLoss.date !== today) this.dailyLoss = { date: today, realizedSol: 0, paused: false };
    return CFG.DAILY_LOSS_ENABLED && this.dailyLoss.paused;
  }

  recordTrade(entry) {
    this.history.unshift({ ...entry, ts: Date.now() });
    if (this.history.length > 500) this.history.length = 500;
  }

  calcSmartSize(score) {
    if (!CFG.SMART_SIZE_ENABLED) return null;
    const factor = 1 + ((Math.max(0, Math.min(100, score || 50)) - 50) / 50) * (CFG.SMART_SIZE_MULT - 1);
    return Math.max(CFG.SMART_SIZE_MIN, Math.min(CFG.SMART_SIZE_MAX, +(CFG.SMART_SIZE_BASE * factor).toFixed(4)));
  }

  async _autoBuy(mint, solAmount, reason, priceData, opts = {}) {
    const { onSuccess, webhookTitle, webhookDesc, webhookColor = 0x3b7eff, webhookFields = [] } = opts;
    const bal = await this.swap.getSolBalance();
    if (bal !== null && bal < solAmount + CFG.MIN_SOL_RESERVE) {
      log('warn', `_autoBuy: solde insuffisant pour ${reason}`, { available: bal?.toFixed(4) });
      return false;
    }
    if (this.isDailyLossPaused() && !reason.startsWith('PYRAMID') && !reason.startsWith('DCAD')) {
      log('warn', `_autoBuy bloqué par Daily Loss Limit (${reason})`);
      return false;
    }
    const bps = this.scorer.slippage(priceData?.liquidity, 'normal');
    let result;
    try { result = await this.swap.buy(mint, solAmount, bps); }
    catch (err) { log('error', `_autoBuy échoué (${reason})`, { err: err.message }); return false; }
    if (!result.success) { log('warn', `_autoBuy refusé (${reason})`, { err: result.error }); return false; }

    const sym           = priceData?.symbol || mint.slice(0, 8);
    const tokBought     = result.outAmount || 0;
    // Prix d'entrée doit être en USD (même unité que priceCache)
    // solAmount/tokBought = SOL/token → multiplier par SOL/USD pour avoir USD/token
    const solUsdRate    = getPrice(SOL_MINT)?.price || 0;
    const exactEntryPrice = priceData?.price > 0
      ? priceData.price  // prix USD déjà disponible au moment de l'achat
      : (tokBought > 0 && solUsdRate > 0
          ? (solAmount / tokBought) * solUsdRate
          : (tokBought > 0 ? solAmount / tokBought : 0));
    this.recordBuy(mint, solAmount, tokBought);

    if (!this.positions.entries.has(mint)) {
      this.positions.trackEntry(mint, exactEntryPrice, tokBought, exactEntryPrice);
    } else {
      const e = this.positions.entries.get(mint);
      const cb = this.costBasis.get(mint);
      if (e && cb && cb.tokBought > 0) {
        e.price = +(cb.solSpent / cb.tokBought).toPrecision(10);
        e.bootstrapped = false;
      }
    }
    this.recordTrade({ type: 'buy', mint, symbol: sym, solSpent: solAmount, outAmount: tokBought,
      entryPrice: exactEntryPrice, reason, txId: result.sig, txUrl: result.txUrl });
    if (onSuccess) onSuccess(result, result.outAmount || 0);
    if (webhookTitle) {
      await webhook(`🟢 ${webhookTitle}`,
        `${webhookDesc || ''} | ${sym} +${result.outAmount?.toFixed(4)} tokens`,
        webhookColor, [...webhookFields,
          { name: 'SOL investis', value: solAmount.toFixed(4), inline: true },
          { name: 'Raison',       value: reason,               inline: true },
        ]);
    }
    return true;
  }

  async _sell(mint, sellAmount, reason, priceData, opts = {}) {
    const { useJito = false, slippage, pendingFirst = false, markSLDone: msl = false,
            onSuccess, webhookTitle, webhookDesc, webhookColor = 0x3b7eff, webhookFields = [] } = opts;
    if (pendingFirst) this.positions.markSLPending(mint);
    const bps = slippage ?? this.scorer.slippage(priceData?.liquidity, useJito ? 'emergency' : pendingFirst ? 'high' : 'normal');
    const res = await this.swap.sell(mint, sellAmount, reason, bps, useJito);
    if (res.success) {
      const symbol = priceData?.symbol || mint.slice(0, 8);
      const { pnlSol, pnlPct } = this.recordSell(mint, res.solOut, sellAmount, symbol);
      this.recordTrade({ type: 'sell', mint, symbol, amount: sellAmount, solOut: res.solOut,
        reason, txId: res.sig, txUrl: res.txUrl, pnlSol, pnlPct });
      if (msl) { this.positions.markExitForReentry(mint, priceData?.price || 0); this.positions.markSLDone(mint); }
      if (onSuccess)     onSuccess(res);
      if (webhookTitle) {
        const ok = pnlSol !== null && pnlSol >= 0;
        const pnlStr = pnlPct !== null ? ` | ${pnlPct >= 0 ? '+' : ''}${pnlPct}%` : '';
        await webhook(`${ok ? '✅' : '🔴'} ${webhookTitle}`,
          `${webhookDesc || ''}${pnlStr}`, ok ? 0x05d488 : webhookColor,
          [...webhookFields,
            { name: 'SOL reçu', value: res.solOut?.toFixed(6) || '?', inline: true },
            { name: 'Raison',   value: reason,                        inline: true },
          ]);
      }
      return true;
    }
    if (pendingFirst && !res.cbBlocked) this.positions.clearSLPending(mint);
    return false;
  }

  // ── Tick principal ────────────────────────────────────────────────────────
  async tick() {
    try {
      if (this.cycle % 10 === 0) await this.rpc.healthCheck();
      this.cycle++;

      // [P5] Lecture comptes token — 429/fetch-failed → sleep 5s, pas de backoff 300s
      let r1, r2;
      try {
        [r1, r2] = await Promise.all([
          this.rpc.conn.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(SPL_TOKEN) }),
          this.rpc.conn.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(SPL_2022)  }),
        ]);
      } catch (rpcErr) {
        const is429 = rpcErr.message?.includes('429') || rpcErr.message?.includes('Too Many Requests');
        const isNet = rpcErr.message?.includes('fetch failed') || rpcErr.message?.includes('ENOTFOUND') || rpcErr.message?.includes('ETIMEDOUT');
        log('warn', `Tick RPC ${is429 ? '429' : isNet ? 'network' : 'error'} — failover + skip cycle`, { err: rpcErr.message?.slice(0, 80) });
        this.rpc.failover();
        await sleep(5000); // 5s max, pas de backoff progressif
        return;
      }

      const accounts = [...r1.value, ...r2.value].filter(acc => {
        const info = acc.account.data.parsed.info;
        if (info.mint === SOL_MINT || info.mint === USDC_MINT) return false;
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
        if (price > 0)    this.momentum.addPrice(mint, price);

        if (price > 0) {
          const sym = pd?.symbol || mint.slice(0, 8);

          const ar = this.positions.checkAR(mint, price);
          if (ar) {
            log('error', `ANTI-RUG -${ar.drop}%`, { mint: mint.slice(0, 8) });
            await this._sell(mint, ar.sellAmount, 'ANTI_RUG', pd, {
              useJito: true, pendingFirst: true, markSLDone: true,
              webhookTitle: 'Anti-Rug', webhookDesc: `Chute -${ar.drop}% sur **${sym}**`, webhookColor: 0xff2d55 });
          }
          const le = this.positions.checkLE(mint);
          if (le) {
            log('error', `LIQUIDITY EXIT -${le.drop}%`, { mint: mint.slice(0, 8) });
            await this._sell(mint, le.sellAmount, 'LIQ_EXIT', pd, {
              useJito: true, pendingFirst: true, markSLDone: true,
              webhookTitle: 'Liquidity Exit', webhookDesc: `Liq -${le.drop}% sur **${sym}**`, webhookColor: 0xff4500 });
          }
          if (CFG.TP_ENABLED && pnl !== null) {
            for (const hit of this.positions.checkTP(mint, price)) {
              log('warn', `TP T${hit.idx + 1} +${hit.currentPnl}%`, { mint: mint.slice(0, 8) });
              await this._sell(mint, hit.sellAmount, `TP_T${hit.idx + 1}`, pd, {
                onSuccess: () => this.positions.markTierDone(mint, hit.idx, hit.sellAmount),
                webhookTitle: `Take-Profit T${hit.idx + 1}`,
                webhookDesc:  `+${hit.currentPnl}% sur **${sym}**`,
                webhookColor: 0x00d97e,
                webhookFields: [{ name: 'Vendu', value: hit.sellAmount.toFixed(4), inline: true }] });
            }
            this.positions.resetTiersIfNeeded(mint, pnl);
          }
          const sl = this.positions.checkSL(mint, price);
          if (sl) {
            const label = sl.type === 'break-even' ? 'Break-Even' : 'Stop-Loss';
            log('warn', `${label.toUpperCase()} ${sl.pnl}%`, { mint: mint.slice(0, 8) });
            await this._sell(mint, sl.sellAmount, sl.type.toUpperCase().replace('-','_'), pd, {
              pendingFirst: true, markSLDone: true,
              webhookTitle: label, webhookDesc: `**${sym}** à ${sl.pnl}%`, webhookColor: 0xff2d55 });
          }
          const ts = this.positions.checkTS(mint, price, this.momentum);
          if (ts) {
            log('warn', `TRAILING pic:+${ts.peak}% actuel:${ts.pnl}%`, { mint: mint.slice(0, 8) });
            await this._sell(mint, ts.sellAmount, 'TRAILING_STOP', pd, {
              pendingFirst: true, markSLDone: true,
              webhookTitle: 'Trailing Stop', webhookDesc: `**${sym}** pic:+${ts.peak}% actuel:${ts.pnl}%`, webhookColor: 0xff9800 });
          }
          const tt = this.positions.checkTT(mint, pnl);
          if (tt) {
            log('warn', `TIME STOP ${tt.holdHours}h`, { mint: mint.slice(0, 8) });
            await this._sell(mint, tt.sellAmount, 'TIME_STOP', pd, {
              pendingFirst: true, markSLDone: true,
              webhookTitle: 'Time Stop', webhookDesc: `**${sym}** stagnant ${tt.holdHours}h`, webhookColor: 0x9b59b6 });
          }
          const me = this.positions.checkME(mint, price, this.momentum);
          if (me) {
            log('warn', `MOMENTUM EXIT vel:${me.trend.velocity}%/cycle`, { mint: mint.slice(0, 8) });
            await this._sell(mint, me.sellAmount, 'MOMENTUM_EXIT', pd, {
              pendingFirst: true, markSLDone: true,
              webhookTitle: 'Momentum Exit', webhookDesc: `**${sym}** retournement`, webhookColor: 0xff9800 });
          }
        }

        this.positions.updatePrevPrice(mint, price);
        const score = this.scorer.score(pd);

        if (price > 0 && bal > 0) {
          const sym = pd?.symbol || mint.slice(0, 8);
          if (CFG.PYRAMID_ENABLED) {
            for (const hit of this.positions.checkPyramid(mint, price)) {
              log('info', `PYRAMID T${hit.idx+1} +${hit.currentPnl}%`, { mint: mint.slice(0,8) });
              await this._autoBuy(mint, hit.addSol, `PYRAMID_T${hit.idx+1}`, pd, {
                onSuccess: (res, tok) => this.positions.markPyramidDone(mint, hit.idx, tok, hit.addSol),
                webhookTitle: `Pyramid T${hit.idx+1}`, webhookDesc: `+${hit.currentPnl}% sur **${sym}**`,
                webhookColor: 0x00bfff, webhookFields: [{ name: 'Ajout', value: hit.addSol.toFixed(4)+' SOL', inline: true }] });
            }
            this.positions.resetPyramidIfNeeded(mint, pnl);
          }
          if (CFG.DCAD_ENABLED) {
            for (const hit of this.positions.checkDCADown(mint, price, this.momentum)) {
              log('info', `DCA-DOWN T${hit.idx+1} ${hit.currentPnl}%`, { mint: mint.slice(0,8) });
              await this._autoBuy(mint, hit.addSol, `DCAD_T${hit.idx+1}`, pd, {
                onSuccess: (res, tok) => this.positions.markDCADownDone(mint, hit.idx, tok, hit.addSol),
                webhookTitle: `DCA-Down T${hit.idx+1}`, webhookDesc: `${hit.currentPnl}% sur **${sym}**`,
                webhookColor: 0xff9800, webhookFields: [{ name: 'Ajout', value: hit.addSol.toFixed(4)+' SOL', inline: true }] });
            }
          }
        }

        tokens.push({
          mint:             mint.slice(0,8)+'...'+mint.slice(-4),
          mintFull:         mint,
          balance:          parseFloat(bal.toFixed(6)),
          price:            price > 0 ? price : null,
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

      // SOL entry
      try {
        const solBal = await this.swap.getSolBalance();
        if (solBal !== null && solBal > 0) {
          await prefetchPrices([SOL_MINT]);
          const solPd    = getPrice(SOL_MINT);
          const solPrice = solPd?.price || null;
          tokens.push({
            mint: SOL_MINT.slice(0,8)+'...'+SOL_MINT.slice(-4), mintFull: SOL_MINT,
            balance: parseFloat(solBal.toFixed(6)), price: solPrice,
            value: solPrice ? parseFloat((solBal * solPrice).toFixed(4)) : null,
            symbol: 'SOL', name: 'Solana', isSol: true,
            logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
            pnl: null, entryPrice: null, bootstrapped: false,
          });
        }
      } catch (err) { log('warn', 'SOL entry failed', { err: err.message }); }

      // USDC entry
      try {
        const usdcBal = await this.swap.getUsdcBalance();
        if (usdcBal !== null && usdcBal > 0.01) {
          tokens.push({
            mint: USDC_MINT.slice(0,8)+'...'+USDC_MINT.slice(-4), mintFull: USDC_MINT,
            balance: parseFloat(usdcBal.toFixed(4)), price: 1.0, value: parseFloat(usdcBal.toFixed(4)),
            symbol: 'USDC', name: 'USD Coin', isUsdc: true,
            logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
            pnl: null, entryPrice: null, bootstrapped: false,
          });
        }
      } catch (err) { log('warn', 'USDC entry failed', { err: err.message }); }

      this.portfolio = tokens.sort((a, b) => (b.value || 0) - (a.value || 0));
      const tv = tokens.reduce((s, t) => s + (t.value || 0), 0);

      // Re-entry
      if (CFG.REENTRY_ENABLED) {
        const portfolioMints = new Set(tokens.map(t => t.mintFull));
        for (const mint of Array.from(this.positions.slHit)) {
          if (portfolioMints.has(mint)) continue;
          await prefetchPrices([mint]);
          const pd    = getPrice(mint);
          const price = pd?.price || 0;
          if (!(price > 0)) continue;
          const score   = this.scorer.score(pd);
          const reentry = this.positions.checkReentry(mint, price, score);
          if (!reentry) continue;
          log('info', `RE-ENTRY rebond +${reentry.reboundPct}% score:${score}`, { mint: mint.slice(0,8) });
          this.positions.clearForReentry(mint);
          const ok = await this._autoBuy(mint, reentry.solAmount, 'REENTRY', pd, {
            webhookTitle: 'Re-Entry automatique',
            webhookDesc:  `Rebond +${reentry.reboundPct}% | Score: ${score}/100`,
            webhookColor: 0x7b68ee });
          if (!ok) this.positions.slHit.add(mint);
          else await sleep(3000);
        }
      }

      log('debug', 'Cycle done', { tokens: tokens.length, total: `$${tv.toFixed(2)}`, cycle: this.cycle });

      if (this.cycle % 10 === 0) {
        const solPrice = getPrice(SOL_MINT)?.price || 0;
        this.valueHistory.push({ ts: Date.now(), valueSol: +tv.toFixed(4), solPriceUsd: +solPrice.toFixed(2) });
        if (this.valueHistory.length > CFG.HISTORY_MAX_POINTS) this.valueHistory.shift();
      }

      if (this.cycle === 1 || this.cycle % 20 === 0) {
        const bootedCount = [...this.positions.entries.values()].filter(e => e.bootstrapped).length;
        if (bootedCount > 0) this.autoScanBootstrapped().catch(err => log('warn', 'autoScanBootstrapped error', { err: err.message }));
      }
      if (this.cycle % 10 === 0) this.persist();

    } catch (err) {
      // [P5] Pas de backoff 300s — simple failover + sleep 5s
      const isNetwork = err.message?.includes('fetch failed') || err.message?.includes('ENOTFOUND') || err.message?.includes('ETIMEDOUT');
      log(isNetwork ? 'warn' : 'error', 'Tick error', { err: err.message });
      this.rpc.failover();
      if (isNetwork) await sleep(5000);
    }
  }

  async _heliusFindEntryPrice(mint, walletStr) {
    if (!CFG.HELIUS_KEY) return null;
    const base = `https://api.helius.xyz/v0/addresses/${walletStr}/transactions?api-key=${CFG.HELIUS_KEY}&limit=100`;
    let before = null;
    for (let page = 0; page < 5; page++) {
      const url = base + (before ? `&before=${before}` : '');
      let txs;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
        if (!r.ok) break;
        txs = await r.json();
        if (!Array.isArray(txs) || !txs.length) break;
      } catch { break; }
      for (const tx of txs) {
        const recv = (tx.tokenTransfers || []).find(
          t => t.mint === mint && t.toUserAccount === walletStr && parseFloat(t.tokenAmount) > 0);
        if (!recv) continue;
        const solOut = (tx.nativeTransfers || [])
          .filter(n => n.fromUserAccount === walletStr)
          .reduce((s, n) => s + (n.amount || 0), 0) / 1e9;
        const tokReceived = parseFloat(recv.tokenAmount);
        if (solOut > 0 && tokReceived > 0)
          return { entryPrice: solOut / tokReceived, solSpent: solOut, tokReceived, ts: (tx.timestamp || 0) * 1000 };
      }
      before = txs[txs.length - 1]?.signature;
      if (!before) break;
      await sleep(200);
    }
    return null;
  }

  async autoScanBootstrapped() {
    const walletStr = this.wallet.publicKey.toString();
    const booted = [...this.positions.entries.entries()]
      .filter(([, e]) => e.bootstrapped).map(([m]) => m);
    if (!booted.length) return;

    // [P3] Sans Helius : forçage immédiat prix courant
    if (!CFG.HELIUS_KEY) {
      log('warn', `${booted.length} positions bootstrappées — forçage prix courant (sans Helius)`);
      let forced = 0;
      for (const mint of booted) {
        const currentPrice = getPrice(mint)?.price || 0;
        if (currentPrice > 0) {
          this.positions.setEntryPrice(mint, currentPrice);
          log('info', `Bootstrap forcé (sans Helius) ${mint.slice(0,8)} @ ${currentPrice.toPrecision(4)}`);
          forced++;
        }
      }
      if (forced > 0) this.persist();
      return;
    }

    // [P4] Batch 10, priorisé par bootAttempts
    const batch = booted
      .sort((a, b) => (this.positions.entries.get(a)?.bootAttempts || 0)
                    - (this.positions.entries.get(b)?.bootAttempts || 0))
      .slice(0, 10);

    log('info', `Auto-scan Helius — ${batch.length}/${booted.length} bootstrappées`);
    let fixed = 0;

    for (const mint of batch) {
      try {
        const found = await this._heliusFindEntryPrice(mint, walletStr);
        if (found?.entryPrice > 0) {
          this.positions.setEntryPrice(mint, found.entryPrice);
          if (!this.costBasis.has(mint) || !this.costBasis.get(mint)?.solSpent) {
            this.costBasis.set(mint, { solSpent: found.solSpent, tokBought: found.tokReceived, buyTs: found.ts || Date.now() });
          }
          fixed++;
        } else {
          const cb = this.costBasis.get(mint);
          if (cb?.solSpent > 0 && cb?.tokBought > 0) {
            this.positions.setEntryPrice(mint, cb.solSpent / cb.tokBought);
            fixed++;
          } else {
            const e = this.positions.entries.get(mint);
            if (e) e.bootAttempts = (e.bootAttempts || 0) + 1;
            if ((e?.bootAttempts || 0) >= 3) {
              const cur = getPrice(mint)?.price || 0;
              if (cur > 0) { this.positions.setEntryPrice(mint, cur); fixed++; }
            }
          }
        }
        await sleep(300);
      } catch (err) { log('warn', `Bootstrap scan error ${mint.slice(0,8)}: ${err.message}`); }
    }
    if (fixed > 0) { this.persist(); log('info', `Bootstrap: ${fixed}/${batch.length} corrigées`); }
  }

  getStats() {
    const tv   = this.portfolio.reduce((s, t) => s + (t.value || 0), 0);
    const pnls = this.portfolio.filter(t => t.pnl !== null).map(t => t.pnl);
    const avg  = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
    return {
      version: VERSION, uptime: Math.round((Date.now() - this.startTime) / 1000),
      cycles: this.cycle, tokens: this.portfolio.length, totalValue: +tv.toFixed(4),
      pnlStats: {
        avg:      avg !== null ? +avg.toFixed(2) : null,
        best:     pnls.length ? +Math.max(...pnls).toFixed(2) : null,
        worst:    pnls.length ? +Math.min(...pnls).toFixed(2) : null,
        positive: pnls.filter(p => p >= 0).length,
        negative: pnls.filter(p => p  < 0).length,
      },
      negCacheSize: _negCache.size,
      sellCircuitBreaker: this.swap.sellFailures,
      cbTrippedAt:  this.swap._cbTrippedAt ? new Date(this.swap._cbTrippedAt).toISOString() : null,
      cbAutoResetIn: this.swap._cbTrippedAt ? Math.max(0, Math.round((5*60000 - (Date.now() - this.swap._cbTrippedAt)) / 1000)) : null,
      lastUpdate: new Date().toISOString(),
      dailyLoss: {
        enabled: CFG.DAILY_LOSS_ENABLED, limit: CFG.DAILY_LOSS_LIMIT,
        today: this.dailyLoss.date, realizedSol: +this.dailyLoss.realizedSol.toFixed(6),
        paused: this.dailyLoss.paused,
      },
      scannerEnabled: CFG.SCANNER_ENABLED,
      strategy: {
        tp: CFG.TP_ENABLED ? `${CFG.TP_TIERS.length} paliers` : 'OFF',
        sl: CFG.SL_ENABLED ? `${CFG.SL_PCT}%` : 'OFF',
        breakEven: CFG.BE_ENABLED ? `+${CFG.BE_BUFFER}%` : 'OFF',
        trailing: CFG.TS_ENABLED ? `${CFG.TS_PCT}%` : 'OFF',
        antiRug: CFG.AR_ENABLED ? `>${CFG.AR_PCT}%` : 'OFF',
        liqExit: CFG.LE_ENABLED ? `>${CFG.LE_PCT}%` : 'OFF',
        jito: CFG.JITO_ENABLED ? `${CFG.JITO_TIP_SOL} SOL` : 'OFF',
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §14  TOKEN SCANNER
// ─────────────────────────────────────────────────────────────────────────────

class TokenScanner {
  constructor(bot) {
    this.bot        = bot;
    this.seen       = new Set();
    this._recentWs  = new Map(); // [P14b] dedup WS events: mint → ts
    this.pending    = new Set();
    this.cooldowns  = new Map();
    this.queue      = [];
    this.ws         = null;
    this.wsId       = 0;
    this.running    = false;
    this.reconnects = 0;
    this.lastPollTs = 0;
    this.stats      = { detected: 0, evaluated: 0, bought: 0, rejected: 0, errors: 0 };
  }

  start() { this.running = true; log('info', 'TokenScanner démarré (WS + polling DexScreener)'); this._connectWs(); this._loop(); }
  stop()  { this.running = false; if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; } }

  _wsUrl() {
    return CFG.HELIUS_KEY
      ? `wss://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_KEY}`
      : 'wss://api.mainnet-beta.solana.com';
  }

  _connectWs() {
    if (!this.running) return;
    // Fermer l'ancienne connexion avant d'en créer une nouvelle
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }
    log('info', `Scanner WS connexion (tentative ${this.reconnects + 1})`);
    let WebSocket;
    try { WebSocket = require('ws'); }
    catch { log('warn', 'Module ws absent — scanner WebSocket désactivé'); return; }
    try { this.ws = new WebSocket(this._wsUrl()); }
    catch (e) { log('warn', `Scanner WS init error: ${e.message}`); this._scheduleWsReconnect(); return; }

    this.ws.on('open', () => {
      log('success', 'Scanner WS connecté'); this.reconnects = 0;
      for (const programId of CFG.SCANNER_PROGRAMS) {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++this.wsId,
          method: 'logsSubscribe',
          params: [{ mentions: [programId] }, { commitment: 'confirmed' }],
        }));
      }
    });
    this.ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'logsNotification') this._handleLogs(msg.params?.result?.value);
      } catch {}
    });
    this.ws.on('error', e => log('warn', `Scanner WS error: ${e.message}`));
    this.ws.on('close', () => { log('warn', 'Scanner WS fermé — reconnexion...'); this._scheduleWsReconnect(); });
  }

  _scheduleWsReconnect() {
    if (!this.running) return;
    this.reconnects++;
    if (this.reconnects >= 3) { log('warn', `Scanner WS abandonné — polling actif`); return; }
    setTimeout(() => this._connectWs(), Math.min(10000 * this.reconnects, 60000));
  }

  _isValidMint(addr) {
    if (!addr || addr.length < 32 || addr.length > 44) return false;
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) return false;
    if (/(.)\1{4,}/.test(addr)) return false;
    const charCounts = {};
    for (const c of addr) charCounts[c] = (charCounts[c] || 0) + 1;
    if (Math.max(...Object.values(charCounts)) / addr.length > 0.5) return false;
    const SYSTEM = new Set([SOL_MINT, USDC_MINT, SPL_TOKEN, SPL_2022,
      '11111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
      'ComputeBudget111111111111111111111111111111',
      'Sysvar1nstructions1111111111111111111111111',
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo v1
      'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',  // Memo v2
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',  // Metaplex
      'TokenRouterProgram111111111111111111111111111',
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Whirlpool
      'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',  // Serum
      ...CFG.SCANNER_PROGRAMS]);
    return !SYSTEM.has(addr);
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
      const matches = l.match(/[1-9A-HJ-NP-Za-km-z]{43,44}/g) || [];
      for (const m of matches) if (this._isValidMint(m)) mintCandidates.add(m);
    }
    const reason = isRaydiumInit ? 'RAYDIUM_NEW' : isPumpGrad ? 'PUMP_GRAD' : 'PUMP_NEW';
    for (const mint of mintCandidates) this._enqueue(mint, reason);
  }

  async _pollDexScreener() {
    try {
      const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const items = await r.json();
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const mint = item?.tokenAddress;
        if (!mint || item?.chainId !== 'solana') continue;
        if (this._isValidMint(mint)) this._enqueue(mint, 'DEX_LATEST');
      }
    } catch (err) { log('debug', `Scanner poll error: ${err.message}`); }
  }

  async _loop() {
    while (this.running) {
      await sleep(3000);
      const pollMs = (CFG.SCANNER_POLL_SEC || 30) * 1000;
      if (Date.now() - this.lastPollTs >= pollMs) {
        this.lastPollTs = Date.now();
        await this._pollDexScreener().catch(() => {});
      }
      const now   = Date.now();
      const ready = this.queue.filter(e => e.ts <= now);
      this.queue  = this.queue.filter(e => e.ts > now);
      // [P14a] Précharger tous les prix en une seule requête DexScreener batch
      if (ready.length > 0) {
        await prefetchPrices(ready.map(e => e.mint)).catch(() => {});
      }
      for (const entry of ready) {
        try { await this._evaluate(entry.mint, entry.reason); }
        catch (err) { this.stats.errors++; log('warn', `Scanner eval error: ${err.message}`); }
        await sleep(200);
      }
    }
  }

  _enqueue(mint, reason) {
    if (!this._isValidMint(mint)) return;
    if (this.seen.has(mint) || this.pending.has(mint) || _negCache.has(mint)) return;
    if (Date.now() - (this.cooldowns.get(mint) || 0) < CFG.SCANNER_COOLDOWN_MS) return;
    // [P14b] Dedup WS: même mint depuis 2 programmes différents dans la même fenêtre 2s
    const rwTs = this._recentWs.get(mint) || 0;
    if (Date.now() - rwTs < 2000) return;
    this._recentWs.set(mint, Date.now());
    if (this._recentWs.size > 500) { // nettoyage mémoire
      const old = Date.now() - 10_000;
      for (const [m, t] of this._recentWs) if (t < old) this._recentWs.delete(m);
    }
    this.seen.add(mint); this.pending.add(mint); this.stats.detected++;
    log('info', `Scanner détecté: ${mint.slice(0, 8)}... (${reason})`);
    // [P6] délai 45s pour indexation DexScreener
    this.queue.push({ mint, reason, ts: Date.now() + CFG.SCANNER_DELAY_MS });
  }

  async _evaluate(mint, reason) {
    this.cooldowns.set(mint, Date.now());
    this.pending.delete(mint);

    const already = this.bot.portfolio.find(t => t.mintFull === mint);
    if (already) { this.stats.rejected++; return; }

    const openPositions = this.bot.portfolio.filter(t =>
      !t.isSol && !t.isUsdc && t.balance > 0 && t.price > 0 && (t.value || 0) >= 2.0 && !t.bootstrapped).length;
    if (openPositions >= CFG.MAX_POSITIONS) { this.stats.rejected++; return; }

    if (this.bot.isDailyLossPaused()) { this.stats.rejected++; return; }

    // Prix déjà préchargé en batch dans _loop (P14a) — refetch seulement si absent
    let pd = getPrice(mint);
    if (!pd) await prefetchPrices([mint]).catch(() => {});
    pd = getPrice(mint);

    // [P7b] Si DexScreener n'a pas encore indexé le token (pd null ou liq=0),
    // essayer PumpFun directement — disponible dès le bloc 0
    if (!pd || !pd.price || pd.price <= 0 || (pd.liquidity || 0) === 0) {
      const pf = await _fetchPumpFun(mint);
      if (pf?.price > 0) {
        priceCache.set(mint, { data: pf, ts: Date.now() });
        pd = pf;
        log('debug', `Scanner PumpFun direct — liq $${(pf.liquidity||0).toFixed(0)}`, { mint: mint.slice(0,8) });
      }
    }

    if (!pd || !pd.price || pd.price <= 0) { this.stats.rejected++; return; }

    let liq = pd.liquidity || 0;

    if (liq < CFG.SCANNER_MIN_LIQ || liq > CFG.SCANNER_MAX_LIQ) {
      log('debug', `Scanner reject — liq $${liq.toFixed(0)} hors plage [$${CFG.SCANNER_MIN_LIQ}-$${CFG.SCANNER_MAX_LIQ}]`);
      this.stats.rejected++; return;
    }

    const score = this.bot.scorer.score(pd);
    this.stats.evaluated++;

    if (score < CFG.SCANNER_MIN_SCORE) {
      log('debug', `Scanner reject — score ${score} < ${CFG.SCANNER_MIN_SCORE}`, { mint: mint.slice(0,8) });
      this.stats.rejected++; return;
    }

    const solAmount = this.bot.calcSmartSize(score) || CFG.SCANNER_SOL_AMOUNT;
    log('info', `Scanner BUY — score:${score} liq:$${liq.toFixed(0)} sol:${solAmount}`, { mint: mint.slice(0,8), reason });

    const ok = await this.bot._autoBuy(mint, solAmount, `SCANNER_${reason}`, pd, {
      webhookTitle:  'Scanner — Nouveau token',
      webhookDesc:   `**${pd.symbol || mint.slice(0,8)}** | Score: **${score}/100** | Liq: $${liq.toFixed(0)}`,
      webhookColor:  0x00d9ff,
      webhookFields: [
        { name: 'Raison',    value: reason,               inline: true },
        { name: 'SOL',       value: solAmount.toFixed(4), inline: true },
        { name: 'Score',     value: `${score}/100`,       inline: true },
        { name: 'Liquidité', value: `$${liq.toFixed(0)}`, inline: true },
      ],
    });
    if (ok) { this.stats.bought++; log('success', `Scanner acheté ${pd.symbol || mint.slice(0,8)} (${score}/100)`); }
    else {
      // Si échec réseau (pas solde insuffisant), re-queuer dans 30s pour retenter
      const lastErr = this.bot.swap._lastBuyErr || '';
      const isNetwork = lastErr.includes('ENOTFOUND') || lastErr.includes('fetch failed') || lastErr.includes('ETIMEDOUT');
      if (isNetwork) {
        this.seen.delete(mint);
        this.cooldowns.delete(mint);
        this.queue.push({ mint, reason, ts: Date.now() + 30_000 });
        log('warn', `Scanner buy réseau raté — requeue dans 30s`, { mint: mint.slice(0,8) });
      }
      this.stats.errors++;
    }
  }

  getStatus() {
    return {
      running: this.running, wsConnected: this.ws?.readyState === 1,
      pollIntervalS: CFG.SCANNER_POLL_SEC || 30, enabled: CFG.SCANNER_ENABLED,
      minScore: CFG.SCANNER_MIN_SCORE, minLiq: CFG.SCANNER_MIN_LIQ,
      maxLiq: CFG.SCANNER_MAX_LIQ, solAmount: CFG.SCANNER_SOL_AMOUNT,
      delayMs: CFG.SCANNER_DELAY_MS,
      queueLength: this.queue.length, pendingCount: this.pending.size,
      seenCount: this.seen.size, stats: this.stats,
    };
  }
}

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

  const num = (v, min, max) => { const n = parseFloat(v); return !isNaN(n) && n >= min && n <= max ? n : null; };

  app.get('/health', (_, res) => res.json({ status: 'ok', version: VERSION, uptime: process.uptime() }));

  app.get('/api/debug/prices', (_, res) => {
    const rows = [];
    const allMints = new Set([...priceCache.keys(), ..._failCount.keys(), ...bot.portfolio.map(t => t.mintFull)]);
    for (const mint of allMints) {
      const c = priceCache.get(mint); const f = _failCount.get(mint) || 0; const nc = _negCache.get(mint);
      rows.push({
        mint: mint.slice(0,8)+'...', symbol: c?.data?.symbol || null,
        price: c?.data?.price || null, liquidity: c?.data?.liquidity || null,
        source: c?.data?.source || null,
        cacheAge: c ? Math.round((Date.now() - c.ts) / 1000) + 's' : null,
        failures: f > 0 ? f : null,
        negUntil: nc ? Math.round((nc.until - Date.now()) / 60_000) + 'min' : null,
        status: nc ? 'neg-cached' : c ? 'live' : 'no-data',
      });
    }
    const live = rows.filter(r => r.status === 'live').length;
    res.json({ summary: { total: rows.length, live, dead: rows.filter(r => r.status === 'neg-cached').length }, tokens: rows.slice(0, 60) });
  });

  app.get('/api/stats',     (_, res) => res.json(bot.getStats()));
  app.get('/api/portfolio', (_, res) => res.json({ address: wallet.publicKey.toString(), tokens: bot.portfolio, timestamp: Date.now() }));
  app.get('/api/wallet',    (_, res) => res.json({ address: wallet.publicKey.toString() }));
  app.get('/api/trades',    (_, res) => res.json({ trades: bot.history }));
  app.get('/api/analytics', (_, res) => res.json(bot.analytics.toApi(bot.history)));
  app.get('/api/sol-balance', async (_, res) => {
    const [sol, usdc] = await Promise.all([bot.swap.getSolBalance(), bot.swap.getUsdcBalance()]);
    res.json({ balance: sol, formatted: sol != null ? sol.toFixed(6) + ' SOL' : null, usdc, sellToUsdc: CFG.SELL_TO_USDC });
  });
  app.get('/api/take-profit', (_, res) => res.json({
    enabled: CFG.TP_ENABLED, tiers: bot.positions.tiers.map((t, i) => ({ index: i+1, pnl: t.pnl, sell: t.sell })),
    hysteresis: CFG.TP_HYSTERESIS, breakEven: { enabled: CFG.BE_ENABLED, buffer: CFG.BE_BUFFER },
    tracked: bot.positions.entries.size, entries: bot.positions.toApiRows(),
  }));

  app.get('/api/config', (_, res) => res.json({
    takeProfitEnabled: CFG.TP_ENABLED, takeProfitTiers: CFG.TP_TIERS, hysteresis: CFG.TP_HYSTERESIS,
    breakEvenEnabled: CFG.BE_ENABLED, breakEvenBuffer: CFG.BE_BUFFER,
    stopLossEnabled: CFG.SL_ENABLED, stopLossPct: CFG.SL_PCT,
    trailingEnabled: CFG.TS_ENABLED, trailingPct: CFG.TS_PCT,
    antiRugEnabled: CFG.AR_ENABLED, antiRugPct: CFG.AR_PCT,
    liqExitEnabled: CFG.LE_ENABLED, liqExitPct: CFG.LE_PCT,
    timeStopEnabled: CFG.TT_ENABLED, timeStopHours: CFG.TT_HOURS,
    momentumEnabled: CFG.ME_ENABLED, momentumThreshold: CFG.ME_THRESHOLD,
    jitoEnabled: CFG.JITO_ENABLED, jitoTipSol: CFG.JITO_TIP_SOL,
    maxPositions: CFG.MAX_POSITIONS, defaultSlippage: CFG.DEFAULT_SLIPPAGE,
    minSolReserve: CFG.MIN_SOL_RESERVE, intervalSec: CFG.INTERVAL_SEC,
    pyramidEnabled: CFG.PYRAMID_ENABLED, pyramidTiers: CFG.PYRAMID_TIERS, pyramidMaxSol: CFG.PYRAMID_MAX_SOL,
    dcadEnabled: CFG.DCAD_ENABLED, dcadTiers: CFG.DCAD_TIERS, dcadMaxAdds: CFG.DCAD_MAX_ADDS,
    reentryEnabled: CFG.REENTRY_ENABLED, reentryDelayMin: CFG.REENTRY_DELAY_MIN,
    smartSizeEnabled: CFG.SMART_SIZE_ENABLED, smartSizeBase: CFG.SMART_SIZE_BASE,
    sellToUsdc: CFG.SELL_TO_USDC,
    scannerEnabled: CFG.SCANNER_ENABLED, scannerMinScore: CFG.SCANNER_MIN_SCORE,
    scannerMinLiq: CFG.SCANNER_MIN_LIQ, scannerMaxLiq: CFG.SCANNER_MAX_LIQ,
    scannerSolAmount: CFG.SCANNER_SOL_AMOUNT, scannerDelayMs: CFG.SCANNER_DELAY_MS,
    dailyLossEnabled: CFG.DAILY_LOSS_ENABLED, dailyLossLimit: CFG.DAILY_LOSS_LIMIT,
  }));

  app.post('/api/config', (req, res) => {
    const b = req.body;
    const applyNum = (key, min, max, setter) => { const n = num(b[key], min, max); if (n !== null) setter(n); };
    if (b.takeProfitEnabled !== undefined)  CFG.TP_ENABLED = !!b.takeProfitEnabled;
    if (b.breakEvenEnabled  !== undefined)  CFG.BE_ENABLED = !!b.breakEvenEnabled;
    if (b.stopLossEnabled   !== undefined)  CFG.SL_ENABLED = !!b.stopLossEnabled;
    if (b.trailingEnabled   !== undefined)  CFG.TS_ENABLED = !!b.trailingEnabled;
    if (b.antiRugEnabled    !== undefined)  CFG.AR_ENABLED = !!b.antiRugEnabled;
    if (b.liqExitEnabled    !== undefined)  CFG.LE_ENABLED = !!b.liqExitEnabled;
    if (b.timeStopEnabled   !== undefined)  CFG.TT_ENABLED = !!b.timeStopEnabled;
    if (b.momentumEnabled   !== undefined)  CFG.ME_ENABLED = !!b.momentumEnabled;
    if (b.jitoEnabled       !== undefined)  CFG.JITO_ENABLED = !!b.jitoEnabled;
    if (b.pyramidEnabled    !== undefined)  CFG.PYRAMID_ENABLED = !!b.pyramidEnabled;
    if (b.dcadEnabled       !== undefined)  CFG.DCAD_ENABLED = !!b.dcadEnabled;
    if (b.reentryEnabled    !== undefined)  CFG.REENTRY_ENABLED = !!b.reentryEnabled;
    if (b.smartSizeEnabled  !== undefined)  CFG.SMART_SIZE_ENABLED = !!b.smartSizeEnabled;
    if (b.sellToUsdc        !== undefined)  CFG.SELL_TO_USDC = !!b.sellToUsdc;
    if (b.scannerEnabled    !== undefined)  CFG.SCANNER_ENABLED = !!b.scannerEnabled;
    if (b.dailyLossEnabled  !== undefined)  CFG.DAILY_LOSS_ENABLED = !!b.dailyLossEnabled;
    if (Array.isArray(b.takeProfitTiers) && b.takeProfitTiers.length) {
      const clean = b.takeProfitTiers.map(t => ({ pnl: parseFloat(t.pnl), sell: parseFloat(t.sell) }))
        .filter(t => t.pnl > 0 && t.sell > 0 && t.sell <= 100).sort((a, c) => a.pnl - c.pnl);
      if (clean.length) { CFG.TP_TIERS = clean; bot.positions.tiers = clean; }
    }
    applyNum('stopLossPct',     -100, 0,     n => CFG.SL_PCT         = n);
    applyNum('breakEvenBuffer',  -5,  20,    n => CFG.BE_BUFFER      = n);
    applyNum('trailingPct',       1,  100,   n => CFG.TS_PCT         = n);
    applyNum('antiRugPct',        1,  100,   n => CFG.AR_PCT         = n);
    applyNum('liqExitPct',        1,  100,   n => CFG.LE_PCT         = n);
    applyNum('hysteresis',        0,  50,    n => CFG.TP_HYSTERESIS  = n);
    applyNum('timeStopHours',     1,  720,   n => CFG.TT_HOURS       = n);
    applyNum('momentumThreshold',-100,0,     n => CFG.ME_THRESHOLD   = n);
    applyNum('jitoTipSol',    0.00001,0.01,  n => CFG.JITO_TIP_SOL  = n);
    applyNum('defaultSlippage',  10, 5000,   n => CFG.DEFAULT_SLIPPAGE = n);
    applyNum('minSolReserve',     0,  10,    n => CFG.MIN_SOL_RESERVE  = n);
    applyNum('intervalSec',      10, 3600,   n => CFG.INTERVAL_SEC     = n);
    applyNum('maxPositions',      1,  50,    n => CFG.MAX_POSITIONS    = n);
    applyNum('pyramidMaxSol',  0.001, 100,   n => CFG.PYRAMID_MAX_SOL  = n);
    applyNum('dcadMaxAdds',       1,  10,    n => CFG.DCAD_MAX_ADDS    = n);
    applyNum('reentryDelayMin',   1, 1440,   n => CFG.REENTRY_DELAY_MIN = n);
    applyNum('reentrySol',     0.01,  10,    n => CFG.REENTRY_SOL      = n);
    applyNum('smartSizeBase',  0.001, 10,    n => CFG.SMART_SIZE_BASE  = n);
    applyNum('smartSizeMax',   0.001, 10,    n => CFG.SMART_SIZE_MAX   = n);
    applyNum('scannerMinScore',   0,  100,   n => CFG.SCANNER_MIN_SCORE  = n);
    applyNum('scannerMinLiq',     0,  1e7,   n => CFG.SCANNER_MIN_LIQ    = n);
    applyNum('scannerMaxLiq',     0,  1e8,   n => CFG.SCANNER_MAX_LIQ    = n);
    applyNum('scannerSolAmount', 0.001,10,   n => CFG.SCANNER_SOL_AMOUNT  = n);
    applyNum('dailyLossLimit',  -100,  0,    n => CFG.DAILY_LOSS_LIMIT    = n);
    if (scanner && b.scannerEnabled === true  && !scanner.running) scanner.start();
    if (scanner && b.scannerEnabled === false && scanner.running)  scanner.stop();
    log('info', 'Config mise à jour');
    res.json({ success: true });
  });

  app.post('/api/quote', async (req, res) => {
    const { inputMint, outputMint, amount, slippageBps = CFG.DEFAULT_SLIPPAGE } = req.body;
    if (!inputMint || !outputMint || !amount) return res.status(400).json({ error: 'inputMint, outputMint, amount requis' });
    try {
      const q = await bot.swap.getQuote({ inputMint, outputMint, amountRaw: BigInt(Math.floor(Number(amount))), slippageBps: parseInt(slippageBps) });
      res.json({ success: true, quote: q });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.get('/api/score/:mint', async (req, res) => {
    await prefetchPrices([req.params.mint]);
    const pd = getPrice(req.params.mint);
    if (!pd) return res.status(404).json({ error: 'Token introuvable' });
    res.json({ mint: req.params.mint, score: bot.scorer.score(pd), trend: bot.momentum.getTrend(req.params.mint), data: pd });
  });

  app.post('/api/buy', async (req, res) => {
    const { mint, solAmount, slippageBps = CFG.DEFAULT_SLIPPAGE, ignoreScore = false } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    if (bot.portfolio.length >= CFG.MAX_POSITIONS) return res.status(400).json({ error: `Max positions atteint` });
    const sol = parseFloat(solAmount);
    if (isNaN(sol) || sol <= 0 || sol > 100) return res.status(400).json({ error: 'solAmount invalide' });
    await prefetchPrices([mint]);
    const pd = getPrice(mint); const score = bot.scorer.score(pd);
    if (!ignoreScore && CFG.MIN_SCORE > 0 && score < CFG.MIN_SCORE)
      return res.status(400).json({ error: `Score trop faible: ${score}/${CFG.MIN_SCORE}` });
    try {
      const result = await bot.swap.buy(mint, sol, parseInt(slippageBps) || CFG.DEFAULT_SLIPPAGE);
      if (result.success) {
        const solUsd = getPrice(SOL_MINT)?.price || 0;
        const ep = pd?.price > 0 ? pd.price
          : (result.outAmount > 0 && solUsd > 0 ? (sol / result.outAmount) * solUsd
          : (result.outAmount > 0 ? sol / result.outAmount : 0));
        bot.positions.trackEntry(mint, ep, result.outAmount, ep);
        bot.recordBuy(mint, sol, result.outAmount || 0);
        bot.recordTrade({ type: 'buy', mint, symbol: pd?.symbol || mint.slice(0,8),
          solSpent: sol, outAmount: result.outAmount, entryPrice: ep, txId: result.sig, txUrl: result.txUrl });
        bot.persist();
        setTimeout(() => bot.tick().catch(() => {}), 4000);
      }
      res.json(result);
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/buy/dca', async (req, res) => {
    const { mint, totalSol, chunks = 3, intervalSec = 60, slippageBps = CFG.DEFAULT_SLIPPAGE } = req.body;
    if (!mint || !totalSol) return res.status(400).json({ error: 'mint et totalSol requis' });
    try {
      const result = await bot.swap.buyDCA(mint, parseFloat(totalSol), Math.min(parseInt(chunks)||3, 10),
        parseInt(intervalSec)||60, parseInt(slippageBps)||CFG.DEFAULT_SLIPPAGE);
      bot.persist(); setTimeout(() => bot.tick().catch(() => {}), 4000);
      res.json(result);
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/sell', async (req, res) => {
    const { mint, amount, percent, slippageBps = CFG.DEFAULT_SLIPPAGE, reason = 'MANUAL', useJito = false } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    const tok = bot.portfolio.find(t => t.mintFull === mint || t.mintFull?.startsWith(mint.slice(0,8)));
    if (!tok) return res.status(404).json({ error: 'Token non trouvé' });
    let sellAmount = parseFloat(amount) || 0;
    if (percent !== undefined) sellAmount = tok.balance * (parseFloat(percent) / 100);
    if (sellAmount <= 0) return res.status(400).json({ error: 'Montant invalide' });
    sellAmount = Math.min(sellAmount, tok.balance);
    const result = await bot.swap.sell(tok.mintFull, sellAmount, reason, parseInt(slippageBps)||CFG.DEFAULT_SLIPPAGE, !!useJito);
    if (result.success) {
      const { pnlSol, pnlPct } = bot.recordSell(tok.mintFull, result.solOut, sellAmount, tok.symbol);
      bot.recordTrade({ type: 'sell', mint: tok.mintFull, symbol: tok.symbol,
        amount: sellAmount, solOut: result.solOut, reason, txId: result.sig, txUrl: result.txUrl, pnlSol, pnlPct });
      bot.persist(); setTimeout(() => bot.tick().catch(() => {}), 4000);
    }
    res.json({ ...result, sellAmount });
  });

  app.get('/api/positions', (_, res) => {
    const rows = bot.positions.toApiRows().map(row => {
      const cur = bot.portfolio.find(t => t.mintFull === row.mint)?.price || getPrice(row.mint)?.price || 0;
      const pnl = row.entryPrice > 0 && cur > 0 ? ((cur - row.entryPrice) / row.entryPrice) * 100 : null;
      return { ...row, currentPrice: cur, pnl: pnl !== null ? +pnl.toFixed(2) : null };
    });
    res.json({ count: rows.length, bootstrapped: rows.filter(r => r.bootstrapped).length, positions: rows });
  });

  app.post('/api/positions/set-entry', (req, res) => {
    const { mint, entryPrice, balance } = req.body;
    if (!mint || entryPrice === undefined) return res.status(400).json({ error: 'mint et entryPrice requis' });
    const price = parseFloat(entryPrice);
    if (isNaN(price) || price <= 0) return res.status(400).json({ error: 'entryPrice invalide' });
    const tok = bot.portfolio.find(t => t.mintFull === mint);
    const ok  = bot.positions.setEntryPrice(mint, price, balance ? parseFloat(balance) : null);
    if (!ok) {
      if (!tok) return res.status(404).json({ error: 'Token non trouvé' });
      bot.positions.trackEntry(mint, price, tok.balance, price);
    }
    bot.persist();
    res.json({ success: true, mint, entryPrice: price });
  });

  app.post('/api/positions/delete', (req, res) => {
    const { mint } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    if (!bot.positions.entries.has(mint)) return res.status(404).json({ error: 'Position non trouvée' });
    for (const map of [bot.positions.entries, bot.positions.triggered, bot.positions.sold,
                       bot.positions.peak, bot.costBasis]) map.delete(mint);
    bot.positions.slHit.delete(mint); bot.positions.slPending.delete(mint); bot.positions.breakEven.delete(mint);
    bot.persist(); res.json({ success: true, mint });
  });

  app.get('/api/positions/scan-history', async (_, res) => {
    if (!CFG.HELIUS_KEY) return res.status(400).json({ error: 'HELIUS_API_KEY requis' });
    const booted    = [...bot.positions.entries.entries()].filter(([, e]) => e.bootstrapped).map(([m]) => m);
    if (!booted.length) return res.json({ message: 'Aucune position bootstrappée', fixed: 0 });
    const walletStr = wallet.publicKey.toString();
    const results   = [];
    for (const mint of booted) {
      try {
        const found = await bot._heliusFindEntryPrice(mint, walletStr);
        if (found?.entryPrice > 0) {
          bot.positions.setEntryPrice(mint, found.entryPrice);
          if (!bot.costBasis.has(mint)) bot.costBasis.set(mint, { solSpent: found.solSpent, tokBought: found.tokReceived, buyTs: found.ts || Date.now() });
          results.push({ mint: mint.slice(0,8), status: 'fixed', entryPrice: found.entryPrice });
        } else {
          results.push({ mint: mint.slice(0,8), status: 'not_found' });
        }
        await sleep(300);
      } catch (err) { results.push({ mint: mint.slice(0,8), status: 'error', error: err.message }); }
    }
    const fixed = results.filter(r => r.status === 'fixed').length;
    if (fixed > 0) bot.persist();
    res.json({ total: booted.length, fixed, results });
  });

  app.get('/api/dead-tokens', (_, res) => {
    const now  = Date.now();
    const dead = bot.portfolio.filter(tok => {
      const f    = _failCount.get(tok.mintFull) || 0;
      const ageH = (now - (bot.positions.entries.get(tok.mintFull)?.ts || now)) / 3_600_000;
      return (f >= 10 || (tok.value < 0.01 && f >= 3)) && ageH > 12;
    }).map(tok => ({
      mint: tok.mintFull, symbol: tok.symbol || tok.mintFull.slice(0,8),
      value: tok.value, failures: _failCount.get(tok.mintFull) || 0,
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
