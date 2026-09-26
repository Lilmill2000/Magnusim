import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchFaces, readPreviewFaces, remapRecordFaces } from '../geometry-face-match.js';
import { copyStudyTree, createGeometryFolder, createStudyFolder, writeJsonAtomic } from '../project-layout.js';
import { rewriteCopiedStudy } from '../w17-simulation.js';

// The two transient test plates: the same 50 x 1500 x 500 mm box, one with a round
// hole and one with a teardrop hole, so the faces are numbered differently.
const BOX = { xmin: 0, xmax: 50, ymin: 0, ymax: 1500, zmin: 0, zmax: 500 };
const face = (id, centroid, normal, area, surface_type = 'Plane') => ({ id, centroid, normal, area, surface_type });
const ROUND = [
  face(1, [25, 750, 250], [0, -1, 0], 15708, 'Cylinder'),
  face(2, [25, 750, 500], [0, 0, 1], 75000),
  face(3, [25, 1500, 250], [0, 1, 0], 25000),
  face(4, [25, 750, 0], [0, 0, -1], 75000),
  face(5, [25, 0, 250], [0, -1, 0], 25000),
  face(6, [50, 750, 250], [1, 0, 0], 742146),
  face(7, [0, 750, 250], [-1, 0, 0], 742146),
];
const TEARDROP = [
  face(1, [25, 844.3, 278.3], [0, -0.33, -0.94], 9732),
  face(2, [25, 844.3, 221.7], [0, -0.33, 0.94], 9732),
  face(3, [50, 749.2, 250], [1, 0, 0], 735422),
  face(4, [25, 718.2, 250], [0, 1, 0], 7854, 'Cylinder'),
  face(5, [25, 750, 500], [0, 0, 1], 75000),
  face(6, [25, 1500, 250], [0, 1, 0], 25000),
  face(7, [25, 750, 0], [0, 0, -1], 75000),
  face(8, [25, 0, 250], [0, -1, 0], 25000),
  face(9, [0, 749.2, 250], [-1, 0, 0], 735422),
];
const geo = (faces, solids = 1) => ({ faces, solids, diag: Math.hypot(50, 1500, 500) });

describe('faces matched between two geometries', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('pairs the faces that are the same surface, not the same number', () => {
    const map = matchFaces(geo(TEARDROP), geo(ROUND));
    // Inlet end, outlet end, top and bottom are the same surfaces on both plates.
    assert.equal(map.get(8), 5);
    assert.equal(map.get(6), 3);
    assert.equal(map.get(5), 2);
    assert.equal(map.get(7), 4);
    // The side walls have a different hole cut out (area differs) and the holes differ.
    for (const id of [1, 2, 3, 4, 9]) assert.equal(map.has(id), false, `face ${id}`);
  });

  it('matches nothing between multi-body geometries', () => {
    assert.equal(matchFaces(geo(TEARDROP, 2), geo(ROUND)).size, 0);
  });

  it('does not pick one of two equal candidates', () => {
    const twin = [...ROUND, face(8, [25, 0, 250], [0, -1, 0], 25000)];
    assert.equal(matchFaces(geo(TEARDROP), geo(twin)).has(8), false);
  });

  it('carries matched faces and lists the rest', () => {
    const map = matchFaces(geo(TEARDROP), geo(ROUND));
    const out = remapRecordFaces({ name: 'Wall', faces: ['face 8@Body1', 'face 1@Body1'] }, map);
    assert.deepEqual(out.rec.faces, ['face 5@Body1']);
    assert.deepEqual(out.lost, ['face 1@Body1']);
  });

  it('copies a study onto the other geometry with its BCs on the matching faces', () => {
    root = mkdtempSync(join(tmpdir(), 'cfd-face-match-'));
    const tear = createGeometryFolder(root, { id: 'g-tear', name: 'Teardrop' });
    const round = createGeometryFolder(root, { id: 'g-round', name: 'Round' });
    writeJsonAtomic(join(tear.dir, 'cad_preview.json'), { n_solids: 1, bounds: BOX, faces: TEARDROP });
    writeJsonAtomic(join(round.dir, 'cad_preview.json'), { n_solids: 1, bounds: BOX, faces: ROUND });
    const src = createStudyFolder(root, 'g-tear', { id: 'sim-tear', name: 'Tear', time_dependency: 'Transient' });
    writeJsonAtomic(join(src.dir, 'boundary_conditions.json'), {
      simulation_id: 'sim-tear',
      boundary_conditions: [
        { id: 'bc1', name: 'Inlet', bc_type: 'Velocity inlet', faces: ['face 8@Body1'], simulation_id: 'sim-tear' },
        { id: 'bc2', name: 'Outlet', bc_type: 'Pressure outlet', faces: ['face 6@Body1'], simulation_id: 'sim-tear' },
        { id: 'bc3', name: 'Hole', bc_type: 'Wall', faces: ['face 1@Body1', 'face 2@Body1'], simulation_id: 'sim-tear' },
      ],
    });
    const destDir = copyStudyTree(src.dir, join(round.dir, 'simulations'), 'Copy', { cloneCases: false });
    const faceMap = matchFaces(readPreviewFaces(tear.dir), readPreviewFaces(round.dir));
    const out = rewriteCopiedStudy(destDir, 'sim-tear', 'sim-round', 'g-round', {
      sourceGeometryId: 'g-tear',
      faceMap,
      copyRuns: false,
    });
    const bcs = JSON.parse(readFileSync(join(destDir, 'boundary_conditions.json'), 'utf8')).boundary_conditions;
    const byName = Object.fromEntries(bcs.map((b) => [b.name, b]));
    assert.deepEqual(byName.Inlet.faces, ['face 5@Body1']);
    assert.deepEqual(byName.Outlet.faces, ['face 3@Body1']);
    assert.deepEqual(byName.Hole.faces, []);
    assert.equal(byName.Inlet.simulation_id, 'sim-round');
    assert.equal(byName.Inlet.geometry_id, 'g-round');
    assert.deepEqual(out.lost_faces, [{ kind: 'bc', name: 'Hole', faces: ['face 1@Body1', 'face 2@Body1'] }]);
  });
});
