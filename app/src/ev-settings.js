import { fetchHaEntityState } from "./api/api.js";
import { carChargeLimit } from "./utils.js";

const SENSOR_IND_BASE = "mt-1 block text-xs";
const SENSOR_IND_NEUTRAL = `${SENSOR_IND_BASE} text-slate-500 dark:text-slate-400`;
const SENSOR_IND_SUCCESS = `${SENSOR_IND_BASE} text-emerald-600 dark:text-emerald-400`;
const SENSOR_IND_ERROR = `${SENSOR_IND_BASE} text-red-600 dark:text-red-400`;

// Every HA entity input that shows a live "Current value:" readout below it.
// `afterUpdate` runs side effects tied to a specific reading (e.g. the car's
// charge limit feeding the Target SoC field); most entries have none.
function sensorEntries(els) {
  return [
    { input: els.evSocSensor, indicator: els.evSocValue },
    { input: els.evPlugSensor, indicator: els.evPlugValue },
    { input: els.evTargetSocEntity, indicator: els.evTargetSocEntityValue, afterUpdate: () => applyCarChargeLimit(els) },
    { input: els.evChargerSwitchEntity, indicator: els.evChargerSwitchValue },
    { input: els.evChargerCurrentEntity, indicator: els.evChargerCurrentValue },
  ];
}

async function readSensorState({ input, indicator }) {
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
}

export async function refreshEvSensorStates(els) {
  await Promise.allSettled(sensorEntries(els).map(readSensorState));
  applyCarChargeLimit(els);
}

// Keep the Target SoC field on the car's charge limit. The server plans to the
// live limit whenever it can read it, so the field should show that number, and
// it is also the fallback when HA is unreachable: the last limit read from the
// car is a better fallback than a value typed before it changed. The quick-set
// button re-reads the limit and loads it, even into a focused field.
function applyCarChargeLimit(els, { force = false } = {}) {
  const btn = els.evTargetSocQuickSet;
  const field = els.evTargetSoc;
  const limit = carChargeLimit(els.evTargetSocEntityValue?.dataset.haState);

  if (btn) {
    if (limit != null) {
      btn.disabled = false;
      btn.title = `Set to the car's charge limit (${Math.round(limit)}%)`;
      btn.onclick = async () => {
        await readSensorState({ input: els.evTargetSocEntity, indicator: els.evTargetSocEntityValue });
        applyCarChargeLimit(els, { force: true });
      };
    } else {
      btn.disabled = true;
      btn.title = "Configure the car's charge-limit entity first";
      btn.onclick = null;
    }
  }

  if (!field || limit == null) return;
  // Don't overwrite a value the user is typing, except on an explicit click.
  if (!force && document.activeElement === field) return;
  const rounded = String(Math.round(limit));
  if (field.value === rounded) return;
  field.value = rounded;
  // Through the input event, like a user edit: saves the setting and re-solves.
  field.dispatchEvent(new Event('input', { bubbles: true }));
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
