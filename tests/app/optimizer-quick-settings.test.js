// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initOptimizerQuickSettings,
  normalizeQuickSettingIds,
  parseQuickSettingSelection,
  writeQuickSettingSelection,
} from '../../app/src/optimizer-quick-settings.js';

const definitions = [
  { id: 'minSoc_percent', selector: '#minsoc', label: 'Min SoC (%)', kind: 'number' },
  { id: 'mode', selector: '#mode', label: 'Mode', kind: 'select' },
  { id: 'blockFeedInOnNegativePrices', selector: '#block-feedin-negative-prices', label: 'Block feed-in', kind: 'checkbox' },
];

function setupDom(selection = '[]') {
  document.body.innerHTML = `
    <section id="optimizer-quick-settings" class="hidden">
      <div id="optimizer-quick-settings-body"></div>
      <input id="optimizer-quick-settings-selection" value='${selection}' />
    </section>
    <label class="text-sm">Min SoC (%)
      <input id="minsoc" type="number" class="form-input" value="20" min="0" max="100" />
    </label>
    <label class="text-sm">Mode
      <select id="mode" class="form-select">
        <option value="zero">zero</option>
        <option value="max">max</option>
      </select>
    </label>
    <label class="toggle">
      <input id="block-feedin-negative-prices" type="checkbox" />
      <span class="toggle-knob"></span>
      <span>Block feed-in</span>
    </label>
  `;

  return {
    body: document.querySelector('#optimizer-quick-settings-body'),
    section: document.querySelector('#optimizer-quick-settings'),
    selectionInput: document.querySelector('#optimizer-quick-settings-selection'),
  };
}

describe('optimizer quick settings', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('pins and unpins settings without triggering a recompute callback', () => {
    const els = setupDom();
    const onSelectionChange = vi.fn();
    const controller = initOptimizerQuickSettings({ ...els, definitions, onSelectionChange });

    document.querySelector('[data-quick-setting-pin="minSoc_percent"]').click();

    expect(controller.getSelectedIds()).toEqual(['minSoc_percent']);
    expect(JSON.parse(els.selectionInput.value)).toEqual(['minSoc_percent']);
    expect(els.section.classList.contains('hidden')).toBe(false);
    expect(els.body.querySelector('#optimizer-quick-minSoc_percent')).toBeTruthy();
    expect(onSelectionChange).toHaveBeenCalledWith(['minSoc_percent']);

    document.querySelector('[data-quick-setting-pin="minSoc_percent"]').click();

    expect(controller.getSelectedIds()).toEqual([]);
    expect(JSON.parse(els.selectionInput.value)).toEqual([]);
    expect(els.section.classList.contains('hidden')).toBe(true);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });

  it('places toggle pins after the toggle text', () => {
    const els = setupDom();
    initOptimizerQuickSettings({ ...els, definitions });

    const toggleLabel = document.querySelector('#block-feedin-negative-prices').closest('label');

    expect(toggleLabel.lastElementChild).toBe(document.querySelector('[data-quick-setting-pin="blockFeedInOnNegativePrices"]'));
  });

  it('can unpin a setting from its optimizer mirror', () => {
    const els = setupDom('["minSoc_percent"]');
    const onSelectionChange = vi.fn();
    const controller = initOptimizerQuickSettings({ ...els, definitions, onSelectionChange });

    document.querySelector('[data-quick-setting-unpin="minSoc_percent"]').click();

    expect(controller.getSelectedIds()).toEqual([]);
    expect(JSON.parse(els.selectionInput.value)).toEqual([]);
    expect(els.section.classList.contains('hidden')).toBe(true);
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it('syncs number, select, and checkbox mirrors in both directions', () => {
    const els = setupDom('["minSoc_percent","mode","blockFeedInOnNegativePrices"]');
    initOptimizerQuickSettings({ ...els, definitions });

    const minSoc = document.querySelector('#minsoc');
    const minSocMirror = document.querySelector('#optimizer-quick-minSoc_percent');
    const mode = document.querySelector('#mode');
    const modeMirror = document.querySelector('#optimizer-quick-mode');
    const block = document.querySelector('#block-feedin-negative-prices');
    const blockMirror = document.querySelector('#optimizer-quick-blockFeedInOnNegativePrices');

    minSocMirror.value = '35';
    minSocMirror.dispatchEvent(new Event('input', { bubbles: true }));
    expect(minSoc.value).toBe('35');

    modeMirror.value = 'max';
    modeMirror.dispatchEvent(new Event('change', { bubbles: true }));
    expect(mode.value).toBe('max');

    blockMirror.checked = true;
    blockMirror.dispatchEvent(new Event('change', { bubbles: true }));
    expect(block.checked).toBe(true);

    minSoc.value = '42';
    minSoc.dispatchEvent(new Event('input', { bubbles: true }));
    expect(minSocMirror.value).toBe('42');

    mode.value = 'zero';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modeMirror.value).toBe('zero');

    block.checked = false;
    block.dispatchEvent(new Event('change', { bubbles: true }));
    expect(blockMirror.checked).toBe(false);
  });

  it('routes mirror edits through the source input event path', () => {
    const els = setupDom('["minSoc_percent"]');
    initOptimizerQuickSettings({ ...els, definitions });

    const onInput = vi.fn();
    const minSoc = document.querySelector('#minsoc');
    const minSocMirror = document.querySelector('#optimizer-quick-minSoc_percent');
    minSoc.addEventListener('input', onInput);

    minSocMirror.value = '30';
    minSocMirror.dispatchEvent(new Event('input', { bubbles: true }));

    expect(minSoc.value).toBe('30');
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown saved IDs safely', () => {
    const els = setupDom('["missing","minSoc_percent","minSoc_percent"]');
    const controller = initOptimizerQuickSettings({ ...els, definitions });

    expect(controller.getSelectedIds()).toEqual(['minSoc_percent']);
    expect(JSON.parse(els.selectionInput.value)).toEqual(['minSoc_percent']);
    expect(els.body.querySelector('#optimizer-quick-missing')).toBeNull();
  });

  it('parses JSON and comma-separated selection values', () => {
    expect(parseQuickSettingSelection('["minSoc_percent","missing"]', definitions)).toEqual(['minSoc_percent']);
    expect(parseQuickSettingSelection('mode, missing, mode', definitions)).toEqual(['mode']);
  });

  it('updates the selection through the controller setSelectedIds method', () => {
    const els = setupDom();
    const onSelectionChange = vi.fn();
    const controller = initOptimizerQuickSettings({ ...els, definitions, onSelectionChange });

    // Default opts → no notification.
    controller.setSelectedIds(['minSoc_percent']);
    expect(controller.getSelectedIds()).toEqual(['minSoc_percent']);
    expect(JSON.parse(els.selectionInput.value)).toEqual(['minSoc_percent']);
    expect(els.body.querySelector('#optimizer-quick-minSoc_percent')).toBeTruthy();
    expect(onSelectionChange).not.toHaveBeenCalled();

    // Explicit notify → callback fires with the normalized ids.
    controller.setSelectedIds(['mode'], { notify: true });
    expect(controller.getSelectedIds()).toEqual(['mode']);
    expect(onSelectionChange).toHaveBeenCalledWith(['mode']);
  });

  it('reuses an existing pin button instead of creating a duplicate', () => {
    const els = setupDom();
    // Pre-seed the min-soc label with a pin button as if init had already run.
    const minSocLabel = document.querySelector('#minsoc').closest('label');
    const preExisting = document.createElement('button');
    preExisting.type = 'button';
    preExisting.dataset.quickSettingPin = 'minSoc_percent';
    minSocLabel.appendChild(preExisting);

    initOptimizerQuickSettings({ ...els, definitions });

    const pins = minSocLabel.querySelectorAll('[data-quick-setting-pin="minSoc_percent"]');
    expect(pins.length).toBe(1);
    expect(pins[0]).toBe(preExisting);
  });

  it('normalizes a direct array, dropping non-array, non-string, unknown, and duplicate ids', () => {
    expect(parseQuickSettingSelection(['minSoc_percent', 'mode', 'minSoc_percent'], definitions))
      .toEqual(['minSoc_percent', 'mode']);
    // Non-array input → [] inside normalizeQuickSettingIds.
    expect(normalizeQuickSettingIds(null, definitions)).toEqual([]);
    // Non-string entries are skipped.
    expect(normalizeQuickSettingIds([42, 'mode', null], definitions)).toEqual(['mode']);
  });

  it('writeQuickSettingSelection is a no-op without a selection input', () => {
    expect(() => writeQuickSettingSelection(null, ['minSoc_percent'], definitions)).not.toThrow();
  });

  it('uses the default no-op onSelectionChange when none is supplied', () => {
    const els = setupDom();
    const controller = initOptimizerQuickSettings({ ...els, definitions });
    // Pinning notifies; with no callback supplied the default () => {} runs without error.
    expect(() => document.querySelector('[data-quick-setting-pin="minSoc_percent"]').click()).not.toThrow();
    expect(controller.getSelectedIds()).toEqual(['minSoc_percent']);
  });

  it('resolves the owner document from body then selectionInput when section is absent', () => {
    setupDom();
    const body = document.querySelector('#optimizer-quick-settings-body');
    const selectionInput = document.querySelector('#optimizer-quick-settings-selection');
    // No section → falls through to body.ownerDocument.
    expect(() => initOptimizerQuickSettings({ body, selectionInput, definitions })).not.toThrow();
    // No section, no body → falls through to selectionInput.ownerDocument.
    expect(() => initOptimizerQuickSettings({ selectionInput, definitions })).not.toThrow();
  });

  it('falls back to the global document when no element is supplied', () => {
    // section/body/selectionInput all undefined → doc = global document.
    const controller = initOptimizerQuickSettings({ definitions });
    expect(controller.getSelectedIds()).toEqual([]);
  });

  it('does not render mirrors when body or section is missing', () => {
    const els = setupDom('["minSoc_percent"]');
    // No body/section → renderMirrors early-returns; selection still tracked.
    const controller = initOptimizerQuickSettings({ selectionInput: els.selectionInput, definitions });
    expect(controller.getSelectedIds()).toEqual(['minSoc_percent']);
  });

  it('skips a selected id whose source control is missing from the DOM', () => {
    // "mode" selector (#mode) is absent → no source control → mirror skipped.
    document.body.innerHTML = `
      <section id="optimizer-quick-settings" class="hidden">
        <div id="optimizer-quick-settings-body"></div>
        <input id="optimizer-quick-settings-selection" value='["minSoc_percent","mode"]' />
      </section>
      <label class="text-sm">Min SoC (%)
        <input id="minsoc" type="number" value="20" />
      </label>
    `;
    const els = {
      body: document.querySelector('#optimizer-quick-settings-body'),
      section: document.querySelector('#optimizer-quick-settings'),
      selectionInput: document.querySelector('#optimizer-quick-settings-selection'),
    };
    const controller = initOptimizerQuickSettings({ ...els, definitions });
    expect(controller.getSelectedIds()).toEqual(['minSoc_percent', 'mode']);
    expect(els.body.querySelector('#optimizer-quick-minSoc_percent')).toBeTruthy();
    // mode has no source control, so no mirror is rendered for it.
    expect(els.body.querySelector('#optimizer-quick-mode')).toBeNull();
  });

  it('ignores source input events for an unpinned control with no mirror', () => {
    const els = setupDom(); // nothing pinned → no mirrors exist
    initOptimizerQuickSettings({ ...els, definitions });
    const minSoc = document.querySelector('#minsoc');
    // syncMirrorFromSource finds no mirror → early-returns without throwing.
    expect(() => minSoc.dispatchEvent(new Event('input', { bubbles: true }))).not.toThrow();
  });

  it('labels a pin button "setting" when the definition has no label', () => {
    const noLabelDefs = [{ id: 'minSoc_percent', selector: '#minsoc', kind: 'number' }];
    const els = setupDom('["minSoc_percent"]');
    initOptimizerQuickSettings({ ...els, definitions: noLabelDefs });
    const pin = document.querySelector('[data-quick-setting-pin="minSoc_percent"]');
    expect(pin.getAttribute('aria-label')).toContain('setting');
    expect(pin.getAttribute('aria-pressed')).toBe('true');
  });

  it('skips installing a pin button when the source is not inside a label', () => {
    document.body.innerHTML = `
      <section id="optimizer-quick-settings" class="hidden">
        <div id="optimizer-quick-settings-body"></div>
        <input id="optimizer-quick-settings-selection" value='[]' />
      </section>
      <input id="minsoc" type="number" value="20" />
    `;
    const els = {
      body: document.querySelector('#optimizer-quick-settings-body'),
      section: document.querySelector('#optimizer-quick-settings'),
      selectionInput: document.querySelector('#optimizer-quick-settings-selection'),
    };
    const controller = initOptimizerQuickSettings({ ...els, definitions });

    // No label → no pin button rendered, but the control is still tracked.
    expect(document.querySelector('[data-quick-setting-pin="minSoc_percent"]')).toBeNull();
    controller.setSelectedIds(['minSoc_percent']);
    expect(els.body.querySelector('#optimizer-quick-minSoc_percent')).toBeTruthy();
  });
});
