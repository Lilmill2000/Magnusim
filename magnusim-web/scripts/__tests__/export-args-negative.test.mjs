// Plot over path from a point at a negative coordinate (and a particle-trace pick there):
// the tools got "--points -0.01,0,0.3;..." and argparse read the value as an option,
// so the route answered 500 "expected one argument". The point lists now go as
// --points=... / --pick=... (found by the validation set's pipe profile, x from -R to R).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { popExportArgs, ptExportArgs } from '../vite-plugin-case-fields.js';
import { PYTHON } from '../python-env.js';

function run(args) {
  return spawnSync(PYTHON, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
}

describe('result tools take points at negative coordinates', () => {
  it('plot over path: the points reach the tool as one argument', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'magnusim-pop-args-'));
    try {
      const args = popExportArgs(join(tmp, 'no-case'), '100', join(tmp, 'out'), { points: '-0.01,0,0.3;0.01,0,0.3', subdivisions: 4, field: 'magU' });
      assert.ok(args.includes('--points=-0.01,0,0.3;0.01,0,0.3'), args.join(' '));
      // The tool parses its command line and stops at the missing case, not at argparse.
      const r = run(args);
      assert.doesNotMatch(r.stderr, /expected one argument|unrecognized arguments/, r.stderr);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /"ok": false/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('particle trace: a picked point at a negative coordinate reaches the tool', () => {
    const p = { seeds_h: 2, seeds_v: 2, spacing: 0.01, size: 0.001, both: true, pick: '-0.2,0.1,0', max_steps: 10, seed_mode: 'grid', faces: [], quantity_mode: 'count', n_seeds: 4, density: 10, region: '', vector: '', coloring: '' };
    const args = ptExportArgs('C:/no-case', '100', 'C:/no-out', p);
    assert.ok(args.includes('--pick=-0.2,0.1,0'), args.join(' '));
    assert.ok(args.includes('--pick=') === false);
    assert.ok(ptExportArgs('c', '1', 'o', { ...p, pick: '' }).includes('--pick='));
  });
});
