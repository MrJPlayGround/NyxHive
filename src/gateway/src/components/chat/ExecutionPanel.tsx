import { useState } from "react";
import {
  Bot,
  ChevronRight,
  FileCode2,
  Globe,
  Loader2,
  Search,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import type { ExecutionEvent } from "../../stores/chat";
import { describeExecutionEvent } from "./message-execution";

/* ── Helpers ─────────────────────────────────────────────────────────── */

function eventIcon(kind: ExecutionEvent["kind"]) {
  switch (kind) {
    case "command":
      return SquareTerminal;
    case "file_change":
      return FileCode2;
    case "mcp_tool":
      return Bot;
    case "web_search":
      return Search;
    case "status":
    default:
      return Sparkles;
  }
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function hasExpandableDetail(event: ExecutionEvent): boolean {
  return !!(
    event.outputPreview ||
    event.details ||
    (event.changes && event.changes.length > 0)
  );
}

/** Should this event auto-expand its detail section? */
function shouldAutoExpand(event: ExecutionEvent): boolean {
  if (event.phase === "failed") return true;
  if (event.phase === "started" || event.phase === "updated") return true;
  return false;
}

function groupEventsByTurn(events: ExecutionEvent[]) {
  const groups: Array<{
    key: string;
    label: string;
    events: ExecutionEvent[];
  }> = [];
  for (const event of events) {
    const turn = event.turn;
    const key = turn ? `turn-${turn}` : "turn-0";
    const label = turn ? `Turn ${turn}` : "Setup";
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.key === key) {
      lastGroup.events.push(event);
      continue;
    }
    groups.push({ key, label, events: [event] });
  }
  return groups
    .map((group) => ({
      ...group,
      events: [...group.events].reverse(),
    }))
    .reverse();
}

/* ── Clamped output ──────────────────────────────────────────────────── */

const OUTPUT_LINE_CLAMP = 4;

function ClampedOutput({ text }: { text: string }) {
  const lines = text.split("\n");
  const clamped = lines.length > OUTPUT_LINE_CLAMP;
  const [showAll, setShowAll] = useState(false);

  return (
    <div className="rounded border border-[var(--nyx-line)] bg-black/20 px-2.5 py-1.5 font-mono text-[10px] leading-[1.6] text-[var(--nyx-text-secondary)]">
      <pre className="whitespace-pre-wrap break-words">
        {showAll || !clamped
          ? text
          : lines.slice(0, OUTPUT_LINE_CLAMP).join("\n")}
      </pre>
      {clamped && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 text-[9px] text-[var(--nyx-muted)] hover:text-[var(--nyx-text-secondary)]"
        >
          +{lines.length - OUTPUT_LINE_CLAMP} more lines
        </button>
      )}
    </div>
  );
}

/* ── Timeline Row ────────────────────────────────────────────────────── */

function TimelineRow({
  event,
  isLast,
  compact,
  onOpenChange,
  onAttachSnippet,
}: {
  event: ExecutionEvent;
  isLast: boolean;
  compact: boolean;
  onOpenChange?: (path: string) => void;
  onAttachSnippet?: (itemId: string, label: string, content: string) => void;
}) {
  const isActive = event.phase === "started" || event.phase === "updated";
  const isFailed = event.phase === "failed";
  const expandable = hasExpandableDetail(event);
  const [expanded, setExpanded] = useState(shouldAutoExpand(event));

  const Icon = eventIcon(event.kind);
  const label = describeExecutionEvent(event);

  // Inline command snippet for compact completed commands
  const inlineCmd =
    compact && event.command && !expanded
      ? event.command.trim().slice(0, 40) +
        (event.command.trim().length > 40 ? "..." : "")
      : null;

  return (
    <div
      className={cn(
        "relative flex gap-2.5",
        isFailed && "rounded-md bg-[rgba(244,112,104,0.04)]",
      )}
    >
      {/* Timeline spine */}
      <div className="flex flex-col items-center pt-[5px]">
        <div
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            isActive
              ? "bg-[var(--nyx-accent)] shadow-[0_0_6px_var(--nyx-accent-glow)] animate-pulse"
              : isFailed
                ? "bg-[var(--nyx-danger)]"
                : "bg-[var(--nyx-muted)]/40",
          )}
        />
        {!isLast && <div className="w-px flex-1 bg-[var(--nyx-line)]" />}
      </div>

      {/* Content */}
      <div className={cn("min-w-0 flex-1", compact ? "pb-1" : "pb-2.5")}>
        {/* Header row */}
        <div
          role={expandable ? "button" : undefined}
          tabIndex={expandable ? 0 : undefined}
          onClick={() => expandable && setExpanded(!expanded)}
          onKeyDown={(e) =>
            expandable && e.key === "Enter" && setExpanded(!expanded)
          }
          className={cn(
            "flex items-center gap-1.5",
            expandable && "cursor-pointer group",
          )}
        >
          <Icon
            className={cn(
              "h-3 w-3 shrink-0",
              isActive
                ? "text-[var(--nyx-accent)]"
                : isFailed
                  ? "text-[var(--nyx-danger)]"
                  : "text-[var(--nyx-muted)]",
            )}
          />
          <span
            className={cn(
              "min-w-0 truncate text-[12px]",
              isActive
                ? "font-medium text-[var(--nyx-text)]"
                : isFailed
                  ? "font-medium text-[var(--nyx-danger)]"
                  : "text-[var(--nyx-text-secondary)]",
            )}
          >
            {label}
          </span>

          {/* Inline command snippet for compact mode */}
          {inlineCmd && (
            <span className="hidden min-w-0 truncate font-mono text-[10px] text-[var(--nyx-muted)] xl:block">
              {inlineCmd}
            </span>
          )}

          <span className="ml-auto shrink-0 font-mono text-[9px] text-[var(--nyx-muted)]">
            {formatTime(event.timestamp)}
          </span>

          {/* Non-zero exit code inline */}
          {event.exitCode != null && event.exitCode !== 0 && (
            <span className="shrink-0 font-mono text-[9px] font-medium text-[var(--nyx-danger)]">
              E{event.exitCode}
            </span>
          )}

          {expandable && (
            <ChevronRight
              className={cn(
                "h-2.5 w-2.5 shrink-0 text-[var(--nyx-muted)] transition-transform duration-100",
                expanded && "rotate-90",
                !expanded && "group-hover:text-[var(--nyx-text-secondary)]",
              )}
            />
          )}
        </div>

        {/* Expanded detail */}
        {expanded && expandable && (
          <div className="mt-1.5 space-y-1.5 pl-[18px]">
            {event.command && (
              <pre className="overflow-x-auto rounded border border-[var(--nyx-line)] bg-black/20 px-2.5 py-1 font-mono text-[10px] leading-[1.6] text-[var(--nyx-text-secondary)]">
                <code>{event.command}</code>
              </pre>
            )}
            {event.outputPreview && (
              <div className="space-y-1">
                <ClampedOutput text={event.outputPreview} />
                {onAttachSnippet ? (
                  <button
                    type="button"
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      onAttachSnippet(
                        event.id,
                        event.subtitle ?? describeExecutionEvent(event),
                        event.outputPreview ?? "",
                      );
                    }}
                    className="text-[9px] uppercase tracking-[0.16em] text-zinc-500 hover:text-zinc-200"
                  >
                    Attach to composer
                  </button>
                ) : null}
              </div>
            )}
            {event.details && !event.outputPreview && !event.command && (
              <p className="text-[10px] leading-[1.6] text-[var(--nyx-muted)]">
                {event.details}
              </p>
            )}
            {event.changes && event.changes.length > 0 && (
              <div className="space-y-px">
                {event.changes.map((change) => (
                  <button
                    type="button"
                    key={`${event.id}:${change.path}`}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      onOpenChange?.(change.path);
                    }}
                    className="flex w-full items-center gap-1.5 text-[10px] text-left"
                  >
                    <div
                      className={cn(
                        "h-1 w-1 rounded-full",
                        change.kind === "add" && "bg-emerald-400",
                        change.kind === "update" && "bg-[var(--nyx-warn)]",
                        change.kind === "delete" && "bg-[var(--nyx-danger)]",
                      )}
                    />
                    <span className="min-w-0 truncate font-mono text-[var(--nyx-muted)]">
                      {change.path.split("/").pop()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main Panel ──────────────────────────────────────────────────────── */

export function ExecutionPanel({
  events,
  streaming,
  onOpenChange,
  onAttachSnippet,
  className,
}: {
  events: ExecutionEvent[];
  streaming: boolean;
  onOpenChange?: (path: string) => void;
  onAttachSnippet?: (itemId: string, label: string, content: string) => void;
  className?: string;
}) {
  const groups = groupEventsByTurn(events);
  const completedCount = events.filter((e) => e.phase === "completed").length;
  const failedCount = events.filter((e) => e.phase === "failed").length;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-[var(--nyx-panel-2)]",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--nyx-line)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-[var(--nyx-text)]">
            Trace
          </span>
          <div className="flex items-center gap-1.5 font-mono text-[9px]">
            {completedCount > 0 && (
              <span className="text-emerald-400">{completedCount}</span>
            )}
            {failedCount > 0 && (
              <span className="text-[var(--nyx-danger)]">{failedCount}!</span>
            )}
          </div>
        </div>
        {streaming && (
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--nyx-accent)] shadow-[0_0_6px_var(--nyx-accent-glow)]" />
            <span className="text-[9px] font-medium uppercase tracking-wider text-[var(--nyx-accent)]">
              Live
            </span>
          </div>
        )}
      </div>

      {events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div className="flex flex-col items-center gap-2">
            {streaming ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-[var(--nyx-muted)]" />
                <p className="text-[11px] text-[var(--nyx-muted)]">
                  Waiting for trace events...
                </p>
              </>
            ) : (
              <>
                <Globe className="h-4 w-4 text-[var(--nyx-muted)]" />
                <p className="text-[11px] text-[var(--nyx-muted)]">
                  Events will appear as the agent works
                </p>
              </>
            )}
          </div>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-3 pt-2 pb-3">
            {groups.map((group, gi) => {
              // Determine which events in this group are "compact" —
              // completed commands/status in a sequence of 2+
              const isCompact = (ei: number): boolean => {
                const ev = group.events[ei];
                if (ev.phase !== "completed") return false;
                if (ev.kind !== "command" && ev.kind !== "status") return false;
                // If there are 2+ completed commands in the group, compact them all
                const completedCmds = group.events.filter(
                  (e) =>
                    e.phase === "completed" &&
                    (e.kind === "command" || e.kind === "status"),
                );
                return completedCmds.length >= 2;
              };

              return (
                <div key={group.key}>
                  {/* Turn divider */}
                  <div className="flex items-center gap-2 py-1.5">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-[var(--nyx-line-strong)] to-transparent" />
                    <span className="font-mono text-[8px] uppercase tracking-[0.2em] text-[var(--nyx-muted)]">
                      {group.label}
                    </span>
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-[var(--nyx-line-strong)] to-transparent" />
                  </div>
                  {/* Events */}
                  {group.events.map((event, ei) => (
                    <TimelineRow
                      key={event.id}
                      event={event}
                      isLast={
                        gi === groups.length - 1 &&
                        ei === group.events.length - 1
                      }
                      compact={isCompact(ei)}
                      onOpenChange={onOpenChange}
                      onAttachSnippet={onAttachSnippet}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
