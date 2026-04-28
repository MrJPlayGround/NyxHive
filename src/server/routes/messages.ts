import { Hono } from "hono";
import { z } from "zod";
import type { QueueProcessor } from "../../queue/processor.js";
import type { QueueDB } from "../../queue/db.js";
import type { AuthEnv } from "../../auth/types.js";
import { parseBody } from "./validate.js";
import { formatError } from "../../utils/error.js";
import { canRead, canWrite } from "../middleware/rbac.js";
import { CROSS_CHANNEL_DEDUP_WINDOW_MS, IOS_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, RELAY_SYNC_TIMEOUT_MS } from "../../defaults.js";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../../crawl/index.js";
import { formatCrawlCommandResult, isCrawlCommand, parseCrawlCommandText, runCrawlCommand } from "../../crawl/index.js";
import type { RelayOriginContext } from "../../types.js";
import type { DelegationRunStore } from "../../runs/store.js";
import { MAX_BASE64_ATTACHMENT_CHARS, normalizeInboundAttachments } from "../../security/attachments.js";
import { buildAttachmentBlockedPathReport } from "../../runs/blockers.js";
import { recordInboundArtifactAcquisitionFailures } from "../../artifacts/inbound.js";

const messageSchema = z.object({
  message: z.string().default(""),
  task_id: z.string().optional(),
  channel: z.string().optional(),
  sender: z.string().optional(),
  sender_id: z.string().optional(),
  agent: z.string().optional(),
  model_override: z.string().optional(),
  async: z.boolean().optional(),
  stream: z.boolean().optional(),
  mode: z.enum(["default", "ralph"]).optional(),
  benchmark: z.boolean().optional(),
  nonce: z.string().optional(),
  // Legacy image-only field
  images: z.array(z.object({
    type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: z.string().max(MAX_BASE64_ATTACHMENT_CHARS, "Image data exceeds 10MB limit"),
  })).max(5).optional(),
  // General file attachments (images, PDFs, CSVs, text, etc.)
  files: z.array(z.object({
    name: z.string(),
    type: z.string(),
    data: z.string().max(MAX_BASE64_ATTACHMENT_CHARS, "File data exceeds 10MB limit"),
  })).max(5).optional(),
  relay: z.object({
    origin_instance: z.string().min(1),
    callback_url: z.string().url(),
    callback_token: z.string().min(1),
  }).optional(),
}).superRefine((body, ctx) => {
  const hasAttachments = (body.images?.length ?? 0) + (body.files?.length ?? 0) > 0;
  if (!body.message.trim() && !hasAttachments) {
    ctx.addIssue({
      code: "custom",
      message: "message is required when no attachments are provided",
      path: ["message"],
    });
  }
});

function buildStatusMessage(msg: {
  last_progress_text?: string;
  last_activity?: string;
  status: string;
}): string | null {
  const progressText = msg.last_progress_text?.trim();
  if (progressText) return humanStatusFromActivity(progressText);

  const activity = msg.last_activity?.trim();
  if (!activity) return msg.status === "processing" ? "Nyx is working..." : null;

  return humanStatusFromActivity(activity);
}

function humanStatusFromActivity(activity: string): string {
  const normalized = activity.toLowerCase();
  if (
    normalized.includes("web")
    || normalized.includes("source")
    || normalized.includes("fetch")
    || normalized.includes("browse")
  ) {
    return "Nyx is checking sources...";
  }
  if (
    normalized.startsWith("reading ")
    || normalized.includes("read ")
    || normalized.includes("search")
    || normalized.includes("grep")
    || normalized.includes("glob")
    || normalized.includes("inspect")
  ) {
    return "Nyx is checking context...";
  }
  if (
    normalized.includes("classif")
    || normalized.includes("think")
    || normalized.includes("reason")
    || normalized.includes("response")
    || normalized.includes("respond")
  ) {
    return "Nyx is thinking...";
  }
  if (
    normalized.startsWith("running")
    || normalized.includes("command")
    || normalized.startsWith("writing ")
    || normalized.startsWith("editing ")
    || normalized.startsWith("updated ")
    || normalized.includes("file")
    || normalized.includes("tool")
    || normalized.includes("implement")
  ) {
    return "Nyx is working...";
  }
  return "Nyx is working...";
}

function getMessageStatus(msgStatus: string, hasResponse: boolean): string {
  if (msgStatus === "failed" || msgStatus === "dead_letter") return msgStatus;
  if (msgStatus === "suspended") return "suspended";
  if (hasResponse) return "completed";
  if (msgStatus === "processing") return "processing";
  if (msgStatus === "completed") return "completed";
  return "queued";
}

function getMessageError(status: string, lastError?: string): string | null {
  if (status !== "failed" && status !== "dead_letter") return null;
  return lastError?.trim() || null;
}

// Nonce-based dedup for relay messages — 5 minute TTL, max 500 entries
const NONCE_TTL_MS = 5 * 60_000;
const NONCE_MAX = 500;
const seenNonces = new Map<string, number>(); // nonce → timestamp

function checkAndRecordNonce(nonce: string): boolean {
  const now = Date.now();
  // Prune expired entries periodically
  if (seenNonces.size > NONCE_MAX) {
    for (const [k, ts] of seenNonces) {
      if (now - ts > NONCE_TTL_MS) seenNonces.delete(k);
    }
  }
  if (seenNonces.has(nonce)) return true; // duplicate
  seenNonces.set(nonce, now);
  return false;
}

export function messagesRoutes(
  processor: QueueProcessor,
  queue: QueueDB,
  opts?: {
    requestTimeoutMs?: number;
    relayTimeoutMs?: number;
    crawlService?: CrawlService;
    crawlSources?: CrawlSourceStore;
    crawlIngest?: CrawlIngestBridge;
    runs?: DelegationRunStore;
  },
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const replySchema = z.object({
    reply: z.string().min(1),
    async: z.boolean().optional().default(true),
  });

  const toRelayContext = (relay?: {
    origin_instance: string;
    callback_url: string;
    callback_token: string;
  }): RelayOriginContext | undefined => {
    if (!relay) return undefined;
    return {
      originInstance: relay.origin_instance,
      callbackUrl: relay.callback_url,
      callbackToken: relay.callback_token,
    };
  };

  // GET /api/message/:id — Check status of a message
  app.get("/:id", canRead, (c) => {
    const messageId = c.req.param("id");
    const msg = queue.getMessageByMessageId(messageId);
    if (!msg) return c.json({ error: "Message not found" }, 404);

    const response = queue.getResponseByMessageId(messageId);
    const status = getMessageStatus(msg.status, Boolean(response));
    const suspended = status === "suspended" ? queue.getSuspendedMessage(messageId) : null;
    return c.json({
      message_id: messageId,
      status,
      response: response?.message ?? null,
      input_request: suspended ? suspended.request : null,
      error: getMessageError(status, msg.last_error),
      agent: response?.agent ?? msg.agent ?? null,
      activity: response ? null : (msg.last_activity ?? null),
      progress_text: response ? null : (msg.last_progress_text ?? null),
      progress_at: response ? null : (msg.last_progress_at ?? null),
      status_message: response
        ? null
        : buildStatusMessage({
          last_progress_text: msg.last_progress_text,
          last_activity: msg.last_activity,
          status,
        }),
      created_at: msg.created_at,
      completed_at: response?.created_at ?? null,
    });
  });

  app.post("/:id/reply", canWrite, async (c) => {
    const messageId = c.req.param("id");
    const result = await parseBody(c, replySchema);
    if (result instanceof Response) return result;

    try {
      const resumed = await processor.resumeSuspendedMessage(messageId, result.reply, { async: result.async });
      return c.json(resumed, result.async ? 202 : 200);
    } catch (error) {
      return c.json({ error: formatError(error) }, 404);
    }
  });

  // POST /api/message/:id/cancel — Cancel an in-flight message
  app.post("/:id/cancel", canWrite, (c) => {
    const messageId = c.req.param("id");
    const result = processor.cancelMessage(messageId);
    if (result.cancelled) return c.json({ cancelled: true });
    return c.json({ error: result.error ?? "not found" }, 404);
  });

  // POST /api/message — Send a message to be processed
  app.post("/", canWrite, async (c) => {
    const result = await parseBody(c, messageSchema);
    if (result instanceof Response) return result;
    const body = result;

    const auth = c.get("auth");

    // When authenticated via session, override sender identity with the user's info
    const channel = body.channel ?? "api";
    const sender = auth?.type === "session" && auth.user
      ? auth.user.display_name
      : (body.sender ?? "api");
    const senderId = auth?.type === "session" && auth.user
      ? auth.user.id
      : (body.sender_id ?? "api_key");

    let files;
    try {
      files = normalizeInboundAttachments({ images: body.images, files: body.files });
    } catch (error) {
      const blockedPath = opts?.runs?.recordBlockedPath(buildAttachmentBlockedPathReport({
        error,
        channel,
        failed_path: "api.message.attachments.normalize",
      }));
      recordInboundArtifactAcquisitionFailures(opts?.runs, {
        channel,
        source_prefix: "api.message",
        error,
        images: body.images,
        files: body.files,
      });
      return c.json({
        error: formatError(error),
        ...(blockedPath ? { blocked_path: blockedPath } : {}),
      }, 400);
    }
    const mergedFiles = files.length > 0 ? files : undefined;

    // Nonce-based dedup for relay messages — catches retries even after content dedup window
    if (body.nonce && checkAndRecordNonce(body.nonce)) {
      return c.json({ status: "duplicate", hint: "Nonce already seen (relay dedup)" });
    }

    // Cross-channel dedup: only collapse retries from the same requester.
    const dedupIdentity = auth?.type === "session" && auth.user
      ? { sender: auth.user.display_name, senderId: auth.user.id }
      : { sender: body.sender, senderId: body.sender_id };
    const crossDup = queue.findRecentDuplicateAnyChannelForIdentity(body.message, dedupIdentity, CROSS_CHANNEL_DEDUP_WINDOW_MS);
    if (crossDup && crossDup.channel !== channel) {
      return c.json({ message_id: crossDup.message_id, status: "duplicate", hint: `Already sent on ${crossDup.channel} channel within the last 60 seconds` });
    }

    const parsedCrawl = isCrawlCommand(body.message) ? parseCrawlCommandText(body.message) : null;
    const benchmarkMode = body.benchmark === true;

    const relayContext = toRelayContext(body.relay);

    // Async mode: enqueue and return immediately
    if (body.async) {
      if (parsedCrawl) {
        return c.json({ error: "Async /crawl is not supported. Use sync or stream mode." }, 400);
      }
      if (benchmarkMode) {
        return c.json({ error: "Benchmark mode is only supported for sync or stream requests." }, 400);
      }
      // Dedup: reject if identical message from same sender/channel within 10s
      const existing = queue.findRecentDuplicate(channel, sender, body.message);
      if (existing) {
        return c.json({ message_id: existing, status: "duplicate", hint: "Identical message already enqueued within the last 10 seconds" });
      }
      const messageId = queue.enqueueMessage({
        channel,
        sender,
        sender_id: senderId,
        task_id: body.task_id,
        message: body.message,
        agent: body.agent,
        files: mergedFiles ? JSON.stringify(mergedFiles) : undefined,
        relay: relayContext,
      });
      return c.json({ message_id: messageId, status: "enqueued" });
    }

    // Stream mode: return SSE stream with per-request progress events
    if (body.stream) {
      const encoder = new TextEncoder();
      let heartbeat: ReturnType<typeof setInterval>;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));

          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              clearInterval(heartbeat);
            }
          }, 15_000);

          const writeEvent = (type: string, data: Record<string, unknown>) => {
            try {
              const json = JSON.stringify({ type, ...data, timestamp: Date.now() });
              controller.enqueue(encoder.encode(`event: ${type}\ndata: ${json}\n\n`));
            } catch { /* stream closed */ }
          };

          const work = parsedCrawl?.ok
            ? runCrawlCommand({ ...parsedCrawl.input, origin: "api" }, {
              service: opts?.crawlService,
              sources: opts?.crawlSources,
              ingest: opts?.crawlIngest,
            }).then((result) => ({
              message_id: null,
              response: formatCrawlCommandResult(result),
              agent: body.agent ?? "system",
              trace_id: null,
            }))
            : parsedCrawl && !parsedCrawl.ok
              ? Promise.resolve({
                message_id: null,
                response: parsedCrawl.error,
                agent: body.agent ?? "system",
                trace_id: null,
              })
              : processor.processImmediate({
                channel,
                sender,
                sender_id: senderId,
                task_id: body.task_id,
                message: body.message,
                agent: body.agent,
                modelOverride: body.model_override,
                files: mergedFiles,
                relay: relayContext,
                benchmark: benchmarkMode,
                mode: body.mode,
                onEvent: (event) => writeEvent(event.type, event.data as Record<string, unknown>),
              });

          work.then((result) => {
            writeEvent("response", {
              message_id: result.message_id,
              response: result.response,
              agent: result.agent,
              trace_id: result.trace_id,
            });
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* already closed */ }
          }).catch((err) => {
            writeEvent("error", { error: formatError(err) });
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* already closed */ }
          });
        },
        cancel() {
          clearInterval(heartbeat);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Sync path — wrap in timeout (iOS gets 5 min, relay gets 115s so server responds before MCP client aborts, others 5 min)
    const timeoutMs = channel.startsWith("ios:")
      ? IOS_REQUEST_TIMEOUT_MS
      : channel === "relay"
        ? (opts?.relayTimeoutMs ?? RELAY_SYNC_TIMEOUT_MS)
        : (opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("AGENT_TIMEOUT")), timeoutMs);
    });

    try {
      const result = await Promise.race(parsedCrawl?.ok
        ? [
          runCrawlCommand({ ...parsedCrawl.input, origin: "api" }, {
            service: opts?.crawlService,
            sources: opts?.crawlSources,
            ingest: opts?.crawlIngest,
          }).then((crawl) => ({
            message_id: null,
            response: formatCrawlCommandResult(crawl),
            agent: body.agent ?? "system",
            trace_id: null,
          })),
          timeoutPromise,
        ]
        : parsedCrawl && !parsedCrawl.ok
          ? [Promise.resolve({
            message_id: null,
            response: parsedCrawl.error,
            agent: body.agent ?? "system",
            trace_id: null,
          })]
          : [
            processor.processImmediate({
              channel,
              sender,
              sender_id: senderId,
              task_id: body.task_id,
              message: body.message,
              agent: body.agent,
              modelOverride: body.model_override,
              files: mergedFiles,
              relay: relayContext,
              benchmark: benchmarkMode,
              mode: body.mode,
            }),
            timeoutPromise,
          ]);
      const run = result.message_id ? opts?.runs?.getRunByMessageId(result.message_id) ?? null : null;
      return c.json({
        message_id: result.message_id,
        response: result.response,
        agent: result.agent,
        trace_id: result.trace_id,
        ...(run ? {
          run: {
            id: run.run_id,
            status: run.status,
            outcome: run.result?.outcome ?? null,
            summary: run.result?.summary ?? null,
            result: run.result ?? null,
            started_at: run.created_at,
            finished_at: run.completed_at ?? null,
          },
        } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "AGENT_TIMEOUT") {
        // Dedup: don't re-enqueue if identical message already exists
        const existingId = queue.findRecentDuplicate(channel, sender, body.message, IOS_REQUEST_TIMEOUT_MS);
        const messageId = existingId ?? queue.enqueueMessage({
          channel,
          sender,
          sender_id: senderId,
          task_id: body.task_id,
          message: body.message,
          agent: body.agent,
          files: mergedFiles ? JSON.stringify(mergedFiles) : undefined,
          relay: relayContext,
        });
        return c.json({ message_id: messageId, status: "running", timeout: true });
      }
      const errorMsg = formatError(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  return app;
}
