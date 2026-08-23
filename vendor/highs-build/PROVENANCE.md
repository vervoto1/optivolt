# HiGHS solver build — provenance

`highs.js` + `highs.wasm` are the **runtime LP/MILP solver** (loaded by
`api/services/planner-service.ts` and the solver tests under `tests/lib/`). They
are vendored binaries: nothing here is produced by `npm install`, and they get
no updates from dependency refreshes. This file records where they came from
and how to replace them. `tests/vendor/highs-build-provenance.test.js` pins the
hashes below, so a swapped binary fails CI until this file is updated with it.

## Current build

| | |
|---|---|
| Source | [`lovasoa/highs-js`](https://github.com/lovasoa/highs-js) @ `98c35cc8071104828e881cadfcfcba034c596411` (2024-12-19, "Increase default STACK_SIZE when compiling highs" = tag `v1.8.0` + 2 commits) |
| HiGHS | [`ERGO-Code/HiGHS`](https://github.com/ERGO-Code/HiGHS) @ `fcfb5341462f8a7db5ef5038613413f97d6cac3d` (2024-10-17, **v1.8.0**) — the `HiGHS` submodule of the commit above |
| Built by | upstream `bmesuere/optivolt` commit `a407213` ("vendor highs.js", 2026-02-25), which also added the `vendor/highs-js` submodule pointing at the source commit |
| `highs.wasm` | sha256 `57c508b92572e056bde89399278ccebf71b1b33dfdcda8fe34d48b491104226b` (2 526 007 bytes) |
| `highs.js` | sha256 `c5b7a9817265a7b01aadbaca9848d217d5e00363f2e6e00c08605b2db57050c8` (25 359 bytes, minified Emscripten `MODULARIZE` wrapper, CommonJS — hence the sibling `package.json`) |

The `vendor/highs-js` git submodule is not checked out in normal development
(it is only the provenance pointer; nothing imports from it) and is excluded
from the add-on image.

## Refresh procedure

The npm `highs` package is the same project's release build: every version
since `v1.14` is built from a commit that includes the stack-size fix the
current build was vendored for, so a refresh **does not need the Emscripten
toolchain** — copy the release artifacts instead.

1. Pick the release: `npm view highs versions` (the package version equals the
   highs-js tag; the bundled HiGHS version is the `HiGHS` submodule of that tag,
   `git ls-tree v<version> HiGHS` in a highs-js clone).
2. Fetch it without installing: `npm pack highs@<version>` and extract the
   tarball; the artifacts are `package/build/highs.js` and
   `package/build/highs.wasm`.
3. Gate it **before** copying anything:
   `npx tsx scripts/compare-highs-builds.ts <extracted>/package/build/highs.js`
   solves the default dataset with both builds and reports status, objective,
   solve time and per-slot plan differences. Run it again against a snapshot of
   the production `DATA_DIR` (`data.json` + `settings.json`) so the gate covers
   the plan that actually runs. Status or objective differences fail the gate;
   differing rows at an equal objective are alternative optima — review them.
4. Copy the two files over `highs.js` / `highs.wasm` (keep `package.json`), run
   the full suite (`npm run test:run` — the `tests/lib/` solver tests exercise
   the real binary), then update the **Current build** table above: source
   commit/tag, HiGHS commit/version, new sha256 hashes, and replace "Built by"
   with the npm version. Move the `vendor/highs-js` submodule pointer to the
   matching tag (or drop the submodule) so the pointer never disagrees with the
   binaries.
5. Ship it as its **own PR**, with the gate output in the description. A solver
   bump changes every plan the add-on writes, so it is never folded into a
   dependency-refresh commit.

## Policy

- **Check at every dependency refresh** (the `chore(deps)` routine) whether a
  newer `highs` release exists; note it in the changelog if one is skipped.
- **Upgrade deliberately, not automatically.** HiGHS releases change presolve,
  MIP heuristics and tolerances; the add-on's plans must be compared, not
  assumed. The gate in step 3 is the minimum evidence.
- **Never edit the artifacts in place.** Patches go upstream (highs-js or
  HiGHS); the vendored files are always a verbatim release.
- Upstream `bmesuere/optivolt` may switch back to importing the npm package
  directly; ported commits then need the import rewritten to
  `../../vendor/highs-build/highs.js`.

## Last evaluated refresh

2026-08-23, npm `highs@1.14.2` (highs-js tag `v1.14.2`, 2026-05-28; HiGHS
`7df0786de3088c832297e5ed821db236d8fab281`): the full suite passed (2689 tests)
and `scripts/compare-highs-builds.ts` produced an identical plan on the default
dataset (objective −57.482223, 0 of 96 rows differ, solve time unchanged).
Not adopted in that release — the gate had not yet been run on a production
data snapshot; it is the obvious first candidate for a dedicated solver-bump PR.
