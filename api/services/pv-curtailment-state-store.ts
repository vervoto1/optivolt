import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, resolveDataDir } from './json-store.ts';

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
let tmpCounter = 0;

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

/**
 * The persisted ownership record; null when there is none; 'unreadable' when the file
 * exists but cannot be parsed or validated (e.g. truncated by a power loss). An unreadable
 * record still means a disable may be in place: the caller restores with its current
 * settings, since Pv/Disable=0 is the safe direction.
 */
export async function loadPvCurtailmentState(): Promise<PvCurtailmentPersistedState | 'unreadable' | null> {
  let raw: unknown;
  try {
    raw = await readJson<unknown>(statePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`[pv-curtailment] unreadable ${FILE_NAME}:`, (err as Error).message);
    return 'unreadable';
  }
  if (!isTarget(raw)) {
    console.warn(`[pv-curtailment] malformed ${FILE_NAME}`);
    return 'unreadable';
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

/**
 * Durable write: the record has to survive a power loss right after a Pv/Disable=1, so
 * the temp file is fsynced before the rename and the directory after it (a plain
 * writeFile + rename of a new file can come back empty after a crash).
 */
export async function savePvCurtailmentState(state: PvCurtailmentPersistedState): Promise<void> {
  const file = statePath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    const handle = await fs.open(tmpPath, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, file);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  await syncDir(dir);
}

/** fsync a directory so a rename in it is durable. Best effort: not every platform allows it. */
async function syncDir(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch (err) {
    console.debug(`[pv-curtailment] could not fsync ${dir}:`, (err as Error).message);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function clearPvCurtailmentState(): Promise<void> {
  await fs.rm(statePath(), { force: true });
}
