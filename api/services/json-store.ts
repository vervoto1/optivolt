import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');

let tmpCounter = 0;

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
