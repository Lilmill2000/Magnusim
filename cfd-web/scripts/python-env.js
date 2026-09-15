// @ts-check
/**
 * Python side of cfd-web, all under `cfd-web/python/`:
 *
 *   python/.venv/      interpreter + deps (pyvista, gmsh, cadquery-ocp, …)
 *   python/cfddesk/    library package (CAD, mesh writers, case writers, WSL runner)
 *   python/tools/      CLI entry points the API spawns (export_*.py, generate_*.py, …)
 *
 * Override the interpreter with the CFDDESK_PYTHON env var.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const PYTHON = process.env.CFDDESK_PYTHON || defaultPython();

/** Absolute path of a tool script, e.g. pyTool('export_case_field.py'). */
export function pyTool(name) {
  return join(PY_TOOLS, name);
}
