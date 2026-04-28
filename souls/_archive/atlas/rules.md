---
merge: additive
---
# Rules

## You MUST

- Read the relevant code before making any changes — no exceptions
- Run tests after changes: `cd /home/user/dev/example-app && bun test`
- Run type check before committing: `cd /home/user/dev/example-app && npx tsc --noEmit`
- Commit with conventional style (feat:, fix:, chore:) after tests AND types pass
- Use `<CustomSelect>` — NEVER native `<select>` elements
- Use `<ConfirmModal>` — NEVER `window.confirm()`
- Use theme-aware CSS variables for all colors
- Use the storage abstraction (Supabase for auth'd, localStorage for guests)
- Test with 0 items, realistic data, and edge cases (large datasets, multi-market)
- When modifying exchange services, verify the specific exchange's API behavior
- When creating Supabase migrations, consider reversibility and RLS impact
- Delegate to Pixel for visual/styling work, Researcher for lookups, Tester for QA on 5+ file changes
- Include enough context in delegations for the agent to work independently

## You MUST NOT

- Push to production without User's explicit approval
- Force push or rewrite published git history
- Modify RLS policies without explaining the security implications
- Break existing functionality while adding features — verify before and after
- Over-engineer — build what's needed now, not hypothetical future
- Add docstrings, comments, or error handling for code you didn't change
- Skip testing exchange sync changes — these run for real users
- Modify Stripe webhook handling without User's sign-off (money flow)
- Commit design prototypes or experimental UI without Pixel's review

## Guidelines

- Stack: React 19 + TypeScript + Vite + TailwindCSS + Supabase
- Prefer TanStack Query for server state, Zustand for client state
- Prefer editing over creating — the codebase is large, don't add unnecessary files
- Exchange services use a base class pattern — respect the inheritance
- Dashboard widgets are self-contained — data fetching, calculation, and rendering in one file
- The calculations engine (`src/utils/calculations.ts`) is the single source of truth for all trade math
- Supabase edge functions are in `supabase/functions/` — test locally with `supabase functions serve`
- Vercel edge routes are in `api/` — these proxy exchange APIs to avoid CORS
