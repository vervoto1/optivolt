import type { PlanRow, SolverConfig, EvChargeMode, EvPlanMode } from './types.ts';
import { DEFAULT_INVERTER_EFFICIENCY_PERCENT, evChargeWattsPerAmp } from './build-lp.ts';

// Minimal type for the HiGHS solver result columns (keyed by variable name).
interface HighsColumn {
  Primal?: number;
}

export interface HighsSolution {
  Status?: string;
  ObjectiveValue?: number;
  Columns?: Record<string, HighsColumn>;
}

interface ParseSolutionOpts {
  startMs: number;
  stepMin: number;
}

export function parseSolution(result: HighsSolution, cfg: SolverConfig, opts: ParseSolutionOpts): PlanRow[] {
  const T = cfg.load_W.length;

  const timestampsMs = synthesizeFromStart(opts.startMs, opts.stepMin, T);

  const cap = Math.max(1e-9, cfg.batteryCapacity_Wh);
  // v8 ignore next — trivial Math.max always true branch in practice
  const evCap = Math.max(1e-9, cfg.ev?.evBatteryCapacity_Wh ?? 1);
  // Watts-per-amp for the EV charge-current readout. Shared factor with
  // config-builder's amps->watts so the LP build and the parse agree.
  const evWattsPerAmp = evChargeWattsPerAmp(cfg.ev?.evChargePhases);
  // Inverter efficiency: variables that cross the DC→AC boundary in the LP are
  // emitted as DC W; downstream consumers (plan-summary, plan-accuracy, DESS
  // mapper, UI) expect AC-side numbers matching the AC meter VRM reports.
  // Apply η_inv once here at the LP→PlanRow boundary for those flows.
  // Default MUST match buildLP's signature default — otherwise callers who omit
  // the field get the LP built at one efficiency and AC reported at another.
  const eta_inv = (cfg.inverterEfficiency_percent ?? DEFAULT_INVERTER_EFFICIENCY_PERCENT) / 100;

  // --- 1. Reconstruct solver columns into per-slot arrays ---
  const g2l = Array(T).fill(0);
  const g2b = Array(T).fill(0);
  const pv2l = Array(T).fill(0);
  const pv2b = Array(T).fill(0);
  const pv2g = Array(T).fill(0);
  const pvCurtail = Array(T).fill(0);
  const b2l = Array(T).fill(0);
  const b2g = Array(T).fill(0);
  const soc = Array(T).fill(0);
  const g2ev  = Array(T).fill(0);
  const pv2ev = Array(T).fill(0);
  const b2ev  = Array(T).fill(0);
  const evSoc = Array(T).fill(0);
  // Mask-exempt minimum-SoC floor flows (folded into the EV totals below).
  const g2evFloor = Array(T).fill(0);
  const pv2evFloor = Array(T).fill(0);
  const b2evFloor = Array(T).fill(0);
  const evFloorShortfall = Array(T).fill(0);

  const entries = Object.entries(result.Columns ?? {});

  for (const [name, col] of entries) {
    const t = parseIndex(name);
    if (t == null || t < 0 || t >= T) continue;
    const v = valueOf(col);

    if (name.startsWith("grid_to_load_")) g2l[t] = v;
    else if (name.startsWith("grid_to_battery_")) g2b[t] = v;
    else if (name.startsWith("pv_to_load_")) pv2l[t] = v;
    else if (name.startsWith("pv_to_battery_")) pv2b[t] = v;
    else if (name.startsWith("pv_to_grid_")) pv2g[t] = v;
    else if (name.startsWith("pv_curtail_")) pvCurtail[t] = v;
    else if (name.startsWith("battery_to_load_")) b2l[t] = v;
    else if (name.startsWith("battery_to_grid_")) b2g[t] = v;
    else if (name.startsWith("soc_") && !name.startsWith("soc_shortfall_")) soc[t] = v;
    // Floor flows MUST be matched before their normal counterparts: e.g.
    // "grid_to_ev_floor_3" also startsWith "grid_to_ev_".
    else if (name.startsWith("grid_to_ev_floor_"))    g2evFloor[t]  = v;
    else if (name.startsWith("pv_to_ev_floor_"))       pv2evFloor[t] = v;
    else if (name.startsWith("battery_to_ev_floor_"))  b2evFloor[t]  = v;
    else if (name.startsWith("ev_floor_shortfall_"))   evFloorShortfall[t] = v;
    else if (name.startsWith("grid_to_ev_"))    g2ev[t]  = v;
    else if (name.startsWith("pv_to_ev_"))       pv2ev[t] = v;
    else if (name.startsWith("battery_to_ev_"))  b2ev[t]  = v;
    else if (name.startsWith("ev_soc_"))         evSoc[t] = v;
  }

  // Scalar soft-target shortfall (no per-slot index). 0 when the target is met.
  const evActive = cfg.ev != null;
  const evTargetShortfall_Wh = valueOf(result.Columns?.['ev_target_shortfall'] ?? {});
  const evTargetWh = ((cfg.ev?.evTargetSoc_percent ?? 0) / 100) * (cfg.ev?.evBatteryCapacity_Wh ?? 0);
  const evDepSlot = cfg.ev?.evDepartureSlot ?? -1;

  // Planning-semantics fields for an EV row (separate from ev_charge_mode):
  //   min_soc       — mask-exempt floor charging is active this slot
  //   opportunistic — charging that carries SoC above the requested target
  //   planned       — normal cost-optimal charging toward target
  // ev_target_met / shortfall are attached on the departure slot.
  const evPlanFields = (t: number): Partial<PlanRow> => {
    const floorPower = g2evFloor[t] + pv2evFloor[t] + b2evFloor[t];
    const charging = g2ev[t] + g2evFloor[t]
      + eta_inv * (pv2ev[t] + pv2evFloor[t])
      + eta_inv * (b2ev[t] + b2evFloor[t]);
    let mode: EvPlanMode = 'planned';
    if (floorPower > EV_FLOW_THRESHOLD_W) mode = 'min_soc';
    else if (charging > EV_FLOW_THRESHOLD_W && evSoc[t] > evTargetWh + 1) mode = 'opportunistic';
    const fields: Partial<PlanRow> = { ev_plan_mode: mode };
    if (t === evDepSlot - 1) {
      fields.ev_target_shortfall_Wh = round(evTargetShortfall_Wh);
      fields.ev_target_met = evTargetShortfall_Wh <= 1; // within 1 Wh of target
    }
    return fields;
  };

  // --- 2. Build rows (flows, soc, etc.) ---
  // Apply η_inv at AC↔DC boundaries so PlanRow values reflect the AC-meter view:
  //   pv2l, pv2g, pv2ev, b2l, b2g, b2ev: LP variable is DC W; we report η_inv * v (AC W delivered).
  //   pv2b: stays DC (DC→DC charging on the battery bus; no inverter involved).
  //   pvCurtail: stays DC (raw lost-PV measure on the panel side).
  //   g2*, soc: already AC / Wh; unchanged.
  const slotHours = opts.stepMin / 60;
  const rows: PlanRow[] = [];
  for (let t = 0; t < T; t++) {
    const pv2l_AC = eta_inv * pv2l[t];
    const pv2g_AC = eta_inv * pv2g[t];
    const b2l_AC = eta_inv * b2l[t];
    const b2g_AC = eta_inv * b2g[t];
    // Fold mask-exempt floor charging into the EV totals so DESS mapping, the
    // summary, and the UI account for it. Floor PV/battery legs are DC → AC like
    // their normal counterparts; floor grid leg is already AC.
    const g2evTotal = g2ev[t] + g2evFloor[t];
    const pv2ev_AC = eta_inv * (pv2ev[t] + pv2evFloor[t]);
    const b2ev_AC = eta_inv * (b2ev[t] + b2evFloor[t]);

    const imp = g2l[t] + g2b[t] + g2evTotal;
    const exp = pv2g_AC + b2g_AC;
    const evW = g2evTotal + pv2ev_AC + b2ev_AC;
    const importCost = imp * slotHours / 1000 * cfg.importPrice[t];
    const exportCost = exp * slotHours / 1000 * cfg.exportPrice[t];

    rows.push({
      tIdx: t,
      timestampMs: timestampsMs[t],

      load: round(cfg.load_W[t]),
      pv: round(cfg.pv_W[t]),
      evLoad: round(cfg.evLoad_W?.[t] ?? 0),
      ic: cfg.importPrice[t],
      ec: cfg.exportPrice[t],

      g2l: round(g2l[t]),
      g2b: round(g2b[t]),
      pv2l: round(pv2l_AC),
      pv2b: round(pv2b[t]),
      pv2g: round(pv2g_AC),
      pvCurtail: round(pvCurtail[t]),
      b2l: round(b2l_AC),
      b2g: round(b2g_AC),

      imp: round(imp),
      exp: round(exp),
      importCost_cents: round(importCost),
      exportCost_cents: round(exportCost),
      soc: round(soc[t]),
      soc_percent: (soc[t] / cap) * 100,
      g2ev:          round(g2evTotal),
      pv2ev:         round(pv2ev_AC),
      b2ev:          round(b2ev_AC),
      ev_charge:     round(evW),
      ev_charge_A:   round(evW / evWattsPerAmp),
      ev_charge_mode: evChargeMode(g2evTotal, pv2ev_AC, b2ev_AC, cfg.ev?.evMinChargePower_W ?? 0, pv2b[t]),
      ev_soc_percent: (evSoc[t] / evCap) * 100,
      ...(evActive ? evPlanFields(t) : {}),
    });
  }

  return rows;
}

// 1 W threshold avoids spurious mode classification from solver floating-point residuals
const EV_FLOW_THRESHOLD_W = 1;

function evChargeMode(g: number, pv: number, b: number, evMinPow_W: number, pv2b: number): EvChargeMode {
  const total = g + pv + b;
  if (total < EV_FLOW_THRESHOLD_W)                             return 'off';
  if (evMinPow_W > 0 && total <= evMinPow_W * 1.02)           return 'fixed';       // at minimum charge rate → set exact amps (even if battery tops up)
  if (b > EV_FLOW_THRESHOLD_W)                                 return 'max';         // battery above minimum rate → use all sources
  if (pv2b > EV_FLOW_THRESHOLD_W)                              return 'fixed';       // PV split with battery → respect solver allocation
  if (pv > EV_FLOW_THRESHOLD_W && g > EV_FLOW_THRESHOLD_W)   return 'solar_grid';  // PV + grid → track PV + grid headroom
  if (pv > EV_FLOW_THRESHOLD_W)                                return 'solar_only';  // PV only → track PV surplus
  return 'solar_grid';                                                                // grid only → track grid headroom
}

// --- helpers ---

function parseIndex(varName: string): number | null {
  const m = /_(\d+)$/.exec(varName);
  // v8 ignore next — null path of ternary when regex matches is untestable
  return m ? Number(m[1]) : null;
}

function valueOf(col: HighsColumn): number {
  return col.Primal ?? 0;
}

function round(x: number): number {
  return Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1000) / 1000;
}

// synthesize timeline from a provided startMs
function synthesizeFromStart(startMs: number, stepMin: number, T: number): number[] {
  const out = new Array<number>(T);
  const stepMs = stepMin * 60_000;
  for (let i = 0; i < T; i++) {
    out[i] = startMs + i * stepMs;
  }
  return out;
}
