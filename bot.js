/**
 * SolBot v2.1 — Production-Grade Solana Trading Bot
 * ✅ Take-Profit multi-paliers + Hysteresis
 * ✅ Stop-Loss fixe + Trailing
 * ✅ Anti-Rug protection
 * ✅ DCA buying
 * ✅ Webhooks Discord/Telegram
 * ✅ Analytics complets
 * ✅ Persistence des positions
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function safeParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  PRIVATE_KEY:    process.env.PRIVATE_KEY,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  PORT:           parseInt(process.env.PORT) || 10000,
  INTERVAL_SEC:   parseInt(process.env.INTERVAL_SEC) || 30,
  NODE_ENV:       process.env.NODE_ENV || 'production',
  DATA_FILE:      process.env.DATA_FILE || './bot_state.json',
  
  TAKE_PROFIT_ENABLED:    process.env.TAKE_PROFIT_ENABLED === 'true',
  TAKE_PROFIT_TIERS:      safeParseJson(process.env.TAKE_PROFIT_TIERS,
    [{ pnl: 20, sell: 25 }, { pnl: 40, sell: 25 }, { pnl: 60, sell: 25 }, { pnl: 100, sell: 25 }]),
  TAKE_PROFIT_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),
  
  STOP_LOSS_ENABLED: process.env.STOP_LOSS_ENABLED === 'true',
  STOP_LOSS_PCT:     parseFloat(process.env.STOP_LOSS_PCT || '-50'),
  
  TRAILING_STOP_ENABLED: process.env.TRAILING_STOP_ENABLED === 'true',
  TRAILING_STOP_PCT:     parseFloat(process.env.TRAILING_STOP_PCT || '20'),
  
  ANTI_RUG_ENABLED: process.env.ANTI_RUG_ENABLED === 'true',
  ANTI_RUG_PCT:     parseFloat(process.env.ANTI_RUG_PCT || '60'),
  
  MIN_SOL_RESERVE:  parseFloat(process.env.MIN_SOL_RESERVE || '0.05'),
  MAX_SELL_RETRIES: parseInt(process.env.MAX_SELL_RETRIES || '3'),
  DEFAULT_SLIPPAGE: parseInt(process.env.DEFAULT_SLIPPAGE || '500'),
  PRICE_TTL_MS:     parseInt(process.env.PRICE_TTL_MS || '40000'),
  BUY_COOLDOWN_MS:  parseInt(process.env.BUY_COOLDOWN_MS || '5000'),
  
  WEBHOOK_URL:      process.env.WEBHOOK_URL || null,
  WEBHOOK_TYPE:     process.env.WEBHOOK_TYPE || 'discord',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,
  
  EXTRA_ORIGINS:    process.env.EXTRA_ORIGINS || '',
  DASHBOARD_URL:    process.env.DASHBOARD_URL || null,
};

if (!CONFIG.PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY non définie'); process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// DÉPENDANCES
// ═══════════════════════════════════════════════════════════════════════════
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58    = require('bs58');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════
const SOL_MINT           = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM      = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const VERSION            = '2.1.0';

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════════════════
const LEVEL_ICONS = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', debug: '🔍', success: '✅' };

function log(level, msg, data = null) {
  const ts       = new Date().toISOString();
  const icon     = LEVEL_ICONS[level] || 'ℹ️ ';
  const safeMsg  = String(msg)
    .replace(/PRIVATE_KEY[=:]\S+/gi, 'PRIVATE_KEY=[REDACTED]')
    .replace(/api-key=[^&\s]+/gi,    'api-key=[REDACTED]');
  const safeData = data ? JSON.stringify(data).slice(0, 400) : '';
  console.log(`${icon} [${ts}] [${level.toUpperCase()}] ${safeMsg} ${safeData}`.trimEnd());
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { retries = 2, baseMs = 600, label = '' } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(i); }
    catch (err) {
      lastErr = err;
      if (i < retries) {
        const wait = baseMs * Math.pow(2, i);
        log('warn', `${label} retry ${i+1}/${retries} dans ${wait}ms`, { error: err.message });
        await sleep(wait);
      }
    }
  }
  throw lastErr;
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
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject }); run();
  });
}

class Mutex {
  constructor() { this._chain = Promise.resolve(); }
  lock() {
    let release;
    const wait = this._chain;
    this._chain = new Promise(r => { release = r; });
    return wait.then(() => release);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════
async function sendWebhook(title, description, color = 0x3b7eff, fields = []) {
  if (!CONFIG.WEBHOOK_URL) return;
  try {
    let body;
    if (CONFIG.WEBHOOK_TYPE === 'discord') {
      body = JSON.stringify({
        embeds: [{ title, description, color, fields,
          footer: { text: `SolBot v${VERSION}` },
          timestamp: new Date().toISOString() }],
      });
    } else if (CONFIG.WEBHOOK_TYPE === 'telegram') {
      const text = `*${title}*\n${description}` + (fields.length
        ? '\n' + fields.map(f => `• ${f.name}: ${f.value}`).join('\n') : '');
      body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' });
    } else {
      body = JSON.stringify({ title, description, fields, ts: Date.now() });
    }
    await fetch(CONFIG.WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    log('warn', 'Webhook échec', { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET
// ═══════════════════════════════════════════════════════════════════════════
function loadWallet() {
  try {
    const secretKey = CONFIG.PRIVATE_KEY.startsWith('[')
      ? Uint8Array.from(JSON.parse(CONFIG.PRIVATE_KEY))
      : bs58.decode(CONFIG.PRIVATE_KEY);
    const kp = Keypair.fromSecretKey(secretKey);
    log('info', 'Wallet chargé', { address: kp.publicKey.toString().slice(0, 8) + '...' });
    return kp;
  } catch (err) {
    log('error', 'Clé invalide', { error: err.message }); process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RPC MANAGER
// ═══════════════════════════════════════════════════════════════════════════
function createRpcManager() {
  const endpoints = [
    CONFIG.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}` : null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.public.blastapi.io',
  ].filter(Boolean);
  
  const conns = endpoints.map(ep => new Connection(ep, { commitment: 'confirmed' }));
  let idx = 0;
  
  return {
    get connection() { return conns[idx]; },
    async healthCheck() {
      for (let i = 0; i < conns.length; i++) {
        try {
          const slot = await conns[i].getSlot();
          if (slot > 0) { idx = i; log('debug', 'RPC OK', { slot, ep: i }); return true; }
        } catch { log('warn', 'RPC down', { ep: endpoints[i].slice(0, 40) }); }
      }
      log('error', 'Tous les RPC sont indisponibles');
      return false;
    },
    failover() {
      idx = (idx + 1) % conns.length;
      log('warn', 'RPC failover', { ep: endpoints[idx].slice(0, 40) });
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTANCE
// ═══════════════════════════════════════════════════════════════════════════
function loadState() {
  try {
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
      log('info', 'État restauré', {
        positions: Object.keys(raw.entryPrices || {}).length,
        trades: (raw.trades || []).length,
      });
      return raw;
    }
  } catch (err) {
    log('warn', 'Lecture état échouée — démarrage propre', { error: err.message });
  }
  return { entryPrices: {}, trades: [], stopLossHit: [], slPending: [] };
}

function saveState(state) {
  try {
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log('warn', 'Sauvegarde échouée', { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIX — Multi-sources
// ═══════════════════════════════════════════════════════════════════════════
const priceCache    = new Map();
const decimalsCache = new Map();

async function getTokenDecimals(mint, connection) {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const dec  = info?.value?.data?.parsed?.info?.decimals;
    if (typeof dec === 'number') { decimalsCache.set(mint, dec); return dec; }
  } catch {}
  const fb = mint.endsWith('pump') ? 6 : 9;
  decimalsCache.set(mint, fb);
  return fb;
}

async function batchDexScreener(mints) {
  if (!mints.length) return {};
  const results = {};
  const chunks  = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  
  for (const chunk of chunks) {
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!r.ok) { await sleep(600); continue; }
      const data  = await r.json();
      const pairs = (data?.pairs || []).filter(p => p.chainId === 'solana');
      
      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        if (!mint || !pair.priceUsd) continue;
        const ex = results[mint];
        if (!ex || (pair.liquidity?.usd || 0) > (ex.liquidity || 0)) {
          results[mint] = {
            price:     parseFloat(pair.priceUsd),
            liquidity: pair.liquidity?.usd    || 0,
            volume24h: pair.volume?.h24        || 0,
            change24h: pair.priceChange?.h24   || 0,
            logo:      pair.info?.imageUrl     || null,
            symbol:    pair.baseToken?.symbol  || null,
            name:      pair.baseToken?.name    || null,
            source:    'dexscreener',
          };
        }
      }
    } catch {}
    if (chunks.length > 1) await sleep(380);
  }
  return results;
}

async function fetchPumpFun(mint) {
  try {
    const r = await fetch(
      `https://frontend-api.pump.fun/coins/${mint}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const c = await r.json();
    if (!c?.usd_market_cap || !c?.total_supply) return null;
    const price = c.usd_market_cap / c.total_supply;
    if (!price || price <= 0) return null;
    return {
      price,
      liquidity: c.virtual_sol_reserves ? c.virtual_sol_reserves / 1e9 * 150 : 0,
      volume24h: 0, change24h: 0,
      logo:   c.image_uri || null,
      symbol: c.symbol    || null,
      name:   c.name      || null,
      source: 'pumpfun',
    };
  } catch { return null; }
}

async function fetchBirdeye(mint) {
  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${mint}`,
      { headers: { 'X-Chain': 'solana' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const price = parseFloat(d?.data?.value ?? 0);
    if (!price || price <= 0) return null;
    return { price, liquidity: 0, volume24h: 0, change24h: 0,
      logo: null, symbol: null, name: null, source: 'birdeye' };
  } catch { return null; }
}

async function prefetchAllPrices(mints) {
  const now     = Date.now();
  const toFetch = mints.filter(m => {
    const c = priceCache.get(m);
    return !c || now - c.ts > CONFIG.PRICE_TTL_MS;
  });
  
  if (!toFetch.length) return;
  log('debug', 'Prefetch prix', { total: toFetch.length });
  
  const triedIndividually = new Set();
  const dexData = await batchDexScreener(toFetch);
  log('debug', 'DexScreener batch', { asked: toFetch.length, found: Object.keys(dexData).length });
  
  const missing1 = toFetch.filter(m => !dexData[m]);
  if (missing1.length) {
    const lim = pLimit(5);
    await Promise.all(missing1.map(m => lim(async () => {
      triedIndividually.add(m);
      try {
        const r = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${m}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!r.ok) return;
        const d     = await r.json();
        const pairs = (d?.pairs || []).filter(p => p.chainId === 'solana');
        if (!pairs.length) return;
        const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        if (!best?.priceUsd) return;
        dexData[m] = {
          price:     parseFloat(best.priceUsd),
          liquidity: best.liquidity?.usd    || 0,
          volume24h: best.volume?.h24       || 0,
          change24h: best.priceChange?.h24  || 0,
          logo:      best.info?.imageUrl    || null,
          symbol:    best.baseToken?.symbol || null,
          name:      best.baseToken?.name   || null,
          source:    'dexscreener-ind',
        };
      } catch {}
    })));
  }
  
  const missing2 = toFetch.filter(m => !dexData[m]);
  if (missing2.length) {
    log('debug', 'Pump.fun fallback', { count: missing2.length });
    const lim = pLimit(5);
    await Promise.all(missing2.map(m => lim(async () => {
      const r = await fetchPumpFun(m);
      if (r) dexData[m] = r;
    })));
  }
  
  const missing3 = toFetch.filter(m => !dexData[m]);
  if (missing3.length) {
    log('debug', 'Birdeye fallback', { count: missing3.length });
    const lim = pLimit(4);
    await Promise.all(missing3.map(m => lim(async () => {
      const r = await fetchBirdeye(m);
      if (r) dexData[m] = r;
    })));
  }
  
  for (const mint of toFetch) {
    const d = dexData[mint];
    if (d && d.price > 0) {
      priceCache.set(mint, { data: d, ts: Date.now() });
    }
  }
  
  const found = toFetch.filter(m => (priceCache.get(m)?.data?.price || 0) > 0).length;
  const srcs  = {};
  for (const m of toFetch) {
    const s = priceCache.get(m)?.data?.source;
    if (s) srcs[s] = (srcs[s] || 0) + 1;
  }
  log('debug', 'Prix done', { found, total: toFetch.length, missing: toFetch.length - found, sources: srcs });
}

function getTokenPrice(mint) {
  return priceCache.get(mint)?.data || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION MANAGER
// ═══════════════════════════════════════════════════════════════════════════
class PositionManager {
  constructor(tiers, hysteresis, savedState = {}) {
    this.tiers      = [...tiers].sort((a, b) => a.pnl - b.pnl);
    this.hysteresis = hysteresis;
    this.entryPrices    = new Map(Object.entries(savedState.entryPrices || {}));
    this.triggeredTiers = new Map();
    this.soldAmounts    = new Map();
    this.stopLossHit    = new Set(savedState.stopLossHit  || []);
    this.slPending      = new Set(savedState.slPending    || []);
    this.prevPrices     = new Map();
    this.peakPnl        = new Map();
    
    for (const [mint, data] of this.entryPrices) {
      this.triggeredTiers.set(mint, new Set(data.triggeredTiers || []));
      this.soldAmounts.set(mint, data.soldAmount || 0);
      if (data.peakPnl !== undefined) this.peakPnl.set(mint, data.peakPnl);
    }
    log('info', 'Positions restaurées', { count: this.entryPrices.size });
  }
  
  trackEntry(mint, currentPrice, currentBalance) {
    if (this.entryPrices.has(mint)) return false;
    if (!currentPrice || currentPrice <= 0 || !currentBalance) return false;
    this.entryPrices.set(mint, {
      price: currentPrice, ts: Date.now(),
      originalBalance: currentBalance,
      triggeredTiers: [], soldAmount: 0, peakPnl: 0,
    });
    this.triggeredTiers.set(mint, new Set());
    this.soldAmounts.set(mint, 0);
    this.peakPnl.set(mint, 0);
    log('info', 'Position ouverte', { mint: mint.slice(0,8), entry: currentPrice.toPrecision(6) });
    return true;
  }
  
  getPnl(mint, currentPrice) {
    const entry = this.entryPrices.get(mint);
    if (!entry || !currentPrice || currentPrice <= 0) return null;
    return ((currentPrice - entry.price) / entry.price) * 100;
  }
  
  getRemainingBalance(mint) {
    const entry = this.entryPrices.get(mint);
    if (!entry) return 0;
    return Math.max(0, entry.originalBalance - (this.soldAmounts.get(mint) || 0));
  }
  
  updatePeak(mint, currentPnl) {
    if (currentPnl === null) return;
    const prev = this.peakPnl.get(mint) || 0;
    if (currentPnl > prev) {
      this.peakPnl.set(mint, currentPnl);
      const entry = this.entryPrices.get(mint);
      if (entry) { entry.peakPnl = currentPnl; }
    }
  }
  
  checkTakeProfitTiers(mint, currentPrice) {
    const entry     = this.entryPrices.get(mint);
    const triggered = this.triggeredTiers.get(mint);
    const pnl       = this.getPnl(mint, currentPrice);
    if (!entry || pnl === null || !triggered) return [];
    const toExecute = [];
    for (let i = 0; i < this.tiers.length; i++) {
      if (triggered.has(i)) continue;
      const tier = this.tiers[i];
      if (pnl >= tier.pnl) {
        const remaining  = this.getRemainingBalance(mint);
        const sellAmount = Math.min(entry.originalBalance * (tier.sell / 100), remaining);
        if (sellAmount <= 0) continue;
        toExecute.push({ tierIndex: i, pnlTarget: tier.pnl, currentPnl: pnl.toFixed(2), sellAmount });
      }
    }
    return toExecute;
  }
  
  checkStopLoss(mint, currentPrice) {
    if (!CONFIG.STOP_LOSS_ENABLED) return null;
    if (this.stopLossHit.has(mint) || this.slPending.has(mint)) return null;
    const pnl = this.getPnl(mint, currentPrice);
    if (pnl === null || pnl > CONFIG.STOP_LOSS_PCT) return null;
    const remaining = this.getRemainingBalance(mint);
    if (remaining <= 0) return null;
    return { type: 'stop-loss', pnl: pnl.toFixed(2), sellAmount: remaining };
  }
  
  checkTrailingStop(mint, currentPrice) {
    if (!CONFIG.TRAILING_STOP_ENABLED) return null;
    if (this.stopLossHit.has(mint) || this.slPending.has(mint)) return null;
    const pnl  = this.getPnl(mint, currentPrice);
    const peak = this.peakPnl.get(mint) || 0;
    if (pnl === null || peak < CONFIG.TRAILING_STOP_PCT) return null;
    if (pnl < peak - CONFIG.TRAILING_STOP_PCT) {
      const remaining = this.getRemainingBalance(mint);
      if (remaining <= 0) return null;
      return { type: 'trailing-stop', pnl: pnl.toFixed(2), peak: peak.toFixed(2), sellAmount: remaining };
    }
    return null;
  }
  
  checkAntiRug(mint, currentPrice) {
    if (!CONFIG.ANTI_RUG_ENABLED) return null;
    if (this.stopLossHit.has(mint) || this.slPending.has(mint)) return null;
    const prev = this.prevPrices.get(mint);
    if (!prev || prev <= 0) return null;
    const drop = ((prev - currentPrice) / prev) * 100;
    if (drop >= CONFIG.ANTI_RUG_PCT) {
      const remaining = this.getRemainingBalance(mint);
      if (remaining <= 0) return null;
      return { type: 'anti-rug', drop: drop.toFixed(1), sellAmount: remaining };
    }
    return null;
  }
  
  updatePrevPrice(mint, price) {
    if (price > 0) this.prevPrices.set(mint, price);
  }
  
  markTierExecuted(mint, tierIndex, amountSold) {
    const triggered = this.triggeredTiers.get(mint);
    const entry     = this.entryPrices.get(mint);
    if (!triggered || !entry) return;
    triggered.add(tierIndex);
    const total = (this.soldAmounts.get(mint) || 0) + amountSold;
    this.soldAmounts.set(mint, total);
    entry.triggeredTiers = Array.from(triggered);
    entry.soldAmount     = total;
    log('success', `TP palier ${tierIndex+1} enregistré`, { mint: mint.slice(0,8), sold: amountSold.toFixed(4) });
  }
  
  markStopLossExecuted(mint) {
    this.stopLossHit.add(mint);
    this.slPending.delete(mint);
  }
  
  markStopLossPending(mint) {
    this.slPending.add(mint);
    log('warn', 'SL marqué pending (échec vente)', { mint: mint.slice(0,8) });
  }
  
  clearStopLossPending(mint) {
    this.slPending.delete(mint);
  }
  
  maybeResetTiers(mint, pnl) {
    const triggered = this.triggeredTiers.get(mint);
    const entry     = this.entryPrices.get(mint);
    if (!triggered || !entry) return;
    for (let i = 0; i < this.tiers.length; i++) {
      if (!triggered.has(i)) continue;
      if (pnl < this.tiers[i].pnl - this.hysteresis) {
        triggered.delete(i);
        entry.triggeredTiers = Array.from(triggered);
        log('debug', 'Palier réinitialisé (hystérésis)', { mint: mint.slice(0,8), tier: i+1 });
      }
    }
  }
  
  toSerializable() {
    const out = {};
    for (const [mint, data] of this.entryPrices) {
      out[mint] = {
        price:            data.price,
        ts:               data.ts,
        originalBalance:  data.originalBalance,
        triggeredTiers:   Array.from(this.triggeredTiers.get(mint) || []),
        soldAmount:       this.soldAmounts.get(mint) || 0,
        peakPnl:          this.peakPnl.get(mint) || 0,
      };
    }
    return out;
  }
  
  getStats() {
    const entries = [];
    for (const [mint, data] of this.entryPrices) {
      const triggered = this.triggeredTiers.get(mint) || new Set();
      entries.push({
        mint:            mint.slice(0,8) + '...',
        mintFull:        mint,
        entryPrice:      data.price,
        originalBalance: data.originalBalance,
        sold:            this.soldAmounts.get(mint) || 0,
        remaining:       this.getRemainingBalance(mint),
        triggeredTiers:  Array.from(triggered).map(i => this.tiers[i]?.pnl),
        stopLossHit:     this.stopLossHit.has(mint),
        slPending:       this.slPending.has(mint),
        peakPnl:         this.peakPnl.get(mint) || 0,
      });
    }
    return {
      enabled:    CONFIG.TAKE_PROFIT_ENABLED,
      tiers:      this.tiers.map((t, i) => ({ index: i+1, pnl: t.pnl, sell: t.sell })),
      hysteresis: this.hysteresis,
      stopLoss:   { enabled: CONFIG.STOP_LOSS_ENABLED,    threshold: CONFIG.STOP_LOSS_PCT },
      trailing:   { enabled: CONFIG.TRAILING_STOP_ENABLED, pct: CONFIG.TRAILING_STOP_PCT },
      antiRug:    { enabled: CONFIG.ANTI_RUG_ENABLED,      pct: CONFIG.ANTI_RUG_PCT },
      tracked:    entries.length,
      entries,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SWAP ENGINE
// ═══════════════════════════════════════════════════════════════════════════
class SwapEngine {
  constructor(wallet, rpc) {
    this.wallet       = wallet;
    this.rpc          = rpc;
    this.sellMutex    = new Mutex();
    this.sellFailures = 0;
    this.lastBuyTs    = 0;
  }
  
  async getQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
    const params = `inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`;
    const QUOTE_ENDPOINTS = [
      `https://lite-api.jup.ag/swap/v1/quote?${params}`,
      `https://api.jup.ag/swap/v1/quote?${params}`,
      `https://quote-api.jup.ag/v6/quote?${params}`,
    ];
    let lastErr = null;
    for (const url of QUOTE_ENDPOINTS) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': `SolBot/${VERSION}`, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) { lastErr = new Error(`Quote HTTP ${r.status}`); continue; }
        const q = await r.json();
        if (q.error) { lastErr = new Error(q.error); continue; }
        if (!q.outAmount) { lastErr = new Error(`Aucun devis (${inputMint.slice(0,8)})`); continue; }
        return q;
      } catch (err) {
        lastErr = err;
        log('debug', 'Quote endpoint failed', { url: url.split('/')[2], err: err.message });
      }
    }
    throw lastErr || new Error('Tous les endpoints Jupiter quote ont échoué');
  }
  
  async _executeSwap({ inputMint, outputMint, amountRaw, slippageBps }) {
    return withRetry(async () => {
      const quote = await this.getQuote({ inputMint, outputMint, amountRaw, slippageBps });
      const SWAP_ENDPOINTS = [
        'https://lite-api.jup.ag/swap/v1/swap',
        'https://api.jup.ag/swap/v1/swap',
        'https://quote-api.jup.ag/v6/swap',
      ];
      let swapData = null;
      let swapErr  = null;
      const swapBody = JSON.stringify({
        quoteResponse:             quote,
        userPublicKey:             this.wallet.publicKey.toString(),
        wrapAndUnwrapSol:          true,
        dynamicComputeUnitLimit:   true,
        prioritizationFeeLamports: 'auto',
      });
      for (const swapUrl of SWAP_ENDPOINTS) {
        try {
          const swapRes = await fetch(swapUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': `SolBot/${VERSION}` },
            body:    swapBody,
            signal:  AbortSignal.timeout(30000),
          });
          if (!swapRes.ok) { swapErr = new Error(`Swap HTTP ${swapRes.status}`); continue; }
          swapData = await swapRes.json();
          if (swapData?.swapTransaction) break;
          swapErr  = new Error('swapTransaction manquant');
          swapData = null;
        } catch (err) {
          swapErr = err;
        }
      }
      if (!swapData?.swapTransaction) throw swapErr || new Error('Swap échoué sur tous les endpoints');
      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      const txBlockhash = tx.message.recentBlockhash;
      const lbhMeta = await this.rpc.connection.getLatestBlockhash('confirmed');
      tx.sign([this.wallet]);
      const txId = await this.rpc.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
      });
      const conf = await this.rpc.connection.confirmTransaction({
        signature:            txId,
        blockhash:            txBlockhash,
        lastValidBlockHeight: lbhMeta.lastValidBlockHeight,
      }, 'confirmed');
      if (conf.value.err) throw new Error(`Tx rejetée: ${JSON.stringify(conf.value.err)}`);
      return { txId, txUrl: `https://solscan.io/tx/${txId}`, quote };
    }, { retries: 2, baseMs: 800, label: `swap(${inputMint.slice(0,8)})` });
  }
  
  async buy(mint, solAmount, slippageBps = CONFIG.DEFAULT_SLIPPAGE) {
    const elapsed = Date.now() - this.lastBuyTs;
    if (elapsed < CONFIG.BUY_COOLDOWN_MS) {
      const wait = ((CONFIG.BUY_COOLDOWN_MS - elapsed) / 1000).toFixed(1);
      throw new Error(`Cooldown actif — réessayez dans ${wait}s`);
    }
    const solBal = await this.getSolBalance();
    if (solBal !== null) {
      const needed = solAmount + CONFIG.MIN_SOL_RESERVE;
      if (solBal < needed) {
        throw new Error(`Solde insuffisant: ${solBal.toFixed(4)} SOL (besoin ${needed.toFixed(4)} SOL)`);
      }
    }
    log('info', 'Achat', { mint: mint.slice(0,8), solAmount, slippageBps });
    const amountRaw = BigInt(Math.floor(solAmount * 1e9));
    const { txId, txUrl, quote } = await this._executeSwap(
      { inputMint: SOL_MINT, outputMint: mint, amountRaw, slippageBps });
    const outDec   = await getTokenDecimals(mint, this.rpc.connection);
    const outAmount = Number(quote.outAmount) / Math.pow(10, outDec);
    this.lastBuyTs  = Date.now();
    log('success', 'Achat confirmé', { mint: mint.slice(0,8), out: outAmount.toFixed(4), txId });
    return { success: true, txId, txUrl, outAmount, solSpent: solAmount };
  }
  
  async buyDCA(mint, totalSol, chunks, intervalSec, slippageBps = CONFIG.DEFAULT_SLIPPAGE) {
    const chunkSol = totalSol / chunks;
    const results  = [];
    log('info', 'DCA start', { mint: mint.slice(0,8), totalSol, chunks, intervalSec });
    for (let i = 0; i < chunks; i++) {
      try {
        const r = await this.buy(mint, chunkSol, slippageBps);
        results.push({ chunk: i+1, ...r });
        log('info', `DCA chunk ${i+1}/${chunks}`, { out: r.outAmount?.toFixed(4) });
        if (i < chunks - 1) await sleep(intervalSec * 1000);
      } catch (err) {
        log('warn', `DCA chunk ${i+1} échoué`, { error: err.message });
        results.push({ chunk: i+1, success: false, error: err.message });
      }
    }
    const succeeded = results.filter(r => r.success).length;
    return { results, succeeded, total: chunks };
  }
  
  async sell(mint, amount, reason = 'MANUAL', slippageBps = CONFIG.DEFAULT_SLIPPAGE) {
    if (this.sellFailures >= CONFIG.MAX_SELL_RETRIES) {
      const msg = `Circuit-breaker actif (${this.sellFailures} échecs)`;
      log('error', msg);
      return { success: false, error: msg };
    }
    const release = await this.sellMutex.lock();
    try {
      log('info', 'Vente', { mint: mint.slice(0,8), amount: amount.toFixed(4), reason });
      const outDec    = await getTokenDecimals(mint, this.rpc.connection);
      const amountRaw = BigInt(Math.floor(amount * Math.pow(10, outDec)));
      const { txId, txUrl, quote } = await this._executeSwap(
        { inputMint: mint, outputMint: SOL_MINT, amountRaw, slippageBps });
      const solOut = Number(quote.outAmount) / 1e9;
      this.sellFailures = 0;
      log('success', 'Vente confirmée', { mint: mint.slice(0,8), solOut: solOut.toFixed(6), txId, reason });
      return { success: true, txId, txUrl, solOut, amountSold: amount };
    } catch (err) {
      this.sellFailures++;
      log('error', 'Vente échouée', { error: err.message, failures: this.sellFailures, reason });
      return { success: false, error: err.message };
    } finally {
      release();
    }
  }
  
  async getSolBalance() {
    try {
      return await this.rpc.connection.getBalance(this.wallet.publicKey) / 1e9;
    } catch { return null; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOOP
// ═══════════════════════════════════════════════════════════════════════════
class BotLoop {
  constructor(wallet, rpc, savedState) {
    this.wallet       = wallet;
    this.rpc          = rpc;
    this.portfolio    = [];
    this.startTime    = Date.now();
    this.cycleCount   = 0;
    this.tradeHistory = savedState.trades || [];
    this.positions = new PositionManager(
      CONFIG.TAKE_PROFIT_TIERS,
      CONFIG.TAKE_PROFIT_HYSTERESIS,
      savedState,
    );
    this.swap = new SwapEngine(wallet, rpc);
  }
  
  _persist() {
    saveState({
      entryPrices: this.positions.toSerializable(),
      trades:      this.tradeHistory.slice(0, 500),
      stopLossHit: Array.from(this.positions.stopLossHit),
      slPending:   Array.from(this.positions.slPending),
    });
  }
  
  async tick() {
    try {
      if (this.cycleCount % 10 === 0) await this.rpc.healthCheck();
      this.cycleCount++;
      
      const [acc1, acc2] = await Promise.all([
        this.rpc.connection.getParsedTokenAccountsByOwner(
          this.wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM) }),
        this.rpc.connection.getParsedTokenAccountsByOwner(
          this.wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM_2022) }),
      ]);
      
      const allAccounts = [...acc1.value, ...acc2.value].filter(acc => {
        if (acc.account.data.parsed.info.mint === SOL_MINT) return false;
        const ta  = acc.account.data.parsed.info.tokenAmount;
        const bal = parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0');
        return bal > 0;
      });
      
      const allMints = allAccounts.map(a => a.account.data.parsed.info.mint);
      await prefetchAllPrices(allMints);
      
      const tokens = [];
      for (const acc of allAccounts) {
        const mint = acc.account.data.parsed.info.mint;
        const ta   = acc.account.data.parsed.info.tokenAmount;
        const bal  = parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0');
        if (!bal || bal <= 0) continue;
        
        const priceData = getTokenPrice(mint);
        const price     = priceData?.price || 0;
        const value     = bal * price;
        
        this.positions.trackEntry(mint, price, bal);
        const pnl = this.positions.getPnl(mint, price);
        if (pnl !== null) this.positions.updatePeak(mint, pnl);
        
        if (price > 0) {
          const rugAlert = this.positions.checkAntiRug(mint, price);
          if (rugAlert) {
            log('error', '🚨 ANTI-RUG DÉCLENCHÉ', { mint: mint.slice(0,8), drop: rugAlert.drop + '%' });
            await sendWebhook('🚨 Anti-Rug Alert', `Chute de **${rugAlert.drop}%** détectée`, 0xff4757, [
              { name: 'Token', value: priceData?.symbol || mint.slice(0,8), inline: true },
              { name: 'Chute', value: rugAlert.drop + '%', inline: true },
            ]);
            this.positions.markStopLossPending(mint);
            const res = await this.swap.sell(mint, rugAlert.sellAmount, 'ANTI_RUG');
            if (res.success) {
              this.positions.markStopLossExecuted(mint);
              this.positions.clearStopLossPending(mint);
            }
          }
          
          if (CONFIG.TAKE_PROFIT_ENABLED && pnl !== null) {
            const tiers = this.positions.checkTakeProfitTiers(mint, price);
            for (const tier of tiers) {
              log('warn', `TP palier ${tier.tierIndex+1}`, {
                mint: mint.slice(0,8), pnl: tier.currentPnl + '%', sell: tier.sellAmount.toFixed(4) });
              const res = await this.swap.sell(mint, tier.sellAmount, `TP_T${tier.tierIndex+1}`);
              if (res.success) {
                this.positions.markTierExecuted(mint, tier.tierIndex, tier.sellAmount);
              }
            }
            this.positions.maybeResetTiers(mint, pnl);
          }
          
          const sl = this.positions.checkStopLoss(mint, price);
          if (sl) {
            log('warn', 'STOP-LOSS', { mint: mint.slice(0,8), pnl: sl.pnl + '%' });
            this.positions.markStopLossPending(mint);
            const res = await this.swap.sell(mint, sl.sellAmount, 'STOP_LOSS');
            if (res.success) {
              this.positions.markStopLossExecuted(mint);
              this.positions.clearStopLossPending(mint);
            } else {
              this.positions.clearStopLossPending(mint);
            }
          }
          
          const ts = this.positions.checkTrailingStop(mint, price);
          if (ts) {
            log('warn', 'TRAILING STOP', { mint: mint.slice(0,8), pnl: ts.pnl, peak: ts.peak });
            this.positions.markStopLossPending(mint);
            const res = await this.swap.sell(mint, ts.sellAmount, 'TRAILING_STOP');
            if (res.success) {
              this.positions.markStopLossExecuted(mint);
              this.positions.clearStopLossPending(mint);
            } else {
              this.positions.clearStopLossPending(mint);
            }
          }
        }
        
        this.positions.updatePrevPrice(mint, price);
        
        tokens.push({
          mint:             mint.slice(0, 8) + '...' + mint.slice(-4),
          mintFull:         mint,
          balance:          parseFloat(bal.toFixed(6)),
          price:            price > 0 ? price : null,
          value:            parseFloat(value.toFixed(4)),
          liquidity:        priceData?.liquidity  || 0,
          volume24h:        priceData?.volume24h  || 0,
          change24h:        priceData?.change24h  || 0,
          logo:             priceData?.logo        || null,
          symbol:           priceData?.symbol      || null,
          name:             priceData?.name        || null,
          pnl,
          peakPnl:          this.positions.peakPnl.get(mint) || null,
          entryPrice:       this.positions.entryPrices.get(mint)?.price || null,
          remainingBalance: this.positions.getRemainingBalance(mint),
          triggeredTiers:   Array.from(this.positions.triggeredTiers.get(mint) || [])
                               .map(i => CONFIG.TAKE_PROFIT_TIERS[i]?.pnl),
          stopLossHit:      this.positions.stopLossHit.has(mint),
        });
      }
      
      this.portfolio = tokens.sort((a, b) => b.value - a.value);
      const tv = tokens.reduce((s, t) => s + t.value, 0);
      log('debug', 'Cycle OK', { tokens: tokens.length, total: `$${tv.toFixed(2)}`, cycle: this.cycleCount });
      
      if (this.cycleCount % 10 === 0) this._persist();
      
    } catch (err) {
      log('error', 'Erreur cycle', { error: err.message });
      this.rpc.failover();
    }
  }
  
  getStats() {
    const tv      = this.portfolio.reduce((s, t) => s + t.value, 0);
    const pnlList = this.portfolio.filter(t => t.pnl !== null).map(t => t.pnl);
    const posP    = pnlList.filter(p => p >= 0).length;
    const posN    = pnlList.filter(p => p < 0).length;
    const avgPnl  = pnlList.length ? pnlList.reduce((a, b) => a + b, 0) / pnlList.length : null;
    const best    = pnlList.length ? Math.max(...pnlList) : null;
    const worst   = pnlList.length ? Math.min(...pnlList) : null;
    return {
      version:    VERSION,
      uptime:     Math.round((Date.now() - this.startTime) / 1000),
      cycles:     this.cycleCount,
      tokens:     this.portfolio.length,
      totalValue: parseFloat(tv.toFixed(4)),
      pnlStats:   { avgPnl: avgPnl !== null ? +avgPnl.toFixed(2) : null, best, worst, positive: posP, negative: posN },
      takeProfit: CONFIG.TAKE_PROFIT_ENABLED ? this.positions.getStats() : { enabled: false },
      stopLoss:   { enabled: CONFIG.STOP_LOSS_ENABLED,    threshold: CONFIG.STOP_LOSS_PCT },
      trailing:   { enabled: CONFIG.TRAILING_STOP_ENABLED, pct: CONFIG.TRAILING_STOP_PCT },
      antiRug:    { enabled: CONFIG.ANTI_RUG_ENABLED,      pct: CONFIG.ANTI_RUG_PCT },
      sellCircuitBreaker: this.swap.sellFailures,
      lastUpdate: new Date().toISOString(),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API SERVER
// ═══════════════════════════════════════════════════════════════════════════
function startApi(bot, wallet) {
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  
  const staticDir   = process.env.STATIC_DIR || __dirname;
  const DASHBOARD_URL = CONFIG.DASHBOARD_URL;
  const indexPath   = path.join(staticDir, 'index.html');
  const hasIndex    = fs.existsSync(indexPath);
  
  if (hasIndex) {
    app.use(express.static(staticDir));
    app.get('/', (req, res) => res.sendFile(indexPath));
    log('info', 'Dashboard local activé', { dir: staticDir });
  } else {
    app.get('/', (req, res) => {
      const info = {
        bot:       `SolBot v${VERSION}`,
        status:    'running',
        uptime:    Math.round(process.uptime()) + 's',
        dashboard: DASHBOARD_URL || 'Non configuré',
        api:       ['/health', '/api/stats', '/api/portfolio', '/api/sol-balance', '/api/trades'],
      };
      if (DASHBOARD_URL) {
        res.redirect(302, DASHBOARD_URL);
      } else {
        res.json(info);
      }
    });
    log('info', 'Dashboard local absent', { dashboard: DASHBOARD_URL || 'none' });
  }
  
  app.get('/health',          (req, res) => res.json({ status: 'ok', version: VERSION, uptime: process.uptime() }));
  app.get('/api/stats',       (req, res) => res.json(bot.getStats()));
  app.get('/api/portfolio',   (req, res) => res.json({ address: wallet.publicKey.toString(), tokens: bot.portfolio, timestamp: Date.now() }));
  app.get('/api/wallet',      (req, res) => res.json({ address: wallet.publicKey.toString() }));
  app.get('/api/take-profit', (req, res) => res.json(bot.positions.getStats()));
  app.get('/api/trades',      (req, res) => res.json({ trades: bot.tradeHistory }));
  app.get('/api/sol-balance', async (req, res) => {
    const bal = await bot.swap.getSolBalance();
    res.json({ balance: bal, formatted: bal != null ? bal.toFixed(6) + ' SOL' : null });
  });
  
  app.get('/api/config', (req, res) => res.json({
    takeProfitEnabled:  CONFIG.TAKE_PROFIT_ENABLED,
    takeProfitTiers:    CONFIG.TAKE_PROFIT_TIERS,
    hysteresis:         CONFIG.TAKE_PROFIT_HYSTERESIS,
    stopLossEnabled:    CONFIG.STOP_LOSS_ENABLED,
    stopLossPct:        CONFIG.STOP_LOSS_PCT,
    trailingEnabled:    CONFIG.TRAILING_STOP_ENABLED,
    trailingPct:        CONFIG.TRAILING_STOP_PCT,
    antiRugEnabled:     CONFIG.ANTI_RUG_ENABLED,
    antiRugPct:         CONFIG.ANTI_RUG_PCT,
    defaultSlippage:    CONFIG.DEFAULT_SLIPPAGE,
    minSolReserve:      CONFIG.MIN_SOL_RESERVE,
    intervalSec:        CONFIG.INTERVAL_SEC,
  }));
  
  app.post('/api/config', (req, res) => {
    const { takeProfitEnabled, takeProfitTiers, hysteresis,
      stopLossEnabled, stopLossPct,
      trailingEnabled, trailingPct, antiRugEnabled, antiRugPct,
      defaultSlippage, minSolReserve, intervalSec } = req.body;
    
    if (takeProfitEnabled !== undefined) CONFIG.TAKE_PROFIT_ENABLED   = !!takeProfitEnabled;
    if (stopLossEnabled   !== undefined) CONFIG.STOP_LOSS_ENABLED     = !!stopLossEnabled;
    if (trailingEnabled   !== undefined) CONFIG.TRAILING_STOP_ENABLED = !!trailingEnabled;
    if (antiRugEnabled    !== undefined) CONFIG.ANTI_RUG_ENABLED      = !!antiRugEnabled;
    
    if (Array.isArray(takeProfitTiers) && takeProfitTiers.length > 0) {
      const clean = takeProfitTiers
        .map(t => ({ pnl: parseFloat(t.pnl), sell: parseFloat(t.sell) }))
        .filter(t => !isNaN(t.pnl) && t.pnl > 0 && !isNaN(t.sell) && t.sell > 0 && t.sell <= 100)
        .sort((a, b) => a.pnl - b.pnl);
      if (clean.length > 0) CONFIG.TAKE_PROFIT_TIERS = clean;
    }
    
    const validateNum = (v, min, max) => { const n = parseFloat(v); return !isNaN(n) && n >= min && n <= max ? n : null; };
    const sl  = validateNum(stopLossPct,    -100, 0);    if (sl !== null) CONFIG.STOP_LOSS_PCT           = sl;
    const tr  = validateNum(trailingPct,    1, 100);     if (tr !== null) CONFIG.TRAILING_STOP_PCT       = tr;
    const ar  = validateNum(antiRugPct,     1, 100);     if (ar !== null) CONFIG.ANTI_RUG_PCT            = ar;
    const ds  = validateNum(defaultSlippage,10, 5000);   if (ds !== null) CONFIG.DEFAULT_SLIPPAGE        = ds;
    const mr  = validateNum(minSolReserve,  0, 10);      if (mr !== null) CONFIG.MIN_SOL_RESERVE         = mr;
    const hys = validateNum(hysteresis,     0, 50);      if (hys !== null) CONFIG.TAKE_PROFIT_HYSTERESIS = hys;
    const ivl = validateNum(intervalSec,    10, 3600);   if (ivl !== null) CONFIG.INTERVAL_SEC           = ivl;
    
    log('info', 'Config mise à jour');
    res.json({ success: true });
  });
  
  app.post('/api/buy', async (req, res) => {
    const { mint, solAmount, slippageBps = CONFIG.DEFAULT_SLIPPAGE } = req.body;
    if (!mint || !solAmount) return res.status(400).json({ error: 'mint et solAmount requis' });
    const sol = parseFloat(solAmount);
    if (isNaN(sol) || sol <= 0 || sol > 50) return res.status(400).json({ error: 'solAmount invalide (0-50)' });
    try {
      const result = await bot.swap.buy(mint, sol, parseInt(slippageBps) || CONFIG.DEFAULT_SLIPPAGE);
      if (result.success) {
        bot._persist();
        setTimeout(() => bot.tick().catch(() => {}), 4000);
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });
  
  app.post('/api/sell', async (req, res) => {
    const { mint, amount, percent, slippageBps = CONFIG.DEFAULT_SLIPPAGE, reason = 'MANUAL' } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    const tok = bot.portfolio.find(t => t.mintFull === mint || t.mintFull?.startsWith(mint.slice(0,8)));
    if (!tok) return res.status(404).json({ error: 'Token non trouvé dans le portfolio' });
    
    let sellAmount = amount ? parseFloat(amount) : 0;
    if (percent !== undefined) sellAmount = tok.balance * (parseFloat(percent) / 100);
    if (!sellAmount || sellAmount <= 0) return res.status(400).json({ error: 'Montant invalide' });
    sellAmount = Math.min(sellAmount, tok.balance);
    
    const result = await bot.swap.sell(tok.mintFull, sellAmount, reason,
      parseInt(slippageBps) || CONFIG.DEFAULT_SLIPPAGE);
    
    if (result.success) {
      bot._persist();
      setTimeout(() => bot.tick().catch(() => {}), 4000);
    }
    res.json({ ...result, sellAmount });
  });
  
  app.post('/api/reset-circuit-breaker', (req, res) => {
    bot.swap.sellFailures = 0;
    log('info', 'Circuit-breaker réinitialisé');
    res.json({ success: true });
  });
  
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.listen(CONFIG.PORT, '0.0.0.0', () =>
    log('info', 'API démarrée', { port: CONFIG.PORT, version: VERSION }));
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  log('info', `SolBot v${VERSION} — Démarrage`, { env: CONFIG.NODE_ENV });
  const wallet     = loadWallet();
  const rpc        = createRpcManager();
  const savedState = loadState();
  const bot        = new BotLoop(wallet, rpc, savedState);
  
  log('info', 'Premier cycle...');
  await bot.tick();
  
  setInterval(
    () => bot.tick().catch(err => log('error', 'Loop error', { error: err.message })),
    CONFIG.INTERVAL_SEC * 1000,
  );
  
  startApi(bot, wallet);
  
  log('success', '✅ Bot opérationnel', {
    address:    wallet.publicKey.toString().slice(0, 8) + '...',
    interval:   CONFIG.INTERVAL_SEC + 's',
    tp:         CONFIG.TAKE_PROFIT_ENABLED ? CONFIG.TAKE_PROFIT_TIERS.length + ' paliers' : 'off',
    sl:         CONFIG.STOP_LOSS_ENABLED   ? CONFIG.STOP_LOSS_PCT + '%' : 'off',
    trailing:   CONFIG.TRAILING_STOP_ENABLED ? CONFIG.TRAILING_STOP_PCT + '%' : 'off',
    antiRug:    CONFIG.ANTI_RUG_ENABLED ? CONFIG.ANTI_RUG_PCT + '%' : 'off',
    solReserve: CONFIG.MIN_SOL_RESERVE + ' SOL',
    webhook:    CONFIG.WEBHOOK_URL ? CONFIG.WEBHOOK_TYPE : 'off',
  });
  
  const cleanup = () => { bot._persist(); log('info', 'Arrêt propre'); process.exit(0); };
  process.on('SIGINT',  cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException',  err    => log('error', 'Exception non gérée', { error: err.message }));
  process.on('unhandledRejection', reason => log('error', 'Rejet non géré', { reason: String(reason).slice(0, 300) }));
}

main().catch(err => { console.error('Échec démarrage:', err.message); process.exit(1); });
