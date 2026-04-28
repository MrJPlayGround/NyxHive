/**
 * Path display utilities for user-facing surfaces.
 *
 * Rule: never show absolute filesystem paths in Slack, gateway, or any
 * user-facing summary. Strip to project-relative paths (e.g. `src/channels/slack.ts`).
 */

/**
 * Strip an absolute path down to its project-relative form.
 *
 * - If `projectRoot` is provided, strips that prefix.
 * - Otherwise uses heuristic: finds the last segment that looks like a
 *   project boundary (`src/`, `lib/`, `test/`, `docs/`, `config/`, etc.)
 *   and keeps from the parent of that segment onward.
 * - Falls back to basename-only if nothing matches.
 */
export function toRelativePath(filePath: string, projectRoot?: string): string {
  if (!filePath) return filePath;

  // Fast path: already relative
  if (!filePath.startsWith("/")) return filePath;

  // Explicit project root
  if (projectRoot) {
    const root = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
    if (filePath.startsWith(root)) {
      return filePath.slice(root.length);
    }
  }

  // Heuristic: find the first known project boundary segment (leftmost wins
  // so that e.g. /project/src/lib/utils.ts resolves to src/lib/utils.ts)
  const markers = ["/src/", "/lib/", "/test/", "/tests/", "/docs/", "/config/", "/scripts/", "/plans/", "/souls/", "/templates/"];
  let firstIdx = Number.MAX_SAFE_INTEGER;
  for (const marker of markers) {
    const idx = filePath.indexOf(marker);
    if (idx !== -1 && idx < firstIdx) {
      firstIdx = idx;
    }
  }
  if (firstIdx < Number.MAX_SAFE_INTEGER) {
    return filePath.slice(firstIdx + 1); // +1 to drop the leading /
  }

  // Fallback: keep the shortest meaningful tail rather than exposing the
  // absolute prefix or collapsing to an ambiguous basename when avoidable.
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join("/");
  }
  return parts[0] ?? filePath;
}

/**
 * Strip absolute paths from a batch of file paths.
 */
export function toRelativePaths(paths: string[], projectRoot?: string): string[] {
  return paths.map((p) => toRelativePath(p, projectRoot));
}

/**
 * Strip any embedded absolute paths from a free-text string.
 * Replaces occurrences of `/Users/.../<boundary>/rest` or `/home/.../<boundary>/rest`
 * with just the relative tail.
 */
export function stripAbsolutePaths(text: string): string {
  // Match absolute paths like /Users/foo/bar/src/thing.ts or /home/user/project/lib/x.ts
  return text.replace(
    /(?:\/(?:Users|home|var|tmp|opt|root)\/[^\s:,`"']+)/g,
    (match) => toRelativePath(match),
  );
}
