"""
Shill bid scoring system
Computes numerical risk scores for bidders and auctions
"""

from typing import Dict, Any, List
from dataclasses import dataclass

from src.config import config


@dataclass
class BidderScore:
    """Score result for a single bidder"""
    bidder_id: str
    total_score: float
    components: Dict[str, float]
    risk_factors: List[str]


@dataclass
class AuctionScore:
    """Score result for an auction"""
    auction_id: str
    total_score: float
    bidder_scores: List[BidderScore]
    risk_factors: List[str]


class ShillBidScorer:
    """
    Computes numerical shill bid risk scores
    Scores range from 0.0 (no risk) to 1.0 (maximum risk)
    """
    
    # Scoring weights for different factors
    WEIGHTS = {
        'bid_ratio': 0.25,
        'concentration': 0.20,
        'bidding_pairs': 0.20,
        'never_won': 0.15,
        'rapid_bidding': 0.10,
        'bid_increment': 0.10,
    }
    
    def score_bidder(
        self, 
        bidder_id: str, 
        bidder_features: Dict[str, Any],
        auction_features: Dict[str, Any]
    ) -> BidderScore:
        """
        Compute risk score for a single bidder
        
        Args:
            bidder_id: Bidder identifier
            bidder_features: Features computed for this bidder
            auction_features: Features computed for the auction
            
        Returns:
            BidderScore: Score result with components
        """
        components = {}
        risk_factors = []
        
        # Score bid ratio (how much of auction's bids are from this bidder)
        bid_ratio = bidder_features.get('bid_ratio', 0)
        bid_ratio_score = min(bid_ratio / config.HIGH_BID_RATIO_THRESHOLD, 1.0)
        components['bid_ratio'] = bid_ratio_score
        if bid_ratio > config.HIGH_BID_RATIO_THRESHOLD:
            risk_factors.append(f"High bid ratio: {bid_ratio:.1%}")
        
        # Score never winning pattern
        never_won = bidder_features.get('never_won', False)
        bid_count = bidder_features.get('bid_count', 0)
        if never_won and bid_count >= 3:
            components['never_won'] = 1.0
            risk_factors.append(f"Made {bid_count} bids but never won")
        else:
            components['never_won'] = 0.0
        
        # Check if bidder is part of frequent bidding pairs
        bidding_pairs = auction_features.get('bidding_pairs', [])
        pair_score = 0.0
        for pair in bidding_pairs:
            if bidder_id in pair.get('bidders', []):
                pair_count = pair.get('count', 0)
                pair_score = min(pair_count / (config.FREQUENT_PAIR_THRESHOLD * 2), 1.0)
                risk_factors.append(f"Frequent bidding pair ({pair_count} interactions)")
                break
        components['bidding_pairs'] = pair_score
        
        # Default scores for components not yet computed
        components['concentration'] = 0.0
        components['rapid_bidding'] = 0.0
        components['bid_increment'] = 0.0
        
        # Calculate weighted total score
        total_score = sum(
            components.get(key, 0) * weight 
            for key, weight in self.WEIGHTS.items()
        )
        
        return BidderScore(
            bidder_id=bidder_id,
            total_score=min(total_score, 1.0),
            components=components,
            risk_factors=risk_factors
        )
    
    def score_auction(self, features: Dict[str, Any]) -> AuctionScore:
        """
        Compute risk score for an auction
        
        Args:
            features: Computed behavioral features for the auction
            
        Returns:
            AuctionScore: Score result with bidder scores
        """
        bidder_scores = []
        all_risk_factors = []
        
        # Score each bidder
        for bidder_id, bidder_features in features.get('bidder_features', {}).items():
            score = self.score_bidder(bidder_id, bidder_features, features)
            bidder_scores.append(score)
            all_risk_factors.extend(score.risk_factors)
        
        # Add auction-level risk factors
        concentration = features.get('bid_concentration', 0)
        if concentration > config.HIGH_CONCENTRATION_THRESHOLD:
            all_risk_factors.append(f"High bid concentration: {concentration:.1%}")
        
        if features.get('bidding_pairs'):
            pair_count = len(features['bidding_pairs'])
            all_risk_factors.append(f"Detected {pair_count} frequent bidding pair(s)")
        
        # Calculate auction-level score (average of top suspicious bidders)
        if bidder_scores:
            # Take top 2 most suspicious bidders
            sorted_scores = sorted(bidder_scores, key=lambda x: x.total_score, reverse=True)
            top_scores = [s.total_score for s in sorted_scores[:2]]
            total_score = sum(top_scores) / len(top_scores)
        else:
            total_score = 0.0
        
        # Adjust for concentration
        concentration_bonus = min(concentration / config.HIGH_CONCENTRATION_THRESHOLD, 1.0) * 0.2
        total_score = min(total_score + concentration_bonus, 1.0)
        
        return AuctionScore(
            auction_id=features.get('auction_id', 'unknown'),
            total_score=total_score,
            bidder_scores=bidder_scores,
            risk_factors=list(set(all_risk_factors))  # Remove duplicates
        )
    
    def get_risk_level(self, score: float) -> str:
        """
        Convert numerical score to risk level
        
        Args:
            score: Numerical score (0.0 to 1.0)
            
        Returns:
            str: Risk level string
        """
        if score < 0.2:
            return 'NONE'
        elif score < 0.4:
            return 'LOW'
        elif score < 0.6:
            return 'MEDIUM'
        elif score < 0.8:
            return 'HIGH'
        else:
            return 'CRITICAL'
