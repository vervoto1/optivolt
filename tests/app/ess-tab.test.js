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
  renderLineChart.mockReturnValue(true);
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

  it('pins the cell-voltage trend axis to the LiFePO4 range (2.75–3.75 V)', async () => {
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
    expect(cellTrendCall[2]).toMatchObject({ yMin: 2.75, yMax: 3.75, showLegend: false });
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

describe('value formatting', () => {
  it('formats integers, large non-integers (0 dp) and small non-integers (2 dp), escapes units and extras', async () => {
    getEssState.mockResolvedValue({
      batteries: [battery('B0', {
        scalars: {
          soc: { entity: 'B0.soc', value: 80, unit: '%' },          // integer
          totalVoltage: { entity: 'B0.v', value: 123.456, unit: 'V' }, // >=100 non-integer -> 0 dp
          current: { entity: 'B0.i', value: 3.14159, unit: 'A' },     // <100 non-integer -> 2 dp
          minCellVoltage: { entity: 'B0.mc', value: 3.3, unit: '<V>' }, // unit needs escaping
        },
        balancing: { value: 'on' },
        extras: [
          { name: 'Firmware', value: 'v1.2 & up', unit: '' },         // value escaped, no unit
          { name: 'Cycles', value: 412, unit: 'x' },                  // value + unit
          { name: 'Empty', value: '' },                               // empty -> missing
          { name: 'Null', value: null },                              // null -> missing
        ],
      })],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const overview = document.querySelector('#ess-batteries [data-overview]');
    const html = overview.innerHTML;
    expect(html).toContain('123 V');     // 123.456 -> 0 dp
    expect(html).toContain('3.14 A');    // 3.14159 -> 2 dp
    expect(html).toContain('80 %');      // integer kept as-is
    expect(html).toContain('3.30 &lt;V&gt;'); // 3.3 -> 2 dp, unit HTML-escaped
    // Balancing tile (on)
    expect(html).toContain('Balancing');
    expect(html).toContain('text-emerald-600');
    expect(html).toContain('>On<');
    // Extra with escaped value + no unit
    expect(html).toContain('v1.2 &amp; up');
    expect(html).toContain('412 x');
    // Empty + null extras render the missing placeholder
    expect(overview.querySelectorAll('.ess-missing').length).toBeGreaterThanOrEqual(2);
  });

  it('renders balancing Off and the missing placeholder for an unknown balancing value', async () => {
    getEssState.mockResolvedValue({
      batteries: [
        battery('Off', { balancing: { value: 'off' } }),
        battery('Unknown', { balancing: { value: null } }),
      ],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const cards = document.querySelectorAll('#ess-batteries section.card');
    expect(cards[0].innerHTML).toContain('>Off<');
    expect(cards[0].innerHTML).toContain('text-slate-400');
    // Balancing value null -> the missing placeholder, not "Off".
    const balancingTiles = [...cards[1].querySelectorAll('.stat-label')]
      .filter((l) => l.textContent === 'Balancing');
    expect(balancingTiles).toHaveLength(1);
    expect(balancingTiles[0].nextElementSibling.querySelector('.ess-missing')).not.toBeNull();
  });

  it('renders system extras', async () => {
    getEssState.mockResolvedValue({
      batteries: [battery('B0')],
      system: {
        name: 'Sys',
        scalars: { soc: { entity: 's.soc', value: 55, unit: '%' } },
        extras: [{ name: 'Grid', value: 'L1', unit: '' }],
      },
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    expect(document.getElementById('ess-system-scalars').textContent).toContain('Grid');
    expect(document.getElementById('ess-system-scalars').textContent).toContain('L1');
  });
});

describe('chart overlays + history degradation', () => {
  it('shows trend/SoC placeholders when the line charts cannot draw', async () => {
    renderLineChart.mockReturnValue(false); // nothing drawable
    getEssState.mockResolvedValue({
      batteries: [battery('B0', { temperatures: [{ entity: 'B0.t1', name: 'T1', value: 25 }] })],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const trendOverlay = document.querySelector('#ess-batteries [data-trend]').parentElement.querySelector('.chart-empty span');
    const tempOverlay = document.querySelector('#ess-batteries [data-temp]').parentElement.querySelector('.chart-empty span');
    expect(trendOverlay.textContent).toContain('No trend data');
    expect(tempOverlay.textContent).toContain('No trend data');
    // SoC card has no overlay node in this fixture: setChartMessage is a no-op
    // (the absent-overlay early-return branch). The card is still revealed.
    expect(document.getElementById('ess-soc-card').classList.contains('hidden')).toBe(false);
  });

  it('writes the "No SoC history" overlay message when the SoC card has an overlay node', async () => {
    renderLineChart.mockReturnValue(false);
    // Give the SoC card a chart-empty overlay so setChartMessage writes into it.
    document.getElementById('ess-soc-card').innerHTML =
      '<canvas id="ess-soc-chart"></canvas><div class="chart-empty"><span>Waiting…</span></div>';
    getEssState.mockResolvedValue({
      batteries: [battery('B0')],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const socOverlay = document.querySelector('#ess-soc-card .chart-empty span');
    expect(socOverlay.textContent).toContain('No SoC history');
  });

  it('no-ops the overlay update when the chart-empty node has no <span>', async () => {
    renderLineChart.mockReturnValue(false);
    // SoC card overlay exists but has no inner <span>: setChartMessage shows the
    // overlay yet cannot write text (the false side of `span && message`).
    document.getElementById('ess-soc-card').innerHTML =
      '<canvas id="ess-soc-chart"></canvas><div class="chart-empty"></div>';
    getEssState.mockResolvedValue({ batteries: [battery('B0')], system: null, refreshIntervalSeconds: 30, fetchedAtMs: 0 });
    getEssHistory.mockResolvedValue(emptyHistory);

    await expect(initEssTab()).resolves.toBeUndefined();
    const overlay = document.querySelector('#ess-soc-card .chart-empty');
    // Overlay revealed (display cleared) but no span text written.
    expect(overlay.style.display).toBe('');
    expect(overlay.querySelector('span')).toBeNull();
  });

  it('renders the system card even when the system-name node is absent', async () => {
    // System card + scalars present but no #ess-system-name: nameEl is null.
    document.getElementById('ess-system-name').remove();
    getEssState.mockResolvedValue({
      batteries: [battery('B0')],
      system: { name: 'Headless Sys', scalars: { soc: { entity: 's.soc', value: 60, unit: '%' } }, extras: [] },
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await expect(initEssTab()).resolves.toBeUndefined();
    expect(document.getElementById('ess-system-card').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('ess-system-scalars').textContent).toContain('System SoC');
  });

  it('omits batteries whose SoC entity is missing from the combined SoC chart', async () => {
    getEssState.mockResolvedValue({
      batteries: [
        battery('HasSoc'),
        battery('NoSoc', { scalars: { soc: { value: 50, unit: '%' } } }), // no entity
      ],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const socCall = renderLineChart.mock.calls.find(([, , opts]) => opts && opts.yTitle === '%');
    expect(socCall).toBeDefined();
    const entries = socCall[1];
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('HasSoc');
  });
});

describe('robustness against partial DOM / odd inputs', () => {
  it('handles an absent panel-ess (does nothing, no HA traffic)', async () => {
    document.body.innerHTML = '';
    await expect(initEssTab()).resolves.toBeUndefined();
    expect(getEssState).not.toHaveBeenCalled();
  });

  it('renders even when the system card and SoC card nodes are absent', async () => {
    // Minimal panel: only the batteries container exists.
    document.body.innerHTML = `<div id="panel-ess"><div id="ess-batteries"></div></div>`;
    getEssState.mockResolvedValue({
      batteries: [battery('B0')],
      system: { name: 'Sys', scalars: {}, extras: [] },
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await expect(initEssTab()).resolves.toBeUndefined();
    expect(document.querySelectorAll('#ess-batteries section.card')).toHaveLength(1);
  });

  it('does not throw when the batteries container is missing but history still runs', async () => {
    // First, render with zero batteries (container present) so module `views`
    // is reset to an empty array.
    getEssState.mockResolvedValueOnce({ batteries: [], system: null, refreshIntervalSeconds: 30, fetchedAtMs: 0 });
    getEssHistory.mockResolvedValueOnce(emptyHistory);
    await initEssTab();
    deactivateEssTab();

    // Now: panel-ess present, but no #ess-batteries node. buildSkeleton returns
    // early (views stays empty), so renderHistory's per-battery view is undefined
    // and must be tolerated rather than throwing.
    document.body.innerHTML = `
      <div id="panel-ess">
        <section id="ess-empty" class="hidden"><div id="ess-empty-message"></div></section>
        <section id="ess-soc-card" class="hidden"><canvas id="ess-soc-chart"></canvas></section>
      </div>`;
    getEssState.mockResolvedValue({
      batteries: [battery('B0')],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await expect(initEssTab()).resolves.toBeUndefined();
    // SoC chart still attempted from history despite no per-battery views.
    expect(renderLineChart).toHaveBeenCalled();
  });

  it('treats an absent batteries array as empty (no cards, no crash)', async () => {
    getEssState.mockResolvedValue({ system: null, refreshIntervalSeconds: 30, fetchedAtMs: 0 }); // no batteries
    getEssHistory.mockResolvedValue(emptyHistory);

    await expect(initEssTab()).resolves.toBeUndefined();
    expect(document.querySelectorAll('#ess-batteries section.card')).toHaveLength(0);
  });

  it('tolerates null cells/temperatures/extras and unitless scalars', async () => {
    getEssState.mockResolvedValue({
      batteries: [{
        name: 'B0',
        cells: null,
        temperatures: null,
        extras: null,
        balancing: null,
        scalars: { soc: { entity: 'B0.soc', value: 77 } }, // value, no unit
      }],
      system: { name: 'Sys', scalars: { soc: { entity: 's.soc', value: 50 } }, extras: null },
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();

    const overview = document.querySelector('#ess-batteries [data-overview]');
    // Unitless scalar -> value with no trailing unit space.
    expect(overview.innerHTML).toContain('<div class="stat-value">77</div>');
    // System still rendered.
    expect(document.getElementById('ess-system-card').classList.contains('hidden')).toBe(false);
  });

  it('hides the system card when state has no system', async () => {
    getEssState.mockResolvedValue({
      batteries: [battery('B0')],
      system: null,
      refreshIntervalSeconds: 30,
      fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();
    expect(document.getElementById('ess-system-card').classList.contains('hidden')).toBe(true);
  });

  it('shows the empty state without throwing when the empty/content nodes are absent', async () => {
    // panel-ess only — none of the empty-message / batteries / cards exist, so
    // every optional-chained DOM access in showEmpty hits its null branch.
    document.body.innerHTML = `<div id="panel-ess"></div>`;
    getEssState.mockRejectedValue(new Error('HA down'));
    getEssHistory.mockResolvedValue(emptyHistory);

    await expect(initEssTab()).resolves.toBeUndefined();
  });

  it('falls back to a generic empty message when the rejection has no message', async () => {
    getEssState.mockRejectedValue({}); // no .message
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();
    expect(document.getElementById('ess-empty-message').textContent)
      .toContain('Home Assistant is not configured.');
  });

  it('defaults a missing/invalid refresh interval to a 30s poll', async () => {
    vi.useFakeTimers();
    getEssState.mockResolvedValue({ batteries: [battery('B0')], system: null, fetchedAtMs: 0 }); // no refreshIntervalSeconds
    getEssHistory.mockResolvedValue(emptyHistory);

    await initEssTab();
    expect(getEssState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29000);
    expect(getEssState).toHaveBeenCalledTimes(1); // not yet
    await vi.advanceTimersByTimeAsync(1000);
    expect(getEssState).toHaveBeenCalledTimes(2); // polled at 30s
  });

  it('rebuilds the skeleton when the battery count changes between renders', async () => {
    vi.useFakeTimers();
    getEssState.mockResolvedValueOnce({
      batteries: [battery('A'), battery('B')],
      system: null, refreshIntervalSeconds: 5, fetchedAtMs: 0,
    });
    getEssHistory.mockResolvedValue(emptyHistory);
    await initEssTab();
    expect(document.querySelectorAll('#ess-batteries section.card')).toHaveLength(2);

    // Next poll returns a single battery — skeleton must shrink to one card.
    getEssState.mockResolvedValueOnce({
      batteries: [battery('A')], system: null, refreshIntervalSeconds: 5, fetchedAtMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelectorAll('#ess-batteries section.card')).toHaveLength(1);
  });

  it('keeps the last render when a poll fetch rejects (no blanking)', async () => {
    vi.useFakeTimers();
    getEssState.mockResolvedValueOnce({ batteries: [battery('B0')], system: null, refreshIntervalSeconds: 5, fetchedAtMs: 0 });
    getEssHistory.mockResolvedValue(emptyHistory);
    await initEssTab();
    expect(document.querySelectorAll('#ess-batteries section.card')).toHaveLength(1);

    getEssState.mockRejectedValueOnce(new Error('poll failed'));
    await vi.advanceTimersByTimeAsync(5000);
    // Render preserved despite the failed poll.
    expect(document.querySelectorAll('#ess-batteries section.card')).toHaveLength(1);
    expect(document.getElementById('ess-empty').classList.contains('hidden')).toBe(true);
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
