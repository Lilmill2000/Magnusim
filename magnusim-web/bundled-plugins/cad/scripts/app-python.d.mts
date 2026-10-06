// Types for scripts/app-python.mjs (the specs, tests and gates import it).
// SPDX-License-Identifier: GPL-3.0-or-later
export interface AppPython {
  /** The interpreter to run, or null when none was found. */
  python: string | null;
  /** How it was found: 'MAGNUSIM_PYTHON', 'CAD_E2E_PYTHON', 'venv', 'PATH' ('' when none was). */
  from: string;
  /** Why none was found ('' when one was). */
  missing: string;
}
export const APP_PY_ROOT: string;
export const PYTHON_VARS: string[];
export const PATH_PYTHONS: string[];
export function venvPythons(pyRoot?: string): string[];
export function probePython(cmd: string): string | null;
export function findAppPython(
  env?: Record<string, string | undefined>,
  o?: { exists?: (p: string) => boolean; probe?: (cmd: string) => string | null; pyRoot?: string },
): AppPython;
export function appPythonMissing(found: AppPython): string;
