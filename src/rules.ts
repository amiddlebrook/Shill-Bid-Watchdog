/**
 * Shill Bid Detection Rules Engine
 * Ported from Python MVP with 4 explainable rules
 */

import type { AuctionFeatures, Evidence } from './types';

// Detection thresholds
const THRESHOLDS = {
    HIGH_BID_RATIO: 0.4,           // Bidder participates in >40% of bids
    HIGH_CONCENTRATION: 0.7,       // Top 2 bidders make >70% of bids
    FREQUENT_PAIR_COUNT: 3,        // Same pair bids against each other >= 3 times
    BID_INFLATION_MULTIPLIER: 5,   // Price increased by 5x or more
    MIN_BIDS_FOR_INFLATION: 3      // Minimum bids for inflation check
};

export interface RuleResults {
    violations: string[];
    evidence: Evidence[];
}

/**
 * Run all detection rules on auction features
 */
export function runDetectionRules(features: AuctionFeatures): RuleResults {
    const violations: string[] = [];
    const evidence: Evidence[] = [];

    // Rule 1: High Bid Ratio (single bidder dominates)
    const highRatioBidders = checkHighBidRatio(features);
    if (highRatioBidders.length > 0) {
        violations.push('high_bid_ratio');
        evidence.push({
            rule: 'High Bid Ratio',
            description: 'Bidder(s) participate in unusually high percentage of bids',
            details: {
                bidders: highRatioBidders.map(b => ({
                    bidderId: b.bidderId,
                    bidRatio: `${(b.bidRatio * 100).toFixed(1)}%`,
                    bidCount: b.bidCount
                }))
            }
        });
    }

    // Rule 2: High Bid Concentration (few bidders dominate)
    if (features.bidConcentration > THRESHOLDS.HIGH_CONCENTRATION) {
        violations.push('high_concentration');
        evidence.push({
            rule: 'High Bid Concentration',
            description: `Top 2 bidders made ${(features.bidConcentration * 100).toFixed(1)}% of all bids`,
            details: {
                concentration: features.bidConcentration,
                threshold: THRESHOLDS.HIGH_CONCENTRATION
            }
        });
    }

    // Rule 3: Frequent Bidding Pairs (same bidders repeatedly compete)
    if (features.biddingPairs.length > 0) {
        violations.push('frequent_pairs');
        evidence.push({
            rule: 'Frequent Bidding Pairs',
            description: 'Same bidders repeatedly bid against each other',
            details: {
                pairs: features.biddingPairs.map(p => ({
                    bidders: [p.bidderA, p.bidderB],
                    interactions: p.interactionCount
                }))
            }
        });
    }

    // Rule 4: Bid Inflation Pattern (bidders drive price up but never win)
    const inflationBidders = checkBidInflation(features);
    if (inflationBidders.length > 0) {
        violations.push('bid_inflation');
        evidence.push({
            rule: 'Bid Inflation Pattern',
            description: 'Bidders frequently bid but never win',
            details: {
                bidders: inflationBidders.map(b => ({
                    bidderId: b.bidderId,
                    bidCount: b.bidCount,
                    neverWon: true
                }))
            }
        });
    }

    return { violations, evidence };
}

/**
 * Rule 1: Check for bidders with unusually high bid ratios
 */
function checkHighBidRatio(features: AuctionFeatures): Array<{
    bidderId: string;
    bidRatio: number;
    bidCount: number;
}> {
    const violators: Array<{ bidderId: string; bidRatio: number; bidCount: number }> = [];

    for (const [bidderId, bf] of Object.entries(features.bidderFeatures)) {
        if (bf.bidRatio > THRESHOLDS.HIGH_BID_RATIO) {
            violators.push({
                bidderId,
                bidRatio: bf.bidRatio,
                bidCount: bf.bidCount
            });
        }
    }

    return violators;
}

/**
 * Rule 4: Check for bid inflation pattern
 * Bidders who make multiple bids but never win
 */
function checkBidInflation(features: AuctionFeatures): Array<{
    bidderId: string;
    bidCount: number;
}> {
    const violators: Array<{ bidderId: string; bidCount: number }> = [];

    for (const [bidderId, bf] of Object.entries(features.bidderFeatures)) {
        // Bidder made multiple bids but never won
        if (bf.bidCount >= THRESHOLDS.MIN_BIDS_FOR_INFLATION && bf.neverWon) {
            violators.push({
                bidderId,
                bidCount: bf.bidCount
            });
        }
    }

    return violators;
}

/**
 * Get rule descriptions for UI display
 */
export function getRuleDescriptions(): Array<{
    id: string;
    name: string;
    description: string;
    threshold: string;
}> {
    return [
        {
            id: 'high_bid_ratio',
            name: 'High Bid Ratio',
            description: 'Detects when a single bidder participates in an unusually high percentage of bids',
            threshold: `>${THRESHOLDS.HIGH_BID_RATIO * 100}% of bids`
        },
        {
            id: 'high_concentration',
            name: 'High Bid Concentration',
            description: 'Detects when top 2 bidders dominate the bidding',
            threshold: `>${THRESHOLDS.HIGH_CONCENTRATION * 100}% of bids`
        },
        {
            id: 'frequent_pairs',
            name: 'Frequent Bidding Pairs',
            description: 'Detects when same bidders repeatedly compete against each other',
            threshold: `>=${THRESHOLDS.FREQUENT_PAIR_COUNT} consecutive interactions`
        },
        {
            id: 'bid_inflation',
            name: 'Bid Inflation Pattern',
            description: 'Detects bidders who frequently bid but never win (price manipulation)',
            threshold: `>=${THRESHOLDS.MIN_BIDS_FOR_INFLATION} bids, never won`
        }
    ];
}
