// Start the host app (this checkout's magnusim-web) for CAD e2e tests with the
// app's own startHost() (magnusim-web/e2e/support/host-server.mjs): a fresh
// projects root and prefs in a temp folder, no user plugins, a free port with
// +11..+13 free too, a private Vite dependency cache (.cache/host-vite here), CAD
// turned on before the first load (it ships off; the P1 gate's off-by-default
// test forgets that choice itself), and no sweep of WSL's cases.
//
//   node e2e/host-server.mjs [--port N] [--lock FILE] [--plugins-dir DIR]
//     CAD_E2E_PORT_FROM: the lowest base port tried (default 8170).
//     Starts the server and keeps it running until this process is stopped;
//     prints one JSON line {"base","port","pid","server_pid","reused","projects","prefs"} when it is up.
//
// --lock FILE (or env CAD_E2E_LOCK): one server per shared node_modules. If the
// lock names a live server (its server_pid), that server is reused (nothing is
// started); otherwise the server started here is written there, and the lock is
// removed when it stops. Stop a server you started with: taskkill /PID <pid> /T /F (Windows).
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, readLiveLock, startHost, WEB_ROOT as CORE_WEB_ROOT } from '../../../e2e/support/host-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = resolve(HERE, '..');
export const WEB_ROOT = resolve(PLUGIN_DIR, '..', '..');
export { killTree, readLiveLock };

/** Ports above the base that must be free too (specs may start more servers there). */
export const KEEP_FREE = [11, 12, 13];

/**
 * Start (or reuse via the lock) a host server. Returns {base, port, pid, reused, projects, prefs, stop()}.
 * stop() ends only a server this call started, and removes its lock.
 */
export async function startHostServer({ port, lock = process.env.CAD_E2E_LOCK || null, pluginsDir = null, log = () => {} } = {}) {
  if (resolve(CORE_WEB_ROOT) !== resolve(WEB_ROOT)) throw new Error(`the app's startHost() serves ${CORE_WEB_ROOT}, not this plugin's checkout ${WEB_ROOT}`);
  const host = await startHost({
    name: 'cad-e2e',
    webRoot: WEB_ROOT,
    ...(port ? { port } : { portFrom: Number(process.env.CAD_E2E_PORT_FROM) || 8170 }),
    keepFree: KEEP_FREE,
    ...(pluginsDir ? { pluginsDir } : {}),
    // CAD ships off (manifest default_enabled = false): on before the page first loads.
    enablePlugins: ['cad'],
    viteCacheDir: resolve(PLUGIN_DIR, '.cache', 'host-vite'),
    lock,
    // No WSL meshes or solves here, and never a sweep of this PC's real WSL cases
    // (the app's own e2e config sets the same).
    env: { MAGNUSIM_E2E_WSL: null, MAGNUSIM_WSL_PRUNE: '0' },
    timeoutMs: 180_000,
    // startHost() starts its lines with "[cad-e2e] "; the caller adds its own prefix.
    log: (m) => log(String(m).replace(/^\[cad-e2e\] /, '')),
  });
  return {
    base: host.base,
    port: host.port,
    pid: host.pid,
    reused: host.reused,
    projects: host.projects || null,
    prefs: host.prefs || null,
    stop: () => host.stop(),
    tail: () => (host.log ? host.log().slice(-6000) : ''),
  };
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
  console.log(JSON.stringify({ base: server.base, port: server.port, pid: server.reused ? server.pid : process.pid, server_pid: server.pid, reused: server.reused, projects: server.projects, prefs: server.prefs }));
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
