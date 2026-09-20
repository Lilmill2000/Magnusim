import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleReadableRunCase,
  bindRunCasePaths,
  createGeometryFolder,
  createRunFolder,
  createStudyFolder,
  listFoamTimeDirs,
  resolveRunResultsCaseDir,
  walkRuns,
  writeJsonAtomic,
} from '../project-layout.js';
import { studyRunClaimsCaseDir } from '../project-isolation.js';

describe('run results case resolution', () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function writeTime(caseDir, name) {
    const dir = join(caseDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'U'), 'U', 'utf8');
    writeFileSync(join(dir, 'p'), 'p', 'utf8');
  }

  it('lists decimal foam time dirs that have U/p', () => {
    root = mkdtempSync(join(tmpdir(), 'cfd-times-'));
    const cse = join(root, 'case');
    writeTime(cse, '0.02');
    writeTime(cse, '0.04');
    writeTime(cse, '1');
    mkdirSync(join(cse, 'constant'), { recursive: true });
    assert.deepEqual(listFoamTimeDirs(cse), ['0.02', '0.04', '1']);
  });

  it('skips a live write that only has U when listing complete times', () => {
    root = mkdtempSync(join(tmpdir(), 'cfd-times-partial-'));
    const cse = join(root, 'case');
    writeTime(cse, '0.02');
    mkdirSync(join(cse, '0.04'), { recursive: true });
    writeFileSync(join(cse, '0.04', 'U'), 'partial', 'utf8');
    assert.deepEqual(listFoamTimeDirs(cse), ['0.02', '0.04']);
    assert.deepEqual(listFoamTimeDirs(cse, { complete: true }), ['0.02']);
  });

  it('prefers the case folder that actually has frames', () => {
    root = mkdtempSync(join(tmpdir(), 'cfd-run-case-'));
    const empty = join(root, 'copied', 'case');
    mkdirSync(join(empty, '0'), { recursive: true });
    writeFileSync(join(empty, '0', 'U'), 'init', 'utf8');
    const real = join(root, 'original', 'case');
    writeTime(real, '0.02');
    writeTime(real, '0.04');
    writeTime(real, '1');
    const rec = {
      case_dir: empty,
      prepare_run: { case_dir: real },
      argv: ['run_solve.py', '--case-dir', real],
    };
    const resolved = resolveRunResultsCaseDir(rec, join(root, 'copied'));
    assert.equal(resolved, real);
    bindRunCasePaths(rec, join(root, 'copied'));
    assert.equal(rec.case_dir, real);
    assert.equal(listFoamTimeDirs(rec.case_dir).length, 3);
  });

  it('lets a copied study attach frames that still live on the source run', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'cfd-claim-'));
    root = projectsRoot;
    const projectDir = join(projectsRoot, 'proj1');
    mkdirSync(projectDir, { recursive: true });
    createGeometryFolder(projectDir, { id: 'g1', name: 'Transient Test', original_filename: 't.step' });
    createStudyFolder(projectDir, 'g1', { id: 'sim-src', name: 'Incompressible Transient' });
    const dest = createStudyFolder(projectDir, 'g1', { id: 'sim-dst', name: 'Incompressible Transient 1' });
    const srcRun = createRunFolder(projectDir, 'sim-src', { id: 'run-src', name: 'Run 1' });
    const destRun = createRunFolder(projectDir, 'sim-dst', { id: 'run-dst', name: 'Run 1' });
    writeTime(srcRun.case_dir, '0.02');
    writeTime(srcRun.case_dir, '1');
    mkdirSync(join(destRun.dir, 'case', '0'), { recursive: true });
    writeFileSync(join(destRun.dir, 'case', '0', 'U'), 'init', 'utf8');
    writeJsonAtomic(join(destRun.dir, 'run.json'), {
      id: 'run-dst',
      name: 'Run 1',
      case_dir: join(destRun.dir, 'case'),
      prepare_run: { case_dir: srcRun.case_dir },
      argv: ['run_solve.py', '--case-dir', srcRun.case_dir],
    });
    assert.equal(studyRunClaimsCaseDir(srcRun.case_dir, 'proj1', 'sim-dst', projectsRoot), true);
    assert.equal(studyRunClaimsCaseDir(srcRun.case_dir, 'proj1', 'sim-src', projectsRoot), true);
    assert.equal(basename(dest.folder).startsWith('Incompressible_Transient_1') || dest.id === 'sim-dst', true);
  });

  it('stitches copied-case mesh with leftover time folders', () => {
    root = mkdtempSync(join(tmpdir(), 'cfd-heal-'));
    const dest = join(root, 'copied', 'case');
    mkdirSync(join(dest, 'constant', 'polyMesh'), { recursive: true });
    writeFileSync(join(dest, 'constant', 'polyMesh', 'points'), 'pts', 'utf8');
    mkdirSync(join(dest, '0'), { recursive: true });
    writeFileSync(join(dest, '0', 'U'), 'init', 'utf8');
    const src = join(root, 'original', 'case');
    writeTime(src, '0.02');
    writeTime(src, '1');
    const rec = {
      case_dir: dest,
      prepare_run: { case_dir: src },
    };
    const assembled = assembleReadableRunCase(rec, join(root, 'copied'));
    assert.equal(assembled, dest);
    assert.deepEqual(listFoamTimeDirs(dest), ['0', '0.02', '1']);
    bindRunCasePaths(rec, join(root, 'copied'));
    assert.equal(rec.case_dir, dest);
  });

  it('listing runs does not copy leftover time folders', () => {
    root = mkdtempSync(join(tmpdir(), 'cfd-walk-no-heal-'));
    const projectDir = join(root, 'proj1');
    mkdirSync(projectDir, { recursive: true });
    createGeometryFolder(projectDir, { id: 'g1', name: 'Transient Test', original_filename: 't.step' });
    createStudyFolder(projectDir, 'g1', { id: 'sim-src', name: 'Incompressible Transient' });
    createStudyFolder(projectDir, 'g1', { id: 'sim-dst', name: 'Incompressible Transient 1' });
    const srcRun = createRunFolder(projectDir, 'sim-src', { id: 'run-src', name: 'Run 1' });
    const destRun = createRunFolder(projectDir, 'sim-dst', { id: 'run-dst', name: 'Run 1' });
    writeTime(srcRun.case_dir, '0.02');
    writeTime(srcRun.case_dir, '1');
    mkdirSync(join(destRun.dir, 'case', 'constant', 'polyMesh'), { recursive: true });
    writeFileSync(join(destRun.dir, 'case', 'constant', 'polyMesh', 'points'), 'pts', 'utf8');
    mkdirSync(join(destRun.dir, 'case', '0'), { recursive: true });
    writeFileSync(join(destRun.dir, 'case', '0', 'U'), 'init', 'utf8');
    writeJsonAtomic(join(destRun.dir, 'run.json'), {
      id: 'run-dst',
      name: 'Run 1',
      case_dir: join(destRun.dir, 'case'),
      prepare_run: { case_dir: srcRun.case_dir },
    });
    const listed = walkRuns(projectDir, 'sim-dst').find((r) => r.id === 'run-dst');
    assert.ok(listed);
    assert.equal(listed.case_dir, join(destRun.dir, 'case'));
    assert.equal(existsSync(join(destRun.dir, 'case', '0.02')), false);
    assert.equal(existsSync(join(destRun.dir, 'case', '1')), false);
    assert.deepEqual(listFoamTimeDirs(join(destRun.dir, 'case')), ['0']);
  });
});
