// The person's Hole panel with what Magnusim CAD PR 13 added, and Extrude's Draft angle, on one
// Part: a 60 x 40 x 20 block (x 0..60, y 0..40, z 0..20) and a sketch "Layout" of two points:
//   cad:hole-kinds  a clearance hole for an M6 bolt (normal fit, 6.6 mm) counterbored From the
//               screw table (11 x 6.4 mm): the panel's words, the three features in the tree, the
//               volume it cuts (1073.50 mm3), one Ctrl+Z takes the whole hole back and Ctrl+Y brings
//               it; a tapped M6x1 hole 12 mm deep with a modelled thread (the feature "Hole 2
//               thread", its label in the view, about 273.9 mm3 cut); holes From a sketch at
//               Layout's points (2.5 mm, through: 196.35 mm3) that follow a point moved; a blind hole
//               deeper than the block with a drill point: the words the person reads (it goes through,
//               the drill tip left out; Magnusim CAD issue 14) and no tip made; then a 10 mm square
//               extruded 10 mm at a Draft angle of 5 deg: its frustum, 835.23 mm3.
// Setup (the block and Layout) goes in through the document as the other specs do; everything
// asserted is what the person sees (the panel, the tree, the toast, the chip, the view's label) or
// the record their clicks stored.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSketch, addSolid, chipVolumes, historyNames, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, singleVolume, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(
      () =>
        workspaceFrame(page).evaluate(() => {
          const st = (window as unknown as W).__CAD__.services.doc.state.get();
          return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const undoLabel = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel as string | null);
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(?:[(][-+?][)] )?${name}$`) }) });
const toolPanel = (frame: FrameLocator) => frame.locator('[data-cad-panel="tool"]');
/** The workspace's toast, as the person sees it over the Part. */
const toast = (page: Page) => page.locator('#workspace-overlay [data-ws-toast]');

/** A sketch "Layout" on Top of two points, at (45, 10) and (45, 30), each placed by its dimensions. */
async function addLayout(page: Page): Promise<string> {
  return workspaceFrame(page).evaluate(async () => {
    const s = (window as unknown as W).__CAD__.services;
    const dim = (id: string, kind: string, pt: string, v: number) => ({ id, kind, refs: ['origin', pt], expr: `${v} mm`, driving: true });
    const cs = [dim('c_ax', 'distance_x', 'pt_a', 45), dim('c_ay', 'distance_y', 'pt_a', 10), dim('c_bx', 'distance_x', 'pt_b', 45), dim('c_by', 'distance_y', 'pt_b', 30)];
    // As addSketch: a sketch "made earlier" leaves the camera where it was.
    const handle = s.viewport.get().handle;
    const lookAt = handle?.lookAt;
    if (handle) handle.lookAt = () => {};
    let sk: { feature: string; commit(): void };
    try {
      sk = s.doc.beginNew('sketch', {
        name: 'Layout',
        support: { kind: 'plane', plane: 'origin:top' },
        plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
        points: { pt_a: [45, 10], pt_b: [45, 30] },
        entities: [
          { id: 'e_a', kind: 'point', p: 'pt_a' },
          { id: 'e_b', kind: 'point', p: 'pt_b' },
        ],
        constraints: cs,
        solved: { values: { c_ax: 45, c_ay: 10, c_bx: 45, c_by: 30 }, dof: 0, state: 'fully' },
      });
      sk.commit();
    } finally {
      if (handle && lookAt) handle.lookAt = lookAt;
    }
    for (let i = 0; i < 400; i++) {
      const o = s.doc.state.get().rebuild.outputs[sk.feature];
      if (o && o.type === 'sketch') return sk.feature;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('Layout did not build');
  });
}

/** Hole opened, the block's top face clicked, then each centre clicked on it. */
async function openHole(page: Page, frame: FrameLocator, centres: [number, number][]) {
  await runCommand(frame, 'solid.hole');
  const panel = toolPanel(frame);
  await expect(panel.locator('[data-tool-panel="solid.hole"]')).toBeVisible();
  const face = await modelOnPage(page, [5, 5, 20]);
  await page.mouse.click(face[0], face[1]);
  await expect(panel.locator('[data-pick-field="hole-face"] [data-pick-row]')).toHaveCount(1);
  await expect(panel.locator('[data-tool-panel="solid.hole"]')).toHaveAttribute('data-hole-along', 'Z');
  for (const [x, y] of centres) {
    const at = await modelOnPage(page, [x, y, 20]);
    await page.mouse.click(at[0], at[1]);
  }
  await expect(panel.locator('[data-hole-centre]')).toHaveCount(centres.length);
  return panel;
}

/** The panel's hints, as the person reads them. */
const hints = (frame: FrameLocator) => toolPanel(frame).locator('.mgk-hint');

test('cad:hole-kinds Hole: a counterbore from the screw table, a modelled thread, holes at a sketch\'s points, a blind hole that goes through; one Ctrl+Z per hole; Extrude\'s Draft angle', async ({ page, request }) => {
  test.setTimeout(360_000);
  await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await addSolid(page, { size: [60, 40, 20] });
  await addLayout(page);
  await settled(page);
  const BLOCK = 48_000;
  await expect.poll(() => singleVolume(frame)).toBeCloseTo(BLOCK, 3);
  const base = ['Sketch 1', 'Extrude 1', 'Layout'];
  await expect(historyNames(frame)).toHaveText(base);

  // 1. A clearance hole for an M6 bolt, counterbored for its socket head From the screw table.
  let panel = await openHole(page, frame, [[15, 20]]);
  await panel.locator('[data-field="sizing"] select').selectOption('clearance');
  await expect(panel.locator('[data-field="size"] select')).toHaveValue('M6');
  await expect(panel.locator('[data-field="fit"] select')).toHaveValue('normal');
  await expect(hints(frame)).toContainText(['Clearance hole 6.6 mm (ISO 273, normal fit).']);
  await panel.locator('[data-field="type"] select').selectOption('counterbore');
  await expect(panel.locator('input[data-field="from-table"]')).toBeChecked();
  await expect(hints(frame)).toContainText(['Counterbore 11 mm across, 6.4 mm deep, for an M6 socket head cap screw (ISO 4762, DIN 974-1).']);
  // From the table: no counterbore fields to type.
  await expect(panel.locator('input[data-field="cb-diameter"]')).toHaveCount(0);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  const bored = [...base, 'Hole 1 sketch', 'Hole 1 counterbore', 'Hole 1'];
  await expect(historyNames(frame)).toHaveText(bored);
  await settled(page);
  for (const n of ['Hole 1 counterbore', 'Hole 1']) await expect(featureRow(frame, n)).toHaveAttribute('data-state', 'ok');
  // pi 5.5^2 6.4 + pi 3.3^2 (20 - 6.4) = 1073.50.
  const cb = Math.PI * 30.25 * 6.4 + Math.PI * 10.89 * 13.6;
  await expect.poll(() => singleVolume(frame), { timeout: 30_000 }).toBeCloseTo(BLOCK - cb, 1);
  const stored = await workspaceFrame(page).evaluate(() => {
    const d = (window as unknown as W).__CAD__.services.doc.state.get().doc;
    const by = (n: string) => d.features.find((f: { name: string }) => f.name === n);
    return { dims: by('Hole 1 sketch').constraints.filter((c: { expr?: string }) => c.expr).map((c: { id: string; expr: string }) => `${c.id}=${c.expr}`), step: by('Hole 1 counterbore').extent, bore: by('Hole 1').extent.kind };
  });
  expect(stored.dims).toEqual(expect.arrayContaining(['d=6.6 mm', 'dc=11 mm']));
  expect(stored).toMatchObject({ step: { kind: 'blind', distance: '6.4 mm' }, bore: 'through_all' });
  expect(await undoLabel(page)).toBe('Hole 1');
  // One Ctrl+Z takes the whole hole back (its sketch and both cuts); Ctrl+Y brings it.
  await frame.locator('[data-cad-app]').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+z');
  await expect(historyNames(frame)).toHaveText(base);
  await expect.poll(() => singleVolume(frame), { timeout: 30_000 }).toBeCloseTo(BLOCK, 2);
  await page.keyboard.press('Control+y');
  await expect(historyNames(frame)).toHaveText(bored);
  await expect.poll(() => singleVolume(frame), { timeout: 30_000 }).toBeCloseTo(BLOCK - cb, 1);

  // 2. A tapped M6x1 hole 12 mm deep, its thread modelled: cut into the wall by "Hole 2 thread".
  panel = await openHole(page, frame, [[30, 20]]);
  await panel.locator('[data-field="sizing"] select').selectOption('tapped');
  await expect(panel.locator('[data-field="size"] select option:checked')).toHaveText('M6x1');
  await panel.locator('[data-field="thread"] select').selectOption('modelled');
  await expect(hints(frame)).toContainText(['Tap drill 5 mm for M6x1; the thread is cut into the wall (and labelled in the view).']);
  await panel.locator('[data-field="depth"] select').selectOption('blind');
  await panel.locator('[data-field="distance"]').fill('12 mm');
  let before = await singleVolume(frame);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  const threaded = [...bored, 'Hole 2 sketch', 'Hole 2', 'Hole 2 thread'];
  await expect(historyNames(frame)).toHaveText(threaded, { timeout: 60_000 });
  await settled(page);
  await expect(featureRow(frame, 'Hole 2 thread')).toHaveAttribute('data-state', 'ok');
  // The bore (pi 2.5^2 12 = 235.62) and the groove: about 273.9 in all.
  await expect.poll(async () => before - (await singleVolume(frame)), { timeout: 30_000 }).toBeGreaterThan(Math.PI * 6.25 * 12 + 30);
  expect(before - (await singleVolume(frame))).toBeCloseTo(273.9, 0);
  // Its designation beside the hole in the view.
  await expect(frame.locator('.cad-thread-label[data-thread="Hole 2"]')).toHaveText('M6x1');
  expect(await undoLabel(page)).toBe('Hole 2');

  // 3. Holes at Layout's points (From a sketch), 2.5 mm through; they follow a point that moves.
  await runCommand(frame, 'solid.hole');
  panel = toolPanel(frame);
  await expect(panel.locator('[data-tool-panel="solid.hole"]')).toBeVisible();
  const face = await modelOnPage(page, [5, 5, 20]);
  await page.mouse.click(face[0], face[1]);
  await expect(panel.locator('[data-pick-field="hole-face"] [data-pick-row]')).toHaveCount(1);
  await panel.locator('[data-field="from-sketch"] select').selectOption('Layout');
  await expect(panel.locator('[data-pick-field="hole-centres"] .cad-pick-label')).toHaveText("Centres: Layout's points (2)");
  await expect(hints(frame)).toContainText(["2 holes at Layout's points: they follow those points when they move (a point added to Layout later gets no hole)"]);
  await panel.locator('[data-field="diameter"]').fill('2.5 mm');
  before = await singleVolume(frame);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  const pointed = [...threaded, 'Hole 3 sketch', 'Hole 3'];
  await expect(historyNames(frame)).toHaveText(pointed);
  await settled(page);
  await expect.poll(async () => before - (await singleVolume(frame)), { timeout: 30_000 }).toBeCloseTo(2 * Math.PI * 1.5625 * 20, 1);
  /** Hole 3's circle centres as built (the top face's frame runs as the model's x and y). */
  const centres = () =>
    workspaceFrame(page).evaluate(() => {
      const st = (window as unknown as W).__CAD__.services.doc.state.get();
      const sk = st.doc.features.find((f: { name: string }) => f.name === 'Hole 3 sketch');
      const out = st.rebuild.outputs[sk.id];
      return sk.entities.filter((e: { kind: string; id: string }) => e.kind === 'circle' && /^h\d+$/.test(e.id)).map((e: { c: string }) => out.points[e.c].map((v: number) => Math.round(v * 1e4) / 1e4));
    });
  expect(await centres()).toEqual([
    [45, 10],
    [45, 30],
  ]);
  // Layout's first point moved 5 mm along X: its hole goes with it.
  await workspaceFrame(page).evaluate(() => {
    const doc = (window as unknown as W).__CAD__.services.doc;
    const sk = doc.state.get().doc.features.find((f: { name: string }) => f.name === 'Layout');
    const s = doc.beginEdit(sk.id);
    s.update({ constraints: sk.constraints.map((c: { id: string }) => (c.id === 'c_ax' ? { ...c, expr: '50 mm' } : c)) });
    s.commit();
  });
  await settled(page);
  await expect.poll(centres, { timeout: 30_000 }).toEqual([
    [50, 10],
    [45, 30],
  ]);
  await expect(featureRow(frame, 'Hole 3')).toHaveAttribute('data-state', 'ok');

  // 4. Magnusim CAD issue 14: a blind hole 30 mm deep in the 20 mm block, with a drill point. The
  // person reads that it goes through and that the tip was left out; no tip is made.
  panel = await openHole(page, frame, [[15, 33]]);
  await panel.locator('[data-field="diameter"]').fill('4 mm');
  await panel.locator('[data-field="depth"] select').selectOption('blind');
  await panel.locator('[data-field="distance"]').fill('30 mm');
  await panel.locator('[data-field="tip"] select').selectOption('drill');
  before = await singleVolume(frame);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await expect(toast(page).filter({ hasText: 'Hole 4:' })).toContainText('Hole 4: Hole 4 is 30 mm deep, at least as deep as Body 1 there, so it goes through (set depth through, or a smaller distance); the drill tip was left out', { timeout: 60_000 });
  await expect(historyNames(frame)).toHaveText([...pointed, 'Hole 4 sketch', 'Hole 4']);
  await settled(page);
  await expect.poll(async () => before - (await singleVolume(frame)), { timeout: 30_000 }).toBeCloseTo(Math.PI * 4 * 20, 1);

  // 5. Extrude's Draft angle: a 10 mm square beside the block, 10 mm at 5 deg (it narrows), a new body.
  await addSketch(page, { at: [100, 0], size: [10, 10] });
  await settled(page);
  await featureRow(frame, 'Sketch 2').locator('> .tree-row').click();
  await runCommand(frame, 'solid.extrude');
  const ex = frame.locator('[data-cad-panel="feature"]');
  await expect(ex.locator('[data-profile-list] [data-profile]')).toHaveCount(1);
  const dist = ex.locator('.nui[data-field="distance"] input');
  await dist.fill('10');
  await dist.press('Enter');
  const taper = ex.locator('.nui[data-field="taper"] input');
  await taper.fill('5');
  await taper.press('Enter');
  await expect(ex.locator('.nui[data-field="taper"] [data-nui-error]')).toHaveCount(0);
  await ex.locator('[data-panel-done]').click();
  await expect(ex).toHaveCount(0);
  await settled(page);
  const drafted = await workspaceFrame(page).evaluate(() => {
    const d = (window as unknown as W).__CAD__.services.doc.state.get().doc;
    const f = d.features[d.features.length - 1];
    return { name: f.name, taper: f.taper, extent: f.extent, op: f.op };
  });
  expect(drafted).toEqual({ name: 'Extrude 2', taper: '5 deg', extent: { kind: 'blind', distance: '10 mm' }, op: 'new' });
  // h / 3 (A + a + sqrt(A a)) with the top 10 - 20 tan(5 deg) across: 835.23.
  await expect.poll(async () => (await chipVolumes(frame)).some((v) => Math.abs(v - 835.23) < 0.01), { timeout: 30_000 }).toBe(true);
});
