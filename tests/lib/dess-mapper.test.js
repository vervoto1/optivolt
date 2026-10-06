import { describe, it, expect } from 'vitest';
import { mapRowsToDessV2, effectiveChargeCap_W, Strategy, Restrictions, FeedIn } from '../../lib/dess-mapper.ts';

describe('mapRowsToDessV2 — flags field', () => {
  const cfg = {
    maxGridImport_W: 5000,
    maxSoc_percent: 100,
    minSoc_percent: 0,
    maxChargePower_W: 4000,
    maxDischargePower_W: 4000,
  };

  it('includes flags: 0 on each perSlot entry', () => {
    const rows = [{
      g2l: 0, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
      soc: 500, soc_percent: 50,
      load: 500, pv: 0, ev_charge: 0,
      ic: 10, ec: 5,
    }];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[0]).toHaveProperty('flags', 0);
  });
});

describe('mapRowsToDessV2 — empty rows diagnostics', () => {
  const cfg = {
    maxGridImport_W: 5000,
    maxSoc_percent: 100,
    minSoc_percent: 0,
    maxDischargePower_W: 4000,
  };

  it('returns -Infinity gridChargeTippingPoint when rows is empty', () => {
    const { diagnostics } = mapRowsToDessV2([], cfg);
    expect(diagnostics.gridChargeTippingPoint_cents_per_kWh).toBe(-Infinity);
  });

  it('returns Infinity batteryExportTippingPoint when rows is empty', () => {
    const { diagnostics } = mapRowsToDessV2([], cfg);
    expect(diagnostics.batteryExportTippingPoint_cents_per_kWh).toBe(Infinity);
  });

  it('returns empty perSlot array when rows is empty', () => {
    const { perSlot } = mapRowsToDessV2([], cfg);
    expect(perSlot).toHaveLength(0);
  });
});

describe('Tipping Point Calculations', () => {
  // Minimal mock of the config
  const mockCfg = {
    stepSize_m: 15,
    minSoc_percent: 10,
    maxSoc_percent: 90,
    maxChargePower_W: 1000,
    maxDischargePower_W: 1000,
    maxGridImport_W: 5000,
    maxGridExport_W: 5000,
  };

  // Helper to create a row with specific values
  function createRow(overrides = {}) {
    return {
      soc_percent: 50,
      g2b: 0, b2g: 0, ic: 0, ec: 0,
      g2l: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0,
      load: 0, pv: 0, soc: 0,
      ...overrides,
    };
  }

  it('should calculate Grid Charge Tipping Point correctly', () => {
    const rows = [
      createRow({ soc_percent: 50, g2b: 100, ic: 10 }), // Charge at 10c
      createRow({ soc_percent: 50, g2b: 100, ic: 15 }), // Charge at 15c
      createRow({ soc_percent: 50, g2b: 0, ic: 20 }), // No charge at 20c
      createRow({ soc_percent: 50, g2b: 100, ic: 12 }), // Charge at 12c
    ];

    const result = mapRowsToDessV2(rows, mockCfg);
    // The highest price at which we charged was 15c
    expect(result.diagnostics.gridChargeTippingPoint_cents_per_kWh).toBe(15);
  });

  it('should return -Infinity for Grid Charge Tipping Point if no charging occurs', () => {
    const rows = [
      createRow({ soc_percent: 50, g2b: 0, ic: 10 }),
      createRow({ soc_percent: 50, g2b: 0, ic: 15 }),
    ];

    const result = mapRowsToDessV2(rows, mockCfg);
    expect(result.diagnostics.gridChargeTippingPoint_cents_per_kWh).toBe(-Infinity);
  });

  it('should calculate Battery Export Tipping Point correctly', () => {
    const rows = [
      createRow({ soc_percent: 50, b2g: 100, ec: 30 }), // Export at 30c
      createRow({ soc_percent: 50, b2g: 100, ec: 20 }), // Export at 20c
      createRow({ soc_percent: 50, b2g: 0, ec: 10 }), // No export at 10c
      createRow({ soc_percent: 50, b2g: 100, ec: 25 }), // Export at 25c
    ];

    const result = mapRowsToDessV2(rows, mockCfg);
    // The lowest price at which we exported was 20c
    expect(result.diagnostics.batteryExportTippingPoint_cents_per_kWh).toBe(20);
  });

  it('should return Infinity for Battery Export Tipping Point if no exporting occurs', () => {
    const rows = [
      createRow({ soc_percent: 50, b2g: 0, ec: 30 }),
      createRow({ soc_percent: 50, b2g: 0, ec: 20 }),
    ];

    const result = mapRowsToDessV2(rows, mockCfg);
    expect(result.diagnostics.batteryExportTippingPoint_cents_per_kWh).toBe(Infinity);
  });

  it('should ignore small flows (epsilon)', () => {
    const rows = [
      // g2b=0.5 is <= FLOW_EPSILON_W (1), should be ignored
      createRow({ soc_percent: 50, g2b: 0.5, ic: 100 }),
      createRow({ soc_percent: 50, g2b: 100, ic: 10 }),
    ];

    const result = mapRowsToDessV2(rows, mockCfg);
    expect(result.diagnostics.gridChargeTippingPoint_cents_per_kWh).toBe(10);
  });

  it('should only search within the first SoC segment', () => {
    // If the planner reaches min/max SoC, it starts a new segment.
    // We only care about the immediate future (first segment).

    const rows = [
      createRow({ soc_percent: 50, g2b: 100, ic: 10 }), // Segment 1
      createRow({ soc_percent: 10, g2b: 100, ic: 10 }), // Boundary (minSoc) -> Start Segment 2 next?
      // Actually dess-mapper logic: if isAtSocBoundary, current index ends segment.
      // So index 1 is end of segment 1.

      createRow({ soc_percent: 50, g2b: 100, ic: 99 }), // Segment 2
    ];

    // Note: mockCfg.minSoc_percent = 10. `isAtSocBoundary` checks <= min + epsilon.
    // So row 1 (10%) triggers boundary.
    // Segment 1 is index 0..1.
    // Segment 2 is index 2..2.

    // We expect it to find 10c from segment 1, NOT 99c from segment 2.
    const result = mapRowsToDessV2(rows, mockCfg);
    expect(result.diagnostics.gridChargeTippingPoint_cents_per_kWh).toBe(10);
  });

  it('should calculate Grid Battery Tipping Point (grid->load) correctly', () => {
    const rows = [
      createRow({ soc_percent: 50, g2l: 100, ic: 40 }), // Grid usage at 40c
      createRow({ soc_percent: 50, g2l: 100, ic: 30 }), // Grid usage at 30c
      createRow({ soc_percent: 50, g2l: 0, ic: 50 }),   // No usage at 50c
    ];

    const result = mapRowsToDessV2(rows, mockCfg);
    // Highest price used was 40c
    expect(result.diagnostics.gridBatteryTippingPoint_cents_per_kWh).toBe(40);
  });

  it('should return -Infinity for Grid Battery Tipping Point if no grid usage occurs', () => {
    const rows = [
      createRow({ soc_percent: 50, g2l: 0, ic: 40 }),
      createRow({ soc_percent: 50, g2l: 0, ic: 30 }),
    ];

    const result = mapRowsToDessV2(rows, mockCfg);
    expect(result.diagnostics.gridBatteryTippingPoint_cents_per_kWh).toBe(-Infinity);
  });
});

describe('mapRowsToDessV2', () => {
  const cfg = {
    stepSize_m: 15,
    batteryCapacity_Wh: 20480,
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxChargePower_W: 3600,
    maxDischargePower_W: 4000,
    maxGridImport_W: 5000,
    maxGridExport_W: 5000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 2,
  };

  // Helper to create rows with specific tipping points established
  // A grid charge at price X sets gridChargeTp = X
  // A grid-to-load at price Y sets gridBatteryTp = Y
  // A battery export at price Z sets batteryExportTp = Z
  function makeRow(overrides = {}) {
    return {
      g2l: 0, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
      soc: 500, soc_percent: 50,
      load: 0, pv: 0, ev_charge: 0,
      ic: 20, ec: 5,
      ...overrides,
    };
  }

  it('charges from grid when importCost <= gridChargeTp', () => {
    // Row 0: establish gridChargeTp = 15 (g2b flow at price 15)
    // Row 1: test slot with ic = 10 (<= 15) should charge
    const rows = [
      makeRow({ g2b: 100, ic: 15 }),
      makeRow({ ic: 10, ec: 5 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[1].strategy).toBe(Strategy.proBattery);
    expect(perSlot[1].restrictions).toBe(Restrictions.batteryToGrid);
  });

  it('applies +5% SoC boost when charging and grid import is saturated', () => {
    const rows = [
      makeRow({ g2b: 100, ic: 15, soc_percent: 50 }),
      makeRow({ ic: 10, ec: 5, soc_percent: 50, g2l: 1000, g2b: 4000 }), // g2l+g2b = 5000 = maxGridImport
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[1].socTarget_percent).toBe(55); // 50 + 5
  });

  it('does NOT boost SoC when charging but grid import is not saturated', () => {
    const rows = [
      makeRow({ g2b: 100, ic: 15, soc_percent: 50 }),
      makeRow({ ic: 10, ec: 5, soc_percent: 50, g2l: 500, g2b: 1000 }), // g2l+g2b = 1500 < 5000
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[1].socTarget_percent).toBe(50); // no boost
  });

  it('caps SoC boost at CV phase threshold', () => {
    const rows = [
      makeRow({ g2b: 100, ic: 15, soc_percent: 93 }),
      makeRow({ ic: 10, ec: 5, soc_percent: 93, g2l: 1000, g2b: 4000 }), // saturated
    ];
    const cvCfg = {
      ...cfg,
      maxSoc_percent: 100,
      cvPhaseThresholds: [{ soc_percent: 95, maxChargePower_W: 9360 }],
    };
    const { perSlot } = mapRowsToDessV2(rows, cvCfg);
    expect(perSlot[1].socTarget_percent).toBe(95); // 93+5=98 capped to CV threshold 95
  });

  it('caps SoC boost at maxSoc_percent - 1 when no CV phase', () => {
    const rows = [
      makeRow({ g2b: 100, ic: 15, soc_percent: 97 }),
      makeRow({ ic: 10, ec: 5, soc_percent: 97, g2l: 1000, g2b: 4000 }), // saturated
    ];
    const { perSlot } = mapRowsToDessV2(rows, { ...cfg, maxSoc_percent: 100 });
    expect(perSlot[1].socTarget_percent).toBe(99); // 97+5=102 capped to 100-1=99
  });

  it('uses grid for load when gridChargeTp < importCost <= gridBatteryTp', () => {
    // gridChargeTp = 10 (from g2b), gridBatteryTp = 25 (from g2l)
    // Test slot ic = 20 (> 10 but <= 25)
    const rows = [
      makeRow({ g2b: 100, ic: 10 }),
      makeRow({ g2l: 100, ic: 25, b2l: 0 }),
      makeRow({ ic: 20, ec: 5 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[2].strategy).toBe(Strategy.proBattery);
    expect(perSlot[2].restrictions).toBe(Restrictions.batteryToGrid);
  });

  it('exports when exportPrice >= batteryExportTp', () => {
    // batteryExportTp = 20 (from b2g flow at price 20)
    // Test slot ec = 25 (>= 20) should export
    const rows = [
      makeRow({ b2g: 100, ec: 20, ic: 100 }),
      makeRow({ ic: 100, ec: 25 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[1].strategy).toBe(Strategy.proGrid);
    expect(perSlot[1].restrictions).toBe(Restrictions.gridToBattery);
  });

  it('targets the END SoC of a contiguous high-price export run', () => {
    // Slots 0..2 all export (b2g>0) at a non-rising price while SoC falls
    // 30→20→10. Every slot should target the run's END SoC (10) so DESS dumps at
    // max immediately instead of stair-stepping down the per-slot trajectory.
    const rows = [
      makeRow({ b2g: 4000, ec: 25, ic: 100, soc_percent: 30 }),
      makeRow({ b2g: 4000, ec: 25, ic: 100, soc_percent: 20 }),
      makeRow({ b2g: 4000, ec: 22, ic: 100, soc_percent: 10 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[0].strategy).toBe(Strategy.proGrid);
    expect(perSlot[0].socTarget_percent).toBe(10);
    expect(perSlot[1].socTarget_percent).toBe(10);
    expect(perSlot[2].socTarget_percent).toBe(10);
  });

  it('a lone export slot keeps its own planned SoC', () => {
    const rows = [
      makeRow({ b2g: 100, ec: 20, ic: 100, soc_percent: 50 }),
      makeRow({ ic: 100, ec: 25, soc_percent: 50, b2g: 500 }), // last slot, run = {itself}
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[1].strategy).toBe(Strategy.proGrid);
    expect(perSlot[1].socTarget_percent).toBe(50);
  });

  it('does not front-load the export run across a higher future price', () => {
    // Slot 1 has a HIGHER export price than slot 0, so slot 0 must NOT be pulled
    // down to slot 1's SoC — that energy is worth more sold in slot 1. Slot 0
    // keeps its own end SoC (30); slot 1 keeps its own (20).
    const rows = [
      makeRow({ b2g: 4000, ec: 25, ic: 100, soc_percent: 30 }),
      makeRow({ b2g: 4000, ec: 40, ic: 100, soc_percent: 20 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[0].strategy).toBe(Strategy.proGrid);
    expect(perSlot[0].socTarget_percent).toBe(30);
    expect(perSlot[1].socTarget_percent).toBe(20);
  });

  it('defaults to selfConsumption when no tipping points match', () => {
    // No g2b, g2l, or b2g flows -> all tipping points at sentinel values
    // importCost > -Infinity but there are no flows so all tps are sentinel
    const rows = [
      makeRow({ ic: 20, ec: 5 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[0].strategy).toBe(Strategy.selfConsumption);
    expect(perSlot[0].restrictions).toBe(Restrictions.none);
  });

  it('triggers proGrid with gridToBattery restrictions when exportPrice >= pvExportTp and PV surplus', () => {
    // Row 0: establish pvExportTp = 15 (pv2g flow at ec 15)
    // Row 1: test slot with ec = 20 (>= 15) AND pv > load should trigger PV export branch
    const rows = [
      makeRow({ pv2g: 500, ec: 15, ic: 100 }),
      makeRow({ ic: 100, ec: 20, pv: 1000, load: 200 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[1].strategy).toBe(Strategy.proGrid);
    expect(perSlot[1].restrictions).toBe(Restrictions.gridToBattery);
  });

  it('does NOT trigger pvExportTp when exportPrice < pvExportTp', () => {
    // Row 0: establish pvExportTp = 25 (pv2g flow at ec 25)
    // Row 1: test slot with ec = 10 (< 25) should fall through to selfConsumption
    const rows = [
      makeRow({ pv2g: 500, ec: 25, ic: 100 }),
      makeRow({ ic: 100, ec: 10, pv: 1000, load: 200 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[1].strategy).toBe(Strategy.selfConsumption);
    expect(perSlot[1].restrictions).toBe(Restrictions.none);
  });

  it('does NOT trigger pvExportTp in deficit slots (load > PV)', () => {
    // Row 0: establish pvExportTp = 5 (low forced export)
    // Row 1: deficit slot (load > pv) with ec = 20 (>= 5) should NOT match pvExportTp
    const rows = [
      makeRow({ pv2g: 500, ec: 5, ic: 100 }),
      makeRow({ ic: 100, ec: 20, pv: 200, load: 1000 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[1].strategy).toBe(Strategy.selfConsumption);
    expect(perSlot[1].restrictions).toBe(Restrictions.none);
  });

  it('batteryExportTp takes precedence over pvExportTp', () => {
    // Both b2g (at ec=20) and pv2g (at ec=10) establish tipping points
    // batteryExportTp=20, pvExportTp=10
    // Test slot ec=22 (>= both) should match batteryExportTp first -> allow battery->grid
    const rows = [
      makeRow({ b2g: 100, ec: 20, ic: 100 }),
      makeRow({ pv2g: 500, ec: 10, ic: 100 }),
      makeRow({ ic: 100, ec: 22 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[2].strategy).toBe(Strategy.proGrid);
    expect(perSlot[2].restrictions).toBe(Restrictions.gridToBattery); // battery export branch, not PV export
  });

  it('blocks feed-in when export price is negative', () => {
    const rows = [makeRow({ ec: -1 })];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[0].feedin).toBe(FeedIn.blocked);
    expect(perSlot[0].restrictions).toBe(Restrictions.batteryToGrid);
  });

  it('allows feed-in at negative export prices when blocking is disabled', () => {
    const rows = [makeRow({ ec: -1 })];
    const { perSlot } = mapRowsToDessV2(rows, cfg, { blockFeedInOnNegativePrices: false });
    expect(perSlot[0].feedin).toBe(FeedIn.allowed);
  });

  it('allows feed-in when export price is positive', () => {
    const rows = [makeRow({ ec: 5 })];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    expect(perSlot[0].feedin).toBe(FeedIn.allowed);
  });

  it('uses per-segment tipping points', () => {
    // Segment 1: rows 0-1 (row 1 at minSoc boundary creates break)
    //   g2b at price 10 -> gridChargeTp = 10
    // Segment 2: row 2
    //   g2b at price 50 -> gridChargeTp = 50
    //   test row 3: ic = 30 (<= 50 in segment 2, but > 10 in segment 1)
    const rows = [
      makeRow({ g2b: 100, ic: 10, soc_percent: 50 }),
      makeRow({ soc_percent: 10, ic: 40 }), // at min boundary
      makeRow({ g2b: 100, ic: 50, soc_percent: 50 }),
      makeRow({ ic: 30, soc_percent: 50 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, cfg);
    // Row 3 is in segment 2 with gridChargeTp=50, ic=30 <= 50 -> charge
    expect(perSlot[3].strategy).toBe(Strategy.proBattery);
    expect(perSlot[3].restrictions).toBe(Restrictions.batteryToGrid);
  });

  it('returns diagnostics including pvExportTippingPoint', () => {
    const rows = [
      makeRow({ g2b: 100, g2l: 200, b2g: 50, pv2g: 300, ic: 15, ec: 25 }),
    ];
    const v2Result = mapRowsToDessV2(rows, cfg);
    expect(v2Result.diagnostics).toHaveProperty('pvExportTippingPoint_cents_per_kWh');
    expect(v2Result.diagnostics.pvExportTippingPoint_cents_per_kWh).toBe(25);
  });

  it('does not use negative-price battery export as an export tipping point', () => {
    const rows = [
      makeRow({ b2g: 100, ec: -20, ic: 100 }),
      makeRow({ ec: -10, ic: 100 }),
    ];
    const result = mapRowsToDessV2(rows, cfg);

    expect(result.diagnostics.batteryExportTippingPoint_cents_per_kWh).toBe(Infinity);
    expect(result.perSlot[1].feedin).toBe(FeedIn.blocked);
    expect(result.perSlot[1].strategy).toBe(Strategy.selfConsumption);
    expect(result.perSlot[1].restrictions).toBe(Restrictions.batteryToGrid);
  });

  it('does not use negative-price PV export as a PV export tipping point', () => {
    const rows = [
      makeRow({ pv2g: 500, ec: -5, ic: 100 }),
      makeRow({ pv: 1000, load: 200, ec: -1, ic: 100 }),
    ];
    const result = mapRowsToDessV2(rows, cfg);

    expect(result.diagnostics.pvExportTippingPoint_cents_per_kWh).toBe(Infinity);
    expect(result.perSlot[1].feedin).toBe(FeedIn.blocked);
    expect(result.perSlot[1].strategy).toBe(Strategy.selfConsumption);
    expect(result.perSlot[1].restrictions).toBe(Restrictions.batteryToGrid);
  });

  describe('EV load inflation of g2l does not affect strategy or restrictions', () => {
    // When an EV is charging, its load is added to g2l (grid-to-load).
    // The DESS mapper should not misinterpret an inflated g2l as a signal to
    // change battery strategy — only g2b (grid-to-battery) and b2g flows drive
    // strategy and restrictions. The g2l magnitude affects the gridBatteryTp
    // tipping-point condition only insofar as it controls whether the slot counts
    // as a "grid usage" slot (g2l > FLOW_EPSILON_W), which is true for both base
    // and EV cases when any grid-to-load flow is present.

    // Shared battery/PV flows and prices for all slots (no g2b, no b2g).
    // Slots cycle through four different price/flow combos to exercise multiple branches.
    const sharedSlots = [
      // Slot 0: grid covers deficit, moderate price
      { g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0, soc: 5000, soc_percent: 50, load: 500, pv: 0, ic: 20, ec: 5 },
      // Slot 1: battery covers deficit, high price
      { g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 500, b2g: 0, soc: 4500, soc_percent: 44, load: 500, pv: 0, ic: 40, ec: 5 },
      // Slot 2: PV covers load, surplus to battery, low price
      { g2b: 0, pv2l: 500, pv2b: 1000, pv2g: 0, b2l: 0, b2g: 0, soc: 5500, soc_percent: 54, load: 500, pv: 1500, ic: 10, ec: 5 },
      // Slot 3: selfConsumption default (no flows, no tipping-point match)
      { g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0, soc: 5500, soc_percent: 54, load: 0, pv: 0, ic: 30, ec: 5 },
    ];

    // Set A: base load — g2l = 500 where grid covers load (slot 0 only)
    const baseLoadRows = sharedSlots.map((slot, i) => makeRow({
      ...slot,
      g2l: i === 0 ? 500 : 0,
    }));

    // Set B: EV load — g2l = 11500 where grid covers load+EV (slot 0 only)
    // evLoad = 11000 added on top of the 500 W base load
    const evLoadRows = sharedSlots.map((slot, i) => makeRow({
      ...slot,
      g2l: i === 0 ? 11500 : 0,
      // load field reflects only household load (EV load tracked separately);
      // g2l reflects total grid draw including EV
    }));

    it('produces identical per-slot strategies for base-load and EV-load rows', () => {
      // NOTE: if this test fails it means the DESS mapper is sensitive to the
      // magnitude of g2l, which would indicate a bug where EV load inflation
      // causes incorrect strategy selection.
      // TODO: if this test fails, investigate whether the gridImport saturation
      // check (g2l + g2b >= maxGridImport_W) inside the gridChargeTp branch
      // incorrectly fires when g2l is inflated by EV load.
      const { perSlot: baseSlots } = mapRowsToDessV2(baseLoadRows, cfg);
      const { perSlot: evSlots } = mapRowsToDessV2(evLoadRows, cfg);

      for (let i = 0; i < baseSlots.length; i++) {
        expect(evSlots[i].strategy, `slot ${i} strategy`).toBe(baseSlots[i].strategy);
        expect(evSlots[i].restrictions, `slot ${i} restrictions`).toBe(baseSlots[i].restrictions);
      }
    });

    it('produces identical feedin decisions for base-load and EV-load rows', () => {
      const { perSlot: baseSlots } = mapRowsToDessV2(baseLoadRows, cfg);
      const { perSlot: evSlots } = mapRowsToDessV2(evLoadRows, cfg);

      for (let i = 0; i < baseSlots.length; i++) {
        expect(evSlots[i].feedin, `slot ${i} feedin`).toBe(baseSlots[i].feedin);
      }
    });
  });

  describe('auto-generated thresholds', () => {
    function makeRow(overrides = {}) {
      return {
        g2l: 0, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
        soc: 500, soc_percent: 50,
        load: 0, pv: 0,
        ic: 20, ec: 5,
        ...overrides,
      };
    }

    it('caps SoC boost at auto-generated CV threshold (e.g. 85%)', () => {
      const rows = [
        makeRow({ g2b: 100, ic: 15, soc_percent: 82 }),
        makeRow({ ic: 10, ec: 5, soc_percent: 82, g2l: 1000, g2b: 4000 }), // saturated
      ];
      const autoCfg = {
        ...cfg,
        maxSoc_percent: 100,
        cvPhaseThresholds: [
          { soc_percent: 85, maxChargePower_W: 2000 },
          { soc_percent: 92, maxChargePower_W: 1000 },
        ],
      };
      const { perSlot } = mapRowsToDessV2(rows, autoCfg);
      // 82+5=87 capped to first applicable CV threshold 85
      expect(perSlot[1].socTarget_percent).toBe(85);
    });

    it('skips low CV thresholds below current SoC and uses first applicable', () => {
      const rows = [
        makeRow({ g2b: 100, ic: 15, soc_percent: 88 }),
        makeRow({ ic: 10, ec: 5, soc_percent: 88, g2l: 1000, g2b: 4000 }), // saturated
      ];
      const autoCfg = {
        ...cfg,
        maxSoc_percent: 100,
        cvPhaseThresholds: [
          { soc_percent: 40, maxChargePower_W: 3000 },  // below current SoC, skipped
          { soc_percent: 85, maxChargePower_W: 2000 },  // below current SoC, skipped
          { soc_percent: 92, maxChargePower_W: 1000 },  // first applicable
        ],
      };
      const { perSlot } = mapRowsToDessV2(rows, autoCfg);
      // 88+5=93 capped to first applicable CV threshold 92
      expect(perSlot[1].socTarget_percent).toBe(92);
    });

    it('falls back to maxSoc_percent when all CV thresholds are below current SoC', () => {
      const rows = [
        makeRow({ g2b: 100, ic: 15, soc_percent: 93 }),
        makeRow({ ic: 10, ec: 5, soc_percent: 93, g2l: 1000, g2b: 4000 }), // saturated
      ];
      const autoCfg = {
        ...cfg,
        maxSoc_percent: 100,
        cvPhaseThresholds: [
          { soc_percent: 40, maxChargePower_W: 3000 },
          { soc_percent: 85, maxChargePower_W: 2000 },
        ],
      };
      const { perSlot } = mapRowsToDessV2(rows, autoCfg);
      // 93+5=98, no applicable CV cap, capped at maxSoc-1=99 → 98
      expect(perSlot[1].socTarget_percent).toBe(98);
    });

    it('maps correctly when dischargePhaseThresholds is present in config', () => {
      // dischargePhaseThresholds should be ignored by the DESS mapper — it only
      // affects the LP. Verify the mapper doesn't break when the field is set.
      const rows = [
        makeRow({ g2b: 100, ic: 15, soc_percent: 50 }),
        makeRow({ ic: 10, ec: 5, soc_percent: 50 }),
      ];
      const dpCfg = {
        ...cfg,
        dischargePhaseThresholds: [
          { soc_percent: 30, maxDischargePower_W: 2000 },
          { soc_percent: 20, maxDischargePower_W: 1000 },
        ],
      };
      const { perSlot } = mapRowsToDessV2(rows, dpCfg);
      expect(perSlot[1].strategy).toBe(Strategy.proBattery);
      expect(perSlot[1].restrictions).toBe(Restrictions.batteryToGrid);
    });
  });

  // v0.7.23 regression: dess-mapper's AC→DC saturation checks defaulted
  // η_inv to 100% when cfg.inverterEfficiency_percent was omitted, while
  // buildLP / parseSolution default to 95%, so the DESS tipping-point
  // helpers over-counted high-price grid usage. (The export-branch socTarget
  // boost that originally tripped this was removed when the discharge taper /
  // run-terminal targeting landed; the same η-default still governs
  // findHighestGridUsageCost, so the guard moved there.) The shared
  // DEFAULT_INVERTER_EFFICIENCY_PERCENT constant in build-lp.ts pins all
  // three modules to the same default; this test fails on `?? 100` and
  // passes on `?? DEFAULT_INVERTER_EFFICIENCY_PERCENT`.
  describe('inverter efficiency default (saturation check)', () => {
    it('pins η default in the gridBatteryTp DC-saturation check', () => {
      // Slot 1 is a grid-to-load slot whose battery discharge sits exactly at the
      // DC cap under the correct η=95 default (3800 / 0.95 = 4000 W DC). It must
      // be treated as SATURATED and excluded from gridBatteryTp; otherwise its
      // ic=100 lifts the tipping point and (mis)classifies slot 2 as proBattery
      // instead of exporting. With the legacy η=100 default (3800 < 4000) the
      // slot leaks in and slot 2 flips to proBattery.
      const rows = [
        makeRow({ b2g: 100, ec: 20, ic: 5, soc_percent: 50 }),               // batteryExportTp = 20
        makeRow({ g2l: 1000, b2l: 3800, ic: 100, ec: 5, soc_percent: 50 }),  // DC-saturated under η=95
        makeRow({ ic: 50, ec: 25, soc_percent: 50 }),                        // test slot
      ];
      // cfg deliberately omits inverterEfficiency_percent.
      const { perSlot } = mapRowsToDessV2(rows, cfg);
      expect(perSlot[2].strategy).toBe(Strategy.proGrid);
    });

    it('matches the explicit η=95 path when the field is omitted', () => {
      const rows = [
        makeRow({ b2g: 100, ec: 20, ic: 5, soc_percent: 50 }),
        makeRow({ g2l: 1000, b2l: 3800, ic: 100, ec: 5, soc_percent: 50 }),
        makeRow({ ic: 50, ec: 25, soc_percent: 50 }),
      ];
      const omitted = mapRowsToDessV2(rows, cfg).perSlot[2];
      const explicit = mapRowsToDessV2(rows, { ...cfg, inverterEfficiency_percent: 95 }).perSlot[2];
      expect(omitted.strategy).toBe(explicit.strategy);
    });

    it('treats every grid-to-load slot as unsaturated when η is 0 (no division by zero)', () => {
      // η=0 short-circuits the AC→DC conversion to 0 W, so the slot-1 price
      // counts toward gridBatteryTp and slot 2 (ic 50 <= 100) uses the grid.
      const rows = [
        makeRow({ b2g: 100, ec: 20, ic: 5, soc_percent: 50 }),
        makeRow({ g2l: 1000, b2l: 3800, ic: 100, ec: 5, soc_percent: 50 }),
        makeRow({ ic: 50, ec: 25, soc_percent: 50 }),
      ];
      const { perSlot, diagnostics } = mapRowsToDessV2(rows, { ...cfg, inverterEfficiency_percent: 0 });
      expect(diagnostics.gridBatteryTippingPoint_cents_per_kWh).toBe(100);
      expect(perSlot[2].strategy).toBe(Strategy.proBattery);
    });
  });
});

describe('effectiveChargeCap_W', () => {
  const cfg = {
    maxChargePower_W: 3600,
    cvPhaseThresholds: [
      { soc_percent: 60, maxChargePower_W: 2000 },
      { soc_percent: 80, maxChargePower_W: 1000 },
    ],
  };

  it('is the flat cap without thresholds', () => {
    expect(effectiveChargeCap_W({ maxChargePower_W: 3600 }, 95)).toBe(3600);
  });

  it('steps down at each threshold the start SoC has reached (inclusive), like c_charge_cap_t', () => {
    expect(effectiveChargeCap_W(cfg, 59.9)).toBe(3600);
    expect(effectiveChargeCap_W(cfg, 60)).toBe(2000);
    expect(effectiveChargeCap_W(cfg, 79.99)).toBe(2000);
    expect(effectiveChargeCap_W(cfg, 80)).toBe(1000);
    expect(effectiveChargeCap_W(cfg, 99)).toBe(1000);
  });

  it('mirrors the LP for unsorted thresholds (decremental steps in given order)', () => {
    // build-lp does not sort cvPhaseThresholds: step_k = p_(k-1) - p_k in list order.
    const unsorted = { maxChargePower_W: 3600, cvPhaseThresholds: [cfg.cvPhaseThresholds[1], cfg.cvPhaseThresholds[0]] };
    // Only the 60% threshold on: 3600 - (1000 - 2000) = 4600, as the LP would allow.
    expect(effectiveChargeCap_W(unsorted, 70)).toBe(4600);
    expect(effectiveChargeCap_W(unsorted, 85)).toBe(2000);
  });
});

describe('mapRowsToDessV2 — saturation against the CV/charge taper', () => {
  const cfg = {
    stepSize_m: 15,
    batteryCapacity_Wh: 20480,
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxChargePower_W: 3600,
    maxDischargePower_W: 4000,
    maxGridImport_W: 5000,
    maxGridExport_W: 5000,
    inverterEfficiency_percent: 100,
    initialSoc_percent: 65,
  };
  const taperCfg = {
    ...cfg,
    cvPhaseThresholds: [
      { soc_percent: 60, maxChargePower_W: 2000 },
      { soc_percent: 80, maxChargePower_W: 1000 },
    ],
  };

  function makeRow(overrides = {}) {
    return {
      g2l: 0, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
      soc: 500, soc_percent: 50,
      load: 0, pv: 0, ev_charge: 0,
      ic: 20, ec: 5,
      ...overrides,
    };
  }

  // Row 0 sets gridChargeTp = 15 so row 1 (ic 10) takes the grid-charge branch.
  const tpRow = (soc_percent) => makeRow({ g2b: 100, ic: 15, soc_percent });

  it('boosts a slot charging at the taper cap in force at its start SoC', () => {
    const rows = [
      tpRow(65),
      makeRow({ ic: 10, g2b: 2000, soc_percent: 69.7 }), // starts at 65% → cap 2000 W, saturated
    ];
    const { perSlot } = mapRowsToDessV2(rows, taperCfg);
    expect(perSlot[1].socTarget_percent).toBeCloseTo(74.7, 6); // 69.7 + 5, below the 80% CV cap
  });

  it('still caps the boost at the next CV threshold', () => {
    const rows = [
      tpRow(76),
      makeRow({ ic: 10, g2b: 2000, soc_percent: 79.7 }),
    ];
    const { perSlot } = mapRowsToDessV2(rows, taperCfg);
    expect(perSlot[1].socTarget_percent).toBe(80); // 84.7 capped by cvCap 80
  });

  it('uses cfg.initialSoc_percent as the first slot start SoC', () => {
    // No tipping-point row: the only grid charge sets gridChargeTp = its own price.
    const rows = [makeRow({ ic: 10, g2b: 2000, soc_percent: 69.7 })];
    const { perSlot } = mapRowsToDessV2(rows, taperCfg);
    expect(perSlot[0].socTarget_percent).toBeCloseTo(74.7, 6);
  });

  it('does not boost a tapered slot charging below its cap', () => {
    const rows = [
      tpRow(65),
      makeRow({ ic: 10, g2b: 1500, soc_percent: 68.5 }), // cap 2000 W, not saturated
    ];
    const { perSlot } = mapRowsToDessV2(rows, taperCfg);
    expect(perSlot[1].socTarget_percent).toBe(68.5);
  });

  it('untapered: unchanged — only the flat maxChargePower_W saturates', () => {
    const below = mapRowsToDessV2([tpRow(65), makeRow({ ic: 10, g2b: 2000, soc_percent: 69.7 })], cfg).perSlot;
    expect(below[1].socTarget_percent).toBe(69.7);
    const at = mapRowsToDessV2([tpRow(65), makeRow({ ic: 10, g2b: 3600, soc_percent: 72 })], cfg).perSlot;
    expect(at[1].socTarget_percent).toBe(77);
  });

  it('PV export forced by a taper-capped battery does not set the PV export tipping point', () => {
    // Row 1 starts at 85% (cap 1000 W), charges at that cap and spills PV to grid
    // at a low price: that export was forced, not chosen, so row 2 (PV surplus,
    // ec 5) must not be pushed to proGrid by it.
    const rows = [
      makeRow({ soc_percent: 85, ic: 100 }),
      makeRow({ pv: 1500, pv2b: 1000, pv2g: 500, ec: 2, ic: 100, soc_percent: 86.2 }),
      makeRow({ ic: 100, ec: 5, pv: 1000, load: 200, soc_percent: 86.2 }),
    ];
    const tapered = mapRowsToDessV2(rows, taperCfg).perSlot;
    expect(tapered[2].strategy).toBe(Strategy.selfConsumption);
    // Same rows without a taper: the export happened below the flat cap, so it
    // was voluntary and does set the tipping point (behaviour unchanged).
    const flat = mapRowsToDessV2(rows, cfg).perSlot;
    expect(flat[2].strategy).toBe(Strategy.proGrid);
  });
});

describe('mapRowsToDessV2 — rebalance hold window', () => {
  const cfg = {
    stepSize_m: 15,
    batteryCapacity_Wh: 20000,
    minSoc_percent: 10,
    maxSoc_percent: 100,
    maxChargePower_W: 3600,
    maxDischargePower_W: 4000,
    maxGridImport_W: 5000,
    maxGridExport_W: 5000,
    initialSoc_percent: 95,
    rebalanceTargetSoc_percent: 100,
  };

  function makeRow(overrides = {}) {
    return {
      g2l: 0, g2b: 0, g2ev: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0, b2ev: 0,
      soc: 10000, soc_percent: 50,
      load: 500, pv: 0, ev_charge: 0,
      ic: 20, ec: 5,
      ...overrides,
    };
  }

  // Held at max SoC with a PV surplus going to grid: every slot is its own
  // segment and the export is SoC-constrained, so the price logic finds no
  // tipping point and falls through to selfConsumption.
  const pvSurplusAtMax = () => makeRow({ soc_percent: 100, pv: 3000, load: 500, pv2l: 500, pv2g: 2500 });
  // Saturated grid charge that ends the slot at 100 %.
  const saturatedChargeTo100 = () => makeRow({ soc_percent: 100, ic: 10, g2l: 1000, g2b: 4000 });
  const HOLD = { strategy: Strategy.proBattery, restrictions: Restrictions.batteryToGrid };

  it('turns a PV-surplus-at-max-SoC slot (selfConsumption) into a hold', () => {
    const rows = [pvSurplusAtMax()];
    expect(mapRowsToDessV2(rows, cfg).perSlot[0].strategy).toBe(Strategy.selfConsumption);

    const { perSlot } = mapRowsToDessV2(rows, cfg, { rebalanceWindow: { startIdx: 0, endIdx: 0 } });
    expect(perSlot[0]).toMatchObject({ ...HOLD, socTarget_percent: 100, feedin: FeedIn.allowed });
  });

  it('turns a proGrid export slot into a hold that blocks battery→grid', () => {
    const rows = [makeRow({ ic: 30, ec: 100, b2g: 1000 })];
    expect(mapRowsToDessV2(rows, cfg).perSlot[0]).toMatchObject({
      strategy: Strategy.proGrid, restrictions: Restrictions.gridToBattery,
    });

    const { perSlot } = mapRowsToDessV2(rows, cfg, { rebalanceWindow: { startIdx: 0, endIdx: 0 } });
    expect(perSlot[0]).toMatchObject({ ...HOLD, socTarget_percent: 100 });
    expect(perSlot[0].restrictions).not.toBe(Restrictions.gridToBattery);
  });

  it('targets 100 on a saturated charge slot inside the window, 99 outside', () => {
    const rows = [saturatedChargeTo100()];
    expect(mapRowsToDessV2(rows, cfg).perSlot[0].socTarget_percent).toBe(99);

    const { perSlot } = mapRowsToDessV2(rows, cfg, { rebalanceWindow: { startIdx: 0, endIdx: 0 } });
    expect(perSlot[0]).toMatchObject({ ...HOLD, socTarget_percent: 100 });
  });

  it('targets the configured rebalance target (maxSoc 95 → 95)', () => {
    const cfg95 = { ...cfg, maxSoc_percent: 95, rebalanceTargetSoc_percent: 95 };
    const rows = [makeRow({ soc_percent: 95, pv: 3000, load: 500, pv2l: 500, pv2g: 2500 })];
    const { perSlot } = mapRowsToDessV2(rows, cfg95, { rebalanceWindow: { startIdx: 0, endIdx: 0 } });
    expect(perSlot[0]).toMatchObject({ ...HOLD, socTarget_percent: 95 });
  });

  it('falls back to maxSoc_percent when no rebalance target is set', () => {
    const { rebalanceTargetSoc_percent: _target, ...noTargetCfg } = { ...cfg, maxSoc_percent: 95 };
    const rows = [makeRow({ soc_percent: 95 })];
    const { perSlot } = mapRowsToDessV2(rows, noTargetCfg, { rebalanceWindow: { startIdx: 0, endIdx: 0 } });
    expect(perSlot[0].socTarget_percent).toBe(95);
  });

  it('never targets above maxSoc_percent (mirrors the LP clamp)', () => {
    const rows = [makeRow({ soc_percent: 90 })];
    const { perSlot } = mapRowsToDessV2(rows, { ...cfg, maxSoc_percent: 90 }, { rebalanceWindow: { startIdx: 0, endIdx: 0 } });
    expect(perSlot[0].socTarget_percent).toBe(90);
  });

  it('ignores CV thresholds for the in-window target', () => {
    const cvCfg = { ...cfg, cvPhaseThresholds: [{ soc_percent: 94, maxChargePower_W: 2000 }] };
    const rows = [saturatedChargeTo100()];
    const { perSlot } = mapRowsToDessV2(rows, cvCfg, { rebalanceWindow: { startIdx: 0, endIdx: 0 } });
    expect(perSlot[0].socTarget_percent).toBe(100);
  });

  it('keeps the negative-price feed-in block inside the window', () => {
    const rows = [makeRow({ soc_percent: 100, pv: 3000, load: 500, pv2l: 500, pv2g: 2500, ec: -2 })];
    const window = { startIdx: 0, endIdx: 0 };
    expect(mapRowsToDessV2(rows, cfg, { rebalanceWindow: window }).perSlot[0]).toMatchObject({
      ...HOLD, feedin: FeedIn.blocked,
    });
    expect(mapRowsToDessV2(rows, cfg, { rebalanceWindow: window, blockFeedInOnNegativePrices: false }).perSlot[0]).toMatchObject({
      ...HOLD, feedin: FeedIn.allowed,
    });
  });

  it('treats both window ends as inclusive', () => {
    const rows = Array.from({ length: 5 }, pvSurplusAtMax);
    const { perSlot } = mapRowsToDessV2(rows, cfg, { rebalanceWindow: { startIdx: 1, endIdx: 3 } });
    expect(perSlot.map(s => s.strategy)).toEqual([
      Strategy.selfConsumption, Strategy.proBattery, Strategy.proBattery, Strategy.proBattery, Strategy.selfConsumption,
    ]);
  });

  it('accepts a window that runs past the last row', () => {
    const rows = Array.from({ length: 5 }, pvSurplusAtMax);
    const { perSlot } = mapRowsToDessV2(rows, cfg, { rebalanceWindow: { startIdx: 3, endIdx: 20 } });
    expect(perSlot).toHaveLength(5);
    expect(perSlot.map(s => s.strategy)).toEqual([
      Strategy.selfConsumption, Strategy.selfConsumption, Strategy.selfConsumption, Strategy.proBattery, Strategy.proBattery,
    ]);
  });

  it('leaves the mapping unchanged without a window', () => {
    const rows = [
      makeRow({ g2b: 1000, ic: 10, soc_percent: 60 }),
      makeRow({ ic: 30, ec: 100, b2g: 1000, soc_percent: 55 }),
      pvSurplusAtMax(),
      saturatedChargeTo100(),
      makeRow({ ec: -1, b2l: 500 }),
    ];
    expect(mapRowsToDessV2(rows, cfg, { rebalanceWindow: undefined })).toEqual(mapRowsToDessV2(rows, cfg));
    expect(mapRowsToDessV2(rows, cfg, {})).toEqual(mapRowsToDessV2(rows, cfg));
  });
});
