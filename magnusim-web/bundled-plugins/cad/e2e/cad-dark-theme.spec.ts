// The dark set (owner decisions D1-D4): the Part follows the host's dark appearance, and its
// pictures stay light. This host's SDK has no appearance yet: setAppearance gives it as the newer
// SDK will (<html>'s data-theme, color-scheme and scales, then the 'appearance' event through the
// bridge's own path). The frame's /plugin-sdk/theme.css already has the host's dark --mg-* set, so
// a dark <html> switches the host's tokens and chrome along with CAD's own; only the SDK's part is
// given here.
//  - dark-model: the view's background is #1b1f27 (its CSS and the canvas), the edges are E1's
//    #e6e9ef (Daniel: option a), a finished sketch beside the block (over the background) its
//    dark inks, and the faces are the pixels they were (D2); back to light, every colour of the
//    page (computed, element by element) and the canvas are as before.
//  - dark-picture: a Picture taken while dark is light (the light background, near-black edges,
//    no dark background pixel) and is the same picture as one taken in light; the view shows no
//    light frame meanwhile (its pixels before and after the picture are the same) and no timer
//    is left behind.
//  - dark-sketch: with a sketch open, its lines and its draw cursor recolour without a reload,
//    and come back in light.
//  - dark-follows-face (E2, Daniel: "the colour follows what's under it"; device scale 2, so a
//    line's middle is whole pixels): a sketch on a block's top face whose lines cross the face's
//    outline. In model mode a finished sketch's lines, then in sketch mode each state (fully
//    defined, under defined, over defined, construction), the points and the line tool's rubber
//    band: LIGHT's ink over the face, the dark ink over the background; a hovered line keeps its
//    colour in its halo, which is fainter over the background (review: the line's blue in the .85
//    halo there read 1.1:1); the panel's keys show both; the draw cursor takes the light tone over
//    the face; light is one colour again, and dark again live; a picture taken while dark is the
//    light one, byte for byte.
//  - dark-follows-face-lost: a sketch on a block whose projected reference (a cube's top face, over
//    the block's edge) is lost: its amber curve takes the light view's amber over the face and the
//    dark one beyond it, in model mode and in sketch mode; the reference's dot in the panel shows
//    both (one colour in light), its crescent of the body colour whole (review: the name's clip cut
//    its left side off). (It went with the removed dark-sketch-face test.)
//  - dark-follows-face-marks: a reference point and axis, the measure line's ends and the Extrude
//    arrow, over a face and over the background.
//  - dark-follows-face-enclosure: the Enclosure's arrows, over the part's face (the +Z arrow seen
//    end on from the top) and over the background (the +X arrow, past the top face's outline).
//  - dark-follows-face-section: a section in dark keeps its light caps, and the measure's end
//    over a cap takes the face ink (the cap is a light surface), the one beyond it the dark one.
//  - dark-follows-face-handle: a fillet's radius arrow over a face shows the light view's grab hand
//    in dark, also after the theme changed with the pointer over the background (review: it kept
//    the white hand of where the pointer had been).
//  - dark-follows-face-lit: on a part of a dark colour (a navy body) the marks keep the dark inks,
//    but over a face lit by a hover or a pick, and over the whole part selected (light blues and
//    the pick green, light surfaces), a finished sketch's line and the measure's end take the
//    light view's inks (review: they stayed light, about 1.1:1 on the pick green).
//  - dark-grid-edge-on: a sketch's plane seen near edge-on keeps the grid it has (no new one is
//    laid out that far across); going dark repaints that grid dark (review round 1: it stayed the
//    light grid, bright on the dark view), and a picture taken then has the light grid, the
//    picture taken in light.
//  - dark-box-caption: a selection box started over a light face: its caption sits on a backing
//    of the dark background colour (review round 1: bare light blue on the face read 1.2 to
//    1.4:1), and has none in light.
//  - dark-pattern-failed: a Pattern copy that could not be used (red marker) under the pointer or
//    keyboard focus: in dark its red number is on a red-tinted background, 4.5:1 and more (review
//    round 1: on the hover blue, 1.7:1), in light on the hover blue as before. The red is the
//    host's dark --mg-danger, from the frame's own theme.css.
//  - dark-chrome: the toolbar takes the host's dark --mg-surface-muted (CAD has no dark value of
//    its own for it), and a button under the pointer stands off it (review of the rebase: the
//    icon buttons' hover was 1.06:1 there); a selected tree row and a pressed toolbar button are
//    the host's --mg-active-bg / -border, as the core's (they were CAD's own blue in dark); back
//    in light each is as before.
//  - dark-sketch-picture: in sketch mode (review round 1: only model mode was pictured dark), the
//    view's own picture (the Assistant's and the Picture tool's path) taken while dark is the one
//    taken in light, and the view shows no light frame meanwhile.
//  - dark-picture-save: the Picture panel's Save PNG (a link: a download) looks exactly like the
//    kit's secondary button beside it, at rest, under the pointer and focused, computed style and
//    pixels, in light and dark (it was the browser's link blue, underlined).
//  - dark-tooltip-edge: a toolbar button's tooltip and the toolbar's drag note have the host
//    tooltip's edge (--mg-tooltip-edge, as the core's .mat-k-tip): a #3a414e line around them in
//    dark, where their shadow is lost; in light the edge is transparent and paints no pixel.
//  - dark-triad: each orientation arrow's brightest pixels read 3:1 and more on the dark view at
//    the home view and at every standard view (lit by the headlight alone, as the core's, an arrow
//    pointing at the eye read 1.8:1); back in light the triad's corner is the pixels it was.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Frame, type Locator, type Page } from '@playwright/test';
import { addSketch, addSolid, featureRowNamed, modelOnPage, newPartFromTree, newProject, openProject, openSketchDetails, partOpened, runCommand, setAppearance, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';
import { hostTokens, themeValue } from '../tests/styles/css-tokens';

type V3 = [number, number, number];
type RGB = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; appearance: { get(): { appearance: { theme: string }; palette: string; background: number; followsFaces: boolean } } } };

const LIGHT_BG: RGB = [0xf0, 0xf2, 0xf7];
const DARK_BG: RGB = [0x1b, 0x1f, 0x27];
const LIGHT_EDGE: RGB = [0x0a, 0x0b, 0x0e];
/** E1 (a): the edges, and a fully defined sketch line over the background: the host's dark text colour. */
const PALE: RGB = [0xe6, 0xe9, 0xef];
const LIGHT_FULL: RGB = [0x10, 0x18, 0x28];
const LIGHT_UNDER: RGB = [0x15, 0x70, 0xef];
/** The dark palette's under-defined blue (the host's dark --mg-primary-ink). */
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

test('cad:dark-model the view turns dark with #e6e9ef edges and light sketch lines, the faces as they were; back to light every colour is as before', async ({ page, request }) => {
  const { seen } = await freshPart(page, request);
  const f = workspaceFrame(page);
  await blockAndSketch(page);
  // Light, as always: CAD has no appearance from this host.
  expect(await f.evaluate(() => (window as unknown as W).__CAD__.appearance.get())).toMatchObject({ appearance: { theme: 'light' }, palette: 'light', followsFaces: false, background: 0xf0f2f7 });
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
  expect(await f.evaluate(() => (window as unknown as W).__CAD__.appearance.get())).toMatchObject({ appearance: { theme: 'dark' }, palette: 'dark', followsFaces: true, background: 0x1b1f27 });
  // The view's background, in CSS and on the canvas: the host's dark viewport colour.
  const css = await f.evaluate(() => ({
    token: getComputedStyle(document.documentElement).getPropertyValue('--cad-viewport-bg').trim(),
    view: getComputedStyle(document.querySelector('[data-cad-viewport]')!).backgroundColor,
  }));
  expect(css).toEqual({ token: '#1b1f27', view: 'rgb(27, 31, 39)' });
  expect(dist(await cornerPixel(page), 0, DARK_BG)).toBeLessThanOrEqual(2);
  const block1 = await shoot(page, blockClip);
  expect(share(block1, px.edge, PALE, 24), "the edges are E1's #e6e9ef").toBeGreaterThan(0.8);
  expect(share(block1, px.edge, LIGHT_EDGE, 24), 'no near-black edge is left').toBeLessThan(0.05);
  expect(share(block1, px.bg, DARK_BG, 4), 'the background around the block').toBeGreaterThan(0.95);
  expect(unchanged(block0, block1, px.face), 'the faces are the pixels they were (D2)').toBeGreaterThan(0.98);
  const sketch1 = await shoot(page, sketchClip);
  // Beside the block, over the background: the dark palette's own ink (the host's dark text colour).
  expect(share(sketch1, sk.edge, PALE, 24), "the sketch's fully defined lines over the background are #e6e9ef").toBeGreaterThan(0.8);

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
  expect(share(line1, lk.edge, DARK_UNDER, 24), "the line, over the background, in the dark palette's blue").toBeGreaterThan(0.8);
  expect(share(line1, lk.bg, DARK_BG, 30), 'the background (and its grid) dark').toBeGreaterThan(0.9);
  const darkCursor = await cursor();
  expect(darkCursor, 'the draw cursor in the dark tone (white ink)').not.toBe(lightCursor);
  expect(darkCursor).not.toContain('101828');

  await appearance(page, 'light');
  const line2 = await shoot(page, clip);
  expect(unchanged(line0, line2, [...lk.edge, ...lk.bg, ...lk.face]), 'every pixel as it was in light').toBeGreaterThan(0.99);
  expect(await cursor()).toBe(lightCursor);
});

/** WCAG contrast of two colours. */
function contrastOf(a: RGB, b: RGB): number {
  const lum = (c: RGB) =>
    c
      .map((v) => v / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)))
      .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const hexRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const cssRgb = (h: string) => { const [r, g, b] = hexRgb(h); return `rgb(${r}, ${g}, ${b})`; };

// ---- E2: the colour follows what's under it (Daniel, 2026-10-28)
// At device scale 2 every line here (1.6 px and up) has whole pixels in its middle, so the pixel
// nearest a line's ink is the ink itself, not a blend with what is under it.
test.describe("E2: a mark's colour follows what is under it", () => {
  test.use({ deviceScaleFactor: 2 });

  type Shot = { img: { width: number; height: number; data: Uint8Array }; k: number; clip: { x: number; y: number; width: number; height: number } };
  const shot2 = async (page: Page, clip: Shot['clip']): Promise<Shot> => {
    const img = PNG.decode(await page.screenshot({ clip }));
    return { img, k: img.width / clip.width, clip };
  };
  /** Model points on the page (CSS px), in one call. */
  const onPage = async (page: Page, pts: V3[]): Promise<[number, number][]> => {
    const box = (await page.locator('#workspace-frame').boundingBox())!;
    const xy = await workspaceFrame(page).evaluate((pts) => pts.map((p) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(p) as [number, number]), pts);
    return xy.map(([x, y]) => [box.x + x, box.y + y]);
  };
  /** Within `r` CSS px of a page point: how near the nearest pixel comes to each ink (max channel difference). */
  const nearest = (s: Shot, at: [number, number], inks: RGB[], r: number) => {
    const cx = (at[0] - s.clip.x) * s.k;
    const cy = (at[1] - s.clip.y) * s.k;
    const R = Math.ceil(r * s.k);
    const best = inks.map(() => Infinity);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= s.img.width || y >= s.img.height) continue;
        const i = 4 * (y * s.img.width + x);
        inks.forEach((c, j) => (best[j] = Math.min(best[j], dist(s.img.data, i, c))));
      }
    return best;
  };
  /**
   * Of samples along a model segment (t from t0 to t1), the share where the pixel nearest the
   * wanted ink is within `tol` of it and nearer it than the other ink is to its own nearest pixel
   * (a line with whole pixels in its middle; a one-pixel line: blendAlong).
   */
  const along = async (page: Page, s: Shot, a: V3, b: V3, t0: number, t1: number, want: RGB, not: RGB, r = 2, tol = 18, n = 9) => {
    const pts: V3[] = Array.from({ length: n }, (_, i) => {
      const t = t0 + ((t1 - t0) * i) / (n - 1);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as V3;
    });
    const xy = await onPage(page, pts);
    const d = xy.map((p) => nearest(s, p, [want, not], r));
    return { share: d.filter(([w, o]) => w <= tol && w < o).length / n, d: d.map(([w, o]) => `${w}/${o}`).join(' ') };
  };
  const at1 = async (page: Page, s: Shot, p: V3, want: RGB, not: RGB, r = 1.5, tol = 18) => {
    const [xy] = await onPage(page, [p]);
    const [w, o] = nearest(s, xy, [want, not], r);
    return { ok: w <= tol && w < o, d: `${w}/${o}` };
  };
  /** How far a colour is from the blends of `ink` with `under` (the segment between them in RGB). */
  const offBlend = (c: RGB, under: RGB, ink: RGB) => {
    const d = [0, 1, 2].map((k) => ink[k] - under[k]);
    const t = Math.max(0, Math.min(1, [0, 1, 2].reduce((sum, k) => sum + (c[k] - under[k]) * d[k], 0) / Math.max(1, d.reduce((sum, v) => sum + v * v, 0))));
    return Math.hypot(...[0, 1, 2].map((k) => c[k] - (under[k] + t * d[k])));
  };
  /**
   * Of samples along a model segment, the share where the line's plainest pixel (within `r` CSS px,
   * the one farthest from `under`, what is under the line) lies on the blends of `want` with `under`
   * rather than on those of `not`. A one-device-pixel line (the measure's: MSAA draws it as a 1 px
   * band, so half of each of two pixel rows when it falls between them) is a blend whatever its
   * coverage: this asks which ink it is a blend of, not how much of it a pixel holds.
   */
  const blendAlong = async (page: Page, s: Shot, a: V3, b: V3, t0: number, t1: number, want: RGB, not: RGB, under: RGB, r = 1.5, n = 9) => {
    const pts: V3[] = Array.from({ length: n }, (_, i) => {
      const t = t0 + ((t1 - t0) * i) / (n - 1);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as V3;
    });
    const xy = await onPage(page, pts);
    const d = xy.map(([px, py]) => {
      const cx = (px - s.clip.x) * s.k;
      const cy = (py - s.clip.y) * s.k;
      const R = Math.ceil(r * s.k);
      let best: RGB = under;
      let far = -1;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const x = Math.round(cx + dx);
          const y = Math.round(cy + dy);
          if (x < 0 || y < 0 || x >= s.img.width || y >= s.img.height) continue;
          const i = 4 * (y * s.img.width + x);
          const c: RGB = [s.img.data[i], s.img.data[i + 1], s.img.data[i + 2]];
          const f = Math.hypot(...[0, 1, 2].map((k) => c[k] - under[k]));
          if (f > far) [best, far] = [c, f];
        }
      return { far, w: offBlend(best, under, want), o: offBlend(best, under, not) };
    });
    return { share: d.filter((x) => x.far >= 20 && x.w < x.o).length / n, d: d.map((x) => `${Math.round(x.far)}:${Math.round(x.w)}/${Math.round(x.o)}`).join(' ') };
  };
  /** The median colour of a 5 x 5 device-pixel patch at a model point (a face's colour clear of every mark). */
  const patchAt = async (page: Page, s: Shot, p: V3): Promise<RGB> => {
    const [[px, py]] = await onPage(page, [p]);
    const all: RGB[] = [];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const i = 4 * (Math.round((py - s.clip.y) * s.k + dy) * s.img.width + Math.round((px - s.clip.x) * s.k + dx));
        all.push([s.img.data[i], s.img.data[i + 1], s.img.data[i + 2]]);
      }
    return [0, 1, 2].map((k) => all.map((c) => c[k]).sort((x, y) => x - y)[12]) as RGB;
  };
  const rgbOf = (n: number): RGB => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const palette = (page: Page) => workspaceFrame(page).evaluate(() => {
    const p = (window as unknown as W).__CAD__.services.viewport.get().handle.palette();
    return { name: p.name as string, sketch: p.sketch as Record<string, string>, face: p.face as null | { sketch: Record<string, string>; constructLine: number; measure: number; ink: number }, constructLine: p.constructLine as number, measure: p.measure as number, ink: p.ink as number };
  });
  const LIGHT_SK = { under: '#1570ef', fully: '#101828', over: '#b42318', construction: '#667085', preview: '#1570ef', hover: '#b2ccff' } as const;
  const DARK_SK = { under: '#7aa7ff', fully: '#e6e9ef', over: '#f97066', construction: '#9aa4b2', preview: '#7aa7ff' } as const;

  /**
   * Lines across the block's top face (x 0..40) and out over the background, at these y (model mm,
   * z 20), and two construction lines whose points show the points' inks (a solid line's ends carry
   * the open-profile marker over them): one free (under-defined points), one fixed (fully defined).
   */
  const ROWS = { fully: 6, under: 12, over: 18, construction: 24 } as const;
  const POINT_ROWS = { under: 30, fully: 35 } as const;
  const lineOf = (y: number): [V3, V3] => [
    [5, y, 20],
    [60, y, 20],
  ];
  // Over the face: x 12..32 of the line (t 0.127 to 0.491); over the background: x 47..56 (t 0.764 to 0.927).
  const FACE: [number, number] = [0.127, 0.491];
  const GROUND: [number, number] = [0.764, 0.927];

  test("cad:dark-follows-face a sketch line crossing a face's outline is the light view's ink over the face and the dark ink over the background, in every state, its points too; the keys show both, the cursor follows; light is one colour, and a picture is the light one", async ({ page, request }) => {
    const { frame, seen } = await freshPart(page, request);
    const f = workspaceFrame(page);
    await addSolid(page, { size: [40, 40, 20] });
    await page.keyboard.press('Escape');
    await appearance(page, 'dark');
    const click = async (p: V3) => {
      await still(page);
      const [x, y] = await modelOnPage(page, p);
      await page.mouse.click(x, y);
    };
    // A sketch on the block's top face (z 20), four lines across its outline at x 40.
    await click([20, 20, 20]);
    await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await still(page);
    for (const y of [...Object.values(ROWS), ...Object.values(POINT_ROWS)]) {
      await page.keyboard.press('l');
      const [a, b] = lineOf(y);
      await click(a);
      await click(b);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
    await still(page);
    await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
    await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
    await page.mouse.move(5, 5);
    await still(page);
    const sketch = await f.evaluate(() => {
      const st = (window as unknown as W).__CAD__.services.doc.state.get();
      return st.doc.features.filter((x: { type: string }) => x.type === 'sketch').at(-1).id as string;
    });
    const clip = await clipAround(page, [
      [0, 0, 20],
      [64, 40, 20],
    ], 8);

    // Model mode: the finished sketch's (under-defined) lines on the face.
    {
      const s = await shot2(page, clip);
      const [a, b] = lineOf(ROWS.under);
      const face = await along(page, s, a, b, ...FACE, hexRgb(LIGHT_SK.under), hexRgb(DARK_SK.under));
      const ground = await along(page, s, a, b, ...GROUND, hexRgb(DARK_SK.under), hexRgb(LIGHT_SK.under));
      expect(face.share, `model mode, over the face, LIGHT's blue: ${face.d}`).toBeGreaterThanOrEqual(0.75);
      expect(ground.share, `model mode, over the background, the dark blue: ${ground.d}`).toBeGreaterThanOrEqual(0.75);
    }

    // The states: line 1 fixed (fully defined), line 2 free, line 3 horizontal twice more (over
    // defined), line 4 construction; line 5 construction, line 6 construction and fixed. A fixed
    // line keeps no relation the line tool gave it (a horizontal beside a fix is over defined).
    await f.evaluate((id) => {
      const doc = (window as unknown as W).__CAD__.services.doc;
      const fe = doc.state.get().doc.features.find((x: { id: string }) => x.id === id);
      const lines = fe.entities.filter((e: { kind: string }) => e.kind === 'line');
      if (lines.length !== 6) throw new Error(`the sketch has ${lines.length} lines, not 6`);
      const fixed = new Set([lines[0].id, lines[5].id]);
      const construction = new Set([lines[3].id, lines[4].id, lines[5].id]);
      const s = doc.beginEdit(id);
      s.update({
        entities: fe.entities.map((e: { id: string }) => (construction.has(e.id) ? { ...e, construction: true } : e)),
        constraints: [
          ...fe.constraints.filter((c: { refs: string[] }) => !c.refs.some((r) => fixed.has(r))),
          { id: 'c_fix_dark1', kind: 'fix', refs: [lines[0].id] },
          { id: 'c_fix_dark2', kind: 'fix', refs: [lines[5].id] },
          { id: 'c_h_dark1', kind: 'horizontal', refs: [lines[2].id] },
          { id: 'c_h_dark2', kind: 'horizontal', refs: [lines[2].id] },
        ],
      });
      s.commit();
    }, sketch);
    await still(page);
    await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last().locator('> .tree-row').dblclick();
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await page.mouse.move(5, 5);
    await still(page);

    /** Every state's line over the face and over the background, and the fully and under-defined lines' points. */
    const states = async (theme: 'light' | 'dark') => {
      const s = await shot2(page, clip);
      const out: Record<string, string> = {};
      const bad: string[] = [];
      for (const [state, y] of Object.entries(ROWS) as [keyof typeof ROWS, number][]) {
        const [a, b] = lineOf(y);
        const faceInk = hexRgb(LIGHT_SK[state]);
        const groundInk = hexRgb(theme === 'dark' ? DARK_SK[state] : LIGHT_SK[state]);
        const other = hexRgb(theme === 'dark' ? DARK_SK[state] : '#ffffff');
        const face = await along(page, s, a, b, ...FACE, faceInk, theme === 'dark' ? other : hexRgb('#ff00ff'));
        const ground = await along(page, s, a, b, ...GROUND, groundInk, theme === 'dark' ? faceInk : hexRgb('#ff00ff'));
        out[state] = `face ${face.share} (${face.d}); ground ${ground.share} (${ground.d})`;
        // Construction is dashed: a sample's window may fall in a gap.
        const min = state === 'construction' ? 0.55 : 0.75;
        if (face.share < min) bad.push(`${state} over the face: ${face.d}`);
        if (ground.share < min) bad.push(`${state} over the background: ${ground.d}`);
      }
      for (const state of ['fully', 'under'] as const) {
        const [a, b] = lineOf(POINT_ROWS[state]);
        const p0 = await at1(page, s, a, hexRgb(LIGHT_SK[state]), theme === 'dark' ? hexRgb(DARK_SK[state]) : hexRgb('#ff00ff'));
        const p1 = await at1(page, s, b, hexRgb(theme === 'dark' ? DARK_SK[state] : LIGHT_SK[state]), theme === 'dark' ? hexRgb(LIGHT_SK[state]) : hexRgb('#ff00ff'));
        out[`${state} points`] = `${p0.d} ${p1.d}`;
        if (!p0.ok) bad.push(`${state}'s point on the face: ${p0.d}`);
        if (!p1.ok) bad.push(`${state}'s point over the background: ${p1.d}`);
      }
      console.log(`[dark-follows-face] ${theme} ${JSON.stringify(out)}`);
      return bad;
    };
    const p = await palette(page);
    expect(p.face?.sketch.fully).toBe(LIGHT_SK.fully);
    // The sketch shows each state (the solver's verdict), so each line is in its state's ink.
    const lineState = await f.evaluate(() => (document.querySelector('[data-cad-panel="sketch"] [data-sketch-state]') as HTMLElement).dataset.sketchState);
    expect(['over', 'under']).toContain(lineState);
    expect(await states('dark'), 'dark: LIGHT ink over the face, the dark ink over the background').toEqual([]);

    // The under-defined line hovered (the pointer on it over the background): the line keeps its
    // colour in its halo, over the face (the halo .85, as in light) and over the background (the
    // halo fainter there, the hover blue at .45 on the dark background, the line's blue 2:1 on it).
    {
      const [a, b] = lineOf(ROWS.under);
      const [hx, hy] = await modelOnPage(page, [52, ROWS.under, 20]);
      await page.mouse.move(hx, hy, { steps: 3 });
      await expect.poll(() => f.evaluate(() => (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().hover?.id ?? null)).not.toBeNull();
      await still(page);
      const s = await shot2(page, clip);
      const face = await along(page, s, a, b, ...FACE, hexRgb(LIGHT_SK.under), hexRgb(DARK_SK.under));
      const ground = await along(page, s, a, b, ...GROUND, hexRgb(DARK_SK.under), hexRgb(LIGHT_SK.under));
      expect(face.share, `the hovered line over the face: LIGHT's blue (${face.d})`).toBeGreaterThanOrEqual(0.75);
      expect(ground.share, `the hovered line over the background: the dark blue (${ground.d})`).toBeGreaterThanOrEqual(0.75);
      /** The halo's pixels 2.6 CSS px either side of the line's middle (in the 7 px halo, clear of the 2.4 px line). */
      const haloAt = async (p: V3) => {
        const [[x0, y0], [x1, y1]] = await onPage(page, [p, [p[0], p[1] + 1, p[2]]]);
        const l = Math.hypot(x1 - x0, y1 - y0);
        return [2.6, -2.6].map((d) => {
          const x = Math.round((x0 + ((x1 - x0) / l) * d - s.clip.x) * s.k);
          const y = Math.round((y0 + ((y1 - y0) / l) * d - s.clip.y) * s.k);
          const i = 4 * (y * s.img.width + x);
          return [s.img.data[i], s.img.data[i + 1], s.img.data[i + 2]] as RGB;
        });
      };
      const HOVER = hexRgb(LIGHT_SK.hover);
      const faint = HOVER.map((v, i) => Math.round(0.45 * v + 0.55 * DARK_BG[i])) as RGB;
      for (const x of [49, 52, 55]) {
        for (const c of await haloAt([x, ROWS.under, 20])) {
          expect(dist(c, 0, faint), `the halo over the background at x ${x}: ${c}, the faint hover blue ${faint}`).toBeLessThanOrEqual(16);
          expect(contrastOf(hexRgb(DARK_SK.under), c), `the dark blue on the halo at x ${x}`).toBeGreaterThanOrEqual(1.8);
        }
      }
      for (const x of [16, 22, 28]) for (const c of await haloAt([x, ROWS.under, 20])) expect(dist(c, 0, HOVER), `the halo over the face at x ${x}: ${c}`).toBeLessThanOrEqual(24);
      await page.mouse.move(5, 5);
      await still(page);
    }

    // The line tool's rubber band, from the face out over the background.
    await page.keyboard.press('l');
    await click([5, 37, 20]);
    const [mx, my] = await modelOnPage(page, [60, 37, 20]);
    await page.mouse.move(mx, my, { steps: 4 });
    await still(page);
    {
      const s = await shot2(page, clip);
      const face = await along(page, s, [5, 37, 20], [60, 37, 20], ...FACE, hexRgb(LIGHT_SK.preview), hexRgb(DARK_SK.preview));
      const ground = await along(page, s, [5, 37, 20], [60, 37, 20], ...GROUND, hexRgb(DARK_SK.preview), hexRgb(LIGHT_SK.preview));
      expect(face.share, `the rubber band over the face: ${face.d}`).toBeGreaterThanOrEqual(0.75);
      expect(ground.share, `the rubber band over the background: ${ground.d}`).toBeGreaterThanOrEqual(0.75);
    }
    // The draw cursor: the light view's (dark ink, white halo) over the face, white over the background.
    const cursor = () => f.evaluate(() => (document.querySelector('[data-cad-canvas]') as HTMLElement).style.cursor);
    const [fx, fy] = await modelOnPage(page, [25, 9, 20]);
    await page.mouse.move(fx, fy, { steps: 3 });
    await expect.poll(cursor, { message: 'over the face: the light tone' }).toContain('101828');
    const [gx, gy] = await modelOnPage(page, [55, 9, 20]);
    await page.mouse.move(gx, gy, { steps: 3 });
    await expect.poll(cursor, { message: 'over the background: the dark tone' }).not.toContain('101828');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.mouse.move(5, 5);
    await still(page);

    // The panel's keys: in dark the left half the colour over a face (on a crescent of the body
    // colour), the right half the colour over the background; in light the one colour.
    const keyOf = (st: string | undefined) => (st === 'fully' ? 'fully' : st === 'over' || st === 'unsolved' ? 'over' : 'under');
    const keys = async () => {
      const dot = frame.locator('[data-cad-panel="sketch"] .cad-sk-state-dot');
      const look = await dot.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow, state: (el.closest('[data-sketch-state]') as HTMLElement).dataset.sketchState }));
      const r = (await dot.boundingBox())!;
      const s = await shot2(page, { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width) + 1, height: Math.ceil(r.height) + 1 });
      const px = (fx: number) => {
        const i = 4 * (Math.round((r.y + r.height / 2 - s.clip.y) * s.k) * s.img.width + Math.round((r.x + r.width * fx - s.clip.x) * s.k));
        return [s.img.data[i], s.img.data[i + 1], s.img.data[i + 2]] as RGB;
      };
      return { ...look, left: px(0.25), right: px(0.75) };
    };
    {
      const k = await keys();
      const role = keyOf(k.state);
      expect(k.bg, 'the dot: the ink over the background').toBe(cssRgb(DARK_SK[role]));
      expect(k.shadow, 'its face half').toBe(`${cssRgb(LIGHT_SK[role])} 4px 0px 0px 0px inset, rgb(189, 201, 219) -1.5px 0px 0px 0.5px`);
      expect(Math.max(...k.left.map((v, i) => Math.abs(v - hexRgb(LIGHT_SK[role])[i]))), `the left half shows ${LIGHT_SK[role]}: ${k.left}`).toBeLessThanOrEqual(24);
      expect(Math.max(...k.right.map((v, i) => Math.abs(v - hexRgb(DARK_SK[role])[i]))), `the right half shows ${DARK_SK[role]}: ${k.right}`).toBeLessThanOrEqual(24);
    }
    const snapshot = (name: string) =>
      f.evaluate((name) => {
        const r = (window as unknown as W).__CAD__.services.viewport.get().handle.snapshot({ view: 'top', width: 320, height: 240, hide: [], section: null });
        (window as unknown as Record<string, Uint8ClampedArray>)[name] = r.rgba;
      }, name);
    const bytesDiffer = (a: string, b: string) =>
      f.evaluate(
        ({ a, b }) => {
          const x = (window as unknown as Record<string, Uint8ClampedArray>)[a];
          const y = (window as unknown as Record<string, Uint8ClampedArray>)[b];
          if (x.length !== y.length) return -1;
          let n = 0;
          for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
          return n;
        },
        { a, b },
      );
    await snapshot('__followsDark1');

    // Light: one colour, LIGHT's, over the face and the background alike; the key one colour.
    await appearance(page, 'light');
    expect(await states('light'), 'light: LIGHT ink everywhere').toEqual([]);
    {
      const k = await keys();
      const role = keyOf(k.state);
      expect([k.bg, k.shadow]).toEqual([cssRgb(LIGHT_SK[role]), 'none']);
    }
    await snapshot('__followsLight');
    expect(await bytesDiffer('__followsLight', '__followsDark1'), 'the picture taken in dark is the light one, byte for byte').toBe(0);
    // Dark again, live: the two inks again; and a picture now is still the light one.
    await appearance(page, 'dark');
    expect(await states('dark'), 'dark again').toEqual([]);
    await snapshot('__followsDark2');
    expect(await bytesDiffer('__followsLight', '__followsDark2')).toBe(0);
    await appearance(page, 'light');
    await page.keyboard.press('Escape');
    expect(seen.errors).toEqual([]);
  });

  test("cad:dark-follows-face-lost a lost reference's curve is the light view's amber over the face and the dark amber beyond it, in both modes; its dot shows both", async ({ page, request }) => {
    const { frame, seen } = await freshPart(page, request);
    const f = workspaceFrame(page);
    // A 40 x 40 x 20 block, and a 10 mm cube on its top face standing out over its +X edge (x 35..45).
    await addSolid(page, { size: [40, 40, 20] });
    await addSolid(page, { at: [35, 15, 20], size: [10, 10, 10] });
    await page.keyboard.press('Escape');
    const click = async (p: V3) => {
      await still(page);
      const [x, y] = await modelOnPage(page, p);
      await page.mouse.click(x, y);
    };
    // A sketch on the block's top face (z 20), the cube's top face projected into it.
    await click([10, 10, 20]);
    await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await still(page);
    await openSketchDetails(page, frame);
    await page.keyboard.press('p');
    await click([40, 20, 30]);
    await still(page);
    const links = frame.locator('[data-sketch-links] [data-link]');
    await expect(links).toHaveCount(1);
    await page.keyboard.press('Escape');
    await still(page);
    await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
    await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
    // The cube suppressed: its square is a lost reference, amber, half over the block's face.
    await featureRowNamed(frame, 'Extrude 2').locator('> .tree-row').click({ button: 'right' });
    await frame.locator('[data-cad-menu] [data-menu-item="suppress"]').click();
    await f.waitForFunction(
      () => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((x: { id: string }) => st.rebuild.features[x.id] && st.rebuild.features[x.id].state !== 'pending');
      },
      null,
      { timeout: 60_000 },
    );
    await page.keyboard.press('Escape');
    await appearance(page, 'dark');
    const p = await palette(page);
    const lostFace = hexRgb(p.face!.sketch.lost);
    const lost = hexRgb(p.sketch.lost);
    // The square's lower side (y 15): over the face from x 35 to 40, over the background from 40 to 45.
    const A: V3 = [35, 15, 20];
    const B: V3 = [45, 15, 20];
    const sides = async (where: string) => {
      const clip = await clipAround(page, [
        [0, 0, 20],
        [50, 40, 20],
      ], 8);
      const s = await shot2(page, clip);
      const face = await along(page, s, A, B, 0.1, 0.4, lostFace, lost, 2, 18, 5);
      const ground = await along(page, s, A, B, 0.6, 0.9, lost, lostFace, 2, 18, 5);
      console.log(`[dark-follows-face-lost] ${where} face ${face.d}; ground ${ground.d}`);
      expect(face.share, `${where}: the lost curve over the face, the light view's amber (${face.d})`).toBeGreaterThanOrEqual(0.6);
      expect(ground.share, `${where}: the lost curve over the background, the dark amber (${ground.d})`).toBeGreaterThanOrEqual(0.6);
    };
    // Model mode, from the top.
    await f.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setView('top', { animate: false }));
    await page.mouse.move(5, 5);
    await still(page);
    await sides('model mode');
    // Sketch mode.
    await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last().locator('> .tree-row').dblclick();
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await page.mouse.move(5, 5);
    await still(page);
    await expect(links.first()).toHaveAttribute('data-link-state', 'lost');
    await sides('sketch mode');
    // The reference's dot: the dark amber, its left half the light view's amber on a crescent of the body colour.
    const dot = links.first().locator('.cad-sk-link-dot');
    const look = () => dot.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow }));
    const halves = async () => {
      const r = (await dot.boundingBox())!;
      const s = await shot2(page, { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width) + 1, height: Math.ceil(r.height) + 1 });
      const px = (fx: number) => {
        const i = 4 * (Math.round((r.y + r.height / 2 - s.clip.y) * s.k) * s.img.width + Math.round((r.x + r.width * fx - s.clip.x) * s.k));
        return [s.img.data[i], s.img.data[i + 1], s.img.data[i + 2]] as RGB;
      };
      return { left: px(0.25), right: px(0.75) };
    };
    /** The pixel 1 CSS px left of the dot, at its middle: the crescent's (it reaches 2 px out). */
    const crescent = async () => {
      const r = (await dot.boundingBox())!;
      const s = await shot2(page, { x: Math.floor(r.x) - 4, y: Math.floor(r.y), width: 6, height: Math.ceil(r.height) + 1 });
      const i = 4 * (Math.round((r.y + r.height / 2 - s.clip.y) * s.k) * s.img.width + Math.round((r.x - 1 - s.clip.x) * s.k));
      return [s.img.data[i], s.img.data[i + 1], s.img.data[i + 2]] as RGB;
    };
    expect(await look()).toEqual({ bg: cssRgb(p.sketch.lost), shadow: `${cssRgb(p.face!.sketch.lost)} 4px 0px 0px 0px inset, rgb(189, 201, 219) -1.5px 0px 0px 0.5px` });
    const dark = await halves();
    expect(dist(dark.left, 0, lostFace), `the dot's left half: ${dark.left}`).toBeLessThanOrEqual(24);
    expect(dist(dark.right, 0, lost), `the dot's right half: ${dark.right}`).toBeLessThanOrEqual(24);
    // Its crescent of the body colour shows whole, as the state dot's (review: the name's clip cut it off at the left).
    const BODY: RGB = [0xbd, 0xc9, 0xdb];
    const cr = await crescent();
    expect(dist(cr, 0, BODY), `the crescent left of the dot: ${cr}`).toBeLessThanOrEqual(24);
    // Light: one colour, the light amber, and the curve one colour.
    await appearance(page, 'light');
    expect(await look()).toEqual({ bg: cssRgb(p.face!.sketch.lost), shadow: 'none' });
    const light = await halves();
    for (const c of [light.left, light.right]) expect(dist(c, 0, lostFace), `light, the dot: ${c}`).toBeLessThanOrEqual(24);
    const crLight = await crescent();
    expect(dist(crLight, 0, BODY), `light: no crescent (${crLight})`).toBeGreaterThan(24);
    await page.keyboard.press('Escape');
    expect(seen.errors).toEqual([]);
  });

  test("cad:dark-follows-face-marks a reference point and axis, the measure's ends and the Extrude arrow take the light view's inks over a face and the dark ones over the background", async ({ page, request }) => {
    const { frame, seen } = await freshPart(page, request);
    const f = workspaceFrame(page);
    await addSolid(page, { size: [40, 40, 20] });
    // A small block further along x: the axis is drawn across the bodies (refgeom/scene.ts
    // axisSegment), so this one carries it out over the background beside the first.
    await addSolid(page, { at: [72, 0, 0], size: [6, 6, 6] });
    await page.keyboard.press('Escape');
    const addRaw = (type: string, init: Record<string, unknown>) =>
      f.evaluate(
        async ({ t, i }) => {
          const s = (window as unknown as W).__CAD__.services;
          const sk = s.doc.beginNew(t, i);
          sk.commit();
          for (let k = 0; k < 400; k++) {
            const st = s.doc.state.get().rebuild;
            if (st.status === 'done' && st.features[sk.feature] && st.features[sk.feature].state !== 'pending') return sk.feature as string;
            await new Promise((r) => setTimeout(r, 25));
          }
          throw new Error(`${t} did not build`);
        },
        { t: type, i: init },
      );
    // Points on the top face (z 20) and beside it, the axis through them, along y 20.
    const P1: V3 = [10, 20, 20];
    const P2: V3 = [62, 20, 20];
    const p1 = await addRaw('ref_point', { method: 'coordinates', xyz: P1.map((v) => `${v} mm`) });
    const p2 = await addRaw('ref_point', { method: 'coordinates', xyz: P2.map((v) => `${v} mm`) });
    await addRaw('ref_axis', { method: 'two_points', points: [{ kind: 'feature', feature: p1 }, { kind: 'feature', feature: p2 }] });
    await appearance(page, 'dark');
    const top = async () => {
      await f.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setView('top', { animate: false }));
      await page.mouse.move(5, 5);
      await still(page);
    };
    await top();
    const p = await palette(page);
    const clip = await clipAround(page, [
      [0, 0, 20],
      [78, 40, 20],
    ], 8);
    let s = await shot2(page, clip);
    const construct = rgbOf(p.constructLine);
    const constructFace = rgbOf(p.face!.constructLine);
    const dot1 = await at1(page, s, P1, constructFace, construct);
    const dot2 = await at1(page, s, P2, construct, constructFace);
    expect(dot1.ok, `the point on the face: ${dot1.d}`).toBe(true);
    expect(dot2.ok, `the point beside it: ${dot2.d}`).toBe(true);
    // The axis between them: dashed, so some samples fall in a gap.
    const axisFace = await along(page, s, P1, P2, 0.12, 0.5, constructFace, construct);
    // x 47 to 58, where nothing is under it.
    const axisGround = await along(page, s, P1, P2, 0.71, 0.92, construct, constructFace);
    expect(axisFace.share, `the axis over the face: ${axisFace.d}`).toBeGreaterThanOrEqual(0.55);
    expect(axisGround.share, `the axis over the background: ${axisGround.d}`).toBeGreaterThanOrEqual(0.55);

    // The measure between two typed points, one on the face, one beside it: its ends (7 px squares).
    await runCommand(frame, 'inspect.measure');
    const input = frame.locator('[data-measure-point-input]');
    for (const q of ['12, 32, 20', '62, 32, 20']) {
      await input.fill(q);
      await input.press('Enter');
    }
    await expect(frame.locator('[data-measure-label]')).toBeVisible({ timeout: 60_000 });
    await top();
    const clip2 = await clipAround(page, [
      [0, 0, 20],
      [78, 40, 20],
    ], 8);
    s = await shot2(page, clip2);
    const measure = rgbOf(p.measure);
    const measureFace = rgbOf(p.face!.measure);
    const m1 = await at1(page, s, [12, 32, 20], measureFace, measure);
    const m2 = await at1(page, s, [62, 32, 20], measure, measureFace);
    expect(m1.ok, `the measure's end on the face: ${m1.d}`).toBe(true);
    expect(m2.ok, `the measure's end beside it: ${m2.d}`).toBe(true);
    // Its line is one device pixel wide, a blend of its ink and what is under it however it falls on
    // the pixel rows (review: a nearness test passed or failed on that): over the face a blend of the
    // face ink with the face, over the background of the dark ink with the background.
    const faceColour = await patchAt(page, s, [27, 36, 20]);
    const lineFace = await blendAlong(page, s, [12, 32, 20], [62, 32, 20], 0.15, 0.45, measureFace, measure, faceColour);
    const lineGround = await blendAlong(page, s, [12, 32, 20], [62, 32, 20], 0.7, 0.85, measure, measureFace, DARK_BG);
    console.log(`[dark-follows-face-marks] face ${faceColour}; the measure line over it ${lineFace.d}; over the background ${lineGround.d}`);
    expect(lineFace.share, `the measure line over the face: ${lineFace.d}`).toBeGreaterThanOrEqual(0.6);
    expect(lineGround.share, `the measure line over the background: ${lineGround.d}`).toBeGreaterThanOrEqual(0.6);
    await frame.locator('[data-cad-panel="tool"] [data-panel-done]').click();
    await expect(frame.locator('[data-tool-panel="inspect.measure"]')).toHaveCount(0);
    await expect(frame.locator('[data-measure-label]')).toBeHidden();

    // The Extrude arrow of a square beside the block: seen from the top it stands on its own
    // preview's top face (the face ink); from the front it rises over the background (the dark ink).
    await addSketch(page, { at: [60, 10], size: [10, 10] });
    await top();
    const [rx, ry] = await modelOnPage(page, [65, 15, 0]);
    await page.mouse.click(rx, ry);
    await frame.locator('[data-command="solid.extrude"]').click();
    await expect(frame.locator('[data-cad-panel] .nui[data-field="distance"] input')).toHaveValue('10');
    await top();
    const ink = rgbOf(p.ink);
    const inkFace = rgbOf(p.face!.ink);
    const [ax, ay] = await modelOnPage(page, [65, 15, 10]);
    s = await shot2(page, { x: Math.round(ax - 12), y: Math.round(ay - 12), width: 24, height: 24 });
    const [endOnFace, endOnGround] = nearest(s, [ax, ay], [inkFace, ink], 6);
    expect(endOnFace, `from the top, over its face: the light view's blue (${endOnFace}/${endOnGround})`).toBeLessThanOrEqual(16);
    expect(endOnGround).toBeGreaterThan(endOnFace);
    await f.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setView('front', { animate: false }));
    await page.mouse.move(5, 5);
    await still(page);
    const [bx, by] = await modelOnPage(page, [65, 15, 10]);
    // A column from just above the preview's top up past the arrow's tip.
    s = await shot2(page, { x: Math.round(bx - 6), y: Math.round(by - 90), width: 12, height: 84 });
    let ground = 0;
    let face = 0;
    for (let i = 0; i < s.img.data.length; i += 4) {
      if (dist(s.img.data, i, ink) <= 16) ground++;
      if (dist(s.img.data, i, inkFace) <= 16) face++;
    }
    expect(ground, `from the front, over the background: the dark blue (${ground} pixels; face ink ${face})`).toBeGreaterThanOrEqual(8);
    expect(face).toBe(0);
    await page.keyboard.press('Escape');
    await appearance(page, 'light');
    expect(seen.errors).toEqual([]);
  });

  test("cad:dark-follows-face-enclosure the Enclosure's arrows take the light view's blue over the part's face and the dark one over the background", async ({ page, request }) => {
    const { frame, seen } = await freshPart(page, request);
    const f = workspaceFrame(page);
    await addSolid(page, { size: [20, 20, 20] });
    await page.keyboard.press('Escape');
    await appearance(page, 'dark');
    // A new Enclosure, tight to the part: an arrow from the middle of each of its sides.
    await runCommand(frame, 'cfd.enclosure');
    await expect(frame.locator('[data-cad-panel] [data-panel-title]')).toHaveText('Enclosure 1');
    await expect(featureRowNamed(frame, 'Enclosure 1')).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
    await f.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setView('top', { animate: false }));
    await page.mouse.move(5, 5);
    await still(page);
    const p = await palette(page);
    const ink = rgbOf(p.ink);
    const inkFace = rgbOf(p.face!.ink);
    // The +Z arrow seen end on from the top, at the middle of the part's top face.
    const [zx, zy] = await modelOnPage(page, [10, 10, 20]);
    let s = await shot2(page, { x: Math.round(zx - 12), y: Math.round(zy - 12), width: 24, height: 24 });
    const [zFace, zGround] = nearest(s, [zx, zy], [inkFace, ink], 6);
    expect(zFace, `the +Z arrow over the part's top face: the light view's blue (${zFace}/${zGround})`).toBeLessThanOrEqual(16);
    expect(zGround).toBeGreaterThan(zFace);
    // The +X arrow, from the middle of the +X side (under the top face's outline, seen from above)
    // out over the background: the light view's blue up to the outline, the dark one beyond it.
    const [xx, xy] = await modelOnPage(page, [20, 10, 10]);
    const [ex] = await modelOnPage(page, [20, 10, 20]);
    const count = async (x0: number, x1: number) => {
      const shot = await shot2(page, { x: Math.round(x0), y: Math.round(xy - 5), width: Math.round(x1 - x0), height: 10 });
      let dark = 0;
      let light = 0;
      for (let i = 0; i < shot.img.data.length; i += 4) {
        if (dist(shot.img.data, i, ink) <= 16) dark++;
        if (dist(shot.img.data, i, inkFace) <= 16) light++;
      }
      return { dark, light };
    };
    expect(ex - xx, 'the outline is between the base and the head').toBeGreaterThan(12);
    expect(ex - xx).toBeLessThan(44);
    const inside = await count(xx + 3, ex - 3);
    const beyond = await count(ex + 3, xx + 50);
    // Over the face its anti-aliased edges (the light view's blue half on the light face) come near the
    // dark blue: the light view's blue fills the shaft's middle, so it has the most pixels.
    expect(inside.light, `the +X arrow over the face: the light view's blue (${JSON.stringify(inside)})`).toBeGreaterThanOrEqual(8);
    expect(inside.light).toBeGreaterThan(inside.dark);
    expect(beyond.dark, `the +X arrow over the background: the dark blue (${JSON.stringify(beyond)})`).toBeGreaterThanOrEqual(8);
    expect(beyond.light).toBe(0);
    await page.keyboard.press('Escape');
    await appearance(page, 'light');
    expect(seen.errors).toEqual([]);
  });

  test("cad:dark-follows-face-section a section in dark keeps its light caps, and a mark over a cap takes the light view's ink", async ({ page, request }) => {
    const { frame, seen } = await freshPart(page, request);
    const f = workspaceFrame(page);
    await addSolid(page, { size: [40, 40, 20] });
    await page.keyboard.press('Escape');
    // Cut at x 20, seen from the right: the cap faces the eye; the block's own faces at x 40 are cut away.
    await f.evaluate(() => {
      const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
      h.setSection({ on: true, plane: 'origin:right', offset: 20, flip: false });
      h.setView('right', { animate: false });
    });
    await runCommand(frame, 'inspect.measure');
    const input = frame.locator('[data-measure-point-input]');
    for (const q of ['20, 12, 10', '20, 55, 10']) {
      await input.fill(q);
      await input.press('Enter');
    }
    await expect(frame.locator('[data-measure-label]')).toBeVisible({ timeout: 60_000 });
    await f.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setView('right', { animate: false }));
    await page.mouse.move(5, 5);
    await still(page);
    const clip = await clipAround(page, [
      [20, 0, 0],
      [20, 58, 20],
    ], 8);
    /** The cap: light, and hatched (a plain face is one colour), at a patch clear of the measure. */
    const cap = async () => {
      const [x, y] = await modelOnPage(page, [20, 30, 15]);
      const s = await shot2(page, { x: Math.round(x - 10), y: Math.round(y - 10), width: 20, height: 20 });
      const lum: number[] = [];
      for (let i = 0; i < s.img.data.length; i += 4) lum.push(s.img.data[i] + s.img.data[i + 1] + s.img.data[i + 2]);
      const hi = Math.max(...lum);
      const lo = Math.min(...lum);
      return { light: contrastOf([s.img.data[0], s.img.data[1], s.img.data[2]], DARK_BG) > 4 || hi / 3 > 150, hatched: lo < hi * 0.8, hi, lo };
    };
    const lightCap = await cap();
    expect(lightCap, 'light: the cap, hatched').toMatchObject({ light: true, hatched: true });
    await appearance(page, 'dark');
    const darkCap = await cap();
    expect(darkCap, 'dark: the cap stays light (D2), hatched').toMatchObject({ light: true, hatched: true });
    expect([darkCap.hi, darkCap.lo]).toEqual([lightCap.hi, lightCap.lo]);
    const p = await palette(page);
    const s = await shot2(page, clip);
    const measure = rgbOf(p.measure);
    const measureFace = rgbOf(p.face!.measure);
    const onCap = await at1(page, s, [20, 12, 10], measureFace, measure);
    const beside = await at1(page, s, [20, 55, 10], measure, measureFace);
    expect(onCap.ok, `the measure's end over the cap: the light view's blue (${onCap.d})`).toBe(true);
    expect(beside.ok, `the end beside the cut: the dark blue (${beside.d})`).toBe(true);
    await page.keyboard.press('Escape');
    await appearance(page, 'light');
    expect(seen.errors).toEqual([]);
  });

  test("cad:dark-follows-face-handle a fillet's radius arrow over a face shows the light view's grab hand in dark, also after the theme changed with the pointer elsewhere", async ({ page, request }) => {
    const { frame, seen } = await freshPart(page, request);
    await addSolid(page, { size: [60, 60, 20] });
    await page.keyboard.press('Escape');
    await appearance(page, 'dark');
    const click = async (p: V3) => {
      await still(page);
      const [x, y] = await modelOnPage(page, p);
      await page.mouse.click(x, y);
    };
    // A 30 x 20 rectangle on the top face (z 20) from (10, 10); its corner (40, 30) filleted: the
    // radius arrow points out of the corner, over the face.
    await click([30, 30, 20]);
    await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await still(page);
    await page.keyboard.press('r');
    await click([10, 10, 20]);
    const [rx, ry] = await modelOnPage(page, [36, 26, 20]);
    await page.mouse.move(rx, ry, { steps: 3 });
    await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
    await page.keyboard.type('30');
    await page.keyboard.press('Tab');
    await page.keyboard.type('20');
    await page.keyboard.press('Enter');
    await still(page);
    await page.keyboard.press('Escape');
    await runCommand(frame, 'sketch.fillet');
    await click([40, 30, 20]);
    await still(page);
    const arrow = frame.locator('[data-sketch-handle]');
    await expect(arrow).toHaveCount(1);
    const hand = () => arrow.evaluate((el) => (el as HTMLElement).style.cursor);
    const crosshair = () => workspaceFrame(page).evaluate(() => (document.querySelector('[data-cad-canvas]') as HTMLElement).style.cursor);
    // Over the face: the light view's hand (its dark ink).
    await arrow.hover();
    await expect.poll(hand, { message: 'on the arrow over the face: the light tone' }).toContain('101828');
    // The pointer over the background beside the block (the crosshair there white), the theme
    // changes (the arrows are given the tone of where the pointer is), then the pointer goes onto
    // the arrow: the light tone, of the face under it.
    const [bx, by] = await modelOnPage(page, [-12, -12, 20]);
    await page.mouse.move(bx, by, { steps: 3 });
    await expect.poll(crosshair, { message: 'over the background: the white crosshair' }).not.toContain('101828');
    await appearance(page, 'light');
    await appearance(page, 'dark');
    expect(await hand(), 'given the tone of the background, where the pointer is').not.toContain('101828');
    await arrow.hover();
    await expect.poll(hand, { message: 'after the theme change: the light tone over the face' }).toContain('101828');
    await page.mouse.move(5, 5);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await appearance(page, 'light');
    expect(seen.errors).toEqual([]);
  });

  test("cad:dark-follows-face-lit on a dark-coloured part a face lit by a hover or a pick, or the whole part selected, is light: a sketch's line and the measure's end over it take the light view's inks", async ({ page, request }) => {
    const { frame, seen } = await freshPart(page, request);
    const f = workspaceFrame(page);
    const block = await addSolid(page, { size: [40, 40, 20] });
    await page.keyboard.press('Escape');
    // Navy (as the tree's swatch sets it): a dark surface, so the marks over it keep the dark inks.
    await f.evaluate((id) => (window as unknown as W).__CAD__.services.doc.setBodyColor(id, '#1d2939'), block.body);
    await appearance(page, 'dark');
    const click = async (p: V3) => {
      await still(page);
      const [x, y] = await modelOnPage(page, p);
      await page.mouse.click(x, y);
    };
    // A finished sketch on the top face (z 20): a free line (under defined) from (6, 12) to (34, 12).
    const A: V3 = [6, 12, 20];
    const B: V3 = [34, 12, 20];
    await click([20, 30, 20]);
    await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await still(page);
    await page.keyboard.press('l');
    await click(A);
    await click(B);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await still(page);
    await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
    await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
    await page.keyboard.press('Escape');
    const selected = () => f.evaluate(() => (window as unknown as W).__CAD__.services.selection.get().items.map((it: { kind: string }) => it.kind) as string[]);
    await expect.poll(selected).toEqual([]);
    /** Orthographic, 40 degrees from the top, from the front: the top face, and the space beyond its far edge. */
    const pose = async () => {
      await f.evaluate(() =>
        (window as unknown as W).__CAD__.services.viewport.get().handle.setCamera({ position: [20, 20 - 300 * Math.sin(0.7), 20 + 300 * Math.cos(0.7)], target: [20, 20, 20], up: [0, 0, 1], orthoHeight: 90, projection: 'orthographic' }),
      );
      await still(page);
    };
    await pose();
    const p = await palette(page);
    const under = hexRgb(p.sketch.under);
    const underFace = hexRgb(p.face!.sketch.under);
    const clip = await clipAround(page, [
      [0, 0, 20],
      [40, 40, 20],
      [20, 22, 60],
    ], 8);
    // At rest, the navy face: the line in the dark view's blue.
    await page.mouse.move(5, 5);
    await still(page);
    let s = await shot2(page, clip);
    const rest = await along(page, s, A, B, 0.2, 0.8, under, underFace);
    expect(rest.share, `on the navy face at rest: the dark view's blue (${rest.d})`).toBeGreaterThanOrEqual(0.75);
    // The face under the pointer (clear of the line): the hover blue, a light surface.
    const hovered = () => f.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().hover?.item ?? null);
    const [hx, hy] = await modelOnPage(page, [20, 32, 20]);
    await page.mouse.move(hx, hy, { steps: 3 });
    await expect.poll(hovered).toMatchObject({ kind: 'face', body: block.body });
    await still(page);
    s = await shot2(page, clip);
    const hover = await along(page, s, A, B, 0.2, 0.8, underFace, under);
    expect(hover.share, `on the hovered face: the light view's blue (${hover.d})`).toBeGreaterThanOrEqual(0.75);
    // The whole part selected from its tree row: the selected blue, a light surface.
    await page.mouse.move(5, 5);
    const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row').click();
    await frame.locator(`[data-body-row="${block.body}"] .tree-row`).first().click();
    await expect.poll(selected).toEqual(['body']);
    await page.mouse.move(5, 5);
    await still(page);
    s = await shot2(page, clip);
    const sel = await along(page, s, A, B, 0.2, 0.8, underFace, under);
    expect(sel.share, `on the selected part: the light view's blue (${sel.d})`).toBeGreaterThanOrEqual(0.75);
    await f.evaluate(() => (window as unknown as W).__CAD__.services.selection.set((st: object) => ({ ...st, items: [] })));
    await expect.poll(selected).toEqual([]);

    // The measure from the top face (picked: the pick green) to a point 40 mm above it.
    await runCommand(frame, 'inspect.measure');
    await pose();
    await click([20, 22, 20]);
    await expect.poll(selected).toEqual(['face']);
    const input = frame.locator('[data-measure-point-input]');
    await input.fill('20, 22, 60');
    await input.press('Enter');
    await expect(frame.locator('[data-measure-label]')).toBeVisible({ timeout: 60_000 });
    await page.mouse.move(5, 5);
    await pose();
    s = await shot2(page, clip);
    const measure = rgbOf(p.measure);
    const measureFace = rgbOf(p.face!.measure);
    const onFace = await at1(page, s, [20, 22, 20], measureFace, measure);
    const above = await at1(page, s, [20, 22, 60], measure, measureFace);
    expect(onFace.ok, `the measure's end on the picked face: the light view's blue (${onFace.d})`).toBe(true);
    expect(above.ok, `its end above, over the background: the dark blue (${above.d})`).toBe(true);
    await frame.locator('[data-cad-panel="tool"] [data-panel-done]').click();
    await expect(frame.locator('[data-tool-panel="inspect.measure"]')).toHaveCount(0);
    await appearance(page, 'light');
    expect(seen.errors).toEqual([]);
  });
});

test('cad:dark-grid-edge-on the grid a near edge-on view keeps turns dark with the view, and a picture taken then is the light one', async ({ page, request }) => {
  const { frame, seen } = await freshPart(page, request);
  const f = workspaceFrame(page);
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await still(page);
  /**
   * The camera looking at the Top plane's origin from -Y, `deg` above the plane, orthographic, at
   * 0.7071 of the canvas height in mm (the grid's step just under 14 px: 10 mm). Then what the
   * sketch's grid does there (src/sketch/overlay.ts drawGrid, the same reads): 'drawn' when a grid
   * is laid out, 'kept' when the plane spans more than 400 steps across the view (the one there stays).
   */
  const pose = (deg: number) =>
    f.evaluate((deg) => {
      const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
      const r = document.querySelector('[data-cad-canvas]')!.getBoundingClientRect();
      const t = (deg * Math.PI) / 180;
      h.setCamera({ position: [0, -500 * Math.cos(t), 500 * Math.sin(t)], target: [0, 0, 0], up: [0, 0, 1], orthoHeight: 0.7071 * r.height, projection: 'orthographic' });
      const plane = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
      const c = [
        [r.left, r.top],
        [r.right, r.top],
        [r.right, r.bottom],
        [r.left, r.bottom],
      ].map(([x, y]) => h.toPlane(x, y, plane)?.uv ?? null);
      if (c.some((p: unknown) => !p)) return 'none';
      const us = c.map((p: number[]) => p[0]);
      const vs = c.map((p: number[]) => p[1]);
      const px = h.pixelSize([(Math.min(...us) + Math.max(...us)) / 2, (Math.min(...vs) + Math.max(...vs)) / 2, 0]);
      const step = Math.pow(10, Math.ceil(Math.log10(Math.max(1e-9, 14 * px))));
      const span = Math.max(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs));
      return span / step > 400 ? 'kept' : 'drawn';
    }, deg);
  // 10 degrees: a grid is laid out; 3 degrees: the view keeps it (it shows as a band across the middle).
  expect(await pose(10)).toBe('drawn');
  await still(page);
  expect(await pose(3)).toBe('kept');
  await still(page);
  /** The middle band of the canvas (the kept grid, seen edge-on): the share of pixels near each grid's colours. */
  const band = async () => {
    const r = await f.evaluate(() => {
      const c = document.querySelector('[data-cad-canvas]')!.getBoundingClientRect();
      return { x: c.x, y: c.y, w: c.width, h: c.height };
    });
    const box = (await page.locator('#workspace-frame').boundingBox())!;
    const img = await shoot(page, { x: Math.round(box.x + r.x + r.w * 0.2), y: Math.round(box.y + r.y + r.h / 2 - 20), width: Math.round(r.w * 0.5), height: 40 });
    let light = 0;
    let dark = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += 4) {
      if (dist(img.data, i, [0xe8, 0xeb, 0xf0]) <= 8 || dist(img.data, i, [0xcf, 0xd3, 0xdb]) <= 8) light++;
      if (dist(img.data, i, [0x2c, 0x32, 0x3d]) <= 10 || dist(img.data, i, [0x3a, 0x41, 0x4e]) <= 10) dark++;
    }
    return { light: light / n, dark: dark / n };
  };
  const inLight = await band();
  expect(inLight.light, `the kept grid in light: ${JSON.stringify(inLight)}`).toBeGreaterThan(0.3);
  const snapshot = (name: string) =>
    f.evaluate((name) => {
      const r = (window as unknown as W).__CAD__.services.viewport.get().handle.snapshot({ view: 'iso', width: 320, height: 240, hide: [], section: null });
      (window as unknown as Record<string, Uint8ClampedArray>)[name] = r.rgba;
    }, name);
  await snapshot('__edgeOnLight');
  await appearance(page, 'dark');
  expect(await pose(3)).toBe('kept');
  await still(page);
  const inDark = await band();
  expect(inDark.dark, `the kept grid turned dark: ${JSON.stringify(inDark)}`).toBeGreaterThan(0.3);
  expect(inDark.light, 'no light grid left on the dark view').toBeLessThan(0.01);
  // A picture now: the light grid, the same picture as in light.
  await snapshot('__edgeOnDark');
  const differ = await f.evaluate(() => {
    const x = (window as unknown as Record<string, Uint8ClampedArray>).__edgeOnLight;
    const y = (window as unknown as Record<string, Uint8ClampedArray>).__edgeOnDark;
    if (x.length !== y.length) return 1;
    let n = 0;
    for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i] - y[i]) > 3 || Math.abs(x[i + 1] - y[i + 1]) > 3 || Math.abs(x[i + 2] - y[i + 2]) > 3) n++;
    return n / (x.length / 4);
  });
  expect(differ, 'the picture taken in dark is the one taken in light').toBeLessThan(0.002);
  await appearance(page, 'light');
  expect((await band()).light).toBeGreaterThan(0.3);
  expect(seen.errors).toEqual([]);
});

test('cad:dark-box-caption a selection box started over a face has its caption on a dark backing in dark, none in light', async ({ page, request }) => {
  const { frame, seen } = await freshPart(page, request);
  await addSolid(page, { size: [40, 40, 20] });
  // Nothing selected (a selected body is shaded darker).
  await page.keyboard.press('Escape');
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.selection.get().items.length)).toBe(0);
  // Seen from the top: its top face fills the view, lit full on (a light face).
  await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setView('top', { animate: false }));
  await still(page);
  /** Ctrl+drag from the block's top face, down and right (enclose); held, the caption's look and pixels, then released. */
  const caption = async () => {
    const [x, y] = await modelOnPage(page, [10, 10, 20]);
    await page.mouse.move(x, y);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 40, { steps: 4 });
    await page.mouse.move(x + 120, y + 80, { steps: 4 });
    const cap = frame.locator('[data-box-select] .cad-box-caption');
    await expect(cap).toBeVisible();
    const look = await cap.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ring: getComputedStyle(el).boxShadow, text: el.textContent }));
    // The caption's box and 1 px of its ring: the share of pixels that are the dark backing over the face.
    const r = (await cap.boundingBox())!;
    const img = await shoot(page, { x: Math.round(r.x - 1), y: Math.round(r.y - 1), width: Math.round(r.width + 2), height: Math.round(r.height + 2) });
    let backed = 0;
    for (let i = 0; i < img.data.length; i += 4) if (dist(img.data, i, DARK_BG) <= 40) backed++;
    await page.mouse.up();
    await page.keyboard.up('Control');
    await expect(frame.locator('[data-box-select]')).toHaveCount(0);
    return { ...look, backed: backed / (img.width * img.height) };
  };
  // The face under the caption's start (no box yet): a light face.
  const [fx, fy] = await modelOnPage(page, [10, 10, 20]);
  const face = (await shoot(page, { x: Math.round(fx) + 8, y: Math.round(fy) + 8, width: 1, height: 1 })).data;
  expect(contrastOf([face[0], face[1], face[2]], DARK_BG), 'the box starts over a light face').toBeGreaterThan(6);
  const light = await caption();
  // Light as it was: bare text on the face.
  expect([light.bg, light.ring]).toEqual(['rgba(0, 0, 0, 0)', 'none']);
  expect(light.backed).toBe(0);
  await appearance(page, 'dark');
  const dark = await caption();
  expect(dark.text).toBe(light.text);
  // On a backing of the view's dark background colour, ring and all, over the face.
  expect(dark.bg).toBe('rgba(27, 31, 39, 0.88)');
  expect(dark.ring).toBe('rgba(27, 31, 39, 0.88) 0px 0px 0px 2px');
  expect(dark.backed, `the backing's pixels around the caption: ${dark.backed}`).toBeGreaterThan(0.5);
  await appearance(page, 'light');
  const back = await caption();
  expect([back.bg, back.ring, back.backed]).toEqual(['rgba(0, 0, 0, 0)', 'none', 0]);
  expect(seen.errors).toEqual([]);
});

test("cad:dark-pattern-failed a failed Pattern copy's red number stays readable under the pointer and keyboard focus in dark, as in light", async ({ page, request }) => {
  const { frame, seen } = await freshPart(page, request);
  // A 10 mm block patterned 3 times, 15 mm apart, joined: the copies don't touch it, so they are red.
  await addSolid(page, { size: [10, 10, 10] });
  await page.keyboard.press('Escape');
  await runCommand(frame, 'pattern.linear');
  const panel = frame.locator('[data-cad-panel="feature"]');
  await panel.locator('[data-field="of"] select').selectOption('bodies');
  await expect(panel.locator('[data-pick-field="bodies"]')).toHaveAttribute('data-active', '1');
  await still(page);
  const [bx, by] = await modelOnPage(page, [5, 5, 10]);
  await page.mouse.click(bx, by);
  await expect(panel.locator('[data-pick-field="bodies"] [data-pick-row]')).toHaveText([/^Body 1/]);
  await frame.locator('[data-tree-node="origin:x"] > .tree-row').click();
  await expect(panel.locator('[data-pick-field="dir1"] [data-pick-row]')).toHaveText(/X axis/);
  for (const [field, value] of [
    ['dir1-count', '3'],
    ['dir1-distance', '15'],
  ]) {
    const input = panel.locator(`.nui[data-field="${field}"] input`);
    await input.fill(value);
    await input.press('Enter');
  }
  await panel.locator('[data-field="op"] select').selectOption('join');
  const marker = frame.locator('.cad-pattern-markers [data-pattern-marker="2"]');
  await expect(marker).toHaveClass(/is-failed/, { timeout: 60_000 });
  await still(page);
  /** The marker's text and background colours: under the pointer, then with keyboard focus (pointer away). */
  const looks = async () => {
    const read = () => marker.evaluate((el) => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
    await marker.hover();
    const hover = await read();
    await page.mouse.move(5, 5);
    await marker.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions));
    expect(await marker.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    const focus = await read();
    await marker.evaluate((el) => (el as HTMLElement).blur());
    return { hover, focus };
  };
  const rgb = (c: string): RGB => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number) as RGB;
  const light = await looks();
  // Light as before: the red number on the hover blue.
  expect(light.hover).toEqual({ color: cssRgb('#b42318'), bg: cssRgb('#b2ccff') });
  expect(light.focus).toEqual(light.hover);
  await appearance(page, 'dark');
  const dark = await looks();
  // The host's dark --mg-danger (the frame's theme.css) on CAD's red-tinted hover.
  expect(dark.hover).toEqual({ color: cssRgb(hostTokens().dark.get('--mg-danger')!), bg: cssRgb('#4a2522') });
  expect(dark.focus).toEqual(dark.hover);
  expect(contrastOf(rgb(dark.hover.color), rgb(dark.hover.bg)), 'the red number on its hover background').toBeGreaterThanOrEqual(4.5);
  await appearance(page, 'light');
  expect(await looks()).toEqual(light);
  expect(seen.errors).toEqual([]);
});

test("cad:dark-chrome the toolbar is the host's dark one, a button under the pointer stands off it, and a selected row and an active button are the core's blue, in dark as in light", async ({ page, request }) => {
  const { frame, seen } = await freshPart(page, request);
  const bar = frame.locator('[data-cad-toolbar]');
  // A selected tree row, and the Picture tool open (its toolbar button pressed).
  const row = frame.locator('[data-tree-node="origin:top"]');
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await expect(row).toHaveClass(/selected/);
  await runCommand(frame, 'file.picture');
  await expect(frame.locator('[data-cad-panel="tool"]')).toBeVisible();
  const active = bar.locator('.tb-btn.is-active').first();
  await expect(active).toBeVisible();
  await expect(row).toHaveClass(/selected/);
  const btn = bar.locator('.tb-btn[data-command]:not(.is-disabled):not(.is-active):not(.is-primary)').filter({ visible: true }).first();
  const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
  /** The toolbar's background, a button's away from the pointer and under it, the selected row's and the pressed button's. */
  const looks = async () => {
    await page.mouse.move(5, 5);
    const rest = await bg(btn);
    await btn.hover();
    const hover = await bg(btn);
    await page.mouse.move(5, 5);
    return {
      bar: await bg(bar),
      rest,
      hover,
      selected: await bg(frame.locator('[data-tree-node="origin:top"] > .tree-row')),
      active: await active.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor })),
    };
  };
  const rgb = (c: string): RGB => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number) as RGB;
  const light = await looks();
  // Light as before: the icon buttons' faint hover on the core's toolbar grey, the core's active blue.
  expect(light).toEqual({ bar: cssRgb('#f2f4f7'), rest: 'rgba(0, 0, 0, 0)', hover: cssRgb('#eef0f4'), selected: cssRgb('#d7e8ff'), active: { bg: cssRgb('#d7e8ff'), border: cssRgb('#9bc2f0') } });
  await appearance(page, 'dark');
  const dark = await looks();
  // The host's dark set is live in the frame: the toolbar is its dark --mg-surface-muted, and the
  // selected row and the pressed button its dark --mg-active-bg / -border, as the core's tree and toolbar.
  const host = hostTokens().dark;
  expect(dark.bar).toBe(cssRgb(host.get('--mg-surface-muted')!));
  expect(dark.selected).toBe(cssRgb(host.get('--mg-active-bg')!));
  expect(dark.active).toEqual({ bg: cssRgb(host.get('--mg-active-bg')!), border: cssRgb(host.get('--mg-active-border')!) });
  expect(dark.hover).toBe(cssRgb(themeValue('--cad-toolbar-hover-bg', 'dark')!));
  expect(contrastOf(rgb(dark.hover), rgb(dark.bar)), 'the hover on the dark toolbar').toBeGreaterThanOrEqual(1.15);
  await appearance(page, 'light');
  expect(await looks()).toEqual(light);
  expect(seen.errors).toEqual([]);
});

test("cad:dark-sketch-picture in sketch mode a picture taken while dark is the light one, and the view keeps its dark lines", async ({ page, request }) => {
  const { frame, seen } = await freshPart(page, request);
  const f = workspaceFrame(page);
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await still(page);
  // A free line (under defined).
  await page.keyboard.press('l');
  for (const p of [
    [5, 5, 0],
    [35, 25, 0],
  ] as V3[]) {
    const [x, y] = await modelOnPage(page, p);
    await page.mouse.click(x, y);
  }
  await page.keyboard.press('Escape');
  await still(page);
  await page.keyboard.press('Escape');
  await still(page);
  const snapshot = (name: string) =>
    f.evaluate((name) => {
      const r = (window as unknown as W).__CAD__.services.viewport.get().handle.snapshot({ view: 'iso', width: 320, height: 240, hide: [], section: null });
      (window as unknown as Record<string, Uint8ClampedArray>)[name] = r.rgba;
      const d = r.rgba as Uint8ClampedArray;
      // The sketch's line in the picture: its light under-defined blue (a target draws three's lines a little darker).
      let blue = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 80 && d[i + 2] > 120) blue++;
      return blue;
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
  expect(await snapshot('__skLight'), 'the line in the light picture').toBeGreaterThan(20);
  await appearance(page, 'dark');
  const before = await canvasShot(page);
  await snapshot('__skDark');
  expect(await differ('__skLight', '__skDark'), 'the picture taken in dark is the one taken in light').toBeLessThan(0.002);
  // The view, its lines dark as before the picture.
  await still(page);
  expect(differs(before, await canvasShot(page)), 'the view after the picture').toBeLessThan(0.002);
  expect(dist(await cornerPixel(page), 0, DARK_BG)).toBeLessThanOrEqual(2);
  await appearance(page, 'light');
  expect(seen.errors).toEqual([]);
});

test("cad:dark-picture-save the Picture panel's Save PNG link looks exactly like the kit's secondary button, at rest, under the pointer and focused, in light and dark", async ({ page, request }) => {
  const { frame, seen } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  await runCommand(frame, 'file.picture');
  const pic = frame.locator('[data-cad-panel="tool"]');
  await pic.locator('[data-picture-take]').click();
  const save = pic.locator('[data-picture-save]');
  await expect(save).toBeVisible({ timeout: 60_000 });
  await expect(save).toHaveAttribute('download', 'Part picture.png');
  // The kit's own secondary button beside it, with the same words: what the link must look like.
  await save.evaluate((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mgk-btn mgk-btn--secondary';
    b.dataset.kitTwin = '1';
    b.textContent = a.textContent;
    a.after(b);
  });
  const kit = pic.locator('[data-kit-twin]');
  const PROPS = ['color', 'background-color', 'border-top-color', 'border-top-width', 'border-top-style', 'border-left-width', 'border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform', 'display', 'vertical-align', 'cursor', 'box-sizing', 'outline-style', 'outline-width', 'outline-color', 'outline-offset', 'box-shadow', 'opacity'] as const;
  const look = (l: Locator) =>
    l.evaluate(
      (el, props) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { ...Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])), height: Math.round(r.height * 10) / 10, width: Math.round(r.width * 10) / 10 };
      },
      [...PROPS],
    );
  /** One of them in a state: at rest, under the pointer, or with keyboard focus. */
  const put = async (l: Locator, name: string, state: 'rest' | 'hover' | 'focus') => {
    await page.mouse.move(5, 5);
    await l.evaluate((el) => (el as HTMLElement).blur());
    if (state === 'hover') await l.hover();
    if (state === 'focus') {
      await l.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions));
      expect(await l.evaluate((el) => el.matches(':focus-visible')), `${name} has keyboard focus`).toBe(true);
    }
  };
  /**
   * Both, as the person sees them: their computed look, and their pixels: the link, then the kit's
   * button in the link's place (the link taken out of the row meanwhile), the same clip with a
   * focus ring's room.
   */
  const both = async (state: 'rest' | 'hover' | 'focus') => {
    const out: { link: Record<string, unknown>; kit: Record<string, unknown>; differ: number } = { link: {}, kit: {}, differ: 1 };
    for (const [name, l] of [
      ['link', save],
      ['kit', kit],
    ] as const) {
      await put(l, name, state);
      out[name] = await look(l);
    }
    const box = (await save.boundingBox())!;
    const clip = { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 };
    await put(save, 'link', state);
    const a = await page.screenshot({ clip });
    await save.evaluate((el) => {
      el.before(document.querySelector('[data-kit-twin]')!);
      (el as HTMLElement).style.display = 'none';
    });
    expect((await kit.boundingBox())!, "the kit button in the link's place").toEqual(box);
    await put(kit, 'kit', state);
    const b = await page.screenshot({ clip });
    await save.evaluate((el) => {
      (el as HTMLElement).style.display = '';
      el.after(document.querySelector('[data-kit-twin]')!);
    });
    await page.mouse.move(5, 5);
    out.differ = differs(a, b);
    return out;
  };
  const check = async (theme: string) => {
    for (const state of ['rest', 'hover', 'focus'] as const) {
      const r = await both(state);
      const diff = PROPS.filter((p) => r.link[p] !== r.kit[p]).map((p) => `${p}: ${r.link[p]} vs ${r.kit[p]}`);
      expect(diff, `${theme} ${state}: the link's look against the kit button's`).toEqual([]);
      expect([r.link.height, r.link.width], `${theme} ${state}: its size`).toEqual([r.kit.height, r.kit.width]);
      expect(r.differ, `${theme} ${state}: the same pixels`).toBeLessThan(0.01);
      // No link blue, no underline.
      expect(r.link['text-decoration-line']).toBe('none');
    }
  };
  await check('light');
  await appearance(page, 'dark');
  await check('dark');
  await appearance(page, 'light');
  await check('light again');
  expect(seen.errors).toEqual([]);
});

test("cad:dark-tooltip-edge a tooltip and the toolbar's drag note have the host tooltip's edge in dark, as the core's tooltips do; in light it paints nothing", async ({ page, request }) => {
  const { frame, seen } = await freshPart(page, request);
  const f = workspaceFrame(page);
  const host = hostTokens();
  // The toolbar's drag note as a drag shows it (Toolbar.tsx DragGhost), over the view: a real drag
  // rewrites the person's toolbar layout (the serial toolbar specs), the look is the same.
  await f.evaluate(() => {
    const g = document.createElement('div');
    g.className = 'tb-drag-ghost';
    g.dataset.e2eGhost = '1';
    g.style.left = '700px';
    g.style.top = '520px';
    const note = document.createElement('div');
    note.className = 'tb-drag-note';
    note.textContent = 'Spline moves to More';
    g.append(note);
    document.body.append(g);
  });
  const note = frame.locator('[data-e2e-ghost] .tb-drag-note');
  /** A toolbar button's tooltip (the kit's, over the toolbar). */
  const tip = async () => {
    await page.mouse.move(5, 5);
    await frame.locator('[data-cad-toolbar] .tb-btn[data-command="file.picture"]').hover();
    const t = frame.locator('[data-cad-tip]');
    await expect(t).toBeVisible();
    return t;
  };
  /** Its edge (computed), the pixels around it, and the same pixels with the edge taken off. */
  const edge = async (l: Locator) => {
    const look = await l.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth, color: getComputedStyle(el).outlineColor, offset: getComputedStyle(el).outlineOffset }));
    const r = (await l.boundingBox())!;
    const clip = { x: Math.floor(r.x) - 3, y: Math.floor(r.y) - 3, width: Math.ceil(r.width) + 6, height: Math.ceil(r.height) + 6 };
    const withEdge = await page.screenshot({ clip });
    await l.evaluate((el) => ((el as HTMLElement).style.outline = 'none'));
    const without = await page.screenshot({ clip });
    await l.evaluate((el) => ((el as HTMLElement).style.outline = ''));
    // The ring 1 px outside the box, along the middle of its left and right sides and of its top and bottom.
    const img = PNG.decode(withEdge);
    const ring = (c: RGB) => {
      const at = [
        [r.x - 0.5, r.y + r.height / 2],
        [r.x + r.width + 0.5, r.y + r.height / 2],
        [r.x + r.width / 2, r.y - 0.5],
        [r.x + r.width / 2, r.y + r.height + 0.5],
      ];
      return at.map(([x, y]) => {
        let best = Infinity;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const px = Math.round(x - clip.x + dx - 0.5);
            const py = Math.round(y - clip.y + dy - 0.5);
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
            best = Math.min(best, dist(img.data, 4 * (py * img.width + px), c));
          }
        return best;
      });
    };
    return { look, ring, changed: differs(withEdge, without) };
  };
  for (const [name, get] of [
    ['tooltip', tip],
    ['drag note', async () => note],
  ] as const) {
    // Light: the host's light edge is transparent: the surface's pixels are the ones without an edge.
    const light = await edge(await get());
    expect(light.look, `light ${name}: its edge`).toEqual({ style: 'solid', width: '1px', color: 'rgba(0, 0, 0, 0)', offset: '0px' });
    expect(light.changed, `light ${name}: the edge paints nothing`).toBe(0);
    await appearance(page, 'dark');
    const dark = await edge(await get());
    const want = host.dark.get('--mg-tooltip-edge')!;
    expect(dark.look, `dark ${name}: the host tooltip's edge`).toEqual({ style: 'solid', width: '1px', color: cssRgb(want), offset: '0px' });
    expect(dark.changed, `dark ${name}: the edge shows`).toBeGreaterThan(0.02);
    const ring = dark.ring(hexRgb(want));
    expect(Math.max(...ring), `dark ${name}: the line around it is ${want} (${ring})`).toBeLessThanOrEqual(14);
    await appearance(page, 'light');
  }
  await page.mouse.move(5, 5);
  expect(seen.errors).toEqual([]);
});

test("cad:dark-triad each orientation arrow reads 3:1 and more on the dark view at the home view and every standard view, Y too; light's triad is the core's", async ({ page, request }) => {
  const { seen } = await freshPart(page, request);
  const f = workspaceFrame(page);
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  const triadClip = async () => {
    const r = await f.evaluate(() => {
      const s = document.querySelector('[data-triad-slot]')!.getBoundingClientRect();
      return { x: s.x, y: s.y, w: s.width, h: s.height };
    });
    return { x: Math.round(box.x + r.x), y: Math.round(box.y + r.y), width: Math.round(r.w), height: Math.round(r.h) };
  };
  /**
   * Each arrow's pixels in the triad's corner (the pixels nearest its colour's hue: X red, Y green,
   * Z blue, well clear of the background) and the contrast on the background of its brightest
   * ones: the 8th brightest (a few pixels are not an arrow you can see).
   */
  const arrows = async (bg: RGB) => {
    const img = PNG.decode(await page.screenshot({ clip: await triadClip() }));
    const out: Record<'x' | 'y' | 'z', { n: number; contrast: number }> = { x: { n: 0, contrast: 0 }, y: { n: 0, contrast: 0 }, z: { n: 0, contrast: 0 } };
    const by: Record<'x' | 'y' | 'z', number[]> = { x: [], y: [], z: [] };
    for (let i = 0; i < img.data.length; i += 4) {
      const c: RGB = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (dist(img.data, i, bg) <= 12) continue;
      const [r, g, b] = c;
      const k = r > g + 30 && r > b + 30 ? 'x' : g > r + 25 && g > b + 15 ? 'y' : b > r + 30 && b > g + 15 ? 'z' : null;
      if (k) by[k].push(contrastOf(c, bg));
    }
    for (const k of ['x', 'y', 'z'] as const) {
      const s = by[k].sort((a, b) => b - a);
      out[k] = { n: s.length, contrast: Math.round((s[Math.min(7, s.length - 1)] ?? 1) * 100) / 100 };
    }
    return out;
  };
  const VIEWS = ['home', 'iso', 'iso_back', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;
  const look = async (view: (typeof VIEWS)[number]) => {
    await f.evaluate((v) => (window as unknown as W).__CAD__.services.viewport.get().handle.setView(v, { animate: false }), view);
    await still(page);
  };
  // Light: the core's triad, lit by the headlight alone (as vtkAxesActor), the core's axis colours.
  await look('home');
  const lightHome = await arrows(LIGHT_BG);
  const lightCorner = await page.screenshot({ clip: await triadClip() });
  await appearance(page, 'dark');
  const results: Record<string, unknown> = {};
  const low: string[] = [];
  for (const view of VIEWS) {
    await look(view);
    const a = await arrows(DARK_BG);
    results[view] = a;
    // An arrow seen end-on (Y from the front or back, Z from the top or bottom, X from the left or
    // right) is a dot: it still reads, but has few pixels.
    for (const k of ['x', 'y', 'z'] as const) if (a[k].n >= 8 && a[k].contrast < 3) low.push(`${view} ${k}: ${a[k].contrast} (${a[k].n} px)`);
  }
  console.log(`[dark-triad] light home ${JSON.stringify(lightHome)} dark ${JSON.stringify(results)}`);
  expect(low, 'every arrow reads 3:1 and more on the dark background').toEqual([]);
  // At the home view every arrow is drawn with enough pixels to see (the Y arrow points away from the eye there).
  const home = results.home as Record<'x' | 'y' | 'z', { n: number; contrast: number }>;
  for (const k of ['x', 'y', 'z'] as const) expect(home[k].n, `home ${k}'s pixels`).toBeGreaterThanOrEqual(8);
  // Back in light: the core's triad, its corner pixel for pixel as before the dark view (its shading too).
  await appearance(page, 'light');
  await look('home');
  expect(await arrows(LIGHT_BG)).toEqual(lightHome);
  expect(differs(lightCorner, await page.screenshot({ clip: await triadClip() })), "the triad's corner back in light").toBeLessThan(0.002);
  expect(seen.errors).toEqual([]);
});
