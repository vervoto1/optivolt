// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { snapshotUI, hydrateUI, updatePlanMeta, updateSummaryUI, updateTerminalCustomUI } from '../../app/src/state.js';

function makeEls() {
  return {
    step: { value: '15' },
    cap: { value: '20480' },
    minsoc: { value: '20' },
    maxsoc: { value: '100' },
    pchg: { value: '3600' },
    pdis: { value: '4000' },
    gimp: { value: '2500' },
    gexp: { value: '5000' },
    etaC: { value: '95' },
    etaD: { value: '95' },
    bwear: { value: '2' },
    idleDrain: { value: '40' },
    terminal: { value: 'zero' },
    terminalCustom: { value: '0', style: {} },
    sourcePrices: { value: 'vrm' },
    sourceLoad: { value: 'vrm' },
    sourcePv: { value: 'vrm' },
    sourceSoc: { value: 'mqtt' },
    sourceEvLoad: { value: 'api' },
    rebalanceEnabled: { checked: false },
    rebalanceHoldHours: { value: '3' },
    haUrl: { value: 'ws://homeassistant.local:8123/api/websocket' },
    haToken: { value: '' },
    evEnabled: { checked: false },
    evChargerPower: { value: '11000' },
    evDisableDischarge: { checked: true },
    evScheduleSensor: { value: '' },
    evScheduleAttribute: { value: 'charging_schedule' },
    evConnectedSwitch: { value: '' },
    evAlwaysApply: { checked: false },
    cvEnabled: { checked: false },
    cvThreshold1Soc: { value: '95' },
    cvThreshold1Power: { value: '9360' },
    cvThreshold2Soc: { value: '97' },
    cvThreshold2Power: { value: '2600' },
    autoCalcEnabled: { checked: false },
    autoCalcInterval: { value: '15' },
    autoCalcUpdateData: { checked: true },
    autoCalcWriteVictron: { checked: true },
    dessRefreshEnabled: { checked: false },
    dessRefreshTime: { value: '23:00' },
    dessRefreshDuration: { value: '15' },
    haPriceSensor: { value: '' },
    haPriceInterval: { value: '60' },
    haPriceTodayAttr: { value: 'today_hourly_prices' },
    haPriceTomorrowAttr: { value: 'tomorrow_hourly_prices' },
    haPriceTimeKey: { value: 'time' },
    haPriceValueKey: { value: 'value' },
    haPriceMultiplier: { value: '100' },
    haPriceImportEqualsExport: { checked: true },
    tableKwh: { checked: false },
    haSettingsGroup: { hidden: false },
    planSocNow: { textContent: '' },
    planTsStart: { textContent: '' },
  };
}

describe('state.js', () => {
  it('does not include haToken in snapshots when the input is blank', () => {
    const els = makeEls();
    const snapshot = snapshotUI(els);
    expect(snapshot.haUrl).toBe('ws://homeassistant.local:8123/api/websocket');
    expect('haToken' in snapshot).toBe(false);
  });

  it('includes haToken in snapshots when the user entered one', () => {
    const els = makeEls();
    els.haToken.value = 'secret-token';
    const snapshot = snapshotUI(els);
    expect(snapshot.haToken).toBe('secret-token');
  });

  it('does not overwrite the token input when the server omits haToken', () => {
    const els = makeEls();
    els.haToken.value = 'keep-me';
    hydrateUI(els, {
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      dataSources: { prices: 'vrm', load: 'vrm', pv: 'vrm', soc: 'mqtt', evLoad: 'api' },
    });
    expect(els.haToken.value).toBe('keep-me');
  });

  it('hydrateUI sets haToken when server provides it', () => {
    const els = makeEls();
    hydrateUI(els, { haToken: 'from-server' });
    expect(els.haToken.value).toBe('from-server');
  });

  it('hydrateUI hides haSettingsGroup when isAddon', () => {
    const els = makeEls();
    hydrateUI(els, { isAddon: true });
    expect(els.haSettingsGroup.hidden).toBe(true);
  });

  it('hydrateUI shows haSettingsGroup when not addon', () => {
    const els = makeEls();
    hydrateUI(els, { isAddon: false });
    expect(els.haSettingsGroup.hidden).toBe(false);
  });

  it('hydrateUI sets all EV config values', () => {
    const els = makeEls();
    hydrateUI(els, {
      evConfig: {
        enabled: true, chargerPower_W: 22000,
        disableDischargeWhileCharging: false,
        scheduleSensor: 'sensor.ev', scheduleAttribute: 'schedule',
        connectedSwitch: 'switch.ev', alwaysApplySchedule: true,
      },
    });
    expect(els.evEnabled.checked).toBe(true);
    expect(els.evChargerPower.value).toBe(22000);
    expect(els.evAlwaysApply.checked).toBe(true);
  });

  it('hydrateUI sets CV phase thresholds', () => {
    const els = makeEls();
    hydrateUI(els, {
      cvPhase: {
        enabled: true,
        thresholds: [
          { soc_percent: 90, maxChargePower_W: 5000 },
          { soc_percent: 95, maxChargePower_W: 2000 },
        ],
      },
    });
    expect(els.cvEnabled.checked).toBe(true);
    expect(els.cvThreshold1Soc.value).toBe(90);
    expect(els.cvThreshold2Power.value).toBe(2000);
  });

  it('hydrateUI sets auto-calculate config', () => {
    const els = makeEls();
    hydrateUI(els, {
      autoCalculate: { enabled: true, intervalMinutes: 30, updateData: false, writeToVictron: false },
    });
    expect(els.autoCalcEnabled.checked).toBe(true);
    expect(els.autoCalcInterval.value).toBe(30);
    expect(els.autoCalcUpdateData.checked).toBe(false);
  });

  it('hydrateUI sets DESS price refresh config', () => {
    const els = makeEls();
    hydrateUI(els, {
      dessPriceRefresh: { enabled: true, time: '12:00', durationMinutes: 60 },
    });
    expect(els.dessRefreshEnabled.checked).toBe(true);
    expect(els.dessRefreshTime.value).toBe('12:00');
  });

  it('hydrateUI sets HA price config', () => {
    const els = makeEls();
    hydrateUI(els, {
      haPriceConfig: {
        sensor: 'sensor.price', priceInterval: 15,
        todayAttribute: 'today', tomorrowAttribute: 'tomorrow',
        timeKey: 'ts', valueKey: 'val', valueMultiplier: 200,
        importEqualsExport: false,
      },
    });
    expect(els.haPriceSensor.value).toBe('sensor.price');
    expect(els.haPriceInterval.value).toBe('15');
    expect(els.haPriceMultiplier.value).toBe(200);
  });

  it('hydrateUI sets tableShowKwh', () => {
    const els = makeEls();
    hydrateUI(els, { tableShowKwh: true });
    expect(els.tableKwh.checked).toBe(true);
  });

  it('hydrateUI sets terminalSocValuation', () => {
    const els = makeEls();
    hydrateUI(els, { terminalSocValuation: 'custom' });
    expect(els.terminal.value).toBe('custom');
  });

  it('hydrateUI handles rebalanceEnabled', () => {
    const els = makeEls();
    hydrateUI(els, { rebalanceEnabled: true, rebalanceHoldHours: 5 });
    expect(els.rebalanceEnabled.checked).toBe(true);
    expect(els.rebalanceHoldHours.value).toBe('5');
  });

  it('hydrateUI handles value of 0 in setIfDef', () => {
    const els = makeEls();
    hydrateUI(els, { idleDrain_W: 0 });
    expect(els.idleDrain.value).toBe('0');
  });

  it('hydrateUI setIfDef sets textContent for elements without value property', () => {
    const els = makeEls();
    // planSocNow has textContent, not value
    hydrateUI(els, { initialSoc_percent: 75 });
    expect(els.planSocNow.textContent).toBe('75');
  });

  it('hydrateUI setIfDef sets textContent to 0 for elements without value', () => {
    const els = makeEls();
    // Create an element that only has textContent (no value property)
    const tcEl = { textContent: 'old' };
    els.step = tcEl; // step normally has value, override to test textContent path
    hydrateUI(els, { stepSize_m: 0 });
    expect(tcEl.textContent).toBe('0');
  });

  it('hydrateUI setIfDef sets textContent for non-zero value on textContent-only element', () => {
    const els = makeEls();
    const tcEl = { textContent: '' };
    els.step = tcEl;
    hydrateUI(els, { stepSize_m: 42 });
    expect(tcEl.textContent).toBe('42');
  });

  it('snapshotUI returns cvPhase with filtered thresholds', () => {
    const els = makeEls();
    els.cvEnabled.checked = true;
    els.cvThreshold1Soc.value = '0';
    els.cvThreshold1Power.value = '0';
    els.cvThreshold2Soc.value = '97';
    els.cvThreshold2Power.value = '2600';
    const snapshot = snapshotUI(els);
    expect(snapshot.cvPhase.thresholds).toHaveLength(1);
    expect(snapshot.cvPhase.thresholds[0].soc_percent).toBe(97);
  });

  it('snapshotUI handles null elements gracefully', () => {
    const els = makeEls();
    els.step = null;
    els.cap = null;
    const snapshot = snapshotUI(els);
    expect(snapshot.stepSize_m).toBeNull();
    expect(snapshot.batteryCapacity_Wh).toBeNull();
  });
});

describe('updatePlanMeta', () => {
  it('shows dash for null initialSoc_percent', () => {
    const els = makeEls();
    updatePlanMeta(els, null, null);
    expect(els.planSocNow.textContent).toBe('—');
    expect(els.planTsStart.textContent).toBe('—');
  });

  it('shows dash for non-finite soc', () => {
    const els = makeEls();
    updatePlanMeta(els, NaN, null);
    expect(els.planSocNow.textContent).toBe('—');
  });

  it('shows rounded integer for valid soc', () => {
    const els = makeEls();
    updatePlanMeta(els, 72.6, null);
    expect(els.planSocNow.textContent).toBe('73');
  });

  it('formats valid ISO date tsStart', () => {
    const els = makeEls();
    updatePlanMeta(els, 50, '2024-01-15T08:30:00.000Z');
    // Should format as dd/mm HH:MM in local timezone
    expect(els.planTsStart.textContent).toMatch(/\d{2}\/\d{2}\s\d{2}:\d{2}/);
  });

  it('shows raw string for invalid date', () => {
    const els = makeEls();
    updatePlanMeta(els, 50, 'not-a-date');
    expect(els.planTsStart.textContent).toBe('not-a-date');
  });

  it('handles missing planSocNow element', () => {
    const els = makeEls();
    delete els.planSocNow;
    updatePlanMeta(els, 50, null); // no error
  });
});

describe('updateSummaryUI', () => {
  function makeSummaryEls() {
    return {
      sumLoad: { textContent: '' },
      sumPv: { textContent: '' },
      sumEv: { textContent: '' },
      sumEvRow: { hidden: false },
      sumLoadGrid: { textContent: '' },
      sumLoadBatt: { textContent: '' },
      sumLoadPv: { textContent: '' },
      avgImport: { textContent: '' },
      gridBatteryTp: { textContent: '' },
      gridChargeTp: { textContent: '' },
      batteryExportTp: { textContent: '' },
      rebalanceStatus: { textContent: '', className: '' },
      rebalanceStatusRow: { classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn() } },
    };
  }

  it('resets all fields when summary is null', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, null);
    expect(els.sumLoad.textContent).toBe('—');
    expect(els.sumPv.textContent).toBe('—');
    expect(els.avgImport.textContent).toBe('—');
    expect(els.sumEvRow.hidden).toBe(true);
  });

  it('displays summary with real DOM elements for stacked bars', () => {
    // Test with real DOM to cover updateStackedBarContainer
    document.body.innerHTML = `
      <div id="load-split-bar" style="display:flex"></div>
      <div id="flow-split-bar" style="display:flex"></div>
    `;
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 10, pvTotal_kWh: 5, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 5, loadFromBattery_kWh: 3, loadFromPv_kWh: 2,
      avgImportPrice_cents_per_kWh: 10,
      gridBatteryTippingPoint_cents_per_kWh: 5,
      gridChargeTippingPoint_cents_per_kWh: 3,
      batteryExportTippingPoint_cents_per_kWh: 12,
      gridToBattery_kWh: 2, batteryToGrid_kWh: 1,
    });
    const loadBar = document.getElementById('load-split-bar');
    expect(loadBar.children.length).toBe(3); // grid, battery, pv segments
    const flowBar = document.getElementById('flow-split-bar');
    expect(flowBar.children.length).toBe(4);
    // Verify segments have styles
    expect(loadBar.children[0].style.width).toContain('%');
    expect(loadBar.children[0].title).toContain('Grid');
    document.body.innerHTML = '';
  });

  it('displays summary values', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 25.5,
      pvTotal_kWh: 12.3,
      evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 15.0,
      loadFromBattery_kWh: 5.0,
      loadFromPv_kWh: 5.5,
      avgImportPrice_cents_per_kWh: 8.75,
      gridBatteryTippingPoint_cents_per_kWh: 5.0,
      gridChargeTippingPoint_cents_per_kWh: 3.0,
      batteryExportTippingPoint_cents_per_kWh: 12.0,
      gridToBattery_kWh: 2.0,
      batteryToGrid_kWh: 1.0,
    });
    expect(els.sumLoad.textContent).toBe('25.50 kWh');
    expect(els.sumPv.textContent).toBe('12.30 kWh');
    expect(els.avgImport.textContent).toBe('8.75 c€/kWh');
    expect(els.gridBatteryTp.textContent).toContain('5.00');
    expect(els.batteryExportTp.textContent).toContain('12.00');
  });

  it('shows EV row when evLoadTotal_kWh > 0', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 10, pvTotal_kWh: 5, evLoadTotal_kWh: 3.5,
      loadFromGrid_kWh: 5, loadFromBattery_kWh: 3, loadFromPv_kWh: 2,
      avgImportPrice_cents_per_kWh: 10,
      gridBatteryTippingPoint_cents_per_kWh: null,
      gridChargeTippingPoint_cents_per_kWh: null,
      batteryExportTippingPoint_cents_per_kWh: null,
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    expect(els.sumEvRow.hidden).toBe(false);
    expect(els.sumEv.textContent).toBe('3.50 kWh');
  });

  it('falls back to pvExportTippingPoint when batteryExportTippingPoint is null', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 10, pvTotal_kWh: 5, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 5, loadFromBattery_kWh: 3, loadFromPv_kWh: 2,
      avgImportPrice_cents_per_kWh: 10,
      gridBatteryTippingPoint_cents_per_kWh: 5,
      gridChargeTippingPoint_cents_per_kWh: 3,
      batteryExportTippingPoint_cents_per_kWh: null,
      pvExportTippingPoint_cents_per_kWh: 7.5,
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    expect(els.batteryExportTp.textContent).toContain('7.50');
  });

  it('shows dash for null tipping points', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 10, pvTotal_kWh: 5, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 5, loadFromBattery_kWh: 3, loadFromPv_kWh: 2,
      avgImportPrice_cents_per_kWh: null,
      gridBatteryTippingPoint_cents_per_kWh: null,
      gridChargeTippingPoint_cents_per_kWh: null,
      batteryExportTippingPoint_cents_per_kWh: null,
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    expect(els.avgImport.textContent).toBe('—');
    expect(els.gridBatteryTp.textContent).toBe('—');
  });

  it('shows dash for NaN kWh values', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: NaN, pvTotal_kWh: NaN, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 0, loadFromBattery_kWh: 0, loadFromPv_kWh: 0,
      avgImportPrice_cents_per_kWh: NaN,
      gridBatteryTippingPoint_cents_per_kWh: NaN,
      gridChargeTippingPoint_cents_per_kWh: NaN,
      batteryExportTippingPoint_cents_per_kWh: NaN,
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    expect(els.sumLoad.textContent).toBe('—');
    expect(els.avgImport.textContent).toBe('—');
  });

  it('shows 0.00 kWh for exactly zero', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 0, pvTotal_kWh: 0, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 0, loadFromBattery_kWh: 0, loadFromPv_kWh: 0,
      avgImportPrice_cents_per_kWh: 0,
      gridBatteryTippingPoint_cents_per_kWh: 0,
      gridChargeTippingPoint_cents_per_kWh: 0,
      batteryExportTippingPoint_cents_per_kWh: 0,
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    expect(els.sumLoad.textContent).toBe('0.00 kWh');
    expect(els.avgImport.textContent).toBe('0.00 c€/kWh');
  });

  it('handles rebalanceStatus active', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 10, pvTotal_kWh: 5, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 5, loadFromBattery_kWh: 3, loadFromPv_kWh: 2,
      avgImportPrice_cents_per_kWh: 10,
      gridBatteryTippingPoint_cents_per_kWh: 5,
      gridChargeTippingPoint_cents_per_kWh: 3,
      batteryExportTippingPoint_cents_per_kWh: 12,
      rebalanceStatus: 'active',
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    expect(els.rebalanceStatusRow.classList.remove).toHaveBeenCalledWith('hidden');
    expect(els.rebalanceStatus.textContent).toBe('Active');
  });

  it('handles rebalanceStatus scheduled', () => {
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 10, pvTotal_kWh: 5, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 5, loadFromBattery_kWh: 3, loadFromPv_kWh: 2,
      avgImportPrice_cents_per_kWh: 10,
      gridBatteryTippingPoint_cents_per_kWh: 5,
      gridChargeTippingPoint_cents_per_kWh: 3,
      batteryExportTippingPoint_cents_per_kWh: 12,
      rebalanceStatus: 'scheduled',
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    expect(els.rebalanceStatus.textContent).toBe('Scheduled');
  });

  it('handles missing summary elements gracefully', () => {
    const els = {};
    updateSummaryUI(els, null); // no error
    updateSummaryUI(els, { loadTotal_kWh: 10 }); // no error
  });

  it('updateStackedBarContainer creates no segments when total <= 0', () => {
    document.body.innerHTML = `
      <div id="load-split-bar" style="display:flex"></div>
      <div id="flow-split-bar" style="display:flex"></div>
    `;
    const els = makeSummaryEls();
    updateSummaryUI(els, {
      loadTotal_kWh: 0, pvTotal_kWh: 0, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 0, loadFromBattery_kWh: 0, loadFromPv_kWh: 0,
      avgImportPrice_cents_per_kWh: 0,
      gridBatteryTippingPoint_cents_per_kWh: 0,
      gridChargeTippingPoint_cents_per_kWh: 0,
      batteryExportTippingPoint_cents_per_kWh: 0,
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    const loadBar = document.getElementById('load-split-bar');
    expect(loadBar.children.length).toBe(0);
    document.body.innerHTML = '';
  });

  it('updateStackedBarContainer skips segments with pct <= 0', () => {
    document.body.innerHTML = `
      <div id="load-split-bar" style="display:flex"></div>
      <div id="flow-split-bar" style="display:flex"></div>
    `;
    const els = makeSummaryEls();
    // Only grid contributes, battery and PV are zero
    updateSummaryUI(els, {
      loadTotal_kWh: 10, pvTotal_kWh: 0, evLoadTotal_kWh: 0,
      loadFromGrid_kWh: 10, loadFromBattery_kWh: 0, loadFromPv_kWh: 0,
      avgImportPrice_cents_per_kWh: 10,
      gridBatteryTippingPoint_cents_per_kWh: 5,
      gridChargeTippingPoint_cents_per_kWh: 3,
      batteryExportTippingPoint_cents_per_kWh: 12,
      gridToBattery_kWh: 0, batteryToGrid_kWh: 0,
    });
    const loadBar = document.getElementById('load-split-bar');
    // Only grid segment should appear (battery=0 and pv=0 are skipped)
    expect(loadBar.children.length).toBe(1);
    document.body.innerHTML = '';
  });

  it('setIfDef skips null values via hydrateUI', () => {
    const els = makeEls();
    els.idleDrain.value = 'original';
    // hydrateUI calls setIfDef; null/undefined values should be skipped
    hydrateUI(els, { idleDrain_W: null });
    expect(els.idleDrain.value).toBe('original');
  });

  it('setIfDef skips undefined values via hydrateUI', () => {
    const els = makeEls();
    els.step.value = 'original';
    // When the property is not in the object, setIfDef receives undefined and skips
    hydrateUI(els, {});
    expect(els.step.value).toBe('original');
  });
});

describe('updateTerminalCustomUI', () => {
  it('disables terminalCustom when terminal is not custom', () => {
    const els = makeEls();
    els.terminal.value = 'zero';
    updateTerminalCustomUI(els);
    expect(els.terminalCustom.disabled).toBe(true);
  });

  it('enables terminalCustom when terminal is custom', () => {
    const els = makeEls();
    els.terminal.value = 'custom';
    updateTerminalCustomUI(els);
    expect(els.terminalCustom.disabled).toBe(false);
  });

  it('handles missing elements', () => {
    updateTerminalCustomUI({});
    updateTerminalCustomUI({ terminal: null, terminalCustom: null });
  });
});
