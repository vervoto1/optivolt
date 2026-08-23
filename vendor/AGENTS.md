<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# vendor

## Purpose

Vendored dependencies bundled with the project. Currently contains the HiGHS linear/mixed-integer optimization solver as a precompiled WASM module.

## Key Files

| File | Description |
|------|-------------|
| `highs-build/highs.wasm` | HiGHS 1.8.0 compiled to WebAssembly (~2.5 MB) |
| `highs-build/highs.js` | Minified Emscripten `MODULARIZE` wrapper for the WASM module (CommonJS) |
| `highs-build/package.json` | Minimal package metadata (`"type": "commonjs"`) |
| `highs-build/PROVENANCE.md` | Source commits, HiGHS version, sha256 hashes, refresh procedure and policy |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `highs-build/` | Precompiled HiGHS WASM solver |
| `highs-js/` | Git submodule pointing at the `lovasoa/highs-js` commit the build came from (provenance only; not checked out, nothing imports it) |

## For AI Agents

### Working In This Directory

- These are **vendored binaries** — do not modify directly; `tests/vendor/highs-build-provenance.test.js` pins their sha256 to `PROVENANCE.md`
- The module is imported directly from `vendor/highs-build/highs.js` by `api/services/planner-service.ts` and the `tests/lib/` solver tests — the npm `highs` package is **not** a dependency
- `package.json` marks the directory CommonJS so the Emscripten wrapper loads under the ESM root package
- To upgrade HiGHS, follow the refresh procedure in `PROVENANCE.md` (copy the npm `highs` release artifacts, gate with `scripts/compare-highs-builds.ts`, update the hashes) — no Emscripten toolchain needed

## Dependencies

### Internal

- Used by `api/services/planner-service.ts` for LP/MIP solving

### External

- HiGHS optimization solver (upstream: github.com/ERGO-Code/HiGHS)

<!-- MANUAL: -->
