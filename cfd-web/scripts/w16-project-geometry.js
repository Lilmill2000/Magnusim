/**
 * W16 — project create + geometry import (filesystem persistence).
 * Projects live under cfd-web/projects/<id>/project.json + geometry/.
 * Each import is kept under geometry/parts/<id>/ (own STEP + CAD preview).
 * Only the active geometry is copied to geometry/source.step and shown in
 * the viewport. Separate files are never compounded. Multi-solid inside one
 * STEP still appears together. Compare can show two meshes side by side.
 * IGES / BREP / STL / OBJ / PLY are normalized per part. Body1.stl is
 * created only when a mesh is generated.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON, pyTool } from './python-env.js';
import {
  activeGeometryId,
  geometriesOf,
  matchesGeometry,
  matchesStudy,
  primaryGeometryId,
} from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation } from './w17-sim-catalog.js';
import { envGet } from './env-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');
const CONVERT_SCRIPT = pyTool('convert_step_to_stl.py');
const CAD_PREVIEW_SCRIPT = pyTool('export_step_cad_preview.py');
const NORMALIZE_SCRIPT = pyTool('normalize_cad_import.py');
const THUMB_SCRIPT = pyTool('render_geometry_thumb.py');
const DEFAULT_STEP = String(envGet('DEFAULT_STEP') || '').trim();
const thumbJobs = new Map();

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

function writeActiveId(id) {
  ensureProjectsRoot();
  writeFileSync(ACTIVE_PATH, JSON.stringify({ project_id: id, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  try {
    if (activeProjectListener) activeProjectListener(id || null);
  } catch (_) {}
}

function projectDir(id) {
  return join(PROJECTS_ROOT, id);
}

function projectJsonPath(id) {
  return join(projectDir(id), 'project.json');
}

function readProject(id) {
  const p = projectJsonPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeProject(proj) {
  const dir = projectDir(proj.id);
  mkdirSync(join(dir, 'geometry'), { recursive: true });
  writeFileSync(projectJsonPath(proj.id), JSON.stringify(proj, null, 2), 'utf8');
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
  const meshJson = proj.mesh && (proj.mesh.mesh_json || join(projectDir(proj.id), 'mesh.json'));
  if (meshJson && existsSync(meshJson)) {
    try {
      const m = JSON.parse(readFileSync(meshJson, 'utf8'));
      const entries = Array.isArray(m.meshes) && m.meshes.length ? m.meshes : [m];
      const generatedEntry = entries.find(
        (x) => x && (x.generated || (x.live_mesh_result && x.live_mesh_result.n_cells)),
      );
      mesh_cells =
        (generatedEntry && generatedEntry.live_mesh_result && generatedEntry.live_mesh_result.n_cells) ||
        (m.live_mesh_result && m.live_mesh_result.n_cells) ||
        m.n_cells ||
        null;
      has_mesh = !!(generatedEntry || m.generated || mesh_cells);
      const job = meshJobFromDoc(m, proj.id);
      meshing = job.meshing;
      mesh_started_at = job.mesh_started_at;
    } catch {
      has_mesh = !!proj.mesh;
    }
  } else if (proj.mesh) {
    has_mesh = true;
  }
  const run = proj.run_1 || null;
  const has_geometry = !!(
    (proj.geometry && (proj.geometry.name || proj.geometry.step_path || proj.geometry.stl_path)) ||
    (Array.isArray(proj.geometries) && proj.geometries.length)
  );
  const thumbFile = join(projectDir(proj.id), 'geometry', 'thumb.png');
  let thumb_url = null;
  if (has_geometry) {
    const v = existsSync(thumbFile) ? Math.floor(statSync(thumbFile).mtimeMs) : 'pending';
    thumb_url = `/api/geometry/thumb?project_id=${encodeURIComponent(proj.id)}&v=${v}`;
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
    has_run: !!(run && (run.status || run.run_id)),
    run_status: (run && run.status) || null,
    simulating: !!(run && String(run.status || '').toLowerCase() === 'running'),
  };
}

let projectsListCache = { at: 0, body: null };
const PROJECTS_LIST_TTL_MS = 800;

function invalidateProjectsListCache() {
  projectsListCache = { at: 0, body: null };
}

function listProjects() {
  ensureProjectsRoot();
  const out = [];
  for (const name of readdirSync(PROJECTS_ROOT)) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const p = projectJsonPath(name);
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
  return { ok: true, status: 201, body: { ok: true, folder, folders, root: ROOT_FOLDER } };
}

function moveProject(id, folder) {
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
  writeProject(proj);
  return {
    ok: true,
    status: 200,
    body: { ok: true, project: summarizeProject(proj), folder: dest, root: ROOT_FOLDER },
  };
}

function updateProject(id, body) {
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
  writeProject(proj);
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

function deleteProject(id) {
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
  rmSync(abs, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  if (readActiveId() === id) {
    writeActiveId(null);
  }
  invalidateProjectsListCache();
  return { ok: true, status: 200, body: { ok: true, deleted: id, title: proj.title || id } };
}

function createProject(body) {
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
    projects_root: PROJECTS_ROOT,
    project_json: projectJsonPath(id),
    soft_pass_avoided: true,
    increment: 'W16',
  };
  writeProject(proj);
  writeActiveId(id);
  return { ok: true, status: 201, body: { ok: true, ...proj, active: true } };
}

function ensureGeometriesHydrated(proj) {
  if (!proj || !proj.id) return proj;
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
    stampLegacySetup(proj.id, primaryGeometryId(proj));
  }
  if (!proj.active_geometry_id && proj.geometries[0] && proj.geometries[0].id) {
    proj.active_geometry_id = proj.geometries[0].id;
    dirty = true;
  }
  if (proj.geometry && !proj.geometry.id && proj.active_geometry_id) {
    proj.geometry.id = proj.active_geometry_id;
    dirty = true;
  }
  if (dirty) writeProject(proj);
  return proj;
}

function stampLegacySetup(projectId, geomId) {
  if (!projectId || !geomId) return;
  const stamp = (path) => {
    if (!existsSync(path)) return;
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      let changed = false;
      if (Array.isArray(doc.boundary_conditions)) {
        for (const rec of doc.boundary_conditions) {
          if (rec && !rec.geometry_id) {
            rec.geometry_id = geomId;
            changed = true;
          }
        }
      }
      if (Array.isArray(doc.materials)) {
        for (const rec of doc.materials) {
          if (rec && !rec.geometry_id) {
            rec.geometry_id = geomId;
            changed = true;
          }
        }
      }
      if (doc.air && !doc.air.geometry_id) {
        doc.air.geometry_id = geomId;
        changed = true;
      }
      if (Array.isArray(doc.meshes)) {
        for (const rec of doc.meshes) {
          if (rec && !rec.geometry_id) {
            rec.geometry_id = geomId;
            changed = true;
          }
        }
      }
      if (Array.isArray(doc.refinements)) {
        for (const rec of doc.refinements) {
          if (rec && !rec.geometry_id) {
            rec.geometry_id = geomId;
            changed = true;
          }
        }
      }
      if (doc.id && !doc.geometry_id && !Array.isArray(doc.meshes)) {
        doc.geometry_id = geomId;
        changed = true;
      }
      if (changed) writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
    } catch {
      /* leave file alone */
    }
  };
  const dir = projectDir(projectId);
  stamp(join(dir, 'boundary_conditions.json'));
  stamp(join(dir, 'materials.json'));
  stamp(join(dir, 'mesh.json'));
  stamp(join(dir, 'mesh_refinements.json'));
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
function getProjectById(id) {
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

function runPython(args) {
  return new Promise((resolveP, reject) => {
    if (!existsSync(PYTHON)) {
      return reject(new Error(`PYTHON missing: ${PYTHON}`));
    }
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`python exit=${code}\n${stderr || stdout}`));
      }
      resolveP({ stdout, stderr, code });
    });
  });
}

function runPythonSync(args) {
  if (!existsSync(PYTHON)) {
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

function resolveStepPath(proj) {
  if (!proj) return null;
  const aid = activeGeometryId(proj);
  if (aid) {
    const part = geometriesOf(proj).find((g) => g.id === aid);
    if (part && part.step_path && existsSync(part.step_path)) return part.step_path;
    const partStep = join(partDirFor(proj.id, aid), 'source.step');
    if (existsSync(partStep)) return partStep;
  }
  const listed = proj.geometry && proj.geometry.step_path;
  if (listed && existsSync(listed)) return listed;
  const fallback = join(projectDir(proj.id), 'geometry', 'source.step');
  return existsSync(fallback) ? fallback : null;
}

function resolveStlPath(proj) {
  if (!proj) return null;
  const listed = proj.geometry && proj.geometry.stl_path;
  if (listed && existsSync(listed)) return listed;
  const fallback = join(projectDir(proj.id), 'geometry', 'Body1.stl');
  return existsSync(fallback) ? fallback : null;
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
  return !!(geomDir && existsSync(join(geomDir, 'source.step')));
}

function partDirFor(projectId, geomId) {
  return join(projectDir(projectId), 'geometry', 'parts', geomId);
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
  const dir = geomId
    ? partDirFor(id, geomId)
    : join(projectDir(id), 'geometry');
  return {
    dir,
    faces: join(dir, 'cad_faces.vtp'),
    edges: join(dir, 'cad_edges.vtp'),
    meta: join(dir, 'cad_preview.json'),
  };
}

const CAD_PREVIEW_VERSION = 7;

function cadPreviewFreshAt(paths, stepPath) {
  if (!existsSync(paths.faces) || !existsSync(paths.edges)) return false;
  if (statSync(paths.faces).size < 80 || statSync(paths.edges).size < 80) return false;
  try {
    const j = JSON.parse(readFileSync(paths.meta, 'utf8'));
    if (Number(j.preview_version) !== CAD_PREVIEW_VERSION) return false;
  } catch {
    return false;
  }
  if (!stepPath || !existsSync(stepPath)) return true;
  const stepM = statSync(stepPath).mtimeMs;
  return statSync(paths.faces).mtimeMs >= stepM && statSync(paths.edges).mtimeMs >= stepM;
}

async function ensureCadPreviewAt(projectId, stepPath, paths) {
  if (!stepPath || !existsSync(stepPath)) {
    return { ok: false, status: 404, body: { error: 'no STEP imported', project_id: projectId } };
  }
  if (cadPreviewFreshAt(paths, stepPath)) {
    try {
      const meta = JSON.parse(readFileSync(paths.meta, 'utf8'));
      if (!Array.isArray(meta.center_of_mass) || meta.center_of_mass.length < 3) {
        await runPython([CAD_PREVIEW_SCRIPT, '--step', stepPath, '--meta', paths.meta, '--com-only']);
      }
    } catch {
      /* COM is optional */
    }
    return { ok: true, ...paths, step_path: stepPath, cached: true };
  }
  if (!existsSync(CAD_PREVIEW_SCRIPT)) {
    return { ok: false, status: 500, body: { error: 'CAD preview script missing', path: CAD_PREVIEW_SCRIPT } };
  }
  mkdirSync(paths.dir, { recursive: true });
  try {
    await runPython([
      CAD_PREVIEW_SCRIPT,
      '--step',
      stepPath,
      '--edges',
      paths.edges,
      '--faces',
      paths.faces,
      '--meta',
      paths.meta,
    ]);
  } catch (e) {
    return { ok: false, status: 500, body: { error: 'CAD preview failed', detail: String(e), project_id: projectId } };
  }
  if (!existsSync(paths.edges) || !existsSync(paths.faces)) {
    return { ok: false, status: 500, body: { error: 'CAD preview missing after export', ...paths } };
  }
  return { ok: true, ...paths, step_path: stepPath, cached: false };
}

async function ensureCadPreview(projectId, geomId) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found', project_id: id } };
  const aid = geomId || activeGeometryId(proj);
  const part = aid ? geometriesOf(proj).find((g) => g.id === aid) : null;
  const stepPath = (part && part.step_path && existsSync(part.step_path) && part.step_path) || resolveStepPath(proj);
  const paths = cadPaths(id, part ? part.id : null);
  const preview = await ensureCadPreviewAt(id, stepPath, paths);
  if (!preview.ok) return { ...preview, project: proj };
  return { ...preview, project: proj };
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
    step_path: join(projectDir(projectId), 'geometry', 'source.step'),
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

async function persistActiveGeometry(proj, parts, activeId, stepSource) {
  const projectId = proj.id;
  const geomDir = join(projectDir(projectId), 'geometry');
  mkdirSync(geomDir, { recursive: true });
  const live = parts.filter((p) => p && p.id && p.step_path && existsSync(p.step_path));
  if (!live.length) {
    unlinkIfExists(join(geomDir, 'source.step'));
    clearLiveCadSidecars(geomDir);
    proj.geometry = null;
    proj.geometries = [];
    proj.active_geometry_id = null;
    proj.updated_at = new Date().toISOString();
    writeProject(proj);
    return { ok: true, empty: true, project: proj, geometry: null, geometries: [] };
  }
  const want = String(activeId || proj.active_geometry_id || live[0].id);
  const active = live.find((p) => p.id === want) || live[0];
  const preview = await ensureCadPreviewAt(projectId, active.step_path, cadPaths(projectId, active.id));
  if (!preview.ok) return preview;
  let cadMeta = null;
  if (existsSync(preview.meta)) {
    try {
      cadMeta = JSON.parse(readFileSync(preview.meta, 'utf8'));
    } catch {
      cadMeta = null;
    }
  }
  const destStep = join(geomDir, 'source.step');
  if (resolve(active.step_path) !== resolve(destStep)) copyFileSync(active.step_path, destStep);
  copyIfExists(preview.faces, join(geomDir, 'cad_faces.vtp'));
  copyIfExists(preview.edges, join(geomDir, 'cad_edges.vtp'));
  copyIfExists(preview.meta, join(geomDir, 'cad_preview.json'));
  unlinkIfExists(join(geomDir, 'Body1.stl'));
  unlinkIfExists(join(geomDir, 'Body1.json'));
  unlinkIfExists(join(geomDir, 'thumb.png'));
  const geometry = geometryRecordFromPart(projectId, active, preview, cadMeta, stepSource);
  for (const p of live) {
    p.body_offset = 0;
    p.assembly_bodies = localBodiesForPart(p);
  }
  proj.geometry = geometry;
  proj.geometries = live;
  proj.active_geometry_id = active.id;
  proj.updated_at = new Date().toISOString();
  writeProject(proj);
  writeActiveId(projectId);
  syncMeshActiveToGeometry(projectId, active.id);
  try {
    await ensureGeometryThumb(projectId);
  } catch {
    /* thumb is best-effort */
  }
  return {
    ok: true,
    empty: false,
    project: proj,
    geometry,
    geometries: live,
    active_geometry_id: active.id,
  };
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

export function ensureBody1Stl(projectId, opts) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, error: 'no project' };
  const proj = readProject(id);
  if (!proj) return { ok: false, error: 'project not found', project_id: id };
  const stepPath = resolveStepPath(proj);
  if (!stepPath) return { ok: false, error: 'W16 source.step missing — import geometry first', project_id: id };
  const outStl = join(projectDir(id), 'geometry', 'Body1.stl');
  const force = !!(opts && opts.force);
  if (!force && existsSync(outStl) && statSync(outStl).size >= 100 && !stlNeedsCadRefresh(outStl)) {
    if (proj.geometry && !proj.geometry.stl_path) {
      proj.geometry.stl_path = outStl;
      proj.geometry.stl_url = `/api/geometry/stl?project_id=${encodeURIComponent(id)}`;
      writeProject(proj);
    }
    return { ok: true, path: outStl, cached: true, cad_quality: true, project_id: id };
  }
  if (!existsSync(CONVERT_SCRIPT)) {
    return { ok: false, error: 'convert script missing', path: CONVERT_SCRIPT };
  }
  const cadFaces = join(projectDir(id), 'geometry', 'cad_faces.vtp');
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
  if (proj.geometry) {
    proj.geometry.stl_path = outStl;
    proj.geometry.stl_url = `/api/geometry/stl?project_id=${encodeURIComponent(id)}`;
    proj.updated_at = new Date().toISOString();
    writeProject(proj);
  }
  return { ok: true, path: outStl, cached: false, project_id: id };
}

function thumbPathFor(id) {
  return join(projectDir(id), 'geometry', 'thumb.png');
}

function thumbIsFresh(thumb, source) {
  if (!existsSync(thumb) || statSync(thumb).size < 80) return false;
  if (!source || !existsSync(source)) return true;
  return statSync(thumb).mtimeMs >= statSync(source).mtimeMs;
}

async function renderGeometryThumb(projectId) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found', project_id: id } };
  const preview = await ensureCadPreview(id);
  const source = preview.ok ? preview.faces : resolveStlPath(proj);
  if (!source) return { ok: false, status: 404, body: { error: 'no geometry imported', project_id: id } };
  const out = thumbPathFor(id);
  const freshnessSrc = resolveStepPath(proj) || source;
  if (thumbIsFresh(out, freshnessSrc)) {
    return { ok: true, path: out, bytes: readFileSync(out), cached: true, project: proj };
  }
  if (!existsSync(THUMB_SCRIPT)) {
    return { ok: false, status: 500, body: { error: 'thumb script missing', path: THUMB_SCRIPT } };
  }
  try {
    if (preview.ok) {
      await runPython([THUMB_SCRIPT, '--vtp', preview.faces, '--edges', preview.edges, '--out', out]);
    } else {
      await runPython([THUMB_SCRIPT, '--stl', source, '--out', out]);
    }
  } catch (e) {
    if (existsSync(out) && statSync(out).size > 80) {
      return { ok: true, path: out, bytes: readFileSync(out), stale: true, project: proj };
    }
    return { ok: false, status: 500, body: { error: 'thumb render failed', detail: String(e), project_id: id } };
  }
  if (!existsSync(out) || statSync(out).size < 80) {
    return { ok: false, status: 500, body: { error: 'thumb missing after render', path: out } };
  }
  return { ok: true, path: out, bytes: readFileSync(out), cached: false, project: proj };
}

function ensureGeometryThumb(projectId) {
  const id = projectId || readActiveId() || '';
  if (thumbJobs.has(id)) return thumbJobs.get(id);
  const job = renderGeometryThumb(id).finally(() => thumbJobs.delete(id));
  thumbJobs.set(id, job);
  return job;
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
    } catch (e) {
      return { ok: false, status: 400, body: { error: 'could not read geometry', detail: String(e), filename: originalName } };
    }
    if (!existsSync(dest) || statSync(dest).size < 32) {
      return { ok: false, status: 500, body: { error: 'STEP missing after convert', dest } };
    }
    return { ok: true, dest };
  };

  if (opts.step_base64 || opts.file_base64) {
    stepSource = 'upload';
    const raw = Buffer.from(String(opts.step_base64 || opts.file_base64), 'base64');
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

async function importGeometry(opts) {
  if (opts && (opts.as_modifier === true || opts.role === 'modifier')) {
    return importModifier(opts);
  }
  ensureProjectsRoot();
  const projectId = String(opts.project_id || readActiveId() || '').trim();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project; create project first', soft_pass: false } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }

  const geomDir = join(projectDir(projectId), 'geometry');
  mkdirSync(geomDir, { recursive: true });

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
      rmSync(join(geomDir, 'parts'), { recursive: true, force: true });
    } catch {
      /* first import has no parts/ */
    }
  }

  const geomId = newGeomId();
  const destDir = partDirFor(projectId, geomId);
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
  const projectId = String((opts && opts.project_id) || readActiveId() || '').trim();
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

function transformModifier(opts) {
  ensureProjectsRoot();
  const projectId = String((opts && opts.project_id) || readActiveId() || '').trim();
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
  writeProject(proj);
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

function removeModifier(opts) {
  ensureProjectsRoot();
  const projectId = String((opts && opts.project_id) || readActiveId() || '').trim();
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
  writeProject(proj);
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
  const projectId = String((opts && opts.project_id) || readActiveId() || '').trim();
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
  let parts = migrateLegacyToParts(proj);
  const found = parts.find((p) => p.id === geomId);
  if (!found) {
    return { ok: false, status: 404, body: { error: 'geometry not in project', geometry_id: geomId } };
  }
  parts = parts.filter((p) => p.id !== geomId);
  const destDir = partDirFor(projectId, geomId);
  try {
    rmSync(destDir, { recursive: true, force: true });
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
    const { pruneOrphanStudies } = await import('./w17-sim-catalog.js');
    const { purgeOrphanSetupRecords, purgeStudyRecords } = await import('./w17-simulation.js');
    const pruned = pruneOrphanStudies(projectId, persisted.project);
    for (const s of pruned.dropped || []) {
      try {
        purgeStudyRecords(projectId, s.id, s.geometry_id);
      } catch (_) {}
    }
    const live = ((pruned.catalog && pruned.catalog.simulations) || []).map((s) => s && s.id).filter(Boolean);
    purgeOrphanSetupRecords(projectId, persisted.project, live);
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
  const projectId = String((opts && opts.project_id) || readActiveId() || '').trim();
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

async function readCadForModifier(projectId, geomId, modId, part) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
  const aid = geomId || (proj && activeGeometryId(proj));
  const host = geometriesOf(proj).find((p) => p.id === aid) || null;
  const rec = findModifierOnPart(host, modId);
  if (!host || !rec) {
    return { ok: false, status: 404, body: { error: 'modifier not found', geometry_id: aid, modifier_id: modId } };
  }
  const paths = modifierCadPaths(id, host.id, rec.id);
  const preview = await ensureCadPreviewAt(id, rec.step_path, paths);
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
  const id = projectId || readActiveId();
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
  const id = projectId || readActiveId();
  if (!id) return { ok: false, status: 404, body: { error: 'no project' } };
  const proj = readProject(id);
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
      const result = moveProject(id, body.folder);
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
      const result = updateProject(id, body);
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
      const result = createProject(body);
      res.setHeader('X-CFD-Source', 'project-create');
      if (result.ok) res.setHeader('X-CFD-Project-Id', result.body.id);
      return sendJson(res, result.status, result.body);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
      // A tab that knows its project pins it; the shared "active" project is
      // only a fallback (it is rewritten by whichever tab opened last).
      const pinned = String(u.searchParams.get('project_id') || '').trim();
      const result = pinned ? getProjectById(pinned) : getActiveProject();
      if (result.ok && result.body.project) {
        const geos = geometriesOf(result.body.project);
        if (geos.length > 1) {
          const persisted = await persistActiveGeometry(
            result.body.project,
            geos,
            result.body.project.active_geometry_id,
            'hydrate',
          );
          if (persisted.ok && persisted.project) result.body.project = persisted.project;
        }
      }
      res.setHeader('X-CFD-Source', 'project-get');
      if (result.body.project && result.body.project.id) {
        res.setHeader('X-CFD-Project-Id', result.body.project.id);
      }
      return sendJson(res, result.status, result.body);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && parts[2]) {
      let proj = ensureGeometriesHydrated(readProject(parts[2]));
      if (!proj) return sendJson(res, 404, { error: 'project not found', id: parts[2] });
      const geos = geometriesOf(proj);
      if (geos.length > 1) {
        const persisted = await persistActiveGeometry(proj, geos, proj.active_geometry_id, 'hydrate');
        if (persisted.ok && persisted.project) proj = persisted.project;
      }
      return sendJson(res, 200, { ok: true, project: proj, increment: 'W16' });
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
          const buf = await readBinaryBody(req);
          opts = {
            project_id: req.headers['x-cfd-project-id'] || undefined,
            filename: req.headers['x-cfd-filename'] || 'upload.step',
            step_base64: buf.toString('base64'),
          };
        } else {
          // try JSON anyway
          opts = await readJsonBody(req);
        }
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid body', detail: String(e) });
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
        const result = removeModifier(opts);
        res.setHeader('X-CFD-Source', 'geometry-modifier-remove');
        return sendJson(res, result.status, result.body);
      }
      const result = transformModifier(opts);
      res.setHeader('X-CFD-Source', 'geometry-modifier-transform');
      return sendJson(res, result.status, result.body);
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
    if (parts[2] === 'cad' && (req.method === 'GET' || req.method === 'HEAD')) {
      const pid = u.searchParams.get('project_id') || readActiveId();
      const geomId = String(u.searchParams.get('geometry_id') || '').trim() || undefined;
      const modId = String(u.searchParams.get('modifier_id') || '').trim();
      const partRaw = String(u.searchParams.get('part') || 'faces').toLowerCase();
      if (modId) {
        const part = partRaw === 'edges' ? 'edges' : partRaw === 'meta' || partRaw === 'preview' ? 'meta' : 'faces';
        const got = await readCadForModifier(pid, geomId, modId, part);
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
        const preview = await ensureCadPreview(pid, geomId);
        if (!preview.ok) return sendJson(res, preview.status || 404, preview.body || { error: 'CAD preview failed' });
        const metaPath = preview.meta || cadPaths(pid, geomId).meta;
        if (!existsSync(metaPath)) return sendJson(res, 404, { error: 'CAD preview meta missing' });
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          res.setHeader('X-CFD-Source', 'geometry-cad-preview');
          res.setHeader('X-CFD-Project-Id', pid || '');
          res.setHeader('Cache-Control', 'no-store');
          return sendJson(res, 200, meta);
        } catch (e) {
          return sendJson(res, 500, { error: 'CAD preview meta unreadable', detail: String(e) });
        }
      }
      const part = partRaw === 'edges' ? 'edges' : 'faces';
      const preview = await ensureCadPreview(pid, geomId);
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
      const pid = u.searchParams.get('project_id') || readActiveId();
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
      const pid = u.searchParams.get('project_id') || readActiveId();
      const got = await ensureGeometryThumb(pid);
      if (!got.ok) return sendJson(res, got.status, got.body);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(got.bytes.length));
      res.setHeader('X-CFD-Source', 'geometry-thumb');
      res.setHeader('X-CFD-Project-Id', pid || '');
      res.setHeader('Cache-Control', 'public, max-age=86400');
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
