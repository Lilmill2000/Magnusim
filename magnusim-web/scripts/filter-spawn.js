/**
 * Python filter/export processes. Case-field middleware calls these
 * instead of spawning interpreters itself.
 */
import { spawn, spawnSync } from 'node:child_process';
import { PYTHON } from './python-env.js';

export function spawnFilter(args, opts = {}) {
  return spawn(PYTHON, args, { windowsHide: true, ...opts });
}

export function runFilterTool(args, opts = {}) {
  return spawnSync(PYTHON, args, {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    ...opts,
  });
}
