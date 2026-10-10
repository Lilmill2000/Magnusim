import { isPlaced } from '../monitorTargets';
import { scopeBelongsToProject } from '../scope';
import { runHasVisibleResults } from '../workbench/jobQueueOrder';
import type { TreeActivity, TreeStudies } from './treeSession';

export interface MeshNode {
  id: string;
  name: string;
  ready: boolean;
  busy?: boolean;
  queuePos?: number;
  scopeKey?: string;
  refinements?: Array<{ id: string; name: string; faces: string[]; scopeKey?: string }>;
  /** Generated from an older version of its linked geometry (API 1.5): Generate it again. */
  outOfDate?: boolean;
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
  /** Bodies of the study's material a linked geometry's update could not place (API 1.5). */
  materialLost?: number;
  bcs: Array<{ id: string; name: string; faces: string[]; scopeKey?: string; lost?: number }>;
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
    /** `placed`: assigned faces, boundaries or points (the tree marks it done). */
    resultControls?: Array<{ id: string; name: string; faces: string[]; placed?: boolean; scopeKey?: string }>;
    /** Started on an older version of its linked geometry (API 1.5, D26). */
    olderGeometry?: boolean;
    /** A finished run that converged (API 1.4): how, and at which iteration or time. */
    converged?: RunConverged;
  }>;
}

/** How a finished run converged (API 1.4): its residuals met their targets, or a monitor settled. */
export interface RunConverged {
  by: 'residuals' | 'monitor';
  iteration?: number;
  time?: number;
  text?: string;
}

/** A geometry a plugin study links (API 1.5): what its row says and its Edit button opens. */
export interface GeomLink {
  plugin: string;
  studyId: string;
  studyTitle: string;
  workspace: string;
  /** The plugin study's tree scope (plugin-study-open), '' when its plugin is not installed. */
  studyScopeKey: string;
  /** The title of the workspace its Edit opens ("Edit in <workspace title>"). */
  workspaceTitle: string;
  sourceState: 'ok' | 'plugin_off' | 'plugin_missing';
  /** Why its plugin cannot open the study now (plugin_off): off, needs setup, failed to load. */
  reason: string;
  /** The study's saved design is newer than the geometry's last update. */
  behind: boolean;
  /** A commit journal is left: fenced until the app finishes the update. */
  updating: boolean;
  lostFaces: number;
  rev: number;
}

export interface GeomNode {
  id: string;
  name: string;
  bodies: string[];
  /** A linked geometry's body names and labels by host body label ("Body1"). */
  bodyLabels?: Record<string, { name?: string | null; label?: string | null }>;
  /** Set for the geometry a plugin study links now (not for an earlier version kept unlinked). */
  link?: GeomLink | null;
  /** An earlier version kept unlinked (API 1.5): the lost faces its records still list. */
  unlinkedLost?: number;
  scopeKey?: string;
  studies: StudyNode[];
  /** API 1.7: the geometry actions it offers ("Edit in CAD"), as the tree node has them. */
  editActions?: import('../workspace/geometryActions').GeometryActionRow[];
  /** API 1.7: an adopted geometry's original ("Add the original as a new geometry"). */
  original?: { fileName: string | null; format: string | null; present: boolean } | null;
  /** API 1.7: the studies a geometry action opened on this plain geometry that sent no edit back yet. */
  editedIn?: Array<{ plugin: string; id: string; title: string; workspace: string; scopeKey: string; available: boolean }>;
}

export interface SetupTreeModel {
  geoms: GeomNode[];
  selectedKey: string | null;
}

export interface ProjectTreeDoc {
  project_id?: string;
  geometries?: ProjectTreeGeom[];
  plugin_nodes?: Array<{ label?: string; name?: string; key?: string; scope?: string; projectId?: string; project_id?: string }>;
  plugin_studies?: PluginStudyRow[];
  plugin_study_kinds?: PluginStudyKind[];
  /** Some plugin studies are being upgraded by their plugin: read the tree again soon. */
  plugin_studies_migrating?: boolean;
}

/** A project-level study a plugin owns (plugin_studies.list). */
export interface PluginStudyRow {
  id: string;
  plugin: string;
  plugin_name: string;
  kind: string;
  kind_title: string;
  icon: string;
  workspace: string;
  /** Its workspace's title (API 1.5); '' when unknown (its plugin is off). */
  workspace_title?: string;
  title: string;
  rev: number;
  /** False when its plugin is off or missing: greyed, cannot open or rename. */
  available: boolean;
  /** Saved by a newer plugin version: opens read-only. */
  read_only: boolean;
  reason: string;
  scope_key: string;
  /** API 1.7: the project geometry a geometry action opened it on ('' when none). */
  edits_geometry?: string;
  /** API 1.7: it edits that plain geometry and sent no edit back yet: shown on the geometry's row, not in STUDIES. */
  editing?: string;
}

/** A study kind an enabled plugin declares (manifest [[study_kinds]]). */
export interface PluginStudyKind {
  plugin: string;
  plugin_name: string;
  key: string;
  title: string;
  icon: string;
  /** The workspace a study of this kind opens in ("" when none). */
  workspace?: string;
  /** API 1.4: a study of this kind may link a project geometry (used from 1.5). */
  links_geometry?: boolean;
  /** API 1.4: its start action (manifest [[start_actions]]), or null. */
  start_action?: import('../workspace/startActions').StartAction | null;
  /** API 1.7: its geometry action (manifest [[geometry_actions]]), or null. */
  geometry_action?: {
    study_kind: string;
    kind_title: string;
    workspace: string;
    workspace_title: string;
    label: string;
    hint: string;
    icon: string;
    formats: string[];
    places: string[];
  } | null;
}

interface ProjectTreeGeom {
  id?: string;
  name?: string;
  key?: string;
  bodies?: string[];
  studies?: ProjectTreeStudy[];
  // A linked geometry (API 1.5; worker project.tree).
  source?: { plugin?: string; study_id?: string; workspace?: string; study_title?: string } | null;
  rev?: number;
  names8?: string;
  updating?: boolean;
  unlinked?: boolean;
  body_labels?: Array<{ ref?: string; name?: string | null; label?: string | null }>;
  lost_faces?: number;
  // study_deleted comes with unlinked: a plain geometry (proposal 5.18, 5.19).
  source_state?: 'ok' | 'plugin_off' | 'plugin_missing' | 'study_deleted';
  source_reason?: string;
  behind?: boolean;
  // API 1.7: what it was imported from, why no action may edit it now ('' when one may),
  // the geometry actions of the plugins that are on (each enabled or with its reason), and
  // what an adopted geometry was imported from.
  format?: 'step' | 'iges' | 'brep' | 'mesh' | null;
  edit_block?: string;
  edit_actions?: import('../workspace/geometryActions').GeometryActionRow[];
  original?: { file_name?: string | null; format?: string | null; present?: boolean } | null;
  edited_in?: Array<{ plugin?: string; id?: string; title?: string; workspace?: string; scope_key?: string; available?: boolean }>;
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
  material_lost?: number;
  bcs?: Array<{ id?: string; name?: string; faces?: string[]; key?: string; lost?: number }>;
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
  out_of_date?: boolean;
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
  result_controls?: Array<{ id?: string; name?: string; faces?: string[]; placed?: boolean; key?: string }>;
  older_geometry?: boolean;
  converged?: RunConverged;
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
  if (index < 0) return 0;
  // The queue is shared by every project: show the place in the whole queue, not
  // among this project's rows (other projects' jobs can be ahead).
  const overall = Number(queue[index].position);
  return overall > 0 ? overall : index + 1;
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

function bodyLabelsOf(geom: ProjectTreeGeom): GeomNode['bodyLabels'] {
  const out: NonNullable<GeomNode['bodyLabels']> = {};
  for (const b of geom.body_labels || []) {
    if (b && b.ref) out[String(b.ref)] = { name: b.name ?? null, label: b.label ?? null };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The link of a geometry a plugin study links now; null for any other (an earlier version is a plain row). */
function geomLinkOf(geom: ProjectTreeGeom, doc: ProjectTreeDoc | null | undefined): GeomLink | null {
  const src = geom.source;
  // A deleted study comes with unlinked too; its state is no link state.
  if (!src || !src.plugin || !src.study_id || geom.unlinked || geom.source_state === 'study_deleted') return null;
  const row = (doc?.plugin_studies || []).find((r) => r && r.plugin === src.plugin && r.id === src.study_id) || null;
  // Every plugin study on disk is listed, whatever its plugin's state: no row, no study.
  if (!row && !geom.source_state) return null;
  const state = geom.source_state || (row && row.available ? 'ok' : 'plugin_off');
  return {
    plugin: String(src.plugin),
    studyId: String(src.study_id),
    studyTitle: str(row?.title || src.study_title, 'its study'),
    workspace: str(row?.workspace || src.workspace),
    studyScopeKey: state === 'plugin_missing' ? '' : str(row?.scope_key),
    workspaceTitle: str(row?.workspace_title),
    sourceState: state,
    reason: state === 'plugin_off' ? str(geom.source_reason || row?.reason, `Requires the ${str(row?.plugin_name, String(src.plugin))} plugin`) : '',
    behind: !!geom.behind,
    updating: !!geom.updating,
    lostFaces: Number(geom.lost_faces) || 0,
    rev: Number(geom.rev) || 0,
  };
}

/**
 * The geometry each linking plugin study links now, by "<plugin>|<study id>" (API 1.5):
 * its row says "→ <geometry>" ("→ Part 1 v2" after "Save as new"). An earlier version kept
 * unlinked is not the study's any more.
 */
export function linkedGeometryByStudy(doc: ProjectTreeDoc | null | undefined): Record<string, { id: string; name: string }> {
  const out: Record<string, { id: string; name: string }> = {};
  for (const g of doc?.geometries || []) {
    const src = g && g.source;
    if (!src || !src.plugin || !src.study_id || g.unlinked || !g.id) continue;
    out[`${src.plugin}|${src.study_id}`] = { id: String(g.id), name: str(g.name, 'Geometry') };
  }
  return out;
}

export function readSetupTree(
  doc?: ProjectTreeDoc | null,
  activity?: TreeActivity | null,
  selectedKey: string | null = null,
  workbench?: TreeStudies | null,
): SetupTreeModel {
  const projectId = str(doc?.project_id);
  const act = scopedActivity(activity, projectId);
  // The workbench's studies win over an older read: a deleted study has no row, and the
  // active row (the one with the + buttons) is the study the workbench has open.
  const known = workbench && projectId && workbench.projectId === projectId ? workbench : null;
  const gone = new Set(known ? known.gone : []);
  const owned = <T extends { key?: string }>(nodes: T[] | undefined): T[] =>
    (nodes || []).filter((node) => !node?.key || !projectId || scopeBelongsToProject(String(node.key), projectId));
  const geoms: GeomNode[] = owned(doc?.geometries).map((geom) => {
    const gid = str(geom.id);
    const studies = owned(geom.studies)
      .filter((study) => study && str(study.geometry_id) === gid && !gone.has(str(study.id)))
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
      bodyLabels: bodyLabelsOf(geom),
      link: geomLinkOf(geom, doc),
      // An earlier version kept by "Save as new" is a plain row; it keeps its lost-face count.
      unlinkedLost: geom.unlinked ? Number(geom.lost_faces) || 0 : 0,
      editActions: Array.isArray(geom.edit_actions) ? geom.edit_actions : [],
      editedIn: (Array.isArray(geom.edited_in) ? geom.edited_in : []).map((s) => ({
        plugin: str(s.plugin),
        id: str(s.id),
        title: str(s.title, str(s.id)),
        workspace: str(s.workspace),
        scopeKey: str(s.scope_key),
        available: s.available !== false,
      })),
      original: geom.original
        ? { fileName: geom.original.file_name ? String(geom.original.file_name) : null, format: geom.original.format ? String(geom.original.format) : null, present: !!geom.original.present }
        : null,
      studies: studies.map((study) => {
        const sid = str(study.id);
        const studyAct = forStudy(act, sid) ? act : null;
        const volumes = (study.material_volumes || []).map((v) => str(v)).filter(Boolean);
        return {
          id: sid,
          name: str(study.name, 'Simulation'),
          geometryId: str(study.geometry_id),
          scopeKey: study.key,
          active: known ? !!sid && sid === known.activeId : !!study.active,
          materialsAssigned: volumes.length > 0,
          materialName: str(study.material_name),
          materialVolumes: volumes,
          materialLost: Number(study.material_lost) || 0,
          wallDefault: str(study.wall_default, 'No-slip'),
          bcs: owned(study.bcs).map((bc, i) => ({
            id: str(bc.id, `bc_${i}`),
            name: str(bc.name, 'BC'),
            faces: (bc.faces || []).map((face) => str(face)).filter(Boolean),
            scopeKey: bc.key,
            ...(Number(bc.lost) > 0 ? { lost: Number(bc.lost) } : {}),
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
              ...(mesh.out_of_date ? { outOfDate: true } : {}),
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
                placed: rc.placed ?? isPlaced(rc as Record<string, unknown>),
                scopeKey: rc.key,
              })),
              ...(run.older_geometry ? { olderGeometry: true } : {}),
              ...(done && run.converged && typeof run.converged === 'object' ? { converged: run.converged } : {}),
            };
          }),
        };
      }),
    };
  });
  return { geoms, selectedKey };
}
