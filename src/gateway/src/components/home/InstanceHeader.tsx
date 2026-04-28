import { cn } from "../../lib/utils";
import type { Health } from "../../lib/types";
import { formatUptime } from "../../lib/format";

interface InstanceHeaderProps {
  instanceName: string;
  agentCount: number;
  health: Health | null;
  runningCount: number;
}

const statusStyles = {
  ok: {
    border: "border-emerald-500/20 bg-emerald-500/8",
    dot: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]",
    text: "text-emerald-400",
    label: "Healthy",
  },
  degraded: {
    border: "border-[var(--nyx-warn-dim)] bg-[var(--nyx-warn-dim)]",
    dot: "bg-[var(--nyx-warn)] shadow-[0_0_6px_var(--nyx-warn)]",
    text: "text-[var(--nyx-warn)]",
    label: "Degraded",
  },
  error: {
    border: "border-[var(--nyx-danger-dim)] bg-[var(--nyx-danger-dim)]",
    dot: "bg-[var(--nyx-danger)] shadow-[0_0_6px_var(--nyx-danger)]",
    text: "text-[var(--nyx-danger)]",
    label: "Error",
  },
  offline: {
    border: "border-[var(--nyx-danger-dim)] bg-[var(--nyx-danger-dim)]",
    dot: "bg-[var(--nyx-danger)]",
    text: "text-[var(--nyx-danger)]",
    label: "Offline",
  },
} as const;

export function InstanceHeader({ instanceName, agentCount, health, runningCount }: InstanceHeaderProps) {
  const initial = instanceName.charAt(0).toUpperCase();
  const statusKey = health ? (health.status ?? "ok") : "offline";
  const style = statusStyles[statusKey];

  const warningCount = (health?.warnings?.length ?? 0) + (health?.errors?.length ?? 0);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3.5">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--nyx-accent)] to-[var(--nyx-accent-2)] text-xl font-bold text-[var(--nyx-bg)] shadow-[0_0_24px_var(--nyx-accent-glow),0_0_48px_rgb(var(--nyx-accent-2-rgb)/0.08)]">
          {initial}
        </div>
        <div>
          <h1 className="text-2xl font-bold text-shimmer">{instanceName}</h1>
          <p className="text-sm text-[var(--nyx-muted)]">
            {agentCount} agents{health ? ` · uptime ${formatUptime(health.uptime_seconds ?? health.uptime)}` : ""}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5", style.border)}>
          <div className={cn("h-2 w-2 rounded-full", style.dot)} />
          <span className={cn("text-sm font-medium", style.text)}>
            {style.label}
          </span>
        </div>
        {warningCount > 0 && statusKey !== "offline" && (
          <div className="rounded-lg border border-[var(--nyx-warn-dim)] bg-[var(--nyx-warn-dim)] px-3 py-1.5 text-sm font-medium text-[var(--nyx-warn)]">
            {warningCount} {warningCount === 1 ? "issue" : "issues"}
          </div>
        )}
        {runningCount > 0 && (
          <div className="rounded-lg border border-[var(--nyx-warn-dim)] bg-[var(--nyx-warn-dim)] px-3 py-1.5 text-sm font-medium text-[var(--nyx-warn)]">
            {runningCount} running
          </div>
        )}
      </div>
    </div>
  );
}
