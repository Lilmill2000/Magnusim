// Which browser-test suites a change runs (scripts/e2e-suites.mjs, docs/TESTING.md),
// and the PC's WSL test lock (e2e/support/wsl-lock.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONTRACT_SPECS, HOST_PATHS, classifyPath, discoverPluginSuites, planSuites, suiteOfFilter, toWebRel } from '../e2e-suites.mjs';
import { acquireWslLock, mayRunWslTests } from '../../e2e/support/wsl-lock.mjs';

const PLUGINS = ['cad'];

test('documentation, unit tests and files outside the app run no browser suite', () => {
  for (const rel of [
    'docs/TESTING.md',
    'README.md',
    'bundled-plugins/cad/README.md',
    'bundled-plugins/cad/LICENSES/OCCT.txt',
    'src/panels/PanelChrome.test.tsx',
    'scripts/__tests__/listen-port.test.mjs',
    'python/tests/unit/test_h8_bundled.py',
    'bundled-plugins/incompressible_flow/tests/test_transient.py',
    'bundled-plugins/cad/tests/kernel/kernel-ops.test.ts',
    'templates/plugin/plugin.py',
    '../ROADMAP.md',
    '../.github/workflows/ci.yml',
  ]) {
    assert.equal(classifyPath(rel, PLUGINS).kind, 'none', rel);
  }
  assert.deepEqual(planSuites(['docs/TESTING.md', 'src/x.test.ts'], PLUGINS).core, null);
});

test('a core change runs the whole core suite and every plugin suite', () => {
  for (const rel of [
    'src/panels/PanelChrome.tsx',
    'scripts/server/compute-queue.ts',
    'python/cfddesk/registry/discovery.py',
    'python/tests/fixtures/plugins/stub-analysis/plugin.py',
    'e2e/support/host-server.mjs',
    'e2e/prepare-projects.js',
    'playwright.config.js',
    'package.json',
    'vite.config.js',
  ]) {
    assert.equal(classifyPath(rel, PLUGINS).kind, 'core', rel);
    const plan = planSuites([rel], PLUGINS);
    assert.equal(plan.core.specs, null, rel);
    assert.deepEqual(Object.keys(plan.plugins), ['cad'], rel);
  }
});

test('a plugin with its own suite runs that suite and only the core contract specs', () => {
  const plan = planSuites(['bundled-plugins/cad/src/app.ts', 'bundled-plugins/cad/e2e/cad-p1-scaffold.spec.ts'], PLUGINS);
  assert.deepEqual(Object.keys(plan.plugins), ['cad']);
  assert.deepEqual(plan.core.specs, [...CONTRACT_SPECS].sort());
});

test('a plugin whose browser tests are still in e2e/ runs the core suite, not other plugins', () => {
  const plan = planSuites(['bundled-plugins/incompressible_flow/ui/RunSettings.tsx'], PLUGINS);
  assert.equal(plan.core.specs, null);
  assert.deepEqual(plan.plugins, {});
});

test('a changed core spec runs that spec alone, unless the core changed too', () => {
  assert.deepEqual(planSuites(['e2e/h13-workspace.spec.js'], PLUGINS).core.specs, ['e2e/h13-workspace.spec.js']);
  assert.deepEqual(planSuites(['e2e/h13-workspace.spec.js'], PLUGINS).plugins, {});
  assert.equal(planSuites(['e2e/h13-workspace.spec.js', 'src/scope.ts'], PLUGINS).core.specs, null);
  const both = planSuites(['e2e/home.spec.js', 'bundled-plugins/cad/src/app.ts'], PLUGINS);
  assert.deepEqual(both.core.specs, ['e2e/h5-plugins.spec.js', 'e2e/h8-contract.spec.js', 'e2e/home.spec.js']);
});

test('a core change outside the host paths a plugin depends on does not run its suite', () => {
  const suites = [
    { key: 'cad', hostPaths: HOST_PATHS.cad },
    { key: 'incompressible_flow', hostPaths: null },
  ];
  // runtime.js, panels and the mesh scripts: the core suite checks them; CAD never reaches them.
  for (const rel of ['src/workbench/runtime.js', 'src/panels/bcs/BcPanel.tsx', 'scripts/w21-mesh-generate.js', 'python/cfddesk/mesh/gmsh_standard.py']) {
    const plan = planSuites([rel], suites);
    assert.equal(plan.core.specs, null, rel);
    assert.deepEqual(Object.keys(plan.plugins), ['incompressible_flow'], rel);
  }
  // The plugin host, the shared harness and the runner itself: CAD too.
  for (const rel of [
    'src/workspace/bridge.ts',
    'src/workbench/dialogs.ts',
    'scripts/server/plugin-files.ts',
    'python/cfddesk/registry/plugin_data.py',
    'python/cfddesk/project/scope.py',
    'e2e/support/host-server.mjs',
    'scripts/e2e-suites.mjs',
    'package.json',
  ]) {
    assert.deepEqual(Object.keys(planSuites([rel], suites).plugins), ['cad', 'incompressible_flow'], rel);
  }
  // A change in one plugin never runs another plugin's suite.
  assert.deepEqual(Object.keys(planSuites(['bundled-plugins/incompressible_flow/ui/RunSettings.tsx'], suites).plugins), ['incompressible_flow']);
  assert.deepEqual(Object.keys(planSuites(['bundled-plugins/cad/src/app.ts'], suites).plugins), ['cad']);
});

test('plugin suites are found by their own test:e2e script or an e2e/playwright.config.js', () => {
  const web = mkdtempSync(join(tmpdir(), 'magnusim-suites-'));
  try {
    const put = (rel, text) => {
      mkdirSync(join(web, rel, '..'), { recursive: true });
      writeFileSync(join(web, rel), text);
    };
    put('bundled-plugins/own/package.json', JSON.stringify({ scripts: { 'test:e2e': 'node e2e.mjs' }, magnusim: { e2eHostPaths: ['src/workspace/'] } }));
    put('bundled-plugins/cad/package.json', JSON.stringify({ scripts: { 'test:e2e': 'node e2e.mjs' } }));
    put('bundled-plugins/shared/e2e/playwright.config.js', 'export default {};');
    put('bundled-plugins/none/manifest.toml', 'key = "none"');
    put('bundled-plugins/lib/package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    assert.deepEqual(discoverPluginSuites(web), [
      { key: 'cad', run: 'npm', hostPaths: HOST_PATHS.cad },
      { key: 'own', run: 'npm', hostPaths: ['src/workspace/'] },
      { key: 'shared', run: 'playwright', config: 'bundled-plugins/shared/e2e/playwright.config.js', hostPaths: null },
    ]);
  } finally {
    rmSync(web, { recursive: true, force: true });
  }
});

test('a spec named on the command line runs in the suite that holds it', () => {
  const keys = ['cad', 'incompressible_flow'];
  assert.equal(suiteOfFilter('e2e/smoke.spec.js', keys), 'core');
  assert.equal(suiteOfFilter('bundled-plugins/incompressible_flow/e2e/h7-steady-transient.spec.js', keys), 'incompressible_flow');
  assert.equal(suiteOfFilter(['magnusim-web', 'bundled-plugins', 'cad', 'e2e', 'cad-p1-scaffold.spec.ts'].join('\\'), keys), 'cad');
  assert.equal(suiteOfFilter('bundled-plugins/unknown/e2e/x.spec.js', keys), 'core');
});

test('changed paths read from magnusim-web, from the repository root, or absolute', () => {
  const repo = join(tmpdir(), 'repo');
  const web = join(repo, 'magnusim-web');
  assert.equal(toWebRel('src/a.ts', repo, web), 'src/a.ts');
  assert.equal(toWebRel('magnusim-web/src/a.ts', repo, web), 'src/a.ts');
  assert.equal(toWebRel('magnusim-web\\src\\a.ts', repo, web), 'src/a.ts');
  assert.equal(toWebRel(join(web, 'src', 'gone.ts'), repo, web), 'src/gone.ts');
  assert.equal(toWebRel(join(repo, 'ROADMAP.md'), repo, web), '../ROADMAP.md');
  // Without git (a snapshot) a relative path is still read from magnusim-web.
  assert.equal(toWebRel('src/a.ts', null, web), 'src/a.ts');
});

test('the WSL lock is taken only by runs that may mesh or solve', () => {
  const wsl = ['C:\\w\\e2e\\smoke.spec.js', 'C:\\w\\e2e\\results-tools.spec.js'];
  assert.equal(mayRunWslTests([], wsl), true);
  assert.equal(mayRunWslTests([], []), false);
  assert.equal(mayRunWslTests(['e2e/home.spec.js'], wsl), false);
  assert.equal(mayRunWslTests(['e2e/smoke.spec.js'], wsl), true);
  assert.equal(mayRunWslTests(['e2e\\smoke.spec.js:120'], wsl), true);
  assert.equal(mayRunWslTests(['results'], wsl), true);
  assert.equal(mayRunWslTests(['--reporter', 'line', 'e2e/h13-workspace.spec.js'], wsl), false);
  assert.equal(mayRunWslTests(['--reporter=line', '-g', 'smoke', 'e2e/h13-workspace.spec.js'], wsl), false);
  assert.equal(mayRunWslTests(['--list'], wsl), false);
  // Tests chosen some other way: unsure, so yes.
  assert.equal(mayRunWslTests(['--last-failed'], wsl), true);
  assert.equal(mayRunWslTests(['--only-changed=HEAD'], wsl), true);
});

test('a second run waits for the WSL lock, and a dead holder does not block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magnusim-lock-test-'));
  const file = join(dir, 'e2e-wsl.lock');
  try {
    // A holder process that is gone: its lock is stale.
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: 'then', cwd: 'x', what: 'old run' }));
    const release = await acquireWslLock({ file, waitMs: 5000, what: 'first', log: () => {} });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
    release();
    assert.throws(() => readFileSync(file));

    // A live holder (another process): the next run waits, says why, and gives up at waitMs.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ pid: holder.pid, at: 'now', cwd: 'other-checkout', what: 'playwright test' }));
      const said = [];
      await assert.rejects(acquireWslLock({ file, waitMs: 1500, log: (l) => said.push(l) }), /still holds .*other-checkout/);
      assert.match(said[0], /waiting for the WSL test lock .*other-checkout/);
      // The holder ends: the waiting run gets the lock.
      holder.kill();
      await new Promise((r) => holder.once('exit', r));
      const again = await acquireWslLock({ file, waitMs: 5000, log: () => {} });
      again();
    } finally {
      holder.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
