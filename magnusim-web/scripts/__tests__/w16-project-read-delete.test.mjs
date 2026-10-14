/**
 * Home reads the active project (GET /api/project) when it loads. For a project with more
 * than one geometry that read also saved project.json (a new Modified time, so the card
 * moved to the top of Home) and made the project the active one. The save goes through the
 * worker, which answers one request at a time: a project deleted while it waited came back
 * (its folder, a project.json, the active project), and its card was on Home again.
 *
 * A read now writes nothing, and no save makes a deleted project again: the worker refuses
 * a save of a project whose project.json is gone, and a project deleted while its save
 * waited is not made the active one.
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
const { createGeometryFolder, writeJsonAtomic } = await import('../project-layout.js');
const { attachWorkerBridge, commitRpcSync } = await import('../py-json.js');
const w16 = await import('../w16-project-geometry.js');
const { handleW16Api, setCadPreviewWriterForTests, setThumbRendererForTests } = w16;

// No thumbnail renders here: a stand-in picture.
setThumbRendererForTests(async (args) => {
  const out = args[args.indexOf('--out') + 1];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.alloc(256, 7));
});

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

async function call(method, path, body) {
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
  await handleW16Api({ method, headers: { 'content-type': 'application/json' } }, res, url, url.pathname.split('/').filter(Boolean), helpers);
  return res;
}

const ACTIVE = join(root, 'active.json');
const activeId = () => (existsSync(ACTIVE) ? JSON.parse(readFileSync(ACTIVE, 'utf8')).project_id || null : null);
const setActive = (id) => writeFileSync(ACTIVE, JSON.stringify({ project_id: id }));
const listing = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).join(', ') || '(empty folder)' : '');

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
    let builds = 0;
    setCadPreviewWriterForTests(async () => {
      builds += 1;
      throw new Error('a read makes no preview');
    });

    const r = await call('GET', '/api/project');
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(builds, 0, 'the read made a CAD preview');
    assert.equal(r.body.project.geometry.id, 'g-tear');
    assert.equal(r.body.project.geometry.fingerprint.n_faces, 5, 'the saved record');
    assert.deepEqual(stampOf(dir), before, 'the read saved project.json');
    assert.equal(listing(join(dir, 'geometry')).includes('cad_'), false, listing(join(dir, 'geometry')));
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
