import { defineCommand } from "citty";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import pc from "picocolors";
import { defaultInstance, getInstance } from "../lib/config.js";
import { renderMarkdown } from "../lib/markdown.js";
import { NYX_VERSION } from "../lib/version.js";
import {
  saveSession,
  loadLastSession,
  loadSession,
  listSessions,
  type LocalSession,
} from "../lib/sessions.js";
import {
  NyxSpinner,
  setSkin,
  getSkin,
  listSkins,
  renderStatusBar,
  renderToolCall,
  cycleVerbosity,
  getVerbosity,
  type StatusBarData,
} from "../lib/skin.js";
import { type SSEEvent } from "../lib/stream.js";
import { createProvider, type ProviderClient } from "../lib/provider.js";
import { getToolDef } from "../tools/registry.js";
import { insertMemory, searchMemory } from "../lib/memory-db.js";
import { resolveModelAlias } from "../../queue/model-utils.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { SSEEvent };

export interface ChatStreamRenderState {
  agentName: string;
  responded: boolean;
  streamingTextStarted: boolean;
  responseFrameOpen: boolean;
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

interface ChatEventHandlers {
  spinner: Pick<NyxSpinner, "update" | "clear" | "stop" | "start" | "notifyToken">;
  statusData: StatusBarData;
  state: ChatStreamRenderState;
  instName: string;
  sessionMode: boolean;
  turnStart: number;
  addCostCents: (costCents: number) => void;
  writeStdout: (text: string) => void;
  writeLine: (text?: string) => void;
}

function getEventData(event: SSEEvent): Record<string, unknown> | null {
  const data = event.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
}

export function getResponseEventCostCents(event: SSEEvent): number | undefined {
  if (typeof event.cost_cents === "number") return event.cost_cents;
  const data = getEventData(event);
  return typeof data?.cost_cents === "number" ? data.cost_cents : undefined;
}

function getResponseEventText(event: SSEEvent): string | undefined {
  if (typeof event.response === "string") return event.response;
  const data = getEventData(event);
  return typeof data?.response === "string" ? data.response : undefined;
}

function getResponseEventAgent(event: SSEEvent): string | undefined {
  if (typeof event.agent === "string") return event.agent;
  const data = getEventData(event);
  return typeof data?.agent === "string" ? data.agent : undefined;
}

export function getThreadSnapshot(
  sessionId: string | null,
  statelessSenderId: string,
): { session_id: string | null; session_label: string; stateless: boolean } {
  return {
    session_id: sessionId,
    session_label: sessionId ?? `stateless:${statelessSenderId.slice(-8)}`,
    stateless: !sessionId,
  };
}

export function handleChatStreamEvent(event: SSEEvent, handlers: ChatEventHandlers): void {
  const {
    spinner,
    statusData,
    state,
    instName,
    sessionMode,
    turnStart,
    addCostCents,
    writeStdout,
    writeLine,
  } = handlers;

  if (event.type === "agent:status") {
    if (event.status === "running" && event.task && !state.streamingTextStarted) spinner.update(String(event.task));
    return;
  }

  if (event.type === "trace:tool_use") {
    if (event.tool) spinner.update(String(event.tool) + "...");
    return;
  }

  if (event.type === "tool:start") {
    const line = renderToolCall(
      String(event.tool ?? "tool"),
      event.input,
    );
    if (state.streamingTextStarted) {
      if (line) writeLine(line);
    } else if (line) {
      spinner.clear();
      writeLine(line);
      spinner.start(String(event.tool ?? "tool") + "...");
    } else {
      spinner.update(String(event.tool ?? "tool") + "...");
    }
    return;
  }

  if (event.type === "usage") {
    statusData.tokensIn = event.input_tokens as number | undefined;
    statusData.tokensOut = event.output_tokens as number | undefined;
    statusData.model = event.model as string | undefined;
    return;
  }

  if (event.type === "agent:progress") {
    statusData.tokensIn = event.tokensIn as number | undefined;
    statusData.tokensOut = event.tokensOut as number | undefined;
    return;
  }

  if (event.type === "token") {
    const text = typeof event.text === "string" ? event.text : "";
    if (!text || state.responded) return;
    if (!state.streamingTextStarted) {
      spinner.clear();
      state.streamingTextStarted = true;
      state.agentName = (event.agent as string | undefined) ?? state.agentName;
      writeLine(agentHeader(state.agentName || instName, sessionMode));
      writeLine(responseFrameBorder("top"));
      state.responseFrameOpen = true;
    }
    spinner.notifyToken();
    writeStdout(text);
    return;
  }

  if (event.type === "response") {
    state.responded = true;
    state.agentName = getResponseEventAgent(event) ?? instName;
    const responseCostCents = getResponseEventCostCents(event);
    if (typeof responseCostCents === "number") addCostCents(responseCostCents);
    statusData.elapsedMs = Date.now() - turnStart;

    if (state.streamingTextStarted) {
      process.stdout.write("\n");
      if (state.responseFrameOpen) {
        writeLine(responseFrameBorder("bottom"));
        state.responseFrameOpen = false;
      }
      const bar = renderStatusBar(statusData);
      if (bar) writeLine(bar);
      writeLine();
      return;
    }

    spinner.stop();
    const text = getResponseEventText(event) ?? "(no response)";
    writeLine(agentHeader(state.agentName, sessionMode));
    writeLine(responseFrameBorder("top"));
    writeLine(renderMarkdown(text));
    writeLine(responseFrameBorder("bottom"));
    const bar = renderStatusBar(statusData);
    if (bar) writeLine(bar);
    writeLine();
    return;
  }

  if (event.type === "error") {
    spinner.stop(false);
    if (state.responseFrameOpen) {
      process.stdout.write("\n");
      writeLine(responseFrameBorder("bottom"));
      state.responseFrameOpen = false;
    }
    writeLine(`\n  ${pc.red("✕")} ${pc.dim(String(event.error ?? "Unknown error"))}\n`);
    state.responded = true;
  }
}

// ─── Turn tracking ────────────────────────────────────────────────────────────

interface Turn {
  userMsg: string;
  assistantMsg: string;
  toolCalls: string[];
  timestamp: number;
}

const TURNS_ROOT = join(homedir(), ".nyxhive", "local-runs");

async function appendTurn(sessionId: string, turn: Turn): Promise<void> {
  try {
    const dir = join(TURNS_ROOT, `chat-${sessionId.slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "turns.jsonl"), JSON.stringify(turn) + "\n");
  } catch { /* non-fatal */ }
}

// ─── Session helpers ──────────────────────────────────────────────────────────

interface CreateSessionResponse {
  session_id: string;
  created_at: number;
}

async function tryCreateSession(
  host: string,
  apiKey: string,
  agent?: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${host}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ agent }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CreateSessionResponse;
    return data.session_id ?? null;
  } catch {
    return null;
  }
}

async function tryGetSessionSummary(
  host: string,
  apiKey: string,
  sessionId: string,
): Promise<SessionSummaryResponse | null> {
  try {
    const res = await fetch(`${host}/api/sessions/${sessionId}`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionSummaryResponse;
  } catch {
    return null;
  }
}

async function tryUndoSessionTurn(
  host: string,
  apiKey: string,
  sessionId: string,
): Promise<number | null> {
  try {
    const res = await fetch(`${host}/api/sessions/${sessionId}/undo`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { deleted?: number };
    return typeof data.deleted === "number" ? data.deleted : null;
  } catch {
    return null;
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const W = () => Math.min(process.stdout.columns || 80, 120);

function agentHeader(name: string, sessionMode: boolean) {
  const w = W();
  const mark = pc.dim("◆");
  const label = pc.bold(pc.cyan(name.toLowerCase()));
  const tag = sessionMode ? pc.dim(" ·session") : "";
  const tagVisible = sessionMode ? 9 : 0;
  const dashLen = Math.max(4, w - 2 - name.length - 1 - (tagVisible > 0 ? 1 + tagVisible : 0));
  const dashes = pc.dim("─".repeat(dashLen));
  return tagVisible
    ? `\n${mark} ${label} ${dashes}${tag}`
    : `\n${mark} ${label} ${dashes}`;
}

function responseFrameBorder(edge: "top" | "bottom"): string {
  const width = Math.max(12, W() - 4);
  const start = edge === "top" ? "╭" : "╰";
  const end = edge === "top" ? "╮" : "╯";
  return `  ${pc.dim(start)}${pc.dim("─".repeat(width))}${pc.dim(end)}`;
}

interface WelcomeBannerOpts {
  instName: string;
  sessionId: string | null;
  agentHint?: string;
  statelessId?: string;
  model: string;
  port: number;
  host: string;
}

export function renderWelcomeBanner(opts: WelcomeBannerOpts): string {
  const mode = opts.sessionId
    ? `session ${opts.sessionId.slice(0, 8)}`
    : `stateless ${opts.statelessId ? opts.statelessId.slice(-8) : "local"}`;
  const rows = [
    ["instance", opts.instName.toLowerCase()],
    ["agent", opts.agentHint ?? "default"],
    ["model", opts.model],
    ["port", String(opts.port || "unknown")],
    ["version", NYX_VERSION],
    ["host", opts.host],
    ["mode", mode],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const content = rows.map(([label, value]) => `  ${pc.cyan(label.padEnd(labelWidth))}  ${value}`);
  const width = Math.max(
    52,
    Math.min(W(), Math.max(...content.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length)) + 2),
  );
  const innerWidth = width - 4;
  const top = `  ${pc.dim("╭")}${pc.dim("─".repeat(innerWidth))}${pc.dim("╮")}`;
  const title = `  ${pc.bold(pc.cyan("nyx chat"))}`;
  const help = `  ${pc.dim("/help  /status  /model  /new  /cost  /fleet  Ctrl+C")}`;
  const bottom = `  ${pc.dim("╰")}${pc.dim("─".repeat(innerWidth))}${pc.dim("╯")}`;
  return ["", top, title, ...content, help, bottom, ""].join("\n");
}

function printWelcome(opts: WelcomeBannerOpts) {
  console.log(renderWelcomeBanner(opts));
}

function printHelp() {
  const cmds: [string, string][] = [
    ["/status",   "Show instance, model, session, and mode"],
    ["/model [n]","Show or set the per-session model override"],
    ["/stats",    "Show session totals and local turn stats"],
    ["/clear",    "Start a new session"],
    ["/new",      "Alias for /clear"],
    ["/resume",   "Resume last session"],
    ["/sessions", "List recent sessions"],
    ["/thread",   "Show current session ID"],
    ["/fleet",    "Quick agent status"],
    ["/cost",     "Session cost so far"],
    ["/ralph",    "Toggle ralph (autonomous) mode"],
    ["/undo",     "Pop last turn (no re-run; server history unchanged)"],
    ["/retry",    "Pop last turn and re-send the same message"],
    ["/compress", "Summarize history into a single context message, start fresh session"],
    ["/compact",  "Alias for /compress"],
    ["/remember <text>", "Save text to cross-session memory"],
    ["/recall <q>",      "Search cross-session memory"],
    ["/verbose",  "Cycle tool call display: off → new → all → verbose"],
    ["/skin <n>", "Switch skin (default|kawaii|nyx|mono)"],
    ["/help",     "This help"],
    ["exit",      "Quit"],
  ];
  console.log();
  for (const [cmd, desc] of cmds) {
    console.log(`  ${pc.cyan(cmd.padEnd(12))} ${pc.dim(desc)}`);
  }
  console.log();
}

function costStr(cents: number) {
  if (cents === 0) return pc.dim("$0.00");
  return pc.yellow("$" + (cents / 100).toFixed(4));
}

export type ChatOutputFormat = "text" | "json";

export interface ChatRuntimeEvent {
  type: string;
  message_id?: string;
  session_id?: string | null;
  agent?: string;
  command?: string;
  response?: string;
  content?: string;
  message?: string;
  cost_cents?: number;
  turns?: number;
  [key: string]: unknown;
}

export interface PipeInputFrame {
  type: "message" | "command";
  content?: string;
  command?: string;
  sender?: string;
  channel?: string;
  message_id?: string;
}

interface RunPromptModeOptions {
  prompt: string;
  outputFormat: ChatOutputFormat;
  executeMessage: (emitEvent?: (event: ChatRuntimeEvent) => void) => Promise<{ ok: boolean; response?: string }>;
  writeStdout: (text: string) => void;
}

interface RunPipeModeOptions {
  input: Iterable<string> | AsyncIterable<string>;
  emitEvent: (event: ChatRuntimeEvent) => void;
  handleMessage: (frame: PipeInputFrame) => Promise<void>;
  handleCommand: (frame: PipeInputFrame) => Promise<{ exit?: boolean } | void>;
}

function normalizeOutputFormat(value: unknown, fallback: ChatOutputFormat): ChatOutputFormat {
  return value === "json" ? "json" : fallback;
}

function writeJsonLine(writeStdout: (text: string) => void, event: ChatRuntimeEvent): void {
  writeStdout(`${JSON.stringify(event)}\n`);
}

export async function runPromptMode({
  prompt,
  outputFormat,
  executeMessage,
  writeStdout,
}: RunPromptModeOptions): Promise<number> {
  if (!prompt.trim()) return 1;

  try {
    const result = await executeMessage(
      outputFormat === "json"
        ? (event) => writeJsonLine(writeStdout, event)
        : undefined,
    );
    if (!result.ok) return 1;
    if (outputFormat === "text") {
      writeStdout(result.response ?? "");
      if (!(result.response ?? "").endsWith("\n")) writeStdout("\n");
    }
    return 0;
  } catch (err) {
    if (outputFormat === "json") {
      writeJsonLine(writeStdout, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return 1;
  }
}

export function parsePipeInputFrame(raw: string): PipeInputFrame {
  const parsed = JSON.parse(raw) as PipeInputFrame;
  if (!parsed || (parsed.type !== "message" && parsed.type !== "command")) {
    throw new Error("Invalid pipe frame: expected type=message|command");
  }
  if (parsed.type === "message" && typeof parsed.content !== "string") {
    throw new Error("Invalid pipe frame: message content must be a string");
  }
  if (parsed.type === "command" && typeof parsed.command !== "string") {
    throw new Error("Invalid pipe frame: command must be a string");
  }
  return parsed;
}

export async function runPipeMode({
  input,
  emitEvent,
  handleMessage,
  handleCommand,
}: RunPipeModeOptions): Promise<number> {
  for await (const rawLine of input) {
    const line = rawLine.trim();
    if (!line) continue;

    let frame: PipeInputFrame;
    try {
      frame = parsePipeInputFrame(line);
    } catch (err) {
      emitEvent({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (frame.type === "message") {
      await handleMessage(frame);
      continue;
    }

    const result = await handleCommand(frame);
    if (result && result.exit) return 0;
  }

  return 0;
}

type TurnStatus = "done" | "blocked" | "interrupt" | "error" | "no_response";

interface TurnResult {
  ok: boolean;
  response: string;
  status: TurnStatus;
  blockedToolName?: string;
  errorMessage?: string;
}

const CANCEL_REQUEST_TIMEOUT_MS = 3_000;

export function resolveActiveMessageId(
  currentMessageId: string | null,
  event: Pick<SSEEvent, "message_id">,
): string | null {
  return typeof event.message_id === "string" && event.message_id.length > 0
    ? event.message_id
    : currentMessageId;
}

export async function cancelActiveTurn(
  host: string,
  apiKey: string,
  abortController: AbortController,
  messageId?: string | null,
): Promise<void> {
  try {
    if (messageId) {
      await fetch(`${host}/api/message/${messageId}/cancel`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(CANCEL_REQUEST_TIMEOUT_MS),
      });
    }
  } catch {
    // Best effort: always abort the local stream even if the cancel POST fails.
  } finally {
    if (!abortController.signal.aborted) abortController.abort();
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export default defineCommand({
  meta: { name: "chat", description: "Interactive chat with an agent" },
  args: {
    instance: { type: "positional", required: false, description: "Instance name" },
    agent:    { type: "string",     description: "Agent to talk to" },
    ralph:    { type: "boolean",    description: "Enable ralph mode" },
    resume:   { type: "boolean",    description: "Resume last session" },
    session:  { type: "string",     description: "Resume specific session ID" },
    prompt:   { type: "string",     description: "Send a single non-interactive prompt" },
    pipe:     { type: "boolean",    description: "Read JSONL commands/messages from stdin" },
    outputFormat: { type: "string", description: "Output format for non-interactive mode (text|json)" },
    yolo:     { type: "boolean",    description: "Skip all approval gates (auto-approve everything)" },
  },
  async run({ args }) {
    const inst = args.instance
      ? await getInstance(args.instance)
      : await defaultInstance();

    if (!inst) {
      console.log(pc.red("No instance found. Run `nyx config init` first."));
      process.exit(1);
    }

    const activeInst = inst;
    const host = activeInst.host ?? `http://localhost:${activeInst.port}`;
    const apiKey = activeInst.apiKey ?? "";
    const instName = activeInst.name;
    const yolo = args.yolo ?? false;
    const pipeMode = args.pipe ?? false;
    const promptMode = typeof args.prompt === "string";
    if (pipeMode && promptMode) {
      console.error("Choose either --prompt or --pipe, not both.");
      process.exit(1);
    }
    const outputFormat = pipeMode
      ? "json"
      : normalizeOutputFormat(args.outputFormat, promptMode ? "text" : "text");
    const statelessSenderId = `nyx-cli:${randomUUID()}`;

    if (!pipeMode && !promptMode && yolo) {
      console.log(`  ${pc.yellow("⚡ --yolo")} ${pc.dim("approval gates disabled")}\n`);
    }

    let provider: ProviderClient;
    try {
      provider = await createProvider({ host, apiKey, instanceName: instName });
    } catch (err) {
      console.log(pc.red(`  Provider error: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }

    let sessionId: string | null = null;
    let sessionCostCents = 0;
    let messageCount = 0;
    let ralphMode = args.ralph ?? false;
    let sessionTitle: string | undefined;
    let modelOverride: string | null = null;

    if (args.session) {
      const s = await loadSession(args.session);
      if (s) {
        sessionId = s.session_id;
        sessionCostCents = s.cost_cents;
        messageCount = s.message_count;
        sessionTitle = s.title;
      } else if (!pipeMode && !promptMode) {
        console.log(pc.yellow(`  Session ${args.session} not found locally — starting fresh.\n`));
      }
    } else if (args.resume) {
      const s = await loadLastSession();
      if (s && s.instance === instName) {
        sessionId = s.session_id;
        sessionCostCents = s.cost_cents;
        messageCount = s.message_count;
        sessionTitle = s.title;
        if (!pipeMode && !promptMode) {
          console.log(pc.dim(`  Resuming session ${sessionId.slice(0, 8)}...\n`));
        }
      }
    }

    if (!sessionId) sessionId = await tryCreateSession(host, apiKey, args.agent);
    if (sessionId) {
      const remote = await tryGetSessionSummary(host, apiKey, sessionId);
      if (remote) {
        sessionCostCents = remote.total_cost_cents;
        messageCount = remote.message_count;
        sessionTitle = remote.title;
      }
    }

    const turnStack: Turn[] = [];
    const sessionApprovals = new Set<string>();
    let activeSpinner: NyxSpinner | null = null;
    let activeAbort: AbortController | null = null;
    let activeRemoteMessageId: string | null = null;
    let interruptingTurn = false;
    const writeStdout = (text: string) => process.stdout.write(text);

    const currentSessionLabel = () => sessionId ?? `stateless:${statelessSenderId.slice(-8)}`;

    const persistSession = async () => {
      if (!sessionId) return;
      const s: LocalSession = {
        session_id: sessionId,
        instance: instName,
        host,
        agent: args.agent,
        created_at: Date.now(),
        updated_at: Date.now(),
        message_count: messageCount,
        title: sessionTitle,
        cost_cents: sessionCostCents,
      };
      await saveSession(s).catch(() => {});
    };

    async function syncSessionFromServer() {
      if (!sessionId) return;
      const summary = await tryGetSessionSummary(host, apiKey, sessionId);
      if (!summary) return;
      sessionTitle = summary.title;
      messageCount = summary.message_count;
      sessionCostCents = summary.total_cost_cents;
    }

    async function rollbackRemoteTurnIfNeeded(reason: "tool_gate" | "interrupt") {
      if (!sessionId) return;
      const deleted = await tryUndoSessionTurn(host, apiKey, sessionId);
      if (deleted && deleted > 0 && !pipeMode && !promptMode) {
        await syncSessionFromServer();
        const label = reason === "tool_gate"
          ? "Blocked turn rolled back from session history."
          : "Interrupted turn rolled back from session history.";
        console.log(`  ${pc.dim(label)}`);
      }
    }

    async function startFreshSession(): Promise<void> {
      await persistSession();
      sessionId = await tryCreateSession(host, apiKey, args.agent);
      sessionCostCents = 0;
      messageCount = 0;
      sessionTitle = undefined;
      turnStack.length = 0;
    }

    async function resumeStoredSession(): Promise<boolean> {
      const s = await loadLastSession();
      if (!s || s.instance !== instName) return false;
      sessionId = s.session_id;
      sessionCostCents = s.cost_cents;
      messageCount = s.message_count;
      sessionTitle = s.title;
      await syncSessionFromServer();
      return true;
    }

    async function undoLastTurn(): Promise<string> {
      if (turnStack.length === 0) return "No turns to undo.";
      const popped = turnStack.pop()!;
      messageCount = Math.max(0, messageCount - 1);
      if (sessionId) {
        const deleted = await tryUndoSessionTurn(host, apiKey, sessionId);
        if (deleted === null) {
          await persistSession();
          return "Remote undo unavailable; local turn removed only.";
        }
        await syncSessionFromServer();
      }
      await persistSession();
      return `Undid: "${popped.userMsg.slice(0, 60)}"`;
    }

    async function compressTurns(): Promise<string> {
      const history = turnStack
        .map((t, i) => `Turn ${i + 1}\nUser: ${t.userMsg}\nAssistant: ${t.assistantMsg}`)
        .join("\n\n");
      const summaryPrompt = `Summarize the following conversation history into a single concise paragraph that captures the key context, decisions, and outcomes. This will be used as context for continuing the session.\n\n${history}`;

      let summary = "";
      for await (const event of provider.stream(summaryPrompt, {
        signal: undefined,
        modelOverride: modelOverride ?? undefined,
      })) {
        if (event.type === "token" && typeof event.text === "string") summary += event.text;
        if (event.type === "response" && typeof event.response === "string" && !summary) summary = event.response;
      }
      return summary;
    }

    function currentModelLabel(): string {
      return modelOverride ?? provider.modelId;
    }

    function getModelSnapshot() {
      return {
        model: currentModelLabel(),
        override: modelOverride,
      };
    }

    function applyModelCommand(input?: string): string {
      const raw = input?.trim() ?? "";
      if (!raw) {
        const current = currentModelLabel();
        const suffix = modelOverride ? " (override)" : "";
        return `Model: ${current}${suffix}\nAliases: haiku, sonnet, opus, flash, pro, gpt, gpt 5.5, gpt 5.4 pro, gpt 5 mini, gpt 5 nano, codex\nUsage: /model <name|reset>`;
      }

      if (raw === "reset" || raw === "default") {
        modelOverride = null;
        return `Model override cleared. Using ${provider.modelId}.`;
      }

      modelOverride = resolveModelAlias(raw);
      return `Model override set to ${modelOverride}.`;
    }

    function getStatusSnapshot() {
      return {
        instance: instName,
        host,
        agent: args.agent ?? "default",
        model: currentModelLabel(),
        model_override: modelOverride,
        session_id: sessionId,
        session_label: currentSessionLabel(),
        mode: ralphMode ? "ralph" : "default",
        turns: messageCount,
        cost_cents: sessionCostCents,
        title: sessionTitle,
        skin: getSkin().name,
        verbosity: getVerbosity(),
      };
    }

    function printStatus() {
      const snapshot = getStatusSnapshot();
      const lines = [
        `  ${pc.dim("Instance:")} ${snapshot.instance}`,
        `  ${pc.dim("Host:")}     ${snapshot.host}`,
        `  ${pc.dim("Agent:")}    ${snapshot.agent}`,
        `  ${pc.dim("Model:")}    ${snapshot.model}`,
        `  ${pc.dim("Override:")} ${snapshot.model_override ?? "none"}`,
        `  ${pc.dim("Session:")}  ${snapshot.session_label}`,
        `  ${pc.dim("Mode:")}     ${snapshot.mode}`,
        `  ${pc.dim("Turns:")}    ${snapshot.turns}`,
        `  ${pc.dim("Cost:")}     ${costStr(snapshot.cost_cents)}`,
        `  ${pc.dim("Skin:")}     ${snapshot.skin} / ${snapshot.verbosity}`,
      ];
      console.log();
      for (const line of lines) console.log(line);
      if (!sessionId) {
        console.log(`  ${pc.dim("Note:")}     stateless mode uses an isolated sender id for this terminal session.`);
      }
      console.log();
    }

    function printStats() {
      console.log();
      console.log(`  ${pc.dim("Server turns:")} ${messageCount}`);
      console.log(`  ${pc.dim("Local turns:")}  ${turnStack.length}`);
      console.log(`  ${pc.dim("Total cost:")}   ${costStr(sessionCostCents)}`);
      console.log(`  ${pc.dim("Model:")}        ${currentModelLabel()}`);
      console.log(`  ${pc.dim("Mode:")}         ${ralphMode ? "ralph" : "default"}`);
      console.log();
    }

    function emitCommandDone(command: string, messageId?: string, extra: Record<string, unknown> = {}) {
      writeJsonLine(writeStdout, {
        type: "command_done",
        command,
        message_id: messageId,
        session_id: sessionId,
        ...extra,
      });
    }

    function emitJsonStreamEvent(event: SSEEvent, messageId?: string, turnCostCents?: number) {
      const agentName = (event.agent as string | undefined) ?? args.agent ?? instName.toLowerCase();
      if (event.type === "agent:status") {
        writeJsonLine(writeStdout, {
          type: "status",
          message_id: messageId,
          session_id: sessionId,
          agent: agentName,
          state: event.status ?? "thinking",
          task: event.task,
        });
        return;
      }
      if (event.type === "trace:tool_use") {
        writeJsonLine(writeStdout, {
          type: "status",
          message_id: messageId,
          session_id: sessionId,
          agent: agentName,
          state: "working",
          task: event.tool,
        });
        return;
      }
      if (event.type === "tool:start") {
        writeJsonLine(writeStdout, {
          type: "tool_start",
          message_id: messageId,
          session_id: sessionId,
          agent: agentName,
          tool: event.tool,
          input: event.input,
        });
        return;
      }
      if (event.type === "execution:event" && (event.phase === "completed" || event.phase === "failed")) {
        writeJsonLine(writeStdout, {
          type: "tool_done",
          message_id: messageId,
          session_id: sessionId,
          agent: agentName,
          tool: event.title ?? event.tool,
          phase: event.phase,
        });
        return;
      }
      if (event.type === "token" && typeof event.text === "string") {
        writeJsonLine(writeStdout, {
          type: "text_delta",
          message_id: messageId,
          session_id: sessionId,
          agent: agentName,
          content: event.text,
        });
        return;
      }
      if (event.type === "response") {
        const responseCostCents = getResponseEventCostCents(event);
        writeJsonLine(writeStdout, {
          type: "done",
          message_id: messageId,
          session_id: sessionId,
          agent: agentName,
          response: getResponseEventText(event),
          cost_cents: typeof turnCostCents === "number" ? turnCostCents : responseCostCents,
          turns: messageCount,
        });
        return;
      }
      if (event.type === "error") {
        writeJsonLine(writeStdout, {
          type: "error",
          message_id: messageId,
          session_id: sessionId,
          agent: agentName,
          message: String(event.error ?? "Unknown error"),
        });
      }
    }

    async function runTurn(
      message: string,
      options: {
        messageId?: string;
        abortController?: AbortController;
        requestApproval: (toolName: string, input: unknown) => Promise<"allow" | "block">;
        onStreamEvent?: (event: SSEEvent, meta: { turnStart: number }) => void;
        emitRuntimeEvent?: (event: ChatRuntimeEvent) => void;
      },
    ): Promise<TurnResult> {
      messageCount++;
      if (!sessionTitle && messageCount === 1) sessionTitle = message.slice(0, 60);

      const abort = options.abortController ?? new AbortController();
      const turnStart = Date.now();
      let assistantText = "";
      const toolCallsThisTurn: string[] = [];
      let blockedToolName: string | null = null;
      let responseSeen = false;
      let streamErrorMessage: string | null = null;
      let caughtError: string | null = null;
      let turnCostCents = 0;

      activeAbort = abort;
      activeRemoteMessageId = null;
      options.emitRuntimeEvent?.({
        type: "turn_start",
        message_id: options.messageId,
        session_id: sessionId,
        agent: args.agent ?? instName.toLowerCase(),
      });

      try {
        for await (const event of provider.stream(message, {
          sessionId: sessionId ?? undefined,
          agent: args.agent,
          modelOverride: modelOverride ?? undefined,
          mode: ralphMode ? "ralph" : undefined,
          sender: "nyx-cli",
          senderId: sessionId ? undefined : statelessSenderId,
          signal: abort.signal,
        })) {
          if (process.env.NYX_DEBUG) {
            appendFileSync("/tmp/nyx-events.log", JSON.stringify(event) + "\n");
          }

          activeRemoteMessageId = resolveActiveMessageId(activeRemoteMessageId, event);

          if (event.type === "tool:start" && !yolo) {
            const toolName = String(event.tool ?? "");
            if (toolName) {
              const decision = await options.requestApproval(toolName, event.input);
              if (decision === "block") {
                blockedToolName = toolName;
                abort.abort(new Error(`Sensitive tool blocked: ${toolName}`));
                break;
              }
              const def = getToolDef(toolName);
              toolCallsThisTurn.push(def.renderInput(event.input));
            }
          }

          if (event.type === "response") {
            responseSeen = true;
            assistantText = getResponseEventText(event) ?? assistantText;
            turnCostCents = getResponseEventCostCents(event) ?? turnCostCents;
          }
          if (event.type === "token" && typeof event.text === "string" && !responseSeen) {
            assistantText += event.text;
          }
          if (event.type === "error") {
            streamErrorMessage = String(event.error ?? "Unknown error");
          }

          options.onStreamEvent?.(event, { turnStart });
          if (options.emitRuntimeEvent) emitJsonStreamEvent(event, options.messageId, turnCostCents);
        }
      } catch (err) {
        caughtError = err instanceof Error ? err.message : String(err);
      } finally {
        activeAbort = null;
        activeRemoteMessageId = null;
      }

      if (responseSeen) {
        sessionCostCents += turnCostCents;
        const turn: Turn = {
          userMsg: message,
          assistantMsg: assistantText,
          toolCalls: toolCallsThisTurn,
          timestamp: turnStart,
        };
        turnStack.push(turn);
        if (sessionId) await appendTurn(sessionId, turn);
        await persistSession();
        return { ok: true, response: assistantText, status: "done" };
      }

      messageCount = Math.max(0, messageCount - 1);
      if (blockedToolName) {
        await rollbackRemoteTurnIfNeeded("tool_gate");
      } else if (abort.signal.aborted) {
        await rollbackRemoteTurnIfNeeded("interrupt");
      }
      await persistSession();

      const errorMessage =
        blockedToolName
          ? `Sensitive tool blocked: ${blockedToolName}`
          : streamErrorMessage
            ?? (abort.signal.aborted ? "Interrupted." : caughtError)
            ?? "No response received.";

      if (options.emitRuntimeEvent) {
        options.emitRuntimeEvent({
          type: "error",
          message_id: options.messageId,
          session_id: sessionId,
          agent: args.agent ?? instName.toLowerCase(),
          message: errorMessage,
        });
      }

      return {
        ok: false,
        response: "",
        status: blockedToolName ? "blocked" : abort.signal.aborted ? "interrupt" : (streamErrorMessage || caughtError) ? "error" : "no_response",
        blockedToolName: blockedToolName ?? undefined,
        errorMessage,
      };
    }

    async function sendMessageInteractive(
      rl: readline.Interface,
      prompt: () => void,
      message: string,
      checkApprovalGate: (toolName: string, input: unknown) => Promise<"allow" | "block">,
    ) {
      const spinner = new NyxSpinner();
      const abort = new AbortController();
      const statusData: StatusBarData = {};
      const streamState: ChatStreamRenderState = {
        agentName: instName,
        responded: false,
        streamingTextStarted: false,
        responseFrameOpen: false,
      };
      let pendingCostCents = 0;

      activeSpinner = spinner;
      activeAbort = abort;
      spinner.start();
      rl.pause();

      const result = await runTurn(message, {
        abortController: abort,
        requestApproval: checkApprovalGate,
        onStreamEvent: (event, meta) => {
          handleChatStreamEvent(event, {
            spinner,
            statusData,
            state: streamState,
            instName,
            sessionMode: !!sessionId,
            turnStart: meta.turnStart,
            addCostCents: (costCents) => {
              pendingCostCents += costCents;
              statusData.costCents = sessionCostCents + pendingCostCents;
            },
            writeStdout,
            writeLine: (text = "") => console.log(text),
          });
        },
      });

      spinner.stop(result.ok);
      activeSpinner = null;
      activeAbort = null;
      rl.resume();

      if (!result.ok) {
        if (result.status === "blocked" && result.blockedToolName) {
          console.log(`\n  ${pc.yellow("⊘")} ${pc.dim(`Stopped turn at sensitive tool: ${result.blockedToolName}`)}\n`);
        } else if (result.status === "interrupt") {
          console.log(`\n  ${pc.yellow("⚡")} ${pc.dim("Interrupted.")}\n`);
        } else if (result.status === "no_response") {
          console.log(`\n  ${pc.red("✕")} ${pc.dim("No response received.")}\n`);
        } else if (result.errorMessage) {
          console.log(`\n  ${pc.red("✕")} ${pc.dim(result.errorMessage)}\n`);
        }
      }

      prompt();
    }

    async function sendMessageNonInteractive(message: string, emitEvent?: (event: ChatRuntimeEvent) => void): Promise<TurnResult> {
      return runTurn(message, {
        requestApproval: async (toolName: string) => {
          const def = getToolDef(toolName);
          if (yolo || def.sensitivity !== "high") return "allow";
          return "block";
        },
        emitRuntimeEvent: emitEvent,
      });
    }

    if (promptMode) {
      const exitCode = await runPromptMode({
        prompt: args.prompt!,
        outputFormat,
        executeMessage: async (emitEvent) => {
          const result = await sendMessageNonInteractive(args.prompt!, emitEvent);
          return { ok: result.ok, response: result.response };
        },
        writeStdout,
      });
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    if (pipeMode) {
      const pipeRl = readline.createInterface({
        input: process.stdin,
        terminal: false,
        crlfDelay: Infinity,
      });

      const exitCode = await runPipeMode({
        input: pipeRl,
        emitEvent: (event) => writeJsonLine(writeStdout, event),
        handleMessage: async (frame) => {
          await sendMessageNonInteractive(frame.content!, (event) => {
            writeJsonLine(writeStdout, { ...event, message_id: event.message_id ?? frame.message_id });
          });
        },
        handleCommand: async (frame) => {
          const command = frame.command!.trim();

          if (command === "/stop") {
            emitCommandDone(command, frame.message_id);
            return { exit: true };
          }

          if (command === "/new" || command === "/clear") {
            await startFreshSession();
            emitCommandDone(command, frame.message_id, { turns: messageCount });
            return;
          }

          if (command === "/resume") {
            const resumed = await resumeStoredSession();
            emitCommandDone(command, frame.message_id, { resumed, turns: messageCount });
            return;
          }

          if (command === "/status") {
            emitCommandDone(command, frame.message_id, getStatusSnapshot());
            return;
          }

          if (command === "/thread") {
            emitCommandDone(command, frame.message_id, getThreadSnapshot(sessionId, statelessSenderId));
            return;
          }

          if (command === "/model" || command.startsWith("/model ")) {
            const result = applyModelCommand(command.slice("/model".length).trim() || undefined);
            emitCommandDone(command, frame.message_id, { message: result, ...getModelSnapshot() });
            return;
          }

          if (command === "/undo") {
            emitCommandDone(command, frame.message_id, { message: await undoLastTurn(), turns: messageCount });
            return;
          }

          if (command === "/retry") {
            if (turnStack.length === 0) {
              emitCommandDone(command, frame.message_id, { message: "No turns to retry." });
              return;
            }
            const last = turnStack.pop()!;
            messageCount = Math.max(0, messageCount - 1);
            if (sessionId) {
              const deleted = await tryUndoSessionTurn(host, apiKey, sessionId);
              if (deleted !== null) await syncSessionFromServer();
            }
            await persistSession();
            await sendMessageNonInteractive(last.userMsg, (event) => {
              writeJsonLine(writeStdout, { ...event, message_id: event.message_id ?? frame.message_id });
            });
            return;
          }

          if (command === "/compress" || command === "/compact") {
            if (turnStack.length === 0) {
              emitCommandDone(command, frame.message_id, { message: "Nothing to compress." });
              return;
            }
            try {
              const summary = await compressTurns();
              await startFreshSession();
              emitCommandDone(command, frame.message_id, { message: "Session compressed.", turns: messageCount });
              await sendMessageNonInteractive(`Context from previous session: ${summary}`, (event) => {
                writeJsonLine(writeStdout, { ...event, message_id: event.message_id ?? frame.message_id });
              });
            } catch (err) {
              writeJsonLine(writeStdout, {
                type: "error",
                message_id: frame.message_id,
                session_id: sessionId,
                message: err instanceof Error ? err.message : String(err),
              });
            }
            return;
          }

          writeJsonLine(writeStdout, {
            type: "error",
            message_id: frame.message_id,
            session_id: sessionId,
            message: `Unsupported command in pipe mode: ${command}`,
          });
        },
      });

      pipeRl.close();
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    printWelcome({
      instName,
      sessionId,
      agentHint: args.agent,
      statelessId: statelessSenderId,
      model: currentModelLabel(),
      port: activeInst.port,
      host,
    });
    if (sessionTitle) console.log(`  ${pc.dim("Topic:")} ${pc.dim(sessionTitle)}\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 200,
      crlfDelay: Infinity,
    });

    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");

    let _lineBuffer: string[] = [];
    let _lineTimer: ReturnType<typeof setTimeout> | null = null;

    const promptStr = () => {
      const turns = turnStack.length > 0 ? pc.dim(`[${turnStack.length}]`) : "";
      const model = pc.dim(currentModelLabel().split("/").pop() ?? currentModelLabel());
      return `${pc.cyan("◆")} ${model}${turns}${ralphMode ? " " + pc.yellow("⚡") : ""} ${pc.dim("›")} `;
    };

    async function checkApprovalGate(toolName: string, input: unknown): Promise<"allow" | "block"> {
      if (yolo) return "allow";
      if (sessionApprovals.has(toolName)) return "allow";
      const def = getToolDef(toolName);
      if (def.sensitivity !== "high") return "allow";

      const summary = def.renderInput(input);
      rl.resume();
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `\n  ${pc.yellow("?")} ${pc.bold(`Sensitive tool requested: ${toolName}`)} ${pc.dim(summary)}\n  ${pc.dim("[y=continue / n=stop turn / a=always]:")} `,
          (ans) => resolve(ans.trim().toLowerCase()),
        );
      });
      rl.pause();

      if (answer === "a") {
        sessionApprovals.add(toolName);
        return "allow";
      }
      return answer === "y" ? "allow" : "block";
    }

    const prompt = () => {
      rl.setPrompt(promptStr());
      rl.prompt(true);
    };

    const handleInput = async (message: string) => {
      if (!message) { prompt(); return; }

      if (message === "exit" || message === "quit") {
        await persistSession();
        const cost = sessionCostCents > 0 ? `  ${pc.dim("Cost:")} ${costStr(sessionCostCents)}\n` : "";
        console.log(`\n${cost}${pc.dim("  Goodbye.\n")}`);
        if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
        rl.close();
        process.exit(0);
      }

      if (message === "/help")   { printHelp(); prompt(); return; }
      if (message === "/status") { printStatus(); prompt(); return; }
      if (message === "/stats")  { printStats(); prompt(); return; }
      if (message === "/thread") {
        const snapshot = getThreadSnapshot(sessionId, statelessSenderId);
        console.log(`\n  ${pc.dim("Session:")} ${sessionId ? pc.cyan(snapshot.session_id!) : pc.dim(`none (${snapshot.session_label})`)}\n`);
        prompt();
        return;
      }
      if (message === "/cost") {
        const turns = `${messageCount} turn${messageCount !== 1 ? "s" : ""}`;
        console.log(`\n  ${pc.dim("Cost:")} ${costStr(sessionCostCents)}  ${pc.dim(turns)}\n`);
        prompt();
        return;
      }
      if (message === "/model" || message.startsWith("/model ")) {
        console.log(pc.dim(`\n  ${applyModelCommand(message.slice("/model".length).trim() || undefined)}\n`));
        prompt();
        return;
      }
      if (message === "/ralph") {
        ralphMode = !ralphMode;
        console.log(pc.dim(`\n  Ralph mode ${ralphMode ? pc.yellow("ON ⚡") : "OFF"}.\n`));
        prompt();
        return;
      }
      if (message === "/verbose") {
        const next = cycleVerbosity();
        console.log(pc.dim(`\n  Verbosity: ${pc.cyan(next)}\n`));
        prompt();
        return;
      }
      if (message === "/undo") {
        console.log(pc.dim(`\n  ${await undoLastTurn()}\n`));
        prompt();
        return;
      }
      if (message === "/retry") {
        if (turnStack.length === 0) {
          console.log(pc.dim("\n  No turns to retry.\n"));
          prompt();
          return;
        }
        const last = turnStack.pop()!;
        messageCount = Math.max(0, messageCount - 1);
        if (sessionId) {
          const deleted = await tryUndoSessionTurn(host, apiKey, sessionId);
          if (deleted === null) {
            console.log(pc.dim("\n  Remote retry fallback: previous turn still exists on the server.\n"));
          } else {
            await syncSessionFromServer();
          }
        }
        console.log(pc.dim(`\n  Retrying: "${last.userMsg.slice(0, 60)}"\n`));
        await sendMessageInteractive(rl, prompt, last.userMsg, checkApprovalGate);
        return;
      }
      if (message === "/compress" || message === "/compact") {
        if (turnStack.length === 0) {
          console.log(pc.dim("\n  Nothing to compress.\n"));
          prompt();
          return;
        }
        console.log(pc.dim("\n  Compressing session history...\n"));
        try {
          const summary = await compressTurns();
          await startFreshSession();
          console.log(pc.dim(`\n  New session${sessionId ? " " + sessionId.slice(0, 8) : ""}. Injecting summary...\n`));
          await sendMessageInteractive(rl, prompt, `Context from previous session: ${summary}`, checkApprovalGate);
        } catch (err) {
          console.log(pc.red(`\n  Compress failed: ${err instanceof Error ? err.message : err}\n`));
          prompt();
        }
        return;
      }
      if (message.startsWith("/remember ")) {
        const text = message.slice(10).trim();
        if (!text) { console.log(pc.dim("\n  Usage: /remember <text>\n")); prompt(); return; }
        insertMemory(text);
        console.log(pc.dim(`\n  Saved: "${text.slice(0, 80)}"\n`));
        prompt();
        return;
      }
      if (message.startsWith("/recall ")) {
        const query = message.slice(8).trim();
        if (!query) { console.log(pc.dim("\n  Usage: /recall <query>\n")); prompt(); return; }
        const results = searchMemory(query);
        if (results.length === 0) {
          console.log(pc.dim("\n  No memories found.\n"));
        } else {
          console.log();
          for (const r of results) {
            const date = new Date(r.created_at).toLocaleDateString();
            console.log(`  ${pc.cyan(date)}  ${pc.dim(r.source)}  ${r.content}`);
          }
          console.log();
        }
        prompt();
        return;
      }
      if (message.startsWith("/skin")) {
        const name = message.split(" ")[1]?.trim();
        if (!name) {
          const descriptions: Record<string, string> = {
            default: "clean · ◆ mark · quarter-circle spinner",
            ghost:   "minimal · invisible chrome · dot spinner",
            aether:  "data vibe · compass-rose spinner",
            nyx:     "coding sessions · braille spinner",
            kawaii:  "chaotic good",
            mono:    "plain ASCII",
          };
          console.log();
          for (const s of listSkins()) {
            const active = s === getSkin().name ? pc.green(" ←") : "";
            console.log(`  ${pc.cyan(s.padEnd(10))} ${pc.dim(descriptions[s] ?? "")}${active}`);
          }
          console.log();
        } else if (setSkin(name)) {
          console.log(pc.dim(`\n  Skin: ${pc.cyan(name)}\n`));
        } else {
          console.log(pc.dim(`\n  Unknown skin. Try: ${listSkins().join(", ")}\n`));
        }
        prompt();
        return;
      }
      if (message === "/clear" || message === "/new") {
        await startFreshSession();
        console.log(pc.dim(`\n  New session${sessionId ? " " + sessionId.slice(0, 8) : " (stateless)"}.\n`));
        prompt();
        return;
      }
      if (message === "/resume") {
        if (await resumeStoredSession()) {
          console.log(pc.dim(`\n  Resumed ${sessionId!.slice(0, 8)}.\n`));
        } else {
          console.log(pc.dim("\n  No previous session found.\n"));
        }
        prompt();
        return;
      }
      if (message === "/sessions") {
        const sessions = await listSessions();
        const mine = sessions.filter((s) => s.instance === instName).slice(0, 8);
        if (mine.length === 0) { console.log(pc.dim("\n  No sessions.\n")); prompt(); return; }
        console.log();
        for (const s of mine) {
          const active = s.session_id === sessionId ? pc.green(" ← current") : "";
          console.log(`  ${pc.cyan(s.session_id.slice(0, 8))}  ${pc.dim(s.title ?? "(untitled)")}  ${pc.dim(s.message_count + "t")}  ${costStr(s.cost_cents)}${active}`);
        }
        console.log();
        prompt();
        return;
      }
      if (message === "/fleet") {
        try {
          const res = await fetch(`${host}/api/agents`, {
            headers: { "Authorization": `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5_000),
          });
          const data = await res.json() as { agents?: { name: string; role: string; enabled: boolean }[] } | { name: string; role: string; enabled: boolean }[];
          const agents = Array.isArray(data) ? data : ((data as { agents?: { name: string; role: string; enabled: boolean }[] }).agents ?? []);
          console.log();
          for (const a of agents) console.log(`  ${a.enabled ? pc.green("●") : pc.red("○")} ${a.name} ${pc.dim(a.role)}`);
          console.log();
        } catch {
          console.log(pc.dim("  Could not reach instance.\n"));
        }
        prompt();
        return;
      }

      await sendMessageInteractive(rl, prompt, message, checkApprovalGate);
    };

    (rl as readline.Interface & NodeJS.EventEmitter).on("line", (raw: string) => {
      _lineBuffer.push(raw);
      if (_lineTimer) clearTimeout(_lineTimer);
      _lineTimer = setTimeout(async () => {
        _lineTimer = null;
        const message = _lineBuffer.join("\n").trim();
        _lineBuffer = [];
        await handleInput(message);
      }, 20);
    });

    let sigintCount = 0;
    (rl as readline.Interface & NodeJS.EventEmitter).on("SIGINT", async () => {
      if (interruptingTurn) return;
      if (activeAbort && !activeAbort.signal.aborted) {
        interruptingTurn = true;
        try {
          await cancelActiveTurn(host, apiKey, activeAbort, activeRemoteMessageId);
          if (activeSpinner) activeSpinner.clear();
          activeSpinner = null;
          activeAbort = null;
          activeRemoteMessageId = null;
          sigintCount = 0;
          console.log(`\n  ${pc.yellow("⚡")} ${pc.dim("Interrupted. Back to prompt.")}\n`);
          prompt();
          return;
        } finally {
          interruptingTurn = false;
        }
      }
      sigintCount++;
      if (sigintCount >= 2) {
        await persistSession();
        if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
        console.log(pc.dim("\n  Goodbye.\n"));
        process.exit(0);
      }
      console.log(pc.dim("\n  Press Ctrl+C again to exit."));
      setTimeout(() => { sigintCount = 0; }, 2000);
      prompt();
    });

    prompt();
  },
});
