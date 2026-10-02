// @ts-check
/**
 * A case_dir may only be served for the project folder it lives under.
 * Home lists every project; workbench APIs must not leak another project's mesh.
 */
import { realpathSync, statSync } from 'node:fs';
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
  // Under the configured projects root first (MAGNUSIM_PROJECTS_ROOT need not be "projects").
  const root = normalizeFs(PROJECTS_ROOT) + '/';
  let rest = n.startsWith(root) ? n.slice(root.length) : null;
  if (rest == null) {
    const marker = '/projects/';
    const i = n.lastIndexOf(marker);
    if (i < 0) return null;
    rest = n.slice(i + marker.length);
  }
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

/**
 * With a plugin study ({ plugin, studyId }), only that study's own folder counts;
 * otherwise the core study rules.
 * @param {string} caseDir
 * @param {string} projectId
 * @param {string} simId
 * @param {{ plugin: string, studyId: string } | null} [pluginStudy]
 */
export function caseDirAllowedForAttach(caseDir, projectId, simId, pluginStudy) {
  if (pluginStudy) return caseDirBelongsToPluginStudy(caseDir, projectId, pluginStudy.plugin, pluginStudy.studyId);
  return (
    caseDirBelongsToStudy(caseDir, projectId, simId) ||
    studyRunClaimsCaseDir(caseDir, projectId, simId)
  );
}

const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const PLUGIN_STUDY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** @param {string} p */
function nativeReal(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * The case folder lies inside a plugin study's own folder
 * (<project>/plugins/<key>/studies/<sid>/, which has its study.json), by real path:
 * a link or junction out of it does not count.
 * @param {string} caseDir
 * @param {string} projectId
 * @param {string} plugin
 * @param {string} studyId
 */
export function caseDirBelongsToPluginStudy(caseDir, projectId, plugin, studyId) {
  if (!caseDirBelongsToProject(caseDir, projectId)) return false;
  const key = String(plugin || '');
  const sid = String(studyId || '');
  if (!PLUGIN_KEY_RE.test(key) || /[. ]$/.test(key) || !PLUGIN_STUDY_ID_RE.test(sid)) return false;
  const studyDir = join(PROJECTS_ROOT, basename(String(projectId)), 'plugins', key, 'studies', sid);
  try {
    if (!statSync(join(studyDir, 'study.json')).isFile()) return false;
  } catch {
    return false;
  }
  const realStudy = nativeReal(studyDir);
  const realCase = nativeReal(String(caseDir));
  if (!realStudy || !realCase) return false;
  const rel = relative(realStudy, realCase);
  return Boolean(rel) && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

/**
 * The attached case is server-global. A tab leaving project A must not detach
 * a case another tab attached for project B.
 */
export function caseDetachAllowed(activeCaseDir, projectId) {
  if (!activeCaseDir) return true;
  return caseDirBelongsToProject(activeCaseDir, projectId);
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
