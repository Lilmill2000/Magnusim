// Press-pull fix round 1, the two sketch polish items the review found in ci2's label fix:
//   P1  a typed line's angle label sat on the line it measures (10°: 0 px; 30°: 0-8 px) and
//       the 30° pill covered its own "40 mm"; a click on the line where the pill was picked the
//       label, and Mirror refused it. Now an angle's pill keeps the ci2 gap from its arms, and a
//       new label keeps a gap from the labels already placed. Checked with Windows' font and a
//       wider one (Linux CI's DejaVu Sans is wider).
//   P7  a double-click on a label in Mirror (to edit its value) first showed "Dimensions can't
//       be mirrored…" from its first click. Now the refusal waits out the double-click.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

type V2 = [number, number];

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** Page coordinates of a sketch point on Top. */
async function at(page: Page, p: V2): Promise<V2> {
  const xy = await workspaceFrame(page).evaluate((pt) => {
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { project(p: number[]): [number, number] | null } | null } } } } }).__CAD__.services.viewport.get().handle;
    return h ? h.project([pt[0], pt[1], 0]) : null;
  }, p);
  expect(xy, `sketch point ${p} is not on screen`).not.toBeNull();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + xy![0], box.y + xy![1]];
}

async function settled(page: Page) {
  await expect
    .poll(() =>
      workspaceFrame(page).evaluate(() => {
        const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } | null } } } } }).__CAD__.services.viewport.get().handle;
        return h ? h.state.get().animating : true;
      }),
    )
    .toBe(false);
}

async function sketchIdle(page: Page) {
  await workspaceFrame(page).evaluate(async () => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { idle?(): Promise<void> } | null } } } } }).__CAD__.services.apis.get().sketch;
    await api?.idle?.();
  });
}

const clickAt = async (page: Page, p: V2) => {
  const [x, y] = await at(page, p);
  await page.mouse.click(x, y);
};
const chip = (frame: FrameLocator) => frame.locator('[data-chip="sketch"]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="sketch"]');

/** Verdana / DejaVu Sans and spaced-out labels: pills wider than either system's (as ci2's test does). */
async function widerFont(page: Page) {
  await workspaceFrame(page).evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '* { font-family: Verdana, "DejaVu Sans", sans-serif !important; } .cad-sk-dim { letter-spacing: 2px !important; }';
    document.head.append(s);
  });
}

async function sketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

async function typedRectangle(page: Page, frame: FrameLocator, w: number, h: number) {
  await page.keyboard.press('r');
  await clickAt(page, [0, 0]);
  const [x, y] = await at(page, [w * 0.7, h * 0.7]);
  await page.mouse.move(x, y);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type(String(w));
  await page.keyboard.press('Tab');
  await page.keyboard.type(String(h));
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await expect(chip(frame)).toHaveText('Fully defined');
}

/** L, a click at `from`, length Tab angle Enter, Esc Esc (the reviewer's steps). */
async function typedLine(page: Page, frame: FrameLocator, from: V2, len: number, deg: number) {
  await page.keyboard.press('l');
  await clickAt(page, from);
  const [x, y] = await at(page, [from[0] + len * 0.6, from[1] + 3]);
  await page.mouse.move(x, y);
  await expect(frame.locator('[data-sketch-box="length"]')).toBeVisible();
  await page.keyboard.type(String(len));
  await page.keyboard.press('Tab');
  await page.keyboard.type(String(deg));
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
}

function boxToSegment(b: { x: number; y: number; width: number; height: number }, a: V2, c: V2): number {
  const [l, t, r, bt] = [b.x, b.y, b.x + b.width, b.y + b.height];
  const inBox = (p: V2) => p[0] >= l && p[0] <= r && p[1] >= t && p[1] <= bt;
  const ptSeg = (p: V2, s: V2, e: V2) => {
    const dx = e[0] - s[0];
    const dy = e[1] - s[1];
    const k = Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - s[0] - k * dx, p[1] - s[1] - k * dy);
  };
  const cross = (p: V2, q: V2, s: V2, e: V2) => {
    const o = (u: V2, v: V2, w: V2) => Math.sign((v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]));
    return o(p, q, s) !== o(p, q, e) && o(s, e, p) !== o(s, e, q);
  };
  const corners: V2[] = [[l, t], [r, t], [r, bt], [l, bt]];
  if (inBox(a) || inBox(c)) return 0;
  for (let i = 0; i < 4; i++) if (cross(a, c, corners[i], corners[(i + 1) % 4])) return 0;
  return Math.min(...corners.map((p) => ptSeg(p, a, c)), ...[a, c].map((p) => Math.min(...corners.map((q, i) => ptSeg(p, q, corners[(i + 1) % 4])))));
}

/** The gap (px) between two boxes (0 when they overlap). */
function boxToBox(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.hypot(dx, dy);
}

test('cad:p5-fix1-angle-label-gap a typed 10° and 30° line: each angle pill clear of its line and of its line\'s length pill, with a wider font too; Mirror picks the 10° line where its pill used to sit', async ({ page, request }) => {
  for (const wide of [false, true]) {
    const { seen, frame } = await freshPart(page, request);
    if (wide) await widerFont(page);
    await sketchOnTop(page, frame);
    await typedRectangle(page, frame, 30, 20);
    const lines: [number, V2][] = [
      [10, [0, -30]],
      [30, [0, -60]],
    ];
    for (const [deg, from] of lines) await typedLine(page, frame, from, 40, deg);
    await page.mouse.move(5, 5);
    await settled(page);
    for (const [deg, from] of lines) {
      const th = (deg * Math.PI) / 180;
      const to: V2 = [from[0] + 40 * Math.cos(th), from[1] + 40 * Math.sin(th)];
      const anglePill = (await frame.locator('[data-sketch-dim]', { hasText: new RegExp(`^${deg}°$`) }).boundingBox())!;
      const gap = boxToSegment(anglePill, await at(page, from), await at(page, to));
      expect(gap, `${wide ? 'wide font: ' : ''}the ${deg}° pill is ${gap.toFixed(1)} px from its line`).toBeGreaterThanOrEqual(8);
      // Its line's own "40 mm" (the nearest 40 mm pill to the line's middle).
      const mid = await at(page, [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
      const lens = frame.locator('[data-sketch-dim]', { hasText: /^40 mm$/ });
      let own = null as null | { x: number; y: number; width: number; height: number };
      for (let i = 0; i < (await lens.count()); i++) {
        const b = (await lens.nth(i).boundingBox())!;
        if (!own || Math.hypot(b.x + b.width / 2 - mid[0], b.y + b.height / 2 - mid[1]) < Math.hypot(own.x + own.width / 2 - mid[0], own.y + own.height / 2 - mid[1])) own = b;
      }
      expect(own).not.toBeNull();
      expect(boxToBox(anglePill, own!), `${wide ? 'wide font: ' : ''}the ${deg}° pill and its 40 mm pill`).toBeGreaterThanOrEqual(4);
    }
    // Mirror: Line 1, then a click on the 10° line 13 mm from its start (where its pill was): the line.
    await page.keyboard.press('m');
    await clickAt(page, [15, 0]);
    const picked = panel(frame).locator('[data-sketch-option="picked"]');
    await expect(picked).toHaveText('To mirror: Line 1');
    const th = (10 * Math.PI) / 180;
    await clickAt(page, [13 * Math.cos(th), -30 + 13 * Math.sin(th)]);
    await expect(picked).toHaveText(/^To mirror: Line 1, Line \d+$/);
    await expect(panel(frame).locator('.mgk-reason-msg')).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(seen.errors).toEqual([]);
  }
});

test('cad:p5-fix1-dblclick-label-no-refusal a double-click on a label in Mirror edits its value with no "can\'t be mirrored" note on the way; a single click still says it', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  await typedRectangle(page, frame, 30, 20);
  const label = frame.locator('[data-sketch-dim]', { hasText: /^20 mm$/ });
  const note = panel(frame).locator('.mgk-reason-msg');
  await page.keyboard.press('m');
  await clickAt(page, [15, 0]);
  const picked = panel(frame).locator('[data-sketch-option="picked"]');
  await expect(picked).toHaveText('To mirror: Line 1');
  // Watch the note from before the double-click until well after it.
  await workspaceFrame(page).evaluate(() => {
    const w = window as unknown as { __noteSeen: string[] };
    w.__noteSeen = [];
    const obs = new MutationObserver(() => {
      for (const el of Array.from(document.querySelectorAll('[data-cad-panel="sketch"] .mgk-reason-msg'))) w.__noteSeen.push(el.textContent ?? '');
    });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await label.dblclick();
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await page.waitForTimeout(700);
  expect(await workspaceFrame(page).evaluate(() => (window as unknown as { __noteSeen: string[] }).__noteSeen)).toEqual([]);
  await expect(note).toHaveCount(0);
  await edit.press('Escape');
  await expect(picked).toHaveText('To mirror: Line 1');
  // A single click: the words come, the pick stays.
  await label.click();
  await expect(note).toHaveText("Dimensions can't be mirrored: pick lines, arcs, circles, splines or points");
  await expect(picked).toHaveText('To mirror: Line 1');
  expect(seen.errors).toEqual([]);
});
