import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectGeneratedCase,
  liveChildIsRunning,
  meshCloseStatus,
  meshStopMatchesLive,
  pidIsAlive,
  settingsForMesh,
} from '../w21-mesh-generate.js';

describe('mesh generate handshake', () => {
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
