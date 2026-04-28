import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./chat";
import { mergeHistoryMessages } from "./history-merge";

function msg(id: string, role: ChatMessage["role"], content: string): ChatMessage {
	return { id, role, content, timestamp: 1 };
}

describe("mergeHistoryMessages", () => {
	test("dedupes persisted user messages with different server ids", () => {
		const merged = mergeHistoryMessages(
			[
				msg("server-user", "user", "So? You done?"),
				msg("server-assistant", "assistant", "Done and pushed."),
			],
			[
				msg("local-user", "user", "So? You done?"),
				msg("local-assistant", "assistant", "Done and pushed."),
			],
			null,
		);

		expect(merged.map((message) => message.id)).toEqual([
			"server-user",
			"server-assistant",
		]);
	});

	test("preserves unsaved repeated user messages beyond server history", () => {
		const merged = mergeHistoryMessages(
			[msg("server-user", "user", "again")],
			[
				msg("local-user-1", "user", "again"),
				msg("local-user-2", "user", "again"),
			],
			null,
		);

		expect(merged.map((message) => message.id)).toEqual([
			"server-user",
			"local-user-2",
		]);
	});

	test("dedupes local display text against terminal-context server messages", () => {
		const merged = mergeHistoryMessages(
			[msg("server-user", "user", "[Terminal Context]\nlogs\n\n[User Message]\nship it")],
			[msg("local-user", "user", "ship it")],
			null,
		);

		expect(merged.map((message) => message.id)).toEqual(["server-user"]);
	});

	test("keeps the active streaming assistant message", () => {
		const merged = mergeHistoryMessages(
			[msg("server-user", "user", "status")],
			[
				msg("local-user", "user", "status"),
				{ ...msg("local-assistant", "assistant", "working"), streaming: true },
			],
			"local-assistant",
		);

		expect(merged.map((message) => message.id)).toEqual([
			"server-user",
			"local-assistant",
		]);
	});

	test("allows callers to drop empty active placeholders", () => {
		const merged = mergeHistoryMessages(
			[msg("server-user", "user", "status")],
			[
				msg("local-user", "user", "status"),
				{ ...msg("local-assistant", "assistant", ""), streaming: true },
			],
			"local-assistant",
			(message, streamingMessageId) =>
				message.role === "user" ||
				(message.id === streamingMessageId && message.content.trim().length > 0),
		);

		expect(merged.map((message) => message.id)).toEqual(["server-user"]);
	});
});
