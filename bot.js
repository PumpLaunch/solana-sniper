// ═══════════════════════════════════════════════════════════════
// SolBot Pro v3.5 — Pump.fun Edition
// Backend Node.js pour Solana Trading Automatique
// Hébergement : Render (Background Worker + API Web)
// Features: Pump.fun API + Weighted Price + Smart Cache + Confidence + Manual Tokens + Logos
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

// ── Configuration du bot ─────────────────────────────────────────
const CONFIG = {
  TOKEN_MINT:           process.env.TOKEN_MINT || "",
  BUY_PRICE_USD:        parseFloat(process.env.BUY_PRICE_USD || "0"),
  STOP_LOSS_ENABLED:    process.env.STOP_LOSS === "true",
  STOP_LOSS_THRESHOLD:  parseFloat(process.env.STOP_LOSS_PCT || "-20"),
  SLIPPAGE_BPS:         parseInt(process.env.SLIPPAGE_BPS || "100"),
  AUTO_SELL:            process.env.AUTO_SELL === "true",
  INTERVAL_SEC:         parseInt(process.env.INTERVAL_SEC || "15"),
  TIERS: [
    { targetPnl: 25,  sellPercent: 25, triggered: false },
    { targetPnl: 50,  sellPercent: 25, triggered: false },
    { targetPnl: 75,  sellPercent: 25, triggered: false },
    { targetPnl: 100, sellPercent: 25, triggered: false },
  ],
};

// ── État global ──────────────────────────────────────────────────
let keypair = null;
const autoBuyPrices = {};
const tokenMetadataCache = {};
const triggeredTiers = {};
const priceCache = new Map();

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
// SOURCES DE PRIX — Pump.fun + Autres avec fallbacks
// ════════════════════════════════════════════════════════════════

// ── Pump.fun API (NOUVEAU — pour tokens pump.fun) ───────────────
async function fetchPumpFunPrice(mintAddress) {
  try {
    // Pump.fun API publique pour les prix
    const url = `https://frontend-api.pump.fun/coins/${mintAddress}`;
    
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SolBot-Pro/3.5',
        'Accept': 'application/json',
        'Origin': 'https://pump.fun'
      },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!res.ok) {
      console.log(`[PUMP.FUN] HTTP ${res.status} pour ${mintAddress.slice(0,8)}...`);
      return null;
    }
    
    const data = await res.json();
    
    // Vérifier les données nécessaires
    if (!data?.usd_market_cap || !data?.virtual_sol_reserves) {
      return null;
    }
    
    // Calculer le prix à partir des réserves virtuelles
    const virtualSolReserves = data.virtual_sol_reserves || 0;
    const virtualTokenReserves = data.virtual_token_reserves || 1;
    const solPrice = data.sol_price || 200; // Prix SOL en USD (fallback)
    
    // Prix en SOL
    const priceSol = virtualSolReserves / virtualTokenReserves;
    // Prix en USD
    const priceUsd = priceSol * solPrice;
    
    if (priceUsd <= 0) return null;
    
    return {
      priceUsd: priceUsd,
      liquidityUsd: data.usd_market_cap || 0,
      change24h: data.price_change_24h || 0,
      source: 'PumpFun'
    };
    
  } catch (err) {
    console.log(`[PUMP.FUN] Erreur pour ${mintAddress.slice(0,8)}... : ${err.message}`);
    return null;
  }
}

// ── DexScreener ─────────────────────────────────────────────────
async function fetchDexScreenerPrice(mintAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
    const headers = {
      'User-Agent': 'SolBot-Pro/3.5',
      'Accept': 'application/json',
      'Connection': 'keep-alive'
    };
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      console.warn(`[DEXSCREENER] HTTP ${res.status} pour ${mintAddress.slice(0,8)}...`);
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
    return null;
  }
}

// ── Jupiter Price (désactivé — ne répond pas) ───────────────────
async function fetchJupiterPrice(mintAddress) {
  console.log(`[JUPITER PRICE] ⚠️ API indisponible — skip ${mintAddress.slice(0,8)}...`);
  return null;
}

// ── Birdeye ─────────────────────────────────────────────────────
async function fetchBirdeyePrice(mintAddress) {
  try {
    const url = `https://public-api.birdeye.so/defi/price?address=${mintAddress}`;
    const res = await fetch(url, {
      headers: {
        'X-API-KEY': process.env.BIRDEYE_API_KEY || 'demo',
        'User-Agent': 'SolBot-Pro/3.5'
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
      headers: { 'User-Agent': 'SolBot-Pro/3.5' },
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
      headers: { 'User-Agent': 'SolBot-Pro/3.5' },
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
      headers: { 'User-Agent': 'SolBot-Pro/3.5' },
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
// PRIX AGGREGÉ — Weighted Average avec Pump.fun en priorité
// ════════════════════════════════════════════════════════════════

async function getWeightedPrice(mintAddress) {
  const sources = [
    { name: 'DexScreener', fetch: () => fetchDexScreenerPrice(mintAddress), weight: 5 },
    { name: 'Jupiter', fetch: () => fetchJupiterPrice(mintAddress), weight: 0 },
    { name: 'Birdeye', fetch: () => fetchBirdeyePrice(mintAddress), weight: 3 },
    { name: 'CoinGecko', fetch: () => fetchCoinGeckoPrice(mintAddress), weight: 2 },
    { name: 'Helius', fetch: () => fetchHeliusPrice(mintAddress), weight: 3 },
    { name: 'PumpFun', fetch: () => fetchPumpFunPrice(mintAddress), weight: 4 },  // ← Pump.fun ajouté
  ];

  const activeSources = sources.filter(src => src.weight > 0);
  
  const results = await Promise.allSettled(
    activeSources.map(src => src.fetch().then(data => ({ ...data, source: src.name, weight: src.weight })))
  );

  let validPrices = results
    .filter(r => r.status === 'fulfilled' && r.value?.priceUsd > 0)
    .map(r => r.value);

  // Fallback ultime si aucune source n'a répondu
  if (validPrices.length === 0) {
    console.log(`[PRIX] 🔄 Fallback CoinGecko pour ${mintAddress.slice(0,8)}...`);
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
// CACHE INTELLIGENT AVEC TTL DYNAMIQUE
// ════════════════════════════════════════════════════════════════

async function getCachedPrice(mintAddress, liquidityUsd) {
  const cached = priceCache.get(mintAddress);
  const now = Date.now();

  let ttl = CACHE_TTL.none;
  if (liquidityUsd >= 1_000_000) ttl = CACHE_TTL.high;
  else if (liquidityUsd >= 100_000) ttl = CACHE_TTL.medium;
  else if (liquidityUsd > 0) ttl = CACHE_TTL.low;

  if (cached && (now - cached.timestamp) < ttl) {
    return { ...cached.data, fromCache: true };
  }

  console.log(`[PRIX] Refresh ${mintAddress.slice(0,8)}... (liquidity: $${Math.round(liquidityUsd).toLocaleString()})`);
  const fresh = await getWeightedPrice(mintAddress);

  if (fresh) {
    priceCache.set(mintAddress, {  fresh, timestamp: now, ttl });
    console.log(`[PRIX] ✅ ${mintAddress.slice(0,8)}... = $${fresh.priceUsd.toExponential(4)} [${fresh.sources.join(',')}] (conf: ${(fresh.confidence*100).toFixed(0)}%)`);
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
      headers: { 'User-Agent': 'SolBot-Pro/3.5' },
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
  } catch (err) {
    console.warn(`[META] Jupiter échec pour ${mintAddress.slice(0,8)}...`);
  }

  // SOURCE 2: Solana Token List
  try {
    const res = await fetch('https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json', {
      headers: { 'User-Agent': 'SolBot-Pro/3.5' },
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
  } catch (err) {
    console.warn(`[META] Solana Token List échec pour ${mintAddress.slice(0,8)}...`);
  }

  // SOURCE 3: Metaplex API
  try {
    const res = await fetch(`https://api.metaplex.com/v1/metadata/${mintAddress}`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.5' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.metadata?.image) metadata.logo = data.metadata.image;
      if (data?.metadata?.symbol) metadata.symbol = data.metadata.symbol;
      if (data?.metadata?.name) metadata.name = data.metadata.name;
    }
  } catch (err) {
    console.warn(`[META] Metaplex échec pour ${mintAddress.slice(0,8)}...`);
  }

  // SOURCE 4: DexScreener
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.5' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.pairs?.[0]?.baseToken?.logoURI) metadata.logo = data.pairs[0].baseToken.logoURI;
      if (data.pairs?.[0]?.baseToken?.symbol && metadata.symbol === '???') {
        metadata.symbol = data.pairs[0].baseToken.symbol;
      }
    }
  } catch (err) {
    console.warn(`[META] DexScreener échec pour ${mintAddress.slice(0,8)}...`);
  }

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
      console.log(`[JUPITER] Tentative ${attempt}/${maxRetries} : Quote pour ${amountRaw} unités`);
      
      // Quote
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const quoteRes = await fetch(quoteUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'SolBot-Pro/3.5' }
      });
      clearTimeout(timeoutId);
      
      if (!quoteRes.ok) {
        const errorText = await quoteRes.text();
        throw new Error(`Quote HTTP ${quoteRes.status}: ${errorText}`);
      }
      
      const quote = await quoteRes.json();
      console.log(`[JUPITER] Quote: ${(quote.outAmount / 1e9).toFixed(6)} SOL`);
      
      // Swap
      const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json", 'User-Agent': 'SolBot-Pro/3.5' },
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
      
      // Signature et envoi
      const connection = getConnection();
      const txBuffer = Buffer.from(swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuffer);
      tx.sign([keypair]);
      
      const txId = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: txId, ...latestBlockhash }, "confirmed");
      
      console.log(`[JUPITER] ✅ Confirmé : ${txId}`);
      return txId;
      
    } catch (err) {
      console.warn(`[JUPITER] ⚠️ Tentative ${attempt} échouée : ${err.message}`);
      
      if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNRESET') || err.message.includes('ETIMEDOUT')) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[JUPITER] ⏳ Retry dans ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (attempt === maxRetries) throw err;
    }
  }
  throw new Error('Échec après toutes les tentatives');
}

// ════════════════════════════════════════════════════════════════
// LOGIQUE DE VENTE — Marque les paliers UNIQUEMENT après succès
// ════════════════════════════════════════════════════════════════

async function applySellLogic(mintAddress, balance, decimals, currentPrice, pnl) {
  console.log(`[DEBUG VENTE] ${mintAddress.slice(0,8)}... | AUTO_SELL: ${CONFIG.AUTO_SELL} | PnL: ${pnl} | Balance: ${balance}`);
  
  if (!CONFIG.AUTO_SELL) { console.log(`[VENTE BLOQUÉE] AUTO_SELL = false`); return; }
  if (pnl === null) { console.log(`[VENTE BLOQUÉE] PnL = null`); return; }
  if (balance <= 0) { console.log(`[VENTE BLOQUÉE] Balance = ${balance}`); return; }

  const rawAmount = Math.floor(balance * Math.pow(10, decimals));

  // 🛡️ STOP-LOSS
  if (CONFIG.STOP_LOSS_ENABLED && pnl <= CONFIG.STOP_LOSS_THRESHOLD) {
    console.log(`[🛡️ STOP-LOSS] ${mintAddress.slice(0,8)}... : Seuil atteint (${pnl.toFixed(2)}%)`);
    try {
      const txId = await jupiterSell(mintAddress, rawAmount, CONFIG.SLIPPAGE_BPS);
      console.log(`[✅ STOP-LOSS] Vente totale : ${txId}`);
    } catch (err) {
      console.error(`[❌ STOP-LOSS] ÉCHEC : ${err.message}`);
    }
    return;
  }

  // 🎯 PALIERS DE PROFITS
  for (let i = 0; i < CONFIG.TIERS.length; i++) {
    const tierKey = `${mintAddress}_tier_${i}`;
    const tier = CONFIG.TIERS[i];

    // Réinitialiser si PnL redescend significativement
    if (triggeredTiers[tierKey] && pnl < tier.targetPnl - 10) {
      delete triggeredTiers[tierKey];
      console.log(`[PALIER RESET] ${mintAddress.slice(0,8)}... : Palier ${i+1} réinitialisé`);
    }

    if (!triggeredTiers[tierKey] && pnl >= tier.targetPnl) {
      const sellPercent = tier.sellPercent / 100;
      const amountToSell = Math.floor(rawAmount * sellPercent);

      console.log(`[🎯 PALIER ${i+1}] ${mintAddress.slice(0,8)}... : +${pnl.toFixed(2)}% → Vente de ${tier.sellPercent}% (${amountToSell} unités)`);

      if (amountToSell > 0) {
        try {
          const txId = await jupiterSell(mintAddress, amountToSell, CONFIG.SLIPPAGE_BPS);
          // ✅ Marquer comme déclenché SEULEMENT après succès
          triggeredTiers[tierKey] = true;
          console.log(`[✅ PALIER ${i+1}] Vente confirmée : ${txId}`);
        } catch (err) {
          console.error(`[❌ PALIER ${i+1}] ÉCHEC : ${err.message}`);
          console.log(`[⚠️ PALIER ${i+1}] NON marqué — réessai au prochain cycle`);
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

    // 1. Tokens du wallet
    const allAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );

    const walletTokens = allAccounts.value.map(acc => acc.account.data.parsed.info.mint);
    console.log(`[BOT] Wallet: ${walletTokens.length} tokens détectés`);

    // 2. Combiner avec tokens manuels
    const allTokensToCheck = [...walletTokens, ...manualTokens, ...dynamicTokens];
    const uniqueTokens = [...new Set(allTokensToCheck)];
    console.log(`[BOT] Analyse de ${uniqueTokens.length} token(s)...`);

    // 3. Boucler sur chaque token
    for (const mintAddress of uniqueTokens) {
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
          console.log(`[MANUAL] ⚠️ ${mintAddress.slice(0,8)}... : Token manuel mais PAS dans le wallet`);
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
      const valueUsd = balance * currentPrice;

      // 6. Prix de référence
      if (hasPrice && !autoBuyPrices[mintAddress]) {
        autoBuyPrices[mintAddress] = currentPrice;
        console.log(`[PRIX REF] ${mintAddress.slice(0,8)}... = $${currentPrice.toExponential(4)}`);
      }

      // 7. PnL
      let pnl = null, pnlStr = "N/A";
      if (hasPrice && autoBuyPrices[mintAddress]) {
        const buyPrice = autoBuyPrices[mintAddress];
        pnl = ((currentPrice - buyPrice) / buyPrice) * 100;
        pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
      }

      // 8. Métadonnées
      const metadata = await fetchTokenMetadata(mintAddress);
      const tokenSymbol = metadata.symbol !== '???' ? metadata.symbol : '???';
      const tokenName = metadata.name || 'Unknown';

      // 9. Afficher
      const manualBadge = isManual ? '📋' : '';
      const walletBadge = isInWallet ? '✅' : '❌';

      if (hasPrice) {
        const cacheMark = priceData.fromCache ? '📦' : '🔄';
        const confMark = priceConfidence >= 0.8 ? '✅' : priceConfidence >= 0.5 ? '⚠️' : '❓';
        console.log(
          `[TOKEN] ${manualBadge}${walletBadge}${cacheMark}${confMark} ${tokenSymbol} (${tokenName}) | ` +
          `Address: ${mintAddress} | Balance: ${balance.toFixed(4)} | ` +
          `Prix: $${currentPrice.toExponential(4)} [${priceSource}] | Valeur: $${valueUsd.toFixed(2)} | ` +
          `PnL: ${pnlStr} | Liquidité: $${Math.round(liquidity).toLocaleString()} | Conf: ${(priceConfidence*100).toFixed(0)}%`
        );
      } else {
        console.log(
          `[TOKEN] ${manualBadge}${walletBadge}❓ ${tokenSymbol} (${tokenName}) | ` +
          `Address: ${mintAddress} | Balance: ${balance.toFixed(4)} | Prix: ❌ NON TROUVÉ`
        );
      }

      // 10. Vente auto (seulement si dans wallet avec balance > 0)
      if (hasPrice && isInWallet && balance > 0) {
        await applySellLogic(mintAddress, balance, decimals, currentPrice, pnl);
      }

      // 11. Stocker pour API
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
// API HTTP — CORS + endpoints complets
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
          console.log(`[MANUAL] ✅ Ajouté : ${address.slice(0,8)}...`);
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
          console.log(`[MANUAL] ❌ Supprimé : ${address.slice(0,8)}...`);
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
        priceStats: { cached: priceCache.size, highConfidence: lastTokensData.filter(t => t.priceConfidence >= 0.8).length }
      }));
      return;
    }

    // GET /
    if (req.url === '/') {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('🤖 SolBot Pro v3.5 API\nEndpoints: GET /api/tokens | POST /api/tokens/add | DELETE /api/tokens/remove | GET /api/status');
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });

  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log(`[HTTP] ✅ API sur le port ${PORT}`);
    console.log(`[HTTP] 📡 Endpoints: /api/tokens | /api/tokens/add | /api/tokens/remove | /api/status`);
  });
}

// ════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  🤖 SolBot Pro v3.5 — Pump.fun Edition");
  console.log(`  RPC        : ${RPC_URL}`);
  console.log(`  Intervalle : ${CONFIG.INTERVAL_SEC}s`);
  console.log(`  Auto-sell  : ${CONFIG.AUTO_SELL}`);
  console.log(`  Stop-loss  : ${CONFIG.STOP_LOSS_ENABLED} (${CONFIG.STOP_LOSS_THRESHOLD}%)`);
  console.log("═══════════════════════════════════════════");
  console.log("  🎯 Features:");
  console.log("  • Pump.fun API (tokens pump.fun) ✅ NOUVEAU");
  console.log("  • Weighted Price (5 sources actives + fallback)");
  console.log("  • Jupiter Price: DÉSACTIVÉ (ne répond pas)");
  console.log("  • Smart Cache TTL dynamique");
  console.log("  • Confidence Score API");
  console.log("  • Tokens Manuels + Vente Auto si dans wallet");
  console.log("  • Logos Multi-sources avec placeholder");
  console.log("  • Retry Jupiter Swap + exponential backoff");
  console.log("  • Headers User-Agent pour éviter rate-limit");
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
