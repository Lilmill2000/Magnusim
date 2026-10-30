// Section view (src/features/section, src/viewport/section.ts), Daniel 2026-10-29: any plane, a
// draggable normal arrow, a typed offset and flip kept.
//   - the view's section state after a change: an origin plane brings its frame, a construction
//     plane or a face needs the one found for it;
//   - the arrow: on the cut where the line through the shown bodies' centre along the normal crosses
//     it, pointing along the plane's own normal; a drag adds how far it went along it, rounded to a
//     pixel's step, Ctrl to whole steps (mm and inch Parts);
//   - kept in the Part's view: readSection takes an origin plane, a construction plane, a face, and
//     nothing else; DocService.setSection writes it (no undo step) and a reload reads it back;
//   - on the REAL kernel with the section binding: a construction plane at an angle (its own normal),
//     the cut follows it when a parameter turns it; a flat face by its reference, the cut follows it
//     when the extrude grows; the plane rolled back keeps the cut where it was (with a note); deleted,
//     the section turns off with a note and a toast; the saved section comes back when the Part opens.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSection, readView } from '../../../src/doc/schema';
import { viewInput } from '../../../src/features/picture/panel';
import { bindSection, savedOf, sectionNotes, setSectionView } from '../../../src/features/section/bind';
import { arrowPlace, draggedOffset } from '../../../src/features/section/handle-math';
import { cutPoint, findSectionFrame, sectionPlaneKey, sectionPlaneWords } from '../../../src/features/section/plane';
import { createStateStore } from '../../../src/lib/store';
import type { BodyId, PersistentRef, RegionRef, Vec3 } from '../../../src/types/doc';
import type { SketchOutput } from '../../../src/types/sketch';
import type { SectionState, ViewportHandle } from '../../../src/types/viewport';
import { DEFAULT_SECTION, nextSection, offsetRange, originFrame } from '../../../src/viewport/section';
import { assistantHarness, REAL_KERNEL_MS, rectangle, type AssistantHarness } from '../../assistant/harness';

const MM = { length: 'mm', angle: 'deg' } as const;
const IN = { length: 'in', angle: 'deg' } as const;
const near = (a: readonly number[], b: readonly number[], tol = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe('the section state', () => {
  it('an origin plane brings its own frame; a construction plane or a face needs the frame found for it', () => {
    const top = nextSection(DEFAULT_SECTION, { on: true, plane: { kind: 'origin', plane: 'origin:top' }, offset: 4 });
    expect(top).toEqual({ on: true, plane: { kind: 'origin', plane: 'origin:top' }, frame: originFrame('origin:top'), offset: 4, flip: false });
    expect(() => nextSection(top, { plane: { kind: 'feature', feature: 'f_1' } })).toThrow(/needs its frame/);
    const frame = { origin: [0, 0, 5] as Vec3, normal: [0, 0.6, 0.8] as Vec3, xdir: [1, 0, 0] as Vec3 };
    const tilted = nextSection(top, { plane: { kind: 'feature', feature: 'f_1' }, frame });
    expect(tilted).toMatchObject({ plane: { kind: 'feature', feature: 'f_1' }, frame, offset: 4 });
    // The frame alone (the plane followed after a rebuild); a bad frame or offset keeps what was.
    const moved = nextSection(tilted, { frame: { ...frame, origin: [0, 0, 7] } });
    expect(moved.frame.origin).toEqual([0, 0, 7]);
    expect(nextSection(moved, { frame: { origin: [0, 0, Number.NaN], normal: [0, 0, 1], xdir: [1, 0, 0] } }).frame.origin).toEqual([0, 0, 7]);
    expect(nextSection(moved, { frame: { origin: [0, 0, 0], normal: [0, 0, 0], xdir: [1, 0, 0] } }).frame.normal).toEqual([0, 0.6, 0.8]);
    expect(nextSection(moved, { offset: Number.NaN }).offset).toBe(4);
    expect(savedOf(moved)).toEqual({ plane: { kind: 'feature', feature: 'f_1' }, offset: 4, flip: false });
    expect(savedOf({ ...moved, on: false })).toBeNull();
    expect(sectionPlaneKey({ kind: 'origin', plane: 'origin:top' })).not.toBe(sectionPlaneKey({ kind: 'feature', feature: 'f_1' }));
  });
});

describe("the section's arrow", () => {
  it("stands on the cut over the bodies' centre and points along the plane's normal", () => {
    // Top plane, offset 4; a box from (0, 0, 0) to (20, 10, 30): the arrow at (10, 5, 4), up.
    expect(arrowPlace(originFrame('origin:top'), 4, [[0, 0, 0, 20, 10, 30]])).toEqual({ origin: [10, 5, 4], dir: [0, 0, 1] });
    // Front plane (normal -Y), offset -10 (y = 10): the arrow at (10, 10, 15), along -Y.
    const front = arrowPlace(originFrame('origin:front'), -10, [[0, 0, 0, 20, 20, 30]]);
    expect(near(front.origin, [10, 10, 15])).toBe(true);
    expect(front.dir).toEqual([0, -1, 0]);
    // A tilted plane: the arrow is on the cut and along its own (unit) normal.
    const s = Math.SQRT1_2;
    const t = arrowPlace({ origin: [0, 0, 10], normal: [2, 0, 2] }, 3, [[0, 0, 0, 20, 20, 20]]);
    expect(near(t.dir, [s, 0, s])).toBe(true);
    const p = cutPoint({ origin: [0, 0, 10], normal: [s, 0, s] }, 3);
    expect(Math.abs((t.origin[0] - p[0]) * s + (t.origin[2] - p[2]) * s)).toBeLessThan(1e-9);
    expect(t.origin[1]).toBeCloseTo(10, 9);
    // No body shown: on the plane's own normal line.
    expect(arrowPlace(originFrame('origin:right'), 2, [])).toEqual({ origin: [2, 0, 0], dir: [1, 0, 0] });
  });

  it("a drag adds how far it went along the arrow, rounded to a pixel's step; Ctrl to whole steps", () => {
    // 0.1 mm a pixel: steps of 0.1 mm.
    expect(draggedOffset(4, 8.04, 0.1, MM, false)).toBe(12);
    expect(draggedOffset(4, 8.26, 0.1, MM, false)).toBeCloseTo(12.3, 9);
    // 0.02 mm a pixel: steps of 0.01 mm.
    expect(draggedOffset(0, 1.234, 0.02, MM, false)).toBeCloseTo(1.23, 9);
    // Ctrl: whole mm; in an inch Part, tenths of an inch.
    expect(draggedOffset(4, 8.26, 0.1, MM, true)).toBe(12);
    expect(draggedOffset(0, 26, 0.1, IN, true)).toBeCloseTo(25.4, 9);
    expect(draggedOffset(-5, -3.4, 0.1, MM, true)).toBe(-8);
  });
});

describe("the Picture panel's section (the person's side of the view tool's)", () => {
  it('takes a construction plane by its name and the selected flat face, as the view tool reads them', () => {
    const base = { views: ['iso' as const], hide: [], labels: 'none' as const, size: 'small' as const, display: 'shaded_edges' as const, projection: 'orthographic' as const };
    expect(viewInput({ ...base, section: { plane: 'Tilt', at: 'offset', offset: '5', flip: true } }).section).toBe('Tilt offset 5 flip');
    expect(viewInput({ ...base, section: { plane: 'selection', at: 'middle', offset: '', flip: false } }).section).toBe('selection middle');
    expect(viewInput({ ...base, section: { plane: '', at: 'offset', offset: '5', flip: true } }).section).toBe('');
  });
});

describe('kept in the Part', () => {
  it('readSection takes an origin plane, a construction plane and a face with their offset and side, and nothing else', () => {
    expect(readSection({ plane: { kind: 'origin', plane: 'origin:right' }, offset: 2.5, flip: true })).toEqual({ plane: { kind: 'origin', plane: 'origin:right' }, offset: 2.5, flip: true });
    expect(readSection({ plane: { kind: 'feature', feature: 'f_9' }, offset: 'x' })).toEqual({ plane: { kind: 'feature', feature: 'f_9' }, offset: 0, flip: false });
    const ref = { name: 'F:f_2:end', signature: { type: 'plane' } };
    expect(readSection({ plane: { kind: 'face', body: 'b_1', ref }, offset: -3, flip: false })).toEqual({ plane: { kind: 'face', body: 'b_1', ref }, offset: -3, flip: false });
    for (const bad of [null, 5, {}, { plane: { kind: 'origin', plane: 'origin:side' } }, { plane: { kind: 'feature' } }, { plane: { kind: 'face', body: 'b_1', ref: { name: 3 } } }, { plane: { kind: 'axis' } }]) {
      expect(readSection(bad), JSON.stringify(bad)).toBeNull();
    }
    // A view read back: the section when it is there; none (off) otherwise.
    expect(readView({ rollback: null, hiddenBodies: [], expanded: [], section: { plane: { kind: 'origin', plane: 'origin:top' }, offset: 4, flip: false } }, 0).section).toEqual({ plane: { kind: 'origin', plane: 'origin:top' }, offset: 4, flip: false });
    expect(readView({ rollback: null, hiddenBodies: [], expanded: [], section: { plane: 'origin:top' } }, 0).section).toBeUndefined();
  });
});

// ------------------------------------------------------------ on the real kernel

let h: AssistantHarness | null = null;
let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  h?.dispose();
  h = null;
});

/** A view that keeps a section state as the real one does (nextSection), over the bodies' boxes. */
function fakeView(x: AssistantHarness) {
  const state = createStateStore<{ section: SectionState }>({ section: { ...DEFAULT_SECTION } });
  const handle = {
    state,
    setSection: (p: Partial<SectionState>) => state.set({ section: nextSection(state.get().section, p) }),
    sectionRange: (f: { origin: Vec3; normal: Vec3 }) => offsetRange(f, x.doc.state.get().rebuild.bodies.filter((b) => b.visible).map((b) => b.bbox)),
  };
  x.services.viewport.set({ handle: handle as unknown as ViewportHandle });
  return handle;
}

async function block(x: AssistantHarness, w: number, d: number, t: string) {
  const rect = rectangle(w, d);
  const sketch = await x.add('sketch', { points: rect.points, entities: rect.entities });
  const out = x.doc.state.get().rebuild.outputs[sketch] as SketchOutput;
  const r = out.regions[0];
  const profile: RegionRef = { sketch, region: r.key, entities: [...r.entities].sort(), sample: r.sample };
  const extrude = await x.add('extrude', { profiles: [profile], extent: { kind: 'blind', distance: t }, op: 'new' });
  const body = (x.doc.state.get().doc.features.find((f) => f.id === extrude) as { creates?: BodyId }).creates as BodyId;
  return { sketch, extrude, body };
}

const settled = async (x: AssistantHarness) => {
  await x.settle();
  // The binding's look-up after the rebuild (a kernel call for a face).
  await new Promise((r) => setTimeout(r, 30));
  await x.settle();
};

describe('the section binding (real kernel)', () => {
  it(
    "a construction plane at an angle: the cut on its own frame and normal, following it when a parameter turns it; rolled back the cut stays (a note); deleted, off with a note",
    async () => {
      h = await assistantHarness();
      const view = fakeView(h);
      stop = bindSection(h.services);
      h.doc.addParam({ name: 'tilt', expr: '30 deg', quantity: 'angle' });
      await block(h, 20, 20, '20 mm');
      const plane = await h.add('ref_plane', { method: 'angle', plane: { kind: 'origin', plane: 'origin:top' }, axis: { kind: 'origin', axis: 'origin:x' }, angle: 'tilt', name: 'Tilt' });
      await settled(h);
      const r = await setSectionView(h.services, { plane: { kind: 'feature', feature: plane }, offset: 3 });
      expect(r.ok).toBe(true);
      const sec = view.state.get().section;
      expect(sec).toMatchObject({ on: true, plane: { kind: 'feature', feature: plane }, offset: 3, flip: false });
      // Its own normal: the Top plane's turned 30 deg about X.
      expect(Math.abs(sec.frame.normal[1])).toBeCloseTo(0.5, 9);
      expect(sec.frame.normal[2]).toBeCloseTo(Math.sqrt(3) / 2, 9);
      expect(sectionPlaneWords(h.doc.state.get(), sec.plane)).toBe('Tilt');
      // Kept in the Part's view (no undo step).
      const undo = h.doc.state.get().history.undoLabel;
      await vi.waitFor(() => expect(h!.doc.state.get().view.section).toEqual({ plane: { kind: 'feature', feature: plane }, offset: 3, flip: false }));
      expect(h.doc.state.get().history.undoLabel).toBe(undo);

      // The parameter turns the plane to 45 deg: the cut follows.
      const tilt = h.doc.state.get().doc.params.find((p) => p.name === 'tilt')!;
      h.doc.updateParam(tilt.id, { expr: '45 deg' });
      await settled(h);
      await vi.waitFor(() => expect(view.state.get().section.frame.normal[2]).toBeCloseTo(Math.SQRT1_2, 9));
      expect(view.state.get().section).toMatchObject({ on: true, offset: 3 });

      // The rollback bar above the plane: not built, held back: the cut stays where it was, a note says so.
      const at = view.state.get().section.frame;
      h.doc.setRollback(2);
      await settled(h);
      await vi.waitFor(() => expect(sectionNotes(h!.services).get().note).toMatch(/^Tilt is not built now \(.*\): the cut stays where it last was until it builds again\.$/));
      expect(view.state.get().section.on).toBe(true);
      expect(view.state.get().section.frame).toEqual(at);
      h.doc.setRollback(null);
      await settled(h);
      await vi.waitFor(() => expect(sectionNotes(h!.services).get().note).toBeNull());

      // Deleted: the section turns off, with a note and a toast; the Part keeps it off.
      expect(h.doc.remove(plane).ok).toBe(true);
      await settled(h);
      await vi.waitFor(() => expect(view.state.get().section.on).toBe(false));
      expect(sectionNotes(h.services).get().note).toBe('The section view is off: Tilt was deleted.');
      expect(h.ws.log.toasts.at(-1)).toEqual({ message: 'The section view is off: Tilt was deleted.', kind: 'info' });
      await vi.waitFor(() => expect(h!.doc.state.get().view.section).toBeUndefined());
    },
    REAL_KERNEL_MS,
  );

  it(
    'a flat face by its reference: the cut follows the face when the extrude grows; the saved section comes back when the Part opens',
    async () => {
      h = await assistantHarness();
      const view = fakeView(h);
      stop = bindSection(h.services);
      h.doc.addParam({ name: 'height', expr: '20 mm', quantity: 'length' });
      const { body } = await block(h, 20, 20, 'height');
      await settled(h);
      // The top face (Extrude 1's end face), picked as the person's panel picks it.
      const b = h.doc.state.get().rebuild.bodies.find((x) => x.id === body)!;
      const top = b.names!.faces.findIndex((n) => /:end/.test(n));
      const { pickFace } = await import('../../../src/features/p2/refs');
      const picked = await pickFace(h.services, b, top, null);
      expect(picked.ok).toBe(true);
      const face = { kind: 'face' as const, body, ref: (picked as unknown as { ref: PersistentRef }).ref };
      expect((await setSectionView(h.services, { plane: face, offset: -5, flip: true })).ok).toBe(true);
      // The face's plane: through z = 20, its normal out of the material (+Z); cut at z = 15.
      expect(view.state.get().section.frame.normal).toEqual([0, 0, 1]);
      expect(cutPoint(view.state.get().section.frame, -5)[2]).toBeCloseTo(15, 9);
      expect(sectionPlaneWords(h.doc.state.get(), face)).toMatch(/Extrude 1 on Body 1$/);
      const found = await findSectionFrame(h.services, face);
      expect(found.ok && found.frame.origin[2]).toBeCloseTo(20, 9);

      // The extrude grows to 30 mm: the face moves up, and so does the cut (5 mm below it).
      const height = h.doc.state.get().doc.params.find((p) => p.name === 'height')!;
      h.doc.updateParam(height.id, { expr: '30 mm' });
      await settled(h);
      await vi.waitFor(() => expect(cutPoint(view.state.get().section.frame, view.state.get().section.offset)[2]).toBeCloseTo(25, 9));

      // Kept in the view; a new binding (the Part opened again) puts it back.
      await vi.waitFor(() => expect(h!.doc.state.get().view.section).toMatchObject({ plane: { kind: 'face', body }, offset: -5, flip: true }));
      stop();
      view.setSection({ on: false, plane: { kind: 'origin', plane: 'origin:front' }, offset: 0 });
      stop = bindSection(h.services);
      await vi.waitFor(() => expect(view.state.get().section).toMatchObject({ on: true, plane: { kind: 'face', body }, offset: -5, flip: true }));
      expect(cutPoint(view.state.get().section.frame, -5)[2]).toBeCloseTo(25, 9);
    },
    REAL_KERNEL_MS,
  );
});
