/**
 * ShillBid Watchdog - Complete Frontend
 * All views and navigation fully implemented
 */

// State
const state = {
  auctions: [],
  alerts: [],
  bidders: [],
  stats: { totalAuctions: 0, activeAlerts: 0, suspiciousBidders: 0 },
  logs: [],
  currentView: 'dashboard',
  currentPlatform: 'bidfta',
  selectedAuction: null,
  lastUpdate: null,
  apiStatus: 'checking',
  chatHistory: [{ role: 'system', content: 'Watchdog AI Online. Paste a BidFTA URL to start watching, or ask me anything.' }]
};

// Inject Chat Styles
const style = document.createElement('style');
style.textContent = `
  .chat-terminal {
      background: #0d1117; /* GitHub Dark Dimmed */
      border: 1px solid #30363d;
      border-radius: 6px;
      font-family: 'Consolas', 'Monaco', monospace;
      display: flex;
      flex-direction: column;
      overflow: hidden;
  }
  .chat-history {
      height: 350px;
      overflow-y: auto;
      padding: 1rem;
      font-size: 0.9rem;
      display: flex;
      flex-direction: column;
      gap: 0.8rem;
  }
  .chat-message {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 6px;
      line-height: 1.4;
      word-wrap: break-word;
  }
  .chat-message.user {
      align-self: flex-end;
      background: #1f6feb; /* Blue */
      color: white;
  }
  .chat-message.bot {
      align-self: flex-start;
      background: #238636; /* Green */
      color: white;
      border-bottom-left-radius: 0;
  }
  .chat-message.system {
      align-self: center;
      color: #8b949e;
      font-style: italic;
      font-size: 0.8rem;
  }
  .chat-input-area {
      border-top: 1px solid #30363d;
      padding: 0.8rem;
      background: #161b22;
  }
  .chat-input-area input {
      background: transparent;
      border: none;
      color: #c9d1d9;
      width: 100%;
      outline: none;
      font-family: inherit;
  }
  .typing-indicator::after {
      content: '...';
      animation: dots 1.5s steps(5, end) infinite;
  }
  @keyframes dots {
      0%, 20% { content: '.'; }
      40% { content: '..'; }
      60% { content: '...'; }
      80%, 100% { content: ''; }
  }
  
  /* Markdown Styles for Formal Agent Output */
  .chat-md-table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 0.85rem;
      background: rgba(0,0,0,0.2);
  }
  .chat-md-table th, .chat-md-table td {
      border: 1px solid #444;
      padding: 6px 8px;
      text-align: left;
  }
  .chat-md-table th {
      background: rgba(255,255,255,0.1);
      font-weight: bold;
  }
  .chat-md-header {
      font-weight: bold;
      margin-top: 12px;
      margin-bottom: 6px;
      color: #e6edf3;
      font-size: 1.1em;
      border-bottom: 1px solid #30363d;
      padding-bottom: 4px;
  }
  .chat-md-list {
      margin: 6px 0;
      padding-left: 20px;
  }
  .chat-md-code {
      background: #333;
      padding: 2px 4px;
      border-radius: 4px;
      font-family: monospace;
  }
`;
document.head.appendChild(style);

// Logging
function log(message, type = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('en-US', { hour12: false }),
    message,
    type
  };
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.pop();
  updateLogUI();
}

function updateLogUI() {
  const logContainer = document.getElementById('activityLog');
  if (logContainer) {
    logContainer.innerHTML = state.logs.slice(0, 15).map(e => `
            <div class="log-entry ${e.type}">
                <span class="log-time">${e.time}</span>
                <span class="log-message">${e.message}</span>
            </div>
        `).join('');
  }
}

// API
async function api(endpoint, options = {}) {
  try {
    const res = await fetch(`/api${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return await res.json();
  } catch (error) {
    log(`API Error: ${error.message}`, 'error');
    throw error;
  }
}

// Health Check
async function checkHealth() {
  try {
    const res = await api('/health');
    state.apiStatus = res.success ? 'connected' : 'error';
    log(res.success ? 'Connected to API' : 'API error', res.success ? 'success' : 'error');
  } catch (e) {
    state.apiStatus = 'error';
    log('Failed to connect', 'error');
  }
  updateStatusIndicator();
}

function updateStatusIndicator() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (dot && text) {
    dot.className = 'status-dot ' + (state.apiStatus === 'connected' ? '' : state.apiStatus === 'checking' ? 'pending' : 'error');
    text.textContent = state.apiStatus === 'connected' ? 'Connected' : state.apiStatus === 'checking' ? 'Connecting...' : 'Disconnected';
  }
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

    if (statsRes.success) {
      state.stats = statsRes.data;
    }

    if (auctionsRes.success) {
      // Update state with deduplication
      const uniqueAuctions = [];
      const seenUrls = new Set();

      // Prioritize auctions with "bidfta" prefix over "unknown" for same URL
      const sortedAuctions = (auctionsRes.data || []).sort((a, b) => {
        // If same URL, prioritize better ID
        if (a.url === b.url) {
          if (a.auction_id.startsWith('bidfta')) return -1;
          if (b.auction_id.startsWith('bidfta')) return 1;
        }
        return new Date(b.updated_at) - new Date(a.updated_at);
      });

      for (const auction of sortedAuctions) {
        // Deduplicate by URL
        if (!seenUrls.has(auction.url)) {
          seenUrls.add(auction.url);
          uniqueAuctions.push(auction);
        }
      }

      state.auctions = uniqueAuctions;
      state.stats.totalAuctions = state.auctions.length;
      log(`Loaded ${state.auctions.length} auctions`, 'success');
    }
    if (alertsRes.success) {
      state.alerts = alertsRes.data || [];
      if (state.alerts.length > 0) log(`${state.alerts.length} active alerts`, 'warning');
    }

    state.lastUpdate = new Date();
    render();
  } catch (error) {
    log('Failed to load data', 'error');
  }
}

async function loadAuctionDetail(id) {
  log(`Loading auction ${id}...`, 'info');
  try {
    const res = await api(`/auctions/${id}`);
    if (res.success) {
      state.selectedAuction = res.data;
      log(`Loaded ${res.data.bids?.length || 0} bids`, 'success');
      render();
    }
  } catch (error) {
    log('Failed to load auction', 'error');
  }
}

// Watch Auction
async function watchAuction(url) {
  log(`Submitting: ${url.substring(0, 50)}...`, 'info');
  try {
    const res = await api('/auctions/watch', {
      method: 'POST',
      body: JSON.stringify({ url })
    });

    if (res.success) {
      log(`Added: ${res.data.auction_id}`, 'success');
      log('Queued for extraction', 'info');
      await loadData();
      return true;
    } else {
      log(`Error: ${res.error}`, 'error');
      return false;
    }
  } catch (error) {
    log('Failed to add auction', 'error');
    return false;
  }
}

async function analyzeAuction(id) {
  log(`Triggering analysis for ${id}...`, 'info');
  try {
    const res = await api(`/auctions/${id}/analyze`, { method: 'POST' });
    if (res.success) {
      log('Analysis queued', 'success');
    } else {
      log('Analysis failed', 'error');
    }
  } catch (error) {
    log('Failed to trigger analysis', 'error');
  }
}

async function forceExtract(id) {
  log(`Triggering re-scan for ${id}...`, 'info');
  try {
    const res = await api(`/auctions/${id}/extract`, { method: 'POST' });
    if (res.success) {
      log('Re-scan queued', 'success');
    } else {
      log('Re-scan failed', 'error');
    }
  } catch (error) {
    log('Failed to queue re-scan', 'error');
  }
}

async function acknowledgeAlert(id) {
  log(`Acknowledging alert ${id}...`, 'info');
  try {
    await api(`/alerts/${id}/acknowledge`, { method: 'POST' });
    log('Alert acknowledged', 'success');
    await loadData();
  } catch (error) {
    log('Failed to acknowledge', 'error');
  }
}

// Chat Handler
async function handleChatMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message) return;

  // Add User Message
  state.chatHistory.push({ role: 'user', content: message });
  input.value = '';
  renderChat(); // Re-render chat immediately
  scrollToBottom();

  // Show Typing Indicator
  const typingId = 'typing-' + Date.now();
  state.chatHistory.push({ role: 'typing', id: typingId });
  renderChat();
  scrollToBottom();

  try {
    // Call AI Backend
    const res = await api('/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        history: state.chatHistory.filter(m => m.role !== 'typing').map(m => ({ role: m.role, content: m.content }))
      })
    });

    // Remove Typing
    state.chatHistory = state.chatHistory.filter(m => m.role !== 'typing');

    if (res.success) {
      state.chatHistory.push({ role: 'bot', content: res.message });
      if (res.actionTaken) {
        log('AI performed an action', 'success');
        await loadData(); // Refresh data if AI mocked an action
      }
    } else {
      state.chatHistory.push({ role: 'system', content: `Error: ${res.error}` });
    }
  } catch (error) {
    state.chatHistory = state.chatHistory.filter(m => m.role !== 'typing');
    state.chatHistory.push({ role: 'system', content: 'Connection error. Agent offline.' });
  }

  renderChat();
  scrollToBottom();
}

function scrollToBottom() {
  const history = document.getElementById('chatHistory');
  if (history) history.scrollTop = history.scrollHeight;
}

function renderChat() {
  // Only re-render the history part to avoid losing focus if used elsewhere
  const container = document.getElementById('chatHistory');
  if (container) {
    container.innerHTML = state.chatHistory.map(msg => {
      if (msg.role === 'typing') {
        return `<div class="chat-message bot"><span class="typing-indicator">Thinking</span></div>`;
      }
      // Parse Markdown
      const content = parseMarkdown(msg.content);
      return `<div class="chat-message ${msg.role}">${content}</div>`;
    }).join('');
  }
}

// Simple Markdown Parser for Chat
function parseMarkdown(text) {
  if (!text) return '';

  // 1. Tables: | Header | Header |\n| --- | --- |
  // Very basic support: Find blocks looking like tables and converting them
  // Note: This is fragile but sufficient for controlled agent output

  // Split by lines
  let lines = text.split('\n');
  let inTable = false;
  let html = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    if (line.startsWith('|') && line.endsWith('|')) {
      if (!inTable) {
        html += '<table class="chat-md-table">';
        inTable = true;
        // Header row
        const headers = line.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
        html += `<thead><tr>${headers}</tr></thead><tbody>`;

        // Check if next line is separator |---| and skip it
        if (i + 1 < lines.length && lines[i + 1].includes('---')) {
          i++;
        }
      } else {
        // Data row
        const cells = line.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
        html += `<tr>${cells}</tr>`;
      }
    } else {
      if (inTable) {
        html += '</tbody></table>';
        inTable = false;
      }

      // Other Markdown

      // Headers ## Text
      if (line.startsWith('### ')) {
        html += `<div class="chat-md-header" style="font-size: 1em">${line.substring(4)}</div>`;
      } else if (line.startsWith('## ')) {
        html += `<div class="chat-md-header">${line.substring(3)}</div>`;
      } else if (line.startsWith('# ')) {
        html += `<div class="chat-md-header" style="font-size: 1.2em">${line.substring(2)}</div>`;
      }
      // List Items - Text
      else if (line.startsWith('- ')) {
        html += `<li class="chat-md-list-item">${line.substring(2)}</li>`;
        // Wrap in ul if not already? keeping it simple, divs work for visuals or use <ul> context
      }
      // Normal text
      else {
        if (line.length > 0) {
          // Bold **Text**
          line = line.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
          // Links
          line = line.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:inherit;text-decoration:underline">$1</a>');
          html += `<div>${line}</div>`;
        } else {
          html += '<br>';
        }
      }
    }
  }

  if (inTable) html += '</tbody></table>';

  // Post-processing for lists (grouping <li>)
  // Simple approach: list items are just divs with bullets for now in CSS, or let's accept <li> without <ul> for loose HTML 
  // Browser usually handles orphans okay, but better to replace with <div>• ...</div>
  html = html.replace(/<li class="chat-md-list-item">(.*?)<\/li>/g, '<div style="margin-left: 10px;">• $1</div>');

  return html;
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
  state.selectedAuction = null;
  log(`Navigated to ${view}`, 'info');
  render();
}

function viewAuction(id) {
  state.currentView = 'auction-detail';
  loadAuctionDetail(id);
}

function switchPlatform(platform) {
  if (platform === 'ebay') {
    log('eBay integration coming soon', 'warning');
    return;
  }
  state.currentPlatform = platform;
  log(`Switched to ${platform}`, 'info');
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
            <button class="platform-tab ${state.currentPlatform === 'bidfta' ? 'active' : ''}" 
                    onclick="switchPlatform('bidfta')">BidFTA</button>
            <button class="platform-tab ${state.currentPlatform === 'ebay' ? 'active' : ''} disabled" 
                    onclick="switchPlatform('ebay')">eBay <span class="coming-soon">Soon</span></button>
        </div>
    `;
}

function Sidebar() {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '◉' },
    { id: 'auctions', label: 'Auctions', icon: '◎' },
    { id: 'lists', label: 'Lists', icon: '≣' },
    { id: 'assessments', label: 'Assessments', icon: '⚖' },
    { id: 'alerts', label: 'Alerts', icon: '⚠', count: state.stats.activeAlerts },
    { id: 'bidders', label: 'Bidders', icon: '◯' }
  ];

  return `
        <aside class="sidebar">
            <nav class="nav-section">
                <div class="nav-title">Navigation</div>
                ${navItems.map(item => `
                    <div class="nav-link ${state.currentView === item.id ? 'active' : ''}" 
                         onclick="navigate('${item.id}')">
                        <span>${item.icon}</span>
                        <span>${item.label}</span>
                        ${item.count ? `<span class="nav-badge">${item.count}</span>` : ''}
                    </div>
                `).join('')}
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

function ChatConsole() {
  return `
        <div class="card mb-4 chat-terminal">
            <div class="card-header border-bottom border-secondary d-flex justify-content-between">
                <span class="card-title text-success">◆ Watchdog AI Agent</span>
                <span class="badge bg-success" style="font-size: 0.7rem">ONLINE</span>
            </div>
            <div id="chatHistory" class="chat-history">
                ${state.chatHistory.map(msg => {
    const content = msg.content || '';
    if (msg.role === 'typing') return `<div class="chat-message bot">Thinking...</div>`;
    const formatted = content.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:inherit;text-decoration:underline">$1</a>');
    return `<div class="chat-message ${msg.role}">${formatted}</div>`;
  }).join('')}
            </div>
            <div class="chat-input-area">
                <form onsubmit="handleChatMessage(event)">
                    <div style="display: flex; align-items: center;">
                        <span style="color: #238636; margin-right: 8px;">❯</span>
                        <input type="text" id="chatInput" placeholder="Command (e.g., 'Watch this URL', 'Analyze auction 123')" autocomplete="off">
                    </div>
                </form>
            </div>
        </div>
    `;
}

// ============================================================================
// VIEWS
// ============================================================================

function DashboardView() {
  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">Dashboard</h1>
                <button class="btn btn-secondary" onclick="loadData()">Refresh</button>
            </div>
            
            <!-- AI Chat Agent -->
            ${ChatConsole()}
            
            <!-- Stats Grid -->
            <div class="grid-4">
                ${StatCard('Auctions', state.stats.totalAuctions)}
                ${StatCard('Alerts', state.stats.activeAlerts, 'critical')}
                ${StatCard('Suspicious', state.stats.suspiciousBidders, 'high')}
                ${StatCard('Analyzed', state.auctions.filter(a => a.last_checked).length)}
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

function AuctionsView() {
  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">Auctions</h1>
                <button class="btn btn-secondary" onclick="loadData()">Refresh</button>
            </div>
            
            <!-- AI Agent -->
            ${ChatConsole()}
            
            <!-- Auctions Table -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title">All Auctions (${state.auctions.length})</span>
                </div>
                <div class="card-body" style="padding: 0">
                    ${AuctionsTable(state.auctions, true)}
                </div>
            </div>
        </main>
    `;
}

function AuctionDetailView() {
  const { auction, bids, alerts } = state.selectedAuction || {};

  if (!auction) {
    return `<main class="main"><div class="empty-state">Loading...</div></main>`;
  }

  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">
                    <span class="text-muted" style="cursor:pointer" onclick="navigate('auctions')">Auctions /</span>
                    ${auction.auction_id}
                </h1>
                <div style="display: flex; gap: var(--space-2)">
                    <a href="${auction.url}" target="_blank" class="btn btn-secondary">Open</a>
                    <button class="btn btn-secondary" style="color: var(--risk-critical); border-color: var(--risk-critical)" onclick="deleteAuction(${auction.id})">Delete</button>
                </div>
            </div>
            
            <!-- Auction Info -->
            <div class="grid-4 mb-4">
                ${StatCard('Risk Level', auction.risk_level || 'NONE', (auction.risk_level || 'none').toLowerCase())}
                ${StatCard('Risk Score', auction.risk_score || 0)}
                ${StatCard('Total Bids', bids?.length || 0)}
                ${StatCard('Alerts', alerts?.length || 0, alerts?.length > 0 ? 'high' : '')}
            </div>
            
            <!-- Details -->
            <div class="card mb-4">
                <div class="card-header"><span class="card-title">Details</span></div>
                <div class="card-body">
                    <table class="detail-table">
                        <tr><td class="text-muted">Item Name</td><td>${auction.item_name || 'Pending extraction'}</td></tr>
                        <tr><td class="text-muted">Status</td><td><span class="status-badge ${auction.status}">${auction.status}</span></td></tr>
                        <tr><td class="text-muted">Current Price</td><td>$${auction.current_price || 'N/A'}</td></tr>
                        <tr><td class="text-muted">Start Price</td><td>$${auction.start_price || 'N/A'}</td></tr>
                        <tr><td class="text-muted">Last Checked</td><td>${auction.last_checked || 'Never'}</td></tr>
                        <tr><td class="text-muted">URL</td><td><a href="${auction.url}" target="_blank" class="table-link">${auction.url}</a></td></tr>
                    </table>
                </div>
            </div>
            
            <!-- Bid History -->
            <div class="card mb-4">
                <div class="card-header"><span class="card-title">Bid History (${bids?.length || 0})</span></div>
                <div class="card-body" style="padding: 0">
                    ${bids && bids.length > 0 ? `
                        <table class="table">
                            <thead>
                                <tr><th>#</th><th>Bidder</th><th>Amount</th><th>Time</th></tr>
                            </thead>
                            <tbody>
                                ${bids.map((b, i) => `
                                    <tr>
                                        <td>${i + 1}</td>
                                        <td class="text-mono">${b.bidder_id}</td>
                                        <td>$${b.amount}</td>
                                        <td class="text-muted">${b.bid_time || '-'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    ` : '<div class="empty-state">No bids extracted yet</div>'}
                </div>
            </div>
            
            <!-- Alerts for this auction -->
            ${alerts && alerts.length > 0 ? `
                <div class="card">
                    <div class="card-header"><span class="card-title">Alerts</span></div>
                    <div class="card-body" style="padding: 0">
                        ${alerts.map(a => AlertItem(a)).join('')}
                    </div>
                </div>
            ` : ''}
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
                <div class="card-header">
                    <span class="card-title">Active Alerts (${state.alerts.length})</span>
                </div>
                <div class="card-body" style="padding: 0">
                    ${state.alerts.length === 0
      ? '<div class="empty-state"><div class="empty-icon">✓</div><div>No active alerts</div></div>'
      : state.alerts.map(AlertItem).join('')
    }
                </div>
            </div>
        </main>
    `;
}

function ListsView() {
  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">Custom Lists</h1>
                <button class="btn btn-secondary" onclick="loadData()">Refresh</button>
            </div>
            
            <div class="card mb-4">
                <div class="card-header"><span class="card-title">Generated Lists</span></div>
                <div class="card-body">
                    <div class="empty-state">
                        <div class="empty-icon">📝</div>
                        <div>Ask the Agent to create a custom list</div>
                        <div class="text-muted text-sm">Example: "List all auctions with high risk > 0.8"</div>
                    </div>
                </div>
            </div>

            <div class="card">
                <div class="card-header"><span class="card-title">Standard Views</span></div>
                <div class="card-body" style="padding: 0">
                     <table class="table">
                        <tbody>
                            <tr>
                                <td><a onclick="navigate('auctions')" style="cursor:pointer;color:#58a6ff">All Auctions</a></td>
                                <td class="text-right text-muted">${state.stats.totalAuctions} items</td>
                            </tr>
                            <tr>
                                <td><a onclick="navigate('alerts')" style="cursor:pointer;color:#58a6ff">Active Alerts</a></td>
                                <td class="text-right text-muted">${state.stats.activeAlerts} items</td>
                            </tr>
                             <tr>
                                <td><a onclick="navigate('bidders')" style="cursor:pointer;color:#58a6ff">Suspicious Bidders</a></td>
                                <td class="text-right text-muted">${state.stats.suspiciousBidders} items</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </main>
  `;
}

function AssessmentsView() {
  // Filter for auctions with analysis logic (e.g. risk score > 0 or has alerts)
  const assessedAuctions = state.auctions.filter(a => a.risk_score > 0 || a.risk_level !== 'NONE');

  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">Assessments</h1>
                <button class="btn btn-secondary" onclick="loadData()">Refresh</button>
            </div>
            
            <div class="card">
                <div class="card-header"><span class="card-title">Risk Assessments</span></div>
                <div class="card-body" style="padding: 0">
                    ${assessedAuctions.length === 0 ?
      '<div class="empty-state"><div class="empty-icon">✓</div><div>No risks detected yet</div></div>' :
      `<table class="table">
                            <thead>
                                <tr>
                                    <th>Auction</th>
                                    <th>Risk Level</th>
                                    <th>Score</th>
                                    <th>Findings</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${assessedAuctions.map(a => `
                                    <tr>
                                        <td><a href="${a.url}" target="_blank" class="table-link">${a.auction_id}</a></td>
                                        <td><span class="risk-badge risk-${(a.risk_level || 'none').toLowerCase()}">${a.risk_level}</span></td>
                                        <td>${(a.risk_score || 0).toFixed(2)}</td>
                                        <td class="text-muted">Analysis complete. See details.</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>`
    }
                </div>
            </div>
        </main>
  `;
}

function BiddersView() {
  // Get unique bidders from auctions
  const bidderMap = {};
  state.auctions.forEach(a => {
    // We'd need bid data to show bidders - for now show placeholder
  });

  return `
        <main class="main">
            <div class="page-header">
                <h1 class="page-title">Bidders</h1>
                <button class="btn btn-secondary" onclick="loadData()">Refresh</button>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Tracked Bidders</span>
                </div>
                <div class="card-body">
                    <div class="empty-state">
                        <div class="empty-icon">👤</div>
                        <div>Bidder profiles will appear here as auctions are analyzed</div>
                        <div class="text-muted text-sm">The system tracks bidder behavior across multiple auctions</div>
                    </div>
                </div>
            </div>
        </main>
  `;
}



// ============================================================================
// SHARED COMPONENTS
// ============================================================================

function StatCard(label, value, risk = '') {
  const color = risk ? `style = "color: var(--risk-${risk})"` : '';
  return `
        <div class="stat-card">
            <div class="stat-label">${label}</div>
            <div class="stat-value" ${color}>${value}</div>
        </div>
  `;
}

async function deleteAuction(id) {
  if (!confirm('Are you sure you want to delete this auction?')) return;
  try {
    const res = await api(`/auctions/${id}`, { method: 'DELETE' });
    if (res.success) {
      log('Auction deleted', 'success');
      if (state.currentView === 'auction-detail') navigate('auctions');
      await loadData();
    }
  } catch (e) {
    log('Failed to delete auction', 'error');
  }
}

function AuctionsTable(auctions, showActions = false) {
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
          ${showActions ? '<th>Actions</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${auctions.map(a => `
                        <tr>
                            <td>
                                <span class="text-mono table-link" onclick="viewAuction(${a.id})" style="cursor:pointer">
                                    ${a.auction_id || '-'}
                                </span>
                            </td>
                            <td>
                                <a href="${a.url}" target="_blank" class="table-link">
                                    ${a.item_name || 'Pending extraction...'}
                                </a>
                            </td>
                            <td><span class="status-badge ${a.status}">${a.status}</span></td>
                            <td><span class="risk-badge risk-${(a.risk_level || 'none').toLowerCase()}">${a.risk_level || 'NONE'}</span></td>
                            <td>${a.bid_count || 0}</td>
                            <td class="text-muted">${a.last_checked ? formatTime(a.last_checked) : 'Pending'}</td>
                            ${showActions ? `
                                <td>
                                    <button class="btn btn-sm btn-secondary" onclick="viewAuction(${a.id})">View</button>
                                    <button class="btn btn-sm" style="color: var(--risk-critical)" onclick="deleteAuction(${a.id})">Del</button>
                                </td>
                            ` : ''}
                        </tr>
                    `).join('')}
      </tbody>
    </table>
        </div>
  `;
}

function AlertItem(alert) {
  return `
        <div class="alert-item">
            <div class="alert-indicator ${(alert.risk_level || 'low').toLowerCase()}"></div>
            <div class="alert-content">
                <div class="alert-title">${alert.item_name || alert.auction_code || 'Alert'}</div>
                <div class="alert-meta">
                    ${alert.summary || 'Suspicious activity detected'} • ${formatTime(alert.created_at)}
                </div>
            </div>
            <button class="btn btn-sm btn-secondary" onclick="acknowledgeAlert(${alert.id})">Dismiss</button>
        </div>
  `;
}

function renderLogs(count) {
  const logs = state.logs.slice(0, count);
  if (logs.length === 0) {
    return '<div class="empty-state">No activity yet</div>';
  }
  return logs.map(e => `
        <div class="log-entry ${e.type}">
            <span class="log-time">${e.time}</span>
            <span class="log-message">${e.message}</span>
        </div>
  `).join('');
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

// ============================================================================
// RENDER
// ============================================================================

function render() {
  const root = document.getElementById('root');

  let mainContent;
  switch (state.currentView) {
    case 'auctions': mainContent = AuctionsView(); break;
    case 'auction-detail': mainContent = AuctionDetailView(); break;
    case 'lists': mainContent = ListsView(); break;
    case 'assessments': mainContent = AssessmentsView(); break;
    case 'alerts': mainContent = AlertsView(); break;
    case 'bidders': mainContent = BiddersView(); break;
    default: mainContent = DashboardView();
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

// ============================================================================
// INITIALIZE
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  log('Initializing ShillBid Watchdog...', 'info');
  render();
  checkHealth();
  loadData();

  // Auto-refresh every 30 seconds
  setInterval(() => {
    log('Auto-refresh', 'info');
    loadData();
  }, 30000);
});
