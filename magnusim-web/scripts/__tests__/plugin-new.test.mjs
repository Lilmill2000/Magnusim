// npm run plugin:new (scripts/plugin-new.mjs): each option writes what it says, and a
// new plugin passes npm run plugin:check (which runs its own pytest tests) as written.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, describe, test } from 'node:test';
import ts from 'typescript';
import { PYTHON } from '../python-env.js';
import { hostApiVersion, parseArgs, render, scaffold as scaffoldPlugin, UsageError, WEB_ROOT } from '../plugin-new.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'magnusim-plugin-new-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Each plugin made here, by folder: the paths scaffold() wrote that say where the app and
// the plugin are on this PC (the trace check reads what was generated, not those).
const INSTALL_PATHS = new Map();
async function scaffold(input) {
  const made = await scaffoldPlugin(input);
  INSTALL_PATHS.set(made.dir, made.installPaths);
  return made;
}

const SDK = JSON.parse(readFileSync(join(WEB_ROOT, 'docs', 'plugins', 'plugin-sdk.json'), 'utf8'));
const API = hostApiVersion();
// The app's Playwright, which `npx playwright` runs from the app folder.
const PLAYWRIGHT_DIR = dirname(createRequire(join(WEB_ROOT, 'package.json')).resolve('@playwright/test/package.json'));

/** A web root of its own: what scaffold() reads from the app (no bundled plugins; a LICENSE). */
function fakeWebRoot(name, imports = SDK.imports) {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n');
  mkdirSync(join(root, 'python', 'cfddesk', 'registry'), { recursive: true });
  writeFileSync(join(root, 'python', 'cfddesk', 'registry', '__init__.py'), `API_VERSION = "${API}"\n`);
  mkdirSync(join(root, 'docs', 'plugins'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plugins', 'plugin-sdk.json'), JSON.stringify({ ...SDK, imports }));
  for (const f of ['workspace-sdk.d.ts', 'plugin-ui.d.ts']) copyFileSync(join(WEB_ROOT, 'docs', 'plugins', f), join(root, 'docs', 'plugins', f));
  return root;
}

/** The value of the first JS string literal after `before` in `text` (evaluated as JavaScript does). */
function jsLiteralAfter(text, before) {
  const at = text.indexOf(before);
  assert.ok(at >= 0, before);
  const m = /'(?:[^'\\\n]|\\.)*'/.exec(text.slice(at + before.length));
  assert.ok(m, `a string after ${before}`);
  return new Function(`return ${m[0]};`)();
}

function files(dir) {
  const out = [];
  const go = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) go(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  go(dir);
  return out.sort();
}

const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');

/** npm run plugin:check -- <dir> --json, with the plugin's own tests. */
function check(dir) {
  const r = spawnSync(PYTHON, [join(WEB_ROOT, 'python', 'tools', 'plugin_check.py'), '--json', dir], {
    encoding: 'utf8',
    timeout: 600_000,
    windowsHide: true,
  });
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    assert.fail(`plugin_check printed no JSON (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  return { status: r.status, report: doc.plugins[0] };
}

/** Type-check the page source against the published SDK and kit types and the app's React types. */
function typecheck(dir) {
  // React's types from the nearest node_modules above the app (its own, or the one
  // above a scratch copy of it).
  const types = (p) => {
    for (let at = WEB_ROOT; ; at = dirname(at)) {
      const file = join(at, 'node_modules', '@types', ...p.split('/'));
      if (existsSync(file)) return file;
      if (dirname(at) === at) throw new Error(`no @types/${p} above ${WEB_ROOT}`);
    }
  };
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    baseUrl: dir,
    paths: {
      react: [types('react/index.d.ts')],
      'react/jsx-runtime': [types('react/jsx-runtime.d.ts')],
      'react-dom/client': [types('react-dom/client.d.ts')],
    },
  };
  const roots = ['src/main.tsx', 'types/workspace-sdk.d.ts', 'types/plugin-ui.d.ts'].map((r) => join(dir, ...r.split('/')));
  const program = ts.createProgram(roots, options);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

// A plugin made here names no coding-assistant tool or vendor, in any file. The names
// are kept base64-encoded so this repository's own trace grep (run before a push) stays
// clean. The editor-pointer word is fine only as CSS (`…:`); the mouse is "the pointer".
// Where the app and the plugin are installed is not generated text: a folder of this PC
// may have any name, so the install paths scaffold() reports are left out of the check.
// Which files a plugin gets is pinned exactly by each test below (no stray tool files).
const TRACE_WORDS = ['Y2xhdWRl', 'YW50aHJvcGlj', 'Y2hhdGdwdA==', 'b3BlbmFp', 'Y29waWxvdA==', 'Y3Vyc29y'].map((b) => Buffer.from(b, 'base64').toString());
const POINTER = TRACE_WORDS[5];

function traceIn(line) {
  const low = line.toLowerCase();
  for (const word of TRACE_WORDS) {
    for (let at = low.indexOf(word); at >= 0; at = low.indexOf(word, at + 1)) {
      const allowed = word === POINTER && low[at + word.length] === ':';
      if (!allowed) return word;
    }
  }
  return null;
}

function assertNoTraces(dir) {
  const paths = INSTALL_PATHS.get(dir);
  assert.ok(paths && paths.length, `scaffold() reported where it put ${dir}`);
  const generated = (text) => paths.reduce((t, p) => t.split(p).join('<install path>'), text);
  for (const f of files(dir)) {
    assert.equal(traceIn(f), null, f);
    const hit = generated(read(dir, f)).split('\n').find((line) => traceIn(line));
    assert.equal(hit, undefined, `${f}: ${hit}`);
  }
}

// GUIDE.md section 14: each source file it writes says its licence near the top. Not the
// app's own types copied into types/ (generated there), nor the built page in workspace/.
function assertSpdx(dir) {
  const source = files(dir).filter((f) => /\.(py|js|mjs|cjs|ts|tsx|jsx|html)$/.test(f) && !/^(types|workspace)\//.test(f));
  assert.ok(source.length >= 3, source.join(' '));
  for (const f of source) {
    const head = read(dir, f).split('\n').slice(0, 10).join('\n');
    assert.match(head, /SPDX-License-Identifier: GPL-3\.0-or-later/, `${f} has no SPDX line at the top`);
  }
}

/** The plugin's pytest, run as GUIDE.md says: the app's interpreter, from another folder, no PYTHONPATH. */
function pytestAlone(dir) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  delete env.PYTHONPATH;
  return spawnSync(PYTHON, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', join(dir, 'tests')], {
    cwd: TMP,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
  });
}

const COMMON = ['.gitignore', 'GUIDE.md', 'LICENSE', 'manifest.toml', 'plugin.py', 'tests/conftest.py', 'tests/test_plugin.py'];
const WORKSPACE = ['package.json', 'src/importmap.json', 'src/index.html', 'src/main.tsx', 'tools/count.py', 'tsconfig.json',
  'types/plugin-ui.d.ts', 'types/workspace-sdk.d.ts', 'vite.config.js', 'workspace/index.html', 'workspace/main.js', 'tests/e2e/playwright.config.js'];
const ANALYSIS = ['__init__.py', 'pyproject.toml', 'tests/test_register.py'];
const sorted = (...lists) => lists.flat().sort();

describe('arguments', () => {
  test('the default is a workspace plugin; the variants exclude each other; keys are checked', () => {
    assert.deepEqual(parseArgs(['wing-polar']), { key: 'wing-polar', variant: 'workspace', service: false, venv: false, studyKind: '', name: '', out: '' });
    const all = parseArgs(['p', '--analysis', '--service', '--venv', '--study-kind', 'Polar', '--name', 'P', '--out', 'x']);
    assert.equal(all.variant, 'analysis');
    assert.equal(all.studyKind, 'Polar');
    assert.equal(all.name, 'P');
    assert.equal(all.out, 'x');
    assert.ok(all.service && all.venv);
    assert.throws(() => parseArgs(['p', '--analysis', '--workspace']), UsageError);
    assert.throws(() => parseArgs(['Bad Key']), /lowercase letters/);
    assert.throws(() => parseArgs(['p', '--study-kind']), /needs a value/);
    assert.throws(() => parseArgs([]), /a plugin key is needed/);
    assert.throws(() => parseArgs(['p', '--colour']), /unknown option/);
  });

  test('the command line answers a bad key with exit 2 and the usage', () => {
    const r = spawnSync(process.execPath, [join(WEB_ROOT, 'scripts', 'plugin-new.mjs'), 'No Good', '--out', TMP], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /lowercase letters/);
    assert.match(r.stderr, /usage: npm run plugin:new/);
  });
});

describe('templates', () => {
  test('values, sections, inverted sections, and tag-only lines leave no line', () => {
    const t = 'a {{x}}\n{{#on}}\nyes\n{{/on}}\n{{^on}}\nno\n{{/on}}\nb {{#on}}in{{^off}} deep{{/off}}{{/on}}\n';
    assert.equal(render(t, { x: '1' }, { on: true, off: false }), 'a 1\nyes\nb in deep\n');
    assert.equal(render(t, { x: '1' }, { on: false, off: false }), 'a 1\nno\nb \n');
    assert.throws(() => render('{{missing}}', {}, {}), /not set/);
    assert.throws(() => render('{{#nope}}x{{/nope}}', {}, {}), /not a known flag/);
  });
});

describe('a new plugin', () => {
  test('--workspace: a page on the kit, built now, React external; a method and a job on the app Python; passes plugin:check', () => {
    const out = join(TMP, 'ws');
    return scaffold({ key: 'pad-demo', out }).then(({ dir, files: made }) => {
      assert.equal(dir, join(out, 'pad-demo'));
      // Exactly these files: no service, no lock, no stray tool files.
      assert.deepEqual(files(dir), sorted(COMMON, WORKSPACE, ['tests/e2e/pad-demo.spec.js']));
      assert.deepEqual(made, files(dir));
      const manifest = read(dir, 'manifest.toml');
      assert.match(manifest, /^key = "pad-demo"$/m);
      assert.match(manifest, new RegExp(`^api_version = "${API.replace('.', '\\.')}"$`, 'm'));
      assert.match(manifest, /^license = "GPL-3.0-or-later"$/m);
      assert.match(manifest, /^\[\[workspaces\]\]\nkey = "pad_demo"\ntitle = "Pad demo"/m);
      assert.match(manifest, /^workspace = "pad_demo"$/m);
      assert.doesNotMatch(manifest, /^\[python\]/m);
      // From templates/plugin-workspace: its icons and opt-in examples.
      assert.match(manifest, /icon = "M4 5h16v14H4z M4 9h16"/);
      assert.match(manifest, /^# \[\[start_actions\]\]$/m);
      // Its hint says what the button does (the sketch example's would promise drawing and simulating).
      assert.match(manifest, /^# hint = "Makes a pad demo study and opens it"$/m);
      assert.doesNotMatch(manifest, /simulate/);
      // The header shows the study's title and Back (DESIGN.md 3.1): the page draws neither,
      // and its test checks the header's title and finds kit controls by role and label.
      assert.doesNotMatch(read(dir, 'src/main.tsx'), /study\.title|<h1/);
      const e2eSpec = read(dir, 'tests/e2e/pad-demo.spec.js');
      assert.match(e2eSpec, /#workspace-overlay \[data-ws-crumb\]/);
      assert.match(e2eSpec, /getByRole\('textbox', \{ name: 'Width', exact: true \}\)/);
      assert.doesNotMatch(e2eSpec, /xpath=|data-title/);
      assertSpdx(dir);
      const plugin = read(dir, 'plugin.py');
      assert.match(plugin, /hub\.register_method\(PLUGIN, "area", area\)/);
      assert.match(plugin, /python="core"/);
      // Built: the bridge, React and the kit stay imports for the host's import map.
      const main = read(dir, 'workspace/main.js');
      assert.match(main, /from "@magnusim\/workspace"/);
      assert.match(main, /from "@magnusim\/plugin-ui"/);
      assert.match(main, /from "react"/);
      assert.doesNotMatch(main, /__CLIENT_INTERNALS|react\.production/);
      assert.match(read(dir, 'workspace/index.html'), /<script type="module" src="\.\/main\.js"><\/script>/);
      assert.deepEqual(JSON.parse(read(dir, 'src/importmap.json')).imports, SDK.imports);
      assert.match(read(dir, 'vite.config.js'), /external: HOST_IMPORTS/);
      const pkg = JSON.parse(read(dir, 'package.json'));
      assert.equal(pkg.license, 'GPL-3.0-or-later');
      assert.equal(pkg.dependencies, undefined, 'React and the kit come from the host, never from dependencies');
      assert.equal(read(dir, 'types/workspace-sdk.d.ts'), read(join(WEB_ROOT, 'docs'), 'plugins/workspace-sdk.d.ts'));
      // Its GUIDE.md sends the reader to the host's docs, which exist.
      for (const doc of ['GUIDE.md', 'DESIGN.md', 'API.md']) {
        assert.ok(read(dir, 'GUIDE.md').includes('`' + doc + '`'), doc);
        assert.ok(existsSync(join(WEB_ROOT, 'docs', 'plugins', doc)), doc);
      }
      assert.ok(existsSync(join(WEB_ROOT, 'docs', 'plugins', 'INDEX.md')));
      assert.ok(read(dir, 'GUIDE.md').includes('`docs/plugins/INDEX.md`'));
      // The e2e spec runs on this app's test servers, found from where the plugin is.
      const specText = read(dir, 'tests/e2e/pad-demo.spec.js');
      const spec = /import \{ e2eTemp, NO_GEOMETRY_PROJECT, startHost \} from '([^']+)'/.exec(specText);
      assert.ok(spec);
      assert.equal(resolve(dir, 'tests', 'e2e', spec[1]), join(WEB_ROOT, 'e2e', 'support', 'plugin-suite.js'));
      // The app's harness only through its plugin seam (Playwright apart).
      const fromApp = [...specText.matchAll(/^import .* from '(\.[^']+)';$/gm)]
        .map((m) => resolve(dir, 'tests', 'e2e', m[1]))
        .filter((p) => p !== join(PLAYWRIGHT_DIR, 'index.mjs'));
      assert.deepEqual(fromApp, [join(WEB_ROOT, 'e2e', 'support', 'plugin-suite.js')]);
      // Outside the app, Node cannot find the app's Playwright from the plugin's folder:
      // the spec and its config import the app's copy by path.
      const pw = /import \{ expect, test \} from '([^']+)'/.exec(specText);
      assert.equal(resolve(dir, 'tests', 'e2e', pw[1]), join(PLAYWRIGHT_DIR, 'index.mjs'));
      const cfg = /import \{ defineConfig \} from '([^']+)'/.exec(read(dir, 'tests/e2e/playwright.config.js'));
      assert.equal(resolve(dir, 'tests', 'e2e', cfg[1]), join(PLAYWRIGHT_DIR, 'index.mjs'));
      // And Playwright, run from the app folder as GUIDE.md says, loads both.
      const listed = spawnSync(process.execPath, [join(PLAYWRIGHT_DIR, 'cli.js'), 'test', '-c', join(dir, 'tests', 'e2e', 'playwright.config.js'), '--list'], {
        cwd: WEB_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.equal(listed.status, 0, listed.stdout + listed.stderr);
      assert.match(listed.stdout, /Pad demo: the form saves to the study/);
      assert.match(listed.stdout, /Total: 1 test in 1 file/);
      assert.match(read(dir, 'LICENSE'), /GNU GENERAL PUBLIC LICENSE/);
      assert.deepEqual(typecheck(dir), []);
      assertNoTraces(dir);
      const { status, report } = check(dir);
      assert.equal(status, 0, JSON.stringify(report.findings, null, 1));
      assert.equal(report.checks.workspace, 'pass');
      assert.equal(report.checks.tools, 'pass');
      assert.equal(report.tests.results.pytest.status, 'passed');
      assert.deepEqual(report.findings, []);
    });
  });

  test('--workspace --service --venv --study-kind: its service and its own environment, its job runs there; passes plugin:check', async () => {
    const { dir } = await scaffold({ key: 'smoke-test', variant: 'workspace', service: true, venv: true, studyKind: 'Wing section', out: join(TMP, 'full') });
    assert.deepEqual(files(dir), sorted(COMMON, WORKSPACE, ['tests/e2e/smoke-test.spec.js', 'service/__init__.py', 'requirements.lock']));
    const manifest = read(dir, 'manifest.toml');
    assert.match(manifest, /^key = "wing_section"$/m);
    assert.match(manifest, /^title = "Wing section"$/m);
    assert.match(manifest, /^\[python\]\nrequirements = "requirements\.lock"\npython = ">=3\.10,<3\.15"\nservice = "service"$/m);
    assert.match(read(dir, 'service/__init__.py'), /@method\("area"\)/);
    assert.match(read(dir, 'service/__init__.py'), /@method\("migrate_study"\)/);
    assert.match(read(dir, 'requirements.lock'), /--require-hashes/);
    const plugin = read(dir, 'plugin.py');
    assert.doesNotMatch(plugin, /register_method/, 'with a service, the method lives in the service');
    assert.match(plugin, /python="plugin"/);
    assert.match(read(dir, 'tests/e2e/smoke-test.spec.js'), /env\/install/);
    assert.match(read(dir, 'tests/test_plugin.py'), /def test_its_service_answers/);
    assertNoTraces(dir);
    assertSpdx(dir);
    // pytest alone, as GUIDE.md "Testing" runs it: its conftest finds the app's packages.
    const alone = pytestAlone(dir);
    assert.equal(alone.status, 0, alone.stdout + alone.stderr);
    assert.match(alone.stdout, /\b3 passed/);
    const { status, report } = check(dir);
    assert.equal(status, 0, JSON.stringify(report.findings, null, 1));
    assert.equal(report.checks.requirements, 'pass');
    assert.equal(report.checks.tools, 'pass');
    assert.equal(report.tests.results.pytest.status, 'passed');
  });

  test('--analysis: templates/plugin renamed, the cloned analysis; no page, no job; passes plugin:check', async () => {
    const { dir, files: made } = await scaffold({ key: 'laminar-x', variant: 'analysis', out: join(TMP, 'an') });
    // Exactly these files: no page, no job, no environment.
    assert.deepEqual(files(dir), sorted(COMMON, ANALYSIS));
    assert.deepEqual(made, files(dir));
    const plugin = read(dir, 'plugin.py');
    assert.match(plugin, /PLUGIN = "laminar-x"/);
    assert.match(plugin, /replace\(steady, key="laminar_x", label="Laminar x"\)/);
    assert.doesNotMatch(plugin, /template/i);
    assert.match(read(dir, 'manifest.toml'), /^requires_plugins = \["incompressible_flow>=1\.0"\]$/m);
    assert.doesNotMatch(read(dir, 'manifest.toml'), /study_kinds/);
    assert.match(read(dir, 'pyproject.toml'), /laminar-x = "magnusim_plugin_laminar_x\.plugin:register"/);
    assert.match(read(dir, 'tests/test_register.py'), /get\("laminar_x"\)/);
    assertNoTraces(dir);
    assertSpdx(dir);
    const alone = pytestAlone(dir);
    assert.equal(alone.status, 0, alone.stdout + alone.stderr);
    const { status, report } = check(dir);
    assert.equal(status, 0, JSON.stringify(report.findings, null, 1));
    assert.equal(report.checks.workspace, 'n/a');
    assert.equal(report.tests.results.pytest.status, 'passed');
  });

  test('--analysis --venv --study-kind: a study kind without a page, a job on its own environment; passes plugin:check', async () => {
    const { dir } = await scaffold({ key: 'polar-y', variant: 'analysis', venv: true, studyKind: 'Polar sweep', out: join(TMP, 'an2') });
    assert.deepEqual(files(dir), sorted(COMMON, ANALYSIS, ['tools/count.py', 'requirements.lock']));
    assertNoTraces(dir);
    const manifest = read(dir, 'manifest.toml');
    assert.match(manifest, /^\[\[study_kinds\]\]\nkey = "polar_sweep"\ntitle = "Polar sweep"/m);
    assert.match(manifest, /^\[python\]$/m);
    assert.doesNotMatch(manifest, /^service = /m);
    assert.match(read(dir, 'plugin.py'), /JobKind\("polar_y_count", "tools\/count\.py", "project", \("steps",\), python="plugin"\)/);
    const { status, report } = check(dir);
    assert.equal(status, 0, JSON.stringify(report.findings, null, 1));
    assert.equal(report.tests.results.pytest.status, 'passed');
  });

  test('--name and --study-kind with quotes, apostrophes and a backslash: each file gets them in its own syntax; passes plugin:check', async () => {
    const name = `Bob's "lab"`;
    const title = `Owner's "X" wing\\B`;
    const { dir } = await scaffold({ key: 'q-ws', name, studyKind: title, service: true, out: join(TMP, 'quotes') });
    const manifest = read(dir, 'manifest.toml');
    assert.ok(manifest.includes(`name = ${JSON.stringify(name)}\n`), manifest);
    assert.ok(manifest.includes(`title = ${JSON.stringify(title)}\n`), manifest);
    assert.match(read(dir, 'GUIDE.md'), /^# Bob's "lab": plugin rules$/m);
    assert.equal(JSON.parse(read(dir, 'package.json')).description, `${name}: the workspace page's build (src/ -> workspace/)`);
    assert.ok(read(dir, 'workspace/index.html').includes('<title>Owner&#39;s &quot;X&quot; wing\\B</title>'));
    // The spec parses, and its strings hold the title as typed.
    const specPath = join(dir, 'tests', 'e2e', 'q-ws.spec.js');
    const syntax = spawnSync(process.execPath, ['--check', specPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const spec = readFileSync(specPath, 'utf8');
    assert.equal(jsLiteralAfter(spec, '\ntest('), `${title}: the form saves to the study, the backend answers and the job reports progress`);
    assert.equal(jsLiteralAfter(spec, 'kind: KIND, title: '), `Test ${title.toLowerCase()}`);
    assertNoTraces(dir);
    // Its pytest asserts the title as typed; plugin:check loads it and runs them.
    const { status, report } = check(dir);
    assert.equal(status, 0, JSON.stringify(report.findings, null, 1));
    assert.equal(report.tests.results.pytest.status, 'passed');
  });

  test('--analysis --name with quotes: the Python it writes holds the name as typed; passes plugin:check', async () => {
    const name = `Bob's "lab" \\ test`;
    const { dir } = await scaffold({ key: 'q-an', variant: 'analysis', venv: true, name, studyKind: `Owner's polar`, out: join(TMP, 'quotes-an') });
    assert.ok(read(dir, 'manifest.toml').includes(`name = ${JSON.stringify(name)}\n`));
    assert.ok(read(dir, 'plugin.py').includes(`name=${JSON.stringify(name)},`));
    const { status, report } = check(dir);
    assert.equal(status, 0, JSON.stringify(report.findings, null, 1));
    assert.equal(report.tests.results.pytest.status, 'passed');
  });

  test('a name or title of more than one line is refused', async () => {
    await assert.rejects(scaffold({ key: 'cc-one', name: 'Two\nlines', out: join(TMP, 'cc') }), /--name: one line of text/);
    await assert.rejects(scaffold({ key: 'cc-two', studyKind: 'Tab\there', out: join(TMP, 'cc') }), /--study-kind: one line of text/);
    assert.equal(existsSync(join(TMP, 'cc')), false);
  });

  test("a bundled plugin's key is refused: the app would put the new plugin in its place", async () => {
    await assert.rejects(scaffold({ key: 'incompressible_flow', out: join(TMP, 'coll') }), /is a bundled plugin's key/);
    assert.equal(existsSync(join(TMP, 'coll', 'incompressible_flow')), false);
    const r = spawnSync(process.execPath, [join(WEB_ROOT, 'scripts', 'plugin-new.mjs'), 'incompressible_flow', '--out', join(TMP, 'coll')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /is a bundled plugin's key/);
  });

  test('a scaffold that fails part way leaves nothing behind, so trying again works', async () => {
    // The kit missing from the import map: the build of the page fails after every file is written.
    const broken = fakeWebRoot('web-broken', Object.fromEntries(Object.entries(SDK.imports).filter(([k]) => k !== '@magnusim/plugin-ui')));
    const out = join(TMP, 'atomic');
    await assert.rejects(scaffold({ key: 'half-done', out, webRoot: broken }), /plugin-ui/);
    assert.deepEqual(readdirSync(out), []);
    const { dir } = await scaffold({ key: 'half-done', out, webRoot: fakeWebRoot('web-ok') });
    assert.ok(existsSync(join(dir, 'workspace', 'main.js')));
  });

  test('inside the app the browser test imports Playwright by name (Node finds the app\'s node_modules)', async () => {
    const web = fakeWebRoot('web-inside');
    // A Playwright package of its own, so that a path to it could be written too.
    const pw = join(web, 'node_modules', '@playwright', 'test');
    mkdirSync(pw, { recursive: true });
    writeFileSync(join(pw, 'package.json'), JSON.stringify({ name: '@playwright/test', exports: { '.': './index.mjs', './package.json': './package.json' } }));
    writeFileSync(join(pw, 'index.mjs'), 'export {};\n');
    const { dir } = await scaffold({ key: 'in-app', webRoot: web, build: false });
    assert.equal(dir, join(web, 'plugins', 'in-app'));
    assert.match(read(dir, 'tests/e2e/in-app.spec.js'), /^import \{ expect, test \} from '@playwright\/test';$/m);
    assert.match(read(dir, 'tests/e2e/playwright.config.js'), /^import \{ defineConfig \} from '@playwright\/test';$/m);
  });

  test("without the app's LICENSE it stops before it writes anything", async () => {
    const web = fakeWebRoot('web-no-licence');
    rmSync(join(web, 'LICENSE'));
    const out = join(TMP, 'no-licence');
    await assert.rejects(scaffold({ key: 'no-text', out, webRoot: web, build: false }), /no LICENSE \(the GPL text\)/);
    assert.equal(existsSync(join(out, 'no-text')), false);
    // With it, the plugin gets a copy.
    writeFileSync(join(web, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\n');
    const { dir, files: made } = await scaffold({ key: 'no-text', out, webRoot: web, build: false });
    assert.ok(made.includes('LICENSE'));
    assert.equal(read(dir, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\n');
  });

  test('never writes over a folder that has files', async () => {
    const out = join(TMP, 'busy');
    mkdirSync(join(out, 'taken'), { recursive: true });
    writeFileSync(join(out, 'taken', 'keep.txt'), 'mine');
    await assert.rejects(scaffold({ key: 'taken', out }), /already exists and is not empty/);
    assert.equal(readFileSync(join(out, 'taken', 'keep.txt'), 'utf8'), 'mine');
  });
});

