# Plan: NyxHive Onboarding UX — Close the Gap with Hermes

**Goal:** Make NyxHive as easy to set up as Hermes while preserving its depth for power users. Currently NyxHive requires founder-level expertise to configure. Target: anyone with API keys can be running in 10 minutes.

**Principle:** Hide depth until someone needs it. Simple surface, power underneath. Never dumb down — layer the complexity.

---

## Phase 1: Setup Wizard (`nyxhive init`)

**Priority:** Highest — first impression, biggest impact.

**Current state:** `nyxhive init` copies a template. User still has to hand-edit config.toml, create .env, understand soul directories, wire ports.

**Target state:** Interactive wizard that produces a working instance.

### Flow

```
$ nyxhive init

What should this instance be called? > my-assistant

What's its purpose?
  1. Coding assistant (lead agent + specialists)
  2. AI companion (conversational + tools)
  3. Trading/ops (domain-specific automation)
  4. Custom (start from scratch)
> 2

Which LLM provider?
  1. Anthropic (Claude)
  2. OpenAI (GPT/Codex)
  3. OpenRouter (multi-provider)
  4. Ollama (local)
> 1

  Enter your ANTHROPIC_API_KEY: fake-anthropic-key
  ✓ Key validated

Which channels? (space to toggle, enter to confirm)
  [x] Telegram
  [ ] Discord
  [ ] Slack
  [ ] iMessage

  Enter Telegram bot token: ...
  ✓ Bot connected: @my_assistant_bot

Connect to other NyxHive instances? (y/N) > n

✓ Instance created at ./my-assistant/
✓ Config written, .env populated
✓ Soul preset applied: companion

Start now? (Y/n) > y
  ✓ my-assistant running on port 3780
  ✓ Telegram connected — send a message to @my_assistant_bot
```

### Implementation notes

- Wizard lives in `src/cli/init-wizard.ts`
- API key validation: hit the provider's models endpoint, confirm auth
- Telegram validation: getMe() call
- Port auto-assignment: scan 3780-3799, pick first available
- Generate .env from answers, never leave blank required fields
- Soul preset selection based on purpose choice (see Phase 3)
- Output a working instance that boots without editing any files

### Effort: Medium-large (2-3 days)

---

## Phase 2: Simple Config Mode

**Current state:** config.toml has 15+ sections, ~90 lines minimum. Agent definitions require understanding roles, providers, models, capabilities, routing, context strategies.

**Target state:** Two config tiers.

### Tier 1: Simple (20 lines)

```toml
name = "my-assistant"
port = 3780

[provider]
name = "anthropic"
api_key_env = "ANTHROPIC_API_KEY"
model = "claude-sonnet-4-20250514"

[telegram]
bot_token_env = "TELEGRAM_BOT_TOKEN"
```

That's it. The system:
- Creates a default agent named after the instance
- Sets role based on the soul preset (or defaults to "lead")
- Uses sensible defaults for routing, context, budget, timeout
- Enables scheduler with no tasks (user adds later)

### Tier 2: Full (current config.toml)

Power users eject into full config when they need:
- Multiple agents
- Custom routing/classification
- Federation
- Scheduler tasks
- Budget controls
- Pairing

### Migration path

`nyxhive eject` — converts simple config to full config.toml with all defaults made explicit. One-way, no going back needed.

### Implementation notes

- Config loader detects which tier by presence of `[agents.*]` blocks
- If no `[agents.*]`, synthesize a default agent from top-level fields
- All current defaults in `src/defaults.ts` stay — simple mode just hides them
- Full mode is unchanged, no breaking changes

### Effort: Medium (1-2 days)

---

## Phase 3: Soul Presets

**Current state:** Soul system is 3 layers (base.yaml + instance.yaml + agent directories with identity/personality/rules/tools/context.md). Powerful but requires understanding the compilation model.

**Target state:** Named presets that map to pre-written soul configurations.

### Presets

| Name | Description | Role | Soul characteristics |
|------|-------------|------|---------------------|
| `coder` | Coding assistant | lead | Direct, technical, reads before writing, runs tests |
| `companion` | General-purpose AI companion | orchestrator | Conversational, opinionated, warm, tools when needed |
| `ops` | Operations monitor | orchestrator | Terse, alert-focused, health-first |
| `researcher` | Research + analysis | worker | Thorough, cites sources, structured output |
| `custom` | Blank slate | configurable | Minimal personality, user fills in |

### Implementation

- Presets stored in `templates/presets/` as complete soul directories
- `nyxhive init` applies preset based on purpose selection
- `nyxhive preset list` — show available presets
- `nyxhive preset apply <name>` — switch an existing instance's soul
- `nyxhive preset eject` — copies preset into editable soul directory for customization

### Effort: Small-medium (1 day for presets, half day for CLI commands)

---

## Phase 4: Federation Made Easy (`nyxhive link`)

**Current state:** Federation requires:
1. Generate API keys on both sides
2. Edit config.toml on instance A to add `[remotes.b]` with URL + key
3. Edit config.toml on instance B (or its .env) to accept that key
4. Know the ports, restart both instances

**Target state:** One command.

```
$ nyxhive link my-assistant nyxai

  ✓ Found my-assistant at localhost:3780
  ✓ Found nyxai at localhost:3777
  ✓ Generated shared API key
  ✓ Added [remotes.nyxai] to my-assistant config
  ✓ Registered my-assistant as authorized caller on nyxai
  ✓ Restart both instances to activate? (Y/n)

  Federation active. my-assistant can now delegate to nyxai agents.
```

### Implementation notes

- Read both instance configs from bookmarks
- Generate a secure random API key
- Append `[remotes.*]` block to caller's config.toml
- Add key to callee's .env or authorized_keys store
- Optionally restart both via `nyxhive restart`

### Also add: `nyxhive unlink`, `nyxhive links` (show federation map)

### Effort: Medium (1-2 days)

---

## Phase 5: Instance Management Polish

### `nyxhive status` (enhanced)

```
$ nyxhive status

  Instance       Port   Status    Uptime    Agents    Last Activity
  ─────────────────────────────────────────────────────────────────
  NyxAI          3777   running   4h 12m    10        2m ago
  NyxLabs        3778   running   4h 12m    4         15m ago
  Aether         3779   running   4h 12m    2         1h ago
  Strider        3780   running   0h 03m    1         just now

  Federation: NyxAI ← Strider → NyxLabs, Aether
  Total cost today: $12.47
```

### `nyxhive logs <name>` — tail instance logs without hunting paths
### `nyxhive health` — quick fleet health check across all instances
### `nyxhive costs` — aggregated cost view across all instances

### Effort: Small (1 day)

---

## Phase 6: Getting Started Doc

**Not architecture docs.** A single page: "Zero to Running in 10 Minutes."

### Structure

1. Install NyxHive (3 lines)
2. Get an API key (link to provider)
3. Run `nyxhive init` (wizard handles the rest)
4. Send your first message
5. Next steps: add channels, connect instances, customize soul

### Lives at: README.md (top section) + docs/getting-started.md (detailed)

### Effort: Small (half day)

---

## Execution Order

| Phase | What | Effort | Impact |
|-------|------|--------|--------|
| 1 | Setup wizard | 2-3 days | Critical — first impression |
| 2 | Simple config | 1-2 days | High — reduces cognitive load |
| 3 | Soul presets | 1.5 days | Medium — removes soul expertise barrier |
| 4 | Federation linking | 1-2 days | High — makes killer feature accessible |
| 5 | Instance management | 1 day | Medium — quality of life |
| 6 | Getting started doc | 0.5 day | High — first thing people read |

**Total: ~8-11 days of focused work**

Phases 1-3 are the core. If NyxHive ships those three, the setup experience goes from "read 200 lines of TOML docs" to "answer 5 questions and you're running." Phases 4-6 are polish that compound the value.

---

## Success Criteria

- Someone with zero NyxHive knowledge can have a working instance in 10 minutes
- No file editing required for basic setup
- The full power (multi-agent, federation, custom souls) is still accessible but opt-in
- Existing configs don't break — full mode is unchanged

## Anti-patterns to Avoid

- Don't abstract away too much — users should understand what they're running
- Don't create a "simple mode" that's a dead end — always allow ejection to full config
- Don't make the wizard the only path — power users should still be able to `nyxhive init --bare` and hand-write config
- Don't break existing instances — this is additive, not a rewrite
