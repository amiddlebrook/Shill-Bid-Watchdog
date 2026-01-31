# ShillBidWatchdog (MVP)

External-only watchdog for detecting likely shill bidders in online auction houses.

## MVP Goals
- ✅ Scrape public auction pages
- ✅ Extract bid histories
- ✅ Compute behavior features
- ✅ Run explainable shill-bid rules
- ✅ Emit evidence-backed alerts

No internal APIs. No auth bypass.

## Features

### Detection Rules
The system uses multiple explainable rules to detect shill bidding:

1. **High Bid Ratio**: Detects when a single bidder participates in >40% of all bids
2. **High Bid Concentration**: Detects when top 2 bidders make >70% of all bids
3. **Frequent Bidding Pairs**: Detects when same bidders repeatedly compete against each other
4. **Bid Inflation Pattern**: Detects bidders who frequently bid but never win

### Risk Levels
- **NONE**: No suspicious patterns detected
- **LOW**: 1 rule violation
- **MEDIUM**: 2 rule violations
- **HIGH**: 3 rule violations
- **CRITICAL**: 4+ rule violations

## Installation

```bash
pip install -e .
```

## Run

```bash
python src/main.py
```

## Architecture

The MVP consists of 5 modular components:

1. **AuctionScraper** (`src/scraper.py`): Scrapes public auction pages
2. **BidHistoryExtractor** (`src/extractor.py`): Extracts structured bid histories
3. **BehaviorFeatureComputer** (`src/features.py`): Computes behavioral features
4. **ShillBidRulesEngine** (`src/rules.py`): Runs explainable detection rules
5. **AlertGenerator** (`src/alerts.py`): Generates evidence-backed alerts

## Sample Output

```
============================================================
ShillBidWatchdog MVP - Shill Bidder Detection
============================================================

[1/5] Scraping public auction pages...
  → Scraped 3 auction pages

[2/5] Extracting bid histories...
  → Extracted 3 bid histories

[3/5] Computing behavior features...
  → Computed features for 3 auctions

[4/5] Running shill-bid detection rules...
  → Found 2 suspicious bidding patterns

[5/5] Generating alerts...
  → Generated 2 alerts

============================================================
ALERTS - Suspicious Shill Bidding Detected
============================================================

ALERT: Auction AUC001
Risk Level: CRITICAL
Summary: Detected 4 suspicious pattern(s) - Risk Level: CRITICAL

Evidence:
  1. High Bid Ratio
     → Bidder(s) participate in unusually high percentage of bids
       • Bidder user_123: bid_ratio=55.6%, bid_count=5
       • Bidder user_456: bid_ratio=44.4%, bid_count=4
  ...
```

## Next Steps (Beyond MVP)

- Integrate with real auction site APIs
- Add machine learning models
- Implement database for historical analysis
- Add web dashboard for monitoring
- Expand rule set based on domain expertise
