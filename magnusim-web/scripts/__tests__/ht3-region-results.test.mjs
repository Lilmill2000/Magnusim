import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseRegionNames, caseRegions, listFoamTimeDirs, timeFieldDirs } from '../project-layout.js';
import { caseShownFields } from '../vite-plugin-case-fields.js';

// HT3: a multi-region case (python/tests/fixtures/cht-case, a solved two-region
// chtMultiRegionSimpleFoam case) keeps a saved time's fields in a folder per
// region. Its regions come from its sidecar; a time is a frame when every region
// wrote one of its frame fields; its fields are every region's.
const HERE = dirname(fileURLToPath(import.meta.url));
const CHT = join(HERE, '..', '..', 'python', 'tests', 'fixtures', 'cht-case');

function copyCase() {
  const dir = join(mkdtempSync(join(tmpdir(), 'ht3-')), 'case');
  cpSync(CHT, dir, { recursive: true });
  return dir;
}

describe('a multi-region case', () => {
  it('lists its regions from its sidecar', () => {
    assert.deepEqual(caseRegions(CHT), [
      { name: 'air', role: 'fluid' },
      { name: 'aluminium_6061', role: 'solid' },
    ]);
    assert.deepEqual(caseRegionNames(CHT), ['air', 'aluminium_6061']);
    assert.deepEqual(timeFieldDirs(CHT, '3'), [join(CHT, '3', 'air'), join(CHT, '3', 'aluminium_6061')]);
  });

  it('reads no regions from a list that is not valid, or from a case of one region', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ht3-bad-'));
    try {
      writeFileSync(join(dir, 'w27-case.json'), JSON.stringify({ regions: [{ name: 'a b', role: 'fluid' }] }));
      assert.deepEqual(caseRegions(dir), []);
      writeFileSync(join(dir, 'w27-case.json'), JSON.stringify({ frame_fields: ['T'] }));
      assert.deepEqual(caseRegions(dir), []);
      assert.deepEqual(timeFieldDirs(dir, '1'), [join(dir, '1')]);
      // One folder on Windows: names that differ only in case; names a case file has; too many.
      for (const regions of [
        [{ name: 'Air', role: 'fluid' }, { name: 'air', role: 'solid' }],
        [{ name: 'g', role: 'fluid' }],
        [{ name: 'FvSchemes', role: 'solid' }],
        [{ name: 'Processor1', role: 'solid' }],
        [{ name: 'Constant', role: 'fluid' }],
        [{ name: 'VTK', role: 'solid' }],
        [{ name: 'postProcessing', role: 'solid' }],
        Array.from({ length: 33 }, (_, i) => ({ name: `r${i}`, role: 'solid' })),
      ]) {
        // A folder each: the reading is cached by the sidecar's time.
        const one = mkdtempSync(join(dir, 'r-'));
        writeFileSync(join(one, 'w27-case.json'), JSON.stringify({ regions }));
        assert.deepEqual(caseRegions(one), [], JSON.stringify(regions[0]));
      }
      // Other keys in a row (RunInputs.mesh.regions rows) are ignored.
      const rows = mkdtempSync(join(dir, 'r-'));
      writeFileSync(join(rows, 'w27-case.json'), JSON.stringify({ regions: [{ name: 'air', role: 'fluid', bodies: ['Body1'], cells: 3 }] }));
      assert.deepEqual(caseRegions(rows), [{ name: 'air', role: 'fluid' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists a time as a frame when every region wrote its frame field', () => {
    const dir = copyCase();
    try {
      writeFileSync(join(dir, 'w27-case.json'), JSON.stringify({ regions: caseRegions(CHT), frame_fields: ['T'] }));
      assert.deepEqual(listFoamTimeDirs(dir, { complete: true }), ['0', '3']);
      // A time only the air has written yet (a half-copied frame) is not one.
      mkdirSync(join(dir, '5', 'air'), { recursive: true });
      writeFileSync(join(dir, '5', 'air', 'T'), 'x');
      assert.deepEqual(listFoamTimeDirs(dir, { complete: true }), ['0', '3']);
      assert.deepEqual(listFoamTimeDirs(dir), ['0', '3', '5']);
      // The rule solve.sh copies a frame back by: one of the frame fields in every
      // region (k, a frame field no region wrote, does not hold a frame back).
      const tk = copyCase();
      writeFileSync(join(tk, 'w27-case.json'), JSON.stringify({ regions: caseRegions(CHT), frame_fields: ['T', 'k'] }));
      assert.deepEqual(listFoamTimeDirs(tk, { complete: true }), ['0', '3']);
      rmSync(dirname(tk), { recursive: true, force: true });
      // U is the fluid's only: no time is a frame (the runner refuses such a case).
      const u = copyCase();
      writeFileSync(join(u, 'w27-case.json'), JSON.stringify({ regions: caseRegions(CHT), frame_fields: ['U'] }));
      assert.deepEqual(listFoamTimeDirs(u, { complete: true }), []);
      rmSync(dirname(u), { recursive: true, force: true });
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  it("lists every region's fields", () => {
    assert.deepEqual(caseShownFields(CHT, '3'), ['T', 'magU', 'p', 'p_rgh', 'rho']);
  });
});
