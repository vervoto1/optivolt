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
| Source | [`lovasoa/highs-js`](https://github.com/lovasoa/highs-js) @ `873198322c76781c26066f6997c752ea13ff59ef` (2026-11-19, "Merge pull request #59 from lovasoa/fix" = tag `v1.16.0`) |
| HiGHS | [`ERGO-Code/HiGHS`](https://github.com/ERGO-Code/HiGHS) @ `f3f113d230429a8c0014b12ab0dd1a3847e58c55` (2026-11-11, **v1.16.0**) — the `HiGHS` submodule of the tag above |
| Built by | upstream release build: npm `highs@1.16.0` (published 2026-11-20, tarball sha1 `3d1222116ee168cc5ea29b81a6826ac56ac01e50`), `package/build/` copied verbatim |
| `highs.wasm` | sha256 `69a85477acde13876c8fe83357959724e795abdfd144af0531f920d41b5f813e` (3 985 864 bytes) |
| `highs.js` | sha256 `4e21caba96b452eb70c7796779082b7997727850a468d8ce5b0a3ee82e030e6e` (168 538 bytes, Emscripten `MODULARIZE` wrapper, CommonJS — hence the sibling `package.json`) |
| License | MIT ("Copyright (c) 2023 highs-js / Copyright (c) 2026 HiGHS"): `LICENSE` is `package/LICENSE` of the same tarball, verbatim. It ships with the binaries in the add-on image. HiGHS lists the licenses of code it bundles in its [`THIRD_PARTY_NOTICES.md`](https://github.com/ERGO-Code/HiGHS/blob/f3f113d230429a8c0014b12ab0dd1a3847e58c55/THIRD_PARTY_NOTICES.md) |

Previous build, for rollback (`git checkout 3a03504 -- vendor/highs-build`, the v0.7.84 commit):
npm `highs@1.15.3` (highs-js `96981da1…`) bundling HiGHS v1.15.1, `highs.wasm`
sha256 `528be436…45c840`. The one before it, HiGHS v1.8.0 (`highs.wasm`
`57c508b9…04226b`), is in `3fe075e` (v0.7.56).

The source commits above are the whole provenance record. There used to be a
`vendor/highs-js` git submodule pointing at the same commit; it was removed
because nothing imported it and Home Assistant Supervisor runs
`git submodule update --init --recursive` on every add-on store refresh, which
pulled highs-js *and* its nested HiGHS repository onto every HA host.

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
   `package/build/highs.wasm`, and the license is `package/LICENSE`.
3. Gate it **before** copying anything:
   `npx --no-install tsx scripts/compare-highs-builds.ts <extracted>/package/build/highs.js`
   solves the default dataset with both builds and reports status, objective,
   solve time and per-slot plan differences. Run it again against a snapshot of
   the production `DATA_DIR` (`data.json` + `settings.json`) so the gate covers
   the plan that actually runs — `scripts/prod-solver-gate.sh <addon-host>`
   fetches the snapshot from the running add-on (or takes the two files) and
   compares against the build of a given commit (`REF=`), so it also works
   after the swap. Status or objective differences fail the gate;
   differing rows at an equal objective are alternative optima — review them.
   The gate builds the config through the planner's own `buildPlannerConfig`
   (prediction adjustments, then the learned charge taper in adaptive-learning
   auto mode). The calibration is not in `data.json`, so host mode also fetches
   `GET /plan-accuracy/calibration` (the persisted calibration, verbatim). The
   adjustments come from `data.json` (the gate prunes expired ones itself);
   `GET /predictions/adjustments` is not used because it rewrites `data.json` on
   the server when an adjustment has expired. With files, pass the add-on's
   `calibration.json` (and `ev-calibration.json`) after the two files
   (`compare-highs-builds.ts --calibration <file>`). Without a calibration
   snapshot a box in auto mode is solved **uncalibrated** and the gate prints a
   warning. It never reads the local `DATA_DIR`, and it has no live EV state,
   so EV charging is not planned.
4. Copy the two files over `highs.js` / `highs.wasm` and `package/LICENSE` over
   `LICENSE` (keep `package.json`), run
   the full suite (`npm run test:run` — the `tests/lib/` solver tests exercise
   the real binary), then update the **Current build** table above: source
   commit/tag, HiGHS commit/version, new sha256 hashes, and replace "Built by"
   with the npm version.
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

2026-11-21, npm `highs@1.16.0` (HiGHS v1.16.0) — **adopted**, replacing
`highs@1.15.3` (HiGHS v1.15.1). HiGHS 1.16 rewrites the LP file reader (invalid
files are now rejected instead of read as a different model), runs presolve as
an initial low-cost sweep plus a `presolve_mode` option, and changes MIP
defaults and many presolve/MIP correctness details. The planner's LP strings
parse unchanged. highs-js 1.16 has one behaviour change that reaches us: when
there is no primal solution, `solve()` now returns the columns **without**
`Primal` values instead of zeros. `parseSolution`'s finite-objective and finite
`soc_t` checks already reject that; the real-solver time-limit test was updated
to pin the new shape.

All gates with the planner's options (x86-64, Node 26.13.1), 1.15.3 vs 1.16.0:

- **Default dataset** (`compare-highs-builds.ts`): identical plan, objective
  −57.079373 on both.
- **Production snapshot** (`scripts/prod-solver-gate.sh <addon-host>`, 116 slots,
  MILP, adaptive-learning calibration applied, EV not planned): identical plan,
  objective −516.802593 on both, for the full stored horizon and from the current
  slot; 73 → 70 ms.
- **Six variants of that snapshot** (initial SoC 12 % and 100 %, reversed prices,
  PV ×4, `avg` terminal valuation, rebalance enabled with a 2 h hold): five give
  identical plans. The rebalance one is an alternative optimum inside the
  planner's MIP gap (0.5 % = 2.55 c): 1.16 finds a 1.42 c cheaper plan
  (−511.788851 vs −510.370138) and differs in 94 rows, but takes 2.75 s
  instead of 1.55 s (repeatable). Rebalancing is disabled in production.
- **Multi-day horizon on that snapshot** (`horizon-whatif.ts`, mode `on`: 116
  firm + 288 forecast slots): both Optimal; 1.16's objective is 694.802472 vs
  694.803957, inside the extended solve's `mip_abs_gap` (2.58). The firm part
  (what can reach Victron) is identical for slots 0–79; from slot 80 (15:00 the
  next day) up to 66 W of PV moves between load and battery, SoC differs by at
  most 0.045 % and firm import totals differ by 3 Wh. The extended solve is
  slower: 100 → 262 ms (5 runs each), well under its 15 s time limit; the
  firm-only solve is 31 → 28 ms.

The full suite passes with the one test update above.

### Previous: 2026-09-19, `highs@1.15.3`

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
objective. The gate was not run on production data before the merge (no snapshot on the
dev box); it was run afterwards, below.

**Production gate, 2026-09-19** (`scripts/prod-solver-gate.sh <addon-host>`,
HiGHS 1.15.1 vs the 1.8.0 build from `3fe075e`, live `data.json` +
`settings.json`: 99 slots, 35 kWh battery at 6 % SoC, 16 kW charge/discharge,
EV enabled, MILP): both `Optimal`, objective −490.684232 on both, for the full
stored horizon and from the current slot; solve time 129 vs 126 ms. Review of
the differing rows: the DESS schedule is the same — 0 of 99 slots differ in
strategy, restrictions, feed-in or flags, and target SoC differs by at most
0.022 %. The only flow difference above rounding is ~32 W of PV routed to the
load instead of the battery in one 06:15 slot and the reverse at 06:30, two
slots at the same price (cost-neutral); energy totals match to 1 Wh. The gate
does not feed live EV state into the config, so EV charging decisions are
outside what it compares.
