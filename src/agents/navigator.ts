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

import type { Browser, Page } from '@cloudflare/puppeteer';
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
    let browser: Browser | null = null;

    // Store API responses that might contain bid data
    const apiResponses: any[] = [];

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

        // Set up network interception to capture bid-related API calls
        await page.setRequestInterception(true);
        page.on('request', (request: any) => {
            request.continue();
        });

        page.on('response', async (response: any) => {
            const responseUrl = response.url();
            const status = response.status();

            // Look for API endpoints that might return bid data
            if (status === 200 &&
                (responseUrl.includes('bid') || responseUrl.includes('history') ||
                 responseUrl.includes('api') || responseUrl.includes('json'))) {
                try {
                    const contentType = response.headers()['content-type'] || '';
                    if (contentType.includes('application/json')) {
                        const data = await response.json();
                        console.log(`[Navigator] Captured API response from: ${responseUrl}`);
                        apiResponses.push({ url: responseUrl, data });
                    }
                } catch (e) {
                    // Ignore JSON parse errors
                }
            }
        });

        // Navigate with human-like timing
        console.log(`[Navigator] Navigating to ${url}...`);
        // Use 'load' instead of 'networkidle2' which is often flakey in CI/Cloudflare
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });

        // Random delay to appear human
        await delay(2000 + Math.random() * 2000);

        // Wait for body to ensure page loaded
        await page.waitForSelector('body', { timeout: 10000 });

        // Anti-Popup: Close newsletter or overlay if present
        console.log('[Navigator] Checking for popups...');
        await page.evaluate(() => {
            // Find buttons or links containing "No Thanks", "Close", or "✕"
            const labels = ["No Thanks", "No thanks", "Close", "✕", "Dismiss"];
            const elements = Array.from(document.querySelectorAll('button, a, div, span'));

            for (const el of elements) {
                const text = (el as HTMLElement).innerText || '';
                if (labels.some(l => text.includes(l))) {
                    console.log(`[Browser] Found and clicking popup closer: ${text}`);
                    (el as HTMLElement).click();
                }
            }

            // Also try specific ID for known newsletter popups if applicable
            const modalClose = document.querySelector('.modal-close, .close-button, #close-button');
            if (modalClose) (modalClose as HTMLElement).click();
        }).catch(() => null);

        await delay(1500);

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
            console.log(`[Navigator] Pass ${retryCount + 1}: Found ${bids.length} bids from page`);

            if (bids.length > 0) break;
            retryCount++;
        }

        // FALLBACK 1: Check captured API responses for bid data
        if (bids.length === 0 && apiResponses.length > 0) {
            console.log(`[Navigator] Checking ${apiResponses.length} captured API responses for bid data...`);
            for (const apiResponse of apiResponses) {
                const extractedBids = extractBidsFromApiResponse(apiResponse.data);
                if (extractedBids.length > 0) {
                    console.log(`[Navigator] Found ${extractedBids.length} bids from API: ${apiResponse.url}`);
                    bids = extractedBids;
                    break;
                }
            }
        }

        // FALLBACK 2: If ended and no bids, try to find "Sold to" info
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

        // FALLBACK 3: Try direct text extraction from page if still no bids
        if (bids.length === 0) {
            console.log('[Navigator] Attempting direct text extraction...');
            bids = await extractBidsFromPageText(page);
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
            auctionNumber: itemInfo.auctionNumber,
            itemName,
            currentPrice,
            status: status as "watching" | "ended" | undefined,
            msrp: itemInfo.msrp,
            condition: itemInfo.condition,
            pickupLocation: itemInfo.pickupLocation,
            lotCode: itemInfo.lotCode,
            bids
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
async function extractCurrentPrice(page: Page): Promise<number> {
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
async function extractStatus(page: Page): Promise<string> {
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
async function extractWinnerFromPage(page: Page): Promise<string | null> {
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
async function extractItemInfo(page: Page): Promise<Partial<BidFTANavigationResult>> {
    try {
        const info = await page.evaluate(() => {
            const result: Record<string, string> = {};

            // Look for Item Information section
            const infoSection = document.querySelector('[class*="item-info"], [class*="ItemInfo"], .item-information');
            const container = infoSection || document.body;

            // Find all label-value pairs
            // BidFTA uses format like: <span>Lot Code:</span> <span>TEA2525531</span>
            // Improved iteration: look at all text nodes/lines
            const textLines = ((container as HTMLElement).innerText || '').split('\n').map((l: string) => l.trim()).filter((l: string) => l);

            textLines.forEach((line: string) => {
                if (line.match(/Lot Code[:\s]*([A-Z0-9]+)/i)) {
                    result.lotCode = line.match(/Lot Code[:\s]*([A-Z0-9]+)/i)![1];
                }
                if (line.match(/Auction Number[:\s]*([A-Z0-9]+)/i)) {
                    result.auctionNumber = line.match(/Auction Number[:\s]*([A-Z0-9]+)/i)![1];
                }
                // Broad MSRP match - catch "Retail Value", "Estimated Retail", etc.
                const msrpLineMatch = line.match(/(?:MSRP|Retail|Value|Value|Price)[\s\S]*?\$([\d,]+\.?\d*)/i);
                if (msrpLineMatch && !result.msrp) {
                    result.msrp = msrpLineMatch[1];
                }
                if (line.match(/Condition[:\s]*(.+)/i)) {
                    result.condition = line.match(/Condition[:\s]*(.+)/i)![1].trim();
                }
                if (line.match(/Pickup Location[:\s]*(.+)/i)) {
                    const val = line.match(/Pickup Location[:\s]*(.+)/i)![1].trim();
                    if (val.length > 2) result.pickupLocation = val;
                }
            });

            // FALLBACK: Heavy regex scan on full text if MSRP missing
            if (!result.msrp) {
                const fullText = document.body.innerText;
                // Matches "Retail Value: $375.00" or similar
                const msrpRegex = /(?:MSRP|Retail|Retail Value|Est\. Value|Expected Price)[:\s]*\$?([\d,]+\.?\d*)/i;
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
 * BidFTA shows bid history in a dropdown when clicking the icon next to "CURRENT BID"
 *
 * From BidFTA page structure:
 * - "CURRENT BID $XX.XX" with a people icon (clickable)
 * - Clicking opens dropdown with table: "Bidder ID | Bid | Date & Time"
 */
async function openBidHistoryPopup(page: Page): Promise<void> {
    try {
        console.log('[Navigator] Attempting to open BidFTA bid history dropdown...');

        // Debug: Log what we can find on the page
        const pageDebug = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return {
                hasCurrentBid: bodyText.includes('CURRENT BID') || bodyText.includes('Current Bid'),
                hasBidderID: bodyText.includes('Bidder ID'),
                pageTextSnippet: bodyText.substring(0, 1000)
            };
        });
        console.log('[Navigator] Page debug:', JSON.stringify({
            hasCurrentBid: pageDebug.hasCurrentBid,
            hasBidderID: pageDebug.hasBidderID
        }));

        // Try to click the bid history trigger
        const clicked = await page.evaluate(() => {
            // BidFTA-specific: Look for the "CURRENT BID" area with the clickable icon
            // The structure is typically: [icon] CURRENT BID $XX.XX

            // Strategy 1: Find element containing "CURRENT BID" and look for clickable siblings/children
            const allElements = Array.from(document.querySelectorAll('*'));

            // Look for elements that contain "CURRENT BID" text
            for (const el of allElements) {
                const text = (el as HTMLElement).innerText || '';
                const directText = el.childNodes[0]?.textContent || '';

                // Match "CURRENT BID" (case insensitive)
                if (text.toLowerCase().includes('current bid') && text.includes('$')) {
                    console.log('[Browser] Found CURRENT BID area:', text.substring(0, 50));

                    // Look for clickable elements within this area
                    const clickables = el.querySelectorAll('a, button, [role="button"], svg, i, span[class*="icon"], [class*="click"], [class*="bid"]');

                    for (const clickable of clickables) {
                        // Skip if it's a login button
                        const clickText = (clickable as HTMLElement).innerText?.toLowerCase() || '';
                        if (clickText.includes('log in') || clickText.includes('login')) continue;

                        console.log('[Browser] Clicking element in CURRENT BID area');
                        (clickable as HTMLElement).click();
                        return 'current_bid_child';
                    }

                    // If no specific clickable found, try clicking the container itself
                    (el as HTMLElement).click();
                    return 'current_bid_container';
                }
            }

            // Strategy 2: Look for SVG icons or icon elements near bid text
            const icons = document.querySelectorAll('svg, i[class*="icon"], span[class*="icon"], [class*="bid-icon"], [class*="bidder"]');
            for (const icon of icons) {
                const parent = icon.parentElement;
                const parentText = parent?.innerText || '';
                if (parentText.toLowerCase().includes('bid') || parentText.includes('$')) {
                    console.log('[Browser] Clicking bid icon');
                    (icon as HTMLElement).click();
                    return 'bid_icon';
                }
            }

            // Strategy 3: Look for any element with bid-related classes
            const bidElements = document.querySelectorAll('[class*="bid-history"], [class*="bidHistory"], [class*="bid-count"], [class*="bidCount"], [class*="current-bid"], [class*="currentBid"]');
            for (const el of bidElements) {
                console.log('[Browser] Clicking bid-class element');
                (el as HTMLElement).click();
                return 'bid_class';
            }

            // Strategy 4: Find elements with dollar amounts and click nearby clickable elements
            const dollarElements = Array.from(document.querySelectorAll('*')).filter(el => {
                const text = (el as HTMLElement).innerText?.trim() || '';
                return /^\$\d+\.\d{2}$/.test(text);
            });

            for (const dollarEl of dollarElements) {
                const parent = dollarEl.parentElement;
                if (!parent) continue;

                // Look for clickable siblings
                const siblings = Array.from(parent.children);
                for (const sibling of siblings) {
                    if (sibling === dollarEl) continue;
                    const tag = sibling.tagName.toLowerCase();
                    if (tag === 'a' || tag === 'button' || sibling.querySelector('svg, i')) {
                        console.log('[Browser] Clicking sibling of dollar amount');
                        (sibling as HTMLElement).click();
                        return 'dollar_sibling';
                    }
                }
            }

            // Strategy 5: Click on any text matching price pattern that might be a link
            const priceLinks = document.querySelectorAll('a, button, [role="button"]');
            for (const link of priceLinks) {
                const text = (link as HTMLElement).innerText || '';
                if (/\$\d+\.\d{2}/.test(text) && text.length < 50) {
                    console.log('[Browser] Clicking price link:', text);
                    (link as HTMLElement).click();
                    return 'price_link';
                }
            }

            return null;
        });

        if (clicked) {
            console.log(`[Navigator] Clicked using strategy: ${clicked}`);
        } else {
            console.log('[Navigator] Could not find bid history trigger');
        }

        // Wait for the dropdown/popup to appear
        await delay(2000);

        // Check if bid table appeared
        const tableAppeared = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            for (const table of tables) {
                const text = (table as HTMLElement).innerText.toLowerCase();
                if (text.includes('bidder') && text.includes('bid') && text.includes('$')) {
                    return true;
                }
            }
            // Also check for dropdown/popup content
            const popups = document.querySelectorAll('[class*="dropdown"], [class*="popup"], [class*="modal"], [role="listbox"], [role="menu"]');
            for (const popup of popups) {
                const text = (popup as HTMLElement).innerText;
                if (/\d{6,}/.test(text) && text.includes('$')) {
                    return true;
                }
            }
            return false;
        });

        console.log(`[Navigator] Bid table/popup appeared: ${tableAppeared}`);

        if (!tableAppeared) {
            // Try a second click strategy - sometimes need to scroll first
            console.log('[Navigator] Table not found, trying alternative click...');

            await page.evaluate(() => {
                // Try clicking any element that looks like it shows bid count
                const allText = document.body.innerText;
                const bidCountMatch = allText.match(/(\d+)\s*(?:bid|Bid)/);

                if (bidCountMatch) {
                    const elements = Array.from(document.querySelectorAll('*'));
                    for (const el of elements) {
                        const text = (el as HTMLElement).innerText?.trim() || '';
                        if (text === bidCountMatch[0] || text === `${bidCountMatch[1]} Bids` || text === `${bidCountMatch[1]} bids`) {
                            console.log('[Browser] Clicking bid count:', text);
                            (el as HTMLElement).click();
                            break;
                        }
                    }
                }
            });

            await delay(1500);
        }

    } catch (error) {
        console.error('[Navigator] Failed to open bid history popup:', error);
    }
}

/**
 * Extract bid history from BidFTA dropdown/popup
 *
 * BidFTA Table Format:
 * Headers: "Bidder ID" | "Bid" | "Date & Time"
 * Data:    "1331515"   | "$39.00" | "01/31/2026 10:50 AM ET"
 */
async function extractBidHistoryFromPopup(
    page: Page
): Promise<Array<{ bidderId: string; amount: number; bidTime?: string }>> {
    try {
        // Wait for bid table or dropdown to appear
        await page.waitForSelector('table', { timeout: 3000 }).catch(() => null);

        const bids = await page.evaluate(() => {
            const results: Array<{ bidderId: string; amount: number; bidTime: string }> = [];

            // Debug: Log all tables found
            const allTables = document.querySelectorAll('table');
            console.log(`[Browser] Found ${allTables.length} total tables on page`);

            // METHOD 1: BidFTA-specific table extraction
            // Look for table with "Bidder ID" header
            for (const table of allTables) {
                const tableText = (table as HTMLElement).innerText;
                const tableTextLower = tableText.toLowerCase();

                // BidFTA bid table has "Bidder ID" column
                const isBidFTATable = tableTextLower.includes('bidder id') ||
                                      tableTextLower.includes('bidder') && tableTextLower.includes('bid') && tableText.includes('$');

                if (!isBidFTATable) {
                    continue;
                }

                console.log('[Browser] Found BidFTA bid table:', tableText.substring(0, 100));

                // Get all rows (including header)
                const rows = table.querySelectorAll('tr');
                let isHeader = true;

                for (const row of rows) {
                    // Get cells - could be th or td
                    const cells = row.querySelectorAll('td, th');
                    if (cells.length < 2) continue;

                    const rowText = (row as HTMLElement).innerText;
                    const rowTextLower = rowText.toLowerCase();

                    // Skip header row
                    if (isHeader && (rowTextLower.includes('bidder id') || rowTextLower.includes('date & time'))) {
                        isHeader = false;
                        continue;
                    }

                    // BidFTA format: Cell 0 = Bidder ID, Cell 1 = Amount, Cell 2 = Date/Time
                    const cell0 = (cells[0] as HTMLElement).innerText.trim();
                    const cell1 = (cells[1] as HTMLElement).innerText.trim();
                    const cell2 = cells[2] ? (cells[2] as HTMLElement).innerText.trim() : '';

                    // Extract bidder ID (6-7 digit number)
                    const bidderIdMatch = cell0.match(/(\d{6,7})/);
                    if (!bidderIdMatch) continue;

                    // Extract amount (dollar value)
                    const amountMatch = cell1.match(/\$?([\d,]+\.?\d*)/);
                    if (!amountMatch) continue;

                    const bidderId = bidderIdMatch[1];
                    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));

                    if (bidderId && amount > 0) {
                        results.push({
                            bidderId,
                            amount,
                            bidTime: cell2 || new Date().toISOString()
                        });
                        console.log(`[Browser] Extracted bid: ${bidderId} $${amount} ${cell2}`);
                    }
                }

                // If we found bids, stop looking
                if (results.length > 0) {
                    console.log(`[Browser] Successfully extracted ${results.length} bids from table`);
                    break;
                }
            }

            // METHOD 2: Dropdown/popup text parsing (if table method failed)
            if (results.length === 0) {
                console.log('[Browser] Table method failed, trying dropdown text parsing...');

                // Look for dropdown or popup content
                const dropdownContent = document.querySelector('[class*="dropdown"], [class*="popup"], [class*="modal"], [role="listbox"], [role="menu"]');
                const searchArea = dropdownContent || document.body;
                const fullText = (searchArea as HTMLElement).innerText;

                // BidFTA bid line format: "1331515 $39.00 01/31/2026 10:50 AM ET"
                // Pattern: 6-7 digit ID, dollar amount, date/time
                const bidLinePattern = /(\d{6,7})\s+\$?([\d,]+\.?\d{2})\s+([\d\/]+\s+[\d:]+\s*(?:AM|PM)\s*(?:ET|EST|CT|CST|PT|PST)?)/gi;

                let match;
                while ((match = bidLinePattern.exec(fullText)) !== null) {
                    results.push({
                        bidderId: match[1],
                        amount: parseFloat(match[2].replace(/,/g, '')),
                        bidTime: match[3].trim()
                    });
                    console.log(`[Browser] Extracted from text: ${match[1]} $${match[2]} ${match[3]}`);
                }
            }

            // METHOD 3: Line-by-line parsing
            if (results.length === 0) {
                console.log('[Browser] Trying line-by-line parsing...');

                const lines = document.body.innerText.split('\n');
                for (const line of lines) {
                    // Look for lines that have: ID (6+ digits), dollar amount, and possibly a date
                    const idMatch = line.match(/\b(\d{6,7})\b/);
                    const amountMatch = line.match(/\$([\d,]+\.?\d{2})/);

                    if (idMatch && amountMatch) {
                        // Extract time if present
                        const timeMatch = line.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+[\d:]+\s*(?:AM|PM)?(?:\s*[A-Z]{2,3})?)/i);

                        results.push({
                            bidderId: idMatch[1],
                            amount: parseFloat(amountMatch[1].replace(/,/g, '')),
                            bidTime: timeMatch ? timeMatch[1] : new Date().toISOString()
                        });
                        console.log(`[Browser] Extracted from line: ${idMatch[1]} $${amountMatch[1]}`);
                    }
                }
            }

            console.log(`[Browser] Total bids extracted: ${results.length}`);
            return results;
        });

        console.log(`[Navigator] Extracted ${bids.length} bids from popup/page`);
        return bids;
    } catch (error) {
        console.error('[Navigator] Failed to extract bid history:', error);
        return [];
    }
}


/**
 * Extract bids from API response data
 * Handles various API response formats that auction sites might use
 */
function extractBidsFromApiResponse(data: any): Array<{ bidderId: string; amount: number; bidTime?: string }> {
    const bids: Array<{ bidderId: string; amount: number; bidTime?: string }> = [];

    if (!data) return bids;

    try {
        // Handle array of bids directly
        if (Array.isArray(data)) {
            for (const item of data) {
                const bid = extractBidFromObject(item);
                if (bid) bids.push(bid);
            }
        }

        // Handle nested structures
        const bidArrayKeys = ['bids', 'bidHistory', 'bid_history', 'history', 'items', 'data', 'results'];
        for (const key of bidArrayKeys) {
            if (data[key] && Array.isArray(data[key])) {
                for (const item of data[key]) {
                    const bid = extractBidFromObject(item);
                    if (bid) bids.push(bid);
                }
            }
        }

        // Handle single bid object
        if (typeof data === 'object' && !Array.isArray(data)) {
            const bid = extractBidFromObject(data);
            if (bid) bids.push(bid);
        }
    } catch (e) {
        console.error('[Navigator] Error extracting bids from API response:', e);
    }

    return bids;
}

/**
 * Extract bid info from a single object
 */
function extractBidFromObject(obj: any): { bidderId: string; amount: number; bidTime?: string } | null {
    if (!obj || typeof obj !== 'object') return null;

    // Common field names for bidder ID
    const idFields = ['bidderId', 'bidder_id', 'bidder', 'userId', 'user_id', 'id', 'memberId', 'member_id'];
    // Common field names for amount
    const amountFields = ['amount', 'bid', 'bidAmount', 'bid_amount', 'price', 'value'];
    // Common field names for time
    const timeFields = ['time', 'bidTime', 'bid_time', 'createdAt', 'created_at', 'timestamp', 'date'];

    let bidderId = '';
    let amount = 0;
    let bidTime = '';

    for (const field of idFields) {
        if (obj[field]) {
            bidderId = String(obj[field]);
            break;
        }
    }

    for (const field of amountFields) {
        if (obj[field] !== undefined) {
            amount = parseFloat(String(obj[field]).replace(/[^0-9.]/g, ''));
            break;
        }
    }

    for (const field of timeFields) {
        if (obj[field]) {
            bidTime = String(obj[field]);
            break;
        }
    }

    if (bidderId && amount > 0) {
        return { bidderId, amount, bidTime: bidTime || new Date().toISOString() };
    }

    return null;
}

/**
 * Extract bids directly from page text as a last resort
 * Looks for patterns like "BidderID: 1234567 Amount: $25.00"
 */
async function extractBidsFromPageText(page: Page): Promise<Array<{ bidderId: string; amount: number; bidTime?: string }>> {
    try {
        const bids = await page.evaluate(() => {
            const results: Array<{ bidderId: string; amount: number; bidTime: string }> = [];
            const bodyText = document.body.innerText;

            // Pattern 1: "BidderId Amount Time" format (space-separated in tables/lists)
            // e.g., "1366231  $26.01  01/30/2026 08:53 PM ET"
            const pattern1 = /(\d{6,})\s+\$?([\d,]+\.?\d*)\s+([\d\/]+(?:\s+[\d:]+\s*(?:AM|PM)?(?:\s+[A-Z]+)?)?)/gi;
            let match;
            while ((match = pattern1.exec(bodyText)) !== null) {
                results.push({
                    bidderId: match[1],
                    amount: parseFloat(match[2].replace(/,/g, '')),
                    bidTime: match[3].trim()
                });
            }

            // Pattern 2: Labeled format
            // e.g., "Bidder: 1234567" "Bid: $25.00"
            if (results.length === 0) {
                const bidderMatches = bodyText.match(/Bidder(?:\s*ID)?[:\s]+(\d{5,})/gi) || [];
                const amountMatches = bodyText.match(/(?:Bid|Amount)[:\s]+\$?([\d,]+\.?\d*)/gi) || [];

                const minLength = Math.min(bidderMatches.length, amountMatches.length);
                for (let i = 0; i < minLength; i++) {
                    const idMatch = bidderMatches[i].match(/(\d{5,})/);
                    const amtMatch = amountMatches[i].match(/([\d,]+\.?\d*)/);
                    if (idMatch && amtMatch) {
                        results.push({
                            bidderId: idMatch[1],
                            amount: parseFloat(amtMatch[1].replace(/,/g, '')),
                            bidTime: new Date().toISOString()
                        });
                    }
                }
            }

            // Pattern 3: Look for consecutive number and dollar amount
            // e.g., lines containing a long number followed by a dollar amount
            if (results.length === 0) {
                const lines = bodyText.split('\n');
                for (const line of lines) {
                    const idMatch = line.match(/\b(\d{6,})\b/);
                    const amountMatch = line.match(/\$([\d,]+\.?\d*)/);
                    if (idMatch && amountMatch) {
                        results.push({
                            bidderId: idMatch[1],
                            amount: parseFloat(amountMatch[1].replace(/,/g, '')),
                            bidTime: new Date().toISOString()
                        });
                    }
                }
            }

            return results;
        });

        console.log(`[Navigator] Extracted ${bids.length} bids from page text`);
        return bids;
    } catch (error) {
        console.error('[Navigator] Failed to extract bids from page text:', error);
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
