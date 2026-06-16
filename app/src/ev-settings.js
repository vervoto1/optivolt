import { fetchHaEntityState } from "./api/api.js";

const SENSOR_IND_BASE = "mt-1 block text-xs";
const SENSOR_IND_NEUTRAL = `${SENSOR_IND_BASE} text-slate-500 dark:text-slate-400`;
const SENSOR_IND_SUCCESS = `${SENSOR_IND_BASE} text-emerald-600 dark:text-emerald-400`;
const SENSOR_IND_ERROR = `${SENSOR_IND_BASE} text-red-600 dark:text-red-400`;

// Every HA entity input that shows a live "Current value:" readout below it.
// `afterUpdate` runs side effects tied to a specific reading (e.g. the EV SoC
// quick-set button); most entries have none.
function sensorEntries(els) {
  return [
    { input: els.evSocSensor, indicator: els.evSocValue, afterUpdate: () => updateEvSocQuickSet(els) },
    { input: els.evPlugSensor, indicator: els.evPlugValue },
    { input: els.evChargerSwitchEntity, indicator: els.evChargerSwitchValue },
    { input: els.evChargerCurrentEntity, indicator: els.evChargerCurrentValue },
  ];
}

export async function refreshEvSensorStates(els) {
  await Promise.allSettled(sensorEntries(els).map(async ({ input, indicator }) => {
    const entityId = input?.value?.trim();
    if (!entityId || !indicator) return;
    try {
      const state = await fetchHaEntityState(entityId);
      indicator.textContent = `Current value: ${state.state}`;
      indicator.className = SENSOR_IND_SUCCESS;
      indicator.dataset.haState = state.state;
    } catch {
      // HA not configured or entity unavailable - leave indicator as-is
    }
  }));
  updateEvSocQuickSet(els);
}

function updateEvSocQuickSet(els) {
  const btn = els.evTargetSocQuickSet;
  if (!btn) return;
  const soc = parseFloat(els.evSocValue?.dataset.haState);
  if (!isNaN(soc)) {
    const rounded = Math.round(soc);
    btn.disabled = false;
    btn.title = `Set to current EV SoC (${rounded}%)`;
    btn.onclick = () => {
      els.evTargetSoc.value = rounded;
      els.evTargetSoc.dispatchEvent(new Event('input', { bubbles: true }));
    };
  } else {
    btn.disabled = true;
    btn.title = "Configure EV SoC sensor first";
    btn.onclick = null;
  }
}

export function wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun }) {
  for (const { input, indicator, afterUpdate } of sensorEntries(els)) {
    if (!input || !indicator) continue;

    let seq = 0;

    input.addEventListener("input", () => {
      indicator.textContent = "";
      indicator.className = SENSOR_IND_NEUTRAL;
      delete indicator.dataset.haState;
      afterUpdate?.();
    });

    input.addEventListener("blur", async () => {
      const entityId = input.value.trim();
      if (!entityId) {
        indicator.textContent = "";
        return;
      }

      const id = ++seq;

      // Flush immediately so the server has the latest HA credentials before
      // we validate the entity.
      persistConfigDebounced.cancel();
      debounceRun.cancel();
      await persistConfig();

      if (id !== seq) return;

      try {
        const state = await fetchHaEntityState(entityId);
        if (id !== seq) return;
        indicator.textContent = `Current value: ${state.state}`;
        indicator.className = SENSOR_IND_SUCCESS;
        indicator.dataset.haState = state.state;
        afterUpdate?.();
      } catch (err) {
        if (id !== seq) return;
        indicator.textContent = `Error: ${err.message}`;
        indicator.className = SENSOR_IND_ERROR;
        delete indicator.dataset.haState;
        afterUpdate?.();
      }
    });
  }
}
