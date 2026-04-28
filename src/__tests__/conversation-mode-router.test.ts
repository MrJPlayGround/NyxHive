import { describe, expect, test } from "bun:test";

import {
  resolveAutoConversationMode,
  resolveIngressConversationMode,
} from "../runtime/conversation-mode-router.js";
import { chooseTelegramModelTier } from "../channels/telegram-model-routing.js";

describe("shared conversation mode router", () => {
  test("matches the workspace auto resolver for lightweight and build turns", () => {
    expect(resolveAutoConversationMode({ message: "thanks nyx" })).toMatchObject({
      mode: "quick",
      reasoning: "low",
    });

    expect(resolveAutoConversationMode({ message: "fix this bug and commit" })).toMatchObject({
      mode: "build",
      reasoning: "medium",
    });
  });

  test("resolves Telegram ingress with the shared auto mode", () => {
    expect(resolveIngressConversationMode({
      channel: "telegram",
      message: "BDO cooking boxes worth doing?",
    })).toMatchObject({
      mode: "quick",
      reasoning: "low",
    });

    expect(resolveIngressConversationMode({
      channel: "telegram",
      message: "fix this bug and commit",
    })).toMatchObject({
      mode: "build",
      reasoning: "medium",
    });
  });

  test("forces public Discord viewer ingress to quick mode", () => {
    expect(resolveIngressConversationMode({
      channel: "discord",
      senderRole: "viewer",
      message: "fix the repo and commit it",
    })).toMatchObject({
      mode: "quick",
      reasoning: "low",
      reason: "public Discord viewer",
    });
  });

  test("skips auto mode for internal system ingress", () => {
    expect(resolveIngressConversationMode({
      channel: "scheduler",
      message: "build the daily briefing",
    })).toBeNull();
  });

  test("derives Telegram model tier from the shared mode decision", () => {
    expect(chooseTelegramModelTier("good morning")).toMatchObject({
      tier: "min",
      mode: "quick",
    });

    expect(chooseTelegramModelTier("Summarize yesterday's decisions from NyxAI and turn them into a short morning brief.")).toMatchObject({
      tier: "default",
      mode: "task",
    });

    expect(chooseTelegramModelTier("fix this bug and commit")).toMatchObject({
      tier: "max",
      mode: "build",
    });
  });
});
