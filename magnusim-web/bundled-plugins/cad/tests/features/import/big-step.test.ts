// @vitest-environment node
// The 113 MB STEP through the import pipeline on the real kernel (opt-in:
// CAD_E2E_BIG_STEP=<path>; docs/p2p3-plan.md §5.4): healed while read (no
// second copy), 11,776 faces, the BREP stored, and a reopen that reads the
// stored BREP only. Times and the kernel heap go to the test output.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import { importFixture, openRealDoc, settle, type RealDoc } from '../p2/real-doc';

const BIG = process.env.CAD_E2E_BIG_STEP ?? '';
const open: RealDoc[] = [];
afterAll(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

describe('the 113 MB STEP (opt-in)', () => {
  it.skipIf(!BIG)(`imports healed-on-read and reopens from the stored BREP (CAD_E2E_BIG_STEP${BIG ? `=${BIG}` : ' is not set'})`, async () => {
    const bytes = new Uint8Array(readFileSync(BIG));
    const name = BIG.split(/[\\/]/).pop()!;
    const r = await openRealDoc();
    open.push(r);
    const t0 = performance.now();
    const { feature, rebuild } = await importFixture(r, name, { bytes });
    const ms = performance.now() - t0;
    expect(rebuild.features[feature]).toMatchObject({ state: 'ok' });
    expect(rebuild.bodies[0].faces).toBe(11776);
    const ops = [...r.kernel.ops];
    expect(ops).toContain('import_step');
    expect(ops).not.toContain('heal');
    const heap = r.kernel.status.get().heap_bytes;
    const f = r.doc.state.get().doc.features[0] as { brep: { size: number } };
    process.stdout.write(`[big-step] import ${(ms / 1000).toFixed(1)} s, BREP ${(f.brep.size / 1048576).toFixed(1)} MB, heap ${((heap ?? 0) / 1048576).toFixed(0)} MB\n`);
    await r.doc.flush();
    const folder = r.folder;
    r.dispose();
    open.splice(open.indexOf(r), 1);
    forgetBreps();
    const t1 = performance.now();
    const again = await openRealDoc({ folder });
    open.push(again);
    const rb = await settle(again.doc, 240_000);
    process.stdout.write(`[big-step] reopen ${((performance.now() - t1) / 1000).toFixed(1)} s\n`);
    expect(rb.bodies[0].faces).toBe(11776);
    expect(again.kernel.ops).not.toContain('import_step');
    expect(again.kernel.ops).not.toContain('heal');
  }, 600_000);
});
