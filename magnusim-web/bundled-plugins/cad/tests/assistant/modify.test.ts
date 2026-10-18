// modify on the REAL kernel, through the page's tool handler (CAD tools spec §3.2.11, §5.4, §7.4,
// §7.7, §12.1 "resolve and real-kernel cases"), on a 60 x 40 x 6 plate (Body 1, sketch lines
// e_1 to e_4: bottom, right, top, left):
//   - a fillet of a face keeps the face (every edge of it, a live set); one of an edge between two
//     faces keeps that edge (a fixed set), its volume as the formula says; "edges of <face>" with a
//     filter is a fixed set of edges;
//   - a fillet too large for its wall changes nothing (no feature, no undo entry, no panel) and
//     answers feature_failed with CAD's own words (the edges, and the largest radius that works);
//   - targets on two bodies, a body or a region as a target, a size2 on a fillet and a bad size
//     are refused before anything changes;
//   - a chamfer of two distances; a shell that keeps the outer size (the cavity's volume);
//   - one undo entry per call; get_model shows the feature as made by the Assistant and its
//     inputs as this tool's input, which sent back with edit replaces it; edit_feature sets size;
//     an edit of another kind is wrong_feature_type, and an edit's targets are read on the bodies
//     before the feature;
//   - the round trip names the same faces and edges: a face of a mirror copy (a label every face
//     of the copy shares) by its ~k, and a fillet face numbered on the bodies before the feature
//     that uses it (a later cut that removes another fillet face does not shift it).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { uiFor } from '../../src/ui/controller';
import type { ChamferFeature, FilletFeature, RegionRef, ShellFeature } from '../../src/types/doc';
import type { SketchOutput } from '../../src/types/sketch';
import { assistantHarness, REAL_KERNEL_MS, rectangle, type AssistantHarness } from './harness';
import { extrude, plate, regions, Shapes, sketchOn, undoLabel } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const MODIFY = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'fillet', targets: [], size: '', size2: '', flip: false, inward: false, ...o });
const EDIT = (feature: string, o: Record<string, unknown> = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });
const volume = (x: AssistantHarness, name = 'Body 1') => x.doc.state.get().rebuild.bodies.find((b) => b.name === name)!.volume!;
const featureNamed = <T>(x: AssistantHarness, name: string) => x.doc.state.get().doc.features.find((f) => f.name === name) as unknown as T;
/** What one rounded edge of length L takes away: the corner square minus the quarter circle. */
const filletLoss = (r: number, l: number) => (1 - Math.PI / 4) * r * r * l;

describe('modify fillet', () => {
  it(
    'keeps an edge as a fixed set and a face as a live set; one undo entry for the request',
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-test', title: 'Round the plate' });
      await plate(h);
      const v0 = volume(h);
      // One edge between the top face and the side swept from e_1 (y = -20, 60 mm long).
      const one = await h.ok('modify', MODIFY({ targets: ['Extrude 1.end & Extrude 1.side(e_1)'], size: '2 mm' }));
      expect(one.data).toMatchObject({
        feature: { name: 'Fillet 1', type: 'fillet', state: 'ok' },
        kept_as: '1 edge (a fixed set)',
        body: 'Body 1',
        edges: { picked: 1, rounded: 1 },
        created: ['Fillet 1.fillet(1)'],
        step: 1,
        resolved: { targets: expect.stringMatching(/^Extrude 1\.end & Extrude 1\.side\(e_1\) -> /), body: 'Body 1' },
      });
      expect(one.text).toMatch(/^Fillet 1 ok: 1 edge \(a fixed set\) on Body 1 · Body 1 14400 → 1434\d mm³$/);
      const f1 = featureNamed<FilletFeature>(h, 'Fillet 1');
      expect(f1).toMatchObject({ body: expect.any(String), faces: [], radius: '2 mm' });
      expect(f1.edges.map((e) => e.name)).toHaveLength(1);
      expect(volume(h)).toBeCloseTo(v0 - filletLoss(2, 60), 3);
      expect(undoLabel(h)).toBe('Assistant: Round the plate');
      // A face: every edge of it, kept as the face.
      const face = await h.ok('modify', MODIFY({ targets: ['Extrude 1.start'], size: '1 mm' }));
      expect(face.data).toMatchObject({ feature: { name: 'Fillet 2' }, kept_as: '1 face (every edge of each, a live set)', edges: { picked: 4 } });
      const f2 = featureNamed<FilletFeature>(h, 'Fillet 2');
      expect(f2.faces.map((r) => r.name)).toEqual([expect.stringMatching(/:start$/)]);
      expect(f2.edges).toEqual([]);
      // Two calls of one request: one undo entry, and Undo takes both away.
      h.fake.emitTurn({ id: 't-test', title: 'Round the plate', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(h.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Sketch 1', 'Extrude 1']);
    },
    REAL_KERNEL_MS,
  );

  it(
    '"edges of <face>" with a filter is a fixed set of those edges',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const filtered = await h.ok('modify', MODIFY({ targets: ['edges of Extrude 1.side(e_2) |Z'], size: '1 mm' }));
      expect(filtered.data).toMatchObject({ kept_as: '2 edges (a fixed set)', resolved: { targets: expect.stringMatching(/2 edges \(lines\), fixed set$/) } });
      expect(featureNamed<FilletFeature>(h, 'Fillet 1').faces).toEqual([]);
      expect(featureNamed<FilletFeature>(h, 'Fillet 1').edges).toHaveLength(2);
      // Two vertical edges, 6 mm long each.
      expect(volume(h)).toBeCloseTo(14400 - 2 * filletLoss(1, 6), 3);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a radius too large for the wall changes nothing and answers feature_failed with CAD\'s words',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const before = h.doc.state.get().doc;
      const label = undoLabel(h);
      const r = await h.call('modify', MODIFY({ targets: ['Extrude 1.end'], size: '20 mm' }));
      expect(r).toMatchObject({
        ok: false,
        error: {
          code: 'failed',
          hint: 'Read detail.message and detail.sub, change the inputs and call again.',
          detail: { reason: 'feature_failed', feature: 'Fillet 1', message: expect.stringMatching(/^Fillet 1 failed: a radius of 20 mm is too large for .+: \d+(\.\d+)? mm or less works$/) },
        },
      });
      expect((r as { error: { message: string } }).error.message).toMatch(/^feature_failed: Fillet 1 fails: Fillet 1 failed: a radius of 20 mm is too large/);
      // Nothing changed: no feature, no undo entry, no panel left open.
      expect(h.doc.state.get().doc).toBe(before);
      expect(undoLabel(h)).toBe(label);
      expect(uiFor(h.services).state.get().panel).toBeNull();
      expect(h.doc.session()).toBeNull();
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses targets on two bodies, a body, a region, a size2 and a bad size before anything changes',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const s = new Shapes().rect('k', 40, -5, 50, 5);
      const sk = await sketchOn(h, 'Block sketch', 'origin:top', s);
      await extrude(h, 'Block', regions(h, sk), { distance: '3 mm' });
      const before = h.doc.state.get().doc;
      const two = await h.call('modify', MODIFY({ targets: ['Extrude 1.end', 'Block.end'], size: '1 mm' }));
      expect(two).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'bad_selector: targets are on Body 1 and Body 2: one body per call.', detail: { reason: 'bad_selector', bodies: ['Body 1', 'Body 2'] } } });
      const body = await h.call('modify', MODIFY({ targets: ['Body 1'], size: '1 mm' }));
      expect(body).toMatchObject({ ok: false, error: { detail: { reason: 'bad_selector', field: 'targets[0]' } } });
      expect((body as { error: { message: string } }).error.message).toContain('names a body: a fillet takes faces (every edge of each) or edges');
      const region = await h.call('modify', MODIFY({ targets: ['Block sketch r1'], size: '1 mm' }));
      expect(region).toMatchObject({ ok: false, error: { detail: { reason: 'bad_selector' } } });
      const fields = await h.call('modify', MODIFY({ targets: [], size: '', size2: '2 mm' }));
      expect(fields).toMatchObject({ ok: false, error: { code: 'invalid_input', detail: { reason: 'bad_input' } } });
      expect((fields as { error: { message: string } }).error.message).toBe('bad_input: targets: at least one face or edge; size: the radius ("2 mm", "r"); size2: only a chamfer has a second distance; send "".');
      const expr = await h.call('modify', MODIFY({ targets: ['Extrude 1.end'], size: 'rr' }));
      expect(expr).toMatchObject({ ok: false, error: { detail: { reason: 'expr_error', field: 'size' } } });
      const nothing = await h.call('modify', MODIFY({ targets: ['Extrude 1.nope'], size: '1 mm' }));
      expect(nothing).toMatchObject({ ok: false, error: { detail: { reason: 'unknown_role' } } });
      expect(h.doc.state.get().doc).toBe(before);
      void p;
    },
    REAL_KERNEL_MS,
  );
});

describe('modify chamfer and shell', () => {
  it(
    'chamfers with two distances, and shells keeping the outer size',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const c = await h.ok('modify', MODIFY({ kind: 'chamfer', targets: ['Extrude 1.end & Extrude 1.side(e_3)'], size: '1 mm', size2: '2 mm', flip: true }));
      expect(c.data).toMatchObject({ feature: { name: 'Chamfer 1', type: 'chamfer', state: 'ok' }, kept_as: '1 edge (a fixed set)', resolved: { size: '1 mm, 2 mm' } });
      expect(featureNamed<ChamferFeature>(h, 'Chamfer 1')).toMatchObject({ mode: 'two', distance: '1 mm', distance2: '2 mm', flip: true });
      // A triangle 1 x 2 along 60 mm.
      expect(volume(h)).toBeCloseTo(14400 - 60, 3);
      const sh = await h.ok('modify', MODIFY({ kind: 'shell', targets: ['Extrude 1.start'], size: '1 mm', inward: true }));
      expect(sh.data).toMatchObject({ feature: { name: 'Shell 1', type: 'shell', state: 'ok' }, kept_as: '1 face to open' });
      expect(featureNamed<ShellFeature>(h, 'Shell 1')).toMatchObject({ thickness: '1 mm', direction: 'inside' });
      expect((sh.data.created as string[]).length).toBeGreaterThan(3);
      expect((sh.data.created as string[]).every((l) => l.startsWith('Shell 1.inner('))).toBe(true);
      // The outer size stays (the bounding box), the volume falls.
      const b = h.doc.state.get().rebuild.bodies[0];
      expect(b.bbox.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([-30, -20, 0, 30, 20, 6]);
      expect(volume(h)).toBeLessThan(14400 - 60 - 9000);
    },
    REAL_KERNEL_MS,
  );
});

/** What find gives for a selector: each row's label and centre. */
async function found(x: AssistantHarness, query: string): Promise<{ label: string | null; center_mm: number[] }[]> {
  const r = await x.ok('find', { query, limit: 20 });
  return (r.data.rows as { label?: string; center_mm: number[] }[]).map((w) => ({ label: w.label ?? null, center_mm: w.center_mm }));
}

describe('modify edits and the round trip', () => {
  it(
    'a face of a mirror copy comes back by its ~k, and resent it is still that one face',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const PATTERN = { edit: '', name: '', kind: 'mirror', of: 'bodies', items: ['Body 1'], about: 'Right offset 40 mm', count: '', spacing: '', symmetric: false, flip: false, about2: '', count2: '', spacing2: '', flip2: false, op: 'new', bodies: [] };
      await h.ok('pattern', PATTERN);
      const [top] = await found(h, '"Body 1 (Mirror copy)" faces >Z');
      expect(top.label).toMatch(/^Mirror 1\.mirror~\d+$/);
      const one = await h.ok('modify', MODIFY({ targets: [`edges of ${top.label}`], size: '1 mm' }));
      expect(one.text).toMatch(/^Fillet 1 ok: 1 face \(every edge of each, a live set\)/);
      const v = volume(h, 'Body 1 (Mirror copy)');
      const full = await h.ok('get_model', { detail: 'full', feature: 'Fillet 1' });
      const inputs = (full.data.feature as Record<string, unknown>).inputs as Record<string, unknown>;
      expect(inputs.targets).toEqual([`edges of ${top.label}`]);
      const again = await h.ok('modify', inputs);
      expect(again.text).toMatch(/^Fillet 1 ok \(replaced\): 1 face /);
      expect(volume(h, 'Body 1 (Mirror copy)')).toBeCloseTo(v, 6);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a fillet face is numbered on the bodies before the feature that uses it: a later cut that removes another does not move the chamfer',
    async () => {
      h = await assistantHarness();
      await plate(h);
      await h.ok('modify', MODIFY({ targets: ['Body 1 edges |Z'], size: '1 mm' }));
      const before = await found(h, 'Fillet 1.fillet');
      expect(before).toHaveLength(4);
      await h.ok('modify', MODIFY({ kind: 'chamfer', targets: ['Fillet 1.fillet(3) & Extrude 1.end'], size: '0.5 mm' }));
      const edgeAt = () => featureNamed<ChamferFeature>(h!, 'Chamfer 1').edges.map((e) => e.signature.at.map((c) => Math.round(c * 100) / 100));
      const was = edgeAt();
      // A cut through the corner of Fillet 1.fillet(1): that face is gone at the end of the history.
      const [first] = await found(h, 'Fillet 1.fillet(1)');
      const [cx, cy] = first.center_mm;
      const rect = rectangle(6, 6, cx - 3, cy - 3);
      const sk = await h.add('sketch', { points: rect.points, entities: rect.entities });
      const out = h.doc.state.get().rebuild.outputs[sk] as SketchOutput;
      const r = out.regions[0];
      const profile: RegionRef = { sketch: sk, region: r.key, entities: [...r.entities].sort(), sample: r.sample };
      await h.add('extrude', { profiles: [profile], extent: { kind: 'through_all', both: true, distance: '10 mm' }, op: 'cut', creates: null, scope: [] });
      expect(await found(h, 'Fillet 1.fillet')).toHaveLength(3);
      const full = await h.ok('get_model', { detail: 'full', feature: 'Chamfer 1' });
      const inputs = (full.data.feature as Record<string, unknown>).inputs as Record<string, unknown>;
      // The pair's order follows the stored names (their feature ids).
      expect((inputs.targets as string[]).map((t) => t.split(' & ').sort())).toEqual([['Extrude 1.end', 'Fillet 1.fillet(3)']]);
      const again = await h.ok('modify', inputs);
      expect(again.text).toMatch(/^Chamfer 1 ok \(replaced\): 1 edge/);
      expect(edgeAt()).toEqual(was);
    },
    REAL_KERNEL_MS,
  );

  it(
    'get_model full writes the inputs as modify input; sent back with edit they replace it; edit_feature sets size',
    async () => {
      h = await assistantHarness();
      await plate(h);
      await h.ok('modify', MODIFY({ targets: ['Extrude 1.end'], size: '2 mm' }));
      const full = await h.ok('get_model', { detail: 'full', feature: '' });
      const row = (full.data.features as Record<string, unknown>[]).find((f) => f.name === 'Fillet 1')!;
      expect(row).toMatchObject({
        by: 'assistant',
        inputs: { edit: 'Fillet 1', name: '', kind: 'fillet', targets: ['edges of Extrude 1.end'], size: '2 mm', size2: '', flip: false, inward: false },
        values: [{ field: 'size', expr: '2 mm' }],
      });
      const stored = featureNamed<FilletFeature>(h, 'Fillet 1');
      // Sent back as it is: the same feature, replaced in place.
      const again = await h.ok('modify', row.inputs as Record<string, unknown>);
      expect(again.text).toMatch(/^Fillet 1 ok \(replaced\)/);
      const now = featureNamed<FilletFeature>(h, 'Fillet 1');
      expect(now.id).toBe(stored.id);
      expect(now.faces.map((r) => r.name)).toEqual(stored.faces.map((r) => r.name));
      // edit_feature by the tool's field name (and the feature's own path still works).
      await h.ok('edit_feature', EDIT('Fillet 1', { set: [{ field: 'size', value: '1.5 mm' }] }));
      expect(featureNamed<FilletFeature>(h, 'Fillet 1').radius).toBe('1.5 mm');
      await h.ok('edit_feature', EDIT('Fillet 1', { set: [{ field: 'radius', value: '1 mm' }] }));
      expect(featureNamed<FilletFeature>(h, 'Fillet 1').radius).toBe('1 mm');
      // Another kind: wrong_feature_type, saying which kind changes it.
      const wrong = await h.call('modify', { ...(row.inputs as Record<string, unknown>), kind: 'chamfer' });
      expect(wrong).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'wrong_feature_type: edit: Fillet 1 is a fillet, not a chamfer: send kind fillet to change it.', detail: { reason: 'wrong_feature_type' } } });
      // An edit reads its targets on the bodies before the feature: its own faces are not there.
      const own = await h.call('modify', MODIFY({ edit: 'Fillet 1', targets: ['Fillet 1.fillet(1)'], size: '1 mm' }));
      expect(own).toMatchObject({ ok: false, error: { detail: { reason: 'nothing_selected' } } });
      // A name another feature has.
      const taken = await h.call('modify', MODIFY({ name: 'extrude 1', targets: ['Extrude 1.end'], size: '1 mm' }));
      expect(taken).toMatchObject({ ok: false, error: { detail: { reason: 'name_taken', field: 'name' } } });
      // A name of its own.
      const named = await h.ok('modify', MODIFY({ name: 'Round', kind: 'chamfer', targets: ['Extrude 1.start & Extrude 1.side(e_1)'], size: '0.5 mm' }));
      expect(named.data).toMatchObject({ feature: { name: 'Round', type: 'chamfer' } });
    },
    REAL_KERNEL_MS,
  );
});
