import { logger } from "../utils/logger.js";
import type { NyxHiveConfig, InvocationResult } from "../types.js";
import { AGENT_TIMEOUT_MS } from "../defaults.js";
import type { RelayCallbackManager } from "../federation/relay.js";

async function pollRemoteMessage(
  instanceUrl: string,
  apiKey: string,
  messageId: string,
  timeoutMs: number,
): Promise<{ response: string; agent: string; trace_id?: string }> {
  const startedAt = Date.now();
  const statusUrl = `${instanceUrl}/api/message/${messageId}`;

  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(statusUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`Remote status poll failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      status: string;
      response?: string | null;
      error?: string | null;
      agent?: string | null;
      trace_id?: string;
    };

    if (data.status === "completed") {
      return {
        response: data.response ?? "",
        agent: data.agent ?? "unknown",
        trace_id: data.trace_id,
      };
    }

    if (data.status === "failed" || data.status === "dead_letter") {
      throw new Error(data.error || `Remote task ${messageId} ended in ${data.status}`);
    }

    await Bun.sleep(1000);
  }

  throw new Error(`Remote task ${messageId} did not complete within ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Dispatch a delegation to a remote NyxHive instance.
 * Uses the target instance's POST /api/message endpoint.
 *
 * Returns an InvocationResult so the caller can treat it
 * identically to a local invokeAgent() result.
 */
export async function dispatchToInstance(
  instanceName: string,
  agent: string,
  task: string,
  config: NyxHiveConfig,
  timeoutMs?: number,
  relayCallbacks?: RelayCallbackManager,
): Promise<InvocationResult> {
  const startTime = Date.now();
  const instanceConfig = config.remotes?.[instanceName];

  if (!instanceConfig) {
    const known = config.remotes ? Object.keys(config.remotes).join(", ") : "none";
    throw new Error(`Unknown remote "${instanceName}". Known remotes: ${known}`);
  }

  const apiKey = process.env[instanceConfig.api_key_env];
  if (!apiKey) {
    throw new Error(`Missing API key for instance "${instanceName}" (env: ${instanceConfig.api_key_env})`);
  }

  const url = `${instanceConfig.url}/api/message`;
  const effectiveTimeout = timeoutMs ?? AGENT_TIMEOUT_MS;
  const relay = relayCallbacks?.issue(instanceName);

  logger.info(`[dispatch] ${instanceName}.${agent}: "${task.slice(0, 80)}"`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        message: task,
        agent,
        sender: config.daemon?.name ?? "nyx",
        channel: "dispatch",
        async: !!relay,
        relay: relay ? {
          origin_instance: relay.originInstance,
          callback_url: relay.callbackUrl,
          callback_token: relay.callbackToken,
        } : undefined,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`Instance "${instanceName}" returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      message_id?: string;
      status?: string;
      response?: string;
      agent?: string;
      trace_id?: string;
    };

    const settled = relay && data.message_id
      ? await pollRemoteMessage(instanceConfig.url, apiKey, data.message_id, effectiveTimeout)
      : {
          response: data.response ?? "",
          agent: data.agent ?? agent,
          trace_id: data.trace_id,
        };

    const duration = Date.now() - startTime;
    logger.info(`[dispatch] ${instanceName}.${agent} completed in ${duration}ms — ${settled.response.length} chars`);

    return {
      response: settled.response,
      agent: settled.agent,
      method: "sdk",
      duration_ms: duration,
    };
  } catch (err: unknown) {
    const duration = Date.now() - startTime;
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Instance "${instanceName}" timed out after ${Math.round(effectiveTimeout / 1000)}s`);
    }
    logger.error(`[dispatch] ${instanceName}.${agent} failed in ${duration}ms: ${err}`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
