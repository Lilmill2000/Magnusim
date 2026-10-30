// The sketch tool's import row (help sketch_tools: import), on the REAL kernel and solver through
// sketch mode, with the host's call.readAttachment faked (tests/fakes/assistant-sdk.ts):
//   - an attached DXF is read by its attachment id and added as the person's Import SVG/DXF adds
//     it: made gives the very words the person's panel shows (read, skipped, size, open ends, the
//     scale, layers, notes), the regions close, and one region extrudes to its area times the depth;
//   - parity: the same file through the person's Import SVG/DXF (sketch mode, OK) and through the
//     row stores the same entities on the same points;
//   - value: scale, place and layers; the curves' names "<id>.1"...;
//   - honest errors: no readAttachment on the host, an id the conversation does not have, an id
//     that is not one, a read that failed, a binary DXF, a drawing past the cap, bad values.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawSteps } from '../../src/assistant/sketch/write';
import { planImport, readDrawing, summaryWords } from '../../src/sketch/import';
import { applyImport } from '../../src/sketch/import/tool';
import type { SketchFeature } from '../../src/types/doc';
import { bytesOf, DXF_BINARY, DXF_PART, DXF_PART_AREAS, manyLinesDxf, SVG_MM, SVG_MM_RECT_AREA } from '../sketch/import/fixtures';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { C, E, featureNamed, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const ATT = 'att-0123456789abcdef';
const ATT2 = 'att-fedcba9876543210';
const fileOf = (name: string, data: string | Uint8Array<ArrayBuffer>) => new File([typeof data === 'string' ? bytesOf(data) : data], name, { type: 'application/octet-stream' });
const ok = async (x: AssistantHarness, tool: string, input: Row) => {
  const r = await x.call(tool, input);
  if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
  return r.result as { text: string; data: Row };
};
const fail = async (x: AssistantHarness, tool: string, input: Row) => {
  const r = await x.call(tool, input);
  if (r.ok) throw new Error(`${tool} did not fail: ${JSON.stringify(r.result).slice(0, 300)}`);
  return r.error as { code: string; message: string; hint: string; detail: Row };
};
const IMPORT = (name: string, att = ATT, value = '', on = 'Top') => SK({ name, on, entities: [], constraints: [C('i1', 'import', [att], value)] });

/** A sketch's entities and points with its random ids renamed in the order met, numbers to 1e-6. */
function canon(f: SketchFeature) {
  const map = new Map<string, string>();
  const rid = (x: string) => {
    if (!/^(e|pt)_[0-9a-z]{12}$/.test(x)) return x;
    if (!map.has(x)) map.set(x, `#${map.size + 1}`);
    return map.get(x)!;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return rid(v);
    if (typeof v === 'number') return Math.round(v * 1e6) / 1e6 + 0;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const entities = walk(f.entities);
  const points = Object.fromEntries(Object.entries(f.points).map(([k, p]) => [rid(k), walk(p)]));
  return { entities, points, constraints: f.constraints };
}

describe('the import row', () => {
  it(
    "an attached DXF goes in as the person's Import adds it: made says what the person's panel says; the outlines close; a region extrudes",
    async () => {
      h = await assistantHarness({ sketchMode: true, assistant: { attachments: { [ATT]: fileOf('part.dxf', DXF_PART) } } });
      const r = await ok(h, 'sketch', IMPORT('Part'));
      expect(h.fake.reads).toEqual([ATT]);
      const panel = summaryWords(planImport(readDrawing('part.dxf', bytesOf(DXF_PART))).summary);
      const made = (r.data.made as Row[])[0];
      expect(made).toEqual({
        id: 'i1',
        kind: 'import',
        entities: Array.from({ length: 14 }, (_, k) => `i1.${k + 1}`),
        values: { file: 'part.dxf', read: panel.read, skipped: panel.skipped, size: panel.size, open_ends: 0, scale: panel.scale, layers: panel.layers, notes: panel.notes.join(' ') },
      });
      expect(made.values).toMatchObject({ read: 'Read: 8 lines, 3 arcs, 1 circle, 1 ellipse, 1 spline', skipped: 'Skipped: 1 TEXT', open_ends: 0 });
      // Every outline closed: seven regions (the slot round its hole, the hole, the half disc, the
      // spline's two either side of the line it crosses, the ellipse, the square).
      expect(r.data.open).toEqual([]);
      const regions = r.data.regions as { id: string; area_mm2: number }[];
      expect(regions).toHaveLength(7);
      const in2 = 25.4 * 25.4;
      expect(regions[0].area_mm2).toBeCloseTo(DXF_PART_AREAS.slot * in2, 1);
      // Under-defined, as imported geometry is: no relation was added.
      expect(r.data.solver).toMatchObject({ state: 'under' });
      expect(featureNamed(h, 'Part').constraints).toEqual([]);
      const ex = await ok(h, 'extrude', { edit: '', name: 'Slot', sketch: 'Part', regions: ['r1'], face: '', direction: '', extent: 'blind', distance: '10 mm', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '' });
      expect(ex.data.feature).toMatchObject({ state: 'ok' });
      const vol = await ok(h, 'measure', { targets: ['Body 1'], section: '' });
      expect(vol.data.volume_mm3 as number).toBeCloseTo(DXF_PART_AREAS.slot * in2 * 10, 0);
    },
    REAL_KERNEL_MS,
  );

  it(
    "parity: the same SVG through the person's Import SVG/DXF and through the row stores the same entities on the same points",
    async () => {
      h = await assistantHarness({ sketchMode: true, assistant: { attachments: { [ATT]: fileOf('plate.svg', SVG_MM) } } });
      const mode = h.mode!;
      expect(await mode.startSketch({ kind: 'plane', plane: 'origin:top' })).toBe(true);
      await vi.waitFor(() => expect(mode.stored()).not.toBeNull(), { timeout: 10_000 });
      await mode.idle();
      const mine = await applyImport(mode, readDrawing('plate.svg', bytesOf(SVG_MM)), { place: 'centre' });
      expect(mine.ok, JSON.stringify(mine)).toBe(true);
      const personId = mode.feature!;
      expect(await mode.finish()).toBeNull();
      await h.settle();
      const r = await ok(h, 'sketch', IMPORT('Theirs', ATT, 'place centre'));
      const person = h.doc.state.get().doc.features.find((f) => f.id === personId) as SketchFeature;
      const theirs = featureNamed(h, 'Theirs');
      expect(canon(theirs)).toEqual(canon(person));
      expect(person.entities).toHaveLength(13);
      // Both close the same three outlines; the rounded rectangle's area is exact.
      const areas = (r.data.regions as { area_mm2: number }[]).map((x) => x.area_mm2);
      expect(areas).toHaveLength(3);
      expect(areas.some((a) => Math.abs(a - SVG_MM_RECT_AREA) < 1e-3)).toBe(true);
    },
    REAL_KERNEL_MS,
  );

  it(
    'value: the scale, centre and layers; later rows name the curves "<id>.1"...; with entities of its own',
    async () => {
      h = await assistantHarness({ sketchMode: true, assistant: { attachments: { [ATT]: fileOf('part.dxf', DXF_PART) } } });
      const r = await ok(h, 'sketch', SK({ name: 'Square', on: 'Top', entities: [E('c', 'circle', [0, 0, 1])], constraints: [C('i1', 'import', [ATT], 'scale 10; place centre; layers Parts'), C('f1', 'fix', ['i1.1'])] }));
      const made = (r.data.made as Row[])[0];
      expect(made.values).toMatchObject({ read: 'Read: 4 lines', size: 'Size: 20 × 20 mm', scale: 'Scale: 1 unit = 10 mm ($INSUNITS 1: inches)', layers: 'Layers: 0 (10), Parts (4), Hidden (1); left out: 0, Hidden' });
      const f = featureNamed(h, 'Square');
      expect(f.entities.map((e) => e.kind)).toEqual(['circle', 'line', 'line', 'line', 'line']);
      // Centred: the square spans -10..10; fix held the first line.
      const xs = Object.values(f.points).map((p) => p[0]);
      expect(Math.min(...xs)).toBeCloseTo(-10, 6);
      expect(f.constraints.map((c) => c.kind)).toEqual(['fix']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'honest errors: a host without readAttachment; an id the conversation has not; not an id; a failed read; a binary DXF; past the cap; bad values; nothing changes',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const none = await fail(h, 'sketch', IMPORT('A'));
      expect(none.message).toBe("not_editable: constraints[0] (i1, import): this Magnusim cannot hand an attached file to a tool: the person can bring the drawing in with Import SVG/DXF in the sketch (MODIFY).");
      expect(none.code).toBe('not_ready');
      h.dispose();
      h = await assistantHarness({
        sketchMode: true,
        assistant: { attachments: { [ATT]: fileOf('b.dxf', DXF_BINARY), [ATT2]: { code: 'failed', message: 'The file did not arrive whole. Try again.' }, 'att-1111111111111111': fileOf('many.dxf', manyLinesDxf(20_001)) } },
      });
      const missing = await fail(h, 'sketch', IMPORT('A', 'att-2222222222222222'));
      expect(missing.message).toContain('no attached file att-2222222222222222 in this conversation');
      expect(missing.code).toBe('invalid_input');
      expect((await fail(h, 'sketch', IMPORT('A', 'plate.svg'))).message).toContain('"plate.svg" is not an attachment id');
      expect((await fail(h, 'sketch', IMPORT('A', ATT2))).message).toBe(`internal: constraints[0] (i1, import): ${ATT2} could not be read (The file did not arrive whole. Try again): try again.`);
      expect((await fail(h, 'sketch', IMPORT('A'))).message).toBe('bad_input: constraints[0] (i1, import): b.dxf is a binary DXF: save it as an ASCII DXF (R12 or later) and import that.');
      expect((await fail(h, 'sketch', IMPORT('A', 'att-1111111111111111'))).message).toBe('bad_input: constraints[0] (i1, import): many.dxf has 20,001 curves to import: at most 20,000 go into one sketch.');
      expect((await fail(h, 'sketch', IMPORT('A', ATT, 'scale -2'))).message).toContain('scale is the mm per drawing unit, a number above 0');
      expect((await fail(h, 'sketch', IMPORT('A', ATT, 'place left'))).message).toContain('place is origin');
      expect((await fail(h, 'sketch', IMPORT('A', ATT, 'colour red'))).message).toContain('"colour" is not one of scale, place, layers');
      expect(h.doc.state.get().doc.features).toEqual([]);
      // entities [] needs an import row.
      expect((await fail(h, 'sketch', SK({ name: 'A' }))).message).toContain('entities: give at least one shape (or an import or copy row)');
    },
    REAL_KERNEL_MS,
  );
});

describe('watched', () => {
  it("an import's curves are drawn in one step, named by its row", () => {
    const target = {
      points: { a: [0, 0] as [number, number], b: [1, 0] as [number, number], c: [1, 1] as [number, number] },
      entities: [
        { id: 'e_000000000001', kind: 'line' as const, p: ['a', 'b'] as [string, string] },
        { id: 'e_000000000002', kind: 'line' as const, p: ['b', 'c'] as [string, string] },
      ],
      constraints: [],
    };
    const groups = { e_000000000001: 'i1', e_000000000002: 'i1' };
    expect(drawSteps({ points: {}, entities: [], constraints: [] }, target, { i1: 'drawing' }, groups).map((s) => s.label)).toEqual(['Draw drawing i1']);
    expect(drawSteps({ points: {}, entities: [], constraints: [] }, target).map((s) => s.label)).toEqual(['Draw line e_000000000001', 'Draw line e_000000000002']);
  });
});
