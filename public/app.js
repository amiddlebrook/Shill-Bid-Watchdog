/**
 * ShillBid Watchdog - Professional Frontend
 * Clean, data-focused dashboard with activity logging
 */

// State
const state = {
  auctions: [],
  alerts: [],
  stats: { totalAuctions: 0, activeAlerts: 0, suspiciousBidders: 0 },
  logs: [],
  currentView: 'dashboard',
  lastUpdate: null,
  apiStatus: 'checking'
};

// Logging
function log(message, type = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('en-US', { hour12: false }),
    message,
    type
  };
  state.logs.unshift(entry);
  if (state.logs.length > 50) state.logs.pop();
  updateLogUI();
}

function updateLogUI() {
  const logContainer = document.getElementById('activityLog');
  if (!logContainer) return;

  logContainer.innerHTML = state.logs.slice(0, 10).map(e => `
        <div class="log-entry ${e.type}">
            <span class="log-time">${e.time}</span>
            <span class="log-message">${e.message}</span>
        </div>
    `).join('');
}

// API
async function api(endpoint, options = {}) {
  const url = `/api${endpoint}`;
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const data = await res.json();
    return data;
  } catch (error) {
    log(`API Error: ${error.message}`, 'error');
    throw error;
  }
}

// Health Check
async function checkHealth() {
  try {
    const res = await api('/health');
    if (res.success) {
      state.apiStatus = 'connected';
      log('Connected to ShillBid API', 'success');
    } else {
      state.apiStatus = 'error';
      log('API returned error', 'error');
    }
  } catch (e) {
    state.apiStatus = 'error';
    log('Failed to connect to API', 'error');
  }
  updateStatusIndicator();
}

function updateStatusIndicator() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (!dot || !text) return;

  dot.className = 'status-dot ' + (state.apiStatus === 'connected' ? '' : state.apiStatus === 'checking' ? 'pending' : 'error');
  text.textContent = state.apiStatus === 'connected' ? 'Connected' : state.apiStatus === 'checking' ? 'Connecting...' : 'Disconnected';
}

// Data Loading
async function loadData() {
  log('Fetching data...', 'info');

  try {
    const [auctionsRes, alertsRes, statsRes] = await Promise.all([
      api('/auctions'),
      api('/alerts?unacknowledged=true'),
      api('/stats')
    ]);

    if (auctionsRes.success) {
      state.auctions = auctionsRes.data || [];
      log(`Loaded ${state.auctions.length} auctions`, 'success');
    }
    if (alertsRes.success) {
      state.alerts = alertsRes.data || [];
      if (state.alerts.length > 0) {
        log(`${state.alerts.length} active alerts`, 'warning');
      }
    }
    if (statsRes.success) {
      state.stats = statsRes.data;
    }

    state.lastUpdate = new Date();
    render();
  } catch (error) {
    log('Failed to load data', 'error');
  }
}

// Watch Auction
async function watchAuction(url) {
  log(`Submitting: ${url}`, 'info');

  try {
    const res = await api('/auctions/watch', {
      method: 'POST',
      body: JSON.stringify({ url })
    });

    if (res.success) {
      log(`Added auction: ${res.data.auction_id}`, 'success');
      log('Navigator agent queued for extraction', 'info');
      await loadData();
      return true;
    } else {
      log(`Error: ${res.error}`, 'error');
      return false;
    }
  } catch (error) {
    log(`Failed to add auction`, 'error');
    return false;
  }
}

// Event Handlers
function handleSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('urlInput');
  const url = input.value.trim();
  if (url) {
    watchAuction(url);
    input.value = '';
  }
}

function navigate(view) {
  state.currentView = view;
  render();
}

// Components
function Header() {
  return `
        <header class="header">
            <div class="logo">
                <div class="logo-icon">W</div>
                <span>ShillBid Watchdog</span>
            </div>
            <div class="header-actions">
                <div class="status-indicator">
                    <div id="statusDot" class="status-dot pending"></div>
                    <span id="statusText">Connecting...</span>
                </div>
            </div>
        </header>
    `;
}

function Tabs() {
  return `
        <div class="platform-tabs">
            <button class="platform-tab active">BidFTA</button>
            <button class="platform-tab disabled">eBay <span class="coming-soon">Soon</span></button>
        </div>
    `;
}

function Sidebar() {
  return `
        <aside class="sidebar">
            <nav class="nav-section">
                <div class="nav-title">Navigation</div>
                <div class="nav-link ${state.currentView === 'dashboard' ? 'active' : ''}" onclick="navigate('dashboard')">
                    Dashboard
                </div>
                <div class="nav-link ${state.currentView === 'auctions' ? 'active' : ''}" onclick="navigate('auctions')">
                    Auctions
                </div>
                <div class="nav-link ${state.currentView === 'alerts' ? 'active' : ''}" onclick="navigate('alerts')">
                    Alerts
                </div>
            </nav>
            
            <div class="nav-section">
                <div class="nav-title">Statistics</div>
                <div class="sidebar-stats">
                    <div class="sidebar-stat">
                        <span class="sidebar-stat-label">Auctions</span>
                        <span class="sidebar-stat-value">${state.stats.totalAuctions}</span>
                    </div>
                    <div class="sidebar-stat">
                        <span class="sidebar-stat-label">Alerts</span>
                        <span class="sidebar-stat-value" style="color: var(--risk-critical)">${state.stats.activeAlerts}</span>
                    </div>
                    <div class="sidebar-stat">
                        <span class="sidebar-stat-label">Suspicious</span>
                        <span class="sidebar-stat-value" style="color: var(--risk-high)">${state.stats.suspiciousBidders}</span>
                    </div>
                </div>
            </div>
            
            <div class="nav-section">
                <div class="nav-title">Last Updated</div>
                <div class="text-sm text-muted" style="padding: 0 var(--space-2)">
                    ${state.lastUpdate ? state.lastUpdate.toLocaleTimeString() : 'Never'}
                </div>
            </div>
        </aside>
    `;
}

function Dashboard() {
  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">Dashboard</h1>
                <button class="btn btn-secondary" onclick="loadData()">Refresh</button>
            </div>
            
            <!-- Watch Form -->
            <div class="card mb-4">
                <div class="card-header">
                    <span class="card-title">Watch Auction</span>
                </div>
                <div class="card-body">
                    <form onsubmit="handleSubmit(event)">
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">BidFTA Auction URL</label>
                                <input type="url" id="urlInput" class="form-input" 
                                    placeholder="https://www.bidfta.com/569416/item-detail/50968437" required>
                            </div>
                            <button type="submit" class="btn btn-primary">Watch</button>
                        </div>
                    </form>
                </div>
            </div>
            
            <!-- Stats Grid -->
            <div class="grid-4">
                ${StatCard('Auctions', state.stats.totalAuctions)}
                ${StatCard('Alerts', state.stats.activeAlerts, 'critical')}
                ${StatCard('Suspicious', state.stats.suspiciousBidders, 'high')}
                ${StatCard('Analyzed', state.auctions.filter(a => a.last_checked).length)}
            </div>
            
            <!-- Activity Log -->
            <div class="card mb-4">
                <div class="card-header">
                    <span class="card-title">Activity Log</span>
                </div>
                <div class="card-body" style="padding: 0">
                    <div id="activityLog" class="activity-log">
                        ${state.logs.slice(0, 10).map(e => `
                            <div class="log-entry ${e.type}">
                                <span class="log-time">${e.time}</span>
                                <span class="log-message">${e.message}</span>
                            </div>
                        `).join('') || '<div class="empty-state">No activity yet</div>'}
                    </div>
                </div>
            </div>
            
            <!-- Recent Auctions -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Recent Auctions</span>
                    <button class="btn btn-sm btn-secondary" onclick="navigate('auctions')">View All</button>
                </div>
                <div class="card-body" style="padding: 0">
                    ${AuctionsTable(state.auctions.slice(0, 5))}
                </div>
            </div>
        </main>
    `;
}

function StatCard(label, value, risk = '') {
  const color = risk ? `style="color: var(--risk-${risk})"` : '';
  return `
        <div class="stat-card">
            <div class="stat-label">${label}</div>
            <div class="stat-value" ${color}>${value}</div>
        </div>
    `;
}

function AuctionsTable(auctions) {
  if (auctions.length === 0) {
    return '<div class="empty-state"><div class="empty-icon">📭</div><div>No auctions yet</div></div>';
  }

  return `
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th>Auction ID</th>
                        <th>Item</th>
                        <th>Status</th>
                        <th>Risk</th>
                        <th>Bids</th>
                        <th>Last Checked</th>
                    </tr>
                </thead>
                <tbody>
                    ${auctions.map(a => `
                        <tr>
                            <td><span class="text-mono">${a.auction_id || '-'}</span></td>
                            <td>
                                <a href="${a.url}" target="_blank" class="table-link">
                                    ${a.item_name || 'Pending extraction...'}
                                </a>
                            </td>
                            <td><span class="status-badge ${a.status}">${a.status}</span></td>
                            <td><span class="risk-badge risk-${(a.risk_level || 'none').toLowerCase()}">${a.risk_level || 'NONE'}</span></td>
                            <td>${a.bid_count || 0}</td>
                            <td class="text-muted">${a.last_checked ? formatTime(a.last_checked) : 'Pending'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function AuctionsView() {
  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">Auctions</h1>
                <button class="btn btn-secondary" onclick="loadData()">Refresh</button>
            </div>
            <div class="card">
                <div class="card-body" style="padding: 0">
                    ${AuctionsTable(state.auctions)}
                </div>
            </div>
        </main>
    `;
}

function AlertsView() {
  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">Alerts</h1>
                <button class="btn btn-secondary" onclick="loadData()">Refresh</button>
            </div>
            <div class="card">
                <div class="card-body" style="padding: 0">
                    ${state.alerts.length === 0
      ? '<div class="empty-state"><div class="empty-icon">✓</div><div>No active alerts</div></div>'
      : state.alerts.map(a => `
                            <div class="alert-item">
                                <div class="alert-indicator ${(a.risk_level || 'low').toLowerCase()}"></div>
                                <div class="alert-content">
                                    <div class="alert-title">${a.item_name || a.auction_code || 'Alert'}</div>
                                    <div class="alert-meta">
                                        ${a.summary || 'Suspicious activity detected'} • ${formatTime(a.created_at)}
                                    </div>
                                </div>
                            </div>
                        `).join('')
    }
                </div>
            </div>
        </main>
    `;
}

function formatTime(isoString) {
  if (!isoString) return 'Unknown';
  const date = new Date(isoString);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

// Render
function render() {
  const root = document.getElementById('root');

  let mainContent;
  switch (state.currentView) {
    case 'auctions': mainContent = AuctionsView(); break;
    case 'alerts': mainContent = AlertsView(); break;
    default: mainContent = Dashboard();
  }

  root.innerHTML = `
        <div class="app">
            ${Header()}
            ${Tabs()}
            <div class="app-content">
                ${Sidebar()}
                ${mainContent}
            </div>
        </div>
    `;

  updateStatusIndicator();
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  log('Initializing ShillBid Watchdog...', 'info');
  render();
  checkHealth();
  loadData();

  // Auto-refresh every 30 seconds
  setInterval(() => {
    log('Auto-refreshing...', 'info');
    loadData();
  }, 30000);
});
