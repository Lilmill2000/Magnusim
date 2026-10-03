// A tool on the core's Python (a plugin's python="core" job too) imports this app's
// cfddesk and SDK: spawnJob puts python/ and python/sdk first on PYTHONPATH.
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { corePythonPath } from '../job-runner.js';
import { PY_ROOT } from '../python-env.js';

test('the app python and SDK folders come first, once, before what was set', () => {
  const first = [PY_ROOT, join(PY_ROOT, 'sdk')];
  assert.deepEqual(corePythonPath(undefined).split(delimiter), first);
  assert.deepEqual(corePythonPath('').split(delimiter), first);
  assert.deepEqual(corePythonPath(['x', 'y'].join(delimiter)).split(delimiter), [...first, 'x', 'y']);
  const again = corePythonPath(corePythonPath('x'));
  assert.deepEqual(again.split(delimiter), [...first, 'x']);
});
