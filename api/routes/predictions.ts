import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, assertCondition, toHttpError } from '../http-errors.ts';
import { loadPredictionConfig, updatePredictionConfig } from '../services/prediction-config-store.ts';
import { normalizePredictionConfigPatch, normalizeTemperaturePredictor } from '../services/prediction-config-schema.ts';
import { runPredictionSensorCheck } from '../services/prediction-sensor-check.ts';
import type { HaDerivedSensor, HaSensor } from '../../lib/ha-postprocess.ts';
import { loadSettings } from '../services/settings-store.ts';
import { runAutoSelect } from '../services/prediction-auto-select.ts';
import { getLatestAutoSelectRun, loadAutoSelectHistory } from '../services/prediction-auto-select-store.ts';
import type { PredictConfig } from '../../lib/load-predictor-historical.ts';
import type { PredictionAdjustmentInput } from '../services/prediction-adjustments.ts';
import {
  createStoredPredictionAdjustment,
  deleteStoredPredictionAdjustment,
  loadActiveAdjustmentsAndPrune,
  updateStoredPredictionAdjustment,
} from '../services/prediction-adjustment-store.ts';
import {
  buildPredictionRunConfig,
  executeLoadForecast,
  executePredictionValidation,
  executeStrategyPredictions,
  executeTemperatureStrategyPredictions,
  executePvForecast,
  persistForecastData,
  runCombinedPredictionForecast,
  withAdjustedForecast,
} from '../services/prediction-forecast-runner.ts';

// v8 ignore next — module-level router instantiation
const router = express.Router();

router.get('/config', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();
    res.json({
      ...config,
      isAddon: !!process.env.SUPERVISOR_TOKEN,
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read prediction config'));
  }
});

router.post('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // v8 ignore next — null path of ?? is untestable when req.body always exists
    const patch = normalizePredictionConfigPatch(req.body ?? {});
    // Merged under the store's update lock so a concurrent auto-select write
    // cannot revert this save (or vice versa).
    const merged = await updatePredictionConfig(prev => ({ ...prev, ...patch }));

    res.json({ message: 'Prediction config saved.', config: merged });
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to save prediction config'));
  }
});

// ----------------------------- Manual adjustments ------------------------

router.get('/adjustments', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { adjustments } = await loadActiveAdjustmentsAndPrune();
    res.json({ adjustments });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read prediction adjustments'));
  }
});

router.post('/adjustments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertCondition(
      req.body && typeof req.body === 'object' && !Array.isArray(req.body),
      400,
      'prediction adjustment payload must be an object',
    );

    const result = await createStoredPredictionAdjustment(req.body as PredictionAdjustmentInput);
    res.status(201).json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to create prediction adjustment'));
  }
});

router.patch('/adjustments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertCondition(
      req.body && typeof req.body === 'object' && !Array.isArray(req.body),
      400,
      'prediction adjustment payload must be an object',
    );

    const result = await updateStoredPredictionAdjustment(String(req.params.id), req.body as PredictionAdjustmentInput);
    res.json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to update prediction adjustment'));
  }
});

router.delete('/adjustments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteStoredPredictionAdjustment(String(req.params.id)));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to delete prediction adjustment'));
  }
});

router.post('/validate', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();
    res.json(await executePredictionValidation(config));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Validation failed'));
  }
});

/**
 * Per-hour predictions for one strategy (the comparison table's Chart button).
 * A body with `type: 'temperature'` is a temperature strategy (sensor,
 * lookbackWeeks, dayFilter, bins); anything else is a historical one.
 */
router.post('/validate/strategy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // v8 ignore next — null path of ?? is untestable when req.body always exists
    const body: unknown = req.body ?? {};
    if (typeof body === 'object' && body !== null && (body as { type?: unknown }).type === 'temperature') {
      const strategy = normalizeTemperaturePredictor(body, 'strategy');
      const config = await buildPredictionRunConfig();
      res.json(await executeTemperatureStrategyPredictions(config, strategy));
      return;
    }
    // Reuse the config validator: a historical strategy is exactly a historicalPredictor.
    const { historicalPredictor } = normalizePredictionConfigPatch({ historicalPredictor: body });
    const config = await buildPredictionRunConfig();
    res.json(await executeStrategyPredictions(config, historicalPredictor as PredictConfig));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Validation failed'));
  }
});

// ----------------------------- Sensor check -------------------------------

/**
 * Check sensor entities against Home Assistant and derived formulas against
 * the sensor names. Read-only and advisory: it never saves anything, and an
 * unreachable HA comes back as `reachable: false` with a 200 (the UI warns,
 * it does not block). The body may carry the editor's unsaved `sensors` /
 * `derived`; whatever it omits comes from the stored config.
 */
router.post('/sensors/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // v8 ignore next — null path of ?? is untestable when req.body always exists
    const body: unknown = req.body ?? {};
    const patch = normalizePredictionConfigPatch(body);
    const config = await buildPredictionRunConfig();
    const sensors = (patch.sensors ?? config.sensors ?? []) as HaSensor[];
    const derived = (patch.derived ?? config.derived ?? []) as HaDerivedSensor[];
    res.json(await runPredictionSensorCheck({ haUrl: config.haUrl ?? '', haToken: config.haToken ?? '' }, sensors, derived));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Sensor check failed'));
  }
});

// ----------------------------- Strategy auto-select -----------------------

/** Settings + last run; the full ring buffer only with `?history=1` (the card never needs it). */
router.get('/auto-select', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const withHistory = req.query.history === '1' || req.query.history === 'true';
    const [settings, lastRun, history] = await Promise.all([
      loadSettings(),
      getLatestAutoSelectRun(),
      withHistory ? loadAutoSelectHistory() : Promise.resolve(null),
    ]);
    res.json({
      config: settings.predictionAutoSelect ?? null,
      lastRun,
      ...(history ? { history } : {}),
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read auto-select state'));
  }
});

router.post('/auto-select/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // v8 ignore next — null path of ?? is untestable when req.body always exists
    const body = (req.body ?? {}) as { apply?: unknown };
    assertCondition(
      typeof body === 'object' && !Array.isArray(body),
      400,
      'auto-select payload must be an object',
    );
    // Reject anything that isn't a real boolean rather than coercing it: a
    // caller who sends "false" or 0 means a dry run, and silently reading that
    // as apply=true would rewrite prediction-config.json in auto mode.
    assertCondition(
      body.apply === undefined || typeof body.apply === 'boolean',
      400,
      'auto-select "apply" must be a boolean',
    );
    // apply=false forces a dry run regardless of mode (score + record, never write)
    const apply = body.apply !== false;
    res.json(await runAutoSelect({ apply, trigger: 'manual' }));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Auto-select run failed'));
  }
});

// ----------------------------- Load forecast ------------------------------

router.post('/load/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();

    if (req.query.recent === 'false') {
      config.includeRecent = false;
    }

    const result = await executeLoadForecast(config, 'load/forecast');
    await persistForecastData({ load: result.forecast });
    res.json(await withAdjustedForecast(result, 'load'));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Load forecast failed'));
  }
});

// ----------------------------- PV forecast --------------------------------

router.post('/pv/forecast', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();

    const result = await executePvForecast(config, 'pv/forecast');
    await persistForecastData({ pv: result?.forecast });
    res.json(await withAdjustedForecast(result, 'pv'));
  } catch (error) {
    // v8 ignore next — non-HttpError branch of ternary is covered by tests, v8 double-counts
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'PV forecast failed'));
  }
});

// ----------------------------- Combined forecast --------------------------

router.post('/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();
    if (req.query.recent === 'false') config.includeRecent = false;
    // persist=false: a read-only preview (the Predictions tab on open).
    const persist = req.query.persist !== 'false';
    res.json(await runCombinedPredictionForecast(config, 'forecast', { persist }));
  } catch (error) {
    // v8 ignore next — non-HttpError branch of ternary is covered by tests, v8 double-counts
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

router.get('/forecast/now', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();
    config.includeRecent = false;
    res.json(await runCombinedPredictionForecast(config, 'forecast/now'));
  } catch (error) {
    // v8 ignore next — non-HttpError branch of ternary is covered by tests, v8 double-counts
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

export default router;
