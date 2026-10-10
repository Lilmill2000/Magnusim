// ux010 (DRAW): the sketch cursors' SVGs, hotspots, keyword fallbacks and tones (src/sketch/cursors.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cursorFor, cursorParts, cursorSvg, cursorTone, sketchCursor } from '../../src/sketch/cursors';
import { SKETCH_ICONS } from '../../src/sketch/icons';
import { VIEWPORT_BG } from '../../src/viewport/colors';

afterEach(() => vi.unstubAllGlobals());

const parses = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror') === null;

describe('sketch cursors', () => {
  it('the crosshair has its hotspot at its centre and the tool icon at its lower right; the hands at the palm', () => {
    const d = cursorParts('draw', SKETCH_ICONS.line);
    expect([d.x, d.y, d.fallback]).toEqual([10, 10, 'crosshair']);
    expect(d.body).toContain('M10.5 1.5V7.5');
    expect(d.body).toContain(SKETCH_ICONS.line);
    expect(cursorParts('grab')).toMatchObject({ x: 15, y: 15, fallback: 'grab' });
    expect(cursorParts('grabbing')).toMatchObject({ x: 15, y: 15, fallback: 'grabbing' });
    // Open fingers reach higher than closed ones.
    expect(cursorParts('grab').body).toContain('M14.4 14V4.6');
    expect(cursorParts('grabbing').body).toContain('M14.4 14V10.4');
    for (const k of ['draw', 'grab', 'grabbing'] as const) for (const tone of ['light', 'dark'] as const) expect(parses(cursorSvg(k, SKETCH_ICONS.circle, 64, tone))).toBe(true);
    expect(cursorSvg('grab', null, 64)).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="64" height="64" viewBox="0 0 32 32">/);
  });

  it('tones: dark strokes with a white halo on a light view; plain white (a faint dark edge) on a dark one', () => {
    expect(cursorTone('light', VIEWPORT_BG)).toBe('light');
    expect(cursorTone(undefined, null)).toBe('light');
    expect(cursorTone('dark', VIEWPORT_BG)).toBe('dark');
    expect(cursorTone('light', 0x1d2433)).toBe('dark');
    expect(cursorTone(null, 0x808080)).toBe('light');
    expect(cursorTone(null, 0x303030)).toBe('dark');
    const light = cursorParts('draw', SKETCH_ICONS.line, 'light').body;
    const dark = cursorParts('draw', SKETCH_ICONS.line, 'dark').body;
    expect(light).toContain('stroke="#101828"');
    expect(light).toContain('stroke="#ffffff"');
    expect(dark).not.toContain('#101828');
    expect(dark).toContain('stroke="#ffffff"');
    expect(cursorParts('grab', null, 'dark').body).not.toContain('#101828');
  });

  it('image-set (1x, 2x) where the browser takes it, else one image, always ending with the keyword; move and grab are the open hand', () => {
    vi.stubGlobal('CSS', { supports: (_p: string, v: string) => v.startsWith('image-set(') });
    expect(sketchCursor('grabbing')).toMatch(/^image-set\(url\("data:image\/svg\+xml,[^"]+"\) 1x, url\("data:image\/svg\+xml,[^"]+"\) 2x\) 15 15, grabbing$/);
    vi.stubGlobal('CSS', { supports: (_p: string, v: string) => v.startsWith('url(') });
    expect(sketchCursor('draw', SKETCH_ICONS.trim)).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) 10 10, crosshair$/);
    expect(cursorFor('default')).toBe('default');
    expect(cursorFor('pointer')).toBe('pointer');
    expect(cursorFor('move')).toBe(cursorFor('grab'));
    expect(cursorFor('move')).toContain(', grab');
    expect(cursorFor('grab', null, 'dark')).not.toBe(cursorFor('grab', null, 'light'));
  });
});
