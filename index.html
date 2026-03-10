<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#060910">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>SolBot Monitor</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#060910;--bg1:#0c1120;--bg2:#111827;--bg3:#1a2235;
  --border:#1e2d47;--border2:#253550;
  --text:#e8edf5;--dim:#4a5a78;
  --up:#00d97e;--dn:#ff3860;--gold:#f0b429;--blue:#3b82f6;--purple:#9945ff;
  --safe-top:env(safe-area-inset-top);--safe-bot:env(safe-area-inset-bottom);
  --font:'Space Grotesk',sans-serif;--mono:'Space Mono',monospace;
}
html,body{height:100%;overflow:hidden}
body{font-family:var(--font);background:var(--bg);color:var(--text);display:flex;flex-direction:column;padding-top:var(--safe-top);padding-bottom:var(--safe-bot)}
.topbar{flex-shrink:0;background:var(--bg1);border-bottom:1px solid var(--border);padding:10px 14px;display:flex;align-items:center;gap:10px;min-height:52px}
.logo{font-size:15px;font-weight:700;letter-spacing:.03em;white-space:nowrap}
.logo span{color:var(--gold)}
.pulse-dot{width:7px;height:7px;border-radius:50%;background:var(--up);flex-shrink:0;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(0,217,126,.4)}50%{opacity:.7;box-shadow:0 0 0 4px rgba(0,217,126,0)}}
.topbar-stats{display:flex;gap:10px;flex:1;justify-content:flex-end;align-items:center}
.ts{display:flex;flex-direction:column;align-items:flex-end}
.ts-lbl{font-size:9px;color:var(--dim);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.ts-val{font-family:var(--mono);font-size:13px;font-weight:700;white-space:nowrap}
.ts-val.pos{color:var(--up)}.ts-val.neg{color:var(--dn)}.ts-val.gold{color:var(--gold)}
.sep{width:1px;height:28px;background:var(--border);flex-shrink:0}
.btn-refresh{background:none;border:1px solid var(--border2);border-radius:6px;color:var(--dim);padding:5px 8px;font-size:14px;cursor:pointer;flex-shrink:0;transition:color .15s,transform .4s}
.tabs{flex-shrink:0;display:flex;background:var(--bg1);border-bottom:1px solid var(--border);overflow-x:auto}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:1;min-width:72px;padding:10px 6px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dim);text-align:center;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap;text-transform:uppercase}
.tab.active{color:var(--gold);border-bottom-color:var(--gold)}
.content{flex:1;overflow:hidden;position:relative}
.section{display:none;height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.section::-webkit-scrollbar{width:3px}.section::-webkit-scrollbar-thumb{background:var(--border2)}
.section.active{display:block}
.filter-bar{padding:8px 14px;display:flex;align-items:center;gap:8px;background:var(--bg1);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
.filter-count{font-size:10px;color:var(--dim);font-family:var(--mono);flex:1}
.btn-filter{background:var(--bg2);border:1px solid var(--border);border-radius:6px;color:var(--dim);font-size:10px;font-weight:600;padding:4px 9px;cursor:pointer;letter-spacing:.04em}
.btn-filter.active-dead{color:var(--dn);border-color:rgba(255,56,96,.3)}
.tok-list{padding:10px 12px;display:flex;flex-direction:column;gap:8px;padding-bottom:20px}
.tok-card{background:var(--bg1);border:1px solid var(--border);border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color .15s}
.tok-card:active{border-color:var(--border2)}
.tok-card.sol-card{border-left:3px solid var(--purple)}
.tok-card.usdc-card{border-left:3px solid var(--blue)}
.tok-card.dead-card{opacity:.45}
.tok-top{display:flex;align-items:center;gap:10px;padding:11px 12px 9px}
.tok-logo{width:38px;height:38px;border-radius:9px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;overflow:hidden}
.tok-logo img{width:100%;height:100%;object-fit:cover;border-radius:9px}
.tok-name{flex:1;min-width:0}
.tok-sym{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tok-sym.sol-sym{color:var(--purple)}.tok-sym.usdc-sym{color:var(--blue)}
.tok-addr{font-size:9px;color:var(--dim);font-family:var(--mono);margin-top:2px;display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.badge{font-size:8px;font-weight:700;letter-spacing:.05em;padding:1px 5px;border-radius:3px}
.badge-boot{background:rgba(240,180,41,.15);color:var(--gold);border:1px solid rgba(240,180,41,.3)}
.badge-sl{background:rgba(255,56,96,.15);color:var(--dn);border:1px solid rgba(255,56,96,.3)}
.badge-be{background:rgba(59,130,246,.15);color:var(--blue);border:1px solid rgba(59,130,246,.3)}
.badge-sol{background:rgba(153,69,255,.15);color:var(--purple);border:1px solid rgba(153,69,255,.3)}
.badge-usdc{background:rgba(59,130,246,.15);color:var(--blue);border:1px solid rgba(59,130,246,.3)}
.tok-right{text-align:right;flex-shrink:0}
.tok-val{font-family:var(--mono);font-size:14px;font-weight:700}
.tok-pnl{font-family:var(--mono);font-size:11px;padding:2px 6px;border-radius:4px;margin-top:3px;display:inline-block;font-weight:600}
.tok-pnl.pos{background:rgba(0,217,126,.12);color:var(--up)}
.tok-pnl.neg{background:rgba(255,56,96,.12);color:var(--dn)}
.tok-pnl.dim{background:var(--bg3);color:var(--dim)}
.tok-bottom{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--border)}
.tok-stat{padding:7px 0;text-align:center;border-right:1px solid var(--border)}
.tok-stat:last-child{border-right:none}
.tok-stat-lbl{font-size:8px;color:var(--dim);letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px}
.tok-stat-val{font-family:var(--mono);font-size:11px;font-weight:600}
.dead-sep{padding:5px 12px;background:rgba(255,56,96,.05);border-top:1px solid rgba(255,56,96,.2);font-size:9px;color:rgba(255,56,96,.5);letter-spacing:.07em;text-transform:uppercase;font-weight:600}
.detail-view{display:none;position:absolute;inset:0;z-index:50;flex-direction:column;background:var(--bg)}
.detail-view.open{display:flex}
.detail-header{flex-shrink:0;display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg1);border-bottom:1px solid var(--border)}
.detail-back{background:none;border:none;color:var(--dim);font-size:22px;cursor:pointer;line-height:1}
.detail-stats{flex-shrink:0;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border)}
.detail-stat{background:var(--bg1);padding:9px 8px;text-align:center}
.detail-stat-lbl{font-size:8px;color:var(--dim);letter-spacing:.05em;text-transform:uppercase;margin-bottom:3px}
.detail-stat-val{font-family:var(--mono);font-size:12px;font-weight:700}
.chart-wrap{flex:1;position:relative;background:#0a0e1a;overflow:hidden;min-height:0}
.chart-spinner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--dim);font-size:11px}
.spinner{width:22px;height:22px;border:2px solid var(--border2);border-top-color:var(--gold);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#chartFrame{width:100%;height:100%;border:none;position:relative;z-index:1}
.detail-footer{flex-shrink:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 12px;background:var(--bg1);border-top:1px solid var(--border)}
.btn-dex{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 8px;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:11px;font-weight:600;text-decoration:none}
.btn-copy{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 8px;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:11px;font-weight:600;cursor:pointer}
.an-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:12px}
.kpi{background:var(--bg1);border:1px solid var(--border);border-radius:10px;padding:12px}
.kpi-lbl{font-size:9px;color:var(--dim);letter-spacing:.07em;text-transform:uppercase;margin-bottom:6px}
.kpi-val{font-family:var(--mono);font-size:18px;font-weight:700}
.kpi-val.pos{color:var(--up)}.kpi-val.neg{color:var(--dn)}.kpi-val.gold{color:var(--gold)}
.trades-list{padding:0 12px 20px}
.trade-card{background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.trade-sym{font-size:13px;font-weight:600}
.trade-meta{font-size:9px;color:var(--dim);font-family:var(--mono);margin-top:2px}
.trade-pnl{font-family:var(--mono);font-size:13px;font-weight:700;text-align:right}
.trade-sol{font-size:9px;color:var(--dim);font-family:var(--mono);margin-top:2px;text-align:right}
.sc-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:12px 12px 6px}
.sc-card{background:var(--bg1);border:1px solid var(--border);border-radius:10px;padding:12px}
.sc-lbl{font-size:9px;color:var(--dim);letter-spacing:.06em;text-transform:uppercase;margin-bottom:5px}
.sc-val{font-family:var(--mono);font-size:20px;font-weight:700;color:var(--gold)}
.sc-sub{font-size:9px;color:var(--dim);margin-top:3px}
.sc-status{display:flex;align-items:center;gap:6px;padding:10px 12px;background:var(--bg1);border-bottom:1px solid var(--border)}
.sc-dot{width:6px;height:6px;border-radius:50%}
.sc-dot.on{background:var(--up);animation:pulse 2s infinite}
.sc-dot.off{background:var(--dn)}
.cfg-list{padding:12px;display:flex;flex-direction:column;gap:8px;padding-bottom:24px}
.cfg-section{background:var(--bg1);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.cfg-title{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:10px 14px;background:var(--bg2);border-bottom:1px solid var(--border);color:var(--gold)}
.cfg-row{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border)}
.cfg-row:last-child{border-bottom:none}
.cfg-row-label{flex:1}
.cfg-row-title{font-size:12px;font-weight:600}
.cfg-row-desc{font-size:9px;color:var(--dim);margin-top:2px}
.toggle{width:44px;height:24px;background:var(--bg3);border-radius:12px;position:relative;cursor:pointer;flex-shrink:0;margin-left:10px;transition:background .2s}
.toggle.on{background:var(--up)}
.toggle::after{content:'';position:absolute;width:18px;height:18px;background:#fff;border-radius:50%;top:3px;left:3px;transition:transform .2s}
.toggle.on::after{transform:translateX(20px)}
.cfg-input-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 14px}
.cfg-field label{font-size:9px;color:var(--dim);letter-spacing:.05em;text-transform:uppercase;display:block;margin-bottom:4px}
.cfg-field input,.cfg-field select{width:100%;padding:8px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-size:12px;font-family:var(--mono)}
.cfg-field input:focus,.cfg-field select:focus{outline:none;border-color:var(--gold)}
.save-bar{flex-shrink:0;padding:10px 12px;background:var(--bg1);border-top:1px solid var(--border)}
.btn-save{width:100%;padding:13px;background:var(--gold);color:#060910;font-weight:700;font-size:13px;border:none;border-radius:9px;cursor:pointer;letter-spacing:.05em}
.btn-save:active{opacity:.85}
.save-status{text-align:center;font-size:10px;height:16px;margin-top:6px;font-family:var(--mono);color:var(--dim)}
.save-status.ok{color:var(--up)}.save-status.err{color:var(--dn)}
.toast-wrap{position:fixed;top:calc(16px + var(--safe-top));right:12px;z-index:999;display:flex;flex-direction:column;gap:6px}
.toast{padding:10px 14px;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;font-size:12px;color:var(--text);animation:tst .25s ease;max-width:280px;line-height:1.4}
.toast.ok{border-color:rgba(0,217,126,.4)}.toast.err{border-color:rgba(255,56,96,.4)}
@keyframes tst{from{transform:translateX(110%);opacity:0}to{transform:none;opacity:1}}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 20px;color:var(--dim);text-align:center;gap:10px}
.empty-icon{font-size:40px;opacity:.35}
.empty-txt{font-size:12px}
.load-wrap{display:flex;align-items:center;justify-content:center;gap:10px;padding:40px;color:var(--dim);font-size:12px}
</style>
</head>
<body>

<header class="topbar">
  <div class="pulse-dot" id="statusDot"></div>
  <div class="logo">SOL<span>BOT</span> <span style="font-size:9px;color:var(--dim);font-weight:400;margin-left:2px">v6</span></div>
  <div class="topbar-stats">
    <div class="ts"><div class="ts-lbl">Portfolio</div><div class="ts-val gold" id="tvTotal">&mdash;</div></div>
    <div class="sep"></div>
    <div class="ts"><div class="ts-lbl">PnL net</div><div class="ts-val" id="tvPnl">&mdash;</div></div>
    <div class="sep"></div>
    <div class="ts"><div class="ts-lbl">Win%</div><div class="ts-val" id="tvWin">&mdash;</div></div>
    <div class="sep"></div>
    <button class="btn-refresh" id="btnRefresh" onclick="hardRefresh()">&#8634;</button>
  </div>
</header>

<div class="tabs">
  <div class="tab active" id="tab-portfolio" onclick="switchTab('portfolio',this)">Portfolio</div>
  <div class="tab" id="tab-scanner"   onclick="switchTab('scanner',this)">Scanner</div>
  <div class="tab" id="tab-analytics" onclick="switchTab('analytics',this)">Analytics</div>
  <div class="tab" id="tab-config"    onclick="switchTab('config',this)">Config</div>
</div>

<div class="content">

  <div class="detail-view" id="detailView">
    <div class="detail-header">
      <button class="detail-back" onclick="closeDetail()">&#8249;</button>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:700" id="dtTitle">&mdash;</div>
        <div style="font-size:9px;color:var(--dim);font-family:var(--mono);margin-top:2px" id="dtAddr">&mdash;</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:9px;color:var(--dim)">Score</div>
        <div style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--gold)" id="dtScore">&mdash;</div>
      </div>
    </div>
    <div class="detail-stats">
      <div class="detail-stat"><div class="detail-stat-lbl">Valeur</div><div class="detail-stat-val" id="dtVal">&mdash;</div></div>
      <div class="detail-stat"><div class="detail-stat-lbl">PnL</div><div class="detail-stat-val" id="dtPnl">&mdash;</div></div>
      <div class="detail-stat"><div class="detail-stat-lbl">Peak</div><div class="detail-stat-val pos" id="dtPeak">&mdash;</div></div>
      <div class="detail-stat"><div class="detail-stat-lbl">Entree</div><div class="detail-stat-val" id="dtEntry">&mdash;</div></div>
      <div class="detail-stat"><div class="detail-stat-lbl">Liq.</div><div class="detail-stat-val" id="dtLiq">&mdash;</div></div>
      <div class="detail-stat"><div class="detail-stat-lbl">MCap</div><div class="detail-stat-val" id="dtMcap">&mdash;</div></div>
      <div class="detail-stat"><div class="detail-stat-lbl">Vol 24h</div><div class="detail-stat-val" id="dtVol">&mdash;</div></div>
      <div class="detail-stat"><div class="detail-stat-lbl">Balance</div><div class="detail-stat-val" id="dtBal">&mdash;</div></div>
    </div>
    <div class="chart-wrap">
      <div class="chart-spinner" id="chartSpinner"><div class="spinner"></div><div>Chargement...</div></div>
      <iframe id="chartFrame" src="about:blank"></iframe>
    </div>
    <div class="detail-footer">
      <a class="btn-dex" id="btnDex" href="#" target="_blank">DexScreener</a>
      <button class="btn-copy" onclick="copyMint()">Copier adresse</button>
    </div>
  </div>

  <section class="section active" id="sec-portfolio">
    <div class="filter-bar">
      <div class="filter-count" id="filterCount">Chargement...</div>
      <button class="btn-filter" id="btnDead" onclick="toggleDead()">Morts : caches</button>
    </div>
    <div class="tok-list" id="tokList">
      <div class="load-wrap"><div class="spinner"></div><span>Chargement...</span></div>
    </div>
  </section>

  <section class="section" id="sec-scanner">
    <div id="scannerContent">
      <div class="load-wrap"><div class="spinner"></div><span>Chargement...</span></div>
    </div>
  </section>

  <section class="section" id="sec-analytics">
    <div class="an-grid">
      <div class="kpi"><div class="kpi-lbl">PnL realise</div><div class="kpi-val" id="anPnl">&mdash;</div></div>
      <div class="kpi"><div class="kpi-lbl">Win Rate</div><div class="kpi-val" id="anWin">&mdash;</div></div>
      <div class="kpi"><div class="kpi-lbl">Trades</div><div class="kpi-val gold" id="anTrades">&mdash;</div></div>
      <div class="kpi"><div class="kpi-lbl">ROI</div><div class="kpi-val" id="anRoi">&mdash;</div></div>
      <div class="kpi"><div class="kpi-lbl">Sharpe</div><div class="kpi-val" id="anSharpe">&mdash;</div></div>
      <div class="kpi"><div class="kpi-lbl">Drawdown max</div><div class="kpi-val neg" id="anDD">&mdash;</div></div>
    </div>
    <div class="trades-list" id="tradesList">
      <div class="load-wrap"><div class="spinner"></div><span>Chargement...</span></div>
    </div>
  </section>

  <section class="section" id="sec-config">
    <div class="cfg-list">

      <div class="cfg-section">
        <div class="cfg-title">Scanner automatique</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Actif</div><div class="cfg-row-desc">Detection et achat auto de nouveaux tokens</div></div><div class="toggle" id="tog-scanner" onclick="tog(this)"></div></div>
        <div class="cfg-input-row">
          <div class="cfg-field"><label>Score min</label><input type="number" id="scannerMinScore" value="60" min="0" max="100"></div>
          <div class="cfg-field"><label>Montant SOL</label><input type="number" id="scannerSolAmount" value="0.05" step="0.01" min="0.001"></div>
        </div>
        <div class="cfg-input-row">
          <div class="cfg-field"><label>Liq. min ($)</label><input type="number" id="scannerMinLiq" value="5000" min="0"></div>
          <div class="cfg-field"><label>Liq. max ($)</label><input type="number" id="scannerMaxLiq" value="300000" min="0"></div>
        </div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Take-Profit</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Actif</div><div class="cfg-row-desc">Vente auto a chaque palier</div></div><div class="toggle" id="tog-tp" onclick="tog(this)"></div></div>
        <div class="cfg-input-row"><div class="cfg-field"><label>Hysteresis (%)</label><input type="number" id="tpHysteresis" value="5" min="0" max="50"></div></div>
        <div style="padding:0 14px 12px">
          <div style="font-size:9px;color:var(--dim);letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px">Paliers : PnL → % vendu</div>
          <div id="tp-tiers-list" style="display:flex;flex-direction:column;gap:6px"></div>
          <button onclick="addTPTier()" style="margin-top:8px;width:100%;padding:7px;background:var(--bg3);border:1px dashed var(--border2);border-radius:6px;color:var(--dim);font-size:11px;cursor:pointer">+ Ajouter palier</button>
        </div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Break-Even Stop</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Actif</div><div class="cfg-row-desc">SL = entry+buffer apres TP1</div></div><div class="toggle" id="tog-be" onclick="tog(this)"></div></div>
        <div class="cfg-input-row"><div class="cfg-field"><label>Buffer (%)</label><input type="number" id="beBuffer" value="2" min="0" max="20"></div></div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Stop-Loss</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Actif</div><div class="cfg-row-desc">Vente forcee sous le seuil</div></div><div class="toggle" id="tog-sl" onclick="tog(this)"></div></div>
        <div class="cfg-input-row"><div class="cfg-field"><label>Seuil (%)</label><input type="number" id="slPct" value="-50" min="-99" max="-1"></div></div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Trailing Stop</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Actif</div><div class="cfg-row-desc">Suit le peak, vend si recul</div></div><div class="toggle" id="tog-ts" onclick="tog(this)"></div></div>
        <div class="cfg-input-row"><div class="cfg-field"><label>Recul max (%)</label><input type="number" id="tsPct" value="20" min="1" max="90"></div></div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Anti-Rug</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Actif</div><div class="cfg-row-desc">Exit urgence si chute brutale</div></div><div class="toggle" id="tog-ar" onclick="tog(this)"></div></div>
        <div class="cfg-input-row"><div class="cfg-field"><label>Chute % / cycle</label><input type="number" id="arPct" value="60" min="10" max="99"></div></div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Daily Loss Limit</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Actif</div><div class="cfg-row-desc">Suspend les achats si perte journaliere atteinte</div></div><div class="toggle" id="tog-dl" onclick="tog(this)"></div></div>
        <div class="cfg-input-row"><div class="cfg-field"><label>Limite (SOL)</label><input type="number" id="dailyLossLimit" value="-1.5" step="0.1" max="0"></div></div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Jito Bundles</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Actif</div><div class="cfg-row-desc">Transactions prioritaires Jito</div></div><div class="toggle" id="tog-jito" onclick="tog(this)"></div></div>
        <div class="cfg-input-row"><div class="cfg-field"><label>Tip (SOL)</label><input type="number" id="jitoTip" value="0.0001" step="0.00001" min="0"></div></div>
      </div>

      <div class="cfg-section" style="border-color:rgba(240,180,41,.2)">
        <div class="cfg-title" style="color:var(--gold);background:rgba(240,180,41,.06)">Sortie des ventes</div>
        <div class="cfg-row"><div class="cfg-row-label"><div class="cfg-row-title">Vendre en USDC</div><div class="cfg-row-desc">OFF = SOL | ON = USDC stablecoin</div></div><div class="toggle" id="tog-usdc" onclick="tog(this)"></div></div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">General</div>
        <div class="cfg-input-row">
          <div class="cfg-field"><label>Slippage (bps)</label><input type="number" id="defaultSlippage" value="500" min="10" max="5000"></div>
          <div class="cfg-field"><label>Reserve SOL min</label><input type="number" id="minSolReserve" value="0.05" step="0.01" min="0"></div>
        </div>
        <div class="cfg-input-row">
          <div class="cfg-field"><label>Intervalle (sec)</label>
            <select id="intervalSec"><option value="15">15s</option><option value="30" selected>30s</option><option value="60">60s</option></select>
          </div>
          <div class="cfg-field"><label>Max positions</label><input type="number" id="maxPositions" value="10" min="1" max="50"></div>
        </div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Circuit-Breaker</div>
        <div style="padding:14px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:11px;color:var(--dim)">Echecs sell consecutifs</div>
            <div style="font-family:var(--mono);font-size:28px;font-weight:700;color:var(--dn)" id="cbCount">&mdash;</div>
            <div style="font-size:9px;color:var(--gold);margin-top:2px" id="cbResetIn"></div>
          </div>
          <button onclick="resetCB()" style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 16px;color:var(--text);font-size:11px;font-weight:600;cursor:pointer">RESET</button>
        </div>
      </div>

      <div class="cfg-section">
        <div class="cfg-title">Daily Loss - Etat</div>
        <div style="padding:14px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:11px;color:var(--dim)">PnL aujourd'hui</div>
            <div style="font-family:var(--mono);font-size:22px;font-weight:700" id="dlPnl">&mdash;</div>
            <div style="font-size:9px;margin-top:2px" id="dlStatus">&mdash;</div>
          </div>
          <button onclick="resetDL()" style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 16px;color:var(--text);font-size:11px;font-weight:600;cursor:pointer">RESET</button>
        </div>
      </div>

    </div>
    <div style="height:80px"></div>
  </section>

</div>

<div class="save-bar" id="saveBar" style="display:none">
  <button class="btn-save" onclick="saveConfig()">SAUVEGARDER</button>
  <div class="save-status" id="saveStatus"></div>
</div>

<div class="toast-wrap" id="toasts"></div>

<script>

const API = 'https://solana-sniper-7o8s.onrender.com';
let _portfolio = [], _showDead = false, _cfgData = {}, _detailMint = null, _tpTiers = [];

document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('chartFrame').addEventListener('load', onChartLoad);
  loadAll();
  setInterval(loadAll, 30000);
});

function apiFetch(path, opts) {
  opts = opts || {};
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 12000);
  return fetch(API + path, Object.assign({}, opts, { signal: controller.signal }))
    .then(function(r) {
      clearTimeout(timer);
      if (!(r.headers.get('content-type') || '').includes('application/json'))
        throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .catch(function(e) { clearTimeout(timer); throw e; });
}

function loadAll() { return Promise.allSettled([loadPortfolio(), loadAnalytics()]); }

function hardRefresh() {
  var btn = document.getElementById('btnRefresh');
  btn.style.transform = 'rotate(180deg)';
  loadAll().then(function() { setTimeout(function() { btn.style.transform = ''; }, 500); });
}

function loadPortfolio() {
  return Promise.allSettled([
    apiFetch('/api/stats'),
    apiFetch('/api/portfolio'),
    apiFetch('/api/analytics')
  ]).then(function(r) {
    var s = r[0].value || {}, toks = (r[1].value && r[1].value.tokens) || [], a = r[2].value || {};
    _portfolio = toks;

    var dot = document.getElementById('statusDot');
    if (dot) dot.style.background = s.sellCircuitBreaker >= 3 ? 'var(--dn)' : 'var(--up)';

    var tv = document.getElementById('tvTotal');
    if (tv) tv.textContent = s.totalValue != null ? '$' + s.totalValue.toFixed(2) : '--';

    var pe = document.getElementById('tvPnl');
    if (pe) {
      var p = a.realizedPnlSol != null ? a.realizedPnlSol : null;
      pe.textContent = p !== null ? (p >= 0 ? '+' : '') + p.toFixed(4) + ' SOL' : '--';
      pe.className = 'ts-val ' + (p == null ? '' : p >= 0 ? 'pos' : 'neg');
    }
    var we = document.getElementById('tvWin');
    if (we) {
      we.textContent = a.winRate != null ? a.winRate + '%' : '--';
      we.className = 'ts-val ' + ((a.winRate || 0) >= 50 ? 'pos' : 'neg');
    }

    var cb = document.getElementById('cbCount');
    if (cb) cb.textContent = s.sellCircuitBreaker != null ? s.sellCircuitBreaker : '--';
    var cr = document.getElementById('cbResetIn');
    if (cr) cr.textContent = s.cbAutoResetIn > 0 ? 'Reset dans ' + s.cbAutoResetIn + 's' : '';

    var dl = s.dailyLoss;
    if (dl) {
      var dp = document.getElementById('dlPnl'), ds = document.getElementById('dlStatus');
      if (dp) { dp.textContent = (dl.realizedSol >= 0 ? '+' : '') + dl.realizedSol.toFixed(4) + ' SOL'; dp.style.color = dl.realizedSol >= 0 ? 'var(--up)' : 'var(--dn)'; }
      if (ds) { ds.textContent = dl.paused ? 'Achats suspendus' : 'Limite : ' + dl.limit + ' SOL'; ds.style.color = dl.paused ? 'var(--dn)' : 'var(--dim)'; }
    }
    renderPortfolio(_portfolio);
  }).catch(function(e) { console.error('loadPortfolio', e); });
}

function isDead(t) {
  if (t.isSol || t.isUsdc) return false;
  return !(t.price > 0) && !(t.symbol && /[a-zA-Z]{2,}/.test(t.symbol) && t.symbol.length <= 24);
}

function toggleDead() {
  _showDead = !_showDead;
  var btn = document.getElementById('btnDead');
  btn.textContent = 'Morts : ' + (_showDead ? 'visibles' : 'caches');
  btn.classList.toggle('active-dead', _showDead);
  renderPortfolio(_portfolio);
}

function fmtK(n) { return n > 0 ? '$' + (n / 1000).toFixed(1) + 'k' : '--'; }
function fmtM(n) {
  if (!n) return '--';
  if (n > 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n > 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}
function fmt(n, d) { d = d != null ? d : 2; return n != null ? n.toFixed(d) : '--'; }

function renderPortfolio(toks) {
  var list = document.getElementById('tokList');
  var cnt  = document.getElementById('filterCount');
  toks.forEach(function(t) { if (!t.mintFull) t.mintFull = t.mint; });
  var live = toks.filter(function(t) { return !isDead(t); });
  var dead = toks.filter(function(t) { return isDead(t); });
  var show = _showDead ? toks : live;
  if (cnt) cnt.textContent = dead.length > 0
    ? live.length + ' actifs  ' + dead.length + ' morts ' + (_showDead ? 'visibles' : 'masques')
    : live.length + ' tokens';
  if (!show.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">&#9672;</div><div class="empty-txt">Portfolio vide</div></div>';
    return;
  }
  var html = '', inDead = false;
  show.forEach(function(t) {
    var dt = isDead(t);
    if (_showDead && !inDead && dt && live.length > 0) {
      inDead = true;
      html += '<div class="dead-sep">&#9660; Rugges / abandonnes (' + dead.length + ')</div>';
    }
    var pnl  = t.pnl != null ? t.pnl : null;
    var pCls = pnl == null ? 'dim' : pnl >= 0 ? 'pos' : 'neg';
    var pStr = pnl == null ? '--' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
    var cc   = 'tok-card' + (t.isSol ? ' sol-card' : t.isUsdc ? ' usdc-card' : dt ? ' dead-card' : '');
    var sc   = 'tok-sym'  + (t.isSol ? ' sol-sym'  : t.isUsdc ? ' usdc-sym'  : '');
    var logoHtml = t.logo
      ? '<img src="' + t.logo + '" onerror="this.outerHTML=\'&#129689;\'" loading="lazy">'
      : '&#129689;';
    var badges = '';
    if (t.isSol)             badges += '<span class="badge badge-sol">SOL</span>';
    else if (t.isUsdc)       badges += '<span class="badge badge-usdc">USDC</span>';
    else if (t.bootstrapped) badges += '<span class="badge badge-boot">BOOT</span>';
    if (t.stopLossHit) badges += '<span class="badge badge-sl">SL</span>';
    if (t.breakEven)   badges += '<span class="badge badge-be">BE</span>';
    var valStr = t.value > 0 ? '$' + t.value.toFixed(2) : '--';
    var balStr = t.isSol ? fmt(t.balance, 4) + ' SOL' : t.isUsdc ? fmt(t.balance, 2) + ' $' : fmt(t.balance, 4);
    var mintEnc = encodeURIComponent(t.mintFull);
    html += '<div class="' + cc + '" data-mint="' + mintEnc + '">'
      + '<div class="tok-top">'
      + '<div class="tok-logo">' + logoHtml + '</div>'
      + '<div class="tok-name"><div class="' + sc + '">' + (t.symbol || t.mint.slice(0, 8)) + '</div>'
      + '<div class="tok-addr"><span>' + t.mint.slice(0, 4) + '...' + t.mint.slice(-4) + '</span>' + badges + '</div></div>'
      + '<div class="tok-right"><div class="tok-val">' + valStr + '</div>'
      + '<div class="tok-pnl ' + pCls + '">' + pStr + '</div></div>'
      + '</div>'
      + '<div class="tok-bottom">'
      + '<div class="tok-stat"><div class="tok-stat-lbl">Balance</div><div class="tok-stat-val">' + balStr + '</div></div>'
      + '<div class="tok-stat"><div class="tok-stat-lbl">Peak</div><div class="tok-stat-val pos">+' + fmt(t.peakPnl, 1) + '%</div></div>'
      + '<div class="tok-stat"><div class="tok-stat-lbl">Liq.</div><div class="tok-stat-val">' + fmtK(t.liquidity) + '</div></div>'
      + '</div></div>';
  });
  list.innerHTML = html;
  // Event delegation - no inline onclick needed
  list.onclick = function(e) {
    var card = e.target.closest('[data-mint]');
    if (card) openDetail(card.getAttribute('data-mint'));
  };
}

function openDetail(enc) {
  var mint = decodeURIComponent(enc), tok = null;
  for (var i = 0; i < _portfolio.length; i++) { if (_portfolio[i].mintFull === mint) { tok = _portfolio[i]; break; } }
  if (!tok) return;
  _detailMint = mint;
  document.getElementById('dtTitle').textContent  = tok.symbol || mint.slice(0, 8);
  document.getElementById('dtAddr').textContent   = mint.slice(0, 12) + '...' + mint.slice(-6);
  document.getElementById('dtScore').textContent  = tok.score != null ? tok.score + '/100' : '--';
  document.getElementById('dtBal').textContent    = tok.isSol ? fmt(tok.balance, 4) + ' SOL' : tok.isUsdc ? fmt(tok.balance, 2) + ' $' : fmt(tok.balance, 4);
  var pnl = tok.pnl != null ? tok.pnl : null;
  var dp = document.getElementById('dtPnl');
  dp.textContent = pnl == null ? '--' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
  dp.className = 'detail-stat-val ' + (pnl == null ? '' : pnl >= 0 ? 'pos' : 'neg');
  document.getElementById('dtVal').textContent   = tok.value > 0 ? '$' + tok.value.toFixed(2) : '--';
  document.getElementById('dtPeak').textContent  = '+' + fmt(tok.peakPnl, 2) + '%';
  document.getElementById('dtEntry').textContent = tok.entryPrice ? tok.entryPrice.toPrecision(5) : '--';
  document.getElementById('dtLiq').textContent   = fmtK(tok.liquidity);
  document.getElementById('dtMcap').textContent  = fmtM(tok.mcap);
  document.getElementById('dtVol').textContent   = fmtM(tok.volume24h);
  document.getElementById('btnDex').href = 'https://dexscreener.com/solana/' + mint;
  document.getElementById('chartSpinner').style.display = 'flex';
  var frame = document.getElementById('chartFrame');
  frame.src = 'about:blank';
  setTimeout(function() { frame.src = 'https://dexscreener.com/solana/' + mint + '?embed=1&theme=dark&trades=0&info=0'; }, 80);
  document.getElementById('detailView').classList.add('open');
}

function closeDetail() {
  document.getElementById('detailView').classList.remove('open');
  document.getElementById('chartFrame').src = 'about:blank';
  _detailMint = null;
}

function onChartLoad() {
  var f = document.getElementById('chartFrame');
  if (f.src !== 'about:blank') document.getElementById('chartSpinner').style.display = 'none';
}

function copyMint() {
  if (!_detailMint) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(_detailMint).then(function() { toast('Adresse copiee', 'ok'); });
  } else {
    var t = document.createElement('textarea');
    t.value = _detailMint; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
    toast('Adresse copiee', 'ok');
  }
}

function loadScanner() {
  var wrap = document.getElementById('scannerContent');
  return Promise.allSettled([apiFetch('/api/scanner/status'), apiFetch('/api/daily-loss')]).then(function(res) {
    var s = res[0].value || {}, d = res[1].value || {};
    var fn = function(n) { return n != null ? n.toLocaleString() : '--'; };
    var wsS = s.wsConnected ? 'WS connecte' : 'Polling';
    function rowHtml(lbl, val) {
      return '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 10px">'
        + '<div style="font-size:8px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">' + lbl + '</div>'
        + '<div style="font-family:var(--mono);font-size:12px;font-weight:600">' + val + '</div></div>';
    }
    var dlHtml = '';
    if (d.enabled !== undefined) {
      var dlColor = d.realizedSol >= 0 ? 'var(--up)' : 'var(--dn)';
      var dlBorder = d.paused ? 'rgba(255,56,96,.4)' : 'var(--border)';
      var dlPnlStr = (d.realizedSol >= 0 ? '+' : '') + (d.realizedSol || 0).toFixed(4) + ' SOL';
      dlHtml = '<div style="background:var(--bg1);border:1px solid ' + dlBorder + ';border-radius:10px;padding:12px;margin-bottom:8px">'
        + '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Daily Loss</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
        + '<div><div style="font-family:var(--mono);font-size:20px;font-weight:700;color:' + dlColor + '">' + dlPnlStr + '</div>'
        + '<div style="font-size:9px;color:var(--dim);margin-top:3px">Limite : ' + d.limit + ' SOL | ' + (d.date || '') + '</div></div>'
        + (d.paused
           ? '<span style="background:rgba(255,56,96,.15);color:var(--dn);border:1px solid rgba(255,56,96,.3);border-radius:4px;font-size:10px;font-weight:700;padding:3px 8px">PAUSE</span>'
           : '<span style="color:var(--up);font-size:10px;font-weight:600">Actif</span>')
        + '</div>'
        + (d.paused ? '<button onclick="resetDL()" style="margin-top:10px;width:100%;padding:8px;background:rgba(255,56,96,.1);border:1px solid rgba(255,56,96,.3);border-radius:6px;color:var(--dn);font-size:11px;font-weight:600;cursor:pointer">Reset Daily Loss</button>' : '')
        + '</div>';
    }
    wrap.innerHTML = '<div class="sc-status">'
      + '<div class="sc-dot ' + (s.running ? 'on' : 'off') + '"></div>'
      + '<div style="font-size:11px;font-weight:600">Scanner ' + (s.running ? 'ACTIF' : 'INACTIF') + '</div>'
      + '<div style="font-size:9px;color:var(--dim);margin-left:auto;font-family:var(--mono)">' + wsS + '</div></div>'
      + '<div class="sc-grid">'
      + '<div class="sc-card"><div class="sc-lbl">Detectes</div><div class="sc-val">' + fn(s.stats && s.stats.detected) + '</div><div class="sc-sub">total session</div></div>'
      + '<div class="sc-card"><div class="sc-lbl">Achetes</div><div class="sc-val" style="color:var(--up)">' + fn(s.stats && s.stats.bought) + '</div><div class="sc-sub">swaps reels</div></div>'
      + '<div class="sc-card"><div class="sc-lbl">Rejetes</div><div class="sc-val" style="color:var(--dn)">' + fn(s.stats && s.stats.rejected) + '</div><div class="sc-sub">filtres</div></div>'
      + '<div class="sc-card"><div class="sc-lbl">En queue</div><div class="sc-val">' + (s.queueLength != null ? s.queueLength : '--') + '</div><div class="sc-sub">delai ' + (s.delayMs ? s.delayMs / 1000 + 's' : '--') + '</div></div>'
      + '</div>'
      + '<div style="padding:0 12px 12px">'
      + '<div style="background:var(--bg1);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px">'
      + '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Criteres actuels</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">'
      + rowHtml('Score min', (s.minScore != null ? s.minScore : '--') + '/100')
      + rowHtml('SOL/trade', (s.solAmount != null ? s.solAmount : '--') + ' SOL')
      + rowHtml('Liq. min', '$' + fn(s.minLiq)) + rowHtml('Liq. max', '$' + fn(s.maxLiq))
      + rowHtml('Delai', s.delayMs ? s.delayMs / 1000 + 's' : '--')
      + rowHtml('Poll', (s.pollIntervalS != null ? s.pollIntervalS : '--') + 's')
      + '</div></div>'
      + dlHtml
      + '<button onclick="resetSeen()" style="width:100%;padding:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--dim);font-size:11px;font-weight:600;cursor:pointer">Effacer tokens vus (' + (s.seenCount || 0) + ')</button>'
      + '</div>';
  }).catch(function(e) {
    document.getElementById('scannerContent').innerHTML = '<div class="empty"><div class="empty-icon">&#8853;</div><div class="empty-txt">' + e.message + '</div></div>';
  });
}

function resetSeen() {
  apiFetch('/api/scanner/reset-seen', { method: 'POST' }).then(function() { toast('Tokens vus effaces', 'ok'); loadScanner(); }).catch(function(e) { toast('Erreur: ' + e.message, 'err'); });
}

function loadAnalytics() {
  return Promise.allSettled([apiFetch('/api/analytics'), apiFetch('/api/trades')]).then(function(res) {
    var a = res[0].value || {}, tr = (res[1].value && res[1].value.trades) || [];
    var g = function(id) { return document.getElementById(id); };
    var p = a.realizedPnlSol != null ? a.realizedPnlSol : null;
    var ap = g('anPnl'); if (ap) { ap.textContent = p !== null ? (p >= 0 ? '+' : '') + p.toFixed(4) + ' SOL' : '--'; ap.className = 'kpi-val ' + (p == null ? '' : p >= 0 ? 'pos' : 'neg'); }
    var aw = g('anWin'); if (aw) { aw.textContent = a.winRate != null ? a.winRate + '%' : '--'; aw.className = 'kpi-val ' + ((a.winRate || 0) >= 50 ? 'pos' : 'neg'); }
    if (g('anTrades')) g('anTrades').textContent = a.totalTrades != null ? a.totalTrades : '--';
    var ar = g('anRoi'); if (ar) { ar.textContent = a.roi != null ? a.roi + '%' : '--'; ar.className = 'kpi-val ' + (a.roi == null ? '' : a.roi >= 0 ? 'pos' : 'neg'); }
    if (g('anSharpe')) g('anSharpe').textContent = a.sharpeRatio != null ? a.sharpeRatio : '--';
    if (g('anDD')) g('anDD').textContent = a.maxDrawdownSol ? '-' + a.maxDrawdownSol + ' SOL' : '--';
    var list = g('tradesList');
    if (!list) return;
    if (!tr.length) { list.innerHTML = '<div class="empty"><div class="empty-icon">&#128202;</div><div class="empty-txt">Aucun trade cloture</div></div>'; return; }
    list.innerHTML = tr.slice(0, 30).map(function(t) {
      var p = t.pnlPct != null ? t.pnlPct : null, cls = p == null ? '' : p >= 0 ? 'pos' : 'neg';
      var d = new Date(t.ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      var icon = t.type === 'buy' ? '[B]' : (t.type === 'sell' ? (p != null && p >= 0 ? '[+]' : '[-]') : '');
      return '<div class="trade-card">'
        + '<div><div class="trade-sym">' + icon + ' ' + (t.symbol || (t.mint && t.mint.slice(0, 8)) || '?') + '</div>'
        + '<div class="trade-meta">' + (t.type || '').toUpperCase() + ' | ' + d + ' | ' + (t.reason || '') + '</div></div>'
        + '<div><div class="trade-pnl ' + cls + '">' + (p != null ? (p >= 0 ? '+' : '') + p.toFixed(2) + '%' : '--') + '</div>'
        + '<div class="trade-sol">' + (t.solOut != null ? t.solOut.toFixed(4) + ' SOL' : t.solSpent != null ? t.solSpent.toFixed(4) + ' SOL in' : '') + '</div></div>'
        + '</div>';
    }).join('');
  }).catch(function(e) { console.error('loadAnalytics', e); });
}

function loadConfig() {
  apiFetch('/api/config').then(function(c) { _cfgData = c; applyConfig(); }).catch(function(e) { console.error(e); });
}

function renderTPTiers(tiers) {
  _tpTiers = Array.isArray(tiers) ? tiers.map(function(t) { return { pnl: t.pnl, sell: t.sell }; }) : [];
  var list = document.getElementById('tp-tiers-list');
  if (!list) return;
  list.innerHTML = '';
  _tpTiers.forEach(function(tier, i) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px';
    var inner = document.createElement('div');
    inner.style.cssText = 'flex:1;display:flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:5px 8px';
    var lbl1 = document.createElement('span'); lbl1.style.cssText = 'font-size:9px;color:var(--dim);white-space:nowrap'; lbl1.textContent = 'PnL >=';
    var inp1 = document.createElement('input'); inp1.type = 'number'; inp1.value = tier.pnl; inp1.min = 1; inp1.max = 10000; inp1.step = 1;
    inp1.style.cssText = 'width:52px;background:none;border:none;color:var(--text);font-size:12px;font-family:var(--mono);text-align:right;outline:none';
    inp1.dataset.idx = i; inp1.dataset.field = 'pnl'; inp1.onchange = function() { if (_tpTiers[i]) _tpTiers[i].pnl = parseFloat(this.value) || 0; };
    var lbl2 = document.createElement('span'); lbl2.style.cssText = 'font-size:9px;color:var(--dim)'; lbl2.textContent = '%';
    var arr  = document.createElement('span'); arr.style.cssText = 'font-size:10px;color:var(--dim);margin:0 4px'; arr.textContent = '->';
    var lbl3 = document.createElement('span'); lbl3.style.cssText = 'font-size:9px;color:var(--dim);white-space:nowrap'; lbl3.textContent = 'vendre';
    var inp2 = document.createElement('input'); inp2.type = 'number'; inp2.value = tier.sell; inp2.min = 1; inp2.max = 100; inp2.step = 1;
    inp2.style.cssText = 'width:46px;background:none;border:none;color:var(--gold);font-size:12px;font-family:var(--mono);text-align:right;outline:none';
    inp2.dataset.idx = i; inp2.dataset.field = 'sell'; inp2.onchange = function() { if (_tpTiers[i]) _tpTiers[i].sell = parseFloat(this.value) || 0; };
    var lbl4 = document.createElement('span'); lbl4.style.cssText = 'font-size:9px;color:var(--dim)'; lbl4.textContent = '%';
    inner.appendChild(lbl1); inner.appendChild(inp1); inner.appendChild(lbl2); inner.appendChild(arr);
    inner.appendChild(lbl3); inner.appendChild(inp2); inner.appendChild(lbl4);
    var del = document.createElement('button');
    del.style.cssText = 'width:26px;height:26px;background:none;border:1px solid var(--border2);border-radius:6px;color:var(--dn);font-size:14px;cursor:pointer;flex-shrink:0;line-height:1';
    del.textContent = 'x'; del.dataset.idx = i;
    del.onclick = function() { removeTPTier(parseInt(this.dataset.idx)); };
    row.appendChild(inner); row.appendChild(del);
    list.appendChild(row);
  });
}

function addTPTier() {
  var lp = _tpTiers.length ? _tpTiers[_tpTiers.length - 1].pnl : 0;
  _tpTiers.push({ pnl: lp + 50, sell: 25 });
  renderTPTiers(_tpTiers);
}

function removeTPTier(i) { _tpTiers.splice(i, 1); renderTPTiers(_tpTiers); }

function applyConfig() {
  var c = _cfgData;
  function sb(id, v) { var el = document.getElementById(id); if (el) el.classList.toggle('on', !!v); }
  sb('tog-tp', c.takeProfitEnabled); sb('tog-be', c.breakEvenEnabled); sb('tog-sl', c.stopLossEnabled);
  sb('tog-ts', c.trailingEnabled);   sb('tog-ar', c.antiRugEnabled);   sb('tog-jito', c.jitoEnabled);
  sb('tog-usdc', c.sellToUsdc);      sb('tog-scanner', c.scannerEnabled); sb('tog-dl', c.dailyLossEnabled);
  function sv(id, v) { var el = document.getElementById(id); if (el && v != null) el.value = v; }
  sv('tpHysteresis', c.hysteresis);       sv('beBuffer', c.breakEvenBuffer);   sv('slPct', c.stopLossPct);
  sv('tsPct', c.trailingPct);             sv('arPct', c.antiRugPct);            sv('jitoTip', c.jitoTipSol);
  sv('defaultSlippage', c.defaultSlippage); sv('minSolReserve', c.minSolReserve);
  sv('intervalSec', c.intervalSec);       sv('maxPositions', c.maxPositions);
  sv('scannerMinScore', c.scannerMinScore); sv('scannerSolAmount', c.scannerSolAmount);
  sv('scannerMinLiq', c.scannerMinLiq);   sv('scannerMaxLiq', c.scannerMaxLiq);
  sv('dailyLossLimit', c.dailyLossLimit);
  renderTPTiers(c.takeProfitTiers || []);
}

function tog(el) { el.classList.toggle('on'); }
function getNum(id) { var v = parseFloat(document.getElementById(id) && document.getElementById(id).value); return isNaN(v) ? null : v; }
function getInt(id) { var v = parseInt(document.getElementById(id)  && document.getElementById(id).value);  return isNaN(v) ? null : v; }
function getBool(id) { var el = document.getElementById(id); return el ? el.classList.contains('on') : false; }

function saveConfig() {
  var st = document.getElementById('saveStatus');
  if (st) { st.textContent = '...'; st.className = 'save-status'; }
  var body = {
    takeProfitEnabled: getBool('tog-tp'), takeProfitTiers: _tpTiers.filter(function(t) { return t.pnl > 0 && t.sell > 0; }),
    breakEvenEnabled: getBool('tog-be'),  stopLossEnabled: getBool('tog-sl'),  trailingEnabled: getBool('tog-ts'),
    antiRugEnabled: getBool('tog-ar'),    jitoEnabled: getBool('tog-jito'),    sellToUsdc: getBool('tog-usdc'),
    scannerEnabled: getBool('tog-scanner'), dailyLossEnabled: getBool('tog-dl'),
    hysteresis: getNum('tpHysteresis'),   breakEvenBuffer: getNum('beBuffer'), stopLossPct: getNum('slPct'),
    trailingPct: getNum('tsPct'),         antiRugPct: getNum('arPct'),         jitoTipSol: getNum('jitoTip'),
    defaultSlippage: getInt('defaultSlippage'), minSolReserve: getNum('minSolReserve'),
    intervalSec: getInt('intervalSec'),   maxPositions: getInt('maxPositions'),
    scannerMinScore: getNum('scannerMinScore'), scannerSolAmount: getNum('scannerSolAmount'),
    scannerMinLiq: getNum('scannerMinLiq'), scannerMaxLiq: getNum('scannerMaxLiq'),
    dailyLossLimit: getNum('dailyLossLimit'),
  };
  apiFetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r) {
      if (r.success) { if (st) { st.textContent = 'Sauvegarde'; st.className = 'save-status ok'; } toast('Config sauvegardee', 'ok'); }
      else throw new Error('API error');
    }).catch(function(e) { if (st) { st.textContent = e.message; st.className = 'save-status err'; } toast('Erreur: ' + e.message, 'err'); });
}

function resetCB() {
  apiFetch('/api/reset-circuit-breaker', { method: 'POST' })
    .then(function(r) { if (r.success) { document.getElementById('cbCount').textContent = '0'; toast('CB reset', 'ok'); } })
    .catch(function(e) { toast('Erreur: ' + e.message, 'err'); });
}

function resetDL() {
  apiFetch('/api/daily-loss/reset', { method: 'POST' })
    .then(function(r) { if (r.success) { toast('Daily Loss reset', 'ok'); loadPortfolio(); loadScanner(); } })
    .catch(function(e) { toast('Erreur: ' + e.message, 'err'); });
}

function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
  if (el) el.classList.add('active');
  var sec = document.getElementById('sec-' + name);
  if (sec) sec.classList.add('active');
  var sb = document.getElementById('saveBar');
  if (sb) sb.style.display = name === 'config' ? 'block' : 'none';
  if (name === 'config')    loadConfig();
  if (name === 'scanner')   loadScanner();
  if (name === 'analytics') loadAnalytics();
}

function toast(msg, type) {
  type = type || '';
  var w = document.getElementById('toasts'), el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg; w.appendChild(el);
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 3000);
}

</script>
</body>
</html>
