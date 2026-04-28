import { AlertCircle, AlertTriangle } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../lib/format";
import { categoryTextColors } from "../../lib/colors";
import type { Proposal } from "../../stores/proposals";

interface NeedsAttentionPanelProps {
  proposals: Proposal[];
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  watchdogAlerts?: Array<{ agentName: string; stuckMinutes: number }>;
}

export function NeedsAttentionPanel({ proposals, onApprove, onReject, watchdogAlerts }: NeedsAttentionPanelProps) {
  const totalCount = proposals.length + (watchdogAlerts?.length ?? 0);
  if (totalCount === 0) return null;

  return (
    <div className="flex h-full flex-col rounded-xl border border-[rgba(244,112,104,0.15)] bg-gradient-to-b from-[rgba(244,112,104,0.03)] to-transparent p-4">
      <div className="mb-3 flex items-center gap-2">
        <AlertCircle className="h-5 w-5 text-[var(--nyx-danger)] section-icon-glow" />
        <span className="text-base font-semibold">Needs Attention</span>
        <span className="rounded-full bg-[var(--nyx-danger-dim)] px-2 py-0.5 text-xs font-semibold text-[var(--nyx-danger)] shadow-[0_0_8px_rgba(244,112,104,0.1)]">
          {totalCount}
        </span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {watchdogAlerts?.map((alert) => (
          <WatchdogAlertItem key={alert.agentName} {...alert} />
        ))}
        {proposals.slice(0, 5).map((p) => (
          <div key={p.id} className="rounded-lg border border-[var(--nyx-line)] bg-[rgba(255,255,255,0.02)] px-3 py-2.5">
            <div className="mb-1.5 text-sm font-medium">{p.title}</div>
            <div className="flex items-center gap-2">
              <span className={cn("text-xs", categoryTextColors[p.category])}>{p.category}</span>
              <span className="text-xs text-[var(--nyx-muted)]">{p.effort}</span>
              <span className="text-xs text-[var(--nyx-muted)]">{formatRelativeTime(p.createdAt)}</span>
              <div className="ml-auto flex gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-3 text-xs text-[var(--nyx-accent)] hover:bg-[var(--nyx-accent-dim)]"
                  onClick={() => onApprove(p.id)}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-3 text-xs text-[var(--nyx-danger)] hover:bg-[var(--nyx-danger-dim)]"
                  onClick={() => onReject(p.id)}
                >
                  Skip
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WatchdogAlertItem({ agentName, stuckMinutes }: { agentName: string; stuckMinutes: number }) {
  return (
    <div className="rounded-lg border border-[rgba(244,112,104,0.12)] bg-[rgba(244,112,104,0.03)] px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5 text-[var(--nyx-danger)]" />
        <span className="text-[13px] font-medium text-[#f8a0a0]">{agentName} stuck for {stuckMinutes}m</span>
      </div>
      <div className="text-[11px] text-[var(--nyx-muted)] mt-0.5">Auto-retry queued</div>
    </div>
  );
}
