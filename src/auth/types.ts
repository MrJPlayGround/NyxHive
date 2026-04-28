export type UserRole = "owner" | "admin" | "user" | "viewer";

export interface User {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  is_active: number; // SQLite boolean
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export interface Invite {
  code: string;
  created_by: string;
  role: UserRole;
  max_uses: number;
  use_count: number;
  expires_at: string | null;
  created_at: string;
}

/** Safe user representation (no password_hash) */
export type SafeUser = Omit<User, "password_hash">;

export interface AuthContext {
  type: "api_key" | "session";
  role: UserRole;
  user?: SafeUser;
}

/** Hono env type for routes that access auth context */
export type AuthEnv = { Variables: { auth: AuthContext } };
