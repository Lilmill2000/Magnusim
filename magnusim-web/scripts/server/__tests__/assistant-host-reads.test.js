// The read host tools against a stand-in for the app (Core host tools spec 4.1-4.7, 16.1):
// catalog (every kind, and a key's fields), projects (Home's filters; the list sent to a
// cloud provider only when allowed), project_summary (another project's consent; its
// picture), read_setup (every what; inside faces marked; no path in any answer) and
// read_results (every kind; the case folder passed to the results routes and never
// returned; the server-wide attached case never set).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-reads-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { createHostTools } = await import('../assistant/host-tools.ts');
const { createHostTransport } = await import('../assistant/host-call.ts');
const { paced } = await import('../assistant/host/common.ts');
const { resultText } = await import('../assistant/sanitize.ts');
const { startFakeApp, makeRt, pathFree, world, WIN } = await import('./assistant-host-harness.js');

let app;
// The calls' rate runs on this clock: a call that waits for its slot moves it on, never the test's time.
let fakeNow = 0;
before(async () => {
  app = await startFakeApp();
});
after(async () => {
  await app.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

function tools(o = {}) {
  const list = createHostTools({
    hostCall: paced(createHostTransport({ port: () => app.port, now: () => fakeNow }).call, async (ms) => { fakeNow += ms; }),
    assistant: async () => ({ provider: 'anthropic', model: 'm' }),
    version: async () => '0.5.0',
    plugins: () => [],
    assistantSettings: async () => ({ effort: 'default', privacy: o.privacy ?? 'ask', caps: { turn_usd: 8 }, provider_log: o.providerLog ?? false }),
    spentToday: async () => 1.234,
    ...o,
  });
  return Object.fromEntries(list.map((t) => [t.name, t]));
}
const rt = makeRt;
const fresh = () => {
  app.w = Object.assign(app.w, world());
  app.over = null;
};
async function ok(tool, input, r = rt()) {
  const out = await tools()[tool].run(input, r);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(pathFree(out.data), `${tool}: a path in ${resultText(tool, out)}`);
  return out.data;
}

describe('app_status', () => {
  it('the Assistant\'s own settings read only, today\'s spend, hardware and units; nothing writes them', async () => {
    fresh();
    const d = await ok('app_status', {});
    assert.deepEqual(d.assistant, { provider: 'anthropic', model: 'm', effort: 'default', privacy: 'ask', caps: { turn_usd: 8 }, provider_log: false, spent_today_usd: 1.23, can_change_these: false });
    assert.deepEqual(d.hardware, { cores: 8, ram_gb: 32, openfoam: 'ok', checked_at: '2026-10-20T10:00:00Z' });
    assert.equal(d.units, 'Metric');
    assert.deepEqual(d.plugins.map((p) => [p.key, p.on, p.env]), [
      ['cad', true, 'none'],
      ['heat_transfer', false, 'ready'],
    ]);
    // Another project's queued run: its kind and place only.
    assert.deepEqual(d.compute.queue, [{ kind: 'solve', mine: false, position: 1 }]);
    assert.equal(d.where, 'workbench');
  });
  it('whether the provider log for a problem report is on (the person switches it; app_status reads it)', async () => {
    fresh();
    const d = await tools({ assistantSettings: async () => ({ effort: 'default', privacy: 'ask', caps: { turn_usd: 8 }, provider_log: true }) }).app_status.run({}, rt());
    assert.equal(d.ok, true);
    assert.deepEqual([d.data.assistant.provider_log, d.data.assistant.can_change_these], [true, false]);
  });
  it("this turn's spend and caps so far, read when asked (read-only; none outside a turn)", async () => {
    fresh();
    let use = { steps: 4, steps_cap: 120, minutes: 2.1, minutes_cap: 60, usd: 0.12, usd_cap: 8 };
    const r = rt({ ctx: { used: () => use } });
    let d = await ok('app_status', {}, r);
    assert.deepEqual(d.assistant.this_turn, { steps: 4, steps_cap: 120, minutes: 2.1, minutes_cap: 60, usd: 0.12, usd_cap: 8 });
    assert.equal(d.assistant.can_change_these, false);
    use = { ...use, steps: 5 };
    d = await ok('app_status', {}, r);
    assert.equal(d.assistant.this_turn.steps, 5, 'read at the call, not when the turn began');
    d = await ok('app_status', {}, rt({ ctx: { used: () => { throw new Error('gone'); } } }));
    assert.equal(d.assistant.this_turn, undefined);
  });
});

describe('app_status with_projects', () => {
  it("names another project's running and queued jobs only when asked, and asks for that by the project list's question (seen live: a mesh it could not stop from Home)", async () => {
    fresh();
    app.w.queue = {
      ...app.w.queue,
      busy: { kind: 'mesh', project_id: 'p2', project_title: 'Other project', mesh_id: 'm9', mesh_name: 'Fine mesh' },
    };
    const home = rt({ ctx: { projectId: null } });
    let d = await ok('app_status', { with_projects: false }, home);
    assert.deepEqual(d.compute.live, { kind: 'mesh', mine: false });
    assert.deepEqual(d.compute.queue, [{ kind: 'solve', mine: false, position: 1 }]);
    d = await ok('app_status', { with_projects: true }, home);
    assert.deepEqual(d.compute.live, { kind: 'mesh', mine: false, project_id: 'p2', project_title: 'Other project', name: 'Fine mesh' });
    assert.deepEqual(d.compute.queue, [{ kind: 'solve', mine: false, position: 1, id: 'q-1', project_id: 'p2', project_title: '', name: 'Other run' }]);
    // The runner asks the project list's question first (LIST_CONSENT_KEY) only for with_projects.
    const t = tools().app_status;
    assert.equal(t.projectOf({ with_projects: true }), '*projects');
    assert.equal(t.projectOf({ with_projects: false }), null);
  });
});

describe('field units', () => {
  it("a field with a quantity and no unit says its SI unit (a temperature in K); a value with its own unit field names that field (seen live: a wall temperature with no unit)", async () => {
    const { flattenSchema } = await import('../assistant/host/common.ts');
    const fields = flattenSchema({
      properties: {
        wall_temperature: { type: 'number', title: 'Wall temperature', 'x-cfddesk': { quantity: 'temperature' } },
        wall_htc: { type: 'number', title: 'Heat transfer coefficient', 'x-cfddesk': { quantity: 'heat_transfer_coefficient' } },
        size: { type: 'number', title: 'Size', 'x-cfddesk': { unit: 'mm', quantity: 'length' } },
        note: { type: 'string', title: 'Note' },
      },
    });
    assert.deepEqual(Object.fromEntries(fields.map((f) => [f.key, f.unit])), { wall_temperature: 'K', wall_htc: 'W/(m²·K)', size: 'mm', note: '' });
  });
});

describe('catalog', () => {
  const cat = (kind, key = '') => ok('catalog', { kind, key });
  it('every kind lists; a key gives that item\'s fields', async () => {
    fresh();
    const a = await cat('analyses');
    assert.ok(a.analyses.some((x) => x.key === 'incompressible_steady'));
    const one = await cat('analyses', 'incompressible_steady');
    assert.ok(one.settings.some((f) => f.key === 'turbulence_model' && f.enum.includes('kOmegaSST')));
    assert.ok(one.run_settings.some((f) => f.key === 'endTime'));
    assert.ok(one.run_settings.some((f) => f.key === 'transient.end_time' && f.unit === 's'));
    const bc = await cat('bc_types');
    assert.ok(bc.types.some((t) => t.type === 'Velocity inlet'));
    assert.deepEqual(bc.menu[0].key, 'inlet');
    const inlet = await cat('bc_types', 'Velocity inlet');
    assert.ok(inlet.fields.some((f) => f.key === 'velocity_type'));
    assert.ok(inlet.units.some((u) => u.field === 'value' && u.unit_field === 'unit'));
    const mats = await cat('materials');
    assert.ok(mats.presets.some((p) => p.key === 'air'));
    const air = await cat('materials', 'air');
    assert.deepEqual([air.model, air.values.rho], ['newtonian_incompressible', 1.204]);
    assert.ok((await cat('meshers')).meshers.some((m) => m.key === 'standard'));
    const ms = await cat('mesh_settings', 'standard');
    assert.ok(ms.fields.some((f) => f.key === 'advanced.mesh_engine' && f.enum.includes('cfmesh')));
    assert.deepEqual((await cat('refinement_types')).types, ['Surface custom sizing', 'Inflate boundary layer']);
    assert.ok((await cat('refinement_types', 'Inflate boundary layer')).fields.some((f) => f.key === 'n_layers'));
    assert.ok((await cat('monitors')).monitors.some((m) => m.key === 'probe' && m.target === 'point'));
    assert.match((await cat('monitors', 'probe')).places, /points/);
    assert.ok((await cat('filters')).filters.some((f) => f.key === 'cut_plane'));
    assert.ok((await cat('filters', 'cut_plane')).fields.length > 0);
    assert.deepEqual((await cat('study_kinds')).study_kinds.map((k) => [k.plugin, k.key, k.edits_geometry]), [
      ['cad', 'part', false],
      ['cad', 'part', true],
    ]);
    assert.deepEqual((await cat('start_actions')).start_actions.map((k) => k.key), ['part']);
    assert.deepEqual((await cat('samples')).samples.map((k) => [k.plugin, k.key]), [['cad', 'bracket']]);
    assert.deepEqual((await cat('plugins')).plugins.map((p) => [p.key, p.on]), [
      ['cad', true],
      ['heat_transfer', false],
    ]);
  });
  it('an unknown key is not_found, with the way to list', async () => {
    const out = await tools().catalog.run({ kind: 'analyses', key: 'nope' }, rt());
    assert.deepEqual([out.ok, out.error.code], [false, 'not_found']);
    assert.match(out.error.hint, /catalog/);
  });
});

describe('projects', () => {
  it("Home's filters: folder, search over title and description, sort, limit; never the projects folder", async () => {
    fresh();
    const r = rt({ ctx: { cloud: false, local: true } });
    const all = await tools().projects.run({ folder: '', search: '', sort: 'modified', limit: 0 }, r);
    assert.deepEqual(all.data.projects.map((p) => p.id), ['p2', 'p1', 'p3']);
    assert.deepEqual(all.data.folders, ['My Projects', 'Aero']);
    assert.ok(!JSON.stringify(all).includes('thumb') && !JSON.stringify(all).includes(WIN));
    const aero = await tools().projects.run({ folder: 'Aero', search: '', sort: 'name', limit: 0 }, r);
    assert.deepEqual(aero.data.projects.map((p) => p.title), ['Duct', 'Wing']);
    const found = await tools().projects.run({ folder: '', search: 'TUNNEL', sort: 'name', limit: 0 }, r);
    assert.deepEqual(found.data.projects.map((p) => p.id), ['p1']);
    const one = await tools().projects.run({ folder: '', search: '', sort: 'name', limit: 1 }, r);
    assert.deepEqual([one.data.projects.length, one.data.total], [1, 3]);
  });
  it('names the project list for its privacy question: the runner asks it once per destination before the call', async () => {
    assert.equal(tools().projects.projectOf({}, rt().ctx), '*projects');
    // Reached here, the runner allowed it.
    const sent = await tools().projects.run({ folder: '', search: '', sort: 'name', limit: 0 }, rt());
    assert.equal(sent.ok, true);
  });
});

describe('project_summary', () => {
  it('another project is named for its own privacy question (the runner asks it first); this one is read as is', async () => {
    fresh();
    const other = await tools().project_summary.run({ project_id: 'p2', with_thumbnail: false }, rt());
    assert.equal(other.ok, true);
    assert.equal(tools().project_summary.projectOf({ project_id: 'p2' }, rt().ctx), 'p2');
    assert.equal(tools().project_summary.projectOf({ project_id: '' }, rt().ctx), 'p1');
    const mine = await ok('project_summary', { project_id: '', with_thumbnail: false });
    assert.deepEqual(mine.geometries.map((g) => [g.id, g.linked, g.active]), [
      ['g1', false, true],
      ['g2', true, false],
    ]);
    assert.deepEqual(mine.plugin_studies, [{ id: 'cs1', plugin: 'cad', kind: 'part', title: 'Plate' }]);
  });
  it('with_thumbnail: the picture as an image; a picture still being made is "not ready"', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    app.w.thumb = png;
    const out = await tools().project_summary.run({ project_id: '', with_thumbnail: true }, rt());
    assert.equal(out.images.length, 1);
    assert.deepEqual([out.images[0].mediaType, out.images[0].width], ['image/png', 1]);
    app.w.thumb = null;
    const later = await tools().project_summary.run({ project_id: '', with_thumbnail: true }, rt());
    assert.equal(later.images, undefined);
    assert.equal(later.data.thumbnail, 'not ready');
  });
});

describe('read_setup', () => {
  const read = (what, more = {}) => ok('read_setup', { project_id: '', simulation_id: '', what, id: '', other_id: '', page: 0, ...more });
  it('every what, as the panels show it, no path anywhere', async () => {
    fresh();
    const study = await read('study');
    assert.deepEqual([study.id, study.analysis, study.settings.turbulence_model, study.active], ['s1', 'incompressible_steady', 'kOmegaSST', true]);
    const mats = await read('materials');
    assert.deepEqual(mats.materials[0], { id: 'mat-1', name: 'Air', preset: 'air', material_model: 'newtonian_incompressible', role: 'fluid', properties: { nu: 1.5e-5, rho: 1.2 }, bodies: ['Body1'] });
    const bcs = await read('bcs');
    assert.deepEqual(bcs.bcs[0], { id: 'bc-1', name: 'Inlet', type: 'Velocity inlet', faces: ['face 1@Body1'], values: { velocity_type: 'Fixed', value: 5, unit: 'm/s', direction: 'Normal to face' } });
    assert.deepEqual(bcs.defaults, { wall_type: 'No-slip' });
    const meshes = await read('meshes');
    assert.deepEqual(meshes.meshes.map((m) => [m.id, m.engine, m.generated.status, m.generated.cells, m.active]), [
      ['m1', 'standard', 'done', 1200, true],
      ['m2', 'cfmesh', 'not generated', null, false],
    ]);
    const mesh = await read('mesh', { id: 'm1' });
    assert.deepEqual([mesh.settings.fineness, mesh.settings['advanced.mesh_engine'], mesh.settings.automatic_boundary_layers], [5, 'standard', true]);
    const refs = await read('refinements', { id: 'm1' });
    assert.deepEqual(refs.refinements[0].values, { sizing: 'Custom', default_size: 2, default_size_unit: 'mm' });
    // Its mesh is Standard's: the refinement editor's note under Refine out to (src/panels/mesh/reach.ts).
    assert.equal(refs.refinements[0].note, 'Standard ignores Refine out to: it sizes these faces only. Hex-dominant refines the cells out to this distance.');
    assert.deepEqual((await read('refinements', { id: 'm2' })).refinements, []);
    const runs = await read('runs');
    assert.deepEqual(runs.runs.map((r) => [r.id, r.status, r.active]), [
      ['r1', 'done', true],
      ['r2', 'draft', false],
    ]);
    const run = await read('run', { id: 'r1' });
    assert.deepEqual([run.endTime, run.cores, run.monitors[0].type, run.views[0].name, run.has_results], [200, 4, 'area_average', 'Side', true]);
    const geom = await read('geometry');
    assert.deepEqual([geom.id, geom.bodies, geom.faces, geom.inside_faces, geom.linked, geom.geometry_rev], ['g1', 2, 5, 2, false, null]);
    const linkedGeom = await read('geometry', { id: 'g2' });
    assert.deepEqual([linkedGeom.linked, linkedGeom.geometry_rev], [true, 4]);
    const bodies = await read('bodies');
    assert.deepEqual(bodies.bodies, [
      { name: 'Body1', index: 1 },
      { name: 'Body2', index: 2, label: 'Core' },
    ]);
    const faces = await read('faces');
    assert.equal(faces.total, 5);
    assert.deepEqual(faces.faces[0], { id: 'face 1@Body1', name: 'Inlet face', body: 'Body1', area: 1, normal: [1, 0, 0], centroid: [0, 0, 0], surface: 'Plane', inside: false });
    assert.deepEqual([faces.faces[2].inside, faces.faces[2].shared_with], [true, 'face 4@Body2']);
    const map = await read('face_map', { other_id: 'g2' });
    assert.deepEqual(map.map, { 'face 1@Body1': 'face 1@Body1' });
    const lost = await read('lost_faces', { id: 'g2' });
    assert.deepEqual(lost.entries[0], { study_id: 's3', study: 'Plate flow', kind: 'bc', id: 'bc-9', name: 'Wall', field: 'faces', faces: ['face 7@Body1'], reason: 'gone' });
    const linked = await read('linked');
    assert.deepEqual(linked.linked, [{ geometry_id: 'g2', name: 'Plate', plugin: 'cad', study_id: 'cs1', state: 'lost_faces', lost: 1, rev: 4 }]);
    const ps = await read('plugin_study', { id: 'cs1' });
    assert.deepEqual([ps.plugin, ps.rev, ps.available], ['cad', 3, true]);
  });
  it("a mesh's quality as the Mesh panel shows it (RH2): checkMesh's worst cells, failed checks and the panel's lines; null when not known", async () => {
    fresh();
    assert.equal((await read('mesh', { id: 'm1' })).quality, null);
    app.w.meshes[0].live_mesh_result = {
      status: 'done',
      n_cells: 1200,
      case_dir: `${WIN}\m1`,
      quality: {
        known: true,
        ok: false,
        n_failed: 1,
        max_non_orthogonality: 72.64597596,
        severe_non_orthogonal_faces: 750,
        max_skewness: 8.000000342,
        skewed_faces: 22,
        max_aspect_ratio: 38.02406827,
        failed: [{ check: 'skewness', count: 22, unit: 'faces', accepted: true }],
      },
    };
    const mesh = await read('mesh', { id: 'm1' });
    assert.deepEqual(mesh.quality, {
      max_non_orthogonality: 72.64597596,
      max_skewness: 8.000000342,
      max_aspect_ratio: 38.02406827,
      n_failed: 1,
      failed: [{ check: 'skewness', count: 22, unit: 'faces' }],
      lines: ['Worst cells: 73° non-orthogonal, skewness 8.0, aspect ratio 38', 'checkMesh failed 1 check: 22 highly skewed faces.'],
    });
    // A record with the worst cells as top-level keys (the older shape) still reads.
    app.w.meshes[0].live_mesh_result = { status: 'done', n_cells: 1200, max_non_ortho: 78.2, max_skewness: 3.84, n_faces: 9000 };
    assert.deepEqual((await read('mesh', { id: 'm1' })).quality.lines, ['Worst cells: 78° non-orthogonal, skewness 3.8']);
    app.w.meshes[0].live_mesh_result = { status: 'done', n_cells: 1200, quality: { known: false } };
    assert.equal((await read('mesh', { id: 'm1' })).quality, null);
  });
  it("One cell across (2D) on: the Mesh panel's note under it, from the same answer (GET /api/mesh/two-d); off: not asked", async () => {
    fresh();
    const asked = () => app.seen.filter((r) => r.path === '/api/mesh/two-d').length;
    const before = asked();
    assert.equal((await read('mesh', { id: 'm1' })).two_d, undefined);
    assert.equal(asked(), before);
    app.w.meshes[0].settings = { name: 'Mesh 1', fineness: 4, advanced: { mesh_engine: 'snappy_hexdominant' }, mesher_settings: { one_cell_across: true } };
    let mesh = await read('mesh', { id: 'm1' });
    assert.equal(mesh.settings['mesher_settings.one_cell_across'], true);
    assert.deepEqual(mesh.two_d, {
      available: false,
      reason: 'No boundary condition is a Symmetry.',
      note: 'Not available on this part: No boundary condition is a Symmetry. Generate refuses until it is.',
    });
    app.w.two_d = {
      ok: true,
      available: true,
      two_d: { axis: 'z', depth_m: 0.01, cells_across: 1, front: { faces: ['Face 5@Body1'], bc: 'Sides', patch: 'sides' }, back: { faces: ['Face 3@Body1'], bc: 'Sides', patch: 'sides' } },
    };
    mesh = await read('mesh', { id: 'm1' });
    assert.deepEqual(mesh.two_d, {
      available: true,
      axis: 'z',
      depth_m: 0.01,
      cells_across: 1,
      front: { faces: ['Face 5@Body1'], bc: 'Sides' },
      back: { faces: ['Face 3@Body1'], bc: 'Sides' },
      note: '2D: one cell across, 10 mm deep along z, between Face 5@Body1 and Face 3@Body1 (Symmetry "Sides").',
    });
    // The check failed: said so, not available.
    app.w.two_d = { ok: false, error: 'FileNotFoundError: the study has no geometry' };
    mesh = await read('mesh', { id: 'm1' });
    assert.deepEqual(
      [mesh.two_d.available, mesh.two_d.error, mesh.two_d.note],
      [false, 'FileNotFoundError: the study has no geometry', "Couldn't check the part: FileNotFoundError: the study has no geometry"],
    );
    delete app.w.two_d;
    // A mesh generated one cell across: its row says so, as its summary in the Mesh panel does.
    app.w.meshes[0].live_mesh_result = { status: 'done', n_cells: 1769, one_cell_across: true, two_d: { axis: 'z', cells_across: 1 } };
    assert.equal((await read('meshes')).meshes[0].generated.one_cell_across, true);
    assert.equal((await read('meshes')).meshes[1].generated.one_cell_across, undefined);
  });
  it('faces page by 200; a preview still being made is waited for; an unknown id is not_found', async () => {
    fresh();
    app.w.meta.g1.faces = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, body: 1, area: 1 }));
    const p2 = await read('faces', { page: 2 });
    assert.deepEqual([p2.faces.length, p2.faces[0].id, p2.next_page], [50, 'face 401@Body1', undefined]);
    assert.equal((await read('faces', { page: 0 })).next_page, 1);
    let calls = 0;
    app.over = (m, path) => (path === '/api/geometry/cad' && (calls += 1) < 3 ? { status: 202, body: { ok: false, pending: true, code: 'preview_pending' } } : undefined);
    const labels = [];
    const waited = await tools().read_setup.run({ project_id: '', simulation_id: '', what: 'bodies', id: '', other_id: '', page: 0 }, rt({ progress: (_f, l) => labels.push(l) }));
    assert.equal(waited.ok, true);
    assert.deepEqual(labels, ["Waiting for the geometry's preview", "Waiting for the geometry's preview"]);
    app.over = null;
    const none = await tools().read_setup.run({ project_id: '', simulation_id: '', what: 'mesh', id: 'm9', other_id: '', page: 0 }, rt());
    assert.equal(none.error.code, 'not_found');
    const study = await tools().read_setup.run({ project_id: '', simulation_id: 's9', what: 'bcs', id: '', other_id: '', page: 0 }, rt());
    assert.equal(study.error.code, 'not_found');
  });
  it('project_id always passed; the study the call names, else the shown one', async () => {
    fresh();
    const from = app.seen.length;
    await read('bcs', { simulation_id: 's2' });
    const bcs = app.seen.slice(from).find((r) => r.path === '/api/bcs');
    assert.deepEqual([bcs.query.project_id, bcs.query.simulation_id], ['p1', 's2']);
    for (const r of app.seen.slice(from)) if (r.path !== '/api/registry' && r.path !== '/api/projects') assert.equal(r.query.project_id, 'p1', r.path);
  });
});

describe('read_results', () => {
  const res = (kind, more = {}) => ok('read_results', { project_id: '', simulation_id: '', run_id: '', kind, field: '', time: -1, points: [], samples: 0, filter_key: '', values: [], ...more });
  it('every kind; the case goes to the results routes and never comes back; /api/case/attach is never called', async () => {
    fresh();
    const from = app.seen.length;
    const st = await res('status');
    assert.deepEqual([st.run_id, st.status, st.iteration, st.end, st.cores, st.has_results], ['r1', 'done', 200, 200, 4, true]);
    const resid = await res('residuals');
    assert.equal(resid.series.Ux.length, 200);
    assert.deepEqual(resid.last, { Ux: 1 / 300, p: 2 / 300 });
    const mon = await res('monitors');
    assert.equal(mon.monitors[0].rows.length, 200);
    const times = await res('times');
    assert.deepEqual(times.times, ['50', '100', '150', '200']);
    const range = await res('field_range', { field: 'p' });
    assert.deepEqual(range, { field: 'p', time: '200', min: -1, max: 2, mean: 0.5, unit: 'Pa', over_all_times: { min: -3, max: 4 } });
    const pts = await res('point', { field: 'p', points: [[0, 0, 0], [1, 1, 1]] });
    assert.deepEqual(pts.points[0], { x: 0, y: 0, z: 0, values: { p: 1.5, U: [1, 0, 0] }, inside: true });
    const line = await res('line', { field: 'p', points: [[0, 0, 0], [1, 0, 0]], samples: 50 });
    assert.deepEqual(line.samples[1], { s: 0.5, x: 0.5, y: 0, z: 0, value: 2 });
    const filt = await res('plugin_filter', { filter_key: 'cut_plane', values: [{ key: 'orientation', value: '"X"' }] });
    assert.deepEqual(filt.answer, { ok: true, value: 3, label: 'ok' });
    const media = await res('media');
    assert.deepEqual(media.items, [{ id: 'md1', kind: 'screenshot', name: 'Side', width: 800, height: 600, duration_s: null, created_at: null }]);
    assert.deepEqual((await res('exports')).exports, []);
    const reqs = app.seen.slice(from);
    assert.ok(!reqs.some((r) => r.path === '/api/case/attach'));
    const caseReads = reqs.filter((r) => ['/api/times', '/api/fields/p/meta', '/api/inspect', '/api/plot-over-path', '/api/fields/p/series-range'].includes(r.path) || r.path.startsWith('/api/filter/'));
    assert.ok(caseReads.length >= 6);
    for (const r of caseReads) assert.deepEqual([r.query.case, r.query.project_id], [`${WIN}\\p1\\s1\\r1`, 'p1'], r.path);
    const line2 = reqs.find((r) => r.path === '/api/plot-over-path');
    assert.deepEqual([line2.query.points, line2.query.subdivisions, line2.query.time], ['0,0,0;1,0,0', '50', '200']);
    const filter = reqs.find((r) => r.path === '/api/filter/cut_plane');
    assert.equal(filter.query.orientation, 'X');
  });
  it('a run with no results says so; a time not saved, a bad value, a missing run are refused', async () => {
    fresh();
    const draft = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: 'r2', kind: 'times', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [] }, rt());
    assert.deepEqual([draft.error.code, draft.error.message], ['no_results', 'Run 2 has no results yet; its status is draft.']);
    const notSaved = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: '', kind: 'field_range', field: 'p', time: 75, points: [], samples: 0, filter_key: '', values: [] }, rt());
    assert.equal(notSaved.error.code, 'not_found');
    const bad = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: '', kind: 'plugin_filter', field: '', time: -1, points: [], samples: 0, filter_key: 'cut_plane', values: [{ key: 'orientation', value: '"Q"' }, { key: 'nope', value: '1' }] }, rt());
    assert.equal(bad.error.code, 'bad_values');
    assert.equal(bad.error.detail.length, 2);
    const gone = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: 'r9', kind: 'status', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [] }, rt());
    assert.equal(gone.error.code, 'not_found');
  });
  it('transient_preview: the transient.* values checked, then a read of the preview', async () => {
    fresh();
    const from = app.seen.length;
    await res('transient_preview', { values: [{ key: 'transient.max_co', value: '0.8' }] });
    const req = app.seen.slice(from).find((r) => r.path === '/api/run/transient-preview');
    assert.deepEqual(req.body, { project_id: 'p1', run_id: 'r1', simulation_id: 's1', transient: { max_co: 0.8 } });
  });
});

describe('read_results: precheck (RH2)', () => {
  const res = (kind, more = {}) => ok('read_results', { project_id: '', simulation_id: '', run_id: '', kind, field: '', time: -1, points: [], samples: 0, filter_key: '', values: [], ...more });
  const PISO = {
    code: 'piso_high_co',
    level: 'warn',
    text: 'Max Courant 100 with 1 outer corrector.',
    short: 'Max Courant 100 with PISO',
    fix: { label: '3 outer correctors, Max Courant 5', target: 'run', values: [{ key: 'transient.n_outer_correctors', value: 3 }, { key: 'transient.max_co', value: 5 }], cost: { steps: 180000, wall_s: 315000 } },
    alt: { label: 'Max Courant 1', target: 'run', values: [{ key: 'transient.max_co', value: 1 }], cost: { steps: 900000, wall_s: 525000 } },
    kept: false,
  };
  const STILL = { code: 'still_start', level: 'info', text: 'The run starts from rest.', fix: { label: 'Start from potential flow', target: 'study', values: [{ key: 'potential_flow', value: true }], cost: null }, alt: null, kept: false };
  const STEADY = { code: 'steady_for_mean', level: 'warn', text: 'A steady run solves the mean.', fix: { label: 'Make a steady copy', target: 'steady_copy', values: [], cost: { steps: 1500, wall_s: 900 } }, alt: null, kept: false };
  const answer = (extra = {}) => ({
    ok: true,
    checked: true,
    checks: [PISO, STEADY, STILL],
    estimate: { line: 'Δt ≈ 1.1e-5 s at Max Courant 1', delta_t_s: 1.11e-5, steps: 900000, wall_s: 525000, flow_through_s: 0.177, velocity_cap: 226.113 },
    earlier: { run_id: 'r9', name: 'Run_2', verdict: 'unhealthy', codes: ['pv_coupling'] },
    mesh: { cells: 625221, max_non_orthogonality: 55, max_skewness: 2.1, max_aspect_ratio: 12 },
    settings: { max_co: 100, n_outer_correctors: 1 },
    kept: ['still_start'],
    ...extra,
  });

  it("the run's check as Before you start shows it: the rows with their fix calls, kept, the estimate, the velocity limit and the last run's health", async () => {
    fresh();
    app.over = (m, path) => (path === '/api/run/precheck' ? answer() : undefined);
    const from = app.seen.length;
    const pc = await res('precheck');
    const req = app.seen.slice(from).find((r) => r.path === '/api/run/precheck');
    assert.deepEqual(req.body, { project_id: 'p1', run_id: 'r1', simulation_id: 's1' });
    assert.equal(pc.using, 'saved');
    assert.equal(pc.shown_in, 'Run panel → Before you start');
    assert.deepEqual(pc.estimate, { delta_t_s: 1.11e-5, steps: 900000, wall_h: 145.83, flow_through_s: 0.177, line: 'Δt ≈ 1.1e-5 s at Max Courant 1' });
    assert.equal(pc.velocity_cap, 226.113);
    assert.deepEqual(pc.earlier, { run_id: 'r9', name: 'Run_2', verdict: 'unhealthy', codes: ['pv_coupling'] });
    assert.deepEqual(pc.mesh, { cells: 625221, max_non_orthogonality: 55, max_skewness: 2.1, max_aspect_ratio: 12 });
    const [piso, steady, still] = pc.findings;
    assert.deepEqual([piso.code, piso.level, piso.kept, still.kept], ['piso_high_co', 'warn', false, true]);
    // The fix and the alternative as the calls that make them (setup_edit's run update; study_edit set).
    assert.equal(piso.fix[0].call, `setup_edit {kind:'run', action:'update', id:'r1', values:[{"key":"transient.n_outer_correctors","value":"3"},{"key":"transient.max_co","value":"5"}]}`);
    assert.equal(piso.fix[1].call, `setup_edit {kind:'run', action:'update', id:'r1', values:[{"key":"transient.max_co","value":"1"}]}`);
    assert.deepEqual(piso.fix[0].cost, { steps: 180000, wall_s: 315000 });
    assert.equal(still.fix[0].call, `study_edit {action:'set', id:'s1', values:[{"key":"potential_flow","value":"true"}]}`);
    assert.match(steady.fix[0].call, /^study_edit \{action:'copy', copy_from:'s1', copy_mode:'settings'\}, then study_edit \{action:'set_time'/);
    assert.ok(Buffer.byteLength(JSON.stringify(pc), 'utf8') <= 8 * 1024);
  });

  it('values: proposed transient.* settings checked without saving (using: proposed); other keys are refused', async () => {
    fresh();
    app.over = (m, path) => (path === '/api/run/precheck' ? answer({ checks: [STILL] }) : undefined);
    const from = app.seen.length;
    const pc = await res('precheck', { values: [{ key: 'transient.n_outer_correctors', value: '3' }, { key: 'transient.max_co', value: '5' }] });
    const reqs = app.seen.slice(from);
    assert.deepEqual(reqs.find((r) => r.path === '/api/run/precheck').body, { project_id: 'p1', run_id: 'r1', simulation_id: 's1', transient: { n_outer_correctors: 3, max_co: 5 } });
    assert.ok(!reqs.some((r) => r.path === '/api/run/update'), 'nothing saved');
    assert.equal(pc.using, 'proposed');
    assert.deepEqual(pc.findings.map((f) => f.code), ['still_start']);
    const bad = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: '', kind: 'precheck', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [{ key: 'endTime', value: '5' }] }, rt());
    assert.equal(bad.error.code, 'bad_values');
  });

  it('a check of the run settings only (no mesh yet) says so, as the panel does, and never "nothing found before it starts"', async () => {
    fresh();
    const est = { line: 'No time-step estimate until the mesh is generated', complete: false, unchecked: 'its mesh and physics are checked once the mesh is generated' };
    app.over = (m, path) => (path === '/api/run/precheck' ? answer({ checks: [], kept: [], estimate: est, mesh: null }) : undefined);
    const out = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: '', kind: 'precheck', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [] }, rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.data.partial, 'Only its run settings were checked: its mesh and physics are checked once the mesh is generated.');
    assert.equal(out.summary, 'Run 1: nothing found in its run settings');
    // With rows, the summary says what was checked in words of its own.
    app.over = (m, path) => (path === '/api/run/precheck' ? answer({ checks: [{ code: 'still_start', level: 'info', text: 'The run starts from rest.', fix: null }, { code: 'piso_correctors', level: 'warn', text: 'PISO needs at least 2 pressure correctors per step.', fix: null }], kept: [], estimate: est, mesh: null }) : undefined);
    const rows = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: '', kind: 'precheck', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [] }, rt());
    assert.equal(rows.ok, true, JSON.stringify(rows));
    assert.match(rows.summary, /^Run 1: \d+ to look at before it starts \(only its run settings were checked\)$/);
  });

  it('an analysis without the check says so', async () => {
    fresh();
    app.over = (m, path) => (path === '/api/run/precheck' ? { ok: true, checked: false, checks: [], estimate: null, unavailable: 'Its plugin is off.' } : undefined);
    const pc = await res('precheck');
    assert.deepEqual(pc, { run_id: 'r1', checked: false, why: 'Its plugin is off.', shown_in: 'Run panel → Before you start' });
  });
});

describe('read_results: health, log_tail and the status fields (RH1)', () => {
  const res = (kind, more = {}) => ok('read_results', { project_id: '', simulation_id: '', run_id: '', kind, field: '', time: -1, points: [], samples: 0, filter_key: '', values: [], ...more });
  const FIX = { label: 'New run: 3 outer correctors, Max Courant 5', target: 'new_run', values: [{ key: 'transient.n_outer_correctors', value: 3 }, { key: 'transient.max_co', value: 5 }], cost: { steps: 177878, wall_s: 308946 } };
  const health = {
    v: 1,
    verdict: 'unhealthy',
    unit: 'time step',
    window: 50,
    t: 0.0188,
    first_unhealthy: { t: 0.0069061069, step: 25, wall_s: 15 },
    restart: 'from_zero',
    checked: ['velocity_clipped', 'pv_coupling'],
    skipped: [],
    findings: [
      { code: 'velocity_clipped', level: 'error', text: 'Velocity clipped in 100% of steps: the 226 m/s limit caught 57% of cells.', evidence: { line: 786, text: `limitVelocity on ${WIN}\p1 /home/someone/x`, log_at: 46273, key: '76dd40d7d1a9' }, fix: [FIX] },
      { code: 'courant_mode', level: 'warn', text: 'Likely cause: Max Courant 100 with 1 outer corrector (PISO).', evidence: null, fix: [FIX] },
    ],
  };
  const withRun = (extra) => {
    fresh();
    Object.assign(app.w.runs[0], { status: 'stopped', time_dependency: 'Transient', co_mean: 0.94, co_max: 82.3, delta_t: 9.1e-4, n_steps: 119, stop_requested: false, warnings: [{ code: 'x', message: `copy failed to ${WIN}\p1\s1\r1` }], health, health_checked: true, continue_from: 0.1667, ...extra });
  };

  it('status gives the Courant number, the time step, steps, warnings (scrubbed) and the health verdict', async () => {
    withRun();
    const st = await res('status');
    assert.deepEqual(st.courant, { mean: 0.94, max: 82.3 });
    assert.equal(st.delta_t, 9.1e-4);
    assert.equal(st.n_steps, 119);
    assert.equal(st.stopping, false);
    assert.deepEqual(st.health, { verdict: 'unhealthy', codes: ['velocity_clipped', 'courant_mode'], restart: 'from_zero' });
    assert.equal(st.health_checked, true);
    assert.equal(st.warnings[0].scrubbed, true);
    assert.ok(!st.warnings[0].message.includes(WIN), st.warnings[0].message);
  });

  it("health: the record, the panel's next words and the fix as setup_edit's one call; path-free and within 8 KB", async () => {
    withRun();
    app.over = (m, path) => (path === '/api/run/health' ? { ok: true, run_id: 'r1', health, health_checked: true } : undefined);
    const h = await res('health');
    assert.equal(h.verdict, 'unhealthy');
    assert.equal(h.word, 'Unhealthy');
    assert.equal(h.shown_in, 'Run panel → Health');
    assert.match(h.next.text, /^Its saved results \(from t = 0\.167 s\) come after the problem began \(t = 0\.0069 s\)/);
    const fix = h.next.fixes[0];
    assert.equal(fix.name, 'Run 1 fixed');
    assert.deepEqual(fix.values, [{ key: 'transient.n_outer_correctors', value: '3' }, { key: 'transient.max_co', value: '5' }]);
    assert.equal(fix.call, `setup_edit {kind:'run', action:'add', other_id:'r1', name:'Run 1 fixed', values:${JSON.stringify(fix.values)}}`);
    assert.ok(!JSON.stringify(h).includes('/home/someone'));
    assert.ok(Buffer.byteLength(JSON.stringify(h), 'utf8') <= 8 * 1024);
  });

  it("health's fix label takes the pre-run check's cost of the same values when the run has one (spec 3.10)", async () => {
    withRun({ prepare_run: { checks: [{ code: 'piso_high_co', level: 'warn', text: 'x', fix: { label: '3 outer correctors, Max Courant 5', target: 'run', values: [{ key: 'transient.n_outer_correctors', value: 3 }, { key: 'transient.max_co', value: 5 }], cost: { steps: 181000, wall_s: 320000 } } }] } });
    app.over = (m, path) => (path === '/api/run/health' ? { ok: true, run_id: 'r1', health, health_checked: true } : undefined);
    const h = await res('health');
    assert.deepEqual(h.next.fixes[0].cost, { steps: 181000, wall_s: 320000 });
    assert.deepEqual(h.checked_at_start, ['piso_high_co']);
    // Without checks at start: the run's own measured cost.
    withRun();
    app.over = (m, path) => (path === '/api/run/health' ? { ok: true, run_id: 'r1', health, health_checked: true } : undefined);
    assert.deepEqual((await res('health')).next.fixes[0].cost, { steps: 177878, wall_s: 308946 });
  });

  it("health's next offers \"Use when continuing\" only where the Run panel does; a waiting change: only Health on the continued part can tell; the fix's call sets the run's own values back (S3, S4, S5)", async () => {
    const MC1 = { label: 'New run: Max Courant 1', target: 'new_run', values: [{ key: 'transient.max_co', value: 1 }], cost: { steps: 889391, wall_s: 514911 } };
    const before = { ...health, restart: 'continue_after_fix', findings: [{ ...health.findings[1], fix: [MC1] }] };
    const block = { end_time: 1, write_count: 20, write_interval: 0.05, max_co: 100, n_outer_correctors: 1, n_correctors: 2, max_delta_t: 0.05, source: { max_delta_t: 'auto' } };
    withRun({ health: before, continue_from: 0.005, last_saved_iteration: 0.005, transient: block });
    app.over = (m, path) => (path === '/api/run/health' ? { ok: true, run_id: 'r1', health: before, health_checked: true } : undefined);
    const said = 'Its last saved time (t = 0.005 s) is before it became unhealthy (t = 0.0069 s).';
    // Its study still Transient: the change can wait for Continue, as the person's question offers.
    app.w.studies[0].time_dependency = 'Transient';
    let h = await res('health');
    assert.match(h.next.text, /A change made with "Use when continuing" \(Max Courant or the correctors\) may avoid that/);
    // Its study now Steady-state: no Continue change is offered anywhere, so health offers none.
    app.w.studies[0].time_dependency = 'Steady-state';
    h = await res('health');
    assert.equal(h.next.text, `${said} Continue goes on from there; with the same settings it will likely become unhealthy again. A new run from t = 0 is the surer way.`);
    // Outer correctors 1 → 3 wait for its Continue (stored on the run at once).
    app.w.studies[0].time_dependency = 'Transient';
    Object.assign(app.w.runs[0], {
      transient: { ...block, n_outer_correctors: 3 },
      continue_changes: [{ from_t: 0.005, from_iteration: null, at: 'a', by: 'person', kind: 'settings', changes: [{ key: 'transient.n_outer_correctors', from: 1, to: 3 }], applied_at: null }],
    });
    h = await res('health');
    assert.equal(h.next.text, `${said} Health checks the continued part from t = 0.005 s; whether the change is enough shows only there. A new run from t = 0 is the surer way.`);
    // The new run is the one the fix's cost describes: 1 outer corrector (what the run solved with), then Max Courant 1.
    const fix = h.next.fixes[0];
    assert.deepEqual(fix.values, [{ key: 'transient.n_outer_correctors', value: '1' }, { key: 'transient.max_co', value: '1' }]);
    assert.equal(fix.call, `setup_edit {kind:'run', action:'add', other_id:'r1', name:'Run 1 fixed', values:${JSON.stringify(fix.values)}}`);
    assert.deepEqual(h.findings[0].fix[0].values, fix.values);
  });

  it('health on an old ended run starts "Check its log" (no card); a kind of run not checked says so', async () => {
    withRun({ health: null, health_checked: undefined, status: 'done' });
    const asks = [];
    app.over = (m, path, q) => {
      if (path !== '/api/run/health') return undefined;
      asks.push(q.get('recompute'));
      return { ok: true, run_id: 'r1', health: null, health_checked: null, checking: q.get('recompute') === '1' };
    };
    const h = await res('health');
    assert.deepEqual(h, { run_id: 'r1', checking: true, hint: 'read_results {kind:"health"} again in a few seconds' });
    assert.deepEqual(asks, [null, '1']);
    withRun({ health: null, health_checked: false });
    app.over = (m, path) => (path === '/api/run/health' ? { ok: true, run_id: 'r1', health: null, health_checked: false } : undefined);
    const no = await res('health');
    assert.deepEqual(no, { run_id: 'r1', health: null, checked: false, why: 'Health is not checked for this kind of run.' });
  });

  it("log_tail: the end, the start, or a finding's line (its key passed); at most 200 lines and 24 KB; path-free", async () => {
    withRun();
    const asked = [];
    app.over = (m, path, q) => {
      if (path !== '/api/run/solver-log') return undefined;
      asked.push(Object.fromEntries(q));
      const n = Number(q.get('lines'));
      return { ok: true, lines: Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(200)} ${WIN}\p1`), hit_line: q.get('key') ? 3 : null, first_line: null, truncated: true, live: false, as_of: '2026-11-03T10:00:00Z' };
    };
    const end = await res('log_tail', { samples: 500 });
    assert.equal(asked[0].at, 'end');
    assert.equal(asked[0].lines, '200');
    assert.ok(Buffer.byteLength(JSON.stringify(end), 'utf8') <= 24 * 1024);
    assert.ok(end.lines.length < 200 && end.truncated === true);
    await res('log_tail', { time: 0, filter_key: 'issues' });
    assert.deepEqual([asked[1].at, asked[1].filter], ['start', 'issues']);
    const at = await res('log_tail', { time: 46273 });
    assert.deepEqual([asked[2].at, asked[2].key], ['46273', '76dd40d7d1a9']);
    assert.equal(at.hit_line, 3);
  });
});

// RH3 (parity row R35): read_setup {what:'numerics'}: the rows the Run panel's "Numerics as written"
// shows, from the same route (run.precheck's numerics); a started run with none recorded says so.
describe('read_setup: numerics (RH3)', () => {
  const read = (more = {}) => ({ project_id: '', simulation_id: '', what: 'numerics', id: '', other_id: '', page: 0, ...more });
  const ROWS = [
    { group: 'Schemes', label: 'Gradient limiter', value: 'cellLimited Gauss linear 1', source: 'preset' },
    { group: 'PIMPLE', label: 'Outer relaxation', value: 'p 0.4, equations 0.7; the final outer loop 1', source: 'run' },
    { group: 'Limiters', label: 'Velocity limit', value: '226 m/s = 10 × 22.6 m/s (inlet velocity_inlet_1_1)', source: '' },
  ];
  it("a draft's rows, as Numerics as written shows them, from run.precheck", async () => {
    fresh();
    app.over = (m, path) => (path === '/api/run/precheck' ? { ok: true, checked: true, checks: [], estimate: null, numerics: ROWS, case_dir: 'C:/x' } : undefined);
    const from = app.seen.length;
    const out = await ok('read_setup', read({ id: 'r2' }));
    const req = app.seen.slice(from).find((r) => r.path === '/api/run/precheck');
    assert.deepEqual(req.body, { project_id: 'p1', simulation_id: 's1', run_id: 'r2' });
    assert.deepEqual(out, {
      run_id: 'r2',
      name: 'Run 2',
      from: 'study',
      rows: [
        { group: 'Schemes', label: 'Gradient limiter', value: 'cellLimited Gauss linear 1', source: 'preset' },
        { group: 'PIMPLE', label: 'Outer relaxation', value: 'p 0.4, equations 0.7; the final outer loop 1', source: 'run' },
        { group: 'Limiters', label: 'Velocity limit', value: '226 m/s = 10 × 22.6 m/s (inlet velocity_inlet_1_1)' },
      ],
      shown_in: 'Run panel → Numerics as written',
    });
  });
  it('a started run: what it started with (numerics_used), else none, saying why', async () => {
    fresh();
    app.over = (m, path) => (path === '/api/run/precheck' ? { ok: true, checked: true, checks: [], numerics: ROWS } : undefined);
    const none = await ok('read_setup', read({ id: 'r1' }));
    assert.deepEqual([none.from, none.rows], [null, []]);
    assert.equal(none.note, `"Run 1" started before its numerics were recorded; read_setup {what:'study'} has the study's now.`);
    app.w.runs[0].numerics_used = { analysis: 'incompressible_steady', mode: 'steady', at: '2026-11-04T00:00:00Z', values: { relax_p: 0.3 } };
    const used = await ok('read_setup', read({ id: 'r1' }));
    assert.deepEqual([used.from, used.rows.length], ['numerics_used', 3]);
    assert.equal('recorded' in used, false);
  });
  it('a started run whose rows were not recorded (started before they were): the one row the panel shows, and a note saying so', async () => {
    fresh();
    const row = { group: 'Not recorded', label: 'Numerics as written', value: 'This run started before the app recorded what its case was written with, so it is not shown here.', source: '' };
    app.over = (m, path) => (path === '/api/run/precheck' ? { ok: true, checked: true, checks: [], numerics: [row], numerics_recorded: false } : undefined);
    app.w.runs[0].numerics_used = { analysis: 'incompressible_steady', mode: 'steady', at: '2026-11-04T00:00:00Z', values: { relax_p: 0.3 } };
    const out = await ok('read_setup', read({ id: 'r1' }));
    assert.deepEqual([out.from, out.recorded, out.rows], ['numerics_used', false, [{ group: 'Not recorded', label: 'Numerics as written', value: row.value }]]);
    assert.equal(out.note, `"Run 1" started before what its case was written with was recorded: its case folder holds it; read_setup {what:'study'} has the study's numerics now.`);
  });
  it("a preset row names the preset the run is written with (the run's, as the panel names it)", async () => {
    fresh();
    app.over = (m, path) => (path === '/api/run/precheck' ? { ok: true, checked: true, checks: [], numerics: [{ ...ROWS[0], preset: 'Robust' }, ROWS[1]] } : undefined);
    app.w.runs[0].numerics_used = { analysis: 'incompressible_steady', mode: 'steady', at: '2026-11-04T00:00:00Z', values: { numerics_preset: null } };
    const used = await ok('read_setup', read({ id: 'r1' }));
    assert.deepEqual(used.rows[0], { group: 'Schemes', label: 'Gradient limiter', value: 'cellLimited Gauss linear 1', source: 'preset', preset: 'Robust' });
    assert.equal('preset' in used.rows[1], false);
  });
});
