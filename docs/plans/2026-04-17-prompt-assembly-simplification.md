# Prompt Assembly Simplification

The prompt builder is profile-driven:

- `conversation_light` keeps identity, speaker context, selected knowledge, and compact reply-shape guidance.
- `agentic_standard` keeps operational guardrails but compresses the operating model.
- `agentic_heavy` keeps the full execution contract for work that can change files, run commands, or coordinate agents.

## Conversation Cuts

Conversation mode excludes:

- generated platform context
- current date/live-fact block
- Slack/custom channel guidance
- learned patterns
- routing suggestions
- generic graph briefing
- work log
- active delegation list
- strict agentic contract
- clarification instruction
- wisdom/delegation-depth/context-pressure blocks

These sections still appear in agentic modes when useful.

## Hierarchy

1. hard safety and explicit user instructions
2. soul/personality/voice
3. current speaker and recent context
4. selected memory lanes
5. task-specific execution policy
6. routing and operating hints

Tone belongs to the soul. Execution policy controls behavior and evidence requirements; it should not rewrite warmth, rhythm, wit, or conversational pacing.

