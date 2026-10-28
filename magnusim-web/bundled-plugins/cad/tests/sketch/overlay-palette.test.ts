// @vitest-environment node
// Sketch mode's lines follow the view's palette (src/sketch/overlay.ts, the sketch-geometry
// layer's `palette` hook): a dark palette draws the lines, the points and the grid again in its
// inks at once, with the cursor's dark tone (the light one over a light face); E2: every set of
// lines (solid, dashed, the preview, guides, dimension lines, the grid) and the points also carry
// their face colours, LIGHT's ink for each segment's role, which the view draws where a light face
// shows under them (src/viewport/onface.ts); the hover halo keeps its one colour, at .85 over a
// face and fainter over the dark background, so a hovered line keeps its colour there; a driven
// dimension's lines stay apart from a driving one's; LIGHT (a picture, or the
// theme back to light) gives the light colours and no face colours, the grid's too when a near
// edge-on view keeps the grid it has.
// The real sketch mode (the solver in this process, tests/sketch/harness.ts, which loads it in
// Node) with a DOM of its own for the overlay's HTML, set up once the solver is loaded.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Color, Group, type Object3D, type Points } from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { afterEach, describe, expect, it } from 'vitest';
import { attachOverlay } from '../../src/sketch/overlay';
import type { PlaneFrame, Vec3 } from '../../src/types/doc';
import type { ViewportHandle } from '../../src/types/viewport';
import { faceColoursOf, faceOpacityOf, isFaceTwin, syncFaceTwins } from '../../src/viewport/onface';
import { DARK, LIGHT, type MarkPalette } from '../../src/viewport/palette';
import { rectangle, sketchOf } from './fixtures';
import { sketchHarness, type Harness } from './harness';

let h: Harness | null = null;
let detach: (() => void) | null = null;
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser', 'CSS'] as const;
let saved: Record<string, PropertyDescriptor | undefined> = {};
/** jsdom (a dev dependency; vitest's own DOM), loaded by name: the plugin has no types for it. */
const JSDOM_MODULE = 'jsdom';
/** A DOM for the overlay (after the solver loaded: it must load as in Node). */
async function withDom() {
  const { JSDOM } = (await import(/* @vite-ignore */ JSDOM_MODULE)) as { JSDOM: new (html: string, o: object) => { window: Window & typeof globalThis } };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  saved = {};
  for (const k of GLOBALS) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    // CSS.supports: a browser's answer for a one-image cursor (jsdom has none), so the cursors are images.
    const v = k === 'window' ? dom.window : k === 'CSS' ? { supports: (_p: string, val: string) => val.startsWith('url(') } : (dom.window as unknown as Record<string, unknown>)[k];
    Object.defineProperty(globalThis, k, { value: typeof v === 'function' && !/^[A-Z]/.test(k) ? (v as (...a: unknown[]) => unknown).bind(dom.window) : v, configurable: true, writable: true });
  }
}
afterEach(() => {
  detach?.();
  detach = null;
  h?.dispose();
  h = null;
  for (const k of GLOBALS) {
    const d = saved[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
});

/**
 * A viewport handle with what the overlay uses; 10 px per mm on the Top plane; keeps each layer's
 * palette hook. `edgeOn(true)`: the plane seen near edge-on, so far across that the grid is not
 * drawn again (src/sketch/overlay.ts drawGrid: more than 400 steps).
 */
function fakeHandle() {
  const hooks = new Map<string, (p: MarkPalette) => void>();
  const groups = new Map<string, Group>();
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  host.appendChild(canvas);
  document.body.appendChild(host);
  let palette: MarkPalette = LIGHT;
  let far = 1;
  /** What lightSurfaceAt answers (a light face under the pointer). */
  let face = false;
  let tool: { onPointer(e: unknown): boolean } | null = null;
  const handle = {
    lightSurfaceAt: () => face,
    addLayer(id: string, o: { palette?: (p: MarkPalette) => void } = {}) {
      const group = new Group();
      groups.set(id, group);
      if (o.palette) hooks.set(id, o.palette);
      const html = document.createElement('div');
      host.appendChild(html);
      return { id, group, html, setVisible() {}, changed() {}, dispose: () => html.remove() };
    },
    palette: () => palette,
    onFrame: () => () => {},
    pushTool: (t: { onPointer(e: unknown): boolean }) => {
      tool = t;
      return () => {};
    },
    pixelSize: () => 0.1,
    project: (p: Vec3) => [400 + p[0] * 10, 300 - p[1] * 10] as [number, number],
    toPlane: (x: number, y: number, _plane: PlaneFrame) => ({ p: [((x - 400) / 10) * far, ((300 - y) / 10) * far, 0] as Vec3, uv: [((x - 400) / 10) * far, ((300 - y) / 10) * far] as [number, number] }),
  };
  const edgeOn = (on: boolean) => {
    far = on ? 1000 : 1;
  };
  const overFace = (on: boolean) => {
    face = on;
  };
  /** As the viewport does on setPalette: the live palette, then each hook. */
  const setPalette = (p: MarkPalette) => {
    palette = p;
    for (const fn of hooks.values()) fn(p);
  };
  /** The pointer moved over the canvas (client px), as the viewport hands it to sketch mode's tool. */
  const pointer = (x: number, y: number) => tool?.onPointer({ type: 'move', button: 0, buttons: 0, clientX: x, clientY: y, ctrl: false, shift: false, alt: false, ray: { origin: [0, 0, 0], dir: [0, 0, -1] }, native: {} });
  return { handle: handle as unknown as ViewportHandle, hooks, groups, canvas, setPalette, edgeOn, overFace, pointer };
}

type Line = LineSegments2 & { material: LineMaterial };
/** The sketch-geometry layer's undashed fat lines by draw order (the grid 900, the solid lines 1000). */
function lines(groups: Map<string, Group>): Map<number, Line> {
  const out = new Map<number, Line>();
  groups.get('sketch-geometry')!.traverse((o: Object3D) => {
    if ((o as Line).isLineSegments2 && !(o as Line).material.dashed && !out.has(o.renderOrder)) out.set(o.renderOrder, o as Line);
  });
  return out;
}

/** Every line set and point set of both sketch layers, by draw order (the grid 900, the halo 990, the rest 1000 and up). */
function marks(groups: Map<string, Group>) {
  const sets: (Line | Points)[] = [];
  for (const id of ['sketch-geometry', 'sketch-annotations'])
    groups.get(id)!.traverse((o: Object3D) => {
      if ((o as Line).isLineSegments2 || (o as Points).isPoints) sets.push(o as Line | Points);
    });
  return sets;
}

/** The distinct colours of a geometry's segments or points, as '#rrggbb'. */
function coloursOf(g: Line['geometry'] | Points['geometry']): string[] {
  const a = g.getAttribute('instanceColorStart') ?? g.getAttribute('color');
  const seen = new Set<string>();
  for (let i = 0; i < a.count; i++) seen.add(`#${new Color(a.getX(i), a.getY(i), a.getZ(i)).getHexString()}`);
  return [...seen].sort();
}
/** The distinct colours of a line's segments, as '#rrggbb'. */
function colours(l: Line): string[] {
  return l.visible ? coloursOf(l.geometry) : [];
}

async function sketchWithOverlay() {
  h = await sketchHarness(sketchOf(rectangle(0, 0, 20, 10)));
  await h.idle();
  await withDom();
  const v = fakeHandle();
  detach = attachOverlay(h.mode, v.handle);
  h.tool('line');
  await h.idle();
  return v;
}

describe('sketch mode and the palette', () => {
  it('draws in LIGHT, again in the dark inks at once, and LIGHT again exactly', async () => {
    const v = await sketchWithOverlay();
    expect(v.hooks.has('sketch-geometry')).toBe(true);
    const light = { solid: colours(lines(v.groups).get(1000)!), grid: colours(lines(v.groups).get(900)!), cursor: v.canvas.style.cursor };
    expect(light.solid).toEqual([LIGHT.sketch.under]);
    expect(light.grid).toEqual([LIGHT.sketch.grid, LIGHT.sketch.gridMajor].sort());
    // Light: nothing carries face colours (nothing is drawn twice).
    expect(marks(v.groups).filter((o) => faceColoursOf(o.geometry))).toEqual([]);
    // The draw cursor in the light tone (#101828 ink).
    expect(light.cursor).toContain('101828');
    v.setPalette(DARK);
    expect(colours(lines(v.groups).get(1000)!)).toEqual([DARK.sketch.under]);
    expect(colours(lines(v.groups).get(900)!)).toEqual([DARK.sketch.grid, DARK.sketch.gridMajor].sort());
    // The cursor in the dark tone (white): a different image from the light one.
    expect(v.canvas.style.cursor).not.toBe(light.cursor);
    expect(v.canvas.style.cursor).not.toContain('101828');
    v.setPalette(LIGHT);
    expect(colours(lines(v.groups).get(1000)!)).toEqual(light.solid);
    expect(colours(lines(v.groups).get(900)!)).toEqual(light.grid);
    expect(v.canvas.style.cursor).toBe(light.cursor);
    expect(marks(v.groups).filter((o) => faceColoursOf(o.geometry))).toEqual([]);
  });

  // E2 judgement: a white cursor melts into a light face (1.6:1 on the body colour): over one, in a
  // dark view, the cursor is the light view's (dark, with a white halo); in light it never asks.
  it('gives the draw cursor the light tone over a light face in a dark view, the dark tone elsewhere', async () => {
    const v = await sketchWithOverlay();
    const move = (x: number, y: number) => v.pointer(x, y);
    const light = v.canvas.style.cursor;
    v.overFace(true);
    move(420, 280);
    await h!.idle();
    expect(v.canvas.style.cursor, 'light: over a face as anywhere').toBe(light);
    v.setPalette(DARK);
    v.overFace(false);
    move(430, 280);
    await h!.idle();
    const dark = v.canvas.style.cursor;
    expect(dark).not.toBe(light);
    expect(dark).not.toContain('101828');
    v.overFace(true);
    move(440, 280);
    await h!.idle();
    expect(v.canvas.style.cursor, 'dark, over a light face: the light tone').toBe(light);
    v.overFace(false);
    move(450, 280);
    await h!.idle();
    expect(v.canvas.style.cursor).toBe(dark);
  });

  // Review round 1: drawGrid draws no new grid in a near edge-on view, and the one there kept the old
  // palette's colours: the light grid stayed bright on the dark view, and a picture taken while dark
  // showed the dark grid on its light background.
  it('recolours the grid a near edge-on view keeps: the dark palette, LIGHT for a picture, and back', async () => {
    const v = await sketchWithOverlay();
    const grid = () => lines(v.groups).get(900)!;
    const built = grid().geometry;
    expect(colours(grid())).toEqual([LIGHT.sketch.grid, LIGHT.sketch.gridMajor].sort());
    v.edgeOn(true);
    v.setPalette(DARK);
    expect(colours(grid())).toEqual([DARK.sketch.grid, DARK.sketch.gridMajor].sort());
    // The same lines, recoloured (no new grid was laid out).
    expect(grid().geometry.getAttribute('instanceStart').count).toBe(built.getAttribute('instanceStart').count);
    // A picture while dark: the hook with LIGHT, then the live palette again.
    const hook = v.hooks.get('sketch-geometry')!;
    hook(LIGHT);
    expect(colours(grid())).toEqual([LIGHT.sketch.grid, LIGHT.sketch.gridMajor].sort());
    hook(DARK);
    expect(colours(grid())).toEqual([DARK.sketch.grid, DARK.sketch.gridMajor].sort());
    // Back to a view that draws a grid: the new grid in the live colours.
    v.edgeOn(false);
    v.setPalette(LIGHT);
    expect(colours(grid())).toEqual([LIGHT.sketch.grid, LIGHT.sketch.gridMajor].sort());
  });

  it("E2: every line set and the points (the preview, construction and dimension lines, the grid) carry LIGHT's ink for each segment's role; none in light", async () => {
    // A rectangle (solid, under defined), a construction line (dashed), a driving and a driven dimension.
    const g = rectangle(0, 0, 20, 10);
    g.points.q1 = [0, 20];
    g.points.q2 = [20, 20];
    g.entities.push({ id: 'k1', kind: 'line', p: ['q1', 'q2'], construction: true });
    g.constraints.push({ id: 'dw', kind: 'distance', refs: ['e1'], expr: '20 mm', driving: true }, { id: 'dd', kind: 'distance', refs: ['e2'], expr: '10 mm', driving: false });
    h = await sketchHarness(sketchOf(g));
    await h.idle();
    await withDom();
    const v = fakeHandle();
    detach = attachOverlay(h.mode, v.handle);
    // The line tool's rubber band: a preview line from a placed start to the pointer.
    h.tool('line');
    h.click([30, 0]);
    h.move([40, 5]);
    await h.idle();
    v.setPalette(DARK);
    const shown = marks(v.groups).filter((o) => o.visible && o.renderOrder !== 990);
    // The grid, solid, dashed, preview, dimension lines and points at least.
    expect(shown.length).toBeGreaterThanOrEqual(6);
    expect(shown.some((o) => (o as Line).isLineSegments2 && (o as Line).material.dashed)).toBe(true);
    expect(shown.some((o) => (o as Points).isPoints)).toBe(true);
    expect(shown.some((o) => o.renderOrder === 900)).toBe(true);
    const roles = Object.keys(DARK.sketch) as (keyof typeof DARK.sketch)[];
    const faceOf = (c: string) => new Set(roles.filter((r) => DARK.sketch[r] === c).map((r) => LIGHT.sketch[r]));
    for (const o of shown) {
      const face = faceColoursOf(o.geometry);
      expect(face, `${o.renderOrder}: face colours`).toBeTruthy();
      // Each segment's (point's) face colour is its role's LIGHT ink, in the same place.
      const dark = o.geometry.getAttribute((o as Line).isLineSegments2 ? 'instanceColorStart' : 'color');
      const lit = face!.getAttribute((o as Line).isLineSegments2 ? 'instanceColorStart' : 'color');
      expect(lit.count).toBe(dark.count);
      for (let i = 0; i < dark.count; i++) {
        const d = `#${new Color(dark.getX(i), dark.getY(i), dark.getZ(i)).getHexString()}`;
        const l = `#${new Color(lit.getX(i), lit.getY(i), lit.getZ(i)).getHexString()}`;
        expect([...faceOf(d)], `${o.renderOrder} segment ${i}: ${d}`).toEqual([l]);
      }
      // Dashed on the same distances.
      if ((o as Line).isLineSegments2 && (o as Line).material.dashed) expect(Array.from(face!.getAttribute('instanceDistanceStart').array as Float32Array)).toEqual(Array.from(o.geometry.getAttribute('instanceDistanceStart').array as Float32Array));
    }
    // What the dark lines show over a face: LIGHT's inks, the driven dimension's grey and the construction grey among them.
    expect(new Set(shown.flatMap((o) => coloursOf(faceColoursOf(o.geometry)!)))).toEqual(new Set(shown.flatMap((o) => coloursOf(o.geometry)).map((c) => [...faceOf(c)][0])));
    v.setPalette(LIGHT);
    expect(marks(v.groups).filter((o) => faceColoursOf(o.geometry))).toEqual([]);
  });

  it('draws the hover halo fainter over the dark background (the line keeps its colour in it) and as in light over a face; light as before', async () => {
    h = await sketchHarness(sketchOf(rectangle(0, 0, 20, 10)));
    await h.idle();
    await withDom();
    const v = fakeHandle();
    detach = attachOverlay(h.mode, v.handle);
    await h.idle();
    h.mode.setHover({ what: 'entity', id: 'e1' });
    const halo = () => marks(v.groups).find((o) => o.renderOrder === 990) as Line;
    const twin = () => halo().children.find(isFaceTwin) as Line | undefined;
    // Light: .85, in the hover blue, drawn once.
    expect(halo().visible).toBe(true);
    expect(colours(halo())).toEqual([LIGHT.sketch.hover]);
    expect(halo().material.opacity).toBe(0.85);
    expect(faceColoursOf(halo().geometry)).toBeUndefined();
    expect(faceOpacityOf(halo().material)).toBeUndefined();
    v.setPalette(DARK);
    // Dark: the same blue; over the background .45, over a light face (its twin) .85.
    expect(colours(halo())).toEqual([DARK.sketch.hover]);
    expect(DARK.sketch.hover).toBe(LIGHT.sketch.hover);
    expect(coloursOf(faceColoursOf(halo().geometry)!)).toEqual([LIGHT.sketch.hover]);
    expect(halo().material.opacity).toBe(0.45);
    expect(faceOpacityOf(halo().material)).toBe(0.85);
    syncFaceTwins(v.groups.get('sketch-geometry')!, true);
    expect(twin()!.visible).toBe(true);
    expect([twin()!.material.opacity, halo().material.opacity]).toEqual([0.85, 0.45]);
    // A picture (LIGHT) and the theme back: .85, drawn once.
    v.setPalette(LIGHT);
    syncFaceTwins(v.groups.get('sketch-geometry')!, false);
    expect(halo().material.opacity).toBe(0.85);
    expect(faceOpacityOf(halo().material)).toBeUndefined();
    expect(twin()?.visible ?? false).toBe(false);
  });

  it("keeps a driven dimension's lines apart from a driving one's in dark, and over a face as in light", async () => {
    const g = rectangle(0, 0, 20, 10);
    g.constraints.push({ id: 'dw', kind: 'distance', refs: ['e1'], expr: '20 mm', driving: true }, { id: 'dd', kind: 'distance', refs: ['e2'], expr: '10 mm', driving: false });
    h = await sketchHarness(sketchOf(g));
    await h.idle();
    await withDom();
    const v = fakeHandle();
    detach = attachOverlay(h.mode, v.handle);
    await h.idle();
    const dimLines = () => {
      let out: Line | null = null;
      v.groups.get('sketch-annotations')!.traverse((o: Object3D) => {
        if ((o as Line).isLineSegments2 && o.renderOrder === 1003) out = o as Line;
      });
      return out!;
    };
    expect(colours(dimLines())).toEqual([LIGHT.sketch.dim, LIGHT.sketch.driven].sort());
    v.setPalette(DARK);
    expect(colours(dimLines())).toEqual(['#9aa4b2', '#e6e9ef']);
    expect(coloursOf(faceColoursOf(dimLines().geometry)!)).toEqual([LIGHT.sketch.dim, LIGHT.sketch.driven].sort());
    expect(colours(lines(v.groups).get(1000)!)).toEqual([DARK.sketch.under]);
    expect(DARK.sketch.under).toBe('#7aa7ff');
  });
});
