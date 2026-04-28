import { frameSchema, requestFrame, type Frame, type FrameError } from "../../protocol/frame";

type EventHandler = (frame: Frame) => void;

type PendingRequest = {
	resolve: (payload: unknown) => void;
	reject: (error: FrameError) => void;
	timeout: ReturnType<typeof setTimeout>;
};

export class GatewayClient {
	private ws: WebSocket | null = null;
	private pending = new Map<string, PendingRequest>();
	private eventHandlers = new Map<string, Set<EventHandler>>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay = 1000;
	private url: string | null = null;
	/** Queue events that arrive before handlers are registered (e.g. buffered replay after reconnect) */
	private earlyEventQueue: Frame[] = [];
	/** Resolvers waiting for the WS to open */
	private openWaiters: Array<() => void> = [];

	onConnectionChange?: (connected: boolean) => void;
	onChallenge?: (nonce: string) => void;
	/** Called when reconnected and auth completes, with count of replayed messages */
	onReconnected?: (bufferedMessages: number) => void;
	/** Called when a request fails (for global error reporting) */
	onRequestError?: (method: string, error: FrameError) => void;

	connect(url: string) {
		// Close existing connection to prevent duplicate WebSockets
		if (this.ws) {
			try { this.ws.close(); } catch { /* ignore */ }
		}
		this.url = url;
		this.earlyEventQueue = [];
		this.ws = new WebSocket(url);

		this.ws.onopen = () => {
			this.reconnectDelay = 1000;
			// Resolve any pending waitForOpen calls
			for (const resolve of this.openWaiters) resolve();
			this.openWaiters = [];
		};

		this.ws.onmessage = (event) => {
			const result = frameSchema.safeParse(JSON.parse(event.data));
			if (!result.success) return;

			const frame = result.data;

			if (frame.type === "res") {
				const pending = this.pending.get(frame.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pending.delete(frame.id);
					if (frame.error) {
						pending.reject(frame.error);
					} else {
						pending.resolve(frame.payload);
					}
				}
			} else if (frame.type === "event") {
				if (frame.method === "connect.challenge") {
					this.onChallenge?.((frame.payload as { nonce: string }).nonce);
				}
				const handlers = this.eventHandlers.get(frame.method);
				if (handlers && handlers.size > 0) {
					handlers.forEach((h) => h(frame));
				} else if (frame.method !== "connect.challenge") {
					// No handlers registered yet — queue for later (e.g. replayed events after reconnect)
					this.earlyEventQueue.push(frame);
				}
			}
		};

		this.ws.onclose = () => {
			this.onConnectionChange?.(false);
			this.scheduleReconnect();
		};

		this.ws.onerror = () => {
			this.ws?.close();
		};
	}

	async request<T = unknown>(method: string, payload: unknown, timeoutMs = 30000): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			// Wait for connection instead of immediately rejecting
			await this.waitForOpen(timeoutMs);
		}

		const frame = requestFrame(method, payload);

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(frame.id);
				const err = { code: "TIMEOUT", message: `Request ${method} timed out` };
				this.onRequestError?.(method, err);
				reject(err);
			}, timeoutMs);

			this.pending.set(frame.id, {
				resolve: resolve as (p: unknown) => void,
				reject: (error: FrameError) => {
					this.onRequestError?.(method, error);
					reject(error);
				},
				timeout,
			});

			this.ws!.send(JSON.stringify(frame));
		});
	}

	on(event: string, handler: EventHandler): () => void {
		if (!this.eventHandlers.has(event)) {
			this.eventHandlers.set(event, new Set());
		}
		this.eventHandlers.get(event)!.add(handler);

		// Flush any queued events for this event type (from before handlers were registered)
		if (this.earlyEventQueue.length > 0) {
			const pending = this.earlyEventQueue.filter((f) => f.method === event);
			this.earlyEventQueue = this.earlyEventQueue.filter((f) => f.method !== event);
			for (const frame of pending) {
				handler(frame);
			}
		}

		return () => {
			this.eventHandlers.get(event)?.delete(handler);
		};
	}

	disconnect() {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.ws?.close();
		this.ws = null;
	}

	get isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	/** Wait for the WebSocket to be in OPEN state (resolves immediately if already open) */
	waitForOpen(timeoutMs = 10000): Promise<void> {
		if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				// Remove from waiters on timeout
				this.openWaiters = this.openWaiters.filter((r) => r !== onOpen);
				reject({ code: "WS_TIMEOUT", message: "WebSocket did not open in time" });
			}, timeoutMs);
			const onOpen = () => {
				clearTimeout(timer);
				resolve();
			};
			this.openWaiters.push(onOpen);
		});
	}

	private scheduleReconnect() {
		if (!this.url) return;
		const url = this.url;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
			this.connect(url);
		}, this.reconnectDelay);
	}
}

export const gateway = new GatewayClient();
