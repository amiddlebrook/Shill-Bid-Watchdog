/**
 * Behavior Feature Computation
 * Ported from Python MVP
 */

import type { Bid, AuctionFeatures, BidderFeatures, BiddingPair } from './types';

/**
 * Compute all behavioral features for an auction
 */
export function computeFeatures(auctionId: string, bids: Bid[]): AuctionFeatures {
    const totalBids = bids.length;
    const bidderMap = groupBidsByBidder(bids);
    const uniqueBidders = Object.keys(bidderMap).length;

    // Compute features for each bidder
    const bidderFeatures: Record<string, BidderFeatures> = {};
    const highestBidAmount = Math.max(...bids.map(b => b.amount), 0);

    for (const [bidderId, bidderBids] of Object.entries(bidderMap)) {
        bidderFeatures[bidderId] = computeBidderFeatures(
            bidderId,
            bidderBids,
            totalBids,
            highestBidAmount
        );
    }

    // Compute bid concentration (top 2 bidders)
    const bidConcentration = computeBidConcentration(bidderFeatures, totalBids);

    // Detect frequent bidding pairs
    const biddingPairs = detectBiddingPairs(bids, auctionId);

    // Compute price inflation
    const priceInflation = computePriceInflation(bids);

    return {
        auctionId,
        totalBids,
        uniqueBidders,
        bidConcentration,
        bidderFeatures,
        biddingPairs,
        priceInflation
    };
}

/**
 * Group bids by bidder
 */
function groupBidsByBidder(bids: Bid[]): Record<string, Bid[]> {
    const groups: Record<string, Bid[]> = {};

    for (const bid of bids) {
        if (!groups[bid.bidderId]) {
            groups[bid.bidderId] = [];
        }
        groups[bid.bidderId].push(bid);
    }

    return groups;
}

/**
 * Compute features for a single bidder
 */
function computeBidderFeatures(
    bidderId: string,
    bidderBids: Bid[],
    totalBids: number,
    highestBidAmount: number
): BidderFeatures {
    const bidCount = bidderBids.length;
    const bidRatio = totalBids > 0 ? bidCount / totalBids : 0;

    const totalAmount = bidderBids.reduce((sum, b) => sum + b.amount, 0);
    const avgBidAmount = bidCount > 0 ? totalAmount / bidCount : 0;

    // Check if this bidder's highest bid is the auction winner
    const bidderHighest = Math.max(...bidderBids.map(b => b.amount));
    const neverWon = bidderHighest < highestBidAmount;

    // Calculate timing if available
    const bidTimings: number[] = [];
    const sortedBids = [...bidderBids].sort((a, b) => {
        if (!a.bidTime || !b.bidTime) return 0;
        return new Date(a.bidTime).getTime() - new Date(b.bidTime).getTime();
    });

    for (let i = 1; i < sortedBids.length; i++) {
        if (sortedBids[i].bidTime && sortedBids[i - 1].bidTime) {
            const diff = new Date(sortedBids[i].bidTime!).getTime() -
                new Date(sortedBids[i - 1].bidTime!).getTime();
            bidTimings.push(diff);
        }
    }

    return {
        bidderId,
        bidCount,
        bidRatio,
        avgBidAmount,
        neverWon,
        bidTimings: bidTimings.length > 0 ? bidTimings : undefined
    };
}

/**
 * Compute bid concentration (percentage of bids from top 2 bidders)
 */
function computeBidConcentration(
    bidderFeatures: Record<string, BidderFeatures>,
    totalBids: number
): number {
    if (totalBids === 0) return 0;

    const bidCounts = Object.values(bidderFeatures)
        .map(bf => bf.bidCount)
        .sort((a, b) => b - a);

    const top2Bids = bidCounts.slice(0, 2).reduce((sum, c) => sum + c, 0);
    return top2Bids / totalBids;
}

/**
 * Detect pairs of bidders who frequently bid against each other
 */
function detectBiddingPairs(bids: Bid[], auctionId: string): BiddingPair[] {
    // Sort bids by order
    const sortedBids = [...bids].sort((a, b) => (a.bidOrder || 0) - (b.bidOrder || 0));

    // Count consecutive bidding interactions
    const pairCounts: Record<string, number> = {};

    for (let i = 1; i < sortedBids.length; i++) {
        const currentBidder = sortedBids[i].bidderId;
        const prevBidder = sortedBids[i - 1].bidderId;

        if (currentBidder !== prevBidder) {
            // Create consistent key (alphabetical order)
            const [a, b] = [currentBidder, prevBidder].sort();
            const key = `${a}::${b}`;
            pairCounts[key] = (pairCounts[key] || 0) + 1;
        }
    }

    // Filter frequent pairs (>= 3 interactions)
    const frequentPairs: BiddingPair[] = [];
    const THRESHOLD = 3;

    for (const [key, count] of Object.entries(pairCounts)) {
        if (count >= THRESHOLD) {
            const [bidderA, bidderB] = key.split('::');

            // Calculate suspicion score based on interaction frequency
            const suspicionScore = Math.min(count / 10, 1.0);

            frequentPairs.push({
                bidderA,
                bidderB,
                interactionCount: count,
                auctionIds: [auctionId],
                suspicionScore
            });
        }
    }

    return frequentPairs;
}

/**
 * Compute price inflation ratio
 */
function computePriceInflation(bids: Bid[]): number {
    if (bids.length < 2) return 0;

    const sortedBids = [...bids].sort((a, b) => (a.bidOrder || 0) - (b.bidOrder || 0));
    const startPrice = sortedBids[0].amount;
    const endPrice = sortedBids[sortedBids.length - 1].amount;

    if (startPrice === 0) return 0;

    return (endPrice - startPrice) / startPrice;
}
