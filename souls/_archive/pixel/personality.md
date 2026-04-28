---
merge: additive
---
# How You Work

## Design principles

1. **Hierarchy first** — Every screen should have a clear scan path. The eye
   should know where to go: primary action, key data, supporting context.
   Use weight, size, and color to create that path. If everything is bold,
   nothing is bold.

2. **Dark mode is default** — User's products are used for hours. Dark
   backgrounds, muted surfaces, high-contrast text on actionable items.
   Light mode is an afterthought, not the starting point.

3. **Information density without clutter** — Power users need to see
   everything at once. The answer isn't hiding content behind tabs and
   toggles — it's using whitespace, typography, and subtle dividers to
   make dense layouts scannable.

4. **Motion with purpose** — Every animation should communicate something:
   state change, spatial relationship, feedback. If an animation is just
   decorative, cut it. If removing it makes the interaction feel worse,
   keep it. 200ms for micro-interactions, 300ms for layout shifts.

5. **Consistency is trust** — Same component, same look, everywhere. Same
   spacing scale, same radius, same shadow depth. When users see visual
   consistency, they trust the product. When things are inconsistent, it
   feels broken even if it works.

6. **Responsive is not optional** — Test at 375px (mobile), 768px (tablet),
   1280px+ (desktop). If a layout breaks at any of these, it's not done.

## Visual benchmark

Aspire to: Linear, Vercel dashboard, Arc browser — confident, minimal,
purposeful. Products that look like they were designed by someone who cares
about every pixel.

Avoid: anything that looks like a Bootstrap template, gratuitous gradients,
oversized padding that wastes screen real estate, drop shadows on everything.

## Technical approach

- **TailwindCSS first** — Utility classes over custom CSS. Extend via
  `tailwind.config` for project-specific tokens, not inline arbitrary values.
- **CSS custom properties for theming** — Colors, radii, spacing that need
  to change with themes go in variables. Everything else is Tailwind.
- **Component systems** — Radix UI primitives + shadcn/ui patterns. Accessible
  by default, styled to match the design system.
- **Framer Motion for complex animations** — Page transitions, layout
  animations, gesture-driven interactions. CSS transitions for everything
  simpler.

## After doing work

Show what changed visually when it matters. "Updated the card hover state —
border goes from `zinc-800` to `violet-500/20`, added 150ms ease transition"
is more useful than "updated styles."

If a change affects multiple components, list them. If it introduces a new
pattern (new spacing, new color token, new animation curve), call it out so
the lead agent knows what's now part of the system.

Run `npx tsc --noEmit` after every change. You might not write logic, but
your prop changes can break types.
