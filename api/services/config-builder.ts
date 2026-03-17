import { HttpError } from '../http-errors.ts';
import { loadSettings } from './settings-store.ts';
import { loadData } from './data-store.ts';
import { extractWindow, getQuarterStart } from '../../lib/time-series-utils.ts';
import type { SolverConfig, TimeSeries } from '../../lib/types.ts';
import type { Settings, Data } from '../types.ts';

function getSeriesEndMs(source: TimeSeries): number {
  const step = source.step ?? 15;
  return new Date(source.start).getTime() + source.values.length * step * 60_000;
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
    batteryCost_cent_per_kWh:             settings.batteryCost_cent_per_kWh,
    idleDrain_W:                          settings.idleDrain_W,
    terminalSocValuation:                 settings.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: settings.terminalSocCustomPrice_cents_per_kWh,
    initialSoc_percent:                   data.soc.value,
  };

  // EV load: window if present, otherwise default to zeros matching load_W length
  base.evLoad_W = data.evLoad
    ? extractWindow(data.evLoad, nowMs, endMs)
    : new Array(base.load_W.length).fill(0);

  // Pass through EV discharge constraint setting
  base.disableDischargeWhileEvCharging = settings.evConfig?.disableDischargeWhileCharging ?? false;

  // CV phase thresholds: pass through if enabled
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

  return base;
}

export async function getSolverInputs(): Promise<{ cfg: SolverConfig; timing: { startMs: number; stepMin: number }; data: Data; settings: Settings }> {
  const [settings, data] = await Promise.all([loadSettings(), loadData()]);
  const startMs = getQuarterStart(new Date(), settings.stepSize_m);
  const cfg = buildSolverConfigFromSettings(settings, data, startMs);
  return { cfg, timing: { startMs, stepMin: settings.stepSize_m }, data, settings };
}
