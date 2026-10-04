// npm run gen:plugin-docs(:check) (scripts/gen-plugin-docs.mjs) and npm run test:docs
// (scripts/doc-tests.mjs): the reference is generated from the code and checked, and
// every code block tagged `test` runs, failing when its code is wrong.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, describe, test } from 'node:test';
import { codeBlocks, runBlock, runFiles, testBlocks } from '../doc-tests.mjs';
import { dtsExports, generate, pythonFacts } from '../gen-plugin-docs.mjs';
import { WEB_ROOT } from '../python-env.js';

const { JobManager } = await import('../server/jobs.ts');

const TMP = mkdtempSync(join(tmpdir(), 'magnusim-plugin-docs-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const DOCS = join(WEB_ROOT, 'docs', 'plugins');
const GEN = join(WEB_ROOT, 'scripts', 'gen-plugin-docs.mjs');

const block = (lang, code) => ({ lang, tags: [lang, 'test'], code, line: 1 });

// gate:h16-no-ai-traces: the docs and the templates name no coding-assistant tool or vendor
// and carry none of their files. The words are base64 here, so this file passes the same
// grep. The editor-pointer word is allowed only as CSS (`…:`); the mouse is "the pointer".
const TRACE_RE = new RegExp(
  ['Y2xhdWRl', 'YW50aHJvcGlj', 'Y3Vyc29y', 'Y2hhdGdwdA==', 'b3BlbmFp', 'Y29waWxvdA==', 'QUdFTlRTXC5tZA==', 'bGxtc1wudHh0']
    .map((b) => Buffer.from(b, 'base64').toString())
    .join('|'),
  'gi',
);
const POINTER_CSS = new RegExp(`${Buffer.from('Y3Vyc29y', 'base64').toString()}:`, 'i');
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|wasm|zip|gz|pyc)$/i;

/** Every trace in the text files under `dir` (caches left out), as "path:line: text". */
function tracesUnder(dir) {
  const hits = [];
  const go = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(WEB_ROOT, p).split(sep).join('/');
      if (e.isDirectory()) {
        if (['node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'].includes(e.name)) continue;
        if (TRACE_RE.test(e.name)) hits.push(`${rel}/`);
        TRACE_RE.lastIndex = 0;
        go(p);
        continue;
      }
      if (TRACE_RE.test(e.name)) hits.push(rel);
      TRACE_RE.lastIndex = 0;
      if (BINARY.test(e.name) || e.name === 'CACHEDIR.TAG') continue;
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(TRACE_RE)) {
            if (POINTER_CSS.test(line.slice(m.index, m.index + m[0].length + 1))) continue;
            hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
    }
  };
  go(dir);
  return hits;
}

describe('gate:h16-no-ai-traces', () => {
  test('docs/ and templates/ name no coding-assistant tool or vendor (CSS pointer rules apart)', () => {
    assert.deepEqual([...tracesUnder(join(WEB_ROOT, 'docs')), ...tracesUnder(join(WEB_ROOT, 'templates'))], []);
  });

  test('the check finds a trace in text and in a file name, and lets a CSS pointer rule through', () => {
    const dir = join(TMP, 'traces');
    const word = (b) => Buffer.from(b, 'base64').toString();
    const files = {
      'ok.css': `.a { ${word('Y3Vyc29y')}: pointer; }\n`,
      'mouse.md': `The tip sits right of the ${word('Y3Vyc29y')}.\n`,
      'made.md': `Written with ${word('Q29waWxvdA==')}.\n`,
      [word('bGxtc1wudHh0').replace('\\', '')]: 'index\n',
    };
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const hits = tracesUnder(dir).map((h) => h.replace(/^.*traces\//, ''));
    assert.equal(hits.length, 3, hits.join('\n'));
    assert.ok(hits.some((h) => h.startsWith('mouse.md:1:')));
    assert.ok(hits.some((h) => h.startsWith('made.md:1:')));
    assert.ok(!hits.some((h) => h.startsWith('ok.css')));
  });
});

describe('the generated reference', () => {
  test('API.md and manifest.schema.json in docs/plugins are up to date (gate:h16-docs-in-sync)', () => {
    const r = spawnSync(process.execPath, [GEN, '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('--check fails on a stale file, and writing makes it pass', () => {
    const w = spawnSync(process.execPath, [GEN, '--out-dir', TMP], { encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    assert.equal(spawnSync(process.execPath, [GEN, '--check', '--out-dir', TMP]).status, 0);
    const api = join(TMP, 'API.md');
    const text = readFileSync(api, 'utf8');
    assert.ok(text.includes('## 7. Hooks\n'), 'the section this test edits');
    writeFileSync(api, text.replace('## 7. Hooks', '## 7. Hooks (edited by hand)'));
    const r = spawnSync(process.execPath, [GEN, '--check', '--out-dir', TMP], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /docs\/plugins\/API\.md out of date; run npm run gen:plugin-docs/);
  });

  test("plugin-api.d.ts holds types only: the page's internal functions behind them are not published", () => {
    const dts = readFileSync(join(DOCS, 'plugin-api.d.ts'), 'utf8');
    assert.match(dts, /^declare module '@magnusim\/plugin-api' \{$/m);
    assert.match(dts, /export interface PluginHost \{/);
    assert.match(dts, /export interface StudyState \{/, 'the types the props name come along');
    assert.deepEqual(dts.split('\n').filter((l) => /^\s*export (?:declare )?(?:function|const|let|class) /.test(l)), []);
    // A file's own header comment (legacyBridge's, about its functions) is left out too.
    assert.doesNotMatch(dts, /Islands call the functions below/);
  });

  test('it says what the code says: every manifest key, bridge call, kit export, SDK module and hook', () => {
    const { api, schema } = generate();
    const facts = pythonFacts();
    const s = JSON.parse(schema);
    for (const key of Object.keys(s.properties)) assert.ok(api.includes(`| \`${key}\` |`), `manifest key ${key}`);
    for (const def of Object.values(s.$defs)) for (const key of Object.keys(def.properties)) assert.ok(api.includes(`| \`${key}\` |`), `table key ${key}`);
    const bridge = dtsExports(join(DOCS, 'workspace-sdk.d.ts'), '@magnusim/workspace');
    assert.ok(bridge.some((r) => r.name === 'connect' && r.kind === 'function'));
    const ws = bridge.find((r) => r.name === 'Workspace');
    for (const call of ['study.update', 'jobs.start', 'files.write', 'compute.submitOpenFOAM']) {
      assert.ok(ws.members.some((m) => m.text.startsWith(call + '(')), call);
      assert.ok(api.includes(`\`${call}(`), call);
    }
    const kit = dtsExports(join(DOCS, 'plugin-ui.d.ts'), '@magnusim/plugin-ui');
    for (const name of ['Button', 'NumberUnitInput', 'PanelChrome', 'formatSci']) {
      assert.ok(kit.some((r) => r.name === name), name);
      assert.ok(api.includes(`#### ${name}\n`), name);
    }
    // The in-page host API (docs/plugins/plugin-api.d.ts): register(host)'s host and every pluginUi member.
    const hostApi = dtsExports(join(DOCS, 'plugin-api.d.ts'), '@magnusim/plugin-api');
    assert.ok(api.includes('## 4. The in-page host API (@magnusim/plugin-api)\n'));
    const pluginUi = hostApi.find((r) => r.name === 'PluginUi');
    for (const name of ['registerPanel', 'registerFieldWidget', 'registerStudySettings', 'registerBcSettings', 'kit', 'toast', 'unitSystem']) {
      assert.ok(pluginUi.members.some((m) => m.text.startsWith(`${name}:`)), name);
      assert.ok(api.includes(`\`${name}: `), name);
    }
    for (const name of ['PluginHost', 'StudySettingsProps', 'BcSettingsProps', 'RegisterPanelOpts']) assert.ok(api.includes(`#### ${name}\n`), name);
    for (const m of facts.sdk) assert.ok(api.includes(`### ${m.module}\n`), m.module);
    for (const h of facts.hooks.fired) assert.ok(api.includes(`\`${h}\``), h);
    for (const f of facts.contract.analysis_type_fields) assert.ok(api.includes(`| \`${f.name}\` |`), f.name);
    assert.match(api, new RegExp(`Host API \\*\\*${facts.api_version.replace('.', '\\.')}\\*\\*`));
    // Its examples are tests (npm run test:docs runs them).
    assert.deepEqual(testBlocks(api).map((b) => b.lang), ['toml', 'ts', 'python']);
  });
});

describe('the generated reference reads as the code is used', () => {
  const api = () => readFileSync(join(DOCS, 'API.md'), 'utf8');

  test('a property is shown as an attribute (data.root), never as a call', () => {
    assert.ok(api().includes('- `root: Path`'), 'PluginData.root is a property');
    assert.ok(!api().includes('root() -> Path'), 'root is not called');
  });

  test('an optional group of props keeps its ? (DisabledReason.fix)', () => {
    assert.ok(api().includes('- `fix?: { … }`'), 'DisabledReasonProps.fix is optional');
    assert.ok(!api().includes('- `fix: { … }`'));
  });

  test('a set of names is shown whole: every event kind emit() takes', () => {
    const src = readFileSync(join(WEB_ROOT, 'python', 'sdk', 'magnusim_sdk', 'events.py'), 'utf8');
    const body = /^KNOWN_KINDS = frozenset\(\s*\{([^}]*)\}/m.exec(src);
    assert.ok(body, 'events.py defines KNOWN_KINDS');
    const kinds = [...body[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    assert.ok(kinds.length >= 10, kinds.join(' '));
    const line = api().split('\n').find((l) => l.startsWith('- `KNOWN_KINDS = '));
    assert.ok(line, 'API.md lists KNOWN_KINDS');
    assert.ok(!line.includes('...'), line);
    for (const k of kinds) assert.ok(line.includes(`"${k}"`), `KNOWN_KINDS in API.md misses ${k}`);
  });
});

// The handwritten guides (GUIDE.md, DESIGN.md, INDEX.md, compatibility.md's freeze) say
// what the code says: each of these fails when the code moves and the guide does not.
describe('the handwritten guides', () => {
  // A checkout with core.autocrlf writes these files with CRLF: every check reads LF.
  const lf = (text) => text.replace(/\r\n/g, '\n');
  const read = (name) => lf(readFileSync(join(DOCS, name), 'utf8'));
  const app = (...rel) => lf(readFileSync(join(WEB_ROOT, ...rel), 'utf8'));
  const GUIDES = ['GUIDE.md', 'DESIGN.md', 'INDEX.md'];

  test('INDEX.md names every file in docs/plugins, and nothing that is not there', () => {
    const index = read('INDEX.md');
    const here = readdirSync(DOCS, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .filter((name) => name !== 'INDEX.md');
    for (const name of here) assert.ok(index.includes(`[${name}](${name})`) || index.includes(`\`${name}\``), `INDEX.md does not name ${name}`);
    // The map is the first table; the commands table follows it.
    const map = index.slice(0, index.indexOf('| Command |'));
    const named = [...map.matchAll(/^\| (?:\[([^\]]+)\]\([^)]+\)|`([^`]+)`) \|/gm)].map((m) => m[1] || m[2]);
    assert.ok(named.length >= 10, named.join(', '));
    for (const name of named) assert.ok(here.includes(name), `INDEX.md names ${name}, which is not in docs/plugins`);
  });

  test("the app's README and plugins/README.md lead to INDEX.md", () => {
    const readme = readFileSync(join(WEB_ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes('](docs/plugins/INDEX.md)'), 'README.md links docs/plugins/INDEX.md');
    assert.ok(readFileSync(join(WEB_ROOT, 'plugins', 'README.md'), 'utf8').includes('docs/plugins/INDEX.md'), 'plugins/README.md names docs/plugins/INDEX.md');
  });

  test('every link and picture in the guides leads to a file that exists', () => {
    for (const name of [...GUIDES, 'compatibility.md']) {
      for (const m of read(name).matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/i.test(target)) continue;
        assert.ok(existsSync(join(DOCS, target)), `${name}: ${target} does not exist`);
      }
    }
  });

  test('every block the doc runner can run is tagged test in the guides', () => {
    const runnable = new Set(['python', 'py', 'ts', 'tsx', 'js', 'jsx', 'toml']);
    for (const name of GUIDES) {
      const blocks = codeBlocks(read(name));
      const untested = blocks.filter((b) => runnable.has(b.lang) && !b.tags.includes('test'));
      assert.deepEqual(untested.map((b) => `${name}:${b.line} (${b.lang})`), []);
    }
    assert.ok(testBlocks(read('GUIDE.md')).length >= 8, 'GUIDE.md keeps its tested examples');
    assert.ok(testBlocks(read('DESIGN.md')).length >= 3, 'DESIGN.md keeps its tested examples');
  });

  test("GUIDE.md's seam table is what e2e/support/plugin-suite.js exports", () => {
    const seam = readFileSync(join(WEB_ROOT, 'e2e', 'support', 'plugin-suite.js'), 'utf8');
    const exported = new Set();
    for (const m of seam.matchAll(/^export \{([^}]+)\}/gm)) for (const n of m[1].split(',')) exported.add(n.trim().split(/\s+as\s+/).pop());
    for (const m of seam.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)) exported.add(m[1]);
    const guide = read('GUIDE.md');
    const table = guide.slice(guide.indexOf('| Export | What it is |'), guide.indexOf('`scripts/__tests__/e2e-suites.test.mjs`'));
    const listed = new Set([...table.matchAll(/`(\w+)`/g)].map((m) => m[1]));
    assert.deepEqual([...exported].filter((n) => !listed.has(n)), [], 'exported but not in GUIDE.md');
    assert.deepEqual([...listed].filter((n) => !exported.has(n)), [], 'in GUIDE.md but not exported');
  });

  test("GUIDE.md's plugin:check table is the checker's rules, in its order", () => {
    const tool = readFileSync(join(WEB_ROOT, 'python', 'tools', 'plugin_check.py'), 'utf8');
    const block = tool.slice(tool.indexOf('CHECKS: tuple'), tool.indexOf('\n)\n', tool.indexOf('CHECKS: tuple')));
    const rules = [...block.matchAll(/^\s+\("(\w+)", "/gm)].map((m) => m[1]);
    assert.ok(rules.length >= 16, rules.join(', '));
    const guide = read('GUIDE.md');
    const table = guide.slice(guide.indexOf('| Rule | Checks |'), guide.indexOf('`--no-tests` skips'));
    assert.deepEqual([...table.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]), rules);
  });

  test("DESIGN.md's token values are tokens.css's", () => {
    const css = readFileSync(join(WEB_ROOT, 'src', 'theme', 'tokens.css'), 'utf8');
    const tokens = new Map([...css.matchAll(/^\s*(--mg-[\w-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
    const design = read('DESIGN.md');
    let rows = 0;
    for (const m of design.matchAll(/^\| `(--mg-[\w-]+)` \| `([^`]+)` \|/gm)) {
      assert.equal(tokens.get(m[1]), m[2], `DESIGN.md says ${m[1]} is ${m[2]}`);
      rows += 1;
    }
    assert.ok(rows >= 15, `${rows} single-token rows`);
    assert.ok(design.includes('| `--mg-primary` | `#1570ef` |'), 'the primary colour row');
    // Every token DESIGN.md names exists, and every one a range names (`--mg-x-1` … `--mg-x-6`).
    for (const m of design.matchAll(/`(--mg-[\w-]+)`/g)) assert.ok(tokens.has(m[1]), `DESIGN.md names ${m[1]}, which tokens.css does not have`);
    let ranges = 0;
    for (const m of design.matchAll(/`(--mg-[\w-]+-)(\d+)` … `(--mg-[\w-]+-)(\d+)`/g)) {
      assert.equal(m[1], m[3], m[0]);
      for (let n = Number(m[2]); n <= Number(m[4]); n++) assert.ok(tokens.has(`${m[1]}${n}`), `DESIGN.md's ${m[0]} names ${m[1]}${n}, which tokens.css does not have`);
      ranges += 1;
    }
    assert.ok(ranges >= 2, `${ranges} token ranges`);
  });

  /** The freeze section of compatibility.md against the versions the code reports. */
  function checkFreeze(text) {
    const facts = pythonFacts();
    const sdk = JSON.parse(read('plugin-sdk.json'));
    const compat = lf(text);
    const head = compat.match(/^## Frozen at (\S+)\n\n(.+)$/m);
    assert.ok(head, 'compatibility.md has a "## Frozen at" section');
    assert.equal(head[1], facts.api_version);
    assert.ok(compat.indexOf('## Frozen at') < compat.indexOf(`## ${facts.api_version}\n`), 'the freeze comes before the version sections');
    for (const v of [
      `host API ${facts.api_version}`,
      `workspace SDK ${sdk.sdk_version}`,
      `plugin UI kit ${sdk.plugin_ui_version}`,
      `\`magnusim_sdk\` ${facts.sdk_version}`,
      `analysis contract ${facts.contract.version}`,
    ]) {
      assert.ok(head[2].includes(v), `the freeze line names ${v}: ${head[2]}`);
    }
  }

  test('compatibility.md says the API is frozen at the versions the code reports', () => {
    checkFreeze(readFileSync(join(DOCS, 'compatibility.md'), 'utf8'));
  });

  test('the freeze check reads a CRLF checkout of compatibility.md the same', () => {
    const text = lf(readFileSync(join(DOCS, 'compatibility.md'), 'utf8'));
    checkFreeze(text.replace(/\n/g, '\r\n'));
  });

  test("GUIDE.md's startHost options are the ones host-server.mjs takes", () => {
    const src = app('e2e', 'support', 'host-server.mjs');
    const fn = src.slice(src.indexOf('export async function startHost('));
    const destructured = fn.slice(fn.indexOf('const {') + 7, fn.indexOf('} = options;'));
    const options = new Set([
      ...[...destructured.matchAll(/^\s*(\w+)(?:\s*[:=]|,)/gm)].map((m) => m[1]),
      ...[...fn.matchAll(/options\.(\w+)/g)].map((m) => m[1]),
    ]);
    const guide = read('GUIDE.md');
    const table = guide.slice(guide.indexOf('| Option | Default | What it does |'), guide.indexOf('It returns `{base,'));
    const listed = new Set([...table.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]));
    assert.ok(options.size >= 15, [...options].join(' '));
    assert.deepEqual([...options].filter((n) => !listed.has(n)), [], 'startHost takes these; GUIDE.md does not list them');
    assert.deepEqual([...listed].filter((n) => !options.has(n)), [], 'GUIDE.md lists these; startHost does not take them');
    // The default port it states is the one the code computes.
    assert.ok(fn.includes("Number(process.env.MAGNUSIM_E2E_PORT || 8083) + 11"), 'portFrom default');
    assert.ok(table.includes('`MAGNUSIM_E2E_PORT` + 11 (8094)'));
    // And the seeded project it names.
    assert.match(app('e2e', 'prepare-projects.js'), /export const NO_GEOMETRY_PROJECT = 'no-geometry-e2e';/);
    assert.ok(guide.includes('`NO_GEOMETRY_PROJECT` is the id `no-geometry-e2e`'));
  });

  test("GUIDE.md's set-up routes and Settings selectors are the app's", () => {
    const routes = app('scripts', 'server', 'routes.ts');
    const guide = read('GUIDE.md');
    const table = guide.slice(guide.indexOf('| Route | What it does |'), guide.indexOf('Turning your plugin off and on'));
    const listed = [...table.matchAll(/^\| `(GET|POST) (\/api\/[^`]+)` \|/gm)];
    assert.equal(listed.length, 4, table);
    for (const [, method, path] of listed) {
      assert.ok(routes.includes(`router.${method.toLowerCase()}('${path}'`), `${method} ${path} is not a route of scripts/server/routes.ts`);
    }
    // The scaffold's browser test uses exactly these.
    const spec = app('templates', 'scaffold', 'tests', 'e2e', 'plugin.spec.js.tmpl');
    for (const m of spec.matchAll(/\/api\/[\w-]+(?:\/[\w$`{}.-]+)*/g)) {
      const path = m[0].replace(/\$\{KEY\}/g, ':key').replace(/`$/, '');
      assert.ok(listed.some(([, , p]) => p === path), `the scaffold's test calls ${path}, which GUIDE.md does not list`);
    }
    const settings = app('src', 'panels', 'prefs', 'PluginsStep.tsx');
    for (const attr of ['data-plugin-key', 'data-plugin-toggle', 'data-plugin-status']) {
      assert.ok(guide.includes(attr), attr);
      assert.ok(settings.includes(`${attr}={`), `${attr} is not in PluginsStep.tsx`);
    }
    const wizard = app('src', 'wizard', 'controller.ts');
    for (const id of ['wb-prefs', 'wiz-next']) {
      assert.ok(guide.includes(`#${id}`), id);
      assert.ok(wizard.includes(`$('${id}')`), `${id} is not in the wizard`);
    }
    const overlay = app('src', 'workspace', 'WorkspaceOverlay.tsx');
    for (const attr of ['data-ws-toast', 'data-ws-crumb']) {
      assert.ok(guide.includes(`[${attr}]`), attr);
      assert.ok(overlay.includes(`'${attr}'`) || overlay.includes(`${attr}=`), `${attr} is not in WorkspaceOverlay.tsx`);
    }
  });

  test("GUIDE.md's JobKind table is JobKind's fields, and a study-scoped job is refused as it says", () => {
    const src = app('python', 'cfddesk', 'registry', 'jobs.py');
    const cls = src.slice(src.indexOf('class JobKind'), src.indexOf('def ensure_tool_in_package'));
    const fields = [...cls.matchAll(/^ {4}(\w+): /gm)].map((m) => m[1]);
    assert.deepEqual(fields, ['key', 'tool', 'scope', 'args_from_params', 'python']);
    const guide = read('GUIDE.md');
    assert.ok(guide.includes(`\`JobKind(${fields.join(', ')})\``), 'GUIDE.md gives the order');
    const table = guide.slice(guide.indexOf('| Field | What it is |'), guide.indexOf('`hub.register_job(spec'));
    assert.deepEqual([...table.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]), fields);
    // What ws.jobs.start sends (the plugin and project only) is refused for scope "study".
    const dir = mkdtempSync(join(TMP, 'jobs-'));
    const jobs = new JobManager({ cacheDir: dir });
    assert.throws(() => jobs.create('hello_count', { steps: 5, project_id: 'p1' }, 'p1', { scope: 'study' }), /simulation_id required/);
    assert.ok(table.includes('("simulation_id required")'));
    assert.equal(jobs.create('hello_count', { steps: 5, project_id: 'p1', study_id: 'st-1' }, 'p1', { scope: 'project' }).status, 'queued');
  });

  test('GUIDE.md says which study fields the host keeps on each route, as the code does', () => {
    const fixedIn = (text, re) => new Set([...re.exec(text)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]));
    const page = fixedIn(app('python', 'cfddesk', 'worker', 'methods.py'), /^_STUDY_FIXED = \{([^}]+)\}/m);
    const sdk = fixedIn(app('python', 'sdk', 'magnusim_sdk', 'data.py'), /^ {8}fixed = \{([^}]+)\}/m);
    const guide = read('GUIDE.md');
    const listed = (lead) => {
      const line = guide.split('\n').find((l) => l.includes(lead));
      assert.ok(line, lead);
      return new Set([...line.slice(line.indexOf(lead) + lead.length).split('.')[0].matchAll(/`(\w+)`/g)].map((m) => m[1]));
    };
    assert.deepEqual([...listed('Through the page, the host keeps:')].sort(), [...page].sort());
    assert.deepEqual([...listed('Through `PluginData`, it keeps:')].sort(), [...sdk].sort());
  });

  test('the quick start says how to build the page and start the app, with settings the app reads', () => {
    const guide = read('GUIDE.md');
    const index = read('INDEX.md');
    for (const cmd of ['npm install', 'npm run build', 'npm run dev']) {
      assert.ok(guide.slice(0, guide.indexOf('## 2.')).includes(cmd), `GUIDE.md "Quick start" gives ${cmd}`);
      assert.ok(index.includes(`\`${cmd}\``), `INDEX.md's commands give ${cmd}`);
    }
    assert.match(app('package.json'), /"dev": "vite /);
    // Each variable the second server sets is one the app reads.
    const quick = guide.slice(guide.indexOf('### A second app server of your own'), guide.indexOf('## 2.'));
    const vars = [...new Set([...quick.matchAll(/\$env:(MAGNUSIM_\w+)/g)].map((m) => m[1]))];
    assert.deepEqual(vars.sort(), ['MAGNUSIM_LOCAL_JSON', 'MAGNUSIM_PLUGINS_DIR', 'MAGNUSIM_PORT', 'MAGNUSIM_PROJECTS_ROOT']);
    const reads = { LOCAL_JSON: ['scripts', 'env-compat.js'], PROJECTS_ROOT: ['scripts', 'project-isolation.js'], PORT: ['scripts', 'prefs.js'] };
    for (const [suffix, rel] of Object.entries(reads)) assert.ok(app(...rel).includes(`envGet('${suffix}')`), `${rel.join('/')} reads ${suffix}`);
    assert.ok(app('scripts', 'server', 'routes.ts').includes('MAGNUSIM_PLUGINS_DIR'));
    // The saved port wins over the variable, as the guide warns.
    const prefs = app('scripts', 'prefs.js');
    assert.ok(prefs.indexOf('readLocalDoc().port') < prefs.indexOf("envGet('PORT')"));
    assert.match(prefs, /export const DEFAULT_PORT = 8082;/);
  });
});

describe('code blocks', () => {
  test('fences of either kind; only blocks tagged test are tests', () => {
    const md = '```python test\nx = 1\n```\n\n~~~ts\nlet y = 2;\n~~~\n\n````toml test\nkey = "a"\n```\n````\n';
    const all = codeBlocks(md);
    assert.deepEqual(all.map((b) => [b.lang, b.line]), [['python', 1], ['ts', 5], ['toml', 9]]);
    assert.equal(all[2].code, 'key = "a"\n```\n');
    assert.deepEqual(testBlocks(md).map((b) => b.lang), ['python', 'toml']);
  });

  test('python runs, with magnusim_sdk and cfddesk.registry; a failing one fails', () => {
    assert.equal(runBlock(block('python', 'from magnusim_sdk.events import EVENT_PREFIX\nimport cfddesk.registry\nassert EVENT_PREFIX\n')), null);
    assert.match(runBlock(block('python', 'assert 1 + 1 == 3, "arithmetic"\n')), /AssertionError: arithmetic/);
  });

  test('py is python too', () => {
    assert.equal(runBlock(block('py', 'import cfddesk.registry\n')), null);
    assert.match(runBlock(block('py', 'raise SystemExit(4)\n')), /exit 4/);
  });

  test("a python block gets scratch settings in its own folder, never this PC's", () => {
    const code = [
      'import os',
      'here = os.path.realpath(os.getcwd())',
      'for name in ("MAGNUSIM_LOCAL_JSON", "CFDDESK_LOCAL_JSON"):',
      '    path = os.path.realpath(os.environ[name])',
      '    assert os.path.dirname(path) == here, (name, path, here)',
      '    assert os.path.basename(here).startswith("magnusim-doc-test-py-"), here',
      '',
    ].join('\n');
    assert.equal(runBlock(block('python', code)), null);
  });

  test('ts and tsx are type-checked against the published bridge, kit and React types', () => {
    const ok = "import { connect } from '@magnusim/workspace';\nconst ws = await connect();\nconst s = await ws.study.get();\nawait ws.study.update({ a: 1 }, s.rev);\nexport {};\n";
    assert.equal(runBlock(block('ts', ok)), null);
    assert.match(runBlock(block('ts', ok.replace(', s.rev', ''))), /Expected 2 arguments/);
    assert.match(runBlock(block('ts', "import { connect } from '@magnusim/workspace';\nconst ws = await connect();\nws.study.remove();\nexport {};\n")), /remove/);
    const tsx = "import { Button } from '@magnusim/plugin-ui';\nimport { useState } from 'react';\nexport function A() {\n  const [n, setN] = useState(0);\n  return <Button onClick={() => setN(n + 1)}>Add one</Button>;\n}\n";
    assert.equal(runBlock(block('tsx', tsx)), null);
    assert.match(runBlock(block('tsx', tsx.replace('<Button onClick', '<Button colour="red" onClick'))), /colour/);
  });

  test("ts is type-checked against the in-page host API's types too (plugin-api.d.ts)", () => {
    const ok = [
      "import type { PluginHost } from '@magnusim/plugin-api';",
      'export function register(host: PluginHost): void {',
      "  host.pluginUi.registerPanel({ key: 'p', title: 'P', place: 'prefs', Component: () => null });",
      '}',
      '',
    ].join('\n');
    assert.equal(runBlock(block('ts', ok)), null);
    assert.match(runBlock(block('ts', ok.replace("place: 'prefs'", "place: 'toolbar'"))), /toolbar/);
  });

  test('js and jsx are type-checked too (checkJs)', () => {
    const js = "import { connect } from '@magnusim/workspace';\nconst ws = await connect();\nconst s = await ws.study.get();\nawait ws.study.update({ a: 1 }, s.rev);\nexport {};\n";
    assert.equal(runBlock(block('js', js)), null);
    assert.match(runBlock(block('js', js.replace(', s.rev', ''))), /Expected 2 arguments/);
    const jsx = "import { Button } from '@magnusim/plugin-ui';\nexport function A() {\n  return <Button onClick={() => {}}>Add one</Button>;\n}\n";
    assert.equal(runBlock(block('jsx', jsx)), null);
    assert.match(runBlock(block('jsx', jsx.replace('<Button onClick', '<Button colour="red" onClick'))), /colour/);
  });

  test('toml is a whole manifest the host must load', () => {
    const good = 'key = "doc-demo"\nname = "Doc demo"\nversion = "0.1.0"\napi_version = "1.4"\nlicense = "GPL-3.0-or-later"\n\n[[workspaces]]\nkey = "pad"\ntitle = "Pad"\n\n[[study_kinds]]\nkey = "pad"\ntitle = "Pad"\nworkspace = "pad"\n';
    assert.equal(runBlock(block('toml', good)), null);
    assert.match(runBlock(block('toml', good.replace('GPL-3.0-or-later', 'Proprietary'))), /^license: /m);
    assert.match(runBlock(block('toml', good.replace('workspace = "pad"', 'workspace = "elsewhere"'))), /^load: .*'elsewhere' is not declared/m);
    assert.match(runBlock(block('toml', good.replace('name = "Doc demo"\n', ''))), /^manifest: .*needs name/m);
    // A misspelt key is only a warning in plugin:check (the host ignores it); in an example it fails.
    const typo = good.replace('license = ', 'descripton = "misspelt"\nlicense = ').replace('title = "Pad"\n\n[[study_kinds]]', 'title = "Pad"\nicn = "M1 1"\n\n[[study_kinds]]');
    const why = runBlock(block('toml', typo));
    assert.match(why, /^manifest warning: descripton is not a manifest key/m);
    assert.match(why, /^manifest warning: workspaces\[0\]\.icn is not a manifest key/m);
    // So does a key newer than the api_version it declares.
    assert.match(runBlock(block('toml', good.replace('api_version = "1.4"', 'api_version = "1.1"').replace('[[workspaces]]', '[files]\nmax_file_mb = 8\n\n[[workspaces]]'))), /^api_version warning: files needs host API 1\.2/m);
  });

  test("toml: a manifest's ui entry and service must be ones the host can use", () => {
    const panel = 'key = "doc-panel"\nname = "Doc panel"\nversion = "0.1.0"\napi_version = "1.6"\nlicense = "GPL-3.0-or-later"\nui = "ui"\nui_entry = "index.tsx"\n';
    assert.equal(runBlock(block('toml', panel)), null);
    assert.match(runBlock(block('toml', panel.replace('index.tsx', 'index.xyz'))), /^ui: the UI entry ui\/index\.xyz is missing/m);
    const svc = panel.replace('ui = "ui"\nui_entry = "index.tsx"\n', '\n[python]\nrequirements = "requirements.lock"\nservice = "service"\n');
    assert.equal(runBlock(block('toml', svc)), null);
    // A name that is no module name at all is refused, never a crash of the checker.
    assert.match(runBlock(block('toml', svc.replace('service = "service"', 'service = "../elsewhere"'))), /^tools: \[python\] service '\.\.\/elsewhere' is not a module name/m);
  });

  test('a test block in a language with no runner fails; files report each block', () => {
    assert.match(runBlock(block('sh', 'echo hi\n')), /no runner for `sh test` blocks/);
    const md = join(TMP, 'doc.md');
    writeFileSync(md, '# Doc\n\n```python test\nassert True\n```\n\n```python\nraise SystemExit(1)\n```\n\n```python test\nraise SystemExit(3)\n```\n');
    const { passed, failed } = runFiles([md]);
    assert.equal(passed, 1);
    assert.deepEqual(failed.map((f) => [f.line, f.lang]), [[11, 'python']]);
    assert.match(failed[0].why, /exit 3/);
  });
});
