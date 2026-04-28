import { describe, it, expect } from "bun:test";
import { frameSchema, requestFrame, responseFrame, eventFrame } from "../gateway/protocol/frame";
import { methodSchemas, chatSendRequest, connectAuthenticatePayload } from "../gateway/protocol/methods";
import {
  eventSchemas,
  agentProgressEvent,
  logEntryEvent,
  runtimeTurnStartedEvent,
  runtimeRequestOpenedEvent,
} from "../gateway/protocol/events";

describe("WebSocket Protocol Frames", () => {
  it("validates a request frame", () => {
    const frame = {
      type: "req",
      id: "abc-123",
      method: "chat.send",
      payload: { message: "hello" },
    };
    expect(frameSchema.safeParse(frame).success).toBe(true);
  });

  it("validates a response frame with error", () => {
    const frame = {
      type: "res",
      id: "abc-123",
      method: "chat.send",
      payload: null,
      error: { code: "NOT_FOUND", message: "Thread not found" },
    };
    expect(frameSchema.safeParse(frame).success).toBe(true);
  });

  it("validates an event frame", () => {
    const frame = {
      type: "event",
      id: "evt-1",
      method: "agent:progress",
      payload: { agent: "forge", text: "Working..." },
    };
    expect(frameSchema.safeParse(frame).success).toBe(true);
  });

  it("rejects invalid frame type", () => {
    const frame = { type: "invalid", id: "x", method: "y", payload: {} };
    expect(frameSchema.safeParse(frame).success).toBe(false);
  });

  it("creates request frames with UUID", () => {
    const frame = requestFrame("chat.send", { message: "hello" });
    expect(frame.type).toBe("req");
    expect(frame.method).toBe("chat.send");
    expect(frame.id).toBeTruthy();
    expect(frame.payload).toEqual({ message: "hello" });
  });

  it("creates response frames", () => {
    const frame = responseFrame("req-1", "chat.send", { messageId: "m1", threadId: "t1" });
    expect(frame.type).toBe("res");
    expect(frame.id).toBe("req-1");
    expect(frame.error).toBeUndefined();
  });

  it("creates response frames with error", () => {
    const error = { code: "HANDLER_ERROR", message: "Something failed" };
    const frame = responseFrame("req-1", "chat.send", null, error);
    expect(frame.error).toEqual(error);
  });

  it("creates event frames", () => {
    const frame = eventFrame("agent:progress", { agent: "forge", text: "hi" });
    expect(frame.type).toBe("event");
    expect(frame.method).toBe("agent:progress");
  });
});

describe("Method Schemas", () => {
  it("validates chat.send request", () => {
    expect(chatSendRequest.safeParse({ message: "hello" }).success).toBe(true);
    expect(chatSendRequest.safeParse({ message: "hello", agent: "forge" }).success).toBe(true);
    expect(chatSendRequest.safeParse({ message: "hello", idempotencyKey: "send-1" }).success).toBe(true);
    expect(chatSendRequest.safeParse({}).success).toBe(false);
  });

  it("validates connect.authenticate payload", () => {
    const payload = {
      deviceId: "d-1",
      deviceName: "Gateway",
      signature: "sig123",
      protocolVersion: 1,
    };
    expect(connectAuthenticatePayload.safeParse(payload).success).toBe(true);
  });

  it("has schemas for all registered methods", () => {
    for (const [method, schema] of Object.entries(methodSchemas)) {
      expect(schema.request).toBeTruthy();
      expect(schema.response).toBeTruthy();
    }
  });

  it("registers expected method count", () => {
    const methods = Object.keys(methodSchemas);
    expect(methods.length).toBeGreaterThanOrEqual(20);
  });
});

describe("Event Schemas", () => {
  it("validates agent:progress event", () => {
    const payload = { agent: "forge", messageId: "m1", text: "Working..." };
    expect(agentProgressEvent.safeParse(payload).success).toBe(true);
  });

  it("validates log:entry event", () => {
    const payload = { level: "info", message: "Started", timestamp: Date.now() };
    expect(logEntryEvent.safeParse(payload).success).toBe(true);
  });

  it("validates turn.started runtime events", () => {
    const payload = { threadId: "thread-1", turn: 2, runId: "chat:thread-1:2", agent: "nyx", startedAt: Date.now() };
    expect(runtimeTurnStartedEvent.safeParse(payload).success).toBe(true);
  });

  it("validates request.opened runtime events", () => {
    const payload = {
      requestId: "proposal:abc",
      kind: "proposal_approval",
      title: "Approve proposal: Diff drawer",
      createdAt: Date.now(),
      actions: [{ id: "approve", label: "Approve", variant: "primary" }],
      proposal: { proposalId: "abc", title: "Diff drawer" },
    };
    expect(runtimeRequestOpenedEvent.safeParse(payload).success).toBe(true);
  });

  it("has schemas for all registered events", () => {
    for (const [event, schema] of Object.entries(eventSchemas)) {
      expect(schema).toBeTruthy();
    }
  });

  it("registers expected event count", () => {
    const events = Object.keys(eventSchemas);
    expect(events.length).toBeGreaterThanOrEqual(7);
  });
});
