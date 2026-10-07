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
      // Checked against the merged result: a patch that would invert a
      // min/max pair is rejected (400) instead of being stored swapped.
      const next = normalizeSettings(mergeSettings(prev, incoming as SettingsPatch), {
        savingPatch: incoming as Record<string, unknown>,
        previous: prev,
      });
      rebalanceToggled = next.rebalanceEnabled !== prev.rebalanceEnabled;
      return next;
    }))!;

    // Switching rebalancing on or off starts a fresh cycle: drop the hold
    // start and the pending marker left from before. A kept pending marker
    // could make config-builder give up on the new hold at once; a kept hold
    // start (disabled mid-hold) would let the countdown run on while
    // rebalancing is off, so re-enabling later found the cycle "complete" and
    // switched rebalancing off again without holding. Switching it on also
    // starts the give-up period now (see resetRebalanceCycle).
    if (rebalanceToggled) await resetRebalanceCycle(mergedSettings.rebalanceEnabled);

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
 * Reset the rebalance cycle progress (a locked patch of the current data file;
 * other fields are kept). Best effort: the settings are already saved.
 *
 * - Switched on: clear `rebalanceState.startMs` and stamp
 *   `rebalanceState.pendingSinceMs` with now. The planner also stamps it, but
 *   only from an Optimal plan, so with solves that keep failing (time limit,
 *   an infeasible hold) the REBALANCE_PENDING_GIVE_UP_MS give-up would never
 *   run and the hold would stay mapped indefinitely.
 * - Switched off: clear `startMs` and `pendingSinceMs`; nothing is written
 *   when both are already clear.
 */
async function resetRebalanceCycle(enabled: boolean): Promise<void> {
  try {
    await updateData(d => {
      const state = d.rebalanceState;
      if (enabled) {
        return { ...d, rebalanceState: { ...state, startMs: null, pendingSinceMs: Date.now() } };
      }
      if (!state || (state.startMs == null && state.pendingSinceMs == null)) return null;
      const { pendingSinceMs: _pendingSinceMs, ...rest } = state;
      return { ...d, rebalanceState: { ...rest, startMs: null } };
    });
  } catch (err) {
    console.warn('[settings] could not reset the rebalance cycle progress:', (err as Error).message);
  }
}

export default router;
