// H15: a JobKind's arguments come from one function, used by /api/jobs and the runner's prepare step.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-regtool-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const { jobArgsFromParams, pluginJobEnv, startRegisteredJob } = await import('../registered-tool.js');
const { prepareFromJob } = await import('../../foam-runner.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));

describe('jobArgsFromParams', () => {
  const spec = { tool: 'jobs/write_mesh_case.py', tool_path: '/plugins/foam-demo/jobs/write_mesh_case.py', args_from_params: ['sleep', 'fail', 'mesh_size', 'zero'], plugin: 'foam-demo' };
  const params = { sleep: 2, fail: '', mesh_size: 0.5, zero: 0, other: 'x', project_id: 'p1' };

  it('--name value for each set param, in the order the JobKind lists them', () => {
    assert.deepEqual(jobArgsFromParams(spec, params), ['--sleep', '2', '--mesh-size', '0.5', '--zero', '0']);
    assert.deepEqual(jobArgsFromParams({}, params), []);
  });

  it('startRegisteredJob spawns exactly those arguments', () => {
    const spawned = [];
    const jobs = {
      finish: () => assert.fail('not refused'),
      spawnPython: (id, script, args, opts) => spawned.push({ id, script, args, opts }),
    };
    startRegisteredJob(jobs, spec, params, { id: 'job-1' });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].script, spec.tool_path);
    assert.deepEqual(spawned[0].args, jobArgsFromParams(spec, params));
    assert.deepEqual(spawned[0].opts.env, pluginJobEnv(spec, params, { id: 'job-1' }));
  });

  it("the runner's prepare step builds its args and env the same way, with its own job id and case folder", () => {
    const row = { key: 'foam_demo_write_mesh_case', runtime: 'core', plugin: 'foam-demo', args_from_params: spec.args_from_params };
    const p = prepareFromJob(row, params, { jobId: 'fc-abcdefgh-123456', caseDir: 'C:/projects/p1/plugins/foam-demo/studies/s1/cases/m1' });
    assert.equal(p.job, 'foam_demo_write_mesh_case');
    assert.equal(p.runtime, 'core');
    assert.deepEqual(p.args, jobArgsFromParams(row, params));
    assert.deepEqual(p.env, {
      ...pluginJobEnv(row, params, { id: 'fc-abcdefgh-123456' }),
      MAGNUSIM_JOB_ID: 'fc-abcdefgh-123456',
      MAGNUSIM_CASE_DIR: 'C:/projects/p1/plugins/foam-demo/studies/s1/cases/m1',
    });
    assert.equal(p.env.MAGNUSIM_PLUGIN_KEY, 'foam-demo');
    assert.equal(p.env.MAGNUSIM_PROJECT_ID, 'p1');
    // The spec names no program: no tool path, no interpreter.
    assert.ok(!('tool' in p) && !('tool_path' in p) && !('python' in p));
    assert.equal(prepareFromJob({ ...row, runtime: 'plugin' }, {}, { jobId: 'fc-abcdefgh-123456', caseDir: 'x' }).runtime, 'plugin');
  });
});
