<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="theme-color" content="#0a0e1a">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>SolBot Pro v5.0 — Dashboard Complet</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        :root {
            --bg: #0a0e1a; --bg-card: #151a28; --bg-hover: #1e2538;
            --border: #2a3550; --text: #ffffff; --text-muted: #6b7a99;
            --accent: #3b82f6; --success: #10b981; --danger: #ef4444;
            --warning: #f59e0b; --radius: 12px;
            --safe-top: env(safe-area-inset-top);
            --safe-bottom: env(safe-area-inset-bottom);
        }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg); color: var(--text);
            min-height: 100vh; padding-top: var(--safe-top);
            padding-bottom: calc(80px + var(--safe-bottom));
        }
        .header {
            background: linear-gradient(180deg, var(--bg-card) 0%, var(--bg) 100%);
            border-bottom: 1px solid var(--border);
            padding: calc(12px + var(--safe-top)) 16px 12px;
            position: sticky; top: 0; z-index: 100;
        }
        .header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
        .logo { display: flex; align-items: center; gap: 8px; }
        .logo-icon {
            width: 36px; height: 36px; background: linear-gradient(135deg, var(--accent), #8b5cf6);
            border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px;
        }
        .logo-text { font-size: 16px; font-weight: 700; }
        .logo-version {
            font-size: 10px; color: var(--text-muted); background: var(--bg-hover);
            padding: 2px 6px; border-radius: 4px; margin-left: 4px;
        }
        .status {
            display: flex; align-items: center; gap: 6px; padding: 4px 10px;
            background: rgba(16, 185, 129, 0.15); border: 1px solid var(--success);
            border-radius: 12px; font-size: 11px; font-weight: 600; color: var(--success);
        }
        .status-dot {
            width: 6px; height: 6px; background: var(--success); border-radius: 50%;
            animation: pulse 2s infinite;
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .stat-card {
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: var(--radius); padding: 10px;
        }
        .stat-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; }
        .stat-value { font-family: 'JetBrains Mono', monospace; font-size: 16px; font-weight: 600; }
        .stat-value.pos { color: var(--success); }
        .stat-value.neg { color: var(--danger); }
        .tabs {
            display: flex; gap: 6px; padding: 12px 16px; overflow-x: auto;
            -webkit-overflow-scrolling: touch;
        }
        .tabs::-webkit-scrollbar { display: none; }
        .tab {
            flex: 1; min-width: 80px; padding: 10px 16px; background: var(--bg-card);
            border: 1px solid var(--border); border-radius: 10px; color: var(--text-muted);
            font-size: 12px; font-weight: 500; cursor: pointer; text-align: center;
            white-space: nowrap;
        }
        .tab.active { background: var(--accent); color: white; border-color: var(--accent); }
        .section { display: none; padding: 0 16px; }
        .section.active { display: block; }
        .token-list { display: flex; flex-direction: column; gap: 10px; padding-bottom: 20px; }
        .token-card {
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: var(--radius); padding: 12px; cursor: pointer;
            transition: all 0.2s;
        }
        .token-card:active { transform: scale(0.98); border-color: var(--accent); }
        .token-card.active { border-color: var(--accent); box-shadow: 0 0 15px rgba(59,130,246,0.3); }
        .token-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .token-info { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
        .token-logo {
            width: 40px; height: 40px; border-radius: 10px; background: var(--bg-hover);
            display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; overflow: hidden;
        }
        .token-logo img { width: 100%; height: 100%; object-fit: cover; }
        .token-details { flex: 1; min-width: 0; }
        .token-symbol { font-weight: 600; font-size: 14px; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .token-address { font-size: 10px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; }
        .token-price { text-align: right; flex-shrink: 0; }
        .price-value { font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 14px; }
        .price-change { font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; }
        .price-change.pos { background: rgba(16, 185, 129, 0.15); color: var(--success); }
        .price-change.neg { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
        .token-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
        .token-stat { text-align: center; }
        .token-stat-label { font-size: 9px; color: var(--text-muted); margin-bottom: 3px; }
        .token-stat-value { font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 12px; }
        .token-actions { display: flex; gap: 6px; margin-top: 10px; }
        .btn {
            flex: 1; padding: 8px; border: none; border-radius: 8px;
            font-size: 11px; font-weight: 600; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 4px;
            min-height: 36px;
        }
        .btn:active { transform: scale(0.95); }
        .btn-buy { background: var(--success); color: white; }
        .btn-sell { background: var(--danger); color: white; }
        .btn-chart { background: var(--bg-hover); color: var(--text); border: 1px solid var(--border); }
        .btn-primary { background: linear-gradient(135deg, var(--accent), #8b5cf6); color: white; }
        .btn-secondary { background: var(--bg-hover); color: var(--text); border: 1px solid var(--border); }
        .btn-sm { padding: 6px 10px; font-size: 10px; }
        .fab {
            position: fixed; bottom: calc(90px + var(--safe-bottom)); right: 16px;
            width: 56px; height: 56px; background: linear-gradient(135deg, var(--accent), #8b5cf6);
            border: none; border-radius: 50%; color: white; font-size: 24px;
            cursor: pointer; box-shadow: 0 4px 20px rgba(59,130,246,0.4);
            z-index: 90; display: flex; align-items: center; justify-content: center;
        }
        .bottom-nav {
            position: fixed; bottom: 0; left: 0; right: 0;
            height: calc(70px + var(--safe-bottom)); background: var(--bg-card);
            border-top: 1px solid var(--border); display: flex; justify-content: space-around;
            align-items: flex-start; padding-top: 8px; z-index: 100;
        }
        .nav-item {
            display: flex; flex-direction: column; align-items: center;
            gap: 4px; padding: 8px 12px; color: var(--text-muted);
            cursor: pointer; flex: 1;
        }
        .nav-item.active { color: var(--accent); }
        .nav-icon { font-size: 20px; }
        .nav-label { font-size: 10px; font-weight: 500; }
        .modal {
            display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.85); z-index: 200;
            align-items: flex-end; justify-content: center;
        }
        .modal.active { display: flex; }
        .modal-content {
            background: var(--bg-card); border-radius: var(--radius) var(--radius) 0 0;
            width: 100%; max-height: 85vh; overflow-y: auto;
            padding: 20px 16px calc(20px + var(--safe-bottom));
            animation: slideUp 0.3s ease;
        }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .modal-header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border);
        }
        .modal-title { font-size: 16px; font-weight: 700; }
        .modal-close {
            width: 36px; height: 36px; background: var(--bg-hover); border: none;
            border-radius: 8px; color: var(--text); font-size: 20px; cursor: pointer;
        }
        .form-group { margin-bottom: 16px; }
        .form-label { display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 6px; }
        .form-input {
            width: 100%; padding: 10px; background: var(--bg-hover);
            border: 1px solid var(--border); border-radius: 8px;
            color: var(--text); font-size: 13px;
        }
        .form-input:focus { outline: none; border-color: var(--accent); }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .quick-amounts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 6px; }
        .quick-btn {
            padding: 8px; background: var(--bg-hover); border: 1px solid var(--border);
            border-radius: 6px; color: var(--text-muted); font-size: 11px;
            font-weight: 600; cursor: pointer; text-align: center; min-height: 36px;
        }
        .quick-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
        .config-grid { display: flex; flex-direction: column; gap: 16px; }
        .config-section {
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: var(--radius); padding: 14px;
        }
        .config-section-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
        .toggle-row {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 0; border-bottom: 1px solid var(--border);
        }
        .toggle-row:last-child { border-bottom: none; }
        .toggle-label { display: flex; flex-direction: column; gap: 3px; flex: 1; }
        .toggle-title { font-size: 12px; font-weight: 500; }
        .toggle-desc { font-size: 10px; color: var(--text-muted); }
        .toggle {
            width: 48px; height: 26px; background: var(--bg-hover); border-radius: 13px;
            position: relative; cursor: pointer; flex-shrink: 0; margin-left: 10px;
        }
        .toggle.active { background: var(--success); }
        .toggle::after {
            content: ''; position: absolute; width: 20px; height: 20px;
            background: white; border-radius: 50%; top: 3px; left: 3px;
            transition: transform 0.2s;
        }
        .toggle.active::after { transform: translateX(22px); }
        .badge {
            display: inline-flex; align-items: center; padding: 2px 6px;
            border-radius: 4px; font-size: 9px; font-weight: 600;
        }
        .badge-success { background: rgba(16,185,129,0.15); color: var(--success); }
        .badge-danger { background: rgba(239,68,68,0.15); color: var(--danger); }
        .badge-warning { background: rgba(245,158,11,0.15); color: var(--warning); }
        .badge-info { background: rgba(59,130,246,0.15); color: var(--accent); }
        .chart-container {
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: var(--radius); padding: 12px; margin-bottom: 16px;
            height: 250px;
        }
        .loading { display: flex; align-items: center; justify-content: center; padding: 40px; color: var(--text-muted); gap: 10px; }
        .spinner {
            width: 24px; height: 24px; border: 3px solid var(--border);
            border-top-color: var(--accent); border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .empty { text-align: center; padding: 40px 20px; color: var(--text-muted); }
        .empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.5; }
        .toast-container {
            position: fixed; top: calc(20px + var(--safe-top)); right: 16px;
            z-index: 300; display: flex; flex-direction: column; gap: 8px;
        }
        .toast {
            padding: 12px 16px; background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 8px; color: var(--text); font-size: 13px;
            animation: slideIn 0.3s ease; min-width: 280px;
        }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .progress-bar {
            width: 100%; height: 6px; background: var(--bg-hover);
            border-radius: 3px; overflow: hidden; margin-top: 6px;
        }
        .progress-fill {
            height: 100%; background: linear-gradient(90deg, var(--accent), #8b5cf6);
            border-radius: 3px; transition: width 0.3s;
        }
        .auto-buy-status {
            background: var(--bg-hover); border: 1px solid var(--border);
            border-radius: 8px; padding: 10px; margin-top: 10px;
        }
        .auto-buy-tier {
            display: flex; justify-content: space-between; align-items: center;
            padding: 6px 0; border-bottom: 1px solid var(--border);
        }
        .auto-buy-tier:last-child { border-bottom: none; }
        .tier-triggered { color: var(--success); }
        .tier-pending { color: var(--text-muted); }
        .tier-will-trigger { color: var(--warning); }
        @media (min-width: 768px) {
            .stats-grid { grid-template-columns: repeat(4, 1fr); }
            .token-stats { grid-template-columns: repeat(5, 1fr); }
            .modal { align-items: center; }
            .modal-content { border-radius: var(--radius); max-width: 600px; max-height: 80vh; }
        }
    </style>
</head>
<body>
    <!-- HEADER -->
    <header class="header">
        <div class="header-top">
            <div class="logo">
                <div class="logo-icon">🤖</div>
                <div>
                    <div class="logo-text">SolBot Pro</div>
                    <div class="logo-version">v5.0</div>
                </div>
            </div>
            <div class="status">
                <div class="status-dot"></div>
                <span id="statusText">LIVE</span>
            </div>
        </div>
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Portfolio</div>
                <div class="stat-value" id="totalValue">$0.00</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">PnL Net</div>
                <div class="stat-value" id="pnlNet">0 ◎</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Win Rate</div>
                <div class="stat-value" id="winRate">0%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Actifs</div>
                <div class="stat-value" id="tokenCount">0</div>
            </div>
        </div>
    </header>

    <!-- TABS -->
    <div class="tabs">
        <div class="tab active" onclick="switchTab('portfolio')">◈ Portfolio</div>
        <div class="tab" onclick="switchTab('analytics')">⌇ Analytics</div>
        <div class="tab" onclick="switchTab('config')">⚙ Config</div>
        <div class="tab" onclick="switchTab('autobuys')">📈 Auto-Buys</div>
        <div class="tab" onclick="switchTab('reentry')">🔄 Re-Entry</div>
        <div class="tab" onclick="switchTab('dead')">🔴 Dead</div>
    </div>

    <!-- PORTFOLIO SECTION -->
    <section id="portfolio" class="section active">
        <div class="token-list" id="tokenList">
            <div class="loading">
                <div class="spinner"></div>
                <span>Chargement...</span>
            </div>
        </div>
    </section>

    <!-- ANALYTICS SECTION -->
    <section id="analytics" class="section">
        <div class="chart-container">
            <canvas id="pnlChart"></canvas>
        </div>
        <div class="stats-grid" style="margin-bottom: 16px;">
            <div class="stat-card">
                <div class="stat-label">PnL Réalisé</div>
                <div class="stat-value" id="realizedPnl">0 ◎</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Win Rate</div>
                <div class="stat-value" id="analyticsWinRate">0%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Trades</div>
                <div class="stat-value" id="totalTrades">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">ROI</div>
                <div class="stat-value" id="roi">0%</div>
            </div>
        </div>
        <div class="form-row">
            <div class="stat-card">
                <div class="stat-label">Sharpe</div>
                <div class="stat-value" id="sharpe">—</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Sortino</div>
                <div class="stat-value" id="sortino">—</div>
            </div>
        </div>
        <div class="form-row" style="margin-top: 10px;">
            <div class="stat-card">
                <div class="stat-label">Max Drawdown</div>
                <div class="stat-value neg" id="maxDrawdown">—</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Profit Factor</div>
                <div class="stat-value" id="profitFactor">—</div>
            </div>
        </div>
        <div class="config-section" style="margin-top: 16px;">
            <div class="config-section-title">🔥 Win / Loss Streaks</div>
            <div style="display: flex; gap: 16px; justify-content: center; padding: 12px;">
                <div style="text-align: center;">
                    <div style="font-size: 24px;">🔥</div>
                    <div style="font-size: 11px; color: var(--text-muted);">Win</div>
                    <div class="stat-value pos" id="winStreak">0</div>
                    <div style="font-size: 10px; color: var(--text-muted);">(Max: <span id="maxWinStreak">0</span>)</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 24px;">❄️</div>
                    <div style="font-size: 11px; color: var(--text-muted);">Loss</div>
                    <div class="stat-value neg" id="lossStreak">0</div>
                    <div style="font-size: 10px; color: var(--text-muted);">(Max: <span id="maxLossStreak">0</span>)</div>
                </div>
            </div>
        </div>
        <div class="config-section" style="margin-top: 16px;">
            <div class="config-section-title">📊 Derniers trades</div>
            <div id="recentTrades">
                <div class="empty">
                    <div class="empty-icon">📊</div>
                    <div>Aucun trade récent</div>
                </div>
            </div>
        </div>
    </section>

    <!-- CONFIG SECTION -->
    <section id="config" class="section">
        <div class="config-grid">
            <div class="config-section">
                <div class="config-section-title">🎯 Take-Profit</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Vente auto à chaque palier</div>
                    </div>
                    <div class="toggle" id="toggle-tp" onclick="toggleConfig('takeProfitEnabled')"></div>
                </div>
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">Hysteresis (%)</label>
                    <input type="number" class="form-input" id="tpHysteresis" value="5" min="0" max="50">
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">🔒 Break-Even Stop</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">SL → entry+buffer après TP1</div>
                    </div>
                    <div class="toggle" id="toggle-be" onclick="toggleConfig('breakEvenEnabled')"></div>
                </div>
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">Buffer (%)</label>
                    <select class="form-input" id="beBuffer">
                        <option value="1">+1%</option>
                        <option value="2" selected>+2%</option>
                        <option value="5">+5%</option>
                    </select>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">🛡 Stop-Loss</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Vente forcée sous le seuil</div>
                    </div>
                    <div class="toggle" id="toggle-sl" onclick="toggleConfig('stopLossEnabled')"></div>
                </div>
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">Seuil (%)</label>
                    <select class="form-input" id="slPct">
                        <option value="-25">-25%</option>
                        <option value="-40">-40%</option>
                        <option value="-50" selected>-50%</option>
                        <option value="-70">-70%</option>
                    </select>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">📉 Trailing Stop</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Suit le peak, vend si recul</div>
                    </div>
                    <div class="toggle" id="toggle-ts" onclick="toggleConfig('trailingEnabled')"></div>
                </div>
                <div class="form-row" style="margin-top: 12px;">
                    <div class="form-group">
                        <label class="form-label">Recul max (%)</label>
                        <select class="form-input" id="tsPct">
                            <option value="10">10%</option>
                            <option value="20" selected>20%</option>
                            <option value="30">30%</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Adaptatif σ</label>
                        <select class="form-input" id="tsVol">
                            <option value="false">OFF</option>
                            <option value="true" selected>ON</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">🚨 Anti-Rug</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Urgence si chute brutale</div>
                    </div>
                    <div class="toggle" id="toggle-ar" onclick="toggleConfig('antiRugEnabled')"></div>
                </div>
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">Chute (% / cycle)</label>
                    <select class="form-input" id="arPct">
                        <option value="40">40%</option>
                        <option value="60" selected>60%</option>
                        <option value="80">80%</option>
                    </select>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">💧 Liquidity Exit</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Exit si liquidité chute de X%</div>
                    </div>
                    <div class="toggle" id="toggle-le" onclick="toggleConfig('liqExitEnabled')"></div>
                </div>
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">Chute liq. (%)</label>
                    <select class="form-input" id="lePct">
                        <option value="50">50%</option>
                        <option value="70" selected>70%</option>
                        <option value="90">90%</option>
                    </select>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">⏱ Time-Based Stop</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Exit si stagnant trop longtemps</div>
                    </div>
                    <div class="toggle" id="toggle-tt" onclick="toggleConfig('timeStopEnabled')"></div>
                </div>
                <div class="form-row" style="margin-top: 12px;">
                    <div class="form-group">
                        <label class="form-label">Après (heures)</label>
                        <select class="form-input" id="ttHours">
                            <option value="12">12h</option>
                            <option value="24" selected>24h</option>
                            <option value="48">48h</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">PnL min</label>
                        <input type="number" class="form-input" id="ttMinPnl" value="0" step="1">
                    </div>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">🔄 Momentum Exit</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Exit si retournement confirmé</div>
                    </div>
                    <div class="toggle" id="toggle-me" onclick="toggleConfig('momentumEnabled')"></div>
                </div>
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">Seuil (%/cycle)</label>
                    <input type="number" class="form-input" id="meThreshold" value="-3" step="0.5">
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">⚡ Jito Bundles</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Sells urgents via Jito (anti-MEV)</div>
                    </div>
                    <div class="toggle" id="toggle-jito" onclick="toggleConfig('jitoEnabled')"></div>
                </div>
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">Tip (SOL)</label>
                    <input type="number" class="form-input" id="jitoTip" value="0.0001" step="0.0001">
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">📈 Pyramid In (NEW)</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Rachète sur montée (paliers)</div>
                    </div>
                    <div class="toggle" id="toggle-pyramid" onclick="toggleConfig('pyramidEnabled')"></div>
                </div>
                <div class="form-row" style="margin-top: 12px;">
                    <div class="form-group">
                        <label class="form-label">Max SOL</label>
                        <input type="number" class="form-input" id="pyramidMaxSol" value="0.5" step="0.05">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Hysteresis</label>
                        <input type="number" class="form-input" id="pyramidHysteresis" value="5" min="0" max="50">
                    </div>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">📉 DCA-Down (NEW)</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Moyenne à la baisse</div>
                    </div>
                    <div class="toggle" id="toggle-dcad" onclick="toggleConfig('dcadEnabled')"></div>
                </div>
                <div class="form-row" style="margin-top: 12px;">
                    <div class="form-group">
                        <label class="form-label">Max Adds</label>
                        <input type="number" class="form-input" id="dcadMaxAdds" value="2" min="1" max="10">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Require Momentum</label>
                        <select class="form-input" id="dcadRequireMomentum">
                            <option value="true" selected>OUI</option>
                            <option value="false">NON</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">🔄 Re-Entry (NEW)</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">Rachat auto après SL</div>
                    </div>
                    <div class="toggle" id="toggle-reentry" onclick="toggleConfig('reentryEnabled')"></div>
                </div>
                <div class="form-row" style="margin-top: 12px;">
                    <div class="form-group">
                        <label class="form-label">Délai (min)</label>
                        <input type="number" class="form-input" id="reentryDelayMin" value="30" min="1" max="1440">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Rebond min (%)</label>
                        <input type="number" class="form-input" id="reentryMinGain" value="15" min="1" max="200">
                    </div>
                </div>
                <div class="form-group" style="margin-top: 10px;">
                    <label class="form-label">Score min</label>
                    <input type="number" class="form-input" id="reentryMinScore" value="60" min="0" max="100">
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">🎯 Smart Sizing (NEW)</div>
                <div class="toggle-row">
                    <div class="toggle-label">
                        <div class="toggle-title">Actif</div>
                        <div class="toggle-desc">SOL auto par score 0-100</div>
                    </div>
                    <div class="toggle" id="toggle-smartsize" onclick="toggleConfig('smartSizeEnabled')"></div>
                </div>
                <div class="form-row" style="margin-top: 12px;">
                    <div class="form-group">
                        <label class="form-label">Base SOL</label>
                        <input type="number" class="form-input" id="smartSizeBase" value="0.05" step="0.01">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Multiplier</label>
                        <input type="number" class="form-input" id="smartSizeMult" value="2.0" step="0.1">
                    </div>
                </div>
                <div class="form-row" style="margin-top: 10px;">
                    <div class="form-group">
                        <label class="form-label">Min SOL</label>
                        <input type="number" class="form-input" id="smartSizeMin" value="0.02" step="0.01">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Max SOL</label>
                        <input type="number" class="form-input" id="smartSizeMax" value="0.5" step="0.05">
                    </div>
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">⚙ Général</div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Slippage défaut (bps)</label>
                        <input type="number" class="form-input" id="defaultSlippage" value="500" min="10" max="5000">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Réserve SOL min</label>
                        <input type="number" class="form-input" id="minSolReserve" value="0.05" step="0.01" min="0" max="10">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Intervalle (sec)</label>
                        <select class="form-input" id="intervalSec">
                            <option value="15">15s</option>
                            <option value="30" selected>30s</option>
                            <option value="60">60s</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Max positions</label>
                        <input type="number" class="form-input" id="maxPositions" value="10" min="1" max="50">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Score min. achat (0 = désactivé)</label>
                    <input type="number" class="form-input" id="minScore" value="0" min="0" max="100">
                </div>
            </div>
            <div class="config-section">
                <div class="config-section-title">⚠ Circuit-Breaker</div>
                <div style="padding: 10px; background: var(--bg-hover); border-radius: 8px; text-align: center;">
                    <div style="font-size: 12px; color: var(--text-muted);">Échecs sell consécutifs</div>
                    <div style="font-size: 24px; font-weight: 700; color: var(--danger);" id="circuitBreakerCount">—</div>
                    <button class="btn btn-secondary btn-sm" onclick="resetCircuitBreaker()" style="margin-top: 8px; width: 100%;">
                        🔄 RESET
                    </button>
                </div>
            </div>
        </div>
        <button class="btn btn-primary" onclick="saveConfig()" style="width: 100%; padding: 14px; margin-top: 16px; min-height: 48px;">
            ▸ SAUVEGARDER LA CONFIG ◂
        </button>
    </section>

    <!-- AUTO-BUYS SECTION -->
    <section id="autobuys" class="section">
        <div id="autoBuysContent">
            <div class="loading">
                <div class="spinner"></div>
                <span>Chargement...</span>
            </div>
        </div>
    </section>

    <!-- RE-ENTRY SECTION -->
    <section id="reentry" class="section">
        <div id="reentryContent">
            <div class="loading">
                <div class="spinner"></div>
                <span>Chargement...</span>
            </div>
        </div>
    </section>

    <!-- DEAD TOKENS SECTION -->
    <section id="dead" class="section">
        <div style="display: flex; gap: 10px; margin-bottom: 16px;">
            <button class="btn btn-secondary" onclick="loadDeadTokens()" style="flex: 1;">
                ↺ Refresh
            </button>
            <button class="btn btn-danger" onclick="purgeDeadTokens()" style="flex: 1;">
                🗑 Purge ALL
            </button>
            <button class="btn btn-secondary" onclick="resetNegCache()" style="flex: 1;">
                🔍 Reset Cache
            </button>
        </div>
        <div id="deadTokensContent">
            <div class="loading">
                <div class="spinner"></div>
                <span>Chargement...</span>
            </div>
        </div>
    </section>

    <!-- FLOATING ACTION BUTTON -->
    <button class="fab" onclick="openBuyModal()">+</button>

    <!-- BOTTOM NAV -->
    <nav class="bottom-nav">
        <div class="nav-item active" onclick="switchTab('portfolio')">
            <div class="nav-icon">◈</div>
            <div class="nav-label">Portfolio</div>
        </div>
        <div class="nav-item" onclick="switchTab('analytics')">
            <div class="nav-icon">⌇</div>
            <div class="nav-label">Analytics</div>
        </div>
        <div class="nav-item" onclick="switchTab('config')">
            <div class="nav-icon">⚙</div>
            <div class="nav-label">Config</div>
        </div>
        <div class="nav-item" onclick="switchTab('autobuys')">
            <div class="nav-icon">📈</div>
            <div class="nav-label">Auto</div>
        </div>
        <div class="nav-item" onclick="switchTab('reentry')">
            <div class="nav-icon">🔄</div>
            <div class="nav-label">Re-Entry</div>
        </div>
    </nav>

    <!-- BUY MODAL -->
    <div class="modal" id="buyModal">
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title">▲ ACHETER</div>
                <button class="modal-close" onclick="closeBuyModal()">×</button>
            </div>
            <div class="form-group">
                <label class="form-label">Token Address</label>
                <input type="text" class="form-input" id="buyTokenAddress" placeholder="Coller l'adresse complète">
            </div>
            <div class="form-group">
                <label class="form-label">Montant (SOL)</label>
                <input type="number" class="form-input" id="buyAmount" placeholder="0.00" step="0.01">
                <div class="quick-amounts">
                    <div class="quick-btn" onclick="setBuyAmount(0.1)">0.1</div>
                    <div class="quick-btn" onclick="setBuyAmount(0.25)">0.25</div>
                    <div class="quick-btn" onclick="setBuyAmount(0.5)">0.5</div>
                    <div class="quick-btn" onclick="setMaxBuy()">MAX</div>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Slippage</label>
                    <select class="form-input" id="buySlippage">
                        <option value="100">1%</option>
                        <option value="300" selected>3%</option>
                        <option value="500">5%</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Smart Size</label>
                    <select class="form-input" id="buySmartSize">
                        <option value="false">OFF</option>
                        <option value="true">ON</option>
                    </select>
                </div>
            </div>
            <button class="btn btn-buy" onclick="executeBuy()" style="width: 100%; padding: 14px; min-height: 48px;">
                CONFIRMER L'ACHAT
            </button>
        </div>
    </div>

    <!-- SELL MODAL -->
    <div class="modal" id="sellModal">
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title">▼ VENDRE</div>
                <button class="modal-close" onclick="closeSellModal()">×</button>
            </div>
            <div class="form-group">
                <label class="form-label">Token</label>
                <input type="text" class="form-input" id="sellTokenInfo" readonly style="background: var(--bg-hover);">
            </div>
            <div class="form-group">
                <label class="form-label">Balance</label>
                <input type="text" class="form-input" id="sellBalance" readonly style="background: var(--bg-hover);">
            </div>
            <div class="form-group">
                <label class="form-label">À vendre</label>
                <input type="number" class="form-input" id="sellAmount" placeholder="0.00" step="0.001">
                <div class="quick-amounts">
                    <div class="quick-btn" onclick="setSellPercent(25)">25%</div>
                    <div class="quick-btn" onclick="setSellPercent(50)">50%</div>
                    <div class="quick-btn" onclick="setSellPercent(75)">75%</div>
                    <div class="quick-btn" onclick="setSellPercent(100)">100%</div>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Slippage</label>
                    <select class="form-input" id="sellSlippage">
                        <option value="100">1%</option>
                        <option value="300" selected>3%</option>
                        <option value="500">5%</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Jito</label>
                    <select class="form-input" id="sellJito">
                        <option value="false">OFF</option>
                        <option value="true">ON</option>
                    </select>
                </div>
            </div>
            <button class="btn btn-sell" onclick="executeSell()" style="width: 100%; padding: 14px; min-height: 48px;">
                CONFIRMER LA VENTE
            </button>
        </div>
    </div>

    <!-- TOKEN DETAIL MODAL -->
    <div class="modal" id="tokenDetailModal">
        <div class="modal-content" style="max-width: 800px;">
            <div class="modal-header">
                <div class="modal-title" id="tokenDetailTitle">Token</div>
                <button class="modal-close" onclick="closeTokenDetailModal()">×</button>
            </div>
            <div class="form-row" style="margin-bottom: 16px;">
                <div class="stat-card">
                    <div class="stat-label">Valeur</div>
                    <div class="stat-value" id="detailValue">$0.00</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Liq.</div>
                    <div class="stat-value" id="detailLiq">$0k</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">MCap</div>
                    <div class="stat-value" id="detailMcap">$0</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Vol 24h</div>
                    <div class="stat-value" id="detailVol24h">$0</div>
                </div>
            </div>
            <div class="form-row" style="margin-bottom: 16px;">
                <div class="stat-card">
                    <div class="stat-label">Score</div>
                    <div class="stat-value" id="detailScore">0/100</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Entrée</div>
                    <div class="stat-value" id="detailEntry">$0.00</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Peak PnL</div>
                    <div class="stat-value pos" id="detailPeak">+0%</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Liq Drop</div>
                    <div class="stat-value neg" id="detailLiqDrop">0%</div>
                </div>
            </div>
            <div class="auto-buy-status" id="autoBuyStatus">
                <div style="font-size: 12px; font-weight: 600; margin-bottom: 8px;">📈 Pyramid In Status</div>
                <div id="pyramidTiers"></div>
                <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
                    Budget restant: <span id="pyramidBudget" style="color: var(--accent);">0 SOL</span>
                </div>
            </div>
            <div class="auto-buy-status" style="margin-top: 10px;">
                <div style="font-size: 12px; font-weight: 600; margin-bottom: 8px;">📉 DCA-Down Status</div>
                <div id="dcadTiers"></div>
                <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
                    Adds restants: <span id="dcadAddsLeft" style="color: var(--accent);">0</span>
                </div>
            </div>
            <div style="display: flex; gap: 10px; margin-top: 16px;">
                <button class="btn btn-secondary" onclick="openDexScreener()" style="flex: 1;">
                    🦎 DexScreener
                </button>
                <button class="btn btn-secondary" onclick="scanHistory()" style="flex: 1;">
                    🔍 Scan History
                </button>
            </div>
            <div style="display: flex; gap: 10px; margin-top: 10px;">
                <button class="btn btn-buy" onclick="openBuyFromDetail()" style="flex: 1;">
                    ▲ BUY
                </button>
                <button class="btn btn-sell" onclick="openSellFromDetail()" style="flex: 1;">
                    ▼ SELL
                </button>
            </div>
        </div>
    </div>

    <!-- TOAST CONTAINER -->
    <div class="toast-container" id="toastContainer"></div>

    <script>
        const API = window.location.origin;
        let portfolio = [];
        let configData = {};
        let currentToken = null;
        let solBalance = 0;
        let pnlChart = null;
        let currentDetailMint = null;

        // INIT
        document.addEventListener('DOMContentLoaded', () => {
            loadData();
            loadConfig();
            setInterval(() => loadData(), 30000);
        });

        // LOAD DATA
        async function loadData() {
            try {
                const [statsRes, portfolioRes, balanceRes] = await Promise.all([
                    fetch(`${API}/api/stats`),
                    fetch(`${API}/api/portfolio`),
                    fetch(`${API}/api/sol-balance`)
                ]);
                const statsData = await statsRes.json();
                portfolio = (await portfolioRes.json()).tokens || [];
                const balanceData = await balanceRes.json();
                solBalance = balanceData.balance || 0;
                document.getElementById('totalValue').textContent = `$${(statsData.totalValue || 0).toFixed(2)}`;
                document.getElementById('tokenCount').textContent = statsData.tokens || 0;
                document.getElementById('circuitBreakerCount').textContent = statsData.sellCircuitBreaker || 0;
                renderPortfolio(portfolio);
            } catch (err) {
                console.error('Load error:', err);
            }
        }

        // LOAD CONFIG
        async function loadConfig() {
            try {
                const res = await fetch(`${API}/api/config`);
                configData = await res.json();
                updateConfigUI();
            } catch (err) {
                console.error('Config load error:', err);
            }
        }

        // UPDATE CONFIG UI
        function updateConfigUI() {
            document.getElementById('toggle-tp').classList.toggle('active', configData.takeProfitEnabled);
            document.getElementById('toggle-be').classList.toggle('active', configData.breakEvenEnabled);
            document.getElementById('toggle-sl').classList.toggle('active', configData.stopLossEnabled);
            document.getElementById('toggle-ts').classList.toggle('active', configData.trailingEnabled);
            document.getElementById('toggle-ar').classList.toggle('active', configData.antiRugEnabled);
            document.getElementById('toggle-le').classList.toggle('active', configData.liqExitEnabled);
            document.getElementById('toggle-tt').classList.toggle('active', configData.timeStopEnabled);
            document.getElementById('toggle-me').classList.toggle('active', configData.momentumEnabled);
            document.getElementById('toggle-jito').classList.toggle('active', configData.jitoEnabled);
            document.getElementById('toggle-pyramid').classList.toggle('active', configData.pyramidEnabled);
            document.getElementById('toggle-dcad').classList.toggle('active', configData.dcadEnabled);
            document.getElementById('toggle-reentry').classList.toggle('active', configData.reentryEnabled);
            document.getElementById('toggle-smartsize').classList.toggle('active', configData.smartSizeEnabled);
            document.getElementById('tpHysteresis').value = configData.hysteresis || 5;
            document.getElementById('beBuffer').value = configData.breakEvenBuffer || 2;
            document.getElementById('slPct').value = configData.stopLossPct || -50;
            document.getElementById('tsPct').value = configData.trailingPct || 20;
            document.getElementById('tsVol').value = configData.trailingVol ? 'true' : 'false';
            document.getElementById('arPct').value = configData.antiRugPct || 60;
            document.getElementById('lePct').value = configData.liqExitPct || 70;
            document.getElementById('ttHours').value = configData.timeStopHours || 24;
            document.getElementById('ttMinPnl').value = configData.timeStopMinPnl || 0;
            document.getElementById('meThreshold').value = configData.momentumThreshold || -3;
            document.getElementById('jitoTip').value = configData.jitoTipSol || 0.0001;
            document.getElementById('pyramidMaxSol').value = configData.pyramidMaxSol || 0.5;
            document.getElementById('pyramidHysteresis').value = configData.pyramidHysteresis || 5;
            document.getElementById('dcadMaxAdds').value = configData.dcadMaxAdds || 2;
            document.getElementById('dcadRequireMomentum').value = configData.dcadRequireMomentum ? 'true' : 'false';
            document.getElementById('reentryDelayMin').value = configData.reentryDelayMin || 30;
            document.getElementById('reentryMinGain').value = configData.reentryMinGain || 15;
            document.getElementById('reentryMinScore').value = configData.reentryMinScore || 60;
            document.getElementById('smartSizeBase').value = configData.smartSizeBase || 0.05;
            document.getElementById('smartSizeMult').value = configData.smartSizeMult || 2.0;
            document.getElementById('smartSizeMin').value = configData.smartSizeMin || 0.02;
            document.getElementById('smartSizeMax').value = configData.smartSizeMax || 0.5;
            document.getElementById('defaultSlippage').value = configData.defaultSlippage || 500;
            document.getElementById('minSolReserve').value = configData.minSolReserve || 0.05;
            document.getElementById('intervalSec').value = configData.intervalSec || 30;
            document.getElementById('maxPositions').value = configData.maxPositions || 10;
            document.getElementById('minScore').value = configData.minScore || 0;
        }

        // RENDER PORTFOLIO
        function renderPortfolio(tokens) {
            const list = document.getElementById('tokenList');
            if (tokens.length === 0) {
                list.innerHTML = `
                    <div class="empty">
                        <div class="empty-icon">💎</div>
                        <div>Aucun token dans le portfolio</div>
                        <button class="btn btn-primary" onclick="openBuyModal()" style="margin-top: 16px; min-height: 44px;">
                            + Acheter un token
                        </button>
                    </div>
                `;
                return;
            }
            list.innerHTML = tokens.map(token => {
                const pnlClass = token.pnl >= 0 ? 'pos' : 'neg';
                const pnlSign = token.pnl >= 0 ? '+' : '';
                const logo = token.logo 
                    ? `<img src="${token.logo}" onerror="this.parentElement.innerHTML='🪙'" style="width:100%;height:100%;border-radius:10px;object-fit:cover;">`
                    : '🪙';
                const badges = [];
                if (token.bootstrapped) badges.push('<span class="badge badge-warning">BOOT</span>');
                if (token.stopLossHit) badges.push('<span class="badge badge-danger">SL</span>');
                if (token.breakEven) badges.push('<span class="badge badge-info">BE</span>');
                return `
                    <div class="token-card" onclick="openTokenDetail('${token.mintFull}')">
                        <div class="token-header">
                            <div class="token-info">
                                <div class="token-logo">${logo}</div>
                                <div class="token-details">
                                    <div class="token-symbol">${token.symbol || token.mint.slice(0, 8)}... ${badges.join(' ')}</div>
                                    <div class="token-address">${token.mint.slice(0, 4)}...${token.mint.slice(-4)}</div>
                                </div>
                            </div>
                            <div class="token-price">
                                <div class="price-value">$${(token.price || 0).toFixed(6)}</div>
                                <div class="price-change ${pnlClass}">${pnlSign}${(token.pnl || 0).toFixed(2)}%</div>
                            </div>
                        </div>
                        <div class="token-stats">
                            <div class="token-stat">
                                <div class="token-stat-label">Valeur</div>
                                <div class="token-stat-value">$${(token.value || 0).toFixed(2)}</div>
                            </div>
                            <div class="token-stat">
                                <div class="token-stat-label">Balance</div>
                                <div class="token-stat-value">${(token.balance || 0).toFixed(4)}</div>
                            </div>
                            <div class="token-stat">
                                <div class="token-stat-label">Liq.</div>
                                <div class="token-stat-value">$${((token.liquidity || 0) / 1000).toFixed(1)}k</div>
                            </div>
                        </div>
                        <div class="token-actions">
                            <button class="btn btn-buy" onclick="event.stopPropagation(); openBuyModal('${token.mintFull}')">Buy</button>
                            <button class="btn btn-sell" onclick="event.stopPropagation(); openSellModal('${token.mintFull}', '${token.symbol || token.mint.slice(0,8)}', ${token.balance})">Sell</button>
                            <button class="btn btn-chart" onclick="event.stopPropagation(); openTokenDetail('${token.mintFull}')">📊</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // TAB SWITCHING
        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
            document.querySelectorAll('.section').forEach(section => section.classList.remove('active'));
            event.currentTarget.classList.add('active');
            document.getElementById(tabName).classList.add('active');
            if (tabName === 'analytics') { loadAnalytics(); }
            if (tabName === 'autobuys') { loadAutoBuys(); }
            if (tabName === 'reentry') { loadReentry(); }
            if (tabName === 'dead') { loadDeadTokens(); }
        }

        // CONFIG TOGGLES
        function toggleConfig(key) {
            const toggle = document.getElementById(`toggle-${key}`);
            if (toggle) toggle.classList.toggle('active');
        }

        async function saveConfig() {
            try {
                const config = {
                    takeProfitEnabled: document.getElementById('toggle-tp').classList.contains('active'),
                    breakEvenEnabled: document.getElementById('toggle-be').classList.contains('active'),
                    stopLossEnabled: document.getElementById('toggle-sl').classList.contains('active'),
                    trailingEnabled: document.getElementById('toggle-ts').classList.contains('active'),
                    trailingVol: document.getElementById('tsVol').value === 'true',
                    antiRugEnabled: document.getElementById('toggle-ar').classList.contains('active'),
                    liqExitEnabled: document.getElementById('toggle-le').classList.contains('active'),
                    timeStopEnabled: document.getElementById('toggle-tt').classList.contains('active'),
                    momentumEnabled: document.getElementById('toggle-me').classList.contains('active'),
                    jitoEnabled: document.getElementById('toggle-jito').classList.contains('active'),
                    pyramidEnabled: document.getElementById('toggle-pyramid').classList.contains('active'),
                    dcadEnabled: document.getElementById('toggle-dcad').classList.contains('active'),
                    reentryEnabled: document.getElementById('toggle-reentry').classList.contains('active'),
                    smartSizeEnabled: document.getElementById('toggle-smartsize').classList.contains('active'),
                    hysteresis: parseFloat(document.getElementById('tpHysteresis').value),
                    breakEvenBuffer: parseFloat(document.getElementById('beBuffer').value),
                    stopLossPct: parseFloat(document.getElementById('slPct').value),
                    trailingPct: parseFloat(document.getElementById('tsPct').value),
                    antiRugPct: parseFloat(document.getElementById('arPct').value),
                    liqExitPct: parseFloat(document.getElementById('lePct').value),
                    timeStopHours: parseFloat(document.getElementById('ttHours').value),
                    timeStopMinPnl: parseFloat(document.getElementById('ttMinPnl').value),
                    momentumThreshold: parseFloat(document.getElementById('meThreshold').value),
                    jitoTipSol: parseFloat(document.getElementById('jitoTip').value),
                    pyramidMaxSol: parseFloat(document.getElementById('pyramidMaxSol').value),
                    pyramidHysteresis: parseFloat(document.getElementById('pyramidHysteresis').value),
                    dcadMaxAdds: parseInt(document.getElementById('dcadMaxAdds').value),
                    dcadRequireMomentum: document.getElementById('dcadRequireMomentum').value === 'true',
                    reentryDelayMin: parseFloat(document.getElementById('reentryDelayMin').value),
                    reentryMinGain: parseFloat(document.getElementById('reentryMinGain').value),
                    reentryMinScore: parseFloat(document.getElementById('reentryMinScore').value),
                    smartSizeBase: parseFloat(document.getElementById('smartSizeBase').value),
                    smartSizeMult: parseFloat(document.getElementById('smartSizeMult').value),
                    smartSizeMin: parseFloat(document.getElementById('smartSizeMin').value),
                    smartSizeMax: parseFloat(document.getElementById('smartSizeMax').value),
                    defaultSlippage: parseInt(document.getElementById('defaultSlippage').value),
                    minSolReserve: parseFloat(document.getElementById('minSolReserve').value),
                    intervalSec: parseInt(document.getElementById('intervalSec').value),
                    maxPositions: parseInt(document.getElementById('maxPositions').value),
                    minScore: parseFloat(document.getElementById('minScore').value),
                };
                const res = await fetch(`${API}/api/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config),
                });
                if (res.ok) {
                    showToast('✅ Configuration sauvegardée', 'success');
                    loadConfig();
                } else {
                    showToast('❌ Erreur lors de la sauvegarde', 'error');
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            }
        }

        // LOAD ANALYTICS
        async function loadAnalytics() {
            try {
                const [analyticsRes, tradesRes] = await Promise.all([
                    fetch(`${API}/api/analytics`),
                    fetch(`${API}/api/trades`)
                ]);
                const analytics = await analyticsRes.json();
                const trades = await tradesRes.json();
                document.getElementById('realizedPnl').textContent = `${analytics.realizedPnlSol || 0} ◎`;
                document.getElementById('analyticsWinRate').textContent = `${analytics.winRate || 0}%`;
                document.getElementById('totalTrades').textContent = analytics.totalTrades || 0;
                document.getElementById('roi').textContent = `${analytics.roi || 0}%`;
                document.getElementById('sharpe').textContent = analytics.sharpeRatio || '—';
                document.getElementById('sortino').textContent = analytics.sortinoRatio || '—';
                document.getElementById('maxDrawdown').textContent = analytics.maxDrawdownSol ? `-${analytics.maxDrawdownSol}` : '—';
                document.getElementById('profitFactor').textContent = analytics.profitFactor || '—';
                document.getElementById('winStreak').textContent = analytics.winStreak || 0;
                document.getElementById('maxWinStreak').textContent = analytics.maxWinStreak || 0;
                document.getElementById('lossStreak').textContent = analytics.lossStreak || 0;
                document.getElementById('maxLossStreak').textContent = analytics.maxLossStreak || 0;
                const recentTrades = trades.trades?.slice(0, 10) || [];
                const container = document.getElementById('recentTrades');
                if (recentTrades.length === 0) {
                    container.innerHTML = `
                        <div class="empty">
                            <div class="empty-icon">📊</div>
                            <div>Aucun trade récent</div>
                        </div>
                    `;
                    return;
                }
                container.innerHTML = recentTrades.map(trade => {
                    const pnlClass = trade.pnlPct >= 0 ? 'pos' : 'neg';
                    const pnlSign = trade.pnlPct >= 0 ? '+' : '';
                    const date = new Date(trade.ts).toLocaleString('fr-FR');
                    return `
                        <div style="padding: 10px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="font-weight: 600; font-size: 13px;">${trade.symbol || trade.mint?.slice(0,8)}</div>
                                <div style="font-size: 10px; color: var(--text-muted);">${trade.type.toUpperCase()} • ${date}</div>
                            </div>
                            <div class="${pnlClass}" style="font-weight: 600; font-family: 'JetBrains Mono', monospace;">
                                ${pnlSign}${(trade.pnlPct || 0).toFixed(2)}%
                            </div>
                        </div>
                    `;
                }).join('');
                updatePnlChart(analytics.pnlHistory || []);
            } catch (err) {
                console.error('Analytics load error:', err);
            }
        }

        // UPDATE PNL CHART
        function updatePnlChart(pnlHistory) {
            const ctx = document.getElementById('pnlChart').getContext('2d');
            if (pnlChart) { pnlChart.destroy(); }
            const labels = pnlHistory.slice(-30).map((_, i) => i + 1);
            const data = pnlHistory.slice(-30).map(p => p.cumul);
            pnlChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'PnL Cumulé (SOL)',
                        data: data,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { display: false },
                        y: {
                            grid: { color: 'rgba(42, 53, 80, 0.5)' },
                            ticks: { color: '#6b7a99', font: { family: 'JetBrains Mono', size: 10 } }
                        }
                    },
                    interaction: { intersect: false, mode: 'index' }
                }
            });
        }

        // LOAD AUTO-BUYS
        async function loadAutoBuys() {
            try {
                const res = await fetch(`${API}/api/auto-buys`);
                const data = await res.json();
                const container = document.getElementById('autoBuysContent');
                if (!data.positions || data.positions.length === 0) {
                    container.innerHTML = `
                        <div class="empty">
                            <div class="empty-icon">📈</div>
                            <div>Aucune position avec auto-buy</div>
                        </div>
                    `;
                    return;
                }
                container.innerHTML = data.positions.map(pos => {
                    const pnlClass = pos.pnl >= 0 ? 'pos' : 'neg';
                    const pnlSign = pos.pnl >= 0 ? '+' : '';
                    let pyramidHtml = '';
                    if (data.pyramidEnabled && pos.pyramidTiers) {
                        pyramidHtml = `<div style="margin-top: 8px; font-size: 11px;"><strong>Pyramid:</strong> ${pos.pyramidTiers.map(t => 
                            `<span class="${t.triggered ? 'tier-triggered' : t.willTrigger ? 'tier-will-trigger' : 'tier-pending'}">T${t.idx+1}: ${t.pnl}% (${t.addSol} SOL)</span>`
                        ).join(' | ')}</div>`;
                    }
                    let dcadHtml = '';
                    if (data.dcadEnabled && pos.dcadTiers) {
                        dcadHtml = `<div style="margin-top: 4px; font-size: 11px;"><strong>DCA-Down:</strong> ${pos.dcadTiers.map(t => 
                            `<span class="${t.triggered ? 'tier-triggered' : t.willTrigger ? 'tier-will-trigger' : 'tier-pending'}">T${t.idx+1}: ${t.pnl}% (${t.addSol} SOL)</span>`
                        ).join(' | ')}</div>`;
                    }
                    return `
                        <div class="config-section" style="margin-bottom: 10px;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div style="font-weight: 600;">${pos.symbol} (${pos.mint.slice(0,8)}...)</div>
                                <div class="${pnlClass}" style="font-family: 'JetBrains Mono', monospace;">${pnlSign}${pos.pnl}%</div>
                            </div>
                            ${pyramidHtml}
                            ${dcadHtml}
                            <div style="margin-top: 8px; font-size: 10px; color: var(--text-muted);">
                                Pyramid: ${pos.addedSol?.toFixed(4) || 0}/${data.pyramidMaxSol} SOL | DCA: ${pos.dcadDone || 0}/${data.dcadMaxAdds} adds
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (err) {
                console.error('Auto-buys load error:', err);
            }
        }

        // LOAD RE-ENTRY
        async function loadReentry() {
            try {
                const res = await fetch(`${API}/api/reentry`);
                const data = await res.json();
                const container = document.getElementById('reentryContent');
                if (!data.stoppedTokens || data.stoppedTokens.length === 0) {
                    container.innerHTML = `
                        <div class="empty">
                            <div class="empty-icon">🔄</div>
                            <div>Aucun token éligible au re-entry</div>
                        </div>
                    `;
                    return;
                }
                container.innerHTML = data.stoppedTokens.map(token => {
                    const eligibleClass = token.eligible ? 'pos' : 'neg';
                    const delayClass = token.delayDone ? 'pos' : 'warning';
                    return `
                        <div class="config-section" style="margin-bottom: 10px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <div style="font-weight: 600;">${token.symbol}</div>
                                <span class="badge ${token.eligible ? 'badge-success' : 'badge-danger'}">${token.eligible ? 'ÉLIGIBLE' : 'NON'}</span>
                            </div>
                            <div style="font-size: 11px; color: var(--text-muted);">
                                <div>Exit: ${token.exitPrice?.toFixed(6) || '—'} → Current: ${token.currentPrice?.toFixed(6) || '—'}</div>
                                <div>Rebond: <span class="${token.reboundPct >= data.reentryMinGain ? 'pos' : 'neg'}">+${token.reboundPct || 0}%</span> (min: +${data.reentryMinGain}%)</div>
                                <div>Délai: <span class="${token.delayDone ? 'pos' : 'warning'}">${token.delayDone ? 'OK' : token.delayRemainMin + 'min'}</span></div>
                                <div>Score: <span class="${token.scoreOk ? 'pos' : 'neg'}">${token.score || 0}/100</span> (min: ${data.reentryMinScore})</div>
                            </div>
                            ${token.eligible ? `<button class="btn btn-secondary btn-sm" onclick="clearReentry('${token.mint}')" style="margin-top: 8px; width: 100%;">Annuler Re-Entry</button>` : ''}
                        </div>
                    `;
                }).join('');
            } catch (err) {
                console.error('Re-entry load error:', err);
            }
        }

        // LOAD DEAD TOKENS
        async function loadDeadTokens() {
            try {
                const res = await fetch(`${API}/api/dead-tokens`);
                const data = await res.json();
                const container = document.getElementById('deadTokensContent');
                if (!data.deadTokens || data.deadTokens.length === 0) {
                    container.innerHTML = `
                        <div class="empty">
                            <div class="empty-icon">✅</div>
                            <div>Aucun token mort</div>
                        </div>
                    `;
                    return;
                }
                container.innerHTML = `
                    <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 10px;">
                        ${data.alive} alive | ${data.dead} dead | Neg-cache: ${data.negCacheSize}
                    </div>
                ` + data.deadTokens.map(token => `
                    <div class="config-section" style="margin-bottom: 10px;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="font-weight: 600;">${token.symbol}</div>
                                <div style="font-size: 10px; color: var(--text-muted);">${token.mint.slice(0,8)}...</div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 12px;">$${token.value?.toFixed(2) || '0.00'}</div>
                                <div style="font-size: 10px; color: var(--danger);">${token.failures || 0} échecs</div>
                            </div>
                        </div>
                        <button class="btn btn-danger btn-sm" onclick="purgeDeadToken('${token.mint}')" style="margin-top: 8px; width: 100%;">
                            🗑 Purge
                        </button>
                    </div>
                `).join('');
            } catch (err) {
                console.error('Dead tokens load error:', err);
            }
        }

        // PURGE DEAD TOKENS
        async function purgeDeadTokens() {
            if (!confirm('Purger TOUS les tokens morts ?')) return;
            try {
                const res = await fetch(`${API}/api/dead-tokens/purge`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ all: true }),
                });
                const result = await res.json();
                if (result.success) {
                    showToast(`✅ ${result.purged} tokens purgés`, 'success');
                    loadDeadTokens();
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            }
        }

        async function purgeDeadToken(mint) {
            try {
                const res = await fetch(`${API}/api/dead-tokens/purge`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mints: [mint] }),
                });
                const result = await res.json();
                if (result.success) {
                    showToast(`✅ Token purgé`, 'success');
                    loadDeadTokens();
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            }
        }

        async function resetNegCache() {
            try {
                const res = await fetch(`${API}/api/neg-cache/reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ all: true }),
                });
                const result = await res.json();
                if (result.success) {
                    showToast(`✅ Cache reset (${result.cleared} tokens)`, 'success');
                    loadDeadTokens();
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            }
        }

        async function resetCircuitBreaker() {
            try {
                const res = await fetch(`${API}/api/reset-circuit-breaker`, { method: 'POST' });
                const result = await res.json();
                if (result.success) {
                    showToast('✅ Circuit-breaker reset', 'success');
                    loadData();
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            }
        }

        async function clearReentry(mint) {
            try {
                const res = await fetch(`${API}/api/reentry/clear`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mint }),
                });
                const result = await res.json();
                if (result.success) {
                    showToast('✅ Re-entry annulé', 'success');
                    loadReentry();
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            }
        }

        // BUY MODAL
        function openBuyModal(mint = '') {
            document.getElementById('buyTokenAddress').value = mint;
            document.getElementById('buyAmount').value = '';
            document.getElementById('buyModal').classList.add('active');
        }
        function closeBuyModal() { document.getElementById('buyModal').classList.remove('active'); }
        function setBuyAmount(amount) { document.getElementById('buyAmount').value = amount; }
        async function setMaxBuy() {
            if (solBalance > 0) {
                const max = Math.max(0, solBalance - 0.05);
                document.getElementById('buyAmount').value = max.toFixed(4);
            }
        }
        async function executeBuy() {
            const mint = document.getElementById('buyTokenAddress').value.trim();
            const amount = parseFloat(document.getElementById('buyAmount').value);
            const slippage = parseInt(document.getElementById('buySlippage').value);
            const useSmartSize = document.getElementById('buySmartSize').value === 'true';
            if (!mint || (!amount && !useSmartSize)) { showToast('❌ Veuillez remplir tous les champs', 'error'); return; }
            const btn = event.currentTarget;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:20px;height:20px;margin-right:8px;display:inline-block"></div> En cours...';
            try {
                const res = await fetch(`${API}/api/buy`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mint, solAmount: amount, slippageBps: slippage, useSmartSize }),
                });
                const result = await res.json();
                if (result.success) {
                    showToast(`✅ Achat réussi ! ${result.outAmount?.toFixed(4)} tokens`, 'success');
                    closeBuyModal();
                    setTimeout(() => loadData(), 3000);
                } else {
                    showToast('❌ ' + result.error, 'error');
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalText;
            }
        }

        // SELL MODAL
        function openSellModal(mint, symbol, balance) {
            document.getElementById('sellTokenInfo').value = `${symbol} (${mint.slice(0, 4)}...${mint.slice(-4)})`;
            document.getElementById('sellBalance').value = balance.toFixed(4);
            document.getElementById('sellModal').dataset.mint = mint;
            document.getElementById('sellModal').classList.add('active');
        }
        function closeSellModal() { document.getElementById('sellModal').classList.remove('active'); }
        function setSellPercent(percent) {
            const balance = parseFloat(document.getElementById('sellBalance').value);
            document.getElementById('sellAmount').value = (balance * percent / 100).toFixed(4);
        }
        async function executeSell() {
            const mint = document.getElementById('sellModal').dataset.mint;
            const amount = parseFloat(document.getElementById('sellAmount').value);
            const slippage = parseInt(document.getElementById('sellSlippage').value);
            const useJito = document.getElementById('sellJito').value === 'true';
            if (!mint || !amount) { showToast('❌ Veuillez entrer un montant valide', 'error'); return; }
            const btn = event.currentTarget;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:20px;height:20px;margin-right:8px;display:inline-block"></div> En cours...';
            try {
                const res = await fetch(`${API}/api/sell`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mint, amount, slippageBps: slippage, useJito, reason: 'MANUAL' }),
                });
                const result = await res.json();
                if (result.success) {
                    showToast(`✅ Vente réussie ! ${result.solOut?.toFixed(6)} SOL reçus`, 'success');
                    closeSellModal();
                    setTimeout(() => loadData(), 3000);
                } else {
                    showToast('❌ ' + result.error, 'error');
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalText;
            }
        }

        // TOKEN DETAIL MODAL
        async function openTokenDetail(mint) {
            currentDetailMint = mint;
            const token = portfolio.find(t => t.mintFull === mint);
            if (!token) return;
            document.getElementById('tokenDetailTitle').textContent = `${token.symbol || mint.slice(0,8)}...`;
            document.getElementById('detailValue').textContent = `$${(token.value || 0).toFixed(2)}`;
            document.getElementById('detailLiq').textContent = `$${((token.liquidity || 0) / 1000).toFixed(1)}k`;
            document.getElementById('detailMcap').textContent = `$${(token.mcap || 0).toLocaleString()}`;
            document.getElementById('detailVol24h').textContent = `$${(token.volume24h || 0).toLocaleString()}`;
            document.getElementById('detailScore').textContent = `${token.score || 0}/100`;
            document.getElementById('detailEntry').textContent = `$${(token.entryPrice || 0).toFixed(6)}`;
            document.getElementById('detailPeak').textContent = `+${(token.peakPnl || 0).toFixed(2)}%`;
            document.getElementById('detailLiqDrop').textContent = `${(token.liqDrop || 0).toFixed(1)}%`;
            // Load auto-buy status
            try {
                const res = await fetch(`${API}/api/auto-buys`);
                const data = await res.json();
                const pos = data.positions.find(p => p.mint === mint);
                if (pos) {
                    // Pyramid
                    const pyramidContainer = document.getElementById('pyramidTiers');
                    if (data.pyramidEnabled && pos.pyramidTiers) {
                        pyramidContainer.innerHTML = pos.pyramidTiers.map(t => `
                            <div class="auto-buy-tier">
                                <span class="${t.triggered ? 'tier-triggered' : t.willTrigger ? 'tier-will-trigger' : 'tier-pending'}">
                                    T${t.idx+1}: ${t.pnl}%
                                </span>
                                <span>${t.addSol} SOL ${t.triggered ? '✅' : t.willTrigger ? '⏳' : '⏸'}</span>
                            </div>
                        `).join('');
                        document.getElementById('pyramidBudget').textContent = `${pos.pyramidBudgetLeft?.toFixed(4) || 0} SOL`;
                    } else {
                        pyramidContainer.innerHTML = '<div style="font-size: 11px; color: var(--text-muted);">Pyramid OFF</div>';
                    }
                    // DCA-Down
                    const dcadContainer = document.getElementById('dcadTiers');
                    if (data.dcadEnabled && pos.dcadTiers) {
                        dcadContainer.innerHTML = pos.dcadTiers.map(t => `
                            <div class="auto-buy-tier">
                                <span class="${t.triggered ? 'tier-triggered' : t.willTrigger ? 'tier-will-trigger' : 'tier-pending'}">
                                    T${t.idx+1}: ${t.pnl}%
                                </span>
                                <span>${t.addSol} SOL ${t.triggered ? '✅' : t.willTrigger ? '⏳' : '⏸'}</span>
                            </div>
                        `).join('');
                        document.getElementById('dcadAddsLeft').textContent = pos.dcadAddsLeft || 0;
                    } else {
                        dcadContainer.innerHTML = '<div style="font-size: 11px; color: var(--text-muted);">DCA-Down OFF</div>';
                    }
                }
            } catch (err) { console.error('Auto-buy status error:', err); }
            document.getElementById('tokenDetailModal').classList.add('active');
        }
        function closeTokenDetailModal() { document.getElementById('tokenDetailModal').classList.remove('active'); currentDetailMint = null; }
        function openDexScreener() {
            if (currentDetailMint) window.open(`https://dexscreener.com/solana/${currentDetailMint}`, '_blank');
        }
        async function scanHistory() {
            if (!currentDetailMint) return;
            try {
                const res = await fetch(`${API}/api/positions/scan-history`);
                const result = await res.json();
                if (result.fixed > 0) {
                    showToast(`✅ ${result.fixed} positions corrigées`, 'success');
                    loadData();
                } else {
                    showToast('ℹ️ Aucune position à corriger', 'info');
                }
            } catch (err) {
                showToast('❌ ' + err.message, 'error');
            }
        }
        function openBuyFromDetail() {
            closeTokenDetailModal();
            if (currentDetailMint) openBuyModal(currentDetailMint);
        }
        function openSellFromDetail() {
            closeTokenDetailModal();
            if (currentDetailMint) {
                const token = portfolio.find(t => t.mintFull === currentDetailMint);
                if (token) openSellModal(token.mintFull, token.symbol || token.mint.slice(0,8), token.balance);
            }
        }

        // TOAST
        function showToast(message, type = 'info') {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.style.borderColor = type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--border)';
            toast.textContent = message;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.animation = 'slideIn 0.3s ease reverse';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }

        // CLOSE MODALS ON OUTSIDE CLICK
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        });
    </script>
</body>
</html>
