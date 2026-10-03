// A tool on the core's Python (a plugin's python="core" job too) imports this app's
// cfddesk and SDK: spawnJob puts python/ and python/sdk first on PYTHONPATH. A job on a
// plugin's own environment gets none of the core's paths (isolatedPythonEnv).
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { corePythonPath, jobEnv } from '../job-runner.js';
import { PY_ROOT, PYTHON } from '../python-env.js';

const FIRST = [PY_ROOT, join(PY_ROOT, 'sdk')];

test('the app python and SDK folders come first, once, before what was set', () => {
  assert.deepEqual(corePythonPath(undefined).split(delimiter), FIRST);
  assert.deepEqual(corePythonPath('').split(delimiter), FIRST);
  assert.deepEqual(corePythonPath(['x', 'y'].join(delimiter)).split(delimiter), [...FIRST, 'x', 'y']);
  assert.deepEqual(corePythonPath(corePythonPath('x')).split(delimiter), [...FIRST, 'x']);
});

test("a job on the core's Python gets them; the job's own env is kept", () => {
  for (const python of [undefined, PYTHON]) {
    const env = jobEnv(python, { MAGNUSIM_JOB_ID: 'j1' }, { PYTHONPATH: 'x', KEEP: '1' });
    assert.deepEqual(String(env.PYTHONPATH).split(delimiter), [...FIRST, 'x']);
    assert.equal(env.MAGNUSIM_JOB_ID, 'j1');
    assert.equal(env.KEEP, '1');
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
    assert.equal(env.PYTHONNOUSERSITE, undefined);
  }
});

test("a job on a plugin's own environment gets no python/ and no PYTHONPATH at all", () => {
  const plugin = join('C:', 'plugin-envs', 'airfoil', 'Scripts', 'python.exe');
  const env = jobEnv(plugin, { MAGNUSIM_JOB_ID: 'j2', PYTHONPATH: PY_ROOT }, { PYTHONPATH: PY_ROOT, PYTHONHOME: 'h', KEEP: '1' });
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.MAGNUSIM_JOB_ID, 'j2');
  assert.equal(env.KEEP, '1');
  assert.ok(!Object.values(env).some((v) => String(v).split(delimiter).includes(PY_ROOT)), 'no value names the core python folder');
});
