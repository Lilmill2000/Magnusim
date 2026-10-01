// @ts-check
/**
 * What the Vite dev server's file watcher leaves alone (vite.config.js).
 *
 * Chokidar on Windows will sit on a core if it walks projects/, python/, or
 * caches. A function ignore is reliable with backslashes; globs alone are not.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The app folder (magnusim-web), where the dev server watches from. */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IGNORED_PARTS = [
  '/node_modules/',
  '/.git/',
  '/projects/',
  // Playwright's projects root; a watched run folder blocks the live-sync rename from WSL.
  '/.tmp-projects/',
  '/.cache/',
  '/python/',
  // A plugin's own virtual environment or bytecode (plugins/<key>/.venv).
  '/.venv/',
  '/__pycache__/',
  '/dist/',
  'hexcore-process-backup',
];

// Results, meshes, CAD, media, and build or tool logs.
const IGNORED_FILES = /\.(vtp|vtu|vtk|vtm|foam|bin|stl|step|stp|png|jpe?g|webp|mp4|webm|log)$/i;

// A local OCCT source or build folder in the app folder (occt-7.9.3/, 300+ MB).
const IGNORED_APP_DIRS = /^occt-[^/]*(\/|$)/;

function slashes(path) {
  return String(path || '').replace(/\\/g, '/').toLowerCase();
}

/**
 * True when the watcher must not look at this file or folder.
 * @param {string} filePath absolute, or relative to the app folder
 * @param {string} [appRoot]
 */
export function isViteWatchIgnored(filePath, appRoot = APP_ROOT) {
  const p = slashes(filePath);
  const absolute = p.startsWith('/') || /^[a-z]:\//.test(p);
  const root = slashes(appRoot).replace(/\/+$/, '');
  // The part below the app folder, or null for a path outside it.
  let rel = null;
  if (!absolute) rel = p.replace(/^(\.\/)+/, '');
  else if (p === root || p.startsWith(`${root}/`)) rel = p.slice(root.length + 1);
  // Inside the app folder only that part counts, so a checkout under a
  // projects/ or python/ folder is still watched.
  const path = rel === null ? p : `/${rel}`;
  if (path.endsWith('/node_modules') || IGNORED_PARTS.some((part) => path.includes(part))) return true;
  if (rel !== null && IGNORED_APP_DIRS.test(rel)) return true;
  return IGNORED_FILES.test(path);
}
