// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { setupSettingsSubtabs } from '../../app/src/settings-subtabs.js';

function mountFullSubtabs() {
  document.body.innerHTML = `
    <button id="subtab-power" role="tab" aria-selected="true"></button>
    <button id="subtab-ev" role="tab" aria-selected="false"></button>
    <div id="settings-power"></div>
    <div id="settings-ev" class="hidden"></div>
  `;
  return {
    powerTab: document.getElementById('subtab-power'),
    evTab: document.getElementById('subtab-ev'),
    powerPanel: document.getElementById('settings-power'),
    evPanel: document.getElementById('settings-ev'),
  };
}

describe('setupSettingsSubtabs', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('activates Power settings and hides the EV sub-panel on init', () => {
    const els = mountFullSubtabs();

    setupSettingsSubtabs();

    expect(els.powerTab.getAttribute('aria-selected')).toBe('true');
    expect(els.evTab.getAttribute('aria-selected')).toBe('false');
    expect(els.powerPanel.classList.contains('hidden')).toBe(false);
    expect(els.evPanel.classList.contains('hidden')).toBe(true);
  });

  it('switches to the EV sub-panel on click and back again', () => {
    const els = mountFullSubtabs();
    setupSettingsSubtabs();

    els.evTab.click();
    expect(els.evTab.getAttribute('aria-selected')).toBe('true');
    expect(els.powerTab.getAttribute('aria-selected')).toBe('false');
    expect(els.evPanel.classList.contains('hidden')).toBe(false);
    expect(els.powerPanel.classList.contains('hidden')).toBe(true);

    els.powerTab.click();
    expect(els.powerTab.getAttribute('aria-selected')).toBe('true');
    expect(els.powerPanel.classList.contains('hidden')).toBe(false);
    expect(els.evPanel.classList.contains('hidden')).toBe(true);
  });

  it('marks exactly one sub-tab active after any switch', () => {
    const els = mountFullSubtabs();
    setupSettingsSubtabs();

    els.evTab.click();
    const active = [els.powerTab, els.evTab].filter(t => t.getAttribute('aria-selected') === 'true');
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(els.evTab);
  });

  it('is a no-op when no sub-tabs are present', () => {
    document.body.innerHTML = `<div></div>`;
    expect(() => setupSettingsSubtabs()).not.toThrow();
  });

  it('still activates the first sub-tab when only one is present', () => {
    document.body.innerHTML = `
      <button id="subtab-power"></button>
      <div id="settings-power"></div>
    `;
    const powerTab = document.getElementById('subtab-power');

    setupSettingsSubtabs();
    expect(powerTab.getAttribute('aria-selected')).toBe('true');
  });

  it('supports the Battery sub-tab as a third section', () => {
    document.body.innerHTML = `
      <button id="subtab-power" role="tab" aria-selected="true"></button>
      <button id="subtab-ev" role="tab" aria-selected="false"></button>
      <button id="subtab-battery" role="tab" aria-selected="false"></button>
      <div id="settings-power"></div>
      <div id="settings-ev" class="hidden"></div>
      <div id="settings-battery" class="hidden"></div>
    `;
    const batteryTab = document.getElementById('subtab-battery');
    const batteryPanel = document.getElementById('settings-battery');
    setupSettingsSubtabs();

    batteryTab.click();
    expect(batteryTab.getAttribute('aria-selected')).toBe('true');
    expect(batteryPanel.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('settings-power').classList.contains('hidden')).toBe(true);
  });
});
