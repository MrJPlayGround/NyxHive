const LOCALHOST_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

export function validateOutboundHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `Invalid URL: ${raw}`;
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return `Unsupported URL scheme "${scheme.replace(":", "")}". Only http and https are allowed.`;
  }

  if (parsed.username || parsed.password) {
    return "URLs with embedded credentials are not allowed.";
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedHost(hostname)) {
    return `Blocked destination: ${hostname}. Localhost and private network destinations are not allowed.`;
  }

  return null;
}

function isBlockedHost(hostname: string): boolean {
  if (!hostname || LOCALHOST_NAMES.has(hostname)) return true;

  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (bare.includes(":")) return true;

  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet, index) => !Number.isFinite(octet) || String(octet) !== parts[index] || octet < 0 || octet > 255)) {
    return false;
  }

  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;

  return false;
}
