// @ts-check
/**
 * Background sweep of Magnusim's WSL scratch cases (<case root>/<id>).
 *
 * Every mesh and solve works in its own copy there; a run that succeeds removes its
 * copy itself. This removes the rest (failed, stopped or interrupted runs) once
 * nothing has touched them for a day and no process holds them, shortly after the
 * server starts and then every few hours. python/cfddesk/runner/cleanup.py and
 * python/cfddesk/wsl/templates/prune_cases.sh decide what goes.
 *
 * MAGNUSIM_WSL_PRUNE=0 turns it off (the e2e config does, except for the servers
 * that test it). MAGNUSIM_WSL_PRUNE_MAX_AGE_H and MAGNUSIM_WSL_PRUNE_DELAY_MS change
 * the age kept and the wait after boot.
 */
import { spawn } from 'node:child_process';
import { PYTHON, pyTool } from './python-env.js';

const DEFAULT_MAX_AGE_H = 24;
const DEFAULT_DELAY_MS = 120_000;
const EVERY_MS = 6 * 3600_000;
const SWEEP_TIMEOUT_MS = 3600_000;

// One schedule and one sweep per server process: a Vite restart imports this
// module again, so the state lives on the process, not in the module.
/** @type {{ timer: ReturnType<typeof setTimeout> | null, running: boolean }} */
const state = (() => {
  const key = Symbol.for('magnusim.wslPrune');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) g[key] = { timer: null, running: false };
  return g[key];
})();

/** @param {NodeJS.ProcessEnv} [env] */
export function wslPruneSettings(env = process.env) {
  const get = (/** @type {string} */ suffix) => {
    for (const prefix of ['MAGNUSIM_', 'CFDDESK_']) {
      const v = env[prefix + suffix];
      if (v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return undefined;
  };
  const num = (/** @type {string | undefined} */ raw, /** @type {number} */ fallback) => {
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    enabled: get('WSL_PRUNE') !== '0',
    maxAgeHours: num(get('WSL_PRUNE_MAX_AGE_H'), DEFAULT_MAX_AGE_H),
    delayMs: num(get('WSL_PRUNE_DELAY_MS'), DEFAULT_DELAY_MS),
  };
}

/**
 * One sweep, unless one is already running in this server.
 * @param {{ maxAgeHours?: number, log?: (line: string) => void }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export function runWslPrune(opts = {}) {
  if (state.running) return Promise.resolve(null);
  state.running = true;
  const log = opts.log || ((line) => console.log(line));
  const maxAge = opts.maxAgeHours ?? wslPruneSettings().maxAgeHours;
  return new Promise((resolve) => {
    let out = '';
    /** @type {Record<string, unknown> | null} */
    let doc = null;
    const done = () => {
      state.running = false;
      resolve(doc);
    };
    let child;
    try {
      child = spawn(PYTHON, [pyTool('prune_wsl_cases.py'), '--max-age-hours', String(maxAge)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SWEEP_TIMEOUT_MS,
      });
    } catch (e) {
      log(`[CFD] WSL case sweep did not start: ${e instanceof Error ? e.message : String(e)}`);
      done();
      return;
    }
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', () => {});
    child.on('error', (e) => {
      log(`[CFD] WSL case sweep did not start: ${e.message}`);
    });
    child.on('close', () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try {
        doc = JSON.parse(line);
      } catch {
        doc = null;
      }
      if (doc && doc.ok) {
        const gb = (Number(doc.freed_kb) || 0) / 1048576;
        log(
          `[CFD] WSL cases pruned: ${Number(doc.removed) || 0} removed (${gb.toFixed(1)} GB), ` +
            `${Number(doc.kept_recent) || 0} recent and ${Number(doc.kept_busy) || 0} in use kept (${doc.root})`,
        );
      } else {
        log(`[CFD] WSL case sweep failed: ${(doc && doc.error) || line.slice(-300) || 'no output'}`);
      }
      done();
    });
  });
}

/**
 * Start the sweep schedule (Windows only: the cases live in WSL). Returns whether
 * it is scheduled.
 * @param {{ log?: (line: string) => void, env?: NodeJS.ProcessEnv, platform?: string }} [opts]
 */
export function scheduleWslPrune(opts = {}) {
  const settings = wslPruneSettings(opts.env);
  if ((opts.platform || process.platform) !== 'win32' || !settings.enabled) return false;
  if (state.timer) return true;
  const tick = (/** @type {number} */ ms) => {
    const timer = setTimeout(() => {
      void runWslPrune({ maxAgeHours: settings.maxAgeHours, log: opts.log }).finally(() => {
        // Stopped meanwhile (tests): no next sweep.
        if (state.timer === timer) tick(EVERY_MS);
      });
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    state.timer = timer;
  };
  tick(settings.delayMs);
  return true;
}

/** Stop the schedule (tests). */
export function stopWslPrune() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}
