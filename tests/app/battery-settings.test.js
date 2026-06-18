// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchBatteryStatus: vi.fn(),
}));

import { fetchBatteryStatus } from '../../app/src/api/api.js';
import { getElements } from '../../app/src/ui-binding.js';
import { hydrateUI, snapshotUI } from '../../app/src/state.js';
import { initBatterySettings, deactivateBatterySettings } from '../../app/src/battery-settings.js';

const flush = () => new Promise(r => setTimeout(r, 0));

const BATTERY_INPUTS = `
  <input type="checkbox" id="bcc-enabled">
  <input type="checkbox" id="bcc-dry-run">
  <input id="bcc-interval">
  <input id="bcc-emergency">
  <input id="bcc-reduce">
  <input id="bcc-restore">
  <input id="bcc-stabilization">
  <input id="bcc-levels">
  <div id="bcc-status"></div>
  <input type="checkbox" id="bbc-enabled">
  <input type="checkbox" id="bbc-dry-run">
  <input id="bbc-interval">
  <input id="bbc-high-current">
  <input id="bbc-tight-trigger">
  <input id="bbc-loose-trigger">
  <input id="bbc-step">
  <input id="bbc-top-cap">
  <input id="bbc-critical-high">
  <input id="bbc-top-start">
  <input id="bbc-bottom-top">
  <input id="bbc-bottom-floor">
  <input id="bbc-max-warn">
  <div id="bbc-status"></div>
`;

describe('battery settings — hydrate ↔ snapshot roundtrip', () => {
  beforeEach(() => { document.body.innerHTML = BATTERY_INPUTS; });

  it('roundtrips both controller configs through the DOM', () => {
    const els = getElements();
    const charge = {
      enabled: true, dryRun: false, controlIntervalSeconds: 45,
      emergencyVoltage: 3.6, reduceVoltage: 3.45, restoreVoltage: 3.35,
      stabilizationSeconds: 20, currentLevels: [300, 100, 0],
    };
    const balance = {
      enabled: true, dryRun: false, controlIntervalSeconds: 120,
      highCurrentThreshold_A: 40, tightTrigger: 0.004, looseTrigger: 0.03, step: 0.05,
      topCap: 3.5, criticalHighVoltage: 3.54, topStart: 3.44, bottomTop: 3.39,
      bottomFloor: 2.85, maxWarnVoltage: 3.62,
    };

    hydrateUI(els, { batteryChargeControl: charge, batteryBalanceControl: balance });
    const snap = snapshotUI(els);

    expect(snap.batteryChargeControl).toEqual(charge);
    expect(snap.batteryBalanceControl).toEqual(balance);
  });

  it('defaults the current-levels ladder when the field is empty', () => {
    const els = getElements();
    els.bccLevels.value = '';
    expect(snapshotUI(els).batteryChargeControl.currentLevels).toEqual([400, 180, 50, 0]);
  });
});

describe('battery settings — live status rendering', () => {
  beforeEach(() => { document.body.innerHTML = BATTERY_INPUTS; vi.clearAllMocks(); });
  afterEach(() => { deactivateBatterySettings(); });

  it('renders charge + balance status from GET /battery', async () => {
    fetchBatteryStatus.mockResolvedValue({
      charge: { enabled: true, dryRun: true, status: 'ok', commandedLevel: 180, maxCellVoltage: 3.42, reason: 'hold' },
      balance: { enabled: true, dryRun: false, batteries: [
        { name: 'B0', status: 'ok', startVoltage: 3.3, triggerVoltage: 0.02, reason: 'bottom', warning: false },
      ] },
    });

    initBatterySettings();
    await flush();

    const bcc = document.getElementById('bcc-status').textContent;
    expect(bcc).toContain('ok');
    expect(bcc).toContain('dry-run');
    expect(bcc).toContain('180A');
    expect(bcc).toContain('hold');

    const bbc = document.getElementById('bbc-status').textContent;
    expect(bbc).toContain('B0');
    expect(bbc).toContain('3.300V');
    expect(bbc).toContain('bottom');
  });

  it('shows "disabled" when a controller is off', async () => {
    fetchBatteryStatus.mockResolvedValue({
      charge: { enabled: false },
      balance: { enabled: false },
    });
    initBatterySettings();
    await flush();
    expect(document.getElementById('bcc-status').textContent).toContain('disabled');
    expect(document.getElementById('bbc-status').textContent).toContain('disabled');
  });

  it('shows "no BMS data yet" when balance is enabled but has no batteries', async () => {
    fetchBatteryStatus.mockResolvedValue({
      // commandedLevel null, no reason → exercises the "—" fallbacks in renderCharge.
      charge: { enabled: true, dryRun: false, status: 'idle', commandedLevel: null, maxCellVoltage: 'n/a' },
      // batteries missing entirely → rows defaults to [] → "no BMS data yet".
      balance: { enabled: true, dryRun: true },
    });
    initBatterySettings();
    await flush();

    const bcc = document.getElementById('bcc-status').textContent;
    expect(bcc).toContain('(live)');
    expect(bcc).toContain('level —');
    expect(bcc).toContain('maxV —');

    const bbc = document.getElementById('bbc-status').textContent;
    expect(bbc).toContain('no BMS data yet');
    expect(bbc).toContain('(dry-run)');
  });

  it('renders a per-BMS warning marker and falls back when reason is missing', async () => {
    fetchBatteryStatus.mockResolvedValue({
      charge: { enabled: true, dryRun: false, status: 'ok', commandedLevel: 100, maxCellVoltage: 3.5, reason: null, warning: false },
      balance: { enabled: true, dryRun: false, batteries: [
        { name: 'B1', status: 'warn', startVoltage: 3.4, triggerVoltage: 0.01, reason: null, warning: true },
      ] },
    });
    initBatterySettings();
    await flush();

    // reason null → renderCharge uses status as the trailing fallback.
    const bcc = document.getElementById('bcc-status').textContent;
    expect(bcc.endsWith('ok')).toBe(true);

    const bbc = document.getElementById('bbc-status').textContent;
    expect(bbc).toContain('⚠');
    expect(bbc).toContain('B1: warn');
  });

  it('leaves the last status in place when the fetch rejects', async () => {
    document.getElementById('bcc-status').textContent = 'Status: previous';
    fetchBatteryStatus.mockRejectedValue(new Error('HA hiccup'));
    initBatterySettings();
    await flush();
    expect(document.getElementById('bcc-status').textContent).toBe('Status: previous');
  });

  it('does nothing when neither status placeholder is present', async () => {
    document.body.innerHTML = '';
    initBatterySettings();
    await flush();
    expect(fetchBatteryStatus).not.toHaveBeenCalled();
  });

  it('renders only balance when the charge placeholder is absent', async () => {
    document.getElementById('bcc-status').remove();
    fetchBatteryStatus.mockResolvedValue({
      charge: { enabled: true, dryRun: false, status: 'ok' },
      balance: { enabled: false },
    });
    initBatterySettings();
    await flush();
    // renderCharge(null, ...) early-returns; balance still renders.
    expect(document.getElementById('bcc-status')).toBeNull();
    expect(document.getElementById('bbc-status').textContent).toContain('disabled');
  });

  it('renders only charge when the balance placeholder is absent', async () => {
    document.getElementById('bbc-status').remove();
    fetchBatteryStatus.mockResolvedValue({
      // Both reason and status falsy → renderCharge uses the "—" fallback.
      charge: { enabled: true, dryRun: false, status: '', commandedLevel: 50, maxCellVoltage: 3.4, reason: '' },
      balance: { enabled: true, dryRun: false, batteries: [] },
    });
    initBatterySettings();
    await flush();
    expect(document.getElementById('bbc-status')).toBeNull();
    const bcc = document.getElementById('bcc-status').textContent;
    expect(bcc).toContain('50A');
    expect(bcc.endsWith('· —')).toBe(true);
  });

  it('keeps polling on the interval', async () => {
    vi.useFakeTimers();
    try {
      fetchBatteryStatus.mockResolvedValue({ charge: { enabled: false }, balance: { enabled: false } });
      initBatterySettings();
      expect(fetchBatteryStatus).toHaveBeenCalledTimes(1); // immediate poll
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchBatteryStatus).toHaveBeenCalledTimes(2); // interval-driven poll
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchBatteryStatus).toHaveBeenCalledTimes(3);
    } finally {
      deactivateBatterySettings();
      vi.useRealTimers();
    }
  });
});
