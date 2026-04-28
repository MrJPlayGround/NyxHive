# Memory Lane Contract

Memory injected into a reply must declare what kind of memory it is. The assistant should not blur routing artifacts, summaries, procedural hints, and personal continuity into one undifferentiated "I remember."

## Lanes

| Lane | Meaning | Conversational Use |
| --- | --- | --- |
| `conversation_recent` | Recent live thread context | Allowed |
| `durable_user_preference` | User preference or durable interpersonal fact | Allowed |
| `conversation_summary` | Accepted summary of prior conversation | Selective |
| `graph_memory` | Graph fact or relationship | Selective |
| `compiled_digest` | Compiled high-level digest | Selective |
| `knowledge_chunk` | Retrieved source chunk | Selective |
| `context_artifact` | Generated artifact overview | Selective |
| `procedural_memory` | How-to procedure or skill memory | Blocked in conversation |
| `routing_history` | Routing outcome/process history | Never prompt-injected as personal memory |
| `outcome_pattern` | Learned outcome pattern | Blocked in conversation, allowed in hybrid/agentic |

## Precedence For Conversation

1. recent conversation
2. durable user preferences
3. accepted summaries
4. directly relevant graph memory
5. directly relevant compiled digest
6. raw knowledge chunks only when explicitly relevant
7. context artifacts only when they summarize selected material

Procedural memory and routing history are not allowed to surface as personal recall in ordinary chat.

## Implementation

The executable contract lives in `src/memory/lanes.ts`. Retrieval traces and prompt assembly traces expose injected lanes so conversational weirdness can be diagnosed from evidence instead of vibes.

