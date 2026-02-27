// Configuration
const API_BASE = window.location.origin;
const REFRESH_INTERVAL = 10000; // 10 secondes
let autoRefresh = true;
let lastData = null;

// Format helpers
function formatAddress(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function formatNumber(num, decimals = 2) {
  return parseFloat(num).toFixed(decimals);
}

function formatCurrency(num) {
  return '$' + formatNumber(num, 2);
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('fr-FR');
}

// Copy to clipboard
function copyWallet() {
  const addr = document.getElementById('walletAddress').textContent;
  navigator.clipboard.writeText(addr).then(() => {
    alert('Adresse copiée: ' + addr);
  });
}

// Fetch data from API
async function fetchData() {
  try {
    const [statsRes, portfolioRes, tpRes] = await Promise.all([
      fetch(`${API_BASE}/api/stats`),
      fetch(`${API_BASE}/api/portfolio`),
      fetch(`${API_BASE}/api/take-profit`)
    ]);

    const stats = await statsRes.json();
    const portfolio = await portfolioRes.json();
    const tp = await tpRes.json();

    lastData = { stats, portfolio, tp };
    updateUI(stats, portfolio, tp);
    updateLastUpdate();
    
  } catch (err) {
    console.error('Fetch error:', err);
    document.getElementById('statusBadge').innerHTML = `
      <span class="status-dot" style="background: #ef4444;"></span>
      <span class="status-text">Hors ligne</span>
    `;
  }
}

// Update UI
function updateUI(stats, portfolio, tp) {
  // Stats
  document.getElementById('totalValue').textContent = formatCurrency(stats.totalValue || 0);
  document.getElementById('tokenCount').textContent = stats.tokens || 0;
  document.getElementById('uptime').textContent = formatUptime(stats.uptime || 0);
  document.getElementById('walletAddress').textContent = formatAddress(portfolio.address || '9Xpa...qTsX');
  
  // Take-Profit triggered count
  const triggeredCount = tp.entries?.reduce((sum, e) => sum + e.triggeredTiers.length, 0) || 0;
  document.getElementById('tpTriggered').textContent = triggeredCount;

  // Tokens list
  const tokensList = document.getElementById('tokensList');
  if (portfolio.tokens && portfolio.tokens.length > 0) {
    tokensList.innerHTML = portfolio.tokens.map(token => `
      <div class="token-card">
        <div class="token-info">
          <div>
            <div class="token-symbol">${token.mint}</div>
            <div class="token-mint">${formatAddress(token.mintFull)}</div>
          </div>
        </div>
        <div class="token-stats">
          <div class="token-stat">
            <div class="token-stat-label">Balance</div>
            <div class="token-stat-value">${formatNumber(token.balance, 4)}</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">Prix</div>
            <div class="token-stat-value">${token.price ? formatCurrency(token.price) : 'N/A'}</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">Valeur</div>
            <div class="token-stat-value">${formatCurrency(token.value)}</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">PnL</div>
            <div class="token-stat-value ${token.pnl >= 0 ? 'positive' : 'negative'}">
              ${token.pnl !== null ? (token.pnl >= 0 ? '+' : '') + formatNumber(token.pnl, 2) + '%' : 'N/A'}
            </div>
          </div>
        </div>
      </div>
    `).join('');
  } else {
    tokensList.innerHTML = '<div class="loading">Aucun token détecté</div>';
  }

  // Take-Profit list
  const tpList = document.getElementById('tpList');
  if (tp.entries && tp.entries.length > 0) {
    tpList.innerHTML = tp.entries.map(entry => `
      <div class="tp-card">
        <div class="tp-header">
          <div class="tp-mint">${entry.mint}</div>
          <div class="tp-entry">Entry: ${formatCurrency(entry.entryPrice)}</div>
        </div>
        <div class="tp-tiers">
          ${tp.tiers.map((tier, i) => {
            const isTriggered = entry.triggeredTiers.includes(tier.pnl);
            return `
              <div class="tp-tier ${isTriggered ? 'triggered' : 'pending'}">
                ${tier.pnl} ${isTriggered ? '✅' : '⏳'}
              </div>
            `;
          }).join('')}
        </div>
        <div style="margin-top: 8px; font-size: 0.75rem; color: #64748b;">
          Vendu: ${formatNumber(entry.sold, 4)} / Restant: ${formatNumber(entry.remaining, 4)}
        </div>
      </div>
    `).join('');
  } else {
    tpList.innerHTML = '<div class="loading">Aucun take-profit actif</div>';
  }

  // Add sample logs (in real version, you'd fetch from a logs endpoint)
  updateLogs();
}

// Update logs (simulated - in production, you'd have a /api/logs endpoint)
function updateLogs() {
  const logsContainer = document.getElementById('logsContainer');
  const now = new Date();
  
  // Generate recent activity logs based on current data
  const logs = [
    { time: now, level: 'info', msg: 'Cycle terminé - 17 tokens analysés' },
    { time: new Date(now - 30000), level: 'info', msg: 'RPC OK - Slot 403155200' },
    { time: new Date(now - 60000), level: 'info', msg: 'Bot démarré avec succès' }
  ];

  logsContainer.innerHTML = logs.map(log => `
    <div class="log-entry">
      <span class="log-time">[${formatTime(log.time)}]</span>
      <span class="log-level-${log.level}">[${log.level.toUpperCase()}]</span>
      ${log.msg}
    </div>
  `).join('');
}

function updateLastUpdate() {
  document.getElementById('lastUpdate').textContent = formatTime(Date.now());
}

// Refresh data
function refreshData() {
  fetchData();
}

// Auto-refresh loop
setInterval(() => {
  if (autoRefresh) {
    fetchData();
  }
}, REFRESH_INTERVAL);

// Initial load
document.addEventListener('DOMContentLoaded', () => {
  fetchData();
});

// Visibility API - pause when tab is hidden
document.addEventListener('visibilitychange', () => {
  autoRefresh = !document.hidden;
  document.getElementById('autoRefreshStatus').textContent = autoRefresh ? 'ON' : 'OFF';
});
