import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeJson, readJson, withJsonLock, sweepTempFiles } from '../../../api/services/json-store.ts';
import fs from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('json-store — writeJson', () => {
  const TMP = /^\/tmp\/test\/data\.json\.\d+\.\d+\.tmp$/;

  /** One fake FileHandle per fs.open call, recorded in order. */
  let handles;
  const makeHandle = (target) => ({
    target,
    writeFile: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const fileHandles = () => handles.filter(h => TMP.test(h.target));
  const dirHandles = () => handles.filter(h => !TMP.test(h.target));
  const openWith = (tweak = () => {}) => {
    fs.open.mockImplementation(async (target, flags) => {
      const h = makeHandle(target);
      tweak(h, flags);
      handles.push(h);
      return h;
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handles = [];
    fs.mkdir.mockResolvedValue(undefined);
    openWith();
    fs.rename.mockResolvedValue(undefined);
    fs.unlink.mockResolvedValue(undefined);
  });

  it('creates parent directory and writes formatted JSON atomically via a temp file', async () => {
    await writeJson('/tmp/test/data.json', { key: 'value' });

    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/test', { recursive: true });
    expect(fs.open).toHaveBeenCalledWith(expect.stringMatching(TMP), 'w');
    const [fh] = fileHandles();
    expect(fh.writeFile).toHaveBeenCalledWith(expect.stringContaining('"key": "value"'), 'utf8');
    expect(fs.rename).toHaveBeenCalledWith(fh.target, '/tmp/test/data.json');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('fsyncs the temp file before the rename and the directory after it', async () => {
    const order = [];
    openWith((h, flags) => {
      const kind = flags === 'w' ? 'file' : 'dir';
      h.sync.mockImplementation(async () => { order.push(`sync:${kind}`); });
      h.close.mockImplementation(async () => { order.push(`close:${kind}`); });
    });
    fs.rename.mockImplementation(async () => { order.push('rename'); });

    await writeJson('/tmp/test/data.json', { a: 1 });

    expect(order).toEqual(['sync:file', 'close:file', 'rename', 'sync:dir', 'close:dir']);
    expect(fs.open).toHaveBeenCalledWith('/tmp/test', 'r');
    expect(dirHandles()).toHaveLength(1);
  });

  it('tolerates a directory that cannot be opened', async () => {
    const real = fs.open.getMockImplementation();
    fs.open.mockImplementation(async (target, flags) => {
      if (flags === 'r') throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
      return real(target, flags);
    });

    await expect(writeJson('/tmp/test/data.json', { a: 1 })).resolves.toBeUndefined();
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('tolerates a directory fsync failure and still closes the directory handle', async () => {
    openWith((h, flags) => {
      if (flags === 'r') h.sync.mockRejectedValue(new Error('EINVAL'));
    });

    await expect(writeJson('/tmp/test/data.json', { a: 2 })).resolves.toBeUndefined();
    expect(dirHandles()[0].close).toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('uses a distinct temp file per write so concurrent writers cannot tear each other', async () => {
    // Two in-flight writes to the same target used to share `${file}.tmp`; the
    // second write could land mid-way through the first, and whichever
    // rename won published a mix of both payloads.
    let releaseFirst;
    let first = true;
    openWith((h, flags) => {
      if (flags === 'w' && first) {
        first = false;
        h.writeFile.mockImplementation(() => new Promise(resolve => { releaseFirst = resolve; }));
      }
    });
    const p1 = writeJson('/tmp/test/data.json', { n: 1 });
    const p2 = writeJson('/tmp/test/data.json', { n: 2 });
    await p2;
    releaseFirst();
    await p1;

    const tmpPaths = fileHandles().map(h => h.target);
    expect(tmpPaths).toHaveLength(2);
    expect(tmpPaths[0]).not.toBe(tmpPaths[1]);
    expect(fs.rename.mock.calls.map(c => c[1])).toEqual(['/tmp/test/data.json', '/tmp/test/data.json']);
  });

  it('writes JSON with a trailing newline', async () => {
    await writeJson('/tmp/test/data.json', { x: 1 });

    const [content] = fileHandles()[0].writeFile.mock.calls[0];
    expect(content.endsWith('\n')).toBe(true);
  });

  it('propagates mkdir errors', async () => {
    fs.mkdir.mockRejectedValue(new Error('permission denied'));

    await expect(writeJson('/no/access/file.json', {})).rejects.toThrow('permission denied');
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('propagates write errors, closes the handle and removes the temp file', async () => {
    openWith((h) => { h.writeFile.mockRejectedValue(new Error('disk full')); });

    await expect(writeJson('/tmp/test/data.json', {})).rejects.toThrow('disk full');
    const [fh] = fileHandles();
    expect(fh.close).toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(fh.target);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('propagates fsync errors and removes the temp file without renaming it', async () => {
    openWith((h) => { h.sync.mockRejectedValue(new Error('EIO')); });

    await expect(writeJson('/tmp/test/data.json', {})).rejects.toThrow('EIO');
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(fileHandles()[0].target);
  });

  it('propagates open errors and still attempts to remove the temp file', async () => {
    fs.open.mockRejectedValue(new Error('EMFILE'));

    await expect(writeJson('/tmp/test/data.json', {})).rejects.toThrow('EMFILE');
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringMatching(TMP));
  });

  it('propagates rename errors and removes the orphaned temp file', async () => {
    fs.rename.mockRejectedValue(new Error('cross-device link'));

    await expect(writeJson('/tmp/test/data.json', {})).rejects.toThrow('cross-device link');
    expect(fs.unlink).toHaveBeenCalledWith(fileHandles()[0].target);
    expect(dirHandles()).toHaveLength(0);
  });

  it('still propagates the rename error when the temp-file cleanup fails too', async () => {
    fs.rename.mockRejectedValue(new Error('cross-device link'));
    fs.unlink.mockRejectedValue(new Error('gone already'));

    await expect(writeJson('/tmp/test/data.json', {})).rejects.toThrow('cross-device link');
  });
});

describe('json-store — readJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.readFile = vi.fn();
  });

  it('reads and parses JSON from a file', async () => {
    fs.readFile.mockResolvedValue('{"foo":"bar"}\n');

    const result = await readJson('/tmp/test/data.json');

    expect(fs.readFile).toHaveBeenCalledWith('/tmp/test/data.json', 'utf8');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('propagates readFile errors', async () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    fs.readFile.mockRejectedValue(err);

    await expect(readJson('/tmp/missing.json')).rejects.toThrow('ENOENT');
  });
});

describe('json-store — withJsonLock', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  it('runs callers for the same path one after another, in order', async () => {
    const events = [];
    let release;
    const first = withJsonLock('/tmp/a.json', async () => {
      events.push('first:start');
      await new Promise(resolve => { release = resolve; });
      events.push('first:end');
      return 1;
    });
    const second = withJsonLock('/tmp/sub/../a.json', async () => { events.push('second'); return 2; });
    await tick();
    expect(events).toEqual(['first:start']);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not block callers for a different path', async () => {
    const events = [];
    let release;
    const blocked = withJsonLock('/tmp/a.json', () => new Promise(resolve => { release = resolve; }));
    await withJsonLock('/tmp/b.json', async () => { events.push('b'); });
    expect(events).toEqual(['b']);
    release();
    await blocked;
  });

  it('rejects a failing caller without breaking the chain for the next one', async () => {
    await expect(withJsonLock('/tmp/a.json', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withJsonLock('/tmp/a.json', async () => 'ok')).toBe('ok');
  });
});

describe('json-store — sweepTempFiles', () => {
  const NOW = 1_700_000_000_000;
  const file = (mtimeMs, isFile = true) => ({ isFile: () => isFile, mtimeMs });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.unlink.mockResolvedValue(undefined);
  });

  it('removes only stale writeJson temp files, leaving young ones and everything else alone', async () => {
    fs.readdir.mockResolvedValue(['settings.json', 'data.json.1234.7.tmp', 'data.json.99.1.tmp', 'notes.tmp', 'prediction-config.json.5.2.tmp']);
    fs.stat.mockImplementation(async (p) => {
      if (p.endsWith('data.json.1234.7.tmp')) return file(NOW - 60 * 60_000);
      if (p.endsWith('data.json.99.1.tmp')) return file(NOW - 30_000); // a write in progress
      if (p.endsWith('prediction-config.json.5.2.tmp')) return file(NOW - 10 * 60_000, false); // a directory, oddly
      throw new Error(`unexpected stat ${p}`);
    });

    const removed = await sweepTempFiles('/data', { now: NOW });

    expect(removed).toEqual(['/data/data.json.1234.7.tmp']);
    expect(fs.unlink).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledWith('/data/data.json.1234.7.tmp');
    expect(console.log).toHaveBeenCalledWith('[json-store] removed 1 stale temp file(s) from /data');
  });

  it('never throws: a missing directory is an empty sweep and an unlink failure is logged', async () => {
    fs.readdir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await sweepTempFiles('/nope', { now: NOW })).toEqual([]);

    fs.readdir.mockResolvedValue(['a.json.1.1.tmp']);
    fs.stat.mockResolvedValue(file(NOW - 60 * 60_000));
    fs.unlink.mockRejectedValueOnce(new Error('EACCES'));
    expect(await sweepTempFiles('/data', { now: NOW })).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith('[json-store] could not remove stale temp file /data/a.json.1.1.tmp:', 'EACCES');
    expect(console.log).not.toHaveBeenCalled();
  });
});
