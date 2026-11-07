// A generated mesh's quality (RH2): the mesh record keeps checkMesh's report as numbers in
// `live_mesh_result.quality`, from the generator's result (persistMeshResult), and a done mesh
// whose result has none reads the mesh-facts.json its generator left beside it, only while
// that still matches the mesh. The Python writer's stamp and the server's agree.
// D1 (2026-11-07): Hex-dominant's checkMesh verdict fails Generate, naming the check, and the
// failed record keeps the quality; the fake mesher standing in for it does the same.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-mesh-quality-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const CHECKMESH = join(WEB, 'python', 'tests', 'fixtures', 'mesh-facts', 'checkmesh');
const { cleanMeshQuality, meshFactsQuality, meshStamp } = await import('../mesh-quality.js');
const { persistMeshResult } = await import('../w21-mesh-generate.js');
const { meshCasePath } = await import('../study-io.js');
const { PYTHON, pyTool } = await import('../python-env.js');
const { meshGeneratorArgs } = await import('../test-compute.js');
const { seedElbowProject } = await import('../../e2e/prepare-projects.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));

const PID = 'quality-p1';
seedElbowProject(PROJECTS, PID, 'Quality');
const meshDoc = JSON.parse(readFileSync(join(PROJECTS, PID, 'mesh.json'), 'utf8'));
const MESH = String(meshDoc.meshes[0].id);
const SIM = String(meshDoc.meshes[0].simulation_id || JSON.parse(readFileSync(join(PROJECTS, PID, 'simulations.json'), 'utf8')).simulations[0].id);

/**
 * The fake mesher, as Generate runs it in tests: a one-cell mesh, and with a checkMesh report the
 * mesh's facts. `standsFor`: the generator it stands in for (scripts/test-compute.js); `exit`: the
 * exit code it must end with.
 */
function fakeGenerate(caseDir, checkmesh, { standsFor = '', exit = 0 } = {}) {
  const args = ['--case-dir', caseDir, '--generate-id', 'g1', ...(standsFor ? ['--stands-for', standsFor] : [])];
  const r = spawnSync(PYTHON, [pyTool('fake_mesh_generate.py'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, MAGNUSIM_TEST_MESH_SECONDS: '0', MAGNUSIM_TEST_MESH_CHECKMESH: checkmesh ? join(CHECKMESH, checkmesh) : '' },
  });
  assert.equal(r.status, exit, r.stderr);
  const line = r.stdout.split(/\r?\n/).find((l) => l.includes('"event":"result"'));
  return JSON.parse(line.slice(line.indexOf('{')));
}

const done = (extra = {}) => ({
  status: 'done',
  mesh_id: MESH,
  simulation_id: SIM,
  generate_id: 'g1',
  n_cells: 1,
  n_points: 8,
  finished_at: '2026-11-03T10:00:00Z',
  ...extra,
});

const liveOf = (doc) => (doc.meshes || []).find((m) => String(m.id) === MESH).live_mesh_result;

describe('the mesh record keeps checkMesh quality', () => {
  it("persistMeshResult keeps the generator's quality, cleaned (at most 8 failed checks, known fields only)", () => {
    const result = fakeGenerate(join(ROOT, 'scratch-case'), 'skewed.log');
    const doc = persistMeshResult(PID, done({ quality: { ...result.quality, junk: 'x', failed: [...result.quality.failed, ...Array(10).fill({ check: 'other', text: 'a'.repeat(300) })] } }));
    const q = liveOf(doc).quality;
    assert.equal(q.known, true);
    assert.equal(q.ok, false);
    assert.equal(q.n_failed, 1);
    assert.equal(q.max_non_orthogonality, 72.64597596);
    assert.equal(q.max_skewness, 8.000000342);
    assert.equal(q.max_aspect_ratio, 38.02406827);
    assert.equal(q.junk, undefined);
    assert.equal(q.failed.length, 8);
    assert.deepEqual(q.failed[0], { check: 'skewness', count: 22, unit: 'faces', accepted: true });
    assert.equal(q.failed[1].text.length, 120);
    // On disk too (mesh.json), as the page and the Assistant read it.
    const again = persistMeshResult(PID, done({ quality: result.quality }));
    assert.deepEqual(liveOf(again).quality.failed, [{ check: 'skewness', count: 22, unit: 'faces', accepted: true }]);
  });

  it('a running record has none; a failed result keeps none', () => {
    assert.equal(liveOf(persistMeshResult(PID, { ...done(), status: 'running', quality: undefined })).quality, null);
    assert.equal(liveOf(persistMeshResult(PID, { ...done(), status: 'failed', quality: undefined })).quality, null);
  });

  it("a done mesh without quality in its result reads its generator's mesh-facts.json while it matches the mesh", () => {
    const caseDir = meshCasePath(PID, MESH, SIM);
    const result = fakeGenerate(caseDir, 'negative-volume.log');
    // The Python stamp and the server's are the same.
    const facts = JSON.parse(readFileSync(join(caseDir, 'mesh-facts.json'), 'utf8'));
    assert.deepEqual(facts.stamp, meshStamp(join(caseDir, 'constant', 'polyMesh')));
    assert.deepEqual(meshFactsQuality(caseDir), cleanMeshQuality(result.quality));
    const q = liveOf(persistMeshResult(PID, done())).quality;
    assert.deepEqual(
      q.failed.map((f) => [f.check, f.count, f.accepted]),
      [
        ['non_aligned_edges', 1, false],
        ['negative_volume', 1, false],
        ['non_orthogonality', 3, false],
        ['face_pyramids', 4, false],
      ],
    );
    assert.equal(q.max_non_orthogonality, 107.448358);
    // The mesh changed since (a later generate wrote it): its old facts are not read.
    writeFileSync(join(caseDir, 'constant', 'polyMesh', 'points'), readFileSync(join(caseDir, 'constant', 'polyMesh', 'points'), 'utf8') + '\n');
    assert.equal(meshFactsQuality(caseDir), null);
    assert.equal(liveOf(persistMeshResult(PID, done())).quality, null);
  });

  it('standing in for Hex-dominant, the fake fails a mesh its checkMesh rule refuses, naming the check, and the failed record keeps the quality (D1)', () => {
    const neg = fakeGenerate(join(ROOT, 'hex-neg'), 'hexdominant-pipe-55d.log', { standsFor: 'generate_snappy.py', exit: 1 });
    assert.equal(neg.ok, false);
    assert.equal(
      neg.error,
      'checkMesh failed 5 checks: 8 cells with a high aspect ratio, 8 cells with a negative volume, 84 faces over 90° non-orthogonal, 644 wrongly oriented faces, 164 highly skewed faces.',
    );
    assert.equal(neg.quality.n_failed, 5);
    const rec = liveOf(persistMeshResult(PID, { ...done(), status: 'failed', error: neg.error, quality: neg.quality }));
    assert.equal(rec.error, neg.error);
    assert.deepEqual(rec.quality.failed.map((f) => [f.check, f.count]), [
      ['aspect_ratio', 8],
      ['negative_volume', 8],
      ['non_orthogonality', 84],
      ['face_pyramids', 644],
      ['skewness', 164],
    ]);
    // Skewed faces and up to 8 cells of high aspect ratio: kept, as Standard and cfMesh keep them.
    const kept = fakeGenerate(join(ROOT, 'hex-kept'), 'skewed-few-thin.log', { standsFor: 'generate_snappy.py' });
    assert.equal(kept.ok, true);
    assert.equal(kept.error, undefined);
    assert.equal(kept.quality.n_failed, 2);
    // Standing in for Standard, it ends as before (Standard gates inside its own pipeline).
    assert.equal(fakeGenerate(join(ROOT, 'std-neg'), 'negative-volume.log', { standsFor: 'generate_standard.py' }).ok, true);
  });

  it('meshGeneratorArgs: the stand-in learns which generator it stands in for; a real run gets its own arguments', () => {
    const was = process.env.MAGNUSIM_TEST_COMPUTE;
    try {
      process.env.MAGNUSIM_TEST_COMPUTE = 'fake';
      assert.deepEqual(meshGeneratorArgs(join('python', 'tools', 'generate_snappy.py'), ['--fineness', '6']), ['--stands-for', 'generate_snappy.py', '--fineness', '6']);
      delete process.env.MAGNUSIM_TEST_COMPUTE;
      assert.deepEqual(meshGeneratorArgs(join('python', 'tools', 'generate_snappy.py'), ['--fineness', '6']), ['--fineness', '6']);
    } finally {
      if (was === undefined) delete process.env.MAGNUSIM_TEST_COMPUTE;
      else process.env.MAGNUSIM_TEST_COMPUTE = was;
    }
  });

  it('cleanMeshQuality: unknown stays unknown, junk is null', () => {
    assert.deepEqual(cleanMeshQuality({ known: false, max_skewness: 3 }), { known: false });
    assert.equal(cleanMeshQuality(null), null);
    assert.equal(cleanMeshQuality([1]), null);
    assert.equal(cleanMeshQuality('x'), null);
    assert.deepEqual(cleanMeshQuality({ known: true, n_failed: 'x', max_skewness: Infinity, failed: [{ check: 'skewness', count: '3', unit: 'parsecs' }] }), {
      known: true,
      ok: false,
      n_failed: 0,
      max_non_orthogonality: null,
      avg_non_orthogonality: null,
      severe_non_orthogonal_faces: null,
      max_skewness: null,
      skewed_faces: null,
      max_aspect_ratio: null,
      min_volume_m3: null,
      failed: [{ check: 'skewness', count: null, unit: null, accepted: false }],
    });
  });
});
