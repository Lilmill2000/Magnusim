import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// A study folder's id.json holds the study's identity only. Older versions also kept
// its turbulence model there, and that copy won over simulations.json. Reading the
// project moves such settings into the study's simulations.json row (the id.json
// value still wins), then leaves id.json identity-only.
const root = mkdtempSync(join(tmpdir(), 'cfd-study-id-settings-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { createGeometryFolder, createStudyFolder, findStudy, writeIdFile, writeJsonAtomic } = await import(
  '../project-layout.js'
);
const { ensureCatalog, pruneOrphanStudies, readCatalog, saveCatalog, upsertSimulationInCatalog } = await import(
  '../w17-sim-catalog.js'
);

after(() => rmSync(root, { recursive: true, force: true }));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const mtime = (p) => statSync(p).mtimeMs;

/** What older versions wrote into a study's id.json. */
function legacyIdJson(sid, extra) {
  return {
    id: sid,
    name: 'Incompressible Steady-state',
    geometry_id: 'g1',
    kind: 'simulation',
    analysis: 'Incompressible',
    analysis_type: 'incompressible_steady',
    time_dependency: 'Steady-state',
    algorithm: 'SIMPLE',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    sort_index: 0,
    ...extra,
  };
}

/** The index row older versions saved for the same study. */
function legacyRow(sid) {
  return {
    id: sid,
    project_id: 'x',
    name: 'Incompressible Steady-state',
    geometry_id: 'g1',
    analysis: 'Incompressible',
    analysis_type: 'incompressible_steady',
    analysis_title: 'Incompressible Fluid Flow',
    turbulence_model_key: 'kOmegaSST',
    category: 'FLUID DYNAMICS',
    flow_group: '',
    turbulence_model: 'k-omega SST',
    time_dependency: 'Steady-state',
    algorithm: 'SIMPLE',
    residual_u: 0.0001,
    sort_index: 0,
  };
}

/** A project with one study whose id.json carries `idExtra` on top of its identity. */
function seed(pid, idExtra) {
  const dir = join(root, pid);
  mkdirSync(dir, { recursive: true });
  createGeometryFolder(dir, { id: 'g1', name: 'part.step', original_filename: 'part.step' });
  const study = createStudyFolder(dir, 'g1', { id: 'sim_1', name: 'Incompressible Steady-state' });
  writeIdFile(study.dir, legacyIdJson('sim_1', idExtra));
  writeJsonAtomic(join(dir, 'simulations.json'), {
    active_id: 'sim_1',
    simulations: [{ ...legacyRow('sim_1'), project_id: pid }],
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  return {
    dir,
    idPath: join(study.dir, 'id.json'),
    indexPath: join(dir, 'simulations.json'),
    proj: { id: pid, geometries: [{ id: 'g1', name: 'part.step' }] },
  };
}

const row = (indexPath) => readJson(indexPath).simulations.find((s) => s.id === 'sim_1');

describe("a legacy study id.json's settings move into simulations.json on read", () => {
  it('keeps the id.json value, moves it into the index row and leaves id.json identity-only', async () => {
    const { idPath, indexPath } = seed('p-fold', { turbulence_model: 'kEpsilon' });
    const cat = readCatalog('p-fold');
    const sim = cat.simulations.find((s) => s.id === 'sim_1');
    // Same precedence as before: the id.json value wins over the index.
    assert.equal(sim.turbulence_model, 'kEpsilon');
    // Index-only settings stay as they were.
    assert.equal(sim.turbulence_model_key, 'kOmegaSST');
    assert.equal(sim.residual_u, 0.0001);

    assert.equal(row(indexPath).turbulence_model, 'kEpsilon');
    assert.equal(row(indexPath).turbulence_model_key, 'kOmegaSST');
    const ident = readJson(idPath);
    assert.equal('turbulence_model' in ident, false);
    assert.deepEqual(ident, legacyIdJson('sim_1', {}));

    // A second read finds nothing to move and writes nothing.
    const before = [mtime(idPath), mtime(indexPath)];
    await new Promise((r) => setTimeout(r, 30));
    const again = readCatalog('p-fold').simulations.find((s) => s.id === 'sim_1');
    assert.equal(again.turbulence_model, 'kEpsilon');
    assert.deepEqual([mtime(idPath), mtime(indexPath)], before);
  });

  it('a save after the move keeps the moved value', () => {
    const { idPath, indexPath, proj } = seed('p-fold-save', { turbulence_model: 'kEpsilon' });
    const cat = ensureCatalog('p-fold-save', proj);
    saveCatalog('p-fold-save', cat);
    assert.equal(row(indexPath).turbulence_model, 'kEpsilon');
    assert.equal('turbulence_model' in readJson(idPath), false);
    assert.equal(readCatalog('p-fold-save').simulations[0].turbulence_model, 'kEpsilon');
  });

  it('pruneOrphanStudies, saving straight from the index, keeps an id.json-only value', () => {
    const { dir, idPath, indexPath } = seed('p-fold-prune', { turbulence_model: 'kEpsilon' });
    // A second geometry's study is listed, its geometry gone: the prune saves the index.
    writeJsonAtomic(indexPath, {
      ...readJson(indexPath),
      simulations: [...readJson(indexPath).simulations, { id: 'sim_gone', name: 'Gone', geometry_id: 'g-gone' }],
    });
    const out = pruneOrphanStudies('p-fold-prune', { id: 'p-fold-prune', geometries: [{ id: 'g1' }] });
    assert.deepEqual(
      out.dropped.map((s) => s.id),
      ['sim_gone']
    );
    assert.equal(row(indexPath).turbulence_model, 'kEpsilon');
    assert.equal('turbulence_model' in readJson(idPath), false);
    assert.equal(findStudy(dir, 'sim_1').turbulence_model, undefined);
    assert.equal(readCatalog('p-fold-prune').simulations[0].turbulence_model, 'kEpsilon');
  });

  it('a later change is saved to the index and not written into id.json', () => {
    const { idPath, indexPath, proj } = seed('p-fold-edit', { turbulence_model: 'k-omega SST' });
    const sim = readCatalog('p-fold-edit').simulations[0];
    assert.equal(sim.turbulence_model, 'k-omega SST');
    upsertSimulationInCatalog('p-fold-edit', proj, { ...sim, turbulence_model: 'laminar' });
    assert.equal(row(indexPath).turbulence_model, 'laminar');
    assert.equal('turbulence_model' in readJson(idPath), false);
    assert.equal(readCatalog('p-fold-edit').simulations[0].turbulence_model, 'laminar');
  });

  it('moves any setting, not only the turbulence model', () => {
    const { idPath, indexPath } = seed('p-fold-any', { diffusivity: 0.25, residual_u: 0.001 });
    const sim = readCatalog('p-fold-any').simulations[0];
    assert.equal(sim.diffusivity, 0.25);
    assert.equal(sim.residual_u, 0.001);
    assert.equal(row(indexPath).diffusivity, 0.25);
    assert.equal(row(indexPath).residual_u, 0.001);
    const ident = readJson(idPath);
    assert.equal('diffusivity' in ident, false);
    assert.equal('residual_u' in ident, false);
  });

  it('an id.json that holds only the identity leaves the index untouched', async () => {
    const { idPath, indexPath } = seed('p-identity', {});
    const index = readFileSync(indexPath, 'utf8');
    const before = [mtime(idPath), mtime(indexPath)];
    await new Promise((r) => setTimeout(r, 30));
    const sim = readCatalog('p-identity').simulations[0];
    assert.equal(sim.turbulence_model, 'k-omega SST');
    assert.equal(readFileSync(indexPath, 'utf8'), index);
    assert.deepEqual([mtime(idPath), mtime(indexPath)], before);
  });

  it('an id.json value equal to the index only trims id.json', async () => {
    const { idPath, indexPath } = seed('p-equal', { turbulence_model: 'k-omega SST' });
    const index = readFileSync(indexPath, 'utf8');
    readCatalog('p-equal');
    assert.equal(readFileSync(indexPath, 'utf8'), index);
    assert.equal('turbulence_model' in readJson(idPath), false);
  });

  it('a study the index does not list keeps its id.json settings', () => {
    const { dir, indexPath } = seed('p-unlisted', {});
    const other = createStudyFolder(dir, 'g1', { id: 'sim_2', name: 'Other' });
    writeIdFile(other.dir, legacyIdJson('sim_2', { name: 'Other', turbulence_model: 'kEpsilon', sort_index: 1 }));
    const sim = readCatalog('p-unlisted').simulations.find((s) => s.id === 'sim_2');
    assert.equal(sim.turbulence_model, 'kEpsilon');
    assert.equal(readJson(join(other.dir, 'id.json')).turbulence_model, 'kEpsilon');
    assert.equal(
      readJson(indexPath).simulations.some((s) => s.id === 'sim_2'),
      false
    );
  });

  it('a new study folder and its saved id.json hold the identity only', () => {
    const dir = join(root, 'p-new');
    mkdirSync(dir, { recursive: true });
    createGeometryFolder(dir, { id: 'g1', name: 'part.step', original_filename: 'part.step' });
    const sim = {
      ...legacyRow('sim_n'),
      project_id: 'p-new',
      turbulence_model: 'kOmegaSST',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const study = createStudyFolder(dir, 'g1', sim);
    assert.equal('turbulence_model' in readJson(join(study.dir, 'id.json')), false);
    upsertSimulationInCatalog('p-new', { id: 'p-new', geometries: [{ id: 'g1' }] }, sim);
    const ident = readJson(join(findStudy(dir, 'sim_n').dir, 'id.json'));
    for (const key of ['turbulence_model', 'turbulence_model_key', 'flow_group', 'residual_u', 'category']) {
      assert.equal(key in ident, false, key + ' in id.json');
    }
    const saved = readJson(join(dir, 'simulations.json')).simulations.find((s) => s.id === 'sim_n');
    assert.equal(saved.turbulence_model, 'kOmegaSST');
    assert.equal(saved.residual_u, 0.0001);
  });
});
