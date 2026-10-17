// @ts-check
/**
 * Stop a process and everything it started.
 *
 * On Windows `child.kill()` ends only the direct child: a tool's own
 * children (a plugin job's worker, a solver it launched) keep running, so this
 * goes through `taskkill /T /F`. Elsewhere a process started with
 * `ownProcessGroup()` leads its own group, and the whole group is killed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** @param {number | null | undefined} pid */
export function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 8000,
        stdio: 'ignore',
      });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    /* not a group leader: the process alone */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * killProcessTree without blocking the server: on Windows `taskkill /T /F` runs as an async
 * process (never spawnSync, which would hold the whole server until it ends), by its absolute
 * path; elsewhere the group (else the process alone) gets SIGKILL. Resolves once taskkill has
 * ended, or after `timeoutMs` (it is then left to finish on its own).
 * @param {number | null | undefined} pid
 * @param {{ timeoutMs?: number }} [o]
 * @returns {Promise<void>}
 */
export function killProcessTreeAsync(pid, { timeoutMs = 8000 } = {}) {
  if (!pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const exe = join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(exe, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on('error', done);
    child.on('close', done);
  });
}

/** Spawn options that let killProcessTree reach what a process starts (POSIX: its own group). */
export function ownProcessGroup() {
  return process.platform === 'win32' ? {} : { detached: true };
}

/**
 * The environment for a Python that must see only its own packages (a
 * plugin's environment): nothing of the core's PYTHONPATH or user site.
 * @param {NodeJS.ProcessEnv} env
 */
export function isolatedPythonEnv(env) {
  const out = { ...env };
  delete out.PYTHONPATH;
  delete out.PYTHONHOME;
  delete out.PYTHONSTARTUP;
  out.PYTHONNOUSERSITE = '1';
  return out;
}
