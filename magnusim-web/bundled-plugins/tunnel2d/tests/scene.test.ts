// The scene file: what is read back, and what is refused.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { defaultScene, flowModelFor, LIMITS, parseScene, SCENE_VERSION, SceneError } from '../src/scene/scene';

describe('the scene file', () => {
  it('round-trips the default scene', () => {
    const s = defaultScene();
    expect(parseScene(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
  it('fills in what an older or partial file lacks', () => {
    const s = parseScene({ bodies: [{ shape: { kind: 'circle', diameter: 0.3 }, x: 1, y: 1 }] });
    expect(s.tunnel.walls).toBe('farfield');
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
    expect(s.version).toBe(SCENE_VERSION);
    expect(s.rakes).toEqual([]);
    expect(s.view).toMatchObject({ field: 'speed', tracers: false, density: 'normal', trail: 'short', arrows: false, streamlines: false, particleColor: 'speed' });
  });
  it('reads a version-2 file with the flow model automatic, and keeps a chosen one', () => {
    expect(parseScene({ version: 2, flow: { speed: 3, fluid: 'water' } }).flow).toEqual({ speed: 3, fluid: 'water', model: 'auto' });
    expect(parseScene({ flow: { model: 'sa' } }).flow.model).toBe('sa');
    expect(parseScene({ flow: { model: 'rans' } }).flow.model).toBe('auto');
  });
  it('reads the refinement levels (0, 1, 2), with none for older files and bad values', () => {
    expect(parseScene({ version: 3 }).tunnel.refine).toBe(0);
    expect(parseScene({ tunnel: { refine: 2 } }).tunnel.refine).toBe(2);
    expect(parseScene({ tunnel: { refine: '1' } }).tunnel.refine).toBe(1);
    expect(parseScene({ tunnel: { refine: 5 } }).tunnel.refine).toBe(0);
  });
  it('picks the turbulence model automatically from a real Reynolds number of 100,000', () => {
    const s = defaultScene(); // a 1 m chord at 10 m/s in air: Re about 660,000
    expect(flowModelFor(s)).toBe('sa');
    expect(flowModelFor({ ...s, flow: { ...s.flow, model: 'resolved' } })).toBe('off');
    const slow = { ...s, flow: { ...s.flow, speed: 1 } }; // Re about 66,000
    expect(flowModelFor(slow)).toBe('off');
    expect(flowModelFor({ ...slow, flow: { ...slow.flow, model: 'sa' } })).toBe('sa');
    expect(flowModelFor({ ...s, bodies: [] })).toBe('off');
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
