# Instance Isolation Design

**Date:** 2026-03-07
**Status:** Approved

## Problem

NyxHive instances (NyxAI, NyxLabs, Acme) are meshed when they should be isolated. Shared global registry, shared API keys, shared browser profile, hardcoded MCP routing, and automatic cross-instance discovery violate the principle that each instance is an independent deployment of the NyxHive stack.

## Core Model

**NyxHive = engine. Instances = deployments.**

NyxHive is a globally-installed CLI tool. It ships the runtime (daemon, queue, routing, agent invocation, MCP server), a base soul (behavioral rules), and the `nyxhive` CLI.

An instance is a self-contained, portable directory that uses the engine. An instance knows nothing about other instances unless explicitly configured. No global registry. No shared data. No automatic discovery.

**Portability guarantee:** `rsync` an instance directory to a new machine, install `nyxhive`, run `nyxhive start`. Done.

## Instance Directory Structure

```
<instance>/
├── config.toml          # daemon name, port, agents, providers, routing
├── .env                 # API keys, bot tokens (never shared between instances)
├── data/                # SQLite DBs, logs, PID file, browser-profile/
├── workspace/           # per-agent working directories
└── souls/
    └── instance.yaml    # identity, context, relationships (layered on engine base)
```

## Topology

Star topology. NyxAI at the center, optional outbound spokes.

```
        NyxLabs
          ^
          |
NyxAI ---+  (outbound dispatch, configured in NyxAI's config.toml)
          |
          v
        Acme
```

- NyxAI can dispatch to other instances via their HTTP APIs, configured in its own `config.toml` under a `[remotes]` section with explicit URL + API key per target.
- Leaf instances (NyxLabs, Acme) have no `[remotes]` config. They receive API calls like any HTTP server but don't initiate cross-instance communication.
- No global registry. Each instance is standalone.

## Soul Layering

```
Engine base soul (ships with nyxhive)
  - Behavioral rules: verify work, be direct, evidence before assertions
  - Safety rules: no force push, no skipping hooks
  - Communication standards: no filler, complete work products

Instance soul (lives in <instance>/souls/instance.yaml)
  - Identity: "You are Atlas, lead engineer for NyxLabs"
  - Context: project paths, tech stack, relationships
  - Instance-specific rules or overrides
```

The engine base soul is loaded at runtime from the engine installation, not copied into instances. Instance souls layer on top. Upgrading the engine improves base behavioral rules for all instances automatically.

## Engine Distribution

- **Long-term:** `bun install -g nyxhive` (npm package with versioning)
- **Short-term:** git clone + `bun link`
- Engine version is independent of instance data

## MCP & Claude Code Integration

Per-project `.mcp.json` in each repo, pointing at its instance's MCP endpoint:

- `trading-journal/.mcp.json` -> `localhost:3778` (NyxLabs)
- `acme-agentic-workspace/.mcp.json` -> `localhost:3779` (Acme)
- `nyxhive/.mcp.json` -> `localhost:3777` (NyxAI) (already exists)

No global MCP config. Claude Code discovers the right instance by walking the directory tree.

## Global Directory (`~/.nyxhive/`)

Reduced to a thin CLI home:

- `~/.nyxhive/bookmarks.json` — convenience list of local instance paths for `nyxhive list` (operator-level, not runtime)
- `~/.nyxhive/cli-config.json` — CLI preferences (if any)

No instance data, no registry, no shared resources.

## Migration: What Changes

| Current | After |
|---------|-------|
| `~/.nyxhive/instances.json` global registry | Deleted. `bookmarks.json` for CLI convenience only |
| `~/.nyxhive/instances/{name}/` holds all instances | Instance dirs live wherever you want |
| `~/.nyxhive/browser-profile/` shared | Per-instance `data/browser-profile/` |
| `~/.nyxhive/nyxai.db`, `nyxhive.db` stale root DBs | Deleted |
| `souls/instance.yaml` in engine repo (NyxAI-specific) | Engine ships base soul only; NyxAI identity moves to instance dir |
| `/home/user/dev/.mcp.json` hardcodes NyxAI | Per-project `.mcp.json` in each repo |
| Shared OpenRouter/Brave keys in env files | Each instance owns its own keys |
| `dispatchToInstance()` reads global registry | Reads `[remotes]` from instance's own `config.toml` |
| `config/nyxhive.toml` in engine repo is NyxAI's live config | Moved to NyxAI's instance directory |
| `nyxhive init` scaffolds under `~/.nyxhive/instances/` | Scaffolds in current directory or specified path |

## `nyxhive init` Scaffold

```bash
nyxhive init acme
# Creates ./acme/ with:
```

```
acme/
├── config.toml          # server port, daemon name, empty agents section
├── .env                 # placeholder API key vars
├── data/                # empty (DBs created on first start)
├── workspace/           # empty (agent workdirs created on first start)
└── souls/
    └── instance.yaml    # identity stub (name, empty context)
```

## NyxAI: Patient Zero

NyxAI is the dogfooding instance — it develops the engine AND runs as an instance. Architecturally it follows the same rules as any other instance. Its instance directory happens to coexist with the engine repo, but it's still a separate, portable deployment.
