import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// The catalog module reads the projects root when it loads.
const root = mkdtempSync(join(tmpdir(), 'cfd-study-delete-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { createGeometryFolder, createStudyFolder, removeStudyFolder } = await import('../project-layout.js');
const { deleteSimulationFromCatalog, saveCatalog, setActiveSimulation } = await import('../w17-sim-catalog.js');

after(() => rmSync(root, { recursive: true, force: true }));

describe('study delete', () => {
  it('the catalog does not list the deleted study again, and activating it changes nothing', () => {
    const pid = 'p-delete';
    const dir = join(root, pid);
    const proj = { id: pid, geometries: [{ id: 'g1', name: 'part.step' }] };
    createGeometryFolder(dir, { id: 'g1', name: 'part.step', original_filename: 'part.step' });
    createStudyFolder(dir, 'g1', { id: 'sim-a', name: 'Baseline' });
    createStudyFolder(dir, 'g1', { id: 'sim-b', name: 'Baseline copy' });
    saveCatalog(pid, {
      simulations: [
        { id: 'sim-a', name: 'Baseline', geometry_id: 'g1' },
        { id: 'sim-b', name: 'Baseline copy', geometry_id: 'g1' },
      ],
      active_id: 'sim-b',
    });

    // The delete saves the catalog while the study's folder is still on disk (the
    // route removes it next). The walk used to put it back into simulations.json.
    const next = deleteSimulationFromCatalog(pid, proj, 'sim-b');
    assert.deepEqual(next.simulations.map((s) => s.id), ['sim-a']);
    assert.equal(next.active_id, 'sim-a');
    const index = () => JSON.parse(readFileSync(join(dir, 'simulations.json'), 'utf8'));
    assert.deepEqual(index().simulations.map((s) => s.id), ['sim-a']);
    assert.equal(index().active_id, 'sim-a');

    removeStudyFolder(dir, 'sim-b');
    const cat = setActiveSimulation(pid, proj, 'sim-b');
    assert.equal(cat.active_id, 'sim-a');
    assert.deepEqual(cat.simulations.map((s) => s.id), ['sim-a']);
    assert.deepEqual(index().simulations.map((s) => s.id), ['sim-a']);
    assert.equal(index().active_id, 'sim-a');
  });

  it('deleting the active first study makes the next one active', () => {
    const pid = 'p-delete-first';
    const dir = join(root, pid);
    const proj = { id: pid, geometries: [{ id: 'g1', name: 'part.step' }] };
    createGeometryFolder(dir, { id: 'g1', name: 'part.step', original_filename: 'part.step' });
    createStudyFolder(dir, 'g1', { id: 'sim-a', name: 'First' });
    createStudyFolder(dir, 'g1', { id: 'sim-b', name: 'Second' });
    saveCatalog(pid, {
      simulations: [
        { id: 'sim-a', name: 'First', geometry_id: 'g1' },
        { id: 'sim-b', name: 'Second', geometry_id: 'g1' },
      ],
      active_id: 'sim-a',
    });
    const next = deleteSimulationFromCatalog(pid, proj, 'sim-a');
    assert.deepEqual(next.simulations.map((s) => s.id), ['sim-b']);
    assert.equal(next.active_id, 'sim-b');
  });
});
