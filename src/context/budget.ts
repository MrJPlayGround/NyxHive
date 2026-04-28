import type { StoredMessage } from "../memory/store.js";
import type { ContextBudget, ContextWindow, SoulContextStrategy } from "./types.js";
import { messageTokens, estimateTokens } from "./tokens.js";
import { trimTextToTokenBudget } from "./token-discipline.js";
import { createHash } from "node:crypto";

type ConversationMessage = { role: "user" | "assistant"; content: string };
type ContextReadyMessage = StoredMessage & { content: string; quarantinedOutput?: boolean };

const SUMMARY_CONTEXT_PREFIX = "[CONVERSATION SUMMARY — neutral compressed state, not dialogue, not a prior user or assistant turn]";
const MACHINE_OUTPUT_MIN_CHARS = 8_000;
const MACHINE_OUTPUT_MIN_LINES = 80;
const MACHINE_OUTPUT_SAMPLE_LINES = 6;

// Summary is injected as a single context block because provider messages only
// support user/assistant roles here. The content label keeps it non-dialogic.
// No fake assistant acknowledgment — that polluted history with synthetic exchanges.

function normalizeSummaryForContext(summary: string): string {
  return summary
    .split("\n")
    .map((line) => line
      .replace(/^\s*(assistant|nyx)\s*:\s*/i, "Prior assistant note: ")
      .replace(/^\s*user\s*:\s*/i, "Prior user note: "))
    .join("\n");
}

function buildSummaryContextMessage(summary: string): string {
  return `${SUMMARY_CONTEXT_PREFIX}\n${normalizeSummaryForContext(summary)}`;
}

function shouldQuarantineMachineOutput(content: string): boolean {
  if (content.length < MACHINE_OUTPUT_MIN_CHARS) return false;
  const lines = content.split(/\r?\n/);
  if (lines.length < MACHINE_OUTPUT_MIN_LINES) return false;
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length < MACHINE_OUTPUT_MIN_LINES) return false;
  const denseMachineLines = nonEmptyLines.filter((line) =>
    /^(?:\S+:\d+:|\S+:\s|[+\-]{3}\s|\s*(?:at|error:|warning:|pass|fail|\d+\)|\d+\.|\[|\{))/.test(line),
  ).length;
  return denseMachineLines >= Math.max(20, Math.floor(nonEmptyLines.length * 0.35));
}

function quarantineMachineOutput(message: StoredMessage): ContextReadyMessage {
  if (!shouldQuarantineMachineOutput(message.content)) return { ...message };

  const lines = message.content.split(/\r?\n/);
  const hash = createHash("sha256").update(message.content).digest("hex").slice(0, 16);
  const head = lines.slice(0, MACHINE_OUTPUT_SAMPLE_LINES).join("\n").trim();
  const tail = lines.slice(-MACHINE_OUTPUT_SAMPLE_LINES).join("\n").trim();
  const handle = `conversation=${message.conversation_id} message=${message.id}`;
  const content = [
    "[large machine output quarantined]",
    `handle: ${handle}`,
    `sha256: ${hash}`,
    `lines: ${lines.length}`,
    `chars: ${message.content.length}`,
    "",
    "head:",
    head,
    "",
    "tail:",
    tail,
  ].join("\n").trim();

  return { ...message, content, quarantinedOutput: true };
}

function quarantineMessages(messages: StoredMessage[]): { messages: ContextReadyMessage[]; count: number } {
  let count = 0;
  const quarantined = messages.map((message) => {
    const ready = quarantineMachineOutput(message);
    if (ready.quarantinedOutput) count += 1;
    return ready;
  });
  return { messages: quarantined, count };
}

function metrics(params: {
  messageCount: number;
  tokenCount: number;
  budgetTokens: number;
  truncated: boolean;
  systemPromptTokens: number;
  quarantinedOutputs?: number;
}): ContextWindow["metrics"] {
  const quarantinedOutputs = params.quarantinedOutputs ?? 0;
  return {
    messageCount: params.messageCount,
    tokenCount: params.tokenCount,
    budgetTokens: params.budgetTokens,
    utilizationPct: params.budgetTokens > 0 ? Math.round((params.tokenCount / params.budgetTokens) * 100) : 0,
    truncated: params.truncated || quarantinedOutputs > 0,
    quarantinedOutputs,
    systemPromptTokens: params.systemPromptTokens,
    totalTokens: params.systemPromptTokens + params.tokenCount,
  };
}

/**
 * Build a token-bounded context window from stored messages.
 *
 * Algorithm:
 * 1. Reserve budget for summary prefix if present
 * 2. Walk messages newest-to-oldest, accumulate tokens until budget exhausted
 * 3. Always preserve the most recent user message
 * 4. If last assistant response alone exceeds 80% of remaining budget, truncate its middle
 */
export function buildContextWindow(
  messages: StoredMessage[],
  summary: string | null,
  budget: ContextBudget,
  strategy?: SoulContextStrategy,
): ContextWindow {
  // fresh_context: skip all history
  if (strategy?.fresh_context) {
    return {
      messages: [],
      metrics: metrics({ messageCount: 0, tokenCount: 0, budgetTokens: budget.historyBudget, truncated: false, systemPromptTokens: budget.systemPromptTokens }),
    };
  }

  const prepared = quarantineMessages(messages);
  const contextMessages = prepared.messages;
  const quarantinedOutputs = prepared.count;

  // inject mode: summary + last N messages only (no token budget walk)
  // Relies on system prompt (graph memory, knowledge, work log) for persistent context
  if (strategy?.context_mode === "inject") {
    const recency = strategy.inject_recency ?? 3;
    const recentMessages = contextMessages.slice(-recency);

    // Always include summary in inject mode
    const prefixMessages: ConversationMessage[] = [];
    let prefixTokens = 0;
    if (summary) {
      const summaryMsg = buildSummaryContextMessage(summary);
      prefixMessages.push({ role: "user", content: summaryMsg });
      prefixTokens = estimateTokens(summaryMsg, { mode: "fast" });
    }

    const stripCode = strategy.strip_code_blocks === true;
    const historyMessages: ConversationMessage[] = recentMessages.map((m) => {
      let content = m.content;
      if (stripCode) {
        content = content.replace(/```[\s\S]*?```/g, "[code block removed]");
      }
      return { role: m.role as "user" | "assistant", content };
    });

    const historyTokens = recentMessages.reduce((sum, m) => sum + messageTokens(m, { mode: "fast" }), 0);
    const totalTokens = prefixTokens + historyTokens;

    return {
      messages: [...prefixMessages, ...historyMessages],
      metrics: metrics({
        messageCount: recentMessages.length,
        tokenCount: totalTokens,
        budgetTokens: budget.historyBudget,
        truncated: messages.length > recency,
        systemPromptTokens: budget.systemPromptTokens,
        quarantinedOutputs,
      }),
    };
  }

  // Apply strategy overrides to budget
  const effectiveBudget = strategy?.history_budget_ratio !== undefined
    ? {
        ...budget,
        historyBudget: Math.max(500, Math.floor(Math.max(0, budget.contextWindow - budget.systemPromptTokens - budget.responseReserve) * strategy.history_budget_ratio)),
      }
    : budget;

  const { historyBudget } = effectiveBudget;

  // Apply max_messages cap before budget walk
  const cappedMessages = strategy?.max_messages !== undefined
    ? contextMessages.slice(-strategy.max_messages)
    : contextMessages;

  // Build summary prefix (skip if include_summary=false)
  const includeSummary = strategy?.include_summary !== false;
  const prefixMessages: ConversationMessage[] = [];
  let prefixTokens = 0;
  if (summary && includeSummary) {
    const summaryMsg = buildSummaryContextMessage(summary);
    prefixMessages.push({ role: "user", content: summaryMsg });
    prefixTokens = estimateTokens(summaryMsg, { mode: "fast" });
  }

  const remainingBudget = Math.max(500, historyBudget - prefixTokens);

  if (cappedMessages.length === 0) {
    return {
      messages: prefixMessages,
      metrics: metrics({
        messageCount: 0,
        tokenCount: prefixTokens,
        budgetTokens: historyBudget,
        truncated: messages.length > 0,
        systemPromptTokens: budget.systemPromptTokens,
        quarantinedOutputs,
      }),
    };
  }

  // Walk newest-to-oldest; always keep the most recent user message
  const selected: StoredMessage[] = [];
  let totalTokens = 0;
  const lastIdx = cappedMessages.length - 1;

  for (let i = lastIdx; i >= 0; i--) {
    const msg = cappedMessages[i];
    const tokens = messageTokens(msg, { mode: "fast" });
    // Always include the most recent message (user's latest input)
    const isLastMessage = i === lastIdx;

    if (isLastMessage || totalTokens + tokens <= remainingBudget) {
      selected.unshift(msg);
      totalTokens += tokens;
    } else {
      break;
    }
  }

  // Convert to ConversationMessage array, optionally stripping code blocks
  const stripCode = strategy?.strip_code_blocks === true;
  const historyMessages: ConversationMessage[] = selected.map((m) => {
    let content = m.content;
    if (stripCode) {
      content = content.replace(/```[\s\S]*?```/g, "[code block removed]");
    }
    const messageBudget = Math.max(500, remainingBudget);
    const trimmed = trimTextToTokenBudget(content, messageBudget, {
      marker: "[...history message trimmed for token budget...]",
      mode: "fast",
    });
    content = trimmed.text;
    return { role: m.role as "user" | "assistant", content };
  });

  // Truncate middle of last assistant response if it alone exceeds 80% of remaining budget
  let lastAssistantIdx = -1;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    if (historyMessages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx >= 0) {
    const lastMsg = historyMessages[lastAssistantIdx];
    const lastTokens = estimateTokens(lastMsg.content, { mode: "fast" });
    if (lastTokens > remainingBudget * 0.8) {
      const maxChars = Math.floor(remainingBudget * 0.7 * 3.5);
      if (lastMsg.content.length > maxChars) {
        const half = Math.floor(maxChars / 2);
        // Find paragraph boundary near the cut point (avoid cutting mid-sentence)
        const rawHead = lastMsg.content.slice(0, half);
        const rawTail = lastMsg.content.slice(-half);
        const headCutIdx = rawHead.lastIndexOf("\n\n");
        const tailCutIdx = rawTail.indexOf("\n\n");
        const head = headCutIdx > half * 0.5 ? rawHead.slice(0, headCutIdx) : rawHead;
        const tail = tailCutIdx !== -1 && tailCutIdx < half * 0.5 ? rawTail.slice(tailCutIdx + 2) : rawTail;
        historyMessages[lastAssistantIdx] = {
          ...lastMsg,
          content: `${head}\n\n[...truncated...]\n\n${tail}`,
        };
      }
    }
  }

  const finalHistoryTokens = historyMessages.reduce(
    (sum, msg) => sum + estimateTokens(msg.content, { mode: "fast" }),
    0,
  );
  const totalWithPrefix = prefixTokens + finalHistoryTokens;

  return {
    messages: [...prefixMessages, ...historyMessages],
    metrics: {
      messageCount: selected.length,
      tokenCount: totalWithPrefix,
      budgetTokens: historyBudget,
      utilizationPct: historyBudget > 0 ? Math.round((totalWithPrefix / historyBudget) * 100) : 0,
      truncated: selected.length < messages.length || cappedMessages.length < messages.length || quarantinedOutputs > 0,
      quarantinedOutputs,
      systemPromptTokens: budget.systemPromptTokens,
      totalTokens: budget.systemPromptTokens + totalWithPrefix,
    },
  };
}
