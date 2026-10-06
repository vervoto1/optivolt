import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJson, readJson } from '../../../api/services/json-store.ts';

// Real-filesystem round trip (the sibling json-store.test.js mocks node:fs).
describe('json-store — writeJson on a real filesystem', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optivolt-json-store-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips, replaces an existing file and leaves no temp files behind', async () => {
    const file = path.join(dir, 'nested', 'settings.json');
    await writeJson(file, { a: 1 });
    await writeJson(file, { a: 2, b: [1, 2] });

    expect(await readJson(file)).toEqual({ a: 2, b: [1, 2] });
    expect(await fs.readFile(file, 'utf8')).toBe('{\n  "a": 2,\n  "b": [\n    1,\n    2\n  ]\n}\n');
    expect(await fs.readdir(path.join(dir, 'nested'))).toEqual(['settings.json']);
  });

  it('removes the temp file when the rename fails', async () => {
    // Renaming a file over a non-empty directory fails on every platform.
    const target = path.join(dir, 'blocked.json');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'inside'), 'x');

    await expect(writeJson(target, { a: 1 })).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(['blocked.json']);
  });
});
