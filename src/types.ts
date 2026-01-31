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
    AI: any;
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
    status: 'watching' | 'ended' | 'analyzed' | 'deleted';
    riskLevel: RiskLevel;
    riskScore: number;
    lastChecked?: string;
    bids?: Bid[];
    // BidFTA-specific fields
    lotCode?: string;           // Item ID that persists across relists (e.g., TEA2525531)
    auctionNumber?: string;     // Specific auction instance (e.g., AML2600499)
    msrp?: number;              // Manufacturer suggested retail price
    condition?: string;         // e.g., "Good Condition", "As Is"
    itemFingerprintId?: number; // FK to item_fingerprints table
    sellerId?: string;          // For BidFTA, always "BIDFTA"
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
