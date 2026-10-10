// ux010 (TOOLBAR builder): the taped banana in a sketch. Daniel 2026-10-09: "add something similar
// to that but to the sketch section and use this image ... a banana duct taped to a wall, so
// someone can add this to their sketch to see the scale". On a 40 x 30 rectangle sketch:
//   - sketch mode's SCALE MODELS (after its VIEW) shows the picture to +u of the rectangle, at its
//     true size (137.7 x 181.0 mm) on screen, and the button is pressed;
//   - it lies behind the rectangle's lines; a press on it drags it with the pointer;
//   - Finish and edit the sketch again: it is where it was left;
//   - the sketch's DOF, its region and the Extrude of it do not change;
//   - the button again removes it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSketch, modelOnPage, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type Request = Parameters<typeof newProject>[0];
type Vec3 = [number, number, number];
const SHOTS = process.env.CAD_UX010_SHOTS ?? '';
const W = 137.7;
const H = 181.0;

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const button = (frame: FrameLocator) => tb(frame).locator('.tb-btn[data-command="scale.sketch-banana"]');
const layer = (frame: FrameLocator) => frame.locator('[data-layer="scale-sketch-banana"]');

type SketchWin = { __CAD__: { services: { apis: { get(): { sketch: { edit(id: string): void; finish(): Promise<void>; idle(): Promise<void>; state: { get(): { feature: string | null } } } } }; doc: { state: { get(): { rebuild: { status: string; outputs: Record<string, { regions?: unknown[] }> } } } } } } };

async function freshPart(page: Page, request: Request) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

async function editSketch(page: Page, frame: FrameLocator, id: string) {
  await workspaceFrame(page).evaluate((s) => (window as unknown as SketchWin).__CAD__.services.apis.get().sketch.edit(s), id);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
}
async function idle(page: Page) {
  await workspaceFrame(page).evaluate(() => (window as unknown as SketchWin).__CAD__.services.apis.get().sketch.idle());
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } | null } } } } }).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
}
const regions = (page: Page, id: string) => workspaceFrame(page).evaluate((s) => (window as unknown as SketchWin).__CAD__.services.doc.state.get().rebuild.outputs[s]?.regions?.length ?? 0, id);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

async function pixels(page: Page, pts: [number, number][]): Promise<[number, number, number][]> {
  const img = PNG.decode(await page.screenshot());
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  return pts.map((p) => {
    const px = PNG.at(img, Math.round(p[0] * dpr), Math.round(p[1] * dpr));
    return [px[0], px[1], px[2]];
  });
}

test('cad:ux010-sketch-banana the taped banana beside a 40 x 30 rectangle at true size, behind its lines, dragged, kept through Finish and edit, never part of the sketch; removed by the button', async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { seen, frame } = await freshPart(page, request);
  const sketch = await addSketch(page, { size: [40, 30] });
  await editSketch(page, frame, sketch);
  const chip = await frame.locator('[data-chip="sketch"]').textContent();
  expect(await regions(page, sketch)).toBe(1);

  // SKETCH mode's SCALE MODELS, after its VIEW.
  const groups = await tb(frame).locator(':scope > .tb-group').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')));
  expect(groups.slice(-3)).toEqual(['view', 'scale', 'edit']);
  await expect(button(frame)).toHaveAttribute('aria-label', 'Banana for scale');
  await expect(button(frame)).not.toHaveAttribute('aria-pressed', 'true');

  // Shown to +u of the rectangle (10 mm gap), centred on it in v, pressed.
  await button(frame).click();
  await expect(layer(frame)).toHaveAttribute('data-sketch-banana', 'shown');
  await expect(button(frame)).toHaveAttribute('aria-pressed', 'true');
  const at = (await layer(frame).getAttribute('data-sketch-banana-at'))!.split(' ').map(Number);
  // A clear gap: max(20 mm, 15 % of the sketch's size) right of its points AND its dimension labels.
  expect(at[0] - W / 2).toBeGreaterThanOrEqual(60 - 1e-6);
  // Centred in v on the sketch and its labels (the "40 mm" label below the rectangle counts).
  expect(at[1]).toBeGreaterThan(5);
  expect(at[1]).toBeLessThan(25);

  // At the zoom it was placed at, the "30 mm" label's right edge is at least 20 mm left of it.
  {
    const cs = JSON.parse((await layer(frame).getAttribute('data-sketch-banana-corners'))!) as Vec3[];
    const left = (await modelOnPage(page, cs[0]))[0];
    const k = dist(await modelOnPage(page, [0, 0, 0]), await modelOnPage(page, [40, 0, 0])) / 40;
    const labelRights = await frame.locator('.cad-sk-dim').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    const frameBox = (await page.locator('#workspace-frame').boundingBox())!;
    expect(left - (frameBox.x + Math.max(...labelRights)), 'the gap between the labels and the picture (px)').toBeGreaterThanOrEqual(20 * k * 0.98);
  }
  // Fit (it frames the picture too), then its size on screen: true size at this zoom (2 %).
  await tb(frame).locator('[data-command="view.fit"]').click();
  await idle(page);
  const corners = JSON.parse((await layer(frame).getAttribute('data-sketch-banana-corners'))!) as Vec3[];
  const c = await Promise.all(corners.map((p) => modelOnPage(page, p)));
  const o = await modelOnPage(page, [0, 0, 0]);
  const x40 = await modelOnPage(page, [40, 0, 0]);
  const pxPerMm = dist(o, x40) / 40;
  expect(Math.abs(dist(c[0], c[1]) / pxPerMm / W - 1), `width on screen ${dist(c[0], c[1]) / pxPerMm} mm`).toBeLessThan(0.02);
  expect(Math.abs(dist(c[1], c[2]) / pxPerMm / H - 1), `height on screen ${dist(c[1], c[2]) / pxPerMm} mm`).toBeLessThan(0.02);
  // Upright: +v (the picture's top) is up the screen.
  expect(c[3][1]).toBeLessThan(c[0][1]);
  // Drawn: the grip (an opaque pixel of it) is not the empty view's colour.
  const grip = JSON.parse((await layer(frame).getAttribute('data-sketch-banana-grip'))!) as Vec3;
  const gp = await modelOnPage(page, grip);
  const far = await modelOnPage(page, [-60, -60, 0]);
  const [onPic, bg] = await pixels(page, [gp, far]);
  expect(Math.abs(onPic[0] - bg[0]) + Math.abs(onPic[1] - bg[1]) + Math.abs(onPic[2] - bg[2]), `picture ${onPic} vs view ${bg}`).toBeGreaterThan(60);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sketch-banana.png` });

  // A drawing tool ignores the picture: a click-drag on it with Line draws a line there, the
  // picture stays put (the coordinator's decision: draw or trace over it; Select moves it).
  const entities = () => workspaceFrame(page).evaluate(() => ((window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { draft(): { entities: unknown[] } } } } } } }).__CAD__.services.apis.get().sketch.draft().entities.length));
  const before = await entities();
  await tb(frame).locator('[data-command="sketch.line"]').click();
  await page.mouse.move(gp[0], gp[1]);
  await page.mouse.down();
  await page.mouse.move(gp[0] + 40, gp[1] + 10, { steps: 12 });
  await page.mouse.up();
  await idle(page);
  expect(await entities()).toBe(before + 1);
  await expect(layer(frame)).not.toHaveAttribute('data-sketch-banana-dragging', '1');
  expect((await layer(frame).getAttribute('data-sketch-banana-at'))!.split(' ').map(Number)).toEqual(at);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await idle(page);
  await expect.poll(entities).toBe(before);

  // Select: drag it away (on a leash round the sketch, 300 mm here), then right-click on it: Place
  // next to sketch puts it back beside the sketch.
  await page.mouse.move(gp[0], gp[1]);
  await page.mouse.down();
  await page.mouse.move(gp[0] + 80, gp[1] + 60, { steps: 8 });
  await page.mouse.up();
  expect(Number(await layer(frame).getAttribute('data-sketch-banana-leash'))).toBe(300);
  expect((await layer(frame).getAttribute('data-sketch-banana-at'))!.split(' ').map(Number)).not.toEqual(at);
  await page.mouse.click(gp[0] + 80, gp[1] + 60, { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="sketch-banana-place"]').click();
  // Beside the sketch again (its labels measured at this zoom, so not always the very same spot).
  await expect.poll(async () => (await layer(frame).getAttribute('data-sketch-banana-at'))!.split(' ').map(Number)[0] - W / 2).toBeGreaterThanOrEqual(60 - 1e-6);
  const placed = (await layer(frame).getAttribute('data-sketch-banana-at'))!.split(' ').map(Number);
  expect(placed[0] - W / 2).toBeLessThan(120);
  // Back where the rest of the test expects it (the drag below starts from its grip there).
  if (placed[0] !== at[0] || placed[1] !== at[1]) {
    const g = await modelOnPage(page, JSON.parse((await layer(frame).getAttribute('data-sketch-banana-grip'))!) as Vec3);
    await page.mouse.move(g[0], g[1]);
    await page.mouse.down();
    await page.mouse.move(gp[0], gp[1], { steps: 8 });
    await page.mouse.up();
  }

  // Behind the lines: the line's own pixel before the picture comes under it.
  const edge = await modelOnPage(page, [40, 15, 0]);
  // The line's core: the darkest pixel across it (it is anti-aliased into what lies under it).
  const across = (p: [number, number]): [number, number][] => [-2, -1, 0, 1, 2].map((dx) => [p[0] + dx, p[1]]);
  const darkest = (px: [number, number, number][]) => Math.min(...px.map((c) => c[0] + c[1] + c[2]));
  const lineBefore = darkest(await pixels(page, across(edge)));

  // Drag by its grip onto the rectangle's right edge: it follows the pointer.
  await page.mouse.move(gp[0], gp[1]);
  await page.mouse.down();
  await expect(layer(frame)).toHaveAttribute('data-sketch-banana-dragging', '1');
  await page.mouse.move(edge[0], edge[1], { steps: 12 });
  await page.mouse.up();
  await expect(layer(frame)).not.toHaveAttribute('data-sketch-banana-dragging', '1');
  const grip2 = JSON.parse((await layer(frame).getAttribute('data-sketch-banana-grip'))!) as Vec3;
  expect(Math.hypot(grip2[0] - 40, grip2[1] - 15), `the grip ${grip2} under the pointer at (40, 15)`).toBeLessThan(0.6);
  const g2 = await modelOnPage(page, grip2);
  expect(dist(g2, edge)).toBeLessThan(2);
  const moved = (await layer(frame).getAttribute('data-sketch-banana-at'))!.split(' ').map(Number);
  // The line is drawn over it; the picture shows just beside the line.
  const beside = await modelOnPage(page, [grip2[0] + 4 / pxPerMm + 0.5, grip2[1], 0]);
  const lineAfter = darkest(await pixels(page, across(edge)));
  const [besideAfter] = await pixels(page, [beside]);
  // Still the line's own dark core (a covered line would show the tape there instead).
  expect(Math.abs(lineAfter - lineBefore), `the line's core ${lineBefore} -> ${lineAfter} (the picture beside it ${besideAfter})`).toBeLessThan(45);
  expect(besideAfter[0] + besideAfter[1] + besideAfter[2] - lineAfter, 'the line is darker than the picture beside it').toBeGreaterThan(60);
  expect(Math.abs(besideAfter[0] - bg[0]) + Math.abs(besideAfter[1] - bg[1]) + Math.abs(besideAfter[2] - bg[2]), `beside the line ${besideAfter}`).toBeGreaterThan(30);
  // Never part of the sketch: the same DOF and the one region.
  await idle(page);
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText(chip ?? '');
  expect(await regions(page, sketch)).toBe(1);

  // Finish, edit again: where it was left.
  await tb(frame).locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await expect(layer(frame)).toHaveCount(0);
  await editSketch(page, frame, sketch);
  await expect(layer(frame)).toHaveAttribute('data-sketch-banana', 'shown');
  expect((await layer(frame).getAttribute('data-sketch-banana-at'))!.split(' ').map(Number)).toEqual(moved);
  await expect(button(frame)).toHaveAttribute('aria-pressed', 'true');
  await tb(frame).locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();

  // The Extrude of the sketch: its region alone (40 x 30 x 10 = 12,000 mm³).
  await workspaceFrame(page).evaluate((s) => {
    const doc = (window as unknown as { __CAD__: { services: { doc: { beginNew(t: string, i: unknown): { commit(): void }; state: { get(): { rebuild: { outputs: Record<string, { regions: { key: string; entities: string[]; sample: [number, number] }[] }> } } } } } } }).__CAD__.services.doc;
    const r = doc.state.get().rebuild.outputs[s].regions[0];
    doc.beginNew('extrude', { profiles: [{ sketch: s, region: r.key, entities: r.entities, sample: r.sample }], extent: { kind: 'blind', distance: '10 mm' }, op: 'new' }).commit();
  }, sketch);
  await expect(frame.locator('[data-chip="volume"] [data-volume-mm3]')).toHaveAttribute('data-volume-mm3', '12000', { timeout: 60_000 });

  // The button again: removed.
  await editSketch(page, frame, sketch);
  await expect(layer(frame)).toHaveAttribute('data-sketch-banana', 'shown');
  await button(frame).click();
  await expect(layer(frame)).toHaveCount(0);
  await expect(button(frame)).not.toHaveAttribute('aria-pressed', 'true');
  expect(seen.errors, 'console errors').toEqual([]);
});
