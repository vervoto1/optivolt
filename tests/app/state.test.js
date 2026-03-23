// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { snapshotUI, hydrateUI } from '../../app/src/state.js';

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
});
