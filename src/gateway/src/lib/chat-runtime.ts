import type { Frame } from "../../protocol/frame";

export interface ThreadChange {
	id: string;
	threadId: string;
	messageId?: string;
	filePath: string;
	operation: "write" | "edit" | "create" | "delete";
	linesAdded: number;
	linesRemoved: number;
	diffSummary?: string;
	timestamp: number;
}

export interface RuntimeItem {
	id: string;
	type: "command" | "file_change" | "mcp_tool" | "web_search" | "status" | "agent_message";
	status: "started" | "updated" | "completed" | "failed";
	title: string;
	subtitle?: string;
	details?: string;
	command?: string;
	outputPreview?: string;
	exitCode?: number | null;
	changes?: Array<{ path: string; kind: "add" | "delete" | "update" }>;
	timestamp: number;
}

export interface RuntimeRequestAction {
	id: string;
	label: string;
	variant?: "primary" | "secondary" | "danger";
}

export interface RuntimeProposalRequest {
	proposalId: string;
	title: string;
	description?: string;
	category?: string;
	priority?: string;
	effort?: string;
	filesAffected?: string[];
}

export interface RuntimeRequest {
	requestId: string;
	kind: "proposal_approval" | "user_input";
	title: string;
	description?: string;
	threadId?: string;
	createdAt: number;
	actions: RuntimeRequestAction[];
	proposal?: RuntimeProposalRequest;
}

export interface TerminalSnippet {
	id: string;
	itemId: string;
	label: string;
	content: string;
	lineStart: number;
	lineEnd: number;
	createdAt: number;
}

export type AssistantOutputDirective =
	| { type: "text"; text: string }
	| { type: "replyTo"; messageId: string; text?: string }
	| { type: "attachments"; items: Array<{ name: string; url?: string; mimeType?: string; size?: number }> }
	| { type: "embed"; title?: string; body?: string; url?: string }
	| { type: "voiceHint"; text: string; voice?: string }
	| { type: "ephemeral"; text: string }
	| { type: "actionCard"; title: string; body?: string; actions?: RuntimeRequestAction[] };

export interface AssistantOutput {
	directives: AssistantOutputDirective[];
}

export type ChatRuntimeEvent =
	| { type: "thread.started"; threadId: string; agent: string; startedAt: number; created?: boolean }
	| { type: "turn.started"; threadId: string; turn: number; runId?: string; agent: string; startedAt: number }
	| { type: "turn.completed"; threadId: string; turn?: number; runId?: string; agent?: string; status: "completed" | "failed" | "aborted"; finishedAt: number; text?: string; output?: AssistantOutput; tokensIn?: number; tokensOut?: number; cost?: number; durationMs?: number }
	| { type: "response.delta"; threadId?: string; agent?: string; delta: string; textSoFar?: string }
	| { type: "activity.updated"; threadId?: string; activity?: string; tokensIn?: number; tokensOut?: number }
	| { type: "heartbeat"; threadId?: string; runId?: string }
	| { type: "item.started" | "item.updated" | "item.completed"; threadId: string; turn?: number; item: RuntimeItem }
	| { type: "context.updated"; threadId?: string; utilizationPct?: number; estimated?: boolean }
	| { type: "diff.updated"; threadId: string; changes: ThreadChange[] }
	| { type: "request.opened"; request: RuntimeRequest }
	| { type: "request.resolved"; requestId: string; resolution: string; resolvedAt: number }
	| { type: "chat.active"; threadId: string; agent?: string; startedAt?: number; runId?: string };

function objectPayload(frame: Frame): Record<string, any> {
	return (frame.payload ?? {}) as Record<string, any>;
}

function isObject(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseAssistantOutputDirective(value: unknown): AssistantOutputDirective | null {
	if (!isObject(value) || typeof value.type !== "string") return null;
	switch (value.type) {
		case "text": {
			const text = asString(value.text);
			return text === undefined ? null : { type: "text", text };
		}
		case "replyTo": {
			const messageId = asString(value.messageId);
			if (!messageId) return null;
			return { type: "replyTo", messageId, text: asString(value.text) };
		}
		case "attachments": {
			if (!Array.isArray(value.items)) return null;
			const items = value.items.flatMap((item) => {
				if (!isObject(item) || typeof item.name !== "string") return [];
				return [{
					name: item.name,
					url: asString(item.url),
					mimeType: asString(item.mimeType),
					size: typeof item.size === "number" ? item.size : undefined,
				}];
			});
			return { type: "attachments", items };
		}
		case "embed":
			return {
				type: "embed",
				title: asString(value.title),
				body: asString(value.body),
				url: asString(value.url),
			};
		case "voiceHint": {
			const text = asString(value.text);
			return text === undefined ? null : { type: "voiceHint", text, voice: asString(value.voice) };
		}
		case "ephemeral": {
			const text = asString(value.text);
			return text === undefined ? null : { type: "ephemeral", text };
		}
		case "actionCard": {
			const title = asString(value.title);
			if (!title) return null;
			const actions = Array.isArray(value.actions)
				? value.actions.flatMap((action) => {
					if (!isObject(action) || typeof action.id !== "string" || typeof action.label !== "string") return [];
					const variant = action.variant === "primary" || action.variant === "secondary" || action.variant === "danger"
						? action.variant
						: undefined;
					return [{ id: action.id, label: action.label, variant }];
				})
				: undefined;
			return { type: "actionCard", title, body: asString(value.body), actions };
		}
		default:
			return null;
	}
}

function parseAssistantOutput(value: unknown, fallbackText?: string): AssistantOutput | undefined {
	const directives = isObject(value) && Array.isArray(value.directives)
		? value.directives.flatMap((directive) => parseAssistantOutputDirective(directive) ?? [])
		: [parseAssistantOutputDirective(value)].flatMap((directive) => directive ?? []);
	if (directives.length > 0) return { directives };
	return fallbackText === undefined ? undefined : { directives: [{ type: "text", text: fallbackText }] };
}

export function resolveRuntimeEvents(frame: Frame): ChatRuntimeEvent[] {
	const payload = objectPayload(frame);
	switch (frame.method) {
		case "thread.started":
			return [{
				type: "thread.started",
				threadId: String(payload.threadId),
				agent: String(payload.agent),
				startedAt: Number(payload.startedAt ?? Date.now()),
				created: payload.created === true,
			}];
		case "turn.started":
			return [{
				type: "turn.started",
				threadId: String(payload.threadId),
				turn: Number(payload.turn ?? 1),
				runId: typeof payload.runId === "string" ? payload.runId : undefined,
				agent: String(payload.agent),
				startedAt: Number(payload.startedAt ?? Date.now()),
			}];
		case "turn.completed":
			return [{
				type: "turn.completed",
				threadId: String(payload.threadId),
				turn: typeof payload.turn === "number" ? payload.turn : undefined,
				runId: typeof payload.runId === "string" ? payload.runId : undefined,
				agent: typeof payload.agent === "string" ? payload.agent : undefined,
				status: payload.status === "aborted" ? "aborted" : payload.status === "failed" ? "failed" : "completed",
				finishedAt: Number(payload.finishedAt ?? Date.now()),
				text: typeof payload.text === "string" ? payload.text : undefined,
				tokensIn: typeof payload.tokensIn === "number" ? payload.tokensIn : undefined,
				tokensOut: typeof payload.tokensOut === "number" ? payload.tokensOut : undefined,
				cost: typeof payload.cost === "number" ? payload.cost : undefined,
				durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
				output: parseAssistantOutput(payload.output, typeof payload.text === "string" ? payload.text : undefined),
			}];
		case "response:delta":
			return [{
				type: "response.delta",
				threadId: typeof payload.sender_id === "string" ? payload.sender_id : undefined,
				agent: typeof payload.agent === "string" ? payload.agent : undefined,
				delta: String(payload.text_delta ?? ""),
				textSoFar: typeof payload.text_so_far === "string" ? payload.text_so_far : undefined,
			}];
		case "agent:progress": {
			const data = (payload.data ?? payload) as Record<string, any>;
			return [{
				type: "activity.updated",
				threadId: typeof payload.sender_id === "string" ? payload.sender_id : undefined,
				activity: typeof data.activity === "string" ? data.activity : undefined,
				tokensIn: typeof data.tokensIn === "number" ? data.tokensIn : undefined,
				tokensOut: typeof data.tokensOut === "number" ? data.tokensOut : undefined,
			}];
		}
		case "chat:heartbeat":
		case "run.heartbeat":
			return [{
				type: "heartbeat",
				threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
				runId: typeof payload.runId === "string" ? payload.runId : undefined,
			}];
		case "chat:active":
			return [{
				type: "chat.active",
				threadId: String(payload.threadId),
				agent: typeof payload.agent === "string" ? payload.agent : undefined,
				startedAt: typeof payload.startedAt === "number" ? payload.startedAt : undefined,
				runId: typeof payload.runId === "string" ? payload.runId : undefined,
			}];
		case "chat:execution":
		case "item.started":
		case "item.updated":
		case "item.completed": {
			if (frame.method === "chat:execution") {
				return [{
					type: payload.phase === "started" ? "item.started" : payload.phase === "updated" ? "item.updated" : "item.completed",
					threadId: String(payload.threadId ?? payload.sender_id ?? ""),
					turn: typeof payload.turn === "number" ? payload.turn : undefined,
					item: {
						id: String(payload.id),
						type: payload.kind,
						status: payload.phase === "failed" ? "failed" : payload.phase,
						title: String(payload.title),
						subtitle: typeof payload.subtitle === "string" ? payload.subtitle : undefined,
						details: typeof payload.details === "string" ? payload.details : undefined,
						command: typeof payload.command === "string" ? payload.command : undefined,
						outputPreview: typeof payload.outputPreview === "string" ? payload.outputPreview : undefined,
						exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
						changes: Array.isArray(payload.changes) ? payload.changes : undefined,
						timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
					},
				}];
			}
			return [{
				type: frame.method,
				threadId: String(payload.threadId),
				turn: typeof payload.turn === "number" ? payload.turn : undefined,
				item: payload.item as RuntimeItem,
			}];
		}
		case "context:metrics":
		case "context.updated": {
			const data = (payload.data ?? payload) as Record<string, any>;
			return [{
				type: "context.updated",
				threadId: typeof data.threadId === "string" ? data.threadId : undefined,
				utilizationPct: typeof data.utilizationPct === "number" ? data.utilizationPct : undefined,
				estimated: data.estimated === true,
			}];
		}
		case "diff.updated":
			return [{
				type: "diff.updated",
				threadId: String(payload.threadId),
				changes: Array.isArray(payload.changes) ? payload.changes as ThreadChange[] : [],
			}];
		case "request.opened":
			return [{ type: "request.opened", request: payload as RuntimeRequest }];
		case "request.resolved":
			return [{
				type: "request.resolved",
				requestId: String(payload.requestId),
				resolution: String(payload.resolution),
				resolvedAt: Number(payload.resolvedAt ?? Date.now()),
			}];
		case "chat:response":
			return [{
				type: "turn.completed",
				threadId: String(payload.threadId ?? ""),
				status: "completed",
				finishedAt: Date.now(),
				text: typeof payload.text === "string" ? payload.text : undefined,
				tokensIn: typeof payload.tokensIn === "number" ? payload.tokensIn : undefined,
				tokensOut: typeof payload.tokensOut === "number" ? payload.tokensOut : undefined,
				cost: typeof payload.cost === "number" ? payload.cost : undefined,
				durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
				output: parseAssistantOutput(payload.output, typeof payload.text === "string" ? payload.text : undefined),
			}];
		case "response:complete":
			return [{
				type: "turn.completed",
				threadId: String(payload.sender_id ?? ""),
				status: "completed",
				finishedAt: Date.now(),
				text: typeof payload.text_so_far === "string" ? payload.text_so_far : undefined,
				tokensIn: typeof payload.tokens_in === "number" ? payload.tokens_in : undefined,
				tokensOut: typeof payload.tokens_out === "number" ? payload.tokens_out : undefined,
				cost: typeof payload.cost === "number" ? payload.cost : undefined,
				durationMs: typeof payload.duration_ms === "number" ? payload.duration_ms : undefined,
				output: parseAssistantOutput(payload.output, typeof payload.text_so_far === "string" ? payload.text_so_far : undefined),
			}];
		default:
			return [];
	}
}

export function buildTerminalContextBlock(snippets: TerminalSnippet[]): string {
	if (snippets.length === 0) return "";
	const parts = snippets.map((snippet) => {
		const range = snippet.lineStart === snippet.lineEnd
			? `line ${snippet.lineStart}`
			: `lines ${snippet.lineStart}-${snippet.lineEnd}`;
		return `### ${snippet.label} (${range})\n\`\`\`text\n${snippet.content}\n\`\`\``;
	});
	return `[Terminal Context]\n${parts.join("\n\n")}\n[/Terminal Context]`;
}

export function countSnippetLines(content: string): number {
	return content.split("\n").length;
}
