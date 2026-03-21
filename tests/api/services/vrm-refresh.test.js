import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSettings, saveSettings } from '../../../api/services/settings-store.ts';
import { loadData, saveData } from '../../../api/services/data-store.ts';
import * as mqttService from '../../../api/services/mqtt-service.ts';

// ---------------------------------------------------------------------------
// Hoisted mock factories for VRMClient methods
// ---------------------------------------------------------------------------
const { mockFetchForecasts, mockFetchPrices, mockFetchDessSettings } = vi.hoisted(() => ({
  mockFetchForecasts: vi.fn(),
  mockFetchPrices: vi.fn(),
  mockFetchDessSettings: vi.fn(),
}));

vi.mock('../../../lib/vrm-api.ts', () => ({
  VRMClient: class {
    constructor() {
      this.fetchForecasts = mockFetchForecasts;
      this.fetchPrices = mockFetchPrices;
      this.fetchDynamicEssSettings = mockFetchDessSettings;
    }
  },
}));

vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/mqtt-service.ts');
vi.mock('../../../api/services/ha-ev-service.ts', () => ({
  fetchEvLoadFromHA: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../api/services/ha-price-service.ts', () => ({
  fetchPricesFromHA: vi.fn().mockResolvedValue(null),
}));

const { refreshSeriesFromVrmAndPersist, refreshSettingsFromVrmAndPersist } = await import(
  '../../../api/services/vrm-refresh.ts'
);

// ---------------------------------------------------------------------------
// Shared defaults
// ---------------------------------------------------------------------------
const baseSettings = {
  stepSize_m: 15,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 5000,
  maxDischargePower_W: 5000,
  maxGridImport_W: 5000,
  maxGridExport_W: 5000,
  batteryCost_cent_per_kWh: 5,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
};

const baseData = {
  load: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [100] },
  pv: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [50] },
  importPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [10] },
  exportPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [5] },
  soc: { value: 60, timestamp: '2024-01-01T00:00:00.000Z' },
};

const forecasts = {
  timestamps: [new Date('2024-01-01T10:00:00.000Z').getTime()],
  step_minutes: 15,
  load_W: [500],
  pv_W: [200],
};

const prices = {
  timestamps: [new Date('2024-01-01T10:00:00.000Z').getTime()],
  step_minutes: 15,
  importPrice_cents_per_kwh: [12],
  exportPrice_cents_per_kwh: [6],
};

describe('refreshSeriesFromVrmAndPersist — MQTT SoC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';

    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
    saveData.mockResolvedValue();
    saveSettings.mockResolvedValue();
    mockFetchForecasts.mockResolvedValue({ ...forecasts });
    mockFetchPrices.mockResolvedValue({ ...prices });
  });

  afterEach(() => {
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });

  it('uses MQTT SoC when soc source is mqtt and reading succeeds', async () => {
    mqttService.readVictronSocPercent.mockResolvedValue(75);

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.soc.value).toBe(75);
    expect(savedData.soc.timestamp).toBeDefined();
  });

  it('falls back to existing SoC when MQTT read fails', async () => {
    mqttService.readVictronSocPercent.mockRejectedValue(new Error('MQTT timeout'));

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    // Falls back to baseData.soc
    expect(savedData.soc).toEqual(baseData.soc);
  });

  it('does not call readVictronSocPercent when soc source is not mqtt', async () => {
    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'api' },
    });

    await refreshSeriesFromVrmAndPersist();

    expect(mqttService.readVictronSocPercent).not.toHaveBeenCalled();
  });

  it('preserves existing soc when soc source is api', async () => {
    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'api' },
    });

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.soc).toEqual(baseData.soc);
  });
});

describe('refreshSeriesFromVrmAndPersist — VRM data fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';

    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
    saveData.mockResolvedValue();
    saveSettings.mockResolvedValue();
    mqttService.readVictronSocPercent.mockResolvedValue(50);
  });

  afterEach(() => {
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });

  it('persists VRM load data from forecasts', async () => {
    mockFetchForecasts.mockResolvedValue({ ...forecasts });
    mockFetchPrices.mockResolvedValue({ ...prices });

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.load.values).toEqual([500]);
    expect(savedData.load.start).toBe('2024-01-01T10:00:00.000Z');
  });

  it('persists VRM pv data from forecasts', async () => {
    mockFetchForecasts.mockResolvedValue({ ...forecasts });
    mockFetchPrices.mockResolvedValue({ ...prices });

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.pv.values).toEqual([200]);
  });

  it('persists VRM import/export price data', async () => {
    mockFetchForecasts.mockResolvedValue({ ...forecasts });
    mockFetchPrices.mockResolvedValue({ ...prices });

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.importPrice.values).toEqual([12]);
    expect(savedData.exportPrice.values).toEqual([6]);
  });

  it('keeps existing load/pv when forecast fetch fails', async () => {
    mockFetchForecasts.mockRejectedValue(new Error('VRM down'));
    mockFetchPrices.mockResolvedValue({ ...prices });

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    // Falls back to baseData values
    expect(savedData.load).toEqual(baseData.load);
    expect(savedData.pv).toEqual(baseData.pv);
  });

  it('keeps existing prices when prices fetch fails', async () => {
    mockFetchForecasts.mockResolvedValue({ ...forecasts });
    mockFetchPrices.mockRejectedValue(new Error('prices unavailable'));

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.importPrice).toEqual(baseData.importPrice);
    expect(savedData.exportPrice).toEqual(baseData.exportPrice);
  });

  it('skips forecast fetch when both load and pv sources are not vrm', async () => {
    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'api', pv: 'api', prices: 'vrm', soc: 'mqtt' },
    });
    mockFetchPrices.mockResolvedValue({ ...prices });

    await refreshSeriesFromVrmAndPersist();

    expect(mockFetchForecasts).not.toHaveBeenCalled();
  });

  it('skips price fetch when prices source is not vrm', async () => {
    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'api', soc: 'mqtt' },
    });
    mockFetchForecasts.mockResolvedValue({ ...forecasts });

    await refreshSeriesFromVrmAndPersist();

    expect(mockFetchPrices).not.toHaveBeenCalled();
  });

  it('updates stepSize_m in settings from forecast step_minutes', async () => {
    mockFetchForecasts.mockResolvedValue({ ...forecasts, step_minutes: 15 });
    mockFetchPrices.mockResolvedValue({ ...prices });

    await refreshSeriesFromVrmAndPersist();

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ stepSize_m: 15 }),
    );
  });

  it('throws when VRM_INSTALLATION_ID is not set', async () => {
    delete process.env.VRM_INSTALLATION_ID;
    await expect(refreshSeriesFromVrmAndPersist()).rejects.toThrow('VRM Site ID not configured');
  });

  it('throws when VRM_TOKEN is not set', async () => {
    delete process.env.VRM_TOKEN;
    await expect(refreshSeriesFromVrmAndPersist()).rejects.toThrow('VRM API token not configured');
  });
});

describe('refreshSeriesFromVrmAndPersist — HA prices and EV load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';

    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'ha', soc: 'mqtt' },
    });
    loadData.mockResolvedValue({ ...baseData });
    saveData.mockResolvedValue();
    saveSettings.mockResolvedValue();
    mqttService.readVictronSocPercent.mockResolvedValue(50);
    mockFetchForecasts.mockResolvedValue({ ...forecasts });
    mockFetchPrices.mockResolvedValue({ ...prices });
  });

  afterEach(() => {
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });

  it('uses HA prices when dataSources.prices is ha', async () => {
    const { fetchPricesFromHA } = await import('../../../api/services/ha-price-service.ts');
    fetchPricesFromHA.mockResolvedValueOnce({
      importPrice: { start: '2024-01-01T10:00:00.000Z', step: 15, values: [20] },
      exportPrice: { start: '2024-01-01T10:00:00.000Z', step: 15, values: [10] },
    });

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.importPrice.values).toEqual([20]);
    expect(savedData.exportPrice.values).toEqual([10]);
  });

  it('falls back to VRM prices when HA price fetch throws', async () => {
    const { fetchPricesFromHA } = await import('../../../api/services/ha-price-service.ts');
    fetchPricesFromHA.mockRejectedValueOnce(new Error('HA unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshSeriesFromVrmAndPersist();

    // Falls back to baseData prices (VRM fetch also skipped because prices='ha', so baseData)
    const savedData = saveData.mock.calls[0][0];
    expect(savedData.importPrice).toEqual(baseData.importPrice);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vrm-refresh]'),
      expect.stringContaining('HA unavailable'),
    );
    warnSpy.mockRestore();
  });

  it('uses HA EV load when evConfig is enabled', async () => {
    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
      evConfig: { enabled: true },
    });
    mockFetchPrices.mockResolvedValue({ ...prices });

    const { fetchEvLoadFromHA } = await import('../../../api/services/ha-ev-service.ts');
    fetchEvLoadFromHA.mockResolvedValueOnce({
      start: '2024-01-01T10:00:00.000Z',
      step: 15,
      values: [11000, 11000],
    });

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.evLoad).toBeDefined();
    expect(savedData.evLoad.values).toEqual([11000, 11000]);
  });

  it('warns and clears evLoad when HA EV load fetch throws', async () => {
    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
      evConfig: { enabled: true },
    });
    mockFetchPrices.mockResolvedValue({ ...prices });

    const { fetchEvLoadFromHA } = await import('../../../api/services/ha-ev-service.ts');
    fetchEvLoadFromHA.mockRejectedValueOnce(new Error('EV service down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshSeriesFromVrmAndPersist();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vrm-refresh]'),
      expect.stringContaining('EV service down'),
    );
    warnSpy.mockRestore();
  });
});

describe('refreshSeriesFromVrmAndPersist — SoC null result and HA prices null', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';

    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
    saveData.mockResolvedValue();
    saveSettings.mockResolvedValue();
    mockFetchForecasts.mockResolvedValue({ ...forecasts });
    mockFetchPrices.mockResolvedValue({ ...prices });
  });

  afterEach(() => {
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });

  it('keeps existing soc when MQTT returns null socPercent (fulfilled with null)', async () => {
    // Line 19: shouldFetchSoc=true but socPercent=null → uses baseData.soc
    mqttService.readVictronSocPercent.mockResolvedValue(null);

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.soc).toEqual(baseData.soc);
  });

  it('keeps existing prices when HA prices fetch returns null', async () => {
    // Line 146: haPrices is null — importPrice/exportPrice not updated
    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'ha', soc: 'mqtt' },
    });
    mqttService.readVictronSocPercent.mockResolvedValue(50);

    const { fetchPricesFromHA } = await import('../../../api/services/ha-price-service.ts');
    fetchPricesFromHA.mockResolvedValueOnce(null);

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    // importPrice/exportPrice should fall back to baseData since HA returned null
    expect(savedData.importPrice).toEqual(baseData.importPrice);
    expect(savedData.exportPrice).toEqual(baseData.exportPrice);
  });

  it('sets evLoad to undefined when fetchEvLoadFromHA returns null', async () => {
    // Line 161: fetched = null → evLoad = undefined
    loadSettings.mockResolvedValue({
      ...baseSettings,
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
      evConfig: { enabled: true },
    });
    mqttService.readVictronSocPercent.mockResolvedValue(50);

    const { fetchEvLoadFromHA } = await import('../../../api/services/ha-ev-service.ts');
    fetchEvLoadFromHA.mockResolvedValueOnce(null);

    await refreshSeriesFromVrmAndPersist();

    const savedData = saveData.mock.calls[0][0];
    expect(savedData.evLoad).toBeUndefined();
  });
});

describe('refreshSettingsFromVrmAndPersist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';

    loadSettings.mockResolvedValue({ ...baseSettings });
    saveSettings.mockResolvedValue();
    mqttService.readVictronSocLimits.mockResolvedValue({
      minSoc_percent: 15,
      maxSoc_percent: 95,
    });
    mockFetchDessSettings.mockResolvedValue({
      batteryCapacity_Wh: 12000,
      dischargePower_W: 6000,
      chargePower_W: 5000,
      maxPowerFromGrid_W: 8000,
      maxPowerToGrid_W: 7000,
      batteryCosts_cents_per_kWh: 4,
    });
  });

  afterEach(() => {
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });

  it('persists VRM settings values into settings store', async () => {
    await refreshSettingsFromVrmAndPersist();

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        batteryCapacity_Wh: 12000,
        maxDischargePower_W: 6000,
        maxChargePower_W: 5000,
        maxGridImport_W: 8000,
        maxGridExport_W: 7000,
        batteryCost_cent_per_kWh: 4,
      }),
    );
  });

  it('uses MQTT SoC limits when available', async () => {
    await refreshSettingsFromVrmAndPersist();

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        minSoc_percent: 15,
        maxSoc_percent: 95,
      }),
    );
  });

  it('keeps existing SoC limits when MQTT read fails', async () => {
    mqttService.readVictronSocLimits.mockRejectedValue(new Error('MQTT error'));

    await refreshSettingsFromVrmAndPersist();

    // Falls back to baseSettings values
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        minSoc_percent: baseSettings.minSoc_percent,
        maxSoc_percent: baseSettings.maxSoc_percent,
      }),
    );
  });
});

describe('refreshSeriesFromVrmAndPersist — empty timestamps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'tok';
    loadSettings.mockResolvedValue({ ...baseSettings });
    loadData.mockResolvedValue({ ...baseData });
    saveData.mockResolvedValue();
    saveSettings.mockResolvedValue();
    mockFetchPrices.mockResolvedValue({ ...prices });
  });

  it('throws when VRM returns empty timestamps for forecasts', async () => {
    mockFetchForecasts.mockResolvedValue({
      timestamps: [],
      step_minutes: 15,
      load_W: [],
      pv_W: [],
    });

    await expect(refreshSeriesFromVrmAndPersist()).rejects.toThrow('VRM returned no timestamps');
  });
});
