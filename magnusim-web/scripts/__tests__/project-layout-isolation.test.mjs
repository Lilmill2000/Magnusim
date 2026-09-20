import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  caseUnderOwner,
  copyStudyTree,
  createGeometryFolder,
  createMeshFolder,
  createRunFolder,
  createStudyFolder,
  removeStudyFolder,
  renameFolderTo,
  walkAllMeshes,
  walkMeshes,
  walkRuns,
  walkStudies,
  writeJsonAtomic,
} from '../project-layout.js';
import {
  assembleMeshDocAt,
  persistOneBcAt,
  persistOneMaterialAt,
  persistOneMeshAt,
  persistOneRefinementAt,
  persistOneResultControlAt,
  persistOneRunResultControlAt,
  persistRunAt,
} from '../study-io.js';

describe('tree-aligned isolation', () => {
  let root;
  let s1;
  let s2;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'cfd-layout-'));
    const geom = createGeometryFolder(root, {
      id: 'g1',
      name: 'cyclone.step',
      original_filename: 'cyclone.step',
    });
    assert.match(geom.folder, /^Geometry_cyclone/);
    s1 = createStudyFolder(root, 'g1', { id: 'sim-a', name: 'Incompressible Steady-state 1' });
    s2 = createStudyFolder(root, 'g1', { id: 'sim-b', name: 'Incompressible Steady-state 2' });
    const m1 = createMeshFolder(root, 'sim-a', { id: 'm1', name: 'Mesh 1' });
    const m2 = createMeshFolder(root, 'sim-b', { id: 'm2', name: 'Mesh 1' });
    writeJsonAtomic(join(m1.dir, 'mesh.json'), {
      id: 'm1',
      name: 'Mesh 1',
      simulation_id: 'sim-a',
      generated: true,
      live_mesh_result: { status: 'done', n_cells: 677246, case_dir: join(m1.dir, 'case') },
    });
    writeJsonAtomic(join(m2.dir, 'mesh.json'), {
      id: 'm2',
      name: 'Mesh 1',
      simulation_id: 'sim-b',
      generated: false,
    });
    writeJsonAtomic(join(s1.dir, 'boundary_conditions.json'), {
      boundary_conditions: [{ id: 'bc-a', name: 'Pressure 1', simulation_id: 'sim-a' }],
    });
    writeJsonAtomic(join(s2.dir, 'boundary_conditions.json'), {
      boundary_conditions: [{ id: 'bc-b', name: 'Velocity inlet 1', simulation_id: 'sim-b' }],
    });
    writeJsonAtomic(join(s1.dir, 'materials.json'), {
      materials: [{ id: 'mat-a', name: 'Air', simulation_id: 'sim-a' }],
    });
    writeJsonAtomic(join(s2.dir, 'materials.json'), {
      materials: [{ id: 'mat-b', name: 'Air', simulation_id: 'sim-b' }],
    });
    writeJsonAtomic(join(s1.dir, 'simulation_control.json'), {
      endTime: 300, writeInterval: 50, simulation_id: 'sim-a',
    });
    writeJsonAtomic(join(s2.dir, 'simulation_control.json'), {
      endTime: 400, writeInterval: 50, simulation_id: 'sim-b',
    });
    writeJsonAtomic(join(s1.dir, 'result_controls.json'), {
      result_controls: [{ id: 'rc-a', name: 'Area 1', simulation_id: 'sim-a' }],
    });
    writeJsonAtomic(join(s2.dir, 'result_controls.json'), {
      result_controls: [{ id: 'rc-b', name: 'Area 1', simulation_id: 'sim-b' }],
    });
    mkdirSync(join(m1.dir, 'case', 'constant'), { recursive: true });
    writeFileSync(join(m1.dir, 'case', 'constant', 'owner.txt'), 'sim-a', 'utf8');
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('two geometries keep separate folders', () => {
    const g2 = createGeometryFolder(root, {
      id: 'g2',
      name: 'other.step',
      original_filename: 'other.step',
    });
    const g1 = JSON.parse(readFileSync(join(s1.geometry_dir, 'id.json'), 'utf8'));
    const g2id = JSON.parse(readFileSync(join(g2.dir, 'id.json'), 'utf8'));
    assert.notEqual(g2.dir, s1.geometry_dir);
    assert.ok(!String(g2.dir).includes(s1.folder));
    assert.equal(g1.id, 'g1');
    assert.equal(g2id.id, 'g2');
  });

  it('walks two studies under Geometry_*', () => {
    const studies = walkStudies(root);
    assert.equal(studies.length, 2);
    assert.ok(studies.every((s) => String(s.dir).includes('simulations')));
  });

  it('walkAllMeshes lists every study without mixing case dirs', () => {
    const all = walkAllMeshes(root);
    assert.equal(all.length, 2);
    const a = all.find((m) => m.id === 'm1');
    const b = all.find((m) => m.id === 'm2');
    assert.equal(a.simulation_id, 'sim-a');
    assert.equal(b.simulation_id, 'sim-b');
    assert.ok(caseUnderOwner(a.case_dir, s1.dir));
    assert.ok(caseUnderOwner(b.case_dir, s2.dir));
  });

  it('walk remaps stale mesh_path into this study folder', () => {
    const m1 = walkMeshes(root, 'sim-a')[0];
    writeJsonAtomic(join(m1.dir, 'mesh.json'), {
      id: 'm1',
      name: 'Mesh 1',
      simulation_id: 'sim-a',
      generated: true,
      live_mesh_result: {
        status: 'done',
        n_cells: 677246,
        case_dir: join(root, 'Incompressible_Steady-state', 'meshes', 'Mesh_1', 'case'),
        mesh_path: join(root, 'Incompressible_Steady-state', 'meshes', 'Mesh_1', 'case', 'constant', 'polyMesh'),
      },
    });
    const again = walkMeshes(root, 'sim-a')[0];
    assert.ok(String(again.live_mesh_result.case_dir).includes(s1.folder));
    assert.equal(String(again.live_mesh_result.mesh_path).includes('Incompressible_Steady-state' + sep + 'meshes'), false);
    assert.ok(caseUnderOwner(again.case_dir, s1.dir));
    assert.ok(caseUnderOwner(again.live_mesh_result.mesh_path, s1.dir));
  });

  it('walk remaps a stale run case_dir into this study folder', () => {
    const run = createRunFolder(root, 'sim-a', { id: 'r-stale', name: 'Run stale' });
    writeJsonAtomic(join(run.dir, 'run.json'), {
      id: 'r-stale',
      name: 'Run stale',
      simulation_id: 'sim-a',
      case_dir: join(root, 'Incompressible_Steady-state', 'simulation_runs', 'Run_stale', 'case'),
    });
    const again = walkRuns(root, 'sim-a').find((r) => r.id === 'r-stale');
    assert.ok(again);
    assert.ok(caseUnderOwner(again.case_dir, s1.dir));
    assert.equal(String(again.case_dir).includes('Incompressible_Steady-state' + sep + 'simulation_runs'), false);
  });

  it('renaming a study folder rewrites stored mesh and run paths on disk', () => {
    const extra = createStudyFolder(root, 'g1', { id: 'sim-rename', name: 'Rename Me' });
    const mesh = createMeshFolder(root, 'sim-rename', { id: 'm-rename', name: 'Mesh 1' });
    writeJsonAtomic(join(mesh.dir, 'mesh.json'), {
      id: 'm-rename',
      generated: true,
      live_mesh_result: {
        status: 'done',
        case_dir: join(extra.dir, 'meshes', 'Mesh_1', 'case'),
        mesh_path: join(extra.dir, 'meshes', 'Mesh_1', 'case', 'constant', 'polyMesh'),
      },
    });
    const run = createRunFolder(root, 'sim-rename', { id: 'r-ren', name: 'Run 1' });
    writeJsonAtomic(join(run.dir, 'run.json'), {
      id: 'r-ren',
      case_dir: join(extra.dir, 'simulation_runs', 'Run_1', 'case'),
    });
    const next = renameFolderTo(extra.dir, join(extra.geometry_dir, 'simulations'), 'Renamed Study');
    assert.notEqual(next, extra.dir);
    const meshDoc = JSON.parse(readFileSync(join(next, 'meshes', 'Mesh_1', 'mesh.json'), 'utf8'));
    assert.ok(String(meshDoc.live_mesh_result.mesh_path).includes('Renamed_Study'));
    assert.equal(String(meshDoc.live_mesh_result.mesh_path).includes(extra.folder + sep + 'meshes'), false);
    const runDoc = JSON.parse(readFileSync(join(next, 'simulation_runs', basename(run.dir), 'run.json'), 'utf8'));
    assert.ok(String(runDoc.case_dir).startsWith(next));
  });

  it('two meshes in one study keep separate case folders even if live points at the other', () => {
    const mA = createMeshFolder(root, 'sim-a', { id: 'mesh-a', name: 'Mesh A' });
    const mB = createMeshFolder(root, 'sim-a', { id: 'mesh-b', name: 'Mesh B' });
    writeJsonAtomic(join(mA.dir, 'mesh.json'), {
      id: 'mesh-a',
      name: 'Mesh A',
      simulation_id: 'sim-a',
      generated: true,
      live_mesh_result: { status: 'done', n_cells: 10, case_dir: join(mA.dir, 'case') },
    });
    writeJsonAtomic(join(mB.dir, 'mesh.json'), {
      id: 'mesh-b',
      name: 'Mesh B',
      simulation_id: 'sim-a',
      generated: false,
      live_mesh_result: { status: 'running', case_dir: join(mA.dir, 'case') },
    });
    const listed = walkMeshes(root, 'sim-a');
    const a = listed.find((m) => m.id === 'mesh-a');
    const b = listed.find((m) => m.id === 'mesh-b');
    assert.ok(a && b);
    assert.ok(String(a.case_dir).includes(mA.folder) || caseUnderOwner(a.case_dir, mA.dir));
    assert.ok(String(b.case_dir).includes(mB.folder) || caseUnderOwner(b.case_dir, mB.dir));
    assert.equal(b.live_mesh_result.case_dir, b.case_dir);
    assert.notEqual(a.case_dir, b.case_dir);
    assert.ok(!String(b.live_mesh_result.case_dir).includes(mA.folder));
  });

  it('study 2 mesh is ungenerated and not under study 1', () => {
    const a = walkMeshes(root, 'sim-a');
    const b = walkMeshes(root, 'sim-b');
    assert.equal(a[0].generated, true);
    assert.equal(a[0].live_mesh_result.n_cells, 677246);
    assert.equal(!!b[0].generated, false);
    assert.ok(caseUnderOwner(a[0].case_dir, s1.dir));
    assert.ok(!caseUnderOwner(a[0].case_dir, s2.dir));
    assert.ok(caseUnderOwner(b[0].case_dir, s2.dir));
  });

  it('saving one mesh folder does not rewrite a sibling mesh', () => {
    const mA = createMeshFolder(root, 'sim-a', { id: 'iso-a', name: 'Iso A' });
    const mB = createMeshFolder(root, 'sim-a', { id: 'iso-b', name: 'Iso B' });
    writeJsonAtomic(join(mA.dir, 'mesh.json'), {
      id: 'iso-a',
      name: 'Iso A',
      simulation_id: 'sim-a',
      settings: { name: 'Iso A', fineness: 5 },
    });
    writeJsonAtomic(join(mB.dir, 'mesh.json'), {
      id: 'iso-b',
      name: 'Iso B',
      simulation_id: 'sim-a',
      settings: { name: 'Iso B', fineness: 5 },
    });
    const beforeA = readFileSync(join(mA.dir, 'mesh.json'), 'utf8');
    persistOneMeshAt(root, 'sim-a', {
      id: 'iso-b',
      name: 'Iso B',
      simulation_id: 'sim-a',
      settings: { name: 'Iso B', fineness: 8 },
    });
    assert.equal(readFileSync(join(mA.dir, 'mesh.json'), 'utf8'), beforeA);
    const b = JSON.parse(readFileSync(join(mB.dir, 'mesh.json'), 'utf8'));
    assert.equal(b.settings.fineness, 8);
    assert.equal(b.id, 'iso-b');
  });

  it('saving one run folder does not rewrite a sibling run', () => {
    const rA = createRunFolder(root, 'sim-a', { id: 'run-a', name: 'Run A' });
    const rB = createRunFolder(root, 'sim-a', { id: 'run-b', name: 'Run B' });
    writeJsonAtomic(join(rA.dir, 'run.json'), {
      id: 'run-a',
      name: 'Run A',
      simulation_id: 'sim-a',
      status: 'done',
      case_dir: join(rA.dir, 'case'),
    });
    writeJsonAtomic(join(rB.dir, 'run.json'), {
      id: 'run-b',
      name: 'Run B',
      simulation_id: 'sim-a',
      status: 'draft',
      case_dir: join(rA.dir, 'case'),
    });
    const beforeA = readFileSync(join(rA.dir, 'run.json'), 'utf8');
    persistRunAt(root, 'sim-a', {
      id: 'run-b',
      name: 'Run B',
      simulation_id: 'sim-a',
      status: 'running',
      case_dir: join(rA.dir, 'case'),
    });
    assert.equal(readFileSync(join(rA.dir, 'run.json'), 'utf8'), beforeA);
    const b = JSON.parse(readFileSync(join(rB.dir, 'run.json'), 'utf8'));
    assert.equal(b.status, 'running');
    assert.ok(String(b.case_dir).includes(rB.folder) || caseUnderOwner(b.case_dir, rB.dir));
    assert.equal(String(b.case_dir).includes(rA.folder), false);
  });

  it('a settings persist keeps mesh_id and copied results on a stopped run', () => {
    const run = createRunFolder(root, 'sim-a', { id: 'run-keep', name: 'Run 1' });
    mkdirSync(join(run.dir, 'case', '0.03'), { recursive: true });
    writeFileSync(join(run.dir, 'case', '0.03', 'U'), 'U', 'utf8');
    writeFileSync(join(run.dir, 'case', '0.03', 'p'), 'p', 'utf8');
    writeJsonAtomic(join(run.dir, 'run.json'), {
      id: 'run-keep',
      name: 'Run 1',
      simulation_id: 'sim-a',
      status: 'stopped',
      mesh_id: 'mesh-assigned',
      mesh_name: 'Mesh 1',
      has_results: true,
      n_saved_times: 1,
      last_saved_iteration: 0.03,
      case_dir: join(run.dir, 'case'),
    });
    persistRunAt(root, 'sim-a', {
      id: 'run-keep',
      name: 'Run 1',
      simulation_id: 'sim-a',
      transient: { max_co: 10 },
    });
    const rec = JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8'));
    assert.equal(rec.mesh_id, 'mesh-assigned');
    assert.equal(rec.status, 'stopped');
    assert.equal(rec.has_results, true);
    assert.equal(rec.n_saved_times, 1);
  });

  it('a new start does not keep stop_requested from the previous Stop', () => {
    const run = createRunFolder(root, 'sim-a', { id: 'run-restart', name: 'Run 1' });
    writeJsonAtomic(join(run.dir, 'run.json'), {
      id: 'run-restart',
      name: 'Run 1',
      simulation_id: 'sim-a',
      status: 'stopped',
      stop_requested: true,
      stage: 'copy',
      mesh_id: 'mesh-assigned',
      has_results: true,
      n_saved_times: 4,
    });
    persistRunAt(root, 'sim-a', {
      id: 'run-restart',
      simulation_id: 'sim-a',
      status: 'running',
      has_results: false,
      stop_requested: false,
      stage: 'starting',
      mesh_id: 'mesh-assigned',
    });
    const rec = JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8'));
    assert.equal(rec.stop_requested, false);
    assert.equal(rec.status, 'running');
    assert.notEqual(rec.stage, 'copy');
    assert.equal(rec.mesh_id, 'mesh-assigned');
  });

  it('study-level materials, control, and result controls stay in their study folder', () => {
    const beforeMat = readFileSync(join(s1.dir, 'materials.json'), 'utf8');
    const beforeCtrl = readFileSync(join(s1.dir, 'simulation_control.json'), 'utf8');
    const beforeRc = readFileSync(join(s1.dir, 'result_controls.json'), 'utf8');
    writeJsonAtomic(join(s2.dir, 'materials.json'), {
      materials: [{ id: 'mat-b2', name: 'Air', simulation_id: 'sim-b' }],
    });
    writeJsonAtomic(join(s2.dir, 'simulation_control.json'), {
      endTime: 900, writeInterval: 25, simulation_id: 'sim-b',
    });
    writeJsonAtomic(join(s2.dir, 'result_controls.json'), {
      result_controls: [{ id: 'rc-b2', name: 'Area 2', simulation_id: 'sim-b' }],
    });
    assert.equal(readFileSync(join(s1.dir, 'materials.json'), 'utf8'), beforeMat);
    assert.equal(readFileSync(join(s1.dir, 'simulation_control.json'), 'utf8'), beforeCtrl);
    assert.equal(readFileSync(join(s1.dir, 'result_controls.json'), 'utf8'), beforeRc);
    const ctrl = JSON.parse(readFileSync(join(s2.dir, 'simulation_control.json'), 'utf8'));
    assert.equal(ctrl.endTime, 900);
  });

  it('each BC, material, refinement, and result control gets its own folder', () => {
    persistOneBcAt(root, 'sim-a', {
      id: 'bc-fold-1',
      name: 'Velocity inlet 1',
      bc_type: 'Velocity inlet',
      value: 5,
      simulation_id: 'sim-a',
    });
    persistOneBcAt(root, 'sim-a', {
      id: 'bc-fold-2',
      name: 'Pressure 1',
      bc_type: 'Pressure',
      value: 0,
      simulation_id: 'sim-a',
    });
    persistOneMaterialAt(root, 'sim-a', {
      id: 'mat-fold-1',
      name: 'Air',
      density: 1.2,
      simulation_id: 'sim-a',
    });
    persistOneMaterialAt(root, 'sim-a', {
      id: 'mat-fold-2',
      name: 'Water',
      density: 998,
      simulation_id: 'sim-a',
    });
    persistOneResultControlAt(root, 'sim-a', {
      id: 'rc-fold-1',
      name: 'Area 1',
      simulation_id: 'sim-a',
    });
    persistOneResultControlAt(root, 'sim-a', {
      id: 'rc-fold-2',
      name: 'Area 2',
      simulation_id: 'sim-a',
    });
    persistOneRefinementAt(root, 'm1', 'sim-a', {
      id: 'ref-fold-1',
      name: 'Local 1',
      type: 'Local',
      mesh_id: 'm1',
      simulation_id: 'sim-a',
    });
    persistOneRefinementAt(root, 'm1', 'sim-a', {
      id: 'ref-fold-2',
      name: 'Local 2',
      type: 'Local',
      mesh_id: 'm1',
      simulation_id: 'sim-a',
    });
    const bcRoot = join(s1.dir, 'boundary_conditions');
    const matRoot = join(s1.dir, 'materials');
    const rcRoot = join(s1.dir, 'result_controls');
    const refRoot = join(s1.dir, 'meshes', 'Mesh_1', 'refinements');
    const bcDirs = readdirSync(bcRoot).filter((n) => existsSync(join(bcRoot, n, 'bc.json')));
    const matDirs = readdirSync(matRoot).filter((n) => existsSync(join(matRoot, n, 'material.json')));
    const rcDirs = readdirSync(rcRoot).filter((n) => existsSync(join(rcRoot, n, 'result_control.json')));
    const refDirs = readdirSync(refRoot).filter((n) => existsSync(join(refRoot, n, 'refinement.json')));
    assert.ok(bcDirs.length >= 2);
    assert.ok(matDirs.length >= 2);
    assert.ok(rcDirs.length >= 2);
    assert.ok(refDirs.length >= 2);
    const aggregate = JSON.parse(readFileSync(join(s1.dir, 'boundary_conditions.json'), 'utf8'));
    assert.ok((aggregate.boundary_conditions || []).some((b) => b.id === 'bc-fold-1'));
    assert.ok((aggregate.boundary_conditions || []).some((b) => b.id === 'bc-fold-2'));
    const beforeBc1 = readFileSync(join(bcRoot, bcDirs.find((n) => n.startsWith('BC_Velocity')), 'bc.json'), 'utf8');
    persistOneBcAt(root, 'sim-a', {
      id: 'bc-fold-2',
      name: 'Pressure 1',
      bc_type: 'Pressure',
      value: 12,
      simulation_id: 'sim-a',
    });
    assert.equal(readFileSync(join(bcRoot, bcDirs.find((n) => n.startsWith('BC_Velocity')), 'bc.json'), 'utf8'), beforeBc1);
    const beforeMat1 = readFileSync(join(matRoot, matDirs.find((n) => n.includes('Air')), 'material.json'), 'utf8');
    persistOneMaterialAt(root, 'sim-a', {
      id: 'mat-fold-2',
      name: 'Water',
      density: 1000,
      simulation_id: 'sim-a',
    });
    assert.equal(readFileSync(join(matRoot, matDirs.find((n) => n.includes('Air')), 'material.json'), 'utf8'), beforeMat1);
    const beforeRc1 = readFileSync(join(rcRoot, rcDirs.find((n) => n.includes('Area_1')), 'result_control.json'), 'utf8');
    persistOneResultControlAt(root, 'sim-a', {
      id: 'rc-fold-2',
      name: 'Area 2',
      faces: ['face 1@Body1'],
      simulation_id: 'sim-a',
    });
    assert.equal(readFileSync(join(rcRoot, rcDirs.find((n) => n.includes('Area_1')), 'result_control.json'), 'utf8'), beforeRc1);
    const beforeRef1 = readFileSync(join(refRoot, refDirs.find((n) => n.includes('Local_1')), 'refinement.json'), 'utf8');
    persistOneRefinementAt(root, 'm1', 'sim-a', {
      id: 'ref-fold-2',
      name: 'Local 2',
      type: 'Local',
      size: 0.01,
      mesh_id: 'm1',
      simulation_id: 'sim-a',
    });
    assert.equal(readFileSync(join(refRoot, refDirs.find((n) => n.includes('Local_1')), 'refinement.json'), 'utf8'), beforeRef1);
  });

  it('assembleMeshDoc never falls back to the first mesh when an id is asked for', () => {
    const missing = assembleMeshDocAt(root, 'sim-a', 'missing-mesh');
    assert.equal(missing.active_id, null);
    assert.equal(missing.settings, null);
    const none = assembleMeshDocAt(root, 'sim-a');
    assert.equal(none.active_id, null);
    assert.ok(none.meshes.length >= 1);
    const one = assembleMeshDocAt(root, 'sim-a', 'm1');
    assert.equal(one.active_id, 'm1');
    assert.equal(one.id, 'm1');
    assert.notEqual(one.id, one.meshes.find((m) => m.id !== 'm1') && one.meshes.find((m) => m.id !== 'm1').id);
  });

  it('each run monitor gets its own folder and saving one does not rewrite a sibling', () => {
    persistRunAt(root, 'sim-a', {
      id: 'run-rc-iso',
      name: 'Run RC iso',
      simulation_id: 'sim-a',
      result_controls: [
        { id: 'aa-1', name: 'Area 1', faces: ['face 1@Body1'] },
        { id: 'aa-2', name: 'Area 2', faces: ['face 2@Body1'] },
      ],
    });
    const run = walkRuns(root, 'sim-a').find((r) => r.id === 'run-rc-iso');
    assert.ok(run);
    const rcRoot = join(run.dir, 'result_controls');
    const rcDirs = readdirSync(rcRoot).filter((n) => existsSync(join(rcRoot, n, 'result_control.json')));
    assert.ok(rcDirs.length >= 2);
    const before1 = readFileSync(join(rcRoot, rcDirs.find((n) => n.includes('Area_1')), 'result_control.json'), 'utf8');
    persistOneRunResultControlAt(root, 'sim-a', 'run-rc-iso', {
      id: 'aa-2',
      name: 'Area 2',
      faces: ['face 9@Body1'],
      simulation_id: 'sim-a',
      run_id: 'run-rc-iso',
    });
    assert.equal(readFileSync(join(rcRoot, rcDirs.find((n) => n.includes('Area_1')), 'result_control.json'), 'utf8'), before1);
    const two = JSON.parse(readFileSync(join(rcRoot, rcDirs.find((n) => n.includes('Area_2')), 'result_control.json'), 'utf8'));
    assert.deepEqual(two.faces, ['face 9@Body1']);
    const runJson = JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8'));
    assert.equal(runJson.result_controls, undefined);
  });

  it('BCs stay in their study folder', () => {
    const before = readFileSync(join(s1.dir, 'boundary_conditions.json'), 'utf8');
    writeJsonAtomic(join(s2.dir, 'boundary_conditions.json'), {
      boundary_conditions: [{ id: 'bc-b2', name: 'Velocity inlet 2', simulation_id: 'sim-b' }],
    });
    const after = readFileSync(join(s1.dir, 'boundary_conditions.json'), 'utf8');
    assert.equal(before, after);
    const b = JSON.parse(readFileSync(join(s2.dir, 'boundary_conditions.json'), 'utf8'));
    assert.equal(b.boundary_conditions[0].name, 'Velocity inlet 2');
  });

  it('settings-copy skips case/ and simulation_runs; clone gets its own case/', () => {
    const run = createRunFolder(root, 'sim-a', { id: 'r1', name: 'Run 1' });
    writeJsonAtomic(join(run.dir, 'run.json'), {
      id: 'r1',
      name: 'Run 1',
      simulation_id: 'sim-a',
      status: 'failed',
    });
    const parent = join(s1.geometry_dir, 'simulations');
    const settingsDest = copyStudyTree(s1.dir, parent, 'Copy settings', { cloneCases: false });
    assert.equal(existsSync(join(settingsDest, 'meshes', 'Mesh_1', 'case', 'constant', 'owner.txt')), false);
    assert.equal(existsSync(join(settingsDest, 'simulation_runs')), true);
    const copiedRuns = readdirSync(join(settingsDest, 'simulation_runs')).filter((n) => !n.startsWith('.'));
    assert.equal(copiedRuns.length, 0);
    const cloneDest = copyStudyTree(s1.dir, parent, 'Clone', { cloneCases: true });
    const cloned = join(cloneDest, 'meshes', 'Mesh_1', 'case', 'constant', 'owner.txt');
    assert.equal(existsSync(cloned), true);
    assert.notEqual(cloneDest, s1.dir);
    assert.equal(readFileSync(cloned, 'utf8'), 'sim-a');
  });

  it('delete study 2 leaves study 1 folder intact', () => {
    const before = readFileSync(join(s1.dir, 'boundary_conditions.json'), 'utf8');
    assert.equal(removeStudyFolder(root, 'sim-b'), true);
    assert.equal(walkStudies(root).some((s) => s.id === 'sim-b'), false);
    assert.equal(existsSync(s1.dir), true);
    assert.equal(readFileSync(join(s1.dir, 'boundary_conditions.json'), 'utf8'), before);
  });
});
