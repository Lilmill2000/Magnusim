// Exports Magnusim CAD's code into its own repository folder (the public "Magnusim CAD"
// repository): only the files the CAD edition's page, server, desktop shell and installer
// build use, as this commit has them. Magnusim CAD and the CAD plugin stay one code base:
// changes are made here, in Magnusim, and the copy is refreshed at each release (one commit
// per sync in the CAD repository).
//
//   node scripts/export-cad-repo.mjs [<out folder>] [--allow-dirty]     (default C:/mcad-export)
//   node scripts/export-cad-repo.mjs --check [<out folder>]   the self-check alone, on a copy
//                                                             (after a build in it, say)
//
// What goes in, each list worked out from the code as it runs, where it can be:
//   page       the page's Vite build as desktop/scripts/build.mjs page() runs it (cad.html):
//              every module and file it reads (getModuleIds, getWatchFiles, the tsconfig.json
//              it compiles with);
//   server     esbuild's metafile of the server and the desktop shell (SERVER_ENTRIES);
//   sdk-build  the builds the server runs itself: the plugin SDK and its UI kit (sdk-build.ts);
//   read       files the server reads by path, which no bundler sees (READ_BY_PATH);
//   types      what tsc needs on top for npm run typecheck (type-only imports, ambient .d.ts),
//              from TypeScript's own program for each of TSCONFIGS;
//   tooling    the desktop shell and its installer build, the CAD plugin (its source, its
//              committed workspace/ build output, its licences, the kernel and solver sources),
//              the tsconfigs (TOOLING, and esbuild's metafile of TOOLING_ENTRIES);
// and it writes, at the new repository's root: README.md, .gitignore and .gitattributes (from
// scripts/export-cad-repo/), LICENSE (Magnusim's), THIRD_PARTY_NOTICES.md (Magnusim's, with only
// the sections about what the copy holds: NOTICE_SECTIONS) and EXPORT.json (the Magnusim commit,
// and each exported path with the lists that put it there); in magnusim-web/: package.json with
// only the dependencies those lists use, and package-lock.json pruned from Magnusim's
// (npm install --package-lock-only --offline: the same versions, or the export stops).
// The app keeps its magnusim-web/ folder, so desktop/scripts/build.mjs and the installer's
// notices find LICENSE, THIRD_PARTY_NOTICES.md and kernel-build/ where they do in Magnusim.
//
// Contents come from git (this commit, as committed: LF), not from the working tree, the files
// of scripts/export-cad-repo/ too; a needed file that is changed or not committed stops the
// export (--allow-dirty copies the working tree instead and EXPORT.json says so). Then the
// self-check (scripts/export-cad-repo/self-check.mjs) reads the written copy: every file git's
// or the export's own, no AI-tool traces, models, test data, secrets or paths of this PC, the
// licences in place. A failed check lists each offender and fails the export; EXPORT.json keeps
// each check's counts. Never exported: tests and e2e, python/, other plugins, docs
// (but the two .d.ts files the server serves), hidden folders, AI-tool files, STEP and IGES files,
// npm packages, build output (but CAD's committed workspace/). A list that needs an excluded file
// stops the export: the copy would not run.
//
// The out folder is emptied first, keeping its .git (it can be a clone of the CAD repository);
// a folder that is not empty and holds no EXPORT.json written by this script is refused.
// Needs Node 24 (or 22.18 and later): it imports the server's TypeScript (sdk-build.ts, load-sdk.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { report, selfCheck, summary } from './export-cad-repo/self-check.mjs';
import { removeTreeSync } from './remove-tree.js';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAGNUSIM_URL = 'https://github.com/Lilmill2000/Magnusim';
/** EXPORT.json's kind: the out folder's marker (an export may replace a folder that has it). */
const MARKER_KIND = 'magnusim-cad-export';
/** The app's folder in the new repository: as in Magnusim (desktop/scripts/build.mjs reads WEB/..). */
const APP_DIR = 'magnusim-web';

/** What runs: the server, the desktop shell, the two scripts the server starts by path, and the Assistant's terminal client. */
const SERVER_ENTRIES = [
  'scripts/server/cad-edition/serve.mjs', // the server (npm run dev)
  'desktop/server.mjs', // the server in the desktop app (an Electron utility process)
  'desktop/main.mjs', // the desktop shell
  'desktop/config.mjs',
  'scripts/assistant-mcp.mjs', // the Assistant's MCP bridge
  'scripts/server/assistant/agents/launch.mjs', // a coding agent's launcher
  'scripts/assistant-run.mjs', // the Assistant from a terminal: the app's refusal of an unproven coding agent turn names it
];

/**
 * Run by path, not imported: the module that names each and the name it uses, so a script no
 * longer started, or no longer pointed to, is noticed.
 */
const BY_PATH = {
  'scripts/assistant-mcp.mjs': ['scripts/server/assistant/mcp/listener.ts', 'assistant-mcp.mjs'], // BRIDGE_SCRIPT
  'scripts/server/assistant/agents/launch.mjs': ['scripts/server/assistant/agents/process.ts', 'launch.mjs'], // LAUNCH_SCRIPT
  'scripts/assistant-run.mjs': ['scripts/server/assistant/turns.ts', 'with assistant-run'], // LAUNCH_PROOF_TEXT
};

/** Read by path at run time (no bundler sees them). A path ending in / is every file under it. */
const READ_BY_PATH = [
  'package.json', // "type": "module" for scripts/*.js; createRequire's base; the version (host-tools.ts)
  'cad.html', // the page from source (--dev), and the desktop build's input
  'scripts/generated/cad-edition-registry.json', // cad-edition/registry.js; made by gen:cad-edition (Python): copied as committed
  'scripts/generated/registry.json', // registry-defaults.js
  'src/plugin-sdk/workspace.ts', // plugin-sdk.ts bundles its text, and reads SDK_VERSION
  'src/plugin-sdk/base.css', // the SDK's theme.css: tokens.css + base.css
  'src/theme/tokens.css',
  'src/plugin-ui/version.ts', // pluginSdkInfo: PLUGIN_UI_API_VERSION
  'docs/plugins/workspace-sdk.d.ts', // the SDK's published types, served when present
  'docs/plugins/plugin-ui.d.ts',
  'bundled-plugins/cad/workspace/', // CAD's workspace, served as committed (routes.ts safePluginFile)
  'src/plugin-ui/colormaps/LICENSES/', // the licences of the colour maps in plugin-ui.js and the page
];

/** The desktop shell and its installer build, the CAD plugin, the typecheck configs. */
const TOOLING = [
  'desktop/', // all of it but its tests: main/server/config, scripts/ (build, notices, icon), resources/, package*.json
  'bundled-plugins/cad/package.json',
  'bundled-plugins/cad/package-lock.json',
  'bundled-plugins/cad/.gitignore',
  'bundled-plugins/cad/tsconfig.json',
  'bundled-plugins/cad/vite.config.ts',
  'bundled-plugins/cad/manifest.toml', // these three: desktop/scripts/build.mjs stage() copies them (it fails without one)
  'bundled-plugins/cad/plugin.py',
  'bundled-plugins/cad/README.md',
  'bundled-plugins/cad/CHANGELOG.md', // named by the plugin's README and source
  'bundled-plugins/cad/ARCHITECTURE.md',
  'bundled-plugins/cad/src/',
  'bundled-plugins/cad/workspace/',
  'bundled-plugins/cad/LICENSES/',
  'bundled-plugins/cad/kernel-build/', // the LGPL corresponding source of workspace/kernel/mk32.wasm
  'bundled-plugins/cad/solver-build/', // and of workspace/solver/planegcs.wasm
  'tsconfig.json', // also the page's: Vite compiles src/ with it
  'tsconfig.src.json',
  'scripts/server/tsconfig.json',
  'scripts/server/assistant/tsconfig.json',
];

/** Build scripts whose own imports come too (CAD's build: keymap-load, make-banana, lock). */
const TOOLING_ENTRIES = ['desktop/scripts/build.mjs', 'desktop/scripts/icon.mjs', 'bundled-plugins/cad/scripts/build.mjs', 'bundled-plugins/cad/kernel-build/ship.mjs'];

/** npm run typecheck: Magnusim's own configs, run over what is exported. */
const TSCONFIGS = ['tsconfig.json', 'scripts/server/tsconfig.json', 'tsconfig.src.json', 'scripts/server/assistant/tsconfig.json'];

/** Tools the scripts run that no import names: the page build (Vite) and tsc. */
const TOOL_PACKAGES = ['vite', '@vitejs/plugin-react', 'typescript'];

const PAGE_BUILD = [
  "import{build}from'vite';import react from'@vitejs/plugin-react';",
  "await build({configFile:false,root:process.cwd(),plugins:[react()],build:{outDir:'dist/page',emptyOutDir:true,chunkSizeWarningLimit:10000,rollupOptions:{input:'cad.html'}}})",
].join('');

const SCRIPTS = {
  build: `node --input-type=module -e "${PAGE_BUILD}"`,
  'build:cad': 'npm --prefix bundled-plugins/cad run build',
  'build:cad:check': 'npm --prefix bundled-plugins/cad run build:check',
  dev: 'node scripts/server/cad-edition/serve.mjs --dev',
  typecheck: TSCONFIGS.map((c) => `tsc -p ${c}`).join(' && '),
  'typecheck:cad': 'tsc -p bundled-plugins/cad/tsconfig.json',
  start: 'npm --prefix desktop start',
  // CAD's packages first: the installer's notices list three.js and three-mesh-bvh from its node_modules.
  // The desktop build fetches Electron's runtime itself when npm ci left none (Electron 44 fetches it on use).
  dist: 'npm ci --prefix bundled-plugins/cad && cd desktop && npm ci && npm run dist',
};

/**
 * Magnusim's THIRD_PARTY_NOTICES.md, section by section ("## " headings): keep, drop, or
 * replace with scripts/export-cad-repo/notices-<file>. A heading not listed stops the export
 * (decide whether Magnusim CAD ships it); a kept one that is gone does too.
 */
const NOTICE_SECTIONS = {
  'Gmsh and the mesher': 'drop',
  'OpenFOAM and cfMesh': 'drop',
  'Magnusim CAD plugin': 'keep', // desktop/scripts/notices.mjs cadSection() puts it in the installer's notices
  '2D Wind Tunnel plugin': 'drop',
  'XFOIL and the Airfoil plugin': 'drop',
  "The Assistant's provider packages": 'keep',
  "The Assistant's tool-connection package (MCP)": 'keep',
  "The Assistant's coding agents": 'keep', // acp.ts's MIT notice (SolidCraft)
  'Other dependencies': 'other.md', // Magnusim's names Python, PyVista and cadquery-ocp
  'Colour maps': 'keep',
};
/** Magnusim's setup files that the copy has none of. */
const NOTICE_WORDING = [[/Setup \(`npm ci`\) or `run\.bat`/g, '`npm ci`']];

// ---------------------------------------------------------------------------------------------

const slash = (p) => p.split(sep).join('/');
const WEB_N = slash(WEB);
const caseless = process.platform === 'win32';

/** `abs` relative to the web root (forward slashes), or null outside it. */
function inWeb(abs) {
  const p = slash(resolve(abs));
  const a = caseless ? p.toLowerCase() : p;
  const b = caseless ? WEB_N.toLowerCase() : WEB_N;
  return a.startsWith(`${b}/`) ? p.slice(WEB_N.length + 1) : null;
}

/** The npm package a node_modules path is in (the innermost), or null. */
function packageOf(p) {
  const s = slash(p);
  const i = s.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = s.slice(i + '/node_modules/'.length).split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

/** A bare import's package name, or null for node: and relative imports. */
function bareName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || isAbsolute(spec) || spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])) return null;
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

const TEST_DIRS = new Set(['__tests__', 'tests', 'test', 'e2e', 'e2e-cad', 'e2e-desktop', 'fixtures', 'test-results', 'playwright-report', 'coverage']);
const AI_FILE = /^(agents|claude|gemini|copilot-instructions)\.md$|^\.(cursorrules|windsurfrules|aider.*|clinerules)$|\.mdc$/i;
const DOCS_KEPT = new Set(READ_BY_PATH.filter((p) => p.startsWith('docs/')));

/** Why the export never takes `p` (web-root relative), or null. */
function excludedBy(p) {
  const parts = p.split('/');
  const dirs = parts.slice(0, -1);
  const name = parts[parts.length - 1];
  if (p === 'scripts/export-cad-repo.mjs' || p.startsWith('scripts/export-cad-repo/')) return 'this export';
  if (dirs.some((d) => d.startsWith('.'))) return 'a hidden folder';
  if (name.startsWith('.') && name !== '.gitignore') return 'a hidden file';
  if (AI_FILE.test(name)) return 'an AI-tool file';
  if (/\.(step|stp|iges|igs)$/i.test(name)) return 'a STEP or IGES file';
  if (dirs.some((d) => TEST_DIRS.has(d)) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /^(vitest|playwright)(\.[\w-]+)?\.config\./.test(name)) return 'a test';
  if (dirs.includes('node_modules')) return 'an npm package';
  if (dirs.includes('dist') || dirs.includes('build')) return 'build output';
  if (parts[0] === 'python') return "Magnusim's Python";
  if ((parts[0] === 'bundled-plugins' && parts[1] !== 'cad') || parts[0] === 'plugins') return 'another plugin';
  if ((parts[0] === 'docs' && !DOCS_KEPT.has(p)) || (parts[0] === 'bundled-plugins' && parts[2] === 'docs')) return 'docs';
  return null;
}

function git(args, opts = {}) {
  return execFileSync('git', ['-C', WEB, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

/** Blobs of `commit`, by repository path, in one git process. */
function catFiles(commit, paths) {
  const out = execFileSync('git', ['-C', WEB, 'cat-file', '--batch'], { input: paths.map((p) => `${commit}:${p}`).join('\n') + '\n', maxBuffer: 1 << 30 });
  const blobs = new Map();
  let pos = 0;
  for (const p of paths) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString();
    const [, type, size] = header.split(' ');
    if (type !== 'blob') throw new Error(`${p} is not a file in ${commit} (${header})`);
    const n = Number(size);
    blobs.set(p, out.subarray(nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  return blobs;
}

// --- the lists --------------------------------------------------------------------------------

/** The page's Vite build, in a temporary folder: its repository files and the npm packages in it. */
async function pageList() {
  const req = createRequire(join(WEB, 'package.json'));
  const { build } = await import(pathToFileURL(req.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(req.resolve('@vitejs/plugin-react')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'magnusim-cad-export-'));
  const ids = new Set();
  const recorder = () => ({
    name: 'magnusim-cad-export-recorder',
    enforce: 'post',
    generateBundle() {
      for (const id of this.getModuleIds()) ids.add(id);
      for (const f of this.getWatchFiles()) ids.add(f);
    },
  });
  try {
    await build({
      configFile: false,
      root: WEB,
      logLevel: 'error',
      cacheDir: join(tmp, 'cache'),
      plugins: [react(), recorder()],
      worker: { plugins: () => [recorder()] },
      build: { outDir: join(tmp, 'out'), emptyOutDir: true, chunkSizeWarningLimit: 10_000, rollupOptions: { input: join(WEB, 'cad.html') } },
    });
  } finally {
    removeTreeSync(tmp);
  }
  const files = new Set();
  const packages = new Set();
  for (const raw of ids) {
    if (raw.startsWith('\0')) continue;
    const id = raw.split('?')[0];
    const abs = isAbsolute(id) ? id : join(WEB, id);
    const pkg = packageOf(abs);
    if (pkg) {
      packages.add(pkg);
      continue;
    }
    if (!existsSync(abs)) continue; // a virtual module
    const rel = inWeb(abs);
    if (!rel) throw new Error(`the page build reads ${abs}, outside ${WEB}`);
    files.add(rel);
  }
  // esbuild compiles each TypeScript module with its nearest tsconfig.json (tsconfck).
  for (const rel of [...files]) {
    if (!/\.[cm]?tsx?$|\.jsx$/.test(rel)) continue;
    for (let dir = dirname(join(WEB, rel)); inWeb(join(dir, 'x')) !== null; dir = dirname(dir)) {
      if (existsSync(join(dir, 'tsconfig.json'))) {
        files.add(inWeb(join(dir, 'tsconfig.json')));
        break;
      }
    }
  }
  return { files, packages };
}

/** esbuild's metafile of `entries`, npm packages left out: repository files, and bare imports by importer. */
async function esbuildList(entries) {
  const req = createRequire(join(WEB, 'package.json'));
  const esbuild = req('esbuild');
  const files = new Set();
  const imports = new Map();
  for (const entry of entries) {
    if (!existsSync(join(WEB, entry))) throw new Error(`${entry} (an entry) does not exist`);
    const r = await esbuild.build({
      entryPoints: [join(WEB, entry)],
      absWorkingDir: WEB,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      bundle: true,
      metafile: true,
      write: false,
      outdir: join(tmpdir(), 'magnusim-cad-export-unused'),
      loader: { '.node': 'empty' },
      logLevel: 'silent',
    });
    for (const w of r.warnings) console.warn(`  esbuild (${entry}): ${w.text}${w.location ? ` at ${w.location.file}:${w.location.line}` : ''}`);
    for (const [input, info] of Object.entries(r.metafile.inputs)) {
      const abs = join(WEB, input);
      const rel = inWeb(abs);
      if (!rel || packageOf(abs)) throw new Error(`${entry} bundles ${input}, which is not a repository file`);
      files.add(rel);
      for (const imp of info.imports) {
        const name = imp.external ? bareName(imp.path) : null;
        if (!name) continue;
        if (!imports.has(name)) imports.set(name, new Set());
        imports.get(name).add(rel);
      }
    }
  }
  return { files, imports };
}

/** The builds the server runs (plugin-sdk.ts): the UI kit (JS and kit.css) and the workspace bridge. */
async function sdkList() {
  const sdk = await import(pathToFileURL(join(WEB, 'scripts', 'server', 'sdk-build.ts')).href);
  const req = createRequire(join(WEB, 'package.json'));
  const esbuild = req('esbuild');
  const kit = await sdk.bundle(WEB, "export * from './src/plugin-ui/index.ts';", 'prod', 'ts', { external: sdk.KIT_EXTERNAL });
  const bridge = await sdk.bundle(WEB, readFileSync(join(WEB, 'src', 'plugin-sdk', 'workspace.ts'), 'utf8'), 'prod', 'ts');
  // As sdk-build.ts buildKitCss(), with a metafile.
  const css = await esbuild.build({ entryPoints: [join(WEB, 'src', 'plugin-ui', 'kit.css')], absWorkingDir: WEB, bundle: true, write: false, metafile: true, logLevel: 'silent' });
  const files = new Set();
  const packages = new Set();
  for (const m of [kit.metafile, bridge.metafile, css.metafile]) {
    for (const input of Object.keys(m.inputs)) {
      if (input === sdk.SDK_ENTRY_NAME) continue;
      const abs = join(WEB, input);
      const pkg = packageOf(abs);
      if (pkg) packages.add(pkg);
      else if (inWeb(abs)) files.add(inWeb(abs));
      else throw new Error(`the plugin SDK build reads ${input}, outside ${WEB}`);
    }
  }
  return { files, packages };
}

/**
 * What tsc needs for TSCONFIGS over the exported files: each config's program, from the
 * exported files it includes (and its ambient .d.ts), until nothing new comes in.
 */
function typesList(have) {
  const ts = createRequire(join(WEB, 'package.json'))('typescript');
  const files = new Set();
  const packages = new Set();
  for (let round = 0, grew = true; grew; round++) {
    if (round > 8) throw new Error('the typecheck file list does not settle');
    grew = false;
    for (const cfg of TSCONFIGS) {
      const parsed = ts.getParsedCommandLineOfConfigFile(join(WEB, cfg), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(`${cfg}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
        },
      });
      const roots = parsed.fileNames.filter((f) => {
        const rel = inWeb(f);
        return rel && !excludedBy(rel) && (have.has(rel) || files.has(rel) || f.endsWith('.d.ts'));
      });
      const program = ts.createProgram({ rootNames: roots, options: parsed.options });
      for (const sf of program.getSourceFiles()) {
        const pkg = packageOf(sf.fileName);
        if (pkg) {
          packages.add(pkg);
          continue;
        }
        const rel = inWeb(sf.fileName);
        if (!rel) throw new Error(`${cfg}'s program reads ${sf.fileName}, outside ${WEB}`);
        if (!have.has(rel) && !files.has(rel)) {
          files.add(rel);
          grew = true;
        }
      }
    }
  }
  return { files, packages };
}

/** The packages that `roots` need, as the lockfile resolves them (dependencies, optional, peers). */
function lockClosure(lock, roots) {
  const keep = new Set();
  const visit = (key) => {
    if (keep.has(key) || !lock[key]) return;
    keep.add(key);
    const e = lock[key];
    for (const dep of [...Object.keys(e.dependencies || {}), ...Object.keys(e.optionalDependencies || {}), ...Object.keys(e.peerDependencies || {})]) {
      for (let base = key; ; ) {
        if (lock[`${base}/node_modules/${dep}`]) {
          visit(`${base}/node_modules/${dep}`);
          break;
        }
        const up = base.lastIndexOf('/node_modules/');
        if (up < 0) {
          visit(`node_modules/${dep}`);
          break;
        }
        base = base.slice(0, up);
      }
    }
  };
  for (const name of roots) visit(`node_modules/${name}`);
  return new Set([...keep].map((k) => packageOf(`/${k}`)));
}

// --- the out folder ---------------------------------------------------------------------------

function prepareOut(out, top) {
  const o = slash(resolve(out));
  const t = slash(resolve(top));
  const cmp = (s) => (caseless ? s.toLowerCase() : s);
  if (resolve(out) === parsePath(resolve(out)).root) throw new Error(`${out} is a drive's root`);
  if (cmp(o) === cmp(t) || cmp(o).startsWith(`${cmp(t)}/`) || cmp(t).startsWith(`${cmp(o)}/`)) throw new Error(`${out} is in or around the Magnusim checkout ${top}`);
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new Error(`${out} is not a folder`);
    const entries = readdirSync(out).filter((e) => e !== '.git');
    if (entries.length) {
      let kind = null;
      try {
        kind = JSON.parse(readFileSync(join(out, 'EXPORT.json'), 'utf8')).kind;
      } catch {
        /* no marker */
      }
      if (kind !== MARKER_KIND) throw new Error(`${out} is not empty and holds no EXPORT.json from this script: refused (empty it, or choose another folder)`);
      for (const e of entries) removeTreeSync(join(out, e));
    }
  }
  mkdirSync(out, { recursive: true });
}

function writeOut(out, rel, data) {
  const p = join(out, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

/**
 * Magnusim's notices, with only NOTICE_SECTIONS' kept (and replaced) sections, after
 * notices-intro.md. `fixed(name)`: a file of scripts/export-cad-repo/, as the commit has it.
 */
function cadNotices(text, fixed) {
  const parts = text.replace(/\r\n/g, '\n').split(/^## /m);
  const out = [fixed('notices-intro.md').toString('utf8').trim()];
  const seen = new Set();
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const heading = part.slice(0, nl).trim();
    const what = NOTICE_SECTIONS[heading];
    if (!what) throw new Error(`THIRD_PARTY_NOTICES.md has a section the export does not know, "## ${heading}": add it to NOTICE_SECTIONS (keep, drop, or a replacement)`);
    seen.add(heading);
    if (what === 'drop') continue;
    let body = what === 'keep' ? part.slice(nl + 1).trim() : fixed(`notices-${what}`).toString('utf8').trim();
    for (const [from, to] of NOTICE_WORDING) body = body.replace(from, to);
    out.push(`## ${heading}\n\n${body}`);
  }
  const missing = Object.keys(NOTICE_SECTIONS).filter((h) => NOTICE_SECTIONS[h] !== 'drop' && !seen.has(h));
  if (missing.length) throw new Error(`THIRD_PARTY_NOTICES.md has no "## ${missing.join('", "## ')}" section any more: update NOTICE_SECTIONS`);
  return `${out.join('\n\n')}\n`;
}

const BINARY = /\.(wasm|bin|webp|png|ico|jpe?g|gif|woff2?|zip|gz)$/i;

/** The files of scripts/export-cad-repo/ the export writes or composes from (the self-check's code is not one). */
const FIXED_FILES = ['README.md', 'gitignore', 'gitattributes', 'notices-intro.md', ...Object.values(NOTICE_SECTIONS).filter((v) => v !== 'keep' && v !== 'drop').map((v) => `notices-${v}`)];

/** The copy's root files that are Magnusim's git files as they are: copy path -> repository path. */
const rootFromGit = (prefix) => ({
  'README.md': `${prefix}scripts/export-cad-repo/README.md`,
  '.gitignore': `${prefix}scripts/export-cad-repo/gitignore`,
  '.gitattributes': `${prefix}scripts/export-cad-repo/gitattributes`,
  LICENSE: 'LICENSE',
});

/** The self-check alone, on a copy this script wrote (its EXPORT.json names the commit). */
function checkOnly(out, prefix) {
  let record = null;
  try {
    record = JSON.parse(readFileSync(join(out, 'EXPORT.json'), 'utf8'));
  } catch {
    /* refused below */
  }
  if (!record || record.kind !== MARKER_KIND || !record.magnusim?.commit) throw new Error(`${out} holds no EXPORT.json from this script`);
  const { commit, uncommitted = [] } = record.magnusim;
  console.log(`Self-check of ${out} (Magnusim ${commit.slice(0, 10)})`);
  const result = selfCheck({ out, web: WEB, commit, prefix, appDir: APP_DIR, fromGit: rootFromGit(prefix), uncommitted });
  if (!report(result)) throw new Error(`the self-check failed: ${Object.values(result.checks).reduce((n, c) => n + c.offenders.length, 0)} offenders`);
  console.log('Self-check passed');
}

// --- the export -------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const allowDirty = args.includes('--allow-dirty');
  const checkAlone = args.includes('--check');
  const unknown = args.filter((a) => a.startsWith('--') && a !== '--allow-dirty' && a !== '--check');
  if (unknown.length) throw new Error(`unknown option ${unknown.join(' ')}`);
  const out = resolve(args.find((a) => !a.startsWith('--')) || (process.platform === 'win32' ? 'C:/mcad-export' : join(WEB, '..', '..', 'mcad-export')));

  const top = git(['rev-parse', '--show-toplevel']).trim();
  const prefix = git(['rev-parse', '--show-prefix']).trim();
  if (prefix !== `${APP_DIR}/` || slash(resolve(top)) !== slash(resolve(WEB, '..'))) throw new Error(`expected the app in ${APP_DIR}/ at the repository's root, found ${top} + ${prefix}`);
  if (checkAlone) return checkOnly(out, prefix);
  const commit = git(['rev-parse', 'HEAD']).trim();
  const commitDate = git(['show', '-s', '--format=%cI', commit]).trim();
  // The whole repository's (':/'): LICENSE and THIRD_PARTY_NOTICES.md are at its root, above the app.
  const tracked = new Set(git(['ls-files', '-z', '--full-name', '--', ':/']).split('\0').filter(Boolean));
  const dirtyTop = new Set(
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      .split('\0')
      .filter((e) => /^[ MADRCU?!]{2} /.test(e))
      .map((e) => e.slice(3)),
  );
  const isDirty = (rel) => dirtyTop.has(`${prefix}${rel}`);
  console.log(`Magnusim ${commit.slice(0, 10)} (${commitDate}) -> ${out}`);

  // Magnusim's files the export writes its own from (repository paths): from git too.
  const readFrom = ['LICENSE', 'THIRD_PARTY_NOTICES.md', ...['package.json', 'package-lock.json', 'desktop/package.json', ...FIXED_FILES.map((f) => `scripts/export-cad-repo/${f}`)].map((p) => `${prefix}${p}`)];
  const readDirty = readFrom.filter((p) => !tracked.has(p) || dirtyTop.has(p));
  if (readDirty.length && !allowDirty) throw new Error(`these files are changed or not committed (commit them, or --allow-dirty):\n  ${readDirty.join('\n  ')}`);
  const committed = catFiles(commit, readFrom.filter((p) => !readDirty.includes(p)));
  /** One of readFrom, as the commit has it (or, with --allow-dirty, as the working tree has it when changed). */
  const source = (repoPath) => (readDirty.includes(repoPath) ? readFileSync(join(top, repoPath)) : committed.get(repoPath));
  const fixed = (name) => source(`${prefix}scripts/export-cad-repo/${name}`);

  /** path -> the lists that put it there */
  const lists = new Map();
  const add = (rel, list) => {
    if (!lists.has(rel)) lists.set(rel, new Set());
    lists.get(rel).add(list);
  };
  /** A named file: it must exist and the export must take it. */
  const need = (rel, list) => {
    const why = excludedBy(rel);
    if (why) throw new Error(`${list} needs ${rel}, but the export leaves it out (${why})`);
    if (!existsSync(join(WEB, rel))) throw new Error(`${list} names ${rel}, which does not exist`);
    add(rel, list);
  };
  /** A folder: every tracked file under it that the export takes (at least one). */
  const folder = (dir, list) => {
    const under = [...tracked].filter((p) => p.startsWith(`${prefix}${dir}`)).map((p) => p.slice(prefix.length));
    const taken = under.filter((p) => !excludedBy(p));
    if (!taken.length) throw new Error(`${list} names ${dir}, which holds no file the export takes`);
    for (const p of taken) add(p, list);
  };
  const named = (items, list) => {
    for (const item of items) (item.endsWith('/') ? folder(item, list) : need(item, list));
  };

  console.log('  page: the Vite build of cad.html');
  const page = await pageList();
  for (const f of page.files) need(f, 'page');
  console.log('  server: esbuild of the server and the desktop shell');
  const server = await esbuildList(SERVER_ENTRIES);
  for (const f of server.files) need(f, 'server');
  for (const [script, [owner, name]] of Object.entries(BY_PATH)) {
    if (!readFileSync(join(WEB, owner), 'utf8').includes(name)) throw new Error(`${owner} no longer says "${name}": is ${script} still run? (update BY_PATH)`);
  }
  console.log('  sdk-build: the plugin SDK and its UI kit');
  const sdk = await sdkList();
  for (const f of sdk.files) need(f, 'sdk-build');
  named(READ_BY_PATH, 'read');
  console.log('  tooling: the desktop shell, the CAD plugin, the typecheck configs');
  named(TOOLING, 'tooling');
  const tooling = await esbuildList(TOOLING_ENTRIES);
  for (const f of tooling.files) need(f, 'tooling');
  console.log('  types: what tsc needs on top');
  const types = typesList(new Set(lists.keys()));
  for (const f of types.files) need(f, 'types');

  // The root package.json's dependencies: those the lists use, as Magnusim declares them (at the commit).
  const rootPkg = JSON.parse(source(`${prefix}package.json`).toString('utf8'));
  const desktopPkg = JSON.parse(source(`${prefix}desktop/package.json`).toString('utf8'));
  const declared = new Set([...Object.keys(rootPkg.dependencies || {}), ...Object.keys(rootPkg.devDependencies || {})]);
  const desktopDeclared = new Set([...Object.keys(desktopPkg.dependencies || {}), ...Object.keys(desktopPkg.devDependencies || {})]);
  for (const [name, by] of server.imports) {
    if (!declared.has(name) && !desktopDeclared.has(name)) throw new Error(`${[...by].join(', ')} import ${name}, which neither package.json declares`);
  }
  const loadSdk = await import(pathToFileURL(join(WEB, 'scripts', 'server', 'assistant', 'providers', 'load-sdk.ts')).href);
  const roots = new Set([
    ...page.packages,
    ...server.imports.keys(),
    ...sdk.packages,
    ...types.packages,
    ...TOOL_PACKAGES,
    // What desktop/scripts/build.mjs serverPackages() ships: loaded by name (load-sdk.ts), React, esbuild.
    ...loadSdk.SDK_NAMES,
    loadSdk.MCP_SDK_NAME,
    'react',
    'react-dom',
    'esbuild',
  ]);
  const lockText = source(`${prefix}package-lock.json`);
  const magnusimLock = JSON.parse(lockText.toString('utf8'));
  const used = lockClosure(magnusimLock.packages, roots);
  const pick = (deps) => Object.fromEntries(Object.entries(deps || {}).filter(([n]) => used.has(n)));
  const pkg = {
    name: 'magnusim-cad',
    private: true,
    version: desktopPkg.version,
    type: 'module',
    description: 'Magnusim CAD: parametric parts and STEP files with the Assistant, as a desktop app (the CAD edition of Magnusim, copied from its repository)',
    scripts: SCRIPTS,
    dependencies: pick(rootPkg.dependencies),
    devDependencies: pick(rootPkg.devDependencies),
    license: 'GPL-3.0-or-later',
    engines: rootPkg.engines,
    overrides: rootPkg.overrides,
  };
  if (!pkg.overrides) delete pkg.overrides;
  add('package.json', 'export');
  add('package-lock.json', 'export');

  // Every file comes from git, as committed, unless --allow-dirty.
  const files = [...lists.keys()].filter((p) => p !== 'package.json' && p !== 'package-lock.json').sort();
  const dirty = files.filter((p) => !tracked.has(`${prefix}${p}`) || isDirty(p));
  if (dirty.length && !allowDirty) throw new Error(`these files are changed or not committed (commit them, or --allow-dirty):\n  ${dirty.join('\n  ')}`);

  /** What came from the working tree (--allow-dirty): repository paths. */
  const uncommitted = [...dirty.map((p) => `${prefix}${p}`), ...readDirty].sort();

  prepareOut(out, top);
  // The marker first: an export that fails from here on leaves a folder the next one may replace.
  writeOut(out, 'EXPORT.json', `${JSON.stringify({ kind: MARKER_KIND, incomplete: 'the export did not finish', magnusim: { repository: MAGNUSIM_URL, commit } }, null, 2)}\n`);
  const blobs = catFiles(commit, files.filter((p) => !dirty.includes(p)).map((p) => `${prefix}${p}`));
  for (const p of files) writeOut(out, `${APP_DIR}/${p}`, dirty.includes(p) ? readFileSync(join(WEB, p)) : blobs.get(`${prefix}${p}`));

  // package.json, and the lockfile pruned from Magnusim's (the same versions).
  const outWeb = join(out, APP_DIR);
  writeOut(out, `${APP_DIR}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
  writeOut(out, `${APP_DIR}/package-lock.json`, lockText);
  const npm = spawnSync('npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund', { cwd: outWeb, encoding: 'utf8', shell: true, timeout: 300_000 });
  let lockfile = "pruned from Magnusim's (npm install --package-lock-only --offline)";
  const warnings = [];
  if (npm.status !== 0) {
    writeOut(out, `${APP_DIR}/package-lock.json`, lockText);
    lockfile = "Magnusim's, copied: npm could not prune it offline (npm ci will refuse it until npm install --package-lock-only is run)";
    warnings.push(`package-lock.json: ${lockfile}\n${(npm.stderr || npm.stdout || '').trim()}`);
  } else {
    const after = JSON.parse(readFileSync(join(outWeb, 'package-lock.json'), 'utf8')).packages;
    const drift = [];
    for (const [key, e] of Object.entries(after)) {
      if (!key) continue;
      const was = magnusimLock.packages[key];
      if (!was) drift.push(`${key} ${e.version}: not in Magnusim's lockfile`);
      else if (was.version !== e.version || was.resolved !== e.resolved || was.integrity !== e.integrity) drift.push(`${key}: ${was.version} -> ${e.version}`);
    }
    if (drift.length) throw new Error(`the pruned lockfile is not Magnusim's versions:\n  ${drift.join('\n  ')}`);
    lockfile += `: ${Object.keys(after).length - 1} packages, all as in Magnusim's`;
  }

  // The new repository's root.
  const rootFiles = {
    'README.md': fixed('README.md'),
    '.gitignore': fixed('gitignore'),
    '.gitattributes': fixed('gitattributes'),
    LICENSE: source('LICENSE'),
    'THIRD_PARTY_NOTICES.md': cadNotices(source('THIRD_PARTY_NOTICES.md').toString('utf8'), fixed),
  };
  for (const [name, data] of Object.entries(rootFiles)) writeOut(out, name, data);
  const { cadSection } = await import(pathToFileURL(join(WEB, 'desktop', 'scripts', 'notices.mjs')).href);
  cadSection(join(out, 'THIRD_PARTY_NOTICES.md')); // the installer's notices need it (throws if gone)

  const all = [...Object.keys(rootFiles), 'EXPORT.json', ...[...lists.keys()].map((p) => `${APP_DIR}/${p}`)].sort();
  for (const rel of all) {
    if (rel === 'EXPORT.json' || BINARY.test(rel)) continue;
    if (readFileSync(join(out, ...rel.split('/')), 'utf8').includes('\r\n') && !/\.(bat|cmd)$/i.test(rel)) warnings.push(`${rel} has CRLF line ends as committed (the CAD repository's .gitattributes stores LF)`);
  }

  const record = {
    kind: MARKER_KIND,
    about: "A copy of Magnusim CAD's code, made by Magnusim's scripts/export-cad-repo.mjs. Code changes are made in Magnusim; this copy is refreshed from it at each release.",
    magnusim: { repository: MAGNUSIM_URL, commit, date: commitDate, ...(uncommitted.length ? { uncommitted } : {}) },
    lockfile,
    selfCheck: 'not run yet',
    lists: {
      page: 'the page: the Vite build of cad.html (modules, files it reads, its tsconfig.json)',
      server: "the server and the desktop shell: esbuild's metafile of their entries",
      'sdk-build': 'the plugin SDK and UI kit the server builds at run time',
      read: 'files the server reads by path',
      types: 'what npm run typecheck needs on top (type-only imports, ambient types)',
      tooling: "the desktop shell's installer build, the CAD plugin (source, workspace, licences, kernel and solver sources), the tsconfigs",
      export: 'written by the export',
      licence: 'licence and notices',
    },
    files: {},
  };
  const rootLists = { 'README.md': ['export'], '.gitignore': ['export'], '.gitattributes': ['export'], LICENSE: ['licence'], 'THIRD_PARTY_NOTICES.md': ['licence', 'export'], 'EXPORT.json': ['export'] };
  for (const rel of all) record.files[rel] = rootLists[rel] || [...lists.get(rel.slice(APP_DIR.length + 1))].sort();
  // One line per file, so a sync's diff of EXPORT.json reads as the files that came and went.
  const fileLines = Object.entries(record.files).map(([rel, l]) => `    ${JSON.stringify(rel)}: ${JSON.stringify(l)}`);
  const writeRecord = () => writeOut(out, 'EXPORT.json', `${JSON.stringify({ ...record, files: '<files>' }, null, 2).replace(/"files": "<files>"/, `"files": {\n${fileLines.join(',\n')}\n  }`)}\n`);
  writeRecord();

  // The self-check reads what was written (EXPORT.json too), and its counts go into EXPORT.json.
  console.log('  self-check: the written copy');
  const checked = selfCheck({ out, web: WEB, commit, prefix, appDir: APP_DIR, fromGit: rootFromGit(prefix), uncommitted });
  record.selfCheck = summary(checked);
  writeRecord();

  // Files and size per top folder.
  const sizes = new Map();
  for (const rel of all) {
    const parts = rel.split('/');
    const key = parts.length === 1 ? '(root)' : parts[0] === APP_DIR ? (parts.length === 2 ? `${APP_DIR}/(files)` : `${APP_DIR}/${parts[1]}`) : parts[0];
    const s = sizes.get(key) || { files: 0, bytes: 0 };
    s.files += 1;
    s.bytes += statSync(join(out, ...parts)).size;
    sizes.set(key, s);
  }
  let total = 0;
  for (const [key, s] of [...sizes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.log(`  ${key.padEnd(34)} ${String(s.files).padStart(5)} files ${(s.bytes / 2 ** 20).toFixed(2).padStart(8)} MiB`);
    total += s.bytes;
  }
  console.log(`  ${'total'.padEnd(34)} ${String(all.length).padStart(5)} files ${(total / 2 ** 20).toFixed(2).padStart(8)} MiB`);
  console.log(`  dependencies: ${Object.keys(pkg.dependencies).join(' ')}`);
  console.log(`  devDependencies: ${Object.keys(pkg.devDependencies).join(' ')}`);
  console.log(`  lockfile: ${lockfile}`);
  for (const w of warnings) console.warn(`  warning: ${w}`);
  if (!report(checked)) throw new Error(`the self-check failed: ${Object.values(checked.checks).reduce((n, c) => n + c.offenders.length, 0)} offenders in ${out} (above); EXPORT.json records it`);
  console.log(`Exported ${all.length} files to ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
