import { describe, expect, test } from "bun:test";
import { getCockpitRequestPollTargets } from "./cockpit-request-poll";
import type { FleetInstance } from "../stores/fleet-config";
import type { InstanceAuthState } from "../stores/fleet-auth";

function makeInstance(id: string): FleetInstance {
	return {
		id,
		label: id,
		wsUrl: `ws://${id}.example/ws`,
		preferredAgent: "nyx",
		enabled: true,
		port: 3777,
		color: "#fff",
	};
}

function makeAuth(authenticated: boolean): InstanceAuthState {
	return {
		connected: authenticated,
		authenticated,
		reconnecting: false,
		error: null,
		instanceName: null,
		leadAgent: null,
	};
}

describe("getCockpitRequestPollTargets", () => {
	test("polls nyxai only when the singleton auth is authenticated", () => {
		const targets = getCockpitRequestPollTargets(
			[makeInstance("nyxai"), makeInstance("nyxlabs")],
			{ nyxlabs: makeAuth(false) },
			true,
		);

		expect(targets).toEqual(["nyxai"]);
	});

	test("polls only authenticated remote instances", () => {
		const targets = getCockpitRequestPollTargets(
			[makeInstance("nyxai"), makeInstance("nyxlabs"), makeInstance("morph")],
			{
				nyxlabs: makeAuth(true),
				morph: makeAuth(false),
			},
			false,
		);

		expect(targets).toEqual(["nyxlabs"]);
	});

	test("preserves instance order across mixed local and remote targets", () => {
		const targets = getCockpitRequestPollTargets(
			[makeInstance("nyxai"), makeInstance("nyxlabs"), makeInstance("morph")],
			{
				nyxlabs: makeAuth(true),
				morph: makeAuth(true),
			},
			true,
		);

		expect(targets).toEqual(["nyxai", "nyxlabs", "morph"]);
	});
});
