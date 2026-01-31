/**
 * ShillBid Watchdog - Type Definitions
 */

// ============================================================================
// Cloudflare Bindings
// ============================================================================

export interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    BROWSER: Fetcher;
    AI: Ai;
    VECTORS: VectorizeIndex;
    COORDINATOR: DurableObjectNamespace;
    ENVIRONMENT: string;
}

// ============================================================================
// Risk Levels
// ============================================================================

export type RiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_COLORS: Record<RiskLevel, string> = {
    NONE: '#2ed573',
    LOW: '#3498db',
    MEDIUM: '#ffa502',
    HIGH: '#ff793f',
    CRITICAL: '#ff4757',
};

// ============================================================================
// Domain Models
// ============================================================================

export interface Bid {
    id?: number;
    auctionId: number;
    bidderId: string;
    amount: number;
    bidTime?: string;
    bidOrder?: number;
}

export interface Auction {
    id?: number;
    auctionId: string;
    source: 'bidfta' | 'ebay' | 'other';
    url: string;
    itemName?: string;
    currentPrice?: number;
    startPrice?: number;
    endTime?: string;
    status: 'watching' | 'ended' | 'analyzed';
    riskLevel: RiskLevel;
    riskScore: number;
    lastChecked?: string;
    bids?: Bid[];
}

export interface Bidder {
    id?: number;
    bidderId: string;
    displayName?: string;
    totalBids: number;
    totalWins: number;
    auctionsParticipated: number;
    avgBidRatio: number;
    suspicionScore: number;
}

export interface Alert {
    id?: number;
    auctionId: number;
    riskLevel: RiskLevel;
    summary: string;
    violations: string[];
    evidence: Evidence[];
    mlConfidence?: number;
    acknowledged: boolean;
    createdAt?: string;
}

export interface Evidence {
    rule: string;
    description: string;
    details: Record<string, unknown>;
}

export interface BiddingPair {
    bidderA: string;
    bidderB: string;
    interactionCount: number;
    auctionIds: string[];
    suspicionScore: number;
}

// ============================================================================
// Feature Computation
// ============================================================================

export interface BidderFeatures {
    bidderId: string;
    bidCount: number;
    bidRatio: number;
    avgBidAmount: number;
    neverWon: boolean;
    bidTimings?: number[]; // milliseconds between bids
}

export interface AuctionFeatures {
    auctionId: string;
    totalBids: number;
    uniqueBidders: number;
    bidConcentration: number;
    bidderFeatures: Record<string, BidderFeatures>;
    biddingPairs: BiddingPair[];
    priceInflation?: number;
}

// ============================================================================
// Detection Results
// ============================================================================

export interface DetectionResult {
    auctionId: string;
    isSuspicious: boolean;
    riskLevel: RiskLevel;
    riskScore: number;
    violations: string[];
    evidence: Evidence[];
    mlConfidence?: number;
}

// ============================================================================
// Agent Types
// ============================================================================

export type TaskType =
    | 'navigate_auction'
    | 'extract_bids'
    | 'analyze_auction'
    | 'update_bidder_profile'
    | 'check_auction_status';

export interface AgentTask {
    id?: number;
    taskType: TaskType;
    targetUrl?: string;
    auctionId?: number;
    status: 'pending' | 'running' | 'completed' | 'failed';
    attempts: number;
    lastError?: string;
    scheduledAt: string;
    completedAt?: string;
}

export interface NavigationResult {
    success: boolean;
    auctionId?: string;
    itemName?: string;
    currentPrice?: number;
    bids?: Array<{
        bidderId: string;
        amount: number;
        bidTime?: string;
    }>;
    error?: string;
    screenshot?: ArrayBuffer;
}

// ============================================================================
// API Request/Response
// ============================================================================

export interface WatchAuctionRequest {
    url: string;
    source?: 'bidfta' | 'ebay';
}

export interface AnalyzeRequest {
    auctionId?: string;
    bids?: Array<{
        bidderId: string;
        amount: number;
        bidTime?: string;
    }>;
}

export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
}
