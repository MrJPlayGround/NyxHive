import { describe, expect, mock, test } from "bun:test";
import { handleLocalSlashCommand, SLASH_COMMANDS, type ChatCommandDeps } from "./chat-commands";

function createDeps(content: string, overrides: Partial<ChatCommandDeps> = {}): ChatCommandDeps {
	return {
		content,
		attachments: undefined,
		state: {
			threadId: "thread-123",
			activeAgent: "nyx",
			streaming: false,
		},
		contextPct: 42,
		gateway: {
			request: mock(async (method: string) => {
				if (method === "chat.status") return { active: true };
				if (method === "chat.setup.status") return { channels: ["discord", "telegram"], instanceName: "NyxAI" };
				return {};
			}),
		},
		sendMessage: mock(() => {}),
		clearMessages: mock(() => {}),
		abortStream: mock(() => {}),
		setModelOverride: mock(() => {}),
		setActiveAgent: mock(() => {}),
		newThread: mock(() => {}),
		setEphemeralBtw: mock(() => {}),
		appendUserMessage: mock(() => {}),
		...overrides,
	};
}

describe("handleLocalSlashCommand", () => {
	test("returns false for non-command input", () => {
		const deps = createDeps("hello");
		expect(handleLocalSlashCommand(deps)).toBe(false);
		expect(deps.clearMessages).not.toHaveBeenCalled();
	});

	test("handles /status via gateway active check", async () => {
		const deps = createDeps("/status");
		expect(handleLocalSlashCommand(deps)).toBe(true);
		await Promise.resolve();
		expect(deps.gateway.request).toHaveBeenCalledWith("chat.status", { threadId: "thread-123" });
		expect(deps.setEphemeralBtw).toHaveBeenCalledWith("Status: active");
	});

	test("handles /new as thread creation alias", () => {
		const deps = createDeps("/new");
		expect(handleLocalSlashCommand(deps)).toBe(true);
		expect(deps.newThread).toHaveBeenCalledTimes(1);
	});

	test("lets no-arg slash commands with trailing text send as normal messages", () => {
		const deps = createDeps("/new Hi");
		expect(handleLocalSlashCommand(deps)).toBe(false);
		expect(deps.newThread).not.toHaveBeenCalled();
	});

	test("handles /reset by clearing server and local state", () => {
		const deps = createDeps("/reset");
		expect(handleLocalSlashCommand(deps)).toBe(true);
		expect(deps.gateway.request).toHaveBeenCalledWith("chat.reset", { threadId: "thread-123" });
		expect(deps.clearMessages).toHaveBeenCalledTimes(1);
	});

	test("queues visible steer message while routing steer to server", async () => {
		const deps = createDeps("/steer check null input", {
			gateway: {
				request: mock(async () => ({ status: "queued" })),
			},
		});
		expect(handleLocalSlashCommand(deps)).toBe(true);
		await Promise.resolve();
		expect(deps.appendUserMessage).toHaveBeenCalledWith("[steer] check null input");
		expect(deps.setEphemeralBtw).toHaveBeenCalledWith("Steer queued — agent will see it on next message.");
	});

	test("routes setup discord as a normal message instead of a side effect call", () => {
		const deps = createDeps("/setup discord secret-token");
		expect(handleLocalSlashCommand(deps)).toBe(true);
		expect(deps.sendMessage).toHaveBeenCalledWith("/setup discord secret-token", undefined);
		expect(deps.gateway.request).not.toHaveBeenCalledWith("chat.setup.status", expect.anything());
	});
});

describe("SLASH_COMMANDS", () => {
	test("includes the gateway P0 commands", () => {
		expect(SLASH_COMMANDS.some((command) => command.name === "/status")).toBe(true);
		expect(SLASH_COMMANDS.some((command) => command.name === "/new")).toBe(true);
		expect(SLASH_COMMANDS.some((command) => command.name === "/reset")).toBe(true);
	});
});
