/**
 * ShillBid Watchdog - Main Worker Entry Point
 * Cloudflare Worker with Hono routing
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';
import type { Env, ApiResponse, Auction, Alert, WatchAuctionRequest } from './types';
import { CoordinatorAgent } from './agents/coordinator';
import { TOOLS, executeTool } from './tools';

// Export Durable Object
export { CoordinatorAgent };

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());

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

// Debug: Get coordinator status
app.get('/api/debug/coordinator', async (c) => {
    try {
        const coordinatorId = c.env.COORDINATOR.idFromName('main');
        const coordinator = c.env.COORDINATOR.get(coordinatorId);
        const response = await coordinator.fetch(new Request('http://internal/status'));
        const data = await response.json();
        return c.json({ success: true, data });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
});

// Debug: Manually trigger task processing
app.post('/api/debug/process', async (c) => {
    try {
        const coordinatorId = c.env.COORDINATOR.idFromName('main');
        const coordinator = c.env.COORDINATOR.get(coordinatorId);
        const response = await coordinator.fetch(new Request('http://internal/process-next'));
        const data = await response.json();
        return c.json({ success: true, data });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
});

// Debug: Check agent tasks in database
app.get('/api/debug/tasks', async (c) => {
    try {
        const tasks = await c.env.DB.prepare(`
            SELECT * FROM agent_tasks ORDER BY scheduled_at DESC LIMIT 20
        `).all();
        return c.json({ success: true, data: tasks.results });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
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

// Delete auction
app.delete('/api/auctions/:id', async (c) => {
    try {
        const id = c.req.param('id');

        // 1. Cancel pending tasks to prevent zombie resurrection
        const coordinatorId = c.env.COORDINATOR.idFromName('main');
        const coordinator = c.env.COORDINATOR.get(coordinatorId);
        await coordinator.fetch(new Request(`http://internal/cancel-tasks?auctionId=${id}`));

        // 2. Delete children first (FK constraints)
        await c.env.DB.prepare('DELETE FROM alerts WHERE auction_id = ?').bind(id).run();
        await c.env.DB.prepare('DELETE FROM bids WHERE auction_id = ?').bind(id).run();
        // 3. Soft Delete parent (hide from view)
        await c.env.DB.prepare("UPDATE auctions SET status = 'deleted' WHERE id = ?").bind(id).run();

        return c.json({ success: true, deleted: true });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed to delete' }, 500);
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
      WHERE a.status != 'deleted'
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

// Trigger analysis
app.post('/api/auctions/:id/analyze', async (c) => {
    try {
        const id = c.req.param('id');
        const auction = await c.env.DB.prepare('SELECT * FROM auctions WHERE id = ?').bind(id).first();
        if (!auction) return c.json({ success: false, error: 'Auction not found' }, 404);

        const coordinatorId = c.env.COORDINATOR.idFromName('main');
        const coordinator = c.env.COORDINATOR.get(coordinatorId);

        await coordinator.fetch(new Request('http://internal/queue-task', {
            method: 'POST',
            body: JSON.stringify({
                taskType: 'analyze_auction', // Assuming this task type is supported
                auctionId: auction.id,
                scheduledAt: new Date().toISOString()
            })
        }));

        return c.json({ success: true, queued: true });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed' }, 500);
    }
});

// Trigger re-extraction
app.post('/api/auctions/:id/extract', async (c) => {
    try {
        const id = c.req.param('id');
        const auction = await c.env.DB.prepare('SELECT * FROM auctions WHERE id = ?').bind(id).first();
        if (!auction) return c.json({ success: false, error: 'Auction not found' }, 404);

        const coordinatorId = c.env.COORDINATOR.idFromName('main');
        const coordinator = c.env.COORDINATOR.get(coordinatorId);

        await coordinator.fetch(new Request('http://internal/queue-task', {
            method: 'POST',
            body: JSON.stringify({
                taskType: 'navigate_auction',
                targetUrl: auction.url,
                auctionId: auction.id,
                scheduledAt: new Date().toISOString()
            })
        }));

        return c.json({ success: true, queued: true });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed' }, 500);
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

// AI Chat Endpoint
app.post('/api/chat', async (c) => {
    try {
        const body = await c.req.json<{ message: string; history?: any[] }>();
        const { message, history } = body;

        // 1. Check for URL in message
        const urlMatch = message.match(/https?:\/\/[^\s]+/);
        let actionResult = null;
        let contextInfo = '';

        if (urlMatch) {
            // User provided a URL, try to watch it
            const url = urlMatch[0];
            const auctionId = extractAuctionId(url);

            // Check if already watching
            const existing = await c.env.DB.prepare('SELECT * FROM auctions WHERE auction_id = ?').bind(auctionId).first() as any;

            // If it exists and is NOT deleted, just report it
            if (existing && existing.status !== 'deleted') {
                contextInfo = `The user mentioned auction ${auctionId}, which we are already watching. Status: ${existing.status}. Item: ${existing.item_name}.`;
            } else {
                let targetId: number | undefined;

                if (existing && existing.status === 'deleted') {
                    // Restore deleted auction
                    await c.env.DB.prepare("UPDATE auctions SET status = 'watching', updated_at = datetime('now') WHERE id = ?").bind(existing.id).run();
                    targetId = existing.id;
                } else {
                    // Insert new
                    const newAuction = await c.env.DB.prepare(`
                        INSERT INTO auctions (auction_id, source, url, status)
                        VALUES (?, ?, ?, 'watching')
                        RETURNING id
                    `).bind(auctionId, detectSource(url), url).first() as any;
                    targetId = newAuction?.id;
                }

                // Trigger EXTRACTION synchronously
                // Only proceed if we have a target ID
                if (targetId) {
                    const coordinatorId = c.env.COORDINATOR.idFromName('main');
                    const coordinator = c.env.COORDINATOR.get(coordinatorId);

                    // Wait for the agent to navigate and extract
                    await coordinator.fetch(new Request('http://internal/run-task-sync', {
                        method: 'POST',
                        body: JSON.stringify({
                            taskType: 'navigate_auction',
                            targetUrl: url,
                            auctionId: targetId,
                            scheduledAt: new Date().toISOString()
                        })
                    }));

                    // Fetch the FRESH data
                    const freshData = await c.env.DB.prepare('SELECT * FROM auctions WHERE id = ?').bind(targetId).first();

                    if (freshData?.status === 'extracted' || freshData?.item_name) {
                        contextInfo = `I have successfully added and SCANNED the auction. Item: "${freshData.item_name}". Price: $${freshData.current_price}. Status: ${freshData.status}.`;
                    } else if (freshData?.status === 'error') {
                        contextInfo = `I tried to scan the auction but encountered an error. Status: error.`;
                    } else {
                        contextInfo = `I added the auction but the scan is still pending/incomplete.`;
                    }
                } else {
                    contextInfo = `Failed to track auction (DB Error).`;
                }
            }
        }

        // 2. Run AI logic with Tool Loop
        const systemPrompt = `You are the ShillBid Watchdog AI, an expert in detecting auction fraud on platforms like BidFTA.
        
        TOOLS AVAILABLE:
        ${JSON.stringify(TOOLS, null, 2)}
        
        INSTRUCTIONS:
        - You can perform actions by outputting a JSON block: {"tool": "tool_name", "args": {...}}
        - ONLY output the JSON block if you want to use a tool.
        - After tool execution, you will see the result and can respond to the user.
        - BE INTERACTIVE: Ask the user questions ("Should I analyze this?", "Do you want to delete this?") to keep them engaged.
        - PROVIDE STATUS: When taking multiple steps, narrate what you are doing ("I am starting the scan...", "Found 5 bids, now calculating risk...").
        - If asked to "analyze" or "scan" or "delete", USE THE TOOLS.
        - If asked to "list" or "show", USE THE list_auctions TOOL.
        - Explain risk scores based on tool outputs.

        CRITICAL: 
        - If an auction was just added, its data might be "Pending". DO NOT GUESS or HALLUCINATE item details.
        - Only talk about specific item details if you see them in the "Context" or tool outputs.
        - If data is missing, say "I'm gathering the data...".

        STYLE GUIDELINES (Enforced):
        - When presenting lists of any kind (auctions, bidders, logs), ALWAYS use Markdown Tables.
          Format: | ID | Name | Value |...
        - When making assessments:
          Use '### Key Findings' for bullet points.
          Use '### Recommendation' for final verdict.
        - Start response with a brief 1-line summary.
        - Use bolding (**text**) for important metrics or risks.
        
        Current Context: ${contextInfo}
        `;

        let historyWithContext = [
            { role: 'system', content: systemPrompt },
            ...(history || []).slice(-10),
            { role: 'user', content: message }
        ];

        let aiResponse = await runAI(c.env, historyWithContext);
        let actionTaken = !!urlMatch;

        // Tool execution loop (max 3 turns)
        for (let i = 0; i < 3; i++) {
            try {
                // Check for tool call in response (JSON)
                // Use a regex to find the last JSON block if mixed with text, or just parse if it looks like JSON
                const jsonMatch = aiResponse.match(/\{[\s\S]*"tool"[\s\S]*\}/);

                if (jsonMatch) {
                    const toolCallStr = jsonMatch[0];
                    const toolCall = JSON.parse(toolCallStr);

                    if (toolCall.tool && toolCall.args) {
                        actionTaken = true;
                        // Execute tool
                        const result = await executeTool(toolCall.tool, toolCall.args, c.env);

                        // Append result to history
                        historyWithContext.push({ role: 'assistant', content: aiResponse });
                        historyWithContext.push({ role: 'system', content: `Tool Output (${toolCall.tool}): ${result}` });

                        // Run AI again
                        aiResponse = await runAI(c.env, historyWithContext);
                    } else {
                        break; // Invalid JSON structure, stop
                    }
                } else {
                    break; // No tool call, stop
                }
            } catch (e) {
                console.error('Tool loop error:', e);
                break;
            }
        }

        return c.json({
            success: true,
            message: aiResponse,
            actionTaken: actionTaken
        });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'AI Error' }, 500);
    }
});

async function runAI(env: Env, messages: any[]) {
    try {
        const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages
        });

        return (response as any).response || "I'm having trouble thinking right now.";
    } catch (e) {
        console.error('AI Error:', e);
        return "I'm offline right now (AI Error).";
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

function extractAuctionId(url: string): string {
    // BidFTA new format: https://www.bidfta.com/569416/item-detail/50968437
    // Pattern: /item-detail/12345678
    const bidfitaDetailMatch = url.match(/item-detail\/(\d+)/i);
    if (bidfitaDetailMatch) return `bidfta-${bidfitaDetailMatch[1]}`;

    // BidFTA old format: https://www.bidfta.com/items?item=123456
    const bidfitaQueryMatch = url.match(/[?&]item=(\d+)/i);
    if (bidfitaQueryMatch) return `bidfta-${bidfitaQueryMatch[1]}`;

    // eBay: https://www.ebay.com/itm/123456
    const ebayMatch = url.match(/itm[\\/=](\d+)/i);
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

export default app;
