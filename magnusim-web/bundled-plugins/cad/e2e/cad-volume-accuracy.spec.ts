// Volumes on B-spline bodies are what the body holds (kernel API 7, 2026-10-30). The plain
// integration read a loft 0.1-0.2 % low in the volume chip, made Press-pull refuse or misjudge
// small moves of its faces ("its volume would change by ... instead of about ..."), and let a
// Combine Cut by a block that only touches a cap pass with the chip rising by 17,756 mm³:
//  1. loft-chip-pp  a ruled loft between two airfoil sketches (Top, and a plane 400 mm up): the
//                   chip shows the section's area x 400; Press-pull of its top cap by 0.1 mm is
//                   ok with no failure line, and the chip rises by the area x 0.1.
//  2. combine-touch the 3-section loft and a block on its top cap that only touches it: Combine
//                   Cut is red, "Nothing to cut ... (touching is not enough)", the chip as before.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { featureRowNamed, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
type P2 = [number, number];

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
  return { seen, frame };
}

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(
      () =>
        cad<boolean>(page, (() => {
          const st = (window as unknown as W).__CAD__.services.doc.state.get();
          return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
        }) as never),
      { timeout: 120_000 },
    )
    .toBe(true);
}

/** A feature made through the document (setup, as a panel commits it), the camera left as it is; its id once built. */
async function add(page: Page, type: string, init: Record<string, unknown>): Promise<string> {
  const id = await cad<string>(page, ((a: { type: string; init: Record<string, unknown> }) => {
    const s = (window as unknown as W).__CAD__.services;
    const handle = s.viewport.get().handle;
    const lookAt = handle?.lookAt;
    if (handle) handle.lookAt = () => {};
    try {
      const f = s.doc.beginNew(a.type, a.init);
      f.commit();
      return f.feature as string;
    } finally {
      if (handle && lookAt) handle.lookAt = lookAt;
    }
  }) as never, { type, init });
  await settled(page);
  return id;
}

/** An airfoil-like closed outline (chord, thickness, centre offset): 15 poles. */
function airfoil(chord: number, th: number, cx = 0, cy = 0): P2[] {
  const P: P2[] = [];
  for (let i = 0; i < 15; i++) {
    const a = (2 * Math.PI * i) / 15;
    const x = 0.5 * chord * Math.cos(a);
    const t = x / chord + 0.5;
    const y = th * chord * (0.2969 * Math.sqrt(Math.max(t, 0)) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4) * 5 * Math.sign(Math.sin(a) || 1) + 0.15 * chord * Math.sin(a);
    P.push([cx + x, cy + y]);
  }
  return P;
}

/** A sketch of a closed control spline through poles P at height z (on Top, or on the plane feature `on`). */
function splineSketch(P: P2[], z: number, on: string | null, periodic: boolean): Record<string, unknown> {
  const ids = P.map((_, i) => `p_${i + 1}`);
  return {
    support: on ? { kind: 'feature', feature: on } : { kind: 'plane', plane: 'origin:top' },
    plane: { origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] },
    points: Object.fromEntries(P.map((p, i) => [ids[i], p])),
    entities: [periodic ? { id: 'e_1', kind: 'spline', form: 'control', pts: ids, degree: 3, closed: true } : { id: 'e_1', kind: 'spline', form: 'control', pts: [...ids, ids[0]], degree: 3 }],
    constraints: [],
    solved: { values: {}, dof: 2 * P.length, state: 'under' },
  };
}

/** A built sketch's one region (as a Loft or Extrude keeps it) and its area. */
async function region(page: Page, sketch: string): Promise<{ ref: Record<string, unknown>; area: number }> {
  return cad(page, ((id: string) => {
    const o = (window as unknown as W).__CAD__.services.doc.state.get().rebuild.outputs[id];
    const r = o.regions[0];
    return { ref: { sketch: id, region: r.key, entities: [...r.entities].sort(), sample: r.sample }, area: r.area };
  }) as never, sketch);
}

const plane = (page: Page, mm: number) => add(page, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: `${mm} mm` });

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const bodyOf = (page: Page, feature: string) => cad<{ id: string; shape: number }>(page, ((f: string) => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies.find((b: { feature: string }) => b.feature === f)) as never, feature);

/** The chip's volume of body `id` (mm³), read until it is `want` within `rel`. */
async function expectChip(frame: FrameLocator, id: string, want: number, rel: number) {
  const at = frame.locator(`[data-chip="volume"] [data-volume-body="${id}"]`).first();
  await expect.poll(async () => Math.abs(Number(await at.getAttribute('data-volume-mm3')) / want - 1), { timeout: 60_000 }).toBeLessThan(rel);
}
const chipOf = async (frame: FrameLocator, id: string) => Number(await frame.locator(`[data-chip="volume"] [data-volume-body="${id}"]`).first().getAttribute('data-volume-mm3'));

test('cad:volume-loft-chip-pp a ruled airfoil loft: the chip shows its section area x 400; Press-pull of its top cap by 0.1 mm is ok and adds the area x 0.1', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const up = await plane(page, 400);
  const s1 = await add(page, 'sketch', splineSketch(airfoil(600, 0.24), 0, null, true));
  const s2 = await add(page, 'sketch', splineSketch(airfoil(600, 0.24), 400, up, true));
  const [r1, r2] = [await region(page, s1), await region(page, s2)];
  expect(r1.area).toBeGreaterThan(50_000);
  const loft = await add(page, 'loft', { sections: [r1.ref, r2.ref], ruled: true, op: 'new' });
  await expect(featureRowNamed(frame as never, 'Loft 1')).toHaveAttribute('data-state', 'ok');
  const body = await bodyOf(page, loft);
  // The plain integration showed 0.13 % less.
  await expectChip(frame, body.id, r1.area * 400, 1e-9);
  // The top cap selected, Press-pull, 0.1 mm.
  const top = await cad<number>(page, (async (shape: number) => {
    const s = (window as unknown as W).__CAD__.services;
    const t = (await s.kernel.call('topo', { id: shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true })).result;
    return t.faces.find((f: { type: string; normal: number[] }) => f.type === 'plane' && f.normal[2] > 0.99).i;
  }) as never, body.shape);
  await cad(page, ((a: { body: string; face: number }) => (window as unknown as W).__CAD__.services.selection.set((st: object) => ({ ...st, items: [{ kind: 'face', body: a.body, index: a.face }] }))) as never, { body: body.id, face: top });
  await runCommand(frame, 'modify.press-pull');
  await expect(panel(frame).locator('[data-feature-panel="press_pull"]')).toBeVisible();
  await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
  const dist = panel(frame).locator('.nui[data-field="distance"] input');
  await dist.fill('0.1');
  await dist.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  // The cap's area is the section's: the body grows by area x 0.1 (it was refused, or read 6 times that).
  await expectChip(frame, body.id, r1.area * 400.1, 1e-8);
  await shot(page, 'volume-loft-pp');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(featureRowNamed(frame as never, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
  expect(seen.errors).toEqual([]);
});

test('cad:volume-combine-touch a block that only touches the top cap of a 3-section loft: Combine Cut says Nothing to cut, the chip as before', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const p200 = await plane(page, 200);
  const p400 = await plane(page, 400);
  const s0 = await add(page, 'sketch', splineSketch(airfoil(600, 0.24), 0, null, false));
  const s1 = await add(page, 'sketch', splineSketch(airfoil(520, 0.22, 30, 10), 200, p200, false));
  const s2 = await add(page, 'sketch', splineSketch(airfoil(420, 0.2, 60, 20), 400, p400, false));
  const loft = await add(page, 'loft', { sections: [(await region(page, s0)).ref, (await region(page, s1)).ref, (await region(page, s2)).ref], ruled: false, op: 'new' });
  const body = await bodyOf(page, loft);
  // The block: 200 x 100 on Top at the origin, from z 400 (the loft's top) to 450.
  const sk = await add(page, 'sketch', {
    support: { kind: 'plane', plane: 'origin:top' },
    plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
    points: { a: [0, 0], b: [200, 0], c: [200, 100], d: [0, 100] },
    entities: [
      { id: 'l1', kind: 'line', p: ['a', 'b'] },
      { id: 'l2', kind: 'line', p: ['b', 'c'] },
      { id: 'l3', kind: 'line', p: ['c', 'd'] },
      { id: 'l4', kind: 'line', p: ['d', 'a'] },
    ],
    constraints: [],
    solved: { values: {}, dof: 8, state: 'under' },
  });
  const blk = await add(page, 'extrude', { profiles: [(await region(page, sk)).ref], extent: { kind: 'two', distance: '450 mm', distance2: '-400 mm' }, op: 'new' });
  const tool = await bodyOf(page, blk);
  await expect.poll(() => chipOf(frame, body.id), { timeout: 60_000 }).toBeGreaterThan(3e7);
  const v0 = await chipOf(frame, body.id);
  // The plain integration: 3.9336e7 for 3.94102e7.
  expect(Math.abs(v0 / 39_410_235.43 - 1)).toBeLessThan(1e-9);
  await add(page, 'combine', { op: 'cut', targets: [body.id], tools: [tool.id], keepTools: false });
  const row = featureRowNamed(frame as never, 'Combine 1');
  await expect(row).toHaveAttribute('data-state', 'error');
  await row.locator('> .tree-row').dblclick();
  await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(/^Combine 1 failed: Nothing to cut: Body 2 does not overlap Body 1 \(touching is not enough\)/, { timeout: 30_000 });
  await shot(page, 'volume-combine-touch');
  await expectChip(frame, body.id, v0, 1e-12);
  expect(seen.errors).toEqual([]);
});
