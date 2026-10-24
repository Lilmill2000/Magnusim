// A stand-in for the app's routes, for the read and edit host tools' tests (Core host tools
// spec 16.1): one project ("p1", open in the turn's window) with a study, a two-body
// geometry whose face table has a face the bodies share, materials, BCs, meshes,
// refinements and runs, answered in the shapes the real handlers answer (paths included, to
// check they never reach the model), plus the committed registry. Every request is
// recorded (method, path, query, JSON body), and a test can answer any route its own way.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REGISTRY = JSON.parse(readFileSync(join(HERE, '..', '..', 'generated', 'registry.json'), 'utf8'));
export const WIN = 'C:\\Users\\someone\\Magnusim Projects';

/** The world the stand-in answers from; tests change it freely (a fresh one per call). */
export function world() {
  return {
    projects: [
      { id: 'p1', title: 'Wing', description: 'A wing in a tunnel', category: 'Aero', units: 'Metric', folder: 'Aero', updated_at: '2026-10-02T10:00:00Z', has_geometry: true, has_mesh: true, mesh_cells: 1200, run_status: 'done', thumb_url: '/api/geometry/thumb?project_id=p1' },
      { id: 'p2', title: 'Pipe', description: 'Elbow', category: 'Other', units: 'Imperial', folder: 'My Projects', updated_at: '2026-10-03T10:00:00Z', has_geometry: false },
      { id: 'p3', title: 'Duct', description: '', category: 'Other', units: 'Metric', folder: 'Aero', updated_at: '2026-10-01T10:00:00Z' },
    ],
    folders: ['Aero'],
    project: {
      id: 'p1',
      title: 'Wing',
      active_geometry_id: 'g1',
      geometry: { id: 'g1', name: 'Wing', step_path: `${WIN}\\p1\\wing.step` },
      geometries: [
        { id: 'g1', name: 'Wing', representation: 'step', step_path: `${WIN}\\p1\\wing.step` },
        { id: 'g2', name: 'Plate', representation: 'step', source: { type: 'plugin_study', plugin: 'cad', study_id: 'cs1' }, link: { rev: 4 } },
      ],
    },
    studies: [
      { id: 's1', name: 'Cruise', analysis_type: 'incompressible_steady', geometry_id: 'g1', time_dependency: 'Steady-state', turbulence_model: 'kOmegaSST', case_dir: `${WIN}\\p1\\s1` },
      { id: 's2', name: 'Climb', analysis_type: 'incompressible_steady', geometry_id: 'g1', time_dependency: 'Steady-state' },
      { id: 's3', name: 'Plate flow', analysis_type: 'incompressible_steady', geometry_id: 'g2', time_dependency: 'Steady-state' },
    ],
    active_study: 's1',
    meta: {
      g1: {
        bodies: ['Body1', 'Body2'],
        body_info: [{ ref: 'Body2', label: 'Core' }],
        n_solids: 2,
        step_path: `${WIN}\\p1\\wing.step`,
        faces_vtp: `${WIN}\\p1\\faces.vtp`,
        bounds: { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 },
        center_of_mass: [0.5, 0.5, 0.5],
        faces_length_unit: 'mm',
        faces: [
          { id: 1, body: 1, area: 1, centroid: [0, 0, 0], normal: [1, 0, 0], surface_type: 'Plane', label: 'Inlet face' },
          { id: 2, body: 1, area: 1, centroid: [1, 0, 0], normal: [-1, 0, 0], surface_type: 'Plane' },
          { id: 3, body: 1, area: 1, centroid: [0.5, 0.5, 0], normal: [0, 0, 1], surface_type: 'Plane', shared_with: 4 },
          { id: 4, body: 2, area: 1, centroid: [0.5, 0.5, 0], normal: [0, 0, -1], surface_type: 'Plane', shared_with: 3 },
          { id: 5, body: 2, area: 2, centroid: [0.5, 0.5, 1], normal: [0, 0, 1], surface_type: 'Plane' },
        ],
      },
      g2: { bodies: ['Body1'], faces: [{ id: 1, area: 1 }], bounds: {} },
    },
    materials: [
      { id: 'mat-1', name: 'Air', preset: 'air', material_model: 'newtonian_incompressible', nu: 1.5e-5, rho: 1.2, kinematic_viscosity: 1.5e-5, density: 1.2, assigned_volumes: ['Body1'], materials_json: `${WIN}\\x.json` },
      { id: 'mat-2', name: 'Water', preset: 'water', material_model: 'newtonian_incompressible', nu: 1e-6, rho: 998, assigned_volumes: ['Body2'] },
    ],
    bcs: [
      { id: 'bc-1', name: 'Inlet', bc_type: 'Velocity inlet', faces: ['face 1@Body1'], velocity_type: 'Fixed', value: 5, unit: 'm/s', direction: 'Normal to face', boundary_conditions_json: `${WIN}\\b.json` },
      { id: 'bc-2', name: 'Outlet', bc_type: 'Pressure', faces: ['face 2@Body1'], value: 0 },
    ],
    bc_defaults: { wall_type: 'No-slip' },
    meshes: [
      { id: 'm1', name: 'Mesh 1', generated: true, status: 'done', n_cells: 1200, n_points: 1500, case_dir: `${WIN}\\m1`, settings: { name: 'Mesh 1', fineness: 5, automatic_boundary_layers: true, advanced: { mesh_engine: 'standard', gap_refinement_factor: 0.05 }, mesher_settings: {} } },
      { id: 'm2', name: 'Mesh 2', generated: false, status: null, settings: { name: 'Mesh 2', fineness: 3, advanced: { mesh_engine: 'cfmesh' } } },
    ],
    refinements: [{ id: 'ref-1', name: 'Nose', type: 'Surface custom sizing', mesh_id: 'm1', faces: ['face 1@Body1'], sizing: 'Custom', default_size: 2, default_size_unit: 'mm' }],
    runs: [
      {
        id: 'r1',
        name: 'Run 1',
        status: 'done',
        mesh_id: 'm1',
        case_dir: `${WIN}\\p1\\s1\\r1`,
        log_path: `${WIN}\\log.txt`,
        endTime: 200,
        writeInterval: 50,
        time_dependency: 'Steady-state',
        iteration: 200,
        has_results: true,
        n_saved_times: 4,
        cores: 4,
        transient: { end_time: 2, write_count: 20 },
        result_controls: [{ id: 'rc-1', name: 'Area average 1', monitor_type: 'area_average', faces: ['face 1@Body1'] }],
        views: [{ id: 'v1', name: 'Side' }],
        residuals: Array.from({ length: 300 }, (_, i) => ({ t: i + 1, Ux: 1 / (i + 1), p: 2 / (i + 1) })),
        settle: { id: 'rc-1', source: 'monitor', window: 50 },
      },
      { id: 'r2', name: 'Run 2', status: 'draft', mesh_id: 'm1', endTime: 100, writeInterval: 10, result_controls: [] },
    ],
    active_run: 'r1',
    plugins: [
      {
        key: 'cad',
        name: 'Magnusim CAD',
        version: '0.2.0',
        enabled: true,
        python_env: null,
        start_actions: [{ study_kind: 'part', kind_title: 'Part', workspace: 'part', label: 'New Part' }],
        geometry_actions: [{ study_kind: 'part', kind_title: 'Part', workspace: 'part', label: 'Edit in CAD' }],
        samples: [{ key: 'bracket', title: 'Bracket', hint: '' }],
        root: WIN,
      },
      { key: 'heat_transfer', name: 'Heat Transfer', version: '0.1.0', enabled: false, python_env: { state: 'ready' } },
    ],
    plugin_studies: [{ id: 'cs1', plugin: 'cad', plugin_name: 'Magnusim CAD', kind: 'part', title: 'Plate', rev: 3, available: true, read_only: false }],
    queue: { ok: true, items: [{ id: 'q-1', kind: 'solve', project_id: 'p2', run_id: 'rx', name: 'Other run', position: 1 }], live: null, busy: null },
    prefs: { ok: true, units: 'Metric', hardware: { physical_cores: 8, logical_cpus: 16, ram_gb: 32, openfoam_ok: true, checked_at: '2026-10-20T10:00:00Z' }, wsl_case_root: '/home/someone/cases' },
  };
}

const json = (status, body) => ({ status, body });

/** The default answers, from `w`. */
function answer(w, method, path, q, body) {
  const sim = q.get('simulation_id') || (body && body.simulation_id) || w.active_study;
  if (method === 'GET') {
    switch (path) {
      case '/api/projects':
        return { ok: true, projects: w.projects, folders: w.folders, active_project_id: 'p2', projects_root: WIN };
      case '/api/project':
        if (q.get('project_id') === 'p1') return { ok: true, project: w.project, projects_root: WIN };
        // Another project of the list: an empty one.
        return w.projects.some((p) => p.id === q.get('project_id')) ? { ok: true, project: { id: q.get('project_id'), geometries: [] } } : json(404, { error: 'project not found' });
      case '/api/simulation': {
        const want = q.get('simulation_id');
        const one = w.studies.find((s) => s.id === (want || w.active_study)) || null;
        return { ok: true, simulation: one, simulations: w.studies, active_id: want || w.active_study, simulation_json: `${WIN}\\sims.json` };
      }
      case '/api/plugin-studies':
        return { ok: true, studies: w.plugin_studies, kinds: [] };
      case '/api/plugins':
        return { ok: true, plugins: w.plugins };
      case '/api/prefs':
        return w.prefs;
      case '/api/registry':
        return REGISTRY;
      case '/api/compute-queue':
        return w.queue;
      case '/api/run/ready':
        return { ok: true, ready: false, issues: [{ message: 'Pick a material.', fix: { go: 'material' } }] };
      case '/api/materials':
        return { ok: true, materials: w.materials, materials_json_path: `${WIN}\\m.json` };
      case '/api/bcs':
        return { ok: true, boundary_conditions: w.bcs, boundary_conditions_all: w.bcs, defaults: w.bc_defaults, boundary_conditions_json_path: `${WIN}\\b.json` };
      case '/api/mesh': {
        const want = q.get('mesh_id');
        const active = want && w.meshes.some((m) => m.id === want) ? want : w.meshes[0] ? w.meshes[0].id : null;
        const mesh = w.meshes.find((m) => m.id === active) || null;
        return { ok: true, mesh, meshes: w.meshes, meshes_all: w.meshes, active_id: active, mesh_json_path: `${WIN}\\mesh.json` };
      }
      case '/api/mesh/refinements':
        return { ok: true, refinements: w.refinements, mesh_refinements_json_path: `${WIN}\\r.json` };
      case '/api/run/status': {
        const want = q.get('run_id');
        const id = want || w.active_run;
        const run = w.runs.find((r) => r.id === id) || null;
        return { ok: true, run, runs: w.runs, runs_all: w.runs, active_run_id: want || w.active_run, live_run: null, meshes: [] };
      }
      case '/api/run/monitors':
        return { ok: true, run_id: q.get('run_id'), status: 'done', transient: false, monitors: [{ name: 'Area average 1', rows: Array.from({ length: 500 }, (_, i) => ({ t: i, p: i })), file: `${WIN}\\mon.dat` }], custom: [], summary: { p: 1 } };
      case '/api/geometry/cad': {
        const m = w.meta[q.get('geometry_id') || 'g1'];
        return m ? m : json(404, { error: 'geometry not found' });
      }
      case '/api/geometry/face-map':
        return { ok: true, map: { 'face 1@Body1': 'face 1@Body1' } };
      case '/api/geometry/lost-faces':
        return { ok: true, linked: true, rev: 4, entries: [{ studyId: 's3', studyTitle: 'Plate flow', kind: 'bc', id: 'bc-9', name: 'Wall', field: 'faces', old: ['face 7@Body1'], reason: 'gone' }] };
      case '/api/plugin-geometry/linked':
        return { ok: true, linked: { geometryId: 'g2', rev: 4, state: 'ok', lostFaces: 1 } };
      case '/api/plugin-geometry/status':
        return q.get('job_id') === 'gl-1' ? { ok: true, job: { id: 'gl-1', status: 'choosing', geometryId: 'g2', geometryName: 'Plate' } } : json(404, { ok: false, code: 'not_found', error: 'not found' });
      case '/api/times':
        return { case_dir: q.get('case'), times: ['50', '100', '150', '200'], fields_available: ['U', 'p'] };
      case '/api/fields/p/meta':
        return { case_dir: q.get('case'), source_vtu: `${WIN}\\x.vtu`, time: q.get('time'), field: 'p', foam_proof: { min: -1, max: 2, mean: 0.5 }, result_fields: [{ key: 'p', unit: 'Pa' }] };
      case '/api/fields/p/series-range':
        return { ok: true, min: -3, max: 4, case_dir: q.get('case') };
      case '/api/inspect':
        return { hit: true, values: { p: 1.5, U: [1, 0, 0] }, case_dir: q.get('case'), source_vtu: `${WIN}\\x.vtu` };
      case '/api/plot-over-path':
        return { field_name: 'p', distances: [0, 0.5, 1], values: [1, 2, 3], sample_points: [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]], value_min: 1, value_max: 3, value_mean: 2, reason: 'ok', case_dir: q.get('case') };
      case '/api/media/list':
        return { ok: true, items: [{ id: 'md1', kind: 'screenshot', name: 'Side', width: 800, height: 600, url: '/api/media/file?x', file: `${WIN}\\a.png` }] };
      case '/api/geometry/thumb':
        return w.thumb ? { raw: w.thumb } : json(202, { ok: false, pending: true });
      default:
        if (path.startsWith('/api/filter/')) return { ok: true, value: 3, label: 'ok', case_dir: q.get('case') };
        return json(404, { error: 'route not found' });
    }
  }
  // Writes answer as the real routes do, enough for the tools to read back.
  switch (path) {
    case '/api/simulation':
      return json(201, { ok: true, simulation: { id: 's-new', name: 'Incompressible Steady-state', analysis_type: 'incompressible_steady' }, simulations: w.studies });
    case '/api/simulation/update':
    case '/api/simulation/activate':
    case '/api/simulation/reorder':
    case '/api/simulation/delete':
      return { ok: true, simulation: w.studies[0], simulations: w.studies };
    case '/api/run/create':
      return { ok: true, run: { id: 'r-new', name: (body && body.name) || 'Run 3' } };
    case '/api/run/update':
      return { ok: true, run: { ...(w.runs.find((r) => r.id === body.run_id) || {}), rev: 7 } };
    case '/api/bcs':
      if (body && body.delete) return { ok: true, deleted: true };
      if (body && body.defaults) return { ok: true, defaults: body.defaults };
      return { ok: true, bc: { id: body.id || 'bc-new', name: body.name || 'Velocity inlet 1', bc_type: body.bc_type, faces: body.faces, rev: 1 } };
    case '/api/mesh/refinements':
      if (body && body.copy_from_mesh) return { ok: true, copied: true, copied_count: 1, lost_faces: [] };
      if (body && body.delete) return { ok: true, deleted: true };
      return { ok: true, refinement: { id: body.id || 'ref-new', name: body.name || 'Surface custom sizing 1', type: body.type, mesh_id: body.mesh_id, faces: body.faces } };
    case '/api/mesh':
      if (body && body.create) {
        // As the app's route: the new mesh joins the study's list, with the default settings.
        const made = { id: 'm-new', name: body.name || 'Mesh 3', generated: false, status: null, rev: 1, settings: { name: body.name || 'Mesh 3', fineness: 5, advanced: { mesh_engine: 'standard' } } };
        w.meshes = [...w.meshes.filter((m) => m.id !== made.id), made];
        return { ok: true, mesh: made, active_id: made.id };
      }
      return { ok: true, saved: true };
    case '/api/worker':
      if (body && body.method === 'materials.set') return { ok: true, materials: body.params.body.materials.map((m) => ({ ...m, rev: 2 })) };
      if (body && body.method === 'bc.menu') return { ok: true, menu: [{ key: 'inlet', label: 'Inlet', variants: [{ key: 'velocity', label: 'Velocity' }] }] };
      return json(400, { error: 'method not allowed' });
    case '/api/project':
      return json(201, { ok: true, id: 'p-new', title: body.title, projects_root: WIN });
    case '/api/project/sample':
      return json(201, { ok: true, id: 'p-sample', title: 'Bracket' });
    case '/api/plugin-studies/create':
      return { ok: true, study: { id: 'ps-new', title: body.title, plugin: body.plugin, workspace: 'part' } };
    case '/api/geometry/import':
      return { ok: true, added: { id: 'geom-new', name: 'bracket', representation: 'step', n_faces: 12 }, geometry: { bodies: ['Body1'] }, project: { step_path: `${WIN}\\x` } };
    case '/api/geometry/original/import':
      return { ok: true, added: { id: 'geom-orig', name: 'Plate original' } };
    case '/api/geometry-actions/open':
      return { ok: true, plugin: 'cad', study_id: 'cs-edit', workspace: 'part', created: true, title: 'Wing (CAD)' };
    case '/api/plugin-geometry/choose':
      return json(202, { ok: true, job_id: body.job_id, geometry_id: 'g2' });
    default:
      return { ok: true };
  }
}

/** Starts the stand-in; `over(method, path, query, body)` may answer first (return undefined to fall through). */
export async function startFakeApp({ w = world(), over = null } = {}) {
  const seen = [];
  let override = over;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = [];
    for await (const c of req) parts.push(c);
    const raw = Buffer.concat(parts);
    const type = String(req.headers['content-type'] || '');
    let body = null;
    if (type.includes('application/json') && raw.length) body = JSON.parse(raw.toString('utf8'));
    const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, bytes: type.includes('octet-stream') ? raw : null, headers: { ...req.headers } };
    seen.push(rec);
    let a = override ? override(req.method, url.pathname, url.searchParams, body, rec) : undefined;
    if (a === undefined) a = answer(w, req.method, url.pathname, url.searchParams, body);
    if (a && a.raw) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': a.raw.length });
      res.end(a.raw);
      return;
    }
    const status = a && typeof a.status === 'number' && 'body' in a ? a.status : 200;
    const out = a && typeof a.status === 'number' && 'body' in a ? a.body : a;
    const headers = { 'content-type': 'application/json' };
    if (a && a.headers) Object.assign(headers, a.headers);
    res.writeHead(status, headers);
    res.end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    w,
    seen,
    port: server.address().port,
    set over(fn) {
      override = fn;
    },
    /** The requests from index `from` on, writes only (anything not a GET). */
    writes(from = 0) {
      return seen.slice(from).filter((r) => r.method !== 'GET' && !(r.body && r.body.method === 'bc.menu') && r.path !== '/api/run/transient-preview');
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/** A tool run context for the open project "p1" in the workbench. */
export function makeRt(o = {}) {
  const { ctx = {}, ...rest } = o;
  return {
    signal: new AbortController().signal,
    ctx: { tab: null, projectId: 'p1', simulationId: 's1', cloud: true, local: false, ...ctx },
    turn: 't-1',
    progress() {},
    ...rest,
  };
}

/** Every string in `v` (deep), for path scans. */
export function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.push(k), strings(x, out));
  return out;
}

/** True when `v` holds no path-like string or key. */
export function pathFree(v) {
  return strings(v).every((s) => !/[A-Za-z]:\\|\/home\/|(step|log|original|stl|json)_path|case_dir|faces_vtp|projects_root|thumb_url/.test(s));
}
