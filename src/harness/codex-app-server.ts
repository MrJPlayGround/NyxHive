import { createHash } from "node:crypto";
import type { FileAttachment } from "../providers/types.js";
import type { AgentConfig, InputRequest } from "../types.js";
import type { AgentHarness, HarnessDiscovery, HarnessRuntimeEvent, HarnessTurnResult } from "./types.js";
import { registerHarness } from "./registry.js";
import { resolveCodexSecurityDecision } from "../agents/codex-security.js";

type JsonRecord = Record<string, unknown>;

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { message?: unknown };
}

export interface CodexAppServerConnection {
  send(message: unknown): void;
  close(): void;
  onLine(callback: (line: string) => void): void;
  onStderr(callback: (line: string) => void): void;
  onExit(callback: (code: number | null, signal: string | null) => void): void;
}

export interface CodexAppServerConnectionInput {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
}

export type CodexAppServerConnectionFactory = (
  input: CodexAppServerConnectionInput,
) => CodexAppServerConnection;

export interface CodexAppServerRunTurnInput {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  model: string;
  effort?: "low" | "medium" | "high" | "max";
  agent?: Pick<AgentConfig, "name" | "capabilities" | "role" | "agentic_mode">;
  baseDir?: string;
  configuredAdditionalDirectories?: string[];
  taskType?: string;
  resumeThreadId?: string;
  codexHome?: string;
  attachments?: FileAttachment[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: HarnessRuntimeEvent) => void;
  freshConnection?: boolean;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface UsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

interface TurnCollector {
  providerThreadId?: string;
  providerTurnId?: string;
  textParts: string[];
  tokensIn: number;
  tokensOut: number;
  toolsUsed: Set<string>;
  startedAt?: number;
  inputRequest?: InputRequest;
  completed: boolean;
}

interface HarnessContext {
  key?: string;
  connection: CodexAppServerConnection;
  nextRequestId: number;
  pending: Map<string, PendingRequest>;
  events: HarnessRuntimeEvent[];
  collector?: TurnCollector;
  resolveTurn?: () => void;
  rejectTurn?: (error: Error) => void;
  onEvent?: (event: HarnessRuntimeEvent) => void;
  initialized: boolean;
  closed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function readObject(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" ? value as JsonRecord : undefined;
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsageNumber(record: JsonRecord | undefined, keys: string[]): number {
  for (const key of keys) {
    const value = readNumber(record?.[key]);
    if (value !== undefined) return value;
  }
  return 0;
}

function readUsageSnapshot(...candidates: unknown[]): UsageSnapshot | undefined {
  for (const candidate of candidates) {
    const usage = readObject(candidate);
    if (!usage) continue;
    const inputTokens = readUsageNumber(usage, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"]);
    const cachedInputTokens = readUsageNumber(usage, ["cached_input_tokens", "cache_read_input_tokens", "cachedInputTokens", "cacheReadInputTokens"]);
    const outputTokens = readUsageNumber(usage, ["output_tokens", "completion_tokens", "outputTokens", "completionTokens"]);
    if (inputTokens > 0 || cachedInputTokens > 0 || outputTokens > 0) {
      return { inputTokens, cachedInputTokens, outputTokens };
    }
  }
  return undefined;
}

function buildEnv(input: Omit<CodexAppServerRunTurnInput, "prompt" | "model">): Record<string, string> {
  return {
    ...input.env,
    ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),
  };
}

function hashEnv(env: Record<string, string>): string {
  const stable = Object.keys(env).sort().map((key) => [key, env[key]]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

function buildPoolKey(input: Omit<CodexAppServerRunTurnInput, "prompt" | "model">, env: Record<string, string>): string {
  return [input.binaryPath, input.cwd, hashEnv(env)].join("\0");
}

function maybeUnrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
  maybeTimer.unref?.();
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  const record = readObject(value);
  return !!record && (typeof record.id === "string" || typeof record.id === "number") && typeof record.method === "string";
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  const record = readObject(value);
  return !!record && !("id" in record) && typeof record.method === "string";
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  const record = readObject(value);
  return !!record && (typeof record.id === "string" || typeof record.id === "number") && !("method" in record);
}

function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "nyxhive",
      title: "NyxHive",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

function requiresHostProcessAuthority(prompt: string): boolean {
  return /\b(restart|stop|start|kill|signal|tmux|launchctl|pkill|lsof|ps)\b/i.test(prompt);
}

function mapRuntimeMode(input: CodexAppServerRunTurnInput) {
  const decision = resolveCodexSecurityDecision({
    agent: input.agent,
    workingDirectory: input.cwd,
    baseDir: input.baseDir,
    configuredAdditionalDirectories: input.configuredAdditionalDirectories,
    taskType: input.taskType,
    requireExecutableAuthority: !!input.agent,
    requiresExternalMutation: requiresHostProcessAuthority(input.prompt),
  });
  const config = decision.sandboxMode === "workspace-write" && decision.additionalDirectories.length > 0
    ? {
        sandbox_workspace_write: {
          writable_roots: decision.additionalDirectories,
        },
      }
    : undefined;
  return {
    decision,
    params: {
      approvalPolicy: decision.approvalPolicy,
      sandbox: decision.sandboxMode,
      ...(config ? { config } : {}),
      ...(decision.additionalDirectories.length > 0 ? { additionalDirectories: decision.additionalDirectories } : {}),
    },
  };
}

function normalizeCodexModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  const aliases: Record<string, string> = {
    "gpt-5": "gpt-5.5",
    "gpt-5-codex": "gpt-5.5",
    "5.5": "gpt-5.5",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
  };
  return aliases[value] ?? value;
}

function isFatalCodexRouterStderr(message: string): boolean {
  return message.includes("write_stdin failed")
    || message.includes("stdin is closed")
    || message.includes("Reading prompt from stdin")
    || message.includes("Unknown process id");
}

function readAccountSnapshot(result: unknown): {
  accountType: "apiKey" | "chatgpt" | "unknown";
  planType?: string;
  authenticated: boolean;
} {
  const record = readObject(result);
  const account = readObject(record?.account) ?? record;
  const type = readString(account?.type);
  if (type === "apiKey") return { accountType: "apiKey", authenticated: true };
  if (type === "chatgpt") {
    const planType = readString(account?.planType);
    return { accountType: "chatgpt", ...(planType ? { planType } : {}), authenticated: true };
  }
  return { accountType: "unknown", authenticated: false };
}

function readModels(result: unknown): string[] {
  const record = readObject(result);
  const rawModels = readArray(record?.models) ?? readArray(record?.data) ?? [];
  return rawModels.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const model = readObject(entry);
    const slug = readString(model?.slug) ?? readString(model?.id) ?? readString(model?.model);
    return slug ? [slug] : [];
  });
}

function readProviderThreadId(result: unknown): string | undefined {
  const record = readObject(result);
  const thread = readObject(record?.thread);
  return readString(thread?.id) ?? readString(record?.threadId);
}

function readTurnId(result: unknown): string | undefined {
  const record = readObject(result);
  const turn = readObject(record?.turn);
  return readString(turn?.id) ?? readString(record?.turnId);
}

function fileToDataUrl(file: FileAttachment): string {
  return `data:${file.mimeType};base64,${file.base64}`;
}

function extractInputRequest(params: unknown): InputRequest {
  const record = readObject(params);
  const question =
    readString(record?.question)
    ?? readString(readObject(record?.request)?.question)
    ?? "Codex requested input.";
  const optionsRaw = readArray(record?.options) ?? readArray(readObject(record?.request)?.options) ?? [];
  const options = optionsRaw.flatMap((option) => {
    const opt = readObject(option);
    const key = readString(opt?.key) ?? readString(opt?.label);
    if (!key) return [];
    const description = readString(opt?.description);
    return [{ key, ...(description ? { description } : {}) }];
  });
  return {
    question,
    ...(options.length > 0 ? { options } : {}),
  };
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  callback: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/g);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) callback(line);
    }
  }
  if (buffer.trim()) callback(buffer);
}

export function createBunCodexAppServerConnection(
  input: CodexAppServerConnectionInput,
): CodexAppServerConnection {
  const lineCallbacks = new Set<(line: string) => void>();
  const stderrCallbacks = new Set<(line: string) => void>();
  const exitCallbacks = new Set<(code: number | null, signal: string | null) => void>();
  const proc = Bun.spawn([input.binaryPath, "app-server"], {
    cwd: input.cwd,
    env: input.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  void readLines(proc.stdout, (line) => {
    for (const callback of lineCallbacks) callback(line);
  });
  void readLines(proc.stderr, (line) => {
    for (const callback of stderrCallbacks) callback(line);
  });
  void proc.exited.then((code) => {
    for (const callback of exitCallbacks) callback(code, null);
  });

  return {
    send(message: unknown): void {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    },
    close(): void {
      proc.kill();
    },
    onLine(callback: (line: string) => void): void {
      lineCallbacks.add(callback);
    },
    onStderr(callback: (line: string) => void): void {
      stderrCallbacks.add(callback);
    },
    onExit(callback: (code: number | null, signal: string | null) => void): void {
      exitCallbacks.add(callback);
    },
  };
}

export class CodexAppServerHarness implements AgentHarness<Omit<CodexAppServerRunTurnInput, "prompt" | "model">, CodexAppServerRunTurnInput> {
  readonly id = "codex_app_server";
  readonly runtime = "codex_app_server" as const;
  readonly provider = "openai" as const;
  private readonly connectionFactory: CodexAppServerConnectionFactory;
  private readonly now: () => number;
  private readonly reuseConnections: boolean;
  private readonly idleTtlMs: number;
  private readonly contexts = new Map<string, HarnessContext>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(opts: {
    connectionFactory?: CodexAppServerConnectionFactory;
    now?: () => number;
    reuseConnections?: boolean;
    idleTtlMs?: number;
  } = {}) {
    this.connectionFactory = opts.connectionFactory ?? createBunCodexAppServerConnection;
    this.now = opts.now ?? (() => Date.now());
    this.reuseConnections = opts.reuseConnections ?? false;
    this.idleTtlMs = opts.idleTtlMs ?? 10 * 60_000;
  }

  supports(ctx: { runtime: "codex_app_server" }): { supported: true; priority: number } | { supported: false; reason: string } {
    return ctx.runtime === "codex_app_server"
      ? { supported: true, priority: 100 }
      : { supported: false, reason: "Codex app-server harness only supports codex_app_server runtime" };
  }

  async discover(input: Omit<CodexAppServerRunTurnInput, "prompt" | "model">): Promise<HarnessDiscovery> {
    return this.withContext(input, async (context) => {
      const [modelsResult, accountResult] = await Promise.all([
        this.sendRequest(context, "model/list", {}),
        this.sendRequest(context, "account/read", {}),
      ]);
      const account = readAccountSnapshot(accountResult);
      return {
        runtime: "codex_app_server",
        provider: "openai",
        authenticated: account.authenticated,
        accountType: account.accountType,
        ...(account.planType ? { planType: account.planType } : {}),
        models: readModels(modelsResult),
      };
    });
  }

  async runTurn(input: CodexAppServerRunTurnInput): Promise<HarnessTurnResult> {
    return this.withContext(input, async (context) => {
      context.onEvent = input.onEvent;
      const collector: TurnCollector = {
        textParts: [],
        tokensIn: 0,
        tokensOut: 0,
        toolsUsed: new Set(),
        completed: false,
      };
      context.collector = collector;
      const [modelsResult, accountResult] = await Promise.all([
        this.sendRequest(context, "model/list", {}),
        this.sendRequest(context, "account/read", {}),
      ]);
      const account = readAccountSnapshot(accountResult);
      this.recordEvent(context, {
        kind: "account.updated",
        runtime: "codex_app_server",
        provider: "openai",
        message: account.accountType,
        payload: accountResult,
        timestamp: this.now(),
      });
      this.recordEvent(context, {
        kind: "model.listed",
        runtime: "codex_app_server",
        provider: "openai",
        payload: readModels(modelsResult),
        timestamp: this.now(),
      });

      const runtimeMode = mapRuntimeMode(input);
      const authorityEvent: HarnessRuntimeEvent = {
        kind: "authority.resolved",
        runtime: "codex_app_server",
        provider: "openai",
        payload: runtimeMode.decision,
        timestamp: this.now(),
      };
      context.events.unshift(authorityEvent);
      context.onEvent?.(authorityEvent);

      const threadParams = {
        cwd: input.cwd,
        model: normalizeCodexModel(input.model) ?? input.model,
        experimentalRawEvents: false,
        ephemeral: true,
        serviceName: "nyxhive",
        ...runtimeMode.params,
      };
      const resumeThreadParams = {
        cwd: threadParams.cwd,
        model: threadParams.model,
        experimentalRawEvents: threadParams.experimentalRawEvents,
        ...runtimeMode.params,
        threadId: input.resumeThreadId,
      };
      const threadResult = input.resumeThreadId
        ? await this.sendRequest(context, "thread/resume", resumeThreadParams)
        : await this.sendRequest(context, "thread/start", threadParams);
      const providerThreadId = readProviderThreadId(threadResult);
      if (!providerThreadId) {
        throw new Error("codex app-server did not return a provider thread id.");
      }
      collector.providerThreadId = providerThreadId;
      this.recordEvent(context, {
        kind: input.resumeThreadId ? "session.resumed" : "session.started",
        runtime: "codex_app_server",
        provider: "openai",
        threadId: providerThreadId,
        timestamp: this.now(),
      });

      const turnCompletion = new Promise<void>((resolve, reject) => {
        context.resolveTurn = resolve;
        context.rejectTurn = reject;
      });
      const turnInput: Array<{ type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }> = [
        { type: "text", text: input.prompt, text_elements: [] },
      ];
      for (const file of input.attachments ?? []) {
        if (file.mimeType.startsWith("image/")) {
          turnInput.push({ type: "image", url: fileToDataUrl(file) });
        }
      }
      collector.startedAt = this.now();
      const turnResult = await this.sendRequest(context, "turn/start", {
        threadId: providerThreadId,
        input: turnInput,
        model: normalizeCodexModel(input.model) ?? input.model,
        ...(input.effort ? { effort: input.effort } : {}),
      });
      collector.providerTurnId = readTurnId(turnResult);
      this.recordEvent(context, {
        kind: "turn.started",
        runtime: "codex_app_server",
        provider: "openai",
        threadId: providerThreadId,
        ...(collector.providerTurnId ? { turnId: collector.providerTurnId } : {}),
        timestamp: this.now(),
      });

      const timeout = setTimeout(() => {
        context.rejectTurn?.(new Error(`codex app-server timed out after ${input.timeoutMs ?? 1_200_000}ms`));
      }, input.timeoutMs ?? 1_200_000);
      const onAbort = () => {
        this.evictContext(context);
        context.rejectTurn?.(new Error("codex app-server aborted."));
      };
      if (input.signal?.aborted) {
        onAbort();
      } else {
        input.signal?.addEventListener("abort", onAbort, { once: true });
      }
      try {
        await turnCompletion;
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      }

      const response = collector.textParts.join("").trim();
      if (!response && !collector.inputRequest) {
        throw new Error("codex app-server completed without an assistant response");
      }

      return {
        runtime: "codex_app_server",
        providerThreadId,
        ...(collector.providerTurnId ? { providerTurnId: collector.providerTurnId } : {}),
        response,
        tokensIn: collector.tokensIn || undefined,
        tokensOut: collector.tokensOut || undefined,
        toolsUsed: collector.toolsUsed.size > 0 ? [...collector.toolsUsed] : undefined,
        inputRequest: collector.inputRequest,
        events: [...context.events],
      };
    });
  }

  closeAll(): void {
    for (const context of this.contexts.values()) {
      this.closeContext(context);
    }
    this.contexts.clear();
  }

  private async withContext<T>(
    input: Omit<CodexAppServerRunTurnInput, "prompt" | "model">,
    operation: (context: HarnessContext) => Promise<T>,
  ): Promise<T> {
    const env = buildEnv(input);
    if (!this.reuseConnections || input.freshConnection) {
      const context = this.createContext(input, env);
      return this.executeWithContext(context, operation, true);
    }

    const key = buildPoolKey(input, env);
    const previous = this.queues.get(key)?.catch(() => undefined) ?? Promise.resolve();
    const abortError = () => new Error("codex app-server aborted.");
    const run = previous.then(() => {
      if (input.signal?.aborted) throw abortError();
      return this.executeWithPooledContext(input, env, key, operation, 1);
    });
    const queue = run.then(() => undefined, () => undefined);
    this.queues.set(key, queue);
    void queue.finally(() => {
      if (this.queues.get(key) === queue) {
        this.queues.delete(key);
      }
    });
    return run;
  }

  private async executeWithPooledContext<T>(
    input: Omit<CodexAppServerRunTurnInput, "prompt" | "model">,
    env: Record<string, string>,
    key: string,
    operation: (context: HarnessContext) => Promise<T>,
    retriesRemaining: number,
  ): Promise<T> {
    const context = this.getPooledContext(input, env, key);
    try {
      return await this.executeWithContext(context, operation, false);
    } catch (error) {
      if (retriesRemaining > 0 && this.shouldRetryWithFreshContext(error)) {
        this.evictContext(context);
        return this.executeWithPooledContext(input, env, key, operation, retriesRemaining - 1);
      }
      throw error;
    }
  }

  private async executeWithContext<T>(
    context: HarnessContext,
    operation: (context: HarnessContext) => Promise<T>,
    closeAfterOperation: boolean,
  ): Promise<T> {
    this.clearIdleTimer(context);
    context.events = [];
    context.collector = undefined;
    context.resolveTurn = undefined;
    context.rejectTurn = undefined;
    context.onEvent = undefined;
    try {
      await this.ensureInitialized(context);
      return await operation(context);
    } catch (error) {
      if (context.closed || this.shouldResetContext(error)) {
        this.evictContext(context);
      }
      throw error;
    } finally {
      context.collector = undefined;
      context.resolveTurn = undefined;
      context.rejectTurn = undefined;
      context.onEvent = undefined;
      if (closeAfterOperation) {
        this.closeContext(context);
      } else if (!context.closed) {
        this.scheduleIdleClose(context);
      }
    }
  }

  private getPooledContext(
    input: Omit<CodexAppServerRunTurnInput, "prompt" | "model">,
    env: Record<string, string>,
    key: string,
  ): HarnessContext {
    const existing = this.contexts.get(key);
    if (existing && !existing.closed) return existing;
    const context = this.createContext(input, env, key);
    this.contexts.set(key, context);
    return context;
  }

  private createContext(
    input: Omit<CodexAppServerRunTurnInput, "prompt" | "model">,
    preparedEnv?: Record<string, string>,
    key?: string,
  ): HarnessContext {
    const env = preparedEnv ?? buildEnv(input);
    const context: HarnessContext = {
      key,
      connection: this.connectionFactory({ binaryPath: input.binaryPath, cwd: input.cwd, env }),
      nextRequestId: 1,
      pending: new Map<string, PendingRequest>(),
      events: [] as HarnessRuntimeEvent[],
      initialized: false,
      closed: false,
    };
    context.connection.onLine((line) => this.handleLine(context, line));
    context.connection.onStderr((line) => {
      const message = line.trim();
      if (!message) return;
      this.recordEvent(context, {
        kind: "turn.failed",
        runtime: "codex_app_server",
        provider: "openai",
        message,
        timestamp: this.now(),
      });
      if (isFatalCodexRouterStderr(message)) {
        if (context.collector) {
          context.collector.completed = true;
        }
        this.evictContext(context);
        context.rejectTurn?.(new Error(message));
      }
    });
    context.connection.onExit((code, signal) => {
      context.closed = true;
      context.initialized = false;
      this.clearIdleTimer(context);
      const error = new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
      for (const pending of context.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      context.pending.clear();
      if (!context.collector?.completed) context.rejectTurn?.(error);
      this.recordEvent(context, {
        kind: "session.closed",
        runtime: "codex_app_server",
        provider: "openai",
        message: error.message,
        timestamp: this.now(),
      });
      if (context.key && this.contexts.get(context.key) === context) {
        this.contexts.delete(context.key);
      }
    });
    return context;
  }

  private async ensureInitialized(context: HarnessContext): Promise<void> {
    if (context.closed) throw new Error("codex app-server connection is closed.");
    if (context.initialized) {
      this.recordEvent(context, {
        kind: "connection.reused",
        runtime: "codex_app_server",
        provider: "openai",
        timestamp: this.now(),
      });
      return;
    }
    await this.sendRequest(context, "initialize", buildCodexInitializeParams());
    context.connection.send({ method: "initialized" });
    context.initialized = true;
    this.recordEvent(context, {
      kind: "connection.started",
      runtime: "codex_app_server",
      provider: "openai",
      timestamp: this.now(),
    });
  }

  private shouldResetContext(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("codex app-server exited")
      || message.includes("codex app-server connection is closed")
      || message.includes("Received invalid JSON from codex app-server")
      || message.includes("Timed out waiting for codex app-server")
      || message.includes("codex app-server timed out after")
      || isFatalCodexRouterStderr(message);
  }

  private shouldRetryWithFreshContext(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("codex app-server connection is closed")
      || message.includes("codex app-server exited")
      || message.includes("Received invalid JSON from codex app-server")
      || message.includes("Timed out waiting for codex app-server")
      || isFatalCodexRouterStderr(message);
  }

  private scheduleIdleClose(context: HarnessContext): void {
    if (this.idleTtlMs <= 0) return;
    context.idleTimer = setTimeout(() => {
      this.evictContext(context);
    }, this.idleTtlMs);
    maybeUnrefTimer(context.idleTimer);
  }

  private clearIdleTimer(context: HarnessContext): void {
    if (!context.idleTimer) return;
    clearTimeout(context.idleTimer);
    context.idleTimer = undefined;
  }

  private evictContext(context: HarnessContext): void {
    this.closeContext(context);
    if (context.key && this.contexts.get(context.key) === context) {
      this.contexts.delete(context.key);
    }
  }

  private closeContext(context: HarnessContext): void {
    if (context.closed) return;
    context.closed = true;
    context.initialized = false;
    this.clearIdleTimer(context);
    context.connection.close();
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("codex app-server connection closed."));
    }
    context.pending.clear();
  }

  private recordEvent(context: HarnessContext, event: HarnessRuntimeEvent): void {
    context.events.push(event);
    context.onEvent?.(event);
  }

  private sendRequest(
    context: HarnessContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<unknown> {
    const id = context.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for codex app-server ${method}.`));
      }, timeoutMs);
      context.pending.set(String(id), { method, resolve, reject, timeout });
      context.connection.send({ id, method, params });
    });
  }

  private handleLine(context: HarnessContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      context.rejectTurn?.(new Error("Received invalid JSON from codex app-server."));
      return;
    }

    if (isJsonRpcResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }
    if (isJsonRpcRequest(parsed)) {
      this.handleRequest(context, parsed);
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      this.handleNotification(context, parsed);
    }
  }

  private handleResponse(
    context: HarnessContext,
    response: JsonRpcResponse,
  ): void {
    const pending = context.pending.get(String(response.id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    context.pending.delete(String(response.id));
    const message = readString(response.error?.message);
    if (message) {
      pending.reject(new Error(`${pending.method} failed: ${message}`));
      return;
    }
    pending.resolve(response.result);
  }

  private handleRequest(
    context: HarnessContext,
    request: JsonRpcRequest,
  ): void {
    const collector = context.collector;
    const params = readObject(request.params);
    const threadId = readString(params?.threadId) ?? collector?.providerThreadId;
    const turnId = readString(params?.turnId) ?? collector?.providerTurnId;
    const itemId = readString(params?.itemId);

    if (
      request.method === "item/commandExecution/requestApproval"
      || request.method === "item/fileRead/requestApproval"
      || request.method === "item/fileChange/requestApproval"
    ) {
      this.recordEvent(context, {
        kind: "approval.requested",
        runtime: "codex_app_server",
        provider: "openai",
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(itemId ? { itemId } : {}),
        payload: request.params,
        timestamp: this.now(),
      });
      context.connection.send({ id: request.id, result: { decision: "decline" } });
      context.rejectTurn?.(new Error(`Unexpected Codex approval request in strict mode: ${request.method}`));
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      const inputRequest = extractInputRequest(request.params);
      if (collector) collector.inputRequest = inputRequest;
      this.recordEvent(context, {
        kind: "user_input.requested",
        runtime: "codex_app_server",
        provider: "openai",
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(itemId ? { itemId } : {}),
        payload: request.params,
        timestamp: this.now(),
      });
      context.connection.send({ id: request.id, result: { answers: { answers: [] } } });
      return;
    }

    context.connection.send({
      id: request.id,
      error: { code: -32601, message: `Unsupported codex app-server request: ${request.method}` },
    });
  }

  private handleNotification(
    context: HarnessContext,
    notification: JsonRpcNotification,
  ): void {
    const collector = context.collector;
    if (!collector) return;

    const params = readObject(notification.params);
    const threadId = readString(params?.threadId) ?? collector.providerThreadId;
    const turnId = readString(params?.turnId) ?? collector.providerTurnId;
    const itemId = readString(params?.itemId);
    const item = readObject(params?.item);

    if (notification.method === "item/agentMessage/delta") {
      const delta = readString(params?.delta);
      if (delta) {
        collector.textParts.push(delta);
        this.recordEvent(context, {
          kind: "content.delta",
          runtime: "codex_app_server",
          provider: "openai",
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          message: delta,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (notification.method === "item/started" && item) {
      const type = readString(item.type);
      const toolName = this.mapToolName(type);
      if (toolName) {
        collector.toolsUsed.add(toolName);
        this.recordEvent(context, {
          kind: "tool.started",
          runtime: "codex_app_server",
          provider: "openai",
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {}),
          itemId: readString(item.id) ?? itemId,
          message: toolName,
          payload: item,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (notification.method === "item/completed" && item) {
      const type = readString(item.type);
      if (type === "agentMessage") {
        const text = readString(item.text);
        if (text && collector.textParts.length === 0) collector.textParts.push(text);
      }
      const toolName = this.mapToolName(type);
      if (toolName) {
        collector.toolsUsed.add(toolName);
        this.recordEvent(context, {
          kind: "tool.completed",
          runtime: "codex_app_server",
          provider: "openai",
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {}),
          itemId: readString(item.id) ?? itemId,
          message: toolName,
          payload: item,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (notification.method === "turn/started") {
      const turn = readObject(params?.turn);
      collector.providerTurnId = readString(turn?.id) ?? collector.providerTurnId;
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = readObject(params?.turn);
      const usage = readUsageSnapshot(
        turn?.usage,
        params?.usage,
        readObject(turn?.metrics)?.usage,
        readObject(params?.metrics)?.usage,
      );
      if (usage) {
        const tokensIn = usage.inputTokens + usage.cachedInputTokens;
        collector.tokensIn += tokensIn;
        collector.tokensOut += usage.outputTokens;
        this.recordEvent(context, {
          kind: "usage.updated",
          runtime: "codex_app_server",
          provider: "openai",
          ...(threadId ? { threadId } : {}),
          ...(collector.providerTurnId ? { turnId: collector.providerTurnId } : turnId ? { turnId } : {}),
          tokensIn,
          tokensOut: usage.outputTokens,
          payload: usage,
          timestamp: this.now(),
        });
      }
      collector.completed = true;
      this.recordEvent(context, {
        kind: "turn.completed",
        runtime: "codex_app_server",
        provider: "openai",
        ...(threadId ? { threadId } : {}),
        ...(collector.providerTurnId ? { turnId: collector.providerTurnId } : turnId ? { turnId } : {}),
        ...(collector.startedAt !== undefined ? { durationMs: this.now() - collector.startedAt } : {}),
        payload: notification.params,
        timestamp: this.now(),
      });
      context.resolveTurn?.();
      return;
    }

    if (notification.method === "error") {
      const message = readString(readObject(params?.error)?.message) ?? "codex app-server error";
      collector.completed = true;
      this.recordEvent(context, {
        kind: "turn.failed",
        runtime: "codex_app_server",
        provider: "openai",
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        message,
        payload: notification.params,
        timestamp: this.now(),
      });
      context.rejectTurn?.(new Error(message));
    }
  }

  private mapToolName(type: string | undefined): string | undefined {
    if (!type) return undefined;
    const names: Record<string, string> = {
      commandExecution: "command_execution",
      command_execution: "command_execution",
      fileRead: "file_read",
      file_read: "file_read",
      fileChange: "file_change",
      file_change: "file_change",
      webSearch: "web_search",
      web_search: "web_search",
      mcpTool: "mcp_tool",
      mcp_tool: "mcp_tool",
    };
    return names[type];
  }
}

const sharedCodexAppServerHarness = new CodexAppServerHarness({ reuseConnections: true });
registerHarness(sharedCodexAppServerHarness);

export function getSharedCodexAppServerHarness(): CodexAppServerHarness {
  return sharedCodexAppServerHarness;
}

export function closeSharedCodexAppServerHarness(): void {
  sharedCodexAppServerHarness.closeAll();
}
