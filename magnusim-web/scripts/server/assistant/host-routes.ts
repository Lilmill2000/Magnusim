/**
 * Every app route a host tool may call (Core host tools spec 3.1, 4): one frozen table.
 *
 * A tool never passes a path: it names an entry and gives its args, and the entry builds
 * the request. Every body key is named here (the model's input is never spread into a
 * body), and the bodies that would do more than the tool means are not in the table at
 * all: a `{delete:true}` to /api/bcs or /api/mesh/refinements (it deletes every record of
 * the study), an empty /api/mesh body (it restores the defaults, or makes a new mesh), a
 * geometry import with `mode=replace`, /api/case/attach, /api/project/open and the
 * Assistant's own routes. The node test (assistant-host-writes.test.js) holds each entry
 * to its method, path and body keys.
 *
 * `:name` segments are filled from the args and must match SEGMENT. `band` says whether
 * a call writes (the write rate, and the ui_sync that follows).
 */

export type Args = Record<string, unknown>;

export interface HostRoute {
  method: 'GET' | 'POST' | 'PATCH';
  /** Exact path; `:name` segments are filled from args and must match SEGMENT. */
  path: string;
  /** Query from args (GET, and the raw import). Empty and null values are left out. */
  query?: (a: Args) => Record<string, string | number | boolean | null | undefined>;
  /** JSON body from args (POST/PATCH). Never spreads the model's input: every key is named. */
  body?: (a: Args) => Record<string, unknown>;
  /** A raw body instead (the geometry import): a file stream, with its byte count. */
  raw?: (a: Args) => { stream: NodeJS.ReadableStream; bytes: number; type: 'application/octet-stream' };
  /** Binary answer (PNG thumbnails). */
  binary?: boolean;
  timeoutMs: number;
  maxBytes: number;
  band: 'read' | 'write';
}

export const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

const S30 = 30_000;
const MB4 = 4 * 1024 * 1024;
const MB16 = 16 * 1024 * 1024;

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
/** A value when given, else undefined (the key is then left out of the JSON). */
const opt = <T>(v: T | undefined | null | ''): T | undefined => (v === undefined || v === null || v === '' ? undefined : v);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function read(path: string, query?: HostRoute['query'], extra: Partial<HostRoute> = {}): HostRoute {
  return Object.freeze({ method: 'GET', path, ...(query ? { query } : {}), timeoutMs: S30, maxBytes: MB4, band: 'read', ...extra }) as HostRoute;
}
function write(path: string, body: NonNullable<HostRoute['body']>, extra: Partial<HostRoute> = {}): HostRoute {
  return Object.freeze({ method: 'POST', path, body, timeoutMs: S30, maxBytes: MB4, band: 'write', ...extra }) as HostRoute;
}

const P = (a: Args) => ({ project_id: str(a.project_id) });
const PS = (a: Args) => ({ project_id: str(a.project_id), simulation_id: opt(str(a.simulation_id)) });

/** The family fields of a BC (checked against its family's schema by setup_edit). */
const bcFields = (a: Args) => obj(a.fields);
/** The refinement fields of its type (checked by setup_edit). */
const refFields = (a: Args) => obj(a.fields);

export const HOST_ROUTES: Readonly<Record<string, HostRoute>> = Object.freeze({
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
  'bc.menu': write('/api/worker', () => ({ method: 'bc.menu', params: {} }), { band: 'read' }),

  // ---------------------------------------------------------------- project_summary, read_setup
  'plugin_studies.list': read('/api/plugin-studies', P),
  'geometry.thumb': read('/api/geometry/thumb', P, { binary: true }),
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
  })),

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
  'geometry.import_raw': Object.freeze({
    method: 'POST',
    path: '/api/geometry/import',
    query: (a: Args) => ({ project_id: str(a.project_id), filename: str(a.filename), length_unit: opt(str(a.length_unit)) }),
    raw: (a: Args) => a.raw as { stream: NodeJS.ReadableStream; bytes: number; type: 'application/octet-stream' },
    timeoutMs: 600_000,
    maxBytes: MB4,
    band: 'write',
  }) as HostRoute,
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
});

export type HostRouteId = keyof typeof HOST_ROUTES;

/** The starters' GET paths, as HOST_GET_ALLOWLIST lists them. */
export const STARTER_ROUTES: readonly string[] = Object.freeze(['queue.get', 'projects.list', 'project.get', 'simulation.get', 'run.ready']);
