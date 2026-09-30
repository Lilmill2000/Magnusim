import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// The catalog module reads the projects root when it loads.
const root = mkdtempSync(join(tmpdir(), 'cfd-geometry-remove-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { createGeometryFolder, createStudyFolder, walkStudies, writeJsonAtomic } = await import('../project-layout.js');
const { deleteSimulationFromCatalog, ensureCatalog, saveCatalog } = await import('../w17-sim-catalog.js');
const { dropGeometryStudies, purgeRemovedStudies } = await import('../w17-simulation.js');

after(() => rmSync(root, { recursive: true, force: true }));

const row = (id, name, geometryId) => ({
  id,
  name,
  geometry_id: geometryId,
  analysis: 'Incompressible',
  time_dependency: 'Steady-state',
});
const onDisk = (pid) => walkStudies(join(root, pid)).map((s) => s.id).sort();
const ids = (list) => (list || []).map((s) => s.id).sort();

/** A round and a teardrop plate, each with the studies named here. */
function twoGeometries(pid, { round = [], tear = [] }) {
  const dir = join(root, pid);
  createGeometryFolder(dir, { id: 'g-round', name: 'round.step', original_filename: 'round.step' });
  const tearGeom = createGeometryFolder(dir, { id: 'g-tear', name: 'tear.step', original_filename: 'tear.step' });
  for (const [id, name] of round) createStudyFolder(dir, 'g-round', { id, name });
  for (const [id, name] of tear) createStudyFolder(dir, 'g-tear', { id, name });
  return { dir, tearDir: tearGeom.dir };
}

/** What removeGeometry (w16) does to the teardrop: its folder goes, then its studies. */
function removeTeardrop(pid, tearDir) {
  rmSync(tearDir, { recursive: true, force: true });
  const proj = { id: pid, geometries: [{ id: 'g-round', name: 'round.step' }] };
  dropGeometryStudies(pid, proj, 'g-tear');
  return proj;
}

describe("removing a geometry keeps every other geometry's studies", () => {
  it('with no simulations.json', () => {
    const pid = 'p-no-index';
    const { tearDir } = twoGeometries(pid, { round: [['sim-round', 'Round']], tear: [['sim-tear', 'Tear']] });
    const proj = removeTeardrop(pid, tearDir);
    assert.deepEqual(onDisk(pid), ['sim-round']);
    assert.deepEqual(ids(ensureCatalog(pid, proj).simulations), ['sim-round']);
  });

  it('with a simulations.json that cannot be read (a write cut short)', () => {
    const pid = 'p-torn-index';
    const { dir, tearDir } = twoGeometries(pid, { round: [['sim-round', 'Round']], tear: [['sim-tear', 'Tear']] });
    writeFileSync(join(dir, 'simulations.json'), '{"active_id": "sim-round", "simulations": [{"id": "sim-ro', 'utf8');
    const proj = removeTeardrop(pid, tearDir);
    assert.deepEqual(onDisk(pid), ['sim-round']);
    assert.deepEqual(ids(ensureCatalog(pid, proj).simulations), ['sim-round']);
  });

  it('with a study whose row never reached simulations.json, the removed geometry having no study', () => {
    // A study's folder is made before its row: a server stopped between the two leaves
    // a study the tree shows (it walks the folders) and the index does not list.
    const pid = 'p-unindexed';
    const { dir, tearDir } = twoGeometries(pid, {
      round: [
        ['sim-round', 'Round'],
        ['sim-round-2', 'Round fine'],
      ],
    });
    writeJsonAtomic(join(dir, 'simulations.json'), {
      active_id: 'sim-round',
      simulations: [row('sim-round', 'Round', 'g-round')],
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    removeTeardrop(pid, tearDir);
    assert.deepEqual(onDisk(pid), ['sim-round', 'sim-round-2']);
  });

  it("still removes what is left of the removed geometry's studies", () => {
    // Its folder did not go all at once (a file held open): a study of it is still there.
    const pid = 'p-leftover';
    const { dir } = twoGeometries(pid, { round: [['sim-round', 'Round']], tear: [['sim-tear', 'Tear']] });
    saveCatalog(pid, {
      active_id: 'sim-round',
      simulations: [row('sim-round', 'Round', 'g-round'), row('sim-tear', 'Tear', 'g-tear')],
    });
    const proj = { id: pid, geometries: [{ id: 'g-round', name: 'round.step' }] };
    const pruned = dropGeometryStudies(pid, proj, 'g-tear');
    assert.deepEqual(ids(pruned.dropped), ['sim-tear']);
    assert.deepEqual(onDisk(pid), ['sim-round']);
    // Its folder went before the catalog save, so the index has no row of it either.
    assert.deepEqual(ids(JSON.parse(readFileSync(join(dir, 'simulations.json'), 'utf8')).simulations), ['sim-round']);
    assert.deepEqual(ids(ensureCatalog(pid, proj).simulations), ['sim-round']);
  });
});

describe('deleting a study', () => {
  it('removes every folder of that study and no other study', () => {
    // deleteSimulation (w17): the catalog save, then the study's folders go.
    const pid = 'p-study-delete';
    const { dir } = twoGeometries(pid, {
      round: [
        ['sim-a', 'Baseline'],
        ['sim-b', 'Fine'],
      ],
      tear: [['sim-c', 'Tear']],
    });
    // A second folder of sim-a (a copy that kept its id), and no row for sim-b.
    createStudyFolder(dir, 'g-round', { id: 'sim-a', name: 'Baseline copy' });
    writeJsonAtomic(join(dir, 'simulations.json'), {
      active_id: 'sim-a',
      simulations: [row('sim-a', 'Baseline', 'g-round'), row('sim-c', 'Tear', 'g-tear')],
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    const proj = { id: pid, geometries: [{ id: 'g-round' }, { id: 'g-tear' }] };
    deleteSimulationFromCatalog(pid, proj, 'sim-a');
    purgeRemovedStudies(pid, { simIds: ['sim-a'] });
    assert.deepEqual(onDisk(pid), ['sim-b', 'sim-c']);
  });

  it('removes nothing when given no study or geometry', () => {
    const pid = 'p-purge-nothing';
    twoGeometries(pid, { round: [['sim-round', 'Round']], tear: [['sim-tear', 'Tear']] });
    purgeRemovedStudies(pid, {});
    purgeRemovedStudies(pid, { simIds: [''], geometryIds: [null] });
    assert.deepEqual(onDisk(pid), ['sim-round', 'sim-tear']);
  });

  it('a folder that will not go is still reported (the delete answers 500), after the others went', () => {
    const pid = 'p-purge-held';
    const { dir } = twoGeometries(pid, { round: [['sim-a', 'Baseline']], tear: [['sim-c', 'Tear']] });
    createStudyFolder(dir, 'g-round', { id: 'sim-a', name: 'Held copy' });
    // A file in one of the two folders held open (the worker reading it) past rmSync's retries.
    const realRm = fs.rmSync;
    fs.rmSync = (path, opts) => {
      if (String(path).endsWith('Held_copy')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      return realRm(path, opts);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => purgeRemovedStudies(pid, { simIds: ['sim-a'] }), /EBUSY/);
    } finally {
      fs.rmSync = realRm;
      syncBuiltinESMExports();
    }
    assert.deepEqual(walkStudies(dir).map((s) => s.folder).sort(), ['Held_copy', 'Tear']);
  });
});
