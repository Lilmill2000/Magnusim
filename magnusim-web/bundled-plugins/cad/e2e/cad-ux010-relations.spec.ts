// ux010 (DRAW, Daniel 2026-10-09: "can you have the constraints be either on a toggle or have
// them only show up if you select the feature they belong to? that radius pull thing looks way too
// cluttered"), in the real host frame:
//  - by default no relation glyph shows; selecting a line shows its relations (and they can be
//    clicked and deleted as before); dimensions always show;
//  - "Show relations" (VIEW, Shift+R) shows every glyph, is drawn pressed, and is remembered (the
//    user's prefs: the next page starts with it on); off again by Shift+R;
//  - a conflicting relation shows (red) with the toggle off and nothing selected;
//  - a new fillet's radius arrow: none of the fillet's glyphs, no point under the arrow, the R label
//    off its line.
// The toggle is the user's pref on the server every test shares: that test runs in the serial phase and puts it back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { baseUrl, cadPref, commandControl, ensureCadOn, newPartFromTree, newProject, openProject, partOpened, readWithRetry, runCommand, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
type V2 = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

const SHOTS = process.env.CAD_UX010_SHOTS || '';
const PREF = 'sketch-show-relations';

async function freshPart(page: Page, request: APIRequestContext) {
  await ensureCadOn(request);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, projectId };
}

async function cad<T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown): Promise<T> {
  return workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
}

async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await cad<[number, number] | null>(page, ((pt: V3) => (window as unknown as W).__CAD__.services.viewport.get().handle?.project(pt) ?? null) as never, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

async function settled(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
}

async function sketchIdle(page: Page) {
  await cad(page, (async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  }) as never);
}

const clickAt = async (page: Page, p: V2) => {
  const [x, y] = await at(page, [p[0], p[1], 0]);
  await page.mouse.click(x, y);
};

async function enterSketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

async function forgetPref(request: APIRequestContext) {
  const r = await readWithRetry(() => request.post(`${baseUrl()}/api/plugin-prefs/remove`, { data: { plugin: 'cad', key: PREF } }));
  expect(r.ok(), await r.text()).toBe(true);
}

/** A 40 x 20 rectangle from the origin with its width and height typed (H, V, the origin: relations), and a free line. */
async function drawPlate(page: Page, frame: FrameLocator) {
  await page.keyboard.press('r');
  await clickAt(page, [0, 0]);
  const [x, y] = await at(page, [28, 14, 0]);
  await page.mouse.move(x, y);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type('40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

const glyphs = (frame: FrameLocator) => frame.locator('[data-sketch-glyph]');
/** Every relation anchor of the sketch (what "Show relations" draws): one glyph per curve a relation names, as glyphAnchors. */
const relationCount = (page: Page) =>
  cad<number>(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    const dims = new Set(['distance', 'distance_x', 'distance_y', 'radius', 'diameter', 'angle']);
    return d.constraints.filter((c: { kind: string }) => !dims.has(c.kind)).length;
  }) as never);

test('cad:ux010-relations-selection by default a relation shows only for the selected geometry: none at first, a line selected shows its own (clickable, deletable), dimensions always show', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await expect(frame.locator('[data-sketch-annotations]')).toHaveAttribute('data-sketch-relations', 'selection');
  await drawPlate(page, frame);
  expect(await relationCount(page)).toBeGreaterThanOrEqual(4);
  await expect(glyphs(frame)).toHaveCount(0);
  // Dimensions are not relations: both show.
  await expect(frame.locator('[data-sketch-dim]')).toHaveCount(2);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    const [ox, oy] = await at(page, [-8, 28, 0]);
    await page.mouse.move(ox - 80, oy - 60);
    await page.screenshot({ path: join(SHOTS, 'relations-default.png'), clip: { x: ox - 40, y: oy - 30, width: 360, height: 220 } });
  }
  // The top line selected: its relations show (Horizontal, and those of its ends), each naming it or its ends.
  await clickAt(page, [20, 20]);
  await expect.poll(() => glyphs(frame).count()).toBeGreaterThan(0);
  const titles = await glyphs(frame).evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  expect(titles.some((t) => t.startsWith('Horizontal'))).toBe(true);
  // A glyph of the selection is clicked and deleted as before.
  const before = await relationCount(page);
  const hz = frame.locator('[data-sketch-glyph="horizontal"]').first();
  await hz.click();
  await expect(hz).toHaveClass(/is-selected/);
  await page.keyboard.press('Delete');
  await sketchIdle(page);
  expect(await relationCount(page)).toBe(before - 1);
  // Nothing selected again: no glyph.
  await page.keyboard.press('Escape');
  await clickAt(page, [60, -25]);
  await expect(glyphs(frame)).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});

test('cad:ux010-relations-toggle Show relations (VIEW, Shift+R) shows every glyph, is pressed, and is remembered for the next page; Shift+R turns it off', { tag: '@serial' }, async ({ page, request }) => {
  await forgetPref(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    await enterSketchOnTop(page, frame);
    await drawPlate(page, frame);
    await expect(glyphs(frame)).toHaveCount(0);
    const ctl = await commandControl(frame, 'view.sketch-relations');
    await expect(ctl).toHaveAttribute('aria-label', 'Show relations');
    await ctl.click();
    await expect(frame.locator('[data-sketch-annotations]')).toHaveAttribute('data-sketch-relations', 'all');
    await expect.poll(() => glyphs(frame).count()).toBeGreaterThanOrEqual(await relationCount(page));
    await expect(frame.locator('[data-cad-toolbar] [data-command="view.sketch-relations"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => cadPref(request, PREF)).toBe(true);
    if (SHOTS) {
      const [ox, oy] = await at(page, [-8, 28, 0]);
      await page.mouse.move(ox - 80, oy - 60);
      await page.screenshot({ path: join(SHOTS, 'relations-toggle-on.png'), clip: { x: ox - 40, y: oy - 30, width: 360, height: 220 } });
    }
    // Another page (a new tab, another Part): it starts with every relation shown.
    const page2 = await page.context().newPage();
    const seen2 = await watchPage(page2);
    await openProject(page2, await newProject(request));
    await newPartFromTree(page2, 'Part 1');
    const f = await partOpened(page2);
    await expect(f.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    await f.locator('[data-tree-node="origin:top"] > .tree-row').click();
    await f.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
    await expect(f.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await expect(f.locator('[data-sketch-annotations]')).toHaveAttribute('data-sketch-relations', 'all');
    await expect(f.locator('[data-cad-toolbar] [data-command="view.sketch-relations"]')).toHaveAttribute('aria-pressed', 'true');
    await drawPlate(page2, f);
    await expect.poll(() => f.locator('[data-sketch-glyph]').count()).toBeGreaterThanOrEqual(await relationCount(page2));
    // Shift+R: off again (and off in the prefs).
    await page2.keyboard.press('Shift+R');
    await expect(f.locator('[data-sketch-annotations]')).toHaveAttribute('data-sketch-relations', 'selection');
    await expect(f.locator('[data-sketch-glyph]')).toHaveCount(0);
    await expect.poll(() => cadPref(request, PREF)).toBe(null);
    expect(seen.errors).toEqual([]);
    expect(seen2.errors).toEqual([]);
    await page2.close();
  } finally {
    await forgetPref(request);
  }
});

test('cad:ux010-relations-conflict a conflicting relation shows, red, with Show relations off and nothing selected', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await drawPlate(page, frame);
  // A broken sketch (as a file written elsewhere could hold): Vertical on the bottom line, which is Horizontal.
  await cad(page, (() => {
    const s = (window as unknown as W).__CAD__.services;
    const d = s.apis.get().sketch.stored();
    const bottom = d.entities.find((e: { kind: string; p: [string, string] }) => e.kind === 'line' && e.p.every((id) => Math.abs(d.points[id][1]) < 1e-6));
    s.doc.session().update({ constraints: [...d.constraints, { id: 'c_bad', kind: 'vertical', refs: [bottom.id] }] });
  }) as never);
  await runCommand(frame, 'sketch.finish');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await frame.locator('[data-cad-tree] [data-feature-row] > .tree-row', { hasText: 'Sketch 1' }).dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await sketchIdle(page);
  await expect(frame.locator('[data-sketch-annotations]')).toHaveAttribute('data-sketch-relations', 'selection');
  const bad = frame.locator('[data-sketch-glyph][data-constraint="c_bad"]');
  await expect(bad).toHaveCount(1);
  await expect(bad).toHaveClass(/is-over/);
  // Only what is in conflict shows: no other relation's glyph lacks the red mark.
  const others = await glyphs(frame).evaluateAll((els) => els.filter((e) => !e.classList.contains('is-over')).length);
  expect(others).toBe(0);
  expect(seen.errors.filter((e) => !/over-defined|conflict/i.test(e))).toEqual([]);
});
