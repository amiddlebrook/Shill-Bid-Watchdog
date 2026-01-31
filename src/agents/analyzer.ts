/**
 * Analyzer Agent - ML + Rules Engine
 * Runs detection analysis on auction bid history
 */

import type {
    Env,
    Bid,
    DetectionResult,
    AuctionFeatures,
    BidderFeatures,
    Evidence,
    RiskLevel,
    BiddingPair
} from '../types';
import { computeFeatures } from '../features';
import { runDetectionRules } from '../rules';
import { runHistoricalDetection } from '../historical';
import { calculateRiskScore, getRiskLevel } from '../scoring';

/**
 * Main analysis function - coordinates feature computation, ML, and rules
 */
export async function analyzeAuction(
    auctionId: number,
    bids: Array<{ bidder_id: string; amount: number; bid_time?: string; bid_order?: number }>,
    env: Env
): Promise<DetectionResult> {
    // Convert DB format to domain format
    const formattedBids: Bid[] = bids.map((b, i) => ({
        auctionId,
        bidderId: b.bidder_id,
        amount: b.amount,
        bidTime: b.bid_time,
        bidOrder: b.bid_order ?? i + 1
    }));

    // Step 1: Compute behavioral features
    const features = computeFeatures(auctionId.toString(), formattedBids);

    // Step 2: Run rule-based detection (rules 1-4)
    const ruleResults = runDetectionRules(features);

    // Step 3: Run historical pattern detection (rules 5-7)
    let historicalResults = { violations: [] as string[], evidence: [] as Evidence[], suspicionScores: {} };
    try {
        historicalResults = await runHistoricalDetection(auctionId, env);
    } catch (error) {
        console.error('Historical detection failed:', error);
    }

    // Combine all violations and evidence
    const allViolations = [...ruleResults.violations, ...historicalResults.violations];
    const allEvidence = [...ruleResults.evidence, ...historicalResults.evidence];

    // Step 4: Calculate risk score (now includes historical patterns)
    const riskScore = calculateRiskScore(features, { violations: allViolations, evidence: allEvidence });
    const riskLevel = getRiskLevel(riskScore);

    // Step 5: ML-enhanced analysis (embeddings + similarity)
    let mlConfidence: number | undefined;
    try {
        mlConfidence = await runMLAnalysis(features, env);
    } catch (error) {
        console.error('ML analysis failed:', error);
    }

    // Step 6: Generate alert if suspicious
    const isSuspicious = allViolations.length > 0 || riskScore > 0.4;

    if (isSuspicious) {
        await createAlert(auctionId, riskLevel, riskScore, { violations: allViolations, evidence: allEvidence }, mlConfidence, env);
    }

    // Step 7: Update auction risk in database
    await env.DB.prepare(`
    UPDATE auctions 
    SET risk_level = ?, risk_score = ?, last_checked = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(riskLevel, riskScore, auctionId).run();

    // Step 8: Update bidder suspicion scores (including historical scores)
    await updateBidderScores(features, historicalResults.suspicionScores, env);

    // Step 9: Update bidding pairs
    await updateBiddingPairs(features, env);

    return {
        auctionId: auctionId.toString(),
        isSuspicious,
        riskLevel,
        riskScore,
        violations: allViolations,
        evidence: allEvidence,
        mlConfidence
    };
}

/**
 * Run ML-enhanced analysis using Workers AI
 */
async function runMLAnalysis(
    features: AuctionFeatures,
    env: Env
): Promise<number> {
    // Create text representation of bid pattern
    const patternText = createPatternDescription(features);

    // Generate embedding using BGE model
    const embeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
        text: patternText
    });

    if (!embeddingResponse.data?.[0]) {
        return 0.5; // Default confidence
    }

    const embedding = embeddingResponse.data[0];

    // Query Vectorize for similar patterns
    try {
        const similar = await env.VECTORS.query(embedding, {
            topK: 5,
            returnMetadata: true
        });

        if (similar.matches?.length > 0) {
            // Calculate confidence based on similarity to known shill patterns
            const avgSimilarity = similar.matches.reduce((sum, m) => sum + (m.score || 0), 0) / similar.matches.length;
            return avgSimilarity;
        }
    } catch {
        // Vectorize might not have data yet
    }

    // Store this pattern for future comparison
    try {
        await env.VECTORS.upsert([{
            id: `auction-${features.auctionId}-${Date.now()}`,
            values: embedding,
            metadata: {
                auctionId: features.auctionId,
                isSuspicious: features.bidConcentration > 0.7,
                bidCount: features.totalBids,
                concentration: features.bidConcentration
            }
        }]);
    } catch {
        // Ignore upsert errors
    }

    return 0.5; // Default confidence
}

/**
 * Create text description of bid pattern for embedding
 */
function createPatternDescription(features: AuctionFeatures): string {
    const parts: string[] = [];

    parts.push(`Auction with ${features.totalBids} total bids from ${features.uniqueBidders} unique bidders.`);
    parts.push(`Bid concentration: ${(features.bidConcentration * 100).toFixed(1)}%.`);

    // Describe top bidders
    const sortedBidders = Object.entries(features.bidderFeatures)
        .sort(([, a], [, b]) => b.bidRatio - a.bidRatio);

    for (const [bidderId, bf] of sortedBidders.slice(0, 3)) {
        parts.push(`Bidder ${bidderId}: ${(bf.bidRatio * 100).toFixed(1)}% of bids, ${bf.bidCount} total, ${bf.neverWon ? 'never won' : 'has won'}.`);
    }

    // Describe bidding pairs
    if (features.biddingPairs.length > 0) {
        parts.push(`Detected ${features.biddingPairs.length} frequent bidding pair(s).`);
        for (const pair of features.biddingPairs.slice(0, 2)) {
            parts.push(`Pair ${pair.bidderA}-${pair.bidderB}: ${pair.interactionCount} interactions.`);
        }
    }

    return parts.join(' ');
}

/**
 * Create alert record in database
 */
async function createAlert(
    auctionId: number,
    riskLevel: RiskLevel,
    riskScore: number,
    ruleResults: { violations: string[]; evidence: Evidence[] },
    mlConfidence: number | undefined,
    env: Env
): Promise<void> {
    const summary = generateAlertSummary(ruleResults.violations, riskLevel);

    await env.DB.prepare(`
    INSERT INTO alerts (auction_id, risk_level, summary, violations, evidence, ml_confidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
        auctionId,
        riskLevel,
        summary,
        JSON.stringify(ruleResults.violations),
        JSON.stringify(ruleResults.evidence),
        mlConfidence ?? null
    ).run();
}

/**
 * Generate human-readable alert summary
 */
function generateAlertSummary(violations: string[], riskLevel: RiskLevel): string {
    const violationCount = violations.length;

    if (violationCount === 0) {
        return `Elevated risk detected - Risk Level: ${riskLevel}`;
    }

    const violationTypes = violations.map(v => {
        switch (v) {
            case 'high_bid_ratio': return 'abnormal bid ratio';
            case 'high_concentration': return 'bid concentration';
            case 'frequent_pairs': return 'suspicious bidding pairs';
            case 'bid_inflation': return 'bid inflation pattern';
            case 'seller_follower': return 'seller follower pattern';
            case 'relist_shill': return 'relist shill pattern';
            case 'loss_leader': return 'loss leader pattern';
            default: return v;
        }
    });

    return `Detected ${violationCount} suspicious pattern(s): ${violationTypes.join(', ')} - Risk Level: ${riskLevel}`;
}

/**
 * Update bidder suspicion scores
 */
async function updateBidderScores(
    features: AuctionFeatures,
    historicalScores: Record<string, number>,
    env: Env
): Promise<void> {
    for (const [bidderId, bf] of Object.entries(features.bidderFeatures)) {
        // Calculate individual suspicion score
        let score = 0;

        if (bf.bidRatio > 0.4) score += 0.3;
        if (bf.neverWon && bf.bidCount >= 3) score += 0.3;

        // Check if part of frequent pair
        const inPair = features.biddingPairs.some(
            p => p.bidderA === bidderId || p.bidderB === bidderId
        );
        if (inPair) score += 0.2;

        // Add historical pattern score if available
        if (historicalScores[bidderId]) {
            score = Math.max(score, historicalScores[bidderId]);
        }

        await env.DB.prepare(`
      UPDATE bidders 
      SET suspicion_score = (suspicion_score + ?) / 2,
          avg_bid_ratio = (avg_bid_ratio + ?) / 2,
          auctions_participated = auctions_participated + 1
      WHERE bidder_id = ?
    `).bind(score, bf.bidRatio, bidderId).run();
    }
}

/**
 * Update bidding pairs table
 */
async function updateBiddingPairs(
    features: AuctionFeatures,
    env: Env
): Promise<void> {
    for (const pair of features.biddingPairs) {
        // Ensure consistent ordering (alphabetical)
        const [bidderA, bidderB] = [pair.bidderA, pair.bidderB].sort();

        await env.DB.prepare(`
      INSERT INTO bidding_pairs (bidder_a, bidder_b, interaction_count, auction_ids, suspicion_score)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bidder_a, bidder_b) DO UPDATE SET
        interaction_count = interaction_count + excluded.interaction_count,
        auction_ids = excluded.auction_ids,
        suspicion_score = (suspicion_score + excluded.suspicion_score) / 2,
        updated_at = datetime('now')
    `).bind(
            bidderA,
            bidderB,
            pair.interactionCount,
            JSON.stringify(pair.auctionIds),
            pair.suspicionScore
        ).run();
    }
}
