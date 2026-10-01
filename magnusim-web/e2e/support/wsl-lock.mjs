// One browser-test run with real WSL meshes and solves at a time on this PC. Two at
// once share WSL's CPU and each takes about twice as long (and the long solves time
// out), so a second run waits here for the first, saying who holds the lock.
// The lock file holds {pid, at, cwd, what}; a lock whose process is gone is stale.
// MAGNUSIM_E2E_LOCK=0 skips the lock; MAGNUSIM_E2E_LOCK_WAIT_MS bounds the wait
// (default 4 h); MAGNUSIM_E2E_LOCK_FILE moves the file (tests).
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** Shared by every checkout and snapshot of this user (not the per-session temp folder). */
export function wslLockFile() {
  if (process.env.MAGNUSIM_E2E_LOCK_FILE) return resolve(process.env.MAGNUSIM_E2E_LOCK_FILE);
  const root = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Magnusim') : join(homedir(), '.cache', 'magnusim');
  return join(root, 'e2e-wsl.lock');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readHolder(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Wait (bounded) for the lock and return release(). Throws after waitMs.
 * `log` gets one line when the wait starts and one a minute after that.
 */
export async function acquireWslLock({ file = wslLockFile(), waitMs = Number(process.env.MAGNUSIM_E2E_LOCK_WAIT_MS) || 4 * 3600_000, what = '', log = console.log } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const started = Date.now();
  let lastSaid = 0;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), cwd: process.cwd(), what }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readHolder(file);
      if (holder && holder.pid && !alive(holder.pid)) {
        try {
          unlinkSync(file);
        } catch {
          /* someone else cleared it */
        }
        continue;
      }
      if (!holder) {
        // Being written right now, or left empty by a crash mid-write: give it a moment.
        if (Date.now() - started > 10_000) {
          try {
            unlinkSync(file);
          } catch {
            /* gone */
          }
        }
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const waited = Date.now() - started;
      if (waited > waitMs) {
        throw new Error(`Another browser-test run with WSL still holds ${file} after ${Math.round(waited / 60_000)} min: pid ${holder.pid} in ${holder.cwd} (${holder.what}) since ${holder.at}. Set MAGNUSIM_E2E_LOCK=0 to run anyway.`);
      }
      if (!lastSaid || Date.now() - lastSaid >= 60_000) {
        log(`[e2e] waiting for the WSL test lock (${Math.round(waited / 60_000)} min so far): pid ${holder.pid} in ${holder.cwd} (${holder.what}) holds it since ${holder.at}`);
        lastSaid = Date.now();
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (lastSaid) log(`[e2e] got the WSL test lock after ${Math.round((Date.now() - started) / 60_000)} min`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    if (readHolder(file)?.pid === process.pid) {
      try {
        unlinkSync(file);
      } catch {
        /* gone */
      }
    }
  };
  process.once('exit', release);
  return release;
}

const WSL_SPEC = /\bNO_WSL\b|\bNO_HEAVY\b|MAGNUSIM_E2E_WSL|MAGNUSIM_E2E_HEAVY|toolchain\.wsl\b/;
// Options of `playwright test` that take a value (so the next word is not a file filter).
const VALUE_OPTIONS = new Set([
  '--add-reporter', '--browser', '-c', '--config', '-g', '--grep', '-G', '--grep-invert', '--global-timeout',
  '-j', '--workers', '--last-failed-file', '--max-failures', '--output', '--repeat-each', '--reporter', '--retries',
  '--run-agents', '--shard', '--test-list', '--test-list-invert', '--timeout', '--trace', '--tsconfig', '--ui-host',
  '--ui-port', '--update-source-method',
]);
// Options that choose tests some other way: the files cannot be told, so take the lock.
const OPAQUE_OPTIONS = new Set(['--last-failed', '--only-changed', '--test-list', '--test-list-invert', '--project']);

/** The spec files in testDir whose tests mesh or solve in WSL when it is there. */
export function wslSpecFiles(testDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p);
      } else if (/\.spec\.[cm]?[jt]sx?$/.test(e.name) && WSL_SPEC.test(readFileSync(p, 'utf8'))) out.push(p);
    }
  };
  walk(testDir);
  return out;
}

/**
 * Whether a `playwright test` command line (the words after "test") may run a test
 * that meshes or solves in WSL. Unsure means yes: the lock is taken more often than
 * needed, never less.
 */
export function mayRunWslTests(args, wslSpecs) {
  if (args.includes('--list')) return false;
  const filters = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.split('=')[0];
    if (OPAQUE_OPTIONS.has(name)) return true;
    if (a.startsWith('-')) {
      if (VALUE_OPTIONS.has(a)) i++;
      continue;
    }
    filters.push(a);
  }
  if (!filters.length) return wslSpecs.length > 0;
  const slash = (p) => p.split(sep).join('/');
  for (const f of filters) {
    const pattern = f.replace(/:\d+(:\d+)?$/, '');
    // Playwright reads a filter as a regular expression on the file's path; people also
    // type plain paths with either slash. Any reading that hits a WSL spec counts.
    const plain = pattern.replace(/\\/g, '/');
    const hits = [(s) => slash(s).includes(plain)];
    try {
      const re = new RegExp(pattern);
      hits.push((s) => re.test(s) || re.test(slash(s)));
    } catch {
      /* not a regular expression: the plain reading stands */
    }
    if (wslSpecs.some((s) => hits.some((hit) => hit(s)))) return true;
  }
  return false;
}
