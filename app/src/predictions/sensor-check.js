/**
 * sensor-check.js
 *
 * Per-entity check of the prediction sensors (Settings → Sensors card)
 * against Home Assistant: does each entity exist, is its state numeric, does
 * HA's unit match the configured one, and does every derived formula term
 * name a known sensor. The server does the work in one HA request
 * (`POST /predictions/sensors/check`); this module only renders it.
 *
 * Advisory only: a failed check, or an HA that cannot be reached, never
 * blocks or undoes a save; it is shown as a warning.
 *
 * Runs on demand (the Check button), after an edit to either JSON editor is
 * committed (its change event), and once quietly when the form is wired.
 * Every edit invalidates a check still in flight, so a slow reply for the
 * old text cannot label the new one.
 */

import { checkPredictionSensors } from '../api/api.js';

const LINE = 'block';
const TONE = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
  neutral: 'text-slate-500 dark:text-slate-400',
};

let checkSeq = 0;

function statusEl() {
  return document.getElementById('pred-sensor-status');
}

function parseOrNull(id) {
  const raw = document.getElementById(id)?.value ?? '';
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function line(text, tone) {
  const el = document.createElement('span');
  el.className = `${LINE} ${TONE[tone]}`;
  el.textContent = text;
  return el;
}

function describeSensor(s) {
  const reading = s.state == null ? '' : ` = ${s.state}${s.unit ? ` ${s.unit}` : ''}`;
  const head = `${s.status === 'ok' ? '✓' : s.status === 'warning' ? '!' : '✗'} ${s.name} (${s.id})${reading}`;
  return s.messages.length > 0 ? `${head}: ${s.messages.join('; ')}` : head;
}

/** Render a `POST /predictions/sensors/check` result into the status block. */
export function renderSensorCheck(result) {
  const el = statusEl();
  if (!el) return;
  el.replaceChildren();
  if (!result.reachable) {
    el.appendChild(line(
      `Could not reach Home Assistant to check the sensors (${result.error ?? 'unknown error'}). Saving is not affected.`,
      'warning',
    ));
  }
  for (const s of result.sensors ?? []) {
    // Without HA only config-side problems are known; an unchecked sensor
    // with none of those is not "ok", just unchecked.
    const tone = !s.checked && s.status === 'ok' ? 'neutral' : s.status;
    el.appendChild(line(s.checked || s.messages.length > 0 ? describeSensor(s) : `${s.name} (${s.id}): not checked`, tone));
  }
  for (const d of result.derived ?? []) {
    if (d.status === 'ok') continue;
    el.appendChild(line(`✗ Derived ${d.name}: ${d.messages.join('; ')}`, 'error'));
  }
}

/**
 * Check the editors' current sensors/derived. `quiet` skips the "Checking…"
 * placeholder and leaves the block untouched on a request error (the wiring
 * call on tab open must not paint an error for a transient blip).
 */
export async function runSensorCheck({ quiet = false } = {}) {
  const el = statusEl();
  if (!el) return null;
  const sensors = parseOrNull('pred-sensors');
  const derived = parseOrNull('pred-derived');
  const seq = ++checkSeq;
  if (sensors === undefined || derived === undefined) {
    el.replaceChildren(line('Sensors or Derived is not valid JSON; fix it before checking.', 'error'));
    return null;
  }
  const body = {
    ...(Array.isArray(sensors) ? { sensors } : {}),
    ...(Array.isArray(derived) ? { derived } : {}),
  };
  if (!quiet) el.replaceChildren(line('Checking sensors in Home Assistant…', 'neutral'));
  try {
    const result = await checkPredictionSensors(body);
    if (seq !== checkSeq) return null;
    renderSensorCheck(result);
    return result;
  } catch (err) {
    if (seq !== checkSeq) return null;
    if (!quiet) el.replaceChildren(line(`Sensor check failed: ${err.message}`, 'warning'));
    return null;
  }
}

/** Drop any check in flight and clear the stale result (the text it describes just changed). */
function invalidateSensorCheck() {
  checkSeq++;
  statusEl()?.replaceChildren();
}

export function wireSensorCheck() {
  document.getElementById('pred-sensor-check')?.addEventListener('click', () => { void runSensorCheck(); });
  for (const id of ['pred-sensors', 'pred-derived']) {
    const el = document.getElementById(id);
    el?.addEventListener('input', invalidateSensorCheck);
    el?.addEventListener('change', () => { void runSensorCheck(); });
  }
  void runSensorCheck({ quiet: true });
}
