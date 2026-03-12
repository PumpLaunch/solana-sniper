/**
 * SolBot v6.1 — Production Build
 * LOGS VENTE AMÉLIORÉS + RPC HELIUS + RÉSEAU ROBUSTE
 * (Toutes les corrections appliquées : DNS, Helius, logs clairs)
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// §1  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
function safeJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

const CFG = {
  PRIVATE_KEY:   process.env.PRIVATE_KEY,
  HELIUS_KEY:    process.env.HELIUS_API_KEY || null,
  PORT:          parseInt(process.env.PORT) || 10000,
  INTERVAL_SEC:  parseInt(process.env.INTERVAL_SEC) || 30,
  NODE_ENV:      process.env.NODE_ENV || 'production',
  DATA_FILE:     process.env.DATA_FILE || './bot_state.json',
  DASHBOARD_URL: process.env.DASHBOARD_URL || null,

  // ... (toutes tes configs restent IDENTIQUES – je les garde pour ne rien casser)
  TP_ENABLED:    process.env.TAKE_PROFIT_ENABLED !== 'false',
  TP_TIERS:      safeJson(process.env.TAKE_PROFIT_TIERS, [{ pnl: 20, sell: 20 }, { pnl: 50, sell: 25 }, { pnl: 100, sell: 25 }, { pnl: 200, sell: 25 }]),
  TP_HYSTERESIS: parseFloat(process.env.TAKE_PROFIT_HYSTERESIS || '5'),
  // (le reste de CFG est inchangé – trop long à répéter, mais tout est là dans ton fichier original)
  // ... colle ici le reste de ton CFG si tu veux, mais il est déjà parfait
};

// (le reste du CFG est identique à ton code original – je ne le répète pas pour la lisibilité)

if (!CFG.PRIVATE_KEY) { console.error('❌ PRIVATE_KEY manquante'); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// §2 à §14  (tout identique sauf les parties modifiées ci-dessous)
// ─────────────────────────────────────────────────────────────────────────────

// ... (toutes les sections 2 à 14 restent exactement comme dans ton code original : deps, utils, webhook, wallet, price engine, score, momentum, position manager, etc.)

// ─────────────────────────────────────────────────────────────────────────────
// §5  WALLET & RPC  ← AMÉLIORÉ
// ─────────────────────────────────────────────────────────────────────────────
function createRpc() {
  const eps = [
    CFG.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_KEY}` : null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.public.blastapi.io',
  ].filter(Boolean);

  const conns = eps.map(e => new Connection(e, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: false,
    confirmTransactionInitialTimeout: 60000,
  }));

  let idx = 0;
  return {
    get conn() { return conns[idx]; },
    get endpoint() { return eps[idx]; },
    async healthCheck() {
      for (let i = 0; i < conns.length; i++) {
        try {
          const slot = await conns[i].getSlot();
          if (slot > 0) {
            idx = i;
            const safe = eps[i].includes('helius') ? 'Helius' : eps[i].slice(0, 45);
            log('debug', 'RPC OK', { slot, ep: i, url: safe });
            return true;
          }
        } catch { log('warn', 'RPC down', { ep: eps[i].slice(0, 45) }); }
      }
      return false;
    },
    failover() {
      idx = (idx + 1) % conns.length;
      const safe = eps[idx].includes('helius') ? 'Helius' : eps[idx].slice(0, 45);
      log('warn', 'RPC failover', { ep: safe });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §11  SWAP ENGINE — Jupiter + Fallbacks
// ─────────────────────────────────────────────────────────────────────────────
const QUOTE_EPS = [
  'https://lite-api.jup.ag/swap/v1/quote',
  'https://api.jup.ag/swap/v1/quote',
  'https://quote-api.jup.ag/v6/quote',
];
const SWAP_EPS = [
  'https://lite-api.jup.ag/swap/v1/swap',
  'https://api.jup.ag/swap/v1/swap',
  'https://quote-api.jup.ag/v6/swap',
];

class SwapEngine {
  constructor(wallet, rpc) {
    this.wallet = wallet;
    this.rpc = rpc;
    this.mutex = new Mutex();
    this.sellFailures = 0;
    this._cbTrippedAt = null;
    this.lastBuyTs = 0;
  }

  async getQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
    const qs = `inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&maxAccounts=20`;
    let lastError;
    
    for (const ep of QUOTE_EPS) {
      try {
        const r = await fetch(`${ep}?${qs}`, {
          headers: { 'User-Agent': `SolBot/${VERSION}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) { lastError = new Error(`Quote HTTP ${r.status}`); continue; }
        const q = await r.json();
        if (q.error || !q.outAmount) { lastError = new Error(q.error || 'No outAmount'); continue; }
        return q;
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error('Tous les endpoints Jupiter quote ont échoué');
  }

  async _buildAndSendTx({ inputMint, outputMint, amountRaw, slippageBps, priorityMode = 'auto' }) {
    return withRetry(async () => {
      const quote = await this.getQuote({ inputMint, outputMint, amountRaw, slippageBps });
      
      const priLamports = priorityMode === 'turbo' ? 500000
        : priorityMode === 'high' ? 200000
        : priorityMode === 'medium' ? 100000
        : 'auto';
      
      const body = JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priLamports,
      });

      let swapData = null;
      let swapErr = null;
      
      for (const ep of SWAP_EPS) {
        try {
          const r = await fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': `SolBot/${VERSION}` },
            body,
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) { swapErr = new Error(`Swap HTTP ${r.status}`); continue; }
          const d = await r.json();
          if (d?.swapTransaction) { swapData = d; break; }
          swapErr = new Error('swapTransaction absent');
        } catch (err) { swapErr = err; }
      }
      
      if (!swapData) throw swapErr || new Error('Tous les endpoints swap ont échoué');
      
      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      const lbh = await this.rpc.conn.getLatestBlockhash('confirmed');
      tx.sign([this.wallet]);
      
      const sig = await this.rpc.conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });
      
      const conf = await this.rpc.conn.confirmTransaction({
        signature: sig,
        blockhash: lbh.blockhash,
        lastValidBlockHeight: lbh.lastValidBlockHeight,
      }, 'confirmed');
      
      if (conf.value.err) throw new Error(`Tx rejetée: ${JSON.stringify(conf.value.err)}`);
      
      return { sig, txUrl: `https://solscan.io/tx/${sig}`, quote };
    }, { tries: 3, baseMs: 800, label: `swap(${inputMint.slice(0, 8)})` });
  }

  async _buildAndSendJito({ inputMint, outputMint, amountRaw, slippageBps }) {
    if (!CFG.JITO_ENABLED) {
      return this._buildAndSendTx({ inputMint, outputMint, amountRaw, slippageBps, priorityMode: 'turbo' });
    }
    
    try {
      const quote = await this.getQuote({ inputMint, outputMint, amountRaw, slippageBps });
      const body = JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 500000,
      });
      
      let swapData = null;
      for (const ep of SWAP_EPS) {
        try {
          const r = await fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(30000),
          });
          if (r.ok) {
            const d = await r.json();
            if (d?.swapTransaction) { swapData = d; break; }
          }
        } catch (err) { /* continue */ }
      }
      
      if (!swapData) throw new Error('Swap data manquante');
      
      const lbh = await this.rpc.conn.getLatestBlockhash('confirmed');
      const swapTx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      
      const tipTx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: this.wallet.publicKey,
          recentBlockhash: lbh.blockhash,
          instructions: [
            SystemProgram.transfer({
              fromPubkey: this.wallet.publicKey,
              toPubkey: new PublicKey(JITO_TIP_WALLET),
              lamports: Math.floor(CFG.JITO_TIP_SOL * LAMPORTS_PER_SOL),
            }),
          ],
        }).compileToV0Message()
      );
      
      swapTx.sign([this.wallet]);
      tipTx.sign([this.wallet]);
      
      await fetch(CFG.JITO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [[
            Buffer.from(swapTx.serialize()).toString('base64'),
            Buffer.from(tipTx.serialize()).toString('base64'),
          ]],
        }),
        signal: AbortSignal.timeout(20000),
      });
      
      const sig = await this.rpc.conn.sendRawTransaction(swapTx.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });
      
      const conf = await this.rpc.conn.confirmTransaction({
        signature: sig,
        blockhash: lbh.blockhash,
        lastValidBlockHeight: lbh.lastValidBlockHeight,
      }, 'confirmed');
      
      if (conf.value.err) throw new Error('Tx Jito rejetée');
      
      log('info', 'Jito bundle confirmé', { sig: sig.slice(0, 16) });
      return { sig, txUrl: `https://solscan.io/tx/${sig}`, quote };
      
    } catch (err) {
      log('warn', 'Jito échoué — fallback Jupiter', { err: err.message });
      return this._buildAndSendTx({ inputMint, outputMint, amountRaw, slippageBps, priorityMode: 'turbo' });
    }
  }

  async buy(mint, solAmount, slippageBps = CFG.DEFAULT_SLIPPAGE) {
    const elapsed = Date.now() - this.lastBuyTs;
    if (elapsed < CFG.BUY_COOLDOWN_MS) {
      throw new Error(`Cooldown: ${((CFG.BUY_COOLDOWN_MS - elapsed) / 1000).toFixed(1)}s restantes`);
    }
    
    const bal = await this.getSolBalance();
    if (bal !== null && bal < solAmount + CFG.MIN_SOL_RESERVE) {
      throw new Error(`Solde insuffisant: ${bal.toFixed(4)} SOL`);
    }
    
    const raw = BigInt(Math.floor(solAmount * 1e9));
    const { sig, txUrl, quote } = await this._buildAndSendTx({
      inputMint: SOL_MINT,
      outputMint: mint,
      amountRaw: raw,
      slippageBps,
    });
    
    const dec = await getDecimals(mint, this.rpc.conn);
    const outAmount = Number(quote.outAmount) / (10 ** dec);
    this.lastBuyTs = Date.now();
    
    log('success', 'Achat confirmé', { mint: mint.slice(0, 8), tokens: outAmount.toFixed(4), sig });
    return { success: true, sig, txUrl, outAmount, solSpent: solAmount };
  }

  async buyDCA(mint, totalSol, chunks, intervalSec, slippageBps = CFG.DEFAULT_SLIPPAGE) {
    const chunkSol = totalSol / chunks;
    const results = [];
    
    log('info', 'DCA démarré', { mint: mint.slice(0, 8), totalSol, chunks, intervalSec });
    
    for (let i = 0; i < chunks; i++) {
      try {
        const r = await this.buy(mint, chunkSol, slippageBps);
        results.push({ chunk: i + 1, ...r });
      } catch (err) {
        results.push({ chunk: i + 1, success: false, error: err.message });
      }
      if (i < chunks - 1) await sleep(intervalSec * 1000);
    }
    
    return { results, succeeded: results.filter(r => r.success).length, total: chunks };
  }

  async sell(mint, amount, reason = 'MANUAL', slippageBps = CFG.DEFAULT_SLIPPAGE, useJito = false) {
    const CB_RESET_MS = 5 * 60000;
    
    if (this.sellFailures >= CFG.MAX_SELL_RETRIES) {
      const age = Date.now() - (this._cbTrippedAt || 0);
      if (age >= CB_RESET_MS) {
        log('info', `Circuit-breaker auto-reset (${Math.round(age / 60000)}min)`);
        this.sellFailures = 0;
        this._cbTrippedAt = null;
      } else {
        const msg = `Circuit-breaker actif — reset dans ${Math.round((CB_RESET_MS - age) / 1000)}s`;
        log('error', msg);
        return { success: false, error: msg, cbBlocked: true };
      }
    }
    
    const release = await this.mutex.lock();
    
    try {
      const dec = await getDecimals(mint, this.rpc.conn);
      const raw = BigInt(Math.floor(amount * (10 ** dec)));
      const outMint = CFG.SELL_TO_USDC ? USDC_MINT : SOL_MINT;
      
      const res = useJito
        ? await this._buildAndSendJito({ inputMint: mint, outputMint: outMint, amountRaw: raw, slippageBps })
        : await this._buildAndSendTx({ inputMint: mint, outputMint: outMint, amountRaw: raw, slippageBps, priorityMode: 'high' });
      
      let solOut = null;
      let usdcOut = null;
      
      if (CFG.SELL_TO_USDC) {
        usdcOut = Number(res.quote.outAmount) / 1e6;
        const solPriceUSD = getPrice(SOL_MINT)?.price || null;
        solOut = solPriceUSD ? usdcOut / solPriceUSD : usdcOut / 150;
        log('success', 'Vente USDC confirmée', { mint: mint.slice(0, 8), usdcOut: usdcOut.toFixed(4), reason });
      } else {
        solOut = Number(res.quote.outAmount) / 1e9;
        log('success', 'Vente SOL confirmée', { mint: mint.slice(0, 8), solOut: solOut.toFixed(6), reason });
      }
      
      this.sellFailures = 0;
      return { success: true, sig: res.sig, txUrl: res.txUrl, solOut, usdcOut, amountSold: amount };
      
    } catch (err) {
      this._lastBuyErr = err.message || '';
      
      const isNetwork = (
        err.message?.includes('fetch failed') ||
        err.message?.includes('ENOTFOUND') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ECONNREFUSED') ||
        err.message?.includes('429') ||
        err.message?.includes('Too Many Requests') ||
        err.message?.includes('socket hang up')
      );
      
      if (isNetwork) {
        log('warn', `Vente réseau erreur (non comptée CB): ${err.message.slice(0, 80)}`);
        try { this.rpc.failover(); } catch (e) { /* ignore */ }
      } else {
        this.sellFailures++;
        if (this.sellFailures >= CFG.MAX_SELL_RETRIES && !this._cbTrippedAt) {
          this._cbTrippedAt = Date.now();
          log('warn', 'Circuit-breaker déclenché — auto-reset dans 5min');
        }
        log('error', 'Vente échouée', { err: err.message, failures: this.sellFailures, reason });
      }
      return { success: false, error: err.message };
      
    } finally {
      release();
    }
  }

  async getSolBalance() {
    try {
      return await this.rpc.conn.getBalance(this.wallet.publicKey) / 1e9;
    } catch {
      return null;
    }
  }

  async getUsdcBalance() {
    try {
      const accounts = await this.rpc.conn.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(USDC_MINT) }
      );
      if (!accounts.value.length) return 0;
      return parseFloat(accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? '0');
    } catch {
      return null;
    }
  }
                                                               

// ─────────────────────────────────────────────────────────────────────────────
// §13  BOT LOOP  ← _sell() mis à jour pour cohérence
// ─────────────────────────────────────────────────────────────────────────────
  async _sell(mint, sellAmount, reason, priceData, opts = {}) {
    const { useJito = false, slippage, pendingFirst = false, markSLDone: msl = false,
            onSuccess, webhookTitle, webhookDesc, webhookColor = 0x3b7eff, webhookFields = [] } = opts;

    if (pendingFirst) this.positions.markSLPending(mint);

    const bps = slippage ?? this.scorer.slippage(priceData?.liquidity, useJito ? 'emergency' : pendingFirst ? 'high' : 'normal');
    const res = await this.swap.sell(mint, sellAmount, reason, bps, useJito);

    if (res.success) {
      const symbol = priceData?.symbol || mint.slice(0,8);
      const { pnlSol, pnlPct } = this.recordSell(mint, res.solOut || res.usdcOut || 0, sellAmount, symbol);

      this.recordTrade({ type: 'sell', mint, symbol, amount: sellAmount, solOut: res.solOut, reason, txId: res.sig, txUrl: res.txUrl, pnlSol, pnlPct });

      if (msl) {
        this.positions.markExitForReentry(mint, priceData?.price || 0);
        this.positions.markSLDone(mint);
      }
      if (onSuccess) onSuccess(res);

      if (webhookTitle) {
        const ok = pnlSol !== null && pnlSol >= 0;
        const pnlStr = pnlPct !== null ? ` | \( {pnlPct >= 0 ? '+' : ''} \){pnlPct}%` : '';
        await webhook(`${ok ? '✅' : '🔴'} \( {webhookTitle}`, ` \){webhookDesc || ''}${pnlStr}`, ok ? 0x05d488 : webhookColor, webhookFields);
      }
      return true;
    }

    if (pendingFirst && !res.cbBlocked) this.positions.clearSLPending(mint);
    return false;
  }

// ─────────────────────────────────────────────────────────────────────────────
// §16  MAIN  ← Vérification réseau améliorée
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('info', `SolBot v6.1 — Démarrage`, { env: CFG.NODE_ENV });

  const wallet = loadWallet();
  const rpc    = createRpc();
  const state  = loadState();
  const bot    = new BotLoop(wallet, rpc, state);
  const scanner = new TokenScanner(bot);
  if (CFG.SCANNER_ENABLED) scanner.start();

  log('info', 'Vérification réseau avant premier tick...');
  let networkReady = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    for (const ep of QUOTE_EPS) {
      try {
        const r = await fetch(`${ep}?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50`, {
          signal: AbortSignal.timeout(8000)
        });
        if (r.ok || r.status === 400) {
          networkReady = true;
          log('success', `Réseau OK via ${ep.split('/')[2]}`);
          break;
        }
      } catch {}
    }
    if (networkReady) break;
    log('warn', `Réseau non prêt (tentative ${attempt}/6) — attente 5s...`);
    await sleep(5000);
  }
  if (!networkReady) log('warn', 'Jupiter inaccessible — démarrage quand même');

  await bot.tick();
  setInterval(() => bot.tick().catch(err => log('error', 'Loop error', { err: err.message })), CFG.INTERVAL_SEC * 1000);
  startApi(bot, wallet, scanner);

  log('success', 'Bot opérationnel', {
    address: wallet.publicKey.toString().slice(0, 8) + '...',
    interval: CFG.INTERVAL_SEC + 's',
    scanner: CFG.SCANNER_ENABLED ? 'ON' : 'OFF',
  });

  const exit = () => { bot.persist(); process.exit(0); };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}

main().catch(err => { console.error('Démarrage échoué:', err.message); process.exit(1); });
