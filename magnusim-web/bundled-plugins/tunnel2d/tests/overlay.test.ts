// The marks over the view (src/ui/overlay.ts), drawn on a context that writes down every call: in
// the light theme they are drawn as they were before the overlay left Viewport.tsx (the log saved
// in __snapshots__/overlay-light.txt right after that move).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import { overlayColours } from '../src/app/colours';
import { defaultScene, type Body, type Scene } from '../src/scene/scene';
import type { Engine } from '../src/sim/engine';
import { SketchEditor } from '../src/sketch/editor';
import type { SketchEntity } from '../src/sketch/cad';
import { overlayState, paintOverlay, type Drag, type OverlayColours } from '../src/ui/overlay';
import { recordingContext } from './canvasLog';
import { tokenReader } from './themeTokens';

/** The view: zoomed out, so the 8 m x 4 m tunnel has margins all round. */
const VIEW = { cx: 4, cy: 2, mpp: 0.012, w: 800, h: 450, dpr: 1.25 };

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

/** The overlay's frames: each kind of selection, a body dragged and one turned, a sketch being edited. */
function frames(colours: OverlayColours): string[] {
  const { store, engine, editor } = fixture();
  const log: string[] = [];
  const g = recordingContext(log, { width: 1000, height: 563 });
  const frame = (label: string, selected: string | null, drag: Drag | null = null) => {
    log.push(`# ${label}`);
    store.select(selected);
    paintOverlay(g, overlayState(engine, store, drag, editor), colours);
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

describe('the overlay', () => {
  it('in the light theme draws exactly what it drew before it left the view', async () => {
    const log = frames(overlayColours(tokenReader('light')));
    expect(log.length).toBeGreaterThan(500);
    await expect(log.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/overlay-light.txt');
  });
});
