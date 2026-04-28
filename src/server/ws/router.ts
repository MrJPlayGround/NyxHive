import { frameSchema, responseFrame, } from "../../gateway/protocol/frame.js";
import { methodSchemas, type MethodName } from "../../gateway/protocol/methods.js";

type HandlerFn = (payload: unknown, deviceId: string) => Promise<unknown>;

interface MethodMetric {
  method: string;
  count: number;
  failures: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  lastMs: number;
  lastCalledAt: number;
  lastError?: string;
}

export class MethodRouter {
  private handlers = new Map<string, HandlerFn>();
  private metrics = new Map<string, Omit<MethodMetric, "avgMs">>();

  register(method: string, handler: HandlerFn) {
    this.handlers.set(method, handler);
  }

  listMethods(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  getMetrics(): MethodMetric[] {
    return Array.from(this.metrics.values())
      .map((metric) => ({
        ...metric,
        avgMs: metric.count > 0 ? Math.round((metric.totalMs / metric.count) * 10) / 10 : 0,
      }))
      .sort((left, right) => left.method.localeCompare(right.method));
  }

  private recordMetric(method: string, startedAt: number, error?: string) {
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    const current = this.metrics.get(method) ?? {
      method,
      count: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
      lastCalledAt: 0,
    };
    current.count++;
    current.totalMs += elapsed;
    current.maxMs = Math.max(current.maxMs, elapsed);
    current.lastMs = elapsed;
    current.lastCalledAt = Date.now();
    if (error) {
      current.failures++;
      current.lastError = error;
    }
    this.metrics.set(method, current);
  }

  async dispatch(raw: string, deviceId: string): Promise<string | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return JSON.stringify(
        responseFrame("unknown", "error", null, {
          code: "INVALID_JSON",
          message: "Failed to parse JSON",
        }),
      );
    }

    const parseResult = frameSchema.safeParse(parsed);
    if (!parseResult.success) {
      return JSON.stringify(
        responseFrame("unknown", "error", null, {
          code: "INVALID_FRAME",
          message: "Failed to parse frame",
        }),
      );
    }

    const frame = parseResult.data;
    if (frame.type !== "req") return null;

    const handler = this.handlers.get(frame.method);
    if (!handler) {
      return JSON.stringify(
        responseFrame(frame.id, frame.method, null, {
          code: "METHOD_NOT_FOUND",
          message: `Unknown method: ${frame.method}`,
        }),
      );
    }

    // Validate request payload against schema — reject methods without a schema
    const schema = methodSchemas[frame.method as MethodName];
    if (!schema) {
      return JSON.stringify(
        responseFrame(frame.id, frame.method, null, {
          code: "NO_SCHEMA",
          message: `No validation schema for method: ${frame.method}`,
        }),
      );
    }
    const validation = schema.request.safeParse(frame.payload);
    if (!validation.success) {
      return JSON.stringify(
        responseFrame(frame.id, frame.method, null, {
          code: "INVALID_PAYLOAD",
          message: validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
        }),
      );
    }

    const startedAt = performance.now();
    try {
      const result = await handler(frame.payload, deviceId);
      this.recordMetric(frame.method, startedAt);
      return JSON.stringify(responseFrame(frame.id, frame.method, result));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.recordMetric(frame.method, startedAt, message);
      return JSON.stringify(
        responseFrame(frame.id, frame.method, null, {
          code: "HANDLER_ERROR",
          message,
        }),
      );
    }
  }
}
