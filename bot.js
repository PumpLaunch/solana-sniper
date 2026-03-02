/**
 * SolBot v3.0 — Production-Grade Solana Trading Bot
 *
 * Réécriture complète depuis v2.2.1 :
 *  • Architecture propre en 7 modules distincts
 *  • _executeSellAction() : helper unique éliminant la duplication dans tick()
 *  • Tous les bugs v2.x corrigés (voir historique ci-dessous)
 *  • Meilleure gestion d'erreurs et logging cohérent
 *  • API Express organisée par domaine (config, portfolio, trade, analytics)
 *
 * Historique des correctifs hérités :
 *  [v2.2.1] checkTakeProfitTiers ignorait stopLossHit → circuit-breaker déclenché
 *            par des tentatives de revente post-Anti-Rug. Corrigé : guard uniforme.
 *  [v2.2]   TP/SL/AR désactivés si var env absente (défaut FALSE). Corrigé : défaut TRUE.
 *           Prix d'entrée enregistré trop tard. Corrigé : prix réel swap immédiat.
 *           DCA : prix d'entrée non moyenné. Corrigé : weighted average.
 *  [v2.1]   Retry swap ne refetchait pas le quote (expiration ~60s).
 *           stopLossHit non persisté → double-vente après redémarrage.
 *           Stop-loss ne marquait pas "pending" si vente échoue.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 1. CONFIG
// ═══════════════════════════════════════════════════════════════════════════

function safeJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

const CFG = {
  // Réseau
  PRIVATE_KEY:    process.env.PRIVATE_KEY,
  HELIUS_KEY:     process.env.HELIUS_API_KEY || null,
  PORT:           parseInt(process.env.PORT)          || 10000,
  INTERVAL_SEC:   parseInt(process.env.INTERVAL_SEC)  || 30,
  NODE_ENV:       process.env.NODE_ENV                 || 'production',
  DATA_FILE:      process.env.DATA_FILE                || './bot_state.json',
  DASHBOARD_URL:  process.env.DASHBOARD_URL            || null,

  // Take-profit (défaut ON — opt-out via =false)
  TP_ENABLED:    process.env.TAKE_PROFIT_ENABLED !== 'false',
  TP_TIERS:      safeJson(process.env.TAKE_PROFIT_TIERS,
    [{ pnl: 20, sell: 25 }, { pnl: 40, sell: 25 }, { pnl: 60, sell: 25 }, { pnl: 100, sell: 25 }]),
  TP_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),

  // Stop-loss fixe (défaut ON)
  SL_ENABLED: process.env.STOP_LOSS_ENABLED !== 'false',
  SL_PCT:     parseFloat(process.env.STOP_LOSS_PCT || '-50'),

  // Trailing stop (défaut OFF — opt-in car agressif)
  TS_ENABLED: process.env.TRAILING_STOP_ENABLED === 'true',
  TS_PCT:     parseFloat(process.env.TRAILING_STOP_PCT || '20'),

  // Anti-rug : chute brutale en 1 cycle (défaut ON)
  AR_ENABLED: process.env.ANTI_RUG_ENABLED !== 'false',
  AR_PCT:     parseFloat(process.env.ANTI_RUG_PCT || '60'),

  // Trading
  MIN_SOL_RESERVE:  parseFloat(process.env.MIN_SOL_RESERVE  || '0.05'),
  MAX_SELL_RETRIES: parseInt(process.env.MAX_SELL_RETRIES   || '3'),
  DEFAULT_SLIPPAGE: parseInt(process.env.DEFAULT_SLIPPAGE   || '500'),  // bps
  PRICE_TTL_MS:     parseInt(process.env.PRICE_TTL_MS       || '40000'),
  BUY_COOLDOWN_MS:  parseInt(process.env.BUY_COOLDOWN_MS    || '5000'),

  // Webhook
  WEBHOOK_URL:      process.env.WEBHOOK_URL      || null,
  WEBHOOK_TYPE:     process.env.WEBHOOK_TYPE     || 'discord',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,
};

if (!CFG.PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY manquante'); process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. DÉPENDANCES & CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58    = require('bs58');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const fetch   = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_2022  = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const VERSION   = '3.0.0';

// ═══════════════════════════════════════════════════════════════════════════
// 3. UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════

// ── Logger ────────────────────────────────────────────────────────────────
const ICONS = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', debug: '🔍', success: '✅' };

function log(level, msg, data = null) {
  const safe = String(msg)
    .replace(/PRIVATE_KEY[=:]\S+/gi, 'PRIVATE_KEY=[REDACTED]')
    .replace(/api-key=[^&\s]+/gi,    'api-key=[REDACTED]');
  const suffix = data ? ' ' + JSON.stringify(data).slice(0, 400) : '';
  console.log(`${ICONS[level] || 'ℹ️ '} [${new Date().toISOString()}] ${safe}${suffix}`);
}

// ── Sleep ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Retry exponentiel ─────────────────────────────────────────────────────
async function withRetry(fn, { tries = 3, baseMs = 600, label = '' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); }
    catch (err) {
      last = err;
      if (i < tries - 1) {
        const wait = baseMs * 2 ** i;
        log('warn', `${label} retry ${i+1}/${tries-1} in ${wait}ms`, { err: err.message });
        await sleep(wait);
      }
    }
  }
  throw last;
}

// ── Concurrence limitée ───────────────────────────────────────────────────
function pLimit(n) {
  let active = 0;
  const queue = [];
  const run = () => {
    while (active < n && queue.length) {
      active++;
      const { fn, res, rej } = queue.shift();
      fn().then(res, rej).finally(() => { active--; run(); });
    }
  };
  return fn => new Promise((res, rej) => { queue.push({ fn, res, rej }); run(); });
}

// ── Mutex ─────────────────────────────────────────────────────────────────
class Mutex {
  constructor() { this._q = Promise.resolve(); }
  lock() {
    let release;
    const next = this._q.then(() => release);
    this._q = new Promise(r => { release = r; });
    return next;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════

async function webhook(title, desc, color = 0x3b7eff, fields = []) {
  if (!CFG.WEBHOOK_URL) return;
  try {
    let body;
    if (CFG.WEBHOOK_TYPE === 'discord') {
      body = JSON.stringify({ embeds: [{
        title, description: desc, color, fields,
        footer: { text: `SolBot v${VERSION}` },
        timestamp: new Date().toISOString(),
      }]});
    } else if (CFG.WEBHOOK_TYPE === 'telegram') {
      const text = `*${title}*\n${desc}` +
        (fields.length ? '\n' + fields.map(f => `• ${f.name}: ${f.value}`).join('\n') : '');
      body = JSON.stringify({ chat_id: CFG.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' });
    } else {
      body = JSON.stringify({ title, description: desc, fields, ts: Date.now() });
    }
    await fetch(CFG.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    log('warn', 'Webhook failed', { err: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. WALLET & RPC
// ═══════════════════════════════════════════════════════════════════════════

function loadWallet() {
  try {
    const raw = CFG.PRIVATE_KEY.startsWith('[')
      ? Uint8Array.from(JSON.parse(CFG.PRIVATE_KEY))
      : bs58.decode(CFG.PRIVATE_KEY);
    const kp = Keypair.fromSecretKey(raw);
    log('info', 'Wallet loaded', { address: kp.publicKey.toString().slice(0, 8) + '…' });
    return kp;
  } catch (err) {
    log('error', 'Invalid key', { err: err.message }); process.exit(1);
  }
}

function createRpc() {
  const endpoints = [
    CFG.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_KEY}` : null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.public.blastapi.io',
  ].filter(Boolean);

  const conns = endpoints.map(ep => new Connection(ep, { commitment: 'confirmed' }));
  let idx = 0;

  return {
    get conn() { return conns[idx]; },

    async healthCheck() {
      for (let i = 0; i < conns.length; i++) {
        try {
          const slot = await conns[i].getSlot();
          if (slot > 0) { idx = i; log('debug', 'RPC OK', { slot, ep: i }); return true; }
        } catch { log('warn', 'RPC down', { ep: endpoints[i].slice(0, 40) }); }
      }
      log('error', 'All RPC endpoints down'); return false;
    },

    failover() {
      idx = (idx + 1) % conns.length;
      log('warn', 'RPC failover', { ep: endpoints[idx].slice(0, 40) });
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. PERSISTANCE
// ═══════════════════════════════════════════════════════════════════════════

function loadState() {
  try {
    if (fs.existsSync(CFG.DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CFG.DATA_FILE, 'utf8'));
      log('info', 'State restored', {
        positions: Object.keys(raw.entryPrices || {}).length,
        trades:    (raw.trades || []).length,
      });
      return raw;
    }
  } catch (err) {
    log('warn', 'State load failed — clean start', { err: err.message });
  }
  return { entryPrices: {}, trades: [], stopLossHit: [], slPending: [] };
}

function saveState(data) {
  try { fs.writeFileSync(CFG.DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch (err) { log('warn', 'State save failed', { err: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. PRICE ENGINE — DexScreener → Pump.fun → Birdeye
//    Note: Jupiter Price API bloqué sur Render.com (réponse vide systématique)
// ═══════════════════════════════════════════════════════════════════════════

const priceCache    = new Map(); // mint → { data, ts }
const decimalsCache = new Map();

async function getDecimals(mint, conn) {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const dec  = info?.value?.data?.parsed?.info?.decimals;
    if (typeof dec === 'number') { decimalsCache.set(mint, dec); return dec; }
  } catch {}
  const fb = 6; // safe fallback
  decimalsCache.set(mint, fb);
  return fb;
}

// ── DexScreener batch ─────────────────────────────────────────────────────
async function fetchDexBatch(mints) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

  for (const chunk of chunks) {
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!r.ok) { await sleep(600); continue; }
      const d = await r.json();
      for (const pair of (d?.pairs || []).filter(p => p.chainId === 'solana')) {
        const mint = pair.baseToken?.address;
        if (!mint || !pair.priceUsd) continue;
        const ex = out[mint];
        if (!ex || (pair.liquidity?.usd || 0) > (ex.liquidity || 0)) {
          out[mint] = {
            price:     parseFloat(pair.priceUsd),
            liquidity: pair.liquidity?.usd   || 0,
            volume24h: pair.volume?.h24       || 0,
            change24h: pair.priceChange?.h24  || 0,
            logo:      pair.info?.imageUrl    || null,
            symbol:    pair.baseToken?.symbol || null,
            name:      pair.baseToken?.name   || null,
            source:    'dexscreener-batch',
          };
        }
      }
    } catch { /* next chunk */ }
    if (chunks.length > 1) await sleep(380);
  }
  return out;
}

// ── DexScreener individuel ────────────────────────────────────────────────
async function fetchDexSingle(mint) {
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d     = await r.json();
    const pairs = (d?.pairs || []).filter(p => p.chainId === 'solana');
    if (!pairs.length) return null;
    const best  = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!best?.priceUsd) return null;
    return {
      price:     parseFloat(best.priceUsd),
      liquidity: best.liquidity?.usd   || 0,
      volume24h: best.volume?.h24      || 0,
      change24h: best.priceChange?.h24 || 0,
      logo:      best.info?.imageUrl   || null,
      symbol:    best.baseToken?.symbol|| null,
      name:      best.baseToken?.name  || null,
      source:    'dexscreener-single',
    };
  } catch { return null; }
}

// ── Pump.fun ──────────────────────────────────────────────────────────────
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
      volume24h: 0,
      change24h: 0,
      logo:   c.image_uri || null,
      symbol: c.symbol    || null,
      name:   c.name      || null,
      source: 'pumpfun',
    };
  } catch { return null; }
}

// ── Birdeye ───────────────────────────────────────────────────────────────
async function fetchBirdeye(mint) {
  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${mint}`,
      { headers: { 'X-Chain': 'solana' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d     = await r.json();
    const price = parseFloat(d?.data?.value ?? 0);
    if (!price || price <= 0) return null;
    return { price, liquidity: 0, volume24h: 0, change24h: 0,
             logo: null, symbol: null, name: null, source: 'birdeye' };
  } catch { return null; }
}

// ── Orchestrateur ─────────────────────────────────────────────────────────
async function prefetchPrices(mints) {
  const now     = Date.now();
  const toFetch = mints.filter(m => {
    const c = priceCache.get(m);
    return !c || now - c.ts > CFG.PRICE_TTL_MS;
  });
  if (!toFetch.length) return;

  log('debug', 'Price fetch', { count: toFetch.length });

  // Étape 1 — DexScreener batch
  const found = await fetchDexBatch(toFetch);
  log('debug', 'DexScreener batch', { asked: toFetch.length, found: Object.keys(found).length });

  // Étape 2 — DexScreener individuel pour les manquants
  const miss1 = toFetch.filter(m => !found[m]);
  if (miss1.length) {
    const lim = pLimit(5);
    await Promise.all(miss1.map(m => lim(async () => {
      const d = await fetchDexSingle(m);
      if (d) found[m] = d;
    })));
  }

  // Étape 3 — Pump.fun
  const miss2 = toFetch.filter(m => !found[m]);
  if (miss2.length) {
    const lim = pLimit(5);
    await Promise.all(miss2.map(m => lim(async () => {
      const d = await fetchPumpFun(m);
      if (d) found[m] = d;
    })));
  }

  // Étape 4 — Birdeye
  const miss3 = toFetch.filter(m => !found[m]);
  if (miss3.length) {
    const lim = pLimit(4);
    await Promise.all(miss3.map(m => lim(async () => {
      const d = await fetchBirdeye(m);
      if (d) found[m] = d;
    })));
  }

  // Merge → cache
  const ts = Date.now();
  for (const m of toFetch) {
    const d = found[m];
    if (d?.price > 0) priceCache.set(m, { data: d, ts });
  }

  const ok   = toFetch.filter(m => priceCache.get(m)?.data?.price > 0).length;
  const srcs = {};
  for (const m of toFetch) {
    const s = priceCache.get(m)?.data?.source;
    if (s) srcs[s] = (srcs[s] || 0) + 1;
  }
  log('debug', 'Prices done', { ok, total: toFetch.length, missing: toFetch.length - ok, srcs });
}

function getPrice(mint) { return priceCache.get(mint)?.data || null; }

// ═══════════════════════════════════════════════════════════════════════════
// 8. POSITION MANAGER
// ═══════════════════════════════════════════════════════════════════════════

class PositionManager {
  constructor(tiers, hysteresis, state = {}) {
    this.tiers      = [...tiers].sort((a, b) => a.pnl - b.pnl);
    this.hysteresis = hysteresis;

    // Structures en mémoire
    this.entries    = new Map(); // mint → entryData
    this.triggered  = new Map(); // mint → Set<tierIndex>
    this.sold       = new Map(); // mint → totalSoldAmount
    this.peak       = new Map(); // mint → maxPnl
    this.prevPrice  = new Map(); // mint → lastSeenPrice
    this.slHit      = new Set(state.stopLossHit || []);
    this.slPending  = new Set(state.slPending   || []);

    // Restaurer depuis le state persisté
    for (const [mint, data] of Object.entries(state.entryPrices || {})) {
      this.entries.set(mint, data);
      this.triggered.set(mint, new Set(data.triggeredTiers || []));
      this.sold.set(mint, data.soldAmount || 0);
      this.peak.set(mint, data.peakPnl || 0);
    }
    log('info', 'Positions restored', { count: this.entries.size });
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  getPnl(mint, price) {
    const e = this.entries.get(mint);
    if (!e || !price || price <= 0) return null;
    return ((price - e.price) / e.price) * 100;
  }

  getRemaining(mint) {
    const e = this.entries.get(mint);
    if (!e) return 0;
    return Math.max(0, e.originalBalance - (this.sold.get(mint) || 0));
  }

  isLiquidated(mint) {
    return this.slHit.has(mint) || this.slPending.has(mint);
  }

  // ── Écriture ─────────────────────────────────────────────────────────────

  /**
   * Enregistre une nouvelle position.
   * forcedPrice = prix réel du swap (SOL / tokens).
   * Si absent → bootstrapped (démarrage sur token existant) → TP/SL désactivés
   * jusqu'à correction via /api/positions/set-entry ou scan Helius.
   */
  trackEntry(mint, marketPrice, balance, forcedPrice = null) {
    if (this.entries.has(mint)) return false;
    const price        = forcedPrice > 0 ? forcedPrice : marketPrice;
    const bootstrapped = !(forcedPrice > 0);
    if (!price || price <= 0 || !balance) return false;

    this.entries.set(mint, {
      price, bootstrapped,
      ts:              Date.now(),
      originalBalance: balance,
      triggeredTiers:  [],
      soldAmount:      0,
      peakPnl:         0,
    });
    this.triggered.set(mint, new Set());
    this.sold.set(mint, 0);
    this.peak.set(mint, 0);

    if (!bootstrapped) {
      log('info', '✅ Position tracked (real swap)', {
        mint: mint.slice(0, 8), price: price.toPrecision(6),
      });
    }
    return true;
  }

  /** Corrige le prix d'une position bootstrappée */
  setEntryPrice(mint, newPrice, newBalance = null) {
    const e = this.entries.get(mint);
    if (!e) return false;
    e.price       = newPrice;
    e.bootstrapped= false;
    this.triggered.set(mint, new Set());
    e.triggeredTiers = [];
    if (newBalance > 0) {
      e.originalBalance = newBalance;
      this.sold.set(mint, 0);
      e.soldAmount = 0;
    }
    log('info', '📌 Entry price corrected', { mint: mint.slice(0, 8), price: newPrice.toPrecision(6) });
    return true;
  }

  updatePeak(mint, pnl) {
    if (pnl === null) return;
    if (pnl > (this.peak.get(mint) || 0)) {
      this.peak.set(mint, pnl);
      const e = this.entries.get(mint);
      if (e) e.peakPnl = pnl;
    }
  }

  updatePrevPrice(mint, price) {
    if (price > 0) this.prevPrice.set(mint, price);
  }

  // ── Checks de sortie ─────────────────────────────────────────────────────

  /**
   * Take-profit paliers.
   * GUARD : retourne [] si position déjà liquidée (stopLossHit / slPending).
   * Sans ce guard, un Anti-Rug réussi dans le même tick provoquerait des
   * tentatives de revente → échecs Jupiter → circuit-breaker.
   */
  checkTP(mint, price) {
    if (this.isLiquidated(mint)) return []; // ← guard v2.2.1
    const e    = this.entries.get(mint);
    const trig = this.triggered.get(mint);
    const pnl  = this.getPnl(mint, price);
    if (!e || !trig || pnl === null) return [];
    if (e.bootstrapped) return []; // prix non fiable

    const out = [];
    for (let i = 0; i < this.tiers.length; i++) {
      if (trig.has(i)) continue;
      const tier = this.tiers[i];
      if (pnl < tier.pnl) continue;
      const remaining  = this.getRemaining(mint);
      const sellAmount = Math.min(e.originalBalance * (tier.sell / 100), remaining);
      if (sellAmount <= 0) continue;
      out.push({ tierIndex: i, pnlTarget: tier.pnl, currentPnl: pnl.toFixed(2), sellAmount });
    }
    return out;
  }

  /** Stop-loss fixe */
  checkSL(mint, price) {
    if (!CFG.SL_ENABLED || this.isLiquidated(mint)) return null;
    const e   = this.entries.get(mint);
    if (!e || e.bootstrapped) return null;
    const pnl = this.getPnl(mint, price);
    if (pnl === null || pnl > CFG.SL_PCT) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'stop-loss', pnl: pnl.toFixed(2), sellAmount: rem };
  }

  /** Trailing stop */
  checkTS(mint, price) {
    if (!CFG.TS_ENABLED || this.isLiquidated(mint)) return null;
    const pnl  = this.getPnl(mint, price);
    const peak = this.peak.get(mint) || 0;
    if (pnl === null || peak < CFG.TS_PCT) return null;
    if (pnl >= peak - CFG.TS_PCT) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'trailing-stop', pnl: pnl.toFixed(2), peak: peak.toFixed(2), sellAmount: rem };
  }

  /** Anti-rug : chute brutale en un cycle */
  checkAR(mint, price) {
    if (!CFG.AR_ENABLED || this.isLiquidated(mint)) return null;
    const prev = this.prevPrice.get(mint);
    if (!prev || prev <= 0) return null;
    const drop = ((prev - price) / prev) * 100;
    if (drop < CFG.AR_PCT) return null;
    const rem = this.getRemaining(mint);
    if (rem <= 0) return null;
    return { type: 'anti-rug', drop: drop.toFixed(1), sellAmount: rem };
  }

  // ── Marqueurs post-exécution ─────────────────────────────────────────────

  markTierDone(mint, tierIndex, amountSold) {
    const trig = this.triggered.get(mint);
    const e    = this.entries.get(mint);
    if (!trig || !e) return;
    trig.add(tierIndex);
    const total = (this.sold.get(mint) || 0) + amountSold;
    this.sold.set(mint, total);
    e.triggeredTiers = Array.from(trig);
    e.soldAmount     = total;
    log('success', `TP tier ${tierIndex + 1} done`, { mint: mint.slice(0, 8), sold: amountSold.toFixed(4) });
  }

  markSLDone(mint) {
    this.slHit.add(mint);
    this.slPending.delete(mint);
  }

  markSLPending(mint) {
    this.slPending.add(mint);
    log('warn', 'SL pending (sell failed)', { mint: mint.slice(0, 8) });
  }

  clearSLPending(mint) {
    this.slPending.delete(mint);
  }

  /** Hystérésis : réinitialise les paliers si le PnL redescend */
  resetTiersIfNeeded(mint, pnl) {
    const trig = this.triggered.get(mint);
    const e    = this.entries.get(mint);
    if (!trig || !e) return;
    for (let i = 0; i < this.tiers.length; i++) {
      if (trig.has(i) && pnl < this.tiers[i].pnl - this.hysteresis) {
        trig.delete(i);
        e.triggeredTiers = Array.from(trig);
        log('debug', 'Tier reset (hysteresis)', { mint: mint.slice(0, 8), tier: i + 1 });
      }
    }
  }

  // ── Sérialisation ─────────────────────────────────────────────────────────

  toSerializable() {
    const out = {};
    for (const [mint, e] of this.entries) {
      out[mint] = {
        price:           e.price,
        ts:              e.ts,
        originalBalance: e.originalBalance,
        triggeredTiers:  Array.from(this.triggered.get(mint) || []),
        soldAmount:      this.sold.get(mint) || 0,
        peakPnl:         this.peak.get(mint) || 0,
        bootstrapped:    e.bootstrapped || false,
      };
    }
    return out;
  }

  getStats() {
    const rows = [];
    for (const [mint, e] of this.entries) {
      rows.push({
        mint:            mint.slice(0, 8) + '…',
        mintFull:        mint,
        entryPrice:      e.price,
        bootstrapped:    !!e.bootstrapped,
        originalBalance: e.originalBalance,
        sold:            this.sold.get(mint) || 0,
        remaining:       this.getRemaining(mint),
        triggeredTiers:  Array.from(this.triggered.get(mint) || []).map(i => this.tiers[i]?.pnl),
        stopLossHit:     this.slHit.has(mint),
        slPending:       this.slPending.has(mint),
        peakPnl:         this.peak.get(mint) || 0,
      });
    }
    return {
      enabled:    CFG.TP_ENABLED,
      tiers:      this.tiers.map((t, i) => ({ index: i + 1, pnl: t.pnl, sell: t.sell })),
      hysteresis: this.hysteresis,
      stopLoss:   { enabled: CFG.SL_ENABLED, threshold: CFG.SL_PCT },
      trailing:   { enabled: CFG.TS_ENABLED, pct: CFG.TS_PCT },
      antiRug:    { enabled: CFG.AR_ENABLED, pct: CFG.AR_PCT },
      tracked:    rows.length,
      entries:    rows,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. SWAP ENGINE — Jupiter (lite-api → api → quote-api)
// ═══════════════════════════════════════════════════════════════════════════

const QUOTE_URLS = [
  'https://lite-api.jup.ag/swap/v1/quote',
  'https://api.jup.ag/swap/v1/quote',
  'https://quote-api.jup.ag/v6/quote',
];
const SWAP_URLS = [
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
    for (const base of QUOTE_URLS) {
      try {
        const r = await fetch(`${base}?${qs}`, {
          headers: { 'User-Agent': `SolBot/${VERSION}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) { last = new Error(`Quote HTTP ${r.status}`); continue; }
        const q = await r.json();
        if (q.error) { last = new Error(q.error); continue; }
        if (!q.outAmount) { last = new Error('No outAmount'); continue; }
        return q;
      } catch (err) {
        last = err;
        log('debug', 'Quote endpoint failed', { ep: base.split('/')[2], err: err.message });
      }
    }
    throw last || new Error('All Jupiter quote endpoints failed');
  }

  async _swap({ inputMint, outputMint, amountRaw, slippageBps }) {
    return withRetry(async () => {
      // Refetch quote à chaque tentative (expire ~60s)
      const quote = await this.getQuote({ inputMint, outputMint, amountRaw, slippageBps });
      const body  = JSON.stringify({
        quoteResponse:             quote,
        userPublicKey:             this.wallet.publicKey.toString(),
        wrapAndUnwrapSol:          true,
        dynamicComputeUnitLimit:   true,
        prioritizationFeeLamports: 'auto',
      });

      let swapData = null, swapErr;
      for (const url of SWAP_URLS) {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': `SolBot/${VERSION}` },
            body,
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) { swapErr = new Error(`Swap HTTP ${r.status}`); continue; }
          const d = await r.json();
          if (d?.swapTransaction) { swapData = d; break; }
          swapErr = new Error('swapTransaction missing');
        } catch (err) {
          swapErr = err;
          log('debug', 'Swap endpoint failed', { ep: url.split('/')[2], err: err.message });
        }
      }
      if (!swapData) throw swapErr || new Error('All Jupiter swap endpoints failed');

      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      // Blockhash extrait de la tx Jupiter — pas de refetch (race condition)
      const blockhash = tx.message.recentBlockhash;
      const lbh       = await this.rpc.conn.getLatestBlockhash('confirmed');
      tx.sign([this.wallet]);

      const sig  = await this.rpc.conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
      });
      const conf = await this.rpc.conn.confirmTransaction({
        signature: sig, blockhash, lastValidBlockHeight: lbh.lastValidBlockHeight,
      }, 'confirmed');

      if (conf.value.err) throw new Error(`Tx rejected: ${JSON.stringify(conf.value.err)}`);
      return { sig, txUrl: `https://solscan.io/tx/${sig}`, quote };
    }, { tries: 3, baseMs: 800, label: `swap(${inputMint.slice(0, 8)})` });
  }

  // ── Acheter ───────────────────────────────────────────────────────────────
  async buy(mint, solAmount, slippageBps = CFG.DEFAULT_SLIPPAGE) {
    const elapsed = Date.now() - this.lastBuyTs;
    if (elapsed < CFG.BUY_COOLDOWN_MS) {
      throw new Error(`Cooldown actif — ${((CFG.BUY_COOLDOWN_MS - elapsed) / 1000).toFixed(1)}s restantes`);
    }
    const bal = await this.getSolBalance();
    if (bal !== null && bal < solAmount + CFG.MIN_SOL_RESERVE) {
      throw new Error(`Solde insuffisant: ${bal.toFixed(4)} SOL (besoin ${(solAmount + CFG.MIN_SOL_RESERVE).toFixed(4)})`);
    }

    const amountRaw = BigInt(Math.floor(solAmount * 1e9));
    const { sig, txUrl, quote } = await this._swap({ inputMint: SOL_MINT, outputMint: mint, amountRaw, slippageBps });
    const dec       = await getDecimals(mint, this.rpc.conn);
    const outAmount = Number(quote.outAmount) / 10 ** dec;
    this.lastBuyTs  = Date.now();

    log('success', 'Buy confirmed', { mint: mint.slice(0, 8), tokens: outAmount.toFixed(4), sig });
    return { success: true, sig, txUrl, outAmount, solSpent: solAmount };
  }

  // ── DCA ───────────────────────────────────────────────────────────────────
  async buyDCA(mint, totalSol, chunks, intervalSec, slippageBps = CFG.DEFAULT_SLIPPAGE) {
    const chunkSol = totalSol / chunks;
    const results  = [];
    log('info', 'DCA start', { mint: mint.slice(0, 8), totalSol, chunks, intervalSec });

    for (let i = 0; i < chunks; i++) {
      try {
        const r = await this.buy(mint, chunkSol, slippageBps);
        results.push({ chunk: i + 1, ...r });
        log('info', `DCA chunk ${i + 1}/${chunks}`, { out: r.outAmount?.toFixed(4) });
      } catch (err) {
        log('warn', `DCA chunk ${i + 1} failed`, { err: err.message });
        results.push({ chunk: i + 1, success: false, error: err.message });
      }
      if (i < chunks - 1) await sleep(intervalSec * 1000);
    }
    return { results, succeeded: results.filter(r => r.success).length, total: chunks };
  }

  // ── Vendre (mutex — zéro double-sell) ─────────────────────────────────────
  async sell(mint, amount, reason = 'MANUAL', slippageBps = CFG.DEFAULT_SLIPPAGE) {
    if (this.sellFailures >= CFG.MAX_SELL_RETRIES) {
      const msg = `Circuit-breaker actif (${this.sellFailures} échecs)`;
      log('error', msg); return { success: false, error: msg };
    }
    const release = await this.mutex.lock();
    try {
      const dec    = await getDecimals(mint, this.rpc.conn);
      const raw    = BigInt(Math.floor(amount * 10 ** dec));
      const { sig, txUrl, quote } = await this._swap({ inputMint: mint, outputMint: SOL_MINT, amountRaw: raw, slippageBps });
      const solOut = Number(quote.outAmount) / 1e9;
      this.sellFailures = 0;
      log('success', 'Sell confirmed', { mint: mint.slice(0, 8), solOut: solOut.toFixed(6), reason, sig });
      return { success: true, sig, txUrl, solOut, amountSold: amount };
    } catch (err) {
      this.sellFailures++;
      log('error', 'Sell failed', { err: err.message, failures: this.sellFailures, reason });
      return { success: false, error: err.message };
    } finally {
      release();
    }
  }

  async getSolBalance() {
    try { return await this.rpc.conn.getBalance(this.wallet.publicKey) / 1e9; }
    catch { return null; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. BOT LOOP
// ═══════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor(wallet, rpc, state) {
    this.wallet    = wallet;
    this.rpc       = rpc;
    this.portfolio = [];
    this.startTime = Date.now();
    this.cycle     = 0;
    this.history   = state.trades || [];

    // Analytics
    const a = state.analytics || {};
    this.analytics = {
      realizedPnlSol:   a.realizedPnlSol   || 0,
      totalBoughtSol:   a.totalBoughtSol   || 0,
      totalSoldSol:     a.totalSoldSol     || 0,
      winCount:         a.winCount         || 0,
      lossCount:        a.lossCount        || 0,
      totalTrades:      a.totalTrades      || 0,
      bestTradePct:     a.bestTradePct     || null,
      worstTradePct:    a.worstTradePct    || null,
      bestTradeSymbol:  a.bestTradeSymbol  || null,
      worstTradeSymbol: a.worstTradeSymbol || null,
      avgHoldMs:        a.avgHoldMs        || 0,
      dailyPnl:         a.dailyPnl         || [],
      pnlHistory:       a.pnlHistory        || [],
    };

    this.costBasis = new Map(Object.entries(state.costBasis || {}));
    this.positions = new PositionManager(CFG.TP_TIERS, CFG.TP_HYSTERESIS, state);
    this.swap      = new SwapEngine(wallet, rpc);
  }

  // ── Persistance ───────────────────────────────────────────────────────────

  persist() {
    saveState({
      entryPrices: this.positions.toSerializable(),
      trades:      this.history.slice(0, 500),
      stopLossHit: Array.from(this.positions.slHit),
      slPending:   Array.from(this.positions.slPending),
      analytics:   this.analytics,
      costBasis:   Object.fromEntries(this.costBasis),
    });
  }

  // ── Comptabilité ──────────────────────────────────────────────────────────

  recordBuy(mint, solSpent, tokBought) {
    const cb = this.costBasis.get(mint);
    if (cb) { cb.solSpent += solSpent; cb.tokBought += tokBought; }
    else    { this.costBasis.set(mint, { solSpent, tokBought, buyTs: Date.now() }); }
    this.analytics.totalBoughtSol = +(this.analytics.totalBoughtSol + solSpent).toFixed(6);
  }

  recordSell(mint, solOut, amountSold, symbol) {
    const cb = this.costBasis.get(mint);
    let pnlSol = null, pnlPct = null, holdMs = null;

    if (cb?.solSpent > 0 && cb?.tokBought > 0) {
      const pct   = Math.min(amountSold / cb.tokBought, 1);
      const cost  = cb.solSpent * pct;
      pnlSol      = +(solOut - cost).toFixed(6);
      pnlPct      = cost > 0 ? +((pnlSol / cost) * 100).toFixed(2) : null;
      holdMs      = Date.now() - (cb.buyTs || Date.now());

      // Mise à jour cost basis
      cb.solSpent  *= (1 - pct);
      cb.tokBought -= amountSold;
      if (cb.tokBought <= 0) this.costBasis.delete(mint);

      // Analytics
      const an = this.analytics;
      an.realizedPnlSol = +(an.realizedPnlSol + pnlSol).toFixed(6);
      an.totalSoldSol   = +(an.totalSoldSol   + solOut).toFixed(6);
      an.totalTrades++;

      if (pnlSol >= 0) {
        an.winCount++;
        if (pnlPct !== null && (an.bestTradePct === null || pnlPct > an.bestTradePct)) {
          an.bestTradePct = pnlPct; an.bestTradeSymbol = symbol;
        }
      } else {
        an.lossCount++;
        if (pnlPct !== null && (an.worstTradePct === null || pnlPct < an.worstTradePct)) {
          an.worstTradePct = pnlPct; an.worstTradeSymbol = symbol;
        }
      }

      const n = an.totalTrades;
      an.avgHoldMs = Math.round((an.avgHoldMs * (n - 1) + holdMs) / n);

      const today = new Date().toISOString().slice(0, 10);
      const day   = an.dailyPnl.find(d => d.date === today);
      if (day) { day.pnlSol = +(day.pnlSol + pnlSol).toFixed(6); day.trades++; }
      else      { an.dailyPnl.push({ date: today, pnlSol: +pnlSol.toFixed(6), trades: 1 }); }
      if (an.dailyPnl.length > 90) an.dailyPnl.shift();

      an.pnlHistory.push({ ts: Date.now(), cumul: +an.realizedPnlSol.toFixed(6) });
      if (an.pnlHistory.length > 500) an.pnlHistory.shift();
    } else {
      this.analytics.totalSoldSol = +(this.analytics.totalSoldSol + solOut).toFixed(6);
    }
    return { pnlSol, pnlPct, holdMs };
  }

  recordTrade(entry) {
    this.history.unshift({ ...entry, ts: Date.now() });
    if (this.history.length > 500) this.history.length = 500;
  }

  // ── Helper vente centralisé ───────────────────────────────────────────────
  /**
   * Exécute une vente automatique (TP / SL / AR / TS) et met à jour toutes
   * les structures en cas de succès. Retourne true si la vente a réussi.
   */
  async _executeSellAction(mint, sellAmount, reason, label, priceData, {
    onSuccess = null,   // callback(result) pour le TP (markTierDone etc.)
    webhookTitle  = null,
    webhookDesc   = null,
    webhookColor  = 0x3b7eff,
    webhookFields = [],
    markSLDone    = false,
    pendingFirst  = false, // si true : markSLPending avant le swap
  } = {}) {
    if (pendingFirst) this.positions.markSLPending(mint);

    const res = await this.swap.sell(mint, sellAmount, reason);
    if (res.success) {
      const symbol = priceData?.symbol || mint.slice(0, 8);
      const { pnlSol, pnlPct } = this.recordSell(mint, res.solOut, sellAmount, symbol);
      this.recordTrade({
        type: 'sell', mint, symbol,
        amount: sellAmount, solOut: res.solOut,
        reason, txId: res.sig, txUrl: res.txUrl, pnlSol, pnlPct,
      });
      if (markSLDone)  this.positions.markSLDone(mint);
      if (onSuccess)   onSuccess(res);
      if (webhookTitle) {
        await webhook(
          webhookTitle,
          webhookDesc || '',
          webhookColor,
          [...webhookFields,
            { name: 'SOL reçu', value: res.solOut?.toFixed(6) || '?', inline: true },
          ],
        );
      }
      return true;
    } else {
      // Échec de la vente
      if (pendingFirst) this.positions.clearSLPending(mint); // retry cycle suivant
      return false;
    }
  }

  // ── Tick principal ────────────────────────────────────────────────────────

  async tick() {
    try {
      if (this.cycle % 10 === 0) await this.rpc.healthCheck();
      this.cycle++;

      // Lecture des comptes token
      const [r1, r2] = await Promise.all([
        this.rpc.conn.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(SPL_TOKEN) }),
        this.rpc.conn.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(SPL_2022)  }),
      ]);

      const accounts = [...r1.value, ...r2.value].filter(acc => {
        if (acc.account.data.parsed.info.mint === SOL_MINT) return false;
        const ta  = acc.account.data.parsed.info.tokenAmount;
        return parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0') > 0;
      });

      await prefetchPrices(accounts.map(a => a.account.data.parsed.info.mint));

      const tokens = [];
      for (const acc of accounts) {
        const mint  = acc.account.data.parsed.info.mint;
        const ta    = acc.account.data.parsed.info.tokenAmount;
        const bal   = parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0');
        if (!bal || bal <= 0) continue;

        const pd    = getPrice(mint);
        const price = pd?.price || 0;

        this.positions.trackEntry(mint, price, bal);
        const pnl = this.positions.getPnl(mint, price);
        if (pnl !== null) this.positions.updatePeak(mint, pnl);

        if (price > 0) {
          const sym = pd?.symbol || mint.slice(0, 8);

          // ── 1. Anti-Rug (priorité max) ──────────────────────────────────
          const ar = this.positions.checkAR(mint, price);
          if (ar) {
            log('error', `🚨 ANTI-RUG -${ar.drop}%`, { mint: mint.slice(0, 8), sym });
            await webhook('🚨 Anti-Rug', `Chute de **${ar.drop}%** — ${sym}`, 0xff4757, [
              { name: 'Token', value: sym, inline: true },
              { name: 'Chute', value: ar.drop + '%', inline: true },
            ]);
            await this._executeSellAction(mint, ar.sellAmount, 'ANTI_RUG', 'Anti-Rug', pd, {
              pendingFirst:  true,
              markSLDone:    true,
              webhookTitle:  '✅ Anti-Rug vendu',
              webhookDesc:   `${ar.sellAmount.toFixed(4)} tokens liquidés`,
              webhookColor:  0x05d488,
            });
          }

          // ── 2. Take-Profit paliers ─────────────────────────────────────
          // checkTP retourne [] si stopLossHit|slPending (guard v2.2.1)
          if (CFG.TP_ENABLED && pnl !== null) {
            for (const tier of this.positions.checkTP(mint, price)) {
              log('warn', `🎯 TP T${tier.tierIndex + 1} +${tier.currentPnl}%`, {
                mint: mint.slice(0, 8), sell: tier.sellAmount.toFixed(4),
              });
              const idx = tier.tierIndex;
              await this._executeSellAction(mint, tier.sellAmount, `TP_T${idx + 1}`, `TP T${idx + 1}`, pd, {
                onSuccess: () => this.positions.markTierDone(mint, idx, tier.sellAmount),
                webhookTitle:  `🎯 Take-Profit T${idx + 1}`,
                webhookDesc:   `+${tier.currentPnl}% sur **${sym}**`,
                webhookColor:  0x05d488,
                webhookFields: [{ name: 'Vendu', value: tier.sellAmount.toFixed(4), inline: true }],
              });
            }
            this.positions.resetTiersIfNeeded(mint, pnl);
          }

          // ── 3. Stop-Loss fixe ──────────────────────────────────────────
          const sl = this.positions.checkSL(mint, price);
          if (sl) {
            log('warn', `🔴 STOP-LOSS ${sl.pnl}%`, { mint: mint.slice(0, 8) });
            await this._executeSellAction(mint, sl.sellAmount, 'STOP_LOSS', 'Stop-Loss', pd, {
              pendingFirst:  true,
              markSLDone:    true,
              webhookTitle:  '🔴 Stop-Loss',
              webhookDesc:   `**${sym}** vendu à ${sl.pnl}%`,
              webhookColor:  0xff4757,
            });
          }

          // ── 4. Trailing Stop ───────────────────────────────────────────
          const ts = this.positions.checkTS(mint, price);
          if (ts) {
            log('warn', `📉 TRAILING STOP pic:+${ts.peak}% actuel:${ts.pnl}%`, { mint: mint.slice(0, 8) });
            await this._executeSellAction(mint, ts.sellAmount, 'TRAILING_STOP', 'Trailing Stop', pd, {
              pendingFirst:  true,
              markSLDone:    true,
              webhookTitle:  '📉 Trailing Stop',
              webhookDesc:   `**${sym}** — pic: +${ts.peak}%, actuel: ${ts.pnl}%`,
              webhookColor:  0xffb020,
            });
          }
        }

        this.positions.updatePrevPrice(mint, price);

        tokens.push({
          mint:             mint.slice(0, 8) + '…' + mint.slice(-4),
          mintFull:         mint,
          balance:          parseFloat(bal.toFixed(6)),
          price:            price > 0 ? price : null,
          value:            parseFloat((bal * price).toFixed(4)),
          liquidity:        pd?.liquidity  || 0,
          volume24h:        pd?.volume24h  || 0,
          change24h:        pd?.change24h  || 0,
          logo:             pd?.logo        || null,
          symbol:           pd?.symbol      || null,
          name:             pd?.name        || null,
          pnl,
          peakPnl:          this.positions.peak.get(mint) || null,
          entryPrice:       this.positions.entries.get(mint)?.price || null,
          bootstrapped:     this.positions.entries.get(mint)?.bootstrapped || false,
          remainingBalance: this.positions.getRemaining(mint),
          triggeredTiers:   Array.from(this.positions.triggered.get(mint) || [])
                              .map(i => CFG.TP_TIERS[i]?.pnl),
          stopLossHit:      this.positions.slHit.has(mint),
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

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats() {
    const tv    = this.portfolio.reduce((s, t) => s + t.value, 0);
    const pnls  = this.portfolio.filter(t => t.pnl !== null).map(t => t.pnl);
    const avg   = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
    return {
      version:    VERSION,
      uptime:     Math.round((Date.now() - this.startTime) / 1000),
      cycles:     this.cycle,
      tokens:     this.portfolio.length,
      totalValue: parseFloat(tv.toFixed(4)),
      pnlStats:   {
        avgPnl:   avg !== null ? +avg.toFixed(2) : null,
        best:     pnls.length ? +Math.max(...pnls).toFixed(2) : null,
        worst:    pnls.length ? +Math.min(...pnls).toFixed(2) : null,
        positive: pnls.filter(p => p >= 0).length,
        negative: pnls.filter(p => p  < 0).length,
      },
      takeProfit: CFG.TP_ENABLED ? this.positions.getStats() : { enabled: false },
      stopLoss:   { enabled: CFG.SL_ENABLED, threshold: CFG.SL_PCT },
      trailing:   { enabled: CFG.TS_ENABLED, pct: CFG.TS_PCT },
      antiRug:    { enabled: CFG.AR_ENABLED, pct: CFG.AR_PCT },
      sellCircuitBreaker: this.swap.sellFailures,
      lastUpdate: new Date().toISOString(),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. API
// ═══════════════════════════════════════════════════════════════════════════

function startApi(bot, wallet) {
  const app = express();
  app.use(express.json({ limit: '128kb' }));

  // CORS — wildcard (dashboard GitHub Pages + Render sans auth ni cookies)
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Dashboard statique
  const indexPath = path.join(process.env.STATIC_DIR || __dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    app.use(express.static(path.dirname(indexPath)));
    app.get('/', (_, res) => res.sendFile(indexPath));
    log('info', 'Local dashboard enabled');
  } else {
    app.get('/', (_, res) => {
      if (CFG.DASHBOARD_URL) return res.redirect(302, CFG.DASHBOARD_URL);
      res.json({ bot: `SolBot v${VERSION}`, status: 'running', uptime: Math.round(process.uptime()) + 's' });
    });
  }

  // ─── Helpers internes ──────────────────────────────────────────────────────
  const num  = (v, min, max) => { const n = parseFloat(v); return !isNaN(n) && n >= min && n <= max ? n : null; };
  const addr = a => wallet.publicKey.toString() === a || a === 'me';

  // ─── Health & debug ────────────────────────────────────────────────────────
  app.get('/health', (_, res) => res.json({ status: 'ok', version: VERSION, uptime: process.uptime() }));

  app.get('/api/debug/prices', (_, res) => {
    const rows = [];
    for (const [mint, e] of priceCache) {
      rows.push({ mint: mint.slice(0, 8) + '…', price: e.data?.price, source: e.data?.source,
        symbol: e.data?.symbol, age: Math.round((Date.now() - e.ts) / 1000) + 's' });
    }
    res.json({ total: rows.length, tokens: rows.slice(0, 40) });
  });

  // ─── Portfolio & stats ────────────────────────────────────────────────────
  app.get('/api/stats',       (_, res) => res.json(bot.getStats()));
  app.get('/api/portfolio',   (_, res) => res.json({
    address: wallet.publicKey.toString(), tokens: bot.portfolio, timestamp: Date.now(),
  }));
  app.get('/api/wallet',      (_, res) => res.json({ address: wallet.publicKey.toString() }));
  app.get('/api/take-profit', (_, res) => res.json(bot.positions.getStats()));
  app.get('/api/trades',      (_, res) => res.json({ trades: bot.history }));
  app.get('/api/sol-balance', async (_, res) => {
    const bal = await bot.swap.getSolBalance();
    res.json({ balance: bal, formatted: bal != null ? bal.toFixed(6) + ' SOL' : null });
  });

  // ─── Analytics ────────────────────────────────────────────────────────────
  app.get('/api/analytics', (_, res) => {
    const a  = bot.analytics;
    const n  = a.winCount + a.lossCount;
    const sells = bot.history.filter(t => t.type === 'sell' && t.pnlPct != null);
    const wins  = sells.filter(t => t.pnlPct >= 0);
    const loses = sells.filter(t => t.pnlPct <  0);
    const h  = Math.floor(a.avgHoldMs / 3600000);
    const m  = Math.floor((a.avgHoldMs % 3600000) / 60000);
    res.json({
      realizedPnlSol:   +a.realizedPnlSol.toFixed(4),
      totalBoughtSol:   +a.totalBoughtSol.toFixed(4),
      totalSoldSol:     +a.totalSoldSol.toFixed(4),
      winCount:         a.winCount,
      lossCount:        a.lossCount,
      totalTrades:      a.totalTrades,
      winRate:          n > 0 ? +((a.winCount / n) * 100).toFixed(1) : null,
      roi:              a.totalBoughtSol > 0
        ? +((a.realizedPnlSol / a.totalBoughtSol) * 100).toFixed(2) : null,
      avgWin:  wins.length  ? +(wins.reduce((s, t)  => s + t.pnlPct, 0) / wins.length).toFixed(1)  : null,
      avgLoss: loses.length ? +(loses.reduce((s, t) => s + t.pnlPct, 0) / loses.length).toFixed(1) : null,
      avgHold: a.avgHoldMs > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : null,
      bestTradePct:    a.bestTradePct,
      bestTradeSymbol: a.bestTradeSymbol,
      worstTradePct:   a.worstTradePct,
      worstTradeSymbol:a.worstTradeSymbol,
      dailyPnl:        a.dailyPnl.slice(-30),
      pnlHistory:      a.pnlHistory.slice(-200),
    });
  });

  // ─── Config GET ────────────────────────────────────────────────────────────
  app.get('/api/config', (_, res) => res.json({
    takeProfitEnabled: CFG.TP_ENABLED,
    takeProfitTiers:   CFG.TP_TIERS,
    hysteresis:        CFG.TP_HYSTERESIS,
    stopLossEnabled:   CFG.SL_ENABLED,
    stopLossPct:       CFG.SL_PCT,
    trailingEnabled:   CFG.TS_ENABLED,
    trailingPct:       CFG.TS_PCT,
    antiRugEnabled:    CFG.AR_ENABLED,
    antiRugPct:        CFG.AR_PCT,
    defaultSlippage:   CFG.DEFAULT_SLIPPAGE,
    minSolReserve:     CFG.MIN_SOL_RESERVE,
    intervalSec:       CFG.INTERVAL_SEC,
  }));

  // ─── Config POST ───────────────────────────────────────────────────────────
  app.post('/api/config', (req, res) => {
    const b = req.body;
    if (b.takeProfitEnabled !== undefined) CFG.TP_ENABLED = !!b.takeProfitEnabled;
    if (b.stopLossEnabled   !== undefined) CFG.SL_ENABLED = !!b.stopLossEnabled;
    if (b.trailingEnabled   !== undefined) CFG.TS_ENABLED = !!b.trailingEnabled;
    if (b.antiRugEnabled    !== undefined) CFG.AR_ENABLED = !!b.antiRugEnabled;

    if (Array.isArray(b.takeProfitTiers) && b.takeProfitTiers.length) {
      const clean = b.takeProfitTiers
        .map(t => ({ pnl: parseFloat(t.pnl), sell: parseFloat(t.sell) }))
        .filter(t => t.pnl > 0 && t.sell > 0 && t.sell <= 100)
        .sort((a, b) => a.pnl - b.pnl);
      if (clean.length) CFG.TP_TIERS = clean;
    }

    const v = (key, min, max, setter) => {
      const n = num(b[key], min, max);
      if (n !== null) setter(n);
    };
    v('stopLossPct',     -100,  0,    n => CFG.SL_PCT           = n);
    v('trailingPct',        1, 100,   n => CFG.TS_PCT           = n);
    v('antiRugPct',         1, 100,   n => CFG.AR_PCT           = n);
    v('hysteresis',         0, 50,    n => CFG.TP_HYSTERESIS    = n);
    v('defaultSlippage',   10, 5000,  n => CFG.DEFAULT_SLIPPAGE = n);
    v('minSolReserve',      0, 10,    n => CFG.MIN_SOL_RESERVE  = n);
    v('intervalSec',       10, 3600,  n => CFG.INTERVAL_SEC     = n);

    log('info', 'Config updated', { tp: CFG.TP_ENABLED, sl: CFG.SL_ENABLED, ts: CFG.TS_ENABLED, ar: CFG.AR_ENABLED });
    res.json({ success: true, config: {
      takeProfitEnabled: CFG.TP_ENABLED, takeProfitTiers: CFG.TP_TIERS,
      hysteresis: CFG.TP_HYSTERESIS, stopLossEnabled: CFG.SL_ENABLED,
      stopLossPct: CFG.SL_PCT, trailingEnabled: CFG.TS_ENABLED, trailingPct: CFG.TS_PCT,
      antiRugEnabled: CFG.AR_ENABLED, antiRugPct: CFG.AR_PCT,
      defaultSlippage: CFG.DEFAULT_SLIPPAGE, minSolReserve: CFG.MIN_SOL_RESERVE,
      intervalSec: CFG.INTERVAL_SEC,
    }});
  });

  // ─── Quote ────────────────────────────────────────────────────────────────
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
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ─── Buy ──────────────────────────────────────────────────────────────────
  app.post('/api/buy', async (req, res) => {
    const { mint, solAmount, slippageBps = CFG.DEFAULT_SLIPPAGE } = req.body;
    if (!mint || !solAmount) return res.status(400).json({ error: 'mint et solAmount requis' });
    const sol = parseFloat(solAmount);
    if (isNaN(sol) || sol <= 0 || sol > 50) return res.status(400).json({ error: 'solAmount invalide (0-50)' });

    try {
      const result = await bot.swap.buy(mint, sol, parseInt(slippageBps) || CFG.DEFAULT_SLIPPAGE);
      if (result.success) {
        const pd         = getPrice(mint);
        const entryPrice = result.outAmount > 0 ? sol / result.outAmount : (pd?.price || 0);
        bot.positions.trackEntry(mint, entryPrice, result.outAmount, entryPrice);
        bot.recordBuy(mint, sol, result.outAmount || 0);
        bot.recordTrade({
          type: 'buy', mint, symbol: pd?.symbol || mint.slice(0, 8),
          solSpent: sol, outAmount: result.outAmount, entryPrice,
          txId: result.sig, txUrl: result.txUrl,
        });
        bot.persist();
        setTimeout(() => bot.tick().catch(() => {}), 4000);
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ─── Buy DCA ──────────────────────────────────────────────────────────────
  app.post('/api/buy/dca', async (req, res) => {
    const { mint, totalSol, chunks = 3, intervalSec = 60, slippageBps = CFG.DEFAULT_SLIPPAGE } = req.body;
    if (!mint || !totalSol) return res.status(400).json({ error: 'mint et totalSol requis' });
    const sol = parseFloat(totalSol);
    const n   = Math.min(parseInt(chunks) || 3, 10);
    if (isNaN(sol) || sol <= 0) return res.status(400).json({ error: 'totalSol invalide' });

    try {
      const result = await bot.swap.buyDCA(mint, sol, n,
        parseInt(intervalSec) || 60, parseInt(slippageBps) || CFG.DEFAULT_SLIPPAGE);

      for (const r of result.results.filter(r => r.success)) {
        const pd         = getPrice(mint);
        const chunkPrice = r.outAmount > 0 ? (sol / n) / r.outAmount : (pd?.price || 0);
        if (!bot.positions.entries.has(mint)) {
          bot.positions.trackEntry(mint, chunkPrice, r.outAmount, chunkPrice);
        } else {
          // DCA : mise à jour du prix d'entrée par moyenne pondérée
          const e  = bot.positions.entries.get(mint);
          const cb = bot.costBasis.get(mint) || { solSpent: 0, tokBought: 0 };
          const total = cb.tokBought + r.outAmount;
          if (total > 0) e.price = (cb.solSpent + sol / n) / total;
        }
        bot.recordBuy(mint, sol / n, r.outAmount || 0);
        bot.recordTrade({
          type: 'buy', mint, symbol: getPrice(mint)?.symbol || mint.slice(0, 8),
          solSpent: sol / n, outAmount: r.outAmount, txId: r.sig, txUrl: r.txUrl,
          tag: `DCA ${r.chunk}/${n}`,
        });
      }
      bot.persist();
      setTimeout(() => bot.tick().catch(() => {}), 4000);
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ─── Sell ─────────────────────────────────────────────────────────────────
  app.post('/api/sell', async (req, res) => {
    const { mint, amount, percent, slippageBps = CFG.DEFAULT_SLIPPAGE, reason = 'MANUAL' } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });

    const tok = bot.portfolio.find(t => t.mintFull === mint || t.mintFull?.startsWith(mint.slice(0, 8)));
    if (!tok) return res.status(404).json({ error: 'Token non trouvé dans le portfolio' });

    let sellAmount = parseFloat(amount) || 0;
    if (percent !== undefined) sellAmount = tok.balance * (parseFloat(percent) / 100);
    if (sellAmount <= 0) return res.status(400).json({ error: 'Montant invalide' });
    sellAmount = Math.min(sellAmount, tok.balance);

    const result = await bot.swap.sell(tok.mintFull, sellAmount, reason, parseInt(slippageBps) || CFG.DEFAULT_SLIPPAGE);
    if (result.success) {
      const { pnlSol, pnlPct } = bot.recordSell(tok.mintFull, result.solOut, sellAmount, tok.symbol);
      bot.recordTrade({
        type: 'sell', mint: tok.mintFull, symbol: tok.symbol || tok.mintFull.slice(0, 8),
        amount: sellAmount, solOut: result.solOut, reason,
        txId: result.sig, txUrl: result.txUrl, pnlSol, pnlPct,
      });
      bot.persist();
      setTimeout(() => bot.tick().catch(() => {}), 4000);
    }
    res.json({ ...result, sellAmount });
  });

  // ─── Positions ────────────────────────────────────────────────────────────
  app.get('/api/positions', (_, res) => {
    const rows = [];
    for (const [mint, e] of bot.positions.entries) {
      const tok = bot.portfolio.find(t => t.mintFull === mint);
      const pd  = getPrice(mint);
      const cur = tok?.price || pd?.price || 0;
      const pnl = e.price > 0 && cur > 0 ? ((cur - e.price) / e.price) * 100 : null;
      rows.push({
        mint, symbol: tok?.symbol || pd?.symbol || null,
        entryPrice: e.price, currentPrice: cur,
        pnl: pnl !== null ? +pnl.toFixed(2) : null,
        bootstrapped:    !!e.bootstrapped,
        originalBalance: e.originalBalance,
        remaining:       bot.positions.getRemaining(mint),
        soldAmount:      bot.positions.sold.get(mint) || 0,
        triggeredTiers:  Array.from(bot.positions.triggered.get(mint) || []),
        stopLossHit:     bot.positions.slHit.has(mint),
        peakPnl:         bot.positions.peak.get(mint) || 0,
        entryTs:         e.ts,
      });
    }
    const booted = rows.filter(p => p.bootstrapped).length;
    res.json({
      count: rows.length, bootstrapped: booted, real: rows.length - booted,
      positions: rows.sort((a, b) => (b.pnl || 0) - (a.pnl || 0)),
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
    const e = bot.positions.entries.get(mint);
    res.json({ success: true, mint, entryPrice: e.price, bootstrapped: !!e.bootstrapped, message: 'TP/SL actifs' });
  });

  app.post('/api/positions/delete', (req, res) => {
    const { mint } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    if (!bot.positions.entries.has(mint)) return res.status(404).json({ error: 'Position non trouvée' });
    bot.positions.entries.delete(mint);
    bot.positions.triggered.delete(mint);
    bot.positions.sold.delete(mint);
    bot.positions.peak.delete(mint);
    bot.positions.slHit.delete(mint);
    bot.positions.slPending.delete(mint);
    bot.persist();
    log('info', 'Position deleted', { mint: mint.slice(0, 8) });
    res.json({ success: true, mint });
  });

  // ─── Helius history scan ──────────────────────────────────────────────────
  app.get('/api/positions/scan-history', async (_, res) => {
    if (!CFG.HELIUS_KEY) return res.status(400).json({ error: 'HELIUS_API_KEY requis' });
    const booted = [...bot.positions.entries.entries()]
      .filter(([, e]) => e.bootstrapped).map(([m]) => m);
    if (!booted.length) return res.json({ message: 'Aucune position bootstrappée', fixed: 0 });

    const walletStr = wallet.publicKey.toString();
    const results   = [];
    log('info', `Helius scan — ${booted.length} bootstrapped positions`);

    for (const mint of booted) {
      try {
        const url = `https://api.helius.xyz/v0/addresses/${walletStr}/transactions` +
          `?api-key=${CFG.HELIUS_KEY}&limit=100&type=SWAP`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) { results.push({ mint, status: 'error', error: `HTTP ${r.status}` }); continue; }
        const txs = await r.json();
        let found = null;

        for (const tx of Array.isArray(txs) ? txs : []) {
          const recv = (tx.tokenTransfers || []).find(t =>
            t.mint === mint && t.toUserAccount === walletStr && t.tokenAmount > 0);
          if (!recv) continue;
          const solOut = (tx.nativeTransfers || [])
            .filter(n => n.fromUserAccount === walletStr)
            .reduce((s, n) => s + (n.amount || 0), 0) / 1e9;
          if (solOut > 0 && recv.tokenAmount > 0) {
            found = { solSpent: solOut, tokReceived: recv.tokenAmount,
              entryPrice: solOut / recv.tokenAmount, tx: tx.signature, ts: tx.timestamp };
            break;
          }
        }

        if (found?.entryPrice > 0) {
          const old = bot.positions.entries.get(mint)?.price;
          bot.positions.setEntryPrice(mint, found.entryPrice);
          if (!bot.costBasis.has(mint)) {
            bot.costBasis.set(mint, {
              solSpent: found.solSpent, tokBought: found.tokReceived,
              buyTs: (found.ts || Date.now() / 1000) * 1000,
            });
          }
          results.push({ mint: mint.slice(0, 8), symbol: getPrice(mint)?.symbol,
            status: 'fixed', entryPrice: found.entryPrice, priceBefore: old });
          log('success', `Entry found ${mint.slice(0, 8)}`, { price: found.entryPrice.toPrecision(4) });
        } else {
          results.push({ mint: mint.slice(0, 8), status: 'not_found' });
        }
        await sleep(250);
      } catch (err) {
        results.push({ mint: mint.slice(0, 8), status: 'error', error: err.message });
      }
    }
    const fixed = results.filter(r => r.status === 'fixed').length;
    if (fixed > 0) bot.persist();
    log('info', `Scan done: ${fixed}/${booted.length}`);
    res.json({ total: booted.length, fixed, results });
  });

  // ─── Circuit-breaker ──────────────────────────────────────────────────────
  app.post('/api/reset-circuit-breaker', (_, res) => {
    bot.swap.sellFailures = 0;
    log('info', 'Circuit-breaker reset');
    res.json({ success: true });
  });

  // ─── Legacy & 404 ─────────────────────────────────────────────────────────
  app.post('/api/sell/test', (_, res) => res.status(410).json({ error: 'Retiré — utiliser POST /api/sell' }));
  app.use((_, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(CFG.PORT, '0.0.0.0', () =>
    log('info', `API ready on :${CFG.PORT}`, { version: VERSION }));
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log('info', `SolBot v${VERSION} — Starting`, { env: CFG.NODE_ENV });

  const tpStr = CFG.TP_TIERS.map(t => `+${t.pnl}%→${t.sell}%`).join(' | ');
  log('info', '═══ ACTIVE STRATEGY ═══', {
    TAKE_PROFIT: CFG.TP_ENABLED ? `✅ [${tpStr}]` : '❌ OFF',
    STOP_LOSS:   CFG.SL_ENABLED ? `✅ [${CFG.SL_PCT}%]` : '❌ OFF',
    TRAILING:    CFG.TS_ENABLED ? `✅ [-${CFG.TS_PCT}% from peak]` : '❌ OFF',
    ANTI_RUG:    CFG.AR_ENABLED ? `✅ [>${CFG.AR_PCT}% drop/cycle]` : '❌ OFF',
    HYSTERESIS:  CFG.TP_HYSTERESIS + '%',
    INTERVAL:    CFG.INTERVAL_SEC + 's',
  });

  const wallet = loadWallet();
  const rpc    = createRpc();
  const state  = loadState();
  const bot    = new BotLoop(wallet, rpc, state);

  log('info', 'First tick…');
  await bot.tick();

  setInterval(
    () => bot.tick().catch(err => log('error', 'Loop error', { err: err.message })),
    CFG.INTERVAL_SEC * 1000,
  );

  startApi(bot, wallet);

  log('success', 'Bot operational', {
    address:   wallet.publicKey.toString().slice(0, 8) + '…',
    interval:  CFG.INTERVAL_SEC + 's',
    tp:        CFG.TP_ENABLED ? CFG.TP_TIERS.length + ' tiers' : 'off',
    sl:        CFG.SL_ENABLED ? CFG.SL_PCT + '%' : 'off',
    trailing:  CFG.TS_ENABLED ? CFG.TS_PCT + '%' : 'off',
    antiRug:   CFG.AR_ENABLED ? CFG.AR_PCT + '%' : 'off',
    reserve:   CFG.MIN_SOL_RESERVE + ' SOL',
    webhook:   CFG.WEBHOOK_URL ? CFG.WEBHOOK_TYPE : 'off',
  });

  const exit = () => { bot.persist(); log('info', 'Clean exit'); process.exit(0); };
  process.on('SIGINT',  exit);
  process.on('SIGTERM', exit);
  process.on('uncaughtException',  err => log('error', 'Uncaught exception',    { err: err.message }));
  process.on('unhandledRejection', r   => log('error', 'Unhandled rejection',   { reason: String(r).slice(0, 300) }));
}

main().catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
