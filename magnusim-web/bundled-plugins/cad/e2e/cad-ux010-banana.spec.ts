// ux010 (TOOLBAR builder): Banana for scale. Daniel 2026-10-09: "a banana for scale. it shouldn't
// be 'counted' as a body or have any effect on the simulation, but just be a tool to help people
// see the scale of things they are making ... when it imports it should be next to the geometry,
// always be able to be dragged around, and yellow ... a 'Banana for scale' button next to the
// 'View' section in the toolbar that is a new section called [Scale Models]". As a user meets it:
//   - SCALE MODELS sits right after VIEW; its button shows a yellow banana and is pressed while one
//     is shown;
//   - a click puts the banana beside the box (to +X with a gap, on the box's ground), yellow; the
//     bodies and the volume chip do not change; Fit frames it;
//   - a drag moves it on its own height, the grabbed point staying under the pointer; it never
//     orbits the view; reload: it is where it was left;
//   - back to the project: the linked geometry is the box alone (its faces and bounds); the Part
//     opened again still shows the banana; the button again removes it;
//   - a Part with no body: the banana lies at the origin.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, baseUrl, chipVolumes, modelOnPage, newPartFromTree, newProject, okLinkReport, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type Request = Parameters<typeof newProject>[0];
const SHOTS = process.env.CAD_UX010_SHOTS ?? '';

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const button = (frame: FrameLocator) => tb(frame).locator('.tb-btn[data-command="scale.banana"]');
const layer = (frame: FrameLocator) => frame.locator('[data-layer="scale-banana"]');

async function freshPart(page: Page, request: Request) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, projectId };
}

const nums = (s: string | null) => (s ?? '').split(' ').map(Number);
type Box = [number, number, number, number, number, number];

/** What the document and the tree count: bodies, and the stored banana (view). */
async function state(page: Page): Promise<{ bodies: number; banana: { at: number[]; rot: number } | null; camera: unknown }> {
  return workspaceFrame(page).evaluate(() => {
    const s = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { bodies: unknown[] }; view: { scaleModels?: { banana?: { at: number[]; rot: number } }; camera?: unknown } } } } } } }).__CAD__.services.doc.state.get();
    return { bodies: s.rebuild.bodies.length, banana: s.view.scaleModels?.banana ?? null, camera: s.view.camera ?? null };
  });
}

/** Saved, with no rebuild running and the view still. */
async function settled(page: Page, frame: FrameLocator) {
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 30_000 });
  await expect
    .poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { status: string } } } } } } }).__CAD__.services.doc.state.get().rebuild.status))
    .toBe('done');
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } | null } } } } }).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
}

async function fit(page: Page, frame: FrameLocator) {
  await tb(frame).locator('[data-command="view.fit"]').click();
  await settled(page, frame);
}

/** The colour of the page pixel at a page point. */
async function pixel(page: Page, p: [number, number]): Promise<[number, number, number]> {
  const img = PNG.decode(await page.screenshot());
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const px = PNG.at(img, Math.round(p[0] * dpr), Math.round(p[1] * dpr));
  return [px[0], px[1], px[2]];
}

test('cad:ux010-banana beside a box, yellow, not a body; dragged with the pointer; kept through a reload; not in the linked geometry; removed by the button', async ({ page, request }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { seen, frame, projectId } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await settled(page, frame);
  const volumes = await chipVolumes(frame);
  expect(volumes).toEqual([24000]);

  // SCALE MODELS right after VIEW, its one command a yellow banana, not pressed.
  const groups = await tb(frame).locator(':scope > .tb-group').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')));
  expect(groups.slice(-3)).toEqual(['view', 'scale', 'edit']);
  await expect(tb(frame).locator('[data-group="scale"] .tb-group-label')).toHaveText('SCALE MODELS');
  await expect(button(frame)).toHaveAttribute('aria-label', 'Banana for scale');
  await expect(button(frame).locator('svg path')).toHaveAttribute('fill', '#F5CF2A');
  await expect(button(frame)).not.toHaveAttribute('aria-pressed', 'true');

  // Click: the banana beside the box (+X, a 20 mm gap: 10 % of 40 mm is less), on its ground.
  await button(frame).click();
  await expect(layer(frame)).toHaveAttribute('data-banana', 'shown');
  await expect(button(frame)).toHaveAttribute('aria-pressed', 'true');
  const box = nums(await layer(frame).getAttribute('data-banana-box')) as Box;
  expect(box[0]).toBeCloseTo(60, 2);
  expect(box[2]).toBeCloseTo(0, 2);
  expect((box[1] + box[4]) / 2).toBeCloseTo(15, 2);
  expect(box[4] - box[1]).toBeGreaterThan(180);
  // Not a body: the bodies, the volume chip and the body rows stay as they were.
  const s1 = await state(page);
  expect(s1.bodies).toBe(1);
  expect(s1.banana).not.toBeNull();
  expect(await chipVolumes(frame)).toEqual(volumes);
  await expect(frame.locator('[data-body-row]')).toHaveCount(1);

  // Fit frames the box and the banana together; the banana is yellow on screen.
  await fit(page, frame);
  const at = nums(await layer(frame).getAttribute('data-banana-at'));
  const mid = await modelOnPage(page, [at[0], at[1], 12]);
  for (const corner of [
    [box[0], box[1], 0],
    [box[3], box[4], 0],
  ] as [number, number, number][])
    await modelOnPage(page, corner);
  const [r, g, b] = await pixel(page, mid);
  expect(r, `banana pixel ${[r, g, b]}`).toBeGreaterThan(170);
  expect(g).toBeGreaterThan(130);
  expect(b).toBeLessThan(110);
  expect(r - b).toBeGreaterThan(90);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/banana.png` });

  // Hover: the open hand; press and drag: the grabbed point follows the pointer on the plane
  // parallel to the screen through it (Daniel), the camera does not move.
  const camera = (await state(page)).camera;
  await page.mouse.move(mid[0], mid[1]);
  await expect(layer(frame)).toHaveAttribute('data-banana-hover', '1');
  await expect(layer(frame)).toHaveAttribute('data-banana-cursor', 'grab');
  await page.mouse.down();
  await expect(layer(frame)).toHaveAttribute('data-banana-cursor', 'grabbing');
  const to: [number, number] = [mid[0] + 120, mid[1]];
  await page.mouse.move(to[0], to[1], { steps: 12 });
  await page.mouse.up();
  await expect(layer(frame)).not.toHaveAttribute('data-banana-dragging', '1');
  const grab = nums(await layer(frame).getAttribute('data-banana-grab')) as [number, number, number];
  const under = await modelOnPage(page, grab);
  expect(Math.hypot(under[0] - to[0], under[1] - to[1]), `the grabbed point ${grab} lands at ${under}, the pointer at ${to}`).toBeLessThan(3);
  const moved = nums(await layer(frame).getAttribute('data-banana-at'));
  expect(moved[0]).not.toBeCloseTo(at[0], 0);
  expect(moved[2]).toBeCloseTo(at[2], 6);
  await expect.poll(async () => (await state(page)).banana?.at.map((v) => +v.toFixed(3) + 0)).toEqual(moved.map((v) => +v.toFixed(3) + 0));
  expect((await state(page)).camera).toEqual(camera);
  expect((await state(page)).bodies).toBe(1);
  expect(await chipVolumes(frame)).toEqual(volumes);

  // Reload: it is where it was left.
  await settled(page, frame);
  await page.waitForTimeout(2200); // the view's own save cadence (one write per 2 s at most)
  await page.reload();
  let again = page.frameLocator('#workspace-frame');
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect(layer(again)).toHaveAttribute('data-banana', 'shown', { timeout: 30_000 });
  expect(nums(await layer(again).getAttribute('data-banana-at')).map((v) => +v.toFixed(2))).toEqual(moved.map((v) => +v.toFixed(2)));
  await expect(button(again)).toHaveAttribute('aria-pressed', 'true');

  // Back to the project: the linked geometry is the box alone.
  const sid = await workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { bridge: { studyId: string } } } }).__CAD__.services.bridge.studyId);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 60_000 });
  await okLinkReport(page);
  let gid = '';
  await expect
    .poll(
      async () => {
        const r = await request.get(`${baseUrl()}/api/plugin-geometry/linked?project_id=${projectId}&plugin=cad&study_id=${sid}`);
        gid = r.ok() ? ((await r.json()).linked?.geometryId ?? '') : '';
        return gid;
      },
      { timeout: 60_000 },
    )
    .not.toBe('');
  const meta = await (await request.get(`${baseUrl()}/api/geometry/cad?project_id=${projectId}&geometry_id=${gid}&part=meta`)).json();
  expect(meta.n_faces).toBe(6);
  const bnd = meta.bounds as Record<string, number>;
  expect([bnd.xmin, bnd.ymin, bnd.zmin, bnd.xmax, bnd.ymax, bnd.zmax].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 0, 40, 30, 20]);

  // Open the Part again: the banana is still there; the button removes it.
  again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').first());
  await expect(layer(again)).toHaveAttribute('data-banana', 'shown', { timeout: 30_000 });
  expect(nums(await layer(again).getAttribute('data-banana-at')).map((v) => +v.toFixed(2))).toEqual(moved.map((v) => +v.toFixed(2)));
  await button(again).click();
  await expect(layer(again)).toHaveCount(0);
  await expect(button(again)).not.toHaveAttribute('aria-pressed', 'true');
  expect((await state(page)).banana).toBeNull();
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:ux010-banana-empty with no body the banana lies at the origin; right-click on it offers Remove banana; SCALE MODELS labelled with its heading at 1920, 1600 and 1280 px, its icon (heading kept) at 1150 and 1000 px; Sketch labelled at 1280', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { seen, frame } = await freshPart(page, request);
  // SCALE MODELS is labelled like every group at 1920, 1600 and 1280 px (VIEW and EDIT go to
  // icons first); at 1150 and 1000 px its button goes to its icon, its heading stays. Sketch keeps
  // its label down to 1280 px; the toolbar never scrolls. At 1280 px that is with Segoe UI
  // (Windows, Daniel's screen); with a wider font (Linux CI's DejaVu Sans) SCALE MODELS may go to
  // its icon there, as the first thing to give room: every modelling command keeps its label and
  // no group goes to icons (cad-p4b-toolbar-wide-text checks the order with wider text).
  for (const width of [1920, 1600, 1280, 1150, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    if (width !== 1280 || process.platform === 'win32') await expect(tb(frame)).toHaveAttribute('data-fit-scale', width >= 1280 ? '0' : '1');
    else {
      await expect.poll(() => tb(frame).evaluate(() => window.innerWidth)).toBe(width);
      // The fit runs before paint once the toolbar has seen its new width: two frames later it is done.
      await tb(frame).evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    const scaleIcon = (await tb(frame).getAttribute('data-fit-scale')) === '1';
    if (width >= 1280) {
      await expect(tb(frame)).toHaveAttribute('data-fit-icons', '');
      const labels = await tb(frame)
        .locator('.tb-group:not([data-group="view"]):not([data-group="edit"]):not([data-group="scale"]) .tb-btn[data-command] .tb-txt')
        .evaluateAll((els) => els.filter((t) => !(getComputedStyle(t).position !== 'absolute' && t.getBoundingClientRect().width > 12)).map((t) => t.textContent));
      expect(labels, `modelling commands without their label at ${width}`).toEqual([]);
    }
    expect(await tb(frame).evaluate((el) => el.scrollWidth - el.clientWidth), `the toolbar scrolls at ${width}`).toBeLessThanOrEqual(1);
    const r = (await button(frame).boundingBox())!;
    expect(r.x + r.width, `the banana inside the frame at ${width}`).toBeLessThanOrEqual(width + 0.5);
    const heading = tb(frame).locator('[data-group="scale"] .tb-group-label');
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText('SCALE MODELS');
    expect((await heading.boundingBox())!.height, `one line at ${width}`).toBeLessThan(16);
    const shown = (sel: string) => tb(frame).locator(sel).evaluate((t) => (getComputedStyle(t).position !== 'absolute' && t.getBoundingClientRect().width > 12 ? t.textContent : ''));
    expect(await shown('.tb-btn[data-command="scale.banana"] .tb-txt'), `the banana's label at ${width}`).toBe(scaleIcon ? '' : 'Banana for scale');
    if (width >= 1280) expect(await shown('.tb-btn[data-command="sketch.new"] .tb-txt'), `Sketch's label at ${width}`).toBe('Sketch');
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await button(frame).click();
  await expect(layer(frame)).toHaveAttribute('data-banana', 'shown');
  expect(nums(await layer(frame).getAttribute('data-banana-at'))).toEqual([0, 0, 0]);
  const box = nums(await layer(frame).getAttribute('data-banana-box'));
  expect(box[2]).toBeCloseTo(0, 6);
  expect((box[0] + box[3]) / 2).toBeCloseTo(0, 2);
  expect((await state(page)).bodies).toBe(0);
  // The banana alone from the side (as banana3-side.png, the approved shape), for review.
  await fit(page, frame);
  await workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { setView(v: string, o?: { animate?: boolean }): void } } } } } }).__CAD__.services.viewport.get().handle.setView('right', { animate: false }));
  await settled(page, frame);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/banana-side.png` });
  // Right-click on it: Remove banana.
  await fit(page, frame);
  const p = await modelOnPage(page, [0, 0, 12]);
  await page.mouse.click(p[0], p[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="banana-remove"]').click();
  await expect(layer(frame)).toHaveCount(0);
  await expect(button(frame)).not.toHaveAttribute('aria-pressed', 'true');
  expect(seen.errors, 'console errors').toEqual([]);
});

type HandleWin = { __CAD__: { services: { viewport: { get(): { handle: { setView(v: string, o?: { animate?: boolean }): void; lookAt(n: number[], up?: number[], o?: { animate?: boolean }): void } } } } } };

/** Press on the banana at a page point, move by (dx, dy) in steps (Alt held when asked), check while held, let go. */
async function dragBy(page: Page, from: [number, number], dx: number, dy: number, opts: { alt?: boolean; check?: () => Promise<void> } = {}) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  if (opts.alt) await page.keyboard.down('Alt');
  await page.mouse.move(from[0] + dx, from[1] + dy, { steps: 16 });
  if (opts.check) await opts.check();
  if (opts.alt) await page.keyboard.up('Alt');
  await page.mouse.up();
}

test('cad:ux010-banana-drag the grabbed point follows the pointer on the screen-parallel plane (front, iso), a leash round the part, magnet slots beside it (Alt: none), Turn 90° and Place next to part', async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await settled(page, frame);
  await button(frame).click();
  await expect(layer(frame)).toHaveAttribute('data-banana', 'shown');
  const atNow = async () => nums(await layer(frame).getAttribute('data-banana-at'));
  const home = await atNow();
  const homeBox = nums(await layer(frame).getAttribute('data-banana-box'));
  expect(homeBox[0]).toBeCloseTo(60, 3);
  expect([home[1], home[2]]).toEqual([15, 0]);

  // 1. Front and isometric views: a 100 px drag moves the grabbed point 100 px on screen the same
  // way (3 px); in the front view the banana keeps its depth (its y), and may leave the ground.
  for (const view of ['front', 'iso']) {
    await workspaceFrame(page).evaluate((v) => (window as unknown as HandleWin).__CAD__.services.viewport.get().handle.setView(v, { animate: false }), view);
    await settled(page, frame);
    const a0 = await atNow();
    const box0 = nums(await layer(frame).getAttribute('data-banana-box'));
    const from = await modelOnPage(page, [(box0[0] + box0[3]) / 2, (box0[1] + box0[4]) / 2, (box0[2] + box0[5]) / 2]);
    await dragBy(page, from, 100, -60);
    const grab = nums(await layer(frame).getAttribute('data-banana-grab')) as [number, number, number];
    const g = await modelOnPage(page, grab);
    expect(Math.hypot(g[0] - from[0] - 100, g[1] - from[1] + 60), `${view}: the grabbed point at ${g}, the pointer at ${[from[0] + 100, from[1] - 60]}`).toBeLessThan(3);
    const a1 = await atNow();
    if (view === 'front') {
      expect(a1[1], 'front view: the same depth').toBeCloseTo(a0[1], 3);
      expect(a1[2], 'front view: up the screen is up').toBeGreaterThan(a0[2] + 1);
    }
  }

  // 2. From the top, zoomed out: a long drag to +X stops at the leash, 300 mm beyond the box's side.
  await workspaceFrame(page).evaluate(() => (window as unknown as HandleWin).__CAD__.services.viewport.get().handle.setView('top', { animate: false }));
  await settled(page, frame);
  let a0 = await atNow();
  let c0 = await modelOnPage(page, [a0[0], a0[1], 18]);
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(c0[0], c0[1]);
    await page.mouse.wheel(0, 300);
  }
  await settled(page, frame);
  a0 = await atNow();
  c0 = await modelOnPage(page, [a0[0], a0[1], 18]);
  await dragBy(page, c0, 1590 - c0[0], 0);
  expect(Number(await layer(frame).getAttribute('data-banana-leash'))).toBe(300);
  const lb = nums(await layer(frame).getAttribute('data-banana-box'));
  const centre = [(lb[0] + lb[3]) / 2, (lb[1] + lb[4]) / 2, (lb[2] + lb[5]) / 2];
  const near = [Math.min(Math.max(centre[0], 0), 40), Math.min(Math.max(centre[1], 0), 30), Math.min(Math.max(centre[2], 0), 20)];
  const beyond = Math.hypot(centre[0] - near[0], centre[1] - near[1], centre[2] - near[2]);
  expect(beyond, `its centre is ${beyond} mm from the box`).toBeLessThanOrEqual(300 + 1e-2);
  expect(beyond, 'the drag reached the leash').toBeGreaterThan(299.9);

  // 3. A magnet slot: back on the ground (Place next to part), then dragged so that it comes a few
  // px from "+X min" on screen: it snaps there and the guide shows; with Alt held it does not.
  {
    const lbx = nums(await layer(frame).getAttribute('data-banana-box'));
    const p0 = await modelOnPage(page, [(lbx[0] + lbx[3]) / 2, (lbx[1] + lbx[4]) / 2, (lbx[2] + lbx[5]) / 2]);
    await page.mouse.click(p0[0], p0[1], { button: 'right' });
    await frame.locator('[data-cad-menu] [data-menu-item="banana-place"]').click();
    await expect.poll(async () => (await atNow()).map((v) => +v.toFixed(3) + 0)).toEqual(home.map((v) => +v.toFixed(3) + 0));
  }
  // "+X min": beside the +X side, aligned with the box's -Y end.
  const slot: [number, number, number] = [40 + 20 + (homeBox[3] - homeBox[0]) / 2, (homeBox[4] - homeBox[1]) / 2, 0];
  /** Press on the banana, then move the pointer so its underside centre comes `off` px from `target` (model) on screen. */
  const dragAtTo = async (target: [number, number, number], off: [number, number], opts: { alt?: boolean; check?: () => Promise<void> } = {}) => {
    const a = await atNow();
    const lbx = nums(await layer(frame).getAttribute('data-banana-box'));
    const press = await modelOnPage(page, [(lbx[0] + lbx[3]) / 2, (lbx[1] + lbx[4]) / 2, (lbx[2] + lbx[5]) / 2]);
    await page.mouse.move(press[0], press[1]);
    await page.mouse.down();
    const g = nums(await layer(frame).getAttribute('data-banana-grab'));
    // The grabbed point goes where the underside centre goes, plus its offset from it.
    const to = await modelOnPage(page, [target[0] + g[0] - a[0], target[1] + g[1] - a[1], target[2] + g[2] - a[2]]);
    if (opts.alt) await page.keyboard.down('Alt');
    await page.mouse.move(to[0] + off[0], to[1] + off[1], { steps: 16 });
    if (opts.check) await opts.check();
    if (opts.alt) await page.keyboard.up('Alt');
    await page.mouse.up();
  };
  await dragAtTo(slot, [5, 4], {
    check: async () => {
      await expect(layer(frame)).toHaveAttribute('data-banana-snap', '+x min');
      await expect(layer(frame)).toHaveAttribute('data-banana-guide', '1');
    },
  });
  expect((await atNow()).map((v) => +v.toFixed(2) + 0)).toEqual(slot.map((v) => +v.toFixed(2) + 0));
  await expect(layer(frame)).not.toHaveAttribute('data-banana-guide', '1');
  await dragAtTo(slot, [6, 5], {
    alt: true,
    check: async () => {
      await expect(layer(frame)).toHaveAttribute('data-banana-snap', '');
    },
  });
  const free = await atNow();
  expect(Math.hypot(free[0] - slot[0], free[1] - slot[1]), 'Alt: no snap').toBeGreaterThan(0.5);

  // 4. Right-click: Turn 90° (beside the part, turned), then Place next to part (where it came).
  const p = await modelOnPage(page, [free[0], free[1], 18]);
  await page.mouse.click(p[0], p[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="banana-turn"]').click();
  await expect.poll(async () => (await state(page)).banana?.rot).toBe(90);
  const box = nums(await layer(frame).getAttribute('data-banana-box'));
  const apart = Math.max(box[0] - 40, -box[3], box[1] - 30, -box[4]);
  expect(apart, `turned, it lies beside the part (${box})`).toBeGreaterThanOrEqual(20 - 1e-3);
  expect(apart).toBeLessThan(20.01);
  const q = await modelOnPage(page, [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, 18]);
  await page.mouse.click(q[0], q[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="banana-place"]').click();
  await expect.poll(async () => (await atNow()).map((v) => +v.toFixed(3))).toEqual(home.map((v) => +v.toFixed(3)));
  expect((await state(page)).banana?.rot).toBe(0);
  expect(seen.errors, 'console errors').toEqual([]);
});
