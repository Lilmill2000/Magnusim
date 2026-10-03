// The import pipeline and the Imported build against the kernel contract
// (docs/p2p3-plan.md §1.2, §2.1-2.3), scripted: the steps in order with their
// progress; files up to 50 MB read raw and healed (the raw shapes kept for
// Heal all), larger ones healed while read (no heal call); the BREP stored
// content-addressed beside the source; a stop or a failure leaves no file and
// no shape behind; the build reads the BREP only, says when file storage or
// the BREP is missing, and heals the source again (amber) under another OCCT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createFileTransfer } from '../../../src/files/transfer';
import { forgetBreps, importDef, importName, rememberBrep } from '../../../src/features/import/feature';
import { healKey, hexColor, LARGE_STEP_BYTES, runImport, type StageProgress } from '../../../src/features/import/pipeline';
import { emptyDoc } from '../../../src/doc/schema';
import type { CadDoc, ImportFeature } from '../../../src/types/doc';
import { FakeFiles, FakeFolder } from '../../doc/fake-files';
import { ctxOf, kernelError, scriptKernel, type ScriptKernel } from '../p2/script-kernel';

afterEach(() => forgetBreps());

const SID = 's_1';
const diag = (ids: number[], total = 0) => ({ total, shapes: ids.map((id) => ({ id, valid: total === 0, problems: [], problem_counts: {}, problem_total: total, free_edges: 0, closed: true })) });

function kernel(): ScriptKernel {
  let next = 10;
  return scriptKernel()
    .on('import_step', (p) => {
      const n = next++;
      return { shapes: [{ id: n, name: 'Plate', color: [1, 0, 0], color_linear: null, type: 'solid', faces: 10 }], faces: 10, edges: 24, bbox: null, unit: 'millimetre', diagnostics: diag([n], p.heal ? 0 : 3), timings: {} };
    })
    .on('heal', (p) => {
      const ids = p.ids as number[];
      return { shapes: ids.map((from) => ({ id: from + 100, from, name: '', color: null, type: 'solid', faces: 10, valid: true })), fixed: 1, sewn: 0, free_edges: 0, diagnostics: diag(ids.map((i) => i + 100)), history: { faces: [], edges: [], deleted: [] }, timings: {} };
    })
    .on('brep_write', (p) => ({ result: { bytes: 64, occt: '7.9.3', timings: {} }, buffers: { brep: new Uint8Array(64).fill((p.ids as number[])[0] % 256).buffer } }));
}

function step(bytes = 1000): File {
  return new File([new Uint8Array(bytes).fill(7)], 'flange.step');
}

describe('import pipeline', () => {
  it('hash, upload, read raw, heal, write and store the BREP; keeps the raw shapes for Heal all', async () => {
    const folder = new FakeFolder();
    const files = createFileTransfer({ files: new FakeFiles(folder) });
    const k = kernel();
    const stages: string[] = [];
    const { outcome } = await runImport({ kernel: k, files, studyId: SID }, step(), { fileName: 'flange.step', tolerance: 0.001, sew: false, onStage: (p: StageProgress) => stages.push(p.stage) });
    expect([...new Set(stages)]).toEqual(['hashing', 'uploading', 'reading', 'healing', 'writing', 'storing']);
    expect(k.ops()).toEqual(['import_step', 'heal', 'brep_write', 'release']);
    expect(k.calls[0].params).toEqual({ name: 'flange.step', heal: false, tol: 0.001, diagnose: true });
    expect(k.calls[0].bytes).toBe(1000);
    expect(k.calls[1].params).toEqual({ ids: [10], tol: 0.001, sew: false, diagnose: true });
    // The healed shapes are freed (the build reads the BREP); the raw ones stay for Heal all.
    expect(k.released).toEqual([110]);
    expect(outcome.raw).toEqual([10]);
    const sha = outcome.source.sha256;
    expect(outcome.source).toMatchObject({ rel: `studies/${SID}/imports/${sha}/source.step`, size: 1000, fileName: 'flange.step', unit: 'millimetre' });
    expect(outcome.brep.rel).toMatch(new RegExp(`^studies/${SID}/imports/${sha}/healed-0\\.001-[0-9a-f]{12}\\.brep$`));
    expect(outcome.brep).toMatchObject({ size: 64, occt: '7.9.3' });
    expect(folder.has(outcome.source.rel) && folder.has(outcome.brep.rel)).toBe(true);
    expect(outcome.items).toEqual([expect.objectContaining({ index: 0, stepName: 'Plate', stepColor: '#ff0000', kind: 'solid', valid: true })]);
    expect(outcome.diagnostics).toEqual({ problemsBefore: 3, problemsAfter: 0, fixed: 1 });
    expect(outcome.created).toEqual([outcome.source.rel, outcome.brep.rel]);
  });

  it('the healed BREP goes to file storage as a Blob (chunks by reference), and the bytes the rebuild reads stay whole', async () => {
    // INTEGRATE: as an ArrayBuffer each 16 MB chunk was copied across to the host page and held its main
    // thread ~160 ms; the 113 MB part's 68 MB BREP froze the host's header for 2.5-3 s (e2e/cad-large-step.spec.js).
    const fake = new FakeFiles();
    const kinds: { rel: string; blob: boolean }[] = [];
    const write = fake.write.bind(fake);
    fake.write = (async (rel: string, data: ArrayBuffer | ArrayBufferView | Blob | string, opts?: { ifMatch?: string | null }) => {
      kinds.push({ rel, blob: data instanceof Blob });
      return write(rel, data, opts);
    }) as typeof fake.write;
    const files = createFileTransfer({ files: fake });
    const { outcome, brepBytes } = await runImport({ kernel: kernel(), files, studyId: SID }, step(), { fileName: 'flange.step', tolerance: 0.001, sew: false, onStage: () => {} });
    expect(kinds.find((k) => k.rel === outcome.brep.rel)).toEqual({ rel: outcome.brep.rel, blob: true });
    expect(new Uint8Array(brepBytes)).toEqual(new Uint8Array(64).fill(110));
  });

  it('a file over 50 MB heals while it is read: no heal call, nothing kept raw', async () => {
    const files = createFileTransfer({ files: new FakeFiles() });
    const k = kernel();
    const big = new File([new Uint8Array(8)], 'big.step');
    Object.defineProperty(big, 'size', { value: LARGE_STEP_BYTES + 1 });
    const { outcome } = await runImport({ kernel: k, files, studyId: SID }, big, { fileName: 'big.step', tolerance: 0.001, sew: false, onStage: () => {} });
    expect(k.ops()).toEqual(['import_step', 'brep_write', 'release']);
    expect(k.calls[0].params.heal).toBe(true);
    expect(outcome.raw).toBeNull();
    expect(outcome.healedOnRead).toBe(true);
    expect(outcome.diagnostics.problemsBefore).toBe(outcome.diagnostics.problemsAfter);
    // Stored with the Part, so a reopened Part still says "Large file: healed while it was read".
    expect(outcome.diagnostics.healedOnRead).toBe(true);
  });

  it('the same file again reuses the stored source (content-addressed, never rewritten)', async () => {
    const fake = new FakeFiles();
    const files = createFileTransfer({ files: fake });
    await runImport({ kernel: kernel(), files, studyId: SID }, step(), { fileName: 'flange.step', tolerance: 0.001, sew: false, onStage: () => {} });
    const writes = fake.writes.length;
    const { outcome } = await runImport({ kernel: kernel(), files, studyId: SID }, step(), { fileName: 'flange.step', tolerance: 0.001, sew: false, onStage: () => {} });
    expect(fake.writes.length).toBe(writes);
    expect(outcome.created).toEqual([]);
  });

  it('a kernel failure leaves no file and no shape behind', async () => {
    const folder = new FakeFolder();
    const files = createFileTransfer({ files: new FakeFiles(folder) });
    const k = kernel().on('brep_write', () => {
      throw kernelError('BinTools write failed', 'occt', 'brep_write');
    });
    await expect(runImport({ kernel: k, files, studyId: SID }, step(), { fileName: 'flange.step', tolerance: 0.001, sew: false, onStage: () => {} })).rejects.toThrow('BinTools write failed');
    expect([...folder.entries.keys()]).toEqual([]);
    expect(k.released).toContain(110);
  });

  it('a stop during the read releases what the kernel made and deletes the uploaded source', async () => {
    const folder = new FakeFolder();
    const files = createFileTransfer({ files: new FakeFiles(folder) });
    const ctl = new AbortController();
    const k = kernel();
    const real = k.calls;
    k.on('import_step', () => {
      ctl.abort();
      return { shapes: [{ id: 5, name: 'Plate', color: null, color_linear: null, type: 'solid', faces: 10 }], faces: 10, edges: 24, bbox: null, timings: {} };
    });
    await expect(runImport({ kernel: k, files, studyId: SID }, step(), { fileName: 'flange.step', tolerance: 0.001, sew: false, signal: ctl.signal, onStage: () => {} })).rejects.toMatchObject({ name: 'AbortError' });
    expect(real.map((c) => c.op)).toEqual(['import_step', 'release']);
    expect(k.released).toEqual([5]);
    expect([...folder.entries.keys()]).toEqual([]);
  });

  it('names and keys', () => {
    expect(hexColor([1, 0.5, 0])).toBe('#ff8000');
    expect(hexColor(null)).toBeNull();
    expect(healKey(0.001, false)).toBe('0.001');
    expect(healKey(0.01, true)).toBe('0.01-knit');
    const doc: CadDoc = { ...emptyDoc('metric'), features: [{ id: 'f_1', type: 'import', name: 'Imported 1 (a.step)' } as ImportFeature, { id: 'f_2', type: 'import', name: 'Imported 3' } as ImportFeature] };
    expect(importName(doc, 'b.stp')).toBe('Imported 4 (b.stp)');
  });
});

describe('Imported build', () => {
  const feature = (over: Partial<ImportFeature> = {}): ImportFeature => ({
    id: 'f_i',
    type: 'import',
    name: 'Imported 1 (flange.step)',
    source: { rel: 'studies/s/imports/aa/source.step', size: 10, sha256: 'aa', fileName: 'flange.step', unit: null },
    brep: { rel: 'studies/s/imports/aa/healed.brep', size: 3, sha256: 'bb', occt: '7.9.3' },
    heal: { tolerance: 0.001, sew: false },
    items: [{ body: 'b_1', index: 0, stepName: 'Plate', stepColor: null, kind: 'solid', valid: true }],
    ...over,
  });

  it('without file storage (a 1.1 host) it says why', async () => {
    const r = await importDef.build(feature(), {}, ctxOf(scriptKernel(), []));
    expect(r).toEqual({ ok: false, message: "Imported 1 (flange.step) failed: importing needs Magnusim's file storage (host API 1.2)" });
  });

  it('reads the stored BREP (brep_read only) and names the faces by index', async () => {
    const k = scriptKernel().on('brep_read', () => ({ shapes: [{ id: 7, type: 'solid', faces: 3 }], occt: '7.9.3', timings: {} }));
    const read: string[] = [];
    const r = await importDef.build(feature(), {}, ctxOf(k, [], { files: { read: async (ref) => (read.push(ref.rel), new Uint8Array(3).buffer) } }));
    expect(read).toEqual(['studies/s/imports/aa/healed.brep']);
    expect(k.ops()).toEqual(['brep_read']);
    expect(r).toMatchObject({ ok: true, removed: [], output: { type: 'import', from: 'brep', bytes: 3 } });
    if (r.ok) expect(r.bodies).toEqual([{ id: 'b_1', shape: 7, valid: true, names: { faces: ['F:f_i:import:0:0', 'F:f_i:import:0:1', 'F:f_i:import:0:2'] } }]);
  });

  it('BREP bytes this session just wrote are used without reading them again', async () => {
    rememberBrep('bb', new Uint8Array(3).buffer);
    const k = scriptKernel().on('brep_read', () => ({ shapes: [{ id: 7, type: 'solid', faces: 3 }], occt: '7.9.3', timings: {} }));
    const r = await importDef.build(feature(), {}, ctxOf(k, [], { files: { read: async () => { throw new Error('should not read'); } } }));
    expect(r.ok).toBe(true);
  });

  it('a body stored invalid is kept, shown amber with its reason', async () => {
    const k = scriptKernel().on('brep_read', () => ({ shapes: [{ id: 7, type: 'solid', faces: 3 }], occt: '7.9.3', timings: {} }));
    const doc = { ...emptyDoc('metric'), bodies: { b_1: { name: 'Plate', color: '#bdc9db' } } };
    const f = feature({ items: [{ body: 'b_1', index: 0, stepName: 'Plate', stepColor: null, kind: 'solid', valid: false, reason: 'invalid result (BRepCheck): NotClosed x2' }] });
    const r = await importDef.build(f, {}, ctxOf(k, [], { doc, files: { read: async () => new Uint8Array(3).buffer } }));
    expect(r).toMatchObject({ ok: true, warning: 'Plate is not a valid solid (BRepCheck: NotClosed x2): Heal all with a larger tolerance may fix it' });
    if (r.ok) expect(r.bodies[0].valid).toBe(false);
  });

  it('a stored BREP that holds fewer bodies than the import lists fails and frees what it read', async () => {
    const k = scriptKernel().on('brep_read', () => ({ shapes: [{ id: 7, type: 'solid', faces: 3 }], occt: '7.9.3', timings: {} }));
    const ctx = ctxOf(k, [], { files: { read: async () => new Uint8Array(3).buffer } });
    const f = feature({ items: [...feature().items, { body: 'b_2', index: 1, stepName: 'Other', stepColor: null, kind: 'solid', valid: true }] });
    const r = await importDef.build(f, {}, ctx);
    expect(r).toEqual({ ok: false, message: 'Imported 1 (flange.step) failed: the stored shapes hold 1 body, the import lists 2' });
    expect(ctx.releasedByCtx).toEqual([7]);
  });

  it('another OCCT heals the stored source again and says so (amber)', async () => {
    const k = scriptKernel('8.0.1')
      .on('import_step', () => ({ shapes: [{ id: 3, name: 'Plate', color: null, color_linear: null, type: 'solid', faces: 3 }], faces: 3, edges: 0, bbox: null, timings: {} }))
      .on('heal', () => ({ shapes: [{ id: 4, from: 3, name: '', color: null, type: 'solid', faces: 3, valid: true }], fixed: 0, sewn: 0, free_edges: 0, history: { faces: [], edges: [], deleted: [] }, timings: {} }));
    const ctx = ctxOf(k, [], { files: { read: async (ref) => (ref.rel.endsWith('source.step') ? new Uint8Array(10).buffer : null) } });
    const r = await importDef.build(feature(), {}, ctx);
    expect(k.ops()).not.toContain('brep_read');
    expect(r).toMatchObject({ ok: true, warning: 'Imported 1 (flange.step) was healed again with OCCT 8.0.1: check later references', output: { from: 'source' } });
    expect(ctx.releasedByCtx).toEqual([3]);
  });

  it('declares no expressions, and the bodies it brings with their STEP names, kept apart from names in use', () => {
    const f = feature({ items: [{ body: 'b_9', index: 0, stepName: 'Body 1', stepColor: '#112233', kind: 'solid', valid: true }] });
    expect(importDef.exprs!(f)).toEqual([]);
    expect(importDef.mapExprs!(f, () => 'x')).toBe(f);
    expect(importDef.ownsBody!(f, 'b_9')).toBe(true);
    const doc = { ...emptyDoc('metric'), bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } } };
    expect(importDef.newBodies!(f, doc)).toEqual({ b_9: { name: 'Body 1 (2)', color: '#112233' } });
    expect(importDef.incomplete(feature({ items: [] }), null as never)).toBe('flange.step is still being imported');
  });
});
