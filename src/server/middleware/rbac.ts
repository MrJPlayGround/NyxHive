import type { Context, Next } from "hono";
import type { AuthContext, UserRole } from "../../auth/types.js";

/**
 * Middleware that requires the authenticated user to have one of the specified roles.
 * API key auth always gets owner-level access.
 */
export function requireRole(...roles: UserRole[]) {
  return async (c: Context, next: Next) => {
    const auth = c.get("auth") as AuthContext | undefined;
    if (!auth) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    if (!roles.includes(auth.role)) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    return next();
  };
}

/** Owner or admin */
export const adminOnly = requireRole("owner", "admin");

/** Can send messages */
export const canWrite = requireRole("owner", "admin", "user");

/** Can read (everyone) */
export const canRead = requireRole("owner", "admin", "user", "viewer");
