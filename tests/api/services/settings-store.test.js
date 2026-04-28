import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/json-store.ts', () => {
  let store = {};
  return {
    resolveDataDir: () => '/tmp/test-data',
    readJson: vi.fn(async (filePath) => {
      if (store[filePath] === undefined) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return JSON.parse(JSON.stringify(store[filePath]));
    }),
    writeJson: vi.fn(async (filePath, data) => {
      store[filePath] = JSON.parse(JSON.stringify(data));
    }),
    _reset: () => { store = {}; },
    _set: (filePath, data) => { store[filePath] = JSON.parse(JSON.stringify(data)); },
  };
});

import { loadSettings, saveSettings, loadDefaultSettings } from '../../../api/services/settings-store.ts';
import { readJson, writeJson, _reset, _set } from '../../../api/services/json-store.ts';

// Minimal valid settings matching the schema
function makeDefaults(overrides = {}) {
  return {
    stepSize_m: 15,
    batteryCapacity_Wh: 20480,
    minSoc_percent: 20,
    maxSoc_percent: 100,
    maxChargePower_W: 3600,
    maxDischargePower_W: 4000,
    maxGridImport_W: 2500,
    maxGridExport_W: 5000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 0,
    idleDrain_W: 0,
    terminalSocCustomPrice_cents_per_kWh: 0,
    rebalanceHoldHours: 3,
    terminalSocValuation: 'zero',
    haUrl: '',
    haToken: '',
    dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
    ...overrides,
  };
}

// The default-settings.json is loaded via its real path; we need to seed it
function getDefaultPath() {
  return new URL('../../../api/defaults/default-settings.json', import.meta.url).pathname;
}

describe('loadSettings', () => {
  beforeEach(() => {
    _reset();
  });

  it('returns defaults when no settings file exists', async () => {
    _set(getDefaultPath(), makeDefaults());

    const settings = await loadSettings();
    expect(settings.stepSize_m).toBe(15);
    expect(settings.batteryCapacity_Wh).toBe(20480);
  });

  it('merges stored settings with defaults', async () => {
    _set(getDefaultPath(), makeDefaults());
    _set('/tmp/test-data/settings.json', { batteryCost_cent_per_kWh: 7 });

    const settings = await loadSettings();
    expect(settings.batteryCost_cent_per_kWh).toBe(7);
    // Default field still present
    expect(settings.stepSize_m).toBe(15);
  });

  it('deep-merges dataSources from stored settings with defaults', async () => {
    _set(getDefaultPath(), makeDefaults());
    _set('/tmp/test-data/settings.json', {
      dataSources: { prices: 'ha' },
    });

    const settings = await loadSettings();
    // Overridden field
    expect(settings.dataSources.prices).toBe('ha');
    // Default fields preserved
    expect(settings.dataSources.load).toBe('vrm');
  });

  it('throws when stored settings file has a non-ENOENT error', async () => {
    _set(getDefaultPath(), makeDefaults());
    // First call returns defaults, second (settings.json) throws EPERM
    readJson
      .mockResolvedValueOnce(makeDefaults())
      .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    await expect(loadSettings()).rejects.toThrow('EPERM');
  });
});

describe('loadSettings — shoreOptimizer merge with null', () => {
  beforeEach(() => {
    _reset();
  });

  it('handles null shoreOptimizer in stored settings', async () => {
    const defaults = makeDefaults({
      shoreOptimizer: {
        enabled: true,
        dryRun: true,
        tickMs: 3000,
        stepA: 0.5,
        minShoreA: 0,
        maxShoreA: 25,
        minChargingPowerW: 200,
        gateOnDessSchedule: true,
        portalId: 'test-portal',
        multiInstance: 6,
        acInputIndex: 1,
        mpptInstance: 0,
        batteryInstance: 512,
      },
    });
    _set(getDefaultPath(), defaults);
    // Stored settings explicitly set shoreOptimizer to null
    _set('/tmp/test-data/settings.json', { shoreOptimizer: null });

    const settings = await loadSettings();
    // defaults.shoreOptimizer ?? {} should provide the merge base
    expect(settings.shoreOptimizer).toBeDefined();
    expect(settings.shoreOptimizer.enabled).toBe(true);
  });

  it('handles null shoreOptimizer in defaults', async () => {
    // Defaults have no shoreOptimizer at all (undefined → ?? {} path)
    _set(getDefaultPath(), makeDefaults());
    _set('/tmp/test-data/settings.json', {
      shoreOptimizer: {
        enabled: true,
        dryRun: false,
        tickMs: 3000,
        stepA: 0.5,
        minShoreA: 0,
        maxShoreA: 25,
        minChargingPowerW: 200,
        gateOnDessSchedule: false,
        portalId: 'stored-portal',
        multiInstance: 6,
        acInputIndex: 1,
        mpptInstance: 0,
        batteryInstance: 512,
      },
    });

    const settings = await loadSettings();
    expect(settings.shoreOptimizer).toBeDefined();
    expect(settings.shoreOptimizer.portalId).toBe('stored-portal');
  });
});

describe('loadSettings — validateSettings edge cases', () => {
  beforeEach(() => {
    _reset();
  });

  it('throws when a numeric field in defaults is NaN', async () => {
    // Seed the defaults with a NaN numeric field so validateSettings rejects
    readJson
      .mockResolvedValueOnce(makeDefaults({ chargeEfficiency_percent: NaN }));

    await expect(loadSettings()).rejects.toThrow('chargeEfficiency_percent must be a finite number');
  });

  it('swaps minSoc and maxSoc when minSoc > maxSoc after merge', async () => {
    _set(getDefaultPath(), makeDefaults());
    // Stored settings override minSoc/maxSoc to be inverted
    _set('/tmp/test-data/settings.json', { minSoc_percent: 90, maxSoc_percent: 10 });

    const settings = await loadSettings();
    expect(settings.minSoc_percent).toBeLessThan(settings.maxSoc_percent);
  });
});

describe('saveSettings', () => {
  beforeEach(() => {
    _reset();
  });

  it('persists settings via writeJson', async () => {
    const settings = makeDefaults();
    await saveSettings(settings);
    expect(writeJson).toHaveBeenCalledWith(
      expect.stringContaining('settings.json'),
      expect.objectContaining(settings),
    );
  });
});

describe('loadDefaultSettings', () => {
  beforeEach(() => {
    _reset();
  });

  it('reads directly from the default-settings.json file', async () => {
    _set(getDefaultPath(), makeDefaults({ batteryCapacity_Wh: 5000 }));

    const defaults = await loadDefaultSettings();
    expect(defaults.batteryCapacity_Wh).toBe(5000);
  });
});
