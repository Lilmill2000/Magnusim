// Which browser-test suites a change runs (scripts/e2e-suites.mjs, docs/TESTING.md),
// and the PC's WSL test lock (e2e/support/wsl-lock.mjs).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTRACT_SPECS, HOST_PATHS, LINK_HOST_PATHS, START_ACTION_HOST_PATHS, classifyPath, discoverPluginSuites, isFullTier, parseArgs, planSuites, suiteEnv, suiteOfFilter, toWebRel } from '../e2e-suites.mjs';
import { acquireWslLock, mayRunWslTests } from '../../e2e/support/wsl-lock.mjs';

const PLUGINS = ['cad'];
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = WEB;

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
    'src/plugin-ui/panels/Toast.tsx',
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

test('gate:l1-suites a plugin that declares start actions or links a geometry depends on those host paths too', () => {
  const web = mkdtempSync(join(tmpdir(), 'magnusim-suites-'));
  try {
    const put = (rel, text) => {
      mkdirSync(join(web, rel, '..'), { recursive: true });
      writeFileSync(join(web, rel), text);
    };
    const npm = (hostPaths) => JSON.stringify({ scripts: { 'test:e2e': 'node e2e.mjs' }, ...(hostPaths ? { magnusim: { e2eHostPaths: hostPaths } } : {}) });
    const kind = (extra = '') => `[[study_kinds]]\nkey = "part"\ntitle = "Part"\nworkspace = "part"\n${extra}`;
    put('bundled-plugins/starter/package.json', npm(['src/plugin-sdk/']));
    put('bundled-plugins/starter/manifest.toml', `key = "starter"\n\n${kind()}\n[[start_actions]]\nstudy_kind = "part"\nlabel = "Start"\n`);
    put('bundled-plugins/linker/package.json', npm(['src/plugin-sdk/']));
    put('bundled-plugins/linker/manifest.toml', `key = "linker"\n\n${kind('links_geometry = true\n')}`);
    put('bundled-plugins/both/e2e/playwright.config.js', 'export default {};');
    put('bundled-plugins/both/package.json', JSON.stringify({ magnusim: { e2eHostPaths: ['src/plugin-sdk/'] } }));
    put('bundled-plugins/both/manifest.toml', `key = "both"\n\n${kind('links_geometry  =  true   # opt in\n')}\n[[start_actions]]\nstudy_kind = "part"\nlabel = "Start"\n`);
    // Commented out, or false: nothing is added.
    put('bundled-plugins/quiet/package.json', npm(['src/plugin-sdk/']));
    put('bundled-plugins/quiet/manifest.toml', `key = "quiet"\n\n${kind('links_geometry = false\n')}\n# [[start_actions]]\n# links_geometry = true\n`);
    // No list of its own: it already runs on every core change.
    put('bundled-plugins/all/package.json', npm(null));
    put('bundled-plugins/all/manifest.toml', `key = "all"\n\n${kind()}\n[[start_actions]]\nstudy_kind = "part"\nlabel = "Start"\n`);
    const byKey = Object.fromEntries(discoverPluginSuites(web).map((s) => [s.key, s.hostPaths]));
    assert.deepEqual(byKey.starter, ['src/plugin-sdk/', ...START_ACTION_HOST_PATHS]);
    assert.deepEqual(byKey.linker, ['src/plugin-sdk/', ...LINK_HOST_PATHS]);
    assert.deepEqual(byKey.both, ['src/plugin-sdk/', ...START_ACTION_HOST_PATHS, ...LINK_HOST_PATHS]);
    assert.deepEqual(byKey.quiet, ['src/plugin-sdk/']);
    assert.equal(byKey.all, null);
    // The host's own files for them, with no plugin named.
    for (const p of ['src/home/', 'src/workspace/startActions.ts', 'src/chrome/MenuButton.tsx', 'python/cfddesk/registry/']) {
      assert.ok(START_ACTION_HOST_PATHS.includes(p), p);
    }
    for (const p of ['src/workspace/linkChoice.ts', 'scripts/link-store.js', 'scripts/link-build.js', 'scripts/compute-slot.js', 'python/cfddesk/project/']) {
      assert.ok(LINK_HOST_PATHS.includes(p), p);
    }
    for (const list of [START_ACTION_HOST_PATHS, LINK_HOST_PATHS]) assert.ok(!list.some((p) => p.startsWith('bundled-plugins/')), list.join(' '));
    // So a change to the Home page runs the starter's suite, not the quiet one's; so does
    // a change to any other file that draws, publishes or opens a start action.
    for (const changed of [
      'src/home/controller.ts',
      'src/workbench/runtime.js',
      'src/chrome/LeftTree.tsx',
      'src/chrome/treeModel.ts',
      'src/app/shell.html',
    ]) {
      const plan = planSuites([changed], discoverPluginSuites(web));
      assert.ok(plan.plugins.starter && plan.plugins.both && plan.plugins.all, changed);
      assert.equal(plan.plugins.quiet, undefined, changed);
      assert.equal(plan.plugins.linker, undefined, changed);
    }
    // The worker files that read and repair a linked geometry (API 1.5) run both groups.
    for (const changed of ['python/cfddesk/worker/methods.py', 'python/cfddesk/worker/link_methods.py']) {
      const plan = planSuites([changed], discoverPluginSuites(web));
      assert.ok(plan.plugins.linker && plan.plugins.both && plan.plugins.all, changed);
      assert.equal(plan.plugins.quiet, undefined, changed);
    }
    assert.ok(planSuites(['python/cfddesk/worker/methods.py'], discoverPluginSuites(web)).plugins.starter);
    // HOST_PATHS.cad keeps its own list: a manifest adds the groups, not this table.
    assert.ok(!HOST_PATHS.cad.includes('src/home/'));
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

test('the full tier (--all, not --fast) tells every suite MAGNUSIM_E2E_FULL=1', () => {
  const full = (argv, base = {}) => suiteEnv(parseArgs(argv), base).MAGNUSIM_E2E_FULL;
  // npm run test:e2e (before a push, nightly), whole suites, one suite or several.
  assert.equal(full(['--all']), '1');
  assert.equal(full(['--all', '--suite', 'airfoil']), '1');
  assert.equal(full(['--all', '--full']), '1');
  // Not the full tier: the fast tier, the changed suites, named specs, WSL turned off by hand.
  assert.equal(full(['--all', '--fast']), undefined);
  assert.equal(full(['--changed']), undefined);
  assert.equal(full(['--changed', '--full']), undefined);
  assert.equal(full(['--all', 'bundled-plugins/airfoil/e2e/airfoil.spec.js']), undefined);
  assert.equal(full(['--all'], { MAGNUSIM_E2E_WSL: '0' }), undefined);
  // A value set by hand is kept; the fast tier still turns WSL off.
  assert.equal(full(['--changed'], { MAGNUSIM_E2E_FULL: '1' }), '1');
  assert.equal(suiteEnv(parseArgs(['--all', '--fast']), {}).MAGNUSIM_E2E_WSL, '0');
  assert.equal(suiteEnv(parseArgs(['--all']), { MAGNUSIM_E2E_SETTLED: '1' }).MAGNUSIM_E2E_SETTLED, undefined);
  assert.equal(isFullTier(parseArgs(['--all']), {}), true);
});

const CI_YML = join(WEB, '..', '.github', 'workflows', 'ci.yml');

// One job of a GitHub workflow, read line by line (comment lines dropped): whether the job
// can be turned off (`if:`, `continue-on-error:`), and each step's command and the same two keys.
function workflowJob(text, name) {
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  const value = (l) => l.replace(/^[\s-]*[\w-]+:\s*/, '').replace(/\s+#.*$/, '').trim();
  const job = { if: body.some((l) => /^ {4}if:/.test(l)), continueOnError: body.some((l) => /^ {4}continue-on-error:/.test(l)), steps: [] };
  let step = null;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i];
    if (/^ {6}- /.test(l)) {
      step = { run: '', if: false, continueOnError: false };
      job.steps.push(step);
    }
    if (!step || !/^ {6}(- | {2})[\w-]+:/.test(l)) continue;
    const key = l.replace(/^ {6}(- | {2})/, '').split(':')[0];
    if (key === 'if') step.if = true;
    if (key === 'continue-on-error') step.continueOnError = value(l) !== 'false';
    if (key === 'run') {
      step.run = value(l);
      if (/^[|>]/.test(step.run)) {
        const block = [];
        while (i + 1 < body.length && /^ {10}/.test(body[i + 1])) block.push(body[++i].trim());
        step.run = block.join('\n');
      }
    }
  }
  return job;
}

test('a workflow job is read with its comments, conditions and run blocks', () => {
  const yml = [
    'jobs:',
    '  node:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm ci',
    '      # - run: npx playwright test -c a/playwright.config.js',
    '      - name: B',
    '        if: false',
    '        run: npx playwright test -c b/playwright.config.js',
    '      - run: |',
    '          echo one',
    '          npx playwright test -c c/playwright.config.js',
    '      - run: npx playwright test -c d/playwright.config.js # d',
    '        continue-on-error: true',
    '  other:',
    '    if: false',
    '    steps:',
    '      - run: npx playwright test -c e/playwright.config.js',
  ].join('\n');
  const node = workflowJob(yml, 'node');
  assert.deepEqual(node.steps.map((s) => [s.run, s.if, s.continueOnError]), [
    ['npm ci', false, false],
    ['npx playwright test -c b/playwright.config.js', true, false],
    ['echo one\nnpx playwright test -c c/playwright.config.js', false, false],
    ['npx playwright test -c d/playwright.config.js', false, true],
  ]);
  assert.equal(node.if, false);
  assert.equal(workflowJob(yml, 'other').if, true);
  assert.equal(workflowJob(yml, 'missing'), null);
});

test('CI runs every bundled plugin suite that runs on the core\'s Playwright', { skip: !existsSync(CI_YML) && 'no .github/workflows/ci.yml beside this folder (a snapshot)' }, () => {
  const node = workflowJob(readFileSync(CI_YML, 'utf8'), 'node');
  assert.ok(node, 'ci.yml has no node job');
  assert.ok(!node.if && !node.continueOnError, 'the node job can be turned off (if: or continue-on-error:)');
  const suites = discoverPluginSuites().filter((s) => s.run === 'playwright');
  assert.ok(suites.length > 0);
  for (const s of suites) {
    // A step of its own, not commented out, not in another job, not behind if: or continue-on-error:.
    const steps = node.steps.filter((st) => st.run === `npx playwright test -c ${s.config}`);
    assert.ok(steps.some((st) => !st.if && !st.continueOnError), `${s.key}: the node job of ci.yml does not run ${s.config}`);
  }
});

test('the plan says whether it is the full tier', () => {
  const plan = (argv) => {
    const r = spawnSync(process.execPath, ['scripts/e2e-suites.mjs', ...argv, '--json'], {
      cwd: WEB,
      encoding: 'utf8',
      env: { ...process.env, MAGNUSIM_E2E_WSL: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(plan(['--all']).full, true);
  assert.equal(plan(['--all', '--fast']).full, false);
  assert.equal(plan(['--changed', '--files', 'src/app/main.ts']).full, false);
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
  // ... and a path from the repository root too, so it still reaches a plugin's host paths.
  assert.equal(toWebRel('magnusim-web/src/workspace/bridge.ts', null, web), 'src/workspace/bridge.ts');
  assert.equal(toWebRel('magnusim-web\\src\\a.ts', null, web), 'src/a.ts');
  assert.equal(toWebRel('magnusim-web', null, web), '');
  const snap = planSuites([toWebRel('magnusim-web/src/workspace/bridge.ts', null, web)], [{ key: 'cad', run: 'npm', hostPaths: HOST_PATHS.cad }]);
  assert.ok(snap.plugins.cad, JSON.stringify(snap));
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

test('a plugin suite on the core\'s Playwright reaches the core harness only through e2e/support/plugin-suite.js', () => {
  const seam = join(WEB_ROOT, 'e2e', 'support', 'plugin-suite.js');
  const pluginsDir = join(WEB_ROOT, 'bundled-plugins');
  const suites = readdirSync(pluginsDir).filter((key) => existsSync(join(pluginsDir, key, 'e2e', 'playwright.config.js')));
  assert.ok(suites.includes('incompressible_flow'), suites.join(' '));
  const specifiers = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const outside = [];
  // Suites that have moved onto the seam; another bundled suite (Airfoil) still
  // imports the core harness directly until it adopts plugin-suite.js.
  const onSeam = ['incompressible_flow'];
  for (const key of suites.filter((k) => onSeam.includes(k))) {
    const dir = join(pluginsDir, key, 'e2e');
    const files = readdirSync(dir).filter((name) => /\.(c|m)?[jt]s$/.test(name));
    assert.ok(files.includes('seed.js') || key !== 'incompressible_flow', 'incompressible_flow seeds its own projects');
    for (const name of files) {
      for (const spec of specifiers(readFileSync(join(dir, name), 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = resolve(dir, spec);
        const rel = relative(join(pluginsDir, key), target);
        if (!rel.startsWith('..') && !rel.startsWith(sep)) continue;
        if (target !== seam) outside.push(`${key}/e2e/${name}: ${spec}`);
      }
    }
  }
  assert.deepEqual(outside, [], 'import these through ../../../e2e/support/plugin-suite.js');
});

test('the plugin seam re-exports what plugin suites use', async () => {
  const seam = await import('../../e2e/support/plugin-suite.js');
  for (const name of [
    'appSuiteConfig',
    'NO_WSL',
    'NO_HEAVY',
    'wslPathExists',
    'waitSlotFree',
    'addAir',
    'addBc',
    'createStudy',
    'setup',
    'PYTHON',
    'seedElbowProject',
  ]) {
    assert.ok(name in seam, name);
  }
});

test('a plugin suite seeds its own projects after the core\'s', async () => {
  const { appSuiteConfig } = await import('../../e2e/support/app-config.js');
  const { runSuiteSeed } = await import('../../e2e/support/seed-suite.js');
  const seedPath = join(WEB_ROOT, 'bundled-plugins', 'incompressible_flow', 'e2e', 'seed.js');
  // appSuiteConfig sets the runner's environment; put it back after.
  const saved = { ...process.env };
  process.env.MAGNUSIM_E2E_SETTLED = '1';
  try {
    const cfg = appSuiteConfig({ name: 'incompressible_flow', testDir: dirname(seedPath), seed: seedPath });
    assert.match(cfg.webServer.command, /^node e2e\/prepare-projects\.js && node e2e\/support\/seed-suite\.js ".*seed\.js" && npm run dev$/);
    const core = appSuiteConfig({ testDir: join(WEB_ROOT, 'e2e') });
    assert.equal(core.webServer.command, 'node e2e/prepare-projects.js && npm run dev');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const root = mkdtempSync(join(tmpdir(), 'magnusim-seed-'));
  try {
    // Seeded twice (a project already there is replaced): one copy, its own id and title.
    await runSuiteSeed(seedPath, root);
    await runSuiteSeed(seedPath, root);
    const { H10_PROJECT, RUN_SETTINGS_PROJECT } = await import('../../bundled-plugins/incompressible_flow/e2e/seed.js');
    for (const id of [H10_PROJECT, RUN_SETTINGS_PROJECT]) {
      const doc = JSON.parse(readFileSync(join(root, id, 'project.json'), 'utf8'));
      assert.equal(doc.id, id);
      assert.equal(readdirSync(join(root, id, 'geometries')).length, 1, id);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
