import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { loadSettings, updateSettings } from '../services/settings-store.ts';
import { updateData } from '../services/data-store.ts';
import { startAutoCalculate, stopAutoCalculate } from '../services/auto-calculate.ts';
import { startDessPriceRefresh, stopDessPriceRefresh } from '../services/dess-price-refresh.ts';
import { startPvCurtailment, stopPvCurtailment } from '../services/pv-curtailment.ts';
import { startShoreOptimizer, stopShoreOptimizer } from '../services/shore-optimizer.ts';
import { startEvActuator, stopEvActuator } from '../services/ev-actuator-service.ts';
import { startBatteryChargeController, stopBatteryChargeController } from '../services/battery-charge-controller.ts';
import { startBalanceTuner, stopBalanceTuner } from '../services/balance-tuner.ts';
import { startPredictionAutoSelect, stopPredictionAutoSelect } from '../services/prediction-auto-select.ts';
import { mergeSettings, normalizeSettings, sanitizeSettingsResponse, validateSettingsPatch } from '../services/settings-schema.ts';
import type { SettingsPatch } from '../services/settings-schema.ts';

const router = express.Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    res.json({ ...sanitizeSettingsResponse(settings), isAddon: !!process.env.SUPERVISOR_TOKEN });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // v8 ignore next — null path of ?? is untestable when req.body always exists
    const incoming = req.body ?? {};
    assertCondition(
      incoming && typeof incoming === 'object' && !Array.isArray(incoming),
      400,
      'settings payload must be an object',
    );
    // Reject bad efficiencies, non-boolean flags and unknown enum values
    // before anything is merged or persisted.
    validateSettingsPatch(incoming as Record<string, unknown>);

    // Merged onto the settings as they are at write time, under the store's
    // lock, so a VRM refresh that loaded them earlier cannot revert this save.
    let rebalanceToggled = false;
    const mergedSettings = (await updateSettings(prev => {
      const next = normalizeSettings(mergeSettings(prev, incoming as SettingsPatch));
      rebalanceToggled = next.rebalanceEnabled !== prev.rebalanceEnabled;
      return next;
    }))!;

    // Switching rebalancing on or off starts a fresh give-up period: drop a
    // pending marker left from before, so a disable→re-enable between two
    // plans cannot give up on the new hold at once (config-builder).
    if (rebalanceToggled) await clearRebalancePending();

    // Restart timers with new settings
    stopAutoCalculate();
    startAutoCalculate(mergedSettings);
    stopDessPriceRefresh();
    startDessPriceRefresh(mergedSettings);
    await stopPvCurtailment();
    startPvCurtailment(mergedSettings);
    stopShoreOptimizer();
    startShoreOptimizer(mergedSettings);
    stopEvActuator();
    startEvActuator(mergedSettings);
    stopBatteryChargeController();
    startBatteryChargeController(mergedSettings);
    stopBalanceTuner();
    startBalanceTuner(mergedSettings);
    stopPredictionAutoSelect();
    startPredictionAutoSelect(mergedSettings);

    res.json({ message: 'Settings saved successfully.', settings: sanitizeSettingsResponse(mergedSettings) });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

/**
 * Drop `rebalanceState.pendingSinceMs` (a locked patch of the current data
 * file; nothing is written when there is none). Best effort: the settings are
 * already saved, and the planner also drops the marker on its next plan with
 * rebalancing off.
 */
async function clearRebalancePending(): Promise<void> {
  try {
    await updateData(d => (d.rebalanceState?.pendingSinceMs == null
      ? null
      : { ...d, rebalanceState: { startMs: d.rebalanceState.startMs ?? null } }));
  } catch (err) {
    console.warn('[settings] could not clear the pending rebalance marker:', (err as Error).message);
  }
}

export default router;
