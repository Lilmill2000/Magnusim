/**
 * Home reads the active project (GET /api/project) when it loads. For a project with more
 * than one geometry that read also saved project.json (a new Modified time, so the card
 * moved to the top of Home) and made the project the active one. The save goes through the
 * worker, which answers one request at a time: a project deleted while it waited came back
 * (its folder, a project.json, the active project), and its card was on Home again.
 *
 * A read now saves nothing, and no save makes a deleted project again: the worker refuses
 * a save of a project whose project.json is gone, and a project deleted while its save
 * waited is not made the active one. A geometry or study switch whose save the worker
 * refused that way answers that the project was deleted (404), not a server error.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, afterEach, describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'magnusim-project-read-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
// The saves here run the app's Python, which must be a file path. CI has no python/.venv
// (setup-python's interpreter is on PATH): name that one, before the modules read it.
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENV = ['Scripts/python.exe', 'bin/python'].some((p) => existsSync(join(WEB, 'python', '.venv', p)));
if (!VENV && !process.env.MAGNUSIM_PYTHON && !process.env.CFDDESK_PYTHON) {
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) process.env.MAGNUSIM_PYTHON = r.stdout.trim();
}
const { createGeometryFolder, createStudyFolder, writeJsonAtomic } = await import('../project-layout.js');
const { attachWorkerBridge, commitRpcSync } = await import('../py-json.js');
const { saveCatalog } = await import('../w17-sim-catalog.js');
const w16 = await import('../w16-project-geometry.js');
const { handleW16Api, setCadPreviewWriterForTests, setThumbRendererForTests } = w16;
const { handleW17Api } = await import('../w17-simulation.js');

// No thumbnail renders here: a stand-in picture. Each render's arguments are kept (the
// picture is rendered outside the project; its source, a preview or STL, is in it).
const thumbRenders = [];
setThumbRendererForTests(async (args) => {
  thumbRenders.push(args.join(' '));
  const out = args[args.indexOf('--out') + 1];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.alloc(256, 7));
});
/** The thumbnail renders of `pid`'s geometry. */
const thumbsOf = (pid) => thumbRenders.filter((args) => args.includes(pid));

afterEach(() => {
  attachWorkerBridge(null);
  setCadPreviewWriterForTests(null);
});

after(() => {
  setThumbRendererForTests(null);
  rmSync(root, { recursive: true, force: true });
});

const SAVED = '2026-10-01T00:00:00.000Z';

/**
 * A round and a teardrop part (stand-in STEP files), the teardrop shown. With `previews`
 * each has a cached CAD preview, whose face count (7, 9) is not the saved record's (5).
 */
function seedProject(pid, { previews = true } = {}) {
  const dir = join(root, pid);
  mkdirSync(dir, { recursive: true });
  const geometries = [
    ['g-round', 'round', 7],
    ['g-tear', 'tear', 9],
  ].map(([id, name, nFaces]) => {
    const folder = createGeometryFolder(dir, { id, name, original_filename: `${name}.step` });
    const stepPath = join(folder.dir, 'source.step');
    writeFileSync(stepPath, 'ISO-10303-21;\n');
    if (previews) {
      writeFileSync(join(folder.dir, 'cad_faces.vtp'), 'f'.repeat(200));
      writeFileSync(join(folder.dir, 'cad_edges.vtp'), 'e'.repeat(200));
      writeFileSync(
        join(folder.dir, 'cad_preview.json'),
        JSON.stringify({ preview_version: 8, n_faces: nFaces, n_edges: 12, n_solids: 1, center_of_mass: [0, 0, 1] }),
      );
    }
    return { id, name, original_filename: `${name}.step`, step_path: stepPath, source_kind: 'step', n_solids: 1 };
  });
  writeJsonAtomic(join(dir, 'project.json'), {
    id: pid,
    title: pid,
    units: 'Metric',
    folder: 'My Projects',
    created_at: SAVED,
    updated_at: SAVED,
    geometries,
    active_geometry_id: 'g-tear',
    geometry: { id: 'g-tear', name: 'tear', step_path: geometries[1].step_path, step_source: 'activate', fingerprint: { n_faces: 5 } },
  });
  return dir;
}

async function call(method, path, body, handler = handleW16Api) {
  const url = new URL(path, 'http://localhost');
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    end(bytes) {
      this.body = bytes;
    },
  };
  const helpers = {
    sendJson(_res, status, doc) {
      res.statusCode = status;
      res.body = doc;
      return true;
    },
    readJsonBody: async () => body,
  };
  await handler({ method, headers: { 'content-type': 'application/json' } }, res, url, url.pathname.split('/').filter(Boolean), helpers);
  return res;
}

/** The server's answer to a route that threw: a 500 with its message. */
const asServerError = (e) => ({ statusCode: 500, body: { error: String((e && e.message) || e) } });

/** Rewrites a seeded project's project.json. */
function editProject(dir, edit) {
  const file = join(dir, 'project.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  edit(doc);
  writeJsonAtomic(file, doc);
}

/** Counts the CAD previews made (none here: each one fails). */
function countPreviewBuilds() {
  const counter = { builds: 0 };
  setCadPreviewWriterForTests(async () => {
    counter.builds += 1;
    throw new Error('a read makes no preview');
  });
  return counter;
}

/** Time for a render a read started without waiting for it. */
const settle = () => new Promise((r) => setTimeout(r, 500));

const ACTIVE = join(root, 'active.json');
const activeId = () => (existsSync(ACTIVE) ? JSON.parse(readFileSync(ACTIVE, 'utf8')).project_id || null : null);
const setActive = (id) => writeFileSync(ACTIVE, JSON.stringify({ project_id: id }));
const listing = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).join(', ') || '(empty folder)' : '');
/** A seeded part's folder. */
const partDir = (dir, gid) => dirname(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).geometries.find((g) => g.id === gid).step_path);

/** project.json as it is on disk: its text and its age. */
function stampOf(dir) {
  const file = join(dir, 'project.json');
  return { text: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };
}

/**
 * The worker as the server has it, answering one request at a time: a project.json save of
 * `pid` waits until released, then the app's Python makes it. `landFirst`: the save is
 * made at once and only its answer waits (a delete lands in between).
 */
function holdSaves(pid, { landFirst = false } = {}) {
  let release;
  const released = new Promise((r) => (release = r));
  let held = false;
  attachWorkerBridge((method, params) => {
    if (method !== 'project.write_project' || basename(String(params.project_dir)) !== pid) return null;
    held = true;
    if (landFirst) {
      const written = commitRpcSync(method, params);
      return released.then(() => written);
    }
    return released.then(() => commitRpcSync(method, params));
  });
  const saveHeld = async () => {
    const by = Date.now() + 60_000;
    while (!held && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
    assert.ok(held, 'the save was never sent to the worker');
  };
  return { release, saveHeld };
}

describe("a read of a project (GET /api/project) writes nothing", () => {
  it('saves no project.json and makes no project the active one; the shown record comes from its cached preview', async () => {
    const pid = 'read-two-geometries';
    const dir = seedProject(pid);
    seedProject('read-other');
    setActive('read-other');
    const before = stampOf(dir);

    for (const path of [`/api/project?project_id=${pid}`, `/api/project/${pid}`]) {
      const r = await call('GET', path);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      const proj = r.body.project;
      assert.equal(proj.updated_at, SAVED, `${path}: the Modified time`);
      assert.equal(proj.geometry.id, 'g-tear', path);
      assert.equal(proj.geometry.fingerprint.n_faces, 9, `${path}: the record is drawn from the cached preview`);
      assert.match(proj.geometry.faces_url, /geometry_id=g-tear/);
      assert.deepEqual(proj.geometries.map((g) => g.id), ['g-round', 'g-tear']);
      assert.deepEqual(stampOf(dir), before, `${path} saved project.json`);
      assert.equal(activeId(), 'read-other', `${path} made the project the active one`);
    }
    // Home's card asks for its own picture: a read renders none (it used to, after it saved).
    await settle();
    assert.deepEqual(thumbsOf(pid), [], 'a read rendered a thumbnail');

    // The active project, as Home reads it.
    setActive(pid);
    const r = await call('GET', '/api/project');
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.project.id, pid);
    assert.equal(r.body.project.geometry.fingerprint.n_faces, 9);
    assert.deepEqual(stampOf(dir), before, 'GET /api/project saved project.json');
  });

  it('makes no CAD preview: without one it answers the saved record', async () => {
    const pid = 'read-no-preview';
    const dir = seedProject(pid, { previews: false });
    setActive(pid);
    const before = stampOf(dir);
    const counter = countPreviewBuilds();

    const r = await call('GET', '/api/project');
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(counter.builds, 0, 'the read made a CAD preview');
    assert.equal(r.body.project.geometry.id, 'g-tear');
    assert.equal(r.body.project.geometry.fingerprint.n_faces, 5, 'the saved record');
    assert.deepEqual(stampOf(dir), before, 'the read saved project.json');
    assert.equal(listing(join(dir, 'geometry')).includes('cad_'), false, listing(join(dir, 'geometry')));
    await settle();
    assert.deepEqual(thumbsOf(pid), [], 'a read rendered a thumbnail');
  });
});

describe("what a read shows of the shown geometry when its preview can't be used as it is", () => {
  /** GET /api/project of `pid`, made the active project: its project, after the checks every read passes. */
  async function read(pid, dir) {
    setActive(pid);
    const before = stampOf(dir);
    const counter = countPreviewBuilds();
    const r = await call('GET', '/api/project');
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.project.id, pid);
    assert.equal(counter.builds, 0, 'the read made a CAD preview');
    assert.deepEqual(stampOf(dir), before, 'the read saved project.json');
    assert.equal(activeId(), pid);
    return r.body.project;
  }

  it('a linked update that did not finish (fenced): the saved record, not its files', async () => {
    const pid = 'read-fenced';
    const dir = seedProject(pid);
    // Its commit journal is there and no job of this server owns it: its files and its
    // records may disagree until the recovery runs.
    const tear = partDir(dir, 'g-tear');
    assert.ok(existsSync(join(tear, 'cad_preview.json')), listing(join(dir, 'geometry')));
    mkdirSync(join(tear, 'link'), { recursive: true });
    writeFileSync(join(tear, 'link', 'commit.json'), JSON.stringify({ job: 'a-job-of-an-earlier-server' }));

    const proj = await read(pid, dir);
    assert.equal(proj.geometry.id, 'g-tear');
    assert.equal(proj.geometry.fingerprint.n_faces, 5, 'the saved record (its preview says 9)');
    assert.equal(proj.active_geometry_id, 'g-tear');

    // With no saved record of it, its record is drawn without its files' counts.
    editProject(dir, (doc) => {
      doc.geometry = { ...doc.geometry, id: 'g-round', name: 'round' };
    });
    const drawn = await read(pid, dir);
    assert.equal(drawn.geometry.id, 'g-tear');
    assert.equal(drawn.geometry.fingerprint.n_faces, null, "counts read from a fenced geometry's files");
  });

  it('a preview that opening the project makes again (older face ids): the saved record', async () => {
    const pid = 'read-stale-face-ids';
    const dir = seedProject(pid);
    // A version 7 preview of a shape with a face two solids share (the same area and
    // centroid twice): its viewport face ids name other faces, so it is made again.
    writeFileSync(
      join(partDir(dir, 'g-tear'), 'cad_preview.json'),
      JSON.stringify({
        preview_version: 7,
        n_faces: 9,
        faces: [
          { area: 2, centroid: [0, 0, 1] },
          { area: 2, centroid: [0, 0, 1] },
        ],
      }),
    );

    const proj = await read(pid, dir);
    assert.equal(proj.geometry.id, 'g-tear');
    assert.equal(proj.geometry.fingerprint.n_faces, 5, 'the saved record (the old preview says 9)');
  });

  it("no preview, and the saved record is another geometry's: the shown part, its counts not known yet", async () => {
    const pid = 'read-other-record';
    const dir = seedProject(pid, { previews: false });
    editProject(dir, (doc) => {
      doc.geometry = { ...doc.geometry, id: 'g-round', name: 'round' };
    });

    const proj = await read(pid, dir);
    assert.equal(proj.active_geometry_id, 'g-tear');
    assert.equal(proj.geometry.id, 'g-tear', "the record is the shown geometry's");
    assert.equal(proj.geometry.name, 'tear');
    assert.match(proj.geometry.faces_url, /geometry_id=g-tear/, 'the page asks for the shown preview');
    assert.equal(proj.geometry.fingerprint.n_faces, null, 'face count');
    assert.equal(proj.geometry.fingerprint.n_solids, null, 'solid count');
    assert.deepEqual(proj.geometries.map((g) => g.id), ['g-round', 'g-tear']);
  });

  it('no STEP left: no geometry shown, and project.json still lists them', async () => {
    const pid = 'read-no-step';
    const dir = seedProject(pid);
    for (const g of ['g-round', 'g-tear']) rmSync(join(partDir(dir, g), 'source.step'));

    const proj = await read(pid, dir);
    assert.equal(proj.geometry, null);
    assert.deepEqual(proj.geometries, []);
    assert.equal(proj.active_geometry_id, null);
    const saved = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    assert.deepEqual(saved.geometries.map((g) => g.id), ['g-round', 'g-tear'], 'the read changed what project.json lists');
    await settle();
    assert.deepEqual(thumbsOf(pid), [], 'a read rendered a thumbnail');
  });
});

describe('a project deleted while one of its saves waits on the worker', () => {
  it('stays deleted when the save runs after the delete: the worker refuses it', { timeout: 120_000 }, async () => {
    const pid = 'save-after-delete';
    const dir = seedProject(pid);
    setActive(pid);
    const held = holdSaves(pid);
    // Another tab shows the round part: the project is saved through the worker.
    const showing = call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-round' });
    await held.saveHeld();

    const deleted = await call('POST', '/api/project/delete', { project_id: pid });
    assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
    assert.equal(existsSync(dir), false);
    held.release();
    const shown = await showing;

    assert.equal(listing(dir), '', `the deleted project is back: ${dir}`);
    assert.notEqual(activeId(), pid, 'the deleted project is the active project again');
    assert.equal(shown.statusCode, 404, JSON.stringify(shown.body));
  });

  it('is not made the active project when the save landed just before the delete', { timeout: 120_000 }, async () => {
    const pid = 'save-before-delete';
    const dir = seedProject(pid);
    setActive(pid);
    const held = holdSaves(pid, { landFirst: true });
    const showing = call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-round' });
    await held.saveHeld();

    const deleted = await call('POST', '/api/project/delete', { project_id: pid });
    assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
    held.release();
    const shown = await showing;

    assert.equal(listing(dir), '', `the deleted project is back: ${dir}`);
    assert.notEqual(activeId(), pid, 'the deleted project is the active project again');
    assert.equal(shown.statusCode, 404, JSON.stringify(shown.body));
  });
});

describe('a study switch of a project deleted while its save waits on the worker', () => {
  it('answers that the project was deleted, and the project stays deleted', { timeout: 120_000 }, async () => {
    const pid = 'study-switch-delete';
    const dir = seedProject(pid);
    for (const [id, geom, name] of [
      ['sim-round', 'g-round', 'Round study'],
      ['sim-tear', 'g-tear', 'Tear study'],
    ]) {
      createStudyFolder(dir, geom, { id, name });
    }
    saveCatalog(pid, {
      simulations: [
        { id: 'sim-round', name: 'Round study', geometry_id: 'g-round' },
        { id: 'sim-tear', name: 'Tear study', geometry_id: 'g-tear' },
      ],
      active_id: 'sim-tear',
    });
    setActive(pid);
    const held = holdSaves(pid);
    // Another tab switches to the other study: the project is saved through the worker.
    const switching = call('POST', '/api/simulation/activate', { project_id: pid, simulation_id: 'sim-round' }, handleW17Api).catch(
      asServerError,
    );
    await held.saveHeld();

    const deleted = await call('POST', '/api/project/delete', { project_id: pid });
    assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
    assert.equal(existsSync(dir), false);
    held.release();
    const switched = await switching;

    assert.equal(listing(dir), '', `the deleted project is back: ${dir}`);
    assert.notEqual(activeId(), pid, 'the deleted project is the active project again');
    assert.equal(switched.statusCode, 404, JSON.stringify(switched.body));
    assert.equal(switched.body.error, 'project deleted while it was saved');
  });
});

describe("a study setting's save", () => {
  /** A project with one study on the teardrop, the active project. */
  function seedStudy(pid) {
    const dir = seedProject(pid);
    createStudyFolder(dir, 'g-tear', { id: 'sim-tear', name: 'Tear study' });
    saveCatalog(pid, { simulations: [{ id: 'sim-tear', name: 'Tear study', geometry_id: 'g-tear' }], active_id: 'sim-tear' });
    setActive(pid);
    return dir;
  }
  const study = (pid) => call('GET', `/api/simulation?project_id=${pid}&simulation_id=sim-tear`, null, handleW17Api);

  // Its project.json was written by a new Python process (spawnSync), which held the whole
  // server for over a second each save: on a busy PC the study panel's next reads waited
  // longer than that, and the saved value was not there yet.
  it('saves project.json through the worker, and the study has the value while that waits', { timeout: 120_000 }, async () => {
    const pid = 'study-save-worker';
    seedStudy(pid);
    const held = holdSaves(pid);
    const saving = call('POST', '/api/simulation/update', { project_id: pid, simulation_id: 'sim-tear', numerics_preset: 'accurate' }, handleW17Api);
    await held.saveHeld();

    const meanwhile = await study(pid);
    assert.equal(meanwhile.statusCode, 200, JSON.stringify(meanwhile.body));
    assert.equal(meanwhile.body.simulation.numerics_preset, 'accurate');
    held.release();
    const saved = await saving;
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.simulation.numerics_preset, 'accurate');
    assert.equal(saved.body.project.active_simulation_id, 'sim-tear');
  });

  it('answers that the project was deleted when it was deleted while the save waited', { timeout: 120_000 }, async () => {
    const pid = 'study-save-delete';
    const dir = seedStudy(pid);
    const held = holdSaves(pid);
    const saving = call('POST', '/api/simulation/update', { project_id: pid, simulation_id: 'sim-tear', simplec: true }, handleW17Api).catch(
      asServerError,
    );
    await held.saveHeld();

    const deleted = await call('POST', '/api/project/delete', { project_id: pid });
    assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
    held.release();
    const saved = await saving;
    assert.equal(listing(dir), '', `the deleted project is back: ${dir}`);
    assert.equal(saved.statusCode, 404, JSON.stringify(saved.body));
    assert.equal(saved.body.error, 'project deleted while it was saved');
  });
});

describe("a study's create, reorder and delete", () => {
  /** A project with two studies on the teardrop (the second active), the active project; and study A's folder. */
  function seedStudies(pid) {
    const dir = seedProject(pid);
    const folderA = createStudyFolder(dir, 'g-tear', { id: 'sim-a', name: 'Study A' }).dir;
    createStudyFolder(dir, 'g-tear', { id: 'sim-b', name: 'Study B' });
    saveCatalog(pid, {
      simulations: [
        { id: 'sim-a', name: 'Study A', geometry_id: 'g-tear' },
        { id: 'sim-b', name: 'Study B', geometry_id: 'g-tear' },
      ],
      active_id: 'sim-b',
    });
    setActive(pid);
    return { dir, folderA };
  }
  const studies = (pid) => call('GET', `/api/simulation?project_id=${pid}`, null, handleW17Api);
  const ids = (body) => (body.simulations || []).map((s) => s.id);

  const routes = {
    create: { path: '/api/simulation', body: { geometry_id: 'g-tear' }, status: 201 },
    reorder: { path: '/api/simulation/reorder', body: { ids: ['sim-b', 'sim-a'], geometry_id: 'g-tear' }, status: 200 },
    delete: { path: '/api/simulation/delete', body: { simulation_id: 'sim-a' }, status: 200 },
  };

  // Each saved project.json through a new Python process (spawnSync): the whole server,
  // every tab's requests, waited over a second for each one.
  for (const [what, route] of Object.entries(routes)) {
    it(`${what}: saves project.json through the worker, and the server answers meanwhile`, { timeout: 120_000 }, async () => {
      const pid = `study-${what}-worker`;
      const { dir, folderA } = seedStudies(pid);
      const held = holdSaves(pid);
      const saving = call('POST', route.path, { project_id: pid, ...route.body }, handleW17Api);
      await held.saveHeld();

      const meanwhile = await studies(pid);
      assert.equal(meanwhile.statusCode, 200, JSON.stringify(meanwhile.body));
      if (what === 'create') assert.equal(ids(meanwhile.body).length, 3, JSON.stringify(ids(meanwhile.body)));
      if (what === 'reorder') assert.deepEqual(ids(meanwhile.body), ['sim-b', 'sim-a']);
      // project.json is saved first, then the study's folder goes.
      if (what === 'delete') assert.ok(existsSync(folderA), 'the folder went before project.json was saved');
      held.release();
      const saved = await saving;
      assert.equal(saved.statusCode, route.status, JSON.stringify(saved.body));
      const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
      assert.equal(project.active_simulation_id, saved.body.active_id, 'project.json names the active study');
      if (what === 'create') assert.equal(project.active_simulation_id, saved.body.simulation.id, 'the new study is the active one');
      if (what === 'delete') {
        assert.equal(saved.body.deleted, 'sim-a');
        assert.equal(existsSync(folderA), false, listing(join(dir, 'geometry')));
      }
    });

    it(`${what}: answers that the project was deleted when it was deleted while the save waited`, { timeout: 120_000 }, async () => {
      const pid = `study-${what}-delete`;
      const { dir } = seedStudies(pid);
      const held = holdSaves(pid);
      const saving = call('POST', route.path, { project_id: pid, ...route.body }, handleW17Api).catch(asServerError);
      await held.saveHeld();

      const deleted = await call('POST', '/api/project/delete', { project_id: pid });
      assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
      assert.equal(existsSync(dir), false);
      held.release();
      const saved = await saving;
      assert.equal(listing(dir), '', `the deleted project is back: ${dir}`);
      assert.notEqual(activeId(), pid, 'the deleted project is the active project again');
      assert.equal(saved.statusCode, 404, JSON.stringify(saved.body));
      assert.equal(saved.body.error, 'project deleted while it was saved');
    });
  }
});

describe('the active project', () => {
  it('is never a deleted one', async () => {
    const kept = await call('POST', '/api/project', { title: 'Kept', category: 'Other', units: 'Metric' });
    assert.equal(kept.statusCode, 201, JSON.stringify(kept.body));
    const gone = await call('POST', '/api/project', { title: 'Gone', category: 'Other', units: 'Metric' });
    assert.equal(gone.statusCode, 201, JSON.stringify(gone.body));
    assert.equal(activeId(), gone.body.id, 'a new project is the active one');
    assert.equal(w16.writeActiveId(kept.body.id), true);
    rmSync(join(root, gone.body.id), { recursive: true, force: true });

    assert.equal(w16.writeActiveId(gone.body.id), false);
    assert.equal(activeId(), kept.body.id);
    assert.equal(existsSync(join(root, gone.body.id)), false);
    assert.equal(w16.writeActiveId(null), true);
    assert.equal(activeId(), null);
  });
});
