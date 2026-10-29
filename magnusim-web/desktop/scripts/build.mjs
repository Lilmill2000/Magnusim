// Builds Magnusim CAD's Windows installer (npm run dist in desktop/):
//   0. Electron's runtime, fetched when it is not there yet (electronRuntime);
//   1. the page: cad.html built by Vite into the app's page/;
//   2. the app, staged in build/app: the desktop shell, the server's source (scripts/, src/,
//      bundled-plugins/cad's manifest, workspace and licences) and only the npm packages the
//      server loads (no Python, nothing of the simulation's runtime);
//   3. THIRD_PARTY_NOTICES.txt from the lockfiles (notices.mjs; a bad licence fails the build);
//   4. the icon (icon.mjs); 5. electron-builder: an unsigned per-user NSIS installer in dist/;
//   6. the size budget (SIZE_BUDGET): over it, the build fails.
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cadSection, licenceRows, noticesText, productionPackages } from './notices.mjs';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(DESKTOP, '..');
const REPO = join(WEB, '..');
const BUILD = join(DESKTOP, 'build');
const APP = join(BUILD, 'app');
const DIST = join(DESKTOP, 'dist');
const REPO_URL = 'https://github.com/Lilmill2000/Magnusim';
/** The Magnusim CAD repository: a copy of this app's code, made by Magnusim's scripts/export-cad-repo.mjs. */
export const CAD_REPO_URL = 'https://github.com/Lilmill2000/Magnusim-CAD';
/** The kind of the EXPORT.json that copy has at its root. */
const EXPORT_KIND = 'magnusim-cad-export';

/** A development snapshot's label in EXPORT.json (scripts/export-cad-repo.mjs --dev). */
const DEV_LABEL = /^development version \S+ \(\d{4}-\d{2}-\d{2}\)$/;

/**
 * Where the installer says its source is. In Magnusim: Magnusim's repository at this checkout's
 * HEAD (no commit outside a checkout). In the Magnusim CAD repository, whose EXPORT.json (at the
 * root, one level above magnusim-web/) says what its code was copied from: that repository, and
 * what in Magnusim, since a copy's own commits are not Magnusim's. A development snapshot
 * (magnusim.public false: its commit is not published, and its record has none) is named by its
 * label, "development version <version> (<date>)", and no commit; a release export by its
 * commit, with its release tag (the label) when it has one.
 */
export function sourceOf(repoRoot) {
  let record = null;
  try {
    record = JSON.parse(readFileSync(join(repoRoot, 'EXPORT.json'), 'utf8'));
  } catch {
    /* no copy's record: Magnusim itself */
  }
  if (record && record.kind === EXPORT_KIND) {
    const m = record.magnusim || {};
    const dev = m.public === false;
    if (!dev && !/^[0-9a-f]{40}$/.test(String(m.commit))) throw new Error(`${join(repoRoot, 'EXPORT.json')} names no Magnusim commit`);
    if (record.incomplete || (record.selfCheck !== undefined && record.selfCheck?.passed !== true)) throw new Error(`${join(repoRoot, 'EXPORT.json')}: the export that wrote this copy did not finish, or failed its self-check`);
    if (dev && !DEV_LABEL.test(String(m.label))) throw new Error(`${join(repoRoot, 'EXPORT.json')}: a development snapshot without its label ("development version <version> (<date>)")`);
    const changed = Array.isArray(m.uncommitted) ? m.uncommitted.length : 0;
    return { repo: CAD_REPO_URL, commit: '', copiedFrom: { repo: m.repository || REPO_URL, label: typeof m.label === 'string' ? m.label : '', commit: dev ? '' : m.commit, changed } };
  }
  let commit = '';
  try {
    // Its "fatal: not a git repository" (a folder that is no checkout) is not shown: the notices then name no commit.
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* not a checkout */
  }
  return { repo: REPO_URL, commit, copiedFrom: null };
}

/**
 * Electron's runtime, node_modules/electron/dist, where the icon and electron-builder take it
 * from. Electron 44 fetches it on its first require('electron'), not at npm ci, so a fresh
 * install has none: its install.js fetches this version when it is missing (from Electron's
 * download cache when it is there) and does nothing when it is installed already.
 */
function electronRuntime() {
  const pkg = join(DESKTOP, 'node_modules', 'electron');
  const r = spawnSync(process.execPath, [join(pkg, 'install.js')], { stdio: 'inherit', timeout: 600_000 });
  const pathFile = join(pkg, 'path.txt');
  const exe = existsSync(pathFile) ? join(pkg, 'dist', readFileSync(pathFile, 'utf8').trim()) : '';
  if (r.status !== 0 || !exe || !existsSync(exe)) throw new Error(`Electron's runtime is not in ${join(pkg, 'dist')} (node_modules/electron/install.js: exit ${r.status ?? r.signal})`);
  return exe;
}

/**
 * The most the installer and the installed app may take (plan §7); the build fails above it.
 * Measured 2026-10-27: Electron 44's own runtime is 321 MiB installed, the app's files 70 MiB
 * (CAD's workspace 25, the server's npm packages about 40); the installer 122 MB.
 */
export const SIZE_BUDGET = { installerMB: 130, installedMB: 400 };

/**
 * The npm packages the server loads, with what they need (the rest of the app's are bundled
 * into the page): the Assistant's provider and tool-connection packages, as its one loader names
 * them (providers/load-sdk.ts), React (the plugin SDK reads its export names) and esbuild (it
 * builds the plugin SDK). The plugin SDK's own packages (sdkPackages) come on top: only the files
 * esbuild bundles into it, so vtk.js comes without its build tools.
 */
async function serverPackages() {
  const sdk = await import(pathToFileURL(join(WEB, 'scripts', 'server', 'assistant', 'providers', 'load-sdk.ts')).href);
  return [...sdk.SDK_NAMES, sdk.MCP_SDK_NAME, 'react', 'react-dom', 'esbuild'];
}

const desktopPkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
const t0 = Date.now();
const step = (what) => console.log(`[build ${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

/** Those packages and every package they need, as the root lockfile resolves them (folder paths). */
function serverClosure(roots) {
  const lock = JSON.parse(readFileSync(join(WEB, 'package-lock.json'), 'utf8')).packages;
  const platform = `@esbuild/${process.platform}-${process.arch}`;
  const keep = new Set();
  const visit = (key) => {
    if (keep.has(key) || !lock[key]) return;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (name.startsWith('@esbuild/') && name !== platform) return;
    keep.add(key);
    const e = lock[key];
    for (const dep of [...Object.keys(e.dependencies || {}), ...Object.keys(e.optionalDependencies || {}), ...Object.keys(e.peerDependencies || {})]) {
      // Node's own resolution: the package's nested copy, else the nearest one above it.
      let base = key;
      for (;;) {
        const candidate = `${base}/node_modules/${dep}`;
        if (lock[candidate]) {
          visit(candidate);
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
  for (const p of roots) visit(`node_modules/${p}`);
  // A nested copy comes with its parent's folder: only the outermost ones are copied.
  return [...keep].filter((k) => ![...keep].some((o) => o !== k && k.startsWith(`${o}/`))).sort();
}

const notTest = (src) => !/[\\/]__tests__([\\/]|$)|\.test\.[cm]?[jt]sx?$|[\\/]\.cache([\\/]|$)/.test(src);

/** In an npm package: what runs (no types, source maps, readme or dotfiles; its licence stays). */
const runtimeFile = (src) => notTest(src) && !/\.(d\.[cm]?ts|[cm]?ts|map)$|[\\/](readme|changelog|history)(\.[a-z]+)?$|[\\/]\.[^\\/]+$/i.test(src);

/** The folders (root lockfile keys) of the packages esbuild bundles into the plugin SDK and its UI kit. */
async function sdkPackages() {
  const sdk = await import(pathToFileURL(join(WEB, 'scripts', 'server', 'sdk-build.ts')).href);
  const kit = await sdk.bundle(WEB, "export * from './src/plugin-ui/index.ts';", 'prod', 'ts', { external: sdk.KIT_EXTERNAL });
  const bridge = await sdk.bundle(WEB, readFileSync(join(WEB, 'src', 'plugin-sdk', 'workspace.ts'), 'utf8'), 'prod', 'ts');
  const keys = new Set();
  for (const m of [kit.metafile, bridge.metafile]) {
    for (const input of Object.keys(m.inputs)) {
      const hit = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'));
      if (hit) keys.add(hit[1]);
    }
  }
  return [...keys].sort();
}

async function stage(source) {
  rmSync(BUILD, { recursive: true, force: true, maxRetries: 5 });
  mkdirSync(APP, { recursive: true });
  for (const dir of ['scripts', 'src']) cpSync(join(WEB, dir), join(APP, dir), { recursive: true, filter: notTest });
  const cad = join(WEB, 'bundled-plugins', 'cad');
  for (const part of ['manifest.toml', 'plugin.py', 'README.md', 'workspace', 'LICENSES']) cpSync(join(cad, part), join(APP, 'bundled-plugins', 'cad', part), { recursive: true });
  for (const f of ['main.mjs', 'config.mjs', 'server.mjs', 'server-log.mjs']) cpSync(join(DESKTOP, f), join(APP, 'desktop', f));
  const modules = [...new Set([...serverClosure(await serverPackages()), ...(await sdkPackages())])].sort();
  for (const key of modules) cpSync(join(WEB, key), join(APP, key), { recursive: true, filter: runtimeFile });
  // electron-builder ships the node_modules its package.json's dependencies name: each
  // top-level copied package, at the version copied.
  const dependencies = Object.fromEntries(
    modules
      .filter((key) => key.split('/node_modules/').length === 1)
      .map((key) => {
        const name = key.slice('node_modules/'.length);
        return [name, JSON.parse(readFileSync(join(WEB, key, 'package.json'), 'utf8')).version];
      })
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  writeFileSync(
    join(APP, 'package.json'),
    `${JSON.stringify(
      {
        name: desktopPkg.name,
        productName: desktopPkg.productName,
        version: desktopPkg.version,
        description: desktopPkg.description,
        license: desktopPkg.license,
        author: desktopPkg.author,
        homepage: source.repo,
        private: true,
        type: 'module',
        main: 'desktop/main.mjs',
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  cpSync(join(REPO, 'LICENSE'), join(APP, 'LICENSE'));
  return modules.length;
}

async function page() {
  const req = createRequire(join(WEB, 'package.json'));
  const { build } = await import(pathToFileURL(req.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(req.resolve('@vitejs/plugin-react')).href);
  const out = join(APP, 'page');
  await build({
    configFile: false,
    root: WEB,
    logLevel: 'warn',
    plugins: [react()],
    build: { outDir: out, emptyOutDir: true, chunkSizeWarningLimit: 10_000, rollupOptions: { input: join(WEB, 'cad.html') } },
  });
  renameSync(join(out, 'cad.html'), join(out, 'index.html'));
}

function notices(source) {
  const packages = [
    ...productionPackages(join(WEB, 'package-lock.json'), join(WEB, 'node_modules')),
    ...productionPackages(join(WEB, 'bundled-plugins', 'cad', 'package-lock.json'), join(WEB, 'bundled-plugins', 'cad', 'node_modules')),
  ];
  const rows = licenceRows(packages);
  const electron = JSON.parse(readFileSync(join(DESKTOP, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  writeFileSync(join(APP, 'THIRD_PARTY_NOTICES.txt'), noticesText({ version: desktopPkg.version, ...source, cad: cadSection(join(REPO, 'THIRD_PARTY_NOTICES.md')), rows, electron }));
  return rows.length;
}

function icon(exe) {
  const out = join(BUILD, 'icon.png');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(exe, [join(DESKTOP, 'scripts', 'icon.mjs'), out], { env, stdio: 'inherit', timeout: 60_000 });
  if (r.status !== 0 || !existsSync(out)) throw new Error('the icon was not drawn');
}

/**
 * The staged app, before it is packaged: its plugin SDK builds from what was staged, and its
 * server starts (the built page, no Python), answers the page, the plugin list, CAD's
 * workspace and the SDK, and keeps its log (server-log.mjs, through the Assistant's redact as
 * staged). A package left out fails here, not in a person's app.
 */
async function checkStaged() {
  const sdk = spawnSync(process.execPath, ['--input-type=module', '-e', "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); const files = await m.buildPluginSdk(process.argv[2], 'prod'); console.log([...files.keys()].join(' '));", join(APP, 'scripts', 'server', 'plugin-sdk.ts'), APP], { encoding: 'utf8', timeout: 120_000 });
  if (sdk.status !== 0) throw new Error(`the staged app's plugin SDK does not build:\n${sdk.stderr || sdk.stdout}`);
  const root = join(BUILD, 'check');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'projects'), { recursive: true });
  const env = { ...process.env, MAGNUSIM_PROJECTS_ROOT: join(root, 'projects'), MAGNUSIM_LOCAL_JSON: join(root, 'local.json'), MAGNUSIM_ASSISTANT_HOME: join(root, 'assistant'), MAGNUSIM_PYTHON: join(root, 'no-python.exe'), MAGNUSIM_SERVER_LOG: join(root, 'logs', 'server.log') };
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(APP, 'desktop', 'server.mjs'), '--static', join(APP, 'page')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`the staged server did not start:\n${said}`)), 60_000);
      const hear = (d) => {
        said += String(d);
        const m = / on (\d+)\s*$/m.exec(said);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      };
      child.stdout.on('data', hear);
      child.stderr.on('data', hear);
      child.once('exit', (code) => reject(new Error(`the staged server stopped (${code}):\n${said}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    for (const path of ['/', '/api/plugins', '/plugins/cad/workspace/index.html', '/plugin-sdk/plugin-ui.js', '/plugin-sdk/workspace.js']) {
      const r = await fetch(base + path);
      if (!r.ok) throw new Error(`the staged server answered ${r.status} for ${path}`);
    }
    const kept = existsSync(env.MAGNUSIM_SERVER_LOG) ? readFileSync(env.MAGNUSIM_SERVER_LOG, 'utf8') : '';
    if (!kept.includes(`server listening on 127.0.0.1:${port}`)) throw new Error(`the staged server kept no log in ${env.MAGNUSIM_SERVER_LOG}:\n${said}`);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
  return sdk.stdout.trim().split(' ').length;
}

function folderBytes(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? folderBytes(p) : statSync(p).size;
  }
  return total;
}

async function installer() {
  const req = createRequire(join(DESKTOP, 'package.json'));
  const { build, Platform, Arch } = await import(pathToFileURL(req.resolve('electron-builder')).href);
  rmSync(DIST, { recursive: true, force: true, maxRetries: 5 });
  // Windows' scanner can hold the freshly copied exe while electron-builder edits it (EBUSY): try again.
  for (let attempt = 1; ; attempt++) {
    try {
      await buildOnce(build, Platform, Arch);
      return;
    } catch (err) {
      if (attempt >= 3 || !/EBUSY|EPERM/.test(String(err && err.message))) throw err;
      step(`installer: ${String(err.message).split(/\r?\n/)[0]}; again in 10 s`);
      await new Promise((r) => setTimeout(r, 10_000));
      rmSync(DIST, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}

async function buildOnce(build, Platform, Arch) {
  await build({
    projectDir: DESKTOP,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    // The runtime electronRuntime() made sure of (no second download).
    config: { ...JSON.parse(readFileSync(join(DESKTOP, 'electron-builder.json'), 'utf8')), electronDist: join(DESKTOP, 'node_modules', 'electron', 'dist') },
    publish: 'never',
  });
}

function sizes() {
  const exe = readdirSync(DIST).find((f) => /^Magnusim-CAD-Setup-.*\.exe$/.test(f));
  if (!exe) throw new Error('no installer in dist/');
  const installerMB = statSync(join(DIST, exe)).size / 2 ** 20;
  const installedMB = folderBytes(join(DIST, 'win-unpacked')) / 2 ** 20;
  const line = `installer ${installerMB.toFixed(1)} MB (budget ${SIZE_BUDGET.installerMB}), installed ${installedMB.toFixed(1)} MB (budget ${SIZE_BUDGET.installedMB})`;
  writeFileSync(join(DIST, 'size.json'), `${JSON.stringify({ installer: exe, installerMB: +installerMB.toFixed(1), installedMB: +installedMB.toFixed(1), budget: SIZE_BUDGET }, null, 2)}\n`);
  if (installerMB > SIZE_BUDGET.installerMB || installedMB > SIZE_BUDGET.installedMB) throw new Error(`over the size budget: ${line}`);
  return line;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    step('Electron runtime');
    const electronExe = electronRuntime();
    const source = sourceOf(REPO);
    step(`staging the app: ${await stage(source)} npm packages for the server`);
    step('page');
    await page();
    step(`staged app checked: its plugin SDK (${await checkStaged()} files) and its server`);
    const from = source.copiedFrom;
    step(`notices: ${notices(source)} npm packages, source ${from ? `${source.repo} (Magnusim${from.label ? ` ${from.label}` : ''}${from.commit ? ` ${from.commit.slice(0, 10)}` : ''})` : `${source.repo}${source.commit ? ` at ${source.commit.slice(0, 10)}` : ''}`}`);
    step('icon');
    icon(electronExe);
    step('installer');
    await installer();
    step(sizes());
    console.log(`Built ${relative(WEB, DIST).split(sep).join('/')}/`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
