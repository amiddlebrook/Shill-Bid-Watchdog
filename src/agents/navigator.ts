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

        // Anti-bot stealth: Set real User-Agent and headers
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"'
        });

        // Navigate with human-like timing
        console.log(`[Navigator] Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Random delay to appear human
        await delay(2000 + Math.random() * 2000);

        // Wait for body to ensure page loaded
        await page.waitForSelector('body', { timeout: 10000 });

        // Check for blocking/captcha
        const isBlocked = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return bodyText.includes('Access Denied') ||
                bodyText.includes('security check') ||
                bodyText.includes('Cloudflare');
        });

        if (isBlocked) {
            console.warn('[Navigator] Blocked by anti-bot protection');
            return { success: false, error: 'Blocked by anti-bot protection' };
        }

        // Extract basic data immediately
        const itemName = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            if (h1 && h1.innerText.trim().length > 0) return h1.innerText.trim();
            const ogTitle = document.querySelector('meta[property="og:title"]');
            if (ogTitle) return ogTitle.getAttribute('content') || 'Unknown Item';
            return document.title || 'Unknown Item';
        });

        const currentPrice = await extractCurrentPrice(page);
        const status = await extractStatus(page);
        const itemInfo = await extractItemInfo(page);

        // BID HISTORY EXTRACTION WITH RETRIES
        let bids: any[] = [];
        let retryCount = 0;
        const maxRetries = 2;

        while (bids.length === 0 && retryCount <= maxRetries && status !== 'ended') {
            if (retryCount > 0) {
                console.log(`[Navigator] Retry ${retryCount} for bid history...`);
                await page.reload({ waitUntil: 'networkidle2' });
                await delay(2000);
            }

            await openBidHistoryPopup(page);
            bids = await extractBidHistoryFromPopup(page);
            console.log(`[Navigator] Pass ${retryCount + 1}: Found ${bids.length} bids`);

            if (bids.length > 0) break;
            retryCount++;
        }

        // FALLBACK: If ended and no bids, try to find "Sold to" info
        if (bids.length === 0 && status === 'ended') {
            const winner = await extractWinnerFromPage(page);
            if (winner) {
                bids.push({
                    bidderId: winner,
                    amount: currentPrice,
                    bidTime: new Date().toISOString()
                });
            }
        }

        const debugText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
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
            status,
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
            // 1. Try robust regex on full text first (fastest and often most reliable for "Label: Value")
            const bodyText = document.body.innerText;
            // Matches "Current Bid: $123.45" or "High Bid: $123.45" or "Price: $123.45"
            // Also handles newlines between label and value
            const textMatch = bodyText.match(/(?:Current Bid|High Bid|Price|Winning Bid)[:\s]*\$?([\d,]+\.?\d*)/i);
            if (textMatch) {
                return parseFloat(textMatch[1].replace(/,/g, ''));
            }

            // 2. Try XPath to find "Current Bid" label and getting nearby value
            const xpath = "//*[contains(text(), 'Current Bid') or contains(text(), 'High Bid')]";
            const iterator = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

            for (let i = 0; i < iterator.snapshotLength; i++) {
                const labelNode = iterator.snapshotItem(i);
                if (!labelNode) continue;

                // Check parent text (container)
                const parentText = labelNode.parentElement?.innerText || '';
                const parentMatch = parentText.match(/\$([\d,]+\.?\d*)/);
                if (parentMatch) return parseFloat(parentMatch[1].replace(/,/g, ''));

                // Check next sibling
                let sibling = labelNode.nextSibling;
                while (sibling) {
                    const siblingText = sibling.textContent || '';
                    const siblingMatch = siblingText.match(/\$([\d,]+\.?\d*)/);
                    if (siblingMatch) return parseFloat(siblingMatch[1].replace(/,/g, ''));
                    sibling = sibling.nextSibling;
                }
            }

            // 3. Fallback: Look for ANY element with class specifically indicating price
            const selectors = [
                '#current-bid', '.current-bid', '.bid-amount',
                '[class*="Price"]', '[class*="winning-bid"]'
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
 * Extract Auction Status
 */
async function extractStatus(page: puppeteer.Page): Promise<'watching' | 'ended'> {
    try {
        return await page.evaluate(() => {
            const body = document.body.innerText.toLowerCase();
            // Check for common "Ended" indicators
            if (body.includes('bidding ended') ||
                body.includes('auction closed') ||
                body.includes('winning bid:') ||
                body.includes('sold to') ||
                document.querySelector('.status-closed') ||
                document.querySelector('.auction-ended')) {
                return 'ended';
            }
            return 'watching';
        });
    } catch {
        return 'watching';
    }
}

/**
 * Extract Winner ID from page text (fallback)
 */
async function extractWinnerFromPage(page: puppeteer.Page): Promise<string | null> {
    try {
        return await page.evaluate(() => {
            const text = document.body.innerText;
            // Look for "Sold to: 12345" or "Winning Bidder: 123456"
            const match = text.match(/(?:Sold to|Winner|Winning Bidder)[:\s]+(\d{5,})/i);
            return match ? match[1] : null;
        });
    } catch {
        return null;
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
            // Improved iteration: look at all text nodes/lines
            const textLines = (container.innerText || '').split('\n').map(l => l.trim()).filter(l => l);

            textLines.forEach(line => {
                if (line.match(/Lot Code[:\s]*([A-Z0-9]+)/i)) {
                    result.lotCode = line.match(/Lot Code[:\s]*([A-Z0-9]+)/i)![1];
                }
                if (line.match(/Auction Number[:\s]*([A-Z0-9]+)/i)) {
                    result.auctionNumber = line.match(/Auction Number[:\s]*([A-Z0-9]+)/i)![1];
                }
                if (line.match(/MSRP[:\s]*\$?([\d,.]+)/i)) {
                    result.msrp = line.match(/MSRP[:\s]*\$?([\d,.]+)/i)![1];
                }
                // Also handle "Original Price" or "Retail"
                if (line.match(/(?:Retail|Original Price)[:\s]*\$?([\d,.]+)/i)) {
                    result.msrp = line.match(/(?:Retail|Original Price)[:\s]*\$?([\d,.]+)/i)![1];
                }
                if (line.match(/Condition[:\s]*(.+)/i)) {
                    result.condition = line.match(/Condition[:\s]*(.+)/i)![1].trim();
                }
                if (line.match(/Pickup Location[:\s]*(.+)/i)) {
                    // Avoid capturing just "Pickup Location:"
                    const val = line.match(/Pickup Location[:\s]*(.+)/i)![1].trim();
                    if (val.length > 2) result.pickupLocation = val;
                }
            });

            // FALLBACK: Heavy regex scan on full text if MSRP missing
            if (!result.msrp) {
                const fullText = document.body.innerText;
                const msrpRegex = /(?:MSRP|Retail|Est\. Value)[:\s]*\$?([\d,]+\.?\d*)/i;
                const match = fullText.match(msrpRegex);
                if (match) result.msrp = match[1];
            }

            // Also try direct text search in Item Information section
            const containerText = container.textContent || '';
            if (!result.lotCode) {
                const lotMatch = containerText.match(/Lot Code[:\s]*([A-Z0-9]+)/i);
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
            '#current-bid',
            '.current-bid',
            '[class*="current-bid"]',
            '[class*="bid-amount"]',
            '.winning-bid',
            'button:has-text("Bid History")',
            'a:has-text("Bid History")',
            '.price-section',
            '[data-testid="bid-history"]'
        ];

        let clicked = false;

        // 1. Try specific selectors
        for (const selector of clickTargets) {
            const element = await page.$(selector);
            if (element) {
                await element.click();
                clicked = true;
                await delay(500); // Small delay between attempts

                // Check if popup/table appeared immediately
                if (await page.$('table')) return;
            }
        }

        // 2. Try clicking the element that contains the current price (most reliable)
        // Find price text using robust regex first
        const priceTextToFind = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const match = bodyText.match(/(?:Current Bid|High Bid)[:\s]*(\$[\d,]+\.?\d*)/i);
            // Return the exact "$39.00" string
            return match ? match[1] : null;
        });

        if (priceTextToFind) {
            // Try clicking element with exact text match (or close to it)
            await page.evaluate((text) => {
                const elements = Array.from(document.querySelectorAll('*'));
                // Find smallest element containing the price text
                const target = elements.reverse().find(el =>
                    el.textContent &&
                    el.textContent.includes(text) &&
                    el.children.length === 0 // Prefer leaf nodes
                );
                if (target) (target as HTMLElement).click();
            }, priceTextToFind);

            clicked = true;
            await delay(1000);
            if (await page.$('table')) return;
        }

        // 3. Try generic "Current Bid" label click fallback
        if (!clicked || !(await page.$('table'))) {
            await page.evaluate(() => {
                const xpath = "//*[contains(text(), 'Current Bid')]";
                const iterator = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                if (iterator.snapshotLength > 0) {
                    const label = iterator.snapshotItem(0);
                    if (label) {
                        // Click label
                        (label as HTMLElement).click();
                        // Click parent
                        (label.parentElement as HTMLElement)?.click();
                        // Click next sibling
                        (label.nextSibling as HTMLElement)?.click();
                    }
                }
            });
        }

        // Wait for popup animation/load
        await delay(2000);

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
    env: Env,
    targetDbId?: number
): Promise<number> {
    let auctionDbId: number;

    // IF we have a target ID, explicitly update it
    if (targetDbId) {
        await env.DB.prepare(`
        UPDATE auctions SET
            item_name = ?,
            current_price = ?,
            start_price = ?,
            status = ?,
            updated_at = datetime('now')
        WHERE id = ?
        `).bind(result.itemName, result.currentPrice, result.msrp || 0, result.status || 'watching', targetDbId).run();
        auctionDbId = targetDbId;
    } else {
        // Fallback: Check if auction already exists by ID string
        const existing = await env.DB.prepare(`
        SELECT id FROM auctions WHERE auction_id = ?
    `).bind(result.auctionId).first() as any;

        if (existing) {
            // Update existing auction
            await env.DB.prepare(`
        UPDATE auctions SET
            item_name = ?,
            current_price = ?,
            start_price = ?,
            status = ?,
            updated_at = datetime('now')
        WHERE id = ?
        `).bind(result.itemName, result.currentPrice, result.msrp || 0, result.status || 'watching', existing.id).run();
            auctionDbId = existing.id;
        } else {
            // Create new auction
            const insertResult = await env.DB.prepare(`
        INSERT INTO auctions (auction_id, source, url, item_name, current_price, start_price, status)
        VALUES (?, 'bidfta', ?, ?, ?, ?, ?)
        RETURNING id
        `).bind(
                result.auctionId,
                result.auctionNumber ? `https://www.bidfta.com/items?item=${result.auctionNumber}` : '',
                result.itemName,
                result.currentPrice,
                result.msrp || 0,
                result.status || 'watching'
            ).first() as any;
            auctionDbId = insertResult.id;
        }
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
