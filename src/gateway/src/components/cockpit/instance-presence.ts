import type { InstanceAuthState } from "../../stores/fleet-auth";
import type { FleetRuntimeState } from "../../stores/fleet-chat";

export interface InstancePresenceState {
	label: string;
	title: string;
	tone: "connected" | "active" | "warn" | "error" | "muted";
}

const RUNTIME_STALE_MS = 90_000;

export function getInstancePresenceState(
	auth: InstanceAuthState,
	runtime?: FleetRuntimeState | null,
	now = Date.now(),
): InstancePresenceState {
	if (auth.error) {
		return {
			label: "Error",
			title: auth.error,
			tone: "error",
		};
	}
	if (auth.reconnecting) {
		return {
			label: "Reconnecting",
			title: "Reconnecting",
			tone: "warn",
		};
	}
	if (auth.connected && !auth.authenticated) {
		return {
			label: "Authenticating",
			title: "Authenticating",
			tone: "warn",
		};
	}
	if (!auth.authenticated) {
		return {
			label: "Disconnected",
			title: "Disconnected",
			tone: "muted",
		};
	}

	if (runtime?.presence === "active") {
		return {
			label: "Working",
			title: runtime.activeThreadId
				? `Working in ${runtime.activeThreadId}`
				: "Working",
			tone: "active",
		};
	}

	if (runtime?.lastEventAt && now - runtime.lastEventAt > RUNTIME_STALE_MS) {
		return {
			label: "Quiet",
			title: "Connected but no recent runtime activity",
			tone: "warn",
		};
	}

	return {
		label: "Connected",
		title: "Connected",
		tone: "connected",
	};
}
