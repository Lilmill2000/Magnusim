/**
 * read_setup (Core host tools spec 4.5): a study's setup as its panels show it: the study
 * and its settings, materials, boundary conditions and their defaults, meshes, refinements,
 * runs and one run, the geometry with its bodies and faces (inside faces marked), the face
 * map to another geometry, lost faces, a linked design's state, and a plugin study. Every
 * answer is built from a whitelist of fields: no path ever reaches the model, and every
 * record carries its `rev` once records have one.
 */
import type { ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import { meshFields, REFINEMENT_FIELDS, studyFields } from './catalog.ts';
import {
  dotted,
  fail,
  failed,
  hostTool,
  isRecord,
  num,
  objectSchema,
  offeredIn,
  okData,
  projectIdOf,
  quoted,
  readableProject,
  records,
  refuse,
  revOf,
  rowLabel,
  S,
  str,
  studyIdOf,
  text,
  via,
  geometryRevOf,
  type HostToolDeps,
  type HostToolDef,
} from './common.ts';
import type { HostCall } from '../host-call.ts';
import { isLinked } from './project-summary.ts';

export const READ_SETUP_WHATS = ['study', 'materials', 'bcs', 'meshes', 'mesh', 'refinements', 'runs', 'run', 'geometry', 'bodies', 'faces', 'face_map', 'lost_faces', 'linked', 'plugin_study'] as const;
export const FACES_PAGE = 200;
/** How long a geometry's preview is waited for (it may still be made after an import). */
const PREVIEW_WAIT_MS = 60_000;

/** Keys the core owns on a BC record (w19 CORE_BC_KEYS, and the stamps): every other key is a field. */
export const BC_CORE_KEYS = new Set([
  'id',
  'name',
  'bc_type',
  'type',
  'faces',
  'face',
  'assigned_faces',
  'saved',
  'created_at',
  'updated_at',
  'persistence',
  'geometry_id',
  'simulation_id',
  'project_id',
  'boundary_conditions_json',
  'defaults',
  'defaults_by_simulation',
  'geometry_rev',
  'rev',
  'base_rev',
]);

/** The scalar and short-list fields of a record, for reads (never a path or a nested blob). */
export function plainFields(rec: Record<string, unknown>, skip: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (skip.has(k) || /(_path|_json|_dir|_url|_vtp)$/.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string') out[k] = cleanText(v, 300);
    else if (Array.isArray(v) && v.length <= 16 && v.every((x) => typeof x === 'number' || typeof x === 'string')) out[k] = v;
  }
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** A geometry's preview meta (its face table), waiting while it is still made (202). */
export async function readMeta(call: HostCall, rt: ToolRunContext, project: string, geometryId: string, tool: string): Promise<Record<string, unknown>> {
  const until = Date.now() + PREVIEW_WAIT_MS;
  for (;;) {
    const meta = (await call('geometry.meta', { project_id: project, geometry_id: geometryId }, via(rt, tool))) as Record<string, unknown>;
    if (meta.pending !== true) return meta;
    if (Date.now() > until || rt.signal.aborted) refuse('not_ready', "The geometry's preview is still being made.", 'Try again in a minute.');
    rt.progress(null, "Waiting for the geometry's preview");
    await sleep(1000, rt.signal);
  }
}

/** The project record (GET /api/project). */
export async function readProject(call: HostCall, rt: { signal: AbortSignal; turn: string | null }, project: string, tool: string): Promise<Record<string, unknown>> {
  const one = (await call('project.get', { project_id: project }, via(rt, tool))) as Record<string, unknown>;
  return isRecord(one.project) ? one.project : {};
}

/** The geometry a study uses (its geometry_id, else the project's shown one). */
export function studyGeometry(project: Record<string, unknown>, study: Record<string, unknown> | null): string {
  return str(study?.geometry_id) || str(project.active_geometry_id) || (isRecord(project.geometry) ? str(project.geometry.id) : '');
}

/** Face table rows as the model reads them: "face N@BodyM", name, area, normal, centroid, inside. */
export function faceRows(table: Record<string, unknown>[], from: number, count: number): Record<string, unknown>[] {
  return table.slice(from, from + count).map((r) => {
    const other = r.shared_with ? table[Number(r.shared_with) - 1] : null;
    return {
      id: rowLabel(r),
      name: text(r.label ?? r.name ?? '', 120) || '',
      body: `Body${Number(r.body) || 1}`,
      area: num(r.area),
      normal: Array.isArray(r.normal) ? r.normal : null,
      centroid: Array.isArray(r.centroid) ? r.centroid : null,
      surface: text(r.surface_type, 40),
      inside: !!other,
      ...(other ? { shared_with: rowLabel(other) } : {}),
    };
  });
}

export function readSetupTool(d: HostToolDeps): HostToolDef {
  const contexts = ['home', 'workbench', 'workspace'] as const;
  return hostTool({
    name: 'read_setup',
    title: 'Read the study setup',
    description:
      'Reads one part of a study\'s setup: study, materials, bcs, meshes, mesh, refinements, runs, run, geometry, bodies, faces (200 a page), face_map, lost_faces, linked, plugin_study. "" = this window\'s project, the shown study, the active record; other_id, page: "" and 0 when unused.',
    schema: objectSchema({
      project_id: S.id('"" = this window\'s project'),
      simulation_id: S.id('"" = the study shown'),
      what: S.enum(READ_SETUP_WHATS),
      id: S.text(120, 'the record (mesh, run, geometry, plugin study); "" = the active one'),
      other_id: S.text(120, 'face_map: the other geometry'),
      page: { type: 'integer', minimum: 0, maximum: 200, description: 'faces: 0-based page of 200' },
    }),
    risk: 'read',
    projectData: true,
    priority: 95,
    workerBacked: true,
    contexts,
    available: offeredIn(contexts),
    projectOf: (input, ctx) => projectIdOf(input, ctx),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const what = str(input.what);
      const id = str(input.id).trim();
      const tool = `read_setup.${what}`;
      try {
        const project = await readableProject(input, rt.ctx, d);
        const o = via(rt, tool);
        // What reads no study.
        if (what === 'geometry' || what === 'bodies' || what === 'faces' || what === 'face_map' || what === 'lost_faces' || what === 'linked' || what === 'plugin_study') {
          return await readGeometryPart(d, rt, input, project, what, id);
        }
        const { id: sim, studies } = await studyIdOf(input, rt.ctx, project, d.hostCall, rt, tool);
        const study = studies.list.find((s) => s.id === sim) ?? null;
        const q = { project_id: project, simulation_id: sim };
        switch (what) {
          case 'study': {
            const one = (await d.hostCall('simulation.get', q, o)) as Record<string, unknown>;
            const rec = isRecord(one.simulation) ? one.simulation : study ?? {};
            const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
            const analysis = str(rec.analysis_type);
            const settings: Record<string, unknown> = {};
            for (const f of studyFields(registry, analysis)) {
              const v = f.key.split('.').reduce<unknown>((at, k) => (isRecord(at) ? at[k] : undefined), rec);
              if (v !== undefined) settings[f.key] = v;
            }
            return okData(
              {
                id: text(rec.id, 80),
                name: text(rec.name),
                analysis: text(analysis, 80),
                geometry_id: text(rec.geometry_id, 80),
                time_dependency: text(rec.time_dependency, 20),
                active: rec.id === studies.activeId,
                settings,
                ...(revOf(rec) !== null ? { rev: revOf(rec) } : {}),
              },
              `Study ${quoted(rec.name)}`,
            );
          }
          case 'materials': {
            const [doc, registry] = await Promise.all([d.hostCall('materials.get', q, o) as Promise<Record<string, unknown>>, d.hostCall('registry.get', {}, o) as Promise<Record<string, unknown>>]);
            const models = records(registry.material);
            const list = records(doc.materials).map((m) => {
              const model = models.find((x) => x.key === m.material_model) ?? null;
              const props = model && isRecord(model.schema) && isRecord(model.schema.properties) ? Object.keys(model.schema.properties) : [];
              const properties: Record<string, unknown> = {};
              for (const k of props) if (typeof m[k] === 'number') properties[k] = m[k];
              return {
                id: text(m.id, 80),
                name: text(m.name),
                preset: text(m.preset, 80),
                material_model: text(m.material_model, 80),
                role: model && model.role === 'solid' ? 'solid' : 'fluid',
                properties,
                bodies: Array.isArray(m.assigned_volumes) ? m.assigned_volumes.map((b) => text(b, 40)) : [],
                ...(revOf(m) !== null ? { rev: revOf(m) } : {}),
              };
            });
            return okData({ materials: list }, `${list.length} materials`);
          }
          case 'bcs': {
            const doc = (await d.hostCall('bcs.get', q, o)) as Record<string, unknown>;
            const bcs = records(doc.boundary_conditions).map((b) => ({
              id: text(b.id, 80),
              name: text(b.name),
              type: text(b.bc_type),
              faces: Array.isArray(b.faces) ? b.faces.map((f) => text(f, 40)) : [],
              values: plainFields(b, BC_CORE_KEYS),
              ...(revOf(b) !== null ? { rev: revOf(b) } : {}),
            }));
            const defaults = isRecord(doc.defaults) ? doc.defaults : {};
            return okData(
              { bcs, defaults: { wall_type: text(defaults.wall_type, 40) }, ...(typeof doc.defaults_rev === 'number' ? { defaults_rev: doc.defaults_rev } : {}) },
              `${bcs.length} boundary conditions`,
            );
          }
          case 'meshes': {
            const doc = (await d.hostCall('mesh.get', q, o)) as Record<string, unknown>;
            const active = str(doc.active_id);
            const meshes = records(doc.meshes).map((m) => meshRow(m, active));
            return okData({ meshes }, `${meshes.length} meshes`);
          }
          case 'mesh': {
            const doc = (await d.hostCall('mesh.get', { ...q, mesh_id: id }, o)) as Record<string, unknown>;
            const rec = isRecord(doc.mesh) ? doc.mesh : null;
            if (!rec || (id && rec.id !== id)) return fail('not_found', id ? `No mesh "${cleanText(id, 80)}" in this study.` : 'This study has no mesh yet.', "read_setup {what:'meshes'} lists them.");
            const row = records(doc.meshes).find((m) => m.id === rec.id) ?? rec;
            const settings = isRecord(rec.settings) ? rec.settings : {};
            const engine = str(isRecord(settings.advanced) ? settings.advanced.mesh_engine : '');
            const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
            const flat = dotted(settings);
            const shown: Record<string, unknown> = {};
            for (const f of meshFields(registry, engine)) if (flat[f.key] !== undefined) shown[f.key] = flat[f.key];
            const live = isRecord(rec.live_mesh_result) ? rec.live_mesh_result : {};
            const quality: Record<string, unknown> = {};
            for (const k of ['max_non_orthogonality', 'max_non_ortho', 'max_skewness', 'max_aspect_ratio', 'n_faces', 'n_patches', 'n_layers_added']) if (typeof live[k] === 'number') quality[k] = live[k];
            return okData(
              {
                ...meshRow(row, str(doc.active_id)),
                settings: shown,
                ...(Object.keys(quality).length ? { quality } : {}),
              },
              `Mesh ${quoted(rec.name ?? settings.name)}`,
            );
          }
          case 'refinements': {
            const doc = (await d.hostCall('refinements.get', q, o)) as Record<string, unknown>;
            const list = records(doc.refinements)
              .filter((r) => !id || r.mesh_id === id)
              .map((r) => refinementRow(r));
            return okData({ refinements: list }, `${list.length} refinements`);
          }
          case 'runs': {
            const doc = (await d.hostCall('run.status', q, o)) as Record<string, unknown>;
            const active = str(doc.active_run_id);
            const runs = records(doc.runs).map((r) => ({
              id: text(r.id, 80),
              name: text(r.name),
              status: text(r.status ?? 'draft', 20),
              mesh_id: text(r.mesh_id, 80),
              active: r.id === active,
              ...(revOf(r) !== null ? { rev: revOf(r) } : {}),
            }));
            return okData({ runs }, `${runs.length} runs`);
          }
          case 'run': {
            const doc = (await d.hostCall('run.status', { ...q, run_id: id }, o)) as Record<string, unknown>;
            const r = isRecord(doc.run) ? doc.run : null;
            if (!r || (id && r.id !== id && r.run_id !== id)) return fail('not_found', id ? `No run "${cleanText(id, 80)}" in this study.` : 'This study has no run yet.', "read_setup {what:'runs'} lists them.");
            return okData(runRow(r, str(doc.active_run_id)), `Run ${quoted(r.name)}`);
          }
          default:
            return fail('invalid_input', `Unknown what "${cleanText(what, 40)}".`);
        }
      } catch (err) {
        return failed(err, "read_setup lists what there is: try what 'meshes', 'runs' or project_summary.");
      }
    },
  });
}

export function meshRow(m: Record<string, unknown>, activeId: string): Record<string, unknown> {
  const settings = isRecord(m.settings) ? m.settings : {};
  const live = isRecord(m.live_mesh_result) ? m.live_mesh_result : {};
  return {
    id: text(m.id, 80),
    name: text(m.name ?? settings.name),
    engine: text(isRecord(settings.advanced) ? settings.advanced.mesh_engine : '', 64),
    generated: {
      status: text(m.status ?? (m.generated ? 'done' : 'not generated'), 20),
      cells: num(m.n_cells) ?? num(live.n_cells),
      points: num(m.n_points) ?? num(live.n_points),
    },
    active: m.id === activeId,
    ...(revOf(m) !== null ? { rev: revOf(m) } : {}),
  };
}

export function refinementRow(r: Record<string, unknown>): Record<string, unknown> {
  const type = str(r.type);
  const fields = REFINEMENT_FIELDS[type] ?? [];
  const values: Record<string, unknown> = {};
  for (const f of fields) if (r[f.key] !== undefined) values[f.key] = r[f.key];
  return {
    id: text(r.id, 80),
    name: text(r.name),
    type: text(type, 80),
    mesh_id: text(r.mesh_id, 80),
    faces: Array.isArray(r.faces) ? r.faces.map((f) => text(f, 40)) : [],
    values,
    ...(revOf(r) !== null ? { rev: revOf(r) } : {}),
  };
}

export function runRow(r: Record<string, unknown>, activeId: string): Record<string, unknown> {
  const monitors = records(r.result_controls).map((rc) => ({
    id: text(rc.id, 80),
    type: text(rc.monitor_type ?? rc.kind, 80),
    name: text(rc.name),
    ...(Array.isArray(rc.faces) && rc.faces.length ? { faces: rc.faces.map((f) => text(f, 40)) } : {}),
    ...(Array.isArray(rc.boundaries) && rc.boundaries.length ? { boundaries: rc.boundaries.map((b) => text(b, 80)) } : {}),
    ...(Array.isArray(rc.points) && rc.points.length ? { points: rc.points.slice(0, 64) } : {}),
  }));
  const views = records(r.views).map((v) => ({ id: text(v.id, 80), name: text(v.name) }));
  const transient = isRecord(r.transient) ? plainFields(r.transient, new Set()) : null;
  return {
    id: text(r.id ?? r.run_id, 80),
    name: text(r.name),
    status: text(r.status ?? 'draft', 20),
    mesh_id: text(r.mesh_id, 80),
    time_dependency: text(r.time_dependency, 20),
    cores: num(r.cores),
    endTime: num(r.endTime),
    writeInterval: num(r.writeInterval),
    transient,
    settle: isRecord(r.settle) ? plainFields(r.settle, new Set()) : null,
    monitors,
    views,
    converged: isRecord(r.converged) ? plainFields(r.converged, new Set()) : r.converged === false ? false : null,
    has_results: r.has_results === true,
    active: (r.id ?? r.run_id) === activeId,
    ...(revOf(r) !== null ? { rev: revOf(r) } : {}),
  };
}

async function readGeometryPart(d: HostToolDeps, rt: ToolRunContext, input: Record<string, unknown>, project: string, what: string, id: string): Promise<ToolOutcome> {
  const tool = `read_setup.${what}`;
  const o = via(rt, tool);
  if (what === 'plugin_study' || what === 'linked') {
    const list = records(((await d.hostCall('plugin_studies.list', { project_id: project }, o)) as Record<string, unknown>).studies);
    if (what === 'plugin_study') {
      const s = id ? list.find((x) => x.id === id) : list[0];
      if (!s) return fail('not_found', id ? `No plugin study "${cleanText(id, 80)}".` : 'This project has no plugin study.', 'project_summary lists them.');
      return okData(
        { id: text(s.id, 80), plugin: text(s.plugin, 64), kind: text(s.kind, 80), title: text(s.title), rev: num(s.rev) ?? 0, available: s.available !== false, read_only: s.read_only === true, reason: text(s.reason, 300) },
        `Plugin study ${quoted(s.title)}`,
      );
    }
    // linked: a plugin study's design, or every linked geometry's.
    const proj = await readProject(d.hostCall, rt, project, tool);
    const geoms = records(proj.geometries).filter(isLinked);
    const targets = geoms
      .map((g) => ({ g, src: isRecord(g.source) ? g.source : {} }))
      .filter(({ g, src }) => !id || g.id === id || src.study_id === id);
    if (id && !targets.length) return fail('not_found', `No linked geometry or plugin study "${cleanText(id, 80)}".`, 'project_summary lists the geometries.');
    const out = [];
    for (const { g, src } of targets.slice(0, 20)) {
      const plugin = str(src.plugin);
      const studyId = str(src.study_id);
      let linked: Record<string, unknown> | null = null;
      if (plugin && studyId) {
        try {
          const r = (await d.hostCall('link.linked', { project_id: project, plugin, study_id: studyId }, o)) as Record<string, unknown>;
          linked = isRecord(r.linked) ? r.linked : null;
        } catch {
          linked = null;
        }
      }
      const pluginOn = list.some((s) => s.id === studyId && s.available !== false);
      const st = str(linked?.state);
      const lost = num(linked?.lostFaces) ?? 0;
      const state = !pluginOn ? 'plugin_off' : st === 'updating' ? 'updating' : st === 'queued' ? 'queued' : lost > 0 ? 'lost_faces' : st === 'failed' ? 'failed' : 'up_to_date';
      out.push({ geometry_id: text(g.id, 80), name: text(g.name), plugin: text(plugin, 64), study_id: text(studyId, 80), state, lost, rev: num(linked?.rev) });
    }
    return okData({ linked: out }, `${out.length} linked geometries`);
  }
  const proj = await readProject(d.hostCall, rt, project, tool);
  let geometryId = id;
  if (!geometryId) {
    // The shown study's geometry, else the project's shown one.
    let study: Record<string, unknown> | null = null;
    try {
      const { id: sim, studies } = await studyIdOf(input, rt.ctx, project, d.hostCall, rt, tool);
      study = studies.list.find((s) => s.id === sim) ?? null;
    } catch {
      study = null;
    }
    geometryId = studyGeometry(proj, study);
  }
  const geom = records(proj.geometries).find((g) => g.id === geometryId) ?? null;
  if (!geom) return fail('not_found', geometryId ? `No geometry "${cleanText(geometryId, 80)}" in this project.` : 'This project has no geometry yet.', 'project_summary lists the geometries.');
  if (what === 'lost_faces') {
    const r = (await d.hostCall('geometry.lost_faces', { project_id: project, geometry_id: geometryId }, o)) as Record<string, unknown>;
    const entries = records(r.entries).slice(0, 200).map((e) => ({
      study_id: text(e.studyId, 80),
      study: text(e.studyTitle),
      kind: text(e.kind, 40),
      id: text(e.id, 80),
      ...(e.meshId ? { mesh_id: text(e.meshId, 80) } : {}),
      ...(e.runId ? { run_id: text(e.runId, 80) } : {}),
      name: text(e.label ?? e.name),
      field: text(e.field, 80),
      faces: Array.isArray(e.old) ? e.old.map((f) => text(f, 40)) : text(e.old, 200),
      reason: text(e.reason, 200),
    }));
    return okData({ linked: r.linked === true, rev: num(r.rev), entries }, `${entries.length} entries with lost faces`);
  }
  if (what === 'face_map') {
    const other = str(input.other_id).trim();
    if (!other) return fail('invalid_input', 'face_map needs other_id: the geometry to map the faces to.', 'project_summary lists the geometries.');
    const r = (await d.hostCall('geometry.face_map', { project_id: project, from: geometryId, to: other }, o)) as Record<string, unknown>;
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(isRecord(r.map) ? r.map : {}).slice(0, 2000)) map[cleanText(k, 40)] = cleanText(String(v), 40);
    return okData({ from: geometryId, to: other, map }, `${Object.keys(map).length} faces matched`);
  }
  const meta = await readMeta(d.hostCall, rt, project, geometryId, tool);
  const table = records(meta.faces);
  if (what === 'bodies') {
    const names = Array.isArray(meta.bodies) ? meta.bodies.map((b) => str(b)) : ['Body1'];
    const info = records(meta.body_info);
    const bodies = names.slice(0, 200).map((name, i) => {
      const own = info.find((b) => b.ref === name);
      return { name: text(name, 40), index: i + 1, ...(own && (own.label || own.name) ? { label: text(own.label ?? own.name) } : {}) };
    });
    return okData({ geometry_id: geometryId, bodies }, `${bodies.length} bodies`);
  }
  if (what === 'faces') {
    const page = Math.max(0, Math.min(200, Number(input.page) || 0));
    const faces = faceRows(table, page * 200, 200);
    return okData(
      { geometry_id: geometryId, total: table.length, page, faces, ...((page + 1) * 200 < table.length ? { next_page: page + 1 } : {}) },
      `${faces.length} of ${table.length} faces`,
    );
  }
  const bounds = isRecord(meta.bounds) ? meta.bounds : null;
  return okData(
    {
      id: text(geom.id, 80),
      name: text(geom.name),
      representation: text(geom.representation, 20),
      bodies: Array.isArray(meta.bodies) ? meta.bodies.length : num(meta.n_solids),
      faces: table.length || num(meta.n_faces),
      inside_faces: table.filter((r) => r.shared_with).length,
      bounds: bounds ? { xmin: num(bounds.xmin), xmax: num(bounds.xmax), ymin: num(bounds.ymin), ymax: num(bounds.ymax), zmin: num(bounds.zmin), zmax: num(bounds.zmax) } : null,
      center_of_mass: Array.isArray(meta.center_of_mass) ? meta.center_of_mass : null,
      length_unit: text(meta.faces_length_unit ?? 'mm', 10),
      linked: isLinked(geom),
      geometry_rev: geometryRevOf(proj, geometryId),
      active: geometryId === str(proj.active_geometry_id),
    },
    `Geometry ${quoted(geom.name)}`,
  );
}
