// A linked geometry's update matches the live faces to the new ones (host API 1.5,
// LINK proposal 5.12; gate:l2-match): bodies by id, then name, then index; faces by name
// (a split keeps every half, a merge one face, an ambiguous group is left to the plan),
// then by shape within the paired body; anything else is lost. The new labels take their
// body from the new face table. The real exports of the link-demo fixture (v1, v2, v3)
// go through the host's own preview process first.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkFaceMap, linkFaceTable, matchFaces, pairLinkBodies } from '../geometry-face-match.js';
import { PYTHON, PY_ROOT } from '../python-env.js';

const EXPORTS = join(PY_ROOT, 'tests', 'fixtures', 'link-plugins', 'link-demo', 'workspace', 'exports');
let root;
/** @type {Record<string, any>} */
const meta = {};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'magnusim-link-match-'));
  for (const v of ['v1', 'v2', 'v3']) {
    const shape = join(EXPORTS, `${v}.bbrep`);
    const sha = createHash('sha256').update(readFileSync(shape)).digest('hex');
    const out = join(root, v);
    const r = spawnSync(
      PYTHON,
      ['-m', 'cfddesk.cad.link_preview', '--shape', shape, '--names', join(EXPORTS, `${v}.face_names.json`), '--shape-sha256', sha, '--out', out, '--report', join(root, `${v}.json`)],
      { cwd: PY_ROOT, encoding: 'utf8', timeout: 300_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    meta[v] = JSON.parse(readFileSync(join(out, 'cad_preview.json'), 'utf8'));
  }
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const face = (id, body, name, centroid, area, normal, extra = {}) => ({ id, body, name, centroid, area, normal, surface_type: 'Plane', ...extra });
const table = (faces, bodies, size = 10) => ({
  faces,
  n_solids: bodies.length,
  body_info: bodies,
  bounds: { xmin: 0, xmax: size, ymin: 0, ymax: size, zmin: 0, zmax: size },
});

describe('the link-demo exports, v1 to v2 to v3', () => {
  it('keeps faces by name, splits and merges them, and loses the boss end', () => {
    const m = linkFaceMap(meta.v1, meta.v2);
    // Split: v1's +y face (12) is two faces in v2 (4 and 8); the BC keeps both.
    assert.deepEqual(m.faces['12'], ['face 4@Body1', 'face 8@Body1']);
    // Merged: the two +x halves (6 and 14) are one face (10).
    assert.deepEqual([m.faces['6'], m.faces['14']], [['face 10@Body1'], ['face 10@Body1']]);
    assert.ok(m.report.merged.some((x) => x.target === 'face 10@Body1' && x.faces === 2));
    // A merge is no ambiguous group: each half maps, and the BC rule decides (claimed twice).
    assert.deepEqual([m.groups['6'], m.groups['14']], [undefined, undefined]);
    // Lost: the boss is gone with its end face.
    for (const id of ['8', '9', '10', '11', '15']) assert.equal(m.faces[id], undefined, `face ${id} is lost`);
    // Two halves on two halves, neither matching by shape: an ambiguous group the plan decides per record.
    assert.equal(m.groups['3'], m.groups['7']);
    assert.ok(m.groups['3']);
    assert.deepEqual(m.faces['3'], ['face 3@Body1', 'face 7@Body1']);
    // Body 2 shares a face with Body 1; its labels keep its own body.
    assert.deepEqual(m.faces['19'], ['face 14@Body2', 'face 15@Body2']);
    // Body 1 was renamed "Fluid" with the same id: it pairs with itself.
    assert.deepEqual(m.body_map, { Body1: 'Body1', Body2: 'Body2' });
    assert.ok(m.report.match.byName >= 14 && m.report.match.byShape === 0, JSON.stringify(m.report.match));
    assert.equal(m.report.match.split, 3);
  });

  it('brings the boss end back by name in v3 (a different index)', () => {
    const m = linkFaceMap(meta.v2, meta.v3);
    // The +y halves are in v3 too: each pairs with its own half by shape.
    assert.deepEqual([...m.faces['4'], ...m.faces['8']].sort(), ['face 11@Body1', 'face 8@Body1']);
    assert.equal(m.faces['4'].length, 1);
    const end = meta.v3.faces.find((f) => f.name === 'F:boss:end');
    assert.equal(end.id, 3);
    assert.equal(m.report.match.split, 0);
  });
});

describe('bodies pair by id, then name, then index', () => {
  it('an id wins over a name, a renamed body keeps its pair, and the rest go by index only when the counts agree', () => {
    const old = [
      { ref: 'Body1', id: 'a', name: 'Body 1' },
      { ref: 'Body2', id: null, name: 'Fin' },
      { ref: 'Body3', id: null, name: null },
    ];
    const next = [
      { ref: 'Body1', id: null, name: 'Fin' },
      { ref: 'Body2', id: 'a', name: 'Fluid' },
      { ref: 'Body3', id: null, name: null },
    ];
    assert.deepEqual(pairLinkBodies(old, next), { Body1: 'Body2', Body2: 'Body1', Body3: 'Body3' });
    assert.deepEqual(pairLinkBodies(old, next.slice(0, 2)), { Body1: 'Body2', Body2: 'Body1', Body3: null });
  });
});

describe('the shape match, within the paired body', () => {
  it('maps an unnamed face with exactly one hit in its paired body, never one in another body', () => {
    const top = [5, 5, 10];
    const a = table([face(1, 1, null, top, 100, [0, 0, 1]), face(2, 2, null, [5, 5, 20], 100, [0, 0, 1])], [{ ref: 'Body1' }, { ref: 'Body2' }], 20);
    // In the new table the same top face is in Body1 (index 7) and a twin of it sits in Body2.
    const b = table([face(7, 1, null, top, 100, [0, 0, 1]), face(8, 2, null, top, 100, [0, 0, 1])], [{ ref: 'Body1' }, { ref: 'Body2' }], 20);
    const m = linkFaceMap(a, b);
    assert.deepEqual(m.faces['1'], ['face 7@Body1']);
    assert.equal(m.faces['2'], undefined, 'Body2 has no face like its old one');
    assert.equal(m.report.match.byShape, 1);
  });

  it('takes the new label\'s body from the new face table', () => {
    const a = table([face(4, 1, 'F:x', [1, 1, 1], 1, [1, 0, 0])], [{ ref: 'Body1', id: 'p' }, { ref: 'Body2', id: 'q' }]);
    const b = table([face(9, 2, 'F:x', [1, 1, 1], 1, [1, 0, 0])], [{ ref: 'Body1', id: 'q' }, { ref: 'Body2', id: 'p' }]);
    const m = linkFaceMap(a, b);
    assert.deepEqual(m.body_map, { Body1: 'Body2', Body2: 'Body1' });
    assert.deepEqual(m.faces['4'], ['face 9@Body2']);
  });

  it('reports a face kept by name that moved far', () => {
    const a = table([face(1, 1, 'F:cap', [0, 0, 0], 10, [0, 0, 1])], [{ ref: 'Body1' }]);
    const b = table([face(1, 1, 'F:cap', [9, 9, 9], 10, [0, 0, 1])], [{ ref: 'Body1' }]);
    const m = linkFaceMap(a, b);
    assert.deepEqual(m.faces['1'], ['face 1@Body1']);
    assert.equal(m.report.match.movedFar, 1);
    assert.equal(m.report.moved_far[0].name, 'F:cap');
  });

  it('pairs a name group by shape first, then maps one leftover to every leftover face', () => {
    const a = table(
      [face(1, 1, 'F:s', [1, 0, 0], 4, [0, -1, 0]), face(2, 1, 'F:s', [3, 0, 0], 4, [0, -1, 0])],
      [{ ref: 'Body1' }],
    );
    const b = table(
      [face(5, 1, 'F:s', [1, 0, 0], 4, [0, -1, 0]), face(6, 1, 'F:s', [3.5, 0, 0], 2, [0, -1, 0]), face(7, 1, 'F:s', [2.5, 0, 0], 2, [0, -1, 0])],
      [{ ref: 'Body1' }],
    );
    const m = linkFaceMap(a, b);
    assert.deepEqual(m.faces['1'], ['face 5@Body1']);
    assert.deepEqual(m.faces['2'], ['face 6@Body1', 'face 7@Body1']);
    assert.deepEqual(m.groups, {});
  });
});

describe('the cross-geometry copy is unchanged', () => {
  it('matchFaces still refuses multi-body geometries, which is why a link copy uses this map', () => {
    const t = linkFaceTable(meta.v1);
    assert.equal(t.faces.length, 21);
    const both = { faces: t.faces, solids: 2, diag: t.diag };
    assert.equal(matchFaces(both, both).size, 0);
  });
});
