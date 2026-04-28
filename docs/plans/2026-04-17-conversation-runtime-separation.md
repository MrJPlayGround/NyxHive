# Conversation Runtime Separation

NyxHive now treats conversation as a first-class runtime mode, not as a weak task type inside the agentic path.

## Runtime Modes

- `conversation`: greetings, vents, casual thoughts, ordinary back-and-forth, simple questions, and low-action follow-ups.
- `hybrid`: substantive thinking, advice, expert discussion, and reflective analysis that needs reasoning but not an execution workflow.
- `agentic`: coding, review, research, file work, command execution, orchestration, and other state-changing work.

## Prompt Profiles

- `conversation_light`: soul-forward, minimal runtime policy, no platform/date/work-log/routing/strict-agentic scaffolding.
- `agentic_standard`: operationally capable, but compressed enough for advice, research, and thought-heavy turns.
- `agentic_heavy`: full execution contract for coding, review, long-context work, and orchestration.

## Selection Rules

Runtime mode is computed before prompt assembly from task type, explicit action intent, file references, attachments, and conversational inertia. Explicit action or file intent wins over casual language. Short reflective turns stay conversational instead of inheriting a coding pipeline by accident.

## Trace Contract

Prompt assembly traces include:

- `runtimeMode`
- `promptProfile`
- token cost by section
- injected/excluded sections
- policy/soul token shares
- memory lanes injected

