// ═══════════════════════════════════════════════════════════════
// SolBot Pro v3.7 — Advanced Selling Strategies
// Backend Node.js pour Solana Trading Automatique
// Hébergement : Render (Background Worker + API Web)
// Profil : Agressif/Équilibré — Maximiser les gains avec protection
// Features: Toutes stratégies + Cache fix + Pump.fun + Weighted Price + Smart Cache + Confidence + Manual Tokens + Logos
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
const RPC_URL = process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=43caa0a0-33d2-420c-b00a-e7261bfecf78";

// ── Configuration de base du bot ─────────────────────────────────
const CONFIG = {
  TOKEN_MINT:           process.env.TOKEN_MINT || "",
  BUY_PRICE_USD:        parseFloat(process.env.BUY_PRICE_USD || "0"),
  STOP_LOSS_ENABLED:    process.env.STOP_LOSS === "true",
  STOP_LOSS_THRESHOLD:  parseFloat(process.env.STOP_LOSS_PCT || "-20"),
  SLIPPAGE_BPS:         parseInt(process.env.SLIPPAGE_BPS || "100"),
  AUTO_SELL:            process.env.AUTO_SELL === "true",
  INTERVAL_SEC:         parseInt(process.env.INTERVAL_SEC || "15"),
  // Paliers de base (utilisés si dynamicTakeProfit = false)
  TIERS: [
    { targetPnl: 25,  sellPercent: 25, triggered: false },
    { targetPnl: 50,  sellPercent: 25, triggered: false },
    { targetPnl: 75,  sellPercent: 25, triggered: false },
    { targetPnl: 100, sellPercent: 25, triggered: false },
  ],
};

// ════════════════════════════════════════════════════════════════
// 🎯 CONFIGURATION AVANCÉE — Profil Agressif/Équilibré
// ════════════════════════════════════════════════════════════════

const SELL_STRATEGY = {
  // ── Take-Profit Dynamique (AGGRESSIF) ─────────────────────────
  dynamicTakeProfit: true,  // ✅ Ajuste les paliers selon la volatilité
  
  // Paliers de base (ajustés dynamiquement)
  baseTiers: [
    { targetPnl: 20,  sellPercent: 30, triggered: false },  // ← Plus agressif: 20% au lieu de 25%
    { targetPnl: 40,  sellPercent: 25, triggered: false },  // ← Plus agressif: 40% au lieu de 50%
    { targetPnl: 60,  sellPercent: 25, triggered: false },  // ← Plus agressif: 60% au lieu de 75%
    { targetPnl: 100, sellPercent: 20, triggered: false },  // ← Dernier palier pour max gains
  ],
  
  // Ajustement selon la volatilité (24h) — Profil Équilibré
  volatilityAdjustment: {
    low: { threshold: 15,  pnlMultiplier: 0.85 },   // -15% si volatilité faible → sortie plus tôt
    medium: { threshold: 40, pnlMultiplier: 1.0 },   // Normal
    high: { threshold: Infinity, pnlMultiplier: 1.15 } // +15% si haute volatilité → laisser courir
  },
  
  // ── Trailing Stop-Loss (AGGRESSIF) ───────────────────────────
  trailingStopLoss: {
    enabled: true,
    trailPercent: 8,           // ← Plus serré: 8% au lieu de 10% (protège les gains)
    activateAfterPnl: 5,       // ← S'active plus tôt: +5% au lieu de +10%
    minProfit: 3               // ← Garde au moins +3% (plus agressif que +5%)
  },
  
  // ── Time-Based Exit (ÉQUILIBRÉ pour memecoins) ───────────────
  timeExit: {
    enabled: true,
    maxHoldHours: 18,          // ← Plus court: 18h au lieu de 24h (memecoins pump.fun)
    minPnlToHold: 8            // ← Garde si PnL > +8% même après timeout
  },
  
  // ── Liquidity Threshold (AGGRESSIF) ──────────────────────────
  liquidityThreshold: {
    enabled: true,
    minLiquidityUsd: 500,      // ← Plus bas: $500 au lieu de $1000 (plus d'opportunités)
    slippageByLiquidity: [
      { min: 0, max: 5000, slippageBps: 400 },     // 4% si liquidité < $5K (agressif)
      { min: 5000, max: 50000, slippageBps: 250 },  // 2.5% si $5K-$50K
      { min: 50000, max: Infinity, slippageBps: 150 } // 1.5% si > $50K
    ]
  },
  
  // ── Volatility Scaling (ÉQUILIBRÉ) ───────────────────────────
  volatilityScaling: {
    enabled: true,
    checkInterval: 180000,     // Vérifie toutes les 3min
    highVolatilitySlippage: 400,  // 4% si haute volatilité (tolérance élevée)
    lowVolatilitySlippage: 150    // 1.5% si basse volatilité
  },
  
  // ── DCA Sell (Optionnel — Désactivé par défaut) ──────────────
  dcaSell: {
    enabled: false,  // Désactivé par défaut (activer pour grosses positions)
    intervals: [0, 180, 360],  // Vend maintenant, +3min, +6min
    percentages: [50, 30, 20]   // 50% immédiat, puis 30%, puis 20%
  }
};

// ── État global pour les stratégies ────────────────────────────
let keypair = null;
const autoBuyPrices = {};
const tokenMetadataCache = {};
const triggeredTiers = {};  // Pour les paliers statiques
const priceCache = new Map();
const tokenTrailingData = {};  // { mintAddress: { highestPnl: X, trailingActive: bool } }
const tokenFirstSeen = {};     // { mintAddress: timestamp }

// TTL dynamique selon la liquidité
const CACHE_TTL = {
  high: 30000,    // 30s pour liquidité >= $1M
  medium: 60000,  // 1min pour $100K-$1M
  low: 120000,    // 2min pour $1K-$100K
  none: 300000,   // 5min pour tokens sans prix
};

// Tokens manuels
let manualTokens = [];
let dynamicTokens = [];

if (process.env.MANUAL_TOKENS) {
  try {
    manualTokens = JSON.parse(process.env.MANUAL_TOKENS);
    console.log(`[MANUAL] ${manualTokens.length} token(s) chargés depuis MANUAL_TOKENS`);
  } catch (e) {
    console.warn('[MANUAL] Erreur de parsing MANUAL_TOKENS');
  }
}

let lastTokensData = [];

// ════════════════════════════════════════════════════════════════
// INITIALISATION
// ════════════════════════════════════════════════════════════════

function initWallet() {
  if (!PRIVATE_KEY_RAW) {
    console.error("[ERREUR] PRIVATE_KEY manquante");
    process.exit(1);
  }
  try {
    const secretBytes = JSON.parse(PRIVATE_KEY_RAW);
    keypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
    console.log(`[WALLET] Connecté : ${keypair.publicKey.toString()}`);
  } catch (err) {
    console.error("[ERREUR] PRIVATE_KEY invalide :", err.message);
    process.exit(1);
  }
}

function getConnection() {
  return new Connection(RPC_URL, "confirmed");
}

// ════════════════════════════════════════════════════════════════
// SOURCES DE PRIX — Avec retry intelligent et headers
// ════════════════════════════════════════════════════════════════

// ── Pump.fun API ────────────────────────────────────────────────
async function fetchPumpFunPrice(mintAddress) {
  try {
    const url = `https://frontend-api.pump.fun/coins/${mintAddress}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SolBot-Pro/3.7',
        'Accept': 'application/json',
        'Origin': 'https://pump.fun'
      },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!res.ok) {
      // HTTP 530 = Cloudflare block, ne pas logger en warning
      if (res.status !== 530) {
        console.log(`[PUMP.FUN] HTTP ${res.status} pour ${mintAddress.slice(0,8)}...`);
      }
      return null;
    }
    
    const data = await res.json();
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
    // Ne pas spammer les logs pour les erreurs réseau courantes
    if (!err.message.includes('ENOTFOUND') && !err.message.includes('ECONNRESET')) {
      console.log(`[PUMP.FUN] Erreur pour ${mintAddress.slice(0,8)}... : ${err.message}`);
    }
    return null;
  }
}

// ── DexScreener — Avec retry et backoff ─────────────────────────
async function fetchDexScreenerPrice(mintAddress, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
      const headers = {
        'User-Agent': 'SolBot-Pro/3.7 (Trading Bot)',
        'Accept': 'application/json',
        'Connection': 'keep-alive'
      };
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      const res = await fetch(url, { signal: controller.signal, headers });
      clearTimeout(timeoutId);
      
      if (!res.ok) {
        console.warn(`[DEXSCREENER] HTTP ${res.status} pour ${mintAddress.slice(0,8)}...`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        return null;
      }
      
      const data = await res.json();
      if (!data.pairs?.length) return null;
      
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
      if (err.name !== 'AbortError') {
        console.warn(`[DEXSCREENER] Erreur pour ${mintAddress.slice(0,8)}... : ${err.message}`);
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ── Jupiter Price (désactivé — ne répond pas) ───────────────────
async function fetchJupiterPrice(mintAddress) {
  // Silence log pour éviter le spam
  return null;
}

// ── Birdeye ─────────────────────────────────────────────────────
async function fetchBirdeyePrice(mintAddress) {
  try {
    const url = `https://public-api.birdeye.so/defi/price?address=${mintAddress}`;
    const res = await fetch(url, {
      headers: {
        'X-API-KEY': process.env.BIRDEYE_API_KEY || 'demo',
        'User-Agent': 'SolBot-Pro/3.7'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success?.data?.value) return null;
    return { priceUsd: data.data.value, source: 'Birdeye' };
  } catch { return null; }
}

// ── CoinGecko ───────────────────────────────────────────────────
async function fetchCoinGeckoPrice(mintAddress) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mintAddress.toLowerCase()}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SolBot-Pro/3.7' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const key = mintAddress.toLowerCase();
    if (!data[key]?.usd) return null;
    return { priceUsd: data[key].usd, source: 'CoinGecko' };
  } catch { return null; }
}

// ── Helius ──────────────────────────────────────────────────────
async function fetchHeliusPrice(mintAddress) {
  try {
    const apiKey = process.env.HELIUS_API_KEY || 'demo';
    const url = `https://api.helius.xyz/v0/tokens?ids=${mintAddress}&api-key=${apiKey}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SolBot-Pro/3.7' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data?.[mintAddress]?.price_info?.price_per_token) return null;
    const t = data.data[mintAddress];
    return {
      priceUsd: t.price_info.price_per_token,
      liquidityUsd: t.liquidity_info?.total_liquidity_usd || 0,
      source: 'Helius'
    };
  } catch { return null; }
}

// ── CoinGecko Fallback (dernier recours) ────────────────────────
async function fetchCoinGeckoFallback(mintAddress) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mintAddress.toLowerCase()}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SolBot-Pro/3.7' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const key = mintAddress.toLowerCase();
    if (data[key]?.usd) {
      return { priceUsd: data[key].usd, source: 'CoinGecko-Fallback' };
    }
    return null;
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════
// PRIX AGGREGÉ — Weighted Average avec Pump.fun
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
// CACHE INTELLIGENT — Ne cache QUE les succès ✅
// ════════════════════════════════════════════════════════════════

async function getCachedPrice(mintAddress, liquidityUsd) {
  const cached = priceCache.get(mintAddress);
  const now = Date.now();

  // Déterminer le TTL selon la liquidité
  let ttl = CACHE_TTL.none;
  if (liquidityUsd >= 1_000_000) ttl = CACHE_TTL.high;
  else if (liquidityUsd >= 100_000) ttl = CACHE_TTL.medium;
  else if (liquidityUsd > 0) ttl = CACHE_TTL.low;

  // ✅ Retourner le cache SEULEMENT si c'est un succès (priceUsd > 0) et pas expiré
  if (cached && cached.data?.priceUsd > 0 && (now - cached.timestamp) < ttl) {
    return { ...cached.data, fromCache: true };
  }

  const fresh = await getWeightedPrice(mintAddress);

  // ✅ NE CACHER QUE LES SUCCÈS (priceUsd > 0)
  if (fresh && fresh.priceUsd > 0) {
    priceCache.set(mintAddress, {  fresh, timestamp: now, ttl });
  }

  return fresh ? { ...fresh, fromCache: false } : null;
}

// ════════════════════════════════════════════════════════════════
// MÉTADONNÉES + LOGOS — Multi-sources avec fallback
// ════════════════════════════════════════════════════════════════

async function fetchTokenMetadata(mintAddress) {
  if (tokenMetadataCache[mintAddress]) {
    return tokenMetadataCache[mintAddress];
  }

  let metadata = { symbol: '???', name: 'Unknown', logo: null };

  // SOURCE 1: Jupiter Token List
  try {
    const res = await fetch('https://tokens.jup.ag/tokens', { 
      headers: { 'User-Agent': 'SolBot-Pro/3.7' },
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      const tokens = await res.json();
      const token = tokens.find(t => t.address === mintAddress);
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
    const res = await fetch('https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json', {
      headers: { 'User-Agent': 'SolBot-Pro/3.7' },
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      const data = await res.json();
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
    const res = await fetch(`https://api.metaplex.com/v1/metadata/${mintAddress}`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.7' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.metadata?.image) metadata.logo = data.metadata.image;
      if (data?.metadata?.symbol) metadata.symbol = data.metadata.symbol;
      if (data?.metadata?.name) metadata.name = data.metadata.name;
    }
  } catch (err) { /* silent fail */ }

  // SOURCE 4: DexScreener
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.7' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.pairs?.[0]?.baseToken?.logoURI) metadata.logo = data.pairs[0].baseToken.logoURI;
      if (data.pairs?.[0]?.baseToken?.symbol && metadata.symbol === '???') {
        metadata.symbol = data.pairs[0].baseToken.symbol;
      }
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
// VENTE JUPITER — Avec retry, timeout long et backoff exponentiel
// ════════════════════════════════════════════════════════════════

async function jupiterSell(mintAddress, amountRaw, slippageBps, maxRetries = 3) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const quoteRes = await fetch(quoteUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'SolBot-Pro/3.7' }
      });
      clearTimeout(timeoutId);
      
      if (!quoteRes.ok) {
        const errorText = await quoteRes.text();
        throw new Error(`Quote HTTP ${quoteRes.status}: ${errorText}`);
      }
      
      const quote = await quoteRes.json();
      
      const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json", 'User-Agent': 'SolBot-Pro/3.7' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: keypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          computeUnitPriceMicroLamports: "auto",
        }),
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
      
      const txId = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: txId, ...latestBlockhash }, "confirmed");
      
      return txId;
      
    } catch (err) {
      if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNRESET') || err.message.includes('ETIMEDOUT')) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      if (attempt === maxRetries) throw err;
    }
  }
  throw new Error('Échec après toutes les tentatives');
}

// ════════════════════════════════════════════════════════════════
// FONCTION D'EXÉCUTION DE VENTE CENTRALISÉE
// ════════════════════════════════════════════════════════════════

async function executeSell(mintAddress, amountRaw, slippageBps, reason) {
  console.log(`[VENTE] ${reason} : ${mintAddress.slice(0,8)}... | Amount: ${amountRaw} | Slippage: ${slippageBps}bps`);
  
  try {
    const txId = await jupiterSell(mintAddress, amountRaw, slippageBps);
    console.log(`[✅ VENTE] ${reason} confirmée : ${txId}`);
    return txId;
  } catch (err) {
    console.error(`[❌ VENTE] ${reason} ÉCHEC : ${err.message}`);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════
// LOGIQUE DE VENTE OPTIMISÉE — Toutes stratégies avancées
// ════════════════════════════════════════════════════════════════

async function applySellLogic(mintAddress, balance, decimals, currentPrice, pnl, liquidityUsd, change24h) {
  if (!CONFIG.AUTO_SELL) return;
  if (pnl === null || pnl === undefined) return;
  if (balance <= 0) return;

  const rawAmount = Math.floor(balance * Math.pow(10, decimals));
  
  // ── 1. Vérification Liquidité ─────────────────────────────────
  if (SELL_STRATEGY.liquidityThreshold.enabled) {
    if (liquidityUsd < SELL_STRATEGY.liquidityThreshold.minLiquidityUsd) {
      return; // Pas de vente si liquidité insuffisante
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
    }
    
    if (trailData.trailingActive) {
      const trailingThreshold = trailData.highestPnl - SELL_STRATEGY.trailingStopLoss.trailPercent;
      const minProfitThreshold = SELL_STRATEGY.trailingStopLoss.minProfit;
      
      if (pnl <= trailingThreshold && pnl >= minProfitThreshold) {
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
          await executeSell(mintAddress, amountToSell, slippageBps, `TAKE_PROFIT_TIER_${i+1}`);
          triggeredTiers[tierKey] = true;
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
// BOUCLE PRINCIPALE — Wallet + Tokens Manuels
// ════════════════════════════════════════════════════════════════

async function runCheck() {
  try {
    const connection = getConnection();
    const tokenDataForAPI = [];

    const allAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );

    const walletTokens = allAccounts.value.map(acc => acc.account.data.parsed.info.mint);

    const allTokensToCheck = [...walletTokens, ...manualTokens, ...dynamicTokens];
    const uniqueTokens = [...new Set(allTokensToCheck)];

    for (const mintAddress of uniqueTokens) {
      const isManual = manualTokens.includes(mintAddress) || dynamicTokens.includes(mintAddress);
      if (mintAddress === "So11111111111111111111111111111111111111112") continue;

      let balance = 0, decimals = 6, isInWallet = false;

      const account = allAccounts.value.find(acc => acc.account.data.parsed.info.mint === mintAddress);
      if (account) {
        balance = parseFloat(account.account.data.parsed.info.tokenAmount.uiAmount) || 0;
        decimals = account.account.data.parsed.info.tokenAmount.decimals;
        isInWallet = true;
        if (balance <= 0) continue;
      } else {
        if (isManual) { /* token manuel pas dans wallet */ }
        else continue;
      }

      const priceData = await getCachedPrice(mintAddress, 0);
      const hasPrice = priceData && priceData.priceUsd > 0;
      const currentPrice = hasPrice ? priceData.priceUsd : 0;
      const liquidity = hasPrice ? (priceData.liquidityUsd || 0) : 0;
      const priceSource = hasPrice ? priceData.sources?.join(',') : null;
      const priceConfidence = hasPrice ? priceData.confidence : null;
      const change24h = hasPrice ? (priceData.change24h || 0) : 0;
      const valueUsd = balance * currentPrice;

      if (hasPrice && !autoBuyPrices[mintAddress]) {
        autoBuyPrices[mintAddress] = currentPrice;
      }

      let pnl = null;
      if (hasPrice && autoBuyPrices[mintAddress]) {
        const buyPrice = autoBuyPrices[mintAddress];
        pnl = ((currentPrice - buyPrice) / buyPrice) * 100;
      }

      const metadata = await fetchTokenMetadata(mintAddress);
      const tokenSymbol = metadata.symbol !== '???' ? metadata.symbol : '???';
      const tokenName = metadata.name || 'Unknown';

      if (hasPrice && isInWallet && balance > 0) {
        await applySellLogic(mintAddress, balance, decimals, currentPrice, pnl, liquidity, change24h);
      }

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

  } catch (err) {
    console.error("[BOT] Erreur runCheck :", err.message);
  }
}

// ════════════════════════════════════════════════════════════════
// API HTTP — CORS + endpoints complets + stratégie
// ════════════════════════════════════════════════════════════════

if (process.env.RENDER) {
  const http = require('http');

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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
          // Mise à jour sécurisée des paramètres
          if (updates.trailingStopLoss?.enabled !== undefined) SELL_STRATEGY.trailingStopLoss.enabled = updates.trailingStopLoss.enabled;
          if (updates.trailingStopLoss?.trailPercent !== undefined) SELL_STRATEGY.trailingStopLoss.trailPercent = updates.trailingStopLoss.trailPercent;
          if (updates.timeExit?.maxHoldHours !== undefined) SELL_STRATEGY.timeExit.maxHoldHours = updates.timeExit.maxHoldHours;
          if (updates.liquidityThreshold?.minLiquidityUsd !== undefined) SELL_STRATEGY.liquidityThreshold.minLiquidityUsd = updates.liquidityThreshold.minLiquidityUsd;
          
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
          res.writeHead(200); res.end(JSON.stringify({ success: true, message: 'Token supprimé' }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'JSON invalide' })); }
      });
      return;
    }

    // GET /api/status
    if (req.url === '/api/status' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'running',
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
        priceStats: { cached: priceCache.size, highConfidence: lastTokensData.filter(t => t.priceConfidence >= 0.8).length }
      }));
      return;
    }

    // GET /
    if (req.url === '/') {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('🤖 SolBot Pro v3.7 API\nEndpoints: GET /api/tokens | GET /api/strategy | POST /api/strategy/update | POST /api/tokens/add | DELETE /api/tokens/remove | GET /api/status');
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });

  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log(`[HTTP] ✅ API sur le port ${PORT}`);
    console.log(`[HTTP] 📡 Endpoints: /api/tokens | /api/strategy | /api/status`);
  });
}

// ════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  🤖 SolBot Pro v3.7 — Advanced Strategies");
  console.log(`  RPC        : ${RPC_URL}`);
  console.log(`  Intervalle : ${CONFIG.INTERVAL_SEC}s`);
  console.log(`  Auto-sell  : ${CONFIG.AUTO_SELL}`);
  console.log(`  Stop-loss  : ${CONFIG.STOP_LOSS_ENABLED} (${CONFIG.STOP_LOSS_THRESHOLD}%)`);
  console.log("  Profil     : Agressif/Équilibré 🎯");
  console.log("═══════════════════════════════════════════");
  console.log("  🎯 Stratégies Actives:");
  console.log("  • Take-Profit Dynamique (volatilité-aware)");
  console.log("  • Trailing Stop-Loss (actif à +5%, trail 8%)");
  console.log("  • Time-Based Exit (18h max, min +8%)");
  console.log("  • Liquidity Threshold ($500 min)");
  console.log("  • Volatility Scaling slippage (1.5-4%)");
  console.log("  • Cache succès uniquement ✅");
  console.log("  • DexScreener retry + backoff");
  console.log("  • Pump.fun API + 4 autres sources");
  console.log("═══════════════════════════════════════════");

  initWallet();
  await runCheck();

  setInterval(async () => {
    try { await runCheck(); }
    catch (err) { console.error("[BOT] Erreur runCheck :", err.message); }
  }, CONFIG.INTERVAL_SEC * 1000);

  console.log("[BOT] 🔄 Surveillance active. Processus maintenu ouvert.");
}

// ── Gestion des erreurs critiques ────────────────────────────────
process.on("uncaughtException", (err) => console.error("[FATAL] Exception :", err.message));
process.on("unhandledRejection", (reason) => console.error("[FATAL] Rejection :", reason));

main();
