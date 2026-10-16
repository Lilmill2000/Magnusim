// The mesher a new mesh starts with (API 1.8 default_mesher): one rule for the server's
// createMesh and the Mesh form (src/defaultMesher.ts), checked on the committed registry.
import { describe, expect, it } from 'vitest';
import committed from '../scripts/generated/registry.json';
import { appDefaultMeshEngine, defaultMeshEngine, newMeshEngines } from './defaultMesher';

const CORE = [{ key: 'standard' }, { key: 'cfmesh' }, { key: 'snappy_hexdominant' }];

describe('defaultMeshEngine', () => {
  it("is the analysis's default_mesher when a new mesh can use it, else the app's default", () => {
    expect(defaultMeshEngine({ default_mesher: 'snappy_hexdominant' }, CORE)).toBe('snappy_hexdominant');
    expect(defaultMeshEngine({ default_mesher: '' }, CORE)).toBe('standard');
    expect(defaultMeshEngine(null, CORE)).toBe('standard');
    // A mesher no plugin registers (a plugin off, removed): never used, the app's default instead.
    expect(defaultMeshEngine({ default_mesher: 'no_such_mesher' }, CORE)).toBe('standard');
    expect(defaultMeshEngine({ default_mesher: 'snappy_hexdominant' }, [{ key: 'standard' }, { key: 'cfmesh' }])).toBe('standard');
  });

  it('falls back to the first mesher a new mesh can use when Standard is not there (meshers in a plugin)', () => {
    const rows = [{ key: 'cfmesh' }, { key: 'my_mesher', plugin: 'meshing' }];
    expect(newMeshEngines(rows)).toEqual(['cfmesh', 'my_mesher']);
    expect(appDefaultMeshEngine(newMeshEngines(rows))).toBe('cfmesh');
    expect(defaultMeshEngine({ default_mesher: 'my_mesher' }, rows)).toBe('my_mesher');
    expect(defaultMeshEngine(null, [])).toBe('');
  });

  it('lists the core product engines in their order, then plugin meshers; never a builtin backend', () => {
    expect(newMeshEngines([{ key: 'snappy_hexdominant' }, { key: 'gmsh_backend' }, { key: 'standard' }, { key: 'x', plugin: 'p' }])).toEqual([
      'standard',
      'snappy_hexdominant',
      'x',
    ]);
  });

  it('on the registry as it ships: Heat Transfer starts on Hex-dominant, Incompressible Flow on Standard', () => {
    const reg = committed as unknown as { analysis: { key: string; default_mesher?: string }[]; mesher: { key: string; plugin?: string }[] };
    const row = (key: string) => reg.analysis.find((r) => r.key === key) || null;
    expect(defaultMeshEngine(row('incompressible_steady'), reg.mesher)).toBe('standard');
    expect(defaultMeshEngine(row('incompressible_transient'), reg.mesher)).toBe('standard');
    if (row('heat_transfer_steady')) {
      expect(defaultMeshEngine(row('heat_transfer_steady'), reg.mesher)).toBe('snappy_hexdominant');
      expect(defaultMeshEngine(row('heat_transfer_transient'), reg.mesher)).toBe('snappy_hexdominant');
    }
  });
});
