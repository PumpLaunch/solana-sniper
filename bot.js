/**
 * 🤖 SolBot-Pro v1.4.0 — Take-Profit Avancé + Dashboard Cyberpunk
 * ✅ DexScreener prices + persistent cache
 * ✅ Trailing Stop-Loss + Time Fallback + Per-Token Config
 * ✅ Jupiter Sell avec headers complets
 * ✅ Helius RPC + Push Notifications + PWA
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
  
  // Take-Profit
  TAKE_PROFIT_ENABLED: process.env.TAKE_PROFIT_ENABLED === 'true',
  TAKE_PROFIT_TIERS: process.env.TAKE_PROFIT_TIERS 
    ? JSON.parse(process.env.TAKE_PROFIT_TIERS) 
    : [{ pnl: 20, sell: 25 }, { pnl: 40, sell: 25 }, { pnl: 60, sell: 25 }, { pnl: 100, sell: 25 }],
  TAKE_PROFIT_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),
  
  // Features avancées
  TRAILING_STOP_ENABLED: process.env.TRAILING_STOP_ENABLED === 'true',
  TRAILING_STOP_DROP: parseFloat(process.env.TRAILING_STOP_DROP || '10'),
  TIME_FALLBACK_ENABLED: process.env.TIME_FALLBACK_ENABLED === 'true',
  TIME_FALLBACK_HOURS: parseInt(process.env.TIME_FALLBACK_HOURS || '24'),
  
  // Per-token config (JSON complexe)
  PER_TOKEN_CONFIG: process.env.PER_TOKEN_CONFIG ? JSON.parse(process.env.PER_TOKEN_CONFIG) : {},
  
  // Execution
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || '500'),
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
if (typeof global.fetch === 'function') { fetch = global.fetch; } 
else { fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)); }

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const VERSION = '1.4.0';

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════════════════

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const icon = { info: 'ℹ️', warn: '⚠️', error: '❌', debug: '🔍', success: '✅' }[level] || 'ℹ️';
  const safeMsg = String(msg).replace(/PRIVATE_KEY[=:]\S+/gi, '[REDACTED]').replace(/api-key=[^&\s]+/gi, '[REDACTED]');
  const safeData = data ? JSON.stringify(data).slice(0, 400) : '';
  console.log(`${icon} [${ts}] [${level.toUpperCase()}] ${safeMsg} ${safeData}`.trim());
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET
// ═══════════════════════════════════════════════════════════════════════════

function loadWallet() {
  try {
    let secretKey = CONFIG.PRIVATE_KEY.startsWith('[') 
      ? Uint8Array.from(JSON.parse(CONFIG.PRIVATE_KEY)) 
      : bs58.decode(CONFIG.PRIVATE_KEY);
    const keypair = Keypair.fromSecretKey(secretKey);
    log('info', 'Wallet chargé', { address: keypair.publicKey.toString().slice(0,8)+'...' });
    return keypair;
  } catch (err) { log('error', 'Clé invalide', { error: err.message }); process.exit(1); }
}

// ═══════════════════════════════════════════════════════════════════════════
// RPC MANAGER — Helius Priority
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
          if (slot > 0) { index = i; log('info', 'RPC OK', { slot, source: i === 0 && CONFIG.HELIUS_API_KEY ? 'Helius' : 'Public' }); return true; }
        } catch (e) { log('warn', 'RPC échec', { endpoint: endpoints[i]?.slice(0, 40) + '...' }); }
      }
      return false;
    },
    failover() { index = (index + 1) % endpoints.length; log('warn', 'RPC failover', { index }); }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIX — DexScreener + Cache Persistant
// ═══════════════════════════════════════════════════════════════════════════

const priceCache = new Map(); // Cache persistant entre les cycles

async function fetchPriceFromDexScreener(mint) {
  const cleanMint = String(mint || '').trim();
  if (!cleanMint || cleanMint.length < 32 || cleanMint === SOL_MINT) return null;
  
  // ✅ Check cache (valide 5 minutes)
  const cached = priceCache.get(cleanMint);
  if (cached && Date.now() - cached.ts < 300000) {
    return cached.data;
  }
  
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${cleanMint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    
    if (!res.ok) {
      if (res.status === 429) return null; // Rate limit silencieux
      return null;
    }
    
    const data = await res.json();
    const pair = data?.pairs?.find(p => 
      p.chainId === 'solana' && 
      p.baseToken?.address?.toLowerCase() === cleanMint.toLowerCase()
    );
    
    if (!pair || !pair.priceUsd) return null;
    
    let price = null;
    if (typeof pair.priceUsd === 'number' && isFinite(pair.priceUsd) && pair.priceUsd > 0) {
      price = pair.priceUsd;
    } else if (typeof pair.priceUsd === 'string') {
      const parsed = parseFloat(pair.priceUsd.trim());
      if (isFinite(parsed) && parsed > 0) price = parsed;
    }
    
    if (!price) return null;
    
    const result = {
      price,
      liquidity: pair.liquidity?.usd || 0,
      change24h: pair.priceChange?.h24 || 0,
      logo: pair.info?.imageUrl || pair.baseToken?.logoUri || null,
      symbol: pair.baseToken?.symbol || null,
      name: pair.baseToken?.name || null,
      source: 'dexscreener'
    };
    
    // ✅ Stocker en cache
    priceCache.set(cleanMint, {  result, ts: Date.now() });
    
    return result;
    
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TAKE-PROFIT MANAGER — VERSION PRO v1.4.0
// ═══════════════════════════════════════════════════════════════════════════

class TieredTakeProfitManager {
  constructor(config = {}) {
    this.defaultTiers = config.tiers || CONFIG.TAKE_PROFIT_TIERS;
    this.hysteresis = config.hysteresis ?? CONFIG.TAKE_PROFIT_HYSTERESIS;
    this.trailingStop = config.trailingStop ?? { enabled: CONFIG.TRAILING_STOP_ENABLED, drop: CONFIG.TRAILING_STOP_DROP };
    this.timeFallback = config.timeFallback ?? { enabled: CONFIG.TIME_FALLBACK_ENABLED, hours: CONFIG.TIME_FALLBACK_HOURS };
    this.perTokenConfig = config.perTokenConfig || CONFIG.PER_TOKEN_CONFIG;
    
    this.entryPrices = new Map();
    this.triggeredTiers = new Map();
    this.soldAmounts = new Map();
    this.tpHistory = [];
    this.maxHistory = 100;
  }
  
  _getConfigForMint(mint) {
    const custom = this.perTokenConfig[mint];
    if (!custom) return { tiers: this.defaultTiers, trailing: this.trailingStop, timeFallback: this.timeFallback, hysteresis: this.hysteresis };
    return {
      tiers: custom.tiers || this.defaultTiers,
      trailing: custom.trailing ?? this.trailingStop,
      timeFallback: custom.timeFallback ?? this.timeFallback,
      hysteresis: custom.hysteresis ?? this.hysteresis
    };
  }
  
  trackEntry(mint, currentPrice, currentBalance) {
    if (!this.entryPrices.has(mint) && currentPrice > 0 && currentBalance > 0) {
      this.entryPrices.set(mint, {
        price: currentPrice, timestamp: Date.now(), originalBalance: currentBalance,
        highestPrice: currentPrice, lastTpTime: null, lastPrice: currentPrice
      });
      this.triggeredTiers.set(mint, new Set());
      this.soldAmounts.set(mint, 0);
      return true;
    }
    const entry = this.entryPrices.get(mint);
    if (entry && currentPrice > entry.highestPrice) entry.highestPrice = currentPrice;
    if (entry) entry.lastPrice = currentPrice;
    return false;
  }
  
  getPnl(mint, currentPrice, includeFees = false) {
    const entry = this.entryPrices.get(mint);
    if (!entry || !currentPrice) return null;
    const rawPnl = ((currentPrice - entry.price) / entry.price) * 100;
    return includeFees ? rawPnl - 0.3 : rawPnl;
  }
  
  checkTrailingStop(mint, currentPrice, config) {
    if (!config.trailing?.enabled) return null;
    const entry = this.entryPrices.get(mint);
    if (!entry) return null;
    const dropThreshold = config.trailing.drop;
    const highest = entry.highestPrice;
    const currentDrop = ((highest - currentPrice) / highest) * 100;
    if (currentDrop >= dropThreshold) {
      return {
        type: 'trailing_stop', triggerPrice: currentPrice, dropFromPeak: parseFloat(currentDrop.toFixed(2)),
        peakPrice: highest, entryPrice: entry.price, pnl: this.getPnl(mint, currentPrice)
      };
    }
    return null;
  }
  
  checkTimeFallback(mint, config) {
    if (!config.timeFallback?.enabled) return null;
    const entry = this.entryPrices.get(mint);
    if (!entry) return null;
    const hoursHeld = (Date.now() - entry.timestamp) / (1000 * 60 * 60);
    const maxHours = config.timeFallback.hours;
    if (hoursHeld >= maxHours) {
      const pnl = this.getPnl(mint, entry.lastPrice);
      return {
        type: 'time_fallback', hoursHeld: parseFloat(hoursHeld.toFixed(1)), maxHours,
        pnl: pnl !== null ? parseFloat(pnl.toFixed(2)) : null,
        reason: hoursHeld >= maxHours * 2 ? 'stagnant' : 'timeout'
      };
    }
    return null;
  }
  
  checkTiers(mint, currentPrice) {
    const entry = this.entryPrices.get(mint);
    const config = this._getConfigForMint(mint);
    const triggered = this.triggeredTiers.get(mint);
    const pnl = this.getPnl(mint, currentPrice);
    if (!entry || pnl === null || !triggered) return [];
    const availableTiers = [];
    const hysteresis = config.hysteresis ?? this.hysteresis;
    for (let i = 0; i < config.tiers.length; i++) {
      if (triggered.has(i)) continue;
      const tier = config.tiers[i];
      if (pnl >= tier.pnl + hysteresis) {
        const sellAmount = entry.originalBalance * (tier.sell / 100);
        availableTiers.push({
          tierIndex: i, pnlTarget: tier.pnl, sellPercent: tier.sell,
          sellAmount: parseFloat(sellAmount.toFixed(6)), currentPnl: parseFloat(pnl.toFixed(2)),
          hysteresisBuffer: hysteresis
        });
      }
    }
    return availableTiers;
  }
  
  async executeSell(mint, amount, reason, tier, seller, price) {
    const result = await seller.sell(mint, amount, reason, tier, true);
    this.tpHistory.unshift({
      mint: mint.slice(0,8)+'...', tier, reason, amount, price,
      value: amount * price, pnl: this.getPnl(mint, price),
      success: result.success, txId: result.txId, error: result.error, timestamp: Date.now()
    });
    if (this.tpHistory.length > this.maxHistory) this.tpHistory.pop();
    return result;
  }
  
  markTierExecuted(mint, tierIndex, amountSold, price, soldSuccessfully = true) {
    const entry = this.entryPrices.get(mint);
    const triggered = this.triggeredTiers.get(mint);
    if (!triggered) return;
    triggered.add(tierIndex);
    const prevSold = this.soldAmounts.get(mint) || 0;
    this.soldAmounts.set(mint, prevSold + amountSold);
    if (entry) entry.lastTpTime = Date.now();
    const pnl = this.getPnl(mint, price);
    const value = amountSold * price;
    const status = soldSuccessfully ? '✅ VENDU' : '⚠️ ÉCHEC';
    log('info', `🎯 TP Tier ${tierIndex+1} ${status}`, {
      mint: mint.slice(0,8)+'...', sold: amountSold.toFixed(4),
      value: `$${value.toFixed(2)}`, pnl: pnl !== null ? `${pnl.toFixed(2)}%` : 'N/A'
    });
    return { pnl, value, success: soldSuccessfully };
  }
  
  maybeResetTier(mint, currentPnl, tierIndex) {
    const config = this._getConfigForMint(mint);
    const tier = config.tiers[tierIndex];
    const triggered = this.triggeredTiers.get(mint);
    if (!triggered || !triggered.has(tierIndex)) return;
    const resetThreshold = tier.pnl - (config.hysteresis ?? this.hysteresis);
    if (currentPnl < resetThreshold) {
      triggered.delete(tierIndex);
      log('debug', `🔄 TP Tier ${tierIndex+1} réarmé`, {
        mint: mint.slice(0,8)+'...', currentPnl: `${currentPnl?.toFixed(2) || 'N/A'}%`, threshold: `${resetThreshold}%`
      });
    }
  }
  
  getStats() {
    const entries = [];
    let totalTriggered = 0, totalSold = 0;
    for (const [mint, entry] of this.entryPrices) {
      const triggered = this.triggeredTiers.get(mint) || new Set();
      const sold = this.soldAmounts.get(mint) || 0;
      const remaining = Math.max(0, entry.originalBalance - sold);
      entries.push({
        mint: mint.slice(0,8)+'...', entryPrice: entry.price, currentPrice: entry.lastPrice,
        originalBalance: entry.originalBalance, sold, remaining, highestPrice: entry.highestPrice,
        triggeredTiers: Array.from(triggered).map(i => this.defaultTiers[i]?.pnl + '%'),
        heldHours: ((Date.now() - entry.timestamp) / 3600000).toFixed(1)
      });
      totalTriggered += triggered.size;
      totalSold += sold;
    }
    return {
      enabled: true,
      defaultTiers: this.defaultTiers.map((t,i) => ({ index: i+1, pnl: t.pnl + '%', sell: t.sell + '%' })),
      features: { trailingStop: !!this.trailingStop?.enabled, timeFallback: !!this.timeFallback?.enabled, perTokenConfig: Object.keys(this.perTokenConfig).length > 0 },
      summary: { tracked: entries.length, totalTriggered, totalSold, historyCount: this.tpHistory.length },
      recent: this.tpHistory.slice(0, 10),
      entries
    };
  }
  
  getHistory(filters = {}) {
    let history = [...this.tpHistory];
    if (filters.mint) history = history.filter(h => h.mint.startsWith(filters.mint.slice(0,8)));
    if (filters.success !== undefined) history = history.filter(h => h.success === filters.success);
    if (filters.since) {
      const since = typeof filters.since === 'number' ? filters.since : Date.now() - filters.since;
      history = history.filter(h => h.timestamp >= since);
    }
    return history;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SELL EXECUTOR — Jupiter + Headers Complets
// ═══════════════════════════════════════════════════════════════════════════

class SellExecutor {
  constructor(wallet, rpc) { this.wallet = wallet; this.rpc = rpc; }
  
  async executeJupiterSell(mint, amount, slippageBps = CONFIG.SLIPPAGE_BPS) {
    const cleanMint = String(mint||'').trim();
    const tokenDecimals = 9;
    const amountRaw = BigInt(Math.floor(amount * Math.pow(10, tokenDecimals)));
    
    const jupiterHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://jup.ag', 'Referer': 'https://jup.ag/', 'Content-Type': 'application/json'
    };
    
    try {
      // 1. Quote
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${cleanMint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`;
      const quoteRes = await fetch(quoteUrl, { headers: jupiterHeaders, signal: AbortSignal.timeout(30000) });
      
      if (!quoteRes.ok) {
        const body = await quoteRes.text().catch(() => 'N/A');
        log('error', '❌ Jupiter Quote failed', { status: quoteRes.status, body: body.slice(0,200) });
        throw new Error(`Jupiter Quote ${quoteRes.status}`);
      }
      
      const quote = await quoteRes.json();
      if (!quote?.outAmount) throw new Error('No outAmount');
      
      // 2. Swap
      const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST', headers: { ...jupiterHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: this.wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
        signal: AbortSignal.timeout(30000)
      });
      
      if (!swapRes.ok) {
        const body = await swapRes.text().catch(() => 'N/A');
        log('error', '❌ Jupiter Swap failed', { status: swapRes.status, body: body.slice(0,200) });
        throw new Error(`Jupiter Swap ${swapRes.status}`);
      }
      
      const swapData = await swapRes.json();
      if (!swapData?.swapTransaction) throw new Error('No swapTransaction');
      
      // 3. Sign & Send
      const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      transaction.sign([this.wallet]);
      const txId = await this.rpc.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });
      
      // 4. Confirm
      const latestBlockhash = await this.rpc.connection.getLatestBlockhash();
      const confirmation = await this.rpc.connection.confirmTransaction({ signature: txId, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error(`Tx failed: ${JSON.stringify(confirmation.value.err)}`);
      
      log('success', '🎉 VENTE CONFIRMÉE !', { mint: cleanMint.slice(0,8)+'...', txUrl: `https://solscan.io/tx/${txId}` });
      return { success: true, txId, txUrl: `https://solscan.io/tx/${txId}` };
      
    } catch (err) {
      log('error', '❌ Jupiter sell failed', { error: err.message, mint: cleanMint.slice(0,10)+'...' });
      return { success: false, error: err.message, provider: 'jupiter' };
    }
  }
  
  async sell(mint, amount, reason, tier = null, useReal = true) {
    if (!useReal) return { success: false, error: 'simulation only' };
    const tierLabel = tier ? ` (Tier ${tier})` : '';
    log('info', `🎯 Vente${tierLabel} — ${reason}`, { mint: String(mint||'').slice(0,8)+'...', amount: parseFloat(amount).toFixed(4), mode: 'REAL' });
    return await this.executeJupiterSell(mint, amount);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOOP
// ═══════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor(wallet, rpc) {
    this.wallet = wallet; this.rpc = rpc; this.portfolio = []; this.startTime = Date.now();
    this.takeProfit = new TieredTakeProfitManager();
    this.seller = new SellExecutor(wallet, rpc);
  }
  
  async tick() {
    try {
      await this.rpc.healthCheck();
      const [accounts, accounts2022] = await Promise.all([
        this.rpc.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM) }),
        this.rpc.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM_2022) }),
      ]);
      const allAccounts = [...accounts.value, ...accounts2022.value];
      
      const tokens = [];
      let totalValue = 0, withPrice = 0, tpTriggered = 0, tpSold = 0;
      
      for (const acc of allAccounts) {
        const mintRaw = acc.account.data.parsed.info.mint;
        const mint = String(mintRaw || '').trim();
        if (!mint || mint === SOL_MINT) continue;
        
        const ta = acc.account.data.parsed.info.tokenAmount;
        const balance = parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0');
        if (balance <= 0) continue;
        
        const priceData = await fetchPriceFromDexScreener(mint);
        const price = priceData?.price || 0;
        const value = balance * price;
        
        if (price > 0) withPrice++;
        totalValue += value;
        
        this.takeProfit.trackEntry(mint, price, balance);
        
        if (CONFIG.TAKE_PROFIT_ENABLED && price > 0) {
          const config = this.takeProfit._getConfigForMint(mint);
          const pnl = this.takeProfit.getPnl(mint, price);
          
          if (pnl !== null) {
            // Trailing Stop
            const trailing = this.takeProfit.checkTrailingStop(mint, price, config);
            if (trailing) {
              log('warn', '🔻 TRAILING STOP DÉCLENCHÉ !', { mint: mint.slice(0,8)+'...', drop: `${trailing.dropFromPeak}%`, pnl: `${trailing.pnl.toFixed(2)}%` });
              const result = await this.takeProfit.executeSell(mint, balance * 0.5, 'TRAILING_STOP', null, this.seller, price);
              this.takeProfit.markTierExecuted(mint, -1, balance * 0.5, price, result.success);
              if (result.success) tpSold++;
              tpTriggered++;
              continue;
            }
            
            // Time Fallback
            const timeFallback = this.takeProfit.checkTimeFallback(mint, config);
            if (timeFallback) {
              log('info', '⏰ TIME FALLBACK DÉCLENCHÉ', { mint: mint.slice(0,8)+'...', held: `${timeFallback.hoursHeld}h`, reason: timeFallback.reason });
              const result = await this.takeProfit.executeSell(mint, balance, 'TIME_FALLBACK', null, this.seller, price);
              this.takeProfit.markTierExecuted(mint, -1, balance, price, result.success);
              if (result.success) tpSold++;
              tpTriggered++;
              continue;
            }
            
            // Tiers normaux
            const availableTiers = this.takeProfit.checkTiers(mint, price);
            for (const tier of availableTiers) {
              log('warn', '🎯 PALIER TAKE-PROFIT DÉCLENCHÉ !', { mint: mint.slice(0,8)+'...', tier: tier.tierIndex+1, target: `+${tier.pnlTarget}%`, current: `${tier.currentPnl}%` });
              const result = await this.takeProfit.executeSell(mint, tier.sellAmount, 'TAKE_PROFIT', tier.tierIndex+1, this.seller, price);
              this.takeProfit.markTierExecuted(mint, tier.tierIndex, tier.sellAmount, price, result.success);
              if (result.success) tpSold++;
              tpTriggered++;
              for (let i = 0; i < config.tiers.length; i++) this.takeProfit.maybeResetTier(mint, pnl, i);
            }
          }
        }
        
        tokens.push({
          mint: mint.slice(0,8)+'...'+mint.slice(-4), mintFull: mint, balance: parseFloat(balance.toFixed(4)),
          price: price > 0 ? parseFloat(price.toFixed(6)) : null, value: parseFloat(value.toFixed(2)),
          pnl: price > 0 ? this.takeProfit.getPnl(mint, price) : null,
          logo: priceData?.logo || null, symbol: priceData?.symbol || null, name: priceData?.name || null,
          triggeredTiers: Array.from(this.takeProfit.triggeredTiers.get(mint)||[]).map(i => CONFIG.TAKE_PROFIT_TIERS[i]?.pnl+'%'),
          entryPrice: this.takeProfit.entryPrices.get(mint)?.price || null,
          remainingBalance: this.takeProfit.getRemainingBalance(mint),
          change24h: priceData?.change24h || 0, liquidity: priceData?.liquidity || 0,
        });
        
        await new Promise(r => setTimeout(r, 150)); // Rate limit friendly
      }
      
      this.portfolio = tokens;
      log('info', '✅ Cycle terminé', { tokens: tokens.length, withPrice, totalValue: `$${totalValue.toFixed(2)}`, tpTriggered, tpSold, tpFailed: tpTriggered - tpSold });
      
    } catch (err) { log('error', '❌ Erreur cycle', { error: err.message }); }
  }
  
  getStats() {
    const totalValue = this.portfolio.reduce((sum, t) => sum + (t.value||0), 0);
    return {
      uptime: Math.round((Date.now()-this.startTime)/1000), tokens: this.portfolio.length,
      totalValue: parseFloat(totalValue.toFixed(2)),
      takeProfit: CONFIG.TAKE_PROFIT_ENABLED ? { enabled: true, ...this.takeProfit.getStats() } : { enabled: false },
      lastUpdate: new Date().toISOString()
    };
  }
  getNewTPNotifications() { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════
// API SERVER
// ═══════════════════════════════════════════════════════════════════════════

function startApi(bot, wallet) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
  app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION, uptime: process.uptime() }));
  app.get('/api/stats', (req, res) => res.json(bot.getStats()));
  app.get('/api/portfolio', (req, res) => res.json({ address: wallet.publicKey.toString(), tokens: bot.portfolio, timestamp: Date.now() }));
  app.get('/api/wallet', (req, res) => res.json({ address: wallet.publicKey.toString(), shortAddress: wallet.publicKey.toString().slice(0,8)+'...'+wallet.publicKey.toString().slice(-4) }));
  app.get('/api/take-profit', (req, res) => res.json(bot.takeProfit.getStats()));
  app.post('/api/sell/test', express.json(), async (req, res) => {
    const { mint, amount, reason, tier, real } = req.body;
    if (!mint) return res.status(400).json({ error: 'mint required' });
    const result = await bot.seller.sell(mint, amount||1, reason||'TEST', tier, real===true);
    res.json(result);
  });
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  const port = CONFIG.PORT;
  app.listen(port, '0.0.0.0', () => log('info', 'API démarrée', { port }));
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log('info', `🤖 SolBot-Pro v${VERSION} — Démarrage`, { env: CONFIG.NODE_ENV });
  const wallet = loadWallet();
  const rpc = getRpcConnection();
  const bot = new BotLoop(wallet, rpc);
  
  log('info', '🚀 Premier cycle...');
  await bot.tick();
  
  setInterval(() => bot.tick().catch(err => log('error', 'Erreur loop', { error: err.message })), CONFIG.INTERVAL_SEC * 1000);
  
  startApi(bot, wallet);
  log('info', '✅ Bot actif', { address: wallet.publicKey.toString().slice(0,8)+'...', interval: `${CONFIG.INTERVAL_SEC}s` });
  
  process.on('SIGINT', () => { log('info', '🛑 Arrêt'); process.exit(0); });
  process.on('uncaughtException', (err) => log('error', '💥 Exception', { error: err.message }));
}

main().catch(err => { console.error('🚨 Échec démarrage:', err.message); process.exit(1); });
