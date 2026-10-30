// ux010 (DRAW, Daniel: "some other mouse thing would be ideal ... can points be round and not
// square?"), in the real host frame:
//  - sketch cursors are our own SVGs (data: URIs the frame's CSP allows) with the keyword as the
//    fallback: the Line tool's crosshair with the line icon (crosshair); under the Select tool the
//    small arrow with a tiny icon of what is under it (Daniel 2026-10-28: the hand "gets way too
//    big"), a free point's and a fully defined line's alike (fallback default); a drag under way and
//    the fillet's radius arrow: the small drag cursor (fallback move); never a hand; the browser
//    takes the value (computed style);
//  - the cursor names the kind before the sketch's analysis is in (CI run 37);
//  - sketch-hover-kinds (light) and sketch-hover-kinds-dark (serial: the look is the person's
//    pref): over a line, a point, an arc, a circle and an ellipse the arrow shows that kind's icon;
//    a hovered point is drawn larger in a disk of the hover colour, and a clicked point keeps its
//    pick-colour ring after the pointer leaves (pixels on screen);
//  - sketch points are round: the points' material cuts a circle, and on screen a point's centre
//    is its colour while the corner of its old square is not;
//  - the cursor SVGs decode at 1x and 2x (and, with CAD_UX010_SHOTS=<dir>, a sheet of them on a
//    light and a dark ground is written there as cursor-*.png, the points as points-*.png).
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { cursorSvg, PICK_KINDS, type SketchCursorKind } from '../src/sketch/cursors';
import { SKETCH_ICONS } from '../src/sketch/icons';
import { ensureCadOn, newPartFromTree, newProject, openProject, partOpened, pickTheme, putLookBackAfterSerialTests, runCommand, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type V3 = [number, number, number];
type V2 = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

const SHOTS = process.env.CAD_UX010_SHOTS || '';

// sketch-hover-kinds-dark changes the look (Settings): light again after it.
putLookBackAfterSerialTests();

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  await ensureCadOn(request);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

async function cad<T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown): Promise<T> {
  return workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
}

async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await cad<[number, number] | null>(page, ((pt: V3) => (window as unknown as W).__CAD__.services.viewport.get().handle?.project(pt) ?? null) as never, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

async function settled(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
}

async function sketchIdle(page: Page) {
  await cad(page, (async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  }) as never);
}

const clickAt = async (page: Page, p: V2) => {
  const [x, y] = await at(page, [p[0], p[1], 0]);
  await page.mouse.click(x, y);
};

async function enterSketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

/** The canvas cursor: what was set (inline), what the browser computed, and which kind the sketch asked for. */
const cursor = (page: Page) =>
  cad<{ inline: string; computed: string; kind: string }>(page, (() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-cad-canvas]')!;
    return { inline: c.style.cursor, computed: getComputedStyle(c).cursor, kind: c.dataset.sketchCursor ?? '' };
  }) as never);

/** The SVG a cursor value shows (its first url, decoded). */
const svgOf = (value: string) => decodeURIComponent(/url\("data:image\/svg\+xml,([^"]+)"\)/.exec(value)?.[1] ?? '');

/** The open hand's longest finger: a sketch never shows it now (Daniel 2026-10-28). */
const HAND = 'M14.4 14V4.6';

async function expectCursor(page: Page, kind: string, fallback: string, contains?: string) {
  await expect.poll(async () => (await cursor(page)).kind).toBe(kind);
  const c = await cursor(page);
  if (kind === 'default') {
    expect(c.inline).toBe('default');
    return;
  }
  expect(c.inline).toContain('url("data:image/svg+xml,');
  expect(c.inline.trim().endsWith(`, ${fallback}`), c.inline.slice(-40)).toBe(true);
  // The browser took it (an unsupported value would have left the keyword or nothing).
  expect(c.computed).toContain('url(');
  expect(svgOf(c.inline)).not.toContain(HAND);
  expect(c.computed).not.toMatch(/grab/);
  if (contains) expect(svgOf(c.inline)).toContain(contains);
}

test('cad:ux010-cursors the sketch cursors are our own SVGs with a keyword fallback: Line crosshair with its icon, the small arrow with the point icon on a free point and the line icon on a fully defined line, the small drag cursor while dragging and on the fillet arrow, never a hand', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  // A fully defined 40 x 20 rectangle from the origin, and a free line.
  await page.keyboard.press('r');
  await clickAt(page, [0, 0]);
  const [rx, ry] = await at(page, [28, 14, 0]);
  await page.mouse.move(rx, ry);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type('40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  // The Line tool: the crosshair with the line icon at its lower right; fallback crosshair.
  const [mx, my] = await at(page, [-30, 30, 0]);
  await page.mouse.move(mx, my);
  await expectCursor(page, 'crosshair', 'crosshair', SKETCH_ICONS.line.slice(0, 12));
  // 1x and 2x images (crisp at 150 % and 200 %), the hotspot given once, in CSS px.
  expect((await cursor(page)).inline).toMatch(/image-set\(url\("data:image\/svg\+xml,[^"]+"\) 1x, url\("data:image\/svg\+xml,[^"]+"\) 2x\) 10 10, crosshair$/);
  await clickAt(page, [-40, 30]);
  await clickAt(page, [-10, 40]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  // The Select tool on the free line's end: the small arrow with the point icon (fallback default).
  const [px, py] = await at(page, [-10, 40, 0]);
  await page.mouse.move(px + 30, py + 30);
  await page.mouse.move(px, py, { steps: 3 });
  // Daniel (2026-10-28): no hand; the kind under the pointer, tiny, beside the arrow.
  await expectCursor(page, 'pick:point', 'default', 'data-pick="point"');
  // Dragging it: the small drag cursor (fallback move).
  await page.mouse.down();
  await page.mouse.move(px + 20, py, { steps: 4 });
  await expectCursor(page, 'drag', 'move', 'data-drag="1"');
  await page.mouse.up();
  await sketchIdle(page);
  // A fully defined line: the line icon too (it can't be dragged: its colour says it is defined).
  const [lx, ly] = await at(page, [20, 0, 0]);
  await page.mouse.move(lx, ly, { steps: 3 });
  await expectCursor(page, 'pick:line', 'default', 'data-pick="line"');
  // The fillet's radius arrow: the small drag cursor on the arrow element.
  await runCommand(frame, 'sketch.fillet');
  await clickAt(page, [40, 20]);
  await sketchIdle(page);
  const handle = frame.locator('[data-sketch-handle]');
  await expect(handle).toHaveCount(1);
  if (SHOTS) {
    // The fillet corner (the review's "before" shot showed its square points), for points-after.
    const [fx, fy] = await at(page, [40, 20, 0]);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'points-after-fillet-corner.png'), clip: { x: fx - 130, y: fy - 60, width: 180, height: 140 } });
  }
  const hc = await handle.evaluate((el) => ({ inline: (el as HTMLElement).style.cursor, computed: getComputedStyle(el).cursor }));
  expect(hc.inline).toContain('url("data:image/svg+xml,');
  expect(hc.inline.trim().endsWith(', move')).toBe(true);
  expect(svgOf(hc.inline)).toContain('data-drag="1"');
  expect(svgOf(hc.inline)).not.toContain(HAND);
  expect(hc.computed).toContain('url(');
  expect(seen.errors).toEqual([]);
  expect(seen.csp, 'CSP violations (a cursor image refused)').toEqual([]);
});

test('cad:ux010-cursor-analysis the cursor names the kind under the pointer before the sketch analysis is in and after it lands: the origin and a free end the point icon, the line the line icon, never a hand (CI run 37)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await page.keyboard.press('l');
  await clickAt(page, [10, 10]);
  await clickAt(page, [40, 10]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  // A slow machine: the analysis not in yet when the pointer arrives.
  await cad(page, (() => {
    const v = (window as unknown as W).__CAD__.services.apis.get().sketch.view;
    (window as unknown as { __heldAnalysis: unknown }).__heldAnalysis = v.get().analysis;
    v.set({ analysis: null });
  }) as never);
  const [ox, oy] = await at(page, [0, 0, 0]);
  await page.mouse.move(ox - 40, oy + 40);
  await page.mouse.move(ox, oy, { steps: 4 });
  await expectCursor(page, 'pick:point', 'default', 'data-pick="point"');
  const [ex, ey] = await at(page, [40, 10, 0]);
  await page.mouse.move(ex + 30, ey);
  await page.mouse.move(ex, ey, { steps: 4 });
  await expect.poll(() => cad<string | null>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().hover?.id ?? null) as never)).not.toBeNull();
  await expectCursor(page, 'pick:point', 'default', 'data-pick="point"');
  // The analysis lands; the pointer does not move: the same point icon.
  await cad(page, (() => {
    const v = (window as unknown as W).__CAD__.services.apis.get().sketch.view;
    v.set({ analysis: (window as unknown as { __heldAnalysis: unknown }).__heldAnalysis });
  }) as never);
  await expectCursor(page, 'pick:point', 'default', 'data-pick="point"');
  // The line between: the line icon; back on the origin: the point icon.
  const [mx, my] = await at(page, [25, 10, 0]);
  await page.mouse.move(mx, my, { steps: 4 });
  await expectCursor(page, 'pick:line', 'default', 'data-pick="line"');
  await page.mouse.move(ox, oy, { steps: 4 });
  await expectCursor(page, 'pick:point', 'default', 'data-pick="point"');
  expect(seen.errors).toEqual([]);
});

test('cad:ux010-points sketch points are round: the material cuts a circle; on screen the centre is the point colour and the corner of the old square is not', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await expect(frame.locator('[data-sketch-annotations]')).toHaveAttribute('data-sketch-points', 'round');
  // A point on its own, away from the grid's axes; the pointer far from it (no hover colour).
  await page.keyboard.press('Escape');
  await runCommand(frame, 'sketch.point');
  await clickAt(page, [23.3, 17.7]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const [qx, qy] = await at(page, [-40, -30, 0]);
  await page.mouse.move(qx, qy);
  await settled(page);
  const [cx, cy] = await at(page, [23.3, 17.7, 0]);
  const size = 24;
  const clip = { x: Math.round(cx) - size / 2, y: Math.round(cy) - size / 2, width: size, height: size };
  // Two frames so the last pointer move is drawn.
  await cad(page, (() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))) as never);
  const buf = await page.screenshot({ clip });
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'points-after.png'), clip: { x: clip.x - 28, y: clip.y - 28, width: 80, height: 80 } });
  }
  const img = PNG.decode(buf);
  const px = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // The point's colour: under-defined blue (#1570ef).
  const blue = [0x15, 0x70, 0xef];
  const mid = size / 2;
  const centre = px(mid, mid);
  expect(dist(centre, blue), `centre ${centre}`).toBeLessThan(60);
  // The 7 px square's corner (3 px off the centre both ways) is outside the round dot: not blue.
  const s = img.width / size;
  for (const [dx, dy] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    const corner = px(Math.round((mid + dx) * s), Math.round((mid + dy) * s));
    expect(dist(corner, blue), `corner ${dx},${dy}: ${corner}`).toBeGreaterThan(110);
  }
  expect(seen.errors).toEqual([]);
});

test('cad:ux010-cursor-sheet each sketch cursor decodes at 1x and 2x', async ({ browser }) => {
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 900, height: 520 } });
  const page = await ctx.newPage();
  const kinds: [SketchCursorKind, string | null, string][] = [
    ['draw', SKETCH_ICONS.line, 'Line'],
    ['draw', SKETCH_ICONS.rectangle, 'Rectangle'],
    ['draw', SKETCH_ICONS.circle, 'Circle'],
    ['draw', SKETCH_ICONS.arc, 'Arc'],
    ['draw', SKETCH_ICONS.trim, 'Trim'],
    ['draw', SKETCH_ICONS.dimension, 'Dimension'],
    ...PICK_KINDS.map((k): [SketchCursorKind, string | null, string] => ['pick', k, `Over a sketch ${k}`]),
    ['drag', null, 'Dragging, a drag handle'],
    ['grab', null, 'Open hand: the 3D banana'],
    ['grabbing', null, 'Closed hand: the 3D banana dragged'],
  ];
  const cell = (tone: 'light' | 'dark') => (k: [SketchCursorKind, string | null, string]) => {
    const one = `data:image/svg+xml,${encodeURIComponent(cursorSvg(k[0], k[1], 32, tone))}`;
    const two = `data:image/svg+xml,${encodeURIComponent(cursorSvg(k[0], k[1], 64, tone))}`;
    return `<div class="c"><img src="${one}" width="32" height="32"><img src="${two}" width="64" height="64"><span>${k[2]}</span></div>`;
  };
  await page.setContent(
    `<style>body{margin:0;font:12px Segoe UI,sans-serif}.g{display:flex;flex-wrap:wrap;gap:10px;padding:12px}.l{background:#f5f6f8;color:#101828}.d{background:#1d2433;color:#e6e8ec}.c{display:flex;align-items:center;gap:8px;width:270px}</style>` +
      `<div class="g l">${kinds.map(cell('light')).join('')}</div><div class="g d">${kinds.map(cell('dark')).join('')}</div>`,
  );
  const sizes = await page.locator('img').evaluateAll((els) => els.map((e) => [(e as HTMLImageElement).naturalWidth, (e as HTMLImageElement).complete]));
  for (const [w, done] of sizes) {
    expect(done).toBe(true);
    expect([32, 64]).toContain(w);
  }
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'cursor-after-sheet-2x.png'), scale: 'device' });
    await page.screenshot({ path: join(SHOTS, 'cursor-after-sheet-1x.png'), scale: 'css' });
  }
  await ctx.close();
});

/** The sketch being edited, as drawn now (points and entities). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const draftOf = (page: Page) => cad<{ points: Record<string, V2>; entities: any[] }>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.draft()) as never);

/** Where on the screen to hover each kind: a place on the curve away from its points (sketch u/v). */
function onCurve(d: Awaited<ReturnType<typeof draftOf>>, kind: string): V2 {
  const e = d.entities.find((x) => x.kind === kind);
  expect(e, `a ${kind} in the sketch`).toBeTruthy();
  const P = (id: string) => d.points[id];
  if (kind === 'line') {
    const [a, b] = e.p.map(P);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  if (kind === 'circle') return [P(e.c)[0], P(e.c)[1] + e.r];
  if (kind === 'arc') {
    const c = P(e.c);
    const a = P(e.a);
    const b = P(e.b);
    const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    const a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
    const tau = 2 * Math.PI;
    const sweep = e.ccw === false ? -((((a0 - a1) % tau) + tau) % tau) : (((a1 - a0) % tau) + tau) % tau;
    const m = a0 + sweep / 2;
    return [c[0] + r * Math.cos(m), c[1] + r * Math.sin(m)];
  }
  if (kind === 'ellipse') {
    const c = P(e.c);
    const M = P(e.major);
    const n = P(e.minor);
    const R = Math.hypot(M[0] - c[0], M[1] - c[1]);
    const r = Math.hypot(n[0] - c[0], n[1] - c[1]);
    const u: V2 = [(M[0] - c[0]) / R, (M[1] - c[1]) / R];
    const t = Math.PI / 4;
    return [c[0] + u[0] * R * Math.cos(t) - u[1] * r * Math.sin(t), c[1] + u[1] * R * Math.cos(t) + u[0] * r * Math.sin(t)];
  }
  // A point entity.
  return P(e.p);
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const blend = (top: RGB, under: number[], a: number): RGB => [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)) as RGB;

/**
 * The colours `r` CSS px from a sketch point's centre on screen, along the four diagonals (clear of
 * horizontal and vertical lines through it), two frames after the last change. The centre is where
 * the dot is drawn: the middle of the pixels of its colour `dot` near the projected place (the
 * drawn sprite sits up to a pixel off the projection).
 */
async function ringColours(page: Page, uv: V2, r: number, dot: RGB): Promise<number[][]> {
  await cad(page, (() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))) as never);
  const [cx, cy] = await at(page, [uv[0], uv[1], 0]);
  const size = 40;
  const clip = { x: Math.round(cx) - size / 2, y: Math.round(cy) - size / 2, width: size, height: size };
  const img = PNG.decode(await page.screenshot({ clip }));
  const s = img.width / size;
  const px = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  let sx = 0;
  let sy = 0;
  let n = 0;
  const reach = 8 * s;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (Math.hypot(x + 0.5 - (cx - clip.x) * s, y + 0.5 - (cy - clip.y) * s) > reach) continue;
      if (dist(px(x, y), dot) > 60) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      n++;
    }
  expect(n, `the dot (${dot}) is drawn near ${uv}`).toBeGreaterThan(4);
  const ox = sx / n;
  const oy = sy / n;
  return [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ].map(([dx, dy]) => px(Math.floor(ox + ((dx * r) / Math.SQRT2) * s), Math.floor(oy + ((dy * r) / Math.SQRT2) * s)));
}

/** At least three of the four diagonals within `tol` of `want`. */
function mostly(cs: number[][], want: number[], tol: number, what: string) {
  const near = cs.filter((c) => dist(c, want) < tol).length;
  expect(near, `${what}: ${JSON.stringify(cs)} vs ${want.map(Math.round)}`).toBeGreaterThanOrEqual(3);
}

/**
 * Daniel (2026-10-28): a line, a point, an arc, a circle and an ellipse drawn with the tools; over
 * each the Select tool's arrow shows that kind's tiny icon (never the hand); then a point: hovered,
 * larger in a disk of the hover colour; clicked, ringed in the pick colour after the pointer leaves.
 */
async function hoverKindsAndPoints(page: Page, frame: FrameLocator, theme: 'light' | 'dark') {
  await page.keyboard.press('l');
  await clickAt(page, [-40, 30]);
  await clickAt(page, [-12, 42]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await clickAt(page, [30, 28]);
  await clickAt(page, [40, 28]);
  await page.keyboard.press('Escape');
  await runCommand(frame, 'sketch.arc');
  await clickAt(page, [-44, -24]);
  await clickAt(page, [-22, -24]);
  await clickAt(page, [-33, -15]);
  await page.keyboard.press('Escape');
  await runCommand(frame, 'sketch.ellipse');
  await clickAt(page, [32, -26]);
  await clickAt(page, [46, -26]);
  await clickAt(page, [32, -20]);
  await page.keyboard.press('Escape');
  await runCommand(frame, 'sketch.point');
  await clickAt(page, [3.3, 17.7]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  await expect.poll(() => cad<string>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.tool.id) as never)).toBe('select');
  const d = await draftOf(page);
  expect(d.entities.map((e) => e.kind).sort()).toEqual(['arc', 'circle', 'ellipse', 'line', 'point']);
  const far: V2 = [0, -45];
  for (const kind of PICK_KINDS) {
    const [fx, fy] = await at(page, [far[0], far[1], 0]);
    await page.mouse.move(fx, fy);
    await expectCursor(page, 'default', 'default');
    const [x, y] = await at(page, [...onCurve(d, kind), 0] as V3);
    await page.mouse.move(x, y, { steps: 4 });
    await expectCursor(page, `pick:${kind}`, 'default', `data-pick="${kind}"`);
    const c = await cursor(page);
    // The image in this view's tone: dark ink on light, white on dark.
    if (theme === 'light') expect(svgOf(c.inline)).toContain('fill="#101828"');
    else expect(svgOf(c.inline)).not.toContain('#101828');
  }

  // The point: off it, then hovered, then clicked and left.
  const pe = d.entities.find((e) => e.kind === 'point');
  const P = d.points[pe.p];
  const pal = theme === 'light' ? { preview: '#1570ef', hover: '#b2ccff', pick: '#2ec47e', opacity: 0.85 } : { preview: '#7aa7ff', hover: '#b2ccff', pick: '#2ec47e', opacity: 0.45 };
  const [fx, fy] = await at(page, [far[0], far[1], 0]);
  await page.mouse.move(fx, fy);
  await expect.poll(() => cad<string | null>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().hover?.id ?? null) as never)).toBeNull();
  // r 4.5: outside the plain 7 px dot, inside the hovered 11 px one; r 7: in the hover disk
  // (17 px), clear of the dot; r 7.4: in the selection ring (17 px, 2.2 px thick).
  const blue = hex(pal.preview);
  const green = hex(pal.pick);
  const ground = await ringColours(page, P, 7, blue);
  const before4 = await ringColours(page, P, 4.5, blue);
  for (const c of before4) expect(dist(c, blue), `plain dot is 7 px: ${c}`).toBeGreaterThan(60);
  const [px, py] = await at(page, [P[0], P[1], 0]);
  await page.mouse.move(px, py, { steps: 4 });
  await expectCursor(page, 'pick:point', 'default', 'data-pick="point"');
  mostly(await ringColours(page, P, 4.5, blue), blue, 70, 'the hovered point drawn larger');
  const disk = await ringColours(page, P, 7, blue);
  for (let i = 0; i < 4; i++) expect(dist(disk[i], blend(hex(pal.hover), ground[i], pal.opacity)), `hover disk ${i}: ${disk[i]} on ${ground[i]}`).toBeLessThan(40);
  for (let i = 0; i < 4; i++) expect(dist(disk[i], ground[i]), 'the disk shows').toBeGreaterThan(theme === 'light' ? 25 : 60);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `point-hover-${theme}.png`), clip: { x: Math.round(px) - 30, y: Math.round(py) - 30, width: 60, height: 60 } });
  }
  // Click it: selected; the pointer leaves: the ring stays, the disk goes, the dot is its plain size.
  await page.mouse.click(px, py);
  await expect.poll(() => cad<string[]>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.selected().map((h: { id: string }) => h.id)) as never)).toEqual([pe.id]);
  await page.mouse.move(fx, fy, { steps: 4 });
  await expect.poll(() => cad<string | null>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().hover?.id ?? null) as never)).toBeNull();
  mostly(await ringColours(page, P, 7.4, green), green, 70, 'the selected point\'s ring');
  for (const c of await ringColours(page, P, 5, green)) expect(dist(c, green), `the gap inside the ring: ${c}`).toBeGreaterThan(80);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `point-selected-${theme}.png`), clip: { x: Math.round(px) - 30, y: Math.round(py) - 30, width: 60, height: 60 } });
  // Escape lets go of it: no ring.
  await page.keyboard.press('Escape');
  for (const c of await ringColours(page, P, 7.4, blue)) expect(dist(c, green), `no ring after Escape: ${c}`).toBeGreaterThan(80);
}

test('cad:sketch-hover-kinds over a line, a point, an arc, a circle and an ellipse the arrow shows that kind\'s tiny icon, never a hand; a hovered point grows in its hover disk, a clicked one keeps its ring (light)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await hoverKindsAndPoints(page, frame, 'light');
  expect(seen.errors).toEqual([]);
  expect(seen.csp).toEqual([]);
});

test('cad:sketch-hover-kinds-dark the same in dark: the white arrow with each kind\'s icon, the hovered point\'s disk fainter over the background, the selected point\'s ring', { tag: '@serial' }, async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await pickTheme(page, 'dark');
  await enterSketchOnTop(page, frame);
  await hoverKindsAndPoints(page, frame, 'dark');
  expect(seen.errors).toEqual([]);
});
