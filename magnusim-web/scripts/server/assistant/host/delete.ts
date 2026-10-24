/**
 * delete (Core host tools spec 4.15, 14.2): anything a person can delete, always asked
 * first, the card naming what goes with it (a geometry's studies, a folder's projects, the
 * faces a BC leaves unassigned). Every kind reads its target first: to check it exists and
 * to say what goes. A project or a folder is deleted by id from anywhere (Daniel, Q1);
 * everything else only in the project open in this window.
 *
 * The bodies never delete more than the one record: a BC and a refinement go by their id
 * string (`{delete:true}` would delete every one of the study), a material always names
 * material_id (without it every material goes), a generated mesh goes through POST
 * /api/mesh {delete_generated} (its hook runs; /api/mesh/delete skips it).
 */
import type { GateDetail } from '../gates.ts';
import type { ToolCtx, ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import {
  emitSync,
  fail,
  failed,
  hostTool,
  isRecord,
  objectSchema,
  offeredIn,
  okDone,
  placeOf,
  projectIdOf,
  quoted,
  records,
  refuse,
  S,
  str,
  studiesOf,
  via,
  writableProject,
  type AssessContext,
  type Assessed,
  type HostToolDeps,
  type HostToolDef,
  type SyncKind,
} from './common.ts';
import { readProject } from './read-setup.ts';
import { andList } from './study-edit.ts';

export const DELETE_KINDS = ['project', 'folder', 'geometry', 'study', 'plugin_study', 'mesh_generated', 'mesh', 'refinement', 'run', 'material', 'bc', 'monitor', 'saved_view', 'media', 'lost_faces'] as const;
/** The kinds a Home turn may delete (the project cards). */
const HOME_KINDS = new Set(['project', 'folder']);
const ROOT_FOLDER = 'My Projects';

interface Target {
  /** The card's title, the item named: `delete geometry "Bracket"`. */
  what: string;
  /** The knock-on line (14.2). */
  note: string;
  detail: GateDetail[];
  /** Deletes it; returns the answer's line and the sync it causes. */
  exec(): Promise<{ done: string; kinds: SyncKind[]; ids: Record<string, string[]>; sim: string | null }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const faceNumbers = (faces: unknown[]) => faces.map((f) => /^face\s*(\d+)/i.exec(str(f))?.[1] ?? str(f));

export function deleteTool(d: HostToolDeps): HostToolDef {
  const contexts = ['home', 'workbench'] as const;
  /** What each assessed call deletes, as its card names it (by the call's input). */
  const named = new WeakMap<Record<string, unknown>, string>();

  /** The target of a call, read now: what goes, and how to delete it. */
  async function targetOf(input: Record<string, unknown>, ctx: ToolCtx, rt: { signal: AbortSignal; turn: string | null }): Promise<Target> {
    const kind = str(input.kind);
    const id = str(input.id).trim();
    const sub = str(input.sub_id).trim();
    const o = via(rt, `delete.${kind}`);
    const notFound = (what: string, hint: string): never => refuse('not_found', `No ${what} "${cleanText(id, 80)}".`, hint);
    if (kind === 'folder') {
      if (!id || id === ROOT_FOLDER) refuse('invalid_input', 'Name the folder to delete (My Projects can\'t be deleted).');
      const list = (await d.hostCall('projects.list', {}, o)) as Record<string, unknown>;
      const folders = Array.isArray(list.folders) ? list.folders : [];
      const inside = records(list.projects).filter((p) => str(p.folder) === id);
      if (!folders.includes(id) && !inside.length) notFound('folder', 'projects lists the folders.');
      const detail = inside.slice(0, 6).map((p) => ({ label: 'Project', value: cleanText(str(p.title), 80) }));
      if (inside.length > 6) detail[5] = { label: 'Projects', value: `and ${inside.length - 5} more` };
      return {
        what: `folder ${quoted(id)}${inside.length ? ` and its ${plural(inside.length, 'project')}` : ''}`,
        note: inside.length ? 'Deletes these projects and everything in them.' : 'The folder is empty.',
        detail,
        exec: async () => {
          await d.hostCall('folders.delete', { name: id }, o);
          return { done: `Deleted folder ${quoted(id)}${inside.length ? ` and its ${plural(inside.length, 'project')}` : ''}.`, kinds: ['tree'], ids: { project: inside.map((p) => str(p.id)) }, sim: null };
        },
      };
    }
    if (kind === 'project') {
      const pid = id || ctx.projectId || '';
      const list = (await d.hostCall('projects.list', {}, o)) as Record<string, unknown>;
      const row = records(list.projects).find((p) => p.id === pid);
      if (!row) notFound('project', 'projects lists them.');
      const [proj, studies] = await Promise.all([readProject(d.hostCall, rt, pid, 'delete.project'), studiesOf(d.hostCall, pid, rt, 'delete.project')]);
      const nGeom = records(proj.geometries).length;
      return {
        what: `project ${quoted(row?.title)}`,
        note: `Deletes the project and everything in it: ${plural(nGeom, 'geometry', 'geometries')}, ${plural(studies.list.length, 'study', 'studies')}, their meshes, runs and results.`,
        detail: [{ label: 'Project', value: cleanText(str(row?.title), 80) }],
        exec: async () => {
          await d.hostCall('project.delete', { project_id: pid }, o);
          return { done: `Deleted project ${quoted(row?.title)}.`, kinds: ['tree'], ids: { project: [pid] }, sim: null };
        },
      };
    }
    // Everything else: in the project open in this window.
    const project = ctx.projectId;
    if (!project) return refuse('no_project', 'No project is open in this window.', "Open one first: core__show {target:'project', project_id}.");
    const given = str(input.project_id).trim();
    if (given && given !== project) refuse('not_this_project', 'Changes go only to the project open in this window.', `Open it first: core__show {target:'project', project_id:'${cleanText(given, 80)}'}, then call this again.`);
    const studies = await studiesOf(d.hostCall, project, rt, `delete.${kind}`);
    const sim = str(input.simulation_id).trim() || ctx.simulationId || studies.activeId || '';
    const q = { project_id: project, simulation_id: sim };
    const done = (line: string, kinds: SyncKind[], ids: Record<string, string[]>, s: string | null = sim) => ({ done: line, kinds: [...kinds, 'tree' as SyncKind], ids, sim: s });
    switch (kind) {
      case 'geometry':
      case 'lost_faces': {
        const proj = await readProject(d.hostCall, rt, project, `delete.${kind}`);
        const g = records(proj.geometries).find((x) => x.id === id);
        if (!g) notFound('geometry', 'project_summary lists the geometries.');
        if (kind === 'lost_faces') {
          const lost = (await d.hostCall('geometry.lost_faces', { project_id: project, geometry_id: id }, o)) as Record<string, unknown>;
          const entries = records(lost.entries);
          const rev = typeof lost.rev === 'number' ? lost.rev : null;
          const one = sub ? entries.find((e) => `${str(e.kind)}:${str(e.id)}:${str(e.field)}` === sub || str(e.id) === sub) : null;
          if (sub && !one) refuse('not_found', `No lost-face entry "${cleanText(sub, 80)}".`, "read_setup {what:'lost_faces'} lists them.");
          const n = one ? 1 : entries.length;
          return {
            what: `the lost faces of ${quoted(g?.name)}`,
            note: `The ${plural(n, 'entry', 'entries')} that lost faces stop showing; their records keep the faces they still have.`,
            detail: [],
            exec: async () => {
              await d.hostCall(
                'lost_faces.forget',
                {
                  project_id: project,
                  geometry_id: id,
                  geometry_rev: rev,
                  ...(one ? { study_id: str(one.studyId), kind: str(one.kind), id: str(one.id), mesh_id: str(one.meshId), run_id: str(one.runId), entry: { field: one.field, old: one.old } } : {}),
                },
                o,
              );
              return done(`Forgot ${plural(n, 'lost-face entry', 'lost-face entries')} of ${quoted(g?.name)}.`, ['geometry'], { geometry: [id] }, null);
            },
          };
        }
        const using = studies.list.filter((s) => s.geometry_id === id).map((s) => str(s.name));
        return {
          what: `geometry ${quoted(g?.name)}`,
          note: using.length ? `Its ${plural(using.length, 'study', 'studies')} go too: ${andList(using.map((n) => `"${n}"`))}, with their meshes, runs and results.` : 'No study uses it.',
          detail: using.slice(0, 6).map((n) => ({ label: 'Study', value: cleanText(n, 80) })),
          exec: async () => {
            await d.hostCall('geometry.remove', { project_id: project, geometry_id: id }, o);
            return done(`Removed geometry ${quoted(g?.name)}${using.length ? ` and its ${plural(using.length, 'study', 'studies')}` : ''}.`, ['geometry', 'study', 'active'], { geometry: [id] }, null);
          },
        };
      }
      case 'study': {
        const s = studies.list.find((x) => x.id === id);
        if (!s) notFound('study', 'project_summary lists the studies.');
        const [meshes, runs, queue] = await Promise.all([
          d.hostCall('mesh.get', { project_id: project, simulation_id: id }, o) as Promise<Record<string, unknown>>,
          d.hostCall('run.status', { project_id: project, simulation_id: id }, o) as Promise<Record<string, unknown>>,
          d.hostCall('queue.get', { project_id: project }, o) as Promise<Record<string, unknown>>,
        ]);
        const meshIds = new Set(records(meshes.meshes).map((m) => str(m.id)));
        const runIds = new Set(records(runs.runs).map((r) => str(r.id)));
        const live = isRecord(queue.live) ? queue.live : null;
        const busy = [...(live ? [live] : []), ...records(queue.items)].some((r) => r.simulation_id === id || meshIds.has(str(r.mesh_id)) || runIds.has(str(r.run_id)));
        if (busy) refuse('busy', `A mesh or run of study ${quoted(s?.name)} is running or queued.`, 'Stop it or take it off the queue first (jobs, or the Queue).');
        return {
          what: `study ${quoted(s?.name)}`,
          note: `Its ${plural(meshIds.size, 'mesh', 'meshes')} and ${plural(runIds.size, 'run')}, with their results, go too.`,
          detail: [],
          exec: async () => {
            await d.hostCall('simulation.delete', { project_id: project, simulation_id: id }, o);
            return done(`Deleted study ${quoted(s?.name)}.`, ['study', 'active'], { study: [id] }, id);
          },
        };
      }
      case 'plugin_study': {
        const list = records(((await d.hostCall('plugin_studies.list', { project_id: project }, o)) as Record<string, unknown>).studies);
        const s = list.find((x) => x.id === id);
        if (!s) notFound('plugin study', 'project_summary lists them.');
        return {
          what: `${quoted(s?.title)} (${cleanText(str(s?.plugin_name) || str(s?.plugin), 60)})`,
          note: 'Its design and history go. Geometries already sent to the simulation stay.',
          detail: [],
          exec: async () => {
            await d.hostCall('plugin_studies.delete', { project_id: project, plugin: str(s?.plugin), study_id: id }, o);
            return done(`Deleted ${quoted(s?.title)}.`, ['plugin_studies'], { plugin_study: [id] }, null);
          },
        };
      }
      case 'mesh':
      case 'mesh_generated': {
        const doc = (await d.hostCall('mesh.get', { ...q, mesh_id: id }, o)) as Record<string, unknown>;
        const m = records(doc.meshes).find((x) => x.id === id);
        if (!m) notFound('mesh', "read_setup {what:'meshes'} lists them.");
        if (kind === 'mesh_generated') {
          const runs = (await d.hostCall('run.status', q, o)) as Record<string, unknown>;
          const users = records(runs.runs).filter((r) => r.mesh_id === id).map((r) => str(r.name));
          const meshing = m?.status === 'running' || m?.status === 'meshing';
          return {
            what: `the generated mesh of ${quoted(m?.name)}`,
            note: `${users.length ? `${andList(users)} can't run again until it is generated again.` : 'Its settings stay; generate it again to use it.'}${meshing ? ' It stops the mesher first.' : ''}`,
            detail: [],
            exec: async () => {
              await d.hostCall('mesh.delete_generated', { ...q, mesh_id: id }, o);
              return done(`Deleted the generated mesh of ${quoted(m?.name)}; its settings stay.`, ['mesh'], { mesh: [id] });
            },
          };
        }
        const refs = (await d.hostCall('refinements.get', q, o)) as Record<string, unknown>;
        const n = records(refs.refinements).filter((r) => r.mesh_id === id).length;
        return {
          what: `mesh ${quoted(m?.name)}`,
          note: `Its settings, ${plural(n, 'refinement')} and generated mesh go; its queued jobs leave the queue.`,
          detail: [],
          exec: async () => {
            await d.hostCall('mesh.delete_record', { ...q, mesh_id: id }, o);
            return done(`Deleted mesh ${quoted(m?.name)}.`, ['mesh', 'refinements'], { mesh: [id] });
          },
        };
      }
      case 'refinement': {
        const doc = (await d.hostCall('refinements.get', q, o)) as Record<string, unknown>;
        const r = records(doc.refinements).find((x) => x.id === id);
        if (!r) notFound('refinement', "read_setup {what:'refinements'} lists them.");
        return {
          what: `refinement ${quoted(r?.name)}`,
          note: `Its ${plural(Array.isArray(r?.faces) ? r.faces.length : 0, 'face')} go back to the mesh's own sizing.`,
          detail: [],
          exec: async () => {
            await d.hostCall('refinements.delete', { ...q, id }, o);
            return done(`Deleted refinement ${quoted(r?.name)}.`, ['refinements'], { refinement: [id] });
          },
        };
      }
      case 'run':
      case 'monitor':
      case 'saved_view':
      case 'media': {
        const runId = kind === 'run' ? id : kind === 'media' ? sub.replace(/^run-/, '') : sub;
        if (kind === 'media' && !/^(run|mesh)-/.test(sub)) refuse('invalid_input', 'media needs sub_id: its owner, run-<id> or mesh-<id>.', "read_results {kind:'media'} lists a run's.");
        if (kind === 'media') {
          const list = (await d.hostCall('media.list', { ...q, owner: sub }, o)) as Record<string, unknown>;
          const item = records(list.items).find((x) => x.id === id);
          if (!item) notFound('picture or recording', "read_results {kind:'media'} lists them.");
          return {
            what: `${str(item?.kind) === 'recording' ? 'recording' : 'picture'} ${quoted(item?.name)}`,
            note: 'It goes from the gallery.',
            detail: [],
            exec: async () => {
              await d.hostCall('media.delete', { ...q, owner: sub, id }, o);
              return done(`Deleted ${quoted(item?.name)} from the gallery.`, ['runs'], { media: [id] });
            },
          };
        }
        const status = (await d.hostCall('run.status', { ...q, run_id: runId }, o)) as Record<string, unknown>;
        const run = isRecord(status.run) && (status.run.id === runId || status.run.run_id === runId) ? status.run : null;
        if (!run) return refuse('not_found', `No run "${cleanText(runId, 80)}" in this study.`, "read_setup {what:'runs'} lists them.");
        if (kind === 'run') {
          return {
            what: quoted(run.name),
            note: run.has_results === true || run.status === 'done' ? 'Its results go.' : 'Its settings go.',
            detail: [],
            exec: async () => {
              await d.hostCall('run.delete', { ...q, run_id: runId }, o);
              return done(`Deleted run ${quoted(run.name)}.`, ['runs'], { run: [runId] });
            },
          };
        }
        const listKey = kind === 'monitor' ? 'result_controls' : 'views';
        const items = records(run[listKey]);
        const item = items.find((x) => x.id === id);
        if (!item) notFound(kind === 'monitor' ? 'monitor' : 'saved view', "read_setup {what:'run'} lists them.");
        return {
          what: `${kind === 'monitor' ? 'monitor' : 'saved view'} ${quoted(item?.name)}`,
          note: kind === 'monitor' ? `It goes from ${quoted(run.name)}, with what it recorded.` : `It goes from ${quoted(run.name)}.`,
          detail: [],
          exec: async () => {
            const r = (await d.hostCall('run.update', { ...q, run_id: runId, changes: { [listKey]: items.filter((x) => x.id !== id) }, base_rev: typeof run.rev === 'number' ? run.rev : undefined }, o)) as Record<string, unknown>;
            if (r.ok === false) refuse('refused', cleanText(str(r.error) || 'Not deleted.', 300));
            return done(`Deleted ${kind === 'monitor' ? 'monitor' : 'saved view'} ${quoted(item?.name)}.`, ['runs'], { run: [runId] });
          },
        };
      }
      case 'material': {
        const doc = (await d.hostCall('materials.get', q, o)) as Record<string, unknown>;
        const m = records(doc.materials).find((x) => x.id === id);
        if (!m) notFound('material', "read_setup {what:'materials'} lists them.");
        const bodies = Array.isArray(m?.assigned_volumes) ? m.assigned_volumes.map((b) => str(b)) : [];
        const proj = await readProject(d.hostCall, rt, project, 'delete.material');
        const study = studies.list.find((s) => s.id === sim);
        return {
          what: `material ${quoted(m?.name)}`,
          note: bodies.length ? `${andList(bodies)} ${bodies.length === 1 ? 'has' : 'have'} no material then.` : 'It is on no body.',
          detail: [],
          exec: async () => {
            await d.hostCall('materials.delete', { ...q, geometry_id: str(study?.geometry_id) || str(proj.active_geometry_id), material_id: id }, o);
            return done(`Deleted material ${quoted(m?.name)}.`, ['materials'], { material: [id] });
          },
        };
      }
      case 'bc': {
        const doc = (await d.hostCall('bcs.get', q, o)) as Record<string, unknown>;
        const b = records(doc.boundary_conditions).find((x) => x.id === id);
        if (!b) notFound('boundary condition', "read_setup {what:'bcs'} lists them.");
        const faces = Array.isArray(b?.faces) ? b.faces : [];
        return {
          what: `boundary condition ${quoted(b?.name)}`,
          note: faces.length ? `${faces.length === 1 ? 'Face' : 'Faces'} ${andList(faceNumbers(faces))} become${faces.length === 1 ? 's' : ''} unassigned.` : 'It is on no face.',
          detail: [],
          exec: async () => {
            await d.hostCall('bcs.delete', { ...q, id }, o);
            return done(`Deleted boundary condition ${quoted(b?.name)}.`, ['bcs'], { bc: [id] });
          },
        };
      }
      default:
        return refuse('invalid_input', `Unknown kind "${cleanText(kind, 40)}".`);
    }
  }

  return hostTool({
    name: 'delete',
    title: 'Delete something',
    description:
      'Deletes a project, folder, geometry, study, plugin_study, mesh_generated, mesh, refinement, run, material, bc, monitor, saved_view, media or lost_faces; the person is asked first. sub_id: monitor/saved_view: the run; media: run-<id>|mesh-<id>; else "".',
    schema: objectSchema({
      project_id: S.id('"" = this window\'s project'),
      simulation_id: S.id('"" = the study shown'),
      kind: S.enum(DELETE_KINDS),
      id: S.text(120, 'the item (a folder: its name)'),
      sub_id: S.text(120, 'monitor/saved_view: the run; media: the owner (run-<id>|mesh-<id>); lost_faces: one entry ("" = forget all)'),
    }),
    risk: 'destructive',
    projectData: true,
    priority: 60,
    contexts,
    available: offeredIn(contexts),
    projectOf: (input, ctx) => (input.kind === 'folder' ? null : projectIdOf(input, ctx)),
    async escalate(input: Record<string, unknown>, a: AssessContext): Promise<Assessed> {
      const t = await targetOf(input, a.ctx, { signal: a.signal, turn: a.turn });
      // The card's title names the item (the runner asks gateText with this same input).
      named.set(input, t.what);
      return { risk: 'destructive', note: t.note, detail: t.detail };
    },
    gateText: (input, a) => {
      const kind = str(input.kind);
      const what = named.get(input) ?? (kind === 'folder' ? `folder "${cleanText(str(input.id), 80)}"` : `this ${kind.replace('_', ' ')}`);
      const verb = kind === 'geometry' ? 'remove' : kind === 'lost_faces' ? 'forget' : 'delete';
      return { title: `Allow the Assistant to ${verb} ${what}?`, copy: a?.note || "It can't be undone.", ...(a?.detail.length ? { detail: a.detail } : {}) };
    },
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const kind = str(input.kind);
      try {
        if (placeOf(rt.ctx) === 'home' && !HOME_KINDS.has(kind)) {
          return fail('no_project', 'From Home only a project or a folder can be deleted.', "Open the project first: core__show {target:'project', project_id}.");
        }
        if (!HOME_KINDS.has(kind)) await writableProject(input, rt.ctx, d.hostCall, rt);
        const t = await targetOf(input, rt.ctx, rt);
        const r = await t.exec();
        // The open window hears it (a project deleted from Home has no window to tell).
        const project = rt.ctx.projectId ?? '';
        if (project) emitSync(d, rt, { project_id: project, simulation_id: r.sim, kinds: [...new Set(r.kinds)], ids: r.ids, revs: {}, tool: `delete.${kind}` });
        return okDone({ done: r.done, ids: {}, detail: { what: t.what, also: t.note } });
      } catch (err) {
        return failed(err);
      }
    },
  });
}
