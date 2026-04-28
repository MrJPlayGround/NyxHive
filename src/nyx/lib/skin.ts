/**
 * nyx CLI skin engine.
 * Drives spinner personality, colors, and display labels.
 */
import pc from "picocolors";
import { renderToolInput, toolSensitivity, type ToolSensitivity } from "../tools/registry.js";

export interface Skin {
  name: string;
  agentLabel: string;
  thinkingVerbs: string[];
  doneVerb: string;
  doneFrame: string;
  toolPrefix: string;
  spinnerFrames: string[];
}

// ─── Default spinner frames — ping-pong, Ghostty-aware ────────────────────────

const isGhostty = process.env.TERM === "xterm-ghostty";

const _defaultBase = isGhostty
  ? ["·", "✢", "✳", "✶", "✻", "*"]
  : ["·", "✢", "✳", "✶", "✻", "✽"];

// Play forward then reverse interior (skip endpoints to avoid stutter at turns)
const defaultSpinnerFrames = [
  ..._defaultBase,
  ..._defaultBase.slice(1, -1).reverse(),
];

// ─── Built-in skins ───────────────────────────────────────────────────────────

const SKINS: Record<string, Skin> = {
  // Clean modern default — lead control plane styling
  default: {
    name: "default",
    agentLabel: "nyx",
    thinkingVerbs: ["thinking", "reading", "working", "checking", "analyzing"],
    doneVerb: "done",
    doneFrame: "◆",
    toolPrefix: "↳",
    spinnerFrames: defaultSpinnerFrames,
  },
  // Ghost — ultra-minimal, nearly invisible UI chrome
  ghost: {
    name: "ghost",
    agentLabel: "nyx",
    thinkingVerbs: [""],
    doneVerb: "",
    doneFrame: "·",
    toolPrefix: "·",
    spinnerFrames: ["⠁", "⠈", "⠐", "⠠", "⢀", "⡀", "⠄", "⠂"],
  },
  // Aether — compass-rose spinner, data/analysis vibe
  aether: {
    name: "aether",
    agentLabel: "aether",
    thinkingVerbs: ["scanning", "analyzing", "computing", "reading", "loading"],
    doneVerb: "complete",
    doneFrame: "◉",
    toolPrefix: "⟶",
    spinnerFrames: ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"],
  },
  // Nyx — for coding sessions with the Nyx agent
  nyx: {
    name: "nyx",
    agentLabel: "nyx",
    thinkingVerbs: ["building", "coding", "reading", "patching", "testing"],
    doneVerb: "shipped",
    doneFrame: "⚡",
    toolPrefix: "→",
    spinnerFrames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  },
  // Kawaii — chaotic good
  kawaii: {
    name: "kawaii",
    agentLabel: "nyx",
    thinkingVerbs: ["pondering...", "contemplating...", "in the zone...", "deep thoughts...", "hmm..."],
    doneVerb: "got it!",
    doneFrame: "✧٩(ˊᗜˋ*)و✧",
    toolPrefix: "▏",
    spinnerFrames: ["(｡•́︿•̀｡)", "(˘ᵕ˘)", "(•̀ᴗ•́)و", "(◕ᴗ◕✿)", "(¬‿¬)", "(⊙_⊙)"],
  },
  // Mono — plain ASCII, max compat
  mono: {
    name: "mono",
    agentLabel: "agent",
    thinkingVerbs: ["working", "running", "processing", "computing", "loading"],
    doneVerb: "done",
    doneFrame: "*",
    toolPrefix: ">",
    spinnerFrames: ["-", "\\", "|", "/"],
  },
};

// ─── Active skin ──────────────────────────────────────────────────────────────

let activeSkin: Skin = SKINS.default!;

export function setSkin(name: string): boolean {
  const s = SKINS[name.toLowerCase()];
  if (!s) return false;
  activeSkin = s;
  return true;
}

export function getSkin(): Skin { return activeSkin; }
export function listSkins(): string[] { return Object.keys(SKINS); }

// ─── Spinner with personality ─────────────────────────────────────────────────

// Cyan RGB (matches ANSI 36m in most terminals)
const CYAN_RGB = { r: 0, g: 212, b: 212 };
// Amber for stalled indicator
const AMBER_RGB = { r: 232, g: 168, b: 56 };

export class NyxSpinner {
  private frame = 0;
  private verbIdx = 0;
  private iv: ReturnType<typeof setInterval> | null = null;
  private currentVerb = "";
  private startedAt = 0;
  private lastActivityAt = 0;
  private glimmerPos = 0;
  private useCustom = false;
  private stopped = false; // guard: prevents stale queued callbacks from writing

  private nextVerb(): string {
    const verbs = activeSkin.thinkingVerbs;
    const v = verbs[this.verbIdx % verbs.length]!;
    return v;
  }

  /** Reset stalled timer — call on each incoming response token */
  notifyToken() {
    this.lastActivityAt = Date.now();
  }

  start(text?: string) {
    this.stopped = false;
    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.frame = 0;
    this.verbIdx = 0;
    this.glimmerPos = 0;
    const maxLen = Math.max(20, (process.stdout.columns || 80) - 20);
    const safeText = text ? text.replace(/[\r\n]+/g, " ").trim().slice(0, maxLen) : undefined;
    this.currentVerb = safeText ?? this.nextVerb();
    this.useCustom = !!safeText;

    this.iv = setInterval(() => {
      if (this.stopped) return;
      const now = Date.now();
      const elapsed = ((now - this.startedAt) / 1000).toFixed(1);
      const frames = activeSkin.spinnerFrames;
      const f = frames[this.frame % frames.length]!;

      // Rotate thinking verbs every ~3 seconds (37 frames * 80ms ≈ 3s)
      if (!this.useCustom && this.frame > 0 && this.frame % 37 === 0) {
        this.verbIdx++;
        this.currentVerb = this.nextVerb();
        this.glimmerPos = 0;
      }

      // Glimmer sweep: bright spot slides left→right across the verb text
      let verbPart = "";
      if (this.currentVerb) {
        const chars = [...this.currentVerb];
        const len = chars.length;
        // pad so the bright spot "enters" and "exits" cleanly
        const sweepLen = len + 4;
        const pos = (this.glimmerPos % sweepLen) - 2;
        const glimmered = chars.map((ch, i) => {
          const dist = Math.abs(i - pos);
          if (dist === 0) return pc.bold(pc.white(ch));
          if (dist === 1) return pc.white(ch);
          return pc.dim(ch);
        }).join("");
        verbPart = " " + glimmered;
        this.glimmerPos++;
      }

      // Stalled indicator: interpolate frame color from cyan → amber after 10s idle
      const stallMs = now - this.lastActivityAt;
      let frameStr: string;
      if (stallMs > 10_000) {
        const t = Math.min((stallMs - 10_000) / 10_000, 1);
        const r = Math.round(CYAN_RGB.r + (AMBER_RGB.r - CYAN_RGB.r) * t);
        const g = Math.round(CYAN_RGB.g + (AMBER_RGB.g - CYAN_RGB.g) * t);
        const b = Math.round(CYAN_RGB.b + (AMBER_RGB.b - CYAN_RGB.b) * t);
        frameStr = `\x1b[38;2;${r};${g};${b}m${f}\x1b[39m`;
      } else {
        frameStr = pc.cyan(f);
      }

      const line = `\r${frameStr}${verbPart} ${pc.dim("(" + elapsed + "s)")}\x1b[K`;
      process.stdout.write(line);
      this.frame++;
    }, 80);
  }

  update(text: string) {
    // Keep total line width under terminal columns to avoid wrap (frame=2, elapsed≈10, padding=3)
    const maxLen = Math.max(20, (process.stdout.columns || 80) - 20);
    this.currentVerb = text.replace(/[\r\n]+/g, " ").trim().slice(0, maxLen);
    this.useCustom = true;
    this.lastActivityAt = Date.now();
    this.glimmerPos = 0;
  }

  stop(success = true) {
    this.stopped = true;
    if (this.iv) { clearInterval(this.iv); this.iv = null; }
    process.stdout.write("\r\x1b[K");
    if (success) {
      const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
      const verb = activeSkin.doneVerb ? ` ${pc.dim(activeSkin.doneVerb)}` : "";
      const time = pc.dim(` (${elapsed}s)`);
      process.stdout.write(`${pc.green(activeSkin.doneFrame)}${verb}${time}\n`);
    }
  }

  clear() {
    this.stopped = true;
    if (this.iv) { clearInterval(this.iv); this.iv = null; }
    process.stdout.write("\r\x1b[K");
  }
}

// ─── Status bar ───────────────────────────────────────────────────────────────

export interface StatusBarData {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  contextPct?: number;
  costCents?: number;
  elapsedMs?: number;
}

export function renderStatusBar(data: StatusBarData): string {
  const w = process.stdout.columns || 80;

  const model = data.model ? pc.dim(data.model.split("/").pop() ?? data.model) : "";
  const tokens = (data.tokensIn != null && data.tokensOut != null)
    ? pc.dim(`${(data.tokensIn / 1000).toFixed(0)}k↑ ${(data.tokensOut / 1000).toFixed(1)}k↓`)
    : "";
  const ctx = data.contextPct != null ? pc.dim(`ctx ${data.contextPct.toFixed(0)}%`) : "";
  const cost = data.costCents != null && data.costCents > 0
    ? pc.yellow(`$${(data.costCents / 100).toFixed(4)}`)
    : "";
  const elapsed = data.elapsedMs != null
    ? pc.dim(`${(data.elapsedMs / 1000).toFixed(1)}s`)
    : "";

  const mark = pc.dim("◆");
  const sep = pc.dim("  ·  ");

  // Responsive layouts
  if (w >= 76) {
    const parts = [model, tokens, ctx, cost, elapsed].filter(Boolean);
    if (!parts.length) return "";
    return `  ${mark}  ` + parts.join(sep);
  } else if (w >= 52) {
    const parts = [model, cost, elapsed].filter(Boolean);
    if (!parts.length) return "";
    return `  ${mark}  ` + parts.join(sep);
  } else {
    return model ? `  ${mark}  ${model}` : "";
  }
}

// ─── Tool call display ────────────────────────────────────────────────────────

export type VerbosityLevel = "off" | "new" | "all" | "verbose";

let verbosity: VerbosityLevel = "new";
export function setVerbosity(v: VerbosityLevel) { verbosity = v; }
export function getVerbosity() { return verbosity; }
export function cycleVerbosity(): VerbosityLevel {
  const cycle: VerbosityLevel[] = ["off", "new", "all", "verbose"];
  verbosity = cycle[(cycle.indexOf(verbosity) + 1) % cycle.length]!;
  return verbosity;
}

export function renderToolCall(tool: string, input: unknown): string {
  if (verbosity === "off") return "";
  const sensitivity = toolSensitivity(tool);
  // Low-sensitivity tools (reads, searches) hidden at "new" verbosity level
  if (verbosity === "new" && sensitivity === "low") return "";
  const inputStr = renderToolInput(tool, input);
  // Color-code by sensitivity: high=red, medium=yellow, low=dim
  const toolColor = sensitivity === "high"
    ? pc.red(tool)
    : sensitivity === "medium"
      ? pc.yellow(tool)
      : pc.cyan(tool);
  return `  ${pc.dim("┊")} ${toolColor}  ${pc.dim(inputStr)}`;
}

/** Expose sensitivity for external use (e.g. approval gate) */
export { toolSensitivity, type ToolSensitivity };
