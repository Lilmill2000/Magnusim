// Editing a project geometry (host API 1.7): the geometry actions' routes and the adoption,
// through the real routes and the real Python worker (fixture plugin edit-demo):
// - the resolver makes one study, then opens it again; the page's reads (target, source,
//   faces) answer the plain geometry;
// - the study's first link updates THAT geometry (same id, rev 1, the host's question
//   first when a study has setup on it), keeps its source files in link/original/, and
//   carries a boundary condition on the top to the pulled top by the original's names;
// - a bad originalNames file is refused at the call (a wrong sha, every row naming another face,
//   no face table); one row naming another face loses its name: its BC never lands on that face;
// - a second link of the study while its adoption runs goes on as an ordinary update;
// - another study's link is `adopted`; a bad project id is a 400;
// - the swap keeps the originals and its undo puts them back.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPORTS, WEB, linkHarness, sha256 } from './link-harness.js';

const FX = join(WEB, 'python', 'tests', 'fixtures', 'edit-plugins', 'edit-demo', 'workspace', 'fixtures');
const fx = (name) => readFileSync(join(FX, name));

/** @type {any} */
let h;

before(async () => {
  h = await linkHarness({ name: 'link-adopt', plugins: ['edit-demo'] });
});
after(async () => {
  await h?.close();
});

/** A project with box.step imported as a plain geometry; its id and folder. */
async function importBox(pid) {
  h.project(pid);
  const r = await h.post('/api/geometry/import', { project_id: pid, step_path: join(FX, 'box.step'), filename: 'box.step' });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  const gid = r.body.added.id;
  return { gid, dir: h.geomDir(pid, gid) };
}

/** The face of a geometry folder's table whose normal points along +z (or -z). */
function faceAlong(dir, z) {
  const meta = JSON.parse(readFileSync(join(dir, 'cad_preview.json'), 'utf8'));
  const f = meta.faces.find((x) => Array.isArray(x.normal) && Math.abs(x.normal[2] - z) < 1e-6);
  return { id: f.id, label: `face ${f.id}@Body1`, z: f.centroid[2] };
}

/** A simulation study on the geometry with two boundary conditions. */
function studyWithBcs(dir, gid, faces) {
  const sdir = join(dir, 'simulations', 'Study_1');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, 'id.json'), JSON.stringify({ id: 'sim-1', name: 'Study 1', geometry_id: gid, kind: 'simulation' }));
  for (const [name, face] of Object.entries(faces)) {
    const bdir = join(sdir, 'boundary_conditions', `BC_${name}`);
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, 'bc.json'), JSON.stringify({ id: `bc-${name.toLowerCase()}`, name, bc_type: 'Velocity inlet', faces: [face] }));
  }
  return sdir;
}

const bc = (sdir, name) => JSON.parse(readFileSync(join(sdir, 'boundary_conditions', `BC_${name}`, 'bc.json'), 'utf8'));

async function open(pid, gid) {
  const r = await h.post('/api/geometry-actions/open', { project_id: pid, geometry_id: gid, plugin: 'edit-demo', study_kind: 'demo' });
  return r;
}

/** The edit: the pulled box, its names, and (by default) the original's names. */
async function linkEdit(pid, sid, { originals = 'box.original_names.json', sourceVersion = 1, basedOnRev = null, shapeBuf = null, namesBuf = null } = {}) {
  const shape = h.put(pid, sid, shapeBuf || fx('box-pulled.bbrep'), 'shape.bbrep', 'edit-demo');
  const names = h.put(pid, sid, namesBuf || fx('box-pulled.face_names.json'), 'names.json', 'edit-demo');
  const orig = originals ? h.put(pid, sid, fx(originals), 'original_names.json', 'edit-demo') : null;
  return h.link(pid, sid, {
    plugin: 'edit-demo',
    shapeFile: fx('box-pulled.bbrep'),
    names: null,
    sourceVersion,
    basedOnRev,
    extra: { shape: { ...shape, format: 'brep' }, face_names: names, ...(orig ? { original_names: orig } : {}) },
  });
}

describe('the geometry action and the page reads', () => {
  it('makes one study, then opens it again; target, source and faces answer the plain geometry', async () => {
    const { gid, dir } = await importBox('p-reads2');
    const a = await open('p-reads2', gid);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.created, true);
    assert.equal(a.body.title, 'box');
    const b = await open('p-reads2', gid);
    assert.equal(b.body.study_id, a.body.study_id);
    assert.equal(b.body.created, false);
    const sid = a.body.study_id;
    const q = `project_id=p-reads2&plugin=edit-demo&study_id=${sid}`;
    const target = await h.get(`/api/plugin-geometry/target?${q}`);
    assert.deepEqual(target.body.geometry, { id: gid, name: 'box', format: 'step', fileName: 'box.step', linked: false, rev: 0, bodies: 1, faces: 6 });
    const src = await fetch(`${h.base}/api/plugin-geometry/source?${q}&format=step`);
    const bytes = Buffer.from(await src.arrayBuffer());
    assert.equal(src.status, 200);
    assert.equal(src.headers.get('x-sha256'), sha256(fx('box.step')));
    assert.equal(sha256(bytes), sha256(fx('box.step')));
    assert.equal(decodeURIComponent(src.headers.get('x-file-name')), 'box.step');
    assert.equal(src.headers.get('x-adopted'), '0');
    assert.equal(Number(src.headers.get('content-length')), bytes.length);
    const bad = await h.get(`/api/plugin-geometry/source?${q}&format=iges`);
    assert.equal(bad.body.code, 'unsupported_format');
    const top = faceAlong(dir, 1);
    studyWithBcs(dir, gid, { Inlet: top.label });
    const faces = await h.get(`/api/plugin-geometry/faces?${q}`);
    assert.equal(faces.status, 200);
    assert.equal(faces.body.faces.length, 6);
    assert.equal(faces.body.sourceSha256, sha256(fx('box.step')));
    assert.deepEqual(faces.body.faces.find((f) => f.index === top.id).uses, [{ studyId: 'sim-1', studyTitle: 'Study 1', kind: 'bc', item: 'Inlet' }]);
    // The fixture's original names are in this order (the host's reader and numbering).
    const names = JSON.parse(fx('box.original_names.json').toString('utf8'));
    assert.equal(names.faces.find((f) => f.index === top.id).name, 'F:box:+z');
    // The tree offers the action, enabled; an unknown plugin's open is plugin_off.
    const tree = await h.get('/api/project/tree?project_id=p-reads2');
    const node = tree.body.geometries.find((g) => g.id === gid);
    const act = node.edit_actions.find((x) => x.plugin === 'edit-demo');
    assert.equal(node.format, 'step');
    assert.equal(act.enabled, true);
    const off = await h.post('/api/geometry-actions/open', { project_id: 'p-reads2', geometry_id: gid, plugin: 'nope', study_kind: 'demo' });
    assert.equal(off.status, 404);
    assert.equal(off.body.code, 'plugin_off');
  });
});

describe('the adoption', () => {
  it('updates the same geometry after the question, keeps the original, and the BCs follow by name', async () => {
    const pid = 'p-adopt';
    const { gid, dir } = await importBox(pid);
    const top = faceAlong(dir, 1);
    const bottom = faceAlong(dir, -1);
    const sdir = studyWithBcs(dir, gid, { Inlet: top.label, Wall: bottom.label });
    const sid = (await open(pid, gid)).body.study_id;
    const linked0 = await h.get(`/api/plugin-geometry/linked?project_id=${pid}&plugin=edit-demo&study_id=${sid}`);
    assert.equal(linked0.body.linked, null, 'before its first link the study links nothing');
    const r = await linkEdit(pid, sid);
    // The study has setup on the geometry: the host asked (overwrite answered by the harness).
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.ok(r.body.asked, 'the host asked first');
    assert.equal(r.body.asked.geometry.id, gid);
    assert.equal(r.body.asked.new_name, 'box v2');
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(rec.result.geometryId, gid);
    assert.equal(rec.result.created, false);
    assert.equal(rec.result.change, 'shape');
    assert.equal(rec.result.rev, 1);
    assert.equal(rec.result.fromRev, 0);
    assert.equal(rec.result.adopted, true);
    assert.equal(rec.result.unverified, 0);
    assert.equal(rec.result.lost.length, 0);
    // The same folder, now linked to the study.
    assert.equal(h.geomDir(pid, gid), dir);
    const id = JSON.parse(readFileSync(join(dir, 'id.json'), 'utf8'));
    assert.equal(id.source.plugin, 'edit-demo');
    assert.equal(id.source.study_id, sid);
    assert.equal(id.source.adopted, true);
    assert.equal(id.original_filename, 'box.step');
    const state = h.state(pid, gid);
    assert.equal(state.rev, 1);
    assert.equal(state.name, 'box');
    assert.equal(state.adopted.from.file_name, 'box.step');
    // The original is kept, with its hash.
    const kept = join(dir, 'link', 'original', 'source.step');
    assert.ok(existsSync(kept));
    assert.equal(sha256(readFileSync(kept)), sha256(fx('box.step')));
    const orig = JSON.parse(readFileSync(join(dir, 'link', 'original', 'original.json'), 'utf8'));
    assert.equal(orig.sha256, sha256(fx('box.step')));
    assert.equal(existsSync(join(dir, 'source.step')), false, 'the STEP of the old shape is not in the folder any more');
    assert.ok(existsSync(join(dir, 'source.bbrep')));
    // Inlet is on the new top (30 mm up), Wall stays on the bottom.
    const newTop = faceAlong(dir, 1);
    assert.ok(Math.abs(newTop.z - 30) < 1e-6, String(newTop.z));
    assert.deepEqual(bc(sdir, 'Inlet').faces, [newTop.label]);
    assert.deepEqual(bc(sdir, 'Wall').faces, [faceAlong(dir, -1).label]);
    assert.equal(bc(sdir, 'Inlet').geometry_rev, 1);
    // LinkedGeometry says it was adopted, and what from.
    const linked = await h.get(`/api/plugin-geometry/linked?project_id=${pid}&plugin=edit-demo&study_id=${sid}`);
    assert.equal(linked.body.linked.geometryId, gid);
    assert.equal(linked.body.linked.adopted, true);
    assert.deepEqual(linked.body.linked.original, { fileName: 'box.step', format: 'step', sha256: sha256(fx('box.step')) });
    // The project record keeps the file name; the page's source is the kept original now.
    const proj = JSON.parse(readFileSync(join(h.projects, pid, 'project.json'), 'utf8'));
    const row = proj.geometries.find((g) => g.id === gid);
    assert.equal(row.original_filename, 'box.step');
    assert.match(row.note, /^Edited in box \(from box\.step\)\.$/);
    const q = `project_id=${pid}&plugin=edit-demo&study_id=${sid}`;
    const src = await fetch(`${h.base}/api/plugin-geometry/source?${q}`);
    assert.equal(src.headers.get('x-adopted'), '1');
    assert.equal(sha256(Buffer.from(await src.arrayBuffer())), sha256(fx('box.step')));
    // The action opens the same study (rule 1) and the tree shows the original.
    assert.equal((await open(pid, gid)).body.study_id, sid);
    const node = (await h.get(`/api/project/tree?project_id=${pid}`)).body.geometries.find((g) => g.id === gid);
    assert.equal(node.rev, 1);
    assert.equal(node.original.file_name, 'box.step');
    assert.equal(node.original.present, true);
    // "Add the original as a new geometry": imported beside it.
    const back = await h.post('/api/geometry/original/import', { project_id: pid, geometry_id: gid });
    assert.equal(back.status, 200, JSON.stringify(back.body).slice(0, 300));
    assert.equal(back.body.added.name, 'box (original)');
    assert.equal(sha256(readFileSync(join(h.geomDir(pid, back.body.added.id), 'source.step'))), sha256(fx('box.step')));
  });

  it('with no study setup there is no question, and the next edit is an ordinary update', async () => {
    const pid = 'p-plain';
    const { gid, dir } = await importBox(pid);
    const sid = (await open(pid, gid)).body.study_id;
    const r = await linkEdit(pid, sid, { originals: null });
    assert.equal(r.status, 202);
    assert.equal(r.body.asked, undefined);
    assert.equal(r.body.queued, true);
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(rec.result.geometryId, gid);
    assert.equal(h.state(pid, gid).rev, 1);
    // A second edit is an ordinary update of the linked geometry (no original names read).
    const again = await linkEdit(pid, sid, { sourceVersion: 2, basedOnRev: 1 });
    assert.ok([200, 202].includes(again.status), JSON.stringify(again.body));
    if (again.status === 202) assert.equal((await h.until(again.body.job_id)).status, 'done');
    assert.ok(existsSync(join(dir, 'link', 'original', 'source.step')));
  });

  it('refuses a bad originalNames file at the call, and another study taking it over', async () => {
    const pid = 'p-refuse';
    const { gid } = await importBox(pid);
    const sid = (await open(pid, gid)).body.study_id;
    const bad = await linkEdit(pid, sid, { originals: 'box.bad_names.json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'bad_face_names');
    assert.match(bad.body.error, /^originalNames does not describe box: /);
    // A second study of the same kind that edits it too (made by hand: the resolver opens the first).
    const other = await h.post('/api/plugin-studies/create', { project_id: pid, plugin: 'edit-demo', kind: 'demo', title: 'Other' });
    const oid = other.body.study.id;
    const f = join(h.projects, pid, 'plugins', 'edit-demo', 'studies', oid, 'study.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), edits_geometry: { id: gid, name: 'box', at: 'x' } }));
    const first = await linkEdit(pid, sid);
    assert.equal((await h.until(first.body.job_id)).status, 'done');
    const late = await linkEdit(pid, oid);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'adopted');
    assert.equal(late.body.error, 'box is already edited in box.');
  });

  it('a removed geometry makes the first link a create', async () => {
    const pid = 'p-gone';
    const { gid, dir } = await importBox(pid);
    const sid = (await open(pid, gid)).body.study_id;
    rmSync(dir, { recursive: true, force: true });
    const r = await linkEdit(pid, sid);
    assert.equal(r.status, 202);
    assert.equal(r.body.created, true);
    assert.notEqual(r.body.geometry_id, gid);
    assert.equal((await h.until(r.body.job_id)).status, 'done');
  });
});

describe('originalNames rows are checked face by face (B1)', () => {
  it('a file whose every row names another face is refused at the call', async () => {
    const pid = 'p-rotated';
    const { gid } = await importBox(pid);
    const sid = (await open(pid, gid)).body.study_id;
    const r = await linkEdit(pid, sid, { originals: 'box.rotated_names.json' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'bad_face_names');
    assert.equal(r.body.error, "originalNames: 6 of 6 faces don't match box");
  });

  it("one row naming another face loses its name: the BC is lost (reported), never put on that face", async () => {
    const pid = 'p-one-wrong';
    const { gid, dir } = await importBox(pid);
    const top = faceAlong(dir, 1);
    const minusX = (() => {
      const meta = JSON.parse(readFileSync(join(dir, 'cad_preview.json'), 'utf8'));
      const f = meta.faces.find((x) => x.normal[0] < -0.5);
      return `face ${f.id}@Body1`;
    })();
    const sdir = studyWithBcs(dir, gid, { Inlet: top.label });
    const sid = (await open(pid, gid)).body.study_id;
    const r = await linkEdit(pid, sid, { originals: 'box.one_wrong_names.json' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(rec.result.unverified, 1);
    assert.equal(rec.result.lost.length, 1);
    assert.equal(rec.result.lost[0].old, top.label);
    const inlet = bc(sdir, 'Inlet');
    assert.deepEqual(inlet.faces, []);
    assert.notDeepEqual(inlet.faces, [minusX]);
    assert.equal(inlet.lost_faces[0].old, top.label);
  });

  it('no face table: refused not_ready at the call, nothing mapped', async () => {
    const pid = 'p-no-table';
    const { gid, dir } = await importBox(pid);
    const sid = (await open(pid, gid)).body.study_id;
    const held = join(dir, 'cad_preview.held.json');
    renameSync(join(dir, 'cad_preview.json'), held);
    try {
      const r = await linkEdit(pid, sid);
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'not_ready');
      assert.equal(r.body.retryAfter, 3);
      assert.match(r.body.error, /^Magnusim has not read the faces of box yet/);
    } finally {
      renameSync(held, join(dir, 'cad_preview.json'));
    }
  });
});

describe('a second link while the adoption runs (B2)', () => {
  it('goes on as an ordinary update of the geometry the first one took over', async () => {
    const pid = 'p-second';
    const { gid } = await importBox(pid);
    const sid = (await open(pid, gid)).body.study_id;
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    let held = false;
    h.overrides.set('geometry.plan', async (params, real, t) => {
      if (params.adopt) {
        held = true;
        await gate;
      }
      return real.call('geometry.plan', params, t);
    });
    try {
      const first = await linkEdit(pid, sid);
      assert.equal(first.status, 202);
      await h.waitFor(() => held, 60_000, 'the adoption reached its plan');
      // A newer design while the first is held: another shape (link-demo's v2) and its names.
      const second = await linkEdit(pid, sid, {
        sourceVersion: 2,
        originals: null,
        shapeBuf: readFileSync(join(EXPORTS, 'v2.bbrep')),
        namesBuf: readFileSync(join(EXPORTS, 'v2.face_names.json')),
      });
      assert.equal(second.status, 202, JSON.stringify(second.body));
      release();
      const a = await h.until(first.body.job_id);
      assert.equal(a.status, 'done', a.error);
      assert.equal(a.result.adopted, true);
      // The app's slot release moves the queue on (its boot hook); this harness kicks it.
      await h.post('/api/compute-queue/kick', { project_id: pid });
      const b = await h.until(second.body.job_id);
      assert.equal(b.status, 'done', `${b.status}: ${b.error}`);
      assert.equal(b.error, null);
      assert.equal(b.result.geometryId, gid);
      assert.equal(b.result.rev, 2);
      assert.equal(b.result.fromRev, 1);
      assert.equal(b.result.adopted, undefined);
      const state = h.state(pid, gid);
      assert.equal(state.rev, 2);
      assert.equal(state.source_version, 2);
      assert.ok(state.adopted, 'the adoption stays recorded');
    } finally {
      release();
      h.overrides.delete('geometry.plan');
    }
  });
});

describe("the question names the geometry, not the Part's (2) title (CAD-flow S3)", () => {
  it('asks "box has a new shape" and offers "box v2" for the Part "box (2)"; the geometry keeps its name', async () => {
    const pid = 'p-names';
    const first = await importBox(pid);
    const r2 = await h.post('/api/geometry/import', { project_id: pid, step_path: join(FX, 'box.step'), filename: 'box.step' });
    const gid = r2.body.added.id;
    const dir = h.geomDir(pid, gid);
    assert.notEqual(gid, first.gid);
    await open(pid, first.gid);
    const opened = (await open(pid, gid)).body;
    assert.equal(opened.title, 'box (2)');
    studyWithBcs(dir, gid, { Inlet: faceAlong(dir, 1).label });
    const asked = await linkEdit(pid, opened.study_id).then((r) => r);
    assert.ok(asked.body.asked, JSON.stringify(asked.body));
    assert.equal(asked.body.asked.edits, true);
    assert.equal(asked.body.asked.geometry.name, 'box');
    assert.equal(asked.body.asked.new_name, 'box v2');
    assert.equal((await h.until(asked.body.job_id)).status, 'done');
    assert.equal(h.state(pid, gid).name, 'box');
    // A later update of the adopted geometry keeps its name too.
    const later = await linkEdit(pid, opened.study_id, { sourceVersion: 2, basedOnRev: 1, originals: null, shapeBuf: readFileSync(join(EXPORTS, 'v2.bbrep')), namesBuf: readFileSync(join(EXPORTS, 'v2.face_names.json')) });
    if (later.body.job_id) assert.equal((await h.until(later.body.job_id)).status, 'done');
    assert.equal(h.state(pid, gid).name, 'box');
  });
});

describe('the routes refuse a bad project id', () => {
  it('400 for a traversal, 404 for no such project', async () => {
    const bad = await h.post('/api/geometry-actions/open', { project_id: '..', geometry_id: 'g', plugin: 'edit-demo', study_kind: 'demo' });
    assert.equal(bad.status, 400);
    const none = await h.post('/api/geometry-actions/open', { project_id: 'no-such-project', geometry_id: 'g', plugin: 'edit-demo', study_kind: 'demo' });
    assert.equal(none.status, 404);
    const src = await h.get('/api/plugin-geometry/source?project_id=..&plugin=edit-demo&study_id=st-1');
    assert.equal(src.status, 400);
  });
});

describe('the swap of an adoption', () => {
  it('moves the source files to link/original and its undo puts them back', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'magnusim-adopt-swap-'));
    try {
      const pdir = join(tmp, 'p');
      const g = join(pdir, 'geometries', 'Geometry_box');
      const stage = join(pdir, '.magnusim-staging', 'link-gl-x');
      mkdirSync(join(stage, 'new'), { recursive: true });
      mkdirSync(g, { recursive: true });
      for (const [f, t] of [['source.step', 'step'], ['original.igs', 'igs'], ['cad_preview.json', 'old'], ['Body1.stl', 'stl']]) writeFileSync(join(g, f), t);
      for (const [f, t] of [['source.bbrep', 'new'], ['cad_preview.json', 'new']]) writeFileSync(join(stage, 'new', f), t);
      const moved = h.job.swapOnce({ projectDir: pdir, geomDir: g, stage, job: 'gl-x', fromRev: 0, rev: 1, change: 'shape', adopt: true });
      assert.equal(moved.ok, true);
      assert.equal(readFileSync(join(g, 'link', 'original', 'source.step'), 'utf8'), 'step');
      assert.equal(readFileSync(join(g, 'link', 'original', 'original.igs'), 'utf8'), 'igs');
      assert.equal(readFileSync(join(stage, 'old', 'Body1.stl'), 'utf8'), 'stl');
      assert.equal(readFileSync(join(g, 'cad_preview.json'), 'utf8'), 'new');
      const journal = JSON.parse(readFileSync(join(g, 'link', 'commit.json'), 'utf8'));
      assert.ok(journal.moves.some((m) => m.to.endsWith('link/original/source.step')));
      assert.equal(h.job.undoByWhatExists(pdir, journal), true);
      assert.equal(readFileSync(join(g, 'source.step'), 'utf8'), 'step');
      assert.equal(readFileSync(join(g, 'original.igs'), 'utf8'), 'igs');
      assert.equal(readFileSync(join(g, 'cad_preview.json'), 'utf8'), 'old');
      assert.equal(existsSync(join(g, 'source.bbrep')), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a failed apply leaves it fenced; the recovery finishes the adoption', async () => {
    const pid = 'p-recover';
    const { gid, dir } = await importBox(pid);
    const sid = (await open(pid, gid)).body.study_id;
    h.overrides.set('geometry.apply', () => ({ ok: false, code: 'failed', error: 'test: apply fails' }));
    let rec;
    try {
      const r = await linkEdit(pid, sid);
      rec = await h.until(r.body.job_id);
    } finally {
      h.overrides.delete('geometry.apply');
    }
    assert.equal(rec.status, 'failed');
    assert.ok(existsSync(join(dir, 'link', 'commit.json')), 'fenced: its journal stays');
    assert.ok(existsSync(join(dir, 'link', 'original', 'source.step')), 'the original is kept while fenced');
    const pend = h.job.pendingRecoveries().find((p) => p.geometryId === gid);
    assert.ok(pend);
    const done = await h.job.recoverOne(pend);
    assert.equal(done.ok, true, done.error);
    assert.equal(h.state(pid, gid).rev, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'id.json'), 'utf8')).source.adopted, true);
    assert.equal(existsSync(join(dir, 'link', 'commit.json')), false);
  });
});
