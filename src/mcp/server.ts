import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { readFileSync, existsSync } from "node:fs";
import { logger } from "../utils/logger.js";
import { writeVaultNote } from "../memory/vault.js";
import { ingestFile } from "../memory/ingest.js";
import { searchObsidianHybrid } from "./search-obsidian.js";
import { buildObsidianNote } from "../memory/obsidian.js";
import { braveWebSearch, braveNewsSearch, braveImageSearch, braveVideoSearch, braveLocalSearch } from "./brave-search.js";
import { openBrowser, closeBrowser, browserStatus } from "../browser/launcher.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { Channel } from "../channels/types.js";
import type { ProposalStore } from "../proposals/store.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { TraceStore } from "../memory/traces.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { ThreadDB } from "../server/db/threads.js";
import type { Scheduler } from "../scheduler/index.js";
import type { MemoryStore } from "../memory/store.js";
import type { CoordinationStore } from "./coordination.js";
import { MCP_DEDUP_WINDOW_MS } from "../defaults.js";
import { getProposalReviewEligibility } from "../proposals/review-policy.js";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { deriveCrawlSourceName, runCrawlCommand, validateCrawlUrl } from "../crawl/index.js";

import { registerTradingTools } from "./trading-tools.js";

export interface McpDeps {
	queue: QueueDB;
	processor: QueueProcessor;
	proposalStore?: ProposalStore;
	registry?: AgentRegistry;
	traces?: TraceStore;
	knowledge?: KnowledgeStore;
	embedder?: EmbeddingProvider;
	threadDb?: ThreadDB;
	scheduler?: Scheduler;
	memory?: MemoryStore;
	graph?: import("../memory/graph.js").GraphMemory;
	logPath?: string;
	vaultPath?: string;
	projects?: Array<{ name: string; repo_path: string; default?: boolean }>;
	coordination?: CoordinationStore;
	routing?: import("../memory/routing.js").RoutingStore;
	activeDelegations?: Map<string, { agent: string; task: string; dispatchedAt: number; convId: string; fromAgent: string }>;
	instanceName?: string;
	crawlService?: CrawlService;
	crawlSources?: CrawlSourceStore;
	crawlIngest?: CrawlIngestBridge;
	remotes?: Record<string, { url: string; api_key_env: string; description?: string; agents?: string[] }>;
	slackBotToken?: string;
	tradingDb?: import("../trading/db.js").TradingDB;
}

export function normalizeSlackMessageText(text: string): string {
	let normalized = text;
	const trimmed = normalized.trim();

	if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") {
				normalized = parsed;
			}
		} catch {
			// Fall through to escaped-newline normalization.
		}
	}

	if (!normalized.includes("\n") && (normalized.includes("\\n") || normalized.includes("\\r\\n"))) {
		normalized = normalized.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
	}

	return normalized;
}

export interface SlackReadMessagesArgs {
	channel: string;
	thread_ts?: string;
	limit?: number;
	cursor?: string;
	oldest?: string;
	latest?: string;
}

export function buildSlackReadMessagesRequest(args: SlackReadMessagesArgs): { method: string; body: Record<string, unknown> } {
	const body: Record<string, unknown> = {
		channel: args.channel,
		limit: Math.min(args.limit ?? 20, 100),
	};

	if (args.cursor) body.cursor = args.cursor;
	if (args.oldest) body.oldest = args.oldest;
	if (args.latest) body.latest = args.latest;

	if (args.thread_ts) {
		body.ts = args.thread_ts;
		return { method: "conversations.replies", body };
	}

	return { method: "conversations.history", body };
}

export function formatSlackReadMessagesResult(result: Record<string, unknown>): {
	ok: true;
	count: number;
	next_cursor: string;
	messages: Array<{ user: string; text: string; ts: string }>;
} {
	const messages = (result.messages as Array<{ user?: string; text?: string; ts?: string }>) ?? [];
	const responseMetadata = result.response_metadata;
	const nextCursor = typeof responseMetadata === "object" && responseMetadata !== null && "next_cursor" in responseMetadata
		? (typeof responseMetadata.next_cursor === "string" ? responseMetadata.next_cursor : "")
		: "";

	return {
		ok: true,
		count: messages.length,
		next_cursor: nextCursor,
		messages: messages.map(m => ({
			user: m.user ?? "unknown",
			text: m.text ?? "",
			ts: m.ts ?? "",
		})),
	};
}

export interface ChannelToolSummary {
	name: string;
	connected: boolean;
	supports_outbound: boolean;
}

export function buildChannelToolList(channels: Channel[] = []): {
	ok: true;
	count: number;
	channels: ChannelToolSummary[];
} {
	const summaries = channels.map(channel => ({
		name: channel.name,
		connected: channel.isConnected(),
		supports_outbound: typeof channel.sendOutbound === "function",
	}));
	return { ok: true, count: summaries.length, channels: summaries };
}

export async function sendChannelToolMessage(
	channels: Channel[],
	args: {
		channel: string;
		recipient: string;
		message: string;
		agent?: string;
		reply_to_id?: string;
	},
): Promise<{ ok: true; channel: string; recipient: string } | { ok: false; error: string }> {
	const target = channels.find(channel => channel.name.toLowerCase() === args.channel.toLowerCase());
	if (!target) return { ok: false, error: `Channel "${args.channel}" not found` };
	if (!target.sendOutbound) {
		return { ok: false, error: `Channel "${target.name}" does not support outbound messages` };
	}

	try {
		await target.sendOutbound(args.recipient, args.message, args.agent, args.reply_to_id);
		return { ok: true, channel: target.name, recipient: args.recipient };
	} catch (err) {
		return { ok: false, error: `Failed to send: ${err}` };
	}
}

function createMcpServer(deps: McpDeps): McpServer {
	const serverName = deps.instanceName?.toLowerCase().replace(/[^a-z0-9]+/g, "_") ?? "nyxhive";
	const server = new McpServer({ name: serverName, version: "0.1.0" });

	// 1. send_message
	server.registerTool(
		"send_message",
		{
				description: "Send a NEW message to NyxHive (queued for processing by Nyx). Do NOT use this to echo back or re-send your current task — that creates infinite loops.",
			inputSchema: {
				message: z.string().describe("The message to send"),
				agent: z.string().optional().describe("Target agent (default: primary lead)"),
				files: z.array(z.object({
					name: z.string().describe("File name (e.g. 'report.pdf')"),
					type: z.string().describe("MIME type (e.g. 'image/png', 'application/pdf', 'text/plain')"),
					data: z.string().describe("Base64-encoded file content"),
				})).max(5).optional().describe("File attachments (max 5, each up to 10MB base64)"),
			},
		},
		async ({ message, agent, files }) => {
			// Same-channel dedup (exact match within 10s)
			const dup = deps.queue.findRecentDuplicate("mcp", "claude-code", message);
			if (dup) {
				return { content: [{ type: "text" as const, text: JSON.stringify({ duplicate: true, existing_id: dup }) }] };
			}

			// Cross-channel dedup: reject if same content was sent on ANY channel recently
			const crossDup = deps.queue.findRecentDuplicateAnyChannel(message, MCP_DEDUP_WINDOW_MS);
			if (crossDup) {
				logger.warn(`[mcp] send_message blocked: cross-channel duplicate (already on ${crossDup.channel} as ${crossDup.message_id})`);
				return { content: [{ type: "text" as const, text: JSON.stringify({ duplicate: true, existing_id: crossDup.message_id, existing_channel: crossDup.channel }) }] };
			}

			// Guard: reject if message content overlaps with any active delegation task.
			// This prevents agents from re-queuing their own delegated work.
			if (deps.activeDelegations) {
				for (const [, del] of deps.activeDelegations) {
					const taskPrefix = del.task.slice(0, 200).toLowerCase();
					const msgPrefix = message.slice(0, 200).toLowerCase();
					// Check if the message substantially overlaps with an active delegation
					const overlap = taskPrefix.split(/\s+/).filter(w => w.length > 4 && msgPrefix.includes(w));
					if (overlap.length > 5) {
						logger.warn(`[mcp] send_message blocked: message overlaps with active delegation to ${del.agent} (${overlap.length} keyword matches)`);
						return { content: [{ type: "text" as const, text: JSON.stringify({ blocked: true, reason: "Message overlaps with an active delegation. Do not re-queue your own task." }) }] };
					}
				}
			}

			const id = deps.queue.enqueueMessage({
				channel: "mcp",
				sender: "claude-code",
				message,
				agent,
				files: files ? JSON.stringify(files) : undefined,
			});
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, message_id: id }) }] };
		},
	);

	server.registerTool(
		"channels_list",
		{
			description: "List connected NyxHive channels and whether each supports outbound messages.",
			inputSchema: {},
		},
		async () => {
			return { content: [{ type: "text" as const, text: JSON.stringify(buildChannelToolList(deps.processor.getChannels() ?? [])) }] };
		},
	);

	server.registerTool(
		"channel_send",
		{
			description: "Send an outbound message through a configured NyxHive channel such as Discord, Telegram, Slack, or iOS.",
			inputSchema: {
				channel: z.string().describe("Channel name, e.g. discord, telegram, slack, ios"),
				recipient: z.string().describe("Recipient/channel/thread id understood by that channel"),
				message: z.string().describe("Message text to send"),
				agent: z.string().optional().describe("Agent name to associate with the outbound message"),
				reply_to_id: z.string().optional().describe("Optional thread/message id to reply to when the channel supports it"),
			},
		},
		async ({ channel, recipient, message, agent, reply_to_id }) => {
			const result = await sendChannelToolMessage(deps.processor.getChannels() ?? [], {
				channel,
				recipient,
				message,
				agent,
				reply_to_id,
			});
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
		},
	);

	// 1b. relay_message (cross-instance)
	server.registerTool(
		"relay_message",
		{
			description: "Send a message to a remote NyxHive instance. Use this to communicate across instances (e.g., NyxLabs→NyxAI).",
			inputSchema: {
				instance: z.string().describe("Target instance name (must be configured in [remotes])"),
				message: z.string().describe("The message to send"),
				agent: z.string().optional().describe("Target agent on the remote instance (default: primary lead)"),
				fire_and_forget: z.boolean().optional().describe("If true, queue and return immediately without waiting for response"),
				nonce: z.string().optional().describe("Dedup nonce — auto-generated if not provided"),
				files: z.array(z.object({
					name: z.string().describe("File name (e.g. 'report.pdf')"),
					type: z.string().describe("MIME type (e.g. 'image/png', 'application/pdf', 'text/plain')"),
					data: z.string().describe("Base64-encoded file content"),
				})).max(5).optional().describe("File attachments (max 5, each up to 10MB base64)"),
			},
		},
		async ({ instance, message, agent, fire_and_forget: asyncMode, nonce, files }) => {
			const remotes = deps.remotes;
			if (!remotes) {
				return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No remotes configured" }) }] };
			}

			const instanceConfig = remotes[instance];
			if (!instanceConfig) {
				const known = Object.keys(remotes);
				return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown instance "${instance}". Known remotes: ${known.join(", ")}` }) }] };
			}

			const apiKey = process.env[instanceConfig.api_key_env];
			if (!apiKey) {
				return { content: [{ type: "text" as const, text: JSON.stringify({ error: `API key env var "${instanceConfig.api_key_env}" is not set` }) }] };
			}

			const url = instanceConfig.url;
			const sender = deps.instanceName ?? "unknown";
			const relayNonce = nonce ?? crypto.randomUUID();
			logger.info(`[mcp] relay_message: ${sender} → ${instance} (agent=${agent ?? "primary-lead"}, async=${!!asyncMode}, nonce=${relayNonce.slice(0, 8)})`);

			// 130s client abort — gives the server's 115s relay timeout room to respond before we give up
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 130_000);
			try {
				const res = await fetch(`${url}/api/message`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({ message, agent, channel: "relay", sender, async: asyncMode, nonce: relayNonce, files }),
					signal: controller.signal,
				});

				// Parse the body regardless of status — timeout responses carry message_id
				const data = await res.json().catch(() => null);

				if (!res.ok) {
					// Relay sync timeout: server enqueued and returned {message_id, status: "running", timeout: true}
					if (data && typeof data === "object" && "timeout" in data && data.timeout === true) {
						logger.warn(`[mcp] relay_message timed out on remote, queued as ${data.message_id}`);
						return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, instance, timeout: true, message_id: data.message_id, status: "running", hint: `Poll GET ${url}/api/runs?message_id=${data.message_id} for result` }) }] };
					}
					const rawBody = data ? JSON.stringify(data) : "(empty)";
					logger.error(`[mcp] relay_message failed: ${res.status} ${rawBody}`);
					return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Remote returned ${res.status}`, body: rawBody }) }] };
				}

				return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, instance, response: data ?? {} }) }] };
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error(`[mcp] relay_message error: ${msg}`);
				return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }] };
			} finally {
				clearTimeout(timeout);
			}
		},
	);

	// 2. list_proposals
	server.registerTool(
		"list_proposals",
		{
			description: "List proposals with optional status filter",
			inputSchema: {
				status: z
					.enum(["proposed", "reviewing", "reviewed", "approved", "executing", "completed", "rejected", "failed", "expired"])
					.optional()
					.describe("Filter by status"),
			},
		},
		async ({ status }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const proposals = deps.proposalStore.list({ status });
			return { content: [{ type: "text" as const, text: JSON.stringify(proposals) }] };
		},
	);

	// 3. approve_proposal
	server.registerTool(
		"approve_proposal",
		{
			description: "Approve a proposal and trigger execution",
			inputSchema: {
				proposal_id: z.string().describe("The proposal ID (with or without 'proposal-' prefix)"),
			},
		},
		async ({ proposal_id }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const id = proposal_id.startsWith("proposal-") ? proposal_id : `proposal-${proposal_id}`;
			const proposal = deps.proposalStore.get(id);
			if (!proposal || !["proposed", "reviewing", "reviewed"].includes(proposal.status)) {
				return { content: [{ type: "text" as const, text: "Proposal not found or cannot be approved" }], isError: true };
			}
			const result = deps.proposalStore.approve(id, "claude-code");
			if (!result || result.status !== "approved") {
				return { content: [{ type: "text" as const, text: "Failed to approve proposal" }], isError: true };
			}

			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, proposal: result }) }] };
		},
	);

	// 4. reject_proposal
	server.registerTool(
		"reject_proposal",
		{
			description: "Reject a proposal with a reason",
			inputSchema: {
				proposal_id: z.string().describe("The proposal ID"),
				reason: z.string().describe("Reason for rejection"),
			},
		},
		async ({ proposal_id, reason }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const id = proposal_id.startsWith("proposal-") ? proposal_id : `proposal-${proposal_id}`;
			const result = deps.proposalStore.reject(id, reason);
			if (!result || result.status !== "rejected") {
				return { content: [{ type: "text" as const, text: "Proposal not found or cannot be rejected" }], isError: true };
			}
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, proposal: result }) }] };
		},
	);

	// 4b. requeue_proposal (retry failed/completed)
	server.registerTool(
		"requeue_proposal",
		{
			description: "Requeue a failed or completed proposal back to proposed state for re-review and re-execution",
			inputSchema: {
				proposal_id: z.string().describe("The proposal ID"),
			},
		},
		async ({ proposal_id }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const id = proposal_id.startsWith("proposal-") ? proposal_id : `proposal-${proposal_id}`;
			const proposal = deps.proposalStore.get(id);
			if (!proposal) return { content: [{ type: "text" as const, text: "Proposal not found" }], isError: true };
			if (!["completed", "failed"].includes(proposal.status)) {
				return { content: [{ type: "text" as const, text: `Proposal status is "${proposal.status}" — can only requeue completed or failed proposals` }], isError: true };
			}
			deps.proposalStore.resetToProposed(id);
			const updated = deps.proposalStore.get(id);
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, proposal: updated }) }] };
		},
	);

	// 5. list_agents
	server.registerTool(
		"list_agents",
		{
			description: "List all registered agents with stats",
		},
		async () => {
			if (!deps.registry) return { content: [{ type: "text" as const, text: "Agent registry not available" }], isError: true };
			const summary = deps.registry.getStatsSummary();
			return { content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
		},
	);

	// 6. get_usage
	server.registerTool(
		"get_usage",
		{
			description: "Get per-agent cost breakdown",
			inputSchema: {
				hours: z.number().optional().describe("Time window in hours (default: 168 = 7 days)"),
			},
		},
		async ({ hours }) => {
			if (!deps.traces) return { content: [{ type: "text" as const, text: "Trace store not available" }], isError: true };
			const h = hours ?? 168;
			const since = Date.now() - h * 3600000;
			const breakdown = deps.traces.getCostByAgent(since);
			const knownAgents = deps.registry?.getKnownAgentKeys() ?? null;
			const filtered = knownAgents ? breakdown.filter((a) => knownAgents.has(a.agent.toLowerCase())) : breakdown;
			const totalEstimated = Math.round(filtered.reduce((s, a) => s + a.total_cost, 0) * 10000) / 100;
			const totalActual = Math.round(filtered.reduce((s, a) => s + a.actual_cost, 0) * 10000) / 100;
			const userBreakdown = deps.traces.getCostByUser(since);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							period_hours: h,
							agents: filtered.map((a) => ({
								agent: a.agent,
								invocations: a.count,
								total_cost_cents: Math.round(a.total_cost * 10000) / 100,
								actual_cost_cents: Math.round(a.actual_cost * 10000) / 100,
								total_tokens_in: a.tokens_in,
								total_tokens_out: a.tokens_out,
								avg_duration_ms: a.avg_duration,
								task_types: a.task_types,
							})),
							users: userBreakdown.map((u) => ({
								sender_id: u.sender_id,
								name: u.sender,
								channel: u.channel,
								conversations: u.conversations,
								invocations: u.invocations,
								total_cost_cents: Math.round(u.total_cost * 10000) / 100,
								actual_cost_cents: Math.round(u.actual_cost * 10000) / 100,
								total_tokens_in: u.tokens_in,
								total_tokens_out: u.tokens_out,
								first_seen: u.first_seen,
								last_seen: u.last_seen,
							})),
							total_cost_cents: totalEstimated,
							actual_cost_cents: totalActual,
						}),
					},
				],
			};
		},
	);

	// 7. search_knowledge
	server.registerTool(
		"search_knowledge",
		{
			description: "Search the knowledge store using semantic embeddings. Provide task context for better relevance ranking.",
			inputSchema: {
				query: z.string().describe("Search query"),
				limit: z.number().optional().describe("Max results (default: 5)"),
				category: z.string().optional().describe("Filter by category"),
				file_paths: z.array(z.string()).optional().describe("Current file paths for relevance boosting"),
				task_type: z.enum(["debug", "code", "review", "chat"]).optional().describe("Task type for category boosting"),
				keywords: z.array(z.string()).optional().describe("Additional keywords for relevance matching"),
			},
		},
		async ({ query, limit, category, file_paths, task_type, keywords }) => {
			if (!deps.knowledge || !deps.embedder) {
				return { content: [{ type: "text" as const, text: "Knowledge store or embedder not available" }], isError: true };
			}
			const embedding = await deps.embedder.embed(query);
			const taskContext = (file_paths || task_type || keywords)
				? { filePaths: file_paths, taskType: task_type, keywords }
				: undefined;
			const results = deps.knowledge.search(embedding, limit ?? 5, 0.5, undefined, category, query, taskContext);
			return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
		},
	);

	// 8. list_threads
	server.registerTool(
		"list_threads",
		{
			description: "List conversation threads",
			inputSchema: {
				limit: z.number().optional().describe("Max threads to return (default: 20)"),
			},
		},
		async ({ limit }) => {
			if (!deps.threadDb) return { content: [{ type: "text" as const, text: "Thread DB not available" }], isError: true };
			const result = deps.threadDb.listThreads({ limit: limit ?? 20 });
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
		},
	);

	// 9. crawl_page
	server.registerTool(
		"crawl_page",
		{
			description: "Fetch a single web page as markdown via Cloudflare Browser Rendering",
			inputSchema: {
				url: z.string().url().describe("The page URL to fetch"),
			},
		},
		async ({ url }) => {
			const urlError = validateCrawlUrl(url);
			if (urlError) {
				return { content: [{ type: "text" as const, text: urlError }], isError: true };
			}
			if (!deps.crawlService) {
				return { content: [{ type: "text" as const, text: "Crawl service not available" }], isError: true };
			}
			try {
				const markdown = await deps.crawlService.fetchPage(url);
				return { content: [{ type: "text" as const, text: markdown }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `crawl_page failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 10. crawl_site
	server.registerTool(
		"crawl_site",
		{
			description: "Crawl a site, ingest the markdown into knowledge, and optionally save it as a recurring crawl source",
			inputSchema: {
				url: z.string().url().describe("The root URL to crawl"),
				name: z.string().optional().describe("Saved source name (required when save_source=true unless derived from URL)"),
				depth: z.number().min(1).max(10).optional().describe("Maximum crawl depth"),
				limit: z.number().min(1).max(500).optional().describe("Maximum pages to crawl"),
				scope: z.string().optional().describe("Knowledge scope tag for ingested chunks"),
				path_glob: z.string().optional().describe("Optional include pattern, e.g. /docs/**"),
				save_source: z.boolean().optional().describe("Save as a recurring crawl source"),
				schedule: z.string().optional().describe("Cron schedule when save_source=true (default: weekly)"),
			},
		},
		async ({ url, name, depth, limit, scope, path_glob, save_source, schedule }) => {
			const urlError = validateCrawlUrl(url);
			if (urlError) {
				return { content: [{ type: "text" as const, text: urlError }], isError: true };
			}
			try {
				const result = await runCrawlCommand({
					url,
					name: name ?? deriveCrawlSourceName(url),
					depth,
					limit,
					scope,
					pathGlob: path_glob,
					saveSource: save_source,
					schedule,
					origin: "agent:mcp",
				}, {
					service: deps.crawlService,
					sources: deps.crawlSources,
					ingest: deps.crawlIngest,
				});
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							pages_crawled: result.pagesCrawled,
							pages_ingested: result.pagesIngested,
							chunks_created: result.chunksCreated,
							chunks_skipped: result.chunksSkipped,
							errors: result.errors,
							source_id: result.sourceId,
						}),
					}],
				};
			} catch (err) {
				return { content: [{ type: "text" as const, text: `crawl_site failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 11. trigger_scan
	server.registerTool(
		"trigger_scan",
		{
			description: "Trigger a scheduled scan task (e.g. discovery crons)",
			inputSchema: {
				task_name: z.string().describe("Task ID or name"),
			},
		},
		async ({ task_name }) => {
			if (!deps.scheduler) return { content: [{ type: "text" as const, text: "Scheduler not available" }], isError: true };
			const task = deps.scheduler.getTask(task_name) ?? deps.scheduler.getTaskByName(task_name);
			if (!task) return { content: [{ type: "text" as const, text: `Task '${task_name}' not found` }], isError: true };
			// Fire-and-forget: don't await — tasks can take minutes.
			deps.scheduler.triggerTask(task.id).catch(() => {});
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, triggered: task.id, name: task.name }) }] };
		},
	);

	// 12. get_queue_status
	server.registerTool(
		"get_queue_status",
		{
			description: "Get message queue statistics",
		},
		async () => {
			const stats = deps.queue.getQueueStats();
			return { content: [{ type: "text" as const, text: JSON.stringify(stats) }] };
		},
	);

	// 13. get_context_pressure
	server.registerTool(
		"get_context_pressure",
		{
			description: "Get the current context pressure band and headroom for a conversation",
			inputSchema: {
				conversation_id: z.string().describe("The conversation ID (for example: gateway:thread-id or telegram:user-id)"),
			},
		},
		async ({ conversation_id }) => {
			const pressure = deps.processor.getContextPressure(conversation_id);
			if (!pressure) {
				return { content: [{ type: "text" as const, text: "Conversation not found or memory unavailable" }], isError: true };
			}
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						conversation_id,
						...pressure,
					}),
				}],
			};
		},
	);

	// 14. get_thread
	server.registerTool(
		"get_thread",
		{
			description: "Get a thread with its messages",
			inputSchema: {
				thread_id: z.string().describe("The thread ID"),
				message_limit: z.number().optional().describe("Max messages to return (default: all)"),
			},
		},
		async ({ thread_id, message_limit }) => {
			if (!deps.threadDb) return { content: [{ type: "text" as const, text: "Thread DB not available" }], isError: true };
			const thread = deps.threadDb.getThread(thread_id);
			if (!thread) return { content: [{ type: "text" as const, text: "Thread not found" }], isError: true };
			if (message_limit && thread.messages) {
				thread.messages = thread.messages.slice(-message_limit);
			}
			return { content: [{ type: "text" as const, text: JSON.stringify(thread) }] };
		},
	);

	// 15. get_proposal
	server.registerTool(
		"get_proposal",
		{
			description: "Get a single proposal with full details and review results",
			inputSchema: {
				proposal_id: z.string().describe("The proposal ID"),
			},
		},
		async ({ proposal_id }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const id = proposal_id.startsWith("proposal-") ? proposal_id : `proposal-${proposal_id}`;
			const proposal = deps.proposalStore.get(id);
			if (!proposal) return { content: [{ type: "text" as const, text: "Proposal not found" }], isError: true };
			return { content: [{ type: "text" as const, text: JSON.stringify(proposal) }] };
		},
	);

	// 16. start_review
	server.registerTool(
		"start_review",
		{
			description: "Trigger AI review on a proposal (moves to reviewing status). Optionally specify which model to use.",
			inputSchema: {
				proposal_id: z.string().describe("The proposal ID"),
				model: z.string().optional().describe("Model to use for review (for example 'claude-opus-4-6', 'gpt-5.5', or 'o3'). Defaults to the best model for the active brain."),
			},
		},
		async ({ proposal_id, model }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const id = proposal_id.startsWith("proposal-") ? proposal_id : `proposal-${proposal_id}`;
			const proposal = deps.proposalStore.get(id);
			if (!proposal) return { content: [{ type: "text" as const, text: "Proposal not found" }], isError: true };
			const eligibility = getProposalReviewEligibility(proposal);
			if (!eligibility.ok) {
				return { content: [{ type: "text" as const, text: eligibility.error }], isError: true };
			}
			if (!deps.proposalStore.markReviewing(id)) {
				return { content: [{ type: "text" as const, text: "Proposal is already being reviewed or cannot be reviewed" }], isError: true };
			}
			// Trigger async review
			(async () => {
				try {
					const reviewPrompt = `You are reviewing a proposal from a less experienced agent. User trusts YOUR judgment — give a clear verdict. Read the affected files in the codebase before judging.

Title: ${proposal.title}
Category: ${proposal.category}
Priority: ${proposal.priority}
Effort: ${proposal.effort}
Description: ${proposal.description}
Files affected: ${proposal.files_affected?.join(", ") || "none listed"}
Proposed by: ${proposal.proposed_by}

If the proposal has minor issues (unclear description, wrong effort/priority, missing files), FIX them yourself and approve with corrections. Only REJECT if the proposal is fundamentally wrong or not worth doing. There is no "needs modification" — either fix it and approve, or reject it.

Do your analysis, then END with this exact format:

---
**Verdict: APPROVE** (or REJECT)
**Why:** 1-2 sentences explaining your reasoning in plain language.
**Effort:** Your corrected estimate (trivial/small/medium/large) if different from proposed.
**Corrected Title:** Only if the original title needs fixing, otherwise omit.
**Corrected Description:** Only if the original description needs fixing, otherwise omit.
**Corrected Files:** Only if the files list is wrong/incomplete, otherwise omit. Comma-separated.
---`;
					const reviewSender = `proposal-review:${id}`;
					const reviewAgent = deps.processor.resolveReviewAgent(["nyx", "analyst"]);
					const result = await deps.processor.processImmediate({
						channel: "system",
						sender: reviewSender,
						message: reviewPrompt,
						agent: reviewAgent,
						trust: "system",
						modelOverride: deps.processor.resolveProposalReviewModel(["nyx", "analyst"], model),
					});
					deps.proposalStore!.saveReview(id, result.response, result.agent);
					deps.processor.clearConversation("system", reviewSender);
				} catch (err) {
					deps.proposalStore!.saveReview(id, `Review failed: ${err}`, "system");
					deps.processor.clearConversation("system", `proposal-review:${id}`);
				}
			})();
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, proposal_id: id, status: "reviewing" }) }] };
		},
	);

	// 17. list_scheduled_tasks
	server.registerTool(
		"list_scheduled_tasks",
		{
			description: "List all scheduled tasks (crons and one-shots)",
		},
		async () => {
			if (!deps.scheduler) return { content: [{ type: "text" as const, text: "Scheduler not available" }], isError: true };
			const tasks = deps.scheduler.listTasks();
			return { content: [{ type: "text" as const, text: JSON.stringify(tasks) }] };
		},
	);

	// 18. get_logs
	server.registerTool(
		"get_logs",
		{
			description: "Tail recent server log lines",
			inputSchema: {
				lines: z.number().optional().describe("Number of lines to tail (default: 100)"),
			},
		},
		async ({ lines }) => {
			if (!deps.logPath) return { content: [{ type: "text" as const, text: "Log path not configured" }], isError: true };
			if (!existsSync(deps.logPath)) return { content: [{ type: "text" as const, text: "Log file not found" }], isError: true };
			try {
				const content = readFileSync(deps.logPath, "utf-8");
				const allLines = content.split("\n").filter(Boolean);
				const tailed = allLines.slice(-(lines ?? 100));
				return { content: [{ type: "text" as const, text: tailed.join("\n") }] };
			} catch {
				return { content: [{ type: "text" as const, text: "Failed to read log file" }], isError: true };
			}
		},
	);

	// 19. complete_proposal
	server.registerTool(
		"complete_proposal",
		{
			description: "Mark an approved/executing proposal as completed with optional result and PR URL",
			inputSchema: {
				proposal_id: z.string().describe("The proposal ID"),
				result: z.string().optional().describe("Execution result summary"),
				executed_by: z.string().optional().describe("Agent that executed the work"),
				pr_url: z.string().optional().describe("GitHub PR URL"),
			},
		},
		async ({ proposal_id, result, executed_by, pr_url }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const id = proposal_id.startsWith("proposal-") ? proposal_id : `proposal-${proposal_id}`;
			const proposal = deps.proposalStore.get(id);
			if (!proposal || !["approved", "executing"].includes(proposal.status)) {
				return { content: [{ type: "text" as const, text: "Proposal not found or not in approved/executing status" }], isError: true };
			}
			deps.proposalStore.markCompleted(id, result, executed_by, pr_url ?? null);
			const updated = deps.proposalStore.get(id);
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, proposal: updated }) }] };
		},
	);

	// 20. delete_proposal
	server.registerTool(
		"delete_proposal",
		{
			description: "Delete a proposal",
			inputSchema: {
				proposal_id: z.string().describe("The proposal ID"),
			},
		},
		async ({ proposal_id }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const id = proposal_id.startsWith("proposal-") ? proposal_id : `proposal-${proposal_id}`;
			const deleted = deps.proposalStore.delete(id);
			if (!deleted) return { content: [{ type: "text" as const, text: "Proposal not found" }], isError: true };
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, deleted: id }) }] };
		},
	);

	// 17. create_proposal
	server.registerTool(
		"create_proposal",
		{
			description: "Create a new proposal",
			inputSchema: {
				title: z.string().describe("Proposal title"),
				description: z.string().describe("Detailed description of the change"),
				category: z.enum(["maintenance", "feature", "bugfix", "improvement", "new_instance"]).describe("Proposal category"),
				priority: z.enum(["low", "medium", "high"]).optional().describe("Priority (default: medium)"),
				effort: z.enum(["small", "medium", "large"]).optional().describe("Effort estimate (default: medium)"),
				files_affected: z.array(
					z.string()
						.refine(s => !s.includes("\0") && !s.startsWith("/") && !s.startsWith("\\") && !s.includes(".."), "Invalid path")
				).optional().describe("List of affected file paths (relative, no traversal)"),
				scout_source: z.string().optional().describe("Source scan identifier (e.g. 'scout:codebase-health')"),
			},
		},
		async ({ title, description, category, priority, effort, files_affected, scout_source }) => {
			if (!deps.proposalStore) return { content: [{ type: "text" as const, text: "Proposal store not available" }], isError: true };
			const proposal = deps.proposalStore.create({
				title,
				description,
				category: category as import("../proposals/store.js").ProposalCategory,
				priority: priority as import("../proposals/store.js").ProposalPriority | undefined,
				effort: effort as import("../proposals/store.js").ProposalEffort | undefined,
				files_affected,
				proposed_by: scout_source ? "scout" : "claude-code",
				scout_source,
			});
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, proposal }) }] };
		},
	);

	// 18. search_obsidian
	server.registerTool(
		"search_obsidian",
		{
			description: "Search Obsidian vault notes by keyword",
			inputSchema: {
				query: z.string().describe("Search query (matched against title and content)"),
				limit: z.number().optional().describe("Max results (default: 10)"),
				category: z.string().optional().describe("Filter by top-level folder/category"),
			},
		},
		async ({ query, limit, category }) => {
			if (!deps.vaultPath) return { content: [{ type: "text" as const, text: "Vault path not configured" }], isError: true };
			try {
				const results = await searchObsidianHybrid(query, {
					vaultPath: deps.vaultPath,
					knowledge: deps.knowledge,
					embedder: deps.embedder,
				}, { limit, category });
				return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
			} catch {
				return { content: [{ type: "text" as const, text: "Vault unavailable (external drive may be disconnected)" }], isError: true };
			}
		},
	);

	// 19. write_obsidian_note
	server.registerTool(
		"write_obsidian_note",
		{
			description: "Write a note to the Obsidian vault. Creates proper frontmatter, wiki links, and metadata automatically. IMPORTANT: Use prose-as-title — name notes as claims, not categories. Good: 'SQLite outperforms Postgres for single-node workloads'. Bad: 'Database Comparison'. The title should tell a reader whether the note is relevant before they read the content.",
			inputSchema: {
				title: z.string().describe("Note title as a claim or finding (e.g. 'retry storms cause cascading failures' not 'Retry Patterns')"),
				content: z.string().describe("Note content (markdown)"),
				category: z.string().describe("Vault subdirectory (e.g. 'Learnings', 'Architecture', 'Decisions')"),
				tags: z.array(z.string()).optional().describe("Tags for the note"),
				related_notes: z.array(z.string()).optional().describe("Related note titles (become [[wiki links]])"),
				agent: z.string().optional().describe("Source agent name"),
			},
		},
		async ({ title, content, category, tags, related_notes, agent }) => {
			if (!deps.vaultPath) return { content: [{ type: "text" as const, text: "Vault path not configured" }], isError: true };
			try {
				const noteContent = buildObsidianNote({
					title,
					content,
					category,
					tags,
					relatedNotes: related_notes,
					sourceAgent: agent,
				});
				const relPath = writeVaultNote(deps.vaultPath, category, title, noteContent);
				logger.info(`[mcp] Wrote Obsidian note: ${relPath}`);

				// Immediate ingest for instant searchability
				if (deps.knowledge && deps.embedder) {
					const { join } = await import("node:path");
					const fullPath = join(deps.vaultPath, relPath);
					try {
						const ingestResult = await ingestFile(fullPath, deps.vaultPath, deps.knowledge, deps.embedder);
						if (ingestResult.chunksUpdated > 0) {
							logger.info(`[mcp] Immediate ingest: ${relPath} (${ingestResult.chunksUpdated} chunks)`);
						}
					} catch (err) {
						logger.warn(`[mcp] Immediate ingest failed for ${relPath}: ${err}`);
						// Non-fatal — watcher will pick it up
					}
				}

				return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, path: relPath }) }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Failed to write note: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 20. git_status
	server.registerTool(
		"git_status",
		{
			description: "Get git status for a configured project",
			inputSchema: {
				project: z.string().optional().describe("Project name (default: first project)"),
			},
		},
		async ({ project }) => {
			if (!deps.projects?.length) return { content: [{ type: "text" as const, text: "No projects configured" }], isError: true };
			const proj = project ? deps.projects.find((p) => p.name.toLowerCase() === project.toLowerCase()) : deps.projects[0];
			if (!proj) return { content: [{ type: "text" as const, text: `Project '${project}' not found` }], isError: true };
			const result = Bun.spawnSync(["git", "status", "--porcelain", "--branch"], { cwd: proj.repo_path });
			if (result.exitCode !== 0) {
				return { content: [{ type: "text" as const, text: `git status failed: ${result.stderr.toString()}` }], isError: true };
			}
			return { content: [{ type: "text" as const, text: JSON.stringify({ project: proj.name, path: proj.repo_path, status: result.stdout.toString().trim() }) }] };
		},
	);

	// 20. git_log
	server.registerTool(
		"git_log",
		{
			description: "Get recent git commits for a configured project",
			inputSchema: {
				project: z.string().optional().describe("Project name (default: first project)"),
				limit: z.number().optional().describe("Number of commits (default: 20, max: 50)"),
			},
		},
		async ({ project, limit }) => {
			if (!deps.projects?.length) return { content: [{ type: "text" as const, text: "No projects configured" }], isError: true };
			const proj = project ? deps.projects.find((p) => p.name.toLowerCase() === project.toLowerCase()) : deps.projects[0];
			if (!proj) return { content: [{ type: "text" as const, text: `Project '${project}' not found` }], isError: true };
			const n = Math.min(limit ?? 20, 50);
			const result = Bun.spawnSync(["git", "log", "--oneline", `-${n}`, "--format=%H|%s|%an|%ar"], { cwd: proj.repo_path });
			if (result.exitCode !== 0) {
				return { content: [{ type: "text" as const, text: `git log failed: ${result.stderr.toString()}` }], isError: true };
			}
			const commits = result.stdout.toString().trim().split("\n").filter(Boolean).map((line) => {
				const [hash, subject, author, relative] = line.split("|");
				return { hash, subject, author, relative };
			});
			return { content: [{ type: "text" as const, text: JSON.stringify({ project: proj.name, commits }) }] };
		},
	);

	// 21. list_projects
	server.registerTool(
		"list_projects",
		{
			description: "List all configured projects",
		},
		async () => {
			if (!deps.projects?.length) return { content: [{ type: "text" as const, text: "No projects configured" }] };
			return { content: [{ type: "text" as const, text: JSON.stringify(deps.projects) }] };
		},
	);

	// 22. claim_work
	server.registerTool(
		"claim_work",
		{
			description: "Atomically claim a work item (proposal, task, etc.) to prevent duplicate work",
			inputSchema: {
				key: z.string().describe("Work item key (e.g. proposal ID, task key)"),
				agent: z.string().describe("Agent claiming the work"),
			},
		},
		async ({ key, agent }) => {
			if (!deps.coordination) return { content: [{ type: "text" as const, text: "Coordination store not available" }], isError: true };
			const ok = deps.coordination.claim(key, agent);
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok, key, agent }) }] };
		},
	);

	// 23. release_work
	server.registerTool(
		"release_work",
		{
			description: "Release a previously claimed work item",
			inputSchema: {
				key: z.string().describe("Work item key"),
				agent: z.string().describe("Agent releasing the claim"),
			},
		},
		async ({ key, agent }) => {
			if (!deps.coordination) return { content: [{ type: "text" as const, text: "Coordination store not available" }], isError: true };
			const ok = deps.coordination.release(key, agent);
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok, key }) }] };
		},
	);

	// 24. post_progress
	server.registerTool(
		"post_progress",
		{
			description: "Post progress update on a claimed work item",
			inputSchema: {
				key: z.string().describe("Work item key"),
				agent: z.string().describe("Agent posting progress"),
				percent: z.number().min(0).max(100).describe("Progress percentage (0-100)"),
				message: z.string().describe("Progress message"),
			},
		},
		async ({ key, agent, percent, message }) => {
			if (!deps.coordination) return { content: [{ type: "text" as const, text: "Coordination store not available" }], isError: true };
			const ok = deps.coordination.postProgress(key, agent, percent, message);
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok, key, percent }) }] };
		},
	);

	// 25. request_input
	server.registerTool(
		"request_input",
		{
			description: "Post a question for the lead agent or user to answer",
			inputSchema: {
				agent: z.string().describe("Agent asking the question"),
				question: z.string().describe("The question"),
				context: z.string().optional().describe("Additional context for the question"),
			},
		},
		async ({ agent, question, context }) => {
			if (!deps.coordination) return { content: [{ type: "text" as const, text: "Coordination store not available" }], isError: true };
			const id = deps.coordination.askQuestion(agent, question, context);
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, question_id: id }) }] };
		},
	);

	// 26. get_agent_status
	server.registerTool(
		"get_agent_status",
		{
			description: "Get active work claims and in-flight delegations for an agent (or all agents)",
			inputSchema: {
				agent: z.string().optional().describe("Agent name (omit for all agents)"),
			},
		},
		async ({ agent }) => {
			const claims = deps.coordination?.getActiveClaims() ?? [];
			const filteredClaims = agent ? claims.filter((c) => c.agent === agent) : claims;

			const delegations: Array<{ agent: string; task: string; dispatchedAt: number; fromAgent: string }> = [];
			if (deps.activeDelegations) {
				for (const [, v] of deps.activeDelegations) {
					if (!agent || v.agent === agent) {
						delegations.push({ agent: v.agent, task: v.task, dispatchedAt: v.dispatchedAt, fromAgent: v.fromAgent });
					}
				}
			}

			return { content: [{ type: "text" as const, text: JSON.stringify({ claims: filteredClaims, delegations }) }] };
		},
	);

	// 27. brave_web_search
	server.registerTool(
		"brave_web_search",
		{
			description: "Search the web using Brave Search API. Can find Twitter/X content that regular search can't access.",
			inputSchema: {
				query: z.string().describe("Search query"),
				count: z.number().min(1).max(20).optional().describe("Number of results (1-20, default: 10)"),
				freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Freshness filter: pd=past day, pw=past week, pm=past month, py=past year"),
			},
		},
		async ({ query, count, freshness }) => {
			const apiKey = process.env.BRAVE_SEARCH_API_KEY;
			if (!apiKey) {
				return { content: [{ type: "text" as const, text: "BRAVE_SEARCH_API_KEY not configured" }], isError: true };
			}
			try {
				const results = await braveWebSearch(query, apiKey, { count, freshness });
				return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Brave Search failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 28. brave_news_search
	server.registerTool(
		"brave_news_search",
		{
			description: "Search news articles using Brave Search API",
			inputSchema: {
				query: z.string().describe("Search query"),
				count: z.number().min(1).max(20).optional().describe("Number of results (1-20, default: 10)"),
				freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Freshness filter: pd=past day, pw=past week, pm=past month, py=past year"),
			},
		},
		async ({ query, count, freshness }) => {
			const apiKey = process.env.BRAVE_SEARCH_API_KEY;
			if (!apiKey) {
				return { content: [{ type: "text" as const, text: "BRAVE_SEARCH_API_KEY not configured" }], isError: true };
			}
			try {
				const results = await braveNewsSearch(query, apiKey, { count, freshness });
				return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Brave News Search failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 29. brave_image_search
	server.registerTool(
		"brave_image_search",
		{
			description: "Search images using Brave Search API",
			inputSchema: {
				query: z.string().describe("Search query"),
				count: z.number().min(1).max(20).optional().describe("Number of results (1-20, default: 10)"),
			},
		},
		async ({ query, count }) => {
			const apiKey = process.env.BRAVE_SEARCH_API_KEY;
			if (!apiKey) {
				return { content: [{ type: "text" as const, text: "BRAVE_SEARCH_API_KEY not configured" }], isError: true };
			}
			try {
				const results = await braveImageSearch(query, apiKey, { count });
				return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Brave Image Search failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 30. brave_video_search
	server.registerTool(
		"brave_video_search",
		{
			description: "Search videos using Brave Search API",
			inputSchema: {
				query: z.string().describe("Search query"),
				count: z.number().min(1).max(20).optional().describe("Number of results (1-20, default: 10)"),
				freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Freshness filter: pd=past day, pw=past week, pm=past month, py=past year"),
			},
		},
		async ({ query, count, freshness }) => {
			const apiKey = process.env.BRAVE_SEARCH_API_KEY;
			if (!apiKey) {
				return { content: [{ type: "text" as const, text: "BRAVE_SEARCH_API_KEY not configured" }], isError: true };
			}
			try {
				const results = await braveVideoSearch(query, apiKey, { count, freshness });
				return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Brave Video Search failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 31. brave_local_search
	server.registerTool(
		"brave_local_search",
		{
			description: "Search local businesses and places using Brave Search API",
			inputSchema: {
				query: z.string().describe("Search query (e.g. 'pizza near me', 'coffee shops in Lisbon')"),
				count: z.number().min(1).max(20).optional().describe("Number of results (1-20, default: 5)"),
			},
		},
		async ({ query, count }) => {
			const apiKey = process.env.BRAVE_SEARCH_API_KEY;
			if (!apiKey) {
				return { content: [{ type: "text" as const, text: "BRAVE_SEARCH_API_KEY not configured" }], isError: true };
			}
			try {
				const results = await braveLocalSearch(query, apiKey, { count });
				return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Brave Local Search failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 32. analyze_image — vision analysis via Anthropic
	server.registerTool(
		"analyze_image",
		{
			description:
				"Analyze an image using a vision model. Accepts a URL or base64-encoded image. " +
				"Use for: reading screenshots, analyzing charts, reviewing designs, extracting text from images.",
			inputSchema: {
				url: z.string().optional().describe("Public URL of the image to analyze"),
				base64: z.string().optional().describe("Base64-encoded image data (without data: prefix)"),
				media_type: z
					.enum(["image/jpeg", "image/png", "image/gif", "image/webp"])
					.optional()
					.default("image/png")
					.describe("MIME type of the base64 image"),
				prompt: z.string().optional().default("Describe this image in detail.").describe("What to analyze or extract from the image"),
			},
		},
		async ({ url, base64, media_type, prompt }) => {
			if (!url && !base64) {
				return { content: [{ type: "text" as const, text: "Provide either url or base64" }], isError: true };
			}
			const apiKey = process.env.ANTHROPIC_API_KEY;
			if (!apiKey) {
				return { content: [{ type: "text" as const, text: "ANTHROPIC_API_KEY not configured" }], isError: true };
			}

			const imageContent: Array<Record<string, unknown>> = [];
			if (url) {
				// Fetch image and convert to base64 — Anthropic requires base64 for images
				try {
					const resp = await fetch(url);
					if (!resp.ok) return { content: [{ type: "text" as const, text: `Failed to fetch image: ${resp.status}` }], isError: true };
					const buf = await resp.arrayBuffer();
					const b64 = Buffer.from(buf).toString("base64");
					const ct = (resp.headers.get("content-type") ?? "image/png").split(";")[0].trim();
					imageContent.push({
						type: "image",
						source: { type: "base64", media_type: ct, data: b64 },
					});
				} catch (err) {
					return { content: [{ type: "text" as const, text: `Failed to fetch image: ${err instanceof Error ? err.message : err}` }], isError: true };
				}
			} else {
				imageContent.push({
					type: "image",
					source: { type: "base64", media_type: media_type ?? "image/png", data: base64! },
				});
			}

			try {
				const resp = await fetch("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
					},
					body: JSON.stringify({
						model: "claude-haiku-4-5-20251001",
						max_tokens: 2048,
						messages: [
							{
								role: "user",
								content: [...imageContent, { type: "text", text: prompt }],
							},
						],
					}),
				});
				if (!resp.ok) {
					const body = await resp.text();
					return { content: [{ type: "text" as const, text: `Anthropic API error ${resp.status}: ${body.slice(0, 500)}` }], isError: true };
				}
				const data = (await resp.json()) as { content: Array<{ type: string; text: string }> };
				const text = data.content?.map((c) => c.text).join("\n") ?? "No response";
				return { content: [{ type: "text" as const, text }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Vision analysis failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 33. open_browser
	server.registerTool(
		"open_browser",
		{
			description: "Open Chrome with the persistent Nyx profile. Optionally navigate to a URL. If Chrome is already running, opens a new tab.",
			inputSchema: {
				url: z.string().optional().describe("URL to open (optional)"),
			},
		},
		async ({ url }) => {
			const result = openBrowser(url);
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
		},
	);

	// 33. close_browser
	server.registerTool(
		"close_browser",
		{
			description: "Close the managed Chrome instance",
			inputSchema: {},
		},
		async () => {
			const result = closeBrowser();
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
		},
	);

	// 34. browser_status
	server.registerTool(
		"browser_status",
		{
			description: "Get the current browser status (running, PID, profile directory)",
			inputSchema: {},
		},
		async () => {
			const result = browserStatus();
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
		},
	);

	// 35. get_routing_stats
	server.registerTool(
		"get_routing_stats",
		{
			description: "Get delegation routing statistics — which agents perform best at which task types, based on historical outcomes",
			inputSchema: {
				days: z.number().optional().describe("Lookback window in days (default: 30)"),
			},
		},
		async ({ days }) => {
			if (!deps.routing) return { content: [{ type: "text" as const, text: "Routing store not available" }], isError: true };
			const d = days ?? 30;
			const matrix = deps.routing.getSkillMatrix(d);
			const suggestions = deps.routing.getSuggestions(d);
			const stale = deps.routing.getStale(60);
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						skill_matrix: matrix,
						suggestions: suggestions,
						stale_decisions: stale.length,
						period_days: d,
					}),
				}],
			};
		},
	);

	// 36. btw_agent — ask a side question to a running agent
	server.registerTool(
		"btw_agent",
		{
			description: "Ask a side question to a running agent without interrupting its current task. Returns the answer from a lightweight model using the agent's current context.",
			inputSchema: {
				target_agent: z.string().describe("Agent key to query"),
				question: z.string().describe("The side question to ask"),
				conversation_id: z.string().optional().describe("Conversation ID to target when the agent has multiple active tasks"),
				thread_id: z.string().optional().describe("Thread ID to target when the agent has multiple active tasks"),
			},
		},
		async ({ target_agent, question, conversation_id, thread_id }) => {
			const target = deps.processor.resolveActiveTaskTarget(target_agent, {
				conversationId: conversation_id,
				threadId: thread_id,
			});
			if ("error" in target) {
				return {
					content: [{
						type: "text" as const,
						text: deps.processor.formatActiveTaskResolutionError(target_agent, target, {
							action: "btw",
							conversationId: conversation_id,
							threadId: thread_id,
						}),
					}],
					isError: true,
				};
			}
			try {
				const result = await deps.processor.handleBtw(target_agent, target.message_id, question, "agent");
				if (!result) {
					return { content: [{ type: "text" as const, text: `No BTW context available for agent '${target_agent}'` }], isError: true };
				}
				return { content: [{ type: "text" as const, text: result.answer }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `btw_agent failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	// 37. steer_agent — inject context into a running agent's task
	server.registerTool(
		"steer_agent",
		{
			description: "Inject context or instructions into a running agent's current task. The message will be delivered at the next checkpoint (interrupt) or next turn (normal).",
			inputSchema: {
				target_agent: z.string().describe("Agent key to steer"),
				message: z.string().describe("Context or instruction to inject"),
				priority: z.enum(["normal", "interrupt"]).optional().describe("Delivery priority (default: normal)"),
				conversation_id: z.string().optional().describe("Conversation ID to target when the agent has multiple active tasks"),
				thread_id: z.string().optional().describe("Thread ID to target when the agent has multiple active tasks"),
			},
		},
		async ({ target_agent, message, priority, conversation_id, thread_id }) => {
			const target = deps.processor.resolveActiveTaskTarget(target_agent, {
				conversationId: conversation_id,
				threadId: thread_id,
			});
			if ("error" in target) {
				return {
					content: [{
						type: "text" as const,
						text: deps.processor.formatActiveTaskResolutionError(target_agent, target, {
							action: "steer",
							conversationId: conversation_id,
							threadId: thread_id,
						}),
					}],
					isError: true,
				};
			}
			try {
				const result = await deps.processor.handleSteer(target_agent, target.message_id, target.conversation_id, {
					message,
					priority: priority ?? "normal",
					source: "agent",
				});
				return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
			} catch (err) {
				return { content: [{ type: "text" as const, text: `steer_agent failed: ${err instanceof Error ? err.message : err}` }], isError: true };
			}
		},
	);

	server.registerTool(
		"knowledge_health",
		{
			description: "Get knowledge store health metrics: chunk counts, category distribution, tier breakdown, staleness, top accessed chunks",
			inputSchema: {
				_unused: z.string().optional().describe("No parameters needed"),
			},
		},
		async () => {
			if (!deps.knowledge) {
				return { content: [{ type: "text" as const, text: "Knowledge store not available" }], isError: true };
			}
			const stats = deps.knowledge.getStats();
			return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
		},
	);

	// --- Slack tools (available when bot token is configured) ---
	if (deps.slackBotToken) {
		const slackToken = deps.slackBotToken;
		const slackApi = async (method: string, body: Record<string, unknown>) => {
			const res = await fetch(`https://slack.com/api/${method}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${slackToken}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify(body),
			});
			return res.json() as Promise<Record<string, unknown>>;
		};

		server.registerTool(
			"slack_post_message",
			{
				description: "Post a message to a Slack channel or thread.",
				inputSchema: {
					channel: z.string().describe("Slack channel ID (e.g., C0AL5KK4VQD)"),
					text: z.string().describe("Message text (supports Slack mrkdwn)"),
					thread_ts: z.string().optional().describe("Thread timestamp to reply to (omit for new message)"),
				},
			},
			async ({ channel, text, thread_ts }) => {
				const body: Record<string, unknown> = {
					channel,
					text: normalizeSlackMessageText(text),
				};
				if (thread_ts) body.thread_ts = thread_ts;
				const result = await slackApi("chat.postMessage", body);
				if (!result.ok) {
					return { content: [{ type: "text" as const, text: `Slack error: ${result.error}` }], isError: true };
				}
				return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ts: result.ts, channel: result.channel }) }] };
			},
		);

		server.registerTool(
			"slack_read_messages",
			{
				description: "Read recent messages from a Slack channel or thread.",
				inputSchema: {
					channel: z.string().describe("Slack channel ID"),
					thread_ts: z.string().optional().describe("Thread timestamp to read replies from"),
					limit: z.number().optional().describe("Number of messages to fetch (default 20, max 100)"),
					cursor: z.string().optional().describe("Pagination cursor from Slack response_metadata.next_cursor"),
					oldest: z.string().optional().describe("Unix timestamp; only return messages after this time"),
					latest: z.string().optional().describe("Unix timestamp; only return messages before this time"),
				},
			},
			async ({ channel, thread_ts, limit, cursor, oldest, latest }) => {
				const { method, body } = buildSlackReadMessagesRequest({ channel, thread_ts, limit, cursor, oldest, latest });
				const result = await slackApi(method, body);
				if (!result.ok) {
					return { content: [{ type: "text" as const, text: `Slack error: ${result.error}` }], isError: true };
				}
				return { content: [{ type: "text" as const, text: JSON.stringify(formatSlackReadMessagesResult(result)) }] };
			},
		);

		server.registerTool(
			"slack_list_channels",
			{
				description: "List Slack channels the bot is a member of.",
				inputSchema: {
					limit: z.number().optional().describe("Number of channels (default 100, max 200)"),
				},
			},
			async ({ limit }) => {
				const count = Math.min(limit ?? 100, 200);
				const result = await slackApi("conversations.list", { types: "public_channel,private_channel", limit: count, exclude_archived: true });
				if (!result.ok) {
					return { content: [{ type: "text" as const, text: `Slack error: ${result.error}` }], isError: true };
				}
				const channels = (result.channels as Array<{ id?: string; name?: string; is_member?: boolean }>) ?? [];
				const memberChannels = channels.filter(c => c.is_member).map(c => ({ id: c.id, name: c.name }));
				return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, count: memberChannels.length, channels: memberChannels }) }] };
			},
		);

		logger.info("[mcp] Slack tools registered (post, read, list)");
	}

	// --- Conversation Memory tool ---
	server.registerTool(
		"search_conversation_memory",
		{
			description: "Search across all conversation history, extracted memories, and knowledge for relevant context. Use this to recall past conversations, decisions, preferences, or any previously discussed topic.",
			inputSchema: {
				query: z.string().describe("Search query — what you want to recall"),
				max_results: z.number().optional().describe("Max results (default: 10)"),
				include_messages: z.boolean().optional().describe("Include raw message history (default: true)"),
			},
		},
		async ({ query, max_results, include_messages }) => {
			const { searchConversationMemory } = await import("../memory/conversation-memory.js");
			const result = await searchConversationMemory(
				{ memory: deps.memory, graph: deps.graph, knowledge: deps.knowledge, embedder: deps.embedder },
				query,
				{ maxResults: max_results ?? 10, includeMessages: include_messages },
			);
			if (result.results.length === 0) {
				return { content: [{ type: "text" as const, text: "No relevant memories found." }] };
			}
			return { content: [{ type: "text" as const, text: result.contextBlock ?? JSON.stringify(result.results) }] };
		},
	);

	// --- Trading tools ---
	if (deps.tradingDb) {
		registerTradingTools(server, deps.tradingDb);
		logger.info("[mcp] Trading tools registered");
	}

	return server;
}

export function mcpRoutes(deps: McpDeps): Hono {
	const app = new Hono();

	app.all("/*", async (c) => {
		const server = createMcpServer(deps);
		const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		await server.connect(transport);
		try {
			return await transport.handleRequest(c.req.raw);
		} catch (err) {
			logger.error(`[mcp] Error handling request: ${err}`);
			return c.json({ error: "MCP request failed" }, 500);
		}
	});

	return app;
}
