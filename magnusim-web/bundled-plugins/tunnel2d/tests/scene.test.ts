// The scene file: what is read back, and what is refused.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { defaultScene, LIMITS, parseScene, SceneError } from '../src/scene/scene';

describe('the scene file', () => {
  it('round-trips the default scene', () => {
    const s = defaultScene();
    expect(parseScene(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
  it('fills in what an older or partial file lacks', () => {
    const s = parseScene({ bodies: [{ shape: { kind: 'circle', diameter: 0.3 }, x: 1, y: 1 }] });
    expect(s.tunnel.walls).toBe('slip');
    expect(s.bodies[0]).toMatchObject({ angle: 0, spin: 0, enabled: true, locked: false });
    expect(s.bodies[0].id).toBeTruthy();
  });
  it('refuses bad values and a newer version, saying what', () => {
    expect(() => parseScene({ version: 99 })).toThrow(/newer version/);
    expect(() => parseScene({ flow: { speed: -1 } })).toThrow(SceneError);
    expect(() => parseScene({ bodies: [{ shape: { kind: 'naca', code: '2012', chord: 1 }, x: 0, y: 0 }] })).toThrow(/camber/);
    expect(() => parseScene({ bodies: [{ shape: { kind: 'blob' }, x: 0, y: 0 }] })).toThrow(/Unknown body shape/);
  });
  it("reads a version-1 file (no rakes, no markers) with the markers' defaults", () => {
    const s = parseScene({ version: 1, bodies: [], view: { field: 'speed' } });
    expect(s.version).toBe(2);
    expect(s.rakes).toEqual([]);
    expect(s.view).toMatchObject({ field: 'speed', tracers: true, density: 'normal', trail: 'short', arrows: false, streamlines: false });
  });
  it('reads rakes, with defaults and limits', () => {
    const s = parseScene({
      rakes: [
        { kind: 'dye', x0: 1, y0: 1, x1: 1, y1: 2 },
        { kind: 'streaks', x0: 1, y0: 1, x1: 2, y1: 1, emitters: 30, color: 3, enabled: false },
        { kind: 'smoke', x0: 0, y0: 0, x1: 0, y1: 1 },
      ],
    });
    expect(s.rakes[0]).toMatchObject({ kind: 'dye', emitters: 12, color: 0, enabled: true });
    expect(s.rakes[0].id).toMatch(/^r/);
    expect(s.rakes[1]).toMatchObject({ emitters: 30, color: 3, enabled: false });
    // An unknown kind reads as streaks.
    expect(s.rakes[2].kind).toBe('streaks');
    expect(() => parseScene({ rakes: [{ kind: 'streaks', x0: 'a', y0: 0, x1: 0, y1: 1 }] })).toThrow(SceneError);
    expect(() => parseScene({ rakes: [{ kind: 'streaks', x0: 0, y0: 0, x1: 0, y1: 1, emitters: 500 }] })).toThrow(/emitters/);
    const many = Array.from({ length: 12 }, () => ({ kind: 'streaks', x0: 0, y0: 0, x1: 0, y1: 1 }));
    expect(parseScene({ rakes: many }).rakes).toHaveLength(LIMITS.maxRakes);
  });
  it('keeps at most the bodies a tunnel holds', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ shape: { kind: 'circle', diameter: 0.1 }, x: i * 0.2, y: 1 }));
    expect(parseScene({ bodies: many }).bodies).toHaveLength(LIMITS.maxBodies);
  });
});
