interface PostmanAuth {
  type: string;
  bearer?: Array<{ key: string; value: string }>;
  basic?: Array<{ key: string; value: string }>;
  oauth2?: Array<{ key: string; value: string }>;
  apikey?: Array<{ key: string; value: string }>;
}

interface PostmanVariable {
  key: string;
  value: string;
  description?: string;
}

interface PostmanResponse {
  name: string;
  status: string;
  code: number;
  body?: string;
}

interface PostmanItem {
  name: string;
  request?: {
    method: string;
    url: { raw: string; path?: string[] };
    header?: Array<{ key: string; value: string }>;
    body?: { mode: string; raw?: string };
    auth?: PostmanAuth;
    description?: string;
  };
  item?: PostmanItem[];
  response?: PostmanResponse[];
}

interface PostmanCollection {
  info: { name: string; description?: string };
  item: PostmanItem[];
  auth?: PostmanAuth;
  variable?: PostmanVariable[];
}

export function postmanToMarkdown(collection: PostmanCollection): string {
  const lines: string[] = [];

  lines.push(`# ${collection.info.name} API Reference`);
  lines.push("");

  if (collection.info.description) {
    lines.push(collection.info.description);
    lines.push("");
  }

  // Collection-level auth
  if (collection.auth) {
    lines.push("## Authentication");
    lines.push("");
    lines.push(formatAuth(collection.auth));
    lines.push("");
  }

  // Variables
  if (collection.variable?.length) {
    lines.push("## Variables");
    lines.push("");
    lines.push("| Key | Value |");
    lines.push("|-----|-------|");
    for (const v of collection.variable) {
      lines.push(`| ${v.key} | ${v.value || ""} |`);
    }
    lines.push("");
  }

  lines.push("## Endpoints");
  lines.push("");

  // Process items recursively
  processItems(collection.item, lines, 3);

  return lines.join("\n");
}

function processItems(items: PostmanItem[], lines: string[], depth: number): void {
  const heading = "#".repeat(Math.min(depth, 6));

  for (const item of items) {
    if (item.item?.length) {
      // Folder
      lines.push(`${heading} ${item.name}`);
      lines.push("");
      processItems(item.item, lines, depth + 1);
    } else if (item.request) {
      // Request
      const { method, url } = item.request;
      const path = url.raw || url.path?.join("/") || "";
      lines.push(`${heading} ${method} ${path}`);
      lines.push("");

      if (item.request.description) {
        lines.push(item.request.description);
        lines.push("");
      }

      // Headers
      if (item.request.header?.length) {
        const headers = item.request.header.filter(h => !h.key.startsWith("//"));
        if (headers.length > 0) {
          lines.push("**Headers:**");
          lines.push("");
          lines.push("| Key | Value |");
          lines.push("|-----|-------|");
          for (const h of headers) {
            lines.push(`| ${h.key} | ${h.value} |`);
          }
          lines.push("");
        }
      }

      // Auth
      if (item.request.auth) {
        lines.push(`**Auth:** ${formatAuth(item.request.auth)}`);
        lines.push("");
      }

      // Body
      if (item.request.body?.raw) {
        lines.push("**Body:**");
        lines.push("");
        lines.push("```json");
        try {
          const parsed = JSON.parse(item.request.body.raw);
          lines.push(JSON.stringify(parsed, null, 2));
        } catch {
          lines.push(item.request.body.raw);
        }
        lines.push("```");
        lines.push("");
      }

      // Response examples
      if (item.response?.length) {
        for (const resp of item.response.slice(0, 2)) {
          lines.push(`**Response (${resp.code} ${resp.status}):**`);
          lines.push("");
          if (resp.body) {
            lines.push("```json");
            try {
              const parsed = JSON.parse(resp.body);
              lines.push(JSON.stringify(parsed, null, 2));
            } catch {
              lines.push(resp.body);
            }
            lines.push("```");
          }
          lines.push("");
        }
      }

      lines.push("---");
      lines.push("");
    }
  }
}

function formatAuth(auth: PostmanAuth): string {
  switch (auth.type) {
    case "bearer":
      return "Bearer Token";
    case "basic":
      return "Basic Auth";
    case "oauth2":
      return "OAuth 2.0";
    case "apikey": {
      const loc = auth.apikey?.find(a => a.key === "in")?.value ?? "header";
      return `API Key (${loc})`;
    }
    default:
      return auth.type;
  }
}
