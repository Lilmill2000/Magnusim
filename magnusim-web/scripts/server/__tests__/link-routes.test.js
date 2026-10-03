// Linked geometries (host API 1.5), L2 step 1: what the link call refuses, and the accept
// rule (an older design never lands; a newer one replaces a queued one; the same one
// joins it), by (plugin, study_id). gate:l2-routes (error codes), gate:l2-stale (two
// frames, two plugins), gate:l2-slot (no stop route, the events stream).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHarness, sleep } from './link-harness.js';

/** @type {any} */
let h;
before(async () => {
  h = await linkHarness({ name: 'link-routes', plugins: ['link-demo-2'] });
});
after(async () => {
  await h?.close();
});

async function linked(pid, sid, version = 1) {
  const r = await h.link(pid, sid, { sourceVersion: version });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const rec = await h.until(r.body.job_id);
  assert.equal(rec.status, 'done', rec.error);
  return r.body.geometry_id;
}

function holdSlot() {
  const c = h.slot.claimComputeSlot('mesh', { project_id: 'elsewhere', mesh_id: 'm9', name: 'Mesh 9' });
  assert.ok(c.ok);
  return () => h.slot.releaseComputeSlot(c.token);
}

describe('the call refuses with the 5.3 codes', () => {
  it('unsupported_format, and bad_request for the shapes of the body', async () => {
    const pid = h.project('p-codes');
    const sid = await h.study(pid);
    const step = await h.link(pid, sid, { extra: { shape: { ...h.put(pid, sid, 'v1.bbrep', 'a.bin'), format: 'step' } } });
    assert.equal(step.status, 400);
    assert.equal(step.body.code, 'unsupported_format');
    assert.match(step.body.error, /'brep'/);
    assert.deepEqual(step.body.formats, ['brep']);
    const both = await h.link(pid, sid, { extra: { shape: { ...h.put(pid, sid, 'v1.bbrep', 'a.bin'), etag: '"x"', format: 'brep' } } });
    assert.deepEqual([both.status, both.body.code], [400, 'bad_request']);
    const noVersion = await h.link(pid, sid, { extra: { source_version: 'one' } });
    assert.deepEqual([noVersion.status, noVersion.body.code], [400, 'bad_request']);
  });

  it('changed: a sha256 or an etag that is not the file sent', async () => {
    const pid = h.project('p-changed');
    const sid = await h.study(pid);
    const wrongSha = await h.link(pid, sid, { extra: { shape: { ...h.put(pid, sid, 'v1.bbrep', 's.bin'), sha256: 'a'.repeat(64), format: 'brep' } } });
    assert.deepEqual([wrongSha.status, wrongSha.body.code], [409, 'changed']);
    const put = h.put(pid, sid, 'v1.bbrep', 'e.bin');
    const stat = await h.get(`/api/plugin-files/stat?project_id=${pid}&plugin=link-demo&rel=${encodeURIComponent(put.rel)}`);
    const etag = stat.body.file.etag;
    const wrongEtag = await h.link(pid, sid, { names: null, extra: { shape: { rel: put.rel, etag: '"0-0-0"', format: 'brep' } } });
    assert.deepEqual([wrongEtag.status, wrongEtag.body.code], [409, 'changed']);
    // The right etag: the host hashes the file as it copies it, and the job links it.
    const ok = await h.link(pid, sid, { names: null, extra: { shape: { rel: put.rel, etag, format: 'brep' } } });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    const rec = await h.until(ok.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(rec.shape_sha256, put.sha256);
  });

  it('outside_study, not_found, study_not_found, not_allowed and plugin_off', async () => {
    const pid = h.project('p-scope');
    const sid = await h.study(pid);
    const other = await h.study(pid, { title: 'Demo 2' });
    const foreign = h.put(pid, other, 'v1.bbrep', 'x.bin');
    const outside = await h.link(pid, sid, { names: null, extra: { shape: { ...foreign, format: 'brep' } } });
    assert.deepEqual([outside.status, outside.body.code], [403, 'outside_study']);
    const missing = await h.link(pid, sid, { names: null, extra: { shape: { rel: `studies/${sid}/none.bin`, sha256: 'b'.repeat(64), format: 'brep' } } });
    assert.deepEqual([missing.status, missing.body.code], [404, 'not_found']);
    const gone = await h.link(pid, 'st-nothere', {});
    assert.deepEqual([gone.status, gone.body.code], [404, 'study_not_found']);
    const sketch = await h.study(pid, { kind: 'sketch', title: 'Sketch 1' });
    const notLinking = await h.link(pid, sketch, {});
    assert.deepEqual([notLinking.status, notLinking.body.code], [403, 'not_allowed']);
    const { setLiveRegistry } = await import('../../registry-defaults.js');
    const doc = await h.real.call('registry.describe', {}, 60_000);
    setLiveRegistry({ ...doc, plugins: doc.plugins.filter((p) => p.key !== 'link-demo') });
    try {
      const off = await h.link(pid, sid, {});
      assert.deepEqual([off.status, off.body.code], [404, 'plugin_off']);
    } finally {
      await h.refreshRegistry();
    }
  });

  it("not_allowed for a project in the desktop app's older format", async () => {
    const pid = h.project('p-desktop');
    const sid = await h.study(pid);
    writeFileSync(join(h.projects, pid, 'project.json'), JSON.stringify({ id: pid, version: 3, units: { length: 'm' }, simulations: [] }));
    const r = await h.link(pid, sid, {});
    assert.deepEqual([r.status, r.body.code], [403, 'not_allowed']);
    assert.match(r.body.error, /older format/);
  });

  it('too_large: no room on the disk for three copies and the spare', async () => {
    const pid = h.project('p-disk');
    const sid = await h.study(pid);
    h.job.setLinkJobDepsForTests({ freeBytes: async () => 300 * 1024 * 1024 });
    try {
      const r = await h.link(pid, sid, {});
      assert.deepEqual([r.status, r.body.code], [202, undefined]);
      await h.until(r.body.job_id);
      h.job.setLinkJobDepsForTests({ freeBytes: async () => 100 * 1024 * 1024 });
      const full = await h.link(pid, sid, { sourceVersion: 2, basedOnRev: 1 });
      assert.deepEqual([full.status, full.body.code], [413, 'too_large']);
      assert.ok(full.body.needed > full.body.free);
    } finally {
      h.job.setLinkJobDepsForTests({ freeBytes: async () => Number.POSITIVE_INFINITY });
    }
  });

  it('bad_brep, empty and bad_face_names end the job with their code; nothing is linked', async () => {
    const pid = h.project('p-shapes');
    const sid = await h.study(pid);
    const bad = await h.link(pid, sid, { shapeFile: Buffer.from('nothing'), names: null });
    assert.equal((await h.until(bad.body.job_id)).code, 'bad_brep');
    const { PYTHON } = await import('../../python-env.js');
    const face = join(h.root, 'face.brep');
    const made = spawnSync(
      PYTHON,
      [
        '-c',
        'import sys\nfrom OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace\nfrom OCP.gp import gp_Pln\nfrom OCP.BRepTools import BRepTools\n' +
          'BRepTools.Write_s(BRepBuilderAPI_MakeFace(gp_Pln(), 0.0, 1.0, 0.0, 1.0).Face(), sys.argv[1])',
        face,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(made.status, 0, made.stderr);
    const empty = await h.link(pid, sid, { shapeFile: readFileSync(face), names: null, sourceVersion: 2 });
    assert.equal((await h.until(empty.body.job_id)).code, 'empty');
    const wrong = await h.link(pid, sid, { version: 'v1', names: 'v2.face_names.json', sourceVersion: 3 });
    const rec = await h.until(wrong.body.job_id);
    assert.equal(rec.code, 'bad_face_names');
    assert.match(rec.error, /shape_sha256/);
    assert.equal(h.geomDir(pid, rec.geometry_id), null);
  });

  it('plugin_needed: an update of a geometry whose study holds a record of a kind no loaded plugin provides', async () => {
    const pid = h.project('p-needed');
    const sid = await h.study(pid);
    const gid = await linked(pid, sid);
    const sdir = join(h.geomDir(pid, gid), 'simulations', 'Study_1');
    mkdirSync(join(sdir, 'boundary_conditions', 'BC_Porous_1'), { recursive: true });
    writeFileSync(join(sdir, 'id.json'), JSON.stringify({ id: 'sim-1', name: 'Study 1', geometry_id: gid, kind: 'simulation' }));
    writeFileSync(join(sdir, 'boundary_conditions', 'BC_Porous_1', 'bc.json'), JSON.stringify({ id: 'bc-p', name: 'Porous 1', registry_key: 'demo_porous_bc', faces: [] }));
    const r = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
    assert.deepEqual([r.status, r.body.code], [409, 'plugin_needed']);
    assert.match(r.body.error, /off or not installed: Study 1 › Porous 1/);
    assert.deepEqual(r.body.records, [{ kind: 'bc', key: 'demo_porous_bc', study: 'Study 1', studyId: 'sim-1', name: 'Porous 1' }]);
    assert.equal(h.state(pid, gid).rev, 1);
    assert.equal(h.queue.snapshotComputeQueue(pid).items.length, 0);
  });
});

describe('the accept rule, by (plugin, study_id)', () => {
  it('stale, supersede and join while an update is queued', async () => {
    const pid = h.project('p-accept');
    const sid = await h.study(pid);
    const gid = await linked(pid, sid);
    const release = holdSlot();
    let b;
    try {
      const a = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
      assert.equal(a.status, 202);
      // The same version and basedOnRev joins it, whatever the bytes.
      const join2 = await h.link(pid, sid, { version: 'v1', names: 'v1-renamed.face_names.json', sourceVersion: 2, basedOnRev: 1 });
      assert.equal(join2.status, 202);
      assert.equal(join2.body.job_id, a.body.job_id);
      assert.equal(join2.body.joined, true);
      // The same version from a page on another rev, and an older one: stale.
      const other = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 0 });
      assert.deepEqual([other.status, other.body.code], [409, 'stale']);
      assert.match(other.body.error, /Demo 1 changed in another tab/);
      const older = await h.link(pid, sid, { version: 'v2', sourceVersion: 1, basedOnRev: 1 });
      assert.deepEqual([older.status, older.body.code], [409, 'stale']);
      // A newer version replaces it: its record ends superseded, its row leaves silently.
      b = await h.link(pid, sid, { version: 'v2', sourceVersion: 3, basedOnRev: 1 });
      assert.equal(b.status, 202);
      assert.notEqual(b.body.job_id, a.body.job_id);
      assert.equal(h.record(a.body.job_id).status, 'superseded');
      const rows = h.queue.snapshotComputeQueue(pid);
      assert.deepEqual(rows.items.map((r) => r.job_id), [b.body.job_id]);
      assert.equal((rows.failed || []).length, 0, 'a supersede shows no notice');
    } finally {
      release();
    }
    await h.queue.kickComputeQueue();
    const rec = await h.until(b.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(h.state(pid, gid).source_version, 3);
  });

  it('two plugins with the same study id: each finds only its own geometry', async () => {
    const pid = h.project('p-two');
    const sid = await h.study(pid);
    // link-demo-2's study with the very same id (study ids are unique only per plugin).
    const sdir = join(h.projects, pid, 'plugins', 'link-demo-2', 'studies', sid);
    mkdirSync(sdir, { recursive: true });
    const record = JSON.parse(readFileSync(join(h.projects, pid, 'plugins', 'link-demo', 'studies', sid, 'study.json'), 'utf8'));
    writeFileSync(join(sdir, 'study.json'), JSON.stringify({ ...record, plugin: 'link-demo-2', plugin_name: 'Link demo 2', title: 'Demo 2' }));
    const g1 = await linked(pid, sid);
    const r2 = await h.link(pid, sid, { plugin: 'link-demo-2', sourceVersion: 1 });
    assert.equal(r2.status, 202, JSON.stringify(r2.body));
    assert.equal(r2.body.created, true, 'a link of the other plugin is its own first link');
    const rec2 = await h.until(r2.body.job_id);
    assert.equal(rec2.status, 'done', rec2.error);
    assert.notEqual(r2.body.geometry_id, g1);
    const a = await h.get(`/api/plugin-geometry/linked?project_id=${pid}&plugin=link-demo&study_id=${sid}`);
    const b = await h.get(`/api/plugin-geometry/linked?project_id=${pid}&plugin=link-demo-2&study_id=${sid}`);
    assert.equal(a.body.linked.geometryId, g1);
    assert.equal(b.body.linked.geometryId, r2.body.geometry_id);
    assert.equal(b.body.linked.name, 'Demo 2');
    // A newer link of one plugin's study never touches the other's queued row.
    const release = holdSlot();
    try {
      const q1 = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
      const q2 = await h.link(pid, sid, { version: 'v2', plugin: 'link-demo-2', sourceVersion: 2, basedOnRev: 1 });
      const q1b = await h.link(pid, sid, { version: 'v2', sourceVersion: 3, basedOnRev: 1 });
      assert.equal(h.record(q1.body.job_id).status, 'superseded');
      assert.equal(h.record(q2.body.job_id).status, 'queued');
      assert.equal(h.record(q1b.body.job_id).status, 'queued');
      for (const id of [q2.body.job_id, q1b.body.job_id]) {
        const row = h.queue.snapshotComputeQueue(pid).items.find((r) => r.job_id === id);
        h.queue.removeComputeJob(null, row.id, pid);
      }
    } finally {
      release();
    }
  });
});

describe('the Queue', () => {
  it('removing the update row in the Queue cancels it; the geometry and its staging are left as they were', async () => {
    const pid = h.project('p-queue-remove');
    const sid = await h.study(pid);
    const gid = await linked(pid, sid);
    const release = holdSlot();
    try {
      const r = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
      const row = h.queue.snapshotComputeQueue(pid).items.find((x) => x.job_id === r.body.job_id);
      assert.ok(row, 'queued');
      const removed = await h.post('/api/compute-queue', { action: 'remove', id: row.id, project_id: pid });
      assert.equal(removed.status, 200);
      const rec = h.record(r.body.job_id);
      assert.deepEqual([rec.status, rec.code], ['cancelled', 'cancelled']);
      assert.equal(existsSync(join(h.projects, pid, '.magnusim-staging', `link-${r.body.job_id}`)), false);
      assert.equal(h.state(pid, gid).rev, 1);
    } finally {
      release();
    }
  });
});

describe('following a job', () => {
  it('no stop: the jobs route does not know a link job, and the status route is scoped to its study', async () => {
    const pid = h.project('p-stop');
    const sid = await h.study(pid);
    const other = await h.study(pid, { title: 'Demo 2' });
    const r = await h.link(pid, sid, {});
    await h.until(r.body.job_id);
    const stop = await h.post(`/api/jobs/${r.body.job_id}/stop`, { project_id: pid });
    assert.equal(stop.status, 404);
    const own = await h.get(`/api/plugin-geometry/status?project_id=${pid}&plugin=link-demo&study_id=${sid}&job_id=${r.body.job_id}`);
    assert.equal(own.body.job.status, 'done');
    assert.equal(own.body.job.result.rev, 1);
    const foreign = await h.get(`/api/plugin-geometry/status?project_id=${pid}&plugin=link-demo&study_id=${other}&job_id=${r.body.job_id}`);
    assert.equal(foreign.status, 404);
  });

  it("the events stream: a snapshot, then this study's events only", async () => {
    const pid = h.project('p-events');
    const sid = await h.study(pid);
    const other = await h.study(pid, { title: 'Demo 2' });
    const ctl = new AbortController();
    const res = await fetch(`${h.base}/api/plugin-geometry/events?project_id=${pid}&plugin=link-demo&study_id=${sid}`, { signal: ctl.signal });
    const reader = res.body.getReader();
    let text = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          text += Buffer.from(value).toString('utf8');
        }
      } catch {
        /* aborted */
      }
    })();
    await sleep(200);
    const mine = await h.link(pid, sid, {});
    const theirs = await h.link(pid, other, {});
    await h.until(mine.body.job_id);
    await h.until(theirs.body.job_id);
    await sleep(300);
    ctl.abort();
    await pump;
    assert.match(text, /^event: snapshot/m);
    assert.ok(text.includes(mine.body.job_id));
    assert.ok(!text.includes(theirs.body.job_id), "another study's job is not on this stream");
    const ends = text.split('\n').filter((l) => l.startsWith('data:') && l.includes('"event":"end"'));
    assert.equal(ends.length, 1);
    assert.ok(ends[0].includes('"status":"done"'));
    assert.ok(statSync(join(h.projects, pid, 'project.json')).isFile());
  });
});
