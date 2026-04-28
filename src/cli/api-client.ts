import type { NyxHiveConfig } from "../types.js";

export function resolveServerApiKey(config: Pick<NyxHiveConfig, "server">): string | undefined {
  if (config.server.api_key) {
    return config.server.api_key;
  }

  const envName = config.server.api_key_env?.trim();
  if (!envName) {
    return undefined;
  }

  const envValue = process.env[envName]?.trim();
  if (!envValue) {
    throw new Error(
      `server.api_key_env=${envName} is configured but ${envName} is not set. Set it, restart the instance, then retry this command.`,
    );
  }

  return envValue;
}

export function formatApiError(status: number, statusText: string, bodyText: string): string {
  const trimmed = bodyText.trim();
  let detail = trimmed;

  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        detail = parsed.error.trim();
      } else if (typeof parsed.message === "string" && parsed.message.trim()) {
        detail = parsed.message.trim();
      }
    } catch {
      detail = trimmed;
    }
  }

  if (!detail) {
    detail = statusText || "Unknown error";
  }

  return `API error: ${status} ${detail}`;
}

export async function apiFetch(base: string, path: string, apiKey?: string, opts?: RequestInit) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts?.headers as Record<string, string> ?? {}),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${base}${path}`, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiError(res.status, res.statusText, text));
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error("Server returned unexpected response. Is the NyxHive server up to date? Try restarting it.");
  }

  return res.json();
}
