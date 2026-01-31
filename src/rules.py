"""
Explainable shill-bid detection rules engine
"""


class ShillBidRulesEngine:
    """
    Runs explainable rules to detect shill bidding patterns
    """
    
    # Rule thresholds
    HIGH_BID_RATIO_THRESHOLD = 0.4  # Bidder participates in >40% of bids
    HIGH_CONCENTRATION_THRESHOLD = 0.7  # Top 2 bidders make >70% of bids
    FREQUENT_PAIR_THRESHOLD = 3  # Same pair bids against each other >= 3 times
    
    def evaluate(self, features, bid_history):
        """
        Evaluate shill-bid detection rules on computed features
        
        Args:
            features (dict): Computed behavioral features
            bid_history (dict): Original bid history
            
        Returns:
            dict: Detection result with evidence
        """
        violations = []
        evidence = []
        
        # Rule 1: High bid ratio (single bidder dominates)
        high_ratio_bidders = self._check_high_bid_ratio(features)
        if high_ratio_bidders:
            violations.append('high_bid_ratio')
            evidence.append({
                'rule': 'High Bid Ratio',
                'description': f'Bidder(s) participate in unusually high percentage of bids',
                'details': high_ratio_bidders
            })
        
        # Rule 2: High bid concentration (few bidders dominate)
        if features['bid_concentration'] > self.HIGH_CONCENTRATION_THRESHOLD:
            violations.append('high_concentration')
            evidence.append({
                'rule': 'High Bid Concentration',
                'description': f'Top 2 bidders make {features["bid_concentration"]:.1%} of all bids',
                'details': {'concentration': features['bid_concentration']}
            })
        
        # Rule 3: Frequent bidding pairs (same bidders repeatedly compete)
        if features['bidding_pairs']:
            violations.append('frequent_pairs')
            evidence.append({
                'rule': 'Frequent Bidding Pairs',
                'description': 'Same bidders repeatedly bid against each other',
                'details': features['bidding_pairs']
            })
        
        # Rule 4: Bid inflation pattern (bidders drive price up but never win)
        inflation_bidders = self._check_bid_inflation(features)
        if inflation_bidders:
            violations.append('bid_inflation')
            evidence.append({
                'rule': 'Bid Inflation Pattern',
                'description': 'Bidders frequently bid but never win',
                'details': inflation_bidders
            })
        
        return {
            'auction_id': features['auction_id'],
            'is_suspicious': len(violations) > 0,
            'violations': violations,
            'evidence': evidence,
            'risk_level': self._calculate_risk_level(len(violations))
        }
    
    def _check_high_bid_ratio(self, features):
        """
        Check for bidders with unusually high bid ratios
        
        Args:
            features (dict): Computed features
            
        Returns:
            list: Bidders violating the rule
        """
        violators = []
        for bidder_id, bidder_features in features['bidder_features'].items():
            if bidder_features['bid_ratio'] > self.HIGH_BID_RATIO_THRESHOLD:
                violators.append({
                    'bidder_id': bidder_id,
                    'bid_ratio': bidder_features['bid_ratio'],
                    'bid_count': bidder_features['bid_count']
                })
        return violators
    
    def _check_bid_inflation(self, features):
        """
        Check for bidders who bid frequently but never win
        
        Args:
            features (dict): Computed features
            
        Returns:
            list: Bidders violating the rule
        """
        violators = []
        for bidder_id, bidder_features in features['bidder_features'].items():
            # Bidder made multiple bids but never won
            if bidder_features['bid_count'] >= 3 and bidder_features['never_won']:
                violators.append({
                    'bidder_id': bidder_id,
                    'bid_count': bidder_features['bid_count'],
                    'never_won': True
                })
        return violators
    
    def _calculate_risk_level(self, violation_count):
        """
        Calculate risk level based on number of violations
        
        Args:
            violation_count (int): Number of rule violations
            
        Returns:
            str: Risk level (LOW, MEDIUM, HIGH, CRITICAL)
        """
        if violation_count == 0:
            return 'NONE'
        elif violation_count == 1:
            return 'LOW'
        elif violation_count == 2:
            return 'MEDIUM'
        elif violation_count == 3:
            return 'HIGH'
        else:
            return 'CRITICAL'
