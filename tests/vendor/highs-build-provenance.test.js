import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The vendored HiGHS solver is the runtime LP engine and gets no updates from
// npm. vendor/highs-build/PROVENANCE.md records where the binaries came from;
// this test pins the artifacts to that record so a swapped or edited build
// cannot land without the provenance being rewritten alongside it.
const dir = path.resolve(import.meta.dirname, '../../vendor/highs-build');
const provenance = readFileSync(path.join(dir, 'PROVENANCE.md'), 'utf8');

function recorded(file) {
  const row = provenance.match(new RegExp(`^\\| \`${file}\` \\| sha256 \`([0-9a-f]{64})\` \\(([\\d ]+) bytes`, 'm'));
  if (!row) throw new Error(`PROVENANCE.md has no sha256 row for ${file}`);
  return { sha256: row[1], bytes: Number(row[2].replace(/ /g, '')) };
}

function actual(file) {
  const buf = readFileSync(path.join(dir, file));
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: statSync(path.join(dir, file)).size };
}

describe('vendored HiGHS build provenance', () => {
  for (const file of ['highs.wasm', 'highs.js']) {
    it(`${file} matches the hash and size recorded in PROVENANCE.md`, () => {
      expect(actual(file)).toEqual(recorded(file));
    });
  }

  it('records the source commits and the HiGHS version', () => {
    expect(provenance).toMatch(/lovasoa\/highs-js.*@ `[0-9a-f]{40}`/);
    expect(provenance).toMatch(/ERGO-Code\/HiGHS.*@ `[0-9a-f]{40}`.*\*\*v\d+\.\d+\.\d+\*\*/);
  });

  it('keeps the CommonJS marker the wrapper needs under an ESM package', () => {
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))).toEqual({ type: 'commonjs' });
  });
});
