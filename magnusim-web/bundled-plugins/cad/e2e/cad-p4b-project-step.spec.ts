// P4b SELECT, the proposal's exit gate (§7 P4b): a sketch on an imported face, with projected
// edges, survives a Delete-faces edit upstream. The projected edges either follow (the face's
// outer edges, unchanged by deleting a hole) or say "Lost reference" in amber (the hole's rim,
// gone with the hole), with no crash and no silent jump, and the sketch still solves.
// - always: the repository's synthetic flange (fixtures/kernel/flange.step: a 100 x 100 x 10
//   plate with 4 through holes r = 5), every step clicked as a user does (Import STEP, the top
//   face's menu, P and clicks, Roll back to here, Delete faces with the hole wall clicked, Roll
//   to end), the volume checked analytically;
// - with CAD_E2E_VORTEX_STEP: Daniel's Vortex part (read where it is, never copied), a sketch on
//   its largest flat face that the view shows, that face projected, and a face upstream deleted
//   (the first whose deletion OCCT heals into a valid solid).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chipVolumes, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLANGE = join(resolve(HERE, '..', 'fixtures', 'kernel'), 'flange.step');
const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';

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
const links = (frame: FrameLocator) => frame.locator('[data-sketch-links] [data-link]');
const featureRow = (frame: FrameLocator, type: string) => frame.locator(`[data-cad-tree] [data-feature-row][data-feature-type="${type}"]`);

async function idle(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
  await cad(page, (async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  }) as never);
}

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

async function importStep(page: Page, frame: FrameLocator, path: string) {
  const chooser = page.waitForEvent('filechooser');
  await frame.locator('[data-cad-toolbar] [data-command="file.import-step"]').click();
  await (await chooser).setFiles(path);
  const p = frame.locator('[data-cad-panel]');
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 180_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  await settled(page);
  await idle(page);
}

/**
 * A page point where the view's own pick finds this face (or edge) of the first body: the middle
 * of one of its triangles (an edge: one of its polyline's points), tried until the pick agrees.
 */
async function pointOn(page: Page, kind: 'face' | 'edge', index: number, kinds?: string[]): Promise<[number, number]> {
  const p = await tryPointOn(page, kind, index, kinds);
  expect(p, `a visible point of ${kind} ${index}`).not.toBeNull();
  return p!;
}

/** pointOn, or null when the view shows no point of it. */
async function tryPointOn(page: Page, kind: 'face' | 'edge', index: number, kinds?: string[]): Promise<[number, number] | null> {
  const xy = await cad<[number, number] | string>(page, ((a: { kind: string; index: number; kinds: string[] | null }) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const h = s.viewport.get().handle;
    const t = b.tess;
    const pts: number[][] = [];
    if (a.kind === 'face') {
      const st = t.faceRanges[2 * a.index];
      const n = t.faceRanges[2 * a.index + 1];
      for (let i = st; i < st + n; i += 3) {
        const v = [t.indices[i], t.indices[i + 1], t.indices[i + 2]];
        pts.push([0, 1, 2].map((k) => (t.positions[3 * v[0] + k] + t.positions[3 * v[1] + k] + t.positions[3 * v[2] + k]) / 3));
      }
    } else {
      const st = t.edgeRanges[2 * a.index];
      const n = t.edgeRanges[2 * a.index + 1];
      // The middles of its segments first (an end may be nearer another edge), then its points.
      for (let i = st; i + 1 < st + n; i++) pts.push([0, 1, 2].map((k) => (t.edgePositions[3 * i + k] + t.edgePositions[3 * (i + 1) + k]) / 2));
      for (let i = st; i < st + n; i++) pts.push([t.edgePositions[3 * i], t.edgePositions[3 * i + 1], t.edgePositions[3 * i + 2]]);
    }
    // Larger triangles first (their middles are well inside the face).
    const seen: string[] = [];
    for (const p of pts) {
      const c = h.project(p);
      if (!c) continue;
      const hit = a.kinds ? h.pickKinds(c[0], c[1], a.kinds) : h.pick(c[0], c[1]);
      if (hit && hit.item.kind === a.kind && hit.item.index === a.index && hit.item.body === b.id) return c;
      if (seen.length < 6) seen.push(hit ? `${hit.item.kind}:${hit.item.index ?? ''}@${Math.round(c[0])},${Math.round(c[1])}` : `none@${Math.round(c[0])},${Math.round(c[1])}`);
    }
    return `${a.kind} ${a.index}: ${pts.length} points, none picks it: ${seen.join(' ')}`;
  }) as never, { kind, index, kinds: kinds ?? null });
  if (typeof xy === 'string') {
    console.log(`[pointOn] ${xy}`);
    return null;
  }
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + xy[0], box.y + xy[1]];
}

/** The first body's faces: planar ones with their normal and area, cylinders with their axis and radius. */
async function faces(page: Page) {
  return cad<{ i: number; type: string; area: number; normal?: V3; centroid?: V3; axis?: { origin: V3; dir: V3 }; radius?: number; bbox?: number[] }[]>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const r = await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'exact', face_mass: true });
    return r.result.faces;
  }) as never);
}

/** The first body's edges with their faces and circle centres. */
async function edges(page: Page) {
  return cad<{ i: number; type: string; faces: number[]; center?: V3; radius?: number }[]>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const r = await s.kernel.call('topo', { id: b.shape, faces: 'none', edges: 'all', vertices: 'none' });
    return r.result.edges;
  }) as never);
}

/** A row's menu item (right-click on the row). */
async function rowMenu(frame: FrameLocator, row: ReturnType<FrameLocator['locator']>, item: string) {
  await row.locator('> .tree-row').click({ button: 'right' });
  await frame.locator(`[data-cad-menu] [data-menu-item="${item}"]`).click();
}

/** Start a sketch on a face as the user does: right-click it, "New sketch on this face". */
async function sketchOnFace(page: Page, frame: FrameLocator, face: number) {
  const [x, y] = await pointOn(page, 'face', face);
  await page.mouse.click(x, y, { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="sketch-mode:new-sketch"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
}

test("cad:p4b-project-step-gate a sketch on the flange's top face with its outer edges and a hole rim projected and a point snapped onto another rim; both holes deleted upstream: the outer edges stay, the rims are amber Lost references, the sketch still solves", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await importStep(page, frame, FLANGE);
  const fs = await faces(page);
  const top = fs.filter((f) => f.type === 'plane' && f.normal && f.normal[2] > 0.99).sort((a, b) => (b.centroid?.[2] ?? 0) - (a.centroid?.[2] ?? 0))[0];
  const holes = fs.filter((f) => f.type === 'cylinder');
  expect(holes).toHaveLength(4);
  const zTop = top.centroid![2];

  // The sketch on the top face; P; the face (its outer edges), then one hole's rim on the top.
  await sketchOnFace(page, frame, top.i);
  await page.keyboard.press('p');
  const [fx, fy] = await pointOn(page, 'face', top.i, ['vertex', 'edge', 'face']);
  await page.mouse.click(fx, fy);
  await idle(page);
  await expect(links(frame)).toHaveCount(1);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/^Projected: .+ · 4 curves$/]);
  const es = await edges(page);
  const hole = holes[0];
  const rim = es.find((e) => e.type === 'circle' && e.faces.includes(hole.i) && e.faces.includes(top.i))!;
  expect(rim, 'the hole rim on the top face').toBeTruthy();
  const [rx, ry] = await pointOn(page, 'edge', rim.i, ['vertex', 'edge', 'face']);
  await page.mouse.click(rx, ry);
  await idle(page);
  await expect(links(frame)).toHaveCount(2);
  await expect(links(frame).nth(1).locator('.cad-sk-link-name')).toHaveText(/^Projected: Edge .+ · 1 curve$/);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).toHaveAttribute('data-sketch-state', 'fully');
  // A point snapped onto a second hole's rim while drawing (not projected first): auto-projected, on curve.
  const hole2 = holes[1];
  const rim2 = es.find((e) => e.type === 'circle' && e.faces.includes(hole2.i) && e.faces.includes(top.i))!;
  await page.keyboard.press('Escape');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.point"], [data-cad-toolbar] [data-tb-more][data-more-commands~="sketch.point"]').first().click();
  if (await frame.locator('[data-cad-menu]').count()) await frame.locator('[data-cad-menu] [data-command="sketch.point"]').click();
  const [qx, qy] = await pointOn(page, 'edge', rim2.i, ['vertex', 'edge']);
  await page.mouse.move(qx + 1, qy + 1, { steps: 2 });
  await page.mouse.move(qx, qy);
  await expect(frame.locator('[data-sketch-infer="on-curve"]')).toHaveCount(1);
  await page.mouse.click(qx, qy);
  await idle(page);
  await page.keyboard.press('Escape');
  await expect(links(frame)).toHaveCount(3);
  await expect(links(frame).nth(2)).toHaveAttribute('data-link-auto', '1');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await settled(page);

  // Upstream: roll back to the import, Delete faces with that hole's wall clicked, roll to the end.
  await rowMenu(frame, featureRow(frame, 'import'), 'rollback');
  await settled(page);
  await idle(page);
  await runCommand(frame, 'modify.delete-faces');
  const panel = frame.locator('[data-cad-panel]');
  await expect(panel.locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  const [wx, wy] = await pointOn(page, 'face', hole.i);
  await page.mouse.click(wx, wy);
  await expect(panel.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1, { timeout: 30_000 });
  const [w2x, w2y] = await pointOn(page, 'face', hole2.i);
  await page.mouse.click(w2x, w2y);
  await expect(panel.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(2, { timeout: 30_000 });
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await rowMenu(frame, featureRow(frame, 'delete_faces'), 'roll-end');
  await settled(page);

  // The plate has 2 holes now; the sketch is built (amber: references lost), nothing failed.
  await expect.poll(async () => (await chipVolumes(frame)).map((v) => Math.round(v * 10) / 10)).toEqual([Math.round((100 * 100 * 10 - 2 * Math.PI * 25 * 10) * 10) / 10]);
  await expect(featureRow(frame, 'delete_faces')).toHaveAttribute('data-state', 'ok');
  const sk = featureRow(frame, 'sketch');
  await expect(sk).toHaveAttribute('data-state', 'warning');
  await expect(frame.locator('[data-cad-tree] [data-feature-row][data-state="error"]')).toHaveCount(0);
  await sk.locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  await expect(links(frame).nth(0)).toHaveAttribute('data-link-state', 'ok');
  await expect(links(frame).nth(0).locator('.cad-sk-link-name')).toHaveText(/· 4 curves$/);
  await expect(links(frame).nth(1)).toHaveAttribute('data-link-state', 'lost');
  await expect(links(frame).nth(1).locator('[data-link-message]')).toHaveText(/^Lost reference: Edge .+ not found after rebuild$/);
  await expect(links(frame).nth(2)).toHaveAttribute('data-link-state', 'lost');
  // Still solved (the snapped point keeps its one freedom along the lost rim): no silent jump of the outer
  // edges (they are where the plate's top edges are), the rims kept where they were.
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).toHaveAttribute('data-sketch-state', 'under');
  const outer = await cad<number[][]>(page, (() => {
    const m = (window as unknown as W).__CAD__.services.apis.get().sketch;
    const d = m.draft();
    const l = d.links[0];
    return l.entities.flatMap((r: { entity: string }) => {
      const e = d.entities.find((x: { id: string }) => x.id === r.entity);
      return e.p.map((p: string) => d.points[p]);
    });
  }) as never);
  const us = outer.map((p) => p[0]);
  const vs = outer.map((p) => p[1]);
  expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(100, 6);
  expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(100, 6);
  void zTop;
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-project-step-vortex (needs CAD_E2E_VORTEX_STEP) the Vortex: a sketch on its largest flat face, the face projected, a face deleted upstream: followed or an honest Lost reference, no crash', async ({ page, request }) => {
  test.skip(!VORTEX, 'CAD_E2E_VORTEX_STEP is not set: the Vortex case needs Daniel\'s STEP file');
  expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP names no file: ${VORTEX}`).toBe(true);
  test.setTimeout(480_000);
  const { seen, frame } = await freshPart(page, request);
  await importStep(page, frame, VORTEX);
  const fs = await faces(page);
  const flats = fs.filter((f) => f.type === 'plane').sort((a, b) => b.area - a.area);
  expect(flats.length).toBeGreaterThan(0);
  // The largest flat face the view shows.
  let support = flats[0];
  for (const f of flats) {
    if (await tryPointOn(page, 'face', f.i)) {
      support = f;
      break;
    }
  }
  await sketchOnFace(page, frame, support.i);
  await page.keyboard.press('p');
  // The sketch's own face (when the view along its normal shows it), else the first face the view shows there.
  let proj: [number, number] | null = null;
  for (const f of [support, ...flats, ...fs]) {
    proj = await tryPointOn(page, 'face', f.i, ['vertex', 'edge', 'face']);
    if (proj) break;
  }
  expect(proj, 'a face of the Vortex in view from the sketch').not.toBeNull();
  await page.mouse.click(proj![0], proj![1]);
  await idle(page);
  await expect(links(frame)).toHaveCount(1);
  await expect(links(frame).first()).toHaveAttribute('data-link-state', 'ok');
  const curves = Number(((await links(frame).first().locator('.cad-sk-link-name').textContent()) ?? '').match(/(\d+) curves?$/)?.[1]);
  expect(curves).toBeGreaterThan(0);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await settled(page);

  // A face to delete upstream: the first (not the sketch's) whose deletion heals into a valid solid.
  await rowMenu(frame, featureRow(frame, 'import'), 'rollback');
  await settled(page);
  await idle(page);
  // Each face's deletion tried on a work copy: healed into a valid solid, made but invalid, or refused.
  const tried: { i: number; how: string }[] = [];
  const nFaces = fs.length;
  for (let i = 0; i < nFaces; i++) {
    if (i === support.i) continue;
    // A stopped call restarts the kernel and the Part rebuilds: each try reads the body as it is now.
    await settled(page);
    tried.push(
      await cad<{ i: number; how: string }>(page, (async (face: number) => {
        const s = (window as unknown as W).__CAD__.services;
        const b = s.doc.state.get().rebuild.bodies[0];
        try {
          const r = await s.kernel.call('defeature', { id: b.shape, faces: [face] }, { timeoutMs: 8000 });
          await s.kernel.call('release', { ids: [r.result.id] }).catch(() => {});
          return { i: face, how: r.result.valid ? 'valid' : 'invalid' };
        } catch (err) {
          return { i: face, how: `refused: ${String((err as Error).message).slice(0, 60)}` };
        }
      }) as never, i),
    );
  }
  await settled(page);
  await idle(page);
  test.info().annotations.push({ type: 'vortex-delete-faces', description: JSON.stringify(tried) });
  console.log(`[vortex] support face ${support.i}; delete faces: ${tried.map((t) => `${t.i} ${t.how}`).join('; ')}`);
  // The first face in view whose deletion heals; else the first one OCCT makes (invalid: Delete faces is then red,
  // and the sketch after it must still build: no crash, no silent jump).
  let victim: number | null = null;
  for (const want of ['valid', 'invalid']) {
    for (const t of tried.filter((x) => x.how === want)) {
      if (await tryPointOn(page, 'face', t.i)) {
        victim = t.i;
        break;
      }
    }
    if (victim != null) break;
  }
  expect(victim, `a face of the Vortex that Delete faces can take, in view (${JSON.stringify(tried)})`).not.toBeNull();
  await runCommand(frame, 'modify.delete-faces');
  const panel = frame.locator('[data-cad-panel]');
  const [wx, wy] = await pointOn(page, 'face', victim!);
  await page.mouse.click(wx, wy);
  await expect(panel.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1, { timeout: 60_000 });
  await panel.locator('[data-panel-done]').click();
  await rowMenu(frame, featureRow(frame, 'delete_faces'), 'roll-end');
  await settled(page);
  await expect(frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"][data-state="error"]')).toHaveCount(0);
  const sk = featureRow(frame, 'sketch');
  await sk.locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  const state = await links(frame).first().getAttribute('data-link-state');
  console.log(`[vortex] deleted face ${victim}; the projection: ${state}; ${await links(frame).first().textContent()}; sketch ${await frame.locator('[data-cad-panel="sketch"] [data-sketch-state]').getAttribute('data-sketch-state')}`);
  expect(['ok', 'lost', 'changed']).toContain(state);
  if (state !== 'ok') await expect(links(frame).first().locator('[data-link-message]')).toHaveText(/^(Lost reference|Changed): .+/);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).not.toHaveAttribute('data-sketch-state', 'unsolved');
  expect(seen.errors).toEqual([]);
});

// ---- P4b fix round 1, B-1: an upstream edit that cuts INTO the projected loop (review: the kept lines ran
// diagonally across the face while the panel said "ok · Fully defined").
test('cad:p4b-fix-b1-fillet-into-loop the flange\'s top face projected; its vertical edges filleted upstream: the outline is re-projected, joined and right (lines shortened, arcs added, one region of the analytic area); a fillet face then deleted: its arc is an amber Lost reference left where it was and the lines meet at the corner again', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  await importStep(page, frame, FLANGE);
  const fs = await faces(page);
  const top = fs.filter((f) => f.type === 'plane' && f.normal && f.normal[2] > 0.99).sort((a, b) => (b.centroid?.[2] ?? 0) - (a.centroid?.[2] ?? 0))[0];
  await sketchOnFace(page, frame, top.i);
  await page.keyboard.press('p');
  const [fx, fy] = await pointOn(page, 'face', top.i, ['vertex', 'edge', 'face']);
  await page.mouse.click(fx, fy);
  await idle(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/^Projected: .+ · 4 curves$/]);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await settled(page);
  const skId = await cad<string>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((f: { type: string }) => f.type === 'sketch').id) as never);

  // Upstream: roll back to the import; Fillet the plate's vertical edges the view shows (r 5); roll to the end.
  await page.keyboard.press('7');
  await idle(page);
  await rowMenu(frame, featureRow(frame, 'import'), 'rollback');
  await settled(page);
  await idle(page);
  const verticals = (await edges(page)).filter((e) => e.type === 'line' && e.faces.length === 2 && !e.faces.includes(top.i)).map((e) => e.i);
  await runCommand(frame, 'modify.fillet');
  const panel = frame.locator('[data-cad-panel]');
  await expect(panel.locator('[data-feature-panel="fillet"]')).toBeVisible();
  // Where each vertical edge the view shows is, found before any is picked (the live fillet renumbers edges).
  const spots: [number, number][] = [];
  for (const e of verticals) {
    // A vertical edge has the top face on neither side; the plate's bottom edges are skipped by their height.
    const z = await cad<number>(page, ((i: number) => {
      const s = (window as unknown as W).__CAD__.services;
      const t = s.doc.state.get().rebuild.bodies[0].tess;
      const st = t.edgeRanges[2 * i];
      return Math.abs(t.edgePositions[3 * st + 2] - t.edgePositions[3 * (st + t.edgeRanges[2 * i + 1] - 1) + 2]);
    }) as never, e);
    if (z < 5) continue;
    const xy = await tryPointOn(page, 'edge', e, ['edge']);
    if (xy) spots.push(xy);
  }
  let n = 0;
  for (const xy of spots) {
    await page.mouse.click(xy[0], xy[1]);
    n++;
    await expect(panel.locator('[data-pick-field="edges"] [data-pick-row]')).toHaveCount(n, { timeout: 30_000 });
    await settled(page);
  }
  expect(n, 'vertical edges of the plate in view').toBeGreaterThanOrEqual(2);
  const r = panel.locator('.nui[data-field="radius"] input');
  await r.fill('5');
  await r.press('Enter');
  await settled(page);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await rowMenu(frame, featureRow(frame, 'fillet'), 'roll-end');
  await settled(page);
  await expect(featureRow(frame, 'fillet')).toHaveAttribute('data-state', 'ok');

  // Model mode: the sketch builds the rounded outline (no warning), one region of 100² − n·(25 − 25π/4):
  // a 1 mm extrude of it (set up through the document) has that volume.
  const area = 100 * 100 - n * (25 - (25 * Math.PI) / 4);
  const sk = featureRow(frame, 'sketch');
  await expect(sk).toHaveAttribute('data-state', 'ok');
  await cad(page, (async (id: string) => {
    const s = (window as unknown as W).__CAD__.services;
    const region = s.doc.state.get().rebuild.outputs[id].regions[0];
    const ex = s.doc.beginNew('extrude', { profiles: [{ sketch: id, region: region.key, entities: region.entities, sample: region.sample }], extent: { kind: 'blind', distance: '1 mm' }, op: 'new' });
    ex.commit();
  }) as never, skId);
  await settled(page);
  await expect.poll(async () => (await chipVolumes(frame)).map((v) => Math.round(v * 100) / 100)).toContain(Math.round(area * 100) / 100);
  expect(await cad<number>(page, ((id: string) => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.outputs[id].regions.length) as never, skId)).toBe(1);
  await page.keyboard.press('Control+z');
  await expect(featureRow(frame, 'extrude')).toHaveCount(0);

  // Opened: the References row says 4 + n curves, ok; every line is straight along X or Y (no diagonal), and
  // every end meets exactly one other curve (joined); the sketch is fully defined; no open profile.
  await sk.locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  await expect(links(frame).first()).toHaveAttribute('data-link-state', 'ok');
  await expect(links(frame).first().locator('.cad-sk-link-name')).toHaveText(new RegExp(`· ${4 + n} curves$`));
  const shape = await cad<{ diagonal: number; ends: number[] }>(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    const count = new Map<string, number>();
    let diagonal = 0;
    for (const e of d.entities) {
      if (!e.link) continue;
      const ends = e.kind === 'line' ? e.p : e.kind === 'arc' ? [e.a, e.b] : [];
      for (const p of ends) count.set(p, (count.get(p) ?? 0) + 1);
      if (e.kind === 'line') {
        const [a, b] = [d.points[e.p[0]], d.points[e.p[1]]];
        if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) diagonal++;
      }
    }
    return { diagonal, ends: [...new Set(count.values())] };
  }) as never);
  expect(shape).toEqual({ diagonal: 0, ends: [2] });
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).toHaveAttribute('data-sketch-state', 'fully');
  await expect(frame.locator('[data-open-end]')).toHaveCount(0);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await settled(page);

  // Delete faces of one fillet face (after the Fillet): that corner is sharp again.
  await page.keyboard.press('7');
  await idle(page);
  await rowMenu(frame, featureRow(frame, 'fillet'), 'rollback');
  await settled(page);
  await idle(page);
  const rounds = (await faces(page)).filter((f) => f.type === 'cylinder' && f.axis && Math.hypot(f.axis.origin[0], f.axis.origin[1]) > 55 && Math.abs((f.radius ?? 0) - 5) < 1e-6).map((f) => f.i);
  let picked: number | null = null;
  for (const f of rounds) if (await tryPointOn(page, 'face', f)) picked = f;
  expect(picked, 'a fillet face in view').not.toBeNull();
  await runCommand(frame, 'modify.delete-faces');
  await expect(panel.locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  const [dx, dy] = await pointOn(page, 'face', picked!);
  await page.mouse.click(dx, dy);
  await expect(panel.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1, { timeout: 30_000 });
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await rowMenu(frame, featureRow(frame, 'delete_faces'), 'roll-end');
  await settled(page);
  await expect(featureRow(frame, 'delete_faces')).toHaveAttribute('data-state', 'ok');
  await expect(sk).toHaveAttribute('data-state', 'warning');
  await expect(frame.locator('[data-cad-tree] [data-feature-row][data-state="error"]')).toHaveCount(0);
  await sk.locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  await expect(links(frame).first()).toHaveAttribute('data-link-state', 'lost');
  await expect(links(frame).first().locator('[data-link-message]')).toHaveText(/^Lost reference: Arc \d+ no longer on the model$/);
  // The lost arc is where it was (radius 5 at a corner); the lines meet at the sharp corner again (one point
  // at |u| = |v| = 50 shared by two lines); nothing lies on top of another.
  const after = await cad<{ cornerLines: number; arcR: number[]; dupLines: number }>(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    const lines = d.entities.filter((e: { kind: string; link?: string }) => e.kind === 'line' && e.link);
    const at = (p: string) => d.points[p];
    const corner = new Map<string, number>();
    for (const l of lines) for (const p of l.p) if (Math.abs(Math.abs(at(p)[0]) - 50) < 1e-6 && Math.abs(Math.abs(at(p)[1]) - 50) < 1e-6) corner.set(p, (corner.get(p) ?? 0) + 1);
    const key = (l: { p: string[] }) => l.p.map((p: string) => at(p).map((x: number) => x.toFixed(4)).join(',')).sort().join('|');
    const keys = lines.map(key);
    return {
      cornerLines: [...corner.values()].filter((c) => c === 2).length,
      arcR: d.entities.filter((e: { kind: string; link?: string }) => e.kind === 'arc' && e.link).map((e: { c: string; a: string }) => Math.round(Math.hypot(at(e.a)[0] - at(e.c)[0], at(e.a)[1] - at(e.c)[1]) * 1000) / 1000),
      dupLines: keys.length - new Set(keys).size,
    };
  }) as never);
  expect(after.cornerLines).toBe(5 - n);
  expect(after.arcR).toEqual(Array(n).fill(5));
  expect(after.dupLines).toBe(0);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).not.toHaveAttribute('data-sketch-state', 'unsolved');
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix-p5-one-body-name the References rows name the imported body one way: a projected corner "… of flange" and the Intersect row "flange"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await importStep(page, frame, FLANGE);
  await frame.locator('[data-tree-node="origin:right"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  await page.keyboard.press('p');
  const [vx, vy] = await modelOnPage(page, [50, -50, 10]);
  await page.mouse.click(vx, vy);
  await idle(page);
  await runCommand(frame, 'sketch.intersect');
  await frame.locator('[data-sketch-intersect] [data-sketch-action="intersect"]').click();
  await idle(page);
  await expect(links(frame).locator('.cad-sk-link-name')).toHaveText([/^Projected: Corner of Face \d+, Face \d+ and Face \d+ of flange · 1 curve$/, /^Intersection: flange · \d+ curves$/]);
  // Where a face came from stays in the row's tooltip (the import's words).
  await expect(links(frame).first().locator('.cad-sk-link-name')).toHaveAttribute('title', /of flange, from .+/);
  expect(seen.errors).toEqual([]);
});
