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
            default:
                return new Response('Not Found', { status: 404 });
        }
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

    private async handleProcessNext(): Promise<Response> {
        const task = this.taskQueue.pending.shift();
        if (!task) {
            return Response.json({ success: true, message: 'No pending tasks' });
        }

        task.status = 'running';
        task.attempts++;
        this.taskQueue.processing.push(task);
        await this.saveState();

        try {
            // Dispatch to appropriate handler
            const result = await this.executeTask(task);

            // Mark as completed
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
            this.taskQueue.processing = this.taskQueue.processing.filter(t => t !== task);
            await this.saveState();

            return Response.json({ success: true, result });
        } catch (error) {
            task.status = 'failed';
            task.lastError = error instanceof Error ? error.message : 'Unknown error';

            // Retry up to 3 times
            if (task.attempts < 3) {
                task.status = 'pending';
                this.taskQueue.pending.push(task);
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

        // Use Browser Rendering to navigate and extract data
        // This is handled by the Navigator Agent
        const response = await this.env.BROWSER.fetch(
            new Request('https://browser-rendering.workers.dev/content', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: task.targetUrl,
                    // Will implement full navigation in navigator.ts
                })
            })
        );

        if (!response.ok) {
            throw new Error(`Navigation failed: ${response.statusText}`);
        }

        // Parse the result and queue analysis
        const data = await response.json();

        // Queue the analysis task
        this.taskQueue.pending.push({
            taskType: 'analyze_auction',
            auctionId: task.auctionId,
            status: 'pending',
            attempts: 0,
            scheduledAt: new Date().toISOString()
        });
        await this.saveState();

        return data;
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
