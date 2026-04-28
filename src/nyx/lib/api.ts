/**
 * HTTP client for NyxHive instance APIs.
 */
import type { InstanceConfig } from "./config.js";

export interface ApiOpts {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  timeout?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

export async function api<T = unknown>(
  instance: InstanceConfig,
  path: string,
  opts: ApiOpts = {},
): Promise<T> {
  const base = instance.host ?? `http://localhost:${instance.port}`;
  const url = `${base}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (instance.apiKey) {
    headers["Authorization"] = `Bearer ${instance.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = opts.timeout ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Check if an instance is reachable. */
export async function ping(instance: InstanceConfig): Promise<boolean> {
  try {
    await api(instance, "/api/queue/health", { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
