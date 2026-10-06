import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// The add-on image copies app/ and vendor/highs-build/ whole (optivolt/Dockerfile),
// and both it and the repo are public: shipping these third-party files means
// shipping their license texts too (MIT keeps the notice, OFL-1.1 needs the text).
const root = path.resolve(import.meta.dirname, '../..');
const appVendor = path.join(root, 'app/vendor');
const highsBuild = path.join(root, 'vendor/highs-build');

function readmeLicenseRows() {
  const readme = readFileSync(path.join(appVendor, 'README.md'), 'utf8');
  const section = readme.split(/^## Licenses$/m)[1];
  if (!section) throw new Error('app/vendor/README.md has no "## Licenses" section');
  return [...section.matchAll(/^\| `([^`]+)` \| ([^|]+?) \| `([^`]+)` \|$/gm)]
    .map(([, file, license, notice]) => ({ file, license, notice }));
}

describe('vendored front-end license notices', () => {
  const rows = readmeLicenseRows();

  it('indexes a notice for every vendored script, stylesheet and font', () => {
    expect(rows.map(r => r.file)).toEqual([
      'tailwind.css',
      'chart.umd.js',
      'patternomaly.min.js',
      'fonts/outfit-*.woff2',
      'fonts/jetbrains-mono-*.woff2',
    ]);
    const covered = (name) => rows.some(({ file }) =>
      new RegExp(`^${file.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]+')}$`).test(name));
    const shipped = [
      ...readdirSync(appVendor).filter(f => /\.(js|css)$/.test(f) && f !== 'fonts.css'),
      ...readdirSync(path.join(appVendor, 'fonts')).map(f => `fonts/${f}`),
    ];
    expect(shipped.filter(f => !covered(f))).toEqual([]);
  });

  it('ships each indexed notice file with the license it names', () => {
    for (const { license, notice } of rows) {
      const text = readFileSync(path.join(appVendor, notice), 'utf8');
      if (license === 'MIT') {
        expect(text, notice).toMatch(/Permission is hereby granted, free of charge/);
      } else {
        expect(license).toBe('OFL-1.1');
        expect(text, notice).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
      }
      expect(text, notice).toMatch(/Copyright/);
    }
  });

  it('keeps no notice file the index does not list', () => {
    const listed = new Set(rows.map(r => r.notice));
    const onDisk = readdirSync(path.join(appVendor, 'licenses')).map(f => `licenses/${f}`);
    expect(onDisk.filter(f => !listed.has(f))).toEqual([]);
  });
});

describe('vendored HiGHS license', () => {
  it('ships the MIT text of highs-js and HiGHS next to the binaries', () => {
    const file = path.join(highsBuild, 'LICENSE');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^MIT License/);
    expect(text).toMatch(/Copyright \(c\) \d{4} highs-js/);
    expect(text).toMatch(/Copyright \(c\) \d{4} HiGHS/);
  });

  it('has the refresh procedure copy the license with the binaries', () => {
    const provenance = readFileSync(path.join(highsBuild, 'PROVENANCE.md'), 'utf8');
    expect(provenance).toMatch(/`package\/LICENSE` over\s+`LICENSE`/);
  });
});
