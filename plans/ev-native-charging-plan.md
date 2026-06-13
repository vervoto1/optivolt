# EV Native Charge Planning — Feature Parity Plan

## Status

Planned. Not started. Builds on the completed work in
`plans/ev-charging-plan.md` (native LP-integrated planned charging already
ships). This document is a self-contained build brief.

## Goal

Make **OptiVolt the EV charge planner** with the full feature set of the Home
Assistant **EV Smart Charging** integration
(`jonasbkarlsson/ev_smart_charging`), so the external integration's *planning*
logic can be retired. The EV screen gains the settings that integration has and
OptiVolt currently lacks — notably **low-price charging** and **low-SoC
charging** — plus price limit, minimum SoC, opportunistic charging, continuous
charging, keep-on, and an earliest-start window.

OptiVolt continues to **plan only**; Home Assistant continues to **actuate** the
physical charger (Tesla Wall Connector, 11 kW). OptiVolt exposes the plan and
the live decision over `/ev/*`; an HA automation drives the charger from it (see
the Appendix). This preserves OptiVolt's design rule: "HA controls the physical
charger, OptiVolt only plans."

---

## What exists today (read first)

### Native LP planned charging (already merged)

`Settings` in `api/types.ts` already has the EV block:

```ts
evEnabled: boolean;
evMinChargeCurrent_A: number;
evMaxChargeCurrent_A: number;
evBatteryCapacity_kWh: number;
evSocSensor: string;
evPlugSensor: string;
evDepartureTime: string;        // "ready by" (ISO local datetime)
evTargetSoc_percent: number;
evChargeEfficiency_percent: number;
```

- `lib/build-lp.ts` adds EV flow variables following the `{source}_to_{sink}_{t}`
  pattern: `grid_to_ev_t`, `pv_to_ev_t`, `battery_to_ev_t`. Total per slot
  `ev_charge_t = g2ev + pv2ev + b2ev`, bounded by min/max power
  (`current_A × 230 V`) with a binary on/off, and EV SoC is tracked with a hard
  "reach target by departure slot" constraint.
- `lib/parse-solution.ts` extracts `ev_charge`, `ev_charge_A`, `ev_charge_mode`,
  `g2ev`, `pv2ev`, `b2ev`, `ev_soc_percent` per row.
- `api/services/config-builder.ts` builds the EV solver config from settings +
  data.
- `api/routes/ev.ts` exposes `GET /ev/schedule` (full per-slot plan + summary)
  and `GET /ev/current` (current slot's decision, `is_charging`).
- UI: the **EV tab** (`panel-ev` in `app/index.html`, logic in
  `app/src/ev-tab.js`, settings wiring in `app/src/ev-settings.js`) shows ready-by
  time, target SoC, live SoC/plug from HA, a charge split (grid/battery/PV), cost
  and effective rate, and per-slot mode rows. The Settings tab also has an "EV
  Charging" card.

### Legacy external-schedule reader (to be superseded)

`api/services/ha-ev-service.ts` + `EvConfig` in `api/types.ts`
(`scheduleSensor`, `scheduleAttribute`, `connectedSwitch`, `alwaysApplySchedule`,
`chargerPower_W`, `disableDischargeWhileCharging`) read the **external** EV
Smart Charging integration's `charging_schedule` attribute and inject it as
`evLoad`. Once native planning has parity, this path becomes optional. **Do not
delete it** in this work — keep it as a selectable EV source for backward
compatibility (see "Source selection" below).

---

## The EV Smart Charging features to port

Mapped from the integration's entities (`const.py`, `number.py`, `switch.py`,
`coordinator.py`, `helpers/coordinator.py`). Each row notes how OptiVolt should
realize it: as a **day-ahead LP** element (planned, cost-optimal) or as a
**runtime override** (reacts to live price/SoC, applied after the solve).

| EV Smart Charging feature | Entity | OptiVolt realization |
|---|---|---|
| Smart charging activated | `switch.smart_charging_activated` | `evEnabled` (exists) |
| Ready-by time | `select.charge_completion_time` | `evDepartureTime` (exists) |
| Earliest-start time | `select.charge_start_time` | NEW `evStartTime` → LP mask |
| Target SoC | (target SoC sensor) | `evTargetSoc_percent` (exists) |
| Charging speed (%/h) | `number.charging_speed` | NEW `evChargingSpeed_pct_per_h` (derive/display; see notes) |
| Price limit on/off + value | `switch.apply_price_limit` + `number.electricity_price_limit` | NEW `evApplyPriceLimit` + `evMaxPrice_cents_per_kWh` → LP mask + soft target |
| Minimum SoC | `number.minimum_ev_soc` | NEW `evMinSoc_percent` → LP floor + runtime override |
| Opportunistic charging + level | `switch.opportunistic_charging` + `number.opportunistic_level` | NEW `evOpportunisticEnabled` + `evOpportunisticLevel_percent` → LP value band |
| Opportunistic type 2 + level | `switch.opportunistic_type2_charging` + `number.opportunistic_type2_level` | NEW `evOpportunisticType2Enabled` + `evOpportunisticType2Level_percent` → LP value band |
| Low-price charging + level | `switch.low_price_charging` + `number.low_price_charging_level` | NEW `evLowPriceChargingEnabled` + `evLowPriceChargingLevel_cents_per_kWh` → **runtime override** |
| Low-SoC charging + level | `switch.low_soc_charging` + `number.low_soc_charging_level` | NEW `evLowSocChargingEnabled` + `evLowSocChargingLevel_percent` → **runtime override** |
| Continuous charging preferred | `switch.continuous_charging_preferred` | NEW `evContinuous` → MILP contiguity penalty |
| Keep charger on | `switch.keep_charger_on` | NEW `evKeepOn` → **runtime override** |

### Semantics (from `coordinator.py`)

- **Low-price charging** (override): when the switch is on **and** the *current*
  buy price is at or below `low_price_charging_level`, charge **now** at full
  power regardless of the plan. Status becomes `low_price_charging`.
- **Low-SoC charging** (override): when the switch is on **and** the *current* EV
  SoC is **below** `low_soc_charging_level`, charge **now** regardless of price
  or plan. Status becomes `low_soc_charging`. This has **priority over**
  low-price.
- **Minimum SoC**: bring the EV up to `min_soc` as soon as possible (a hard
  safety floor), independent of price.
- **Price limit**: never charge in slots whose price exceeds the limit. If the
  cheap-enough slots are insufficient to hit the target, the target is **not**
  forced — the car simply ends below target. (This makes the day-ahead target a
  *soft* objective under a price-limit *hard* mask.)
- **Opportunistic**: when charging anyway / when prices are favourable, top the
  EV up beyond the target toward the opportunistic level. Type 2 is a second,
  higher band (level can exceed 100% in the integration's UI; clamp to a sane
  cap such as 100% for SoC banding here).
- **Continuous**: prefer a single contiguous charging block over the absolute
  cheapest scattered slots, to reduce charger on/off cycling.
- **Keep-on**: once charging has begun, keep the charger energized until the
  ready time / target rather than pausing between cheap slots.

### Priority order for the live decision

`low_soc` > `low_price` > `min_soc floor` > `planned (LP)` > idle. `keep_on`
holds the charger on once started within the active charging window.

---

## Design: LP layer vs runtime-override layer

OptiVolt's strength is a **day-ahead, system-wide cost-optimal** LP. EV Smart
Charging mixes day-ahead planning with **real-time reactions**. Split the port
accordingly:

- **LP / planning layer** (`lib/build-lp.ts`, `lib/types.ts`,
  `api/services/config-builder.ts`): earliest-start window, price-limit mask,
  **soft** target SoC, minimum-SoC floor, opportunistic value bands, continuous
  contiguity penalty. These shape the persisted plan and the Victron DESS
  schedule.
- **Runtime-override layer** (new `api/services/ev-decision-service.ts`, used by
  `api/routes/ev.ts`): low-price, low-SoC, keep-on. These read **live** price +
  EV SoC at request time and override the planned decision for `/ev/current`
  (and annotate `/ev/schedule`). They do **not** require re-solving the LP.

This keeps the expensive solve day-ahead while the reactive behaviors stay live
and cheap, exactly matching the integration's feel.

---

## Settings additions

### `api/types.ts` (extend the EV block in `Settings`)

```ts
evStartTime?: string;                          // earliest charge time (ISO local), optional
evChargingSpeed_pct_per_h?: number;            // informational/derived (see notes)
evApplyPriceLimit?: boolean;
evMaxPrice_cents_per_kWh?: number;
evMinSoc_percent?: number;
evOpportunisticEnabled?: boolean;
evOpportunisticLevel_percent?: number;
evOpportunisticType2Enabled?: boolean;
evOpportunisticType2Level_percent?: number;
evLowPriceChargingEnabled?: boolean;
evLowPriceChargingLevel_cents_per_kWh?: number;
evLowSocChargingEnabled?: boolean;
evLowSocChargingLevel_percent?: number;
evContinuous?: boolean;
evKeepOn?: boolean;
evSource?: 'native' | 'haSchedule';            // default 'native'; 'haSchedule' = legacy reader
```

Add matching defaults to `api/defaults/default-settings.json` and validation in
`api/services/settings-schema.ts` (booleans, numeric ranges: percentages
0..100, prices may be negative, times are ISO strings or empty).

Notes on **charging speed (%/h)**: EV Smart Charging needs it because it does not
know charger power; OptiVolt already knows `evBatteryCapacity_kWh` and min/max
power, so it derives charge rate directly. Keep `evChargingSpeed_pct_per_h` as an
optional *display/derived* value (and, if set, an alternative way to express max
power = `pct_per_h/100 × capacity_kWh × 1000`). The min/max current settings
remain the source of truth for the LP; surface the implied %/h read-only in the
UI so users migrating from EV Smart Charging recognize it.

---

## LP / planning changes

### `lib/types.ts` — extend `SolverConfig` EV fields

Add: `evStartSlot?` (index of earliest allowed slot), `evMaxPrice_cents_per_kWh?`
+ `evApplyPriceLimit?`, `evMinSoc_percent?`, `evOpportunisticLevel_percent?` +
`evOpportunisticEnabled?` (and the type-2 pair), `evContinuous?`, plus the soft
target controls below.

### `api/services/config-builder.ts`

Translate the new settings into `SolverConfig`: resolve `evStartTime` /
`evDepartureTime` to slot indices over the plan horizon; pass price-limit, min
SoC, opportunistic levels, and continuity through. Effective opportunistic cap =
`max(targetSoc, opportunisticLevel, type2Level if enabled)` clamped to 100%.

### `lib/build-lp.ts`

1. **Earliest-start + ready window mask.** Force `ev_charge_t = 0` for
   `t < evStartSlot` and `t > departureSlot` (the upper bound likely exists; add
   the lower bound).
2. **Price-limit mask.** When `evApplyPriceLimit`, force `ev_charge_t = 0` for
   every slot whose import price exceeds `evMaxPrice_cents_per_kWh`. (Mask total
   EV charge, not just `grid_to_ev`, to mirror the integration, which suppresses
   charging entirely in over-limit slots.)
3. **Soft target SoC.** Replace the hard "EV SoC ≥ target at departure" equality
   with a soft constraint: introduce a non-negative shortfall variable
   `ev_target_shortfall` with `ev_soc_departure + ev_target_shortfall ≥ target`
   and add `BIG_PENALTY × ev_target_shortfall` to the objective. With a price
   mask in place this keeps the model **feasible** when cheap slots are
   insufficient, and the optimizer still hits the target whenever it can. Keep
   the penalty well above any realistic energy price so target is honored unless
   physically/price-mask blocked.
4. **Minimum-SoC floor (hard).** Add `ev_soc_t ≥ evMinSoc_percent` for all slots
   at/after the first slot in which the floor is physically reachable from the
   starting SoC at max power. Min SoC is a safety floor and is **not** subject to
   the price mask — exempt min-SoC-driven charging slots from the mask (e.g. a
   dedicated `ev_floor_charge_t` term, or relax the mask until the floor is met).
5. **Opportunistic value band.** For SoC above target up to the opportunistic
   cap, add a small **negative cost** (reward) on stored EV energy valued at the
   opportunistic price threshold, so the optimizer fills that band only when it
   is cheap. Implement as a marginal value on the EV SoC band above target, not
   as a constraint. Type 2 is a second band with its own (higher) cap; value it
   at most the same or a configurable threshold.
6. **Continuity penalty (MILP, optional / phase 2).** OptiVolt already uses MILP
   binaries (CV phase). Reuse the EV on/off binary `ev_on_t` and add transition
   variables capturing `ev_on_t XOR ev_on_{t-1}`; penalize the count of
   transitions with a small objective weight when `evContinuous`. This biases the
   solver toward one contiguous block without hard-forcing it.

### `lib/parse-solution.ts`

Surface the new outputs: `ev_soc_percent` already exists; add `ev_target_met`
(boolean from shortfall ≈ 0) and ensure `ev_charge_mode` reflects planned vs
opportunistic vs floor (`planned` / `opportunistic` / `min_soc`). The
override-driven modes (`low_price`, `low_soc`, `keep_on`) are assigned in the
runtime layer, not here.

### `lib/dess-mapper.ts`

No structural change required — it already consumes EV flows and applies EV
discharge constraints. Verify the soft-target change does not alter the mapping
contract (the mapper reads realized `ev_charge`, not the target).

---

## Runtime-override layer

### New `api/services/ev-decision-service.ts`

`computeEvDecision(settings, lastPlan)` → the **effective current decision**:

1. Read live EV SoC (from `evSocSensor` via `fetchHaEntityState`) and the current
   buy price (from the price source already used by the planner / the current
   plan row). Read plug status (`evPlugSensor`) if present.
2. Determine the active mode by priority:
   - If `evLowSocChargingEnabled` and `liveSoc < evLowSocChargingLevel_percent`
     → mode `low_soc`, charge at max power.
   - Else if `evLowPriceChargingEnabled` and
     `currentPrice ≤ evLowPriceChargingLevel_cents_per_kWh` → mode `low_price`,
     charge at max power.
   - Else if min-SoC floor not yet met → mode `min_soc`, charge at max power.
   - Else fall back to the planned decision from `lastPlan` for the current slot
     (`planned` / `opportunistic` / idle).
   - `evKeepOn`: if charging is active and within the charge window, do not drop
     to idle between planned slots — hold on until ready time / target.
3. Respect plug status: if not connected and the override is not configured to
   force regardless, report idle (mirror `alwaysApplySchedule` behavior — add an
   equivalent for native mode, e.g. overrides require plug-connected unless a
   future "force" flag says otherwise).
4. Return `{ mode, is_charging, ev_charge_W, ev_charge_A, reason }`.

### `api/routes/ev.ts` changes

- `GET /ev/current`: replace the raw "current plan row" with
  `computeEvDecision(...)` output (so low-price/low-SoC overrides are reflected
  live). Keep returning the plan-derived flow split for context.
- `GET /ev/schedule`: annotate each future slot with the mode it would take under
  the overrides given forecast price (e.g. mark slots with
  `price ≤ lowPriceLevel` as `low_price` when that switch is on), so the HA side
  and the EV tab can preview reactive behavior. The planned charge stays the LP
  result; the annotation is advisory.
- Add `GET /ev/status` (optional): a compact `{ mode, is_charging, liveSoc,
  targetSoc, targetMet, readyBy }` object convenient for a single HA sensor.

---

## Front-end changes

### EV settings controls (`app/index.html`)

Add controls to the **EV tab** Settings card (`panel-ev`) and/or the Settings-tab
"EV Charging" card, using existing `toggle` / `form-input` / `sidebar-label`
styles and the `data-settings-input` auto-persist convention. Group as:

- **Window**: earliest-start (`datetime-local`, optional), ready-by (exists),
  target SoC (exists), minimum SoC (number %).
- **Price**: apply-price-limit toggle + max price (¢/kWh) number.
- **Opportunistic**: enable toggle + level (%), plus type-2 enable + level.
- **Reactive overrides**: low-price toggle + level (¢/kWh); low-SoC toggle +
  level (%); keep-charger-on toggle.
- **Behavior**: continuous-charging toggle.
- **Source**: a small select for `evSource` (`native` default / `haSchedule`
  legacy) — when `haSchedule`, hide the native-only controls and show the
  existing `EvConfig` schedule-sensor fields.
- Show the derived **charging speed (%/h)** as a read-only hint next to the
  power/current fields.

Each new control needs: the element id, registration in
`app/src/ui-binding.js` (`getElements()`), hydrate in `app/src/state.js`
(`hydrateUI`), and inclusion in `snapshotUI()` so it round-trips through
`POST /settings`. Mirror how the existing EV fields are wired.

### EV tab status (`app/src/ev-tab.js`, `app/src/ev-settings.js`)

- Show a **mode badge** on the EV status card driven by `GET /ev/current` /
  `GET /ev/status`: `Planned` / `Low price` / `Low SoC` / `Min SoC` /
  `Opportunistic` / `Keep on` / `Idle`, colour-coded (reuse emerald for active
  charging, a price-tint via `getBuyPriceColor` for low-price, amber for low-SoC).
- Add a "Target met by ready time" indicator (green check / shortfall amount)
  from `ev_target_met` / shortfall.
- Keep the existing split bar, cost, and per-slot mode rows; extend the mode-row
  colouring to include the new modes.

---

## Phases

| Phase | Scope | Output |
|-------|-------|--------|
| 1 | Settings: new EV fields + defaults + schema; UI inputs wired (no behavior yet) | Settings round-trip; controls visible |
| 2 | LP masks: earliest-start + price limit; soft target SoC | Plan respects window + price ceiling; stays feasible |
| 3 | Minimum-SoC floor | EV guaranteed to reach min SoC ASAP, mask-exempt |
| 4 | Runtime overrides: low-price + low-SoC + keep-on in `ev-decision-service` + `/ev/current` | Live decision flips to override modes correctly |
| 5 | Opportunistic value bands (incl. type 2) | EV tops up beyond target only when cheap |
| 6 | EV tab mode badge + target-met indicator + schedule annotation | UI surfaces active/forecast mode |
| 7 (optional) | Continuous-charging MILP contiguity penalty | Fewer charge on/off cycles when enabled |
| 8 | HA actuation glue documented + sample automation (Appendix) | HA drives charger from OptiVolt decision |

Phases 1–6 reach functional parity for the requested low-price / low-SoC / price
limit / min SoC / opportunistic settings. 7 is a refinement; 8 is the HA-side
companion.

---

## Testing

Per `AGENTS.md`: `npm run typecheck`, `npm run lint`, `npm run test:run`.

- **`lib/build-lp.ts`** (pure unit tests, `tests/lib/`): price-mask zeros EV
  charge in over-limit slots; earliest-start mask; soft target stays feasible
  when cheap slots are insufficient and still hits target when they are
  sufficient; min-SoC floor reached at the earliest feasible slot and exempt
  from the price mask; opportunistic band only fills below its price threshold.
- **`ev-decision-service`** (`tests/api/`): priority ordering
  (low-SoC > low-price > min-SoC floor > planned); plug-status gating; mode +
  power returned; tolerant of missing HA (falls back to planned).
- **Route tests**: `/ev/current` reflects overrides; `/ev/schedule` annotations;
  `/ev/status` shape.
- **Browser** (`tests/app/`): new settings inputs hydrate and snapshot; mode
  badge renders per `/ev/current`; `haSchedule` source hides native controls.

If a release is cut, bump the 3 version files + `CHANGELOG.md` per `CLAUDE.md`.

---

## Acceptance criteria

- The EV screen exposes **low-price charging** and **low-SoC charging** (toggles
  + levels) plus price limit, minimum SoC, opportunistic (×2), continuous,
  keep-on, and an earliest-start window — matching EV Smart Charging's feature
  set.
- Day-ahead planning honors the earliest-start window and price ceiling, reaches
  minimum SoC as a hard floor, hits target SoC when feasible (soft otherwise),
  and tops up opportunistically only when cheap.
- The live decision (`/ev/current`) flips to **low-SoC** then **low-price**
  overrides by priority, reacting to live SoC and price without re-solving; the
  EV tab shows the active mode.
- OptiVolt remains plan-only; an HA automation actuates the charger from the
  `/ev/*` endpoints (Appendix). The legacy `haSchedule` reader still works when
  selected.
- `npm run typecheck`, `npm run lint`, and `npm run test:run` pass.

---

## Appendix: Home Assistant actuation glue

OptiVolt plans; HA drives the charger. This glue lives in the
`vervoto1/homeassistant` repo, documented here for completeness.

- Expose OptiVolt's decision to HA as a REST sensor polling
  `http://optivolt:3000/ev/status` (or `/ev/current`), surfacing `mode`,
  `is_charging`, and `ev_charge_A`.
- An HA automation reacts to that sensor: start/stop the Tesla Wall Connector and
  set charging current to `ev_charge_A` when `is_charging` is true; stop
  otherwise. The current EV Smart Charging integration can be retired, or kept in
  a passive/manual mode purely as the charger-control shim while OptiVolt owns
  planning.
- Keep the JK BMS safety automation (Victron max charge current) unchanged; it is
  independent of EV planning.
- Because the charger sits behind the Victron inverter, EV draw already affects
  grid import/export in the LP — no extra coupling is needed beyond the existing
  EV flow variables.
