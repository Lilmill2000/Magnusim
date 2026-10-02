import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// The catalog module reads the projects root when it loads.
const root = mkdtempSync(join(tmpdir(), 'cfd-study-clash-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { createGeometryFolder, createRunFolder, createStudyFolder, renameFolderTo, walkStudies, writeJsonAtomic } =
  await import('../project-layout.js');
const { saveCatalog } = await import('../w17-sim-catalog.js');

after(() => rmSync(root, { recursive: true, force: true }));

function seed(pid, names) {
  const dir = join(root, pid);
  createGeometryFolder(dir, { id: 'g1', name: 'part.step', original_filename: 'part.step' });
  const studies = names.map((name, i) => createStudyFolder(dir, 'g1', { id: 'sim-' + i, name }));
  const save = (list = names) =>
    saveCatalog(pid, {
      simulations: list.map((name, i) => ({ id: 'sim-' + i, name, geometry_id: 'g1' })),
      active_id: 'sim-0',
    });
  const folders = () => Object.fromEntries(walkStudies(dir, 'g1').map((s) => [s.id, s.folder]));
  const simsRoot = join(studies[0].geometry_dir, 'simulations');
  return { dir, studies, save, folders, simsRoot };
}

describe('study folders whose names sanitize to the same folder', () => {
  it('"Run A" and "Run A?" keep their folders across catalog saves', () => {
    const { dir, studies, save, folders, simsRoot } = seed('p-clash', ['Run A', 'Run A?']);
    assert.equal(studies[0].folder, 'Run_A');
    assert.equal(studies[1].folder, 'Run_A_2');
    const run = createRunFolder(dir, 'sim-1', { id: 'r1', name: 'Run 1' });
    writeJsonAtomic(join(run.dir, 'run.json'), { id: 'r1', case_dir: join(run.dir, 'case') });

    // Every save renames each study to its own name. The second study used to move to
    // Run_A_3, then back to Run_A_2, on each one.
    for (let i = 0; i < 4; i += 1) {
      save();
      assert.deepEqual(folders(), { 'sim-0': 'Run_A', 'sim-1': 'Run_A_2' }, 'after save ' + (i + 1));
    }
    assert.deepEqual(readdirSync(simsRoot).sort(), ['Run_A', 'Run_A_2']);
    const runDoc = JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8'));
    assert.equal(runDoc.case_dir, join(run.dir, 'case'));
  });

  it('three clashing studies keep _2 and _3', () => {
    const { save, folders } = seed('p-clash-3', ['Run A', 'Run A?', 'Run A*']);
    for (let i = 0; i < 3; i += 1) {
      save();
      assert.deepEqual(folders(), { 'sim-0': 'Run_A', 'sim-1': 'Run_A_2', 'sim-2': 'Run_A_3' });
    }
  });

  it('a suffixed study keeps its folder when the study holding the plain name goes away', () => {
    const { studies, save, folders } = seed('p-clash-gone', ['Run A', 'Run A?']);
    rmSync(studies[0].dir, { recursive: true, force: true });
    save(['Run A', 'Run A?']);
    assert.deepEqual(folders(), { 'sim-1': 'Run_A_2' });
  });

  it('a real rename still moves the folder, once', () => {
    const { save, folders } = seed('p-clash-rename', ['Run A', 'Run A?']);
    save(['Run A', 'Run B']);
    assert.deepEqual(folders(), { 'sim-0': 'Run_A', 'sim-1': 'Run_B' });
    // Renamed back into the clash: a new suffix, then it stays.
    save(['Run A', 'Run A?']);
    const back = folders()['sim-1'];
    assert.match(back, /^Run_A_\d+$/);
    save(['Run A', 'Run A?']);
    assert.equal(folders()['sim-1'], back);
  });

  it('renameFolderTo keeps <wanted>_<n> but not a longer name that only starts with it', () => {
    const { dir, simsRoot } = seed('p-clash-prefix', ['Run A', 'Run A 2b']);
    const other = walkStudies(dir, 'g1').find((s) => s.id === 'sim-1');
    assert.equal(other.folder, 'Run_A_2b');
    const next = renameFolderTo(other.dir, simsRoot, 'Run A');
    assert.notEqual(next, other.dir);
    assert.ok(existsSync(next));
    assert.equal(renameFolderTo(next, simsRoot, 'Run A?'), next);
  });
});
