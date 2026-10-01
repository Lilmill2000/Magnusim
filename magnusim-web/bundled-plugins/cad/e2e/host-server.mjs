// Start the host app (this checkout's magnusim-web) for CAD e2e tests, the way
// e2e/h13-workspace.spec.js starts its second server: a fresh projects root and
// prefs in a temp folder, no user plugins, a free port, a private Vite
// dependency cache (host-vite.config.mjs), and no sweep of WSL's cases.
//
//   node e2e/host-server.mjs [--port N] [--lock FILE] [--plugins-dir DIR]
//     CAD_E2E_PORT_FROM: the lowest base port tried (default 8170).
//     Starts the server and keeps it running until this process is stopped;
//     prints one JSON line {"base","port","pid","reused"} when it is up.
//
// --lock FILE (or env CAD_E2E_LOCK): one server per shared node_modules. If the
// lock names a live server, that server is reused (nothing is started);
// otherwise this process writes {port,pid,base} there and removes it on exit.
// Stop a server you started with: taskkill /PID <pid> /T /F (Windows).
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = resolve(HERE, '..');
export const WEB_ROOT = resolve(PLUGIN_DIR, '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listening() {
  const ports = new Set();
  for (const proto of ['tcp', 'tcpv6']) {
    const out = spawnSync('netstat', ['-ano', '-p', proto], { encoding: 'utf8' }).stdout || '';
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

/** A base port where base, +11, +12 and +13 are free (specs may start servers there). */
export async function findFreeBase(start = 8170, end = 8400) {
  const busy = listening();
  for (let base = start; base < end; base++) {
    const set = [base, base + 11, base + 12, base + 13];
    if (set.some((p) => busy.has(p))) continue;
    let ok = true;
    for (const p of set) if (!(await canBind(p))) ok = false;
    if (ok) return base;
  }
  throw new Error(`no free base port in ${start}..${end}`);
}

async function up(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {
      /* not yet */
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

/** The live server a lock names, or null (a stale lock is removed). */
export async function readLiveLock(lock) {
  if (!lock || !existsSync(lock)) return null;
  let info;
  try {
    info = JSON.parse(readFileSync(lock, 'utf8'));
  } catch {
    return null;
  }
  if (info && info.pid && alive(info.pid) && info.base && (await up(`${info.base}/api/registry`, 3000))) return info;
  try {
    unlinkSync(lock);
  } catch {
    /* someone else removed it */
  }
  return null;
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/**
 * Start (or reuse via the lock) a host server. Returns {base, port, pid, reused, stop()}.
 * stop() kills only a server this call started, and removes its lock.
 */
export async function startHostServer({ port, lock = process.env.CAD_E2E_LOCK || null, pluginsDir = null, log = () => {} } = {}) {
  const live = await readLiveLock(lock);
  if (live) {
    log(`reusing the server in ${lock}: ${live.base} (pid ${live.pid})`);
    return { base: live.base, port: live.port, pid: live.pid, reused: true, projects: live.projects || null, prefs: live.prefs || null, stop() {} };
  }
  port = port || (await findFreeBase(Number(process.env.CAD_E2E_PORT_FROM) || 8170));
  const tmp = mkdtempSync(join(tmpdir(), 'magnusim-cad-e2e-'));
  const projects = join(tmp, 'projects');
  const { prepareE2eProjectsRoot } = await import(pathToFileURL(join(WEB_ROOT, 'e2e', 'prepare-projects.js')).href);
  prepareE2eProjectsRoot(projects);
  const plugins = pluginsDir || join(tmp, 'plugins');
  mkdirSync(plugins, { recursive: true });
  const prefs = join(tmp, 'prefs.json');
  writeFileSync(prefs, JSON.stringify({ wizard_completed: true, units: 'Metric', port }));
  const env = { ...process.env };
  delete env.MAGNUSIM_E2E_WSL;
  // A test server never sweeps the WSL case root (it holds this PC's real cases), as
  // the app's own e2e config has it (magnusim-web/playwright.config.js).
  env.MAGNUSIM_WSL_PRUNE ??= '0';
  Object.assign(env, {
    MAGNUSIM_PROJECTS_ROOT: projects,
    MAGNUSIM_LOCAL_JSON: prefs,
    MAGNUSIM_PORT: String(port),
    MAGNUSIM_BOUND_PORT: String(port),
    MAGNUSIM_PLUGINS_DIR: plugins,
  });
  const vite = join(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, '--config', join(HERE, 'host-vite.config.mjs'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: WEB_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let tail = '';
  const keep = (d) => {
    tail = (tail + d).slice(-6000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const base = `http://127.0.0.1:${port}`;
  let lockWritten = false;
  const stop = () => {
    killTree(child.pid);
    if (lockWritten) {
      try {
        const info = JSON.parse(readFileSync(lock, 'utf8'));
        if (info.pid === process.pid || info.server_pid === child.pid) unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* files still held; the OS temp cleaner takes them */
    }
  };
  if (!(await up(`${base}/api/registry`, 180_000))) {
    stop();
    throw new Error(`the host server did not start on ${port}:\n${tail}`);
  }
  if (lock) {
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ base, port, pid: process.pid, server_pid: child.pid, projects, prefs, started: new Date().toISOString(), web_root: WEB_ROOT }, null, 2));
    lockWritten = true;
  }
  log(`host server up at ${base} (vite pid ${child.pid})`);
  return { base, port, pid: child.pid, reused: false, projects, prefs, stop, tail: () => tail };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const server = await startHostServer({
    port: arg('--port') ? Number(arg('--port')) : undefined,
    lock: arg('--lock') || process.env.CAD_E2E_LOCK || null,
    pluginsDir: arg('--plugins-dir') || null,
    log: (m) => console.error(`[host-server] ${m}`),
  });
  console.log(JSON.stringify({ base: server.base, port: server.port, pid: server.reused ? server.pid : process.pid, server_pid: server.pid, reused: server.reused, projects: server.projects }));
  if (server.reused) process.exit(0);
  const bye = () => {
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('SIGHUP', bye);
  // Stay up until stopped.
  setInterval(() => {}, 1 << 30);
}
