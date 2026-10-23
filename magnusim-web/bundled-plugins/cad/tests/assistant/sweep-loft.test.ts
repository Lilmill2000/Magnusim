// sweep_loft on the REAL kernel, through the page's tool handler (CAD tools spec §3.2.10, §5.3 sweep
// labels, §7.4, §7.5, §7.7, §12.1 "real-kernel, labels"):
//   - a pipe elbow: a ring (OD 20, ID 16) on Top swept along a path on Front (30 mm up, a R40
//     quarter bend, 30 mm along): its volume is the ring's area times the path's length; the faces
//     it made come back as labels (Sweep 1.start, .end, .side(o@a2) ...), which find reads back
//     (the bend's outer side a torus, the bore a hole, side(o) every side swept from o); one undo
//     entry for the request; get_model shows it as made by the Assistant;
//   - op new with a body name and a colour (one step), and a cut along a path through a plate;
//   - get_model full writes its inputs as this tool's input, which sent back with edit replaces it
//     in place; an edit with fewer path curves is kept; a sketch made after the sweep is refused
//     for an edit (later_feature); a loft edit of a sweep is wrong_feature_type;
//   - refused before anything changes, every field problem in one message: no path, a ruled
//     sweep, body fields with the wrong op, a bad colour, a body name another body has, the path
//     in the profile's sketch, profiles in two sketches, unknown sketches and curves, construction
//     curves; a macro's id takes its pieces ("Poly: p");
//   - a path with a gap changes nothing and answers feature_failed with CAD's words;
//   - the body's name and colour are set after the panel's Done, in the same step: a Stop there
//     (held at between-opens) reverts at once, and a person's change there answers busy changed;
//   - a loft from a 20 mm square on Top to a 10 mm square on "Top offset 30 mm" (the sketch tool):
//     the frustum's volume, side labels by the first profile's parts (Loft 1.side(r.top)), ruled;
//     its inputs round-trip; a loft needs two profiles, one region each, in different sketches; a
//     profile with a hole fails with the kernel's words.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeOf } from '../../src/assistant/runtime';
import type { LoftFeature, SweepFeature } from '../../src/types/doc';
import { uiFor } from '../../src/ui/controller';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { plate, Shapes, sketchOn, undoLabel } from './parts';
import { E, SK } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

type Row = Record<string, unknown>;
const SWEEP = (o: Row = {}): Row => ({ edit: '', name: '', kind: 'sweep', profiles: ['Ring'], path: 'Path', orientation: 'follow', ruled: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
const LOFT = (o: Row = {}): Row => ({ edit: '', name: '', kind: 'loft', profiles: ['Base sq', 'Top sq'], path: '', orientation: 'follow', ruled: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
const featureNamed = <T>(x: AssistantHarness, name: string) => x.doc.state.get().doc.features.find((f) => f.name === name) as unknown as T;
const names = (x: AssistantHarness) => x.doc.state.get().doc.features.map((f) => f.name);
const volumeOf = (x: AssistantHarness, name: string) => x.doc.state.get().rebuild.bodies.find((b) => b.name === name)!.volume!;
const rel = (a: number, b: number) => Math.abs(a / b - 1);
const reasonOf = (r: { ok: boolean; error?: { detail?: unknown } }) => (r.ok ? null : ((r as { error: { detail: { reason: string } } }).error.detail?.reason ?? null));
const messageOf = (r: unknown) => (r as { error: { message: string } }).error.message;

/** The ring's area (OD 20, ID 16) and the path's length (30 up, a quarter of R40, 30 along). */
const RING = Math.PI * (10 * 10 - 8 * 8);
const BEND = (Math.PI / 2) * 40;
const PIPE = RING * (30 + BEND + 30);

/** The pipe's sketches: Ring (circles o and i) on Top; Path (l1 up, a2 the bend, l3 along) on Front. */
async function pipeSketches(x: AssistantHarness): Promise<{ ring: string; path: string }> {
  const ring = await sketchOn(x, 'Ring', 'origin:top', new Shapes().circle('o', [0, 0], 10).circle('i', [0, 0], 8));
  // On Front u is +X and v is +Z: up the Z axis, bend towards +X about (40, 30), then along +X.
  const path = await sketchOn(x, 'Path', 'origin:front', new Shapes().line('l1', [0, 0], [0, 30]).arc('a2', [40, 30], [40, 70], [0, 30]).line('l3', [40, 70], [70, 70]));
  return { ring, path };
}

describe('sweep', () => {
  it(
    'a ring along a line, a bend and a line: the volume by formula, the faces as labels, one undo entry',
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-test', title: 'A pipe elbow' });
      await pipeSketches(h);
      const r = await h.ok('sweep_loft', SWEEP());
      expect(r.data).toMatchObject({
        feature: { name: 'Sweep 1', type: 'sweep', state: 'ok' },
        kind: 'sweep',
        // The ring is r2: the inner disc (a hole of it) is larger.
        profiles: [{ sketch: 'Ring', region: 'r2', holes: 1 }],
        path: { sketch: 'Path', curves: ['l1', 'a2', 'l3'] },
        bodies: { created: [{ body: 'Body 1', solids: 1 }], changed: [], removed: [] },
        resolved: {
          profiles: 'Ring -> r2 of Ring (113.097 mm2, 1 hole)',
          path: 'Path -> 3 curves (line l1, arc a2, line l3) of Path',
          orientation: 'follow (the profile turns with the path)',
          op: 'new body',
        },
        broke: [],
        step: 1,
      });
      expect(rel(volumeOf(h, 'Body 1'), PIPE)).toBeLessThan(1e-4);
      expect(r.text).toMatch(/^Sweep 1 ok: Ring r2 along Path \(l1, a2, l3\) · Body 1 made \(1389\d mm³\)$/);
      // The faces it made: both caps and a side for each profile curve along each path curve.
      const created = r.data.created as string[];
      expect([...created].sort()).toEqual(['Sweep 1.end', 'Sweep 1.side(i@a2)', 'Sweep 1.side(i@l1)', 'Sweep 1.side(i@l3)', 'Sweep 1.side(o@a2)', 'Sweep 1.side(o@l1)', 'Sweep 1.side(o@l3)', 'Sweep 1.start'].sort());
      // find reads the labels back: the bend's outside is a torus, the bore a hole, the outside a boss.
      const row = async (query: string) => ((await h!.ok('find', { query, limit: 10 })).data.rows as Row[])[0];
      expect(await row('Sweep 1.side(o@a2)')).toMatchObject({ label: 'Sweep 1.side(o@a2)', type: 'torus' });
      expect(await row('Sweep 1.side(i@l1)')).toMatchObject({ label: 'Sweep 1.side(i@l1)', type: 'cylinder', radius_mm: 8, hole: true });
      expect(await row('Sweep 1.side(o@l3)')).toMatchObject({ type: 'cylinder', radius_mm: 10, hole: false });
      expect(await row('Sweep 1.start')).toMatchObject({ type: 'plane', normal: [0, 0, -1] });
      // side(o): every side swept from o, along each curve of the path.
      const outer = await h.ok('find', { query: 'Sweep 1.side(o)', limit: 10 });
      expect(outer.data.count).toBe(3);
      expect((outer.data.rows as Row[]).map((x) => x.label).sort()).toEqual(['Sweep 1.side(o@a2)', 'Sweep 1.side(o@l1)', 'Sweep 1.side(o@l3)']);
      // get_model: made by the Assistant, its faces by role.
      const brief = await h.ok('get_model', { detail: 'brief', feature: '' });
      expect((brief.data.features as Row[]).find((f) => f.name === 'Sweep 1')).toMatchObject({ type: 'sweep', state: 'ok', by: 'assistant', op: 'new', made: ['Body 1'], faces: { start: 1, end: 1, side: 6 } });
      expect(featureNamed<SweepFeature>(h, 'Sweep 1')).toMatchObject({ orientation: 'follow', op: 'new', scope: [], path: { entities: ['l1', 'a2', 'l3'] } });
      // One entry: Undo takes the sweep away.
      expect(undoLabel(h)).toBe('Assistant: A pipe elbow');
      h.fake.emitTurn({ id: 't-test', title: 'A pipe elbow', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(names(h)).toEqual(['Ring', 'Path']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'op new names and colours its body in the same step; a cut along a path takes a groove out of a plate',
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-test', title: 'A tube and a groove' });
      await pipeSketches(h);
      const tube = await h.ok('sweep_loft', SWEEP({ name: 'Pipe', path: 'Path: l1, a2', body_name: 'Tube', color: '#3366CC' }));
      expect(tube.data).toMatchObject({ feature: { name: 'Pipe', type: 'sweep' }, path: { sketch: 'Path', curves: ['l1', 'a2'] }, resolved: { op: 'new body Tube' }, bodies: { created: [{ body: 'Tube' }] } });
      const pipe = featureNamed<SweepFeature>(h, 'Pipe');
      expect(h.doc.state.get().doc.bodies[pipe.creates!]).toMatchObject({ name: 'Tube', color: '#3366cc' });
      expect(rel(volumeOf(h, 'Tube'), RING * (30 + BEND))).toBeLessThan(1e-4);
      // A plate 60 x 40 x 6, and a 1 mm circle swept along x at z = 3 from x = 0: a groove 30 mm long inside it.
      const p = await plate(h);
      await sketchOn(h, 'Dot', 'origin:right', new Shapes().circle('c', [0, 3], 1));
      await sketchOn(h, 'Run', 'origin:front', new Shapes().line('g', [0, 3], [40, 3]));
      const plate1 = h.doc.state.get().rebuild.bodies.find((b) => b.feature === p.extrude)!;
      const plateBody = plate1.name;
      const groove = await h.ok('sweep_loft', SWEEP({ name: 'Groove', profiles: ['Dot'], path: 'Run', op: 'cut', bodies: [plateBody] }));
      expect(groove.data).toMatchObject({ feature: { name: 'Groove', state: 'ok' }, resolved: { op: `cut ${plateBody}` }, bodies: { created: [], removed: [] } });
      expect(featureNamed<SweepFeature>(h, 'Groove')).toMatchObject({ op: 'cut', creates: null, scope: [plate1.id] });
      expect(volumeOf(h, plateBody)).toBeCloseTo(14400 - Math.PI * 30, 2);
      // The person's plate came between the two calls: the groove is a group of its own, and one
      // Undo takes only it away.
      expect(undoLabel(h)).toBe('Assistant: A tube and a groove');
      h.doc.undo();
      expect(names(h)).toEqual(['Ring', 'Path', 'Pipe', 'Sketch 1', 'Extrude 1', 'Dot', 'Run']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'get_model full writes it as this tool\'s input; sent back with edit it is replaced in place; edits are checked',
    async () => {
      h = await assistantHarness();
      await pipeSketches(h);
      await h.ok('sweep_loft', SWEEP());
      const full = await h.ok('get_model', { detail: 'full', feature: '' });
      const row = (full.data.features as Row[]).find((f) => f.name === 'Sweep 1')!;
      expect(row).toMatchObject({
        by: 'assistant',
        inputs: { edit: 'Sweep 1', name: '', kind: 'sweep', profiles: [expect.stringMatching(/^Ring at\(-?\d+(\.\d+)?, -?\d+(\.\d+)?\)$/)], path: 'Path: l1, a2, l3', orientation: 'follow', ruled: false, op: 'new', bodies: [], body_name: '', color: '' },
      });
      expect(row.values).toBeUndefined();
      const stored = featureNamed<SweepFeature>(h, 'Sweep 1');
      const again = await h.ok('sweep_loft', row.inputs as Row);
      expect(again.text).toMatch(/^Sweep 1 ok \(replaced\): Ring r2 along Path \(l1, a2, l3\)/);
      const now = featureNamed<SweepFeature>(h, 'Sweep 1');
      expect(now.id).toBe(stored.id);
      expect(now.creates).toBe(stored.creates);
      expect(now.profiles).toEqual(stored.profiles);
      // Fewer path curves: a structural edit, kept.
      const shorter = await h.ok('sweep_loft', { ...(row.inputs as Row), path: 'Path: l1' });
      expect(shorter.data).toMatchObject({ feature: { name: 'Sweep 1', state: 'ok' }, resolved: { edit: 'Sweep 1', path: 'Path: l1 -> line l1 of Path' } });
      expect(rel(volumeOf(h, 'Body 1'), RING * 30)).toBeLessThan(1e-4);
      // Sketches made after the sweep: an edit cannot use them.
      await sketchOn(h, 'Late path', 'origin:front', new Shapes().line('m', [0, 0], [0, 10]));
      await sketchOn(h, 'Late ring', 'origin:top', new Shapes().circle('c', [0, 0], 3));
      const latePath = await h.call('sweep_loft', { ...(row.inputs as Row), path: 'Late path' });
      expect(latePath).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'later_feature: path: Late path comes after Sweep 1 in the history: pick a sketch made before it.', detail: { reason: 'later_feature', field: 'path' } } });
      const lateRing = await h.call('sweep_loft', { ...(row.inputs as Row), profiles: ['Late ring'] });
      expect(reasonOf(lateRing)).toBe('later_feature');
      // Another kind: wrong_feature_type, saying which kind changes it.
      const wrong = await h.call('sweep_loft', LOFT({ edit: 'Sweep 1', profiles: ['Ring', 'Late ring'] }));
      expect(wrong).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'wrong_feature_type: edit: Sweep 1 is a sweep, not a loft: send kind sweep to change it.' } });
      // edit_feature has no value to set on it.
      const set = await h.call('edit_feature', { feature: 'Sweep 1', set: [{ field: 'distance', value: '1 mm' }], rename_to: '', suppress: 'keep', move: '' });
      expect(reasonOf(set)).toBe('bad_input');
      expect(messageOf(set)).toContain('Sweep 1 has no field "distance" (its fields: orientation, op)');
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses bad fields, paths and profiles before anything changes; a macro id takes its pieces',
    async () => {
      h = await assistantHarness();
      await pipeSketches(h);
      await h.ok('sweep_loft', SWEEP());
      // A small ring at (100, 0, 0) on Top, and a straight polyline p (two sides) up from it on Front.
      await sketchOn(h, 'Ring 2', 'origin:top', new Shapes().circle('o', [100, 0], 3));
      await sketchOn(h, 'Poly', 'origin:front', new Shapes().line('p__1', [100, 0], [100, 10]).line('p__2', [100, 10], [100, 20]).line('k', [130, 0], [130, 5]));
      const before = h.doc.state.get().doc;
      const label = undoLabel(h);
      const refused = async (input: Row) => {
        const r = await h!.call('sweep_loft', input);
        expect(r.ok, JSON.stringify(r)).toBe(false);
        return r;
      };
      // Every field problem in one message.
      const fields = await refused(SWEEP({ path: '', ruled: true, op: 'join', body_name: 'X', color: 'red' }));
      expect(messageOf(fields)).toBe('bad_input: path: the curves to sweep along, in another sketch ("<sketch>" or "<sketch>: l1, a2"); ruled: only a loft has flat sides; send false; body_name: only op new makes a body; send ""; color: only op new makes a body; send ""; color: "red" is not #rrggbb.');
      expect(reasonOf(await refused(SWEEP({ bodies: ['Body 1'] })))).toBe('bad_input');
      const taken = await refused(SWEEP({ body_name: 'body 1' }));
      expect(taken).toMatchObject({ ok: false, error: { message: 'name_taken: body_name: another body is already called Body 1.', detail: { reason: 'name_taken', field: 'body_name' } } });
      // The path's sketch and curves.
      const own = await refused(SWEEP({ path: 'Ring' }));
      expect(messageOf(own)).toBe('bad_input: path: Ring holds the profile: draw the path in another sketch.');
      const two = await refused(SWEEP({ profiles: ['Ring', 'Ring 2'] }));
      expect(messageOf(two)).toBe("bad_input: profiles: a sweep's profiles are regions of one sketch; these are in Ring and Ring 2.");
      const nope = await refused(SWEEP({ path: 'Nope: l1' }));
      expect(nope).toMatchObject({ ok: false, error: { detail: { reason: 'not_found', field: 'path', names: ['Ring', 'Path', 'Ring 2', 'Poly'] } } });
      expect(messageOf(nope)).toBe('not_found: path: no sketch is called "Nope". Sketches: Ring, Path, Ring 2, Poly.');
      const curve = await refused(SWEEP({ path: 'Path: l1, l9' }));
      expect(curve).toMatchObject({ ok: false, error: { message: 'not_found: path: Path has no curve l9. Its curves: l1, a2, l3.', detail: { reason: 'not_found', curves: ['l1', 'a2', 'l3'] } } });
      expect(messageOf(await refused(SWEEP({ path: 'Path l1' })))).toBe('bad_input: path: "Path l1" reads as the sketch Path, then "l1": write "<sketch>" (all its curves) or "<sketch>: l1, a2".');
      expect(messageOf(await refused(SWEEP({ path: 'Path: l1,' })))).toMatch(/^bad_input: path: name the curves after ":" separated by commas/);
      // A region selector that names no sketch, and a region the sketch does not have.
      expect(reasonOf(await refused(SWEEP({ profiles: ['r1'] })))).toBe('bad_selector');
      expect(reasonOf(await refused(SWEEP({ profiles: ['Ring r5'] })))).toBe('region_not_found');
      // Nothing changed.
      expect(h.doc.state.get().doc).toBe(before);
      expect(undoLabel(h)).toBe(label);
      expect(uiFor(h.services).state.get().panel).toBeNull();
      expect(h.doc.session()).toBeNull();
      // "Poly: p" is the polyline's two sides; "Poly: p.1" one of them (a quoted name reads too).
      const poly = await h.ok('sweep_loft', SWEEP({ profiles: ['Ring 2'], path: 'Poly: p' }));
      expect(poly.data).toMatchObject({ path: { sketch: 'Poly', curves: ['p.1', 'p.2'] } });
      expect(featureNamed<SweepFeature>(h, 'Sweep 2').path).toEqual({ sketch: featureNamed<SweepFeature>(h, 'Poly').id, entities: ['p__1', 'p__2'] });
      const one = await h.ok('sweep_loft', SWEEP({ profiles: ['Ring 2'], path: '"Poly": p.1' }));
      expect(one.data).toMatchObject({ path: { curves: ['p.1'] } });
      expect(rel(volumeOf(h, 'Body 3'), Math.PI * 9 * 10)).toBeLessThan(1e-4);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a path with a gap changes nothing and answers feature_failed with CAD\'s words',
    async () => {
      h = await assistantHarness();
      await pipeSketches(h);
      const before = h.doc.state.get().doc;
      const label = undoLabel(h);
      const r = await h.call('sweep_loft', SWEEP({ path: 'Path: l1, l3' }));
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Sweep 1', message: 'Sweep 1 failed: the path has a gap: its curves must join end to end in one chain' } },
      });
      expect(messageOf(r)).toBe('feature_failed: Sweep 1 fails: Sweep 1 failed: the path has a gap: its curves must join end to end in one chain');
      expect(h.doc.state.get().doc).toBe(before);
      expect(undoLabel(h)).toBe(label);
      expect(uiFor(h.services).state.get().panel).toBeNull();
      expect(h.doc.session()).toBeNull();
    },
    REAL_KERNEL_MS,
  );
});

describe('the body name and colour after the Done (between-opens)', () => {
  it(
    'a Stop there reverts synchronously: no sweep, no body, no panel, no step',
    async () => {
      h = await assistantHarness();
      await pipeSketches(h);
      const rt = runtimeOf(h.services)!;
      const before = h.doc.state.get().doc;
      rt.holds.hold('between-opens');
      const ctl = new AbortController();
      const r = h.call('sweep_loft', SWEEP({ body_name: 'Tube', color: '#3366cc' }), { signal: ctl.signal });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
      // The sweep is in the Part (its Done ran), its body not renamed yet.
      expect(names(h)).toEqual(['Ring', 'Path', 'Sweep 1']);
      const made = featureNamed<SweepFeature>(h, 'Sweep 1');
      expect(h.doc.state.get().doc.bodies[made.creates!]?.name).toBe('Body 1');
      ctl.abort();
      expect(h.doc.state.get().doc).toBe(before);
      expect(h.doc.assistant.current()).toBeNull();
      expect(uiFor(h.services).state.get().panel).toBeNull();
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'stopped' } } });
      expect(h.doc.state.get().doc).toBe(before);
      expect(rt.madeBy.size).toBe(0);
    },
    REAL_KERNEL_MS,
  );

  it(
    "a person's change there: busy changed, what stayed is listed, and the body keeps its name",
    async () => {
      h = await assistantHarness();
      await pipeSketches(h);
      const rt = runtimeOf(h.services)!;
      rt.holds.hold('between-opens');
      const r = h.call('sweep_loft', SWEEP({ body_name: 'Tube' }));
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
      h.doc.addParam({ name: 'q', expr: '1 mm', quantity: 'length' });
      rt.holds.release('between-opens');
      const out = await r;
      expect(out).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'changed', kept: expect.arrayContaining(['added parameter q = 1 mm']) } } });
      expect(JSON.stringify((out as { error: { detail: { kept: string[] } } }).error.detail.kept)).toContain('Sweep 1');
      expect(h.doc.state.get().doc.params.map((x) => x.name)).toContain('q');
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).not.toContain('Tube');
    },
    REAL_KERNEL_MS,
  );
});

describe('loft', () => {
  it(
    'a 20 mm square to a 10 mm square 30 mm up: the frustum, its labels, ruled, and its inputs round-trip',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      h.fake.emitTurn({ id: 't-test', title: 'A frustum' });
      await h.ok('sketch', SK({ name: 'Base sq', entities: [E('r', 'center_rect', [0, 0, 20, 20])] }));
      await h.ok('sketch', SK({ name: 'Top sq', on: 'Top offset 30 mm', entities: [E('q', 'center_rect', [0, 0, 10, 10])] }));
      const r = await h.ok('sweep_loft', LOFT());
      expect(r.data).toMatchObject({
        feature: { name: 'Loft 1', type: 'loft', state: 'ok' },
        kind: 'loft',
        profiles: [
          { sketch: 'Base sq', region: 'r1', area_mm2: 400, holes: 0 },
          { sketch: 'Top sq', region: 'r1', area_mm2: 100, holes: 0 },
        ],
        resolved: { ruled: 'false (smooth sides)', op: 'new body' },
        bodies: { created: [{ body: 'Body 1', solids: 1 }] },
        step: 3,
      });
      expect(r.data.path).toBeUndefined();
      expect(r.text).toMatch(/^Loft 1 ok: through Base sq r1, Top sq r1 · Body 1 made \(7000 mm³\)$/);
      expect(rel(volumeOf(h, 'Body 1'), (30 / 3) * (400 + 100 + 200))).toBeLessThan(1e-6);
      expect([...(r.data.created as string[])].sort()).toEqual(['Loft 1.end', 'Loft 1.side(r.bottom)', 'Loft 1.side(r.left)', 'Loft 1.side(r.right)', 'Loft 1.side(r.top)', 'Loft 1.start']);
      const top = ((await h.ok('find', { query: 'Loft 1.end', limit: 5 })).data.rows as Row[])[0];
      expect(top).toMatchObject({ type: 'plane', area_mm2: 100, normal: [0, 0, 1] });
      // get_model full: the loft as this tool's input, ready to send back; ruled true as an edit.
      const full = await h.ok('get_model', { detail: 'full', feature: 'Loft 1' });
      const row = full.data.feature as Row;
      expect(row.inputs).toMatchObject({ edit: 'Loft 1', kind: 'loft', profiles: [expect.stringMatching(/^Base sq at\(/), expect.stringMatching(/^Top sq at\(/)], path: '', ruled: false, op: 'new', bodies: [] });
      const stored = featureNamed<LoftFeature>(h, 'Loft 1');
      const ruled = await h.ok('sweep_loft', { ...(row.inputs as Row), ruled: true });
      expect(ruled.data).toMatchObject({ feature: { name: 'Loft 1', state: 'ok' }, resolved: { edit: 'Loft 1', ruled: 'true (flat sides)' } });
      expect(featureNamed<LoftFeature>(h, 'Loft 1')).toMatchObject({ id: stored.id, ruled: true, sections: stored.sections });
      // Straight edges between two squares: the same frustum.
      expect(rel(volumeOf(h, 'Body 1'), 7000)).toBeLessThan(1e-6);
      // The request's calls are one undo entry.
      expect(undoLabel(h)).toBe('Assistant: A frustum');
    },
    REAL_KERNEL_MS,
  );

  it(
    'needs two profiles, one region each, in different sketches; a profile with a hole fails with the kernel\'s words',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await h.ok('sketch', SK({ name: 'Base sq', entities: [E('r', 'center_rect', [0, 0, 20, 20])] }));
      await h.ok('sketch', SK({ name: 'Top sq', on: 'Top offset 30 mm', entities: [E('q', 'center_rect', [0, 0, 10, 10])] }));
      await h.ok('sketch', SK({ name: 'Pair', on: 'Top offset 60 mm', entities: [E('a', 'circle', [-20, 0, 3]), E('b', 'circle', [20, 0, 3])] }));
      await h.ok('sketch', SK({ name: 'Ring', on: 'Top offset 90 mm', entities: [E('o', 'circle', [0, 0, 10]), E('i', 'circle', [0, 0, 8])] }));
      const before = h.doc.state.get().doc;
      const one = await h.call('sweep_loft', LOFT({ profiles: ['Base sq'], path: 'Top sq' }));
      expect(messageOf(one)).toBe('bad_input: profiles: a loft takes two or more regions, one per sketch, in order; path: "" for a loft (it goes through its profiles; a path is a sweep\'s).');
      const twice = await h.call('sweep_loft', LOFT({ profiles: ['Base sq', 'Top sq', 'Base sq at(0, 0)'] }));
      expect(twice).toMatchObject({ ok: false, error: { message: 'bad_input: profiles: a loft takes one region per sketch; Base sq is in profiles[0] and profiles[2].', detail: { field: 'profiles[2]' } } });
      const several = await h.call('sweep_loft', LOFT({ profiles: ['Base sq', 'Pair'] }));
      expect(several).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input', field: 'profiles[1]', regions: [{ id: 'r1' }, { id: 'r2' }] } } });
      expect(messageOf(several)).toBe('bad_input: profiles[1]: "Pair" names 2 regions of Pair (r1, r2): a loft takes one region per sketch; name one ("Pair r1" or "Pair at(u, v)").');
      expect(h.doc.state.get().doc).toBe(before);
      // A ring has a hole: the kernel refuses it, and nothing changes.
      const holed = await h.call('sweep_loft', LOFT({ profiles: ['Top sq', 'Ring'] }));
      expect(holed).toMatchObject({ ok: false, error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Loft 1' } } });
      expect(messageOf(holed)).toMatch(/^feature_failed: Loft 1 fails: Loft 1 failed: .*hole/);
      expect(h.doc.state.get().doc).toBe(before);
      expect(uiFor(h.services).state.get().panel).toBeNull();
      // One region of the pair is a loft section.
      const ok = await h.ok('sweep_loft', LOFT({ profiles: ['Top sq', 'Pair r1'], ruled: true }));
      expect(ok.data).toMatchObject({ feature: { name: 'Loft 1', state: 'ok' }, profiles: [{ sketch: 'Top sq' }, { sketch: 'Pair', region: 'r1' }] });
    },
    REAL_KERNEL_MS,
  );
});
