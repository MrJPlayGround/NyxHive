import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  FileCode2,
  FileText,
  Search,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { formatElapsed } from "../../lib/format";
import { ScrollArea } from "../ui/scroll-area";
import { Markdown } from "./Markdown";
import type { ChatMessage, ExecutionEvent } from "../../stores/chat";
import { toDisplayPath } from "../../lib/display-path";
import {
  buildFallbackExecutionEvent,
  buildInlineExecutionPreview,
  describeChatActivity,
  describeExecutionEvent,
  mapExecutionToMessages,
  parseMessageContent,
} from "./message-execution";

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const GATEWAY_USER_BUBBLE_WIDTH_CLASS = [
  "w-fit",
  "max-w-[min(92%,46rem)]",
  "lg:max-w-[min(88%,64rem)]",
  "xl:max-w-[min(84%,76rem)]",
  "2xl:max-w-[min(80%,88rem)]",
].join(" ");

const GATEWAY_ASSISTANT_BUBBLE_WIDTH_CLASS = [
  "w-full",
  "max-w-[min(100%,54rem)]",
  "lg:max-w-[min(96%,72rem)]",
  "xl:max-w-[min(94%,88rem)]",
  "2xl:max-w-[min(92%,104rem)]",
].join(" ");

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

function ChangedFileChips({
  events,
  onOpenChange,
}: {
  events: ExecutionEvent[];
  onOpenChange?: (path: string) => void;
}) {
  if (!onOpenChange) return null;
  const paths = [
    ...new Set(
      events.flatMap(
        (event) => event.changes?.map((change) => change.path) ?? [],
      ),
    ),
  ];
  if (paths.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {paths.slice(0, 6).map((path) => (
        <button
          key={path}
          type="button"
          onClick={() => onOpenChange(path)}
          className="max-w-[18rem] truncate rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] text-zinc-400 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.24)] hover:text-zinc-200 sm:max-w-[24rem]"
        >
          {toDisplayPath(path)}
        </button>
      ))}
      {paths.length > 6 ? (
        <span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[11px] text-zinc-500">
          +{paths.length - 6} more
        </span>
      ) : null}
    </div>
  );
}

function InlineExecutionFeed({
  events,
  onOpenChange,
}: {
  events: ExecutionEvent[];
  onOpenChange?: (path: string) => void;
}) {
  const { items, hiddenCount } = useMemo(
    () => buildInlineExecutionPreview(events),
    [events],
  );
  if (items.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-zinc-500">
        <SquareTerminal className="h-3.5 w-3.5 text-[var(--nyx-accent)]" />
        <span>Trace</span>
        {hiddenCount > 0 ? <span>+{hiddenCount} more</span> : null}
      </div>
      <div className="space-y-1.5">
        {items.map((event) => {
          const Icon = eventIcon(event.kind);
          const primaryPath = event.changes?.[0]?.path;
          const clickable = Boolean(primaryPath && onOpenChange);
          const toneClass =
            event.phase === "failed"
              ? "text-red-300"
              : event.phase === "started" || event.phase === "updated"
                ? "text-zinc-100"
                : "text-zinc-300";
          const dotClass =
            event.phase === "failed"
              ? "bg-red-400"
              : event.phase === "started" || event.phase === "updated"
                ? "bg-[var(--nyx-accent)] shadow-[0_0_8px_var(--nyx-accent-glow)]"
                : "bg-zinc-600";

          return (
            <div
              key={event.id}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]",
                event.phase === "failed"
                  ? "bg-[rgba(244,112,104,0.08)]"
                  : "bg-black/10",
              )}
            >
              <span
                className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass)}
              />
              <Icon className={cn("h-3.5 w-3.5 shrink-0", toneClass)} />
              <span className={cn("min-w-0 flex-1 truncate", toneClass)}>
                {describeExecutionEvent(event)}
              </span>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onOpenChange?.(primaryPath)}
                  className="max-w-[12rem] shrink-0 truncate rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] text-zinc-400 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.24)] hover:text-zinc-200 sm:max-w-[18rem]"
                >
                  {toDisplayPath(primaryPath)}
                </button>
              ) : null}
              {event.phase === "failed" ? (
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReasoningBlock({
  reasoning,
  streaming,
}: {
  reasoning: string;
  streaming: boolean;
}) {
  const lineCount = reasoning
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
  return (
    <details
      open={streaming}
      className="mb-3 overflow-hidden rounded-xl border border-[rgb(var(--nyx-accent-rgb)/0.12)] bg-[rgb(var(--nyx-accent-rgb)/0.05)]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-left marker:content-none">
        <Brain className="h-3.5 w-3.5 shrink-0 text-[var(--nyx-accent)]" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--nyx-accent)]">
          Reasoning
        </span>
        <span className="text-[11px] text-zinc-500">
          {lineCount} line{lineCount === 1 ? "" : "s"}
        </span>
        {streaming ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-zinc-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--nyx-accent)]" />
            Live
          </span>
        ) : null}
      </summary>
      <div className="border-t border-[rgb(var(--nyx-accent-rgb)/0.08)] px-3 py-3">
        <Markdown content={reasoning} />
      </div>
    </details>
  );
}

function ReadingIndicator({ activity }: { activity?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-white/8 bg-black/15 px-3 py-2 text-xs text-zinc-400">
      <span className="inline-flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--nyx-accent)]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--nyx-accent)] [animation-delay:120ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--nyx-accent)] [animation-delay:240ms]" />
      </span>
      <span className="min-w-0 truncate">{describeChatActivity(activity)}</span>
    </div>
  );
}

function Message({
  message,
  executionEvents,
  onOpenChange,
  showReasoning = true,
  showToolCalls = true,
}: {
  message: ChatMessage;
  executionEvents: ExecutionEvent[];
  onOpenChange?: (path: string) => void;
  showReasoning?: boolean;
  showToolCalls?: boolean;
}) {
  const isUser = message.role === "user";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!message.streaming) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [message.streaming]);

  const elapsedSeconds = message.streaming
    ? Math.max(0, Math.floor((now - message.timestamp) / 1000))
    : 0;
  const allExecEvents =
    executionEvents.length > 0
      ? executionEvents
      : buildFallbackExecutionEvent(message);
  const visibleExecutionEvents = showToolCalls
    ? allExecEvents
    : allExecEvents.filter(
        (event) => event.kind !== "mcp_tool" && event.kind !== "command",
      );
  const parsedContent = useMemo(
    () => {
      if (isUser) return { answer: message.content, reasoning: null };
      if (message.reasoning !== undefined) {
        return {
          answer: message.content,
          reasoning: message.reasoning,
        };
      }
      return parseMessageContent(message.content);
    },
    [isUser, message.content, message.reasoning],
  );
  const speakerLabel = isUser ? "You" : message.agent || "Assistant";

  if (!isUser && message.streaming && !parsedContent.answer) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full gap-3 py-4",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "min-w-0 max-w-full overflow-hidden rounded-lg shadow-[0_12px_28px_rgba(0,0,0,0.22)] [contain:layout_paint]",
          isUser
            ? cn(
                GATEWAY_USER_BUBBLE_WIDTH_CLASS,
                "rounded-2xl border border-[rgb(var(--nyx-accent-rgb)/0.12)] bg-[linear-gradient(180deg,rgb(var(--nyx-accent-rgb)/0.13),rgb(var(--nyx-accent-rgb)/0.07))] px-4 py-3 text-zinc-100",
              )
            : cn(
                GATEWAY_ASSISTANT_BUBBLE_WIDTH_CLASS,
                "border-l-2 bg-[linear-gradient(180deg,rgba(17,24,39,0.88),rgba(12,18,28,0.78))] px-4 py-3.5 text-zinc-200",
                message.streaming
                  ? "border-[rgb(var(--nyx-accent-rgb)/0.40)]"
                  : "border-[rgb(var(--nyx-accent-rgb)/0.25)]",
              ),
        )}
        style={{ overflowWrap: "break-word", wordBreak: "break-word" }}
      >
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-2 text-[10px] font-semibold uppercase tracking-[0.16em]",
              isUser
                ? "border-[rgb(var(--nyx-accent-rgb)/0.18)] bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent-2)]"
                : "border-white/10 bg-white/[0.03] text-[var(--nyx-accent)]",
            )}
          >
            {speakerLabel.slice(0, 1)}
          </span>
          <p
            className={cn(
              "min-w-0 truncate text-[12px] font-semibold uppercase tracking-[0.16em]",
              isUser
                ? "text-[var(--nyx-accent-2)]"
                : "text-[var(--nyx-accent)]",
            )}
          >
            {speakerLabel}
          </p>
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.attachments.map((attachment, index) =>
              IMAGE_MIME_TYPES.has(attachment.mimeType) &&
              attachment.previewUrl ? (
                <img
                  key={index}
                  src={attachment.previewUrl}
                  alt={attachment.name ?? "attachment"}
                  className="max-h-48 max-w-full rounded-md border border-zinc-700 object-contain"
                />
              ) : (
                <div
                  key={index}
                className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/50 px-3 py-2"
                >
                  <FileText className="h-4 w-4 shrink-0 text-[var(--nyx-accent)]" />
                  <span className="min-w-0 truncate text-xs text-zinc-300">
                    {attachment.name ?? "file"}
                  </span>
                </div>
              ),
            )}
          </div>
        )}
        {!isUser && showToolCalls ? (
          <InlineExecutionFeed
            events={message.streaming ? [] : visibleExecutionEvents}
            onOpenChange={onOpenChange}
          />
        ) : null}
        {!isUser && showToolCalls ? (
          <ChangedFileChips
            events={message.streaming ? [] : visibleExecutionEvents}
            onOpenChange={onOpenChange}
          />
        ) : null}
        {!isUser && showReasoning && parsedContent.reasoning ? (
          <ReasoningBlock
            reasoning={parsedContent.reasoning}
            streaming={Boolean(message.streaming)}
          />
        ) : null}
        {parsedContent.answer ? (
          <Markdown content={parsedContent.answer} />
        ) : (
          message.streaming &&
          visibleExecutionEvents.length > 0 && (
            <span className="inline-block h-4 w-1 animate-pulse bg-[var(--nyx-accent)]" />
          )
        )}
        {message.streaming && parsedContent.answer && (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-zinc-500">
            <div className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500 [animation-delay:120ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500 [animation-delay:240ms]" />
            </div>
            <span>{describeChatActivity(message.activity)}</span>
            <span className="text-zinc-600">
              {formatElapsed(elapsedSeconds)}
            </span>
          </div>
        )}
        {!isUser && (message.tokensIn || message.tokensOut) ? (
          <p className="mt-2 text-[11px] text-zinc-500">
            {formatTokens(message.tokensIn ?? 0, message.tokensOut ?? 0)}
            {message.cost ? ` · $${message.cost.toFixed(4)}` : ""}
            {message.durationMs
              ? ` · ${(message.durationMs / 1000).toFixed(1)}s`
              : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function formatTokens(tokensIn: number, tokensOut: number): string {
  const total = tokensIn + tokensOut;
  if (total >= 1000) {
    return `${(total / 1000).toFixed(1)}k tokens`;
  }
  return `${total} tokens`;
}

export function MessageList({
  messages,
  executionEvents,
  onOpenChange,
  onSendSuggestion,
  showReasoning = true,
  showToolCalls = true,
  emptyTitle = "NyxHive",
  emptySubtitle = "Send a message to start a conversation",
  emptyActions = [],
}: {
  messages: ChatMessage[];
  executionEvents: ExecutionEvent[];
  onOpenChange?: (path: string) => void;
  onSendSuggestion?: (message: string) => void;
  showReasoning?: boolean;
  showToolCalls?: boolean;
  emptyTitle?: string;
  emptySubtitle?: string;
  emptyActions?: string[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const executionByMessage = useMemo(
    () => mapExecutionToMessages(messages, executionEvents),
    [messages, executionEvents],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, executionEvents]);

  return (
    <ScrollArea className="h-full min-h-0 flex-1">
      <div className="mx-auto min-w-0 max-w-[min(1500px,100%)] space-y-1 px-3 pb-6 sm:px-6">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center py-32">
            <div className="text-center">
              <h2 className="text-shimmer text-2xl font-bold">{emptyTitle}</h2>
              <p className="mt-2 text-sm text-zinc-500">{emptySubtitle}</p>
              {emptyActions.length > 0 && onSendSuggestion ? (
                <div className="mt-5 flex max-w-2xl flex-wrap justify-center gap-2">
                  {emptyActions.map((action) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => onSendSuggestion(action)}
                      className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.24)] hover:text-zinc-100"
                    >
                      {action}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            executionEvents={executionByMessage.get(message.id) ?? []}
            onOpenChange={onOpenChange}
            showReasoning={showReasoning}
            showToolCalls={showToolCalls}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
