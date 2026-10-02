// H14: the plugin UI kit reaches frames as /plugin-sdk/plugin-ui.{js,css,d.ts}
// (an import-map name and a stylesheet in every workspace page) and in-page
// TSX UIs through a shim on the page's own kit. The UI kit dev sheet's frame
// files exist only on a dev server started with VITE_MAGNUSIM_DEV_SHEETS=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobManager } from '../jobs.ts';
import { bundlePluginUi } from '../plugin-ui-bundle.ts';
import { buildUiKitSheetJs, devSdkStamp, pluginSdkFile, SDK_FILES, SDK_IMPORTS } from '../plugin-sdk.ts';
import { dispatch, Router } from '../router.ts';
import { registerPhase3Routes } from '../routes.ts';
import { kitExportNames, newestStamp } from '../sdk-build.ts';
import { frameCsp, injectWorkspaceHead, workspaceCsp } from '../workspace-files.ts';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function listen(handler) {
  return new Promise((done) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

/** A server with the real routes on this checkout, as the dev server or preview serves them. */
async function serve(sdkVariant) {
  const cache = mkdtempSync(join(tmpdir(), 'magnusim-h14-sdk-'));
  const router = new Router();
  registerPhase3Routes(router, {
    worker: { async call() { return {}; } },
    jobs: new JobManager({ cacheDir: join(cache, 'jobs') }),
    webRoot: WEB,
    cacheDir: cache,
    sdkVariant,
    serveLegacyFilter: async () => {},
    startMeshJob() {},
    startSolveJob() {},
    startCadImportJob() {},
    caseSnapshot: () => ({}),
    attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
    resetCaseIdle() {},
  });
  const server = await listen((req, res) => dispatch(router, req, res));
  const host = `127.0.0.1:${server.address().port}`;
  return {
    host,
    get: (path) => fetch(`http://${host}${path}`),
    close: () => {
      server.close();
      rmSync(cache, { recursive: true, force: true });
    },
  };
}

/** Run fn with VITE_MAGNUSIM_DEV_SHEETS set to `value` (null: unset), then put it back. */
function withSheetsFlag(value, fn) {
  const had = Object.hasOwn(process.env, 'VITE_MAGNUSIM_DEV_SHEETS');
  const saved = process.env.VITE_MAGNUSIM_DEV_SHEETS;
  if (value === null) delete process.env.VITE_MAGNUSIM_DEV_SHEETS;
  else process.env.VITE_MAGNUSIM_DEV_SHEETS = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (had) process.env.VITE_MAGNUSIM_DEV_SHEETS = saved;
      else delete process.env.VITE_MAGNUSIM_DEV_SHEETS;
    });
}

test('plugin-ui.js, .css and .d.ts are served in both variants', async () => {
  for (const variant of ['dev', 'prod']) {
    const s = await serve(variant);
    try {
      const js = await s.get('/plugin-sdk/plugin-ui.js');
      assert.equal(js.status, 200, variant);
      assert.match(js.headers.get('content-type'), /^text\/javascript/);
      assert.equal(js.headers.get('access-control-allow-origin'), '*');
      const code = await js.text();
      assert.match(code, /PLUGIN_UI_API_VERSION|1\.0\.0/);
      // React stays outside: a frame's import map gives it.
      assert.match(code, /from\s*["']react\/jsx-runtime["']/);
      assert.doesNotMatch(code, /__SECRET_INTERNALS|react\.production|react\.development/);
      const css = await s.get('/plugin-sdk/plugin-ui.css');
      assert.equal(css.status, 200, variant);
      assert.match(css.headers.get('content-type'), /^text\/css/);
      assert.match(await css.text(), /\.mgk-btn/);
      const dts = await s.get('/plugin-sdk/plugin-ui.d.ts');
      assert.equal(dts.status, 200, variant);
      assert.match(await dts.text(), /declare module '@magnusim\/plugin-ui'/);
    } finally {
      s.close();
    }
  }
});

test('the import map names the kit, and every import-map path is an SDK file', () => {
  assert.equal(SDK_IMPORTS['@magnusim/plugin-ui'], '/plugin-sdk/plugin-ui.js');
  for (const path of Object.values(SDK_IMPORTS)) assert.ok(SDK_FILES.includes(path.replace('/plugin-sdk/', '')), path);
});

test('a workspace page links plugin-ui.css right after theme.css', () => {
  const html = injectWorkspaceHead('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  const theme = html.indexOf('<link rel="stylesheet" href="/plugin-sdk/theme.css">');
  const kit = html.indexOf('<link rel="stylesheet" href="/plugin-sdk/plugin-ui.css">');
  assert.ok(theme > 0 && kit === theme + '<link rel="stylesheet" href="/plugin-sdk/theme.css">'.length, html);
  assert.ok(kit < html.indexOf('<meta charset'));
});

test('the frame CSP: a workspace is frameCsp with its own folder, pinned directive by directive', () => {
  for (const [h, k] of [
    ['127.0.0.1:5173', 'ws-demo'],
    ['localhost:8083', 'cad'],
  ]) {
    assert.equal(workspaceCsp(h, k), frameCsp(h, `/plugins/${k}/workspace/`));
  }
  // The hash is the import map's, which names the kit (A1 changed it on purpose).
  assert.equal(SDK_IMPORTS['@magnusim/plugin-ui'], '/plugin-sdk/plugin-ui.js');
  const hash = createHash('sha256').update(JSON.stringify({ imports: SDK_IMPORTS })).digest('base64');
  const sdk = 'http://127.0.0.1:5173/plugin-sdk/';
  const pinned = (own) =>
    [
      "default-src 'none'",
      `script-src ${sdk} ${own} blob: 'wasm-unsafe-eval' 'sha256-${hash}'`,
      'worker-src blob:',
      `style-src ${sdk} ${own} 'unsafe-inline'`,
      `img-src ${own} data: blob:`,
      `font-src ${sdk} ${own}`,
      `media-src ${own} blob:`,
      `connect-src ${own}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; ');
  assert.equal(workspaceCsp('127.0.0.1:5173', 'ws-demo'), pinned('http://127.0.0.1:5173/plugins/ws-demo/workspace/'));
  assert.equal(frameCsp('127.0.0.1:5173', '/plugin-sdk/'), pinned(sdk));
});

test('the dev sheet frame files: 404 without the flag and in prod, served with it in dev', async () => {
  const dev = await serve('dev');
  const prod = await serve('prod');
  try {
    await withSheetsFlag(null, async () => {
      assert.equal((await dev.get('/plugin-sdk/ui-kit-sheet.html')).status, 404);
      assert.equal((await dev.get('/plugin-sdk/ui-kit-sheet.js')).status, 404);
    });
    await withSheetsFlag('0', async () => {
      assert.equal((await dev.get('/plugin-sdk/ui-kit-sheet.html')).status, 404);
    });
    await withSheetsFlag('1', async () => {
      assert.equal((await prod.get('/plugin-sdk/ui-kit-sheet.html')).status, 404);
      assert.equal((await prod.get('/plugin-sdk/ui-kit-sheet.js')).status, 404);
      const page = await dev.get('/plugin-sdk/ui-kit-sheet.html');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /^text\/html/);
      assert.equal(page.headers.get('content-security-policy'), frameCsp(dev.host, '/plugin-sdk/'));
      const html = await page.text();
      // Standards mode, like the page: the doctype stays first.
      assert.match(html, /^<!doctype html>/i);
      assert.match(html, /<meta charset="utf-8">/);
      assert.match(html, /<head><script type="importmap">.*<\/script><link rel="stylesheet" href="\/plugin-sdk\/theme.css"><link rel="stylesheet" href="\/plugin-sdk\/plugin-ui.css">/);
      assert.match(html, /<script type="module" src="\/plugin-sdk\/ui-kit-sheet.js"><\/script>/);
      const js = await dev.get('/plugin-sdk/ui-kit-sheet.js');
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type'), /^text\/javascript/);
      assert.match(await js.text(), /from\s*["']@magnusim\/plugin-ui["']/);
    });
  } finally {
    dev.close();
    prod.close();
  }
});

test('ui-kit-sheet.js runs the shipped kit: no kit source and no core module in it', async () => {
  const { text, metafile } = await buildUiKitSheetJs(WEB);
  const inputs = Object.keys(metafile.inputs);
  assert.ok(inputs.includes('src/dev/ui-kit/frame.tsx'), inputs.join(', '));
  assert.deepEqual(inputs.filter((p) => p.startsWith('src/plugin-ui/')), []);
  assert.deepEqual(inputs.filter((p) => p.startsWith('src/') && !p.startsWith('src/dev/ui-kit/')), []);
  assert.deepEqual(inputs.filter((p) => p.includes('node_modules')), []);
  // Every import is left to the frame's import map.
  const externals = Object.values(metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path));
  for (const name of externals) assert.ok(Object.hasOwn(SDK_IMPORTS, name), name);
  assert.ok(externals.includes('@magnusim/plugin-ui'));
  assert.doesNotMatch(text, /src\/dev\/ui-kit\/sections\/\w+\.core/);
});

test('tokens.css declares only --mg-* custom properties, inside :root', () => {
  const css = readFileSync(join(WEB, 'src', 'theme', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0][1].trim(), ':root');
  const props = blocks[0][2]
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.slice(0, d.indexOf(':')).trim());
  assert.ok(props.length > 80);
  assert.deepEqual(props.filter((p) => !p.startsWith('--mg-')), []);
  assert.equal(css.replace(blocks[0][0], '').trim(), '');
});

test("prod react-all.js keeps React's licence notice", async () => {
  assert.match(await pluginSdkFile(WEB, 'prod', 'react-all.js'), /@license React/);
});

test('newestStamp changes when a file in a folder changes; a missing folder counts as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'magnusim-h14-stamp-'));
  try {
    const missing = join(dir, 'nope');
    assert.equal(newestStamp(missing), newestStamp(join(dir, 'also-nope')));
    writeFileSync(join(dir, 'a.txt'), 'one');
    const one = newestStamp(dir, missing);
    assert.equal(newestStamp(dir, missing), one);
    writeFileSync(join(dir, 'a.txt'), 'one more');
    const two = newestStamp(dir, missing);
    assert.notEqual(two, one);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'b');
    assert.notEqual(newestStamp(dir, missing), two);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dev SDK stamp changes with a file in the kit, the theme, the frame SDK, the dev sheet or the plugin docs', () => {
  mkdirSync(join(WEB, '.cache'), { recursive: true });
  const root = mkdtempSync(join(WEB, '.cache', 'h14-stamp-'));
  try {
    let last = devSdkStamp(root);
    assert.equal(devSdkStamp(root), last, 'the same files give the same stamp');
    for (const dir of ['src/plugin-ui', 'src/theme', 'src/plugin-sdk', 'src/dev/ui-kit', 'docs/plugins']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'probe.txt'), 'one');
      const added = devSdkStamp(root);
      assert.notEqual(added, last, `a new file in ${dir}`);
      writeFileSync(join(root, dir, 'probe.txt'), 'one, changed');
      last = devSdkStamp(root);
      assert.notEqual(last, added, `a changed file in ${dir}`);
    }
    // Elsewhere in the web root does not count.
    mkdirSync(join(root, 'src', 'panels'), { recursive: true });
    writeFileSync(join(root, 'src', 'panels', 'other.ts'), 'export {};\n');
    assert.equal(devSdkStamp(root), last);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the kit's export names are built again when a kit file gains an export", async () => {
  mkdirSync(join(WEB, '.cache'), { recursive: true });
  const root = mkdtempSync(join(WEB, '.cache', 'h14-names-'));
  try {
    mkdirSync(join(root, 'src', 'plugin-ui'), { recursive: true });
    writeFileSync(join(root, 'src', 'plugin-ui', 'index.ts'), "export * from './more';\nexport const Alpha = 1;\n");
    writeFileSync(join(root, 'src', 'plugin-ui', 'more.ts'), 'export const Beta = 2;\n');
    assert.deepEqual(await kitExportNames(root), ['Alpha', 'Beta']);
    // Unchanged: the same names.
    assert.deepEqual(await kitExportNames(root), ['Alpha', 'Beta']);
    // A file the index reaches gains an export.
    writeFileSync(join(root, 'src', 'plugin-ui', 'more.ts'), 'export const Beta = 2;\nexport const Gamma = 3;\n');
    assert.deepEqual(await kitExportNames(root), ['Alpha', 'Beta', 'Gamma']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dev SDK rebuilds when its stamp changes, and a kit error fails plugin-ui.* only', async () => {
  // A web root of its own under .cache/ (ignored), so `react` resolves to this app's.
  mkdirSync(join(WEB, '.cache'), { recursive: true });
  const root = mkdtempSync(join(WEB, '.cache', 'h14-sdk-'));
  try {
    mkdirSync(join(root, 'src', 'plugin-ui'), { recursive: true });
    for (const rel of ['src/plugin-sdk/workspace.ts', 'src/plugin-sdk/base.css', 'src/theme/tokens.css']) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      cpSync(join(WEB, rel), join(root, rel));
    }
    writeFileSync(join(root, 'src', 'plugin-ui', 'kit.css'), '.mgk-probe { margin: 0; }\n');
    writeFileSync(join(root, 'src', 'plugin-ui', 'index.ts'), 'export const PROBE = "first build";\n');
    const one = await pluginSdkFile(root, 'dev', 'plugin-ui.js', () => 's1');
    assert.match(one, /first build/);
    writeFileSync(join(root, 'src', 'plugin-ui', 'index.ts'), 'export const PROBE = "second build";\n');
    // Same stamp: the cached build.
    assert.match(await pluginSdkFile(root, 'dev', 'plugin-ui.js', () => 's1'), /first build/);
    // New stamp: rebuilt.
    assert.match(await pluginSdkFile(root, 'dev', 'plugin-ui.js', () => 's2'), /second build/);
    // Prod builds once.
    assert.match(await pluginSdkFile(root, 'prod', 'plugin-ui.js'), /second build/);
    writeFileSync(join(root, 'src', 'plugin-ui', 'index.ts'), 'export const PROBE = "third build";\n');
    assert.match(await pluginSdkFile(root, 'prod', 'plugin-ui.js'), /second build/);
    // A broken kit: plugin-ui.* fail, React and the bridge still load.
    writeFileSync(join(root, 'src', 'plugin-ui', 'index.ts'), 'export const PROBE = ;\n');
    await assert.rejects(pluginSdkFile(root, 'dev', 'plugin-ui.js', () => 's3'));
    assert.match(await pluginSdkFile(root, 'dev', 'react.js', () => 's3'), /useState/);
    assert.match(await pluginSdkFile(root, 'dev', 'workspace.js', () => 's3'), /hello/);
    // Fixed: the failed build was not kept.
    writeFileSync(join(root, 'src', 'plugin-ui', 'index.ts'), 'export const PROBE = "fixed";\n');
    assert.match(await pluginSdkFile(root, 'dev', 'plugin-ui.js', () => 's3'), /fixed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The names a bundled module exports (its final `export { … }`). */
function exportedNames(code) {
  const m = code.match(/export\s*\{([^}]*)\}\s*;?\s*(\/\/# sourceMappingURL=.*)?\s*$/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+as\s+/).pop())
    .sort();
}

function uiFolder() {
  const root = mkdtempSync(join(tmpdir(), 'magnusim-h14-ui-'));
  const ui = join(root, 'ui');
  mkdirSync(ui, { recursive: true });
  return { root, ui, write: (name, text) => (writeFileSync(join(ui, name), text), join(ui, name)) };
}

test('the in-page react shim exports every React name (useTransition bundles)', async () => {
  const f = uiFolder();
  try {
    const entry = f.write(
      'index.tsx',
      "import { useTransition, useDeferredValue, useOptimistic } from 'react';\nexport function W() { const [, start] = useTransition(); void start; useDeferredValue(1); useOptimistic(1); return <i />; }\n",
    );
    const code = await bundlePluginUi(entry, f.ui, { kitNames: async () => assert.fail('a UI without the kit never asks for its names') });
    assert.match(code, /__MAGNUSIM_HOST_REACT__/);
    assert.match(code, /useTransition/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a TSX UI imports the kit through a shim on the page kit, with exactly the kit names', async () => {
  const f = uiFolder();
  try {
    const entry = f.write('index.tsx', "export * from '@magnusim/plugin-ui';\nimport { Button } from '@magnusim/plugin-ui';\nexport const B = Button;\n");
    const names = ['Button', 'PLUGIN_UI_API_VERSION', 'formatSimTime'];
    const code = await bundlePluginUi(entry, f.ui, { kitNames: async () => names });
    assert.match(code, /__MAGNUSIM_HOST_KIT__/);
    assert.doesNotMatch(code, /^import\s/m);
    assert.deepEqual(
      exportedNames(code).filter((n) => n !== 'B'),
      [...names].sort(),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a UI without the kit import never waits for the kit, even when the kit is broken', async () => {
  const f = uiFolder();
  let calls = 0;
  const broken = async () => {
    calls += 1;
    throw new Error('kit build failed');
  };
  try {
    const plain = f.write('plain.tsx', "import { useState } from 'react';\nexport function P() { useState(0); return <b>plain</b>; }\n");
    const first = await bundlePluginUi(plain, f.ui, { kitNames: broken });
    assert.match(first, /plain/);
    // Cached, still without asking.
    assert.equal(await bundlePluginUi(plain, f.ui, { kitNames: broken }), first);
    assert.equal(calls, 0);
    // A UI that imports the kit fails with the kit.
    const kitUi = f.write('kit.tsx', "import { Button } from '@magnusim/plugin-ui';\nexport const B = Button;\n");
    await assert.rejects(bundlePluginUi(kitUi, f.ui, { kitNames: broken }), /kit build failed/);
    assert.ok(calls > 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a cached UI that imports the kit rebuilds when the kit gains an export', async () => {
  const f = uiFolder();
  try {
    const entry = f.write('index.tsx', "export * from '@magnusim/plugin-ui';\n");
    let names = ['Button'];
    let calls = 0;
    const kitNames = async () => {
      calls += 1;
      return names;
    };
    assert.deepEqual(exportedNames(await bundlePluginUi(entry, f.ui, { kitNames })), ['Button']);
    assert.deepEqual(exportedNames(await bundlePluginUi(entry, f.ui, { kitNames })), ['Button']);
    names = ['Button', 'Toast'];
    assert.deepEqual(exportedNames(await bundlePluginUi(entry, f.ui, { kitNames })), ['Button', 'Toast']);
    assert.ok(calls >= 3);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("by default a UI that imports the kit gets the kit's own export names", async () => {
  const f = uiFolder();
  try {
    const entry = f.write('index.tsx', "export * from '@magnusim/plugin-ui';\n");
    const names = await kitExportNames(WEB);
    assert.ok(names.includes('Button') && names.includes('PLUGIN_UI_API_VERSION'), names.join(', '));
    assert.ok(!names.includes('default'));
    assert.deepEqual(exportedNames(await bundlePluginUi(entry, f.ui)), names);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('plugin-sdk.ts and plugin-ui-bundle.ts share sdk-build.ts and do not import each other', () => {
  const read = (name) => readFileSync(join(WEB, 'scripts', 'server', name), 'utf8');
  const sdk = read('plugin-sdk.ts');
  const ui = read('plugin-ui-bundle.ts');
  const shared = read('sdk-build.ts');
  const imports = (text) => [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports(sdk).includes('./sdk-build.ts'));
  assert.ok(imports(ui).includes('./sdk-build.ts'));
  assert.ok(!imports(sdk).some((p) => p.includes('plugin-ui-bundle')));
  assert.ok(!imports(ui).some((p) => p.includes('plugin-sdk')));
  assert.deepEqual(imports(shared).filter((p) => p !== 'esbuild' && !p.startsWith('node:')), []);
});
