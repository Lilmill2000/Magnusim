import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { e2eTemp, startHost } from './support/host-server.mjs';

// "It should let me know the meshing failed instead of it just going endlessly."
// A Standard mesh failed after a minute ("HXT 3D mesh failed"); the server recorded the
// failure, but the page went back to "Meshing" for good: the job's event stream, read
// after the page had shown the end (a late or replayed stream: a busy tab, a reconnect),
// turned every replayed stage back into "running". Now an ended job stays ended, and
// the user sees why it failed in plain words, with what to try:
//   - the Mesh panel: "Mesh failed" and the reason (where the surface mesh crosses itself,
//     in the model's units), Generate available again;
//   - the tree's mesh row: no spinner, "Failed"; no "Meshing" chip; the Queue runs nothing;
//   - all of it again after a reload.
// And a mesher that stops with no result ends the mesh failed, saying so, at once.
// No WSL and no meshing: the server's test hook (MAGNUSIM_TEST_MESH_FAIL) makes
// generate_standard.py fail the way the real one did, after a few stages.
const PID = 'sample-project-steady-state-e2e';
const MESH = 'mesh_1';
const PLC_REASON =
  'The volume mesher could not fill the part: the surface mesh crosses itself near (950, 668, −3) mm, ' +
  'often at a thin feature. Try a higher Fineness or the Hex-dominant mesher.';
let host;
let hook;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const tmp = e2eTemp('mesh-failure');
  hook = join(tmp, 'mesh-fail-hook.txt');
  host = await startHost({ name: 'mesh-failure', tmp, env: { MAGNUSIM_TEST_MESH_FAIL: hook } });
});

test.afterAll(() => {
  if (host) host.stop();
});

const q = (path, extra = {}) => `${host.base}${path}?${new URLSearchParams({ project_id: PID, ...extra })}`;

async function openProject(page) {
  await page.goto(`${host.base}/#/p/${encodeURIComponent(PID)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
}

async function openMeshPanel(page) {
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), MESH);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible({ timeout: 30_000 });
  return form;
}

/** Every text the job toast shows from now on. */
async function recordToasts(page) {
  await page.evaluate(() => {
    const el = document.getElementById('job-finish-toast');
    window.__e2eToasts = [];
    new MutationObserver(() => {
      const t = el.textContent || '';
      if (t && !el.hidden && window.__e2eToasts[window.__e2eToasts.length - 1] !== t) window.__e2eToasts.push(t);
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  });
}

/** What the page shows for the mesh, everywhere it shows a job. */
async function expectFailedShown(page, form, reason) {
  const status = form.locator('.mesh-finished');
  await expect(status).toHaveAttribute('data-mesh-status', 'failed', { timeout: 30_000 });
  await expect(status.locator('.mat-k')).toHaveText('Mesh failed');
  await expect(status.locator('.mesh-finished-line')).toHaveText(reason);
  const generate = form.locator('[data-mesh-generate="1"]');
  await expect(generate).toBeEnabled();
  await expect(generate).toHaveText('Generate');
  const row = page.locator(`#left-tree li[data-w20-mesh-item="${MESH}"] > .tree-row`);
  await expect(row).toBeAttached();
  await expect(row.locator('.tree-spin')).toHaveCount(0);
  await expect(row.locator('[data-mesh-failed="1"]')).toHaveText('Failed');
  // The viewport chip says nothing about meshing (hidden, or another job's words).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const chip = document.getElementById('viewport-job-chip');
        return !chip || chip.hidden || !/Meshing/.test(chip.textContent || '');
      }),
      { timeout: 15_000 },
    )
    .toBe(true);
  // The Queue runs nothing.
  await expect(page.locator('#btn-queue')).not.toHaveClass(/is-running/, { timeout: 15_000 });
  await expect(page.locator('#job-queue-now')).toBeHidden({ timeout: 15_000 });
}

test('a mesh that fails says why, and nothing shows it meshing after the end, even after a reload', async ({ page, request }) => {
  test.setTimeout(240_000);
  writeFileSync(hook, 'plc');
  // The job's event stream waits until the page has shown the end; then it replays the
  // whole job (its stages, then "failed"), as it does to a late or second connection.
  let releaseStream = () => {};
  const streamHeld = new Promise((resolve) => (releaseStream = resolve));
  let streams = 0;
  await page.route('**/api/jobs/*/events*', async (route) => {
    streams += 1;
    await streamHeld;
    await route.continue();
  });
  await openProject(page);
  const form = await openMeshPanel(page);
  await recordToasts(page);
  await form.locator('[data-mesh-generate="1"]').click();

  // The server records the failure, with the reason.
  const live = async () =>
    (await (await request.get(q('/api/mesh', { simulation_id: 'sim_1', mesh_id: MESH }))).json()).mesh?.live_mesh_result || {};
  await expect.poll(async () => (await live()).status, { timeout: 60_000, intervals: [500] }).toBe('failed');
  expect((await live()).error).toBe(PLC_REASON);
  // The page shows the end (its job poll), before the stream says anything.
  await expect(form.locator('.mesh-finished')).toHaveAttribute('data-mesh-status', 'failed', { timeout: 30_000 });
  expect(streams, 'the job stream was opened').toBeGreaterThan(0);

  // The stream arrives late, replaying the job: the end stays the end.
  releaseStream();
  await page.waitForTimeout(3_000);
  await expectFailedShown(page, form, PLC_REASON);
  await expect.poll(() => page.evaluate(() => window.__e2eToasts), { timeout: 15_000 }).toContainEqual(expect.stringMatching(/ failed to mesh\.$/));
  // Still so a while later (a revived job would show "Meshing" again and never end).
  await page.waitForTimeout(3_000);
  await expectFailedShown(page, form, PLC_REASON);

  await page.unroute('**/api/jobs/*/events*');
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
  await expectFailedShown(page, await openMeshPanel(page), PLC_REASON);
});

test('a mesher that stops with no result ends the mesh failed, and says so', async ({ page }) => {
  test.setTimeout(180_000);
  writeFileSync(hook, 'vanish');
  await openProject(page);
  const form = await openMeshPanel(page);
  const started = Date.now();
  await form.locator('[data-mesh-generate="1"]').click();
  await expectFailedShown(page, form, 'The mesher stopped without a result.');
  expect(Date.now() - started, 'ended within a bounded time').toBeLessThan(45_000);
});
