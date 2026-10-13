// The exact-Re presets: each is the Reynolds number it says, resolved on its grid, and
// recognised as itself until its setup changes.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PRESETS, matchesPreset, presetById } from '../src/scene/presets';
import { FLUIDS, parseScene } from '../src/scene/scene';
import { referenceLength } from '../src/geometry/shapes';
import { latticeMap } from '../src/sim/units';

describe('the presets', () => {
  it('are the Reynolds numbers they say, resolved (no floor, no model) on their grid', () => {
    for (const p of PRESETS) {
      const s = p.build();
      const re = Number(/Re (\d+)/.exec(p.title)![1]);
      const D = referenceLength(s.bodies[0].shape);
      expect((s.flow.speed * D) / FLUIDS[s.flow.fluid].nu, p.id).toBeCloseTo(re, 6);
      expect(s.preset).toBe(p.id);
      // The high grid (engine.ts RESOLUTION_CELLS, gridFor): 1536 x 768 cells at the tunnel's aspect.
      expect(s.tunnel.resolution).toBe('high');
      const nx = Math.round(Math.sqrt((1536 * 768 * s.tunnel.length) / s.tunnel.height));
      const map = latticeMap(s.tunnel.length, nx, s.flow.speed, FLUIDS[s.flow.fluid].nu);
      expect(map.capped, p.id).toBe(false);
      expect(map.smagorinsky, p.id).toBe(false);
      expect(D / map.dx, p.id).toBeGreaterThan(25);
    }
  });
  it('are recognised until the flow, the tunnel or the body changes, and survive a save', () => {
    const p = presetById('cylinder-re100')!;
    const s = p.build();
    expect(matchesPreset(s, p)).toBe(true);
    expect(matchesPreset(parseScene(JSON.parse(JSON.stringify(s))), p)).toBe(true);
    expect(matchesPreset({ ...s, view: { ...s.view, field: 'speed' }, tunnel: { ...s.tunnel, resolution: 'ultra', refine: 1 } }, p)).toBe(true);
    expect(matchesPreset({ ...s, flow: { ...s.flow, speed: s.flow.speed * 2 } }, p)).toBe(false);
    expect(matchesPreset({ ...s, bodies: [{ ...s.bodies[0], angle: 5 }] }, p)).toBe(false);
    expect(matchesPreset({ ...s, flow: { ...s.flow, model: 'sa' } }, p)).toBe(false);
  });
});
