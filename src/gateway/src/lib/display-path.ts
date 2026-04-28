/**
 * Normalize file paths for display without leaking absolute filesystem layout.
 * Browser-compatible (no Node path module).
 */

const ROOT_SEGMENTS = new Set([
  "src",
  "lib",
  "test",
  "tests",
  "docs",
  "config",
  "scripts",
  "plans",
  "souls",
  "templates",
  "app",
  "apps",
  "packages",
  "gateway",
  "protocol",
  "memory",
]);

function normalizePath(filePath: string): { normalized: string; absolute: boolean } {
  const trimmed = filePath.trim().replace(/\\/g, "/");
  const tildeExpanded = trimmed.startsWith("~/") ? trimmed.slice(2) : trimmed;
  const withoutDrive = tildeExpanded.replace(/^[A-Za-z]:\//, "/");
  const absolute = withoutDrive.startsWith("/");
  return { normalized: withoutDrive, absolute };
}

export function toDisplayPathSegments(filePath: string): string[] {
  if (!filePath) return [];

  const { normalized, absolute } = normalizePath(filePath);
  const originalSegments = normalized.split("/").filter(Boolean);
  if (originalSegments.length === 0) return [];

  const safeSegments = originalSegments.filter((segment) => segment !== "." && segment !== "..");
  const rootIndex = safeSegments.findIndex((segment) => ROOT_SEGMENTS.has(segment));

  if (rootIndex !== -1) {
    return safeSegments.slice(rootIndex);
  }

  if (absolute && safeSegments.length > 2) {
    return safeSegments.slice(-2);
  }

  return safeSegments;
}

export function toDisplayPath(filePath: string): string {
  const segments = toDisplayPathSegments(filePath);
  if (segments.length === 0) return filePath;
  return segments.join("/");
}
