import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldExportMaySpawnFallback } from '../field-export-fallback.js';

describe('field export spawn fallback', () => {
  it('does not spawn a second OpenFOAMReader when the worker is down', () => {
    assert.equal(fieldExportMaySpawnFallback(new Error('worker stopped')), false);
    assert.equal(fieldExportMaySpawnFallback(new Error('Python worker unavailable')), false);
    assert.equal(fieldExportMaySpawnFallback(new Error('worker exited')), false);
    assert.equal(fieldExportMaySpawnFallback(new Error('worker RPC timeout: filter.case_field')), false);
  });

  it('does not spawn after the data lane restarts on a timeout', () => {
    // Every pending call fails with this at once; spawning for each started a storm of
    // volume-loading Python processes.
    assert.equal(fieldExportMaySpawnFallback(new Error('worker restarted after a timeout')), false);
    const unavailable = Object.assign(new Error('spawn python ENOENT'), { name: 'WorkerUnavailableError' });
    assert.equal(fieldExportMaySpawnFallback(unavailable), false);
  });

  it('still allows a spawn for a real export failure', () => {
    assert.equal(fieldExportMaySpawnFallback(new Error('volume read failed')), true);
    assert.equal(fieldExportMaySpawnFallback(new Error('field worker export failed')), true);
  });
});
