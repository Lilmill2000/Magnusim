// @ts-check
/**
 * A case_dir may only be served for the project folder it lives under.
 * Home lists every project; workbench APIs must not leak another project's mesh.
 */
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { pathIsWithin } from './safe-path.js';
import { envGet } from './env-compat.js';
import { caseUnderOwner, findStudy, runCaseDirCandidates, walkRuns } from './project-layout.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
export const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');

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

export function caseDirBelongsToStudy(caseDir, projectId, simId) {
  if (!caseDirBelongsToProject(caseDir, projectId)) return false;
  const want = String(simId || '').trim();
  if (!want) return false;
  const study = findStudy(join(PROJECTS_ROOT, basename(String(projectId || ''))), want);
  return !!(study && caseUnderOwner(caseDir, study.dir));
}

/** Settings-copy can leave frames in a sibling study folder that this run still claims. */
export function studyRunClaimsCaseDir(caseDir, projectId, simId, projectsRoot = PROJECTS_ROOT) {
  if (!caseDir || !projectId || !simId) return false;
  if (projectsRoot === PROJECTS_ROOT && !caseDirBelongsToProject(caseDir, projectId)) return false;
  const projectDir = join(projectsRoot, basename(String(projectId || '')));
  const claimed = normalizeFs(caseDir);
  if (!claimed) return false;
  const runs = walkRuns(projectDir, String(simId).trim()) || [];
  for (const rec of runs) {
    for (const c of runCaseDirCandidates(rec, rec && rec.dir)) {
      if (normalizeFs(c) === claimed) return true;
    }
  }
  return false;
}

export function caseDirAllowedForAttach(caseDir, projectId, simId) {
  return (
    caseDirBelongsToStudy(caseDir, projectId, simId) ||
    studyRunClaimsCaseDir(caseDir, projectId, simId)
  );
}

export function caseDirBelongsToProject(caseDir, projectId) {
  const want = String(projectId || '').trim();
  if (!want || !caseDir) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(want)) return false;
  const root = resolve(PROJECTS_ROOT, basename(want));
  const abs = resolve(String(caseDir));
  const rel = relative(root, abs);
  return Boolean(rel) && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) && pathIsWithin(abs, root);
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
