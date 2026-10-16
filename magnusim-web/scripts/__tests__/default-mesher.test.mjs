// The server's new-mesh mesher (registry-defaults.js defaultMeshEngineFor, used by
// w20-mesh.js createMesh): the same rule as the Mesh form (src/defaultMesher.ts), from the
// live registry; it follows the registry as plugins come and go.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMeshDefaultsFromRegistry,
  defaultAnalysisKey,
  defaultMeshEngineFor,
  loadCommittedRegistry,
  resetRegistryCache,
  setLiveRegistry,
} from '../registry-defaults.js';
import { defaultMeshEngine } from '../../src/defaultMesher.ts';

after(() => resetRegistryCache());

const live = (analysis, mesher) => setLiveRegistry({ ...loadCommittedRegistry(), analysis, mesher });

describe('defaultMeshEngineFor', () => {
  it('Heat Transfer starts on Hex-dominant, Incompressible Flow and a study with no analysis on the app default', () => {
    resetRegistryCache();
    const reg = loadCommittedRegistry();
    for (const row of reg.analysis) {
      // The server and the page agree: the same function on the same rows.
      assert.equal(defaultMeshEngineFor(row.key), defaultMeshEngine(row, reg.mesher), row.key);
    }
    assert.equal(defaultMeshEngineFor('incompressible_steady'), 'standard');
    assert.equal(defaultMeshEngineFor(undefined), buildMeshDefaultsFromRegistry().mesh_engine);
    if (reg.analysis.some((r) => r.key === 'heat_transfer_steady')) {
      assert.equal(defaultMeshEngineFor('heat_transfer_steady'), 'snappy_hexdominant');
      assert.equal(defaultMeshEngineFor('heat_transfer_transient'), 'snappy_hexdominant');
    }
  });

  it('a mesher that is not registered is never used: the app default instead, Standard or the first mesher', () => {
    const ht = { key: 'ht', default_mesher: 'snappy_hexdominant' };
    live([ht], [{ key: 'standard', plugin: 'builtin' }, { key: 'cfmesh', plugin: 'builtin' }]);
    assert.equal(defaultMeshEngineFor('ht'), 'standard');
    live([ht], [{ key: 'cfmesh', plugin: 'builtin' }, { key: 'snappy_hexdominant', plugin: 'meshing' }]);
    assert.equal(defaultMeshEngineFor('ht'), 'snappy_hexdominant');
    live([{ key: 'if' }], [{ key: 'cfmesh', plugin: 'builtin' }, { key: 'snappy_hexdominant', plugin: 'meshing' }]);
    assert.equal(defaultMeshEngineFor('if'), 'cfmesh');
    assert.equal(buildMeshDefaultsFromRegistry().mesh_engine, 'cfmesh');
    resetRegistryCache();
  });

  it("a study with no analysis_type is the default analysis's, as the page reads it", () => {
    const reg = loadCommittedRegistry();
    const key = defaultAnalysisKey();
    assert.ok(key);
    live(
      reg.analysis.map((r) => (r.key === key ? { ...r, default_mesher: 'cfmesh' } : r)),
      reg.mesher,
    );
    assert.equal(defaultMeshEngineFor(undefined), 'cfmesh');
    assert.equal(defaultMeshEngineFor(''), 'cfmesh');
    resetRegistryCache();
  });
});
