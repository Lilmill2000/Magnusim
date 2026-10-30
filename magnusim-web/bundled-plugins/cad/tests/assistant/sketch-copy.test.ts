// The sketch tool's copy row (help sketch_tools: copy), on the REAL kernel and solver through
// sketch mode: the person's Copy and Paste as a row (src/sketch/tools/clip.ts):
//   - this sketch's items: new geometry with the middle of its box at at(u, v); the relations and
//     dimensions between them made again on the copies; one to anything else left out, and made
//     and a warning say so; later rows name the copies "<id>.<item>";
//   - from another sketch (value "from <sketch>"), by its names as get_model gives them or "all",
//     moved by "offset du, dv", into a sketch on another plane at the same u, v;
//   - parity: the person's Copy in one sketch and Paste in another store what the row stores;
//   - honest errors: an offset that is not one, offset and at(u, v) together, no such sketch, a
//     feature that is not a sketch, a name the sketch has not, a key that is not one.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipOf, type SketchClip } from '../../src/sketch/tools/clip';
import { applyPaste } from '../../src/sketch/tools/paste';
import { isDimension } from '../../src/sketch/model';
import type { SketchFeature } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { C, E, featureNamed, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const ok = async (x: AssistantHarness, tool: string, input: Row) => {
  const r = await x.call(tool, input);
  if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
  return r.result as { text: string; data: Row };
};
const fail = async (x: AssistantHarness, tool: string, input: Row) => {
  const r = await x.call(tool, input);
  if (r.ok) throw new Error(`${tool} did not fail: ${JSON.stringify(r.result).slice(0, 300)}`);
  return r.error as { code: string; message: string };
};

/** The box round a sketch's points that these entities use: [u0, v0, u1, v1] to 1e-6. */
function boxOf(f: SketchFeature, ids: readonly string[]) {
  const pts = f.entities.filter((e) => ids.includes(e.id)).flatMap((e) => (e.kind === 'line' ? e.p : [])).map((p) => f.points[p]);
  const r = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))].map(r);
}

/** A 30 x 20 rect on its corner at the origin (held there), its bottom dimensioned, and a circle. */
const PLATE = (name: string, extra: Row[] = []) =>
  SK({ name, on: 'Top', entities: [E('r', 'rect', [0, 0, 30, 20]), E('c1', 'circle', [50, 10, 5])], constraints: [C('d1', 'distance', ['r.bottom'], '30 mm'), C('o1', 'coincident', ['r.bl', 'origin']), ...extra] });

describe('the copy row', () => {
  it(
    "this sketch's items: the middle at at(u, v); relations and the dimension made again on the copies; the one to the origin left out and said; later rows name the copies",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const r = await ok(h, 'sketch', PLATE('Plate', [C('k1', 'copy', ['r', 'at(100, 10)']), C('d2', 'distance', ['k1.r.left'], '20 mm')]));
      const made = (r.data.made as Row[])[0];
      expect(made).toMatchObject({
        id: 'k1',
        kind: 'copy',
        entities: ['k1.r.bottom', 'k1.r.right', 'k1.r.top', 'k1.r.left'],
        values: { from: 'this sketch', copied: '4 lines, 4 relations and 1 dimension', kept: '4 relations and 1 dimension', left_out: '1 relation to other geometry', middle_at: 'at(100, 10)' },
      });
      expect((made.dimensions as string[]).length).toBe(1);
      expect(r.data.warnings as string[]).toContain('k1 (copy): 1 relation to other geometry was left out');
      const f = featureNamed(h, 'Plate');
      const lines = f.entities.filter((e) => e.kind === 'line');
      expect(lines).toHaveLength(8);
      const copies = lines.filter((e) => !e.id.startsWith('r__')).map((e) => e.id);
      expect(boxOf(f, copies)).toEqual([85, 0, 115, 20]);
      // The copy's bottom keeps "30 mm"; the row after it dimensioned its left side.
      expect(f.constraints.filter(isDimension).map((c) => c.expr)).toEqual(['30 mm', '30 mm', '20 mm']);
      // What still moves: the original's height (1), the circle (3), and where the copy lies (2: its
      // tie to the origin was left out; its sizes are held).
      expect(r.data.solver).toMatchObject({ state: 'under', dof: 1 + 3 + 2 });
    },
    REAL_KERNEL_MS,
  );

  it(
    'from another sketch by its names, or "all", moved by an offset, into a sketch on another plane at the same u, v',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', PLATE('A'));
      const r = await ok(h, 'sketch', SK({ name: 'B', on: 'Front', entities: [], constraints: [C('k1', 'copy', ['r'], 'from A; offset 10, -5')] }));
      expect((r.data.made as Row[])[0]).toMatchObject({ entities: ['k1.r.bottom', 'k1.r.right', 'k1.r.top', 'k1.r.left'], values: { from: 'A', left_out: '1 relation to other geometry' } });
      const b = featureNamed(h, 'B');
      expect(b.entities.map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line']);
      expect(boxOf(b, b.entities.map((e) => e.id))).toEqual([10, -5, 40, 15]);
      expect(b.constraints.filter(isDimension).map((c) => c.expr)).toEqual(['30 mm']);
      // "all": every entity of A, the circle too, where it was.
      const all = await ok(h, 'sketch', SK({ name: 'C', on: 'Right', entities: [], constraints: [C('k1', 'copy', ['all'], 'from A')] }));
      expect((all.data.made as Row[])[0]).toMatchObject({ entities: ['k1.r.bottom', 'k1.r.right', 'k1.r.top', 'k1.r.left', 'k1.c1'], values: { copied: '4 lines, 1 circle, 4 relations and 1 dimension' } });
      expect(boxOf(featureNamed(h, 'C'), featureNamed(h, 'C').entities.map((e) => e.id))).toEqual([0, 0, 30, 20]);
    },
    REAL_KERNEL_MS,
  );

  it(
    "parity: the person's Copy in one sketch and Paste in another store what the row stores",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', PLATE('A'));
      const a = featureNamed(h, 'A');
      const mode = h.mode!;
      expect(await mode.startSketch({ kind: 'plane', plane: 'origin:front' })).toBe(true);
      await vi.waitFor(() => expect(mode.stored()).not.toBeNull(), { timeout: 10_000 });
      await mode.idle();
      const clip = clipOf(a, a.entities.filter((e) => e.id.startsWith('r__')).map((e) => e.id)) as SketchClip;
      const mine = await applyPaste(mode, clip, [60, 30]);
      expect(mine.ok, JSON.stringify(mine)).toBe(true);
      const personId = mode.feature!;
      expect(await mode.finish()).toBeNull();
      await h.settle();
      await ok(h, 'sketch', SK({ name: 'Theirs', on: 'Front', entities: [], constraints: [C('k1', 'copy', ['r', 'at(60, 30)'], 'from A')] }));
      const person = h.doc.state.get().doc.features.find((f) => f.id === personId) as SketchFeature;
      const theirs = featureNamed(h, 'Theirs');
      const shape = (f: SketchFeature) => ({
        box: boxOf(f, f.entities.map((e) => e.id)),
        kinds: f.entities.map((e) => e.kind),
        constraints: f.constraints.map((c) => [c.kind, c.refs.map((x) => f.entities.findIndex((e) => e.id === x)), isDimension(c) ? c.expr : '']),
      });
      expect(shape(theirs)).toEqual(shape(person));
      expect(shape(person).box).toEqual([45, 20, 75, 40]);
    },
    REAL_KERNEL_MS,
  );

  it(
    'honest errors, and nothing changes',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', PLATE('A'));
      await ok(h, 'extrude', { edit: '', name: 'Base', sketch: 'A', regions: ['r1'], face: '', direction: '', extent: 'blind', distance: '5 mm', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '' });
      const B = (refs: string[], value: string) => SK({ name: 'B', on: 'Front', entities: [], constraints: [C('k1', 'copy', refs, value)] });
      const before = h.doc.state.get().doc.features.map((f) => f.name);
      expect((await fail(h, 'sketch', B(['r'], 'from A; offset 10'))).message).toContain('offset is "<du>, <dv>" in mm ("offset 40, 0"), not "10"');
      expect((await fail(h, 'sketch', B(['r', 'at(0, 0)'], 'from A; offset 1, 2'))).message).toContain('offset or at(u, v), not both');
      expect((await fail(h, 'sketch', B(['r'], 'from Nope'))).message).toContain('no feature is called "Nope"');
      expect((await fail(h, 'sketch', B(['r'], 'from Base'))).message).toContain('Base is a extrude, not a sketch');
      expect((await fail(h, 'sketch', B(['zz'], 'from A'))).message).toContain('A has no entity called "zz"');
      expect((await fail(h, 'sketch', B(['r'], 'colour red'))).message).toContain('"colour" is not one of from, offset');
      expect((await fail(h, 'sketch', SK({ name: 'B', entities: [E('l', 'line', [0, 0, 1, 0])], constraints: [C('k1', 'copy', ['nope'])] }))).message).toContain('no entity, part or point is called "nope"');
      expect(h.doc.state.get().doc.features.map((f) => f.name)).toEqual(before);
    },
    REAL_KERNEL_MS,
  );
});
