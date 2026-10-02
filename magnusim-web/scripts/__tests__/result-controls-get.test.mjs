import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// The modules read the projects root when they load.
const root = mkdtempSync(join(tmpdir(), 'cfd-rc-get-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { createGeometryFolder, createStudyFolder, writeJsonAtomic } = await import('../project-layout.js');
const { getResultControls, handleResultControlsApi, POST_REFUSED } = await import('../w22-area-average.js');

after(() => rmSync(root, { recursive: true, force: true }));

const LEGACY_FACES = ['face 57@Body1', 'face 71@Body1'];

/** A project with one study whose result_controls.json is an older lone area_average_1. */
function legacyProject(pid, rcDoc) {
  const dir = join(root, pid);
  writeJsonAtomic(join(dir, 'project.json'), { id: pid, geometries: [{ id: 'g1', name: 'part.step' }] });
  createGeometryFolder(dir, { id: 'g1', name: 'part.step', original_filename: 'part.step' });
  const study = createStudyFolder(dir, 'g1', { id: 'sim-a', name: 'Baseline' });
  const studyDir = study.dir;
  writeJsonAtomic(join(dir, 'simulations.json'), {
    active_id: 'sim-a',
    simulations: [{ id: 'sim-a', name: 'Baseline', geometry_id: 'g1' }],
  });
  writeFileSync(join(studyDir, 'result_controls.json'), JSON.stringify(rcDoc));
  return dir;
}

function call(method, url) {
  const sent = [];
  const headers = {};
  const res = { setHeader: (k, v) => (headers[k] = v) };
  const u = new URL('http://127.0.0.1' + url);
  const parts = u.pathname.split('/').filter(Boolean);
  const sendJson = (_res, status, body) => sent.push({ status, body });
  return handleResultControlsApi({ method }, res, u, parts, { sendJson }).then(() => ({ ...sent[0], headers }));
}

describe('GET /api/result-controls', () => {
  it('returns an older lone area_average_1 (faces 57 and 71) for the boot hydrate', async () => {
    legacyProject('p-legacy', { area_average_1: { name: 'Area average 1', kind: 'Area average', faces: LEGACY_FACES } });
    const r = getResultControls('p-legacy');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.area_average_1.faces, LEGACY_FACES);
    // The page picks its record out of result_controls, so the lone record is listed there too.
    assert.deepEqual(r.body.result_controls.map((rc) => rc.faces), [LEGACY_FACES]);

    const http = await call('GET', '/api/result-controls?project_id=p-legacy');
    assert.equal(http.status, 200);
    assert.deepEqual(http.body.area_average_1.faces, LEGACY_FACES);
  });

  it('a record with only faces is still returned', () => {
    legacyProject('p-bare', { area_average_1: { faces: LEGACY_FACES } });
    const r = getResultControls('p-bare');
    assert.deepEqual(r.body.area_average_1, { faces: LEGACY_FACES });
  });

  it('a record stamped with another study is not', () => {
    legacyProject('p-other', { area_average_1: { name: 'Area average 1', faces: LEGACY_FACES, simulation_id: 'sim-z' } });
    const r = getResultControls('p-other');
    assert.equal(r.body.area_average_1, null);
    assert.deepEqual(r.body.result_controls, []);
  });

  it('carries none of the old fixed-face check keys', () => {
    legacyProject('p-keys', { area_average_1: { name: 'Area average 1', faces: LEGACY_FACES } });
    const r = getResultControls('p-keys');
    for (const key of ['bank_exact', 'both_faces', 'da_hard_fail_locks', 'no_fake_chart_values', 'increment']) {
      assert.equal(key in r.body, false, key);
    }
  });
});

describe('POST /api/result-controls', () => {
  it('is refused: monitors are saved on the run', async () => {
    legacyProject('p-post', { area_average_1: { name: 'Area average 1', faces: LEGACY_FACES } });
    for (const url of ['/api/result-controls', '/api/area-average']) {
      const r = await call('POST', url);
      assert.equal(r.status, 405);
      assert.equal(r.body.error, POST_REFUSED);
      assert.equal(r.headers.Allow, 'GET, HEAD');
    }
    // Nothing on disk changed: the lone record still reads back.
    assert.deepEqual(getResultControls('p-post').body.area_average_1.faces, LEGACY_FACES);
  });
});
