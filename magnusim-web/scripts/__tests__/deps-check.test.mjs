// A copy installed by an older release lacks the packages a newer one added, and
// run.bat and Setup.ps1 once looked only for vite (and vtk.js) before they skipped
// the install. scripts/deps-check.mjs answers instead: exit 1 when a "dependencies"
// key is missing from node_modules or differs from its lockfile version. run.bat
// still stops when the very first install fails; a later update uses
// npm install --no-save (never npm ci, which empties node_modules first) and the app
// starts even when that fails offline.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(WEB, 'scripts', 'deps-check.mjs');
const SETUP = join(WEB, 'setup', 'Setup.ps1');

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * A web folder in a temp dir: package.json with `deps` (and `devDeps`), a lockfile
 * recording `locked` (name -> version; null: an entry with no version, as a link has;
 * no `locked`: no lockfile), and node_modules holding `installed` (name -> its
 * package.json, an object or raw text).
 */
function webFolder({ deps, devDeps = {}, locked, installed }) {
  const root = mkdtempSync(join(tmpdir(), 'deps-check-'));
  temps.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'web', dependencies: deps, devDependencies: devDeps }, null, 2));
  if (locked) {
    const packages = { '': { name: 'web', dependencies: deps, devDependencies: devDeps } };
    for (const [name, version] of Object.entries(locked)) {
      packages[`node_modules/${name}`] = version === null ? { resolved: `../${name}`, link: true } : { version, license: 'MIT' };
    }
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'web', lockfileVersion: 3, requires: true, packages }, null, 2));
  }
  for (const [name, pkg] of Object.entries(installed)) {
    const dir = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  }
  return root;
}

/** Run deps-check.mjs on `root` (no root: as run.bat and Setup.ps1 run it, by its own place). */
function check(root, script = SCRIPT) {
  const r = spawnSync(process.execPath, root ? [script, root] : [script], { encoding: 'utf8', cwd: tmpdir() });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const DEPS = { 'pad-left': '^1.0.0', '@acme/kit': '2.0.0', 'gated-exports': '^3.0.0' };
const LOCKED = { 'pad-left': '1.2.0', '@acme/kit': '2.0.0', 'gated-exports': '3.1.0' };
const INSTALLED = {
  'pad-left': { name: 'pad-left', version: '1.2.0' },
  '@acme/kit': { name: '@acme/kit', version: '2.0.0' },
  // An exports map without ./package.json, and no main file: require.resolve can't find it.
  'gated-exports': { name: 'gated-exports', version: '3.1.0', main: 'missing.js', exports: { '.': './missing.js' } },
};

describe('deps-check.mjs', () => {
  it('every dependency in node_modules at its lockfile version: exit 0 (scoped names, an exports map without ./package.json)', () => {
    const r = check(webFolder({ deps: DEPS, devDeps: { 'dev-only': '^1.0.0' }, locked: LOCKED, installed: INSTALLED }));
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out, '');
  });

  it('a dependency missing from node_modules: exit 1, named with its lockfile version', () => {
    const installed = { ...INSTALLED };
    delete installed['@acme/kit'];
    const r = check(webFolder({ deps: DEPS, locked: LOCKED, installed }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^@acme\/kit is not installed \(the lockfile has 2\.0\.0\)$/m);
  });

  it('a dependency at another version than the lockfile records: exit 1, even inside package.json\'s range', () => {
    const r = check(webFolder({ deps: DEPS, locked: LOCKED, installed: { ...INSTALLED, 'pad-left': { name: 'pad-left', version: '1.1.0' } } }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^pad-left is 1\.1\.0, the lockfile has 1\.2\.0$/m);
  });

  it('an installed package.json that does not read counts as missing', () => {
    const r = check(webFolder({ deps: DEPS, locked: LOCKED, installed: { ...INSTALLED, 'gated-exports': '{ not json' } }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^gated-exports is not installed/m);
  });

  it('a lockfile entry with no version (a link), or no lockfile: the package only has to be there', () => {
    const linked = { ...LOCKED, 'pad-left': null };
    assert.equal(check(webFolder({ deps: DEPS, locked: linked, installed: INSTALLED })).code, 0);
    assert.equal(check(webFolder({ deps: DEPS, installed: INSTALLED })).code, 0);
    const installed = { ...INSTALLED };
    delete installed['pad-left'];
    const r = check(webFolder({ deps: DEPS, installed }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^pad-left is not installed$/m);
  });

  it('a package.json that does not read: exit 1', () => {
    const root = webFolder({ deps: DEPS, locked: LOCKED, installed: INSTALLED });
    writeFileSync(join(root, 'package.json'), '{');
    const r = check(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /package\.json can't be read/);
  });

  it('with no folder given it checks the one above the script, wherever it is run from', () => {
    const installed = { ...INSTALLED };
    delete installed['pad-left'];
    const root = webFolder({ deps: DEPS, locked: LOCKED, installed });
    mkdirSync(join(root, 'scripts'));
    const copy = join(root, 'scripts', 'deps-check.mjs');
    copyFileSync(SCRIPT, copy);
    const r = check(null, copy);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^pad-left is not installed/m);
  });
});

describe('run.bat brings the packages up to date', () => {
  const lines = readFileSync(join(WEB, 'run.bat'), 'utf8').split(/\r?\n/);
  const viteAt = lines.indexOf('if not exist "node_modules\\vite" (');
  const viteEnd = lines.indexOf(')', viteAt);

  it('the first install (no node_modules\\vite) still stops on failure', () => {
    assert.ok(viteAt >= 0 && viteEnd > viteAt, 'the node_modules\\vite block');
    const block = lines.slice(viteAt, viteEnd + 1).join('\n');
    assert.match(block, /^\s*call npm install$/m);
    assert.match(block, /^\s*if errorlevel 1 \($/m);
    assert.match(block, /^\s*exit \/b 1$/m);
  });

  it('after it, deps-check.mjs; on a miss npm install --no-save (never npm ci), and no exit when that fails', () => {
    const at = lines.flatMap((l, i) => (/deps-check\.mjs/.test(l) && !/^\s*REM\b/i.test(l) ? [i] : []));
    assert.equal(at.length, 1, 'one deps-check line');
    const line = lines[at[0]];
    const dev = lines.indexOf('call npm run dev');
    assert.ok(at[0] > viteEnd && at[0] < dev, 'after the vite block, before the server starts');
    assert.match(line, /^node scripts\\deps-check\.mjs >nul 2>&1 \|\| \(/);
    assert.ok(existsSync(join(WEB, 'scripts', 'deps-check.mjs')));
    const onMiss = line.slice(line.indexOf('||'));
    assert.match(onMiss, /\bcall npm install --no-save\b/);
    assert.doesNotMatch(line, /\bnpm ci\b/);
    assert.doesNotMatch(onMiss, /\b(exit|pause|goto)\b/i);
    // npm install's own failure only says so.
    assert.match(onMiss, /--no-fund \|\| echo [^&|()]+\)$/);
  });
});

/** Install-NpmPackages's text, from Setup.ps1. */
function installNpmPackages() {
  const ps = readFileSync(SETUP, 'utf8');
  const start = ps.indexOf('function Install-NpmPackages {');
  assert.ok(start >= 0, 'Install-NpmPackages in Setup.ps1');
  const end = ps.indexOf('\nfunction ', start + 1);
  return ps.slice(start, end < 0 ? undefined : end);
}

describe('Setup.ps1 Install-NpmPackages', () => {
  it('asks deps-check.mjs before it skips npm ci (vtk.js alone no longer decides)', () => {
    const body = installNpmPackages();
    const asked = body.indexOf('deps-check.mjs');
    const skip = body.indexOf("Write-Ok 'npm packages already installed'");
    const ci = body.indexOf('npm.cmd ci');
    assert.ok(asked > 0 && skip > asked && ci > skip, 'deps-check, then the skip, then npm ci');
    assert.match(body.slice(asked, skip), /\$LASTEXITCODE -eq 0/);
    assert.doesNotMatch(body, /vtk\.js\\package\.json/);
  });

  /** Windows PowerShell, else none: Setup.ps1 is for Windows (as setup-elevation.test.mjs). */
  const PS =
    process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0
      ? 'powershell.exe'
      : null;

  it('as Setup.ps1 has it: skips with every package in place, else npm ci (npm a stand-in)', { skip: PS ? false : 'Setup runs on Windows only' }, () => {
    const viteAt = { vite: { name: 'vite', version: '6.0.0' } };
    const roots = {
      ready: webFolder({ deps: DEPS, locked: LOCKED, installed: { ...INSTALLED, ...viteAt } }),
      missing: webFolder({ deps: DEPS, locked: LOCKED, installed: { 'pad-left': INSTALLED['pad-left'], ...viteAt } }),
      noVite: webFolder({ deps: DEPS, locked: LOCKED, installed: INSTALLED }),
    };
    for (const root of Object.values(roots)) {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(SCRIPT, join(root, 'scripts', 'deps-check.mjs'));
    }
    const run = join(roots.ready, 'run.ps1');
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    writeFileSync(
      run,
      [
        '$ErrorActionPreference = "Stop"',
        `$errs = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SETUP)}, [ref]$null, [ref]$errs)`,
        'if ($errs.Count) { throw "Setup.ps1 does not parse: $($errs[0].Message)" }',
        "foreach ($name in 'Install-NpmPackages', 'Test-Cmd') {",
        '  $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1',
        '  if (-not $fn) { throw "no $name in Setup.ps1" }',
        '  . ([scriptblock]::Create($fn.Extent.Text))',
        '}',
        'function Write-Ok([string]$m) { [Console]::Out.WriteLine("OK $m") }',
        'function Write-Step([string]$m) { [Console]::Out.WriteLine("STEP $m") }',
        'function npm.cmd { [Console]::Out.WriteLine("NPM $args"); $global:LASTEXITCODE = 0 }',
        ...Object.entries(roots).map(([k, root]) => `[Console]::Out.WriteLine('== ${k}'); $WebRoot = ${q(root)}; Install-NpmPackages`),
      ].join('\r\n'),
    );
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', run], { encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    const part = (k) => out.split(`== ${k}`)[1].split('== ')[0];
    assert.match(part('ready'), /OK npm packages already installed/);
    assert.doesNotMatch(part('ready'), /NPM /);
    assert.match(part('missing'), /@acme\/kit is not installed/);
    assert.match(part('missing'), /STEP Installing web app packages \(npm ci\)[\s\S]*NPM ci --no-fund --no-audit/);
    assert.doesNotMatch(part('missing'), /already installed/);
    assert.match(part('noVite'), /NPM ci --no-fund --no-audit/);
    assert.doesNotMatch(part('noVite'), /already installed/);
  });
});
