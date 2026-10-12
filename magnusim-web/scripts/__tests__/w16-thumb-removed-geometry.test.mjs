/**
 * Activating a geometry renders the Home card thumbnail after the reply. A geometry
 * deleted while that render ran came back as a folder holding only thumb.png: the
 * render wrote into the removed folder (render_geometry_thumb.py makes the folder).
 * With no id.json the tree skipped it, but a new import of the same file got a "_2"
 * folder. A project deleted mid-render came back the same way.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'magnusim-thumb-race-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
// The CAD preview these tests open runs the app's Python, which must be a file path (the
// server checks it exists). CI has no python/.venv (setup-python's interpreter is on PATH):
// name that one, before the server's modules read MAGNUSIM_PYTHON.
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENV = ['Scripts/python.exe', 'bin/python'].some((p) => existsSync(join(WEB, 'python', '.venv', p)));
if (!VENV && !process.env.MAGNUSIM_PYTHON && !process.env.CFDDESK_PYTHON) {
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) process.env.MAGNUSIM_PYTHON = r.stdout.trim();
}
const { createGeometryFolder, geometriesRoot, writeJsonAtomic } = await import('../project-layout.js');
const { handleW16Api, setThumbRendererForTests } = await import('../w16-project-geometry.js');

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'python', 'tests', 'fixtures', 'geometry');

after(() => {
  setThumbRendererForTests(null);
  rmSync(root, { recursive: true, force: true });
});

/** The round and the teardrop hole plate; the round one is active. */
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

/** A thumbnail render that waits until released, then writes as render_geometry_thumb.py does. */
function holdThumbRenders() {
  const started = [];
  let release;
  const released = new Promise((r) => (release = r));
  setThumbRendererForTests(async (args) => {
    started.push(args);
    // Each render's picture is filled with its own number (1 for the first).
    const n = started.length;
    const out = args[args.indexOf('--out') + 1];
    await released;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.alloc(256, n));
  });
  const renderStarted = async () => {
    const by = Date.now() + 120_000;
    while (!started.length && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
    assert.ok(started.length, 'the thumbnail render never started');
  };
  return { started, release, renderStarted };
}

describe('a thumbnail rendered while its geometry is deleted', () => {
  it('does not bring the deleted geometry folder back', { timeout: 300_000 }, async () => {
    const pid = 'thumb-geometry-removed';
    const dir = seedProject(pid);
    const held = holdThumbRenders();
    try {
      const activated = await call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-tear' });
      assert.equal(activated.statusCode, 200, JSON.stringify(activated.body));
      await held.renderStarted();
      const [args] = held.started;
      assert.match(args[args.indexOf('--vtp') + 1], /Geometry_transient-test-teardrop/);

      const removed = await call('POST', '/api/geometry/remove', { project_id: pid, geometry_id: 'g-tear' });
      assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
      held.release();
      // Joins the render still running for the project, and waits for it.
      const thumb = await call('GET', `/api/geometry/thumb?project_id=${pid}`);

      assert.deepEqual(readdirSync(geometriesRoot(dir)), ['Geometry_transient-test']);
      // The Home card shows the geometry that is left.
      assert.equal(thumb.statusCode, 200, JSON.stringify(thumb.body));
      assert.ok(existsSync(join(geometriesRoot(dir), 'Geometry_transient-test', 'thumb.png')));
    } finally {
      held.release();
      setThumbRendererForTests(null);
    }
  });

  it('does not bring a deleted project folder back', { timeout: 300_000 }, async () => {
    const pid = 'thumb-project-deleted';
    const dir = seedProject(pid);
    const held = holdThumbRenders();
    try {
      const activated = await call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-tear' });
      assert.equal(activated.statusCode, 200, JSON.stringify(activated.body));
      await held.renderStarted();

      const deleted = await call('POST', '/api/project/delete', { project_id: pid });
      assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
      held.release();
      const thumb = await call('GET', `/api/geometry/thumb?project_id=${pid}`);

      if (existsSync(dir)) assert.fail(`${dir} is back: ${readdirSync(dir, { recursive: true }).join(', ')}`);
      assert.equal(thumb.statusCode, 404, JSON.stringify(thumb.body));
    } finally {
      held.release();
      setThumbRendererForTests(null);
    }
  });
});

describe('a geometry removed and added again from a file of the same name', () => {
  it("does not get the removed part's thumbnail", { timeout: 300_000 }, async () => {
    // Daniel: a part removed and a changed part of the same file name added. The new one
    // gets the same folder (Geometry_<name>), so the same thumb.png path.
    const pid = 'thumb-same-name-again';
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

    const held = holdThumbRenders();
    try {
      const activated = await call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-first' });
      assert.equal(activated.statusCode, 200, JSON.stringify(activated.body));
      await held.renderStarted();

      const removed = await call('POST', '/api/geometry/remove', { project_id: pid, geometry_id: 'g-first' });
      assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
      const added = await call('POST', '/api/geometry/import', { project_id: pid, step_path: changed, filename: 'Part.step' });
      assert.equal(added.statusCode, 200, JSON.stringify(added.body));
      const newDir = join(geometriesRoot(dir), 'Geometry_Part');
      assert.deepEqual(readdirSync(geometriesRoot(dir)), ['Geometry_Part']);
      assert.notEqual(added.body.geometry.id, 'g-first');

      held.release();
      const thumb = await call('GET', `/api/geometry/thumb?project_id=${pid}`);
      assert.equal(thumb.statusCode, 200, JSON.stringify(thumb.body));
      // The first render drew the removed part (its picture is all 1s): neither the
      // reply nor the new folder's thumb.png may be it.
      assert.ok(held.started.length >= 2, 'the new part was never rendered');
      assert.notEqual(thumb.body[0], 1, "the Home card got the removed part's thumbnail");
      assert.notEqual(readFileSync(join(newDir, 'thumb.png'))[0], 1, "the new geometry's folder holds the removed part's thumbnail");
    } finally {
      held.release();
      setThumbRendererForTests(null);
    }
  });
});

describe("the Home card's thumbnail address", () => {
  it("is not the removed part's address while the new part's picture is made", { timeout: 300_000 }, async () => {
    // The browser keeps a thumbnail a day. While a picture was being made the address was
    // ...&v=pending for any geometry, so after a part was removed and another added, the
    // Home card could show the removed part's picture from the browser's cache.
    const pid = 'thumb-address-same-name';
    const dir = join(root, pid);
    mkdirSync(dir, { recursive: true });
    const first = createGeometryFolder(dir, { id: 'g-old', name: 'Part', original_filename: 'Part.step' });
    cpSync(join(FIXTURES, 'transient-test.step'), join(first.dir, 'source.step'));
    writeJsonAtomic(join(dir, 'project.json'), {
      id: pid,
      title: pid,
      units: 'Metric',
      folder: 'My Projects',
      geometries: [{ id: 'g-old', name: 'Part', original_filename: 'Part.step', step_path: join(first.dir, 'source.step'), source_kind: 'step', n_solids: 1 }],
      active_geometry_id: 'g-old',
    });
    const changedDir = join(root, 'changed-part-address');
    mkdirSync(changedDir, { recursive: true });
    const changed = join(changedDir, 'Part.step');
    cpSync(join(FIXTURES, 'transient-test-teardrop.step'), changed);
    const cardUrl = async () => {
      const listed = await call('GET', '/api/projects');
      assert.equal(listed.statusCode, 200, JSON.stringify(listed.body));
      const card = listed.body.projects.find((p) => p.id === pid);
      assert.ok(card && card.thumb_url, JSON.stringify(card));
      return card.thumb_url;
    };

    const held = holdThumbRenders();
    try {
      // Both pictures are still being made when Home lists the project.
      const activated = await call('POST', '/api/geometry/activate', { project_id: pid, geometry_id: 'g-old' });
      assert.equal(activated.statusCode, 200, JSON.stringify(activated.body));
      await held.renderStarted();
      const before = await cardUrl();
      const removed = await call('POST', '/api/geometry/remove', { project_id: pid, geometry_id: 'g-old' });
      assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
      const added = await call('POST', '/api/geometry/import', { project_id: pid, step_path: changed, filename: 'Part.step' });
      assert.equal(added.statusCode, 200, JSON.stringify(added.body));
      const after = await cardUrl();
      assert.notEqual(after, before, "the new part has the removed part's thumbnail address");

      held.release();
      // An answer to an address asked for before the picture was made is not kept.
      const pending = await call('GET', after);
      assert.equal(pending.statusCode, 200, JSON.stringify(pending.body));
      assert.equal(pending.headers['cache-control'], 'no-store');
      // The made picture's address is new again, and that one is kept.
      const made = await cardUrl();
      assert.notEqual(made, after);
      const kept = await call('GET', made);
      assert.equal(kept.statusCode, 200, JSON.stringify(kept.body));
      assert.match(String(kept.headers['cache-control']), /max-age/);
    } finally {
      held.release();
      setThumbRendererForTests(null);
    }
  });
});
