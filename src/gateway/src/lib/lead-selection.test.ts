import { describe, expect, test } from "bun:test";
import { shouldSyncGatewayLeadAgent } from "./lead-selection";

describe("shouldSyncGatewayLeadAgent", () => {
	test("adopts vortex when nyx is the stale default lead", () => {
		expect(
			shouldSyncGatewayLeadAgent({
				authenticated: true,
				leadAgent: "vortex",
				activeAgent: "nyx",
				threadId: null,
			}),
		).toBe(true);
	});

	test("adopts nyx when a legacy lead alias is still selected", () => {
		expect(
			shouldSyncGatewayLeadAgent({
				authenticated: true,
				leadAgent: "nyx",
				activeAgent: "onyx",
				threadId: null,
			}),
		).toBe(true);
	});

	test("does not override an explicit worker selection", () => {
		expect(
			shouldSyncGatewayLeadAgent({
				authenticated: true,
				leadAgent: "nyx",
				activeAgent: "analyst",
				threadId: null,
			}),
		).toBe(false);
	});

	test("does not change the agent mid-thread", () => {
		expect(
			shouldSyncGatewayLeadAgent({
				authenticated: true,
				leadAgent: "nyx",
				activeAgent: "vortex",
				threadId: "thread-1",
			}),
		).toBe(false);
	});
});
