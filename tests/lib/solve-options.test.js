import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MIP_SOLVE_OPTIONS, solveOptionsFor } from '../../lib/solve-options.ts';

describe('solve-options', () => {
  it('solves a non-empty horizon as a MILP with the planner gap, and an empty one as a plain LP', () => {
    expect(solveOptionsFor({ load_W: [100, 200] })).toEqual({ mip_rel_gap: 0.005, mip_abs_gap: 0.01 });
    expect(solveOptionsFor({ load_W: [] })).toEqual({});
    expect(MIP_SOLVE_OPTIONS).toEqual({ mip_rel_gap: 0.005, mip_abs_gap: 0.01 });
  });

  it('returns a fresh object so a caller cannot mutate the shared constant', () => {
    const opts = solveOptionsFor({ load_W: [1] });
    opts.mip_rel_gap = 1;
    expect(MIP_SOLVE_OPTIONS.mip_rel_gap).toBe(0.005);
  });

  it('is the only place the planner and the solver-refresh gate take their options from', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    for (const file of ['api/services/planner-service.ts', 'scripts/compare-highs-builds.ts']) {
      const src = readFileSync(path.join(root, file), 'utf8');
      expect(src, file).toContain("from '../../lib/solve-options.ts'".replace('../../', file.startsWith('scripts') ? '../' : '../../'));
      expect(src, file).not.toMatch(/mip_rel_gap:\s*0\./);
    }
  });
});
