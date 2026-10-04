// Review round 3, the smaller findings, each as the user meets it in the real
// host frame with the real kernel (the blocker, Operation offered on a first
// feature, is in cad-p1-document.spec.js):
//   - a size field shows every stored digit while it is being edited, so an
//     edit never drops digits; a number written with commas is refused with a
//     reason, as the core's number fields refuse it ("1,500" is never guessed);
//   - Escape with nothing open lets go of the viewport selection;
//   - hiding a selected body takes it out of the selection;
//   - F2 and Delete on a face say what they do instead of doing nothing;
//   - the origin planes' Always and the camera are kept per Part (not undoable);
//   - a parameter in use says who uses it: "width can't be deleted: h and Extrude 1 use it".
// window.__CAD__ is used only to read the viewport's projection and camera, and
// (helpers.ts addSketch / addSolid) to set sketched solids up: there is no Box
// since decision 2026-10-01.
// Owner: INTEGRATE (review round 3).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSketch, addSolid, baseUrl, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

type Vec3 = [number, number, number];
type Loc = ReturnType<FrameLocator['locator']>;

async function freshPart(page: Page, request: Parameters<typeof newProject>[0], title = 'Part 1') {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, title);
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  return { seen, frame, row, projectId };
}

async function setField(panel: Loc, field: string, value: string) {
  const input = panel.locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel.locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}


const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${name}$`) }) });
const expectSaved = (frame: FrameLocator) => expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });

type Cam = { position: Vec3; target: Vec3; up: Vec3; orthoHeight: number; projection: string };
type Handle = {
  project(p: number[]): [number, number] | null;
  camera(): Cam;
  state: { get(): { animating: boolean; planes: string } };
};
type W = { __CAD__: { services: { viewport: { get(): { handle: unknown } } } } };

const handleOf = () => (window as unknown as W).__CAD__.services.viewport.get().handle as Handle;
const still = (page: Page) => workspaceFrame(page).evaluate(() => ((window as unknown as W).__CAD__.services.viewport.get().handle as Handle).state.get().animating ? 'moving' : 'still');
const planesMode = (page: Page) => workspaceFrame(page).evaluate(() => ((window as unknown as W).__CAD__.services.viewport.get().handle as Handle).state.get().planes);
const cameraOf = (page: Page) => workspaceFrame(page).evaluate(() => ((window as unknown as W).__CAD__.services.viewport.get().handle as Handle).camera());
void handleOf;

/** Model points projected to page pixels (the frame's offset added), once no view transition runs. */
async function onPage(page: Page, pts: Vec3[]): Promise<[number, number][]> {
  await expect.poll(() => still(page)).toBe('still');
  const xy = await workspaceFrame(page).evaluate((list) => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle as Handle;
    return list.map((p) => h.project(p));
  }, pts);
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return xy.map((p) => [box.x + p![0], box.y + p![1]]);
}

/** Two cubes, sketched and extruded: Extrude 1 (Body 1, 8000 mm³) at the origin, Extrude 2 (Body 2, 27,000 mm³) from x = 50. */
async function twoBoxes(page: Page, frame: FrameLocator) {
  await addSolid(page);
  await addSolid(page, { at: [50, 0, 0], size: [30, 30, 30] });
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeTotal of 2 bodies · 35,000 mm³');
  await frame.locator('[data-cad-toolbar] [data-command="view.fit"]').click();
}

/** Click Body 2's front face (y = 0) in the viewport: the face is selected, and the chip names its body. */
async function pickBody2Face(page: Page, frame: FrameLocator) {
  const [at] = await onPage(page, [[65, 0, 15]]);
  await page.mouse.click(at[0], at[1]);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeBody 2 · 27,000 mm³');
}

test('cad:p1-review3-precision a size field shows every stored digit while edited, so an edit keeps them; commas are refused with a reason', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 20 x 20 profile: its extrude's distance is the size field.
  await addSolid(page);
  const vol = frame.locator('[data-chip="volume"] [data-volume-mm3]');
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="extrude"] > .tree-row').dblclick();
  const panel = frame.locator('[data-cad-panel="feature"]');
  const len = panel.locator('.nui[data-field="distance"] input');
  await len.fill('12.3456789');
  await len.press('Enter');
  // Still in the field: every digit; out of it: the readout's 6 significant digits.
  await expect(len).toHaveValue('12.3456789');
  await expect.poll(async () => Number(await vol.getAttribute('data-volume-mm3'))).toBeCloseTo(12.3456789 * 400, 9);
  await len.press('Tab');
  await expect(len).toHaveValue('12.3457');
  // Back in the field: every digit again (it showed "12.3457", and an edit dropped the rest).
  await len.click();
  await expect(len).toHaveValue('12.3456789');
  await len.press('End');
  await len.type('1');
  await len.press('Enter');
  await expect(len).toHaveValue('12.34567891');
  await expect.poll(async () => Number(await vol.getAttribute('data-volume-mm3'))).toBeCloseTo(12.34567891 * 400, 9);
  // Focus and leave without typing: nothing is stored again (no undo step, the value as it was).
  await len.press('Tab');
  await len.click();
  await len.press('Tab');
  await expect.poll(async () => Number(await vol.getAttribute('data-volume-mm3'))).toBeCloseTo(12.34567891 * 400, 9);
  // Large values: grouped as a readout, plain while edited.
  await len.fill('1234567.891');
  await len.press('Enter');
  await expect(len).toHaveValue('1234567.891');
  await len.press('Tab');
  await expect(len).toHaveValue('1,234,570');
  await len.click();
  await expect(len).toHaveValue('1234567.891');
  // A comma in a number is refused with a reason, and nothing is applied (the core's number fields accept no commas).
  const before = await vol.getAttribute('data-volume-mm3');
  await len.fill('1,500');
  await len.press('Enter');
  await expect(panel.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveText('No commas in numbers: write 1500, or 1.5 for a decimal');
  expect(await vol.getAttribute('data-volume-mm3')).toBe(before);
  await len.press('Escape');
  await expect(panel.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveCount(0);
  await expect(len).toHaveValue('1234567.891');
  await setField(panel, 'distance', '1500');
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('Volume600,000 mm³');
  await panel.locator('[data-panel-done]').click();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review3-escape-selection Escape with nothing open lets go of the viewport selection', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await twoBoxes(page, frame);
  await pickBody2Face(page, frame);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeTotal of 2 bodies · 35,000 mm³');
  // A panel open: the first Escape closes the panel and keeps the selection, as before.
  await pickBody2Face(page, frame);
  await frame.locator('[data-cad-toolbar] [data-command="modify.parameters"]').click();
  await expect(frame.locator('[data-cad-panel="params"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-panel="params"]')).toHaveCount(0);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeBody 2 · 27,000 mm³');
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeTotal of 2 bodies · 35,000 mm³');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review3-hide-deselects hiding a selected body takes it, and its faces, out of the selection', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tree = frame.locator('[data-cad-tree]');
  await twoBoxes(page, frame);
  await tree.locator('[data-bodies-folder] > .tree-row').click();
  const body2 = tree.locator('[data-body-row]').nth(1);
  await expect(body2.locator('> .tree-row .tl')).toHaveText('Body 2');
  // Selected in the tree, then hidden with its eye.
  await body2.locator('> .tree-row').click();
  await expect(body2).toHaveClass(/selected/);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeBody 2 · 27,000 mm³');
  await body2.locator('[data-body-act="visibility"]').click();
  await expect(body2).not.toHaveClass(/selected/);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeTotal of 1 shown body · 8000 mm³');
  await body2.locator('[data-body-act="visibility"]').click();
  // A face selected in the viewport, then its body hidden from the viewport's own menu.
  await pickBody2Face(page, frame);
  const [at] = await onPage(page, [[65, 0, 15]]);
  await page.mouse.click(at[0], at[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="body-visibility"]').click();
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeTotal of 1 shown body · 8000 mm³');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review3-key-hints F2 and Delete on a face say what they do instead of doing nothing', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const toast = page.locator('#workspace-overlay [data-ws-toast]');
  await twoBoxes(page, frame);
  await pickBody2Face(page, frame);
  await page.keyboard.press('F2');
  await expect(toast).toHaveText(/Faces have no names\. F2 renames a feature or a body: select one in the tree\./);
  await expect(frame.locator('[data-cad-tree] input[aria-label="Feature name"]')).toHaveCount(0);
  // Delete on a face of a native feature (P2, plan §3.9): the frame asks what to delete,
  // focus on Cancel; Escape keeps everything (before P2 a toast said "delete Box 2 in the history").
  await page.keyboard.press('Delete');
  const dlg = frame.locator('[data-cad-dialog]');
  await expect(dlg.locator('h2')).toHaveText('Delete faces of Extrude 2?');
  await expect(dlg.locator('[data-dialog-choice]')).toHaveText(['Delete feature Extrude 2', 'Delete faces and heal', 'Cancel']);
  await expect(dlg.locator('[data-dialog-choice="cancel"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(frame.locator('[data-cad-tree] [data-feature-row]')).toHaveCount(4);
  // A feature selected: F2 renames it, as before.
  await featureRow(frame, 'Extrude 2').locator('> .tree-row').click();
  await page.keyboard.press('F2');
  await expect(frame.locator('[data-cad-tree] input[aria-label="Feature name"]')).toHaveValue('Extrude 2');
  await page.keyboard.press('Escape');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review3-view-kept the origin planes Always and the camera are kept per Part, and are not undo steps', async ({ page, request }) => {
  const { seen, frame, row, projectId } = await freshPart(page, request);
  // One edit: a sketch.
  await addSketch(page);
  await expectSaved(frame);
  const studyId = /\/ws\/cad\/part\/([^/?#]+)/.exec(decodeURIComponent(page.url()))![1];
  // Origin planes: Always, from the Views menu.
  await frame.locator('[data-vp-opens="views"]').click();
  await frame.locator('[data-vp-seg="Origin planes"] [data-value="always"]').click();
  await expect(frame.locator('[data-vp-seg="Origin planes"] [data-value="always"]')).toHaveAttribute('aria-checked', 'true');
  await frame.locator('[data-vp-opens="views"]').click();
  // Orbit with the mouse.
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  const cx = fb.x + fb.width * 0.6;
  const cy = fb.y + fb.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => still(page)).toBe('still');
  const cam = await cameraOf(page);
  // Kept with the Part, in its view file (not the model): planes and camera.
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  await expect
    .poll(async () => {
      const r = await request.post(`${baseUrl()}/api/plugin-data/read`, { data: { project_id: projectId, plugin: 'cad', rel: `studies/${studyId}/view.json` } });
      const v = (await r.json()).doc?.view;
      return v && v.planes === 'always' && v.camera && near(v.camera.position, cam.position) ? 'kept' : JSON.stringify(v);
    }, { timeout: 10_000 })
    .toBe('kept');
  // Neither is an undo step: Ctrl+Z undoes the sketch, and the planes stay Always.
  await page.keyboard.press('Control+z');
  await expect(frame.locator('[data-cad-tree] [data-tree-empty="history"]')).toHaveText('No features yet');
  expect(await planesMode(page)).toBe('always');
  await page.keyboard.press('Control+y');
  await expect(frame.locator('[data-cad-tree] [data-feature-row]')).toHaveCount(1);
  await expectSaved(frame);
  await expect.poll(() => still(page)).toBe('still');
  const cam2 = await cameraOf(page);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  // Reopened: Always, and the camera where it was left.
  const again = await openPart(page, row);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  await expect.poll(() => planesMode(page)).toBe('always');
  await again.locator('[data-vp-opens="views"]').click();
  await expect(again.locator('[data-vp-seg="Origin planes"] [data-value="always"]')).toHaveAttribute('aria-checked', 'true');
  await again.locator('[data-vp-opens="views"]').click();
  await expect
    .poll(async () => {
      const c = await cameraOf(page);
      return near(c.position, cam2.position) && near(c.target, cam2.target) && near(c.up, cam2.up) ? 'same' : JSON.stringify(c);
    })
    .toBe('same');
  // Another Part keeps its own: a new one starts with Auto.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  // The prompt offers "Part 2" (Part 1 is taken), and the new Part opens by itself.
  await newPartFromTree(page, 'Part 2', { offered: 'Part 2' });
  const other = await partOpened(page);
  await expect(other.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  await expect.poll(() => planesMode(page)).toBe('auto');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test("cad:p1-review3-param-in-use a parameter in use says who uses it: \"width can't be deleted: h and Extrude 1 use it\"", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  await tb.locator('[data-command="modify.parameters"]').click();
  const params = frame.locator('[data-cad-panel="params"]');
  const add = async (name: string, expr: string) => {
    await params.locator('[aria-label="New parameter name"]').fill(name);
    await params.locator('[aria-label="New parameter expression"]').fill(expr);
    await params.locator('[data-param-add-btn]').click();
    await expect(params.locator(`[data-param-row="${name}"]`)).toHaveCount(1);
  };
  await add('width', '40 mm');
  await add('h', 'width / 2');
  await params.locator('[data-panel-done]').click();
  // A sketch extruded "width".
  await addSketch(page);
  await tb.locator('[data-command="solid.extrude"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await setField(panel, 'distance', 'width');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await tb.locator('[data-command="modify.parameters"]').click();
  await params.locator('[data-param-row="width"] [data-param-delete]').click();
  await expect(params.locator('[data-param-error="width"]')).toHaveText("width can't be deleted: h and Extrude 1 use it");
  await expect(params.locator('[data-param-row="width"]')).toHaveCount(1);
  // One user: "uses".
  await params.locator('[data-param-row="h"] [data-param-delete]').click();
  await expect(params.locator('[data-param-row="h"]')).toHaveCount(0);
  await params.locator('[data-param-row="width"] [data-param-delete]').click();
  await expect(params.locator('[data-param-error="width"]')).toHaveText("width can't be deleted: Extrude 1 uses it");
  await params.locator('[data-panel-done]').click();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review3-not-saved a save the host refuses says why ("Not saved: the disk is full") with Retry, asks before leaving, and Retry saves', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page);
  await expectSaved(frame);
  // The host refuses every commit, the automatic retries' too, until the disk has room again
  // (`room`, set just before Retry is clicked): its own answer, HTTP 507 disk_full. Nothing
  // here depends on when an automatic retry comes (P1.5 review round 1: the first one landed
  // right after an earlier version stopped refusing, and the chip said Saved by itself).
  const commit = '**/api/plugin-files/uploads/*/commit*';
  let room = false;
  let refused = 0;
  await page.route(commit, async (route) => {
    if (room) return route.continue();
    refused++;
    await route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'there is not enough free disk space for this file', code: 'disk_full' }) });
  });
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').click({ button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="suppress"]').click();
  const chip = frame.locator('[data-chip="save"]');
  await expect(chip).toHaveAttribute('data-state', 'error');
  await expect(chip.locator('.cad-chip-v')).toHaveText('Not saved: the disk is full');
  await expect(chip.locator('[data-chip-action="Retry"]')).toHaveText('Retry');
  // Still not saved: leaving asks, with the reason. The exit hook tries the save once more and it
  // is refused too; this Part was never linked and has no body to link (Extrude 1 suppressed), so
  // nothing would go to the project anyway: it is the app's own "Leave without saving?", not
  // "Couldn't update the project" (L3 review polish 1). Stay keeps the Part.
  const beforeLeave = refused;
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#cf-heading')).toHaveText('Leave without saving?', { timeout: 60_000 });
  await expect(page.locator('#cf-copy')).toHaveText('Magnusim CAD: Changes to Part 1 are not saved: the disk is full. Leaving discards them.');
  await expect(page.locator('#cf-confirm')).toHaveText('Leave');
  await expect(page.locator('#cf-cancel')).toHaveText('Stay');
  await page.locator('#cf-cancel').click();
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  // The page retried by itself (3 s, then 10 s, 30 s, a minute) and on the way out: more refusals
  // came, and the chip still says why, with Retry.
  expect(refused).toBeGreaterThan(beforeLeave);
  expect(refused).toBeGreaterThanOrEqual(2);
  await expect(chip).toHaveAttribute('data-state', 'error');
  await expect(chip.locator('.cad-chip-v')).toHaveText('Not saved: the disk is full');
  await expect(chip.locator('[data-chip-action="Retry"]')).toHaveText('Retry');
  // The disk has room again. Retry writes now: the next automatic try is at least 10 s away
  // (two refusals or more), so only Retry can make it Saved within 2.5 s.
  room = true;
  await chip.locator('[data-chip-action="Retry"]').click();
  await expect(chip).toHaveText('Saved', { timeout: 2500 });
  await page.unroute(commit);
  expect(seen.csp, 'CSP violations').toEqual([]);
  // The browser logs the host's refusal (the 507 this test answered) as a failed load; nothing else.
  expect(seen.errors.filter((e) => !/status of 507 .*\/api\/plugin-files\/uploads\/[^/]+\/commit/.test(e)), 'console errors').toEqual([]);
});
