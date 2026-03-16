<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# defaults

## Purpose

Default JSON configuration files used as fallbacks when no persisted data exists. Loaded by the store services on first run or when files are missing/corrupted.

## Key Files

| File | Description |
|------|-------------|
| `default-settings.json` | Battery capacity, charge/discharge limits, SoC bounds, efficiency, grid limits, step size, data sources |
| `default-data.json` | Stub timeseries for load, PV, import/export prices, and initial SoC |
| `default-prediction-config.json` | Empty prediction config template (sensors, derived, activeConfig) |

## For AI Agents

### Working In This Directory

- These files define the **schema** for persisted data; any new settings field must have a default here
- `settings-store.ts` merges persisted settings with these defaults (new fields get default values automatically)
- Changing defaults affects new installations only; existing `DATA_DIR` files take precedence
- Units follow project conventions: `_Wh`, `_W`, `_percent`, `_m`, `_cents_per_kWh`

### Common Patterns

- Flat JSON objects (no nesting except `dataSources` and `terminalSocValuation`)
- Conservative defaults: 5000 Wh battery, 20-100% SoC, 90% efficiency

## Dependencies

### Internal

- Consumed by `../services/settings-store.ts`, `../services/data-store.ts`, `../services/prediction-config-store.ts`

### External

None.

<!-- MANUAL: -->
