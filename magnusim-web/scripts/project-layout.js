// @ts-check
/**
 * Tree-aligned project folders.
 * projects/<id>/geometries/Geometry_<file>/simulations/<study>/meshes/<mesh>/case
 *                                          └─ simulation_runs/<run>/case
 * Isolation: a writer for study/mesh/run N may only touch that folder.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { pathIsWithin } from './safe-path.js';
import { basename, dirname, join, resolve } from 'node:path';

export const LAYOUT_VERSION = 2;

export function sanitizeFolderName(name, fallback = 'item') {
  const s = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80)
    .replace(/[. ]+$/g, '');
  if (!s || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) return fallback;
  return s;
}

export function geometryFolderName(filenameOrName) {
  const raw = String(filenameOrName || 'Geometry');
  const stem = raw.replace(/\.[^.\\/]+$/, '');
  return 'Geometry_' + sanitizeFolderName(stem, 'Geometry');
}

export function writeJsonAtomic(filePath, doc) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  renameSync(tmp, filePath);
  return filePath;
}

export function readJsonFile(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeIdFile(dir, rec) {
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'id.json'), rec);
  return join(dir, 'id.json');
}

export function uniqueChildDir(parent, wantedName) {
  mkdirSync(parent, { recursive: true });
  let name = wantedName;
  let n = 2;
  while (existsSync(join(parent, name))) {
    name = wantedName + '_' + n;
    n += 1;
  }
  return { name, path: join(parent, name) };
}

export function geometriesRoot(projectDirPath) {
  return join(projectDirPath, 'geometries');
}

function listDirFolders(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => {
        if (!n || n.startsWith('.')) return false;
        try {
          return statSync(join(dir, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

export function walkGeometries(projectDirPath) {
  const root = geometriesRoot(projectDirPath);
  const out = [];
  for (const name of listDirFolders(root)) {
    const dir = join(root, name);
    const id = readJsonFile(join(dir, 'id.json'));
    if (!id || !id.id) continue;
    out.push({ ...id, folder: name, dir });
  }
  return out;
}

export function findGeometry(projectDirPath, geomId) {
  const want = String(geomId || '').trim();
  if (!want) return null;
  return walkGeometries(projectDirPath).find((g) => String(g.id) === want) || null;
}

export function walkStudies(projectDirPath, geomId) {
  const geoms = geomId
    ? [findGeometry(projectDirPath, geomId)].filter(Boolean)
    : walkGeometries(projectDirPath);
  const out = [];
  for (const g of geoms) {
    const simsRoot = join(g.dir, 'simulations');
    for (const name of listDirFolders(simsRoot)) {
      const dir = join(simsRoot, name);
      const id = readJsonFile(join(dir, 'id.json'));
      if (!id || !id.id) continue;
      out.push({
        ...id,
        folder: name,
        dir,
        geometry_id: id.geometry_id || g.id,
        geometry_dir: g.dir,
        geometry_folder: g.folder,
      });
    }
  }
  out.sort((a, b) => {
    const ai = Number(a && a.sort_index);
    const bi = Number(b && b.sort_index);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    if (Number.isFinite(ai) && !Number.isFinite(bi)) return -1;
    if (!Number.isFinite(ai) && Number.isFinite(bi)) return 1;
    return 0;
  });
  return out;
}

export function findStudy(projectDirPath, simId) {
  const want = String(simId || '').trim();
  if (!want) return null;
  return walkStudies(projectDirPath).find((s) => String(s.id) === want) || null;
}

export function bindMeshCasePaths(rec, dir) {
  if (!rec || !dir) return rec;
  const caseDir = join(dir, 'case');
  rec.case_dir = caseDir;
  const live = rec.live_mesh_result;
  if (live) {
    const poly = join(caseDir, 'constant', 'polyMesh');
    const fp = live.fingerprint_after && typeof live.fingerprint_after === 'object' ? live.fingerprint_after : null;
    rec.live_mesh_result = {
      ...live,
      case_dir: caseDir,
      mesh_path: poly,
      ...(fp
        ? {
            fingerprint_after: {
              ...fp,
              points_path: join(poly, 'points'),
              owner_path: join(poly, 'owner'),
            },
          }
        : {}),
    };
  }
  return rec;
}

const FOAM_TIME_DIR = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function foamTimeHasField(base, field) {
  return existsSync(join(base, field)) || existsSync(join(base, field + '.gz'));
}

/** Viewer/API times require both U and p so a half-copied live write is skipped. */
export function foamTimeDirIsComplete(caseDir, name) {
  const base = join(caseDir, String(name));
  return foamTimeHasField(base, 'U') && foamTimeHasField(base, 'p');
}

export function listFoamTimeDirs(caseDir, opts) {
  if (!caseDir || !existsSync(caseDir)) return [];
  let ents;
  try {
    ents = readdirSync(caseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const needComplete = !!(opts && opts.complete);
  const times = [];
  for (const ent of ents) {
    const name = ent.name;
    let isDir = ent.isDirectory();
    if (!isDir && ent.isSymbolicLink()) {
      try {
        isDir = statSync(join(caseDir, name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    if (!FOAM_TIME_DIR.test(name)) continue;
    const base = join(caseDir, name);
    const ok = needComplete
      ? foamTimeDirIsComplete(caseDir, name)
      : foamTimeHasField(base, 'U') || foamTimeHasField(base, 'p');
    if (ok) times.push(name);
  }
  times.sort((a, b) => Number(a) - Number(b));
  return times;
}

function addCaseCandidate(out, path) {
  const s = String(path || '').trim();
  if (!s || out.includes(s)) return;
  out.push(s);
}

export function runCaseDirCandidates(rec, dir) {
  const out = [];
  if (dir) addCaseCandidate(out, join(dir, 'case'));
  if (rec) {
    addCaseCandidate(out, rec.case_dir);
    addCaseCandidate(out, rec.prepare_run && rec.prepare_run.case_dir);
    const argv = rec.argv;
    if (Array.isArray(argv)) {
      const i = argv.indexOf('--case-dir');
      if (i >= 0) addCaseCandidate(out, argv[i + 1]);
    }
  }
  return out;
}

export function resolveRunResultsCaseDir(rec, dir) {
  return assembleReadableRunCase(rec, dir);
}

export function foamCaseHasMesh(caseDir) {
  if (!caseDir || !existsSync(caseDir)) return false;
  return (
    existsSync(join(caseDir, 'constant', 'polyMesh', 'points')) ||
    existsSync(join(caseDir, 'constant', 'polyMesh', 'points.gz')) ||
    existsSync(join(caseDir, '.cfddesk-prepared.vtu'))
  );
}

function sameResolvedPath(a, b) {
  if (!a || !b) return false;
  try {
    return resolve(String(a)) === resolve(String(b));
  } catch {
    return String(a) === String(b);
  }
}

/** Settings-copy can leave times in one folder and constant/polyMesh in another. */
export function healRunResultsCase(destCase, sourceCase) {
  if (!destCase || !sourceCase || sameResolvedPath(destCase, sourceCase)) return destCase;
  if (!existsSync(destCase) || !existsSync(sourceCase)) return destCase;
  const destTimes = new Set(listFoamTimeDirs(destCase));
  for (const t of listFoamTimeDirs(sourceCase)) {
    if (destTimes.has(t)) continue;
    const from = join(sourceCase, t);
    const to = join(destCase, t);
    if (existsSync(to)) continue;
    try {
      symlinkSync(resolve(from), to, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      try {
        cpSync(from, to, { recursive: true });
      } catch {
        /* keep going; a later attach can retry */
      }
    }
  }
  return destCase;
}

export function assembleReadableRunCase(rec, dir) {
  const candidates = runCaseDirCandidates(rec, dir);
  const local = dir ? join(dir, 'case') : null;
  const meshCase =
    (local && foamCaseHasMesh(local) && local) ||
    candidates.find((c) => foamCaseHasMesh(c)) ||
    null;
  let timesCase = null;
  let timesN = -1;
  for (const c of candidates) {
    const n = listFoamTimeDirs(c).length;
    if (n > timesN) {
      timesN = n;
      timesCase = c;
    }
  }
  if (meshCase && timesCase && !sameResolvedPath(meshCase, timesCase)) {
    healRunResultsCase(meshCase, timesCase);
  }
  if (meshCase && listFoamTimeDirs(meshCase).length) return meshCase;
  if (timesCase && foamCaseHasMesh(timesCase)) return timesCase;
  return meshCase || timesCase || local || (rec && rec.case_dir) || null;
}

export function bindRunCasePaths(rec, dir) {
  if (!rec || !dir) return rec;
  rec.case_dir = assembleReadableRunCase(rec, dir);
  return rec;
}

/** Listing a run must stay a JSON read. Healing/copying times is attach-only. */
export function bindListedRunCaseDir(rec, dir) {
  if (!rec || !dir) return rec;
  rec.case_dir = join(dir, 'case');
  return rec;
}

function loadMeshRecord(dir, study) {
  const id = readJsonFile(join(dir, 'id.json'));
  const mesh = readJsonFile(join(dir, 'mesh.json'));
  if (!id && !mesh) return null;
  const rec = { ...(mesh || {}), ...(id || {}), folder: basename(dir), dir };
  rec.id = rec.id || (id && id.id);
  rec.simulation_id = rec.simulation_id || (study && study.id) || rec.simulation_id;
  rec.geometry_id = rec.geometry_id || (study && study.geometry_id) || rec.geometry_id;
  return bindMeshCasePaths(rec, dir);
}

export function walkMeshes(projectDirPath, simId) {
  const study = findStudy(projectDirPath, simId);
  if (!study) return [];
  const root = join(study.dir, 'meshes');
  const out = [];
  for (const name of listDirFolders(root)) {
    const rec = loadMeshRecord(join(root, name), study);
    if (rec) out.push(rec);
  }
  return out;
}

export function walkAllMeshes(projectDirPath) {
  const out = [];
  for (const s of walkStudies(projectDirPath)) out.push(...walkMeshes(projectDirPath, s.id));
  return out;
}

export function findMesh(projectDirPath, meshId, simId) {
  const want = String(meshId || '').trim();
  if (!want) return null;
  if (simId) {
    return walkMeshes(projectDirPath, simId).find((m) => String(m.id) === want) || null;
  }
  for (const s of walkStudies(projectDirPath)) {
    const m = walkMeshes(projectDirPath, s.id).find((x) => String(x.id) === want);
    if (m) return m;
  }
  return null;
}

function stripDirMeta(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const next = { ...rec };
  delete next.dir;
  delete next.folder;
  delete next.kind;
  return next;
}

export function mergeChildRows(folderRows, legacyList) {
  const have = new Set((folderRows || []).map((r) => String(r && r.id)));
  const extra = (legacyList || []).filter((r) => r && r.id != null && !have.has(String(r.id)));
  return [...(folderRows || []).map(stripDirMeta), ...extra];
}

function assembleRunResultControls(dir, rec) {
  const rows = walkChildItems(join(dir, 'result_controls'), 'result_control.json');
  rec.result_controls = mergeChildRows(rows, rec.result_controls);
  return rec;
}

function loadRunRecord(dir, study) {
  const id = readJsonFile(join(dir, 'id.json'));
  const run = readJsonFile(join(dir, 'run.json'));
  if (!id && !run) return null;
  const rec = { ...(run || {}), ...(id || {}), folder: basename(dir), dir };
  rec.id = rec.id || rec.run_id || (id && id.id);
  rec.run_id = rec.run_id || rec.id;
  rec.simulation_id = rec.simulation_id || (study && study.id) || rec.simulation_id;
  assembleRunResultControls(dir, rec);
  return bindListedRunCaseDir(rec, dir);
}

export function walkRuns(projectDirPath, simId) {
  const study = findStudy(projectDirPath, simId);
  if (!study) return [];
  const root = join(study.dir, 'simulation_runs');
  const out = [];
  for (const name of listDirFolders(root)) {
    const rec = loadRunRecord(join(root, name), study);
    if (rec) out.push(rec);
  }
  return out;
}

export function walkAllRuns(projectDirPath) {
  const out = [];
  for (const s of walkStudies(projectDirPath)) out.push(...walkRuns(projectDirPath, s.id));
  return out;
}

export function findRun(projectDirPath, runId, simId) {
  const want = String(runId || '').trim();
  if (!want) return null;
  if (simId) {
    return walkRuns(projectDirPath, simId).find((r) => String(r.id) === want || String(r.run_id) === want) || null;
  }
  for (const s of walkStudies(projectDirPath)) {
    const r = walkRuns(projectDirPath, s.id).find((x) => String(x.id) === want || String(x.run_id) === want);
    if (r) return r;
  }
  return null;
}

export function createGeometryFolder(projectDirPath, rec) {
  const root = geometriesRoot(projectDirPath);
  mkdirSync(root, { recursive: true });
  const wanted = geometryFolderName(rec.original_filename || rec.name || rec.id);
  const { name: folder, path: dir } = uniqueChildDir(root, wanted);
  writeIdFile(dir, {
    id: rec.id,
    name: rec.name || folder,
    original_filename: rec.original_filename || null,
    kind: 'geometry',
  });
  mkdirSync(join(dir, 'simulations'), { recursive: true });
  return { id: rec.id, folder, dir, name: rec.name || folder };
}

export function createStudyFolder(projectDirPath, geomId, sim) {
  const geom = findGeometry(projectDirPath, geomId);
  if (!geom) throw new Error('geometry folder missing for ' + geomId);
  const simsRoot = join(geom.dir, 'simulations');
  mkdirSync(simsRoot, { recursive: true });
  const wanted = sanitizeFolderName(sim.name || 'Incompressible_Steady-state', 'Study');
  const { name: folder, path: dir } = uniqueChildDir(simsRoot, wanted);
  writeIdFile(dir, {
    id: sim.id,
    name: sim.name,
    geometry_id: geomId,
    kind: 'simulation',
    analysis: sim.analysis,
    analysis_type: sim.analysis_type,
    turbulence_model: sim.turbulence_model,
    time_dependency: sim.time_dependency,
    algorithm: sim.algorithm,
    created_at: sim.created_at,
    updated_at: sim.updated_at,
  });
  mkdirSync(join(dir, 'meshes'), { recursive: true });
  mkdirSync(join(dir, 'simulation_runs'), { recursive: true });
  mkdirSync(join(dir, 'materials'), { recursive: true });
  mkdirSync(join(dir, 'boundary_conditions'), { recursive: true });
  mkdirSync(join(dir, 'result_controls'), { recursive: true });
  return { ...sim, folder, dir, geometry_dir: geom.dir, geometry_id: geomId };
}

export function createMeshFolder(projectDirPath, simId, mesh) {
  const study = findStudy(projectDirPath, simId);
  if (!study) throw new Error('study folder missing for ' + simId);
  const root = join(study.dir, 'meshes');
  mkdirSync(root, { recursive: true });
  const wanted = sanitizeFolderName(mesh.name || 'Mesh_1', 'Mesh_1');
  const { name: folder, path: dir } = uniqueChildDir(root, wanted);
  writeIdFile(dir, {
    id: mesh.id,
    name: mesh.name || folder,
    simulation_id: simId,
    kind: 'mesh',
  });
  mkdirSync(join(dir, 'refinements'), { recursive: true });
  return { ...mesh, folder, dir, case_dir: join(dir, 'case') };
}

export function createRunFolder(projectDirPath, simId, run) {
  const study = findStudy(projectDirPath, simId);
  if (!study) throw new Error('study folder missing for ' + simId);
  const root = join(study.dir, 'simulation_runs');
  mkdirSync(root, { recursive: true });
  const wanted = sanitizeFolderName(run.name || 'Run_1', 'Run_1');
  const { name: folder, path: dir } = uniqueChildDir(root, wanted);
  writeIdFile(dir, {
    id: run.id,
    name: run.name || folder,
    simulation_id: simId,
    mesh_id: run.mesh_id || null,
    kind: 'run',
  });
  mkdirSync(join(dir, 'result_controls'), { recursive: true });
  return { ...run, folder, dir, case_dir: join(dir, 'case') };
}

function pathPrefixVariants(dir) {
  const win = String(dir || '').replace(/\//g, '\\');
  const posix = String(dir || '').replace(/\\/g, '/');
  return [win, posix, win.replace(/\\/g, '\\\\')].filter(Boolean);
}

export function replacePathPrefix(text, fromDir, toDir) {
  if (!text || !fromDir || !toDir || fromDir === toDir) return text;
  const froms = pathPrefixVariants(fromDir);
  const tos = pathPrefixVariants(toDir);
  let out = String(text);
  for (let i = 0; i < froms.length; i += 1) {
    const from = froms[i];
    const to = tos[i];
    if (!from || from === to) continue;
    let next = '';
    let idx = 0;
    while (idx < out.length) {
      const at = out.indexOf(from, idx);
      if (at < 0) {
        next += out.slice(idx);
        break;
      }
      const after = out[at + from.length] || '';
      const boundary = after === '' || after === '/' || after === '\\' || after === '"';
      next += out.slice(idx, at) + (boundary ? to : from);
      idx = at + from.length;
    }
    out = next;
  }
  return out;
}

function rewritePathPrefixInJsonTree(rootDir, fromDir, toDir) {
  if (!rootDir || !existsSync(rootDir) || fromDir === toDir) return;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      let raw = '';
      try {
        raw = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const next = replacePathPrefix(raw, fromDir, toDir);
      if (next !== raw) writeFileSync(p, next, 'utf8');
    }
  }
}

function persistBoundRecords(studyDir) {
  if (!studyDir || !existsSync(studyDir)) return;
  const meshRoot = join(studyDir, 'meshes');
  for (const name of listDirFolders(meshRoot)) {
    const dir = join(meshRoot, name);
    const mesh = readJsonFile(join(dir, 'mesh.json'));
    if (!mesh) continue;
    bindMeshCasePaths(mesh, dir);
    delete mesh.dir;
    delete mesh.folder;
    writeJsonAtomic(join(dir, 'mesh.json'), mesh);
  }
  const runRoot = join(studyDir, 'simulation_runs');
  for (const name of listDirFolders(runRoot)) {
    const dir = join(runRoot, name);
    const run = readJsonFile(join(dir, 'run.json'));
    if (!run) continue;
    bindRunCasePaths(run, dir);
    delete run.dir;
    delete run.folder;
    writeJsonAtomic(join(dir, 'run.json'), run);
  }
}

export function renameFolderTo(dir, parent, newName) {
  const wanted = sanitizeFolderName(newName, basename(dir));
  if (basename(dir) === wanted) return dir;
  const dest = uniqueChildDir(parent, wanted);
  renameSync(dir, dest.path);
  rewritePathPrefixInJsonTree(dest.path, dir, dest.path);
  const projectRoot = dirname(dirname(dirname(parent)));
  for (const name of ['project.json', 'simulations.json', 'simulation.json']) {
    const p = join(projectRoot, name);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      const next = replacePathPrefix(raw, dir, dest.path);
      if (next !== raw) writeFileSync(p, next, 'utf8');
    } catch {
      /* ignore */
    }
  }
  persistBoundRecords(dest.path);
  return dest.path;
}

const ITEM_KIND = {
  material: { prefix: 'Material_', json: 'material.json', fallback: 'Material' },
  bc: { prefix: 'BC_', json: 'bc.json', fallback: 'BC' },
  rc: { prefix: 'RC_', json: 'result_control.json', fallback: 'RC' },
  refinement: { prefix: 'Ref_', json: 'refinement.json', fallback: 'Ref' },
};

export function itemFolderName(kind, name, fallback) {
  const spec = ITEM_KIND[kind] || { prefix: '', fallback: fallback || 'item' };
  return spec.prefix + sanitizeFolderName(name || fallback, spec.fallback);
}

export function walkChildItems(parentDir, jsonFile) {
  const out = [];
  for (const name of listDirFolders(parentDir)) {
    const dir = join(parentDir, name);
    const rec = readJsonFile(join(dir, jsonFile));
    if (!rec || rec.id == null) continue;
    const ident = readJsonFile(join(dir, 'id.json')) || {};
    const row = { ...ident, ...rec, folder: name, dir };
    delete row.kind;
    out.push(row);
  }
  return out;
}

export function findChildItem(parentDir, jsonFile, id) {
  const want = String(id || '').trim();
  if (!want) return null;
  return walkChildItems(parentDir, jsonFile).find((x) => String(x.id) === want) || null;
}

export function persistChildItem(parentDir, kind, rec) {
  const spec = ITEM_KIND[kind];
  if (!spec) throw new Error('unknown item kind ' + kind);
  if (!rec || rec.id == null) throw new Error(kind + ' id required');
  mkdirSync(parentDir, { recursive: true });
  let folder = findChildItem(parentDir, spec.json, rec.id);
  if (!folder) {
    const wanted = itemFolderName(kind, rec.name, rec.id);
    const created = uniqueChildDir(parentDir, wanted);
    folder = { dir: created.path, folder: created.name };
  }
  writeIdFile(folder.dir, {
    id: rec.id,
    name: rec.name || folder.folder,
    simulation_id: rec.simulation_id || null,
    mesh_id: rec.mesh_id || null,
    run_id: rec.run_id || null,
    kind,
  });
  const bound = { ...rec };
  delete bound.dir;
  delete bound.folder;
  writeJsonAtomic(join(folder.dir, spec.json), bound);
  return { ...bound, folder: folder.folder || basename(folder.dir), dir: folder.dir };
}

export function removeChildItem(parentDir, jsonFile, id) {
  const folder = findChildItem(parentDir, jsonFile, id);
  if (!folder || !folder.dir) return false;
  rmSync(folder.dir, { recursive: true, force: true });
  return true;
}

/** Wipe child folders and persist each record into its own folder. Never share a list file as SoT. */
export function replaceChildItems(parentDir, kind, recs) {
  const spec = ITEM_KIND[kind];
  if (!spec) throw new Error('unknown item kind ' + kind);
  mkdirSync(parentDir, { recursive: true });
  for (const name of listDirFolders(parentDir)) {
    const dir = join(parentDir, name);
    if (existsSync(join(dir, spec.json)) || existsSync(join(dir, 'id.json'))) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  const out = [];
  for (const rec of recs || []) {
    if (rec && rec.id != null) out.push(persistChildItem(parentDir, kind, rec));
  }
  return out;
}

export function collectChildRecs(parentDir, jsonFile, legacyList) {
  return mergeChildRows(walkChildItems(parentDir, jsonFile), legacyList);
}

export function studyMaterialsDir(studyDir) {
  return join(studyDir, 'materials');
}

export function studyBcsDir(studyDir) {
  return join(studyDir, 'boundary_conditions');
}

export function studyRcsDir(studyDir) {
  return join(studyDir, 'result_controls');
}

export function meshRefsDir(meshDir) {
  return join(meshDir, 'refinements');
}

export function runRcsDir(runDir) {
  return join(runDir, 'result_controls');
}

export function studyMaterialsPath(studyDir) {
  return join(studyDir, 'materials.json');
}

export function studyBcsPath(studyDir) {
  return join(studyDir, 'boundary_conditions.json');
}

export function studyResultControlsPath(studyDir) {
  return join(studyDir, 'result_controls.json');
}

export function studyControlPath(studyDir) {
  return join(studyDir, 'simulation_control.json');
}

export function meshSettingsPath(meshDir) {
  return join(meshDir, 'mesh.json');
}

export function meshRefinementsPath(meshDir) {
  return join(meshDir, 'refinements.json');
}

export function meshCaseDir(meshDir) {
  return join(meshDir, 'case');
}

export function runSettingsPath(runDir) {
  return join(runDir, 'run.json');
}

export function runCaseDir(runDir) {
  return join(runDir, 'case');
}

export function caseUnderOwner(casePath, ownerDir) {
  if (!casePath || !ownerDir) return false;
  return pathIsWithin(casePath, ownerDir);
}

export function removeStudyFolder(projectDirPath, simId) {
  const study = findStudy(projectDirPath, simId);
  if (!study || !study.dir) return false;
  rmSync(study.dir, { recursive: true, force: true });
  return true;
}

export function copyStudyTree(srcStudyDir, destParent, newName, { cloneCases }) {
  const wanted = sanitizeFolderName(newName, 'Study');
  const dest = uniqueChildDir(destParent, wanted);
  cpSync(srcStudyDir, dest.path, {
    recursive: true,
    filter(src) {
      if (cloneCases) return true;
      const n = String(src).replace(/\\/g, '/');
      if (/(^|\/)case(\/|$)/i.test(n)) return false;
      if (/(^|\/)simulation_runs(\/|$)/i.test(n)) return false;
      return true;
    },
  });
  if (!cloneCases) mkdirSync(join(dest.path, 'simulation_runs'), { recursive: true });
  return dest.path;
}

export function catalogFromWalk(projectDirPath, activeId) {
  const simulations = walkStudies(projectDirPath).map((s) => ({
    id: s.id,
    name: s.name,
    geometry_id: s.geometry_id,
    folder: s.folder,
    dir: s.dir,
    analysis: s.analysis,
    analysis_type: s.analysis_type,
    turbulence_model: s.turbulence_model,
    time_dependency: s.time_dependency,
    algorithm: s.algorithm,
    created_at: s.created_at,
    updated_at: s.updated_at,
    sort_index: Number.isFinite(Number(s.sort_index)) ? Number(s.sort_index) : undefined,
  }));
  const active_id =
    activeId && simulations.some((s) => s.id === activeId)
      ? activeId
      : simulations[0]
        ? simulations[0].id
        : null;
  return { active_id, simulations, updated_at: new Date().toISOString() };
}
