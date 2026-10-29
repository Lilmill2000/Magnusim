// ux010 (DRAW): the sketch cursors' SVGs, hotspots, keyword fallbacks and tones (src/sketch/cursors.ts);
// the small arrow with the kind's icon over sketch geometry and the kind each item shows (Daniel 2026-10-28).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARROW_PATH, ARROW_TIP, cursorFor, cursorParts, cursorSvg, cursorTone, entityPickKind, PICK_ICON_BOX, PICK_KINDS, pickKeyword, pickKindOf, sketchCursor } from '../../src/sketch/cursors';
import type { SketchFeature } from '../../src/types/doc';
import { SKETCH_ICONS } from '../../src/sketch/icons';
import { VIEWPORT_BG } from '../../src/viewport/colors';
import { DARK, LIGHT } from '../../src/viewport/palette';

afterEach(() => vi.unstubAllGlobals());

const parses = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror') === null;

describe('sketch cursors', () => {
  it('the crosshair has its hotspot at its centre and the tool icon at its lower right; the hands (the 3D banana) at the palm', () => {
    const d = cursorParts('draw', SKETCH_ICONS.line);
    expect([d.x, d.y, d.fallback]).toEqual([10, 10, 'crosshair']);
    expect(d.body).toContain('M10.5 1.5V7.5');
    expect(d.body).toContain(SKETCH_ICONS.line);
    expect(cursorParts('grab')).toMatchObject({ x: 15, y: 15, fallback: 'grab' });
    expect(cursorParts('grabbing')).toMatchObject({ x: 15, y: 15, fallback: 'grabbing' });
    // Open fingers reach higher than closed ones.
    expect(cursorParts('grab').body).toContain('M14.4 14V4.6');
    expect(cursorParts('grabbing').body).toContain('M14.4 14V10.4');
    for (const k of ['draw', 'pick', 'drag', 'grab', 'grabbing'] as const) for (const tone of ['light', 'dark'] as const) expect(parses(cursorSvg(k, k === 'pick' ? 'arc' : SKETCH_ICONS.circle, 64, tone))).toBe(true);
    expect(cursorSvg('grab', null, 64)).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="64" height="64" viewBox="0 0 32 32">/);
  });

  // Daniel (2026-10-28): "if I hover over something in the sketch, say a line, a tiny little line
  // icon appears next to the mouse cursor. If I hover over a point, a tiny point icon".
  it('pick: the small arrow with its hotspot at the tip and a tiny icon of each kind at its lower right, clear of the hotspot; drag: the four-way arrow', () => {
    const doc = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');
    for (const kind of PICK_KINDS) {
      for (const tone of ['light', 'dark'] as const) {
        const p = cursorParts('pick', kind, tone);
        expect([p.x, p.y, p.fallback]).toEqual([ARROW_TIP.x, ARROW_TIP.y, 'default']);
        expect(p.body).toContain(ARROW_PATH);
        const svg = doc(cursorSvg('pick', kind, 32, tone));
        expect(svg.querySelector('parsererror')).toBeNull();
        // One icon, of this kind, and only this kind.
        expect([...svg.querySelectorAll('[data-pick]')].map((g) => g.getAttribute('data-pick'))).toEqual([kind]);
        expect(svg.querySelector('[data-drag]')).toBeNull();
      }
    }
    // The icon is about 11 px, its box well to the lower right of the hotspot, past the arrow's tip.
    expect(PICK_ICON_BOX.size).toBeGreaterThanOrEqual(10);
    expect(PICK_ICON_BOX.size).toBeLessThanOrEqual(12);
    expect(PICK_ICON_BOX.x - ARROW_TIP.x).toBeGreaterThanOrEqual(12);
    expect(PICK_ICON_BOX.y - ARROW_TIP.y).toBeGreaterThanOrEqual(12);
    expect(PICK_ICON_BOX.x + PICK_ICON_BOX.size).toBeLessThanOrEqual(32);
    // Every coordinate the icons draw lies in their box (the halo aside).
    for (const kind of PICK_KINDS) {
      const g = /<g data-pick="[a-z]+">(.*)<\/g>/.exec(cursorParts('pick', kind).body)![1];
      const centres = [...g.matchAll(/(?:cx|cy)="([\d.]+)"/g)].map((m) => +m[1]);
      for (const n of centres) {
        expect(n).toBeGreaterThanOrEqual(PICK_ICON_BOX.x);
        expect(n).toBeLessThanOrEqual(PICK_ICON_BOX.x + PICK_ICON_BOX.size);
      }
      const start = /d="M([\d.]+) ([\d.]+)/.exec(g);
      if (start) {
        expect(+start[1]).toBeGreaterThanOrEqual(PICK_ICON_BOX.x - 1);
        expect(+start[2]).toBeGreaterThanOrEqual(PICK_ICON_BOX.y - 1);
      }
    }
    // The arrow is small: about 10 x 15 px (the hand was 17 x 22).
    const coords = [...ARROW_PATH.matchAll(/([\d.]+)/g)].map((m) => +m[1]);
    expect(Math.max(...coords)).toBeLessThanOrEqual(18);
    // Each kind draws differently; the pick arrow with no kind is the arrow alone.
    expect(new Set(PICK_KINDS.map((k) => cursorParts('pick', k).body)).size).toBe(PICK_KINDS.length);
    expect(cursorParts('pick', 'nonsense').body).not.toContain('data-pick');
    const drag = cursorParts('drag');
    expect([drag.x, drag.y, drag.fallback]).toEqual([ARROW_TIP.x, ARROW_TIP.y, 'move']);
    expect(drag.body).toContain('data-drag="1"');
    expect(drag.body).not.toContain('M14.4 14V4.6');
  });

  it('the kind each sketch item shows: points, lines, arcs, circles and ellipses, every other kind grouped into them', () => {
    const kinds: [Parameters<typeof entityPickKind>[0], string][] = [
      [{ kind: 'point' }, 'point'],
      [{ kind: 'line' }, 'line'],
      [{ kind: 'circle' }, 'circle'],
      [{ kind: 'arc' }, 'arc'],
      [{ kind: 'ellipse' }, 'ellipse'],
      [{ kind: 'ellipse_arc' }, 'ellipse'],
      [{ kind: 'parabola' }, 'arc'],
      [{ kind: 'conic' }, 'arc'],
      [{ kind: 'spline' }, 'arc'],
      [{ kind: 'spline', closed: true }, 'circle'],
    ];
    for (const [e, k] of kinds) expect(entityPickKind(e), e.kind).toBe(k);
    // A rectangle's, polygon's or slot's sides are lines and its ends arcs (they are line and arc
    // entities); a curve's end or centre is a point hit; a dimension or relation shows no icon.
    const d = {
      entities: [
        { id: 'e1', kind: 'line', p: ['p1', 'p2'] },
        { id: 'a1', kind: 'arc', c: 'c', a: 'a', b: 'b' },
        { id: 's1', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c'], degree: 3, closed: true },
        { id: 'q', kind: 'point', p: 'p9' },
      ],
    } as unknown as Pick<SketchFeature, 'entities'>;
    expect(pickKindOf(d, { what: 'entity', id: 'e1' })).toBe('line');
    expect(pickKindOf(d, { what: 'entity', id: 'a1' })).toBe('arc');
    expect(pickKindOf(d, { what: 'entity', id: 's1' })).toBe('circle');
    expect(pickKindOf(d, { what: 'entity', id: 'q' })).toBe('point');
    expect(pickKindOf(d, { what: 'point', id: 'p1' })).toBe('point');
    expect(pickKindOf(d, { what: 'point', id: 'origin' })).toBe('point');
    expect(pickKindOf(d, { what: 'constraint', id: 'd1' })).toBeNull();
    expect(pickKindOf(d, { what: 'entity', id: 'gone' })).toBeNull();
    expect(pickKindOf(d, null)).toBeNull();
    expect(pickKeyword('ellipse')).toBe('pick:ellipse');
  });

  it('tones: dark strokes with a white halo on a light view; plain white (a faint dark edge) on a dark one', () => {
    expect(cursorTone('light', VIEWPORT_BG)).toBe('light');
    expect(cursorTone(undefined, null)).toBe('light');
    expect(cursorTone('dark', VIEWPORT_BG)).toBe('dark');
    expect(cursorTone('light', 0x1d2433)).toBe('dark');
    expect(cursorTone(null, 0x808080)).toBe('light');
    expect(cursorTone(null, 0x303030)).toBe('dark');
    // Sketch mode and the bananas take the tone from the view's palette's background.
    expect(cursorTone(null, DARK.background)).toBe('dark');
    expect(cursorTone(null, LIGHT.background)).toBe('light');
    const light = cursorParts('draw', SKETCH_ICONS.line, 'light').body;
    const dark = cursorParts('draw', SKETCH_ICONS.line, 'dark').body;
    expect(light).toContain('stroke="#101828"');
    expect(light).toContain('stroke="#ffffff"');
    expect(dark).not.toContain('#101828');
    expect(dark).toContain('stroke="#ffffff"');
    expect(cursorParts('grab', null, 'dark').body).not.toContain('#101828');
    for (const kind of PICK_KINDS) {
      expect(cursorParts('pick', kind, 'light').body).toContain('fill="#101828"');
      expect(cursorParts('pick', kind, 'dark').body).not.toContain('#101828');
      expect(cursorParts('pick', kind, 'dark').body).toContain('fill="#ffffff"');
    }
    expect(cursorParts('drag', null, 'dark').body).not.toContain('#101828');
  });

  it('image-set (1x, 2x) where the browser takes it, else one image, always ending with the keyword; a sketch keyword never gives a hand', () => {
    vi.stubGlobal('CSS', { supports: (_p: string, v: string) => v.startsWith('image-set(') });
    expect(sketchCursor('grabbing')).toMatch(/^image-set\(url\("data:image\/svg\+xml,[^"]+"\) 1x, url\("data:image\/svg\+xml,[^"]+"\) 2x\) 15 15, grabbing$/);
    expect(sketchCursor('pick', 'line')).toMatch(/^image-set\(url\("data:image\/svg\+xml,[^"]+"\) 1x, url\("data:image\/svg\+xml,[^"]+"\) 2x\) 2 2, default$/);
    vi.stubGlobal('CSS', { supports: (_p: string, v: string) => v.startsWith('url(') });
    expect(sketchCursor('draw', SKETCH_ICONS.trim)).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) 10 10, crosshair$/);
    expect(cursorFor('default')).toBe('default');
    expect(cursorFor('pointer')).toBe('pointer');
    // 'pick:<kind>': the small arrow with that kind's icon (fallback the plain arrow).
    for (const kind of PICK_KINDS) {
      const v = cursorFor(pickKeyword(kind));
      expect(v).toMatch(/url\("data:image\/svg\+xml,[^"]+"\)( 2x\))? 2 2, default$/);
      expect(decodeURIComponent(v)).toContain(`data-pick="${kind}"`);
    }
    expect(cursorFor('pick:nonsense')).toBe('pick:nonsense');
    // The drag keywords: the small drag cursor, never the hand (fallback move).
    for (const k of ['drag', 'move', 'grab', 'grabbing']) {
      expect(cursorFor(k)).toBe(cursorFor('drag'));
      expect(cursorFor(k)).toMatch(/ 2 2, move$/);
      expect(decodeURIComponent(cursorFor(k))).not.toContain('M14.4 14');
    }
    expect(cursorFor('drag', null, 'dark')).not.toBe(cursorFor('drag', null, 'light'));
    expect(cursorFor('pick:point', null, 'dark')).not.toBe(cursorFor('pick:point', null, 'light'));
  });
});
