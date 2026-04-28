export interface ActivityEvent {
  id: string;
  type: "completion" | "proposal" | "delegation" | "watchdog" | "system" | "error";
  agent: string;
  action: string;
  subject: string;
  detail?: string;
  timestamp: number;
}

export class ActivityRingBuffer {
  private buffer: ActivityEvent[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(event: ActivityEvent): void {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push(event);
  }

  getAll(): ActivityEvent[] {
    return [...this.buffer];
  }
}

let activityIdCounter = 0;
function nextActivityId(): string {
  return `act-${Date.now()}-${++activityIdCounter}`;
}

let globalBuffer: ActivityRingBuffer | null = null;
let globalBroadcast: ((event: string, payload: unknown) => void) | null = null;

export function initActivityStream(broadcast: (event: string, payload: unknown) => void, capacity = 50): ActivityRingBuffer {
  globalBuffer = new ActivityRingBuffer(capacity);
  globalBroadcast = broadcast;
  return globalBuffer;
}

export function emitActivity(event: Omit<ActivityEvent, "id" | "timestamp">): void {
  if (!globalBuffer) return;
  const full: ActivityEvent = {
    ...event,
    id: nextActivityId(),
    timestamp: Date.now(),
  };
  globalBuffer.push(full);
  globalBroadcast?.("activity:event", full);
}

export function getActivityBuffer(): ActivityRingBuffer | null {
  return globalBuffer;
}
