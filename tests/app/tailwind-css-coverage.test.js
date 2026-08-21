// Regression guard for the Tailwind v4 migration (0.7.54): the compiled
// stylesheet must keep styling the utility classes the app's markup and JS
// class-string constants depend on. CI's stale-CSS check only catches an
// un-rebuilt asset — not a class the v4 scanner fails to extract from a JS
// string — so assert the selectors directly.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const css = readFileSync(
  new URL("../../app/vendor/tailwind.css", import.meta.url),
  "utf8",
);

describe("compiled tailwind.css covers migrated utilities", () => {
  it.each([
    ".shadow-xs",
    ".focus\\:outline-hidden",
    ".focus\\:ring-2",
    ".focus\\:ring-sky-400\\/50",
    ".rounded-pill",
    ".text-ink",
    ".text-ink-soft",
  ])("contains selector %s", (sel) => {
    expect(css).toContain(sel);
  });

  it("keeps the preflight gray variables referenced by tailwind.source.css", () => {
    // The v3-parity base layer resolves default border and placeholder colors
    // through these theme variables; v4 only emits them while author CSS
    // references survive its tree-shaking.
    expect(css).toContain("--color-gray-200:");
    expect(css).toContain("--color-gray-400:");
  });
});
