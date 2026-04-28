import { describe, expect, test } from "bun:test";
import { resolveFleetConnectionTarget } from "./useFleetConnections";
import { resolveFleetWsUrl } from "../lib/fleet-gateway";
import type { FleetInstance } from "../stores/fleet-config";
import type { InstanceConfig } from "../stores/fleet-auth";

function makeInstance(overrides: Partial<FleetInstance> = {}): FleetInstance {
	return {
		id: overrides.id ?? "nyxlabs",
		label: overrides.label ?? "NyxLabs",
		wsUrl: overrides.wsUrl ?? "ws://fleet.example/ws",
		preferredAgent: overrides.preferredAgent ?? "vortex",
		enabled: overrides.enabled ?? true,
		port: overrides.port ?? 3778,
		color: overrides.color ?? "#fff",
	};
}

function makeConfig(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
	return {
		wsUrlOverride: overrides.wsUrlOverride ?? null,
		deviceId: overrides.deviceId ?? null,
		deviceSecret: overrides.deviceSecret ?? null,
	};
}

describe("resolveFleetConnectionTarget", () => {
	test("defaults NyxAI websocket discovery to the backend port", () => {
		const originalWindow = globalThis.window;
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				location: {
					protocol: "http:",
					hostname: "127.0.0.1",
				},
			},
		});

		try {
			expect(resolveFleetWsUrl("nyxai", "")).toBe("ws://127.0.0.1:3779/ws");
		} finally {
			Object.defineProperty(globalThis, "window", {
				configurable: true,
				value: originalWindow,
			});
		}
	});

	test("uses per-instance credentials when global credentials are missing", () => {
		const target = resolveFleetConnectionTarget(
			makeInstance(),
			{
				deviceId: null,
				deviceName: null,
				deviceSecret: null,
			},
			makeConfig({
				wsUrlOverride: "wss://nyxlabs.example/ws",
				deviceId: "instance-device",
				deviceSecret: "instance-secret",
			}),
		);

		expect(target).toEqual({
			wsUrl: "wss://nyxlabs.example/ws",
			deviceId: "instance-device",
			deviceName: "NyxLabs",
			deviceSecret: "instance-secret",
			connectionKey: "wss://nyxlabs.example/ws|instance-device|instance-secret",
		});
	});

	test("prefers per-instance websocket override and credentials over global defaults", () => {
		const target = resolveFleetConnectionTarget(
			makeInstance(),
			{
				deviceId: "global-device",
				deviceName: "User Mac",
				deviceSecret: "global-secret",
			},
			makeConfig({
				wsUrlOverride: "wss://remote.example/ws",
				deviceId: "instance-device",
				deviceSecret: "instance-secret",
			}),
		);

		expect(target).toEqual({
			wsUrl: "wss://remote.example/ws",
			deviceId: "instance-device",
			deviceName: "User Mac",
			deviceSecret: "instance-secret",
			connectionKey: "wss://remote.example/ws|instance-device|instance-secret",
		});
	});

	test("returns null when neither global nor per-instance credentials are usable", () => {
		const target = resolveFleetConnectionTarget(
			makeInstance(),
			{
				deviceId: null,
				deviceName: "User Mac",
				deviceSecret: null,
			},
			makeConfig(),
		);

		expect(target).toBeNull();
	});
});
