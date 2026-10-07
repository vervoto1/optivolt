// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  checkPredictionSensors: vi.fn(),
}));

import { checkPredictionSensors } from '../../app/src/api/api.js';
import { renderSensorCheck, runSensorCheck, wireSensorCheck } from '../../app/src/predictions/sensor-check.js';

const SENSORS = [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }];
const DERIVED = [{ name: 'Load', formula: ['+Grid Import'] }];

function setupDom({ sensors = JSON.stringify(SENSORS), derived = JSON.stringify(DERIVED) } = {}) {
  document.body.innerHTML = `
    <textarea id="pred-sensors"></textarea>
    <textarea id="pred-derived"></textarea>
    <button id="pred-sensor-check" type="button"></button>
    <div id="pred-sensor-status"></div>
  `;
  document.getElementById('pred-sensors').value = sensors;
  document.getElementById('pred-derived').value = derived;
}

const ok = (overrides = {}) => ({
  id: 'sensor.grid', name: 'Grid Import', configuredUnit: 'kWh', status: 'ok', checked: true,
  state: '50740.8', unit: 'kWh', stateClass: 'total_increasing', messages: [], ...overrides,
});

function lines() {
  return [...document.querySelectorAll('#pred-sensor-status span')].map(el => ({ text: el.textContent, cls: el.className }));
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('prediction sensor check', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDom();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sends the editors’ current (unsaved) sensors and derived and renders each entity', async () => {
    checkPredictionSensors.mockResolvedValue({ reachable: true, sensors: [ok()], derived: [{ name: 'Load', status: 'ok', messages: [] }] });
    await runSensorCheck();
    expect(checkPredictionSensors).toHaveBeenCalledWith({ sensors: SENSORS, derived: DERIVED });
    expect(lines()).toEqual([
      { text: '✓ Grid Import (sensor.grid) = 50740.8 kWh', cls: expect.stringContaining('text-emerald-600') },
    ]);
  });

  it('shows per-entity errors and broken derived formulas in red, warnings in amber', () => {
    renderSensorCheck({
      reachable: true,
      sensors: [
        ok({ id: 'sensor.typo', status: 'error', state: null, unit: null, messages: ['not found in Home Assistant'] }),
        ok({ id: 'sensor.flaky', status: 'warning', state: 'unavailable', messages: ['current state is "unavailable", not a number'] }),
      ],
      derived: [{ name: 'Load', status: 'error', messages: ['term "-EV" matches no sensor name; it counts as 0'] }],
    });
    expect(lines()).toEqual([
      { text: '✗ Grid Import (sensor.typo): not found in Home Assistant', cls: expect.stringContaining('text-red-600') },
      { text: '! Grid Import (sensor.flaky) = unavailable kWh: current state is "unavailable", not a number', cls: expect.stringContaining('text-amber-600') },
      { text: '✗ Derived Load: term "-EV" matches no sensor name; it counts as 0', cls: expect.stringContaining('text-red-600') },
    ]);
  });

  it('warns — without blaming the sensors — when Home Assistant cannot be reached', () => {
    renderSensorCheck({ reachable: false, error: 'timed out', sensors: [ok({ checked: false, state: null, unit: null })], derived: [] });
    expect(lines()).toEqual([
      { text: expect.stringContaining('Could not reach Home Assistant to check the sensors (timed out). Saving is not affected.'), cls: expect.stringContaining('text-amber-600') },
      { text: 'Grid Import (sensor.grid): not checked', cls: expect.stringContaining('text-slate-500') },
    ]);
  });

  it('refuses to check invalid JSON and leaves the request unsent', async () => {
    setupDom({ sensors: '[{oops' });
    await runSensorCheck();
    expect(checkPredictionSensors).not.toHaveBeenCalled();
    expect(lines()[0].text).toContain('not valid JSON');
  });

  it('omits an empty editor so the server uses the stored list', async () => {
    setupDom({ derived: '' });
    checkPredictionSensors.mockResolvedValue({ reachable: true, sensors: [], derived: [] });
    await runSensorCheck();
    expect(checkPredictionSensors).toHaveBeenCalledWith({ sensors: SENSORS });
  });

  it('reports a failed request, except in quiet mode', async () => {
    checkPredictionSensors.mockRejectedValue(new Error('HTTP 500'));
    await runSensorCheck();
    expect(lines()[0].text).toBe('Sensor check failed: HTTP 500');

    document.getElementById('pred-sensor-status').replaceChildren();
    await runSensorCheck({ quiet: true });
    expect(lines()).toEqual([]);
  });

  it('paints no unreachable-HA warning in quiet mode', async () => {
    checkPredictionSensors.mockResolvedValue({
      reachable: false, error: 'Home Assistant connection is not configured', sensors: [], derived: [],
    });
    await runSensorCheck({ quiet: true });
    expect(lines()).toEqual([]);
    await runSensorCheck();
    expect(lines()[0].text).toContain('Could not reach Home Assistant');
  });

  it('sends nothing to HA when the form is wired (no check on page load)', async () => {
    wireSensorCheck();
    await Promise.resolve();
    expect(checkPredictionSensors).not.toHaveBeenCalled();
  });

  it('drops a reply for text that was edited while the check was in flight', async () => {
    wireSensorCheck();
    const pending = deferred();
    checkPredictionSensors.mockReset();
    checkPredictionSensors.mockReturnValueOnce(pending.promise);

    document.getElementById('pred-sensor-check').click();
    const sensors = document.getElementById('pred-sensors');
    sensors.value = JSON.stringify([{ id: 'sensor.new', name: 'Grid Import', unit: 'kWh' }]);
    sensors.dispatchEvent(new Event('input', { bubbles: true }));

    pending.resolve({ reachable: true, sensors: [ok()], derived: [] });
    await pending.promise;
    await Promise.resolve();
    expect(lines()).toEqual([]);
  });

  it('re-checks when an editor change is committed and on the button', async () => {
    checkPredictionSensors.mockResolvedValue({ reachable: true, sensors: [ok()], derived: [] });
    wireSensorCheck();

    document.getElementById('pred-derived').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('pred-sensor-check').click();
    await vi.waitFor(() => expect(checkPredictionSensors).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(lines()).toHaveLength(1));
  });

  it('does nothing without the status element', async () => {
    document.body.innerHTML = '';
    expect(await runSensorCheck()).toBeNull();
    renderSensorCheck({ reachable: true, sensors: [], derived: [] });
    wireSensorCheck();
    expect(checkPredictionSensors).not.toHaveBeenCalled();
  });
});
