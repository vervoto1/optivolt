// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchAutoSelect: vi.fn(),
  fetchStoredSettings: vi.fn(),
  runAutoSelect: vi.fn(),
  saveStoredSettings: vi.fn(),
}));

import { fetchAutoSelect, fetchStoredSettings, runAutoSelect, saveStoredSettings } from '../../app/src/api/api.js';
import {
  initAutoSelect,
  getLastAutoSelectRun,
  formatStrategy,
  formatRelativeTime,
  isSameStrategy,
  readAutoSelectForm,
  refreshAutoSelectStatus,
} from '../../app/src/predictions/auto-select.js';

function setupDom({ full = true } = {}) {
  document.body.innerHTML = full ? `
    <input id="autosel-enabled" type="checkbox">
    <select id="autosel-mode"><option value="suggest">suggest</option><option value="auto">auto</option></select>
    <input id="autosel-time" value="03:30">
    <select id="autosel-metric"><option value="mae">mae</option><option value="rmse">rmse</option></select>
    <input id="autosel-min-improvement" value="10">
    <input id="autosel-window-days" value="28">
    <button id="autosel-run">Run Selection</button>
    <span id="autosel-last-run"></span>
    <span id="autosel-outcome"></span>
    <span id="autosel-current"></span><span id="autosel-current-metric"></span>
    <span id="autosel-best"></span><span id="autosel-best-metric"></span>
    <span id="autosel-delta"></span>
    <div id="autosel-apply-row" hidden><button id="autosel-apply">Apply suggestion</button></div>
  ` : '';
}

const text = id => document.getElementById(id).textContent;
const NOW = new Date('2026-08-23T10:00:00.000Z');
const INC = { lookbackWeeks: 8, dayFilter: 'all', aggregation: 'median', mae: 483, rmse: 720, mape: 30, n: 672, nSkipped: 0 };
const BEST = { lookbackWeeks: 26, dayFilter: 'all', aggregation: 'median', mae: 386, rmse: 600, mape: 28, n: 672, nSkipped: 0 };

function run(overrides = {}) {
  return {
    at: '2026-08-23T01:30:00.000Z',
    trigger: 'scheduled',
    sensor: 'Load without EV',
    windowDays: 28,
    metric: 'mae',
    mode: 'suggest',
    minImprovement_percent: 10,
    incumbent: INC,
    best: INC,
    improvement_percent: 0,
    reason: 'incumbent-best',
    action: 'kept',
    ranking: [],
    ...overrides,
  };
}

describe('auto-select.js', () => {
  let warn;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setupDom();
    fetchStoredSettings.mockResolvedValue({ predictionAutoSelect: { enabled: true, mode: 'auto', time: '04:15', metric: 'rmse', minImprovement_percent: 7, windowDays: 21 } });
    fetchAutoSelect.mockResolvedValue({ lastRun: null });
    saveStoredSettings.mockResolvedValue({});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  describe('helpers', () => {
    it('formatStrategy and isSameStrategy', () => {
      expect(formatStrategy(INC)).toBe('8w / all / median');
      expect(formatStrategy(null)).toBe('--');
      expect(isSameStrategy(INC, { ...INC, mae: 1 })).toBe(true);
      expect(isSameStrategy(INC, BEST)).toBe(false);
      expect(isSameStrategy(null, BEST)).toBe(false);
    });

    it('formatRelativeTime buckets', () => {
      const now = NOW.getTime();
      expect(formatRelativeTime(new Date(now - 10_000).toISOString(), now)).toBe('just now');
      expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 min ago');
      expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 h ago');
      expect(formatRelativeTime(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('3 d ago');
    });
  });

  describe('init', () => {
    it('hydrates the form from settings and renders the empty state', async () => {
      await initAutoSelect();
      expect(document.getElementById('autosel-enabled').checked).toBe(true);
      expect(document.getElementById('autosel-mode').value).toBe('auto');
      expect(document.getElementById('autosel-time').value).toBe('04:15');
      expect(document.getElementById('autosel-metric').value).toBe('rmse');
      expect(document.getElementById('autosel-min-improvement').value).toBe('7');
      expect(document.getElementById('autosel-window-days').value).toBe('21');
      expect(text('autosel-last-run')).toBe('Never');
      expect(text('autosel-outcome')).toBe('No run yet');
      expect(text('autosel-current')).toBe('--');
      expect(document.getElementById('autosel-apply-row').hidden).toBe(true);
      expect(getLastAutoSelectRun()).toBeNull();
    });

    it('falls back to defaults when settings lack the block, and warns on load failure', async () => {
      fetchStoredSettings.mockResolvedValue(undefined);
      await initAutoSelect();
      expect(document.getElementById('autosel-enabled').checked).toBe(false);
      expect(document.getElementById('autosel-window-days').value).toBe('28');

      fetchStoredSettings.mockRejectedValue(new Error('offline'));
      await initAutoSelect();
      expect(warn).toHaveBeenCalledWith('Failed to load auto-select settings:', 'offline');
    });

    it('survives a missing DOM', async () => {
      setupDom({ full: false });
      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'suggested', best: BEST, improvement_percent: 20, reason: 'switch' }) });
      await expect(initAutoSelect()).resolves.toBeUndefined();
      expect(readAutoSelectForm()).toEqual({ enabled: false, mode: 'suggest', time: '03:30', metric: 'mae', minImprovement_percent: 10, windowDays: 28 });
    });

    it('saves the settings block (debounced) when a field changes, and warns on failure', async () => {
      await initAutoSelect();
      document.getElementById('autosel-min-improvement').value = '12.5';
      document.getElementById('autosel-window-days').value = 'abc';
      document.getElementById('autosel-enabled').dispatchEvent(new Event('change'));
      document.getElementById('autosel-min-improvement').dispatchEvent(new Event('input'));
      expect(saveStoredSettings).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(700);
      expect(saveStoredSettings).toHaveBeenCalledOnce();
      expect(saveStoredSettings).toHaveBeenCalledWith({
        predictionAutoSelect: { enabled: true, mode: 'auto', time: '04:15', metric: 'rmse', minImprovement_percent: 12.5, windowDays: 28 },
      });

      saveStoredSettings.mockRejectedValue(new Error('nope'));
      document.getElementById('autosel-mode').dispatchEvent(new Event('change'));
      await vi.advanceTimersByTimeAsync(700);
      expect(warn).toHaveBeenCalledWith('Failed to save auto-select settings:', 'nope');
    });
  });

  describe('status rendering', () => {
    it('renders a kept / incumbent-best run', async () => {
      fetchAutoSelect.mockResolvedValue({ lastRun: run() });
      await initAutoSelect();
      expect(text('autosel-last-run')).toBe('9 h ago · scheduled');
      expect(text('autosel-outcome')).toBe('Kept — current strategy is best');
      expect(document.getElementById('autosel-outcome').className).toContain('emerald');
      expect(text('autosel-current')).toBe('8w / all / median');
      expect(text('autosel-current-metric')).toBe('MAE 483 Wh');
      expect(text('autosel-best')).toBe('8w / all / median');
      expect(text('autosel-delta')).toBe('0 %');
      expect(document.getElementById('autosel-apply-row').hidden).toBe(true);
    });

    it('renders below-threshold with the margin (default when the record lacks it)', async () => {
      fetchAutoSelect.mockResolvedValue({ lastRun: run({ reason: 'below-threshold', best: BEST, improvement_percent: 5.38, minImprovement_percent: 8 }) });
      await initAutoSelect();
      expect(text('autosel-outcome')).toBe('Kept — best is only 5.4 % better (min 8 %)');
      expect(text('autosel-delta')).toBe('−5.4 %');
      expect(text('autosel-best-metric')).toBe('MAE 386 Wh');

      fetchAutoSelect.mockResolvedValue({ lastRun: run({ reason: 'below-threshold', best: BEST, improvement_percent: null, minImprovement_percent: undefined }) });
      await refreshAutoSelectStatus();
      expect(text('autosel-outcome')).toBe('Kept — best is only 0.0 % better (min 10 %)');
      expect(text('autosel-delta')).toBe('--');
    });

    it('renders no-eligible, skipped, and applied runs', async () => {
      fetchAutoSelect.mockResolvedValue({ lastRun: run({ reason: 'no-eligible', incumbent: null, best: null, improvement_percent: null }) });
      await initAutoSelect();
      expect(text('autosel-outcome')).toBe('Kept — not enough data to score');
      expect(text('autosel-best')).toBe('--');
      expect(text('autosel-best-metric')).toBe('');

      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'skipped', skipReason: 'active predictor is "fixed", not historical', incumbent: null, best: null, reason: null, improvement_percent: null }) });
      await refreshAutoSelectStatus();
      expect(text('autosel-outcome')).toBe('Skipped: active predictor is "fixed", not historical');
      expect(document.getElementById('autosel-outcome').className).toContain('amber');

      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'skipped', incumbent: null, best: null, reason: null, improvement_percent: null }) });
      await refreshAutoSelectStatus();
      expect(text('autosel-outcome')).toBe('Skipped: unknown reason');

      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'applied', best: BEST, improvement_percent: 20.08, reason: 'switch', metric: 'rmse' }) });
      await refreshAutoSelectStatus();
      expect(text('autosel-outcome')).toBe('Switched to best (−20.1 %)');
      expect(text('autosel-best-metric')).toBe('RMSE 600 Wh');

      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'applied', best: BEST, improvement_percent: null, reason: 'incumbent-unscored', incumbent: null, metric: undefined }) });
      await refreshAutoSelectStatus();
      expect(text('autosel-outcome')).toBe('Switched to best (−0.0 %)');
      expect(text('autosel-current-metric')).toBe('');
    });

    it('renders a suggestion with an Apply button that goes through applyStrategy', async () => {
      const applyStrategy = vi.fn().mockResolvedValue(undefined);
      let current = INC;
      const getCurrentStrategy = vi.fn(() => current);
      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'suggested', best: BEST, improvement_percent: 20.08, reason: 'switch' }) });
      await initAutoSelect({ applyStrategy, getCurrentStrategy });

      expect(text('autosel-outcome')).toBe('Suggested: switch to best (−20.1 %)');
      expect(document.getElementById('autosel-outcome').className).toContain('sky');
      expect(document.getElementById('autosel-apply-row').hidden).toBe(false);

      applyStrategy.mockImplementation(async s => { current = s; });
      document.getElementById('autosel-apply').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(applyStrategy).toHaveBeenCalledWith(BEST);
      expect(text('autosel-outcome')).toBe('Suggestion applied');
      expect(document.getElementById('autosel-apply-row').hidden).toBe(true);
    });

    it('explains an unscored incumbent suggestion and reports apply failures', async () => {
      const applyStrategy = vi.fn().mockRejectedValue(new Error('save failed'));
      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'suggested', best: BEST, incumbent: null, improvement_percent: null, reason: 'incumbent-unscored' }) });
      await initAutoSelect({ applyStrategy });
      expect(text('autosel-outcome')).toBe('Suggested: current strategy could not be scored');

      document.getElementById('autosel-apply').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(text('autosel-outcome')).toBe('Apply failed: save failed');
      expect(document.getElementById('autosel-outcome').className).toContain('red');
    });

    it('ignores Apply when there is nothing to apply or no applyStrategy dep', async () => {
      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'suggested', best: BEST, improvement_percent: 20, reason: 'switch' }) });
      await initAutoSelect();
      document.getElementById('autosel-apply').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(text('autosel-outcome')).toBe('Suggested: switch to best (−20.0 %)');

      fetchAutoSelect.mockResolvedValue({ lastRun: run({ action: 'suggested', best: null, improvement_percent: null, reason: 'no-eligible' }) });
      await initAutoSelect({ applyStrategy: vi.fn() });
      document.getElementById('autosel-apply').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(text('autosel-outcome')).toBe('Suggested: current strategy could not be scored');
    });

    it('treats a failed or empty status fetch as "no run"', async () => {
      fetchAutoSelect.mockRejectedValue(new Error('500'));
      await initAutoSelect();
      expect(warn).toHaveBeenCalledWith('Failed to load auto-select status:', '500');
      expect(text('autosel-outcome')).toBe('No run yet');

      fetchAutoSelect.mockResolvedValue(undefined);
      await refreshAutoSelectStatus();
      expect(getLastAutoSelectRun()).toBeNull();
    });
  });

  describe('run now', () => {
    it('runs a selection, renders the result, and notifies onRunComplete', async () => {
      const onRunComplete = vi.fn();
      await initAutoSelect({ onRunComplete });
      let release;
      runAutoSelect.mockReturnValue(new Promise(resolve => { release = resolve; }));

      const btn = document.getElementById('autosel-run');
      btn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe('Running…');
      expect(btn.classList.contains('opacity-50')).toBe(true);

      const result = run({ action: 'suggested', best: BEST, improvement_percent: 20, reason: 'switch', trigger: 'manual', at: NOW.toISOString() });
      release(result);
      await vi.advanceTimersByTimeAsync(0);
      expect(runAutoSelect).toHaveBeenCalledWith(true);
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe('Run Selection');
      expect(text('autosel-last-run')).toBe('just now · manual');
      expect(onRunComplete).toHaveBeenCalledWith(result);
      expect(getLastAutoSelectRun()).toBe(result);
    });

    it('shows run errors without an onRunComplete dep', async () => {
      await initAutoSelect();
      runAutoSelect.mockRejectedValue(new Error('Auto-select run already in progress'));
      document.getElementById('autosel-run').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(text('autosel-outcome')).toBe('Error: Auto-select run already in progress');
      expect(document.getElementById('autosel-run').disabled).toBe(false);

      runAutoSelect.mockResolvedValue(run());
      document.getElementById('autosel-run').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(text('autosel-outcome')).toBe('Kept — current strategy is best');
    });
  });
});
