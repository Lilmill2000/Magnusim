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

  it('still allows a spawn for a real export failure', () => {
    assert.equal(fieldExportMaySpawnFallback(new Error('volume read failed')), true);
    assert.equal(fieldExportMaySpawnFallback(new Error('field worker export failed')), true);
  });
});
