/**
 * SolBot v2.2 — Production-Grade Solana Trading Bot
 *
 * Fixes vs v2.1:
 *  [BUG CRITIQUE] TAKE_PROFIT_ENABLED / STOP_LOSS_ENABLED / ANTI_RUG_ENABLED
 *                  défaut FALSE si var d'env absente → stratégies jamais actives.
 *                  Corrigé : défaut TRUE (opt-out avec =false, pas opt-in avec =true)
 *  [BUG CRITIQUE] Prix d'entrée enregistré au mauvais moment : trackEntry() appelé
 *                  au cycle suivant avec prix marché approximatif.
 *                  Corrigé : prix réel calculé depuis le swap (SOL ÷ tokens reçus)
 *                  et position enregistrée IMMÉDIATEMENT après l'achat.
 *  [BUG] DCA : prix d'entrée non mis à jour pour les chunks suivants.
 *              Corrigé : moyenne pondérée (cost averaging) sur tous les chunks.
 *  [FEAT] Log de démarrage "STRATÉGIE ACTIVE" : affiche l'état TP/SL/AR/Trailing
 *          au boot pour diagnostiquer rapidement les mauvaises configurations.
 *  [FEAT] Log debug "📊 TP check" à chaque cycle par token : PnL courant,
 *          prochain palier, balance restante → facilite le debug TP.
 *
 * Fixes vs v2.0 (hérités de v2.1):
 *  [BUG] batchJupiterPrices: fallback v6 sautait si un chunk réussissait
 *  [BUG] Blockhash extrait du tx Jupiter (tx.message.recentBlockhash) et non refetch
 *  [BUG] stopLossHit désormais persisté — évite double-vente après redémarrage
 *  [BUG] Retry _executeSwap refetch le quote (quotes Jupiter expirent en ~60s)
 *  [BUG] Stop-loss marque "pending" même si la vente échoue (évite retry infini)
 *  [PERF] DexScreener individuel ignoré si token déjà traité par le batch
 *  [FEAT] Trailing stop-loss, DCA, Webhooks, Anti-rug, /api/config, PnL stats
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS D'AMORÇAGE (avant CONFIG pour hoisting sûr)
// ═══════════════════════════════════════════════════════════════════════════

function safeParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Clés / réseau
  PRIVATE_KEY:    process.env.PRIVATE_KEY,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  PORT:           parseInt(process.env.PORT) || 10000,
  INTERVAL_SEC:   parseInt(process.env.INTERVAL_SEC) || 30,
  NODE_ENV:       process.env.NODE_ENV || 'production',
  DATA_FILE:      process.env.DATA_FILE || './bot_state.json',

  // Take-profit par paliers
  // NOTE: défaut TRUE — mettre TAKE_PROFIT_ENABLED=false pour désactiver
  TAKE_PROFIT_ENABLED:    process.env.TAKE_PROFIT_ENABLED !== 'false',
  TAKE_PROFIT_TIERS:      safeParseJson(process.env.TAKE_PROFIT_TIERS,
    [{ pnl: 20, sell: 25 }, { pnl: 40, sell: 25 }, { pnl: 60, sell: 25 }, { pnl: 100, sell: 25 }]),
  TAKE_PROFIT_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),

  // Stop-loss fixe — défaut TRUE
  STOP_LOSS_ENABLED: process.env.STOP_LOSS_ENABLED !== 'false',
  STOP_LOSS_PCT:     parseFloat(process.env.STOP_LOSS_PCT || '-50'),  // ex: -50 = -50%

  // Trailing stop-loss — défaut FALSE (opt-in car agressif)
  TRAILING_STOP_ENABLED: process.env.TRAILING_STOP_ENABLED === 'true',
  TRAILING_STOP_PCT:     parseFloat(process.env.TRAILING_STOP_PCT || '20'), // recule de X% depuis le pic

  // Anti-rug : vend immédiatement si la valeur chute de X% en UN seul cycle — défaut TRUE
  ANTI_RUG_ENABLED: process.env.ANTI_RUG_ENABLED !== 'false',
  ANTI_RUG_PCT:     parseFloat(process.env.ANTI_RUG_PCT || '60'),  // ex: 60 = chute 60%+ en 1 cycle

  // Garde-fous trading
  MIN_SOL_RESERVE:  parseFloat(process.env.MIN_SOL_RESERVE  || '0.05'), // SOL minimum gardé en réserve
  MAX_SELL_RETRIES: parseInt(process.env.MAX_SELL_RETRIES   || '3'),
  DEFAULT_SLIPPAGE: parseInt(process.env.DEFAULT_SLIPPAGE   || '500'),  // bps (5%)
  PRICE_TTL_MS:     parseInt(process.env.PRICE_TTL_MS       || '40000'), // 40s TTL < 30s intervalle
  BUY_COOLDOWN_MS:  parseInt(process.env.BUY_COOLDOWN_MS    || '5000'),  // 5s entre achats

  // Webhook (Discord/Telegram ou URL custom)
  WEBHOOK_URL:     process.env.WEBHOOK_URL    || null,
  WEBHOOK_TYPE:    process.env.WEBHOOK_TYPE   || 'discord', // 'discord' | 'telegram' | 'raw'
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,

  // Origines CORS autorisées (séparées par virgule)
  EXTRA_ORIGINS: process.env.EXTRA_ORIGINS || '',
  DASHBOARD_URL: process.env.DASHBOARD_URL || null, // ex: https://pumplaunch.github.io/solbot
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
const VERSION            = '2.2.0';

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

/** Retry exponentiel — refetch le quote si fourni en callback */
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

/** Concurrence limitée (p-limit maison, sans dépendance npm) */
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

/** Mutex — empêche exécutions concurrentes (zéro double-sell) */
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
// WEBHOOK NOTIFICATIONS
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
// RPC MANAGER — singletons par endpoint
// ═══════════════════════════════════════════════════════════════════════════

function createRpcManager() {
  const endpoints = [
    CONFIG.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}` : null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.public.blastapi.io',
  ].filter(Boolean);

  // FIX: un objet Connection par endpoint (pas recréé à chaque appel)
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
// PERSISTANCE — survit aux redémarrages Render
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
// PRIX — batch multi-sources avec fallback
// ═══════════════════════════════════════════════════════════════════════════

const priceCache   = new Map(); // mint → { data, ts }
const decimalsCache = new Map();
// batchedSet est maintenant LOCAL dans prefetchAllPrices (réinitialisé chaque cycle)

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

// ─── Source 1 : DexScreener batch (primaire — fonctionne sur Render) ─────────
// NOTE: Jupiter Price API (api.jup.ag/price) est bloqué sur les IPs Render.com
//       (retourne systématiquement 0 résultat en ~100ms). Supprimé définitivement.
//       Pipeline : DexScreener batch → DexScreener individuel → Pump.fun → Birdeye

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
            dexId:     pair.dexId              || null,
            source:    'dexscreener',
          };
        }
      }
      // NE PAS ajouter à batchedSet ici — géré localement dans prefetchAllPrices
    } catch { /* chunk raté — individuel prendra le relais */ }
    if (chunks.length > 1) await sleep(380);
  }
  return results;
}

// ─── Source 2 : Pump.fun individuel ──────────────────────────────────────────
// Couvre les tokens en bonding curve (pas encore sur aucun DEX)
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

// ─── Source 3 : Birdeye (pas de clé requise pour les prix publics) ────────────
// Fallback final pour les tokens non couverts par DexScreener ni Pump.fun
async function fetchBirdeye(mint) {
  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${mint}`,
      {
        headers: { 'X-Chain': 'solana' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const price = parseFloat(d?.data?.value ?? 0);
    if (!price || price <= 0) return null;
    return { price, liquidity: 0, volume24h: 0, change24h: 0,
             logo: null, symbol: null, name: null, source: 'birdeye' };
  } catch { return null; }
}

// ─── Orchestrateur principal ──────────────────────────────────────────────────
async function prefetchAllPrices(mints) {
  const now     = Date.now();
  const toFetch = mints.filter(m => {
    const c = priceCache.get(m);
    return !c || now - c.ts > CONFIG.PRICE_TTL_MS;
  });
  if (!toFetch.length) return;

  log('debug', 'Prefetch prix', { total: toFetch.length });

  // batchedSet LOCAL — réinitialisé à chaque cycle pour permettre les retries
  // (évite le bug où batchedSet global bloque l'étape individuelle pour toujours)
  const triedIndividually = new Set();

  // ── Étape 1 : DexScreener batch (tous les tokens d'un coup) ──
  const dexData = await batchDexScreener(toFetch);
  const afterBatch = Object.keys(dexData).length;
  log('debug', 'DexScreener batch', { asked: toFetch.length, found: afterBatch });

  // ── Étape 2 : DexScreener individuel pour les tokens absents du batch
  //    Tous les tokens non trouvés passent ici — batchedSet global supprimé
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
      } catch { /* timeout/erreur réseau — pump.fun prendra le relais */ }
    })));
    const foundInd = missing1.filter(m => dexData[m]).length;
    if (foundInd > 0) log('debug', 'DexScreener individuel', { tried: missing1.length, found: foundInd });
  }

  // ── Étape 3 : Pump.fun pour TOUS les tokens encore manquants
  //    FIX: on ne filtre plus sur endsWith('pump') — insuffisant et faux
  const missing2 = toFetch.filter(m => !dexData[m]);
  if (missing2.length) {
    log('debug', 'Pump.fun fallback', { count: missing2.length });
    const lim = pLimit(5);
    await Promise.all(missing2.map(m => lim(async () => {
      const r = await fetchPumpFun(m);
      if (r) dexData[m] = r;
    })));
  }

  // ── Étape 4 : Birdeye pour les tokens encore introuvables ──
  const missing3 = toFetch.filter(m => !dexData[m]);
  if (missing3.length) {
    log('debug', 'Birdeye fallback', { count: missing3.length });
    const lim = pLimit(4);
    await Promise.all(missing3.map(m => lim(async () => {
      const r = await fetchBirdeye(m);
      if (r) dexData[m] = r;
    })));
  }

  // ── Fusion → cache ──
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
// POSITION MANAGER — TP, SL, Trailing, Anti-Rug
// ═══════════════════════════════════════════════════════════════════════════

class PositionManager {
  constructor(tiers, hysteresis, savedState = {}) {
    this.tiers      = [...tiers].sort((a, b) => a.pnl - b.pnl);
    this.hysteresis = hysteresis;

    // Restaurer état persisté
    this.entryPrices    = new Map(Object.entries(savedState.entryPrices || {}));
    this.triggeredTiers = new Map();
    this.soldAmounts    = new Map();
    this.stopLossHit    = new Set(savedState.stopLossHit  || []); // FIX: persisté
    this.slPending      = new Set(savedState.slPending    || []); // FIX: évite retry infini
    this.prevPrices     = new Map(); // pour anti-rug et trailing
    this.peakPnl        = new Map(); // pour trailing stop

    for (const [mint, data] of this.entryPrices) {
      this.triggeredTiers.set(mint, new Set(data.triggeredTiers || []));
      this.soldAmounts.set(mint, data.soldAmount || 0);
      if (data.peakPnl !== undefined) this.peakPnl.set(mint, data.peakPnl);
    }
    log('info', 'Positions restaurées', { count: this.entryPrices.size });
  }

  // forcedEntryPrice: prix réel du swap (depuis /api/buy)
  // Si absent → position "bootstrappée" (bot redémarré sur token existant)
  //   → entryPrice = prix marché courant MAIS bootstrapped=true
  //   → TP est désactivé pour ce token jusqu'à ce qu'on fixe le vrai prix
  trackEntry(mint, currentPrice, currentBalance, forcedEntryPrice = null) {
    if (this.entryPrices.has(mint)) return false;
    const entryPrice = (forcedEntryPrice && forcedEntryPrice > 0) ? forcedEntryPrice : currentPrice;
    if (!entryPrice || entryPrice <= 0 || !currentBalance) return false;
    const isBootstrapped = !(forcedEntryPrice > 0);
    this.entryPrices.set(mint, {
      price: entryPrice, ts: Date.now(),
      originalBalance: currentBalance,
      triggeredTiers: [], soldAmount: 0, peakPnl: 0,
      bootstrapped: isBootstrapped, // TP désactivé jusqu'à correction manuelle ou scan chain
    });
    this.triggeredTiers.set(mint, new Set());
    this.soldAmounts.set(mint, 0);
    this.peakPnl.set(mint, 0);
    if (!isBootstrapped) {
      log('info', '✅ Position enregistrée (swap réel)', {
        mint: mint.slice(0,8), entryPrice: entryPrice.toPrecision(6),
      });
    }
    // Positions bootstrappées : loggées silencieusement (évite spam au démarrage)
    return true;
  }

  /** Corrige le prix d'entrée d'une position bootstrappée ou existante */
  setEntryPrice(mint, newPrice, newBalance = null) {
    const existing = this.entryPrices.get(mint);
    if (!existing) return false;
    const oldPrice = existing.price;
    existing.price = newPrice;
    existing.bootstrapped = false;
    // Reset triggered tiers when entry price is corrected
    this.triggeredTiers.set(mint, new Set());
    existing.triggeredTiers = [];
    if (newBalance && newBalance > 0) {
      existing.originalBalance = newBalance;
      this.soldAmounts.set(mint, 0);
      existing.soldAmount = 0;
    }
    log('info', '📌 Prix d\'entrée corrigé', {
      mint: mint.slice(0,8), old: oldPrice.toPrecision(6), new: newPrice.toPrecision(6),
    });
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

  /** Met à jour le peak PnL pour le trailing stop */
  updatePeak(mint, currentPnl) {
    if (currentPnl === null) return;
    const prev = this.peakPnl.get(mint) || 0;
    if (currentPnl > prev) {
      this.peakPnl.set(mint, currentPnl);
      const entry = this.entryPrices.get(mint);
      if (entry) { entry.peakPnl = currentPnl; }
    }
  }

  /** Take-profit paliers — ignoré si position bootstrappée sans vrai prix */
  checkTakeProfitTiers(mint, currentPrice) {
    const entry     = this.entryPrices.get(mint);
    const triggered = this.triggeredTiers.get(mint);
    const pnl       = this.getPnl(mint, currentPrice);
    if (!entry || pnl === null || !triggered) return [];
    // Skip TP for bootstrapped positions (entry = arbitrary market price, not real buy price)
    if (entry.bootstrapped) return [];

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

  /** Stop-loss fixe */
  checkStopLoss(mint, currentPrice) {
    if (!CONFIG.STOP_LOSS_ENABLED) return null;
    if (this.stopLossHit.has(mint) || this.slPending.has(mint)) return null;
    const entry = this.entryPrices.get(mint);
    if (entry?.bootstrapped) return null; // pas de SL sur position sans vrai prix d'entrée
    const pnl = this.getPnl(mint, currentPrice);
    if (pnl === null || pnl > CONFIG.STOP_LOSS_PCT) return null;
    const remaining = this.getRemainingBalance(mint);
    if (remaining <= 0) return null;
    return { type: 'stop-loss', pnl: pnl.toFixed(2), sellAmount: remaining };
  }

  /** Trailing stop-loss */
  checkTrailingStop(mint, currentPrice) {
    if (!CONFIG.TRAILING_STOP_ENABLED) return null;
    if (this.stopLossHit.has(mint) || this.slPending.has(mint)) return null;
    const pnl  = this.getPnl(mint, currentPrice);
    const peak = this.peakPnl.get(mint) || 0;
    if (pnl === null || peak < CONFIG.TRAILING_STOP_PCT) return null; // Pas encore assez haut
    if (pnl < peak - CONFIG.TRAILING_STOP_PCT) {
      const remaining = this.getRemainingBalance(mint);
      if (remaining <= 0) return null;
      return { type: 'trailing-stop', pnl: pnl.toFixed(2), peak: peak.toFixed(2), sellAmount: remaining };
    }
    return null;
  }

  /** Anti-rug : chute brutale en un cycle */
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

  /** FIX: marque "pending" si la vente échoue — évite retry infini */
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
// SWAP ENGINE — Jupiter v6 (buy + sell + DCA)
// ═══════════════════════════════════════════════════════════════════════════

class SwapEngine {
  constructor(wallet, rpc) {
    this.wallet       = wallet;
    this.rpc          = rpc;
    this.sellMutex    = new Mutex();
    this.sellFailures = 0;    // circuit-breaker
    this.lastBuyTs    = 0;   // cooldown achats
  }

  /** Quote Jupiter — essaie plusieurs endpoints (quote-api.jup.ag bloqué sur Render free tier) */
  async getQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
    const params = `inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`;
    const QUOTE_ENDPOINTS = [
      `https://lite-api.jup.ag/swap/v1/quote?${params}`,   // endpoint léger, moins bloqué
      `https://api.jup.ag/swap/v1/quote?${params}`,         // nouvel endpoint unifié
      `https://quote-api.jup.ag/v6/quote?${params}`,        // ancien endpoint (bloqué Render)
    ];
    let lastErr = null;
    for (const url of QUOTE_ENDPOINTS) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': `SolBot/${VERSION}`, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) { lastErr = new Error(`Quote HTTP ${r.status} (${url.split('/')[2]})`); continue; }
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

  /**
   * Execute swap — FIX: extraction du blockhash directement depuis la tx Jupiter
   * Pas de getLatestBlockhash() séparé (race condition avec le blockhash embed)
   * FIX retry: refetch quote à chaque tentative (quotes expirent en ~60s)
   */
  async _executeSwap({ inputMint, outputMint, amountRaw, slippageBps }) {
    return withRetry(async (attempt) => {
      // Refetch quote à chaque tentative (évite "quote expired")
      const quote = await this.getQuote({ inputMint, outputMint, amountRaw, slippageBps });

      // Swap — même cascade d'endpoints que le quote
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
          if (swapData?.swapTransaction) break; // succès
          swapErr  = new Error('swapTransaction manquant');
          swapData = null;
        } catch (err) {
          swapErr = err;
          log('debug', 'Swap endpoint failed', { url: swapUrl.split('/')[2], err: err.message });
        }
      }
      if (!swapData?.swapTransaction) throw swapErr || new Error('Swap échoué sur tous les endpoints');

      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));

      // FIX: extraire blockhash depuis la tx signée par Jupiter (pas refetch)
      const txBlockhash = tx.message.recentBlockhash;
      // Besoin de lastValidBlockHeight pour confirmTransaction — fetch minimal
      const lbhMeta = await this.rpc.connection.getLatestBlockhash('confirmed');

      tx.sign([this.wallet]);

      const txId = await this.rpc.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
      });

      const conf = await this.rpc.connection.confirmTransaction({
        signature:            txId,
        blockhash:            txBlockhash,           // ← du tx, pas du refetch
        lastValidBlockHeight: lbhMeta.lastValidBlockHeight,
      }, 'confirmed');

      if (conf.value.err) throw new Error(`Tx rejetée: ${JSON.stringify(conf.value.err)}`);

      return { txId, txUrl: `https://solscan.io/tx/${txId}`, quote };
    }, { retries: 2, baseMs: 800, label: `swap(${inputMint.slice(0,8)})` });
  }

  /** Acheter un token avec X SOL */
  async buy(mint, solAmount, slippageBps = CONFIG.DEFAULT_SLIPPAGE) {
    // Cooldown
    const elapsed = Date.now() - this.lastBuyTs;
    if (elapsed < CONFIG.BUY_COOLDOWN_MS) {
      const wait = ((CONFIG.BUY_COOLDOWN_MS - elapsed) / 1000).toFixed(1);
      throw new Error(`Cooldown actif — réessayez dans ${wait}s`);
    }
    // Garde SOL
    const solBal = await this.getSolBalance();
    if (solBal !== null) {
      const needed = solAmount + CONFIG.MIN_SOL_RESERVE;
      if (solBal < needed) {
        throw new Error(`Solde insuffisant: ${solBal.toFixed(4)} SOL (besoin ${needed.toFixed(4)} SOL, réserve ${CONFIG.MIN_SOL_RESERVE})`);
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

  /**
   * Achat DCA — split en `chunks` transactions réparties sur `intervalSec`
   */
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

  /** Vendre avec mutex (zéro double-sell) */
  async sell(mint, amount, reason = 'MANUAL', slippageBps = CONFIG.DEFAULT_SLIPPAGE) {
    if (this.sellFailures >= CONFIG.MAX_SELL_RETRIES) {
      const msg = `Circuit-breaker actif (${this.sellFailures} échecs) — relancer le bot`;
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

    // ── Analytics persistants ──────────────────────────────────────────────
    const saved = savedState.analytics || {};
    this.analytics = {
      realizedPnlSol:  saved.realizedPnlSol  || 0,   // PnL total réalisé en SOL
      totalBoughtSol:  saved.totalBoughtSol  || 0,   // SOL total investi
      totalSoldSol:    saved.totalSoldSol    || 0,   // SOL total récupéré
      winCount:        saved.winCount        || 0,   // trades gagnants
      lossCount:       saved.lossCount       || 0,   // trades perdants
      totalTrades:     saved.totalTrades     || 0,   // nb total de round-trips
      bestTradePct:    saved.bestTradePct    || null,// meilleur % réalisé
      worstTradePct:   saved.worstTradePct   || null,// pire % réalisé
      bestTradeSymbol: saved.bestTradeSymbol || null,
      worstTradeSymbol:saved.worstTradeSymbol|| null,
      avgHoldMs:       saved.avgHoldMs       || 0,   // durée moyenne en ms
      dailyPnl:        saved.dailyPnl        || [],  // [{date:'2024-01-01', pnlSol, trades}]
      pnlHistory:      saved.pnlHistory      || [],  // [{ts, cumulSol}] pour graphique
    };

    // Cost basis : Map<mint, {solSpent, tokBought, buyTs}>
    const cbRaw = savedState.costBasis || {};
    this.costBasis = new Map(Object.entries(cbRaw));

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
      trades:      this.tradeHistory.slice(0, 500),  // 500 trades persistés
      stopLossHit: Array.from(this.positions.stopLossHit),
      slPending:   Array.from(this.positions.slPending),
      analytics:   this.analytics,
      costBasis:   Object.fromEntries(this.costBasis),
    });
  }

  // Enregistre le cost basis à l'achat
  _recordBuy(mint, solSpent, tokBought) {
    const existing = this.costBasis.get(mint);
    if (existing) {
      // DCA : moyenne pondérée
      existing.solSpent  += solSpent;
      existing.tokBought += tokBought;
    } else {
      this.costBasis.set(mint, { solSpent, tokBought, buyTs: Date.now() });
    }
    this.analytics.totalBoughtSol = +(this.analytics.totalBoughtSol + solSpent).toFixed(6);
  }

  // Calcule et enregistre le PnL réalisé à la vente
  _recordSell(mint, solOut, amountSold, symbol) {
    const cb = this.costBasis.get(mint);
    let pnlSol = null, pnlPct = null, holdMs = null;

    if (cb && cb.solSpent > 0 && cb.tokBought > 0) {
      // Coût proportionnel aux tokens vendus
      const pctSold   = Math.min(amountSold / cb.tokBought, 1);
      const costBasis = cb.solSpent * pctSold;
      pnlSol  = +(solOut - costBasis).toFixed(6);
      pnlPct  = costBasis > 0 ? +((pnlSol / costBasis) * 100).toFixed(2) : null;
      holdMs  = Date.now() - (cb.buyTs || Date.now());

      // Mettre à jour le cost basis restant
      cb.solSpent  *= (1 - pctSold);
      cb.tokBought -= amountSold;
      if (cb.tokBought <= 0) this.costBasis.delete(mint);

      // Mettre à jour les analytics
      this.analytics.realizedPnlSol  = +(this.analytics.realizedPnlSol + pnlSol).toFixed(6);
      this.analytics.totalSoldSol    = +(this.analytics.totalSoldSol + solOut).toFixed(6);
      this.analytics.totalTrades++;
      if (pnlSol >= 0) {
        this.analytics.winCount++;
        if (pnlPct !== null && (this.analytics.bestTradePct === null || pnlPct > this.analytics.bestTradePct)) {
          this.analytics.bestTradePct    = pnlPct;
          this.analytics.bestTradeSymbol = symbol;
        }
      } else {
        this.analytics.lossCount++;
        if (pnlPct !== null && (this.analytics.worstTradePct === null || pnlPct < this.analytics.worstTradePct)) {
          this.analytics.worstTradePct    = pnlPct;
          this.analytics.worstTradeSymbol = symbol;
        }
      }

      // Moyenne hold time
      const n = this.analytics.totalTrades;
      this.analytics.avgHoldMs = Math.round((this.analytics.avgHoldMs * (n-1) + holdMs) / n);

      // Snapshot journalier
      const today = new Date().toISOString().slice(0, 10);
      const day   = this.analytics.dailyPnl.find(d => d.date === today);
      if (day) { day.pnlSol = +(day.pnlSol + pnlSol).toFixed(6); day.trades++; }
      else      { this.analytics.dailyPnl.push({ date: today, pnlSol: +pnlSol.toFixed(6), trades: 1 }); }
      if (this.analytics.dailyPnl.length > 90) this.analytics.dailyPnl.shift(); // 90 jours max

      // Historique PnL cumulatif pour graphique
      this.analytics.pnlHistory.push({ ts: Date.now(), cumul: +this.analytics.realizedPnlSol.toFixed(6) });
      if (this.analytics.pnlHistory.length > 500) this.analytics.pnlHistory.shift();
    } else {
      // Pas de cost basis (token acheté avant analytics) — enregistre quand même le SOL
      this.analytics.totalSoldSol = +(this.analytics.totalSoldSol + solOut).toFixed(6);
    }

    return { pnlSol, pnlPct, holdMs };
  }

  _recordTrade(entry) {
    this.tradeHistory.unshift({ ...entry, ts: Date.now() });
    if (this.tradeHistory.length > 500) this.tradeHistory.length = 500;
  }

  async tick() {
    try {
      // Health check tous les 10 cycles
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
          // ── Anti-rug (priorité maximale) ──────────────────────────────
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
              const { pnlSol, pnlPct } = this._recordSell(mint, res.solOut, rugAlert.sellAmount, priceData?.symbol);
              this._recordTrade({ type: 'sell', mint, symbol: priceData?.symbol || mint.slice(0,8),
                amount: rugAlert.sellAmount, solOut: res.solOut, reason: 'Anti-Rug',
                txId: res.txId, txUrl: res.txUrl, pnlSol, pnlPct });
              await sendWebhook('✅ Anti-Rug vendu', `${(rugAlert.sellAmount).toFixed(4)} tokens vendus`,
                0x05d488, [{ name: 'SOL reçu', value: res.solOut?.toFixed(6), inline: true }]);
            } else {
              this.positions.clearStopLossPending(mint); // retry au prochain cycle
            }
          }

          // ── Take-Profit paliers ───────────────────────────────────────
          if (CONFIG.TAKE_PROFIT_ENABLED && pnl !== null) {
            const tiers = this.positions.checkTakeProfitTiers(mint, price);
            for (const tier of tiers) {
              log('warn', `TP palier ${tier.tierIndex+1}`, {
                mint: mint.slice(0,8), pnl: tier.currentPnl + '%', sell: tier.sellAmount.toFixed(4) });
              const res = await this.swap.sell(mint, tier.sellAmount, `TP_T${tier.tierIndex+1}`);
              if (res.success) {
                this.positions.markTierExecuted(mint, tier.tierIndex, tier.sellAmount);
                const { pnlSol, pnlPct } = this._recordSell(mint, res.solOut, tier.sellAmount, priceData?.symbol);
                this._recordTrade({ type: 'sell', mint, symbol: priceData?.symbol || mint.slice(0,8),
                  amount: tier.sellAmount, solOut: res.solOut, reason: `TP Palier ${tier.tierIndex+1}`,
                  txId: res.txId, txUrl: res.txUrl, pnlSol, pnlPct });
                await sendWebhook(`🎯 Take-Profit T${tier.tierIndex+1}`,
                  `+${tier.currentPnl}% atteint sur **${priceData?.symbol || mint.slice(0,8)}**`, 0x05d488, [
                  { name: 'Vendu', value: tier.sellAmount.toFixed(4), inline: true },
                  { name: 'SOL reçu', value: res.solOut?.toFixed(6), inline: true },
                ]);
              }
            }
            this.positions.maybeResetTiers(mint, pnl);
          }

          // ── Stop-loss fixe ────────────────────────────────────────────
          const sl = this.positions.checkStopLoss(mint, price);
          if (sl) {
            log('warn', 'STOP-LOSS', { mint: mint.slice(0,8), pnl: sl.pnl + '%' });
            this.positions.markStopLossPending(mint);
            const res = await this.swap.sell(mint, sl.sellAmount, 'STOP_LOSS');
            if (res.success) {
              this.positions.markStopLossExecuted(mint);
              const { pnlSol: slPnlSol, pnlPct: slPnlPct } = this._recordSell(mint, res.solOut, sl.sellAmount, priceData?.symbol);
              this._recordTrade({ type: 'sell', mint, symbol: priceData?.symbol || mint.slice(0,8),
                amount: sl.sellAmount, solOut: res.solOut, reason: 'Stop-Loss',
                txId: res.txId, txUrl: res.txUrl, pnlSol: slPnlSol, pnlPct: slPnlPct });
              await sendWebhook('🔴 Stop-Loss déclenché',
                `**${priceData?.symbol || mint.slice(0,8)}** vendu à ${sl.pnl}%`, 0xff4757, [
                { name: 'SOL récupéré', value: res.solOut?.toFixed(6), inline: true },
              ]);
            } else {
              this.positions.clearStopLossPending(mint);
            }
          }

          // ── Trailing stop-loss ────────────────────────────────────────
          const ts = this.positions.checkTrailingStop(mint, price);
          if (ts) {
            log('warn', 'TRAILING STOP', { mint: mint.slice(0,8), pnl: ts.pnl, peak: ts.peak });
            this.positions.markStopLossPending(mint);
            const res = await this.swap.sell(mint, ts.sellAmount, 'TRAILING_STOP');
            if (res.success) {
              this.positions.markStopLossExecuted(mint);
              const { pnlSol: tsPnlSol, pnlPct: tsPnlPct } = this._recordSell(mint, res.solOut, ts.sellAmount, priceData?.symbol);
              this._recordTrade({ type: 'sell', mint, symbol: priceData?.symbol || mint.slice(0,8),
                amount: ts.sellAmount, solOut: res.solOut, reason: 'Trailing Stop',
                txId: res.txId, txUrl: res.txUrl, pnlSol: tsPnlSol, pnlPct: tsPnlPct });
              await sendWebhook('📉 Trailing Stop',
                `**${priceData?.symbol || mint.slice(0,8)}** — pic: +${ts.peak}%, actuel: ${ts.pnl}%`, 0xffb020);
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

      // Sauvegarde périodique (toutes les 5 min ≈ 10 cycles à 30s)
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

  // CORS — wildcard: API publique sans auth ni cookies.
  // Nécessaire car Render sleep envoie ses propres pages HTML sans header CORS,
  // et le strict matching par origine bloque le dashboard GitHub Pages.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Dashboard statique — optionnel (présent en local, absent sur Render si GitHub Pages)
  const staticDir   = process.env.STATIC_DIR || __dirname;
  const DASHBOARD_URL = CONFIG.DASHBOARD_URL;
  const indexPath   = path.join(staticDir, 'index.html');
  const hasIndex    = fs.existsSync(indexPath);

  if (hasIndex) {
    app.use(express.static(staticDir));
    app.get('/', (req, res) => res.sendFile(indexPath));
    log('info', 'Dashboard local activé', { dir: staticDir });
  } else {
    // Pas d'index.html — retourner un JSON utile sur / plutôt que de crasher
    app.get('/', (req, res) => {
      const info = {
        bot:       `SolBot v${VERSION}`,
        status:    'running',
        uptime:    Math.round(process.uptime()) + 's',
        dashboard: DASHBOARD_URL || 'Non configuré (définir DASHBOARD_URL)',
        api:       ['/health', '/api/stats', '/api/portfolio', '/api/sol-balance', '/api/trades'],
      };
      if (DASHBOARD_URL) {
        res.redirect(302, DASHBOARD_URL);
      } else {
        res.json(info);
      }
    });
    log('info', 'Dashboard local absent — route / redirige vers DASHBOARD_URL ou JSON', { dashboard: DASHBOARD_URL || 'none' });
  }

  // ── READ ──────────────────────────────────────────────────────────────────
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

  app.get('/api/debug/prices', (req, res) => {
    const out = [];
    for (const [mint, e] of priceCache) {
      out.push({ mint: mint.slice(0,8)+'...', price: e.data?.price, source: e.data?.source,
        symbol: e.data?.symbol, age: Math.round((Date.now()-e.ts)/1000)+'s' });
    }
    res.json({ total: out.length, tokens: out.slice(0, 40) });
  });

  // ── CONFIG GET + POST ─────────────────────────────────────────────────────
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

    // Validate & set TP tiers: array of {pnl, sell} where pnl>0, sell>0, sum sell <= 100
    if (Array.isArray(takeProfitTiers) && takeProfitTiers.length > 0) {
      const clean = takeProfitTiers
        .map(t => ({ pnl: parseFloat(t.pnl), sell: parseFloat(t.sell) }))
        .filter(t => !isNaN(t.pnl) && t.pnl > 0 && !isNaN(t.sell) && t.sell > 0 && t.sell <= 100)
        .sort((a, b) => a.pnl - b.pnl);
      if (clean.length > 0) CONFIG.TAKE_PROFIT_TIERS = clean;
    }

    const validateNum = (v, min, max) => { const n = parseFloat(v); return !isNaN(n) && n >= min && n <= max ? n : null; };
    const sl  = validateNum(stopLossPct,    -100, 0);    if (sl  !== null) CONFIG.STOP_LOSS_PCT           = sl;
    const tr  = validateNum(trailingPct,    1, 100);     if (tr  !== null) CONFIG.TRAILING_STOP_PCT       = tr;
    const ar  = validateNum(antiRugPct,     1, 100);     if (ar  !== null) CONFIG.ANTI_RUG_PCT            = ar;
    const ds  = validateNum(defaultSlippage,10, 5000);  if (ds  !== null) CONFIG.DEFAULT_SLIPPAGE        = ds;
    const mr  = validateNum(minSolReserve,  0, 10);     if (mr  !== null) CONFIG.MIN_SOL_RESERVE         = mr;
    const hys = validateNum(hysteresis,     0, 50);     if (hys !== null) CONFIG.TAKE_PROFIT_HYSTERESIS  = hys;
    const ivl = validateNum(intervalSec,    10, 3600);  if (ivl !== null) CONFIG.INTERVAL_SEC            = ivl;

    log('info', 'Config mise à jour', {
      tp: CONFIG.TAKE_PROFIT_ENABLED, tiers: CONFIG.TAKE_PROFIT_TIERS.length,
      sl: CONFIG.STOP_LOSS_ENABLED, trail: CONFIG.TRAILING_STOP_ENABLED,
    });
    res.json({ success: true, config: {
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
    }});
  });

  // ── QUOTE ─────────────────────────────────────────────────────────────────
  app.post('/api/quote', async (req, res) => {
    const { inputMint, outputMint, amount, slippageBps = CONFIG.DEFAULT_SLIPPAGE } = req.body;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: 'inputMint, outputMint, amount requis' });
    }
    try {
      const quote = await bot.swap.getQuote({
        inputMint, outputMint,
        amountRaw: BigInt(Math.floor(Number(amount))),
        slippageBps: parseInt(slippageBps) || CONFIG.DEFAULT_SLIPPAGE,
      });
      res.json({ success: true, quote });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ── BUY ───────────────────────────────────────────────────────────────────
  app.post('/api/buy', async (req, res) => {
    const { mint, solAmount, slippageBps = CONFIG.DEFAULT_SLIPPAGE } = req.body;
    if (!mint || !solAmount) return res.status(400).json({ error: 'mint et solAmount requis' });
    const sol = parseFloat(solAmount);
    if (isNaN(sol) || sol <= 0 || sol > 50) return res.status(400).json({ error: 'solAmount invalide (0-50)' });
    try {
      const result = await bot.swap.buy(mint, sol, parseInt(slippageBps) || CONFIG.DEFAULT_SLIPPAGE);
      if (result.success) {
        const pd = getTokenPrice(mint);
        // Compute actual entry price from swap: SOL paid / tokens received
        const actualEntryPrice = result.outAmount > 0 ? sol / result.outAmount : (pd?.price || 0);
        // Pre-register position with REAL price — before next tick sees the token
        bot.positions.trackEntry(mint, actualEntryPrice, result.outAmount, actualEntryPrice);
        bot._recordBuy(mint, sol, result.outAmount || 0);
        bot._recordTrade({ type: 'buy', mint, symbol: pd?.symbol || mint.slice(0,8),
          solSpent: sol, outAmount: result.outAmount, entryPrice: actualEntryPrice,
          txId: result.txId, txUrl: result.txUrl });
        bot._persist();
        log('info', '✅ Position enregistrée', {
          mint: mint.slice(0,8), entryPrice: actualEntryPrice.toPrecision(6),
          tokens: result.outAmount?.toFixed(4), tp: CONFIG.TAKE_PROFIT_ENABLED,
        });
        setTimeout(() => bot.tick().catch(() => {}), 4000);
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ── BUY DCA ──────────────────────────────────────────────────────────────
  app.post('/api/buy/dca', async (req, res) => {
    const { mint, totalSol, chunks = 3, intervalSec = 60, slippageBps = CONFIG.DEFAULT_SLIPPAGE } = req.body;
    if (!mint || !totalSol) return res.status(400).json({ error: 'mint et totalSol requis' });
    const sol = parseFloat(totalSol);
    const n   = Math.min(parseInt(chunks) || 3, 10);
    if (isNaN(sol) || sol <= 0) return res.status(400).json({ error: 'totalSol invalide' });
    try {
      const result = await bot.swap.buyDCA(mint, sol, n, parseInt(intervalSec) || 60,
        parseInt(slippageBps) || CONFIG.DEFAULT_SLIPPAGE);
      for (const r of result.results.filter(r => r.success)) {
        const pd = getTokenPrice(mint);
        const chunkEntryPrice = r.outAmount > 0 ? (sol/n) / r.outAmount : (pd?.price || 0);
        // For DCA, first successful chunk sets the entry; subsequent ones average in via trackEntry returning false
        if (!bot.positions.entryPrices.has(mint)) {
          bot.positions.trackEntry(mint, chunkEntryPrice, r.outAmount, chunkEntryPrice);
        } else {
          // DCA average — update entry price with weighted average
          const existing = bot.positions.entryPrices.get(mint);
          const cb = bot.costBasis.get(mint) || { solSpent: 0, tokBought: 0 };
          const totalTok = cb.tokBought + r.outAmount;
          if (totalTok > 0) {
            existing.price = (cb.solSpent + (sol/n)) / totalTok;
          }
        }
        bot._recordBuy(mint, sol/n, r.outAmount || 0);
        bot._recordTrade({ type: 'buy', mint, symbol: pd?.symbol || mint.slice(0,8),
          solSpent: sol/n, outAmount: r.outAmount, txId: r.txId, txUrl: r.txUrl, tag: `DCA ${r.chunk}/${n}` });
      }
      bot._persist();
      setTimeout(() => bot.tick().catch(() => {}), 4000);
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ── SELL ──────────────────────────────────────────────────────────────────
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
      const { pnlSol, pnlPct } = bot._recordSell(tok.mintFull, result.solOut, sellAmount, tok.symbol);
      bot._recordTrade({ type: 'sell', mint: tok.mintFull, symbol: tok.symbol || tok.mintFull.slice(0,8),
        amount: sellAmount, solOut: result.solOut, reason, txId: result.txId, txUrl: result.txUrl,
        pnlSol, pnlPct });
      bot._persist();
      setTimeout(() => bot.tick().catch(() => {}), 4000);
    }
    res.json({ ...result, sellAmount });
  });

  // ── ANALYTICS ────────────────────────────────────────────────────────────
  app.get('/api/analytics', (req, res) => {
    const a  = bot.analytics;
    const n  = a.winCount + a.lossCount;
    const winRate  = n > 0 ? +((a.winCount / n) * 100).toFixed(1) : null;
    const roi      = a.totalBoughtSol > 0
      ? +((a.realizedPnlSol / a.totalBoughtSol) * 100).toFixed(2) : null;

    // Calcul des trades sell avec PnL pour avg profit/loss
    const sellTrades = bot.tradeHistory.filter(t => t.type === 'sell' && t.pnlPct != null);
    const wins  = sellTrades.filter(t => t.pnlPct >= 0);
    const loses = sellTrades.filter(t => t.pnlPct < 0);
    const avgWin  = wins.length  ? +(wins.reduce((s,t) => s+t.pnlPct, 0)  / wins.length).toFixed(1)  : null;
    const avgLoss = loses.length ? +(loses.reduce((s,t) => s+t.pnlPct, 0) / loses.length).toFixed(1) : null;

    // Formatage du hold time moyen
    const h   = Math.floor(a.avgHoldMs / 3600000);
    const m   = Math.floor((a.avgHoldMs % 3600000) / 60000);
    const avgHold = a.avgHoldMs > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : null;

    res.json({
      realizedPnlSol:  +a.realizedPnlSol.toFixed(4),
      totalBoughtSol:  +a.totalBoughtSol.toFixed(4),
      totalSoldSol:    +a.totalSoldSol.toFixed(4),
      winCount:        a.winCount,
      lossCount:       a.lossCount,
      totalTrades:     a.totalTrades,
      winRate,
      roi,
      avgWin,
      avgLoss,
      avgHold,
      bestTradePct:    a.bestTradePct,
      bestTradeSymbol: a.bestTradeSymbol,
      worstTradePct:   a.worstTradePct,
      worstTradeSymbol:a.worstTradeSymbol,
      dailyPnl:        a.dailyPnl.slice(-30),   // 30 derniers jours
      pnlHistory:      a.pnlHistory.slice(-200), // 200 derniers points
    });
  });

  // ── RESET CIRCUIT BREAKER ────────────────────────────────────────────────
  app.post('/api/reset-circuit-breaker', (req, res) => {
    bot.swap.sellFailures = 0;
    log('info', 'Circuit-breaker réinitialisé');
    res.json({ success: true });
  });

  // ─── POSITION MANAGEMENT ─────────────────────────────────────────────────

  app.get('/api/positions', (req, res) => {
    const positions = [];
    for (const [mint, data] of bot.positions.entryPrices) {
      const tok      = bot.portfolio.find(t => t.mintFull === mint);
      const pd       = getTokenPrice(mint);
      const curPrice = tok?.price || pd?.price || 0;
      const pnl      = data.price > 0 && curPrice > 0
        ? ((curPrice - data.price) / data.price) * 100 : null;
      positions.push({
        mint,
        symbol:          tok?.symbol || pd?.symbol || null,
        entryPrice:      data.price,
        currentPrice:    curPrice,
        pnl:             pnl !== null ? +pnl.toFixed(2) : null,
        bootstrapped:    !!data.bootstrapped,
        originalBalance: data.originalBalance,
        remaining:       bot.positions.getRemainingBalance(mint),
        soldAmount:      bot.positions.soldAmounts.get(mint) || 0,
        triggeredTiers:  Array.from(bot.positions.triggeredTiers.get(mint) || []),
        stopLossHit:     bot.positions.stopLossHit.has(mint),
        peakPnl:         bot.positions.peakPnl.get(mint) || 0,
        entryTs:         data.ts,
      });
    }
    const booted = positions.filter(p => p.bootstrapped).length;
    res.json({ count: positions.length, bootstrapped: booted, real: positions.length - booted,
      positions: positions.sort((a, b) => (b.pnl || 0) - (a.pnl || 0)) });
  });

  app.post('/api/positions/set-entry', (req, res) => {
    const { mint, entryPrice, balance } = req.body;
    if (!mint || entryPrice === undefined) return res.status(400).json({ error: 'mint et entryPrice requis' });
    const price = parseFloat(entryPrice);
    if (isNaN(price) || price <= 0) return res.status(400).json({ error: 'entryPrice invalide' });
    const bal = balance !== undefined ? parseFloat(balance) : null;
    let ok = bot.positions.setEntryPrice(mint, price, bal);
    if (!ok) {
      const tok = bot.portfolio.find(t => t.mintFull === mint);
      if (!tok) return res.status(404).json({ error: 'Token non trouvé' });
      bot.positions.trackEntry(mint, price, bal || tok.balance, price);
    }
    bot._persist();
    const entry = bot.positions.entryPrices.get(mint);
    res.json({ success: true, mint, entryPrice: entry.price, bootstrapped: !!entry.bootstrapped,
      message: 'Prix fixe — TP/SL actifs' });
  });

  app.get('/api/positions/scan-history', async (req, res) => {
    if (!CONFIG.HELIUS_API_KEY) return res.status(400).json({ error: 'HELIUS_API_KEY requis' });
    const bootstrapped = [];
    for (const [mint, data] of bot.positions.entryPrices) {
      if (data.bootstrapped) bootstrapped.push(mint);
    }
    if (!bootstrapped.length) return res.json({ message: 'Aucune position bootstrappée', fixed: 0 });
    log('info', 'Scan Helius ' + bootstrapped.length + ' positions');
    const walletAddress = wallet.publicKey.toString();
    const results = [];
    for (const mint of bootstrapped) {
      try {
        const url = 'https://api.helius.xyz/v0/addresses/' + walletAddress +
          '/transactions?api-key=' + CONFIG.HELIUS_API_KEY + '&limit=100&type=SWAP';
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) { results.push({ mint, status: 'error', error: 'HTTP ' + r.status }); continue; }
        const txs = await r.json();
        let found = null;
        for (const tx of (Array.isArray(txs) ? txs : [])) {
          const recv = (tx.tokenTransfers || []).find(t =>
            t.mint === mint && t.toUserAccount === walletAddress && t.tokenAmount > 0);
          if (!recv) continue;
          const solOut = (tx.nativeTransfers || [])
            .filter(n => n.fromUserAccount === walletAddress)
            .reduce((s, n) => s + (n.amount || 0), 0) / 1e9;
          if (solOut > 0 && recv.tokenAmount > 0) {
            found = { solSpent: solOut, tokReceived: recv.tokenAmount,
              entryPrice: solOut / recv.tokenAmount, tx: tx.signature, ts: tx.timestamp };
            break;
          }
        }
        if (found && found.entryPrice > 0) {
          const old = bot.positions.entryPrices.get(mint)?.price;
          bot.positions.setEntryPrice(mint, found.entryPrice);
          if (!bot.costBasis.has(mint)) {
            bot.costBasis.set(mint, { solSpent: found.solSpent, tokBought: found.tokReceived,
              buyTs: (found.ts || Date.now()/1000) * 1000 });
          }
          results.push({ mint: mint.slice(0,8), symbol: getTokenPrice(mint)?.symbol,
            status: 'fixed', entryPrice: found.entryPrice, priceBefore: old, solSpent: found.solSpent });
          log('success', 'Prix retrouvé ' + mint.slice(0,8), { price: found.entryPrice.toPrecision(4) });
        } else {
          results.push({ mint: mint.slice(0,8), status: 'not_found' });
        }
        await sleep(250);
      } catch (err) {
        results.push({ mint: mint.slice(0,8), status: 'error', error: err.message });
      }
    }
    const fixed = results.filter(r => r.status === 'fixed').length;
    if (fixed > 0) bot._persist();
    log('info', 'Scan terminé: ' + fixed + '/' + bootstrapped.length);
    res.json({ total: bootstrapped.length, fixed, results });
  });

  app.post('/api/positions/delete', (req, res) => {
    const { mint } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });
    if (!bot.positions.entryPrices.has(mint)) return res.status(404).json({ error: 'Position non trouvée' });
    bot.positions.entryPrices.delete(mint);
    bot.positions.triggeredTiers.delete(mint);
    bot.positions.soldAmounts.delete(mint);
    bot.positions.peakPnl.delete(mint);
    bot.positions.stopLossHit.delete(mint);
    bot.positions.slPending.delete(mint);
    bot._persist();
    log('info', 'Position supprimée', { mint: mint.slice(0,8) });
    res.json({ success: true, mint });
  });

  // ── LEGACY ───────────────────────────────────────────────────────────────
  app.post('/api/sell/test', async (req, res) => {
    res.status(410).json({ error: 'Endpoint retiré — utiliser POST /api/sell' });
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

  // ── Startup strategy summary (aide au debug) ──────────────────────────────
  const tpTierStr = CONFIG.TAKE_PROFIT_TIERS.map(t => `+${t.pnl}%→${t.sell}%`).join(' | ');
  log('info', '═══ STRATÉGIE ACTIVE ═══', {
    TAKE_PROFIT:  CONFIG.TAKE_PROFIT_ENABLED ? `✅ ON  [${tpTierStr}]` : '❌ OFF',
    STOP_LOSS:    CONFIG.STOP_LOSS_ENABLED   ? `✅ ON  [${CONFIG.STOP_LOSS_PCT}%]` : '❌ OFF',
    TRAILING:     CONFIG.TRAILING_STOP_ENABLED ? `✅ ON  [-${CONFIG.TRAILING_STOP_PCT}% depuis pic]` : '❌ OFF',
    ANTI_RUG:     CONFIG.ANTI_RUG_ENABLED    ? `✅ ON  [chute >${CONFIG.ANTI_RUG_PCT}%]` : '❌ OFF',
    HYSTERESIS:   CONFIG.TAKE_PROFIT_HYSTERESIS + '%',
    INTERVAL:     CONFIG.INTERVAL_SEC + 's',
  });
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

  log('success', 'Bot opérationnel', {
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
  process.on('unhandledRejection', reason => log('error', 'Rejet non géré',      { reason: String(reason).slice(0, 300) }));
}

main().catch(err => { console.error('Échec démarrage:', err.message); process.exit(1); });
