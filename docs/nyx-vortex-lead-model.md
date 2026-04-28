# Nyx / Vortex Lead Model

## Roles

- **Nyx** is the engineering lead and repo owner for **NyxHive**. She owns the engine, runtime, agent model, prompts, delegation behavior, templates, and repo-level technical direction.
- **Vortex** is the product-and-domain lead and repo owner for **NyxLabs**. He owns the trading/journal product, domain language, UX shape, data model, and product correctness.

## Boundaries

- Nyx and Vortex are **repo leads**, not generic assistants.
- They are **not pure orchestrators**. They own decisions and implementation in their home repo.
- They are **not duplicate coder personas**. Nyx owns NyxHive architecture and agent behavior; Vortex owns NyxLabs product behavior and domain logic.
- They are **not managers of each other**. Cross-repo help is collaboration, not hierarchy.

## Delegation Rules

- The lead for the relevant repo keeps the conversation and final call.
- Delegate specialist slices when they add leverage: research, broad QA, review, focused discovery, or docs.
- Do not delegate just to avoid ownership.
- Cross-repo work should stay repo-owned:
  - Nyx owns NyxHive-side changes.
  - Vortex owns NyxLabs-side changes.
  - If a request spans both repos, the lead whose repo is the center of gravity should own the conversation and pull in the other lead or specialists as needed.

## Conversation Ownership

- **Nyx owns the conversation** when the center of gravity is NyxHive: engine behavior, agents, queue/runtime, souls/prompts, templates, platform defaults, infra for the engine.
- **Vortex owns the conversation** when the center of gravity is NyxLabs: trading workflows, journaling UX, domain decisions, product language, Supabase schema and app behavior.
- Casual chat can happen with either, but “companion mode” is outside the definition of both leads.

## Outside Both Roles

- Generic life-companion behavior
- Fleet-supervisor / fake multi-boss personas
- Pure routing-only orchestrators
- Specialist worker roles like reviewer, tester, researcher, ops monitor

## Audit: Current Conflicts

- `src/agents/invoke.ts` still forced `lead` agents down the orchestrator fast path, so Nyx/Vortex were being classified like orchestrators even when they should own coding and repo decisions directly.
- `src/agents/platform-docs.ts` only injected the management/delegation operating model for `role = "orchestrator"`, not for `lead`, so Nyx/Vortex were not first-class in generated platform docs/prompts.
- `templates/default/template.json` and `templates/full/template.json` still defaulted to “Nyx orchestrator + Forge coder”, which recreates the old split-brain boss/coder model.
- `config/template.toml` still scaffolded an orchestrator-first prompt.
- `souls/vortex/identity.md` still described Vortex as the builder of ChromaTrading Journal instead of the NyxLabs product/domain lead.
- `config/nyxhive.toml` still framed Nyx as the lead for “NyxAI” instead of the NyxHive repo owner.
- `src/nyx/commands/cockpit.ts` still surfaced legacy Onyx wording in user-facing help text.

## First-Pass Cleanup In This Change

- Make `lead` agents classify and run like leads rather than pure orchestrators.
- Give `lead` agents the generated operating model docs that were previously reserved for orchestrators.
- Rewrite Nyx and Vortex soul text around repo ownership and clearer boundaries.
- Update shipped defaults/templates so Nyx is the direct repo lead instead of a generic orchestrator delegating to a duplicate coder.
- Remove a visible Onyx-era label from the cockpit command path.

## Second Pass

- Retire or archive the remaining Strider/Onyx-era template and branding artifacts that are no longer part of the desired architecture.
- Rename internal legacy terminology like “orchestrator” in comments, helper names, and some task-type plumbing where the behavior is still correct but the language is stale.
- Tighten cross-instance handoff mechanics so Nyx/Vortex ownership can be expressed explicitly in config and routing, not just soul text.

## Second-Pass Status

### Retired

- `templates/orchestrator/*` — removed from built-in templates. Strider is no longer part of the intended product surface.
- `souls/onyx.yaml` — removed. Onyx is no longer an active soul or product identity.

### Kept For Compatibility

- Internal `role = "orchestrator"` support stays in the runtime because pure coordination agents still exist as a compatibility/runtime concept.
- Legacy instance aliases like `onyx` and `strider` remain only in narrowly-scoped CLI compatibility shims so older local setups still resolve instead of breaking.
- Companion / ops presets remain available as compatibility presets, but they are no longer the default direction of the product surface.

### Intentionally Still Present

- The `orchestrator` task type and related routing table entries remain in the engine because they model coordination-heavy work internally.
- Some lower-level comments and historical tests still mention orchestrators or old names where they are describing compatibility behavior rather than the current product story.
