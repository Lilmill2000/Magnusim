/**
 * GET /api/geometry/cad never holds its request for a preview being made. A plain part whose
 * preview (cad_faces.vtp, cad_edges.vtp, cad_preview.json) is missing is made when it is
 * shown, and every request for it (the viewport asks for its faces, its edges and its face
 * table twice) waited for the whole build, up to 3 minutes. The browser opens at most 6
 * connections to the app for all of its tabs, so two tabs on two such parts froze every tab.
 * Now a build not done in CAD_WAIT_MS is answered 202 {pending, code: preview_pending} with
 * Retry-After: 1 (HEAD too, with no body) while it goes on, once per preview however many
 * ask; the page asks again. A build that failed is remembered for its STEP file as it was
 * (a minute at most), so the next ask gets its 500 instead of starting it again; a changed
 * STEP is made again. A modifier's preview (?modifier_id) is answered the same way.
 */
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'magnusim-cad-wait-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
// The previews these tests make run the app's Python (see w16-preview-removed-geometry.test.mjs).
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENV = ['Scripts/python.exe', 'bin/python'].some((p) => existsSync(join(WEB, 'python', '.venv', p)));
if (!VENV && !process.env.MAGNUSIM_PYTHON && !process.env.CFDDESK_PYTHON) {
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) process.env.MAGNUSIM_PYTHON = r.stdout.trim();
}
const { createGeometryFolder, writeJsonAtomic } = await import('../project-layout.js');
const { CAD_WAIT_MS, handleW16Api, setCadPreviewWriterForTests, setThumbRendererForTests } = await import('../w16-project-geometry.js');

const FIXTURES = join(WEB, 'python', 'tests', 'fixtures', 'geometry');

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

/** A project with one plate and no preview yet; with `modifier`, a zone on it (its own STEP). */
function seedProject(pid, { modifier = false } = {}) {
  const dir = join(root, pid);
  mkdirSync(dir, { recursive: true });
  const folder = createGeometryFolder(dir, { id: 'g-plate', name: 'transient-test', original_filename: 'transient-test.step' });
  const stepPath = join(folder.dir, 'source.step');
  cpSync(join(FIXTURES, 'transient-test.step'), stepPath);
  const part = { id: 'g-plate', name: 'transient-test', original_filename: 'transient-test.step', step_path: stepPath, source_kind: 'step', n_solids: 1 };
  let modStep = '';
  if (modifier) {
    modStep = join(folder.dir, 'modifiers', 'mod-zone', 'source.step');
    mkdirSync(dirname(modStep), { recursive: true });
    cpSync(join(FIXTURES, 'transient-test-teardrop.step'), modStep);
    part.modifiers = [{ id: 'mod-zone', name: 'zone', step_path: modStep }];
  }
  writeJsonAtomic(join(dir, 'project.json'), { id: pid, title: pid, units: 'Metric', folder: 'My Projects', geometries: [part], active_geometry_id: 'g-plate' });
  return { dir, stepPath, modStep };
}

/** A request to the geometry routes, answered as the server answers it: {status, headers, body, ms}. */
async function call(method, path) {
  const url = new URL(path, 'http://localhost');
  const t0 = performance.now();
  const res = {
    statusCode: 200,
    body: undefined,
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
      res.body = method === 'HEAD' ? undefined : doc;
      return true;
    },
    readJsonBody: async () => ({}),
  };
  await handleW16Api({ method, headers: {} }, res, url, url.pathname.split('/').filter(Boolean), helpers);
  return { status: res.statusCode, headers: res.headers, body: res.body, ms: performance.now() - t0 };
}

/** The real writer, held until released; `builds` counts the builds started. */
function holdWriter({ fail = false } = {}) {
  let release;
  const released = new Promise((r) => (release = r));
  const state = { builds: 0, release: () => release() };
  setCadPreviewWriterForTests(async (stepPath, out, write) => {
    state.builds += 1;
    await released;
    if (fail) throw new Error('the part could not be read');
    return write(stepPath, out);
  });
  return state;
}

/** Ask as the page does (one request at a time, every 200 ms here) until the answer is not 202. */
async function askUntilDone(path, timeoutMs = 120_000) {
  const by = Date.now() + timeoutMs;
  for (;;) {
    const r = await call('GET', path);
    if (r.status !== 202) return r;
    assert.ok(Date.now() < by, `${path} still 202 after ${timeoutMs} ms`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

const settle = () => new Promise((done) => setTimeout(done, 50));

/** The answer, or {status: 'no answer'} when the request is still held after `ms`. */
function answeredWithin(pending, ms = 2000) {
  let timer;
  const late = new Promise((done) => {
    timer = setTimeout(() => done({ status: `no answer within ${ms} ms`, headers: {}, body: undefined, ms }), ms);
  });
  return Promise.race([pending, late]).finally(() => clearTimeout(timer));
}

function assertPending(r, what) {
  assert.equal(r.status, 202, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(String(r.headers['retry-after']), '1', what);
  assert.equal(r.headers['cache-control'], 'no-store', what);
  assert.ok(r.ms < (CAD_WAIT_MS ?? 250) + 400, `${what} answered in ${Math.round(r.ms)} ms`);
}

describe('GET /api/geometry/cad while the preview is being made', () => {
  it('answers every part 202 at once (HEAD too), with one build; then 200 with the files', { timeout: 300_000 }, async () => {
    const pid = 'cad-wait-pending';
    seedProject(pid);
    const held = holdWriter();
    try {
      const q = `project_id=${pid}`;
      const asks = [
        ['GET', `/api/geometry/cad?${q}&part=preview`],
        ['GET', `/api/geometry/cad?${q}&geometry_id=g-plate&part=preview&v=7&t=1`],
        ['GET', `/api/geometry/cad?${q}&geometry_id=g-plate&part=faces&v=7&t=1`],
        ['GET', `/api/geometry/cad?${q}&geometry_id=g-plate&part=edges&v=7&t=1`],
        ['HEAD', `/api/geometry/cad?${q}&geometry_id=g-plate&part=faces`],
      ];
      const answers = await Promise.all(asks.map(([m, p]) => answeredWithin(call(m, p))));
      answers.forEach((r, i) => assertPending(r, asks[i].join(' ')));
      for (const r of answers.slice(0, 4)) {
        assert.equal(r.body.pending, true);
        assert.equal(r.body.code, 'preview_pending');
        assert.equal(r.body.ok, false);
      }
      assert.equal(answers[4].body, undefined, 'a HEAD has no body');
      await settle();
      assert.equal(held.builds, 1, 'one build for every request');
      // Asked again while it is made: still 202, still one build.
      assertPending(await answeredWithin(call('GET', `/api/geometry/cad?${q}&part=faces`)), 'a second ask');
      assert.equal(held.builds, 1);
      held.release();
      const meta = await askUntilDone(`/api/geometry/cad?${q}&geometry_id=g-plate&part=preview`);
      assert.equal(meta.status, 200, JSON.stringify(meta.body));
      assert.ok(Number(meta.body.n_faces) > 0, JSON.stringify(meta.body).slice(0, 200));
      for (const part of ['faces', 'edges']) {
        const r = await call('GET', `/api/geometry/cad?${q}&geometry_id=g-plate&part=${part}`);
        assert.equal(r.status, 200, part);
        assert.ok(Buffer.isBuffer(r.body) && r.body.length > 80, `${part}: ${r.body && r.body.length} bytes`);
        assert.equal(r.headers['content-type'], 'application/xml');
      }
      assert.equal(held.builds, 1);
    } finally {
      held.release();
      setCadPreviewWriterForTests(null);
    }
  });

  it('a build that failed answers 500 to the next ask without a second build; a changed STEP is made again', { timeout: 300_000 }, async () => {
    const pid = 'cad-wait-failed';
    const { stepPath } = seedProject(pid);
    const path = `/api/geometry/cad?project_id=${pid}&geometry_id=g-plate&part=faces`;
    const held = holdWriter({ fail: true });
    try {
      assertPending(await answeredWithin(call('GET', path)), 'while it is made');
      held.release();
      const failed = await askUntilDone(path);
      assert.equal(failed.status, 500, JSON.stringify(failed.body));
      assert.match(String(failed.body.error), /CAD preview failed/);
      const again = await call('GET', `/api/geometry/cad?project_id=${pid}&part=preview`);
      assert.equal(again.status, 500, 'asked again: the same failure');
      assert.equal(held.builds, 1, 'not made again while its STEP is the same');

      // The STEP changes (a new file of the same name): made again, and this time it is made.
      const ok = holdWriter();
      appendFileSync(stepPath, '\n');
      ok.release();
      const made = await askUntilDone(path);
      assert.equal(made.status, 200, JSON.stringify(made.body));
      assert.equal(ok.builds, 1);
    } finally {
      setCadPreviewWriterForTests(null);
    }
  });

  it("answers a modifier's preview 202 while it is made, then 200", { timeout: 300_000 }, async () => {
    const pid = 'cad-wait-modifier';
    seedProject(pid, { modifier: true });
    // The plate's own preview first, so only the modifier's is held.
    const plate = await askUntilDone(`/api/geometry/cad?project_id=${pid}&geometry_id=g-plate&part=preview`);
    assert.equal(plate.status, 200, JSON.stringify(plate.body));
    const held = holdWriter();
    try {
      const q = `project_id=${pid}&geometry_id=g-plate&modifier_id=mod-zone`;
      const answers = await Promise.all(['faces', 'edges', 'meta'].map((part) => answeredWithin(call('GET', `/api/geometry/cad?${q}&part=${part}`))));
      answers.forEach((r, i) => assertPending(r, `modifier ${['faces', 'edges', 'meta'][i]}`));
      assert.equal(answers[0].body.code, 'preview_pending');
      assertPending(await answeredWithin(call('HEAD', `/api/geometry/cad?${q}&part=faces`)), 'modifier HEAD');
      await settle();
      assert.equal(held.builds, 1);
      held.release();
      const faces = await askUntilDone(`/api/geometry/cad?${q}&part=faces`);
      assert.equal(faces.status, 200, JSON.stringify(faces.body));
      assert.ok(Buffer.isBuffer(faces.body) && faces.body.length > 80);
      const meta = await call('GET', `/api/geometry/cad?${q}&part=meta`);
      assert.equal(meta.status, 200);
      assert.ok(Number(meta.body.n_faces) > 0);
    } finally {
      held.release();
      setCadPreviewWriterForTests(null);
    }
  });
});
