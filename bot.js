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
// §11  SWAP ENGINE  ← LOGS VENTE REFONUS
// ─────────────────────────────────────────────────────────────────────────────
class SwapEngine {
  // ... (tout le reste de la classe reste identique jusqu’à la méthode sell)

  async sell(mint, amount, reason = 'MANUAL', slippageBps = CFG.DEFAULT_SLIPPAGE, useJito = false) {
    const CB_RESET_MS = 5 * 60_000;
    if (this.sellFailures >= CFG.MAX_SELL_RETRIES) {
      const age = Date.now() - (this._cbTrippedAt || 0);
      if (age >= CB_RESET_MS) {
        this.sellFailures = 0; this._cbTrippedAt = null;
        log('info', 'Circuit-breaker auto-reset');
      } else {
        log('error', `Circuit-breaker actif — reset dans ${Math.round((CB_RESET_MS - age)/1000)}s`);
        return { success: false, error: 'CB actif', cbBlocked: true };
      }
    }

    const release = await this.mutex.lock();
    const start = Date.now();
    const symbol = getPrice(mint)?.symbol || mint.slice(0,8);

    try {
      const dec = await getDecimals(mint, this.rpc.conn);
      const raw = BigInt(Math.floor(amount * 10 ** dec));
      const outMint = CFG.SELL_TO_USDC ? USDC_MINT : SOL_MINT;

      log('info', `🚀 VENTE DÉCLENCHÉE`, {
        mint: mint.slice(0,8),
        symbol,
        amount: amount.toFixed(4),
        reason,
        slippage: slippageBps + 'bps',
        jito: useJito ? '✅' : 'OFF'
      });

      const res = useJito
        ? await this._buildAndSendJito({ inputMint: mint, outputMint: outMint, amountRaw: raw, slippageBps })
        : await this._buildAndSendTx({ inputMint: mint, outputMint: outMint, amountRaw: raw, slippageBps, priorityMode: 'high' });

      let received = 0;
      if (CFG.SELL_TO_USDC) {
        received = Number(res.quote.outAmount) / 1e6;
        log('success', `✅ VENTE USDC TERMINÉE — ${reason}`, {
          mint: mint.slice(0,8),
          symbol,
          vendu: amount.toFixed(4),
          reçu: received.toFixed(4) + ' USDC',
          tx: `https://solscan.io/tx/${res.sig}`,
          durée: `${Date.now() - start}ms`
        });
      } else {
        received = Number(res.quote.outAmount) / 1e9;
        log('success', `✅ VENTE SOL TERMINÉE — ${reason}`, {
          mint: mint.slice(0,8),
          symbol,
          vendu: amount.toFixed(4),
          reçu: received.toFixed(6) + ' SOL',
          tx: `https://solscan.io/tx/${res.sig}`,
          durée: `${Date.now() - start}ms`
        });
      }

      this.sellFailures = 0;
      return { success: true, sig: res.sig, txUrl: res.txUrl, solOut: received, usdcOut: CFG.SELL_TO_USDC ? received : null, amountSold: amount };
    } catch (err) {
      const isNetwork = err.message?.includes('fetch') || err.message?.includes('ENOTFOUND') ||
                        err.message?.includes('ETIMEDOUT') || err.message?.includes('429') ||
                        err.message?.includes('ECONN');

      if (isNetwork) {
        log('warn', `⚠️ ERREUR RÉSEAU (NON comptée dans CB) — ${reason}`, {
          mint: mint.slice(0,8),
          error: err.message.slice(0, 100)
        });
        try { this.rpc.failover(); } catch {}
      } else {
        this.sellFailures++;
        if (this.sellFailures >= CFG.MAX_SELL_RETRIES && !this._cbTrippedAt) {
          this._cbTrippedAt = Date.now();
          log('error', '🚨 Circuit-breaker déclenché');
        }
        log('error', `❌ VENTE ÉCHOUÉE — ${reason}`, { mint: mint.slice(0,8), error: err.message });
      }
      return { success: false, error: err.message };
    } finally {
      release();
    }
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
