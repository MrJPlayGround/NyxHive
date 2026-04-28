const LARGE_BODY_LIMIT_PATHS = new Set([
  "/api/message",
  "/api/relay/callback",
]);

const SESSION_MESSAGE_PATH = /^\/api\/sessions\/[^/]+\/message$/;

export function usesLargeMessageBodyLimit(path: string): boolean {
  return LARGE_BODY_LIMIT_PATHS.has(path) || SESSION_MESSAGE_PATH.test(path);
}
