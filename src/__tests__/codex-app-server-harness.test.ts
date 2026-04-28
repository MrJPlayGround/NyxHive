import { describe, expect, test } from "bun:test";
import {
  CodexAppServerHarness,
  type CodexAppServerConnection,
  type CodexAppServerConnectionInput,
} from "../harness/codex-app-server.js";

class FakeCodexConnection implements CodexAppServerConnection {
  readonly sent: unknown[] = [];
  closeCount = 0;
  private readonly lineCallbacks = new Set<(line: string) => void>();
  private readonly stderrCallbacks = new Set<(line: string) => void>();
  private readonly exitCallbacks = new Set<(code: number | null, signal: string | null) => void>();

  constructor(private readonly scenario: "complete" | "approval" | "discover" | "camelUsage" | "stall" | "fatalStdin" | "empty" = "complete") {}

  send(message: unknown): void {
    this.sent.push(message);
    const record = message as { id?: number; method?: string; params?: Record<string, unknown> };
    if (!record.id) return;

    queueMicrotask(() => {
      if (record.method === "initialize") {
        this.emit({ id: record.id, result: { ok: true } });
        return;
      }
      if (record.method === "model/list") {
        this.emit({ id: record.id, result: { models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.3-codex" }] } });
        return;
      }
      if (record.method === "account/read") {
        this.emit({ id: record.id, result: { account: { type: "chatgpt", planType: "pro" } } });
        return;
      }
      if (record.method === "thread/start" || record.method === "thread/resume") {
        this.emit({ id: record.id, result: { thread: { id: record.params?.threadId ?? "thread_1" } } });
        return;
      }
      if (record.method === "turn/start") {
        this.emit({ id: record.id, result: { turn: { id: "turn_1" } } });
        if (this.scenario === "stall") return;
        if (this.scenario === "fatalStdin") {
          this.emitStderr("2026-04-23T16:28:09.373067Z ERROR codex_core::tools::router: error=write_stdin failed: Unknown process id 15074");
          return;
        }
        if (this.scenario === "approval") {
          this.emit({
            id: 99,
            method: "item/commandExecution/requestApproval",
            params: { threadId: "thread_1", turnId: "turn_1", itemId: "item_1", command: "rm -rf ." },
          });
          return;
        }
        if (this.scenario === "discover") return;
        if (this.scenario === "empty") {
          this.emit({
            method: "turn/completed",
            params: { threadId: "thread_1", turn: { id: "turn_1", status: "completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 } } },
          });
          return;
        }
        this.emit({ method: "turn/started", params: { threadId: "thread_1", turn: { id: "turn_1" } } });
        this.emit({ method: "item/agentMessage/delta", params: { threadId: "thread_1", turnId: "turn_1", itemId: "msg_1", delta: "Hello" } });
        this.emit({ method: "item/agentMessage/delta", params: { threadId: "thread_1", turnId: "turn_1", itemId: "msg_1", delta: " Nyx" } });
        if (this.scenario === "camelUsage") {
          this.emit({ method: "item/started", params: { threadId: "thread_1", turnId: "turn_1", item: { id: "read_1", type: "fileRead" } } });
          this.emit({ method: "item/completed", params: { threadId: "thread_1", turnId: "turn_1", item: { id: "read_1", type: "fileRead" } } });
          this.emit({
            method: "turn/completed",
            params: { threadId: "thread_1", turn: { id: "turn_1", status: "completed", usage: { inputTokens: 20, cachedInputTokens: 3, outputTokens: 7 } } },
          });
          return;
        }
        this.emit({ method: "item/completed", params: { threadId: "thread_1", turnId: "turn_1", item: { id: "cmd_1", type: "commandExecution" } } });
        this.emit({
          method: "turn/completed",
          params: { threadId: "thread_1", turn: { id: "turn_1", status: "completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 } } },
        });
      }
    });
  }

  close(): void {
    this.closeCount += 1;
  }

  onLine(callback: (line: string) => void): void {
    this.lineCallbacks.add(callback);
  }

  onStderr(callback: (line: string) => void): void {
    this.stderrCallbacks.add(callback);
  }

  onExit(callback: (code: number | null, signal: string | null) => void): void {
    this.exitCallbacks.add(callback);
  }

  emit(message: unknown): void {
    const line = JSON.stringify(message);
    for (const callback of this.lineCallbacks) callback(line);
  }

  emitStderr(line: string): void {
    for (const callback of this.stderrCallbacks) callback(line);
  }

  emitExit(code: number | null = 0, signal: string | null = null): void {
    for (const callback of this.exitCallbacks) callback(code, signal);
  }
}

function makeHarness(connection: FakeCodexConnection, opts: { reuseConnections?: boolean } = {}): CodexAppServerHarness {
  return new CodexAppServerHarness({
    connectionFactory: (_input: CodexAppServerConnectionInput) => connection,
    now: () => 123,
    ...opts,
  });
}

describe("CodexAppServerHarness", () => {
  test("discovers Codex account and model state over app-server JSON-RPC", async () => {
    const connection = new FakeCodexConnection("discover");
    const harness = makeHarness(connection);

    const result = await harness.discover({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
    });

    expect(result).toEqual({
      runtime: "codex_app_server",
      provider: "openai",
      authenticated: true,
      accountType: "chatgpt",
      planType: "pro",
      models: ["gpt-5.5", "gpt-5.3-codex"],
    });
    expect(connection.sent).toContainEqual({ method: "initialized" });
  });

  test("runs a least-privilege turn and returns a resumable provider thread id", async () => {
    const connection = new FakeCodexConnection();
    const harness = makeHarness(connection);

    const result = await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Say hello",
      model: "gpt-5.5",
    });

    expect(result.response).toBe("Hello Nyx");
    expect(result.providerThreadId).toBe("thread_1");
    expect(result.providerTurnId).toBe("turn_1");
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(4);
    expect(result.toolsUsed).toEqual(["command_execution"]);
    expect(result.events[0]).toMatchObject({
      kind: "authority.resolved",
      runtime: "codex_app_server",
      provider: "openai",
      payload: {
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
    });
    expect(result.events.map((event) => event.kind)).toContain("turn.completed");
    expect(result.events.find((event) => event.kind === "usage.updated")).toMatchObject({
      tokensIn: 12,
      tokensOut: 4,
    });
    expect(connection.sent).toContainEqual({
      id: 4,
      method: "thread/start",
      params: {
        cwd: "/tmp/project",
        model: "gpt-5.5",
        experimentalRawEvents: false,
        ephemeral: true,
        serviceName: "nyxhive",
        approvalPolicy: "never",
        sandbox: "read-only",
      },
    });
  });

  test("passes workspace writable roots through the app-server config override", async () => {
    const connection = new FakeCodexConnection();
    const harness = makeHarness(connection);

    await harness.runTurn({
      binaryPath: "codex",
      cwd: "/home/user/dev/nyxhive",
      env: {},
      prompt: "Update live config",
      model: "gpt-5.5",
      agent: {
        name: "Nyx",
        role: "lead",
        capabilities: ["tool_use"],
      },
      configuredAdditionalDirectories: [
        "/home/user/.nyxhive",
        "/home/user/dev/example-trading",
      ],
      taskType: "coding",
    });

    expect(connection.sent).toContainEqual({
      id: 4,
      method: "thread/start",
      params: {
        cwd: "/home/user/dev/nyxhive",
        model: "gpt-5.5",
        experimentalRawEvents: false,
        ephemeral: true,
        serviceName: "nyxhive",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: {
          sandbox_workspace_write: {
            writable_roots: [
              "/home/user/.nyxhive",
              "/home/user/dev/example-trading",
            ],
          },
        },
        additionalDirectories: [
          "/home/user/.nyxhive",
          "/home/user/dev/example-trading",
        ],
      },
    });
  });

  test("uses full host authority for explicit restart operations", async () => {
    const connection = new FakeCodexConnection();
    const harness = makeHarness(connection);

    await harness.runTurn({
      binaryPath: "codex",
      cwd: "/home/user/dev/nyxhive",
      env: {},
      prompt: "restart astra-trading and nyxlabs",
      model: "gpt-5.5",
      agent: {
        name: "Nyx",
        role: "lead",
        capabilities: ["tool_use"],
      },
      configuredAdditionalDirectories: [
        "/home/user/.nyxhive",
        "/home/user/dev/example-trading",
      ],
      taskType: "coding",
    });

    expect(connection.sent).toContainEqual({
      id: 4,
      method: "thread/start",
      params: {
        cwd: "/home/user/dev/nyxhive",
        model: "gpt-5.5",
        experimentalRawEvents: false,
        ephemeral: true,
        serviceName: "nyxhive",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        additionalDirectories: [
          "/home/user/.nyxhive",
          "/home/user/dev/example-trading",
        ],
      },
    });
  });

  test("resumes an existing provider thread when a session id is supplied", async () => {
    const connection = new FakeCodexConnection();
    const harness = makeHarness(connection);

    const result = await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Continue",
      model: "5.5",
      resumeThreadId: "thread_existing",
    });

    expect(result.providerThreadId).toBe("thread_existing");
    expect(connection.sent).toContainEqual({
      id: 4,
      method: "thread/resume",
      params: {
        cwd: "/tmp/project",
        model: "gpt-5.5",
        experimentalRawEvents: false,
        approvalPolicy: "never",
        sandbox: "read-only",
        threadId: "thread_existing",
      },
    });
  });

  test("fails loudly when a turn completes without assistant text", async () => {
    const connection = new FakeCodexConnection("empty");
    const harness = makeHarness(connection);

    await expect(harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Do the thing",
      model: "gpt-5.5",
    })).rejects.toThrow("codex app-server completed without an assistant response");
  });

  test("declines unexpected approval requests in strict mode and fails loudly", async () => {
    const connection = new FakeCodexConnection("approval");
    const harness = makeHarness(connection);

    await expect(harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Run risky command",
      model: "gpt-5.5",
      timeoutMs: 1000,
    })).rejects.toThrow("Unexpected Codex approval request in strict mode");

    expect(connection.sent).toContainEqual({ id: 99, result: { decision: "decline" } });
  });

  test("parses camelCase usage and records non-command tool events", async () => {
    const connection = new FakeCodexConnection("camelUsage");
    const harness = makeHarness(connection);

    const result = await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Read a file",
      model: "gpt-5.5",
    });

    expect(result.tokensIn).toBe(23);
    expect(result.tokensOut).toBe(7);
    expect(result.toolsUsed).toEqual(["file_read"]);
    expect(result.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["tool.started", "tool.completed", "usage.updated"]));
  });

  test("reuses a pooled app-server connection across serialized turns", async () => {
    const connection = new FakeCodexConnection();
    const harness = makeHarness(connection, { reuseConnections: true });

    await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "First",
      model: "gpt-5.5",
    });
    const second = await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Second",
      model: "gpt-5.5",
    });

    expect(connection.sent.filter((message) => (message as { method?: string }).method === "initialize")).toHaveLength(1);
    expect(second.events.map((event) => event.kind)).toContain("connection.reused");
    expect(connection.closeCount).toBe(0);
    harness.closeAll();
    expect(connection.closeCount).toBe(1);
  });

  test("can force fresh app-server connections for fragile interactive turns", async () => {
    const connections: FakeCodexConnection[] = [];
    const harness = new CodexAppServerHarness({
      connectionFactory: () => {
        const connection = new FakeCodexConnection();
        connections.push(connection);
        return connection;
      },
      now: () => 123,
      reuseConnections: true,
    });

    await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "First",
      model: "gpt-5.5",
      freshConnection: true,
    });
    await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Second",
      model: "gpt-5.5",
      freshConnection: true,
    });

    expect(connections).toHaveLength(2);
    expect(connections[0]?.closeCount).toBe(1);
    expect(connections[1]?.closeCount).toBe(1);
  });

  test("evicts a pooled connection after app-server exit and starts a fresh one", async () => {
    const connections: FakeCodexConnection[] = [];
    const harness = new CodexAppServerHarness({
      connectionFactory: () => {
        const connection = new FakeCodexConnection();
        connections.push(connection);
        return connection;
      },
      now: () => 123,
      reuseConnections: true,
    });

    await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "First",
      model: "gpt-5.5",
    });
    connections[0]?.emitExit(1, null);
    await harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Second",
      model: "gpt-5.5",
    });

    expect(connections).toHaveLength(2);
    expect(connections[1]?.sent.filter((message) => (message as { method?: string }).method === "initialize")).toHaveLength(1);
  });

  test("queued pooled turns reacquire a fresh connection after the previous turn times out", async () => {
    const connections: FakeCodexConnection[] = [];
    const harness = new CodexAppServerHarness({
      connectionFactory: () => {
        const connection = new FakeCodexConnection(connections.length === 0 ? "stall" : "complete");
        connections.push(connection);
        return connection;
      },
      now: () => 123,
      reuseConnections: true,
    });

    const first = harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Stall",
      model: "gpt-5.5",
      timeoutMs: 5,
    });
    const second = harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Second",
      model: "gpt-5.5",
    });

    await expect(first).rejects.toThrow("codex app-server timed out");
    await expect(second).resolves.toMatchObject({
      response: "Hello Nyx",
      providerThreadId: "thread_1",
    });
    expect(connections).toHaveLength(2);
    expect(connections[0]?.closeCount).toBe(1);
  });

  test("aborts a stalled pooled turn and frees the next queued turn", async () => {
    const connections: FakeCodexConnection[] = [];
    const harness = new CodexAppServerHarness({
      connectionFactory: () => {
        const connection = new FakeCodexConnection(connections.length === 0 ? "stall" : "complete");
        connections.push(connection);
        return connection;
      },
      now: () => 123,
      reuseConnections: true,
    });
    const abort = new AbortController();

    const first = harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Stall",
      model: "gpt-5.5",
      timeoutMs: 10_000,
      signal: abort.signal,
    });
    const second = harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Second",
      model: "gpt-5.5",
    });

    await Bun.sleep(1);
    abort.abort();

    await expect(first).rejects.toThrow("codex app-server aborted");
    await expect(second).resolves.toMatchObject({
      response: "Hello Nyx",
      providerThreadId: "thread_1",
    });
    expect(connections).toHaveLength(2);
    expect(connections[0]?.closeCount).toBe(1);
  });

  test("aborted queued pooled turns do not run later", async () => {
    const connections: FakeCodexConnection[] = [];
    const harness = new CodexAppServerHarness({
      connectionFactory: () => {
        const connection = new FakeCodexConnection(connections.length === 0 ? "stall" : "complete");
        connections.push(connection);
        return connection;
      },
      now: () => 123,
      reuseConnections: true,
    });
    const abort = new AbortController();

    const first = harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Stall",
      model: "gpt-5.5",
      timeoutMs: 5,
    });
    const second = harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Should not run",
      model: "gpt-5.5",
      signal: abort.signal,
    });

    abort.abort();

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult.status).toBe("rejected");
    expect(secondResult.status).toBe("rejected");
    if (firstResult.status === "rejected") {
      expect(firstResult.reason.message).toContain("codex app-server timed out");
    }
    if (secondResult.status === "rejected") {
      expect(secondResult.reason.message).toContain("codex app-server aborted");
    }
    expect(connections).toHaveLength(1);
  });

  test("retries a pooled turn on a fresh connection when app-server stderr reports a fatal stdin router failure", async () => {
    const connections: FakeCodexConnection[] = [];
    const harness = new CodexAppServerHarness({
      connectionFactory: () => {
        const connection = new FakeCodexConnection(connections.length === 0 ? "fatalStdin" : "complete");
        connections.push(connection);
        return connection;
      },
      now: () => 123,
      reuseConnections: true,
    });

    const turn = harness.runTurn({
      binaryPath: "codex",
      cwd: "/tmp/project",
      env: {},
      prompt: "Recover from fatal stdin routing",
      model: "gpt-5.5",
      timeoutMs: 1_000,
    });

    const result = await Promise.race([
      turn,
      Bun.sleep(50).then(() => "pending" as const),
    ]);

    expect(result).not.toBe("pending");
    expect(result).toMatchObject({
      response: "Hello Nyx",
      providerThreadId: "thread_1",
    });
    expect(connections).toHaveLength(2);
    expect(connections[0]?.closeCount).toBe(1);
  });
});
