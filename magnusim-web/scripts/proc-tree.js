// @ts-check
/**
 * Stop a process and everything it started.
 *
 * On Windows `child.kill()` ends only the direct child: a tool's own
 * children (a plugin job's worker, a solver it launched) keep running, so this
 * goes through `taskkill /T /F`. Elsewhere a process started with
 * `ownProcessGroup()` leads its own group, and the whole group is killed.
 */
import { spawnSync } from 'node:child_process';

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
