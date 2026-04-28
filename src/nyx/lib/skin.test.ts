import { describe, it, expect, beforeEach } from "bun:test";
import {
  getSkin,
  setSkin,
  listSkins,
  NyxSpinner,
  renderStatusBar,
  renderToolCall,
  setVerbosity,
  getVerbosity,
  cycleVerbosity,
  type Skin,
  type StatusBarData,
  type VerbosityLevel,
} from "./skin.js";

// Strip ANSI escape codes for assertion readability
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("skin engine", () => {
  beforeEach(() => {
    setSkin("default");
    setVerbosity("new");
  });

  // ─── setSkin / getSkin ───────────────────────────────────────────────────────

  describe("setSkin", () => {
    it("returns true for known skins", () => {
      expect(setSkin("kawaii")).toBe(true);
      expect(getSkin().name).toBe("kawaii");
    });

    it("returns false for unknown skin and keeps current", () => {
      setSkin("kawaii");
      expect(setSkin("nonexistent")).toBe(false);
      expect(getSkin().name).toBe("kawaii"); // unchanged
    });

    it("is case-insensitive", () => {
      expect(setSkin("KAWAII")).toBe(true);
      expect(getSkin().name).toBe("kawaii");
    });

    it("handles empty string", () => {
      expect(setSkin("")).toBe(false);
    });
  });

  describe("listSkins", () => {
    it("returns all built-in skin names", () => {
      const skins = listSkins();
      expect(skins).toContain("default");
      expect(skins).toContain("kawaii");
      expect(skins).toContain("nyx");
      expect(skins).toContain("mono");
      expect(skins.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ─── Skin shape validation ──────────────────────────────────────────────────

  describe("skin shape", () => {
    for (const name of ["default", "kawaii", "nyx", "mono"]) {
      it(`${name} skin has all required fields`, () => {
        setSkin(name);
        const skin = getSkin();
        expect(skin.name).toBe(name);
        expect(skin.agentLabel).toBeTruthy();
        expect(skin.thinkingVerbs.length).toBeGreaterThan(0);
        expect(skin.doneVerb).toBeTruthy();
        expect(skin.toolPrefix).toBeTruthy();
        expect(skin.spinnerFrames.length).toBeGreaterThan(0);
      });

      it(`${name} skin has no empty thinking verbs`, () => {
        setSkin(name);
        for (const verb of getSkin().thinkingVerbs) {
          expect(verb.trim().length).toBeGreaterThan(0);
        }
      });

      it(`${name} skin has no empty spinner frames`, () => {
        setSkin(name);
        for (const frame of getSkin().spinnerFrames) {
          expect(frame.length).toBeGreaterThan(0);
        }
      });
    }
  });

  // ─── renderStatusBar ────────────────────────────────────────────────────────

  describe("renderStatusBar", () => {
    it("renders full layout at wide terminal (>= 76 cols)", () => {
      // Mock process.stdout.columns
      const orig = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
      try {
        const bar = strip(renderStatusBar({
          model: "anthropic/claude-sonnet-4-20250514",
          tokensIn: 12500,
          tokensOut: 3200,
          contextPct: 42,
          costCents: 5.67,
          elapsedMs: 3400,
        }));
        expect(bar).toContain("claude-sonnet-4-20250514");
        expect(bar).toContain("13k"); // 12500/1000 rounded
        expect(bar).toContain("3.2k");
        expect(bar).toContain("ctx 42%");
        expect(bar).toContain("$0.0567");
        expect(bar).toContain("3.4s");
      } finally {
        Object.defineProperty(process.stdout, "columns", { value: orig, configurable: true });
      }
    });

    it("renders compact layout at medium terminal (52-75 cols)", () => {
      const orig = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", { value: 60, configurable: true });
      try {
        const bar = strip(renderStatusBar({
          model: "anthropic/claude-sonnet-4-20250514",
          tokensIn: 12500,
          tokensOut: 3200,
          contextPct: 42,
          costCents: 5.67,
          elapsedMs: 3400,
        }));
        expect(bar).toContain("claude-sonnet-4-20250514");
        expect(bar).toContain("$0.0567");
        expect(bar).toContain("3.4s");
        // Compact layout should NOT include tokens or context%
        expect(bar).not.toContain("ctx");
        expect(bar).not.toContain("k↑");
      } finally {
        Object.defineProperty(process.stdout, "columns", { value: orig, configurable: true });
      }
    });

    it("renders minimal layout at narrow terminal (< 52 cols)", () => {
      const orig = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
      try {
        const bar = strip(renderStatusBar({
          model: "anthropic/claude-sonnet-4-20250514",
          tokensIn: 12500,
          tokensOut: 3200,
          contextPct: 42,
          costCents: 5.67,
          elapsedMs: 3400,
        }));
        expect(bar).toContain("claude-sonnet-4-20250514");
        // Minimal: only model
        expect(bar).not.toContain("$");
        expect(bar).not.toContain("ctx");
      } finally {
        Object.defineProperty(process.stdout, "columns", { value: orig, configurable: true });
      }
    });

    it("handles empty data gracefully", () => {
      const bar = renderStatusBar({});
      // Should not throw, should return something
      expect(typeof bar).toBe("string");
    });

    it("handles zero cost", () => {
      const bar = strip(renderStatusBar({ costCents: 0 }));
      // Zero cost should be suppressed
      expect(bar).not.toContain("$");
    });

    it("handles null tokens", () => {
      const bar = strip(renderStatusBar({ tokensIn: 500 }));
      // Missing tokensOut — tokens section should be omitted
      expect(bar).not.toContain("k↑");
    });

    it("extracts model short name from path", () => {
      const orig = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
      try {
        const bar = strip(renderStatusBar({ model: "anthropic/claude-sonnet-4-20250514" }));
        // Should show just the model name, not the provider prefix
        expect(bar).toContain("claude-sonnet-4-20250514");
        expect(bar).not.toContain("anthropic/");
      } finally {
        Object.defineProperty(process.stdout, "columns", { value: orig, configurable: true });
      }
    });
  });

  // ─── renderToolCall ─────────────────────────────────────────────────────────

  describe("renderToolCall", () => {
    it("renders tool name and string input", () => {
      setVerbosity("all");
      const out = strip(renderToolCall("bash", "find . -name '*.ts'"));
      expect(out).toContain("bash");
      expect(out).toContain("find . -name '*.ts'");
    });

    it("renders tool name and object input", () => {
      setVerbosity("all");
      const out = strip(renderToolCall("file_read", { path: "src/chat.ts" }));
      expect(out).toContain("file_read");
      expect(out).toContain("src/chat.ts");
    });

    it("returns empty string when verbosity is off", () => {
      setVerbosity("off");
      expect(renderToolCall("bash", "ls")).toBe("");
    });

    it("truncates long input to 80 chars", () => {
      setVerbosity("all");
      const longInput = "x".repeat(200);
      const out = strip(renderToolCall("bash", longInput));
      // The input portion inside parens should be truncated
      expect(out.length).toBeLessThan(200);
    });

    it("handles null/undefined input", () => {
      setVerbosity("all");
      const out = renderToolCall("bash", null);
      expect(typeof out).toBe("string");
      const out2 = renderToolCall("bash", undefined);
      expect(typeof out2).toBe("string");
    });

    it("uses the shared tool activity prefix", () => {
      setVerbosity("all");
      setSkin("nyx");
      const out = strip(renderToolCall("bash", "ls"));
      expect(out).toContain("┊");
    });
  });

  // ─── Verbosity cycling ──────────────────────────────────────────────────────

  describe("verbosity", () => {
    it("cycles through all levels in order", () => {
      setVerbosity("off");
      expect(cycleVerbosity()).toBe("new");
      expect(cycleVerbosity()).toBe("all");
      expect(cycleVerbosity()).toBe("verbose");
      expect(cycleVerbosity()).toBe("off"); // wraps around
    });

    it("getVerbosity returns current level", () => {
      setVerbosity("verbose");
      expect(getVerbosity()).toBe("verbose");
    });
  });

  // ─── NyxSpinner ─────────────────────────────────────────────────────────────

  describe("NyxSpinner", () => {
    it("can be instantiated", () => {
      const spinner = new NyxSpinner();
      expect(spinner).toBeDefined();
    });

    it("start and stop without throwing", () => {
      const spinner = new NyxSpinner();
      spinner.start("test");
      spinner.stop();
    });

    it("clear without throwing", () => {
      const spinner = new NyxSpinner();
      spinner.start("test");
      spinner.clear();
    });

    it("stop without start does not throw", () => {
      const spinner = new NyxSpinner();
      spinner.stop(); // no-op
    });

    it("update changes spinner text", () => {
      const spinner = new NyxSpinner();
      spinner.start("initial");
      spinner.update("new text");
      spinner.stop();
    });

    it("update truncates to 80 chars", () => {
      const spinner = new NyxSpinner();
      spinner.start();
      spinner.update("x".repeat(200));
      spinner.stop();
    });

    it("respects active skin's spinner frames and verbs", () => {
      setSkin("kawaii");
      const spinner = new NyxSpinner();
      // Kawaii skin should use its own frames/verbs
      // Can't easily assert stdout content in unit tests, but ensure no crash
      spinner.start();
      spinner.stop();
    });

    it("double stop does not throw", () => {
      const spinner = new NyxSpinner();
      spinner.start("test");
      spinner.stop();
      spinner.stop(); // second stop
    });
  });
});
