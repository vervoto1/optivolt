<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# vendor

## Purpose

Vendored dependencies bundled with the project. Currently contains the HiGHS linear/mixed-integer optimization solver as a precompiled WASM module.

## Key Files

| File | Description |
|------|-------------|
| `highs-build/highs.wasm` | HiGHS solver compiled to WebAssembly (~16.8 KB) |
| `highs-build/highs.js` | CommonJS wrapper for the WASM module (~60 lines) |
| `highs-build/package.json` | Minimal package metadata (`"type": "commonjs"`) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `highs-build/` | Precompiled HiGHS WASM solver |
| `highs-js/` | Reserved (currently empty) |

## For AI Agents

### Working In This Directory

- These are **vendored binaries** — do not modify directly
- The WASM module is loaded by `api/services/planner-service.ts` via the `highs` npm package
- CommonJS wrapper required because the WASM loader expects CJS format
- If upgrading HiGHS, rebuild the WASM binary and replace both files

## Dependencies

### Internal

- Used by `api/services/planner-service.ts` for LP/MIP solving

### External

- HiGHS optimization solver (upstream: github.com/ERGO-Code/HiGHS)

<!-- MANUAL: -->
