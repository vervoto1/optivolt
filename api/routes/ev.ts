import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http-errors.ts';
import { getLastPlan, getLastEvPreview } from '../services/planner-service.ts';
import { loadSettings, saveSettings } from '../services/settings-store.ts';
import { computeEvDecision } from '../services/ev-decision-service.ts';
import { getLastActuation, runActuatorTick } from '../services/ev-actuator-service.ts';
import type { EvOverrideMode } from '../types.ts';

const router = express.Router();

const OVERRIDE_MODES: readonly EvOverrideMode[] = ['auto', 'charge', 'stop'];

// GET /ev/schedule — full per-slot EV schedule from last computed plan, with an
// advisory override-mode annotation per slot.
router.get('/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = getLastPlan();
    if (!plan) {
      throw new HttpError(404, 'No plan computed yet');
    }
    const settings = await loadSettings();
    const lowPriceOn = !!settings.evLowPriceChargingEnabled
      && Number.isFinite(settings.evLowPriceChargingLevel_cents_per_kWh);
    const lowPriceLevel = settings.evLowPriceChargingLevel_cents_per_kWh ?? 0;

    // When the real plan excludes the EV (car disconnected), fall back to the
    // advisory preview: the schedule as it would be if plugged in now, seeded
    // from the live SoC. This is display-only and never drives Victron.
    const evActiveInPlan = plan.rows.some(r => (r.ev_charge ?? 0) > 0 || (r.ev_soc_percent ?? 0) > 0);
    const preview = evActiveInPlan ? null : getLastEvPreview();
    const sourceRows = preview?.rows ?? plan.rows;
    const timing = preview?.timing ?? plan.timing;

    const slots = sourceRows.map(row => {
      // Advisory: the mode this slot would take under the reactive overrides,
      // given the forecast price. The planned charge stays the LP result.
      let override_mode = row.ev_charge > 0 ? (row.ev_plan_mode ?? 'planned') : 'idle';
      if (lowPriceOn && row.ic <= lowPriceLevel) override_mode = 'low_price';
      return {
        timestampMs: row.timestampMs,
        ev_charge_W: row.ev_charge,
        ev_charge_A: row.ev_charge_A,
        ev_charge_mode: row.ev_charge_mode,
        ev_plan_mode: row.ev_plan_mode,
        override_mode,
        g2ev_W: row.g2ev,
        pv2ev_W: row.pv2ev,
        b2ev_W: row.b2ev,
        ev_soc_percent: row.ev_soc_percent,
        price_cents_per_kWh: row.ic,
      };
    });

    const summary = preview
      ? preview.summary
      : {
          evChargeTotal_kWh: plan.summary.evChargeTotal_kWh,
          evChargeFromGrid_kWh: plan.summary.evChargeFromGrid_kWh,
          evChargeFromPv_kWh: plan.summary.evChargeFromPv_kWh,
          evChargeFromBattery_kWh: plan.summary.evChargeFromBattery_kWh,
        };

    res.json({
      planStart: new Date(timing.startMs).toISOString(),
      slots,
      // true → this is the "if connected" preview, not the active plan; it is
      // NOT applied to Victron. liveSoc_percent is the SoC the preview starts from.
      preview: !!preview,
      liveSoc_percent: preview?.liveSoc_percent ?? null,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

// GET /ev/current — effective current decision, with live reactive overrides.
router.get('/current', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = getLastPlan();
    if (!plan) {
      throw new HttpError(404, 'No plan computed yet');
    }
    const settings = await loadSettings();
    const decision = await computeEvDecision(settings, plan);

    // Plan-derived flow split for context (the slot covering now).
    const nowMs = Date.now();
    const rows = plan.rows;
    let row = rows[0];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].timestampMs <= nowMs) { row = rows[i]; break; }
    }

    res.json({
      timestampMs: row.timestampMs,
      mode: decision.mode,
      reason: decision.reason,
      is_charging: decision.is_charging,
      ev_charge_W: decision.ev_charge_W,
      ev_charge_A: decision.ev_charge_A,
      liveSoc_percent: decision.liveSoc_percent,
      plugConnected: decision.plugConnected,
      currentPrice_cents_per_kWh: decision.currentPrice_cents_per_kWh,
      targetSoc_percent: decision.targetSoc_percent,
      targetMet: decision.targetMet,
      readyBy: decision.readyBy,
      // Plan-derived split (the LP's view of this slot).
      planned_ev_charge_W: row.ev_charge,
      planned_ev_charge_mode: row.ev_charge_mode,
      g2ev_W: row.g2ev,
      pv2ev_W: row.pv2ev,
      b2ev_W: row.b2ev,
      ev_soc_percent: row.ev_soc_percent,
    });
  } catch (err) {
    next(err);
  }
});

// GET /ev/status — compact single-sensor-friendly status object.
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    const plan = getLastPlan();
    const decision = await computeEvDecision(settings, plan);
    res.json({
      mode: decision.mode,
      is_charging: decision.is_charging,
      ev_charge_A: decision.ev_charge_A,
      liveSoc_percent: decision.liveSoc_percent,
      targetSoc_percent: decision.targetSoc_percent,
      targetMet: decision.targetMet,
      readyBy: decision.readyBy,
    });
  } catch (err) {
    next(err);
  }
});

// GET /ev/actuation — last actuation record (observability for the EV tab badge).
router.get('/actuation', (req: Request, res: Response) => {
  res.json(getLastActuation());
});

// GET /ev/override — the current manual charging override (auto/charge/stop).
router.get('/override', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    res.json({ mode: settings.evOverrideMode ?? 'auto' });
  } catch (err) {
    next(err);
  }
});

// POST /ev/override { mode } — pin the charger to charge/stop (held until cleared
// back to 'auto'). Persisted in settings so it survives restarts; the running
// actuator picks it up on its next tick. We also fire one immediate tick so the
// change takes effect now instead of after the control interval. Does NOT restart
// the actuator loop (which would reset its single-owner state) or re-plan DESS.
router.post('/override', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mode = (req.body ?? {}).mode;
    if (!OVERRIDE_MODES.includes(mode)) {
      throw new HttpError(400, `mode must be one of ${OVERRIDE_MODES.join(', ')}`);
    }
    const settings = await loadSettings();
    settings.evOverrideMode = mode as EvOverrideMode;
    await saveSettings(settings);
    // Best-effort instant apply — never let a tick error fail the request.
    void runActuatorTick().catch(() => {});
    res.json({ mode });
  } catch (err) {
    next(err);
  }
});

export default router;
