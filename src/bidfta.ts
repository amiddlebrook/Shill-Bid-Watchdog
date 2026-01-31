/**
 * BidFTA-Specific Detection Logic
 * 
 * Key insight: BidFTA is ALWAYS the seller. Items get relisted if not picked up.
 * Suspected shill pattern: Someone bids up items, doesn't pick them up, item relists.
 * 
 * Detection focuses on:
 * 1. Same bidder appearing on same ITEM across multiple relists
 * 2. Bidder who consistently bids but never picks up / wins
 * 3. Bids that land exactly at or just below another bidder's max
 */

import type { Env, Evidence } from './types';

// BidFTA-specific thresholds
const BIDFTA_THRESHOLDS = {
    MIN_RELISTS_FOR_PATTERN: 2,     // Item listed at least 2 times
    SUSPICIOUS_RELIST_BIDDER: 0.5,  // Bidder appears in >50% of item's listings
    PENNY_INCREMENT_SUSPICIOUS: 5,  // >5 penny increments in auction is suspicious
    MAX_BID_EXPOSURE_DELTA: 0.05,   // Bid within 5% of another's max = suspicious
    BIDDER_LOSS_STREAK: 5           // Loses 5+ auctions they actively bid on
};

export interface BidFTAPatternResult {
    violations: string[];
    evidence: Evidence[];
    suspicionScores: Record<string, number>;
}

/**
 * Main BidFTA pattern detection
 */
export async function runBidFTADetection(
    auctionId: number,
    env: Env
): Promise<BidFTAPatternResult> {
    const violations: string[] = [];
    const evidence: Evidence[] = [];
    const suspicionScores: Record<string, number> = {};

    // Get auction and its item fingerprint
    const auction = await env.DB.prepare(`
    SELECT * FROM auctions WHERE id = ?
  `).bind(auctionId).first() as any;

    if (!auction) {
        return { violations, evidence, suspicionScores };
    }

    // Rule: Relist Stalker - Same bidder on item across multiple relists
    const relistResult = await checkRelistStalker(auctionId, auction.item_fingerprint_id, env);
    if (relistResult.detected) {
        violations.push('relist_stalker');
        evidence.push({
            rule: 'Relist Stalker',
            description: 'This bidder appears every time this item is relisted',
            details: relistResult.details
        });
        Object.assign(suspicionScores, relistResult.scores);
    }

    // Rule: Penny Sniper - Excessive $0.01 increment bids
    const pennyResult = await checkPennySniping(auctionId, env);
    if (pennyResult.detected) {
        violations.push('penny_sniper');
        evidence.push({
            rule: 'Penny Sniper Pattern',
            description: 'Excessive minimal increment bids (potential max bid exposure)',
            details: pennyResult.details
        });
        Object.assign(suspicionScores, pennyResult.scores);
    }

    // Rule: Never-Pickup Pattern - Bidder wins but items keep relisting
    const neverPickupResult = await checkNeverPickup(auctionId, env);
    if (neverPickupResult.detected) {
        violations.push('never_pickup');
        evidence.push({
            rule: 'Never-Pickup Pattern',
            description: 'Winner appears to not pick up items (items keep relisting)',
            details: neverPickupResult.details
        });
        Object.assign(suspicionScores, neverPickupResult.scores);
    }

    // Rule: Serial Loser - High activity bidder who "loses" frequently
    const serialLoserResult = await checkSerialLoser(auctionId, env);
    if (serialLoserResult.detected) {
        violations.push('serial_loser');
        evidence.push({
            rule: 'Serial Loser Pattern',
            description: 'Bidder is very active but almost never wins',
            details: serialLoserResult.details
        });
        Object.assign(suspicionScores, serialLoserResult.scores);
    }

    return { violations, evidence, suspicionScores };
}

/**
 * Check for bidders who appear every time an item is relisted
 */
async function checkRelistStalker(
    auctionId: number,
    fingerprintId: number | null,
    env: Env
): Promise<{ detected: boolean; details: Record<string, unknown>; scores: Record<string, number> }> {
    if (!fingerprintId) {
        return { detected: false, details: {}, scores: {} };
    }

    // Get all auctions with this item fingerprint
    const relatedAuctions = await env.DB.prepare(`
    SELECT id FROM auctions WHERE item_fingerprint_id = ?
  `).bind(fingerprintId).all();

    const auctionIds = relatedAuctions.results?.map((a: any) => a.id) || [];

    if (auctionIds.length < BIDFTA_THRESHOLDS.MIN_RELISTS_FOR_PATTERN) {
        return { detected: false, details: {}, scores: {} };
    }

    // Find bidders who appear in multiple listings of same item
    const stalkers = await env.DB.prepare(`
    SELECT 
      bidder_id,
      COUNT(DISTINCT auction_id) as appearances,
      SUM(1) as total_bids
    FROM bids
    WHERE auction_id IN (${auctionIds.join(',')})
    GROUP BY bidder_id
    HAVING appearances >= ?
    ORDER BY appearances DESC
  `).bind(BIDFTA_THRESHOLDS.MIN_RELISTS_FOR_PATTERN).all();

    const suspicious: Array<{ bidderId: string; appearances: number; totalListings: number; rate: number }> = [];
    const scores: Record<string, number> = {};

    for (const row of stalkers.results as any[]) {
        const rate = row.appearances / auctionIds.length;

        if (rate >= BIDFTA_THRESHOLDS.SUSPICIOUS_RELIST_BIDDER) {
            suspicious.push({
                bidderId: row.bidder_id,
                appearances: row.appearances,
                totalListings: auctionIds.length,
                rate
            });

            // Score: higher rate = more suspicious
            scores[row.bidder_id] = Math.min(rate * 1.5, 1.0);
        }
    }

    return {
        detected: suspicious.length > 0,
        details: {
            itemRelistCount: auctionIds.length,
            stalkerBidders: suspicious
        },
        scores
    };
}

/**
 * Check for excessive penny-increment bidding (suggests max bid exposure)
 */
async function checkPennySniping(
    auctionId: number,
    env: Env
): Promise<{ detected: boolean; details: Record<string, unknown>; scores: Record<string, number> }> {
    // Get all bids ordered by time/order
    const bids = await env.DB.prepare(`
    SELECT bidder_id, amount, bid_order 
    FROM bids 
    WHERE auction_id = ?
    ORDER BY bid_order ASC
  `).bind(auctionId).all();

    if (!bids.results || bids.results.length < 3) {
        return { detected: false, details: {}, scores: {} };
    }

    // Count penny increments per bidder
    const pennyIncrements: Record<string, number> = {};
    let totalPennyIncrements = 0;

    for (let i = 1; i < bids.results.length; i++) {
        const prevBid = bids.results[i - 1] as any;
        const currentBid = bids.results[i] as any;

        const increment = currentBid.amount - prevBid.amount;

        // Penny increment: $0.01 to $1.00
        if (increment > 0 && increment <= 1.00) {
            pennyIncrements[currentBid.bidder_id] = (pennyIncrements[currentBid.bidder_id] || 0) + 1;
            totalPennyIncrements++;
        }
    }

    const scores: Record<string, number> = {};
    const snipers: Array<{ bidderId: string; pennyBids: number }> = [];

    for (const [bidderId, count] of Object.entries(pennyIncrements)) {
        if (count >= BIDFTA_THRESHOLDS.PENNY_INCREMENT_SUSPICIOUS) {
            snipers.push({ bidderId, pennyBids: count });
            scores[bidderId] = Math.min(count / 10, 1.0);
        }
    }

    return {
        detected: snipers.length > 0 || totalPennyIncrements > BIDFTA_THRESHOLDS.PENNY_INCREMENT_SUSPICIOUS * 2,
        details: {
            totalPennyIncrements,
            sniperBidders: snipers
        },
        scores
    };
}

/**
 * Check for winners who don't pick up items (items keep relisting)
 */
async function checkNeverPickup(
    auctionId: number,
    env: Env
): Promise<{ detected: boolean; details: Record<string, unknown>; scores: Record<string, number> }> {
    // This requires tracking winning bids and subsequent relists
    // Get item fingerprint
    const auction = await env.DB.prepare(`
    SELECT item_fingerprint_id FROM auctions WHERE id = ?
  `).bind(auctionId).first() as any;

    if (!auction?.item_fingerprint_id) {
        return { detected: false, details: {}, scores: {} };
    }

    // Get fingerprint relist data
    const fingerprint = await env.DB.prepare(`
    SELECT times_listed, suspicious_relist FROM item_fingerprints WHERE id = ?
  `).bind(auction.item_fingerprint_id).first() as any;

    if (!fingerprint || fingerprint.times_listed < 2) {
        return { detected: false, details: {}, scores: {} };
    }

    // If item has been relisted multiple times, it's suspicious
    const relistCount = fingerprint.times_listed;
    const isSuspicious = relistCount >= 3;

    return {
        detected: isSuspicious,
        details: {
            timesRelisted: relistCount,
            note: 'Item has been relisted multiple times, suggesting winning bidders are not picking up'
        },
        scores: {}
    };
}

/**
 * Check for serial loser pattern - bidder very active but almost never wins
 */
async function checkSerialLoser(
    auctionId: number,
    env: Env
): Promise<{ detected: boolean; details: Record<string, unknown>; scores: Record<string, number> }> {
    // Get bidders in this auction
    const bidders = await env.DB.prepare(`
    SELECT DISTINCT bidder_id FROM bids WHERE auction_id = ?
  `).bind(auctionId).all();

    const serialLosers: Array<{ bidderId: string; auctions: number; wins: number; lossRate: number }> = [];
    const scores: Record<string, number> = {};

    for (const row of bidders.results as any[]) {
        const bidderId = row.bidder_id;

        // Get bidder stats
        const stats = await env.DB.prepare(`
      SELECT total_bids, total_wins, auctions_participated 
      FROM bidders WHERE bidder_id = ?
    `).bind(bidderId).first() as any;

        if (!stats || stats.auctions_participated < BIDFTA_THRESHOLDS.BIDDER_LOSS_STREAK) {
            continue;
        }

        const lossRate = 1 - (stats.total_wins / stats.auctions_participated);

        // Very high loss rate with high activity = suspicious
        if (lossRate > 0.9 && stats.total_bids >= 20) {
            serialLosers.push({
                bidderId,
                auctions: stats.auctions_participated,
                wins: stats.total_wins,
                lossRate
            });

            scores[bidderId] = lossRate * 0.9;
        }
    }

    return {
        detected: serialLosers.length > 0,
        details: { serialLosers },
        scores
    };
}

/**
 * Create item fingerprint from BidFTA item
 * BidFTA items have unique IDs in the URL like ?item=123456
 */
export function extractBidFTAItemId(url: string): string | null {
    // Pattern: https://www.bidfta.com/items?item=123456
    const match = url.match(/[?&]item=(\d+)/i);
    return match ? match[1] : null;
}

/**
 * Normalize BidFTA item name for fingerprinting
 */
export function normalizeBidFTAItemName(itemName: string): string {
    return itemName
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')  // Remove special chars
        .replace(/\s+/g, ' ')          // Normalize whitespace
        .trim()
        .split(' ')
        .filter(w => w.length > 2)     // Remove short words
        .sort()                         // Sort for consistency
        .join(' ');
}
