// @ts-check
/**
 * Python side of magnusim-web, all under `magnusim-web/python/`:
 *
 *   python/.venv/      interpreter + deps (pyvista, gmsh, cadquery-ocp, …)
 *   python/cfddesk/    library package (import path kept as cfddesk during rename)
 *   python/tools/      CLI entry points the API spawns (export_*.py, generate_*.py, …)
 *
 * Override the interpreter with MAGNUSIM_PYTHON (or legacy CFDDESK_PYTHON).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envGet } from './env-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = resolve(__dirname, '..');
export const PY_ROOT = join(WEB_ROOT, 'python');
export const PY_TOOLS = join(PY_ROOT, 'tools');

function defaultPython() {
  const win = join(PY_ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(win)) return win;
  const posix = join(PY_ROOT, '.venv', 'bin', 'python');
  if (existsSync(posix)) return posix;
  return process.platform === 'win32' ? 'python' : 'python3';
}

export const PYTHON = envGet('PYTHON') || defaultPython();

/** Absolute path of a tool script, e.g. pyTool('export_case_field.py'). */
export function pyTool(name) {
  return join(PY_TOOLS, name);
}
