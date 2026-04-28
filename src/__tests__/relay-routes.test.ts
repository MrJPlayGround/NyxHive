import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayRoutes } from "../server/routes/relay.js";
import { RELAY_PRESENTING_INSTANCE_HEADER, RelayCallbackManager } from "../federation/relay.js";

describe("relay callback routes", () => {
  test("forwards callback sender metadata into processImmediate identity", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "relay-msg",
        response: "relay reply",
        agent: "nyx",
      })),
    };
    const dataDir = mkdtempSync(join(tmpdir(), "relay-routes-"));
    const relayCallbacks = new RelayCallbackManager({
      daemon: { name: "NyxAI", data_dir: dataDir } as any,
      server: { public_url: "https://nyx.example.com" } as any,
    });
    const relay = relayCallbacks.issue("remote");
    const app = relayRoutes(processor as any, relayCallbacks);

    try {
      const res = await app.request("/callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-NyxRelay-Token": relay.callbackToken,
          [RELAY_PRESENTING_INSTANCE_HEADER]: "remote",
        },
        body: JSON.stringify({
          message: "reply from origin",
          sender: "NyxAI",
        }),
      });

      expect(res.status).toBe(200);
      expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
        channel: "relay",
        sender: "NyxAI",
        sender_id: "NyxAI",
        message: "reply from origin",
      }));
    } finally {
      relayCallbacks.close();
    }
  });

  test("rejects callback when the presenting instance does not match the issued remote", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "relay-msg",
        response: "relay reply",
        agent: "nyx",
      })),
    };
    const dataDir = mkdtempSync(join(tmpdir(), "relay-routes-"));
    const relayCallbacks = new RelayCallbackManager({
      daemon: { name: "NyxAI", data_dir: dataDir } as any,
      server: { public_url: "https://nyx.example.com" } as any,
    });
    const relay = relayCallbacks.issue("remote");
    const app = relayRoutes(processor as any, relayCallbacks);

    try {
      const res = await app.request("/callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-NyxRelay-Token": relay.callbackToken,
          [RELAY_PRESENTING_INSTANCE_HEADER]: "other-remote",
        },
        body: JSON.stringify({
          message: "reply from origin",
          sender: "NyxAI",
        }),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ status: "invalid" });
      expect(processor.processImmediate).not.toHaveBeenCalled();
    } finally {
      relayCallbacks.close();
    }
  });

  test("defaults callback identity to the validated remote when sender metadata is omitted", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "relay-msg",
        response: "relay reply",
        agent: "nyx",
      })),
    };
    const dataDir = mkdtempSync(join(tmpdir(), "relay-routes-"));
    const relayCallbacks = new RelayCallbackManager({
      daemon: { name: "NyxAI", data_dir: dataDir } as any,
      server: { public_url: "https://nyx.example.com" } as any,
    });
    const relay = relayCallbacks.issue("remote-a");
    const app = relayRoutes(processor as any, relayCallbacks);

    try {
      const res = await app.request("/callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-NyxRelay-Token": relay.callbackToken,
          [RELAY_PRESENTING_INSTANCE_HEADER]: "remote-a",
        },
        body: JSON.stringify({
          message: "reply from origin",
        }),
      });

      expect(res.status).toBe(200);
      expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
        channel: "relay",
        sender: "remote-a",
        sender_id: "remote-a",
        message: "reply from origin",
      }));
    } finally {
      relayCallbacks.close();
    }
  });

  test("treats duplicate callback nonces as idempotent and does not reprocess the message", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "relay-msg",
        response: "relay reply",
        agent: "nyx",
      })),
    };
    const dataDir = mkdtempSync(join(tmpdir(), "relay-routes-"));
    const relayCallbacks = new RelayCallbackManager({
      daemon: { name: "NyxAI", data_dir: dataDir } as any,
      server: { public_url: "https://nyx.example.com" } as any,
    });
    const relay = relayCallbacks.issue("remote-a");
    const app = relayRoutes(processor as any, relayCallbacks);

    try {
      const headers = {
        "Content-Type": "application/json",
        "X-NyxRelay-Token": relay.callbackToken,
        [RELAY_PRESENTING_INSTANCE_HEADER]: "remote-a",
      };
      const body = JSON.stringify({
        message: "reply from origin",
        nonce: "nonce-1",
      });

      const first = await app.request("/callback", {
        method: "POST",
        headers,
        body,
      });
      const second = await app.request("/callback", {
        method: "POST",
        headers,
        body,
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(202);
      expect(await second.json()).toEqual({ status: "duplicate" });
      expect(processor.processImmediate).toHaveBeenCalledTimes(1);
    } finally {
      relayCallbacks.close();
    }
  });
});
