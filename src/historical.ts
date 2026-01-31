/**
 * Historical Pattern Detection
 * Cross-auction analysis for bidder frequency vs item relist frequency
 */

import type { Env, Evidence } from './types';

// Thresholds for historical patterns
const HISTORICAL_THRESHOLDS = {
    MIN_AUCTIONS_FOR_PATTERN: 3,     // Need at least 3 auctions to detect pattern
    HIGH_RELIST_RATE: 0.5,           // Item relisted in >50% of auctions
    HIGH_BIDDER_FREQUENCY: 0.6,      // Bidder appears in >60% of seller's auctions
    LOSS_LEADER_THRESHOLD: 0.8,      // Loses >80% of auctions they bid on
    SELLER_FOLLOWER_MIN: 5           // Bidder follows seller across 5+ auctions
};

export interface HistoricalPatternResult {
    violations: string[];
    evidence: Evidence[];
    suspicionScores: Record<string, number>;
}

/**
 * Main historical pattern detection
 * Runs cross-auction analysis on bidder and item patterns
 */
export async function runHistoricalDetection(
    auctionId: number,
    env: Env
): Promise<HistoricalPatternResult> {
    const violations: string[] = [];
    const evidence: Evidence[] = [];
    const suspicionScores: Record<string, number> = {};

    // Get auction details
    const auction = await env.DB.prepare(`
    SELECT * FROM auctions WHERE id = ?
  `).bind(auctionId).first();

    if (!auction) {
        return { violations, evidence, suspicionScores };
    }

    // Rule 5: Seller Follower Pattern
    const followerResult = await checkSellerFollowerPattern(auctionId, env);
    if (followerResult.detected) {
        violations.push('seller_follower');
        evidence.push({
            rule: 'Seller Follower Pattern',
            description: 'Bidder(s) consistently appear in this seller\'s auctions',
            details: followerResult.details
        });
        Object.assign(suspicionScores, followerResult.scores);
    }

    // Rule 6: Item Relist + Same Bidders
    const relistResult = await checkRelistPattern(auctionId, env);
    if (relistResult.detected) {
        violations.push('relist_shill');
        evidence.push({
            rule: 'Relist Shill Pattern',
            description: 'Same bidders appear when item is relisted multiple times',
            details: relistResult.details
        });
        Object.assign(suspicionScores, relistResult.scores);
    }

    // Rule 7: Loss Leader Pattern
    const lossLeaderResult = await checkLossLeaderPattern(auctionId, env);
    if (lossLeaderResult.detected) {
        violations.push('loss_leader');
        evidence.push({
            rule: 'Loss Leader Pattern',
            description: 'Bidder consistently loses auctions despite heavy bidding',
            details: lossLeaderResult.details
        });
        Object.assign(suspicionScores, lossLeaderResult.scores);
    }

    return { violations, evidence, suspicionScores };
}

/**
 * Rule 5: Check for bidders who follow a specific seller
 */
async function checkSellerFollowerPattern(
    auctionId: number,
    env: Env
): Promise<{ detected: boolean; details: Record<string, unknown>; scores: Record<string, number> }> {
    // Get seller for this auction
    const auction = await env.DB.prepare(`
    SELECT seller_id FROM auctions WHERE id = ?
  `).bind(auctionId).first();

    if (!auction?.seller_id) {
        return { detected: false, details: {}, scores: {} };
    }

    // Find all auctions by this seller
    const sellerAuctions = await env.DB.prepare(`
    SELECT id FROM auctions WHERE seller_id = ?
  `).bind(auction.seller_id).all();

    if (sellerAuctions.results.length < HISTORICAL_THRESHOLDS.MIN_AUCTIONS_FOR_PATTERN) {
        return { detected: false, details: {}, scores: {} };
    }

    const auctionIds = sellerAuctions.results.map((a: any) => a.id);

    // Find bidders who appear in multiple seller auctions
    const bidderFrequency = await env.DB.prepare(`
    SELECT 
      bidder_id,
      COUNT(DISTINCT auction_id) as auction_count,
      SUM(1) as total_bids
    FROM bids
    WHERE auction_id IN (${auctionIds.join(',')})
    GROUP BY bidder_id
    HAVING auction_count >= ?
  `).bind(HISTORICAL_THRESHOLDS.MIN_AUCTIONS_FOR_PATTERN).all();

    const suspiciousBidders: Array<{ bidderId: string; auctionCount: number; frequency: number }> = [];
    const scores: Record<string, number> = {};

    for (const row of bidderFrequency.results as any[]) {
        const frequency = row.auction_count / auctionIds.length;

        if (frequency >= HISTORICAL_THRESHOLDS.HIGH_BIDDER_FREQUENCY) {
            suspiciousBidders.push({
                bidderId: row.bidder_id,
                auctionCount: row.auction_count,
                frequency
            });

            // Score increases with frequency
            scores[row.bidder_id] = Math.min(frequency * 1.2, 1.0);

            // Update cross_auction_patterns
            await env.DB.prepare(`
        INSERT INTO cross_auction_patterns 
          (bidder_id, seller_id, auction_count, pattern_type, suspicion_score)
        VALUES (?, ?, ?, 'seller_follower', ?)
        ON CONFLICT(bidder_id, seller_id) DO UPDATE SET
          auction_count = excluded.auction_count,
          pattern_type = 'seller_follower',
          suspicion_score = excluded.suspicion_score,
          last_seen = datetime('now')
      `).bind(row.bidder_id, auction.seller_id, row.auction_count, scores[row.bidder_id]).run();
        }
    }

    return {
        detected: suspiciousBidders.length > 0,
        details: {
            sellerId: auction.seller_id,
            totalSellerAuctions: auctionIds.length,
            suspiciousBidders
        },
        scores
    };
}

/**
 * Rule 6: Check for same bidders appearing on relisted items
 */
async function checkRelistPattern(
    auctionId: number,
    env: Env
): Promise<{ detected: boolean; details: Record<string, unknown>; scores: Record<string, number> }> {
    // Get item fingerprint
    const auction = await env.DB.prepare(`
    SELECT item_fingerprint_id, item_name FROM auctions WHERE id = ?
  `).bind(auctionId).first();

    if (!auction?.item_fingerprint_id) {
        return { detected: false, details: {}, scores: {} };
    }

    // Find all auctions with same item fingerprint
    const relatedAuctions = await env.DB.prepare(`
    SELECT id FROM auctions WHERE item_fingerprint_id = ?
  `).bind(auction.item_fingerprint_id).all();

    if (relatedAuctions.results.length < 2) {
        return { detected: false, details: {}, scores: {} };
    }

    const auctionIds = relatedAuctions.results.map((a: any) => a.id);

    // Find bidders who appear in multiple listings of same item
    const repeatedBidders = await env.DB.prepare(`
    SELECT 
      bidder_id,
      COUNT(DISTINCT auction_id) as listing_appearances,
      SUM(1) as total_bids
    FROM bids
    WHERE auction_id IN (${auctionIds.join(',')})
    GROUP BY bidder_id
    HAVING listing_appearances >= 2
  `).all();

    const suspiciousBidders: Array<{ bidderId: string; appearances: number; totalListings: number }> = [];
    const scores: Record<string, number> = {};

    for (const row of repeatedBidders.results as any[]) {
        const appearanceRate = row.listing_appearances / auctionIds.length;

        if (appearanceRate >= HISTORICAL_THRESHOLDS.HIGH_RELIST_RATE) {
            suspiciousBidders.push({
                bidderId: row.bidder_id,
                appearances: row.listing_appearances,
                totalListings: auctionIds.length
            });

            // Higher score for appearing in more relists
            scores[row.bidder_id] = Math.min(appearanceRate * 1.5, 1.0);
        }
    }

    // Mark fingerprint as suspicious
    if (suspiciousBidders.length > 0) {
        await env.DB.prepare(`
      UPDATE item_fingerprints 
      SET suspicious_relist = 1, times_listed = ?
      WHERE id = ?
    `).bind(auctionIds.length, auction.item_fingerprint_id).run();
    }

    return {
        detected: suspiciousBidders.length > 0,
        details: {
            itemName: auction.item_name,
            timesListed: auctionIds.length,
            suspiciousBidders
        },
        scores
    };
}

/**
 * Rule 7: Check for loss leader pattern (bidders who always lose)
 */
async function checkLossLeaderPattern(
    auctionId: number,
    env: Env
): Promise<{ detected: boolean; details: Record<string, unknown>; scores: Record<string, number> }> {
    // Get bidders in this auction
    const bidders = await env.DB.prepare(`
    SELECT DISTINCT bidder_id FROM bids WHERE auction_id = ?
  `).bind(auctionId).all();

    const lossLeaders: Array<{ bidderId: string; auctions: number; wins: number; lossRate: number }> = [];
    const scores: Record<string, number> = {};

    for (const row of bidders.results as any[]) {
        const bidderId = row.bidder_id;

        // Get bidder's overall history
        const history = await env.DB.prepare(`
      SELECT total_bids, total_wins, auctions_participated 
      FROM bidders WHERE bidder_id = ?
    `).bind(bidderId).first() as any;

        if (!history || history.auctions_participated < HISTORICAL_THRESHOLDS.MIN_AUCTIONS_FOR_PATTERN) {
            continue;
        }

        const lossRate = 1 - (history.total_wins / history.auctions_participated);

        if (lossRate >= HISTORICAL_THRESHOLDS.LOSS_LEADER_THRESHOLD && history.total_bids >= 10) {
            lossLeaders.push({
                bidderId,
                auctions: history.auctions_participated,
                wins: history.total_wins,
                lossRate
            });

            // Score based on loss rate and activity
            scores[bidderId] = lossRate * 0.8;
        }
    }

    return {
        detected: lossLeaders.length > 0,
        details: { lossLeaders },
        scores
    };
}

/**
 * Create fingerprint hash for item name (for relist detection)
 */
export function createItemFingerprint(itemName: string): string {
    // Normalize: lowercase, remove special chars, sort words
    const normalized = itemName
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .sort()
        .join(' ');

    // Simple hash
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }

    return `fp-${Math.abs(hash).toString(36)}`;
}

/**
 * Get or create item fingerprint
 */
export async function getOrCreateFingerprint(
    itemName: string,
    auctionId: string,
    env: Env
): Promise<number> {
    const hash = createItemFingerprint(itemName);
    const normalized = itemName.toLowerCase().trim();

    // Try to get existing
    let fingerprint = await env.DB.prepare(`
    SELECT id, auction_ids FROM item_fingerprints WHERE fingerprint_hash = ?
  `).bind(hash).first() as any;

    if (fingerprint) {
        // Update with new auction
        const auctionIds = JSON.parse(fingerprint.auction_ids || '[]');
        if (!auctionIds.includes(auctionId)) {
            auctionIds.push(auctionId);
            await env.DB.prepare(`
        UPDATE item_fingerprints 
        SET times_listed = times_listed + 1, auction_ids = ?
        WHERE id = ?
      `).bind(JSON.stringify(auctionIds), fingerprint.id).run();
        }
        return fingerprint.id;
    }

    // Create new
    const result = await env.DB.prepare(`
    INSERT INTO item_fingerprints (fingerprint_hash, item_name_normalized, auction_ids)
    VALUES (?, ?, ?)
    RETURNING id
  `).bind(hash, normalized, JSON.stringify([auctionId])).first() as any;

    return result.id;
}
