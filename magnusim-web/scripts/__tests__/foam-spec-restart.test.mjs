// F6: solver.restart reaches the relay's spec only as true (a plain run's spec is unchanged).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-foam-spec-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';
const { buildFoamSpec } = await import('../foam-runner.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));

const plan = (solver) => ({
  job_id: 'fc-abc123-0a1b2c',
  token: '0a1b2c3d',
  case_dir: 'C:/p/case',
  case_base: 'C:/p',
  case_parts: ['case'],
  plugin: 'incompressible_flow',
  wsl_case: 'cfddesk-w27-r1',
  wsl_root: '/home/u/cases',
  n_procs: 2,
  claim: { kind: 'solve', project_id: 'p1' },
  run_id: 'r1',
  simulation_id: 's1',
  solver: { app: 'simpleFoam', keep_frames: 'latest', frame_fields: ['U', 'p'], stop_strategy: 'stopAt_writeNow', parallel: 'mpirun', ...solver },
});

describe('the spec carries solver.restart', () => {
  it('true when the plan asks for it', () => {
    assert.equal(buildFoamSpec(plan({ restart: true })).solver.restart, true);
  });
  it('left out otherwise (anything but true)', () => {
    for (const restart of [undefined, false, 'true', 1]) {
      assert.equal('restart' in buildFoamSpec(plan(restart === undefined ? {} : { restart })).solver, false, String(restart));
    }
  });
});
