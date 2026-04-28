import { describe, expect, it } from "bun:test";
import { chooseTelegramModelTier } from "../channels/telegram-model-routing.js";

describe("chooseTelegramModelTier", () => {
  it("routes short conversational messages to min tier", () => {
    expect(chooseTelegramModelTier("good morning").tier).toBe("min");
    expect(chooseTelegramModelTier("Need anything from me before lunch?").tier).toBe("min");
  });

  it("keeps standard operational requests on default tier", () => {
    expect(chooseTelegramModelTier("Summarize yesterday's decisions from NyxAI and turn them into a short morning brief.").tier).toBe("default");
  });

  it("routes complex cross-instance requests to max tier", () => {
    const message = "Analyze fleet costs across all instances, compare current burn to last week, and give me a cross-instance plan with the biggest savings opportunities.";
    expect(chooseTelegramModelTier(message).tier).toBe("max");
  });

  it("routes long multi-line requests to max tier", () => {
    const message = [
      "I need a full plan.",
      "Check NyxAI, NyxLabs, and Aether.",
      "Look at costs, error rates, and scheduled jobs.",
      "Summarize what changed.",
      "Flag the top risks.",
      "Recommend the next actions.",
      "Keep it operational.",
      "Then tell me where to start.",
    ].join("\n");
    expect(chooseTelegramModelTier(message).tier).toBe("max");
  });
});
