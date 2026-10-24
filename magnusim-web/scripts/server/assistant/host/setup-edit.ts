/**
 * setup_edit (Core host tools spec 4.10): a study's materials, boundary conditions and their
 * defaults, meshes, refinements, runs, monitors and saved views, and the project's
 * geometries (activate, a link's choice, the original, Edit in CAD), in the project open
 * in this window only.
 *
 * Each write reads the record first (its existence, its rev, what a change merges onto),
 * checks `values` against the registry or plugin schema (every problem at once), checks
 * faces against the study's geometry (shared faces refused: they are inside the part),
 * and sends one named body (host-routes.ts). The route facts it works around:
 * - /api/bcs matches a BC by name and overwrites it: a name already used is refused;
 * - a material goes through `materials.set` with only_id(s): POST /api/materials without
 *   a matching id updates the study's first material;
 * - an empty /api/mesh body restores the defaults (or makes a new mesh): never sent;
 * - {delete:true} deletes every BC or refinement: the delete tool sends the id.
 * A change that makes results or a generated mesh out of date asks first (escalate).
 */
import { randomBytes } from 'node:crypto';
import type { GateDetail } from '../gates.ts';
import type { ToolCtx, ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import { carrySettle } from '../../../../src/workbench/runSettle.ts';
import { runCopyBody } from '../../../../src/workbench/runCopyBody.ts';
import { bcFamily, materialModel, meshFields, REFINEMENT_FIELDS, runFields } from './catalog.ts';
import {
  badValues,
  checkFaces,
  emitSync,
  fail,
  failed,
  flattenSchema,
  geometryRevOf,
  hostTool,
  isRecord,
  nest,
  normalFace,
  objectSchema,
  offeredIn,
  okDone,
  parseValues,
  quoted,
  records,
  refuse,
  revOf,
  S,
  str,
  studyIdOf,
  via,
  writableProject,
  type AssessContext,
  type Assessed,
  type Field,
  type HostToolDeps,
  type HostToolDef,
  type SyncKind,
} from './common.ts';
import { readMeta, readProject, studyGeometry } from './read-setup.ts';
import { HostCallError } from '../host-call.ts';
import { resultsNote, runsWithResults } from './study-edit.ts';

export const SETUP_KINDS = ['material', 'bc', 'bc_defaults', 'mesh', 'refinement', 'run', 'monitor', 'saved_view', 'geometry'] as const;
export const SETUP_ACTIONS = ['add', 'update', 'activate', 'rename', 'copy_from', 'restore_defaults', 'assign', 'unassign', 'clear', 'link_choice', 'add_original', 'edit_in_cad'] as const;

/** The kind · action pairs setup_edit takes; any other is refused, naming these. */
export const SETUP_PAIRS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  material: ['add', 'update', 'assign', 'unassign', 'clear'],
  bc: ['add', 'update', 'assign', 'unassign', 'clear'],
  bc_defaults: ['update'],
  mesh: ['add', 'update', 'activate', 'rename', 'restore_defaults', 'copy_from'],
  refinement: ['add', 'update', 'assign', 'unassign', 'copy_from'],
  run: ['add', 'update', 'activate', 'rename', 'copy_from'],
  monitor: ['add', 'update'],
  saved_view: ['add', 'update', 'rename'],
  geometry: ['activate', 'link_choice', 'add_original', 'edit_in_cad'],
});

/** The actions that change an existing record's settings: they make results out of date. */
const CHANGES_SETTINGS = new Set(['update', 'assign', 'unassign', 'clear', 'restore_defaults', 'copy_from']);

const LINK_CHOICES = ['new', 'overwrite', 'cancel', 'not_now'];
const WALL_TYPES = ['No-slip', 'Slip'];

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const rcId = () => `rc-${randomBytes(4).toString('hex')}`;

/** The id a call names, normalized. */
const idOf = (input: Record<string, unknown>) => str(input.id).trim();
const strList = (v: unknown, max: number) => (Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean).slice(0, max) : []);

/** The rev a write sends as base_rev (C2): the call's, else the record's as read; a call's that differs from the read is stale. */
function baseRev(input: Record<string, unknown>, rec: Record<string, unknown> | null): number | undefined {
  const given = Number(input.rev) || 0;
  const stored = revOf(rec);
  if (given > 0 && stored !== null && given !== stored) {
    refuse('stale_record', 'This was changed elsewhere since it was read.', 'Read it again with read_setup; the person or another window changed it.', { rev: stored });
  }
  return given > 0 ? given : (stored ?? undefined);
}

export function setupEditTool(d: HostToolDeps): HostToolDef {
  const contexts = ['workbench'] as const;

  async function assess(input: Record<string, unknown>, a: AssessContext): Promise<Assessed | null> {
    const project = a.ctx.projectId;
    if (!project) return null;
    const kind = str(input.kind);
    const action = str(input.action);
    const rt = { signal: a.signal, turn: a.turn };
    const o = via(rt, `setup_edit.${kind}.${action}`);
    if (kind === 'geometry' && action === 'add_original') {
      return { risk: 'compute', note: 'Imports the original file of this geometry as a new geometry and makes its preview.', detail: [] };
    }
    if (kind === 'geometry' && action === 'link_choice' && input.type === 'overwrite') {
      const proj = await readProject(d.hostCall, rt, project, 'setup_edit');
      const sims = (await d.hostCall('simulation.get', { project_id: project }, o)) as Record<string, unknown>;
      const job = await findLinkJob(project, str(input.other_id), rt);
      const gid = str(job?.job.geometryId) || str(job?.job.oldGeometryId);
      const g = records(proj.geometries).find((x) => x.id === gid);
      const n = records(sims.simulations).filter((s) => s.geometry_id === gid).length;
      return {
        risk: 'destructive',
        note: `Replaces geometry ${quoted(g?.name ?? job?.job.geometryName)} in place; ${n} ${n === 1 ? 'study uses' : 'studies use'} it and keep their setup on matching faces.`,
        detail: [],
      };
    }
    const sim = str(input.simulation_id) || a.ctx.simulationId || '';
    const detail: GateDetail[] = [];
    let note = '';
    if (kind === 'mesh' && ['update', 'restore_defaults', 'copy_from'].includes(action)) {
      const doc = (await d.hostCall('mesh.get', { project_id: project, simulation_id: sim, mesh_id: idOf(input) }, o)) as Record<string, unknown>;
      const m = records(doc.meshes).find((x) => x.id === (idOf(input) || doc.active_id));
      if (m && (m.generated === true || m.status === 'done')) {
        note = `${cleanText(str(m.name) || 'This mesh', 60)} is generated; changing its settings marks it out of date and it must be generated again.`;
        detail.push({ label: 'Mesh', value: cleanText(str(m.name), 60) });
      }
    }
    if (kind === 'refinement' && action === 'copy_from') {
      const doc = (await d.hostCall('refinements.get', { project_id: project, simulation_id: sim }, o)) as Record<string, unknown>;
      const n = records(doc.refinements).filter((r) => r.mesh_id === idOf(input)).length;
      if (n) note = `Its ${n} refinement${n === 1 ? ' is' : 's are'} replaced by the copied ones.`;
    }
    if (['material', 'bc', 'refinement', 'mesh', 'run', 'monitor'].includes(kind) && CHANGES_SETTINGS.has(action) && sim) {
      const names = await runsWithResults(d.hostCall, rt, project, sim, 'setup_edit');
      if (names.length) {
        note = note ? `${note} ${resultsNote(names)}` : resultsNote(names);
        for (const n of names.slice(0, 6 - detail.length)) detail.push({ label: 'Has results', value: n });
      }
    }
    return note ? { risk: 'destructive', note, detail } : null;
  }

  /** The link job `jobId` and the plugin study it belongs to (the status route needs both). */
  async function findLinkJob(project: string, jobId: string, rt: { signal: AbortSignal; turn: string | null }) {
    if (!jobId) return null;
    const o = via(rt, 'setup_edit.geometry.link_choice');
    const list = records(((await d.hostCall('plugin_studies.list', { project_id: project }, o)) as Record<string, unknown>).studies);
    for (const s of list.slice(0, 50)) {
      try {
        const r = (await d.hostCall('link.status', { project_id: project, plugin: str(s.plugin), study_id: str(s.id), job_id: jobId }, o)) as Record<string, unknown>;
        if (isRecord(r.job)) return { plugin: str(s.plugin), study_id: str(s.id), job: r.job };
      } catch {
        /* not this study's job */
      }
    }
    return null;
  }

  return hostTool({
    name: 'setup_edit',
    title: 'Change the study setup',
    description:
      'Changes the setup of the project open here: material, bc, bc_defaults, mesh, refinement, run, monitor, saved_view, geometry. values keys: from catalog. Unused: "", [].',
    schema: objectSchema({
      project_id: S.id('"" = this window\'s'),
      simulation_id: S.id('"" = the study shown'),
      kind: S.enum(SETUP_KINDS),
      action: S.enum(SETUP_ACTIONS),
      id: S.text(120, 'the record; "" for add'),
      other_id: S.text(120, 'monitor, saved_view: the run; refinement: the mesh; copy_from: the source; link_choice: the job'),
      name: S.text(120),
      type: S.text(120, 'bc type, preset, refinement or monitor type, link choice'),
      faces: { type: 'array', maxItems: 2000, items: { type: 'string', maxLength: 40 }, description: 'from read_setup faces' },
      bodies: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 40 }, description: 'from read_setup bodies' },
      values: S.values(40, 2000, 'value is JSON text, e.g. "5"'),
      rev: { type: 'integer', minimum: 0, description: 'from read_setup; 0 = no check' },
    }),
    risk: 'edit',
    projectData: true,
    priority: 88,
    workerBacked: true,
    contexts,
    available: offeredIn(contexts, (ctx: ToolCtx) => (ctx.projectId ? true : 'No project is open in this window.')),
    projectOf: (_input, ctx) => ctx.projectId,
    escalate: assess,
    gateText: (input, a) => ({
      title:
        a?.risk === 'compute'
          ? 'Allow the Assistant to add the original geometry?'
          : input.kind === 'geometry'
            ? 'Allow the Assistant to overwrite this geometry?'
            : `Allow the Assistant to change this ${str(input.kind).replace('_', ' ')}?`,
      copy: a?.note || 'It changes the study setup.',
      ...(a?.detail.length ? { detail: a.detail } : {}),
    }),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const kind = str(input.kind);
      const action = str(input.action);
      const tool = `setup_edit.${kind}.${action}`;
      const o = via(rt, tool);
      const pairs = SETUP_PAIRS[kind];
      if (!pairs || !pairs.includes(action)) {
        return fail('invalid_input', `${cleanText(kind, 40)} takes ${pairs ? pairs.join(', ') : 'no such action'}, not ${cleanText(action, 40)}.`, `Valid actions for ${cleanText(kind, 40)}: ${(pairs ?? []).join(', ')}.`, { valid: pairs ?? [] });
      }
      try {
        const project = await writableProject(input, rt.ctx, d.hostCall, rt);
        const sync = (kinds: SyncKind[], sim: string | null, ids: Record<string, string[]>, revs: Record<string, number> = {}, active?: Record<string, string>) =>
          emitSync(d, rt, { project_id: project, simulation_id: sim, kinds, ids, revs, ...(active ? { active } : {}), tool });
        if (kind === 'geometry') return await geometryEdit(project, input, rt, sync, findLinkJob);
        const { id: sim, studies } = await studyIdOf(input, rt.ctx, project, d.hostCall, rt, tool);
        const study = studies.list.find((s) => s.id === sim) ?? {};
        const q = { project_id: project, simulation_id: sim };
        const ctxOf = async () => {
          const proj = await readProject(d.hostCall, rt, project, tool);
          const geometryId = studyGeometry(proj, study);
          return { proj, geometryId, geometryRev: geometryRevOf(proj, geometryId) };
        };
        const facesOk = async (geometryId: string, faces: readonly unknown[]) => (faces.length ? checkFaces(faces, records((await readMeta(d.hostCall, rt, project, geometryId, tool)).faces)) : []);
        /**
         * Saves the call's values on mesh `m` (its engine's fields; `advanced.mesh_engine` among the
         * values switches the engine they are read for), with `name` when given: the update, and an
         * add's values. Refuses an empty change (an empty body would restore the defaults).
         */
        const saveMeshValues = async (
          m: Record<string, unknown>,
          mq: Record<string, unknown>,
          name: string,
        ): Promise<{ ok: true; count: number } | { ok: false; problems: Parameters<typeof badValues>[0]; hint: string }> => {
          const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
          const settings = isRecord(m.settings) ? m.settings : {};
          const engineNow = str(isRecord(settings.advanced) ? settings.advanced.mesh_engine : '');
          const wanted = (Array.isArray(input.values) ? input.values : []).find((p) => isRecord(p) && p.key === 'advanced.mesh_engine');
          let engine = engineNow;
          try {
            if (isRecord(wanted)) engine = str(JSON.parse(str(wanted.value))) || engineNow;
          } catch {
            engine = engineNow;
          }
          const hint = `catalog {kind:'mesh_settings', key:'${cleanText(engine, 64)}'} lists the fields.`;
          const parsed = parseValues(input.values, meshFields(registry, engine));
          if (!parsed.ok) return { ok: false, problems: parsed.problems, hint };
          if (!Object.keys(parsed.values).length && !name) refuse('invalid_input', 'update needs values or a name.', "catalog {kind:'mesh_settings', key} lists the fields.");
          const nested = nest(parsed.values);
          // mesher_settings is replaced whole by the route: the stored keys go with the change.
          if (isRecord(nested.mesher_settings)) nested.mesher_settings = { ...(isRecord(settings.mesher_settings) ? settings.mesher_settings : {}), ...nested.mesher_settings };
          await d.hostCall('mesh.update', { ...mq, geometry_id: '', name, settings: nested }, o);
          return { ok: true, count: Object.keys(parsed.values).length };
        };

        switch (kind) {
          // ------------------------------------------------------------ materials
          case 'material': {
            const [doc, registry, g] = await Promise.all([
              d.hostCall('materials.get', q, o) as Promise<Record<string, unknown>>,
              d.hostCall('registry.get', {}, o) as Promise<Record<string, unknown>>,
              ctxOf(),
            ]);
            const list = records(doc.materials).map((m) => ({ ...m }));
            const meta = await readMeta(d.hostCall, rt, project, g.geometryId, tool);
            const bodyNames = Array.isArray(meta.bodies) ? meta.bodies.map((b) => str(b)) : ['Body1'];
            const bodies = strList(input.bodies, 200);
            const unknownBodies = bodies.filter((b) => !bodyNames.includes(b));
            if (unknownBodies.length) return fail('not_found', `No body ${unknownBodies.slice(0, 6).join(', ')} on the study's geometry.`, "read_setup {what:'bodies'} lists them.");
            let rec: Record<string, unknown>;
            const now = new Date().toISOString();
            if (action === 'add') {
              const hit = materialModel(registry, str(input.type).trim() || 'air');
              if (!hit) return fail('not_found', `No material or preset "${cleanText(str(input.type), 80)}".`, "catalog {kind:'materials', key:''} lists them.");
              const values = materialValues(hit.model, hit.preset, input.values);
              rec = {
                id: newId('mat'),
                name: cleanText(str(input.name).trim(), 120) || str(hit.preset?.name) || str(hit.model.label) || 'Material',
                ...(isRecord(hit.model.record_constants) ? hit.model.record_constants : {}),
                ...values,
                library: str(hit.preset?.library) || (Array.isArray(hit.preset?.codes) ? str(hit.preset?.codes[0]) : ''),
                material_model: str(hit.model.key),
                preset: str(hit.preset?.key) || str(hit.model.custom_preset) || 'custom',
                simulation_id: sim,
                geometry_id: g.geometryId,
                project_id: project,
                saved: true,
                created_at: now,
              };
              setBodies(rec, bodies);
            } else {
              const old = list.find((m) => m.id === idOf(input));
              if (!old) return fail('not_found', `No material "${cleanText(idOf(input), 80)}" in this study.`, "read_setup {what:'materials'} lists them.");
              const base = baseRev(input, old);
              rec = { ...old };
              if (base !== undefined) rec.base_rev = base;
              const held = Array.isArray(old.assigned_volumes) ? old.assigned_volumes.map((b) => str(b)) : [];
              if (action === 'update') {
                const name = cleanText(str(input.name).trim(), 120);
                if (name) rec.name = name;
                const type = str(input.type).trim();
                const hit = materialModel(registry, type || str(old.material_model));
                if (type && !hit) return fail('not_found', `No material or preset "${cleanText(type, 80)}".`, "catalog {kind:'materials', key:''} lists them.");
                if (hit) {
                  Object.assign(rec, materialValues(hit.model, type ? hit.preset : null, input.values));
                  if (type) {
                    rec.material_model = str(hit.model.key);
                    if (hit.preset) {
                      rec.preset = str(hit.preset.key);
                      rec.library = str(hit.preset.library);
                    }
                  }
                }
                if (bodies.length) setBodies(rec, bodies);
              } else if (action === 'assign') setBodies(rec, [...new Set([...held, ...bodies])]);
              else if (action === 'unassign') setBodies(rec, held.filter((b) => !bodies.includes(b)));
              else setBodies(rec, []);
              rec.updated_at = now;
            }
            if (g.geometryRev !== null) rec.geometry_rev = g.geometryRev;
            // A body has one material: the others give up the bodies this one takes.
            const taken = new Set(strList(rec.assigned_volumes, 200));
            const changed = [str(rec.id)];
            const next = list.filter((m) => m.id !== rec.id).map((m) => {
              const held = strList(m.assigned_volumes, 200);
              if (!held.some((b) => taken.has(b))) return m;
              changed.push(str(m.id));
              const out = { ...m };
              setBodies(out, held.filter((b) => !taken.has(b)));
              if (g.geometryRev !== null) out.geometry_rev = g.geometryRev;
              return out;
            });
            next.push(rec);
            const air = next.find((m) => strList(m.assigned_volumes, 1).length) ?? next[0];
            const saved = (await d.hostCall('materials.set', { project_id: project, simulation_id: sim, materials: next, air, only_id: str(rec.id), only_ids: changed }, o)) as Record<string, unknown>;
            if (saved.ok === false) return fail('refused', cleanText(str(saved.error) || 'The material was not saved.', 300));
            const back = records(saved.materials).find((m) => m.id === rec.id);
            const rev = revOf(back ?? null);
            sync(['materials', 'tree'], sim, { material: changed }, rev !== null ? { [str(rec.id)]: rev } : {});
            const where = strList(rec.assigned_volumes, 200);
            return okDone({
              done: `${action === 'add' ? 'Added' : 'Saved'} material ${quoted(rec.name)}${where.length ? ` on ${where.join(', ')}` : ' (on no body yet)'}.`,
              ids: { material: str(rec.id) },
              rev,
              ...(changed.length > 1 ? { detail: { bodies_moved_from: changed.slice(1) } } : {}),
            });
          }
          // ------------------------------------------------------------ boundary conditions
          case 'bc': {
            const [doc, registry, g] = await Promise.all([
              d.hostCall('bcs.get', q, o) as Promise<Record<string, unknown>>,
              d.hostCall('registry.get', {}, o) as Promise<Record<string, unknown>>,
              ctxOf(),
            ]);
            const list = records(doc.boundary_conditions);
            const faces = await facesOk(g.geometryId, Array.isArray(input.faces) ? input.faces : []);
            const name = cleanText(str(input.name).trim(), 120);
            const old = action === 'add' ? null : (list.find((b) => b.id === idOf(input)) ?? null);
            if (action !== 'add' && !old) return fail('not_found', `No boundary condition "${cleanText(idOf(input), 80)}" in this study.`, "read_setup {what:'bcs'} lists them.");
            // The route matches by name and overwrites: a name used by another BC is refused.
            if (name && list.some((b) => b.name === name && b.id !== old?.id)) {
              return fail('invalid_input', `A boundary condition named ${quoted(name)} already exists in this study.`, 'Pick another name, or update that one by its id.');
            }
            const type = str(input.type).trim() || str(old?.bc_type);
            const family = bcFamily(registry, type);
            if (!family) return fail('not_found', type ? `No BC type "${cleanText(type, 80)}".` : 'add needs a type.', "catalog {kind:'bc_types', key:''} lists them.");
            const fields = flattenSchema(family.fields);
            const parsed = parseValues(input.values, fields);
            if (!parsed.ok) return badValues(parsed.problems, `catalog {kind:'bc_types', key:'${cleanText(str(family.key), 64)}'} lists its fields.`);
            const held = strList(old?.faces, 2000);
            const nextFaces =
              action === 'add' || (action === 'update' && faces.length)
                ? faces
                : action === 'assign'
                  ? [...new Set([...held, ...faces])]
                  : action === 'unassign'
                    ? held.filter((f) => !strList(input.faces, 2000).map((x) => normalFace(x) ?? x).includes(f))
                    : action === 'clear'
                      ? []
                      : held;
            const carried: Record<string, unknown> = {};
            if (old) for (const f of fields) if (old[f.key] !== undefined) carried[f.key] = old[f.key];
            const base = old ? baseRev(input, old) : undefined;
            const saved = (await d.hostCall(
              'bcs.upsert',
              {
                project_id: project,
                simulation_id: sim,
                geometry_id: g.geometryId,
                id: old ? str(old.id) : '',
                name: name || str(old?.name),
                bc_type: str(family.record_type),
                faces: nextFaces,
                fields: { ...carried, ...parsed.values },
                geometry_rev: g.geometryRev ?? undefined,
                base_rev: base,
              },
              o,
            )) as Record<string, unknown>;
            const bc = isRecord(saved.bc) ? saved.bc : {};
            const id = str(bc.id);
            const rev = revOf(bc);
            sync(['bcs', 'tree'], sim, { bc: [id] }, rev !== null ? { [id]: rev } : {});
            // A new Wall takes the wall type that walls with no BC don't have, as the panel's Add
            // does (bcCatalog newBcRecord). Seen live: the model expected No-slip and found Slip.
            const wall = str(bc.wall_type);
            const wallNote =
              action === 'add' && wall && parsed.values.wall_type === undefined
                ? ` It is ${wall}: a new Wall takes the other wall type than walls with no BC; values wall_type changes it.`
                : '';
            return okDone({
              done: `${action === 'add' ? 'Added' : 'Saved'} boundary condition ${quoted(bc.name)} (${cleanText(str(bc.bc_type), 60)}${wall ? `, ${cleanText(wall, 20)}` : ''}) on ${nextFaces.length} face${nextFaces.length === 1 ? '' : 's'}.${wallNote}`,
              ids: { bc: id },
              rev,
            });
          }
          case 'bc_defaults': {
            const parsed = parseValues(input.values, [{ key: 'wall_type', type: 'string', label: 'Walls with no BC', unit: '', enum: WALL_TYPES, min: null, max: null, items: null, min_items: null, max_items: null, description: '' }]);
            if (!parsed.ok) return badValues(parsed.problems, 'bc_defaults takes wall_type: "No-slip" or "Slip".');
            const wall = str(parsed.values.wall_type);
            if (!wall) return fail('invalid_input', 'bc_defaults update needs values wall_type.');
            await d.hostCall('bcs.defaults', { project_id: project, simulation_id: sim, wall_type: wall }, o);
            sync(['bc_defaults'], sim, {});
            return okDone({ done: `Walls with no boundary condition are now ${wall}.`, ids: {} });
          }
          // ------------------------------------------------------------ meshes
          case 'mesh': {
            const doc = (await d.hostCall('mesh.get', { ...q, mesh_id: idOf(input) }, o)) as Record<string, unknown>;
            const meshes = records(doc.meshes);
            if (action === 'add') {
              const made = (await d.hostCall('mesh.create', { ...q, name: cleanText(str(input.name).trim(), 64) }, o)) as Record<string, unknown>;
              const id = str(made.active_id) || str(isRecord(made.mesh) ? made.mesh.id : '');
              const madeName = isRecord(made.mesh) ? made.mesh.name : 'Mesh';
              sync(['mesh', 'tree'], sim, { mesh: [id] });
              // Settings sent with the add are saved now, as an update would: never dropped.
              const sent = Array.isArray(input.values) ? input.values.filter(isRecord) : [];
              if (sent.length) {
                const fresh = records(((await d.hostCall('mesh.get', { ...q, mesh_id: id }, o)) as Record<string, unknown>).meshes).find((x) => x.id === id) ?? null;
                const saved = fresh ? await saveMeshValues(fresh, { ...q, mesh_id: id, base_rev: revOf(fresh) ?? undefined }, '') : null;
                if (!saved || !saved.ok) {
                  const problems = saved && !saved.ok ? saved.problems : [];
                  return badValues(problems, `Mesh ${quoted(madeName)} was added (id ${id}) with its default settings; these values were not saved. Set them with setup_edit {kind:'mesh', action:'update', id:'${id}'}.`);
                }
                sync(['mesh'], sim, { mesh: [id] });
                return okDone({ done: `Added mesh ${quoted(madeName)} with ${saved.count} setting${saved.count === 1 ? '' : 's'}.`, ids: { mesh: id }, hint: 'Generate it with compute.' });
              }
              return okDone({ done: `Added mesh ${quoted(madeName)}.`, ids: { mesh: id }, hint: "Change it with setup_edit {kind:'mesh', action:'update'}; generate it with compute." });
            }
            const id = idOf(input) || str(doc.active_id);
            const m = meshes.find((x) => x.id === id);
            if (!m) return fail('not_found', id ? `No mesh "${cleanText(id, 80)}" in this study.` : 'This study has no mesh yet.', "read_setup {what:'meshes'} lists them.");
            const base = baseRev(input, m);
            const mq = { ...q, mesh_id: id, base_rev: base };
            if (action === 'activate') {
              await d.hostCall('mesh.activate', { ...q, mesh_id: id }, o);
              sync(['active'], sim, { mesh: [id] }, {}, { mesh: id });
              return okDone({ done: `Mesh ${quoted(m.name)} is now the active mesh.`, ids: { mesh: id } });
            }
            if (action === 'rename') {
              const name = cleanText(str(input.name).trim(), 64);
              if (!name) return fail('invalid_input', 'rename needs a name.');
              await d.hostCall('mesh.rename', { ...mq, name }, o);
              sync(['mesh', 'tree'], sim, { mesh: [id] });
              return okDone({ done: `Renamed mesh ${quoted(m.name)} to ${quoted(name)}.`, ids: { mesh: id } });
            }
            if (action === 'restore_defaults') {
              await d.hostCall('mesh.restore_defaults', mq, o);
              sync(['mesh'], sim, { mesh: [id] });
              return okDone({ done: `Mesh ${quoted(m.name)} is back to its default settings.`, ids: { mesh: id } });
            }
            if (action === 'copy_from') {
              const from = str(input.other_id).trim();
              const all = records(doc.meshes_all).length ? records(doc.meshes_all) : meshes;
              const src = all.find((x) => x.id === from);
              if (!src || from === id) return fail('not_found', `No other mesh "${cleanText(from, 80)}" to copy from.`, "read_setup {what:'meshes'} lists them.");
              await d.hostCall('mesh.copy_from', { ...mq, copy_from: from }, o);
              // The panel's "Copy settings from" copies the refinements too (audit X7).
              await d.hostCall('refinements.copy', { ...q, mesh_id: id, copy_from_mesh: from }, o);
              sync(['mesh', 'refinements', 'tree'], sim, { mesh: [id] });
              return okDone({ done: `Copied the settings and refinements of ${quoted(src.name)} into mesh ${quoted(m.name)}.`, ids: { mesh: id } });
            }
            // update: never an empty body (it would restore the defaults).
            const name = cleanText(str(input.name).trim(), 64);
            const saved = await saveMeshValues(m, mq, name);
            if (!saved.ok) return badValues(saved.problems, saved.hint);
            sync(['mesh'], sim, { mesh: [id] });
            return okDone({ done: `Saved ${saved.count} setting${saved.count === 1 ? '' : 's'} of mesh ${quoted(name || m.name)}.`, ids: { mesh: id } });
          }
          // ------------------------------------------------------------ refinements
          case 'refinement': {
            const [doc, meshDoc] = await Promise.all([d.hostCall('refinements.get', q, o) as Promise<Record<string, unknown>>, d.hostCall('mesh.get', q, o) as Promise<Record<string, unknown>>]);
            const list = records(doc.refinements);
            const meshes = records(meshDoc.meshes);
            if (action === 'copy_from') {
              const dest = idOf(input);
              const from = str(input.other_id).trim();
              const all = records(meshDoc.meshes_all).length ? records(meshDoc.meshes_all) : meshes;
              if (!meshes.some((m) => m.id === dest)) return fail('not_found', `No mesh "${cleanText(dest, 80)}" in this study (id is the mesh to copy into).`, "read_setup {what:'meshes'} lists them.");
              if (!all.some((m) => m.id === from) || from === dest) return fail('not_found', `No other mesh "${cleanText(from, 80)}" to copy from.`, "read_setup {what:'meshes'} lists them.");
              const r = (await d.hostCall('refinements.copy', { ...q, mesh_id: dest, copy_from_mesh: from }, o)) as Record<string, unknown>;
              sync(['refinements', 'tree'], sim, { mesh: [dest] });
              const lost = records(r.lost_faces);
              return okDone({
                done: `Copied ${Number(r.copied_count) || 0} refinements into the mesh; its earlier ones were replaced.`,
                ids: { mesh: dest },
                ...(lost.length ? { detail: { lost_faces: lost.slice(0, 20) } } : {}),
              });
            }
            const old = action === 'add' ? null : (list.find((r) => r.id === idOf(input)) ?? null);
            if (action !== 'add' && !old) return fail('not_found', `No refinement "${cleanText(idOf(input), 80)}" in this study.`, "read_setup {what:'refinements'} lists them.");
            const mesh = str(input.other_id).trim() || str(old?.mesh_id) || str(meshDoc.active_id);
            if (!meshes.some((m) => m.id === mesh)) return fail('not_found', mesh ? `No mesh "${cleanText(mesh, 80)}" in this study.` : 'Add a mesh first.', "read_setup {what:'meshes'} lists them.");
            const type = str(input.type).trim() || str(old?.type);
            const fields = REFINEMENT_FIELDS[type];
            if (!fields) return fail('not_found', `No refinement type "${cleanText(type, 80)}".`, "catalog {kind:'refinement_types', key:''} lists them.");
            const parsed = parseValues(input.values, fields);
            if (!parsed.ok) return badValues(parsed.problems, `catalog {kind:'refinement_types', key:'${type}'} lists its fields.`);
            const name = cleanText(str(input.name).trim(), 120);
            // Matched by id, or by name and mesh: a name used on that mesh is refused.
            if (name && list.some((r) => r.name === name && r.mesh_id === mesh && r.id !== old?.id)) {
              return fail('invalid_input', `A refinement named ${quoted(name)} is already on that mesh.`, 'Pick another name, or update that one by its id.');
            }
            const g = await ctxOf();
            const faces = await facesOk(g.geometryId, Array.isArray(input.faces) ? input.faces : []);
            const held = strList(old?.faces, 2000);
            const nextFaces =
              action === 'add' || (action === 'update' && faces.length)
                ? faces
                : action === 'assign'
                  ? [...new Set([...held, ...faces])]
                  : action === 'unassign'
                    ? held.filter((f) => !strList(input.faces, 2000).map((x) => normalFace(x) ?? x).includes(f))
                    : held;
            const carried: Record<string, unknown> = {};
            if (old) for (const f of fields) if (old[f.key] !== undefined) carried[f.key] = old[f.key];
            const r = (await d.hostCall(
              'refinements.upsert',
              {
                ...q,
                id: old ? str(old.id) : '',
                name: name || str(old?.name),
                type,
                mesh_id: mesh,
                faces: nextFaces,
                fields: { ...carried, ...parsed.values },
                geometry_rev: g.geometryRev ?? undefined,
                base_rev: old ? baseRev(input, old) : undefined,
              },
              o,
            )) as Record<string, unknown>;
            const ref = isRecord(r.refinement) ? r.refinement : {};
            const id = str(ref.id);
            const rev = revOf(ref);
            sync(['refinements', 'tree'], sim, { refinement: [id] }, rev !== null ? { [id]: rev } : {});
            return okDone({ done: `${action === 'add' ? 'Added' : 'Saved'} refinement ${quoted(ref.name)} on ${nextFaces.length} face${nextFaces.length === 1 ? '' : 's'}.`, ids: { refinement: id }, rev });
          }
          // ------------------------------------------------------------ runs, monitors, saved views
          case 'run':
          case 'monitor':
          case 'saved_view':
            return await runEdit(project, sim, study, input, rt, sync, ctxOf, facesOk);
          default:
            return fail('invalid_input', `Unknown kind "${cleanText(kind, 40)}".`);
        }
      } catch (err) {
        if (err instanceof HostCallError && err.status === 400 && /unsupported|not .*type/i.test(err.message)) {
          return fail('bad_values', err.message, 'catalog lists the types and fields.');
        }
        return failed(err, 'read_setup lists the records.');
      }
    },
  });

  // ------------------------------------------------------------------ runs, monitors, saved views
  async function runEdit(
    project: string,
    sim: string,
    study: Record<string, unknown>,
    input: Record<string, unknown>,
    rt: ToolRunContext,
    sync: (kinds: SyncKind[], sim: string | null, ids: Record<string, string[]>, revs?: Record<string, number>, active?: Record<string, string>) => void,
    ctxOf: () => Promise<{ proj: Record<string, unknown>; geometryId: string; geometryRev: number | null }>,
    facesOk: (geometryId: string, faces: readonly unknown[]) => Promise<string[]>,
  ): Promise<ToolOutcome> {
    const kind = str(input.kind);
    const action = str(input.action);
    const o = via(rt, `setup_edit.${kind}.${action}`);
    const q = { project_id: project, simulation_id: sim };
    if (kind === 'run' && action === 'add') {
      const parsed = parseValues(input.values, [], { mesh_id: (v) => (typeof v === 'string' ? null : 'a mesh id (text)') });
      if (!parsed.ok) return badValues(parsed.problems, 'add takes values mesh_id only; change the rest with update.');
      const made = (await d.hostCall('run.create', { ...q, name: cleanText(str(input.name).trim(), 64), mesh_id: str(parsed.values.mesh_id) }, o)) as Record<string, unknown>;
      const run = isRecord(made.run) ? made.run : {};
      sync(['runs', 'tree'], sim, { run: [str(run.id)] });
      return okDone({ done: `Added run ${quoted(run.name)}.`, ids: { run: str(run.id) }, hint: "Change its settings with setup_edit {kind:'run', action:'update'}." });
    }
    // The run: the call's id for a run, its other_id for a monitor or a saved view.
    const runId = kind === 'run' ? idOf(input) : str(input.other_id).trim();
    const status = (await d.hostCall('run.status', { ...q, run_id: runId }, o)) as Record<string, unknown>;
    const run = isRecord(status.run) ? status.run : null;
    if (!run || (runId && run.id !== runId && run.run_id !== runId)) {
      return fail('not_found', runId ? `No run "${cleanText(runId, 80)}" in this study.` : 'This study has no run yet.', "read_setup {what:'runs'} lists them.");
    }
    const id = str(run.id ?? run.run_id);
    const base = baseRev(kind === 'run' ? input : { rev: 0 }, run);
    const g = await ctxOf();
    const update = async (changes: Record<string, unknown>) => {
      const r = (await d.hostCall('run.update', { ...q, run_id: id, changes, geometry_rev: g.geometryRev ?? undefined, base_rev: base }, o)) as Record<string, unknown>;
      if (r.ok === false) refuse('refused', cleanText(str(r.error) || 'The run was not saved.', 300));
      return isRecord(r.run) ? r.run : {};
    };
    if (kind === 'run') {
      if (action === 'activate') {
        await d.hostCall('run.activate', { ...q, run_id: id }, o);
        sync(['active'], sim, { run: [id] }, {}, { run: id });
        return okDone({ done: `Run ${quoted(run.name)} is now the active run.`, ids: { run: id } });
      }
      if (action === 'rename') {
        const name = cleanText(str(input.name).trim(), 64);
        if (!name) return fail('invalid_input', 'rename needs a name.');
        await d.hostCall('run.rename', { ...q, run_id: id, name }, o);
        sync(['runs', 'tree'], sim, { run: [id] });
        return okDone({ done: `Renamed run ${quoted(run.name)} to ${quoted(name)}.`, ids: { run: id } });
      }
      const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
      const fields = runFields(registry, str(study.analysis_type));
      if (action === 'copy_from') {
        const from = str(input.other_id).trim();
        const all = [...records(status.runs_all), ...records(status.runs)];
        const src = all.find((r) => r.id === from);
        if (!src || from === id) return fail('not_found', `No other run "${cleanText(from, 80)}" to copy from.`, "read_setup {what:'runs'} lists them.");
        const bcs = (await d.hostCall('bcs.get', q, o)) as Record<string, unknown>;
        const studyBcIds = records(bcs.boundary_conditions).filter((b) => strList(b.faces, 1).length).map((b) => str(b.id));
        // The source's transient block over its analysis's defaults (the page's transientSettingsFor).
        const transient: Record<string, unknown> = {};
        for (const f of fields) if (f.key.startsWith('transient.')) transient[f.key.slice(10)] = defaultOf(registry, str(study.analysis_type), f.key.slice(10));
        if (isRecord(src.transient)) for (const k of Object.keys(transient)) if (src.transient[k] !== undefined) transient[k] = src.transient[k];
        const studyTransient = /transient/i.test(str(study.time_dependency));
        const copied = runCopyBody({
          src,
          dest: run,
          studyId: sim,
          fallback: { endTime: run.endTime, writeInterval: run.writeInterval },
          insideCreate: false,
          studyTransient,
          srcTransient: src.time_dependency ? /transient/i.test(str(src.time_dependency)) : studyTransient,
          transient,
          cores: Number.isInteger(src.cores) && Number(src.cores) >= 1 ? Number(src.cores) : null,
          studyBcIds,
          newRcId: rcId,
          carry: carrySettle,
        });
        const changes: Record<string, unknown> = { ...copied.body };
        delete changes.run_id;
        await update(changes);
        sync(['runs', 'tree'], sim, { run: [id] });
        return okDone({
          done: copied.otherStudy
            ? `Copied the time settings from ${quoted(src.name)} of another study into ${quoted(run.name)}; its mesh and monitors stay there.${copied.note ? ` ${copied.note}` : ''}`
            : `Copied the settings of ${quoted(src.name)} into ${quoted(run.name)}.${copied.note ? ` ${copied.note}` : ''}`,
          ids: { run: id },
        });
      }
      // update: only the run's own keys, camelCase as the route takes them (no `settings`).
      const parsed = parseValues(input.values, fields, {
        settle: (v) => (v === null || isRecord(v) ? null : 'an object, or null for off'),
      });
      if (!parsed.ok) return badValues(parsed.problems, `catalog {kind:'analyses', key:'${cleanText(str(study.analysis_type), 80)}'} lists the run_settings.`);
      if (!Object.keys(parsed.values).length) return fail('invalid_input', 'update needs values.', "catalog {kind:'analyses', key} lists the run_settings.");
      const nested = nest(parsed.values);
      if (isRecord(nested.transient)) nested.transient = { ...(isRecord(run.transient) ? run.transient : {}), ...nested.transient };
      if ('settle' in nested) nested.settle_time_dependency = str(run.time_dependency) || str(study.time_dependency);
      const saved = await update(nested);
      sync(['runs'], sim, { run: [id] }, revOf(saved) !== null ? { [id]: revOf(saved) as number } : {});
      return okDone({ done: `Saved ${Object.keys(parsed.values).join(', ')} of run ${quoted(run.name)}.`, ids: { run: id }, rev: revOf(saved) });
    }
    if (kind === 'saved_view') {
      if (action !== 'rename') {
        return fail('deferred', 'Saving a view captures the live camera and filters; that comes with the results-view tool in v0.5.x.', 'This comes in a later version; ask the person to do it.');
      }
      const views = records(run.views).map((v) => ({ ...v }));
      const view = views.find((v) => v.id === idOf(input));
      const name = cleanText(str(input.name).trim(), 120);
      if (!view) return fail('not_found', `No saved view "${cleanText(idOf(input), 80)}" on this run.`, "read_setup {what:'run'} lists its views.");
      if (!name) return fail('invalid_input', 'rename needs a name.');
      const was = str(view.name);
      view.name = name;
      await update({ views });
      sync(['runs'], sim, { run: [id] });
      return okDone({ done: `Renamed saved view ${quoted(was)} to ${quoted(name)}.`, ids: { run: id, saved_view: str(view.id) } });
    }
    // monitors: the run's list with this one added or replaced (the route replaces the array).
    const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
    const rcs = records(run.result_controls).map((r) => ({ ...r }));
    const old = action === 'add' ? null : (rcs.find((r) => r.id === idOf(input)) ?? null);
    if (action === 'update' && !old) return fail('not_found', `No monitor "${cleanText(idOf(input), 80)}" on this run.`, "read_setup {what:'run'} lists its monitors.");
    const typeKey = str(input.type).trim() || str(old?.monitor_type);
    const typeRow = records(registry.monitor).find((m) => m.key === typeKey || m.label === typeKey);
    if (!typeRow) return fail('not_found', `No monitor type "${cleanText(typeKey, 80)}".`, "catalog {kind:'monitors', key:''} lists them.");
    const target = str(typeRow.target) || 'patch';
    const extra: Record<string, (v: unknown) => string | null> = {
      write_control: (v) => (typeof v === 'string' ? null : 'text'),
      ...(target === 'boundary' ? { boundaries: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'a list of BC ids (or "@walls")') } : {}),
      ...(target === 'point'
        ? { points: (v) => (Array.isArray(v) && v.length <= 64 && v.every((p) => Array.isArray(p) && p.length === 3 && p.every((x) => typeof x === 'number' && Number.isFinite(x))) ? null : 'a list of [x, y, z] in metres') }
        : {}),
    };
    const parsed = parseValues(input.values, flattenSchema(typeRow.schema), extra);
    if (!parsed.ok) return badValues(parsed.problems, `catalog {kind:'monitors', key:'${cleanText(str(typeRow.key), 64)}'} lists its fields.`);
    const name = cleanText(str(input.name).trim(), 120);
    // A new monitor on boundaries starts on every one it can measure, as the panel's does (Forces: every wall).
    const boundaries = !old && target === 'boundary' ? monitorBoundaryTokens(records(((await d.hostCall('bcs.get', q, o)) as Record<string, unknown>).boundary_conditions), typeRow.boundary_kinds, records(registry.bc_family)) : [];
    const rec: Record<string, unknown> = old
      ? { ...old }
      : newMonitorRecord(typeRow, rcId(), name || `${cleanText(str(typeRow.label), 60)} ${rcs.filter((r) => r.monitor_type === typeRow.key).length + 1}`, { boundaries });
    if (name) rec.name = name;
    Object.assign(rec, parsed.values);
    if (target === 'patch' && Array.isArray(input.faces) && input.faces.length) rec.faces = await facesOk(g.geometryId, input.faces);
    const at = rcs.findIndex((r) => r.id === rec.id);
    if (at >= 0) rcs[at] = rec;
    else rcs.push(rec);
    const saved = await update({ result_controls: rcs });
    sync(['runs'], sim, { run: [id], monitor: [str(rec.id)] }, revOf(saved) !== null ? { [id]: revOf(saved) as number } : {});
    return okDone({ done: `${action === 'add' ? 'Added' : 'Saved'} monitor ${quoted(rec.name)} on run ${quoted(run.name)}.`, ids: { run: id, monitor: str(rec.id) }, rev: revOf(saved) });
  }

  // ------------------------------------------------------------------ geometry
  async function geometryEdit(
    project: string,
    input: Record<string, unknown>,
    rt: ToolRunContext,
    sync: (kinds: SyncKind[], sim: string | null, ids: Record<string, string[]>, revs?: Record<string, number>, active?: Record<string, string>) => void,
    findJob: (project: string, jobId: string, rt: { signal: AbortSignal; turn: string | null }) => Promise<{ plugin: string; study_id: string; job: Record<string, unknown> } | null>,
  ): Promise<ToolOutcome> {
    const action = str(input.action);
    const o = via(rt, `setup_edit.geometry.${action}`);
    const proj = await readProject(d.hostCall, rt, project, 'setup_edit');
    if (action === 'link_choice') {
      const jobId = str(input.other_id).trim();
      const choice = str(input.type).trim();
      if (!LINK_CHOICES.includes(choice)) return fail('invalid_input', `link_choice takes type ${LINK_CHOICES.join(', ')}.`);
      const found = await findJob(project, jobId, rt);
      if (!found) return fail('not_found', `No link job "${cleanText(jobId, 80)}" in this project.`, 'wait follows link jobs; their ids are link.<gl-…>.');
      const parsed = parseValues(input.values, [], { copy: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'a list of study ids') });
      if (!parsed.ok) return badValues(parsed.problems, 'link_choice takes values copy: the study ids to copy.');
      const r = (await d.hostCall('link.choose', { project_id: project, plugin: found.plugin, study_id: found.study_id, job_id: jobId, choice, copy: Array.isArray(parsed.values.copy) ? parsed.values.copy : [] }, o)) as Record<string, unknown>;
      sync(['geometry', 'tree'], null, { geometry: [str(r.geometry_id)].filter(Boolean) });
      const said: Record<string, string> = { new: 'It adds the design as a new geometry.', overwrite: 'It updates the geometry in place.', cancel: 'The update is cancelled.', not_now: 'The question waits for later.' };
      return okDone({ done: `Answered the link question: ${choice}. ${said[choice]}`, ids: { link_job: jobId, ...(r.geometry_id ? { geometry: str(r.geometry_id) } : {}) } });
    }
    const id = idOf(input);
    const g = records(proj.geometries).find((x) => x.id === id);
    if (!g) return fail('not_found', id ? `No geometry "${cleanText(id, 80)}" in this project.` : 'Name the geometry by its id.', 'project_summary lists the geometries.');
    if (action === 'activate') {
      await d.hostCall('geometry.activate', { project_id: project, geometry_id: id }, o);
      sync(['active', 'geometry', 'tree'], null, { geometry: [id] }, {}, { geometry: id });
      return okDone({ done: `Geometry ${quoted(g.name)} is now shown.`, ids: { geometry: id } });
    }
    if (action === 'add_original') {
      rt.progress(null, 'Importing the original file');
      const r = (await d.hostCall('geometry.original_import', { project_id: project, geometry_id: id }, o)) as Record<string, unknown>;
      const added = isRecord(r.added) ? r.added : {};
      sync(['geometry', 'active', 'tree'], null, { geometry: [str(added.id)] }, {}, { geometry: str(added.id) });
      return okDone({ done: `Imported the original of ${quoted(g.name)} as geometry ${quoted(added.name)}.`, ids: { geometry: str(added.id) } });
    }
    // edit_in_cad: the plugin's geometry-editing study kind (catalog study_kinds, edits_geometry).
    const plugins = records(((await d.hostCall('plugins.list', {}, o)) as Record<string, unknown>).plugins).filter((p) => p.enabled !== false);
    const editor = plugins.flatMap((p) => records(p.geometry_actions).map((a) => ({ plugin: str(p.key), kind: str(a.study_kind) }))).find((x) => x.plugin && x.kind);
    if (!editor) return fail('not_found', 'No plugin that edits geometry is on.', "catalog {kind:'plugins', key:''} lists them; the person can turn one on in Settings.");
    const r = (await d.hostCall('geometry_actions.open', { project_id: project, geometry_id: id, plugin: editor.plugin, study_kind: editor.kind }, o)) as Record<string, unknown>;
    sync(['plugin_studies', 'tree'], null, { plugin_study: [str(r.study_id)] });
    return okDone({
      done: `${r.created ? 'Made' : 'Found'} ${quoted(r.title ?? 'the CAD study')} to edit ${quoted(g.name)}.`,
      ids: { plugin_study: str(r.study_id), workspace: str(r.workspace) },
      hint: `Open it with core__show {target:'workspace', id:'${str(r.study_id)}'}.`,
    });
  }
}

/** A material's property values: the preset's, then the model's defaults, then `values` (checked), under every record key. */
function materialValues(model: Record<string, unknown>, preset: Record<string, unknown> | null, values: unknown): Record<string, unknown> {
  const fields: Field[] = flattenSchema(model.schema);
  const parsed = parseValues(values, fields);
  if (!parsed.ok) return badValues(parsed.problems, `catalog {kind:'materials', key:'${cleanText(str(model.key), 64)}'} lists its fields.`);
  const given: Record<string, unknown> = {};
  if (preset && isRecord(preset.values)) Object.assign(given, preset.values);
  Object.assign(given, parsed.values);
  const keys = isRecord(model.record_keys) ? model.record_keys : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(given)) {
    const names = Array.isArray(keys[k]) ? (keys[k] as unknown[]).map((x) => str(x)) : [k];
    for (const n of names) out[n] = v;
  }
  return out;
}

/** A material's bodies under every key the page writes them (materialRecord). */
function setBodies(rec: Record<string, unknown>, bodies: string[]): void {
  rec.assigned_volumes = bodies.slice();
  rec.assigned_volume = bodies[0] || null;
  rec.body_ids = bodies.slice();
  rec.volume_ids = bodies.slice();
}

/** What a 'boundary' monitor saves for the walls no BC claims (src/monitorTargets.ts DEFAULT_WALLS_TOKEN). */
export const DEFAULT_WALLS_TOKEN = '@walls';

/** A bc_type compared without case, spaces, '_' or '-' (src/bcCatalog.ts typeText). */
const bcTypeText = (raw: unknown): string => str(raw).toLowerCase().replace(/[\s_-]+/g, '');

/** The BC family a saved record belongs to, by its bc_type (src/bcCatalog.ts familyKeyOf); '' for none. */
function bcFamilyKey(bc: Record<string, unknown>, families: Record<string, unknown>[]): string {
  const want = bcTypeText(bc.bc_type || bc.type);
  if (!want) return '';
  const fam = families.find((f) => str(f.key).trim() && str(f.record_type).trim() && [f.record_type, ...(Array.isArray(f.aliases) ? f.aliases : [])].some((n) => bcTypeText(n) === want));
  return fam ? str(fam.key) : '';
}

/**
 * The boundaries a new 'boundary' monitor starts on, as the run panel picks them
 * (src/monitorTargets.ts boundaryChoices, its tokens): the study's BCs with faces whose family
 * the type's boundary_kinds lists (any when it lists none), then the walls no BC claims when it
 * takes walls. A unit test holds the two to the same list.
 */
export function monitorBoundaryTokens(bcs: Record<string, unknown>[], kinds: unknown, families: Record<string, unknown>[]): string[] {
  const want = Array.isArray(kinds) && kinds.length ? new Set(kinds.map(String)) : null;
  const out: string[] = [];
  for (const bc of bcs) {
    if (!Array.isArray(bc.faces) || !bc.faces.length) continue;
    if (want && !want.has(bcFamilyKey(bc, families))) continue;
    const name = str(bc.name).trim();
    const token = bc.id != null && String(bc.id) ? String(bc.id) : name;
    if (!token || out.includes(token)) continue;
    out.push(token);
  }
  if (!want || want.has('wall')) out.push(DEFAULT_WALLS_TOKEN);
  return out;
}

/**
 * A new result control of a monitor type, as the run panel saves it (src/monitorTargets.ts
 * newMonitorRecord: that module imports the registry types, so the server keeps this copy;
 * a unit test holds the two to the same record).
 */
export function newMonitorRecord(typeRow: Record<string, unknown>, id: string, name: string, opts: { boundaries?: string[] } = {}): Record<string, unknown> {
  const target = str(typeRow.target) || 'patch';
  const base = {
    id,
    name,
    monitor_type: typeRow.key,
    kind: str(typeRow.label) || 'Area average',
    category: target === 'boundary' ? 'Boundary data' : target === 'point' ? 'Point data' : 'Surface data',
    write_control: 'Time step',
    faces: [] as string[],
    results: null,
    series: null,
    chart_values: null,
    results_available: false,
  };
  if (target === 'boundary') return { ...base, boundaries: (opts.boundaries || []).slice() };
  if (target === 'point') return { ...base, points: [] };
  return base;
}

/** A transient control field's default (the transient sibling's control schema). */
function defaultOf(registry: Record<string, unknown>, analysisKey: string, key: string): unknown {
  const analyses = records(registry.analysis);
  const row = analyses.find((a) => a.key === analysisKey);
  const family = row ? str(row.family) || str(row.plugin) : '';
  const t = (row && row.time_dependency === 'transient' ? row : null) ?? analyses.find((a) => a.time_dependency === 'transient' && (str(a.family) || str(a.plugin)) === family);
  const props = t && isRecord(t.control_schema) && isRecord(t.control_schema.properties) ? t.control_schema.properties : {};
  const p = props[key];
  return isRecord(p) ? (p.default ?? null) : null;
}
