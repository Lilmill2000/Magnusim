import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PYTHON } from '../python-env.js';
import {
  closeAfterExit,
  inspectGeneratedCase,
  liveChildIsRunning,
  meshCloseStatus,
  meshStopMatchesLive,
  pidIsAlive,
  resolveMeshBackend,
  settingsForMesh,
} from '../w21-mesh-generate.js';

describe('mesh generate handshake', () => {
  it('runs the mesher picked in the panel engine select', () => {
    // The panel writes the registry key to advanced.mesh_engine (settingsFrom in MeshPanel.tsx).
    const pick = (engine) => resolveMeshBackend({ ui_mesh_engine: engine, advanced: { mesh_engine: engine } });
    assert.equal(pick('snappy_hexdominant'), 'snappy_hexdominant');
    assert.equal(pick('standard'), 'standard');
    assert.equal(resolveMeshBackend({}), 'standard');
    assert.equal(resolveMeshBackend({ algorithm: 'Hex-dominant' }), 'snappy_hexdominant');
  });

  it('does not treat a dead child as a live lock', () => {
    assert.equal(liveChildIsRunning(null), false);
    assert.equal(liveChildIsRunning({ killed: true, pid: 1, exitCode: null }), false);
    assert.equal(liveChildIsRunning({ killed: false, pid: 1, exitCode: 0 }), false);
    assert.equal(liveChildIsRunning({ killed: false, pid: 1, signalCode: 'SIGTERM', exitCode: null }), false);
    assert.equal(liveChildIsRunning({ killed: false, pid: 99999999, exitCode: null }), false);
    assert.equal(pidIsAlive(process.pid), true);
    assert.equal(pidIsAlive(99999999), false);
  });

  it('recognizes a finished case from polyMesh + w21-counts without generate-*.log', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfd-mesh-hs-'));
    try {
      const caseDir = join(root, 'case');
      mkdirSync(join(caseDir, 'constant', 'polyMesh'), { recursive: true });
      writeFileSync(join(caseDir, 'constant', 'polyMesh', 'points'), 'FoamFile\n{\n}\n307529\n(\n)\n', 'utf8');
      writeFileSync(
        join(caseDir, 'w21-counts.json'),
        JSON.stringify({ n_cells: 700209, n_points: 307529, n_faces: 1668556, generate_id: '846f4ad1' }),
        'utf8'
      );
      writeFileSync(join(caseDir, 'log.standard_generate.txt'), 'Standard mesh OK — 700209 cells / MESH_SCRIPT_OK\n', 'utf8');
      const found = inspectGeneratedCase(caseDir);
      assert.ok(found);
      assert.equal(found.n_cells, 700209);
      assert.equal(found.generate_id, '846f4ad1');
      assert.equal(found.script_ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads fineness from that mesh id, not the catalog first mesh', () => {
    const doc = {
      settings: { name: 'Mesh 1', fineness: 5 },
      meshes: [
        { id: 'mesh-1', settings: { name: 'Mesh 1', fineness: 5 } },
        { id: 'mesh-2', settings: { name: 'Mesh 2', fineness: 5 } },
      ],
    };
    assert.equal(settingsForMesh(doc, 'mesh-2').fineness, 5);
    assert.equal(settingsForMesh(doc, 'mesh-2').name, 'Mesh 2');
    assert.equal(settingsForMesh(doc, 'mesh-2', { fineness: 10 }).fineness, 10);
    assert.equal(settingsForMesh(doc, 'mesh-2', { fineness: 10 }).name, 'Mesh 2');
    assert.equal(settingsForMesh(doc, 'missing'), null);
    assert.notEqual(settingsForMesh(doc, 'mesh-2').name, settingsForMesh(doc, 'mesh-1').name);
    assert.equal(settingsForMesh(doc, 'mesh-2', { fineness: 8 }).fineness, 8);
    assert.equal(settingsForMesh(doc, 'mesh-2', { fineness: 8 }).name, 'Mesh 2');
  });

  it('cancels only the live mesh and never marks a stopped generate done', () => {
    const live = { mesh_id: 'mesh-2', project_id: 'proj-1' };
    assert.equal(meshStopMatchesLive(null, { meshId: 'mesh-2' }).match, false);
    assert.equal(meshStopMatchesLive(live, { meshId: 'mesh-1' }).reason, 'other_mesh');
    assert.equal(meshStopMatchesLive(live, { meshId: 'mesh-2' }).match, true);
    assert.equal(meshStopMatchesLive(live, { projectId: 'other' }).reason, 'other_project');
    assert.equal(meshCloseStatus({ stopRequested: true, ok: true }), 'stopped');
    assert.equal(meshCloseStatus({ stopRequested: false, ok: true }), 'done');
    assert.equal(meshCloseStatus({ stopRequested: false, ok: false }), 'failed');
  });

  it('ignores a mesh folder with no polyMesh', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfd-mesh-empty-'));
    try {
      mkdirSync(join(root, 'case'), { recursive: true });
      assert.equal(inspectGeneratedCase(join(root, 'case')), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('generator that dies abnormally', () => {
  const hasPython = spawnSync(PYTHON, ['--version'], { windowsHide: true }).status === 0;

  /**
   * A python parent that leaves a child holding its stdout, then exits: what a
   * killed venv launcher or a crashed generator looks like. 'close' only comes
   * once the orphan exits, which for a gmsh/WSL child can be never.
   */
  function spawnOrphaningParent() {
    const code =
      'import subprocess, sys, time\n' +
      "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n" +
      "print('GRANDCHILD', g.pid, flush=True)\n" +
      'time.sleep(0.2)\n' +
      'sys.exit(3)\n';
    return spawn(PYTHON, ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  }

  it('frees the live lock and finishes the job even when orphans hold the pipes', { skip: !hasPython }, async () => {
    const child = spawnOrphaningParent();
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
    });
    let orphaned = 0;
    let grandchild = 0;
    closeAfterExit(child, {
      graceMs: 300,
      onOrphaned: () => {
        orphaned += 1;
        grandchild = Number((out.match(/GRANDCHILD (\d+)/) || [])[1]) || 0;
      },
    });
    let exitedAt = 0;
    child.on('exit', () => {
      exitedAt = Date.now();
    });
    try {
      const closed = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 15000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, lagMs: Date.now() - exitedAt });
        });
      });
      assert.equal(liveChildIsRunning(child), false, 'a dead generator is not "already running"');
      assert.ok(closed, "'close' fires so the job is finalized and the queue kicked");
      assert.equal(closed.code, 3);
      assert.ok(closed.lagMs < 5000, `close came ${closed.lagMs} ms after exit`);
      assert.equal(orphaned, 1);
      assert.ok(grandchild > 0 && pidIsAlive(grandchild), 'the orphan was still holding the pipe');
    } finally {
      if (grandchild) {
        try {
          process.kill(grandchild);
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('leaves a normal exit alone', async () => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ok')"], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    let orphaned = 0;
    closeAfterExit(child, { graceMs: 200, onOrphaned: () => (orphaned += 1) });
    await new Promise((resolve) => child.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(orphaned, 0);
  });
});
