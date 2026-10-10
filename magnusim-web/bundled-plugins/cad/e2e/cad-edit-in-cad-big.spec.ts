// Edit in CAD on Daniel's 113 MB STEP (opt-in: CAD_KERNEL_BIG_STEP or CAD_E2E_BIG_STEP; the
// test skips without it, shard big). It logs the timings of each step: the app's own import
// in the simulation view, then in the Part the STEP from the app (source), the import with
// its heal (import) and the face matching (adopt, with matched/total); Back with no change
// then links nothing. The plan's figure for the first open is about 45 s.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { backUnchanged, edit, editOpened, importGeometry, linkedOf, metaOf, newProject, openProject, startEditHost, stopEditHost, timingsNote, treeMenuItem } from './edit-in-cad-helpers';

const BIG = process.env.CAD_KERNEL_BIG_STEP || process.env.CAD_E2E_BIG_STEP || '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  if (BIG && existsSync(BIG)) await startEditHost('cad-edit-in-cad-big', 50);
});
test.afterAll(() => stopEditHost());

test('cad:edit-big-step the 113 MB STEP: Edit in CAD opens it, its faces matched; the timings are logged; Back with no change links nothing', { tag: '@serial' }, async ({ page, request }, info) => {
  test.skip(!BIG || !existsSync(BIG), 'CAD_KERNEL_BIG_STEP is not set (opt-in: the 113 MB STEP)');
  test.setTimeout(3_600_000);
  const pid = await newProject(request, `CAD edit big ${Date.now()}`);
  const t0 = Date.now();
  const geom = await importGeometry(request, pid, BIG, 'big.step');
  const m0 = await metaOf(request, pid, geom.id);
  const hostImport = Date.now() - t0;
  await openProject(page, pid);
  const t1 = Date.now();
  await (await treeMenuItem(page, geom.id)).click();
  const { sid } = await editOpened(page, pid, 1_800_000);
  const open = Date.now() - t1;
  const e = await edit(page);
  timingsNote(info, 'big-step', { host_import: hostImport, open_to_ready: open, ...e.timings }, { matched: e.adopt?.matched, total: e.adopt?.total, hostFaces: m0.faces.length });
  expect(e.adopt?.total).toBe(m0.faces.length);
  await backUnchanged(page, pid);
  expect(await linkedOf(request, pid, sid)).toBeNull();
});
