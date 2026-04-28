import { describe, expect, test } from "bun:test";
import {
  formatHealthSummary,
  formatHealthUnreachableSummary,
  formatQueueDeadLetterSample,
  formatQueueDeadLetterSummary,
  formatQueueSummary,
} from "../cli/status-format.js";

describe("CLI status formatting", () => {
  test("uses health queue dead letter totals", () => {
    const summary = formatQueueSummary({
      stats: { pending: 0, completed: 257, dead_letter: 6 },
      deadLetters: 6,
    });

    expect(summary).toBe("0 pending, 257 completed, 6 dead");
  });

  test("includes active processing work in the queue summary", () => {
    const summary = formatQueueSummary({
      stats: { pending: 0, completed: 477, dead_letter: 3 },
      processing: 1,
      deadLetters: 3,
    });

    expect(summary).toBe("0 pending, 1 processing, 477 completed, 3 dead");
  });

  test("uses degraded health status from response body", () => {
    expect(formatHealthSummary({ status: "degraded", ok: false })).toBe("degraded");
  });

  test("describes unreachable health with live PID and fetch error", () => {
    const summary = formatHealthUnreachableSummary({
      pid: 77850,
      error: Object.assign(
        new Error("Unable to connect. Is the computer able to access the url?"),
        { code: "ConnectionRefused" },
      ),
    });

    expect(summary).toBe("unreachable with live PID 77850: Unable to connect. Is the computer able to access the url? (ConnectionRefused)");
  });

  test("summarizes queue dead letter categories from health details", () => {
    const summary = formatQueueDeadLetterSummary({
      dead_letters: {
        total: 13,
        retryable: 1,
        categories: {
          configuration: 12,
          transient: 1,
        },
      },
    });

    expect(summary).toBe("12 configuration, 1 transient; 1 retryable");
  });

  test("summarizes the latest queue dead letter sample", () => {
    const summary = formatQueueDeadLetterSample({
      dead_letters: {
        total: 14,
        samples: [
          {
            message_id: "65ecbbd4-217a-4fa0-a1ba-f50688b1c58c",
            error: "Codex Exec exited with signal SIGTERM: Reading prompt from stdin...\n",
            analysis: {
              category: "configuration",
            },
          },
        ],
      },
    });

    expect(summary).toBe("configuration: Codex Exec exited with signal SIGTERM: Reading prompt from stdin...");
  });

  test("extracts provider error messages from JSON dead letter samples", () => {
    const summary = formatQueueDeadLetterSample({
      dead_letters: {
        total: 1,
        samples: [
          {
            message_id: "bc77963e-a5af-48f3-8ad4-0dca200d5dc1",
            error: JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                code: "invalid_value",
                message: "Invalid 'input[2].content[2].image_url'. Expected a base64-encoded data URL.",
                param: "input[2].content[2].image_url",
              },
              status: 400,
            }),
            analysis: {
              category: "permanent",
            },
          },
        ],
      },
    });

    expect(summary).toBe("permanent: Invalid 'input[2].content[2].image_url'. Expected a base64-encoded data URL.");
  });
});
