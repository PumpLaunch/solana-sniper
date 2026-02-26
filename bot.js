// ═══════════════════════════════════════════════════════════════
// SolBot Pro v3.9 — API Fix Edition
// Backend Node.js pour Solana Trading Automatique
// Hébergement : Render (Background Worker + API Web)
// ═══════════════════════════════════════════════════════════════

"use strict";

const { Connection, Keypair, PublicKey, VersionedTransaction } = require("@solana/web3.js");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// ── Variables d'environnement ────────────────────────────────────
const PRIVATE_KEY_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=43caa0a0-33d2-420c-b00a-e7261bfecf78";

// ── Configuration ────────────────────────────────────────────────
const CONFIG = {
  STOP_LOSS_ENABLED: process.env.STOP_LOSS === "true",
  STOP_LOSS_THRESHOLD: parseFloat(process.env.STOP_LOSS_PCT || "-20"),
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || "300"),
  AUTO_SELL: process.env.AUTO_SELL === "true",
  INTERVAL_SEC: parseInt(process.env.INTERVAL_SEC || "15"),
  TIERS: [
    { targetPnl: 20, sellPercent: 30, triggered: false },
    { targetPnl: 40, sellPercent: 25, triggered: false },
    { targetPnl: 60, sellPercent: 25, triggered: false },
    { targetPnl: 100, sellPercent: 20, triggered: false },
  ],
};

// ── État global ──────────────────────────────────────────────────
let keypair = null;
const autoBuyPrices = {};
const tokenMetadataCache = {};
const triggeredTiers = {};
const priceCache = new Map();
const tokenTrailingData = {};
const tokenFirstSeen = {};
const failedSellAttempts = new Map();
const manualTokens = [];
const dynamicTokens = [];
let lastTokensData = [];

// Cache config
const CACHE_TTL = { high: 30000, medium: 60000, low: 120000, none: 300000 };

// ── Initialisation ───────────────────────────────────────────────
function initWallet() {
  if (!PRIVATE_KEY_RAW) { console.error("[ERREUR] PRIVATE_KEY manquante"); process.exit(1); }
  try {
    const secretBytes = JSON.parse(PRIVATE_KEY_RAW);
    keypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
    console.log(`[WALLET] Connecté : ${keypair.publicKey.toString()}`);
  } catch (err) { console.error("[ERREUR] PRIVATE_KEY invalide :", err.message); process.exit(1); }
}

function getConnection() { return new Connection(RPC_URL, "confirmed"); }

// ── Logging utilitaire ───────────────────────────────────────────
function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  const prefix = { debug: '🔍', info: 'ℹ️', warn: '⚠️', error: '❌' }[level] || 'ℹ️';
  console.log(`${prefix} [${ts}] [${level.toUpperCase()}] ${msg}`, Object.keys(meta).length ? meta : '');
}

// ── Fetch avec retry ─────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, maxRetries = 2, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) { if (attempt < maxRetries && res.status >= 500) { await new Promise(r => setTimeout(r, baseDelay * attempt)); continue; } return null; }
      return await res.json();
    } catch (err) {
      if (attempt < maxRetries) { await new Promise(r => setTimeout(r, baseDelay * attempt)); continue; }
      return null;
    }
  }
  return null;
}

// ── Sources de prix ──────────────────────────────────────────────
async function fetchDexScreenerPrice(mint) {
  try {
    const data = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.9', 'Accept': 'application/json' }, timeout: 15000
    }, 2, 1000);
    if (!data?.pairs?.length) return null;
    const pairs = data.pairs.filter(p => p.chainId === "solana");
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!best?.priceUsd) return null;
    return { priceUsd: parseFloat(best.priceUsd), liquidityUsd: best.liquidity?.usd || 0, change24h: best.priceChange?.h24 || 0, source: 'DexScreener' };
  } catch { return null; }
}

async function fetchPumpFunPrice(mint) {
  try {
    const data = await fetchWithRetry(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.9', 'Accept': 'application/json', 'Origin': 'https://pump.fun' }, timeout: 10000
    }, 1, 2000);
    if (!data?.usd_market_cap || !data?.virtual_sol_reserves) return null;
    const priceUsd = (data.virtual_sol_reserves / (data.virtual_token_reserves || 1)) * (data.sol_price || 200);
    if (priceUsd <= 0) return null;
    return { priceUsd, liquidityUsd: data.usd_market_cap || 0, change24h: data.price_change_24h || 0, source: 'PumpFun' };
  } catch { return null; }
}

async function fetchCoinGeckoPrice(mint) {
  try {
    const data = await fetchWithRetry(`https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mint.toLowerCase()}&vs_currencies=usd`, {
      headers: { 'User-Agent': 'SolBot-Pro/3.9' }, timeout: 10000
    }, 1, 2000);
    const key = mint.toLowerCase();
    if (!data?.[key]?.usd) return null;
    return { priceUsd: data[key].usd, source: 'CoinGecko' };
  } catch { return null; }
}

async function getWeightedPrice(mint) {
  const sources = [
    { name: 'DexScreener', fetch: () => fetchDexScreenerPrice(mint), weight: 5 },
    { name: 'PumpFun', fetch: () => fetchPumpFunPrice(mint), weight: 4 },
    { name: 'CoinGecko', fetch: () => fetchCoinGeckoPrice(mint), weight: 2 },
  ];
  const results = await Promise.allSettled(sources.map(s => s.fetch().then(d => ({ ...d, source: s.name, weight: s.weight }))));
  let valid = results.filter(r => r.status === 'fulfilled' && r.value?.priceUsd > 0).map(r => r.value);
  if (valid.length === 0) return null;
  const sum = valid.reduce((s, p) => s + p.priceUsd * p.weight, 0);
  const totalW = valid.reduce((s, p) => s + p.weight, 0);
  return {
    priceUsd: sum / totalW,
    confidence: Math.min(valid.length / sources.length, 1),
    sources: valid.map(p => p.source),
    liquidityUsd: valid.find(p => p.liquidityUsd)?.liquidityUsd || 0,
    change24h: valid.find(p => p.change24h)?.change24h || 0
  };
}

async function getCachedPrice(mint, liquidityUsd) {
  const cached = priceCache.get(mint);
  const now = Date.now();
  let ttl = CACHE_TTL.none;
  if (liquidityUsd >= 1_000_000) ttl = CACHE_TTL.high;
  else if (liquidityUsd >= 100_000) ttl = CACHE_TTL.medium;
  else if (liquidityUsd > 0) ttl = CACHE_TTL.low;
  if (cached && cached.data?.priceUsd > 0 && (now - cached.timestamp) < ttl) return { ...cached.data, fromCache: true };
  const fresh = await getWeightedPrice(mint);
  if (fresh && fresh.priceUsd > 0) priceCache.set(mint, {  fresh, timestamp: now, ttl });
  return fresh ? { ...fresh, fromCache: false } : null;
}

async function fetchTokenMetadata(mint) {
  if (tokenMetadataCache[mint]) return tokenMetadataCache[mint];
  let meta = { symbol: '???', name: 'Unknown', logo: null };
  try {
    const tokens = await fetchWithRetry('https://tokens.jup.ag/tokens', { headers: { 'User-Agent': 'SolBot-Pro/3.9' }, timeout: 15000 }, 1, 2000);
    if (tokens) {
      const t = tokens.find(x => x.address === mint);
      if (t) { meta = { symbol: t.symbol || '???', name: t.name || 'Unknown', logo: t.logoURI || null }; if (meta.logo) { tokenMetadataCache[mint] = meta; return meta; } }
    }
  } catch {}
  if (!meta.logo && meta.symbol !== '???') {
    const c = ['#0ea5e9','#10b981','#f59e0b','#ef4444','#a78bfa','#ec4899'];
    const i = meta.symbol.charCodeAt(0) % c.length;
    meta.logo = `image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="${c[i]}"/><text x="16" y="22" font-size="18" font-weight="bold" fill="white" text-anchor="middle">${meta.symbol[0].toUpperCase()}</text></svg>`)}`;
  }
  tokenMetadataCache[mint] = meta;
  return meta;
}

// ── Jupiter Sell avec timeouts 60s ───────────────────────────────
async function jupiterSell(mint, amountRaw, slippageBps, maxRetries = 3) {
  const SOL = "So11111111111111111111111111111111111111112";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log('debug', `[JUPITER] Tentative ${attempt}/${maxRetries}`);
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=${SOL}&amount=${amountRaw}&slippageBps=${slippageBps}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // ← 60s timeout
      const quote = await fetchWithRetry(quoteUrl, { headers: { 'User-Agent': 'SolBot-Pro/3.9' }, timeout: 60000 }, 3, 3000);
      clearTimeout(timeoutId);
      if (!quote) throw new Error('Quote timeout');
      if (quote.errorCode) throw new Error(quote.error);
      const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST", headers: { "Content-Type": "application/json", 'User-Agent': 'SolBot-Pro/3.9' },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: keypair.publicKey.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, computeUnitPriceMicroLamports: "auto" }),
        signal: AbortSignal.timeout(60000) // ← 60s timeout
      });
      if (!swapRes.ok) throw new Error(`Swap HTTP ${swapRes.status}: ${await swapRes.text()}`);
      const { swapTransaction } = await swapRes.json();
      const conn = getConnection();
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
      tx.sign([keypair]);
      const txId = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
      const bh = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: txId, ...bh }, "confirmed");
      log('info', `[JUPITER] ✅ Confirmé : ${txId}`);
      return txId;
    } catch (err) {
      log('warn', `[JUPITER] ⚠️ Tentative ${attempt} échouée : ${err.message}`);
      if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNRESET') || err.message.includes('ETIMEDOUT')) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
        continue;
      }
      if (attempt === maxRetries) throw err;
    }
  }
  throw new Error('Jupiter échec après toutes les tentatives');
}

// ── Exécution de vente avec protection anti-loop ─────────────────
async function executeSell(mint, amountRaw, baseSlippage, reason) {
  const now = Date.now();
  const failed = failedSellAttempts.get(mint) || { count: 0, lastAttempt: 0, nextRetry: 0 };
  if (failed.count >= 3 && now < failed.nextRetry) {
    log('info', `[⏸️ VENTE PAUSE] ${mint.slice(0,8)}... : ${failed.count} échecs → Pause`);
    return null;
  }
  let slippage = Math.min(baseSlippage + failed.count * 150, 1500);
  log('info', `[VENTE] ${reason} : ${mint.slice(0,8)}... | Slippage: ${slippage}bps (attempt ${failed.count + 1})`);
  try {
    const txId = await jupiterSell(mint, amountRaw, slippage);
    failedSellAttempts.delete(mint);
    log('info', `[✅ VENTE] ${reason} confirmée : ${txId}`);
    return txId;
  } catch (err) {
    failed.count++;
    failed.lastAttempt = now;
    failed.nextRetry = now + Math.min(120000 * Math.pow(1.5, failed.count - 1), 3600000);
    failedSellAttempts.set(mint, failed);
    log('error', `[❌ VENTE] ${reason} ÉCHEC : ${err.message}`);
    if (failed.count >= 3) log('error', `[🚨] ${mint.slice(0,8)}... : Pause 5min`);
    throw err;
  }
}

// ── Logique de vente ─────────────────────────────────────────────
async function applySellLogic(mint, balance, decimals, price, pnl, liquidity, change24h) {
  if (!CONFIG.AUTO_SELL || pnl == null || balance <= 0) return;
  const raw = Math.floor(balance * 10 ** decimals);
  if (liquidity < 1000) return; // Min liquidity
  let slippage = CONFIG.SLIPPAGE_BPS;
  if (liquidity < 10000) slippage = 500;
  else if (liquidity < 100000) slippage = 300;
  
  // Trailing Stop
  if (pnl >= 5) {
    const td = tokenTrailingData[mint] || { highest: pnl, active: false };
    if (pnl > td.highest) td.highest = pnl;
    if (!td.active && pnl >= 5) td.active = true;
    if (td.active && pnl <= td.highest - 8 && pnl >= 3) {
      log('info', `[🛡️ TRAILING] ${mint.slice(0,8)}... @ ${pnl.toFixed(2)}%`);
      await executeSell(mint, raw, slippage, 'TRAILING_STOP');
      tokenTrailingData[mint] = { highest: 0, active: false };
      return;
    }
    tokenTrailingData[mint] = td;
  }
  
  // Take-Profit Dynamique
  const mult = Math.abs(change24h || 0) > 40 ? 1.15 : Math.abs(change24h || 0) < 15 ? 0.85 : 1.0;
  for (let i = 0; i < CONFIG.TIERS.length; i++) {
    const t = CONFIG.TIERS[i];
    const target = t.targetPnl * mult;
    const key = `${mint}_tier_${i}`;
    if (triggeredTiers[key] && pnl < target - 10) delete triggeredTiers[key];
    if (!triggeredTiers[key] && pnl >= target) {
      const amt = Math.floor(raw * t.sellPercent / 100);
      if (amt > 0) {
        log('info', `[🎯 PALIER ${i+1}] ${mint.slice(0,8)}... @ ${pnl.toFixed(2)}% → ${t.sellPercent}%`);
        await executeSell(mint, amt, slippage, `TAKE_PROFIT_${i+1}`);
        triggeredTiers[key] = true;
      }
    }
  }
}

// ── Boucle principale ────────────────────────────────────────────
async function runCheck() {
  try {
    const conn = getConnection();
    const tokens = [];
    const accounts = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
    const walletMints = accounts.value.map(a => a.account.data.parsed.info.mint);
    const allMints = [...new Set([...walletMints, ...manualTokens, ...dynamicTokens])];
    
    for (const mint of allMints) {
      if (mint === "So11111111111111111111111111111111111111112") continue;
      const acc = accounts.value.find(a => a.account.data.parsed.info.mint === mint);
      let balance = 0, decimals = 6, inWallet = false;
      if (acc) { balance = parseFloat(acc.account.data.parsed.info.tokenAmount.uiAmount) || 0; decimals = acc.account.data.parsed.info.tokenAmount.decimals; inWallet = true; if (balance <= 0) continue; }
      else if (!manualTokens.includes(mint) && !dynamicTokens.includes(mint)) continue;
      
      const pdata = await getCachedPrice(mint, 0);
      const hasPrice = pdata?.priceUsd > 0;
      const price = hasPrice ? pdata.priceUsd : 0;
      const liq = hasPrice ? (pdata.liquidityUsd || 0) : 0;
      const src = hasPrice ? pdata.sources?.join(',') : null;
      const conf = hasPrice ? pdata.confidence : null;
      const change24h = hasPrice ? (pdata.change24h || 0) : 0;
      
      if (hasPrice && !autoBuyPrices[mint]) autoBuyPrices[mint] = price;
      let pnl = null;
      if (hasPrice && autoBuyPrices[mint]) pnl = ((price - autoBuyPrices[mint]) / autoBuyPrices[mint]) * 100;
      
      const meta = await fetchTokenMetadata(mint);
      const sym = meta.symbol !== '???' ? meta.symbol : '???';
      
      if (hasPrice && inWallet && balance > 0) await applySellLogic(mint, balance, decimals, price, pnl, liq, change24h);
      
      tokens.push({
        symbol: sym, name: meta.name || 'Unknown', address: mint, balance, price,
        value: balance * price, pnl, liquidity: liq, logo: meta.logo,
        hasPrice, priceSource: src, priceConfidence: conf, priceSources: pdata?.sources || [],
        isManual: manualTokens.includes(mint) || dynamicTokens.includes(mint),
        isInWallet: inWallet, autoSellEnabled: hasPrice && inWallet && balance > 0
      });
    }
    lastTokensData = tokens;
    log('debug', `[BOT] ${tokens.length} tokens analysés`);
  } catch (err) { log('error', `[BOT] Erreur runCheck : ${err.message}`); }
}

// ── API HTTP avec CORS ───────────────────────────────────────────
if (process.env.RENDER) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    
    // GET /api/tokens
    if (req.url === '/api/tokens' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, wallet: keypair?.publicKey?.toString(), tokens: lastTokensData, count: lastTokensData.length, timestamp: new Date().toISOString() }));
      return;
    }
    
    // GET /api/status
    if (req.url === '/api/status' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'running', wallet: keypair?.publicKey?.toString(), tokensCount: lastTokensData.length, uptime: process.uptime(), autoSell: CONFIG.AUTO_SELL }));
      return;
    }
    
    // POST /api/tokens/add
    if (req.url === '/api/tokens/add' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { address, symbol, name } = JSON.parse(body);
          if (!address || address.length < 32) { res.writeHead(400); res.end(JSON.stringify({ error: 'Adresse invalide' })); return; }
          if (manualTokens.includes(address) || dynamicTokens.includes(address)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Déjà ajouté' })); return; }
          dynamicTokens.push(address);
          if (symbol || name) tokenMetadataCache[address] = { symbol: symbol || '???', name: name || 'Unknown', logo: null };
          log('info', `[MANUAL] Ajouté : ${address.slice(0,8)}...`);
          res.writeHead(200); res.end(JSON.stringify({ success: true, message: 'Token ajouté' }));
        } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'JSON invalide' })); }
      });
      return;
    }
    
    // DELETE /api/tokens/remove
    if (req.url === '/api/tokens/remove' && req.method === 'DELETE') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { address } = JSON.parse(body);
          const mi = manualTokens.indexOf(address), di = dynamicTokens.indexOf(address);
          if (mi > -1) manualTokens.splice(mi, 1);
          else if (di > -1) dynamicTokens.splice(di, 1);
          else { res.writeHead(404); res.end(JSON.stringify({ error: 'Non trouvé' })); return; }
          log('info', `[MANUAL] Supprimé : ${address.slice(0,8)}...`);
          res.writeHead(200); res.end(JSON.stringify({ success: true, message: 'Token supprimé' }));
        } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'JSON invalide' })); }
      });
      return;
    }
    
    // Root
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('🤖 SolBot Pro v3.9 API\nEndpoints: GET /api/tokens | GET /api/status | POST /api/tokens/add | DELETE /api/tokens/remove');
      return;
    }
    
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });
  
  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => log('info', `[HTTP] ✅ API sur le port ${PORT}`));
}

// ── Point d'entrée ───────────────────────────────────────────────
async function main() {
  log('info', "═══════════════════════════════════════════");
  log('info', "  🤖 SolBot Pro v3.9 — API Fix Edition");
  log('info', `  RPC : ${RPC_URL}`);
  log('info', `  Intervalle : ${CONFIG.INTERVAL_SEC}s | Auto-sell : ${CONFIG.AUTO_SELL}`);
  log('info', "═══════════════════════════════════════════");
  
  initWallet();
  await runCheck();
  setInterval(async () => { try { await runCheck(); } catch (e) { log('error', `Loop error: ${e.message}`); } }, CONFIG.INTERVAL_SEC * 1000);
  log('info', "[BOT] 🔄 Surveillance active");
}

process.on('uncaughtException', e => log('error', `[FATAL] ${e.message}`));
process.on('unhandledRejection', r => log('error', `[FATAL] ${r}`));

main();
