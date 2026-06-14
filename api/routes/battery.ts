import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { toHttpError } from '../http-errors.ts';
import { getBatteryChargeStatus } from '../services/battery-charge-controller.ts';
import { getBalanceTunerStatus } from '../services/balance-tuner.ts';

const router = express.Router();

// Combined live status for both battery controllers (charge-current + balancing).
router.get('/', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      charge: getBatteryChargeStatus(),
      balance: getBalanceTunerStatus(),
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read battery controller status'));
  }
});

export default router;
