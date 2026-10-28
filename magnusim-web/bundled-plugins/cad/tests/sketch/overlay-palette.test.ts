// @vitest-environment node
// Sketch mode's lines follow the view's palette (src/sketch/overlay.ts, the sketch-geometry
// layer's `palette` hook): a dark palette draws the lines, the points and the grid again in its
// inks at once, with the cursor's dark tone; E2's candidate (b) puts a background-coloured rim
// under every set of lines (solid, dashed, the preview, guides, dimension lines) and under the
// points; (c) keeps a driven dimension's lines apart from a driving one's; LIGHT (a picture, or
// the theme back to light) gives the light colours.
// The real sketch mode (the solver in this process, tests/sketch/harness.ts, which loads it in
// Node) with a DOM of its own for the overlay's HTML, set up once the solver is loaded.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Color, Group, type Object3D, type Points, type PointsMaterial } from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { afterEach, describe, expect, it } from 'vitest';
import { attachOverlay } from '../../src/sketch/overlay';
import type { PlaneFrame, Vec3 } from '../../src/types/doc';
import type { ViewportHandle } from '../../src/types/viewport';
import { DARK, darkPalette, LIGHT, type MarkPalette } from '../../src/viewport/palette';
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

/** A viewport handle with what the overlay uses; 10 px per mm on the Top plane; keeps each layer's palette hook. */
function fakeHandle() {
  const hooks = new Map<string, (p: MarkPalette) => void>();
  const groups = new Map<string, Group>();
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  host.appendChild(canvas);
  document.body.appendChild(host);
  let palette: MarkPalette = LIGHT;
  const handle = {
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
    pushTool: () => () => {},
    pixelSize: () => 0.1,
    project: (p: Vec3) => [400 + p[0] * 10, 300 - p[1] * 10] as [number, number],
    toPlane: (x: number, y: number, _plane: PlaneFrame) => ({ p: [(x - 400) / 10, (300 - y) / 10, 0] as Vec3, uv: [(x - 400) / 10, (300 - y) / 10] as [number, number] }),
  };
  /** As the viewport does on setPalette: the live palette, then each hook. */
  const setPalette = (p: MarkPalette) => {
    palette = p;
    for (const fn of hooks.values()) fn(p);
  };
  return { handle: handle as unknown as ViewportHandle, hooks, groups, canvas, setPalette };
}

type Line = LineSegments2 & { material: LineMaterial };
/** The sketch-geometry layer's undashed fat lines by draw order (the grid 900, the solid lines 1000); rims left out. */
function lines(groups: Map<string, Group>): Map<number, Line> {
  const out = new Map<number, Line>();
  groups.get('sketch-geometry')!.traverse((o: Object3D) => {
    if ((o as Line).isLineSegments2 && o.name !== 'sketch-rim' && !(o as Line).material.dashed && !out.has(o.renderOrder)) out.set(o.renderOrder, o as Line);
  });
  return out;
}

/** Every line set and point set of both sketch layers (the grid and the hover halo aside), and every rim (E2 b). */
function marks(groups: Map<string, Group>) {
  const sets: (Line | Points)[] = [];
  const rims: (Line | Points)[] = [];
  for (const id of ['sketch-geometry', 'sketch-annotations'])
    groups.get(id)!.traverse((o: Object3D) => {
      if (!(o as Line).isLineSegments2 && !(o as Points).isPoints) return;
      if (o.name === 'sketch-rim') rims.push(o as Line | Points);
      else if (o.renderOrder >= 1000) sets.push(o as Line | Points);
    });
  return { sets, rims };
}
const widthOf = (o: Line | Points) => ((o as Line).isLineSegments2 ? (o as Line).material.linewidth : ((o as Points).material as PointsMaterial).size);
const rimColour = (o: Line | Points) => `#${(o.material as unknown as { color: Color }).color.getHexString()}`;

/** The distinct colours of a line's segments, as '#rrggbb'. */
function colours(l: Line): string[] {
  if (!l.visible) return [];
  const a = l.geometry.getAttribute('instanceColorStart');
  const seen = new Set<string>();
  for (let i = 0; i < a.count; i++) seen.add(`#${new Color(a.getX(i), a.getY(i), a.getZ(i)).getHexString()}`);
  return [...seen].sort();
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
    expect(marks(v.groups).rims.filter((r) => r.visible)).toEqual([]);
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
  });

  it('E2 (b): a rim in the background colour, 1 px wider each side, under every line set and the points (the preview, construction and dimension lines too); none with (a) or (c)', async () => {
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
    v.setPalette(darkPalette({ sketch: 'b' }));
    const { sets, rims } = marks(v.groups);
    const shown = sets.filter((o) => o.visible);
    // Solid, dashed, preview, dimension lines and points at least.
    expect(shown.length).toBeGreaterThanOrEqual(5);
    expect(shown.some((o) => (o as Line).isLineSegments2 && (o as Line).material.dashed)).toBe(true);
    expect(shown.some((o) => (o as Points).isPoints)).toBe(true);
    for (const o of shown) {
      const rim = rims.find((r) => r.geometry === o.geometry);
      expect(rim, `${o.renderOrder}: a rim`).toBeTruthy();
      expect(rim!.visible).toBe(true);
      expect(widthOf(rim!)).toBeCloseTo(widthOf(o) + 2);
      expect(rimColour(rim!)).toBe('#1b1f27');
      // Drawn before every line and point, dashed as its line is.
      expect(rim!.renderOrder).toBeLessThan(990);
      if ((o as Line).isLineSegments2) expect((rim as Line).material.dashed).toBe((o as Line).material.dashed);
    }
    // In the geometry layer's frame (drawn before every line of both layers), the dimension lines' rim too.
    for (const r of rims) expect(v.groups.get('sketch-geometry')!.getObjectById(r.id)).toBe(r);
    for (const o of ['a', 'c'] as const) {
      v.setPalette(darkPalette({ sketch: o }));
      expect(marks(v.groups).rims.filter((r) => r.visible), `(${o}) no rim`).toEqual([]);
    }
    v.setPalette(LIGHT);
    expect(marks(v.groups).rims.filter((r) => r.visible)).toEqual([]);
  });

  it("E2 (c): a driven dimension's lines a darker grey than a driving one's, and every state its mid tone", async () => {
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
    expect(colours(dimLines())).toEqual(['#646d7e', '#8a93a3']);
    expect(colours(lines(v.groups).get(1000)!)).toEqual([DARK.sketch.under]);
    expect(DARK.sketch.under).toBe('#2e6bd8');
    v.setPalette(darkPalette({ sketch: 'a' }));
    expect(colours(dimLines())).toEqual(['#9aa4b2', '#e6e9ef']);
  });
});
