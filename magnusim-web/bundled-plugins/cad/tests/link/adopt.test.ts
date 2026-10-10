// @vitest-environment node
// Edit in CAD (host API 1.7): the original-names sidecar. CAD's import faces are
// matched to the app's face table by index, then by fingerprint within the body;
// the sidecar has one row per host face (the app's numbering), CAD's names where
// found, and the app's canonical form.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptPath, cadFaceTable, designDigest, matchFaces, originalNamesText, prepareAdoption, readCadAdopt, sameFace, unmatchedWords, unverifiedWords, type CadVisit } from '../../src/link/adopt';
import { forgetBreps, rememberBrep } from '../../src/features/import/feature';
import type { Bridge } from '../../src/lib/bridge';
import type { CadDoc, ImportFeature } from '../../src/types/doc';
import type { GeometryFace, GeometryFaces } from '../../src/types/edit-geometry';
import type { KernelAdapter } from '../../src/types/kernel';

type V3 = [number, number, number];
/** A 20 mm cube's faces: -X, +X, -Y, +Y, -Z, +Z (the order OCCT gives a box). */
const CUBE: { c: V3; n: V3 }[] = [
  { c: [0, 10, 10], n: [-1, 0, 0] },
  { c: [20, 10, 10], n: [1, 0, 0] },
  { c: [10, 0, 10], n: [0, -1, 0] },
  { c: [10, 20, 10], n: [0, 1, 0] },
  { c: [10, 10, 0], n: [0, 0, -1] },
  { c: [10, 10, 20], n: [0, 0, 1] },
];

function hostFace(i: number, k: number, body = 1, shift: V3 = [0, 0, 0]): GeometryFace {
  const f = CUBE[k];
  return { index: i + 1, body, label: `face ${i + 1}@Body${body}`, area: 400, centroid: [f.c[0] + shift[0], f.c[1] + shift[1], f.c[2] + shift[2]], normal: f.n, surfaceType: 'plane', sharedWith: null, name: null, uses: [] };
}

function visit(k: number, solid = 1, bodyId = 'b_1', shift: V3 = [0, 0, 0]): CadVisit {
  const f = CUBE[k];
  return { solid, bodyId, face: k, name: `F:f_imp:import:${solid - 1}:${k}`, area: 400, centroid: [f.c[0] + shift[0], f.c[1] + shift[1], f.c[2] + shift[2]], normal: f.n };
}

const DIAG = Math.hypot(20, 20, 20);

describe('matchFaces', () => {
  it('the same order: every face by index', () => {
    const m = matchFaces([0, 1, 2, 3, 4, 5].map((k, i) => hostFace(i, k)), [0, 1, 2, 3, 4, 5].map((k) => visit(k)), DIAG);
    expect(m).toMatchObject({ matched: 6, total: 6, byIndex: 6, byShape: 0 });
    expect(m.visit).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...m.bodies]).toEqual([[1, 1]]);
  });

  it('healing renumbered the faces: found by fingerprint in the same body', () => {
    const order = [5, 4, 3, 2, 1, 0];
    const m = matchFaces(order.map((k, i) => hostFace(i, k)), [0, 1, 2, 3, 4, 5].map((k) => visit(k)), DIAG);
    expect(m).toMatchObject({ matched: 6, byIndex: 0, byShape: 6 });
    expect(m.visit).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('a face that is not there (moved beyond the tolerance, or another size) stays unmatched', () => {
    const host = [0, 1, 2, 3, 4, 5].map((k, i) => hostFace(i, k));
    host[5] = { ...host[5], centroid: [10, 10, 20.01] };
    host[4] = { ...host[4], area: 401 };
    const m = matchFaces(host, [0, 1, 2, 3, 4, 5].map((k) => visit(k)), DIAG);
    expect(m).toMatchObject({ matched: 4, total: 6 });
    expect(m.visit.slice(4)).toEqual([-1, -1]);
  });

  it('within the tolerance (1e-4 of the diagonal) still the same face; normals must agree when both have one', () => {
    const tol = 1e-4 * DIAG;
    expect(sameFace({ area: 400, centroid: [0, 10, 10 + tol * 0.9], normal: [-1, 0, 0] }, visit(0), tol)).toBe(true);
    expect(sameFace({ area: 400, centroid: [0, 10, 10], normal: [1, 0, 0] }, visit(0), tol)).toBe(false);
    expect(sameFace({ area: 400, centroid: [0, 10, 10], normal: null }, visit(0), tol)).toBe(true);
    expect(sameFace({ area: 400.3, centroid: [0, 10, 10], normal: null }, visit(0), tol)).toBe(true);
  });

  it('two bodies: each host body pairs with its solid; a fingerprint only ever matches within it', () => {
    // Two identical cubes, the second 100 mm along X: bodies in the other order in the app.
    const host = [...[0, 1, 2, 3, 4, 5].map((k, i) => hostFace(i, k, 1, [100, 0, 0])), ...[0, 1, 2, 3, 4, 5].map((k, i) => hostFace(6 + i, k, 2))];
    const cad = [...[0, 1, 2, 3, 4, 5].map((k) => visit(k, 1, 'b_a')), ...[0, 1, 2, 3, 4, 5].map((k) => visit(k, 2, 'b_b', [100, 0, 0]))];
    const m = matchFaces(host, cad, Math.hypot(120, 20, 20));
    expect(m.matched).toBe(12);
    expect([...m.bodies].sort()).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(m.visit.slice(0, 6)).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it('two candidates with the same fingerprint: none is guessed', () => {
    const host = [hostFace(0, 0)];
    const twin = { ...visit(0), face: 9, name: 'twin' };
    const m = matchFaces([{ ...host[0], index: 1 }], [visit(1), visit(0), twin], DIAG);
    expect(m.visit).toEqual([-1]);
  });
});

describe('matchFaces on a large part', () => {
  // 10,000 faces on a 100 x 100 grid of tiles (each 1 mm square, 0.5 mm apart), in 4 bodies.
  function table(n: number) {
    const host: GeometryFace[] = [];
    const cad: CadVisit[] = [];
    for (let i = 0; i < n; i++) {
      const c: V3 = [(i % 100) * 1.5, Math.floor(i / 100) * 1.5, (i % 7) * 0.25];
      const body = 1 + Math.floor((4 * i) / n);
      host.push({ index: i + 1, body, label: `face ${i + 1}@Body${body}`, area: 1 + (i % 13) * 0.01, centroid: c, normal: [0, 0, 1], surfaceType: 'plane', sharedWith: null, name: null, uses: [] });
      cad.push({ solid: body, bodyId: `b_${body}`, face: i, name: `F:f:import:${body - 1}:${i}`, area: 1 + (i % 13) * 0.01, centroid: [...c] as V3, normal: [0, 0, 1] });
    }
    return { host, cad, diag: Math.hypot(150, 150, 1.5) };
  }

  it('10,000 faces in the same order: all by index, in well under half a second', () => {
    const { host, cad, diag } = table(10_000);
    const t0 = performance.now();
    const m = matchFaces(host, cad, diag);
    const ms = performance.now() - t0;
    expect(m).toMatchObject({ matched: 10_000, byIndex: 10_000 });
    expect(ms).toBeLessThan(500);
  });

  it('10,000 faces, every one renumbered (reversed): all found by fingerprint through the grid, in well under half a second', () => {
    const { host, cad, diag } = table(10_000);
    const shuffled = [...cad].reverse();
    const t0 = performance.now();
    const m = matchFaces(host, shuffled, diag);
    const ms = performance.now() - t0;
    expect(m).toMatchObject({ matched: 10_000, byShape: 10_000 });
    expect(m.visit[0]).toBe(9_999);
    expect(ms).toBeLessThan(500);
  });
});

describe('the sidecar', () => {
  const table: GeometryFaces = {
    geometryId: 'g1',
    rev: 0,
    lengthUnit: 'mm',
    sourceSha256: 'A'.repeat(64),
    bodies: [{ index: 1, ref: 'Body1', id: null, name: 'Box' }],
    faces: [0, 1, 2, 3, 4, 5].map((k, i) => hostFace(i, k)),
  };

  it('one row per host face in the app format: names without #k, labels as an export gives them', () => {
    const visits = [0, 1, 2, 3, 4, 5].map((k) => visit(k));
    visits[2] = { ...visits[2], name: `${visits[2].name}#1` };
    const m = matchFaces(table.faces, visits, DIAG);
    m.visit[5] = -1;
    const text = originalNamesText(table, visits, m, [{ id: 'b_1', name: 'Box' }], (id) => (id === 'f_imp' ? 'Imported 1 (box.step)' : null));
    expect(text.endsWith('\n')).toBe(true);
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ format: 'magnusim.face-names', version: 1, length_unit: 'mm', shape_sha256: 'a'.repeat(64) });
    expect(doc.bodies).toEqual([{ index: 1, id: 'b_1', name: 'Box', label: 'Box' }]);
    expect(doc.faces).toHaveLength(6);
    // A named row carries the fingerprint of the CAD face it names (contract change 4), in mm.
    expect(doc.faces[0]).toEqual({ index: 1, body: 1, name: 'F:f_imp:import:0:0', label: 'Imported 1 (box.step) · Face 1', centroid: [0, 10, 10], area: 400, normal: [-1, 0, 0] });
    expect(doc.faces[2]).toEqual({ index: 3, body: 1, name: 'F:f_imp:import:0:2', label: 'Imported 1 (box.step) · Face 3 · part 2', centroid: [10, 0, 10], area: 400, normal: [0, -1, 0] });
    // Not matched: no name, no label, no fingerprint (the app maps its records by shape only).
    expect(doc.faces[5]).toEqual({ index: 6, body: 1 });
    // Canonical: sorted keys, one line.
    expect(text.split('\n')).toHaveLength(2);
    expect(text.indexOf('"bodies"')).toBeLessThan(text.indexOf('"faces"'));
  });

  it('a curved face names its fingerprint with normal null; a face matched without a fingerprint gets no name; the bodies are the app\'s own (none for a surface-only import)', () => {
    const visits = [0, 1, 2, 3, 4, 5].map((k) => visit(k));
    visits[1] = { ...visits[1], normal: null };
    const m = matchFaces(table.faces, visits, DIAG);
    const doc = JSON.parse(originalNamesText(table, visits, m, [{ id: 'b_1', name: 'Box' }], () => 'Imported 1'));
    expect(doc.faces[1]).toMatchObject({ name: 'F:f_imp:import:0:1', centroid: [20, 10, 10], area: 400, normal: null });
    const forced = { ...m, visit: [...m.visit] };
    const bare = [...visits];
    bare[3] = { ...bare[3], area: null };
    const noPrint = JSON.parse(originalNamesText(table, bare, forced, [{ id: 'b_1', name: 'Box' }], () => 'Imported 1'));
    expect(noPrint.faces[3]).not.toHaveProperty('name');
    expect(noPrint.faces[3]).not.toHaveProperty('centroid');
    const shells = JSON.parse(originalNamesText({ ...table, bodies: [] }, visits, m, [{ id: 'b_1', name: 'Box' }], () => 'Imported 1'));
    expect(shells.bodies).toEqual([]);
  });

  it('designDigest: the same features, bodies and parameters give the same digest; any change another', async () => {
    const d1 = { features: [{ id: 'f', type: 'import', name: 'Imported 1' }], bodies: { b: { name: 'Box', color: '#000000' } }, params: [] } as unknown as CadDoc;
    const same = JSON.parse(JSON.stringify(d1)) as CadDoc;
    expect(await designDigest(same)).toBe(await designDigest(d1));
    expect(await designDigest({ ...d1, bodies: { b: { name: 'Box', color: '#000000', simulation: false } } } as unknown as CadDoc)).not.toBe(await designDigest(d1));
    expect(await designDigest({ ...d1, features: [...d1.features, { id: 'g', type: 'press_pull', name: 'Press-pull 1' }] } as unknown as CadDoc)).not.toBe(await designDigest(d1));
  });

  it('readCadAdopt keeps a well-formed record only; unmatchedWords counts the faces left, or says the matching failed; unverifiedWords', () => {
    expect(readCadAdopt({ geometryId: 'g', importId: 'f_1', baselineVersion: 3, baselineDigest: 'd', originalNames: { rel: 'x', sha256: 'y' }, matched: 5, total: 6 })).toEqual({
      geometryId: 'g',
      importId: 'f_1',
      baselineVersion: 3,
      baselineDigest: 'd',
      originalNames: { rel: 'x', sha256: 'y' },
      matched: 5,
      total: 6,
      error: null,
    });
    // A record from before the import id and digest were kept: both null.
    expect(readCadAdopt({ geometryId: 'g', baselineVersion: 3, originalNames: null })).toMatchObject({ importId: null, baselineDigest: null, originalNames: null, matched: 0 });
    expect(unmatchedWords({ matched: 0, total: 6, error: 'the app did not answer.' }, 'Box')).toBe('Face matching failed: the app did not answer. Boundary conditions will follow by shape only.');
    expect(unverifiedWords(0, 'Box')).toBeNull();
    expect(unverifiedWords(1, 'Box')).toBe('1 face of Box could not be checked; their boundary conditions follow by shape only.');
    expect(unverifiedWords(4, 'Box')).toBe('4 faces of Box could not be checked; their boundary conditions follow by shape only.');
    expect(readCadAdopt({ geometryId: 'g', baselineVersion: 3, originalNames: null })).toMatchObject({ originalNames: null, matched: 0 });
    expect(readCadAdopt({ geometryId: '', baselineVersion: 3 })).toBeNull();
    expect(readCadAdopt(null)).toBeNull();
    expect(unmatchedWords({ matched: 6, total: 6 }, 'Box')).toBeNull();
    expect(unmatchedWords({ matched: 5, total: 6 }, 'Box')).toBe('1 face of Box could not be matched; their boundary conditions follow by shape only.');
    expect(unmatchedWords({ matched: 3, total: 6 }, 'Box')).toBe('3 faces of Box could not be matched; their boundary conditions follow by shape only.');
  });
});

describe('prepareAdoption against a scripted kernel and app', () => {
  afterEach(() => forgetBreps());

  const feature: ImportFeature = {
    id: 'f_imp',
    type: 'import',
    name: 'Imported 1 (box.step)',
    source: { rel: 'studies/s1/imports/x/source.step', size: 10, sha256: 's', fileName: 'box.step', unit: null },
    brep: { rel: 'studies/s1/imports/x/healed.brep', size: 3, sha256: 'brep-sha', occt: '7.9.3' },
    heal: { tolerance: 0.001, sew: false },
    items: [{ body: 'b_1', index: 0, stepName: 'Box', stepColor: null, kind: 'solid', valid: true }],
    origin: { geometryId: 'g1', sha256: 's' },
  } as ImportFeature;
  const doc = { features: [feature], bodies: { b_1: { name: 'Box', color: '#bdc9db' } } } as unknown as CadDoc;

  function kernel(type: 'solid' | 'other' = 'solid') {
    const calls: string[] = [];
    const k = {
      call: vi.fn(async (op: string, p: Record<string, unknown>) => {
        calls.push(op);
        if (op === 'brep_read') return { result: { shapes: [{ id: 41, type, faces: 6 }], occt: '7.9.3', timings: {} } };
        if (op === 'link_export') return { result: { solids: [{ src: 0, piece: 1, faces: 6 }], empty: [], visit_body: [1, 1, 1, 1, 1, 1], visit_face: [0, 1, 2, 3, 4, 5] }, buffers: { brep: new ArrayBuffer(1) } };
        if (op === 'topo') {
          const sel = p.faces as { start: number; count: number };
          const all = CUBE.map((f, i) => ({ i, type: 'plane', area: 400, centroid: f.c, normal: f.n, bbox: [0, 0, 0, 20, 20, 20] }));
          return { result: { faces: all.slice(sel.start, sel.start + sel.count), edges: [], vertices: [], counts: { faces: 6, edges: 12, vertices: 8 }, timings: {} } };
        }
        if (op === 'release') return { result: {} };
        throw new Error(`unexpected ${op}`);
      }),
    };
    return { k: k as unknown as KernelAdapter, calls };
  }

  it('reads the stored shapes (from this session when it has them), matches, writes the sidecar, and gives the record', async () => {
    rememberBrep('brep-sha', new ArrayBuffer(3));
    const { k, calls } = kernel();
    const written: [string, string][] = [];
    const host = [5, 0, 1, 2, 3, 4].map((kk, i) => hostFace(i, kk));
    const bridge = {
      files: { write: vi.fn(async (rel: string, text: string) => (written.push([rel, text]), { rel, sha256: 'E'.repeat(64) })), read: vi.fn() },
      edit: { faces: async () => ({ geometryId: 'g1', rev: 0, lengthUnit: 'mm', sourceSha256: 'f'.repeat(64), bodies: [{ index: 1, ref: 'Body1', id: null, name: 'Box' }], faces: host }) },
    } as unknown as Bridge;
    const o = await prepareAdoption({ bridge, kernel: k, doc: () => doc }, { geometry: { id: 'g1', name: 'Box', format: 'step', fileName: 'box.step', linked: false, rev: 0, bodies: 1, faces: 6 }, feature, baselineVersion: 2, baselineDigest: 'dg', studyId: 's1' });
    expect(o.record).toEqual({ geometryId: 'g1', importId: 'f_imp', baselineVersion: 2, baselineDigest: 'dg', originalNames: { rel: adoptPath('s1', 'f_imp'), sha256: 'e'.repeat(64) }, matched: 6, total: 6, error: null });
    expect(bridge.files!.read).not.toHaveBeenCalled();
    expect(calls[0]).toBe('brep_read');
    // One solid per body and the app counts as many faces: the visit order is the face order, no link_export.
    expect(calls).not.toContain('link_export');
    expect(calls.at(-1)).toBe('release');
    // One file per Imported feature: two tabs' imports never write the same one.
    expect(written[0][0]).toBe('studies/s1/adopt/f_imp/original_names.json');
    const side = JSON.parse(written[0][1]);
    expect(side.faces.map((f: { name: string }) => f.name)).toEqual(['F:f_imp:import:0:5', 'F:f_imp:import:0:0', 'F:f_imp:import:0:1', 'F:f_imp:import:0:2', 'F:f_imp:import:0:3', 'F:f_imp:import:0:4']);
    expect(o.faces.get(1)).toEqual({ body: 'b_1', index: 5 });
    expect(o.bodies.get(1)).toBe('b_1');
  });

  it('a surface-only import (box20-faces): no link_export (it would find no solid), the faces in their order', async () => {
    rememberBrep('brep-sha', new ArrayBuffer(3));
    const shell = kernel('shell' as 'solid');
    const t = await cadFaceTable({ bridge: { files: null } as unknown as Bridge, kernel: shell.k, doc: () => doc }, feature, undefined, {}, 6);
    expect(shell.calls).not.toContain('link_export');
    expect(t.visits.map((v) => v.face)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(t.visits.every((v) => v.area === 400)).toBe(true);
  });

  it('a body of several solids (or a face count the app does not share): the visit order comes from link_export', async () => {
    rememberBrep('brep-sha', new ArrayBuffer(3));
    const several = kernel('other');
    const t = await cadFaceTable({ bridge: { files: null } as unknown as Bridge, kernel: several.k, doc: () => doc }, feature);
    expect(several.calls).toContain('link_export');
    expect(t.visits.map((v) => v.face)).toEqual([0, 1, 2, 3, 4, 5]);
    const counted = kernel('solid');
    await cadFaceTable({ bridge: { files: null } as unknown as Bridge, kernel: counted.k, doc: () => doc }, feature, undefined, {}, 7);
    expect(counted.calls).toContain('link_export');
  });

  /** A kernel holding one solid of `n` faces (face i at x = i); `die` throws from that topo call on (its worker died). */
  function many(n: number, o: { die?: number; failRead?: boolean } = {}) {
    const calls: string[] = [];
    let topos = 0;
    const k = {
      status: { get: () => ({ heap_bytes: 300 * 2 ** 20 }) },
      call: vi.fn(async (op: string, p: Record<string, unknown>) => {
        calls.push(op);
        await new Promise((r) => setTimeout(r, 1));
        if (op === 'brep_read') {
          if (o.failRead) throw Object.assign(new Error('out of memory'), { kind: 'oom' });
          return { result: { shapes: [{ id: 7, type: 'solid', faces: n }], occt: '7.9.3', timings: {} } };
        }
        if (op === 'topo') {
          topos++;
          if (o.die !== undefined && topos >= o.die) throw Object.assign(new Error('the kernel worker died'), { kind: 'crash' });
          const sel = p.faces as { start: number; count: number };
          const faces = Array.from({ length: sel.count }, (_, j) => ({ i: sel.start + j, type: 'plane', area: 1, centroid: [sel.start + j, 0, 0], normal: [0, 0, 1], bbox: [0, 0, 0, n, 1, 1] }));
          return { result: { faces, edges: [], vertices: [], counts: { faces: n, edges: 0, vertices: 0 }, timings: {} } };
        }
        if (op === 'release') return { result: {} };
        throw new Error(`unexpected ${op}`);
      }),
    };
    return { k: k as unknown as KernelAdapter, calls, topos: () => topos };
  }

  it('with helper kernels: each helper reads the BREP and they share the fingerprint chunks; the Part kernel (still drawing the part) is not used; nothing is released (the caller stops the helpers)', async () => {
    rememberBrep('brep-sha', new ArrayBuffer(3));
    const main = many(2000);
    const a = many(2000);
    const b = many(2000);
    const dropped = vi.fn();
    const prof: Record<string, number> = {};
    const t = await cadFaceTable({ bridge: { files: null } as unknown as Bridge, kernel: main.k, doc: () => doc, helpers: async () => [a.k, b.k], dropHelpers: dropped }, feature, undefined, prof, 2000);
    for (const x of [a, b]) expect(x.calls[0]).toBe('brep_read');
    expect(main.calls).toEqual([]);
    expect(a.topos() + b.topos()).toBe(10);
    expect(a.topos()).toBeGreaterThan(0);
    expect(b.topos()).toBeGreaterThan(0);
    expect([...a.calls, ...b.calls]).not.toContain('release');
    expect(dropped).not.toHaveBeenCalled();
    expect(prof).toMatchObject({ helpers: 2, helper_heap_mb: 300 });
    expect(t.visits).toHaveLength(2000);
    expect(t.visits.every((v, i) => v.area === 1 && v.centroid![0] === i)).toBe(true);
  });

  it('a helper dies mid-way: every helper is stopped, its chunk goes back, and the Part kernel finishes alone with every face', async () => {
    rememberBrep('brep-sha', new ArrayBuffer(3));
    const main = many(3000);
    const a = many(3000, { die: 2 });
    const b = many(3000);
    let stopped = false;
    const dropped = vi.fn(() => {
      stopped = true;
    });
    // A stopped helper's next call fails too (its worker is gone).
    const bk = b.k.call as unknown as ReturnType<typeof vi.fn>;
    const inner = bk.getMockImplementation() as (op: string, p: Record<string, unknown>) => Promise<unknown>;
    bk.mockImplementation(async (op: string, p: Record<string, unknown>) => {
      if (stopped && op === 'topo') throw new Error('terminated');
      return inner(op, p);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prof: Record<string, number> = {};
    const t = await cadFaceTable({ bridge: { files: null } as unknown as Bridge, kernel: main.k, doc: () => doc, helpers: async () => [a.k, b.k], dropHelpers: dropped }, feature, undefined, prof, 3000);
    warn.mockRestore();
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(prof.helper_failed).toBe(1);
    // Nothing lost: every face has its fingerprint.
    expect(t.visits).toHaveLength(3000);
    expect(t.visits.every((v, i) => v.area === 1 && v.centroid![0] === i)).toBe(true);
    // The Part kernel read the BREP only once the helpers were gone, finished, and released its copy.
    expect(main.calls[0]).toBe('brep_read');
    expect(main.topos()).toBeGreaterThan(0);
    expect(main.calls.at(-1)).toBe('release');
  });

  it('a helper whose read fails (out of memory): no helper is used, the Part kernel does it all', async () => {
    rememberBrep('brep-sha', new ArrayBuffer(3));
    const main = many(1000);
    const a = many(1000, { failRead: true });
    const b = many(1000);
    const dropped = vi.fn();
    const prof: Record<string, number> = {};
    const t = await cadFaceTable({ bridge: { files: null } as unknown as Bridge, kernel: main.k, doc: () => doc, helpers: async () => [a.k, b.k], dropHelpers: dropped }, feature, undefined, prof, 1000);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(prof).toMatchObject({ helpers: 0, helper_failed: 1 });
    expect(a.topos() + b.topos()).toBe(0);
    expect(main.topos()).toBe(5);
    expect(t.visits).toHaveLength(1000);
  });

  it('cadFaceTable downloads the stored BREP when this session has not got it, and releases what it read', async () => {
    const { k, calls } = kernel();
    const bridge = { files: { read: vi.fn(async () => new ArrayBuffer(3)) } } as unknown as Bridge;
    const t = await cadFaceTable({ bridge, kernel: k, doc: () => doc }, feature);
    expect(bridge.files!.read).toHaveBeenCalledWith('studies/s1/imports/x/healed.brep');
    expect(t.visits).toHaveLength(6);
    expect(t.solids).toEqual([{ id: 'b_1', name: 'Box' }]);
    expect(t.diag).toBeCloseTo(DIAG, 9);
    expect(calls.at(-1)).toBe('release');
  });
});
