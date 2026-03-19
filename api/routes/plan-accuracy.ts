import { Router } from 'express';
import type { Request, Response } from 'express';
import { evaluateLatestPlan, evaluateRecentPlans } from '../services/plan-accuracy-service.ts';
import { loadCalibration, resetCalibration, calibrate } from '../services/efficiency-calibrator.ts';
import { loadPlanHistory } from '../services/plan-history-store.ts';
import { getRecentSamples } from '../services/soc-tracker.ts';

const router = Router();

/**
 * GET /plan-accuracy?days=1
 * Returns a merged accuracy report across recent plans (default: last 24h).
 * Deviations are deduplicated by timestamp (latest plan wins for each slot).
 */
router.get('/', async (req: Request, res: Response) => {
  const days = Math.min(7, Math.max(0.5, Number(req.query.days) || 1));
  const reports = await evaluateRecentPlans(days);
  if (reports.length === 0) {
    res.json({ message: 'No plan accuracy data available yet', report: null });
    return;
  }

  // Merge deviations across plans: for each timestamp, keep the latest plan's deviation
  const byTimestamp = new Map<number, (typeof reports)[0]['deviations'][0]>();
  for (const r of reports) {
    for (const d of r.deviations) {
      byTimestamp.set(d.timestampMs, d);
    }
  }
  const deviations = [...byTimestamp.values()].sort((a, b) => a.timestampMs - b.timestampMs);

  const absDeviations = deviations.map(d => Math.abs(d.deviation_percent));
  const meanDeviation = absDeviations.length > 0
    ? absDeviations.reduce((a, b) => a + b, 0) / absDeviations.length
    : 0;

  res.json({
    report: {
      planId: 'merged',
      createdAtMs: reports[0].createdAtMs,
      evaluatedAtMs: Date.now(),
      slotsCompared: deviations.length,
      meanDeviation_percent: Math.round(meanDeviation * 100) / 100,
      maxDeviation_percent: absDeviations.length > 0 ? Math.round(Math.max(...absDeviations) * 100) / 100 : 0,
      deviations,
    },
  });
});

/**
 * GET /plan-accuracy/history?days=7
 * Returns accuracy reports for recent plans.
 */
router.get('/history', async (req: Request, res: Response) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
  const reports = await evaluateRecentPlans(days);
  res.json({ days, count: reports.length, reports });
});

/**
 * GET /plan-accuracy/calibration
 * Returns the current calibration state.
 */
router.get('/calibration', async (_req: Request, res: Response) => {
  const calibration = await loadCalibration();
  if (!calibration) {
    res.json({ message: 'No calibration data yet (collecting data)', calibration: null });
    return;
  }
  res.json({ calibration });
});

/**
 * POST /plan-accuracy/calibrate
 * Manually trigger calibration now (instead of waiting for the next auto-calculate cycle).
 */
router.post('/calibrate', async (req: Request, res: Response) => {
  const minDataDays = Math.max(1, Number(req.query.minDataDays) || 1);
  const result = await calibrate(minDataDays);
  if (!result) {
    res.json({ message: 'Calibration returned no result (insufficient data or all slots filtered)', calibration: null });
    return;
  }
  res.json({ message: 'Calibration complete', calibration: result });
});

/**
 * POST /plan-accuracy/calibration/reset
 * Clears all calibration data so it can be rebuilt from scratch.
 */
router.post('/calibration/reset', async (_req: Request, res: Response) => {
  await resetCalibration();
  res.json({ message: 'Calibration data reset' });
});

/**
 * GET /plan-accuracy/snapshots?days=1
 * Returns raw plan snapshots (for debugging).
 */
router.get('/snapshots', async (req: Request, res: Response) => {
  const days = Math.min(7, Math.max(1, Number(req.query.days) || 1));
  const history = await loadPlanHistory();
  const cutoffMs = Date.now() - days * 24 * 60 * 60_000;
  const recent = history.filter(s => s.createdAtMs >= cutoffMs);
  res.json({ days, count: recent.length, snapshots: recent });
});

/**
 * GET /plan-accuracy/soc-samples?days=1
 * Returns raw SoC samples (for debugging).
 */
router.get('/soc-samples', async (req: Request, res: Response) => {
  const days = Math.min(7, Math.max(1, Number(req.query.days) || 1));
  const samples = await getRecentSamples(days);
  res.json({ days, count: samples.length, samples });
});

export default router;
