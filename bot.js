/**
 * 🤖 SolBot-Basic v1.3.3 — Fix: URL spaces + Price parsing
 */
'use strict';

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

if (!CONFIG.PRIVATE_KEY) { console.error('❌ PRIVATE_KEY non définie'); process.exit(1); }

// ═══════════════════════════════════════════════════════════════════════════
// DÉPENDANCES
// ═══════════════════════════════════════════════════════════════════════════

const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const express = require('express');
const path = require('path');

let fetch;
if (typeof global.fetch === 'function') {
  fetch = global.fetch;
} else {
  fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const VERSION = '1.3.3';

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════════════════

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const icon = { info: 'ℹ️', warn: '⚠️', error: '❌', debug: '🔍', success: '✅' }[level] || 'ℹ️';
  const safeMsg = String(msg).replace(/PRIVATE_KEY[=:]\S+/gi, 'PRIVATE_KEY=[REDACTED]').replace(/api-key=[^&\s]+/gi, 'api-key=[REDACTED]');
  const safeData = data ? JSON.stringify(data).slice(0, 300) : '';
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
  } catch (err) { log('error', 'Clé invalide', { error: err.message }); process.exit(1); }
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
    get connection() { return new Connection(endpoints[index], { commitment: 'confirmed' }); },
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
// PRIX + LOGOS — FIX: TRIM MINTS + VALIDATE PRICES
// ═══════════════════════════════════════════════════════════════════════════

const priceCache = new Map();
const logoCache = new Map();
let jupiterTokenList = null;

// Helper: trim et valider les mints
function cleanMints(mints) {
  return mints.map(m => String(m || '').trim()).filter(m => m && m.length >= 32 && m.length <= 44);
}

// Helper: parser un prix de façon robuste
function parsePrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const num = parseFloat(value.trim());
    return isFinite(num) && num > 0 ? num : null;
  }
  return null;
}

async function fetchWithDebug(url, options = {}, apiName) {
  try {
    const defaultHeaders = { 'User-Agent': `SolBot-Basic/${VERSION} (contact: bot@solana.local)` };
    const res = await fetch(url, { 
      ...options, 
      headers: { ...defaultHeaders, ...options.headers },
      signal: AbortSignal.timeout(options.timeout || 20000)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => 'N/A');
      log('warn', `${apiName} HTTP ${res.status}`, { url: url.slice(0, 120), body: body.slice(0, 150) });
      return null;
    }
    return res;
  } catch (err) {
    log('error', `${apiName} fetch failed`, { url: url.slice(0, 100), error: err.message, code: err.code });
    return null;
  }
}

async function batchJupiterPrices(mints) {
  if (!mints.length) return {};
  try {
    const results = {};
    // ✅ TRIM les mints avant de les utiliser
    const clean = cleanMints(mints);
    
    for (const mint of clean.slice(0, 20)) {
      try {
        // ✅ URL sans espace : ${mint} directement
        const url = `https://api.jup.ag/price/v2?ids=${mint}`;
        const res = await fetchWithDebug(url, {}, 'Jupiter');
        if (!res) continue;
        const data = await res.json();
        const item = data?.data?.[mint];
        if (item?.price) {
          const price = parsePrice(item.price);
          if (price) results[mint] = { price };
        }
      } catch (err) {
        log('debug', 'Jupiter single fetch error', { mint: mint.slice(0,8)+'...', error: err.message });
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return results;
  } catch (err) {
    log('error', 'batchJupiterPrices failed', { error: err.message });
    return {};
  }
}

async function batchDexScreener(mints) {
  if (!mints.length) return {};
  try {
    const results = {};
    const clean = cleanMints(mints);
    const chunks = [];
    for (let i = 0; i < clean.length; i += 10) chunks.push(clean.slice(i, i + 10));
    
    for (const chunk of chunks) {
      try {
        // ✅ URL corrigée : pas d'espace dans join
        const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`;
        const res = await fetchWithDebug(url, {}, 'DexScreener');
        if (!res) continue;
        const data = await res.json();
        const pairs = data?.pairs?.filter(p => p.chainId === 'solana') || [];
        
        for (const pair of pairs) {
          const mint = pair.baseToken?.address?.trim();
          if (!mint || !pair.priceUsd) continue;
          
          // ✅ Parser le prix de façon robuste
          const price = parsePrice(pair.priceUsd);
          if (!price) continue; // Skip si prix invalide
          
          const existing = results[mint];
          if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity || 0)) {
            results[mint] = {
              price, // ✅ Prix validé
              liquidity: pair.liquidity?.usd || 0,
              change24h: pair.priceChange?.h24 || 0,
              logo: pair.info?.imageUrl || pair.baseToken?.logoUri || null,
              symbol: pair.baseToken?.symbol || null,
              name: pair.baseToken?.name || null,
              source: 'dexscreener'
            };
          }
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        log('debug', 'DexScreener chunk error', { error: err.message });
      }
    }
    return results;
  } catch (err) {
    log('error', 'batchDexScreener failed', { error: err.message });
    return {};
  }
}

async function fetchPumpFun(mint) {
  try {
    const cleanMint = String(mint || '').trim();
    if (!cleanMint) return null;
    const url = `https://frontend-api.pump.fun/coins/${cleanMint}`;
    const res = await fetchWithDebug(url, { timeout: 10000 }, 'PumpFun');
    if (!res) return null;
    const coin = await res.json();
    if (!coin?.usd_market_cap || !coin?.total_supply) return null;
    const price = parsePrice(coin.usd_market_cap) / parsePrice(coin.total_supply);
    if (!price || price <= 0) return null;
    return {
      price,
      liquidity: coin.virtual_sol_reserves ? parsePrice(coin.virtual_sol_reserves) / 1e9 * 150 : 0,
      change24h: 0,
      logo: coin.image_uri || null,
      symbol: coin.symbol || null,
      name: coin.name || null,
      source: 'pumpfun'
    };
  } catch (err) {
    log('debug', 'PumpFun fetch error', { mint: String(mint||'').slice(0,8)+'...', error: err.message });
    return null;
  }
}

async function fetchJupiterTokenList() {
  try {
    const res = await fetchWithDebug('https://token.jup.ag/all', { timeout: 20000 }, 'JupiterTokenList');
    if (!res) return new Map();
    const tokens = await res.json();
    const logoMap = new Map();
    for (const token of tokens) {
      if (token?.address && token?.logoURI) {
        logoMap.set(token.address.trim(), { logo: token.logoURI, symbol: token.symbol, name: token.name });
      }
    }
    log('info', 'Jupiter Token List loaded', { count: logoMap.size });
    return logoMap;
  } catch (err) {
    log('warn', 'fetchJupiterTokenList failed', { error: err.message });
    return new Map();
  }
}

async function prefetchAllPrices(mints) {
  const cleanMintsList = cleanMints(mints);
  const toFetch = cleanMintsList.filter(m => {
    const c = priceCache.get(m);
    return !c || Date.now() - c.ts > 30000;
  });
  
  if (!toFetch.length) { log('debug', 'Prix en cache', { cached: cleanMintsList.length }); return; }
  log('debug', `Prefetch prix batch`, { total: toFetch.length });

  if (!jupiterTokenList) jupiterTokenList = await fetchJupiterTokenList();

  const jupPrices = await batchJupiterPrices(toFetch);
  log('debug', 'Jupiter prices', { found: Object.keys(jupPrices).length });

  const dexData = await batchDexScreener(toFetch);
  log('debug', 'DexScreener data', { found: Object.keys(dexData).length });

  const stillMissing = toFetch.filter(m => !dexData[m] && !jupPrices[m]);
  const pumpResults = {};
  if (stillMissing.length > 0) {
    log('debug', 'Fetching PumpFun for missing', { count: Math.min(stillMissing.length, 3) });
    for (const mint of stillMissing.slice(0, 3)) {
      const r = await fetchPumpFun(mint);
      if (r) pumpResults[mint] = r;
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Fusionner avec validation stricte du prix
  let withLogo = 0, found = 0;
  for (const mint of toFetch) {
    const dex = dexData[mint], jup = jupPrices[mint], pump = pumpResults[mint], jupMeta = jupiterTokenList?.get(mint);
    let result = null;
    
    // Priorité DexScreener (a déjà un prix validé)
    if (dex && dex.price) { result = { ...dex }; }
    // Puis Pump.fun
    else if (pump && pump.price) { result = { ...pump }; }
    // Puis Jupiter
    else if (jup && jup.price) { result = { price: jup.price, liquidity: 0, change24h: 0, source: 'jupiter' }; }
    
    // Ajouter metadata Jupiter si disponible
    if (result && jupMeta) {
      result.logo = result.logo || jupMeta.logo;
      result.symbol = result.symbol || jupMeta.symbol;
      result.name = result.name || jupMeta.name;
    }

    // ✅ Stocker SEULEMENT si le prix est valide
    if (result && result.price && result.price > 0) {
      priceCache.set(mint, {  result, ts: Date.now() });
      found++;
      if (result.logo) { logoCache.set(mint, result.logo); withLogo++; }
    }
  }

  log('debug', `Prix récupérés`, { found, total: toFetch.length, withLogo, missing: toFetch.length - found });
  
  if (found === 0 && toFetch.length > 0) {
    log('warn', '⚠️ AUCUN PRIX VALIDÉ — Vérifier parsing ou APIs', { 
      jup: Object.keys(jupPrices).length, dex: Object.keys(dexData).length, pump: Object.keys(pumpResults).length 
    });
  }
}

function getTokenPrice(mint) { 
  const cached = priceCache.get(mint);
  // ✅ Retourner null si le prix est invalide
  if (!cached?.data?.price || cached.data.price <= 0) return null;
  return cached.data; 
}
function getTokenLogo(mint) { return logoCache.get(mint) || null; }

// ═══════════════════════════════════════════════════════════════════════════
// TAKE-PROFIT MANAGER (inchangé)
// ═══════════════════════════════════════════════════════════════════════════

class TieredTakeProfitManager {
  constructor(tiers, hysteresis = 5) {
    this.tiers = tiers.sort((a, b) => a.pnl - b.pnl);
    this.hysteresis = hysteresis;
    this.entryPrices = new Map();
    this.triggeredTiers = new Map();
    this.soldAmounts = new Map();
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
    const sold = this.soldAmounts.get(mint) || 0;
    if (!entry) return 0;
    return Math.max(0, entry.originalBalance - sold);
  }
  checkTiers(mint, currentPrice) {
    const entry = this.entryPrices.get(mint), triggered = this.triggeredTiers.get(mint), pnl = this.getPnl(mint, currentPrice);
    if (!entry || pnl === null || !triggered) return [];
    const availableTiers = [];
    for (let i = 0; i < this.tiers.length; i++) {
      const tier = this.tiers[i];
      if (triggered.has(i)) continue;
      if (pnl >= tier.pnl) {
        const sellAmount = entry.originalBalance * (tier.sell / 100);
        availableTiers.push({ tierIndex: i, pnlTarget: tier.pnl, sellPercent: tier.sell, sellAmount: parseFloat(sellAmount.toFixed(6)), currentPnl: parseFloat(pnl.toFixed(2)) });
      }
    }
    return availableTiers;
  }
  markTierExecuted(mint, tierIndex, amountSold, price) {
    const triggered = this.triggeredTiers.get(mint);
    if (!triggered) return;
    triggered.add(tierIndex);
    const prevSold = this.soldAmounts.get(mint) || 0;
    this.soldAmounts.set(mint, prevSold + amountSold);
    const pnl = this.getPnl(mint, price), value = amountSold * price;
    log('info', 'Palier Take-Profit exécuté', { mint: mint.slice(0,8)+'...', tier: tierIndex+1, sold: amountSold.toFixed(4) });
    return { pnl, value };
  }
  maybeResetTier(mint, currentPnl, tierIndex) {
    const tier = this.tiers[tierIndex], triggered = this.triggeredTiers.get(mint);
    if (!triggered || !triggered.has(tierIndex)) return;
    if (currentPnl < tier.pnl - this.hysteresis) triggered.delete(tierIndex);
  }
  getStats() {
    const entries = [];
    for (const [mint, entry] of this.entryPrices) {
      const triggered = this.triggeredTiers.get(mint) || new Set();
      entries.push({ mint: mint.slice(0,8)+'...', entryPrice: entry.price, originalBalance: entry.originalBalance, sold: this.soldAmounts.get(mint)||0, remaining: this.getRemainingBalance(mint), triggeredTiers: Array.from(triggered).map(i => this.tiers[i].pnl+'%') });
    }
    return { enabled: true, tiers: this.tiers.map((t,i)=>({index:i+1,pnl:t.pnl+'%',sell:t.sell+'%'})), hysteresis: this.hysteresis+'%', tracked: entries.length, entries };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SELL EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

class SellExecutor {
  constructor(wallet, rpc) { this.wallet = wallet; this.rpc = rpc; this.lastPrice = new Map(); }
  async executeJupiterSell(mint, amount, slippageBps = 500) {
    try {
      const tokenDecimals = 9, amountRaw = BigInt(Math.floor(amount * Math.pow(10, tokenDecimals)));
      const cleanMint = String(mint||'').trim();
      const quoteRes = await fetchWithDebug(`https://quote-api.jup.ag/v6/quote?inputMint=${cleanMint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`, { headers: { 'User-Agent': `SolBot-Basic/${VERSION}` }}, 'JupiterQuote');
      if (!quoteRes) throw new Error('Quote fetch failed');
      const quote = await quoteRes.json();
      if (!quote?.outAmount) throw new Error('No quote');
      const swapRes = await fetchWithDebug('https://quote-api.jup.ag/v6/swap', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `SolBot-Basic/${VERSION}` },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: this.wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' })
      }, 'JupiterSwap');
      if (!swapRes) throw new Error('Swap fetch failed');
      const swapData = await swapRes.json();
      if (!swapData?.swapTransaction) throw new Error('No swapTransaction');
      const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      transaction.sign([this.wallet]);
      const txId = await this.rpc.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });
      const latestBlockhash = await this.rpc.connection.getLatestBlockhash();
      const confirmation = await this.rpc.connection.confirmTransaction({ signature: txId, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error(`Tx failed`);
      log('success', '🎯 Vente RÉELLE confirmée !', { mint: cleanMint.slice(0,8)+'...', txUrl: `https://solscan.io/tx/${txId}` });
      return { success: true, txId, txUrl: `https://solscan.io/tx/${txId}`, quote };
    } catch (err) { log('error', '❌ Jupiter: Échec', { error: err.message, mint: String(mint||'').slice(0,8)+'...' }); return { success: false, error: err.message }; }
  }
  async sell(mint, amount, reason, tier = null, useReal = true) {
    if (!useReal) return { success: false, error: 'simulation only' };
    const tierLabel = tier ? ` (Tier ${tier})` : '';
    log('info', `🎯 Vente${tierLabel} — ${reason}`, { mint: String(mint||'').slice(0,8)+'...', amount: parseFloat(amount).toFixed(4) });
    return await this.executeJupiterSell(mint, amount);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOOP
// ═══════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor(wallet, rpc) {
    this.wallet = wallet; this.rpc = rpc; this.portfolio = []; this.startTime = Date.now();
    this.takeProfit = new TieredTakeProfitManager(CONFIG.TAKE_PROFIT_TIERS, CONFIG.TAKE_PROFIT_HYSTERESIS);
    this.seller = new SellExecutor(wallet, rpc); this.lastPrice = new Map(); this.tpNotifications = new Map();
  }
  async tick() {
    try {
      await this.rpc.healthCheck();
      const [accounts, accounts2022] = await Promise.all([
        this.rpc.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM) }),
        this.rpc.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM_2022) }),
      ]);
      const allAccounts = [...accounts.value, ...accounts2022.value];
      const validAccounts = allAccounts.filter(acc => {
        const mint = acc.account.data.parsed.info.mint?.trim();
        if (!mint || mint === SOL_MINT) return false;
        const ta = acc.account.data.parsed.info.tokenAmount;
        const balance = parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0');
        return balance > 0;
      });
      const allMints = validAccounts.map(acc => acc.account.data.parsed.info.mint?.trim());
      await prefetchAllPrices(allMints);
      const tokens = [];
      for (const acc of validAccounts) {
        const mint = acc.account.data.parsed.info.mint?.trim(), tokenAmount = acc.account.data.parsed.info.tokenAmount;
        const balance = parseFloat(tokenAmount.uiAmount ?? tokenAmount.uiAmountString ?? '0');
        if (!balance || balance <= 0) continue;
        const priceData = getTokenPrice(mint), price = priceData?.price || 0, value = balance * price;
        this.lastPrice.set(mint, price); this.takeProfit.trackEntry(mint, price, balance);
        if (CONFIG.TAKE_PROFIT_ENABLED && price > 0) {
          const pnl = this.takeProfit.getPnl(mint, price);
          if (pnl !== null) {
            const availableTiers = this.takeProfit.checkTiers(mint, price);
            for (const tier of availableTiers) {
              log('warn', '🎯 PALIER TAKE-PROFIT DÉCLENCHÉ !', { mint: mint.slice(0,8)+'...', tier: tier.tierIndex+1, pnl: `${tier.currentPnl}%` });
              await this.seller.sell(mint, tier.sellAmount, 'TAKE_PROFIT', tier.tierIndex+1, true);
              const execResult = this.takeProfit.markTierExecuted(mint, tier.tierIndex, tier.sellAmount, price);
              this.tpNotifications.set(`${mint}-${tier.tierIndex}`, { mint, tier: tier.tierIndex+1, pnl: execResult.pnl, value: execResult.value, timestamp: Date.now() });
            }
            for (let i = 0; i < CONFIG.TAKE_PROFIT_TIERS.length; i++) this.takeProfit.maybeResetTier(mint, pnl, i);
          }
        }
        tokens.push({
          mint: mint.slice(0,8)+'...'+mint.slice(-4), mintFull: mint, balance: parseFloat(balance.toFixed(4)),
          price: price ? parseFloat(price.toFixed(6)) : null, value: parseFloat(value.toFixed(2)), liquidity: priceData?.liquidity||0,
          change24h: priceData?.change24h||0, pnl: this.takeProfit.getPnl(mint, price), entryPrice: this.takeProfit.entryPrices.get(mint)?.price||null,
          remainingBalance: this.takeProfit.getRemainingBalance(mint),
          triggeredTiers: Array.from(this.takeProfit.triggeredTiers.get(mint)||[]).map(i => CONFIG.TAKE_PROFIT_TIERS[i].pnl+'%'),
          logo: priceData?.logo || getTokenLogo(mint) || null, symbol: priceData?.symbol||null, name: priceData?.name||null,
        });
      }
      this.portfolio = tokens;
      const totalValue = tokens.reduce((sum, t) => sum + (t.value||0), 0);
      log('debug', 'Cycle terminé', { tokens: tokens.length, totalValue: `$${totalValue.toFixed(2)}` });
    } catch (err) { log('error', 'Erreur cycle', { error: err.message }); this.rpc.failover(); }
  }
  getStats() {
    const totalValue = this.portfolio.reduce((sum, t) => sum + (t.value||0), 0);
    return {
      uptime: Math.round((Date.now()-this.startTime)/1000), tokens: this.portfolio.length, totalValue: parseFloat(totalValue.toFixed(2)),
      takeProfit: CONFIG.TAKE_PROFIT_ENABLED ? { enabled: true, tiers: CONFIG.TAKE_PROFIT_TIERS.map((t,i)=>({index:i+1,pnl:t.pnl+'%',sell:t.sell+'%'})), hysteresis: CONFIG.TAKE_PROFIT_HYSTERESIS+'%', ...this.takeProfit.getStats() } : { enabled: false },
      lastUpdate: new Date().toISOString()
    };
  }
  getNewTPNotifications() { const notifications = []; for (const [key, data] of this.tpNotifications) notifications.push(data); return notifications; }
}

// ═══════════════════════════════════════════════════════════════════════════
// API SERVER
// ═══════════════════════════════════════════════════════════════════════════

function startApi(bot, wallet) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept'); next(); });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
  app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION, uptime: process.uptime() }));
  app.get('/api/stats', (req, res) => res.json(bot.getStats()));
  app.get('/api/portfolio', (req, res) => res.json({ address: wallet.publicKey.toString(), tokens: bot.portfolio, timestamp: Date.now() }));
  app.get('/api/wallet', (req, res) => res.json({ address: wallet.publicKey.toString(), shortAddress: wallet.publicKey.toString().slice(0,8)+'...'+wallet.publicKey.toString().slice(-4) }));
  app.get('/api/take-profit', (req, res) => res.json(bot.takeProfit.getStats()));
  app.get('/api/notifications/tp', (req, res) => res.json({ notifications: bot.getNewTPNotifications() }));
  app.post('/api/sell/test', express.json(), async (req, res) => {
    const { mint, amount, reason, tier, real } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint required' });
    const result = await bot.seller.sell(mint, amount||1, reason||'MANUAL_TEST', tier, real===true);
    res.json(result);
  });
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  const port = CONFIG.PORT; app.listen(port, '0.0.0.0', () => log('info', 'API démarrée', { port }));
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log('info', `🤖 SolBot-Basic v${VERSION} — Démarrage`, { env: CONFIG.NODE_ENV });
  const wallet = loadWallet(), rpc = getRpcConnection(), bot = new BotLoop(wallet, rpc);
  log('info', 'Premier cycle...'); await bot.tick();
  setInterval(() => bot.tick().catch(err => log('error', 'Erreur loop', { error: err.message })), CONFIG.INTERVAL_SEC * 1000);
  startApi(bot, wallet);
  log('info', '✅ Bot actif', { address: wallet.publicKey.toString().slice(0,8)+'...', interval: `${CONFIG.INTERVAL_SEC}s` });
  process.on('SIGINT', () => { log('info', '🛑 Arrêt'); process.exit(0); });
  process.on('uncaughtException', (err) => log('error', '💥 Exception', { error: err.message }));
}

main().catch(err => { console.error('🚨 Échec démarrage:', err.message); process.exit(1); });
