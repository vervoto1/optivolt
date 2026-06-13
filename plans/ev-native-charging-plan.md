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

OptiVolt becomes the **sole owner** of EV charging: it plans, applies the live
overrides, **and actuates the physical charger** (Tesla Wall Connector, 11 kW)
directly via Home Assistant service calls. The goal is to **retire the EV Smart
Charging integration entirely** — OptiVolt does both the deciding and the
driving. It still exposes the plan and live decision over `/ev/*` for
observability. Keeping OptiVolt plan-only with an HA automation as the actuator
remains a supported fallback — see "EV actuation in OptiVolt" below.

> **Note — this expands OptiVolt's role.** Today OptiVolt's only actuator is
> Victron MQTT; everything HA-related is read-only. Adding charger control means
> OptiVolt issues HA **service calls** (a new write path) and runs its own fast
> control loop. The design below makes that safe: idempotent, fail-safe, single
> owner.

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
- **Actuation layer** (new `api/services/ev-actuator-service.ts`): a fast control
  tick that takes the effective decision from the override layer and **drives the
  charger** via HA service calls (`switch.turn_on`/`switch.turn_off`, plus
  optional `number.set_value` for current), idempotently and fail-safe. This is
  the piece that makes OptiVolt independent of the integration. See "EV actuation
  in OptiVolt".

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
// Actuation (OptiVolt drives the charger itself — see "EV actuation in OptiVolt")
evActuationEnabled?: boolean;                  // default false; when true OptiVolt controls the charger
evChargerSwitchEntity?: string;                // switch.* that starts/stops charging
evChargerCurrentEntity?: string;               // number.* charge current in A (optional)
evControlIntervalSeconds?: number;             // actuator tick cadence, default 60
evFailSafeMode?: 'hold' | 'stop';              // on error/restart: 'hold' = no write (default), 'stop' = turn off
evActuationPaused?: boolean;                    // user kill-switch to suspend OptiVolt charger control
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

> **CRITICAL — reconcile with the existing target clamp.** Today
> `config-builder.ts:131` does
> `achievableTargetWh = Math.min(requestedTargetWh, initialWh + maxChargeable_Wh, capacityWh)`
> and passes the *clamped* value as `evTargetSoc_percent`. That clamp exists only
> to keep today's **hard** `c_ev_target` equality feasible. Once the target
> becomes **soft** (below), this clamp becomes harmful: it silently lowers the
> target before the LP sees it, so `ev_target_shortfall` reads ~0 and
> `ev_target_met` reports "met" while the car is below the user's *requested*
> SoC. **Change the clamp to a capacity-only cap**
> (`Math.min(requestedTargetWh, capacityWh)`) and let the soft constraint carry
> feasibility. Pick exactly one feasibility mechanism — clamp **or** soft target,
> not both.
>
> **Guard the window.** After resolving slots, require `evStartSlot < depSlot`.
> If the window is empty (start ≥ departure, or departure already elapsed →
> `departureTimeToSlot` returns 0), disable EV planning for this solve rather
> than emitting masks that zero every slot (which, combined with the cardinality
> bound below, would make the model infeasible). Log the reason.

### `lib/build-lp.ts`

1. **Earliest-start + ready window mask.** Force `ev_charge_t = 0` for
   `t < evStartSlot` and `t ≥ depSlot`. The upper-bound side already exists
   implicitly (the SoC target lives at `depSlot - 1`); add the lower bound by
   pinning the flow bounds to 0 (`gridToEv`/`pvToEv`/`batteryToEv` upper bound 0)
   and forcing `ev_on_t = 0` for masked slots, so the cardinality bound (#3a)
   counts only reachable slots.
2. **Price-limit mask.** When `evApplyPriceLimit`, force `ev_charge_t = 0` for
   every slot whose import price exceeds `evMaxPrice_cents_per_kWh` — pin the
   three EV flow bounds to 0 and `ev_on_t = 0` (same mechanism as #1). Mask
   *total* EV charge, not just `grid_to_ev`, to mirror the integration.
   **Exception:** slots needed by the min-SoC floor (#4) are never masked.
3. **Soft target SoC.** Replace the hard `c_ev_target` (`build-lp.ts:445`,
   `ev_soc_{depSlot-1} ≥ evTargetWh`) with a soft constraint: add a non-negative
   `ev_target_shortfall` and the constraint
   `ev_soc_{depSlot-1} + ev_target_shortfall ≥ evTargetWh`, plus
   `BIG_PENALTY × ev_target_shortfall` in the objective. `BIG_PENALTY` must sit
   **above** the largest per-Wh import cost in the horizon but **below** the
   `softMinSocPenalty`/`TIEBREAK` scales so it doesn't distort battery economics —
   reuse the existing magnitude discipline (the TIEBREAK ladder is `5e-7…4e-6`;
   the shortfall penalty is a *large* coefficient, e.g. `100` c€/Wh, far above any
   realistic price). Surface `ev_target_shortfall` in the solution so
   `parse-solution` can derive `ev_target_met`.

   3a. **Remove/recompute the cardinality lower bound.** `c_ev_min_on`
   (`build-lp.ts:462`, `Σ ev_on_t ≥ kMin`) was derived from the *hard* deficit and
   assumes every slot is available. With a soft target and/or any mask it can
   force more on-slots than exist among reachable slots → **infeasible LP** (the
   exact failure the soft target is meant to prevent). Fix: when a mask or the
   soft target is active, either (a) drop `c_ev_min_on` entirely, or (b) recompute
   `kMin = min(kMin, count(reachable, non-masked slots in [evStartSlot, depSlot)))`.
   Prefer (b) only if you still want the relaxation-tightening; (a) is simpler and
   safe. This is the single highest-risk LP interaction — cover it with the
   regression test in Testing.
4. **Minimum-SoC floor (hard, MILP-gated, mask-exempt).** A *static* mask cannot
   express "exempt the floor slots" because the floor slots aren't known at build
   time. Use a MILP indicator instead:
   - Add `ev_soc_t ≥ evMinFloorWh` for all `t` at/after the first slot the floor
     is physically reachable from `evInitialWh` at max power (a hard floor, like
     today's soc bounds — independent of price).
   - Introduce a binary `ev_floor_active_t` and a separate flow term
     `ev_floor_charge_t` (AC into the charger) that is **excluded from the price
     mask**. Bound `ev_floor_charge_t = 0` whenever the floor is already satisfied
     (`ev_soc_{t-1} ≥ evMinFloorWh` ⇒ via the indicator), and route it into
     `c_ev_soc_t` exactly like `grid_to_ev` (AC, `evChargeWhPerW` factor).
   - The floor charge competes with nothing on price (it's a safety obligation),
     so it carries only the normal import cost in the objective, no mask, no
     opportunistic reward.

   ```
   PRICE-MASK vs MIN-SOC-FLOOR (decision)
     slot t price > limit?
        │ no ──► normal masked planning (ev_charge_t free, c_ev_target soft)
        └ yes ─► ev_charge_t = 0  (masked)
                    │
                    └─ but ev_soc_{t-1} < evMinFloorWh ?
                          │ no ──► stays masked (0)
                          └ yes ─► ev_floor_charge_t > 0 allowed (mask-exempt,
                                    pays import cost, bounded by evMaxPow_W)
   ```
5. **Opportunistic value band (bounded reward).** For SoC above target up to the
   opportunistic cap, add a small **negative cost** on stored EV energy in that
   band. The reward magnitude must be **strictly less** than the marginal import
   cost of the cheapest slot that could fill the band, in every slot — otherwise
   the solver fills to the cap regardless of price ("opportunistic" degenerates to
   "always fill"). Concretely: value the band at the *opportunistic price
   threshold minus an epsilon*, and verify the sign/magnitude ordering holds
   against `BIG_PENALTY` (shortfall), `batteryCost_cents`, and the TIEBREAK ladder.
   Type 2 is a second, higher band with its own cap valued at most the same.
   Implement as a marginal value on the EV SoC band above target (segmented SoC
   variable), not a constraint.
6. **Continuity penalty (MILP, optional / phase 7).** Reuse `ev_on_t` and add
   transition variables capturing `ev_on_t XOR ev_on_{t-1}`; penalize the
   transition count with a small objective weight when `evContinuous`. Biases
   toward one contiguous block without hard-forcing it.

### `lib/parse-solution.ts`

> **CRITICAL — do NOT overload `ev_charge_mode`.** `ev_charge_mode` already
> exists as the **hardware-actuation hint** enum `EvChargeMode`
> (`off | fixed | solar_only | solar_grid | max`, `lib/types.ts:136`, computed in
> `parse-solution.ts:127`/`evChargeMode()`), and it is **consumed by
> `lib/dess-mapper.ts`** to pick charger amps/strategy. Writing planning labels
> (`planned`/`opportunistic`/`min_soc`/…) into it would silently break DESS
> mapping.

Add a **separate** field `ev_plan_mode: 'planned' | 'opportunistic' | 'min_soc'`
(planning semantics), leave `ev_charge_mode` untouched, and add `ev_target_met`
(boolean from `ev_target_shortfall ≈ 0`). The override-driven plan modes
(`low_price`, `low_soc`, `keep_on`) are assigned in the runtime layer and live on
the decision object, not on the plan row.

### `lib/dess-mapper.ts`

No structural change required — it already consumes EV flows and applies EV
discharge constraints. **Verify two things:** (1) the soft-target change does not
alter the mapping contract (the mapper reads realized `ev_charge`, not the
target), and (2) `ev_charge_mode` semantics are unchanged (per the
`ev_plan_mode` split above) so DESS amp/strategy selection is unaffected.

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
| 8 | HA service-call write path (`callHaService`) + charger control settings | OptiVolt can switch the charger + set current via HA |
| 9 | EV actuator service (fast tick, idempotent, fail-safe) + cutover | OptiVolt owns EV charging end-to-end; integration uninstalled |

Phases 1–6 reach **decision parity** for low-price / low-SoC / price limit /
min SoC / opportunistic. 7 refines charge-cycling. **8–9 give OptiVolt charger
actuation so the EV Smart Charging integration can be removed entirely** — this
is the difference between "OptiVolt has all the planning logic" and "OptiVolt is
independent of the integration".

---

## Testing

Per `AGENTS.md`: `npm run typecheck`, `npm run lint`, `npm run test:run`.

- **`lib/build-lp.ts`** (pure unit tests, `tests/lib/`): price-mask zeros EV
  charge in over-limit slots; earliest-start mask; soft target stays feasible
  when cheap slots are insufficient and still hits target when they are
  sufficient; min-SoC floor reached at the earliest feasible slot and exempt
  from the price mask; opportunistic band only fills below its price threshold.
  - **CRITICAL regression — feasibility under mask + cardinality bound.** Build
    a case where the price mask zeros enough slots that fewer than the old `kMin`
    remain, and assert the LP is **feasible** (proves the `c_ev_min_on` fix in
    LP-change #3a). Without this test the soft-target work can ship a solver that
    returns "infeasible" in production.
  - **`ev_plan_mode` vs `ev_charge_mode`.** Assert `ev_charge_mode` retains its
    hardware-hint values and `ev_plan_mode` carries planning labels — guards the
    enum-collision split.
  - **No false "target met".** With the requested target above what's reachable,
    assert `ev_target_met === false` and `ev_target_shortfall > 0` (proves the
    `achievableTargetWh` clamp no longer masks the shortfall).
- **`ev-decision-service`** (`tests/api/`): priority ordering
  (low-SoC > low-price > min-SoC floor > planned); plug-status gating; mode +
  power returned; tolerant of missing HA (falls back to planned).
- **Route tests**: `/ev/current` reflects overrides; `/ev/schedule` annotations;
  `/ev/status` shape; `/ev/actuation` reports last command.
- **`ev-actuator-service`** (`tests/api/`): idempotent writes (no duplicate
  service call when desired state is unchanged); fail-safe (no charger write on
  HA error / missing plan / restart); plug-gating; `evFailSafeMode: 'stop'`
  issues a single `turn_off` on sustained error; `evActuationPaused` suspends
  control; mock `callHaService`.
  - **Boot seeding (regression).** First tick after start reads observed charger
    state, seeds `lastCommand`, and issues **no** write (no blip); tick 2 applies
    a plan change. Asserts the "clean startup" semantics.
  - **No plan source.** With `getLastPlan()` null / auto-calculate disabled, the
    actuator makes no write and reports `status: 'no_plan_source'`.
  - **Stale plug status.** `evPlugSensor` returning `unavailable` produces a
    no-write (uncertain), NOT a `turn_off`.
  - **Contention detection.** Observed state diverging from commanded for N ticks
    flags contention (and auto-pauses if configured).
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
- With `evActuationEnabled`, OptiVolt **drives the charger directly** via HA
  service calls on a fast control tick — idempotently and fail-safe (no charger
  write on error or restart) — so the **EV Smart Charging integration can be
  uninstalled**. Plan-only + an HA actuation automation remains a supported
  fallback, and the legacy `haSchedule` reader still works when selected.
- `npm run typecheck`, `npm run lint`, and `npm run test:run` pass.

---

## EV actuation in OptiVolt

This is the piece that makes OptiVolt **independent** of the EV Smart Charging
integration: OptiVolt drives the physical charger itself via Home Assistant
service calls, so the integration can be uninstalled. (If you prefer to keep
OptiVolt plan-only, skip this and use the HA-automation fallback at the end.)

### HA service-call write path (`api/services/ha-client.ts`)

OptiVolt's `ha-client.ts` is read-only today. Add a generic writer:

```ts
callHaService({ haUrl, haToken, domain, service, target, data }):
  Promise<void>;   // POST {baseUrl}/api/services/{domain}/{service}
```

Reuse `resolveHaHttpConfig` for credentials: in add-on mode it posts through the
supervisor proxy (`http://supervisor/core` + `SUPERVISOR_TOKEN`). The add-on
manifest **already declares `homeassistant_api: true`** (`optivolt/config.yaml:19`),
so the supervisor already allows service calls — no manifest change is needed.
Keep the function generic — the EV actuator is just its first caller (the ESS
plan's writable max-charge-current, ESS phase 8, is the second; build this once).

### Actuator service (`api/services/ev-actuator-service.ts`)

A lightweight control loop, **separate** from the 15-min planner, registered at
server start the same way `api/services/auto-calculate.ts` is wired:

1. Every `evControlIntervalSeconds` (default 60), compute the effective decision
   with `computeEvDecision(settings, getLastPlan())` from the override layer.

   > **Dependency — actuation needs a current plan, which needs auto-calculate.**
   > `getLastPlan()` is populated only by `auto-calculate.ts`, which is opt-in
   > (`if (!config?.enabled) return;`). If a user enables `evActuationEnabled`
   > but not `autoCalculate`, `getLastPlan()` is `null` forever and (per
   > fail-safe) the charger is never driven — a **silent** dead feature. Surface
   > this: on actuator start, if auto-calculate is disabled, log a warning and
   > report it in `GET /ev/actuation` (`status: 'no_plan_source'`). Optionally
   > trigger a solve from the actuator. Add a startup-validation test.
2. Gate first: if `!evActuationEnabled` or `evActuationPaused`, do nothing.
   Plug-status gating with **staleness awareness**: read `evPlugSensor`; if the
   value is `unavailable`/`unknown` (a transient HA hiccup), treat it as
   **uncertain → no write** (per fail-safe), NOT as "unplugged → turn off".
   Only a *fresh, definite* not-connected state ensures the charger is off
   (subject to fail-safe).
3. Drive the charger **idempotently** — only issue a service call when the desired
   state differs from the last command OptiVolt sent (track last command in
   memory):
   - on/off via `callHaService('switch', is_charging ? 'turn_on' : 'turn_off', { entity_id: evChargerSwitchEntity })`
   - charge current, if `evChargerCurrentEntity` is set, via
     `callHaService('number', 'set_value', { entity_id: evChargerCurrentEntity }, { value: ev_charge_A })`
4. **Single-owner contention detection.** Each tick, compare the *observed*
   charger state against the state OptiVolt last commanded. If they diverge for
   N consecutive ticks despite OptiVolt not writing (something else is toggling
   the charger), log it and (optionally) auto-pause — this is the only signal
   OptiVolt has that a second controller is fighting it.
5. Record the last actuation (mode, command, value, observed-vs-commanded,
   timestamp, ok/error) in memory for `GET /ev/actuation` and the EV-tab badge.

Add a small `GET /ev/actuation` route returning that last-actuation record for
observability.

> **Cadence note.** The actuator ticks every ~60 s on *live* SoC/price but the
> planned fallback (`getLastPlan()`) is refreshed only every ~15 min and is
> replaced wholesale with no locking. That's acceptable (the override layer
> reacts live; the plan is a slow baseline), but document that a tick may read a
> plan up to one interval stale, and ensure reads of `getLastPlan()` tolerate it
> being swapped mid-tick (snapshot the reference once per tick).

### Fail-safe and ownership rules

- **Single owner (procedural, with a detection backstop).** When
  `evActuationEnabled`, OptiVolt is the *intended* only writer to the charger
  entities. Nothing in OptiVolt can technically *prevent* a second controller
  (the EV Smart Charging integration, or a stray HA automation) from also
  toggling the switch — idempotency only stops OptiVolt from spamming, it cannot
  stop the other writer. The cutover steps are the primary guard; the
  contention-detection in the actuator loop (step 4) is the backstop that surfaces
  a missed cutover instead of letting the charger flap silently.
- **Don't fight the battery-protection automation.** The Tesla draws through the
  Victron inverter, and an independent JK BMS / Victron *max-charge-current*
  automation may throttle charge current for battery protection (see
  `CLAUDE.md` and the ESS dashboard plan). When that automation caps current,
  OptiVolt will command the charger on at planned amps and see SoC not rising;
  the low-SoC override must **not** escalate into a fight (e.g. cap commanded
  current to the BMS-allowed value if `evChargerCurrentEntity` is driven, and
  treat "on but not charging" as the BMS's call, not a fault).
- **Fail-safe = no write on uncertainty.** On any error (HA unreachable, missing
  live SoC/price, no current plan, stale plug status) the actuator makes **no**
  charger write — the charger holds its last physical state. Never leave the
  charger forced-on as a side effect of a failure. `evFailSafeMode: 'stop'` is an
  opt-in stricter mode that issues a single `turn_off` on sustained error.
- **Respect manual control.** A user toggling the charger by hand should not be
  instantly reverted; `evActuationPaused` suspends OptiVolt control, and the
  idempotent design avoids spamming writes.
- **Clean startup (precise semantics).** "No write on restart" and "idempotent"
  must not contradict each other. On boot: **tick 1** reads the charger's current
  observed state and *seeds* `lastCommand = observed` and writes **nothing**
  (no blip). From **tick 2** onward, normal idempotent writes apply (write only
  when desired ≠ `lastCommand`). This means a plan change that occurred during the
  downtime *is* applied on tick 2 — "no write on restart" scopes to the first
  tick only, it is not "never write until the user changes something".

### Cutover — retire the integration

1. Configure `evChargerSwitchEntity` (and optionally `evChargerCurrentEntity`),
   then enable `evActuationEnabled`.
2. Disable the EV Smart Charging integration's charger control (or uninstall it)
   so there is a single owner.
3. Verify a full cycle: plug in below target → OptiVolt charges in the planned
   cheap slots; force a low-SoC or low-price condition → OptiVolt charges
   immediately; reach target → OptiVolt stops.
4. Leave the JK BMS safety automation (Victron max charge current) unchanged — it
   is independent of EV charging. The charger sits behind the Victron inverter,
   so EV draw already affects grid import/export in the LP; no extra coupling is
   needed beyond the existing EV flow variables.

### Fallback — keep OptiVolt plan-only (optional)

Leave `evActuationEnabled` off and drive the charger from an HA automation that
polls `GET /ev/current` / `GET /ev/status` (`mode`, `is_charging`,
`ev_charge_A`) and calls `switch.turn_on` / `switch.turn_off` (+ current).
Same decision source; actuation just lives in HA instead of OptiVolt.
