// Delete faces never shows a heal past the gap as a success (2026-10-30): a part's every face's
// edges rounded R2 by Fillet 1, then the blends selected, Delete faces, "Delete faces and heal".
//  1. heal-fill   an L-block (Extrude 60 x 40 x 20, Extrude Cut 30 x 40 x 10 off one end): OCCT's
//                 heal filled the step and the app showed Delete faces 1 ok with the volume chip
//                 at 48,000 mm³ (the full box). Now the heal is tried again in two goes: Delete
//                 faces 1 is ok and the chip shows the sharp L-block's 36,000 mm³, its 8 faces.
//  2. heal-tblock a T-block (a bar 60 x 40 x 10 on a stem 20 x 40 x 10), which two goes cannot
//                 make right (it was heal-refuse: red, "would add 16,39x mm³ over faces you kept"):
//                 kernel API 8 takes the fillets off as fillets (Analysis Situs). Delete faces 1 is
//                 ok, its panel's note and the tree row's info mark say "Taken off as fillets up to
//                 R2 by Analysis Situs: OCCT's heal could not do it cleanly", the chip shows the
//                 sharp T-block's 32,000 mm³, its 10 faces.
// Review 2026-10-30:
//  3. heal-boss   a plate with a boss joined on it, Fillet 1 of the boss's 4 vertical edges R2,
//                 Delete faces of the 4 rounds: ok, the chip at the sharp boss's 25,200 mm³ (it was
//                 red: "would add 20.6018 mm³ over faces you kept (End face of Extrude 1)", the
//                 corners' end caps on the plate read as a fill).
//  4. heal-loft   a ruled loft with a wavy top, Fillet 1 of the wavy face R1, Delete faces of the 4
//                 rounds: the check's boolean returned the whole body, so Delete faces 1 is a
//                 warning with "the kernel could not compare the result with the body before it:
//                 check the result" and the chip at the sharp loft's volume (it was red with the
//                 body's own 71,765.2 mm³ as "would add").
//  5. heal-large  a STEP part of over 2000 faces (the rounded L-block with a 2000-sided prism on it),
//                 its blends but one torus deleted: the heal fills the step, and the row is a
//                 warning, "this part is too large to compare the result with the body before it:
//                 check the result" (it was ok with no word).
//  6. pattern     a Linear pattern of the rounded L-block's blend faces (picked, then the
//                 command): red, "OCCT could not take those faces off Body 1 cleanly (healing
//                 filled more than the gap ...)", the chip as Fillet 1 left it.
// Kernel API 8 (Delete faces version 2, the Analysis Situs plan §3.4):
//  7. heal-refuse the T-block with a hole through its bar: its rims are rings, which cannot come off
//                 as fillets either. Red with the heal's words, then "; taking them off as fillets
//                 did not work either: 1 of the 42 fillet faces could not be taken off (a ring round a
//                 boss or a hole ...); the body is unchanged", the chip as Fillet 1 left it.
//  8. heal-rest   the T-block's fillets but one picked: red with "Every fillet up to R2 on Body 1 is
//                 40 faces and 39 are picked: with all 40, Delete faces can take them off as fillets"
//                 and the panel's "Add the rest (+1)"; pressed, the faces are 40, the row ok, the
//                 chip at 32,000 mm³.
//  9. heal-legacy the T-block's Delete faces as a Part saved before version 2 keeps it (the model
//                 file written here without the version, the Part read again): red with OCCT's
//                 refusal and "This Delete faces was made before Delete faces could take fillets
//                 off as fillets: a new Delete faces of these faces may do it", the chip as Fillet 1
//                 left it.
// Review 2026-11-02:
// 10. heal-rings  the T-block with a hole through its bar, every fillet but the hole's two rim rings
//                 picked: red, and the words say "Delete faces cannot take the fillets up to R2 on Body
//                 1 off as fillets: 2 of the 42 are rings round a boss or a hole", with no Add the rest
//                 (it said "with all 42, Delete faces can take them off as fillets" and offered the
//                 rims, which taking off as fillets then refused), the chip as Fillet 1 left it.
// Kernel API 9 (the budget's words):
// 11. heal-budget the T-block's fillets with the time Delete faces allows for taking them off as
//                 fillets lowered to 0.001 s (window.__CAD__.secondWay: suppress_blends' own
//                 budget_ms; no body that OCCT's heal refuses in time is over the real 1.4 s): red,
//                 the heal's words, then "; taking them off as fillets would take about 0.N s (40
//                 fillet faces on a body of 50 faces), and Delete faces allows 0.001 s for taking
//                 fillets off as fillets; the body is unchanged" (it said "did not work either:
//                 taking 40 fillet faces off as fillets on a body of 50 faces would take ..."), the
//                 chip as Fillet 1 left it (with the kernel's own 1.4 s they come off: heal-tblock).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSolid, featureRowNamed, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; secondWay: { budgetMs: number | null } } };

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      cad<boolean>(page, (() => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
      }) as never),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const volumeChip = (frame: FrameLocator) => frame.locator('[data-chip="volume"]');
const sizeChip = (frame: FrameLocator) => frame.locator('[data-chip="size"]');
const chipVolumes = (frame: FrameLocator) => volumeChip(frame).locator('[data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

/** The chip's one volume, read until it is `v` within `rel` (one body listed). */
async function expectOneVolume(frame: FrameLocator, v: number, rel = 1e-6) {
  await expect
    .poll(
      async () => {
        const vs = await chipVolumes(frame);
        return vs.length === 1 ? Math.abs(vs[0] / v - 1) : 1;
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(rel);
}

/** Select faces of the one body: all of them, or the ones not flat. */
async function selectFaces(page: Page, which: 'all' | 'round'): Promise<number> {
  return cad<number>(page, (async (w: string) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' })).result;
    const idx = t.faces.filter((f: { type: string }) => w === 'all' || f.type !== 'plane').map((f: { i: number }) => f.i);
    s.selection.set((st: object) => ({ ...st, items: idx.map((index: number) => ({ kind: 'face', body: b.id, index })) }));
    return idx.length;
  }) as never, which);
}

/** Fillet 1 of every face (radius 2, through the panel), then the blends selected, Delete faces, "Delete faces and heal". */
async function roundThenDelete(page: Page, frame: FrameLocator, faces: number, blends: number | null): Promise<number> {
  expect(await selectFaces(page, 'all')).toBe(faces);
  await runCommand(frame, 'modify.fillet');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Fillet 1');
  const radius = panel(frame).locator('.nui[data-field="radius"] input');
  await radius.fill('2');
  await radius.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
  const filleted = (await chipVolumes(frame))[0];
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  const picked = await selectFaces(page, 'round');
  if (blends !== null) expect(picked).toBe(blends);
  else expect(picked).toBeGreaterThan(faces);
  await runCommand(frame, 'modify.delete-faces');
  const dlg = frame.locator('[data-cad-dialog]');
  await expect(dlg.locator('h2')).toHaveText('Delete faces of Fillet 1?');
  await dlg.locator('[data-dialog-choice="faces"]').click();
  await expect(panel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
  return filleted;
}

const bodyFaces = (page: Page) => cad<number>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces) as never);
const sizeOf = async (frame: FrameLocator) => ((await sizeChip(frame).locator('[data-size-mm]').getAttribute('data-size-mm')) ?? '').split(',').map((v) => Math.round(Number(v) * 1e6) / 1e6);

test('cad:delete-faces-heal-fill Delete faces of every blend of a rounded L-block: ok, the chip shows the sharp L-block (36,000 mm³), not the box', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const block = await addSolid(page, { size: [60, 40, 20] });
  await addSolid(page, { at: [30, 0, 10], size: [30, 40, 10], op: 'cut', scope: [block.body!] });
  await settled(page);
  await expectOneVolume(frame, 36000);
  const filleted = await roundThenDelete(page, frame, 8, 30);
  expect(Math.abs(filleted / 35601.6258 - 1)).toBeLessThan(1e-6);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok');
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  // The sharp L-block (the heal in one go made the 60 x 40 x 20 box of 48,000 mm³).
  await expectOneVolume(frame, 36000);
  await expect(volumeChip(frame)).not.toContainText('48,000');
  await expect.poll(() => sizeOf(frame)).toEqual([60, 40, 20]);
  expect(await bodyFaces(page)).toBe(8);
  await shot(page, 'delete-faces-heal-fill');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  await expectOneVolume(frame, 36000);
  expect(seen.errors).toEqual([]);
});

const NOTE = "Taken off as fillets up to R2 by Analysis Situs: OCCT's heal could not do it cleanly";

/** The T-block: a bar 60 x 40 x 10 on a stem 20 x 40 x 10 (32,000 mm³), with a 8 mm hole through the bar at (10, 20) when `hole`. */
async function tBlock(page: Page, frame: FrameLocator, hole = false) {
  const bar = await addSolid(page, { at: [0, 0, 10], size: [60, 40, 10] });
  await addSolid(page, { at: [20, 0, 0], size: [20, 40, 10], op: 'join', scope: [bar.body!] });
  if (hole) await addSolid(page, { circle: true, at: [10, 20, 0], size: [8, 20], op: 'cut', scope: [bar.body!] });
  await settled(page);
  await expectOneVolume(frame, hole ? 32000 - Math.PI * 16 * 10 : 32000);
}

/** Fillet 1 of every face R2 through its panel, Done; its chip volume. */
async function roundAll(page: Page, frame: FrameLocator): Promise<number> {
  expect(await selectFaces(page, 'all')).toBe(await bodyFaces(page));
  return filletSelected(page, frame, '2');
}

/** Select the fillet faces of the one body: not flat, not the hole's wall (radius 4), but for the first `skip` of them; without the hole's rim rounds (tori round its axis at (10, 20)) when `rims` is false. */
async function selectFillets(page: Page, skip = 0, rims = true): Promise<number[]> {
  return cad<number[]>(page, (async (a: { n: number; rims: boolean }) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: false })).result;
    type F = { i: number; type: string; radius?: number; axis?: { origin: number[] } };
    const rim = (f: F) => f.type === 'torus' && !!f.axis && Math.abs(f.axis.origin[0] - 10) < 1e-6 && Math.abs(f.axis.origin[1] - 20) < 1e-6;
    const all = t.faces.filter((f: F) => f.type !== 'plane' && !(f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 4) < 1e-6) && (a.rims || !rim(f))).map((f: F) => f.i);
    const idx = all.slice(a.n);
    s.selection.set((st: object) => ({ ...st, items: idx.map((index: number) => ({ kind: 'face', body: b.id, index })) }));
    return all;
  }) as never, { n: skip, rims });
}

test('cad:delete-faces-heal-tblock Delete faces of every blend of a rounded T-block: OCCT cannot, the fillets come off as fillets: ok with the note, the chip at the sharp T-block (32,000 mm³)', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  await tBlock(page, frame);
  const faces0 = await bodyFaces(page);
  await roundThenDelete(page, frame, faces0, null);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  // Was red: "healing filled more than the gap ...: it would add 16,39x mm³ over faces you kept (...)".
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  await expect(panel(frame).locator('[data-note]')).toHaveText(`Note: ${NOTE}`);
  await expect(row.locator('[data-feature-badge="note"]')).toHaveAttribute('data-message', NOTE);
  await expectOneVolume(frame, 32000);
  await expect.poll(() => sizeOf(frame)).toEqual([60, 40, 20]);
  expect(await bodyFaces(page)).toBe(10);
  await expect(panel(frame).locator('[data-delete-rest]')).toHaveCount(0);
  await shot(page, 'delete-faces-heal-tblock');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  await expectOneVolume(frame, 32000);
  expect(seen.errors).toEqual([]);
});

test('cad:delete-faces-heal-refuse a rounded T-block with a hole through its bar: red, OCCT\'s words then why taking the fillets off failed too, the body and its chip unchanged', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  await tBlock(page, frame, true);
  const filleted = await roundAll(page, frame);
  expect(await selectFillets(page)).toHaveLength(42);
  await deleteSelected(page, frame, true);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(
    /^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add [\d,.]+ mm³ over faces you kept \([^)]*\); taking them off as fillets did not work either: 1 of the 42 fillet faces could not be taken off \(a ring round a boss or a hole cannot be taken off as a fillet\); the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead$/,
  );
  // Nothing to add: no Add the rest. The body as Fillet 1 left it.
  await expect(panel(frame).locator('[data-delete-rest]')).toHaveCount(0);
  await expectOneVolume(frame, filleted);
  await shot(page, 'delete-faces-heal-refuse');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'error');
  await expectOneVolume(frame, filleted);
  expect(seen.errors).toEqual([]);
});

test("cad:delete-faces-heal-budget the rounded T-block's fillets with the time allowed for taking them off as fillets lowered: red, how long it would take and what Delete faces allows, the body unchanged", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  await tBlock(page, frame);
  const filleted = await roundAll(page, frame);
  expect(await selectFillets(page)).toHaveLength(40);
  expect(await bodyFaces(page)).toBe(50);
  await cad(page, (() => {
    (window as unknown as W).__CAD__.secondWay.budgetMs = 1;
  }) as never);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  try {
    await deleteSelected(page, frame, true);
    await expect(row).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
    await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(
      /^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add [\d,.]+ mm³ over faces you kept \([^)]*\); taking them off as fillets would take about \d\.\d s \(40 fillet faces on a body of 50 faces\), and Delete faces allows 0\.001 s for taking fillets off as fillets; the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead$/,
    );
    await expect(panel(frame).locator('[data-run-reason]').first()).not.toContainText('did not work either');
    await expect(panel(frame).locator('[data-delete-rest]')).toHaveCount(0);
    await expectOneVolume(frame, filleted);
    await shot(page, 'delete-faces-heal-budget');
  } finally {
    await cad(page, (() => {
      (window as unknown as W).__CAD__.secondWay.budgetMs = null;
    }) as never);
  }
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'error');
  await expectOneVolume(frame, filleted);
  expect(seen.errors).toEqual([]);
});

test('cad:delete-faces-heal-rest the rounded T-block\'s fillets but one: red with every fillet up to R2 and how many are picked; Add the rest (+1) makes it the sharp T-block', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  await tBlock(page, frame);
  const filleted = await roundAll(page, frame);
  expect(await selectFillets(page, 1)).toHaveLength(40);
  await deleteSelected(page, frame, true);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(/\. Every fillet up to R2 on Body 1 is 40 faces and 39 are picked: with all 40, Delete faces can take them off as fillets$/);
  await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(39);
  await expectOneVolume(frame, filleted);
  const rest = panel(frame).locator('[data-delete-rest]');
  await expect(rest).toHaveText('Add the rest (+1)');
  await shot(page, 'delete-faces-heal-rest');
  await rest.click();
  await settled(page);
  await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(40);
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-note]')).toHaveText(`Note: ${NOTE}`);
  await expect(rest).toHaveCount(0);
  await expectOneVolume(frame, 32000);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  expect(seen.errors).toEqual([]);
});

test("cad:delete-faces-heal-rings the holed T-block's fillets but its hole's rim rings: red, and the words say the rings stop taking them off as fillets, with no Add the rest; the body unchanged", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  await tBlock(page, frame, true);
  const filleted = await roundAll(page, frame);
  expect(await selectFillets(page, 0, false)).toHaveLength(40);
  await deleteSelected(page, frame, true);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  const reason = panel(frame).locator('[data-run-reason]').first();
  await expect(reason).toHaveText(
    /^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add [\d,.]+ mm³ over faces you kept \([^)]*\); the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead\. Delete faces cannot take the fillets up to R2 on Body 1 off as fillets: 2 of the 42 are rings round a boss or a hole$/,
  );
  // It said "with all 42, Delete faces can take them off as fillets" and offered the two rims, which then were refused.
  await expect(reason).not.toContainText('can take them off as fillets');
  await expect(panel(frame).locator('[data-delete-rest]')).toHaveCount(0);
  await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(40);
  await expectOneVolume(frame, filleted);
  await shot(page, 'delete-faces-heal-rings');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'error');
  await expectOneVolume(frame, filleted);
  expect(seen.errors).toEqual([]);
});

test('cad:delete-faces-heal-legacy a Part whose Delete faces was saved before version 2 stays red as before, says a new Delete faces may take the fillets off, the body as Fillet 1 left it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  await tBlock(page, frame);
  const filleted = await roundAll(page, frame);
  expect(await selectFillets(page)).toHaveLength(40);
  await deleteSelected(page, frame, true);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });
  // The model file as a build before version 2 wrote it: the Delete faces with no version. Then the Part reads it again.
  const was = await cad<number | null>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const rel = `studies/${s.bridge.studyId}/model.json`;
    const text = new TextDecoder().decode(await s.bridge.files.read(rel));
    const model = JSON.parse(text);
    const df = model.doc.features.find((f: { type: string }) => f.type === 'delete_faces');
    const version = df.version ?? null;
    delete df.version;
    await s.bridge.files.write(rel, JSON.stringify(model));
    await s.doc.reload();
    return version;
  }) as never);
  expect(was).toBe(2);
  await settled(page);
  await expect(row).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(row.locator('[data-feature-badge="error"]')).toHaveAttribute(
    'data-message',
    /^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add 16,39\d\.\d+ mm³ over faces you kept \([^)]*\); the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead\. This Delete faces was made before Delete faces could take fillets off as fillets: a new Delete faces of these faces may do it$/,
  );
  await expectOneVolume(frame, filleted);
  await expect(volumeChip(frame)).not.toContainText('32,000');
  // Its panel says the same, and offers nothing to add (the pick is every fillet up to R2).
  await row.locator('> .tree-row').dblclick();
  await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(/a new Delete faces of these faces may do it$/);
  await expect(panel(frame).locator('[data-delete-rest]')).toHaveCount(0);
  await shot(page, 'delete-faces-heal-legacy');
  await panel(frame).locator('[data-panel-done]').click();
  expect(seen.errors).toEqual([]);
});

/** Select the edges of the one body that `which` keeps (by their topo rows). */
async function selectEdges(page: Page, which: 'boss-vertical'): Promise<number> {
  return cad<number>(page, (async (w: string) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'none', edges: 'all', vertices: 'none' })).result;
    const idx = t.edges.filter((e: { type: string; mid: number[] }) => w === 'boss-vertical' && e.type === 'line' && Math.abs(e.mid[2] - 13) < 1e-6).map((e: { i: number }) => e.i);
    s.selection.set((st: object) => ({ ...st, items: idx.map((index: number) => ({ kind: 'edge', body: b.id, index })) }));
    return idx.length;
  }) as never, which);
}

/** Select faces `idx` of the one body. */
async function selectFaceIndices(page: Page, idx: number[]) {
  await cad(page, ((a: number[]) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    s.selection.set((st: object) => ({ ...st, items: a.map((index) => ({ kind: 'face', body: b.id, index })) }));
  }) as never, idx);
}

/** The one body's faces: type, area, bbox. */
const bodyTopo = (page: Page) =>
  cad<{ i: number; type: string; area: number; bbox: number[] }[]>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    return (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'exact', face_mass: true })).result.faces;
  }) as never);

/** Fillet 1 of what is selected, radius `r` through the panel, ok; Done. Its chip volume. */
async function filletSelected(page: Page, frame: FrameLocator, r: string): Promise<number> {
  await runCommand(frame, 'modify.fillet');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Fillet 1');
  const radius = panel(frame).locator('.nui[data-field="radius"] input');
  await radius.fill(r);
  await radius.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
  const v = (await chipVolumes(frame))[0];
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  return v;
}

/** Delete faces of what is selected: the dialog's "Delete faces and heal" when it asks; the panel open, settled. */
async function deleteSelected(page: Page, frame: FrameLocator, ofFillet: boolean) {
  await runCommand(frame, 'modify.delete-faces');
  if (ofFillet) {
    const dlg = frame.locator('[data-cad-dialog]');
    await expect(dlg.locator('h2')).toHaveText('Delete faces of Fillet 1?');
    await dlg.locator('[data-dialog-choice="faces"]').click();
  }
  await expect(panel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
}

test("cad:delete-faces-heal-boss Delete faces of a boss's 4 corner rounds on its plate: ok, the chip at the sharp boss (25,200 mm³), not red", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const plate = await addSolid(page, { size: [60, 40, 10] });
  await addSolid(page, { at: [20, 15, 10], size: [20, 10, 6], op: 'join', scope: [plate.body!] });
  await settled(page);
  await expectOneVolume(frame, 25200);
  expect(await selectEdges(page, 'boss-vertical')).toBe(4);
  const filleted = await filletSelected(page, frame, '2');
  expect(Math.abs(filleted / (25200 - 4 * (4 - Math.PI) * 6) - 1)).toBeLessThan(1e-9);
  expect(await selectFaces(page, 'round')).toBe(4);
  await deleteSelected(page, frame, true);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok');
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  await expectOneVolume(frame, 25200);
  expect(await bodyFaces(page)).toBe(11);
  await shot(page, 'delete-faces-heal-boss');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  expect(seen.errors).toEqual([]);
});

/** A feature made through the document (setup, as a panel commits it), the camera left as it is; its id once built. */
async function add(page: Page, type: string, init: Record<string, unknown>): Promise<string> {
  const id = await cad<string>(page, ((a: { type: string; init: Record<string, unknown> }) => {
    const s = (window as unknown as W).__CAD__.services;
    const handle = s.viewport.get().handle;
    const lookAt = handle?.lookAt;
    if (handle) handle.lookAt = () => {};
    try {
      const f = s.doc.beginNew(a.type, a.init);
      f.commit();
      return f.feature as string;
    } finally {
      if (handle && lookAt) handle.lookAt = lookAt;
    }
  }) as never, { type, init });
  await settled(page);
  return id;
}

/** A 60 x 30 outline whose top edge is a wavy control spline (14 poles, amplitude 4), at height z (on Top, or on the plane feature `on`). */
function wavySketch(z: number, on: string | null): Record<string, unknown> {
  const n = 14;
  const P: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    P.push([60 * (1 - t), 30 + 4 * Math.sin(3 * Math.PI * t) * Math.sin(Math.PI * t)]);
  }
  P[1] = [P[1][0], 30];
  P[n - 2] = [P[n - 2][0], 30];
  const points: Record<string, number[]> = { a: [0, 0], b: [60, 0] };
  P.forEach((p, i) => (points[`s${i}`] = p));
  return {
    support: on ? { kind: 'feature', feature: on } : { kind: 'plane', plane: 'origin:top' },
    plane: { origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] },
    points,
    entities: [
      { id: 'e1', kind: 'line', p: ['a', 'b'] },
      { id: 'e2', kind: 'line', p: ['b', 's0'] },
      { id: 'e3', kind: 'spline', form: 'control', pts: P.map((_, i) => `s${i}`), degree: 3 },
      { id: 'e4', kind: 'line', p: [`s${n - 1}`, 'a'] },
    ],
    constraints: [],
    solved: { values: {}, dof: 2 * (n + 2), state: 'under' },
  };
}

/** A built sketch's one region, as a Loft keeps it. */
const regionRef = (page: Page, sketch: string) =>
  cad<Record<string, unknown>>(page, ((id: string) => {
    const r = (window as unknown as W).__CAD__.services.doc.state.get().rebuild.outputs[id].regions[0];
    return { sketch: id, region: r.key, entities: [...r.entities].sort(), sample: r.sample };
  }) as never, sketch);

test('cad:delete-faces-heal-loft Delete faces of the rounds of a wavy loft whose check cannot compare: a warning to check the result, the chip at the sharp loft', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const up = await add(page, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '40 mm' });
  const s1 = await add(page, 'sketch', wavySketch(0, null));
  const s2 = await add(page, 'sketch', wavySketch(40, up));
  await add(page, 'loft', { sections: [await regionRef(page, s1), await regionRef(page, s2)], ruled: true, op: 'new' });
  await expect(featureRowNamed(frame as never, 'Loft 1')).toHaveAttribute('data-state', 'ok');
  await expect.poll(async () => (await chipVolumes(frame)).length, { timeout: 30_000 }).toBe(1);
  const sharp = (await chipVolumes(frame))[0];
  const wavy = (await bodyTopo(page)).filter((f) => f.type !== 'plane');
  expect(wavy).toHaveLength(1);
  await selectFaceIndices(page, [wavy[0].i]);
  await filletSelected(page, frame, '1');
  const faces = (await bodyTopo(page)).filter((f) => f.type !== 'plane');
  const big = faces.reduce((m, f) => (f.area > m.area ? f : m));
  const rounds = faces.filter((f) => f.i !== big.i).map((f) => f.i);
  expect(rounds).toHaveLength(4);
  await selectFaceIndices(page, rounds);
  await deleteSelected(page, frame, true);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'warning');
  await expect(panel(frame).locator('[data-warning]')).toHaveText('the kernel could not compare the result with the body before it: check the result', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  // The sharp loft again (OCCT's one-go heal: 71,765.227 mm³ against 71,765.210).
  await expectOneVolume(frame, sharp, 1e-6);
  await shot(page, 'delete-faces-heal-loft');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'warning');
  expect(seen.errors).toEqual([]);
});

test('cad:delete-faces-heal-large Delete faces on a STEP part of over 2000 faces whose heal fills a step: a warning to check the result, not ok', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  // Made in code with the app's kernel: the L-block with every edge R2 and a 2000-sided prism standing on its top (one solid, 2039 faces), as STEP.
  const b64 = await cad<string>(page, (async () => {
    const k = (window as unknown as W).__CAD__.services.kernel;
    const c = async (op: string, p: Record<string, unknown>) => (await k.call(op, p)).result;
    const box = async (d: number[], o: number[]) => (await c('box', { dx: d[0], dy: d[1], dz: d[2], origin: o })).id;
    const L = (await c('boolean', { op: 'cut', targets: [await box([60, 40, 20], [0, 0, 0])], tools: [await box([31, 42, 11], [30, -1, 10])] })).id;
    const es = (await c('topo', { id: L, faces: 'none', edges: 'all', vertices: 'none' })).edges.map((e: { i: number }) => e.i);
    const fl = (await c('fillet', { id: L, edges: es, r: 2 })).id;
    const n = 2000;
    const pt = (i: number) => [15 + 8 * Math.cos((2 * Math.PI * i) / n), 20 + 8 * Math.sin((2 * Math.PI * i) / n)];
    const loop = Array.from({ length: n }, (_, i) => ({ id: `l${i}`, kind: 'line', a: pt(i), b: pt((i + 1) % n) }));
    const prism = (await c('extrude', { profile: { plane: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] }, loops: [loop] }, extent: { kind: 'blind', d: 10 } })).id;
    const both = (await c('boolean', { op: 'fuse', targets: [fl], tools: [prism] })).id;
    const step = (await k.call('export_step', { shapes: [{ id: both, name: 'Large' }], schema: 'AP214' })).buffers.step as ArrayBuffer;
    let bin = '';
    const u8 = new Uint8Array(step);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }) as never);
  const file = join(tmpdir(), `cad-e2e-large-${process.pid}-${Date.now()}.step`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  const chooser = page.waitForEvent('filechooser');
  await frame.locator('[data-cad-toolbar] [data-command="file.import-step"]').click();
  await (await chooser).setFiles(file);
  await expect(panel(frame).locator('[data-feature-panel="import"]')).toBeVisible();
  await expect(panel(frame).locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await settled(page);
  expect(await bodyFaces(page)).toBeGreaterThan(2000);
  // A part this large shows its volume on request: read it from the kernel.
  const bodyVolume = () => cad<number>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    return (await s.kernel.call('props', { id: s.doc.state.get().rebuild.bodies[0].shape, volume: true, bbox: 'none' })).result.volume;
  }) as never);
  const v0 = await bodyVolume();
  const faces = await bodyTopo(page);
  const blends = faces.filter((f) => f.type !== 'plane' && f.bbox[3] < 61);
  expect(blends).toHaveLength(30);
  const torus = blends.find((f) => f.type === 'torus')!;
  await selectFaceIndices(page, blends.filter((f) => f.i !== torus.i).map((f) => f.i));
  await deleteSelected(page, frame, false);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'warning', { timeout: 120_000 });
  await expect(panel(frame).locator('[data-warning]')).toHaveText('this part is too large to compare the result with the body before it: check the result');
  // What the person is asked to check: the heal filled the step (12,393.6 mm³ more).
  expect((await bodyVolume()) - v0).toBeGreaterThan(12_000);
  await shot(page, 'delete-faces-heal-large');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(row).toHaveAttribute('data-state', 'warning');
  expect(seen.errors).toEqual([]);
});

test("cad:delete-faces-heal-pattern a Linear pattern of a rounded L-block's blend faces: red with the heal's words, the chip as Fillet 1 left it", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const block = await addSolid(page, { size: [60, 40, 20] });
  await addSolid(page, { at: [30, 0, 10], size: [30, 40, 10], op: 'cut', scope: [block.body!] });
  await settled(page);
  expect(await selectFaces(page, 'all')).toBe(8);
  const filleted = await filletSelected(page, frame, '2');
  expect(await selectFaces(page, 'round')).toBe(30);
  await runCommand(frame, 'pattern.linear');
  await expect(panel(frame).locator('[data-feature-panel="pattern_linear"]')).toBeVisible();
  await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(30);
  await panel(frame).locator('[data-pick-field="dir1"] [data-pick-list]').click();
  await frame.locator('[data-tree-node="origin:x"] > .tree-row').click();
  for (const [field, value] of [['dir1-count', '2'], ['dir1-distance', '70']]) {
    const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
    await input.fill(value);
    await input.press('Enter');
  }
  await settled(page);
  const row = featureRowNamed(frame as never, 'Linear pattern 1');
  await expect(row).toHaveAttribute('data-state', 'error');
  await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(/^Linear pattern 1 failed: OCCT could not take those faces off Body 1 cleanly \(healing (filled more than the gap the deleted faces leave: it would add [\d,.]+ mm³ over faces you kept|would also take away faces you kept) \(/, { timeout: 30_000 });
  await expectOneVolume(frame, filleted);
  await shot(page, 'delete-faces-heal-pattern');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'error');
  await expectOneVolume(frame, filleted);
  expect(seen.errors).toEqual([]);
});
