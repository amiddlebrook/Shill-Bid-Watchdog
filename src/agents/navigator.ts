/**
 * Navigator Agent - Browser Rendering
 * Navigates to auction pages and extracts bid history
 * 
 * BidFTA Structure (from analysis):
 * - Lot Code: Item identifier that persists across relists (e.g., TEA2525531)
 * - Auction Number: Specific auction instance (e.g., AML2600499)
 * - Bidder IDs: Numeric IDs visible in bid history popup (e.g., 1366231)
 * - Bid History: Shown in popup when clicking "current bid" area
 */

import puppeteer from '@cloudflare/puppeteer';
import type { Env, NavigationResult, Bid } from '../types';
import { getOrCreateFingerprint } from '../historical';

// BidFTA item info field labels
const BIDFTA_FIELDS = {
    LOT_CODE: 'Lot Code:',
    AUCTION_NUMBER: 'Auction Number',
    MSRP: 'MSRP:',
    CONDITION: 'Condition:',
    PICKUP: 'Pickup Location:'
};

export interface BidFTANavigationResult extends NavigationResult {
    lotCode?: string;         // Item identifier (persists across relists)
    auctionNumber?: string;   // Specific auction instance ID
    msrp?: number;
    condition?: string;
    pickupLocation?: string;
}

/**
 * Navigate to a BidFTA auction page and extract all data
 */
export async function navigateBidFTA(
    url: string,
    env: Env
): Promise<BidFTANavigationResult> {
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

        // Wait for body to ensure page loaded
        await page.waitForSelector('body', { timeout: 10000 });

        // Check for blocking/captcha (lighter check)
        const isBlocked = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return bodyText.includes('Access Denied') ||
                bodyText.includes('security check') ||
                bodyText.includes('Cloudflare');
        });

        if (isBlocked) {
            console.warn('[Navigator] Potential blocking validation detected');
            return {
                success: false,
                error: 'Blocked by anti-bot protection'
            };
        }

        // Navigate with human-like timing
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Random delay to appear human
        await delay(1000 + Math.random() * 2000);

        // Extract item name from title or meta tags
        const itemName = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            if (h1 && h1.innerText.trim().length > 0) return h1.innerText.trim();

            const metaTitle = document.querySelector('meta[property="og:title"]');
            if (metaTitle) return metaTitle.getAttribute('content') || 'Unknown Item';

            return document.title || 'Unknown Item';
        });

        // Extract current price
        const currentPrice = await extractCurrentPrice(page);
        console.log(`[Navigator] Extracted: ${itemName} - $${currentPrice}`);

        // Extract Item Information fields
        const itemInfo = await extractItemInfo(page);

        // Click on current bid area to reveal bid history popup
        await openBidHistoryPopup(page);

        // Extract bid history from popup
        const bids = await extractBidHistoryFromPopup(page);
        console.log(`[Navigator] Found ${bids.length} bids`);

        // Capture page text for debugging if extraction fails
        let debugText = '';
        if (itemName === 'Unknown Item' || bids.length === 0) {
            debugText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
            console.log('[Navigator] Debug content:', debugText);
        }

        await browser.close();

        // Create/update item fingerprint if we have a lot code
        let fingerprintId: number | undefined;
        if (itemInfo.lotCode && env.DB) {
            try {
                fingerprintId = await getOrCreateFingerprint(
                    itemName,
                    itemInfo.auctionNumber || 'unknown',
                    env
                );
            } catch (e) {
                console.error('Fingerprint creation failed:', e);
            }
        }

        return {
            success: true,
            auctionId: itemInfo.auctionNumber || extractAuctionIdFromUrl(url),
            itemName,
            currentPrice,
            bids,
            lotCode: itemInfo.lotCode,
            auctionNumber: itemInfo.auctionNumber,
            msrp: itemInfo.msrp,
            condition: itemInfo.condition,
            pickupLocation: itemInfo.pickupLocation,
            // Return debug info if needed
            debug: debugText
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
 * Extract current price from page
 */
async function extractCurrentPrice(page: puppeteer.Page): Promise<number> {
    try {
        const price = await page.evaluate(() => {
            // Try specific BidFTA selectors first
            const selectors = [
                '#current-bid',
                '.current-bid',
                '.bid-amount',
                '[class*="Price"]',
                '[class*="amount"]'
            ];

            for (const selector of selectors) {
                const els = document.querySelectorAll(selector);
                for (const el of els) {
                    const text = el.textContent || '';
                    if (text.includes('$')) {
                        const match = text.match(/\$[\s]*([\d,]+\.?\d*)/);
                        if (match) return parseFloat(match[1].replace(/,/g, ''));
                    }
                }
            }

            return 0;
        });

        return price || 0;
    } catch {
        return 0;
    }
}

/**
 * Extract Item Information fields from BidFTA page
 * These are in the "Item Information" section with label: value format
 */
async function extractItemInfo(page: puppeteer.Page): Promise<{
    lotCode?: string;
    auctionNumber?: string;
    msrp?: number;
    condition?: string;
    pickupLocation?: string;
}> {
    try {
        const info = await page.evaluate(() => {
            const result: Record<string, string> = {};

            // Look for Item Information section
            const infoSection = document.querySelector('[class*="item-info"], [class*="ItemInfo"], .item-information');
            const container = infoSection || document.body;

            // Find all label-value pairs
            // BidFTA uses format like: <span>Lot Code:</span> <span>TEA2525531</span>
            const rows = container.querySelectorAll('[class*="row"], tr, div > span + span');

            rows.forEach(row => {
                const text = row.textContent || '';

                // Check for known fields
                if (text.includes('Lot Code')) {
                    const match = text.match(/Lot Code[:\s]*([A-Z0-9]+)/i);
                    if (match) result.lotCode = match[1];
                }
                if (text.includes('Auction Number')) {
                    const match = text.match(/Auction Number[:\s]*([A-Z0-9]+)/i);
                    if (match) result.auctionNumber = match[1];
                }
                if (text.includes('MSRP')) {
                    const match = text.match(/MSRP[:\s]*\$?([\d,.]+)/i);
                    if (match) result.msrp = match[1];
                }
                if (text.includes('Condition')) {
                    const match = text.match(/Condition[:\s]*(.+?)(?:$|\n)/i);
                    if (match) result.condition = match[1].trim();
                }
                if (text.includes('Pickup')) {
                    const match = text.match(/Pickup[:\s]*(.+?)(?:$|\n)/i);
                    if (match) result.pickupLocation = match[1].trim();
                }
            });

            // Also try direct text search in Item Information section
            const fullText = container.textContent || '';

            if (!result.lotCode) {
                const lotMatch = fullText.match(/Lot Code[:\s]*([A-Z0-9]+)/i);
                if (lotMatch) result.lotCode = lotMatch[1];
            }

            if (!result.auctionNumber) {
                // Look for auction number link (it's usually a link on BidFTA)
                const auctionLinks = document.querySelectorAll('a[href*="auction"]');
                auctionLinks.forEach(link => {
                    const text = link.textContent?.trim();
                    if (text && /^[A-Z]{2,3}\d+$/.test(text)) {
                        result.auctionNumber = text;
                    }
                });
            }

            return result;
        });

        return {
            lotCode: info.lotCode,
            auctionNumber: info.auctionNumber,
            msrp: info.msrp ? parseFloat(info.msrp.replace(',', '')) : undefined,
            condition: info.condition,
            pickupLocation: info.pickupLocation
        };
    } catch (error) {
        console.error('Failed to extract item info:', error);
        return {};
    }
}

/**
 * Click on current bid area to open the bid history popup
 */
async function openBidHistoryPopup(page: puppeteer.Page): Promise<void> {
    try {
        // BidFTA shows bid history when you click on the current bid amount
        const clickTargets = [
            '[class*="current-bid"]',
            '[class*="bid-amount"]',
            'button:has-text("Bid History")',
            'a:has-text("Bid History")',
            '.price-section',
            '[data-testid="bid-history"]'
        ];

        for (const selector of clickTargets) {
            const element = await page.$(selector);
            if (element) {
                await element.click();
                await delay(1000 + Math.random() * 500);

                // Check if popup appeared
                const popup = await page.$('[class*="popup"], [class*="modal"], [class*="dropdown"]');
                if (popup) {
                    return;
                }
            }
        }
    } catch (error) {
        console.error('Failed to open bid history popup:', error);
    }
}

/**
 * Extract bid history from the popup
 * Format from screenshot: "Bidder ID | Bid | Date & Time"
 * Example: "1366231 $26.01 01/30/2026 08:53 PM ET"
 */
/**
 * Extract bid history from the page (popup or embedded)
 */
async function extractBidHistoryFromPopup(
    page: puppeteer.Page
): Promise<Array<{ bidderId: string; amount: number; bidTime?: string }>> {
    try {
        // Wait for potential bid table
        await page.waitForSelector('table', { timeout: 3000 }).catch(() => null);

        const bids = await page.evaluate(() => {
            // Find the bid table
            const tables = Array.from(document.querySelectorAll('table'));
            let bidRows = [];

            for (const table of tables) {
                const headers = Array.from(table.querySelectorAll('th, td')).map(c => c.innerText.toLowerCase());
                // Look for standard headers
                if (headers.some(h => h.includes('bidder') || (h.includes('amount') && h.includes('bid')))) {
                    // This is likely the bid table
                    const rows = Array.from(table.querySelectorAll('tr'));
                    // Skip rows that are clearly headers
                    bidRows = rows.filter(r => {
                        const cells = r.querySelectorAll('td');
                        const text = r.innerText.toLowerCase();
                        // Must have data cells and not be a header row
                        return cells.length >= 2 && !text.includes('bidder') && !text.includes('amount');
                    });
                    break;
                }
            }

            // Fallback: look for ANY table rows that look like bids if no table found
            if (bidRows.length === 0) {
                const allRows = Array.from(document.querySelectorAll('tr'));
                bidRows = allRows.filter(r => {
                    const cells = r.querySelectorAll('td');
                    if (cells.length < 2) return false;
                    const text = r.innerText;
                    return text.includes('$') && /\d{4,}/.test(text); // Has $ and loose number for ID
                });
            }

            return bidRows.map(row => {
                const cells = Array.from(row.querySelectorAll('td'));
                if (cells.length < 2) return null;

                // Try to identify columns by content
                let bidderId = '';
                let amount = 0;
                let bidTime = new Date().toISOString();

                cells.forEach(cell => {
                    const text = cell.innerText.trim();
                    // ID is usually 5+ digits
                    if (/^\d{5,}$/.test(text) && !text.includes('$')) {
                        bidderId = text;
                    }
                    // Amount has $
                    else if (text.includes('$')) {
                        amount = parseFloat(text.replace(/[^0-9.]/g, '') || '0');
                    }
                    // Time usually has : / or "ago"
                    else if (text.includes(':') || text.includes('/') || text.toLowerCase().includes('ago')) {
                        bidTime = text;
                    }
                });

                // Positional fallback if heuristics fail
                if (!bidderId) bidderId = cells[0]?.innerText?.trim();
                if (!amount) amount = parseFloat(cells[1]?.innerText?.replace(/[^0-9.]/g, '') || '0');
                if (bidTime === new Date().toISOString()) bidTime = cells[2]?.innerText?.trim() || bidTime;

                if (!amount) return null;

                return {
                    bidderId,
                    amount,
                    bidTime,
                    riskLevel: 'LOW'
                };
            }).filter(b => b);
        });

        return bids;
    } catch (error) {
        console.error('Failed to extract bid history:', error);
        return [];
    }
}

/**
 * Navigate to eBay auction and extract bid history
 */
export async function navigateEbay(
    url: string,
    env: Env
): Promise<NavigationResult> {
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
    // BidFTA: ?item=123456
    const bidfitaMatch = url.match(/item[=\/](\d+)/i);
    if (bidfitaMatch) return `bidfta-${bidfitaMatch[1]}`;

    // eBay
    const ebayMatch = url.match(/itm[\\/=](\d+)/i);
    if (ebayMatch) return `ebay-${ebayMatch[1]}`;

    // Fallback
    return `unknown-${Date.now()}`;
}

/**
 * Store extracted data in database
 */
export async function storeAuctionData(
    result: BidFTANavigationResult,
    env: Env
): Promise<number> {
    // Check if auction already exists
    const existing = await env.DB.prepare(`
    SELECT id FROM auctions WHERE auction_id = ?
  `).bind(result.auctionId).first() as any;

    let auctionDbId: number;

    if (existing) {
        // Update existing auction
        await env.DB.prepare(`
      UPDATE auctions SET
        item_name = ?,
        current_price = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(result.itemName, result.currentPrice, existing.id).run();
        auctionDbId = existing.id;
    } else {
        // Create new auction
        const insertResult = await env.DB.prepare(`
      INSERT INTO auctions (auction_id, source, url, item_name, current_price)
      VALUES (?, 'bidfta', ?, ?, ?)
      RETURNING id
    `).bind(
            result.auctionId,
            result.auctionNumber ? `https://www.bidfta.com/items?item=${result.auctionNumber}` : '',
            result.itemName,
            result.currentPrice
        ).first() as any;
        auctionDbId = insertResult.id;
    }

    // Store lot code for relist tracking
    if (result.lotCode) {
        try {
            const fingerprintId = await getOrCreateFingerprint(
                result.itemName || 'Unknown',
                result.auctionId || 'unknown',
                env
            );

            await env.DB.prepare(`
        UPDATE auctions SET item_fingerprint_id = ? WHERE id = ?
      `).bind(fingerprintId, auctionDbId).run();
        } catch (e) {
            console.error('Failed to store lot code:', e);
        }
    }

    // Store bids
    if (result.bids && result.bids.length > 0) {
        await storeBids(auctionDbId, result.bids, env);
    }

    return auctionDbId;
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
