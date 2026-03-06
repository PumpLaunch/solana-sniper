// ═══════════════════════════════════════════════════════════════
// SolBot Pro — Backend Node.js
// Hébergement : Render (Background Worker)
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
const RPC_URL         = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

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
let keypair            = null;
let stopLossTriggered  = false;

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
// FETCH DU PRIX VIA DEXSCREENER
// ════════════════════════════════════════════════════════════════

async function fetchTokenPrice(mintAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
    const res  = await fetch(url);

    if (!res.ok) {
      console.warn(`[PRIX] Réponse DexScreener non-OK : ${res.status}`);
      return null;
    }

    const data = await res.json();

    if (!data.pairs || data.pairs.length === 0) {
      console.warn("[PRIX] Aucune paire trouvée pour ce token.");
      return null;
    }

    // Sélectionner la paire Solana avec la liquidité la plus élevée
    const bestPair = data.pairs
      .filter((p) => p.chainId === "solana")
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    if (!bestPair) return null;

    return {
      priceUsd:     parseFloat(bestPair.priceUsd) || 0,
      priceNative:  parseFloat(bestPair.priceNative) || 0,
      change24h:    bestPair.priceChange?.h24 || 0,
      liquidityUsd: bestPair.liquidity?.usd || 0,
      pairAddress:  bestPair.pairAddress,
    };
  } catch (err) {
    console.error("[PRIX] Erreur fetch DexScreener :", err.message);
    return null;
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

  // Étape 1 : Quote
  const quoteUrl =
    `https://quote-api.jup.ag/v6/quote` +
    `?inputMint=${mintAddress}` +
    `&outputMint=${SOL_MINT}` +
    `&amount=${amountRaw}` +
    `&slippageBps=${slippageBps}`;

  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    throw new Error(`Quote échouée (${quoteRes.status}) : ${await quoteRes.text()}`);
  }
  const quote = await quoteRes.json();
  console.log(`[JUPITER] Quote reçu. SOL estimé : ${(quote.outAmount / 1e9).toFixed(6)}`);

  // Étape 2 : Construction de la transaction
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

  // Étape 3 : Signature et envoi
  const connection = getConnection();
  const txBuffer   = Buffer.from(swapTransaction, "base64");
  const tx         = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);

  const txId = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries:    3,
  });

  // Étape 4 : Confirmation
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: txId, ...latestBlockhash },
    "confirmed"
  );

  console.log(`[JUPITER] ✅ Transaction confirmée : ${txId}`);
  return txId;
}

// ════════════════════════════════════════════════════════════════
// BOUCLE DE SURVEILLANCE PRINCIPALE
// ════════════════════════════════════════════════════════════════

async function runCheck() {
  if (!CONFIG.TOKEN_MINT) {
    console.warn("[BOT] TOKEN_MINT non défini — surveillance suspendue.");
    return;
  }

  // 1. Récupérer le prix actuel
  const priceData = await fetchTokenPrice(CONFIG.TOKEN_MINT);
  if (!priceData) {
    console.warn("[BOT] Prix indisponible, nouvelle tentative au prochain cycle.");
    return;
  }

  // 2. Calculer le PnL
  const pnl = CONFIG.BUY_PRICE_USD > 0
    ? ((priceData.priceUsd - CONFIG.BUY_PRICE_USD) / CONFIG.BUY_PRICE_USD) * 100
    : null;

  const pnlStr = pnl !== null
    ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`
    : "PnL inconnu (BUY_PRICE_USD non défini)";

  console.log(
    `[BOT] $${priceData.priceUsd} | PnL : ${pnlStr} | ` +
    `Liquidité : $${Math.round(priceData.liquidityUsd).toLocaleString()}`
  );

  if (pnl === null) return;

  // 3. Vérification du stop-loss
  if (CONFIG.STOP_LOSS_ENABLED && !stopLossTriggered && pnl <= CONFIG.STOP_LOSS_THRESHOLD) {
    stopLossTriggered = true;
    console.log(`[STOP-LOSS] Seuil atteint (${pnl.toFixed(2)}%). Vente totale initiée.`);

    if (CONFIG.AUTO_SELL) {
      const balData = await getTokenBalance(CONFIG.TOKEN_MINT);
      if (balData && balData.raw > 0) {
        await jupiterSell(CONFIG.TOKEN_MINT, balData.raw, CONFIG.SLIPPAGE_BPS)
          .catch((err) => console.error("[STOP-LOSS] Erreur vente :", err.message));
      }
    }
    return;
  }

  // 4. Vérification des paliers de vente
  for (let i = 0; i < CONFIG.TIERS.length; i++) {
    const tier = CONFIG.TIERS[i];

    if (!tier.triggered && pnl >= tier.targetPnl) {
      tier.triggered = true;
      console.log(
        `[PALIER ${i + 1}] Atteint à ${pnlStr} → ` +
        `Vente de ${tier.sellPercent}% de la position.`
      );

      if (CONFIG.AUTO_SELL) {
        const balData = await getTokenBalance(CONFIG.TOKEN_MINT);
        if (balData && balData.raw > 0) {
          const amountRaw = Math.floor(balData.raw * (tier.sellPercent / 100));
          if (amountRaw > 0) {
            await jupiterSell(CONFIG.TOKEN_MINT, amountRaw, CONFIG.SLIPPAGE_BPS)
              .catch((err) =>
                console.error(`[PALIER ${i + 1}] Erreur vente :`, err.message)
              );
          }
        }
      } else {
        console.log(`[PALIER ${i + 1}] AUTO_SELL désactivé — palier enregistré uniquement.`);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  SolBot Pro — Backend Node.js démarré");
  console.log(`  RPC        : ${RPC_URL}`);
  console.log(`  Token      : ${CONFIG.TOKEN_MINT || "Non défini"}`);
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

  console.log("[BOT] Surveillance active. Processus maintenu ouvert.");
}

// ── Gestion des erreurs critiques ────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Exception non capturée :", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Promesse rejetée non gérée :", reason);
});

main();
