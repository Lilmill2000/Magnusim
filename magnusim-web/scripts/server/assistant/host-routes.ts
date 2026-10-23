/**
 * The app routes the host tools may call (core host tools spec C1, §3, §4): one frozen table of
 * entries by id, grouped by tool. host-call.ts checks every entry against the denylist when
 * it freezes the table, and the call's body again at each call. A tool lane adds its entries
 * here, never transport code.
 *
 * Every builder names each key it sends: a value comes from `args` (the tool's own, already
 * checked input) by name, never the model's input spread into a query or body. Ids are
 * `<area>.<what>`; the starter tools' five (Foundation) are HOST_GET_ALLOWLIST's paths.
 */
import type { Args, HostRoute, QueryValue } from './host-call.ts';

/** `a[k]` when it is a non-empty string, else null (left out of a query). */
const s = (a: Args, k: string): string | null => (typeof a[k] === 'string' && a[k] !== '' ? (a[k] as string) : null);

const projectQuery = (a: Args): Record<string, QueryValue> => ({ project_id: s(a, 'project_id') });
const studyQuery = (a: Args): Record<string, QueryValue> => ({ project_id: s(a, 'project_id'), simulation_id: s(a, 'simulation_id') });
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
  // ---- the starter tools (app_status, project_summary, explain_ready)
  'queue.get': { method: 'GET', path: '/api/compute-queue', query: projectQuery, band: 'read' },
  'projects.list': { method: 'GET', path: '/api/projects', query: projectQuery, band: 'read' },
  'project.get': { method: 'GET', path: '/api/project', query: projectQuery, band: 'read' },
  'simulation.get': { method: 'GET', path: '/api/simulation', query: studyQuery, band: 'read' },
  'run.ready': { method: 'GET', path: '/api/run/ready', query: (a) => ({ ...studyQuery(a), run_id: s(a, 'run_id') }), band: 'read' },

  // ---- host-tool images (C6): the project's picture as on Home, PNG at most 1.5 MB (IMAGE_CAPS)
  'geometry.thumb': { method: 'GET', path: '/api/geometry/thumb', query: projectQuery, binary: true, maxBytes: 1.5 * 1024 * 1024, band: 'read' },

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
  'mesh.get': { method: 'GET', path: '/api/mesh', query: (a) => ({ ...studyQuery(a), mesh_id: s(a, 'mesh_id') }), band: 'read' },
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
  'run.status': { method: 'GET', path: '/api/run/status', query: (a) => ({ ...studyQuery(a), run_id: s(a, 'run_id') }), band: 'read' },
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
  /** The run's case goes from the app to the app (checked against the project there); never to the model. */
  'results.times': { method: 'GET', path: '/api/times', query: (a) => ({ case: s(a, 'case'), project_id: s(a, 'project_id') }), band: 'read' },
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
  'link.status': {
    method: 'GET',
    path: '/api/plugin-geometry/status',
    query: (a) => ({ project_id: s(a, 'project_id'), plugin: s(a, 'plugin'), study_id: s(a, 'study_id'), job_id: s(a, 'job_id') }),
    band: 'read',
  },
};
