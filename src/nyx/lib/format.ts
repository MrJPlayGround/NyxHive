/**
 * Terminal formatting utilities.
 */
import pc from "picocolors";

/** Pad or truncate a string to exact width. */
export function col(text: string, width: number): string {
  if (text.length > width) return text.slice(0, width - 1) + "…";
  return text.padEnd(width);
}

/** Draw a horizontal rule. */
export function hr(width: number): string {
  return "─".repeat(width);
}

/** Format a table with headers and rows. */
export function table(
  headers: { label: string; width: number }[],
  rows: string[][],
  opts?: { indent?: number },
): string {
  const indent = " ".repeat(opts?.indent ?? 2);
  const totalWidth = headers.reduce((sum, h) => sum + h.width, 0) + (headers.length - 1) * 2;

  const lines: string[] = [];
  const headerLine = headers.map((h) => pc.bold(col(h.label, h.width))).join("  ");
  lines.push(`${indent}${headerLine}`);
  lines.push(`${indent}${hr(totalWidth)}`);

  for (const row of rows) {
    const rowLine = headers.map((h, i) => col(row[i] ?? "", h.width)).join("  ");
    lines.push(`${indent}${rowLine}`);
  }

  return lines.join("\n");
}

/** Format duration from ms to human-readable. */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mRem = m % 60;
  return mRem > 0 ? `${h}h ${mRem}m` : `${h}h`;
}

/** Format cost in USD. */
export function cost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  return `$${usd.toFixed(2)}`;
}

/** Status indicator with color. */
export function statusDot(status: "running" | "down" | "unknown"): string {
  switch (status) {
    case "running":
      return pc.green("●");
    case "down":
      return pc.red("✕");
    case "unknown":
      return pc.yellow("?");
  }
}

/** Format a timestamp to HH:MM. */
export function time(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}
