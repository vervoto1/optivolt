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
  hydrateSettingsKeys,
  settingsKeysForElement,
  snapshotUI,
  updatePlanMeta,
  updateRebalanceNudgeUI,
  updateSummaryUI,
} from "./state.js";

// True when a server error message is about `key` ("dischargeEfficiency_percent
// must be …", "cvPhase.thresholds[0].soc_percent …").
function messageNamesSetting(message, key) {
  return typeof message === "string"
    && (message === key || [" ", ".", "["].some((sep) => message.startsWith(key + sep)));
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

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
    hydrateSettingsKeys,
    // Called after controls were refilled from the server, so copies of them
    // elsewhere on the page (the pinned quick-settings fields) can follow.
    onSettingsRehydrated: () => {},
    settingsKeysForElement,
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
  // Settings keys the user edited in this tab and that no successful save
  // has carried yet, each with the generation of its latest edit. A save
  // sends the form's current value for exactly these keys, whatever value the
  // server may hold: a field the user never touched here is never sent, so a
  // value the server changed on its own (rebalancing switched off after a hold
  // cycle, stepSize_m or system limits from a VRM refresh, an edit in another
  // tab) is not reverted by a form that still shows the old one, and a value
  // the user did set is always sent, even when it matches an older one.
  const dirtyKeys = new Map();
  let editGeneration = 0;
  // How many saves have started with each key, so a plan solved before a
  // save of that key does not overwrite it (see syncRebalanceFromPlan).
  const saveStarts = new Map();
  // Saves run one at a time, in order, so they cannot complete out of order.
  let saveChain = Promise.resolve();
  // Server values not yet shown because the control was being typed in
  // (key -> stored value); shown once the user leaves it without editing.
  const pendingRefill = new Map();

  const debounceRun = deps.debounce(onRun, 250);
  // The form is read when the debounce fires, not when it was queued, so a
  // save never carries form values older than a rehydrate in between.
  const persistConfigDebounced = deps.debounce(() => {
    void persistConfig();
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

    let settingsError = null;
    try {
      // A rejected save (e.g. a 400 for a blank efficiency field) does not
      // stop the solve, which then runs on the settings already stored. The
      // rejection must stay on screen though: the success label below would
      // otherwise replace it, and every later edit would be dropped unseen.
      settingsError = await savePendingConfig();

      const updateData = !!els.updateDataBeforeRun?.checked;
      const writeToVictron = !!els.pushToVictron?.checked;
      const rebalanceSavesAtSolve = saveStarts.get("rebalanceEnabled") ?? 0;
      const result = await deps.requestRemoteSolve({ updateData, writeToVictron });
      syncRebalanceFromPlan(result?.summary?.rebalanceStatus, rebalanceSavesAtSolve);

      const solverStatus =
        typeof result?.solverStatus === "string" ? result.solverStatus : "OK";
      updateRunStatus(solverStatus, writeToVictron);
      // The plan is solved (and, if asked, already written) by now: a panel
      // that fails to draw must not turn that into an "Error" or blank the
      // summary, so render failures are reported separately.
      const renderFailures = renderPlanResult(result);
      if (renderFailures.length > 0) {
        showDisplayFailure(
          isNonOptimal(solverStatus)
            ? `Plan status: ${solverStatus}`
            : writeToVictron ? "Plan calculated and sent to Victron" : "Plan calculated",
          renderFailures,
        );
      }
      if (settingsError != null) showSettingsNotSaved(settingsError);
    } catch (err) {
      console.error(err);
      if (els.status) {
        const notSaved = settingsError != null ? ` (settings not saved: ${settingsError})` : "";
        els.status.textContent = `Error: ${err.message}${notSaved}`;
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
  // Each panel renders on its own, so one that throws cannot stop the rest.
  // Returns the failures as "panel: message" strings (empty when all drew).
  function renderPlanResult(result) {
    const failures = [];
    const renderGuarded = (panel, draw) => {
      try {
        draw();
      } catch (err) {
        console.error(`Failed to render ${panel}:`, err);
        failures.push(`${panel}: ${err?.message ?? err}`);
      }
    };

    const rows = Array.isArray(result?.rows) ? result.rows : [];

    renderGuarded("plan info", () => deps.updatePlanMeta(els, result.initialSoc_percent, result.tsStart));
    renderGuarded("summary", () => deps.updateSummaryUI(els, result.summary));
    renderGuarded("rebalance notice", () => deps.updateRebalanceNudgeUI(els, result.rebalanceNudge));

    const cfgForViz = getVizConfig();
    let evSettings = null;
    renderGuarded("EV settings", () => { evSettings = getEvSettings(); });

    lastTableRows = rows;
    lastTableRebalanceWindow = result?.rebalanceWindow ?? null;
    renderGuarded("schedule", () => renderScheduleTable());

    // When the car is disconnected the real plan has no EV; the backend then
    // returns evPreview — the schedule as it would be if plugged in now. It is
    // display-only (never applied to Victron) and is confined to the EV tab. The
    // optimizer overview reflects only the real plan, so the overview charts are
    // NOT given the preview: the overview SoC chart shows an EV-SoC line only when
    // the car is actually in the plan (its EV SoC lives in `rows`).
    const evPreview = result?.evPreview ?? null;
    renderAllCharts(rows, cfgForViz, result?.rebalanceWindow ?? null, evSettings, null, renderGuarded);
    renderGuarded("EV panel", () => deps.updateEvPanel(
      els,
      evPreview?.rows ?? rows,
      evPreview?.summary ?? result?.summary,
      cfgForViz.stepSize_m,
      evPreview,
    ));
    return failures;
  }

  // Amber notice: the plan itself is fine, only some of its display failed.
  function showDisplayFailure(prefix, failures) {
    if (!els.status) return;
    const more = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
    els.status.textContent = `${prefix}, but display failed: ${failures[0]}${more}`;
    els.status.className = "text-sm font-medium text-amber-600 dark:text-amber-400";
  }

  // Red notice put in front of whatever the run reported: the plan on screen
  // was computed from the previously stored settings, not the edited form.
  function showSettingsNotSaved(message) {
    if (!els.status) return;
    els.status.textContent =
      `Settings not saved: ${message}. ${els.status.textContent} (using the previously saved settings)`;
    els.status.className = "text-sm font-medium text-red-600 dark:text-red-400";
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

    // A render failure still returns { ageMs }: falling back to a solve would
    // only hit the same failure on an identical payload.
    const renderFailures = renderPlanResult(result);

    const ageMs = Number.isFinite(result.computedAtMs)
      ? Math.max(0, Date.now() - result.computedAtMs)
      : Infinity;

    const solverStatus =
      typeof result.solverStatus === "string" ? result.solverStatus : "OK";
    if (renderFailures.length > 0) {
      showDisplayFailure(
        isNonOptimal(solverStatus)
          ? `Plan status: ${solverStatus}`
          : `Plan loaded (${formatPlanAge(ageMs)})`,
        renderFailures,
      );
    } else if (els.status) {
      if (isNonOptimal(solverStatus)) {
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

  // Each chart draws inside `renderGuarded` (see renderPlanResult).
  function renderAllCharts(rows, cfg, rebalanceWindow, evSettings, evSocRows, renderGuarded) {
    lastFlowsRenderData = { rows, cfg, rebalanceWindow, evSettings };
    renderGuarded("energy flows chart", () => deps.drawFlowsBarStackSigned(
      els.flows, rows, cfg.stepSize_m, rebalanceWindow, evSettings, flowsAggregateMinutes(),
    ));
    renderGuarded("SoC chart", () => deps.drawSocChart(els.soc, rows, cfg.stepSize_m, evSettings, evSocRows));
    renderGuarded("prices chart", () => deps.drawPricesStepLines(els.prices, rows, cfg.stepSize_m));
    renderGuarded("load/PV chart", () => deps.drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m));
  }

  function onFlowsAggregationChange() {
    if (!lastFlowsRenderData) return;
    const { rows, cfg, rebalanceWindow, evSettings } = lastFlowsRenderData;
    deps.drawFlowsBarStackSigned(
      els.flows, rows, cfg.stepSize_m, rebalanceWindow, evSettings, flowsAggregateMinutes(),
    );
  }

  // Mark settings keys as edited by the user in this tab.
  function markSettingsDirty(...keys) {
    for (const key of keys) {
      dirtyKeys.set(key, ++editGeneration);
      // The user's value now wins over a server value waiting to be shown.
      pendingRefill.delete(key);
    }
  }

  // The settings keys of a control: those read from it, or, for a pinned
  // quick-settings copy, the key of the field it copies.
  function keysOfControl(control) {
    if (!control || typeof control !== "object") return new Set();
    const keys = new Set(deps.settingsKeysForElement(els, control));
    const mirrorOf = control.dataset?.optimizerQuickMirror;
    if (mirrorOf) keys.add(mirrorOf);
    return keys;
  }

  // Keys whose control the user is in right now. Refilling it would move the
  // caret or undo what is being typed.
  function keysBeingEdited() {
    if (typeof document === "undefined") return new Set();
    const focused = document.activeElement;
    if (!focused || focused === document.body) return new Set();
    return keysOfControl(focused);
  }

  // Listen (capturing, so before any control's own handler queues a save)
  // for user edits anywhere under `root` and mark the settings keys read
  // from the edited control. Setting a control's value from code fires no
  // event, so hydrating the form (page load, VRM refresh) marks nothing.
  // When the user leaves a control, show a server value that was held back
  // while it had focus.
  function trackSettingsEdits(root = document) {
    const onEdit = (event) => {
      markSettingsDirty(...deps.settingsKeysForElement(els, event.target));
    };
    root.addEventListener("input", onEdit, true);
    root.addEventListener("change", onEdit, true);
    root.addEventListener("focusout", (event) => {
      const left = [...keysOfControl(event.target)].filter((key) => pendingRefill.has(key));
      if (left.length === 0) return;
      // Run once focus has moved on, so the next focused control is known.
      setTimeout(() => rehydrateFromServer(Object.fromEntries(pendingRefill), left), 0);
    }, true);
  }

  // Queue a save of the edited keys behind any save still running. Resolves
  // to the error message when the save failed, else null (also when there was
  // nothing to save).
  function savePendingConfig() {
    const run = saveChain.then(saveDirtySettings);
    // saveDirtySettings never rejects; this keeps the chain alive even if it
    // ever did, so one broken save cannot block every later one.
    saveChain = run.catch(() => null);
    return run;
  }

  // POST the edited keys' current form values as a partial patch; the server
  // merges it onto its current settings. On success each key is clean again
  // unless it was edited while the request ran, and its controls are
  // rehydrated from the stored settings in the response so server-side
  // normalisation (rounding, clamps) shows. A key the server rejects stays
  // edited, so the next save sends it again; the rest of the patch is still
  // saved (see saveKeys). Never rejects.
  async function saveDirtySettings() {
    try {
      return await sendDirtySettings();
    } catch (error) {
      console.error("Failed to persist settings", error);
      return error?.message ?? String(error);
    }
  }

  async function sendDirtySettings() {
    if (dirtyKeys.size === 0) return null;
    const form = deps.snapshotUI(els);
    const generations = new Map(dirtyKeys);
    const keys = [];
    for (const key of dirtyKeys.keys()) {
      if (hasOwn(form, key)) keys.push(key);
      // No form value (a cleared HA token: "keep the stored one"): nothing to send.
      else dirtyKeys.delete(key);
    }
    if (keys.length === 0) return null;
    for (const key of keys) saveStarts.set(key, (saveStarts.get(key) ?? 0) + 1);

    const { saved, failures, stored } = await saveKeys(keys, form);

    const settled = [];
    for (const key of saved) {
      pendingRefill.delete(key);
      if (dirtyKeys.get(key) !== generations.get(key)) continue; // edited again meanwhile
      dirtyKeys.delete(key);
      settled.push(key);
    }
    if (stored) rehydrateFromServer(stored, settled);
    if (failures.length === 0) return null;
    return [...new Set(failures.map((failure) => failure.message))].join("; ");
  }

  // POST `keys` as one patch. When the server rejects it (400), save what it
  // did not object to: the keys the error message names are set aside and
  // the rest is sent again; when it names none, each key is sent on its own.
  // So one invalid field (a cleared efficiency, or a min SoC typed above the
  // max) cannot hold back a safety switch such as "Write to Victron" saved
  // with it. Network and server errors keep everything for the next save.
  async function saveKeys(keys, form) {
    const result = { saved: [], failures: [], stored: null };
    const attempt = async (list) => {
      const patch = {};
      for (const key of list) patch[key] = form[key];
      try {
        const response = await deps.saveConfig(patch);
        result.saved.push(...list);
        if (response?.settings && typeof response.settings === "object") result.stored = response.settings;
      } catch (error) {
        const message = error?.message ?? String(error);
        if (error?.status !== 400 || list.length === 1) {
          console.error("Failed to persist settings", error);
          result.failures.push({ keys: list, message });
          return;
        }
        const named = list.filter((key) => messageNamesSetting(message, key));
        if (named.length > 0 && named.length < list.length) {
          console.error("Failed to persist settings", error);
          result.failures.push({ keys: named, message });
          await attempt(list.filter((key) => !named.includes(key)));
        } else {
          for (const key of list) await attempt([key]);
        }
      }
    };
    await attempt(keys);
    return result;
  }

  // Refill the controls of `keys` from the server's `settings`. A key with an
  // unsaved edit is skipped; a key whose control has focus is skipped too,
  // and its value is shown when the user leaves the control.
  function rehydrateFromServer(settings, keys) {
    const editing = keysBeingEdited();
    const refill = [];
    for (const key of keys) {
      if (!hasOwn(settings, key) || dirtyKeys.has(key)) continue;
      if (editing.has(key)) {
        pendingRefill.set(key, settings[key]);
        continue;
      }
      pendingRefill.delete(key);
      refill.push(key);
    }
    if (refill.length === 0) return;
    deps.hydrateSettingsKeys(els, settings, refill);
    deps.onSettingsRehydrated();
  }

  // Fill the form from settings the server sent unasked (e.g. the reply of
  // "Refresh from VRM"), leaving every control with an unsaved edit alone so
  // the user's pending change is neither lost nor overwritten on screen.
  function hydrateServerSettings(settings) {
    if (!settings || typeof settings !== "object") return;
    rehydrateFromServer(settings, Object.keys(settings));
  }

  async function persistConfig() {
    const settingsError = await savePendingConfig();
    if (settingsError != null && els.status) {
      els.status.textContent = `Settings error: ${settingsError}`;
      els.status.className = "text-sm font-medium text-red-600 dark:text-red-400";
    }
  }

  function queuePersistSnapshot() {
    persistConfigDebounced();
  }

  // The server switches rebalancing off by itself once a hold cycle completes
  // or gives up; a freshly solved plan reports that through its summary's
  // rebalanceStatus ("disabled" when off). Mirror it into the checkbox so this
  // tab stops showing a stale "on" (which also hides the rebalance notice).
  // The checkbox is left alone while the user's edit of it is unsaved, or when
  // a save of it started while the solve ran (the plan then predates that
  // save). Cached plans are never used: they can predate the settings.
  function syncRebalanceFromPlan(rebalanceStatus, savesAtSolve) {
    const checkbox = els.rebalanceEnabled;
    if (!checkbox) return;
    if (!["disabled", "scheduled", "active"].includes(rebalanceStatus)) return;
    if (dirtyKeys.has("rebalanceEnabled")) return;
    if ((saveStarts.get("rebalanceEnabled") ?? 0) !== savesAtSolve) return;
    checkbox.checked = rebalanceStatus !== "disabled";
  }

  function updateRunStatus(solverStatus, writeToVictron) {
    if (!els.status) return;

    const nonOptimal = isNonOptimal(solverStatus);

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
    hydrateServerSettings,
    markSettingsDirty,
    onFlowsAggregationChange,
    onRun,
    onTableDisplayChange,
    persistConfig,
    persistConfigDebounced,
    queuePersistSnapshot,
    renderScheduleTable,
    trackSettingsEdits,
  };
}

function isNonOptimal(solverStatus) {
  return typeof solverStatus === "string" && solverStatus.toLowerCase() !== "optimal";
}

function formatPlanAge(ageMs) {
  /* age is Infinity when the cached plan carries no computedAtMs */
  if (!Number.isFinite(ageMs)) return "age unknown";
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 1) return "just now";
  return `${minutes} min ago`;
}
