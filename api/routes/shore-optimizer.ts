import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { toHttpError } from '../http-errors.ts';
import { loadSettings } from '../services/settings-store.ts';
import { getShoreOptimizerStatus } from '../services/shore-optimizer.ts';

const router = express.Router();

router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    res.json(getShoreOptimizerStatus(settings.shoreOptimizer));
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read shore optimizer status'));
  }
});

export default router;
