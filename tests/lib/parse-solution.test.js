import { describe, it, expect } from 'vitest';
import { parseSolution } from '../../lib/parse-solution.ts';

describe('parseSolution', () => {
  const cfg = {
    load_W: [500, 600],
    pv_W: [100, 0],
    importPrice: [10, 20],
    exportPrice: [5, 5],
    batteryCapacity_Wh: 1000,
  };

  const opts = {
    startMs: 1700000000000,
    stepMin: 60,
  };

  it('correctly parses HiGHS columns into rows', () => {
    const result = {
      Columns: {
        'grid_to_load_0': { Primal: 400 },
        'pv_to_load_0': { Primal: 100 },
        'grid_to_load_1': { Primal: 600 },
        'soc_0': { Primal: 200 },
        'soc_1': { Primal: 200 },
      },
    };

    const rows = parseSolution(result, cfg, opts);

    expect(rows).toHaveLength(2);
    expect(rows[0].g2l).toBe(400);
    expect(rows[0].pv2l).toBe(100);
    expect(rows[1].g2l).toBe(600);
    expect(rows[0].soc).toBe(200);
    expect(rows[0].soc_percent).toBe(20);
    expect(rows[0].timestampMs).toBe(1700000000000);
    expect(rows[1].timestampMs).toBe(1700000000000 + 3600000);
  });

  it('handles null/missing Columns gracefully (line 36: Columns ?? {})', () => {
    // Line 36: `Object.entries(result.Columns ?? {})` — null Columns → empty entries
    const result = { Columns: null };
    const rows = parseSolution(result, cfg, opts);
    expect(rows).toHaveLength(2);
    // All flows should be 0
    expect(rows[0].g2l).toBe(0);
    expect(rows[0].soc).toBe(0);
  });

  it('skips columns with out-of-range index (line 40: t < 0 || t >= T)', () => {
    // Line 40: `if (t == null || t < 0 || t >= T) continue`
    const result = {
      Columns: {
        'grid_to_load_99': { Primal: 999 }, // t=99 >= T=2 → skipped
        'grid_to_load_0': { Primal: 200 },
      },
    };
    const rows = parseSolution(result, cfg, opts);
    expect(rows[0].g2l).toBe(200);
    // t=99 was skipped, so no rows[99]
    expect(rows).toHaveLength(2);
  });

  it('uses 0 when Primal is undefined (line 91: Primal ?? 0)', () => {
    // Line 91 (valueOf): `col.Primal ?? 0`
    const result = {
      Columns: {
        'grid_to_load_0': {}, // no Primal field
      },
    };
    const rows = parseSolution(result, cfg, opts);
    expect(rows[0].g2l).toBe(0);
  });

  it('includes evLoad in PlanRow from cfg.evLoad_W', () => {
    const cfgWithEv = {
      load_W: [100, 100, 100, 100],
      pv_W: [0, 0, 0, 0],
      importPrice: [10, 10, 10, 10],
      exportPrice: [5, 5, 5, 5],
      batteryCapacity_Wh: 1000,
      evLoad_W: [0, 500, 11000, 0],
    };

    const result = {
      Columns: {
        'soc_0': { Primal: 500 },
        'soc_1': { Primal: 500 },
        'soc_2': { Primal: 500 },
        'soc_3': { Primal: 500 },
      },
    };

    const rows = parseSolution(result, cfgWithEv, { startMs: 1700000000000, stepMin: 15 });

    expect(rows).toHaveLength(4);
    expect(rows[0].evLoad).toBe(0);
    expect(rows[1].evLoad).toBe(500);
    expect(rows[2].evLoad).toBe(11000);
    expect(rows[3].evLoad).toBe(0);
  });

});
