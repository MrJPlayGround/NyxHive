import { Activity } from "lucide-react";
import { Link } from "react-router-dom";
import type { ActivityEvent } from "../../stores/activity-feed";

const dotColors: Record<ActivityEvent["type"], string> = {
  completion: "bg-emerald-400",
  proposal: "bg-[var(--nyx-accent-2)]",
  delegation: "bg-[var(--nyx-accent)]",
  watchdog: "bg-[var(--nyx-danger)]",
  system: "bg-[var(--nyx-accent)]",
  error: "bg-[var(--nyx-danger)]",
};

const agentColors: Record<string, string> = {
  nyx: "text-[var(--nyx-accent)]",
  scout: "text-[var(--nyx-warn)]",
  analyst: "text-[var(--nyx-accent-2)]",
  tester: "text-emerald-400",
  researcher: "text-cyan-400",
  system: "text-[var(--nyx-accent)]",
};

interface ActivityFeedProps {
  events: ActivityEvent[];
}

export function ActivityFeed({ events }: ActivityFeedProps) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--nyx-line)] bg-[rgba(255,255,255,0.01)] p-4 border-gradient-top">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-5 w-5 text-[var(--nyx-accent)] section-icon-glow" />
        <span className="text-base font-semibold">Activity</span>
        <span className="ml-auto text-xs text-[var(--nyx-muted)]">Live</span>
        <div className="live-indicator h-1.5 w-1.5 rounded-full bg-[var(--nyx-accent)] shadow-[0_0_6px_var(--nyx-accent)]" />
      </div>

      {events.length === 0 ? (
        <p className="flex-1 flex items-center justify-center text-xs text-[var(--nyx-muted)]">No recent activity</p>
      ) : (
        <div className="flex-1 overflow-y-auto text-sm">
          {events.slice(0, 8).map((e) => (
            <div key={e.id} className="flex items-start gap-2.5 border-b border-[var(--nyx-line)] py-2 last:border-0">
              <div className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${dotColors[e.type]}`} />
              <div className="min-w-0 flex-1">
                <div>
                  <span className={`font-medium ${agentColors[e.agent] ?? "text-[var(--nyx-text-secondary)]"}`}>{e.agent}</span>
                  {" "}
                  <span className="text-[var(--nyx-muted)]">{e.action}</span>
                  {" "}
                  <span className="text-[var(--nyx-text-secondary)]">{e.subject}</span>
                </div>
                {e.detail && <div className="mt-0.5 text-xs text-[var(--nyx-muted)]">{e.detail}</div>}
              </div>
              <span className="shrink-0 text-xs text-[var(--nyx-muted)]">{formatRelativeShort(e.timestamp)}</span>
            </div>
          ))}
        </div>
      )}

      <Link to="/activity" className="mt-3 block text-center text-xs text-[var(--nyx-muted)] hover:text-[var(--nyx-text-secondary)]">
        View all
      </Link>
    </div>
  );
}

function formatRelativeShort(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
