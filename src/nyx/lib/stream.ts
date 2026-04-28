/**
 * SSE streaming utilities shared by nyx CLI commands.
 */

export interface SSEEvent {
  type: string;
  message_id?: string;
  response?: string;
  agent?: string;
  error?: string;
  status?: string;
  task?: string;
  [key: string]: unknown;
}

/**
 * Async generator that reads an SSE response stream and yields parsed events.
 * The caller is responsible for sending a POST request that returns text/event-stream.
 */
// How long to wait for the server to respond with headers.
// AbortSignal.timeout() must NOT be passed to fetch() directly — it applies to the full
// request lifetime including body streaming, which would kill long agent runs.
// Instead we race the fetch promise against a manual timer, then drop the timer once
// headers arrive so it never touches the body read loop.
const CONNECT_TIMEOUT_MS = 30_000;
// Idle timeout: max time between SSE chunks. Resets on every received chunk.
const IDLE_TIMEOUT_MS = 600_000; // 10 minutes

export async function* streamSSE(
  url: string,
  apiKey: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  // Race fetch against a plain timeout — once fetch resolves the timer is cleared
  // and has zero effect on the response body stream.
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const connectTimeoutPromise = new Promise<never>((_, reject) => {
    connectTimer = setTimeout(
      () => reject(new Error("Connect timeout: server did not respond in 30s")),
      CONNECT_TIMEOUT_MS,
    );
  });

  const res = await Promise.race([
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal, // only user-supplied abort — no timeout signal that would kill body reads
    }),
    connectTimeoutPromise,
  ]).finally(() => clearTimeout(connectTimer));

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? ": " + body.slice(0, 120) : ""}`);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    // Per-chunk idle timeout — reset on every received chunk.
    // This catches dead connections without killing long-running agent tasks.
    const idleAbort = new AbortController();
    const idleTimer = setTimeout(() => idleAbort.abort(new Error("SSE idle timeout")), IDLE_TIMEOUT_MS);

    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          idleAbort.signal.addEventListener("abort", () => reject(idleAbort.signal.reason), { once: true }),
        ),
      ]);
    } finally {
      clearTimeout(idleTimer);
    }

    // Propagate upstream abort after cleanup
    if (signal?.aborted) throw signal.reason;

    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n|\r/g, "\n");

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      // Skip SSE keepalive comments (`: ping` etc.) — they reset the idle timer but carry no data
      if (!part.trim() || part.startsWith(":")) continue;
      const dataLines = part
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
      if (dataLines.length === 0) continue;
      try {
        yield JSON.parse(dataLines.join("")) as SSEEvent;
      } catch { /* malformed chunk */ }
    }
  }
}
