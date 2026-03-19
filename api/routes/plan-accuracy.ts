import { Router } from 'express';
import type { Request, Response } from 'express';
import { evaluateLatestPlan, evaluateRecentPlans } from '../services/plan-accuracy-service.ts';
import { loadCalibration, resetCalibration } from '../services/efficiency-calibrator.ts';
import { loadPlanHistory } from '../services/plan-history-store.ts';
import { getRecentSamples } from '../services/soc-tracker.ts';

const router = Router();

/**
 * GET /plan-accuracy
 * Returns the accuracy report for the most recent plan.
 */
router.get('/', async (_req: Request, res: Response) => {
  const report = await evaluateLatestPlan();
  if (!report) {
    res.json({ message: 'No plan accuracy data available yet', report: null });
    return;
  }
  res.json({ report });
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
