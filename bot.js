/**
 * 🤖 SolBot-Basic v1.2 — Take-Profit par Paliers + Ventes Réelles Jupiter
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  PORT: parseInt(process.env.PORT) || 10000,
  INTERVAL_SEC: parseInt(process.env.INTERVAL_SEC) || 30,
  NODE_ENV: process.env.NODE_ENV || 'production',
  
  TAKE_PROFIT_ENABLED: process.env.TAKE_PROFIT_ENABLED === 'true',
  TAKE_PROFIT_TIERS: process.env.TAKE_PROFIT_TIERS 
    ? JSON.parse(process.env.TAKE_PROFIT_TIERS) 
    : [{ pnl: 20, sell: 25 }, { pnl: 40, sell: 25 }, { pnl: 60, sell: 25 }, { pnl: 100, sell: 25 }],
  TAKE_PROFIT_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),
};

if (!CONFIG.PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY non définie');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// DÉPENDANCES (IMPORTS — HORS DE CONFIG)
// ═══════════════════════════════════════════════════════════════════════════

const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58   = require('bs58');
const express = require('express');
const path    = require('path');                                          // ← AJOUT
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

const SOL_MINT          = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM      = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'; // ← Token-2022
const VERSION            = '1.2.0';

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════════════════

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const icon = { info: 'ℹ️', warn: '⚠️', error: '❌', debug: '🔍', success: '✅' }[level] || 'ℹ️';
  const safeMsg = String(msg)
    .replace(/PRIVATE_KEY[=:]\S+/gi, 'PRIVATE_KEY=[REDACTED]')
    .replace(/api-key=[^&\s]+/gi, 'api-key=[REDACTED]');
  const safeData = data ? JSON.stringify(data).slice(0, 200) : '';
  console.log(`${icon} [${ts}] [${level.toUpperCase()}] ${safeMsg} ${safeData}`.trim());
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET
// ═══════════════════════════════════════════════════════════════════════════

function loadWallet() {
  try {
    let secretKey;
    if (CONFIG.PRIVATE_KEY.startsWith('[')) {
      secretKey = Uint8Array.from(JSON.parse(CONFIG.PRIVATE_KEY));
    } else {
      secretKey = bs58.decode(CONFIG.PRIVATE_KEY);
    }
    const keypair = Keypair.fromSecretKey(secretKey);
    const address = keypair.publicKey.toString();
    log('info', 'Wallet chargé', { address: address.slice(0, 8) + '...' + address.slice(-4) });
    return keypair;
  } catch (err) {
    log('error', 'Clé invalide', { error: err.message });
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RPC MANAGER
// ═══════════════════════════════════════════════════════════════════════════

function getRpcConnection() {
  const endpoints = [
    CONFIG.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}` : null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.public.blastapi.io',
  ].filter(Boolean);
  
  let index = 0;
  
  return {
    get connection() {
      return new Connection(endpoints[index], { commitment: 'confirmed' });
    },
    async healthCheck() {
      for (let i = 0; i < endpoints.length; i++) {
        try {
          const conn = new Connection(endpoints[i], { commitment: 'confirmed' });
          const slot = await conn.getSlot();
          if (slot > 0) { index = i; log('info', 'RPC OK', { slot }); return true; }
        } catch (e) { log('warn', 'RPC échec', { endpoint: endpoints[i].slice(0, 40) + '...' }); }
      }
      return false;
    },
    failover() { index = (index + 1) % endpoints.length; log('warn', 'RPC failover', { index }); }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIX + CACHE
// ═══════════════════════════════════════════════════════════════════════════

const priceCache = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN DECIMALS CACHE
// ═══════════════════════════════════════════════════════════════════════════

const decimalsCache = new Map();

async function getTokenDecimals(mint, connection) {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const dec = info?.value?.data?.parsed?.info?.decimals;
    if (dec !== undefined) {
      decimalsCache.set(mint, dec);
      return dec;
    }
  } catch {}
  // Fallback: pump.fun tokens use 6, most others 9
  const fallback = mint.endsWith('pump') ? 6 : 9;
  decimalsCache.set(mint, fallback);
  return fallback;
}



// ── Batch Jupiter : 1 appel pour tous les mints non-cachés ───────────────────
async function batchJupiterPrices(mints) {
  if (!mints.length) return {};
  const results = {};
  const chunks = [];
  for (let i = 0; i < mints.length; i += 100)
    chunks.push(mints.slice(i, i + 100));

  for (const chunk of chunks) {
    // Essai 1 : Jupiter Price v2
    let ok = false;
    try {
      const res = await fetch(
        `https://api.jup.ag/price/v2?ids=${chunk.join(',')}`,
        { signal: AbortSignal.timeout(12000) }
      );
      if (res.ok) {
        const data = await res.json();
        for (const [mint, item] of Object.entries(data?.data || {})) {
          const p = parseFloat(item?.price);
          if (p > 0) { results[mint] = p; ok = true; }
        }
      }
    } catch {}

    // Essai 2 : Jupiter Price v6 (fallback si v2 échoue)
    if (!ok) {
      try {
        const res = await fetch(
          `https://price.jup.ag/v6/price?ids=${chunk.join(',')}`,
          { signal: AbortSignal.timeout(12000) }
        );
        if (res.ok) {
          const data = await res.json();
          for (const [mint, item] of Object.entries(data?.data || {})) {
            const p = parseFloat(item?.price);
            if (p > 0) results[mint] = p;
          }
        }
      } catch {}
    }

    // Petite pause entre chunks si plusieurs
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 200));
  }

  log('debug', `Jupiter batch`, { asked: mints.length, found: Object.keys(results).length });
  return results;
}

// ── Batch DexScreener : enrichit logo/symbol/liquidité (max 30 par appel) ────
async function batchDexScreener(mints) {
  if (!mints.length) return {};
  try {
    const chunks = [];
    for (let i = 0; i < mints.length; i += 30)
      chunks.push(mints.slice(i, i + 30));

    const results = {};
    // Séquentiel pour respecter le rate limit DexScreener
    for (const chunk of chunks) {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
          { signal: AbortSignal.timeout(15000) }
        );
        if (!res.ok) continue;
        const data = await res.json();
        const pairs = data?.pairs?.filter(p => p.chainId === 'solana') || [];
        // Garder la meilleure paire (+ liquide) par mint
        for (const pair of pairs) {
          const mint = pair.baseToken?.address;
          if (!mint || !pair.priceUsd) continue;
          const existing = results[mint];
          if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity || 0)) {
            results[mint] = {
              price:     parseFloat(pair.priceUsd),
              liquidity: pair.liquidity?.usd   || 0,
              change24h: pair.priceChange?.h24 || 0,
              logo:      pair.info?.imageUrl   || null,
              symbol:    pair.baseToken?.symbol || null,
              name:      pair.baseToken?.name   || null,
            };
          }
        }
        // Pause courte entre chunks pour éviter le rate limit
        if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
      } catch { continue; }
    }
    return results;
  } catch { return {}; }
}

// ── Pump.fun individuel (tokens bonding curve uniquement) ─────────────────────
async function fetchPumpFun(mint) {
  try {
    const res = await fetch(
      `https://frontend-api.pump.fun/coins/${mint}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const coin = await res.json();
    if (!coin?.usd_market_cap || !coin?.total_supply) return null;
    const price = coin.usd_market_cap / coin.total_supply;
    if (!price || price <= 0) return null;
    return {
      price,
      liquidity: coin.virtual_sol_reserves ? coin.virtual_sol_reserves / 1e9 * 150 : 0,
      change24h: 0,
      logo:      coin.image_uri || null,
      symbol:    coin.symbol    || null,
      name:      coin.name      || null,
      source:    'pumpfun',
    };
  } catch { return null; }
}

// ── Pré-chargement batch de tous les prix en début de cycle ──────────────────
async function prefetchAllPrices(mints) {
  const toFetch = mints.filter(m => {
    const c = priceCache.get(m);
    return !c || Date.now() - c.ts > 60000;
  });
  if (!toFetch.length) return;

  log('debug', `Prefetch prix batch`, { total: toFetch.length });

  // 1. Jupiter batch (prix pour tous)
  const jupPrices = await batchJupiterPrices(toFetch);

  // 2. DexScreener batch (métadonnées : logo, symbol, liquidité)
  const dexData = await batchDexScreener(toFetch);

  // 3. Tokens manquants dans Jupiter → DexScreener individuel rapide en parallèle
  const jupMissing = toFetch.filter(m => !jupPrices[m] && !dexData[m]);
  if (jupMissing.length > 0) {
    log('debug', `DexScreener individuel pour tokens manquants`, { count: jupMissing.length });
    await Promise.all(jupMissing.map(async m => {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${m}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) return;
        const data = await res.json();
        const solanaPairs = (data?.pairs || []).filter(p => p.chainId === 'solana');
        if (!solanaPairs.length) return;
        const pair = solanaPairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
        if (!pair?.priceUsd) return;
        dexData[m] = {
          price:     parseFloat(pair.priceUsd),
          liquidity: pair.liquidity?.usd || 0,
          change24h: pair.priceChange?.h24 || 0,
          logo:      pair.info?.imageUrl || null,
          symbol:    pair.baseToken?.symbol || null,
          name:      pair.baseToken?.name || null,
        };
      } catch {}
    }));
  }

  // 4. Pump.fun individuel pour les tokens encore introuvables
  const stillMissing = toFetch.filter(m => !jupPrices[m] && !dexData[m] && m.endsWith('pump'));
  const pumpResults = {};
  await Promise.all(stillMissing.map(async m => {
    const r = await fetchPumpFun(m);
    if (r) pumpResults[m] = r;
  }));

  // 5. Fusionner et mettre en cache
  for (const mint of toFetch) {
    const dex  = dexData[mint];
    const jup  = jupPrices[mint];
    const pump = pumpResults[mint];

    let result = null;
    if (dex) {
      result = { ...dex, source: 'dexscreener' };
    } else if (jup) {
      result = { price: jup, liquidity: 0, change24h: 0,
                 logo: null, symbol: null, name: null, source: 'jupiter' };
      // Enrichir avec pump.fun si disponible
      if (pump) { result.logo = pump.logo; result.symbol = pump.symbol; result.name = pump.name; }
    } else if (pump) {
      result = pump;
    }

    if (result) {
      priceCache.set(mint, { data: result, ts: Date.now() });
    } else {
      log('debug', 'Prix introuvable', { mint: mint.slice(0,8)+'...' });
    }
  }

  const found = toFetch.filter(m => priceCache.get(m)?.data).length;
  log('debug', `Prix récupérés`, { found, total: toFetch.length, missing: toFetch.length - found });
}

// ── Lecture du cache (après prefetch) ────────────────────────────────────────
function getTokenPrice(mint) {
  const cached = priceCache.get(mint);
  return cached?.data || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎯 TAKE-PROFIT MANAGER PAR PALIERS
// ═══════════════════════════════════════════════════════════════════════════

class TieredTakeProfitManager {
  constructor(tiers, hysteresis = 5) {
    this.tiers = tiers.sort((a, b) => a.pnl - b.pnl);
    this.hysteresis = hysteresis;
    this.entryPrices    = new Map();
    this.triggeredTiers = new Map();
    this.soldAmounts    = new Map();
  }
  
  trackEntry(mint, currentPrice, currentBalance) {
    if (!this.entryPrices.has(mint) && currentPrice > 0 && currentBalance > 0) {
      this.entryPrices.set(mint, { price: currentPrice, timestamp: Date.now(), originalBalance: currentBalance });
      this.triggeredTiers.set(mint, new Set());
      this.soldAmounts.set(mint, 0);
      return true;
    }
    return false;
  }
  
  getPnl(mint, currentPrice) {
    const entry = this.entryPrices.get(mint);
    if (!entry || !currentPrice) return null;
    return ((currentPrice - entry.price) / entry.price) * 100;
  }
  
  getRemainingBalance(mint) {
    const entry = this.entryPrices.get(mint);
    const sold  = this.soldAmounts.get(mint) || 0;
    if (!entry) return 0;
    return Math.max(0, entry.originalBalance - sold);
  }
  
  checkTiers(mint, currentPrice) {
    const entry     = this.entryPrices.get(mint);
    const triggered = this.triggeredTiers.get(mint);
    const pnl       = this.getPnl(mint, currentPrice);
    if (!entry || pnl === null || !triggered) return [];
    
    const availableTiers = [];
    for (let i = 0; i < this.tiers.length; i++) {
      const tier = this.tiers[i];
      if (triggered.has(i)) continue;
      if (pnl >= tier.pnl) {
        const sellAmount = entry.originalBalance * (tier.sell / 100);
        availableTiers.push({
          tierIndex: i, pnlTarget: tier.pnl, sellPercent: tier.sell,
          sellAmount: parseFloat(sellAmount.toFixed(6)), currentPnl: parseFloat(pnl.toFixed(2))
        });
      }
    }
    return availableTiers;
  }
  
  markTierExecuted(mint, tierIndex, amountSold) {
    const triggered = this.triggeredTiers.get(mint);
    if (!triggered) return;
    triggered.add(tierIndex);
    const prevSold = this.soldAmounts.get(mint) || 0;
    this.soldAmounts.set(mint, prevSold + amountSold);
    log('info', 'Palier Take-Profit exécuté', {
      mint: mint.slice(0,8) + '...', tier: tierIndex + 1,
      sold: amountSold.toFixed(4), totalSold: this.soldAmounts.get(mint).toFixed(4)
    });
  }
  
  maybeResetTier(mint, currentPnl, tierIndex) {
    const tier      = this.tiers[tierIndex];
    const triggered = this.triggeredTiers.get(mint);
    if (!triggered || !triggered.has(tierIndex)) return;
    if (currentPnl < tier.pnl - this.hysteresis) {
      triggered.delete(tierIndex);
    }
  }
  
  getStats() {
    const entries = [];
    for (const [mint, entry] of this.entryPrices) {
      const triggered = this.triggeredTiers.get(mint) || new Set();
      entries.push({
        mint: mint.slice(0,8) + '...', entryPrice: entry.price,
        originalBalance: entry.originalBalance, sold: this.soldAmounts.get(mint) || 0,
        remaining: this.getRemainingBalance(mint),
        triggeredTiers: Array.from(triggered).map(i => this.tiers[i].pnl + '%')
      });
    }
    return {
      enabled: true,
      tiers: this.tiers.map((t, i) => ({ index: i+1, pnl: t.pnl + '%', sell: t.sell + '%' })),
      hysteresis: this.hysteresis + '%',
      tracked: entries.length,
      entries
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔄 SELL EXECUTOR — MODE RÉEL
// ═══════════════════════════════════════════════════════════════════════════

class SellExecutor {
  constructor(wallet, rpc) {
    this.wallet = wallet;
    this.rpc    = rpc;
  }
  
  async executeJupiterSell(mint, amount, slippageBps = 500) {
    try {
      const tokenDecimals = await getTokenDecimals(mint, this.rpc.connection);
      const amountRaw     = BigInt(Math.floor(amount * Math.pow(10, tokenDecimals)));
      
      // Quote
      const quoteRes = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`,
        { headers: { 'User-Agent': 'SolBot-Basic/1.2' }, signal: AbortSignal.timeout(30000) }
      );
      if (!quoteRes.ok) throw new Error(`Quote HTTP ${quoteRes.status}`);
      const quote = await quoteRes.json();
      if (!quote?.outAmount) throw new Error('No quote');
      
      // Swap
      const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'SolBot-Basic/1.2' },
        body: JSON.stringify({
          quoteResponse: quote, userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto'
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!swapRes.ok) throw new Error(`Swap HTTP ${swapRes.status}`);
      const swapData = await swapRes.json();
      if (!swapData?.swapTransaction) throw new Error('No swapTransaction');
      
      // Sign & Send
      const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      transaction.sign([this.wallet]);
      const txId = await this.rpc.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed'
      });
      
      // Confirm
      const latestBlockhash = await this.rpc.connection.getLatestBlockhash();
      const confirmation    = await this.rpc.connection.confirmTransaction({
        signature: txId, blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      }, 'confirmed');
      
      if (confirmation.value.err) throw new Error(`Tx failed: ${JSON.stringify(confirmation.value.err)}`);
      
      log('success', '🎯 Vente RÉELLE confirmée !', {
        mint: mint.slice(0,8) + '...', txUrl: `https://solscan.io/tx/${txId}`
      });
      return { success: true, txId, txUrl: `https://solscan.io/tx/${txId}`, quote };
      
    } catch (err) {
      log('error', '❌ Jupiter: Échec', { error: err.message, mint: mint?.slice(0,8) + '...' });
      return { success: false, error: err.message };
    }
  }
  
  async sell(mint, amount, reason, tier = null, useReal = true) {
    if (!useReal) return { success: false, error: 'simulation désactivée' };
    const tierLabel = tier ? ` (Tier ${tier})` : '';
    log('info', `🎯 Vente${tierLabel} — ${reason}`, {
      mint: mint.slice(0,8) + '...', amount: parseFloat(amount).toFixed(4), mode: 'REAL'
    });
    return await this.executeJupiterSell(mint, amount);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 💰 BUY EXECUTOR — Achat via Jupiter
// ═══════════════════════════════════════════════════════════════════════════

class BuyExecutor {
  constructor(wallet, rpc) {
    this.wallet = wallet;
    this.rpc    = rpc;
  }

  /** Obtenir un devis sans exécuter */
  async getQuote({ inputMint, outputMint, amount, slippageBps = 500 }) {
    const quoteRes = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&maxAccounts=20`,
      { headers: { 'User-Agent': 'SolBot-Basic/1.2' }, signal: AbortSignal.timeout(15000) }
    );
    if (!quoteRes.ok) throw new Error(`Quote HTTP ${quoteRes.status}`);
    const q = await quoteRes.json();
    if (q.error) throw new Error(q.error);
    if (!q.outAmount) throw new Error('Aucun devis disponible pour ce token');
    return q;
  }

  /** Exécuter un swap quelconque (SOL→token ou token→SOL) */
  async executeSwap(quote) {
    const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SolBot-Basic/1.2' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!swapRes.ok) throw new Error(`Swap HTTP ${swapRes.status}`);
    const swapData = await swapRes.json();
    if (!swapData?.swapTransaction) throw new Error('swapTransaction manquant');

    const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    transaction.sign([this.wallet]);
    const txId = await this.rpc.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
    });
    const lbh = await this.rpc.connection.getLatestBlockhash();
    const conf = await this.rpc.connection.confirmTransaction(
      { signature: txId, blockhash: lbh.blockhash, lastValidBlockHeight: lbh.lastValidBlockHeight },
      'confirmed'
    );
    if (conf.value.err) throw new Error(`Transaction échouée: ${JSON.stringify(conf.value.err)}`);
    return { txId, txUrl: `https://solscan.io/tx/${txId}` };
  }

  /** Acheter un token avec un montant SOL (en SOL, ex: 0.1) */
  async buy(mint, solAmount, slippageBps = 500) {
    try {
      log('info', 'Achat en cours', { mint: mint.slice(0,8)+'...', solAmount, slippageBps });
      const lamports = BigInt(Math.floor(solAmount * 1e9));
      const quote = await this.getQuote({ inputMint: SOL_MINT, outputMint: mint, amount: lamports, slippageBps });
      const { txId, txUrl } = await this.executeSwap(quote);
      const outDecimals = await getTokenDecimals(mint, this.rpc.connection);
      const outAmount   = Number(quote.outAmount) / Math.pow(10, outDecimals);
      log('success', 'Achat confirmé', { mint: mint.slice(0,8)+'...', outAmount: outAmount.toFixed(4), txId });
      return { success: true, txId, txUrl, quote, outAmount, solSpent: solAmount };
    } catch (err) {
      log('error', 'Achat échoué', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  /** Obtenir la balance SOL du wallet */
  async getSolBalance() {
    try {
      const lamports = await this.rpc.connection.getBalance(this.wallet.publicKey);
      return lamports / 1e9;
    } catch {
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOOP
// ═══════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor(wallet, rpc) {
    this.wallet     = wallet;
    this.rpc        = rpc;
    this.portfolio  = [];
    this.tradeHistory = [];  // [ { type, mint, symbol, amount, sol, txId, txUrl, ts } ]
    this.startTime  = Date.now();
    this.takeProfit = new TieredTakeProfitManager(CONFIG.TAKE_PROFIT_TIERS, CONFIG.TAKE_PROFIT_HYSTERESIS);
    this.seller     = new SellExecutor(wallet, rpc);
    this.buyer      = new BuyExecutor(wallet, rpc);
  }
  
  async tick() {
    try {
      await this.rpc.healthCheck();
      // Récupère les deux programmes SPL en parallèle (Token + Token-2022)
      const [accounts, accounts2022] = await Promise.all([
        this.rpc.connection.getParsedTokenAccountsByOwner(
          this.wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM) }
        ),
        this.rpc.connection.getParsedTokenAccountsByOwner(
          this.wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM_2022) }
        ),
      ]);
      const allAccounts = [...accounts.value, ...accounts2022.value];

      // Extraire tous les mints valides
      const validAccounts = allAccounts.filter(acc => {
        const mint = acc.account.data.parsed.info.mint;
        if (mint === SOL_MINT) return false;
        const ta = acc.account.data.parsed.info.tokenAmount;
        const balance = parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0');
        return balance > 0;
      });

      // Pré-charger tous les prix en batch (1-2 appels API au lieu de 84)
      const allMints = validAccounts.map(acc => acc.account.data.parsed.info.mint);
      await prefetchAllPrices(allMints);
      
      const tokens = [];
      for (const acc of validAccounts) {
        const mint      = acc.account.data.parsed.info.mint;
        const tokenAmount = acc.account.data.parsed.info.tokenAmount;
        // uiAmount est null pour certains tokens pump.fun → fallback sur uiAmountString
        const balance = parseFloat(tokenAmount.uiAmount ?? tokenAmount.uiAmountString ?? '0');
        if (!balance || balance <= 0) continue;
        
        const priceData = getTokenPrice(mint);  // synchrone — déjà en cache
        const price     = priceData?.price || 0;
        const value     = balance * price;
        
        this.takeProfit.trackEntry(mint, price, balance);
        
        if (CONFIG.TAKE_PROFIT_ENABLED && price > 0) {
          const pnl = this.takeProfit.getPnl(mint, price);
          if (pnl !== null) {
            const availableTiers = this.takeProfit.checkTiers(mint, price);
            for (const tier of availableTiers) {
              log('warn', '🎯 PALIER TAKE-PROFIT DÉCLENCHÉ !', {
                mint: mint.slice(0,8) + '...', tier: tier.tierIndex + 1,
                target: `+${tier.pnlTarget}%`, currentPnl: `${tier.currentPnl}%`
              });
              await this.seller.sell(mint, tier.sellAmount, 'TAKE_PROFIT', tier.tierIndex + 1, true);
              this.takeProfit.markTierExecuted(mint, tier.tierIndex, tier.sellAmount);
            }
            for (let i = 0; i < CONFIG.TAKE_PROFIT_TIERS.length; i++) {
              this.takeProfit.maybeResetTier(mint, pnl, i);
            }
          }
        }
        
        tokens.push({
          mint: mint.slice(0, 8) + '...' + mint.slice(-4), mintFull: mint,
          balance: parseFloat(balance.toFixed(4)),
          price: price > 0 ? price : null,  // précision complète pour les micro-prix pump.fun
          value: parseFloat(value.toFixed(2)),
          liquidity: priceData?.liquidity || 0,
          change24h: priceData?.change24h || 0,
          logo:      priceData?.logo || null,
          symbol:    priceData?.symbol || null,
          name:      priceData?.name || null,
          pnl: this.takeProfit.getPnl(mint, price),
          entryPrice: this.takeProfit.entryPrices.get(mint)?.price || null,
          remainingBalance: this.takeProfit.getRemainingBalance(mint),
          triggeredTiers: Array.from(this.takeProfit.triggeredTiers.get(mint) || []).map(i => CONFIG.TAKE_PROFIT_TIERS[i].pnl + '%')
        });
      }
      
      this.portfolio       = tokens;
      const totalValue     = tokens.reduce((sum, t) => sum + t.value, 0);
      log('debug', 'Cycle terminé', { tokens: tokens.length, totalValue: `$${totalValue.toFixed(2)}` });
      
    } catch (err) {
      log('error', 'Erreur cycle', { error: err.message });
      this.rpc.failover();
    }
  }
  
  getStats() {
    const totalValue = this.portfolio.reduce((sum, t) => sum + t.value, 0);
    return {
      uptime:     Math.round((Date.now() - this.startTime) / 1000),
      tokens:     this.portfolio.length,
      totalValue: parseFloat(totalValue.toFixed(2)),
      takeProfit: CONFIG.TAKE_PROFIT_ENABLED ? {
        enabled: true,
        tiers: CONFIG.TAKE_PROFIT_TIERS.map((t, i) => ({ index: i+1, pnl: t.pnl + '%', sell: t.sell + '%' })),
        hysteresis: CONFIG.TAKE_PROFIT_HYSTERESIS + '%',
        ...this.takeProfit.getStats()
      } : { enabled: false },
      lastUpdate: new Date().toISOString()
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API SERVER
// ═══════════════════════════════════════════════════════════════════════════

function startApi(bot, wallet) {
  const app = express();
  app.use(express.json());

  // ─── CORS — autorise GitHub Pages ─────────────────────────────────────
  app.use((req, res, next) => {
    const allowed = [
      'https://pumplaunch.github.io',
      'http://localhost:3000',
      'http://localhost:10000',
    ];
    const origin = req.headers.origin;
    if (!origin || allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // ──────────────────────────────────────────────────────────────────────

  // ─── Dashboard statique ────────────────────────────────────────────────
  // Place index.html dans le même dossier que bot.js (ou définir STATIC_DIR)
  const staticDir = process.env.STATIC_DIR || __dirname;          // ← AJOUT
  app.use(express.static(staticDir));                              // ← AJOUT
  app.get('/', (req, res) =>                                       // ← AJOUT
    res.sendFile(path.join(staticDir, 'index.html'))               // ← AJOUT
  );                                                               // ← AJOUT
  // ──────────────────────────────────────────────────────────────────────

  app.get('/health',         (req, res) => res.json({ status: 'ok', version: VERSION, uptime: process.uptime() }));
  app.get('/api/stats',      (req, res) => res.json(bot.getStats()));
  app.get('/api/portfolio',  (req, res) => res.json({ address: wallet.publicKey.toString(), tokens: bot.portfolio, timestamp: Date.now() }));
  app.get('/api/wallet',     (req, res) => res.json({ address: wallet.publicKey.toString(), shortAddress: wallet.publicKey.toString().slice(0, 8) + '...' + wallet.publicKey.toString().slice(-4) }));
  app.get('/api/take-profit',(req, res) => res.json(bot.takeProfit.getStats()));
  
  app.post('/api/sell/test', async (req, res) => {
    const { mint, amount, reason, tier, real } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint required' });
    const result = await bot.seller.sell(mint, amount || 1, reason || 'MANUAL_TEST', tier, real === true);
    res.json(result);
  });
  
  // Debug endpoint — vérifier l'état du cache de prix
  app.get('/api/debug/prices', (req, res) => {
    const cacheState = [];
    for (const [mint, entry] of priceCache.entries()) {
      cacheState.push({
        mint: mint.slice(0,8)+'...',
        price: entry.data?.price || null,
        source: entry.data?.source || null,
        symbol: entry.data?.symbol || null,
        age: Math.round((Date.now()-entry.ts)/1000)+'s',
      });
    }
    res.json({ total: cacheState.length, tokens: cacheState.slice(0,20) });
  });

  // ─── Solde SOL ──────────────────────────────────────────────────────────
  app.get('/api/sol-balance', async (req, res) => {
    const bal = await bot.buyer.getSolBalance();
    res.json({ balance: bal, formatted: bal !== null ? bal.toFixed(4) + ' SOL' : null });
  });

  // ─── Quote (preview sans exécuter) ──────────────────────────────────────
  app.post('/api/quote', async (req, res) => {
    const { inputMint, outputMint, amount, slippageBps = 500 } = req.body;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: 'inputMint, outputMint, amount requis' });
    }
    try {
      const quote = await bot.buyer.getQuote({ inputMint, outputMint, amount: BigInt(Math.floor(amount)), slippageBps });
      res.json({ success: true, quote });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ─── Achat réel ──────────────────────────────────────────────────────────
  app.post('/api/buy', async (req, res) => {
    const { mint, solAmount, slippageBps = 500 } = req.body;
    if (!mint || !solAmount) return res.status(400).json({ error: 'mint et solAmount requis' });
    if (solAmount <= 0 || solAmount > 100) return res.status(400).json({ error: 'solAmount invalide (0-100 SOL)' });
    const result = await bot.buyer.buy(mint, parseFloat(solAmount), slippageBps);
    if (result.success) {
      const priceData = getTokenPrice(mint);
      const entry = {
        type: 'buy', mint, symbol: priceData?.symbol || mint.slice(0,8),
        solSpent: solAmount, outAmount: result.outAmount,
        txId: result.txId, txUrl: result.txUrl, ts: Date.now(),
      };
      bot.tradeHistory.unshift(entry);
      if (bot.tradeHistory.length > 50) bot.tradeHistory.pop();
      // Refresh portfolio after buy
      setTimeout(() => bot.tick().catch(() => {}), 3000);
    }
    res.json(result);
  });

  // ─── Vente réelle (remplace /api/sell/test) ──────────────────────────────
  app.post('/api/sell', async (req, res) => {
    const { mint, amount, percent, slippageBps = 500, reason = 'MANUAL' } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint requis' });

    // Trouver le token dans le portfolio
    const tok = bot.portfolio.find(t => t.mintFull === mint || t.mintFull?.startsWith(mint.slice(0,8)));
    if (!tok) return res.status(404).json({ error: 'Token non trouvé dans le portfolio' });

    // Calculer le montant à vendre
    let sellAmount = amount;
    if (percent !== undefined) {
      sellAmount = tok.balance * (parseFloat(percent) / 100);
    }
    if (!sellAmount || sellAmount <= 0) return res.status(400).json({ error: 'Montant invalide' });
    sellAmount = Math.min(sellAmount, tok.balance);

    const result = await bot.seller.sell(tok.mintFull, sellAmount, reason, null, true);
    if (result.success) {
      const entry = {
        type: 'sell', mint: tok.mintFull, symbol: tok.symbol || tok.mintFull.slice(0,8),
        amount: sellAmount, percent: percent || null,
        txId: result.txId, txUrl: result.txUrl, ts: Date.now(),
      };
      bot.tradeHistory.unshift(entry);
      if (bot.tradeHistory.length > 50) bot.tradeHistory.pop();
      // Refresh portfolio après vente
      setTimeout(() => bot.tick().catch(() => {}), 3000);
    }
    res.json({ ...result, sellAmount });
  });

  // ─── Historique des trades ──────────────────────────────────────────────
  app.get('/api/trades', (req, res) => {
    res.json({ trades: bot.tradeHistory });
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  const port = CONFIG.PORT;
  app.listen(port, '0.0.0.0', () => log('info', 'API + Dashboard démarrés', { port, url: `http://localhost:${port}` }));
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log('info', `🤖 SolBot-Basic v${VERSION} — Démarrage`, { env: CONFIG.NODE_ENV });
  const wallet = loadWallet();
  const rpc    = getRpcConnection();
  const bot    = new BotLoop(wallet, rpc);
  
  log('info', 'Premier cycle...');
  await bot.tick();
  setInterval(() => bot.tick().catch(err => log('error', 'Erreur loop', { error: err.message })), CONFIG.INTERVAL_SEC * 1000);
  startApi(bot, wallet);
  
  log('info', '✅ Bot actif', { 
    address:    wallet.publicKey.toString().slice(0, 8) + '...',
    interval:   `${CONFIG.INTERVAL_SEC}s`,
    takeProfit: CONFIG.TAKE_PROFIT_ENABLED ? 'tiers: 25%x4' : 'disabled'
  });
  
  process.on('SIGINT',           () => { log('info', '🛑 Arrêt'); process.exit(0); });
  process.on('uncaughtException', err => log('error', '💥 Exception', { error: err.message }));
}

main().catch(err => { console.error('🚨 Échec démarrage:', err.message); process.exit(1); });
