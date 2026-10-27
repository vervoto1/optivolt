// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchHaEntityState: vi.fn(),
}));

import { fetchHaEntityState } from '../../app/src/api/api.js';
import {
  refreshEvSensorStates,
  wireEvSensorInputs,
} from '../../app/src/ev-settings.js';

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

function setupEls() {
  document.body.innerHTML = `
    <input id="ev-departure-time" />
    <button id="ev-departure-quick-set" type="button"></button>
    <input id="ev-target-soc" />
    <button id="ev-target-soc-quick-set" type="button"></button>
    <input id="ev-soc-sensor" />
    <input id="ev-plug-sensor" />
    <span id="ev-soc-value"></span>
    <span id="ev-plug-value"></span>
    <input id="ev-target-soc-entity" />
    <span id="ev-target-soc-entity-value"></span>
    <input id="ev-charger-switch-entity" />
    <span id="ev-charger-switch-value"></span>
    <input id="ev-charger-current-entity" />
    <span id="ev-charger-current-value"></span>
  `;
  return {
    evDepartureTime: document.getElementById('ev-departure-time'),
    evDepartureQuickSet: document.getElementById('ev-departure-quick-set'),
    evTargetSoc: document.getElementById('ev-target-soc'),
    evTargetSocQuickSet: document.getElementById('ev-target-soc-quick-set'),
    evSocSensor: document.getElementById('ev-soc-sensor'),
    evPlugSensor: document.getElementById('ev-plug-sensor'),
    evSocValue: document.getElementById('ev-soc-value'),
    evPlugValue: document.getElementById('ev-plug-value'),
    evTargetSocEntity: document.getElementById('ev-target-soc-entity'),
    evTargetSocEntityValue: document.getElementById('ev-target-soc-entity-value'),
    evChargerSwitchEntity: document.getElementById('ev-charger-switch-entity'),
    evChargerSwitchValue: document.getElementById('ev-charger-switch-value'),
    evChargerCurrentEntity: document.getElementById('ev-charger-current-entity'),
    evChargerCurrentValue: document.getElementById('ev-charger-current-value'),
  };
}

describe('EV settings wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2099, 0, 1, 10, 7));
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('refreshes HA sensor values and pulls the car charge limit into Target SoC', async () => {
    const els = setupEls();
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evPlugSensor.value = 'binary_sensor.ev_plug';
    els.evTargetSocEntity.value = 'number.tesla_charge_limit';
    els.evTargetSoc.value = '80';
    const states = {
      'sensor.ev_soc': '85',
      'binary_sensor.ev_plug': 'on',
      'number.tesla_charge_limit': '100',
    };
    fetchHaEntityState.mockImplementation(async (id) => ({ state: states[id] }));
    const onInput = vi.fn();
    els.evTargetSoc.addEventListener('input', onInput);

    await refreshEvSensorStates(els);

    expect(els.evSocValue.textContent).toBe('Current value: 85');
    expect(els.evPlugValue.textContent).toBe('Current value: on');
    expect(els.evTargetSocEntityValue.textContent).toBe('Current value: 100');
    // The charge limit, not the battery level, and saved like a user edit.
    expect(els.evTargetSoc.value).toBe('100');
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(els.evTargetSocQuickSet.disabled).toBe(false);
    expect(els.evTargetSocQuickSet.title).toBe("Set to the car's charge limit (100%)");

    // Unchanged limit on the next refresh: no extra save/solve.
    await refreshEvSensorStates(els);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('quick-set re-reads the charge limit and loads it, even into a focused field', async () => {
    vi.useRealTimers();
    const els = setupEls();
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evTargetSocEntity.value = 'number.tesla_charge_limit';
    const states = { 'sensor.ev_soc': '85', 'number.tesla_charge_limit': '90' };
    fetchHaEntityState.mockImplementation(async (id) => ({ state: states[id] }));
    await refreshEvSensorStates(els);
    expect(els.evTargetSoc.value).toBe('90');

    // User is typing in the field when the limit changes in the car app:
    // a background refresh leaves the field alone…
    els.evTargetSoc.focus();
    els.evTargetSoc.value = '7';
    states['number.tesla_charge_limit'] = '70';
    await refreshEvSensorStates(els);
    expect(els.evTargetSoc.value).toBe('7');

    // …but the button reads the car again and loads its limit.
    states['number.tesla_charge_limit'] = '75';
    els.evTargetSocQuickSet.click();
    await flushPromises();
    expect(fetchHaEntityState).toHaveBeenLastCalledWith('number.tesla_charge_limit');
    expect(els.evTargetSoc.value).toBe('75');
  });

  it.each(['unavailable', 'unknown', '0'])('keeps Target SoC and disables quick-set when the limit reads %s', async (state) => {
    const els = setupEls();
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evTargetSocEntity.value = 'number.tesla_charge_limit';
    els.evTargetSoc.value = '80';
    fetchHaEntityState.mockImplementation(async (id) => ({ state: id === 'sensor.ev_soc' ? '85' : state }));

    await refreshEvSensorStates(els);

    expect(els.evTargetSoc.value).toBe('80');
    expect(els.evTargetSocQuickSet.disabled).toBe(true);
    expect(els.evTargetSocQuickSet.title).toBe("Configure the car's charge-limit entity first");
  });

  it('never loads the battery level when no charge-limit entity is configured', async () => {
    const els = setupEls();
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evTargetSoc.value = '80';
    fetchHaEntityState.mockResolvedValue({ state: '85' });

    await refreshEvSensorStates(els);
    els.evTargetSocQuickSet.click();

    expect(els.evTargetSocQuickSet.disabled).toBe(true);
    expect(els.evTargetSoc.value).toBe('80');
  });

  it('loads the charge limit as soon as the entity is entered', async () => {
    vi.useRealTimers();
    const els = setupEls();
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });
    fetchHaEntityState.mockResolvedValue({ state: '90' });
    els.evTargetSoc.value = '80';

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evTargetSocEntity.value = 'number.tesla_charge_limit';
    els.evTargetSocEntity.dispatchEvent(new Event('blur'));
    await flushPromises();

    expect(els.evTargetSoc.value).toBe('90');
    expect(els.evTargetSocQuickSet.disabled).toBe(false);

    // Editing the entity id again drops the reading and disables the button.
    els.evTargetSocEntity.dispatchEvent(new Event('input'));
    expect(els.evTargetSocQuickSet.disabled).toBe(true);
  });

  it('shows live values for the actuation charger entities too', async () => {
    const els = setupEls();
    els.evChargerSwitchEntity.value = 'switch.tesla_charging';
    els.evChargerCurrentEntity.value = 'number.tesla_charging_amps';
    fetchHaEntityState.mockImplementation((id) =>
      Promise.resolve({ state: id === 'switch.tesla_charging' ? 'on' : '16' }));

    await refreshEvSensorStates(els);

    expect(fetchHaEntityState).toHaveBeenCalledWith('switch.tesla_charging');
    expect(fetchHaEntityState).toHaveBeenCalledWith('number.tesla_charging_amps');
    expect(els.evChargerSwitchValue.textContent).toBe('Current value: on');
    expect(els.evChargerCurrentValue.textContent).toBe('Current value: 16');
  });

  it('validates a non-SoC entity on blur without enabling SoC quick-set', async () => {
    vi.useRealTimers();
    const els = setupEls();
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });
    fetchHaEntityState.mockResolvedValue({ state: '16' });

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evChargerCurrentEntity.value = 'number.tesla_charging_amps';
    els.evChargerCurrentEntity.dispatchEvent(new Event('blur'));
    await flushPromises();

    expect(persistConfig).toHaveBeenCalledTimes(1);
    expect(fetchHaEntityState).toHaveBeenCalledWith('number.tesla_charging_amps');
    expect(els.evChargerCurrentValue.textContent).toBe('Current value: 16');
    // SoC readout (and therefore the SoC quick-set) is untouched by an unrelated entity.
    expect(els.evSocValue.textContent).toBe('');
  });

  it('flushes settings before validating a sensor on blur', async () => {
    vi.useRealTimers();
    const els = setupEls();
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });
    fetchHaEntityState.mockResolvedValue({ state: '61' });

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evSocSensor.dispatchEvent(new Event('blur'));
    await flushPromises();

    expect(persistConfigDebounced.cancel).toHaveBeenCalledTimes(1);
    expect(debounceRun.cancel).toHaveBeenCalledTimes(1);
    expect(persistConfig).toHaveBeenCalledTimes(1);
    expect(fetchHaEntityState).toHaveBeenCalledWith('sensor.ev_soc');
    expect(els.evSocValue.textContent).toBe('Current value: 61');
    expect(els.evSocValue.dataset.haState).toBe('61');

    els.evSocSensor.dispatchEvent(new Event('input'));
    expect(els.evSocValue.textContent).toBe('');
    expect(els.evSocValue.dataset.haState).toBeUndefined();
  });

  it('clears the readout and skips validation when the entity is blanked on blur', async () => {
    vi.useRealTimers();
    const els = setupEls();
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evSocValue.textContent = 'Current value: stale';
    els.evSocSensor.value = '   ';
    els.evSocSensor.dispatchEvent(new Event('blur'));
    await flushPromises();

    expect(els.evSocValue.textContent).toBe('');
    expect(persistConfig).not.toHaveBeenCalled();
    expect(fetchHaEntityState).not.toHaveBeenCalled();
  });

  it('renders the error and clears haState when validation fails on blur', async () => {
    vi.useRealTimers();
    const els = setupEls();
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });
    fetchHaEntityState.mockRejectedValue(new Error('entity not found'));

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evTargetSocEntityValue.dataset.haState = '90';
    els.evTargetSocQuickSet.disabled = false;
    els.evTargetSocEntity.value = 'number.missing';
    els.evTargetSocEntity.dispatchEvent(new Event('blur'));
    await flushPromises();

    expect(persistConfig).toHaveBeenCalledTimes(1);
    expect(els.evTargetSocEntityValue.textContent).toBe('Error: entity not found');
    expect(els.evTargetSocEntityValue.className).toContain('text-red-600');
    expect(els.evTargetSocEntityValue.dataset.haState).toBeUndefined();
    // afterUpdate ran on the error path: the quick-set is disabled again.
    expect(els.evTargetSocQuickSet.disabled).toBe(true);
  });

  it('discards a stale blur whose fetch resolves after a newer blur started', async () => {
    vi.useRealTimers();
    const els = setupEls();
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });

    // First blur's fetch is held open; second blur resolves first and bumps seq.
    let releaseStale;
    const stalePromise = new Promise((resolve) => { releaseStale = resolve; });
    fetchHaEntityState
      .mockImplementationOnce(() => stalePromise)
      .mockResolvedValueOnce({ state: '88' });

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evSocSensor.value = 'sensor.ev_soc';

    els.evSocSensor.dispatchEvent(new Event('blur')); // id=1, fetch pending
    await flushPromises();
    els.evSocSensor.dispatchEvent(new Event('blur')); // id=2, resolves to 88
    await flushPromises();
    expect(els.evSocValue.textContent).toBe('Current value: 88');

    releaseStale({ state: '11' }); // stale id=1 now resolves; must be ignored
    await flushPromises();
    expect(els.evSocValue.textContent).toBe('Current value: 88');
  });

  it('discards a stale blur whose fetch rejects after a newer blur started', async () => {
    vi.useRealTimers();
    const els = setupEls();
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });

    let rejectStale;
    const stalePromise = new Promise((_resolve, reject) => { rejectStale = reject; });
    fetchHaEntityState
      .mockImplementationOnce(() => stalePromise)
      .mockResolvedValueOnce({ state: '88' });

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evSocSensor.value = 'sensor.ev_soc';

    els.evSocSensor.dispatchEvent(new Event('blur')); // id=1, fetch pending
    await flushPromises();
    els.evSocSensor.dispatchEvent(new Event('blur')); // id=2, resolves to 88
    await flushPromises();
    expect(els.evSocValue.textContent).toBe('Current value: 88');

    rejectStale(new Error('stale failure')); // stale id=1 rejects; must be ignored
    await flushPromises();
    expect(els.evSocValue.textContent).toBe('Current value: 88');
  });

  it('aborts a stale blur at the persist step when a newer blur supersedes it', async () => {
    vi.useRealTimers();
    const els = setupEls();
    // Hold the first blur open inside `await persistConfig()`.
    let releasePersist;
    const persistConfig = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releasePersist = resolve; }))
      .mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });
    fetchHaEntityState.mockResolvedValue({ state: '88' });

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evSocSensor.value = 'sensor.ev_soc';

    els.evSocSensor.dispatchEvent(new Event('blur')); // id=1, paused at persistConfig
    await flushPromises();
    els.evSocSensor.dispatchEvent(new Event('blur')); // id=2, bumps seq, resolves to 88
    await flushPromises();
    expect(els.evSocValue.textContent).toBe('Current value: 88');

    releasePersist(); // id=1 resumes; id !== seq → returns before fetching.
    await flushPromises();
    // Stale blur never issued a third fetch (only the live blur fetched once).
    expect(fetchHaEntityState).toHaveBeenCalledTimes(1);
    expect(els.evSocValue.textContent).toBe('Current value: 88');
  });

  it('still syncs Target SoC when the quick-set button element is absent', async () => {
    const els = setupEls();
    els.evTargetSocQuickSet = null; // applyCarChargeLimit must skip the button safely.
    els.evTargetSocEntity.value = 'number.tesla_charge_limit';
    fetchHaEntityState.mockResolvedValue({ state: '50' });

    // Should not throw despite the missing button.
    await expect(refreshEvSensorStates(els)).resolves.toBeUndefined();
    expect(els.evTargetSoc.value).toBe('50');
  });

  it('skips wiring a sensor entry whose indicator element is missing', () => {
    const els = setupEls();
    els.evSocValue = null; // first entry has no indicator → continue past it.
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });

    // No throw, and the entry with no indicator gets no listeners.
    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evSocSensor.dispatchEvent(new Event('input'));
    expect(fetchHaEntityState).not.toHaveBeenCalled();
  });
});
