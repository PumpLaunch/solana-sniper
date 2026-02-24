// ═══════════════════════════════════════════════════════════════
// SolBot Pro — Backend Node.js
// Hébergement : Render (Background Worker + API Web)
// Version : 2.0 — Multi-sources de prix + Affichage complet
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
let stopLossTriggered = false;

// 🧠 STOCKAGE AUTO DES PRIX DE RÉFÉRENCE (par token)
const autoBuyPrices = {};

// 🧠 CACHE DES MÉTADONNÉES DE TOKENS (nom, symbole)
const tokenMetadataCache = {};

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
// FETCH DU PRIX VIA MULTIPLES SOURCES (5 APIs en cascade)
// ════════════════════════════════════════════════════════════════

async function fetchTokenPrice(mintAddress) {
  
  // ── SOURCE 1: DEXSCREENER ─────────────────────────────────────
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.pairs && data.pairs.length > 0) {
        const bestPair = data.pairs
          .filter(p => p.chainId === "solana")
          .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        if (bestPair && bestPair.priceUsd) {
          return {
            priceUsd: parseFloat(bestPair.priceUsd) || 0,
            priceNative: parseFloat(bestPair.priceNative) || 0,
            change24h: bestPair.priceChange?.h24 || 0,
            liquidityUsd: bestPair.liquidity?.usd || 0,
            pairAddress: bestPair.pairAddress,
            source: 'DexScreener'
          };
        }
      }
    }
  } catch (err) {
    console.warn(`[PRIX] DexScreener échec pour ${mintAddress.slice(0,8)}...`);
  }
  
  // ── SOURCE 2: JUPITER PRICE API ───────────────────────────────
  try {
    const url = `https://price.jup.ag/v6/price?ids=${mintAddress}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.data && data.data[mintAddress]) {
        const p = data.data[mintAddress];
        return {
          priceUsd: p.price || 0,
          priceNative: p.price / 1e-6 || 0,
          change24h: p.change24h || 0,
          liquidityUsd: 0,
          pairAddress: null,
          source: 'Jupiter'
        };
      }
    }
  } catch (err) {
    console.warn(`[PRIX] Jupiter échec pour ${mintAddress.slice(0,8)}...`);
  }
  
  // ── SOURCE 3: BIRDEYE API ─────────────────────────────────────
  try {
    const url = `https://public-api.birdeye.so/defi/price?address=${mintAddress}`;
    const res = await fetch(url, { 
      headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || 'demo' } 
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.data && data.data.value) {
        return {
          priceUsd: data.data.value || 0,
          priceNative: 0,
          change24h: 0,
          liquidityUsd: 0,
          pairAddress: null,
          source: 'Birdeye'
        };
      }
    }
  } catch (err) {
    console.warn(`[PRIX] Birdeye échec pour ${mintAddress.slice(0,8)}...`);
  }
  
  // ── SOURCE 4: COINGECKO API ───────────────────────────────────
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mintAddress}&vs_currencies=usd`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const key = mintAddress.toLowerCase();
      if (data[key] && data[key].usd) {
        return {
          priceUsd: data[key].usd || 0,
          priceNative: 0,
          change24h: 0,
          liquidityUsd: 0,
          pairAddress: null,
          source: 'CoinGecko'
        };
      }
    }
  } catch (err) {
    console.warn(`[PRIX] CoinGecko échec pour ${mintAddress.slice(0,8)}...`);
  }
  
  // ── SOURCE 5: HELIUS TOKEN API ────────────────────────────────
  try {
    const apiKey = process.env.HELIUS_API_KEY || 'demo';
    const url = `https://api.helius.xyz/v0/tokens?ids=${mintAddress}&api-key=${apiKey}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.data && data.data[mintAddress]) {
        const t = data.data[mintAddress];
        if (t.price_info && t.price_info.price_per_token) {
          return {
            priceUsd: t.price_info.price_per_token || 0,
            priceNative: t.price_info.price_per_token / 1e-6 || 0,
            change24h: t.price_info?.percent_change_24h || 0,
            liquidityUsd: t.liquidity_info?.total_liquidity_usd || 0,
            pairAddress: null,
            source: 'Helius'
          };
        }
      }
    }
  } catch (err) {
    console.warn(`[PRIX] Helius échec pour ${mintAddress.slice(0,8)}...`);
  }
  
  // ── AUCUNE SOURCE N'A TROUVÉ DE PRIX ──────────────────────────
  return null;
}

// ════════════════════════════════════════════════════════════════
// RÉCUPÉRATION DES MÉTADONNÉES DU TOKEN (nom, symbole) via Jupiter
// ════════════════════════════════════════════════════════════════

async function fetchTokenMetadata(mintAddress) {
  if (tokenMetadataCache[mintAddress]) {
    return tokenMetadataCache[mintAddress];
  }

  try {
    const response = await fetch('https://tokens.jup.ag/tokens');
    if (!response.ok) return { symbol: '???', name: 'Unknown', logo: null };
    
    const tokens = await response.json();
    const token = tokens.find(t => t.address === mintAddress);
    
    if (token) {
      tokenMetadataCache[mintAddress] = {
        symbol: token.symbol || '???',
        name: token.name || 'Unknown',
        logo: token.logoURI || null
      };
      return tokenMetadataCache[mintAddress];
    }
    
    return { symbol: '???', name: 'Unknown', logo: null };
    
  } catch (err) {
    return { symbol: '???', name: 'Unknown', logo: null };
  }
}

// ════════════════════════════════════════════════════════════════
// RÉCUPÉRATION DE LA BALANCE TOKEN
// ════════════════════════════════════════════════════════════════

async function getTokenBalance(mintAddress) {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(mintAddress);

    const accounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { mint: mintPubkey }
    );

    if (accounts.value.length === 0) return { balance: 0, raw: 0, decimals: 6 };

    const info = accounts.value[0].account.data.parsed.info;
    return {
      balance:  info.tokenAmount.uiAmount || 0,
      raw:      parseInt(info.tokenAmount.amount),
      decimals: info.tokenAmount.decimals,
    };
  } catch (err) {
    console.error("[BALANCE] Erreur lecture balance :", err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// VENTE VIA JUPITER AGGREGATOR V6
// ════════════════════════════════════════════════════════════════

async function jupiterSell(mintAddress, amountRaw, slippageBps) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";

  console.log(`[JUPITER] Demande de quote : ${amountRaw} unités → SOL`);

  const quoteUrl =
    `https://quote-api.jup.ag/v6/quote?` +
    `inputMint=${mintAddress}` +
    `&outputMint=${SOL_MINT}` +
    `&amount=${amountRaw}` +
    `&slippageBps=${slippageBps}`;

  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    throw new Error(`Quote échouée (${quoteRes.status}) : ${await quoteRes.text()}`);
  }
  const quote = await quoteRes.json();
  console.log(`[JUPITER] Quote reçu. SOL estimé : ${(quote.outAmount / 1e9).toFixed(6)}`);

  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse:                 quote,
      userPublicKey:                 keypair.publicKey.toString(),
      wrapAndUnwrapSol:              true,
      dynamicComputeUnitLimit:       true,
      computeUnitPriceMicroLamports: "auto",
    }),
  });

  if (!swapRes.ok) {
    throw new Error(`Swap tx échouée (${swapRes.status}) : ${await swapRes.text()}`);
  }

  const { swapTransaction } = await swapRes.json();

  const connection = getConnection();
  const txBuffer   = Buffer.from(swapTransaction, "base64");
  const tx         = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);

  const txId = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries:    3,
  });

  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: txId, ...latestBlockhash },
    "confirmed"
  );

  console.log(`[JUPITER] ✅ Transaction confirmée : ${txId}`);
  return txId;
}

// ════════════════════════════════════════════════════════════════
// LOGIQUE DE VENTE — Réutilisable pour chaque token
// ════════════════════════════════════════════════════════════════

async function applySellLogic(mintAddress, balance, decimals, currentPrice, pnl) {
  if (!CONFIG.AUTO_SELL || pnl === null) return;

  const rawAmount = Math.floor(balance * Math.pow(10, decimals));

  // Stop-loss
  if (CONFIG.STOP_LOSS_ENABLED && !stopLossTriggered && pnl <= CONFIG.STOP_LOSS_THRESHOLD) {
    stopLossTriggered = true;
    console.log(`[STOP-LOSS] ${mintAddress.slice(0,8)}... : Seuil atteint (${pnl.toFixed(2)}%)`);
    await jupiterSell(mintAddress, rawAmount, CONFIG.SLIPPAGE_BPS);
    return;
  }

  // Paliers de prise de profits
  for (let i = 0; i < CONFIG.TIERS.length; i++) {
    const tier = CONFIG.TIERS[i];
    if (!tier.triggered && pnl >= tier.targetPnl) {
      tier.triggered = true;
      const sellPercent = tier.sellPercent / 100;
      const amountToSell = Math.floor(rawAmount * sellPercent);
      
      console.log(`[PALIER ${i+1}] ${mintAddress.slice(0,8)}... : +${pnl.toFixed(2)}% → Vente de ${tier.sellPercent}%`);
      
      if (amountToSell > 0) {
        await jupiterSell(mintAddress, amountToSell, CONFIG.SLIPPAGE_BPS);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
// BOUCLE DE SURVEILLANCE — TOUS LES TOKENS DU WALLET
// ════════════════════════════════════════════════════════════════

async function runCheck() {
  try {
    const connection = getConnection();
    const tokenDataForAPI = [];  // Données locales pour ce cycle

    const allAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );

    if (allAccounts.value.length === 0) {
      console.log("[BOT] Aucun token trouvé dans le wallet.");
      lastTokensData = [];
      return;
    }

    console.log(`[BOT] Analyse de ${allAccounts.value.length} token(s)...`);

    // 2. Boucler sur chaque token
    for (const account of allAccounts.value) {
      const info = account.account.data.parsed.info;
      const mintAddress = info.mint;
      const balance = parseFloat(info.tokenAmount.uiAmount) || 0;
      const decimals = info.tokenAmount.decimals;

      // Ignorer si solde nul
      if (balance <= 0) continue;

      // Ignorer le SOL natif
      if (mintAddress === "So11111111111111111111111111111111111111112") continue;

      // 3. Récupérer le prix via multiples sources
      const priceData = await fetchTokenPrice(mintAddress);
      
      // ✅ Définir les variables de prix (MÊME si pas de prix trouvé)
      const hasPrice = priceData && priceData.priceUsd > 0;
      const currentPrice = hasPrice ? priceData.priceUsd : 0;
      const liquidity = hasPrice ? priceData.liquidityUsd : 0;
      const priceSource = hasPrice ? priceData.source : null;

      // Calculer la valeur (0 si pas de prix)
      const valueUsd = balance * currentPrice;

      // 🧠 Auto-détection du prix de référence (seulement si prix disponible)
      if (hasPrice && !autoBuyPrices[mintAddress]) {
        autoBuyPrices[mintAddress] = currentPrice;
        console.log(`[PRIX REF] ${mintAddress.slice(0,8)}... enregistré à $${currentPrice.toExponential(4)}`);
      }

      // Calculer le PnL (seulement si prix disponible)
      let pnl = null;
      let pnlStr = "N/A";
      if (hasPrice && autoBuyPrices[mintAddress]) {
        const buyPrice = autoBuyPrices[mintAddress];
        pnl = ((currentPrice - buyPrice) / buyPrice) * 100;
        pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
      }

      // 🧠 Récupérer les métadonnées du token
      const metadata = await fetchTokenMetadata(mintAddress);
      const tokenSymbol = metadata.symbol !== '???' ? metadata.symbol : (info.symbol || '???');
      const tokenName = metadata.name || 'Unknown';

      // ✅ Afficher le token avec ou sans prix
      if (hasPrice) {
        console.log(
          `[TOKEN] ${tokenSymbol} (${tokenName}) | ` +
          `Address: ${mintAddress} | ` +
          `Balance: ${balance.toFixed(4)} | ` +
          `Prix: $${currentPrice.toExponential(4)} [${priceSource}] | ` +
          `Valeur: $${valueUsd.toFixed(2)} | ` +
          `PnL: ${pnlStr} | ` +
          `Liquidité: $${Math.round(liquidity).toLocaleString()}`
        );
      } else {
        console.log(
          `[TOKEN] ${tokenSymbol} (${tokenName}) | ` +
          `Address: ${mintAddress} | ` +
          `Balance: ${balance.toFixed(4)} | ` +
          `Prix: ❌ NON TROUVÉ | ` +
          `Valeur: $?.?? | ` +
          `PnL: N/A`
        );
      }

      // Appliquer la logique de vente (seulement si prix disponible)
      if (hasPrice) {
        await applySellLogic(mintAddress, balance, decimals, currentPrice, pnl);
      }

      // 📦 Stocker les données pour l'API web (TOUS les tokens)
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
        hasPrice: hasPrice
      });
    }

    // 🔄 Mettre à jour le stockage global pour l'API
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
    res.setHeader('Content-Type', 'application/json');
    
    if (req.url === '/api/tokens') {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        wallet: keypair?.publicKey?.toString() || 'N/A',
        tokens: lastTokensData,
        count: lastTokensData.length,
        timestamp: new Date().toISOString()
      }));
    } else if (req.url === '/api/status') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'running',
        wallet: keypair?.publicKey?.toString() || 'N/A',
        tokensCount: lastTokensData.length,
        uptime: process.uptime(),
        autoSell: CONFIG.AUTO_SELL,
        stopLoss: CONFIG.STOP_LOSS_ENABLED
      }));
    } else if (req.url === '/') {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('🤖 SolBot Pro API is running!\nEndpoints: /api/tokens, /api/status');
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  
  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log(`[HTTP] ✅ API disponible sur le port ${PORT}`);
    console.log(`[HTTP] 📡 Endpoints: /api/tokens | /api/status`);
  });
}

// ════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  🤖 SolBot Pro — Backend Node.js démarré");
  console.log(`  RPC        : ${RPC_URL}`);
  console.log(`  Token      : ${CONFIG.TOKEN_MINT || "Multi-tokens"}`);
  console.log(`  Intervalle : ${CONFIG.INTERVAL_SEC}s`);
  console.log(`  Auto-sell  : ${CONFIG.AUTO_SELL}`);
  console.log(`  Stop-loss  : ${CONFIG.STOP_LOSS_ENABLED} (${CONFIG.STOP_LOSS_THRESHOLD}%)`);
  console.log("═══════════════════════════════════════════");

  initWallet();

  // Premier cycle immédiat au démarrage
  await runCheck();

  // Boucle principale — maintient le processus actif sur Render
  setInterval(async () => {
    try {
      await runCheck();
    } catch (err) {
      console.error("[BOT] Erreur non gérée dans runCheck :", err.message);
    }
  }, CONFIG.INTERVAL_SEC * 1000);

  console.log("[BOT] 🔄 Surveillance active. Processus maintenu ouvert.");
}

// ── Gestion des erreurs critiques ────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Exception non capturée :", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Promesse rejetée non gérée :", reason);
});

main();
