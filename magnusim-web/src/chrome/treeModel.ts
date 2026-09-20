import { runHasVisibleResults } from '../workbench/jobQueueOrder';

export type TreeRec = Record<string, unknown>;

export interface MeshNode {
  id: string;
  name: string;
  ready: boolean;
  busy?: boolean;
  queuePos?: number;
  refinements?: Array<{ id: string; name: string; faces: string[] }>;
}

export interface StudyNode {
  id: string;
  name: string;
  geometryId: string;
  active: boolean;
  meshes: MeshNode[];
  materialsAssigned: boolean;
  materialVolumes: string[];
  bcs: Array<{ id: string; name: string; faces: string[] }>;
  wallDefault: string;
  runs: Array<{
    id: string;
    name: string;
    meshId?: string;
    meshName?: string;
    ready: boolean;
    hasResults?: boolean;
    busy?: boolean;
    queuePos?: number;
    resultControls?: Array<{ id: string; name: string; faces: string[] }>;
  }>;
}

export interface GeomNode {
  id: string;
  name: string;
  bodies: string[];
  studies: StudyNode[];
}

export interface SetupTreeModel {
  geoms: GeomNode[];
  selectedKey: string | null;
}

function recs(v: unknown): TreeRec[] {
  return Array.isArray(v) ? (v as TreeRec[]) : [];
}

function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v);
}

function expandedMap(): Record<string, boolean> {
  const ui = window.__CFD_TREE_UI__;
  return (ui && ui.expanded) || {};
}

export function treeExpanded(label: string, fallback = false): boolean {
  const exp = expandedMap();
  if (Object.prototype.hasOwnProperty.call(exp, label)) return !!exp[label];
  return fallback;
}

type JobActivity = {
  kind?: string | null;
  mesh_id?: string | null;
  run_id?: string | null;
  queue?: Array<{ kind?: string; mesh_id?: string | null; run_id?: string | null }>;
};

function jobActivity(): JobActivity {
  return (window.__CFD_JOB_ACTIVITY__ as JobActivity) || {};
}

function activityQueuePos(kind: 'mesh' | 'solve', id: string): number {
  if (!id) return 0;
  const q = jobActivity().queue || [];
  const i = q.findIndex((r) => {
    if (!r || r.kind !== kind) return false;
    return kind === 'mesh' ? String(r.mesh_id) === id : String(r.run_id) === id;
  });
  return i >= 0 ? i + 1 : 0;
}

function meshBusy(mesh: TreeRec | null | undefined, id: string): boolean {
  if (meshReady(mesh)) return false;
  const act = jobActivity();
  if (act.kind === 'mesh' && !!id && String(act.mesh_id) === id) return true;
  if (act.kind && act.kind !== 'mesh') return false;
  const live = mesh && (mesh.live_mesh_result as TreeRec | undefined);
  return !!(live && live.status === 'running' && (!act.mesh_id || String(act.mesh_id) === id));
}

function runBusy(rec: { status?: string; id?: string; run_id?: string }, id: string): boolean {
  const st = String(rec.status || '');
  if (st === 'done' || st === 'failed' || st === 'stopped') return false;
  if (st === 'running' || st === 'starting') return true;
  const act = jobActivity();
  return act.kind === 'solve' && !!id && String(act.run_id) === id;
}

function meshReady(mesh: TreeRec | null | undefined): boolean {
  if (!mesh) return false;
  const live = mesh.live_mesh_result as TreeRec | undefined;
  const act = jobActivity();
  const thisGenerating =
    act.kind === 'mesh' && !!mesh.id && String(act.mesh_id) === String(mesh.id);
  if (live && live.status === 'running' && thisGenerating) return false;
  const caseDir = (live && live.case_dir) || mesh.case_dir;
  const cells = Number(live && live.n_cells != null ? live.n_cells : mesh.n_cells);
  const hasCells = Number.isFinite(cells) && cells > 0;
  if (live && live.status === 'done' && (caseDir || hasCells)) return true;
  if (mesh.generated && caseDir) return true;
  if (caseDir && hasCells) return true;
  return false;
}

function allMeshes(): TreeRec[] {
  const st = window.__CFD_W20_STATE__ as { meshes_all?: TreeRec[]; meshes?: TreeRec[] } | undefined;
  if (st && Array.isArray(st.meshes_all)) return st.meshes_all;
  if (st && Array.isArray(st.meshes)) return st.meshes;
  const pub = window.__CFD_W20__ as { meshes?: TreeRec[] } | undefined;
  return recs(pub?.meshes);
}

function meshesForStudy(study: TreeRec, _geoms: TreeRec[], studies: TreeRec[]): MeshNode[] {
  const all = allMeshes();
  const sid = str(study.id);
  if (!sid) return [];
  const tagged = all.filter((m) => m && m.simulation_id && String(m.simulation_id) === sid);
  const source = tagged.length
    ? tagged
    : studies.length === 1 && String(studies[0].id) === sid
      ? all.filter(
          (m) =>
            m &&
            !m.simulation_id &&
            (!m.geometry_id || !study.geometry_id || String(m.geometry_id) === String(study.geometry_id)),
        )
      : [];
  return source.map((m, i) => {
    const id = str(m.id || m.name, `mesh_${i + 1}`);
    return {
      id,
      name: str(m.name, `Mesh ${i + 1}`),
      ready: meshReady(m),
      busy: meshBusy(m, id),
      queuePos: activityQueuePos('mesh', id),
      refinements: refsForMesh(id),
    };
  });
}

function refsForMesh(meshId: string): Array<{ id: string; name: string; faces: string[] }> {
  const st = window.__CFD_W26_STATE__ as { refinements?: TreeRec[] } | undefined;
  return recs(st && st.refinements)
    .filter((r) => String(r.mesh_id || '') === String(meshId))
    .map((r, i) => ({
      id: str(r.id, `ref_${i}`),
      name: str(r.name, 'Refinement'),
      faces: Array.isArray(r.faces) ? r.faces.map(String) : [],
    }));
}

export function readSetupTree(): SetupTreeModel {
  const w16 = (window.__CFD_W16_STATE__ || window.__CFD_W16__ || {}) as TreeRec;
  const w17 = (window.__CFD_W17_STATE__ || window.__CFD_W17__ || {}) as TreeRec;
  const w17sims = recs((w17 as { simulations?: TreeRec[] }).simulations);
  const w16geoms = recs(w16.geometries);
  const geomOne = w16.geometry as TreeRec | undefined;
  const geomsRaw =
    w16geoms.length > 0
      ? w16geoms
      : geomOne && (geomOne.id || geomOne.name || geomOne.step_path || geomOne.faces_url)
        ? [geomOne]
        : [];
  const liveIds = new Set(geomsRaw.map((g) => str(g.id)).filter(Boolean));
  const studies = (
    w17sims.length
      ? w17sims
      : w17.simulation
        ? [w17.simulation as TreeRec]
        : []
  )
    .filter((s) => s && s.geometry_id && (!liveIds.size || liveIds.has(str(s.geometry_id))))
    .slice()
    .sort((a, b) => {
      const ai = Number(a.sort_index);
      const bi = Number(b.sort_index);
      if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
      return 0;
    });
  const activeSid = str((w17.simulation as TreeRec | undefined)?.id || w17.activeId);
  const w18 = window.__CFD_W18_STATE__ as {
    material?: { assigned_volumes?: string[]; simulation_id?: string };
    materials_all?: Array<{
      name?: string;
      assigned_volumes?: string[];
      simulation_id?: string;
    }>;
  } | undefined;
  const matsAll = recs(w18 && w18.materials_all);
  const w19 = window.__CFD_W19_STATE__ as {
    bcs?: Array<{ id?: string; name?: string; faces?: string[]; simulation_id?: string }>;
    bcs_all?: Array<{ id?: string; name?: string; faces?: string[]; simulation_id?: string }>;
    defaults?: { wall_type?: string };
    defaults_by_simulation?: Record<string, { wall_type?: string }>;
  } | undefined;
  const bcsAll = (w19 && (w19.bcs_all || w19.bcs)) || [];
  const defsBy = (w19 && w19.defaults_by_simulation) || {};
  const w27 = window.__CFD_W27_STATE__ as {
    runs?: Array<{
      id?: string;
      run_id?: string;
      name?: string;
      mesh_id?: string;
      mesh_name?: string;
      status?: string;
      simulation_id?: string;
      result_controls?: unknown;
    }>;
    runs_all?: Array<{
      id?: string;
      run_id?: string;
      name?: string;
      mesh_id?: string;
      mesh_name?: string;
      status?: string;
      simulation_id?: string;
      result_controls?: unknown;
    }>;
  } | undefined;
  const runsAll = (w27 && (w27.runs_all || w27.runs)) || [];
  const ui = window.__CFD_TREE_UI__;

  function rowsForStudy<T extends { simulation_id?: string }>(rows: T[], sid: string): T[] {
    const tagged = rows.filter((r) => r && r.simulation_id && String(r.simulation_id) === sid);
    if (tagged.length) return tagged;
    if (studies.length === 1 && String(studies[0].id) === sid) {
      return rows.filter((r) => r && !r.simulation_id);
    }
    return [];
  }

  function wallForStudy(sid: string, isActive: boolean): string {
    const raw = (defsBy[sid] && defsBy[sid].wall_type) || (isActive ? w19?.defaults?.wall_type : '');
    return String(raw || '').trim().toLowerCase() === 'slip' ? 'Slip' : 'No-slip';
  }

  const geoms: GeomNode[] = geomsRaw.map((g) => {
    const gid = str(g.id);
    const bodies = recs(g.bodies).map((b) => (typeof b === 'string' ? b : str((b as TreeRec).name)))
      .filter(Boolean);
    const bodyList =
      bodies.length > 0
        ? bodies
        : recs(g.assembly_bodies).map((b) => str(b)).filter(Boolean);
    const mine = studies.filter((s) => String(s.geometry_id) === gid);
    return {
      id: gid,
      name: str(g.name || g.original_filename, 'Geometry'),
      bodies: bodyList.length ? bodyList : geomOne && String(geomOne.id) === gid ? ['Body1'] : [],
      studies: mine.map((s) => {
        const sid = str(s.id);
        const isActive = !!(activeSid && sid === activeSid);
        const studyMeshes = meshesForStudy(s, geomsRaw, studies);
        const air =
          rowsForStudy(matsAll, sid).find((m) => String(m.name || 'Air') === 'Air') ||
          (isActive && w18 && w18.material ? w18.material : null);
        const vols = Array.isArray(air?.assigned_volumes) ? air.assigned_volumes : [];
        const studyBcs = rowsForStudy(bcsAll, sid);
        const studyRuns = rowsForStudy(runsAll, sid);
        return {
          id: sid,
          name: str(s.name, 'Incompressible'),
          geometryId: str(s.geometry_id),
          active: isActive,
          meshes: studyMeshes,
          materialsAssigned: vols.length > 0,
          materialVolumes: vols.map((v) => String(v)),
          bcs: studyBcs.map((bc, i) => ({
            id: str(bc.id, `bc_${i}`),
            name: str(bc.name, 'BC'),
            faces: Array.isArray(bc.faces) ? bc.faces.map(String) : [],
          })),
          wallDefault: wallForStudy(sid, isActive),
          runs: studyRuns.map((r) => {
            const rid = str(r.id || r.run_id);
            const done = r.status === 'done';
            return {
              id: rid,
              name: str(r.name, 'Run'),
              meshId: r.mesh_id ? String(r.mesh_id) : undefined,
              meshName: r.mesh_name ? String(r.mesh_name) : undefined,
              ready: done,
              hasResults: done || runHasVisibleResults(r),
              busy: runBusy(r, rid),
              queuePos: activityQueuePos('solve', rid),
              resultControls: recs(r.result_controls).map((rc, i) => ({
                id: str(rc.id || rc.name, `rc_${i}`),
                name: str(rc.name || rc.kind, 'Result'),
                faces: Array.isArray(rc.faces) ? rc.faces.map(String) : [],
              })),
            };
          }),
        };
      }),
    };
  });

  return { geoms, selectedKey: (ui && ui.selectedKey) || null };
}
