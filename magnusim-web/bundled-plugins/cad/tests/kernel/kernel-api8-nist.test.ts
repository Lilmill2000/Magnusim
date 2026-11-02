// @vitest-environment node
// Kernel API 8 on real exported STEP (optional, local only): the NIST MBE PMI test parts
// (CTC 01-05, FTC 06-11, "AP203 geometry only"), which NIST publishes for use without
// restriction. They are never committed: ASI_CORPUS_DIR names the folder holding them (as
// unzipped from NIST-PMI-STEP-Files.zip, nist.gov/document/nist-pmi-step-files), and each file is
// checked against its sha256 here. Without it the test is skipped and says so. What it records
// (2026-11-01, dev kernel): recognition answers on every part within the time limit, every index
// is a face of the part, and suppress_blends either gives a checked result or refuses in words;
// on these parts it refused every pick tried (engraved-text arcs read as R0.4-R4.5 fillets, and
// chains whose neighbours it cannot rebuild).
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { call, loadKernel, tryCall, type R } from './kernel-lib';
import { api8Gate } from './asi-lib';

const k = await loadKernel();
const { describe8 } = api8Gate(k);
const DIR = process.env.ASI_CORPUS_DIR || '';

/** The geometry-only files: name, sha256, solid faces (NIST-PMI-STEP-Files.zip of 2024-06-19). */
const FILES: [string, string, number][] = [
  ['nist_ctc_01_asme1_rd.stp', 'e081d518484d5c708c6729353237f94a7d97da2b74a10d60d4c0d146d67a5855', 139],
  ['nist_ctc_02_asme1_rc.stp', 'e6df6d0ed68fd8a91bd3f8360c7047f2af3d61068b89050d84423fe8ddb93bcf', 663],
  ['nist_ctc_03_asme1_rc.stp', '95a775b1acdbc34de11319cb83b4cf6c6fdd7de8cbfc4af2d0afe5d3565cfdf8', 139],
  ['nist_ctc_04_asme1_rd.stp', 'cdb59a085a3364941b881f96b511265a7cb5f6e94180c4426bdc3025481f405a', 517],
  ['nist_ctc_05_asme1_rd.stp', '5140b8f41fa1d0a069ea978e28c92a597f47220d0a11e667b79ff5f7c7243b86', 208],
  ['nist_ftc_06_asme1_rd.stp', '5e30f0903f9470c14a98e70395ca005fe90bcd3fb704c381a80a69958838f169', 144],
  ['nist_ftc_07_asme1_rd.stp', 'a0bc551656780b26d7a0ee1beedbc07d43f41efa092f74f3c2d8383417f04481', 269],
  ['nist_ftc_08_asme1_rc.stp', '4b7011b0b86cf6301058aa954b76a9587d23478b6dee2660f4a80caf0dfe8b73', 270],
  ['nist_ftc_09_asme1_rd.stp', 'e29c09bd2d454601ff1a0d77c4c4ffaf2ed78eee71031ce49f7b7bb5a6d1d4e8', 158],
  ['nist_ftc_10_asme1_rb.stp', '2bd726f9fe86aeb96ab517ce876e5696e7951310df5c4fbca36276d65879067b', 214],
  ['nist_ftc_11_asme1_rb.stp', 'a5abfea460499dc31bc812aca68917948a117565fea4f5a080e36eb32f39650d', 6],
];

const where = (name: string) => [join(DIR, name), join(DIR, 'AP203 geometry only', name)].find((p) => existsSync(p));

describe8('recognize and suppress_blends on the NIST MBE PMI parts (API 8, local corpus)', () => {
  const run = DIR ? it : it.skip;
  run(`every part: recognized in time, indices checked, suppression checked or refused in words${DIR ? '' : ' [skipped: not fetched: set ASI_CORPUS_DIR to the NIST-PMI-STEP-Files folder]'}`, () => {
    const rows: R[] = [];
    for (const [name, sha, faces] of FILES) {
      const path = where(name);
      expect(path, `${name} is not in ${DIR}`).toBeDefined();
      const bytes = new Uint8Array(readFileSync(path!));
      expect(createHash('sha256').update(bytes).digest('hex'), `${name}: not the NIST file this test pins`).toBe(sha);
      const imp = call(k, 'import_step', { ...k.putBytes(bytes), name, heal: true, tol: 1e-3 });
      // One solid (CTC-02 also carries a loose one-face sheet, imported beside it).
      const solids = (imp.shapes as R[]).filter((x) => x.type === 'solid');
      expect(solids, name).toHaveLength(1);
      const id = solids[0].id as number;
      expect(solids[0], name).toMatchObject({ faces });
      const t0 = performance.now();
      const rec = call(k, 'recognize', { id });
      const ms = performance.now() - t0;
      expect(ms, name).toBeLessThan(3000);
      const types = (call(k, 'topo', { id, edges: 'none', vertices: 'none', face_mass: false, face_bbox: 'none' }).faces as R[]).map((f) => f.type);
      for (const b of rec.blends) expect(types[b.face], `${name} face ${b.face}`).not.toBe('plane');
      for (const h of rec.holes) {
        expect(h.faces.length, name).toBeGreaterThan(0);
        expect(h.faces.every((i: number) => i >= 0 && i < faces), name).toBe(true);
        if (h.d_min !== null) expect(h.d_min, name).toBeLessThanOrEqual(h.d_max);
      }
      // Every fillet up to the smallest radius Analysis Situs reads, as suppress_blends takes them.
      const smallest = Math.min(...rec.blends.map((b: R) => b.r));
      const picks = call(k, 'recognize', { id, holes: false, max_r: smallest * 1.001 }).blends.map((b: R) => b.face);
      const s = tryCall(k, 'suppress_blends', { id, faces: picks });
      if (s.ok) {
        expect(s.valid, name).not.toBe(false);
        expect(s.faces, name).toBeLessThan(faces);
        expect(s.self_check, name).toMatchObject({ split: 0, stale_leaves: 0, dropped: 0 });
      } else {
        expect(['input', 'occt'], name).toContain(s.kind);
        expect(String(s.error).length, name).toBeGreaterThan(10);
      }
      rows.push({ part: name, faces, blends: rec.blends.length, chains: rec.chains.length, holes: rec.holes.length, recognize_ms: Math.round(ms), smallest_r: +smallest.toFixed(3), picks: picks.length, suppress: s.ok ? `${faces} -> ${s.faces} faces` : String(s.error) });
      call(k, 'release', { all: true });
    }
    console.table(rows);
  }, 120_000);
});
