import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function text(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

const BANNED = [
  'w17State',
  'w18State',
  'w19State',
  'w20State',
  'function persistActiveBc',
  'function saveMeshSettingsClient',
  'function syncSimulationTree',
  'window.__CFD_W17_STATE__',
  'window.__CFD_W18_STATE__',
  'window.__CFD_W19_STATE__',
  'window.__CFD_W20_STATE__',
];

test('gate:h3-simulation-legacy-gone', () => {
  const runtime = text('src/workbench/runtime.js');
  const api = text('src/api/w17.ts');
  const hub = text('src/panels/SimulationHub.tsx');
  for (const name of BANNED) assert.equal(runtime.includes(name), false, name);
  assert.equal(api.includes('acceptsW17Analysis'), false);
  assert.equal(hub.includes('acceptsW17Analysis'), false);
  assert.equal(text('scripts/w17-simulation.js').includes('acceptsW17Analysis'), false);
  // Phase 6: the study panel saves through the runtime's /api/simulation/update merge
  // (saveStudy); the runtime publishes cfd:study instead of writing hidden rows.
  const panel = text('src/panels/simulation/SimulationPanel.tsx');
  assert.match(panel, /saveStudy\(/);
  assert.equal(panel.includes('legacyDelete'), false);
  assert.match(runtime, /'cfd:study'/);
  const shell = text('src/app/shell.html');
  for (const id of ['sim-time-select', 'study-rename', 'study-panel-title', 'sim-algorithm', 'sim-delete']) {
    assert.equal(shell.includes(`id="${id}"`), false, `legacy study markup #${id}`);
    assert.equal(runtime.includes(`getElementById('${id}')`), false, `runtime still reads #${id}`);
  }
});

test('gate:h3-materials-legacy-gone', () => {
  const runtime = text('src/workbench/runtime.js');
  const shell = text('src/app/shell.html');
  const panel = text('src/panels/materials/MaterialsPanel.tsx');
  for (const name of BANNED) assert.equal(runtime.includes(name), false, name);
  assert.match(panel, /materials\.set/);
  // Viewport and tree body clicks reach the panel as cfd:bodies; the panel is the one writer.
  assert.match(panel, /subscribeBodyPicks/);
  assert.equal(panel.includes("apiPost('/api/materials'"), false);
  assert.equal(panel.includes('legacyDelete'), false);
  assert.match(runtime, /publishBodySelection\(/);
  for (const name of ['air-assign-list', 'syncAirPropertyLabels', 'persistAirAssignment', 'syncAirAssignList']) {
    assert.equal(runtime.includes(name), false, `runtime.js still has ${name}`);
    assert.equal(shell.includes(name), false, `shell.html still has ${name}`);
  }
  for (const host of ['panel-air-material', 'panel-material-picker', 'panel-materials-hub']) {
    assert.match(shell, new RegExp(`<div id="${host}"[^>]*></div>`), `${host} must be an empty island host`);
  }
});

test('gate:h3-bcs-legacy-gone', () => {
  const runtime = text('src/workbench/runtime.js');
  const panel = text('src/panels/bcs/BcPanel.tsx');
  const shell = text('src/app/shell.html');
  for (const name of BANNED) assert.equal(runtime.includes(name), false, name);
  assert.match(panel, /bc\.menu/);
  assert.equal(panel.includes('PRODUCT'), false);
  assert.match(runtime, /toggleFaceId/);
  assert.match(text('src/viewer/pick.ts'), /export function toggleFaceId/);
  // The islands reach the runtime only through legacyBridge; the runtime saves through the worker.
  assert.match(panel, /from '\.\.\/legacyBridge'/);
  assert.equal(panel.includes('getElementById'), false);
  assert.equal(panel.includes('legacyDelete'), false);
  assert.match(text('src/workbench/setupPersist.js'), /bcs\.set/);
  assert.match(runtime, /cfd:bcs/);
  // Select-then-Add and the hub/editor are React; the legacy picker, hub and editor DOM are gone.
  for (const id of ['bc-picker-apply', 'bc-assign-list', 'bcs-hub-list', 'btn-add-bc', 'bc-editor-type', 'bc-p-value', 'bc-delete']) {
    assert.equal(shell.includes(`id="${id}"`), false, `shell.html still has #${id}`);
    assert.equal(runtime.includes(`'${id}'`), false, `runtime.js still targets #${id}`);
  }
  for (const host of ['panel-bcs-hub', 'panel-bc-picker', 'panel-bc-editor']) {
    assert.match(shell, new RegExp(`<div id="${host}"[^>]*></div>`), `${host} must be an empty island host`);
  }
});

test('gate:h3-mesh-legacy-gone', () => {
  const runtime = text('src/workbench/runtime.js');
  const panel = text('src/panels/mesh/MeshPanel.tsx');
  const shell = text('src/app/shell.html');
  for (const name of BANNED) assert.equal(runtime.includes(name), false, name);
  // The island reaches the runtime only through legacyBridge, never raw globals or hidden DOM.
  assert.equal(panel.includes('__CFD_MESH_DRAFTS__'), false);
  assert.equal(panel.includes('__CFD_W21_GENERATE__'), false);
  assert.equal(panel.includes('getElementById'), false);
  assert.match(panel, /mesh\.set/);
  assert.match(panel, /from '\.\.\/legacyBridge'/);
  // One Generate path: the legacy button and the panel's progress DOM are gone.
  for (const id of ['btn-generate-mesh', 'mesh-fineness', 'mesh-finished-line', 'mesh-restore-defaults', 'mesh-delete', 'mesh-rename']) {
    assert.equal(shell.includes(`id="${id}"`), false, `shell.html still has #${id}`);
    assert.equal(runtime.includes(`'${id}'`), false, `runtime.js still targets #${id}`);
  }
  assert.match(shell, /<div id="panel-mesh-form"[^>]*><\/div>/, 'mesh form host must be an empty island host');
  assert.match(runtime, /cfd:mesh-job/);
});

test('gate:h3-replace-panel', () => {
  const api = text('src/plugin-api/index.ts');
  const register = text('src/panels/register.ts');
  assert.match(api, /replacePanel/);
  assert.match(api, /'results' \| 'prefs' \| 'geometry'/);
  assert.match(register, /replacePanel\('panel-incompressible-defaults'/);
  assert.match(register, /replacePanel\('panel-mesh-form'/);
  assert.match(register, /replacePanel\('panel-bc-editor'/);
  assert.match(register, /replacePanel\('panel-air-material'/);
  assert.match(text('src/workbench/runtime.js'), /mountIsland\(id, \{ scope, itemId \}\)/);
});
