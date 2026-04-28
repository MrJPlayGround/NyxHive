import { readFileSync } from "node:fs";
import { sign, createPrivateKey } from "node:crypto";
import { logger } from "./logger.js";

export interface APNsConfig {
  keyId: string;
  teamId: string;
  keyPath: string;
  bundleId: string;
  production: boolean;
}

export interface APNsPayload {
  alert: { title: string; body: string };
  sound?: string;
  badge?: number;
  data?: Record<string, unknown>;
}

let cachedToken: { token: string; expires: number } | null = null;

async function getToken(config: APNsConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires) {
    return cachedToken.token;
  }

  const keyPem = readFileSync(config.keyPath, "utf8");

  const header = { alg: "ES256", kid: config.keyId };
  const payload = { iss: config.teamId, iat: Math.floor(Date.now() / 1000) };

  const b64url = (data: string) => Buffer.from(data).toString("base64url");
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = createPrivateKey(keyPem);
  const signature = sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });

  const token = `${signingInput}.${signature.toString("base64url")}`;
  // APNs tokens are valid for 60 minutes; refresh at 55 min
  cachedToken = { token, expires: Date.now() + 55 * 60 * 1000 };
  return token;
}

export async function sendAPNs(
  deviceToken: string,
  payload: APNsPayload,
  config: APNsConfig,
): Promise<boolean> {
  const host = config.production
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";

  const apnsPayload = {
    aps: {
      alert: payload.alert,
      sound: payload.sound || "default",
      ...(payload.badge !== undefined && { badge: payload.badge }),
    },
    ...(payload.data || {}),
  };

  try {
    const token = await getToken(config);
    const response = await fetch(`${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      body: JSON.stringify(apnsPayload),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[APNs] Push failed (${response.status}): ${text}`);
    }
    return response.ok;
  } catch (err) {
    logger.error(`[APNs] Send failed: ${err}`);
    return false;
  }
}
