
import type { Env, Auction } from './types';

// ============================================================================
// Tool Definitions
// ============================================================================

export const TOOLS = [
    {
        name: 'list_auctions',
        description: 'List auctions with optional filtering. Use this to see what is being watched.',
        parameters: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['watching', 'ended', 'analyzed', 'deleted', 'all'], description: 'Filter by status (default: all except deleted)' },
                riskLevel: { type: 'string', enum: ['HIGH', 'CRITICAL', 'MEDIUM', 'LOW', 'NONE'], description: 'Filter by risk level' },
                search: { type: 'string', description: 'Search term for item name or ID' },
                limit: { type: 'number', description: 'Max results (default 20)' }
            }
        }
    },
    {
        name: 'delete_auction',
        description: 'Soft delete an auction. It will be hidden from lists but valid for historical queries if needed.',
        parameters: {
            type: 'object',
            properties: {
                auctionTypeIdOrId: { type: 'string', description: 'The public auction ID (e.g. bidfta-123) or internal numeric ID' }
            },
            required: ['auctionTypeIdOrId']
        }
    },
    {
        name: 'restore_auction',
        description: 'Restore a deleted auction to watching status.',
        parameters: {
            type: 'object',
            properties: {
                auctionTypeIdOrId: { type: 'string' }
            },
            required: ['auctionTypeIdOrId']
        }
    },
    {
        name: 'analyze_auction',
        description: 'Trigger a deep analysis of an auction. This recalculates risk scores based on new data.',
        parameters: {
            type: 'object',
            properties: {
                auctionTypeIdOrId: { type: 'string' }
            },
            required: ['auctionTypeIdOrId']
        }
    },
    {
        name: 'watch_auction',
        description: 'Start watching a new auction URL. This will queue it for scanning.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                source: { type: 'string', enum: ['bidfta', 'ebay'] }
            },
            required: ['url']
        }
    },
    {
        name: 'update_risk_manual',
        description: 'Manually set the risk level for an auction based on your expert assessment.',
        parameters: {
            type: 'object',
            properties: {
                auctionTypeIdOrId: { type: 'string' },
                riskLevel: { type: 'string', enum: ['HIGH', 'CRITICAL', 'MEDIUM', 'LOW', 'NONE'] },
                reason: { type: 'string', description: 'Reason for the manual override' }
            },
            required: ['auctionTypeIdOrId', 'riskLevel']
        }
    }
];

// ============================================================================
// Tool Execution
// ============================================================================

export async function executeTool(name: string, args: any, env: Env): Promise<string> {
    try {
        switch (name) {
            case 'list_auctions':
                return await listAuctions(env, args);
            case 'delete_auction':
                return await deleteAuction(env, args.auctionTypeIdOrId);
            case 'restore_auction':
                return await restoreAuction(env, args.auctionTypeIdOrId);
            case 'analyze_auction':
                return await analyzeAuction(env, args.auctionTypeIdOrId);
            case 'watch_auction':
                return await watchAuction(env, args.url, args.source);
            case 'update_risk_manual':
                return await updateRiskManual(env, args.auctionTypeIdOrId, args.riskLevel, args.reason);
            default:
                return `Error: Unknown tool '${name}'`;
        }
    } catch (error) {
        return `Error executing '${name}': ${error instanceof Error ? error.message : String(error)}`;
    }
}

// ============================================================================
// Implementations
// ============================================================================

async function listAuctions(env: Env, args: any): Promise<string> {
    let query = `SELECT id, auction_id, item_name, current_price, status, risk_level, risk_score FROM auctions WHERE 1=1`;
    const params: any[] = [];

    // Default to hiding deleted unless 'deleted' or 'all' is requested
    if (args.status === 'deleted') {
        query += ` AND status = 'deleted'`;
    } else if (args.status !== 'all') {
        query += ` AND status != 'deleted'`;
        if (args.status) {
            query += ` AND status = ?`;
            params.push(args.status);
        }
    }

    if (args.riskLevel) {
        query += ` AND risk_level = ?`;
        params.push(args.riskLevel);
    }

    if (args.search) {
        query += ` AND (item_name LIKE ? OR auction_id LIKE ?)`;
        params.push(`%${args.search}%`, `%${args.search}%`);
    }

    query += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(args.limit || 20);

    const results = await env.DB.prepare(query).bind(...params).all();

    if (results.results.length === 0) return "No auctions found matching criteria.";

    return JSON.stringify(results.results, null, 2);
}

async function resolveAuctionId(env: Env, idOrCode: string): Promise<number | null> {
    // Try numeric ID first
    if (/^\d+$/.test(idOrCode)) {
        const byId = await env.DB.prepare('SELECT id FROM auctions WHERE id = ?').bind(Number(idOrCode)).first();
        if (byId) return byId.id as number;
    }

    // Try string ID
    const byCode = await env.DB.prepare('SELECT id FROM auctions WHERE auction_id = ?').bind(idOrCode).first();
    if (byCode) return byCode.id as number;

    return null;
}

async function deleteAuction(env: Env, idOrCode: string): Promise<string> {
    const id = await resolveAuctionId(env, idOrCode);
    if (!id) return `Auction '${idOrCode}' not found.`;

    await env.DB.prepare("UPDATE auctions SET status = 'deleted' WHERE id = ?").bind(id).run();

    // Cancel any pending tasks
    const coordinatorId = env.COORDINATOR.idFromName('main');
    const coordinator = env.COORDINATOR.get(coordinatorId);
    try {
        await coordinator.fetch(new Request(`http://internal/cancel-tasks?auctionId=${id}`));
    } catch (e) { /* ignore */ }

    return `Auction ${idOrCode} (ID: ${id}) has been soft-deleted.`;
}

async function restoreAuction(env: Env, idOrCode: string): Promise<string> {
    const id = await resolveAuctionId(env, idOrCode);
    if (!id) return `Auction '${idOrCode}' not found.`;

    await env.DB.prepare("UPDATE auctions SET status = 'watching' WHERE id = ?").bind(id).run();
    return `Auction ${idOrCode} restored to 'watching' status.`;
}

async function analyzeAuction(env: Env, idOrCode: string): Promise<string> {
    const id = await resolveAuctionId(env, idOrCode);
    if (!id) return `Auction '${idOrCode}' not found.`;

    const coordinatorId = env.COORDINATOR.idFromName('main');
    const coordinator = env.COORDINATOR.get(coordinatorId);

    await coordinator.fetch(new Request('http://internal/queue-task', {
        method: 'POST',
        body: JSON.stringify({
            taskType: 'analyze_auction',
            auctionId: id,
            scheduledAt: new Date().toISOString()
        })
    }));

    return `Analysis queued for auction ${id}.`;
}

async function watchAuction(env: Env, url: string, source?: string): Promise<string> {
    // Basic source detection (simplified from index.ts)
    const detectedSource = source || (url.includes('ebay') ? 'ebay' : 'bidfta');

    // We need to call the API or replicate logic. Since we are in the worker env, we can just insert directly.
    // However, duplicate logic with index.ts is risky.
    // For now, let's replicate the insert-if-not-exists logic.

    // Extract ID (simplified) - Reuse the one in index.ts if possible? 
    // We can't import valid functions easily if they are not exported.
    // I'll assume the URL is enough to be unique for now or let the DB Constraints handle it?
    // DB has auction_id UNIQUE. I need to generate it.

    // Let's defer to the index logic by making a self-request? No, inconsistent.
    // I will import extractAuctionId logic later or just do a simple hash for now if not bidfta.

    let auctionId = '';
    const match = url.match(/item-detail\/(\d+)/i) || url.match(/[?&]item=(\d+)/i) || url.match(/itm[\\/=](\d+)/i);
    if (match) {
        auctionId = (url.includes('ebay') ? 'ebay-' : 'bidfta-') + match[1];
    } else {
        auctionId = 'unknown-' + Date.now();
    }

    const result = await env.DB.prepare(`
      INSERT INTO auctions (auction_id, source, url, status)
      VALUES (?, ?, ?, 'watching')
      ON CONFLICT(auction_id) DO UPDATE SET
        url = excluded.url,
        status = 'watching', -- Auto-restore if was deleted!
        updated_at = datetime('now')
      RETURNING *
    `).bind(auctionId, detectedSource, url).first();

    const coordinatorId = env.COORDINATOR.idFromName('main');
    const coordinator = env.COORDINATOR.get(coordinatorId);
    await coordinator.fetch(new Request('http://internal/queue-task', {
        method: 'POST',
        body: JSON.stringify({
            taskType: 'navigate_auction',
            targetUrl: url,
            auctionId: result.id
        })
    }));

    return `Started watching ${url} (ID: ${auctionId}). Scan queued.`;
}

async function updateRiskManual(env: Env, idOrCode: string, riskLevel: string, reason: string): Promise<string> {
    const id = await resolveAuctionId(env, idOrCode);
    if (!id) return `Auction '${idOrCode}' not found.`;

    // Map level to approximate score for consistency
    const scores = { 'NONE': 0.1, 'LOW': 0.3, 'MEDIUM': 0.5, 'HIGH': 0.8, 'CRITICAL': 0.95 };
    const score = scores[riskLevel as keyof typeof scores] || 0.5;

    await env.DB.prepare(`
        UPDATE auctions 
        SET risk_level = ?, risk_score = ? 
        WHERE id = ?
    `).bind(riskLevel, score, id).run();

    // Log an alert for this manual override
    await env.DB.prepare(`
        INSERT INTO alerts (auction_id, risk_level, summary, violations, acknowledged)
        VALUES (?, ?, ?, ?, 0)
    `).bind(id, riskLevel, `Manual Agent Override: ${reason}`, '["Manual Intervention"]').run();

    return `Updated auction ${id} risk level to ${riskLevel}.`;
}
