import { describe, expect, test } from "bun:test";
import { mergeFleetConfigState, mergeInstances, type FleetInstance } from "./fleet-config";

function inst(overrides: Partial<FleetInstance> & Pick<FleetInstance, "id">): FleetInstance {
	return {
		id: overrides.id,
		label: overrides.label ?? overrides.id,
		wsUrl: overrides.wsUrl ?? "",
		preferredAgent: overrides.preferredAgent ?? null,
		enabled: overrides.enabled ?? true,
		port: overrides.port ?? 3777,
		color: overrides.color ?? "#fff",
	};
}

describe("mergeInstances", () => {
	test("keeps nyxai enabled even if persisted config disabled it", () => {
		const merged = mergeInstances([inst({ id: "nyxai", enabled: false })]);
		expect(merged.find((instance) => instance.id === "nyxai")?.enabled).toBe(true);
	});

	test("keeps nyxlabs enabled even if persisted config disabled it", () => {
		const merged = mergeInstances([inst({ id: "nyxlabs", enabled: false })]);
		expect(merged.find((instance) => instance.id === "nyxlabs")?.enabled).toBe(true);
	});

	test("drops retired persisted instances that are no longer defaults", () => {
		const merged = mergeInstances([inst({ id: "aether", enabled: false, port: 4780 })]);
		expect(merged.find((instance) => instance.id === "aether")).toBeUndefined();
		expect(merged.map((instance) => instance.id)).toEqual(["nyxai", "nyxlabs"]);
	});
});

describe("mergeFleetConfigState", () => {
	test("resets retired selected instance ids to the current default", () => {
		const merged = mergeFleetConfigState(
			{
				instances: [inst({ id: "aether", enabled: false, port: 4780 })],
				selectedInstanceId: "aether",
			},
			{
				instances: [],
				selectedInstanceId: "nyxai",
				selectInstance: () => undefined,
				updateInstance: () => undefined,
			},
		);

		expect(merged.selectedInstanceId).toBe("nyxai");
		expect(merged.instances.map((instance) => instance.id)).toEqual(["nyxai", "nyxlabs"]);
	});
});
