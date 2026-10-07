import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadPvCurtailmentState,
  savePvCurtailmentState,
  clearPvCurtailmentState,
} from '../../../api/services/pv-curtailment-state-store.ts';

describe('pv-curtailment-state-store', () => {
  let dir;
  let previousDataDir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-state-'));
    previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const state = {
    ownsDisable: true,
    sinceMs: 1_700_000_000_000,
    serial: 'c0619ab6bd28',
    acsystemInstance: 0,
    enphaseSwitchEntity: 'switch.envoy',
  };

  it('returns null when nothing is recorded', async () => {
    await expect(loadPvCurtailmentState()).resolves.toBeNull();
  });

  it('round-trips a record through DATA_DIR and clears it', async () => {
    await savePvCurtailmentState(state);
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'pv-curtailment-state.json'), 'utf8'));
    expect(raw).toEqual(state);
    await expect(loadPvCurtailmentState()).resolves.toEqual(state);

    await clearPvCurtailmentState();
    await expect(loadPvCurtailmentState()).resolves.toBeNull();
    // Clearing an absent record is a no-op.
    await expect(clearPvCurtailmentState()).resolves.toBeUndefined();
  });

  it('defaults a missing switch entity to empty', async () => {
    const { enphaseSwitchEntity: _omit, ...withoutSwitch } = state;
    await fs.writeFile(path.join(dir, 'pv-curtailment-state.json'), JSON.stringify(withoutSwitch));
    await expect(loadPvCurtailmentState()).resolves.toEqual({ ...state, enphaseSwitchEntity: '' });
  });

  it('defaults a missing or non-numeric sinceMs to 0', async () => {
    const { sinceMs: _omit, ...withoutSince } = state;
    await fs.writeFile(path.join(dir, 'pv-curtailment-state.json'), JSON.stringify(withoutSince));
    await expect(loadPvCurtailmentState()).resolves.toEqual({ ...state, sinceMs: 0 });
  });

  it('reports a malformed or unparsable record as unreadable, with a warning', async () => {
    const file = path.join(dir, 'pv-curtailment-state.json');
    await fs.writeFile(file, JSON.stringify({ ...state, acsystemInstance: -1 }));
    await expect(loadPvCurtailmentState()).resolves.toBe('unreadable');
    await fs.writeFile(file, JSON.stringify({ ...state, enphaseSwitchEntity: 42 }));
    await expect(loadPvCurtailmentState()).resolves.toBe('unreadable');
    await fs.writeFile(file, 'null');
    await expect(loadPvCurtailmentState()).resolves.toBe('unreadable');
    await fs.writeFile(file, '{not json');
    await expect(loadPvCurtailmentState()).resolves.toBe('unreadable');
    // A zero-length file, as a power loss can leave behind.
    await fs.writeFile(file, '');
    await expect(loadPvCurtailmentState()).resolves.toBe('unreadable');
    expect(console.warn).toHaveBeenCalledTimes(5);
  });

  it('fsyncs the record and its directory and leaves no temp file behind', async () => {
    const opened = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (p, flags) => {
      const handle = await realOpen(p, flags);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => { opened.push([path.basename(p), flags]); return realSync(); };
      return handle;
    });
    await savePvCurtailmentState(state);
    expect(opened).toEqual([
      [expect.stringMatching(/^pv-curtailment-state\.json\.\d+\.\d+\.tmp$/), 'w'],
      [path.basename(dir), 'r'],
    ]);
    expect(await fs.readdir(dir)).toEqual(['pv-curtailment-state.json']);
    await expect(loadPvCurtailmentState()).resolves.toEqual(state);
  });

  it('removes the temp file and rejects when the rename fails', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('EXDEV'));
    await expect(savePvCurtailmentState(state)).rejects.toThrow('EXDEV');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('still saves when the directory cannot be fsynced', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (p, flags) => {
      if (flags === 'r') throw new Error('EISDIR');
      return realOpen(p, flags);
    });
    await savePvCurtailmentState(state);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('could not fsync'), 'EISDIR');
    await expect(loadPvCurtailmentState()).resolves.toEqual(state);
  });
});
