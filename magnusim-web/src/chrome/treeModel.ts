import { scopeBelongsToProject } from '../scope';
import { runHasVisibleResults } from '../workbench/jobQueueOrder';
import type { TreeActivity } from './treeSession';

export interface MeshNode {
  id: string;
  name: string;
  ready: boolean;
  busy?: boolean;
  queuePos?: number;
  scopeKey?: string;
  refinements?: Array<{ id: string; name: string; faces: string[]; scopeKey?: string }>;
}

export interface StudyNode {
  id: string;
  name: string;
  geometryId: string;
  active: boolean;
  scopeKey?: string;
  meshes: MeshNode[];
  materialsAssigned: boolean;
  materialName?: string;
  materialVolumes: string[];
  bcs: Array<{ id: string; name: string; faces: string[]; scopeKey?: string }>;
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
    scopeKey?: string;
    resultControls?: Array<{ id: string; name: string; faces: string[]; scopeKey?: string }>;
  }>;
}

export interface GeomNode {
  id: string;
  name: string;
  bodies: string[];
  scopeKey?: string;
  studies: StudyNode[];
}

export interface SetupTreeModel {
  geoms: GeomNode[];
  selectedKey: string | null;
}

export interface ProjectTreeDoc {
  project_id?: string;
  geometries?: ProjectTreeGeom[];
  plugin_nodes?: Array<{ label?: string; name?: string; key?: string; scope?: string; projectId?: string; project_id?: string }>;
}

interface ProjectTreeGeom {
  id?: string;
  name?: string;
  key?: string;
  bodies?: string[];
  studies?: ProjectTreeStudy[];
}

interface ProjectTreeStudy {
  id?: string;
  name?: string;
  geometry_id?: string;
  key?: string;
  sort_index?: number;
  active?: boolean;
  wall_default?: string;
  material_volumes?: string[];
  material_name?: string;
  bcs?: Array<{ id?: string; name?: string; faces?: string[]; key?: string }>;
  meshes?: ProjectTreeMesh[];
  runs?: ProjectTreeRun[];
}

interface ProjectTreeMesh {
  id?: string;
  name?: string;
  key?: string;
  generated?: boolean;
  case_dir?: string;
  n_cells?: number | null;
  live_status?: string;
  refinements?: Array<{ id?: string; name?: string; faces?: string[]; key?: string }>;
}

interface ProjectTreeRun {
  id?: string;
  name?: string;
  key?: string;
  mesh_id?: string;
  mesh_name?: string;
  status?: string;
  case_dir?: string;
  n_saved_times?: number;
  last_saved_iteration?: number;
  has_results?: boolean;
  result_controls?: Array<{ id?: string; name?: string; faces?: string[]; key?: string }>;
}

type QueueRow = NonNullable<TreeActivity['queue']>[number];

function str(v: unknown, fallback = ''): string {
  return v == null || v === '' ? fallback : String(v);
}

function scopedActivity(activity: TreeActivity | null | undefined, projectId: string): TreeActivity | null {
  if (!activity || !activity.project_id || String(activity.project_id) !== String(projectId)) return null;
  return activity;
}

function forStudy(activity: TreeActivity | null, studyId: string): boolean {
  return !!activity && !!activity.simulation_id && String(activity.simulation_id) === String(studyId);
}

function queuePos(
  activity: TreeActivity | null,
  projectId: string,
  studyId: string,
  kind: 'mesh' | 'solve',
  id: string,
): number {
  if (!activity || !id) return 0;
  const queue = activity.queue || [];
  const index = queue.findIndex((row) => queueMatches(row, projectId, studyId, kind, id));
  return index >= 0 ? index + 1 : 0;
}

function queueMatches(
  row: QueueRow | undefined,
  projectId: string,
  studyId: string,
  kind: 'mesh' | 'solve',
  id: string,
): boolean {
  if (!row || row.kind !== kind) return false;
  if (row.project_id && String(row.project_id) !== String(projectId)) return false;
  if (!row.simulation_id || String(row.simulation_id) !== String(studyId)) return false;
  return kind === 'mesh' ? String(row.mesh_id) === id : String(row.run_id) === id;
}

function meshReady(mesh: ProjectTreeMesh, activity: TreeActivity | null, studyId: string, id: string): boolean {
  const thisGenerating =
    forStudy(activity, studyId) && activity?.kind === 'mesh' && !!id && String(activity.mesh_id) === id;
  if (mesh.live_status === 'running' && thisGenerating) return false;
  const caseDir = mesh.case_dir;
  const cells = Number(mesh.n_cells);
  const hasCells = Number.isFinite(cells) && cells > 0;
  if (mesh.live_status === 'done' && (caseDir || hasCells)) return true;
  if (mesh.generated && caseDir) return true;
  if (caseDir && hasCells) return true;
  return false;
}

function meshBusy(
  mesh: ProjectTreeMesh,
  activity: TreeActivity | null,
  studyId: string,
  id: string,
  ready: boolean,
): boolean {
  if (ready) return false;
  if (!forStudy(activity, studyId)) return mesh.live_status === 'running' && !activity;
  if (activity?.kind === 'mesh' && !!id && String(activity.mesh_id) === id) return true;
  if (activity?.kind && activity.kind !== 'mesh') return false;
  return mesh.live_status === 'running' && (!activity?.mesh_id || String(activity.mesh_id) === id);
}

function runBusy(run: ProjectTreeRun, activity: TreeActivity | null, studyId: string, id: string): boolean {
  const status = String(run.status || '');
  if (status === 'done' || status === 'failed' || status === 'stopped') return false;
  if (status === 'running' || status === 'starting') return true;
  return forStudy(activity, studyId) && activity?.kind === 'solve' && !!id && String(activity.run_id) === id;
}

export function readSetupTree(
  doc?: ProjectTreeDoc | null,
  activity?: TreeActivity | null,
  selectedKey: string | null = null,
): SetupTreeModel {
  const projectId = str(doc?.project_id);
  const act = scopedActivity(activity, projectId);
  const owned = <T extends { key?: string }>(nodes: T[] | undefined): T[] =>
    (nodes || []).filter((node) => !node?.key || !projectId || scopeBelongsToProject(String(node.key), projectId));
  const geoms: GeomNode[] = owned(doc?.geometries).map((geom) => {
    const gid = str(geom.id);
    const studies = owned(geom.studies)
      .filter((study) => study && str(study.geometry_id) === gid)
      .slice()
      .sort((a, b) => {
        const ai = Number(a.sort_index);
        const bi = Number(b.sort_index);
        if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
        return 0;
      });
    return {
      id: gid,
      name: str(geom.name, 'Geometry'),
      scopeKey: geom.key,
      bodies: (geom.bodies || []).map((body) => str(body)).filter(Boolean),
      studies: studies.map((study) => {
        const sid = str(study.id);
        const studyAct = forStudy(act, sid) ? act : null;
        const volumes = (study.material_volumes || []).map((v) => str(v)).filter(Boolean);
        return {
          id: sid,
          name: str(study.name, 'Incompressible'),
          geometryId: str(study.geometry_id),
          scopeKey: study.key,
          active: !!study.active,
          materialsAssigned: volumes.length > 0,
          materialName: str(study.material_name, 'Air'),
          materialVolumes: volumes,
          wallDefault: str(study.wall_default, 'No-slip'),
          bcs: owned(study.bcs).map((bc, i) => ({
            id: str(bc.id, `bc_${i}`),
            name: str(bc.name, 'BC'),
            faces: (bc.faces || []).map((face) => str(face)).filter(Boolean),
            scopeKey: bc.key,
          })),
          meshes: owned(study.meshes).map((mesh, i) => {
            const id = str(mesh.id || mesh.name, `mesh_${i + 1}`);
            const ready = meshReady(mesh, studyAct, sid, id);
            return {
              id,
              name: str(mesh.name, `Mesh ${i + 1}`),
              scopeKey: mesh.key,
              ready,
              busy: meshBusy(mesh, studyAct, sid, id, ready),
              queuePos: queuePos(studyAct, projectId, sid, 'mesh', id),
              refinements: owned(mesh.refinements).map((ref, refIndex) => ({
                id: str(ref.id, `ref_${refIndex}`),
                name: str(ref.name, 'Refinement'),
                faces: (ref.faces || []).map((face) => str(face)).filter(Boolean),
                scopeKey: ref.key,
              })),
            };
          }),
          runs: owned(study.runs).map((run) => {
            const id = str(run.id);
            const done = run.status === 'done';
            return {
              id,
              name: str(run.name, 'Run'),
              scopeKey: run.key,
              meshId: run.mesh_id ? String(run.mesh_id) : undefined,
              meshName: run.mesh_name ? String(run.mesh_name) : undefined,
              ready: done,
              hasResults: done || runHasVisibleResults(run),
              busy: runBusy(run, studyAct, sid, id),
              queuePos: queuePos(studyAct, projectId, sid, 'solve', id),
              resultControls: owned(run.result_controls).map((rc, i) => ({
                id: str(rc.id || rc.name, `rc_${i}`),
                name: str(rc.name, 'Result'),
                faces: (rc.faces || []).map((face) => str(face)).filter(Boolean),
                scopeKey: rc.key,
              })),
            };
          }),
        };
      }),
    };
  });
  return { geoms, selectedKey };
}
