# Multi-Day Planning Horizon with Forecast Prices — Implementation Plan

## Status

Implemented on branch `feat/multi-day-horizon`, pending review (0.7.72,
steps 0–9). Written 2026-10-13, revised
the same day after a four-lens adversarial review (LP/economics, data and
forecasts, plan consumers, tests/rollout). Target release 0.7.72.

## Goal

Today the plan ends at local midnight (before 13:00) or at midnight tomorrow
(from 13:00). In production it runs the battery down to the 5 % floor by the
end of that window (net-metering arbitrage plus `terminalSocValuation:
zero`), so nothing is left to bridge the night and the next day(s).

Extend the plan by **1–4 extra days** priced with **forecast** market prices
after the published day-ahead prices, so the LP itself decides how much
charge to carry over: hold it before an expensive Wednesday, let it run down
before a cheap Saturday.

Requirements:

- Opt-in, `extendedHorizon.mode: "off"` by default. With `off`, every LP,
  DESS schedule and plan-history write is byte-identical to 0.7.71, proven by
  golden fixtures.
- **Forecast prices never reach Victron or an actuator.** Only firm
  (published-price) slots are written, and every "current slot" consumer
  treats a forecast row as "no plan".
- **Today's plan is the fallback.** The firm-only plan is always solved
  first, exactly as today; the extended solve only replaces it when it
  returns Optimal. A missing forecast, a failed fit or a time-out leaves
  today's behaviour plus a warning.
- **Collect before act.** `mode: "collect"` fetches and logs the forecast and
  extends load/PV data without changing any plan. This lets the what-if script
  run on real production snapshots, and lets us measure the forecast error,
  before switching to `on`.

## Facts (research and review, 2026-10-13)

### Price forecast: EpexPredictor

- `github.com/b3nn0/EpexPredictor` (BSD-3), LightGBM on weather, load, gas
  and cross-border prices; region `NL`. Public endpoint
  `https://epexpredictor.batzill.com/prices?region=NL&unit=CT_PER_KWH`, no
  auth, "no guarantees, fair use".
- **Response:** `{ prices: [{ startsAt, total }], knownUntil }`.
  - Prices are 15-minute values starting at the current slot.
  - Without `hours` the response covers about 6.9 days; `hours=120` ends at fetch + 120 h.
  - `knownUntil` is the **start** of the last published slot, so the published end is `knownUntil + 15 min`.
  - Published slots equal EPEX (checked against energy-charts).
  - `startTs` reaches about 90 days back and returns published history.
  - `hourly=true` returns hourly prices.
  - `surcharge`/`taxPercent` return `(p + s)(1 + t)`.
- **Accuracy:**
  - Published NL backtest MAE is 1.72 / 1.85 / 1.89 c/kWh ex VAT at 1 / 2 / 3 days ahead.
  - `evaluation=true` scores 0.64 c on the last 15 days. That is in-sample and optimistic, so live accuracy must be measured.
- **Example:** on 2026-10-13 the forecast daily averages are Wed 18.2, Thu 17.3, Fri 16.9, **Sat 11.8** and Sun 15.0 c.

### What limits the horizon today

- `endMs = min(load, pv, import, export, evLoad ends)`
  (`config-builder.ts:175-180`); `endMs ≤ now` throws 422, which
  auto-calculate uses to retry with a refresh (`auto-calculate.ts:21-24,87-90`).
- Load and PV forecasts are cut by `getForecastTimeRange()`
  (`lib/time-series-utils.ts:115-134`), which is also used by all three load
  predictors, the PV forecast and `computeHorizonWarnings`. VRM follows the
  same rule (`lib/vrm-api.ts:183-211`).
- **VRM zero-fills unpublished prices** (`vrm-api.ts:345-346,416`), so the
  end of a VRM price series is not the end of the published prices.
- **PV irradiance:** `icon_d2`, `forecastDays: 2` (`open-meteo-client.ts:53`).
  - `icon_d2` ends about 45 h out and is null after that.
  - `icon_seamless` has the same variables and `minutely_15`, has no nulls for 6 days, and is identical to `icon_d2` in the overlap (0 of 313 slots differ by more than 1 W).
  - PV training uses the Archive API, not ICON.
- **Load:** the historical predictor loses samples, not values, for targets
  several days ahead. Nulls become 0 W at `open-meteo.ts:126-128`,
  `load-prediction-service.ts:648,775` and `time-series-utils.ts:179-185`.
- **Prices:** the production HA price sensor is hourly (`priceInterval: 60`),
  while the forecast is quarter-hourly.

### Solver

- Measured worst case: ratchet + rebalance + continuous EV with binaries in
  every slot is 8.7 s at T=96, 14 s at T=192, and reaches the 30 s limit at T=384 or more.
- The base LP without binaries takes 0.36 s at T=480.
- A non-Optimal plan is display-only (`planner-service.ts:677-682`).
- **Slot-indexed tie-breaks** (`build-lp.ts:410-414,439`) reach about 0.96
  c/kWh at t=479. `preferEarlierPvCharging` crosses `avoidCurtail` at
  t≈493.
- A posted `api` series can already make T > 144 today, so a constant cap
  would change today's LPs.
- **Correction:** the 0.7.71 CHANGELOG states `preferEarlierPvCharging` as
  "about 0.08 c/kWh over 48 h". The correct figure is about 0.15 c/kWh (0.11 at
  today's 36 h maximum).

### Consumers that must be fenced

| Consumer | Problem | Code |
|---|---|---|
| Victron write | Writes `min(48, rows.length)` slots; `firmSlots < 48` from 12:00 until publication every day | `planner-service.ts:786-807` |
| DESS mapper | Segments span the plan; tipping points and the export-run look-ahead read every row; `dess` is required on every row | `dess-mapper.ts:170-184,276-283,368-374`, `api/types.ts:419-421` |
| Rebalance | `rebalanceMaxStartSlot` is the pin; `solveWithPinnedHoldFallback` strips it and gallops to `T−D`; `KMAX` clamps a negative cap to 0 | `planner-service.ts:403-469`, `build-lp.ts:212-215` |
| EV | Default deadline is T; departure is clamped to T+1; target and floor rows reference every slot; missing `ev_soc` is parsed as 0 | `config-builder.ts:49-61,338-353`, `build-lp.ts:309,749-775`, `parse-solution.ts:111,242` |
| Current-row users | PV curtailment, shore optimizer, EV decision; a stale plan could reach forecast rows | `pv-curtailment.ts:99-120`, `planner-service.ts:220-231`, `ev-decision-service.ts:101-102,182-185` |
| Plan history | Every future slot of every plan is stored, and the calibrator reads them | `planner-service.ts:733-779`, `efficiency-calibrator.ts:231-283` |
| Totals | Summary and table totals add up all rows | `plan-summary.ts:73-109`, `table.js:150-158` |
| Horizon warnings | Prices are checked against the same end as load and PV | `planner-service.ts:27-54` |

## Design

### Settings: `extendedHorizon`

```json
"extendedHorizon": {
  "mode": "off",
  "extraDays": 3,
  "forecastUrl": "https://epexpredictor.batzill.com",
  "region": "NL",
  "importVat_percent": 21,
  "riskMargin_cents_per_kWh": 1.0,
  "refreshMinutes": 60
}
```

- `mode`:
  - `off`: no forecast is fetched.
  - `collect`: fetch and log the forecast and extend load/PV data; plans are unchanged.
    The solve caps the planner's own (`api`) load/PV series at the old window
    end, where they end with `off`, so prices that already reach past it (HA
    from about 12:45, multi-day `api` prices) do not lengthen the plan.
  - `on`: also solve the extended plan.
- `extraDays` (1–4): the target end is the local midnight at or after the
  firm end, plus `extraDays` local calendar days (23 h or 25 h across a DST
  switch; `extendedWindowEndMs`). The forecast reach is then fixed relative
  to the published prices and does not jump at midnight. The load/PV
  predictor window (`resolvePlanningWindow`, below) is anchored at
  max(tomorrow 24:00, firm end), so it always reaches this end.
- `forecastUrl`: must be `http(s)` with no credentials in the URL.
  `region` is an enum of the feed's regions.
- `importVat_percent`: used only as the fallback slope of the import fit
  (see below).
- `riskMargin_cents_per_kWh`: the dead-band on carry-over (see the LP
  section). It does **not** shift prices.
- `refreshMinutes`: 30–600, with jitter. A refresh is due at
  `min(refreshMinutes + jitter, 12 h − 2 h)`, so it always lands before the
  forecast turns stale.
- Plumbing follows the `exportTariff` pattern in full:
  - **Types:** `api/types.ts`.
  - **Schema** (`settings-schema.ts`): `SettingsPatch`, field-by-field `mergeSettings`, an `EXTENDED_HORIZON_DEFAULTS` constant and a limits constant, a lenient load normaliser that warns, and strict validation in `validateSettingsPatch`.
  - **Store and defaults:** the `settings-store.ts` merge and `default-settings.json`.
  - **UI:** `SETTINGS_FIELDS` sends the complete object, `ui-binding.js` adds `els` entries and `data-settings-input` on every control, and the form hydrates on load.
- **Server-derived values never live in settings** (the 0.7.69 stale-tab
  class of bug). The import fit and the forecast are kept in `data.json`.

### Data

```text
data.priceForecast = {
  fetchedAt, publishedEnd,          // publishedEnd = knownUntil + 15 min
  series: TimeSeries,               // market c/kWh ex VAT, 15-min, as fetched
  fit?: { a, b, n, mad, fittedAt }  // last accepted import fit
}
```

- Validated in `data-store.ts`: finite values, 15-minute step. `data-store`
  also starts rejecting non-finite values in every series.
- The accuracy log `price-forecast-log.json` keeps one snapshot per local
  day (the first fetch after publication), hourly, for the next 5 days, in a
  ring of 60. It is scored offline by
  `scripts/price-forecast-accuracy.ts`, which takes the actual prices from
  the feed's `startTs` history. There is no endpoint or UI panel.

### Fetching (`lib/price-forecast.ts` + `api/services/price-forecast-service.ts`)

- **Pure code in `lib/`:** builds the URL (no `hours`, so about 7 days;
  `startTs` = local midnight today, so the overlap with today's published
  prices is included) and parses the response.
- **The service:** uses `fetchWithTimeout` with a 10 s timeout and
  `withRetry` with 2 attempts.
- **It runs in the background**, never inside the solve path. The data
  refresh starts it when the forecast is older than `refreshMinutes` (at
  most 10 h), or
  when the published import prices reach past `publishedEnd`. The solve
  always uses the stored forecast.
- A failure keeps the stored forecast and warns. A forecast older than 12 h
  counts as missing.
- `now` is injected, and tests stub `fetch` as `open-meteo-client` does.
- **Documented in `optivolt/DOCS.md`:** the third-party host, that the
  request sends the region only (plus the client IP), and the fair-use
  terms.

### Load and PV over the longer horizon

- A new `resolvePlanningWindow(settings, now, firmEndMs?)` gives:
  - the old window, when `mode` is `off`;
  - when `mode` is `collect` or `on`, an end of local midnight after
    tomorrow 24:00 (or after the firm end when it is known) plus `extraDays`.
- All three load predictors and the PV forecast use it.
- **PV:** keep `icon_d2` up to its last non-null value and splice
  `icon_seamless` in after it, with `forecastDays` counted from today's UTC
  midnight (Open-Meteo's day count with `timezone=GMT`) to the window end,
  +1, capped at 16, as for the temperature forecast. The firm
  part is identical by construction.
- **No silent zeros past the old window:** a null or missing value after the
  old `getForecastTimeRange` end ends the series there, and the predictor
  returns `truncatedAt` and a reason. The historical predictor also ends the
  series where its sample count per target drops below a minimum. Inside the
  old window, behaviour is unchanged.
- VRM load/PV sources are not extended; the horizon is then capped by VRM's
  end, and an info line says so.

### Firm boundary

- **`firmEndMs = min(importEnd, exportEnd, loadEnd, pvEnd, publishedUntil)`**,
  where `publishedUntil` is:
  - for VRM: the last timestamp VRM actually returned before zero-filling,
    stored with the series;
  - for HA, `api` and others: the series end.
- With `on` the firm part is not capped at the old window: published
  prices that reach past it (before 13:00) are real prices, so the
  firm-only plan (the fallback) may be longer than the `off` plan.
- If `firmEndMs ≤ now`, throw the same 422 as today, with the same details.
  Forecast prices never stand in for missing published prices.
- `firmSlots = (firmEndMs − now) / step`. `SolverConfig.firmSlots` is
  optional; absent means T, which is today.

### Pricing the forecast slots (`lib/forecast-pricing.ts`)

- **Resample** the forecast to the firm import's interval. When the firm
  import is constant within every hour across the firm part, use hourly means.
  This avoids quarter-hour arbitrage the user is never billed on.
- **Import fit:** `import = a·m + b` with a Theil–Sen fit on the overlap
  between published import and published market prices (hourly when the
  import is hourly).
  - VRM zero-fill slots are excluded.
  - `a` must lie between 0.95 and 1.30. When the overlap's spread is under 3 c, use
    `a = 1 + VAT` and the median for `b`.
  - The fit is rejected when the residual MAD exceeds 1 c. In that case use
    the stored fit if it is under 7 days old **and from the same calendar
    year**; otherwise there is no extension and a warning is shown.
  - A fresh fit prices only the forecast slots in the local calendar year of
    its overlap's last point: an extension that crosses 1 January on a fit
    of this year's prices is cut there (with a warning), and one that starts
    in the next year is not used.
  - This tracks GE-Spot's tax and markup, including the 1 January change, as
    soon as 2027 prices are published.
- **Export:** forecast slots continue the firm part's export relation.
  - Net-metering regime:
    - if every firm export equals the import, export = forecast import;
    - if every firm export is 0, export = 0;
    - otherwise, export = forecast import + median(export − import) over the firm part;
    - if the firm relation is inconsistent, there is no extension and a warning is shown.
  - Market regime: only where `resolveExportPrices` would choose `market`
    (a configured market source and a slot at or after `effectiveFrom`). There
    the forecast market price is the market series: `m − fee`, then
    `negativePrice`.
  - The 2027 tariff therefore treats forecast days exactly like firm days.
- Prices are unbiased; the risk margin is applied in the LP.

### Solve pipeline (`planner-service.ts`)

1. **Firm-only solve, exactly as today.** This includes the rebalance pin
   search and the EV preview. Its result is the fallback and the reference.
2. If `mode` is `on`, the forecast is fresh, the fit is accepted and
   `T_ext > firmSlots`: build the extended config.
   - It is the firm config with forecast slots appended, `firmSlots` set,
     and `socRef` = the firm-only SoC at `firmSlots − 1`.
   - The rebalance hold is pinned to the start the firm-only plan chose,
     so the extended solve never searches.
   - Solve options: `mip_rel_gap: 0`,
     `mip_abs_gap: max(0.01, 0.005·|firm-only objective|)`, time limit 15 s.
     A separate `extendedSolveOptions()` leaves `MIP_SOLVE_OPTIONS` and the
     HiGHS gate untouched.
3. If the extended solve is Optimal, use its rows. Otherwise use the
   firm-only plan and warn. The EV preview stays firm-only.

### LP (`lib/build-lp.ts`), all gated on `firmSlots < T`

- **Tie-breaks:** `min(t, firmSlots − 1)` for `preferEarlierCharging`,
  `preferEarlierDischarge`, `preferEarlierPvCharging` and
  `preferEarlierEvCharging`. With `firmSlots` absent this is identical for
  every T, and it leaves no firm/forecast bias.
- **No binaries in forecast slots:**
  - `battery_charging_t` is continuous between 0 and 1, which is the convex
    hull of the binary model. A charge-and-discharge loop only pays below
    about −5 c/kWh all-in, on slots that are never executed, which is acceptable.
  - **CV taper:** apply a running minimum to the battery thresholds (forecast
    rows only, so firm rows are unchanged). Keep `cv_k_t` as a continuous
    variable between 0 and 1 with the forward row
    `soc_{t−1} − (maxSoc − θ_k)·cv ≤ θ_k`, and drop `c_cv_rev`. The cap
    `P0 − Σ Δ_k·max(0, (s − θ_k)/(maxSoc − θ_k))` is then concave, exact at
    θ_0 and at maxSoc, and adds no new rows. Do the same for the discharge
    phase `dp`.
  - **Floor ratchet:** for `t ≥ firmSlots`,
    `soc_shortfall_t + soc_t ≥ minSoc − allowance(firmSlots−1)·(1 − fr_{firmSlots−1})`.
    The allowance is frozen at the boundary, with no growth and no new latch.
  - **Rebalance:** `KMAX = min(T − D, pin, firmSlots − D)`. A hold that has
    not started and does not fit in the firm part is deferred: no hold
    variables, `pendingSinceMs` is kept, and rebalancing is not switched off.
    A hold that has already started keeps its slot-0 pin.
  - **EV:** every EV index is resolved against `firmSlots`.
    - The departure is clamped to `firmSlots + 1`.
    - EV is off when its start is at or after `firmSlots`.
    - EV variables, target, floor and continuity exist only for firm slots.
    - `BIG_PENALTY` and `minChargeCost` are computed over firm slots.
- **Carry-over dead-band:**
  `dev⁺ − dev⁻ = soc_{firmSlots−1} − socRef_Wh`, with objective term
  `r·(dev⁺ + dev⁻)` (r = `riskMargin_cents_per_kWh` per kWh). Ending the
  firm part with more charge than today's plan, or with less, must each beat
  the forecast error by r. This is a true two-sided hysteresis with no price
  shift and no artificial negative prices.
- **Terminal valuation:** the end-of-horizon valuation (`min`/`avg`/`max`
  over the whole horizon, and `tailMin` over its last hours) now reads
  forecast prices. That is intended, and its effect on the first 12 h is
  small at 2–5 days out.

### Fences outside the LP

- **Victron:** write `min(48, firmSlots)` slots, with the fingerprint over
  the same count, so today's slot count is kept exactly.
  - The DESS mapper runs on firm rows only: segments, tipping points,
    look-ahead and diagnostics.
  - Forecast rows get a never-written sentinel `dess`
    (`Strategy.unknown`/`Restrictions.unknown`), so the required field is
    always present.
- **Current-row users:** PV-curtailment (decision and annotation), shore
  optimizer `getCurrentSlotMode` and EV decision treat a `priceForecast` row
  as "no current slot". The PV-curtailment negative run stops at the
  boundary.
- **Rows:** `PlanRow.priceForecast: true` is present on forecast rows only,
  so `off` payloads are unchanged. EV fields are `null` on forecast rows.
- **Plan history** stores firm slots only, which is the same as today
  because firm is at most 36 h.
- **Summary:** firm totals as today, plus a `forecast` block only when one
  exists. `summary.extendedHorizon.firmObjective` is the firm-only
  objective; the plan's own objective (`/calculate` `objectiveValue`) is the
  extended solve's when the plan is extended. `/ev/schedule` marks forecast
  rows and never marks them `low_price`; `/ev/current` reads a forecast row
  as no current slot (null plan fields).
- **Warnings:**
  - prices are checked against the old firm window, and load/PV against the
    end the extended solve uses (`api` sources);
  - the forecast is missing or stale;
  - the fit was rejected;
  - the extension was cut short (and why);
  - the extended solve was not Optimal (the firm-only plan is used).

### UI

- **Settings card "Multi-day horizon":**
  - fields for the mode, extra days, URL, region, VAT and risk margin;
  - a status line, e.g. "Planning through Fri 17 Oct (forecast prices after
    Wed 00:00; fit a 1.21, b 14.3 c)";
  - in `collect` mode it says plans are unchanged.
- **Charts:** a dashed price line after the boundary (Chart.js segment
  `borderDash`), lower alpha for forecast bars, and a boundary marker. No
  new vendored library.
- **Labels:** tooltips and table rows show the weekday when the plan spans
  more than one day.
- **Table:** DESS and pvControl columns show "—" on forecast rows; the Σ
  row has firm totals, with forecast totals on a second line.
- `npm run build:css`.

## Implementation steps

0. **Before any LP edit:**
   - `tests/lib/lp-golden.test.js` with sha256 hashes of `buildLP` at 0.7.71
     for about 12 configs: 15/5/60-minute steps, a 192-slot `api` horizon,
     CV, DP, ratchet, rebalance (pinned and free), EV (native, continuous,
     taper), and the export-tariff modes;
   - the committed benchmark `scripts/bench-horizon.ts`;
   - the CHANGELOG correction for `preferEarlierPvCharging`.
1. Settings block, types and validation; `data.priceForecast`; `data-store`
   rejects non-finite values.
2. `lib/price-forecast.ts`, `price-forecast-service.ts`, the background
   refresh hook, the accuracy log, the `DOCS.md` section.
3. `resolvePlanningWindow`; load predictors and PV splice, with the truncation
   rule; VRM `publishedUntil`.
4. `lib/forecast-pricing.ts`: resampling, import fit, export relation;
   extended config builder in `config-builder.ts` (`firmEndMs`, `firmSlots`,
   422).
5. `build-lp.ts` LP changes; `parse-solution.ts` row flag and EV nulls;
   `extendedSolveOptions()`.
6. Planner pipeline (firm-only → extended → fallback); fences (Victron
   write, DESS mapper sentinel, current-row users, PV curtailment, plan
   history, summary, `/ev/schedule`, warnings).
7. UI.
8. Scripts:
   - `scripts/horizon-whatif.ts`: compares firm-only and extended plans on a
     snapshot, with `--forecast <file>`, and `--ref <rev>` for the LP-identity
     diff against a git revision. Pure helpers live in
     `scripts/horizon-whatif-config.ts` with tests.
   - `scripts/price-forecast-accuracy.ts`.
9. Docs (CHANGELOG, CLAUDE.md data flow and commands, AGENTS.md tables) and
   version 0.7.72.

## Tests

- **Golden LP hashes** (step 0) stay green: `off` is byte-identical.
- **Settings:** defaults on old files, partial patches, strict and lenient
  validation (mode, extraDays, URL scheme and credentials, region,
  refreshMinutes range).
- **Forecast:**
  - parser: `knownUntil` is inclusive; resolution.
  - service: refresh triggers, failure keeps the stored forecast, staleness,
    background start; tests stub `fetch`.
  - accuracy log: one snapshot per day.
- **Load and PV:** the window by mode; the PV splice (firm part identical);
  truncation at the first null past the old window; the historical
  predictor's sample-count cut.
- **Forecast pricing:**
  - import fit: Theil–Sen; slope bounds; low-spread fallback; MAD rejection;
    stored fit across a year boundary refused; VRM zero slots excluded;
    hourly resampling.
  - export relation: equal, zero, offset, inconsistent; market regime across
    2027-01-01.
- **Config:** `firmEndMs` rules including VRM zero-fill; 422 when the firm
  end has passed even with a valid forecast; `firmSlots` absent when `off`.
- **build-lp:**
  - structure: no binaries after `firmSlots` (parse the `Binaries` section);
  - tie-breaks: capped at `firmSlots − 1`;
  - ratchet: frozen past the boundary;
  - rebalance: `KMAX` within firm; deferred when it does not fit;
  - EV: confined to firm slots;
  - dead-band: both directions.
  - Behaviour:
    - an expensive forecast day keeps charge at the boundary;
    - a cheap one lets it run down;
    - a spread smaller than r changes nothing.
  - The worst case (ratchet + rebalance + continuous EV, about 524 slots)
    solves Optimal within the test timeout.
- **Planner:**
  - pipeline:
    - firm-only fallback on a non-Optimal extended solve, a rejected fit or
      a missing forecast;
    - the rebalance pin is inherited;
    - the EV preview stays firm-only.
  - writes: `firmSlots = 46` writes 46 slots; the fingerprint uses the same
    count.
  - forecast rows: get a sentinel `dess`; current-row users ignore them;
    plan history keeps firm slots only.
  - warnings: correct per series.
- **UI:**
  - the settings card binds, hydrates and saves; the status line;
  - the dashed segment;
  - "—" in the DESS columns;
  - totals are split.
- Coverage stays at 100 % for `api/`, `lib/`, `app/src/`.

## Verification before release

1. `npm run lint`, `typecheck`, `test:coverage`, the Tailwind check.
2. `scripts/bench-horizon.ts` on the dev box: extended solve < 5 s in the
   worst case, firm-only times unchanged.
3. `scripts/horizon-whatif.ts --ref v0.7.71` on a production snapshot with
   `mode: off`: identical LP.
4. After installing with `mode: collect` for a few days:
   - run `horizon-whatif` on production snapshots at 09:00, 14:00 and 22:00,
     and on a Thursday or Friday;
   - run `price-forecast-accuracy` to set `riskMargin`.

## Rollout

1. Merge and publish 0.7.72; install manually.
2. Set `extendedHorizon.mode = "collect"` for about a week: check the
   forecast status line, the fit values and the accuracy script.
3. Set the risk margin from the measured error, then `mode = "on"`. Watch the
   SoC at midnight, the fallback warnings and solve times in the log.
4. If the public endpoint proves unreliable, self-host EpexPredictor in
   Docker and change `forecastUrl`.

## Open decisions (defaults chosen)

- `extraDays: 3`, `riskMargin: 1.0` c/kWh (to be retuned from the log).
- EV charging is not planned in forecast slots.
- Coarser slots for forecast days are rejected: about 30 places assume a
  uniform step, and binary-free forecast slots already make the extended
  solve cheap.
