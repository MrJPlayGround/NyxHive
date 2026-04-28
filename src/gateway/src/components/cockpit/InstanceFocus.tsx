import { RefreshCw, Settings, Wifi, WifiOff } from "lucide-react";
import { cn } from "../../lib/utils";
import type { FleetInstance } from "../../stores/fleet-config";
import type { InstanceAuthState } from "../../stores/fleet-auth";
import type { FleetRuntimeState } from "../../stores/fleet-chat";
import { resolveFleetWsUrl } from "../../lib/fleet-gateway";
import { fleetGateway } from "../../lib/fleet-gateway";
import { useAuthStore } from "../../stores/auth";
import { CockpitWorkspace } from "./CockpitWorkspace";
import { getInstancePresenceState } from "./instance-presence";

interface InstanceFocusProps {
	instance: FleetInstance;
	auth: InstanceAuthState;
	runtime?: FleetRuntimeState | null;
}

function StatusBadge({ auth, runtime }: { auth: InstanceAuthState; runtime?: FleetRuntimeState | null }) {
	const presence = getInstancePresenceState(auth, runtime ?? undefined);
	if (presence.tone === "active") {
		return (
			<div className="flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1">
				<div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(74,222,128,0.55)]" />
				<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-300">
					{presence.label}
				</span>
			</div>
		);
	}
	if (presence.tone === "connected") {
		return (
			<div className="flex items-center gap-1.5 rounded-full border border-[rgb(var(--nyx-accent-rgb)/0.2)] bg-[rgb(var(--nyx-accent-rgb)/0.08)] px-2.5 py-1">
				<div className="h-1.5 w-1.5 rounded-full bg-[var(--nyx-accent)] shadow-[0_0_5px_rgb(var(--nyx-accent-rgb)/0.6)]" />
				<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--nyx-accent)]">
					{presence.label}
				</span>
			</div>
		);
	}
	if (presence.tone === "warn") {
		return (
			<div className="flex items-center gap-1.5 rounded-full border border-[var(--nyx-warn)]/20 bg-[var(--nyx-warn)]/8 px-2.5 py-1">
				<div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--nyx-warn)]" />
				<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--nyx-warn)]">
					{presence.label}
				</span>
			</div>
		);
	}
	if (presence.tone === "error") {
		return (
			<div className="flex items-center gap-1.5 rounded-full border border-[var(--nyx-danger)]/20 bg-[var(--nyx-danger)]/8 px-2.5 py-1">
				<WifiOff className="h-3 w-3 text-[var(--nyx-danger)]" />
				<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--nyx-danger)]">
					{presence.label}
				</span>
			</div>
		);
	}
	return (
		<div className="flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1">
			<Wifi className="h-3 w-3 text-zinc-500" />
			<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
				Disconnected
			</span>
		</div>
	);
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
	if (!value) return null;
	return (
		<div className="flex items-center gap-2">
			<span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">{label}</span>
			<span className="text-[11px] text-zinc-300">{value}</span>
		</div>
	);
}

export function InstanceFocus({ instance, auth, runtime }: InstanceFocusProps) {
	const resolvedWsUrl = resolveFleetWsUrl(instance.id, instance.wsUrl, instance.port);
	const isNotConfigured = !instance.enabled || !resolvedWsUrl;
	const retryMainAuth = useAuthStore((s) => s.retryAuth);

	const handleRetry = () => {
		if (instance.id === "nyxai") {
			retryMainAuth();
			return;
		}
		fleetGateway.reconnect(instance.id);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			{/* Instance header */}
			<div className="flex shrink-0 items-center gap-4 border-b border-[var(--nyx-line)] px-5 py-3">
				{/* Color marker */}
				<div
					className="h-5 w-1 shrink-0 rounded-full"
					style={{ backgroundColor: instance.color }}
				/>
				<div className="min-w-0 flex-1">
					<h2 className="text-base font-bold leading-tight text-[var(--nyx-text)]">
						{auth.instanceName ?? instance.label}
					</h2>
					<div className="mt-0.5 flex items-center gap-3">
						<MetaRow label="Agent" value={auth.leadAgent ?? instance.preferredAgent} />
						<MetaRow label="Socket" value={resolvedWsUrl} />
						{auth.error ? (
							<span className="text-[10px] text-[var(--nyx-danger)]">{auth.error}</span>
						) : null}
					</div>
				</div>
				{(auth.error || (!auth.authenticated && !isNotConfigured)) ? (
					<button
						type="button"
						onClick={handleRetry}
						className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-300 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.18)] hover:text-zinc-100"
					>
						<RefreshCw className="h-3.5 w-3.5" />
						Retry
					</button>
				) : null}
				<StatusBadge auth={auth} runtime={runtime} />
			</div>

			{/* Not-configured notice */}
			{isNotConfigured && (
				<div className="flex shrink-0 items-center gap-3 border-b border-[var(--nyx-line)] bg-[rgba(232,184,74,0.04)] px-5 py-2.5">
					<Settings className="h-3.5 w-3.5 shrink-0 text-[var(--nyx-warn)]" />
					<p className="text-[11px] text-zinc-400">
						{instance.id === "nyxai" && !instance.enabled
							? "NyxAI is disabled in fleet config."
							: `Configure or override ${instance.label}'s WebSocket URL in Settings › Fleet to connect.`}
					</p>
				</div>
			)}

			<CockpitWorkspace instance={instance} auth={auth} />
		</div>
	);
}
