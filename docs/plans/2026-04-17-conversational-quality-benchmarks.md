# Conversational Quality Benchmarks

NyxHive has a lightweight benchmark surface for conversation quality regressions.

## What Is Measured

- runtime mode selected for scripted scenarios
- prompt profile selected for scripted scenarios
- prompt token composition
- policy-to-soul ratio
- policy section count
- memory lane count
- reply-shape diagnostics:
  - bullet count
  - internal framework terms
  - action-framing starts

## Harness

Executable helpers live in `src/runtime/conversation-benchmark.ts`.

The harness is intentionally deterministic. It does not judge model output quality directly; it checks the structural conditions that make stiff output more likely.

## Guardrail Tests

The regression suite covers:

- greeting and casual-turn mode selection
- reflective follow-ups not inheriting coding execution
- agentic follow-ups still carrying action context
- conversation profile prompt pruning
- memory lane filtering
- reply-shape detection of internal workflow narration
- policy/soul prompt composition bounds

