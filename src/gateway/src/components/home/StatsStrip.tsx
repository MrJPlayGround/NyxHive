import { formatBytes, formatCost } from "../../lib/format";
import type { Health } from "../../lib/types";

interface StatsStripProps {
  health: Health | null;
  totalCost: number;
  proposalCount: number;
  completedCount: number;
}

const cells = [
  { key: "queue",     label: "Queue",       color: "text-[var(--nyx-accent)]",  bg: "bg-[var(--nyx-accent-dim)]",     glow: "hover:shadow-[inset_0_-1px_12px_var(--nyx-accent-glow)]" },
  { key: "completed", label: "Completed",   color: "text-emerald-400",          bg: "bg-emerald-500/8",               glow: "hover:shadow-[inset_0_-1px_12px_rgba(52,211,153,0.08)]" },
  { key: "proposals", label: "Proposals",   color: "text-[var(--nyx-accent-2)]", bg: "bg-[var(--nyx-accent-2-dim)]",  glow: "hover:shadow-[inset_0_-1px_12px_rgb(var(--nyx-accent-2-rgb)/0.08)]" },
  { key: "cost",      label: "Spent Today", color: "text-[var(--nyx-danger)]",  bg: "bg-[var(--nyx-danger-dim)]",     glow: "hover:shadow-[inset_0_-1px_12px_rgb(var(--nyx-danger-rgb)/0.08)]" },
  { key: "memory",    label: "Memory",      color: "text-[var(--nyx-warn)]",    bg: "bg-[var(--nyx-warn-dim)]",       glow: "hover:shadow-[inset_0_-1px_12px_rgb(var(--nyx-warn-rgb)/0.08)]" },
] as const;

export function StatsStrip({ health, totalCost, proposalCount, completedCount }: StatsStripProps) {
  const values: Record<string, string> = {
    queue: String(health?.queueDepth ?? 0),
    completed: String(completedCount),
    proposals: String(proposalCount),
    cost: formatCost(totalCost),
    memory: health ? formatBytes(health.memoryUsage) : "—",
  };

  return (
    <div className="flex overflow-hidden rounded-xl border border-[var(--nyx-line)] border-gradient-top">
      {cells.map(({ key, label, color, bg, glow }) => (
        <div key={key} className={`stat-cell flex-1 px-4 py-3 text-center ${bg} ${glow} transition-shadow duration-200`}>
          <div className="text-[11px] uppercase tracking-wider text-[var(--nyx-muted)] font-medium">{label}</div>
          <div className={`text-xl font-semibold ${color}`}>{values[key]}</div>
        </div>
      ))}
    </div>
  );
}
