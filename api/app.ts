import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { HttpError, toHttpError } from './http-errors.ts';
import calculateRouter from './routes/calculate.ts';
import settingsRouter from './routes/settings.ts';
import dataRouter from './routes/data.ts';
import vrmRouter from './routes/vrm.ts';
import predictionsRouter from './routes/predictions.ts';
import planAccuracyRouter from './routes/plan-accuracy.ts';
import haRouter from './routes/ha.ts';
import evRouter from './routes/ev.ts';
import essRouter from './routes/ess.ts';
import shoreOptimizerRouter from './routes/shore-optimizer.ts';
import batteryRouter from './routes/battery.ts';
import { getAutoCalculateHealth } from './services/auto-calculate.ts';
import { getPlanWriteChainHealth } from './services/planner-service.ts';

// A plan/write run pending this long is wedged on an await that never settles.
export const PLAN_WRITE_STUCK_MS = 10 * 60_000;

const app = express();
app.disable('x-powered-by');

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir = join(__dirname, '../app');

app.use(express.json({ limit: '1mb' }));

app.use('/calculate', calculateRouter);
app.use('/settings', settingsRouter);
app.use('/data', dataRouter);
app.use('/vrm', vrmRouter);
app.use('/predictions', predictionsRouter);
app.use('/plan-accuracy', planAccuracyRouter);
app.use('/ha', haRouter);
app.use('/ev', evRouter);
app.use('/ess', essRouter);
app.use('/shore-optimizer', shoreOptimizerRouter);
app.use('/battery', batteryRouter);

// 503 only when work is genuinely stuck, so the Supervisor watchdog (when the user
// enables it) restarts a wedged process. Never tied to whether Venus/VRM/HA are
// reachable: an outage is not fixed by a restart.
app.get('/health', (_req: Request, res: Response) => {
  const nowMs = Date.now();
  const autoCalculate = getAutoCalculateHealth(nowMs);
  const planWrites = getPlanWriteChainHealth(nowMs);
  const reasons: string[] = [];
  if (autoCalculate.stuck) {
    reasons.push(`auto-calculate tick running for ${Math.round(Number(autoCalculate.calculatingForMs) / 1000)}s`);
  }
  if (planWrites.oldestPendingMs !== null && planWrites.oldestPendingMs > PLAN_WRITE_STUCK_MS) {
    reasons.push(`plan/write run pending for ${Math.round(planWrites.oldestPendingMs / 1000)}s`);
  }
  if (reasons.length > 0) {
    res.status(503).json({ message: 'Optivolt API is stuck.', reasons });
    return;
  }
  res.json({ message: 'Optivolt API is running.' });
});

app.use(express.static(staticDir));

app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new HttpError(404, 'Not found'));
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const httpError = toHttpError(err);

  if (httpError.statusCode >= 500) {
    console.error(`Unhandled error for ${_req.method} ${_req.originalUrl}:`, err);
  }

  const payload: Record<string, unknown> = { error: httpError.message };
  if (httpError.expose && httpError.details) {
    payload.details = httpError.details;
  }

  res.status(httpError.statusCode).json(payload);
});

export default app;
