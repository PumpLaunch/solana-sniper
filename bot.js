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

// ── Batch Jupiter : 1 appel pour tous les mints non-cachés ───────────────────
async function batchJupiterPrices(mints) {
  if (!mints.length) return {};
  try {
    // Jupiter accepte jusqu'à 100 ids par appel
    const chunks = [];
    for (let i = 0; i < mints.length; i += 100)
      chunks.push(mints.slice(i, i + 100));

    const results = {};
    await Promise.all(chunks.map(async chunk => {
      const res = await fetch(
        `https://api.jup.ag/price/v2?ids=${chunk.join(',')}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const [mint, item] of Object.entries(data?.data || {})) {
        if (item?.price) results[mint] = parseFloat(item.price);
      }
    }));
    return results;
  } catch { return {}; }
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

  // 3. Pump.fun individuel pour les tokens encore introuvables
  const stillMissing = toFetch.filter(m => !jupPrices[m] && !dexData[m] && m.endsWith('pump'));
  const pumpResults = {};
  await Promise.all(stillMissing.map(async m => {
    const r = await fetchPumpFun(m);
    if (r) pumpResults[m] = r;
  }));

  // 4. Fusionner et mettre en cache
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
      const tokenDecimals = 9;
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
// BOT LOOP
// ═══════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor(wallet, rpc) {
    this.wallet     = wallet;
    this.rpc        = rpc;
    this.portfolio  = [];
    this.startTime  = Date.now();
    this.takeProfit = new TieredTakeProfitManager(CONFIG.TAKE_PROFIT_TIERS, CONFIG.TAKE_PROFIT_HYSTERESIS);
    this.seller     = new SellExecutor(wallet, rpc);
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
        
 
