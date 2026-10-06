// Build, then run the e2e specs against one host server, holding .cache/build.lock for
// the whole run so no build (another e2e run, or npm run build) rewrites workspace/ mid-test.
//   node scripts/e2e.mjs [options] [playwright args...]
//     npm run test:e2e                   every spec (the full suite), parallel workers
//     npm run test:e2e -- e2e/x.spec.ts  one spec (any Playwright args pass through)
//     npm run test:e2e:<shard>           one area shard (scripts/e2e-shards.mjs): shell, sketch,
//                                        solids, step, link, big
//     npm run test:e2e:smoke             the smoke set: the tests tagged @smoke
//     npm run test:e2e:changed [-- --base <ref>]   the shards the changed files need
// Options (the rest goes to Playwright):
//   --shard a,b      only these shards (repeatable; with spec paths too: both)
//   --smoke          only the tests tagged @smoke (of the shards, when named)
//   --changed        the shards the changed files need: git status (staged, unstaged and
//                    untracked, the whole checkout), plus with --base <ref> every file that
//                    differs from HEAD's merge base with <ref>; --files a,b names the files
//                    instead (relative to where you run it, or absolute)
//   --plan           print what would run and why; run nothing
// One host server for the run: started here (e2e/host-server.mjs) unless CAD_E2E_BASE_URL names
// one; CAD_E2E_LOCK=<file> shares it with other runs (a live server named there is reused).
// Two phases on that server:
//   1. parallel: every selected test but the @serial ones, on CAD_E2E_WORKERS workers
//      (default DEFAULT_WORKERS; --workers N wins). A spec file runs in order in one worker;
//      files run side by side.
//   2. serial: the selected @serial tests, alone, on one worker. They change what every test
//      on the server sees (CAD turned off, its manifest broken) or read what every test makes
//      (Home's list of every project).
// A phase with no selected test is left out. With PLAYWRIGHT_JSON_OUTPUT_NAME set and both
// phases running, the serial phase writes <name>.serial.json beside it.
// Waits up to CAD_E2E_WAIT_MS (default 10 min) for another run's build lock.
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lock.mjs';
import { SHARD_NAMES, shardsForFiles, specsOf } from './e2e-shards.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'e2e/playwright.config.ts';

/** Workers of the parallel phase (CAD_E2E_WORKERS overrides it, CI=1 makes it 1; --workers N wins over all). */
export const DEFAULT_WORKERS = 3;

export function parseArgs(argv) {
  const o = { shards: [], smoke: false, changed: false, base: null, files: null, plan: false, pw: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [name, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => {
      const v = inline !== null ? inline : argv[++i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    if (name === '--shard') o.shards.push(...value().split(',').map((s) => s.trim()).filter(Boolean));
    else if (name === '--smoke') o.smoke = true;
    else if (name === '--changed') o.changed = true;
    else if (name === '--base') {
      o.base = value();
      o.changed = true;
    } else if (name === '--files') {
      o.files = [...(o.files || []), ...value().split(',').map((s) => s.trim()).filter(Boolean)];
      o.changed = true;
    } else if (name === '--plan') o.plan = true;
    else o.pw.push(a);
  }
  const bad = o.shards.filter((s) => !SHARD_NAMES.includes(s));
  if (bad.length) throw new Error(`no shard ${bad.join(', ')} (shards: ${SHARD_NAMES.join(', ')})`);
  return o;
}

/** Playwright args without the options named (and their values). */
export function withoutOptions(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const name = eq > 0 && a.startsWith('-') ? a.slice(0, eq) : a;
    if (!names.includes(name)) out.push(a);
    else if (eq < 0) i++; // its value is the next arg
  }
  return out;
}

/** A path from git or --files, relative to the plugin folder with '/'. */
export function toPluginRel(p, base = process.env.INIT_CWD || process.cwd()) {
  const abs = isAbsolute(p) ? p : resolve(base, p);
  const rel = relative(ROOT, abs);
  return (isAbsolute(rel) ? abs : rel).split(sep).join('/');
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Changed files (plugin-relative): git status, plus with `base` the files that differ from HEAD's merge base with it. */
export function changedFromGit(base, run = git) {
  const top = run(['rev-parse', '--show-toplevel']).trim();
  const files = new Set();
  // -z: NUL-separated; a rename is "R  new\0old\0".
  const parts = run(['status', '--porcelain=v1', '-uall', '-z']).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    files.add(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') files.add(parts[++i]);
  }
  if (base) {
    const mb = run(['merge-base', base, 'HEAD']).trim();
    for (const f of run(['diff', '--name-only', '-z', mb]).split('\0')) if (f) files.add(f);
  }
  return [...files].map((f) => toPluginRel(resolve(top, f)));
}

function hostPaths() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return (pkg.magnusim && pkg.magnusim.e2eHostPaths) || [];
}

const cli = () => join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

/** Tests a phase would run (playwright --list): 0 when none. */
function countTests(args, env) {
  const listEnv = { ...env };
  delete listEnv.PLAYWRIGHT_JSON_OUTPUT_NAME;
  const listArgs = [...withoutOptions(args, ['--reporter', '--workers', '-j', '--retries']), '--list', '--reporter=list'];
  const r = spawnSync(process.execPath, [cli(), 'test', '-c', CONFIG, ...listArgs], { cwd: ROOT, env: listEnv, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /Total: (\d+) tests? in \d+ files?/.exec(out);
  if (m) return Number(m[1]);
  if (/No tests found/i.test(out)) return 0;
  throw new Error(`playwright --list failed (exit ${r.status}):\n${out.slice(-4000)}`);
}

/**
 * What to run: {shards, specs (null: every spec), why: {shard: files}, none, nothing}.
 * `changed` is the changed files (plugin-relative) when o.changed.
 */
export function planRun(o, changed = [], host = hostPaths()) {
  const why = {};
  let shards = [...o.shards];
  if (o.changed) {
    const plan = shardsForFiles(changed, host);
    for (const [s, files] of Object.entries(plan.why)) why[s] = files;
    shards = SHARD_NAMES.filter((s) => shards.includes(s) || plan.shards.includes(s));
    if (!shards.length) return { shards, specs: [], why, none: plan.none, nothing: true };
    // Every shard: the full suite (the opt-in shard's tests skip without their file).
    const everyShard = SHARD_NAMES.filter((s) => s !== 'big').every((s) => shards.includes(s));
    return { shards, specs: everyShard ? null : specsOf(shards), why, none: plan.none, nothing: false };
  }
  return { shards, specs: shards.length ? specsOf(shards) : null, why, none: [], nothing: false };
}

/**
 * The Playwright args of a run: the shard specs first, because an option such as --project takes
 * every value up to the next option (`--project chromium e2e/a.spec.ts` names two projects).
 */
export function playwrightArgs(o, plan) {
  return [...(plan.specs || []), ...o.pw];
}

function describe(o, plan, files) {
  const lines = [];
  const few = (list) => (list.length > 4 ? `${list.slice(0, 4).join(', ')} (+${list.length - 4} more)` : list.join(', '));
  if (o.changed) lines.push(`[cad-e2e] ${files.length} changed file(s)`);
  if (plan.nothing) lines.push('[cad-e2e] no shard needs them: nothing to run');
  else if (plan.specs === null) lines.push(`[cad-e2e] ${o.changed ? 'every shard: ' : ''}the full suite${o.smoke ? ', smoke tests only' : ''}`);
  else lines.push(`[cad-e2e] shards ${plan.shards.join(', ')}${o.smoke ? ', smoke tests only' : ''}`);
  for (const [s, f] of Object.entries(plan.why)) lines.push(`  ${s} <- ${few(f)}`);
  if (plan.none.length) lines.push(`  not run for: ${few(plan.none.map((n) => `${n.file} (${n.why})`))}`);
  if (plan.shards.includes('big') && !process.env.CAD_E2E_BIG_STEP) lines.push('  big: its tests skip without CAD_E2E_BIG_STEP');
  return lines.join('\n');
}

async function main(argv) {
  const o = parseArgs(argv);
  let files = [];
  if (o.changed) {
    if (o.files) files = o.files.map((f) => toPluginRel(f));
    else {
      try {
        files = changedFromGit(o.base);
      } catch (err) {
        console.error(`[cad-e2e] git could not list the changed files (not a git checkout?): name them with --files a,b,c\n${err.message}`);
        return 2;
      }
    }
  }
  const plan = planRun(o, files);
  if (o.changed || o.shards.length || o.smoke || o.plan) console.log(describe(o, plan, files));
  if (plan.nothing) return 0;
  const pwArgs = playwrightArgs(o, plan);
  if (o.plan) {
    console.log(`[cad-e2e] playwright test ${pwArgs.join(' ')}`);
    return 0;
  }

  const release = await acquireLock(join(ROOT, '.cache', 'build.lock'), Number(process.env.CAD_E2E_WAIT_MS || 600_000));
  let stopServer = () => {};
  try {
    const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CAD_BUILD_LOCK_HELD: String(process.pid) } });
    if (b.status !== 0) return b.status ?? 1;
    const env = { ...process.env, ...(o.smoke ? { CAD_E2E_SMOKE: '1' } : {}) };
    // --list, --help and the like: one plain Playwright call.
    if (o.pw.some((a) => ['--list', '--help', '-h', '--version', '-V'].includes(a))) {
      return spawnSync(process.execPath, [cli(), 'test', '-c', CONFIG, ...pwArgs], { cwd: ROOT, stdio: 'inherit', env }).status ?? 1;
    }
    const serialArgs = [...withoutOptions(pwArgs, ['--workers', '-j']), '--workers=1'];
    const nParallel = countTests(pwArgs, { ...env, CAD_E2E_PHASE: 'parallel' });
    const nSerial = countTests(serialArgs, { ...env, CAD_E2E_PHASE: 'serial' });
    if (!nParallel && !nSerial) {
      console.error('[cad-e2e] no tests found for that selection');
      return 1;
    }
    // CI (CI=1) keeps one worker until its job sets CAD_E2E_WORKERS: a 4-core runner is not this PC.
    const workers = Number(process.env.CAD_E2E_WORKERS) || (process.env.CI ? 1 : DEFAULT_WORKERS);
    console.log(`[cad-e2e] ${nParallel} test(s) in parallel on ${workers} workers (unless --workers says otherwise), then ${nSerial} @serial test(s) alone`);

    // One host server for both phases.
    if (!env.CAD_E2E_BASE_URL) {
      const { restoreManifestIfLeft } = await import('../e2e/manifest-guard.mjs');
      if (restoreManifestIfLeft()) console.log('[cad-e2e] restored manifest.toml left broken by a stopped run');
      const { startHostServer } = await import('../e2e/host-server.mjs');
      const server = await startHostServer({ log: (m) => console.log(`[cad-e2e] ${m}`) });
      stopServer = () => server.stop();
      process.once('SIGINT', () => {
        stopServer();
        process.exit(130);
      });
      env.CAD_E2E_BASE_URL = server.base;
      if (server.prefs) env.CAD_E2E_PREFS = server.prefs;
    }
    const run = (phase, args, extraEnv = {}) => {
      const t0 = Date.now();
      console.log(`\n[cad-e2e] ${phase} phase: playwright test ${args.join(' ')}`);
      const s = spawnSync(process.execPath, [cli(), 'test', '-c', CONFIG, ...args], { cwd: ROOT, stdio: 'inherit', env: { ...env, CAD_E2E_PHASE: phase, CAD_E2E_WORKERS: String(workers), ...extraEnv } }).status ?? 1;
      console.log(`[cad-e2e] ${phase} phase: ${s === 0 ? 'passed' : 'FAILED'} in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
      return s;
    };
    let code = 0;
    if (nParallel) code = run('parallel', pwArgs) || code;
    if (nSerial) {
      const json = env.PLAYWRIGHT_JSON_OUTPUT_NAME;
      const extra = json && nParallel ? { PLAYWRIGHT_JSON_OUTPUT_NAME: json.replace(/(\.json)?$/i, '.serial.json') } : {};
      code = run('serial', serialArgs, extra) || code;
    }
    return code;
  } finally {
    stopServer();
    release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`[cad-e2e] ${err.message}`);
  }
  process.exit(code);
}
