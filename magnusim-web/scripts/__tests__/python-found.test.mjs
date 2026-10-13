import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pythonFound } from '../python-env.js';

// No python/.venv (CI: setup-python puts python on PATH): the app falls back to a bare
// command name, which is never a file, so an existsSync check called it missing and the
// geometry thumbnail and deferred STEP write never ran.
test('a bare interpreter name is found on PATH; a path must exist', () => {
  assert.equal(pythonFound('python3'), true);
  assert.equal(pythonFound('python'), true);
  assert.equal(pythonFound('/no/such/dir/bin/python'), false);
  assert.equal(pythonFound('C:\\no\\such\\python.exe'), false);
  assert.equal(pythonFound(''), false);
  assert.equal(pythonFound(process.execPath), true);
});
