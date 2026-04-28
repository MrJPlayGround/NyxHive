# Changelog

All notable changes to NyxHive are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Delegation contracts** — structured extraction of file paths, verification hints, output expectations, and exclude patterns from delegation envelopes. Heuristic-based (zero LLM cost). Backward compatible envelope format.
- **Delegation quality hooks** — enriched envelopes, verification hints, session persistence for delegated tasks.
- **Per-message SSE streaming** — real-time streaming endpoint and delegation event emission.
- **DB indexes and WAL verification** — SQLite performance indexes on hot tables, WAL mode check, idempotency guard on message inserts.
- **SQLite backup/export system** — on-demand and scheduled database backups.
- **Subagent working memory** — last 5 completed task entries per agent (task summary, result, timestamp, files touched) stored in SQLite, injected into agent context.
- **Security guardrails** — 6-layer defense: credential vault with env sanitization, command guard (blocked/approval/allowed tiers), delegation guard with trust levels, path traversal hardening, stricter auth rate limiting, admin endpoint lockdown in insecure mode.
- **Audit log security events** — extended audit log with security-specific event types.
- **Output quality rules** — soul baseline now includes output quality directives.
- **Real-time streaming UX** — lower thresholds, tool activity emission, final text inclusion.
- **Context propagation** — Nyx read access and Claude Code parity for context handling.
- **Defensive shutdown** — graceful shutdown with PID management, orphaned process cleanup, SIGHUP warning.
- **Auto-review gate** — post-coding LLM review for coder delegations: captures git diff, runs cheap review (PASS/WARN/FAIL), appends verdict to delegation result.
- **Proposal PR pipeline** — auto-create GitHub PR when proposal execution completes. `POST /api/proposals/:id/create-pr` endpoint. `setPrUrl` store method and `createPrForBranch` utility.
- **Soul-driven per-agent CLAUDE.md** — per-agent CLAUDE.md and CWD override driven by soul config.
- **Cost-based context control** — replaced turn cap with cost-based context control for Forge.
- **Comprehensive test coverage** — unit tests for proposals/notifications, memory/feedback, scheduler/cron, development planner.

### Changed
- **Processor decomposition** — extracted `DelegationEngine` (-730 lines), `ManagementActionExecutor` (-422 lines), and `ConversationManager` from the monolithic processor.
- **Agent team trim** — reduced from 7 to 4 active agents (Nyx, Forge, Tester, Analyst).
- **Dashboard migration** — nyx-office migrated from npm to bun.
- **Default agent timeout** — raised from 10 minutes to 30 minutes.
- **Orchestrator enforcement** — SDK-only invocation for orchestrators, stripped SDK tools, added orchestrator to MUST_DELEGATE list.
- **Streaming throttle** — Discord and Telegram text edits throttled to 3-second intervals.
- **Credential sanitization** — credentials scrubbed from learning system output.

### Fixed
- Strip SDK tools for orchestrators to prevent self-execution.
- Persist `timeout_ms` through agent registry round-trip.
- Suppress short interim text during multi-turn CLI sessions.
- Remove live text streaming from Discord/Telegram (replaced by throttled edits).
- Skip follow-up escalation for status questions.
- Teach Nyx to deliver complete work products, not conversations.
- Wrap raw `JSON.parse` calls in try/catch across codebase.
- Route proposal execution to Forge for code categories (was incorrectly going to Nyx).
- Emit `proposal:rejected` event from API reject route.
- Heartbeat daily-review broken output from MiniMax tool hallucination.
- Pre-fetch briefing data server-side and raise orchestrator turn cap.
- Strip `CLAUDECODE` env var to allow agent spawning from Claude Code session.
- Enforce read-only tools for orchestrators on CLI path.
- `--tools` enforcement for agent tool restriction.
- Proposal verdict extraction, review prompt, and PR URL handling.
- Replace vague `@learn` instructions with concrete syntax and examples in souls.

### Security
- Path validation hardened against traversal attacks.
- Admin endpoints blocked when running without auth.
- Stricter rate limiting on auth endpoints.
- Credential vault audit logging.
