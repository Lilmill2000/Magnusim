// @vitest-environment node
// Import STEP on the real kernel (P2 exit criteria, docs/p2p3-plan.md §5.1
// items 1, 8, 11): the flange through the import pipeline (upload, read,
// heal, BREP) into "Imported 1 (flange.step)" with the STEP's body, 10 faces,
// 96,858.41 mm³ and face names; the files it stored; and a reopen that reads
// the stored BREP only (no import_step, no heal) with the same face names.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportFeature } from '../../../src/types/doc';
import { forgetBreps } from '../../../src/features/import/feature';
import { importFixture, openRealDoc, settle, type RealDoc } from '../p2/real-doc';

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

async function part(folder?: RealDoc['folder']) {
  const r = await openRealDoc({ folder });
  open.push(r);
  return r;
}

describe('Import STEP on the real kernel', () => {
  it('imports the flange: name, body, faces, volume, names, stored files', async () => {
    const r = await part();
    const { feature, rebuild, outcome } = await importFixture(r, 'flange.step');
    const f = r.doc.state.get().doc.features.find((x) => x.id === feature) as ImportFeature;
    expect(f.name).toBe('Imported 1 (flange.step)');
    expect(rebuild.features[feature]).toMatchObject({ state: 'ok' });
    expect(rebuild.bodies).toHaveLength(1);
    const b = rebuild.bodies[0];
    expect(b.faces).toBe(10);
    expect(b.valid).toBe(true);
    expect(b.volume).toBeCloseTo(96858.40734641012, 3);
    // Names follow the stored BREP's face indices.
    expect(b.names?.faces).toEqual(Array.from({ length: 10 }, (_, i) => `F:${feature}:import:0:${i}`));
    // Body name and colour from the STEP (the BodyDef the import brought).
    expect(r.doc.state.get().doc.bodies[b.id].name).toBe(f.items[0].stepName);
    expect(f.items[0]).toMatchObject({ index: 0, kind: 'solid', valid: true });
    // Diagnostics: "0 problems".
    expect(f.diagnostics).toMatchObject({ problemsBefore: 0, problemsAfter: 0 });
    expect(outcome?.problemsAfter).toEqual([]);
    // The source and the healed BREP are in the Part's folder, content-addressed.
    const sid = r.services.bridge.studyId;
    expect(f.source.rel).toBe(`studies/${sid}/imports/${f.source.sha256}/source.step`);
    expect(f.brep.rel).toMatch(new RegExp(`^studies/${sid}/imports/${f.source.sha256}/healed-0\\.001-[0-9a-f]{12}\\.brep$`));
    expect(r.folder.has(f.source.rel)).toBe(true);
    expect(r.folder.has(f.brep.rel)).toBe(true);
    expect(r.folder.entries.get(f.brep.rel)!.bytes.byteLength).toBe(f.brep.size);
    // The output says where the shapes came from.
    expect(rebuild.outputs[feature]).toMatchObject({ type: 'import', from: 'brep' });
  });

  it('a reopened Part reads the stored BREP only: no import_step, no heal, the same names', async () => {
    const r = await part();
    const { feature } = await importFixture(r, 'flange.step');
    await r.doc.flush();
    const before = r.doc.state.get().rebuild.bodies[0].names?.faces;
    r.dispose();
    open.splice(open.indexOf(r), 1);
    forgetBreps();

    const again = await part(r.folder);
    const rb = await settle(again.doc);
    expect(again.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Imported 1 (flange.step)']);
    expect(rb.features[feature]).toMatchObject({ state: 'ok' });
    expect(rb.bodies[0].names?.faces).toEqual(before);
    expect(rb.bodies[0].volume).toBeCloseTo(96858.40734641012, 3);
    expect(rb.outputs[feature]).toMatchObject({ type: 'import', from: 'brep' });
    expect(again.kernel.ops).toContain('brep_read');
    expect(again.kernel.ops).not.toContain('import_step');
    expect(again.kernel.ops).not.toContain('heal');
  });

  it('a stored BREP that is gone is said, not skipped', async () => {
    const r = await part();
    const { feature } = await importFixture(r, 'flange.step');
    await r.doc.flush();
    const f = r.doc.state.get().doc.features[0] as ImportFeature;
    r.dispose();
    open.splice(open.indexOf(r), 1);
    forgetBreps();
    r.folder.entries.delete(f.brep.rel);
    const again = await part(r.folder);
    const rb = await settle(again.doc);
    expect(rb.features[feature]).toMatchObject({ state: 'error' });
    expect(rb.features[feature].message).toBe(`Imported 1 (flange.step) failed: its stored shapes (${f.brep.rel}) are not in the project any more`);
    expect(rb.bodies).toHaveLength(0);
  });

  it('a stored BREP that changed is refused by its checksum', async () => {
    const r = await part();
    const { feature } = await importFixture(r, 'flange.step');
    await r.doc.flush();
    const f = r.doc.state.get().doc.features[0] as ImportFeature;
    r.dispose();
    open.splice(open.indexOf(r), 1);
    forgetBreps();
    const e = r.folder.entries.get(f.brep.rel)!;
    const bytes = e.bytes.slice();
    bytes[bytes.length - 2] ^= 0x20;
    r.folder.put(f.brep.rel, bytes);
    const again = await part(r.folder);
    const rb = await settle(again.doc);
    expect(rb.features[feature]).toMatchObject({ state: 'error' });
    expect(rb.features[feature].message).toContain('changed (its checksum is not the one the Part recorded)');
  });
});
