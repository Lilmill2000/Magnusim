// The tunnel's flow markers (T2): tracer particles, rakes of streaks, timelines and dye,
// velocity arrows and streamlines, as the user meets them.
//
// 1. Tracers fill the tunnel and keep their number while the flow runs and the airfoil is
//    dragged through them: none is ever inside a body, none is lost or left not-a-number
//    (30 s; 5 min with MAGNUSIM_E2E_SOAK=1).
// 2. A streak rake, a timeline rake and a dye rake each put their markers into the flow,
//    downstream of the rake; dye never sits inside a body; a rake drags as a whole and by
//    its end, Undo puts it back, and the rakes are saved with the tunnel.
// 3. Streamlines are traced and velocity arrows drawn (the view changes when they are
//    turned on); the plain background shows the markers without a field or a legend; and
//    focusing a control low in the side panel never scrolls the page (the toolbar stays).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect } from '@playwright/test';
import { newTunnel, openTunnel, scaledTimeout, scene, SLOW, stats, T, test, toggle, useTunnelHost, worldToPage } from './helpers.js';

const t = useTunnelHost('tunnel2d-markers');
const KEEP_MS = process.env.MAGNUSIM_E2E_SOAK === '1' ? 300_000 : 30_000;

const particles = (frame) => T(frame, () => window.__TUNNEL__.particles());

test('tracers fill the tunnel, stay out of bodies and keep their number while the airfoil is dragged', async ({ page, request }) => {
  t.needsFastGpu();
  scaledTimeout(KEEP_MS + 240_000);
  const frame = await openTunnel(t.host, page, await newTunnel(t.host, request, 'Tracer tunnel'));
  const p0 = await particles(frame);
  expect(p0.tracers).toBeGreaterThan(500);
  expect(p0.tracersAlive).toBe(p0.tracers);
  const foil = (await scene(frame)).bodies[0];
  const end = Date.now() + KEEP_MS;
  let k = 0;
  while (Date.now() < end) {
    // Drag the airfoil up and down through the tracers now and then.
    const b = (await scene(frame)).bodies[0];
    const at = await worldToPage(page, frame, b.x + 0.15, b.y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(at.x + i * 4, at.y + (k % 2 ? -1 : 1) * i * 8);
    await page.mouse.up();
    k++;
    await page.waitForTimeout(2000);
    const p = await particles(frame);
    expect(p.nan, `after ${k} drags`).toBe(0);
    expect(p.inside, `after ${k} drags: tracers inside a body ${JSON.stringify(p.insideAt)} airfoil at ${JSON.stringify(await T(frame, (id) => window.__TUNNEL__.livePose(id), foil.id))}`).toBe(0);
    expect(p.tracersAlive, `after ${k} drags`).toBe(p0.tracers);
  }
  expect((await stats(frame)).state).toBe('running');
  expect((await scene(frame)).bodies[0].id).toBe(foil.id);
});

test('streak, timeline and dye rakes put markers downstream, drag, undo and are saved', async ({ page, request }) => {
  t.needsFastGpu();
  const study = await newTunnel(t.host, request, 'Rake tunnel');
  const frame = await openTunnel(t.host, page, study);
  const add = frame.getByRole('combobox', { name: 'Add rake' });
  await add.selectOption('streaks');
  await add.selectOption('timelines');
  await add.selectOption('dye');
  await expect.poll(async () => (await scene(frame)).rakes.map((r) => r.kind)).toEqual(['streaks', 'timelines', 'dye']);
  const [streaks, timelines, dye] = (await scene(frame)).rakes;
  // The rake panel names the selected rake (the last added).
  await expect(frame.locator('[data-t2d-rake-name]')).toHaveText('Dye 1');

  // Each puts its markers into the flow, well downstream of the rake.
  await expect
    .poll(async () => (await particles(frame)).pools.find((p) => p.id === streaks.id)?.maxX ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(streaks.x0 + 2);
  await expect
    .poll(async () => (await particles(frame)).pools.find((p) => p.id === timelines.id)?.maxX ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(timelines.x0 + 2);
  await expect
    .poll(async () => {
      const d = await T(frame, () => window.__TUNNEL__.dye());
      return d ? d.maxX[d.channels[Object.keys(d.channels)[0]]] : 0;
    }, { timeout: 30_000 })
    .toBeGreaterThan(dye.x0 + 2);
  const d = await T(frame, () => window.__TUNNEL__.dye());
  expect(d.insideSum, 'dye inside the airfoil').toBe(0);
  const p = await particles(frame);
  expect(p.inside, 'rake particles inside the airfoil').toBe(0);
  expect(p.nan).toBe(0);

  // Drag the streak rake down by its middle, then stretch it by its top end.
  await frame.locator(`[data-t2d-rake="${streaks.id}"]`).click();
  const mid = await worldToPage(page, frame, streaks.x0, (streaks.y0 + streaks.y1) / 2);
  const mpp = (await T(frame, () => window.__TUNNEL__.view())).mpp;
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(mid.x, mid.y + i * 10);
  await page.mouse.up();
  let r = (await scene(frame)).rakes[0];
  expect(r.y0).toBeCloseTo(streaks.y0 - 80 * mpp, 2);
  expect(r.y1).toBeCloseTo(streaks.y1 - 80 * mpp, 2);
  const top = await worldToPage(page, frame, r.x1, r.y1);
  await page.mouse.move(top.x, top.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(top.x + i * 10, top.y - i * 5);
  await page.mouse.up();
  r = (await scene(frame)).rakes[0];
  expect(r.x1).toBeCloseTo(streaks.x1 + 60 * mpp, 2);
  expect(r.x0).toBeCloseTo(streaks.x0, 6);
  // Undo takes back the stretch, then the move.
  await frame.locator('[data-t2d-undo]').click();
  await expect.poll(async () => (await scene(frame)).rakes[0].x1).toBeCloseTo(streaks.x1, 6);
  await frame.locator('[data-t2d-undo]').click();
  await expect.poll(async () => (await scene(frame)).rakes[0].y0).toBeCloseTo(streaks.y0, 6);

  // The rake panel: twenty emitters.
  const emitters = frame.getByRole('textbox', { name: 'Emitters', exact: true });
  await emitters.fill('20');
  await emitters.press('Enter');
  await expect.poll(async () => (await scene(frame)).rakes[0].emitters).toBe(20);

  // Saved with the tunnel.
  await expect.poll(() => T(frame, () => window.__TUNNEL__.save()), { timeout: 15_000 }).toBe('saved');
  await page.reload();
  const again = await openTunnel(t.host, page, study);
  const s = await scene(again);
  expect(s.rakes.map((x) => x.kind)).toEqual(['streaks', 'timelines', 'dye']);
  expect(s.rakes[0].emitters).toBe(20);
});

test('streamlines, velocity arrows and the plain background', async ({ page, request }) => {
  t.needsGpu();
  const frame = await openTunnel(t.host, page, await newTunnel(t.host, request, 'Lines tunnel'));
  await expect(frame.locator('[data-t2d-legend]')).toBeVisible();
  await toggle(frame, 'Streamlines');
  await expect.poll(() => T(frame, () => window.__TUNNEL__.streamlines()), { timeout: 20_000 * SLOW }).toBeGreaterThan(10);
  // Arrows: with the flow paused (so nothing else moves), the view changes when they come on.
  await frame.locator('[data-t2d-play]').click();
  await page.waitForTimeout(500);
  // A page screenshot clipped to the frame (an element screenshot of a paused WebGPU frame
  // leaves headless Chrome ignoring the next click).
  const clip = await page.locator('#workspace-frame').boundingBox();
  const before = await page.screenshot({ clip });
  // A DOM click on the switch's input: after a screenshot of a paused WebGPU frame, headless
  // Chrome holds back the next mouse click (not something a user meets).
  await frame.locator('input[aria-label="Velocity arrows"]').dispatchEvent('click');
  await expect.poll(async () => (await scene(frame)).view.arrows).toBe(true);
  await page.waitForTimeout(500);
  const after = await page.screenshot({ clip });
  expect(Buffer.compare(before, after)).not.toBe(0);
  // The plain background: no field, no legend.
  await frame.getByRole('combobox', { name: 'Show' }).selectOption('none');
  await expect(frame.locator('[data-t2d-legend]')).toHaveCount(0);
  await expect(frame.getByRole('combobox', { name: 'Streaks' })).toBeVisible();
  await frame.locator('[data-t2d-play]').dispatchEvent('click');
  await expect(frame.locator('[data-t2d-status]')).toHaveAttribute('data-state', 'running');
  // Layout guard: focusing a control low in the side panel scrolls that panel, never the
  // page (the app is pinned to the frame), so the toolbar stays where it is.
  const top = (await frame.locator('[data-t2d-play]').boundingBox()).y;
  await frame.getByRole('combobox', { name: 'Run speed' }).focus();
  await frame.getByRole('combobox', { name: 'Run speed' }).scrollIntoViewIfNeeded();
  expect((await frame.locator('[data-t2d-play]').boundingBox()).y).toBe(top);
  expect(await frame.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
});
