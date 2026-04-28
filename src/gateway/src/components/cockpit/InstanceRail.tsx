/**
 * InstanceRail — left nav rail for the cockpit.
 * Shows all fleet instances with per-instance connection status dots.
 * Clicking an instance selects it as the active focus.
 */

import { cn } from "../../lib/utils";
import type { FleetInstance } from "../../stores/fleet-config";
import type { InstanceAuthState } from "../../stores/fleet-auth";
import type { FleetRuntimeState } from "../../stores/fleet-chat";
import { getInstancePresenceState } from "./instance-presence";

interface InstanceRailProps {
	instances: FleetInstance[];
	selectedId: string;
	authStates: Record<string, InstanceAuthState>;
	runtimeStates?: Record<string, FleetRuntimeState | undefined>;
	requestCounts?: Record<string, number>;
	onSelect: (id: string) => void;
}

function statusDot(auth: InstanceAuthState, runtime?: FleetRuntimeState): { color: string; glow: string; title: string } {
	const presence = getInstancePresenceState(auth, runtime);
	if (presence.tone === "active") {
		return {
			color: "bg-emerald-400 animate-pulse",
			glow: "shadow-[0_0_8px_rgba(74,222,128,0.45)]",
			title: presence.title,
		};
	}
	if (presence.tone === "connected") {
		return {
			color: "bg-[var(--nyx-accent)]",
			glow: "shadow-[0_0_6px_rgb(var(--nyx-accent-rgb)/0.5)]",
			title: presence.title,
		};
	}
	if (presence.tone === "warn") {
		return {
			color: "bg-[var(--nyx-warn)] animate-pulse",
			glow: "",
			title: presence.title,
		};
	}
	if (presence.tone === "error") {
		return {
			color: "bg-[var(--nyx-danger)]",
			glow: "",
			title: presence.title,
		};
	}
	return {
		color: "bg-zinc-700",
		glow: "",
		title: presence.title,
	};
}

export function InstanceRail({ instances, selectedId, authStates, runtimeStates, requestCounts, onSelect }: InstanceRailProps) {
	return (
		<div className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-[var(--nyx-line)] bg-[var(--nyx-panel-2)] p-2">
			<p className="px-2 pb-1.5 pt-1 text-[9px] font-medium uppercase tracking-[0.16em] text-[var(--nyx-muted)]">
				Fleet
			</p>
			{instances.map((inst) => {
				const auth = authStates[inst.id] ?? {
					connected: false,
					authenticated: false,
					reconnecting: false,
					error: null,
					instanceName: null,
					leadAgent: null,
				};
				const dot = statusDot(auth, runtimeStates?.[inst.id]);
				const isSelected = inst.id === selectedId;
				const requestCount = requestCounts?.[inst.id] ?? 0;

				return (
					<button
						key={inst.id}
						type="button"
						onClick={() => onSelect(inst.id)}
						className={cn(
							"flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nyx-accent)]",
							isSelected
								? "bg-[var(--nyx-accent-dim)] text-[var(--nyx-accent)] border border-[rgb(var(--nyx-accent-rgb)/0.15)]"
								: "text-[var(--nyx-text-secondary)] hover:bg-[var(--nyx-panel-hover)] hover:text-[var(--nyx-text)] border border-transparent",
							!inst.enabled && "opacity-55",
						)}
						title={!inst.enabled ? `${inst.label} — configure WebSocket URL to enable` : dot.title}
					>
						{/* Instance color marker */}
						<div
							className="h-3 w-0.5 shrink-0 rounded-full"
							style={{ backgroundColor: inst.color }}
						/>
						<span className="min-w-0 flex-1 truncate font-medium">{inst.label}</span>
						{requestCount > 0 ? (
							<span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[rgb(var(--nyx-accent-rgb)/0.14)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--nyx-accent)]">
								{requestCount}
							</span>
						) : null}
						{inst.enabled ? (
							<div
								className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot.color, dot.glow)}
								title={dot.title}
							/>
						) : (
							<div className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" title="Disabled" />
						)}
					</button>
				);
			})}
		</div>
	);
}
