import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UNOWNED_MESH_PROJECT as PID } from './prepare-projects.js';

// A mesh whose generator this server did not start (another server on the same
// projects folder, or the instance a Vite restart replaced) is still meshing while that
// generator runs. Opening its project used to mark it "failed" with no reason at once:
// a full e2e run failed on a mesh that then finished fine. It must stay running, and
// only when that generator dies with nobody to report a result end failed, saying why.
test('a mesh another process is generating stays running, then says why when that process dies', async ({ page, request }) => {
  test.setTimeout(180_000);
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: PID, ...extra })}`;
  const treeMesh = async () => {
    const tree = await (await request.get(q('/api/project/tree'))).json();
    const study = (tree.geometries || []).flatMap((g) => g.studies || [])[0] || {};
    return { study, mesh: (study.meshes || [])[0] || {} };
  };
  const { study, mesh } = await treeMesh();
  expect(mesh.id, 'seeded mesh').toBeTruthy();
  const caseDir = mesh.case_dir;
  const meshJson = join(dirname(caseDir), 'mesh.json');
  const spin = page.locator(`#left-tree li[data-w20-mesh-item="${mesh.id}"] > .tree-row .tree-spin`);

  // The other generator: a live process holding the case lock, as generate_standard.py does.
  const gen = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const generateId = 'e2e-unowned';
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, '.generate.lock'), JSON.stringify({ pid: gen.pid, generate_id: generateId, mesh_id: mesh.id }));
    const rec = JSON.parse(readFileSync(meshJson, 'utf8'));
    rec.generated = false;
    rec.live_mesh_result = {
      status: 'running',
      mode: 'mesh',
      path_kind: 'standard',
      engine: 'standard',
      generate_id: generateId,
      pid: null,
      case_dir: caseDir,
      mesh_path: join(caseDir, 'constant', 'polyMesh'),
      started_at: new Date().toISOString(),
      finished_at: null,
      stage: 'gmsh',
      stage_detail: 'tets: filling the volume',
      error: null,
      fingerprint_before: null,
    };
    writeFileSync(meshJson, JSON.stringify(rec, null, 2));

    // Opening the project hydrates its mesh state on the server.
    await page.goto(`/#/p/${encodeURIComponent(PID)}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
    // Past the server's grace for a result after a generator exits: still running.
    for (let i = 0; i < 6; i++) {
      expect((await treeMesh()).mesh.live_status, `check ${i}`).toBe('running');
      await expect(spin).toBeAttached();
      await page.waitForTimeout(2_000);
    }
    const apiMesh = await (await request.get(q('/api/mesh', { simulation_id: study.id, mesh_id: mesh.id }))).json();
    expect(apiMesh.mesh?.live_mesh_result?.status).toBe('running');

    // The generator dies without writing a result: the mesh ends failed, with a reason.
    gen.kill();
    await expect.poll(async () => (await treeMesh()).mesh.live_status, { timeout: 60_000, intervals: [1_000] }).toBe('failed');
    const failed = await (await request.get(q('/api/mesh', { simulation_id: study.id, mesh_id: mesh.id }))).json();
    expect(failed.mesh?.live_mesh_result?.error).toBe('Meshing stopped when the server restarted.');
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
    await expect(page.locator(`#left-tree li[data-w20-mesh-item="${mesh.id}"]`)).toBeAttached();
    await expect(spin).toHaveCount(0);
  } finally {
    gen.kill();
  }
});
