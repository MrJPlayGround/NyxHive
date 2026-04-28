import type { ChatAttachment } from "../stores/chat";

export interface SlashCommand {
	name: string;
	description: string;
	hasArgs?: boolean;
	streamingOnly?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "/status", description: "Show whether the current thread is active" },
	{ name: "/new", description: "Start a new thread" },
	{ name: "/reset", description: "Clear conversation context" },
	{ name: "/clear", description: "Clear chat display" },
	{ name: "/btw", description: "Side question (won't interrupt agent)", hasArgs: true, streamingOnly: true },
	{ name: "/steer", description: "Inject message at next turn", hasArgs: true, streamingOnly: true },
	{ name: "/stop", description: "Stop the current generation", streamingOnly: true },
	{ name: "/model", description: "Switch model (or reset to default)", hasArgs: true },
	{ name: "/agent", description: "Switch active agent", hasArgs: true },
	{ name: "/thread", description: "Start a new thread" },
	{ name: "/usage", description: "Show queue stats and usage" },
	{ name: "/cancel", description: "Cancel the currently running task" },
	{ name: "/crawl", description: "Crawl a site into knowledge", hasArgs: true },
	{ name: "/context", description: "Show conversation context info" },
	{ name: "/forget", description: "Remove last N exchanges (default 1)", hasArgs: true },
	{ name: "/trim", description: "Keep only last N messages (default 5)", hasArgs: true },
	{ name: "/setup", description: "Channel setup menu / status", hasArgs: true },
	{ name: "/help", description: "Show available commands" },
];

export interface ChatCommandGateway {
	request<T>(method: string, payload: Record<string, unknown>): Promise<T>;
}

export interface ChatCommandState {
	threadId: string | null;
	activeAgent: string;
	streaming: boolean;
}

export interface ChatCommandDeps {
	content: string;
	attachments?: ChatAttachment[];
	state: ChatCommandState;
	contextPct: number | null;
	gateway: ChatCommandGateway;
	sendMessage: (content: string, attachments?: ChatAttachment[]) => void;
	clearMessages: () => void;
	abortStream: () => void;
	setModelOverride: (model: string | null) => void;
	setActiveAgent: (agent: string) => void;
	newThread: () => void;
	setEphemeralBtw: (value: string) => void;
	appendUserMessage: (content: string) => void;
}

export function handleLocalSlashCommand({
	content,
	attachments,
	state,
	contextPct,
	gateway,
	sendMessage,
	clearMessages,
	abortStream,
	setModelOverride,
	setActiveAgent,
	newThread,
	setEphemeralBtw,
	appendUserMessage,
}: ChatCommandDeps): boolean {
	const trimmed = content.trim();
	const lower = trimmed.toLowerCase();
	if (!lower.startsWith("/")) return false;

	const spaceIdx = lower.indexOf(" ");
	const cmd = spaceIdx === -1 ? lower : lower.slice(0, spaceIdx);
	const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
	const commandDef = SLASH_COMMANDS.find((command) => command.name === cmd);
	if (args && commandDef && !commandDef.hasArgs) return false;

	switch (cmd) {
		case "/status":
			gateway.request<{ active: boolean }>("chat.status", { threadId: state.threadId }).then((res) => {
				setEphemeralBtw(res.active ? "Status: active" : "Status: idle");
			}).catch((err) => {
				setEphemeralBtw(`Failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			return true;
		case "/new":
		case "/thread":
			newThread();
			return true;
		case "/reset":
			gateway.request("chat.reset", { threadId: state.threadId }).catch((err) =>
				console.error("[chat.reset] failed:", err),
			);
			clearMessages();
			return true;
		case "/clear":
			clearMessages();
			return true;
		case "/btw":
			if (!args) return true;
			gateway.request<{ answer: string }>("chat.btw", {
				agent: state.activeAgent,
				question: args,
				threadId: state.threadId,
			}).then((res) => {
				setEphemeralBtw(res.answer);
			}).catch((err) => {
				console.error("[chat.btw] failed:", err);
				setEphemeralBtw(`Failed: ${err instanceof Error ? err.message : "Unknown error"}`);
			});
			return true;
		case "/steer":
			if (!args) return true;
			gateway.request<{ status?: string }>("chat.steer", {
				agent: state.activeAgent,
				message: args,
				threadId: state.threadId,
			}).then((res) => {
				if (res?.status === "queued") {
					setEphemeralBtw("Steer queued — agent will see it on next message.");
				}
			}).catch((err) => {
				console.error("[chat.steer] failed:", err);
				setEphemeralBtw(`Steer failed: ${err instanceof Error ? err.message : "Unknown error"}`);
			});
			appendUserMessage(`[steer] ${args}`);
			return true;
		case "/stop":
		case "/cancel":
			abortStream();
			return true;
		case "/model":
			setModelOverride(!args || args === "reset" || args === "default" ? null : args);
			return true;
		case "/agent":
			if (args) setActiveAgent(args);
			return true;
		case "/usage":
			gateway.request<{ queue: Record<string, number>; agents: Array<{ name: string; status: string; invocations: number; costCents: number }> }>("chat.usage", {}).then((res) => {
				const q = res.queue;
				const lines = [`Queue: ${q.pending ?? 0} pending, ${q.processing ?? 0} processing, ${q.completed ?? 0} completed, ${q.failed ?? 0} failed`];
				for (const agent of res.agents) {
					lines.push(`${agent.name}: ${agent.status} (${agent.invocations} invocations, $${(agent.costCents / 100).toFixed(2)})`);
				}
				setEphemeralBtw(lines.join("\n"));
			}).catch((err) => {
				setEphemeralBtw(`Failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			return true;
		case "/context":
			gateway.request<{ messageCount: number; hasSummary: boolean }>("chat.context", { threadId: state.threadId }).then((res) => {
				setEphemeralBtw(`Messages: ${res.messageCount} | Summary: ${res.hasSummary ? "yes" : "no"} | Context bar: ${contextPct ?? 0}%`);
			}).catch((err) => {
				setEphemeralBtw(`Failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			return true;
		case "/forget": {
			const exchanges = Number.parseInt(args, 10) || 1;
			gateway.request<{ removed: number }>("chat.forget", { threadId: state.threadId, exchanges }).then((res) => {
				setEphemeralBtw(res.removed > 0 ? `Removed ${res.removed} messages (${exchanges} exchange${exchanges !== 1 ? "s" : ""}).` : "Nothing to forget.");
			}).catch((err) => {
				setEphemeralBtw(`Failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			return true;
		}
		case "/trim": {
			const keep = Number.parseInt(args, 10) || 5;
			gateway.request<{ removed: number }>("chat.trim", { threadId: state.threadId, keep }).then((res) => {
				setEphemeralBtw(res.removed > 0 ? `Trimmed ${res.removed} messages, keeping last ${keep}.` : "Nothing to trim.");
			}).catch((err) => {
				setEphemeralBtw(`Failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			return true;
		}
		case "/crawl":
			if (!args) return true;
			sendMessage(`/crawl ${args}`, attachments);
			return true;
		case "/setup":
			if (args.startsWith("discord ")) {
				sendMessage(`/setup discord ${args.slice(8).trim()}`, attachments);
			} else {
				gateway.request<{ channels: string[]; instanceName: string }>("chat.setup.status", {}).then((res) => {
					const lines = [`Instance: ${res.instanceName}`, `Active channels: ${res.channels.length > 0 ? res.channels.join(", ") : "none"}`];
					setEphemeralBtw(lines.join("\n"));
				}).catch((err) => {
					setEphemeralBtw(`Failed: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
			return true;
		case "/help":
			setEphemeralBtw(SLASH_COMMANDS.map((command) => `${command.name} — ${command.description}${command.streamingOnly ? " (while streaming)" : ""}`).join("\n"));
			return true;
		default:
			return false;
	}
}
