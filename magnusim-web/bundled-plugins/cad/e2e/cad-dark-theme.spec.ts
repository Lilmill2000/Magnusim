// The dark set (owner decisions D1-D4): the Part follows the host's dark appearance, and its
// pictures stay light. This host's SDK has no appearance yet: setAppearance gives it as the newer
// SDK will (<html>'s data-theme, color-scheme and scales, then the 'appearance' event through the
// bridge's own path). Only CAD's own dark tokens switch here (the host's --mg-* dark set comes with
// its newer theme.css).
//  - dark-model: the view's background is #1b1f27 (its CSS and the canvas), the edges are E1's
//    candidate (the mid grey until Daniel picks), a finished sketch's lines E2's, and the faces
//    are the pixels they were (D2); back to light, every colour of the page (computed, element by
//    element) and the canvas are as before.
//  - dark-picture: a Picture taken while dark is light (the light background, near-black edges,
//    no dark background pixel) and is the same picture as one taken in light; the view shows no
//    light frame meanwhile (its pixels before and after the picture are the same) and no timer
//    is left behind.
//  - dark-sketch: with a sketch open, its lines and its draw cursor recolour without a reload,
//    and come back in light.
//  - dark-lines: E1 / E2's switch (window.__CAD__.appearance.darkLines) draws each candidate's edge
//    colour, (b) with a rim, for Daniel's screenshot review.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Frame, type Page } from '@playwright/test';
import { addSketch, addSolid, newPartFromTree, newProject, openProject, partOpened, runCommand, setAppearance, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type V3 = [number, number, number];
type RGB = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; appearance: { get(): { appearance: { theme: string }; palette: string; lines: { edges: string; sketch: string } | null; background: number }; darkLines(l?: unknown): unknown } } };

const LIGHT_BG: RGB = [0xf0, 0xf2, 0xf7];
const DARK_BG: RGB = [0x1b, 0x1f, 0x27];
const LIGHT_EDGE: RGB = [0x0a, 0x0b, 0x0e];
/** E1 / E2 candidates: (a) and (b) the host's dark text colour, (c) the mid grey (the default until Daniel picks). */
const PALE: RGB = [0xe6, 0xe9, 0xef];
const GREY: RGB = [0x8a, 0x93, 0xa3];
const LIGHT_FULL: RGB = [0x10, 0x18, 0x28];
const LIGHT_UNDER: RGB = [0x15, 0x70, 0xef];
const DARK_UNDER: RGB = [0x7a, 0xa7, 0xff];

const dist = (a: ArrayLike<number>, i: number, c: RGB) => Math.max(Math.abs(a[i] - c[0]), Math.abs(a[i + 1] - c[1]), Math.abs(a[i + 2] - c[2]));

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** No transition, every picking structure built, the solver idle, two more frames. */
async function still(page: Page) {
  const f = workspaceFrame(page);
  await f.waitForFunction(
    () => {
      const s = (window as unknown as W).__CAD__.services;
      const v = s.viewport.get().handle?.state.get();
      return !!v && !v.animating && v.bvhPending === 0 && s.doc.state.get().rebuild.status !== 'running';
    },
    null,
    { timeout: 60_000 },
  );
  await f.evaluate(async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/** Switch the appearance and wait two frames (the view draws in the new colours on its next frame). */
async function appearance(page: Page, theme: 'light' | 'dark') {
  await setAppearance(page, theme);
  await still(page);
}

/** The page clip (page px) around these model points, with a margin, inside the canvas. */
async function clipAround(page: Page, pts: V3[], pad = 12) {
  const f = workspaceFrame(page);
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  const r = await f.evaluate((pts) => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
    const c = document.querySelector('[data-cad-canvas]')!.getBoundingClientRect();
    const s = pts.map((p) => h.project(p) as [number, number]);
    return { s, c: { x: c.x, y: c.y, w: c.width, h: c.height } };
  }, pts);
  const xs = r.s.map((p) => p[0]);
  const ys = r.s.map((p) => p[1]);
  const x0 = Math.max(r.c.x, Math.min(...xs) - pad);
  const y0 = Math.max(r.c.y, Math.min(...ys) - pad);
  const x1 = Math.min(r.c.x + r.c.w, Math.max(...xs) + pad);
  const y1 = Math.min(r.c.y + r.c.h, Math.max(...ys) + pad);
  return { x: Math.round(box.x + x0), y: Math.round(box.y + y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

const shoot = async (page: Page, clip: { x: number; y: number; width: number; height: number }) => PNG.decode(await page.screenshot({ clip }));

/** The middle of the canvas, clear of the tree, the toolbar and the triad: as the page shows it. */
async function canvasShot(page: Page): Promise<Buffer> {
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  const c = await workspaceFrame(page).evaluate(() => {
    const r = document.querySelector('[data-cad-canvas]')!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  return page.screenshot({ clip: { x: box.x + c.x + c.width * 0.3, y: box.y + c.y + c.height * 0.2, width: c.width * 0.5, height: c.height * 0.55 } });
}

/** Fraction of pixels that differ by more than a few levels in a channel. */
function differs(a: Buffer, b: Buffer): number {
  const x = PNG.decode(a);
  const y = PNG.decode(b);
  expect([y.width, y.height]).toEqual([x.width, x.height]);
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) if ([0, 1, 2].some((k) => Math.abs(x.data[i + k] - y.data[i + k]) > 3)) n++;
  return n / (x.width * x.height);
}

/** One pixel of the canvas near its top-left corner (clear of every mark), as the page shows it. */
async function cornerPixel(page: Page): Promise<RGB> {
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  const c = await workspaceFrame(page).evaluate(() => {
    const r = document.querySelector('[data-cad-canvas]')!.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const img = await shoot(page, { x: Math.round(box.x + c.x + c.w * 0.6), y: Math.round(box.y + c.y + c.h * 0.08), width: 4, height: 4 });
  return [img.data[0], img.data[1], img.data[2]];
}

/** Every element's painted colours (computed), in document order: the page as the person sees it. */
function pageColours(f: Frame): Promise<string[]> {
  return f.evaluate(() => {
    const props = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'box-shadow', 'text-shadow', 'fill', 'stroke', 'caret-color', 'text-decoration-color', 'accent-color'];
    return Array.from(document.querySelectorAll('*')).map((el) => {
      const s = getComputedStyle(el);
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.getAttribute('class') ?? '').trim()} ${props.map((p) => s.getPropertyValue(p)).join(' | ')}`;
    });
  });
}

/** Pixels classified in a light shot: edge (near-black), background, and face pixels away from both. */
function classify(img: { width: number; height: number; data: Uint8Array }, line: RGB) {
  const { width: w, height: h, data } = img;
  const edge: number[] = [];
  const bg: number[] = [];
  const face: number[] = [];
  const kind = (x: number, y: number) => {
    const i = 4 * (y * w + x);
    return dist(data, i, line) <= 24 ? 'edge' : dist(data, i, LIGHT_BG) <= 4 ? 'bg' : 'face';
  };
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const k = kind(x, y);
      const i = 4 * (y * w + x);
      if (k === 'edge') edge.push(i);
      else if (k === 'bg') bg.push(i);
      else {
        // A face pixel two pixels away from any edge or background (no anti-aliased blend).
        let clear = true;
        for (let dy = -2; dy <= 2 && clear; dy++) for (let dx = -2; dx <= 2 && clear; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          if (kind(xx, yy) !== 'face') clear = false;
        }
        if (clear) face.push(i);
      }
    }
  return { edge, bg, face };
}

/** The pixels next to the edge pixels (1 to 2 px from one) on a face: not edge or background pixels themselves. */
function besideEdges(w: number, h: number, edge: number[], bg: number[]): number[] {
  const isEdge = new Set([...edge, ...bg]);
  const out = new Set<number>();
  for (const i of edge) {
    const p = i / 4;
    const x = p % w;
    const y = Math.floor(p / w);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = 4 * (yy * w + xx);
        if (!isEdge.has(j)) out.add(j);
      }
  }
  return [...out];
}

/** Of these pixels of a shot, the fraction within `tol` of a colour. */
const share = (img: { data: Uint8Array }, at: number[], c: RGB, tol: number) => (at.length ? at.filter((i) => dist(img.data, i, c) <= tol).length / at.length : 0);
/** Of these pixels, the fraction unchanged between two shots (within 3 levels). */
const unchanged = (a: { data: Uint8Array }, b: { data: Uint8Array }, at: number[]) => (at.length ? at.filter((i) => dist(b.data, i, [a.data[i], a.data[i + 1], a.data[i + 2]]) <= 3).length / at.length : 0);

/** A 20 mm block at the origin and, beside it, a finished 20 x 20 sketch at x 40 (fully defined). */
async function blockAndSketch(page: Page) {
  await addSolid(page, { size: [20, 20, 20] });
  await addSketch(page, { at: [40, 0], size: [20, 20] });
  // The view frames both (the sketch counts when it is shown).
  await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.fit({ animate: false }));
  await still(page);
}
const BLOCK: V3[] = [0, 20].flatMap((x) => [0, 20].flatMap((y) => [0, 20].map((z) => [x, y, z] as V3)));
const SKETCH: V3[] = [
  [40, 0, 0],
  [60, 0, 0],
  [60, 20, 0],
  [40, 20, 0],
];

test('cad:dark-model the view turns dark with light edges and sketch lines, the faces as they were; back to light every colour is as before', async ({ page, request }) => {
  const { seen } = await freshPart(page, request);
  const f = workspaceFrame(page);
  await blockAndSketch(page);
  // Light, as always: CAD has no appearance from this host.
  expect(await f.evaluate(() => (window as unknown as W).__CAD__.appearance.get())).toMatchObject({ appearance: { theme: 'light' }, palette: 'light', lines: null, background: 0xf0f2f7 });
  const coloursBefore = await pageColours(f);
  const shotBefore = await canvasShot(page);
  const blockClip = await clipAround(page, BLOCK);
  const sketchClip = await clipAround(page, SKETCH);
  const block0 = await shoot(page, blockClip);
  const sketch0 = await shoot(page, sketchClip);
  expect(dist(await cornerPixel(page), 0, LIGHT_BG)).toBeLessThanOrEqual(2);
  const px = classify(block0, LIGHT_EDGE);
  expect(px.edge.length, 'the block has near-black edges in light').toBeGreaterThan(40);
  expect(px.face.length, 'and faces').toBeGreaterThan(200);
  const sk = classify(sketch0, LIGHT_FULL);
  expect(sk.edge.length, "the finished sketch's fully defined lines in light").toBeGreaterThan(20);

  await appearance(page, 'dark');
  expect(await f.evaluate(() => (window as unknown as W).__CAD__.appearance.get())).toMatchObject({ appearance: { theme: 'dark' }, palette: 'dark', lines: { edges: 'c', sketch: 'c' }, background: 0x1b1f27 });
  // The view's background, in CSS and on the canvas: the host's dark viewport colour.
  const css = await f.evaluate(() => ({
    token: getComputedStyle(document.documentElement).getPropertyValue('--cad-viewport-bg').trim(),
    view: getComputedStyle(document.querySelector('[data-cad-viewport]')!).backgroundColor,
  }));
  expect(css).toEqual({ token: '#1b1f27', view: 'rgb(27, 31, 39)' });
  expect(dist(await cornerPixel(page), 0, DARK_BG)).toBeLessThanOrEqual(2);
  const block1 = await shoot(page, blockClip);
  expect(share(block1, px.edge, GREY, 24), "the edges are E1's mid grey").toBeGreaterThan(0.8);
  expect(share(block1, px.edge, LIGHT_EDGE, 24), 'no near-black edge is left').toBeLessThan(0.05);
  expect(share(block1, px.bg, DARK_BG, 4), 'the background around the block').toBeGreaterThan(0.95);
  expect(unchanged(block0, block1, px.face), 'the faces are the pixels they were (D2)').toBeGreaterThan(0.98);
  const sketch1 = await shoot(page, sketchClip);
  expect(share(sketch1, sk.edge, GREY, 24), "the sketch's fully defined lines are E2's mid grey").toBeGreaterThan(0.8);

  await appearance(page, 'light');
  // Every colour of the page as it was (the dark set only ever adds to the light one), and the canvas.
  const coloursAfter = await pageColours(f);
  expect(coloursAfter.length).toBe(coloursBefore.length);
  expect(coloursAfter.filter((c, i) => c !== coloursBefore[i])).toEqual([]);
  expect(differs(shotBefore, await canvasShot(page)), 'the canvas back in light').toBeLessThan(0.002);
  expect(dist(await cornerPixel(page), 0, LIGHT_BG)).toBeLessThanOrEqual(2);
  expect(seen.errors).toEqual([]);
  expect(seen.csp).toEqual([]);
});

test('cad:dark-picture a Picture taken while the view is dark is light, the same picture as in light, and the view never shows a light frame', async ({ page, request }) => {
  const { frame, seen } = await freshPart(page, request);
  const f = workspaceFrame(page);
  await blockAndSketch(page);
  await runCommand(frame, 'file.picture');
  const pic = frame.locator('[data-cad-panel="tool"]');
  const take = async () => {
    const img = pic.locator('[data-picture-image]');
    const was = (await img.count()) ? await img.getAttribute('src') : null;
    await pic.locator('[data-picture-take]').click();
    await expect(pic.locator('[data-picture-image]')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => pic.locator('[data-picture-image]').getAttribute('src'), { timeout: 60_000 }).not.toBe(was);
  };
  /** The shown picture's pixels, kept in the frame as `name`; what it shows, counted. */
  const read = (name: string) =>
    f.evaluate(async (name) => {
      const img = document.querySelector<HTMLImageElement>('[data-picture-image]')!;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      (window as unknown as Record<string, Uint8ClampedArray>)[name] = d;
      const near = (i: number, rgb: number[], t: number) => Math.abs(d[i] - rgb[0]) <= t && Math.abs(d[i + 1] - rgb[1]) <= t && Math.abs(d[i + 2] - rgb[2]) <= t;
      let light = 0;
      let dark = 0;
      let black = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (near(i, [0xf0, 0xf2, 0xf7], 3)) light++;
        if (near(i, [0x1b, 0x1f, 0x27], 6)) dark++;
        if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) black++;
      }
      const n = d.length / 4;
      return { w: c.width, h: c.height, light: light / n, dark: dark / n, black: black / n };
    }, name);

  await take();
  const inLight = await read('__lightPicture');
  // The view's own picture (the Assistant's and the Picture tool's path) in light, kept in the frame.
  const snapshot = (name: string) =>
    f.evaluate((name) => {
      const r = (window as unknown as W).__CAD__.services.viewport.get().handle.snapshot({ view: 'iso', width: 320, height: 240, hide: [], section: null });
      (window as unknown as Record<string, Uint8ClampedArray>)[name] = r.rgba;
      const d = r.rgba as Uint8ClampedArray;
      let light = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0xf0) <= 3 && Math.abs(d[i + 1] - 0xf2) <= 3 && Math.abs(d[i + 2] - 0xf7) <= 3) light++;
      return light / (d.length / 4);
    }, name);
  const differ = (a: string, b: string) =>
    f.evaluate(
      ({ a, b }) => {
        const x = (window as unknown as Record<string, Uint8ClampedArray>)[a];
        const y = (window as unknown as Record<string, Uint8ClampedArray>)[b];
        if (x.length !== y.length) return 1;
        let n = 0;
        for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i] - y[i]) > 3 || Math.abs(x[i + 1] - y[i + 1]) > 3 || Math.abs(x[i + 2] - y[i + 2]) > 3) n++;
        return n / (x.length / 4);
      },
      { a, b },
    );
  expect(await snapshot('__lightSnap')).toBeGreaterThan(0.4);
  expect(inLight.light, 'the light background fills most of the picture').toBeGreaterThan(0.4);
  expect(inLight.black, 'near-black edges').toBeGreaterThan(0.0005);

  await appearance(page, 'dark');
  const viewBefore = await canvasShot(page);
  // Every timer the picture schedules (none: nothing waits to be put back).
  await f.evaluate(() => {
    const w = window as unknown as { __timers: number[]; setTimeout: typeof setTimeout };
    w.__timers = [];
    const was = window.setTimeout;
    (window as unknown as { __setTimeoutWas: typeof setTimeout }).__setTimeoutWas = was;
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...a: unknown[]) => {
      w.__timers.push(ms ?? 0);
      return was(fn, ms, ...a);
    }) as typeof setTimeout;
  });
  // The view's own picture while dark: the light one, pixel for pixel, and no timer left behind.
  const timersBefore = await f.evaluate(() => (window as unknown as { __timers: number[] }).__timers.length);
  expect(await snapshot('__darkSnap'), "the view's own picture: the light background").toBeGreaterThan(0.4);
  expect(await f.evaluate(() => (window as unknown as { __timers: number[] }).__timers.length)).toBe(timersBefore);
  expect(await differ('__lightSnap', '__darkSnap'), "the view's own picture taken in dark is the one taken in light").toBeLessThan(0.002);
  await f.evaluate(() => {
    window.setTimeout = (window as unknown as { __setTimeoutWas: typeof setTimeout }).__setTimeoutWas;
  });
  // The Picture tool while dark.
  await take();
  const inDark = await read('__darkPicture');
  expect([inDark.w, inDark.h]).toEqual([inLight.w, inLight.h]);
  expect(inDark.light, 'light, not the dark background').toBeGreaterThan(0.4);
  expect(inDark.dark, 'no more pixels of the dark background than in light (none of it)').toBeLessThanOrEqual(inLight.dark);
  expect(inDark.black, 'near-black edges, as in light').toBeGreaterThan(0.0005);
  expect(await differ('__lightPicture', '__darkPicture'), 'the Picture taken in dark is the one taken in light').toBeLessThan(0.002);
  // The view itself stayed dark: its pixels are the ones before the pictures.
  await still(page);
  expect(differs(viewBefore, await canvasShot(page)), 'the view after the pictures').toBeLessThan(0.002);
  expect(dist(await cornerPixel(page), 0, DARK_BG)).toBeLessThanOrEqual(2);
  await appearance(page, 'light');
  expect(seen.errors).toEqual([]);
});

test('cad:dark-sketch an open sketch recolours its lines and its draw cursor live, and back in light', async ({ page, request }) => {
  const { frame } = await freshPart(page, request);
  const f = workspaceFrame(page);
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await still(page);
  // A free line (under defined: the under-defined blue) from (5, 5) to (35, 25).
  await page.keyboard.press('l');
  const at = async (p: V3) => {
    const xy = await f.evaluate((q) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(q), p);
    const box = (await page.locator('#workspace-frame').boundingBox())!;
    return [box.x + xy[0], box.y + xy[1]] as [number, number];
  };
  const a = await at([5, 5, 0]);
  const b = await at([35, 25, 0]);
  await page.mouse.click(a[0], a[1]);
  await page.mouse.click(b[0], b[1]);
  await page.keyboard.press('Escape');
  await still(page);
  // The line tool again: the draw cursor (its ink is in the cursor's image).
  await page.keyboard.press('l');
  await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 60);
  await still(page);
  const cursor = () => f.evaluate(() => (document.querySelector('[data-cad-canvas]') as HTMLElement).style.cursor);
  const lightCursor = await cursor();
  expect(lightCursor).toContain('101828');
  const clip = await clipAround(page, [
    [5, 5, 0],
    [35, 25, 0],
  ]);
  const line0 = await shoot(page, clip);
  const lk = classify(line0, LIGHT_UNDER);
  expect(lk.edge.length, 'the line in the under-defined blue').toBeGreaterThan(15);

  await appearance(page, 'dark');
  const line1 = await shoot(page, clip);
  expect(share(line1, lk.edge, DARK_UNDER, 24), "the line in the dark palette's blue").toBeGreaterThan(0.8);
  expect(share(line1, lk.bg, DARK_BG, 30), 'the background (and its grid) dark').toBeGreaterThan(0.9);
  const darkCursor = await cursor();
  expect(darkCursor, 'the draw cursor in the dark tone (white ink)').not.toBe(lightCursor);
  expect(darkCursor).not.toContain('101828');

  await appearance(page, 'light');
  const line2 = await shoot(page, clip);
  expect(unchanged(line0, line2, [...lk.edge, ...lk.bg, ...lk.face]), 'every pixel as it was in light').toBeGreaterThan(0.99);
  expect(await cursor()).toBe(lightCursor);
});

test("cad:dark-lines E1 / E2's switch draws each candidate's edge colour, (b) with a rim, for the owner's review", async ({ page, request }) => {
  await freshPart(page, request);
  const f = workspaceFrame(page);
  await blockAndSketch(page);
  const clip = await clipAround(page, BLOCK);
  const px = classify(await shoot(page, clip), LIGHT_EDGE);
  await appearance(page, 'dark');
  const lines = (v: unknown) => f.evaluate((v) => (window as unknown as W).__CAD__.appearance.darkLines(v), v);
  for (const [option, colour] of [
    ['a', PALE],
    ['b', PALE],
    ['c', GREY],
  ] as const) {
    expect(await lines(option)).toEqual({ edges: option, sketch: option });
    await still(page);
    expect(await f.evaluate(() => (window as unknown as W).__CAD__.appearance.get().lines)).toEqual({ edges: option, sketch: option });
    const img = await shoot(page, clip);
    // (b)'s rim covers the edges' anti-aliased border: their middle shows the colour, the rest the background.
    expect(share(img, px.edge, colour, 24), `(${option}): the edges' colour`).toBeGreaterThan(option === 'b' ? 0.3 : 0.75);
  }
  // (b)'s rim: a line in the background colour under each edge, 1 px wider each side: beside the
  // edges, on the faces, (b) shows the background colour where (a) shows the face.
  const beside = besideEdges(clip.width, clip.height, px.edge, px.bg);
  const rimShare = async (option: 'a' | 'b') => {
    await lines(option);
    await still(page);
    return share(await shoot(page, clip), beside, DARK_BG, 10);
  };
  const plain = await rimShare('a');
  const rimmed = await rimShare('b');
  expect(rimmed - plain, `(b) rims the edges: ${rimmed} against (a)'s ${plain}`).toBeGreaterThan(0.1);
  expect(await f.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.palette().edgeRim)).toBe(0x1b1f27);
  await lines('c');
  await appearance(page, 'light');
});
