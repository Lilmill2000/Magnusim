/**
 * A geometry's CAD preview (cad_faces.vtp, cad_edges.vtp, cad_preview.json) is made when it
 * is shown, a Home card asks for its picture, or a modifier is added. A geometry or project
 * removed while that ran came back as a folder holding only those three files: the preview
 * wrote into the removed folder (its writers make the folder). The tree skipped it, but a
 * new import of the same file got a "_2" folder. Same class as the thumbnail
 * (w16-thumb-removed-geometry.test.mjs): the preview is now made outside the project and
 * moved in only while its geometry is still there.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'magnusim-preview-race-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
// The previews these tests make run the app's Python, which must be a file path (the
// server checks it exists). CI has no python/.venv (setup-python's interpreter is on PATH):
// name that one, before the server's modules read MAGNUSIM_PYTHON.
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENV = ['Scripts/python.exe', 'bin/python'].some((p) => existsSync(join(WEB, 'python', '.venv', p)));
if (!VENV && !process.env.MAGNUSIM_PYTHON && !process.env.CFDDESK_PYTHON) {
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) process.env.MAGNUSIM_PYTHON = r.stdout.trim();
}
const { createGeometryFolder, geometriesRoot, writeJsonAtomic } = await import('../project-layout.js');
const { handleW16Api, setCadPreviewWriterForTests, setThumbRendererForTests } = await import('../w16-project-geometry.js');

const FIXTURES = join(WEB, 'python', 'tests', 'fixtures', 'geometry');

// No thumbnail renders here (they would make previews of their own): a stand-in picture.
setThumbRendererForTests(async (args) => {
  const out = args[args.indexOf('--out') + 1];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.alloc(256, 7));
});

after(() => {
  setCadPreviewWriterForTests(null);
  setThumbRendererForTests(null);
  rmSync(root, { recursive: true, force: true });
});

/** The round and the teardrop hole plate, with no previews yet; the round one is active. */
function seedProject(pid) {
  const dir = join(root, pid);
  mkdirSync(dir, { recursive: true });
  const geometries = [
    ['g-round', 'transient-test'],
    ['g-tear', 'transient-test-teardrop'],
  ].map(([id, name]) => {
    const folder = createGeometryFolder(dir, { id, name, original_filename: `${name}.step` });
    const stepPath = join(folder.dir, 'source.step');
    cpSync(join(FIXTURES, `${name}.step`), stepPath);
    return { id, name, original_filename: `${name}.step`, step_path: stepPath, source_kind: 'step', n_solids: 1 };
  });
  writeJsonAtomic(join(dir, 'project.json'), {
    id: pid,
    title: pid,
    units: 'Metric',
    folder: 'My Projects',
    geometries,
    active_geometry_id: 'g-round',
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

/**
 * Previews of a STEP whose path matches `held` are made (the STEP is read) and then wait
 * until released before they write, as the preview's writers do: making the folder they
 * write to. That is the bug's window: a delete before the STEP is read just fails the
 * preview. The others are written at once. `started` lists the held builds.
 */
function holdPreviews(held) {
  const started = [];
  let release;
  const released = new Promise((r) => (release = r));
  setCadPreviewWriterForTests(async (stepPath, out, write) => {
    if (!held.test(stepPath)) return write(stepPath, out);
    const made = mkdtempSync(join(tmpdir(), 'magnusim-preview-made-'));
    const first = { faces: join(made, 'cad_faces.vtp'), edges: join(made, 'cad_edges.vtp'), meta: join(made, 'cad_preview.json') };
    await write(stepPath, first);
    started.push({ stepPath, out });
    await released;
    const meta = JSON.parse(readFileSync(first.meta, 'utf8'));
    Object.assign(meta, { faces_vtp: out.faces, edges_vtp: out.edges });
    writeFileSync(first.meta, JSON.stringify(meta));
    for (const k of ['faces', 'edges', 'meta']) {
      mkdirSync(dirname(out[k]), { recursive: true });
      cpSync(first[k], out[k]);
    }
    rmSync(made, { recursive: true, force: true });
  });
  const buildStarted = async (n = 1) => {
    const by = Date.now() + 120_000;
    while (started.length < n && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
    assert.ok(started.length >= n, 'the held preview never started');
  };
  return { started, release, buildStarted };
}

const PREVIEW_FILES = ['cad_edges.vtp', 'cad_faces.vtp', 'cad_preview.json'];
const listing = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).join(', ') : '(gone)');

describe('a CAD preview made while its geometry is deleted', () => {
  it('does not bring the deleted geometry folder back', { timeout: 300_000 }, async () => {
    const pid = 'preview-geometry-removed';
    const dir = seedProject(pid);
    const tearDir = join(geometriesRoot(dir), 'Geometry_transient-test-teardrop');
    const held = holdPreviews(/Geometry_transient-test-teardrop/);
    try {
      // Showing the teardrop makes its preview (it has none yet).
      const showing = call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-tear' });
      await held.buildStarted();
      // Made outside the project, not in the geometry's folder.
      assert.ok(!held.started[0].out.faces.startsWith(dir), held.started[0].out.faces);

      const removed = await call('POST', '/api/geometry/remove', { project_id: pid, geometry_id: 'g-tear' });
      assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
      assert.equal(existsSync(tearDir), false);
      held.release();
      const shown = await showing;

      if (existsSync(tearDir)) assert.fail(`${tearDir} is back: ${listing(tearDir)}`);
      assert.deepEqual(readdirSync(geometriesRoot(dir)), ['Geometry_transient-test']);
      assert.equal(shown.statusCode, 404, JSON.stringify(shown.body));
      // The round plate (shown again by the remove) has its preview, naming its own files.
      const roundDir = join(geometriesRoot(dir), 'Geometry_transient-test');
      for (const f of PREVIEW_FILES) assert.ok(existsSync(join(roundDir, f)), `${f} missing: ${listing(roundDir)}`);
      const meta = JSON.parse(readFileSync(join(roundDir, 'cad_preview.json'), 'utf8'));
      assert.equal(meta.faces_vtp, join(roundDir, 'cad_faces.vtp'));
      assert.equal(meta.edges_vtp, join(roundDir, 'cad_edges.vtp'));
    } finally {
      held.release();
      setCadPreviewWriterForTests(null);
    }
  });

  it('does not bring a deleted project folder back', { timeout: 300_000 }, async () => {
    const pid = 'preview-project-deleted';
    const dir = seedProject(pid);
    const held = holdPreviews(/Geometry_transient-test-teardrop/);
    try {
      const showing = call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-tear' });
      await held.buildStarted();

      const deleted = await call('POST', '/api/project/delete', { project_id: pid });
      assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
      held.release();
      const shown = await showing;

      if (existsSync(dir)) assert.fail(`${dir} is back: ${listing(dir)}`);
      assert.notEqual(shown.statusCode, 200, JSON.stringify(shown.body));
    } finally {
      held.release();
      setCadPreviewWriterForTests(null);
    }
  });

  it("does not bring the host geometry's folder back from its modifier's preview", { timeout: 300_000 }, async () => {
    const pid = 'preview-modifier-host-removed';
    const dir = seedProject(pid);
    const tearDir = join(geometriesRoot(dir), 'Geometry_transient-test-teardrop');
    // The teardrop's own preview first (showing it makes it), so only the modifier's is held.
    const shown = await call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-tear' });
    assert.equal(shown.statusCode, 200, JSON.stringify(shown.body));
    const held = holdPreviews(/[\\/]modifiers[\\/]/);
    try {
      const adding = call('POST', '/api/geometry/import', {
        project_id: pid,
        as_modifier: true,
        geometry_id: 'g-tear',
        step_path: join(FIXTURES, 'transient-test.step'),
        filename: 'zone.step',
      });
      await held.buildStarted();
      assert.match(held.started[0].stepPath, /Geometry_transient-test-teardrop[\\/]modifiers[\\/]/);

      const removed = await call('POST', '/api/geometry/remove', { project_id: pid, geometry_id: 'g-tear' });
      assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
      held.release();
      const added = await adding;

      if (existsSync(tearDir)) assert.fail(`${tearDir} is back: ${listing(tearDir)}`);
      assert.deepEqual(readdirSync(geometriesRoot(dir)), ['Geometry_transient-test']);
      assert.notEqual(added.statusCode, 200, JSON.stringify(added.body));
    } finally {
      held.release();
      setCadPreviewWriterForTests(null);
    }
  });
});

describe('a geometry removed and added again from a file of the same name while its preview is made', () => {
  it("gets the new part's preview, not the removed part's", { timeout: 300_000 }, async () => {
    // The new part gets the same folder (Geometry_<name>), so the same preview paths: the
    // removed part's preview must not land there.
    const pid = 'preview-same-name-again';
    const dir = join(root, pid);
    mkdirSync(dir, { recursive: true });
    const first = createGeometryFolder(dir, { id: 'g-first', name: 'Part', original_filename: 'Part.step' });
    cpSync(join(FIXTURES, 'transient-test.step'), join(first.dir, 'source.step'));
    writeJsonAtomic(join(dir, 'project.json'), {
      id: pid,
      title: pid,
      units: 'Metric',
      folder: 'My Projects',
      geometries: [{ id: 'g-first', name: 'Part', original_filename: 'Part.step', step_path: join(first.dir, 'source.step'), source_kind: 'step', n_solids: 1 }],
      active_geometry_id: 'g-first',
    });
    // The changed part: another shape, the same file name.
    const changedDir = join(root, 'changed-part');
    mkdirSync(changedDir, { recursive: true });
    const changed = join(changedDir, 'Part.step');
    cpSync(join(FIXTURES, 'transient-test-teardrop.step'), changed);
    // What each part's preview says (made apart, in a project of its own).
    const facesOf = async (name) => {
      const p = `preview-of-${name}`;
      const d = join(root, p);
      mkdirSync(d, { recursive: true });
      const f = createGeometryFolder(d, { id: 'g', name, original_filename: `${name}.step` });
      cpSync(join(FIXTURES, `${name}.step`), join(f.dir, 'source.step'));
      writeJsonAtomic(join(d, 'project.json'), {
        id: p,
        title: p,
        units: 'Metric',
        folder: 'My Projects',
        geometries: [{ id: 'g', name, original_filename: `${name}.step`, step_path: join(f.dir, 'source.step'), source_kind: 'step', n_solids: 1 }],
        active_geometry_id: 'g',
      });
      const r = await call('POST', '/api/geometry/activate', { project_id: p, geometry_id: 'g' });
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      return readFileSync(join(f.dir, 'cad_faces.vtp'));
    };
    const roundFaces = await facesOf('transient-test');
    const tearFaces = await facesOf('transient-test-teardrop');
    assert.notDeepEqual(roundFaces, tearFaces);

    const held = holdPreviews(/Geometry_Part/);
    try {
      const showing = call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-first' });
      await held.buildStarted();
      const removed = await call('POST', '/api/geometry/remove', { project_id: pid, geometry_id: 'g-first' });
      assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
      // The import makes the new part's preview at the same paths: it waits for the build
      // already running there.
      const adding = call('POST', '/api/geometry/import', { project_id: pid, step_path: changed, filename: 'Part.step' });
      held.release();
      const [, added] = await Promise.all([showing, adding]);
      assert.equal(added.statusCode, 200, JSON.stringify(added.body));
      assert.notEqual(added.body.geometry.id, 'g-first');

      const newDir = join(geometriesRoot(dir), 'Geometry_Part');
      assert.deepEqual(readdirSync(geometriesRoot(dir)), ['Geometry_Part']);
      // The removed part's preview was dropped, and the new one made from the new STEP.
      assert.ok(held.started.length >= 2, 'the new part was never previewed');
      assert.deepEqual(readFileSync(join(newDir, 'cad_faces.vtp')), tearFaces, "the new geometry's folder holds the removed part's preview");
      const meta = JSON.parse(readFileSync(join(newDir, 'cad_preview.json'), 'utf8'));
      assert.equal(meta.faces_vtp, join(newDir, 'cad_faces.vtp'));
    } finally {
      held.release();
      setCadPreviewWriterForTests(null);
    }
  });
});
