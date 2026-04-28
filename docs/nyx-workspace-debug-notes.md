# Nyx Workspace Debug Notes

## 2026-04-15: Rate-limit Toast and Hermes Path Leak

### Symptoms

- Chat UI showed `Rate limited — try again in a moment`.
- Chat UI also showed `Failed to send message`.
- Profiles screen showed Hermes profile storage: `~/.hermes/profiles`.
- Terminal sessions could start in `~/.hermes`.

### Root Causes

1. Workspace chat fallback was too expensive.

   When Codex app-server stalled on a lightweight chat turn, the fallback path went
   through normal agent invocation. That re-ran classification and routing before
   sending a small response, which could hit upstream provider rate limits.

2. Hermes workspace filesystem defaults were still active.

   The ripped workspace still had runtime defaults from Hermes:

   - terminal default cwd: `~/.hermes`
   - profiles root: `~/.hermes/profiles`
   - active profile marker: `~/.hermes/active_profile`

3. Profiles were not NyxHive-native.

   The Profiles page was browsing Hermes profiles instead of deriving Nyx/Vortex
   from NyxHive instance config under `~/.nyxhive/instances`.

### Fixes Applied

- Workspace chat Codex timeout now falls back directly to native provider API
  with `openrouter/google/gemini-2.5-flash`, bypassing extra classification.
- Terminal default cwd is now `~/dev/personal/nyxhive`.
- Profiles now use:
  - `~/.nyxhive/profiles` for user-created profiles
  - `~/.nyxhive/instances` for active NyxHive instance profiles
- Profiles now show:
  - `Nyx` from `NyxAI`
  - `Vortex` from `NyxLabs`
- Existing Hermes/Nyx avatar image remains the default profile visual.

### Verification

- `GET /api/profiles/list` returns active `Nyx` and `Vortex`.
- Workspace chat smoke send returns streamed chunks and `done`.
- Existing stale terminal session rooted at `~/.hermes` was killed during restart.

