// @vitest-environment jsdom
// The marks over the view (src/ui/overlay.ts), drawn on a context that writes down every call: in
// the light theme they are drawn as they were before the overlay left Viewport.tsx (the log saved
// in __snapshots__/overlay-light.txt right after that move), with nothing painted on the margins;
// in dark the margins and the ring at the tunnel's wall come first, then the marks in dark colours
// with a halo under those that have none of their own; the rakes keep their colours; and pictures
// draw the light marks whatever the page's theme.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import { forgetColours, overlayColours } from '../src/app/colours';
import { defaultScene, type Body, type Scene } from '../src/scene/scene';
import type { Engine } from '../src/sim/engine';
import { SketchEditor } from '../src/sketch/editor';
import type { SketchEntity } from '../src/sketch/cad';
import { domainRectPx, type Drawn } from '../src/render/domain';
import { lightOverlay, overlayState, paintOverlay, type Drag, type OverlayState } from '../src/ui/overlay';
import { recordingContext } from './canvasLog';
import { themedStyles, tokenReader } from './themeTokens';

/** The view: zoomed out, so the 8 m x 4 m tunnel has margins all round. */
const VIEW = { cx: 4, cy: 2, mpp: 0.012, w: 800, h: 450, dpr: 1.25 };
/** The overlay canvas, the GPU canvas's size (device px). */
const CANVAS = { width: Math.round(VIEW.w * VIEW.dpr), height: Math.round(VIEW.h * VIEW.dpr) };

/** The frame on the GPU canvas for VIEW, as the engine records it (a 512 x 256 lattice). */
function drawnFor(view: typeof VIEW, nx = 512, ny = 256, length = 8): Drawn {
  const dx = length / nx;
  const f = Math.fround;
  return {
    scale: f(view.mpp / view.dpr / dx),
    ox: f((view.cx - (view.w / 2) * view.mpp) / dx - 0.5),
    oy: f((view.cy + (view.h / 2) * view.mpp) / dx - 0.5),
    nx,
    ny,
    w: Math.round(view.w * view.dpr),
    h: Math.round(view.h * view.dpr),
  };
}

const line = (id: string, a: string, b: string) => ({ id, kind: 'line', p: [a, b] }) as SketchEntity;

/** A scene with every mark: streak, timeline and switched-off rakes, two probes, a body near the top wall, one switched off, an open sketch and one to edit. */
function scene(): Scene {
  const base = defaultScene();
  const body = (id: string, over: Partial<Body>): Body => ({ id, name: id, shape: { kind: 'rect', width: 0.6, height: 0.2 }, x: 2, y: 2, angle: 0, spin: 0, enabled: true, locked: false, ...over });
  return {
    ...base,
    bodies: [
      body('b1', { x: 1.5, y: 3.6, angle: 4 }),
      body('b2', { x: 3, y: 1, enabled: false }),
      body('b3', {
        x: 4.5,
        y: 2.5,
        shape: { kind: 'sketch', name: 'Open', sketch: { points: { a: [0, 0], b: [200, 0], c: [200, 100] }, entities: [line('e1', 'a', 'b'), line('e2', 'b', 'c')], constraints: [] } },
      }),
      body('b4', {
        x: 5,
        y: 1,
        shape: { kind: 'sketch', name: 'Edited', sketch: { points: { a: [300, 0], b: [500, 0], c: [400, 150] }, entities: [line('e1', 'a', 'b'), line('e2', 'b', 'c'), line('e3', 'c', 'a')], constraints: [] } },
      }),
    ],
    rakes: [
      { id: 'r1', kind: 'streaks', x0: 1, y0: 1, x1: 1, y1: 3, emitters: 4, color: 0, enabled: true },
      { id: 'r2', kind: 'timelines', x0: 6, y0: 0.5, x1: 6.5, y1: 3.5, emitters: 8, color: 1, enabled: true },
      { id: 'r3', kind: 'dye', x0: 7, y0: 1, x1: 7, y1: 2, emitters: 1, color: 4, enabled: false },
    ],
    probes: [
      { id: 'p1', x: 3.5, y: 3 },
      { id: 'p2', x: 7.9, y: 0.1 },
    ],
  };
}

function fixture() {
  const store = new Store(scene());
  const engine = { worldView: { ...VIEW }, livePose: () => null } as unknown as Engine;
  const editor = new SketchEditor(store, engine, () => {
    throw new Error('the overlay never solves a sketch');
  });
  return { store, engine, editor };
}

type Paint = (g: CanvasRenderingContext2D, st: OverlayState) => void;

/** The overlay's frames: each kind of selection, a body dragged and one turned, a sketch being edited. */
function frames(paint: Paint): string[] {
  const { store, engine, editor } = fixture();
  const log: string[] = [];
  const g = recordingContext(log, CANVAS);
  const frame = (label: string, selected: string | null, drag: Drag | null = null) => {
    log.push(`# ${label}`);
    store.select(selected);
    paint(g, overlayState(engine, store, drag, editor));
  };
  frame('nothing selected', null);
  frame('the streak rake selected', 'r1');
  frame('a probe selected', 'p2');
  frame('the open sketch selected', 'b3');
  frame('a body dragged', 'b1', { kind: 'move', id: 'b1', startX: 1.5, startY: 3.6, bodyX: 1.8, bodyY: 3.4, angle: 4, moved: true });
  frame('a body turned', 'b1', { kind: 'turn', id: 'b1', startAngle: 4, pointerStart: 0, angle: 20, x: 1.5, y: 3.6 });
  // Editing b4, the pointer by its origin: the snap ring.
  editor.bodyId = 'b4';
  editor.pointerMove(5.01, 1);
  frame('a sketch edited', 'b4');
  return log;
}

/** Paints each frame on screen in a theme's colours (the tokens resolved from the stylesheets), over `drawn`. */
const onScreen = (theme: 'light' | 'dark', drawn: Drawn | null = drawnFor(VIEW)): Paint => {
  const colours = overlayColours(tokenReader(theme));
  return (g, st) => paintOverlay(g, st, colours, drawn);
};

/** One frame of a log (from its '# label' line to the next). */
function frameOf(log: string[], label: string): string[] {
  const at = log.indexOf(`# ${label}`);
  const next = log.findIndex((l, i) => i > at && l.startsWith('# '));
  return log.slice(at + 1, next < 0 ? undefined : next);
}

/** Where `run` (consecutive lines) starts in `lines`, or -1. */
function indexOfRun(lines: string[], run: string[]): number {
  for (let i = 0; i + run.length <= lines.length; i++) if (run.every((l, k) => lines[i + k] === l)) return i;
  return -1;
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  forgetColours();
});

describe('the overlay', () => {
  it('in the light theme draws exactly what it drew before it left the view, nothing on the margins', async () => {
    const log = frames(onScreen('light'));
    expect(log.length).toBeGreaterThan(500);
    expect(log.some((l) => /fill\("evenodd"\)|^rect\(|setTransform\(1, 0, 0, 1, 0, 0\)/.test(l))).toBe(false);
    await expect(log.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/overlay-light.txt');
  });

  it("pictures and recordings draw the frame's marks in the light colours while the page is dark", () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const styles = themedStyles();
    try {
      const log = frames((g, st) => lightOverlay(() => st)(g));
      expect(log).toEqual(frames(onScreen('light')));
      // Read on the hidden light element only, never on the dark page.
      expect(styles.reads.length).toBeGreaterThan(0);
      for (const el of styles.reads) {
        expect(el).not.toBe(document.documentElement);
        expect(el.getAttribute('data-theme')).toBe('light');
      }
    } finally {
      styles.restore();
    }
  });

  it("in the dark theme paints the margins and the ring at the tunnel's wall first, by the GPU's frame", () => {
    const drawn = drawnFor(VIEW);
    const r = domainRectPx(drawn)!;
    expect(r.walls).toEqual({ left: true, right: true, top: true, bottom: true });
    const log = frames(onScreen('dark', drawn));
    // The ring is one device px at 1.25 (round(dpr)), on the tunnel's outermost pixels.
    const head = [
      'setTransform(1.25, 0, 0, 1.25, 0, 0)',
      'clearRect(0, 0, 800, 450)',
      'setTransform(1, 0, 0, 1, 0, 0)',
      'fillStyle = "#1b1f27"',
      'beginPath()',
      `rect(0, 0, ${CANVAS.width}, ${CANVAS.height})`,
      `rect(${r.x0}, ${r.y0}, ${r.x1 - r.x0}, ${r.y1 - r.y0})`,
      'fill("evenodd")',
      'beginPath()',
      `rect(${r.x0}, ${r.y0}, 1, ${r.y1 - r.y0})`,
      `rect(${r.x1 - 1}, ${r.y0}, 1, ${r.y1 - r.y0})`,
      `rect(${r.x0}, ${r.y0}, ${r.x1 - r.x0}, 1)`,
      `rect(${r.x0}, ${r.y1 - 1}, ${r.x1 - r.x0}, 1)`,
      'fillStyle = "#6b7382"',
      'fill()',
      'setTransform(1.25, 0, 0, 1.25, 0, 0)',
    ];
    for (const label of ['nothing selected', 'a body turned', 'a sketch edited']) expect(frameOf(log, label).slice(0, head.length), label).toEqual(head);
    // The tunnel is where the shader has it: 8 m x 4 m at 0.012 m per CSS px, centred.
    expect((r.x1 - r.x0) / VIEW.dpr).toBeCloseTo(8 / 0.012, -1);
    expect((r.y1 - r.y0) / VIEW.dpr).toBeCloseTo(4 / 0.012, -1);
  });

  it('in the dark theme draws the marks in dark colours, with a halo under the probe cross, the sketch origin and its snap ring', () => {
    const log = frames(onScreen('dark'));
    // Nothing half-themed: none of the light marks' own colours is left.
    for (const light of ['#ffffff', '#101828', '#475467', '#667085']) expect(log.some((l) => l.includes(light)), light).toBe(false);
    for (const dark of ['#e6e9ef', '#2f6fde', '#7aa7ff', '#6b7382', '#9aa4b2']) expect(log.some((l) => l.includes(dark)), dark).toBe(true);
    // The probe's cross: a halo of the margin's colour, 3 px wider than its ink, before its ring.
    const probe = frameOf(log, 'nothing selected');
    const cross = indexOfRun(probe, ['strokeStyle = "#1b1f27"', 'lineWidth = 4.5', 'stroke()']);
    expect(cross).toBeGreaterThan(0);
    expect(probe[cross + 3]).toBe('beginPath()');
    expect(probe[cross + 4]).toMatch(/^arc\(/);
    const selected = frameOf(log, 'a probe selected');
    expect(indexOfRun(selected, ['strokeStyle = "#1b1f27"', 'lineWidth = 5.5', 'stroke()'])).toBeGreaterThan(0);
    expect(selected).toContain('fillStyle = "#7aa7ff"');
    // The sketch: a halo under its origin cross, then under its snap ring.
    const sketch = frameOf(log, 'a sketch edited');
    const origin = indexOfRun(sketch, ['strokeStyle = "#1b1f27"', 'lineWidth = 4', 'beginPath()']);
    expect(origin).toBeGreaterThan(0);
    expect(sketch.slice(origin + 7, origin + 11)).toEqual(['stroke()', 'strokeStyle = "#9aa4b2"', 'lineWidth = 1', 'beginPath()']);
    expect(sketch.slice(-6)).toEqual(['strokeStyle = "#1b1f27"', 'lineWidth = 4.5', 'stroke()', 'strokeStyle = "#2f6fde"', 'lineWidth = 1.5', 'stroke()']);
  });

  it('draws the rakes in the same colours in both themes', () => {
    expect(overlayColours(tokenReader('dark')).rakes).toEqual(overlayColours(tokenReader('light')).rakes);
    const rakes = (log: string[]) => frameOf(log, 'the streak rake selected').filter((l) => /^(strokeStyle|fillStyle) = "#(1570ef|6941c6|099250|b54708|0086c9|dd2590)"$/.test(l));
    const light = rakes(frames(onScreen('light')));
    expect(light.length).toBeGreaterThan(6);
    expect(rakes(frames(onScreen('dark')))).toEqual(light);
  });

  it("leaves the margins to the stage's background with no frame on the GPU canvas yet, or one of another size", () => {
    for (const drawn of [null, { ...drawnFor(VIEW), w: CANVAS.width + 1 }]) {
      const log = frames(onScreen('dark', drawn));
      expect(log.some((l) => /fill\("evenodd"\)|fillStyle = "#6b7382"|setTransform\(1, 0, 0, 1, 0, 0\)/.test(l))).toBe(false);
    }
  });

  it('paints the whole canvas as margin when the tunnel is off it, and no ring', () => {
    const away = drawnFor({ ...VIEW, cx: -20 });
    expect(domainRectPx(away)).toBeNull();
    const first = frameOf(frames(onScreen('dark', away)), 'nothing selected');
    expect(first.slice(2, 6)).toEqual(['setTransform(1, 0, 0, 1, 0, 0)', 'fillStyle = "#1b1f27"', `fillRect(0, 0, ${CANVAS.width}, ${CANVAS.height})`, 'setTransform(1.25, 0, 0, 1.25, 0, 0)']);
  });
});
