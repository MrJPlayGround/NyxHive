# Procedural Skill Policy

Procedural skills are NyxHive's reusable procedural memory. They should encode how Nyx or Vortex makes a future decision after a proven run, not merely what commands were run once.

## Promotion Rule

Promote a workflow into a skill only when all of these are true:

- The workflow replaces a repeatable decision, not just a repeatable task.
- The source run completed successfully and has verification evidence.
- The skill states the trigger condition, decision boundary, when-not-to-use boundary, and verification path.
- The lesson generalizes to a class of future tasks, not one incident, one branch, one stale process, or one chat thread.
- The skill would change future behavior before the agent touches files, restarts services, approves work, rejects work, escalates, or chooses an investigation path.

## Save As Something Else

Do not create a procedural skill for:

- one-off incident notes
- design-only plans or handoffs
- raw logs, command transcripts, or restart recipes
- simple operational replays such as pull, build, restart, and status checks
- completed task summaries that do not include a reusable decision
- project or user preferences that belong in memory
- policy/governance changes that need explicit User approval before becoming standing behavior

## Good Shape

A publishable draft should be easy to answer with:

- When should the agent load this skill?
- What decision does it replace?
- What evidence resolves the decision?
- When should the agent avoid the skill?
- How does the agent verify the result?

Example: "When cockpit replies do not appear live but show after refresh, decide whether the fault is server persistence, runtime event delivery, or client merge state before changing UI layout."

Non-example: "Pull master on Air, build the gateway, and restart NyxAI and NyxLabs."

## Research Notes

Hermes treats skills as on-demand procedural knowledge and agent-managed procedural memory for non-trivial workflows discovered after successful complex work, corrections, or dead ends. NyxHive follows that shape but adds a stricter gate because its auto-drafting created too many low-value candidates: the draft must preserve a reusable decision boundary and proof from a completed run.

The Agent Skills format also favors compact `SKILL.md` files with frontmatter, task instructions, examples, edge cases, and optional supporting files. NyxHive drafts should keep the main skill small and move long references or raw evidence elsewhere.

References:

- Hermes README: <https://github.com/NousResearch/hermes-agent>
- Hermes skills guide: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md>
- Hermes memory guide: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md>
- OpenAI skills README: <https://github.com/openai/skills>
