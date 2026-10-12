import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL } from './toolchain.js';

// Hiding bodies in the view (Daniel, 2026-10): in a study on a part with several bodies,
// a right-click on a body in the viewport hides it, a right-click on its row in the tree
// hides or shows it, several bodies (Ctrl-click) hide at once, and a hidden body's row is
// lighter grey. A view state only: nothing saved changes, and a reload shows every body.
// The part: two boxes that share a face (box 1 is x 0..10 mm, box 2 is x 10..30 mm).
const HERE = dirname(fileURLToPath(import.meta.url));
const TWO = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'two-boxes-shared-face.brep');
const ONE = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'elbow.step');
const stamp = () => Date.now().toString(36);
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';

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
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 120_000 });
  return pid;
}

/** An Incompressible Flow study on the shown geometry. */
async function createStudy(page) {
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  return page.evaluate(() => window.__CFD_W17__.activeId);
}

const bodies = (page) => page.evaluate(() => window.__CFD_VIEWPORT_BODIES__());

/**
 * A point of the viewer on a face of this body, clear of the face's edges (the same face
 * 10 px all round: a click within 7 px of an edge picks the edge). null when none shows.
 */
function bodyPoint(page, body) {
  return page.evaluate((want) => {
    const canvas = document.querySelector('#viewer canvas');
    const r = canvas.getBoundingClientRect();
    const faceAt = (x, y) => {
      const top = document.elementFromPoint(x, y);
      if (!top || !top.closest('#viewer')) return '';
      const hit = window.__CFD_PICK_CAD__({ clientX: x, clientY: y });
      return hit && hit.faceId ? `${hit.solidId || 1}:${hit.faceId}` : '';
    };
    const ring = [[10, 0], [-10, 0], [0, 10], [0, -10], [7, 7], [7, -7], [-7, 7], [-7, -7]];
    for (let fy = 0.25; fy <= 0.75; fy += 0.03) {
      for (let fx = 0.2; fx <= 0.8; fx += 0.03) {
        const x = Math.round(r.left + r.width * fx);
        const y = Math.round(r.top + r.height * fy);
        const key = faceAt(x, y);
        if (!key || Number(key.split(':')[0]) !== want) continue;
        if (ring.some(([dx, dy]) => faceAt(x + dx, y + dy) !== key)) continue;
        return { x, y, key };
      }
    }
    return null;
  }, body);
}

async function findBody(page, body) {
  let at = null;
  await expect
    .poll(async () => {
      at = await bodyPoint(page, body);
      return !!at;
    }, { timeout: 30_000, intervals: [250] })
    .toBe(true);
  return at;
}

const bodyRow = (page, i) => page.locator(`#simulations-tree [data-w16-body="1"][data-body-index="${i}"]`).first();
const treeMenu = (page) => page.locator('[data-geom-menu]');

test('bodies hide and show from the viewport and the tree, in a study; a hidden body is grey in the tree', async ({ page }) => {
  test.setTimeout(240_000);
  const pid = await openProject(page, `e2e body hide ${stamp()}`, TWO);
  await createStudy(page);
  await expect.poll(async () => (await bodies(page)).drawn, { timeout: 60_000 }).toEqual([1, 2]);
  await expect(bodyRow(page, 2)).toBeVisible();
  const name2 = ((await bodyRow(page, 2).locator(':scope > .tree-row .tl').textContent()) || '').trim();
  expect(name2).toContain('Body2');

  // The viewport: right-click on box 2, Hide <its tree name>.
  const on2 = await findBody(page, 2);
  await page.mouse.click(on2.x, on2.y, { button: 'right' });
  const menu = page.locator('#face-ctx-menu');
  await expect(menu).toBeVisible();
  const hideBody = page.locator('#face-ctx-hide-body');
  await expect(hideBody).toBeVisible();
  await expect(hideBody).toHaveText(`Hide ${name2}`);
  // The face item names the face's own body (it said @Body1 for every face before).
  await expect(page.locator('#face-ctx-hide')).toHaveText(/^Hide face \d+@Body2$/);
  await expect(page.locator('#face-ctx-show-bodies')).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('1-viewport-menu.png') });
  await hideBody.click();
  await expect(menu).toBeHidden();
  await expect.poll(() => bodies(page)).toEqual({ geometryId: expect.any(String), hidden: [2], drawn: [1] });
  // Its row is lighter grey and says why; the other row is not.
  await expect(bodyRow(page, 2)).toHaveClass(/is-hidden-body/);
  await expect(bodyRow(page, 2)).toHaveAttribute('title', 'Hidden in the view');
  await expect(bodyRow(page, 1)).not.toHaveClass(/is-hidden-body/);
  const grey = await bodyRow(page, 2).locator(':scope > .tree-row .tl').evaluate((el) => getComputedStyle(el).color);
  const dark = await bodyRow(page, 1).locator(':scope > .tree-row .tl').evaluate((el) => getComputedStyle(el).color);
  expect(grey).not.toBe(dark);
  // The chip says what is hidden.
  await expect(page.locator('#hidden-faces-chip-txt')).toHaveText('1 body hidden');
  // A click where box 2 was no longer lands on it.
  const through = await page.evaluate(([x, y]) => window.__CFD_PICK_CAD__({ clientX: x, clientY: y }), [on2.x, on2.y]);
  expect(through && through.solidId === 2).toBeFalsy();
  expect(await bodyPoint(page, 2)).toBeNull();
  await page.screenshot({ path: test.info().outputPath('2-body2-hidden.png') });

  // The tree: right-click its row, Show body.
  await bodyRow(page, 2).locator(':scope > .tree-row').click({ button: 'right' });
  await expect(treeMenu(page).locator('[data-body-act="show"]')).toHaveText('Show body');
  await treeMenu(page).locator('[data-body-act="show"]').click();
  await expect.poll(async () => (await bodies(page)).drawn).toEqual([1, 2]);
  expect((await bodies(page)).hidden).toEqual([]);
  await expect(bodyRow(page, 2)).not.toHaveClass(/is-hidden-body/);
  await expect(page.locator('#hidden-faces-chip')).toBeHidden();

  // The tree, both rows (Ctrl-click): Hide 2 bodies; both grey.
  await bodyRow(page, 1).locator(':scope > .tree-row .tl').click();
  await bodyRow(page, 2).locator(':scope > .tree-row .tl').click({ modifiers: ['Control'] });
  await expect(bodyRow(page, 1)).toHaveClass(/\bselected\b/);
  await expect(bodyRow(page, 2)).toHaveClass(/\bselected\b/);
  await bodyRow(page, 2).locator(':scope > .tree-row').click({ button: 'right' });
  await expect(treeMenu(page).locator('[data-body-act="hide"]')).toHaveText('Hide 2 bodies');
  await page.screenshot({ path: test.info().outputPath('3-tree-menu-two.png') });
  await treeMenu(page).locator('[data-body-act="hide"]').click();
  await expect.poll(async () => (await bodies(page)).hidden).toEqual([1, 2]);
  expect((await bodies(page)).drawn).toEqual([]);
  await expect(bodyRow(page, 1)).toHaveClass(/is-hidden-body/);
  await expect(bodyRow(page, 2)).toHaveClass(/is-hidden-body/);
  // Clicking a hidden body's row still selects it.
  await bodyRow(page, 1).locator(':scope > .tree-row .tl').click();
  await expect(bodyRow(page, 1)).toHaveClass(/\bselected\b/);
  await expect(bodyRow(page, 1)).toHaveClass(/is-hidden-body/);
  await page.screenshot({ path: test.info().outputPath('4-both-hidden.png') });

  // The viewport (nothing left under the click): Show all bodies.
  const box = await page.locator('#viewer canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('#face-ctx-hide-body')).toBeHidden();
  await expect(page.locator('#face-ctx-show-bodies')).toBeVisible();
  await page.locator('#face-ctx-show-bodies').click();
  await expect.poll(async () => (await bodies(page)).drawn).toEqual([1, 2]);
  await expect(bodyRow(page, 1)).not.toHaveClass(/is-hidden-body/);
  await expect(bodyRow(page, 2)).not.toHaveClass(/is-hidden-body/);

  // The viewport, a face of each box picked (Ctrl-click), right-click one: Hide 2 bodies.
  await page.keyboard.press('Escape');
  const a = await findBody(page, 1);
  const b = await findBody(page, 2);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Control');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => window.__CFD_VIEWPORT_FACES__().selected.length)).toBe(2);
  await page.mouse.click(b.x, b.y, { button: 'right' });
  await expect(page.locator('#face-ctx-hide-body')).toHaveText('Hide 2 bodies');
  await page.locator('#face-ctx-hide-body').click();
  await expect.poll(async () => (await bodies(page)).hidden).toEqual([1, 2]);
  // Their faces left the picks.
  expect(await page.evaluate(() => window.__CFD_VIEWPORT_FACES__().selected)).toEqual([]);
  await expect(page.locator('#hidden-faces-chip-txt')).toHaveText('2 bodies hidden');
  // The chip's Show all brings them back.
  await page.locator('#hidden-faces-show').click();
  await expect.poll(async () => (await bodies(page)).drawn).toEqual([1, 2]);

  // Hide face on a face of box 2 hides that face (its label named Body1 before, so nothing hid).
  const face2 = await findBody(page, 2);
  await page.mouse.click(face2.x, face2.y, { button: 'right' });
  await page.locator('#face-ctx-hide').click();
  await expect(page.locator('#hidden-faces-chip-txt')).toHaveText('1 face hidden');
  const faceId = Number(face2.key.split(':')[1]);
  expect(await page.evaluate(() => window.__CFD_VIEWPORT_FACES__().hidden)).toEqual([`face ${faceId}@Body2`]);
  const under = await page.evaluate(([x, y]) => window.__CFD_PICK_CAD__({ clientX: x, clientY: y }), [face2.x, face2.y]);
  expect(under && under.faceId).not.toBe(faceId);
  await page.locator('#hidden-faces-show').click();
  await expect(page.locator('#hidden-faces-chip')).toBeHidden();

  // A view state only: a reload shows every body again.
  const again = await findBody(page, 2);
  await page.mouse.click(again.x, again.y, { button: 'right' });
  await page.locator('#face-ctx-hide-body').click();
  await expect.poll(async () => (await bodies(page)).hidden).toEqual([2]);
  await page.reload();
  await page.waitForFunction((p) => window.__CFD_PROJECT_READY__ === p, pid, { timeout: 60_000 });
  await expect.poll(async () => (await bodies(page)).drawn, { timeout: 60_000 }).toEqual([1, 2]);
  expect((await bodies(page)).hidden).toEqual([]);
  await expect(bodyRow(page, 2)).not.toHaveClass(/is-hidden-body/);
});

test('a part with one body offers no Hide body', async ({ page }) => {
  test.setTimeout(180_000);
  await openProject(page, `e2e body hide one ${stamp()}`, ONE);
  await createStudy(page);
  await expect.poll(async () => (await bodies(page)).drawn, { timeout: 60_000 }).toEqual([1]);
  const at = await findBody(page, 1);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.locator('#face-ctx-menu')).toBeVisible();
  await expect(page.locator('#face-ctx-hide')).toBeVisible();
  await expect(page.locator('#face-ctx-hide-body')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await bodyRow(page, 1).locator(':scope > .tree-row').click({ button: 'right' });
  await expect(page.locator('[data-body-act]')).toHaveCount(0);
});

/** The x range of the mesh the viewport draws (the largest drawn surface with no CAD face ids). */
function meshXRange(page) {
  return page.evaluate(() => {
    const view = window.__CFD_VIEW__;
    let pd = null;
    for (const a of view.renderer.getActors()) {
      const m = a.getMapper && a.getMapper();
      const d = m && m.getInputData && m.getInputData();
      const cd = d && d.getCellData && d.getCellData();
      if (!cd || !a.getVisibility() || !d.getPolys || !d.getPolys().getNumberOfCells()) continue;
      if (cd.getArrayByName('faceId')) continue;
      if (!pd || d.getNumberOfCells() > pd.getNumberOfCells()) pd = d;
    }
    if (!pd) return null;
    const pts = pd.getPoints().getData();
    const conn = pd.getPolys().getData();
    let xmin = Infinity;
    let xmax = -Infinity;
    for (let i = 0; i < conn.length; i += conn[i] + 1) {
      for (let k = 1; k <= conn[i]; k++) {
        const x = pts[3 * conn[i + k]];
        xmin = Math.min(xmin, x);
        xmax = Math.max(xmax, x);
      }
    }
    return { cells: pd.getNumberOfCells(), xmin, xmax };
  });
}

test('a hidden body leaves the mesh view too', async ({ page }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(900_000);
  await openProject(page, `e2e body hide mesh ${stamp()}`, TWO);
  const sid = await createStudy(page);
  // A quick mesh: fineness 1, no boundary layers.
  const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  if ((await study.locator('.tw').textContent())?.trim() === '+') await study.locator('.tw').click();
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  const mid = await page.evaluate(() => window.__CFD_W20__.active_id);
  await form.locator('[data-schema-key="fineness"] input').fill('1');
  await form.locator('[data-schema-key="fineness"] input').press('Tab');
  const layers = form.locator('button[aria-label="Automatic boundary layers"]');
  if ((await layers.count()) && (await layers.getAttribute('aria-pressed')) === 'true') await layers.click();
  await form.locator('[data-mesh-generate="1"]').click();
  const status = page.locator('#panel-mesh-form [data-mesh-status]');
  await expect(status).toHaveAttribute('data-mesh-status', 'ready', { timeout: 840_000 });
  if (!(await page.evaluate(() => window.__CFD_MESH_INSPECT__ === true))) {
    await page.locator(`#left-tree [data-w20-mesh-item="${mid}"] > .tree-row .tl`).first().click();
  }
  await expect.poll(() => page.evaluate(() => window.__CFD_MESH_INSPECT__ === true), { timeout: 60_000 }).toBe(true);
  let full = null;
  await expect
    .poll(async () => {
      full = await meshXRange(page);
      return !!full && full.cells > 0;
    }, { timeout: 120_000 })
    .toBe(true);
  // Box 1 is x 0..10 mm, box 2 x 10..30 mm (the mesh is in metres or mm).
  const length = full.xmax - full.xmin;
  // Hide box 2 from its tree row: the mesh drawn ends where box 1 does.
  await bodyRow(page, 2).locator(':scope > .tree-row').click({ button: 'right' });
  await treeMenu(page).locator('[data-body-act="hide"]').click();
  await expect(bodyRow(page, 2)).toHaveClass(/is-hidden-body/);
  await expect
    .poll(async () => {
      const r = await meshXRange(page);
      return r ? Math.abs(r.xmax - (full.xmin + length / 3)) < 0.05 * length && r.cells < full.cells : false;
    }, { timeout: 30_000 })
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath('mesh-body2-hidden.png') });
  // Show it again: the whole mesh.
  await bodyRow(page, 2).locator(':scope > .tree-row').click({ button: 'right' });
  await treeMenu(page).locator('[data-body-act="show"]').click();
  await expect.poll(async () => (await meshXRange(page))?.cells, { timeout: 30_000 }).toBe(full.cells);
});
