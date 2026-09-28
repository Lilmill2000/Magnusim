import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'cfd-mesh-geom-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
after(() => rmSync(root, { recursive: true, force: true }));

const { createGeometryFolder } = await import('../project-layout.js');
const { readPolyMeshCounts, resolveProjectGeometry } = await import('../w21-mesh-generate.js');

function header(extra = '', format = 'ascii') {
  return (
    'FoamFile\n{\n    version     2.0;\n    format      ' +
    format +
    ';\n    arch        "LSB;label=32;scalar=64";\n    class       labelList;\n' +
    extra +
    '    object      owner;\n}\n// * * * * * * * * * * * * * * * * * * //\n\n'
  );
}

function polyMesh(name, owner, points) {
  const dir = join(root, name, 'constant', 'polyMesh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner'), owner);
  writeFileSync(join(dir, 'points'), points);
  return dir;
}

const POINTS = header() + '5\n(\n(0 0 0)\n(1 0 0)\n(0 1 0)\n(0 0 1)\n(1 1 1)\n)\n';

describe('readPolyMeshCounts', () => {
  it('uses the header note OpenFOAM writes', () => {
    const owner = header('    note        "nPoints:296017  nCells:677353  nFaces:1611171  nInternalFaces:1552507";\n', 'binary') + '1611171\n(';
    const r = readPolyMeshCounts(polyMesh('note', owner, POINTS));
    assert.deepEqual([r.n_points, r.n_cells, r.n_faces], [296017, 677353, 1611171]);
  });

  it('reads a binary owner list (no note)', () => {
    const labels = Buffer.alloc(6 * 4);
    [0, 3, 1, 2, 3, 0].forEach((v, i) => labels.writeInt32LE(v, i * 4));
    const owner = Buffer.concat([
      Buffer.from(header('', 'binary') + '6\n(', 'latin1'),
      labels,
      Buffer.from(')\n', 'latin1'),
    ]);
    const r = readPolyMeshCounts(polyMesh('binary', owner, POINTS));
    assert.deepEqual([r.n_points, r.n_cells, r.n_faces], [5, 4, 6]);
  });

  it('reads an ascii owner list (no note)', () => {
    const owner = header() + '5\n(\n0\n2\n1\n0\n2\n)\n';
    const r = readPolyMeshCounts(polyMesh('ascii', owner, POINTS));
    assert.deepEqual([r.n_points, r.n_cells, r.n_faces], [5, 3, 5]);
  });
});

describe('resolveProjectGeometry', () => {
  function project(id, files) {
    const proj = join(root, id);
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 'project.json'),
      JSON.stringify({ id, active_geometry_id: 'geom-a', geometries: [{ id: 'geom-a', name: 'Part' }] }),
    );
    const g = createGeometryFolder(proj, { id: 'geom-a', name: 'Part', original_filename: 'part.stl' });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(g.dir, name), body);
  }

  it('meshes an STL import before its background STEP write finishes', () => {
    // Mesh imports have the BREP sidecar at once; Generate used to say "source.step missing".
    project('sidecar-only', { 'source.bbrep': 'x'.repeat(200) });
    const r = resolveProjectGeometry('sidecar-only');
    assert.equal(r.ok, true, r.error);
    assert.match(r.step_path, /source\.step$/);
    assert.match(r.geometry_stamp.file, /source\.bbrep$/);
    assert.equal(r.step_sha256, null);
  });

  it('hashes a small STEP', () => {
    project('small-step', { 'source.step': 'ISO-10303-21;' + 'x'.repeat(200) });
    const r = resolveProjectGeometry('small-step');
    assert.equal(r.ok, true, r.error);
    assert.match(r.step_sha256, /^[0-9a-f]{64}$/);
    assert.match(r.geometry_stamp.file, /source\.step$/);
  });

  it('still says so when there is no geometry at all', () => {
    project('no-geometry', {});
    const r = resolveProjectGeometry('no-geometry');
    assert.equal(r.ok, false);
    assert.match(r.error, /source\.step missing/);
  });
});
