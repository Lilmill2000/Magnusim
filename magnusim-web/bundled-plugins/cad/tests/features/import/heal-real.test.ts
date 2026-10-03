// @vitest-environment node
// Heal all and knitting on the real kernel (docs/p2p3-plan.md §5.1 item 11;
// needs kernel API 3, said in the names otherwise): a surface-only STEP (the
// 20 mm cube written as six loose faces) imports as surface bodies with "6
// faces not in a solid"; Heal all with knitting makes one valid solid of
// 8,000 mm³, stores a new BREP and is one undo step with the import; a cube
// with a 0.005 mm gap stays open at 0.001 mm and closes at 0.01 mm.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileTransfer } from '../../../src/files/transfer';
import { createImportRuns } from '../../../src/features/import/runs';
import { forgetBreps } from '../../../src/features/import/feature';
import type { ImportFeature } from '../../../src/types/doc';
import { fixture, openRealDoc, settle, type RealDoc } from '../p2/real-doc';
import { realKernelAnywhere } from '../p2/kernel-anywhere';

const api = await (async () => {
  const k = realKernelAnywhere();
  await k.start();
  const v = (await k.call('version', {} as never)).result.api ?? 0;
  k.dispose();
  return v;
})();

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

async function importOpen(name: string) {
  const r = await openRealDoc();
  open.push(r);
  const bytes = fixture(name);
  const runs = createImportRuns(r.services, () => ({ kernel: r.kernel, files: createFileTransfer({ files: r.services.bridge.files }), studyId: r.services.bridge.studyId }));
  const s = r.doc.beginNew('import', { source: { rel: '', size: bytes.byteLength, sha256: '', fileName: name, unit: null } } as never);
  runs.start(s, new File([new Uint8Array(bytes).buffer as ArrayBuffer], name));
  await vi.waitFor(
    () => {
      const run = runs.state.get().runs[s.feature];
      if (run?.error) throw new Error(`import stopped: ${run.error}`);
      expect(s.incomplete()).toBeNull();
      expect(run?.progress ?? null).toBeNull();
    },
    { timeout: 60_000, interval: 20 },
  );
  await settle(r.doc);
  return { r, s, runs };
}

describe('Heal all on the real kernel (needs kernel API 3)', () => {
  it.skipIf(api < 3)('six loose faces: surface bodies, "6 faces not in a solid"; knitting makes one 8,000 mm³ solid, one undo step', async () => {
    const { r, s, runs } = await importOpen('box20-faces.step');
    const f0 = s.draft as ImportFeature;
    const out0 = runs.state.get().runs[s.feature].outcome!;
    expect(out0.looseFaces).toBe(6);
    expect(f0.items.every((it) => it.kind === 'shell')).toBe(true);
    // One surface body (the six faces, not sewn).
    const before = r.doc.state.get().rebuild.bodies;
    expect(before).toHaveLength(1);
    expect(before[0].faces).toBe(6);
    const brep0 = f0.brep.rel;
    await runs.healAll(s, 0.001, true);
    const f1 = s.draft as ImportFeature;
    expect(runs.state.get().runs[s.feature].error).toBeNull();
    expect(f1.heal).toEqual({ tolerance: 0.001, sew: true });
    expect(f1.items).toHaveLength(1);
    expect(f1.items[0]).toMatchObject({ kind: 'solid', valid: true, body: f0.items[0].body });
    expect(f1.diagnostics?.sewn).toBe(6);
    expect(f1.brep.rel).not.toBe(brep0);
    expect(f1.brep.rel).toMatch(/healed-0\.001-knit-[0-9a-f]{12}\.brep$/);
    const rb = await settle(r.doc);
    expect(rb.bodies).toHaveLength(1);
    expect(rb.bodies[0].volume).toBeCloseTo(8000, 6);
    expect(rb.bodies[0].faces).toBe(6);
    s.commit();
    await settle(r.doc);
    // The BREP the knit replaced is not kept (no undo step points at it); the new one is.
    await vi.waitFor(() => expect(r.folder.has(brep0)).toBe(false));
    expect(r.folder.has(f1.brep.rel)).toBe(true);
    // Import + Heal all is one undo step.
    expect(r.doc.state.get().history.undoLabel).toBe('Imported 1 (box20-faces.step)');
    r.doc.undo();
    expect(r.doc.state.get().doc.features).toHaveLength(0);
  });

  it.skipIf(api < 3)('a 0.005 mm gap stays open at 0.001 mm and closes at 0.01 mm', async () => {
    const { r, s, runs } = await importOpen('box20-gap.step');
    await runs.healAll(s, 0.001, true);
    let f = s.draft as ImportFeature;
    expect(f.diagnostics?.freeEdges ?? 0).toBeGreaterThan(0);
    expect(f.items.some((it) => it.kind === 'shell')).toBe(true);
    await runs.healAll(s, 0.01, true);
    f = s.draft as ImportFeature;
    expect(runs.state.get().runs[s.feature].error).toBeNull();
    expect(f.diagnostics?.freeEdges ?? 0).toBe(0);
    expect(f.items).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ kind: 'solid', valid: true });
    const rb = await settle(r.doc);
    expect(Math.abs(rb.bodies[0].volume! - 8000)).toBeLessThan(1);
  });

  it.skipIf(api < 3)('a solid and a loose sheet under one product: a solid body and a surface body', async () => {
    const { s } = await importOpen('box10-sheet.step');
    const f = s.draft as ImportFeature;
    expect(f.items.map((it) => it.kind).sort()).toEqual(['shell', 'solid']);
  });
});
