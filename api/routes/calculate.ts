/* v8 ignore start — import lines are v8 branch-counting artifacts */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, toHttpError } from '../http-errors.ts';
import { SolverStatusError } from '../../lib/parse-solution.ts';
import { planAndMaybeWrite, getLastPlan, getLastEvPreview } from '../services/planner-service.ts';
import type { ComputePlanResult } from '../services/planner-service.ts';
/* v8 ignore end */

const router = express.Router();

function planResponseBody(plan: ComputePlanResult) {
  const { cfg, timing, result, rows, summary, rebalanceWindow, rebalanceNudge, computedAtMs } = plan;
  return {
    solverStatus: result.Status,
    objectiveValue: result.ObjectiveValue,
    rows,
    initialSoc_percent: cfg.initialSoc_percent,
    tsStart: new Date(timing.startMs).toISOString(),
    summary,
    rebalanceWindow,
    rebalanceNudge,
    // Present only when the car is disconnected: the EV schedule as it WOULD
    // be if plugged in now (display-only; never written to Victron). The cached
    // preview belongs to the last Optimal plan; computePlan returns an early-stop
    // incumbent before the preview step, so pairing it with that older preview
    // would show a preview that does not match the rows on screen.
    evPreview: result.Status === 'Optimal' ? getLastEvPreview() : null,
    computedAtMs,
  };
}

// GET /calculate/last — the cached last plan (kept fresh by auto-calculate),
// without triggering a solve. Lets the UI hydrate instantly on page load.
router.get('/last', (_req: Request, res: Response, next: NextFunction) => {
  const plan = getLastPlan();
  if (!plan) {
    next(new HttpError(404, 'No plan computed yet'));
    return;
  }
  // computePlan only caches Optimal solves; this is a second check so a
  // non-Optimal plan can never be served as the current plan.
  if (plan.result.Status !== 'Optimal') {
    next(new HttpError(404, 'No optimal plan cached'));
    return;
  }
  res.json(planResponseBody(plan));
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    const shouldUpdateData = !!body.updateData;
    const shouldWriteToVictron = !!body.writeToVictron;

    logCalculateCall(body, {
      updateData: shouldUpdateData,
      writeToVictron: shouldWriteToVictron,
    });

    const plan = await planAndMaybeWrite({
      updateData: shouldUpdateData,
      writeToVictron: shouldWriteToVictron,
      forceWrite: true, // manual trigger always writes
    });

    res.json(planResponseBody(plan));
  } catch (error) {
    logCalculateError(error);
    if (error instanceof SolverStatusError) {
      // The solver returned no usable solution (infeasible, unbounded, error, or
      // an early stop without an incumbent): name the status instead of a generic 500.
      next(new HttpError(502, error.message, { cause: error, expose: true, details: { solverStatus: error.status } }));
      return;
    }
    next(toHttpError(error, 500, 'Failed to calculate plan'));
  }
});

function logCalculateCall(rawBody: unknown, parsed: { updateData: boolean; writeToVictron: boolean }): void {
  console.log('[calculate] request', {
    timestamp: new Date().toISOString(),
    rawBody: rawBody ?? null,
    parsed,
  });
}

function logCalculateError(error: unknown): void {
  const err = error instanceof Error ? error : undefined;
  console.error('[calculate] error', {
    timestamp: new Date().toISOString(),
    message: err?.message,
    name: err?.name,
    stack: err?.stack,
  });
}

export default router;
