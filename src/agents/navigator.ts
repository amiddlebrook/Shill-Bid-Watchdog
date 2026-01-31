/**
 * Navigator Agent - Browser Rendering
 * Navigates to auction pages and extracts bid history
 */

import puppeteer from '@cloudflare/puppeteer';
import type { Env, NavigationResult, Bid } from '../types';

/**
 * Navigate to a BidFTA auction page and extract bid history
 */
export async function navigateBidFTA(
    url: string,
    env: Env
): Promise<NavigationResult> {
    let browser: puppeteer.Browser | null = null;

    try {
        // Connect to Browser Rendering
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        // Set realistic viewport and user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Navigate with human-like timing
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Random delay to appear human
        await delay(1000 + Math.random() * 2000);

        // Extract item name
        const itemName = await page.$eval(
            'h1, .item-title, .product-title, [data-testid="item-title"]',
            (el: Element) => el.textContent?.trim() || 'Unknown Item'
        ).catch(() => 'Unknown Item');

        // Extract current price
        const currentPrice = await page.$eval(
            '.current-bid, .price, [data-testid="current-price"]',
            (el: Element) => {
                const text = el.textContent || '0';
                return parseFloat(text.replace(/[^0-9.]/g, '')) || 0;
            }
        ).catch(() => 0);

        // Click on Bid History tab if present
        const bidHistoryTab = await page.$(
            'button:has-text("Bid History"), a:has-text("Bid History"), [data-tab="bids"], .bid-history-tab'
        );

        if (bidHistoryTab) {
            await bidHistoryTab.click();
            await delay(1000 + Math.random() * 1000);
        }

        // Extract bid history
        const bids = await extractBidHistory(page);

        // Take screenshot for debugging/verification
        const screenshot = await page.screenshot({ type: 'png' });

        // Extract auction ID from URL
        const auctionId = extractAuctionIdFromUrl(url);

        await browser.close();

        return {
            success: true,
            auctionId,
            itemName,
            currentPrice,
            bids,
            screenshot
        };
    } catch (error) {
        if (browser) {
            await browser.close();
        }

        return {
            success: false,
            error: error instanceof Error ? error.message : 'Navigation failed'
        };
    }
}

/**
 * Extract bid history from the current page
 */
async function extractBidHistory(
    page: puppeteer.Page
): Promise<Array<{ bidderId: string; amount: number; bidTime?: string }>> {
    // Try multiple selectors for bid history tables
    const selectors = [
        'table.bid-history tr',
        '.bid-history-list .bid-item',
        '[data-testid="bid-row"]',
        '.bids-table tbody tr',
        '.bidding-history tr'
    ];

    for (const selector of selectors) {
        try {
            const rows = await page.$$(selector);
            if (rows.length > 0) {
                const bids: Array<{ bidderId: string; amount: number; bidTime?: string }> = [];

                for (const row of rows) {
                    const bid = await row.evaluate((el: Element) => {
                        // Try to find bidder name/ID
                        const bidderEl = el.querySelector('.bidder, .user, td:first-child, [data-bidder]');
                        const bidderId = bidderEl?.textContent?.trim() || 'unknown';

                        // Try to find amount
                        const amountEl = el.querySelector('.amount, .price, td:nth-child(2), [data-amount]');
                        const amountText = amountEl?.textContent || '0';
                        const amount = parseFloat(amountText.replace(/[^0-9.]/g, '')) || 0;

                        // Try to find timestamp
                        const timeEl = el.querySelector('.time, .date, td:last-child, [data-time]');
                        const bidTime = timeEl?.textContent?.trim();

                        return { bidderId, amount, bidTime };
                    });

                    // Skip header rows or invalid bids
                    if (bid.amount > 0 && bid.bidderId !== 'unknown') {
                        bids.push(bid);
                    }
                }

                if (bids.length > 0) {
                    return bids;
                }
            }
        } catch {
            // Try next selector
            continue;
        }
    }

    // Fallback: try to find any visible bid information
    return extractBidsFromText(page);
}

/**
 * Fallback: extract bids from page text
 */
async function extractBidsFromText(
    page: puppeteer.Page
): Promise<Array<{ bidderId: string; amount: number; bidTime?: string }>> {
    const pageText = await page.evaluate(() => document.body.innerText);

    // Pattern: "username bid $123.45"
    const bidPattern = /(\w+[\w\d_-]*)\s*(?:bid|placed|:)\s*\$?([\d,]+\.?\d*)/gi;
    const bids: Array<{ bidderId: string; amount: number; bidTime?: string }> = [];

    let match;
    while ((match = bidPattern.exec(pageText)) !== null) {
        const bidderId = match[1];
        const amount = parseFloat(match[2].replace(',', ''));

        if (amount > 0 && !['current', 'starting', 'reserve'].includes(bidderId.toLowerCase())) {
            bids.push({ bidderId, amount });
        }
    }

    return bids;
}

/**
 * Navigate to eBay auction and extract bid history
 */
export async function navigateEbay(
    url: string,
    env: Env
): Promise<NavigationResult> {
    // Similar implementation for eBay
    // Will be implemented when eBay support is added
    return {
        success: false,
        error: 'eBay navigation not yet implemented'
    };
}

/**
 * Helper function for delays
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract auction ID from URL
 */
function extractAuctionIdFromUrl(url: string): string {
    // BidFTA
    const bidfitaMatch = url.match(/item[=\/](\d+)/i);
    if (bidfitaMatch) return `bidfta-${bidfitaMatch[1]}`;

    // eBay
    const ebayMatch = url.match(/itm[\/=](\d+)/i);
    if (ebayMatch) return `ebay-${ebayMatch[1]}`;

    // Fallback
    return `unknown-${Date.now()}`;
}

/**
 * Store extracted bids in database
 */
export async function storeBids(
    auctionDbId: number,
    bids: Array<{ bidderId: string; amount: number; bidTime?: string }>,
    env: Env
): Promise<void> {
    // Clear existing bids for this auction
    await env.DB.prepare('DELETE FROM bids WHERE auction_id = ?')
        .bind(auctionDbId)
        .run();

    // Insert new bids
    for (let i = 0; i < bids.length; i++) {
        const bid = bids[i];
        await env.DB.prepare(`
      INSERT INTO bids (auction_id, bidder_id, amount, bid_time, bid_order)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
            auctionDbId,
            bid.bidderId,
            bid.amount,
            bid.bidTime || null,
            i + 1
        ).run();

        // Update bidder profile
        await env.DB.prepare(`
      INSERT INTO bidders (bidder_id, total_bids, last_seen)
      VALUES (?, 1, datetime('now'))
      ON CONFLICT(bidder_id) DO UPDATE SET
        total_bids = total_bids + 1,
        last_seen = datetime('now')
    `).bind(bid.bidderId).run();
    }
}
