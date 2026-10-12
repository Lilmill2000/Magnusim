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
  it('keeps at most the bodies a tunnel holds', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ shape: { kind: 'circle', diameter: 0.1 }, x: i * 0.2, y: 1 }));
    expect(parseScene({ bodies: many }).bodies).toHaveLength(LIMITS.maxBodies);
  });
});
