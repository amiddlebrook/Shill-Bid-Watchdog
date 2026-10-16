-- Additive migration for both new installations and existing v1 D1 databases.
CREATE TABLE IF NOT EXISTS auctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, auction_id TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL DEFAULT 'bidfta', url TEXT NOT NULL, item_name TEXT,
  current_price REAL, start_price REAL, end_time TEXT,
  status TEXT DEFAULT 'watching', risk_level TEXT DEFAULT 'NONE', risk_score REAL DEFAULT 0,
  last_checked TEXT, created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT, auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id TEXT NOT NULL, amount REAL NOT NULL, bid_time TEXT, bid_order INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  risk_level TEXT NOT NULL, summary TEXT, violations TEXT, evidence TEXT,
  ml_confidence REAL, acknowledged INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS auction_notes (
  auction_id INTEGER PRIMARY KEY REFERENCES auctions(id) ON DELETE CASCADE,
  seller_tag TEXT, notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_watchdog_bids_auction ON bids(auction_id);
CREATE INDEX IF NOT EXISTS idx_watchdog_bids_bidder ON bids(bidder_id);
CREATE INDEX IF NOT EXISTS idx_watchdog_alerts_ack ON alerts(acknowledged);
CREATE INDEX IF NOT EXISTS idx_watchdog_seller_tag ON auction_notes(seller_tag);
