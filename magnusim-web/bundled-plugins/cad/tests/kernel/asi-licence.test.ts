// @vitest-environment node
// Analysis Situs' licence notice against its vendored sources (kernel-build/asi/upstream/, inside
// mk32.wasm since kernel API 8): BSD-3-Clause asks that the copyright lines travel with the binary,
// and its LICENSE file has none, so LICENSES/AnalysisSitus-BSD-3-Clause.txt names every holder.
// This regenerates the holders from the 169 files' own headers and compares: a vendored file with a
// holder the notice does not name, or a notice naming one no file has, fails here. The two files
// under OCCT's LGPL (asiAlgo_UnifySameDomain.{h,cpp}) must be exactly the ones the notices name.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { PLUGIN } from './kernel-lib';

const UPSTREAM = join(PLUGIN, 'kernel-build', 'asi', 'upstream', 'src');
const NOTICE = join(PLUGIN, 'LICENSES', 'AnalysisSitus-BSD-3-Clause.txt');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** "Copyright (c) 2018-present, Sergey Slyadnev" / "Copyright (c) 2012-2014 OPEN CASCADE SAS" -> the holder. */
export function holderOf(line: string): string | null {
  const m = /Copyright\s*(?:\(c\))?\s*:?\s*(?:\d{4}(?:\s*-\s*(?:\d{4}|present))?\s*,?\s*)?(.+?)\s*$/i.exec(line);
  return m ? m[1].trim() : null;
}

it("names every copyright holder of the vendored Analysis Situs files, and only them; the LGPL files are the two named", () => {
  const all = files(UPSTREAM);
  expect(all).toHaveLength(169);
  const count = new Map<string, number>();
  const lgpl: string[] = [];
  for (const f of all) {
    const text = readFileSync(f, 'latin1');
    // The first "Copyright (c)" line of the file's header (the OCCT-derived header also has a
    // "Copyright: Open CASCADE 2014" line above its "Copyright (c) 2012-2014 OPEN CASCADE SAS").
    const line = text.split('\n').find((l) => /Copyright \(c\)/.test(l));
    expect(line, `${relative(UPSTREAM, f)} has no copyright line`).toBeDefined();
    const holder = holderOf(line!);
    expect(holder, line).toBeTruthy();
    count.set(holder!, (count.get(holder!) ?? 0) + 1);
    if (/GNU Lesser General Public License/.test(text.slice(0, 2000))) lgpl.push(relative(UPSTREAM, f).replace(/\\/g, '/'));
  }
  expect(Object.fromEntries([...count].sort())).toEqual({ 'Julia Slyadneva': 2, 'OPEN CASCADE SAS': 22, 'Quaoar Studio LLC': 8, 'Sergey Slyadnev': 137 });

  const notice = readFileSync(NOTICE, 'utf8').replace(/\r\n/g, '\n');
  const named = new Set(notice.split('\n').filter((l) => /^Copyright \(c\)/.test(l)).map((l) => holderOf(l)!));
  expect([...named].sort()).toEqual([...count.keys()].sort());
  expect(notice).toContain('3c3ec3ff077ef71eaee39dc062e01aada475808f');
  expect(notice).toContain('169 files');

  expect(lgpl.sort()).toEqual(['asiAlgo/auxiliary/asiAlgo_UnifySameDomain.cpp', 'asiAlgo/auxiliary/asiAlgo_UnifySameDomain.h']);
  expect(notice).toContain('src/asiAlgo/auxiliary/asiAlgo_UnifySameDomain.h and asiAlgo_UnifySameDomain.cpp');
  const readme = readFileSync(join(PLUGIN, 'LICENSES', 'README.md'), 'utf8');
  expect(readme).toContain('`asiAlgo_UnifySameDomain.{h,cpp}`: LGPL-2.1 with the Open CASCADE exception');
  // Since API 8 the code is in the kernel, and the notices say so.
  expect(readme).toMatch(/\| Analysis Situs 2026\.1\.1, asiAlgo[^|]*\| inside `workspace\/kernel\/mk32\.wasm`/);
  expect(readme).not.toContain('holds none of it');
});
