import { AlertTriangle } from "lucide-react";
import { cn } from "../../lib/utils";
import { formatCost } from "../../lib/format";
import type { Agent } from "../../stores/agents";

const roleColors: Record<string, { bg: string; text: string; border: string; gradient: string }> = {
  lead:    { bg: "bg-[var(--nyx-accent-dim)]", text: "text-[var(--nyx-accent)]", border: "border-[rgb(var(--nyx-accent-rgb)/0.20)]", gradient: "from-[var(--nyx-accent)] to-[var(--nyx-accent-2)]" },
  worker:  { bg: "bg-[var(--nyx-accent-2-dim)]", text: "text-[var(--nyx-accent-2)]", border: "border-[rgb(var(--nyx-accent-2-rgb)/0.20)]", gradient: "from-[var(--nyx-accent-2)] to-[#6b8cdb]" },
  coder:   { bg: "bg-emerald-500/12", text: "text-emerald-400", border: "border-emerald-500/20", gradient: "from-emerald-500 to-teal-400" },
  default: { bg: "bg-zinc-500/12",   text: "text-zinc-400",   border: "border-zinc-500/20",  gradient: "from-zinc-500 to-zinc-400" },
};

const statusColors = {
  idle: "bg-[var(--nyx-accent)]",
  running: "bg-[var(--nyx-warn)] shadow-[0_0_6px_var(--nyx-warn)]",
  error: "bg-[var(--nyx-danger)] shadow-[0_0_6px_var(--nyx-danger)]",
};

interface AgentCardProps {
  agent: Agent;
  stuckMinutes?: number;
}

export function AgentCard({ agent, stuckMinutes }: AgentCardProps) {
  const colors = roleColors[agent.role] ?? roleColors.default;
  const isRunning = agent.status === "running";
  const isStuck = agent.status === "error" || (stuckMinutes != null && stuckMinutes > 0);
  const initial = agent.name.charAt(0).toUpperCase();

  return (
    <div className={cn(
      "card-hover relative overflow-hidden rounded-xl border p-4",
      isStuck
        ? "border-[rgba(244,112,104,0.20)] bg-gradient-to-br from-[rgba(244,112,104,0.06)] to-transparent"
        : isRunning
        ? cn(colors.border, "bg-gradient-to-br from-[var(--nyx-accent-dim)] to-transparent")
        : "border-[var(--nyx-line)] bg-[rgba(255,255,255,0.02)] hover:border-[var(--nyx-line-strong)]"
    )}>
      {(isRunning || isStuck) && (
        <div className={cn(
          "absolute inset-x-0 top-0 h-0.5",
          isStuck ? "bg-[rgba(244,112,104,0.50)]" : "bg-gradient-to-r from-transparent via-[var(--nyx-accent)] to-transparent"
        )} />
      )}

      <div className="mb-2.5 flex items-center gap-2.5">
        <div className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-bold",
          isStuck ? "bg-[var(--nyx-danger-dim)] text-[var(--nyx-danger)]"
          : `bg-gradient-to-br ${colors.gradient} text-white shadow-sm`
        )}>
          {initial}
        </div>
        <div className="min-w-0">
          <div className="text-base font-semibold">{agent.name}</div>
          <div className={cn("text-xs", isStuck ? "text-[var(--nyx-danger)]" : colors.text)}>{agent.role}</div>
        </div>
        <div className={cn("ml-auto h-2 w-2 shrink-0 rounded-full", statusColors[agent.status])} />
      </div>

      {isStuck && stuckMinutes != null ? (
        <div className="flex items-center gap-1.5 text-xs text-[var(--nyx-danger)]">
          <AlertTriangle className="h-3.5 w-3.5" />
          Stuck {stuckMinutes}m — auto-retry queued
        </div>
      ) : isRunning && agent.currentTask ? (
        <>
          <div className="mb-2 truncate text-xs text-[var(--nyx-text-secondary)]">{agent.currentTask}</div>
          <div className="h-1 rounded-full bg-white/5">
            <div className="h-full rounded-full bg-gradient-to-r from-[var(--nyx-accent)] to-[var(--nyx-accent-2)]" style={{ width: "50%" }} />
          </div>
        </>
      ) : (
        <div className="text-xs text-[var(--nyx-muted)]">
          Idle{agent.lastInvokedAt ? ` · ${formatRelativeShort(agent.lastInvokedAt)}` : ""}
        </div>
      )}

      <div className="mt-2.5 flex justify-between text-[11px] text-[var(--nyx-muted)]">
        <span>{agent.totalInvocations} tasks</span>
        <span>{formatCost(agent.estimatedCostCents)}</span>
      </div>
    </div>
  );
}

function formatRelativeShort(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
