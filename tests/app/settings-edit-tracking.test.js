// @vitest-environment jsdom
// Saves send only the settings keys the user edited, and an edit is found by
// mapping the edited control to the keys read from it. A setting whose
// control maps to no key would never be saved, so check every one on the
// real page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getElements, wireGlobalInputs } from '../../app/src/ui-binding.js';
import { hydrateSettingsKeys, hydrateUI, settingsKeysForElement, snapshotUI } from '../../app/src/state.js';
import { createOptimizerController } from '../../app/src/optimizer-controller.js';
import { initOptimizerQuickSettings } from '../../app/src/optimizer-quick-settings.js';

// Controls that save through their own handler rather than the
// data-settings-input wiring: the kWh table toggle (onTableDisplayChange)
// and the hidden quick-settings selection (written by the pin buttons).
const OWN_SAVE_TRIGGER = new Set(['tableKwh', 'optimizerQuickSettingsSelection']);

function controllerFor(els, services = {}) {
  const saveConfig = vi.fn(async (patch) => ({ settings: patch }));
  const controller = createOptimizerController({
    els,
    services: {
      debounce: (fn) => Object.assign((...args) => fn(...args), { cancel() {} }),
      saveConfig,
      requestRemoteSolve: vi.fn().mockResolvedValue({ rows: [], summary: {} }),
      ...services,
    },
  });
  controller.trackSettingsEdits(document);
  return { controller, saveConfig };
}

function loadPage() {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../app/index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  return getElements();
}

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('settings edit tracking on the real page', () => {
  it('maps a control on the page to every saved settings key', () => {
    const els = loadPage();
    els.haToken.value = 'token'; // write-only: only in the snapshot when typed
    const savedKeys = Object.keys(snapshotUI(els));

    const tracked = new Set();
    for (const el of Object.values(els)) {
      for (const key of settingsKeysForElement(els, el)) tracked.add(key);
    }

    expect(savedKeys.length).toBeGreaterThan(50);
    expect(savedKeys.filter((key) => !tracked.has(key))).toEqual([]);
  });

  it('wires every settings control to a save', () => {
    const els = loadPage();
    const unwired = [];
    for (const [name, el] of Object.entries(els)) {
      if (!el || OWN_SAVE_TRIGGER.has(name)) continue;
      if (settingsKeysForElement(els, el).length === 0) continue;
      if (!el.hasAttribute('data-settings-input')) unwired.push(name);
    }
    expect(unwired).toEqual([]);
  });

  it('switching auto-calculate "Write to Victron" off saves that key alone, without a solve', async () => {
    const els = loadPage();
    hydrateUI(els, { autoCalculate: { enabled: true, intervalMinutes: 15, updateData: true, writeToVictron: true } });
    const { controller, saveConfig } = controllerFor(els);
    const onInput = vi.fn();
    wireGlobalInputs(els, {
      onInput,
      onSave: controller.queuePersistSnapshot,
      onRun: vi.fn(),
      updateTerminalCustomUI: () => {},
    });

    els.autoCalcWriteVictron.click();

    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalled());
    expect(saveConfig.mock.calls[0][0]).toEqual({
      autoCalculate: { enabled: true, intervalMinutes: 15, updateData: true, writeToVictron: false },
    });
    expect(onInput).not.toHaveBeenCalled(); // data-no-autosolve: no re-solve
  });

  it('a pinned quick-settings copy shows the value the server stored', async () => {
    const els = loadPage();
    hydrateUI(els, { maxDischargePower_W: 4000, optimizerQuickSettings: ['maxDischargePower_W'] });
    let quick = null;
    const { controller } = controllerFor(els, {
      saveConfig: vi.fn(async (patch) => ({
        settings: { ...patch, maxDischargePower_W: Math.round(patch.maxDischargePower_W) },
      })),
      onSettingsRehydrated: () => quick.syncMirrors(),
    });
    quick = initOptimizerQuickSettings({
      selectionInput: els.optimizerQuickSettingsSelection,
      section: els.optimizerQuickSettingsSection,
      body: els.optimizerQuickSettingsBody,
    });
    const mirror = document.getElementById('optimizer-quick-maxDischargePower_W');
    expect(mirror).not.toBeNull();

    mirror.value = '4000.6';
    mirror.dispatchEvent(new Event('input', { bubbles: true }));
    expect(els.pdis.value).toBe('4000.6');
    await controller.persistConfig();

    expect(els.pdis.value).toBe('4001');
    expect(mirror.value).toBe('4001');
  });

  it('a focused pinned copy is refilled when the user leaves it', async () => {
    const els = loadPage();
    hydrateUI(els, { maxDischargePower_W: 4000, optimizerQuickSettings: ['maxDischargePower_W'] });
    let quick = null;
    const { controller } = controllerFor(els, { onSettingsRehydrated: () => quick.syncMirrors() });
    quick = initOptimizerQuickSettings({
      selectionInput: els.optimizerQuickSettingsSelection,
      section: els.optimizerQuickSettingsSection,
      body: els.optimizerQuickSettingsBody,
    });
    const mirror = document.getElementById('optimizer-quick-maxDischargePower_W');

    mirror.focus();
    controller.hydrateServerSettings({ maxDischargePower_W: 15000 }); // e.g. a VRM refresh
    expect(els.pdis.value).toBe('4000');
    expect(mirror.value).toBe('4000');

    mirror.blur();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(els.pdis.value).toBe('15000');
    expect(mirror.value).toBe('15000');
  });

  it('maps a control only to the keys read from it', () => {
    const els = loadPage();
    expect(settingsKeysForElement(els, els.rebalanceEnabled)).toEqual(['rebalanceEnabled']);
    expect(settingsKeysForElement(els, els.bccLevels)).toEqual(['batteryChargeControl']);
    expect(settingsKeysForElement(els, els.run)).toEqual([]);
    expect(settingsKeysForElement(els, null)).toEqual([]);
  });

  it('hydrates only the controls of the given keys', () => {
    const els = loadPage();
    els.pdis.value = '1';
    els.cap.value = '2';
    els.planSocNow.textContent = '55';

    hydrateSettingsKeys(els, { maxDischargePower_W: 4001, batteryCapacity_Wh: 30000 }, ['maxDischargePower_W']);

    expect(els.pdis.value).toBe('4001');
    expect(els.cap.value).toBe('2');
    expect(els.planSocNow.textContent).toBe('55');
  });
});
