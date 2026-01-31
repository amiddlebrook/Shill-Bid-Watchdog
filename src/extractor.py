"""
Bid history extractor from auction page data
"""


class BidHistoryExtractor:
    """
    Extracts and structures bid history from scraped auction pages
    """
    
    def extract(self, auction_page):
        """
        Extract bid history from an auction page
        
        Args:
            auction_page (dict): Scraped auction page data
            
        Returns:
            dict: Structured bid history with metadata
        """
        return {
            'auction_id': auction_page['auction_id'],
            'item_name': auction_page['item_name'],
            'current_price': auction_page['current_price'],
            'total_bids': len(auction_page['bids']),
            'bids': auction_page['bids'],
            'bidders': self._extract_bidder_info(auction_page['bids'])
        }
    
    def _extract_bidder_info(self, bids):
        """
        Extract unique bidder information
        
        Args:
            bids (list): List of bid dictionaries
            
        Returns:
            dict: Bidder statistics
        """
        bidders = {}
        for bid in bids:
            bidder_id = bid['bidder_id']
            if bidder_id not in bidders:
                bidders[bidder_id] = {
                    'bid_count': 0,
                    'total_amount': 0,
                    'bids': []
                }
            bidders[bidder_id]['bid_count'] += 1
            bidders[bidder_id]['total_amount'] += bid['amount']
            bidders[bidder_id]['bids'].append(bid)
        
        return bidders
