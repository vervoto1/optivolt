import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, resolveDataDir, writeJson } from './json-store.ts';

/**
 * Write-ahead record of a live `acsystem/<n>/Pv/Disable=1` that OptiVolt owns.
 *
 * Written before the disable is published and deleted only once the restore
 * (`Pv/Disable=0`, Enphase switch back on) has been confirmed, so a restart
 * after a SIGKILL, crash, OOM or power loss can still find and undo it — the
 * in-memory ownership flag alone is lost with the process.
 */
export interface PvDisableTarget {
  serial: string;
  acsystemInstance: number;
  enphaseSwitchEntity: string;
}

export interface PvCurtailmentPersistedState extends PvDisableTarget {
  ownsDisable: true;
  sinceMs: number;
}

const FILE_NAME = 'pv-curtailment-state.json';

function statePath(): string {
  return path.join(resolveDataDir(), FILE_NAME);
}

function isTarget(raw: unknown): raw is PvCurtailmentPersistedState {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  return s.ownsDisable === true
    && typeof s.serial === 'string' && s.serial !== ''
    && typeof s.acsystemInstance === 'number' && Number.isInteger(s.acsystemInstance) && s.acsystemInstance >= 0
    && (s.enphaseSwitchEntity === undefined || typeof s.enphaseSwitchEntity === 'string');
}

/** The persisted ownership record, or null when there is none (or it is unusable). */
export async function loadPvCurtailmentState(): Promise<PvCurtailmentPersistedState | null> {
  let raw: unknown;
  try {
    raw = await readJson<unknown>(statePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`[pv-curtailment] ignoring unreadable ${FILE_NAME}:`, (err as Error).message);
    return null;
  }
  if (!isTarget(raw)) {
    console.warn(`[pv-curtailment] ignoring malformed ${FILE_NAME}`);
    return null;
  }
  const sinceMs = Number((raw as { sinceMs?: unknown }).sinceMs);
  return {
    ownsDisable: true,
    sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0,
    serial: raw.serial,
    acsystemInstance: raw.acsystemInstance,
    enphaseSwitchEntity: raw.enphaseSwitchEntity ?? '',
  };
}

export async function savePvCurtailmentState(state: PvCurtailmentPersistedState): Promise<void> {
  await writeJson(statePath(), state);
}

export async function clearPvCurtailmentState(): Promise<void> {
  await fs.rm(statePath(), { force: true });
}
