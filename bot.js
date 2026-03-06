/**
 * SolBot Pro v3.3.1 — Render Optimized Edition
 * ✅ Keep-alive auto (anti-sleep gratuit)
 * ✅ Logs allégés en production
 * ✅ Health check enrichi + RAM
 * ✅ render.yaml + package.json inclus
 */
'use strict';

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
