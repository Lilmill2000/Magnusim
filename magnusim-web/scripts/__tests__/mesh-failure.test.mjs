// A failed mesh says why, in words the user can act on, and a mesher that stops with no
// result still ends its mesh "failed" (never "meshing" for ever).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-mesh-failure-'));
const PROJECTS = join(ROOT, 'projects');
const HOOK = join(ROOT, 'mesh-fail-hook.txt');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_TEST_MESH_FAIL = HOOK;

const { MESHER_GONE_TEXT, formatModelPoint, parsePlcError, plainMeshFailure } = await import('../mesh-failure.js');
const { startMeshGenerate, watchGeneratorGone } = await import('../w21-mesh-generate.js');
const { resetComputeSlotForTests } = await import('../compute-slot.js');
const { PYTHON } = await import('../python-env.js');
const { seedElbowProject } = await import('../../e2e/prepare-projects.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));

// The end of the log of a real failed Standard mesh (2026-10-12): gmsh prints the PLC
// lines after the result line, as its process ends.
const HXT_LOG = [
  'MAGNUSIM_EVENT {"event":"progress","stage":"gmsh","msg":"tets: filling the shell between the surface and the hex core (timeout 480s)"}',
  'Exception: HXT 3D mesh failed',
  'MAGNUSIM_EVENT {"event":"result","ok":false,"error":"HXT 3D mesh failed"}',
  'PLC Error:  A vertex lies in a segment.',
  '  Vertex:  [14720] (0.950106,0.668371,-0.003175).',
  '  Segment: [71150, 16254] #-1 (4183)',
  '',
].join('\r\n');

describe('why a mesh failed', () => {
  it('names where the surface mesh crosses itself, in the model units, and what to try', () => {
    assert.deepEqual(parsePlcError(HXT_LOG), {
      message: 'A vertex lies in a segment.',
      vertex: [0.950106, 0.668371, -0.003175],
    });
    assert.equal(
      plainMeshFailure({ error: 'HXT 3D mesh failed', log: HXT_LOG, scaleToMetres: 0.001, gotResult: true }),
      'The volume mesher could not fill the part: the surface mesh crosses itself near (950, 668, −3) mm, ' +
        'often at a thin feature. Try a higher Fineness or the Hex-dominant mesher.',
    );
    // A part in metres, or with no unit known: metres.
    assert.match(plainMeshFailure({ error: 'HXT 3D mesh failed', log: HXT_LOG, gotResult: true }), / near \(0\.95, 0\.668, −0\.003\) m, /);
  });

  it('gives points in each model unit, with sensible decimals', () => {
    assert.equal(formatModelPoint([0.950106, 0.668371, -0.003175], 0.001), '(950, 668, −3) mm');
    assert.equal(formatModelPoint([0.0254, 0.00254, 0], 0.0254), '(1, 0.1, 0) in');
    assert.equal(formatModelPoint([12.5, -3, 0.25], 1), '(12.5, −3, 0.3) m');
    assert.equal(formatModelPoint([0.001, 0.002, 0.0005], 0.01), '(0.1, 0.2, 0.05) cm');
  });

  it('keeps a plain reason for an HXT failure with no PLC lines, and the mesher\'s own error otherwise', () => {
    assert.equal(
      plainMeshFailure({ error: 'HXT 3D mesh failed', log: 'Exception: HXT 3D mesh failed\n', gotResult: true }),
      'The volume mesher could not fill the part. Try a higher Fineness or the Hex-dominant mesher.',
    );
    assert.equal(plainMeshFailure({ error: 'missing source.step: x', log: '', gotResult: true }), 'missing source.step: x');
    assert.equal(plainMeshFailure({ error: null, log: 'stage lines only', gotResult: false }), MESHER_GONE_TEXT);
    assert.equal(MESHER_GONE_TEXT, 'The mesher stopped without a result.');
  });
});

describe('a generator that is gone with no close', () => {
  function fakeChild(pid = 4321) {
    const child = new EventEmitter();
    Object.assign(child, { pid, exitCode: null, signalCode: null });
    const destroyed = [];
    child.stdout = { destroy: () => destroyed.push('stdout') };
    child.stderr = { destroy: () => destroyed.push('stderr') };
    return { child, destroyed };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  it('ends the job with its exit code a grace after the generator is gone', async () => {
    const { child, destroyed } = fakeChild();
    let alive = true;
    const closes = [];
    child.on('close', (code, signal) => closes.push([code, signal]));
    watchGeneratorGone(child, { pollMs: 10, graceMs: 60, alive: () => alive });
    await wait(80);
    assert.deepEqual(closes, [], 'a live generator is left alone');
    alive = false;
    child.exitCode = 1;
    await wait(40);
    assert.deepEqual(closes, [], 'not before the grace');
    await wait(120);
    assert.deepEqual(closes, [[1, null]]);
    assert.deepEqual(destroyed.sort(), ['stderr', 'stdout']);
  });

  it('does nothing when the real close comes, or when the generator never started', async () => {
    const a = fakeChild();
    const closesA = [];
    a.child.on('close', (code) => closesA.push(code));
    watchGeneratorGone(a.child, { pollMs: 10, graceMs: 30, alive: () => false });
    a.child.emit('close', 0, null);
    await wait(120);
    assert.deepEqual(closesA, [0]);

    const b = fakeChild(null);
    let closedB = 0;
    b.child.on('close', () => (closedB += 1));
    watchGeneratorGone(b.child, { pollMs: 10, graceMs: 30, alive: () => false });
    await wait(120);
    assert.equal(closedB, 0, "a spawn error is the 'error' handler's to report");
  });
});

describe('a Standard generate that fails', () => {
  const hasPython = spawnSync(PYTHON, ['--version'], { windowsHide: true }).status === 0;
  const PID = 'mesh-failure-node';
  seedElbowProject(PROJECTS, PID, 'Mesh failure');
  /** mesh_1's own record (geometries/<geometry>/simulations/<study>/meshes/<mesh>/mesh.json). */
  const meshJsonOf = () => {
    const find = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isFile() && ent.name === 'mesh.json' && basename(dirname(dir)) === 'meshes') return p;
        if (ent.isDirectory() && ent.name !== 'case') {
          const hit = find(p);
          if (hit) return hit;
        }
      }
      return null;
    };
    return JSON.parse(readFileSync(find(join(PROJECTS, PID, 'geometries')), 'utf8'));
  };

  /** Generate mesh_1 with the test hook set to `mode`; resolves with every update and the end. */
  async function generate(mode) {
    resetComputeSlotForTests();
    writeFileSync(HOOK, mode);
    const updates = [];
    let end = null;
    const done = new Promise((resolve) => {
      const kicked = startMeshGenerate({
        projectId: PID,
        meshId: 'mesh_1',
        settings: null,
        onUpdate: (fields) => {
          updates.push(fields);
          if (fields.status !== 'running') {
            end = fields;
            resolve(null);
          }
        },
      });
      assert.equal(kicked.ok, true, JSON.stringify(kicked.bodyExtra));
    });
    let timer;
    await Promise.race([done, new Promise((r) => (timer = setTimeout(r, 60_000)))]);
    clearTimeout(timer);
    return { updates, end };
  }

  it('ends failed with the volume mesher\'s reason, in the job and in the mesh record', { skip: !hasPython }, async () => {
    const { updates, end } = await generate('plc');
    assert.ok(end, 'the generate ended');
    assert.equal(end.status, 'failed');
    assert.equal(end.stage, 'failed');
    assert.match(end.error, /^The volume mesher could not fill the part: the surface mesh crosses itself near \(950, 668, −3\) mm/);
    assert.match(end.note, /HXT 3D mesh failed/, 'the mesher\'s own words stay in the note');
    assert.ok(updates.some((u) => u.status === 'running' && u.stage === 'gmsh'), 'it reported its stages first');
    const live = meshJsonOf().live_mesh_result;
    assert.equal(live.status, 'failed');
    assert.equal(live.error, end.error);
  });

  it('ends failed when the mesher stops with no result', { skip: !hasPython }, async () => {
    const { end } = await generate('vanish');
    assert.ok(end, 'the generate ended');
    assert.equal(end.status, 'failed');
    assert.equal(end.error, MESHER_GONE_TEXT);
    assert.equal(meshJsonOf().live_mesh_result.error, MESHER_GONE_TEXT);
  });
});
