/**
 * ShillBid Watchdog - Frontend Application
 * Tabbed UI for multiple auction house watchdogs
 */

// ============================================================================
// State Management
// ============================================================================

const state = {
  auctions: [],
  alerts: [],
  stats: {
    totalAuctions: 0,
    activeAlerts: 0,
    suspiciousBidders: 0
  },
  currentPlatform: 'bidfta',  // 'bidfta' | 'ebay'
  currentView: 'dashboard',
  loading: false
};

// Platform configurations
const PLATFORMS = {
  bidfta: {
    name: 'BidFTA',
    icon: '🏪',
    color: '#00a8cc',
    placeholder: 'https://www.bidfta.com/items?item=123456',
    active: true
  },
  ebay: {
    name: 'eBay',
    icon: '🛒',
    color: '#e53238',
    placeholder: 'https://www.ebay.com/itm/123456',
    active: false  // Not yet implemented
  }
};

// ============================================================================
// API Client
// ============================================================================

const api = {
  async get(endpoint) {
    const response = await fetch(`/api${endpoint}`);
    return response.json();
  },

  async post(endpoint, data) {
    const response = await fetch(`/api${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  }
};

// ============================================================================
// Components
// ============================================================================

function Header() {
  return `
    <header class="header">
      <div class="logo">
        <div class="logo-icon"></div>
        <span>ShillBid Watchdog</span>
      </div>
      <div class="header-actions">
        <div class="agent-status">
          <span class="agent-dot active"></span>
          <span>Agents Active</span>
        </div>
        <div class="alert-badge" onclick="showAlerts()">
          🔔
          <span class="count" id="alertCount">${state.stats.activeAlerts}</span>
        </div>
      </div>
    </header>
  `;
}

function PlatformTabs() {
  return `
    <div class="platform-tabs">
      ${Object.entries(PLATFORMS).map(([id, platform]) => `
        <button 
          class="platform-tab ${state.currentPlatform === id ? 'active' : ''} ${!platform.active ? 'disabled' : ''}"
          onclick="${platform.active ? `switchPlatform('${id}')` : ''}"
          ${!platform.active ? 'disabled' : ''}
          style="--platform-color: ${platform.color}"
        >
          <span class="platform-icon">${platform.icon}</span>
          <span class="platform-name">${platform.name} Watchdog</span>
          ${!platform.active ? '<span class="coming-soon">Coming Soon</span>' : ''}
        </button>
      `).join('')}
    </div>
  `;
}

function Sidebar() {
  const platform = PLATFORMS[state.currentPlatform];

  return `
    <aside class="sidebar">
      <div class="platform-badge" style="--platform-color: ${platform.color}">
        <span class="platform-icon">${platform.icon}</span>
        <span>${platform.name}</span>
      </div>

      <nav class="nav-section">
        <div class="nav-title">Navigation</div>
        <div class="nav-link ${state.currentView === 'dashboard' ? 'active' : ''}" onclick="navigate('dashboard')">
          📊 Dashboard
        </div>
        <div class="nav-link ${state.currentView === 'auctions' ? 'active' : ''}" onclick="navigate('auctions')">
          🎯 Auctions
        </div>
        <div class="nav-link ${state.currentView === 'alerts' ? 'active' : ''}" onclick="navigate('alerts')">
          ⚠️ Alerts
        </div>
        <div class="nav-link ${state.currentView === 'bidders' ? 'active' : ''}" onclick="navigate('bidders')">
          👤 Bidders
        </div>
      </nav>

      <div class="nav-section">
        <div class="nav-title">Quick Stats</div>
        <div class="stat-card">
          <div class="stat-label">Total Auctions</div>
          <div class="stat-value">${state.stats.totalAuctions}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Alerts</div>
          <div class="stat-value risk-critical">${state.stats.activeAlerts}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Suspicious Bidders</div>
          <div class="stat-value risk-high">${state.stats.suspiciousBidders}</div>
        </div>
      </div>

      <div class="nav-section rules-info">
        <div class="nav-title">Detection Rules</div>
        <div class="rule-list">
          <div class="rule-item">✓ Relist Stalker</div>
          <div class="rule-item">✓ Penny Sniper</div>
          <div class="rule-item">✓ Loss Leader</div>
          <div class="rule-item">✓ Bid Pairs</div>
        </div>
      </div>
    </aside>
  `;
}

function Dashboard() {
  const platform = PLATFORMS[state.currentPlatform];

  return `
    <div class="main">
      <h1 class="mb-lg">${platform.icon} ${platform.name} Dashboard</h1>
      
      <!-- Watch New Auction Form -->
      <div class="card mb-lg">
        <div class="card-header">
          <h2 class="card-title">🎯 Watch New Auction</h2>
        </div>
        <div class="card-body">
          <form id="watchForm" onsubmit="handleWatchAuction(event)">
            <div class="form-group">
              <label class="form-label">${platform.name} Auction URL</label>
              <input 
                type="url" 
                class="form-input" 
                id="auctionUrl"
                placeholder="${platform.placeholder}"
                required
              >
            </div>
            <button type="submit" class="btn btn-primary" style="--btn-color: ${platform.color}">
              🔍 Start Watching
            </button>
          </form>
        </div>
      </div>

      <!-- Stats Grid -->
      <div class="grid-4 mb-lg">
        ${StatsCard('Total Watched', state.stats.totalAuctions, 'none')}
        ${StatsCard('Active Alerts', state.stats.activeAlerts, 'critical')}
        ${StatsCard('Suspicious Bidders', state.stats.suspiciousBidders, 'high')}
        ${StatsCard('Analyzed Today', 0, 'low')}
      </div>

      <!-- Recent Alerts -->
      <div class="card mb-lg">
        <div class="card-header">
          <h2 class="card-title">⚠️ Recent Alerts</h2>
          <button class="btn btn-ghost" onclick="navigate('alerts')">View All</button>
        </div>
        <div class="card-body">
          ${state.alerts.length > 0
      ? state.alerts.slice(0, 5).map(AlertCard).join('')
      : EmptyState('No alerts yet', 'Start watching auctions to detect shill bidding')
    }
        </div>
      </div>

      <!-- Recent Auctions -->
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">🎯 Recent ${platform.name} Auctions</h2>
          <button class="btn btn-ghost" onclick="navigate('auctions')">View All</button>
        </div>
        <div class="card-body">
          ${state.auctions.length > 0
      ? AuctionsTable(state.auctions.slice(0, 5))
      : EmptyState('No auctions watched', `Add a ${platform.name} auction URL above to get started`)
    }
        </div>
      </div>
    </div>
  `;
}

function StatsCard(label, value, risk) {
  return `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value risk-${risk}">${value}</div>
    </div>
  `;
}

function AlertCard(alert) {
  const riskClass = `risk-${(alert.risk_level || 'none').toLowerCase()}`;
  const time = alert.created_at ? formatTime(alert.created_at) : 'Just now';

  return `
    <div class="alert-card ${riskClass}">
      <div class="alert-header">
        <div class="alert-title">
          <span class="risk-badge ${riskClass}">${alert.risk_level}</span>
          <span>${alert.item_name || `Auction ${alert.auction_code}`}</span>
        </div>
        <span class="alert-time">${time}</span>
      </div>
      <div class="alert-body">${alert.summary || 'Suspicious activity detected'}</div>
      ${alert.violations ? `
        <div class="alert-violations">
          ${JSON.parse(alert.violations || '[]').map(v => `<span class="violation-tag">${v}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function AuctionsTable(auctions) {
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Auction</th>
          <th>Lot Code</th>
          <th>Bids</th>
          <th>Risk</th>
          <th>Last Checked</th>
        </tr>
      </thead>
      <tbody>
        ${auctions.map(AuctionRow).join('')}
      </tbody>
    </table>
  `;
}

function AuctionRow(auction) {
  const riskClass = `risk-${(auction.risk_level || 'none').toLowerCase()}`;
  const time = auction.last_checked ? formatTime(auction.last_checked) : 'Pending';

  return `
    <tr>
      <td>
        <a href="${auction.url}" target="_blank" class="table-link">
          ${auction.item_name || auction.auction_id}
        </a>
      </td>
      <td class="text-mono">${auction.lot_code || '-'}</td>
      <td>${auction.bid_count || 0}</td>
      <td><span class="risk-badge ${riskClass}">${auction.risk_level || 'NONE'}</span></td>
      <td class="text-muted">${time}</td>
    </tr>
  `;
}

function EmptyState(title, subtitle) {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">📭</div>
      <div><strong>${title}</strong></div>
      <div class="text-muted">${subtitle}</div>
    </div>
  `;
}

function AuctionsView() {
  const platform = PLATFORMS[state.currentPlatform];

  return `
    <div class="main">
      <h1 class="mb-lg">${platform.icon} ${platform.name} Auctions</h1>
      <div class="card">
        <div class="card-body">
          ${state.auctions.length > 0
      ? AuctionsTable(state.auctions)
      : EmptyState('No auctions', `Watch a ${platform.name} auction to get started`)
    }
        </div>
      </div>
    </div>
  `;
}

function AlertsView() {
  const platform = PLATFORMS[state.currentPlatform];

  return `
    <div class="main">
      <h1 class="mb-lg">${platform.icon} ${platform.name} Alerts</h1>
      <div class="card">
        <div class="card-body">
          ${state.alerts.length > 0
      ? state.alerts.map(AlertCard).join('')
      : EmptyState('No alerts', 'Alerts will appear when suspicious activity is detected')
    }
        </div>
      </div>
    </div>
  `;
}

function EbayPlaceholder() {
  return `
    <div class="main">
      <div class="placeholder-content">
        <div class="placeholder-icon">🛒</div>
        <h1>eBay Watchdog</h1>
        <p class="text-muted">Coming Soon</p>
        <p>eBay integration is currently in development.</p>
        <p>Switch to BidFTA Watchdog to start monitoring auctions.</p>
      </div>
    </div>
  `;
}

// ============================================================================
// Event Handlers
// ============================================================================

async function handleWatchAuction(event) {
  event.preventDefault();

  const urlInput = document.getElementById('auctionUrl');
  const url = urlInput.value.trim();

  if (!url) return;

  // Validate URL matches platform
  const platform = state.currentPlatform;
  if (platform === 'bidfta' && !url.includes('bidfta.com')) {
    showToast('Please enter a valid BidFTA URL', 'error');
    return;
  }
  if (platform === 'ebay' && !url.includes('ebay.com')) {
    showToast('Please enter a valid eBay URL', 'error');
    return;
  }

  try {
    const result = await api.post('/auctions/watch', { url, source: platform });

    if (result.success) {
      urlInput.value = '';
      await loadData();
      showToast('Auction added! Agent is analyzing...', 'success');
    } else {
      showToast(result.error || 'Failed to add auction', 'error');
    }
  } catch (error) {
    showToast('Connection error', 'error');
  }
}

function navigate(view) {
  state.currentView = view;
  render();
}

function switchPlatform(platform) {
  if (PLATFORMS[platform]?.active) {
    state.currentPlatform = platform;
    state.currentView = 'dashboard';
    render();
    loadData();
  }
}

function showAlerts() {
  navigate('alerts');
}

// ============================================================================
// Data Loading
// ============================================================================

async function loadData() {
  state.loading = true;

  try {
    // Filter by platform
    const source = state.currentPlatform;

    const [auctionsRes, alertsRes, statsRes] = await Promise.all([
      api.get(`/auctions?source=${source}`),
      api.get(`/alerts?unacknowledged=true&source=${source}`),
      api.get(`/stats?source=${source}`)
    ]);

    if (auctionsRes.success) state.auctions = auctionsRes.data || [];
    if (alertsRes.success) state.alerts = alertsRes.data || [];
    if (statsRes.success) state.stats = statsRes.data || state.stats;

    const alertCountEl = document.getElementById('alertCount');
    if (alertCountEl) {
      alertCountEl.textContent = state.stats.activeAlerts;
    }
  } catch (error) {
    console.error('Failed to load data:', error);
  }

  state.loading = false;
  render();
}

// ============================================================================
// Utilities
// ============================================================================

function formatTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 24px;
    background: ${type === 'error' ? 'var(--risk-critical)' : 'var(--accent)'};
    color: white;
    border-radius: var(--radius-md);
    z-index: 9999;
    animation: slideIn 0.3s ease;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ============================================================================
// Render
// ============================================================================

function render() {
  const root = document.getElementById('root');

  let mainContent;

  // Check if platform is active
  if (!PLATFORMS[state.currentPlatform]?.active) {
    mainContent = EbayPlaceholder();
  } else {
    switch (state.currentView) {
      case 'auctions':
        mainContent = AuctionsView();
        break;
      case 'alerts':
        mainContent = AlertsView();
        break;
      default:
        mainContent = Dashboard();
    }
  }

  root.innerHTML = `
    <div class="app">
      ${Header()}
      ${PlatformTabs()}
      <div class="app-content">
        ${Sidebar()}
        ${mainContent}
      </div>
    </div>
  `;
}

// ============================================================================
// Initialize
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  render();
  loadData();

  // Auto-refresh every 30 seconds
  setInterval(loadData, 30000);
});
