# TODOS

## UI

### Verify Tailwind v4 rendering on the wall-panel browser

**What:** Load the dashboard on the actual wall-mounted tablet / older WebViews and confirm colors render.

**Why:** Tailwind v4 emits all palette colors exclusively as `oklch()` custom properties with no hex fallbacks. Browsers below Chrome/Edge 111, Safari 15.4, or Firefox 113 render the UI without colors — silently. HA dashboards are commonly viewed on old frozen Android WebViews.

**Context:** Introduced by the Tailwind 3→4 migration in v0.7.54. If an affected device turns up, options are a PostCSS fallback pass over `app/vendor/tailwind.css` or pinning that device's browser. A quick eyeball of shadows/focus rings/dark mode on a modern browser is also still outstanding (CSS-level parity was verified, pixels were not).

**Effort:** S
**Priority:** P2
**Depends on:** None

### Migrate the inline `<style>` block in index.html into `@layer components`

**What:** Move the ~200-line unlayered `<style>` block (`.card`, `.form-input`, `.toggle`, …) into a cascade layer below Tailwind's utilities.

**Why:** Since Tailwind v4 puts utilities in `@layer`, unlayered author CSS beats every utility regardless of specificity — future "add a utility to override `.form-input`" edits silently lose unless the `!` important-prefix is used.

**Context:** Flagged by the v0.7.54 adversarial review; current clashes are pre-handled with `!`-prefixed utilities (e.g. `!mt-0` in `ess-tab.js`) and a warning comment now sits at the top of the style block. Migrating means wrapping the block in `@layer components { … }` and re-testing visual parity.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Solver

### Decide the vendored HiGHS WASM build's refresh story

**What:** Establish how `vendor/highs-build/` (the actual runtime LP solver) gets updated, now that the npm `highs` package is removed.

**Why:** The vendored build receives no updates from dependency refreshes; a stale solver is a silent-wrong-results vector long-term, and the Docker image ships it directly.

**Context:** v0.7.54 removed the unused npm `highs` dependency (imported nowhere; the vendored build differs from npm's — verified by hash). Upstream (`bmesuere/optivolt`) may import npm `highs` directly, so future ported commits may need the import path rewritten to the vendored build.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Completed
