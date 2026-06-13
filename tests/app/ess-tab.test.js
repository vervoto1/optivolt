// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('../../app/src/ess-charts.js', () => ({
  renderCellSnapshot: vi.fn(() => true),
  renderLineChart: vi.fn(() => true),
  cellColor: (i) => `hsl(${i}, 70%, 50%)`,
  batteryColor: (i) => `rgb(${i},${i},${i})`,
}));

vi.mock('../../app/src/api/api.js', () => ({
  getEssState: vi.fn(),
  getEssHistory: vi.fn(),
}));

import { initEssTab, deactivateEssTab } from '../../app/src/ess-tab.js';
import { getEssState, getEssHistory } from '../../app/src/api/api.js';
import { renderCellSnapshot, renderLineChart } from '../../app/src/ess-charts.js';

function setupDom() {
  document.body.innerHTML = `
    <div id="panel-ess">
      <section id="ess-empty" class="hidden"><div id="ess-empty-message"></div></section>
      <div id="ess-batteries"></div>
      <section id="ess-soc-card" class="hidden"><canvas id="ess-soc-chart"></canvas></section>
      <section id="ess-system-card" class="hidden">
        <h3 id="ess-system-name"></h3>
        <div id="ess-system-scalars"></div>
      </section>
    </div>`;
}

function battery(name, overrides = {}) {
  return {
    name,
    cells: [{ entity: `${name}.c1`, value: 3.3 }],
    temperatures: [],
    scalars: { soc: { entity: `${name}.soc`, value: 80, unit: '%' } },
    balancing: null,
    extras: [],
    ...overrides,
  };
}

const emptyHistory = { hours: 24, period: '5minute', series: {}, noStatistics: [], fetchedAtMs: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  renderCellSnapshot.mockReturnValue(true);
  setupDom();
});

afterEach(() => {
  deactivateEssTab();
  vi.useRealTimers();
});

describe('initEssTab — rendering', () => {
  it('builds one card per battery from the state response', async () => {
    getEssState.mockResolvedValue({
      batteries: [battery('Basen Green'), battery('Gobel Power')],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const cards = document.querySelectorAll('#ess-batteries section.card');
    expect(cards).toHaveLength(2);
    expect(document.querySelector('#ess-batteries').textContent).toContain('Basen Green');
    expect(document.querySelector('#ess-batteries').textContent).toContain('SoC');
    expect(document.getElementById('ess-empty').classList.contains('hidden')).toBe(true);
  });

  it('pins the cell-voltage trend axis to the LiFePO4 range (2.8–3.8 V)', async () => {
    getEssState.mockResolvedValue({
      batteries: [battery('B0')],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const cellTrendCall = renderLineChart.mock.calls.find(([, , opts]) => opts && opts.yTitle === 'V');
    expect(cellTrendCall).toBeDefined();
    expect(cellTrendCall[2]).toMatchObject({ yMin: 2.8, yMax: 3.8, showLegend: false });
  });

  it('pins the temperature trend axis to the 20–80 °C band', async () => {
    getEssState.mockResolvedValue({
      batteries: [battery('B0', { temperatures: [{ entity: 'B0.t1', name: 'Temp 1', value: 25 }] })],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const tempTrendCall = renderLineChart.mock.calls.find(([, , opts]) => opts && opts.yTitle === '°C');
    expect(tempTrendCall).toBeDefined();
    expect(tempTrendCall[2]).toMatchObject({ yMin: 20, yMax: 80, showLegend: true });
  });

  it('renders the system card when present', async () => {
    getEssState.mockResolvedValue({
      batteries: [battery('B0')],
      system: { name: 'Victron system', scalars: { batteryPower: { entity: 's.p', value: 1200, unit: 'W' } }, extras: [] },
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const sysCard = document.getElementById('ess-system-card');
    expect(sysCard.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('ess-system-name').textContent).toBe('Victron system');
    expect(document.getElementById('ess-system-scalars').textContent).toContain('Battery power');
  });
});

describe('initEssTab — graceful degradation', () => {
  it('shows the empty state (no throw) when the state fetch rejects (422)', async () => {
    getEssState.mockRejectedValue(new Error('Home Assistant is not configured'));
    getEssHistory.mockResolvedValue(emptyHistory);

    await expect(initEssTab()).resolves.toBeUndefined();

    const empty = document.getElementById('ess-empty');
    expect(empty.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('ess-empty-message').textContent).toContain('Home Assistant');
    expect(document.getElementById('ess-batteries').classList.contains('hidden')).toBe(true);
  });

  it('renders a "not found" placeholder for a battery whose cells are all missing', async () => {
    renderCellSnapshot.mockReturnValue(false); // simulate nothing to draw
    getEssState.mockResolvedValue({
      batteries: [battery('B0', { cells: [{ entity: 'B0.c1', value: null }], scalars: { soc: { entity: 'B0.soc', value: null } } })],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    // Snapshot chart shows an explicit placeholder rather than a blank canvas.
    const overlay = document.querySelector('#ess-batteries [data-snapshot]').parentElement.querySelector('.chart-empty span');
    expect(overlay.textContent).toContain('not found');
    // A null scalar renders the missing placeholder, not a blank/zero value.
    expect(document.querySelector('#ess-batteries .ess-missing')).not.toBeNull();
  });

  it('keeps the last render when a history fetch fails', async () => {
    getEssState.mockResolvedValue({ batteries: [battery('B0')], system: null, refreshIntervalSeconds: 30, fetchedAtMs: 0 });
    getEssHistory.mockRejectedValue(new Error('stats down'));

    await initEssTab();

    // Battery card still built; tab not blanked.
    expect(document.querySelectorAll('#ess-batteries section.card')).toHaveLength(1);
    expect(document.getElementById('ess-empty').classList.contains('hidden')).toBe(true);
  });
});

describe('polling lifecycle', () => {
  it('polls state on the interval and stops on deactivation (no leak)', async () => {
    vi.useFakeTimers();
    getEssState.mockResolvedValue({ batteries: [battery('B0')], system: null, refreshIntervalSeconds: 5, fetchedAtMs: 0 });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();
    expect(getEssState).toHaveBeenCalledTimes(1); // initial load

    await vi.advanceTimersByTimeAsync(5000);
    expect(getEssState).toHaveBeenCalledTimes(2); // one poll

    deactivateEssTab();
    await vi.advanceTimersByTimeAsync(15000);
    expect(getEssState).toHaveBeenCalledTimes(2); // no further polls after deactivation
  });

  it('does no HA traffic on import — only when activated', () => {
    // getEssState must not have been called merely by importing the module.
    expect(getEssState).not.toHaveBeenCalled();
  });
});

describe('static wiring', () => {
  function read(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  }

  it('places the ESS tab button between EV and Predictions in the nav', () => {
    const html = read('../../app/index.html');
    const ev = html.indexOf('id="tab-ev"');
    const ess = html.indexOf('id="tab-ess"');
    const predictions = html.indexOf('id="tab-predictions"');
    expect(ev).toBeGreaterThan(-1);
    expect(ess).toBeGreaterThan(ev);
    expect(predictions).toBeGreaterThan(ess);
  });

  it('lazy-inits the ESS tab via an activation hook, not during boot()', () => {
    const main = read('../../app/main.js');
    expect(main).toContain('onActivate: () => { void initEssTab(); }');
    // boot() must not eagerly init the ESS tab.
    const boot = main.slice(main.indexOf('async function boot()'));
    expect(boot).not.toContain('initEssTab');
  });
});
