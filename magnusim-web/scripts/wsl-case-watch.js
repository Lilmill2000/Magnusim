// @ts-check
/**
 * The processes of one WSL case copy: probe them, kill them, and wait until they
 * are gone while the compute slot stays held (a core solve's drain, a plugin
 * case whose relay ended, the boot check).
 *
 * python/tools/wsl_case_procs.py does the matching (the case id exactly, a cwd in
 * the case copy, the run's own scripts), so reconstructPar and the copy back are
 * seen too. Every call passes the WSL case root, so the tool never has to ask WSL
 * for $HOME inside a probe.
 */
import { spawn } from 'node:child_process';
import { PYTHON, pyTool } from './python-env.js';
import { wslCaseRoot } from './wsl-env.js';
import { currentSlotToken, releaseComputeSlot } from './compute-slot.js';

export const PROBE_TIMEOUT_MS = 15_000;
export const WATCH_EVERY_MS = 2_000;
export const KILL_EVERY_MS = 30_000;
export const MAX_KILLS = 5;
export const UNREACHABLE_MS = 10 * 60_000;

/** What `onLost` notices say, by reason. */
export const LOST_TEXT = Object.freeze({
  stuck: 'its processes in WSL would not stop. Restart WSL (wsl --shutdown) before starting more jobs',
  unreachable: 'WSL stopped answering. Results saved before then are in the run folder',
});

/** The spawn the tool calls go through (tests replace it). */
const tools = { spawn: /** @type {typeof spawn} */ (spawn) };

/** @param {typeof spawn | null} fn */
export function setCaseProcsSpawnForTests(fn) {
  tools.spawn = fn || spawn;
}

/**
 * @param {'probe'|'kill'} action
 * @param {{ wslCase: string, scripts?: string[], names?: string[] }} opts
 */
function procsArgs(action, { wslCase, scripts, names }) {
  const args = [pyTool('wsl_case_procs.py'), action, '--wsl-case', String(wslCase || '')];
  for (const s of scripts || []) args.push('--script', String(s));
  if (names && names.length) args.push('--names', names.map(String).join(','));
  return args;
}

/** @param {string | null | undefined} root */
function procsEnv(root) {
  return {
    ...process.env,
    MAGNUSIM_WSL_CASE_ROOT: String(root ?? wslCaseRoot()),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

/**
 * @param {string} out
 * @returns {'live' | 'dead' | 'unknown'}
 */
export function parseProbeAnswer(out) {
  const lines = String(out || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  try {
    const j = JSON.parse(lines[lines.length - 1] || '');
    if (j && j.ok === true && typeof j.live === 'boolean') return j.live ? 'live' : 'dead';
  } catch {
    /* not an answer */
  }
  return 'unknown';
}

/**
 * Are processes of this case copy still running in WSL? Never rejects: a spawn
 * error, a timeout (15 s) or a bad answer is 'unknown'.
 * @param {{ wslCase: string, scripts?: string[], root?: string | null }} opts
 * @returns {Promise<'live' | 'dead' | 'unknown'>}
 */
export function probeWslCase({ wslCase, scripts = [], root } = /** @type {any} */ ({})) {
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    let done = false;
    let out = '';
    /** @param {'live' | 'dead' | 'unknown'} state */
    const finish = (state) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(state);
    };
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = tools.spawn(PYTHON, procsArgs('probe', { wslCase, scripts }), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: procsEnv(root),
      });
    } catch {
      finish('unknown');
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish('unknown');
    }, PROBE_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (child.stdout) child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => finish('unknown'));
    child.on('close', () => finish(parseProbeAnswer(out)));
  });
}

/**
 * End this case copy's processes in WSL (its scripts first). Does not wait.
 * @param {{ wslCase: string, scripts?: string[], names?: string[], root?: string | null }} opts
 */
export function killWslCase({ wslCase, scripts = [], names, root } = /** @type {any} */ ({})) {
  try {
    const child = tools.spawn(PYTHON, procsArgs('kill', { wslCase, scripts, names }), {
      windowsHide: true,
      stdio: 'ignore',
      env: procsEnv(root),
    });
    child.on('error', () => {});
  } catch {
    /* the next probe tries again */
  }
}

/**
 * Wait until the case copy's processes are gone, holding the slot meanwhile.
 *
 * Every 2 s one probe (never two at once). Two `dead` in a row → onGone. A `live`
 * while stop() is true kills now and then at most every 30 s; still `live` after
 * 5 kills → onLost('stuck'). `unknown` for 10 minutes in a row → onLost('unreachable').
 * stop() is read at every probe (a throw counts as false). When isCurrent() is
 * false (the slot moved on) the watch ends silently: no kill, no callback, no release.
 *
 * The watch owns the release: onGone and onLost run in try/catch and release()
 * runs in finally, so a throw there never keeps the slot.
 *
 * @param {{
 *   token: string, wslCase: string, scripts?: string[], root?: string | null,
 *   stop?: () => boolean, onGone?: () => void, onLost?: (reason: 'stuck' | 'unreachable') => void,
 *   isCurrent?: () => boolean, release?: () => void,
 *   probe?: (opts: { wslCase: string, scripts: string[], root?: string | null }) => Promise<string>,
 *   kill?: (opts: { wslCase: string, scripts: string[], root?: string | null }) => void,
 * }} opts
 * @returns {{ cancel: () => void }}
 */
export function watchWslCaseGone(opts) {
  const { token, wslCase, scripts = [], root, stop, onGone, onLost } = opts;
  const isCurrent = typeof opts.isCurrent === 'function' ? opts.isCurrent : () => currentSlotToken() === token;
  const release = typeof opts.release === 'function' ? opts.release : () => releaseComputeSlot(token);
  const probe = typeof opts.probe === 'function' ? opts.probe : probeWslCase;
  const kill = typeof opts.kill === 'function' ? opts.kill : killWslCase;
  let ended = false;
  let deadInRow = 0;
  let kills = 0;
  /** @type {number | null} */
  let lastKillAt = null;
  /** @type {number | null} */
  let unknownSince = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const current = () => {
    try {
      return !!isCurrent();
    } catch {
      return false;
    }
  };
  const stopWanted = () => {
    try {
      return !!(stop && stop());
    } catch {
      return false;
    }
  };
  /** @param {(() => void) | null} fn */
  const end = (fn) => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    try {
      if (fn) fn();
    } catch (e) {
      console.warn(`[CFD case watch] ${wslCase}: ending failed`, e);
    } finally {
      try {
        release();
      } catch (e) {
        console.warn(`[CFD case watch] ${wslCase}: release failed`, e);
      }
    }
  };
  const quiet = () => {
    ended = true;
    if (timer) clearTimeout(timer);
  };
  const schedule = () => {
    if (ended) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, WATCH_EVERY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  const tick = async () => {
    if (ended) return;
    if (!current()) return quiet();
    let state;
    try {
      state = String(await probe({ wslCase, scripts, root }));
    } catch {
      state = 'unknown';
    }
    if (ended) return;
    if (!current()) return quiet();
    const now = Date.now();
    if (state === 'dead') {
      unknownSince = null;
      deadInRow += 1;
      if (deadInRow >= 2) return end(() => onGone && onGone());
    } else if (state === 'live') {
      deadInRow = 0;
      unknownSince = null;
      if (kills >= MAX_KILLS) return end(() => onLost && onLost('stuck'));
      if (stopWanted() && (lastKillAt === null || now - lastKillAt >= KILL_EVERY_MS)) {
        if (!current()) return quiet();
        kills += 1;
        lastKillAt = now;
        try {
          kill({ wslCase, scripts, root });
        } catch (e) {
          console.warn(`[CFD case watch] ${wslCase}: kill failed`, e);
        }
      }
    } else {
      deadInRow = 0;
      if (unknownSince === null) unknownSince = now;
      else if (now - unknownSince >= UNREACHABLE_MS) return end(() => onLost && onLost('unreachable'));
    }
    schedule();
  };
  schedule();
  return { cancel: quiet };
}
