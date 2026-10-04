/**
 * npm run test:docs: run every code block tagged `test` in the plugin docs.
 *
 *   node scripts/doc-tests.mjs [file.md ...]   (default: every .md under docs/plugins/)
 *
 * A fenced block whose info string has the word `test` (```python test) is a test:
 *
 *   python, py         run with the app's Python, magnusim_sdk and cfddesk on the
 *                      path, in a scratch folder, with scratch settings; passes on exit 0
 *   ts, tsx, js, jsx   type-checked (strict) against the published types,
 *                      docs/plugins/workspace-sdk.d.ts, plugin-ui.d.ts and plugin-api.d.ts,
 *                      and React's: the code runs in a workspace frame or the app's page,
 *                      which only the app has
 *   toml               a whole manifest.toml: put in a scratch plugin folder named after
 *                      its key, with a stub of each file it names (workspace pages, the
 *                      ui entry, the [python] lock and service), and checked by npm run
 *                      plugin:check: its manifest, key, api_version, licence, the host
 *                      loading it, and its workspace, ui and tools rules must pass with no
 *                      error and no warning (a misspelt key is only a warning there, as
 *                      the host ignores it; in an example it is a mistake)
 *
 * A `test` block in any other language fails: say how to run it here first. Blocks
 * without `test` are not run. Exit 1 when a block fails.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { PY_ROOT, PYTHON, pyTool, WEB_ROOT } from './python-env.js';

const DOCS = join(WEB_ROOT, 'docs', 'plugins');

/** Every fenced block: {lang, tags, code, line} (line: the fence's, 1-based). */
export function codeBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*([^`]*)$/.exec(lines[i]);
    if (!open) continue;
    const fence = open[2];
    const tags = open[3].trim().split(/\s+/).filter(Boolean);
    const body = [];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[j])) body.push(lines[j++]);
    out.push({ lang: (tags[0] || '').toLowerCase(), tags, code: body.join('\n') + '\n', line: i + 1 });
    i = j;
  }
  return out;
}

export const testBlocks = (text) => codeBlocks(text).filter((b) => b.tags.slice(1).includes('test'));

function mdFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...mdFiles(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

function scratch(name) {
  return mkdtempSync(join(tmpdir(), `magnusim-doc-test-${name}-`));
}

function runPython(block) {
  const dir = scratch('py');
  try {
    writeFileSync(join(dir, 'block.py'), block.code);
    writeFileSync(join(dir, 'settings.json'), '{}');
    const env = {
      ...process.env,
      PYTHONPATH: [PY_ROOT, join(PY_ROOT, 'sdk'), process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      // Scratch settings: a block never reads or writes this PC's .cfddesk-local.json.
      MAGNUSIM_LOCAL_JSON: join(dir, 'settings.json'),
      CFDDESK_LOCAL_JSON: join(dir, 'settings.json'),
      PYTHONIOENCODING: 'utf-8',
    };
    const r = spawnSync(PYTHON, ['block.py'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    if (r.error) return `could not run ${PYTHON}: ${r.error.message}`;
    return r.status === 0 ? null : `exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n')}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function typecheck(block) {
  const ext = { ts: '.ts', tsx: '.tsx', js: '.js', jsx: '.jsx' }[block.lang];
  // Inside the app folder, so `react` resolves to its @types; .cache/ is not tracked.
  const dir = join(WEB_ROOT, '.cache', 'doc-tests');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `block-${process.pid}-${block.line}${ext}`);
  writeFileSync(file, block.code);
  try {
    const options = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: true,
      types: [],
    };
    const roots = [file, join(DOCS, 'workspace-sdk.d.ts'), join(DOCS, 'plugin-ui.d.ts'), join(DOCS, 'plugin-api.d.ts')];
    const program = ts.createProgram(roots, options);
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => !d.file || resolve(d.file.fileName) === resolve(file));
    if (!diags.length) return null;
    return diags
      .map((d) => {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        if (!d.file || d.start === undefined) return msg;
        const { line } = d.file.getLineAndCharacterOfPosition(d.start);
        return `block line ${line + 1}: ${msg}`;
      })
      .join('\n');
  } finally {
    rmSync(file, { force: true });
  }
}

// The rules a manifest decides. The files it names are stubbed above, so a wrong ui_entry,
// workspace entry or service is the example's own mistake.
const MUST_PASS = ['manifest', 'key', 'api_version', 'license', 'load', 'workspace', 'ui', 'tools'];

function checkManifest(block) {
  const key = /^key\s*=\s*"([^"]+)"/m.exec(block.code)?.[1];
  if (!key) return 'a manifest test block needs key = "..."';
  const root = scratch('toml');
  try {
    const dir = join(root, key);
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.toml'), block.code);
    writeFileSync(join(dir, 'plugin.py'), 'def register(hub):\n    return None\n');
    // The files the manifest names, so the host can load it: a page that connects.
    const page = (rel) => {
      const file = join(dir, ...rel.split('/'));
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '<script type="module" src="./main.js"></script>\n');
      writeFileSync(join(file, '..', 'main.js'), 'import { connect } from "@magnusim/workspace";\nawait connect();\n');
    };
    for (const m of block.code.matchAll(/^entry\s*=\s*"(workspace\/[^"]+)"/gm)) page(m[1]);
    if (/^\[\[workspaces\]\]/m.test(block.code) && !/^entry\s*=/m.test(block.code)) page('workspace/index.html');
    const lock = /^requirements\s*=\s*"([^"]+)"/m.exec(block.code)?.[1] || (/^\[python\]/m.test(block.code) ? 'requirements.lock' : '');
    if (lock) writeFileSync(join(dir, ...lock.split('/')), '# no packages\n');
    // An in-page UI's entry, in a language the host bundles or loads (an entry of any
    // other kind is left out, so the ui rule says it is missing).
    const ui = /^ui\s*=\s*"([^"]+)"/m.exec(block.code)?.[1];
    if (ui) {
      const entry = /^ui_entry\s*=\s*"([^"]+)"/m.exec(block.code)?.[1] || 'index.js';
      if (/\.(?:m?js|jsx|tsx?)$/.test(entry) && !entry.split('/').includes('..')) {
        const file = join(dir, ...ui.split('/'), ...entry.split('/'));
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'export function register() {}\n');
      }
    }
    // A [python] service: a module of that name (a name that is not a module is left out).
    const service = /^service\s*=\s*"([^"]+)"/m.exec(block.code)?.[1];
    if (service && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(service)) {
      const pkg = join(dir, ...service.split('.'));
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, '__init__.py'), 'from magnusim_sdk.service import method  # noqa: F401\n');
    }
    const r = spawnSync(PYTHON, [pyTool('plugin_check.py'), '--json', '--no-tests', dir], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
    let report;
    try {
      report = JSON.parse(r.stdout).plugins[0];
    } catch {
      return `plugin:check gave no report: ${(r.stderr || r.stdout).trim().slice(-600)}`;
    }
    // Errors and warnings alike: an example teaches what it shows.
    const bad = report.findings.filter((f) => MUST_PASS.includes(f.check));
    return bad.length ? bad.map((f) => `${f.check}${f.level === 'error' ? '' : ` ${f.level}`}: ${f.message}`).join('\n') : null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const RUNNERS = { python: runPython, py: runPython, ts: typecheck, tsx: typecheck, js: typecheck, jsx: typecheck, toml: checkManifest };

/** Run one block: null when it passes, else what went wrong. */
export function runBlock(block) {
  const run = RUNNERS[block.lang];
  if (!run) return `no runner for \`${block.lang || '(no language)'} test\` blocks (have: ${Object.keys(RUNNERS).join(', ')})`;
  return run(block);
}

/** Run every test block of the files; returns {passed, failed: [{file, line, lang, why}]}. */
export function runFiles(files, log = () => {}) {
  let passed = 0;
  const failed = [];
  for (const file of files) {
    const rel = relative(WEB_ROOT, file).split(sep).join('/');
    for (const block of testBlocks(readFileSync(file, 'utf8'))) {
      const why = runBlock(block);
      if (why) {
        failed.push({ file: rel, line: block.line, lang: block.lang, why });
        log(`FAIL ${rel}:${block.line} (${block.lang})\n  ${why.replace(/\n/g, '\n  ')}`);
      } else {
        passed++;
        log(`ok   ${rel}:${block.line} (${block.lang})`);
      }
    }
  }
  return { passed, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((a) => resolve(process.env.INIT_CWD || process.cwd(), a)) : mdFiles(DOCS);
  const { passed, failed } = runFiles(files, (line) => console.log(line));
  console.log(`\n${passed} doc test block(s) passed, ${failed.length} failed (${files.length} file(s) read)`);
  process.exit(failed.length ? 1 : 0);
}
