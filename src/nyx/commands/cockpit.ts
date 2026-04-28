import { defineCommand } from "citty";
import { randomUUID } from "node:crypto";
import { emitKeypressEvents, type Key } from "node:readline";
import { stdin, stdout } from "node:process";
import pc from "picocolors";
import { api } from "../lib/api.js";
import { duration } from "../lib/format.js";
import { loadInstances, type InstanceConfig } from "../lib/config.js";
import { renderMarkdownLines } from "../lib/markdown.js";
import { NyxHiveProvider, type SSEEvent } from "../lib/provider.js";
import { deleteSession, listSessions, saveSession, type LocalSession } from "../lib/sessions.js";

interface HealthResponse {
  status: string;
  uptime_seconds?: number;
  queue?: {
    pending?: number;
    processing?: number;
    completed?: number;
    failed?: number;
  };
  agents?: {
    count?: number;
    names?: string[];
  };
  warnings?: string[];
}

interface InfoResponse {
  name?: string;
  agents?: string[];
}

interface RunSummary {
  run_id: string;
  agent: string;
  status: string;
  task_description?: string;
  created_at: number;
  completed_at?: number | null;
}

interface SessionCreateResponse {
  session_id?: string;
}

interface SessionSummaryResponse {
  session_id: string;
  title: string;
  agent: string | null;
  message_count: number;
  total_cost_cents: number;
  created_at: number;
  updated_at: number;
}

interface SessionListResponse {
  sessions: Array<{
    session_id: string;
    title: string;
    agent: string | null;
    total_cost_cents: number;
    created_at: number;
    updated_at: number;
  }>;
  total: number;
}

interface SessionMessageRecord {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  agent: string | null;
  created_at: number;
}

interface SessionDetailResponse extends SessionSummaryResponse {
  messages: SessionMessageRecord[];
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  streaming?: boolean;
  streamMode?: "delta" | "token";
}

type ActivityKind = "tool" | "status" | "system" | "error" | "response" | "reason";

interface ActivityItem {
  at: number;
  kind: ActivityKind;
  text: string;
}

interface UsageSnapshot {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs?: number;
}

type RuntimeItemKind = "command" | "file_change" | "mcp_tool" | "web_search" | "status" | "agent_message";
type RuntimePhase = "started" | "updated" | "completed" | "failed";

interface RuntimeChange {
  path: string;
  kind: "add" | "delete" | "update";
}

interface RuntimeItem {
  id: string;
  kind: RuntimeItemKind;
  phase: RuntimePhase;
  title: string;
  subtitle?: string;
  details?: string;
  command?: string;
  outputPreview?: string;
  exitCode?: number | null;
  changes?: RuntimeChange[];
  timestamp: number;
}

interface FileChangeItem {
  filePath: string;
  operation: "write" | "edit" | "create" | "delete" | "update";
  linesAdded: number;
  linesRemoved: number;
  diffSummary?: string;
  timestamp: number;
}

interface BrowserSessionItem {
  session_id: string;
  title: string;
  agent: string | null;
  message_count: number;
  total_cost_cents: number;
  created_at: number;
  updated_at: number;
  localOnly: boolean;
  current: boolean;
}

type InspectorTab = "ops" | "tools" | "diff" | "trace";
type LayoutMode = "overview" | "split" | "chat" | "diff" | "tools" | "reason";

interface CockpitEntry {
  key: string;
  label: string;
  instance: InstanceConfig;
  agent: string;
  health: HealthResponse | null;
  runs: RunSummary[];
  sessionId: string | null;
  sessionTitle?: string;
  messageCount: number;
  costCents: number;
  messages: ChatMessage[];
  activity: string;
  activityLog: ActivityItem[];
  runtimeItems: RuntimeItem[];
  fileChanges: FileChangeItem[];
  isStreaming: boolean;
  lastError?: string;
  usage: UsageSnapshot;
  streamStartedAt?: number;
  lastResponseAt?: number;
  selectedRuntimeIndex: number;
  selectedChangeIndex: number;
}

interface QueuedPrompt {
  entryKey: string;
  entryLabel: string;
  message: string;
}

interface RenderBoxOptions {
  tail?: boolean;
  border?: (value: string) => string;
}

const LEGACY_HIDDEN_INSTANCE_NAMES = new Set(["gateway", "onyx", "strider", "onxy"]);
const LEAD_AGENT_PRIORITY = ["nyx", "vortex", "aether", "morph"];
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const MAX_ACTIVITY_ITEMS = 120;
const MAX_RUNTIME_ITEMS = 160;
const MAX_FILE_CHANGES = 120;
const INSPECTOR_TABS: InspectorTab[] = ["ops", "tools", "diff", "trace"];

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function preferredCockpitInstances(instances: InstanceConfig[], includeAll: boolean): InstanceConfig[] {
  const filtered = includeAll
    ? instances
    : instances.filter((inst) => !LEGACY_HIDDEN_INSTANCE_NAMES.has(normalizeName(inst.name)));
  const list = filtered.length > 0 ? filtered : instances;
  const order = ["nyxai", "nyxlabs", "aether"];
  return [...list].sort((a, b) => {
    const ai = order.indexOf(normalizeName(a.name));
    const bi = order.indexOf(normalizeName(b.name));
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function titleCase(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  if (width === 1) return plain.slice(0, 1);
  return `${plain.slice(0, width - 1)}…`;
}

function fit(text: string, width: number): string {
  const safe = truncate(text, width);
  return safe + " ".repeat(Math.max(0, width - visibleLength(safe)));
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  const paragraphs = stripAnsi(text).replace(/\r/g, "").split("\n");
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word.length > width ? truncate(word, width) : word;
        continue;
      }
      if ((line + " " + word).length <= width) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word.length > width ? truncate(word, width) : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !stripAnsi(lines[start] ?? "").trim()) start++;
  while (end > start && !stripAnsi(lines[end - 1] ?? "").trim()) end--;
  return lines.slice(start, end);
}

function wrapMultiline(text: string, width: number): string[] {
  const chunks = text.replace(/\r/g, "").split("\n");
  const output: string[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) {
      output.push("");
      continue;
    }
    output.push(...wrapText(chunk, width));
  }
  return output.length > 0 ? output : [""];
}

function renderReadableText(text: string, width: number): string[] {
  return trimBlankLines(renderMarkdownLines(text, Math.max(12, width)));
}

function tailLines<T>(lines: T[], count: number): T[] {
  if (count <= 0) return [];
  if (lines.length <= count) return [...lines];
  return lines.slice(lines.length - count);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shortTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function shortSession(sessionId: string | null): string {
  return sessionId ? sessionId.slice(0, 8) : "none";
}

function healthLabel(entry: CockpitEntry): string {
  if (!entry.health) return "down";
  return entry.health.status === "ok" ? "up" : entry.health.status;
}

function formatCost(costCents: number): string {
  return `$${(costCents / 100).toFixed(2)}`;
}

function statusTone(status: string): (value: string) => string {
  const normalized = normalizeName(status);
  if (normalized === "ok" || normalized === "up" || normalized === "completed") return pc.green;
  if (normalized === "down" || normalized === "error" || normalized === "failed") return pc.red;
  if (normalized === "started" || normalized === "updated") return pc.cyan;
  return pc.yellow;
}

function pickLeadAgent(info: InfoResponse | null, health: HealthResponse | null, fallbackName: string): string {
  const agents = info?.agents ?? health?.agents?.names ?? [];
  for (const preferred of LEAD_AGENT_PRIORITY) {
    if (agents.some((agent) => normalizeName(agent) === preferred)) return preferred;
  }
  const normalizedFallback = normalizeName(fallbackName);
  if (agents.some((agent) => normalizeName(agent) === normalizedFallback)) return normalizedFallback;
  return agents[0] ?? normalizedFallback;
}

function themeForEntry(entry: Pick<CockpitEntry, "key" | "agent" | "label">): {
  accent: (value: string) => string;
  muted: (value: string) => string;
  badge: string;
  glyph: string;
  avatar: string;
  portrait: string[];
} {
  const key = normalizeName(entry.key || entry.agent || entry.label);
  if (key.includes("vortex") || key.includes("nyxlabs")) {
    return {
      accent: pc.yellow,
      muted: pc.magenta,
      badge: pc.bgYellow(pc.black(" VTX ")),
      glyph: "◈",
      avatar: pc.bgYellow(pc.black(" V ")),
      portrait: [`${pc.bgYellow(pc.black(" V "))} ${pc.yellow("journal lead")}`],
    };
  }
  if (key.includes("nyx")) {
    return {
      accent: pc.cyan,
      muted: pc.blue,
      badge: pc.bgCyan(pc.black(" NYX ")),
      glyph: "◐",
      avatar: pc.bgCyan(pc.black(" N ")),
      portrait: [`${pc.bgCyan(pc.black(" N "))} ${pc.cyan("code lead")}`],
    };
  }
  if (key.includes("aether")) {
    return {
      accent: pc.green,
      muted: pc.cyan,
      badge: pc.bgGreen(pc.black(" AET ")),
      glyph: "△",
      avatar: pc.bgGreen(pc.black(" A ")),
      portrait: [`${pc.bgGreen(pc.black(" A "))} ${pc.green("trade ops")}`],
    };
  }
  return {
    accent: pc.white,
    muted: pc.dim,
    badge: pc.bgWhite(pc.black(" AGT ")),
    glyph: "•",
    avatar: pc.bgWhite(pc.black(" ? ")),
    portrait: [`${pc.bgWhite(pc.black(" ? "))} ${pc.white("agent")}`],
  };
}

function layoutLabel(mode: LayoutMode): string {
  return mode === "reason" ? "reason" : mode;
}

function runtimeKindLabel(kind: RuntimeItemKind): string {
  switch (kind) {
    case "command":
      return "$";
    case "file_change":
      return "Δ";
    case "mcp_tool":
      return "⌘";
    case "web_search":
      return "⌕";
    case "agent_message":
      return "↔";
    case "status":
    default:
      return "•";
  }
}

function activityGlyph(kind: ActivityKind): string {
  switch (kind) {
    case "tool":
      return "⌘";
    case "error":
      return "✕";
    case "response":
      return "↳";
    case "reason":
      return "≈";
    case "system":
      return "•";
    case "status":
    default:
      return "·";
  }
}

function lastAssistantMessage(entry: CockpitEntry): ChatMessage | null {
  return [...entry.messages].reverse().find((message) => message.role === "assistant") ?? null;
}

function compactCount(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}

function latestPreviewLines(entry: CockpitEntry, width: number, maxLines = 2): string[] {
  const assistant = lastAssistantMessage(entry);
  if (!assistant?.content) return [pc.dim("No assistant reply yet.")];
  return renderReadableText(assistant.content, width).slice(0, maxLines);
}

function buildOverviewLines(entries: CockpitEntry[], selectedIndex: number, width: number, height: number): string[] {
  const lines: string[] = [
    pc.bold("Fleet Overview"),
    pc.dim("One front door. Three repo owners. Zero orchestrator cosplay."),
    "",
  ];

  for (const [index, entry] of entries.entries()) {
    const theme = themeForEntry(entry);
    const selected = index === selectedIndex;
    const live = entry.isStreaming;
    const queue = entry.health?.queue;
    const status = healthLabel(entry);
    const headLeft = `${selected ? theme.accent("›") : pc.dim(" ")} ${theme.badge} ${selected ? theme.accent(entry.label) : entry.label} ${pc.dim(`@${entry.agent}`)}`;
    const headRight = live ? pc.cyan("live") : statusTone(status)(status);
    lines.push(joinEdge(headLeft, headRight, width));
    lines.push(`  ${pc.dim("now")} ${truncate(entry.activity || (live ? "stream open" : "idle"), Math.max(12, width - 8))}`);
    lines.push(`  ${pc.dim("queue")} ${queue?.pending ?? 0}/${queue?.processing ?? 0}/${queue?.completed ?? 0}   ${pc.dim("turns")} ${entry.messageCount}   ${pc.dim("cost")} ${formatCost(entry.costCents)}`);
    const preview = latestPreviewLines(entry, Math.max(12, width - 4), 2);
    for (const line of preview) lines.push(`  ${line}`);
    lines.push("");
  }

  const selected = entries[selectedIndex] ?? entries[0];
  const recent = tailLines(selected.activityLog, 3);
  lines.push(pc.dim(`Selected: ${selected.label}`));
  if (recent.length === 0) {
    lines.push(pc.dim("No recent signals."));
  } else {
    for (const item of recent) {
      const tone = activityKindTone(item.kind);
      lines.push(`  ${pc.dim(shortTime(item.at))} ${tone(activityGlyph(item.kind))} ${truncate(item.text, Math.max(12, width - 10))}`);
    }
  }

  return lines.slice(0, height);
}

function joinEdge(left: string, right: string, width: number): string {
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  if (leftLen + rightLen + 1 <= width) {
    return left + " ".repeat(Math.max(1, width - leftLen - rightLen)) + right;
  }
  if (rightLen >= width) return fit(right, width);
  const safeLeft = truncate(left, width - rightLen - 1);
  return safeLeft + " ".repeat(Math.max(1, width - visibleLength(safeLeft) - rightLen)) + right;
}

function renderBox(title: string, lines: string[], width: number, height: number, options: RenderBoxOptions = {}): string[] {
  const border = options.border ?? ((value: string) => pc.dim(value));
  const innerWidth = Math.max(1, width - 2);
  const usable = Math.max(0, height - 2);
  const source = options.tail ? tailLines(lines, usable) : lines.slice(0, usable);
  const body = [...source];
  while (body.length < usable) body.push("");
  const label = ` ${truncate(title, Math.max(1, innerWidth - 1))} `;
  const top = `${border("╭")}${label}${border("─".repeat(Math.max(0, innerWidth - visibleLength(label))))}${border("╮")}`;
  const bottom = `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`;
  const side = border("│");
  const rendered = body.map((line) => `${side}${fit(line, innerWidth)}${side}`);
  return [top, ...rendered, bottom].slice(0, height);
}

function pushActivity(entry: CockpitEntry, kind: ActivityKind, text: string): void {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) return;
  const previous = entry.activityLog[entry.activityLog.length - 1];
  if (previous && previous.kind === kind && previous.text === cleaned) {
    previous.at = Date.now();
    return;
  }
  entry.activityLog.push({ at: Date.now(), kind, text: cleaned });
  if (entry.activityLog.length > MAX_ACTIVITY_ITEMS) {
    entry.activityLog.splice(0, entry.activityLog.length - MAX_ACTIVITY_ITEMS);
  }
}

function uniqueLatestChanges(changes: FileChangeItem[]): FileChangeItem[] {
  const latestByPath = new Map<string, FileChangeItem>();
  for (const change of changes) {
    const current = latestByPath.get(change.filePath);
    if (!current || current.timestamp <= change.timestamp) {
      latestByPath.set(change.filePath, change);
    }
  }
  return [...latestByPath.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function summarizeRuntimeItem(item: RuntimeItem): string {
  if (item.kind === "command" && item.command) {
    const cleaned = item.command.trim().replace(/^(?:sudo\s+|env\s+\S+=\S+\s+)*/, "");
    const words = cleaned.split(/\s+/).filter(Boolean);
    const first = words[0]?.split("/").pop() ?? cleaned;
    if (words[1] && first.length + words[1].length < 26) return `${first} ${words[1]}`;
    return first || item.title;
  }
  if (item.kind === "file_change") {
    const first = item.changes?.[0]?.path ?? item.subtitle ?? item.title;
    const file = first.split("/").pop() ?? first;
    return `${item.phase === "completed" ? "edited" : "editing"} ${file}`;
  }
  if (item.kind === "web_search") return item.subtitle ?? item.title;
  if (item.kind === "mcp_tool") return item.subtitle ?? item.title;
  return item.subtitle ?? item.title;
}

function runtimePhaseBadge(item: RuntimeItem): string {
  const tone = statusTone(item.phase);
  const glyph = item.phase === "failed" ? "✕" : item.phase === "completed" ? "●" : "◌";
  return tone(glyph);
}

function activityKindTone(kind: ActivityKind): (value: string) => string {
  switch (kind) {
    case "tool":
      return pc.cyan;
    case "error":
      return pc.red;
    case "response":
      return pc.green;
    case "reason":
      return pc.magenta;
    case "system":
      return pc.yellow;
    default:
      return pc.white;
  }
}

function colorizeDiffLine(line: string, width: number): string {
  const clipped = truncate(line, Math.max(8, width));
  if (clipped.startsWith("@@")) return pc.cyan(clipped);
  if (clipped.startsWith("diff --git") || clipped.startsWith("index ") || clipped.startsWith("---") || clipped.startsWith("+++")) {
    return pc.dim(clipped);
  }
  if (clipped.startsWith("+")) return pc.green(clipped);
  if (clipped.startsWith("-")) return pc.red(clipped);
  return clipped;
}

function renderDiffSummary(summary: string, width: number, maxLines: number): string[] {
  const sourceLines = stripAnsi(summary).replace(/\r/g, "").split("\n");
  const rendered: string[] = [];
  for (const source of sourceLines) {
    const wrapped = source.trim() ? wrapText(source, Math.max(8, width)) : [""];
    for (const line of wrapped) {
      rendered.push(colorizeDiffLine(line, width));
      if (rendered.length >= maxLines) return rendered;
    }
  }
  return rendered;
}

function upsertRuntimeItem(entry: CockpitEntry, item: RuntimeItem): void {
  const index = entry.runtimeItems.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) {
    entry.runtimeItems[index] = { ...entry.runtimeItems[index]!, ...item };
  } else {
    entry.runtimeItems.push(item);
    if (entry.runtimeItems.length > MAX_RUNTIME_ITEMS) {
      entry.runtimeItems.splice(0, entry.runtimeItems.length - MAX_RUNTIME_ITEMS);
    }
  }
  entry.selectedRuntimeIndex = entry.runtimeItems.length - 1;
}

function recordFileChanges(entry: CockpitEntry, item: RuntimeItem): void {
  if (!item.changes || item.changes.length === 0) return;
  const timestamp = item.timestamp || Date.now();
  for (const change of item.changes) {
    const next: FileChangeItem = {
      filePath: change.path,
      operation: change.kind === "add" ? "create" : change.kind === "delete" ? "delete" : item.kind === "file_change" ? "edit" : "update",
      linesAdded: 0,
      linesRemoved: 0,
      diffSummary: item.details ?? item.outputPreview ?? item.subtitle,
      timestamp,
    };
    const index = entry.fileChanges.findIndex((candidate) => candidate.filePath === next.filePath && candidate.timestamp === next.timestamp);
    if (index >= 0) {
      entry.fileChanges[index] = { ...entry.fileChanges[index]!, ...next };
    } else {
      entry.fileChanges.push(next);
      if (entry.fileChanges.length > MAX_FILE_CHANGES) {
        entry.fileChanges.splice(0, entry.fileChanges.length - MAX_FILE_CHANGES);
      }
    }
  }
  entry.selectedChangeIndex = uniqueLatestChanges(entry.fileChanges).length - 1;
}

function renderMessageCard(message: ChatMessage, entry: CockpitEntry, width: number): string[] {
  const theme = themeForEntry(entry);
  const inner = Math.max(10, width - 4);
  const stamp = pc.dim(shortTime(message.timestamp));
  const header =
    message.role === "user"
      ? `${pc.bold("YOU")} ${stamp}`
      : message.role === "assistant"
        ? `${theme.avatar} ${theme.accent(pc.bold(entry.label))} ${stamp} ${message.streaming ? pc.cyan("live") : pc.dim("done")}`
        : `${pc.bgYellow(pc.black(" SYS "))} ${pc.yellow("system")} ${stamp}`;
  const border =
    message.role === "user"
      ? pc.dim
      : message.role === "assistant"
        ? theme.muted
        : pc.yellow;
  const content = message.content || (message.streaming ? "Waiting for first token…" : "");
  const lines =
    message.role === "assistant"
      ? renderReadableText(content, inner)
      : message.role === "system"
        ? wrapMultiline(content, inner)
        : wrapMultiline(content, inner);
  const body = lines.map((line) => `${border("│")} ${fit(line, inner)} ${border("│")}`);
  if (message.role === "assistant" && message.streaming) {
    const runtimePreview = buildLiveRuntimePreview(entry, inner);
    if (runtimePreview.length > 0) {
      body.push(`${border("│")} ${fit("", inner)} ${border("│")}`);
      body.push(`${border("│")} ${fit(pc.dim("live runtime"), inner)} ${border("│")}`);
      for (const line of runtimePreview) {
        body.push(`${border("│")} ${fit(line, inner)} ${border("│")}`);
      }
    }
  }
  if (message.streaming && message.content) {
    body.push(`${border("│")} ${fit(pc.dim("…streaming"), inner)} ${border("│")}`);
  }
  const top = `${border("╭")} ${fit(header, inner)} ${border("╮")}`;
  const bottom = `${border("╰")}${border("─".repeat(inner + 2))}${border("╯")}`;
  return [top, ...body, bottom];
}

function buildLiveRuntimePreview(entry: CockpitEntry, width: number): string[] {
  const lines: string[] = [];
  const runtimeItems = entry.runtimeItems.slice(-3);
  for (const item of runtimeItems) {
    lines.push(`${runtimePhaseBadge(item)} ${truncate(summarizeRuntimeItem(item), Math.max(8, width - 2))}`);
  }

  const recentTrace = entry.activityLog.filter((item) => item.kind === "reason").slice(-2);
  for (const item of recentTrace) {
    lines.push(pc.dim(`trace: ${truncate(item.text, Math.max(8, width - 8))}`));
  }

  return lines.slice(0, 6);
}

function buildConversationBlocks(entry: CockpitEntry, width: number): string[][] {
  if (entry.messages.length === 0) {
    const theme = themeForEntry(entry);
    return [[
      `${theme.avatar} ${theme.accent("Direct owners. No babysitter.")}`,
      "",
      `${pc.dim("Talk straight to")} ${theme.accent(entry.label)} ${pc.dim(`@${entry.agent}`)}`,
      "",
      "Composer lives below the thread.",
      "Tools, diff, and reasoning stay right.",
      "Enter sends. [ and ] switch tabs. /sessions opens history.",
    ]];
  }

  return entry.messages.map((message) => [...renderMessageCard(message, entry, width), ""]);
}

function fitConversationBlock(block: string[], height: number): string[] {
  if (block.length <= height) return block;
  if (height <= 6) return tailLines(block, height);
  const head = block.slice(0, 2);
  const remaining = Math.max(0, height - head.length);
  return [...head, ...tailLines(block.slice(head.length), remaining)];
}

function buildConversationLines(entry: CockpitEntry, width: number, height: number): string[] {
  const blocks = buildConversationBlocks(entry, width);
  const selected: string[][] = [];
  let used = 0;

  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index] ?? [];
    if (selected.length === 0 && block.length >= height) {
      return fitConversationBlock(block, height);
    }
    if (used + block.length > height) break;
    selected.unshift(block);
    used += block.length;
  }

  return selected.flat();
}

function buildInstanceLines(entries: CockpitEntry[], selectedIndex: number, activeKey: string | null, width: number): string[] {
  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const theme = themeForEntry(entry);
    const selected = index === selectedIndex;
    const live = activeKey === entry.key;
    const queue = entry.health?.queue;
    const status = healthLabel(entry);
    const titleLeft = `${selected ? theme.accent("›") : pc.dim(String(index + 1))} ${theme.badge} ${selected ? theme.accent(entry.label) : entry.label}`;
    const titleRight = live ? pc.cyan("live") : statusTone(status)(status);
    lines.push(joinEdge(titleLeft, titleRight, width));
    lines.push(fit(`  ${pc.dim("@"+entry.agent)}  ${pc.dim("session")} ${shortSession(entry.sessionId)}  ${pc.dim("turns")} ${entry.messageCount}`, width));
    lines.push(fit(`  ${pc.dim("queue")} ${queue?.pending ?? 0}/${queue?.processing ?? 0}/${queue?.completed ?? 0}  ${pc.dim("cost")} ${formatCost(entry.costCents)}`, width));
    const activityText = entry.lastError
      ? pc.red(truncate(entry.lastError, Math.max(8, width - 8)))
      : truncate(entry.activity || (live ? "stream open" : "idle"), Math.max(8, width - 8));
    lines.push(fit(`  ${pc.dim("now")} ${live ? theme.accent(activityText) : activityText}`, width));
    lines.push("");
  }
  return lines.length > 0 ? lines : ["No remote instances."];
}

function inspectorTabs(tab: InspectorTab): string {
  return INSPECTOR_TABS.map((candidate) => {
    const label = candidate === "trace" ? "reason" : candidate;
    const text = candidate === tab ? ` ${label} ` : label;
    return candidate === tab ? pc.bold(pc.white(text)) : pc.dim(text);
  }).join(pc.dim("  ·  "));
}

function inspectorTitle(tab: InspectorTab, entry: CockpitEntry): string {
  const summary =
    tab === "tools"
      ? `${entry.runtimeItems.length}e`
      : tab === "diff"
        ? `${uniqueLatestChanges(entry.fileChanges).length}f`
        : tab === "trace"
          ? `${entry.activityLog.length}s`
          : `${entry.runs.length}r`;
  const label = tab === "trace" ? "reason" : tab;
  return `${pc.bold("inspect")} ${label} ${pc.dim(summary)}`;
}

function buildOpsLines(entry: CockpitEntry, width: number, height: number): string[] {
  const queue = entry.health?.queue;
  const warnings = entry.health?.warnings ?? [];
  const lines: string[] = [
    `${themeForEntry(entry).accent("Status")} ${statusTone(healthLabel(entry))(healthLabel(entry))}`,
    `Lead      @${entry.agent}`,
    `Session   ${entry.sessionTitle ? truncate(entry.sessionTitle, Math.max(10, width - 12)) : shortSession(entry.sessionId)}`,
    `Turns     ${entry.messageCount}`,
    `Cost      ${formatCost(entry.costCents)}`,
    `Queue     ${queue?.pending ?? 0} wait  ${queue?.processing ?? 0} run  ${queue?.failed ?? 0} fail`,
    `Uptime    ${entry.health?.uptime_seconds ? duration(entry.health.uptime_seconds * 1000) : "—"}`,
    `Model     ${entry.usage.model ? truncate(entry.usage.model, Math.max(8, width - 12)) : "server"}`,
    `Tokens    ${(entry.usage.inputTokens ?? 0).toLocaleString()} in  ${(entry.usage.outputTokens ?? 0).toLocaleString()} out`,
    "",
    pc.dim("Recent runs"),
  ];

  if (entry.runs.length === 0) {
    lines.push(pc.dim("No recent runs."));
  } else {
    for (const run of entry.runs.slice(0, 5)) {
      lines.push(`${shortTime(run.created_at)} ${truncate(run.agent, 8)} ${statusTone(run.status)(truncate(run.status, 10))}`);
      if (run.task_description) lines.push(`  ${truncate(run.task_description, Math.max(12, width - 2))}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push(pc.dim("Warnings"));
    for (const warning of warnings.slice(0, 3)) {
      lines.push(...wrapText(warning, Math.max(8, width)).map((line) => `  ${line}`));
    }
  }

  return tailLines(lines, height);
}

function selectedRuntimeItem(entry: CockpitEntry): RuntimeItem | null {
  if (entry.runtimeItems.length === 0) return null;
  entry.selectedRuntimeIndex = clamp(entry.selectedRuntimeIndex, 0, entry.runtimeItems.length - 1);
  return entry.runtimeItems[entry.selectedRuntimeIndex] ?? null;
}

function buildToolLines(entry: CockpitEntry, width: number, height: number): string[] {
  const lines: string[] = [pc.dim("Live lane"), ""];
  const visibleList = Math.max(6, Math.floor(height * 0.42));
  const items = entry.runtimeItems.slice(-visibleList);
  const baseIndex = Math.max(0, entry.runtimeItems.length - items.length);

  if (items.length === 0) {
    lines.push(pc.dim("No tool/runtime events yet."));
    lines.push(pc.dim("This pane fills from execution:event streaming."));
    return tailLines(lines, height);
  }

  for (const [index, item] of items.entries()) {
    const absoluteIndex = baseIndex + index;
    const selected = absoluteIndex === entry.selectedRuntimeIndex;
    const marker = selected ? pc.cyan("›") : pc.dim(" ");
    const icon = runtimeKindLabel(item.kind);
    const head = `${marker} ${runtimePhaseBadge(item)} ${icon} ${truncate(summarizeRuntimeItem(item), Math.max(8, width - 14))}`;
    lines.push(head);
    const meta = `${pc.dim(shortTime(item.timestamp))} ${pc.dim(item.kind)}${item.exitCode != null && item.exitCode !== 0 ? ` ${pc.red(`E${item.exitCode}`)}` : ""}`;
    lines.push(`  ${fit(meta, Math.max(1, width - 2))}`);
  }

  const selected = selectedRuntimeItem(entry);
  if (selected) {
    lines.push("");
    lines.push(pc.dim("Focus"));
    lines.push(`${runtimePhaseBadge(selected)} ${runtimeKindLabel(selected.kind)} ${selected.title}`);
    if (selected.subtitle) lines.push(...wrapText(selected.subtitle, Math.max(8, width)).map((line) => `  ${line}`));
    if (selected.command) {
      lines.push("");
      lines.push(pc.dim("Command"));
      lines.push(...wrapText(selected.command, Math.max(8, width)).map((line) => `  ${line}`));
    }
    if (selected.outputPreview) {
      lines.push("");
      lines.push(pc.dim("Output"));
      lines.push(...wrapText(selected.outputPreview, Math.max(8, width)).map((line) => `  ${line}`));
    } else if (selected.details) {
      lines.push("");
      lines.push(pc.dim("Details"));
      lines.push(...wrapText(selected.details, Math.max(8, width)).map((line) => `  ${line}`));
    }
    if (selected.changes && selected.changes.length > 0) {
      lines.push("");
      lines.push(pc.dim("Files"));
      for (const change of selected.changes.slice(0, 6)) {
        lines.push(`  ${change.kind.padEnd(6, " ")} ${truncate(change.path, Math.max(8, width - 10))}`);
      }
    }
  }

  return tailLines(lines, height);
}

function selectedFileChange(entry: CockpitEntry): FileChangeItem | null {
  const latest = uniqueLatestChanges(entry.fileChanges);
  if (latest.length === 0) return null;
  entry.selectedChangeIndex = clamp(entry.selectedChangeIndex, 0, latest.length - 1);
  return latest[entry.selectedChangeIndex] ?? null;
}

function buildDiffLines(entry: CockpitEntry, width: number, height: number): string[] {
  const lines: string[] = [pc.dim("Patch review"), ""];
  const latest = uniqueLatestChanges(entry.fileChanges);

  if (latest.length === 0) {
    lines.push(pc.dim("No file changes captured yet."));
    lines.push(pc.dim("When the agent edits files, they’ll show up here."));
    return tailLines(lines, height);
  }

  const visibleList = Math.max(4, Math.floor(height * 0.35));
  const list = latest.slice(0, visibleList);

  lines.push(pc.dim("Files"));
  for (const [index, change] of list.entries()) {
    const selected = index === entry.selectedChangeIndex;
    const marker = selected ? pc.cyan("›") : pc.dim(" ");
    const counts = `${change.linesAdded > 0 ? pc.green(`+${change.linesAdded}`) : ""}${change.linesRemoved > 0 ? ` ${pc.red(`-${change.linesRemoved}`)}` : ""}`.trim() || pc.dim("0");
    lines.push(`${marker} ${truncate(change.filePath, Math.max(8, width - 12))}`);
    lines.push(`  ${fit(`${pc.dim(change.operation)} ${counts}`, Math.max(1, width - 2))}`);
  }

  const selected = selectedFileChange(entry);
  if (selected) {
    lines.push("");
    lines.push(pc.dim("Focus"));
    lines.push(truncate(selected.filePath, Math.max(8, width)));
    lines.push(`${selected.operation}  ${selected.linesAdded > 0 ? `+${selected.linesAdded}` : "0"} ${selected.linesRemoved > 0 ? `-${selected.linesRemoved}` : "0"}`);
    lines.push("");
    if (selected.diffSummary) {
      lines.push(pc.dim("Patch"));
      lines.push(...renderDiffSummary(selected.diffSummary, Math.max(8, width - 2), Math.max(4, height - lines.length - 1)).map((line) => `  ${line}`));
    } else {
      lines.push(pc.dim("No stored diff summary for this change."));
    }
  }

  return tailLines(lines, height);
}

function buildTraceLines(entry: CockpitEntry, width: number, height: number): string[] {
  const lines: string[] = [
    pc.dim("Public reasoning trace"),
    pc.dim("Status, tool, and progress signals only."),
    "",
  ];

  const items = tailLines(entry.activityLog, Math.max(4, height - lines.length));
  if (items.length === 0) {
    lines.push(pc.dim("No trace yet."));
    return tailLines(lines, height);
  }

  for (const item of items) {
    const tone = activityKindTone(item.kind);
    const head = `${pc.dim(shortTime(item.at))} ${tone(activityGlyph(item.kind))} ${tone(item.kind.padEnd(8, " "))}`;
    const wrapped = wrapText(item.text, Math.max(8, width - 13));
    for (const [index, line] of wrapped.entries()) {
      lines.push(index === 0 ? `${head} ${line}` : `         ${line}`);
    }
  }

  return tailLines(lines, height);
}

function buildInspectorLines(entry: CockpitEntry, tab: InspectorTab, width: number, height: number): string[] {
  switch (tab) {
    case "ops":
      return buildOpsLines(entry, width, height);
    case "diff":
      return buildDiffLines(entry, width, height);
    case "trace":
      return buildTraceLines(entry, width, height);
    case "tools":
    default:
      return buildToolLines(entry, width, height);
  }
}

function buildHeader(width: number, entries: CockpitEntry[], selectedIndex: number, activeKey: string | null, queuedPrompt: QueuedPrompt | null, tab: InspectorTab, layoutMode: LayoutMode): string[] {
  const selected = entries[selectedIndex] ?? entries[0];
  const headerLeft = `${pc.bold(pc.cyan("NYX"))} ${pc.bold("Cockpit")} ${pc.dim("control room")}`;
  const headerRight = `${selected.label} ${pc.dim(`@${selected.agent}`)} ${pc.dim("·")} ${activeKey ? pc.cyan("live") : pc.dim("ready")} ${pc.dim("·")} ${pc.dim(tab === "trace" ? "reason" : tab)} ${pc.dim("·")} ${pc.dim(layoutLabel(layoutMode))}`;
  const lines = [joinEdge(headerLeft, headerRight, width)];
  if (queuedPrompt) {
    lines.push(fit(`${pc.yellow("queued")} ${truncate(`${queuedPrompt.entryLabel}: ${queuedPrompt.message}`, Math.max(12, width - 8))}`, width));
  }
  return lines;
}

function buildFooter(width: number, entry: CockpitEntry, activeKey: string | null, queuedPrompt: QueuedPrompt | null, layoutMode: LayoutMode): string[] {
  const streamElapsed = entry.isStreaming && entry.streamStartedAt ? duration(Date.now() - entry.streamStartedAt) : "—";
  const left = `${pc.dim("session")} ${shortSession(entry.sessionId)}  ${pc.dim("model")} ${entry.usage.model ? truncate(entry.usage.model, 24) : "server"}  ${pc.dim("tokens")} ${(entry.usage.inputTokens ?? 0).toLocaleString()}/${(entry.usage.outputTokens ?? 0).toLocaleString()}  ${pc.dim("cost")} ${formatCost(entry.costCents)}`;
  const right = activeKey ? `${pc.cyan("live")} ${pc.dim(streamElapsed)}` : pc.dim("ready");
  const hint = queuedPrompt
    ? `${pc.dim("keys")} Tab next  Ctrl+N/P owners  [ ] tabs  ↑↓ inspect  /focus ${layoutLabel(layoutMode)}  Ctrl+C interrupt`
    : `${pc.dim("keys")} Tab next  Ctrl+N/P owners  [ ] tabs  ↑↓ inspect  /focus overview  /sessions  /help`;
  return [
    joinEdge(left, right, width),
    fit(hint, width),
  ];
}

function buildComposerLines(width: number, entry: CockpitEntry, draft: string, activeKey: string | null): string[] {
  const theme = themeForEntry(entry);
  const inner = Math.max(8, width - 4);
  const status = activeKey ? pc.yellow("busy") : pc.green("ready");
  const placeholder = activeKey ? pc.dim("Type a redirect and press Enter…") : pc.dim("Type a prompt…");
  const draftLines = draft.trim() ? wrapText(draft, inner) : [placeholder];
  const border = pc.dim;
  const header = joinEdge(`${theme.avatar} ${theme.accent("compose")} ${pc.dim(`@${entry.agent}`)}`, `${status} ${pc.dim(`· ${draftLines.length}l`)}`, inner);
  const top = `${border("╭")} ${fit(header, inner)} ${border("╮")}`;
  const body = draftLines.map((line, index) => {
    const content = index === 0 && draft.trim() ? `${pc.bold(">")} ${line}` : line;
    return `${border("│")} ${fit(content, inner)} ${border("│")}`;
  });
  const footer = `${border("╰")} ${fit(pc.dim("Enter send  ·  /focus overview|chat|tools|diff|reason  ·  /new reset"), inner)} ${border("╯")}`;
  return [
    top,
    ...body,
    footer,
  ];
}

function trimComposerLines(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  if (height <= 3) return tailLines(lines, height);
  const top = lines[0]!;
  const footer = lines[lines.length - 1]!;
  const bodyHeight = height - 2;
  const body = lines.slice(1, -1);
  if (body.length <= bodyHeight) return lines.slice(0, height);
  return [top, ...tailLines(body, bodyHeight), footer];
}

function renderCenterPane(entry: CockpitEntry, width: number, height: number, draft: string, activeKey: string | null, contentLines?: string[], titleText?: string): string[] {
  const theme = themeForEntry(entry);
  const border = pc.dim;
  const innerWidth = Math.max(1, width - 2);
  const innerHeight = Math.max(1, height - 2);
  const title = titleText ?? `${theme.avatar} ${theme.accent(entry.label)} ${pc.dim(`@${entry.agent}`)}`;
  const label = ` ${truncate(title, Math.max(1, innerWidth - 1))} `;
  const top = `${border("╭")}${label}${border("─".repeat(Math.max(0, innerWidth - visibleLength(label))))}${border("╮")}`;
  const bottom = `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`;
  const side = border("│");

	const composerLines = buildComposerLines(innerWidth, entry, draft, activeKey);
	const maxComposerHeight = clamp(Math.floor(innerHeight * 0.55), 4, 12);
	const composerHeight = clamp(composerLines.length, 4, maxComposerHeight);
	const dividerHeight = 1;
	const conversationHeight = Math.max(2, innerHeight - composerHeight - dividerHeight);
	const conversation = contentLines ? tailLines(contentLines, conversationHeight) : buildConversationLines(entry, innerWidth, conversationHeight);
	const paddedConversation = [...conversation];
	while (paddedConversation.length < conversationHeight) paddedConversation.push("");

  const dividerLabel = fit(pc.dim(" conversation "), Math.max(8, Math.min(innerWidth, 18)));
  const divider = `${pc.dim("─".repeat(Math.max(0, Math.floor((innerWidth - visibleLength(dividerLabel)) / 2))))}${dividerLabel}${pc.dim("─".repeat(Math.max(0, innerWidth - Math.floor((innerWidth - visibleLength(dividerLabel)) / 2) - visibleLength(dividerLabel))))}`;
	const body = [
	    ...paddedConversation,
	    divider,
	    ...trimComposerLines(composerLines, composerHeight),
	  ];
  while (body.length < innerHeight) body.push("");

  return [top, ...body.map((line) => `${side}${fit(line, innerWidth)}${side}`), bottom].slice(0, height);
}

function buildHelpOverlay(width: number, height: number): string[] {
  const lines = [
    pc.bold("Cockpit Help"),
    "",
    "Tab    next owner",
    "Ctrl+N / Ctrl+P  next/previous owner",
    "[ ]    cycle inspector pane",
    "Up/Down  move selected tool/file in inspector",
    "Enter  send prompt",
    "Paste is multiline-safe",
    "/sessions  browse past sessions",
    "/copy  copy current context to clipboard",
    "/panel ops|tools|diff|trace",
    "/focus overview|split|chat|tools|diff|reason",
    "/help  toggle help",
    "/new  reset session",
    "/clear  clear local transcript",
    "/refresh  repoll health/runs",
    "/quit  exit",
  ];
  return renderBox(" Help ", lines, clamp(Math.floor(width * 0.46), 36, 56), clamp(height - 6, 12, 18), { border: pc.cyan });
}

function timeAgo(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  return `${duration(diff)} ago`;
}

function mergeBrowserSessions(
  entry: CockpitEntry,
  remote: SessionListResponse | null,
  localSessions: LocalSession[],
): BrowserSessionItem[] {
  const byId = new Map<string, BrowserSessionItem>();
  for (const session of remote?.sessions ?? []) {
    byId.set(session.session_id, {
      ...session,
      message_count: 0,
      localOnly: false,
      current: session.session_id === entry.sessionId,
    });
  }

  for (const local of localSessions.filter((session) => normalizeName(session.instance) === entry.key)) {
    const existing = byId.get(local.session_id);
    if (existing) {
      existing.title = existing.title || local.title || "(untitled)";
      existing.message_count = Math.max(existing.message_count, local.message_count);
      existing.total_cost_cents = Math.max(existing.total_cost_cents, local.cost_cents);
      existing.current ||= local.session_id === entry.sessionId;
      continue;
    }
    byId.set(local.session_id, {
      session_id: local.session_id,
      title: local.title ?? "(untitled)",
      agent: local.agent ?? entry.agent,
      message_count: local.message_count,
      total_cost_cents: local.cost_cents,
      created_at: local.created_at,
      updated_at: local.updated_at,
      localOnly: true,
      current: local.session_id === entry.sessionId,
    });
  }

  return [...byId.values()].sort((a, b) => b.updated_at - a.updated_at);
}

function sessionPreviewLines(detail: SessionDetailResponse | null, width: number, loading: boolean, error?: string): string[] {
  if (loading) return [pc.dim("Loading session preview…")];
  if (error) return wrapText(error, Math.max(8, width));
  if (!detail) return [pc.dim("Select a session to preview it.")];
  const lines: string[] = [
    pc.bold(detail.title || "(untitled)"),
    `${pc.dim("agent")} ${detail.agent ?? "unknown"}  ${pc.dim("turns")} ${detail.message_count}  ${pc.dim("cost")} ${formatCost(detail.total_cost_cents)}`,
    `${pc.dim("updated")} ${timeAgo(detail.updated_at)}`,
    "",
  ];
  const recent = detail.messages.slice(-6);
  for (const message of recent) {
    const label = message.role === "assistant" ? pc.cyan("assistant") : message.role === "user" ? pc.white("you") : pc.yellow("system");
    lines.push(`${label} ${pc.dim(shortTime(message.created_at))}`);
    lines.push(...wrapText(message.content || "", Math.max(8, width)).slice(0, 3).map((line) => `  ${line}`));
    lines.push("");
  }
  return lines;
}

function buildSessionsOverlay(
  width: number,
  height: number,
  entry: CockpitEntry,
  items: BrowserSessionItem[],
  selectedIndex: number,
  detail: SessionDetailResponse | null,
  loadingList: boolean,
  loadingDetail: boolean,
  error?: string,
): string[] {
  const overlayWidth = clamp(Math.floor(width * 0.78), 80, 120);
  const overlayHeight = clamp(Math.floor(height * 0.78), 18, 30);
  const innerWidth = Math.max(1, overlayWidth - 2);
  const innerHeight = Math.max(1, overlayHeight - 2);
  const listWidth = clamp(Math.floor(innerWidth * 0.38), 26, 40);
  const detailWidth = innerWidth - listWidth - 1;
  const listHeight = innerHeight - 3;
  const detailHeight = innerHeight - 3;
  const lines: string[] = [];
  const header = joinEdge(
    `${pc.bold("Sessions")} ${pc.dim(`for ${entry.label}`)}`,
    pc.dim("Enter resume  d delete  u undo  c copy  Esc close"),
    innerWidth,
  );
  lines.push(header, "");

  const listLines: string[] = [];
  if (loadingList) {
    listLines.push(pc.dim("Loading sessions…"));
  } else if (items.length === 0) {
    listLines.push(pc.dim("No saved sessions."));
  } else {
    for (const [index, item] of items.slice(0, listHeight - 1).entries()) {
      const selected = index === selectedIndex;
      const marker = selected ? pc.cyan("›") : pc.dim(" ");
      const meta = `${item.current ? pc.green("current") : item.localOnly ? pc.yellow("local") : pc.dim("remote")} ${pc.dim("·")} ${formatCost(item.total_cost_cents)}`;
      listLines.push(`${marker} ${truncate(item.title || "(untitled)", Math.max(12, listWidth - 4))}`);
      listLines.push(`  ${fit(`${pc.dim(item.session_id.slice(0, 8))} ${pc.dim("·")} ${meta}`, Math.max(1, listWidth - 2))}`);
    }
  }

  const previewLines = sessionPreviewLines(detail, detailWidth, loadingDetail, error);
  const leftBox = renderBox(" history ", listLines, listWidth, listHeight, { border: pc.dim });
  const rightBox = renderBox(" preview ", previewLines, detailWidth, detailHeight, { border: pc.dim, tail: true });
  for (let i = 0; i < Math.max(leftBox.length, rightBox.length); i++) {
    lines.push(`${leftBox[i] ?? " ".repeat(listWidth)}${pc.dim("│")}${rightBox[i] ?? " ".repeat(detailWidth)}`);
  }
  lines.push("");
  lines.push(pc.dim("Remote sessions are live from the selected instance. Delete removes remote + local cache."));

  return renderBox(" Session Browser ", lines, overlayWidth, overlayHeight, { border: pc.cyan });
}

function copyToClipboard(text: string): string | null {
  const value = text.trim();
  if (!value) return "Nothing to copy.";
  const result = Bun.spawnSync(["pbcopy"], {
    stdin: Buffer.from(value),
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return null;
  const error = result.stderr.toString().trim();
  return error || "pbcopy failed.";
}

function copyableSelection(entry: CockpitEntry, tab: InspectorTab): string {
  if (tab === "diff") {
    const change = selectedFileChange(entry);
    return change ? `${change.filePath}\n\n${change.diffSummary ?? ""}` : "";
  }
  if (tab === "tools") {
    const item = selectedRuntimeItem(entry);
    if (!item) return "";
    return [
      item.title,
      item.subtitle ?? "",
      item.command ?? "",
      item.outputPreview ?? item.details ?? "",
    ].filter(Boolean).join("\n\n");
  }
  if (tab === "trace") {
    return entry.activityLog.map((item) => `[${shortTime(item.at)}] ${item.kind}: ${item.text}`).join("\n");
  }
  const assistant = [...entry.messages].reverse().find((message) => message.role === "assistant");
  return assistant?.content ?? "";
}

function deleteDraftLine(draft: string): string {
  if (!draft) return "";
  const normalized = draft.replace(/\r/g, "");
  const lastNewline = normalized.lastIndexOf("\n");
  if (lastNewline === -1) return "";
  return normalized.slice(0, lastNewline + 1);
}

async function tryCreateSession(instance: InstanceConfig, agent: string): Promise<string | null> {
  try {
    const data = await api<SessionCreateResponse>(instance, "/api/sessions", {
      method: "POST",
      body: { agent },
      timeout: 5_000,
    });
    return data.session_id ?? null;
  } catch {
    return null;
  }
}

async function tryGetSessionSummary(instance: InstanceConfig, sessionId: string): Promise<SessionSummaryResponse | null> {
  try {
    return await api<SessionSummaryResponse>(instance, `/api/sessions/${sessionId}`, { timeout: 5_000 });
  } catch {
    return null;
  }
}

async function tryListRemoteSessions(instance: InstanceConfig, limit = 30): Promise<SessionListResponse | null> {
  try {
    return await api<SessionListResponse>(instance, `/api/sessions?limit=${limit}`, { timeout: 6_000 });
  } catch {
    return null;
  }
}

async function tryGetSessionDetail(instance: InstanceConfig, sessionId: string): Promise<SessionDetailResponse | null> {
  try {
    return await api<SessionDetailResponse>(instance, `/api/sessions/${sessionId}`, { timeout: 8_000 });
  } catch {
    return null;
  }
}

async function tryDeleteRemoteSession(instance: InstanceConfig, sessionId: string): Promise<boolean> {
  try {
    const result = await api<{ deleted?: boolean }>(instance, `/api/sessions/${sessionId}`, {
      method: "DELETE",
      timeout: 6_000,
    });
    return result.deleted === true;
  } catch {
    return false;
  }
}

async function tryUndoRemoteSession(instance: InstanceConfig, sessionId: string): Promise<number | null> {
  try {
    const result = await api<{ deleted?: number }>(instance, `/api/sessions/${sessionId}/undo`, {
      method: "POST",
      timeout: 6_000,
    });
    return typeof result.deleted === "number" ? result.deleted : null;
  } catch {
    return null;
  }
}

function applySessionDetail(entry: CockpitEntry, detail: SessionDetailResponse): void {
  entry.sessionId = detail.session_id;
  entry.sessionTitle = detail.title;
  entry.messageCount = detail.message_count;
  entry.costCents = detail.total_cost_cents;
  entry.messages = detail.messages.map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.created_at,
  }));
  entry.runtimeItems = [];
  entry.fileChanges = [];
  entry.activity = "resumed";
}

async function primeSession(entry: CockpitEntry, savedSessions: LocalSession[]): Promise<void> {
  const existing = savedSessions.find((session) => normalizeName(session.instance) === entry.key);
  if (!existing) {
    entry.sessionId = null;
    return;
  }
  const summary = await tryGetSessionSummary(entry.instance, existing.session_id);
  if (!summary) {
    entry.sessionId = null;
    return;
  }
  entry.sessionId = summary.session_id;
  entry.sessionTitle = summary.title;
  entry.messageCount = summary.message_count;
  entry.costCents = summary.total_cost_cents;
}

async function refreshEntry(entry: CockpitEntry): Promise<void> {
  const [healthResult, infoResult, runsResult] = await Promise.allSettled([
    api<HealthResponse>(entry.instance, "/health", { timeout: 4_000 }),
    api<InfoResponse>(entry.instance, "/api/info", { timeout: 4_000 }),
    api<RunSummary[]>(entry.instance, "/api/runs?limit=6", { timeout: 4_000 }),
  ]);

  if (healthResult.status === "fulfilled") {
    entry.health = healthResult.value;
    entry.lastError = undefined;
  } else {
    entry.health = null;
    entry.lastError = healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason);
  }

  if (infoResult.status === "fulfilled") {
    const info = infoResult.value;
    entry.label = info.name?.trim() || entry.label;
    entry.agent = pickLeadAgent(info, entry.health, entry.agent);
  }

  entry.runs = runsResult.status === "fulfilled" ? runsResult.value : [];
}

async function persistEntrySession(entry: CockpitEntry): Promise<void> {
  if (!entry.sessionId) return;
  await saveSession({
    session_id: entry.sessionId,
    instance: entry.key,
    host: entry.instance.host ?? `http://localhost:${entry.instance.port}`,
    agent: entry.agent,
    created_at: Date.now(),
    updated_at: Date.now(),
    message_count: entry.messageCount,
    title: entry.sessionTitle,
    cost_cents: entry.costCents,
  }).catch(() => {});
}

function runtimeItemFromEvent(event: SSEEvent): RuntimeItem | null {
  if (event.type !== "execution:event") return null;
  const kind = typeof event.kind === "string" ? event.kind : "status";
  const phase = typeof event.phase === "string" ? event.phase : "started";
  if (!["command", "file_change", "mcp_tool", "web_search", "status", "agent_message"].includes(kind)) return null;
  if (!["started", "updated", "completed", "failed"].includes(phase)) return null;
  return {
    id: typeof event.id === "string" ? event.id : `${kind}:${Date.now()}`,
    kind: kind as RuntimeItemKind,
    phase: phase as RuntimePhase,
    title: typeof event.title === "string" ? event.title : kind,
    subtitle: typeof event.subtitle === "string" ? event.subtitle : undefined,
    details: typeof event.details === "string" ? event.details : undefined,
    command: typeof event.command === "string" ? event.command : undefined,
    outputPreview: typeof event.outputPreview === "string" ? event.outputPreview : undefined,
    exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
    changes: Array.isArray(event.changes)
      ? event.changes
        .filter((change): change is RuntimeChange =>
          typeof change === "object"
          && change !== null
          && typeof (change as Record<string, unknown>).path === "string"
          && typeof (change as Record<string, unknown>).kind === "string")
        .map((change) => ({
          path: change.path,
          kind: change.kind,
        }))
      : undefined,
    timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
  };
}

export default defineCommand({
  meta: { name: "cockpit", description: "Fullscreen command center for direct repo leads" },
  args: {
    all: { type: "boolean", description: "Include hidden or gateway instances, including legacy aliases" },
  },
  async run({ args }) {
    if (!stdin.isTTY || !stdout.isTTY) {
      console.error("nyx cockpit requires an interactive TTY.");
      process.exit(1);
    }

    const instances = preferredCockpitInstances(await loadInstances(), !!args.all);
    if (instances.length === 0) {
      console.error("No instances found. Run `nyx config init` first.");
      process.exit(1);
    }

    const savedSessions = await listSessions();
    const entries: CockpitEntry[] = instances.map((instance) => ({
      key: normalizeName(instance.name),
      label: titleCase(instance.name),
      instance,
      agent: normalizeName(instance.name),
      health: null,
      runs: [],
      sessionId: null,
      messageCount: 0,
      costCents: 0,
      messages: [],
      activity: "",
      activityLog: [],
      runtimeItems: [],
      fileChanges: [],
      isStreaming: false,
      usage: {},
      selectedRuntimeIndex: 0,
      selectedChangeIndex: 0,
    }));

    await Promise.all(entries.map(async (entry) => {
      await refreshEntry(entry);
      await primeSession(entry, savedSessions);
      pushActivity(entry, "system", `ready on ${entry.instance.host ?? `localhost:${entry.instance.port}`}`);
    }));

	    let selectedIndex = clamp(entries.findIndex((entry) => entry.key === "nyxai"), 0, entries.length - 1);
	    let draft = "";
	    let activeStreamKey: string | null = null;
	    let queuedPrompt: QueuedPrompt | null = null;
	    let inspectorTab: InspectorTab = "tools";
	    let layoutMode: LayoutMode = "split";
	    let showHelp = false;
	    let showSessions = false;
	    let sessionItems: BrowserSessionItem[] = [];
	    let sessionIndex = 0;
	    let sessionPreview: SessionDetailResponse | null = null;
	    let sessionListLoading = false;
	    let sessionPreviewLoading = false;
	    let sessionError: string | undefined;
	    let shuttingDown = false;
	    let renderTimer: ReturnType<typeof setTimeout> | null = null;
	    let activeAbort: AbortController | null = null;
	    let pasteMode = false;
	    const senderId = `nyx-cockpit:${randomUUID()}`;
	    const rawInput = stdin as NodeJS.ReadStream & { setRawMode?: (value: boolean) => void };

    function selectedEntry(): CockpitEntry {
      return entries[selectedIndex] ?? entries[0];
    }

    function cycleTab(direction: 1 | -1): void {
      const index = INSPECTOR_TABS.indexOf(inspectorTab);
      inspectorTab = INSPECTOR_TABS[(index + direction + INSPECTOR_TABS.length) % INSPECTOR_TABS.length]!;
    }

	    function moveSelection(direction: 1 | -1): void {
	      const entry = selectedEntry();
	      if (inspectorTab === "tools" && entry.runtimeItems.length > 0) {
	        entry.selectedRuntimeIndex = clamp(entry.selectedRuntimeIndex + direction, 0, entry.runtimeItems.length - 1);
	      } else if (inspectorTab === "diff") {
	        const latest = uniqueLatestChanges(entry.fileChanges);
	        if (latest.length > 0) entry.selectedChangeIndex = clamp(entry.selectedChangeIndex + direction, 0, latest.length - 1);
	      }
	    }

	    function setLayoutMode(next: LayoutMode): void {
	      layoutMode = next;
	      if (next === "diff") inspectorTab = "diff";
	      if (next === "tools") inspectorTab = "tools";
	      if (next === "reason") inspectorTab = "trace";
	    }

	    function requestRender() {
      if (shuttingDown || renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        render();
      }, 24);
    }

	    function render() {
	      if (shuttingDown) return;
	      const width = Math.max(stdout.columns || 120, 100);
	      const height = Math.max(stdout.rows || 32, 22);
	      const selected = selectedEntry();
	      const wideInspector = layoutMode === "diff" || layoutMode === "tools" || layoutMode === "reason";
	      let leftWidth = layoutMode === "chat" ? clamp(Math.floor(width * 0.17), 20, 24) : clamp(Math.floor(width * 0.19), 20, 25);
	      let rightWidth = layoutMode === "chat"
	        ? clamp(Math.floor(width * 0.22), 26, 32)
	        : wideInspector
	          ? clamp(Math.floor(width * 0.4), 42, 60)
	          : clamp(Math.floor(width * 0.3), 30, 40);
	      let centerWidth = width - leftWidth - rightWidth - 2;
	      const minCenterWidth = wideInspector ? 32 : layoutMode === "overview" ? 44 : 40;
	      if (centerWidth < minCenterWidth) {
	        const deficit = minCenterWidth - centerWidth;
	        leftWidth = Math.max(22, leftWidth - Math.ceil(deficit / 2));
	        rightWidth = Math.max(30, rightWidth - Math.floor(deficit / 2));
	        centerWidth = width - leftWidth - rightWidth - 2;
	      }

	      const headerLines = buildHeader(width, entries, selectedIndex, activeStreamKey, queuedPrompt, inspectorTab, layoutMode);
	      const footerLines = buildFooter(width, selected, activeStreamKey, queuedPrompt, layoutMode);
	      const chromeHeight = headerLines.length + footerLines.length + 2;
	      const contentHeight = Math.max(12, height - chromeHeight);
	      const leftBox = renderBox(
	        `${pc.bold("fleet")}`,
	        buildInstanceLines(entries, selectedIndex, activeStreamKey, leftWidth - 2),
	        leftWidth,
        contentHeight,
        { border: pc.dim },
      );
	      const centerBox = renderCenterPane(
	        selected,
	        centerWidth,
	        contentHeight,
	        draft,
	        activeStreamKey,
	        layoutMode === "overview" ? buildOverviewLines(entries, selectedIndex, centerWidth - 2, Math.max(4, contentHeight - 8)) : undefined,
	        layoutMode === "overview" ? `${pc.bold("overview")} ${pc.dim("fleet + selected lane")}` : undefined,
	      );
	      const rightBox = renderBox(
	        inspectorTitle(inspectorTab, selected),
	        buildInspectorLines(selected, inspectorTab, rightWidth - 2, contentHeight - 2),
	        rightWidth,
        contentHeight,
        { border: pc.dim },
      );

      const sep = pc.dim("│");
      const outputLines: string[] = [...headerLines, ""];
	      for (let index = 0; index < contentHeight; index++) {
	        outputLines.push(`${leftBox[index] ?? " ".repeat(leftWidth)}${sep}${centerBox[index] ?? " ".repeat(centerWidth)}${sep}${rightBox[index] ?? " ".repeat(rightWidth)}`);
	      }
	      outputLines.push("");
	      outputLines.push(...footerLines);

	      stdout.write("\x1b[H");
	      stdout.write(outputLines.join("\n"));
	      if (showHelp) {
	        const overlay = buildHelpOverlay(width, height);
        const x = Math.max(1, Math.floor((width - visibleLength(stripAnsi(overlay[0] ?? ""))) / 2));
        const y = Math.max(3, Math.floor((height - overlay.length) / 2));
        overlay.forEach((line, index) => {
	          stdout.write(`\x1b[${y + index};${x}H${line}`);
	        });
	      }
	      if (showSessions) {
	        const overlay = buildSessionsOverlay(
	          width,
	          height,
	          selected,
	          sessionItems,
	          sessionIndex,
	          sessionPreview,
	          sessionListLoading,
	          sessionPreviewLoading,
	          sessionError,
	        );
	        const x = Math.max(1, Math.floor((width - visibleLength(stripAnsi(overlay[0] ?? ""))) / 2));
	        const y = Math.max(2, Math.floor((height - overlay.length) / 2));
	        overlay.forEach((line, index) => {
	          stdout.write(`\x1b[${y + index};${x}H${line}`);
	        });
	      }
	      stdout.write("\x1b[J");
	    }

	    async function fullRefresh() {
	      await Promise.all(entries.map((entry) => refreshEntry(entry)));
	      requestRender();
	    }

	    async function loadSessionPreview(entry: CockpitEntry): Promise<void> {
	      const current = sessionItems[sessionIndex];
	      if (!current) {
	        sessionPreview = null;
	        sessionPreviewLoading = false;
	        sessionError = undefined;
	        requestRender();
	        return;
	      }
	      sessionPreviewLoading = true;
	      sessionError = undefined;
	      requestRender();
	      const detail = await tryGetSessionDetail(entry.instance, current.session_id);
	      if (!showSessions || sessionItems[sessionIndex]?.session_id !== current.session_id) return;
	      sessionPreviewLoading = false;
	      if (!detail) {
	        sessionPreview = null;
	        sessionError = "Could not load session preview from the remote instance.";
	        requestRender();
	        return;
	      }
	      sessionPreview = detail;
	      requestRender();
	    }

	    async function openSessionBrowser(): Promise<void> {
	      const entry = selectedEntry();
	      showSessions = true;
	      sessionListLoading = true;
	      sessionPreviewLoading = false;
	      sessionPreview = null;
	      sessionItems = [];
	      sessionIndex = 0;
	      sessionError = undefined;
	      requestRender();
	      const [remote, local] = await Promise.all([
	        tryListRemoteSessions(entry.instance, 30),
	        listSessions(),
	      ]);
	      sessionItems = mergeBrowserSessions(entry, remote, local);
	      const currentIndex = sessionItems.findIndex((item) => item.current);
	      sessionIndex = currentIndex >= 0 ? currentIndex : 0;
	      sessionListLoading = false;
	      if (sessionItems.length === 0) {
	        sessionPreview = null;
	        requestRender();
	        return;
	      }
	      await loadSessionPreview(entry);
	    }

	    async function resumeSelectedSession(): Promise<void> {
	      const entry = selectedEntry();
	      const current = sessionItems[sessionIndex];
	      if (!current) return;
	      const detail = sessionPreview?.session_id === current.session_id ? sessionPreview : await tryGetSessionDetail(entry.instance, current.session_id);
	      if (!detail) {
	        sessionError = "Could not resume session.";
	        requestRender();
	        return;
	      }
	      applySessionDetail(entry, detail);
	      await persistEntrySession(entry);
	      pushActivity(entry, "system", `resumed session ${shortSession(detail.session_id)}`);
	      showSessions = false;
	      requestRender();
	    }

	    async function deleteSelectedSessionEntry(): Promise<void> {
	      const entry = selectedEntry();
	      const current = sessionItems[sessionIndex];
	      if (!current) return;
	      sessionError = undefined;
	      requestRender();
	      const remoteDeleted = current.localOnly ? true : await tryDeleteRemoteSession(entry.instance, current.session_id);
	      if (!remoteDeleted) {
	        sessionError = "Remote delete failed.";
	        requestRender();
	        return;
	      }
	      await deleteSession(current.session_id).catch(() => {});
	      if (entry.sessionId === current.session_id) {
	        entry.sessionId = null;
	        entry.sessionTitle = undefined;
	        entry.messageCount = 0;
	        entry.costCents = 0;
	        entry.messages = [];
	        entry.runtimeItems = [];
	        entry.fileChanges = [];
	        entry.activity = "session deleted";
	      }
	      pushActivity(entry, "system", `deleted session ${shortSession(current.session_id)}`);
	      await openSessionBrowser();
	    }

	    async function undoSelectedSessionTurn(): Promise<void> {
	      const entry = selectedEntry();
	      const current = sessionItems[sessionIndex];
	      if (!current || current.localOnly) return;
	      const deleted = await tryUndoRemoteSession(entry.instance, current.session_id);
	      if (!deleted) {
	        sessionError = "Undo failed.";
	        requestRender();
	        return;
	      }
	      pushActivity(entry, "system", `undid ${deleted} message${deleted === 1 ? "" : "s"} in ${shortSession(current.session_id)}`);
	      await loadSessionPreview(entry);
	      if (entry.sessionId === current.session_id && sessionPreview) {
	        applySessionDetail(entry, sessionPreview);
	        await persistEntrySession(entry);
	      }
	    }

    async function ensureSession(entry: CockpitEntry): Promise<string | null> {
      if (entry.sessionId) {
        const summary = await tryGetSessionSummary(entry.instance, entry.sessionId);
        if (summary) {
          entry.messageCount = summary.message_count;
          entry.costCents = summary.total_cost_cents;
          entry.sessionTitle = summary.title;
          return entry.sessionId;
        }
        entry.sessionId = null;
      }

      const sessionId = await tryCreateSession(entry.instance, entry.agent);
      entry.sessionId = sessionId;
      entry.messageCount = 0;
      entry.costCents = 0;
      entry.sessionTitle = undefined;
      if (sessionId) {
        pushActivity(entry, "system", `opened session ${shortSession(sessionId)}`);
        await persistEntrySession(entry);
      }
      return sessionId;
    }

    async function flushQueuedPrompt() {
      if (activeStreamKey || !queuedPrompt) return;
      const next = queuedPrompt;
      queuedPrompt = null;
      const target = entries.find((entry) => entry.key === next.entryKey);
      if (target) await executePrompt(target, next.message);
    }

    async function executePrompt(entry: CockpitEntry, message: string) {
      if (!message.trim()) return;

      entry.messages.push({ role: "user", content: message, timestamp: Date.now() });
      entry.messages.push({ role: "assistant", content: "", timestamp: Date.now(), streaming: true });
      entry.activity = "starting";
      entry.isStreaming = true;
      entry.streamStartedAt = Date.now();
      activeStreamKey = entry.key;
      activeAbort = new AbortController();
      pushActivity(entry, "status", "stream opened");
      requestRender();

      const sessionId = await ensureSession(entry);
      const provider = new NyxHiveProvider({
        host: entry.instance.host ?? `http://localhost:${entry.instance.port}`,
        apiKey: entry.instance.apiKey,
        instanceName: entry.label,
      });
      const assistant = entry.messages[entry.messages.length - 1]!;

      try {
        for await (const event of provider.stream(message, {
          sessionId: sessionId ?? undefined,
          agent: entry.agent,
          sender: "nyx-cockpit",
          senderId,
          signal: activeAbort.signal,
        })) {
          handleStreamEvent(entry, assistant, event);
          requestRender();
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        const interrupted = activeAbort.signal.aborted;
        assistant.streaming = false;
        if (interrupted) {
          assistant.content = assistant.content || "[interrupted]";
          entry.activity = "interrupted";
          pushActivity(entry, "system", "stream interrupted");
        } else {
          assistant.content = assistant.content || `Error: ${errorText}`;
          entry.activity = "error";
          entry.lastError = errorText;
          pushActivity(entry, "error", errorText);
        }
      } finally {
        assistant.streaming = false;
        entry.isStreaming = false;
        entry.streamStartedAt = undefined;
        activeStreamKey = null;
        activeAbort = null;
        await persistEntrySession(entry);
        await refreshEntry(entry);
        requestRender();
        await flushQueuedPrompt();
      }
    }

    function queueOrInterruptPrompt(message: string): void {
      const selected = selectedEntry();
      if (!message.trim()) {
        requestRender();
        return;
      }
      if (activeStreamKey && activeAbort) {
        queuedPrompt = { entryKey: selected.key, entryLabel: selected.label, message };
        pushActivity(selected, "system", `queued redirect: ${truncate(message, 44)}`);
        selected.activity = "interrupting";
        activeAbort.abort(new Error("Interrupted by new prompt"));
        requestRender();
        return;
      }
      void executePrompt(selected, message);
    }

    function handleStreamEvent(entry: CockpitEntry, assistant: ChatMessage, event: SSEEvent): void {
      const runtimeItem = runtimeItemFromEvent(event);
      if (runtimeItem) {
        upsertRuntimeItem(entry, runtimeItem);
        recordFileChanges(entry, runtimeItem);
        entry.activity = summarizeRuntimeItem(runtimeItem);
        pushActivity(entry, runtimeItem.kind === "file_change" ? "tool" : runtimeItem.phase === "failed" ? "error" : "tool", `${runtimeItem.title}${runtimeItem.subtitle ? ` · ${runtimeItem.subtitle}` : ""}`);
        return;
      }

      if (event.type === "token" && typeof event.text === "string") {
        if (assistant.streamMode === "delta") return;
        assistant.streamMode = "token";
        assistant.content += event.text;
        entry.activity = "responding";
        return;
      }

      if (event.type === "response:delta") {
        assistant.streamMode = "delta";
        if (typeof event.text_so_far === "string") {
          assistant.content = event.text_so_far;
        } else if (typeof event.text_delta === "string") {
          assistant.content += event.text_delta;
        }
        entry.activity = "responding";
        return;
      }

      if (event.type === "response" && typeof event.response === "string") {
        assistant.content = event.response;
        assistant.streaming = false;
        assistant.streamMode = undefined;
        if (typeof event.cost_cents === "number") entry.costCents += event.cost_cents;
        entry.messageCount += 1;
        entry.activity = "done";
        entry.lastResponseAt = Date.now();
        pushActivity(entry, "response", `response finished in ${duration(Date.now() - (entry.streamStartedAt ?? Date.now()))}`);
        return;
      }

      if (event.type === "response:complete") {
        if (typeof event.tokens_in === "number") entry.usage.inputTokens = event.tokens_in;
        if (typeof event.tokens_out === "number") entry.usage.outputTokens = event.tokens_out;
        if (typeof event.duration_ms === "number") entry.usage.elapsedMs = event.duration_ms;
        return;
      }

      if (event.type === "usage") {
        entry.usage.model = typeof event.model === "string" ? event.model : entry.usage.model;
        entry.usage.inputTokens = typeof event.input_tokens === "number" ? event.input_tokens : entry.usage.inputTokens;
        entry.usage.outputTokens = typeof event.output_tokens === "number" ? event.output_tokens : entry.usage.outputTokens;
        return;
      }

      if (event.type === "agent:progress") {
        if (typeof event.tokensIn === "number") entry.usage.inputTokens = event.tokensIn;
        if (typeof event.tokensOut === "number") entry.usage.outputTokens = event.tokensOut;
        if (typeof event.elapsed === "number") entry.usage.elapsedMs = Math.round(event.elapsed * 1000);
        if (typeof event.activity === "string" && event.activity.trim()) {
          entry.activity = event.activity;
          pushActivity(entry, "reason", event.activity);
        }
        return;
      }

      if (event.type === "agent:status") {
        const next = typeof event.task === "string" ? event.task : String(event.status ?? "working");
        entry.activity = next;
        pushActivity(entry, "status", next);
        return;
      }

      if (event.type === "trace:tool_use" && typeof event.tool === "string") {
        entry.activity = event.tool;
        pushActivity(entry, "reason", event.tool);
        return;
      }

      if (event.type === "tool:start" && typeof event.tool === "string") {
        entry.activity = event.tool;
        const details = typeof event.input === "string" ? `${event.tool} ${event.input}` : event.tool;
        pushActivity(entry, "tool", details);
        return;
      }

      if (event.type === "error") {
        const errorText = String(event.error ?? "Unknown error");
        assistant.content = `Error: ${errorText}`;
        assistant.streaming = false;
        entry.activity = "error";
        entry.lastError = errorText;
        pushActivity(entry, "error", errorText);
      }
    }

    async function handleCommand(commandLine: string): Promise<void> {
      const [command, ...rest] = commandLine.trim().split(/\s+/);
      const selected = selectedEntry();

      switch (command) {
        case "/quit":
        case "/exit":
          cleanup(0);
          return;
        case "/refresh":
          await fullRefresh();
          return;
        case "/new":
        case "/reset":
          selected.sessionId = await tryCreateSession(selected.instance, selected.agent);
          selected.messages = [];
          selected.activity = "new session";
          selected.messageCount = 0;
          selected.costCents = 0;
          selected.runtimeItems = [];
          selected.fileChanges = [];
          selected.activityLog = [];
          pushActivity(selected, "system", `new session ${shortSession(selected.sessionId)}`);
          await persistEntrySession(selected);
          requestRender();
          return;
        case "/clear":
          selected.messages = [];
          selected.activity = "";
          selected.lastError = undefined;
          pushActivity(selected, "system", "cleared local transcript");
          requestRender();
          return;
        case "/switch": {
          const target = normalizeName(rest.join(" "));
          const idx = entries.findIndex((entry) => entry.key === target || normalizeName(entry.label) === target);
          if (idx >= 0) selectedIndex = idx;
          requestRender();
          return;
        }
	        case "/panel":
	        case "/view": {
	          const next = normalizeName(rest.join(" "));
	          if (next === "ops" || next === "tools" || next === "diff" || next === "trace" || next === "reason") {
	            inspectorTab = next === "reason" ? "trace" : next;
	          }
	          requestRender();
	          return;
	        }
	        case "/focus": {
	          const next = normalizeName(rest.join(" "));
	          if (next === "overview" || next === "split" || next === "chat" || next === "tools" || next === "diff" || next === "reason") {
	            setLayoutMode(next as LayoutMode);
	          } else {
	            selected.messages.push({
	              role: "system",
	              content: "Usage: /focus overview|split|chat|tools|diff|reason",
	              timestamp: Date.now(),
	            });
	          }
	          requestRender();
	          return;
	        }
	        case "/help":
	          showHelp = !showHelp;
	          requestRender();
	          return;
	        case "/sessions":
	          await openSessionBrowser();
	          return;
	        case "/copy": {
	          const text = copyableSelection(selected, inspectorTab);
	          const error = copyToClipboard(text);
	          selected.messages.push({
	            role: "system",
	            content: error ? `Clipboard error: ${error}` : "Copied current context to clipboard.",
	            timestamp: Date.now(),
	          });
	          requestRender();
	          return;
	        }
	        default:
	          selected.messages.push({
	            role: "system",
            content: `Unknown command: ${command}`,
            timestamp: Date.now(),
          });
          requestRender();
      }
    }

	    function cleanup(code = 0): void {
	      if (shuttingDown) return;
	      shuttingDown = true;
	      if (renderTimer) clearTimeout(renderTimer);
	      clearInterval(refreshTimer);
	      stdin.removeListener("keypress", onKeypress);
	      if (activeAbort && !activeAbort.signal.aborted) activeAbort.abort(new Error("cockpit closed"));
	      if (rawInput.setRawMode) rawInput.setRawMode(false);
	      stdout.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
	      process.exit(code);
	    }

	    async function onKeypress(str: string, key: Key): Promise<void> {
	      if (key.name === "paste-start") {
	        pasteMode = true;
	        requestRender();
	        return;
	      }

	      if (key.name === "paste-end") {
	        pasteMode = false;
	        requestRender();
	        return;
	      }

	      if (pasteMode) {
	        if (str) {
	          draft += str === "\r" ? "\n" : str;
	          requestRender();
	        }
	        return;
	      }

	      if (key.ctrl && key.name === "c") {
	        if (activeAbort && activeStreamKey) {
	          activeAbort.abort(new Error("Interrupted by user"));
	          requestRender();
	          return;
        }
	        cleanup(0);
	        return;
	      }

	      if (showSessions) {
	        const current = sessionItems[sessionIndex];
	        if (key.name === "escape") {
	          showSessions = false;
	          sessionError = undefined;
	          requestRender();
	          return;
	        }
	        if (key.name === "up") {
	          sessionIndex = clamp(sessionIndex - 1, 0, Math.max(0, sessionItems.length - 1));
	          void loadSessionPreview(selectedEntry());
	          requestRender();
	          return;
	        }
	        if (key.name === "down") {
	          sessionIndex = clamp(sessionIndex + 1, 0, Math.max(0, sessionItems.length - 1));
	          void loadSessionPreview(selectedEntry());
	          requestRender();
	          return;
	        }
	        if (key.name === "return") {
	          await resumeSelectedSession();
	          return;
	        }
	        if (str === "d") {
	          await deleteSelectedSessionEntry();
	          return;
	        }
	        if (str === "u" && current && !current.localOnly) {
	          await undoSelectedSessionTurn();
	          return;
	        }
	        if (str === "c") {
	          const previewText = sessionPreview
	            ? sessionPreview.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n")
	            : current ? `${current.title}\n${current.session_id}` : "";
	          const error = copyToClipboard(previewText);
	          sessionError = error ? `Clipboard error: ${error}` : undefined;
	          requestRender();
	          return;
	        }
	        return;
	      }

	      if (key.name === "tab") {
	        selectedIndex = (selectedIndex + 1) % entries.length;
	        requestRender();
        return;
      }

      if (key.name === "up") {
        moveSelection(-1);
        requestRender();
        return;
      }

      if (key.name === "down") {
        moveSelection(1);
        requestRender();
        return;
      }

      if (key.name === "return") {
        const line = draft;
        draft = "";
        if (line.trim().startsWith("/")) await handleCommand(line);
        else queueOrInterruptPrompt(line);
        requestRender();
        return;
      }

	      if (key.name === "backspace") {
	        if (key.meta) {
	          draft = deleteDraftLine(draft);
	          requestRender();
	          return;
	        }
	        draft = draft.slice(0, -1);
	        requestRender();
	        return;
	      }

	      if (key.name === "escape") {
	        draft = "";
	        queuedPrompt = null;
	        showHelp = false;
	        requestRender();
        return;
      }

      if (key.ctrl && key.name === "l") {
        await fullRefresh();
        return;
      }

      if (key.ctrl && key.name === "o") {
        setLayoutMode("overview");
        requestRender();
        return;
      }

      if (key.ctrl && key.name === "t") {
        setLayoutMode("tools");
        requestRender();
        return;
      }

      if (key.ctrl && key.name === "r") {
        setLayoutMode("reason");
        requestRender();
        return;
      }

      if (key.ctrl && key.name === "g") {
        setLayoutMode("chat");
        requestRender();
        return;
      }

      if (key.ctrl && key.name === "f") {
        setLayoutMode("diff");
        requestRender();
        return;
      }

      if (key.ctrl && key.name === "n") {
        selectedIndex = (selectedIndex + 1) % entries.length;
        requestRender();
        return;
      }

      if (key.ctrl && key.name === "p") {
        selectedIndex = (selectedIndex - 1 + entries.length) % entries.length;
        requestRender();
        return;
      }

      if (str === "[") {
        cycleTab(-1);
        requestRender();
        return;
      }

      if (str === "]") {
        cycleTab(1);
        requestRender();
        return;
      }

      if (!key.ctrl && !key.meta && str) {
        draft += str;
        requestRender();
      }
    }

	    emitKeypressEvents(stdin);
	    if (rawInput.setRawMode) rawInput.setRawMode(true);
	    stdin.on("keypress", onKeypress);

    const refreshTimer = setInterval(() => {
      void fullRefresh();
    }, 15_000);

    process.on("SIGTERM", () => cleanup(0));
    process.on("SIGINT", () => cleanup(0));

	    stdout.write("\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[H\x1b[?25l");
	    render();
  },
});
