// ═══════════════════════════════════════════════════════════════
// SolBot Pro v3.2 — Ultimate Edition
// Backend Node.js pour Solana Trading Automatique
// Hébergement : Render (Background Worker + API Web)
// Features: Weighted Price + Smart Cache + Confidence + Manual Tokens + Logos
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

// 🧠 STOCKAGE AUTO DES PRIX DE RÉFÉRENCE (par token)
const autoBuyPrices = {};

// 🧠 CACHE DES MÉTADONNÉES DE TOKENS (nom, symbole, logo)
const tokenMetadataCache = {};

// 🧠 SUIVI DES PALIERS DÉCLENCHÉS (par token)
const triggeredTiers = {};

// 🧠 CACHE INTELLIGENT DES PRIX AVEC TTL DYNAMIQUE
const priceCache = new Map();
const CACHE_TTL = {
  high: 30000,    // 30s pour liquidité >= $1M
  medium: 60000,  // 1min pour $100K-$1M
  low: 120000,    // 2min pour $1K-$100K
  none: 300000,   // 5min pour tokens sans prix
};

// 📋 LISTE MANUELLE DE TOKENS À SURVEILLER
let manualTokens = [];
let dynamicTokens = [];

// Charger les tokens manuels depuis les variables d'environnement
if (process.env.MANUAL_TOKENS) {
  try {
    manualTokens = JSON.parse(process.env.MANUAL_TOKENS);
    console.log(`[MANUAL] ${manualTokens.length} token(s) chargés depuis MANUAL_TOKENS`);
  } catch (e) {
    console.warn('[MANUAL] Erreur de parsing MANUAL_TOKENS');
  }
}

// 📦 Données pour l'API web
let lastTokensData = [];

// ════════════════════════════════════════════════════════════════
// INITIALISATION DU WALLET
// ════════════════════════════════════════════════════════════════

function initWallet() {
  if (!PRIVATE_KEY_RAW) {
    console.error("[ERREUR] Variable d'environnement PRIVATE_KEY manquante.");
    process.exit(1);
  }
  try {
    const secretBytes = JSON.parse(PRIVATE_KEY_RAW);
    keypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
    console.log(`[WALLET] Connecté : ${keypair.publicKey.toString()}`);
  } catch (err) {
    console.error("[ERREUR] Impossible de lire PRIVATE_KEY :", err.message);
    process.exit(1);
  }
}

function getConnection() {
  return new Connection(RPC_URL, "confirmed");
}

// ════════════════════════════════════════════════════════════════
// 🎯 PRIX AGGREGÉ AVEC MOYENNE PONDÉRÉE (Weighted Average)
// ════════════════════════════════════════════════════════════════

async function getWeightedPrice(mintAddress) {
  const sources = [
    { name: 'DexScreener', fetch: () => fetchDexScreenerPrice(mintAddress), weight: 3 },
    { name: 'Jupiter', fetch: () => fetchJupiterPrice(mintAddress), weight: 4 },
    { name: 'Birdeye', fetch: () => fetchBirdeyePrice(mintAddress), weight: 2 },
    { name: 'CoinGecko', fetch: () => fetchCoinGeckoPrice(mintAddress), weight: 1 },
    { name: 'Helius', fetch: () => fetchHeliusPrice(mintAddress), weight: 2 },
  ];

  const results = await Promise.allSettled(
    sources.map(src => src.fetch().then(data => ({ ...data, source: src.name, weight: src.weight })))
  );

  const validPrices = results
    .filter(r => r.status === 'fulfilled' && r.value?.priceUsd > 0)
    .map(r => r.value);

  if (validPrices.length === 0) return null;

  const weightedSum = validPrices.reduce((sum, p) => sum + p.priceUsd * p.weight, 0);
  const totalWeight = validPrices.reduce((sum, p) => sum + p.weight, 0);
  const confidence = validPrices.length / sources.length;

  return {
    priceUsd: weightedSum / totalWeight,
    confidence: Math.min(confidence, 1.0),
    sources: validPrices.map(p => p.source),
    liquidityUsd: validPrices.find(p => p.liquidityUsd)?.liquidityUsd || 0,
    change24h: validPrices.find(p => p.change24h)?.change24h || 0
  };
}

// ── Sources individuelles ───────────────────────────────────────

async function fetchDexScreenerPrice(mintAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs?.length) return null;
    const bestPair = data.pairs
      .filter(p => p.chainId === "solana")
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!bestPair?.priceUsd) return null;
    return {
      priceUsd: parseFloat(bestPair.priceUsd),
      liquidityUsd: bestPair.liquidity?.usd || 0,
      change24h: bestPair.priceChange?.h24 || 0
    };
  } catch { return null; }
}

async function fetchJupiterPrice(mintAddress) {
  try {
    const url = `https://price.jup.ag/v6/price?ids=${mintAddress}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data?.[mintAddress]?.price) return null;
    const p = data.data[mintAddress];
    return { priceUsd: p.price, change24h: p.change24h || 0 };
  } catch { return null; }
}

async function fetchBirdeyePrice(mintAddress) {
  try {
    const url = `https://public-api.birdeye.so/defi/price?address=${mintAddress}`;
    const res = await fetch(url, { headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || 'demo' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success?.data?.value) return null;
    return { priceUsd: data.data.value };
  } catch { return null; }
}

async function fetchCoinGeckoPrice(mintAddress) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mintAddress}&vs_currencies=usd`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const key = mintAddress.toLowerCase();
    if (!data[key]?.usd) return null;
    return { priceUsd: data[key].usd };
  } catch { return null; }
}

async function fetchHeliusPrice(mintAddress) {
  try {
    const apiKey = process.env.HELIUS_API_KEY || 'demo';
    const url = `https://api.helius.xyz/v0/tokens?ids=${mintAddress}&api-key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data?.[mintAddress]?.price_info?.price_per_token) return null;
    const t = data.data[mintAddress];
    return {
      priceUsd: t.price_info.price_per_token,
      liquidityUsd: t.liquidity_info?.total_liquidity_usd || 0
    };
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════
// 🧠 CACHE INTELLIGENT AVEC TTL DYNAMIQUE
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
    priceCache.set(mintAddress, { data: fresh, timestamp: now, ttl });
    console.log(`[PRIX] ✅ ${mintAddress.slice(0,8)}... = $${fresh.priceUsd.toExponential(4)} [${fresh.sources.join(',')}] (conf: ${(fresh.confidence*100).toFixed(0)}%)`);
  }

  return fresh ? { ...fresh, fromCache: false } : null;
}

// ════════════════════════════════════════════════════════════════
// 🖼️ RÉCUPÉRATION DES MÉTADONNÉES + LOGOS (Multi-sources)
// ════════════════════════════════════════════════════════════════

async function fetchTokenMetadata(mintAddress) {
  if (tokenMetadataCache[mintAddress]) {
    return tokenMetadataCache[mintAddress];
  }

  let metadata = { symbol: '???', name: 'Unknown', logo: null };

  // SOURCE 1: Jupiter Token List
  try {
    const response = await fetch('https://tokens.jup.ag/tokens');
    if (response.ok) {
      const tokens = await response.json();
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
    const response = await fetch('https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json');
    if (response.ok) {
      const data = await response.json();
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
    const response = await fetch(`https://api.metaplex.com/v1/metadata/${mintAddress}`);
    if (response.ok) {
      const data = await response.json();
      if (data?.metadata?.image) metadata.logo = data.metadata.image;
      if (data?.metadata?.symbol) metadata.symbol = data.metadata.symbol;
      if (data?.metadata?.name) metadata.name = data.metadata.name;
    }
  } catch (err) {
    console.warn(`[META] Metaplex échec pour ${mintAddress.slice(0,8)}...`);
  }

  // SOURCE 4: DexScreener
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    if (response.ok) {
      const data = await response.json();
      if (data.pairs?.[0]?.baseToken?.logoURI) metadata.logo = data.pairs[0].baseToken.logoURI;
      if (data.pairs?.[0]?.baseToken?.symbol && metadata.symbol === '???') {
        metadata.symbol = data.pairs[0].baseToken.symbol;
      }
    }
  } catch (err) {
    console.warn(`[META] DexScreener échec pour ${mintAddress.slice(0,8)}...`);
  }

  // SOURCE 5: Fallback avec placeholder coloré
  if (!metadata.logo && metadata.symbol !== '???') {
    const firstChar = metadata.symbol.charAt(0).toUpperCase();
    const colors = ['#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899'];
    const colorIndex = firstChar.charCodeAt(0) % colors.length;
    metadata.logo = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${colors[colorIndex]}"/><text x="16" y="22" font-size="18" font-weight="bold" fill="white" text-anchor="middle" font-family="Arial">${firstChar}</text></svg>`)}`;
  }

  tokenMetadataCache[mintAddress] = metadata;
  return metadata;
}

// ════════════════════════════════════════════════════════════════
// VENTE VIA JUPITER AGGREGATOR V6
// ════════════════════════════════════════════════════════════════

async function jupiterSell(mintAddress, amountRaw, slippageBps) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  console.log(`[JUPITER] Demande de quote : ${amountRaw} unités → SOL`);

  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Quote échouée (${quoteRes.status}) : ${await quoteRes.text()}`);
  
  const quote = await quoteRes.json();
  console.log(`[JUPITER] Quote reçu. SOL estimé : ${(quote.outAmount / 1e9).toFixed(6)}`);

  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      computeUnitPriceMicroLamports: "auto",
    }),
  });

  if (!swapRes.ok) throw new Error(`Swap tx échouée (${swapRes.status}) : ${await swapRes.text()}`);
  const { swapTransaction } = await swapRes.json();

  const connection = getConnection();
  const txBuffer = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);

  const txId = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: txId, ...latestBlockhash }, "confirmed");

  console.log(`[JUPITER] ✅ Transaction confirmée : ${txId}`);
  return txId;
}

// ════════════════════════════════════════════════════════════════
// LOGIQUE DE VENTE — Stop-loss et paliers INDÉPENDANTS par token
// ════════════════════════════════════════════════════════════════

async function applySellLogic(mintAddress, balance, decimals, currentPrice, pnl) {
  if (!CONFIG.AUTO_SELL || pnl === null) return;

  const rawAmount = Math.floor(balance * Math.pow(10, decimals));

  // 🛡️ STOP-LOSS
  if (CONFIG.STOP_LOSS_ENABLED && pnl <= CONFIG.STOP_LOSS_THRESHOLD) {
    console.log(`[🛡️ STOP-LOSS] ${mintAddress.slice(0,8)}... : Seuil atteint (${pnl.toFixed(2)}%)`);
    try {
      await jupiterSell(mintAddress, rawAmount, CONFIG.SLIPPAGE_BPS);
      console.log(`[✅ STOP-LOSS] Vente totale de ${mintAddress.slice(0,8)}... exécutée`);
    } catch (err) {
      console.error(`[❌ STOP-LOSS] Échec : ${err.message}`);
    }
    return;
  }

  // 🎯 PALIERS DE PROFITS
  for (let i = 0; i < CONFIG.TIERS.length; i++) {
    const tierKey = `${mintAddress}_tier_${i}`;
    const tier = CONFIG.TIERS[i];

    if (!triggeredTiers[tierKey] && pnl >= tier.targetPnl) {
      triggeredTiers[tierKey] = true;
      const sellPercent = tier.sellPercent / 100;
      const amountToSell = Math.floor(rawAmount * sellPercent);

      if (amountToSell > 0) {
        console.log(`[🎯 PALIER ${i+1}] ${mintAddress.slice(0,8)}... : +${pnl.toFixed(2)}% → Vente de ${tier.sellPercent}%`);
        try {
          await jupiterSell(mintAddress, amountToSell, CONFIG.SLIPPAGE_BPS);
          console.log(`[✅ PALIER ${i+1}] Vente exécutée`);
        } catch (err) {
          console.error(`[❌ PALIER ${i+1}] Échec : ${err.message}`);
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
// BOUCLE DE SURVEILLANCE — Wallet + Tokens Manuels
// ════════════════════════════════════════════════════════════════

async function runCheck() {
  try {
    const connection = getConnection();
    const tokenDataForAPI = [];

    // 1. Récupérer les tokens du wallet
    const allAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );

    const walletTokens = allAccounts.value.map(acc => acc.account.data.parsed.info.mint);
    console.log(`[BOT] Wallet: ${walletTokens.length} tokens détectés`);

    // 2. Combiner avec les tokens manuels
    const allTokensToCheck = [...walletTokens, ...manualTokens, ...dynamicTokens];
    const uniqueTokens = [...new Set(allTokensToCheck)];
    console.log(`[BOT] Analyse de ${uniqueTokens.length} token(s) (wallet + manuels)...`);

    // 3. Boucler sur chaque token
    for (const mintAddress of uniqueTokens) {
      const isManual = manualTokens.includes(mintAddress) || dynamicTokens.includes(mintAddress);
      if (mintAddress === "So11111111111111111111111111111111111111112") continue;

      let balance = 0;
      let decimals = 6;
      let isInWallet = false;

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

      // 6. Auto-détection du prix de référence
      if (hasPrice && !autoBuyPrices[mintAddress]) {
        autoBuyPrices[mintAddress] = currentPrice;
        console.log(`[PRIX REF] ${mintAddress.slice(0,8)}... enregistré à $${currentPrice.toExponential(4)}`);
      }

      // 7. Calculer le PnL
      let pnl = null;
      let pnlStr = "N/A";
      if (hasPrice && autoBuyPrices[mintAddress]) {
        const buyPrice = autoBuyPrices[mintAddress];
        pnl = ((currentPrice - buyPrice) / buyPrice) * 100;
        pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
      }

      // 8. Récupérer les métadonnées
      const metadata = await fetchTokenMetadata(mintAddress);
      const tokenSymbol = metadata.symbol !== '???' ? metadata.symbol : '???';
      const tokenName = metadata.name || 'Unknown';

      // 9. Afficher le token
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

      // 10. Vente auto (seulement si dans le wallet avec balance > 0)
      if (hasPrice && isInWallet && balance > 0) {
        await applySellLogic(mintAddress, balance, decimals, currentPrice, pnl);
      }

      // 11. Stocker pour l'API
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
    console.error("[BOT] Erreur dans runCheck :", err.message);
  }
}

// ════════════════════════════════════════════════════════════════
// 🌐 API HTTP POUR L'INTERFACE WEB
// ════════════════════════════════════════════════════════════════

if (process.env.RENDER) {
  const http = require('http');

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
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

    // POST /api/tokens/add
    if (req.url === '/api/tokens/add' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { address, name, symbol } = data;
          if (!address || address.length < 32) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: 'Adresse invalide' }));
            return;
          }
          if (manualTokens.includes(address) || dynamicTokens.includes(address)) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: 'Token déjà dans la liste' }));
            return;
          }
          dynamicTokens.push(address);
          if (name || symbol) {
            tokenMetadataCache[address] = { symbol: symbol || '???', name: name || 'Unknown', logo: null };
          }
          console.log(`[MANUAL] ✅ Token ajouté : ${address.slice(0,8)}...`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Token ajouté', address, totalManual: manualTokens.length, totalDynamic: dynamicTokens.length }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'JSON invalide' }));
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
          const data = JSON.parse(body);
          const { address } = data;
          const manualIndex = manualTokens.indexOf(address);
          const dynamicIndex = dynamicTokens.indexOf(address);
          if (manualIndex > -1) manualTokens.splice(manualIndex, 1);
          else if (dynamicIndex > -1) dynamicTokens.splice(dynamicIndex, 1);
          else {
            res.writeHead(404);
            res.end(JSON.stringify({ success: false, error: 'Token non trouvé' }));
            return;
          }
          console.log(`[MANUAL] ❌ Token supprimé : ${address.slice(0,8)}...`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Token supprimé', address }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'JSON invalide' }));
        }
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
      res.end('🤖 SolBot Pro v3.2 API\nEndpoints: GET /api/tokens | POST /api/tokens/add | DELETE /api/tokens/remove | GET /api/status');
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log(`[HTTP] ✅ API sur le port ${PORT}`);
    console.log(`[HTTP] 📡 Endpoints: /api/tokens | /api/tokens/add | /api/tokens/remove | /api/status`);
    console.log(`[HTTP] 📋 Tokens manuels: ${manualTokens.length} chargés`);
  });
}

// ════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  🤖 SolBot Pro v3.2 — Ultimate Edition");
  console.log(`  RPC        : ${RPC_URL}`);
  console.log(`  Intervalle : ${CONFIG.INTERVAL_SEC}s`);
  console.log(`  Auto-sell  : ${CONFIG.AUTO_SELL}`);
  console.log(`  Stop-loss  : ${CONFIG.STOP_LOSS_ENABLED} (${CONFIG.STOP_LOSS_THRESHOLD}%)`);
  console.log("═══════════════════════════════════════════");
  console.log("  🎯 Features:");
  console.log("  • Weighted Average Price (5 sources)");
  console.log("  • Smart Cache TTL dynamique");
  console.log("  • Confidence Score API");
  console.log("  • Tokens Manuels + Vente Auto");
  console.log("  • Logos Multi-sources");
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
