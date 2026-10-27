// Daniel's first test of the CAD desktop app, in the real host frame, asserting what he sees:
//  - SolidWorks-style relations: he selects sketch lines with the Select tool and a palette of the
//    relations that apply shows beside them (one line: Horizontal, Vertical, Fix; two lines:
//    Parallel, Perpendicular, Equal, Collinear...); a click adds the relation (the sketch's
//    relations and its DOF change), the button then shows pressed and the contradicting one goes;
//    the palette never covers his sketch and goes when nothing is selected;
//  - the construction badge: "Construction · X" with a real × ("Turn off construction") that turns
//    construction drawing off (what he draws next is normal geometry).
// With RELATIONS_SHOTS=<folder>: screenshots of the palette and the badge for a person to look at.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { ensureCadOn, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

type V2 = [number, number];
type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function cad<T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown): Promise<T> {
  return workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
}

async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await cad<[number, number] | null>(page, ((pt: V3) => (window as unknown as W).__CAD__.services.viewport.get().handle?.project(pt) ?? null) as never, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

const clickAt = async (page: Page, p: V2, ctrl = false) => {
  const [x, y] = await at(page, [p[0], p[1], 0]);
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.click(x, y);
  if (ctrl) await page.keyboard.up('Control');
};

async function settled(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
}

async function sketchIdle(page: Page) {
  await cad(page, (async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  }) as never);
}

type Drawn = { points: Record<string, V2>; entities: { id: string; kind: string; p?: [string, string]; construction?: boolean }[]; constraints: { id: string; kind: string; refs: string[] }[] };
async function drawn(page: Page): Promise<Drawn> {
  return cad(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    return { points: d.points, entities: d.entities, constraints: d.constraints };
  }) as never);
}

const palette = (frame: FrameLocator) => frame.locator('[data-sketch-relations-palette]');
const relation = (frame: FrameLocator, kind: string) => palette(frame).locator(`[data-relation="${kind}"]`);
const badge = (frame: FrameLocator) => frame.locator('[data-sketch-construction-badge]');
const dofChip = (frame: FrameLocator) => frame.locator('[data-sketch-dof]');
const dof = async (frame: FrameLocator) => Number(await dofChip(frame).getAttribute('data-sketch-dof'));

async function shot(page: Page, name: string) {
  if (!process.env.RELATIONS_SHOTS) return;
  await page.screenshot({ path: join(process.env.RELATIONS_SHOTS, `${name}.png`) });
}

/** The line whose ends are these two points (as drawn: the clicks land within a pixel). */
function lineAt(d: Drawn, a: V2, b: V2): string {
  const near = (id: string, p: V2) => Math.hypot(d.points[id][0] - p[0], d.points[id][1] - p[1]) < 1;
  const l = d.entities.find((e) => e.kind === 'line' && ((near(e.p![0], a) && near(e.p![1], b)) || (near(e.p![0], b) && near(e.p![1], a))));
  expect(l, `a line from ${a} to ${b}`).toBeTruthy();
  return l!.id;
}

const mid = (a: V2, b: V2): V2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

test('cad:sketch-relations-palette selecting lines shows the relations that apply beside them; a click adds one (relations and DOF change), it then shows pressed; the construction badge\'s × turns construction drawing off', async ({ page, request }) => {
  await ensureCadOn(request);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);

  // Two slanted lines, apart (nothing inferred between them).
  const A: [V2, V2] = [
    [-30, -12],
    [10, -22],
  ];
  const B: [V2, V2] = [
    [-26, 14],
    [16, 31],
  ];
  await page.keyboard.press('l');
  for (const [p, q] of [A, B]) {
    await clickAt(page, p);
    await clickAt(page, q);
    await page.keyboard.press('Escape');
    await sketchIdle(page);
  }
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  let d = await drawn(page);
  const l1 = lineAt(d, ...A);
  const l2 = lineAt(d, ...B);
  const before = d.constraints.length;
  await expect(palette(frame)).toBeHidden();
  const dof0 = await dof(frame);
  expect(dof0).toBe(8);

  // One line selected: Horizontal, Vertical, Fix beside it.
  await clickAt(page, mid(...A));
  await expect(palette(frame)).toBeVisible();
  await expect(palette(frame).locator('[data-relation]')).toHaveCount(3);
  expect(await palette(frame).locator('[data-relation]').evaluateAll((els) => els.map((e) => e.getAttribute('data-relation')))).toEqual(['horizontal', 'vertical', 'fix']);
  await expect(relation(frame, 'horizontal')).toHaveAttribute('aria-label', 'Horizontal');
  await shot(page, 'palette-one-line');
  // Beside the selection, never over the line itself (its middle stays clickable).
  const box = (await palette(frame).boundingBox())!;
  const [mx, my] = await at(page, [...mid(...A), 0]);
  expect(mx >= box.x && mx <= box.x + box.width && my >= box.y && my <= box.y + box.height).toBe(false);
  expect(Math.hypot(box.x + box.width / 2 - mx, box.y + box.height / 2 - my)).toBeLessThan(260);

  // Horizontal: the relation is in the sketch, one DOF less, the button pressed and Vertical gone.
  await relation(frame, 'horizontal').click();
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.constraints.slice(before).map((c) => [c.kind, c.refs])).toEqual([['horizontal', [l1]]]);
  await expect.poll(() => dof(frame)).toBe(dof0 - 1);
  await expect(relation(frame, 'horizontal')).toHaveAttribute('aria-pressed', 'true');
  await expect(relation(frame, 'vertical')).toHaveCount(0);

  // Ctrl+click the second line: the two-line relations (Vertical left out: the first is horizontal).
  await clickAt(page, mid(...B), true);
  await expect(relation(frame, 'parallel')).toBeVisible();
  expect(await palette(frame).locator('[data-relation]').evaluateAll((els) => els.map((e) => e.getAttribute('data-relation')))).toEqual(['horizontal', 'parallel', 'perpendicular', 'equal', 'collinear', 'fix']);
  await shot(page, 'palette-two-lines');
  await relation(frame, 'parallel').click();
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.constraints.slice(before).map((c) => c.kind)).toEqual(['horizontal', 'parallel']);
  expect(d.constraints.slice(before)[1].refs.sort()).toEqual([l1, l2].sort());
  await expect.poll(() => dof(frame)).toBe(dof0 - 2);
  // The second line followed (parallel to the horizontal one).
  const e2 = d.entities.find((e) => e.id === l2)!;
  expect(Math.abs(d.points[e2.p![0]][1] - d.points[e2.p![1]][1])).toBeLessThan(1e-6);
  await expect(relation(frame, 'parallel')).toHaveAttribute('aria-pressed', 'true');
  await expect(relation(frame, 'perpendicular')).toHaveCount(0);
  // Equal too, from the same selection.
  await relation(frame, 'equal').click();
  await sketchIdle(page);
  await expect.poll(() => dof(frame)).toBe(dof0 - 3);
  await shot(page, 'palette-two-lines-added');

  // Nothing selected: no palette.
  await page.keyboard.press('Escape');
  await expect(palette(frame)).toBeHidden();

  // Construction drawing on (X): the badge says so with the shortcut, and its × turns it off.
  await page.keyboard.press('x');
  await expect(badge(frame)).toBeVisible();
  await expect(badge(frame).locator('[data-sketch-construction-text]')).toHaveText('Construction · X');
  const off = badge(frame).getByRole('button', { name: 'Turn off construction' });
  await expect(off).toBeVisible();
  await expect(off).toHaveAttribute('title', /\(X\)/);
  await shot(page, 'construction-badge');
  await off.click();
  await expect(badge(frame)).toBeHidden();
  expect(await cad<boolean>(page, (() => !!(window as unknown as W).__CAD__.services.apis.get().sketch.drawConstruction) as never)).toBe(false);
  // What is drawn next is normal geometry.
  const C: [V2, V2] = [
    [-30, 45],
    [20, 50],
  ];
  await page.keyboard.press('l');
  await clickAt(page, C[0]);
  await clickAt(page, C[1]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.entities.find((e) => e.id === lineAt(d, ...C))?.construction).toBeFalsy();
  expect(seen.errors).toEqual([]);
});
