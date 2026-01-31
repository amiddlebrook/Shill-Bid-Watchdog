/**
 * Coordinator Agent - Durable Object
 * Orchestrates the AI agent swarm, manages task queue
 */

import type { Env, AgentTask, TaskType } from '../types';

interface TaskQueue {
    pending: AgentTask[];
    processing: AgentTask[];
}

export class CoordinatorAgent implements DurableObject {
    private state: DurableObjectState;
    private env: Env;
    private taskQueue: TaskQueue = { pending: [], processing: [] };

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
        this.env = env;

        // Restore state from storage
        this.state.blockConcurrencyWhile(async () => {
            const stored = await this.state.storage.get<TaskQueue>('taskQueue');
            if (stored) {
                this.taskQueue = stored;
            }
        });
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        switch (url.pathname) {
            case '/queue-task':
                return this.handleQueueTask(request);
            case '/process-next':
                return this.handleProcessNext();
            case '/status':
                return this.handleStatus();
            case '/clear':
                return this.handleClear();
            case '/cancel-tasks':
                return this.handleCancelTasks(request);
            case '/run-task-sync':
                return this.handleRunTaskSync(request);
            default:
                return new Response('Not Found', { status: 404 });
        }
    }

    private async handleCancelTasks(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const auctionId = parseInt(url.searchParams.get('auctionId') || '0');
        if (!auctionId) return Response.json({ success: false, error: 'Invalid ID' });

        const before = this.taskQueue.pending.length;
        this.taskQueue.pending = this.taskQueue.pending.filter(t => t.auctionId !== auctionId);

        // Also remove from processing if possible (can't stop execution, but remove from list)
        // this.taskQueue.processing = this.taskQueue.processing.filter(t => t.auctionId !== auctionId);

        await this.saveState();

        // Remove from DB tasks for cleanliness
        await this.env.DB.prepare('DELETE FROM agent_tasks WHERE auction_id = ? AND status = "pending"').bind(auctionId).run();

        return Response.json({ success: true, cancelled: before - this.taskQueue.pending.length });
    }

    private async handleQueueTask(request: Request): Promise<Response> {
        try {
            const body = await request.json() as Partial<AgentTask>;

            const task: AgentTask = {
                taskType: body.taskType || 'navigate_auction',
                targetUrl: body.targetUrl,
                auctionId: body.auctionId,
                status: 'pending',
                attempts: 0,
                scheduledAt: new Date().toISOString()
            };

            this.taskQueue.pending.push(task);
            await this.saveState();

            // Also persist to D1 for durability
            await this.env.DB.prepare(`
        INSERT INTO agent_tasks (task_type, target_url, auction_id, status, scheduled_at)
        VALUES (?, ?, ?, 'pending', datetime('now'))
      `).bind(task.taskType, task.targetUrl || null, task.auctionId || null).run();

            // Schedule processing via alarm
            await this.state.storage.setAlarm(Date.now() + 1000);

            return Response.json({ success: true, queued: true });
        } catch (error) {
            return Response.json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, { status: 500 });
        }
    }

    private async handleRunTaskSync(request: Request): Promise<Response> {
        try {
            const body = await request.json() as Partial<AgentTask>;

            const task: AgentTask = {
                taskType: (body.taskType || 'navigate_auction') as TaskType,
                targetUrl: body.targetUrl,
                auctionId: body.auctionId,
                status: 'running',
                attempts: 0,
                scheduledAt: new Date().toISOString()
            };

            await this.executeTask(task);

            return Response.json({ success: true });
        } catch (error) {
            return Response.json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, { status: 500 });
        }
    }

    private async handleProcessNext(): Promise<Response> {
        console.log('[Coordinator] handleProcessNext called, pending tasks:', this.taskQueue.pending.length);

        const task = this.taskQueue.pending.shift();
        if (!task) {
            console.log('[Coordinator] No pending tasks');
            return Response.json({ success: true, message: 'No pending tasks' });
        }

        console.log('[Coordinator] Processing task:', task.taskType, task.targetUrl);
        task.status = 'running';
        task.attempts++;
        this.taskQueue.processing.push(task);
        await this.saveState();

        try {
            // Dispatch to appropriate handler
            console.log('[Coordinator] Executing task...');
            const result = await this.executeTask(task);
            console.log('[Coordinator] Task completed successfully:', result);

            // Mark as completed
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
            this.taskQueue.processing = this.taskQueue.processing.filter(t => t !== task);
            await this.saveState();

            // Update task in DB - saving result to last_error for debugging purposes
            await this.env.DB.prepare(`
                UPDATE agent_tasks SET 
                    status = 'completed', 
                    completed_at = datetime('now'),
                    last_error = ? 
                WHERE task_type = ? AND auction_id = ?
            `).bind(JSON.stringify(result).substring(0, 5000), task.taskType, task.auctionId).run();

            return Response.json({ success: true, result });
        } catch (error) {
            console.error('[Coordinator] Task failed:', error);
            task.status = 'failed';
            task.lastError = error instanceof Error ? error.message : 'Unknown error';

            // Update task in DB
            await this.env.DB.prepare(`
                UPDATE agent_tasks SET status = 'failed', last_error = ?
                WHERE task_type = ? AND auction_id = ?
            `).bind(task.lastError, task.taskType, task.auctionId).run();

            // If navigation failed, update auction status to error so UI shows it
            if (task.taskType === 'navigate_auction' && task.auctionId) {
                await this.env.DB.prepare(`
                    UPDATE auctions SET status = 'error' 
                    WHERE id = ?
                `).bind(task.auctionId).run();
            }

            // Retry up to 3 times
            if (task.attempts < 3) {
                task.status = 'pending';
                this.taskQueue.pending.push(task);
                console.log('[Coordinator] Will retry, attempt', task.attempts);
            }

            this.taskQueue.processing = this.taskQueue.processing.filter(t => t !== task);
            await this.saveState();

            return Response.json({ success: false, error: task.lastError });
        }
    }

    private async executeTask(task: AgentTask): Promise<unknown> {
        switch (task.taskType) {
            case 'navigate_auction':
                return this.executeNavigateAuction(task);
            case 'extract_bids':
                return this.executeExtractBids(task);
            case 'analyze_auction':
                return this.executeAnalyzeAuction(task);
            default:
                throw new Error(`Unknown task type: ${task.taskType}`);
        }
    }

    private async executeNavigateAuction(task: AgentTask): Promise<unknown> {
        if (!task.targetUrl) {
            throw new Error('Target URL required for navigation');
        }

        // Import navigator functions
        const { navigateBidFTA, storeAuctionData } = await import('./navigator');

        // Use Puppeteer via Navigator to extract data
        const result = await navigateBidFTA(task.targetUrl, this.env);

        if (!result.success) {
            throw new Error(result.error || 'Navigation failed');
        }

        // Store extracted data in database (update existing if ID provided)
        const auctionDbId = await storeAuctionData(result, this.env, task.auctionId);

        // Update auction with extracted data, but don't resurrect if deleted
        await this.env.DB.prepare(`
            UPDATE auctions SET
                item_name = ?,
                current_price = ?,
                status = CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'extracted' END,
                last_checked = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ?
        `).bind(result.itemName, result.currentPrice, task.auctionId || auctionDbId).run();

        // Queue the analysis task
        this.taskQueue.pending.push({
            taskType: 'analyze_auction',
            auctionId: task.auctionId || auctionDbId,
            status: 'pending',
            attempts: 0,
            scheduledAt: new Date().toISOString()
        });
        await this.saveState();

        return {
            success: true,
            itemName: result.itemName,
            bidsExtracted: result.bids?.length || 0,
            lotCode: result.lotCode
        };
    }

    private async executeExtractBids(task: AgentTask): Promise<unknown> {
        // Extract bid history from stored page data
        // This will be filled in from navigator results
        return { message: 'Extraction completed' };
    }

    private async executeAnalyzeAuction(task: AgentTask): Promise<unknown> {
        if (!task.auctionId) {
            throw new Error('Auction ID required for analysis');
        }

        // Fetch bids from database
        const bids = await this.env.DB.prepare(`
      SELECT * FROM bids WHERE auction_id = ? ORDER BY bid_order ASC
    `).bind(task.auctionId).all();

        if (!bids.results?.length) {
            return { message: 'No bids to analyze' };
        }

        // Import and run analyzer
        const { analyzeAuction } = await import('./analyzer');
        const result = await analyzeAuction(
            task.auctionId,
            bids.results as any[],
            this.env
        );

        return result;
    }

    private handleStatus(): Response {
        return Response.json({
            success: true,
            data: {
                pending: this.taskQueue.pending.length,
                processing: this.taskQueue.processing.length,
                tasks: [...this.taskQueue.pending, ...this.taskQueue.processing]
            }
        });
    }

    private async handleClear(): Promise<Response> {
        this.taskQueue = { pending: [], processing: [] };
        await this.saveState();
        return Response.json({ success: true, cleared: true });
    }

    private async saveState(): Promise<void> {
        await this.state.storage.put('taskQueue', this.taskQueue);
    }

    // Alarm handler for scheduled processing
    async alarm(): Promise<void> {
        if (this.taskQueue.pending.length > 0) {
            await this.handleProcessNext();

            // Schedule next if more tasks
            if (this.taskQueue.pending.length > 0) {
                await this.state.storage.setAlarm(Date.now() + 2000);
            }
        }
    }
}
