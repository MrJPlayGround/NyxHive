import { defineCommand } from "citty";
import { intro, outro, text, password, spinner, isCancel, cancel } from "@clack/prompts";
import pc from "picocolors";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isRemoteMode, loadInstances, REMOTE_CONFIG_FILE, loadGatewayConfig } from "../lib/config.js";
import { api } from "../lib/api.js";
import { saveModelConfig, loadModelConfig } from "../lib/provider.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyGateway(host: string, apiKey: string): Promise<number> {
  const res = await fetch(`${host}/api/agents`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object" && "agents" in data && Array.isArray((data as Record<string, unknown>).agents)) {
    return ((data as Record<string, unknown>).agents as unknown[]).length;
  }
  return 0;
}

interface RemoteAgent {
  name: string;
  port?: number;
}

async function discoverInstances(
  host: string,
  apiKey: string,
): Promise<RemoteAgent[]> {
  try {
    const res = await fetch(`${host}/api/agents`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as RemoteAgent[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function buildToml(gatewayHost: string, gatewayKey: string, instances: RemoteAgent[]): string {
  const lines: string[] = [];
  lines.push("[gateway]");
  lines.push(`host = "${gatewayHost}"`);
  lines.push(`api_key = "${gatewayKey}"`);
  lines.push("");

  for (const inst of instances) {
    if (!inst.name) continue;
    const instHost = inst.port
      ? gatewayHost.replace(/:\d+$/, `:${inst.port}`)
      : gatewayHost;
    lines.push(`[instances.${inst.name}]`);
    lines.push(`host = "${instHost}"`);
    lines.push(`api_key = "${gatewayKey}"`);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const initCmd = defineCommand({
  meta: { name: "init", description: "Interactive setup wizard for remote mode" },
  async run() {
    intro(pc.bold("nyx config init"));

    const gwHost = await text({
      message: "Gateway host",
      placeholder: "http://100.109.215.36:3780",
      validate: (v) => {
        if (!v || !v.startsWith("http")) return "Must start with http:// or https://";
      },
    });
    if (isCancel(gwHost)) { cancel("Aborted"); return; }

    const gwKey = await password({
      message: "API key",
    });
    if (isCancel(gwKey)) { cancel("Aborted"); return; }

    const s = spinner();
    s.start("Connecting to gateway...");

    let agentCount = 0;
    let agents: RemoteAgent[] = [];
    try {
      agentCount = await verifyGateway(gwHost as string, gwKey as string);
      agents = await discoverInstances(gwHost as string, gwKey as string);
      s.stop(`Connected — ${agentCount} agent(s) found`);
    } catch (err) {
      s.stop(pc.red(`Connection failed: ${err instanceof Error ? err.message : err}`));
      return;
    }

    // Write config
    const toml = buildToml(gwHost as string, gwKey as string, agents);
    await mkdir(dirname(REMOTE_CONFIG_FILE), { recursive: true });
    await writeFile(REMOTE_CONFIG_FILE, toml, "utf-8");

    outro(pc.green(`Config written to ${REMOTE_CONFIG_FILE}`));
    if (agents.length > 0) {
      console.log(`  Instances: ${agents.map((a) => a.name).join(", ")}`);
    }
  },
});

const showCmd = defineCommand({
  meta: { name: "show", description: "Print current config" },
  async run() {
    if (!isRemoteMode()) {
      console.log(`  Mode:      ${pc.yellow("local")} (reading ~/.nyxhive/instances/)`);
      const instances = await loadInstances();
      if (instances.length === 0) {
        console.log("  Instances: none found");
      } else {
        const names = instances.map((i) => `${i.name} (${i.port})`).join("  ");
        console.log(`  Instances: ${names}`);
      }
      return;
    }

    const gw = await loadGatewayConfig();
    const instances = await loadInstances();

    console.log(`  Config:    ${REMOTE_CONFIG_FILE} ${pc.cyan("(remote mode)")}`);

    if (gw) {
      // Check connectivity
      let statusMark: string;
      try {
        await api(gw, "/api/queue/health", { timeout: 3_000 });
        statusMark = pc.green("connected");
      } catch {
        statusMark = pc.red("unreachable");
      }
      console.log(`  Gateway:   ${gw.host}  ${statusMark}`);
    }

    if (instances.length > 0) {
      const names = instances.map((i) => `${i.name} (${i.port})`).join("  ");
      console.log(`  Instances: ${names}`);
    } else {
      console.log("  Instances: none");
    }
  },
});

const setCmd = defineCommand({
  meta: { name: "set", description: "Set a config value" },
  args: {
    key:   { type: "positional", required: true,  description: "Config key (e.g. model)" },
    value: { type: "positional", required: true,  description: "Value (e.g. anthropic:claude-sonnet-4-6)" },
  },
  async run({ args }) {
    if (args.key === "model") {
      const [provider, ...rest] = (args.value as string).split(":");
      const model = rest.join(":") || "claude-sonnet-4-6";
      const validProviders = ["nyxhive", "anthropic", "openai"];
      if (!validProviders.includes(provider)) {
        console.log(pc.red(`  Unknown provider "${provider}". Valid: ${validProviders.join(", ")}`));
        return;
      }
      await saveModelConfig(provider, model);
      console.log(`  ${pc.green("✓")} model → ${pc.cyan(provider + ":" + model)}`);
    } else {
      console.log(pc.yellow(`  Unknown key "${args.key}". Supported: model`));
    }
  },
});

const modelCmd = defineCommand({
  meta: { name: "model", description: "Show current model config" },
  async run() {
    const cfg = await loadModelConfig();
    console.log(`  ${pc.dim("provider:")} ${pc.cyan(cfg.provider)}`);
    console.log(`  ${pc.dim("model:")}    ${pc.cyan(cfg.model)}`);
    if (cfg.provider === "nyxhive") {
      console.log(`  ${pc.dim("(routing through NyxHive server — no direct API key needed)")}`);
    }
  },
});

export default defineCommand({
  meta: { name: "config", description: "Manage nyx CLI configuration" },
  subCommands: { init: initCmd, show: showCmd, set: setCmd, model: modelCmd },
});
