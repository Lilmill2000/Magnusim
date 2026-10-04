import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';

// The viewport's job chip named the running mesh stage by its raw key ("Meshing ... ·
// prepare_input") while the Mesh panel said "Building the mesh input". The chip names
// the stage as the panel does, from the mesher's stage labels, and a stage the mesher
// does not name adds nothing to "Meshing ..." (never a snake_case key).
// No mesher runs: Generate is answered by the test as a started snappyHexMesh job, and
// the job's progress events are the test's.
const JOB = 'job-mesh-chip-e2e';
// Its own elbow project (it starts a Generate): seeded here and removed after, not on
// every spec's test server.
const PID = 'mesh-chip-stage-e2e';
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: PID, ...extra })}`;

test.beforeAll(() => {
  rmSync(join(PROJECTS, PID), { recursive: true, force: true });
  seedElbowProject(PROJECTS, PID, 'Mesh chip stage');
});

test.afterAll(() => {
  rmSync(join(PROJECTS, PID), { recursive: true, force: true });
});

test('the viewport job chip names the mesh stage as the Mesh panel does, never by its key', async ({ page, request }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  const tree = await (await request.get(q('/api/project/tree'))).json();
  const study = (tree.geometries || []).flatMap((g) => g.studies || [])[0] || {};
  const meshId = String(((study.meshes || [])[0] || {}).id || '');
  expect(meshId, 'seeded mesh').toBeTruthy();

  // The job's state comes from its events only (no status polls answer for it).
  await page.addInitScript(() => {
    window.__CFD_DISABLE_RUN_STATUS_POLL__ = true;
  });
  let stage = 'prepare_input';
  await page.route(`**/api/jobs/${JOB}/events*`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
      body: `event: event\ndata: ${JSON.stringify({ event: 'progress', stage, status: 'running' })}\n\n`,
    });
  });
  await page.route(/\/api\/mesh\/generate(\?|$)/, async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        job_id: JOB,
        status: 'running',
        mode: 'mesh',
        path_kind: 'snappyHexMesh',
        mesh_id: meshId,
        generate_id: 'gen-mesh-chip-e2e',
        stage,
      }),
    });
  });

  await page.goto(`/#/p/${encodeURIComponent(PID)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await form.locator('[data-mesh-generate="1"]').click();

  const panelLine = page.locator('.mesh-finished[data-mesh-status="generating"] .mesh-finished-line');
  const chip = page.locator('#viewport-job-chip');
  const chipLabel = page.locator('#viewport-job-label');
  // The panel's words for a stage: its line without the trailing ellipsis.
  const panelWords = async () => String(await panelLine.textContent()).replace(/\W+$/, '');

  for (const [key, words] of [
    ['prepare_input', 'Building the mesh input'],
    ['snappyHexMesh', 'Snapping the mesh to the surface'],
  ]) {
    if (key !== stage) {
      stage = key;
      await page.evaluate((id) => window.__CFD_WATCH_JOB__(id), JOB);
    }
    await expect(panelLine).toHaveText(new RegExp(`^${words}\\W+$`));
    expect(await panelWords()).toBe(words);
    await expect(chip).toBeVisible();
    await expect.poll(async () => String(await chipLabel.textContent()), `chip at ${key}`).toMatch(/^Meshing /);
    const label = String(await chipLabel.textContent());
    expect(label.endsWith(' ' + words), `chip "${label}" ends with the panel's "${words}"`).toBe(true);
    expect(label, 'no stage key in the chip').not.toContain('_');
    expect(label).not.toContain(key);
  }

  // A stage the mesher has no label for: the chip says "Meshing ..." and no key.
  stage = 'some_new_stage';
  await page.evaluate((id) => window.__CFD_WATCH_JOB__(id), JOB);
  await expect.poll(async () => String(await chipLabel.textContent())).not.toContain('Snapping the mesh');
  const unknown = String(await chipLabel.textContent());
  expect(unknown).toMatch(/^Meshing /);
  expect(unknown).not.toContain('_');
  expect(unknown).not.toContain('some');
});
