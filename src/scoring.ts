/**
 * Risk Scoring System
 * Computes numerical risk scores (0.0 to 1.0)
 */

import type { AuctionFeatures, RiskLevel } from './types';
import type { RuleResults } from './rules';

// Scoring weights for different factors
const WEIGHTS = {
    high_bid_ratio: 0.25,
    high_concentration: 0.20,
    frequent_pairs: 0.20,
    bid_inflation: 0.15,
    ml_signal: 0.10,
    rapid_bidding: 0.05,
    price_inflation: 0.05
};

/**
 * Calculate overall risk score for an auction
 */
export function calculateRiskScore(
    features: AuctionFeatures,
    ruleResults: RuleResults
): number {
    let score = 0;

    // Score from rule violations
    for (const violation of ruleResults.violations) {
        const weight = WEIGHTS[violation as keyof typeof WEIGHTS] || 0.1;
        score += weight;
    }

    // Add continuous scores based on feature values

    // Bid concentration score (0 to 0.2)
    const concentrationScore = Math.min(features.bidConcentration / 0.7, 1) * 0.2;
    score += concentrationScore;

    // Score from bidding pairs
    if (features.biddingPairs.length > 0) {
        const pairScore = Math.min(features.biddingPairs.length / 3, 1) * 0.1;
        score += pairScore;
    }

    // Score from bidder features
    const bidderScores = Object.values(features.bidderFeatures).map(bf => {
        let bidderScore = 0;

        // High participation
        if (bf.bidRatio > 0.3) {
            bidderScore += bf.bidRatio * 0.3;
        }

        // Never won pattern
        if (bf.neverWon && bf.bidCount >= 3) {
            bidderScore += 0.2;
        }

        return bidderScore;
    });

    // Take average of top suspicious bidders
    const topBidderScores = bidderScores.sort((a, b) => b - a).slice(0, 2);
    const avgBidderScore = topBidderScores.length > 0
        ? topBidderScores.reduce((a, b) => a + b, 0) / topBidderScores.length
        : 0;

    score += avgBidderScore * 0.15;

    // Price inflation score
    if (features.priceInflation && features.priceInflation > 2) {
        score += Math.min(features.priceInflation / 10, 1) * 0.05;
    }

    // Clamp to 0-1 range
    return Math.min(Math.max(score, 0), 1);
}

/**
 * Convert numerical score to risk level
 */
export function getRiskLevel(score: number): RiskLevel {
    if (score < 0.2) return 'NONE';
    if (score < 0.4) return 'LOW';
    if (score < 0.6) return 'MEDIUM';
    if (score < 0.8) return 'HIGH';
    return 'CRITICAL';
}

/**
 * Get risk level from violation count (alternative method)
 */
export function getRiskLevelFromViolations(violationCount: number): RiskLevel {
    if (violationCount === 0) return 'NONE';
    if (violationCount === 1) return 'LOW';
    if (violationCount === 2) return 'MEDIUM';
    if (violationCount === 3) return 'HIGH';
    return 'CRITICAL';
}

/**
 * Calculate score for a single bidder
 */
export function calculateBidderScore(
    bidderFeatures: {
        bidRatio: number;
        bidCount: number;
        neverWon: boolean;
        avgBidAmount: number;
    },
    inFrequentPair: boolean
): number {
    let score = 0;

    // High bid ratio
    if (bidderFeatures.bidRatio > 0.4) {
        score += 0.3;
    } else if (bidderFeatures.bidRatio > 0.3) {
        score += 0.15;
    }

    // Never won with many bids
    if (bidderFeatures.neverWon && bidderFeatures.bidCount >= 3) {
        score += 0.25;
    }

    // Part of frequent pair
    if (inFrequentPair) {
        score += 0.2;
    }

    // Many bids total
    if (bidderFeatures.bidCount >= 5) {
        score += 0.1;
    }

    return Math.min(score, 1);
}

/**
 * Risk level metadata for UI
 */
export const RISK_METADATA: Record<RiskLevel, {
    label: string;
    color: string;
    bgColor: string;
    description: string;
}> = {
    NONE: {
        label: 'No Risk',
        color: '#2ed573',
        bgColor: 'rgba(46, 213, 115, 0.1)',
        description: 'No suspicious patterns detected'
    },
    LOW: {
        label: 'Low Risk',
        color: '#3498db',
        bgColor: 'rgba(52, 152, 219, 0.1)',
        description: '1 rule violation detected'
    },
    MEDIUM: {
        label: 'Medium Risk',
        color: '#ffa502',
        bgColor: 'rgba(255, 165, 2, 0.1)',
        description: '2 rule violations detected'
    },
    HIGH: {
        label: 'High Risk',
        color: '#ff793f',
        bgColor: 'rgba(255, 121, 63, 0.1)',
        description: '3 rule violations detected'
    },
    CRITICAL: {
        label: 'Critical Risk',
        color: '#ff4757',
        bgColor: 'rgba(255, 71, 87, 0.1)',
        description: '4+ rule violations detected'
    }
};
