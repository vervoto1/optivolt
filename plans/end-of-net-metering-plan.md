# End of Net Metering (Salderingsregeling) — Implementation Plan

## Status

Implemented on branch `feat/end-of-net-metering` as v0.7.71 (steps 1–8
done; pending review and merge). Written 2026-10-13 and revised after an
adversarial review on the same day. Must ship, and be
installed on the HA host, before **2026-12-31 ~13:00 local**: that is when the
day-ahead auction publishes the first prices for 2027 slots, and the plan
solved from then on already covers 1 January.

## Goal

From **2027-01-01 00:00 Europe/Amsterdam** the Dutch salderingsregeling ends.
Every imported kWh then carries energy tax and VAT, and every exported kWh
earns only the bare market price. OptiVolt must switch its export valuation
automatically at that instant, per slot, with no manual step on New Year's
Eve. It must also stay switchable: forced on, forced off, or automatic by
date.

The intended behaviour after the switch, in the user's words: PV goes into
the battery first and the grid covers only the shortfall. Grid→battery
charging serves later self-consumption, not export arbitrage. Mildly negative
prices should not drive behaviour.

Out of scope, by decision: the NextEnergy Zonnebonus (+50 % on the market
price, 06–22 h, 6000 kWh per contract year). It does not apply to export from
a home battery, and the user asked for it to stay out of the model.

## Facts this plan rests on

- **The LP prices are already per slot.** `lib/build-lp.ts:402-411` prices
  import and export separately for each slot. Battery→grid, PV→grid and the
  curtailment rule all read `exportPrice[t]`. Terminal valuation `custom`
  (`selectTerminalPriceCentsPerKWh`, `build-lp.ts:921`) takes any price we
  compute. The tariff itself lives entirely in the inputs; the only LP change
  is a tie-break for the order of PV charging (below).
- **Production prices are all-in.** `haPriceConfig.sensor` is
  `sensor.gespot_hourly_average_price_nl` with `importEqualsExport: true`, so
  export = import = (spot + 11.80 c) × 1.21, which is 27–43 c on 2026-10-13.
  From 2027 that over-values every exported kWh by about 13–14 c. The all-in
  import price only drops below 0 when spot is below about −11.8 c, so cheap
  grid charging is already limited to genuinely very negative hours.
- **A bare market price is available.** `sensor.gespot_hourly_market_average_price_nl`
  has the same shape as the import sensor (`today_hourly_prices` /
  `tomorrow_hourly_prices`, `time` / `value`, hourly, EUR/kWh). Its values
  equal the hourly mean of GE-Spot's per-interval `raw_value`, verified to
  within 0.00005 against `sensor.gespot_current_price_nl`. The value excludes
  VAT and energy tax; ignore the sensor's `vat = 21.0%` attribute.
- **Contract.** NextEnergy dynamic settles hourly and, from 2027, pays the
  market price per exported kWh with no feed-in costs. At negative prices its
  FAQ says the customer pays nothing.
- **`extractWindow` pads with 0** (`lib/time-series-utils.ts:61-84`). Missing
  market slots must not silently read as a real 0 c price, so it needs a pad
  argument.
- **Settings plumbing.** `settings-store.ts` merges nested blocks
  (`dataSources`, `shoreOptimizer`, `pvCurtailment`) field by field with the
  defaults on load. `POST /settings` goes through `SettingsPatch`,
  `mergeSettings` (`settings-schema.ts:165`) and `validateSettingsPatch`
  (`:822`). `normalizeHaPriceConfig` (`:455`) returns a whitelisted object, so
  a new field must be added there. The UI sends nested blocks as complete
  objects (`app/src/state.js` `SETTINGS_FIELDS`).
- **Warnings.** `computeHorizonWarnings(data, startMs)`
  (`planner-service.ts:27`) feeds `summary.horizonWarnings` (`:633`), which
  the UI lists (`state.js:549`). Each is logged with a `STALE DATA` prefix.
- **PV-curtailment actuator** (`lib/pv-curtailment.ts:162`) detects negative
  prices from `row.ic` only.
- **Coverage is locked at 100 %** for `api/**`, `lib/**` and `app/src/**`
  (Codecov project and patch). `scripts/` is outside coverage.

## Design

### Data: keep the market price as its own series

Add an optional `marketPrice?: TimeSeries` to `Data` (`api/types.ts`), in
c€/kWh, excluding VAT and tax, 15-minute steps like the other price series.

- `data.exportPrice` keeps its current meaning: what the price source says
  export earns. Under `importEqualsExport` that is the import price, which is
  exactly the net-metering value.
- `data.marketPrice` is written by the HA refresh when `exportSensor` is set,
  and **removed** by the refresh whenever the price source cannot produce it
  (HA without `exportSensor`, or VRM), so no stale series lingers after a
  source switch. `POST /data` accepts it too, validated like the other series
  with numeric-or-null values; `marketPrice: null` removes it. The config
  builder samples it by slot timestamp, so an hourly series lines up with the
  15-minute slots.

Why a separate series rather than overwriting `exportPrice` at fetch time:
a settings change takes effect on the next solve with no re-fetch; a horizon
that crosses midnight on 31 December mixes the two rules per slot; and
`data.json` keeps both raw feeds for debugging.

### Settings

`haPriceConfig.exportSensor: string` — optional, default `""`. Read with the
same attribute, key, multiplier and interval settings as `sensor`.

New block `exportTariff`:

```json
"exportTariff": {
  "mode": "auto",
  "effectiveFrom": "2027-01-01T00:00:00+01:00",
  "fee_cents_per_kWh": 0,
  "negativePrice": "floorZero",
  "terminalSocValuation": "tailMin",
  "terminalTail_h": 6
}
```

- `mode`:
  - `netMetering`: export = `data.exportPrice` for every slot (today's
    behaviour).
  - `marketPrice`: market pricing for every slot. Use this for a what-if run,
    or to move to the new tariff before the switch date.
  - `auto` (default): `netMetering` for slots before `effectiveFrom`,
    `marketPrice` from then on — **but only when a market source is
    configured** (see below).
- `effectiveFrom`: an ISO instant with an explicit offset (`Z` or `±hh:mm`),
  on a 15-minute boundary in UTC. A bare local time would bring back the
  time-zone ambiguity fixed in 0.7.70; the boundary rule means no slot
  straddles the switch.
- `fee_cents_per_kWh`: finite, ≥ 0, subtracted from the market price. 0 for
  NextEnergy.
- `negativePrice`:
  - `floorZero` (default): export earns `max(0, market − fee)`. Matches the
    NextEnergy FAQ, and mildly negative hours change nothing: no LP
    curtailment, no DESS feed-in block, no Multi RS throttling risk.
  - `passThrough`: negative values reach the LP, which curtails, and DESS
    blocks feed-in (`blockFeedInOnNegativePrices` checks `row.ec < 0`).
- `terminalSocValuation`: the end-of-horizon SoC valuation used **when the
  last slot is market-priced** (market or fallback). It overrides the
  top-level setting only in that case, so 2026 behaviour is untouched.
  - `tailMin` (default): `max(0, min(importPrice over the last
    terminalTail_h hours of the horizon))`, passed to the LP as `custom`.
    The stored charge displaces import the following night and morning,
    whose price is best approximated by the horizon's own tail. The minimum
    keeps the value below every evening import price, so the battery still
    covers the evening load instead of hoarding. Taking the whole-horizon
    minimum (`min`) was rejected in review: a single cheap or negative midday
    import slot pulls the value to 0 and brings back the end-of-horizon
    dump. Charging inside the tail window costs more than the value it adds
    (import ÷ η versus import × η), so it does not attract grid charging at
    the end. Selling above it in the evening remains possible, and is
    correct: a 40 c evening market price beats a 25 c night import.
  - The existing values (`zero`, `min`, `avg`, `max`, `custom`) are also
    accepted and used as is.
- `terminalTail_h`: 1–24, default 6.

A settings object **without** `exportTariff` (solver-gate snapshots, test
fixtures, configs built outside the store) behaves as `netMetering`. A
missing `haPriceConfig.exportSensor` counts as `""`.

Validation: `validateSettingsPatch` rejects bad values on `POST /settings`
(bad enums, `effectiveFrom` without offset, unparseable or off the 15-minute
grid, fee < 0 or non-finite, tail outside 1–24). Normalising a stored file on
load falls back to the default for an invalid field and logs a warning,
rather than throwing, so a bad stored value cannot stop the add-on.

### Market source configured

```text
marketSourceConfigured =
  dataSources.prices === 'ha'  ? haPriceConfig.exportSensor.trim() !== ''
  dataSources.prices === 'api' ? data.marketPrice is present
  otherwise (VRM)              : false   // a leftover series is ignored
```

- `auto` without a configured market source behaves as `netMetering` for
  every slot, never applies the terminal override, and emits the "no market
  source" warning from 7 days before `effectiveFrom` onwards. This covers HA
  users outside the Netherlands or without a market sensor, VRM users and
  `POST /data` users: export is never zeroed for anyone who did not opt in.
- `marketPrice` mode was chosen explicitly, so it uses the market rule even
  without a source, falling back to 0 per slot (and warning).

### Where the switch is applied

A new pure helper, `lib/export-tariff.ts`:

```ts
resolveExportPrices({
  slotStartsMs, sourceExport, market, tariff, marketSourceConfigured,
}): {
  exportPrice: number[];
  regime: Array<'netMetering' | 'market' | 'fallback'>;
  marketPricedSlots: number;
  fallbackSlots: number;
  missingMarketSource: boolean;  // auto, no source, horizon reaches effectiveFrom − 7 d
}

terminalTailMinPrice(importPrice, stepSize_m, tail_h): number
```

For each slot:

1. If `tariff` is absent, the mode is `netMetering`, the mode is `auto`
   without a market source, or the mode is `auto` and the slot starts
   before `effectiveFrom`: `sourceExport[t]`, regime `netMetering`.
2. Otherwise, if `market[t]` is finite: `market[t] − fee`, then
   `negativePrice`; regime `market`.
3. Otherwise **0**, regime `fallback`, counted in `fallbackSlots`.

Why 0 is the fallback: under the new tariff, missing market data must not
quietly bring back the net-metering valuation, which would plan battery
export against a price about 2× too high. With export at 0 the plan keeps the
battery for the house and still exports true PV surplus, because curtailment
is only allowed at negative prices. Failing the solve instead would leave a
stale DESS schedule running, which is worse.

Called from `buildSolverConfigFromSettings`
(`api/services/config-builder.ts:90`) right after the existing windows:

- `extractWindow` gains an optional `pad` argument (default 0, so existing
  callers are unchanged). The market window uses `NaN`; an absent
  `data.marketPrice` is all `NaN`.
- `marketPrice` is **not** added to the `endMs` or `mustCoverStart` checks. A
  lagging market feed must not shorten the plan; its slots fall back per
  slot instead.
- When the last slot's regime is `market` or `fallback`, the terminal
  valuation is replaced: `tailMin` → `terminalSocValuation: 'custom'` with
  `terminalSocCustomPrice_cents_per_kWh = terminalTailMinPrice(...)`;
  any other value is used as is.
- The result is attached as an optional diagnostics field
  `cfg.exportTariffInfo = { marketPricedSlots, fallbackSlots,
  missingMarketSource, effectiveFrom, terminalOverride }`, which `buildLP`
  ignores. When the block is absent or the mode resolves to `netMetering`
  for every slot, `exportPrice` and every LP input are identical to today's,
  and `buildLP(cfg)` produces the same string.

### Warnings

A sibling `computeExportTariffWarnings(info)` in `planner-service.ts`; its
messages go into the same `summary.horizonWarnings` list the UI already
shows, but are logged with a `[export-tariff]` prefix, not `STALE DATA`:

- "Market price missing for N slots after net metering ends — export valued
  at 0 for those slots" when `fallbackSlots > 0`.
- "Net metering ends at <effectiveFrom> but no market-price source is
  configured — export still valued at the import price" when
  `missingMarketSource`.

The existing `computeHorizonWarnings` gets a `Market prices` horizon check
only when a market source is configured.

### Fetching (`api/services/ha-price-service.ts`)

Factor the "state → attributes → `pricePointsToSeries`" path out of
`fetchPricesFromHA` and call it for `sensor` and, when set, `exportSensor`.
It returns `{ importPrice, exportPrice, marketPrice? }`. A failing market
sensor still returns the import result, with a `console.warn`; the fallback
rule covers the missing slots.

`vrm-refresh.ts` (HA branch, `:208-218`) writes `marketPrice` when the
fetch returned it. When `exportSensor` is empty it removes `marketPrice`
inside the `updateData` mutate. When the market fetch failed it keeps the
stored series (its slots age out of the window and fall back).

### Other changes found in review

- **PV-curtailment actuator** (`lib/pv-curtailment.ts`): the import side
  (`ic < threshold`) keeps every trigger, including the grid-headroom
  full disable. The export side counts only when truly negative
  (`ec < min(threshold, 0)`, so 0 c floored/fallback slots never qualify) and
  only through the plan's own curtailment (`planned_pv_curtailment`):
  switching all PV off would buy the self-consumed part back at the import
  price to avoid a small export fee.

### PV charges the battery first (LP tie-break)

Added at the user's request. With one export price across a PV surplus
window, the LP was free to export first and charge at the end of the
afternoon. `TIEBREAK.preferEarlierPvCharging` (2e-7 per slot on
`pv_to_battery`, mirroring `preferEarlierCharging`) makes it charge from the
earliest surplus and export only once the battery is full, so a PV forecast
that falls short in the afternoon still finds a full battery. It only breaks
ties (at most about 0.08 c/kWh over a 48 h horizon), grows more slowly than
the grid-charging tie-break so PV keeps beating grid charging, and stays below
the curtailment penalty. It applies under net metering too. Tested in
`tests/lib/build-lp-export-tariff.test.js`, which fails with the tie-break at
0.

### What deliberately does not change

- `lib/build-lp.ts` objective prices: they already use per-slot import and
  export.
- `lib/dess-mapper.ts`: tipping points are taken within each segment, and
  `blockFeedInOnNegativePrices` checks `row.ec < 0`; with `floorZero` that
  never fires on market slots.
- EV logic: grid→EV prices off import. Charging the EV from PV gets more
  attractive on its own, because the alternative (export) is worth less.
- `parse-solution.ts` costs and plan accuracy: they read `cfg.exportPrice`,
  so reported revenue becomes contract-correct automatically.

## UI

- Price-source card (`app/index.html` ~line 1912, next to
  `ha-price-import-equals-export`): an **"Export market-price sensor"** text
  input, placeholder `sensor.gespot_hourly_market_average_price_nl`, read as
  part of the complete `haPriceConfig` object.
- New **"Export tariff"** card in Settings:
  - mode select (Auto by date / Net metering / Market price);
  - effective-from as a text input holding the ISO instant with offset
    (validated server-side), with the instant shown beneath it in the server
    time zone (0.7.70 helpers);
  - fee; negative-price rule; terminal valuation; tail hours;
  - a status line, computed from the server clock offset: "Net metering
    active until …", "Market-price export active since …", or "Net metering
    (no market-price sensor configured)".
- `exportTariff` is read as a complete object in `SETTINGS_FIELDS`, like
  `pvCurtailment`, so the send-only-edited-fields save (0.7.69) sends it whole
  when any of its inputs changed; hydrate the inputs on load.
- Price chart: plot `ec` as its own line whenever it differs from `ic`. Check
  whether the chart already does; add it if not.
- Rebuild Tailwind (`npm run build:css`) after the markup changes, and avoid
  Tailwind-like words in JS comments.

## Implementation steps

1. **Types, schema, defaults, store.** `ExportTariffConfig` and the new
   fields in `api/types.ts` (and `lib/types.ts` for the optional
   `exportTariffInfo`); `SettingsPatch`, `mergeSettings` (field by field),
   `validateSettingsPatch`, lenient `normalizeExportTariff`, `exportSensor`
   in `normalizeHaPriceConfig`; `default-settings.json`; field-by-field merge
   in `settings-store.ts`; `marketPrice` validation in `data-store.ts`.
2. **`lib/export-tariff.ts`** and the `extractWindow` pad argument, with
   unit tests.
3. **`config-builder.ts`**: windows, helper call, terminal override,
   `exportTariffInfo`.
4. **`ha-price-service.ts` and `vrm-refresh.ts`**: second sensor, persist
   or remove `marketPrice`.
5. **Planner warnings** and the PV-curtailment trigger.
6. **UI** and `npm run build:css`.
7. **What-if script** (`scripts/export-tariff-whatif.ts`, see Verification).
8. **Docs and version**: CHANGELOG, version bump to 0.7.71 in
   `package.json`, `package-lock.json` (`npm install --package-lock-only`)
   and `optivolt/config.yaml`; one line in the CLAUDE.md data-flow paragraph.

## Tests

Every new branch needs a test (100 % patch coverage).

- `tests/lib/export-tariff.test.js`: every mode; absent tariff; a horizon
  straddling `2026-12-31T23:00:00Z` (= 2027-01-01 00:00 CET); `floorZero` vs
  `passThrough`; `NaN` and non-finite market values fall back to 0 and are
  counted (with a fee, the fallback is 0, not −fee); auto without a source;
  the 7-day warning window; `terminalTailMinPrice` including a negative tail
  floored at 0 and a tail longer than the horizon.
- `tests/lib/time-series-utils.test.js`: the pad argument.
- `tests/lib/build-lp.test.js`, behaviour under asymmetric prices:
  - import 27–43 c, export 10–25 c, ~88 % round trip: midday PV surplus goes
    to the battery before the grid, and no grid-charged energy is later sold
    through `battery_to_grid`;
  - with the `tailMin` price as `custom`, a battery full at the end is not
    drained to the grid, even with a cheap midday import slot and an evening
    market price above that slot's import price.
- `tests/api/services/config-builder.test.js`: `buildLP` string identical for
  absent block, `netMetering`, and `auto` with every slot before the switch;
  straddling fixture; terminal override only when the last slot is
  market-priced or fallback; market series ending early gives `fallbackSlots`
  and does not shorten `endMs`; `prices: 'ha'` with empty `exportSensor` in
  2027 keeps the source export and sets `missingMarketSource`.
- `tests/api/services/ha-price-service.test.js`: export sensor parsed; export
  sensor failure still returns import.
- `tests/api/services/vrm-refresh.test.js`: `marketPrice` persisted; removed
  when `exportSensor` is empty; kept when the market fetch fails.
- `tests/api/services/settings-schema.test.js` and `settings-store.test.js`:
  old file loads with defaults; partial `exportTariff` patch keeps the other
  fields; invalid patches rejected; invalid stored value falls back.
- `tests/api/services/planner-service.test.js`: tariff warnings reach
  `summary.horizonWarnings`.
- `tests/api/services/pv-curtailment.test.js` / `tests/lib/pv-curtailment.test.js`:
  `ic > 0`, `ec < 0`.
- `tests/app/`: the export-tariff card binds, hydrates, sends the complete
  block when edited, and renders the status line.

## Verification before release

`scripts/prod-solver-gate.sh` compares two HiGHS builds, not two tariff
modes, so it is not the tool here. Add `scripts/export-tariff-whatif.ts`:

```sh
npx --no-install tsx scripts/export-tariff-whatif.ts data.json settings.json \
  [--calibration calibration.json] [--market market-entity.json]
```

- Builds the config through `buildPlannerConfig` for `exportTariff` absent,
  `netMetering` and `marketPrice`, solves each with the vendored HiGHS.
- Fails if the LP strings for absent and `netMetering` differ.
- `--market` takes the JSON of `GET /ha/entity/sensor.gespot_hourly_market_average_price_nl`
  from the add-on and injects it as `data.marketPrice` via
  `pricePointsToSeries`; the script prints `fallbackSlots` and refuses a
  `marketPrice` comparison with fallback slots unless `--allow-fallback`.
- Prints, per mode: Σ battery→grid, Σ PV→grid, Σ PV→battery, Σ grid→battery
  (kWh), final SoC, planned cost.

Expected with real market data: battery→grid collapses to (near) zero,
PV→battery rises, and the final SoC no longer falls to the floor.

## Rollout

1. Merge and publish as v0.7.71. The HA host does not auto-update: the user
   installs it manually, with `ha supervisor restart` if the store lags.
2. In production set `haPriceConfig.exportSensor =
   sensor.gespot_hourly_market_average_price_nl` and leave
   `exportTariff.mode = auto`. Check that `data.json` gains `marketPrice` on
   the next refresh and that the status line reads "Net metering active
   until 1 Jan 2027".
3. **Optional dry run in December:** switch to `marketPrice` for one day to
   see real DESS behaviour, then back to `auto`.
4. **Manual, on 2027-01-01 (not automatable here):** set the energy tax in
   GE-Spot's import price to 8.80 c excluding VAT (10.65 c including VAT,
   down from 11.08 c). Check the extra-cost field while there: the current
   ex-VAT add-on is 11.80 c against an expected 11.35 c, which suggests the
   2.19 c markup was entered including VAT.

## Open decisions (defaults chosen, change if wanted)

- `negativePrice` defaults to `floorZero`, per the NextEnergy FAQ and the
  user's preference; `passThrough` if that changes.
- Fallback value when market data is missing: 0.
- `terminalTail_h` default 6.
- Not in this plan: computing the import price inside OptiVolt from the
  market price plus a dated tax table. That would also automate rollout step
  4, but GE-Spot already does the job.
