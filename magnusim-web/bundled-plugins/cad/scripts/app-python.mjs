// The app's Python, for what CAD runs natively: the app's link checker
// (python -m magnusim_sdk.link check) in the link gates, tests/kernel/kernel-link.test.ts
// and the link e2e, and the OCP check of cad-p2-step.spec.js. Found in this order:
//   1. MAGNUSIM_PYTHON, the app's own override (CAD_E2E_PYTHON, this plugin's older
//      name for it, after it). Used as given, never passed over: a path that is not
//      there, or a command that cannot import cfddesk and magnusim_sdk, is the answer
//      "missing", so a wrong setting fails instead of quietly testing another Python;
//   2. the app's venv, magnusim-web/python/.venv (Scripts/python.exe on Windows,
//      bin/python elsewhere);
//   3. a `python` or `python3` on PATH that can import cfddesk and magnusim_sdk. In CI
//      there is no venv: the backend is pip-installed into setup-python's interpreter.
// None: `python` is null and `missing` says what was tried. The gates (gate:l2-cad,
// gate:l3-cad) then FAIL at once with it; the specs and tests skip with it, and fail
// under the gates (CAD_LINK_REQUIRE_PYTHON=1, CAD_L3_REQUIRE=1).
// The gates hand the Python they found to everything they start as MAGNUSIM_PYTHON.
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** magnusim-web/python: the app's Python side (its venv is .venv in it). */
export const APP_PY_ROOT = join(ROOT, '..', '..', 'python');

/** The environment variables that name the app's Python, in order. */
export const PYTHON_VARS = ['MAGNUSIM_PYTHON', 'CAD_E2E_PYTHON'];

/** The commands looked for on PATH, in order. */
export const PATH_PYTHONS = ['python', 'python3'];

/** The app's venv interpreters: Windows', then everyone else's. */
export function venvPythons(pyRoot = APP_PY_ROOT) {
  return [join(pyRoot, '.venv', 'Scripts', 'python.exe'), join(pyRoot, '.venv', 'bin', 'python')];
}

const PROBE = 'import sys, cfddesk, magnusim_sdk; print(sys.executable)';

/**
 * Run `cmd` (a path or a command on PATH): its sys.executable when it can import cfddesk
 * and magnusim_sdk, else null.
 */
export function probePython(cmd) {
  const r = spawnSync(cmd, ['-c', PROBE], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const exe = String(r.stdout ?? '').trim().split(/\r?\n/).pop()?.trim();
  return exe || null;
}

/** A bare command name ("python3"), not a path. */
const isCommand = (s) => !/[\\/]/.test(s);

/**
 * Find the app's Python. Returns {python, from, missing}: `python` is the interpreter to
 * run (null when none was found), `from` how it was found (the variable, 'venv' or
 * 'PATH'), and `missing` the reason when none was ("" when one was).
 */
export function findAppPython(env = process.env, { exists = existsSync, probe = probePython, pyRoot = APP_PY_ROOT } = {}) {
  for (const name of PYTHON_VARS) {
    const v = String(env[name] ?? '').trim();
    if (!v) continue;
    if (isCommand(v)) {
      const exe = probe(v);
      if (exe) return { python: exe, from: name, missing: '' };
      return { python: null, from: name, missing: `${name} is ${v}, which cannot import cfddesk and magnusim_sdk` };
    }
    if (exists(v)) return { python: v, from: name, missing: '' };
    return { python: null, from: name, missing: `${name} names no file (${v})` };
  }
  const venvs = venvPythons(pyRoot);
  for (const v of venvs) if (exists(v)) return { python: v, from: 'venv', missing: '' };
  for (const cmd of PATH_PYTHONS) {
    const exe = probe(cmd);
    if (exe) return { python: exe, from: 'PATH', missing: '' };
  }
  return {
    python: null,
    from: '',
    missing: `none of ${PYTHON_VARS.join(', ')} is set, there is no venv (${venvs.join(' or ')}), and no ${PATH_PYTHONS.join(' or ')} on PATH can import cfddesk and magnusim_sdk`,
  };
}

/** The one line the gates and specs say when there is no Python. */
export function appPythonMissing(found) {
  return `the app's Python is missing: ${found.missing}. Set MAGNUSIM_PYTHON to the app's python (the one with the backend installed: cfddesk, magnusim_sdk, OCP).`;
}
