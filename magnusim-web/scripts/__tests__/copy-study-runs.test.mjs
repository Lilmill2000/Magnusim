import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyStudyTree,
  createGeometryFolder,
  createMeshFolder,
  createRunFolder,
  createStudyFolder,
  findStudy,
  walkMeshes,
  walkRuns,
  writeJsonAtomic,
} from '../project-layout.js';
import { rewriteCopiedStudy, timeDependenciesMatch } from '../w17-simulation.js';

describe('copy study runs when time dependency matches', () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setupSource({ timeDependency, runCount }) {
    root = mkdtempSync(join(tmpdir(), 'cfd-copy-runs-'));
    createGeometryFolder(root, {
      id: 'g1',
      name: 'cyclone.step',
      original_filename: 'cyclone.step',
    });
    const src = createStudyFolder(root, 'g1', {
      id: 'sim-src',
      name: `Incompressible ${timeDependency} 1`,
      time_dependency: timeDependency,
    });
    const meshes = [];
    const runs = [];
    for (let i = 1; i <= runCount; i += 1) {
      const mesh = createMeshFolder(root, 'sim-src', { id: `m${i}`, name: `Mesh ${i}` });
      writeJsonAtomic(join(mesh.dir, 'mesh.json'), {
        id: `m${i}`,
        name: `Mesh ${i}`,
        simulation_id: 'sim-src',
        generated: true,
        live_mesh_result: { status: 'done', n_cells: 1000 * i, case_dir: join(mesh.dir, 'case') },
      });
      mkdirSync(join(mesh.dir, 'case', 'constant'), { recursive: true });
      writeFileSync(join(mesh.dir, 'case', 'constant', 'owner.txt'), `mesh-${i}`, 'utf8');
      meshes.push(mesh);
      const run = createRunFolder(root, 'sim-src', {
        id: `r${i}`,
        name: `Run ${i}`,
        mesh_id: `m${i}`,
      });
      writeJsonAtomic(join(run.dir, 'run.json'), {
        id: `r${i}`,
        run_id: `r${i}`,
        name: `Run ${i}`,
        simulation_id: 'sim-src',
        mesh_id: `m${i}`,
        mesh_name: `Mesh ${i}`,
        status: 'done',
        endTime: 100 * i,
        writeInterval: 10 * i,
        time_dependency: timeDependency,
        transient: timeDependency === 'Transient' ? { deltaT: 0.001 * i } : undefined,
        result_controls: [{ id: `rc${i}`, name: `Probe ${i}` }],
      });
      mkdirSync(join(run.dir, 'case'), { recursive: true });
      writeFileSync(join(run.dir, 'case', 'owner.txt'), `run-${i}`, 'utf8');
      runs.push(run);
    }
    return { src, meshes, runs };
  }

  function copyDest(src, { cloneCases, copyRuns, destTimeDependency }) {
    const destDir = copyStudyTree(src.dir, join(src.geometry_dir, 'simulations'), 'Copy', {
      cloneCases,
    });
    rewriteCopiedStudy(destDir, 'sim-src', 'sim-new', 'g1', {
      cloneCases,
      copyRuns,
      destTimeDependency,
      destAlgorithm: destTimeDependency === 'Transient' ? 'PIMPLE' : 'SIMPLE',
      projectDirPath: root,
    });
    return destDir;
  }

  it('matches transient to transient and steady to steady', () => {
    assert.equal(timeDependenciesMatch('Transient', 'transient'), true);
    assert.equal(timeDependenciesMatch('Steady-state', 'Steady-state'), true);
    assert.equal(timeDependenciesMatch('Transient', 'Steady-state'), false);
    assert.equal(timeDependenciesMatch('Steady-state', 'Transient'), false);
  });

  it('settings-copy of matching transient seeds one draft run per source run with remapped meshes', () => {
    const { src } = setupSource({ timeDependency: 'Transient', runCount: 2 });
    copyDest(src, { cloneCases: false, copyRuns: true, destTimeDependency: 'Transient' });
    const destRuns = walkRuns(root, 'sim-new');
    const destMeshes = walkMeshes(root, 'sim-new');
    assert.equal(destRuns.length, 2);
    assert.equal(destMeshes.length, 2);
    const meshByName = new Map(destMeshes.map((m) => [m.name, m]));
    for (const rec of destRuns) {
      assert.equal(rec.status, 'draft');
      assert.equal(rec.time_dependency, 'Transient');
      assert.equal(existsSync(join(rec.dir, 'case', 'owner.txt')), false);
      const want = meshByName.get(rec.mesh_name);
      assert.ok(want, `missing dest mesh for ${rec.mesh_name}`);
      assert.equal(String(rec.mesh_id), String(want.id));
      assert.match(String(rec.mesh_id), /^mesh-copy-/);
      assert.ok(rec.endTime);
      assert.ok(rec.transient);
    }
    const times = destRuns.map((r) => r.endTime).sort((a, b) => a - b);
    assert.deepEqual(times, [100, 200]);
  });

  it('settings-copy of matching steady seeds draft runs and remaps meshes', () => {
    const { src } = setupSource({ timeDependency: 'Steady-state', runCount: 1 });
    copyDest(src, { cloneCases: false, copyRuns: true, destTimeDependency: 'Steady-state' });
    const destRuns = walkRuns(root, 'sim-new');
    const destMeshes = walkMeshes(root, 'sim-new');
    assert.equal(destRuns.length, 1);
    assert.equal(String(destRuns[0].mesh_id), String(destMeshes[0].id));
    assert.equal(destRuns[0].status, 'draft');
    assert.equal(destRuns[0].transient, undefined);
  });

  it('does not copy runs when transient is started as steady', () => {
    const { src } = setupSource({ timeDependency: 'Transient', runCount: 2 });
    copyDest(src, { cloneCases: false, copyRuns: false, destTimeDependency: 'Steady-state' });
    assert.equal(walkRuns(root, 'sim-new').length, 0);
    assert.equal(walkMeshes(root, 'sim-new').length, 2);
    const dest = findStudy(root, 'sim-new');
    const ident = JSON.parse(readFileSync(join(dest.dir, 'id.json'), 'utf8'));
    assert.equal(ident.time_dependency, 'Steady-state');
  });

  it('does not copy runs when steady is started as transient', () => {
    const { src } = setupSource({ timeDependency: 'Steady-state', runCount: 1 });
    copyDest(src, { cloneCases: true, copyRuns: false, destTimeDependency: 'Transient' });
    assert.equal(walkRuns(root, 'sim-new').length, 0);
  });

  it('strips CAD faces when settings-copy goes onto another geometry', () => {
    root = mkdtempSync(join(tmpdir(), 'cfd-copy-geom-'));
    createGeometryFolder(root, {
      id: 'g1',
      name: 'first.step',
      original_filename: 'first.step',
    });
    const g2 = createGeometryFolder(root, {
      id: 'g2',
      name: 'teardrop.step',
      original_filename: 'teardrop.step',
    });
    const src = createStudyFolder(root, 'g1', {
      id: 'sim-src',
      name: 'Incompressible Transient 1',
      time_dependency: 'Transient',
    });
    writeJsonAtomic(join(src.dir, 'boundary_conditions.json'), {
      simulation_id: 'sim-src',
      geometry_id: 'g1',
      boundary_conditions: [
        {
          id: 'bc1',
          name: 'Pressure 1',
          bc_type: 'Pressure',
          faces: ['face 8@Body1'],
          face: 'face 8@Body1',
        },
      ],
    });
    const destDir = copyStudyTree(src.dir, join(g2.dir, 'simulations'), 'Incompressible Transient', {
      cloneCases: false,
    });
    rewriteCopiedStudy(destDir, 'sim-src', 'sim-new', 'g2', {
      cloneCases: false,
      copyRuns: false,
      sourceGeometryId: 'g1',
    });
    const dest = JSON.parse(readFileSync(join(destDir, 'boundary_conditions.json'), 'utf8'));
    assert.deepEqual(dest.boundary_conditions[0].faces, []);
    assert.equal(dest.boundary_conditions[0].face, null);
    assert.equal(dest.boundary_conditions[0].geometry_id, 'g2');
    assert.equal(dest.boundary_conditions[0].simulation_id, 'sim-new');
    const srcBcs = JSON.parse(readFileSync(join(src.dir, 'boundary_conditions.json'), 'utf8'));
    assert.deepEqual(srcBcs.boundary_conditions[0].faces, ['face 8@Body1']);
    const destBcRoot = join(destDir, 'boundary_conditions');
    const destBcDirs = readdirSync(destBcRoot).filter((n) => existsSync(join(destBcRoot, n, 'bc.json')));
    assert.equal(destBcDirs.length, 1);
    const destFolderBc = JSON.parse(readFileSync(join(destBcRoot, destBcDirs[0], 'bc.json'), 'utf8'));
    assert.deepEqual(destFolderBc.faces, []);
    assert.equal(destFolderBc.simulation_id, 'sim-new');
  });

  it('clone of matching types remaps run mesh ids and keeps the case', () => {
    const { src } = setupSource({ timeDependency: 'Transient', runCount: 1 });
    copyDest(src, { cloneCases: true, copyRuns: true, destTimeDependency: 'Transient' });
    const destRuns = walkRuns(root, 'sim-new');
    const destMeshes = walkMeshes(root, 'sim-new');
    assert.equal(destRuns.length, 1);
    assert.equal(String(destRuns[0].mesh_id), String(destMeshes[0].id));
    assert.match(String(destRuns[0].mesh_id), /^mesh-copy-/);
    assert.equal(existsSync(join(destRuns[0].dir, 'case', 'owner.txt')), true);
    assert.equal(destRuns[0].status, 'done');
  });
});
