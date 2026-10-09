// P4b SELECT: Project, Silhouette and Intersect (Daniel's must-haves 3 and 4) as the user
// meets them: P and a click on a face, the Sketch panel's References rows (what each follows,
// how many curves, its state), purple curves that follow the model when a parameter changes
// (a driven dimension on a projected line reads the new length), an amber "Lost reference"
// that does not block the sketch, Break link, Trim refused on a linked curve and allowed
// against it, a silhouette and a section extruded and checked by their analytic volumes, and
// snaps on model geometry while drawing (scope addition A: auto-projected, linked, Ctrl off).
// Setup (parameters, blocks, extrudes of the made profiles) goes in through the document.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { PNG } from './png';
import { addSolid, chipVolumes, commandControl, modelOnPage, newPartFromTree, newProject, openProject, openSketchDetails, partOpened, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
type V3 = [number, number, number];

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
const at = (page: Page, p: V3) => modelOnPage(page, p);

async function idle(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
  await cad(page, (async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  }) as never);
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

/**
 * A W x D x H block whose width is the parameter `width` (setup through the document): a fully
 * defined rectangle on Top from the origin, extruded H. Returns the parameter's id.
 */
async function paramBlock(page: Page, w: number, d: number, h: number): Promise<string> {
  const id = await cad<string>(page, (async (a: { w: number; d: number; h: number }) => {
    const s = (window as unknown as W).__CAD__.services;
    const pid = s.doc.addParam({ name: 'width', expr: `${a.w} mm`, quantity: 'length' });
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
      { id: 'c_d', kind: 'distance', refs: ['e_2'], expr: `${a.d} mm`, driving: true },
    ];
    let sk;
    try {
      sk = s.doc.beginNew('sketch', {
        support: { kind: 'plane', plane: 'origin:top' },
        plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
        points: { pt_1: [0, 0], pt_2: [a.w, 0], pt_3: [a.w, a.d], pt_4: [0, a.d] },
        entities: [
          { id: 'e_1', kind: 'line', p: ['pt_1', 'pt_2'] },
          { id: 'e_2', kind: 'line', p: ['pt_2', 'pt_3'] },
          { id: 'e_3', kind: 'line', p: ['pt_3', 'pt_4'] },
          { id: 'e_4', kind: 'line', p: ['pt_4', 'pt_1'] },
        ],
        constraints: cs,
        solved: { values: { c_w: a.w, c_d: a.d }, dof: 0, state: 'fully' },
      });
      sk.commit();
    } finally {
      handle.lookAt = lookAt;
    }
    for (let k = 0; k < 400; k++) {
      const o = s.doc.state.get().rebuild.outputs[sk.feature];
      if (o?.regions?.length) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const region = s.doc.state.get().rebuild.outputs[sk.feature].regions[0];
    const ex = s.doc.beginNew('extrude', { profiles: [{ sketch: sk.feature, region: region.key, entities: region.entities, sample: region.sample }], extent: { kind: 'blind', distance: `${a.h} mm` }, op: 'new' });
    ex.commit();
    return pid as string;
  }) as never, { w, d, h });
  await settled(page);
  await idle(page);
  return id;
}

/** A new sketch on an origin plane, as the user starts one (its row, then Sketch). */
async function sketchOn(page: Page, frame: FrameLocator, plane: 'top' | 'front' | 'right') {
  await frame.locator(`[data-tree-node="origin:${plane}"] > .tree-row`).click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  // ux010: the references are under the Sketch panel's Details (every test here reads them).
  await openSketchDetails(page, frame);
}

const links = (frame: FrameLocator) => frame.locator('[data-sketch-links] [data-link]');

/** Extrude a made profile of a sketch (setup), as Extrude would; returns the body's volume chip values once built. */
async function extrudeProfile(page: Page, frame: FrameLocator, sketch: string, h: number) {
  await cad(page, (async (a: { sketch: string; h: number }) => {
    const s = (window as unknown as W).__CAD__.services;
    for (let k = 0; k < 400; k++) {
      if (s.doc.state.get().rebuild.outputs[a.sketch]?.regions?.length) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const region = s.doc.state.get().rebuild.outputs[a.sketch].regions[0];
    const ex = s.doc.beginNew('extrude', { profiles: [{ sketch: a.sketch, region: region.key, entities: region.entities, sample: region.sample }], extent: { kind: 'blind', distance: `${a.h} mm` }, op: 'new' });
    ex.commit();
  }) as never, { sketch, h });
  await settled(page);
  void frame;
}

const lastSketch = (page: Page) =>
  cad<string>(page, (() => {
    const fs = (window as unknown as W).__CAD__.services.doc.state.get().doc.features.filter((f: { type: string }) => f.type === 'sketch');
    return fs[fs.length - 1].id;
  }) as never);

test('cad:p4b-project-face-follows Project a face: four purple lines, linked; a parameter change moves them (a driven dimension reads it); a suppressed body gives an amber Lost reference that does not block', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const width = await paramBlock(page, 40, 20, 10);
  await sketchOn(page, frame, 'top');
  const panel = frame.locator('[data-cad-panel="sketch"]');

  // P: the Project tool (its button pressed); a click on the block's top face.
  await page.keyboard.press('p');
  // Its button pressed, or (folded at this width: P4b fix round 1 folds Project before the new tools) its group's More.
  await expect(frame.locator('[data-cad-toolbar] .tb-btn[data-command="sketch.project"], [data-cad-toolbar] [data-tb-more][data-more-commands~="sketch.project"]')).toHaveClass(/is-active/);
  await expect(panel.locator('[data-sketch-hint]')).toContainText('Click a vertex, an edge or a face of a body');
  const [tx, ty] = await at(page, [20, 10, 10]);
  await page.mouse.click(tx, ty);
  await idle(page);
  await expect(links(frame)).toHaveCount(1);
  const row = links(frame).first();
  await expect(row).toHaveAttribute('data-link-state', 'ok');
  await expect(row).toHaveAttribute('data-link-type', 'projected');
  await expect(row.locator('.cad-sk-link-name')).toHaveText(/^Projected: .+ · 4 curves$/);
  // The same face again: refused in words, nothing added.
  await page.mouse.click(tx, ty);
  await idle(page);
  await expect(panel.locator('[data-run-reason], .mgk-reason-msg').first()).toContainText('is already in Sketch 2');
  await expect(links(frame)).toHaveCount(1);
  // Projected lines are fixed: the sketch is fully defined with them alone.
  await expect(panel.locator('[data-sketch-state]')).toHaveAttribute('data-sketch-state', 'fully');

  // A dimension on the projected long side: it would over-define (the line is fixed), so it is driven.
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  const [lx, ly] = await at(page, [20, 0, 0]);
  await page.mouse.click(lx, ly);
  const [px, py] = await at(page, [20, -8, 0]);
  await page.mouse.click(px, py);
  await frame.locator('[data-question-accept]').click();
  await idle(page);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['(40 mm)']);
  await page.keyboard.press('Escape');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();

  // Upstream: width 40 -> 50. The block grows (volume), and the projected lines follow it.
  await cad(page, ((id: string) => (window as unknown as W).__CAD__.services.doc.updateParam(id, { expr: '50 mm' })) as never, width);
  await settled(page);
  await expect.poll(async () => (await chipVolumes(frame)).map((v) => Math.round(v * 1000) / 1000)).toEqual([10_000]);
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last().locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['(50 mm)']);
  await expect(links(frame).first()).toHaveAttribute('data-link-state', 'ok');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();

  // The block's extrude suppressed: its body is gone; the sketch still builds, amber, and says what was lost.
  const exRow = frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="extrude"] > .tree-row');
  await exRow.click({ button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="suppress"]').click();
  await settled(page);
  const skRow = frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last();
  await expect(skRow).toHaveAttribute('data-state', 'warning');
  await skRow.locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  await expect(links(frame).first()).toHaveAttribute('data-link-state', 'lost');
  await expect(links(frame).first().locator('[data-link-message]')).toHaveText(/^Lost reference: .+ Body 1 is not there at this point$/);
  // Not blocked: the sketch is still solved (fully defined), its foot says the warning.
  await expect(panel.locator('[data-sketch-state]')).toHaveAttribute('data-sketch-state', 'fully');
  await expect(panel.locator('[data-warning]')).toContainText('Lost reference');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  // Unsuppressed: found again.
  await exRow.click({ button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="suppress"]').click();
  await settled(page);
  await expect(skRow).not.toHaveAttribute('data-state', 'warning');
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-project-edge-vertex-break an edge and a vertex projected; Trim refused on a linked line and done against it; Break link makes it ordinary geometry', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 20, 10] });
  await sketchOn(page, frame, 'top');
  const panel = frame.locator('[data-cad-panel="sketch"]');
  await page.keyboard.press('p');
  // The top face's front edge (y = 0, z = 10) and the far corner vertex (40, 20, 10).
  const [ex, ey] = await at(page, [20, 0, 10]);
  await page.mouse.click(ex, ey);
  await idle(page);
  const [vx, vy] = await at(page, [40, 20, 10]);
  await page.mouse.click(vx, vy);
  await idle(page);
  await expect(links(frame)).toHaveCount(2);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/^Projected: Edge .+ · 1 curve$/, /^Projected: .+ · 1 curve$/]);
  await page.keyboard.press('Escape');

  // A line across the projected edge (drawn: it is not linked), from (10, -10) to (10, 10).
  await page.keyboard.press('l');
  const a = await at(page, [10, -10, 0]);
  const b = await at(page, [10, 10, 0]);
  await page.keyboard.down('Control');
  await page.mouse.click(a[0], a[1]);
  await page.mouse.click(b[0], b[1]);
  await page.keyboard.up('Control');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await idle(page);
  // Trim on the projected line: refused, it follows the model.
  await page.keyboard.press('t');
  const [px, py] = await at(page, [30, 0, 0]);
  await page.mouse.click(px, py);
  await idle(page);
  await expect(panel.locator('.mgk-reason-msg, [data-run-reason]').first()).toContainText('follows the model: Break link first');
  // Trim the drawn line's piece below the projected edge: it is cut AT the projected line.
  const [qx, qy] = await at(page, [10, -5, 0]);
  await page.mouse.click(qx, qy);
  await idle(page);
  const lineEnds = await cad<number[][]>(page, (() => {
    const m = (window as unknown as W).__CAD__.services.apis.get().sketch;
    const d = m.draft();
    const e = d.entities.find((x: { kind: string; link?: string }) => x.kind === 'line' && !x.link);
    return e.p.map((p: string) => d.points[p]);
  }) as never);
  expect(Math.min(...lineEnds.map((p) => p[1]))).toBeCloseTo(0, 6);
  await page.keyboard.press('Escape');

  // Break link from the right-click menu: the line is ordinary geometry (no References row for it).
  const [bx, by] = await at(page, [30, 0, 0]);
  await page.mouse.click(bx, by, { button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu.locator('[data-menu-item="break-link"]')).toHaveText('Break link');
  await menu.locator('[data-menu-item="break-link"]').click();
  await idle(page);
  await expect(links(frame)).toHaveCount(1);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/^Projected: .+ · 1 curve$/]);
  // Now it can be trimmed.
  await page.keyboard.press('t');
  await page.mouse.click(px, py);
  await idle(page);
  await expect(panel.locator('.mgk-reason-msg').filter({ hasText: 'follows the model' })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-project-silhouette Silhouette of a lying cylinder: one closed outline of 4 lines, extruded 5 mm = 30 x 20 x 5', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A cylinder Ø20 along X from x = 0 to 30 (its axis at y = 0, z = 0): seen from above, a 30 x 20 rectangle.
  await addSolid(page, { circle: true, axis: 'x', size: [20, 30], at: [0, 0, 30] });
  await sketchOn(page, frame, 'top');
  await page.keyboard.press('p');
  await frame.locator('[data-sketch-project] [data-switch="silhouette"] .cad-switch-label').click();
  await expect(frame.locator('[data-sketch-project] [data-switch="silhouette"] input')).toBeChecked();
  await expect(frame.locator('[data-sketch-hint]')).toContainText('Click a body');
  const [cx, cy] = await at(page, [15, 0, 40]);
  await page.mouse.click(cx, cy);
  await idle(page);
  await expect(links(frame)).toHaveCount(1);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/^Silhouette: Body 1 · 4 curves$/]);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await extrudeProfile(page, frame, await lastSketch(page), 5);
  await expect.poll(async () => (await chipVolumes(frame)).map((v) => Math.round(v * 100) / 100).sort((x, y) => x - y)).toEqual([3000, Math.round(Math.PI * 100 * 30 * 100) / 100].sort((x, y) => x - y));
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-project-intersect Intersect: the Right plane cuts Body 1 (a 20 x 10 loop, extruded 5 = 1000 mm3); Body 2 it misses says so', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { at: [-10, 0, 0], size: [40, 20, 10] });
  await addSolid(page, { at: [50, 0, 0], size: [10, 10, 10] });
  await sketchOn(page, frame, 'right');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.intersect"], [data-cad-toolbar] [data-tb-more][data-more-commands~="sketch.intersect"]').first().click();
  const menu = frame.locator('[data-cad-menu]');
  if (await menu.count()) await menu.locator('[data-command="sketch.intersect"]').click();
  const block = frame.locator('[data-sketch-intersect]');
  await expect(block.locator('[data-intersect-bodies]')).toHaveText('Every shown body (2)');
  await block.locator('[data-sketch-action="intersect"]').click();
  await idle(page);
  await expect(links(frame)).toHaveCount(1);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/^Intersection: Body 1 · 4 curves$/]);
  await expect(frame.locator('[data-cad-panel="sketch"] .mgk-reason-msg').first()).toHaveText(/Intersected Body 1\. The sketch plane doesn't cut Body 2\./);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await extrudeProfile(page, frame, await lastSketch(page), 5);
  await expect.poll(async () => (await chipVolumes(frame)).map((v) => Math.round(v * 1000) / 1000).sort((x, y) => x - y)).toEqual([1000, 1000, 8000]);
  expect(seen.errors).toEqual([]);
});

/** The first non-linked line's two ends (u, v), or null. */
async function drawnLine(page: Page): Promise<number[][] | null> {
  return cad<number[][] | null>(page, (() => {
    const m = (window as unknown as W).__CAD__.services.apis.get().sketch;
    const d = m.draft();
    const e = d?.entities.find((x: { kind: string; link?: string }) => x.kind === 'line' && !x.link);
    return e ? e.p.map((p: string) => d.points[p]) : null;
  }) as never);
}

test("cad:p4b-snap-corner-follows a line from the block's top corner snaps to it unprojected (auto-projected, light), follows a width change, Ctrl+Z takes both back, Ctrl turns the snap off", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const width = await paramBlock(page, 40, 20, 10);
  await sketchOn(page, frame, 'top');
  await page.keyboard.press('l');
  // Hover the top corner (40, 0, 10): the coincident glyph shows (the corner is above the sketch plane).
  const c = await at(page, [40, 0, 10]);
  await page.mouse.move(c[0] + 2, c[1] + 2, { steps: 3 });
  await page.mouse.move(c[0] + 1, c[1] + 1);
  await expect(frame.locator('[data-sketch-infer="coincident"]')).toHaveCount(1);
  // Ctrl held: no snap at all.
  await page.keyboard.down('Control');
  await page.mouse.move(c[0], c[1] + 1);
  await expect(frame.locator('[data-sketch-infer]')).toHaveCount(0);
  await page.keyboard.up('Control');
  await page.mouse.move(c[0], c[1]);
  await expect(frame.locator('[data-sketch-infer="coincident"]')).toHaveCount(1);
  await page.mouse.click(c[0], c[1]);
  const far = await at(page, [20, 10, 0]);
  await page.keyboard.down('Control');
  await page.mouse.click(far[0], far[1]);
  await page.keyboard.up('Control');
  await idle(page);
  // (What the panel's foot says, should the edit be refused.)
  const note = await frame.locator('[data-cad-panel="sketch"] .mgk-reason-msg').allTextContents();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await idle(page);
  await expect(links(frame), note.join(' | ')).toHaveCount(1);
  await expect(links(frame).first()).toHaveAttribute('data-link-auto', '1');
  await expect(links(frame).first().locator('.cad-sk-link-name')).toHaveText(/^Projected: Corner of .+ · 1 curve$/);
  const l1 = (await drawnLine(page))!;
  expect(l1[0][0]).toBeCloseTo(40, 6);
  expect(l1[0][1]).toBeCloseTo(0, 6);
  // One step back takes the line and its reference together; one forward brings both.
  await page.keyboard.press('Control+z');
  await idle(page);
  await expect(links(frame)).toHaveCount(0);
  expect(await drawnLine(page)).toBeNull();
  await page.keyboard.press('Control+y');
  await idle(page);
  await expect(links(frame)).toHaveCount(1);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  // Width 40 -> 50: the line still starts at the corner, now (50, 0).
  await cad(page, ((id: string) => (window as unknown as W).__CAD__.services.doc.updateParam(id, { expr: '50 mm' })) as never, width);
  await settled(page);
  await expect.poll(async () => (await chipVolumes(frame)).map((v) => Math.round(v * 1000) / 1000)).toEqual([10_000]);
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last().locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  const l2 = (await drawnLine(page))!;
  expect(l2[0][0]).toBeCloseTo(50, 6);
  expect(l2[0][1]).toBeCloseTo(0, 6);
  await expect(links(frame).first()).toHaveAttribute('data-link-state', 'ok');
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-snap-on-edge a point placed on a model edge (the on-curve glyph) stays on it after an upstream change', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const width = await paramBlock(page, 40, 20, 10);
  await sketchOn(page, frame, 'top');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.point"], [data-cad-toolbar] [data-tb-more][data-more-commands~="sketch.point"]').first().click();
  const menu = frame.locator('[data-cad-menu]');
  if (await menu.count()) await menu.locator('[data-command="sketch.point"]').click();
  // The right side edge of the top face (x = 40, z = 10), a quarter along it.
  const p = await at(page, [40, 5, 10]);
  await page.mouse.move(p[0] + 1, p[1] + 1, { steps: 3 });
  await page.mouse.move(p[0], p[1]);
  await expect(frame.locator('[data-sketch-infer="on-curve"]')).toHaveCount(1);
  await page.mouse.click(p[0], p[1]);
  await idle(page);
  await page.keyboard.press('Escape');
  await expect(links(frame)).toHaveCount(1);
  await expect(links(frame).first().locator('.cad-sk-link-name')).toHaveText(/^Projected: Edge .+ · 1 curve$/);
  const pointAt = () =>
    cad<number[]>(page, (() => {
      const m = (window as unknown as W).__CAD__.services.apis.get().sketch;
      const d = m.draft();
      const e = d.entities.find((x: { kind: string; link?: string }) => x.kind === 'point' && !x.link);
      return d.points[e.p];
    }) as never);
  expect((await pointAt())[0]).toBeCloseTo(40, 6);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await cad(page, ((id: string) => (window as unknown as W).__CAD__.services.doc.updateParam(id, { expr: '55 mm' })) as never, width);
  await settled(page);
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last().locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  // Still on the edge: x = 55 now.
  expect((await pointAt())[0]).toBeCloseTo(55, 6);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-snap-constrain-to-model a body vertex Ctrl+clicked after a sketch point is auto-projected, and Coincident ties the point to it; a dimension takes a body edge as its second pick', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 20, 10] });
  await sketchOn(page, frame, 'top');
  const panel = frame.locator('[data-cad-panel="sketch"]');
  // A free point (Ctrl: no snap) at (25, 5).
  await frame.locator('[data-cad-toolbar] [data-command="sketch.point"], [data-cad-toolbar] [data-tb-more][data-more-commands~="sketch.point"]').first().click();
  const menu = frame.locator('[data-cad-menu]');
  if (await menu.count()) await menu.locator('[data-command="sketch.point"]').click();
  const p = await at(page, [25, 5, 0]);
  await page.keyboard.down('Control');
  await page.mouse.click(p[0], p[1]);
  await page.keyboard.up('Control');
  await idle(page);
  await page.keyboard.press('Escape');
  // Select it, then Ctrl+click the block's top corner (40, 0, 10): projected and added to the selection.
  await page.mouse.click(p[0], p[1]);
  const c = await at(page, [40, 0, 10]);
  await page.keyboard.down('Control');
  await page.mouse.click(c[0], c[1]);
  await page.keyboard.up('Control');
  await idle(page);
  await expect(links(frame)).toHaveCount(1);
  await expect(links(frame).first()).toHaveAttribute('data-link-auto', '1');
  await expect(panel.locator('[data-sketch-selection] .cad-sk-selected')).toHaveAttribute('title', 'Point 1, Point 2');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.coincident"]').click();
  await idle(page);
  const pts = await cad<number[][]>(page, (() => {
    const m = (window as unknown as W).__CAD__.services.apis.get().sketch;
    const d = m.draft();
    return d.entities.filter((e: { kind: string }) => e.kind === 'point').map((e: { p: string }) => d.points[e.p]);
  }) as never);
  for (const q of pts) {
    expect(q[0]).toBeCloseTo(40, 6);
    expect(q[1]).toBeCloseTo(0, 6);
  }
  await expect(panel.locator('[data-sketch-state]')).toHaveAttribute('data-sketch-state', 'fully');

  // Dimension: Point 1 first, then the block's top back edge (y = 20, z = 10) as the second pick: 20 mm, driven
  // (both are fixed by the model), so the sketch asks and the label reads (20).
  await page.keyboard.press('d');
  const p1 = await at(page, [40, 0, 0]);
  await page.mouse.click(p1[0], p1[1]);
  const edge = await at(page, [20, 20, 10]);
  await page.mouse.click(edge[0], edge[1]);
  await idle(page);
  await expect(links(frame)).toHaveCount(2);
  const place = await at(page, [45, 10, 0]);
  await page.mouse.click(place[0], place[1]);
  await frame.locator('[data-question-accept]').click();
  await idle(page);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['(20 mm)']);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- P4b fix round 1 (review: selection and linked geometry)

/** The open sketch's linked and unlinked lines (their ends, u/v). */
async function sketchLines(page: Page): Promise<{ linked: boolean; ends: number[][] }[]> {
  return cad(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    return d.entities.filter((e: { kind: string }) => e.kind === 'line').map((e: { link?: string; p: string[] }) => ({ linked: !!e.link, ends: e.p.map((p: string) => d.points[p]) }));
  }) as never);
}

/** Whether a purple pixel (the linked colour, #7a3fd1) is within r px of a page point. */
async function purpleNear(page: Page, xy: [number, number], r = 4): Promise<boolean> {
  const img = PNG.decode(await page.screenshot({ clip: { x: Math.round(xy[0]) - r, y: Math.round(xy[1]) - r, width: 2 * r + 1, height: 2 * r + 1 } }));
  for (let i = 0; i < img.width * img.height; i++) {
    const [R, G, B] = [img.data[4 * i], img.data[4 * i + 1], img.data[4 * i + 2]];
    if (B > G + 60 && R > G + 25) return true;
  }
  return false;
}

test('cad:p4b-fix-b2-delete-break-kept Delete and Break link of one projected curve are kept: no "changed" warning, nothing comes back on reopen or after an upstream change, and the broken line has its own ends (it drags)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const width = await paramBlock(page, 40, 20, 10);
  await sketchOn(page, frame, 'top');
  await page.keyboard.press('p');
  const [tx, ty] = await at(page, [20, 10, 10]);
  await page.mouse.click(tx, ty);
  await idle(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/· 4 curves$/]);
  await page.keyboard.press('Escape');
  // Delete the front line.
  const [fx, fy] = await at(page, [20, 0, 0]);
  await page.mouse.click(fx, fy);
  await page.keyboard.press('Delete');
  await idle(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/· 3 curves$/]);
  // Break link on the right line.
  const [rx, ry] = await at(page, [40, 10, 0]);
  await page.mouse.click(rx, ry, { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="break-link"]').click();
  await idle(page);
  await settled(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/· 2 curves$/]);
  await expect(links(frame).first()).toHaveAttribute('data-link-state', 'ok');
  await expect(links(frame).locator('[data-link-message]')).toHaveCount(0);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-warning]')).toHaveCount(0);
  // The broken line drags (its ends are its own now): 5 mm to the right.
  const [mx, my] = await at(page, [40, 10, 0]);
  const [mx2] = await at(page, [45, 10, 0]);
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.mouse.move((mx + mx2) / 2, my, { steps: 3 });
  await page.mouse.move(mx2, my, { steps: 3 });
  await page.mouse.up();
  await idle(page);
  const broken = (await sketchLines(page)).filter((l) => !l.linked);
  expect(broken).toHaveLength(1);
  expect(broken[0].ends[0][0]).toBeGreaterThan(43);
  const bx = broken[0].ends[0][0];
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await settled(page);
  const sk = frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last();
  await expect(sk).not.toHaveAttribute('data-state', 'warning');
  // Upstream width 40 -> 60, then reopen: still 2 linked curves, 3 lines in all; the broken line where it was put.
  await cad(page, ((id: string) => (window as unknown as W).__CAD__.services.doc.updateParam(id, { expr: '60 mm' })) as never, width);
  await settled(page);
  await expect(sk).not.toHaveAttribute('data-state', 'warning');
  await sk.locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/· 2 curves$/]);
  const lines = await sketchLines(page);
  expect(lines).toHaveLength(3);
  const brokenNow = lines.filter((l) => !l.linked)[0];
  expect(brokenNow.ends[0][0]).toBeCloseTo(bx, 6);
  // The back line follows the model: (60, 20) - (0, 20).
  const back = lines.filter((l) => l.linked).find((l) => Math.abs(l.ends[0][1] - 20) < 1e-6 && Math.abs(l.ends[1][1] - 20) < 1e-6)!;
  expect(Math.max(back.ends[0][0], back.ends[1][0])).toBeCloseTo(60, 6);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix-p1-spline-poles a projected B-spline shows its curve, not its control poles: a Points box over the projected face takes only the 2 ends', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A block bounded by a line and a cubic: (0,0)-(40,0), then poles (40,0) (40,30) (0,30) (0,0); 10 mm high.
  const sk = await cad<string>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const h = s.viewport.get().handle;
    const look = h.lookAt;
    h.lookAt = () => {};
    let id = '';
    try {
      const f = s.doc.beginNew('sketch', {
        support: { kind: 'plane', plane: 'origin:top' },
        plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
        points: { a: [0, 0], b: [40, 0], c: [40, 30], d: [0, 30] },
        entities: [
          { id: 'e_l', kind: 'line', p: ['a', 'b'] },
          { id: 'e_s', kind: 'spline', form: 'control', pts: ['b', 'c', 'd', 'a'], degree: 3 },
        ],
        constraints: [],
        solved: { values: {}, dof: 8, state: 'under' },
      });
      f.commit();
      id = f.feature;
    } finally {
      h.lookAt = look;
    }
    return id;
  }) as never);
  await extrudeProfile(page, frame, sk, 10);
  await idle(page);
  await sketchOn(page, frame, 'top');
  await page.keyboard.press('p');
  const [tx, ty] = await at(page, [20, 8, 10]);
  await page.mouse.click(tx, ty);
  await idle(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/· 2 curves$/]);
  await page.keyboard.press('Escape');
  // Points filter, a Ctrl box around everything: only the two ends of the line (the spline's ends).
  await frame.locator('[data-vp-opens="filter"]').click();
  await frame.locator('[data-vp-pop="filter"] [data-filter="point"]').click();
  await page.keyboard.press('Escape');
  const a = await at(page, [-5, 26, 0]);
  const b = await at(page, [45, -5, 0]);
  await page.mouse.move(a[0], a[1]);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await idle(page);
  const words = ((await frame.locator('[data-sketch-selection] .cad-sk-selected').getAttribute('title')) ?? '').split(', ').filter(Boolean);
  expect(words).toHaveLength(2);
  // No purple dot at the inner poles (40,30) and (0,30), which lie off the curve.
  expect(await purpleNear(page, await at(page, [40, 30, 0]), 3)).toBe(false);
  expect(await purpleNear(page, await at(page, [0, 30, 0]), 3)).toBe(false);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix-p2-seam a cylinder\'s side face projected from the side gives its two rims, not its seam edge twice', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { circle: true, size: [20, 20] });
  await sketchOn(page, frame, 'right');
  await page.keyboard.press('p');
  const [x, y] = await at(page, [10, 0, 10]);
  await page.mouse.click(x, y);
  await idle(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/· 2 curves$/]);
  const lines = await sketchLines(page);
  // The rims seen edge-on: two horizontal lines at v = 0 and v = 20; nothing vertical down the middle.
  expect(lines).toHaveLength(2);
  for (const l of lines) expect(Math.abs(l.ends[0][1] - l.ends[1][1])).toBeLessThan(1e-6);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix-p4-construction-purple a projected line made construction stays purple (dashed) in sketch mode and in model mode', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await paramBlock(page, 40, 20, 10);
  // A sketch on a plane 20 mm above Top (so its curves are not behind the block in either mode).
  await cad(page, (() => {
    const s = (window as unknown as W).__CAD__.services;
    const p = s.doc.beginNew('ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '20 mm' });
    p.commit();
  }) as never);
  await settled(page);
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="ref_plane"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  // ux010: the references are under the Sketch panel's Details.
  await openSketchDetails(page, frame);
  await page.keyboard.press('p');
  const [tx, ty] = await at(page, [20, 10, 10]);
  await page.mouse.click(tx, ty);
  await idle(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/· 4 curves$/]);
  await page.keyboard.press('Escape');
  const front = await at(page, [20, 0, 20]);
  await page.mouse.click(front[0], front[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="construction"]').click();
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
  // Somewhere along the dashed line a purple pixel (a dash), in sketch mode...
  const along = async () => {
    for (const u of [8, 14, 20, 26, 32]) if (await purpleNear(page, await at(page, [u, 0, 20]), 3)) return true;
    return false;
  };
  expect(await along()).toBe(true);
  // ... and in model mode.
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await settled(page);
  await idle(page);
  expect(await along()).toBe(true);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix-p7-intersect-words with no body, Intersect says it has nothing to intersect (not "project")', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOn(page, frame, 'top');
  const c = await commandControl(frame, 'sketch.intersect');
  await expect(c).toHaveAttribute('data-disabled-reason', 'There is no body before this sketch to intersect');
  await page.keyboard.press('Escape');
  const p = await commandControl(frame, 'sketch.project');
  await expect(p).toHaveAttribute('data-disabled-reason', 'There is no body before this sketch to project');
  expect(seen.errors).toEqual([]);
});
