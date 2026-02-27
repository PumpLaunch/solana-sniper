// ═══════════════════════════════════════════════════════════════════════════
//  SolBot Pro v4.0 — Réécriture complète
//  Hébergement : Render (Background Worker + Web Service)
//
//  ARCHITECTURE :
//    • Wallet       — lecture clé privée, gestion keypair
//    • RpcManager   — rotation automatique d'endpoints, health-check
//    • PriceEngine  — prix pondéré multi-sources avec cache TTL intelligent
//    • LogoEngine   — logo multi-sources (Jupiter → Helius DAS → DexScreener → SVG)
//    • SellEngine   — stop-loss, trailing stop, paliers de TP, anti-boucle
//    • BotLoop      — analyse du portefeuille, déclenchement des ventes
//    • HttpServer   — API REST avec CORS
//
//  VARIABLES D'ENVIRONNEMENT :
//    PRIVATE_KEY       — tableau JSON [u8, ...] de la clé secrète
//    HELIUS_API_KEY    — clé Helius RPC (optionnel, améliore logos + RPC)
//    AUTO_SELL         — "true" pour activer les ventes automatiques
//    STOP_LOSS         — "true" pour activer le stop-loss
//    STOP_LOSS_PCT     — seuil stop-loss en % (ex: "-20")
//    SLIPPAGE_BPS      — slippage de base en bps (défaut: 300)
//    INTERVAL_SEC      — intervalle de la boucle en secondes (défaut: 15)
//    PORT              — port HTTP (défaut: 10000)
//    RENDER            — défini automatiquement par Render
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

// ── Dépendances ──────────────────────────────────────────────────────────────
const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = require("@solana/web3.js");

// node-fetch v3 est ESM-only — import dynamique
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

// ── Constantes globales ──────────────────────────────────────────────────────
const SOL_MINT    = "So11111111111111111111111111111111111111112";
const TOKEN_PROG  = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BOT_VERSION = "4.0";

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const ENV = {
  PRIVATE_KEY:    process.env.PRIVATE_KEY       || null,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY    || null,
  AUTO_SELL:      process.env.AUTO_SELL         === "true",
  STOP_LOSS:      process.env.STOP_LOSS         === "true",
  STOP_LOSS_PCT:  parseFloat(process.env.STOP_LOSS_PCT   || "-20"),
  SLIPPAGE_BPS:   parseInt(process.env.SLIPPAGE_BPS      || "300"),
  INTERVAL_SEC:   parseInt(process.env.INTERVAL_SEC      || "15"),
  PORT:           parseInt(process.env.PORT              || "10000"),
  IS_RENDER:      !!process.env.RENDER,
};

// Paliers de prise de profit (targetPnl en %, sellPercent = % du solde vendu)
const TAKE_PROFIT_TIERS = [
  { targetPnl: 20,  sellPercent: 30 },
  { targetPnl: 40,  sellPercent: 25 },
  { targetPnl: 60,  sellPercent: 25 },
  { targetPnl: 100, sellPercent: 20 },
];

// TTL du cache de prix selon la liquidité du token
const PRICE_CACHE_TTL = {
  HIGH:   30_000,   // liq ≥ $1M
  MEDIUM: 60_000,   // liq ≥ $100k
  LOW:    120_000,  // liq > $0
  NONE:   300_000,  // liq inconnue
};

// ═══════════════════════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════════════════════

const ICONS = { debug: "🔍", info: "ℹ️ ", warn: "⚠️ ", error: "❌" };

function log(level, msg, meta = null) {
  const ts   = new Date().toISOString();
  const icon = ICONS[level] ?? "ℹ️ ";
  const line = `${icon} [${ts}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
  if (meta) console.log(line, meta);
  else      console.log(line);
}

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITAIRES RÉSEAU
// ═══════════════════════════════════════════════════════════════════════════

/**
 * fetch() avec retry exponentiel.
 * Retourne le body JSON parsé, ou null en cas d'échec total.
 */
async function httpGet(url, { timeoutMs = 15_000, retries = 2, headers = {} } = {}) {
  const defaultHeaders = { "User-Agent": `SolBot-Pro/${BOT_VERSION}`, "Accept": "application/json" };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        headers: { ...defaultHeaders, ...headers },
        signal:  controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) {
        if (attempt < retries && res.status >= 500) {
          await sleep(1_000 * attempt);
          continue;
        }
        return null;
      }
      return await res.json();
    } catch {
      if (attempt < retries) await sleep(1_000 * attempt);
    }
  }
  return null;
}

/**
 * fetch POST JSON avec timeout.
 */
async function httpPost(url, body, { timeoutMs = 60_000 } = {}) {
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":   `SolBot-Pro/${BOT_VERSION}`,
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
//  RPC MANAGER
// ═══════════════════════════════════════════════════════════════════════════

class RpcManager {
  constructor(heliusKey) {
    this._urls = [
      heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : null,
      "https://api.mainnet-beta.solana.com",
      "https://solana-mainnet.public.blastapi.io",
      "https://rpc.ankr.com/solana",
    ].filter(Boolean);

    this._index    = 0;
    this._lastTest = 0;
    this._TEST_INTERVAL = 5 * 60_000; // test toutes les 5 min max
  }

  /** Retourne la connexion active */
  get connection() {
    return new Connection(this._urls[this._index], {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000,
    });
  }

  /** Teste les RPCs dans l'ordre et sélectionne le premier opérationnel */
  async healthCheck() {
    if (Date.now() - this._lastTest < this._TEST_INTERVAL) return;
    this._lastTest = Date.now();

    for (let i = 0; i < this._urls.length; i++) {
      try {
        const conn = new Connection(this._urls[i], {
          commitment: "confirmed",
          confirmTransactionInitialTimeout: 8_000,
        });
        const slot = await conn.getSlot();
        if (slot > 0) {
          this._index = i;
          log("info", `[RPC] ✅ Endpoint sélectionné : ${this._safeUrl(i)} (slot: ${slot})`);
          return;
        }
      } catch (e) {
        log("warn", `[RPC] ❌ ${this._safeUrl(i)} — ${e.message}`);
      }
    }
    log("warn", "[RPC] ⚠️ Aucun endpoint valide — conserve l'actuel");
  }

  /** Passe à l'endpoint suivant en cas d'erreur d'auth */
  failover() {
    this._index = (this._index + 1) % this._urls.length;
    log("warn", `[RPC] ↩️ Basculement → ${this._safeUrl(this._index)}`);
  }

  _safeUrl(i) {
    const u = this._urls[i] || "";
    return u.includes("api-key") ? u.slice(0, 50) + "***" : u.slice(0, 50);
  }

  get heliusRpcUrl() {
    return this._urls[0]?.includes("helius") ? this._urls[0] : null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOGO ENGINE
// ═══════════════════════════════════════════════════════════════════════════

class LogoEngine {
  constructor(heliusKey) {
    this._heliusKey = heliusKey;
    this._cache     = new Map(); // mint → logoUrl string
  }

  async getLogo(mint, symbol) {
    if (this._cache.has(mint)) return this._cache.get(mint);

    // 1. Jupiter token list
    const jupLogo = await this._fromJupiter(mint);
    if (jupLogo) { this._cache.set(mint, jupLogo); return jupLogo; }

    // 2. Helius DAS (NFT / memecoin avec image on-chain)
    if (this._heliusKey) {
      const dasLogo = await this._fromHeliusDas(mint);
      if (dasLogo) { this._cache.set(mint, dasLogo); return dasLogo; }
    }

    // 3. DexScreener info.imageUrl
    const dexLogo = await this._fromDexScreener(mint);
    if (dexLogo) { this._cache.set(mint, dexLogo); return dexLogo; }

    // 4. SVG auto-généré (toujours disponible)
    const svgLogo = this._svgFallback(symbol || mint.slice(0, 3));
    this._cache.set(mint, svgLogo);
    return svgLogo;
  }

  async _fromJupiter(mint) {
    try {
      const list = await httpGet("https://tokens.jup.ag/tokens", { timeoutMs: 12_000, retries: 1 });
      if (!list) return null;
      const token = list.find(t => t.address === mint);
      return token?.logoURI || null;
    } catch { return null; }
  }

  async _fromHeliusDas(mint) {
    try {
      const url  = `https://mainnet.helius-rpc.com/?api-key=${this._heliusKey}`;
      const data = await httpPost(url, {
        jsonrpc: "2.0", id: "logo",
        method:  "getAsset", params: { id: mint },
      }, { timeoutMs: 8_000 });
      const r = data?.result;
      return r?.content?.links?.image
          || r?.content?.files?.[0]?.uri
          || r?.content?.metadata?.image
          || null;
    } catch { return null; }
  }

  async _fromDexScreener(mint) {
    try {
      const data  = await httpGet(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { timeoutMs: 10_000, retries: 1 },
      );
      const pairs = data?.pairs?.filter(p => p.chainId === "solana");
      if (!pairs?.length) return null;
      const best  = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      return best?.info?.imageUrl || best?.baseToken?.logoURI || null;
    } catch { return null; }
  }

  /** Génère un SVG inline avec l'initiale du symbole.
   *  Retourne une data-URI valide utilisable comme src d'image. */
  _svgFallback(symbol) {
    const COLORS = ["#0ea5e9","#10b981","#f59e0b","#ef4444","#a78bfa","#ec4899","#14b8a6","#f97316"];
    const color  = COLORS[(symbol || "?").toUpperCase().charCodeAt(0) % COLORS.length];
    const letter = (symbol || "?")[0].toUpperCase();
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">`,
      `<circle cx="16" cy="16" r="16" fill="${color}"/>`,
      `<text x="16" y="22" font-size="16" font-weight="bold"`,
      ` fill="white" text-anchor="middle" font-family="Arial,sans-serif">${letter}</text>`,
      `</svg>`,
    ].join("");
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PRICE ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/** Résultat normalisé d'une source de prix */
// { priceUsd, liquidityUsd, change24h, source }

class PriceEngine {
  constructor() {
    // Map<mint, { data: PriceData, timestamp: number }>
    this._cache = new Map();
  }

  // ── Sources individuelles ──────────────────────────────────────

  async _dexscreener(mint) {
    const data  = await httpGet(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeoutMs: 15_000, retries: 2 },
    );
    const pairs = data?.pairs?.filter(p => p.chainId === "solana");
    if (!pairs?.length) return null;
    const best  = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!best?.priceUsd) return null;
    return {
      priceUsd:     parseFloat(best.priceUsd),
      liquidityUsd: best.liquidity?.usd   || 0,
      change24h:    best.priceChange?.h24 || 0,
      source:       "DexScreener",
    };
  }

  async _pumpfun(mint) {
    const data = await httpGet(
      `https://frontend-api.pump.fun/coins/${mint}`,
      {
        timeoutMs: 10_000,
        retries: 1,
        headers: { Origin: "https://pump.fun", Referer: "https://pump.fun/" },
      },
    );
    if (!data?.virtual_sol_reserves || !data?.virtual_token_reserves) return null;
    const solPrice = data.sol_price || 200;
    const price    = (data.virtual_sol_reserves / data.virtual_token_reserves) * solPrice;
    if (price <= 0) return null;
    return {
      priceUsd:     price,
      liquidityUsd: data.usd_market_cap  || 0,
      change24h:    data.price_change_24h || 0,
      source:       "PumpFun",
    };
  }

  async _coingecko(mint) {
    const data = await httpGet(
      `https://api.coingecko.com/api/v3/simple/token_price/solana`
      + `?contract_addresses=${mint.toLowerCase()}&vs_currencies=usd`,
      { timeoutMs: 10_000, retries: 1 },
    );
    const key = mint.toLowerCase();
    if (!data?.[key]?.usd) return null;
    return { priceUsd: data[key].usd, liquidityUsd: 0, change24h: 0, source: "CoinGecko" };
  }

  // ── Agrégation pondérée ────────────────────────────────────────

  async _fetchFresh(mint) {
    const SOURCES = [
      { fn: () => this._dexscreener(mint), weight: 5 },
      { fn: () => this._pumpfun(mint),     weight: 4 },
      { fn: () => this._coingecko(mint),   weight: 2 },
    ];

    const results = await Promise.allSettled(SOURCES.map(s => s.fn()));

    const valid = results
      .map((r, i) => r.status === "fulfilled" && r.value?.priceUsd > 0
        ? { ...r.value, weight: SOURCES[i].weight }
        : null)
      .filter(Boolean);

    if (!valid.length) return null;

    const totalWeight    = valid.reduce((s, v) => s + v.weight, 0);
    const weightedPrice  = valid.reduce((s, v) => s + v.priceUsd * v.weight, 0) / totalWeight;
    const bestLiquidity  = valid.find(v => v.liquidityUsd > 0);
    const bestChange     = valid.find(v => v.change24h   != null);

    return {
      priceUsd:     weightedPrice,
      liquidityUsd: bestLiquidity?.liquidityUsd || 0,
      change24h:    bestChange?.change24h        || 0,
      sources:      valid.map(v => v.source),
      confidence:   valid.length / SOURCES.length,
    };
  }

  // ── Point d'entrée avec cache ──────────────────────────────────

  async getPrice(mint) {
    const cached = this._cache.get(mint);
    const now    = Date.now();

    if (cached?.data?.priceUsd > 0) {
      // TTL dynamique basé sur la liquidité connue
      const liq = cached.data.liquidityUsd || 0;
      const ttl =
        liq >= 1_000_000 ? PRICE_CACHE_TTL.HIGH   :
        liq >= 100_000   ? PRICE_CACHE_TTL.MEDIUM  :
        liq > 0          ? PRICE_CACHE_TTL.LOW      :
                           PRICE_CACHE_TTL.NONE;

      if (now - cached.timestamp < ttl) {
        return { ...cached.data, fromCache: true };
      }
    }

    const fresh = await this._fetchFresh(mint);
    if (fresh?.priceUsd > 0) {
      this._cache.set(mint, { data: fresh, timestamp: now });
    }
    return fresh ? { ...fresh, fromCache: false } : null;
  }

  invalidate(mint) {
    this._cache.delete(mint);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SELL ENGINE
// ═══════════════════════════════════════════════════════════════════════════

class SellEngine {
  constructor(rpcManager, keypair) {
    this._rpc     = rpcManager;
    this._keypair = keypair;

    // Map<mint, { count, nextRetry }>  — protection anti-boucle
    this._failedAttempts = new Map();
    // Map<mint, { highest, active }>  — trailing stop
    this._trailingData   = new Map();
    // Set<string> — paliers déclenchés « mint_tier_N »
    this._triggeredTiers = new Set();
  }

  // ── Jupiter swap ────────────────────────────────────────────────

  async _jupiterSell(mint, amountRaw, slippageBps, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        log("debug", `[JUPITER] Tentative ${attempt}/${maxAttempts} — ${mint.slice(0, 8)}…`);

        // 1. Quote
        const quote = await httpGet(
          `https://quote-api.jup.ag/v6/quote`
          + `?inputMint=${mint}&outputMint=${SOL_MINT}`
          + `&amount=${amountRaw}&slippageBps=${slippageBps}`,
          { timeoutMs: 60_000, retries: 3 },
        );
        if (!quote)          throw new Error("Quote null ou timeout");
        if (quote.errorCode) throw new Error(`Jupiter: ${quote.error || quote.errorCode}`);

        // 2. Swap transaction
        const swapData = await httpPost("https://quote-api.jup.ag/v6/swap", {
          quoteResponse:               quote,
          userPublicKey:               this._keypair.publicKey.toString(),
          wrapAndUnwrapSol:            true,
          dynamicComputeUnitLimit:     true,
          computeUnitPriceMicroLamports: "auto",
        }, { timeoutMs: 60_000 });

        if (!swapData?.swapTransaction) throw new Error("swapTransaction manquant");

        // 3. Signature & envoi
        const conn = this._rpc.connection;
        const tx   = VersionedTransaction.deserialize(
          Buffer.from(swapData.swapTransaction, "base64"),
        );
        tx.sign([this._keypair]);

        const txId = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 5,
        });

        const bh = await conn.getLatestBlockhash();
        await conn.confirmTransaction({ signature: txId, ...bh }, "confirmed");

        log("info", `[JUPITER] ✅ Tx confirmée : ${txId}`);
        return txId;

      } catch (err) {
        log("warn", `[JUPITER] ⚠️ Tentative ${attempt} échouée : ${err.message}`);
        if (attempt < maxAttempts) {
          await sleep(Math.pow(2, attempt) * 2_000);
        } else {
          throw err;
        }
      }
    }
  }

  // ── Vente protégée ─────────────────────────────────────────────

  async sell(mint, amountRaw, baseSlippage, reason) {
    if (amountRaw <= 0) {
      log("warn", `[SELL] Montant nul — ignoré (${reason})`);
      return null;
    }

    const now    = Date.now();
    const failed = this._failedAttempts.get(mint) ?? { count: 0, nextRetry: 0 };

    // Pause si trop d'échecs récents
    if (failed.count >= 3 && now < failed.nextRetry) {
      const remaining = Math.ceil((failed.nextRetry - now) / 60_000);
      log("info", `[SELL] ⏸️ Pause ${remaining}min — ${mint.slice(0, 8)}… (${failed.count} échecs)`);
      return null;
    }

    // Slippage augmenté progressivement à chaque échec
    const slippage = Math.min(baseSlippage + failed.count * 150, 1500);
    log("info", `[SELL] ${reason} — ${mint.slice(0, 8)}… | ${amountRaw} | slippage: ${slippage}bps`);

    try {
      const txId = await this._jupiterSell(mint, amountRaw, slippage);
      this._failedAttempts.delete(mint); // reset en cas de succès
      log("info", `[SELL] ✅ ${reason} confirmée — ${txId}`);
      return txId;
    } catch (err) {
      failed.count++;
      failed.nextRetry = now + Math.min(120_000 * Math.pow(1.5, failed.count - 1), 3_600_000);
      this._failedAttempts.set(mint, failed);
      log("error", `[SELL] ❌ ${reason} ÉCHEC — ${err.message}`);
      throw err;
    }
  }

  // ── Sélection du slippage selon liquidité ─────────────────────

  _slippage(liquidityUsd) {
    if (liquidityUsd < 10_000)  return 500;
    if (liquidityUsd < 100_000) return 300;
    return ENV.SLIPPAGE_BPS;
  }

  // ── Logique complète de vente pour un token ───────────────────

  async applyLogic(mint, balance, decimals, price, pnl, liquidityUsd, change24h) {
    if (!ENV.AUTO_SELL)    return;
    if (pnl    == null)    return;
    if (balance <= 0)      return;
    if (liquidityUsd < 1_000) {
      log("debug", `[SELL] Liquidité insuffisante (${liquidityUsd}) — ${mint.slice(0,8)}…`);
      return;
    }

    const raw      = Math.floor(balance * 10 ** decimals);
    if (raw <= 0)  return;

    const slippage = this._slippage(liquidityUsd);

    // ── 1. STOP-LOSS ─────────────────────────────────────────────
    if (ENV.STOP_LOSS && pnl <= ENV.STOP_LOSS_PCT) {
      log("warn", `[🔴 STOP-LOSS] ${mint.slice(0,8)}… PnL=${pnl.toFixed(2)}% ≤ seuil=${ENV.STOP_LOSS_PCT}%`);
      try {
        await this.sell(mint, raw, Math.min(slippage + 200, 1500), "STOP_LOSS");
      } catch (err) {
        log("error", `[STOP-LOSS] Vente échouée : ${err.message}`);
      }
      return; // pas de traitement des paliers après un stop-loss
    }

    // ── 2. TRAILING STOP ─────────────────────────────────────────
    //  Actif dès +5%. Vend si recul ≥ 8 points depuis le plus haut.
    //  Ne vend pas si pnl est négatif (on laisse le stop-loss gérer).
    if (pnl >= 5) {
      const td = this._trailingData.get(mint) ?? { highest: pnl, active: false };

      if (pnl > td.highest) td.highest = pnl;
      if (!td.active)       td.active  = true;

      if (td.active && td.highest >= 8 && pnl <= td.highest - 8 && pnl >= 0) {
        log("info", `[🛡️ TRAILING] ${mint.slice(0,8)}… PnL=${pnl.toFixed(2)}% (sommet: ${td.highest.toFixed(2)}%)`);
        try {
          await this.sell(mint, raw, slippage, "TRAILING_STOP");
          this._trailingData.set(mint, { highest: 0, active: false });
        } catch (err) {
          log("error", `[TRAILING] Vente échouée : ${err.message}`);
          this._trailingData.set(mint, td); // conserve pour retry
        }
        return;
      }

      this._trailingData.set(mint, td);
    }

    // ── 3. PALIERS DE TAKE-PROFIT ─────────────────────────────────
    // Cibles ajustées selon la volatilité 24h
    const volatilityMult =
      Math.abs(change24h) > 40 ? 1.15 :
      Math.abs(change24h) < 15 ? 0.85 : 1.0;

    for (let i = 0; i < TAKE_PROFIT_TIERS.length; i++) {
      const tier      = TAKE_PROFIT_TIERS[i];
      const target    = tier.targetPnl * volatilityMult;
      const tierKey   = `${mint}_tier_${i}`;

      // Réinitialise si prix retombé > 10% sous le palier
      if (this._triggeredTiers.has(tierKey) && pnl < target - 10) {
        this._triggeredTiers.delete(tierKey);
      }

      if (!this._triggeredTiers.has(tierKey) && pnl >= target) {
        const amt = Math.floor(raw * tier.sellPercent / 100);
        if (amt > 0) {
          log("info", `[🎯 PALIER ${i+1}] ${mint.slice(0,8)}… PnL=${pnl.toFixed(2)}% → vente ${tier.sellPercent}%`);
          try {
            await this.sell(mint, amt, slippage, `TAKE_PROFIT_${i + 1}`);
            this._triggeredTiers.add(tierKey);
          } catch (err) {
            log("error", `[PALIER ${i+1}] Vente échouée : ${err.message}`);
            // ne marque pas le palier → sera retenté au prochain cycle
          }
        }
      }
    }
  }

  resetTrailing(mint) {
    this._trailingData.delete(mint);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  WALLET
// ═══════════════════════════════════════════════════════════════════════════

function loadKeypair() {
  if (!ENV.PRIVATE_KEY) {
    log("error", "[WALLET] Variable PRIVATE_KEY manquante");
    process.exit(1);
  }
  try {
    const bytes = JSON.parse(ENV.PRIVATE_KEY);
    const kp    = Keypair.fromSecretKey(new Uint8Array(bytes));
    log("info", `[WALLET] ✅ Connecté : ${kp.publicKey.toString()}`);
    return kp;
  } catch (err) {
    log("error", `[WALLET] PRIVATE_KEY invalide : ${err.message}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOT LOOP
// ═══════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor({ keypair, rpcManager, priceEngine, logoEngine, sellEngine }) {
    this._keypair     = keypair;
    this._rpc         = rpcManager;
    this._prices      = priceEngine;
    this._logos       = logoEngine;
    this._sell        = sellEngine;

    // Prix d'entrée estimé (premier prix récupéré = prix d'achat estimé)
    this._entryPrices  = new Map();
    // Tokens ajoutés manuellement via l'API
    this._manualTokens = new Set();
    // Métadonnées (symbol, name) forcées manuellement
    this._metaOverride = new Map();
    // Dernier état complet du portefeuille (exposé à l'API HTTP)
    this.lastSnapshot  = [];
  }

  addManualToken(address, symbol, name) {
    this._manualTokens.add(address);
    if (symbol || name) {
      this._metaOverride.set(address, {
        symbol: symbol || "???",
        name:   name   || "Unknown",
      });
    }
  }

  removeManualToken(address) {
    const existed = this._manualTokens.delete(address);
    this._metaOverride.delete(address);
    return existed;
  }

  setEntryPrice(mint, price) {
    this._entryPrices.set(mint, price);
  }

  // ── Cycle principal ────────────────────────────────────────────

  async tick() {
    await this._rpc.healthCheck();

    const conn    = this._rpc.connection;
    let   accounts;
    try {
      accounts = await conn.getParsedTokenAccountsByOwner(
        this._keypair.publicKey,
        { programId: new PublicKey(TOKEN_PROG) },
      );
    } catch (err) {
      log("error", `[BOT] getParsedTokenAccounts: ${err.message}`);
      if (err.message.includes("401") || err.message.toLowerCase().includes("unauthorized")) {
        this._rpc.failover();
      }
      return;
    }

    // Ensemble des mints à analyser = portefeuille + tokens manuels
    const walletMints = accounts.value
      .map(a => a.account.data.parsed.info.mint)
      .filter(m => m !== SOL_MINT);

    const allMints = [...new Set([...walletMints, ...this._manualTokens])];
    const snapshot  = [];

    for (const mint of allMints) {
      try {
        const tokenEntry = await this._analyzeToken(mint, accounts.value);
        if (tokenEntry) snapshot.push(tokenEntry);
      } catch (err) {
        log("warn", `[BOT] Erreur analyse ${mint.slice(0,8)}… : ${err.message}`);
      }
    }

    this.lastSnapshot = snapshot;
    log("debug", `[BOT] Cycle terminé — ${snapshot.length} token(s)`);
  }

  async _analyzeToken(mint, walletAccounts) {
    const acc      = walletAccounts.find(a => a.account.data.parsed.info.mint === mint);
    const inWallet = !!acc;

    let balance  = 0;
    let decimals = 6;

    if (inWallet) {
      const info = acc.account.data.parsed.info.tokenAmount;
      balance  = parseFloat(info.uiAmount) || 0;
      decimals = info.decimals;
      // Ignorer les comptes vides hors tokens manuels
      if (balance <= 0 && !this._manualTokens.has(mint)) return null;
    } else if (!this._manualTokens.has(mint)) {
      return null;
    }

    // Prix
    const pdata     = await this._prices.getPrice(mint);
    const hasPrice  = (pdata?.priceUsd ?? 0) > 0;
    const price     = hasPrice ? pdata.priceUsd     : 0;
    const liqUsd    = hasPrice ? pdata.liquidityUsd : 0;
    const change24h = hasPrice ? pdata.change24h    : 0;

    // Prix d'entrée (estimé au premier fetch)
    if (hasPrice && !this._entryPrices.has(mint)) {
      this._entryPrices.set(mint, price);
    }
    const entry  = this._entryPrices.get(mint) ?? null;
    const pnl    = hasPrice && entry ? ((price - entry) / entry) * 100 : null;

    // Métadonnées & logo
    const override = this._metaOverride.get(mint);
    const symbol   = override?.symbol || await this._getSymbol(mint);
    const name     = override?.name   || await this._getName(mint);
    const logo     = await this._logos.getLogo(mint, symbol);

    // Logique de vente
    if (hasPrice && inWallet && balance > 0) {
      await this._sell.applyLogic(mint, balance, decimals, price, pnl, liqUsd, change24h);
    }

    return {
      symbol,
      name,
      address:         mint,
      balance,
      decimals,
      price,
      value:           balance * price,
      pnl,
      entryPrice:      entry,
      liquidity:       liqUsd,
      change24h,
      logo,
      hasPrice,
      priceFromCache:  pdata?.fromCache ?? null,
      priceSources:    pdata?.sources ?? [],
      priceConfidence: pdata?.confidence ?? null,
      isManual:        this._manualTokens.has(mint),
      isInWallet:      inWallet,
      autoSellActive:  ENV.AUTO_SELL && hasPrice && inWallet && balance > 0,
      updatedAt:       new Date().toISOString(),
    };
  }

  // Helpers métadonnées (délégués au logo engine mais isolés pour clarté)
  async _getSymbol(mint) {
    try {
      const list = await httpGet("https://tokens.jup.ag/tokens", { timeoutMs: 10_000, retries: 1 });
      return list?.find(t => t.address === mint)?.symbol || mint.slice(0, 6) + "…";
    } catch { return mint.slice(0, 6) + "…"; }
  }

  async _getName(mint) {
    try {
      const list = await httpGet("https://tokens.jup.ag/tokens", { timeoutMs: 10_000, retries: 1 });
      return list?.find(t => t.address === mint)?.name || "Unknown";
    } catch { return "Unknown"; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP SERVER (API REST)
// ═══════════════════════════════════════════════════════════════════════════

function startHttpServer(port, bot, keypair) {
  const http = require("http");

  function ok(res, body)   { res.writeHead(200); res.end(JSON.stringify(body)); }
  function err(res, code, msg) { res.writeHead(code); res.end(JSON.stringify({ error: msg })); }

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // ── Routes ──────────────────────────────────────────────────

    // GET /
    if (req.url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end([
        `🤖 SolBot Pro v${BOT_VERSION}`,
        "",
        "Endpoints disponibles :",
        "  GET    /api/status",
        "  GET    /api/tokens",
        "  POST   /api/tokens/add    { address, symbol?, name?, entryPrice? }",
        "  DELETE /api/tokens/remove { address }",
        "  POST   /api/tokens/entry  { address, price }",
      ].join("\n"));
      return;
    }

    // GET /api/status
    if (req.url === "/api/status" && req.method === "GET") {
      ok(res, {
        status:      "running",
        version:     BOT_VERSION,
        wallet:      keypair.publicKey.toString(),
        tokensCount: bot.lastSnapshot.length,
        uptime:      Math.round(process.uptime()),
        autoSell:    ENV.AUTO_SELL,
        stopLoss:    ENV.STOP_LOSS ? `${ENV.STOP_LOSS_PCT}%` : "disabled",
        intervalSec: ENV.INTERVAL_SEC,
        timestamp:   new Date().toISOString(),
      });
      return;
    }

    // GET /api/tokens
    if (req.url === "/api/tokens" && req.method === "GET") {
      ok(res, {
        success:   true,
        wallet:    keypair.publicKey.toString(),
        count:     bot.lastSnapshot.length,
        tokens:    bot.lastSnapshot,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // POST /api/tokens/add
    if (req.url === "/api/tokens/add" && req.method === "POST") {
      const body = await readBody(req);
      if (!body) { err(res, 400, "JSON invalide"); return; }
      const { address, symbol, name, entryPrice } = body;
      if (!address || address.length < 32) { err(res, 400, "Adresse invalide"); return; }
      if (bot._manualTokens.has(address))  { err(res, 409, "Token déjà présent"); return; }
      bot.addManualToken(address, symbol, name);
      if (entryPrice && !isNaN(entryPrice)) bot.setEntryPrice(address, parseFloat(entryPrice));
      log("info", `[API] Token ajouté manuellement : ${address.slice(0,8)}…`);
      ok(res, { success: true, message: "Token ajouté" });
      return;
    }

    // DELETE /api/tokens/remove
    if (req.url === "/api/tokens/remove" && req.method === "DELETE") {
      const body = await readBody(req);
      if (!body) { err(res, 400, "JSON invalide"); return; }
      const { address } = body;
      if (!address)                        { err(res, 400, "Adresse manquante"); return; }
      if (!bot.removeManualToken(address)) { err(res, 404, "Token non trouvé"); return; }
      log("info", `[API] Token supprimé : ${address.slice(0,8)}…`);
      ok(res, { success: true, message: "Token supprimé" });
      return;
    }

    // POST /api/tokens/entry — forcer un prix d'entrée
    if (req.url === "/api/tokens/entry" && req.method === "POST") {
      const body = await readBody(req);
      if (!body) { err(res, 400, "JSON invalide"); return; }
      const { address, price } = body;
      if (!address || !price || isNaN(price)) { err(res, 400, "address et price requis"); return; }
      bot.setEntryPrice(address, parseFloat(price));
      log("info", `[API] Prix d'entrée forcé : ${address.slice(0,8)}… = ${price}`);
      ok(res, { success: true, entryPrice: parseFloat(price) });
      return;
    }

    err(res, 404, "Not found");
  });

  server.listen(port, () => log("info", `[HTTP] ✅ API démarrée — port ${port}`));
  return server;
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end",  () => {
      try { resolve(JSON.parse(raw)); }
      catch { resolve(null); }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  POINT D'ENTRÉE
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log("info", "═══════════════════════════════════════════════");
  log("info", `  🤖 SolBot Pro v${BOT_VERSION} — Démarrage`);
  log("info", `  Helius API Key : ${ENV.HELIUS_API_KEY ? "✅ Configurée" : "❌ Non configurée"}`);
  log("info", `  Auto-sell      : ${ENV.AUTO_SELL}`);
  log("info", `  Stop-loss      : ${ENV.STOP_LOSS ? ENV.STOP_LOSS_PCT + "%" : "désactivé"}`);
  log("info", `  Slippage base  : ${ENV.SLIPPAGE_BPS} bps`);
  log("info", `  Intervalle     : ${ENV.INTERVAL_SEC}s`);
  log("info", "═══════════════════════════════════════════════");

  // ── Initialisation ──────────────────────────────────────────────
  const keypair     = loadKeypair();
  const rpcManager  = new RpcManager(ENV.HELIUS_API_KEY);
  const priceEngine = new PriceEngine();
  const logoEngine  = new LogoEngine(ENV.HELIUS_API_KEY);
  const sellEngine  = new SellEngine(rpcManager, keypair);
  const bot         = new BotLoop({ keypair, rpcManager, priceEngine, logoEngine, sellEngine });

  // Sélectionne le meilleur RPC au démarrage
  await rpcManager.healthCheck();
  // Force le test immédiat (ignore le délai de 5 min)
  rpcManager._lastTest = 0;
  await rpcManager.healthCheck();

  // ── Premier cycle ────────────────────────────────────────────────
  await bot.tick();

  // ── Boucle périodique ────────────────────────────────────────────
  setInterval(async () => {
    try { await bot.tick(); }
    catch (e) { log("error", `[LOOP] ${e.message}`); }
  }, ENV.INTERVAL_SEC * 1_000);

  // ── API HTTP (si hébergement Render) ─────────────────────────────
  if (ENV.IS_RENDER) {
    startHttpServer(ENV.PORT, bot, keypair);
  }

  log("info", "[BOT] 🔄 Surveillance active");
}

// ── Gestion des erreurs fatales ──────────────────────────────────────────
process.on("uncaughtException",  e => log("error", `[FATAL] UncaughtException : ${e.message}`));
process.on("unhandledRejection", r => log("error", `[FATAL] UnhandledRejection : ${r}`));

main();
