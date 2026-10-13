#!/usr/bin/env -S npx --no-install tsx
/**
 * Child process of `scripts/horizon-whatif.ts --ref <rev>`: builds the gate
 * config and the LP with the code of another checkout and writes the LP text.
 *
 * Usage (internal):
 *   tsx scripts/horizon-lp-dump.ts --root <checkout> --data <data.json> --settings <settings.json>
 *       --start-ms <ms> --out <lp file> [--calibration <{calibration, evCalibration} json>]
 *
 * Everything the LP is built from is imported from `<checkout>` (its
 * scripts/solver-gate-config.ts and lib/build-lp.ts), so the same runner
 * builds the LP of the working tree and of a git worktree at another revision.
 * Run it with DATA_DIR pointing at an empty directory: the stores are never
 * read, but some modules resolve the directory on import.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    data: { type: 'string' },
    settings: { type: 'string' },
    'start-ms': { type: 'string' },
    out: { type: 'string' },
    calibration: { type: 'string' },
  },
});
if (!values.root || !values.data || !values.settings || !values['start-ms'] || !values.out) {
  console.error('usage: horizon-lp-dump.ts --root <checkout> --data <file> --settings <file> --start-ms <ms> --out <file> [--calibration <file>]');
  process.exit(2);
}
const readJson = (file: string): unknown => JSON.parse(readFileSync(path.resolve(file), 'utf8'));
const load = (rel: string) => import(pathToFileURL(path.join(path.resolve(values.root!), rel)).href);

const gate = await load('scripts/solver-gate-config.ts') as { buildGateConfig: (input: Record<string, unknown>) => Promise<{ cfg: unknown }> };
const lp = await load('lib/build-lp.ts') as { buildLP: (cfg: unknown) => string };
const { cfg } = await gate.buildGateConfig({
  settings: readJson(values.settings),
  data: readJson(values.data),
  startMs: Number(values['start-ms']),
  ...(values.calibration ? { calibration: readJson(values.calibration) } : {}),
});
writeFileSync(values.out, lp.buildLP(cfg));
