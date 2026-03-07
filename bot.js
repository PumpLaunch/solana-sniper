/**
 * SolBot Pro — Backend Node.js Production
 * Hébergement : Render (Background Worker)
 * Features: TP multi-paliers, Stop-Loss, Jupiter v6, Persistence JSON
 */
"use strict";

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

// node-fetch v3 (ESM) — import dynamique
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

// ── Variables d'environnement ────────────────────────────────────
const PRIVATE_KEY_RAW = process.env.PRIVATE_KEY;
const RPC_URL = (process.env.RPC_URL || "https://api.mainnet-beta.solana.com").trim();
const STATE_FILE = process.env.STATE_FILE || "./bot_state.json";

// ── Configuration ────────────────────────────────────────────────
const CONFIG = {
  TOKEN_MINT:           process.env.TOKEN_MINT?.trim() || "",
  BUY_PRICE_USD:        parseFloat(process.env.BUY_PRICE_USD || "0"),
  STOP_LOSS_ENABLED:    process.env.STOP_LOSS === "true",
  STOP_LOSS_THRESHOLD:  parseFloat(process.env.STOP_LOSS_PCT || "-20"),
  SLIPPAGE_BPS:         parseInt(process.env.SLIPPAGE_BPS || "100"),
  AUTO_SELL:            process.env.AUTO_SELL === "true",
  INTERVAL_SEC:         parseInt(process.env.INTERVAL_SEC || "15"),
  MIN_SOL_RESERVE:      parseFloat(process.env.MIN_SOL_RESERVE || "0.005"),
  TIERS: [
    { targetPnl: 25,  sellPercent: 25, triggered: false },
    { targetPnl: 50,  sellPercent: 25, triggered: false },
    { targetPnl: 75,  sellPercent: 25, triggered: false },
    { targetPnl: 100, sellPercent: 25, triggered: false },
  ],
};

// ── État global ──────────────────────────────────────────────────
let keypair = null;
let botState = {
  stopLossTriggered: false,
  tiers: CONFIG.TIERS.map(t => ({ ...t })),
  lastCheck: null,
};

// ════════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { tries = 3, baseMs = 500, label = "" } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < tries - 1) {
        const delay = baseMs * 2 ** i;
        console.warn(`[${label}] retry ${i+1}/${tries} in ${delay}ms — ${err.message}`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function log(level, msg, data = null) {
  const safe = String(msg).replace(/PRIVATE_KEY[=:]\S+/gi, "PRIVATE_KEY=[REDACTED]");
  const suffix = data ? ` ${JSON.stringify(data).slice(0, 300)}` : "";
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${safe}${suffix}`);
}

function saveState() {
  try {
    require("fs").writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2), "utf8");
  } catch (err) {
    log("warn", "State save failed", { err: err.message });
  }
}

function loadState() {
  try {
    const fs = require("fs");
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (raw.tiers?.length === CONFIG.TIERS.length) {
        botState.tiers = raw.tiers;
        botState.stopLossTriggered = !!raw.stopLossTriggered;
        log("info", "State restored", { triggered: botState.stopLossTriggered });
      }
    }
  } catch (err) {
    log("warn", "State load failed — clean start", { err: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// WALLET & CONNECTION
// ════════════════════════════════════════════════════════════════

function initWallet() {
  if (!PRIVATE_KEY_RAW) {
    console.error("[ERREUR] PRIVATE_KEY manquante");
    process.exit(1);
  }
  try {
    const secret = PRIVATE_KEY_RAW.startsWith("[")
      ? Uint8Array.from(JSON.parse(PRIVATE_KEY_RAW))
      : Buffer.from(PRIVATE_KEY_RAW, "base64");
    keypair = Keypair.fromSecretKey(secret);
    log("info", "Wallet loaded", { address: keypair.publicKey.toString().slice(0, 8) + "..." });
  } catch (err) {
    console.error("[ERREUR] Clé invalide:", err.message);
    process.exit(1);
  }
}

function getConnection() {
  return new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });
}

async function getSolBalance() {
  try {
    const bal = await getConnection().getBalance(keypair.publicKey);
    return bal / LAMPORTS_PER_SOL;
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════
// PRICE FETCH — DexScreener
// ════════════════════════════════════════════════════════════════

async function fetchTokenPrice(mintAddress) {
  try {
    // URL corrigée : pas d'espace avant ${mintAddress}
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress.trim()}`;
    const res = await withRetry(() => fetch(url, { signal: AbortSignal.timeout(10000) }), { label: "DexScreener" });

    if (!res.ok) {
      log("warn", "DexScreener HTTP error", { status: res.status });
      return null;
    }

    const data = await res.json();
    if (!data.pairs?.length) return null;

    const bestPair = data.pairs
      .filter(p => p.chainId === "solana")
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    if (!bestPair?.priceUsd) return null;

    return {
      priceUsd: parseFloat(bestPair.priceUsd),
      priceNative: parseFloat(bestPair.priceNative) || 0,
      change24h: bestPair.priceChange?.h24 || 0,
      liquidityUsd: bestPair.liquidity?.usd || 0,
      pairAddress: bestPair.pairAddress,
    };
  } catch (err) {
    log("error", "Price fetch failed", { err: err.message });
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// BALANCE CHECK
// ════════════════════════════════════════════════════════════════

async function getTokenBalance(mintAddress) {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(mintAddress.trim());

    const accounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { mint: mintPubkey }
    );

    if (!accounts.value.length) return { balance: 0, raw: 0, decimals: 6 };

    const info = accounts.value[0].account.data.parsed.info;
    return {
      balance: info.tokenAmount.uiAmount || 0,
      raw: BigInt(info.tokenAmount.amount),
      decimals: info.tokenAmount.decimals,
    };
  } catch (err) {
    log("error", "Balance fetch failed", { err: err.message });
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// JUPITER SELL — v6 avec fallback
// ════════════════════════════════════════════════════════════════

async function jupiterSell(mintAddress, amountRaw, slippageBps) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const QUOTE_ENDPOINTS = [
    "https://quote-api.jup.ag/v6/quote",
    "https://lite-api.jup.ag/swap/v1/quote",
  ];

  log("info", "Jupiter sell request", { mint: mintAddress.slice(0, 8), amount: amountRaw.toString(), slippageBps });

  // Étape 1 : Quote avec fallback
  let quote = null, lastQuoteErr = null;
  for (const baseUrl of QUOTE_ENDPOINTS) {
    try {
      const url = `${baseUrl}?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { lastQuoteErr = new Error(`Quote ${res.status}`); continue; }
      const q = await res.json();
      if (q.error) { lastQuoteErr = new Error(q.error); continue; }
      if (!q.outAmount) { lastQuoteErr = new Error("No outAmount"); continue; }
      quote = q; break;
    } catch (err) { lastQuoteErr = err; }
  }
  if (!quote) throw lastQuoteErr || new Error("Tous les endpoints quote ont échoué");

  log("info", "Quote received", { outAmount: quote.outAmount, priceImpactPct: quote.priceImpactPct });

  // Étape 2 : Swap transaction
  const SWAP_ENDPOINTS = [
    "https://quote-api.jup.ag/v6/swap",
    "https://lite-api.jup.ag/swap/v1/swap",
  ];

  let swapTx = null, lastSwapErr = null;
  for (const baseUrl of SWAP_ENDPOINTS) {
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: keypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: "auto",
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) { lastSwapErr = new Error(`Swap ${res.status}`); continue; }
      const data = await res.json();
      if (!data.swapTransaction) { lastSwapErr = new Error("No swapTransaction"); continue; }
      swapTx = data.swapTransaction; break;
    } catch (err) { lastSwapErr = err; }
  }
  if (!swapTx) throw lastSwapErr || new Error("Tous les endpoints swap ont échoué");

  // Étape 3 : Signature et envoi
  const connection = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
  tx.sign([keypair]);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });

  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (confirmation.value.err) throw new Error(`Tx rejected: ${JSON.stringify(confirmation.value.err)}`);

  log("success", "Swap confirmed", { signature: signature.slice(0, 8) + "...", txUrl: `https://solscan.io/tx/${signature}` });
  return signature;
}

// ════════════════════════════════════════════════════════════════
// MAIN CHECK LOOP
// ════════════════════════════════════════════════════════════════

async function runCheck() {
  if (!CONFIG.TOKEN_MINT) {
    log("warn", "TOKEN_MINT not set — skipping check");
    return;
  }

  botState.lastCheck = new Date().toISOString();

  // 1. Fetch price
  const priceData = await fetchTokenPrice(CONFIG.TOKEN_MINT);
  if (!priceData) {
    log("warn", "Price unavailable — retrying next cycle");
    return;
  }

  // 2. Calculate PnL
  const pnl = CONFIG.BUY_PRICE_USD > 0
    ? ((priceData.priceUsd - CONFIG.BUY_PRICE_USD) / CONFIG.BUY_PRICE_USD) * 100
    : null;

  const pnlStr = pnl !== null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%` : "N/A";
  log("info", "Price update", {
    price: `$${priceData.priceUsd}`,
    pnl: pnlStr,
    liquidity: `$${Math.round(priceData.liquidityUsd).toLocaleString()}`,
    change24h: `${priceData.change24h >= 0 ? "+" : ""}${priceData.change24h}%`,
  });

  if (pnl === null) return;

  // 3. Stop-Loss check (prioritaire)
  if (CONFIG.STOP_LOSS_ENABLED && !botState.stopLossTriggered && pnl <= CONFIG.STOP_LOSS_THRESHOLD) {
    botState.stopLossTriggered = true;
    saveState();
    log("error", "🚨 STOP-LOSS TRIGGERED", { pnl: pnlStr, threshold: `${CONFIG.STOP_LOSS_THRESHOLD}%` });

    if (CONFIG.AUTO_SELL) {
      await executeSell("STOP_LOSS", 100);
    }
    return;
  }

  // 4. Take-Profit tiers
  for (let i = 0; i < botState.tiers.length; i++) {
    const tier = botState.tiers[i];
    if (!tier.triggered && pnl >= tier.targetPnl) {
      tier.triggered = true;
      saveState();
      log("warn", `✅ TP TIER ${i + 1} HIT`, { pnl: pnlStr, sellPercent: tier.sellPercent });

      if (CONFIG.AUTO_SELL) {
        await executeSell(`TP_T${i + 1}`, tier.sellPercent);
      }
    }
  }
}

async function executeSell(reason, percent) {
  // Vérifier solde SOL pour les frais
  const solBal = await getSolBalance();
  if (solBal !== null && solBal < CONFIG.MIN_SOL_RESERVE) {
    log("error", "Insufficient SOL for fees", { balance: solBal, required: CONFIG.MIN_SOL_RESERVE });
    return;
  }

  const balData = await getTokenBalance(CONFIG.TOKEN_MINT);
  if (!balData || balData.raw <= 0n) {
    log("warn", "No tokens to sell", { balance: balData?.balance });
    return;
  }

  const amountRaw = percent >= 100 ? balData.raw : (balData.raw * BigInt(Math.floor(percent * 10))) / 1000n;
  if (amountRaw <= 0n) return;

  try {
    await jupiterSell(CONFIG.TOKEN_MINT, amountRaw.toString(), CONFIG.SLIPPAGE_BPS);
    log("success", `${reason} executed`, { percent, amountSold: (Number(amountRaw) / 10 ** (balData.decimals || 6)).toFixed(4) });
  } catch (err) {
    log("error", `${reason} failed`, { err: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  🤖 SolBot Pro — Backend Started");
  console.log(`  RPC        : ${RPC_URL.slice(0, 40)}...`);
  console.log(`  Token      : ${CONFIG.TOKEN_MINT?.slice(0, 8) + "..." || "Not set"}`);
  console.log(`  Interval   : ${CONFIG.INTERVAL_SEC}s`);
  console.log(`  Auto-sell  : ${CONFIG.AUTO_SELL}`);
  console.log(`  Stop-loss  : ${CONFIG.STOP_LOSS_ENABLED ? `${CONFIG.STOP_LOSS_THRESHOLD}%` : "OFF"}`);
  console.log("═══════════════════════════════════════════");

  initWallet();
  loadState();

  // Premier cycle immédiat
  await runCheck().catch(err => log("error", "Initial check failed", { err: err.message }));

  // Boucle principale
  setInterval(async () => {
    try {
      await runCheck();
    } catch (err) {
      log("error", "Unhandled error in runCheck", { err: err.message });
    }
  }, CONFIG.INTERVAL_SEC * 1000);

  log("info", "Bot monitoring active — process kept alive");
}

// ── Gestion des erreurs globales ────────────────────────────────
process.on("uncaughtException", (err) => {
  log("fatal", "Uncaught exception", { err: err.message, stack: err.stack?.slice(0, 500) });
});

process.on("unhandledRejection", (reason) => {
  log("fatal", "Unhandled rejection", { reason: String(reason).slice(0, 300) });
});

// Graceful shutdown
process.on("SIGINT", () => { saveState(); log("info", "Shutdown — state saved"); process.exit(0); });
process.on("SIGTERM", () => { saveState(); log("info", "Shutdown — state saved"); process.exit(0); });

main().catch(err => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});
