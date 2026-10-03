// @vitest-environment node
// Daniel's STEP files are read where they are (CAD_E2E_VORTEX_STEP, CAD_E2E_BIG_STEP,
// CAD_KERNEL_BIG_STEP) and never copied into the plugin. Review P2/P3 round 3: the
// Vortex part sat in fixtures/kernel/ and the P2 kernel tests read the copy. This
// test looks at every file in the plugin (not node_modules, the build cache or test
// output) with the size of one of his files and fails when its bytes are his.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url));
const SKIP = new Set(['node_modules', '.cache', 'test-results', '.git']);

/** His files by size -> sha256: the two the tests use, and every STEP beside the Vortex part when that folder is here. */
function hisFiles(): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const add = (size: number, sha: string) => out.set(size, (out.get(size) ?? new Set()).add(sha));
  add(64_518, 'd40156af7c86297bc061a5beef6ad89a1878fe25c7b57081b09648c522c71e5b'); // Vortex CFD Test.step
  add(118_565_907, '9d979d08696818942e4e9b05030836a6d44dd043bbf00ccdc84931767a36236b'); // 8m0119333_V12.step
  const vortex = process.env.CAD_E2E_VORTEX_STEP || 'C:/Users/drmil/Desktop/3D/Step Files/Vortex CFD Test.step';
  const folder = dirname(vortex);
  if (existsSync(folder)) {
    for (const name of readdirSync(folder)) {
      const p = join(folder, name);
      if (!/\.(step|stp)$/i.test(name) || !statSync(p).isFile()) continue;
      const size = statSync(p).size;
      if (size < 50_000_000) add(size, sha256(p));
    }
  }
  return out;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

describe("Daniel's STEP files", () => {
  it('no file in the plugin is a copy of one', () => {
    const his = hisFiles();
    const copies: string[] = [];
    let looked = 0;
    for (const p of files(PLUGIN)) {
      const want = his.get(statSync(p).size);
      if (!want) continue;
      looked++;
      if (want.has(sha256(p))) copies.push(relative(PLUGIN, p));
    }
    expect(copies, `copies of Daniel's files (read his files by path instead; ${looked} same-size files checked)`).toEqual([]);
  });
});
