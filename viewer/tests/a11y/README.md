# Accessibility tests

Three layers, all gated on `npm run test:a11y`:

1. **`landing.axe.spec.ts`** runs axe-core against the rendered landing page
   in initial and post-interaction states. It catches WCAG rule violations.
2. **`landing.tree.spec.ts`** pins focused Chrome ARIA tree snapshots for
   structural regressions. Update snapshots with
   `npx playwright test --update-snapshots`.
3. **`equation-reading.spec.ts`** drives `@guidepup/virtual-screen-reader`
   against the live DOM. It verifies equations are read as math, not LaTeX,
   and that the demo viewer does not stack two live-region announcements.

## Not covered here

- **Real NVDA, JAWS, or VoiceOver behavior.** The virtual screen reader is a
  model. It catches the announce-order class of bugs but cannot catch an
  NVDA Browse Mode regression, a MathCAT addon version issue, or a
  JAWS-on-Edge quirk. The plan for that gap is a quarterly Fable session
  (https://www.makeitfable.com) before each minor release.
- **Forms, dashboard, and login.** Those surfaces are out of scope until they
  are re-audited. Add `dashboard.axe.spec.ts` etc. following the same pattern.

## When a test fails

- **Axe violation:** fix the source. Do not silence rules.
- **ARIA snapshot diff:** read the diff. If the change is intentional and the
  new shape is correct, run `--update-snapshots` and commit. If the change is
  unintentional, fix the source.
- **Virtual SR test:** investigate before weakening the assertion. The most
  common cause is a KaTeX hydration race; wait for the rendered MathML before
  reading the DOM.
