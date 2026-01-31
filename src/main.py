"""
Main entry point for ShillBidWatchdog MVP
"""

import sys
from src.scraper import AuctionScraper
from src.extractor import BidHistoryExtractor
from src.features import BehaviorFeatureComputer
from src.rules import ShillBidRulesEngine
from src.alerts import AlertGenerator


def main():
    """
    Main execution flow:
    1. Scrape public auction pages
    2. Extract bid histories
    3. Compute behavior features
    4. Run explainable shill-bid rules
    5. Emit evidence-backed alerts
    """
    print("=" * 60)
    print("ShillBidWatchdog MVP - Shill Bidder Detection")
    print("=" * 60)
    print()
    
    # Step 1: Scrape public auction pages
    print("[1/5] Scraping public auction pages...")
    scraper = AuctionScraper()
    auction_pages = scraper.scrape_sample_auctions()
    print(f"  → Scraped {len(auction_pages)} auction pages")
    print()
    
    # Step 2: Extract bid histories
    print("[2/5] Extracting bid histories...")
    extractor = BidHistoryExtractor()
    bid_histories = []
    for page in auction_pages:
        history = extractor.extract(page)
        bid_histories.append(history)
    print(f"  → Extracted {len(bid_histories)} bid histories")
    print()
    
    # Step 3: Compute behavior features
    print("[3/5] Computing behavior features...")
    feature_computer = BehaviorFeatureComputer()
    all_features = []
    for history in bid_histories:
        features = feature_computer.compute(history)
        all_features.append(features)
    print(f"  → Computed features for {len(all_features)} auctions")
    print()
    
    # Step 4: Run explainable shill-bid rules
    print("[4/5] Running shill-bid detection rules...")
    rules_engine = ShillBidRulesEngine()
    detections = []
    for i, features in enumerate(all_features):
        detection = rules_engine.evaluate(features, bid_histories[i])
        if detection['is_suspicious']:
            detections.append(detection)
    print(f"  → Found {len(detections)} suspicious bidding patterns")
    print()
    
    # Step 5: Emit evidence-backed alerts
    print("[5/5] Generating alerts...")
    alert_generator = AlertGenerator()
    alerts = alert_generator.generate(detections)
    print(f"  → Generated {len(alerts)} alerts")
    print()
    
    # Display alerts
    if alerts:
        print("=" * 60)
        print("ALERTS - Suspicious Shill Bidding Detected")
        print("=" * 60)
        for alert in alerts:
            alert_generator.display(alert)
    else:
        print("=" * 60)
        print("No suspicious shill bidding patterns detected.")
        print("=" * 60)
    
    print()
    print("ShillBidWatchdog MVP run complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
