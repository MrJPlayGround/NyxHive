import { afterEach, describe, expect, it } from "bun:test";
import { InflightTracker } from "../channels/inflight.js";
import {
  describeShutdownCause,
  noteShutdownSignal,
  recordShutdownRequest,
  resetShutdownTracking,
} from "../utils/shutdown.js";

describe("InflightTracker", () => {
  it("waits for tracked work to finish", async () => {
    const tracker = new InflightTracker();
    let resolveTask!: () => void;
    const task = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });

    tracker.track(task);
    const wait = tracker.waitForIdle(100);
    resolveTask();

    await expect(wait).resolves.toEqual({ drained: true, pending: 0 });
  });

  it("reports pending work when the timeout elapses", async () => {
    const tracker = new InflightTracker();
    tracker.track(new Promise<void>(() => {}));

    await expect(tracker.waitForIdle(10)).resolves.toEqual({ drained: false, pending: 1 });
  });
});

describe("shutdown tracking", () => {
  afterEach(() => {
    resetShutdownTracking();
  });

  it("includes both the request source and signal in the shutdown cause", () => {
    recordShutdownRequest("api/admin/shutdown", "caller=127.0.0.1");
    noteShutdownSignal("SIGTERM");

    expect(describeShutdownCause()).toBe("request=api/admin/shutdown (caller=127.0.0.1) signal=SIGTERM");
  });

  it("falls back to unknown when nothing recorded the shutdown cause", () => {
    expect(describeShutdownCause()).toBe("request=unknown");
  });
});
