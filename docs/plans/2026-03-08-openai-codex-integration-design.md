# OpenAI + Codex Integration Design

**Date**: 2026-03-08
**Status**: Approved
**Approach**: A — Codex-First

## Goals

1. **OpenAI as a provider** — GPT-5.4, GPT-5.3-Codex, GPT-5-mini etc. via Chat Completions API. Same `Provider` interface as Anthropic/OpenRouter.
2. **Codex as a coding agent backend** — Spawn `codex app-server` as subprocess, talk JSON-RPC over stdio. Configurable as `cli_fallback` for any agent.
3. **Auth via `codex login`** — Read `~/.codex/auth.json` for tokens. Token exchange gives us an `sk-...` API key for the provider. Handle token refresh.

## Non-Goals

- Building our own OAuth flow (rely on `codex login`)
- Responses API (Chat Completions matches existing provider patterns)
- In-process Codex SDK (it shells out to `codex` binary anyway)

## Architecture

### 1. OpenAI Provider (`src/providers/openai.ts`)

New provider implementing the `Provider` interface. Follows OpenRouter's HTTP-based pattern.

**Auth resolution order:**
1. `OPENAI_API_KEY` env var (direct API key)
2. `~/.codex/auth.json` → `OPENAI_API_KEY` field (from token exchange)
3. `~/.codex/auth.json` → `tokens.access_token` + token exchange on-demand
4. Error with instructions to run `codex login` or set env var

**Token refresh:**
- Check token freshness on each request (8-minute interval, matching Codex)
- Refresh via `POST https://auth.openai.com/oauth/token` with refresh_token
- After refresh, re-exchange for API key if needed
- Store refreshed tokens back to `~/.codex/auth.json`

**Chat Completions mapping:**
- `CompletionParams.messages` → OpenAI messages format (role/content)
- `CompletionParams.tools` → OpenAI function calling format
- `CompletionParams.system` → system message
- Streaming: SSE via `stream: true`
- Response → `ProviderResponse` (content, tokens, tool_calls, finish_reason)

**Models:**
- `gpt-5.4` (tier 4) — flagship, 1M context
- `gpt-5.4-pro` (tier 4) — highest capability
- `gpt-5.3-codex` (tier 3) — industry-leading coding model
- `gpt-5-mini` (tier 2) — fast, cost-efficient
- `gpt-5-nano` (tier 1) — fastest, cheapest
- Model list updatable without code changes via config

### 2. Codex CLI Adapter (`src/agents/invoke-codex.ts`)

New invocation module for Codex agent backend. Spawns `codex app-server` and communicates via JSON-RPC over stdio.

**JSON-RPC protocol (from T3Code research):**
- Newline-delimited JSON over stdin/stdout
- Request/response correlation via message IDs
- Event types: turn start/stop, streaming messages, approval requests, file changes
- Approval types: command execution, file change, file read

**Integration with existing invoke machinery:**
- `cli_fallback = "codex"` in agent config triggers this path
- Same `InvocationResult` return type as `invokeCliI`
- Progress callbacks for streaming
- Session management (start, resume, stop)
- Timeout handling (same tiers as Claude Code)

**Key differences from Claude Code CLI invocation:**
- Protocol: JSON-RPC over stdio (not stream-json)
- Approval: Built-in approval flow (auto-approve in NyxHive context)
- Session: Managed per `codex app-server` instance, not via `--resume`

### 3. Auth Module (`src/auth/codex-auth.ts`)

Shared auth module for reading and refreshing Codex OAuth tokens.

**Constants (from Codex source):**
- Issuer: `https://auth.openai.com`
- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Token endpoint: `https://auth.openai.com/oauth/token`
- Token exchange grant: `urn:ietf:params:oauth:grant-type:token-exchange`

**Functions:**
- `readCodexAuth()` — Read `~/.codex/auth.json`, return parsed tokens
- `refreshTokens()` — Refresh access_token via refresh_token grant
- `exchangeForApiKey()` — Exchange id_token for `sk-...` API key
- `getApiKey()` — High-level: return valid API key, refreshing if needed
- `isTokenFresh(lastRefresh)` — Check if within 8-minute window

### 4. Configuration

```toml
[providers.openai]
# Option 1: Direct API key
api_key_env = "OPENAI_API_KEY"

# Option 2: Codex auth (auto-detected if no api_key_env)
auth_mode = "codex"  # reads ~/.codex/auth.json

default_model = "gpt-5.4"

[agents.codex-agent]
name = "Codex"
role = "coder"
provider = "openai"
model = "gpt-5.4"
always_cli = true
cli_fallback = "codex"  # triggers invoke-codex.ts path
```

### 5. Routing Integration

- Register `openai` in the provider router alongside anthropic/openrouter/minimax
- Add OpenAI models to tier system:
  - Tier 1: gpt-5-nano
  - Tier 2: gpt-5-mini
  - Tier 3: gpt-5.3-codex
  - Tier 4: gpt-5.4, gpt-5.4-pro
- Routing table entries for OpenAI models as alternatives
- Circuit breaker + fallback chain includes OpenAI

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/providers/openai.ts` | **New** | OpenAI Chat Completions provider |
| `src/auth/codex-auth.ts` | **New** | Codex OAuth token reader + refresh |
| `src/agents/invoke-codex.ts` | **New** | Codex app-server JSON-RPC invocation |
| `src/providers/types.ts` | **Edit** | Add `"openai"` to provider union type |
| `src/providers/router.ts` | **Edit** | Register OpenAI, add models to tiers |
| `src/config-schema.ts` | **Edit** | Add openai provider + codex auth config |
| `src/index.ts` | **Edit** | Initialize OpenAI provider on startup |
| `src/agents/invoke.ts` | **Edit** | Route `cli_fallback = "codex"` to invoke-codex |
| `src/types.ts` | **Edit** | Add codex to cli_fallback union |

## Testing

- Unit tests for OpenAI provider (mock fetch, same pattern as openrouter tests)
- Unit tests for codex-auth (mock fs reads, mock fetch for refresh/exchange)
- Unit tests for invoke-codex JSON-RPC parsing
- Integration: manual test with real Codex subscription

## Open Questions

- Codex `app-server` subprocess lifecycle — one per agent? One shared? (Start with one per invocation, optimize later)
- Auto-approve all tool calls in NyxHive context? (Yes — same as `--dangerously-skip-permissions` for Claude Code)
