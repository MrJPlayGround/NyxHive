/**
 * Event bus for SSE and thread-scoped event pub/sub.
 * Extracted from QueueProcessor to isolate event infrastructure.
 */

import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import type { SSEEvent, ThreadEvent } from "../types.js";

export class EventBus {
  private eventListeners: Set<(event: SSEEvent) => void> = new Set();
  private messageListeners: Map<string, (event: SSEEvent) => void> = new Map();
  private threadListeners: Map<string, Set<(event: ThreadEvent) => void>> = new Map();
  private globalThreadListeners: Set<(event: ThreadEvent) => void> = new Set();

  /** Subscribe to global SSE events. Returns unsubscribe function. */
  onEvent(listener: (event: SSEEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Subscribe to events for a specific thread. Returns unsubscribe function. */
  onThreadEvent(threadId: string, callback: (event: ThreadEvent) => void): () => void {
    if (!this.threadListeners.has(threadId)) {
      this.threadListeners.set(threadId, new Set());
    }
    this.threadListeners.get(threadId)!.add(callback);
    return () => {
      this.threadListeners.get(threadId)?.delete(callback);
      if (this.threadListeners.get(threadId)?.size === 0) {
        this.threadListeners.delete(threadId);
      }
    };
  }

  /** Subscribe to ALL thread events globally (for status bars, dashboards). Returns unsubscribe function. */
  onGlobalThreadEvent(callback: (event: ThreadEvent) => void): () => void {
    this.globalThreadListeners.add(callback);
    return () => this.globalThreadListeners.delete(callback);
  }

  /** Emit a thread-scoped event to per-thread subscribers and global listeners. */
  emitThreadEvent(threadId: string, type: string, data: Record<string, unknown>): void {
    const event: ThreadEvent = { type, thread_id: threadId, data, timestamp: Date.now() };

    const listeners = this.threadListeners.get(threadId);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(event); } catch (err) {
          logger.debug(`[processor] Thread listener error for ${type}/${threadId}: ${formatError(err)}`);
        }
      }
    }

    for (const cb of this.globalThreadListeners) {
      try { cb(event); } catch (err) {
        logger.debug(`[processor] Global thread listener error for ${type}: ${formatError(err)}`);
      }
    }
  }

  /** Emit a global SSE event + per-message listener. */
  emit(type: string, data: Record<string, unknown>): void {
    const event: SSEEvent = { type, data, timestamp: Date.now() };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        logger.debug(`[processor] Event listener error for ${type}: ${formatError(err)}`);
      }
    }
    // Per-message listener (for streaming responses)
    const msgId = data.message_id as string | undefined;
    if (msgId) {
      const messageListener = this.messageListeners.get(msgId);
      if (messageListener) {
        try { messageListener(event); } catch (err) {
          logger.debug(`[processor] Message listener error for ${type}/${msgId}: ${formatError(err)}`);
        }
      }
    }
  }

  /** Register a per-message event listener (for streaming). */
  setMessageListener(messageId: string, listener: (event: SSEEvent) => void): void {
    this.messageListeners.set(messageId, listener);
  }

  /** Remove a per-message event listener. */
  removeMessageListener(messageId: string): void {
    this.messageListeners.delete(messageId);
  }
}
