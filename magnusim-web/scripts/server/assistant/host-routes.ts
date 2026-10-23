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

export const HOST_ROUTE_TABLE: Record<string, HostRoute> = {
  // ---- the starter tools (app_status, project_summary, explain_ready)
  'queue.get': { method: 'GET', path: '/api/compute-queue', query: projectQuery, band: 'read' },
  'projects.list': { method: 'GET', path: '/api/projects', query: projectQuery, band: 'read' },
  'project.get': { method: 'GET', path: '/api/project', query: projectQuery, band: 'read' },
  'simulation.get': { method: 'GET', path: '/api/simulation', query: studyQuery, band: 'read' },
  'run.ready': { method: 'GET', path: '/api/run/ready', query: (a) => ({ ...studyQuery(a), run_id: s(a, 'run_id') }), band: 'read' },

  // ---- host-tool images (C6): the project's picture as on Home, PNG at most 1.5 MB (IMAGE_CAPS)
  'geometry.thumb': { method: 'GET', path: '/api/geometry/thumb', query: projectQuery, binary: true, maxBytes: 1.5 * 1024 * 1024, band: 'read' },
};
