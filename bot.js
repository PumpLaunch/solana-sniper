/**
 * 🤖 SolBot-Basic v1.3.6 — Fix: Jupiter API Headers + Real Trades
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
if (typeof global.fetch === 'function') { fetch = global.fetch; } 
else { fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)); }

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const VERSION = '1.3.6';

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
          const slot = await new Connection(endpoints[i], { commitment: 'confirmed' }).getSlot();
          if (slot > 0) { index = i; return true; }
        } catch {}
      }
      return false;
    },
    failover() { index = (index + 1) % endpoints.length; }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIX — DEXSCREENER UNIQUEMENT (Fonctionne ✅)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchPriceFromDexScreener(mint) {
  const cleanMint = String(mint || '').trim();
  if (!cleanMint || cleanMint.length < 32 || cleanMint === SOL_MINT) return null;
  
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${cleanMint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    
    if (!res.ok) return null;
    
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
    
    return {
      price,
      liquidity: pair.liquidity?.usd || 0,
      change24h: pair.priceChange?.h24 || 0,
      logo: pair.info?.imageUrl || pair.baseToken?.logoUri || null,
      symbol: pair.baseToken?.symbol || null,
      name: pair.baseToken?.name || null,
      source: 'dexscreener'
    };
    
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TAKE-PROFIT MANAGER
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
// 🔄 SELL EXECUTOR — FIX JUPITER HEADERS ✅
// ═══════════════════════════════════════════════════════════════════════════

class SellExecutor {
  constructor(wallet, rpc) { 
    this.wallet = wallet; 
    this.rpc = rpc; 
  }
  
  async executeJupiterSell(mint, amount, slippageBps = 500) {
    try {
      const tokenDecimals = 9;
      const amountRaw = BigInt(Math.floor(amount * Math.pow(10, tokenDecimals)));
      const cleanMint = String(mint||'').trim();
      
      // ✅ HEADERS JUPITER CORRIGÉS — C'EST ICI LE FIX !
      const jupiterHeaders = {
        'User-Agent': 'Mozilla/5.0 (compatible; SolBot/1.3.6; +https://solana.local)',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'https://jup.ag',
        'Referer': 'https://jup.ag/'
      };
      
      // 1. Get Quote
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${cleanMint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`;
      
      log('debug', '🔎 Jupiter Quote', { mint: cleanMint.slice(0,10)+'...', amount, url: quoteUrl.slice(0,100) });
      
      const quoteRes = await fetch(quoteUrl, {
        headers: jupiterHeaders,
        signal: AbortSignal.timeout(30000)
      });
      
      if (!quoteRes.ok) {
        const body = await quoteRes.text().catch(() => 'N/A');
        log('error', '❌ Jupiter Quote HTTP error', { status: quoteRes.status, body: body.slice(0,200) });
        throw new Error(`Quote HTTP ${quoteRes.status}: ${body.slice(0,100)}`);
      }
      
      const quote = await quoteRes.json();
      if (!quote?.outAmount) throw new Error('No quote outAmount');
      
      log('debug', '✅ Jupiter Quote OK', { outAmount: quote.outAmount, priceImpact: quote.priceImpactPct });
      
      // 2. Get Swap Transaction
      const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: jupiterHeaders,
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto'
        }),
        signal: AbortSignal.timeout(30000)
      });
      
      if (!swapRes.ok) {
        const body = await swapRes.text().catch(() => 'N/A');
        log('error', '❌ Jupiter Swap HTTP error', { status: swapRes.status, body: body.slice(0,200) });
        throw new Error(`Swap HTTP ${swapRes.status}: ${body.slice(0,100)}`);
      }
      
      const swapData = await swapRes.json();
      if (!swapData?.swapTransaction) throw new Error('No swapTransaction in response');
      
      // 3. Deserialize, Sign & Send
      const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      transaction.sign([this.wallet]);
      
      const txId = await this.rpc.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed'
      });
      
      log('debug', '📤 Transaction envoyée', { txId });
      
      // 4. Confirm
      const latestBlockhash = await this.rpc.connection.getLatestBlockhash();
      const confirmation = await this.rpc.connection.confirmTransaction({
        signature: txId,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      }, 'confirmed');
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      log('success', '🎉 VENTE RÉELLE CONFIRMÉE !', { 
        mint: cleanMint.slice(0,8)+'...', 
        txUrl: `https://solscan.io/tx/${txId}`,
        amountSold: amount.toFixed(4)
      });
      
      return { 
        success: true, 
        txId, 
        txUrl: `https://solscan.io/tx/${txId}`,
        quote 
      };
      
    } catch (err) {
      log('error', '❌ Jupiter sell failed', { 
        error: err.message, 
        mint: String(mint||'').slice(0,8)+'...',
        stack: err.stack?.slice(0,300)
      });
      return { success: false, error: err.message };
    }
  }
  
  async sell(mint, amount, reason, tier = null, useReal = true) {
    if (!useReal) return { success: false, error: 'simulation only' };
    const tierLabel = tier ? ` (Tier ${tier})` : '';
    log('info', `🎯 Vente${tierLabel} — ${reason}`, { 
      mint: String(mint||'').slice(0,8)+'...', 
      amount: parseFloat(amount).toFixed(4),
      mode: 'REAL'
    });
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
      let totalValue = 0;
      let withPrice = 0;
      
      for (const acc of allAccounts) {
        const mintRaw = acc.account.data.parsed.info.mint;
        const mint = String(mintRaw || '').trim();
        
        if (!mint || mint === SOL_MINT) continue;
        
        const ta = acc.account.data.parsed.info.tokenAmount;
        const balance = parseFloat(ta.uiAmount ?? ta.uiAmountString ?? '0');
        if (balance <= 0) continue;
        
        // Fetch price from DexScreener
        const priceData = await fetchPriceFromDexScreener(mint);
        const price = priceData?.price || 0;
        const value = balance * price;
        
        if (price > 0) withPrice++;
        totalValue += value;
        
        this.takeProfit.trackEntry(mint, price, balance);
        
        // Check Take-Profit
        if (CONFIG.TAKE_PROFIT_ENABLED && price > 0) {
          const pnl = this.takeProfit.getPnl(mint, price);
          if (pnl !== null) {
            const availableTiers = this.takeProfit.checkTiers(mint, price);
            for (const tier of availableTiers) {
              log('warn', '🎯 PALIER TAKE-PROFIT DÉCLENCHÉ !', { 
                mint: mint.slice(0,8)+'...', 
                tier: tier.tierIndex+1, 
                target: `+${tier.pnlTarget}%`, 
                currentPnl: `${tier.currentPnl}%` 
              });
              // ✅ Vente réelle avec Jupiter (headers fixés)
              await this.seller.sell(mint, tier.sellAmount, 'TAKE_PROFIT', tier.tierIndex+1, true);
              this.takeProfit.markTierExecuted(mint, tier.tierIndex, tier.sellAmount, price);
            }
            for (let i = 0; i < CONFIG.TAKE_PROFIT_TIERS.length; i++) {
              this.takeProfit.maybeResetTier(mint, pnl, i);
            }
          }
        }
        
        tokens.push({
          mint: mint.slice(0,8)+'...'+mint.slice(-4), mintFull: mint,
          balance: parseFloat(balance.toFixed(4)),
          price: price > 0 ? parseFloat(price.toFixed(6)) : null,
          value: parseFloat(value.toFixed(2)),
          pnl: price > 0 ? this.takeProfit.getPnl(mint, price) : null,
          logo: priceData?.logo || null,
          symbol: priceData?.symbol || null,
          name: priceData?.name || null,
          triggeredTiers: [],
          entryPrice: this.takeProfit.entryPrices.get(mint)?.price || null,
          remainingBalance: this.takeProfit.getRemainingBalance(mint),
          change24h: priceData?.change24h || 0,
          liquidity: priceData?.liquidity || 0,
        });
        
        // Petit délai pour éviter rate limiting
        await new Promise(r => setTimeout(r, 150));
      }
      
      this.portfolio = tokens;
      
      log('info', '✅ Cycle terminé', { 
        tokens: tokens.length, 
        withPrice, 
        totalValue: `$${totalValue.toFixed(2)}` 
      });
      
    } catch (err) {
      log('error', '❌ Erreur cycle', { error: err.message });
    }
  }
  
  getStats() {
    const totalValue = this.portfolio.reduce((sum, t) => sum + (t.value||0), 0);
    return {
      uptime: Math.round((Date.now()-this.startTime)/1000),
      tokens: this.portfolio.length,
      totalValue: parseFloat(totalValue.toFixed(2)),
      takeProfit: CONFIG.TAKE_PROFIT_ENABLED ? {
        enabled: true, tiers: CONFIG.TAKE_PROFIT_TIERS.map((t,i)=>({index:i+1,pnl:t.pnl+'%',sell:t.sell+'%'})),
        hysteresis: CONFIG.TAKE_PROFIT_HYSTERESIS+'%', ...this.takeProfit.getStats()
      } : { enabled: false },
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
  log('info', `🤖 SolBot-Basic v${VERSION} — Jupiter Fix`, { env: CONFIG.NODE_ENV });
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
