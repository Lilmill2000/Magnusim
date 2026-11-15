// Sketched bodies (T4): CAD's sketcher, in the tunnel.
//
// 1. Add shape → Sketch opens the sketcher on a new body, which stays out of the flow (its
//    panel says why) until its outline closes. A rectangle drawn with two clicks joins the
//    flow; a fillet rounds a corner (an arc, tangent to both lines, with its radius
//    dimensioned); a dimension on the left side reads its length; double-clicking the
//    dimension and typing a new value (a bad one is refused with the reason) makes the body
//    taller, and the flow sees it: more drag and a wider wake. Undo and Redo step through it,
//    and the sketch is saved: after a reload it is as it was left, in the flow.
// 2. An open outline is refused with its reason (its open ends counted) and the body stays
//    out of the flow; closing it brings the body in. Dragging a sketch point moves the
//    outline while the solver keeps its relations; Undo puts it back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect } from '@playwright/test';
import { newTunnel, openTunnel, scaledTimeout, scene, T, test, useTunnelHost, worldToPage } from './helpers.js';

const env = useTunnelHost('tunnel2d-sketch');

const editorState = (frame) => T(frame, () => window.__TUNNEL__.sketch());
const sketchOf = async (frame, id) => (await scene(frame)).bodies.find((b) => b.id === id)?.shape.sketch;
const live = (frame, id) => T(frame, (b) => window.__TUNNEL__.bodyLive(b), id);

/** Remove every body (the default airfoil), with the bodies list's buttons. */
async function clearBodies(frame) {
  for (const b of (await scene(frame)).bodies) await frame.getByRole('button', { name: `Remove ${b.name}`, exact: true }).click();
  await expect.poll(async () => (await scene(frame)).bodies.length).toBe(0);
}

/** Add an empty sketch body: the sketcher opens on it. */
async function addSketch(frame) {
  await frame.getByRole('combobox', { name: 'Add shape' }).selectOption('sketch');
  await expect(frame.locator('[data-t2d-sketchbar]')).toBeVisible();
  const s = await scene(frame);
  const body = s.bodies[s.bodies.length - 1];
  expect(body.shape.kind).toBe('sketch');
  return body;
}

/** Page clicks at sketch mm (the body's pivot is the sketch's origin; the body is not turned). */
function sketchMouse(page, frame, body) {
  const at = (mx, my) => worldToPage(page, frame, body.x + mx / 1000, body.y + my / 1000);
  return {
    at,
    async click(mx, my) {
      const p = await at(mx, my);
      await page.mouse.click(p.x, p.y);
      // Never two presses near enough in time to count as a double-click.
      await page.waitForTimeout(450);
    },
  };
}

/** Wait for the solver to finish what was asked of it. */
async function settled(frame) {
  await expect.poll(async () => (await editorState(frame)).busy, { timeout: 30_000 }).toBe(false);
}

const ys = (sk) => Object.values(sk.points).map((p) => p[1]);
const height = (sk) => Math.max(...ys(sk)) - Math.min(...ys(sk));
const lineLength = (sk, e) => Math.hypot(sk.points[e.p[1]][0] - sk.points[e.p[0]][0], sk.points[e.p[1]][1] - sk.points[e.p[0]][1]);

/**
 * The flow behind the body, averaged over five seconds: the drag (N per metre of span) and the
 * wake's deficit (m): across columns downstream (past where the vortices form), the integral of
 * (1 - speed / wind speed) where the flow is slower than the wind (the speed field is in
 * multiples of the wind speed), averaged over the columns.
 */
async function wake(page, frame, id, xs) {
  let fx = 0;
  let width = 0;
  const n = 10;
  for (let k = 0; k < n; k++) {
    fx += (await live(frame, id)).fx / n;
    width +=
      (await T(
        frame,
        async (cols) => {
          // Null while a read is in flight (or the grid is being rebuilt): try again.
          let s = null;
          for (let t = 0; t < 50 && !s; t++) {
            s = await window.__TUNNEL__.sampleField();
            if (!s) await new Promise((r) => setTimeout(r, 100));
          }
          const st = window.__TUNNEL__.stats();
          const dx = st.map.dx;
          const w = Math.ceil(st.nx / 4);
          let deficit = 0;
          for (const x of cols) {
            const i = Math.round(x / dx / 4);
            for (let j = 0; j * w < s.length; j++) {
              const v = s[j * w + i];
              if (v != null) deficit += Math.max(0, 1 - v);
            }
          }
          return (deficit * 4 * dx) / cols.length;
        },
        xs,
      )) / n;
    await page.waitForTimeout(500);
  }
  return { fx, width };
}

test('a sketched rectangle with a fillet, dimensioned: a new value makes the body taller and the flow sees it', async ({ page, request }) => {
  env.needsFastGpu();
  scaledTimeout(420_000);
  const study = await newTunnel(env.host, request, 'Sketch');
  const frame = await openTunnel(env.host, page, study);
  await clearBodies(frame);
  const body = await addSketch(frame);
  const bar = frame.locator('[data-t2d-sketchbar]');
  const chip = bar.locator('[data-t2d-sketch-status]');
  await expect(chip).toContainText('Draw a closed outline');
  await expect(frame.locator('[data-t2d-sketch-problem]')).toContainText('no outline yet');
  expect(await live(frame, body.id)).toBeNull();

  // A rectangle 400 x 200 mm about the pivot: two clicks.
  const m = sketchMouse(page, frame, body);
  await frame.locator('[data-t2d-tool="rectangle"]').click();
  await m.click(-200, -100);
  await m.click(200, 100);
  await settled(frame);
  let sk = await sketchOf(frame, body.id);
  expect(sk.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
  expect(height(sk)).toBeCloseTo(200, -1);
  await expect(chip).toHaveAttribute('data-t2d-sketch-status', 'under');
  await expect(frame.locator('[data-t2d-sketch-problem]')).toHaveCount(0);
  await expect.poll(() => live(frame, body.id), { timeout: 30_000 }).not.toBeNull();

  // A fillet at the top right corner: an arc tangent to both lines, its radius dimensioned.
  await frame.locator('[data-t2d-tool="fillet"]').click();
  await m.click(200, 100);
  await settled(frame);
  sk = await sketchOf(frame, body.id);
  const arc = sk.entities.find((e) => e.kind === 'arc');
  expect(arc, (await editorState(frame)).message).toBeTruthy();
  expect(sk.constraints.filter((c) => c.kind === 'tangent' && c.refs.includes(arc.id))).toHaveLength(2);
  // A fifth of the shorter side, to two figures.
  const radius = sk.constraints.find((c) => c.kind === 'radius' && c.refs[0] === arc.id)?.expr;
  expect(radius).toBe('40 mm');

  // Dimension the left side: pick it, then click where the dimension goes.
  await frame.locator('[data-t2d-tool="dimension"]').click();
  await m.click(-200, 0);
  await m.click(-330, 0);
  await settled(frame);
  let labels = (await editorState(frame)).labels;
  const side = labels.find((l) => l.kind !== 'radius');
  expect(side, JSON.stringify(labels)).toBeTruthy();
  expect(side.value).toBeCloseTo(200, 1);

  // The flow round it now, in the speed view.
  await frame.getByRole('combobox', { name: 'Show' }).selectOption('speed');
  await page.waitForTimeout(10_000);
  // From four to eight heights of the taller body behind it.
  const x0 = [1.5, 2, 2.5, 3].map((d) => body.x + d);
  const before = await wake(page, frame, body.id, x0);

  // Double-click the dimension and type: a value that does not read is refused, 400 mm is taken.
  await frame.locator('[data-t2d-tool="select"]').click();
  await page.waitForTimeout(450);
  const lp = await (async () => {
    const box = await page.locator('#workspace-frame').boundingBox();
    return { x: box.x + side.x, y: box.y + side.y };
  })();
  await page.mouse.dblclick(lp.x, lp.y);
  const box = frame.getByRole('textbox', { name: 'Dimension value' });
  await expect(box).toBeVisible();
  expect(Number(await box.inputValue())).toBeCloseTo(side.value, 1);
  await box.fill('two hundred');
  await box.press('Enter');
  await expect(frame.locator('[data-t2d-dim-error]')).toBeVisible();
  await box.fill('400 mm');
  await box.press('Enter');
  await expect(box).toHaveCount(0);
  await settled(frame);
  sk = await sketchOf(frame, body.id);
  expect(height(sk)).toBeCloseTo(400, 0);
  const left = sk.entities.find((e) => e.id === sk.constraints.find((c) => c.id === side.id).refs[0]);
  expect(lineLength(sk, left)).toBeCloseTo(400, 3);
  // The fillet keeps its radius.
  expect(sk.constraints.find((c) => c.kind === 'radius')?.expr).toBe(radius);

  // The flow sees the taller body: more drag, a wider wake.
  await page.waitForTimeout(10_000);
  const after = await wake(page, frame, body.id, x0);
  console.log(`sketch: drag ${before.fx.toFixed(1)} -> ${after.fx.toFixed(1)} N/m, wake deficit ${before.width.toFixed(3)} -> ${after.width.toFixed(3)} m`);
  expect(after.fx, `drag ${before.fx} -> ${after.fx} N/m`).toBeGreaterThan(before.fx * 1.3);
  expect(after.width, `wake ${before.width} -> ${after.width} m`).toBeGreaterThan(before.width * 1.3);

  // Undo and Redo step through the change.
  await frame.getByRole('button', { name: 'Undo' }).click();
  await settled(frame);
  expect(height(await sketchOf(frame, body.id))).toBeCloseTo(200, 0);
  await frame.getByRole('button', { name: 'Redo' }).click();
  await settled(frame);
  expect(height(await sketchOf(frame, body.id))).toBeCloseTo(400, 0);

  // Done closes the sketcher; the sketch is saved and comes back as it was, in the flow.
  await bar.locator('[data-t2d-sketch-done]').click();
  await expect(bar).toHaveCount(0);
  const saved = await sketchOf(frame, body.id);
  await expect.poll(() => T(frame, () => window.__TUNNEL__.save()), { timeout: 30_000 }).toBe('saved');
  const again = await openTunnel(env.host, page, study);
  expect(await sketchOf(again, body.id)).toEqual(saved);
  await expect.poll(() => live(again, body.id), { timeout: 30_000 }).not.toBeNull();
  await expect(again.locator('[data-t2d-sketch-problem]')).toHaveCount(0);
});

test('an open outline is refused with its reason until it closes; a dragged point moves the outline', async ({ page, request }) => {
  env.needsGpu();
  scaledTimeout(240_000);
  const study = await newTunnel(env.host, request, 'Sketch open');
  const frame = await openTunnel(env.host, page, study);
  await clearBodies(frame);
  const body = await addSketch(frame);
  const m = sketchMouse(page, frame, body);
  const chip = frame.locator('[data-t2d-sketch-status]');

  // Two lines, the chain ended with Escape: open at both ends.
  await m.click(-200, -100);
  await m.click(200, -100);
  await m.click(200, 100);
  await page.keyboard.press('Escape');
  await settled(frame);
  expect((await sketchOf(frame, body.id)).entities).toHaveLength(2);
  await expect(chip).toHaveAttribute('data-t2d-sketch-status', 'open');
  await expect(chip).toContainText('not in the flow');
  await expect(frame.locator('[data-t2d-sketch-problem]')).toContainText('not closed (2 open ends');
  await page.waitForTimeout(1000);
  expect(await live(frame, body.id)).toBeNull();

  // Close it: from the last point back to the first (both picked up where they are).
  await m.click(200, 100);
  await m.click(-200, -100);
  await page.keyboard.press('Escape');
  await settled(frame);
  let sk = await sketchOf(frame, body.id);
  expect(sk.entities).toHaveLength(3);
  expect(Object.keys(sk.points)).toHaveLength(3);
  await expect(chip).not.toHaveAttribute('data-t2d-sketch-status', 'open');
  await expect(frame.locator('[data-t2d-sketch-problem]')).toHaveCount(0);
  await expect.poll(() => live(frame, body.id), { timeout: 30_000 }).not.toBeNull();

  // Drag the top corner up and right: the outline follows, the bottom stays horizontal.
  await frame.locator('[data-t2d-tool="select"]').click();
  await page.waitForTimeout(450);
  const corner = Object.entries(sk.points).find(([, p]) => p[1] > 50)[0];
  const from = await m.at(200, 100);
  const to = await m.at(320, 220);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(from.x + ((to.x - from.x) * k) / 10, from.y + ((to.y - from.y) * k) / 10);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await settled(frame);
  await expect.poll(async () => (await sketchOf(frame, body.id)).points[corner][0], { timeout: 15_000 }).toBeGreaterThan(280);
  sk = await sketchOf(frame, body.id);
  expect(sk.points[corner][1]).toBeGreaterThan(180);
  const bottom = Object.entries(sk.points).filter(([id]) => id !== corner).map(([, p]) => p[1]);
  expect(Math.abs(bottom[0] - bottom[1])).toBeLessThan(1e-6);
  await frame.getByRole('button', { name: 'Undo' }).click();
  await settled(frame);
  expect((await sketchOf(frame, body.id)).points[corner][0]).toBeCloseTo(200, -1);
});

test('an outline opening and closing never stalls or restarts the flow, and Auto keeps its flow model', async ({ page, request }) => {
  env.needsFastGpu();
  scaledTimeout(240_000);
  const study = await newTunnel(env.host, request, 'Sketch switch');
  const frame = await openTunnel(env.host, page, study);
  await clearBodies(frame);
  const body = await addSketch(frame);
  const m = sketchMouse(page, frame, body);
  await frame.locator('[data-t2d-tool="rectangle"]').click();
  await m.click(-200, -100);
  await m.click(200, 100);
  await settled(frame);
  await expect.poll(() => live(frame, body.id), { timeout: 30_000 }).not.toBeNull();
  await page.waitForTimeout(4000);
  // The status line's numbers every 50 ms while the bottom side goes (open: the body leaves
  // the flow) and comes back.
  await T(frame, () => {
    window.__rec = [];
    window.__recT = setInterval(() => {
      const s = window.__TUNNEL__.stats();
      window.__rec.push([performance.now(), s.simTime, s.stepsPerFrame, s.nx]);
    }, 50);
  });
  await page.waitForTimeout(1500);
  await frame.locator('[data-t2d-tool="select"]').click();
  await page.waitForTimeout(450);
  await m.click(0, -100);
  await frame.locator('[data-t2d-sketch-delete]').click();
  await expect(frame.locator('[data-t2d-sketch-status]')).toHaveAttribute('data-t2d-sketch-status', 'open');
  // Auto sizes the open sketch by what is drawn: still the turbulence model, so nothing is rebuilt.
  const model = frame.getByRole('combobox', { name: 'Flow model' });
  await expect(model.locator('option:checked')).toHaveText('Auto (turbulence model)');
  await page.waitForTimeout(3000);
  await expect(model.locator('option:checked')).toHaveText('Auto (turbulence model)');
  await frame.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => live(frame, body.id), { timeout: 30_000 }).not.toBeNull();
  await page.waitForTimeout(3000);
  const rec = await T(frame, () => {
    clearInterval(window.__recT);
    return window.__rec;
  });
  const before = rec.slice(0, 25).map((r) => r[2]).sort((a, b) => a - b)[12];
  let freeze = 0;
  let since = rec[0][0];
  for (let i = 1; i < rec.length; i++) {
    if (rec[i][1] !== rec[i - 1][1]) since = rec[i][0];
    freeze = Math.max(freeze, rec[i][0] - since);
  }
  const fewest = Math.min(...rec.slice(25).map((r) => r[2]));
  console.log(`sketch switch: longest freeze ${Math.round(freeze)} ms, steps a frame ${before} before, ${fewest} at the fewest`);
  expect(freeze, 'the flow stood still this long (ms)').toBeLessThan(400);
  // Never restarted: the simulated time only grows, on the same grid.
  expect(rec.every((r, i) => i === 0 || r[1] >= rec[i - 1][1]), 'the flow restarted').toBe(true);
  expect(new Set(rec.map((r) => r[3])).size, 'the grid changed').toBe(1);
  expect(fewest, `steps a frame fell to ${fewest} from ${before}`).toBeGreaterThan(before * 0.25);
});
