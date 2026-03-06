/**
 * SolBot Pro v3.3.1 — Render Optimized Final (Mars 2026)
 * ✅ Keep-alive auto • Logs allégés • Health + RAM • render.yaml
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION + VERSION (AJOUTÉ POUR RENDER)
// ═══════════════════════════════════════════════════════════════════════════
function safeParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

const VERSION = '3.3.1';   // ← AJOUTÉ ICI (obligatoire)

const CONFIG = {
  PRIVATE_KEY:    process.env.PRIVATE_KEY,
  API_KEY:        process.env.API_KEY || 'CHANGE_ME_32_CHAR_RANDOM_KEY',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || null,
  PORT:           parseInt(process.env.PORT) || 10000,
  INTERVAL_SEC:   parseInt(process.env.INTERVAL_SEC) || 30,
  TOKEN_ACCOUNT_CACHE_CYCLES: parseInt(process.env.TOKEN_ACCOUNT_CACHE_CYCLES) || 10,
  PRICE_PREFETCH_CONCURRENCY: parseInt(process.env.PRICE_PREFETCH_CONCURRENCY) || 8,
  PERSIST_DEBOUNCE_MS:        parseInt(process.env.PERSIST_DEBOUNCE_MS) || 30000,
  API_CACHE_TTL_MS:           parseInt(process.env.API_CACHE_TTL_MS) || 5000,
  WS_PING_INTERVAL_MS:        55000,
  WS_RECONNECT_MS:            5000,

  TAKE_PROFIT_ENABLED:    process.env.TAKE_PROFIT_ENABLED !== 'false',
  TAKE_PROFIT_TIERS:      safeParseJson(process.env.TAKE_PROFIT_TIERS, [{ pnl: 20, sell: 25 }, { pnl: 40, sell: 25 }, { pnl: 60, sell: 25 }, { pnl: 100, sell: 25 }]),
  TAKE_PROFIT_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),
  BREAK_EVEN_ENABLED: process.env.BREAK_EVEN_ENABLED !== 'false',
  BREAK_EVEN_BUFFER:  parseFloat(process.env.BREAK_EVEN_BUFFER || '2'),
  STOP_LOSS_ENABLED: process.env.STOP_LOSS_ENABLED !== 'false',
  STOP_LOSS_PCT:     parseFloat(process.env.STOP_LOSS_PCT || '-50'),
  TRAILING_STOP_ENABLED: process.env.TRAILING_STOP_ENABLED === 'true',
  TRAILING_STOP_PCT:     parseFloat(process.env.TRAILING_STOP_PCT || '20'),
  TRAILING_VOL_ENABLED:  process.env.TRAILING_VOL_ENABLED === 'true',
  TRAILING_VOL_MULT:     parseFloat(process.env.TRAILING_VOL_MULT || '2.5'),
  ANTI_RUG_ENABLED: process.env.ANTI_RUG_ENABLED !== 'false',
  ANTI_RUG_PCT:     parseFloat(process.env.ANTI_RUG_PCT || '60'),
  LIQ_EXIT_ENABLED: process.env.LIQ_EXIT_ENABLED !== 'false',
  LIQ_EXIT_PCT:     parseFloat(process.env.LIQ_EXIT_PCT || '70'),
  TIME_STOP_ENABLED: process.env.TIME_STOP_ENABLED === 'true',
  TIME_STOP_HOURS:   parseFloat(process.env.TIME_STOP_HOURS || '24'),
  TIME_STOP_MIN_PNL: parseFloat(process.env.TIME_STOP_MIN_PNL || '0'),
  MOMENTUM_EXIT_ENABLED: process.env.MOMENTUM_EXIT_ENABLED === 'true',
  MOMENTUM_THRESHOLD:    parseFloat(process.env.MOMENTUM_THRESHOLD || '-3'),
  MOMENTUM_WINDOW:       parseInt(process.env.MOMENTUM_WINDOW || '5'),
  JITO_ENABLED: process.env.JITO_ENABLED === 'true',
  JITO_TIP_SOL: parseFloat(process.env.JITO_TIP_SOL || '0.0001'),
  JITO_URL:     process.env.JITO_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  MAX_POSITIONS:    parseInt(process.env.MAX_POSITIONS || '100'),
  MIN_SCORE_TO_BUY: parseFloat(process.env.MIN_SCORE_TO_BUY || '0'),
  MIN_SOL_RESERVE:  parseFloat(process.env.MIN_SOL_RESERVE || '0.005'),
  MAX_SELL_RETRIES: parseInt(process.env.MAX_SELL_RETRIES || '20'),
  DEFAULT_SLIPPAGE: parseInt(process.env.DEFAULT_SLIPPAGE || '500'),
  PRICE_TTL_MS:     parseInt(process.env.PRICE_TTL_MS || '55000'),
  BUY_COOLDOWN_MS:  parseInt(process.env.BUY_COOLDOWN_MS || '5000'),
  WEBHOOK_URL:      process.env.WEBHOOK_URL || null,
  WEBHOOK_TYPE:     process.env.WEBHOOK_TYPE || 'discord',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,
};

if (!CONFIG.PRIVATE_KEY) { console.error('❌ PRIVATE_KEY manquante'); process.exit(1); }

// ═══════════════════════════════════════════════════════════════════════════
// DÉPENDANCES (identique)
// ═══════════════════════════════════════════════════════════════════════════
const { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const JITO_TIP_WALLET = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER (optimisé Render : debug silencieux en prod)
// ═══════════════════════════════════════════════════════════════════════════
const ICONS = { info: 'ℹ️', warn: '⚠️', error: '❌', debug: '🔍', success: '✅' };
function log(level, msg, data = null) {
  if (CONFIG.NODE_ENV === 'production' && level === 'debug') return;
  const ts = new Date().toISOString();
  const safe = String(msg).replace(/PRIVATE_KEY[=:]\S+/gi, '[REDACTED]');
  const sfx = data ? ' ' + JSON.stringify(data).slice(0, 200) : '';
  console.log(`\( {ICONS[level]} [ \){ts}] [${level.toUpperCase()}] \( {safe} \){sfx}`);
}

// === CONFIGURATION (inchangée sauf NODE_ENV) ===
function safeParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

const CONFIG = {
  // ... (exactement la même config que v3.3.0 — je ne la répète pas pour clarté)
  // Copie-colle ta config complète ici (PRIVATE_KEY, API_KEY, HELIUS_API_KEY, etc.)
  NODE_ENV: process.env.NODE_ENV || 'production',
  // ... toutes les autres variables
};

// === DÉPENDANCES + LOGGER (optimisé Render) ===
const { /* ... */ } = require('@solana/web3.js');
const express = require('express');
const WebSocket = require('ws');
// ... autres requires

function log(level, msg, data = null) {
  if (CONFIG.NODE_ENV === 'production' && level === 'debug') return; // silence debug en prod
  const ts = new Date().toISOString();
  const safe = String(msg).replace(/PRIVATE_KEY[=:]\S+/gi, '[REDACTED]');
  console.log(`\( {ICONS[level]} [ \){ts}] [${level.toUpperCase()}] \( {safe} \){data ? ' ' + JSON.stringify(data).slice(0,200) : ''}`);
}

// === HELIUS WS, BOT LOOP, API SERVER (identiques v3.3.0) ===
// Copie-colle ici tout le code de ta v3.3.0 (HeliusWebSocketManager, BotLoop, PositionManager, etc.)

// === AJOUT RENDER : KEEP-ALIVE + HEALTH ENRICHIE ===
function startApi(bot, wallet) {
  const app = express();
  // ... (sécurité + cache middleware identiques)

  app.get('/health', (_, res) => {
    const mem = process.memoryUsage();
    res.json({
      status: 'ok',
      version: VERSION,
      uptime: process.uptime(),
      memory: {
        rss: (mem.rss / 1024 / 1024).toFixed(1) + ' MB',
        heap: (mem.heapUsed / 1024 / 1024).toFixed(1) + ' MB'
      },
      tokens: bot.portfolio.length,
      render: !!process.env.RENDER
    });
  });

  // ... toutes tes routes /api/

  const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
    log('info', `🚀 SolBot démarré sur port ${CONFIG.PORT} (Render optimized)`);
  });

  // KEEP-ALIVE Render gratuit
  if (process.env.RENDER) {
    setInterval(() => {
      fetch(`http://127.0.0.1:${CONFIG.PORT}/health`).catch(() => {});
      log('debug', 'Keep-alive Render envoyé');
    }, 600000); // toutes les 10 minutes
  }

  return server;
}

// === MAIN (graceful + keep-alive) ===
async function main() {
  log('info', `🚀 SolBot Pro v${VERSION} — RENDER OPTIMIZED`);
  const wallet = loadWallet(), rpc = createRpc(), state = loadState(), bot = new BotLoop(wallet, rpc, state);
  await bot.init();

  setInterval(() => bot.tick().catch(err => log('error', 'Loop error', { err: err.message })), CONFIG.INTERVAL_SEC * 1000);
  startApi(bot, wallet);

  const cleanup = () => { bot.persist(); log('info', '✅ Clean shutdown Render'); process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
main().catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
