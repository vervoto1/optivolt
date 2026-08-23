import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');

let tmpCounter = 0;

/** Tail of the update chain per resolved path (see `withJsonLock`). */
const locks = new Map<string, Promise<unknown>>();

export function resolveDataDir(envVar = 'DATA_DIR'): string {
  return path.resolve(process.env[envVar] ?? DEFAULT_DATA_DIR);
}

export async function readJson<T>(filePath: string): Promise<T> {
  const txt = await fs.readFile(filePath, 'utf8');
  return JSON.parse(txt) as T;
}

/**
 * Atomic write: serialise to a temp file in the same directory, then rename
 * over the target. The temp name is unique per call — the same target can be
 * written concurrently (the prediction config by a UI save and by the
 * auto-selector, for instance), and a shared `${file}.tmp` would let the two
 * `writeFile` calls interleave so that whichever `rename` lands last publishes
 * a file containing a mix of both payloads.
 */
export async function writeJson(filePath: string, obj: unknown): Promise<void> {
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeFile(tmpPath, json, 'utf8');
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Run `fn` with exclusive access to `filePath` — a process-level
 * read-modify-write lock, one chain per resolved path.
 *
 * Every JSON store has more than one writer that loads the file, awaits
 * something slow (a VRM, HA or MQTT round-trip), and saves the whole object
 * back; without serialisation either side can lose the race and persist a
 * snapshot that silently reverts the other's change. Callers wrap the entire
 * load → mutate → save in `fn`. A failed `fn` rejects for its caller only; the
 * chain stays usable for the next one.
 */
export async function withJsonLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const settled = run.then(() => undefined, () => undefined);
  locks.set(key, settled);
  try {
    return await run;
  } finally {
    // Drop the entry once nothing is queued behind us, so the map does not
    // grow with every path ever written.
    if (locks.get(key) === settled) locks.delete(key);
  }
}
