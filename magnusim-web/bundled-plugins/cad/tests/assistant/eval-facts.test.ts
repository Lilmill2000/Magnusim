// The eval's facts of a Part on the REAL kernel (src/assistant/eval-facts.ts; CAD tools spec §2.1,
// §12.5): the plate's parameters, features, sketches (analysed again by the solver: an
// under-defined sketch reads its real dof), its exact body, its holes as holes centred where the
// sketch put them, nothing changed in the Part by reading; what cannot be read goes into `errors`
// (a section or a probe of a body that is not there, a pair with one missing), never thrown; the
// walk's parameter change (refused for a name that is not there and a value the Part refuses);
// no picture without a 3D view.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { loadReference, referenceCalls } from '../../eval/lib.mjs';
import { evalFacts, evalPicture, evalSetParam } from '../../src/assistant/eval-facts';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { C, E, SK } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

/** The plate-holes reference built through the tool handler. */
async function plate(): Promise<AssistantHarness> {
  const x = await assistantHarness({ sketchMode: true });
  h = x;
  for (const c of referenceCalls(loadReference('plate-holes'), 0)) {
    const r = await x.call(c.tool, c.input);
    expect(r.ok, `${c.tool}: ${JSON.stringify(r.ok ? '' : r.error)}`).toBe(true);
  }
  return x;
}

describe('evalFacts', () => {
  it(
    "reads the plate: its parameters, features, sketches, body and holes, and changes nothing",
    async () => {
      const x = await plate();
      const before = x.doc.state.get().doc;
      const undo = x.doc.state.get().history.undoLabel;
      const f = await evalFacts(x.services);
      expect(x.doc.state.get().doc).toBe(before);
      expect(x.doc.state.get().history.undoLabel).toBe(undo);
      expect(f).toMatchObject({ version: 1, units: { length: 'mm', angle: 'deg' }, status: 'ready', rebuild: { status: 'done' }, errors: [], pairs: [], union: null, sections: [], probes: [], health: { health: 'ok', words: [] } });
      expect(f.params.map((p) => [p.name, p.value])).toEqual([
        ['L', 100],
        ['W', 60],
        ['t', 8],
        ['hd', 6.5],
        ['e', 10],
      ]);
      expect(f.features.map((x2) => [x2.name, x2.type, x2.state, x2.by_assistant])).toEqual([
        ['Plate sketch', 'sketch', 'ok', true],
        ['Plate', 'extrude', 'ok', true],
        ['Hole 1 sketch', 'sketch', 'ok', true],
        ['Hole 1', 'extrude', 'ok', true],
      ]);
      expect(f.features[1].values).toEqual([{ field: 'distance', expr: 't', value: 8 }]);
      expect(f.sketches.map((s) => [s.name, s.dof, s.source])).toEqual([
        ['Plate sketch', 0, 'solver'],
        ['Hole 1 sketch', 0, 'solver'],
      ]);
      expect(f.sketches[1].dims.find((d) => d.id === 'd')).toEqual({ id: 'd', kind: 'diameter', expr: 'hd', value: 6.5 });
      expect(f.bodies).toHaveLength(1);
      expect(f.bodies[0]).toMatchObject({ name: 'Body 1', valid: true, solids: 1, shells: 1, voids: 0, faces: 10, bbox: [-50, -30, 0, 50, 30, 8] });
      expect(Math.abs(f.bodies[0].volume! - (48000 - 4 * Math.PI * 3.25 ** 2 * 8))).toBeLessThan(1e-6);
      const holes = f.faces.filter((x2) => x2.kind === 'hole');
      expect(holes).toHaveLength(4);
      for (const hole of holes) {
        expect(hole.radius).toBeCloseTo(3.25, 9);
        expect(Math.abs(hole.axis!.dir[2])).toBeCloseTo(1, 9);
        expect([Math.abs(hole.axis!.point[0]), Math.abs(hole.axis!.point[1])]).toEqual([40, 20]);
        // Off-centre holes: the top and bottom faces' centres are 44.7 mm from each axis.
        expect(hole.centred_mm).toHaveLength(2);
        hole.centred_mm!.forEach((d) => expect(d).toBeCloseTo(Math.hypot(40, 20), 6));
      }
      expect(f.faces.filter((x2) => x2.type === 'plane')).toHaveLength(6);
    },
    REAL_KERNEL_MS,
  );

  it(
    'an under-defined sketch reads its dof from the solver',
    async () => {
      const x = await assistantHarness({ sketchMode: true });
      h = x;
      const r = await x.call('sketch', SK({ name: 'Loose', entities: [E('c', 'circle', [5, 5, 3])], constraints: [C('d', 'diameter', ['c'], '6 mm')] }));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const f = await evalFacts(x.services);
      expect(f.sketches).toEqual([{ name: 'Loose', state: 'under', dof: 2, source: 'solver', conflicting: [], redundant: [], dims: [{ id: 'd', kind: 'diameter', expr: '6 mm', value: 6 }] }]);
      expect(f.health).toEqual({ health: 'warn', words: ['1 sketch under-defined'] });
    },
    REAL_KERNEL_MS,
  );

  it(
    'what cannot be read goes into errors, never thrown',
    async () => {
      const x = await plate();
      const f = await evalFacts(x.services, {
        pairs: [['Body 1', 'Nope']],
        union: true,
        sections: [{ body: 'Nope', origin: [0, 0, 4], normal: [0, 0, 1] }],
        probes: [{ inner: 'Nope', bodies: ['Body 1'], origin: [0, 0, 4], normal: [0, 0, 1] }],
      });
      expect(f.errors).toEqual(['section: no body named Nope', 'probe: no body named Nope']);
      expect(f.pairs).toEqual([{ a: 'Body 1', b: 'Nope', overlap: null, union_solids: null, union_voids: null, distance: null, note: 'no body named Nope' }]);
      // The union of one body is that body.
      expect(f.union).toMatchObject({ solids: 1, shells: 1, voids: 0, bbox: [-50, -30, 0, 50, 30, 8] });
      expect(Math.abs(f.union!.volume - f.bodies[0].volume!)).toBeLessThan(1e-6);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a section gives each piece, its holes and centre; a probe column the intervals each body fills',
    async () => {
      const x = await plate();
      const f = await evalFacts(x.services, {
        sections: [{ body: '*', origin: [0, 0, 4], normal: [0, 0, 1] }],
        probes: [{ inner: 'Body 1', bodies: [], origin: [0, 0, 4], normal: [0, 0, 1], columns: 3 }],
      });
      expect(f.errors).toEqual([]);
      const s = f.sections[0];
      expect(s).toMatchObject({ body: '*', loops: 5, holes: 4, open: 0 });
      expect(s.area).toBeCloseTo(6000 - 4 * Math.PI * 3.25 ** 2, 1);
      const material = s.pieces.filter((p) => p.depth === 0);
      expect(material).toHaveLength(1);
      expect(material[0].bbox).toEqual([-50, -30, 50, 30]);
      expect(material[0].centroid![0]).toBeCloseTo(0, 3);
      expect(material[0].centroid![2]).toBe(4);
      expect(s.pieces.filter((p) => p.depth === 1)).toHaveLength(4);
      // Each column through the plate at its section's points: the plate fills it from z 0 to 8 (4 below and above the cut).
      expect(f.probes).toHaveLength(3);
      for (const p of f.probes) {
        expect(p.dir).toEqual([0, 0, 1]);
        expect(p.intervals['Body 1']).toHaveLength(1);
        expect(p.intervals['Body 1'][0][0]).toBeCloseTo(-4, 6);
        expect(p.intervals['Body 1'][0][1]).toBeCloseTo(4, 6);
      }
    },
    REAL_KERNEL_MS,
  );
});

describe('evalSetParam and evalPicture', () => {
  it(
    'sets a parameter as the person does and waits for the rebuild; refuses a name not there and a value the Part refuses',
    async () => {
      const x = await plate();
      expect(await evalSetParam(x.services, 'thk', '9 mm')).toEqual({ ok: false, reason: 'no parameter named thk' });
      const bad = await evalSetParam(x.services, 't', 'w * 2');
      expect(bad.ok).toBe(false);
      expect(bad.reason).toMatch(/w/);
      expect(await evalSetParam(x.services, 't', '12 mm')).toEqual({ ok: true });
      expect(x.doc.state.get().history.undoLabel).toBe('Set t');
      const v = x.doc.state.get().rebuild.bodies[0].volume!;
      expect(Math.abs(v - 1.5 * (48000 - 4 * Math.PI * 3.25 ** 2 * 8))).toBeLessThan(1e-6);
      // No 3D view in this test Part: no picture.
      expect(await evalPicture(x.services)).toBeNull();
    },
    REAL_KERNEL_MS,
  );
});
