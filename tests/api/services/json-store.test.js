import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeJson, readJson } from '../../../api/services/json-store.ts';
import fs from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('json-store — writeJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.rename.mockResolvedValue(undefined);
  });

  it('creates parent directory and writes formatted JSON atomically', async () => {
    await writeJson('/tmp/test/data.json', { key: 'value' });

    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/test', { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/tmp/test/data.json.tmp',
      expect.stringContaining('"key": "value"'),
      'utf8',
    );
    expect(fs.rename).toHaveBeenCalledWith('/tmp/test/data.json.tmp', '/tmp/test/data.json');
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

  it('propagates rename errors', async () => {
    fs.rename.mockRejectedValue(new Error('cross-device link'));

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
