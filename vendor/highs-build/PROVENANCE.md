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
| Source | [`lovasoa/highs-js`](https://github.com/lovasoa/highs-js) @ `96981da1d88bbf657d81f7f3027377ba6a7e81bf` (2026-09-11, "Release v1.15.3" = tag `v1.15.3`) |
| HiGHS | [`ERGO-Code/HiGHS`](https://github.com/ERGO-Code/HiGHS) @ `04024d701f79feb8e2f18bc3df0dffc04ef05088` (2026-07-02, **v1.15.1**) — the `HiGHS` submodule of the tag above |
| Built by | upstream release build: npm `highs@1.15.3` (published 2026-09-11, tarball sha1 `516181f8c1c6fd0c7d8698073e01f3e07671a82a`), `package/build/` copied verbatim |
| `highs.wasm` | sha256 `528be4365bea1d4188988646b244263f50320df55782e14d6af5bce7cd45c840` (3 531 385 bytes) |
| `highs.js` | sha256 `0bd23843c9795753f2276e9901eb2a1e66288547b6bcba84fa0665dc037b5c7c` (168 432 bytes, Emscripten `MODULARIZE` wrapper, CommonJS — hence the sibling `package.json`) |

Previous build, for rollback (`git checkout 3fe075e -- vendor/highs-build`, the v0.7.56 commit):
highs-js `98c35cc8071104828e881cadfcfcba034c596411` (v1.8.0 + the stack-size
fix) bundling HiGHS v1.8.0, `highs.wasm` sha256 `57c508b9…04226b`.

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

2026-09-19, npm `highs@1.15.3` (HiGHS v1.15.1) — **adopted**, replacing the
v1.8.0 build. `scripts/compare-highs-builds.ts`, old build vs new, on the
default dataset and ten perturbed variants of it (initial SoC 12/45/97 %,
reversed prices, negative/spiky export prices, PV ×4, no PV with load ×2.5,
2 h rebalance window, 15 kW discharge, `avg` terminal valuation): status
Optimal and an identical objective to 6 decimals in all eleven. Rows differ by
at most 0.05 W / Wh, which is the *old* wrapper reporting primals rounded to six
significant digits (`2105.260` where 1.15 reports `2105.263`), not a different
plan. The full suite passes after one test fix: `discharge-phase-soc` compared
SoC to a threshold with a strict `<` on a double, and 1.15 reports the
knife-edge slot as 2499.9999999999995 Wh where 1.8 printed 2500 (same plan on
both builds). Solve time with the planner's MIP options (x86-64, Node 22, warm):
default dataset 33 → 36 ms, 2 h rebalance 127 → 149 ms, and a 192-slot
CV-phase + rebalance MILP 320 ms → 1.13 s — 1.15 is 10–15 % slower on
day-ahead plans and ~3.5× slower on the largest MILP tried, at an equal
objective. The gate was **not** run on a production `DATA_DIR` snapshot —
none was available on the dev box; see the PR for the one-liner to run it.
