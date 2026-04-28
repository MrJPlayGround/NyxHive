import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_STARTUP_GRACE_MS,
  MIN_STALL_TIMEOUT_MS,
  getInvocationStallTimeoutMs,
  getInvocationStartupGraceMs,
} from "../agents/stall-timeout.js";

const ORIGINAL_STALL_TIMEOUT = process.env.NYXHIVE_STALL_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_STALL_TIMEOUT === undefined) {
    delete process.env.NYXHIVE_STALL_TIMEOUT_MS;
    return;
  }
  process.env.NYXHIVE_STALL_TIMEOUT_MS = ORIGINAL_STALL_TIMEOUT;
});

describe("getInvocationStallTimeoutMs", () => {
  test("defaults to the raised 20 minute timeout", () => {
    delete process.env.NYXHIVE_STALL_TIMEOUT_MS;
    expect(getInvocationStallTimeoutMs()).toBe(DEFAULT_STALL_TIMEOUT_MS);
  });

  test("accepts an explicit override", () => {
    process.env.NYXHIVE_STALL_TIMEOUT_MS = "1200000";
    expect(getInvocationStallTimeoutMs()).toBe(1_200_000);
  });

  test("clamps tiny values to a sane minimum", () => {
    process.env.NYXHIVE_STALL_TIMEOUT_MS = "1000";
    expect(getInvocationStallTimeoutMs()).toBe(MIN_STALL_TIMEOUT_MS);
  });

  test("ignores invalid values", () => {
    process.env.NYXHIVE_STALL_TIMEOUT_MS = "five minutes";
    expect(getInvocationStallTimeoutMs()).toBe(DEFAULT_STALL_TIMEOUT_MS);
  });

  test("keeps startup grace at least as large as stall timeout", () => {
    delete process.env.NYXHIVE_STALL_TIMEOUT_MS;
    expect(getInvocationStartupGraceMs()).toBe(DEFAULT_STARTUP_GRACE_MS);

    process.env.NYXHIVE_STALL_TIMEOUT_MS = "1800000";
    expect(getInvocationStartupGraceMs()).toBe(1_800_000);
  });
});
