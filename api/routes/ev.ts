import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http-errors.ts';
import { getLastPlan } from '../services/planner-service.ts';
import { loadSettings } from '../services/settings-store.ts';
import { computeEvDecision } from '../services/ev-decision-service.ts';
import { getLastActuation } from '../services/ev-actuator-service.ts';

const router = express.Router();

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

    const slots = plan.rows.map(row => {
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

    res.json({
      planStart: new Date(plan.timing.startMs).toISOString(),
      slots,
      summary: {
        evChargeTotal_kWh: plan.summary.evChargeTotal_kWh,
        evChargeFromGrid_kWh: plan.summary.evChargeFromGrid_kWh,
        evChargeFromPv_kWh: plan.summary.evChargeFromPv_kWh,
        evChargeFromBattery_kWh: plan.summary.evChargeFromBattery_kWh,
      },
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

export default router;
