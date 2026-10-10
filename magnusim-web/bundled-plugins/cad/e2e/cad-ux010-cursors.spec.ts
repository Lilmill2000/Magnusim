// ux010 (DRAW, Daniel: "some other mouse thing would be ideal ... can points be round and not
// square?"), in the real host frame:
//  - sketch cursors are our own SVGs (data: URIs the frame's CSP allows) with the keyword as the
//    fallback: the Line tool's crosshair with the line icon (crosshair), a free point under the
//    Select tool (an open hand, fallback grab), a fully defined line (the plain arrow), a drag under
//    way (a closed hand, grabbing), the fillet's radius arrow (the open hand); the browser takes the value (computed style);
//  - sketch points are round: the points' material cuts a circle, and on screen a point's centre
//    is its colour while the corner of its old square is not;
//  - the cursor SVGs decode at 1x and 2x (and, with CAD_UX010_SHOTS=<dir>, a sheet of them on a
//    light and a dark ground is written there as cursor-*.png, the points as points-*.png).
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { cursorSvg, type SketchCursorKind } from '../src/sketch/cursors';
import { SKETCH_ICONS } from '../src/sketch/icons';
import { ensureCadOn, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type V3 = [number, number, number];
type V2 = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

const SHOTS = process.env.CAD_UX010_SHOTS || '';

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

async function expectCursor(page: Page, kind: string, fallback: string, contains?: string) {
  await expect.poll(async () => (await cursor(page)).kind).toBe(kind);
  const c = await cursor(page);
  if (fallback === 'default') {
    expect(c.inline).toBe('default');
    return;
  }
  expect(c.inline).toContain('url("data:image/svg+xml,');
  expect(c.inline.trim().endsWith(fallback), c.inline.slice(-40)).toBe(true);
  // The browser took it (an unsupported value would have left the keyword or nothing).
  expect(c.computed).toContain('url(');
  if (contains) expect(svgOf(c.inline)).toContain(contains);
}

test('cad:ux010-cursors the sketch cursors are our own SVGs with a keyword fallback: Line crosshair with its icon, move on a free point, the arrow on a fully defined line, grabbing while dragging, grab on the fillet arrow', async ({ page, request }) => {
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
  // The Select tool on the free line's end: the arrow with the move badge (fallback move).
  const [px, py] = await at(page, [-10, 40, 0]);
  await page.mouse.move(px + 30, py + 30);
  await page.mouse.move(px, py, { steps: 3 });
  // ux010 follow-up (Daniel: "the hand thing for dragging"): the open hand, fallback grab.
  await expectCursor(page, 'move', 'grab', 'M14.4 14V4.6');
  // Dragging it: the dragging variant (fallback grabbing).
  await page.mouse.down();
  await page.mouse.move(px + 20, py, { steps: 4 });
  await expectCursor(page, 'grabbing', 'grabbing', 'M14.4 14V10.4');
  await page.mouse.up();
  await sketchIdle(page);
  // A fully defined line: the plain arrow (it can't be dragged).
  const [lx, ly] = await at(page, [20, 0, 0]);
  await page.mouse.move(lx, ly, { steps: 3 });
  await expectCursor(page, 'default', 'default');
  // The fillet's radius arrow: the grab cursor on the arrow element.
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
  expect(hc.inline.trim().endsWith('grab')).toBe(true);
  expect(hc.computed).toContain('url(');
  expect(seen.errors).toEqual([]);
  expect(seen.csp, 'CSP violations (a cursor image refused)').toEqual([]);
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
    ['grab', null, 'Open hand: draggable, a handle'],
    ['grabbing', null, 'Closed hand: dragging'],
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
