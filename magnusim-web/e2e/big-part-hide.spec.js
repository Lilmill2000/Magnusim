import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON } from '../scripts/python-env.js';

// Hiding a face of a big part (Daniel, 2026-10): on a part with 6,500 faces and 23,000
// edges, a right-click on a face, Hide face, froze the page for 45 s to over a minute
// (it looked like a crash). Each edge's faces were worked out with a pass over every
// triangle, twice per edge, and a search that made arrays per triangle. The part here:
// a bar with 1,000 square teeth along each side (8,006 faces, 24,012 edges), built at
// test time by python/tools/gen_many_faces_part.py (a 2.6 MB file). Before the fix the
// hide held the page for 10 s and more on it; now about a tenth of a second.
const HERE = dirname(fileURLToPath(import.meta.url));
const PY_DIR = join(HERE, '..', 'python');
const stamp = () => Date.now().toString(36);


/** The part's file, written for this test. */
function buildPart(out) {
  // The app's own interpreter: MAGNUSIM_PYTHON, python/.venv, else python3/python on PATH (CI).
  const r = spawnSync(PYTHON, ['tools/gen_many_faces_part.py', out, '--teeth', '1000'], {
    cwd: PY_DIR,
    encoding: 'utf8',
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`gen_many_faces_part.py failed: ${r.stderr || r.error}`);
  return out;
}

async function openProject(page, title, file) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    title,
  );
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(file);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 180_000 });
  return pid;
}

/** The camera close over the top of tooth 500 (its face 2 x 20 mm fills the middle of the view). */
async function lookAtTooth(page) {
  await page.evaluate(() => {
    const { renderer, renderWindow } = window.__CFD_VIEW__;
    const cam = renderer.getActiveCamera();
    cam.setFocalPoint(2002, 10, 20);
    cam.setPosition(2002, 10, 60);
    cam.setViewUp(0, 1, 0);
    renderer.resetCameraClippingRange();
    renderWindow.render();
  });
}

/** The middle of the viewer, and the face under it. */
async function middleFace(page) {
  return page.evaluate(() => {
    const r = document.querySelector('#viewer canvas').getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = window.__CFD_PICK_CAD__({ clientX: x, clientY: y });
    return { x, y, faceId: hit && hit.faceId ? hit.faceId : 0 };
  });
}

/** How long the page's own handlers held the main thread for each right-click and click. */
async function timeHandlers(page) {
  await page.evaluate(() => {
    window.__bigPartTimes = [];
    for (const type of ['contextmenu', 'click']) {
      let t0 = 0;
      window.addEventListener(type, () => { t0 = performance.now(); }, true);
      window.addEventListener(type, () => { window.__bigPartTimes.push({ type, ms: performance.now() - t0 }); });
    }
  });
}
const lastTime = (page, type) =>
  page.evaluate((t) => window.__bigPartTimes.filter((x) => x.type === t).pop()?.ms ?? -1, type);
/** A frame drawn: the page answers again. */
const nextFrame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));

test('a face of a part with thousands of faces hides and shows quickly; the page never freezes', async ({ page }) => {
  test.setTimeout(300_000);
  const file = buildPart(test.info().outputPath('toothed-bar.brep'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await openProject(page, `e2e big part hide ${stamp()}`, file);
  // The part drawn, then the camera over one tooth.
  await expect.poll(async () => (await middleFace(page)).faceId, { timeout: 60_000, intervals: [500] }).toBeGreaterThan(0);
  await lookAtTooth(page);
  let at = null;
  await expect
    .poll(async () => {
      at = await middleFace(page);
      return at.faceId;
    }, { timeout: 30_000, intervals: [250] })
    .toBeGreaterThan(0);
  await timeHandlers(page);

  // Right-click the tooth's top: its face's menu.
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.locator('#face-ctx-menu')).toBeVisible();
  const hide = page.locator('#face-ctx-hide');
  await expect(hide).toHaveText(`Hide face ${at.faceId}@Body1`);
  expect(await lastTime(page, 'contextmenu')).toBeLessThan(1500);
  await page.screenshot({ path: test.info().outputPath('1-menu.png') });

  // Hide face: done in a moment, and the page draws its next frame straight after.
  const t0 = Date.now();
  await hide.click();
  await expect(page.locator('#hidden-faces-chip-txt')).toHaveText('1 face hidden', { timeout: 120_000 });
  await nextFrame(page);
  const wall = Date.now() - t0;
  const held = await lastTime(page, 'click');
  console.log(`hide: page held ${Math.round(held)} ms, ${wall} ms to the next frame`);
  // About 0.1 s here; it was 10 s and more before the fix.
  expect(held).toBeLessThan(2500);
  expect(wall).toBeLessThan(6000);
  await expect(page.locator('#face-ctx-menu')).toBeHidden();
  // The face is gone from the view: a click there no longer lands on it.
  const after = await middleFace(page);
  expect(after.faceId).not.toBe(at.faceId);
  await page.screenshot({ path: test.info().outputPath('2-hidden.png') });

  // A second face (the tooth's side, now in view through the gap) hides as quickly.
  if (after.faceId) {
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await expect(page.locator('#face-ctx-hide')).toHaveText(`Hide face ${after.faceId}@Body1`);
    await page.locator('#face-ctx-hide').click();
    await expect(page.locator('#hidden-faces-chip-txt')).toHaveText('2 faces hidden');
    expect(await lastTime(page, 'click')).toBeLessThan(2500);
  }

  // Show all: everything back, as quickly.
  await page.locator('#hidden-faces-show').click();
  await expect(page.locator('#hidden-faces-chip')).toBeHidden();
  expect(await lastTime(page, 'click')).toBeLessThan(2500);
  await expect.poll(async () => (await middleFace(page)).faceId).toBe(at.faceId);
});
