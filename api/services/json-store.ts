import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');

let tmpCounter = 0;

/** Tail of the update chain per resolved path (see `withJsonLock`). */
const locks = new Map<string, Promise<unknown>>();

/** The temp names `writeJson` produces: `<file>.<pid>.<n>.tmp`. */
const TEMP_FILE = /\.\d+\.\d+\.tmp$/;
/** A temp file younger than this may still belong to a write in progress. */
const TEMP_FILE_MIN_AGE_MS = 5 * 60_000;

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

/**
 * Remove temp files that an interrupted `writeJson` left behind.
 *
 * The temp name is unique per write, so a hard kill (OOM, power loss)
 * between `writeFile` and `rename` leaves a new `<file>.<pid>.<n>.tmp`
 * every time, and nothing else ever touches them: on the add-on's
 * persistent `/data` volume they would accumulate for the life of the
 * install. Called once at boot for `DATA_DIR`; only files older than a few
 * minutes are removed, so a write in progress in this process is never hit.
 * Returns the paths removed. Never throws — a missing directory or an
 * unreadable entry is not worth failing startup over.
 */
export async function sweepTempFiles(dir: string, { now = Date.now() }: { now?: number } = {}): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!TEMP_FILE.test(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || now - stat.mtimeMs < TEMP_FILE_MIN_AGE_MS) continue;
      await fs.unlink(filePath);
      removed.push(filePath);
    } catch (err) {
      console.warn(`[json-store] could not remove stale temp file ${filePath}:`, (err as Error).message);
    }
  }
  if (removed.length > 0) console.log(`[json-store] removed ${removed.length} stale temp file(s) from ${dir}`);
  return removed;
}
