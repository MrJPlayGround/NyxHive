import { describe, expect, test } from "bun:test";
import { getWorkspaceLoadPlan } from "./workspace-load-plan";

describe("getWorkspaceLoadPlan", () => {
	test("disables all workspace loads until auth and chat state exist", () => {
		expect(getWorkspaceLoadPlan({
			authenticated: false,
			hasFleetChat: false,
			threadId: null,
			messageCount: 0,
		})).toEqual({
			loadRequests: false,
			fetchThreads: false,
			loadModelInfo: false,
			loadHistory: false,
		});
	});

	test("loads history only when an active thread has no messages yet", () => {
		expect(getWorkspaceLoadPlan({
			authenticated: true,
			hasFleetChat: true,
			threadId: "thread-a",
			messageCount: 0,
		})).toEqual({
			loadRequests: true,
			fetchThreads: true,
			loadModelInfo: true,
			loadHistory: true,
		});
	});

	test("does not reload history when the active thread already has messages", () => {
		expect(getWorkspaceLoadPlan({
			authenticated: true,
			hasFleetChat: true,
			threadId: "thread-a",
			messageCount: 3,
		})).toEqual({
			loadRequests: true,
			fetchThreads: true,
			loadModelInfo: true,
			loadHistory: false,
		});
	});

	test("loads history when refresh restored only transient assistant placeholders", () => {
		expect(getWorkspaceLoadPlan({
			authenticated: true,
			hasFleetChat: true,
			threadId: "thread-a",
			messageCount: 3,
			hasOnlyTransientAssistantMessages: true,
		})).toEqual({
			loadRequests: true,
			fetchThreads: true,
			loadModelInfo: true,
			loadHistory: true,
		});
	});
});
