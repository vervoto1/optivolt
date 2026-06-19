// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ev-tab.js imports charts.js + state.js at module load; stub them so the module
// loads cleanly in jsdom, and mock the API client so we drive the override calls.
vi.mock('../../app/src/charts.js', () => ({
  SOLUTION_COLORS: {},
  toRGBA: (rgb) => rgb,
  drawEvPowerChart: vi.fn(),
  drawEvSocChartTab: vi.fn(),
}));
vi.mock('../../app/src/state.js', () => ({
  formatKWh: (v) => `${v}`,
  updateStackedBarContainer: vi.fn(),
}));
vi.mock('../../app/src/api/api.js', () => ({
  fetchEvStatus: vi.fn(async () => ({ mode: 'idle' })),
  fetchEvOverride: vi.fn(async () => ({ mode: 'auto' })),
  setEvOverride: vi.fn(async (mode) => ({ mode })),
}));

import { wireEvOverrideControls, refreshEvOverrideState } from '../../app/src/ev-tab.js';
import { fetchEvOverride, setEvOverride } from '../../app/src/api/api.js';

const flush = () => new Promise((r) => setTimeout(r));

function makeEls() {
  const btn = (mode) => {
    const b = document.createElement('button');
    b.dataset.override = mode;
    return b;
  };
  return {
    evOverrideControls: document.createElement('div'),
    evOverrideHint: document.createElement('span'),
    evOverrideAuto: btn('auto'),
    evOverrideCharge: btn('charge'),
    evOverrideStop: btn('stop'),
  };
}

describe('ev-tab.js — manual override controls', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('refreshEvOverrideState highlights the active mode from the server', async () => {
    const els = makeEls();
    fetchEvOverride.mockResolvedValueOnce({ mode: 'charge' });
    await refreshEvOverrideState(els);
    expect(els.evOverrideCharge.getAttribute('aria-pressed')).toBe('true');
    expect(els.evOverrideAuto.getAttribute('aria-pressed')).toBe('false');
    expect(els.evOverrideStop.getAttribute('aria-pressed')).toBe('false');
    expect(els.evOverrideHint.textContent).toBe('forcing charge');
  });

  it("defaults to 'auto' highlight for an unknown/missing mode", async () => {
    const els = makeEls();
    fetchEvOverride.mockResolvedValueOnce({});
    await refreshEvOverrideState(els);
    expect(els.evOverrideAuto.getAttribute('aria-pressed')).toBe('true');
    expect(els.evOverrideHint.textContent).toBe('');
  });

  it('clicking Stop posts the override and highlights it', async () => {
    const els = makeEls();
    setEvOverride.mockResolvedValueOnce({ mode: 'stop' });
    wireEvOverrideControls(els);
    await flush(); // initial refresh (auto)
    els.evOverrideStop.click();
    await flush();
    expect(setEvOverride).toHaveBeenCalledWith('stop');
    expect(els.evOverrideStop.getAttribute('aria-pressed')).toBe('true');
    expect(els.evOverrideHint.textContent).toBe('charging blocked');
  });

  it('reverts to server truth when the POST fails', async () => {
    const els = makeEls();
    setEvOverride.mockRejectedValueOnce(new Error('network'));
    fetchEvOverride.mockResolvedValue({ mode: 'auto' }); // revert target
    wireEvOverrideControls(els);
    await flush();
    els.evOverrideCharge.click();
    await flush();
    expect(setEvOverride).toHaveBeenCalledWith('charge');
    // optimistic highlight reverted back to the server's 'auto'
    expect(els.evOverrideAuto.getAttribute('aria-pressed')).toBe('true');
    expect(els.evOverrideCharge.getAttribute('aria-pressed')).toBe('false');
  });

  it('tolerates a failing fetch (leaves highlight unchanged)', async () => {
    const els = makeEls();
    fetchEvOverride.mockRejectedValueOnce(new Error('down'));
    await expect(refreshEvOverrideState(els)).resolves.toBeUndefined();
  });

  it('is a no-op when the override controls are absent', () => {
    expect(() => wireEvOverrideControls({})).not.toThrow();
    expect(fetchEvOverride).not.toHaveBeenCalled();
  });
});
