/**
 * 🤖 SolBot-Basic v1.0 — Minimal Working Version
 * Objectif: Stable, simple, fonctionnel. On ajoute les features après.
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION (Via Variables d'Environnement)
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  PORT: parseInt(process.env.PORT) || 10000,
  INTERVAL_SEC: parseInt(process.env.INTERVAL_SEC) || 30,
  NODE_ENV: process.env.NODE_ENV || 'production',
};

// Validation minimale
if (!CONFIG.PRIVATE_KEY) {
  console.error('❌ Erreur: PRIVATE_KEY non définie dans les variables d\'environnement');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// DÉPENDANCES
// ═══════════════════════════════════════════════════════════════════════════

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const VERSION = '1.0.0';

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER SIMPLE (Sans fuite de données sensibles)
// ═══════════════════════════════════════════════════════════════════════════

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const icon = { info: 'ℹ️', warn: '⚠️', error: '❌', debug: '🔍' }[level] || 'ℹ️';
  
  // Masquer les données sensibles
  const safeMsg = String(msg)
    .replace(/PRIVATE_KEY[=:]\S+/gi, 'PRIVATE_KEY=[REDACTED]')
    .replace(/api-key=[^&\s]+/gi, 'api-key=[REDACTED]');
  
  const safeData = data ? JSON.stringify(data).slice(0, 200) : '';
  console.log(`${icon} [${ts}] [${level.toUpperCase()}] ${safeMsg} ${safeData}`.trim());
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET — Chargement sécurisé de la clé
// ═══════════════════════════════════════════════════════════════════════════

function loadWallet() {
  try {
    let secretKey;
    
    // Support format JSON array [1,2,3...] ou base58
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
    log('error', 'Clé privée invalide', { error: err.message });
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RPC — Connexion Solana avec fallback
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
          if (slot > 0) {
            index = i;
            log('info', 'RPC OK', { endpoint: endpoints[i].slice(0, 40) + '...', slot });
            return true;
          }
        } catch (e) {
          log('warn', 'RPC échec', { endpoint: endpoints[i].slice(0, 40) + '...' });
        }
      }
      return false;
    },
    
    failover() {
      index = (index + 1) % endpoints.length;
      log('warn', 'RPC failover', { newIndex: index });
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIX — Récupération simple depuis DexScreener
// ═══════════════════════════════════════════════════════════════════════════

const priceCache = new Map(); // Cache mémoire simple

async function getTokenPrice(mint) {
  // Retourner le cache si récent (< 60s)
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.ts < 60000) {
    return cached.data;
  }
  
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(10000)
    });
    
    if (!res.ok) return null;
    const data = await res.json();
    
    const pair = data?.pairs?.find(p => p.chainId === 'solana');
    if (!pair?.priceUsd) return null;
    
    const result = {
      price: parseFloat(pair.priceUsd),
      liquidity: pair.liquidity?.usd || 0,
      change24h: pair.priceChange?.h24 || 0,
    };
    
    // Mettre en cache
    priceCache.set(mint, { data: result, ts: Date.now() });
    return result;
    
  } catch (err) {
    log('debug', 'Prix non disponible', { mint: mint.slice(0, 8) + '...', error: err.message });
    return cached?.data || null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOOP — Cycle principal de surveillance
// ═══════════════════════════════════════════════════════════════════════════

class BotLoop {
  constructor(wallet, rpc) {
    this.wallet = wallet;
    this.rpc = rpc;
    this.portfolio = [];
    this.startTime = Date.now();
  }
  
  async tick() {
    try {
      // Vérifier la connexion RPC
      await this.rpc.healthCheck();
      
      // Récupérer les tokens du wallet
      const accounts = await this.rpc.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { programId: new PublicKey(TOKEN_PROGRAM) }
      );
      
      const tokens = [];
      
      for (const acc of accounts.value) {
        const mint = acc.account.data.parsed.info.mint;
        if (mint === SOL_MINT) continue; // Ignorer SOL natif
        
        const balance = parseFloat(acc.account.data.parsed.info.tokenAmount.uiAmount);
        if (balance <= 0) continue;
        
        // Récupérer le prix
        const priceData = await getTokenPrice(mint);
        const price = priceData?.price || 0;
        const value = balance * price;
        
        tokens.push({
          mint: mint.slice(0, 8) + '...' + mint.slice(-4),
          balance: parseFloat(balance.toFixed(4)),
          price: price > 0 ? parseFloat(price.toFixed(6)) : null,
          value: parseFloat(value.toFixed(2)),
          liquidity: priceData?.liquidity || 0,
          change24h: priceData?.change24h || 0,
        });
      }
      
      this.portfolio = tokens;
      
      // Log résumé
      const totalValue = tokens.reduce((sum, t) => sum + t.value, 0);
      log('debug', 'Cycle terminé', { tokens: tokens.length, totalValue: `$${totalValue.toFixed(2)}` });
      
    } catch (err) {
      log('error', 'Erreur cycle', { error: err.message });
      this.rpc.failover();
    }
  }
  
  getStats() {
    const totalValue = this.portfolio.reduce((sum, t) => sum + t.value, 0);
    return {
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      tokens: this.portfolio.length,
      totalValue: parseFloat(totalValue.toFixed(2)),
      lastUpdate: new Date().toISOString(),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API SERVER — Dashboard simple
// ═══════════════════════════════════════════════════════════════════════════

function startApi(bot, wallet) {
  const app = express();
  
  app.use(express.json());
  
  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: VERSION, uptime: process.uptime() });
  });
  
  // Stats du bot
  app.get('/api/stats', (req, res) => {
    res.json(bot.getStats());
  });
  
  // Portfolio complet
  app.get('/api/portfolio', (req, res) => {
    res.json({
      address: wallet.publicKey.toString(),
      tokens: bot.portfolio,
      timestamp: Date.now(),
    });
  });
  
  // Wallet info (publique seulement)
  app.get('/api/wallet', (req, res) => {
    res.json({
      address: wallet.publicKey.toString(),
      shortAddress: wallet.publicKey.toString().slice(0, 8) + '...' + wallet.publicKey.toString().slice(-4),
    });
  });
  
  // 404 handler
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  
  // Démarrer le serveur
  const port = CONFIG.PORT;
  app.listen(port, '0.0.0.0', () => {
    log('info', 'API démarrée', { port, url: `http://localhost:${port}` });
  });
  
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log('info', `🤖 SolBot-Basic v${VERSION} — Démarrage`, { env: CONFIG.NODE_ENV });
  
  // Initialisation
  const wallet = loadWallet();
  const rpc = getRpcConnection();
  const bot = new BotLoop(wallet, rpc);
  
  // Premier cycle
  log('info', 'Premier cycle...');
  await bot.tick();
  
  // Boucle périodique
  setInterval(() => {
    bot.tick().catch(err => log('error', 'Erreur loop', { error: err.message }));
  }, CONFIG.INTERVAL_SEC * 1000);
  
  // API Dashboard
  startApi(bot, wallet);
  
  log('info', '✅ Bot actif', { 
    address: wallet.publicKey.toString().slice(0, 8) + '...',
    interval: `${CONFIG.INTERVAL_SEC}s`
  });
  
  // Gestion arrêt propre
  process.on('SIGINT', () => {
    log('info', '🛑 Arrêt demandé');
    process.exit(0);
  });
  
  process.on('uncaughtException', (err) => {
    log('error', '💥 Exception non gérée', { error: err.message });
  });
}

// Lancer le bot
main().catch(err => {
  console.error('🚨 Échec démarrage:', err.message);
  process.exit(1);
});
