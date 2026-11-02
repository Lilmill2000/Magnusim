// Fillets and drilled holes found by their shape (S4), on the REAL kernel, on a block written to
// STEP in the test and imported as the person imports one (tests/assistant/rounded-block.ts: R5
// verticals, R2 round the top, four 6 mm holes and a 6/10 mm counterbore):
//   - fillet, fillet 2 mm (equal within max(0.001 mm, 1 %)), fillet <= 2 mm (largest radius),
//     fillet >= 5 mm (smallest); hole 6 mm, hole <= 6 mm, hole >= 10 mm as whole drilled holes
//     (the counterbore is 6 to 10 mm); <= and >= within 0.001 mm only (hole <= 5.95 mm takes no
//     6 mm bore, review 2026-11-02); radius <= and >=; plain hole stays per face;
//   - the find tool's rows (fillet_mm, hole_mm, through), data.holes and its text "(4 holes)" (the
//     person's Find gives the same: person-parity.test.ts);
//   - a query that matches nothing says what the body has ("Body 1 has 12 fillet faces, R2 to R5");
//   - a body over the face limit (lowered as the e2e does) is refused before any kernel call;
//     several bodies, one a surface body, are refused as a whole with that body's words; a bare
//     "fillet <= 2 mm" gets the put-the-scope-first words; Body 1 edges fillet gets its words;
//   - the Assistant's direct delete_faces with "Body 1 faces fillet <= 2 mm" stores the same
//     faces the person's Find then Select all then Delete faces does, ok at the sharp volume.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { applyFilters, selectAny, withScene, type FaceHit, type Scene } from '../../src/assistant/selectors/resolve';
import { parseSelector, type Sel } from '../../src/assistant/selectors/parse';
import { runFind } from '../../src/features/find/panel';
import { runDeleteFaces } from '../../src/features/delete_faces';
import { addBySize } from '../../src/features/delete_faces/by-size';
import { forgetBreps } from '../../src/features/import/feature';
import { recognitionOf } from '../../src/kernel/recognition';
import type { DeleteFacesFeature } from '../../src/types/doc';
import { uiFor } from '../../src/ui/controller';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { importRoundedBlock, ROUNDED_BLOCK } from './rounded-block';

type Row = Record<string, unknown>;

let h: AssistantHarness | null = null;
afterEach(() => {
  if (h) recognitionOf(h.services.kernel).limits.maxFaces = 2000;
  h?.dispose();
  h = null;
  forgetBreps();
});

const call = (x: AssistantHarness) => ({ services: x.services, key: 'turn:t-shape', signal: new AbortController().signal, progress: () => {} });
const scene = <T>(x: AssistantHarness, fn: (sc: Scene) => Promise<T>) => withScene(call(x), {}, fn);
const count = (x: AssistantHarness, q: string) => scene(x, async (sc) => (await selectAny(sc, q)).hits.length);
const radii = (x: AssistantHarness, q: string) => scene(x, async (sc) => (await selectAny(sc, q)).hits.map((hh) => (hh as FaceHit).recognized?.fillet?.r_max).sort());
const fail = async (x: AssistantHarness, tool: string, input: Row): Promise<{ message: string; hint?: string; detail: Row }> => {
  const r = await x.call(tool, input);
  if (r.ok) throw new Error(`${tool} answered ok`);
  return r.error as unknown as { message: string; hint?: string; detail: Row };
};

describe('fillet and sized hole selectors on an imported STEP part (real kernel)', () => {
  it(
    'fillet and its sizes, sized holes as whole holes, radius <= and >=; plain hole as before',
    async () => {
      h = await assistantHarness({ solver: false });
      await importRoundedBlock(h);
      const body = h.doc.state.get().rebuild.bodies[0];
      expect(h.doc.state.get().doc.bodies[body.id]?.name ?? body.name).toBe('Body 1');
      expect(body.faces).toBe(ROUNDED_BLOCK.faces);
      // Fillets: 8 R2 round the top, 4 R5 verticals; sizes by the fillet's own radius.
      expect(await count(h, 'Body 1 faces fillet')).toBe(12);
      expect(await radii(h, 'Body 1 faces fillet <= 2 mm')).toEqual(Array(8).fill(2));
      expect(await count(h, 'Body 1 faces fillet 2 mm')).toBe(8);
      // Equal within 1 %: 2.01 reads the R2s, 2.05 none.
      expect(await count(h, 'Body 1 faces fillet 2.01 mm')).toBe(8);
      expect(await count(h, 'Body 1 faces fillet 2.05 mm')).toBe(0);
      expect(await count(h, 'Body 1 faces fillet >= 5 mm')).toBe(4);
      expect(await count(h, 'Body 1 faces fillet 5 mm')).toBe(4);
      expect(await count(h, 'Body 1 faces fillet >= 2 mm')).toBe(12);
      expect(await count(h, 'all faces fillet <= 5 mm')).toBe(12);
      // Filters after it narrow the set: the R2s on the top's level.
      expect(await count(h, 'Body 1 faces fillet <= 2 mm %cylinder')).toBe(4);
      expect(await count(h, 'Body 1 faces fillet %torus')).toBe(4);
      // Holes: the four 6 mm holes (one face each), the counterbore (6 to 10 mm: wall, floor, wall).
      expect(await count(h, 'Body 1 faces hole <= 6 mm')).toBe(4);
      expect(await count(h, 'Body 1 faces hole 6 mm')).toBe(4);
      expect(await count(h, 'Body 1 faces hole <= 10 mm')).toBe(7);
      expect(await count(h, 'Body 1 faces hole >= 10 mm')).toBe(0);
      expect(await count(h, 'Body 1 faces hole >= 6 mm')).toBe(7);
      // <= and >= get 0.001 mm, not the plain size's 1 % (they took the 6 mm holes, the R2s and the R5s).
      expect(await count(h, 'Body 1 faces hole <= 5.95 mm')).toBe(0);
      expect(await count(h, 'Body 1 faces hole <= 5.9995 mm')).toBe(4);
      expect(await count(h, 'Body 1 faces fillet <= 1.99 mm')).toBe(0);
      expect(await count(h, 'Body 1 faces fillet >= 2.01 mm')).toBe(4);
      expect(await count(h, 'Body 1 faces fillet >= 5.04 mm')).toBe(0);
      expect(await count(h, 'Body 1 faces hole >= 6.05 mm')).toBe(0);
      // Plain hole is still per face (a round face going at least half way round, inward).
      expect(await count(h, 'Body 1 faces hole')).toBe(6);
      // radius <= / >= on the face's own radius (topo).
      expect(await count(h, 'Body 1 faces radius <= 2 mm')).toBe(4);
      expect(await count(h, 'Body 1 faces radius >= 5 mm %cylinder')).toBe(5);
      expect(await count(h, 'Body 1 faces radius 3 mm %cylinder')).toBe(5);
    },
    REAL_KERNEL_MS,
  );

  it(
    "the find tool's rows, holes and text; a no-match says what the body has",
    async () => {
      h = await assistantHarness({ solver: false });
      await importRoundedBlock(h);
      const fl = await h.ok('find', { query: 'Body 1 faces fillet <= 2 mm', limit: 25 });
      expect(fl.data).toMatchObject({ count: 8, kind: 'face', more: 0 });
      expect(fl.data).not.toHaveProperty('holes');
      const rows = fl.data.rows as Row[];
      expect(rows.map((r) => r.fillet_mm)).toEqual(Array(8).fill(2));
      expect(rows.every((r) => !('hole_mm' in r) && !('through' in r))).toBe(true);
      expect(fl.text).toBe('find "Body 1 faces fillet <= 2 mm": 8 faces');
      // Every fillet: the R5s too, each its own radius.
      const all = await h.ok('find', { query: 'Body 1 faces fillet', limit: 25 });
      expect((all.data.rows as Row[]).map((r) => r.fillet_mm).sort()).toEqual([...Array(8).fill(2), ...Array(4).fill(5)]);
      // Sized holes: each face with its hole's bore and through, and the number of holes.
      const ho = await h.ok('find', { query: 'Body 1 faces hole <= 6 mm', limit: 25 });
      expect(ho.data).toMatchObject({ count: 4, holes: 4 });
      expect((ho.data.rows as Row[]).map((r) => [r.hole_mm, r.through])).toEqual(Array(4).fill([6, true]));
      expect(ho.text).toBe('find "Body 1 faces hole <= 6 mm": 4 faces (4 holes)');
      const cb = await h.ok('find', { query: 'Body 1 faces hole <= 10 mm', limit: 25 });
      expect(cb.data).toMatchObject({ count: 7, holes: 5 });
      expect((cb.data.rows as Row[]).filter((r) => Array.isArray(r.hole_mm)).map((r) => r.hole_mm)).toEqual(Array(3).fill([6, 10]));
      // Edges of sized holes: no hole count (the edges carry none; it said "(0 holes)"), in the tool and the Find panel, and no hint about lit faces.
      const he = await h.ok('find', { query: 'edges of (Body 1 faces hole <= 6 mm)', limit: 25 });
      expect(he.data).toMatchObject({ count: 12, kind: 'edge' });
      expect(he.data).not.toHaveProperty('holes');
      expect(he.text).toBe('find "edges of (Body 1 faces hole <= 6 mm)": 12 edges');
      const panelEdges = await runFind(h.services, 'edges of (Body 1 faces hole <= 6 mm)');
      expect(panelEdges).toMatchObject({ count: 12, kind: 'edge', holes: null, shape: false, nothing: null });
      // Faces of them keep both.
      expect(await runFind(h.services, 'Body 1 faces hole <= 6 mm')).toMatchObject({ count: 4, holes: 4, shape: true });
      // Queries without them keep their rows: no fillet_mm, no holes.
      const plain = await h.ok('find', { query: 'Body 1 faces hole', limit: 25 });
      expect(plain.data).not.toHaveProperty('holes');
      expect((plain.data.rows as Row[]).some((r) => 'fillet_mm' in r || 'hole_mm' in r)).toBe(false);

      // No match: the words say what the body has, in the message and in detail.
      const none = await fail(h, 'find', { query: 'Body 1 faces fillet <= 1 mm', limit: 10 });
      expect(none.message).toBe('nothing_selected: "Body 1 faces fillet <= 1 mm" matches nothing: Body 1 has 12 fillet faces, R2 to R5.');
      expect(none.detail.recognized).toEqual([{ body: 'Body 1', fillets: { faces: 12, r_min: 2, r_max: 5 } }]);
      const noHole = await fail(h, 'find', { query: 'Body 1 faces hole >= 10 mm', limit: 10 });
      expect(noHole.message).toBe('nothing_selected: "Body 1 faces hole >= 10 mm" matches nothing: Body 1 has 5 drilled holes, Ø6 to Ø10.');
      expect(noHole.detail.recognized).toEqual([{ body: 'Body 1', holes: { count: 5, d_min: 6, d_max: 10, unsized: 0 } }]);
      // A plain query that matches nothing: as before (no recognition words).
      const plainNone = await fail(h, 'find', { query: 'Body 1 faces %sphere', limit: 10 });
      expect(plainNone.message).toBe('nothing_selected: "Body 1 faces %sphere" matches nothing.');
      expect(plainNone.detail).not.toHaveProperty('recognized');
    },
    REAL_KERNEL_MS,
  );

  it(
    "on a Part in inches, a no-match says the sizes in inches, as Delete faces' Add line does (review 2026-11-02: it gave mm numbers with no unit)",
    async () => {
      h = await assistantHarness({ solver: false, units: 'imperial' });
      await importRoundedBlock(h);
      expect(h.doc.state.get().doc.units.length).toBe('in');
      const fillets = 'Body 1 has 12 fillet faces, R0.07874 to R0.1969 in';
      const holes = 'Body 1 has 5 drilled holes, Ø0.2362 to Ø0.3937 in';
      // The find tool and the Find panel.
      expect((await fail(h, 'find', { query: 'Body 1 faces fillet <= 1 mm', limit: 10 })).message).toBe(`nothing_selected: "Body 1 faces fillet <= 1 mm" matches nothing: ${fillets}.`);
      expect((await runFind(h.services, 'Body 1 faces fillet <= 1 mm')).nothing).toBe(`"Body 1 faces fillet <= 1 mm" matches nothing: ${fillets}.`);
      expect((await runFind(h.services, 'Body 1 faces hole <= 1 mm')).nothing).toBe(`"Body 1 faces hole <= 1 mm" matches nothing: ${holes}.`);
      // Delete faces' Add by size on the same Part says the same.
      const s = h.doc.beginNew('delete_faces');
      try {
        expect(await addBySize(h.services, { feature: s.feature, body: '', kind: 'fillets', size: 1, picked: [] })).toEqual({ ok: false, words: `No fillets up to 0.03937 in on Body 1 that are not already picked (${fillets})` });
      } finally {
        s.discard();
      }
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses in words: a body over the face limit (no kernel call), a surface body among several, edges, and a filter with no scope',
    async () => {
      h = await assistantHarness({ solver: false });
      await importRoundedBlock(h, { body2: true });
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
      // Both bodies searched: Body 2 has none.
      expect(await count(h, 'all faces fillet')).toBe(12);
      const client = recognitionOf(h.services.kernel);
      // Over the limit (the e2e lowers it the same way): refused before any kernel call, never an empty list.
      client.limits.maxFaces = 10;
      const before = client.calls;
      const big = await fail(h, 'find', { query: 'Body 1 faces fillet <= 2 mm', limit: 10 });
      expect(big.message).toBe(`bad_selector: Body 1 has ${ROUNDED_BLOCK.faces} faces: fillets and holes are found on bodies of up to 10 faces.`);
      expect(big.hint).toBe('Select its faces in the view instead.');
      expect(big.detail).toMatchObject({ reason: 'bad_selector', body: 'Body 1', why: 'too_large', faces: ROUNDED_BLOCK.faces, limit: 10 });
      // The whole query is refused for the one body that cannot be searched (Body 2 has 6 faces).
      const many = await fail(h, 'find', { query: 'all faces hole <= 6 mm', limit: 10 });
      expect(many.message).toMatch(/^bad_selector: Body 1 has 25 faces: fillets and holes are found on bodies of up to 10 faces\.$/);
      expect(client.calls).toBe(before);
      client.limits.maxFaces = 2000;
      // A surface body among the scope's bodies: the whole query is refused with its words.
      const surface = await scene(h, async (sc) => {
        const bodies = sc.bodies.map((b) => (b.name === 'Body 2' ? { ...b, solids: 0 } : b));
        const s2 = { ...sc, bodies } as Scene;
        const sel = parseSelector('all faces fillet', sc.known, 'face') as Extract<Sel, { t: 'query' }>;
        const hits: FaceHit[] = [];
        for (const [bi, b] of bodies.entries()) {
          const t = await sc.cache.topo(b.shape, { faces: b.faces });
          for (const f of t.faces) hits.push({ kind: 'face', bi, body: b, index: f.i, topo: f, name: null, warnings: [] });
        }
        return applyFilters(s2, hits, sel.filters).then(
          () => null,
          (e: Error & { hint?: string }) => ({ message: e.message, hint: e.hint }),
        );
      });
      expect(surface).toEqual({ message: 'bad_selector: Body 2 is a surface body: fillets and holes are found on solids only.', hint: 'Select its faces in the view instead.' });
      // Edges: fillet filters faces.
      const edges = await fail(h, 'find', { query: 'Body 1 edges fillet', limit: 10 });
      expect(edges.message).toMatch(/^bad_selector: query: fillet filters faces: Body 1 faces fillet <= 2 mm \(column 14 of "Body 1 edges fillet"\)/);
      // No scope: put it first.
      const bare = await fail(h, 'find', { query: 'fillet <= 2 mm', limit: 10 });
      expect(bare.message).toContain('a filter goes after its scope, as in "Body 1 faces fillet <= 2 mm"');
      expect(bare.hint).toBe('Put the body (or "all") and the kind first: "Body 1 faces fillet <= 2 mm"; find lists what it names.');
      // A bare < after fillet.
      const lt = await fail(h, 'find', { query: 'Body 1 faces fillet < 2 mm', limit: 10 });
      expect(lt.message).toContain('write <= or >= after fillet (<Z and >Z are levels): fillet <= 2 mm');
    },
    REAL_KERNEL_MS,
  );

  it(
    "the Assistant's delete_faces with Body 1 faces fillet <= 2 mm stores what the person's Find, Select all and Delete faces store: ok, the sharp volume",
    async () => {
      h = await assistantHarness({ solver: false });
      const { sharp } = await importRoundedBlock(h);
      // The person: Find, Select all, Delete faces (the panel opens on the selection), Done.
      const found = await runFind(h.services, 'Body 1 faces fillet <= 2 mm');
      expect(found.count).toBe(8);
      h.services.selection.set((s) => ({ ...s, items: [...found.items] }));
      await runDeleteFaces(h.services);
      const ui = uiFor(h.services);
      await h.settle();
      ui.closePanel();
      await h.settle();
      const person = h.doc.state.get();
      const del = person.doc.features.find((f) => f.type === 'delete_faces') as DeleteFacesFeature;
      expect(del?.name).toBe('Delete faces 1');
      expect(person.rebuild.features[del.id]).toMatchObject({ state: 'ok' });
      expect(person.rebuild.bodies[0].volume).toBeCloseTo(sharp, 3);
      const personFaces = del.faces.map((f) => f.name).sort();
      expect(personFaces).toHaveLength(8);
      h.doc.undo();
      await h.settle();
      expect(h.doc.state.get().doc.features.some((f) => f.type === 'delete_faces')).toBe(false);
      // The Assistant: direct delete_faces with the same selector.
      const r = await h.ok('direct', { edit: '', name: '', kind: 'delete_faces', faces: ['Body 1 faces fillet <= 2 mm'], distance: '', bodies: [], tool: '', keep_tool: false, move: [], turn: { angle: '', axis: '', pivot: [] }, copy: false });
      expect(r.data).toMatchObject({ feature: { name: 'Delete faces 1', type: 'delete_faces', state: 'ok' } });
      const ai = h.doc.state.get();
      const aiDel = ai.doc.features.find((f) => f.type === 'delete_faces') as DeleteFacesFeature;
      expect(aiDel.faces.map((f) => f.name).sort()).toEqual(personFaces);
      expect(ai.rebuild.bodies[0].volume).toBeCloseTo(sharp, 3);
    },
    REAL_KERNEL_MS,
  );
});
