import type { ChatMessage, ExecutionEvent } from "../../stores/chat";
import {
  extractThinkingBlocks,
  stripThinking,
} from "../../../../chat/message-content";
export { stripThinking } from "../../../../chat/message-content";

export function buildFallbackExecutionEvent(
  message: ChatMessage,
): ExecutionEvent[] {
  if (!message.streaming || !message.activity) return [];
  const activity = message.activity.trim();
  if (!activity) return [];
  const commandLike =
    activity.startsWith("/") ||
    activity.includes(" -lc ") ||
    activity.includes("git ") ||
    activity.includes("bun ");
  return [
    {
      id: `${message.id}:activity`,
      kind: commandLike ? "command" : "status",
      phase: "started",
      title: commandLike ? "Command run" : "Status",
      command: commandLike ? activity : undefined,
      details: commandLike ? undefined : activity,
      timestamp: message.timestamp,
    },
  ];
}

export function mapExecutionToMessages(
  messages: ChatMessage[],
  events: ExecutionEvent[],
) {
  const assistantIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "assistant");

  const byId = new Map<string, ExecutionEvent[]>();
  if (assistantIndexes.length === 0) return byId;

  for (const event of events) {
    if (event.messageId) {
      const current = byId.get(event.messageId) ?? [];
      current.push(event);
      byId.set(event.messageId, current);
      continue;
    }

    let targetIndex = assistantIndexes.findIndex(({ message }, idx) => {
      const nextAssistant = assistantIndexes[idx + 1]?.message;
      const start = message.timestamp - 2_000;
      const end = message.streaming
        ? Infinity
        : (nextAssistant?.timestamp ?? message.timestamp + 120_000);
      return event.timestamp >= start && event.timestamp < end;
    });

    if (targetIndex === -1) {
      targetIndex = assistantIndexes.findLastIndex(
        ({ message }) =>
          message.streaming && event.timestamp >= message.timestamp - 2_000,
      );
    }
    if (targetIndex === -1) {
      targetIndex = assistantIndexes.findLastIndex(
        ({ message }) => event.timestamp >= message.timestamp - 60_000,
      );
    }
    if (targetIndex === -1) continue;

    const messageId = assistantIndexes[targetIndex].message.id;
    const current = byId.get(messageId) ?? [];
    current.push(event);
    byId.set(messageId, current);
  }

  return byId;
}

export function describeExecutionEvent(event: ExecutionEvent): string {
  if (event.kind === "command" && event.command) {
    const command = event.command.trim();
    const cleaned = command.replace(/^(?:sudo\s+|env\s+\S+=\S+\s+)*/, "");
    const words = cleaned.split(/\s+/);
    const first = words[0] ?? cleaned;
    const base = first.split("/").pop() ?? first;
    if (words.length >= 2 && base.length + words[1].length < 30) {
      return `${base} ${words[1]}`;
    }
    return base;
  }
  if (event.kind === "file_change" && event.changes?.length) {
    if (event.changes.length === 1) {
      const change = event.changes[0];
      return `${change.kind} ${change.path.split("/").pop() ?? change.path}`;
    }
    const kinds = new Set(event.changes.map((change) => change.kind));
    const verb = kinds.size === 1 ? [...kinds][0] : "changed";
    return `${verb} ${event.changes.length} files`;
  }
  if (event.kind === "mcp_tool" && event.subtitle) {
    return event.subtitle;
  }
  if (event.kind === "status" && event.details) {
    return event.details;
  }
  const title = event.title.trim();
  if (/^(Command run|Status|File change)\s*/i.test(title)) {
    const stripped = title
      .replace(/^(Command run|Status|File change)\s*/i, "")
      .trim();
    if (stripped) return stripped;
  }
  return title;
}

export function describeChatActivity(activity?: string, latestEvent?: ExecutionEvent): string {
  if (latestEvent?.phase === "failed") return "Nyx hit a snag.";
  if (latestEvent?.kind === "file_change") return "Nyx is updating files...";
  if (latestEvent?.kind === "web_search") return "Nyx is checking sources...";
  if (latestEvent?.kind === "mcp_tool") return "Nyx is using a tool...";
  if (latestEvent?.kind === "command") return "Nyx is working...";

  const normalized = activity?.trim().toLowerCase() ?? "";
  if (!normalized) return "Nyx is thinking...";
  if (/\b(read(?:ing)?|open(?:ing)?|inspect(?:ing)?|search(?:ing)?|look(?:ing)? up|browse|browsing)\b/.test(normalized)) {
    return "Nyx is checking context...";
  }
  if (/\b(write|edit|patch|update|modify|fix|implement|test|run|build)\b/.test(normalized)) {
    return "Nyx is working...";
  }
  if (/\b(classif|think|reason|respond)\b/.test(normalized)) {
    return "Nyx is thinking...";
  }
  return "Nyx is working...";
}

export function parseMessageContent(content: string) {
  const reasoningBlocks = extractThinkingBlocks(content);
  return {
    answer: stripThinking(content),
    reasoning: reasoningBlocks.length > 0 ? reasoningBlocks.join("\n\n") : null,
  };
}

export function buildInlineExecutionPreview(
  events: ExecutionEvent[],
  maxItems = 3,
) {
  if (events.length === 0 || maxItems <= 0) {
    return { items: [] as ExecutionEvent[], hiddenCount: 0 };
  }
  const selected: ExecutionEvent[] = [];
  const seen = new Set<string>();
  const interesting = events.filter(isPrimaryChatExecutionEvent);
  for (const event of [...interesting].reverse()) {
    if (seen.has(event.id)) continue;
    selected.push(event);
    seen.add(event.id);
    if (selected.length >= maxItems) break;
  }
  if (selected.length < maxItems) {
    for (const event of [...events].filter(isPrimaryChatExecutionEvent).reverse()) {
      if (seen.has(event.id)) continue;
      selected.push(event);
      seen.add(event.id);
      if (selected.length >= maxItems) break;
    }
  }
  const items = selected.sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  return {
    items,
    hiddenCount: Math.max(0, interesting.length - items.length),
  };
}

export function isPrimaryChatExecutionEvent(event: ExecutionEvent): boolean {
  if (event.phase === "failed") return true;
  if (event.kind === "file_change" && event.changes?.length) return true;
  if (event.outputPreview?.trim()) return event.phase === "completed";
  if (event.kind === "web_search" && event.phase === "completed") return true;
  return false;
}
