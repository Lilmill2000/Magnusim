import { safeProjectPath } from './safe-path.js';
import { projectIdOrActive } from './request-scope.js';
import { removeTree, removeTreeSync } from './remove-tree.js';
// @ts-nocheck
/**
 * W16 — project create + geometry import (filesystem persistence).
 * Projects live under magnusim-web/projects/<id>/project.json + geometry/.
 * Each import is kept under geometry/parts/<id>/ (own STEP + CAD preview).
 * Only the active geometry is copied to geometry/source.step and shown in
 * the viewport. Separate files are never compounded. Multi-solid inside one
 * STEP still appears together. Compare can show two meshes side by side.
 * IGES / BREP / STL / OBJ / PLY are normalized per part. Body1.stl is
 * created only when a mesh is generated.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp as fsCp, rename as fsRename } from 'node:fs/promises';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON, pyTool, pythonFound } from './python-env.js';
import {
  activeGeometryId,
  geometriesOf,
  matchesGeometry,
  matchesStudy,
  primaryGeometryId,
} from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation, readCatalog } from './w17-sim-catalog.js';
import { createDraftRun, projectSolveSummary } from './w27-solve.js';
import { computeSlotHolder, folderBusyMessage, holderNamesProject, projectBusyMessage } from './compute-slot.js';
import { computeRowsForProject, dropComputeRows } from './server/compute-queue.ts';
import { projectDeleted } from './server/project-deleted.ts';
import { envGet } from './env-compat.js';
import { thumbRenderTimeoutMs, thumbTestStandIn } from './server/thumb-render.js';
import { matchFaces, readPreviewFaces } from './geometry-face-match.js';
import { callWorker, commitRpc } from './py-json.js';
import { fillSampleFolder, sampleProblem } from './project-sample.js';
import { geometryFenced, isLinkedGeometryDir, markRemovedStudies, onGeometryRemove } from './server/link-job.js';
import { linkOverlay } from './server/link-overlay.js';
import {
  LAYOUT_VERSION,
  createGeometryFolder,
  findGeometry,
  geometriesRoot,
  walkAllMeshes,
} from './project-layout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');
const CONVERT_SCRIPT = pyTool('convert_step_to_stl.py');
const CAD_PREVIEW_SCRIPT = pyTool('export_step_cad_preview.py');
const NORMALIZE_SCRIPT = pyTool('normalize_cad_import.py');
const THUMB_SCRIPT = pyTool('render_geometry_thumb.py');
const DEFERRED_STEP_SCRIPT = pyTool('write_deferred_step.py');

/**
 * Mesh imports (STL/OBJ/PLY) store the geometry as a binary sidecar
 * (source.bbrep) first and write source.step in the background. The geometry
 * is present as soon as either file exists; its age is the newer of the two.
 */
export function geometrySidecarPath(stepPath) {
  return String(stepPath || '').replace(/\.[^.\\/]+$/, '') + '.bbrep';
}

export function geomFileExists(stepPath) {
  if (!stepPath) return false;
  return existsSync(stepPath) || existsSync(geometrySidecarPath(stepPath));
}

function geomMtimeMs(stepPath) {
  let out = 0;
  for (const f of [stepPath, geometrySidecarPath(stepPath)]) {
    try {
      if (f && existsSync(f)) out = Math.max(out, statSync(f).mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Write the deferred source.step off the request path (readers use the sidecar meanwhile). */
function writeDeferredStepLater(stepPath) {
  if (!stepPath || existsSync(stepPath) || !existsSync(DEFERRED_STEP_SCRIPT)) return;
  runPython([DEFERRED_STEP_SCRIPT, '--step', stepPath]).catch((e) =>
    console.warn('[W16] deferred STEP write failed (sidecar still serves readers)', String(e)),
  );
}
const DEFAULT_STEP = String(envGet('DEFAULT_STEP') || '').trim();
const thumbJobs = new Map();

/** A linked geometry's name (its link/state.json), else its folder's id.json name. */
function linkedGeometryName(dir) {
  for (const f of [join(dir, 'link', 'state.json'), join(dir, 'id.json')]) {
    try {
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      if (doc && doc.name) return String(doc.name);
    } catch {
      /* next */
    }
  }
  return 'the geometry';
}

/**
 * A linked geometry whose update did not finish is fenced (API 1.5): its files and its
 * records may disagree until the recovery runs, so its CAD, VTP, stl, thumbnail and
 * face-map reads answer 503 at once, and the page keeps what it shows.
 */
function linkFenceAnswer(dir) {
  if (!dir || !geometryFenced(dir)) return null;
  const name = linkedGeometryName(dir);
  return { ok: false, status: 503, body: { ok: false, code: 'geometry_updating', error: `Updating ${name}. Try again in a moment.` } };
}

function ensureProjectsRoot() {
  mkdirSync(PROJECTS_ROOT, { recursive: true });
}

function slugify(title) {
  const s = String(title || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'project';
}

function newProjectId(title) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rand = randomBytes(3).toString('hex');
  return `${slugify(title)}-${stamp}-${rand}`;
}

function readActiveId() {
  if (!existsSync(ACTIVE_PATH)) return null;
  try {
    const j = JSON.parse(readFileSync(ACTIVE_PATH, 'utf8'));
    return j.project_id || null;
  } catch {
    return null;
  }
}

/**
 * Make `id` the active project (null: none). A project whose project.json is gone (it was
 * deleted) never is: false, and the active project stays as it was.
 */
export function writeActiveId(id) {
  if (id && !existsSync(projectJsonPath(id))) return false;
  ensureProjectsRoot();
  writeFileSync(ACTIVE_PATH, JSON.stringify({ project_id: id, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  try {
    if (activeProjectListener) activeProjectListener(id || null);
  } catch (_) {}
  return true;
}

function projectDir(id) {
  return safeProjectPath(PROJECTS_ROOT, id);
}

function projectJsonPath(id) {
  return join(projectDir(id), 'project.json');
}

function readProject(id) {
  const p = projectJsonPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * A save of a project whose project.json is gone (it was deleted) throws this (a 404 to the
 * route), and makes nothing: not the project's folder, not its project.json.
 */
function projectGone(id) {
  return Object.assign(new Error(`project not found: ${id} (deleted)`), { status: 404 });
}

/**
 * Saves project.json through the long-lived worker: a new Python process per save held the
 * whole server (every tab's requests) for over a second. Only a new project (`create`) is
 * saved where there is none. The worker answers one request at a time: this save can run
 * after the project was deleted, and the worker then refuses it (it never makes the
 * project again).
 */
async function writeProjectAsync(proj, { create = false } = {}) {
  const dir = projectDir(proj.id);
  if (!create && !existsSync(projectJsonPath(proj.id))) throw projectGone(proj.id);
  mkdirSync(geometriesRoot(dir), { recursive: true });
  if (proj.layout_version == null) proj.layout_version = LAYOUT_VERSION;
  const written = await commitRpc('project.write_project', { project_dir: dir, doc: proj, create });
  if (written && typeof written === 'object') Object.assign(proj, written);
  invalidateProjectsListCache();
  return proj;
}

const FOLDERS_PATH = join(PROJECTS_ROOT, 'folders.json');
const SKIP_DIR_NAMES = new Set(['active.json', 'folders.json']);

function readStoredFolders() {
  if (!existsSync(FOLDERS_PATH)) return [];
  try {
    const j = JSON.parse(readFileSync(FOLDERS_PATH, 'utf8'));
    const list = Array.isArray(j.folders) ? j.folders : [];
    return list.map((n) => String(n || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function writeStoredFolders(names) {
  ensureProjectsRoot();
  const folders = [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  writeFileSync(
    FOLDERS_PATH,
    JSON.stringify({ folders, updated_at: new Date().toISOString() }, null, 2),
    'utf8',
  );
  return folders;
}

let liveMeshJobReader = null;
let activeProjectListener = null;

export function attachLiveMeshJobReader(fn) {
  liveMeshJobReader = typeof fn === 'function' ? fn : null;
}

export function attachActiveProjectListener(fn) {
  activeProjectListener = typeof fn === 'function' ? fn : null;
}

function meshJobFromDoc(m, projectId) {
  const lives = [];
  if (m && m.live_mesh_result) lives.push(m.live_mesh_result);
  if (m && Array.isArray(m.meshes)) {
    for (const entry of m.meshes) {
      if (entry && entry.live_mesh_result) lives.push(entry.live_mesh_result);
    }
  }
  const live = lives.find((l) => l && l.status === 'running') || (m && m.live_mesh_result);
  const snap = liveMeshJobReader ? liveMeshJobReader() : null;
  if (snap && snap.project_id && snap.project_id === projectId) {
    return {
      meshing: true,
      mesh_started_at: (live && live.started_at) || snap.started_at || null,
    };
  }
  if (!live || live.status !== 'running') {
    return { meshing: false, mesh_started_at: null };
  }
  // mesh.json can stay "running" after Vite dies. Only trust it when we
  // cannot see the live child table yet (reader not attached).
  if (liveMeshJobReader) {
    return { meshing: false, mesh_started_at: live.started_at || null };
  }
  const start = Date.parse(live.started_at || '');
  if (Number.isFinite(start) && Date.now() - start > 8 * 3600 * 1000) {
    return { meshing: false, mesh_started_at: live.started_at || null };
  }
  return { meshing: true, mesh_started_at: live.started_at || null };
}

function summarizeProject(proj) {
  let mesh_cells = null;
  let has_mesh = false;
  let meshing = false;
  let mesh_started_at = null;
  try {
    const entries = walkAllMeshes(projectDir(proj.id));
    const generatedEntry = entries.find(
      (x) => x && (x.generated || (x.live_mesh_result && x.live_mesh_result.n_cells)),
    );
    mesh_cells =
      (generatedEntry && generatedEntry.live_mesh_result && generatedEntry.live_mesh_result.n_cells) || null;
    has_mesh = !!(generatedEntry || mesh_cells);
    const job = meshJobFromDoc({ meshes: entries }, proj.id);
    meshing = job.meshing;
    mesh_started_at = job.mesh_started_at;
  } catch {
    has_mesh = !!proj.mesh;
  }
  const run = proj.run_1 || null;
  let solve = {
    simulating: !!(run && String(run.status || '').toLowerCase() === 'running'),
    has_run: !!(run && (run.status || run.run_id)),
    run_status: (run && run.status) || null,
    run_started_at: (run && run.started_at) || null,
  };
  try {
    solve = { ...solve, ...projectSolveSummary(proj.id) };
  } catch (_) {}
  const has_geometry = !!(
    (proj.geometry && (proj.geometry.name || proj.geometry.step_path || proj.geometry.stl_path)) ||
    (Array.isArray(proj.geometries) && proj.geometries.length)
  );
  const thumbFile = thumbPathFor(proj.id);
  let thumb_url = null;
  if (has_geometry) {
    // The browser keeps a thumbnail a day (thumbCacheControl): its address names the
    // geometry and the picture's age, so a geometry removed and added again (the same
    // file name, the same thumb.png path) never reuses the removed part's picture.
    const age = existsSync(thumbFile) ? String(Math.floor(statSync(thumbFile).mtimeMs)) : THUMB_PENDING;
    const v = `${thumbGeometryId(proj) || 'none'}-${age}`;
    thumb_url = `/api/geometry/thumb?project_id=${encodeURIComponent(proj.id)}&v=${encodeURIComponent(v)}`;
  }
  return {
    id: proj.id,
    title: proj.title || 'Untitled',
    description: proj.description || '',
    category: proj.category || 'Other',
    units: proj.units || 'Metric',
    folder: proj.folder || 'My Projects',
    created_at: proj.created_at || null,
    updated_at: proj.updated_at || proj.created_at || null,
    has_geometry,
    geometry_name: (proj.geometry && proj.geometry.name) || null,
    thumb_url,
    analysis: (proj.simulation && (proj.simulation.analysis || proj.simulation.name)) || null,
    has_mesh,
    mesh_cells,
    meshing,
    mesh_started_at,
    has_run: !!solve.has_run,
    run_status: solve.run_status || null,
    run_started_at: solve.run_started_at || null,
    simulating: !!solve.simulating,
    solve_started_at: solve.solve_started_at || null,
    sim_time: solve.sim_time,
    sim_end: solve.sim_end,
    time_dependency: solve.time_dependency || null,
    x_axis: solve.x_axis || null,
    iteration: solve.iteration,
    endTime: solve.endTime,
  };
}

let projectsListCache = { at: 0, body: null };
const PROJECTS_LIST_TTL_MS = 4000;

function invalidateProjectsListCache() {
  projectsListCache = { at: 0, body: null };
}

function listProjects() {
  ensureProjectsRoot();
  const out = [];
  for (const name of readdirSync(PROJECTS_ROOT)) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    let p;
    try {
      p = projectJsonPath(name);
    } catch {
      continue; // not a project id: the sample copies' staging folder (.sample-staging), a stray file
    }
    if (existsSync(p)) {
      try {
        out.push(JSON.parse(readFileSync(p, 'utf8')));
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  return out;
}

const ROOT_FOLDER = 'My Projects';

function listFolders(projects) {
  const fromProjects = (projects || listProjects())
    .map((p) => String(p.folder || '').trim())
    .filter((n) => n && n !== ROOT_FOLDER);
  const stored = readStoredFolders().filter((n) => n && n !== ROOT_FOLDER);
  return [...new Set([...stored, ...fromProjects])].sort((a, b) => a.localeCompare(b));
}

function createFolder(name) {
  const folder = String(name || '').trim();
  if (!folder) {
    return { ok: false, status: 400, body: { error: 'folder name required' } };
  }
  if (folder === ROOT_FOLDER) {
    return { ok: true, status: 200, body: { ok: true, folder, folders: listFolders(), root: ROOT_FOLDER } };
  }
  const folders = writeStoredFolders([...readStoredFolders(), folder]);
  // The project list carries the folders: a cached one would not offer the new folder yet.
  invalidateProjectsListCache();
  return { ok: true, status: 201, body: { ok: true, folder, folders, root: ROOT_FOLDER } };
}

function projectsInFolder(folder) {
  const name = String(folder || '').trim();
  if (!name) return [];
  return listProjects().filter((p) => String((p && p.folder) || '').trim() === name);
}

export function deleteFolder(name) {
  const folder = String(name || '').trim();
  if (!folder) {
    return { ok: false, status: 400, body: { error: 'folder name required' } };
  }
  if (folder === ROOT_FOLDER) {
    return { ok: false, status: 400, body: { error: 'Cannot delete My Projects' } };
  }
  const projects = projectsInFolder(folder);
  // A job running (or stopping) in any of its projects: nothing is deleted.
  const held = computeSlotHolder();
  const busy = held ? projects.find((p) => holderNamesProject(held, p.id)) : null;
  if (busy) {
    return { ok: false, status: 409, body: { error: folderBusyMessage(held, busy.title || busy.id, busy.id), folder } };
  }
  const deleted = [];
  const failed = [];
  for (const p of projects) {
    const result = deleteProject(p.id);
    if (result.ok) deleted.push({ id: p.id, title: p.title || p.id });
    else failed.push({ id: p.id, error: (result.body && result.body.error) || 'delete failed' });
  }
  if (failed.length) {
    invalidateProjectsListCache();
    return {
      ok: false,
      status: 500,
      body: {
        error: 'Could not delete every project in this folder',
        folder,
        deleted,
        failed,
      },
    };
  }
  writeStoredFolders(readStoredFolders().filter((n) => n !== folder));
  invalidateProjectsListCache();
  return {
    ok: true,
    status: 200,
    body: { ok: true, folder, deleted, folders: listFolders() },
  };
}

async function moveProject(id, folder) {
  const proj = readProject(id);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', id } };
  }
  const dest = String(folder || ROOT_FOLDER).trim() || ROOT_FOLDER;
  if (dest !== ROOT_FOLDER) {
    writeStoredFolders([...readStoredFolders(), dest]);
  }
  proj.folder = dest;
  proj.updated_at = new Date().toISOString();
  if (!(await saveUnlessDeleted(proj))) return projectDeletedAnswer(id);
  return {
    ok: true,
    status: 200,
    body: { ok: true, project: summarizeProject(proj), folder: dest, root: ROOT_FOLDER },
  };
}

async function updateProject(id, body) {
  if (!isSafeProjectId(id)) {
    return { ok: false, status: 400, body: { error: 'invalid project id' } };
  }
  const proj = readProject(id);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', id } };
  }
  if (body.title != null) {
    const title = String(body.title || body.name || '').trim();
    if (!title) {
      return { ok: false, status: 400, body: { error: 'title required' } };
    }
    proj.title = title;
  }
  if (body.description != null) proj.description = String(body.description);
  if (body.category != null) proj.category = String(body.category).trim() || proj.category;
  if (body.units != null) proj.units = String(body.units).trim() || proj.units;
  if (body.folder != null) {
    const dest = String(body.folder || ROOT_FOLDER).trim() || ROOT_FOLDER;
    if (dest !== ROOT_FOLDER) {
      writeStoredFolders([...readStoredFolders(), dest]);
    }
    proj.folder = dest;
  }
  proj.updated_at = new Date().toISOString();
  if (!(await saveUnlessDeleted(proj))) return projectDeletedAnswer(id);
  return {
    ok: true,
    status: 200,
    body: { ok: true, project: summarizeProject(proj), project_id: id },
  };
}

function openProject(id) {
  const proj = readProject(id);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', id } };
  }
  writeActiveId(id);
  return {
    ok: true,
    status: 200,
    body: { ok: true, active: true, project: summarizeProject(proj), project_id: id },
  };
}

function isSafeProjectId(id) {
  const s = String(id || '').trim();
  if (!s || s === '.' || s === '..') return false;
  if (s !== basename(s)) return false;
  if (SKIP_DIR_NAMES.has(s)) return false;
  return true;
}

function isInsideProjectsRoot(abs) {
  const root = resolve(PROJECTS_ROOT);
  const rel = relative(root, abs);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

export function deleteProject(id) {
  if (!isSafeProjectId(id)) {
    return { ok: false, status: 400, body: { error: 'invalid project id' } };
  }
  const proj = readProject(id);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', id } };
  }
  const abs = resolve(projectDir(id));
  if (!isInsideProjectsRoot(abs)) {
    return { ok: false, status: 400, body: { error: 'refusing to delete outside projects root' } };
  }
  // Synchronous from here to removeTreeSync: no job can start in between. A job of this
  // project (by folder, in any spelling) holding the compute slot refuses the delete.
  const held = computeSlotHolder();
  if (held && holderNamesProject(held, id)) {
    return { ok: false, status: 409, body: { error: projectBusyMessage(held, id) } };
  }
  const rowIds = computeRowsForProject(id);
  removeTreeSync(abs, { maxRetries: 8, retryDelay: 50 });
  // Its queued jobs go with it (a plugin case's record finishes stopped).
  dropComputeRows(rowIds, 'The project was deleted');
  // So do the Assistant's saved chats of it (its History), the person's delete or the AI's.
  projectDeleted(id);
  if (readActiveId() === id) {
    writeActiveId(null);
  }
  invalidateProjectsListCache();
  return { ok: true, status: 200, body: { ok: true, deleted: id, title: proj.title || id } };
}

/** A new project: its folder now, project.json through the worker, then it is the active one. */
async function createProject(body) {
  ensureProjectsRoot();
  const title = String(body.title || body.name || '').trim();
  if (!title) {
    return { ok: false, status: 400, body: { error: 'title required', soft_pass: false } };
  }
  const category = String(body.category || 'Other').trim() || 'Other';
  const units = String(body.units || 'Metric').trim() || 'Metric';
  const description = body.description != null ? String(body.description) : '';
  const folder = String(body.folder || ROOT_FOLDER).trim() || ROOT_FOLDER;
  const id = newProjectId(title);
  const now = new Date().toISOString();
  const proj = {
    id,
    title,
    description,
    category,
    units,
    folder,
    created_at: now,
    updated_at: now,
    geometry: null,
    persistence: 'filesystem',
    layout_version: LAYOUT_VERSION,
    projects_root: PROJECTS_ROOT,
    project_json: projectJsonPath(id),
    soft_pass_avoided: true,
    increment: 'W16',
  };
  await writeProjectAsync(proj, { create: true });
  writeActiveId(id);
  return { ok: true, status: 201, body: { ok: true, ...proj, active: true } };
}

/** `title`, or `title 2`, `title 3`, ...: the first no project here has. */
function freeProjectTitle(title) {
  const taken = new Set(listProjects().map((p) => String((p && p.title) || '').trim().toLowerCase()));
  if (!taken.has(title.toLowerCase())) return title;
  for (let n = 2; ; n++) {
    const next = `${title} ${n}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

/**
 * A copied sample's CAD previews (cad_faces.vtp, cad_edges.vtp, cad_preview.json of each
 * geometry) stamped now: a copy keeps the shipped files' times, and a source.step written
 * later (a checkout, a zip) would make every copy build its preview again (cadPreviewFreshAt).
 */
function freshenSamplePreviews(dest) {
  const root = geometriesRoot(dest);
  if (!existsSync(root)) return;
  const now = new Date();
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!lstatSync(dir).isDirectory()) continue;
    for (const file of ['cad_faces.vtp', 'cad_edges.vtp', 'cad_preview.json']) {
      const path = join(dir, file);
      if (existsSync(path) && lstatSync(path).isFile()) utimesSync(path, now, now);
    }
  }
}

/**
 * Where a sample is made before it is a project: a folder of the projects folder no project
 * list reads (no project.json of its own, a name starting with a dot).
 */
const SAMPLE_STAGING = '.sample-staging';

/** Rename a folder, again for a while when Windows holds it (an indexer, a scanner). */
async function renameFolder(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsRename(from, to);
      return;
    } catch (e) {
      const code = String((e && e.code) || '');
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= 10) throw e;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/**
 * Remove what a sample copy left under SAMPLE_STAGING when the app stopped in the middle of
 * it (a crash, a kill): entries older than `maxAgeMs`. Runs before each sample is opened, one
 * at a time, so no copy of this server is in there while it does. Returns the names removed.
 */
export async function sweepSampleStaging(root = PROJECTS_ROOT, maxAgeMs = 60 * 60 * 1000) {
  const stagingRoot = join(root, SAMPLE_STAGING);
  const removed = [];
  let names = [];
  try {
    names = readdirSync(stagingRoot);
  } catch {
    return removed;
  }
  for (const name of names) {
    const dir = join(stagingRoot, name);
    try {
      if (Date.now() - lstatSync(dir).mtimeMs < maxAgeMs) continue;
      await removeTree(dir);
      removed.push(name);
    } catch (e) {
      console.warn('[CFD W16] sample staging sweep', dir, e);
    }
  }
  return removed;
}

/** The sample being opened (each waits for the one before). @type {Promise<unknown>} */
let sampleChain = Promise.resolve();

/**
 * A plugin's sample project (manifest [[samples]], API 1.8) as a new project: the sample's
 * folder copied into the projects folder with its placeholders filled in
 * (scripts/project-sample.js), a new id, a title no project here has ("Heat sink", then
 * "Heat sink 2", ...) and the folder asked for, and a new draft run in each study (a
 * sample ships no runs: a run's id names its WSL case, so two copies never share one).
 * It becomes the active project. The worker names the folder, only for a plugin that is on.
 * One at a time (two at once would pick the same free title).
 */
export function createProjectFromSample(body) {
  const run = sampleChain.then(() => copySample(body));
  sampleChain = run.catch(() => {});
  return run;
}

/**
 * The copy is made, checked again and filled in under SAMPLE_STAGING, then moved into
 * place whole, so no list ever shows a half-made project; anything that fails removes
 * only what this call made.
 */
async function copySample(body) {
  ensureProjectsRoot();
  await sweepSampleStaging();
  const plugin = String((body && body.plugin) || '').trim();
  const sample = String((body && body.sample) || '').trim();
  if (!plugin || !sample) return { ok: false, status: 400, body: { error: 'plugin and sample required' } };
  let found;
  try {
    found = await commitRpc('plugins.sample', { key: plugin, sample });
  } catch (e) {
    // The worker's "not on" / "no such sample" (-32004) is the caller's 404; anything else
    // (the worker gone, a crash) is the app's, 503.
    const why = String((e && e.message) || e);
    if (e && Number(e.code) === -32004) return { ok: false, status: 404, body: { error: why } };
    return { ok: false, status: 503, body: { error: `could not read the sample: ${why}` } };
  }
  const src = String((found && found.dir) || '');
  let problem = '';
  try {
    problem = sampleProblem(src);
  } catch (e) {
    problem = `the sample's folder cannot be read: ${String((e && e.message) || e)}`;
  }
  if (problem) return { ok: false, status: 500, body: { error: problem } };
  const title = freeProjectTitle(String((found && found.title) || 'Sample').trim() || 'Sample');
  const id = newProjectId(title);
  const dest = projectDir(id);
  const stagingRoot = join(PROJECTS_ROOT, SAMPLE_STAGING);
  const staging = join(stagingRoot, id);
  const now = new Date().toISOString();
  const refuse = (why) => ({ ok: false, status: 500, body: { error: `could not open the sample: ${why}` } });
  let placed = false;
  const fail = async (why) => {
    // Only what this call made: its staging folder, and the project once it moved there.
    for (const dir of placed ? [staging, dest] : [staging]) {
      try {
        await removeTree(dir);
      } catch (e) {
        console.warn('[CFD W16] sample cleanup', dir, e);
      }
    }
    try {
      rmdirSync(stagingRoot); // only when empty
    } catch {
      /* kept */
    }
    invalidateProjectsListCache();
    return refuse(why);
  };
  if (existsSync(dest)) return refuse(`a project ${id} is already there`);
  try {
    mkdirSync(stagingRoot, { recursive: true });
    mkdirSync(staging); // not recursive: one that is there already is not ours
  } catch (e) {
    return refuse(String((e && e.message) || e));
  }
  let proj;
  try {
    // Links were refused above; none is followed while copying. `staging` is the empty folder
    // this call just made, so nothing there is replaced (force: false); errorOnExist stays off
    // because Node on Linux refuses a copy into an existing folder with it on.
    await fsCp(src, staging, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
    // Checked again on the copy: a link made, or files grown, since the check above.
    const again = sampleProblem(staging);
    if (again) return await fail(again);
    fillSampleFolder(staging, { projectDir: dest, projectsRoot: PROJECTS_ROOT, projectId: id });
    freshenSamplePreviews(staging);
    proj = Object.assign(JSON.parse(readFileSync(join(staging, 'project.json'), 'utf8')), {
      id,
      title,
      folder: String((body && body.folder) || ROOT_FOLDER).trim() || ROOT_FOLDER,
      created_at: now,
      updated_at: now,
      persistence: 'filesystem',
      projects_root: PROJECTS_ROOT,
      project_json: projectJsonPath(id),
      sample: { plugin, key: String(found.sample || sample) },
    });
    // Whole before it can be listed: the worker writes it (project.write_project) in the
    // staging folder, and the folder moves into place with it.
    if (proj.layout_version == null) proj.layout_version = LAYOUT_VERSION;
    const written = await commitRpc('project.write_project', { project_dir: staging, doc: proj });
    if (written && typeof written === 'object') Object.assign(proj, written);
    if (existsSync(dest)) return await fail(`a project ${id} is already there`);
    await renameFolder(staging, dest);
    placed = true;
    invalidateProjectsListCache();
  } catch (e) {
    return await fail(String((e && e.message) || e));
  }
  try {
    rmdirSync(stagingRoot); // only when empty
  } catch {
    /* another copy is under way, or something was left: kept */
  }
  // The project's studies as the app reads them (its folders, then the index).
  for (const sid of readCatalog(id).simulations.map((s) => String((s && s.id) || '')).filter(Boolean)) {
    let made;
    try {
      made = await createDraftRun({ projectId: id, simulationId: sid });
    } catch (e) {
      made = { ok: false, error: String((e && e.message) || e) };
    }
    if (!made || made.ok === false) return await fail(`no draft run for study ${sid}: ${(made && made.error) || 'unknown'}`);
  }
  writeActiveId(id);
  return { ok: true, status: 201, body: { ok: true, ...proj, active: true } };
}

function ensureGeometriesHydrated(proj) {
  if (!proj || !proj.id) return proj;
  // Linked geometries (API 1.5): project.json is their cache. Their link fields come from
  // link/state.json on every read; a record the cache lost is added back (the repair).
  try {
    const pdir = projectDir(proj.id);
    for (const rec of linkOverlay(proj, pdir)) {
      commitRpc('project.upsert_geometry', { project_dir: pdir, record: rec }).catch(() => {
        /* the overlay adds it again on the next read */
      });
    }
  } catch {
    /* an unreadable folder: the record stays as it was */
  }
  const geomDir = join(projectDir(proj.id), 'geometry');
  if (!hasImportedGeometry(proj, geomDir)) return proj;
  let dirty = false;
  if (!Array.isArray(proj.geometries) || !proj.geometries.length) {
    const parts = migrateLegacyToParts(proj);
    if (!parts.length) return proj;
    for (const p of parts) {
      p.n_solids = Math.max(1, Number(p.n_solids) || 1);
      p.body_offset = 0;
      p.assembly_bodies = localBodiesForPart(p);
    }
    proj.geometries = parts;
    dirty = true;
  }
  if (!proj.active_geometry_id && proj.geometries[0] && proj.geometries[0].id) {
    proj.active_geometry_id = proj.geometries[0].id;
    dirty = true;
  }
  if (proj.geometry && !proj.geometry.id && proj.active_geometry_id) {
    proj.geometry.id = proj.active_geometry_id;
    dirty = true;
  }
  if (dirty) saveInBackground(proj, 'geometry records repaired on a read');
  // A project whose only geometry a link made has no active record yet: draw it from its
  // own files (never regenerated, never written here).
  if (!proj.geometry && proj.active_geometry_id) {
    const part = geometriesOf(proj).find((g) => g.id === proj.active_geometry_id);
    const paths = part ? cadPaths(proj.id, part.id) : null;
    if (part && paths && isLinkedGeometryDir(paths.dir) && cadPreviewFilesReady(paths)) {
      let meta = null;
      try {
        meta = JSON.parse(readFileSync(paths.meta, 'utf8'));
      } catch {
        meta = null;
      }
      proj.geometry = geometryRecordFromPart(proj.id, { ...part }, paths, meta, 'link');
    }
  }
  return proj;
}

function getActiveProject() {
  const id = readActiveId();
  if (!id) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        active: false,
        project: null,
        projects_root: PROJECTS_ROOT,
        note: 'No active project. POST /api/project to create.',
        increment: 'W16',
      },
    };
  }
  const proj = ensureGeometriesHydrated(readProject(id));
  if (!proj) {
    return {
      ok: false,
      status: 404,
      body: { error: 'active project missing on disk', project_id: id, projects_root: PROJECTS_ROOT },
    };
  }
  return { ok: true, status: 200, body: { ok: true, active: true, project: proj, projects_root: PROJECTS_ROOT, increment: 'W16' } };
}

/** Same shape as getActiveProject(), for an explicit project id. */
export function getProjectById(id) {
  const proj = ensureGeometriesHydrated(readProject(id));
  if (!proj) {
    return {
      ok: false,
      status: 404,
      body: { error: 'project not found', project_id: id, projects_root: PROJECTS_ROOT },
    };
  }
  const active = readActiveId() === id;
  return { ok: true, status: 200, body: { ok: true, active, project: proj, projects_root: PROJECTS_ROOT, increment: 'W16' } };
}

/** Run the app's Python; `timeoutMs` stops it (and rejects) when it has not ended by then. */
function runPython(args, opts = {}) {
  return new Promise((resolveP, reject) => {
    if (!pythonFound()) {
      return reject(new Error(`PYTHON missing: ${PYTHON}`));
    }
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(opts.timeoutMs) || 0;
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill('SIGKILL');
            } catch {
              /* gone */
            }
          }, timeoutMs)
        : null;
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`python stopped: no answer in ${timeoutMs} ms`));
      }
      if (code !== 0) {
        return reject(new Error(`python exit=${code}\n${stderr || stdout}`));
      }
      resolveP({ stdout, stderr, code });
    });
  });
}

function runPythonSync(args) {
  if (!pythonFound()) {
    throw new Error(`PYTHON missing: ${PYTHON}`);
  }
  const r = spawnSync(PYTHON, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`python exit=${r.status}\n${r.stderr || r.stdout}`);
  }
  return r;
}

function runConvert(stepPath, outStl) {
  if (!existsSync(CONVERT_SCRIPT)) {
    return Promise.reject(new Error(`convert script missing: ${CONVERT_SCRIPT}`));
  }
  return runPython([CONVERT_SCRIPT, '--step', stepPath, '--out', outStl]);
}

function resolveStepPath(proj, geometryId) {
  if (!proj) return null;
  const aid = geometryId || activeGeometryId(proj);
  if (aid) {
    const part = geometriesOf(proj).find((g) => g.id === aid);
    if (part && part.step_path && geomFileExists(part.step_path)) return part.step_path;
    const partStep = join(partDirFor(proj.id, aid), 'source.step');
    if (geomFileExists(partStep)) return partStep;
  }
  // A named geometry has only its own shape (never the shown one's).
  if (geometryId) return null;
  const listed = proj.geometry && proj.geometry.step_path;
  if (listed && geomFileExists(listed)) return listed;
  return null;
}

function resolveStlPath(proj) {
  if (!proj) return null;
  const listed = proj.geometry && proj.geometry.stl_path;
  if (listed && existsSync(listed)) return listed;
  const aid = activeGeometryId(proj);
  if (aid) {
    const partStl = join(partDirFor(proj.id, aid), 'Body1.stl');
    if (existsSync(partStl)) return partStl;
  }
  return null;
}

function extOfName(name) {
  const m = String(name || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '';
}

function cadKindOfName(name) {
  const e = extOfName(name);
  if (e === '.step' || e === '.stp') return 'step';
  if (e === '.iges' || e === '.igs') return 'iges';
  if (e === '.brep' || e === '.brp') return 'brep';
  if (e === '.stl' || e === '.obj' || e === '.ply') return 'mesh';
  return '';
}

function clearStaleOriginals(geomDir, keepPath) {
  const keep = keepPath ? resolve(keepPath) : '';
  for (const name of readdirSync(geomDir)) {
    if (!/^original\./i.test(name)) continue;
    const p = join(geomDir, name);
    if (keep && resolve(p) === keep) continue;
    try {
      unlinkSync(p);
    } catch {
      /* leftover original.* is best-effort */
    }
  }
}

function parseNormalizeStdout(stdout) {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .find((l) => l.startsWith('CAD_NORMALIZE_OK'));
  if (!line) return {};
  try {
    return JSON.parse(line.slice('CAD_NORMALIZE_OK'.length).trim());
  } catch {
    return {};
  }
}

function parseCompoundStdout(stdout) {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .find((l) => l.startsWith('CAD_COMPOUND_OK'));
  if (!line) return {};
  try {
    return JSON.parse(line.slice('CAD_COMPOUND_OK'.length).trim());
  } catch {
    return {};
  }
}

function newGeomId() {
  return `geom-${randomBytes(4).toString('hex')}`;
}

function newModId() {
  return `mod-${randomBytes(4).toString('hex')}`;
}

function modifierDirFor(projectId, hostId, modId) {
  return join(partDirFor(projectId, hostId), 'modifiers', modId);
}

function modifierCadPaths(projectId, hostId, modId) {
  const dir = modifierDirFor(projectId, hostId, modId);
  return {
    dir,
    faces: join(dir, 'cad_faces.vtp'),
    edges: join(dir, 'cad_edges.vtp'),
    meta: join(dir, 'cad_preview.json'),
  };
}

function normalizeTranslation(raw) {
  const a = Array.isArray(raw) ? raw : [0, 0, 0];
  return [0, 1, 2].map((i) => {
    const n = Number(a[i]);
    return Number.isFinite(n) ? n : 0;
  });
}

function publicModifier(projectId, hostId, rec) {
  if (!rec || !rec.id) return null;
  const q = `project_id=${encodeURIComponent(projectId)}&geometry_id=${encodeURIComponent(hostId)}&modifier_id=${encodeURIComponent(rec.id)}`;
  return {
    id: rec.id,
    name: rec.name,
    original_filename: rec.original_filename || null,
    source_kind: rec.source_kind || 'step',
    length_unit: rec.length_unit || null,
    translation: normalizeTranslation(rec.translation),
    rotation: Array.isArray(rec.rotation) ? rec.rotation : [0, 0, 0],
    opacity: rec.opacity != null ? Number(rec.opacity) : 0.38,
    n_solids: rec.n_solids || 1,
    faces_url: `/api/geometry/cad?${q}&part=faces`,
    edges_url: `/api/geometry/cad?${q}&part=edges`,
    imported_at: rec.imported_at,
  };
}

function boundsTranslationBeside(hostBounds, modBounds) {
  if (!hostBounds || !modBounds) return [0, 0, 0];
  const span = Math.max(Number(hostBounds.xmax) - Number(hostBounds.xmin) || 0, 1e-6);
  const gap = 0.08 * span;
  const dx = Number(hostBounds.xmax) + gap - Number(modBounds.xmin || 0);
  return [Number.isFinite(dx) ? dx : 0, 0, 0];
}

function findModifierOnPart(part, modId) {
  const list = (part && Array.isArray(part.modifiers) && part.modifiers) || [];
  return list.find((m) => m && m.id === modId) || null;
}

function hasImportedGeometry(proj, geomDir) {
  if (geometriesOf(proj).length) return true;
  if (proj && proj.geometry && (proj.geometry.step_path || proj.geometry.name)) return true;
  return !!(geomDir && geomFileExists(join(geomDir, 'source.step')));
}

function partDirFor(projectId, geomId) {
  const found = findGeometry(projectDir(projectId), geomId);
  if (found && found.dir) return found.dir;
  return join(geometriesRoot(projectDir(projectId)), String(geomId || 'geometry'));
}

function localBodiesForPart(part) {
  const n = Math.max(1, Number(part && part.n_solids) || 1);
  return Array.from({ length: n }, (_, i) => `Body${i + 1}`);
}

function copyOriginalSidecar(geomDir, destDir) {
  if (!existsSync(geomDir)) return null;
  let copied = null;
  for (const name of readdirSync(geomDir)) {
    if (!/^original\./i.test(name)) continue;
    const src = join(geomDir, name);
    try {
      if (!statSync(src).isFile()) continue;
      const dest = join(destDir, name);
      copyFileSync(src, dest);
      copied = dest;
    } catch {
      /* sidecar is optional */
    }
  }
  return copied;
}

function migrateLegacyToParts(proj) {
  const existing = geometriesOf(proj);
  if (existing.length) {
    return existing.map((g) => ({ ...g }));
  }
  const geomDir = join(projectDir(proj.id), 'geometry');
  const src = resolveStepPath(proj) || join(geomDir, 'source.step');
  if (!src || !existsSync(src)) return [];
  const id = (proj.geometry && proj.geometry.id) || newGeomId();
  const destDir = partDirFor(proj.id, id);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, 'source.step');
  if (resolve(src) !== resolve(dest)) {
    copyFileSync(src, dest);
  }
  const originalPath =
    (proj.geometry && proj.geometry.original_path && existsSync(proj.geometry.original_path)
      ? (() => {
          const leaf = basename(proj.geometry.original_path);
          const out = join(destDir, leaf);
          try {
            copyFileSync(proj.geometry.original_path, out);
          } catch {
            /* ignore */
          }
          return existsSync(out) ? out : proj.geometry.original_path;
        })()
      : copyOriginalSidecar(geomDir, destDir));
  const nSolids = Math.max(
    1,
    Number((proj.geometry && proj.geometry.fingerprint && proj.geometry.fingerprint.n_solids) || 1),
  );
  const g = proj.geometry || {};
  return [
    {
      id,
      name: g.name || 'Geometry',
      original_filename: g.original_filename || null,
      original_path: originalPath,
      source_kind: g.source_kind || g.representation || 'step',
      length_unit: g.length_unit || null,
      representation: g.representation || 'step',
      tessellated: !!g.tessellated,
      watertight: g.watertight != null ? !!g.watertight : true,
      step_path: dest,
      n_solids: nSolids,
      n_faces: (g.fingerprint && g.fingerprint.n_faces) || null,
      body_offset: 0,
      imported_at: g.imported_at || new Date().toISOString(),
      note: g.note || null,
    },
  ];
}

function unlinkIfExists(p) {
  if (p && existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* keep going */
    }
  }
}

function clearLiveCadSidecars(geomDir) {
  unlinkIfExists(join(geomDir, 'Body1.stl'));
  unlinkIfExists(join(geomDir, 'Body1.json'));
  unlinkIfExists(join(geomDir, 'cad_faces.vtp'));
  unlinkIfExists(join(geomDir, 'cad_edges.vtp'));
  unlinkIfExists(join(geomDir, 'cad_preview.json'));
  unlinkIfExists(join(geomDir, 'thumb.png'));
}

function cadPaths(id, geomId) {
  const dir = geomId ? partDirFor(id, geomId) : geometriesRoot(projectDir(id));
  return {
    dir,
    faces: join(dir, 'cad_faces.vtp'),
    edges: join(dir, 'cad_edges.vtp'),
    meta: join(dir, 'cad_preview.json'),
  };
}

const CAD_PREVIEW_VERSION = 8;

/**
 * True for a preview made before version 8 whose shape has a face two solids share.
 * Those previews numbered that face once in the viewport (faceId), while the face table
 * and the mesher count it once per solid, so every later viewport id named another face.
 * Only they need a new preview: without a shared face both numberings are the same. A
 * shared face shows in the old face table as two entries with the same area and centroid,
 * bit for bit (both come from the same OCCT face).
 */
export function cadPreviewFaceIdsStale(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (Number(meta.preview_version) >= 8) return false;
  // Mesh imports number their own triangles or surfaces, never shared OCCT faces.
  if (meta.display === 'mesh-triangles' || !Array.isArray(meta.faces)) return false;
  const seen = new Set();
  for (const f of meta.faces) {
    if (!f) continue;
    const key = JSON.stringify([f.area, f.centroid]);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

const faceIdsStaleSeen = new Map();

function cadPreviewFaceIdsStaleAt(paths) {
  try {
    const mtimeMs = statSync(paths.meta).mtimeMs;
    const hit = faceIdsStaleSeen.get(paths.meta);
    if (hit && hit.mtimeMs === mtimeMs) return hit.stale;
    const stale = cadPreviewFaceIdsStale(JSON.parse(readFileSync(paths.meta, 'utf8')));
    faceIdsStaleSeen.set(paths.meta, { mtimeMs, stale });
    return stale;
  } catch {
    return false;
  }
}

function cadPreviewFilesReady(paths) {
  try {
    return (
      existsSync(paths.faces) &&
      existsSync(paths.edges) &&
      statSync(paths.faces).size >= 80 &&
      statSync(paths.edges).size >= 80
    );
  } catch {
    return false;
  }
}

function cadPreviewFreshAt(paths, stepPath) {
  if (!cadPreviewFilesReady(paths)) return false;
  try {
    const j = JSON.parse(readFileSync(paths.meta, 'utf8'));
    // A version 7 preview that cadPreviewFaceIdsStale keeps is the same as a version 8 one.
    if (Number(j.preview_version) !== CAD_PREVIEW_VERSION && Number(j.preview_version) !== 7) return false;
  } catch {
    return false;
  }
  if (!stepPath || !geomFileExists(stepPath)) return true;
  const stepM = geomMtimeMs(stepPath);
  return statSync(paths.faces).mtimeMs >= stepM && statSync(paths.edges).mtimeMs >= stepM;
}

/**
 * A geometry's (or modifier's) CAD preview at `paths`, made when it is missing or older than
 * its STEP file. `opts.polled`: the ask is one of a page's asks again until the preview is
 * made (GET /api/geometry/cad), which is answered a failed build (below).
 */
async function ensureCadPreviewAt(projectId, stepPath, paths, opts = {}) {
  // A linked geometry (API 1.5): its link job wrote its previews, so they are never made
  // again here and no --com-only run starts for it (its centre of mass is a follow-up).
  if (paths && isLinkedGeometryDir(paths.dir)) {
    const fenced = linkFenceAnswer(paths.dir);
    if (fenced) return fenced;
    if (cadPreviewFilesReady(paths) && existsSync(paths.meta)) return { ok: true, ...paths, step_path: stepPath, cached: true };
    const name = linkedGeometryName(paths.dir);
    return { ok: false, status: 503, body: { ok: false, code: 'geometry_updating', error: `Updating ${name}. Try again in a moment.` } };
  }
  if (!stepPath || !geomFileExists(stepPath)) {
    return { ok: false, status: 404, body: { error: 'no STEP imported', project_id: projectId } };
  }
  if (cadPreviewFilesReady(paths) && !cadPreviewFaceIdsStaleAt(paths)) {
    if (cadPreviewFreshAt(paths, stepPath)) {
      try {
        const meta = JSON.parse(readFileSync(paths.meta, 'utf8'));
        if (!Array.isArray(meta.center_of_mass) || meta.center_of_mass.length < 3) {
          runPython([CAD_PREVIEW_SCRIPT, '--step', stepPath, '--meta', paths.meta, '--com-only']).catch(() => {});
        }
      } catch {
        /* COM is optional */
      }
    }
    return { ok: true, ...paths, step_path: stepPath, cached: true };
  }
  // A build that will fail again for this STEP file (the worker or the script read it and
  // failed) is answered again, for CAD_FAILURE_KEEP_MS while the file is the one it read, to
  // the page asking until its preview is made: it hears why instead of starting the build
  // once more each time. Only to those asks: an import, an activate, a thumbnail or a
  // modifier tries again. A failure that may not happen again (the worker timed out behind
  // other work, restarted or was not there) is not kept: the next ask makes it again.
  const stamp = cadSourceStamp(stepPath);
  const failed = opts.polled ? cadPreviewFailures.get(paths.meta) : null;
  if (failed) {
    if (failed.stamp === stamp && Date.now() - failed.at < CAD_FAILURE_KEEP_MS) return failed.result;
    cadPreviewFailures.delete(paths.meta);
  }
  // One build per preview at a time: requests that come while it runs (the page asks
  // for faces, edges and meta together) wait for it, instead of rewriting the files
  // another request is reading.
  let build = cadPreviewBuilds.get(paths.meta);
  if (!build) {
    build = buildCadPreviewAt(projectId, stepPath, paths)
      .catch((e) => ({ ok: false, status: 500, body: { error: 'CAD preview failed', detail: String(e), project_id: projectId } }))
      .then((result) => {
        if (result && result.lasting) cadPreviewFailures.set(paths.meta, { result, stamp, at: Date.now() });
        else cadPreviewFailures.delete(paths.meta);
        return result;
      })
      .finally(() => cadPreviewBuilds.delete(paths.meta));
    cadPreviewBuilds.set(paths.meta, build);
  }
  return build;
}

const cadPreviewBuilds = new Map();
/** Builds that failed for good, by preview (its meta path): {result, stamp, at}. */
const cadPreviewFailures = new Map();
const CAD_FAILURE_KEEP_MS = 60_000;

/**
 * Whether a preview build's failure will happen again for the same STEP file: the worker
 * answered with an error (it read the part and could not make it) or the script exited with
 * one. A worker that did not answer in time (busy with other work), restarted or was not
 * there, a script stopped at its time limit, or anything else may well work the next time.
 */
function cadPreviewFailureLasts(err) {
  if (!err) return false;
  if (err.scriptMissing || err.name === 'RpcError') return true;
  return /^python exit=/.test(String(err.message || ''));
}

/** The STEP file a preview is made from, as it is now (a mesh import's sidecar until its STEP is written). */
function cadSourceStamp(stepPath) {
  return fileStamp(existsSync(stepPath) ? stepPath : geometrySidecarPath(stepPath));
}

/**
 * How long a request for a CAD preview waits for its build. A build takes seconds to
 * minutes, and the viewport asks for a part's faces, edges and face table together: held
 * that long, two tabs' requests filled the browser's six connections to the app and every
 * other request of every tab waited. Past this the answer is "being prepared" (202) while
 * the build goes on; the page asks again.
 */
export const CAD_WAIT_MS = 250;

/** `job` (a preview's build), or { pending: true } when it has not ended within `waitMs`. */
async function withinCadWait(job, waitMs = CAD_WAIT_MS) {
  // It goes on after a pending answer: its failure is kept (above), never thrown at no one.
  job.catch(() => {});
  let timer;
  const late = new Promise((resolveLate) => {
    timer = setTimeout(() => resolveLate({ pending: true }), waitMs);
  });
  try {
    return await Promise.race([job, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The shown geometry's preview, or { pending: true } while it is being made (see CAD_WAIT_MS). */
export function ensureCadPreviewWithin(projectId, geomId, waitMs = CAD_WAIT_MS) {
  return withinCadWait(ensureCadPreview(projectId, geomId, { polled: true }), waitMs);
}

/** "Being prepared": 202 with Retry-After, never kept (a HEAD gets no body). */
function sendCadPending(req, res, sendJson, pid) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', '1');
  res.setHeader('X-CFD-Project-Id', pid || '');
  if (req.method === 'HEAD') {
    res.statusCode = 202;
    res.end();
    return true;
  }
  return sendJson(res, 202, { ok: false, pending: true, code: 'preview_pending', error: 'The part is being prepared.' });
}

/** Writes a preview's three files where `out` names them: the worker, else the script. */
async function writeCadPreviewWithPython(stepPath, out) {
  const rpc = callWorker('cad.preview', { step_path: stepPath, edges: out.edges, faces: out.faces, meta: out.meta }, 180_000);
  if (rpc) return rpc;
  if (!existsSync(CAD_PREVIEW_SCRIPT)) {
    throw Object.assign(new Error('CAD preview script missing'), { scriptMissing: true });
  }
  // The worker's limit: a script that never ends would hold its preview's build for good.
  return runPython([CAD_PREVIEW_SCRIPT, '--step', stepPath, '--edges', out.edges, '--faces', out.faces, '--meta', out.meta], { timeoutMs: 180_000 });
}
let writeCadPreview = writeCadPreviewWithPython;

/**
 * Tests hold the CAD preview build with a stand-in `fn(stepPath, out, write)`, where `write`
 * is the real writer (null puts the real writer back).
 */
export function setCadPreviewWriterForTests(fn) {
  writeCadPreview = fn ? (stepPath, out) => fn(stepPath, out, writeCadPreviewWithPython) : writeCadPreviewWithPython;
}

/**
 * MAGNUSIM_TEST_PREVIEW_HOLD (tests only): a file. While it is there, a CAD preview that is
 * made (its STEP read) waits before it is placed in the project. `made <step>` and
 * `end <step>` lines are added to `<file>.log`.
 */
async function testPreviewHold(stepPath, event) {
  const hold = envGet('TEST_PREVIEW_HOLD');
  if (!hold) return;
  try {
    writeFileSync(`${hold}.log`, `${event} ${stepPath}\n`, { flag: 'a' });
  } catch {
    /* the test's own log */
  }
  if (event !== 'made') return;
  while (existsSync(hold)) await new Promise((r) => setTimeout(r, 100));
}

/** One attempt at removing a temp stage (removeTree retries it); tests stand in one that fails. */
let stageRmOnce;

/** Tests stand in `fn(path)` for one removal attempt of a temp stage (null puts fs rm back). */
export function setStageRemoverForTests(fn) {
  stageRmOnce = fn || undefined;
}

/**
 * Remove a preview's stage folder or a thumbnail's render outside the project. Windows
 * refuses while the indexer, antivirus or a writer finishing holds a file, and rmSync gives up
 * at once (scripts/remove-tree.js): those left ~1,250 empty magnusim-preview-* folders in
 * %TEMP%, and the throw from a finally failed a preview that was made. One still held after
 * the retries is left and logged, never thrown.
 */
async function removeStaged(path) {
  try {
    await removeTree(path, { maxRetries: 8, retryDelay: 100, rm: stageRmOnce });
  } catch (e) {
    console.warn('[CFD W16] temp not removed', path, String(e));
  }
}

/** Which file it is, and its age and size ('' when it is not there). */
function fileStamp(file) {
  try {
    const s = statSync(file, { bigint: true });
    return `${s.ino}|${s.mtimeNs}|${s.size}`;
  } catch {
    return '';
  }
}

/** A string as Python's json.dumps writes it (non-ASCII as \u escapes). */
function pyJsonString(s) {
  const json = JSON.stringify(String(s));
  let out = '';
  for (let i = 0; i < json.length; i += 1) {
    const n = json.charCodeAt(i);
    out += n > 0x7f ? `\\u${n.toString(16).padStart(4, '0')}` : json[i];
  }
  return out;
}

/** cad_preview.json names its VTP files: the staged names become the geometry folder's. */
function previewMetaToFinal(staged, paths) {
  try {
    let text = readFileSync(staged.meta, 'utf8');
    const was = text;
    for (const k of ['edges', 'faces']) text = text.split(pyJsonString(staged[k])).join(pyJsonString(paths[k]));
    if (text !== was) writeFileSync(staged.meta, text, 'utf8');
  } catch {
    /* no meta: the preview is placed without one, as before */
  }
}

function moveFileSync(from, to) {
  try {
    renameSync(from, to);
  } catch {
    // Another volume, or a reader holds the old file without delete sharing.
    copyFileSync(from, to);
  }
}

/**
 * Move a CAD preview built outside the project into `paths`, unless the geometry it was
 * made from is gone or was replaced while it was built: its folder (or the project) was
 * removed, and writing there would make the removed folder again. The file it was made
 * from must still be that same file: a geometry removed and added again from a file of the
 * same name gets the same folder. All synchronous, so a remove (an rmSync on this thread)
 * cannot land between the check and the move.
 */
function placeCadPreview(projectId, paths, staged, sourceFile, sourceStamp) {
  if (!existsSync(projectJsonPath(projectId)) || !sourceStamp || fileStamp(sourceFile) !== sourceStamp) return false;
  if (!existsSync(paths.dir)) {
    // Only the project's geometries folder (a legacy project's one geometry) is made here:
    // a geometry's or a modifier's folder holds its STEP, so it is there when the STEP is.
    if (paths.dir !== geometriesRoot(projectDir(projectId))) return false;
    mkdirSync(paths.dir);
  }
  moveFileSync(staged.faces, paths.faces);
  moveFileSync(staged.edges, paths.edges);
  if (existsSync(staged.meta)) moveFileSync(staged.meta, paths.meta);
  return true;
}

async function buildCadPreviewAt(projectId, stepPath, paths, retried = false) {
  // Built outside the project, then moved in by placeCadPreview: the preview's writers make
  // the folder they write to, so a geometry or project removed while its preview was built
  // came back as a folder holding only the preview (and the next import of that file got a
  // "_2" folder). A mesh import's STEP is written after its sidecar, which is then the source.
  const sourceFile = existsSync(stepPath) ? stepPath : geometrySidecarPath(stepPath);
  const sourceStamp = fileStamp(sourceFile);
  const stageDir = mkdtempSync(join(tmpdir(), 'magnusim-preview-'));
  const staged = {
    faces: join(stageDir, 'cad_faces.vtp'),
    edges: join(stageDir, 'cad_edges.vtp'),
    meta: join(stageDir, 'cad_preview.json'),
  };
  try {
    let failed = null;
    try {
      await writeCadPreview(stepPath, staged);
      await testPreviewHold(stepPath, 'made');
    } catch (e) {
      failed = e;
    }
    // A build that failed because its STEP was removed or replaced meanwhile is answered
    // as a preview that is not placed (below).
    if (failed && fileStamp(sourceFile) === sourceStamp) {
      if (failed.scriptMissing) {
        return { ok: false, status: 500, body: { error: 'CAD preview script missing', path: CAD_PREVIEW_SCRIPT }, lasting: true };
      }
      return { ok: false, status: 500, body: { error: 'CAD preview failed', detail: String(failed), project_id: projectId }, lasting: cadPreviewFailureLasts(failed) };
    }
    if (!failed && (!existsSync(staged.edges) || !existsSync(staged.faces))) {
      return { ok: false, status: 500, body: { error: 'CAD preview missing after export', ...paths }, lasting: true };
    }
    let placed = false;
    if (!failed) {
      previewMetaToFinal(staged, paths);
      try {
        placed = placeCadPreview(projectId, paths, staged, sourceFile, sourceStamp);
      } catch (e) {
        return { ok: false, status: 500, body: { error: 'CAD preview could not be saved', detail: String(e), project_id: projectId } };
      }
    }
    if (!placed) {
      // Made from a geometry replaced meanwhile: make the one that is there now (once).
      if (!retried && existsSync(projectJsonPath(projectId)) && geomFileExists(stepPath)) {
        return await buildCadPreviewAt(projectId, stepPath, paths, true);
      }
      return { ok: false, status: 404, body: { error: 'geometry removed while its CAD preview was made', project_id: projectId } };
    }
  } finally {
    await removeStaged(stageDir);
    await testPreviewHold(stepPath, 'end');
  }
  return { ok: true, ...paths, step_path: stepPath, cached: false };
}

async function ensureCadPreview(projectId, geomId, opts = {}) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found', project_id: id } };
  const aid = geomId || activeGeometryId(proj);
  const part = aid ? geometriesOf(proj).find((g) => g.id === aid) : null;
  const stepPath = (part && part.step_path && geomFileExists(part.step_path) && part.step_path) || resolveStepPath(proj);
  const paths = cadPaths(id, part ? part.id : null);
  const preview = await ensureCadPreviewAt(id, stepPath, paths, opts);
  if (!preview.ok) return { ...preview, project: proj };
  // Whether it is the project's active geometry (asked for by none, or by its own id).
  return { ...preview, project: proj, active: !geomId || !!(part && part.id === activeGeometryId(proj)) };
}

function copyIfExists(src, dest) {
  if (!src || !existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function geometryRecordFromPart(projectId, part, preview, cadMeta, stepSource) {
  const nSolids = Math.max(
    1,
    Number((cadMeta && cadMeta.n_solids) || part.n_solids || 1),
  );
  part.n_solids = nSolids;
  part.n_faces = (cadMeta && cadMeta.n_faces) || part.n_faces || null;
  part.body_offset = 0;
  part.assembly_bodies = localBodiesForPart(part);
  const bodies =
    (cadMeta && Array.isArray(cadMeta.bodies) && cadMeta.bodies.length && cadMeta.bodies) ||
    part.assembly_bodies;
  const tessellated = !!part.tessellated;
  const watertight = part.watertight !== false;
  const q = `project_id=${encodeURIComponent(projectId)}&geometry_id=${encodeURIComponent(part.id)}`;
  return {
    id: part.id,
    name: part.name,
    bodies,
    volume: bodies[0] || 'Body1',
    step_path:
      (part.step_path && geomFileExists(part.step_path) && part.step_path) ||
      join(partDirFor(projectId, part.id), 'source.step'),
    step_source: stepSource || part.step_source || 'part',
    original_filename: part.original_filename || null,
    original_path: part.original_path || null,
    source_kind: part.source_kind || 'step',
    length_unit: part.length_unit || null,
    representation: tessellated ? 'mesh' : 'step',
    tessellated,
    watertight,
    faces_path: preview.faces,
    edges_path: preview.edges,
    faces_url: `/api/geometry/cad?${q}&part=faces`,
    edges_url: `/api/geometry/cad?${q}&part=edges`,
    stl_path: null,
    stl_url: null,
    fingerprint: {
      empty: false,
      n_faces: cadMeta && cadMeta.n_faces,
      n_edges: cadMeta && cadMeta.n_edges,
      n_solids: cadMeta && cadMeta.n_solids,
      bounds: cadMeta && cadMeta.bounds,
      center_of_mass: cadMeta && cadMeta.center_of_mass,
      center_of_mass_kind: cadMeta && cadMeta.center_of_mass_kind,
      representation: tessellated ? 'mesh' : 'step',
      watertight,
    },
    imported_at: part.imported_at || new Date().toISOString(),
    soft_pass_avoided: true,
    note: part.note || 'STEP stored as CAD. Not tessellated to STL on import.',
    modifiers: (Array.isArray(part.modifiers) ? part.modifiers : [])
      .map((m) => publicModifier(projectId, part.id, m))
      .filter(Boolean),
  };
}

function syncMeshActiveToGeometry(projectId, geomId) {
  if (!projectId || !geomId) return;
  const p = join(projectDir(projectId), 'mesh.json');
  if (!existsSync(p)) return;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    const meshes = Array.isArray(doc.meshes) ? doc.meshes : [];
    if (!meshes.length) return;
    const proj = readProject(projectId);
    const primaryId = primaryGeometryId(proj);
    const sim = getActiveSimulation(projectId, proj);
    const scoped = meshes.filter(
      (m) =>
        matchesGeometry(m, geomId, primaryId) &&
        matchesStudy(m, sim && sim.id, firstLegacySimId(projectId, proj))
    );
    if (!scoped.length) return;
    const cur = meshes.find((m) => m && m.id === doc.active_id);
    if (
      cur &&
      matchesGeometry(cur, geomId, primaryId) &&
      matchesStudy(cur, sim && sim.id, firstLegacySimId(projectId, proj))
    )
      return;
    return;
  } catch {
    /* leave mesh.json */
  }
}

/** The parts whose STEP is there, and the one shown: `activeId`'s, else the first (null: none). */
function shownPart(proj, parts, activeId) {
  const live = parts.filter((p) => p && p.id && p.step_path && geomFileExists(p.step_path));
  const want = String(activeId || proj.active_geometry_id || (live[0] && live[0].id) || '');
  return { live, active: live.find((p) => p.id === want) || live[0] || null };
}

/** A CAD preview's cad_preview.json (null: none, or unreadable). */
function previewMeta(preview) {
  if (!existsSync(preview.meta)) return null;
  try {
    return JSON.parse(readFileSync(preview.meta, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Shows `active` in `proj` (in memory): its record, with the preview files `preview` names
 * and the counts `cadMeta` gives (null: not known).
 */
function showPart(proj, live, active, preview, cadMeta, stepSource) {
  const geometry = geometryRecordFromPart(proj.id, active, preview, cadMeta, stepSource);
  for (const p of live) {
    p.body_offset = 0;
    p.assembly_bodies = localBodiesForPart(p);
  }
  proj.geometry = geometry;
  proj.geometries = live;
  proj.active_geometry_id = active.id;
  return geometry;
}

/**
 * Saves a project read earlier; false when it was deleted meanwhile (the save waits on the
 * worker, which answers one request at a time), and then nothing was saved.
 */
async function saveUnlessDeleted(proj) {
  try {
    await writeProjectAsync(proj);
  } catch (e) {
    if (existsSync(projectJsonPath(proj.id))) throw e;
    return false;
  }
  return existsSync(projectJsonPath(proj.id));
}

/**
 * A save a synchronous caller does not wait for (a read's repair, a cached path): sent to
 * the worker now, so it lands in order with the saves after it. A project deleted
 * meanwhile is not made again; any other failure is logged, and the next call makes the
 * same change again.
 */
function saveInBackground(proj, what) {
  saveUnlessDeleted(proj).catch((e) => console.warn(`[CFD W16] ${what}: project.json not saved`, e));
}

function projectDeletedAnswer(projectId) {
  return { ok: false, status: 404, body: { error: 'project deleted while it was saved', project_id: projectId } };
}

async function persistActiveGeometry(proj, parts, activeId, stepSource) {
  const projectId = proj.id;
  const { live, active } = shownPart(proj, parts, activeId);
  if (!active) {
    proj.geometry = null;
    proj.geometries = [];
    proj.active_geometry_id = null;
    proj.updated_at = new Date().toISOString();
    if (!(await saveUnlessDeleted(proj))) return projectDeletedAnswer(projectId);
    return { ok: true, empty: true, project: proj, geometry: null, geometries: [] };
  }
  const preview = await ensureCadPreviewAt(projectId, active.step_path, cadPaths(projectId, active.id));
  if (!preview.ok) return preview;
  const geometry = showPart(proj, live, active, preview, previewMeta(preview), stepSource);
  proj.updated_at = new Date().toISOString();
  // A project deleted while its save waited is not made the active project again.
  if (!(await saveUnlessDeleted(proj))) return projectDeletedAnswer(projectId);
  writeActiveId(projectId);
  syncMeshActiveToGeometry(projectId, active.id);
  // Best-effort and not needed by the workbench: render the home-card thumbnail after
  // replying (/api/geometry/thumb also renders on demand if it is not there yet).
  ensureGeometryThumb(projectId).catch(() => {
    /* thumb is best-effort */
  });
  return {
    ok: true,
    empty: false,
    project: proj,
    geometry,
    geometries: live,
    active_geometry_id: active.id,
  };
}

/**
 * A project as GET /api/project answers it. This read saves nothing of its own: no
 * project.json save (Home lists the projects by their Modified time), no new active
 * project, no CAD preview, no thumbnail. Such a save waited on the worker, and a project
 * deleted meanwhile came back. (ensureGeometriesHydrated, which the route runs first, still
 * repairs a legacy or a linked geometry's record.)
 *
 * The shown geometry's record is drawn here, in memory, from the preview that opening the
 * project shows as it is (ensureCadPreviewAt). Without one the saved record is answered;
 * when that is another geometry's, the shown part's record, its counts not known yet. The
 * page's /api/geometry/cad makes the preview.
 */
function projectForRead(proj) {
  const parts = geometriesOf(proj);
  if (parts.length < 2) return proj;
  const read = { ...proj };
  const { live, active } = shownPart(read, parts);
  if (!active) return Object.assign(read, { geometry: null, geometries: [], active_geometry_id: null });
  const paths = cadPaths(read.id, active.id);
  const saved = read.geometry && read.geometry.id === active.id ? read.geometry : null;
  // Not a preview made again before it is shown (face ids of an older version), and not a
  // fenced linked geometry's, whose files and records may disagree.
  const cached =
    !linkFenceAnswer(paths.dir) && cadPreviewFilesReady(paths) && existsSync(paths.meta) && !cadPreviewFaceIdsStaleAt(paths);
  if (cached) showPart(read, live, active, paths, previewMeta(paths), (saved && saved.step_source) || 'hydrate');
  else if (saved) Object.assign(read, { geometries: live, active_geometry_id: active.id });
  else showPart(read, live, active, paths, null, 'hydrate');
  return read;
}

function stlNeedsCadRefresh(outStl) {
  if (!existsSync(outStl) || statSync(outStl).size < 100) return true;
  const metaPath = outStl.replace(/\.stl$/i, '.json');
  if (!existsSync(metaPath)) return true;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const ntri = (meta.bounds && meta.bounds.ntri) || 0;
    const lin = meta.linear_deflection;
    if (meta.cad_quality === true && ntri >= 8000) return false;
    if (lin != null && Number(lin) >= 0.4) return true;
    if (ntri > 0 && ntri < 8000) return true;
  } catch {
    return true;
  }
  return false;
}

/** @type {Map<string, { mtimeMs: number, size: number, doc: any }>} */
const previewBudgetSeen = new Map();

/** cad_preview.json's display_budget and shape_sha256, read again only when the file changed. */
function previewBudgetAt(metaPath) {
  try {
    const st = statSync(metaPath);
    const hit = previewBudgetSeen.get(metaPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.doc;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const doc = { display_budget: meta && meta.display_budget === true, shape_sha256: (meta && meta.shape_sha256) || '' };
    previewBudgetSeen.set(metaPath, { mtimeMs: st.mtimeMs, size: st.size, doc });
    return doc;
  } catch {
    return null;
  }
}

/**
 * A geometry whose mesh input the mesh job builds (LINK proposal 5.9, L4): a linked
 * geometry (it has link/state.json), or a plain import whose preview has the display
 * budget (its VTP is not the meshing quality). Returns the shape's hash, which
 * `Body1.json` must record for the file to be current: link/state.json's
 * `shape_sha256`, or the one the budgeted preview recorded. Null for a plain import
 * without the budget, which keeps today's synchronous path.
 * @param {string} dir the geometry folder
 * @returns {{ linked: boolean, shapeSha256: string } | null}
 */
export function deferredMeshInput(dir) {
  if (!dir) return null;
  if (isLinkedGeometryDir(dir)) {
    let st;
    try {
      st = JSON.parse(readFileSync(join(dir, 'link', 'state.json'), 'utf8').replace(/^\ufeff/, ''));
    } catch {
      st = null;
    }
    const sha = st && st.shape_sha256 ? String(st.shape_sha256) : `rev-${(st && st.rev) || 0}`;
    return { linked: true, shapeSha256: sha };
  }
  const budget = previewBudgetAt(join(dir, 'cad_preview.json'));
  if (budget && budget.display_budget) {
    return { linked: false, shapeSha256: budget.shape_sha256 || `mtime-${Math.round(geomMtimeMs(join(dir, 'source.step')))}` };
  }
  return null;
}

/**
 * The Hex-dominant mesh input (`Body1.stl`) of a geometry: `opts.geometryId`, the mesh's
 * own geometry (LINK proposal 5.9), else the one shown. Only the shown geometry's record
 * in project.json names the file.
 *
 * For a linked or display-budgeted geometry (`deferredMeshInput`) it never converts,
 * never spawns and never reads `Body1.stl`: `{ok, deferred: true, shape_sha256}` when
 * `Body1.json` is missing, lacks `cad_quality: true` or names another shape, and the
 * mesh job builds the file in its first stage (`generate_snappy.py` prepare_input);
 * `{ok, cached: true, shape_sha256}` when it is current.
 */
export function ensureBody1Stl(projectId, opts) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, error: 'no project' };
  const proj = readProject(id);
  if (!proj) return { ok: false, error: 'project not found', project_id: id };
  const wanted = opts && opts.geometryId ? String(opts.geometryId) : '';
  const stepPath = resolveStepPath(proj, wanted || undefined);
  if (!stepPath) return { ok: false, error: 'W16 source.step missing — import geometry first', project_id: id };
  const aid = wanted || activeGeometryId(proj);
  const shown = !wanted || wanted === String(activeGeometryId(proj) || (proj.geometry && proj.geometry.id) || '');
  const outStl = join(partDirFor(id, aid || (proj.geometry && proj.geometry.id)), 'Body1.stl');
  const deferred = deferredMeshInput(dirname(outStl));
  if (deferred) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(outStl.replace(/\.stl$/i, '.json'), 'utf8'));
    } catch {
      meta = null;
    }
    const fresh = !!(meta && meta.cad_quality === true && meta.shape_sha256 && String(meta.shape_sha256) === deferred.shapeSha256 && existsSync(outStl));
    return {
      ok: true,
      path: outStl,
      ...(fresh ? { cached: true, cad_quality: true } : { deferred: true }),
      shape_sha256: deferred.shapeSha256,
      linked: deferred.linked,
      project_id: id,
    };
  }
  const force = !!(opts && opts.force);
  if (!force && existsSync(outStl) && statSync(outStl).size >= 100 && !stlNeedsCadRefresh(outStl)) {
    if (shown && proj.geometry && !proj.geometry.stl_path) {
      proj.geometry.stl_path = outStl;
      proj.geometry.stl_url = `/api/geometry/stl?project_id=${encodeURIComponent(id)}`;
      saveInBackground(proj, 'mesh input path');
    }
    return { ok: true, path: outStl, cached: true, cad_quality: true, project_id: id };
  }
  if (!existsSync(CONVERT_SCRIPT)) {
    return { ok: false, error: 'convert script missing', path: CONVERT_SCRIPT };
  }
  const cadFaces = join(partDirFor(id, aid || (proj.geometry && proj.geometry.id)), 'cad_faces.vtp');
  try {
    if (existsSync(cadFaces) && statSync(cadFaces).size >= 200) {
      runPythonSync([CONVERT_SCRIPT, '--from-vtp', cadFaces, '--out', outStl]);
    } else {
      runPythonSync([CONVERT_SCRIPT, '--step', stepPath, '--out', outStl, '--cad-quality']);
    }
  } catch (e) {
    return { ok: false, error: 'STEP→STL convert failed', detail: String(e), step_path: stepPath };
  }
  if (!existsSync(outStl) || statSync(outStl).size < 100) {
    return { ok: false, error: 'STL missing after convert', out_stl: outStl };
  }
  if (shown && proj.geometry) {
    proj.geometry.stl_path = outStl;
    proj.geometry.stl_url = `/api/geometry/stl?project_id=${encodeURIComponent(id)}`;
    proj.updated_at = new Date().toISOString();
    saveInBackground(proj, 'mesh input path');
  }
  return { ok: true, path: outStl, cached: false, project_id: id };
}

function thumbPathFor(id) {
  const proj = readProject(id);
  const aid = proj && activeGeometryId(proj);
  if (aid) return join(partDirFor(id, aid), 'thumb.png');
  const geoms = proj && Array.isArray(proj.geometries) ? proj.geometries : [];
  if (geoms[0] && geoms[0].id) return join(partDirFor(id, geoms[0].id), 'thumb.png');
  return join(geometriesRoot(projectDir(id)), 'thumb.png');
}

// Stopped at thumbRenderTimeoutMs; MAGNUSIM_TEST_THUMB_FAIL (1 or hang) runs a stand-in
// that fails or never ends (server/thumb-render.js).
const renderThumbWithPython = (args) =>
  runPython(thumbTestStandIn() || [THUMB_SCRIPT, ...args], { timeoutMs: thumbRenderTimeoutMs() });
let renderThumb = renderThumbWithPython;

/**
 * Renders at a time. Home asks for every card's picture at once, and each render is a
 * Python with VTK: a dozen at once took the machine's cores from every other request.
 */
const THUMB_RENDERS_AT_ONCE = 2;
let thumbRendersRunning = 0;
const thumbRenderQueue = [];

async function inThumbRenderSlot(fn) {
  if (thumbRendersRunning >= THUMB_RENDERS_AT_ONCE) {
    await new Promise((go) => thumbRenderQueue.push(go));
  }
  thumbRendersRunning += 1;
  try {
    return await fn();
  } finally {
    thumbRendersRunning -= 1;
    const next = thumbRenderQueue.shift();
    if (next) next();
  }
}

/** Renders running now (their process not ended yet); tests check none is left. */
export function thumbRendersRunningForTests() {
  return thumbRendersRunning;
}

/**
 * A render that failed is not tried again for THUMB_FAILED_MS while the project shows the
 * same geometry, unchanged: on a machine where the renderer cannot run, every Home visit
 * started a Python for every card, each to fail the same way. The card shows its initials.
 */
const THUMB_FAILED_MS = 5 * 60_000;
const thumbFailures = new Map();

function thumbFailureKey(id, geomId, source) {
  let age = '';
  try {
    age = String(statSync(source).mtimeMs);
  } catch {
    /* gone: its own key */
  }
  return `${id}|${geomId}|${age}`;
}

/** Tests hold the thumbnail render with a stand-in (null puts render_geometry_thumb.py back). */
export function setThumbRendererForTests(fn) {
  renderThumb = fn || renderThumbWithPython;
}

function thumbIsFresh(thumb, source) {
  if (!existsSync(thumb) || statSync(thumb).size < 80) return false;
  if (!source || !existsSync(source)) return true;
  return statSync(thumb).mtimeMs >= statSync(source).mtimeMs;
}

/** A thumbnail address's age while the picture is not made yet (thumbCacheControl). */
const THUMB_PENDING = 'pending';

/**
 * Cache-Control of a thumbnail answer, from its address's `v` (summarizeProject). Only an
 * address naming a made picture is kept: one asked for while the picture was still pending
 * (or with no `v`) is the same address for whatever the project shows next.
 */
export function thumbCacheControl(v) {
  const s = String(v || '');
  if (!s || s === THUMB_PENDING || s.endsWith('-' + THUMB_PENDING)) return 'no-store';
  return 'public, max-age=86400';
}

/** The geometry a project's thumbnail shows: its active one, else its first ('' when none). */
function thumbGeometryId(proj) {
  const aid = proj && activeGeometryId(proj);
  if (aid) return String(aid);
  const geoms = proj && Array.isArray(proj.geometries) ? proj.geometries : [];
  return String((geoms[0] && geoms[0].id) || '');
}

/**
 * Move a thumbnail rendered outside the project to `out`, unless `out` is no longer the
 * project's thumbnail: its geometry (or the project) was removed while it rendered, and
 * writing there would make the removed folder again. All synchronous, so a remove (an
 * rmSync on this thread) cannot land between the check and the copy.
 *
 * `geomId` is the geometry the render drew. A geometry removed and added again from a
 * file of the same name gets the same folder, so the same `out`: the path alone let the
 * removed part's picture land in the new geometry's folder, where it stayed (it is newer
 * than the new STEP, so it counted as current).
 */
function placeThumb(id, out, rendered, geomId) {
  const proj = readProject(id);
  if (!proj || thumbPathFor(id) !== out || !existsSync(dirname(out))) return false;
  if (geomId !== undefined && thumbGeometryId(proj) !== geomId) return false;
  try {
    copyFileSync(rendered, out);
    return true;
  } catch {
    return false;
  }
}

async function renderGeometryThumb(projectId, retried = false) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found', project_id: id } };
  const out = thumbPathFor(id);
  const geomId = thumbGeometryId(proj);
  // A linked geometry's thumbnail is a follow-up of its link job: served, never rendered here.
  if (isLinkedGeometryDir(dirname(out))) {
    const fenced = linkFenceAnswer(dirname(out));
    if (fenced) return fenced;
    if (existsSync(out) && statSync(out).size >= 80) return { ok: true, path: out, bytes: readFileSync(out), cached: true, project: proj };
    return { ok: false, status: 404, body: { error: 'no thumbnail yet', project_id: id } };
  }
  const preview = await ensureCadPreview(id);
  const source = preview.ok ? preview.faces : resolveStlPath(proj);
  if (!source) return { ok: false, status: 404, body: { error: 'no geometry imported', project_id: id } };
  const freshnessSrc = resolveStepPath(proj) || source;
  if (thumbIsFresh(out, freshnessSrc)) {
    return { ok: true, path: out, bytes: readFileSync(out), cached: true, project: proj };
  }
  if (!existsSync(THUMB_SCRIPT)) {
    return { ok: false, status: 500, body: { error: 'thumb script missing', path: THUMB_SCRIPT } };
  }
  const failKey = thumbFailureKey(id, geomId, freshnessSrc);
  const failed = thumbFailures.get(failKey);
  if (failed && Date.now() - failed.at < THUMB_FAILED_MS) {
    if (existsSync(out) && statSync(out).size > 80) {
      return { ok: true, path: out, bytes: readFileSync(out), stale: true, project: proj };
    }
    // The first failure's reason, kept: "not tried again" alone hid why.
    return { ok: false, status: 500, body: { error: 'thumb render failed', detail: `${failed.detail} (not tried again yet)`, project_id: id } };
  }
  // Rendered outside the project, then moved in by placeThumb: render_geometry_thumb.py
  // makes the folder it writes to.
  const rendered = join(tmpdir(), `magnusim-thumb-${process.pid}-${randomBytes(6).toString('hex')}.png`);
  try {
    if (preview.ok) {
      await inThumbRenderSlot(() => renderThumb(['--vtp', preview.faces, '--edges', preview.edges, '--out', rendered]));
    } else {
      await inThumbRenderSlot(() => renderThumb(['--stl', source, '--out', rendered]));
    }
    thumbFailures.delete(failKey);
  } catch (e) {
    thumbFailures.set(failKey, { at: Date.now(), detail: String(e).slice(0, 2000) });
    await removeStaged(rendered);
    if (existsSync(out) && statSync(out).size > 80) {
      return { ok: true, path: out, bytes: readFileSync(out), stale: true, project: proj };
    }
    return { ok: false, status: 500, body: { error: 'thumb render failed', detail: String(e), project_id: id } };
  }
  const made = existsSync(rendered) && statSync(rendered).size >= 80;
  const placed = made && placeThumb(id, out, rendered, geomId);
  await removeStaged(rendered);
  if (!made) {
    return { ok: false, status: 500, body: { error: 'thumb missing after render', path: out } };
  }
  if (!placed) {
    // Render what the project shows now (once); a removed project answers 404.
    if (!retried) return renderGeometryThumb(id, true);
    return { ok: false, status: 409, body: { error: 'geometry changed while its thumbnail rendered', project_id: id } };
  }
  // The Home list names the picture's age in its address (summarizeProject): list again.
  invalidateProjectsListCache();
  return { ok: true, path: out, bytes: readFileSync(out), cached: false, project: proj };
}

function ensureGeometryThumb(projectId) {
  const id = projectId || projectIdOrActive('', readActiveId) || '';
  if (thumbJobs.has(id)) return thumbJobs.get(id);
  const job = renderGeometryThumb(id).finally(() => thumbJobs.delete(id));
  thumbJobs.set(id, job);
  return job;
}

/**
 * How long a thumbnail request waits for its picture. A render of a big part takes
 * many seconds, and Home asks for every card's picture at once: requests held that
 * long fill the browser's six connections to the app, and every other request of the
 * page (a new folder, a rename) waits behind them. Past this the answer is "being
 * made" (202, not kept) while the render goes on; the card asks again.
 */
export const THUMB_WAIT_MS = 250;

/** The thumbnail, or { pending: true } when it is not made within THUMB_WAIT_MS. */
export async function geometryThumbWithin(projectId, waitMs = THUMB_WAIT_MS) {
  const job = ensureGeometryThumb(projectId);
  let timer;
  const late = new Promise((resolveLate) => {
    timer = setTimeout(() => resolveLate({ pending: true }), waitMs);
  });
  try {
    return await Promise.race([job, late]);
  } finally {
    clearTimeout(timer);
  }
}

function stlFingerprint(stlPath) {
  const buf = readFileSync(stlPath);
  const header = buf.subarray(0, 80).toString('ascii').replace(/\0+$/g, '');
  const ntri = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  const sha256 = createHash('sha256').update(buf).digest('hex');
  let meta = null;
  const metaPath = stlPath.replace(/\.stl$/i, '.json');
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  const bounds = meta && meta.bounds ? meta.bounds : null;
  const nPoints = bounds && bounds.nx != null ? bounds.nx : null;
  return {
    bytes: buf.length,
    header,
    ntri,
    nPoints,
    nCells: ntri,
    bounds,
    sha256,
    mesh_checksum: sha256.slice(0, 16),
    empty: !(ntri > 100),
    convert_meta: meta,
  };
}

async function materializePartStep(opts, destDir, originalName, kind, lengthUnit) {
  mkdirSync(destDir, { recursive: true });
  let stepPath = opts.step_path ? String(opts.step_path).trim() : '';
  let stepSource = 'path';
  let normalizeInfo = null;
  let originalPath = null;

  const writeNormalized = async (srcPath) => {
    const dest = join(destDir, 'source.step');
    if (!existsSync(NORMALIZE_SCRIPT)) {
      return { ok: false, status: 500, body: { error: 'normalize script missing', path: NORMALIZE_SCRIPT } };
    }
    try {
      const rpc = callWorker('cad.normalize', { src: srcPath, dest, unit: lengthUnit }, 180000);
      if (rpc) {
        try {
          normalizeInfo = await rpc;
        } catch {
          normalizeInfo = null;
        }
      }
      if (!normalizeInfo || !normalizeInfo.ok) {
        const ran = await runPython([
          NORMALIZE_SCRIPT,
          '--in',
          srcPath,
          '--out',
          dest,
          '--unit',
          lengthUnit,
        ]);
        normalizeInfo = parseNormalizeStdout(ran.stdout);
      }
    } catch (e) {
      return { ok: false, status: 400, body: { error: 'could not read geometry', detail: String(e), filename: originalName } };
    }
    const deferred = !!(normalizeInfo && normalizeInfo.step_deferred);
    const present = deferred
      ? existsSync(geometrySidecarPath(dest))
      : existsSync(dest) && statSync(dest).size >= 32;
    if (!present) {
      return { ok: false, status: 500, body: { error: 'STEP missing after convert', dest } };
    }
    return { ok: true, dest, deferred };
  };

  if (opts.file_bytes || opts.step_base64 || opts.file_base64) {
    stepSource = 'upload';
    const raw = opts.file_bytes
      ? Buffer.from(opts.file_bytes)
      : Buffer.from(String(opts.step_base64 || opts.file_base64), 'base64');
    if (raw.length < 32) {
      return { ok: false, status: 400, body: { error: 'uploaded file too small / empty' } };
    }
    if (kind === 'step' || !kind) {
      stepPath = join(destDir, 'source.step');
      writeFileSync(stepPath, raw);
    } else {
      originalPath = join(destDir, 'original' + (extOfName(originalName) || '.bin'));
      writeFileSync(originalPath, raw);
      clearStaleOriginals(destDir, originalPath);
      const conv = await writeNormalized(originalPath);
      if (!conv.ok) return conv;
      stepPath = conv.dest;
    }
  } else if (stepPath) {
    if (!existsSync(stepPath)) {
      return { ok: false, status: 404, body: { error: 'file not found', step_path: stepPath } };
    }
    const srcKind = cadKindOfName(stepPath) || kind;
    if (srcKind === 'step' || !srcKind) {
      const dest = join(destDir, 'source.step');
      copyFileSync(stepPath, dest);
      stepPath = dest;
    } else {
      originalPath = join(destDir, 'original' + (extOfName(stepPath) || extOfName(originalName) || '.bin'));
      copyFileSync(stepPath, originalPath);
      clearStaleOriginals(destDir, originalPath);
      const conv = await writeNormalized(originalPath);
      if (!conv.ok) return conv;
      stepPath = conv.dest;
    }
  } else if (existsSync(DEFAULT_STEP)) {
    stepPath = join(destDir, 'source.step');
    copyFileSync(DEFAULT_STEP, stepPath);
    stepSource = 'default-vortex';
  } else {
    return {
      ok: false,
      status: 400,
      body: { error: 'step_path or step_base64 required', default_step_missing: DEFAULT_STEP },
    };
  }
  return { ok: true, stepPath, stepSource, originalPath, normalizeInfo };
}

function partNote(kind, originalName, lengthUnit, watertight) {
  if (kind === 'iges' || kind === 'brep') {
    let note = 'Imported as CAD and stored as STEP for meshing.';
    if (!watertight) note += ' Open shells — meshing needs a closed solid.';
    return note;
  }
  if (kind === 'mesh') {
    let note = 'Tessellated import (' + extOfName(originalName).replace('.', '') + ', ' + lengthUnit + ').';
    note += watertight
      ? ' Closed solid written as STEP.'
      : ' Not a closed solid — viewport only until the mesh is watertight.';
    return note;
  }
  return 'STEP stored as CAD. Not tessellated to STL on import.';
}

export async function importGeometry(opts) {
  if (opts && (opts.as_modifier === true || opts.role === 'modifier')) {
    return importModifier(opts);
  }
  ensureProjectsRoot();
  const projectId = String(opts.project_id || projectIdOrActive('', readActiveId) || '').trim();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project; create project first', soft_pass: false } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }

  const replace = String(opts.mode || '').toLowerCase() === 'replace';
  let stepPathHint = opts.step_path ? String(opts.step_path).trim() : '';
  const originalName = opts.filename || (stepPathHint ? basename(stepPathHint) : 'geometry.step');
  const kind = cadKindOfName(originalName) || (stepPathHint ? cadKindOfName(stepPathHint) : 'step');
  if (!kind) {
    return {
      ok: false,
      status: 400,
      body: { error: 'unsupported CAD format — use STEP, IGES, BREP, STL, OBJ or PLY', filename: originalName },
    };
  }
  const lengthUnit = String(opts.length_unit || opts.unit || 'MM').trim() || 'MM';
  const geomName =
    String(originalName || 'Vortex CFD Test.step')
      .replace(/\.(step|stp|iges|igs|brep|brp|stl|obj|ply)$/i, '')
      .trim() || 'Vortex CFD Test';

  let parts = replace ? [] : migrateLegacyToParts(proj);
  if (replace) {
    try {
      rmSync(geometriesRoot(projectDir(projectId)), { recursive: true, force: true });
      mkdirSync(geometriesRoot(projectDir(projectId)), { recursive: true });
    } catch {
      /* first import */
    }
  }

  const geomId = newGeomId();
  const created = createGeometryFolder(projectDir(projectId), {
    id: geomId,
    name: geomName,
    original_filename: originalName,
  });
  const destDir = created.dir;
  const wrote = await materializePartStep(opts, destDir, originalName, kind, lengthUnit);
  if (!wrote.ok) {
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return wrote;
  }

  const nSolids = Math.max(1, Number((wrote.normalizeInfo && wrote.normalizeInfo.n_solids) || 1));
  const watertight =
    wrote.normalizeInfo && wrote.normalizeInfo.watertight != null
      ? !!wrote.normalizeInfo.watertight
      : nSolids > 0;
  const tessellated = kind === 'mesh';
  const part = {
    id: geomId,
    name: geomName,
    original_filename: originalName,
    original_path: wrote.originalPath,
    source_kind: kind || 'step',
    length_unit: kind === 'mesh' ? lengthUnit : null,
    representation: tessellated ? 'mesh' : 'step',
    tessellated,
    watertight,
    step_path: wrote.stepPath,
    n_solids: nSolids,
    n_faces: (wrote.normalizeInfo && wrote.normalizeInfo.n_faces) || null,
    body_offset: 0,
    imported_at: new Date().toISOString(),
    note: partNote(kind, originalName, lengthUnit, watertight),
  };
  parts = parts.concat([part]);

  const persisted = await persistActiveGeometry(proj, parts, geomId, wrote.stepSource);
  if (!persisted.ok) {
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return persisted;
  }
  if (wrote.normalizeInfo && wrote.normalizeInfo.step_deferred) writeDeferredStepLater(wrote.stepPath);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      project_id: projectId,
      project: persisted.project,
      geometry: persisted.geometry,
      geometries: persisted.geometries,
      added: part,
      active_geometry_id: persisted.active_geometry_id,
      tree: { geometry_name: persisted.geometry && persisted.geometry.name, volume: (persisted.geometry && persisted.geometry.volume) || 'Body1' },
      increment: 'W16',
      soft_pass_avoided: true,
      tessellated,
    },
  };
}

async function importModifier(opts) {
  ensureProjectsRoot();
  const projectId = String((opts && opts.project_id) || projectIdOrActive('', readActiveId) || '').trim();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project; create project first' } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const parts = migrateLegacyToParts(proj);
  const hostId = String((opts && (opts.host_geometry_id || opts.geometry_id || opts.host_id)) || proj.active_geometry_id || '').trim();
  const host = parts.find((p) => p.id === hostId) || parts[0] || null;
  if (!host) {
    return { ok: false, status: 400, body: { error: 'import a geometry first, then add a modifier to it' } };
  }
  const stepPathHint = opts.step_path ? String(opts.step_path).trim() : '';
  const originalName = opts.filename || (stepPathHint ? basename(stepPathHint) : 'modifier.step');
  const kind = cadKindOfName(originalName) || (stepPathHint ? cadKindOfName(stepPathHint) : 'step');
  if (!kind) {
    return {
      ok: false,
      status: 400,
      body: { error: 'unsupported CAD format — use STEP, IGES, BREP, STL, OBJ or PLY', filename: originalName },
    };
  }
  const lengthUnit = String(opts.length_unit || opts.unit || 'MM').trim() || 'MM';
  const modName =
    String(originalName || 'Modifier')
      .replace(/\.(step|stp|iges|igs|brep|brp|stl|obj|ply)$/i, '')
      .trim() || 'Modifier';
  const modId = newModId();
  const destDir = modifierDirFor(projectId, host.id, modId);
  const wrote = await materializePartStep(opts, destDir, originalName, kind, lengthUnit);
  if (!wrote.ok) {
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return wrote;
  }
  const preview = await ensureCadPreviewAt(projectId, wrote.stepPath, modifierCadPaths(projectId, host.id, modId));
  if (!preview.ok) {
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return preview;
  }
  let modMeta = null;
  let hostMeta = null;
  try {
    if (existsSync(preview.meta)) modMeta = JSON.parse(readFileSync(preview.meta, 'utf8'));
  } catch {
    modMeta = null;
  }
  try {
    const hostMetaPath = cadPaths(projectId, host.id).meta;
    if (existsSync(hostMetaPath)) hostMeta = JSON.parse(readFileSync(hostMetaPath, 'utf8'));
  } catch {
    hostMeta = null;
  }
  const nSolids = Math.max(1, Number((modMeta && modMeta.n_solids) || (wrote.normalizeInfo && wrote.normalizeInfo.n_solids) || 1));
  const rec = {
    id: modId,
    name: modName,
    original_filename: originalName,
    source_kind: kind || 'step',
    length_unit: kind === 'mesh' ? lengthUnit : null,
    step_path: wrote.stepPath,
    n_solids: nSolids,
    translation: boundsTranslationBeside(hostMeta && hostMeta.bounds, modMeta && modMeta.bounds),
    rotation: [0, 0, 0],
    opacity: 0.38,
    imported_at: new Date().toISOString(),
    note: 'Translucent modifier on this geometry. Not meshed until applied.',
  };
  host.modifiers = (Array.isArray(host.modifiers) ? host.modifiers : []).concat([rec]);
  const persisted = await persistActiveGeometry(proj, parts, host.id, 'modifier');
  if (!persisted.ok) {
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return persisted;
  }
  if (wrote.normalizeInfo && wrote.normalizeInfo.step_deferred) writeDeferredStepLater(wrote.stepPath);
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      role: 'modifier',
      project_id: projectId,
      project: persisted.project,
      geometry: persisted.geometry,
      geometries: persisted.geometries,
      modifier: publicModifier(projectId, host.id, rec),
      host_geometry_id: host.id,
      active_geometry_id: persisted.active_geometry_id,
      increment: 'W16',
    },
  };
}

async function transformModifier(opts) {
  ensureProjectsRoot();
  const projectId = String((opts && opts.project_id) || projectIdOrActive('', readActiveId) || '').trim();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project' } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const hostId = String((opts && (opts.host_geometry_id || opts.geometry_id)) || proj.active_geometry_id || '').trim();
  const modId = String((opts && (opts.modifier_id || opts.id)) || '').trim();
  const host = geometriesOf(proj).find((p) => p.id === hostId) || null;
  const rec = findModifierOnPart(host, modId);
  if (!host || !rec) {
    return { ok: false, status: 404, body: { error: 'modifier not found', geometry_id: hostId, modifier_id: modId } };
  }
  if (opts.translation) rec.translation = normalizeTranslation(opts.translation);
  if (opts.rotation) rec.rotation = Array.isArray(opts.rotation) ? opts.rotation : rec.rotation;
  if (opts.opacity != null) rec.opacity = Number(opts.opacity);
  if (opts.name) rec.name = String(opts.name);
  proj.updated_at = new Date().toISOString();
  if (proj.geometry && proj.geometry.id === host.id) {
    proj.geometry.modifiers = (host.modifiers || []).map((m) => publicModifier(projectId, host.id, m)).filter(Boolean);
  }
  if (!(await saveUnlessDeleted(proj))) return projectDeletedAnswer(projectId);
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      project_id: projectId,
      geometry: proj.geometry,
      geometries: proj.geometries,
      modifier: publicModifier(projectId, host.id, rec),
    },
  };
}

async function removeModifier(opts) {
  ensureProjectsRoot();
  const projectId = String((opts && opts.project_id) || projectIdOrActive('', readActiveId) || '').trim();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project' } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const hostId = String((opts && (opts.host_geometry_id || opts.geometry_id)) || proj.active_geometry_id || '').trim();
  const modId = String((opts && (opts.modifier_id || opts.id || opts.delete)) || '').trim();
  const host = geometriesOf(proj).find((p) => p.id === hostId) || null;
  if (!host || !findModifierOnPart(host, modId)) {
    return { ok: false, status: 404, body: { error: 'modifier not found', geometry_id: hostId, modifier_id: modId } };
  }
  host.modifiers = (host.modifiers || []).filter((m) => m && m.id !== modId);
  try {
    rmSync(modifierDirFor(projectId, host.id, modId), { recursive: true, force: true });
  } catch {
    /* folder may already be gone */
  }
  proj.updated_at = new Date().toISOString();
  if (proj.geometry && proj.geometry.id === host.id) {
    proj.geometry.modifiers = (host.modifiers || []).map((m) => publicModifier(projectId, host.id, m)).filter(Boolean);
  }
  if (!(await saveUnlessDeleted(proj))) return projectDeletedAnswer(projectId);
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      deleted: true,
      project_id: projectId,
      geometry: proj.geometry,
      geometries: proj.geometries,
      removed: modId,
    },
  };
}

async function removeGeometry(opts) {
  ensureProjectsRoot();
  const projectId = String((opts && opts.project_id) || projectIdOrActive('', readActiveId) || '').trim();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project' } };
  }
  // The plugin studies whose target it is (API 1.7) are marked first, before the project
  // this call writes is read: their next link asks before it adds a geometry.
  const markId = String((opts && (opts.geometry_id || opts.id)) || '').trim();
  if (markId && readProject(projectId)) await markRemovedStudies(projectId, markId);
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const geomId = String((opts && (opts.geometry_id || opts.id)) || '').trim();
  if (!geomId) {
    return { ok: false, status: 400, body: { error: 'geometry_id required' } };
  }
  let parts = migrateLegacyToParts(proj);
  const found = parts.find((p) => p.id === geomId);
  if (!found) {
    return { ok: false, status: 404, body: { error: 'geometry not in project', geometry_id: geomId } };
  }
  parts = parts.filter((p) => p.id !== geomId);
  const destDir = partDirFor(projectId, geomId);
  // A linked geometry (API 1.5): marked removed first, so no follow-up or repair brings it
  // back; its queued update leaves the queue and a running one before its commit stops.
  onGeometryRemove(projectId, geomId, destDir);
  try {
    // Before the catalog save below: its walk must not find this geometry's studies.
    // Retried as a study folder's remove is: the worker may be reading a file in it.
    removeTreeSync(destDir, { maxRetries: 8, retryDelay: 50 });
  } catch {
    /* folder may already be gone */
  }
  const nextActive =
    proj.active_geometry_id && proj.active_geometry_id !== geomId
      ? proj.active_geometry_id
      : (parts[0] && parts[0].id) || null;
  const persisted = await persistActiveGeometry(proj, parts, nextActive, 'removed');
  if (!persisted.ok) return persisted;
  try {
    const { dropGeometryStudies } = await import('./w17-simulation.js');
    dropGeometryStudies(projectId, persisted.project, geomId);
  } catch (_) {}
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      project_id: projectId,
      project: persisted.project,
      geometry: persisted.geometry,
      geometries: persisted.geometries || [],
      active_geometry_id: persisted.active_geometry_id || null,
      removed: geomId,
    },
  };
}

async function activateGeometry(opts) {
  ensureProjectsRoot();
  const projectId = String((opts && opts.project_id) || projectIdOrActive('', readActiveId) || '').trim();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project' } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const geomId = String((opts && (opts.geometry_id || opts.id)) || '').trim();
  if (!geomId) {
    return { ok: false, status: 400, body: { error: 'geometry_id required' } };
  }
  const parts = migrateLegacyToParts(proj);
  if (!parts.find((p) => p.id === geomId)) {
    return { ok: false, status: 404, body: { error: 'geometry not in project', geometry_id: geomId } };
  }
  const persisted = await persistActiveGeometry(proj, parts, geomId, 'activate');
  if (!persisted.ok) return persisted;
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      project_id: projectId,
      project: persisted.project,
      geometry: persisted.geometry,
      geometries: persisted.geometries || [],
      active_geometry_id: persisted.active_geometry_id,
    },
  };
}

/**
 * A modifier's preview file, or { pending: true } while it is being made (CAD_WAIT_MS).
 * No page asks for one today (GET /api/geometry/cad?modifier_id): it is answered as the
 * geometry's own preview is.
 */
async function readCadForModifier(projectId, geomId, modId, part) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
  const aid = geomId || (proj && activeGeometryId(proj));
  const host = geometriesOf(proj).find((p) => p.id === aid) || null;
  const rec = findModifierOnPart(host, modId);
  if (!host || !rec) {
    return { ok: false, status: 404, body: { error: 'modifier not found', geometry_id: aid, modifier_id: modId } };
  }
  const paths = modifierCadPaths(id, host.id, rec.id);
  const preview = await withinCadWait(ensureCadPreviewAt(id, rec.step_path, paths, { polled: true }));
  if (preview.pending) return preview;
  if (!preview.ok) return preview;
  const file = part === 'edges' ? paths.edges : part === 'meta' ? paths.meta : paths.faces;
  if (!existsSync(file)) return { ok: false, status: 404, body: { error: 'modifier CAD missing', path: file } };
  if (part === 'meta') {
    try {
      return { ok: true, meta: JSON.parse(readFileSync(file, 'utf8')), project_id: id };
    } catch (e) {
      return { ok: false, status: 500, body: { error: 'modifier meta unreadable', detail: String(e) } };
    }
  }
  return { ok: true, path: file, bytes: readFileSync(file), project_id: id, part };
}

function readCadForProject(projectId, part, geomId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
  const aid = geomId || (proj && activeGeometryId(proj));
  const paths = cadPaths(id, aid || null);
  const live = cadPaths(id, null);
  const file = part === 'edges' ? paths.edges : paths.faces;
  const fallback = part === 'edges' ? live.edges : live.faces;
  const pick = existsSync(file) ? file : fallback;
  if (!existsSync(pick)) return { ok: false, status: 404, body: { error: 'CAD preview missing', part, path: file } };
  return { ok: true, path: pick, bytes: readFileSync(pick), project_id: id, part };
}

function readStlForProject(projectId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
  const aid = proj && activeGeometryId(proj);
  const fenced = aid ? linkFenceAnswer(cadPaths(id, aid).dir) : null;
  if (fenced) return fenced;
  if (!proj || !proj.geometry || !proj.geometry.stl_path) {
    return { ok: false, status: 404, body: { error: 'no geometry imported', project_id: id } };
  }
  const p = proj.geometry.stl_path;
  if (!existsSync(p)) return { ok: false, status: 404, body: { error: 'stl missing on disk', path: p } };
  return { ok: true, path: p, bytes: readFileSync(p), project: proj };
}

function readBinaryBody(req) {
  return new Promise((resolveP, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveP(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Vite middleware handler for /api/project* and /api/geometry*.
 * Returns true if handled.
 */
export async function handleW16Api(req, res, u, parts, helpers) {
  const { sendJson, readJsonBody } = helpers;

  // ---- /api/folders ----
  if (parts[0] === 'api' && parts[1] === 'folders') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, 200, { ok: true, folders: listFolders(), increment: 'W26' });
    }
    if (req.method === 'POST') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      if (body.delete || body.action === 'delete') {
        const result = deleteFolder(body.name || body.folder || body.delete);
        return sendJson(res, result.status, result.body);
      }
      const result = createFolder(body.name || body.folder || body.title);
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 405, { error: 'method not allowed for /api/folders' });
  }

  // ---- /api/projects (list) ----
  if (parts[0] === 'api' && parts[1] === 'projects' && (req.method === 'GET' || req.method === 'HEAD')) {
    const now = Date.now();
    if (projectsListCache.body && now - projectsListCache.at < PROJECTS_LIST_TTL_MS) {
      return sendJson(res, 200, projectsListCache.body);
    }
    const active = readActiveId();
    const raw = listProjects();
    const body = {
      ok: true,
      projects: raw.map(summarizeProject),
      folders: listFolders(raw),
      active_project_id: active,
      projects_root: PROJECTS_ROOT,
      increment: 'W26',
    };
    projectsListCache = { at: now, body };
    return sendJson(res, 200, body);
  }

  // ---- /api/project ----
  if (parts[0] === 'api' && parts[1] === 'project') {
    if (req.method === 'POST' && parts[2] === 'move') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const id = String(body.project_id || body.id || '').trim();
      const result = await moveProject(id, body.folder);
      if (result.ok) res.setHeader('X-CFD-Project-Id', id);
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && parts[2] === 'update') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const id = String(body.project_id || body.id || '').trim();
      const result = await updateProject(id, body);
      if (result.ok) res.setHeader('X-CFD-Project-Id', id);
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && parts[2] === 'delete') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const id = String(body.project_id || body.id || '').trim();
      const result = deleteProject(id);
      if (result.ok) res.setHeader('X-CFD-Project-Id', id);
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && parts[2] === 'sample') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const result = await createProjectFromSample(body);
      res.setHeader('X-CFD-Source', 'project-sample');
      if (result.ok && 'id' in result.body) res.setHeader('X-CFD-Project-Id', result.body.id);
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && parts[2] === 'open') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const id = String(body.project_id || body.id || '').trim();
      const result = openProject(id);
      if (result.ok) res.setHeader('X-CFD-Project-Id', id);
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && !parts[2]) {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const result = await createProject(body);
      res.setHeader('X-CFD-Source', 'project-create');
      if (result.ok && 'id' in result.body) res.setHeader('X-CFD-Project-Id', result.body.id);
      return sendJson(res, result.status, result.body);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
      // A tab that knows its project pins it; the shared "active" project is
      // only a fallback (it is rewritten by whichever tab opened last).
      const pinned = String(u.searchParams.get('project_id') || '').trim();
      const result = pinned ? getProjectById(pinned) : getActiveProject();
      if (result.ok && result.body.project) result.body.project = projectForRead(result.body.project);
      res.setHeader('X-CFD-Source', 'project-get');
      if (result.body.project && result.body.project.id) {
        res.setHeader('X-CFD-Project-Id', result.body.project.id);
      }
      return sendJson(res, result.status, result.body);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && parts[2]) {
      const proj = ensureGeometriesHydrated(readProject(parts[2]));
      if (!proj) return sendJson(res, 404, { error: 'project not found', id: parts[2] });
      return sendJson(res, 200, { ok: true, project: projectForRead(proj), increment: 'W16' });
    }
    return sendJson(res, 405, { error: 'method not allowed for /api/project' });
  }

  // ---- /api/geometry ----
  if (parts[0] === 'api' && parts[1] === 'geometry') {
    if (parts[2] === 'import' && req.method === 'POST') {
      const ctype = String(req.headers['content-type'] || '');
      let opts = {};
      try {
        if (ctype.includes('application/json')) {
          opts = await readJsonBody(req);
        } else if (ctype.includes('application/octet-stream') || ctype.includes('application/step')) {
          // The file itself is the body (no base64); options ride on the query string.
          const q = u.searchParams;
          const opt = (key, header) => q.get(key) || (header ? req.headers[header] : undefined) || undefined;
          const buf = await readBinaryBody(req);
          opts = {
            project_id: opt('project_id', 'x-cfd-project-id'),
            filename: opt('filename', 'x-cfd-filename') || 'upload.step',
            length_unit: opt('length_unit'),
            mode: opt('mode'),
            role: opt('role'),
            host_geometry_id: opt('host_geometry_id'),
            file_bytes: buf,
          };
        } else {
          // try JSON anyway
          opts = await readJsonBody(req);
        }
      } catch (e) {
        const tooBig = e && e.status === 413;
        return sendJson(res, tooBig ? 413 : 400, {
          error: tooBig ? 'file too large to upload' : 'invalid body',
          detail: String(e),
        });
      }
      const result = await importGeometry(opts);
      res.setHeader('X-CFD-Source', 'geometry-import');
      if (result.ok) {
        res.setHeader('X-CFD-Project-Id', result.body.project_id);
        res.setHeader('X-CFD-Geometry-Body', 'Body1');
      }
      return sendJson(res, result.status, result.body);
    }
    if ((parts[2] === 'remove' || parts[2] === 'delete') && req.method === 'POST') {
      let opts = {};
      try {
        opts = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid body', detail: String(e) });
      }
      const result = await removeGeometry(opts);
      res.setHeader('X-CFD-Source', 'geometry-remove');
      if (result.ok) res.setHeader('X-CFD-Project-Id', result.body.project_id);
      return sendJson(res, result.status, result.body);
    }
    if (parts[2] === 'modifier' && req.method === 'POST') {
      let opts = {};
      try {
        opts = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid body', detail: String(e) });
      }
      if (opts && (opts.delete === true || opts.action === 'delete' || opts.remove === true)) {
        const result = await removeModifier(opts);
        res.setHeader('X-CFD-Source', 'geometry-modifier-remove');
        return sendJson(res, result.status, result.body);
      }
      const result = await transformModifier(opts);
      res.setHeader('X-CFD-Source', 'geometry-modifier-transform');
      return sendJson(res, result.status, result.body);
    }
    // Faces that are the same surface on two geometries of the project (source id -> target id).
    if (parts[2] === 'face-map' && (req.method === 'GET' || req.method === 'HEAD')) {
      const pid = u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const from = String(u.searchParams.get('from') || '').trim();
      const to = String(u.searchParams.get('to') || '').trim();
      if (!pid || !from || !to) return sendJson(res, 400, { error: 'project_id, from and to required' });
      const proj = readProject(pid);
      const ids = new Set(geometriesOf(proj).map((g) => String(g.id)));
      if (!ids.has(from) || !ids.has(to)) {
        return sendJson(res, 404, { error: 'geometry not in project', from, to });
      }
      const fenced = linkFenceAnswer(cadPaths(pid, from).dir) || linkFenceAnswer(cadPaths(pid, to).dir);
      if (fenced) return sendJson(res, fenced.status, fenced.body);
      const map = matchFaces(readPreviewFaces(cadPaths(pid, from).dir), readPreviewFaces(cadPaths(pid, to).dir));
      res.setHeader('X-CFD-Source', 'geometry-face-map');
      return sendJson(res, 200, { ok: true, project_id: pid, from, to, map: Object.fromEntries(map) });
    }
    if (parts[2] === 'activate' && req.method === 'POST') {
      let opts = {};
      try {
        opts = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid body', detail: String(e) });
      }
      const result = await activateGeometry(opts);
      res.setHeader('X-CFD-Source', 'geometry-activate');
      if (result.ok) res.setHeader('X-CFD-Project-Id', result.body.project_id);
      return sendJson(res, result.status, result.body);
    }
    // A preview not made within CAD_WAIT_MS is answered "being prepared" (202, Retry-After)
    // while it is made: the page asks again (src/workbench/cadPreviewWait.ts).
    if (parts[2] === 'cad' && (req.method === 'GET' || req.method === 'HEAD')) {
      const pid = u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const geomId = String(u.searchParams.get('geometry_id') || '').trim() || undefined;
      const modId = String(u.searchParams.get('modifier_id') || '').trim();
      const partRaw = String(u.searchParams.get('part') || 'faces').toLowerCase();
      if (modId) {
        const part = partRaw === 'edges' ? 'edges' : partRaw === 'meta' || partRaw === 'preview' ? 'meta' : 'faces';
        const got = await readCadForModifier(pid, geomId, modId, part);
        if (got.pending) return sendCadPending(req, res, sendJson, pid);
        if (!got.ok) return sendJson(res, got.status || 404, got.body || { error: 'modifier CAD failed' });
        if (part === 'meta') {
          res.setHeader('X-CFD-Source', 'geometry-modifier-cad-preview');
          res.setHeader('Cache-Control', 'no-store');
          return sendJson(res, 200, got.meta);
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('Content-Length', String(got.bytes.length));
        res.setHeader('X-CFD-Source', 'geometry-modifier-cad');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'HEAD') {
          res.end();
          return true;
        }
        res.end(got.bytes);
        return true;
      }
      if (partRaw === 'preview' || partRaw === 'meta') {
        const preview = await ensureCadPreviewWithin(pid, geomId);
        if (preview.pending) return sendCadPending(req, res, sendJson, pid);
        if (!preview.ok) return sendJson(res, preview.status || 404, preview.body || { error: 'CAD preview failed' });
        const metaPath = preview.meta || cadPaths(pid, geomId).meta;
        if (!existsSync(metaPath)) return sendJson(res, 404, { error: 'CAD preview meta missing' });
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          res.setHeader('X-CFD-Source', 'geometry-cad-preview');
          res.setHeader('X-CFD-Project-Id', pid || '');
          // The page's viewport reads the shown geometry's face table and, for the project's
          // active one, takes it as the active face table too (not downloaded twice).
          res.setHeader('X-CFD-Active-Geometry', preview.active ? '1' : '0');
          res.setHeader('Cache-Control', 'no-store');
          return sendJson(res, 200, meta);
        } catch (e) {
          return sendJson(res, 500, { error: 'CAD preview meta unreadable', detail: String(e) });
        }
      }
      const part = partRaw === 'edges' ? 'edges' : 'faces';
      const preview = await ensureCadPreviewWithin(pid, geomId);
      if (preview.pending) return sendCadPending(req, res, sendJson, pid);
      if (!preview.ok) return sendJson(res, preview.status || 404, preview.body || { error: 'CAD preview failed' });
      const got = readCadForProject(pid, part, geomId);
      if (!got.ok) return sendJson(res, got.status, got.body);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Length', String(got.bytes.length));
      res.setHeader('X-CFD-Source', 'geometry-cad');
      res.setHeader('X-CFD-Cad-Part', part);
      res.setHeader('X-CFD-Project-Id', pid || '');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      res.end(got.bytes);
      return true;
    }
    if (parts[2] === 'stl' && (req.method === 'GET' || req.method === 'HEAD')) {
      const pid = u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const got = readStlForProject(pid);
      if (!got.ok) return sendJson(res, got.status, got.body);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'model/stl');
      res.setHeader('Content-Length', String(got.bytes.length));
      res.setHeader('X-CFD-Source', 'geometry-stl');
      res.setHeader('X-CFD-Project-Id', pid || '');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      res.end(got.bytes);
      return true;
    }
    if (parts[2] === 'thumb' && (req.method === 'GET' || req.method === 'HEAD')) {
      const pid = u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const got = await geometryThumbWithin(pid);
      if (got.pending) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '2');
        return sendJson(res, 202, { ok: false, pending: true, error: 'The thumbnail is being made.', project_id: pid || '' });
      }
      if (!got.ok) {
        // An image request (a Home card's <img>, a fetch asking for image/*) gets "no picture"
        // (204), not an error status: the browser logs every 4xx/5xx of an image as a console
        // error, and the card shows its initials either way. Others keep the real status.
        if (/\bimage\//i.test(String(req.headers.accept || ''))) {
          res.statusCode = 204;
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-CFD-Thumb', String((got.body && got.body.error) || 'no thumbnail').slice(0, 120));
          res.end();
          return true;
        }
        return sendJson(res, got.status, got.body);
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(got.bytes.length));
      res.setHeader('X-CFD-Source', 'geometry-thumb');
      res.setHeader('X-CFD-Project-Id', pid || '');
      res.setHeader('Cache-Control', thumbCacheControl(u.searchParams.get('v')));
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      res.end(got.bytes);
      return true;
    }
    return sendJson(res, 404, { error: 'unknown /api/geometry route', path: u.pathname });
  }

  return false;
}

export const W16_META = {
  increment: 'W16',
  projects_root: PROJECTS_ROOT,
  default_step: DEFAULT_STEP,
  convert_script: CONVERT_SCRIPT,
  python: PYTHON,
};
