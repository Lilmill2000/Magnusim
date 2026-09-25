import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  'w21State',
  'w22State',
  'w23State',
  'w24State',
  'w25State',
  'w26State',
  'w27State',
  'window.__CFD_W22_STATE__',
  'window.__CFD_W26_STATE__',
  'window.__CFD_W27_STATE__',
];

test('gate:h4-legacy-gone', () => {
  const runtime = text('src/workbench/runtime.js');
  for (const name of BANNED) assert.equal(runtime.includes(name), false, name);
  assert.match(text('src/panels/run/RunControl.tsx'), /data-run-start/);
  // Phase 7: the geometry panel shows V0.1.0's rows from runtime state; its old
  // file-less "Import" job button is gone.
  const geometryPanel = text('src/panels/geometry/GeometryPanel.tsx');
  assert.match(geometryPanel, /subscribeGeometryState/);
  assert.equal(geometryPanel.includes('cad_import'), false);
  assert.match(text('src/panels/prefs/PluginsStep.tsx'), /registry\.reload/);
  assert.match(text('src/plugin-api/index.ts'), /pluginTreeNodes/);
  assert.match(text('scripts/server/routes.ts'), /registry\.reload/);
  const writes = text('src/workbench/hostWrites.js');
  assert.match(writes, /\/api\/run\/update/);
  assert.match(writes, /\/api\/run\/start/);
  assert.match(writes, /\/api\/mesh\/refinements/);
  assert.equal(runtime.includes("fetch('/api/run/update'"), false);
  assert.equal(runtime.includes("fetch('/api/run/start'"), false);
  assert.equal(runtime.includes("fetch('/api/mesh/refinements',"), false);
  assert.match(text('src/panels/run/RunMonitors.tsx'), /\/api\/run\/monitors/);
  // Phase 4: the run panel is React; the runtime publishes cfd:run-state and keeps no hidden Start.
  const shell = text('src/app/shell.html');
  for (const id of ['btn-sim-start', 'btn-sim-stop', 'sim-transient-fields', 'sim-run-hint', 'sim-end-time']) {
    assert.equal(shell.includes(`id="${id}"`), false, `shell.html still has #${id}`);
    assert.equal(runtime.includes(`'${id}'`), false, `runtime.js still targets #${id}`);
  }
  assert.match(shell, /<div id="panel-sim-control"[^>]*><\/div>/, 'run panel host must be an empty island host');
  assert.match(runtime, /cfd:run-state/);
  const panel = text('src/panels/run/RunControl.tsx');
  assert.equal(panel.includes('getElementById'), false);
  assert.match(panel, /from '\.\.\/legacyBridge'/);
  assert.match(text('src/chrome/FiltersPanel.tsx'), /\/api\/filter\//);
});

test('gate:phase5-settings-wizard', () => {
  const shell = text('src/app/shell.html');
  assert.equal(/preferences/i.test(shell), false, 'no Preferences string in shell.html');
  assert.match(shell, /id="home-prefs">Settings</);
  assert.match(shell, /id="wb-prefs">Settings</);
  assert.match(shell, /data-wiz-dot="5"[^>]*>Plugins</);
  assert.match(shell, /data-wiz-step="5"[\s\S]*id="wiz-plugins"/);
  assert.equal(existsSync(join(root, 'src/panels/prefs/Preferences.tsx')), false);
  assert.equal(/data-preferences/.test(text('src/style.css')), false);
  assert.match(text('src/panels/register.ts'), /replacePanel\('wiz-plugins', PluginsStep\)/);
  assert.match(text('src/wizard/controller.ts'), /mountIsland\('wiz-plugins'/);
});

test('gate:phase7-one-owner-per-panel', () => {
  // Every React island host is an empty shell: no legacy markup hidden underneath.
  const shell = text('src/app/shell.html');
  const register = text('src/panels/register.ts');
  const hosts = [...register.matchAll(/replacePanel\('([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(hosts.length >= 10, 'register.ts lists the island hosts');
  for (const id of hosts) {
    const open = new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>`);
    const m = shell.match(open);
    assert.ok(m, `host #${id} exists in shell.html`);
    const rest = shell.slice(m.index + m[0].length);
    const close = rest.indexOf(`</${m[1]}>`);
    assert.equal(rest.slice(0, close).trim(), '', `host #${id} has legacy children`);
  }
  // Nothing left to hide, and islands delete through the bridge, not hidden buttons.
  assert.equal(/cfd-host-island/.test(text('src/style.css')), false);
  assert.equal(/cfd-host-island/.test(text('src/islands.tsx')), false);
  assert.equal(/legacyDelete/.test(text('src/panels/scope.ts')), false);
  // Numbered prove hooks nobody calls are gone.
  const runtime = text('src/workbench/runtime.js');
  for (const hook of ['W7_APPLY', 'W16_APPLY', 'W21_APPLY', 'W22_OPEN', 'W27_START']) {
    assert.equal(runtime.includes(`window.__CFD_${hook}__`), false, hook);
  }
});
