import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// The catalog module reads the projects root when it loads.
const root = mkdtempSync(join(tmpdir(), 'cfd-missing-study-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { createGeometryFolder, createStudyFolder, writeJsonAtomic } = await import('../project-layout.js');
const { ensureCatalog, listSimulations, pruneOrphanStudies, setActiveSimulation } = await import('../w17-sim-catalog.js');

after(() => rmSync(root, { recursive: true, force: true }));

const row = (id, name, geometryId = 'g1') => ({
  id,
  name,
  geometry_id: geometryId,
  analysis: 'Incompressible',
  time_dependency: 'Steady-state',
});
const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const ids = (list) => (list || []).map((s) => s.id);

/**
 * A project saved before a study delete dropped the study from the index: the row stayed,
 * and activating it made it active_id (and simulation.json a copy of it).
 */
function damagedProject(pid) {
  const dir = join(root, pid);
  const proj = { id: pid, geometries: [{ id: 'g1', name: 'part.step' }] };
  createGeometryFolder(dir, { id: 'g1', name: 'part.step', original_filename: 'part.step' });
  createStudyFolder(dir, 'g1', { id: 'sim-a', name: 'Baseline' });
  createStudyFolder(dir, 'g1', { id: 'sim-b', name: 'Fine' });
  writeJsonAtomic(join(dir, 'simulations.json'), {
    active_id: 'sim-gone',
    simulations: [row('sim-a', 'Baseline'), row('sim-gone', 'Deleted'), row('sim-b', 'Fine')],
    updated_at: '2026-09-01T00:00:00.000Z',
  });
  writeJsonAtomic(join(dir, 'simulation.json'), row('sim-gone', 'Deleted'));
  return { dir, proj };
}

describe('a study the index lists after its folder is gone', () => {
  it('is not listed; the first study left is active, and the index on disk is fixed', () => {
    const { dir, proj } = damagedProject('p-missing');
    const cat = ensureCatalog('p-missing', proj);
    assert.deepEqual(ids(cat.simulations), ['sim-a', 'sim-b']);
    assert.equal(cat.active_id, 'sim-a');
    assert.deepEqual(ids(listSimulations('p-missing', proj)), ['sim-a', 'sim-b']);
    const index = read(dir, 'simulations.json');
    assert.deepEqual(ids(index.simulations), ['sim-a', 'sim-b']);
    assert.equal(index.active_id, 'sim-a');
    assert.equal(read(dir, 'simulation.json').id, 'sim-a');
  });

  it('activating it (an old tab, a queued job) keeps a study that exists', () => {
    const { dir, proj } = damagedProject('p-missing-activate');
    const cat = setActiveSimulation('p-missing-activate', proj, 'sim-gone');
    assert.equal(cat.active_id, 'sim-a');
    assert.deepEqual(ids(cat.simulations), ['sim-a', 'sim-b']);
    assert.equal(read(dir, 'simulations.json').active_id, 'sim-a');
    assert.equal(setActiveSimulation('p-missing-activate', proj, 'sim-b').active_id, 'sim-b');
    assert.deepEqual(ids(read(dir, 'simulations.json').simulations), ['sim-a', 'sim-b']);
    assert.equal(read(dir, 'simulations.json').active_id, 'sim-b');
  });

  it('an index with every folder is not written', () => {
    const pid = 'p-whole';
    const dir = join(root, pid);
    const proj = { id: pid, geometries: [{ id: 'g1', name: 'part.step' }] };
    createGeometryFolder(dir, { id: 'g1', name: 'part.step', original_filename: 'part.step' });
    createStudyFolder(dir, 'g1', { id: 'sim-a', name: 'Baseline' });
    createStudyFolder(dir, 'g1', { id: 'sim-b', name: 'Fine' });
    const index = {
      active_id: 'sim-b',
      simulations: [row('sim-a', 'Baseline'), row('sim-b', 'Fine')],
      updated_at: '2026-09-01T00:00:00.000Z',
    };
    writeJsonAtomic(join(dir, 'simulations.json'), index);
    const cat = ensureCatalog(pid, proj);
    assert.deepEqual(ids(cat.simulations), ['sim-a', 'sim-b']);
    assert.equal(cat.active_id, 'sim-b');
    assert.deepEqual(read(dir, 'simulations.json'), index);
  });
});

describe('geometry remove', () => {
  it("leaves no row of the removed geometry's studies", () => {
    // removeGeometry (w16) takes the geometry folder away first, then prunes the catalog.
    const pid = 'p-geometry-remove';
    const dir = join(root, pid);
    createGeometryFolder(dir, { id: 'g1', name: 'round.step', original_filename: 'round.step' });
    const tear = createGeometryFolder(dir, { id: 'g2', name: 'tear.step', original_filename: 'tear.step' });
    createStudyFolder(dir, 'g1', { id: 'sim-round', name: 'Round' });
    createStudyFolder(dir, 'g2', { id: 'sim-tear', name: 'Tear' });
    writeJsonAtomic(join(dir, 'simulations.json'), {
      active_id: 'sim-tear',
      simulations: [row('sim-round', 'Round', 'g1'), row('sim-tear', 'Tear', 'g2')],
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    rmSync(tear.dir, { recursive: true, force: true });
    const proj = { id: pid, geometries: [{ id: 'g1', name: 'round.step' }] };
    const pruned = pruneOrphanStudies(pid, proj);
    assert.deepEqual(ids(pruned.catalog.simulations), ['sim-round']);
    assert.equal(pruned.catalog.active_id, 'sim-round');
    assert.deepEqual(ids(pruned.dropped), ['sim-tear']);
    const index = read(dir, 'simulations.json');
    assert.deepEqual(ids(index.simulations), ['sim-round']);
    assert.equal(index.active_id, 'sim-round');
    assert.deepEqual(ids(ensureCatalog(pid, proj).simulations), ['sim-round']);
  });
});
