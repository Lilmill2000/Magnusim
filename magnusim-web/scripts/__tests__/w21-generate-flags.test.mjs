import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meshGenerateValues, meshGeneratorFlags } from '../w21-mesh-generate.js';

const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'python', 'tools');

/** The --flags a generator script declares with add_argument. */
function declaredFlags(script) {
  const src = readFileSync(join(TOOLS, script), 'utf8');
  return new Set([...src.matchAll(/add_argument\(\s*["'](--[a-z0-9-]+)["']/g)].map((m) => m[1]));
}

describe('mesh settings reach the generator', () => {
  it('uses the defaults the panel shows when a mesh has no settings', () => {
    // Hex-dominant used to read physics_based_meshing off null here.
    for (const none of [null, undefined, {}]) {
      assert.deepEqual(meshGenerateValues(none), {
        fineness: 5,
        addLayers: true,
        physicsBased: true,
        hexCore: true,
        smallFeature: 'auto',
        gapFactor: 0.05,
        gradation: 1.22,
      });
    }
  });

  it('passes every Standard setting the panel saves', () => {
    const settings = {
      fineness: 3,
      hex_element_core: false,
      automatic_boundary_layers: false,
      physics_based_meshing: false,
      advanced: {
        mesh_engine: 'standard',
        small_feature_suppression: ' 0.002 ',
        gap_refinement_factor: 0.2,
        global_gradation_rate: 1.5,
      },
    };
    assert.deepEqual(meshGeneratorFlags(meshGenerateValues(settings), 'standard'), [
      '--fineness', '3',
      '--add-layers', '0',
      '--physics-based', '0',
      '--hex-core', '0',
      '--small-feature', '0.002',
      '--gap-factor', '0.2',
      '--gradation', '1.5',
    ]);
  });

  it('gives cfMesh and Hex-dominant only the flags their generators read', () => {
    const settings = {
      fineness: 12,
      hex_element_core: true,
      automatic_boundary_layers: true,
      advanced: { gap_refinement_factor: 0.3 },
    };
    const expected = ['--fineness', '10', '--add-layers', '1', '--physics-based', '1'];
    assert.deepEqual(meshGeneratorFlags(meshGenerateValues(settings), 'cfmesh'), expected);
    assert.deepEqual(meshGeneratorFlags(meshGenerateValues(settings), 'snappy_hexdominant'), expected);
  });

  it('only sends flags each generator script declares', () => {
    const values = meshGenerateValues({});
    for (const [engine, script] of [
      ['standard', 'generate_standard.py'],
      ['cfmesh', 'generate_cfmesh_standard.py'],
      ['snappy_hexdominant', 'generate_snappy.py'],
    ]) {
      const declared = declaredFlags(script);
      for (const flag of meshGeneratorFlags(values, engine).filter((a) => a.startsWith('--'))) {
        assert.ok(declared.has(flag), `${script} does not declare ${flag}`);
      }
    }
  });
});
