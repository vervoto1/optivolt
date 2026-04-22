import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, toHttpError } from '../http-errors.ts';
import { loadSettings } from '../services/settings-store.ts';
import { fetchHaEntityState } from '../services/ha-client.ts';

const router = express.Router();

router.get('/entity/:entityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entityId = req.params.entityId as string;
    // v8 ignore next — Express :param never yields empty string for non-empty routes
    if (!entityId) {
      throw new HttpError(400, 'entityId is required');
    }

    const settings = await loadSettings();
    if (!settings.haUrl && !process.env.SUPERVISOR_TOKEN) {
      throw new HttpError(422, 'HA URL is not configured');
    }

    try {
      const state = await fetchHaEntityState({
        haUrl: settings.haUrl,
        haToken: settings.haToken,
        entityId,
      });
      res.json(state);
    } catch (err) {
      // v8 ignore next — non-Error branch of ternary is untestable with real HA responses
      throw toHttpError(err, 422, err instanceof Error ? err.message : 'Failed to fetch entity state');
    }
  } catch (err) {
    next(err);
  }
});

export default router;
