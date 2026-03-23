/**
 * Test that discharge phase thresholds correctly reduce discharge power
 * when SoC drops below configured thresholds.
 *
 * Mirrors cv-phase-soc.test.js but for the discharge direction:
 * when SoC drops BELOW a threshold, discharge power is capped.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
// @ts-ignore
import highsFactory from '../../vendor/highs-build/highs.js';

function makeConfig(overrides = {}) {
  const T = 16; // 4 hours of 15-min slots
  return {
    load_W: Array(T).fill(2000),          // 2kW constant load
    pv_W: Array(T).fill(0),               // no PV — forces battery discharge
    importPrice: Array(T).fill(100),       // expensive import — forces battery use
    exportPrice: Array(T).fill(0),
    stepSize_m: 15,
    batteryCapacity_Wh: 10000,             // 10 kWh battery
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxChargePower_W: 5000,
    maxDischargePower_W: 4000,             // 4kW max discharge
    maxGridImport_W: 5000,
    maxGridExport_W: 5000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 2,
    idleDrain_W: 0,                        // no idle drain for cleaner math
    terminalSocValuation: 'zero',
    terminalSocCustomPrice_cents_per_kWh: 0,
    initialSoc_percent: 80,                // start at 80% — will discharge down
    dischargePhaseThresholds: [
      { soc_percent: 30, maxDischargePower_W: 2000 }, // below 30%: cap at 2kW
    ],
    ...overrides,
  };
}

describe('Discharge phase SoC consistency', () => {
  let highs;

  beforeAll(async () => {
    highs = await highsFactory({});
  });

  it('discharge power respects threshold when SoC drops below it', async () => {
    const cfg = makeConfig();
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);

    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, {
      startMs: Date.now(),
      stepMin: cfg.stepSize_m,
    });

    for (let i = 1; i < rows.length; i++) {
      const prevSocPercent = rows[i - 1].soc_percent;
      const totalDischarge = rows[i].b2l + rows[i].b2g;

      if (prevSocPercent < 30) {
        // Below 30%: discharge should not exceed 2000W (+ small tolerance)
        expect(totalDischarge).toBeLessThanOrEqual(2000 + 1);
      }
    }
  });

  it('discharge power is not restricted above threshold', async () => {
    // Use high load so battery discharge can exceed the throttled 2kW rate
    const cfg = makeConfig({
      load_W: Array(16).fill(4000),   // 4kW load — allows full 4kW discharge
      maxGridExport_W: 5000,
    });
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);

    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, {
      startMs: Date.now(),
      stepMin: cfg.stepSize_m,
    });

    // Find slots where SoC is well above 30% — discharge should be at full rate
    const highSocSlots = [];
    for (let i = 1; i < rows.length; i++) {
      const prevSocPercent = rows[i - 1].soc_percent;
      const totalDischarge = rows[i].b2l + rows[i].b2g;
      if (prevSocPercent > 35 && totalDischarge > 100) {
        highSocSlots.push({ slot: i, prevSoc: prevSocPercent, discharge: totalDischarge });
      }
    }

    // At least some slots should discharge above the throttled rate
    const unthrottled = highSocSlots.filter(s => s.discharge > 2001);
    expect(unthrottled.length).toBeGreaterThan(0);
  });

  it('dp binaries are not activated above threshold', async () => {
    const cfg = makeConfig();
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);

    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, {
      startMs: Date.now(),
      stepMin: cfg.stepSize_m,
    });

    // Check dp_0 binaries: should be 0 when SoC > 30%
    const dpBins = Object.entries(result.Columns || {}).filter(([k]) => k.startsWith('dp_0_'));
    const violations = [];
    for (const [name, col] of dpBins) {
      const t = Number(name.split('_')[2]);
      const active = Math.round(col?.Primal ?? 0) === 1;
      const startSocPercent = t === 0 ? cfg.initialSoc_percent : rows[t - 1].soc_percent;
      if (active && startSocPercent > 30.5) {
        violations.push({ slot: t, startSoc: startSocPercent.toFixed(1), dp_0: active });
      }
    }

    expect(violations).toEqual([]);
  });

  it('works with two discharge thresholds', async () => {
    const cfg = makeConfig({
      dischargePhaseThresholds: [
        { soc_percent: 40, maxDischargePower_W: 3000 },
        { soc_percent: 25, maxDischargePower_W: 1000 },
      ],
    });
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);

    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, {
      startMs: Date.now(),
      stepMin: cfg.stepSize_m,
    });

    for (let i = 1; i < rows.length; i++) {
      const prevSocPercent = rows[i - 1].soc_percent;
      const totalDischarge = rows[i].b2l + rows[i].b2g;

      if (prevSocPercent < 25) {
        expect(totalDischarge).toBeLessThanOrEqual(1000 + 1);
      } else if (prevSocPercent < 40) {
        expect(totalDischarge).toBeLessThanOrEqual(3000 + 1);
      }
    }
  });

  it('works alongside CV phase thresholds', async () => {
    const cfg = makeConfig({
      initialSoc_percent: 50,
      cvPhaseThresholds: [
        { soc_percent: 95, maxChargePower_W: 2000 },
      ],
      dischargePhaseThresholds: [
        { soc_percent: 30, maxDischargePower_W: 2000 },
      ],
    });
    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);

    expect(result.Status).toBe('Optimal');

    const rows = parseSolution(result, cfg, {
      startMs: Date.now(),
      stepMin: cfg.stepSize_m,
    });

    // Verify discharge thresholds are respected
    for (let i = 1; i < rows.length; i++) {
      const prevSocPercent = rows[i - 1].soc_percent;
      const totalDischarge = rows[i].b2l + rows[i].b2g;

      if (prevSocPercent < 30) {
        expect(totalDischarge).toBeLessThanOrEqual(2000 + 1);
      }
    }
  });
});
