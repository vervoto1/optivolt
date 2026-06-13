import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { loadSettings } from '../services/settings-store.ts';
import { getEssState, getEssHistory } from '../services/ess-service.ts';
import type { EssHistoryPeriod } from '../types.ts';

const router = express.Router();

// GET /ess/state — live snapshot of all configured ESS entities.
router.get('/state', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    res.json(await getEssState(settings));
  } catch (err) {
    next(err);
  }
});

function clampHours(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(168, Math.round(n)));
}

function clampPeriod(raw: unknown, fallback: EssHistoryPeriod): EssHistoryPeriod {
  return raw === '5minute' || raw === 'hour' ? raw : fallback;
}

// GET /ess/history?hours=24&period=5minute — trend series for charts.
router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    const hours = clampHours(req.query.hours, settings.essConfig?.historyWindowHours ?? 24);
    const period = clampPeriod(req.query.period, settings.essConfig?.historyPeriod ?? '5minute');
    res.json(await getEssHistory(settings, { hours, period }));
  } catch (err) {
    next(err);
  }
});

export default router;
