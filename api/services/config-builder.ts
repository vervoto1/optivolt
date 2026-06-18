import { HttpError } from '../http-errors.ts';
import { loadSettings } from './settings-store.ts';
import { loadData, saveData } from './data-store.ts';
import { loadCalibration, loadEvCalibration, generateThresholdsFromCurve, EV_MIN_RATE } from './efficiency-calibrator.ts';
import { applyPredictionAdjustmentsToData, pruneExpiredPredictionAdjustments } from './prediction-adjustments.ts';
import { recordFullSocObservation } from './rebalance-nudge.ts';
import { extractWindow, getQuarterStart, getSeriesEndMs } from '../../lib/time-series-utils.ts';
import { fetchHaEntityState } from './ha-client.ts';
import { resolveEvMode } from './ev-mode.ts';
import { resolveDepartureMs } from './ev-departure.ts';
import { evChargeWattsPerAmp } from '../../lib/build-lp.ts';
import type { SolverConfig, EvConfig } from '../../lib/types.ts';
import type { Settings, Data, CalibrationResult, EvCalibrationResult } from '../types.ts';

function departureTimeToSlot(
  departureMs: number,
  startMs: number,
  stepSize_m: number,
  T: number,
): number {
  if (!Number.isFinite(departureMs)) return 0;

  const slotsAvailable = Math.floor((departureMs - startMs) / (stepSize_m * 60_000));
  if (slotsAvailable <= 0) return 0;
  return Math.min(slotsAvailable, T + 1);
}

/**
 * Resolve an earliest-start time to the first slot index at/after which charging
 * is allowed. Empty/invalid/elapsed start time → 0 (no earliest-start
 * restriction). Slots strictly before the returned index are masked.
 */
function startTimeToSlot(
  startTime: string | undefined,
  startMs: number,
  stepSize_m: number,
): number {
  if (!startTime) return 0;
  const ms = new Date(startTime).getTime();
  if (!Number.isFinite(ms)) return 0;
  const slot = Math.ceil((ms - startMs) / (stepSize_m * 60_000));
  return slot > 0 ? slot : 0;
}

/**
 * Build a fully resolved SolverConfig from stored settings + data.
 * Settings and data are already validated by their respective stores.
 * Throws 422 when there is insufficient future data to optimise.
 *
 * `nowMs` defaults to the start of the current slot so tests can call this
 * directly without worrying about timing. Production callers should pass a
 * pre-computed value so the same instant is used for both the window and the
 * returned timing.
 */
export function buildSolverConfigFromSettings(
  settings: Settings,
  data: Data,
  nowMs = getQuarterStart(new Date(), settings.stepSize_m),
  evState?: { pluggedIn: boolean; soc_percent: number },
): SolverConfig {
  const loadEndMs   = getSeriesEndMs(data.load);
  const pvEndMs     = getSeriesEndMs(data.pv);
  const importEndMs = getSeriesEndMs(data.importPrice);
  const exportEndMs = getSeriesEndMs(data.exportPrice);
  const evLoadEndMs = data.evLoad ? getSeriesEndMs(data.evLoad) : Infinity;
  const endMs = Math.min(loadEndMs, pvEndMs, importEndMs, exportEndMs, evLoadEndMs);

  if (endMs <= nowMs) {
    throw new HttpError(422, 'Insufficient future data', {
      details: {
        now:       new Date(nowMs).toISOString(),
        loadEnd:   new Date(loadEndMs).toISOString(),
        pvEnd:     new Date(pvEndMs).toISOString(),
        importEnd: new Date(importEndMs).toISOString(),
        exportEnd: new Date(exportEndMs).toISOString(),
        ...(data.evLoad ? { evLoadEnd: new Date(evLoadEndMs).toISOString() } : {}),
      },
    });
  }

  const base: SolverConfig = {
    load_W:      extractWindow(data.load,        nowMs, endMs),
    pv_W:        extractWindow(data.pv,          nowMs, endMs),
    importPrice: extractWindow(data.importPrice, nowMs, endMs),
    exportPrice: extractWindow(data.exportPrice, nowMs, endMs),

    stepSize_m:                           settings.stepSize_m,
    batteryCapacity_Wh:                   settings.batteryCapacity_Wh,
    minSoc_percent:                       settings.minSoc_percent,
    maxSoc_percent:                       settings.maxSoc_percent,
    maxChargePower_W:                     settings.maxChargePower_W,
    maxDischargePower_W:                  settings.maxDischargePower_W,
    maxGridImport_W:                      settings.maxGridImport_W,
    maxGridExport_W:                      settings.maxGridExport_W,
    chargeEfficiency_percent:             settings.chargeEfficiency_percent,
    dischargeEfficiency_percent:          settings.dischargeEfficiency_percent,
    inverterEfficiency_percent:           settings.inverterEfficiency_percent,
    batteryCost_cent_per_kWh:             settings.batteryCost_cent_per_kWh,
    idleDrain_W:                          settings.idleDrain_W,
    terminalSocValuation:                 settings.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: settings.terminalSocCustomPrice_cents_per_kWh,
    initialSoc_percent:                   data.soc.value,
  };

  // EV load (uncontrollable) injection. CRITICAL: in native mode the LP owns EV
  // charging via the controllable grid/pv/battery_to_ev variables, so the
  // uncontrollable data.evLoad must NOT also be folded into the house load — that
  // would double-count the EV (the same draw as both fixed load AND planned
  // charge). Suppress it in native mode; keep it in off mode (where data.evLoad
  // is a manually/API-injected uncontrollable EV draw).
  base.evLoad_W = (resolveEvMode(settings) !== 'native' && data.evLoad)
    ? extractWindow(data.evLoad, nowMs, endMs)
    : new Array(base.load_W.length).fill(0);

  // Manual CV phase thresholds remain supported and act as the baseline.
  if (settings.cvPhase?.enabled && settings.cvPhase.thresholds?.length) {
    base.cvPhaseThresholds = settings.cvPhase.thresholds
      .filter(t => t.soc_percent > 0 && t.maxChargePower_W > 0)
      .sort((a, b) => a.soc_percent - b.soc_percent);
  }

  if (settings.rebalanceEnabled) {
    // Math.ceil ensures the hold is never shorter than requested; Math.max(1, …) prevents 0-slot holds
    // from a bad/zero rebalanceHoldHours setting (which would immediately complete the cycle).
    const holdSlots = Math.max(1, Math.ceil(settings.rebalanceHoldHours / (settings.stepSize_m / 60)));
    const startMs_ = data.rebalanceState?.startMs ?? null;
    const slotsElapsed = startMs_ != null
      ? Math.floor((nowMs - startMs_) / (settings.stepSize_m * 60_000))
      : 0;
    const remainingSlots = startMs_ != null
      ? Math.max(0, holdSlots - slotsElapsed)
      : holdSlots;
    base.rebalanceHoldSlots = holdSlots;
    base.rebalanceRemainingSlots = remainingSlots;
    base.rebalanceTargetSoc_percent = settings.maxSoc_percent;
  }

  if (resolveEvMode(settings) === 'native' && evState?.pluggedIn) {
    const T = base.load_W.length;
    // Three-phase chargers deliver 3x the power per amp. Single source for the
    // A->W conversion; parse-solution does the inverse with the same phase count.
    const phases = settings.evChargePhases === 3 ? 3 : 1;
    const wattsPerAmp = evChargeWattsPerAmp(settings.evChargePhases);
    const minPow_W = settings.evMinChargeCurrent_A * wattsPerAmp;
    const maxPow_W = settings.evMaxChargeCurrent_A * wattsPerAmp;
    const capacityWh = settings.evBatteryCapacity_kWh * 1000;

    // "Ready by" deadline. When the user has not set one, default to the end of
    // the known horizon — i.e. reach target by the last slot we have prices for,
    // charging in the cheapest hours along the way. (Only reached when the EV is
    // connected, so the home-battery co-optimisation still ignores an absent EV.)
    //
    // The deadline is a wall-clock time-of-day + today/tomorrow selector resolved
    // relative to now, so it can't drift into the past. Should it still resolve to
    // an elapsed instant (e.g. "today" at a time already gone, or a legacy absolute
    // datetime) departureTimeToSlot returns 0; rather than silently disabling EV
    // planning until the user re-picks, treat that as "no deadline" and fall back to
    // the end of the horizon so the car keeps getting a charge-to-target plan.
    const departureMs = resolveDepartureMs(settings.evDepartureTime, settings.evDepartureDay, nowMs);
    const depSlot = departureMs != null
      ? departureTimeToSlot(departureMs, nowMs, settings.stepSize_m, T)
      : T;
    const D = depSlot > 0 ? depSlot : T;
    // Earliest-start window: slot index at/after which charging is allowed.
    const startSlot = startTimeToSlot(settings.evStartTime, nowMs, settings.stepSize_m);

    // Guard the window: require startSlot < D. D is now always > 0 (an elapsed
    // deadline falls back to the horizon above), so the only empty window left is an
    // earliest-start time at/past the deadline/horizon, which would emit masks that
    // zero every slot and, combined with the cardinality bound, make the model
    // infeasible. Disable EV planning for this solve in that case.
    if (D > 0 && startSlot < D) {
      // Capacity-only clamp. The OLD achievable-charge clamp lowered the target
      // before the LP saw it, so the (now soft) target read as "met" while the
      // car sat below the user's requested SoC. Soft target carries feasibility.
      const requestedTargetWh = Math.min((settings.evTargetSoc_percent / 100) * capacityWh, capacityWh);

      const ev: EvConfig = {
        evMinChargePower_W: Math.min(minPow_W, maxPow_W),
        evMaxChargePower_W: maxPow_W,
        evBatteryCapacity_Wh: capacityWh,
        evInitialSoc_percent: evState.soc_percent,
        evTargetSoc_percent: (requestedTargetWh / capacityWh) * 100,
        evDepartureSlot: D,
        evChargeEfficiency_percent: settings.evChargeEfficiency_percent,
        evChargePhases: phases,
      };

      if (startSlot > 0) ev.evStartSlot = startSlot;

      // Price limit (hard mask; min-SoC floor stays exempt inside build-lp).
      if (settings.evApplyPriceLimit && Number.isFinite(settings.evMaxPrice_cents_per_kWh)) {
        ev.evApplyPriceLimit = true;
        ev.evMaxPrice_cents_per_kWh = settings.evMaxPrice_cents_per_kWh;
      }

      // Minimum-SoC safety floor (soft, mask-exempt, sourced). Only meaningful
      // above the initial SoC — otherwise it is already satisfied.
      if (Number.isFinite(settings.evMinSoc_percent) && (settings.evMinSoc_percent ?? 0) > 0) {
        ev.evMinSocFloor_percent = Math.min(settings.evMinSoc_percent!, settings.evTargetSoc_percent);
      }

      // Opportunistic top-up bands (caps above target, clamped to 100%).
      if (settings.evOpportunisticEnabled && Number.isFinite(settings.evOpportunisticLevel_percent)) {
        const cap = Math.min(100, Math.max(settings.evTargetSoc_percent, settings.evOpportunisticLevel_percent!));
        if (cap > settings.evTargetSoc_percent) ev.evOpportunisticCap_percent = cap;
      }
      if (settings.evOpportunisticType2Enabled && Number.isFinite(settings.evOpportunisticType2Level_percent)) {
        const base1 = ev.evOpportunisticCap_percent ?? settings.evTargetSoc_percent;
        const cap2 = Math.min(100, Math.max(base1, settings.evOpportunisticType2Level_percent!));
        if (cap2 > base1) ev.evOpportunisticType2Cap_percent = cap2;
      }

      if (settings.evContinuous) ev.evContinuous = true;

      base.ev = ev;
    } else {
      console.log(
        `[config-builder] EV planning disabled: empty charge window ` +
        `(startSlot=${startSlot}, departureSlot=${D}).`,
      );
    }
  }

  return base;
}

/**
 * Apply calibration to the solver config.
 * Converts calibration curves into MILP power thresholds instead of
 * adjusting efficiency percentages — the curves measure charge/discharge
 * speed deviation (power), not energy conversion efficiency.
 * Only applies when confidence exceeds 0.5 threshold.
 */
export function applyCalibration(cfg: SolverConfig, cal: CalibrationResult): SolverConfig {
  if (cal.confidence < 0.5) return cfg;

  // Generate charge thresholds from calibration curve. The charge/CV taper is a
  // real physical limit (a BMS accepts less current as it approaches full), so
  // modelling it in the LP is correct.
  const chargeThresholds = generateThresholdsFromCurve(
    cal.chargeCurve,
    // v8 ignore next — null path of ?? is untestable with real calibration results
    cal.chargeSamples ?? [],
    cfg.maxChargePower_W,
    'charge',
  );

  // NOTE: we deliberately do NOT derive a discharge-power taper from the
  // calibration curve any more. Unlike charging, the battery has no real
  // low-SoC discharge limit here (the inverter was measured delivering ~15 kW at
  // 5% SoC). The discharge curve is `actual / predicted` SoC change per band, and
  // near a slot's target SoC DESS stops discharging and just covers house load —
  // so "throttled because the target was already reached" was being mislearned as
  // "the battery can't discharge fast at low SoC". Feeding that back as a hard LP
  // discharge-power ceiling made the optimizer plan a too-gentle drain and defer
  // export from a high-price hour into the next cheaper hour, which in turn
  // produced more throttled slots — a self-reinforcing loop. The discharge curve
  // is still computed/persisted by the calibrator for duration predictions; it
  // just no longer constrains the optimizer. See dischargePhaseThresholds in
  // build-lp.ts (still supported for a genuine, statically-configured taper).

  console.log(
    `[config-builder] Applying calibration: ${chargeThresholds.length} charge thresholds ` +
    `(discharge taper not applied) (confidence=${cal.confidence})`,
  );

  // Map to the SolverConfig threshold format
  const result = { ...cfg };

  if (chargeThresholds.length > 0) {
    result.cvPhaseThresholds = chargeThresholds.map(t => ({
      soc_percent: t.soc_percent,
      maxChargePower_W: t.power_W,
    }));
  }

  return result;
}

/**
 * Apply the learned EV charge-acceptance taper to the solver config. No-op unless
 * an EV is in the plan (cfg.ev) and EV calibration confidence exceeds 0.5. Forecast
 * only: it caps the planned EV charge power per SoC band so the plan stops assuming
 * a flat rate to target. Uses the low EV floor (EV_MIN_RATE) so a real near-full
 * taper can be represented.
 */
export function applyEvCalibration(cfg: SolverConfig, evCal: EvCalibrationResult): SolverConfig {
  if (!cfg.ev) return cfg;
  if (evCal.confidence < 0.5) return cfg;

  const thresholds = generateThresholdsFromCurve(
    evCal.evChargeCurve,
    // v8 ignore next — null path of ?? is untestable with real calibration results
    evCal.evChargeSamples ?? [],
    cfg.ev.evMaxChargePower_W,
    'charge',
    2,
    undefined,    // keep the default max-thresholds cap
    EV_MIN_RATE,
  );

  if (thresholds.length === 0) return cfg;

  // Enforce a physically-monotonic taper: charge acceptance only ever DROPS as SoC
  // rises (a BMS never accepts more current closer to full). A noisy/sparse learned
  // curve can emit a higher power at a higher SoC band; project a running-min over
  // the (ascending-SoC) thresholds so the plan can't model an acceptance "bump".
  let cap = Infinity;
  const monotonic = thresholds.map(t => {
    const power_W = Math.min(t.power_W, cap);
    cap = power_W;
    return { soc_percent: t.soc_percent, maxChargePower_W: power_W };
  });

  console.log(
    `[config-builder] Applying EV charge taper: ${monotonic.length} thresholds (confidence=${evCal.confidence})`,
  );

  return {
    ...cfg,
    ev: {
      ...cfg.ev,
      evChargeThresholds: monotonic,
    },
  };
}

export async function getSolverInputs(): Promise<{ cfg: SolverConfig; timing: { startMs: number; stepMin: number }; data: Data; settings: Settings; evState?: { pluggedIn: boolean; soc_percent: number } }> {
  const [settings, loadedData] = await Promise.all([loadSettings(), loadData()]);
  const startMs = getQuarterStart(new Date(), settings.stepSize_m);
  const pruned = pruneExpiredPredictionAdjustments(loadedData, startMs);
  let data = pruned.data;
  let shouldSaveData = pruned.changed;

  const observedData = recordFullSocObservation(data);
  if (observedData !== data) {
    data = observedData;
    shouldSaveData = true;
  }

  if (shouldSaveData) await saveData(data);

  let evState: { pluggedIn: boolean; soc_percent: number } | undefined;
  if (resolveEvMode(settings) === 'native' && settings.evSocSensor && settings.evPlugSensor) {
    try {
      const [socEntity, plugEntity] = await Promise.all([
        fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evSocSensor }),
        fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evPlugSensor }),
      ]);
      const soc_percent = parseFloat(socEntity.state);
      const pluggedIn = plugEntity.state !== 'disconnected'
        && plugEntity.state !== 'unavailable'
        && plugEntity.state !== 'unknown'
        && plugEntity.state !== 'off';
      if (Number.isFinite(soc_percent)) {
        evState = { pluggedIn, soc_percent };
      }
    } catch (err) {
      console.warn('Could not read EV state from HA:', err instanceof Error ? err.message : String(err));
    }
  }

  const adjustedData = applyPredictionAdjustmentsToData(data);
  let cfg = buildSolverConfigFromSettings(settings, adjustedData, startMs, evState);

  // Apply calibration when adaptive learning is in 'auto' mode
  if (settings.adaptiveLearning?.enabled && settings.adaptiveLearning.mode === 'auto') {
    try {
      const cal = await loadCalibration();
      if (cal) {
        cfg = applyCalibration(cfg, cal);
      }
    } catch (err) {
      console.warn('[config-builder] Failed to load calibration:', (err as Error).message);
    }

    // EV charge-acceptance taper: opt-in (evChargeCurveEnabled), and only when an EV
    // is actually in the plan. Forecast-only; leaves the flat cap when disabled or
    // not yet confident.
    if (settings.evChargeCurveEnabled && cfg.ev) {
      try {
        const evCal = await loadEvCalibration();
        if (evCal) {
          cfg = applyEvCalibration(cfg, evCal);
        }
      } catch (err) {
        console.warn('[config-builder] Failed to load EV calibration:', (err as Error).message);
      }
    }
  }

  // evState is returned so callers that REBUILD cfg (e.g. after an MQTT SoC
  // refresh or a rebalance reset) can pass it back in — otherwise the rebuilt
  // cfg silently drops the EV (no 4th arg → evState undefined → EV excluded).
  return { cfg, timing: { startMs, stepMin: settings.stepSize_m }, data, settings, evState };
}
