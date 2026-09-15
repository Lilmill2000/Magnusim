/**
 * A case_dir may only be served for the project folder it lives under.
 * Home lists every project; workbench APIs must not leak another project's mesh.
 */
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECTS_ROOT = join(ROOT, 'projects');

export function normalizeFs(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function projectIdFromCaseDir(caseDir) {
  const n = normalizeFs(caseDir);
  if (!n) return null;
  const marker = '/projects/';
  const i = n.lastIndexOf(marker);
  if (i < 0) return null;
  const rest = n.slice(i + marker.length);
  const id = rest.split('/')[0];
  if (!id || id === 'active.json' || id === 'folders.json') return null;
  return id;
}

export function caseDirBelongsToProject(caseDir, projectId) {
  const want = String(projectId || '').trim();
  if (!want || !caseDir) return false;
  const inferred = projectIdFromCaseDir(caseDir);
  if (inferred) return inferred === want.toLowerCase();
  const root = resolve(PROJECTS_ROOT, basename(want));
  const abs = resolve(String(caseDir));
  const rel = relative(root, abs);
  return Boolean(rel) && !rel.startsWith('..') && !rel.startsWith(sep);
}

export function idleCaseSnapshot(note, projectId) {
  return {
    ok: true,
    case_dir: null,
    status: 'idle',
    mode: 'idle',
    project_id: projectId || null,
    n_times: 0,
    times: [],
    note: note || 'idle — no case attached for this project',
    pid: null,
    n_cells: null,
    n_points: null,
    n_faces: null,
  };
}
