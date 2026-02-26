// ═══════════════════════════════════════════════════════════════
// SolBot Pro v3.8 — Production Ultimate Edition
// Backend Node.js pour Solana Trading Automatique
// Hébergement : Render (Background Worker + API Web)
// Profil : Agressif/Équilibré — Maximiser gains avec protection robuste
// Features: Anti-loop protection + Weighted Price + Smart Cache + Strategies + Monitoring + Health Checks
// ═══════════════════════════════════════════════════════════════

"use strict";

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = require("@solana/web3.js");

// node-fetch v3 est un module ESM — on l'importe dynamiquement
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

// ── Variables d'environnement ────────────────────────────────────
const PRIVATE_KEY_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "https://mainnet.helius-rpc.com";
const API_AUTH_KEY = process.env.API_AUTH_KEY || null; // Optionnel: clé pour sécuriser les endpoints POST/DELETE

// ── Configuration de base du bot ─────────────────────────────────
const CONFIG = {
  TOKEN_MINT: process.env.TOKEN_MINT || "",
  BUY_PRICE_USD: parseFloat(process.env.BUY_PRICE_USD || "0"),
  STOP_LOSS_ENABLED: process.env.STOP_LOSS === "true",
  STOP_LOSS_THRESHOLD: parseFloat(process.env.STOP_LOSS_PCT || "-20"),
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || "150"),
  AUTO_SELL: process.env.AUTO_SELL === "true",
  INTERVAL_SEC: parseInt(process.env.INTERVAL_SEC || "15"),
  // Paliers de base (utilisés si dynamicTakeProfit = false)
  TIERS: [
    { targetPnl: 25, sellPercent: 25, triggered: false },
    { targetPnl: 50, sellPercent: 25, triggered: false },
    { targetPnl: 75, sellPercent: 25, triggered: false },
    { targetPnl: 100, sellPercent: 25, triggered: false },
  ],
};

// ════════════════════════════════════════════════════════════════
// 🎯 CONFIGURATION AVANCÉE — Profil Agressif/Équilibré + Robustesse
// ════════════════════════════════════════════════════════════════

const SELL_STRATEGY = {
  // ── Take-Profit Dynamique (AGGRESSIF) ─────────────────────────
  dynamicTakeProfit: true,
  baseTiers: [
    { targetPnl: 20, sellPercent: 30, triggered: false },  // Sortie plus tôt
    { targetPnl: 40, sellPercent: 25, triggered: false },
    { targetPnl: 60, sellPercent: 25, triggered: false },
    { targetPnl: 100, sellPercent: 20, triggered: false }, // Dernier palier
  ],
  volatilityAdjustment: {
    low: { threshold: 15, pnlMultiplier: 0.85 },
    medium: { threshold: 40, pnlMultiplier: 1.0 },
    high: { threshold: Infinity, pnlMultiplier: 1.15 }
  },
  
  // ── Trailing Stop-Loss (AGGRESSIF) ───────────────────────────
  trailingStopLoss: {
    enabled: true,
    trailPercent: 8,
    activateAfterPnl: 5,
    minProfit: 3
  },
  
  // ── Time-Based Exit (ÉQUILIBRÉ pour memecoins) ───────────────
  timeExit: {
    enabled: true,
    maxHoldHours: 18,
    minPnlToHold: 8
  },
  
  // ── Liquidity Threshold (PROTECTION) ─────────────────────────
  liquidityThreshold: {
    enabled: true,
    minLiquidityUsd: 1000,  // ↑ Plus prudent: $1000 au lieu de $500
    priceImpactMax: 10,     // Max 10% d'impact sur le prix
    slippageByLiquidity: [
      { min: 0, max: 10000, slippageBps: 500 },    // 5% si < $10K
      { min: 10000, max: 100000, slippageBps: 300 }, // 3% si $10K-$100K
      { min: 100000, max: Infinity, slippageBps: 150 } // 1.5% si > $100K
    ]
  },
  
  // ── Volatility Scaling (ÉQUILIBRÉ) ───────────────────────────
  volatilityScaling: {
    enabled: true,
    checkInterval: 180000,
    highVolatilitySlippage: 500,
    lowVolatilitySlippage: 200
  },
  
  // ── DCA Sell (Optionnel) ─────────────────────────────────────
  dcaSell: {
    enabled: false,
    intervals: [0, 180, 360],
    percentages: [50, 30, 20]
  }
};

// ── Protection contre les boucles de vente infinies ─────────────
const SELL_RETRY_CONFIG = {
  maxAttempts: 3,              // ↓ Plus conservateur: 3 au lieu de 5
  baseDelayMs: 120000,         // 2 minutes de base
  maxDelayMs: 3600000,         // 1 heure max
  slippageStepBps: 150,        // +1.5% à chaque échec
  maxSlippageBps: 1500,        // Max 15% slippage
  circuitBreakerThreshold: 10, // Après 10 échecs totaux, pause globale
  circuitBreakerDuration: 600000 // Pause de 10 minutes
};

// ── Configuration du cache ──────────────────────────────────────
const CACHE_CONFIG = {
  maxEntries: 100,             // Limite le cache à 100 tokens
  cleanupInterval: 300000,     // Cleanup toutes les 5 minutes
  ttl: {
    high: 30000,    // 30s pour liquidité >= $1M
    medium: 60000,  // 1min pour $100K-$1M
    low: 120000,    // 2min pour $1K-$100K
    none: 300000,   // 5min pour tokens sans prix
  }
};

// ── Configuration du monitoring ─────────────────────────────────
const MONITORING_CONFIG = {
  heartbeatInterval: 60000,    // Heartbeat toutes les 1 minute
  metricsEndpoint: process.env.METRICS_ENDPOINT || null, // Optionnel: envoyer des métriques
  logLevel: process.env.LOG_LEVEL || 'info' // 'debug', 'info', 'warn', 'error'
};

// ════════════════════════════════════════════════════════════════
// ÉTAT GLOBAL — Avec protection et monitoring
// ════════════════════════════════════════════════════════════════

let keypair = null;
let isShuttingDown = false;

// Caches et états
const autoBuyPrices = {};
const tokenMetadataCache = {};
const triggeredTiers = {};
const priceCache = new Map();
const tokenTrailingData = {};
const tokenFirstSeen = {};
const failedSellAttempts = new Map();

// Métriques pour monitoring
const metrics = {
  startTime: Date.now(),
  totalChecks: 0,
  successfulChecks: 0,
  failedChecks: 0,
  totalSells: 0,
  failedSells: 0,
  lastHeartbeat: Date.now(),
  errors: []
};

// Tokens manuels
let manualTokens = [];
let dynamicTokens = [];

if (process.env.MANUAL_TOKENS) {
  try {
    manualTokens = JSON.parse(process.env.MANUAL_TOKENS);
    log('info', `[MANUAL] ${manualTokens.length} token(s) chargés depuis MANUAL_TOKENS`);
  } catch (e) {
    log('warn', '[MANUAL] Erreur de parsing MANUAL_TOKENS');
  }
}

let lastTokensData = [];

// ════════════════════════════════════════════════════════════════
// UTILITAIRES DE LOGGING ET MONITORING
// ════════════════════════════════════════════════════════════════

function log(level, message, meta = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[MONITORING_CONFIG.logLevel] ?? 1;
  
  if (levels[level] >= currentLevel) {
    const timestamp = new Date().toISOString();
    const prefix = {
      debug: '🔍',
      info: 'ℹ️',
      warn: '⚠️',
      error: '❌'
    }[level] || 'ℹ️';
    
    console.log(`${prefix} [${timestamp}] [${level.toUpperCase()}] ${message}`, Object.keys(meta).length ? meta : '');
    
    // Stocker les erreurs récentes pour debugging
    if (level === 'error') {
      metrics.errors.push({ timestamp, message, meta });
      if (metrics.errors.length > 50) metrics.errors.shift(); // Garder seulement les 50 dernières
    }
  }
}

function updateMetric(key, value = 1) {
  if (typeof metrics[key] === 'number') {
    metrics[key] += value;
  }
}

async function sendHeartbeat() {
  metrics.lastHeartbeat = Date.now();
  
  // Log heartbeat toutes les 5 minutes pour éviter le spam
  if (Math.floor(metrics.lastHeartbeat / 300000) !== Math.floor((metrics.lastHeartbeat - 60000) / 300000)) {
    log('info', `[❤️ HEARTBEAT] Uptime: ${Math.round((Date.now() - metrics.startTime) / 1000)}s | Checks: ${metrics.totalChecks} | Sells: ${metrics.totalSells} | Cache: ${priceCache.size}`);
  }
  
  // Envoyer à un endpoint de monitoring si configuré
  if (MONITORING_CONFIG.metricsEndpoint) {
    try {
      await fetch(MONITORING_CONFIG.metricsEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: 'solbot-pro',
          version: '3.8',
          uptime: Date.now() - metrics.startTime,
          checks: metrics.totalChecks,
          sells: metrics.totalSells,
          errors: metrics.errors.length,
          timestamp: new Date().toISOString()
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (e) {
      // Silently fail — ne pas bloquer le bot
    }
  }
}

function cleanupOldCache() {
  const now = Date.now();
  const maxAge = CACHE_CONFIG.ttl.none * 2; // Supprimer les entrées > 2x le TTL max
  
  for (const [key, value] of priceCache.entries()) {
    if (now - value.timestamp > maxAge) {
      priceCache.delete(key);
      log('debug', `[CACHE] Cleanup: ${key.slice(0,8)}...`);
    }
  }
  
  // Cleanup des failed sell attempts anciens
  for (const [mint, data] of failedSellAttempts.entries()) {
    if (now - data.lastAttempt > CACHE_CONFIG.ttl.none * 4) {
      failedSellAttempts.delete(mint);
      log('debug', `[FAILED_SELL] Cleanup: ${mint.slice(0,8)}...`);
    }
  }
  
  // Limiter la taille du cache
  if (priceCache.size > CACHE_CONFIG.maxEntries) {
    const oldest = Array.from(priceCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
    if (oldest) {
      priceCache.delete(oldest);
      log('debug', `[CACHE] Size limit: removed ${oldest.slice(0,8)}...`);
    }
  }
}

// ════════════════════════════════════════════════════════════════
// INITIALISATION ET SHUTDOWN
// ════════════════════════════════════════════════════════════════

function initWallet() {
  if (!PRIVATE_KEY_RAW) {
    log('error', '[ERREUR] PRIVATE_KEY manquante');
    process.exit(1);
  }
  try {
    const secretBytes = JSON.parse(PRIVATE_KEY_RAW);
    keypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
    log('info', `[WALLET] Connecté : ${keypair.publicKey.toString()}`);
  } catch (err) {
    log('error', `[ERREUR] PRIVATE_KEY invalide : ${err.message}`);
    process.exit(1);
  }
}

function getConnection() {
  return new Connection(RPC_URL, "confirmed");
}

// Gestion du shutdown gracieux
function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    log('warn', `[SHUTDOWN] Reçu signal ${signal} — Arrêt gracieux...`);
    isShuttingDown = true;
    
    // Attendre que les ventes en cours se terminent (max 30s)
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    log('info', `[SHUTDOWN] Bot arrêté proprement`);
    process.exit(0);
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  // Gestion des erreurs non capturées
  process.on('uncaughtException', (err) => {
    log('error', `[💥 CRASH] Uncaught Exception: ${err.message}`, { stack: err.stack });
    // Ne pas exit — laisser le bot continuer si possible
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    log('error', `[💥 CRASH] Unhandled Rejection: ${reason}`, { promise: String(promise) });
  });
}

// ════════════════════════════════════════════════════════════════
// SOURCES DE PRIX — Robustes avec retry, timeout, et fallbacks
// ════════════════════════════════════════════════════════════════

async function fetchWithRetry(url, options = {}, maxRetries = 2, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);
      
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!res.ok) {
        if (attempt < maxRetries && res.status >= 500) {
          await new Promise(r => setTimeout(r, baseDelay * attempt));
          continue;
        }
        return null;
      }
      
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        log('warn', `[FETCH] Timeout: ${url.slice(0, 50)}...`);
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ── Pump.fun API ────────────────────────────────────────────────
async function fetchPumpFunPrice(mintAddress) {
  try {
    const url = `https://frontend-api.pump.fun/coins/${mintAddress}`;
    const data = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'SolBot-Pro/3.8',
        'Accept': 'application/json',
        'Origin': 'https://pump.fun'
      },
      timeout: 10000
    }, 1, 2000);
    
    if (!data?.usd_market_cap || !data?.virtual_sol_reserves) return null;
    
    const virtualSolReserves = data.virtual_sol_reserves || 0;
    const virtualTokenReserves = data.virtual_token_reserves || 1;
    const solPrice = data.sol_price || 200;
    
    const priceSol = virtualSolReserves / virtualTokenReserves;
    const priceUsd = priceSol * solPrice;
    
    if (priceUsd <= 0) return null;
    
    return {
      priceUsd: priceUsd,
      liquidityUsd: data.usd_market_cap || 0,
      change24h: data.price_change_24h || 0,
      source: 'PumpFun'
    };
  } catch (err) {
    return null;
  }
}

// ── DexScreener — Avec retry et backoff ─────────────────────────
async function fetchDexScreenerPrice(mintAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
    const data = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'SolBot-Pro/3.8 (Trading Bot)',
        'Accept': 'application/json',
        'Connection': 'keep-alive'
      },
      timeout: 15000
    }, 2, 1000);
    
    if (!data?.pairs?.length) return null;
    
    const solanaPairs = data.pairs.filter(p => p.chainId === "solana");
    if (solanaPairs.length === 0) return null;
    
    const bestPair = solanaPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!bestPair?.priceUsd) return null;
    
    return {
      priceUsd: parseFloat(bestPair.priceUsd),
      liquidityUsd: bestPair.liquidity?.usd || 0,
      change24h: bestPair.priceChange?.h24 || 0,
      source: 'DexScreener'
    };
  } catch (err) {
    return null;
  }
}

// ── Jupiter Price (désactivé — ne répond pas) ───────────────────

// ── Birdeye ─────────────────────────────────────────────────────
async function fetchBirdeyePrice(mintAddress) {
  try {
    const url = `https://public-api.birdeye.so/defi/price?address=${mintAddress}`;
    const data = await fetchWithRetry(url, {
      headers: {
        'X-API-KEY': process.env.BIRDEYE_API_KEY || 'demo',
        'User-Agent': 'SolBot-Pro/3.8'
      },
      timeout: 10000
    }, 1, 2000);
    
    if (!data?.success?.data?.value) return null;
    return { priceUsd: data.data.value, source: 'Birdeye' };
  } catch {
    return null;
  }
}

// ── CoinGecko ───────────────────────────────────────────────────
async function fetchCoinGeckoPrice(mintAddress) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mintAddress.toLowerCase()}&vs_currencies=usd`;
    const data = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'SolBot-Pro/3.8' },
      timeout: 10000
    }, 1, 2000);
    
    const key = mintAddress.toLowerCase();
    if (!data?.[key]?.usd) return null;
    return { priceUsd: data[key].usd, source: 'CoinGecko' };
  } catch {
    return null;
  }
}

// ── Helius ──────────────────────────────────────────────────────
async function fetchHeliusPrice(mintAddress) {
  try {
    const apiKey = process.env.HELIUS_API_KEY || 'demo';
    const url = `https://api.helius.xyz/v0/tokens?ids=${mintAddress}&api-key=${apiKey}`;
    const data = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'SolBot-Pro/3.8' },
      timeout: 10000
    }, 1, 2000);
    
    if (!data?.data?.[mintAddress]?.price_info?.price_per_token) return null;
    const t = data.data[mintAddress];
    return {
      priceUsd: t.price_info.price_per_token,
      liquidityUsd: t.liquidity_info?.total_liquidity_usd || 0,
      source: 'Helius'
    };
  } catch {
    return null;
  }
}

// ── CoinGecko Fallback (dernier recours) ────────────────────────
async function fetchCoinGeckoFallback(mintAddress) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mintAddress.toLowerCase()}&vs_currencies=usd`;
    const data = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'SolBot-Pro/3.8' },
      timeout: 10000
    }, 1, 2000);
    
    const key = mintAddress.toLowerCase();
    if (data?.[key]?.usd) {
      return { priceUsd: data[key].usd, source: 'CoinGecko-Fallback' };
    }
    return null;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// PRIX AGGREGÉ — Weighted Average avec Pump.fun et fallback intelligent
// ════════════════════════════════════════════════════════════════

async function getWeightedPrice(mintAddress) {
  const sources = [
    { name: 'DexScreener', fetch: () => fetchDexScreenerPrice(mintAddress), weight: 5 },
    { name: 'Jupiter', fetch: () => fetchJupiterPrice(mintAddress), weight: 0 },
    { name: 'Birdeye', fetch: () => fetchBirdeyePrice(mintAddress), weight: 3 },
    { name: 'CoinGecko', fetch: () => fetchCoinGeckoPrice(mintAddress), weight: 2 },
    { name: 'Helius', fetch: () => fetchHeliusPrice(mintAddress), weight: 3 },
    { name: 'PumpFun', fetch: () => fetchPumpFunPrice(mintAddress), weight: 4 },
  ];

  const activeSources = sources.filter(src => src.weight > 0);
  
  const results = await Promise.allSettled(
    activeSources.map(src => src.fetch().then(data => ({ ...data, source: src.name, weight: src.weight })))
  );

  let validPrices = results
    .filter(r => r.status === 'fulfilled' && r.value?.priceUsd > 0)
    .map(r => r.value);

  // Fallback ultime
  if (validPrices.length === 0) {
    const fallback = await fetchCoinGeckoFallback(mintAddress);
    if (fallback) {
      validPrices = [{ ...fallback, weight: 1 }];
    }
  }

  if (validPrices.length === 0) return null;

  const weightedSum = validPrices.reduce((sum, p) => sum + p.priceUsd * p.weight, 0);
  const totalWeight = validPrices.reduce((sum, p) => sum + p.weight, 0);
  const confidence = validPrices.length / activeSources.length;

  return {
    priceUsd: weightedSum / totalWeight,
    confidence: Math.min(confidence, 1.0),
    sources: validPrices.map(p => p.source),
    liquidityUsd: validPrices.find(p => p.liquidityUsd)?.liquidityUsd || 0,
    change24h: validPrices.find(p => p.change24h)?.change24h || 0
  };
}

// ════════════════════════════════════════════════════════════════
// CACHE INTELLIGENT — Ne cache QUE les succès + cleanup automatique
// ════════════════════════════════════════════════════════════════

async function getCachedPrice(mintAddress, liquidityUsd) {
  const cached = priceCache.get(mintAddress);
  const now = Date.now();

  // Déterminer le TTL selon la liquidité
  let ttl = CACHE_CONFIG.ttl.none;
  if (liquidityUsd >= 1_000_000) ttl = CACHE_CONFIG.ttl.high;
  else if (liquidityUsd >= 100_000) ttl = CACHE_CONFIG.ttl.medium;
  else if (liquidityUsd > 0) ttl = CACHE_CONFIG.ttl.low;

  // Retourner le cache SEULEMENT si c'est un succès et pas expiré
  if (cached && cached.data?.priceUsd > 0 && (now - cached.timestamp) < ttl) {
    return { ...cached.data, fromCache: true };
  }

  const fresh = await getWeightedPrice(mintAddress);

  // NE CACHER QUE LES SUCCÈS (priceUsd > 0)
  if (fresh && fresh.priceUsd > 0) {
    // Cleanup si cache trop grand avant d'ajouter
    if (priceCache.size >= CACHE_CONFIG.maxEntries) {
      const oldest = Array.from(priceCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
      if (oldest) priceCache.delete(oldest);
    }
    
    priceCache.set(mintAddress, { data: fresh, timestamp: now, ttl });
  }

  return fresh ? { ...fresh, fromCache: false } : null;
}

// ════════════════════════════════════════════════════════════════
// MÉTADONNÉES + LOGOS — Multi-sources avec fallback et cache
// ════════════════════════════════════════════════════════════════

async function fetchTokenMetadata(mintAddress) {
  if (tokenMetadataCache[mintAddress]) {
    return tokenMetadataCache[mintAddress];
  }

  let metadata = { symbol: '???', name: 'Unknown', logo: null };

  // SOURCE 1: Jupiter Token List
  try {
    const data = await fetchWithRetry('https://tokens.jup.ag/tokens', {
      headers: { 'User-Agent': 'SolBot-Pro/3.8' },
      timeout: 15000
    }, 1, 2000);
    
    if (data) {
      const token = data.find(t => t.address === mintAddress);
      if (token) {
        metadata = {
          symbol: token.symbol || '???',
          name: token.name || 'Unknown',
          logo: token.logoURI || null
        };
        if (metadata.logo) {
          tokenMetadataCache[mintAddress] = metadata;
          return metadata;
        }
      }
    }
  } catch (err) { /* silent fail */ }

  // SOURCE 2: Solana Token List
  try {
    const data = await fetchWithRetry('https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json', {
      headers: { 'User-Agent': 'SolBot-Pro/3.8' },
      timeout: 15000
    }, 1, 2000);
    
    if (data) {
      const token = data.tags?.[mintAddress] || data.tokens?.find(t => t.address === mintAddress);
      if (token?.logoURI) {
        metadata.logo = token.logoURI;
        if (token.symbol) metadata.symbol = token.symbol;
        if (token.name) metadata.name = token.name;
      }
    }
  } catch (err) { /* silent fail */ }

  // SOURCE 3: Metaplex API
  try {
    const data = await fetchWithRetry(`https://api.metaplex.com/v1/metadata/${mintAddress}`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.8' },
      timeout: 10000
    }, 1, 2000);
    
    if (data?.metadata?.image) metadata.logo = data.metadata.image;
    if (data?.metadata?.symbol) metadata.symbol = data.metadata.symbol;
    if (data?.metadata?.name) metadata.name = data.metadata.name;
  } catch (err) { /* silent fail */ }

  // SOURCE 4: DexScreener
  try {
    const data = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.8' },
      timeout: 10000
    }, 1, 2000);
    
    if (data?.pairs?.[0]?.baseToken?.logoURI) metadata.logo = data.pairs[0].baseToken.logoURI;
    if (data.pairs?.[0]?.baseToken?.symbol && metadata.symbol === '???') {
      metadata.symbol = data.pairs[0].baseToken.symbol;
    }
  } catch (err) { /* silent fail */ }

  // SOURCE 5: Fallback placeholder coloré
  if (!metadata.logo && metadata.symbol !== '???') {
    const firstChar = metadata.symbol.charAt(0).toUpperCase();
    const colors = ['#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899'];
    const colorIndex = firstChar.charCodeAt(0) % colors.length;
    metadata.logo = `image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${colors[colorIndex]}"/><text x="16" y="22" font-size="18" font-weight="bold" fill="white" text-anchor="middle" font-family="Arial">${firstChar}</text></svg>`)}`;
  }

  tokenMetadataCache[mintAddress] = metadata;
  return metadata;
}

// ════════════════════════════════════════════════════════════════
// VENTE JUPITER — Avec retry robuste, timeout, et logging détaillé
// ════════════════════════════════════════════════════════════════
async function jupiterSell(mintAddress, amountRaw, slippageBps, maxRetries = 3) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log('debug', `[JUPITER] Tentative ${attempt}/${maxRetries}`);
      
      // ↑↑↑ TIMEOUT 60s + 3 retries + 3s delay ↑↑↑
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s
      
      const quoteData = await fetchWithRetry(quoteUrl, {
        headers: { 'User-Agent': 'SolBot-Pro/3.8' },
        timeout: 60000
      }, 3, 3000); // 3 retries, 3s base delay
      
      clearTimeout(timeoutId);
      
      if (!quoteData) throw new Error('Quote API timeout after 60s');
      if (quoteData?.errorCode) throw new Error(`Quote error: ${quoteData.error}`);
      
      log('debug', `[JUPITER] Quote: ${(quoteData.outAmount / 1e9).toFixed(6)} SOL`);
      
      // ↑↑↑ SWAP TIMEOUT 60s ↑↑↑
      const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json", 'User-Agent': 'SolBot-Pro/3.8' },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: keypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          computeUnitPriceMicroLamports: "auto",
        }),
        signal: AbortSignal.timeout(60000) // 60s
      });
      
      if (!swapRes.ok) {
        const errorText = await swapRes.text();
        throw new Error(`Swap HTTP ${swapRes.status}: ${errorText}`);
      }
      
      const { swapTransaction } = await swapRes.json();
      
      const connection = getConnection();
      const txBuffer = Buffer.from(swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuffer);
      tx.sign([keypair]);
      
      const txId = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: txId, ...latestBlockhash }, "confirmed");
      
      log('info', `[JUPITER] ✅ Confirmé : ${txId}`);
      return txId;
      
    } catch (err) {
      log('warn', `[JUPITER] ⚠️ Tentative ${attempt} échouée : ${err.message}`);
      
      if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNRESET') || err.message.includes('ETIMEDOUT')) {
        const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (attempt === maxRetries) throw err;
    }
  }
  throw new Error('Échec Jupiter après 3 tentatives (60s timeout)');
}

// ════════════════════════════════════════════════════════════════
// FONCTION D'EXÉCUTION DE VENTE — Avec protection anti-boucle et slippage dynamique
// ════════════════════════════════════════════════════════════════

async function executeSell(mintAddress, amountRaw, baseSlippageBps, reason) {
  if (isShuttingDown) {
    log('warn', `[VENTE] Abort: bot en shutdown`);
    return null;
  }
  
  const now = Date.now();
  const failedData = failedSellAttempts.get(mintAddress) || { 
    count: 0, 
    lastAttempt: 0, 
    nextRetry: 0, 
    baseSlippage: baseSlippageBps,
    totalFailures: 0
  };
  
  // ── Circuit breaker global ───────────────────────────────────
  const totalFailures = Array.from(failedSellAttempts.values()).reduce((sum, d) => sum + (d.totalFailures || 0), 0);
  if (totalFailures >= SELL_RETRY_CONFIG.circuitBreakerThreshold) {
    log('warn', `[VENTE] Circuit breaker: ${totalFailures} échecs globaux → pause`);
    return null;
  }
  
  // ── Vérifier si on doit attendre avant de réessayer ───────────
  if (failedData.count >= SELL_RETRY_CONFIG.maxAttempts && now < failedData.nextRetry) {
    const waitMinutes = Math.round((failedData.nextRetry - now) / 60000);
    log('info', `[⏸️ VENTE PAUSE] ${mintAddress.slice(0,8)}... : ${failedData.count} échecs → Pause ${waitMinutes}min`);
    return null;
  }
  
  // ── Calculer le slippage dynamique ───────────────────────────
  let slippageBps = baseSlippageBps + (failedData.count * SELL_RETRY_CONFIG.slippageStepBps);
  slippageBps = Math.min(slippageBps, SELL_RETRY_CONFIG.maxSlippageBps);
  
  log('info', `[VENTE] ${reason} : ${mintAddress.slice(0,8)}... | Amount: ${amountRaw} | Slippage: ${slippageBps}bps (attempt ${failedData.count + 1})`);
  
  try {
    const txId = await jupiterSell(mintAddress, amountRaw, slippageBps);
    
    // ✅ Succès : reset les compteurs d'échec
    failedSellAttempts.delete(mintAddress);
    updateMetric('totalSells');
    log('info', `[✅ VENTE] ${reason} confirmée : ${txId}`);
    return txId;
    
  } catch (err) {
    // ❌ Échec : logger et incrémenter
    failedData.count++;
    failedData.totalFailures = (failedData.totalFailures || 0) + 1;
    failedData.lastAttempt = now;
    
    const delayMs = Math.min(
      SELL_RETRY_CONFIG.baseDelayMs * Math.pow(1.5, failedData.count - 1),
      SELL_RETRY_CONFIG.maxDelayMs
    );
    failedData.nextRetry = now + delayMs;
    failedData.baseSlippage = baseSlippageBps;
    
    failedSellAttempts.set(mintAddress, failedData);
    updateMetric('failedSells');
    
    log('error', `[❌ VENTE] ${reason} ÉCHEC (attempt ${failedData.count}/${SELL_RETRY_CONFIG.maxAttempts}) : ${err.message}`);
    
    if (failedData.count >= SELL_RETRY_CONFIG.maxAttempts) {
      const waitMinutes = Math.round(delayMs / 60000);
      log('error', `[🚨 VENTE CRITIQUE] ${mintAddress.slice(0,8)}... : ${failedData.count} échecs → Pause ${waitMinutes}min`);
      log('error', `[🚨 ACTION] Vérifier liquidité sur DexScreener ou vendre manuellement via Jupiter UI`);
    }
    
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════
// LOGIQUE DE VENTE OPTIMISÉE — Toutes stratégies + protections
// ════════════════════════════════════════════════════════════════

async function applySellLogic(mintAddress, balance, decimals, currentPrice, pnl, liquidityUsd, change24h) {
  if (!CONFIG.AUTO_SELL || isShuttingDown) return;
  if (pnl === null || pnl === undefined) return;
  if (balance <= 0) return;

  const rawAmount = Math.floor(balance * Math.pow(10, decimals));
  
  // ── 1. Vérification Liquidité ─────────────────────────────────
  if (SELL_STRATEGY.liquidityThreshold.enabled) {
    if (liquidityUsd < SELL_STRATEGY.liquidityThreshold.minLiquidityUsd) {
      log('debug', `[VENTE SKIP] Liquidité insuffisante: $${liquidityUsd.toFixed(0)} < $${SELL_STRATEGY.liquidityThreshold.minLiquidityUsd}`);
      return;
    }
  }
  
  // ── 2. Calcul du Slippage Dynamique ───────────────────────────
  let slippageBps = CONFIG.SLIPPAGE_BPS;
  
  if (SELL_STRATEGY.liquidityThreshold.enabled) {
    for (const tier of SELL_STRATEGY.liquidityThreshold.slippageByLiquidity) {
      if (liquidityUsd >= tier.min && liquidityUsd < tier.max) {
        slippageBps = tier.slippageBps;
        break;
      }
    }
  }
  
  if (SELL_STRATEGY.volatilityScaling.enabled && change24h !== undefined) {
    const volatility = Math.abs(change24h);
    if (volatility > 50) {
      slippageBps = SELL_STRATEGY.volatilityScaling.highVolatilitySlippage;
    } else if (volatility < 15) {
      slippageBps = SELL_STRATEGY.volatilityScaling.lowVolatilitySlippage;
    }
  }

  // ── 3. Trailing Stop-Loss ─────────────────────────────────────
  if (SELL_STRATEGY.trailingStopLoss.enabled) {
    const trailData = tokenTrailingData[mintAddress] || { highestPnl: pnl, trailingActive: false };
    
    if (pnl > trailData.highestPnl) {
      trailData.highestPnl = pnl;
    }
    
    if (!trailData.trailingActive && pnl >= SELL_STRATEGY.trailingStopLoss.activateAfterPnl) {
      trailData.trailingActive = true;
      log('debug', `[TRAILING] Activé pour ${mintAddress.slice(0,8)}... (PnL: ${pnl.toFixed(2)}%)`);
    }
    
    if (trailData.trailingActive) {
      const trailingThreshold = trailData.highestPnl - SELL_STRATEGY.trailingStopLoss.trailPercent;
      const minProfitThreshold = SELL_STRATEGY.trailingStopLoss.minProfit;
      
      if (pnl <= trailingThreshold && pnl >= minProfitThreshold) {
        log('info', `[🛡️ TRAILING STOP] ${mintAddress.slice(0,8)}... : PnL ${pnl.toFixed(2)}% ≤ seuil ${trailingThreshold.toFixed(2)}%`);
        await executeSell(mintAddress, rawAmount, slippageBps, 'TRAILING_STOP');
        tokenTrailingData[mintAddress] = { highestPnl: 0, trailingActive: false };
        return;
      }
    }
    
    tokenTrailingData[mintAddress] = trailData;
  }

  // ── 4. Time-Based Exit ────────────────────────────────────────
  if (SELL_STRATEGY.timeExit.enabled) {
    const now = Date.now();
    
    if (!tokenFirstSeen[mintAddress]) {
      tokenFirstSeen[mintAddress] = now;
    }
    
    const holdHours = (now - tokenFirstSeen[mintAddress]) / (1000 * 60 * 60);
    
    if (holdHours >= SELL_STRATEGY.timeExit.maxHoldHours) {
      if (pnl < SELL_STRATEGY.timeExit.minPnlToHold) {
        log('info', `[⏱️ TIME EXIT] ${mintAddress.slice(0,8)}... : Vente après ${holdHours.toFixed(1)}h (PnL: ${pnl.toFixed(2)}%)`);
        await executeSell(mintAddress, rawAmount, slippageBps, 'TIME_EXIT');
        delete tokenFirstSeen[mintAddress];
        return;
      }
    }
  }

  // ── 5. Take-Profit Dynamique ─────────────────────────────────
  if (SELL_STRATEGY.dynamicTakeProfit) {
    let pnlMultiplier = 1.0;
    const volatility = Math.abs(change24h || 0);
    
    if (volatility < SELL_STRATEGY.volatilityAdjustment.low.threshold) {
      pnlMultiplier = SELL_STRATEGY.volatilityAdjustment.low.pnlMultiplier;
    } else if (volatility < SELL_STRATEGY.volatilityAdjustment.medium.threshold) {
      pnlMultiplier = SELL_STRATEGY.volatilityAdjustment.medium.pnlMultiplier;
    } else {
      pnlMultiplier = SELL_STRATEGY.volatilityAdjustment.high.pnlMultiplier;
    }
    
    for (let i = 0; i < SELL_STRATEGY.baseTiers.length; i++) {
      const baseTier = SELL_STRATEGY.baseTiers[i];
      const adjustedTargetPnl = baseTier.targetPnl * pnlMultiplier;
      const tierKey = `${mintAddress}_tier_${i}_dynamic`;
      
      if (triggeredTiers[tierKey] && pnl < adjustedTargetPnl - 10) {
        delete triggeredTiers[tierKey];
      }
      
      if (!triggeredTiers[tierKey] && pnl >= adjustedTargetPnl) {
        const sellPercent = baseTier.sellPercent / 100;
        const amountToSell = Math.floor(rawAmount * sellPercent);
        
        if (amountToSell > 0) {
          log('info', `[🎯 PALIER ${i+1} DYNAMIQUE] ${mintAddress.slice(0,8)}... : +${pnl.toFixed(2)}% ≥ ${adjustedTargetPnl.toFixed(1)}% → Vente de ${baseTier.sellPercent}%`);
          await executeSell(mintAddress, amountToSell, slippageBps, `TAKE_PROFIT_TIER_${i+1}`);
          triggeredTiers[tierKey] = true;
        }
      }
    }
  } else {
    // Fallback: paliers statiques
    for (let i = 0; i < CONFIG.TIERS.length; i++) {
      const tierKey = `${mintAddress}_tier_${i}`;
      const tier = CONFIG.TIERS[i];
      
      if (triggeredTiers[tierKey] && pnl < tier.targetPnl - 10) {
        delete triggeredTiers[tierKey];
      }
      
      if (!triggeredTiers[tierKey] && pnl >= tier.targetPnl) {
        const sellPercent = tier.sellPercent / 100;
        const amountToSell = Math.floor(rawAmount * sellPercent);
        
        if (amountToSell > 0) {
          log('info', `[🎯 PALIER ${i+1}] ${mintAddress.slice(0,8)}... : +${pnl.toFixed(2)}% → Vente de ${tier.sellPercent}%`);
          await executeSell(mintAddress, amountToSell, slippageBps, `TAKE_PROFIT_TIER_${i+1}`);
          triggeredTiers[tierKey] = true;
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
// BOUCLE PRINCIPALE — Wallet + Tokens Manuels + Monitoring
// ════════════════════════════════════════════════════════════════

async function runCheck() {
  if (isShuttingDown) return;
  
  updateMetric('totalChecks');
  const checkStart = Date.now();
  
  try {
    const connection = getConnection();
    const tokenDataForAPI = [];

    // Cleanup périodique du cache
    if (metrics.totalChecks % 20 === 0) {
      cleanupOldCache();
    }

    // 1. Tokens du wallet
    const allAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
      { commitment: 'confirmed' }
    );

    const walletTokens = allAccounts.value.map(acc => acc.account.data.parsed.info.mint);

    // 2. Combiner avec tokens manuels
    const allTokensToCheck = [...walletTokens, ...manualTokens, ...dynamicTokens];
    const uniqueTokens = [...new Set(allTokensToCheck)];

    // 3. Boucler sur chaque token
    for (const mintAddress of uniqueTokens) {
      if (isShuttingDown) break;
      
      const isManual = manualTokens.includes(mintAddress) || dynamicTokens.includes(mintAddress);
      if (mintAddress === "So11111111111111111111111111111111111111112") continue;

      let balance = 0, decimals = 6, isInWallet = false;

      // 4. Vérifier si dans le wallet
      const account = allAccounts.value.find(acc => acc.account.data.parsed.info.mint === mintAddress);
      if (account) {
        balance = parseFloat(account.account.data.parsed.info.tokenAmount.uiAmount) || 0;
        decimals = account.account.data.parsed.info.tokenAmount.decimals;
        isInWallet = true;
        if (balance <= 0) continue;
      } else {
        if (isManual) {
          log('debug', `[MANUAL] ⚠️ ${mintAddress.slice(0,8)}... : Token manuel mais PAS dans le wallet`);
        } else {
          continue;
        }
      }

      // 5. Récupérer le prix
      const priceData = await getCachedPrice(mintAddress, 0);
      const hasPrice = priceData && priceData.priceUsd > 0;
      const currentPrice = hasPrice ? priceData.priceUsd : 0;
      const liquidity = hasPrice ? (priceData.liquidityUsd || 0) : 0;
      const priceSource = hasPrice ? priceData.sources?.join(',') : null;
      const priceConfidence = hasPrice ? priceData.confidence : null;
      const change24h = hasPrice ? (priceData.change24h || 0) : 0;
      const valueUsd = balance * currentPrice;

      // 6. Prix de référence
      if (hasPrice && !autoBuyPrices[mintAddress]) {
        autoBuyPrices[mintAddress] = currentPrice;
        log('info', `[PRIX REF] ${mintAddress.slice(0,8)}... = $${currentPrice.toExponential(4)}`);
      }

      // 7. PnL
      let pnl = null;
      if (hasPrice && autoBuyPrices[mintAddress]) {
        const buyPrice = autoBuyPrices[mintAddress];
        pnl = ((currentPrice - buyPrice) / buyPrice) * 100;
      }

      // 8. Métadonnées
      const metadata = await fetchTokenMetadata(mintAddress);
      const tokenSymbol = metadata.symbol !== '???' ? metadata.symbol : '???';
      const tokenName = metadata.name || 'Unknown';

      // 9. Vente auto (seulement si dans wallet avec balance > 0)
      if (hasPrice && isInWallet && balance > 0) {
        await applySellLogic(mintAddress, balance, decimals, currentPrice, pnl, liquidity, change24h);
      }

      // 10. Stocker pour API
      tokenDataForAPI.push({
        symbol: tokenSymbol,
        name: tokenName,
        address: mintAddress,
        balance: balance,
        price: currentPrice,
        value: valueUsd,
        pnl: pnl,
        liquidity: liquidity,
        logo: metadata.logo,
        hasPrice: hasPrice,
        priceSource: priceSource,
        priceConfidence: priceConfidence,
        priceSources: priceData?.sources || [],
        isManual: isManual,
        isInWallet: isInWallet,
        autoSellEnabled: hasPrice && isInWallet && balance > 0
      });
    }

    lastTokensData = tokenDataForAPI;
    updateMetric('successfulChecks');
    
    const checkDuration = Date.now() - checkStart;
    if (checkDuration > CONFIG.INTERVAL_SEC * 1000 * 0.8) {
      log('warn', `[PERF] runCheck took ${checkDuration}ms (>${CONFIG.INTERVAL_SEC * 0.8}s)`);
    }

  } catch (err) {
    updateMetric('failedChecks');
    log('error', `[BOT] Erreur runCheck : ${err.message}`, { stack: err.stack });
  }
}

// ════════════════════════════════════════════════════════════════
// API HTTP — CORS + endpoints + auth optionnelle + monitoring
// ════════════════════════════════════════════════════════════════

if (process.env.RENDER) {
  const http = require('http');

  const server = http.createServer((req, res) => {
    // Headers CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Authentification optionnelle pour les endpoints sensibles
    const isProtected = ['/api/strategy/update', '/api/tokens/add', '/api/tokens/remove'].includes(req.url);
    if (isProtected && API_AUTH_KEY) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${API_AUTH_KEY}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // GET /api/tokens
    if (req.url === '/api/tokens' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        wallet: keypair?.publicKey?.toString() || 'N/A',
        tokens: lastTokensData,
        count: lastTokensData.length,
        manualTokens: manualTokens,
        dynamicTokens: dynamicTokens,
        timestamp: new Date().toISOString(),
        priceQuality: {
          highConfidence: lastTokensData.filter(t => t.priceConfidence >= 0.8).length,
          mediumConfidence: lastTokensData.filter(t => t.priceConfidence >= 0.5 && t.priceConfidence < 0.8).length,
          lowConfidence: lastTokensData.filter(t => t.priceConfidence < 0.5 && t.hasPrice).length,
          noPrice: lastTokensData.filter(t => !t.hasPrice).length
        }
      }));
      return;
    }

    // GET /api/strategy
    if (req.url === '/api/strategy' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, strategy: SELL_STRATEGY }));
      return;
    }

    // POST /api/strategy/update
    if (req.url === '/api/strategy/update' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const updates = JSON.parse(body);
          // Mise à jour sécurisée
          if (updates.trailingStopLoss?.enabled !== undefined) SELL_STRATEGY.trailingStopLoss.enabled = updates.trailingStopLoss.enabled;
          if (updates.trailingStopLoss?.trailPercent !== undefined) SELL_STRATEGY.trailingStopLoss.trailPercent = updates.trailingStopLoss.trailPercent;
          if (updates.timeExit?.maxHoldHours !== undefined) SELL_STRATEGY.timeExit.maxHoldHours = updates.timeExit.maxHoldHours;
          if (updates.liquidityThreshold?.minLiquidityUsd !== undefined) SELL_STRATEGY.liquidityThreshold.minLiquidityUsd = updates.liquidityThreshold.minLiquidityUsd;
          
          log('info', `[STRATÉGIE] Mise à jour appliquée`, { updates });
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Stratégie mise à jour', current: SELL_STRATEGY }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'JSON invalide' }));
        }
      });
      return;
    }

    // POST /api/tokens/add
    if (req.url === '/api/tokens/add' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { address, name, symbol } = data;
          if (!address || address.length < 32) {
            res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'Adresse invalide' })); return;
          }
          if (manualTokens.includes(address) || dynamicTokens.includes(address)) {
            res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'Déjà dans la liste' })); return;
          }
          dynamicTokens.push(address);
          if (name || symbol) tokenMetadataCache[address] = { symbol: symbol || '???', name: name || 'Unknown', logo: null };
          log('info', `[MANUAL] ✅ Ajouté : ${address.slice(0,8)}...`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Token ajouté', address }));
        } catch (e) {
          res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'JSON invalide' }));
        }
      });
      return;
    }

    // DELETE /api/tokens/remove
    if (req.url === '/api/tokens/remove' && req.method === 'DELETE') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { address } = JSON.parse(body);
          const mi = manualTokens.indexOf(address), di = dynamicTokens.indexOf(address);
          if (mi > -1) manualTokens.splice(mi, 1);
          else if (di > -1) dynamicTokens.splice(di, 1);
          else { res.writeHead(404); res.end(JSON.stringify({ success: false, error: 'Non trouvé' })); return; }
          log('info', `[MANUAL] ❌ Supprimé : ${address.slice(0,8)}...`);
          res.writeHead(200); res.end(JSON.stringify({ success: true, message: 'Token supprimé' }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'JSON invalide' })); }
      });
      return;
    }

    // GET /api/status
    if (req.url === '/api/status' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: isShuttingDown ? 'shutting_down' : 'running',
        wallet: keypair?.publicKey?.toString() || 'N/A',
        tokensCount: lastTokensData.length,
        manualTokensCount: manualTokens.length + dynamicTokens.length,
        uptime: process.uptime(),
        autoSell: CONFIG.AUTO_SELL,
        stopLoss: CONFIG.STOP_LOSS_ENABLED,
        strategy: {
          dynamicTakeProfit: SELL_STRATEGY.dynamicTakeProfit,
          trailingStopLoss: SELL_STRATEGY.trailingStopLoss.enabled,
          timeExit: SELL_STRATEGY.timeExit.enabled
        },
        priceStats: { cached: priceCache.size, highConfidence: lastTokensData.filter(t => t.priceConfidence >= 0.8).length },
        metrics: {
          totalChecks: metrics.totalChecks,
          successfulChecks: metrics.successfulChecks,
          failedChecks: metrics.failedChecks,
          totalSells: metrics.totalSells,
          failedSells: metrics.failedSells,
          uptime: Date.now() - metrics.startTime
        }
      }));
      return;
    }

    // GET /api/metrics (pour monitoring externe)
    if (req.url === '/api/metrics' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        service: 'solbot-pro',
        version: '3.8',
        uptime: Date.now() - metrics.startTime,
        checks: { total: metrics.totalChecks, success: metrics.successfulChecks, failed: metrics.failedChecks },
        sells: { total: metrics.totalSells, failed: metrics.failedSells },
        cache: { size: priceCache.size, failedAttempts: failedSellAttempts.size },
        errors: metrics.errors.slice(-10), // Dernières 10 erreurs
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // GET / (health check)
    if (req.url === '/') {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('🤖 SolBot Pro v3.8 API\nEndpoints: GET /api/tokens | GET /api/strategy | POST /api/strategy/update | POST /api/tokens/add | DELETE /api/tokens/remove | GET /api/status | GET /api/metrics');
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });

  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    log('info', `[HTTP] ✅ API sur le port ${PORT}`);
    log('info', `[HTTP] 📡 Endpoints: /api/tokens | /api/strategy | /api/status | /api/metrics`);
  });
}

// ════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE — Avec heartbeat et gestion robuste
// ════════════════════════════════════════════════════════════════

async function main() {
  log('info', "═══════════════════════════════════════════");
  log('info', "  🤖 SolBot Pro v3.8 — Production Ultimate");
  log('info', `  RPC        : ${RPC_URL}`);
  log('info', `  Intervalle : ${CONFIG.INTERVAL_SEC}s`);
  log('info', `  Auto-sell  : ${CONFIG.AUTO_SELL}`);
  log('info', `  Stop-loss  : ${CONFIG.STOP_LOSS_ENABLED} (${CONFIG.STOP_LOSS_THRESHOLD}%)`);
  log('info', `  Profil     : Agressif/Équilibré 🎯`);
  log('info', "═══════════════════════════════════════════");
  log('info', "  🎯 Stratégies Actives:");
  log('info', "  • Take-Profit Dynamique (volatilité-aware)");
  log('info', "  • Trailing Stop-Loss (actif à +5%, trail 8%)");
  log('info', "  • Time-Based Exit (18h max, min +8%)");
  log('info', "  • Liquidity Threshold ($1000 min)");
  log('info', "  • Volatility Scaling slippage (2-5%)");
  log('info', "  • Cache succès uniquement ✅");
  log('info', "  • Anti-loop protection ✅");
  log('info', "  • DexScreener retry + backoff");
  log('info', "  • Pump.fun API + 4 autres sources");
  log('info', "  • Monitoring & heartbeat ✅");
  log('info', "═══════════════════════════════════════════");

  setupGracefulShutdown();
  initWallet();
  
  // Heartbeat périodique
  setInterval(sendHeartbeat, MONITORING_CONFIG.heartbeatInterval);
  
  // Premier run
  await runCheck();

  // Boucle principale avec protection
  setInterval(async () => {
    if (!isShuttingDown) {
      await runCheck();
    }
  }, CONFIG.INTERVAL_SEC * 1000);

  log('info', "[BOT] 🔄 Surveillance active. Processus maintenu ouvert.");
  sendHeartbeat(); // Premier heartbeat immédiat
}

// Démarrage
main().catch(err => {
  log('error', `[FATAL] Erreur au démarrage : ${err.message}`, { stack: err.stack });
  process.exit(1);
});
