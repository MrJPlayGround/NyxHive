# NyxHive Tool-Use Trust Boundary Audit

Date: 2026-04-11
Scope: small enforcement pass plus operating contract. No broad tool behavior redesign.

## Summary

NyxHive has three tool execution surfaces:

1. Claude CLI tools, configured in `src/agents/invoke-cli.ts`.
2. Native API and SDK local tools, implemented by `src/agents/tools.ts` and exposed through `src/agents/invoke-native-api.ts` and `src/agents/invoke-sdk.ts`.
3. MCP integration tools, bridged from local and remote NyxHive instances through `src/agents/native-mcp-client.ts` and `src/server/urls.ts`.

The core trust distinction is local vs remote/integration:

- Local tools run in the agent workspace and are bounded by `working_directory`, `allowed_directories`, role write gates, and per-agent `allowed_tools`/`disallowed_tools`.
- Remote/integration tools are outside the local workspace trust boundary. They can reveal or mutate data owned by another instance or service, so they should require both a per-agent MCP tool list and an explicit remote-side agent grant.

This pass tightens two gaps without changing core tool execution semantics:

- SDK local tools now respect the same per-agent `allowed_tools`/`disallowed_tools` mapping that native API tools already used.
- Native API remote MCP endpoints now require `remotes.<name>.agents` to include the invoking agent, or `"*"`, before tools from that remote are exposed.

## Current Model

### Local CLI Tools

- `src/agents/invoke-cli.ts` maps agent config to Claude CLI flags.
- `allowed_tools` becomes a hard `--tools` restriction when configured.
- `disallowed_tools` is always passed, with `AskUserQuestion` blocked because there is no interactive stdin.
- Pure orchestrators get read-only defaults unless explicitly allowlisted.
- MCP tools are appended into the Claude `--tools` list only when an agent has configured MCP tools.

This surface is comparatively strong because the model only sees tools that the harness decides to expose.

### Local SDK And Native API Tools

- `src/agents/tools.ts` implements local read tools, write/command tools, utility tools, web tools, and knowledge search.
- Path validation keeps file access within the workspace plus `allowed_directories`.
- Write tools and `run_command` require `ToolContext.writable`.
- Native API already filtered local tool definitions through agent allow/block lists and forced read-only tools for review/audit/research tasks.
- SDK did not previously apply `allowed_tools`/`disallowed_tools`, so a coder routed through SDK could still see all default local tools for that role.

The new shared helper in `src/agents/tool-permissions.ts` normalizes Claude-style names such as `Read`, `Bash`, `WebSearch` and native names such as `read_file`, `run_command`, `web_search`, then applies the allow/block lists before tools are exposed.

### MCP And Remote Integration Tools

- Local MCP tools require `agent.mcp_tools` or soul `capabilities.mcp_tools`.
- Remote MCP endpoints are read from `[remotes]`.
- Before this pass, a remote with no `agents` list was exposed to every agent if the agent had matching `mcp_tools`.
- After this pass, remote MCP tools require an explicit remote grant:
  - `remotes.<name>.agents = ["strider"]` grants only that agent.
  - `remotes.<name>.agents = ["*"]` grants all local agents intentionally.
  - No `agents` list means the remote is not exposed as a native API tool endpoint.

This makes local MCP and remote MCP distinct: local MCP is governed by this instance's agent config, while remote MCP is governed by this instance's agent config plus the remote entry's agent allowlist.

## Follow-Ups

1. Add audit-log events for tool policy decisions once an `AuditLog` dependency is cleanly available in `InvokeOpts`. Useful events: `security.tool_policy_applied`, `security.tool_blocked`, and `security.remote_mcp_skipped`.
2. Add UI/API display of effective tool permissions per agent: local read, local write, command, web, local MCP, remote MCP.
3. Add a startup warning when `[remotes]` entries omit `agents`, so operators can choose between explicit per-agent lists and `["*"]`.

## Verification Targets

- SDK tests assert `allowed_tools` and `disallowed_tools` filter local tool exposure.
- Native API tests assert remote MCP tools are exposed only through explicit `agents` grants.
- URL tests assert wildcard grants and implicit-deny behavior for remote MCP endpoint resolution.
