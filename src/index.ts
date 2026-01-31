/**
 * ShillBid Watchdog - Main Worker Entry Point
 * Cloudflare Worker with Hono routing
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';
import type { Env, ApiResponse, Auction, Alert, WatchAuctionRequest } from './types';
import { CoordinatorAgent } from './agents/coordinator';

// Export Durable Object
export { CoordinatorAgent };

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());

// ============================================================================
// Static Assets (Dashboard)
// ============================================================================

app.get('/', async (c) => {
    // Serve the main dashboard
    return c.html(await getIndexHtml());
});

// ============================================================================
// API Routes
// ============================================================================

// Health check
app.get('/api/health', (c) => {
    return c.json<ApiResponse<{ status: string }>>({
        success: true,
        data: { status: 'healthy' }
    });
});

// Watch a new auction
app.post('/api/auctions/watch', async (c) => {
    try {
        const body = await c.req.json<WatchAuctionRequest>();

        if (!body.url) {
            return c.json<ApiResponse<null>>({
                success: false,
                error: 'URL is required'
            }, 400);
        }

        // Extract auction ID from URL
        const auctionId = extractAuctionId(body.url);
        const source = body.source || detectSource(body.url);

        // Insert into database
        const result = await c.env.DB.prepare(`
      INSERT INTO auctions (auction_id, source, url, status)
      VALUES (?, ?, ?, 'watching')
      ON CONFLICT(auction_id) DO UPDATE SET
        url = excluded.url,
        updated_at = datetime('now')
      RETURNING *
    `).bind(auctionId, source, body.url).first();

        // Queue navigation task via Coordinator
        const coordinatorId = c.env.COORDINATOR.idFromName('main');
        const coordinator = c.env.COORDINATOR.get(coordinatorId);
        await coordinator.fetch(new Request('http://internal/queue-task', {
            method: 'POST',
            body: JSON.stringify({
                taskType: 'navigate_auction',
                targetUrl: body.url,
                auctionId: result?.id
            })
        }));

        return c.json<ApiResponse<typeof result>>({
            success: true,
            data: result
        });
    } catch (error) {
        return c.json<ApiResponse<null>>({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Get all watched auctions
app.get('/api/auctions', async (c) => {
    try {
        const results = await c.env.DB.prepare(`
      SELECT a.*, 
        (SELECT COUNT(*) FROM bids WHERE auction_id = a.id) as bid_count,
        (SELECT COUNT(*) FROM alerts WHERE auction_id = a.id AND acknowledged = 0) as alert_count
      FROM auctions a
      ORDER BY a.updated_at DESC
      LIMIT 50
    `).all();

        return c.json<ApiResponse<typeof results.results>>({
            success: true,
            data: results.results
        });
    } catch (error) {
        return c.json<ApiResponse<null>>({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Get auction details with bids
app.get('/api/auctions/:id', async (c) => {
    try {
        const id = c.req.param('id');

        const auction = await c.env.DB.prepare(`
      SELECT * FROM auctions WHERE id = ? OR auction_id = ?
    `).bind(id, id).first();

        if (!auction) {
            return c.json<ApiResponse<null>>({
                success: false,
                error: 'Auction not found'
            }, 404);
        }

        const bids = await c.env.DB.prepare(`
      SELECT * FROM bids WHERE auction_id = ? ORDER BY bid_order ASC
    `).bind(auction.id).all();

        const alerts = await c.env.DB.prepare(`
      SELECT * FROM alerts WHERE auction_id = ? ORDER BY created_at DESC
    `).bind(auction.id).all();

        return c.json<ApiResponse<{
            auction: typeof auction;
            bids: typeof bids.results;
            alerts: typeof alerts.results;
        }>>({
            success: true,
            data: {
                auction,
                bids: bids.results,
                alerts: alerts.results
            }
        });
    } catch (error) {
        return c.json<ApiResponse<null>>({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Get all alerts
app.get('/api/alerts', async (c) => {
    try {
        const unacknowledgedOnly = c.req.query('unacknowledged') === 'true';

        let query = `
      SELECT al.*, a.auction_id as auction_code, a.item_name, a.url
      FROM alerts al
      JOIN auctions a ON al.auction_id = a.id
    `;

        if (unacknowledgedOnly) {
            query += ' WHERE al.acknowledged = 0';
        }

        query += ' ORDER BY al.created_at DESC LIMIT 100';

        const results = await c.env.DB.prepare(query).all();

        return c.json<ApiResponse<typeof results.results>>({
            success: true,
            data: results.results
        });
    } catch (error) {
        return c.json<ApiResponse<null>>({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Acknowledge an alert
app.post('/api/alerts/:id/acknowledge', async (c) => {
    try {
        const id = c.req.param('id');

        await c.env.DB.prepare(`
      UPDATE alerts SET acknowledged = 1 WHERE id = ?
    `).bind(id).run();

        return c.json<ApiResponse<{ acknowledged: true }>>({
            success: true,
            data: { acknowledged: true }
        });
    } catch (error) {
        return c.json<ApiResponse<null>>({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Get bidder profile
app.get('/api/bidders/:id', async (c) => {
    try {
        const bidderId = c.req.param('id');

        const bidder = await c.env.DB.prepare(`
      SELECT * FROM bidders WHERE bidder_id = ?
    `).bind(bidderId).first();

        if (!bidder) {
            return c.json<ApiResponse<null>>({
                success: false,
                error: 'Bidder not found'
            }, 404);
        }

        // Get bidder's auction history
        const auctionHistory = await c.env.DB.prepare(`
      SELECT DISTINCT a.* 
      FROM auctions a
      JOIN bids b ON a.id = b.auction_id
      WHERE b.bidder_id = ?
      ORDER BY a.updated_at DESC
      LIMIT 20
    `).bind(bidderId).all();

        // Get bidding pairs
        const pairs = await c.env.DB.prepare(`
      SELECT * FROM bidding_pairs 
      WHERE bidder_a = ? OR bidder_b = ?
      ORDER BY suspicion_score DESC
      LIMIT 10
    `).bind(bidderId, bidderId).all();

        return c.json<ApiResponse<{
            bidder: typeof bidder;
            auctionHistory: typeof auctionHistory.results;
            biddingPairs: typeof pairs.results;
        }>>({
            success: true,
            data: {
                bidder,
                auctionHistory: auctionHistory.results,
                biddingPairs: pairs.results
            }
        });
    } catch (error) {
        return c.json<ApiResponse<null>>({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Trigger manual analysis
app.post('/api/auctions/:id/analyze', async (c) => {
    try {
        const id = c.req.param('id');

        const auction = await c.env.DB.prepare(`
      SELECT * FROM auctions WHERE id = ? OR auction_id = ?
    `).bind(id, id).first();

        if (!auction) {
            return c.json<ApiResponse<null>>({
                success: false,
                error: 'Auction not found'
            }, 404);
        }

        // Queue analysis task
        const coordinatorId = c.env.COORDINATOR.idFromName('main');
        const coordinator = c.env.COORDINATOR.get(coordinatorId);
        await coordinator.fetch(new Request('http://internal/queue-task', {
            method: 'POST',
            body: JSON.stringify({
                taskType: 'analyze_auction',
                auctionId: auction.id
            })
        }));

        return c.json<ApiResponse<{ queued: true }>>({
            success: true,
            data: { queued: true }
        });
    } catch (error) {
        return c.json<ApiResponse<null>>({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Dashboard stats
app.get('/api/stats', async (c) => {
    try {
        const [auctionCount, alertCount, bidderCount, recentAlerts] = await Promise.all([
            c.env.DB.prepare('SELECT COUNT(*) as count FROM auctions').first(),
            c.env.DB.prepare('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0').first(),
            c.env.DB.prepare('SELECT COUNT(*) as count FROM bidders WHERE suspicion_score > 0.5').first(),
            c.env.DB.prepare(`
        SELECT risk_level, COUNT(*) as count 
        FROM alerts 
        GROUP BY risk_level
      `).all()
        ]);

        return c.json<ApiResponse<{
            totalAuctions: number;
            activeAlerts: number;
            suspiciousBidders: number;
            alertsByLevel: typeof recentAlerts.results;
        }>>({
            success: true,
            data: {
                totalAuctions: (auctionCount as any)?.count || 0,
                activeAlerts: (alertCount as any)?.count || 0,
                suspiciousBidders: (bidderCount as any)?.count || 0,
                alertsByLevel: recentAlerts.results
            }
        });
    } catch (error) {
        return c.json<ApiResponse<null>>({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// ============================================================================
// Helper Functions
// ============================================================================

function extractAuctionId(url: string): string {
    // BidFTA: https://www.bidfta.com/items?item=123456
    const bidfitaMatch = url.match(/item[=\/](\d+)/i);
    if (bidfitaMatch) return `bidfta-${bidfitaMatch[1]}`;

    // eBay: https://www.ebay.com/itm/123456
    const ebayMatch = url.match(/itm[\/=](\d+)/i);
    if (ebayMatch) return `ebay-${ebayMatch[1]}`;

    // Fallback: hash the URL
    return `unknown-${hashCode(url)}`;
}

function detectSource(url: string): 'bidfta' | 'ebay' | 'other' {
    if (url.includes('bidfta.com')) return 'bidfta';
    if (url.includes('ebay.com')) return 'ebay';
    return 'other';
}

function hashCode(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

async function getIndexHtml(): Promise<string> {
    // This will be replaced with actual static file serving
    // For now, return a basic dashboard structure
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ShillBid Watchdog</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}

export default app;
