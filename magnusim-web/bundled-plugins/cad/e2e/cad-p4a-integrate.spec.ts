// P4a integration gaps, as the user meets them in the real host frame with the
// real kernel:
//   - Extrude "Along" takes CONSTRUCT geometry: a Plane (its normal) picked by its
//     tree row, an Axis clicked where the view draws it, an origin plane's tree row;
//     the square goes that way (volume = area x distance x cos of the tilt);
//   - sketch points are point inputs: a Plane "Through 3 points" from three
//     corners of a triangle sketched on Front, clicked in the view, is the Front
//     plane, and keeps them when opened again.
// Setup (sketches, CONSTRUCT features) goes in through the document as the other
// P4a specs do; window.__CAD__ is used only for that, to project model points,
// and to read exact figures.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, singleVolume, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

const SHOTS = process.env.CAD_E2E_SHOTS || '';
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** A feature put in through the document (setup), the camera left as it is; waits until it is built. Returns its id. */
async function addRaw(page: Page, type: string, init: Record<string, unknown>): Promise<string> {
  return workspaceFrame(page).evaluate(
    async ({ t, i }) => {
      const s = (window as unknown as W).__CAD__.services;
      const handle = s.viewport.get().handle;
      const lookAt = handle?.lookAt;
      if (handle) handle.lookAt = () => {};
      let id: string;
      try {
        const sk = s.doc.beginNew(t, i);
        sk.commit();
        id = sk.feature;
      } finally {
        if (handle && lookAt) handle.lookAt = lookAt;
      }
      for (let k = 0; k < 400; k++) {
        const st = s.doc.state.get().rebuild;
        if (st.status === 'done' && st.features[id] && st.features[id].state !== 'pending') return id;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`${t} did not build`);
    },
    { t: type, i: init },
  );
}

const TOP = { support: { kind: 'plane', plane: 'origin:top' }, plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] } };
const FRONT = { support: { kind: 'plane', plane: 'origin:front' }, plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] } };

/** Closed polygon sketch entities through these points (uv on the sketch plane). */
function polygon(pts: [number, number][]) {
  const points: Record<string, [number, number]> = {};
  const entities: Record<string, unknown>[] = [];
  pts.forEach((p, i) => (points[`p${i + 1}`] = p));
  pts.forEach((_p, i) => entities.push({ id: `e${i + 1}`, kind: 'line', p: [`p${i + 1}`, `p${((i + 1) % pts.length) + 1}`] }));
  return { points, entities, constraints: [], solved: { values: {}, dof: 2 * pts.length, state: 'under' } };
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(\\(.\\) )?${esc(name)}$`) }) });

async function still(page: Page) {
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
}

async function clickAt(page: Page, p: V3) {
  await still(page);
  const [x, y] = await modelOnPage(page, p);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

async function expectVolume(frame: FrameLocator, mm3: number, rel = 1e-6) {
  await expect.poll(async () => Math.abs((await singleVolume(frame)) / mm3 - 1), { timeout: 30_000, message: `volume ${mm3} mm³` }).toBeLessThan(rel);
}

test('cad:p4a-along-construct Extrude Along a CONSTRUCT plane (its tree row: along its normal), a CONSTRUCT axis clicked in the view, and an origin plane\'s row', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 10 x 10 square on Top; Plane 1 = Top turned 45° about X; Point 1 at (0, -20, 20) and Axis 1
  // from the origin through it (the same tilt, 45° from Z).
  const sq = await addRaw(page, 'sketch', { ...TOP, ...polygon([[0, 0], [10, 0], [10, 10], [0, 10]]) });
  await addRaw(page, 'ref_plane', { method: 'angle', plane: { kind: 'origin', plane: 'origin:top' }, axis: { kind: 'origin', axis: 'origin:x' }, angle: '45 deg' });
  const pt = await addRaw(page, 'ref_point', { method: 'coordinates', xyz: ['0 mm', '-20 mm', '20 mm'] });
  await addRaw(page, 'ref_axis', { method: 'two_points', points: [{ kind: 'origin', point: 'origin:point' }, { kind: 'feature', feature: pt }] });
  await expect(featureRow(frame, 'Axis 1')).toHaveAttribute('data-state', 'ok');

  // The square selected (its tree row, as a user does), then Extrude, distance 20.
  void sq;
  await frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: /^(?:[(]-[)] )?Sketch 1$/ }) }).locator('> .tree-row').click();
  await runCommand(frame, 'solid.extrude');
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Extrude 1');
  const d = p.locator('.nui[data-field="distance"] input');
  await d.fill('20');
  await d.press('Enter');
  await expectVolume(frame, 100 * 20);
  const along = p.locator('[data-pick-field="direction"]');
  await expect(along.locator('[data-pick-empty]')).toHaveText('Normal to the profile');

  // Along Plane 1, picked by its row in the tree: its normal, tilted 45° from the square's.
  await along.locator('[data-pick-list]').click();
  await expect(along).toHaveAttribute('data-active', '1');
  await featureRow(frame, 'Plane 1').locator('> .tree-row').click();
  await expect(along.locator('[data-pick-row] .cad-pick-name')).toHaveText('Normal to Plane 1');
  await expect(featureRow(frame, 'Extrude 1')).toHaveAttribute('data-state', 'ok');
  await expectVolume(frame, 100 * 20 * Math.SQRT1_2);
  await shot(page, 'p4a-along-plane');

  // Taken out: along the normal again. Then Axis 1, clicked where the view draws it.
  await along.locator('[data-pick-remove]').click();
  await expect(along.locator('[data-pick-empty]')).toHaveText('Normal to the profile');
  await expectVolume(frame, 100 * 20);
  await along.locator('[data-pick-list]').click();
  await expect(along).toHaveAttribute('data-active', '1');
  await clickAt(page, [0, -8, 8]);
  await expect(along.locator('[data-pick-row] .cad-pick-name')).toHaveText('Axis 1');
  await expectVolume(frame, 100 * 20 * Math.SQRT1_2);
  // The body leans the axis' way: 10 + 20·sin 45° deep in y.
  await expect(frame.locator('[data-chip="size"]')).toHaveText(/^Size10 mm × 24\.14\d* mm × 14\.14\d* mm$/);

  // An origin plane's row: Front's normal lies in the square's plane, which Extrude refuses, with the reason.
  await along.locator('[data-pick-remove]').click();
  await along.locator('[data-pick-list]').click();
  await frame.locator('[data-cad-tree] [data-tree-node="origin:front"] > .tree-row').click();
  await expect(along.locator('[data-pick-row] .cad-pick-name')).toHaveText('Normal to Front plane');
  await expect(featureRow(frame, 'Extrude 1')).toHaveAttribute('data-state', 'error');
  await expect(p.locator('[data-run-reason]')).toContainText(/plane|direction/i);
  await along.locator('[data-pick-remove]').click();
  await expect(featureRow(frame, 'Extrude 1')).toHaveAttribute('data-state', 'ok');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p4a-point-sketch-points a Plane through 3 points of a sketch, clicked in the view, is that sketch\'s plane and keeps them', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A triangle on Front: corners (10, 0, 10), (30, 0, 10), (10, 0, 30) in the model.
  await addRaw(page, 'sketch', { ...FRONT, ...polygon([[10, 10], [30, 10], [10, 30]]) });
  await still(page);
  await runCommand(frame, 'construct.plane');
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Plane 1');
  await p.locator('[data-field="method"] select').selectOption('three_points');
  await expect(p.locator('[data-pick-field="points"]')).toHaveAttribute('data-active', '1');
  for (const c of [
    [10, 0, 10],
    [30, 0, 10],
    [10, 0, 30],
  ] as V3[])
    await clickAt(page, c);
  await expect(p.locator('[data-pick-list="points"] [data-pick-row] .cad-pick-name')).toHaveText([/^Corner of Line \d and Line \d of Sketch 1$/, /^Corner of Line \d and Line \d of Sketch 1$/, /^Corner of Line \d and Line \d of Sketch 1$/]);
  // The Front plane (through y = 0, its normal along Y).
  await expect(p.locator('[data-construct-readout]')).toHaveText(/^Built: through -?\d+(\.\d+)?, 0, -?\d+(\.\d+)? mm, normal 0, -?1, 0$/);
  await shot(page, 'p4a-plane-sketch-points');
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Plane 1')).toHaveAttribute('data-state', 'ok');

  // Opened again: the three points are kept (by the sketch's point ids), and the plane is built.
  await featureRow(frame, 'Plane 1').locator('> .tree-row').dblclick();
  await expect(p.locator('[data-pick-list="points"] [data-pick-row] .cad-pick-name')).toHaveText([/^Corner of Line \d and Line \d of Sketch 1$/, /^Corner of Line \d and Line \d of Sketch 1$/, /^Corner of Line \d and Line \d of Sketch 1$/]);
  await p.locator('[data-panel-done]').click();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
