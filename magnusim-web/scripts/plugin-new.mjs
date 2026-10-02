/**
 * npm run plugin:new -- <key> [--workspace|--analysis] [--service] [--venv]
 *                        [--study-kind <title>] [--name <name>] [--out <folder>]
 *
 * Writes a new plugin folder, <out>/<key> (default: this app's plugins/<key>), that
 * passes `npm run plugin:check` and its own tests as written:
 *
 *   --workspace (default)  a study kind that opens in its own page: templates/plugin-workspace's
 *                          manifest, a React page on the UI kit in src/ (built into workspace/
 *                          now, and by `npm run build` after: vite.config.js keeps React, the
 *                          bridge and the kit external, from src/importmap.json, the host's
 *                          import map), a backend method and a job that reports progress
 *   --analysis             templates/plugin: a simulation type that clones the steady
 *                          incompressible analysis (and a project study kind with --study-kind)
 *   --service              its backend as a service (service/), run in its own environment
 *   --venv                 its own Python environment (requirements.lock); its job runs there
 *   --study-kind <title>   the study kind's title (default: the plugin's name)
 *
 * Every plugin gets manifest.toml (GPL-3.0-or-later), plugin.py, GUIDE.md (the hard
 * rules and where the host docs are), LICENSE, .gitignore and tests/ (pytest; a
 * workspace plugin also tests/e2e/). The generated files come from templates/plugin,
 * templates/plugin-workspace and templates/scaffold.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(WEB_ROOT, 'templates');
const SCAFFOLD = join(TEMPLATES, 'scaffold');

/** A plugin key the scaffold accepts: lowercase words joined by '-' or '_'. */
export const KEY_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

const USAGE = `usage: npm run plugin:new -- <key> [--workspace|--analysis] [--service] [--venv] [--study-kind <title>] [--name <name>] [--out <folder>]
  <key>               the plugin's key and folder name: lowercase letters and digits, words joined by - or _
  --workspace         a study kind with its own page (the default)
  --analysis          a simulation type, cloned from the steady incompressible analysis
  --service           a backend service in the plugin's own environment
  --venv              the plugin's own Python environment; its job runs there
  --study-kind <t>    the study kind's title (default: the plugin's name)
  --name <name>       the plugin's display name (default: from the key)
  --out <folder>      where the <key> folder goes (default: the app's plugins/)`;

export class UsageError extends Error {}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = { key: '', variant: '', service: false, venv: false, studyKind: '', name: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === '--workspace' || a === '--analysis') {
      const v = a.slice(2);
      if (opts.variant && opts.variant !== v) throw new UsageError('--workspace and --analysis cannot go together');
      opts.variant = v;
    } else if (a === '--service') opts.service = true;
    else if (a === '--venv') opts.venv = true;
    else if (a === '--study-kind') opts.studyKind = value();
    else if (a === '--name') opts.name = value();
    else if (a === '--out') opts.out = value();
    else if (a === '-h' || a === '--help') throw new UsageError('');
    else if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
    else if (!opts.key) opts.key = a;
    else throw new UsageError(`one key only (got ${opts.key} and ${a})`);
  }
  if (!opts.key) throw new UsageError('a plugin key is needed');
  if (!KEY_RE.test(opts.key) || opts.key.length > 64) {
    throw new UsageError(`key ${JSON.stringify(opts.key)}: use lowercase letters and digits, words joined by - or _ (for example wing-polar)`);
  }
  opts.variant = opts.variant || 'workspace';
  return opts;
}

function words(key) {
  const text = key.replace(/[-_]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function kindKey(title) {
  const k = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = /^[a-z]/.test(k) ? k : `kind_${k}`;
  return key.slice(0, 41).replace(/_+$/, '');
}

/** The keys of the app's bundled plugins (bundled-plugins/<folder>/manifest.toml). */
export function bundledKeys(webRoot = WEB_ROOT) {
  const root = join(webRoot, 'bundled-plugins');
  const keys = new Set();
  for (const folder of existsSync(root) ? readdirSync(root) : []) {
    const manifest = join(root, folder, 'manifest.toml');
    if (!existsSync(manifest)) continue;
    keys.add(/^key\s*=\s*"([^"]+)"/m.exec(readFileSync(manifest, 'utf8'))?.[1] || folder);
  }
  return keys;
}

// A name or title goes into Python, JavaScript, JSON, TOML and HTML text; each
// template takes the form its file needs.
const jsonBody = (s) => JSON.stringify(s).slice(1, -1);
/** Inside "..." in Python (and in a docstring): JSON's escapes are Python's too. */
const pyText = jsonBody;
/** Inside '...' in JavaScript. */
const jsText = (s) => jsonBody(s).replace(/'/g, "\\'");
const htmlText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Where the generated browser test imports Playwright from: the app's own copy. */
function playwrightImport(webRoot, e2eDir, inApp) {
  // Inside the app, Node finds the app's node_modules by itself.
  if (inApp) return '@playwright/test';
  let pkg;
  try {
    pkg = createRequire(join(webRoot, 'package.json')).resolve('@playwright/test/package.json');
  } catch {
    return '@playwright/test';
  }
  const file = join(dirname(pkg), 'index.mjs');
  return posixRel(e2eDir, file) ?? pathToFileURL(file).href;
}

/** The host API version (cfddesk.registry.API_VERSION). */
export function hostApiVersion(webRoot = WEB_ROOT) {
  const text = readFileSync(join(webRoot, 'python', 'cfddesk', 'registry', '__init__.py'), 'utf8');
  const m = /^API_VERSION\s*=\s*"([0-9]+\.[0-9]+)"/m.exec(text);
  if (!m) throw new Error('cannot read API_VERSION from python/cfddesk/registry/__init__.py');
  return m[1];
}

function sdkInfo(webRoot = WEB_ROOT) {
  return JSON.parse(readFileSync(join(webRoot, 'docs', 'plugins', 'plugin-sdk.json'), 'utf8'));
}

/**
 * {{name}} values and {{#flag}}...{{/flag}} / {{^flag}}...{{/flag}} sections. A line
 * holding only section tags leaves no line behind. An unknown name is an error.
 * @param {string} text
 * @param {Record<string, string>} vars
 * @param {Record<string, boolean>} flags
 */
export function render(text, vars, flags) {
  let out = text.replace(/\r\n/g, '\n').replace(/^[ \t]*((?:\{\{[#^/]\w+\}\})+)[ \t]*\n/gm, '$1');
  const section = /\{\{([#^])(\w+)\}\}((?:(?!\{\{[#^]\w+\}\})[\s\S])*?)\{\{\/\2\}\}/g;
  let prev;
  do {
    prev = out;
    out = out.replace(section, (_m, type, name, body) => {
      if (!(name in flags)) throw new Error(`template section ${name} is not a known flag`);
      return (type === '#') === !!flags[name] ? body : '';
    });
  } while (out !== prev);
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, name) => {
    if (!(name in vars)) throw new Error(`template value ${name} is not set`);
    return vars[name];
  });
  if (/\{\{[#^/]?\w+\}\}/.test(out)) throw new Error('a template section is not closed');
  return out;
}

/** Replace `from` (a string or RegExp) in `text`; throws when the template no longer has it. */
function must(text, from, to, what) {
  const found = typeof from === 'string' ? text.includes(from) : from.test(text);
  if (!found) throw new Error(`the template changed: ${what} not found (${String(from)})`);
  return typeof from === 'string' ? text.split(from).join(to) : text.replace(from, to);
}

function posixRel(from, to) {
  const r = relative(from, to);
  if (!r || isAbsolute(r)) return null;
  return r.split(sep).join('/');
}

function setLine(text, key, value) {
  return must(text, new RegExp(`^${key}\\s*=.*$`, 'm'), `${key} = ${JSON.stringify(value)}`, `${key} line`);
}

/** The manifest from templates/plugin-workspace (workspace) or templates/plugin (analysis). */
function manifestText(o) {
  if (o.variant === 'workspace') {
    let t = readFileSync(join(TEMPLATES, 'plugin-workspace', 'manifest.toml'), 'utf8').replace(/\r\n/g, '\n');
    t = setLine(t, 'key', o.key);
    t = setLine(t, 'name', o.name);
    t = setLine(t, 'api_version', o.api);
    t = setLine(t, 'description', `${o.name}: a ${o.kindTitle.toLowerCase()} study with its own workspace`);
    t = setLine(t, 'authors', 'Your Name');
    t = must(t, /^key = "sketch"$/gm, `key = "${o.kind}"`, 'workspace and kind keys');
    t = must(t, /^title = "Sketch"$/gm, `title = ${JSON.stringify(o.kindTitle)}`, 'workspace and kind titles');
    t = must(t, /^workspace = "sketch"$/m, `workspace = "${o.kind}"`, 'the kind\'s workspace');
    t = t.replace(/^# study_kind = "sketch"$/m, `# study_kind = "${o.kind}"`);
    t = t.replace(/"Start a sketch"/g, JSON.stringify(`Start a ${o.kindTitle.toLowerCase()}`.slice(0, 40)));
    t = t.replace(/"New sketch"/g, JSON.stringify(`New ${o.kindTitle.toLowerCase()}`.slice(0, 40)));
    t = t.replace(/^# header_label = "Sketch"$/m, `# header_label = ${JSON.stringify(o.kindTitle.slice(0, 24))}`);
    // The host docs are being reorganised; point at the generated reference.
    t = t.replace(/\((?:docs\/plugins\/)?authoring\.md, "[^"]*"\)/g, '(docs/plugins/API.md)');
    t = t.replace(/\(compatibility\.md, "## 1\.4"\)/g, '(docs/plugins/compatibility.md, 1.4)');
    return t;
  }
  let t = readFileSync(join(TEMPLATES, 'plugin', 'manifest.toml'), 'utf8').replace(/\r\n/g, '\n');
  t = setLine(t, 'key', o.key);
  t = setLine(t, 'name', o.name);
  t = setLine(t, 'api_version', o.api);
  t = setLine(t, 'description', `${o.name}: a simulation type cloned from the steady incompressible analysis`);
  t = setLine(t, 'authors', 'Your Name');
  if (o.flags.study_kind) {
    t += `\n# A project-level study this plugin owns (plugins/${o.key}/studies/<id>).\n[[study_kinds]]\nkey = "${o.kind}"\ntitle = ${JSON.stringify(o.kindTitle)}\nicon = "M5 19V5h14v14z M9 9h6v6H9z"\nschema_version = 1\n`;
  }
  return t;
}

/** templates/plugin's files, renamed for this plugin (analysis). */
function analysisFiles(o) {
  const read = (rel) => readFileSync(join(TEMPLATES, 'plugin', rel), 'utf8').replace(/\r\n/g, '\n');
  const common = (t) =>
    t
      .split('magnusim_plugin_template')
      .join(`magnusim_plugin_${o.pkg}`)
      .split('magnusim-plugin-template')
      .join(`magnusim-plugin-${o.key}`)
      .split('template-demo')
      .join(o.key)
      .split('template_demo')
      .join(o.pkg)
      .split('"Template demo"')
      .join(JSON.stringify(o.name))
      .split('Template demo')
      .join(pyText(o.name))
      .split('"Template"')
      .join(JSON.stringify(o.name));
  let plugin = common(read('plugin.py'));
  plugin = must(plugin, /^API_VERSION = ".*"$/m, `API_VERSION = "${o.api}"`, 'API_VERSION');
  plugin = plugin.replace('authors=["Magnusim"]', 'authors=["Your Name"]');
  plugin = must(plugin, '"""Copy-paste plugin. Clone a registered builtin; do not import cfddesk.builtin."""', `"""${pyText(o.name)}: a simulation type cloned from a registered builtin (do not import cfddesk.builtin)."""`, 'plugin docstring');
  if (o.flags.job) {
    plugin = must(plugin, 'from cfddesk.registry.manifest import PluginManifest', 'from cfddesk.registry.jobs import JobKind\nfrom cfddesk.registry.manifest import PluginManifest', 'manifest import');
    plugin = must(plugin, 'from dataclasses import replace', 'from dataclasses import replace\nfrom pathlib import Path', 'dataclasses import');
    plugin = must(
      plugin,
      '    return PluginManifest(',
      `    # A job (tools/count.py) that runs ${o.flags.venv ? "on the plugin's own environment" : "on the app's Python"} and reports progress.\n` +
        `    hub.register_job(\n        JobKind("${o.jobKey}", "tools/count.py", "project", ("steps",), python="${o.runtime}"),\n        plugin=PLUGIN,\n        package_dir=Path(__file__).resolve().parent,\n    )\n    return PluginManifest(`,
      'register return',
    );
  }
  let test = common(read('tests/test_register.py'));
  test = test.replace('def test_template_registers(', 'def test_registers(').replace('"""Loads this template from a plugins/ folder and checks the cloned analysis."""', `"""Loads ${pyText(o.name)} from a plugins/ folder and checks the analysis it adds."""`);
  return {
    'plugin.py': plugin,
    '__init__.py': `"""${pyText(o.name)} (installed as a package through an entry point; see pyproject.toml)."""\n`,
    'pyproject.toml': common(read('pyproject.toml')).replace('description = "Copy-paste Magnusim plugin"', `description = ${JSON.stringify(o.name)}`),
    'tests/test_register.py': test,
  };
}

function scaffoldFile(rel, o) {
  return render(readFileSync(join(SCAFFOLD, rel), 'utf8'), o.vars, o.flags);
}

/**
 * Write a new plugin. Returns {dir, files} (files: relative paths, sorted).
 * @param {{key: string, variant?: string, service?: boolean, venv?: boolean, studyKind?: string, name?: string, out?: string, base?: string, webRoot?: string, build?: boolean}} input
 */
export async function scaffold(input) {
  const webRoot = input.webRoot || WEB_ROOT;
  const variant = input.variant || 'workspace';
  const key = input.key;
  if (!KEY_RE.test(key)) throw new UsageError(`key ${JSON.stringify(key)} is not a valid plugin key`);
  if (bundledKeys(webRoot).has(key)) {
    throw new UsageError(`key ${JSON.stringify(key)} is a bundled plugin's key: the app would put this plugin in its place; choose another key`);
  }
  const base = input.base || process.cwd();
  const parent = input.out ? resolve(base, input.out) : join(webRoot, 'plugins');
  const dir = join(parent, key);
  if (existsSync(dir) && readdirSync(dir).length) throw new UsageError(`${dir} already exists and is not empty`);
  const name = (input.name || words(key)).trim();
  for (const [opt, value] of [['--name', name], ['--study-kind', input.studyKind || '']]) {
    if (/\p{Cc}/u.test(value)) throw new UsageError(`${opt}: one line of text, no control characters`);
  }
  if (!name) throw new UsageError('--name needs a name');
  const workspace = variant === 'workspace';
  const pythonTable = !!(input.service || input.venv);
  const flags = {
    workspace,
    analysis: !workspace,
    service: !!input.service,
    venv: pythonTable,
    job: workspace || !!input.venv,
    study_kind: workspace || !!input.studyKind,
  };
  const kindTitle = (input.studyKind || name).trim();
  if (!kindTitle) throw new UsageError('--study-kind needs a title');
  if (kindTitle.length > 80) throw new UsageError('--study-kind: a title of 80 characters at most');
  const pkg = key.replace(/-/g, '_');
  const api = hostApiVersion(webRoot);
  const info = sdkInfo(webRoot);
  const e2eDir = join(dir, 'tests', 'e2e');
  const inApp = !(posixRel(webRoot, dir) ?? '..').startsWith('..');
  const vars = {
    key,
    name,
    name_py: pyText(name),
    name_js: jsText(name),
    name_json: jsonBody(name),
    pkg,
    api,
    kind: kindKey(kindTitle),
    kind_title: kindTitle,
    kind_title_py: pyText(kindTitle),
    kind_title_js: jsText(kindTitle),
    kind_title_html: htmlText(kindTitle),
    kind_title_lower_js: jsText(kindTitle.toLowerCase()),
    playwright: playwrightImport(webRoot, e2eDir, inApp),
    job_key: `${pkg}_count`,
    runtime: pythonTable ? 'plugin' : 'core',
    react_version: String(info.react_version || '19.0.0'),
    app_rel: posixRel(e2eDir, webRoot) ?? pathToFileURL(webRoot).href,
    check_path: posixRel(webRoot, dir) ?? dir,
    e2e_config: (posixRel(webRoot, join(e2eDir, 'playwright.config.js')) ?? join(e2eDir, 'playwright.config.js')),
  };
  const o = { key, name, pkg, api, variant, flags, vars, kind: vars.kind, kindTitle, jobKey: vars.job_key, runtime: vars.runtime };

  /** @type {Record<string, string>} */
  const files = {
    'manifest.toml': manifestText(o) + (pythonTable ? scaffoldFile('manifest-python.toml.tmpl', o) : ''),
    'GUIDE.md': scaffoldFile('GUIDE.md.tmpl', o),
    '.gitignore': scaffoldFile('gitignore.tmpl', o),
    'tests/conftest.py': scaffoldFile('tests/conftest.py.tmpl', o),
    'tests/test_plugin.py': scaffoldFile('tests/test_plugin.py.tmpl', o),
  };
  if (workspace) {
    files['plugin.py'] = scaffoldFile('plugin-workspace.py.tmpl', o);
    files['src/index.html'] = scaffoldFile('workspace/src/index.html.tmpl', o);
    files['src/main.tsx'] = scaffoldFile('workspace/src/main.tsx.tmpl', o);
    files['src/importmap.json'] = JSON.stringify({ imports: info.imports }, null, 2) + '\n';
    files['vite.config.js'] = scaffoldFile('workspace/vite.config.js.tmpl', o);
    files['package.json'] = scaffoldFile('workspace/package.json.tmpl', o);
    files['tsconfig.json'] = scaffoldFile('workspace/tsconfig.json.tmpl', o);
    files['types/workspace-sdk.d.ts'] = readFileSync(join(webRoot, 'docs', 'plugins', 'workspace-sdk.d.ts'), 'utf8');
    files['types/plugin-ui.d.ts'] = readFileSync(join(webRoot, 'docs', 'plugins', 'plugin-ui.d.ts'), 'utf8');
    files['tests/e2e/playwright.config.js'] = scaffoldFile('tests/e2e/playwright.config.js.tmpl', o);
    files[`tests/e2e/${key}.spec.js`] = scaffoldFile('tests/e2e/plugin.spec.js.tmpl', o);
  } else {
    Object.assign(files, analysisFiles(o));
  }
  if (flags.service) files['service/__init__.py'] = scaffoldFile('service/__init__.py.tmpl', o);
  if (flags.job) files['tools/count.py'] = scaffoldFile('tools/count.py.tmpl', o);
  if (pythonTable) files['requirements.lock'] = scaffoldFile('requirements.lock.tmpl', o);

  // Written to a folder beside it and renamed into place when complete: a failure
  // part way leaves nothing behind (and nothing that blocks trying again).
  mkdirSync(parent, { recursive: true });
  const work = join(parent, `.${key}.new-${process.pid}-${Date.now()}`);
  try {
    for (const [rel, text] of Object.entries(files)) {
      const path = join(work, ...rel.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    const licence = [join(webRoot, 'LICENSE'), join(webRoot, '..', 'LICENSE')].find((p) => existsSync(p));
    if (licence) {
      copyFileSync(licence, join(work, 'LICENSE'));
      files.LICENSE = '';
    }
    if (workspace && input.build !== false) {
      for (const rel of await buildWorkspace(work, Object.keys(info.imports))) files[rel] = '';
    }
    if (existsSync(dir)) rmdirSync(dir); // empty: checked above
    renameSync(work, dir);
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    throw err;
  }
  return { dir, files: Object.keys(files).sort() };
}

/**
 * Build src/ into workspace/ now, with the app's esbuild, so the page works before
 * the plugin's own `npm install`; `npm run build` (Vite) writes the same files after.
 * @param {string} dir
 * @param {string[]} external
 */
export async function buildWorkspace(dir, external) {
  const esbuild = await import('esbuild');
  const out = join(dir, 'workspace');
  mkdirSync(out, { recursive: true });
  await esbuild.build({
    absWorkingDir: dir,
    entryPoints: [join(dir, 'src', 'main.tsx')],
    outfile: join(out, 'main.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const html = readFileSync(join(dir, 'src', 'index.html'), 'utf8');
  writeFileSync(join(out, 'index.html'), must(html, 'src="./main.tsx"', 'src="./main.js"', 'the page script'));
  return ['workspace/index.html', 'workspace/main.js'];
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      if (err.message) console.error(`plugin:new: ${err.message}`);
      console.error(USAGE);
      process.exit(err.message ? 2 : 0);
    }
    throw err;
  }
  try {
    const { dir, files } = await scaffold({ ...opts, base: process.env.INIT_CWD || process.cwd() });
    const rel = relative(process.env.INIT_CWD || process.cwd(), dir);
    const shown = !rel ? '.' : rel.startsWith('..') || isAbsolute(rel) ? dir : rel;
    console.log(`Made ${opts.variant} plugin ${opts.key} in ${dir}:`);
    for (const f of files) console.log(`  ${f}`);
    console.log(`\nNext:\n  npm run plugin:check -- ${shown}\n  read ${join(shown, 'GUIDE.md')}`);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`plugin:new: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
