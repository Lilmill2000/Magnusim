// A second app server for a spec, or for a bundled plugin's own suite: its own
// projects root, prefs and plugins folder in a temp folder, on a free port, so it
// never touches the main test server's state. Use it instead of spawning Vite
// and picking MAGNUSIM_E2E_PORT + N by hand (two specs once claimed the same N).
//
//   import { startHost } from './support/host-server.mjs';
//   const host = await startHost({ name: 'g1', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
//   try { await page.goto(`${host.base}/#/p/...`); ... } finally { host.stop(); }
//
// startHost(options) resolves once GET /api/registry answers. Options:
//   name            label for the temp folder and log lines ('host')
//   tmp             a temp folder the caller made (e2eTemp(name)) and filled; default: a new one
//   projects        projects root; created and seeded with the e2e projects when missing
//   seed            false: leave a missing projects root empty (default true)
//   pluginsDir      MAGNUSIM_PLUGINS_DIR; default <tmp>/plugins (made empty when missing: no user plugins)
//   pluginsFrom     a folder copied into pluginsDir first (relative to the checkout)
//   bundledDir      MAGNUSIM_BUNDLED_DIR; default unset (the checkout's bundled-plugins/)
//   enablePlugins   keys of bundled plugins that ship off, turned on before the first load
//   prefs           more prefs over {wizard_completed: true, units: 'Metric', port}
//   env             more environment; a null value removes a variable
//   webRoot         the checkout to run (default: this one)
//   viteCacheDir    a private Vite dependency cache (servers sharing node_modules otherwise
//                   share node_modules/.vite, and one re-optimizing blanks the others' pages)
//   port            a fixed port (default: the first free one from portFrom)
//   portFrom        lowest port tried (default MAGNUSIM_E2E_PORT + 11)
//   keepFree        offsets above the port that must be free too (e.g. [11, 12, 13])
//   lock            a file naming a live server to reuse; written when this call starts one
//   timeoutMs       how long to wait for the server (default 120 s)
//   log             (line) => void for progress lines
// It returns {base, port, pid, reused, tmp, projects, prefs, pluginsDir, log(), stop()}:
// log() is the server's whole output so far; stop() ends the server's process tree
// and removes the temp folder (and the lock it wrote). A worker that exits stops it too.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareE2eProjectsRoot } from '../prepare-projects.js';

export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A new temp folder for one server (magnusim-<name>-XXXXXX). */
export function e2eTemp(name = 'host') {
  return mkdtempSync(join(tmpdir(), `magnusim-${name}-`));
}

/** Ports something listens on (Windows netstat; elsewhere the bind test alone decides). */
function listening() {
  const ports = new Set();
  if (process.platform !== 'win32') return ports;
  for (const proto of ['tcp', 'tcpv6']) {
    const out = spawnSync('netstat', ['-ano', '-p', proto], { encoding: 'utf8', windowsHide: true }).stdout || '';
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING/i);
      if (m) ports.add(Number(m[1]));
    }
  }
  return ports;
}

function canBind(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}

/** The first port from `from` where it and every port + keepFree offset are free. */
export async function findFreePort(from, keepFree = [], span = 400) {
  const busy = listening();
  for (let port = from; port < from + span; port++) {
    const set = [port, ...keepFree.map((k) => port + k)];
    if (set.some((p) => busy.has(p))) continue;
    let ok = true;
    for (const p of set) if (!(await canBind(p))) ok = false;
    if (ok) return port;
  }
  throw new Error(`no free port in ${from}..${from + span - 1}`);
}

/** Whether a URL answers below 500 within `ms`. */
export async function waitUp(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** End a process and everything it started. */
export function killTree(pid) {
  if (!pid || !alive(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}

/** The live server a lock file names, or null (a stale lock is removed). */
export async function readLiveLock(lock) {
  if (!lock || !existsSync(lock)) return null;
  let info;
  try {
    info = JSON.parse(readFileSync(lock, 'utf8'));
  } catch {
    return null;
  }
  if (info && info.server_pid && alive(info.server_pid) && info.base && (await waitUp(`${info.base}/api/registry`, 3000))) return info;
  try {
    unlinkSync(lock);
  } catch {
    /* someone else removed it */
  }
  return null;
}

/** A Vite config file for webRoot with its own dependency cache (in webRoot/.cache, which Vite does not watch). */
function privateCacheConfig(webRoot, cacheDir) {
  const dir = join(webRoot, '.cache', 'e2e-host');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `vite.${process.pid}.${Date.now()}.config.mjs`);
  const base = pathToFileURL(join(webRoot, 'vite.config.js')).href;
  writeFileSync(
    file,
    `import base from ${JSON.stringify(base)};\nexport default { ...base, root: ${JSON.stringify(webRoot)}, cacheDir: ${JSON.stringify(cacheDir)} };\n`,
  );
  return file;
}

export async function startHost(options = {}) {
  const {
    name = 'host',
    seed = true,
    pluginsFrom = null,
    bundledDir = null,
    enablePlugins = [],
    prefs: extraPrefs = {},
    env: extraEnv = {},
    webRoot = WEB_ROOT,
    viteCacheDir = null,
    keepFree = [],
    lock = null,
    timeoutMs = 120_000,
    log = () => {},
  } = options;
  const live = await readLiveLock(lock);
  if (live) {
    log(`[${name}] reusing the server in ${lock}: ${live.base}`);
    return { ...live, pid: live.server_pid, reused: true, log: () => '', stop() {} };
  }
  const tmp = options.tmp || e2eTemp(name);
  const projects = options.projects || join(tmp, 'projects');
  if (!existsSync(projects)) {
    if (seed) prepareE2eProjectsRoot(projects);
    else mkdirSync(projects, { recursive: true });
  }
  const pluginsDir = options.pluginsDir || join(tmp, 'plugins');
  if (pluginsFrom) cpSync(isAbsolute(pluginsFrom) ? pluginsFrom : join(webRoot, pluginsFrom), pluginsDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  const prefsPath = join(tmp, 'prefs.json');
  const config = viteCacheDir ? privateCacheConfig(webRoot, viteCacheDir) : null;
  const vite = join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');

  let child = null;
  let out = '';
  let lockWritten = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off('exit', stop);
    if (child) killTree(child.pid);
    if (lockWritten) {
      try {
        if (JSON.parse(readFileSync(lock, 'utf8')).server_pid === child?.pid) unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
    if (config) rmSync(config, { force: true });
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* a file may still be held for a moment; the OS temp cleaner takes it */
    }
  };
  process.once('exit', stop);

  let port = options.port || 0;
  const from = options.portFrom || Number(process.env.MAGNUSIM_E2E_PORT || 8083) + 11;
  for (let attempt = 1; ; attempt++) {
    if (!options.port) port = await findFreePort(from + (attempt - 1), keepFree);
    const prefs = { wizard_completed: true, units: 'Metric', ...extraPrefs, port };
    if (enablePlugins.length) {
      const p = { ...(prefs.plugins || {}) };
      p.enabled = [...new Set([...(p.enabled || []), ...enablePlugins])];
      prefs.plugins = p;
    }
    writeFileSync(prefsPath, JSON.stringify(prefs));
    const env = {
      ...process.env,
      MAGNUSIM_PROJECTS_ROOT: projects,
      MAGNUSIM_LOCAL_JSON: prefsPath,
      MAGNUSIM_PORT: String(port),
      MAGNUSIM_BOUND_PORT: String(port),
      MAGNUSIM_PLUGINS_DIR: pluginsDir,
    };
    if (bundledDir) env.MAGNUSIM_BUNDLED_DIR = bundledDir;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v == null) delete env[k];
      else env[k] = String(v);
    }
    const args = [vite, ...(config ? ['--config', config] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
    out = '';
    child = spawn(process.execPath, args, {
      cwd: webRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const base = `http://127.0.0.1:${port}`;
    const exited = new Promise((r) => child.once('exit', () => r(false)));
    const up = await Promise.race([waitUp(`${base}/api/registry`, timeoutMs), exited]);
    if (up) {
      if (lock) {
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(
          lock,
          JSON.stringify({ base, port, pid: process.pid, server_pid: child.pid, projects, prefs: prefsPath, started: new Date().toISOString(), web_root: webRoot }, null, 2),
        );
        lockWritten = true;
      }
      log(`[${name}] server up at ${base} (pid ${child.pid})`);
      return { base, port, pid: child.pid, reused: false, tmp, projects, prefs: prefsPath, pluginsDir, log: () => out, stop };
    }
    killTree(child.pid);
    // Another run took the port between the check and Vite's bind: try the next one.
    if (!options.port && attempt < 5 && /already in use|EADDRINUSE/i.test(out)) {
      log(`[${name}] port ${port} was taken, trying another`);
      continue;
    }
    const why = out.slice(-3000);
    stop();
    throw new Error(`[${name}] the app server did not start on port ${port}:\n${why}`);
  }
}
