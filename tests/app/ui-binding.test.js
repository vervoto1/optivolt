// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getElements, wireGlobalInputs, wireVrmSettingInput } from '../../app/src/ui-binding.js';

function createEl(tag, id, attrs = {}) {
  const el = document.createElement(tag);
  el.id = id;
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  document.body.appendChild(el);
  return el;
}

describe('ui-binding', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('getElements', () => {
    it('returns object with element references', () => {
      createEl('button', 'run');
      createEl('input', 'step');
      createEl('input', 'cap');
      createEl('select', 'source-prices');
      createEl('input', 'ev-enabled');
      createEl('input', 'cv-enabled');
      createEl('input', 'auto-calc-enabled');
      createEl('input', 'dess-refresh-enabled');
      createEl('input', 'ha-price-sensor');

      const els = getElements();
      expect(els.run).toBeTruthy();
      expect(els.step).toBeTruthy();
      expect(els.cap).toBeTruthy();
      expect(els.sourcePrices).toBeTruthy();
      expect(els.evEnabled).toBeTruthy();
    });

    it('returns null for missing elements', () => {
      const els = getElements();
      expect(els.run).toBeNull();
      expect(els.step).toBeNull();
    });
  });

  describe('wireGlobalInputs', () => {
    it('wires input/change events on inputs and selects', () => {
      const input1 = createEl('input', 'test-input', { 'data-settings-input': '' });
      const select1 = createEl('select', 'test-select', { 'data-settings-input': '' });
      const tableKwh = createEl('input', 'table-kwh');
      const updateData = createEl('input', 'update-data-before-run');
      const pushVictron = createEl('input', 'push-to-victron');
      const predOnly = createEl('input', 'pred-input');
      predOnly.dataset.predictionsOnly = 'true';

      const onInput = vi.fn();
      const onRun = vi.fn();
      const updateTerminalCustomUI = vi.fn();

      const els = {
        tableKwh,
        updateDataBeforeRun: updateData,
        pushToVictron: pushVictron,
        run: createEl('button', 'run'),
        terminal: createEl('select', 'terminal'),
      };

      wireGlobalInputs(els, { onInput, onRun, updateTerminalCustomUI });

      // input event on normal input should fire onInput
      input1.dispatchEvent(new Event('input'));
      expect(onInput).toHaveBeenCalled();

      // change event on select should fire onInput
      select1.dispatchEvent(new Event('change'));
      expect(onInput).toHaveBeenCalledTimes(2);

      // tableKwh change should fire onRun
      tableKwh.dispatchEvent(new Event('change'));
      expect(onRun).toHaveBeenCalled();

      // run button click
      els.run.click();
      expect(onRun).toHaveBeenCalledTimes(2);

      // terminal change should call updateTerminalCustomUI
      expect(updateTerminalCustomUI).toHaveBeenCalled(); // called once on init
    });

    it('handles Ctrl+Enter keyboard shortcut', () => {
      const run = createEl('button', 'run');
      run.focus = vi.fn();
      run.click = vi.fn();

      wireGlobalInputs(
        { run, tableKwh: null, updateDataBeforeRun: null, pushToVictron: null },
        { onInput: vi.fn(), onRun: vi.fn(), updateTerminalCustomUI: vi.fn() },
      );

      const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true });
      event.preventDefault = vi.fn();
      document.dispatchEvent(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(run.focus).toHaveBeenCalled();
      expect(run.click).toHaveBeenCalled();
    });

    it('handles Cmd+Enter keyboard shortcut', () => {
      const run = createEl('button', 'run2');
      run.focus = vi.fn();
      run.click = vi.fn();

      wireGlobalInputs(
        { run, tableKwh: null, updateDataBeforeRun: null, pushToVictron: null },
        { onInput: vi.fn(), onRun: vi.fn(), updateTerminalCustomUI: vi.fn() },
      );

      const event = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true });
      event.preventDefault = vi.fn();
      document.dispatchEvent(event);

      expect(run.focus).toHaveBeenCalled();
    });

    it('skips quick-mirror inputs and routes data-no-autosolve inputs to onSave', () => {
      // Normal autosolve input -> onInput.
      const normal = createEl('input', 'norm', { 'data-settings-input': '' });
      // Mirror input -> skipped entirely (no listeners wired).
      const mirror = createEl('input', 'mirror', { 'data-settings-input': '' });
      mirror.dataset.optimizerQuickMirror = 'true';
      // Save-only input -> onSave, never onInput.
      const saveOnly = createEl('input', 'save-only', {
        'data-settings-input': '', 'data-no-autosolve': '',
      });

      const onInput = vi.fn();
      const onSave = vi.fn();

      wireGlobalInputs(
        { run: null, tableKwh: null, updateDataBeforeRun: null, pushToVictron: null, terminal: null },
        { onInput, onSave, onRun: vi.fn(), updateTerminalCustomUI: vi.fn() },
      );

      normal.dispatchEvent(new Event('input'));
      expect(onInput).toHaveBeenCalledTimes(1);

      // Mirror input fires events but has no wired listeners.
      mirror.dispatchEvent(new Event('input'));
      mirror.dispatchEvent(new Event('change'));
      expect(onInput).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();

      // Save-only input routes to onSave, not onInput.
      saveOnly.dispatchEvent(new Event('change'));
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onInput).toHaveBeenCalledTimes(1);
    });

    it('wires the flows aggregation change handler when provided', () => {
      const flows15m = createEl('input', 'flows-15m');
      const onFlowsAggregationChange = vi.fn();

      wireGlobalInputs(
        { run: null, tableKwh: null, updateDataBeforeRun: null, pushToVictron: null, terminal: null, flows15m },
        { onInput: vi.fn(), onRun: vi.fn(), updateTerminalCustomUI: vi.fn(), onFlowsAggregationChange },
      );

      flows15m.dispatchEvent(new Event('change'));
      expect(onFlowsAggregationChange).toHaveBeenCalledTimes(1);
    });

    it('ignores Enter without modifier', () => {
      const run = createEl('button', 'run3');
      run.click = vi.fn();

      wireGlobalInputs(
        { run, tableKwh: null, updateDataBeforeRun: null, pushToVictron: null },
        { onInput: vi.fn(), onRun: vi.fn(), updateTerminalCustomUI: vi.fn() },
      );

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(run.click).not.toHaveBeenCalled();
    });
  });

  describe('wireVrmSettingInput', () => {
    it('wires click on vrmFetchSettings button', () => {
      const btn = createEl('button', 'vrm-fetch-settings');
      const onRefresh = vi.fn();
      wireVrmSettingInput({ vrmFetchSettings: btn }, { onRefresh });

      btn.click();
      expect(onRefresh).toHaveBeenCalled();
    });

    it('handles null vrmFetchSettings element', () => {
      wireVrmSettingInput({ vrmFetchSettings: null }, { onRefresh: vi.fn() });
      // no error
    });
  });
});
