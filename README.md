# ShillBid Watchdog

AI-powered shill bid detection using Cloudflare Workers with an AI Agent Swarm architecture.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Cloudflare account (for deployment)
- Wrangler CLI (`npm install -g wrangler`)

### Local Development

```bash
# Install dependencies
npm install

# Start local dev server
npm run dev
```

Visit `http://localhost:8787` to see the dashboard.

### Cloudflare Setup (For Full Features)

```bash
# Login to Cloudflare
wrangler login

# Create D1 database
npm run db:create

# Update wrangler.toml with the database_id from above

# Run migrations
npm run db:migrate

# Create KV namespace
npm run kv:create

# Update wrangler.toml with the KV id

# Deploy
npm run deploy
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AI Agent Swarm                        │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────────┐ │
│  │  Coordinator  │──│   Navigator   │──│  Analyzer   │ │
│  │ (Durable Obj) │  │(Browser Rend) │  │(Workers AI) │ │
│  └───────────────┘  └───────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌──────────┐  ┌─────────┐
         │   D1   │  │ Vectorize│  │   KV    │
         └────────┘  └──────────┘  └─────────┘
```

## 🔍 Detection Rules

1. **High Bid Ratio** - Single bidder participates in >40% of bids
2. **High Concentration** - Top 2 bidders make >70% of bids  
3. **Frequent Bidding Pairs** - Same bidders repeatedly compete
4. **Bid Inflation** - Bidders drive price up but never win

## 📁 Project Structure

```
src/
├── index.ts              # Worker entry + API routes
├── types.ts              # TypeScript definitions
├── features.ts           # Behavior feature computation
├── rules.ts              # Detection rules engine
├── scoring.ts            # Risk scoring system
└── agents/
    ├── coordinator.ts    # Task orchestration (Durable Object)
    ├── navigator.ts      # Browser automation
    └── analyzer.ts       # ML + rules analysis

public/
├── index.html            # Dashboard
├── styles.css            # Dark theme
└── app.js                # Frontend logic
```

## 🎯 Supported Auction Sites

- ✅ BidFTA (primary target)
- 🔜 eBay (coming soon)

## 📊 Risk Levels

| Level | Score | Color | Description |
|-------|-------|-------|-------------|
| NONE | 0-0.2 | 🟢 | No suspicious patterns |
| LOW | 0.2-0.4 | 🔵 | 1 rule violation |
| MEDIUM | 0.4-0.6 | 🟡 | 2 rule violations |
| HIGH | 0.6-0.8 | 🟠 | 3 rule violations |
| CRITICAL | 0.8-1.0 | 🔴 | 4+ rule violations |

## License

MIT
