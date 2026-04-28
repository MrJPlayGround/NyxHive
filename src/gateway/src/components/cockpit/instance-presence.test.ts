import { describe, expect, test } from "bun:test";
import { getInstancePresenceState } from "./instance-presence";
import type { InstanceAuthState } from "../../stores/fleet-auth";
import type { FleetRuntimeState } from "../../stores/fleet-chat";

function makeAuth(overrides: Partial<InstanceAuthState> = {}): InstanceAuthState {
	return {
		connected: true,
		authenticated: true,
		reconnecting: false,
		error: null,
		instanceName: null,
		leadAgent: null,
		...overrides,
	};
}

function makeRuntime(overrides: Partial<FleetRuntimeState> = {}): FleetRuntimeState {
	return {
		presence: "idle",
		activeRunId: null,
		activeThreadId: null,
		lastEventAt: null,
		lastStartedAt: null,
		lastCompletedAt: null,
		...overrides,
	};
}

describe("getInstancePresenceState", () => {
	test("shows working when an authenticated instance has an active runtime", () => {
		const presence = getInstancePresenceState(
			makeAuth(),
			makeRuntime({ presence: "active", activeThreadId: "thread-7" }),
			1_000,
		);

		expect(presence.label).toBe("Working");
		expect(presence.tone).toBe("active");
		expect(presence.title).toContain("thread-7");
	});

	test("shows quiet when runtime activity is stale", () => {
		const presence = getInstancePresenceState(
			makeAuth(),
			makeRuntime({ lastEventAt: 1_000 }),
			100_000,
		);

		expect(presence.label).toBe("Quiet");
		expect(presence.tone).toBe("warn");
	});

	test("falls back to disconnected/auth errors before runtime state", () => {
		expect(getInstancePresenceState(makeAuth({ authenticated: false, connected: false }), makeRuntime()).label).toBe("Disconnected");
		expect(getInstancePresenceState(makeAuth({ error: "boom" }), makeRuntime()).label).toBe("Error");
	});
});
