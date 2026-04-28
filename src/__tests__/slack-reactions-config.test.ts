import { describe, it, expect } from "bun:test";
import { resolveReactions } from "../channels/slack/identity.js";

describe("resolveReactions", () => {
  it("returns defaults when no config", () => {
    const r = resolveReactions(undefined);
    expect(r.ack).toBe("eyes");
    expect(r.done).toBe("white_check_mark");
    expect(r.error).toBe("x");
    expect(r.typing).toBeUndefined();
  });
  it("overrides configured reactions", () => {
    const r = resolveReactions({ ack_reaction: "hourglass", done_reaction: "sparkles" });
    expect(r.ack).toBe("hourglass");
    expect(r.done).toBe("sparkles");
    expect(r.error).toBe("x");
  });
  it("strips colons from emoji names", () => {
    expect(resolveReactions({ ack_reaction: ":brain:" }).ack).toBe("brain");
  });
});
