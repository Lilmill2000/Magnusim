/**
 * The app routes the host tools may call (core host tools spec C1, §3, §4): one table of
 * entries by id, grouped by tool. host-call.ts checks every entry against the denylist when
 * it freezes the table, and the call's body again at each call. A tool lane adds its entries
 * here, never transport code.
 *
 * Every builder names each key it sends: a value comes from `args` (the tool's own, already
 * checked input) by name, never the model's input spread into a query or body. Beyond the
 * denylist, the bodies that would do more than a tool means are not built at all: an empty
 * /api/mesh body (it restores the defaults, or makes a new mesh), a BC or refinement delete
 * by anything but its id. The node tests (assistant-host-writes, -project, -delete) hold
 * each entry to its method, path and body keys. Ids are `<area>.<what>`; the starter tools'
 * five (Foundation) are HOST_GET_ALLOWLIST's paths.
 */

import type { Args, HostRoute, QueryValue } from './host-call.ts';

const S30 = 30_000;
const MB4 = 4 * 1024 * 1024;
const MB16 = 16 * 1024 * 1024;

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
/** A value when given, else undefined (the key is then left out of the JSON). */
const opt = <T>(v: T | undefined | null | ''): T | undefined => (v === undefined || v === null || v === '' ? undefined : v);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function read(path: string, query?: HostRoute['query'], extra: Partial<HostRoute> = {}): HostRoute {
  return { method: 'GET', path, ...(query ? { query } : {}), timeoutMs: S30, maxBytes: MB4, band: 'read', ...extra };
}
function write(path: string, body: NonNullable<HostRoute['body']>, extra: Partial<HostRoute> = {}): HostRoute {
  return { method: 'POST', path, body, timeoutMs: S30, maxBytes: MB4, band: 'write', ...extra };
}

const P = (a: Args) => ({ project_id: str(a.project_id) });
const PS = (a: Args) => ({ project_id: str(a.project_id), simulation_id: opt(str(a.simulation_id)) });

/** The family fields of a BC (checked against its family's schema by setup_edit). */
const bcFields = (a: Args) => obj(a.fields);
/** The refinement fields of its type (checked by setup_edit). */
const refFields = (a: Args) => obj(a.fields);

/** `a[k]` when it is a non-empty string, else null (left out of a query). The job tools' entries use these. */
const s = (a: Args, k: string): string | null => (typeof a[k] === 'string' && a[k] !== '' ? (a[k] as string) : null);
const projectQuery = (a: Args): Record<string, QueryValue> => ({ project_id: s(a, 'project_id') });
/** `a[k]` when it is a finite number, else null (left out). */
const n = (a: Args, k: string): number | null => (typeof a[k] === 'number' && Number.isFinite(a[k]) ? (a[k] as number) : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Only the keys that have a value: a route reads "" or null as given. */
function only(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

export const HOST_ROUTE_TABLE: Record<string, HostRoute> = {
  // ---------------------------------------------------------------- the starters (Foundation 7.4)
  'queue.get': read('/api/compute-queue', (a) => ({ project_id: opt(str(a.project_id)) })),
  'projects.list': read('/api/projects'),
  'project.get': read('/api/project', P),
  'simulation.get': read('/api/simulation', PS),
  'run.ready': read('/api/run/ready', (a) => ({ ...PS(a), run_id: opt(str(a.run_id)) })),

  // ---------------------------------------------------------------- app_status, catalog
  'plugins.list': read('/api/plugins'),
  'plugin.env': read('/api/plugins/:key/env'),
  'prefs.get': read('/api/prefs'),
  'registry.get': read('/api/registry', undefined, { maxBytes: MB16 }),
  'bc.menu': write('/api/worker', () => ({ method: 'bc.menu', params: {} }), { band: 'read', worker: 'bc.menu' }),

  // ---------------------------------------------------------------- project_summary, read_setup
  'plugin_studies.list': read('/api/plugin-studies', P),
  // Host-tool images (C6): the project's picture as on Home, PNG at most 1.5 MB (IMAGE_CAPS).
  'geometry.thumb': read('/api/geometry/thumb', P, { binary: true, maxBytes: 1.5 * 1024 * 1024 }),
  'materials.get': read('/api/materials', PS),
  'bcs.get': read('/api/bcs', PS),
  'mesh.get': read('/api/mesh', (a) => ({ ...PS(a), mesh_id: opt(str(a.mesh_id)) })),
  'refinements.get': read('/api/mesh/refinements', PS),
  'run.status': read('/api/run/status', (a) => ({ ...PS(a), run_id: opt(str(a.run_id)) })),
  'geometry.meta': read('/api/geometry/cad', (a) => ({ project_id: str(a.project_id), geometry_id: opt(str(a.geometry_id)), part: 'meta' }), { maxBytes: MB16 }),
  'geometry.face_map': read('/api/geometry/face-map', (a) => ({ project_id: str(a.project_id), from: str(a.from), to: str(a.to) }), { maxBytes: MB16 }),
  'geometry.lost_faces': read('/api/geometry/lost-faces', (a) => ({ project_id: str(a.project_id), geometry_id: str(a.geometry_id) })),
  'link.status': read('/api/plugin-geometry/status', (a) => ({ project_id: str(a.project_id), plugin: str(a.plugin), study_id: str(a.study_id), job_id: str(a.job_id) })),
  'link.linked': read('/api/plugin-geometry/linked', (a) => ({ project_id: str(a.project_id), plugin: str(a.plugin), study_id: str(a.study_id) })),

  // ---------------------------------------------------------------- read_results
  'run.monitors': read('/api/run/monitors', (a) => ({ ...PS(a), run_id: opt(str(a.run_id)) })),
  // `case` is the run's case folder, read from run.status: the model never gives or sees it.
  'results.times': read('/api/times', (a) => ({ project_id: str(a.project_id), case: str(a.case) })),
  'results.field_meta': read('/api/fields/:field/meta', (a) => ({ project_id: str(a.project_id), case: str(a.case), time: opt(str(a.time)) }), { maxBytes: MB16 }),
  'results.series_range': read('/api/fields/:field/series-range', (a) => ({ project_id: str(a.project_id), case: str(a.case) })),
  'results.inspect': read('/api/inspect', (a) => ({
    project_id: str(a.project_id),
    case: str(a.case),
    time: opt(str(a.time)),
    x: Number(a.x),
    y: Number(a.y),
    z: Number(a.z),
    fields: opt(str(a.fields)),
  })),
  'results.line': read(
    '/api/plot-over-path',
    (a) => ({ project_id: str(a.project_id), case: str(a.case), time: opt(str(a.time)), points: str(a.points), subdivisions: Number(a.subdivisions) || 0, field: opt(str(a.field)) }),
    { maxBytes: MB16 },
  ),
  // A plugin filter's own fields go on the query, as its schema names them (checked by read_results).
  'results.filter': read('/api/filter/:key', (a) => ({ ...obj(a.params), project_id: str(a.project_id), simulation_id: opt(str(a.simulation_id)), case: opt(str(a.case)) })),
  'media.list': read('/api/media/list', (a) => ({ ...PS(a), owner: str(a.owner) })),
  'results.export': read('/api/results/export-vtk/:id', P),
  // A read: it writes nothing (w27 previewTransient).
  'run.transient_preview': write(
    '/api/run/transient-preview',
    (a) => ({ project_id: str(a.project_id), run_id: str(a.run_id), simulation_id: opt(str(a.simulation_id)), transient: obj(a.transient) }),
    { band: 'read' },
  ),

  // ---------------------------------------------------------------- project_edit
  'folders.create': write('/api/folders', (a) => ({ name: str(a.name) })),
  'project.create': write('/api/project', (a) => ({
    title: str(a.title),
    description: str(a.description),
    category: opt(str(a.category)),
    units: opt(str(a.units)),
    folder: opt(str(a.folder)),
  })),
  'project.update': write('/api/project/update', (a) => ({
    project_id: str(a.project_id),
    title: opt(str(a.title)),
    description: opt(str(a.description)),
    category: opt(str(a.category)),
    units: opt(str(a.units)),
    folder: opt(str(a.folder)),
  })),
  'project.move': write('/api/project/move', (a) => ({ project_id: str(a.project_id), folder: str(a.folder) })),
  'project.sample': write('/api/project/sample', (a) => ({ plugin: str(a.plugin), sample: str(a.sample), folder: opt(str(a.folder)) }), { timeoutMs: 120_000 }),

  // ---------------------------------------------------------------- study_edit
  'simulation.create': write('/api/simulation', (a) => ({
    project_id: str(a.project_id),
    analysis_type: str(a.analysis_type),
    time_dependency: opt(str(a.time_dependency)),
    geometry_id: opt(str(a.geometry_id)),
    activate: true,
  })),
  'simulation.copy': write('/api/simulation', (a) => ({
    project_id: str(a.project_id),
    copy_from: str(a.copy_from),
    copy_mode: str(a.copy_mode),
    geometry_id: opt(str(a.geometry_id)),
    activate: true,
  }), { timeoutMs: 120_000 }),
  // `settings`: the dotted study keys made nested, each checked against the analysis's schemas.
  'simulation.update': write('/api/simulation/update', (a) => ({
    ...obj(a.settings),
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    name: opt(str(a.name)),
    time_dependency: opt(str(a.time_dependency)),
  })),
  'simulation.activate': write('/api/simulation/activate', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id) })),
  'simulation.reorder': write('/api/simulation/reorder', (a) => ({ project_id: str(a.project_id), ids: list(a.ids).map(str), geometry_id: opt(str(a.geometry_id)) })),
  'plugin_studies.create': write('/api/plugin-studies/create', (a) => ({ project_id: str(a.project_id), plugin: str(a.plugin), kind: str(a.kind), title: str(a.title) })),
  'plugin_studies.rename': write('/api/plugin-studies/rename', (a) => ({
    project_id: str(a.project_id),
    plugin: str(a.plugin),
    study_id: str(a.study_id),
    title: str(a.title),
    rev: Number(a.rev) || 0,
  })),

  // ---------------------------------------------------------------- setup_edit: materials
  // The study's records with this one replaced (only_id: the worker persists only it).
  'materials.set': write('/api/worker', (a) => ({
    method: 'materials.set',
    params: {
      project_id: str(a.project_id),
      sim_id: str(a.simulation_id),
      body: {
        project_id: str(a.project_id),
        simulation_id: str(a.simulation_id),
        materials: list(a.materials),
        ...(a.air && typeof a.air === 'object' ? { air: a.air } : {}),
        only_id: str(a.only_id),
        ...(list(a.only_ids).length ? { only_ids: list(a.only_ids).map(str) } : {}),
      },
    },
  }), { worker: 'materials.set' }),

  // ---------------------------------------------------------------- setup_edit: BCs
  'bcs.upsert': write('/api/bcs', (a) => ({
    ...bcFields(a),
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    geometry_id: opt(str(a.geometry_id)),
    id: opt(str(a.id)),
    name: str(a.name),
    bc_type: str(a.bc_type),
    faces: list(a.faces).map(str),
    geometry_rev: opt(a.geometry_rev as number),
    base_rev: opt(a.base_rev as number),
  })),
  'bcs.defaults': write('/api/bcs', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), defaults: { wall_type: str(a.wall_type) } })),

  // ---------------------------------------------------------------- setup_edit: meshes (never an empty body)
  'mesh.create': write('/api/mesh', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), create: true, name: opt(str(a.name)) })),
  // `settings`: the buildSettings keys (top-level and `advanced`), checked by setup_edit.
  'mesh.update': write('/api/mesh', (a) => ({
    ...obj(a.settings),
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    geometry_id: opt(str(a.geometry_id)),
    mesh_id: str(a.mesh_id),
    name: opt(str(a.name)),
    base_rev: opt(a.base_rev as number),
  })),
  'mesh.activate': write('/api/mesh', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), activate: str(a.mesh_id) })),
  'mesh.rename': write('/api/mesh', (a) => ({
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    mesh_id: str(a.mesh_id),
    name: str(a.name),
    base_rev: opt(a.base_rev as number),
  })),
  'mesh.restore_defaults': write('/api/mesh', (a) => ({
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    mesh_id: str(a.mesh_id),
    use_bank_defaults: true,
    base_rev: opt(a.base_rev as number),
  })),
  'mesh.copy_from': write('/api/mesh', (a) => ({
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    mesh_id: str(a.mesh_id),
    copy_from: str(a.copy_from),
    base_rev: opt(a.base_rev as number),
  })),

  // ---------------------------------------------------------------- setup_edit: refinements
  'refinements.upsert': write('/api/mesh/refinements', (a) => ({
    ...refFields(a),
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    id: opt(str(a.id)),
    name: str(a.name),
    type: str(a.type),
    mesh_id: str(a.mesh_id),
    faces: list(a.faces).map(str),
    faces_explicit: true,
    geometry_rev: opt(a.geometry_rev as number),
    base_rev: opt(a.base_rev as number),
  })),
  'refinements.copy': write('/api/mesh/refinements', (a) => ({
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    mesh_id: str(a.mesh_id),
    copy_from_mesh: str(a.copy_from_mesh),
  })),

  // ---------------------------------------------------------------- setup_edit: runs, monitors, saved views
  'run.create': write('/api/run/create', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), name: str(a.name), mesh_id: opt(str(a.mesh_id)) })),
  // `changes`: run settings keys as the route takes them (camelCase), checked by setup_edit.
  'run.update': write('/api/run/update', (a) => ({
    ...obj(a.changes),
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    run_id: str(a.run_id),
    geometry_rev: opt(a.geometry_rev as number),
    base_rev: opt(a.base_rev as number),
  })),
  'run.activate': write('/api/run/activate', (a) => ({ project_id: str(a.project_id), run_id: str(a.run_id), simulation_id: str(a.simulation_id) })),
  'run.rename': write('/api/run/rename', (a) => ({ project_id: str(a.project_id), run_id: str(a.run_id), name: str(a.name), simulation_id: str(a.simulation_id) })),

  // ---------------------------------------------------------------- setup_edit: geometry
  'geometry.activate': write('/api/geometry/activate', (a) => ({ project_id: str(a.project_id), geometry_id: str(a.geometry_id) })),
  'link.choose': write('/api/plugin-geometry/choose', (a) => ({
    project_id: str(a.project_id),
    plugin: str(a.plugin),
    study_id: str(a.study_id),
    job_id: str(a.job_id),
    choice: str(a.choice),
    copy: list(a.copy).map(str),
  })),
  'geometry.original_import': write('/api/geometry/original/import', (a) => ({ project_id: str(a.project_id), geometry_id: str(a.geometry_id) }), { timeoutMs: 600_000 }),
  'geometry_actions.open': write('/api/geometry-actions/open', (a) => ({
    project_id: str(a.project_id),
    geometry_id: str(a.geometry_id),
    plugin: str(a.plugin),
    study_kind: str(a.study_kind),
  }), { timeoutMs: 120_000 }),

  // ---------------------------------------------------------------- import_file (never mode=replace)
  'geometry.import_raw': {
    method: 'POST',
    path: '/api/geometry/import',
    query: (a: Args) => ({ project_id: str(a.project_id), filename: str(a.filename), length_unit: opt(str(a.length_unit)) }),
    raw: (a: Args) => a.raw as { stream: NodeJS.ReadableStream; bytes: number; type: 'application/octet-stream' },
    timeoutMs: 600_000,
    maxBytes: MB4,
    band: 'write',
  },
  // Only a path the person typed in this turn's message (import_file checks it).
  'geometry.import_path': write('/api/geometry/import', (a) => ({ project_id: str(a.project_id), step_path: str(a.step_path), length_unit: opt(str(a.length_unit)) }), {
    timeoutMs: 600_000,
  }),

  // ---------------------------------------------------------------- delete
  'project.delete': write('/api/project/delete', (a) => ({ project_id: str(a.project_id) })),
  'folders.delete': write('/api/folders', (a) => ({ delete: true, name: str(a.name) })),
  'geometry.remove': write('/api/geometry/remove', (a) => ({ project_id: str(a.project_id), geometry_id: str(a.geometry_id) })),
  'simulation.delete': write('/api/simulation/delete', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id) })),
  'plugin_studies.delete': write('/api/plugin-studies/delete', (a) => ({ project_id: str(a.project_id), plugin: str(a.plugin), study_id: str(a.study_id) })),
  'mesh.delete_generated': write('/api/mesh', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), mesh_id: str(a.mesh_id), delete_generated: true })),
  'mesh.delete_record': write('/api/mesh', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), mesh_id: str(a.mesh_id), delete_record: true })),
  // Always the id string, never `true` (that deletes every refinement of the study).
  'refinements.delete': write('/api/mesh/refinements', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), delete: str(a.id) })),
  'run.delete': write('/api/run/delete', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), run_id: str(a.run_id) })),
  // material_id is always set: without it every material of the study goes.
  'materials.delete': write('/api/materials', (a) => ({
    delete: true,
    project_id: str(a.project_id),
    simulation_id: str(a.simulation_id),
    geometry_id: opt(str(a.geometry_id)),
    material_id: str(a.material_id),
  })),
  // The id string, as the page sends it (never `true`).
  'bcs.delete': write('/api/bcs', (a) => ({ project_id: str(a.project_id), simulation_id: str(a.simulation_id), delete: str(a.id) })),
  'media.delete': write('/api/media/delete', (a) => ({ ...PS(a), owner: str(a.owner), id: str(a.id) })),
  'lost_faces.forget': write('/api/geometry/lost-faces/forget', (a) => ({
    project_id: str(a.project_id),
    geometry_id: str(a.geometry_id),
    geometry_rev: a.geometry_rev ?? null,
    study_id: opt(str(a.study_id)),
    kind: opt(str(a.kind)),
    id: opt(str(a.id)),
    mesh_id: opt(str(a.mesh_id)),
    run_id: opt(str(a.run_id)),
    entry: a.entry && typeof a.entry === 'object' ? a.entry : undefined,
  })),

  // ---- the job tools (compute, wait, jobs; spec 06 C4, §4.12-4.14): the queue, meshes, runs, exports
  /** A queued solve or continue, flat, as the page enqueues it (runtime.js enqueueSolveJob). */
  'queue.add': {
    method: 'POST',
    path: '/api/compute-queue',
    body: (a) =>
      only({
        id: s(a, 'id'),
        kind: 'solve',
        mesh_id: s(a, 'mesh_id'),
        run_id: s(a, 'run_id'),
        simulation_id: s(a, 'simulation_id'),
        project_id: s(a, 'project_id'),
        name: s(a, 'name'),
        mesh_generating: a.mesh_generating === true,
        settings: isObj(a.continue) ? { continue: a.continue } : null,
      }),
    band: 'write',
  },
  'queue.remove': {
    method: 'POST',
    path: '/api/compute-queue',
    body: (a) => ({ action: 'remove', kind: s(a, 'kind') ?? '', id: s(a, 'id') ?? '', project_id: s(a, 'project_id') ?? '' }),
    band: 'write',
  },
  'queue.reorder': { method: 'PATCH', path: '/api/compute-queue', body: (a) => ({ ids: Array.isArray(a.ids) ? a.ids.map(String) : [] }), band: 'write' },
  'queue.kick': { method: 'POST', path: '/api/compute-queue/kick', body: (a) => ({ project_id: s(a, 'project_id') ?? '' }), band: 'write' },
  /** No `settings`: the stored ones are generated (setup_edit saved them). Busy: queued. */
  'mesh.generate': {
    method: 'POST',
    path: '/api/mesh/generate',
    body: (a) => only({ project_id: s(a, 'project_id'), simulation_id: s(a, 'simulation_id'), mesh_id: s(a, 'mesh_id'), geometry_id: s(a, 'geometry_id'), name: s(a, 'name'), queue_if_busy: true }),
    band: 'write',
  },
  /** The mesh's Stop: ends its generate, deletes nothing (w20-mesh.js stopMeshRoute). */
  'mesh.stop': {
    method: 'POST',
    path: '/api/mesh/stop',
    body: (a) => ({ project_id: s(a, 'project_id') ?? '', simulation_id: s(a, 'simulation_id') ?? '', mesh_id: s(a, 'mesh_id') ?? '' }),
    band: 'write',
  },
  'run.start': {
    method: 'POST',
    path: '/api/run/start',
    body: (a) => only({ project_id: s(a, 'project_id'), simulation_id: s(a, 'simulation_id'), run_id: s(a, 'run_id'), start_id: s(a, 'start_id') }),
    band: 'write',
  },
  'run.continue': {
    method: 'POST',
    path: '/api/run/continue',
    body: (a) =>
      only({
        project_id: s(a, 'project_id'),
        simulation_id: s(a, 'simulation_id'),
        run_id: s(a, 'run_id'),
        extra_iterations: n(a, 'extra_iterations'),
        end_time: n(a, 'end_time'),
        start_id: s(a, 'start_id'),
      }),
    band: 'write',
  },
  /** The first stop is graceful (the current step is written); force ends it at once. */
  'run.stop': {
    method: 'POST',
    path: '/api/run/stop',
    body: (a) => ({ project_id: s(a, 'project_id') ?? '', run_id: s(a, 'run_id') ?? '', ...(a.force === true ? { force: true } : {}) }),
    band: 'write',
  },
  'export.start': {
    method: 'POST',
    path: '/api/results/export-vtk',
    body: (a) => only({ project_id: s(a, 'project_id'), case: s(a, 'case'), frames: s(a, 'frames'), time: s(a, 'time') }),
    band: 'write',
  },
  'export.get': { method: 'GET', path: '/api/results/export-vtk/:id', query: projectQuery, band: 'read' },
  /** The job manager's stop: kills the export's process tree. */
  'jobs.stop': { method: 'POST', path: '/api/jobs/:id/stop', query: projectQuery, body: () => ({}), band: 'write' },
  /** Up to two minutes (WSL's first start); the server answers meanwhile (hardware-profile.js). */
  'prefs.hardware_check': { method: 'POST', path: '/api/prefs/hardware-check', body: () => ({}), timeoutMs: 150_000, band: 'write' },
  'plugins.env.get': { method: 'GET', path: '/api/plugins/:key/env', band: 'read' },
  'plugins.env.install': { method: 'POST', path: '/api/plugins/:key/env/install', body: () => ({}), band: 'write' },
};
