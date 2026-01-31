"""
Behavior feature computation for shill bid detection
"""


class BehaviorFeatureComputer:
    """
    Computes behavioral features from bid histories to detect shill bidding
    """
    
    def compute(self, bid_history):
        """
        Compute behavior features from bid history
        
        Args:
            bid_history (dict): Extracted bid history
            
        Returns:
            dict: Computed behavioral features
        """
        features = {
            'auction_id': bid_history['auction_id'],
            'total_bids': bid_history['total_bids'],
            'unique_bidders': len(bid_history['bidders']),
            'bidder_features': {}
        }
        
        # Compute features for each bidder
        for bidder_id, bidder_data in bid_history['bidders'].items():
            bidder_features = self._compute_bidder_features(
                bidder_id, 
                bidder_data,
                bid_history
            )
            features['bidder_features'][bidder_id] = bidder_features
        
        # Compute auction-level features
        features['bid_concentration'] = self._compute_bid_concentration(bid_history)
        features['bidding_pairs'] = self._detect_bidding_pairs(bid_history)
        
        return features
    
    def _compute_bidder_features(self, bidder_id, bidder_data, bid_history):
        """
        Compute features for a single bidder
        
        Args:
            bidder_id (str): Bidder identifier
            bidder_data (dict): Bidder's bid data
            bid_history (dict): Full bid history
            
        Returns:
            dict: Bidder-specific features
        """
        bid_count = bidder_data['bid_count']
        total_bids = bid_history['total_bids']
        
        return {
            'bid_count': bid_count,
            'bid_ratio': bid_count / total_bids if total_bids > 0 else 0,
            'avg_bid_amount': bidder_data['total_amount'] / bid_count if bid_count > 0 else 0,
            'never_won': bidder_data['bids'][-1]['amount'] < bid_history['current_price'] if bid_count > 0 else True
        }
    
    def _compute_bid_concentration(self, bid_history):
        """
        Compute how concentrated bidding is among few bidders
        
        Args:
            bid_history (dict): Extracted bid history
            
        Returns:
            float: Concentration ratio (higher = more concentrated)
        """
        if len(bid_history['bidders']) == 0:
            return 0
        
        # Find top 2 bidders by bid count
        bidder_counts = [(data['bid_count'], bidder_id) 
                         for bidder_id, data in bid_history['bidders'].items()]
        bidder_counts.sort(reverse=True)
        
        top_2_bids = sum(count for count, _ in bidder_counts[:2])
        total_bids = bid_history['total_bids']
        
        return top_2_bids / total_bids if total_bids > 0 else 0
    
    def _detect_bidding_pairs(self, bid_history):
        """
        Detect pairs of bidders who frequently bid against each other
        
        Args:
            bid_history (dict): Extracted bid history
            
        Returns:
            list: List of detected bidding pairs
        """
        bids = bid_history['bids']
        pairs = []
        
        # Look for consecutive bidding patterns
        for i in range(len(bids) - 1):
            current_bidder = bids[i]['bidder_id']
            next_bidder = bids[i + 1]['bidder_id']
            
            if current_bidder != next_bidder:
                pair = tuple(sorted([current_bidder, next_bidder]))
                pairs.append(pair)
        
        # Count pair occurrences
        pair_counts = {}
        for pair in pairs:
            pair_counts[pair] = pair_counts.get(pair, 0) + 1
        
        # Return pairs that bid against each other frequently (>= 3 times)
        frequent_pairs = [
            {'bidders': list(pair), 'count': count}
            for pair, count in pair_counts.items()
            if count >= 3
        ]
        
        return frequent_pairs
