/* v8 ignore start — import lines are v8 branch-counting artifacts */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { loadData, updateData, validateData } from '../services/data-store.ts';
import { loadSettings } from '../services/settings-store.ts';
import { recordFullSocObservation } from '../services/rebalance-nudge.ts';
import { assertCondition, toHttpError } from '../http-errors.ts';
import type { TimeSeries, SocData, Data } from '../types.ts';
/* v8 ignore end */

// v8 ignore next — module-level router instantiation
const router = express.Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await loadData();
    res.json(data);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to load data'));
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = req.body as Record<string, unknown>;
    assertCondition(
      !!payload && typeof payload === 'object' && !Array.isArray(payload),
      400,
      'Payload must be a JSON object',
    );

    const settings = await loadSettings();
    const dataSources = settings.dataSources;

    const sourceMapping: Record<string, string> = {
      load: dataSources.load,
      pv: dataSources.pv,
      importPrice: dataSources.prices,
      exportPrice: dataSources.prices,
      soc: dataSources.soc,
      evLoad: dataSources.evLoad ?? 'api',
    };

    const allowedKeys = ['load', 'pv', 'importPrice', 'exportPrice', 'soc', 'evLoad'];
    const keysToUpdate = Object.keys(payload).filter(k => allowedKeys.includes(k) && sourceMapping[k] === 'api');

    assertCondition(
      keysToUpdate.length > 0,
      400,
      'No valid data keys provided or settings are not set to API',
    );

    for (const key of keysToUpdate) {
      const value = payload[key];
      assertCondition(
        !!value && typeof value === 'object' && !Array.isArray(value),
        400,
        `'${key}' must be a JSON object`,
      );
    }

    // Patch only the posted keys onto data.json as it is at write time, under
    // the store's lock: a planner run or forecast refresh in flight can no
    // longer write its older snapshot over this update (or the reverse).
    const applyPayload = (current: Data): Data => {
      let nextData: Data = { ...current };
      for (const key of keysToUpdate) {
        const value = payload[key];
        if (key === 'soc') {
          nextData.soc = value as SocData;
          nextData = recordFullSocObservation(nextData);
        } else if (key === 'evLoad') {
          nextData.evLoad = value as TimeSeries;
        } else if (key === 'load' || key === 'pv' || key === 'importPrice' || key === 'exportPrice') {
          nextData[key] = value as TimeSeries;
        }
      }
      try {
        validateData(nextData);
      } catch (validationError) {
        const msg = validationError instanceof Error ? validationError.message : String(validationError);
        throw toHttpError(validationError, 400, msg);
      }
      return nextData;
    };

    try {
      await updateData(applyPayload);
    } catch (saveError) {
      // A 400 from applyPayload passes through unchanged (already an HttpError).
      return next(toHttpError(saveError, 500, 'Failed to persist data'));
    }
    logDataUpdateCall(keysToUpdate);
    res.json({ message: 'Data updated successfully', keysUpdated: keysToUpdate });

  } catch (error) {
    next(toHttpError(error, 500));
  }
});

function logDataUpdateCall(keysUpdated: string[]): void {
  console.log('[data] update', {
    timestamp: new Date().toISOString(),
    keysUpdated,
  });
}

export default router;
