// The Ellipse group in the real host frame, each asserting what the person sees: the
// tools' hints, the status chip's DOF, the entities drawn, the profiles Extrude offers
// and the volume chip, checked against the closed forms.
//  - Ellipse: centre, major end, minor radius: 5 DOF; extruded, pi a b h.
//  - Partial ellipse (the arc runs the way the pointer goes), Parabola and Conic, each
//    closed by a line snapped to its ends: 7, 6 and 6 DOF as drawn; three profiles that
//    extrude to half an ellipse, two thirds of the parabola's box and the conic's area.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { rationalQuad } from '../src/sketch/tools/conic';
import { chipVolumes, newPartFromTree, newProject, openProject, partOpened, runCommand, singleVolume, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
type V2 = [number, number];

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** Page coordinates of a model point. */
async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await workspaceFrame(page).evaluate((pt) => {
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { project(p: number[]): [number, number] | null } | null } } } } }).__CAD__.services.viewport.get().handle;
    return h ? h.project(pt) : null;
  }, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

async function settled(page: Page) {
  await expect
    .poll(() =>
      workspaceFrame(page).evaluate(() => {
        const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } | null } } } } }).__CAD__.services.viewport.get().handle;
        return h ? h.state.get().animating : true;
      }),
    )
    .toBe(false);
}

async function sketchIdle(page: Page) {
  await workspaceFrame(page).evaluate(async () => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { idle?(): Promise<void> } | null } } } } }).__CAD__.services.apis.get().sketch;
    await api?.idle?.();
  });
}

const clickAt = async (page: Page, p: V2) => {
  const [x, y] = await at(page, [p[0], p[1], 0]);
  await page.mouse.click(x, y);
};
const moveTo = async (page: Page, p: V2) => {
  const [x, y] = await at(page, [p[0], p[1], 0]);
  await page.mouse.move(x, y);
};

type Ent = { id: string; kind: string; [k: string]: unknown };
/** The sketch being edited, as drawn now: its entities and its points. */
async function drawn(page: Page): Promise<{ kinds: Record<string, number>; points: Record<string, V2>; entities: Ent[] }> {
  return workspaceFrame(page).evaluate(() => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { draft(): { points: Record<string, [number, number]>; entities: { id: string; kind: string; construction?: boolean }[] } | null } } } } } }).__CAD__.services.apis.get().sketch;
    const d = api.draft();
    const kinds: Record<string, number> = {};
    for (const e of d?.entities ?? []) if (!e.construction) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    return { kinds, points: d?.points ?? {}, entities: (d?.entities ?? []) as Ent[] };
  });
}

const chip = (frame: FrameLocator) => frame.locator('[data-chip="sketch"]');
const hint = (frame: FrameLocator) => frame.locator('[data-cad-panel="sketch"] [data-sketch-hint]');

async function enterSketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

async function finish(frame: FrameLocator) {
  await runCommand(frame, 'sketch.finish');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

/** Extrude every profile of the sketch named: the profiles it offers, then H typed and Done. */
async function extrudeAll(frame: FrameLocator, sketch: string, profiles: number, h: number) {
  const row = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(?:[(]-[)] )?${sketch}$`) }) });
  await row.locator('> .tree-row').click();
  await runCommand(frame, 'solid.extrude');
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-profile-list] [data-profile]')).toHaveCount(profiles);
  const dist = p.locator('.nui[data-field="distance"] input');
  await dist.fill(String(h));
  await dist.press('Enter');
  await expect(p.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
}

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: V2) => Math.hypot(a[0], a[1]);
/** An ellipse's radii from its stored centre, major end and minor end. */
function radii(pts: Record<string, V2>, e: Ent): { a: number; b: number } {
  const c = pts[e.c as string];
  const m = sub(pts[e.major as string], c);
  const n = sub(pts[e.minor as string], c);
  const a = len(m);
  return { a, b: Math.abs((m[0] * n[1] - m[1] * n[0]) / a) };
}

test('cad:ellipse-draw-extrude Ellipse: centre, major end, minor radius; 5 DOF; extruded to pi a b h', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await runCommand(frame, 'sketch.ellipse');
  await expect(hint(frame)).toContainText('Click the centre of the ellipse');
  await clickAt(page, [5, 5]);
  await expect(hint(frame)).toContainText('an end of the major axis');
  await clickAt(page, [35, 5]);
  await expect(hint(frame)).toContainText('the minor radius');
  await clickAt(page, [7, 17]);
  await sketchIdle(page);
  const d = await drawn(page);
  expect(d.kinds).toEqual({ ellipse: 1 });
  await expect(chip(frame)).toHaveText('Under defined · 5 DOF');
  const { a, b } = radii(d.points, d.entities[0]);
  expect(Math.abs(a - 30)).toBeLessThan(0.5);
  expect(Math.abs(b - 12)).toBeLessThan(0.5);
  await page.keyboard.press('Escape');
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 1, 10);
  await expect.poll(async () => Math.abs((await singleVolume(frame)) / (Math.PI * a * b * 10) - 1)).toBeLessThan(1e-6);
  expect(seen.errors).toEqual([]);
});

test('cad:ellipse-group-profiles Partial ellipse, Parabola and Conic closed by lines: 7, 6 and 6 DOF; three profiles extrude to their closed-form areas', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);

  // Partial ellipse: centre (-20, 0), major end (-5, 0), minor radius 8; from the major end over the top to (-35, 0).
  await runCommand(frame, 'sketch.ellipse-partial');
  await clickAt(page, [-20, 0]);
  await clickAt(page, [-5, 0]);
  await clickAt(page, [-18, 8]);
  await expect(hint(frame)).toContainText('Click where the partial ellipse starts');
  await clickAt(page, [-5, 0]);
  for (let deg = 15; deg <= 165; deg += 15) await moveTo(page, [-20 + 15 * Math.cos((deg * Math.PI) / 180), 8 * Math.sin((deg * Math.PI) / 180)]);
  await clickAt(page, [-35, 0]);
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.kinds).toEqual({ ellipse_arc: 1 });
  await expect(chip(frame)).toHaveText('Under defined · 7 DOF');
  const half = d.entities.find((e) => e.kind === 'ellipse_arc')!;
  const hr = radii(d.points, half);
  await page.keyboard.press('Escape');
  // Its chord: a line snapped to its two ends.
  await page.keyboard.press('l');
  await clickAt(page, [-35, 0]);
  await clickAt(page, [-5, 0]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  const chord = d.entities.find((e) => e.kind === 'line')! as Ent & { p: string[] };
  expect([...chord.p].sort()).toEqual([half.a as string, half.b as string].sort());

  // Parabola: focus (15, 15), vertex (10, 15), ends 8 below and above the axis.
  await runCommand(frame, 'sketch.parabola');
  await expect(hint(frame)).toContainText('Click the focus of the parabola');
  await clickAt(page, [15, 15]);
  await clickAt(page, [10, 15]);
  await clickAt(page, [14, 7]);
  await clickAt(page, [14, 23]);
  await sketchIdle(page);
  d = await drawn(page);
  const par = d.entities.find((e) => e.kind === 'parabola')!;
  const pa = d.points[par.a as string];
  const pb = d.points[par.b as string];
  const focal = len(sub(d.points[par.f as string], d.points[par.v as string]));
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  await clickAt(page, pb);
  await clickAt(page, pa);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Conic: ends (10, -30) and (35, -30), top (15, -12), passing near (19.5, -22.8) (rho 0.4).
  await runCommand(frame, 'sketch.conic');
  await clickAt(page, [10, -30]);
  await clickAt(page, [35, -30]);
  await expect(hint(frame)).toContainText('top point');
  await clickAt(page, [15, -12]);
  await expect(frame.locator('[data-sketch-box="rho"]')).toBeVisible();
  await clickAt(page, [19.5, -22.8]);
  await sketchIdle(page);
  d = await drawn(page);
  const con = d.entities.find((e) => e.kind === 'conic')!;
  expect(con.rho as number).toBeGreaterThan(0.35);
  expect(con.rho as number).toBeLessThan(0.45);
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  await clickAt(page, [35, -30]);
  await clickAt(page, [10, -30]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.kinds).toEqual({ ellipse_arc: 1, parabola: 1, conic: 1, line: 3 });

  // The areas from the curves as placed: half the ellipse; two thirds of the parabola's box; the conic's by Green.
  const halfArea = (Math.PI * hr.a * hr.b) / 2;
  const span = Math.abs(pb[1] - pa[1]);
  const parArea = (2 / 3) * span * ((span / 2) ** 2 / (4 * focal));
  const P0 = d.points[con.a as string];
  const P2 = d.points[con.b as string];
  const P1 = d.points[con.t as string];
  const w = (con.rho as number) / (1 - (con.rho as number));
  let conArea = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const p = rationalQuad(P0, P1, P2, w, i / N)[0];
    const q = rationalQuad(P0, P1, P2, w, (i + 1) / N)[0];
    conArea += (p[0] * q[1] - q[0] * p[1]) / 2;
  }
  conArea += (P2[0] * P0[1] - P0[0] * P2[1]) / 2;
  conArea = Math.abs(conArea);

  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 3, 5);
  const want = (halfArea + parArea + conArea) * 5;
  await expect.poll(async () => (await chipVolumes(frame)).reduce((s, v) => s + v, 0)).toBeGreaterThan(0);
  await expect.poll(async () => Math.abs((await chipVolumes(frame)).reduce((s, v) => s + v, 0) / want - 1)).toBeLessThan(1e-5);
  expect(seen.errors).toEqual([]);
});
