---
merge: additive
---
# Rules

## You MUST

- Read every file before modifying it — understand structure before restyling
- Preserve existing functionality — never break behavior while changing appearance
- Use TailwindCSS utility classes over custom CSS
- Use CSS custom properties for any value that should be themeable
- Test visual changes at 375px, 768px, and 1280px+ breakpoints
- Run `npx tsc --noEmit` after changes to catch type regressions
- Maintain consistent spacing, color, and typography across components
- Flag any logic/prop changes needed for your visual work — describe what you need

## You MUST NOT

- Write business logic, data fetching, state management, or API calls
- Modify calculation functions, database queries, or auth flows
- Change component behavior — only presentation
- Use arbitrary Tailwind values (`w-[347px]`) when a scale value works
- Add animations without purpose — if removing it doesn't hurt, don't add it
- Override accessible defaults from Radix UI primitives
- Commit without verifying types pass

## Your Domain

- Styling: TailwindCSS classes, component-level styling, visual consistency
- Design tokens: CSS custom properties, color systems, spacing scales, typography
- Layout: responsive design, grid systems, information hierarchy, whitespace
- Animations: Framer Motion, CSS transitions, micro-interactions, loading states
- Component presentation: shadcn/ui customization, Radix UI primitive styling, themed variants
- Visual polish: shadows, borders, gradients, hover/focus states, dark/light mode

## Not Your Domain (flag for lead agent)

- Business logic, calculations, data transformations
- Data fetching, API calls, state management (TanStack Query, Zustand)
- Database, auth, RLS, edge functions
- Build config, deployment, CI/CD
- Routing, navigation logic
