import { eventFrame } from "../../gateway/protocol/frame.js";
import type { EventName } from "../../gateway/protocol/events.js";
import type { ServerWebSocket } from "bun";

interface ConnectedClient {
  deviceId: string;
  deviceName: string;
  ws: ServerWebSocket<WsData>;
  scopes: string[];
  connectedAt: number;
  subscriptions: Set<string>;
}

interface BufferedMessage {
  seq: number;
  data: string;
  timestamp: number;
}

export interface WsData {
  deviceId: string | null;
  deviceName: string | null;
  authenticated: boolean;
  nonce: string | null;
}

const MAX_BUFFER_SIZE = 200;
const BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ConnectionManager {
  private clients = new Map<string, ConnectedClient>();
  /** Per-device message buffer for replay on reconnect */
  private buffers = new Map<string, BufferedMessage[]>();
  /** Global sequence counter for ordering */
  private seq = 0;

  add(deviceId: string, ws: ServerWebSocket<WsData>, meta?: { deviceName?: string; scopes?: string[] }) {
    this.clients.set(deviceId, {
      deviceId,
      deviceName: meta?.deviceName ?? "unknown",
      ws,
      scopes: meta?.scopes ?? [],
      connectedAt: Date.now(),
      subscriptions: new Set(),
    });
  }

  remove(deviceId: string, ws?: ServerWebSocket<WsData>) {
    // If a specific WS is provided, only remove if it matches the current one.
    // This prevents a late-firing close event from a stale WS from removing
    // a newer connection that already re-authenticated.
    if (ws) {
      const current = this.clients.get(deviceId);
      if (current && current.ws !== ws) return;
    }
    this.clients.delete(deviceId);
    // Keep buffer alive for reconnect — it'll be cleaned up by TTL
  }

  get(deviceId: string): ConnectedClient | undefined {
    return this.clients.get(deviceId);
  }

  count(): number {
    return this.clients.size;
  }

  getStats(): {
    connected: number;
    bufferedDevices: number;
    bufferedMessages: number;
    subscriptions: number;
    seq: number;
  } {
    let bufferedMessages = 0;
    for (const messages of this.buffers.values()) {
      bufferedMessages += messages.length;
    }
    let subscriptions = 0;
    for (const client of this.clients.values()) {
      subscriptions += client.subscriptions.size;
    }
    return {
      connected: this.clients.size,
      bufferedDevices: this.buffers.size,
      bufferedMessages,
      subscriptions,
      seq: this.seq,
    };
  }

  /** Get current sequence number (for client to track) */
  getSeq(): number {
    return this.seq;
  }

  subscribe(deviceId: string, eventType: string) {
    this.clients.get(deviceId)?.subscriptions.add(eventType);
  }

  unsubscribe(deviceId: string, eventType: string) {
    this.clients.get(deviceId)?.subscriptions.delete(eventType);
  }

  broadcast(method: EventName | string, payload: unknown) {
    const frame = eventFrame(method, payload);
    const msg = JSON.stringify(frame);
    this.seq++;

    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      } else {
        // Client disconnected — buffer the message
        this.bufferMessage(client.deviceId, msg);
      }
    }

    // Also buffer for devices that were recently connected but are now gone
    // (removed from clients map but buffer still exists)
    for (const deviceId of this.buffers.keys()) {
      if (!this.clients.has(deviceId)) {
        this.bufferMessage(deviceId, msg);
      }
    }
  }

  broadcastToSubscribed(method: string, payload: unknown) {
    const frame = eventFrame(method, payload);
    const msg = JSON.stringify(frame);
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(method) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  /** Buffer a message for a disconnected device */
  private bufferMessage(deviceId: string, data: string) {
    if (!this.buffers.has(deviceId)) {
      this.buffers.set(deviceId, []);
    }
    const buf = this.buffers.get(deviceId)!;
    buf.push({ seq: this.seq, data, timestamp: Date.now() });
    // Trim to max size
    if (buf.length > MAX_BUFFER_SIZE) {
      buf.splice(0, buf.length - MAX_BUFFER_SIZE);
    }
  }

  /** Replay buffered messages for a reconnecting device and clear the buffer */
  replayBuffered(deviceId: string, ws: ServerWebSocket<WsData>): number {
    const buf = this.buffers.get(deviceId);
    if (!buf || buf.length === 0) return 0;

    const now = Date.now();
    let replayed = 0;
    for (const msg of buf) {
      // Skip expired messages
      if (now - msg.timestamp > BUFFER_TTL_MS) continue;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg.data);
        replayed++;
      }
    }
    this.buffers.delete(deviceId);
    return replayed;
  }

  /** Get count of buffered (non-expired) messages for a device */
  getBufferedCount(deviceId: string): number {
    const buf = this.buffers.get(deviceId);
    if (!buf) return 0;
    const now = Date.now();
    return buf.filter(m => now - m.timestamp <= BUFFER_TTL_MS).length;
  }

  /** Initialize buffer for a device (called on first connect so we buffer during disconnects) */
  initBuffer(deviceId: string) {
    if (!this.buffers.has(deviceId)) {
      this.buffers.set(deviceId, []);
    }
  }

  /** Clean up stale buffers */
  cleanupBuffers() {
    const now = Date.now();
    for (const [deviceId, buf] of this.buffers) {
      // Remove if all messages are expired
      if (buf.length === 0 || (buf.length > 0 && now - buf[buf.length - 1].timestamp > BUFFER_TTL_MS)) {
        this.buffers.delete(deviceId);
      }
    }
  }

  /** Send WebSocket ping to all connected clients (keeps Bun idleTimeout alive) */
  pingAll() {
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }

  listConnected(): Array<{ deviceId: string; deviceName: string; connectedAt: number }> {
    return Array.from(this.clients.values()).map(c => ({
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
    }));
  }
}
