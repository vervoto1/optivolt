import {
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./charts.js";
import { renderTable } from "./table.js";
import { debounce, resolveDepartureMs, effectiveTargetSoc } from "./utils.js";
import { saveConfig } from "./config-store.js";
import { fetchLastPlan, requestRemoteSolve } from "./api/api.js";
import { updateEvPanel } from "./ev-tab.js";
import {
  snapshotUI,
  updatePlanMeta,
  updateRebalanceNudgeUI,
  updateSummaryUI,
} from "./state.js";

export function createOptimizerController({ els, services = {} }) {
  const deps = {
    debounce,
    drawFlowsBarStackSigned,
    drawLoadPvGrouped,
    drawPricesStepLines,
    drawSocChart,
    fetchLastPlan,
    renderTable,
    requestRemoteSolve,
    saveConfig,
    snapshotUI,
    updateEvPanel,
    updatePlanMeta,
    updateRebalanceNudgeUI,
    updateSummaryUI,
    ...services,
  };

  let lastTableRows = [];
  let lastTableRebalanceWindow = null;
  let lastFlowsRenderData = null;
  let lastPersistedConfigJson = null;

  const debounceRun = deps.debounce(onRun, 250);
  const persistConfigDebounced = deps.debounce((cfg) => {
    void persistConfig(cfg);
  }, 600);

  async function onRun() {
    if (typeof persistConfigDebounced.cancel === "function") {
      persistConfigDebounced.cancel();
    }

    if (els.status) {
      els.status.textContent = "Calculating…";
      els.status.className = "text-sm font-medium text-ink dark:text-slate-100";
    }

    const runBtn = els.run;
    if (runBtn) {
      runBtn.classList.add('loading');
      runBtn.disabled = true;
    }

    try {
      await persistConfig();

      const updateData = !!els.updateDataBeforeRun?.checked;
      const writeToVictron = !!els.pushToVictron?.checked;
      const result = await deps.requestRemoteSolve({ updateData, writeToVictron });

      const solverStatus =
        typeof result?.solverStatus === "string" ? result.solverStatus : "OK";
      updateRunStatus(solverStatus, writeToVictron);
      renderPlanResult(result);
    } catch (err) {
      console.error(err);
      if (els.status) {
        els.status.textContent = `Error: ${err.message}`;
        els.status.className = "text-sm font-medium text-red-600 dark:text-red-400";
      }
      deps.updateSummaryUI(els, null);
    } finally {
      if (runBtn) {
        runBtn.classList.remove('loading');
        runBtn.disabled = false;
      }
    }
  }

  // Render everything a solved (or cached) plan drives: plan meta, summary,
  // rebalance nudge, schedule table, overview charts, and the EV panel.
  function renderPlanResult(result) {
    const rows = Array.isArray(result?.rows) ? result.rows : [];

    deps.updatePlanMeta(els, result.initialSoc_percent, result.tsStart);
    deps.updateSummaryUI(els, result.summary);
    deps.updateRebalanceNudgeUI(els, result.rebalanceNudge);

    const cfgForViz = getVizConfig();
    const evSettings = getEvSettings();

    lastTableRows = rows;
    lastTableRebalanceWindow = result.rebalanceWindow ?? null;
    renderScheduleTable();

    // When the car is disconnected the real plan has no EV; the backend then
    // returns evPreview — the schedule as it would be if plugged in now. It is
    // display-only (never applied to Victron) and is confined to the EV tab. The
    // optimizer overview reflects only the real plan, so the overview charts are
    // NOT given the preview: the overview SoC chart shows an EV-SoC line only when
    // the car is actually in the plan (its EV SoC lives in `rows`).
    const evPreview = result.evPreview ?? null;
    renderAllCharts(rows, cfgForViz, result.rebalanceWindow ?? null, evSettings);
    deps.updateEvPanel(
      els,
      evPreview?.rows ?? rows,
      evPreview?.summary ?? result.summary,
      cfgForViz.stepSize_m,
      evPreview,
    );
  }

  // Hydrate the UI from the server's cached plan (kept fresh by auto-calculate)
  // without triggering a solve. Returns { ageMs } when a plan was rendered, or
  // null when none is available (fresh server start, or the fetch failed) so
  // the caller can fall back to a full solve.
  async function hydrateFromCachedPlan() {
    let result;
    try {
      result = await deps.fetchLastPlan();
    } catch {
      return null;
    }
    if (!Array.isArray(result?.rows) || result.rows.length === 0) return null;

    renderPlanResult(result);

    const ageMs = Number.isFinite(result.computedAtMs)
      ? Math.max(0, Date.now() - result.computedAtMs)
      : Infinity;

    if (els.status) {
      const solverStatus =
        typeof result.solverStatus === "string" ? result.solverStatus : "OK";
      if (solverStatus.toLowerCase() !== "optimal") {
        els.status.textContent = `Plan status: ${solverStatus}`;
        els.status.className = "text-sm font-medium text-amber-600 dark:text-amber-400";
      } else {
        els.status.textContent = `Plan loaded (${formatPlanAge(ageMs)})`;
        els.status.className = "text-sm font-medium text-emerald-600 dark:text-emerald-400";
      }
    }
    return { ageMs };
  }

  function onTableDisplayChange(event) {
    if (!renderScheduleTable()) {
      void onRun();
      return;
    }
    if (event?.currentTarget === els.tableKwh) {
      queuePersistSnapshot();
    }
  }

  function renderScheduleTable() {
    if (!lastTableRows.length) return false;
    deps.renderTable({
      rows: lastTableRows,
      cfg: getVizConfig(),
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
      showDess: !!els.tableDess?.checked,
      rebalanceWindow: lastTableRebalanceWindow,
      evSettings: getEvSettings(),
    });
    return true;
  }

  function flowsAggregateMinutes() {
    return els.flows15m?.checked ? null : 60;
  }

  function renderAllCharts(rows, cfg, rebalanceWindow = null, evSettings = null, evSocRows = null) {
    lastFlowsRenderData = { rows, cfg, rebalanceWindow, evSettings };
    deps.drawFlowsBarStackSigned(
      els.flows, rows, cfg.stepSize_m, rebalanceWindow, evSettings, flowsAggregateMinutes(),
    );
    deps.drawSocChart(els.soc, rows, cfg.stepSize_m, evSettings, evSocRows);
    deps.drawPricesStepLines(els.prices, rows, cfg.stepSize_m);
    deps.drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
  }

  function onFlowsAggregationChange() {
    if (!lastFlowsRenderData) return;
    const { rows, cfg, rebalanceWindow, evSettings } = lastFlowsRenderData;
    deps.drawFlowsBarStackSigned(
      els.flows, rows, cfg.stepSize_m, rebalanceWindow, evSettings, flowsAggregateMinutes(),
    );
  }

  async function persistConfig(cfg = deps.snapshotUI(els)) {
    // Skip the POST when nothing changed since the last successful persist —
    // notably the unconditional persist at the start of the boot-time run.
    const json = JSON.stringify(cfg);
    if (json === lastPersistedConfigJson) return;
    try {
      await deps.saveConfig(cfg);
      lastPersistedConfigJson = json;
    } catch (error) {
      console.error("Failed to persist settings", error);
      if (els.status) els.status.textContent = `Settings error: ${error.message}`;
    }
  }

  // Record the current UI snapshot as already-persisted. Called after boot
  // hydrates the inputs from the server, so the settings the server just sent
  // are not immediately POSTed straight back to it.
  function seedPersistedConfig() {
    lastPersistedConfigJson = JSON.stringify(deps.snapshotUI(els));
  }

  function queuePersistSnapshot() {
    persistConfigDebounced(deps.snapshotUI(els));
  }

  function updateRunStatus(solverStatus, writeToVictron) {
    if (!els.status) return;

    const nonOptimal =
      typeof solverStatus === "string" &&
      solverStatus.toLowerCase() !== "optimal";

    let label;
    let colorClass = "text-emerald-600 dark:text-emerald-400";

    if (nonOptimal) {
      label = `Plan status: ${solverStatus}`;
      colorClass = "text-amber-600 dark:text-amber-400";
    } else if (writeToVictron) {
      label = "Plan updated and sent to Victron";
    } else {
      label = "Plan updated";
    }
    els.status.textContent = label;
    els.status.className = `text-sm font-medium ${colorClass}`;
  }

  function getVizConfig() {
    return {
      stepSize_m: Number(els.step?.value),
      batteryCapacity_Wh: Number(els.cap?.value),
    };
  }

  function getEvSettings() {
    return els.evEnabled?.checked ? {
      departureTime: resolveDepartureMs(els.evDepartureTime?.value, els.evDepartureDay?.value),
      targetSoc_percent: effectiveTargetSoc(els.evTargetSocEntityValue?.dataset.haState, els.evTargetSoc?.value),
    } : null;
  }

  return {
    debounceRun,
    hydrateFromCachedPlan,
    onFlowsAggregationChange,
    onRun,
    onTableDisplayChange,
    persistConfig,
    persistConfigDebounced,
    queuePersistSnapshot,
    renderScheduleTable,
    seedPersistedConfig,
  };
}

function formatPlanAge(ageMs) {
  /* age is Infinity when the cached plan carries no computedAtMs */
  if (!Number.isFinite(ageMs)) return "age unknown";
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 1) return "just now";
  return `${minutes} min ago`;
}
