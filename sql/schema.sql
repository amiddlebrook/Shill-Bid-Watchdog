-- ShillBidWatchdog Database Schema
-- PostgreSQL compatible

-- ============================================================================
-- Drop existing tables (for development reset)
-- ============================================================================

DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS bids CASCADE;
DROP TABLE IF EXISTS bidders CASCADE;
DROP TABLE IF EXISTS auctions CASCADE;

-- ============================================================================
-- Tables
-- ============================================================================

-- Auctions table: Stores auction metadata
CREATE TABLE auctions (
    id SERIAL PRIMARY KEY,
    auction_id VARCHAR(100) UNIQUE NOT NULL,
    item_name VARCHAR(500) NOT NULL,
    current_price DECIMAL(15, 2),
    start_price DECIMAL(15, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bids table: Stores individual bids
CREATE TABLE bids (
    id SERIAL PRIMARY KEY,
    auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id VARCHAR(100) NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    timestamp TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bidders table: Stores bidder profiles and aggregate stats
CREATE TABLE bidders (
    id SERIAL PRIMARY KEY,
    bidder_id VARCHAR(100) UNIQUE NOT NULL,
    total_bids INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_auctions INTEGER DEFAULT 0,
    avg_bid_ratio DECIMAL(5, 4) DEFAULT 0.0,
    suspicion_score DECIMAL(5, 4) DEFAULT 0.0,
    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Alerts table: Stores generated alerts
CREATE TABLE alerts (
    id SERIAL PRIMARY KEY,
    auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
    risk_level VARCHAR(20) NOT NULL,
    summary TEXT,
    violations TEXT,  -- JSON array of violation types
    evidence TEXT,    -- JSON array of evidence objects
    acknowledged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Index for faster auction lookups by external ID
CREATE INDEX idx_auctions_auction_id ON auctions(auction_id);

-- Index for faster bid lookups by bidder
CREATE INDEX idx_bids_bidder_id ON bids(bidder_id);

-- Index for faster bid lookups by auction
CREATE INDEX idx_bids_auction_id ON bids(auction_id);

-- Index for faster bidder lookups
CREATE INDEX idx_bidders_bidder_id ON bidders(bidder_id);

-- Index for finding high-suspicion bidders
CREATE INDEX idx_bidders_suspicion_score ON bidders(suspicion_score DESC);

-- Index for alert timestamps
CREATE INDEX idx_alerts_created_at ON alerts(created_at DESC);

-- Index for unacknowledged alerts
CREATE INDEX idx_alerts_unacknowledged ON alerts(acknowledged) WHERE acknowledged = FALSE;

-- ============================================================================
-- Triggers
-- ============================================================================

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for auctions table
CREATE TRIGGER update_auctions_updated_at
    BEFORE UPDATE ON auctions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Views
-- ============================================================================

-- View for auction summary with bid counts
CREATE OR REPLACE VIEW auction_summary AS
SELECT 
    a.id,
    a.auction_id,
    a.item_name,
    a.current_price,
    COUNT(b.id) AS total_bids,
    COUNT(DISTINCT b.bidder_id) AS unique_bidders,
    a.created_at,
    a.updated_at
FROM auctions a
LEFT JOIN bids b ON a.id = b.auction_id
GROUP BY a.id, a.auction_id, a.item_name, a.current_price, a.created_at, a.updated_at;

-- View for bidder summary across all auctions
CREATE OR REPLACE VIEW bidder_summary AS
SELECT 
    bidder_id,
    COUNT(*) AS total_bids,
    COUNT(DISTINCT auction_id) AS auctions_participated,
    SUM(amount) AS total_bid_amount,
    AVG(amount) AS avg_bid_amount,
    MAX(amount) AS max_bid,
    MIN(amount) AS min_bid
FROM bids
GROUP BY bidder_id;

-- View for high-risk alerts
CREATE OR REPLACE VIEW high_risk_alerts AS
SELECT 
    al.id,
    al.risk_level,
    al.summary,
    a.auction_id,
    a.item_name,
    al.created_at
FROM alerts al
JOIN auctions a ON al.auction_id = a.id
WHERE al.risk_level IN ('HIGH', 'CRITICAL')
AND al.acknowledged = FALSE
ORDER BY al.created_at DESC;
