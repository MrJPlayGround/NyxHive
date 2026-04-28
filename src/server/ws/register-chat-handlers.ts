import type { MethodRouter } from "./router.js";
import type { HandlerDeps } from "./handler-deps.js";
import { logger } from "../../utils/logger.js";
import { formatCrawlCommandResult, isCrawlCommand, parseCrawlCommandText, runCrawlCommand } from "../../crawl/index.js";
import { resolvePrimaryAgentKey } from "../../agents/primary.js";
import { normalizeAssistantMessageContent } from "../../chat/message-content.js";
import { sanitizeAssistantResponse } from "../../chat/response-sanitizer.js";
import { normalizeInboundAttachments } from "../../security/attachments.js";
import { ChatSessionQueue, getChatSessionKey } from "./chat-session-queue.js";

/** Track active gateway chat invocations by runId so control commands can target exact runs. */
export interface ActiveGatewayInvocation {
  runId: string;
  threadId: string;
  conversationKey: string;
  deviceId: string;
  agent: string;
  startedAt: number;
  turn: number;
}

const activeGatewayInvocations = new Map<string, ActiveGatewayInvocation>();
const activeGatewayRunByThread = new Map<string, string>();
const gatewayChatRequests = new Map<string, {
  idempotencyKey: string;
  messageId: string;
  threadId: string;
  runId: string;
  status: "started" | "queued" | "ok";
  updatedAt: number;
}>();
const GATEWAY_CHAT_REQUEST_TTL_MS = 30 * 60_000;
const chatSessionQueue = new ChatSessionQueue();
const gatewayChatSendQueue = new ChatSessionQueue();

function pruneGatewayChatRequests(now = Date.now()) {
  for (const [key, entry] of gatewayChatRequests) {
    if (now - entry.updatedAt > GATEWAY_CHAT_REQUEST_TTL_MS) {
      gatewayChatRequests.delete(key);
    }
  }
}

function resolveGatewayRunId(threadId: string, turn: number): string {
  return `chat:${threadId}:${turn}`;
}

function assistantTextOutput(text: string) {
  return { type: "text", text };
}

function broadcastRunHeartbeat(
  deps: HandlerDeps,
  opts: { agent: string; threadId: string; runId: string; turn: number; startedAt: number },
): void {
  const payload = {
    agent: opts.agent,
    channel: "gateway",
    threadId: opts.threadId,
    runId: opts.runId,
    turn: opts.turn,
    startedAt: opts.startedAt,
    timestamp: Date.now(),
  };
  deps.connections.broadcast("run.heartbeat", payload);
  deps.connections.broadcast("chat:heartbeat", payload);
}

export function getActiveGatewayInvocation() {
  if (activeGatewayInvocations.size === 0) return null;
  let latest: { agent: string; startedAt: number } | null = null;
  for (const invocation of activeGatewayInvocations.values()) {
    if (!latest || invocation.startedAt > latest.startedAt) latest = invocation;
  }
  return latest;
}

export function getActiveGatewayInvocations() {
  return activeGatewayInvocations;
}

function hasActiveGatewayThread(threadId: string): boolean {
  return activeGatewayRunByThread.has(threadId);
}

function setActiveGatewayInvocation(invocation: ActiveGatewayInvocation): void {
  const previousRunId = activeGatewayRunByThread.get(invocation.threadId);
  if (previousRunId && previousRunId !== invocation.runId) {
    activeGatewayInvocations.delete(previousRunId);
  }
  activeGatewayInvocations.set(invocation.runId, invocation);
  activeGatewayRunByThread.set(invocation.threadId, invocation.runId);
}

function deleteActiveGatewayInvocation(runId: string): void {
  const invocation = activeGatewayInvocations.get(runId);
  if (!invocation) return;
  activeGatewayInvocations.delete(runId);
  if (activeGatewayRunByThread.get(invocation.threadId) === runId) {
    activeGatewayRunByThread.delete(invocation.threadId);
  }
}

function resolveGatewayInvocationTarget(opts: {
  runId?: string | null;
  threadId?: string | null;
  deviceId: string;
}): ActiveGatewayInvocation | { error: "NO_ACTIVE_RUN" | "AMBIGUOUS_ACTIVE_RUN" | "STALE_RUN_TARGET" } {
  const runId = opts.runId?.trim();
  if (runId) {
    return activeGatewayInvocations.get(runId) ?? { error: "STALE_RUN_TARGET" };
  }

  const threadId = opts.threadId?.trim();
  if (threadId) {
    const threadRunId = activeGatewayRunByThread.get(threadId);
    return threadRunId
      ? activeGatewayInvocations.get(threadRunId) ?? { error: "STALE_RUN_TARGET" }
      : { error: "NO_ACTIVE_RUN" };
  }

  const matches = Array.from(activeGatewayInvocations.values())
    .filter((invocation) => invocation.deviceId === opts.deviceId);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { error: "AMBIGUOUS_ACTIVE_RUN" };
  return { error: "NO_ACTIVE_RUN" };
}

export function registerChatHandlers(router: MethodRouter, deps: HandlerDeps) {
  const gatewayTurnAssignments = new Map<string, number>();
  const getAgentConfig = (agentKey: string) => deps.registry?.get(agentKey) ?? deps.config.agents?.[agentKey];
  const resolveDefaultAgentKey = () => resolvePrimaryAgentKey(deps.config.agents ?? {}, deps.config.daemon);
  const isAbortError = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    return err.name === "AbortError" || /operation was aborted|aborted/i.test(err.message);
  };

  const inferCliFallback = (provider: string, model: string): string | undefined => {
    if (provider === "openai" || model.startsWith("gpt-")) return "codex";
    if (provider === "anthropic" || model.startsWith("claude-")) return "claude";
    if (provider === "openrouter" || provider === "minimax") return undefined;
    return undefined;
  };

  const resolveChatModelState = (senderId: string, agentKey: string, warning?: string | null) => {
    const agentConfig = getAgentConfig(agentKey);
    if (!agentConfig) throw new Error(`Unknown agent: ${agentKey}`);
    const overrideModel = deps.processor.getModelOverride(senderId, agentKey);
    const effectiveModel = deps.processor.getEffectiveModel(senderId, agentKey);
    const naturalDefault = deps.processor.getNaturalDefault(agentKey);
    const provider = deps.processor.getModelOverrideProvider(senderId, agentKey) ?? agentConfig.provider;
    return {
      agent: agentKey,
      model: effectiveModel,
      provider,
      cliFallback: inferCliFallback(provider, effectiveModel) ?? agentConfig.cli_fallback,
      overridden: Boolean(overrideModel) && overrideModel !== naturalDefault,
      warning: warning ?? null,
    };
  };

  const getNextTurn = (threadId: string) => {
    if (!deps.threadDb) return 1;
    const history = deps.threadDb.getExecutionEvents(threadId);
    const highestTurn = history.reduce((max, event) => Math.max(max, event.turn ?? 0), 0);
    return highestTurn + 1;
  };

  const reserveGatewayTurn = (threadId: string) => {
    const observed = getNextTurn(threadId);
    const next = Math.max(observed, (gatewayTurnAssignments.get(threadId) ?? 0) + 1);
    gatewayTurnAssignments.set(threadId, next);
    return next;
  };

  const broadcastDiffUpdate = (threadId: string) => {
    if (!deps.threadDb) return;
    deps.connections.broadcast("diff.updated", {
      threadId,
      changes: deps.threadDb.getFileChanges(threadId),
    });
  };

  router.register("chat.send", async (payload: unknown, deviceId: string) => {
    const { message, agent, threadId, idempotencyKey, images, files: rawFiles } = payload as {
      message: string;
      agent?: string;
      threadId?: string | null;
      idempotencyKey?: string;
      images?: { type: string; data: string }[];
      files?: { name: string; type: string; data: string }[];
    };

    pruneGatewayChatRequests();
    if (idempotencyKey) {
      const existingRequest = gatewayChatRequests.get(idempotencyKey);
      if (existingRequest) {
        return {
          messageId: existingRequest.messageId,
          threadId: existingRequest.threadId,
          runId: existingRequest.runId,
          status: existingRequest.status === "ok"
            ? "ok"
            : existingRequest.status === "queued"
              ? "queued"
              : "in_flight",
        };
      }
    }

    const files = normalizeInboundAttachments({ images, files: rawFiles });

    const messageId = crypto.randomUUID();
    const instanceName = deps.config.daemon.name ?? "nyxhive";
    const agentName = agent ?? resolveDefaultAgentKey() ?? "nyx";

    let resolvedThreadId = threadId ?? null;
    let createdThread = false;
    if (deps.threadDb) {
      if (resolvedThreadId) {
        const existing = deps.threadDb.getThread(resolvedThreadId);
        if (existing) {
          deps.threadDb.addThreadMessage(resolvedThreadId, { role: "user", content: message, agent: agentName });
        } else {
          const thread = deps.threadDb.createThread({ message, instance: instanceName, agent: agentName });
          resolvedThreadId = thread.id;
          createdThread = true;
        }
      } else {
        const thread = deps.threadDb.createThread({ message, instance: instanceName, agent: agentName });
        resolvedThreadId = thread.id;
        createdThread = true;
      }
    }
    if (!resolvedThreadId) resolvedThreadId = messageId;

    const mergedFiles = files.length > 0 ? files : undefined;

    const chatThreadId = resolvedThreadId;
    const sessionKey = getChatSessionKey(chatThreadId, deviceId);
    const queued = gatewayChatSendQueue.isBusy(sessionKey) || hasActiveGatewayThread(chatThreadId);
    const turn = reserveGatewayTurn(chatThreadId);
    const runId = resolveGatewayRunId(chatThreadId, turn);
    const markRequestStatus = (status: "started" | "queued" | "ok") => {
      if (!idempotencyKey) return;
      const entry = gatewayChatRequests.get(idempotencyKey);
      if (!entry) return;
      gatewayChatRequests.set(idempotencyKey, {
        ...entry,
        status,
        updatedAt: Date.now(),
      });
    };

    if (idempotencyKey) {
      gatewayChatRequests.set(idempotencyKey, {
        idempotencyKey,
        messageId,
        threadId: chatThreadId,
        runId,
        status: queued ? "queued" : "started",
        updatedAt: Date.now(),
      });
    }

    if (!threadId) {
      const pendingModelOverride = deps.processor.getModelOverride(deviceId, agentName);
      if (pendingModelOverride) {
        deps.processor.setModelOverride(chatThreadId, agentName, pendingModelOverride);
      }
    }

    if (queued) {
      logger.info(`[chat.send] Thread ${chatThreadId} already active or queued — server will serialize follow-up send`);
    }

    if (isCrawlCommand(message)) {
      const parsed = parseCrawlCommandText(message);
      void gatewayChatSendQueue.run(sessionKey, async () => {
        const startedAt = Date.now();
        markRequestStatus("started");
        setActiveGatewayInvocation({
          runId,
          threadId: chatThreadId,
          conversationKey: `gateway:${chatThreadId}`,
          deviceId,
          agent: agentName,
          startedAt,
          turn,
        });
        if (createdThread) {
          deps.connections.broadcast("thread.started", {
            threadId: chatThreadId,
            agent: agentName,
            startedAt,
            created: true,
          });
        }
        deps.connections.broadcast("turn.started", {
          threadId: chatThreadId,
          turn,
          runId,
          agent: agentName,
          startedAt,
        });

        const heartbeatInterval = setInterval(() => {
          broadcastRunHeartbeat(deps, { agent: agentName, threadId: chatThreadId, runId, turn, startedAt });
        }, 10_000);

        try {
          const text = parsed.ok
            ? formatCrawlCommandResult(await runCrawlCommand(parsed.input, {
              service: deps.crawlService,
              sources: deps.crawlSources,
              ingest: deps.crawlIngest,
            }))
            : parsed.error;

          if (deps.threadDb) {
            deps.threadDb.addThreadMessage(chatThreadId, {
              role: "assistant",
              content: text,
              agent: agentName,
            });
            deps.threadDb.updateThread(chatThreadId, { status: "completed", response: text });
          }

          deps.connections.broadcast("chat:response", {
            text,
            done: true,
            agent: agentName,
            channel: "gateway",
            threadId: chatThreadId,
            tokensIn: 0,
            tokensOut: 0,
            cost: 0,
            durationMs: 0,
          });
          deps.connections.broadcast("turn.completed", {
            threadId: chatThreadId,
            turn,
            runId,
            agent: agentName,
            status: "completed",
            finishedAt: Date.now(),
            text,
            output: assistantTextOutput(text),
            tokensIn: 0,
            tokensOut: 0,
            cost: 0,
            durationMs: 0,
          });
        } catch (err) {
          const text = `crawl failed: ${err instanceof Error ? err.message : String(err)}`;
          if (deps.threadDb) {
            deps.threadDb.addThreadMessage(chatThreadId, {
              role: "assistant",
              content: text,
              agent: agentName,
            });
            deps.threadDb.updateThread(chatThreadId, { status: "failed", response: text });
          }
          deps.connections.broadcast("chat:response", {
            text,
            done: true,
            agent: agentName,
            channel: "gateway",
            threadId: chatThreadId,
            tokensIn: 0,
            tokensOut: 0,
            cost: 0,
            durationMs: 0,
          });
          deps.connections.broadcast("turn.completed", {
            threadId: chatThreadId,
            turn,
            runId,
            agent: agentName,
            status: "failed",
            finishedAt: Date.now(),
            text,
            output: assistantTextOutput(text),
            tokensIn: 0,
            tokensOut: 0,
            cost: 0,
            durationMs: 0,
          });
        } finally {
          clearInterval(heartbeatInterval);
          deleteActiveGatewayInvocation(runId);
          markRequestStatus("ok");
        }
      }).catch((err) => {
        logger.error(`[chat.send] queued crawl task failed to launch: ${err}`);
      });

      return { messageId, threadId: resolvedThreadId, runId, status: queued ? "queued" : "started", queued: queued || undefined };
    }

    void gatewayChatSendQueue.run(sessionKey, async () => {
      const startedAt = Date.now();
      markRequestStatus("started");
      setActiveGatewayInvocation({
        runId,
        threadId: chatThreadId,
        conversationKey: `gateway:${chatThreadId}`,
        deviceId,
        agent: agentName,
        startedAt,
        turn,
      });
      if (createdThread) {
        deps.connections.broadcast("thread.started", {
          threadId: chatThreadId,
          agent: agentName,
          startedAt,
          created: true,
        });
      }
      deps.connections.broadcast("turn.started", {
        threadId: chatThreadId,
        turn,
        runId,
        agent: agentName,
        startedAt,
      });

      const heartbeatInterval = setInterval(() => {
        broadcastRunHeartbeat(deps, { agent: agentName, threadId: chatThreadId, runId, turn, startedAt });
      }, 10_000);

    let partialText = "";
    let partialMessageId: string | null = null;
    let lastSaveLen = 0;
    let firstSaved = false;
    const FIRST_SAVE_THRESHOLD = 1;
    const PARTIAL_SAVE_THRESHOLD = 200;

    const unsubscribeContext = deps.processor.onEvent((event) => {
      if (event.type !== "context:metrics") return;
      const data = event.data as { utilizationPct?: number; estimated?: boolean };
      deps.connections.broadcast("context:metrics", {
        utilizationPct: data.utilizationPct,
        estimated: data.estimated,
        channel: "gateway",
        threadId: chatThreadId,
      });
      deps.connections.broadcast("context.updated", {
        threadId: chatThreadId,
        utilizationPct: data.utilizationPct,
        estimated: data.estimated,
      });
    });

    const unsubscribeDelta = deps.processor.onEvent((event) => {
      if (event.type !== "response:delta") return;
      const data = event.data as { text_delta?: string; text_so_far?: string; channel?: string; sender_id?: string };
      if (data.channel !== "gateway") return;
      if (data.sender_id && data.sender_id !== chatThreadId) return;
      if (data.text_so_far) {
        partialText = sanitizeAssistantResponse(data.text_so_far);
      } else if (data.text_delta) {
        partialText = sanitizeAssistantResponse(`${partialText}${data.text_delta}`);
      }
      if (!partialText) return;
      const threshold = firstSaved ? PARTIAL_SAVE_THRESHOLD : FIRST_SAVE_THRESHOLD;
      if (deps.threadDb && partialText.length - lastSaveLen >= threshold) {
        firstSaved = true;
        lastSaveLen = partialText.length;
        try {
          if (!partialMessageId) {
            const msg = deps.threadDb.addThreadMessage(chatThreadId, {
              role: "assistant",
              content: partialText,
              agent: agentName,
            });
            partialMessageId = msg.id;
          } else {
            deps.threadDb.updateThreadMessage(partialMessageId, partialText);
          }
        } catch (err) {
          logger.error(`[chat.send] Partial save failed: ${err}`);
        }
      }
    });

    const unsubscribeExecution = deps.processor.onEvent((event) => {
      if (event.type !== "execution:event") return;
      const data = event.data as { channel?: string; sender_id?: string; [key: string]: unknown };
      if (data.channel !== "gateway") return;
      if (data.sender_id && data.sender_id !== chatThreadId) return;
      const assistantMessageId = partialMessageId ?? undefined;
      if (
        deps.threadDb &&
        typeof data.id === "string" &&
        typeof data.kind === "string" &&
        typeof data.phase === "string" &&
        typeof data.title === "string"
      ) {
        deps.threadDb.recordExecutionEvent({
          threadId: chatThreadId,
          messageId: assistantMessageId,
          id: data.id,
          kind: data.kind as "command" | "file_change" | "mcp_tool" | "web_search" | "status",
          phase: data.phase as "started" | "updated" | "completed" | "failed",
          turn: typeof data.turn === "number" ? data.turn : undefined,
          title: data.title,
          subtitle: typeof data.subtitle === "string" ? data.subtitle : undefined,
          details: typeof data.details === "string" ? data.details : undefined,
          command: typeof data.command === "string" ? data.command : undefined,
          outputPreview: typeof data.outputPreview === "string" ? data.outputPreview : undefined,
          exitCode: typeof data.exitCode === "number" ? data.exitCode : null,
          changes: Array.isArray(data.changes) ? data.changes as Array<{ path: string; kind: "add" | "delete" | "update" }> : undefined,
          timestamp: typeof data.timestamp === "number" ? data.timestamp : undefined,
        });
      }
      deps.connections.broadcast("chat:execution", {
        ...data,
        message_id: assistantMessageId,
        threadId: chatThreadId,
      });
      const runtimeItemMethod = data.phase === "started"
        ? "item.started"
        : data.phase === "updated"
          ? "item.updated"
          : "item.completed";
      deps.connections.broadcast(runtimeItemMethod, {
        threadId: chatThreadId,
        turn: typeof data.turn === "number" ? data.turn : turn,
        item: {
          id: String(data.id),
          type: data.kind,
          status: data.phase,
          title: data.title,
          subtitle: typeof data.subtitle === "string" ? data.subtitle : undefined,
          details: typeof data.details === "string" ? data.details : undefined,
          command: typeof data.command === "string" ? data.command : undefined,
          outputPreview: typeof data.outputPreview === "string" ? data.outputPreview : undefined,
          exitCode: typeof data.exitCode === "number" ? data.exitCode : null,
          changes: Array.isArray(data.changes) ? data.changes : undefined,
          timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
        },
      });
      if (data.kind === "file_change" || (Array.isArray(data.changes) && data.changes.length > 0)) {
        broadcastDiffUpdate(chatThreadId);
      }
    });

      try {
        const result = await deps.processor.processImmediate({
          channel: "gateway",
          sender: deviceId,
          sender_id: chatThreadId,
          message,
          agent: agentName,
          files: mergedFiles,
        });
        const finalText = result.response.length > 0 ? result.response : partialText;
        try {
          if (deps.threadDb) {
            const totalTokens = (result.tokens_in ?? 0) + (result.tokens_out ?? 0);
            const costCents = result.cost ?? 0;
            if (partialMessageId) {
              deps.threadDb.updateThreadMessage(partialMessageId, finalText, { tokens: totalTokens, cost_cents: costCents });
            } else {
              deps.threadDb.addThreadMessage(chatThreadId, {
                role: "assistant",
                content: finalText,
                agent: result.agent,
                tokens: totalTokens,
                cost_cents: costCents,
              });
            }
            deps.threadDb.updateThread(chatThreadId, {
              status: "completed",
              response: finalText,
              cost_cents: result.cost ?? 0,
              total_tokens: totalTokens,
              duration_ms: result.duration_ms ?? null,
            });
          }
        } catch (err) {
          logger.error(`[chat.send] DB persist failed: ${err}`);
        }
        deps.connections.broadcast("chat:response", {
          text: finalText,
          done: true,
          agent: result.agent,
          channel: "gateway",
          threadId: chatThreadId,
          tokensIn: result.tokens_in ?? 0,
          tokensOut: result.tokens_out ?? 0,
          cost: result.cost ?? 0,
          durationMs: result.duration_ms ?? 0,
        });
        deps.connections.broadcast("turn.completed", {
          threadId: chatThreadId,
          turn,
          runId,
          agent: result.agent,
          status: "completed",
          finishedAt: Date.now(),
          text: finalText,
          output: assistantTextOutput(finalText),
          tokensIn: result.tokens_in ?? 0,
          tokensOut: result.tokens_out ?? 0,
          cost: result.cost ?? 0,
          durationMs: result.duration_ms ?? 0,
        });
        broadcastDiffUpdate(chatThreadId);
      } catch (err) {
        logger.error(`[chat.send] processImmediate failed: ${err}`);
        const aborted = isAbortError(err);
        const errorText = aborted
          ? "Operation aborted."
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
        const content = partialText.length > 0
          ? `${partialText}\n\n[${aborted ? "Aborted" : "Error: stream interrupted"}]`
          : aborted
            ? "[Aborted]"
            : errorText;
        try {
          if (deps.threadDb) {
            if (partialMessageId) {
              deps.threadDb.updateThreadMessage(partialMessageId, content);
            } else {
              deps.threadDb.addThreadMessage(chatThreadId, {
                role: "assistant",
                content,
                agent: agentName,
              });
            }
            deps.threadDb.updateThread(chatThreadId, {
              status: aborted ? "cancelled" : "failed",
              response: content,
            });
          }
          deps.processor.recordConversationTurn?.("gateway", chatThreadId, message, content, { agent: agentName });
        } catch (dbErr) {
          logger.error(`[chat.send] DB error persist failed: ${dbErr}`);
        }
        deps.connections.broadcast("chat:response", {
          text: content,
          done: true,
          channel: "gateway",
          threadId: chatThreadId,
        });
        deps.connections.broadcast("turn.completed", {
          threadId: chatThreadId,
          turn,
          runId,
          agent: agentName,
          status: aborted ? "aborted" : "failed",
          finishedAt: Date.now(),
          text: content,
          output: assistantTextOutput(content),
        });
        broadcastDiffUpdate(chatThreadId);
      } finally {
        deleteActiveGatewayInvocation(runId);
        clearInterval(heartbeatInterval);
        unsubscribeDelta();
        unsubscribeExecution();
        unsubscribeContext();
        markRequestStatus("ok");
      }
    }).catch((err) => {
      logger.error(`[chat.send] queued task failed to launch: ${err}`);
    });

    return { messageId, threadId: resolvedThreadId, runId, status: queued ? "queued" : "started", queued: queued || undefined };
  });

  router.register("chat.abort", async (payload: unknown, deviceId: string) => {
    const { threadId, runId } = (payload ?? {}) as { threadId?: string; runId?: string };
    return chatSessionQueue.run(getChatSessionKey(threadId, deviceId), async () => {
      const target = resolveGatewayInvocationTarget({ runId, threadId, deviceId });
      const senderId = "error" in target ? (threadId ?? deviceId) : target.threadId;
      const result = deps.processor.cancelTask("gateway", senderId);

      if (result.cancelled) {
        if (!("error" in target)) deleteActiveGatewayInvocation(target.runId);
        logger.info(`[chat.abort] Cancelled ${result.agent} after ${result.elapsed}s (run: ${runId ?? "implicit"}, thread: ${threadId ?? senderId})`);
      } else {
        const code = "error" in target ? target.error : "NO_ACTIVE_RUN";
        logger.warn(`[chat.abort] No active task found (code: ${code}, run: ${runId ?? "none"}, thread: ${threadId ?? "none"}, device: ${deviceId})`);
        return { ...result, code };
      }
      return result;
    });
  });

  router.register("chat.btw", async (payload: unknown) => {
    const { agent, question, threadId } = payload as { agent: string; question: string; threadId?: string };
    const target = deps.processor.resolveActiveTaskTarget(agent, { threadId });
    if ("error" in target) {
      throw new Error(deps.processor.formatActiveTaskResolutionError(agent, target, { action: "btw", threadId }));
    }
    const result = await deps.processor.handleBtw(agent, target.message_id, question, "gateway");
    if (!result) {
      throw new Error("No cached context for this task");
    }
    return result;
  });

  router.register("chat.steer", async (payload: unknown, deviceId: string) => {
    const { agent, message, threadId, priority } = payload as { agent: string; message: string; threadId?: string; priority?: string };
    logger.info(`[chat.steer] agent=${agent} message="${message?.slice(0, 80)}" threadId=${threadId} deviceId=${deviceId}`);
    const target = deps.processor.resolveActiveTaskTarget(agent, { threadId });
    if ("error" in target) {
      if (target.error !== "agent_idle") {
        throw new Error(deps.processor.formatActiveTaskResolutionError(agent, target, { action: "steer", threadId }));
      }
      const senderId = threadId ?? deviceId;
      deps.processor.saveSteerToConversation("gateway", senderId, `[STEER from user]\n${message}`);
      return { status: "queued", detail: "Agent idle — steer saved for next turn" };
    }
    return deps.processor.handleSteer(agent, target.message_id, target.conversation_id, {
      message,
      priority: (priority as "normal" | "interrupt") ?? "normal",
      source: "gateway",
    });
  });

  router.register("chat.usage", async () => {
    const queueStats = deps.queue.getQueueStats();
    const agents = deps.registry?.getAllEntries(false);
    const agentStats: Array<{ name: string; status: string; invocations: number; costCents: number }> = [];
    if (agents) {
      for (const [key, agent] of agents) {
        const running = deps.registry?.getRunningAgents().get(key);
        agentStats.push({
          name: key,
          status: running ? "running" : "idle",
          invocations: agent.total_invocations,
          costCents: agent.estimated_cost_cents,
        });
      }
    }
    return { queue: queueStats, agents: agentStats };
  });

  router.register("chat.context", async (payload: unknown, deviceId: string) => {
    const { threadId } = (payload ?? {}) as { threadId?: string };
    return deps.processor.getContextInfo("gateway", threadId ?? deviceId);
  });

  router.register("chat.forget", async (payload: unknown, deviceId: string) => {
    const { threadId, exchanges } = (payload ?? {}) as { threadId?: string; exchanges?: number };
    return chatSessionQueue.run(getChatSessionKey(threadId, deviceId), async () =>
      deps.processor.forgetMessages("gateway", threadId ?? deviceId, exchanges ?? 1));
  });

  router.register("chat.trim", async (payload: unknown, deviceId: string) => {
    const { threadId, keep } = (payload ?? {}) as { threadId?: string; keep?: number };
    return chatSessionQueue.run(getChatSessionKey(threadId, deviceId), async () =>
      deps.processor.trimConversation("gateway", threadId ?? deviceId, keep ?? 5));
  });

  router.register("chat.setup.status", async () => {
    const channels: string[] = [];
    if (deps.config.discord) channels.push("discord");
    if (deps.config.telegram) channels.push("telegram");
    if (deps.config.slack) channels.push("slack");
    if (deps.config.imessage) channels.push("imessage");
    return { channels, instanceName: deps.config.daemon.name ?? "nyxhive" };
  });

  router.register("chat.reset", async (payload: unknown, deviceId: string) => {
    const { threadId } = (payload ?? {}) as { threadId?: string };
    return chatSessionQueue.run(getChatSessionKey(threadId, deviceId), async () => {
      const senderId = threadId ?? deviceId;
      deps.processor.clearConversation("gateway", senderId);
      logger.info(`[chat.reset] Gateway conversation context cleared for ${senderId}`);
      return { ok: true };
    });
  });

  router.register("chat.status", async (payload: unknown, deviceId: string) => {
    const { threadId } = (payload ?? {}) as { threadId?: string };
    const senderId = threadId ?? deviceId;
    const active = deps.processor.isActive("gateway", senderId);
    if (active.active) return active;
    return { active: hasActiveGatewayThread(senderId) };
  });

  router.register("chat.history", async (payload: unknown) => {
    const { threadId, limit } = payload as { threadId: string; limit?: number };
    return chatSessionQueue.run(`thread:${threadId}`, async () => {
      if (!deps.threadDb) {
        logger.warn("[chat.history] No threadDb available");
        return { messages: [], executionEvents: [] };
      }
      const thread = deps.threadDb.getThread(threadId);
      if (!thread) {
        logger.warn(`[chat.history] Thread not found: ${threadId}`);
        return { messages: [], executionEvents: [] };
      }
      const clampedLimit = Math.min(Math.max(limit ?? 50, 1), 200);
      const messages = deps.threadDb.getThreadMessages(threadId, clampedLimit).map((message) => {
        if (message.role !== "assistant" || typeof message.content !== "string") return message;
        const normalized = normalizeAssistantMessageContent(message.content);
        return {
          ...message,
          content: normalized.content,
          reasoning: normalized.reasoning,
        };
      });
      const executionEvents = deps.threadDb.getExecutionEvents(threadId, 150);
      logger.info(`[chat.history] Returning ${messages.length} messages and ${executionEvents.length} execution events for thread ${threadId}`);
      return { messages, executionEvents };
    });
  });

  router.register("chat.model.get", async (payload: unknown, deviceId: string) => {
    const { threadId, agent } = (payload ?? {}) as { threadId?: string | null; agent?: string };
    return resolveChatModelState(threadId ?? deviceId, agent ?? resolveDefaultAgentKey() ?? "nyx");
  });

  router.register("chat.model.set", async (payload: unknown, deviceId: string) => {
    const { threadId, agent, model } = (payload ?? {}) as { threadId?: string | null; agent?: string; model?: string | null };
    return chatSessionQueue.run(getChatSessionKey(threadId, deviceId), async () => {
      const agentKey = agent ?? resolveDefaultAgentKey() ?? "nyx";
      const senderId = threadId ?? deviceId;
      let warning: string | null = null;
      if (!model || model === "default" || model === "reset") {
        deps.processor.clearModelOverride(senderId, agentKey);
      } else {
        warning = deps.processor.setModelOverride(senderId, agentKey, model);
      }
      return resolveChatModelState(senderId, agentKey, warning);
    });
  });
}
