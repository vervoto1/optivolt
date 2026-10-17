import { HttpError } from '../http-errors.ts';
import { loadSettings } from './settings-store.ts';
import { updateData } from './data-store.ts';
import { loadCalibration, loadEvCalibration, generateThresholdsFromCurve, EV_MIN_RATE } from './efficiency-calibrator.ts';
import { applyPredictionAdjustmentsToData, pruneExpiredPredictionAdjustments } from './prediction-adjustments.ts';
import { recordFullSocObservation } from './rebalance-nudge.ts';
import { extendedWindowEndMs, extractWindow, getForecastTimeRange, getQuarterStart, getSeriesEndMs, sampleSeriesAt } from '../../lib/time-series-utils.ts';
import { fetchHaEntityState } from './ha-client.ts';
import { resolveEvMode } from './ev-mode.ts';
import { resolveDepartureMs } from './ev-departure.ts';
import { fetchEvTargetSoc } from './ev-target-soc.ts';
import { evChargeWattsPerAmp } from '../../lib/build-lp.ts';
import { resolveExportPrices, terminalTailMinPrice, type ExportPriceRegime } from '../../lib/export-tariff.ts';
import { priceForecastSlots, type ExportRelation, type FitRejectionReason, type ImportFit, type ImportResolution, type StoredFitRejectionReason } from '../../lib/forecast-pricing.ts';
import { getPriceForecastStatus, publishedImportEndMs } from './price-forecast-service.ts';
import type { SolverConfig, EvConfig, TimeSeries, ExportTariffInfo } from '../../lib/types.ts';
import type { Settings, Data, SocData, CalibrationResult, EvCalibrationResult, PriceForecastFit, PriceForecastRegion } from '../types.ts';

/**
 * How long a rebalance hold may stay pending (rebalancing enabled, the hold
 * clock never started) before the planner gives up and switches rebalancing
 * off. With grid charging allowed the solver places a hold inside its 1–2 day
 * horizon, so three days of pending means the hold cannot start on this
 * system (e.g. the pack never gets within tolerance of the target). Persisted
 * as `rebalanceState.pendingSinceMs`.
 */
export const REBALANCE_PENDING_GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How far below the rebalance target the live SoC may read and still start the
 * hold clock. Packs whose system SoC tops out at 99 % (as in production) would
 * otherwise never start the hold, and every plan would keep the battery held
 * with battery-to-grid export blocked.
 *
 * Within this tolerance the LP's hold requirement is lowered by the same
 * amount (`rebalanceHoldSoc_percent`, see buildSolverConfigFromSettings).
 */
export const REBALANCE_START_TOLERANCE_PERCENT = 1;

/** EV SoC (%) below which a car without a deadline is not deferred to forecast days (`evDeferMinSoc_percent`). */
export const DEFAULT_EV_DEFER_MIN_SOC_PERCENT = 20;

/**
 * Live EV readings that seed the plan. `targetSoc_percent` is present only when
 * an `evTargetSocEntity` was configured and readable; otherwise the static
 * `evTargetSoc_percent` setting is used.
 */
export interface EvLiveState {
  pluggedIn: boolean;
  soc_percent: number;
  targetSoc_percent?: number;
}

function departureTimeToSlot(
  departureMs: number,
  startMs: number,
  stepSize_m: number,
  T: number,
): number {
  /* v8 ignore next — unreachable: the only caller guards departureMs != null and resolveDepartureMs only ever yields null or a finite number */
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
 * Whether a market-price series can be expected, by price source: Home
 * Assistant needs the configured `exportSensor`, API prices a stored
 * `data.marketPrice` (posted to /data), and VRM never supplies one — a series
 * left from an earlier source does not count. Without one, `auto` keeps net
 * metering for every slot.
 */
export function isMarketSourceConfigured(settings: Settings, data: Data): boolean {
  switch (settings.dataSources.prices) {
    case 'ha': return (settings.haPriceConfig?.exportSensor ?? '').trim() !== '';
    case 'api': return data.marketPrice !== undefined;
    default: return false;
  }
}

/**
 * Apply `settings.exportTariff` to `cfg` in place: per-slot export prices (net
 * metering, market or the 0 fallback, see lib/export-tariff.ts), the terminal
 * valuation override when the last slot is market-priced, and the
 * `exportTariffInfo` diagnostics. Without the block nothing changes, so the LP
 * is byte-identical to the pre-tariff one.
 *
 * The market series is not part of the horizon or the must-cover checks: a
 * lagging market feed must not shorten the plan; its missing slots fall back
 * per slot instead (NaN marks them missing, not 0 c).
 */
function applyExportTariff(cfg: SolverConfig, settings: Settings, data: Data, nowMs: number): void {
  const tariff = settings.exportTariff;
  if (!tariff) return;

  const T = cfg.exportPrice.length;
  const stepMs = settings.stepSize_m * 60_000;
  const slotStartsMs = Array.from({ length: T }, (_, t) => nowMs + t * stepMs);
  // A series the current price source cannot produce (left in data.json
  // after a source switch) is ignored rather than priced.
  const marketSourceConfigured = isMarketSourceConfigured(settings, data);
  // Sampled by slot timestamp, so an hourly market feed (as posted to /data)
  // lines up with the 15-minute slots instead of being read one hour per slot.
  const market = marketSourceConfigured && data.marketPrice
    ? sampleSeriesAt(data.marketPrice, slotStartsMs)
    : new Array<number>(T).fill(NaN);

  const resolved = resolveExportPrices({
    slotStartsMs,
    sourceExport: cfg.exportPrice,
    market,
    tariff,
    marketSourceConfigured,
  });
  cfg.exportPrice = resolved.exportPrice;

  const terminalOverride = applyTerminalOverride(cfg, settings, resolved.regime[T - 1]);

  cfg.exportTariffInfo = {
    marketPricedSlots: resolved.marketPricedSlots,
    fallbackSlots: resolved.fallbackSlots,
    missingMarketSource: resolved.missingMarketSource,
    effectiveFrom: tariff.effectiveFrom,
    terminalOverride,
  };
}

/**
 * The end-of-horizon valuation follows the tariff of the last slot, so a 2026
 * horizon keeps the top-level setting untouched: when the last slot is market
 * priced (or the 0 fallback) the tariff block's valuation replaces it on
 * `cfg` (tailMin over `cfg.importPrice`). Returns the override, or null.
 * Requires `settings.exportTariff`.
 */
function applyTerminalOverride(
  cfg: SolverConfig,
  settings: Settings,
  lastRegime: ExportPriceRegime | undefined,
): ExportTariffInfo['terminalOverride'] {
  const tariff = settings.exportTariff!;
  if (lastRegime !== 'market' && lastRegime !== 'fallback') return null;
  const terminalOverride: NonNullable<ExportTariffInfo['terminalOverride']> = tariff.terminalSocValuation === 'tailMin'
    ? {
        terminalSocValuation: 'custom',
        terminalSocCustomPrice_cents_per_kWh: terminalTailMinPrice(cfg.importPrice, settings.stepSize_m, tariff.terminalTail_h),
      }
    : {
        terminalSocValuation: tariff.terminalSocValuation,
        terminalSocCustomPrice_cents_per_kWh: cfg.terminalSocCustomPrice_cents_per_kWh,
      };
  cfg.terminalSocValuation = terminalOverride.terminalSocValuation;
  cfg.terminalSocCustomPrice_cents_per_kWh = terminalOverride.terminalSocCustomPrice_cents_per_kWh;
  return terminalOverride;
}

/**
 * The end of the published VRM import prices, when it caps the firm part:
 * only with `extendedHorizon.mode` `on` and VRM prices (VRM zero-fills the
 * unpublished slots, so its series end is not where its prices end; see
 * `publishedImportEndMs`). Infinity otherwise, so `off` and `collect` keep
 * today's horizon exactly, zero-filled slots included.
 */
function vrmPublishedUntilMs(settings: Settings, data: Data): number {
  if (settings.extendedHorizon?.mode !== 'on' || settings.dataSources.prices !== 'vrm') return Infinity;
  // null: not a single non-zero price, i.e. nothing published at all.
  return publishedImportEndMs(data, 'vrm') ?? new Date(data.importPrice.start).getTime();
}

/**
 * `extendedHorizon.mode` `collect` must not change any plan, but in that mode
 * the planner's own load and PV predictors (the `api` sources) already write
 * the longer planning window. Their series ends are therefore capped at the
 * old (`getForecastTimeRange`) window end, which is where those predictors
 * end with the mode off, so the horizon is still set by the prices exactly as
 * with the mode off, e.g. when HA prices for tomorrow arrive before 13:00 or
 * `api` prices are posted for several days. VRM and HA load/PV series are
 * never extended, so they are not capped (with the mode off they may already
 * reach past the old window). Infinity otherwise.
 *
 * Not applied with the mode `on`: there the firm part runs to the end of the
 * published prices, also when those reach past the old window (published
 * prices are real prices). The firm-only plan of `on` is then longer than the
 * `off` plan, which is intended: it is the fallback of the extended solve.
 */
function collectSeriesCapMs(settings: Settings, nowMs: number, source: 'load' | 'pv'): number {
  if (settings.extendedHorizon?.mode !== 'collect' || settings.dataSources[source] !== 'api') return Infinity;
  return Date.parse(getForecastTimeRange(nowMs).endIso);
}

/**
 * Build a fully resolved SolverConfig from stored settings + data.
 * Settings and data are already validated by their respective stores.
 * Throws 422 when there is insufficient future data to optimise, or when the
 * load or a price series starts after the plan window begins.
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
  evState?: EvLiveState,
): SolverConfig {
  const loadEndMs   = Math.min(getSeriesEndMs(data.load), collectSeriesCapMs(settings, nowMs, 'load'));
  const pvEndMs     = Math.min(getSeriesEndMs(data.pv), collectSeriesCapMs(settings, nowMs, 'pv'));
  const importEndMs = getSeriesEndMs(data.importPrice);
  const exportEndMs = getSeriesEndMs(data.exportPrice);
  const evLoadEndMs = data.evLoad ? getSeriesEndMs(data.evLoad) : Infinity;
  // The firm end: forecast prices never stand in for missing published ones,
  // so with the multi-day horizon on, VRM's zero-filled slots are cut off too.
  const publishedUntilMs = vrmPublishedUntilMs(settings, data);
  const endMs = Math.min(loadEndMs, pvEndMs, importEndMs, exportEndMs, evLoadEndMs, publishedUntilMs);

  if (endMs <= nowMs) {
    throw new HttpError(422, 'Insufficient future data', {
      details: {
        now:       new Date(nowMs).toISOString(),
        loadEnd:   new Date(loadEndMs).toISOString(),
        pvEnd:     new Date(pvEndMs).toISOString(),
        importEnd: new Date(importEndMs).toISOString(),
        exportEnd: new Date(exportEndMs).toISOString(),
        ...(data.evLoad ? { evLoadEnd: new Date(evLoadEndMs).toISOString() } : {}),
        ...(Number.isFinite(publishedUntilMs) ? { publishedUntil: new Date(publishedUntilMs).toISOString() } : {}),
      },
    });
  }

  // A series that starts after the plan window begins would be zero-padded by
  // extractWindow for the leading slots. Zero PV just means "no sun yet" and an
  // injected evLoad legitimately starts when the EV draw starts, but zero load
  // or zero prices would make the solver plan against free energy in exactly
  // the slots that are written to Victron first, so reject those outright.
  const mustCoverStart: Array<[string, TimeSeries]> = [
    ['load',        data.load],
    ['importPrice', data.importPrice],
    ['exportPrice', data.exportPrice],
  ];
  for (const [name, series] of mustCoverStart) {
    const seriesStartMs = new Date(series.start).getTime();
    if (seriesStartMs > nowMs) {
      throw new HttpError(422, `Series '${name}' starts after the plan window begins`, {
        details: {
          now:         new Date(nowMs).toISOString(),
          seriesStart: new Date(seriesStartMs).toISOString(),
        },
      });
    }
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
    // Clamp to maxSoc: a battery fuller than the configured ceiling (e.g. right after
    // lowering maxSoc) would otherwise have to discharge the excess within slot 0 to
    // satisfy `soc_t <= maxSoc_Wh`, which can make the whole LP infeasible.
    initialSoc_percent:                   Math.min(data.soc.value, settings.maxSoc_percent),
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

  applyExportTariff(base, settings, data, nowMs);

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
    // A hold that has been pending (enabled, never started) for
    // REBALANCE_PENDING_GIVE_UP_MS solves like a completed cycle: no hold
    // window, and the planner switches rebalancing off after the solve. The
    // window's DESS hold blocks battery-to-grid export, so a hold that can
    // never start must not stay mapped forever.
    const pendingSinceMs = data.rebalanceState?.pendingSinceMs ?? null;
    const pendingExpired = startMs_ == null && pendingSinceMs != null
      && nowMs - pendingSinceMs >= REBALANCE_PENDING_GIVE_UP_MS;
    const remainingSlots = startMs_ != null
      ? Math.max(0, holdSlots - slotsElapsed)
      : (pendingExpired ? 0 : holdSlots);
    base.rebalanceHoldSlots = holdSlots;
    base.rebalanceRemainingSlots = remainingSlots;
    base.rebalanceTargetSoc_percent = settings.maxSoc_percent;
    // Within REBALANCE_START_TOLERANCE_PERCENT of the target the planner stamps
    // the hold start (and, once started, pins it to slot 0), so the hold the LP
    // enforces from slot 0 must be reachable from the live SoC. The LP needs
    // SoC >= its hold level by the end of the window's first slot; with the
    // learned charge taper (or CV thresholds) on a large pack, closing the last
    // point takes more than one slot. At the full target the window could then
    // never start at slot 0, the clock never stamped (and rebalancing was
    // switched off after REBALANCE_PENDING_GIVE_UP_MS), and a started hold's
    // slot-0 pin was infeasible every cycle (a relaxation search each plan).
    // Only the LP's hold level drops: the DESS-mapped target stays at
    // rebalanceTargetSoc_percent, so Victron still tops the pack up
    // (proBattery at >= 100 % is its keep-battery-charged path).
    // A started hold keeps the relaxed level regardless of the live SoC: its
    // start is pinned to slot 0, so a reading that dips just under the
    // tolerance band (e.g. 98.9 % on a 100 % target) would otherwise restore
    // the full target, make the pin infeasible and push the window to k > 0
    // while the wall-clock countdown keeps running.
    //
    // Once the hold has started its wall-clock countdown is running, so the
    // remaining slots must be held from now on. Without this cap the solver
    // may re-place them later in the horizon (e.g. export now, recharge at a
    // cheaper hour, re-enter the hold), and the cycle then completes on the
    // clock after far less real hold time than requested.
    // A hold that has not started yet gets the same slot-0 cap once the live
    // SoC is within the start tolerance (the relaxed hold level above makes
    // slot 0 reachable). Left free, the window's start is decided by a
    // 1e-6-per-slot tie-break that is far below the MIP gap, so an "Optimal"
    // plan may place it at any near-equal-cost k > 0 on every cycle: the
    // planner only stamps a plan that holds from slot 0, so the clock would
    // never start and the pending give-up would switch rebalancing off
    // without a hold. With the cap the plan holds from slot 0 and stamps; a
    // cap that is infeasible goes through the planner's relaxation search.
    const withinStartTolerance = data.soc.value >= settings.maxSoc_percent - REBALANCE_START_TOLERANCE_PERCENT;
    if (remainingSlots > 0 && (startMs_ != null || withinStartTolerance)) {
      base.rebalanceHoldSoc_percent = settings.maxSoc_percent - REBALANCE_START_TOLERANCE_PERCENT;
      base.rebalanceMaxStartSlot = 0;
    }
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
    // Live target (the car's own charge limit, when an entity is configured and
    // readable) wins over the static setting — planning to a target the car
    // refuses to reach books cheap slots for a charge that never happens.
    const targetSoc_percent = evState.targetSoc_percent ?? settings.evTargetSoc_percent;

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
      const requestedTargetWh = Math.min((targetSoc_percent / 100) * capacityWh, capacityWh);

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
      /* v8 ignore next — the `?? 0` arm is unreachable: Number.isFinite() short-circuits the && for any nullish evMinSoc_percent, so the nullish-coalesce never falls back */
      if (Number.isFinite(settings.evMinSoc_percent) && (settings.evMinSoc_percent ?? 0) > 0) {
        ev.evMinSocFloor_percent = Math.min(settings.evMinSoc_percent!, targetSoc_percent);
      }

      // Opportunistic top-up bands (caps above target, clamped to 100%).
      if (settings.evOpportunisticEnabled && Number.isFinite(settings.evOpportunisticLevel_percent)) {
        const cap = Math.min(100, Math.max(targetSoc_percent, settings.evOpportunisticLevel_percent!));
        if (cap > targetSoc_percent) ev.evOpportunisticCap_percent = cap;
      }
      if (settings.evOpportunisticType2Enabled && Number.isFinite(settings.evOpportunisticType2Level_percent)) {
        const base1 = ev.evOpportunisticCap_percent ?? targetSoc_percent;
        const cap2 = Math.min(100, Math.max(base1, settings.evOpportunisticType2Level_percent!));
        if (cap2 > base1) ev.evOpportunisticType2Cap_percent = cap2;
      }

      if (settings.evContinuous) ev.evContinuous = true;

      // Multi-day horizon: plan the EV through the forecast days too, so its
      // charge can wait for cheaper ones (buildExtendedSolverConfig moves the
      // departure; the firm-only LP is unchanged):
      // - no deadline (none set, or an elapsed one): the target is due at the
      //   end of the extended horizon, unless evDeferMinSoc_percent is at or
      //   above the target ("never wait": due at the published-price end);
      // - a deadline past the published prices: the target is due at the
      //   deadline (the firm-only LP sets no target there, as before).
      // The car is first topped up to evDeferMinSoc_percent as soon as
      // possible, via the mask-exempt minimum-SoC floor, so it never waits
      // while below it.
      const deferMin_percent = settings.evDeferMinSoc_percent ?? DEFAULT_EV_DEFER_MIN_SOC_PERCENT;
      const noDeadline = departureMs == null || depSlot <= 0;
      const deadlinePastFirm = departureMs != null && depSlot > T;
      if (settings.extendedHorizon?.mode === 'on'
        && ((noDeadline && deferMin_percent < targetSoc_percent) || deadlinePastFirm)) {
        ev.evDeferToForecast = true;
        if (deferMin_percent > 0 && deferMin_percent < targetSoc_percent) {
          ev.evMinSocFloor_percent = Math.max(ev.evMinSocFloor_percent ?? 0, deferMin_percent);
        }
      }

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

/**
 * Where `buildPlannerConfig` reads the adaptive-learning calibration from. The
 * planner always uses the persisted files under DATA_DIR (the default); the
 * solver-refresh gate (scripts/compare-highs-builds.ts) passes a production
 * snapshot instead, so it solves the LP production solves without touching the
 * local DATA_DIR.
 */
export interface CalibrationSources {
  loadCalibration: () => Promise<CalibrationResult | null>;
  loadEvCalibration: () => Promise<EvCalibrationResult | null>;
}

const STORED_CALIBRATION: CalibrationSources = { loadCalibration, loadEvCalibration };

/**
 * The single place a planner `SolverConfig` is assembled from persisted state:
 * prediction adjustments → `buildSolverConfigFromSettings` → (adaptive learning
 * in 'auto' mode) the learned charge/CV taper → the learned EV charge taper.
 *
 * Every solve the planner runs — the main plan and the EV preview — goes
 * through here, so no caller can rebuild a config that silently drops the
 * adjustments or the calibration — the planner's soc=mqtt rebuild did exactly
 * that on every solve from 2026-04-30 (a848f1b) until 0.7.64.
 */
export async function buildPlannerConfig(
  settings: Settings,
  data: Data,
  startMs: number,
  evState?: EvLiveState,
  calibrationSources: CalibrationSources = STORED_CALIBRATION,
): Promise<SolverConfig> {
  const adjustedData = applyPredictionAdjustmentsToData(data);
  let cfg = buildSolverConfigFromSettings(settings, adjustedData, startMs, evState);

  // Apply calibration when adaptive learning is in 'auto' mode
  if (settings.adaptiveLearning?.enabled && settings.adaptiveLearning.mode === 'auto') {
    try {
      const cal = await calibrationSources.loadCalibration();
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
        const evCal = await calibrationSources.loadEvCalibration();
        if (evCal) {
          cfg = applyEvCalibration(cfg, evCal);
        }
      } catch (err) {
        console.warn('[config-builder] Failed to load EV calibration:', (err as Error).message);
      }
    }
  }

  return cfg;
}

// ----------------------------- Multi-day horizon ---------------------------

/** What the extended config needs from the firm-only solve. */
export interface ExtendedFirmResult {
  /** Objective of the firm-only solve. Not read here: the planner derives the extended MIP gap from it. */
  objective?: number;
  /** The firm-only plan's SoC at the end of the firm part, `rows[firmSlots − 1].soc` (Wh). Becomes `socRef_Wh`. */
  socAtFirmEnd_Wh: number;
  /** Start slot of the hold window the firm-only plan chose (`rebalanceWindow.startIdx`), when it has one. */
  rebalanceStartSlot?: number;
}

export interface BuildExtendedSolverConfigInput {
  /** The firm-only config exactly as it was solved (after any rebalance pin relaxation). */
  firmCfg: SolverConfig;
  settings: Settings;
  /** The plan data (getSolverInputs' `data`); prediction adjustments are applied here as in buildPlannerConfig. */
  data: Data;
  /** Start of slot 0, the same instant the firm config was built for. */
  nowMs: number;
  firmResult: ExtendedFirmResult;
}

export type ExtendedHorizonSkipReason =
  | 'off'                 // extendedHorizon.mode is not `on`
  | 'forecastMissing'     // no stored price forecast
  | 'forecastStale'       // the stored forecast is older than 12 h
  | 'forecastRegion'      // the stored forecast is for another region
  | 'noForecastSlots'     // nothing to append: load/PV/window/forecast end at or before the firm end
  | 'fitRejected'         // import fit rejected and no usable stored fit
  | 'exportInconsistent'  // net-metered forecast slots, but the firm export relation is inconsistent
  | 'invalidFirmResult';  // socAtFirmEnd_Wh is not a finite number

/**
 * Which series ends the extended horizon (the earliest end; ties in this
 * order), or `fitYear`: the fresh import fit is on this year's published
 * prices and the next year's slots are left out (`priceForecastSlots`).
 */
export type ExtendedHorizonEndReason = 'load' | 'pv' | 'evLoad' | 'window' | 'forecast' | 'fitYear';

export interface ExtendedHorizonInfo {
  /** Firm (published-price) slots: the firm config's T, `cfg.firmSlots`. */
  firmSlots: number;
  /** Forecast slots appended after the firm part. */
  extendedSlots: number;
  /** firmSlots + extendedSlots. */
  totalSlots: number;
  /** ISO end of the firm part and of the extended horizon. */
  firmEnd: string;
  end: string;
  endReason: ExtendedHorizonEndReason;
  /** Resolution the forecast was resampled to (the firm import's). */
  resolution: ImportResolution;
  /** The import fit used: fresh (`fittedAt` = now) or the stored fallback. */
  fit: PriceForecastFit & { source: 'fresh' | 'stored'; method?: ImportFit['method'] };
  /** Why the fresh fit was rejected, when the stored fit was used instead. */
  freshFitRejection?: { reason: FitRejectionReason; message: string };
  /** Continued net-metering export relation, or null when no forecast slot is net-metered. */
  exportRelation: ExportRelation | null;
  /** Region of the forecast, for `persistPriceForecastFit`. */
  region: PriceForecastRegion;
  /** A fresh accepted fit for the caller to persist with `persistPriceForecastFit` (absent when the stored fit was used). */
  newFit?: PriceForecastFit;
}

export interface ExtendedHorizonSkip {
  skipped: ExtendedHorizonSkipReason;
  message: string;
  /** With `noForecastSlots`: which series ended the horizon. */
  endReason?: ExtendedHorizonEndReason;
  /** With `fitRejected`: the fresh fit's rejection and why the stored fit was not usable. */
  fitRejection?: { reason: FitRejectionReason; message: string; storedRejection: StoredFitRejectionReason };
}

export type ExtendedSolverConfigResult = { cfg: SolverConfig; info: ExtendedHorizonInfo } | ExtendedHorizonSkip;

const FORECAST_STATE_SKIP = {
  missing: 'forecastMissing',
  stale: 'forecastStale',
  region: 'forecastRegion',
} as const;

/**
 * The extended (multi-day) solver config, derived from the firm-only config
 * that was just solved, or the reason there is none. Pure (no I/O).
 *
 * - Only with `extendedHorizon.mode` `on` and a fresh stored forecast for the
 *   configured region.
 * - Forecast slots run from the firm end to the earliest of the load end, the
 *   PV end, the evLoad end (when evLoad is used, as in the firm config), the
 *   extended window end (`extendedWindowEndMs`: the local midnight at or
 *   after the firm end plus `extraDays` calendar days) and
 *   the forecast end; pricing may cut that short where the forecast lacks a
 *   quarter of a slot's hour.
 * - The firm part of every array is the firm config's own (calibration
 *   thresholds, adjustments and the export tariff are therefore identical);
 *   forecast load/PV come from the plan data with the prediction adjustments
 *   applied, exactly like buildPlannerConfig.
 * - Prices: see lib/forecast-pricing.ts. The export tariff is applied to the
 *   forecast slots with the forecast market price as the market series; the
 *   terminal valuation follows the extended last slot (reset to the settings
 *   first, so a firm-only override does not leak), and `exportTariffInfo`
 *   counts both parts.
 * - `firmSlots`, `socRef_Wh` (the firm-only SoC at the firm end) and
 *   `carryOverMargin_cents_per_kWh` (`riskMargin_cents_per_kWh`) are set.
 * - A rebalance hold's start is fixed (`rebalanceMinStartSlot` =
 *   `rebalanceMaxStartSlot`) at the start the firm plan chose, so the extended
 *   solve has no window to search; without a reported start, or for a hold
 *   longer than the firm part, the firm config's cap is kept (buildLP then
 *   defers a hold that has no slot-0 pin).
 * - EV config stays as in the firm config: buildLP confines it to firm slots,
 *   except an EV with `evDeferToForecast`, whose departure becomes its
 *   deadline past the firm part (capped at the extended length) or, without
 *   a deadline, the extended length.
 *
 * A fresh accepted import fit is returned as `info.newFit`; the caller
 * persists it (fire-and-forget) with `persistPriceForecastFit`, keeping this
 * function free of I/O and the stored fallback fit current.
 */
export function buildExtendedSolverConfig({
  firmCfg, settings, data, nowMs, firmResult,
}: BuildExtendedSolverConfigInput): ExtendedSolverConfigResult {
  const horizon = settings.extendedHorizon;
  if (horizon?.mode !== 'on') {
    return { skipped: 'off', message: 'the multi-day horizon is not switched on' };
  }
  if (!Number.isFinite(firmResult.socAtFirmEnd_Wh)) {
    return { skipped: 'invalidFirmResult', message: 'the firm-only plan has no SoC at the firm end' };
  }
  const status = getPriceForecastStatus(data, horizon, nowMs);
  if (status.state !== 'fresh') {
    return { skipped: FORECAST_STATE_SKIP[status.state], message: `the price forecast is ${status.state === 'region' ? 'for another region' : status.state}` };
  }
  const forecast = status.forecast!;

  const stepMs = settings.stepSize_m * 60_000;
  const firmSlots = firmCfg.load_W.length;
  const firmEndMs = nowMs + firmSlots * stepMs;
  const adjusted = applyPredictionAdjustmentsToData(data);
  const evLoad = resolveEvMode(settings) !== 'native' && data.evLoad ? data.evLoad : undefined;

  const ends: Array<[ExtendedHorizonEndReason, number]> = [
    ['load', getSeriesEndMs(adjusted.load)],
    ['pv', getSeriesEndMs(adjusted.pv)],
    ['evLoad', evLoad ? getSeriesEndMs(evLoad) : Infinity],
    ['window', extendedWindowEndMs(settings, firmEndMs)],
    ['forecast', getSeriesEndMs(forecast.series)],
  ];
  let [endReason, endMs] = ends[0];
  for (const [reason, ms] of ends) {
    if (ms < endMs) [endReason, endMs] = [reason, ms];
  }
  const requested = Math.floor((endMs - nowMs) / stepMs) - firmSlots;
  if (requested <= 0) {
    return { skipped: 'noForecastSlots', endReason, message: `no slots to append: the ${endReason} data ends at or before the firm end` };
  }

  const slotStartsMs = Array.from({ length: requested }, (_, i) => firmEndMs + i * stepMs);
  const priced = priceForecastSlots({
    nowMs,
    stepSize_m: settings.stepSize_m,
    firmStartMs: nowMs,
    firmImport: firmCfg.importPrice,
    firmSourceExport: extractWindow(data.exportPrice, nowMs, firmEndMs),
    slotStartsMs,
    importSeries: data.importPrice,
    importPublishedUntilMs: publishedImportEndMs(data, settings.dataSources.prices),
    forecast: { series: forecast.series, publishedEndMs: Date.parse(forecast.publishedEnd), fit: forecast.fit },
    vat_percent: horizon.importVat_percent,
    tariff: settings.exportTariff,
    marketSourceConfigured: isMarketSourceConfigured(settings, data),
  });
  if (!priced.ok) {
    if (priced.reason === 'noForecastSlots') {
      return { skipped: 'noForecastSlots', endReason: 'forecast', message: priced.message };
    }
    return { skipped: priced.reason, message: priced.message, ...(priced.fitRejection ? { fitRejection: priced.fitRejection } : {}) };
  }

  const extendedSlots = priced.slots;
  if (priced.truncationReason) endReason = priced.truncationReason;
  const extEndMs = firmEndMs + extendedSlots * stepMs;
  const tail = (series: TimeSeries) => extractWindow(series, firmEndMs, extEndMs);

  const cfg: SolverConfig = {
    ...firmCfg,
    load_W: [...firmCfg.load_W, ...tail(adjusted.load)],
    pv_W: [...firmCfg.pv_W, ...tail(adjusted.pv)],
    importPrice: [...firmCfg.importPrice, ...priced.importPrice],
    exportPrice: [...firmCfg.exportPrice, ...priced.export.exportPrice],
    evLoad_W: [...(firmCfg.evLoad_W ?? new Array<number>(firmSlots).fill(0)), ...(evLoad ? tail(evLoad) : new Array<number>(extendedSlots).fill(0))],
    terminalSocValuation: settings.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: settings.terminalSocCustomPrice_cents_per_kWh,
    firmSlots,
    socRef_Wh: firmResult.socAtFirmEnd_Wh,
    carryOverMargin_cents_per_kWh: horizon.riskMargin_cents_per_kWh,
  };
  if (firmCfg.ev?.evDeferToForecast) {
    // Due at a deadline past the firm part (capped at the extended end), else
    // at the extended end.
    const totalSlots = firmSlots + extendedSlots;
    const departureMs = resolveDepartureMs(settings.evDepartureTime, settings.evDepartureDay, nowMs);
    const deadlineSlots = departureMs != null ? Math.floor((departureMs - nowMs) / stepMs) : 0;
    cfg.ev = { ...firmCfg.ev, evDepartureSlot: deadlineSlots > firmSlots ? Math.min(deadlineSlots, totalSlots) : totalSlots };
  }

  if (settings.exportTariff && firmCfg.exportTariffInfo) {
    const firmInfo = firmCfg.exportTariffInfo;
    cfg.exportTariffInfo = {
      marketPricedSlots: firmInfo.marketPricedSlots + priced.export.marketPricedSlots,
      fallbackSlots: firmInfo.fallbackSlots + priced.export.fallbackSlots,
      // Decided by the last slot, which is now the extended one.
      missingMarketSource: priced.export.missingMarketSource,
      effectiveFrom: firmInfo.effectiveFrom,
      terminalOverride: applyTerminalOverride(cfg, settings, priced.export.regime[extendedSlots - 1]),
    };
  }

  // The hold start is fixed (min = max) at the firm plan's, so the extended
  // solve never branches on it. A hold longer than the firm part is the
  // exception: the firm-only LP could only start it at slot 0 (its window
  // covers the whole firm horizon), which is no choice, so that 0 is not
  // passed on; the firm config's own cap is kept instead, so a slot-0 pin (a
  // started hold, or the "hold from now" cap within the start tolerance)
  // still holds from slot 0, and otherwise buildLP defers the hold
  // (isRebalanceHoldDeferred).
  const holdSlots = Math.trunc(firmCfg.rebalanceRemainingSlots ?? 0);
  const startSlot = firmResult.rebalanceStartSlot;
  if (holdSlots > 0 && holdSlots <= firmSlots && startSlot != null && Number.isFinite(startSlot)) {
    const start = Math.max(0, Math.trunc(startSlot));
    cfg.rebalanceMaxStartSlot = start;
    cfg.rebalanceMinStartSlot = start;
  }

  const fit = { ...priced.fit, source: priced.fitSource, ...(priced.fitMethod ? { method: priced.fitMethod } : {}) };
  const info: ExtendedHorizonInfo = {
    firmSlots,
    extendedSlots,
    totalSlots: firmSlots + extendedSlots,
    firmEnd: new Date(firmEndMs).toISOString(),
    end: new Date(extEndMs).toISOString(),
    endReason,
    resolution: priced.resolution,
    fit,
    ...(priced.freshFitRejection ? { freshFitRejection: priced.freshFitRejection } : {}),
    exportRelation: priced.exportRelation,
    region: forecast.region,
    ...(priced.fitSource === 'fresh' ? { newFit: { ...priced.fit } } : {}),
  };
  return { cfg, info };
}

/** A stored fit equal to the new one is rewritten only when it is older than this (keeps its age honest). */
export const FIT_REWRITE_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Store an accepted import fit as `data.priceForecast.fit` (the fallback when
 * a later fit is rejected). Skipped when there is no stored forecast, it is
 * for another region, or the stored fit has the same a, b, n and mad and is
 * younger than FIT_REWRITE_MIN_AGE_MS (no data.json write every plan).
 * Never throws; resolves to whether it wrote. Meant to be called without
 * awaiting it in the solve path.
 */
export async function persistPriceForecastFit(
  fit: PriceForecastFit,
  region: PriceForecastRegion,
  nowMs: number = Date.now(),
): Promise<boolean> {
  let wrote = false;
  try {
    await updateData(current => {
      const pf = current.priceForecast;
      if (!pf || pf.region !== region) return null;
      const stored = pf.fit;
      if (stored && stored.a === fit.a && stored.b === fit.b && stored.n === fit.n && stored.mad === fit.mad
        && nowMs - Date.parse(stored.fittedAt) < FIT_REWRITE_MIN_AGE_MS) {
        return null;
      }
      wrote = true;
      return { ...current, priceForecast: { ...pf, fit: { ...fit } } };
    });
  } catch (err) {
    console.warn('[config-builder] could not store the price forecast fit:', (err as Error).message);
    return false;
  }
  return wrote;
}

/**
 * The data a plan is built from, derived from the stored `data.json`: the live
 * SoC reading (when there is one), expired prediction adjustments pruned and a
 * full-SoC observation recorded. Returns `current` itself when nothing changed.
 * Pure: `getSolverInputs` applies it under the data-store lock, and the
 * solver-refresh gate applies it to a production snapshot.
 */
export function preparePlanData(current: Data, startMs: number, liveSoc?: SocData): Data {
  let next = liveSoc ? { ...current, soc: liveSoc } : current;
  next = pruneExpiredPredictionAdjustments(next, startMs).data;
  next = recordFullSocObservation(next);
  return next;
}

export interface SolverInputsOptions {
  /**
   * Live battery SoC reader (percent), consulted only when
   * `settings.dataSources.soc === 'mqtt'`. It must throw when no reading is
   * available — the plan is not built from a stale SoC — and its result is
   * persisted (only the `soc` field) before the config is built.
   */
  readLiveSoc?: (settings: Settings) => Promise<number>;
}

export async function getSolverInputs(
  { readLiveSoc }: SolverInputsOptions = {},
): Promise<{ cfg: SolverConfig; timing: { startMs: number; stepMin: number }; data: Data; settings: Settings; evState?: EvLiveState }> {
  const settings = await loadSettings();
  const startMs = getQuarterStart(new Date(), settings.stepSize_m);

  // Live SoC first, outside the data lock (an MQTT round-trip can take seconds).
  let liveSoc: SocData | undefined;
  if (readLiveSoc && settings.dataSources.soc === 'mqtt') {
    const value = await readLiveSoc(settings);
    liveSoc = { timestamp: new Date().toISOString(), value };
  }

  // Patch the fresh file under the store's lock — the live SoC, expired
  // adjustments pruned, a full-SoC observation — instead of writing back a
  // snapshot loaded before the awaits, which reverted any data.json write
  // (a prediction adjustment, POST /data) that landed in between.
  const data = await updateData(current => {
    const next = preparePlanData(current, startMs, liveSoc);
    return next === current ? null : next;
  });

  let evState: EvLiveState | undefined;
  if (resolveEvMode(settings) === 'native' && settings.evSocSensor && settings.evPlugSensor) {
    try {
      // fetchEvTargetSoc never rejects (null when unset/unreadable), so a missing
      // target entity can't take the SoC/plug read down with it.
      const [socEntity, plugEntity, liveTarget] = await Promise.all([
        fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evSocSensor }),
        fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evPlugSensor }),
        fetchEvTargetSoc(settings),
      ]);
      const soc_percent = parseFloat(socEntity.state);
      const pluggedIn = plugEntity.state !== 'disconnected'
        && plugEntity.state !== 'unavailable'
        && plugEntity.state !== 'unknown'
        && plugEntity.state !== 'off';
      if (Number.isFinite(soc_percent)) {
        evState = { pluggedIn, soc_percent };
        if (liveTarget != null) {
          evState.targetSoc_percent = liveTarget;
          // Every failure path here is deliberately silent, so the success path
          // has to say something — otherwise a plan built to a target the user
          // never typed is indistinguishable from one built to the setting.
          // Once per plan, not per control tick, and only when they disagree.
          if (liveTarget !== settings.evTargetSoc_percent) {
            console.log(`[ev] target SoC ${liveTarget}% read from ${settings.evTargetSocEntity} (overrides the ${settings.evTargetSoc_percent}% setting)`);
          }
        }
      }
    } catch (err) {
      console.warn('Could not read EV state from HA:', err instanceof Error ? err.message : String(err));
    }
  }

  // Built exactly once, from the data the plan reports: callers must not
  // rebuild it (use buildPlannerConfig for any other solve).
  const cfg = await buildPlannerConfig(settings, data, startMs, evState);

  // evState is returned for the EV preview, which plans the car as if plugged
  // in now and needs the live SoC/target that was read here.
  return { cfg, timing: { startMs, stepMin: settings.stepSize_m }, data, settings, evState };
}
