import { Hono } from "hono";
import type { AuthStore } from "../../auth/store.js";
import type { AuthEnv, UserRole } from "../../auth/types.js";
import { rateLimiter } from "../middleware/rate-limit.js";

export function authRoutes(authStore: AuthStore): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Stricter rate limit for auth endpoints: 10 requests/minute per IP (brute force protection)
  const authRateLimit = rateLimiter({ maxRequests: 10, windowMs: 60_000 });
  app.use("/register", authRateLimit);
  app.use("/login", authRateLimit);

  // POST /register - Create account
  // First user becomes owner. Subsequent users need invite code.
  app.post("/register", async (c) => {
    const body = await c.req.json<{
      email: string;
      display_name: string;
      password: string;
      invite_code?: string;
    }>();

    if (!body.email || !body.display_name || !body.password) {
      return c.json({ error: "email, display_name, and password are required" }, 400);
    }
    if (body.password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    // Check if email taken
    if (authStore.getUserByEmail(body.email)) {
      return c.json({ error: "Email already registered" }, 409);
    }

    const userCount = authStore.getUserCount();
    let role: UserRole = "user";

    if (userCount === 0) {
      // First user is always owner
      role = "owner";
    } else {
      // Subsequent users need invite
      if (!body.invite_code) {
        return c.json({ error: "Invite code required" }, 403);
      }
      const invite = authStore.validateInvite(body.invite_code);
      if (!invite) {
        return c.json({ error: "Invalid or expired invite code" }, 403);
      }
      role = invite.role;
      authStore.consumeInvite(body.invite_code);
    }

    const user = await authStore.createUser(body.email, body.display_name, body.password, role);
    const result = await authStore.authenticate(body.email, body.password, {
      ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip"),
      userAgent: c.req.header("user-agent"),
    });

    return c.json({
      user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
      session_token: result!.session.id,
      expires_at: result!.session.expires_at,
    }, 201);
  });

  // POST /login
  app.post("/login", async (c) => {
    const body = await c.req.json<{ email: string; password: string }>();
    if (!body.email || !body.password) {
      return c.json({ error: "email and password are required" }, 400);
    }

    const result = await authStore.authenticate(body.email, body.password, {
      ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip"),
      userAgent: c.req.header("user-agent"),
    });

    if (!result) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    return c.json({
      user: { id: result.user.id, email: result.user.email, display_name: result.user.display_name, role: result.user.role },
      session_token: result.session.id,
      expires_at: result.session.expires_at,
    });
  });

  // POST /logout - requires session auth
  app.post("/logout", (c) => {
    const auth = c.get("auth");
    if (!auth || auth.type !== "session") {
      return c.json({ error: "Session authentication required" }, 401);
    }

    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (token) authStore.revokeSession(token);
    return c.json({ ok: true });
  });

  // GET /me - current user info
  app.get("/me", (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "Not authenticated" }, 401);

    if (auth.type === "api_key") {
      return c.json({ type: "api_key", role: "owner" });
    }

    const user = auth.user!;
    return c.json({
      user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
    });
  });

  // PUT /password - change password (requires session auth)
  app.put("/password", async (c) => {
    const auth = c.get("auth");
    if (!auth || auth.type !== "session" || !auth.user) {
      return c.json({ error: "Session authentication required" }, 401);
    }

    const body = await c.req.json<{ old_password: string; new_password: string }>();
    if (!body.old_password || !body.new_password) {
      return c.json({ error: "old_password and new_password are required" }, 400);
    }
    if (body.new_password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    const sessionToken = c.req.header("Authorization")?.replace("Bearer ", "");
    const ok = await authStore.changePassword(auth.user.id, body.old_password, body.new_password, sessionToken);
    if (!ok) {
      return c.json({ error: "Current password is incorrect" }, 401);
    }

    return c.json({ ok: true });
  });

  // GET /status - public endpoint, tells clients if auth is enabled
  app.get("/status", (c) => {
    return c.json({ auth_enabled: true, has_users: authStore.getUserCount() > 0 });
  });

  return app;
}

export function userAdminRoutes(authStore: AuthStore): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // GET / - list all users
  app.get("/", (c) => {
    const users = authStore.listUsers();
    return c.json(users.map((u) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      role: u.role,
      is_active: u.is_active,
      created_at: u.created_at,
      last_login_at: u.last_login_at,
    })));
  });

  // POST /invite - generate invite code
  app.post("/invite", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json<{ role?: UserRole; max_uses?: number; expires_in_hours?: number }>();

    const role = body.role ?? "user";
    // Only owner can create admin invites
    if (role === "admin" && auth.role !== "owner") {
      return c.json({ error: "Only owner can create admin invites" }, 403);
    }
    if (role === "owner") {
      return c.json({ error: "Cannot create owner invites" }, 400);
    }

    const creatorId = auth.type === "session" ? auth.user!.id : "api_key";
    const invite = authStore.createInvite(creatorId, role, {
      maxUses: body.max_uses,
      expiresInHours: body.expires_in_hours,
    });

    return c.json(invite, 201);
  });

  // GET /invites - list all invites
  app.get("/invites", (c) => {
    return c.json(authStore.listInvites());
  });

  // DELETE /invites/:code - delete invite
  app.delete("/invites/:code", (c) => {
    const ok = authStore.deleteInvite(c.req.param("code"));
    if (!ok) return c.json({ error: "Invite not found" }, 404);
    return c.json({ ok: true });
  });

  // PUT /:id - update user role/status
  app.put("/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const body = await c.req.json<{ role?: UserRole; display_name?: string; is_active?: number }>();

    const target = authStore.getUserById(id);
    if (!target) return c.json({ error: "User not found" }, 404);

    // Cannot modify owner (unless you are the owner modifying yourself)
    if (target.role === "owner" && auth.user?.id !== target.id) {
      return c.json({ error: "Cannot modify owner" }, 403);
    }

    // Only owner can promote to admin
    if (body.role === "admin" && auth.role !== "owner") {
      return c.json({ error: "Only owner can promote to admin" }, 403);
    }

    // Cannot set role to owner
    if (body.role === "owner") {
      return c.json({ error: "Cannot assign owner role" }, 400);
    }

    const updated = authStore.updateUser(id, body);
    return c.json(updated);
  });

  // DELETE /:id - delete user
  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const target = authStore.getUserById(id);
    if (!target) return c.json({ error: "User not found" }, 404);
    if (target.role === "owner") return c.json({ error: "Cannot delete owner" }, 403);

    authStore.revokeAllSessions(id);
    authStore.deleteUser(id);
    return c.json({ ok: true });
  });

  // POST /:id/reset-password - admin reset password
  app.post("/:id/reset-password", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ new_password: string }>();
    if (!body.new_password || body.new_password.length < 8) {
      return c.json({ error: "new_password must be at least 8 characters" }, 400);
    }

    const target = authStore.getUserById(id);
    if (!target) return c.json({ error: "User not found" }, 404);

    await authStore.resetPassword(id, body.new_password);
    return c.json({ ok: true });
  });

  return app;
}
