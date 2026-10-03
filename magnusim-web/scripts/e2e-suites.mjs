// Run the browser-test suites: all of them, or only the ones a change can affect
// (docs/TESTING.md). Suites: "core" (e2e/, playwright.config.js) and one per
// bundled plugin that has its own: a package.json with a test:e2e script (run in its
// folder, with its own toolchain), or bundled-plugins/<key>/e2e/playwright.config.js
// (run on the core's Playwright).
//
//   node scripts/e2e-suites.mjs --all            every suite, with WSL meshes and solves (before a push)
//   node scripts/e2e-suites.mjs --all --fast     every suite, without them
//   node scripts/e2e-suites.mjs --changed        the fast tier of the suites the changed files affect (before a commit)
//   node scripts/e2e-suites.mjs --changed --full the same with WSL meshes and solves
// Options:
//   --files a,b,c     the changed files (paths from the repository or magnusim-web); default: git
//                     status (staged, unstaged and untracked), so other work in a shared checkout counts too
//   --base <ref>      also count commits since <ref> (e.g. origin/master: what a push sends)
//   --suite <name>    only this suite (repeatable)
//   --plan            print what would run and why, run nothing; --json prints it as JSON
// Anything else (-g, --reporter=line, ...) goes to every Playwright suite that runs. A spec
// path limits the run to the suite that holds it (e2e/... the core, bundled-plugins/<key>/...
// that plugin).
// The full tier (--all without --fast, whole suites, MAGNUSIM_E2E_WSL not 0) sets
// MAGNUSIM_E2E_FULL=1 for every suite: a test whose prerequisite is missing there fails
// instead of skipping (docs/TESTING.md).
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Core specs that also run when a bundled plugin changes: they check how the core
 * meets its bundled plugins (the Settings rows of a required plugin and of ones that
 * ship off, the app without its required plugin, the analysis contract).
 */
export const CONTRACT_SPECS = ['e2e/h5-plugins.spec.js', 'e2e/h8-contract.spec.js'];

/**
 * The core files a plugin's suite depends on, for a plugin that reaches the app only
 * through the plugin host. A core change elsewhere runs the core suite (whose plugin-host
 * specs check the same host with test plugins) but not this plugin's suite. A plugin may
 * declare its own list in its package.json ("magnusim": {"e2eHostPaths": [...]}), which
 * wins over this one. A plugin with no list (Incompressible Flow: its studies run through
 * the whole core) runs on every core change.
 * Entries: a folder ("src/workspace/"), a file, or a pattern with * (within a folder).
 */
export const HOST_PATHS = {
  cad: [
    'src/workspace/',
    'src/plugin-sdk/',
    'src/plugin-api/',
    // The UI kit: every workspace frame loads /plugin-sdk/plugin-ui.css and its import-map entry.
    'src/plugin-ui/',
    'src/plugins/',
    'src/app/',
    'src/chrome/',
    'src/wizard/',
    'src/theme/',
    'src/workbench/dialogs.ts',
    'scripts/server/',
    'scripts/prefs.js',
    'scripts/e2e-suites.mjs',
    'python/cfddesk/registry/',
    'python/cfddesk/worker/',
    'python/cfddesk/project/scope.py',
    'python/cfddesk/project/web_writes.py',
    'python/sdk/',
    'e2e/support/',
    'e2e/prepare-projects.js',
    'e2e/fixtures/',
    'e2e/toolchain.js',
    'e2e/global-setup.js',
    'vite.config.js',
    'package.json',
    'package-lock.json',
  ],
};

/**
 * Host files a bundled plugin's suite also depends on when its manifest declares
 * `[[start_actions]]` (API 1.4): the places the host draws them (Home, the New Project
 * dialog, the header and the empty project, their host elements in the shell), the
 * create-then-open path (runtime.js), the tree's kind rows that publish them
 * (worker methods, treeModel) with the STUDIES rule (LeftTree), and the manifest
 * checks. Added to the plugin's own list by discoverPluginSuites; no plugin is named here.
 */
export const START_ACTION_HOST_PATHS = [
  'src/home/',
  'src/app/shell.html',
  'src/workbench/runtime.js',
  'src/workspace/startActions.ts',
  'src/workspace/StartActionPlaces.tsx',
  'src/workspace/WorkspacesMenu.tsx',
  'src/chrome/MenuButton.tsx',
  'src/chrome/studyName.ts',
  'src/chrome/LeftTree.tsx',
  'src/chrome/treeModel.ts',
  'python/cfddesk/registry/',
  'python/cfddesk/worker/methods.py',
];

/**
 * Host files a bundled plugin's suite also depends on when one of its study kinds has
 * `links_geometry = true` (API 1.5): the linked geometry's writers and readers.
 */
export const LINK_HOST_PATHS = [
  'scripts/w16-project-geometry.js',
  'scripts/w17-simulation.js',
  'scripts/w18-materials.js',
  'scripts/w19-boundary-conditions.js',
  'scripts/w20-mesh.js',
  'scripts/w21-mesh-generate.js',
  'scripts/w22-area-average.js',
  'scripts/w26-mesh-refinements.js',
  'scripts/study-io.js',
  'scripts/py-json.js',
  'scripts/project-layout.js',
  'scripts/w17-sim-catalog.js',
  'scripts/geometry-face-match.js',
  'scripts/link-store.js',
  'scripts/link-stamp.js',
  'scripts/link-build.js',
  'scripts/w27-solve.js',
  'scripts/compute-slot.js',
  'scripts/foam-runner.js',
  'scripts/server/',
  'src/workbench/jobQueueOrder.ts',
  'src/workbench/geometryRev.ts',
  'src/workbench/faceNames.ts',
  'src/workspace/linkChoice.ts',
  'src/workspace/linkReport.ts',
  'src/workspace/bridge.ts',
  'src/workspace/WorkspaceOverlay.tsx',
  // Exit sync (1.6): the leave guard runs the page's hook; openProject and the landing.
  'src/workspace/leaveGuard.ts',
  'src/home/controller.ts',
  'src/workbench/runtime.js',
  'src/workbench/dialogs.ts',
  'python/cfddesk/cad/',
  'python/cfddesk/project/',
  'python/cfddesk/worker/link_methods.py',
  'python/cfddesk/worker/methods.py',
  'python/sdk/magnusim_sdk/link.py',
  'python/tools/gen_link_*',
];

/**
 * The host path groups a bundled plugin's manifest opts into: a plain line test, so a
 * commented-out example adds nothing.
 */
function manifestHostPaths(pluginDir) {
  let text;
  try {
    text = readFileSync(join(pluginDir, 'manifest.toml'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  if (/^\s*\[\[start_actions\]\]/m.test(text)) out.push(...START_ACTION_HOST_PATHS);
  if (/^\s*links_geometry\s*=\s*true\b/m.test(text)) out.push(...LINK_HOST_PATHS);
  return out;
}

function hostMatcher(entries) {
  if (!entries) return () => true;
  const tests = entries.map((e) => {
    if (e.endsWith('/')) return (p) => p.startsWith(e);
    if (e.includes('*')) {
      const re = new RegExp(`^${e.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}$`);
      return (p) => re.test(p);
    }
    return (p) => p === e;
  });
  return (p) => tests.some((t) => t(p));
}

/**
 * Bundled plugins with their own suite: {key, run: 'npm' | 'playwright', config?, hostPaths}.
 */
export function discoverPluginSuites(webRoot = WEB_ROOT) {
  const dir = join(webRoot, 'bundled-plugins');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(join(dir, e.name, 'package.json'), 'utf8'));
    } catch {
      /* no package.json */
    }
    const base = pkg?.magnusim?.e2eHostPaths || HOST_PATHS[e.name] || null;
    // A plugin with no list runs on every core change already; one with a list also
    // depends on the host features its manifest opts into (start actions, linking).
    const hostPaths = base ? [...base, ...manifestHostPaths(join(dir, e.name)).filter((p) => !base.includes(p))] : null;
    if (pkg?.scripts?.['test:e2e']) out.push({ key: e.name, run: 'npm', hostPaths });
    else if (existsSync(join(dir, e.name, 'e2e', 'playwright.config.js'))) {
      out.push({ key: e.name, run: 'playwright', config: `bundled-plugins/${e.name}/e2e/playwright.config.js`, hostPaths });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const DOC = /\.(md|txt)$/i;
const UNIT_TEST = /\.test\.[cm]?[jt]sx?$/;

/**
 * What one changed file (relative to magnusim-web, "/" separators; starting with
 * "../" when it is outside magnusim-web) asks for:
 *   {kind: 'none', why}                nothing in the browser can change
 *   {kind: 'spec', spec}               one core spec only
 *   {kind: 'plugin', plugin}           that plugin's own suite (+ the core contract specs)
 *   {kind: 'plugin-in-core', plugin}   a plugin whose browser tests are still in e2e/: the whole core suite
 *   {kind: 'core'}                     the whole core suite, and the plugin suites that depend on the file
 */
export function classifyPath(rel, pluginKeys) {
  if (!rel || rel.startsWith('../')) return { kind: 'none', why: 'outside the app' };
  if (DOC.test(rel) || rel.startsWith('docs/') || /(^|\/)LICENSES?(\/|$)/.test(rel)) return { kind: 'none', why: 'documentation' };
  if (/^\.git(ignore|attributes)$|^eslint\.config\.js$|^\.editorconfig$/.test(rel)) return { kind: 'none', why: 'repository settings' };
  if (UNIT_TEST.test(rel) || rel.includes('/__tests__/') || rel.startsWith('src/test/')) return { kind: 'none', why: 'unit tests' };
  if (rel.startsWith('python/tests/') && !rel.startsWith('python/tests/fixtures/')) return { kind: 'none', why: 'unit tests' };
  if (/(^|\/)(test-results|\.tmp-[^/]*)\//.test(rel) || rel.startsWith('.cache/')) return { kind: 'none', why: 'test output' };
  // The plugin template is not loaded by the app (its own pytest checks it).
  if (rel.startsWith('templates/')) return { kind: 'none', why: 'plugin template' };
  const m = rel.match(/^bundled-plugins\/([^/]+)\/(.*)$/);
  if (m) {
    const [, key, rest] = m;
    if (rest.startsWith('tests/') || rest.startsWith('node_modules/')) return { kind: 'none', why: 'unit tests' };
    // A plugin without its own suite still has its browser tests in e2e/.
    return pluginKeys.includes(key) ? { kind: 'plugin', plugin: key } : { kind: 'plugin-in-core', plugin: key };
  }
  if (/^e2e\/[^/]+\.spec\.[cm]?[jt]s$/.test(rel)) return { kind: 'spec', spec: rel };
  return { kind: 'core' };
}

/**
 * Which suites the changed files need. `suites` is discoverPluginSuites() (or plugin keys:
 * a plugin then runs on every core change). Returns
 * {core: null | {specs: null (all) | string[], why: string[]}, plugins: {key: {why: string[]}}, none: [{file, why}]}.
 */
export function planSuites(changed, suites) {
  const list = suites.map((s) => (typeof s === 'string' ? { key: s, hostPaths: null } : s));
  const keys = list.map((s) => s.key);
  const none = [];
  const coreFiles = []; // the core itself: the core suite and the plugin suites that depend on it
  const allSpecs = []; // a plugin whose tests are in e2e/: the whole core suite
  const specFiles = []; // one core spec each
  const contract = []; // a plugin with its own suite: its suite and the contract specs
  const pluginWhy = Object.fromEntries(keys.map((k) => [k, []]));
  for (const rel of changed) {
    const c = classifyPath(rel, keys);
    if (c.kind === 'none') none.push({ file: rel, why: c.why });
    else if (c.kind === 'spec') specFiles.push(rel);
    else if (c.kind === 'plugin') {
      pluginWhy[c.plugin].push(rel);
      contract.push(rel);
    } else if (c.kind === 'plugin-in-core') allSpecs.push(rel);
    else coreFiles.push(rel);
  }
  const plan = { core: null, plugins: {}, none };
  if (coreFiles.length || allSpecs.length) {
    plan.core = { specs: null, why: [...coreFiles, ...allSpecs, ...specFiles] };
  } else if (specFiles.length || contract.length) {
    const specs = new Set(specFiles);
    if (contract.length) for (const s of CONTRACT_SPECS) specs.add(s);
    const more = contract.length > 1 ? ` (+${contract.length - 1} more)` : '';
    plan.core = { specs: [...specs].sort(), why: [...specFiles, ...(contract.length ? [`contract specs for ${contract[0]}${more}`] : [])] };
  }
  for (const s of list) {
    const depends = hostMatcher(s.hostPaths);
    const why = [...pluginWhy[s.key], ...coreFiles.filter(depends).map((f) => `core: ${f}`)];
    if (why.length) plan.plugins[s.key] = { why };
  }
  return plan;
}

/**
 * A changed file as magnusim-web-relative ("/" separators; "../..." outside it). A
 * relative path is read from magnusim-web, unless it starts with "magnusim-web/"
 * (a path from the repository root, as git prints it). Without git (a snapshot) the
 * folder holding magnusim-web stands for the repository root.
 */
export function toWebRel(p, repoRoot, webRoot = WEB_ROOT) {
  const root = repoRoot || dirname(webRoot);
  const webDir = relative(root, webRoot).split(sep).join('/');
  const slashed = p.replace(/\\/g, '/');
  let abs;
  if (isAbsolute(p)) abs = p;
  else if (slashed === webDir || slashed.startsWith(`${webDir}/`)) abs = resolve(root, p);
  else abs = resolve(webRoot, p);
  const rel = relative(webRoot, abs);
  if (isAbsolute(rel)) return `../${abs.split(sep).join('/')}`;
  return rel.split(sep).join('/');
}

/** Which suite a spec path named on the command line belongs to: 'core' or a plugin key. */
export function suiteOfFilter(filter, keys) {
  const p = filter.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^magnusim-web\//, '');
  const m = p.match(/^bundled-plugins\/([^/]+)\//);
  return m && keys.includes(m[1]) ? m[1] : 'core';
}

function git(args) {
  const r = spawnSync('git', args, { cwd: WEB_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

/** Changed files from git, relative to the repository root. */
function changedFromGit(base) {
  const files = new Set();
  // -z: NUL-separated; a rename is "R  new\0old\0".
  const parts = git(['status', '--porcelain=v1', '-uall', '-z']).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    files.add(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') files.add(parts[++i]);
  }
  if (base) for (const f of git(['diff', '--name-only', '-z', `${base}...HEAD`]).split('\0')) if (f) files.add(f);
  return [...files];
}

export function parseArgs(argv) {
  const o = { mode: null, fast: null, files: null, base: null, suites: [], plan: false, json: false, passthrough: [], filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [name, inline] = a.includes('=') && a.startsWith('--') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => (inline !== null ? inline : argv[++i]);
    if (name === '--all') o.mode = 'all';
    else if (name === '--changed') o.mode = 'changed';
    else if (name === '--fast') o.fast = true;
    else if (name === '--full') o.fast = false;
    else if (name === '--files') o.files = [...(o.files || []), ...value().split(',').map((s) => s.trim()).filter(Boolean)];
    else if (name === '--base') o.base = value();
    else if (name === '--suite') o.suites.push(value());
    else if (name === '--plan') o.plan = true;
    else if (name === '--json') o.json = o.plan = true;
    else if (a.startsWith('-')) {
      o.passthrough.push(a);
      // Playwright options that take their value as the next word.
      if (inline === null && /^(-g|--grep|-G|--grep-invert|--reporter|-j|--workers|--timeout|--retries|--repeat-each|--max-failures|--project|--trace|--shard|--output)$/.test(a)) {
        o.passthrough.push(argv[++i]);
      }
    } else o.filters.push(a);
  }
  if (!o.mode) o.mode = 'all';
  if (o.fast === null) o.fast = o.mode === 'changed';
  return o;
}

function playwrightCli() {
  return join(WEB_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
}

/**
 * The full tier (docs/TESTING.md: before a push, and nightly): --all without --fast, whole
 * suites (no spec paths named; --suite still counts), and WSL not turned off by hand.
 */
export function isFullTier(o, base = process.env) {
  return o.mode === 'all' && !o.fast && !o.filters.length && base.MAGNUSIM_E2E_WSL !== '0';
}

/** The environment every suite runs with. MAGNUSIM_E2E_FULL=1 marks the full tier; a value set by hand is kept. */
export function suiteEnv(o, base = process.env) {
  const env = { ...base };
  delete env.MAGNUSIM_E2E_SETTLED;
  if (o.fast) env.MAGNUSIM_E2E_WSL = '0';
  if (isFullTier(o, base)) env.MAGNUSIM_E2E_FULL = '1';
  return env;
}

function runPlaywright(label, config, specs, o) {
  const args = [playwrightCli(), 'test', ...(config ? ['-c', config] : []), ...o.passthrough, ...specs];
  const flags = `${o.fast ? ' (MAGNUSIM_E2E_WSL=0)' : ''}${isFullTier(o) ? ' (MAGNUSIM_E2E_FULL=1)' : ''}`;
  console.log(`\n[e2e] ${label}: playwright test ${args.slice(2).join(' ')}${flags}`);
  return spawnSync(process.execPath, args, { cwd: WEB_ROOT, env: suiteEnv(o), stdio: 'inherit' }).status;
}

function runPlugin(suite, specs, o) {
  if (suite.run === 'playwright') return runPlaywright(suite.key, suite.config, specs, o);
  const dir = join(WEB_ROOT, 'bundled-plugins', suite.key);
  if (!existsSync(join(dir, 'node_modules'))) {
    console.error(`\n[e2e] ${suite.key}: bundled-plugins/${suite.key} has no node_modules. Run "npm ci" in bundled-plugins/${suite.key} once, or pass --suite core to leave it out.`);
    return 1;
  }
  // Its own runner takes spec paths relative to its folder.
  const own = specs.map((s) => s.replace(/\\/g, '/').replace(/^(magnusim-web\/)?bundled-plugins\/[^/]+\//, ''));
  const extra = [...o.passthrough, ...own];
  console.log(`\n[e2e] ${suite.key}: npm run test:e2e${extra.length ? ` -- ${extra.join(' ')}` : ''} (in bundled-plugins/${suite.key})`);
  const quoted = extra.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return spawnSync(['npm run test:e2e', ...(quoted.length ? ['--', ...quoted] : [])].join(' '), { cwd: dir, env: suiteEnv(o), stdio: 'inherit', shell: true }).status;
}

function describe(plan, o, changedCount) {
  const lines = [];
  const tier = o.fast
    ? 'fast tier: no WSL meshes or solves'
    : `full: with WSL meshes and solves where WSL is here${isFullTier(o) ? '; the full tier (MAGNUSIM_E2E_FULL=1)' : ''}`;
  if (o.filters.length) lines.push(`[e2e] the named specs; ${tier}`);
  else if (o.mode === 'changed') lines.push(`[e2e] ${changedCount} changed file(s); ${tier}`);
  else lines.push(`[e2e] ${o.suites.length ? `suites ${o.suites.join(', ')}` : 'every suite'}; ${tier}`);
  const few = (list) => (list.length > 4 ? `${list.slice(0, 4).join(', ')} (+${list.length - 4} more)` : list.join(', '));
  const what = (v) => (v.specs && v.specs.length ? v.specs.join(' ') : v.specs ? '(named specs)' : 'all specs');
  if (plan.core) lines.push(`  core: ${what(plan.core)}${plan.core.why.length ? `  <- ${few(plan.core.why)}` : ''}`);
  for (const [k, v] of Object.entries(plan.plugins)) lines.push(`  ${k}: ${v.specs ? v.specs.join(' ') : 'its suite'}${v.why.length ? `  <- ${few(v.why)}` : ''}`);
  if (!plan.core && !Object.keys(plan.plugins).length) lines.push('  nothing to run');
  if (plan.none.length) lines.push(`  not run for: ${few(plan.none.map((n) => `${n.file} (${n.why})`))}`);
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const suites = discoverPluginSuites();
  const keys = suites.map((s) => s.key);
  let plan;
  let changedCount = 0;
  if (o.mode === 'changed') {
    let repoRoot = null;
    try {
      repoRoot = git(['rev-parse', '--show-toplevel']).trim();
    } catch {
      if (!o.files) {
        console.error('[e2e] not a git checkout (a snapshot?): name the changed files with --files a,b,c');
        return 2;
      }
    }
    const changed = o.files ? o.files : changedFromGit(o.base).map((f) => join(repoRoot, f));
    const rels = [...new Set(changed.map((f) => toWebRel(f, repoRoot)))];
    changedCount = rels.length;
    plan = planSuites(rels, suites);
  } else {
    plan = { core: { specs: null, why: [] }, plugins: Object.fromEntries(keys.map((k) => [k, { why: [] }])), none: [] };
  }
  if (o.filters.length) {
    // Specs named on the command line: those, in the suites that hold them.
    plan.core = null;
    plan.plugins = {};
    for (const f of o.filters) {
      const s = suiteOfFilter(f, keys);
      const entry = s === 'core' ? (plan.core ||= { specs: [], why: ['named on the command line'] }) : (plan.plugins[s] ||= { specs: [], why: ['named on the command line'] });
      entry.specs.push(f);
    }
  }
  if (o.suites.length) {
    if (!o.suites.includes('core')) plan.core = null;
    for (const k of Object.keys(plan.plugins)) if (!o.suites.includes(k)) delete plan.plugins[k];
  }
  if (o.json) {
    console.log(JSON.stringify({ fast: o.fast, full: isFullTier(o), ...plan }, null, 2));
    return 0;
  }
  console.log(describe(plan, o, changedCount));
  if (o.plan) return 0;
  const results = [];
  if (plan.core) results.push(['core', runPlaywright('core', null, plan.core.specs || [], o)]);
  for (const [k, v] of Object.entries(plan.plugins)) results.push([k, runPlugin(suites.find((s) => s.key === k), v.specs || [], o)]);
  if (results.length) console.log(`\n[e2e] ${results.map(([k, s]) => `${k}: ${s === 0 ? 'passed' : 'FAILED'}`).join(', ')}`);
  return results.some(([, s]) => s !== 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
