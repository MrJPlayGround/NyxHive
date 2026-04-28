import type { FleetInstance } from "../stores/fleet-config";
import type { InstanceAuthState } from "../stores/fleet-auth";

export function getCockpitRequestPollTargets(
	instances: FleetInstance[],
	auth: Record<string, InstanceAuthState | undefined>,
	nyxaiAuthenticated: boolean,
): string[] {
	return instances
		.filter((instance) => {
			if (instance.id === "nyxai") {
				return nyxaiAuthenticated;
			}
			return auth[instance.id]?.authenticated ?? false;
		})
		.map((instance) => instance.id);
}

