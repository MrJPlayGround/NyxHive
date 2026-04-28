import type { ServerWebSocket } from "bun";
import type { ConnectionManager, WsData } from "./connection.js";
import type { DeviceStore } from "./auth.js";
import type { MethodRouter } from "./router.js";
import { logger } from "../../utils/logger.js";
import { getActiveGatewayInvocations } from "./register-handlers.js";
import { frameSchema } from "../../gateway/protocol/frame.js";
import { connectAuthenticatePayload } from "../../gateway/protocol/methods.js";

interface WsHandlerDeps {
  connections: ConnectionManager;
  devices: DeviceStore;
  router: MethodRouter;
}

/** Per-connection rate limiter: max messages per window */
const WS_RATE_LIMIT = 60;        // messages per window
const WS_RATE_WINDOW_MS = 10_000; // 10 second window
const WS_MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10MB max message size (file uploads)

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(deviceId: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(deviceId);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WS_RATE_WINDOW_MS };
    rateBuckets.set(deviceId, bucket);
  }
  bucket.count++;
  return bucket.count <= WS_RATE_LIMIT;
}

export function createWebSocketHandler(deps: WsHandlerDeps) {
  const { connections, devices, router } = deps;

  return {
    open(ws: ServerWebSocket<WsData>) {
      const challenge = devices.generateChallenge();
      ws.data.nonce = challenge.nonce;
      ws.send(
        JSON.stringify({
          type: "event",
          id: crypto.randomUUID(),
          method: "connect.challenge",
          payload: { nonce: challenge.nonce, protocolVersion: 1 },
        }),
      );
      logger.debug("[ws] New connection, challenge sent");
    },

    async message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      const raw = typeof message === "string" ? message : message.toString();

      // Message size limit
      if (raw.length > WS_MAX_MESSAGE_SIZE) {
        ws.close(1009, "Message too large");
        return;
      }

      // Rate limit (keyed by connection identity — deviceId or socket pointer)
      const rateKey = ws.data.deviceId ?? `anon-${ws.remoteAddress}`;
      if (!checkRateLimit(rateKey)) {
        ws.send(JSON.stringify({
          type: "res", id: "rate-limited", method: "error",
          payload: null, error: { code: "RATE_LIMITED", message: "Too many messages, slow down" },
        }));
        return;
      }

      // If not authenticated, only accept connect.authenticate
      if (!ws.data.authenticated) {
        try {
          const parsed = JSON.parse(raw);
          const frameResult = frameSchema.safeParse(parsed);
          if (!frameResult.success || frameResult.data.type !== "req") {
            ws.send(
              JSON.stringify({
                type: "res",
                id: "unknown",
                method: "connect.authenticate",
                payload: null,
                error: { code: "INVALID_FRAME", message: "Expected a request frame" },
              }),
            );
            return;
          }

          const frame = frameResult.data;
          if (frame.method !== "connect.authenticate") {
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                method: frame.method,
                payload: null,
                error: { code: "NOT_AUTHENTICATED", message: "Authenticate first" },
              }),
            );
            return;
          }

          const authPayload = connectAuthenticatePayload.safeParse(frame.payload);
          if (!authPayload.success) {
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                method: frame.method,
                payload: null,
                error: {
                  code: "INVALID_PAYLOAD",
                  message: authPayload.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", "),
                },
              }),
            );
            return;
          }

          const { deviceId, deviceName, signature, protocolVersion } = authPayload.data;
          if (protocolVersion !== 1) {
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                method: frame.method,
                payload: null,
                error: { code: "UNSUPPORTED_PROTOCOL", message: "Unsupported gateway protocol version" },
              }),
            );
            return;
          }

          // Check if device is known and approved
          if (!devices.isApproved(deviceId)) {
            // Register as pending if new
            await devices.registerDevice(deviceId, deviceName, signature);
            // Notify connected clients about pending device
            connections.broadcast("device:pending", { deviceId, deviceName });
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                method: frame.method,
                payload: null,
                error: { code: "DEVICE_PENDING", message: "Device pending approval" },
              }),
            );
            logger.info(`[ws] Device '${deviceName}' (${deviceId.slice(0, 8)}...) registered, pending approval`);
            return;
          }

          // Verify device
          const valid = await devices.verifyDevice(deviceId, signature);
          if (!valid) {
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                method: frame.method,
                payload: null,
                error: { code: "AUTH_FAILED", message: "Invalid credentials" },
              }),
            );
            return;
          }

          // Authenticated
          ws.data.deviceId = deviceId;
          ws.data.deviceName = deviceName;
          ws.data.authenticated = true;
          devices.updateLastSeen(deviceId);
          connections.add(deviceId, ws, { deviceName });

          // Count buffered messages before replaying (must be before initBuffer clears it)
          const bufferedCount = connections.getBufferedCount(deviceId);

          // Send auth response FIRST — client needs to be ready before we replay events
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              method: "connect.authenticate",
              payload: {
                sessionToken: deviceId,
                scopes: ["read", "write", "admin"],
                serverVersion: "0.1.0",
                bufferedMessages: bufferedCount,
              },
            }),
          );
          logger.info(`[ws] Device '${deviceName}' authenticated`);

          // Replay buffered messages AFTER auth response so client event handlers are registered
          if (bufferedCount > 0) {
            const replayed = connections.replayBuffered(deviceId, ws);
            logger.info(`[ws] Replayed ${replayed} buffered messages for '${deviceName}'`);
          }

          // Initialize buffer for future disconnects (after replay so we don't lose the existing buffer)
          connections.initBuffer(deviceId);

          // Notify client of all active gateway invocations (e.g. after page refresh)
          const activeInvocations = getActiveGatewayInvocations();
          for (const [runId, inv] of activeInvocations) {
            ws.send(JSON.stringify({
              type: "event",
              id: crypto.randomUUID(),
              method: "chat:active",
              payload: { agent: inv.agent, startedAt: inv.startedAt, threadId: inv.threadId, runId },
            }));
          }
        } catch {
          ws.close(1008, "Invalid auth frame");
        }
        return;
      }

      // Authenticated — dispatch to router
      const response = await router.dispatch(raw, ws.data.deviceId!);
      if (response) ws.send(response);
    },

    close(ws: ServerWebSocket<WsData>) {
      if (ws.data.deviceId) {
        connections.remove(ws.data.deviceId, ws);
        rateBuckets.delete(ws.data.deviceId);
        logger.debug(`[ws] Device '${ws.data.deviceName}' disconnected (buffering events)`);
      }
    },
  };
}
