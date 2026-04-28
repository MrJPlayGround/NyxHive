# Gateway UI Theme Refresh Handoff For Opus 4.6

Date: 2026-04-11
Owner: User / NyxHive
Audience: Opus 4.6
Status: ready for frontend implementation

## Why This Exists

User is tired of the gateway being mostly blue. The gateway also has several frontend surfaces that are functionally useful now, but visually and structurally still feel uneven after the recent backend and control-page work.

This handoff is for a NyxHive-native frontend pass. Do not clone Morph or OpenClaw. Use them only as references for operator clarity. The result should still feel like NyxHive, but with more visual choice, better hierarchy, and less blue fatigue.

## Current State

Relevant files:

- `src/gateway/src/index.css`
- `src/gateway/src/stores/ui-prefs.ts`
- `src/gateway/src/components/Layout.tsx`
- `src/gateway/src/pages/Settings.tsx`
- `src/gateway/src/pages/Home.tsx`
- `src/gateway/src/pages/Chat.tsx`
- `src/gateway/src/pages/Cockpit.tsx`
- `src/gateway/src/pages/ControlStation.tsx`
- `src/gateway/src/pages/System.tsx`
- `src/gateway/src/components/chat/MessageList.tsx`
- `src/gateway/src/components/chat/MessageInput.tsx`
- `src/gateway/src/components/home/InstanceHeader.tsx`
- `src/gateway/src/components/cockpit/InstanceRail.tsx`

The gateway already has semantic CSS variables in `src/gateway/src/index.css`:

```css
--nyx-bg
--nyx-panel
--nyx-panel-2
--nyx-panel-hover
--nyx-text
--nyx-text-secondary
--nyx-muted
--nyx-accent
--nyx-accent-dim
--nyx-accent-glow
--nyx-accent-2
--nyx-accent-2-dim
--nyx-danger
--nyx-danger-dim
--nyx-warn
--nyx-warn-dim
--nyx-line
--nyx-line-strong
```

The problem: many components still hard-code the blue palette with values like:

- `rgba(106,173,255,...)`
- `rgba(139,196,255,...)`
- `#6aadff`
- `#8bc4ff`
- `text-blue-*`
- `border-blue-*`
- gradients that assume blue

So a theme selector alone will not be enough. The implementation needs a tokenization cleanup pass.

## Product Goals

1. Add more than one available gateway theme.
2. Keep the default theme close to the current NyxHive look for users who like it.
3. Add at least two non-blue themes that are genuinely usable for long sessions.
4. Persist theme preference in the existing UI prefs store.
5. Make the theme apply to the full gateway: nav, Home, Chat, Cockpit, Control, System, Settings, cards, focus rings, traces, badges, and markdown.
6. Reduce hard-coded color drift so future UI work does not keep reintroducing blue.
7. Improve the most obvious UI rough edges while doing the token pass.

## Non-Goals

- Do not redesign the product from scratch.
- Do not make a landing page.
- Do not add marketing copy.
- Do not add decorative orbs, bokeh blobs, or gradient blob backgrounds.
- Do not introduce a dominant purple, beige, tan, brown, orange, or dark-blue/slate theme.
- Do not make the gateway a Morph clone.
- Do not bury the actual control/chat surfaces behind a pretty shell.
- Do not put the main Chat, Cockpit, Control, or System surfaces inside decorative card frames.

## Theme Direction

Implement a small theme set first. Suggested themes:

1. `aether`
   - Current blue-ish NyxHive default.
   - Keep for continuity.
   - Rename in UI as `Aether`.

2. `signal`
   - Neutral black/graphite base with mint or green accent.
   - Primary accent example: `#64d69a`.
   - Secondary accent example: `#a7f3c5`.
   - This should feel operational and calm, not cyber-green everywhere.

3. `emberless`
   - Neutral black/charcoal base with coral/red-pink accent.
   - Primary accent example: `#ff7a8a`.
   - Secondary accent example: `#ffc0c7`.
   - Avoid making it orange or brown.
   - Keep warning/danger semantics distinct from the theme accent.

4. Optional `mono`
   - High-contrast black/near-white with restrained accent.
   - Useful for late-night debugging and screenshots.
   - Keep status colors readable.

If four themes is too much for first pass, ship three: `Aether`, `Signal`, `Emberless`.

## Theme Architecture

Add a typed theme preference to `src/gateway/src/stores/ui-prefs.ts`:

```ts
export type GatewayTheme = "aether" | "signal" | "emberless" | "mono";

interface UiPrefs {
  theme: GatewayTheme;
  setTheme: (theme: GatewayTheme) => void;
  ...
}
```

Apply the theme at the document root. Suggested pattern:

- Add a small component or hook near `Layout` or `main.tsx`.
- Read `theme` from `useUiPrefs`.
- Set `document.documentElement.dataset.theme = theme`.
- Keep `html` class `dark`; do not introduce a light-mode pass yet.

Example:

```ts
useEffect(() => {
  document.documentElement.dataset.theme = theme;
}, [theme]);
```

Then define CSS variable overrides:

```css
:root,
:root[data-theme="aether"] {
  --nyx-accent-rgb: 106 173 255;
  --nyx-accent-2-rgb: 139 196 255;
  --nyx-accent: rgb(var(--nyx-accent-rgb));
  --nyx-accent-2: rgb(var(--nyx-accent-2-rgb));
  --nyx-accent-dim: rgb(var(--nyx-accent-rgb) / 0.10);
  --nyx-accent-glow: rgb(var(--nyx-accent-rgb) / 0.08);
  --nyx-accent-2-dim: rgb(var(--nyx-accent-2-rgb) / 0.08);
}

:root[data-theme="signal"] {
  --nyx-accent-rgb: 100 214 154;
  --nyx-accent-2-rgb: 167 243 197;
  --nyx-accent: rgb(var(--nyx-accent-rgb));
  --nyx-accent-2: rgb(var(--nyx-accent-2-rgb));
  --nyx-accent-dim: rgb(var(--nyx-accent-rgb) / 0.11);
  --nyx-accent-glow: rgb(var(--nyx-accent-rgb) / 0.08);
  --nyx-accent-2-dim: rgb(var(--nyx-accent-2-rgb) / 0.08);
}
```

Use RGB triplets because many existing classes use alpha. This lets Tailwind arbitrary values move from:

```tsx
"bg-[rgba(106,173,255,0.12)]"
```

to:

```tsx
"bg-[rgb(var(--nyx-accent-rgb)/0.12)]"
```

Do this broadly enough that switching themes is visible everywhere.

## Theme Picker UX

Add a new `Appearance` settings tab, or add an `Appearance` section inside the current Settings page. Preferred:

- Settings tab id: `appearance`
- Label: `Appearance`
- Icon: `Palette` from `lucide-react`

Content:

- A compact theme chooser using buttons or radio cards.
- Each theme option should show name, short operational label, and 2-3 swatches.
- No marketing copy.
- Example labels:
  - `Aether` - current blue signal
  - `Signal` - mint operator accent
  - `Emberless` - coral operator accent
  - `Mono` - high contrast

Also add a small quick selector in the sidebar footer or command palette only if it stays unobtrusive. Settings is enough for first pass.

## UI Surfaces That Need Work

### 1. Global Theme Token Cleanup

Start with `src/gateway/src/index.css` and remove direct blue from utilities:

- `.text-shimmer`
- `.glow-accent`
- `.text-gradient`
- `.sidebar-gradient`
- `.ambient-mesh`
- `.ambient-mesh::before`
- `.border-gradient-top::before`
- `.transaction-surface`
- `.prose-chat th`
- `.prose-chat input[type="checkbox"]`

These should use `--nyx-accent`, `--nyx-accent-2`, and RGB alpha vars.

Acceptance:

- Switching themes changes shimmer text, active nav, focus rings, live dots, panel glows, table headers, and chat accents.
- `rg "106, 173, 255|106,173,255|139, 196, 255|139,196,255|#6aadff|#8bc4ff" src/gateway/src` should return zero or only documented fallback comments.

### 2. Tailwind Blue Class Cleanup

Search for:

```bash
rg "blue-" src/gateway/src
```

Known areas:

- `src/gateway/src/pages/ActivityFeed.tsx`
- `src/gateway/src/pages/Work.tsx`
- `src/gateway/src/pages/ThreadDetail.tsx`
- `src/gateway/src/pages/Agents.tsx`
- `src/gateway/src/pages/Scheduler.tsx`
- `src/gateway/src/pages/Traces.tsx`
- `src/gateway/src/pages/Models.tsx`
- `src/gateway/src/components/proposals/KanbanCard.tsx`
- `src/gateway/src/components/proposals/ProposalDetail.tsx`

Replace generic blue UI accents with semantic variables. Keep blue only if it means a specific external brand or status, not "the UI accent".

### 3. Home Page

Home is functional but reads a bit flat:

- Instance header still uses a blue gradient avatar via `from-[var(--nyx-accent)] to-[var(--nyx-accent-2)]`, which is fine if tokens work.
- `text-shimmer` should be theme-aware.
- Needs Attention is useful and should stay prominent.
- Consider making Home's information order a little more operator-first:
  - Status header
  - Needs Attention
  - Active/running work
  - Recent activity
  - Stats as support, not the main event

Do not add a hero. Home should remain a control surface.

### 4. Chat Page

Recent backend/frontend work improved the chat runtime UI, but the visual tone still leans too much on the same blue accent.

Theme pass should cover:

- live bar
- trace toggle
- reasoning block
- assistant bubble border
- user bubble background
- command menu active item
- model selector focus ring
- markdown table headers and code copy buttons

Also keep the recent safety fixes:

- markdown media must stay constrained
- raw inline layout controls must stay stripped
- long paths and labels must stay truncated
- mobile composer must not overflow

Regression checks to preserve:

```bash
bun test src/gateway/src/components/chat/Markdown.test.ts src/gateway/src/components/chat/message-execution.test.ts src/gateway/src/stores/fleet-chat.test.ts
```

### 5. Cockpit

Cockpit is useful, but visually it is close to Chat and can feel like a second Chat page. Use theme work to make it feel like fleet operations:

- Keep `InstanceRail` compact.
- Theme the selected instance state and request badges.
- Avoid huge cards or preview frames around the main conversation.
- Make disabled/unauthenticated instances visually clear without turning the whole rail into warning color.

Do not implement new fleet backend behavior in this pass.

### 6. Control / Logs / Audit

User previously noticed confusion between "Activity - system-wide audit trail" and Control's "Audit Explorer". This is partly information architecture and partly copy.

Recommended:

- Keep `/control` as the operator control surface: logs + audit + provider usage + core task health.
- Keep `/logs` as raw log browsing if it exists, or make it clearly "Logs".
- Avoid having two pages that both say "audit trail" unless one is explicitly scoped.
- Rename labels if needed:
  - Control page section: `Audit Explorer`
  - Activity page title: `Activity`
  - Activity subtitle: `Recent system events`

The theme pass should make Control readable in all themes, especially log rows and level filters.

### 7. Settings

Settings is the natural home for Appearance:

- Add `Appearance` tab.
- Make the tab layout stable on mobile.
- Avoid nested card-in-card styling.
- Theme previews should be simple swatches, not a fake mini dashboard.

### 8. Status Colors

Do not theme status semantics into ambiguity:

- `ok` can stay emerald/green.
- `warn` stays yellow.
- `error` stays red.
- Theme accent should not replace warn/error.

If using `signal` green accent, make `ok` and accent distinguishable:

- OK dot can use emerald.
- Accent can be mint but should be lighter or cooler.
- Warnings still yellow.

## Suggested Implementation Plan

1. Add `theme` to `useUiPrefs`.
2. Add a tiny `ThemeProvider` or `ThemeSync` component and mount it once near `Layout` or `App`.
3. Add CSS theme definitions in `index.css`.
4. Convert global CSS hard-coded blue utilities to theme variables.
5. Add Settings > Appearance with a theme selector.
6. Convert high-visibility components first:
   - `Layout`
   - `Home`
   - `Chat`
   - `MessageList`
   - `MessageInput`
   - `ControlStation`
   - `Cockpit`
7. Convert remaining obvious `blue-*` Tailwind classes.
8. Run visual smoke checks on at least:
   - `/`
   - `/chat`
   - `/cockpit`
   - `/control`
   - `/settings?tab=appearance`
   - `/settings?tab=system`
9. Run tests/build.

## Code Patterns To Prefer

Prefer:

```tsx
"bg-[var(--nyx-accent-dim)] text-[var(--nyx-accent)]"
```

Prefer for alpha variants:

```tsx
"border-[rgb(var(--nyx-accent-rgb)/0.24)] bg-[rgb(var(--nyx-accent-rgb)/0.10)]"
```

Avoid:

```tsx
"bg-[rgba(106,173,255,0.12)]"
"text-blue-400"
"border-blue-500/30"
```

For component props that currently accept color strings, pass CSS variables instead of concrete blue values where possible.

## Suggested Theme Tokens

These are starting points. Adjust after looking at the actual UI.

```css
:root,
:root[data-theme="aether"] {
  --nyx-bg: #080c12;
  --nyx-panel: rgba(12, 18, 28, 0.88);
  --nyx-panel-2: rgba(8, 13, 22, 0.95);
  --nyx-panel-hover: rgba(22, 34, 52, 0.85);
  --nyx-text: #e8eef6;
  --nyx-text-secondary: #a8b8cc;
  --nyx-muted: #5e7186;
  --nyx-accent-rgb: 106 173 255;
  --nyx-accent-2-rgb: 139 196 255;
}

:root[data-theme="signal"] {
  --nyx-bg: #070b0a;
  --nyx-panel: rgba(12, 20, 17, 0.90);
  --nyx-panel-2: rgba(7, 13, 11, 0.96);
  --nyx-panel-hover: rgba(20, 34, 28, 0.86);
  --nyx-text: #eaf4ee;
  --nyx-text-secondary: #b5c9bd;
  --nyx-muted: #698072;
  --nyx-accent-rgb: 100 214 154;
  --nyx-accent-2-rgb: 167 243 197;
}

:root[data-theme="emberless"] {
  --nyx-bg: #0c080a;
  --nyx-panel: rgba(22, 13, 16, 0.90);
  --nyx-panel-2: rgba(13, 8, 10, 0.96);
  --nyx-panel-hover: rgba(40, 22, 27, 0.86);
  --nyx-text: #f5ecef;
  --nyx-text-secondary: #d2b8c0;
  --nyx-muted: #8a6670;
  --nyx-accent-rgb: 255 122 138;
  --nyx-accent-2-rgb: 255 192 199;
}

:root[data-theme="mono"] {
  --nyx-bg: #070707;
  --nyx-panel: rgba(18, 18, 18, 0.92);
  --nyx-panel-2: rgba(10, 10, 10, 0.98);
  --nyx-panel-hover: rgba(34, 34, 34, 0.90);
  --nyx-text: #f2f2f2;
  --nyx-text-secondary: #c8c8c8;
  --nyx-muted: #7a7a7a;
  --nyx-accent-rgb: 214 214 214;
  --nyx-accent-2-rgb: 255 255 255;
}

:root,
:root[data-theme] {
  --nyx-accent: rgb(var(--nyx-accent-rgb));
  --nyx-accent-2: rgb(var(--nyx-accent-2-rgb));
  --nyx-accent-dim: rgb(var(--nyx-accent-rgb) / 0.10);
  --nyx-accent-glow: rgb(var(--nyx-accent-rgb) / 0.08);
  --nyx-accent-2-dim: rgb(var(--nyx-accent-2-rgb) / 0.08);
}
```

## Accessibility And Layout Requirements

- Theme buttons must be keyboard reachable.
- Current theme must be visible through text and not color alone.
- Focus ring must remain visible on every theme.
- Contrast should be acceptable on nav, cards, log rows, and chat messages.
- Text must not overflow on mobile.
- Do not use viewport-width font scaling.
- Do not use negative letter spacing.
- Keep card/button radius at 8px or less unless a local component already requires otherwise.
- Avoid layout shifts when theme changes.

## Verification

Run:

```bash
cd src/gateway && bun run build
bun test src/gateway/src/components/chat/Markdown.test.ts src/gateway/src/components/chat/message-execution.test.ts src/gateway/src/stores/fleet-chat.test.ts
```

Also run:

```bash
rg "106, 173, 255|106,173,255|139, 196, 255|139,196,255|#6aadff|#8bc4ff" src/gateway/src
rg "blue-" src/gateway/src
```

The first command should be near-zero. The second may have a few valid semantic leftovers, but most UI accent usages should be gone.

Manual smoke:

- Switch each theme in Settings.
- Refresh the page and confirm the theme persists.
- Open `/chat` and verify assistant/user bubbles, markdown, trace rail, and composer are themed.
- Open `/cockpit` and verify selected instance, request badges, and focus surface are themed.
- Open `/control` and verify logs/audit filters are readable.
- Open `/settings?tab=system` and verify OK/warn/error colors remain semantically correct.
- Test mobile width around 390px.

## Acceptance Criteria

- Gateway has at least 3 selectable themes: current/default plus 2 non-blue options.
- Theme persists across reloads.
- Theme applies globally, not just Settings.
- The obvious blue hard-codes are tokenized.
- Chat media containment and markdown sanitizer behavior remain intact.
- Status colors remain semantically clear.
- Build passes.
- Focused chat tests pass.
- The resulting UI does not read as one-note blue anymore.

