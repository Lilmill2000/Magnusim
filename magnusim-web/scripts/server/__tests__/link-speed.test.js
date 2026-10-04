// L4 (LINK proposal revision 7, section 7 and gate:l4-equal's node part), through the
// real routes and the real Python worker:
//   - the link job's preview runs in its own process with stage events: the record keeps
//     one timing per term of the speed plan's table, and the follow-ups' times;
//   - a plain STEP import below the display budget is previewed exactly as before: no
//     source.bbrep beside its STEP, no display_budget, no shape hash;
//   - an old preview (made before L4, no display_budget) is still served as it is: no
//     cad.preview call, and GET /api/project answers at once.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WEB, linkHarness } from './link-harness.js';

/** @type {any} */
let h;

before(async () => {
  h = await linkHarness({ name: 'link-speed' });
});
after(async () => {
  await h?.close();
});

const ELBOW = join(WEB, 'python', 'tests', 'fixtures', 'elbow.step');
const PREVIEW_TERMS = ['read_shape', 'check_shape', 'read_names', 'check_names', 'store_bbrep', 'bbox', 'display_mesh', 'triangles', 'faces_vtp', 'edges', 'face_table', 'write_meta'];

describe('L4 speed plan', () => {
  it("the link job's preview reports its stages; the record keeps them and the follow-ups' times", async () => {
    const pid = h.project('ls-stages');
    const sid = await h.study(pid);
    const r = await h.link(pid, sid, { version: 'v1', sourceVersion: 1 });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.deepEqual(Object.keys(rec.preview_timings), PREVIEW_TERMS);
    for (const v of Object.values(rec.preview_timings)) assert.ok(typeof v === 'number' && v >= 0);
    assert.equal(rec.display_budget, false);
    // A create's follow-ups (centre of mass, thumbnail) run after the commit, outside the slot.
    await h.waitFor(() => h.record(r.body.job_id).follow_timings, 60_000, 'follow-up timings');
    const follow = h.record(r.body.job_id).follow_timings;
    for (const k of ['center_of_mass', 'thumbnail', 'project_json']) assert.ok(typeof follow[k] === 'number', k);
  });

  it('a plain STEP import below the budget is previewed as before, and its preview is then served with no new preview', async () => {
    const pid = h.project('ls-plain');
    const imp = await h.post('/api/geometry/import', { project_id: pid, step_path: ELBOW, filename: 'elbow.step' });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    const root = join(h.projects, pid, 'geometries');
    const dir = join(root, readdirSync(root).find((d) => readdirSync(join(root, d)).includes('source.step')));
    const gid = JSON.parse(readFileSync(join(dir, 'id.json'), 'utf8')).id;
    const cad = await h.get(`/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=meta`);
    assert.equal(cad.status, 200);
    const meta = JSON.parse(readFileSync(join(dir, 'cad_preview.json'), 'utf8'));
    assert.equal(meta.preview_version, 8);
    assert.equal('display_budget' in meta, false);
    assert.equal('shape_sha256' in meta, false);
    // No sidecar: the STEP stays the file every reader parses, as before L4.
    assert.deepEqual(readdirSync(dir).filter((f) => /\.bbrep$|\.tmp\./.test(f)), []);
    // Served from then on as it is: no cad.preview, the files untouched.
    const stamp = statSync(join(dir, 'cad_faces.vtp')).mtimeMs;
    const before = h.calls.filter(([m]) => m === 'cad.preview').length;
    for (const part of ['meta', 'faces', 'edges']) {
      const again = await h.get(`/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=${part}`);
      assert.equal(again.status, 200);
    }
    const t0 = Date.now();
    const proj = await h.get(`/api/project?project_id=${pid}`);
    assert.equal(proj.status, 200);
    assert.ok(Date.now() - t0 < 1000, `GET /api/project took ${Date.now() - t0} ms`);
    assert.equal(h.calls.filter(([m]) => m === 'cad.preview').length, before);
    assert.equal(statSync(join(dir, 'cad_faces.vtp')).mtimeMs, stamp);
  });
});
