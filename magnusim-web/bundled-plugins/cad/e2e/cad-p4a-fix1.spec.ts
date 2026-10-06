// P4a fix round 1: one test per blocker of the two P4a reviews (solids; CONSTRUCT, toolbar
// and chip), and the polish that has something to show, each as the user meets it: the
// toolbar, clicks in the view and on tree rows, values typed in panels, what the panel, the
// tree, the chips and the app's header say. Setup (sketches, blocks, reference planes) goes
// in through the document as the other specs do; volumes are checked against analytic
// values or native OCP 7.9.3 (the Sweep's Keep orientation: 5497.787 mm³, z to 70).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, drawBlock, drawRectangle, featureRowNamed, linkedGeometry, modelOnPage, newPartFromTree, newProject, okLinkReport, openPart, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, projectId };
}

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

/** A sketch put in through the document (setup), the camera left as it is; waits until it is built. Returns its id. */
async function addRawSketch(page: Page, init: Record<string, unknown>): Promise<string> {
  return cad<string>(page, (async (i: Record<string, unknown>) => {
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
  }) as never, init);
}

/** A reference plane offset from Top (setup through the document). Returns its id. */
async function addOffsetPlane(page: Page, mm: number): Promise<string> {
  const id = await cad<string>(page, ((d: number) => {
    const s = (window as unknown as W).__CAD__.services;
    const p = s.doc.beginNew('ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: `${d} mm` });
    p.commit();
    return p.feature as string;
  }) as never, mm);
  await settled(page);
  return id;
}

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      cad<boolean>(page, (() => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
      }) as never),
    )
    .toBe(true);
}

/** The view is still (twice, 150 ms apart, at the same spot for `p`), then a click there. */
async function clickAt(page: Page, p: V3, opts: { button?: 'left' | 'right' } = {}) {
  let last = '';
  await expect
    .poll(async () => {
      const moving = await cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never);
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

/** A click on empty view space (the right of the view, half way down). */
async function clickEmpty(page: Page) {
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.93, box.y + box.height * 0.5);
}

const plane = (p: 'top' | 'front') =>
  ({
    top: { support: { kind: 'plane', plane: 'origin:top' }, plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] } },
    front: { support: { kind: 'plane', plane: 'origin:front' }, plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] } },
  })[p];

/** A rectangle [x0,x1] x [y0,y1] as sketch entities. */
function rect(x0: number, y0: number, x1: number, y1: number) {
  return {
    points: { p1: [x0, y0], p2: [x1, y0], p3: [x1, y1], p4: [x0, y1] },
    entities: [
      { id: 'e1', kind: 'line', p: ['p1', 'p2'] },
      { id: 'e2', kind: 'line', p: ['p2', 'p3'] },
      { id: 'e3', kind: 'line', p: ['p3', 'p4'] },
      { id: 'e4', kind: 'line', p: ['p4', 'p1'] },
    ],
    constraints: [],
    solved: { values: {}, dof: 8, state: 'under' },
  };
}
const circle = (c: [number, number], r: number) => ({ points: { c }, entities: [{ id: 'k1', kind: 'circle', c: 'c', r }], constraints: [], solved: { values: {}, dof: 3, state: 'under' } });

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const foot = (frame: FrameLocator) => panel(frame).locator('[data-run-reason] .mgk-reason-msg');
const volumeChip = (frame: FrameLocator) => frame.locator('[data-chip="volume"]');
const sizeChip = (frame: FrameLocator) => frame.locator('[data-chip="size"]');

/** The volumes the chip lists (mm³), in its order. */
const chipVolumes = (frame: FrameLocator) => volumeChip(frame).locator('[data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

/** The chip's one volume, read until it is `v` within `rel` (one body listed). */
async function expectOneVolume(frame: FrameLocator, v: number, rel = 1e-6) {
  await expect
    .poll(async () => {
      const vs = await chipVolumes(frame);
      return vs.length === 1 ? Math.abs(vs[0] / v - 1) : 1;
    }, { timeout: 30_000 })
    .toBeLessThan(rel);
}

/** The size chip's numbers (mm), waiting for them to be `want` within 1e-6 mm. */
async function expectSize(frame: FrameLocator, want: number[]) {
  await expect
    .poll(async () => {
      const raw = (await sizeChip(frame).locator('[data-size-mm]').getAttribute('data-size-mm').catch(() => null)) ?? '';
      const got = raw.split(',').map(Number);
      return got.length === 3 && got.every((g, i) => Math.abs(g - want[i]) < 1e-6) ? 'ok' : raw;
    }, { timeout: 30_000 })
    .toBe('ok');
}

async function setField(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
}

/** A sketch's tree row clicked: it is selected (as a user selects one before a command). */
async function selectRow(frame: FrameLocator, name: string) {
  // An under-defined sketch's row reads "(-) Sketch 2".
  const row = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(?:[(]-[)] )?${name}$`) }) });
  await row.locator('> .tree-row').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
}

const back = async (page: Page) => {
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 120_000 });
};
const partRow = (page: Page) => page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: 'Part 1' }) });

// ------------------------------------------------------------------ SOLIDS blockers

test.describe('P4a fix 1: solids', () => {
  test('cad:p4a-fix-sweep-keep-orientation Keep orientation moves the profile without turning it (native OCP: pi r^2 x 70, 60 x 10 x 70), Follow path turns it; undo, redo and the panel reopened keep it', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { seen, frame } = await freshPart(page, request);
    await addRawSketch(page, { ...plane('top'), ...circle([0, 0], 5) });
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
    await expect(panel(frame).locator('[data-pick-field="path"]')).toHaveAttribute('data-active', '1');
    await clickAt(page, [0, 0, 30]);
    await settled(page);
    await clickAt(page, [20 - 20 * Math.cos(Math.PI / 4), 0, 50 + 20 * Math.sin(Math.PI / 4)]);
    await settled(page);
    await clickAt(page, [40, 0, 70]);
    await expect(panel(frame).locator('[data-pick-field="path"] [data-pick-row]')).toHaveCount(3);
    await settled(page);
    // Follow path: the profile turns with the path (pi r^2 times the path's length); the tube ends upright at x = 50.
    await expect(panel(frame).locator('[data-field="orientation"] select')).toHaveValue('follow');
    await expectOneVolume(frame, Math.PI * 25 * (50 + 10 * Math.PI + 30), 1e-4);
    await expectSize(frame, [55, 10, 75]);
    // Keep orientation: the disc stays flat, so the volume is pi r^2 times the rise (70) and the box ends at z = 70.
    await panel(frame).locator('[data-field="orientation"] select').selectOption('fixed');
    await settled(page);
    await expect(featureRowNamed(frame, 'Sweep 1')).toHaveAttribute('data-state', 'ok');
    await expectOneVolume(frame, Math.PI * 25 * 70);
    await expectSize(frame, [60, 10, 70]);
    await shot(page, 'p4a-fix-sweep-keep');
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    // Undo takes the sweep away, Redo brings it back as it was.
    await page.keyboard.press('Control+z');
    await expect(featureRowNamed(frame, 'Sweep 1')).toHaveCount(0);
    await expect(volumeChip(frame)).toHaveCount(0);
    await page.keyboard.press('Control+y');
    await expect(featureRowNamed(frame, 'Sweep 1')).toHaveAttribute('data-state', 'ok');
    await expectOneVolume(frame, Math.PI * 25 * 70);
    // Reopened: Keep orientation.
    await featureRowNamed(frame, 'Sweep 1').locator('> .tree-row').dblclick();
    await expect(panel(frame).locator('[data-field="orientation"] select')).toHaveValue('fixed');
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-fillet-then-chamfer Chamfer clicked while the Fillet panel shows its face opens empty; the part keeps the fillet only', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page);
    await runCommand(frame, 'modify.fillet');
    await clickAt(page, [10, 0, 20]);
    await expect(panel(frame).locator('[data-pick-field="edges"] [data-pick-row]')).toHaveCount(1);
    await setField(frame, 'radius', '3');
    await settled(page);
    const filleted = 8000 - (1 - Math.PI / 4) * 9 * 20;
    await expectOneVolume(frame, filleted);
    // Straight to Chamfer, the Fillet panel still open (it shows the fillet face it made).
    await runCommand(frame, 'modify.chamfer');
    await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Chamfer 1');
    await expect(panel(frame).locator('[data-pick-field="edges"] [data-pick-row]')).toHaveCount(0);
    await expect(panel(frame).locator('[data-incomplete-hint]')).toHaveText('Pick edges (or faces: all their edges) to chamfer');
    await settled(page);
    await expectOneVolume(frame, filleted);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
    await expect(featureRowNamed(frame, 'Chamfer 1')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(panel(frame)).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-origin-axes the Origin lists X, Y and Z axes; a row draws its axis; Revolve takes the Z axis clicked in the view', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    const rows = frame.locator('[data-cad-tree] [data-tree-node^="origin:"] .tl');
    await expect(rows).toHaveText(['Top plane', 'Front plane', 'Right plane', 'X axis', 'Y axis', 'Z axis']);
    // Its row selected: the axis is drawn and labelled in the view; nothing selected, it is not.
    await frame.locator('[data-cad-tree] [data-tree-node="origin:z"] > .tree-row').click();
    await expect(frame.locator('[data-construct-label="origin:z"]')).toHaveText('Z axis');
    await expect(frame.locator('[data-construct-label="origin:z"]')).toHaveAttribute('data-state', 'pick');
    await page.keyboard.press('Escape');
    // The pointer off the row, onto empty view space (inside the frame: real Chrome sends the row
    // no mouseleave when the pointer jumps straight out of the frame).
    const vb = (await page.locator('#workspace-frame').boundingBox())!;
    await page.mouse.move(vb.x + vb.width * 0.93, vb.y + vb.height * 0.5, { steps: 4 });
    await expect(frame.locator('[data-construct-label="origin:z"]')).toHaveCount(0);
    // A rectangle on Front beside the Z axis, no centerline: Revolve asks for an axis, and draws the origin's.
    await addRawSketch(page, { ...plane('front'), ...rect(10, 0, 20, 30) });
    await settled(page);
    await runCommand(frame, 'solid.revolve');
    await expect(panel(frame).locator('[data-pick-field="axis"]')).toHaveAttribute('data-active', '1');
    await expect(frame.locator('[data-construct-label^="origin:"]')).toHaveText(['X axis', 'Y axis', 'Z axis']);
    // An origin plane's row is not an axis: it says so.
    await frame.locator('[data-cad-tree] [data-tree-node="origin:top"] > .tree-row').click();
    await expect(panel(frame).locator('[data-pick-error="axis"]')).toContainText('That is a plane: pick an axis');
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row]')).toHaveCount(0);
    // The Z axis clicked in the view, above the profile.
    await clickAt(page, [0, 0, 40]);
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row] .cad-pick-name')).toHaveText('Z axis');
    await settled(page);
    await expect(featureRowNamed(frame, 'Revolve 1')).toHaveAttribute('data-state', 'ok');
    await expectOneVolume(frame, Math.PI * (400 - 100) * 30);
    await shot(page, 'p4a-fix-revolve-z-axis');
    await panel(frame).locator('[data-panel-done]').click();
    // The panel closed: the origin's axes are no longer drawn.
    await expect(frame.locator('[data-construct-label^="origin:"]')).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-origin-axes-along-construct Extrude "Along" an origin axis row; a Plane at an angle about the X axis clicked in the view', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    // A square off the X axis (the axis is then clicked where no edge lies on it).
    await addRawSketch(page, { ...plane('top'), ...rect(5, 5, 15, 15) });
    await settled(page);
    await selectRow(frame, 'Sketch 1');
    await runCommand(frame, 'solid.extrude');
    await panel(frame).locator('[data-pick-field="direction"] [data-pick-list]').click();
    await expect(panel(frame).locator('[data-pick-field="direction"]')).toHaveAttribute('data-active', '1');
    // The X axis lies in the profile's plane: taken, and the extrude says why it cannot go that way.
    await frame.locator('[data-cad-tree] [data-tree-node="origin:x"] > .tree-row').click();
    await expect(panel(frame).locator('[data-pick-field="direction"] [data-pick-row] .cad-pick-name')).toHaveText('X axis');
    await settled(page);
    await expect(foot(frame)).toContainText('the direction lies in the profile\'s plane');
    // The Z axis: up, 10 high.
    await panel(frame).locator('[data-pick-field="direction"] [data-pick-list]').click();
    await frame.locator('[data-cad-tree] [data-tree-node="origin:z"] > .tree-row').click();
    await expect(panel(frame).locator('[data-pick-field="direction"] [data-pick-row] .cad-pick-name')).toHaveText('Z axis');
    await settled(page);
    await expect(featureRowNamed(frame, 'Extrude 1')).toHaveAttribute('data-state', 'ok');
    await expectOneVolume(frame, 100 * 10);
    await panel(frame).locator('[data-panel-done]').click();

    // CONSTRUCT: a Plane at 30° to Top about the X axis, the axis clicked in the view.
    await page.keyboard.press('Escape');
    await frame.locator('[data-cad-tree] [data-tree-node="origin:top"] > .tree-row').click();
    await runCommand(frame, 'construct.plane');
    await panel(frame).locator('[data-field="method"] select').selectOption('angle');
    await panel(frame).locator('[data-pick-list="axis"]').click();
    await expect(panel(frame).locator('[data-pick-field="axis"]')).toHaveAttribute('data-active', '1');
    await expect(frame.locator('[data-construct-label="origin:x"]')).toHaveText('X axis');
    await page.mouse.move(5, 5);
    // The X axis, drawn from the origin across the block, clicked in front of the block (5 mm before its face).
    await clickAt(page, [13, 0, 0]);
    await expect(panel(frame).locator('[data-pick-list="axis"] [data-pick-row] .cad-pick-name')).toHaveText('X axis');
    await setField(frame, 'angle', '30');
    await settled(page);
    await expect(featureRowNamed(frame, 'Plane 1')).toHaveAttribute('data-state', 'ok');
    const n = await cad<number[]>(page, (() => {
      const s = (window as unknown as W).__CAD__.services.doc.state.get();
      const f = s.doc.features.find((x: { name: string }) => x.name === 'Plane 1');
      return s.rebuild.outputs[f.id].frame.normal;
    }) as never);
    expect(Math.abs(n[0])).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(n[1]) - 0.5)).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(n[2]) - Math.sqrt(3) / 2)).toBeLessThan(1e-9);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-through-all-new-join Through all as a New body ends at the block\'s far faces (no made-up length), as a Join adds nothing past them, and a profile that misses the block is red with the reason', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { at: [0, 0, 0], size: [20, 20, 20] });
    await addRawSketch(page, { ...plane('top'), ...circle([10, 10], 3) });
    await settled(page);
    await selectRow(frame, 'Sketch 2');
    await runCommand(frame, 'solid.extrude');
    await panel(frame).locator('[data-field="extent"] select').selectOption('through_all');
    await panel(frame).locator('[data-switch="both"] .cad-switch-label').click();
    await settled(page);
    await expect(featureRowNamed(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok');
    await expect(panel(frame).locator('[data-field="op"] select')).toHaveValue('new');
    await panel(frame).locator('[data-panel-done]').click();
    // The new body alone (its row in the tree): the block's height exactly, and pi r^2 x 20.
    const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
    await frame.locator('[data-cad-tree] [data-body-row]').filter({ hasText: 'Body 2' }).locator('.tree-row').first().click();
    await expectOneVolume(frame, Math.PI * 9 * 20);
    await expectSize(frame, [6, 6, 20]);
    // As a Join: nothing past the block (its box stays 20 high), the volume the block's.
    await featureRowNamed(frame, 'Extrude 2').locator('> .tree-row').dblclick();
    await panel(frame).locator('[data-field="op"] select').selectOption('join');
    await settled(page);
    await expect(featureRowNamed(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok');
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    await expectOneVolume(frame, 8000);
    await expectSize(frame, [20, 20, 20]);
    // A circle beside the block, Through all as a New body: nothing to go through.
    await addRawSketch(page, { ...plane('top'), ...circle([50, 50], 3) });
    await settled(page);
    await selectRow(frame, 'Sketch 3');
    await runCommand(frame, 'solid.extrude');
    await panel(frame).locator('[data-field="extent"] select').selectOption('through_all');
    await settled(page);
    await expect(foot(frame)).toHaveText('Extrude 3 failed: Through all: the profile misses every body: there is nothing to go through (move the profile over a body)');
    await expect(featureRowNamed(frame, 'Extrude 3')).toHaveAttribute('data-state', 'error');
    await page.keyboard.press('Escape');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-loft-reorder profiles picked out of order are moved with the arrows; Ruled gives the straight-sided volume; a profile inside the loft is picked through it', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { seen, frame } = await freshPart(page, request);
    await addRawSketch(page, { ...plane('top'), ...rect(-10, -10, 10, 10) });
    const mid = await addOffsetPlane(page, 15);
    const top = await addOffsetPlane(page, 30);
    await addRawSketch(page, { support: { kind: 'feature', feature: mid }, plane: { origin: [0, 0, 15], normal: [0, 0, 1], xdir: [1, 0, 0] }, ...rect(-5, -5, 5, 5) });
    await addRawSketch(page, { support: { kind: 'feature', feature: top }, plane: { origin: [0, 0, 30], normal: [0, 0, 1], xdir: [1, 0, 0] }, ...rect(-10, -10, 10, 10) });
    await settled(page);
    await runCommand(frame, 'solid.loft');
    // Bottom, top, then the waist: the waist goes last.
    await clickAt(page, [-8, -8, 0]);
    await clickAt(page, [8, 8, 30]);
    await settled(page);
    await clickAt(page, [3, 3, 15]);
    const rows = panel(frame).locator('[data-pick-field="profiles"] [data-pick-row] .cad-pick-name');
    await expect(rows).toHaveText([/^Profile 1 \(Sketch 1\)$/, /^Profile 2 \(Sketch 3\)$/, /^Profile 3 \(Sketch 2\)$/]);
    // Profile 3 (the waist) up one: bottom, waist, top.
    await panel(frame).locator('[data-pick-field="profiles"] [data-pick-row]').nth(2).locator('[data-pick-move="up"]').click();
    await expect(rows).toHaveText([/^Profile 1 \(Sketch 1\)$/, /^Profile 2 \(Sketch 2\)$/, /^Profile 3 \(Sketch 3\)$/]);
    // Ruled: two frustums, h/3 (A1 + A2 + sqrt(A1 A2)) each.
    await panel(frame).locator('input[data-field="ruled"]').click();
    await settled(page);
    await expect(featureRowNamed(frame, 'Loft 1')).toHaveAttribute('data-state', 'ok');
    await expectOneVolume(frame, 2 * (15 / 3) * (400 + 100 + 200));
    // Not ruled: smooth sides, another volume.
    await panel(frame).locator('input[data-field="ruled"]').click();
    await settled(page);
    await expect.poll(async () => Math.abs((await chipVolumes(frame))[0] / 7000 - 1)).toBeGreaterThan(1e-3);
    await shot(page, 'p4a-fix-loft-hourglass');
    // The waist, inside the loft's own body now, clicked through it: taken out (a prism of 20 x 20 x 30).
    await clickAt(page, [3, 3, 15]);
    await expect(rows).toHaveText([/^Profile 1 \(Sketch 1\)$/, /^Profile 2 \(Sketch 3\)$/]);
    await settled(page);
    await expectOneVolume(frame, 400 * 30);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-flip-advice with Flip direction ticked, a refusal says to untick it (Through all, Up to)', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { at: [0, 0, 0], size: [20, 20, 20] });
    await addRawSketch(page, { ...plane('top'), ...circle([10, 10], 3) });
    await settled(page);
    await selectRow(frame, 'Sketch 2');
    await runCommand(frame, 'solid.extrude');
    await panel(frame).locator('[data-field="extent"] select').selectOption('through_all');
    await panel(frame).locator('[data-field="op"] select').selectOption('cut');
    await settled(page);
    // Cut picked Flip off (up into the block); ticked, it points away: untick it.
    const flip = panel(frame).locator('input[data-field="flip"]');
    if (await flip.isChecked()) await panel(frame).locator('input[data-field="flip"]').click();
    await settled(page);
    await expect(featureRowNamed(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok');
    await panel(frame).locator('input[data-field="flip"]').click();
    await expect(flip).toBeChecked();
    await settled(page);
    await expect(foot(frame)).toHaveText('Extrude 2 failed: Through all: there is nothing to go through in this direction (untick Flip direction or tick Both sides)');
    // Up to the block's top face, Flip ticked: the face is behind.
    await panel(frame).locator('[data-field="extent"] select').selectOption('to');
    await panel(frame).locator('[data-field="op"] select').selectOption('new');
    await clickAt(page, [16, 16, 20]);
    await expect(panel(frame).locator('[data-pick-field="target"] [data-pick-row]')).toHaveText(/End face of Extrude 1/);
    if (!(await flip.isChecked())) await panel(frame).locator('input[data-field="flip"]').click();
    await settled(page);
    await expect(foot(frame)).toHaveText('Extrude 2 failed: Up to: the face is behind the profile (untick Flip direction)');
    await page.keyboard.press('Escape');
    expect(seen.errors).toEqual([]);
  });
});

// ------------------------------------------------------------------ CONSTRUCT, chip blockers

test.describe('P4a fix 1: construct and chip', () => {
  test('cad:p4a-fix-vertex-after-undo a corner is still picked in the view after an edit and its Undo', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [40, 30, 20] });
    // The block 30 high, then Undo: 20 high again.
    await featureRowNamed(frame, 'Extrude 1').locator('> .tree-row').dblclick();
    await setField(frame, 'distance', '30');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Control+z');
    await settled(page);
    await expectSize(frame, [40, 30, 20]);
    // A Point at a vertex: the corner (40, 0, 20) clicked.
    await clickEmpty(page);
    await runCommand(frame, 'construct.point');
    await expect(panel(frame).locator('[data-field="method"] select')).toHaveValue('vertex');
    await page.mouse.move(5, 5);
    await clickAt(page, [40, 0, 20]);
    await expect(panel(frame).locator('[data-pick-list="vertex"] [data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-construct-readout]')).toHaveText('Built: at 40, 0, 20 mm');
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-construct-words pick rows of a drawn block say "Side 2 of Extrude 1", "Corner of End, Side 1 and Side 2", and a sketch corner by its lines, never an internal id', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { seen, frame } = await freshPart(page, request);
    // Drawn as a user draws it: the sketch's ids are generated (e_6cctu2upm20i ...), not e_1.
    await drawBlock(page, frame, 40, 30, 20);
    await page.mouse.move(5, 5);
    const seenRows: string[] = [];
    const rowsOf = async () => seenRows.push(...(await panel(frame).locator('[data-pick-row] .cad-pick-name').allTextContents()));
    // A Plane offset from the front side face.
    await clickEmpty(page);
    await runCommand(frame, 'construct.plane');
    await clickAt(page, [20, 0, 10]);
    await expect(panel(frame).locator('[data-pick-list="plane"] [data-pick-row] .cad-pick-name')).toHaveText(/^Side \d of Extrude 1$/);
    await rowsOf();
    await panel(frame).locator('[data-panel-done]').click();
    // A Point at a corner of the block.
    await clickEmpty(page);
    await runCommand(frame, 'construct.point');
    await page.mouse.move(5, 5);
    await clickAt(page, [40, 0, 20]);
    await expect(panel(frame).locator('[data-pick-list="vertex"] [data-pick-row] .cad-pick-name')).toHaveText(/^Corner of (End|Side \d), (End|Side \d) and (End|Side \d) of Extrude 1$/);
    await rowsOf();
    // Through 3 points of the sketch: a corner of its rectangle says which lines meet there.
    await panel(frame).locator('[data-field="method"] select').selectOption('vertex');
    await page.keyboard.press('Escape');
    await featureRowNamed(frame, 'Sketch 1').locator('[data-sketch-act="visibility"]').click();
    await clickEmpty(page);
    await frame.locator('[data-cad-tree] [data-tree-node="origin:top"] > .tree-row').click();
    await runCommand(frame, 'construct.plane');
    await panel(frame).locator('[data-field="method"] select').selectOption('three_points');
    await page.mouse.move(5, 5);
    await clickAt(page, [0, 0, 0]);
    await expect(panel(frame).locator('[data-pick-list="points"] [data-pick-row] .cad-pick-name').first()).toHaveText(/^(Corner of Line \d and Line \d|Sketch origin|Corner of (End|Start|Side \d).*) of (Sketch 1|Extrude 1)$/);
    await rowsOf();
    await page.keyboard.press('Escape');
    expect(seenRows.length).toBeGreaterThanOrEqual(3);
    for (const t of seenRows) expect(t).not.toMatch(/(e|pt|p)_[0-9a-z]+|Side · |Side and |Point of Sketch/);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-chip-tree-1280 at 1280 x 800 with four bodies the tree ends above the volume chip, and the rollback bar can still be dragged', async ({ page, request }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const { seen, frame } = await freshPart(page, request);
    for (let i = 0; i < 4; i++) await addSolid(page, { at: [i * 30, 0, 0], size: [20, 20, 10 + i] });
    await page.keyboard.press('Escape');
    await expect(volumeChip(frame).locator('[data-volume-entry]')).toHaveCount(4);
    // Every Bodies row open: the tree is as tall as it gets.
    const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
    const dock = await frame.locator('[data-cad-dock]').boundingBox();
    const stack = await frame.locator('[data-cad-left-stack]').boundingBox();
    expect(stack!.y + stack!.height).toBeLessThanOrEqual(dock!.y + 0.5);
    await shot(page, 'p4a-fix-chip-tree-1280');
    // The rollback bar (scrolled into the card) dragged up above Extrude 4: it is rolled back.
    const bar = frame.locator('[data-cad-tree] [data-rollback-bar]');
    await bar.scrollIntoViewIfNeeded();
    const from = (await bar.boundingBox())!;
    const target = (await featureRowNamed(frame, 'Extrude 4').locator('> .tree-row').boundingBox())!;
    const dockNow = (await frame.locator('[data-cad-dock]').boundingBox())!;
    // Nothing of the dock over the bar.
    expect(from.y + from.height).toBeLessThanOrEqual(dockNow.y + 0.5);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, target.y + 2, { steps: 8 });
    await page.mouse.up();
    await expect(featureRowNamed(frame, 'Extrude 4')).toHaveAttribute('data-rolled-back', '1');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-plane-edit-click-through editing a Plane drawn over a face, a click there picks the face, not the plane being edited', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [40, 30, 20] });
    // Plane 1: 30 mm over Top, drawn over the block's top face as seen from above.
    await frame.locator('[data-cad-tree] [data-tree-node="origin:top"] > .tree-row').click();
    await runCommand(frame, 'construct.plane');
    await setField(frame, 'distance', '30');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    // Reopened: its plane field active, the block's top face clicked where Plane 1 is drawn over it.
    await featureRowNamed(frame, 'Plane 1').locator('> .tree-row').dblclick();
    await panel(frame).locator('[data-pick-list="plane"]').click();
    await expect(panel(frame).locator('[data-pick-field="plane"]')).toHaveAttribute('data-active', '1');
    await page.mouse.move(5, 5);
    await clickAt(page, [20, 15, 20]);
    await expect(panel(frame).locator('[data-pick-error="plane"]')).toHaveCount(0);
    await expect(panel(frame).locator('[data-pick-list="plane"] [data-pick-row] .cad-pick-name')).toHaveText('End face of Extrude 1');
    await expect(panel(frame).locator('[data-construct-readout]')).toHaveText('Built: through 0, 0, 50 mm, normal 0, 0, 1');
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-broken-reference-leave a broken Axis nothing uses does not stop the update: the header says so as the project lands; one that a feature uses still stops it', async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [20, 20, 10] });
    await addOffsetPlane(page, 10);
    // Axis 1 where Top and Plane 1 cross: they are parallel, so it is broken.
    await page.keyboard.press('Escape');
    await runCommand(frame, 'construct.axis');
    await panel(frame).locator('[data-field="method"] select').selectOption('two_planes');
    await frame.locator('[data-cad-tree] [data-tree-node="origin:top"] > .tree-row').click();
    await featureRowNamed(frame, 'Plane 1').locator('> .tree-row').click();
    await settled(page);
    await expect(featureRowNamed(frame, 'Axis 1')).toHaveAttribute('data-state', 'error');
    await panel(frame).locator('[data-panel-done]').click();
    // Back: the header says the axis is left out (before the export: the app's header then shows
    // the link's own stages), and the project is updated.
    await page.evaluate(() => {
      const w = window as unknown as { __leaveSeen: string[] };
      w.__leaveSeen = [];
      new MutationObserver(() => {
        const t = document.querySelector('[data-ws-leave-status]')?.textContent ?? '';
        if (t && !w.__leaveSeen.includes(t)) w.__leaveSeen.push(t);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await back(page);
    expect(await page.evaluate(() => (window as unknown as { __leaveSeen: string[] }).__leaveSeen)).toContain('Axis 1 is broken (not used by anything). Part 1 is updated without it.');
    await expect(page.locator('#modal-confirm #cf-heading')).not.toHaveText("Couldn't update the project");
    await okLinkReport(page);
    const again = await openPart(page, partRow(page));
    const linked = await linkedGeometry(page);
    expect(linked, 'the project has the Part').not.toBeNull();
    expect(linked!.sourceVersion).toBe(await cad<number>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().sourceVersion) as never));
    // A sketch on a plane… no: an Extrude "Along" the broken axis uses it, and fails with it: the update stops.
    await addRawSketch(page, { ...plane('top'), ...rect(30, 0, 40, 10) });
    await settled(page);
    await selectRow(again, 'Sketch 2');
    await runCommand(again, 'solid.extrude');
    await panel(again).locator('[data-pick-field="direction"] [data-pick-list]').click();
    await featureRowNamed(again, 'Axis 1').locator('> .tree-row').click();
    await settled(page);
    await expect(featureRowNamed(again, 'Extrude 2')).toHaveAttribute('data-state', 'error');
    await panel(again).locator('[data-panel-done]').click();
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#cf-heading')).toHaveText("Couldn't update the project");
    await expect(page.locator('#cf-copy')).toContainText('Axis 1 and Extrude 2 failed to build');
    await page.locator('#cf-cancel').click();
    await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    expect(seen.errors).toEqual([]);
  });
});

// ------------------------------------------------------------------ polish with something to show

test.describe('P4a fix 1: polish', () => {
  test('cad:p4a-fix-shell-words Shell rows say which face ("End face of Extrude 1"); a face picked on an Outside shell is found as it is after an edit (no "Reference repaired")', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page);
    await runCommand(frame, 'modify.shell');
    await clickAt(page, [12, 12, 20]);
    const rows = panel(frame).locator('[data-pick-field="faces"] [data-pick-row] .cad-pick-name');
    await expect(rows).toHaveText(['End face of Extrude 1']);
    await panel(frame).locator('[data-field="direction"] select').selectOption('outside');
    await settled(page);
    // The back side, inside the cup now (seen through the opening), picked on the live result: a second opening.
    await clickAt(page, [10, 20, 16]);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toHaveText(/^Side \d of Extrude 1$/);
    await settled(page);
    await expect(featureRowNamed(frame, 'Shell 1')).toHaveAttribute('data-state', 'ok');
    await panel(frame).locator('[data-panel-done]').click();
    // The block 30 high: the shell is found on it as it is.
    await featureRowNamed(frame, 'Extrude 1').locator('> .tree-row').dblclick();
    await setField(frame, 'distance', '30');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(featureRowNamed(frame, 'Shell 1')).toHaveAttribute('data-state', 'ok');
    await expect(featureRowNamed(frame, 'Shell 1').locator('[data-feature-badge]')).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-chamfer-words a too-large chamfer says what works; Distance 1 says which face it is on; the Fillet hint goes with its last edge', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page);
    await clickAt(page, [10, 0, 20]);
    await runCommand(frame, 'modify.chamfer');
    await panel(frame).locator('[data-field="mode"] select').selectOption('two');
    await setField(frame, 'distance', '2');
    await setField(frame, 'distance2', '4');
    await settled(page);
    const where = panel(frame).locator('[data-distance1-on]');
    await expect(where).toHaveText(/^Distance 1 is on (End face|Side \d) of Extrude 1; Flip sides puts it on the other face\.$/);
    const before = await where.textContent();
    await panel(frame).locator('input[data-field="flip"]').click();
    await settled(page);
    await expect(where).not.toHaveText(before!);
    await setField(frame, 'distance', '25');
    await settled(page);
    await expect(foot(frame)).toHaveText(/^Chamfer 1 failed: distances of 25 mm and 4 mm are too large for .+: [\d.]+ mm and [\d.]+ mm or less work$/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // Fillet on a slot (its top edge is a tangent chain of 2 lines and 2 arcs): "Rounds 4 edges"
    // while the edge is picked; nothing once it is taken out.
    await addRawSketch(page, {
      ...plane('top'),
      points: { a: [40, -10], b: [60, -10], c: [60, 10], d: [40, 10], o1: [60, 0], o2: [40, 0] },
      entities: [
        { id: 'l1', kind: 'line', p: ['a', 'b'] },
        { id: 'a1', kind: 'arc', c: 'o1', a: 'b', b: 'c', ccw: true },
        { id: 'l2', kind: 'line', p: ['c', 'd'] },
        { id: 'a2', kind: 'arc', c: 'o2', a: 'd', b: 'a', ccw: true },
      ],
      constraints: [],
      solved: { values: {}, dof: 12, state: 'under' },
    });
    await settled(page);
    await selectRow(frame, 'Sketch 2');
    await runCommand(frame, 'solid.extrude');
    await setField(frame, 'distance', '10');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    await runCommand(frame, 'modify.fillet');
    await clickAt(page, [50, -10, 10]);
    await settled(page);
    await expect(panel(frame).locator('[data-chain]')).toContainText('Rounds 4 edges');
    await panel(frame).locator('[data-pick-field="edges"] [data-pick-remove]').first().click();
    await settled(page);
    await expect(panel(frame).locator('[data-chain]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-misc-words a curved face then Extrude says it once; a click on nothing in a pick field says so; the view menu puts CONSTRUCT actions first and Delete last; an Axis of a cylinder points up', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { circle: true, at: [0, 0, 0], size: [20, 30] });
    await page.mouse.move(5, 5);
    // The cylinder's side face selected, then Extrude.
    await clickAt(page, [0, -10, 15]);
    await runCommand(frame, 'solid.extrude');
    await expect(page.locator('#workspace-overlay [data-ws-toast]').last()).toHaveText(/^Extrude: the selected face is curved; pick a flat face or a sketch profile/);
    await page.keyboard.press('Escape');
    // Axis of the round face: up, 0, 0, 1; its method's words fit the select.
    await clickAt(page, [0, -10, 15]);
    await runCommand(frame, 'construct.axis');
    await expect(panel(frame).locator('[data-field="method"] select')).toHaveValue('cylinder');
    await expect(panel(frame).locator('[data-construct-readout]')).toHaveText(/direction 0, 0, 1$/);
    const fits = await panel(frame).locator('[data-field="method"] select').evaluate((el: HTMLSelectElement) => {
      const span = document.createElement('span');
      const cs = getComputedStyle(el);
      span.style.font = cs.font;
      span.style.position = 'absolute';
      span.style.whiteSpace = 'nowrap';
      span.textContent = el.options[el.selectedIndex].text;
      document.body.appendChild(span);
      const w = span.getBoundingClientRect().width;
      span.remove();
      return w + parseFloat(cs.paddingLeft) + 16 <= el.clientWidth;
    });
    expect(fits, 'the method fits its select').toBe(true);
    await panel(frame).locator('[data-panel-done]').click();
    // A Point's vertex field: a click on empty space says what to click.
    await page.keyboard.press('Escape');
    await runCommand(frame, 'construct.point');
    await clickEmpty(page);
    await expect(panel(frame).locator('[data-pick-error="vertex"]')).toHaveText('Nothing to pick there: click a vertex, a point or a point of a sketch');
    await page.keyboard.press('Escape');
    // A Plane on Top, 40 up; the view's menu on it: Sketch on Plane 1 before Edit, Delete last.
    await frame.locator('[data-cad-tree] [data-tree-node="origin:top"] > .tree-row').click();
    await runCommand(frame, 'construct.plane');
    await setField(frame, 'distance', '40');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    await page.mouse.move(5, 5);
    await clickAt(page, [-8, -8, 40], { button: 'right' });
    const items = await frame.locator('[data-cad-menu] [role="menuitem"]').allTextContents();
    const at = (re: RegExp) => items.findIndex((t) => re.test(t));
    expect(at(/^Sketch on Plane 1/)).toBeGreaterThanOrEqual(0);
    expect(at(/^Sketch on Plane 1/)).toBeLessThan(at(/^Edit Plane 1|^Edit/));
    expect(items[items.length - 1]).toMatch(/^Delete Plane 1/);
    await page.keyboard.press('Escape');
    // A second plane 2 mm above: the labels never touch (8 px apart at least) and never sit on a body.
    await addOffsetPlane(page, 42);
    await page.mouse.move(5, 5);
    // Axis 1, Plane 1 and Plane 2.
    await expect(frame.locator('[data-construct-label]')).toHaveCount(3);
    await expect
      .poll(async () => {
        const r = await cad<{ boxes: number[][]; onBody: boolean }>(page, (() => {
          const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
          const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-construct-label]')).filter((l) => l.style.display !== 'none').map((l) => {
            const b = l.getBoundingClientRect();
            return [b.left, b.top, b.right, b.bottom];
          });
          const onBody = boxes.some(([l, t, r, b]) => [[l + 1, t + 1], [r - 1, t + 1], [l + 1, b - 1], [r - 1, b - 1], [(l + r) / 2, (t + b) / 2]].some(([x, y]) => h.pick(x, y)?.item.kind === 'face'));
          return { boxes, onBody };
        }) as never);
        if (r.onBody) return 'a label on a body';
        for (let i = 0; i < r.boxes.length; i++)
          for (let j = i + 1; j < r.boxes.length; j++) {
            const [a, b] = [r.boxes[i], r.boxes[j]];
            const gap = Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);
            if (gap < 8) return `labels ${gap.toFixed(1)} px apart`;
          }
        return 'ok';
      })
      .toBe('ok');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-first-sketch-refit a first sketch drawn past the edges of the view is framed when it is finished', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await drawRectangle(page, frame, 600, 400);
    // The framing comes once sketch mode has ended and the view is still: every corner on screen.
    const box = (await page.locator('#workspace-frame').boundingBox())!;
    const offScreen = async () => {
      const moving = await cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().animating) as never);
      if (moving) return 'moving';
      const out: string[] = [];
      for (const c of [[0, 0, 0], [600, 0, 0], [600, 400, 0], [0, 400, 0]] as V3[]) {
        const [x, y] = await modelOnPage(page, c);
        if (x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height) out.push(c.join(','));
      }
      return out.join(' ') || 'all on screen';
    };
    await expect.poll(offScreen, { timeout: 10_000 }).toBe('all on screen');
    // And it stays (no later move takes it off).
    await page.waitForTimeout(500);
    expect(await offScreen()).toBe('all on screen');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4a-fix-chip-cfd-first with more bodies than the chip lists, the Enclosure is one of those shown', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { seen, frame } = await freshPart(page, request);
    for (let i = 0; i < 4; i++) await addSolid(page, { at: [i * 30, 0, 0], size: [20, 20, 20] });
    await runCommand(frame, 'cfd.enclosure');
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    await expect(volumeChip(frame).locator('[data-volume-entry]')).toHaveCount(4);
    await expect(volumeChip(frame).locator('[data-volume-more]')).toHaveText(' · + 1 more');
    await expect(volumeChip(frame)).toContainText('Enclosure 1: ');
    expect(seen.errors).toEqual([]);
  });
});
