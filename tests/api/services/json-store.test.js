import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeJson, readJson, withJsonLock, sweepTempFiles } from '../../../api/services/json-store.ts';
import fs from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('json-store — writeJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.rename.mockResolvedValue(undefined);
    fs.unlink.mockResolvedValue(undefined);
  });

  const TMP = /^\/tmp\/test\/data\.json\.\d+\.\d+\.tmp$/;

  it('creates parent directory and writes formatted JSON atomically via a temp file', async () => {
    await writeJson('/tmp/test/data.json', { key: 'value' });

    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/test', { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(TMP),
      expect.stringContaining('"key": "value"'),
      'utf8',
    );
    const [tmpPath] = fs.writeFile.mock.calls[0];
    expect(fs.rename).toHaveBeenCalledWith(tmpPath, '/tmp/test/data.json');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('uses a distinct temp file per write so concurrent writers cannot tear each other', async () => {
    // Two in-flight writes to the same target used to share `${file}.tmp`; the
    // second writeFile could land mid-way through the first, and whichever
    // rename won published a mix of both payloads.
    let releaseFirst;
    fs.writeFile.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }));
    const first = writeJson('/tmp/test/data.json', { n: 1 });
    const second = writeJson('/tmp/test/data.json', { n: 2 });
    await second;
    releaseFirst();
    await first;

    const tmpPaths = fs.writeFile.mock.calls.map(c => c[0]);
    expect(tmpPaths).toHaveLength(2);
    expect(tmpPaths[0]).not.toBe(tmpPaths[1]);
    expect(tmpPaths.every(p => TMP.test(p))).toBe(true);
    expect(fs.rename.mock.calls.map(c => c[1])).toEqual(['/tmp/test/data.json', '/tmp/test/data.json']);
  });

  it('writes JSON with a trailing newline', async () => {
    await writeJson('/tmp/out.json', { x: 1 });

    const [, content] = fs.writeFile.mock.calls[0];
    expect(content.endsWith('\n')).toBe(true);
  });

  it('propagates mkdir errors', async () => {
    fs.mkdir.mockRejectedValue(new Error('permission denied'));

    await expect(writeJson('/no/access/file.json', {})).rejects.toThrow('permission denied');
  });

  it('propagates writeFile errors', async () => {
    fs.writeFile.mockRejectedValue(new Error('disk full'));

    await expect(writeJson('/tmp/test/file.json', {})).rejects.toThrow('disk full');
  });

  it('propagates rename errors and removes the orphaned temp file', async () => {
    fs.rename.mockRejectedValue(new Error('cross-device link'));

    await expect(writeJson('/tmp/test/file.json', {})).rejects.toThrow('cross-device link');
    const [tmpPath] = fs.writeFile.mock.calls[0];
    expect(fs.unlink).toHaveBeenCalledWith(tmpPath);
  });

  it('still propagates the rename error when the temp-file cleanup fails too', async () => {
    fs.rename.mockRejectedValue(new Error('cross-device link'));
    fs.unlink.mockRejectedValue(new Error('gone already'));

    await expect(writeJson('/tmp/test/file.json', {})).rejects.toThrow('cross-device link');
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
