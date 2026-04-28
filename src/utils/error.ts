/**
 * Format an unknown error value to a human-readable string.
 * Handles Error instances, strings, and other values consistently.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
