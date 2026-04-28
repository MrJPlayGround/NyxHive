import { describe, expect, it } from "bun:test";
import { buildSlackReadMessagesRequest, formatSlackReadMessagesResult, normalizeSlackMessageText } from "../mcp/server.js";

describe("normalizeSlackMessageText", () => {
	it("converts literal escaped newlines into real Slack line breaks", () => {
		const input = "*Scout review*\\n• Report: `change-report.json`\\n• Draft MRs: none";
		expect(normalizeSlackMessageText(input)).toBe("*Scout review*\n• Report: `change-report.json`\n• Draft MRs: none");
	});

	it("parses JSON-stringified Slack text payloads", () => {
		const input = "\"*Scout review*\\n• Total detected changes: `0`\"";
		expect(normalizeSlackMessageText(input)).toBe("*Scout review*\n• Total detected changes: `0`");
	});

	it("leaves already formatted multiline text unchanged", () => {
		const input = "*Scout review*\n• Draft MRs: none";
		expect(normalizeSlackMessageText(input)).toBe(input);
	});
});

describe("buildSlackReadMessagesRequest", () => {
	it("passes cursor and time bounds through to conversations.history", () => {
		expect(
			buildSlackReadMessagesRequest({
				channel: "C123",
				limit: 50,
				cursor: "next-page",
				oldest: "1710000000.000100",
				latest: "1710000100.000200",
			}),
		).toEqual({
			method: "conversations.history",
			body: {
				channel: "C123",
				limit: 50,
				cursor: "next-page",
				oldest: "1710000000.000100",
				latest: "1710000100.000200",
			},
		});
	});

	it("passes the same params through to thread replies when thread_ts is provided", () => {
		expect(
			buildSlackReadMessagesRequest({
				channel: "C123",
				thread_ts: "1710000200.000300",
				cursor: "reply-page",
				oldest: "1710000000.000100",
			}),
		).toEqual({
			method: "conversations.replies",
			body: {
				channel: "C123",
				limit: 20,
				ts: "1710000200.000300",
				cursor: "reply-page",
				oldest: "1710000000.000100",
			},
		});
	});
});

describe("formatSlackReadMessagesResult", () => {
	it("returns next_cursor alongside formatted messages", () => {
		expect(
			formatSlackReadMessagesResult({
				ok: true,
				messages: [
					{ user: "U123", text: "hello", ts: "1710000300.000400" },
					{ text: "system", ts: "1710000400.000500" },
				],
				response_metadata: { next_cursor: "next-page" },
			}),
		).toEqual({
			ok: true,
			count: 2,
			next_cursor: "next-page",
			messages: [
				{ user: "U123", text: "hello", ts: "1710000300.000400" },
				{ user: "unknown", text: "system", ts: "1710000400.000500" },
			],
		});
	});
});
