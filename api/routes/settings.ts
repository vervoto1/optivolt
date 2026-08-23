import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { loadSettings, updateSettings } from '../services/settings-store.ts';
import { startAutoCalculate, stopAutoCalculate } from '../services/auto-calculate.ts';
import { startDessPriceRefresh, stopDessPriceRefresh } from '../services/dess-price-refresh.ts';
import { startPvCurtailment, stopPvCurtailment } from '../services/pv-curtailment.ts';
import { startShoreOptimizer, stopShoreOptimizer } from '../services/shore-optimizer.ts';
import { startEvActuator, stopEvActuator } from '../services/ev-actuator-service.ts';
import { startBatteryChargeController, stopBatteryChargeController } from '../services/battery-charge-controller.ts';
import { startBalanceTuner, stopBalanceTuner } from '../services/balance-tuner.ts';
import { startPredictionAutoSelect, stopPredictionAutoSelect } from '../services/prediction-auto-select.ts';
import { mergeSettings, normalizeSettings, sanitizeSettingsResponse } from '../services/settings-schema.ts';
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

    // Merged onto the settings as they are at write time, under the store's
    // lock, so a VRM refresh that loaded them earlier cannot revert this save.
    const mergedSettings = (await updateSettings(prev => normalizeSettings(mergeSettings(prev, incoming as SettingsPatch))))!;

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

export default router;
