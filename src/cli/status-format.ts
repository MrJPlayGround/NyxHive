type QueueStatus = {
  pending?: unknown;
  processing?: unknown;
  suspended?: unknown;
  completed?: unknown;
  dead_letter?: unknown;
  queueDepth?: unknown;
  deadLetters?: unknown;
  stats?: {
    pending?: unknown;
    completed?: unknown;
    dead_letter?: unknown;
  };
  dead_letters?: {
    total?: unknown;
    retryable?: unknown;
    categories?: Record<string, unknown>;
    samples?: Array<{
      message_id?: unknown;
      error?: unknown;
      analysis?: {
        category?: unknown;
      };
    }>;
  };
};

type HealthStatus = {
  status?: unknown;
  ok?: unknown;
};

type HealthUnreachableStatus = {
  pid?: number | null;
  error?: unknown;
};

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function describeError(error: unknown): string | null {
  const message = error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : typeof error === "string" && error.trim().length > 0
      ? error.trim()
      : null;

  if (!message) return null;

  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && code.trim().length > 0
    ? `${message} (${code.trim()})`
    : message;
}

export function formatHealthSummary(health: HealthStatus): string {
  if (typeof health.status === "string" && health.status.trim().length > 0) {
    return health.status;
  }
  return health.ok === false ? "degraded" : "OK";
}

export function formatHealthUnreachableSummary(status: HealthUnreachableStatus = {}): string {
  const parts = ["unreachable"];
  if (typeof status.pid === "number" && Number.isFinite(status.pid)) {
    parts.push(`with live PID ${status.pid}`);
  }

  const reason = describeError(status.error);
  return reason ? `${parts.join(" ")}: ${reason}` : parts.join(" ");
}

export function formatQueueSummary(queue: QueueStatus): string {
  const pending = readCount(queue.pending) ?? readCount(queue.queueDepth) ?? readCount(queue.stats?.pending) ?? 0;
  const processing = readCount(queue.processing);
  const suspended = readCount(queue.suspended);
  const completed = readCount(queue.completed) ?? readCount(queue.stats?.completed) ?? 0;
  const dead =
    readCount(queue.dead_letter)
    ?? readCount(queue.deadLetters)
    ?? readCount(queue.stats?.dead_letter)
    ?? readCount(queue.dead_letters?.total)
    ?? 0;

  const parts = [`${pending} pending`];
  if (processing && processing > 0) parts.push(`${processing} processing`);
  if (suspended && suspended > 0) parts.push(`${suspended} suspended`);
  parts.push(`${completed} completed`, `${dead} dead`);

  return parts.join(", ");
}

export function formatQueueDeadLetterSummary(queue: QueueStatus): string | null {
  const dead =
    readCount(queue.dead_letter)
    ?? readCount(queue.deadLetters)
    ?? readCount(queue.stats?.dead_letter)
    ?? readCount(queue.dead_letters?.total)
    ?? 0;
  if (dead === 0) return null;

  const categories = Object.entries(queue.dead_letters?.categories ?? {})
    .flatMap(([category, count]) => {
      const value = readCount(count);
      return value && value > 0 ? [{ category, count: value }] : [];
    })
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const categorySummary = categories.length > 0
    ? categories.map(({ category, count }) => `${count} ${category}`).join(", ")
    : `${dead} uncategorized`;
  const retryable = readCount(queue.dead_letters?.retryable);

  return retryable == null ? categorySummary : `${categorySummary}; ${retryable} retryable`;
}

function extractDeadLetterMessage(error: string): string {
  const normalized = error.trim().replace(/\s+/g, " ");
  try {
    const parsed = JSON.parse(error) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const innerError = "error" in parsed ? (parsed as { error?: unknown }).error : undefined;
      if (typeof innerError === "object" && innerError !== null && "message" in innerError) {
        const message = (innerError as { message?: unknown }).message;
        if (typeof message === "string" && message.trim().length > 0) {
          return message.trim().replace(/\s+/g, " ");
        }
      }
    }
  } catch {
    // Plain text errors are the common path.
  }
  return normalized;
}

export function formatQueueDeadLetterSample(queue: QueueStatus): string | null {
  const sample = queue.dead_letters?.samples?.[0];
  if (!sample || typeof sample.error !== "string" || sample.error.trim().length === 0) {
    return null;
  }

  const error = extractDeadLetterMessage(sample.error);
  const category = typeof sample.analysis?.category === "string" && sample.analysis.category.trim().length > 0
    ? `${sample.analysis.category.trim()}: `
    : "";

  return `${category}${error}`;
}
