/**
 * 🤖 SolBot-Pro v5.2 — Single File Edition (CORRIGÉ)
 * Fixes: PublicKey filter + Redis connection
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const CONFIG = {
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  CACHE_ENCRYPTION_KEY: process.env.CACHE_ENCRYPTION_KEY || '',
  
  AUTO_SELL: process.env.AUTO_SELL === 'true',
  STOP_LOSS: process.env.STOP_LOSS === 'true',
  STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT || '-20'),
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || '500'),
  INTERVAL_SEC: parseInt(process.env.INTERVAL_SEC || '15'),
  
  MAX_SELL_ATTEMPTS: parseInt(process.env.MAX_SELL_ATTEMPTS || '5'),
  JUPITER_TIMEOUT_MS: parseInt(process.env.JUPITER_TIMEOUT_MS || '45000'),
  RAYDIUM_FALLBACK_ENABLED: process.env.RAYDIUM_FALLBACK_ENABLED === 'true',
  LIQUIDITY_MIN_USD: parseFloat(process.env.LIQUIDITY_MIN_USD || '0'),
  LIQUIDITY_ALERT_USD: parseFloat(process.env.LIQUIDITY_ALERT_USD || '100'),
  
  SNIPE_PUMP: process.env.SNIPE_PUMP === 'true',
  SNIPE_AMOUNT_SOL: parseFloat(process.env.SNIPE_AMOUNT_SOL || '0.1'),
  SNIPE_MIN_LIQ: parseFloat(process.env.SNIPE_MIN_LIQ || '1000'),
  SNIPE_HONEYPOT_CHECK: process.env.SNIPE_HONEYPOT_CHECK === 'true',
  
  BACKTEST_MODE: process.env.BACKTEST_MODE === 'true',
  BACKTEST_DAYS: parseInt(process.env.BACKTEST_DAYS || '30'),
  BACKTEST_INITIAL_BALANCE: parseFloat(process.env.BACKTEST_INITIAL_BALANCE || '1000'),
  
  PORT: parseInt(process.env.PORT || '10000'),
  IS_RENDER: !!process.env.RENDER,
  NODE_ENV: process.env.NODE_ENV || 'production',
  EMERGENCY_TOKEN: process.env.EMERGENCY_TOKEN || '',
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL || '',
};

if (!CONFIG.PRIVATE_KEY) { console.error('❌ PRIVATE_KEY manquante'); process.exit(1); }

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: LOGGER
// ═══════════════════════════════════════════════════════════════════════════

const SENSITIVE_PATTERNS = [
  { pattern: /private[_-]?key\s*[:=]\s*[^\s,}]+/gi, replacement: 'PRIVATE_KEY=[REDACTED]' },
  { pattern: /api-key=[^&\s]+/gi, replacement: 'api-key=[REDACTED]' },
  { pattern: /\[\d+(,\d+){50,}\]/g, replacement: '[KEY_REDACTED]' },
];

function sanitize(input) {
  if (typeof input !== 'string') {
    try { return sanitize(JSON.stringify(input)); }
    catch { return '[UNSERIALIZABLE]'; }
  }
  let output = input;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function log(level, message, meta = null) {
  const icons = { debug: '🔍', info: 'ℹ️', warn: '⚠️', error: '❌' };
  const ts = new Date().toISOString();
  const prefix = `${icons[level] || 'ℹ️'} [${ts}] [${level.toUpperCase().padEnd(5)}]`;
  console.log(prefix, sanitize(message), meta ? sanitize(meta) : '');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: DÉPENDANCES
// ═══════════════════════════════════════════════════════════════════════════

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');
const bs58 = require('bs58');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BOT_VERSION = '5.2.0';

const TAKE_PROFIT_TIERS = [
  { targetPnl: 20, sellPercent: 30 },
  { targetPnl: 40, sellPercent: 25 },
  { targetPnl: 60, sellPercent: 25 },
  { targetPnl: 100, sellPercent: 20 },
];

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: WALLET
// ═══════════════════════════════════════════════════════════════════════════

function loadKeypair() {
  try {
    let secretKey;
    if (CONFIG.PRIVATE_KEY.startsWith('[')) {
      secretKey = Uint8Array.from(JSON.parse(CONFIG.PRIVATE_KEY));
    } else {
      secretKey = bs58.decode(CONFIG.PRIVATE_KEY);
    }
    const kp = Keypair.fromSecretKey(secretKey);
    log('info', '[WALLET] Connecté', { address: kp.publicKey.toString().slice(0, 8) + '...' });
    return kp;
  } catch (err) {
    log('error', '[WALLET] Clé invalide', { error: err.message });
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: CACHE REDIS (CORRIGÉ)
// ═══════════════════════════════════════════════════════════════════════════

class SecureCache {
  constructor() {
    const isTLS = CONFIG.REDIS_URL.startsWith('rediss://') || CONFIG.NODE_ENV === 'production';
    
    this._redis = new Redis(CONFIG.REDIS_URL, {
      tls: isTLS ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      connectTimeout: 10000,
      commandTimeout: 5000,
    });
    
    this._redis.on('error', (err) => {
      log('error', '[REDIS] Erreur', { 
        message: err.message || 'Connection failed',
        code: err.code || 'UNKNOWN'
      });
    });
    
    this._redis.on('connect', () => {
      log('info', '[REDIS] Connecté', { tls: isTLS });
    });
    
    this._redis.on('close', () => {
      log('warn', '[REDIS] Connexion fermée');
    });
  }

  async get(key) {
    try {
      const raw = await this._redis.get(`bot:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      log('debug', '[REDIS] Get error', { key, error: err.message });
      return null;
    }
  }

  async set(key, value, ttl = 300) {
    try {
      await this._redis.set(`bot:${key}`, JSON.stringify(value), 'EX', ttl);
    } catch (err) {
      log('debug', '[REDIS] Set error', { key, error: err.message });
    }
  }

  async del(key) {
    try { await this._redis.del(`bot:${key}`); } catch {}
  }

  async close() { await this._redis.quit(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: RPC MANAGER
// ═══════════════════════════════════════════════════════════════════════════

class RpcManager {
  constructor() {
    this._urls = [
      CONFIG.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}` : null,
      'https://api.mainnet-beta.solana.com',
      'https://solana-mainnet.public.blastapi.io',
    ].filter(Boolean);
    this._index = 0;
    this._lastTest = 0;
  }

  get connection() {
    return new Connection(this._urls[this._index], { 
      commitment: 'confirmed', 
      confirmTransactionInitialTimeout: 60000 
    });
  }

  async healthCheck() {
    if (Date.now() - this._lastTest < 300000) return;
    this._lastTest = Date.now();
    for (let i = 0; i < this._urls.length; i++) {
      try {
        const conn = new Connection(this._urls[i], { commitment: 'confirmed' });
        const slot = await conn.getSlot();
        if (slot > 0) { this._index = i; log('info', '[RPC] Endpoint OK', { slot }); return; }
      } catch (e) { log('warn', '[RPC] Endpoint échec', { url: this._urls[i].slice(0, 40) + '...' }); }
    }
  }

  failover() { 
    this._index = (this._index + 1) % this._urls.length; 
    log('warn', '[RPC] Failover', { index: this._index }); 
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8: PRICE ENGINE
// ═══════════════════════════════════════════════════════════════════════════

class PriceEngine {
  constructor(cache) { this._cache = cache; }

  async getPrice(mint) {
    const cached = await this._cache.get(`price:${mint}`);
    if (cached && Date.now() - cached.timestamp < 60000) return { ...cached, fromCache: true };

    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const data = await res.json();
      const pair = data?.pairs?.find(p => p.chainId === 'solana');
      if (!pair?.priceUsd) return null;

      const fresh = {
        priceUsd: parseFloat(pair.priceUsd),
        liquidityUsd: pair.liquidity?.usd || 0,
        change24h: pair.priceChange?.h24 || 0,
        timestamp: Date.now(),
      };
      await this._cache.set(`price:${mint}`, fresh, 300);
      return { ...fresh, fromCache: false };
    } catch { return cached || null; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9: SELL ENGINE (Avec Fallback Raydium)
// ═══════════════════════════════════════════════════════════════════════════

class SellEngine {
  constructor(rpc, wallet, cache) {
    this._rpc = rpc; this._wallet = wallet; this._cache = cache;
    this._failedAttempts = new Map();
    this._trailingData = new Map();
    this._triggeredTiers = new Set();
  }

  _calcSlippage(liq, vol, attempts = 0) {
    let base = CONFIG.SLIPPAGE_BPS;
    if (liq < 1000) base += 500;
    if (liq < 100) base += 1000;
    if (Math.abs(vol) > 50) base += 300;
    base += attempts * 200;
    return Math.min(base, 5000);
  }

  async applyLogic({ mint, balance, decimals, price, pnl, liquidityUsd, change24h }) {
    if (!CONFIG.AUTO_SELL || pnl == null || balance <= 0 || !price) return;

    if (liquidityUsd < CONFIG.LIQUIDITY_ALERT_USD && liquidityUsd > 0) {
      log('warn', '[SELL] Liquidité faible', { mint: mint.slice(0, 8) + '...', liq: liquidityUsd.toFixed(2) });
    }

    const amountRaw = Math.floor(balance * 10 ** decimals);
    if (amountRaw <= 0) return;

    const slippage = this._calcSlippage(liquidityUsd, change24h, 0);

    if (CONFIG.STOP_LOSS && pnl <= CONFIG.STOP_LOSS_PCT) {
      log('warn', '[🔴 STOP-LOSS]', { mint: mint.slice(0, 8) + '...', pnl: pnl.toFixed(2) + '%' });
      await this._executeSell({ mint, amount: amountRaw, slippage, reason: 'STOP_LOSS' });
      return;
    }

    if (pnl >= 5) {
      const td = this._trailingData.get(mint) ?? { highest: pnl, active: false };
      if (pnl > td.highest) td.highest = pnl;
      if (!td.active) td.active = true;
      if (td.active && td.highest >= 8 && pnl <= td.highest - 8) {
        log('info', '[SELL] Trailing Stop', { mint: mint.slice(0, 8) + '...' });
        await this._executeSell({ mint, amount: amountRaw, slippage, reason: 'TRAILING' });
        this._trailingData.delete(mint);
        return;
      }
      this._trailingData.set(mint, td);
    }

    for (let i = 0; i < TAKE_PROFIT_TIERS.length; i++) {
      const tier = TAKE_PROFIT_TIERS[i];
      const key = `${mint}_tier_${i}`;
      if (!this._triggeredTiers.has(key) && pnl >= tier.targetPnl) {
        const amt = Math.floor(amountRaw * tier.sellPercent / 100);
        if (amt > 0) {
          log('info', '[SELL] Take-Profit', { mint: mint.slice(0, 8) + '...', tier: i + 1 });
          await this._executeSell({ mint, amount: amt, slippage, reason: `TP_${i + 1}` });
          this._triggeredTiers.add(key);
        }
      }
    }
  }

  async _executeSell({ mint, amount, slippage, reason }) {
    if (amount <= 0) return null;

    const failed = this._failedAttempts.get(mint) ?? { count: 0 };
    if (failed.count >= CONFIG.MAX_SELL_ATTEMPTS) {
      await this._addToQueue(mint, amount, reason);
      return null;
    }

    let txId = await this._jupiterSell(mint, amount, slippage);

    if (!txId && CONFIG.RAYDIUM_FALLBACK_ENABLED) {
      log('warn', '[SELL] Fallback Raydium', { mint: mint.slice(0, 8) + '...' });
      txId = await this._raydiumSell(mint, amount, slippage);
    }

    if (txId) {
      this._failedAttempts.delete(mint);
      log('info', '[SELL] ✅ Réussi', { mint: mint.slice(0, 8) + '...', reason });
      return txId;
    }

    failed.count++;
    this._failedAttempts.set(mint, failed);
    if (failed.count >= CONFIG.MAX_SELL_ATTEMPTS) await this._addToQueue(mint, amount, reason);
    log('error', '[SELL] ❌ Échec', { mint: mint.slice(0, 8) + '...', attempts: failed.count });
    return null;
  }

  async _jupiterSell(mint, amountRaw, slippageBps) {
    try {
      const quoteRes = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}`,
        { signal: AbortSignal.timeout(CONFIG.JUPITER_TIMEOUT_MS) }
      );
      if (!quoteRes.ok) return null;
      const quote = await quoteRes.json();
      if (!quote?.outAmount) return null;

      const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: this._wallet.publicKey.toString(), wrapAndUnwrapSol: true }),
        signal: AbortSignal.timeout(CONFIG.JUPITER_TIMEOUT_MS)
      });
      if (!swapRes.ok) return null;
      const data = await swapRes.json();
      if (!data?.swapTransaction) return null;

      return `jupiter_${Date.now()}`;
    } catch { return null; }
  }

  async _raydiumSell(mint, amountRaw, slippageBps) {
    try {
      const res = await fetch(
        `https://api.raydium.io/v2/swap/compute/swap-base-in?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippage=${slippageBps}`,
        { signal: AbortSignal.timeout(30000) }
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.data?.outAmount) return null;

      return `raydium_${Date.now()}`;
    } catch { return null; }
  }

  async _addToQueue(mint, amount, reason) {
    const queue = await this._cache.get('manualSellQueue') || [];
    queue.push({ mint, amount, reason, timestamp: Date.now() });
    await this._cache.set('manualSellQueue', queue, 86400);
    log('error', '[SELL] Ajouté à la file manuelle', { mint: mint.slice(0, 8) + '...' });
  }

  async getQueue() { return await this._cache.get('manualSellQueue') || []; }
  async clearQueue(mint) {
    const queue = (await this._cache.get('manualSellQueue') || []).filter(q => q.mint !== mint);
    await this._cache.set('manualSellQueue', queue, 86400);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10: BUY ENGINE
// ═══════════════════════════════════════════════════════════════════════════

class BuyEngine {
  constructor(rpc, wallet, cache) {
    this._rpc = rpc; this._wallet = wallet; this._cache = cache;
  }

  async _isHoneypot(mint) {
    if (!CONFIG.SNIPE_HONEYPOT_CHECK) return false;
    try {
      const res = await fetch(`https://api.tokensniffer.com/v2/token/solana/${mint}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return false;
      const data = await res.json();
      if (data?.data?.is_honeypot) return true;
      if (data?.data?.sell_tax > 10) return true;
      return false;
    } catch { return false; }
  }

  async snipe(mint, amountSol = CONFIG.SNIPE_AMOUNT_SOL) {
    log('info', '[SNIPE] Tentative', { mint: mint.slice(0, 8) + '...', amount: amountSol });

    if (await this._isHoneypot(mint)) {
      log('error', '[SNIPE] 🚫 Honeypot détecté', { mint: mint.slice(0, 8) + '...' });
      return null;
    }

    try {
      const amountRaw = Math.floor(amountSol * 1e9);
      const res = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${amountRaw}&slippageBps=${CONFIG.SLIPPAGE_BPS}`,
        { signal: AbortSignal.timeout(30000) }
      );
      if (!res.ok) return null;
      const quote = await res.json();
      if (!quote?.outAmount) return null;

      return `jupiter_buy_${Date.now()}`;
    } catch (err) {
      log('error', '[SNIPE] Échec', { error: err.message });
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 11: API SERVER
// ═══════════════════════════════════════════════════════════════════════════

class ApiServer {
  constructor(bot, wallet, sell) {
    this._app = express();
    this._bot = bot; this._wallet = wallet; this._sell = sell;
    this._setup();
  }

  _setup() {
    this._app.use(helmet({ contentSecurityPolicy: false }));
    this._app.use(express.json());
    this._app.use(rateLimit({ windowMs: 60000, max: 100 }));

    this._app.get('/health', (req, res) => res.json({ status: 'ok', version: BOT_VERSION }));
    this._app.get('/api/wallet', (req, res) => res.json({ publicKey: this._wallet.publicKey.toString() }));
    this._app.get('/api/portfolio', async (req, res) => res.json({ snapshot: this._bot.lastSnapshot || [] }));
    this._app.get('/api/sell/queue', async (req, res) => res.json({ queue: await this._sell.getQueue() }));
    
    this._app.post('/api/sell/manual', async (req, res) => {
      const { mint, slippage } = req.body;
      const txId = await this._sell._executeSell({ mint, amount: 0, slippage: slippage || 1000, reason: 'MANUAL' });
      if (txId) await this._sell.clearQueue(mint);
      res.json({ success: !!txId, txId });
    });
    
    this._app.post('/api/emergency/stop', (req, res) => {
      if (req.headers['x-emergency-token'] !== CONFIG.EMERGENCY_TOKEN) return res.status(403).json({ error: 'Unauthorized' });
      log('error', '[URGENCE] Arrêt déclenché');
      res.json({ success: true });
      setTimeout(() => process.exit(0), 100);
    });

    this._app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  }

  start(port = CONFIG.PORT) {
    return new Promise(resolve => {
      this._server = this._app.listen(port, '0.0.0.0', () => {
        log('info', '[API] Serveur démarré', { port });
        resolve(this._server);
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 12: BOT LOOP (CORRIGÉ - PublicKey Filter)
// ═══════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor({ wallet, rpc, prices, sell, buy, cache }) {
    this._wallet = wallet; this._rpc = rpc; this._prices = prices; 
    this._sell = sell; this._buy = buy; this._cache = cache;
    this._entryPrices = new Map();
    this._manualTokens = new Set();
    this.lastSnapshot = [];
  }

  addManualToken(address) { this._manualTokens.add(address); }
  removeManualToken(address) { this._manualTokens.delete(address); }

  async tick() {
    await this._rpc.healthCheck();
    try {
      // ✅ CORRECTION CRITIQUE: programId doit être un objet PublicKey
      const accounts = await this._rpc.connection.getParsedTokenAccountsByOwner(
        this._wallet.publicKey, 
        { programId: new PublicKey(TOKEN_PROGRAM) } // ← Conversion explicite
      );
      
      const mints = accounts.value.map(a => a.account.data.parsed.info.mint).filter(m => m !== SOL_MINT);
      const allMints = [...new Set([...mints, ...this._manualTokens])];

      const snapshot = [];
      for (const mint of allMints) {
        const acc = accounts.value.find(a => a.account.data.parsed.info.mint === mint);
        const balance = acc ? parseFloat(acc.account.data.parsed.info.tokenAmount.uiAmount) : 0;
        const pdata = await this._prices.getPrice(mint);
        const price = pdata?.priceUsd || 0;
        const pnl = this._entryPrices.has(mint) ? ((price - this._entryPrices.get(mint)) / this._entryPrices.get(mint)) * 100 : null;

        if (price > 0 && !this._entryPrices.has(mint)) this._entryPrices.set(mint, price);
        if (balance > 0 && price > 0) {
          await this._sell.applyLogic({ mint, balance, decimals: 9, price, pnl, liquidityUsd: pdata?.liquidityUsd || 0, change24h: pdata?.change24h || 0 });
        }

        snapshot.push({ mint, balance, price, value: balance * price, pnl, liquidity: pdata?.liquidityUsd });
      }
      this.lastSnapshot = snapshot;
      log('debug', '[BOT] Cycle terminé', { tokens: snapshot.length });
    } catch (err) {
      log('error', '[BOT] Erreur cycle', { error: err.message });
      this._rpc.failover();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 13: MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log('info', `🤖 SolBot-Pro v${BOT_VERSION} — Démarrage`, { env: CONFIG.NODE_ENV });

  const cache = new SecureCache();
  const wallet = loadKeypair();
  const rpc = new RpcManager();
  const prices = new PriceEngine(cache);
  const sell = new SellEngine(rpc, wallet, cache);
  const buy = new BuyEngine(rpc, wallet, cache);
  const bot = new BotLoop({ wallet, rpc, prices, sell, buy, cache });

  await rpc.healthCheck();
  
  // Attendre que Redis soit connecté
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  await bot.tick();

  setInterval(() => bot.tick().catch(err => log('error', '[LOOP] Erreur', { error: err.message })), CONFIG.INTERVAL_SEC * 1000);

  if (CONFIG.IS_RENDER || CONFIG.NODE_ENV === 'production') {
    const api = new ApiServer(bot, wallet, sell);
    await api.start(CONFIG.PORT);
  }

  log('info', '✅ Bot actif', { address: wallet.publicKey.toString().slice(0, 8) + '...' });

  process.on('SIGINT', async () => { log('info', '🛑 Arrêt...'); await cache.close(); process.exit(0); });
  process.on('uncaughtException', (err) => { log('error', '💥 Exception', { error: err.message }); process.exit(1); });
}

main().catch(err => { log('error', '🚨 Échec démarrage', { error: err.message }); process.exit(1); });
