"use strict";

const { Connection, Keypair, PublicKey, VersionedTransaction } = require("@solana/web3.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const Redis = require("ioredis"); // Ajout pour cache persistant
const { mean, std } = require("mathjs"); // Ajout pour calculs stats (Sharpe, etc.)

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8NQuTjrAtp7zfoTBVKM1jCPnitp"; // Program ID Pump.fun
const BOT_VERSION = "4.1"; // Mise à jour version

const ENV = {
  PRIVATE_KEY: process.env.PRIVATE_KEY || null,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || null,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  AUTO_SELL: process.env.AUTO_SELL === "true",
  STOP_LOSS: process.env.STOP_LOSS === "true",
  STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT || "-20"),
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || "300"),
  INTERVAL_SEC: parseInt(process.env.INTERVAL_SEC || "15"),
  PORT: parseInt(process.env.PORT || "10000"),
  IS_RENDER: !!process.env.RENDER,
  BACKTEST_MODE: process.env.BACKTEST_MODE === "true", // Nouveau: mode backtest
  BACKTEST_DAYS: parseInt(process.env.BACKTEST_DAYS || "30"), // Nouveau: durée backtest
  BACKTEST_MINT: process.env.BACKTEST_MINT || "So11111111111111111111111111111111111111112", // Mint à tester (ex. SOL)
  BACKTEST_INITIAL_BALANCE: parseFloat(process.env.BACKTEST_INITIAL_BALANCE || "1000"), // Balance initiale fictive
  JITO_ENABLED: process.env.JITO_ENABLED === "true", // Nouveau: MEV via Jito
  SNIPE_PUMP: process.env.SNIPE_PUMP === "true", // Nouveau: activation sniping Pump.fun
  SNIPE_AMOUNT_SOL: parseFloat(process.env.SNIPE_AMOUNT_SOL || "0.1"), // Montant SOL pour chaque snipe
  SNIPE_FILTER_DEV: process.env.SNIPE_FILTER_DEV || null, // Filtre dev address (optionnel)
  SNIPE_MIN_LIQ: parseInt(process.env.SNIPE_MIN_LIQ || "1000"), // Min liq USD pour snipe
};

const TAKE_PROFIT_TIERS = [
  { targetPnl: 20, sellPercent: 30 },
  { targetPnl: 40, sellPercent: 25 },
  { targetPnl: 60, sellPercent: 25 },
  { targetPnl: 100, sellPercent: 20 },
];

const PRICE_CACHE_TTL = { HIGH: 30000, MEDIUM: 60000, LOW: 120000, NONE: 300000 };

const ICONS = { debug: "🔍", info: "ℹ️ ", warn: "⚠️ ", error: "❌" };

function log(level, msg, meta = null) {
  const ts = new Date().toISOString();
  const icon = ICONS[level] ?? "ℹ️ ";
  const line = `\( {icon} [ \){ts}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
  console.log(line, meta ? meta : "");
}

async function httpGet(url, { timeoutMs = 15000, retries = 2, headers = {} } = {}) {
  const defaultHeaders = { "User-Agent": `SolBot-Pro/${BOT_VERSION}`, "Accept": "application/json" };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { headers: { ...defaultHeaders, ...headers }, signal: controller.signal });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      if (attempt < retries) await sleep(1000 * attempt);
    }
  }
  return null;
}

async function httpPost(url, body, { timeoutMs = 60000 } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": `SolBot-Pro/${BOT_VERSION}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class RpcManager {
  constructor(heliusKey) {
    this._urls = [
      heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : null,
      "https://api.mainnet-beta.solana.com",
      "https://solana-mainnet.public.blastapi.io",
      "https://rpc.ankr.com/solana",
    ].filter(Boolean);
    this._index = 0;
    this._lastTest = 0;
    this._TEST_INTERVAL = 300000;
    this._subscriptions = new Map(); // Nouveau: gestion WebSockets
  }

  get connection() { return new Connection(this._urls[this._index], { commitment: "confirmed", confirmTransactionInitialTimeout: 60000, wsEndpoint: this._getWsEndpoint() }); }

  _getWsEndpoint() {
    const base = this._urls[this._index].replace('http', 'ws');
    return base.includes('helius') ? base.replace('/?', '/ws?') : base;
  }

  async healthCheck() {
    if (Date.now() - this._lastTest < this._TEST_INTERVAL) return;
    this._lastTest = Date.now();
    for (let i = 0; i < this._urls.length; i++) {
      try {
        const conn = new Connection(this._urls[i], { commitment: "confirmed", confirmTransactionInitialTimeout: 8000 });
        const slot = await conn.getSlot();
        if (slot > 0) {
          this._index = i;
          log("info", `[RPC] ✅ ${this._safeUrl(i)} (slot: ${slot})`);
          return;
        }
      } catch (e) { log("warn", `[RPC] ❌ ${this._safeUrl(i)} — ${e.message}`); }
    }
    log("warn", "[RPC] ⚠️ Aucun endpoint valide");
  }

  failover() {
    this._index = (this._index + 1) % this._urls.length;
    log("warn", `[RPC] ↩️ ${this._safeUrl(this._index)}`);
    this._resubscribeAll(); // Resouscrire aux WebSockets après failover
  }

  async subscribeAccount(pubkey, callback) {
    const conn = this.connection;
    const subId = await conn.onAccountChange(new PublicKey(pubkey), callback);
    this._subscriptions.set(pubkey, subId);
    return subId;
  }

  unsubscribeAccount(pubkey) {
    const subId = this._subscriptions.get(pubkey);
    if (subId) this.connection.removeAccountChangeListener(subId);
    this._subscriptions.delete(pubkey);
  }

  async subscribeLogs(programId, callback) {
    const conn = this.connection;
    const subId = await conn.onLogs(new PublicKey(programId), callback, "confirmed");
    this._subscriptions.set(programId, subId);
    return subId;
  }

  _resubscribeAll() {
    // Réimplémenter les subscriptions après failover
    // (À compléter avec les callbacks spécifiques)
  }

  _safeUrl(i) {
    const u = this._urls[i] || "";
    return u.includes("api-key") ? u.slice(0, 50) + "***" : u.slice(0, 50);
  }

  get heliusRpcUrl() { return this._urls[0]?.includes("helius") ? this._urls[0] : null; }
}

class LogoEngine {
  constructor(heliusKey) { this._heliusKey = heliusKey; this._cache = new Map(); }

  async getLogo(mint, symbol) {
    if (this._cache.has(mint)) return this._cache.get(mint);
    let logo = await this._fromJupiter(mint);
    if (!logo && this._heliusKey) logo = await this._fromHeliusDas(mint);
    if (!logo) logo = await this._fromDexScreener(mint);
    if (!logo) logo = this._svgFallback(symbol || mint.slice(0, 3));
    this._cache.set(mint, logo);
    return logo;
  }

  async _fromJupiter(mint) {
    const list = await httpGet("https://tokens.jup.ag/tokens", { timeoutMs: 12000, retries: 1 });
    return list?.find(t => t.address === mint)?.logoURI || null;
  }

  async _fromHeliusDas(mint) {
    const url = `https://mainnet.helius-rpc.com/?api-key=${this._heliusKey}`;
    const data = await httpPost(url, { jsonrpc: "2.0", id: "logo", method: "getAsset", params: { id: mint } }, { timeoutMs: 8000 });
    const r = data?.result;
    return r?.content?.links?.image || r?.content?.files?.[0]?.uri || r?.content?.metadata?.image || null;
  }

  async _fromDexScreener(mint) {
    const data = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeoutMs: 10000, retries: 1 });
    const pairs = data?.pairs?.filter(p => p.chainId === "solana");
    if (!pairs?.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return best?.info?.imageUrl || best?.baseToken?.logoURI || null;
  }

  _svgFallback(symbol) {
    const COLORS = ["#0ea5e9","#10b981","#f59e0b","#ef4444","#a78bfa","#ec4899","#14b8a6","#f97316"];
    const color = COLORS[(symbol || "?").toUpperCase().charCodeAt(0) % COLORS.length];
    const letter = (symbol || "?")[0].toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="\( {color}"/><text x="16" y="22" font-size="16" font-weight="bold" fill="white" text-anchor="middle" font-family="Arial,sans-serif"> \){letter}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
}

class PriceEngine {
  constructor(redis) { this._cache = new Map(); this._redis = redis; } // Nouveau: Redis pour cache persistant

  async _dexscreener(mint) {
    const data = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeoutMs: 15000, retries: 2 });
    const pairs = data?.pairs?.filter(p => p.chainId === "solana");
    if (!pairs?.length || !pairs[0].priceUsd) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return { priceUsd: parseFloat(best.priceUsd), liquidityUsd: best.liquidity?.usd || 0, change24h: best.priceChange?.h24 || 0, source: "DexScreener" };
  }

  async _pumpfun(mint) {
    const data = await httpGet(`https://frontend-api.pump.fun/coins/${mint}`, { timeoutMs: 10000, retries: 1, headers: { Origin: "https://pump.fun", Referer: "https://pump.fun/" } });
    if (!data?.virtual_sol_reserves || !data?.virtual_token_reserves) return null;
    const solPrice = data.sol_price || 200;
    const price = (data.virtual_sol_reserves / data.virtual_token_reserves) * solPrice;
    if (price <= 0) return null;
    return { priceUsd: price, liquidityUsd: data.usd_market_cap || 0, change24h: data.price_change_24h || 0, source: "PumpFun" };
  }

  async _birdeye(mint) { // Nouvelle source: Birdeye
    const data = await httpGet(`https://public-api.birdeye.so/public/price?address=${mint}`, { headers: { "X-API-KEY": "birdeye-key-if-needed" } }); // Ajouter clé si requis
    if (!data?.data?.value) return null;
    return { priceUsd: data.data.value, liquidityUsd: 0, change24h: 0, source: "Birdeye" };
  }

  async _coingecko(mint) {
    const data = await httpGet(`https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mint.toLowerCase()}&vs_currencies=usd`, { timeoutMs: 10000, retries: 1 });
    const key = mint.toLowerCase();
    if (!data?.[key]?.usd) return null;
    return { priceUsd: data[key].usd, liquidityUsd: 0, change24h: 0, source: "CoinGecko" };
  }

  async _fetchFresh(mint) {
    const SOURCES = [
      { fn: () => this._dexscreener(mint), weight: 5 },
      { fn: () => this._pumpfun(mint), weight: 4 },
      { fn: () => this._birdeye(mint), weight: 3 }, // Nouveau
      { fn: () => this._coingecko(mint), weight: 2 },
    ];
    const results = await Promise.allSettled(SOURCES.map(s => s.fn()));
    const valid = results.map((r, i) => r.status === "fulfilled" && r.value?.priceUsd > 0 ? { ...r.value, weight: SOURCES[i].weight } : null).filter(Boolean);
    if (!valid.length) return null;
    const totalWeight = valid.reduce((s, v) => s + v.weight, 0);
    const weightedPrice = valid.reduce((s, v) => s + v.priceUsd * v.weight, 0) / totalWeight;
    const bestLiquidity = valid.find(v => v.liquidityUsd > 0);
    const bestChange = valid.find(v => v.change24h != null);
    return {
      priceUsd: weightedPrice,
      liquidityUsd: bestLiquidity?.liquidityUsd || 0,
      change24h: bestChange?.change24h || 0,
      sources: valid.map(v => v.source),
      confidence: valid.length / SOURCES.length,
    };
  }

  async getPrice(mint) {
    const cachedJson = await this._redis.get(`price:${mint}`);
    if (cachedJson) {
      const cached = JSON.parse(cachedJson);
      const liq = cached.liquidityUsd || 0;
      const ttl = liq >= 1000000 ? PRICE_CACHE_TTL.HIGH : liq >= 100000 ? PRICE_CACHE_TTL.MEDIUM : liq > 0 ? PRICE_CACHE_TTL.LOW : PRICE_CACHE_TTL.NONE;
      if (Date.now() - cached.timestamp < ttl) return { ...cached, fromCache: true };
    }
    const fresh = await this._fetchFresh(mint);
    if (fresh?.priceUsd > 0) {
      fresh.timestamp = Date.now();
      await this._redis.set(`price:${mint}`, JSON.stringify(fresh), "EX", 300); // Expire après 5min max
    }
    return fresh ? { ...fresh, fromCache: false } : null;
  }

  invalidate(mint) { this._cache.delete(mint); this._redis.del(`price:${mint}`); }
}

class BuyEngine { // Nouveau: Engine pour achats (sniping)
  constructor(rpcManager, keypair) {
    this._rpc = rpcManager;
    this._keypair = keypair;
  }

  async _jupiterBuy(mint, amountSol, slippageBps, priorityFee = 0, maxAttempts = 3) {
    const amountRaw = Math.floor(amountSol * 1e9); // SOL to lamports
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const quote = await httpGet(`https://quote-api.jup.ag/v6/quote?inputMint=\( {SOL_MINT}&outputMint= \){mint}&amount=\( {amountRaw}&slippageBps= \){slippageBps}`, { timeoutMs: 60000, retries: 3 });
        if (!quote || quote.errorCode) throw new Error(quote?.error || "Quote error");
        const swapData = await httpPost("https://quote-api.jup.ag/v6/swap", {
          quoteResponse: quote,
          userPublicKey: this._keypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          computeUnitPriceMicroLamports: priorityFee || "auto",
        }, { timeoutMs: 60000 });
        if (!swapData?.swapTransaction) throw new Error("swapTransaction missing");
        const conn = this._rpc.connection;
        const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
        tx.sign([this._keypair]);
        let txId = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
        if (ENV.JITO_ENABLED) txId = await this._sendJitoBundle(txId);
        const bh = await conn.getLatestBlockhash();
        await conn.confirmTransaction({ signature: txId, ...bh }, "confirmed");
        return txId;
      } catch (err) {
        if (attempt < maxAttempts) await sleep(Math.pow(2, attempt) * 2000);
        else throw err;
      }
    }
  }

  async _sendJitoBundle(txId) {
    const jitoRes = await httpPost("https://mainnet.jito.bundle/api/v1/bundles", { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [{ txs: [txId] }] });
    return jitoRes.result || txId;
  }

  async snipe(mint, amountSol = ENV.SNIPE_AMOUNT_SOL, slippageBps = ENV.SLIPPAGE_BPS) {
    log("info", `[SNIPE] Tentative achat ${mint.slice(0,8)}… pour ${amountSol} SOL`);
    try {
      const txId = await this._jupiterBuy(mint, amountSol, slippageBps, this._dynamicPriorityFee());
      log("info", `[SNIPE] ✅ Tx: ${txId}`);
      return txId;
    } catch (err) {
      log("error", `[SNIPE] ❌ ${err.message}`);
      return null;
    }
  }

  _dynamicPriorityFee() {
    return 100000; // Exemple haut pour sniping (0.0001 SOL)
  }
}

class SellEngine {
  constructor(rpcManager, keypair) {
    this._rpc = rpcManager;
    this._keypair = keypair;
    this._failedAttempts = new Map();
    this._trailingData = new Map();
    this._triggeredTiers = new Set();
  }

  async _jupiterSell(mint, amountRaw, slippageBps, priorityFee = 0, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const quote = await httpGet(`https://quote-api.jup.ag/v6/quote?inputMint=\( {mint}&outputMint= \){SOL_MINT}&amount=\( {amountRaw}&slippageBps= \){slippageBps}`, { timeoutMs: 60000, retries: 3 });
        if (!quote || quote.errorCode) throw new Error(quote?.error || "Quote error");
        const swapData = await httpPost("https://quote-api.jup.ag/v6/swap", {
          quoteResponse: quote,
          userPublicKey: this._keypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          computeUnitPriceMicroLamports: priorityFee || "auto", // Dynamique
        }, { timeoutMs: 60000 });
        if (!swapData?.swapTransaction) throw new Error("swapTransaction missing");
        const conn = this._rpc.connection;
        const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
        tx.sign([this._keypair]);
        let txId = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
        if (ENV.JITO_ENABLED) txId = await this._sendJitoBundle(txId); // Nouveau: Jito bundle
        const bh = await conn.getLatestBlockhash();
        await conn.confirmTransaction({ signature: txId, ...bh }, "confirmed");
        return txId;
      } catch (err) {
        if (attempt < maxAttempts) await sleep(Math.pow(2, attempt) * 2000);
        else throw err;
      }
    }
  }

  async _sendJitoBundle(txId) {
    const jitoRes = await httpPost("https://mainnet.jito.bundle/api/v1/bundles", { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [{ txs: [txId] }] });
    return jitoRes.result || txId; // Fallback si échec
  }

  _slippage(liquidityUsd, volatility) {
    let base = liquidityUsd < 10000 ? 500 : liquidityUsd < 100000 ? 300 : ENV.SLIPPAGE_BPS;
    return Math.min(base + (Math.abs(volatility) > 50 ? 100 : 0), 1500); // Dynamique par volatilité
  }

  async applyLogic(mint, balance, decimals, price, pnl, liquidityUsd, change24h) {
    if (!ENV.AUTO_SELL || pnl == null || balance <= 0 || liquidityUsd < 1000) return;
    const raw = Math.floor(balance * 10 ** decimals);
    if (raw <= 0) return;
    const slippage = this._slippage(liquidityUsd, change24h);
    if (ENV.STOP_LOSS && pnl <= ENV.STOP_LOSS_PCT) {
      await this.sell(mint, raw, Math.min(slippage + 200, 1500), "STOP_LOSS").catch(() => {});
      return;
    }
    if (pnl >= 5) {
      const td = this._trailingData.get(mint) ?? { highest: pnl, active: false };
      if (pnl > td.highest) td.highest = pnl;
      if (!td.active) td.active = true;
      if (td.active && td.highest >= 8 && pnl <= td.highest - 8 && pnl >= 0) {
        await this.sell(mint, raw, slippage, "TRAILING_STOP").catch(() => {});
        this._trailingData.delete(mint);
        return;
      }
      this._trailingData.set(mint, td);
    }
    const volatilityMult = Math.abs(change24h) > 40 ? 1.15 : Math.abs(change24h) < 15 ? 0.85 : 1.0;
    for (let i = 0; i < TAKE_PROFIT_TIERS.length; i++) {
      const tier = TAKE_PROFIT_TIERS[i];
      const target = tier.targetPnl * volatilityMult;
      const tierKey = `\( {mint}_tier_ \){i}`;
      if (this._triggeredTiers.has(tierKey) && pnl < target - 10) this._triggeredTiers.delete(tierKey);
      if (!this._triggeredTiers.has(tierKey) && pnl >= target) {
        const amt = Math.floor(raw * tier.sellPercent / 100);
        if (amt > 0) {
          await this.sell(mint, amt, slippage, `TAKE_PROFIT_${i + 1}`).catch(() => {});
          this._triggeredTiers.add(tierKey);
        }
      }
    }
  }

  resetTrailing(mint) { this._trailingData.delete(mint); }

  async sell(mint, amountRaw, baseSlippage, reason) {
    if (amountRaw <= 0) return null;
    const now = Date.now();
    const failed = this._failedAttempts.get(mint) ?? { count: 0, nextRetry: 0 };
    if (failed.count >= 3 && now < failed.nextRetry) return null;
    const slippage = Math.min(baseSlippage + failed.count * 150, 1500);
    try {
      const txId = await this._jupiterSell(mint, amountRaw, slippage, this._dynamicPriorityFee());
      this._failedAttempts.delete(mint);
      return txId;
    } catch (err) {
      failed.count++;
      failed.nextRetry = now + Math.min(120000 * Math.pow(1.5, failed.count - 1), 3600000);
      this._failedAttempts.set(mint, failed);
      throw err;
    }
  }

  _dynamicPriorityFee() {
    return 50000; // Exemple: 0.00005 SOL
  }
}

function loadKeypair() {
  if (!ENV.PRIVATE_KEY) { log("error", "[WALLET] PRIVATE_KEY manquante"); process.exit(1); }
  try {
    const bytes = JSON.parse(ENV.PRIVATE_KEY);
    const kp = Keypair.fromSecretKey(new Uint8Array(bytes));
    log("info", `[WALLET] ✅ ${kp.publicKey.toString()}`);
    return kp;
  } catch (err) { log("error", `[WALLET] PRIVATE_KEY invalide : ${err.message}`); process.exit(1); }
}

class BotLoop {
  constructor({ keypair, rpcManager, priceEngine, logoEngine, sellEngine, buyEngine, redis }) {
    this._keypair = keypair;
    this._rpc = rpcManager;
    this._prices = priceEngine;
    this._logos = logoEngine;
    this._sell = sellEngine;
    this._buy = buyEngine; // Nouveau: BuyEngine
    this._redis = redis;
    this._entryPrices = new Map();
    this._manualTokens = new Set();
    this._metaOverride = new Map();
    this.lastSnapshot = [];
    this._loadPersistentData();
    this._setupSubscriptions(); // Nouveau: subscriptions WebSocket
  }

  async _loadPersistentData() {
    const entryJson = await this._redis.get('entryPrices');
    if (entryJson) this._entryPrices = new Map(JSON.parse(entryJson));
    const manualJson = await this._redis.get('manualTokens');
    if (manualJson) this._manualTokens = new Set(JSON.parse(manualJson));
    const metaJson = await this._redis.get('metaOverride');
    if (metaJson) this._metaOverride = new Map(JSON.parse(metaJson));
  }

  async _savePersistentData() {
    await this._redis.set('entryPrices', JSON.stringify(Array.from(this._entryPrices.entries())));
    await this._redis.set('manualTokens', JSON.stringify(Array.from(this._manualTokens)));
    await this._redis.set('metaOverride', JSON.stringify(Array.from(this._metaOverride.entries())));
  }

  _setupSubscriptions() {
    this._rpc.subscribeAccount(this._keypair.publicKey, (account) => {
      log("info", "[WS] Changement wallet détecté — trigger tick");
      this.tick();
    });
    if (ENV.SNIPE_PUMP) {
      this._rpc.subscribeLogs(PUMP_FUN_PROGRAM, (logs) => this._handlePumpLog(logs)); // Nouveau: subscribe Pump.fun logs
    }
  }

  async _handlePumpLog(logs) {
    if (logs.err) return;
    const logLines = logs.logs || [];
    // Parser logs pour nouveau token creation (ex. chercher 'initialize' ou mint signature)
    if (logLines.some(l => l.includes('initialize') || l.includes('Mint'))) {
      const mint = this._parseMintFromLogs(logLines); // Implémenter parser
      if (mint && this._shouldSnipe(mint)) {
        const pdata = await this._prices.getPrice(mint);
        if (pdata?.liquidityUsd >= ENV.SNIPE_MIN_LIQ) {
          const txId = await this._buy.snipe(mint);
          if (txId) {
            log("info", `[SNIPE] Nouveau token Pump.fun snipé: ${mint.slice(0,8)}… Tx: ${txId}`);
            this.addManualToken(mint); // Ajouter au suivi
          }
        }
      }
    }
  }

  _parseMintFromLogs(logs) {
    // Exemple simple: Chercher ligne avec 'Mint: <address>'
    const mintLine = logs.find(l => l.includes('Mint:'));
    return mintLine ? mintLine.split('Mint: ')[1] : null;
  }

  _shouldSnipe(mint) {
    // Filtres: ex. dev address, etc.
    if (ENV.SNIPE_FILTER_DEV) {
      // Fetch dev from metadata ou logs
      // Return true si match
    }
    return true; // Par défaut
  }

  addManualToken(address, symbol, name) {
    this._manualTokens.add(address);
    if (symbol || name) this._metaOverride.set(address, { symbol: symbol || "???", name: name || "Unknown" });
    this._savePersistentData();
  }

  removeManualToken(address) {
    this._metaOverride.delete(address);
    const removed = this._manualTokens.delete(address);
    this._savePersistentData();
    return removed;
  }

  setEntryPrice(mint, price) { this._entryPrices.set(mint, price); this._savePersistentData(); }

  async tick() {
    if (ENV.BACKTEST_MODE) return this._backtest();
    await this._rpc.healthCheck();
    const conn = this._rpc.connection;
    let accounts;
    try {
      accounts = await conn.getParsedTokenAccountsByOwner(this._keypair.publicKey, { programId: new PublicKey(TOKEN_PROG) });
    } catch (err) {
      log("error", `[BOT] getParsedTokenAccounts: ${err.message}`);
      if (err.message.includes("401") || err.message.toLowerCase().includes("unauthorized")) this._rpc.failover();
      return;
    }
    const walletMints = accounts.value.map(a => a.account.data.parsed.info.mint).filter(m => m !== SOL_MINT);
    const allMints = [...new Set([...walletMints, ...this._manualTokens])];
    const snapshot = await this._parallelAnalyze(allMints, accounts.value); // Nouveau: parallèle via workers
    this.lastSnapshot = snapshot;
  }

  _parallelAnalyze(mints, accounts) {
    return new Promise((resolve) => {
      const workers = [];
      const chunkSize = Math.ceil(mints.length / 4); // 4 workers par ex.
      for (let i = 0; i < mints.length; i += chunkSize) {
        const chunk = mints.slice(i, i + chunkSize);
        const worker = new Worker(__filename, { workerData: { mode: 'analyze', chunk, accounts: accounts /* sérialiser si besoin */ } });
        worker.on("message", (results) => {
          workers.push(results);
          if (workers.length === Math.ceil(mints.length / chunkSize)) resolve(workers.flat().filter(Boolean));
        });
      }
    });
  }

  async _backtest() {
    log("info", "[BACKTEST] Démarrage simulation sur " + ENV.BACKTEST_DAYS + " jours pour mint: " + ENV.BACKTEST_MINT);
    const coinId = await this._getCoinGeckoId(ENV.BACKTEST_MINT); // Résoudre ID CoinGecko
    if (!coinId) { log("error", "[BACKTEST] Coin ID non trouvé"); return; }
    const historical = await httpGet(`https://api.coingecko.com/api/v3/coins/\( {coinId}/market_chart?vs_currency=usd&days= \){ENV.BACKTEST_DAYS}`);
    if (!historical?.prices) { log("error", "[BACKTEST] Données historiques non disponibles"); return; }
    let simBalance = ENV.BACKTEST_INITIAL_BALANCE;
    let simPnL = 0;
    let trades = [];
    let prices = historical.prices.map(p => ({ time: p[0], price: p[1] })); // [timestamp, price]
    let entry = prices[0].price; // Entrée au début
    for (let i = 1; i < prices.length; i++) {
      const price = prices[i].price;
      const pnl = ((price - entry) / entry) * 100;
      const liquidityUsd = 1000000; // Fictif pour test
      const change24h = i > 24 ? ((price - prices[i-24].price) / prices[i-24].price) * 100 : 0; // Approx 24h change (assuming hourly data)
      await this._sell.applyLogic(ENV.BACKTEST_MINT, simBalance, 9, price, pnl, liquidityUsd, change24h); // Simuler vente (adapter pour sim)
      // Mettre à jour simBalance basé sur ventes simulées
      // Ex: si vente 30% à +20%, simBalance *= 0.7, simPnL += 0.3 * pnl / 100 * simBalance
      trades.push({ time: prices[i].time, price, pnl });
    }
    const returns = trades.map(t => t.pnl / 100); // Retours journaliers approx
    const avgReturn = mean(returns);
    const stdDev = std(returns);
    const sharpe = avgReturn / stdDev * Math.sqrt(365); // Annualisé
    log("info", "[BACKTEST] Résultats: PnL total " + simPnL.toFixed(2) + "%, Sharpe " + sharpe.toFixed(2) + ", Trades: " + trades.length);
    // Sauvegarder résultats dans Redis ou fichier
  }

  async _getCoinGeckoId(mint) {
    // Mapper mint à ID CoinGecko (ex. SOL = 'solana')
    const mappings = { [SOL_MINT]: 'solana' }; // Étendre pour autres
    return mappings[mint] || null;
  }

  async _analyzeToken(mint, walletAccounts) {
    const acc = walletAccounts.find(a => a.account.data.parsed.info.mint === mint);
    const inWallet = !!acc;
    let balance = 0, decimals = 6;
    if (inWallet) {
      const info = acc.account.data.parsed.info.tokenAmount;
      balance = parseFloat(info.uiAmount) || 0;
      decimals = info.decimals;
      if (balance <= 0 && !this._manualTokens.has(mint)) return null;
    } else if (!this._manualTokens.has(mint)) return null;
    const pdata = await this._prices.getPrice(mint);
    const hasPrice = (pdata?.priceUsd ?? 0) > 0;
    const price = hasPrice ? pdata.priceUsd : 0;
    const liqUsd = hasPrice ? pdata.liquidityUsd : 0;
    const change24h = hasPrice ? pdata.change24h : 0;
    if (hasPrice && !this._entryPrices.has(mint)) this._entryPrices.set(mint, price);
    const entry = this._entryPrices.get(mint) ?? null;
    const pnl = hasPrice && entry ? ((price - entry) / entry) * 100 : null;
    const override = this._metaOverride.get(mint);
    const symbol = override?.symbol || await this._getSymbol(mint);
    const name = override?.name || await this._getName(mint);
    const logo = await this._logos.getLogo(mint, symbol);
    if (hasPrice && inWallet && balance > 0) await this._sell.applyLogic(mint, balance, decimals, price, pnl, liqUsd, change24h);
    return {
      symbol, name, address: mint, balance, decimals, price, value: balance * price, pnl, entryPrice: entry,
      liquidity: liqUsd, change24h, logo, hasPrice, priceFromCache: pdata?.fromCache ?? null,
      priceSources: pdata?.sources ?? [], priceConfidence: pdata?.confidence ?? null,
      isManual: this._manualTokens.has(mint), isInWallet: inWallet,
      autoSellActive: ENV.AUTO_SELL && hasPrice && inWallet && balance > 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async _getSymbol(mint) {
    const list = await httpGet("https://tokens.jup.ag/tokens", { timeoutMs: 10000, retries: 1 });
    return list?.find(t => t.address === mint)?.symbol || mint.slice(0, 6) + "…";
  }

  async _getName(mint) {
    const list = await httpGet("https://tokens.jup.ag/tokens", { timeoutMs: 10000, retries: 1 });
    return list?.find(t => t.address === mint)?.name || "Unknown";
  }
}

function startHttpServer(port, bot, keypair) {
  // (Inchangé)
}

// Point d'entrée
async function main() {
  log("info", `🤖 SolBot Pro v${BOT_VERSION} — Démarrage`);
  const redis = new Redis(ENV.REDIS_URL); // Nouveau: Redis client
  const keypair = loadKeypair();
  const rpcManager = new RpcManager(ENV.HELIUS_API_KEY);
  const priceEngine = new PriceEngine(redis);
  const logoEngine = new LogoEngine(ENV.HELIUS_API_KEY);
  const sellEngine = new SellEngine(rpcManager, keypair);
  const buyEngine = new BuyEngine(rpcManager, keypair); // Nouveau: BuyEngine
  const bot = new BotLoop({ keypair, rpcManager, priceEngine, logoEngine, sellEngine, buyEngine, redis });
  await rpcManager.healthCheck();
  rpcManager._lastTest = 0;
  await rpcManager.healthCheck();
  await bot.tick();
  setInterval(() => bot.tick().catch(e => log("error", `[LOOP] ${e.message}`)), ENV.INTERVAL_SEC * 1000);
  if (ENV.IS_RENDER) startHttpServer(ENV.PORT, bot, keypair);
  // Subscription exemple: rpcManager.subscribeAccount(keypair.publicKey, (account) => bot.tick());
  log("info", "[BOT] 🔄 Active");
}

// Worker thread pour analyse parallèle
if (!isMainThread) {
  const { mode, chunk, accounts } = workerData;
  if (mode === 'analyze') {
    // Réinstancier classes nécessaires (sans state global)
    // Analyser chunk, poster résultats via parentPort.postMessage(results);
  }
}

process.on("uncaughtException", e => log("error", `[FATAL] Uncaught: ${e.message}`));
process.on("unhandledRejection", r => log("error", `[FATAL] Unhandled: ${r}`));

main();
