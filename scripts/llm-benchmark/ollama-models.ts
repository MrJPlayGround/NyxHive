const OLLAMA_URL = "http://localhost:11434";

interface OllamaTagResponse {
  models?: Array<{ name: string }>;
}

export async function listInstalledModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`Ollama tags error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as OllamaTagResponse;
  return (data.models ?? []).map((model) => model.name);
}

export function resolveInstalledModel(requested: string, installed: string[]): string | null {
  return installed.find((name) => name === requested)
    ?? installed.find((name) => name.startsWith(`${requested}:`))
    ?? null;
}

export async function resolveInstalledModels(requested: readonly string[]): Promise<string[]> {
  const installed = await listInstalledModels();
  const resolved = requested
    .map((model) => ({ requested: model, resolved: resolveInstalledModel(model, installed) }))
    .filter((entry): entry is { requested: string; resolved: string } => entry.resolved !== null);
  const missing = requested.filter((model) => !resolved.some((entry) => entry.requested === model));
  if (missing.length > 0) {
    console.warn(`[bench] Skipping unavailable Ollama models: ${missing.join(", ")}`);
  }
  return resolved.map((entry) => entry.resolved);
}
