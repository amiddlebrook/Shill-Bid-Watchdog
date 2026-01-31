-- ShillBid Watchdog D1 Database Schema
-- SQLite-compatible for Cloudflare D1

-- ============================================================================
-- Core Tables
-- ============================================================================

-- Watched auctions
CREATE TABLE IF NOT EXISTS auctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL DEFAULT 'bidfta',
    url TEXT NOT NULL,
    item_name TEXT,
    current_price REAL,
    start_price REAL,
    end_time TEXT,
    status TEXT DEFAULT 'watching',
    risk_level TEXT DEFAULT 'NONE',
    risk_score REAL DEFAULT 0.0,
    last_checked TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Individual bids
CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id TEXT NOT NULL,
    amount REAL NOT NULL,
    bid_time TEXT,
    bid_order INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Bidder profiles (aggregated across auctions)
CREATE TABLE IF NOT EXISTS bidders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bidder_id TEXT UNIQUE NOT NULL,
    display_name TEXT,
    total_bids INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    auctions_participated INTEGER DEFAULT 0,
    avg_bid_ratio REAL DEFAULT 0.0,
    suspicion_score REAL DEFAULT 0.0,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
);

-- Detection alerts
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    risk_level TEXT NOT NULL,
    summary TEXT,
    violations TEXT,  -- JSON array
    evidence TEXT,    -- JSON array
    ml_confidence REAL,
    acknowledged INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Bidding pairs (frequent competitors)
CREATE TABLE IF NOT EXISTS bidding_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bidder_a TEXT NOT NULL,
    bidder_b TEXT NOT NULL,
    interaction_count INTEGER DEFAULT 1,
    auction_ids TEXT,  -- JSON array
    suspicion_score REAL DEFAULT 0.0,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(bidder_a, bidder_b)
);

-- Agent task queue
CREATE TABLE IF NOT EXISTS agent_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,
    target_url TEXT,
    auction_id INTEGER REFERENCES auctions(id),
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    scheduled_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

-- ============================================================================
-- Historical Pattern Tracking Tables
-- ============================================================================

-- Item fingerprints for detecting relisted items
CREATE TABLE IF NOT EXISTS item_fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint_hash TEXT UNIQUE NOT NULL,
    item_name_normalized TEXT NOT NULL,
    category TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    times_listed INTEGER DEFAULT 1,
    auction_ids TEXT,  -- JSON array of auction IDs
    avg_final_price REAL,
    suspicious_relist INTEGER DEFAULT 0  -- 1 if relist pattern is suspicious
);

-- Seller profiles (track sellers across auctions)
CREATE TABLE IF NOT EXISTS sellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id TEXT UNIQUE NOT NULL,
    display_name TEXT,
    total_auctions INTEGER DEFAULT 0,
    total_relists INTEGER DEFAULT 0,
    avg_relist_rate REAL DEFAULT 0.0,
    associated_bidders TEXT,  -- JSON array of frequent bidders
    suspicion_score REAL DEFAULT 0.0,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
);

-- Cross-auction bidder patterns (bidder activity across multiple auctions)
CREATE TABLE IF NOT EXISTS cross_auction_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bidder_id TEXT NOT NULL,
    seller_id TEXT,
    item_fingerprint_id INTEGER REFERENCES item_fingerprints(id),
    auction_count INTEGER DEFAULT 1,
    total_bids INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    loss_rate REAL DEFAULT 0.0,  -- high loss rate + high frequency = suspicious
    pattern_type TEXT,  -- 'seller_follower', 'item_chaser', 'loss_leader'
    suspicion_score REAL DEFAULT 0.0,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    UNIQUE(bidder_id, seller_id)
);

-- Auction-to-seller mapping
ALTER TABLE auctions ADD COLUMN seller_id TEXT;
ALTER TABLE auctions ADD COLUMN item_fingerprint_id INTEGER REFERENCES item_fingerprints(id);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
CREATE INDEX IF NOT EXISTS idx_auctions_risk ON auctions(risk_level);
CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions(seller_id);
CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id);
CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids(bidder_id);
CREATE INDEX IF NOT EXISTS idx_bidders_suspicion ON bidders(suspicion_score DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unack ON alerts(acknowledged) WHERE acknowledged = 0;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_fingerprints_hash ON item_fingerprints(fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_cross_patterns_bidder ON cross_auction_patterns(bidder_id);
CREATE INDEX IF NOT EXISTS idx_cross_patterns_seller ON cross_auction_patterns(seller_id);
CREATE INDEX IF NOT EXISTS idx_sellers_suspicion ON sellers(suspicion_score DESC);
