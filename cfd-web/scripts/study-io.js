// @ts-check
/**
 * Study / mesh / run file I/O. Writers for study N may only touch that folder.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir } from './w17-sim-catalog.js';
import {
  caseUnderOwner,
  bindMeshCasePaths,
  createMeshFolder,
  createRunFolder,
  findMesh,
  findRun,
  findStudy,
  meshRefinementsPath,
  meshRefsDir,
  persistChildItem,
  readJsonFile,
  removeChildItem,
  runRcsDir,
  studyBcsDir,
  studyBcsPath,
  studyControlPath,
  studyMaterialsDir,
  studyMaterialsPath,
  studyRcsDir,
  studyResultControlsPath,
  walkAllMeshes,
  walkAllRuns,
  walkChildItems,
  walkMeshes,
  walkRuns,
  walkStudies,
  writeIdFile,
  writeJsonAtomic,
  listFoamTimeDirs,
} from './project-layout.js';

export function studyOf(projectId, simId) {
  if (!projectId || !simId) return null;
  return findStudy(projectDir(projectId), String(simId));
}

function studyPath(projectId, simId, which) {
  const s = studyOf(projectId, simId);
  if (!s) return null;
  if (which === 'materials') return studyMaterialsPath(s.dir);
  if (which === 'bcs') return studyBcsPath(s.dir);
  if (which === 'result_controls') return studyResultControlsPath(s.dir);
  if (which === 'control') return studyControlPath(s.dir);
  if (which === 'runs') return join(s.dir, 'simulation_runs', 'catalog.json');
  return null;
}

function stripDirMeta(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const next = { ...rec };
  delete next.dir;
  delete next.folder;
  return next;
}

function mergeFolderRows(folderRows, legacyList) {
  const have = new Set((folderRows || []).map((r) => String(r && r.id)));
  const extra = (legacyList || []).filter((r) => r && r.id != null && !have.has(String(r.id)));
  return [...(folderRows || []).map(stripDirMeta), ...extra];
}

function assembleStudyCollection(projectId, simId, which) {
  const s = studyOf(projectId, simId);
  if (!s) return null;
  if (which === 'materials') {
    const legacy = readJsonFile(studyMaterialsPath(s.dir));
    const rows = walkChildItems(studyMaterialsDir(s.dir), 'material.json');
    return {
      ...(legacy || {}),
      materials: mergeFolderRows(rows, legacy && legacy.materials),
      air: (rows[0] && stripDirMeta(rows[0])) || (legacy && legacy.air) || null,
      simulation_id: simId,
    };
  }
  if (which === 'bcs') {
    const legacy = readJsonFile(studyBcsPath(s.dir));
    const rows = walkChildItems(studyBcsDir(s.dir), 'bc.json');
    const defaultsDoc = readJsonFile(join(studyBcsDir(s.dir), 'defaults.json'));
    return {
      ...(legacy || {}),
      boundary_conditions: mergeFolderRows(rows, legacy && legacy.boundary_conditions),
      defaults: (defaultsDoc && defaultsDoc.defaults) || (legacy && legacy.defaults) || null,
      defaults_by_simulation:
        (defaultsDoc && defaultsDoc.defaults_by_simulation) ||
        (legacy && legacy.defaults_by_simulation) ||
        {},
      simulation_id: simId,
    };
  }
  if (which === 'result_controls') {
    const legacy = readJsonFile(studyResultControlsPath(s.dir));
    const rows = walkChildItems(studyRcsDir(s.dir), 'result_control.json');
    const items = mergeFolderRows(rows, legacy && legacy.result_controls);
    return {
      ...(legacy || {}),
      result_controls: items,
      area_average_1: items[0] || (legacy && legacy.area_average_1) || null,
      simulation_id: simId,
    };
  }
  const p = studyPath(projectId, simId, which);
  return p ? readJsonFile(p) : null;
}

export function readStudyJson(projectId, simId, which) {
  return assembleStudyCollection(projectId, simId, which);
}

export function persistOneMaterialAt(projectDirPath, simId, rec) {
  const s = findStudy(projectDirPath, String(simId));
  if (!s) throw new Error('study folder missing for ' + simId);
  return persistChildItem(studyMaterialsDir(s.dir), 'material', { ...rec, simulation_id: simId });
}

export function persistOneMaterial(projectId, simId, rec) {
  return persistOneMaterialAt(projectDir(projectId), simId, rec);
}

function mirrorStudyBcsJson(studyDir, simId) {
  const rows = walkChildItems(studyBcsDir(studyDir), 'bc.json').map(stripDirMeta);
  const legacy = readJsonFile(studyBcsPath(studyDir)) || {};
  writeJsonAtomic(studyBcsPath(studyDir), {
    ...legacy,
    boundary_conditions: rows,
    simulation_id: simId || legacy.simulation_id || null,
    updated_at: new Date().toISOString(),
  });
}

export function persistOneBcAt(projectDirPath, simId, rec) {
  const s = findStudy(projectDirPath, String(simId));
  if (!s) throw new Error('study folder missing for ' + simId);
  const out = persistChildItem(studyBcsDir(s.dir), 'bc', { ...rec, simulation_id: simId });
  mirrorStudyBcsJson(s.dir, simId);
  return out;
}

export function persistOneBc(projectId, simId, rec) {
  return persistOneBcAt(projectDir(projectId), simId, rec);
}

export function persistBcDefaultsAt(projectDirPath, simId, defaults, defaultsBySimulation) {
  const s = findStudy(projectDirPath, String(simId));
  if (!s) throw new Error('study folder missing for ' + simId);
  const path = join(studyBcsDir(s.dir), 'defaults.json');
  writeJsonAtomic(path, {
    defaults: defaults || null,
    defaults_by_simulation: defaultsBySimulation || {},
    simulation_id: simId,
  });
  return path;
}

export function persistBcDefaults(projectId, simId, defaults, defaultsBySimulation) {
  return persistBcDefaultsAt(projectDir(projectId), simId, defaults, defaultsBySimulation);
}

export function persistOneResultControlAt(projectDirPath, simId, rec) {
  const s = findStudy(projectDirPath, String(simId));
  if (!s) throw new Error('study folder missing for ' + simId);
  return persistChildItem(studyRcsDir(s.dir), 'rc', { ...rec, simulation_id: simId });
}

export function persistOneResultControl(projectId, simId, rec) {
  return persistOneResultControlAt(projectDir(projectId), simId, rec);
}

export function persistOneRefinementAt(projectDirPath, meshId, simId, rec) {
  const mesh = findMesh(projectDirPath, String(meshId), String(simId));
  if (!mesh) throw new Error('mesh folder missing for ' + meshId);
  return persistChildItem(meshRefsDir(mesh.dir), 'refinement', {
    ...rec,
    mesh_id: meshId,
    simulation_id: simId,
  });
}

export function persistOneRefinement(projectId, meshId, simId, rec) {
  return persistOneRefinementAt(projectDir(projectId), meshId, simId, rec);
}

export function persistOneRunResultControlAt(projectDirPath, simId, runId, rec) {
  const run = findRun(projectDirPath, String(runId), String(simId));
  if (!run) throw new Error('run folder missing for ' + runId);
  return persistChildItem(runRcsDir(run.dir), 'rc', {
    ...rec,
    run_id: runId,
    simulation_id: simId,
  });
}

export function persistOneRunResultControl(projectId, simId, runId, rec) {
  return persistOneRunResultControlAt(projectDir(projectId), simId, runId, rec);
}

export function deleteOneRunResultControl(projectId, simId, runId, id) {
  const run = findRun(projectDir(projectId), String(runId), simId ? String(simId) : undefined);
  return !!(run && removeChildItem(runRcsDir(run.dir), 'result_control.json', id));
}

export function deleteOneMaterial(projectId, simId, id) {
  const s = studyOf(projectId, simId);
  return !!(s && removeChildItem(studyMaterialsDir(s.dir), 'material.json', id));
}

export function deleteOneBc(projectId, simId, id) {
  const s = studyOf(projectId, simId);
  const ok = !!(s && removeChildItem(studyBcsDir(s.dir), 'bc.json', id));
  if (ok && s) mirrorStudyBcsJson(s.dir, simId);
  return ok;
}

export function deleteOneResultControl(projectId, simId, id) {
  const s = studyOf(projectId, simId);
  return !!(s && removeChildItem(studyRcsDir(s.dir), 'result_control.json', id));
}

export function deleteOneRefinement(projectId, meshId, simId, id) {
  const mesh = meshFolderOf(projectId, meshId, simId);
  return !!(mesh && removeChildItem(meshRefsDir(mesh.dir), 'refinement.json', id));
}

export function writeStudyJson(projectId, simId, which, doc) {
  const s = studyOf(projectId, simId);
  if (!s) throw new Error('study folder missing for ' + simId);
  if (which === 'materials') {
    for (const rec of (doc && doc.materials) || []) {
      if (rec && rec.id) persistOneMaterial(projectId, simId, rec);
    }
    return studyMaterialsDir(s.dir);
  }
  if (which === 'bcs') {
    for (const rec of (doc && doc.boundary_conditions) || []) {
      if (rec && rec.id) persistOneBc(projectId, simId, rec);
    }
    persistBcDefaults(projectId, simId, doc && doc.defaults, doc && doc.defaults_by_simulation);
    return studyBcsDir(s.dir);
  }
  if (which === 'result_controls') {
    for (const rec of (doc && doc.result_controls) || []) {
      if (rec && rec.id) persistOneResultControl(projectId, simId, rec);
    }
    return studyRcsDir(s.dir);
  }
  const p = studyPath(projectId, simId, which);
  if (!p) throw new Error('study folder missing for ' + simId);
  writeJsonAtomic(p, { ...(doc || {}), simulation_id: simId });
  return p;
}

export function studyFilePath(projectId, simId, which) {
  return studyPath(projectId, simId, which);
}

export function assembleMeshDocAt(projectDirPath, simId, wantId) {
  if (!projectDirPath || !simId) {
    return {
      meshes: [],
      active_id: null,
      id: null,
      name: null,
      settings: null,
      generated: false,
      live_mesh_result: null,
      simulation_id: simId || null,
    };
  }
  const meshes = walkMeshes(projectDirPath, String(simId));
  const want = wantId != null && String(wantId) !== '' ? String(wantId) : '';
  const active = want ? meshes.find((m) => String(m.id) === want) || null : null;
  return {
    meshes,
    active_id: active ? active.id : null,
    id: active ? active.id : null,
    name: active ? active.name : null,
    settings: active ? active.settings : null,
    generated: !!(active && active.generated),
    live_mesh_result: active ? active.live_mesh_result || null : null,
    simulation_id: simId,
    updated_at: new Date().toISOString(),
    persistence: 'filesystem',
    increment: 'W20',
  };
}

export function assembleMeshDoc(projectId, simId, wantId) {
  if (!projectId || !simId) {
    return assembleMeshDocAt('', simId, wantId);
  }
  return assembleMeshDocAt(projectDir(projectId), simId, wantId);
}

function writeMeshFolder(root, sid, rec, folder) {
  const bound = bindMeshCasePaths({ ...rec, simulation_id: sid }, folder.dir);
  delete bound.dir;
  delete bound.folder;
  writeIdFile(folder.dir, {
    id: bound.id,
    name: bound.name,
    simulation_id: sid,
    kind: 'mesh',
  });
  writeJsonAtomic(join(folder.dir, 'mesh.json'), bound);
  return bound;
}

/** Write one mesh folder only. Never rewrite or delete siblings. */
export function persistOneMeshAt(projectDirPath, simId, rec) {
  const sid = String(simId || (rec && rec.simulation_id) || '');
  if (!sid) throw new Error('simulation_id required to persist mesh');
  if (!rec || !rec.id) throw new Error('mesh id required');
  let folder = findMesh(projectDirPath, String(rec.id), sid);
  if (!folder) folder = createMeshFolder(projectDirPath, sid, rec);
  writeMeshFolder(projectDirPath, sid, rec, folder);
  return folder;
}

export function persistOneMesh(projectId, simId, rec) {
  persistOneMeshAt(projectDir(projectId), simId, rec);
  return assembleMeshDoc(projectId, String(simId || (rec && rec.simulation_id) || ''), rec.id);
}

export function persistMeshDoc(projectId, simId, doc, opts) {
  const root = projectDir(projectId);
  const sid = String(simId || (doc && doc.simulation_id) || '');
  if (!sid) throw new Error('simulation_id required to persist meshes');
  const existing = walkMeshes(root, sid);
  const byId = new Map(existing.map((m) => [String(m.id), m]));
  const meshes = Array.isArray(doc && doc.meshes) ? doc.meshes : [];
  const keep = new Set();
  for (const m of meshes) {
    if (!m || !m.id) continue;
    if (m.simulation_id && String(m.simulation_id) !== sid) continue;
    keep.add(String(m.id));
    let folder = byId.get(String(m.id));
    if (!folder) folder = createMeshFolder(root, sid, m);
    writeMeshFolder(root, sid, m, folder);
  }
  if (opts && opts.prune) {
    for (const m of existing) {
      if (!keep.has(String(m.id))) {
        try {
          rmSync(m.dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return assembleMeshDoc(projectId, sid, doc && (doc.active_id || doc.id));
}

export function meshFolderOf(projectId, meshId, simId) {
  if (!projectId || !meshId) return null;
  return findMesh(projectDir(projectId), String(meshId), simId ? String(simId) : undefined);
}

export function meshCasePath(projectId, meshId, simId) {
  const m = meshFolderOf(projectId, meshId, simId);
  return m ? join(m.dir, 'case') : null;
}

export function readMeshRefinements(projectId, meshId, simId) {
  const m = meshFolderOf(projectId, meshId, simId);
  if (!m) return null;
  const legacy = readJsonFile(meshRefinementsPath(m.dir));
  const rows = walkChildItems(meshRefsDir(m.dir), 'refinement.json');
  const refinements = mergeFolderRows(rows, legacy && legacy.refinements).map((r) => ({
    ...r,
    mesh_id: (r && r.mesh_id) || meshId,
    simulation_id: simId,
  }));
  return { ...(legacy || {}), refinements, mesh_id: meshId, simulation_id: simId };
}

export function writeMeshRefinements(projectId, meshId, simId, doc) {
  const m = meshFolderOf(projectId, meshId, simId);
  if (!m) throw new Error('mesh folder missing for ' + meshId);
  for (const rec of (doc && doc.refinements) || []) {
    if (rec && rec.id) persistOneRefinement(projectId, meshId, simId, rec);
  }
  return meshRefsDir(m.dir);
}

export function assembleRefinements(projectId, simId, meshId) {
  const root = projectDir(projectId);
  const meshes = simId ? walkMeshes(root, String(simId)) : [];
  const want = meshId != null ? String(meshId) : '';
  const refs = [];
  for (const m of meshes) {
    if (want && String(m.id) !== want) continue;
    const doc = readMeshRefinements(projectId, m.id, simId);
    for (const r of (doc && doc.refinements) || []) {
      if (r) refs.push({ ...r, mesh_id: r.mesh_id || m.id, simulation_id: simId });
    }
  }
  return { refinements: refs, simulation_id: simId, mesh_id: want || null };
}

/** Write one run folder only. case/ always stays under that run. */
export function persistRunAt(projectDirPath, simId, run) {
  const sid = String(simId || (run && run.simulation_id) || '');
  if (!sid) throw new Error('simulation_id required to persist run');
  const rid = run && (run.id || run.run_id);
  let folder = rid ? findRun(projectDirPath, String(rid), sid) : null;
  if (!folder) folder = createRunFolder(projectDirPath, sid, run);
  const existing = readJsonFile(join(folder.dir, 'run.json')) || {};
  const rec = {
    ...existing,
    ...run,
    id: rid || folder.id,
    run_id: rid || folder.id,
    simulation_id: sid,
    case_dir: join(folder.dir, 'case'),
    mesh_id: run.mesh_id || existing.mesh_id || null,
    mesh_name: run.mesh_name || existing.mesh_name || null,
  };
  const started = ['running', 'starting', 'done', 'failed', 'stopped'];
  if (started.includes(String(existing.status || '')) && (!run.status || run.status === 'draft' || run.status === 'idle')) {
    rec.status = existing.status;
  }
  const freshStart = (run.status === 'running' || run.status === 'starting') && run.has_results === false;
  if (run.status === 'running' || run.status === 'starting') {
    rec.stop_requested = run.stop_requested === true;
    if (freshStart) {
      rec.finished_at = null;
      rec.exit_code = run.exit_code != null ? run.exit_code : null;
      rec.signal = run.signal != null ? run.signal : null;
      if (!run.stage || rec.stage === 'stopping' || rec.stage === 'copy' || rec.stage === 'reconstruct') {
        rec.stage = run.stage || 'starting';
      }
    }
  }
  if (!freshStart) {
    rec.has_results = !!(run.has_results || existing.has_results);
    const nSaved = Math.max(Number(run.n_saved_times) || 0, Number(existing.n_saved_times) || 0);
    if (nSaved) rec.n_saved_times = nSaved;
    const lastRun = Number(run.last_saved_iteration);
    const lastExist = Number(existing.last_saved_iteration);
    if (Number.isFinite(lastRun) || Number.isFinite(lastExist)) {
      rec.last_saved_iteration = Math.max(lastRun || 0, lastExist || 0);
    }
    try {
      const times = listFoamTimeDirs(join(folder.dir, 'case'))
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && t > 0);
      if (times.length) {
        rec.has_results = true;
        rec.n_saved_times = Math.max(Number(rec.n_saved_times) || 0, times.length);
        rec.last_saved_iteration = Math.max(Number(rec.last_saved_iteration) || 0, times[times.length - 1]);
      }
    } catch (_) {}
    const st = String(rec.stage || '');
    if (
      (Number(rec.n_saved_times) > 0 ||
        Number(rec.last_saved_iteration) > 0 ||
        Number(rec.sim_time) > 0) &&
      (st === 'starting' || st === 'decompose' || !st)
    ) {
      rec.stage = 'solve';
    }
  }
  writeIdFile(folder.dir, {
    id: rec.id,
    name: rec.name,
    simulation_id: sid,
    mesh_id: rec.mesh_id || existing.mesh_id || null,
    kind: 'run',
  });
  if (Array.isArray(run.result_controls)) {
    const keep = new Set();
    for (const rc of run.result_controls) {
      if (!rc || rc.id == null) continue;
      persistChildItem(runRcsDir(folder.dir), 'rc', {
        ...rc,
        run_id: rec.id,
        simulation_id: sid,
      });
      keep.add(String(rc.id));
    }
    for (const row of walkChildItems(runRcsDir(folder.dir), 'result_control.json')) {
      if (!keep.has(String(row.id))) removeChildItem(runRcsDir(folder.dir), 'result_control.json', row.id);
    }
    delete rec.result_controls;
  } else if (!Array.isArray(existing.result_controls)) {
    delete rec.result_controls;
  } else {
    rec.result_controls = existing.result_controls;
  }
  delete rec.dir;
  delete rec.folder;
  writeJsonAtomic(join(folder.dir, 'run.json'), rec);
  return { ...rec, dir: folder.dir, folder: folder.folder };
}

export function persistRun(projectId, simId, run) {
  return persistRunAt(projectDir(projectId), simId, run);
}

export function assembleRuns(projectId, simId) {
  if (!projectId || !simId) return [];
  return walkRuns(projectDir(projectId), String(simId));
}

/** Tree catalog: every study's meshes. Generate/solve still use assembleMeshDoc(simId). */
export function assembleAllMeshes(projectId) {
  if (!projectId) return [];
  return walkAllMeshes(projectDir(projectId));
}

/** Tree catalog: every study's runs. */
export function assembleAllRuns(projectId) {
  if (!projectId) return [];
  return walkAllRuns(projectDir(projectId));
}

/** Tree catalog: every study's materials, tagged with simulation_id. */
export function assembleAllMaterials(projectId) {
  if (!projectId) return [];
  const rows = [];
  for (const s of walkStudies(projectDir(projectId))) {
    const doc = readStudyJson(projectId, s.id, 'materials');
    for (const m of (doc && doc.materials) || []) {
      if (m) rows.push({ ...m, simulation_id: s.id });
    }
  }
  return rows;
}

/** Tree catalog: every study's BCs, tagged with simulation_id. */
export function assembleAllBcs(projectId) {
  if (!projectId) return [];
  const rows = [];
  for (const s of walkStudies(projectDir(projectId))) {
    const doc = readStudyJson(projectId, s.id, 'bcs');
    for (const b of (doc && doc.boundary_conditions) || []) {
      if (b) rows.push({ ...b, simulation_id: s.id });
    }
  }
  return rows;
}

export function runFolderOf(projectId, runId, simId) {
  if (!projectId || !runId) return null;
  return findRun(projectDir(projectId), String(runId), simId ? String(simId) : undefined);
}

export function caseOwnedByMesh(casePath, projectId, meshId, simId) {
  const m = meshFolderOf(projectId, meshId, simId);
  return !!(m && caseUnderOwner(casePath, m.dir));
}
