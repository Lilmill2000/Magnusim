// P4a SOLIDS: Revolve, Sweep, Loft, Fillet, Chamfer, Shell, the Extrude extents
// Through all and Up to, and a flat face extruded with no sketch, each as a user
// makes it: the command in the toolbar, picks in the view (regions, a centerline,
// path curves, edges, faces), values typed in the panel, Done. Setup (the sketches,
// a block) goes in through the document as the other specs do; everything asserted
// is what the user sees: the tree rows and their state, the panel's rows and foot,
// the volume and size chips (checked against analytic values). Selections are made as a
// user makes them (a sketch's tree row, Escape to let go); undo, redo, a reopened panel and
// a reopened Part are checked too (P4a review: none of them were).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, featureRowNamed, modelOnPage, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame, runCommand } from './helpers';

type V3 = [number, number, number];

/** A screenshot into CAD_E2E_SHOTS (nothing without it). */
async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** A sketch put in through the document (setup), the camera left as it is; waits until it is built. */
async function addRawSketch(page: Page, init: Record<string, unknown>): Promise<string> {
  return workspaceFrame(page).evaluate(async (i) => {
    const s = (window as unknown as W).__CAD__.services;
    const handle = s.viewport.get().handle;
    const lookAt = handle?.lookAt;
    if (handle) handle.lookAt = () => {};
    let id: string;
    try {
      const sk = s.doc.beginNew('sketch', i);
      sk.commit();
      id = sk.feature;
    } finally {
      if (handle && lookAt) handle.lookAt = lookAt;
    }
    for (let k = 0; k < 400; k++) {
      const o = s.doc.state.get().rebuild.outputs[id];
      if (o && o.type === 'sketch') return id;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the sketch did not build');
  }, init);
}

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      workspaceFrame(page).evaluate(() => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
      }),
    )
    .toBe(true);
}

/** The volume the chip shows for a body (mm³), waiting for it to read `expected` within `rel`. */
async function expectVolume(frame: FrameLocator, page: Page, expected: number, rel = 1e-6, body?: string) {
  const id = body ?? (await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0]?.id));
  const at = frame.locator(`[data-chip="volume"] [data-volume-body="${id}"]`).first();
  await expect.poll(async () => Math.abs(Number(await at.getAttribute('data-volume-mm3')) / expected - 1), { timeout: 30_000 }).toBeLessThan(rel);
}

const plane = (p: 'top' | 'front' | 'right') =>
  ({
    top: { support: { kind: 'plane', plane: 'origin:top' }, plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] } },
    front: { support: { kind: 'plane', plane: 'origin:front' }, plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] } },
    right: { support: { kind: 'plane', plane: 'origin:right' }, plane: { origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] } },
  })[p];

/** A rectangle [x0,x1] x [y0,y1] as sketch entities (and extra lines). */
function rect(x0: number, y0: number, x1: number, y1: number, extra: { a: [number, number]; b: [number, number]; centerline?: boolean }[] = []) {
  const points: Record<string, [number, number]> = { p1: [x0, y0], p2: [x1, y0], p3: [x1, y1], p4: [x0, y1] };
  const entities: Record<string, unknown>[] = [
    { id: 'e1', kind: 'line', p: ['p1', 'p2'] },
    { id: 'e2', kind: 'line', p: ['p2', 'p3'] },
    { id: 'e3', kind: 'line', p: ['p3', 'p4'] },
    { id: 'e4', kind: 'line', p: ['p4', 'p1'] },
  ];
  extra.forEach((l, i) => {
    points[`q${i}a`] = l.a;
    points[`q${i}b`] = l.b;
    entities.push({ id: `l${i}`, kind: 'line', p: [`q${i}a`, `q${i}b`], ...(l.centerline ? { centerline: true } : {}) });
  });
  return { points, entities, constraints: [], solved: { values: {}, dof: 8, state: 'under' } };
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');

/** A history row clicked: it is selected, as a user selects a sketch before a command. */
async function selectRow(frame: FrameLocator, name: string) {
  // An under-defined sketch's row reads "(-) Sketch 2".
  const row = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(?:[(]-[)] )?${name}$`) }) });
  await row.locator('> .tree-row').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
}

/** The size chip's numbers (mm), waiting for them to be `want` within `tol` mm. */
async function expectSize(frame: FrameLocator, want: number[], tol = 1e-6) {
  await expect
    .poll(async () => {
      const raw = (await frame.locator('[data-chip="size"] [data-size-mm]').getAttribute('data-size-mm').catch(() => null)) ?? '';
      const got = raw.split(',').map(Number);
      return got.length === 3 && got.every((g, i) => Math.abs(g - want[i]) < tol) ? 'ok' : raw;
    }, { timeout: 30_000 })
    .toBe('ok');
}
const foot = (frame: FrameLocator) => panel(frame).locator('[data-run-reason] .mgk-reason-msg');

async function clickAt(page: Page, p: V3, opts: { button?: 'left' | 'right' } = {}) {
  // The view still (a new body can start a refit): a point projected during a transition is not where it ends.
  // Still twice, 150 ms apart, at the same spot: a refit that starts a frame after a rebuild is caught too.
  let last = '';
  await expect
    .poll(async () => {
      const moving = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true);
      const at = moving ? 'moving' : (await modelOnPage(page, p)).map((v) => v.toFixed(1)).join(',');
      const same = at !== 'moving' && at === last;
      last = at;
      return same;
    }, { intervals: [150] })
    .toBe(true);
  const [x, y] = await modelOnPage(page, p);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, opts);
}

test.describe('P4a solids', () => {
  test('cad:p4a-revolve: Revolve takes the only profile and its sketch\'s centerline; full, then symmetric 90°; a profile across the axis is red', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addRawSketch(page, { ...plane('front'), ...rect(10, 0, 20, 30, [{ a: [0, -5], b: [0, 40], centerline: true }]) });
    await settled(page);
    await runCommand(frame, 'solid.revolve');
    await expect(panel(frame).locator('[data-feature-panel="revolve"]')).toBeVisible();
    await expect(panel(frame).locator('[data-pick-field="profiles"] [data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row]')).toHaveText(/Line of Sketch 1/);
    await settled(page);
    await expect(featureRowNamed(frame, 'Revolve 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, Math.PI * 300 * 30);
    await shot(page, 'p4a-revolve');
    // Symmetric, 90° in all: a quarter of the tube.
    await panel(frame).locator('[data-field="extent"] select').selectOption('symmetric');
    const angle = panel(frame).locator('.nui[data-field="angle"] input');
    await angle.fill('90');
    await angle.press('Enter');
    await settled(page);
    await expectVolume(frame, page, (Math.PI * 300 * 30) / 4);
    // Symmetric about the sketch plane (P4a review: checked by volume only): 45° each way of Front,
    // so x runs from 10 cos 45° to 20 and y from -20 sin 45° to 20 sin 45°.
    await expectSize(frame, [20 - 10 * Math.SQRT1_2, 40 * Math.SQRT1_2, 30]);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    await expect(featureRowNamed(frame, 'Revolve 1')).toHaveAttribute('data-state', 'ok');
    // Undo: the new Revolve and everything done in its panel are one step; Redo brings it back as it was.
    await page.keyboard.press('Control+z');
    await expect(featureRowNamed(frame, 'Revolve 1')).toHaveCount(0);
    await expect(frame.locator('[data-chip="volume"]')).toHaveCount(0);
    await page.keyboard.press('Control+y');
    await expect(featureRowNamed(frame, 'Revolve 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, (Math.PI * 300 * 30) / 4);
    // Reopened: Symmetric, 90°; 180° typed and Done, then Undo: 90° again, Redo: 180°.
    await featureRowNamed(frame, 'Revolve 1').locator('> .tree-row').dblclick();
    await expect(panel(frame).locator('[data-field="extent"] select')).toHaveValue('symmetric');
    await expect(panel(frame).locator('.nui[data-field="angle"] input')).toHaveValue('90');
    await angle.fill('180');
    await angle.press('Enter');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await expectVolume(frame, page, (Math.PI * 300 * 30) / 2);
    await page.keyboard.press('Control+z');
    await expectVolume(frame, page, (Math.PI * 300 * 30) / 4);
    await expectSize(frame, [20 - 10 * Math.SQRT1_2, 40 * Math.SQRT1_2, 30]);
    await page.keyboard.press('Control+y');
    await expectVolume(frame, page, (Math.PI * 300 * 30) / 2);

    // A second sketch whose profile lies across its own centerline: red with the reason.
    await addRawSketch(page, { ...plane('front'), ...rect(-5, 40, 5, 50, [{ a: [0, 35], b: [0, 55], centerline: true }]) });
    await settled(page);
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Sketch 2');
    await runCommand(frame, 'solid.revolve');
    await expect(panel(frame).locator('[data-pick-field="profiles"] [data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row]')).toHaveText(/Line of Sketch 2/);
    await settled(page);
    await expect(foot(frame)).toHaveText('Revolve 2 failed: the profile crosses the axis: keep the profile on one side of the axis');
    await expect(featureRowNamed(frame, 'Revolve 2')).toHaveAttribute('data-state', 'error');
    // The rest of the model still shows.
    await expectVolume(frame, page, (Math.PI * 300 * 30) / 2);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-revolve-axis-pick: the axis picked by clicking a centerline in the view', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    // Two centerlines: no axis is taken by itself.
    await addRawSketch(page, { ...plane('front'), ...rect(10, 0, 20, 30, [{ a: [0, -5], b: [0, 40], centerline: true }, { a: [40, -5], b: [40, 40], centerline: true }]) });
    await settled(page);
    await runCommand(frame, 'solid.revolve');
    await expect(panel(frame).locator('[data-pick-field="axis"]')).toHaveAttribute('data-active', '1');
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row]')).toHaveCount(0);
    await expect(panel(frame).locator('[data-run-reason], [data-incomplete-hint]').first()).toContainText('Pick an axis');
    // Click the centerline at x = 40 (on Front: model (40, 0, 20)).
    await clickAt(page, [40, 0, 20]);
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row]')).toHaveText(/Line of Sketch 1/);
    await settled(page);
    await expectVolume(frame, page, Math.PI * (900 - 400) * 30);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(featureRowNamed(frame, 'Revolve 1')).toHaveAttribute('data-state', 'ok');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-sweep: the path picked curve by curve in the view; the volume is pi r² times its length', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addRawSketch(page, { ...plane('top'), points: { c: [0, 0] }, entities: [{ id: 'k1', kind: 'circle', c: 'c', r: 5 }], constraints: [], solved: { values: {}, dof: 3, state: 'under' } });
    await addRawSketch(page, {
      ...plane('front'),
      points: { a: [0, 0], b: [0, 50], c: [20, 50], d: [20, 70], e: [50, 70] },
      entities: [
        { id: 'p1', kind: 'line', p: ['a', 'b'] },
        { id: 'p2', kind: 'arc', c: 'c', a: 'b', b: 'd', ccw: false },
        { id: 'p3', kind: 'line', p: ['d', 'e'] },
      ],
      constraints: [],
      solved: { values: {}, dof: 9, state: 'under' },
    });
    await settled(page);
    await runCommand(frame, 'solid.sweep');
    await expect(panel(frame).locator('[data-pick-field="profiles"] [data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-pick-field="path"]')).toHaveAttribute('data-active', '1');
    await clickAt(page, [0, 0, 30]);
    await expect(panel(frame).locator('[data-pick-field="path"] [data-pick-row]')).toHaveCount(1);
    // Each pick rebuilds the sweep, and a new body can refit the view: the next click waits for both
    // (real Chrome, P4a integration: the arc click landed while the view moved).
    await settled(page);
    const r = 20;
    await clickAt(page, [20 - r * Math.cos(Math.PI / 4), 0, 50 + r * Math.sin(Math.PI / 4)]);
    await expect(panel(frame).locator('[data-pick-field="path"] [data-pick-row]')).toHaveCount(2);
    await settled(page);
    await clickAt(page, [40, 0, 70]);
    await expect(panel(frame).locator('[data-pick-field="path"] [data-pick-row]')).toHaveText([/^Line 1 \(Sketch 2\)/, /^Arc 1 \(Sketch 2\)/, /^Line 2 \(Sketch 2\)/]);
    await settled(page);
    await expect(featureRowNamed(frame, 'Sweep 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, Math.PI * 25 * (50 + 10 * Math.PI + 30), 1e-4);
    await shot(page, 'p4a-sweep');
    // Taking the arc out leaves a gap. While the path is still being picked, it is not joined yet
    // (the field says so, nothing red in the foot: P4a review); with another field on, it is red, in words.
    await panel(frame).locator('[data-pick-field="path"] [data-pick-remove]').nth(1).click();
    await settled(page);
    await expect(panel(frame).locator('[data-pick-hint="path"]')).toHaveText('Not joined yet: click the curves between these, so the path runs end to end');
    await expect(foot(frame)).toHaveCount(0);
    await panel(frame).locator('[data-pick-list="profiles"]').click();
    await expect(foot(frame)).toHaveText('Sweep 1 failed: the path has a gap: its curves must join end to end in one chain');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-loft: a square on Top to a smaller square on a plane 30 mm up, picked in the view: the frustum', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addRawSketch(page, { ...plane('top'), ...rect(-10, -10, 10, 10) });
    // A reference plane 30 mm above Top (CONSTRUCT), and a sketch on it.
    const pl = await workspaceFrame(page).evaluate(() => {
      const s = (window as unknown as W).__CAD__.services;
      const p = s.doc.beginNew('ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '30 mm' });
      p.commit();
      return p.feature as string;
    });
    await settled(page);
    await addRawSketch(page, { support: { kind: 'feature', feature: pl }, plane: { origin: [0, 0, 30], normal: [0, 0, 1], xdir: [1, 0, 0] }, ...rect(-5, -5, 5, 5) });
    await settled(page);
    await runCommand(frame, 'solid.loft');
    await expect(panel(frame).locator('[data-feature-panel="loft"]')).toBeVisible();
    await clickAt(page, [-8, -8, 0]);
    await expect(panel(frame).locator('[data-pick-field="profiles"] [data-pick-row]')).toHaveCount(1);
    await clickAt(page, [3, 3, 30]);
    await expect(panel(frame).locator('[data-pick-field="profiles"] [data-pick-row]')).toHaveText([/^Profile 1 \(Sketch 1\)/, /^Profile 2 \(Sketch 2\)/]);
    await settled(page);
    await expect(featureRowNamed(frame, 'Loft 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, (30 / 3) * (400 + 100 + 200));
    await shot(page, 'p4a-loft');
    await panel(frame).locator('[data-panel-done]').click();
    // The Part left (Back) and opened again: the loft is there, built, with its profiles in order.
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 120_000 });
    const again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: 'Part 1' }) }));
    await expect(featureRowNamed(again, 'Loft 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(again, page, (30 / 3) * (400 + 100 + 200));
    await featureRowNamed(again, 'Loft 1').locator('> .tree-row').dblclick();
    await expect(panel(again).locator('[data-pick-field="profiles"] [data-pick-row]')).toHaveText([/^Profile 1 \(Sketch 1\)/, /^Profile 2 \(Sketch 2\)/]);
    await panel(again).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fillet: an edge picked in the view, its words; a radius too large is red with the edge and a radius that works, the block still shows', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [20, 20, 10] });
    await frame.locator('[data-cad-toolbar] [data-command="modify.fillet"]').click();
    await expect(panel(frame).locator('[data-feature-panel="fillet"]')).toBeVisible();
    // The top edge along X at y = 0 (z = 10).
    await clickAt(page, [10, 0, 10]);
    await expect(panel(frame).locator('[data-pick-field="edges"] [data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-pick-field="edges"] [data-pick-row] .cad-pick-name')).toHaveText(/^End · Side \d of Extrude 1$/);
    await settled(page);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, 4000 - (4 - Math.PI) * 20);
    const r = panel(frame).locator('.nui[data-field="radius"] input');
    await r.fill('20');
    await r.press('Enter');
    await settled(page);
    await expect(foot(frame)).toHaveText(/^Fillet 1 failed: a radius of 20 mm is too large for End · Side \d of Extrude 1: [\d.]+ mm or less works$/);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'error');
    await expectVolume(frame, page, 4000);
    const ok = /: ([\d.]+) mm or less works/.exec((await foot(frame).textContent()) ?? '')![1];
    await r.fill(ok);
    await r.press('Enter');
    await settled(page);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-chamfer-shell: Chamfer with two distances on a selected edge; Shell outside with the top face open', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page);
    // Select the top edge first, then Chamfer (select first, then act).
    await clickAt(page, [10, 0, 20]);
    await runCommand(frame, 'modify.chamfer');
    await expect(panel(frame).locator('[data-pick-field="edges"] [data-pick-row]')).toHaveCount(1);
    await panel(frame).locator('[data-field="mode"] select').selectOption('two');
    for (const [k, v] of [
      ['distance', '2'],
      ['distance2', '4'],
    ] as const) {
      const f = panel(frame).locator(`.nui[data-field="${k}"] input`);
      await f.fill(v);
      await f.press('Enter');
    }
    await settled(page);
    await expect(featureRowNamed(frame, 'Chamfer 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, 8000 - 80);
    // Flip sides (P4a review: untested): the 4 mm goes onto the other face. The top face 3 mm in from
    // the edge is the chamfer's on one side and the top's on the other: a click there says which.
    const pickedAt = async () => {
      await page.keyboard.press('Escape');
      await clickAt(page, [10, 3, 20]);
      const t = (await frame.locator('[data-chip="pick"] [data-pick-info]').textContent()) ?? '';
      await page.keyboard.press('Escape');
      return t;
    };
    await panel(frame).locator('[data-panel-done]').click();
    const unflipped = await pickedAt();
    await featureRowNamed(frame, 'Chamfer 1').locator('> .tree-row').dblclick();
    await panel(frame).locator('input[data-field="flip"]').click();
    await settled(page);
    await expectVolume(frame, page, 8000 - 80);
    await panel(frame).locator('[data-panel-done]').click();
    const flipped = await pickedAt();
    expect([unflipped, flipped].sort()).toEqual(['Face · Chamfer (Chamfer 1)', 'Face · End (Extrude 1)']);
    // Shell on a second block: its top face (z = 20) clicked in the panel, 2 mm outside.
    const second = await addSolid(page, { at: [40, 0, 0] });
    await runCommand(frame, 'modify.shell');
    await clickAt(page, [52, 12, 20]);
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
    await settled(page);
    await expectVolume(frame, page, 8000 - 16 * 16 * 18, 1e-6, second.body!);
    await panel(frame).locator('[data-field="direction"] select').selectOption('outside');
    await settled(page);
    await expect(featureRowNamed(frame, 'Shell 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, 24 * 24 * 22 - 8000, 1e-6, second.body!);
    await shot(page, 'p4a-shell');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-extrude-extents: a hole cut Through all (both sides); a post Up to the block\'s top face picked in the view', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    // The block from z = -10 to 10: the sketch plane (Top) cuts it in two halves.
    await addSolid(page, { at: [0, 0, -10], size: [20, 20, 20] });
    await addRawSketch(page, { ...plane('top'), points: { c: [10, 10] }, entities: [{ id: 'k1', kind: 'circle', c: 'c', r: 3 }], constraints: [], solved: { values: {}, dof: 3, state: 'under' } });
    await settled(page);
    await selectRow(frame, 'Sketch 2');
    await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
    await panel(frame).locator('[data-field="extent"] select').selectOption('through_all');
    await panel(frame).locator('[data-field="op"] select').selectOption('cut');
    await settled(page);
    // One side: through the upper half only (P4a review: Both sides was never proven).
    await expect(featureRowNamed(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, 8000 - Math.PI * 9 * 10);
    await panel(frame).locator('[data-switch="both"] .cad-switch-label').click();
    await expect(panel(frame).locator('[data-switch="both"] input')).toBeChecked();
    await settled(page);
    await expectVolume(frame, page, 8000 - Math.PI * 9 * 20);
    await panel(frame).locator('[data-panel-done]').click();

    // A 5 x 5 square beside the block, Up to its top face.
    await addRawSketch(page, { ...plane('top'), ...rect(40, 0, 45, 5) });
    await settled(page);
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Sketch 3');
    await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
    await panel(frame).locator('[data-field="extent"] select').selectOption('to');
    await expect(panel(frame).locator('[data-pick-field="target"]')).toHaveAttribute('data-active', '1');
    await expect(panel(frame).locator('[data-incomplete-hint], [data-run-reason]').first()).toContainText('Up to: pick a face or a vertex');
    await clickAt(page, [16, 16, 10]);
    await expect(panel(frame).locator('[data-pick-field="target"] [data-pick-row]')).toHaveText(/End face of Extrude 1/);
    await settled(page);
    await expect(featureRowNamed(frame, 'Extrude 3')).toHaveAttribute('data-state', 'ok');
    const post = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies.at(-1).id);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    // The post as the user reads it (P4a review: measured through the document): its row in the
    // tree selected, the chips say 5 x 5 x 10 (up to the top face at z = 10), 250 mm³.
    const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
    await frame.locator('[data-cad-tree] [data-body-row]').filter({ hasText: 'Body 2' }).locator('.tree-row').first().click();
    await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeBody 2 · 250 mm³');
    await expectSize(frame, [5, 5, 10]);
    await page.keyboard.press('Escape');
    await featureRowNamed(frame, 'Extrude 3').locator('> .tree-row').dblclick();
    const off = panel(frame).locator('.nui[data-field="offset"] input');
    await off.fill('5');
    await off.press('Enter');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    // Nothing picked: the chip lists each body, the post 5 mm past the top face.
    await expectVolume(frame, page, 25 * 15, 1e-6, post);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-extrude-face: a flat face selected, then Extrude: no sketch, joined, its row names the face', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page);
    await clickAt(page, [12, 12, 20]);
    await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
    await expect(panel(frame).locator('[data-profile="face"]')).toContainText('End face of Extrude 1');
    await expect(panel(frame).locator('[data-field="op"] select')).toHaveValue('join');
    const d = panel(frame).locator('.nui[data-field="distance"] input');
    await d.fill('10');
    await d.press('Enter');
    await settled(page);
    await expect(featureRowNamed(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, 20 * 20 * 30);
    await panel(frame).locator('[data-panel-done]').click();
    // The context menu offers it too, on a flat face (clicked once the view is still).
    await clickAt(page, [20, 10, 15], { button: 'right' });
    await expect(frame.locator('[role="menu"] [role="menuitem"]', { hasText: 'Extrude face' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(seen.errors).toEqual([]);
  });
  test('cad:p4a-bracket: plate, hole cut Through all, Fillet on three outer edges; width 60 -> 50 keeps the edge names in the panel; the fillet faces say so when clicked; 20 mm is red and the plate still shows', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    const plate = await workspaceFrame(page).evaluate(async () => {
      const s = (window as unknown as W).__CAD__.services;
      s.doc.addParam({ name: 'width', expr: '60 mm', quantity: 'length' });
      const handle = s.viewport.get().handle;
      const lookAt = handle.lookAt;
      handle.lookAt = () => {};
      const cs = [
        { id: 'c_h1', kind: 'horizontal', refs: ['e_1'] },
        { id: 'c_v2', kind: 'vertical', refs: ['e_2'] },
        { id: 'c_h3', kind: 'horizontal', refs: ['e_3'] },
        { id: 'c_v4', kind: 'vertical', refs: ['e_4'] },
        { id: 'c_o', kind: 'coincident', refs: ['pt_1', 'origin'] },
        { id: 'c_w', kind: 'distance', refs: ['e_1'], expr: 'width', driving: true },
        { id: 'c_d', kind: 'distance', refs: ['e_2'], expr: '40 mm', driving: true },
      ];
      const sk = s.doc.beginNew('sketch', {
        support: { kind: 'plane', plane: 'origin:top' },
        plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
        points: { pt_1: [0, 0], pt_2: [60, 0], pt_3: [60, 40], pt_4: [0, 40] },
        entities: [
          { id: 'e_1', kind: 'line', p: ['pt_1', 'pt_2'] },
          { id: 'e_2', kind: 'line', p: ['pt_2', 'pt_3'] },
          { id: 'e_3', kind: 'line', p: ['pt_3', 'pt_4'] },
          { id: 'e_4', kind: 'line', p: ['pt_4', 'pt_1'] },
        ],
        constraints: cs,
        solved: { values: { c_w: 60, c_d: 40 }, dof: 0, state: 'fully' },
      });
      sk.commit();
      handle.lookAt = lookAt;
      for (let i = 0; i < 400 && !s.doc.state.get().rebuild.outputs[sk.feature]?.regions?.length; i++) await new Promise((r) => setTimeout(r, 25));
      const g = s.doc.state.get().rebuild.outputs[sk.feature].regions[0];
      const ex = s.doc.beginNew('extrude', { profiles: [{ sketch: sk.feature, region: g.key, entities: g.entities, sample: g.sample }], extent: { kind: 'blind', distance: '20 mm' } });
      ex.commit();
      return sk.feature as string;
    });
    void plate;
    await settled(page);
    await addRawSketch(page, { ...plane('top'), ...rect(25, 15, 35, 25) });
    await settled(page);
    await selectRow(frame, 'Sketch 2');
    await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
    await panel(frame).locator('[data-field="extent"] select').selectOption('through_all');
    await panel(frame).locator('[data-switch="both"] .cad-switch-label').click();
    await panel(frame).locator('[data-field="op"] select').selectOption('cut');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    // Fillet the three outer vertical edges the view shows (the far corner is behind the plate).
    await frame.locator('[data-cad-toolbar] [data-command="modify.fillet"]').click();
    const edges: V3[] = [[0, 0, 10], [60, 0, 10], [0, 40, 10]];
    for (const e of edges) await clickAt(page, e);
    const rows = panel(frame).locator('[data-pick-field="edges"] [data-pick-row] .cad-pick-name');
    await expect(rows).toHaveCount(3);
    await settled(page);
    const words = await rows.allTextContents();
    for (const w of words) expect(w).toMatch(/^Side \d · Side \d of Extrude 1$/);
    const r = panel(frame).locator('.nui[data-field="radius"] input');
    await r.fill('4');
    await r.press('Enter');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    const vol = (w: number) => w * 40 * 20 - 10 * 10 * 20 - 3 * (1 - Math.PI / 4) * 16 * 20;
    await expectVolume(frame, page, vol(60));
    await shot(page, 'p4a-bracket-filleted');

    // The width parameter 60 -> 50: the plate shrinks, Fillet 1 stays on the same edges.
    await workspaceFrame(page).evaluate(() => {
      const d = (window as unknown as W).__CAD__.services.doc;
      const p = d.state.get().doc.params.find((x: { name: string }) => x.name === 'width');
      d.updateParam(p.id, { expr: '50 mm' });
    });
    await expectVolume(frame, page, vol(50));
    await settled(page);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
    await featureRowNamed(frame, 'Fillet 1').locator('> .tree-row').dblclick();
    await expect(panel(frame).locator('[data-feature-panel="fillet"]')).toBeVisible();
    await expect(rows).toHaveText(words);
    await panel(frame).locator('[data-panel-done]').click();

    // The middle of the near original edge (its ray runs into the plate in this view; the other corners' rays
    // leave it): the face there is Fillet 1's.
    await clickAt(page, [0, 0, 10]);
    await expect(frame.locator('[data-chip="pick"] [data-pick-info]')).toHaveText('Face · Fillet (Fillet 1)');
    await page.keyboard.press('Escape');

    // 20 mm: red with the reason, the plate (cut, not filleted) still shows.
    await featureRowNamed(frame, 'Fillet 1').locator('> .tree-row').dblclick();
    await r.fill('20');
    await r.press('Enter');
    await settled(page);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'error');
    await expect(foot(frame)).toHaveText(/^Fillet 1 failed: a radius of 20 mm is too large for .+: [\d.]+ mm or less works$/);
    await shot(page, 'p4a-bracket-fillet-failed');
    await panel(frame).locator('[data-panel-done]').click();
    await expectVolume(frame, page, 50 * 40 * 20 - 10 * 10 * 20);
    expect(seen.errors).toEqual([]);
  });
  test('cad:p4a-extrude-along: Along a slanted line clicked in the view: the square goes that way, its volume area x height', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addRawSketch(page, { ...plane('top'), ...rect(0, 0, 10, 10) });
    // A slanted construction line on Front from (30, 0) to (50, 20): model (30, 0, 0) to (50, 0, 20).
    await addRawSketch(page, { ...plane('front'), points: { a: [30, 0], b: [50, 20] }, entities: [{ id: 's1', kind: 'line', p: ['a', 'b'], construction: true }], constraints: [], solved: { values: {}, dof: 4, state: 'under' } });
    await settled(page);
    await selectRow(frame, 'Sketch 1');
    await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
    await expect(panel(frame).locator('[data-pick-field="direction"] [data-pick-empty]')).toHaveText('Normal to the profile');
    await panel(frame).locator('[data-pick-field="direction"] [data-pick-list]').click();
    await expect(panel(frame).locator('[data-pick-field="direction"]')).toHaveAttribute('data-active', '1');
    await clickAt(page, [40, 0, 10]);
    await expect(panel(frame).locator('[data-pick-field="direction"] [data-pick-row]')).toHaveText(/Line of Sketch 2/);
    const d = panel(frame).locator('.nui[data-field="distance"] input');
    await d.fill('20');
    await d.press('Enter');
    await settled(page);
    await expect(featureRowNamed(frame, 'Extrude 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, (100 * 20) / Math.SQRT2);
    await expect(frame.locator('[data-chip="size"]')).toHaveText(/24\.14\d* mm × 10 mm × 14\.14\d* mm/);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });
});
