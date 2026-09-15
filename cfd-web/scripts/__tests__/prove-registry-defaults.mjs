/**
 * Phase 2 land13 smoke: dual-defaults consumer matches committed registry dump.
 * Run: node scripts/__tests__/prove-registry-defaults.mjs
 */
import {
  DEFAULT_ANALYSIS_KEY,
  MESH_ENGINES,
  REGISTRY_JSON_PATH,
  analysisKeys,
  buildMeshDefaultsFromRegistry,
  buildW17DefaultsFromRegistry,
  loadCommittedRegistry,
  mesherKeys,
  meshEngineKeys,
} from '../registry-defaults.js';
import { W17_DEFAULTS } from '../w17-simulation.js';
import { W20_DEFAULTS, MESH_ENGINES as W20_MESH_ENGINES } from '../w20-mesh.js';

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

const dump = loadCommittedRegistry();
const aKeys = new Set(analysisKeys());
const mKeys = new Set(mesherKeys());
const engines = meshEngineKeys();

if (!aKeys.has(DEFAULT_ANALYSIS_KEY)) {
  fail(`dump analysis missing ${DEFAULT_ANALYSIS_KEY}`);
}
for (const k of ['standard', 'cfmesh', 'snappy_hexdominant']) {
  if (!mKeys.has(k)) fail(`dump mesher missing ${k}`);
}

const w17 = buildW17DefaultsFromRegistry();
if (w17.analysis_type !== DEFAULT_ANALYSIS_KEY) {
  fail(`W17 analysis_type ${w17.analysis_type} != ${DEFAULT_ANALYSIS_KEY}`);
}
if (!aKeys.has(w17.analysis_type)) {
  fail(`W17 analysis_type not in dump: ${w17.analysis_type}`);
}
if (W17_DEFAULTS.analysis_type !== w17.analysis_type) {
  fail('exported W17_DEFAULTS.analysis_type drifted from builder');
}
if (W17_DEFAULTS.analysis_title !== w17.analysis_title) {
  fail('W17 analysis_title drifted');
}
if (W17_DEFAULTS.analysis !== 'Incompressible') {
  fail('bank analysis display name must remain Incompressible for create gate');
}

for (const k of MESH_ENGINES) {
  if (!mKeys.has(k)) fail(`MESH_ENGINES key not in dump: ${k}`);
}
for (const k of engines) {
  if (!MESH_ENGINES.has(k)) fail(`meshEngineKeys missing from MESH_ENGINES: ${k}`);
}
if (
  ![...MESH_ENGINES].every((k) => W20_MESH_ENGINES.has(k)) ||
  MESH_ENGINES.size !== W20_MESH_ENGINES.size
) {
  fail('w20 MESH_ENGINES re-export drifted from registry-defaults');
}

const mesh = buildMeshDefaultsFromRegistry();
if (!mKeys.has(mesh.mesh_engine)) {
  fail(`default mesh_engine not in dump: ${mesh.mesh_engine}`);
}
if (W20_DEFAULTS.advanced.mesh_engine !== mesh.mesh_engine) {
  fail('W20 mesh_engine drifted from dump-backed default');
}
if (W20_DEFAULTS.algorithm !== mesh.algorithm_label) {
  fail('W20 algorithm label drifted from dump mesher label');
}

if (!Array.isArray(dump.analysis) || dump.analysis.length === 0) fail('empty analysis');
if (!Array.isArray(dump.mesher) || dump.mesher.length === 0) fail('empty mesher');

console.log(
  JSON.stringify(
    {
      ok: true,
      registry: REGISTRY_JSON_PATH,
      analysis_type: W17_DEFAULTS.analysis_type,
      analysis_title: W17_DEFAULTS.analysis_title,
      mesh_engine: W20_DEFAULTS.advanced.mesh_engine,
      algorithm: W20_DEFAULTS.algorithm,
      MESH_ENGINES: [...MESH_ENGINES].sort(),
      analysis_keys: [...aKeys].sort(),
      mesher_keys: [...mKeys].sort(),
    },
    null,
    2
  )
);
