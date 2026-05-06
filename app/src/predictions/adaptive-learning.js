import {
  fetchCalibration,
  fetchPlanAccuracy,
  fetchStoredSettings,
  saveStoredSettings,
  triggerCalibration,
} from '../api/api.js';
import { debounce } from '../utils.js';
import { buildTimeAxisFromTimestamps, getBaseOptions, renderChart } from '../charts.js';
import { createTooltipHandler, getChartAnimations, ttDivider, ttHeader, ttRow } from '../chart-tooltip.js';

export async function initAdaptiveLearning() {
  try {
    const settings = await fetchStoredSettings();
    const al = settings.adaptiveLearning ?? { enabled: false, mode: 'suggest', minDataDays: 3 };

    const enabledEl = document.getElementById('adaptive-enabled');
    const modeEl = document.getElementById('adaptive-mode');
    const minDaysEl = document.getElementById('adaptive-min-days');

    if (enabledEl) enabledEl.checked = al.enabled;
    if (modeEl) modeEl.value = al.mode || 'suggest';
    if (minDaysEl) minDaysEl.value = al.minDataDays ?? 3;

    const saveAdaptive = debounce(saveAdaptiveLearning, 600);
    for (const el of [enabledEl, modeEl, minDaysEl]) {
      el?.addEventListener('input', saveAdaptive);
      el?.addEventListener('change', saveAdaptive);
    }

    const calBtn = document.getElementById('adaptive-calibrate');
    calBtn?.addEventListener('click', async () => {
      const minDays = parseInt(document.getElementById('adaptive-min-days')?.value, 10) || 1;
      calBtn.disabled = true;
      calBtn.textContent = 'Calibrating...';
      calBtn.classList.add('opacity-50', 'cursor-not-allowed');
      try {
        const result = await triggerCalibration(minDays);
        await renderSocAccuracy();
        setEl('adaptive-status-text', result.calibration ? 'Calibrated' : result.message || 'No result');
      } catch (err) {
        setEl('adaptive-status-text', `Error: ${err.message}`);
      } finally {
        calBtn.disabled = false;
        calBtn.textContent = 'Calibrate';
        calBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      }
    });
  } catch (err) {
    console.warn('Failed to load adaptive learning settings:', err.message);
  }

  renderSocAccuracy();
}

async function saveAdaptiveLearning() {
  const enabled = document.getElementById('adaptive-enabled')?.checked ?? false;
  const mode = document.getElementById('adaptive-mode')?.value ?? 'suggest';
  const minDataDays = parseInt(document.getElementById('adaptive-min-days')?.value, 10) || 3;

  try {
    await saveStoredSettings({ adaptiveLearning: { enabled, mode, minDataDays } });
  } catch (err) {
    console.warn('Failed to save adaptive learning settings:', err.message);
  }
}

async function renderSocAccuracy() {
  try {
    const [accuracyRes, calibrationRes] = await Promise.all([
      fetchPlanAccuracy(),
      fetchCalibration(),
    ]);

    const report = accuracyRes?.report;
    const calibration = calibrationRes?.calibration;

    if (calibration) {
      setEl('adaptive-status-text', 'Calibrated');
      setEl('adaptive-charge-rate', `${(calibration.effectiveChargeRate * 100).toFixed(1)}%`);
      setEl('adaptive-discharge-rate', `${(calibration.effectiveDischargeRate * 100).toFixed(1)}%`);
      setEl('adaptive-confidence', `${(calibration.confidence * 100).toFixed(0)}%`);
      setEl('adaptive-samples', `${calibration.sampleCount}`);
    } else {
      setEl('adaptive-status-text', 'Collecting data...');
    }

    if (!report && !calibration) return;

    const emptyEl = document.getElementById('soc-accuracy-empty');
    const contentEl = document.getElementById('soc-accuracy-content');
    if (emptyEl) emptyEl.hidden = true;
    if (contentEl) contentEl.hidden = false;

    if (report?.deviations?.length) {
      renderSocAccuracyCharts(report);
      setEl('cal-slots', `${report.slotsCompared}`);
    }

    if (calibration) {
      setEl('cal-charge-rate', `${(calibration.effectiveChargeRate * 100).toFixed(1)}%`);
      setEl('cal-discharge-rate', `${(calibration.effectiveDischargeRate * 100).toFixed(1)}%`);
      setEl('cal-confidence', `${(calibration.confidence * 100).toFixed(0)}%`);
      setEl('cal-slots', `${calibration.sampleCount}`);
      renderEfficiencyCurveChart(calibration);
    }
  } catch (err) {
    console.warn('Failed to load SoC accuracy:', err.message);
  }
}

function renderSocAccuracyCharts(report) {
  renderPercentAccuracyCharts(
    'soc-accuracy-chart',
    'soc-accuracy-diff-chart',
    report.deviations.map(d => ({
      time: d.timestampMs,
      actual: d.actualSoc_percent,
      predicted: d.predictedSoc_percent,
    })),
  );
}

function renderPercentAccuracyCharts(overlayCanvasId, diffCanvasId, recentData) {
  const overlayCanvas = document.getElementById(overlayCanvasId);
  const diffCanvas = document.getElementById(diffCanvasId);
  if (!overlayCanvas || !recentData || recentData.length === 0) return;

  const sorted = [...recentData].sort((a, b) => a.time - b.time);
  const axis = buildTimeAxisFromTimestamps(sorted.map(d => d.time));
  const actualColor = 'rgb(14, 165, 233)';
  const predColor = 'rgb(249, 115, 22)';

  renderChart(overlayCanvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: 'Actual SoC (%)',
          data: sorted.map(d => d.actual),
          borderColor: actualColor,
          backgroundColor: actualColor,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
        {
          label: 'Predicted SoC (%)',
          data: sorted.map(d => d.predicted),
          borderColor: predColor,
          backgroundColor: predColor,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: getBaseOptions({ ...axis, yTitle: '%' }, {
      ...getChartAnimations('line', sorted.length),
      plugins: {
        tooltip: {
          mode: 'index',
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? '';
              let html = ttHeader(time);
              for (const pt of (tooltip.dataPoints ?? [])) {
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${Number(pt.raw).toFixed(1)}%`);
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
  });

  if (!diffCanvas) return;
  renderChart(diffCanvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [{
        label: 'Difference (pred - actual)',
        data: sorted.map(d => d.predicted - d.actual),
        borderColor: 'rgba(100,116,139,0.6)',
        backgroundColor: 'transparent',
        borderWidth: 1,
        pointRadius: 0,
        tension: 0.3,
        fill: { target: 'origin', above: 'rgba(139,201,100,0.45)', below: 'rgba(233,122,131,0.45)' },
      }],
    },
    options: getBaseOptions({ ...axis, yTitle: '% diff' }, {
      ...getChartAnimations('line', sorted.length),
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? '';
              const pt = tooltip.dataPoints?.[0];
              if (!pt) return ttHeader(time);
              const v = Number(pt.raw);
              const color = v >= 0 ? 'rgb(139,201,100)' : 'rgb(233,122,131)';
              let html = ttHeader(time);
              html += ttDivider();
              html += ttRow(color, 'Pred - Actual', `${v >= 0 ? '+' : ''}${Math.abs(v).toFixed(1)}%`);
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
  });
}

function renderEfficiencyCurveChart(calibration) {
  const canvas = document.getElementById('efficiency-curve-chart');
  if (!canvas) return;

  const { chargeCurve, dischargeCurve, chargeSamples, dischargeSamples } = calibration;
  if (!chargeCurve || !dischargeCurve || chargeCurve.length !== 100) return;

  const minSamples = 2;
  const labels = [];
  const data = [];
  const sampleCounts = [];

  for (let soc = 0; soc <= 99; soc++) {
    labels.push(`${soc}%`);
    const n = chargeSamples?.[soc] ?? 0;
    sampleCounts.push(n);
    data.push(n >= minSamples ? chargeCurve[soc] * 100 : null);
  }

  for (let soc = 99; soc >= 0; soc--) {
    labels.push(`${soc}%`);
    const n = dischargeSamples?.[soc] ?? 0;
    sampleCounts.push(n);
    data.push(n >= minSamples ? dischargeCurve[soc] * 100 : null);
  }

  const totalPoints = labels.length;
  const curveColor = (ctx = {}) => {
    const parsedX = ctx.p0?.parsed?.x;
    const idx = Number.isFinite(parsedX) ? parsedX : (Number.isFinite(ctx.dataIndex) ? ctx.dataIndex : 0);
    return idx < 100 ? 'rgb(34, 197, 94)' : 'rgb(249, 115, 22)';
  };

  renderChart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Prediction accuracy',
          data,
          borderColor: curveColor,
          segment: {
            borderColor: (ctx) => ctx.p0DataIndex < 100 ? 'rgb(34, 197, 94)' : 'rgb(249, 115, 22)',
          },
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2,
          spanGaps: false,
          fill: false,
        },
        {
          label: 'Baseline (100%)',
          data: new Array(totalPoints).fill(100),
          borderColor: 'rgba(100, 116, 139, 0.3)',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'SoC lifecycle',
          data: Array.from({ length: totalPoints }, (_, i) => {
            const mid = totalPoints / 2;
            const normalized = i < mid ? i / mid : (totalPoints - i) / mid;
            return 50 + normalized * 58;
          }),
          borderColor: 'rgba(100, 116, 139, 0.15)',
          backgroundColor: 'rgba(100, 116, 139, 0.04)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            generateLabels: () => [
              { text: 'Charge', fillStyle: 'rgb(34, 197, 94)', strokeStyle: 'rgb(34, 197, 94)', lineWidth: 2 },
              { text: 'Discharge', fillStyle: 'rgb(249, 115, 22)', strokeStyle: 'rgb(249, 115, 22)', lineWidth: 2 },
              { text: 'Baseline', fillStyle: 'transparent', strokeStyle: 'rgba(100,116,139,0.3)', lineWidth: 1, lineDash: [4, 4] },
              { text: 'SoC lifecycle', fillStyle: 'rgba(100,116,139,0.04)', strokeStyle: 'rgba(100,116,139,0.15)', lineWidth: 2 },
            ],
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0]?.dataIndex ?? 0;
              const phase = i < 100 ? 'Charging' : 'Discharging';
              return `${phase} @ ${labels[i]} SoC`;
            },
            afterLabel: (ctx) => {
              if (ctx.datasetIndex >= 1) return '';
              const n = sampleCounts[ctx.dataIndex] ?? 0;
              return `${n} sample${n !== 1 ? 's' : ''}`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Charge 0→100%                              Discharge 100→0%' },
          ticks: {
            maxTicksLimit: 11,
            callback: (_v, i) => {
              if (i === 0) return '0%';
              if (i === 99 || i === 100) return '100%';
              if (i === totalPoints - 1) return '0%';
              if (i < 100 && i % 20 === 0) return `${i}%`;
              if (i > 100 && (totalPoints - 1 - i) % 20 === 0) return `${200 - 1 - i}%`;
              return '';
            },
          },
        },
        y: {
          title: { display: true, text: 'Prediction accuracy %' },
          min: 50,
          max: 110,
        },
      },
    },
  });
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
