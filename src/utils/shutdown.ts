interface ShutdownRequest {
  source: string;
  detail?: string;
}

interface ShutdownSignal {
  signal: NodeJS.Signals;
}

let currentRequest: ShutdownRequest | null = null;
let currentSignal: ShutdownSignal | null = null;

export function recordShutdownRequest(source: string, detail?: string): void {
  currentRequest = {
    source,
    detail,
  };
}

export function noteShutdownSignal(signal: NodeJS.Signals): void {
  currentSignal = {
    signal,
  };
}

export function describeShutdownCause(): string {
  const parts: string[] = [];

  if (currentRequest) {
    const detail = currentRequest.detail ? ` (${currentRequest.detail})` : "";
    parts.push(`request=${currentRequest.source}${detail}`);
  }

  if (currentSignal) {
    parts.push(`signal=${currentSignal.signal}`);
  }

  return parts.length > 0
    ? parts.join(" ")
    : "request=unknown";
}

export function resetShutdownTracking(): void {
  currentRequest = null;
  currentSignal = null;
}
