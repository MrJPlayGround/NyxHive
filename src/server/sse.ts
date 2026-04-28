import type { SSEEvent } from "../types.js";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../defaults.js";

/**
 * SSE (Server-Sent Events) streaming helper.
 * Returns a Response that streams events to the client.
 */
export function createSSEStream(
  subscribe: (listener: (event: SSEEvent) => void) => () => void,
): Response {
  let heartbeat: ReturnType<typeof setInterval>;
  let unsubscribe: () => void;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      unsubscribe = subscribe((event) => {
        try {
          const data = JSON.stringify({ type: event.type, ...event.data, timestamp: event.timestamp });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // Stream closed — unsubscribe to stop receiving events
          if (unsubscribe) unsubscribe();
        }
      });

      // Send initial heartbeat
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Heartbeat to keep connection alive
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
          if (unsubscribe) unsubscribe();
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
