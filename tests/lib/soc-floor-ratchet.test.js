import { describe, it, expect, beforeAll } from 'vitest';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
import highsFactory from '../../vendor/highs-build/highs.js';

// Inherited-deficit floor ratchet (issue #49): when the initial SoC starts
// below the minSoc floor (overnight idle drain, integer SoC quantization, a
// raised floor), the plan must NOT buy the deficit back immediately at the
// current price. The deficit rides on the no-intervention trajectory until
// solar or the cheapest charge window recovers it; after the first recovery
// the full floor applies again (no reusing the allowance later in the
// horizon).

describe('buildLP — SoC floor ratchet (structure)', () => {
  const T = 2;
  const base = {
    load_W: Array(T).fill(0),
    pv_W: Array(T).fill(0),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
    stepSize_m: 15,
    batteryCapacity_Wh: 10000,
    minSoc_percent: 10, // 1000 Wh
    maxSoc_percent: 100,
    idleDrain_W: 40, // 10 Wh per 15-min slot
  };

  it('emits the unchanged plain floor constraint when initial SoC is at/above the floor', () => {
    const lp = buildLP({ ...base, initialSoc_percent: 10 });
    expect(lp).not.toContain('floor_recovered');
    expect(lp).toMatch(/c_min_soc_0: soc_shortfall_0 \+ soc_0 >= 1000/);
  });

  it('emits ratchet constraints when initial SoC is below the floor', () => {
    // initial 5% = 500 Wh → inherited shortfall 500 Wh.
    // allowance_0 = 500 + 10 = 510 (one slot of idle drain), so the
    // pre-recovery floor is 1000 - 510 = 490 = the no-intervention SoC.
    const lp = buildLP({ ...base, initialSoc_percent: 5 });
    expect(lp).toMatch(/c_min_soc_0: soc_shortfall_0 \+ soc_0 - 510 floor_recovered_0 >= 490/);
    expect(lp).toMatch(/c_min_soc_1: soc_shortfall_1 \+ soc_1 - 520 floor_recovered_1 >= 480/);
    // Latch: M = maxSoc - minSoc = 9000; SoC above the floor forces the binary.
    expect(lp).toMatch(/c_floor_rec_0: soc_0 - 9000 floor_recovered_0 <= 1000/);
    // Monotone: recovery is permanent.
    expect(lp).toMatch(/c_floor_rec_mono_1: floor_recovered_1 - floor_recovered_0 >= 0/);
    // Binaries declared.
    expect(lp).toMatch(/Binaries[\s\S]*floor_recovered_0[\s\S]*floor_recovered_1/);
  });
});

describe('buildLP — SoC floor ratchet (solver behavior)', () => {
  let highs;

  beforeAll(async () => {
    highs = await highsFactory({});
  });

  // Aug 7 scenario shape: morning peak, cheap midday window, evening export
  // peak. Initial 5% sits 500 Wh below the 10% floor.
  const T = 12;
  const cfg = {
    load_W: Array(T).fill(0),
    pv_W: Array(T).fill(0),
    //             morning peak      cheap window     evening export peak
    importPrice: [50, 50, 50, 50, 10, 10, 10, 10, 45, 45, 45, 45],
    exportPrice: [45, 45, 45, 45, 5, 5, 5, 5, 40, 40, 40, 40],
    stepSize_m: 15,
    batteryCapacity_Wh: 10000,
    minSoc_percent: 10, // 1000 Wh
    maxSoc_percent: 100,
    maxChargePower_W: 5000,
    maxDischargePower_W: 5000,
    maxGridImport_W: 10000,
    maxGridExport_W: 10000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    inverterEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 1,
    idleDrain_W: 40, // 10 Wh per slot
    terminalSocValuation: 'zero',
    initialSoc_percent: 5, // 500 Wh — 500 Wh below the floor
  };

  it('rides the inherited deficit instead of buying it back at the morning peak', () => {
    const result = highs.solve(buildLP(cfg), { mip_rel_gap: 0, mip_abs_gap: 0 });
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    // No grid charging during the expensive morning slots (was ~2 kW in slot 0
    // before the fix), and no discharging either — the battery just idles.
    for (let t = 0; t < 4; t++) {
      expect(rows[t].g2b).toBeLessThan(1);
      expect(rows[t].b2g + rows[t].b2l).toBeLessThan(1);
    }
    // SoC follows the no-intervention trajectory: 500 - 10 Wh idle drain/slot.
    expect(rows[3].soc).toBeCloseTo(460, 0);

    // Recovery happens in the cheap window (the charge the plan makes for
    // arbitrage anyway absorbs the deficit).
    const cheapCharge = rows.slice(4, 8).reduce((s, r) => s + r.g2b, 0);
    expect(cheapCharge).toBeGreaterThan(100);
    expect(rows[7].soc).toBeGreaterThan(1000);
  });

  it('restores the full floor after recovery: the evening dump stops at minSoc, not at the inherited level', () => {
    const result = highs.solve(buildLP(cfg), { mip_rel_gap: 0, mip_abs_gap: 0 });
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    // Evening export drains the battery, but only down to the 1000 Wh floor —
    // NOT back down to the 500 Wh the morning started at (that would erode the
    // floor a little further every day).
    const eveningExport = rows.slice(8).reduce((s, r) => s + r.b2g, 0);
    expect(eveningExport).toBeGreaterThan(100);
    expect(rows[T - 1].soc).toBeGreaterThan(950);
  });

  it('does not deepen the inherited deficit even when an immediate export would be profitable', () => {
    // Export pays 50 in the morning while the refill window costs 5: without a
    // pre-recovery floor the solver would dump the remaining 500 Wh reserve
    // through the floor and re-buy it cheaply later.
    const cfg2 = {
      ...cfg,
      importPrice: [55, 55, 55, 55, 5, 5, 5, 5, 20, 20, 20, 20],
      exportPrice: [50, 50, 50, 50, 2, 2, 2, 2, 15, 15, 15, 15],
    };
    const result = highs.solve(buildLP(cfg2), { mip_rel_gap: 0, mip_abs_gap: 0 });
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg2, { startMs: 0, stepMin: 15 });
    for (let t = 0; t < 4; t++) {
      expect(rows[t].b2g + rows[t].b2l).toBeLessThan(1);
    }
  });

  it('stays feasible with discharge-phase thresholds while below the floor (big-M regression)', () => {
    // Before the fix the dp big-M was sized as threshold - minSoc, which made
    // the forward constraint unsatisfiable whenever SoC sat below the floor.
    const cfg3 = {
      ...cfg,
      dischargePhaseThresholds: [{ soc_percent: 30, maxDischargePower_W: 3000 }],
    };
    const result = highs.solve(buildLP(cfg3), { mip_rel_gap: 0, mip_abs_gap: 0 });
    expect(result.Status).toBe('Optimal');
  });
});
