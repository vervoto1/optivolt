import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Guards for the CI workflows and the dev tooling: none of this runs in the
// add-on, so a silent drift would only show up on GitHub or on a dev box.
const root = path.resolve(import.meta.dirname, '../..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const workflows = readdirSync(path.join(root, '.github/workflows'))
  .filter(f => /\.ya?ml$/.test(f))
  .map(f => ({ name: f, text: read(`.github/workflows/${f}`) }));

// The shell lines of the "Copy source into add-on directory" step, unquoted and
// with the add-on directory spelled out, so both workflows compare equal.
function stagingCommands(text) {
  const step = text.split(/- name: /).find(s => s.startsWith('Copy source into add-on directory'));
  if (!step) throw new Error('no "Copy source into add-on directory" step');
  const run = step.split(/run: \|\n/)[1];
  return run.split('\n')
    .map(line => line.trim())
    .filter(line => /^(cp|mkdir) /.test(line))
    .map(line => line.replaceAll('"', '').replaceAll('${ADDON}', 'optivolt'));
}

describe('CI workflows', () => {
  it('runs the Tests workflow with a read-only token that is not persisted', () => {
    const test = read('.github/workflows/test.yml');
    expect(test).toMatch(/^permissions:\n {2}contents: read$/m);
    const checkouts = test.match(/uses: actions\/checkout@\S+\n(\s+with:\n\s+persist-credentials: false)?/g);
    expect(checkouts.length).toBeGreaterThanOrEqual(2);
    for (const checkout of checkouts) expect(checkout).toMatch(/persist-credentials: false/);
  });

  it('pins every action to a tag or commit, never a branch', () => {
    for (const { name, text } of workflows) {
      for (const [, ref] of text.matchAll(/uses: [^@\s]+@(\S+)/g)) {
        expect(ref, name).not.toMatch(/^(master|main)$/);
      }
    }
  });

  it('stages the smoke-test image exactly like the published build', () => {
    const smoke = stagingCommands(read('.github/workflows/test.yml'));
    const publish = stagingCommands(read('.github/workflows/build-addon.yaml'));
    expect(smoke.length).toBeGreaterThan(0);
    expect(smoke).toEqual(publish);
  });

  it('keeps GitHub Actions under Dependabot', () => {
    expect(read('.github/dependabot.yml')).toMatch(/package-ecosystem: "github-actions"/);
  });
});

describe('dev tooling', () => {
  it('pins tsx as an exact devDependency', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.devDependencies.tsx).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies.tsx).toBeUndefined();
  });

  it('never lets npx fetch an unpinned tsx', () => {
    const files = ['CLAUDE.md', 'README.md', 'vendor/highs-build/PROVENANCE.md',
      ...readdirSync(path.join(root, 'scripts')).map(f => `scripts/${f}`)];
    for (const file of files) {
      expect(read(file), file).not.toMatch(/npx tsx\b/);
    }
  });

  it('typechecks the scripts with syntax that type stripping can run', () => {
    const { compilerOptions, include } = JSON.parse(read('tsconfig.json'));
    expect(compilerOptions.erasableSyntaxOnly).toBe(true);
    expect(compilerOptions.verbatimModuleSyntax).toBe(true);
    expect(include).toContain('scripts/**/*.ts');
  });
});
