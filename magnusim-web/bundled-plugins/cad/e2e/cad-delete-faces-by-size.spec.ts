// MODIFY > Delete faces: Add by size and box select while the panel is open (S5, the Analysis Situs
// plan §3.3), as the person sees them.
//  1. by-size     the rounded block (e2e/rounded-block.ts: R5 verticals, R2 round the top, four 6 mm
//                 holes, a 6/10 mm counterbore) made in the page, written to STEP and imported.
//                 Delete faces with nothing selected (the Part's one solid body): the sizes start at
//                 1 mm and Ø 2 mm (its 96.4 mm diagonal / 50 and / 20). Fillets up to 2, Enter:
//                 "Faces to delete (8)", "Added 8 faces: 1 fillet chain, R2", the row ok and the chip
//                 at the sharp block's volume. Holes up to Ø 6, Add: "(4 through)", 12 faces, the
//                 chip with the holes filled. Again: the words of what Body 1 has, nothing added. With
//                 the page's holes' face limit lowered (kernel API 9: fillets and holes each have
//                 one), Holes Add says both limits in Find's words and Fillets Add still searches
//                 (what Body 1 has, as before). A Ctrl+drag box
//                 on an R5 vertical while the panel is open adds the faces it touches (the count
//                 rises; without useBoxPicks it stays).
//  2. by-size-tblock  Add by size meets the second way (S6): a T-block, Fillet 1 of every face R2,
//                 then Delete faces with nothing selected, Fillets up to 2, Enter: the 40 fillet
//                 faces; OCCT's heal cannot, they come off as fillets: the row ok with the note
//                 "Taken off as fillets up to R2 by Analysis Situs ...", the chip at 32,000 mm³.
//  3. by-size-tblock-corners  round 2 (kernel API 9, the third way): a T-block, Fillet 1 of every
//                 edge but the 8 lateral ones R2, then Fillet 2 of the 8 lateral edges R1 (each R1
//                 round ends in two small B-spline corner pieces where it meets the R2 fillets);
//                 Delete faces with nothing selected, Fillets up to 1, Enter: "Added 8 faces: 8
//                 fillet chains, R1" (the corner pieces read R1.02). OCCT's heal of them grows those
//                 pieces 36 mm past their 2 mm and ran 568 s natively before it failed; in the app the
//                 kernel's 20 s watchdog stopped it ("Delete faces 1 was stopped after 20.0 s", a
//                 kernel restart). Now the kernel does not start a heal that would grow a small
//                 curved face that far, taking them off as fillets refuses at once, and each round
//                 comes off with its 2 corner pieces, one at a time: the row ok well within 20 s with
//                 the note "Taken off one round at a time, with the 16 corner faces ...: OCCT's heal
//                 was not run: it would grow 16 small curved faces up to 10 times their size, which
//                 failed or ran past 20 s on every part measured" (it said, as a forecast, that the
//                 heal would "not finish"), the chip at the T-block with only Fillet 1 (31,731.445
//                 mm³, measured here as the reference), no kernel restart.
//  4. by-size-tblock-corners-refused  the T-block rounded the other way (R1 along y first, then
//                 R2: tori at the concave rounds' ends), made in the page as STEP, with the third
//                 way's time for each round lowered to 1 ms (window.__CAD__.corners): red, its words
//                 name OCCT's heal (run after the other two ways with its whole 20 s, never a shorter
//                 one, and stopped by it), taking them off as fillets and with the corner faces, each
//                 once, then that the body is unchanged; no kernel restart.
//  5. by-size-heal-time  OCCT's heal's time limit (kernel API 9): a comb's 20 rounds R1 on a body
//                 whose every surface is a B-spline (made in the page as STEP), whose heal took 58 s
//                 (the watchdog stopped it at 20 s): Fillets up to 1, Enter: red with "OCCT's heal
//                 did not finish in 20.0 s; taking them off as fillets did not work either: ...; the
//                 body is unchanged", the chip unchanged, no kernel restart. The heal has the whole
//                 20 s its call had (it had 16 s, which stopped heals that end ok in 16-19 s).
//  6. by-size-flat-bspline  review 2026-11-02: a heat sink (a 70 x 30 x 4 base, 5 fins 60 x 1 x 10
//                 set 5 mm in, fin tops R0.4) whose every surface is a B-spline (made in the page as
//                 STEP): Fillets up to 0.4, Enter: its 10 fin rounds; OCCT's heal grows the flat
//                 B-spline fin ends 6 times their size and ends ok in seconds, as it did before API 9.
//                 The row is not red, has no note (OCCT's heal did it), and the chip shows the sharp
//                 sink (11,400 mm³); no kernel restart. It was red in 3 s: "OCCT's heal did not
//                 finish in 2.5 s: it grows 10 small curved faces far past their size; ...".
// Without S5 there is no data-delete-add (step 1 fails at once), and the box step fails without
// useBoxPicks.
// Review 2026-11-02: in by-size, Holes up to Ø 5.95 first adds nothing and says what Body 1 has (<=
// had the plain size's 1 %: it added the four 6 mm holes as "4 holes up to Ø5.95 mm (4 through)").
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, featureRowNamed, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';
import { ctrlBox, importRoundedBlock, r5OnPage, type RoundedBlockMade } from './rounded-block';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; recognition: { maxFilletFaces: number; maxHoleFaces: number } } };

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

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
const picked = (frame: FrameLocator) => panel(frame).locator('[data-pick-field="faces"] [data-pick-row]');
const pickLabel = (frame: FrameLocator) => panel(frame).locator('[data-pick-field="faces"] .cad-pick-label');
const sizeInput = (frame: FrameLocator, kind: 'fillets' | 'holes') => panel(frame).locator(`.nui[data-field="add-${kind}"] input`);
const addButton = (frame: FrameLocator, kind: 'fillets' | 'holes') => panel(frame).locator(`[data-delete-add="${kind}"]`);
const added = (frame: FrameLocator) => panel(frame).locator('[data-delete-added]');
const chipVolumes = (frame: FrameLocator) => frame.locator('[data-chip="volume"] [data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

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

/** MODIFY > Delete faces with nothing selected: its panel, no face picked. */
async function openEmpty(page: Page, frame: FrameLocator) {
  await cad(page, (() => (window as unknown as W).__CAD__.services.selection.set((s: object) => ({ ...s, items: [] }))) as never);
  await runCommand(frame, 'modify.delete-faces');
  await expect(panel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await expect(picked(frame)).toHaveCount(0);
}

const HOLES_FILLED = 4 * Math.PI * 3 * 3 * 20;

test('cad:delete-faces-by-size Fillets up to and Holes up to add faces by size on an imported STEP part, say what they added, refuse in words; a Ctrl+drag box adds faces while the panel is open', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  const made = await importRoundedBlock(page, frame);
  await settled(page);
  await expectOneVolume(frame, made.volume);

  // MODIFY > Delete faces, nothing selected: the rows, the sizes from the block's box, the hint.
  await openEmpty(page, frame);
  await expect(panel(frame).locator('[data-delete-by-size] [data-field-row="add-fillets"]')).toContainText('Fillets up to');
  await expect(panel(frame).locator('[data-delete-by-size] [data-field-row="add-holes"]')).toContainText('Holes up to');
  await expect(panel(frame).locator('[data-delete-by-size] [data-field-row="add-holes"] .cad-delete-add-lead')).toHaveText('Ø');
  await expect(sizeInput(frame, 'fillets')).toHaveValue('1');
  await expect(sizeInput(frame, 'holes')).toHaveValue('2');
  await expect(addButton(frame, 'fillets')).toHaveText('Add');
  await expect(addButton(frame, 'fillets')).not.toHaveAttribute('data-disabled-reason', /./);
  await expect(panel(frame).locator('[data-delete-hint]')).toHaveText('The faces around each deleted face grow to close the gap (holes, fillets, bosses). Fillets up to and Holes up to add faces by size.');

  // Fillets up to 2 mm, Enter: the 8 R2 faces round the top; the row ok, the chip at the sharp block.
  await sizeInput(frame, 'fillets').fill('2');
  await sizeInput(frame, 'fillets').press('Enter');
  await expect(added(frame)).toHaveText('Added 8 faces: 1 fillet chain, R2', { timeout: 60_000 });
  await expect(pickLabel(frame)).toHaveText('Faces to delete (8)');
  await expect(picked(frame)).toHaveCount(8);
  await expect(panel(frame).locator('[data-delete-body]')).toHaveText('Body 1');
  await settled(page);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expectOneVolume(frame, made.sharp);
  await shot(page, 'delete-faces-by-size-fillets');

  // Holes up to Ø 5.95 mm, just under the bores: nothing added, and what Body 1 has.
  await sizeInput(frame, 'holes').fill('5.95');
  await addButton(frame, 'holes').click();
  await expect(added(frame)).toHaveText('No holes up to Ø5.95 mm on Body 1 that are not already picked (Body 1 has 5 drilled holes, Ø6 to Ø10)', { timeout: 60_000 });
  await expect(pickLabel(frame)).toHaveText('Faces to delete (8)');

  // Holes up to Ø 6 mm, Add: the four 6 mm holes, through; the chip with them filled.
  await sizeInput(frame, 'holes').fill('6');
  await addButton(frame, 'holes').click();
  await expect(added(frame)).toHaveText('Added 4 faces: 4 holes up to Ø6 mm (4 through)', { timeout: 60_000 });
  await expect(pickLabel(frame)).toHaveText('Faces to delete (12)');
  await settled(page);
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expectOneVolume(frame, made.sharp + HOLES_FILLED);
  await shot(page, 'delete-faces-by-size-holes');

  // Again: nothing new to add, and what Body 1 has (as it is before this Delete faces), in words.
  await addButton(frame, 'fillets').click();
  await expect(added(frame)).toHaveText('No fillets up to 2 mm on Body 1 that are not already picked (Body 1 has 12 fillet faces, R2 to R5)', { timeout: 60_000 });
  await expect(added(frame)).toHaveAttribute('data-delete-added', 'none');
  await expect(picked(frame)).toHaveCount(12);

  // With the page's holes' limit lowered (as a part over 2,600 faces meets it): Find's words naming
  // both limits, nothing added; fillets are still searched (their limit is 5,000).
  await cad(page, (() => {
    (window as unknown as W).__CAD__.recognition.maxHoleFaces = 10;
  }) as never);
  try {
    await addButton(frame, 'holes').click();
    await expect(added(frame)).toHaveText('Body 1 has 25 faces: holes are found on bodies of up to 10 faces and fillets on bodies of up to 5,000 faces. Select its faces in the view instead.', { timeout: 60_000 });
    await expect(picked(frame)).toHaveCount(12);
    await addButton(frame, 'fillets').click();
    await expect(added(frame)).toHaveText('No fillets up to 2 mm on Body 1 that are not already picked (Body 1 has 12 fillet faces, R2 to R5)', { timeout: 60_000 });
    await expect(picked(frame)).toHaveCount(12);
  } finally {
    await cad(page, (() => {
      (window as unknown as W).__CAD__.recognition.maxHoleFaces = 2600;
    }) as never);
  }

  // A Ctrl+drag box (right to left: what it touches) on an R5 vertical while the panel is open: its faces are added.
  await settled(page);
  const [x, y] = await r5OnPage(page);
  await ctrlBox(page, frame, [x + 6, y - 6], [x - 6, y + 6]);
  await expect.poll(() => picked(frame).count(), { timeout: 30_000 }).toBeGreaterThan(12);
  await expect(pickLabel(frame)).toHaveText(/^Faces to delete \((1[3-9]|[2-9]\d)\)$/);
  await expect(panel(frame).locator('[data-pick-field="faces"] .cad-pick-error')).toHaveCount(0);
  await shot(page, 'delete-faces-by-size-box');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen.csp, 'CSP violations').toEqual([]);
});

test('cad:delete-faces-by-size-tblock Fillets up to 2 mm on a rounded T-block adds its 40 fillet faces; OCCT cannot heal them, they come off as fillets: ok with the note, the sharp T-block', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  // The T-block: a bar 60 x 40 x 10 on a stem 20 x 40 x 10 (32,000 mm³), every face's edges R2 by Fillet 1.
  const bar = await addSolid(page, { at: [0, 0, 10], size: [60, 40, 10] });
  await addSolid(page, { at: [20, 0, 0], size: [20, 40, 10], op: 'join', scope: [bar.body!] });
  await settled(page);
  await expectOneVolume(frame, 32000);
  await cad(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: false })).result;
    s.selection.set((st: object) => ({ ...st, items: t.faces.map((f: { i: number }) => ({ kind: 'face', body: b.id, index: f.i })) }));
  }) as never);
  await runCommand(frame, 'modify.fillet');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Fillet 1');
  const radius = panel(frame).locator('.nui[data-field="radius"] input');
  await radius.fill('2');
  await radius.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);

  // Delete faces, nothing selected; Fillets up to 2 mm, Enter: every fillet of the body.
  await openEmpty(page, frame);
  await sizeInput(frame, 'fillets').fill('2');
  await sizeInput(frame, 'fillets').press('Enter');
  await expect(added(frame)).toHaveText('Added 40 faces: 1 fillet chain, R2', { timeout: 60_000 });
  await expect(pickLabel(frame)).toHaveText('Faces to delete (40)');
  await settled(page);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  const NOTE = "Taken off as fillets up to R2 by Analysis Situs: OCCT's heal could not do it cleanly";
  await expect(panel(frame).locator('[data-note]')).toHaveText(`Note: ${NOTE}`);
  await expect(row.locator('[data-feature-badge="note"]')).toHaveAttribute('data-message', NOTE);
  await expectOneVolume(frame, 32000);
  await shot(page, 'delete-faces-by-size-tblock');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  expect(seen.errors, 'console errors').toEqual([]);
});

/** Select the one body's edges along the extrusion (y: lateral), or every other edge; their count. */
async function selectTEdges(page: Page, lateral: boolean): Promise<number> {
  return cad<number>(page, (async (lat: boolean) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'none', edges: 'all', vertices: 'none', edge_ends: true })).result;
    const near = (a: number, c: number) => Math.abs(a - c) < 1e-6;
    const isLat = (e: { type: string; first: number[]; last: number[] }) => e.type === 'line' && near(e.first[0], e.last[0]) && near(e.first[2], e.last[2]) && !near(e.first[1], e.last[1]);
    const idx = t.edges.filter((e: { type: string; first: number[]; last: number[] }) => isLat(e) === lat).map((e: { i: number }) => e.i);
    s.selection.set((st: object) => ({ ...st, items: idx.map((index: number) => ({ kind: 'edge', body: b.id, index })) }));
    return idx.length;
  }) as never, lateral);
}

/** MODIFY > Fillet of the selection at radius r: the row ok, Done. */
async function filletSelected(page: Page, frame: FrameLocator, name: string, r: number) {
  await runCommand(frame, 'modify.fillet');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText(name);
  const radius = panel(frame).locator('.nui[data-field="radius"] input');
  await radius.fill(String(r));
  await radius.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, name)).toHaveAttribute('data-state', 'ok');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
}

const respawns = (page: Page) => cad<number>(page, (() => (window as unknown as W).__CAD__.services.kernel.status.get().respawns) as never);

// The T-block with only its non-lateral edges R2 (lateral edges sharp), measured in Node on a
// kernel-built copy: 31,731.445350 mm³, 26 faces. Fillet 1's own result here is that body.
const T_CAPS_R2 = 31731.44535019923;

test('cad:delete-faces-by-size-tblock-corners Fillets up to 1 mm on a T-block rounded R2 and then R1 along it takes the 8 R1 rounds off with their 16 corner pieces: ok well within 20 s, the T with only its R2 fillets, no kernel restart', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  // The T-block: a bar 60 x 40 x 10 on a stem 20 x 40 x 10; Fillet 1 R2 on its 16 edges across y,
  // Fillet 2 R1 on its 8 edges along y.
  const bar = await addSolid(page, { at: [0, 0, 10], size: [60, 40, 10] });
  await addSolid(page, { at: [20, 0, 0], size: [20, 40, 10], op: 'join', scope: [bar.body!] });
  await settled(page);
  await expectOneVolume(frame, 32000);
  expect(await selectTEdges(page, false)).toBe(16);
  await filletSelected(page, frame, 'Fillet 1', 2);
  // The reference: the T with only Fillet 1, as the chip reads it now.
  const reference = (await chipVolumes(frame))[0];
  expect(Math.abs(reference / T_CAPS_R2 - 1)).toBeLessThan(1e-9);
  expect(await selectTEdges(page, true)).toBe(8);
  await filletSelected(page, frame, 'Fillet 2', 1);
  const respawns0 = await respawns(page);

  // Delete faces, nothing selected; Fillets up to 1 mm, Enter: the 8 R1 rounds.
  await openEmpty(page, frame);
  await sizeInput(frame, 'fillets').fill('1');
  await sizeInput(frame, 'fillets').press('Enter');
  await expect(added(frame)).toHaveText('Added 8 faces: 8 fillet chains, R1', { timeout: 60_000 });
  const t0 = Date.now();
  await expect(pickLabel(frame)).toHaveText('Faces to delete (8)');
  await settled(page);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  // Well within the kernel's 20 s watchdog (4.4 s in Node: no heal started, taking them off as
  // fillets refused at once, 8 rounds with their corners one at a time and the checks).
  expect(Date.now() - t0, 'ms to ok').toBeLessThan(15_000);
  const NOTE = "Taken off one round at a time, with the 16 corner faces where they meet other fillets: OCCT's heal was not run: it would grow 16 small curved faces up to 10 times their size, which failed or ran past 20 s on every part measured";
  await expect(panel(frame).locator('[data-note]')).toHaveText(`Note: ${NOTE}`);
  await expect(row.locator('[data-feature-badge="note"]')).toHaveAttribute('data-message', NOTE);
  await expectOneVolume(frame, reference, 1e-9);
  expect(await cad<number>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces) as never), 'faces').toBe(26);
  expect(await respawns(page), 'kernel restarts').toBe(respawns0);
  await shot(page, 'delete-faces-by-size-tblock-corners');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  expect(seen.errors, 'console errors').toEqual([]);
});

/**
 * Runs in the Part's frame: the T-block rounded the other way round, its 8 edges along y R1 first
 * and then its 16 edges across R2 (a torus at each concave round's ends), as STEP: the app's Fillet
 * cannot round it R2 after R1. `volume` is that body, `sharp` the T with only its R2 fillets.
 * Self-contained (it is sent as text).
 */
async function tAlongFirstInPage(): Promise<RoundedBlockMade> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type R = Record<string, any>;
  const k = (window as unknown as { __CAD__: { services: { kernel: { call(op: string, p: R): Promise<{ result: R; buffers: Record<string, ArrayBuffer> }> } } } }).__CAD__.services.kernel;
  const r = async (op: string, p: R) => (await k.call(op, p)).result;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const along = (e: R) => e.type === 'line' && near(e.first[0], e.last[0]) && near(e.first[2], e.last[2]) && !near(e.first[1], e.last[1]);
  const edges = async (id: number) => (await r('topo', { id, faces: 'none', vertices: 'none', edge_ends: true })).edges as R[];
  const bar = (await r('box', { dx: 60, dy: 40, dz: 10, origin: [0, 0, 10] })).id;
  const stem = (await r('box', { dx: 20, dy: 40, dz: 10, origin: [20, 0, 0] })).id;
  const sharp = (await r('boolean', { op: 'fuse', targets: [bar], tools: [stem] })).id;
  const ref = (await r('fillet', { id: sharp, edges: (await edges(sharp)).filter((e) => !along(e)).map((e) => e.i), r: 2 })).id;
  const first = (await r('fillet', { id: sharp, edges: (await edges(sharp)).filter(along).map((e) => e.i), r: 1 })).id;
  const id = (await r('fillet', { id: first, edges: (await edges(first)).filter((e) => !along(e)).map((e) => e.i), r: 2 })).id;
  const volume = (await r('props', { id, volume: true, bbox: 'none' })).volume;
  const only = (await r('props', { id: ref, volume: true, bbox: 'none' })).volume;
  const step = (await k.call('export_step', { shapes: [{ id, name: 'Body 1' }], schema: 'AP214' })).buffers.step;
  await r('release', { ids: [id, first, ref, sharp, stem, bar] });
  let bin = '';
  const u8 = new Uint8Array(step);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), volume, sharp: only };
}

test("cad:delete-faces-by-size-tblock-corners-refused the T-block rounded R1 along it first and then R2, as STEP, with each round and its corner pieces allowed 1 ms: Fillets up to 1 mm is red in words that name each way tried once, OCCT's heal after them stopped by its whole 20 s, and that the body is unchanged, with no kernel restart", async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  const made = await importRoundedBlock(page, frame, tAlongFirstInPage);
  await settled(page);
  await expectOneVolume(frame, made.volume);
  const respawns0 = await respawns(page);
  // The third way's time for each round with its corner pieces, lowered from its 2.5 s
  // (window.__CAD__.corners) so that it refuses on a body it takes off.
  await cad(page, (() => {
    (window as unknown as { __CAD__: { corners: { groupMs: number | null } } }).__CAD__.corners.groupMs = 1;
  }) as never);
  try {
    await openEmpty(page, frame);
    await sizeInput(frame, 'fillets').fill('1');
    await sizeInput(frame, 'fillets').press('Enter');
    await expect(added(frame)).toHaveText(/^Added 8 faces: /, { timeout: 60_000 });
    const t0 = Date.now();
    await settled(page);
    const row = featureRowNamed(frame as never, 'Delete faces 1');
    await expect(row).toHaveAttribute('data-state', 'error', { timeout: 60_000 });
    // OCCT's heal, not started first (it would grow the 12 corner pieces far past their size), ran
    // after both other ways refused, with the whole 20 s its call had (never less: a heal that ends
    // in it is never cut), and the budget stopped it, in words, before the call's 40 s.
    expect(Date.now() - t0, 'ms to the red words').toBeLessThan(40_000);
    await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(
      /^Delete faces 1 failed: OCCT's heal did not finish in 20\.0 s: it grows 12 small curved faces far past their size; taking them off as fillets did not work either: [^;]+; taking them off with the 16 corner faces where they meet other fillets did not work either: taking a round off with its corner faces did not finish in 0\.001 s; the body is unchanged$/,
    );
    await expectOneVolume(frame, made.volume);
    expect(await respawns(page), 'kernel restarts').toBe(respawns0);
    await shot(page, 'delete-faces-by-size-tblock-corners-refused');
  } finally {
    await cad(page, (() => {
      (window as unknown as { __CAD__: { corners: { groupMs: number | null } } }).__CAD__.corners.groupMs = null;
    }) as never);
  }
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(seen.errors, 'console errors').toEqual([]);
});

/**
 * Runs in the Part's frame: a comb (a base 60 x 10 with 4 teeth 6 x 15, 20 deep) whose 20 edges
 * along y are rounded R1, with every surface made a B-spline (the kernel's test reshape), as STEP:
 * OCCT's heal of its 20 rounds took 58 s on the kernel before API 9 (in the app the 20 s watchdog
 * stopped it). Self-contained (it is sent as text).
 */
async function bsplineCombInPage(): Promise<RoundedBlockMade> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type R = Record<string, any>;
  const k = (window as unknown as { __CAD__: { services: { kernel: { call(op: string, p: R): Promise<{ result: R; buffers: Record<string, ArrayBuffer> }> } } } }).__CAD__.services.kernel;
  const r = async (op: string, p: R) => (await k.call(op, p)).result;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const xz = [[0, 0], [60, 0], [60, 10], [54, 10], [54, 25], [48, 25], [48, 10], [40, 10], [40, 25], [34, 25], [34, 10], [26, 10], [26, 25], [20, 25], [20, 10], [12, 10], [12, 25], [6, 25], [6, 10], [0, 10]];
  const profile = { plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] }, loops: [xz.map((a, i) => ({ id: `s${i}`, kind: 'line', a, b: xz[(i + 1) % xz.length] }))] };
  const sharp = (await r('extrude', { profile, extent: { kind: 'blind', d: 20 } })).id;
  const along = ((await r('topo', { id: sharp, faces: 'none', vertices: 'none', edge_ends: true })).edges as R[]).filter((e) => e.type === 'line' && near(e.first[0], e.last[0]) && near(e.first[2], e.last[2])).map((e) => e.i);
  const rounded = (await r('fillet', { id: sharp, edges: along, r: 1 })).id;
  const id = (await r('debug_reshape', { id: rounded, bspline: true })).id;
  const volume = (await r('props', { id, volume: true, bbox: 'none' })).volume;
  const step = (await k.call('export_step', { shapes: [{ id, name: 'Body 1' }], schema: 'AP214' })).buffers.step;
  await r('release', { ids: [id, rounded, sharp] });
  let bin = '';
  const u8 = new Uint8Array(step);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), volume, sharp: volume };
}

test("cad:delete-faces-by-size-heal-time a B-spline comb's 20 rounds, whose heal took 58 s: Fillets up to 1 mm is red in words once OCCT's heal has had the whole 20 s its call had, then why taking them off as fillets failed too, the body unchanged, no kernel restart", async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  const made = await importRoundedBlock(page, frame, bsplineCombInPage);
  await settled(page);
  await expectOneVolume(frame, made.volume);
  const respawns0 = await respawns(page);
  await openEmpty(page, frame);
  await sizeInput(frame, 'fillets').fill('1');
  await sizeInput(frame, 'fillets').press('Enter');
  await expect(added(frame)).toHaveText(/^Added 20 faces: /, { timeout: 60_000 });
  await settled(page);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'error', { timeout: 60_000 });
  await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(
    /^Delete faces 1 failed: OCCT's heal did not finish in 20\.0 s; taking them off as fillets did not work either: [^;]+; the body is unchanged$/,
  );
  await expectOneVolume(frame, made.volume);
  // The heal's budget ended it in words: the call's watchdog (20 s more) never stopped the worker.
  expect(await respawns(page), 'kernel restarts').toBe(respawns0);
  await shot(page, 'delete-faces-by-size-heal-time');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(seen.errors, 'console errors').toEqual([]);
});

/**
 * Runs in the Part's frame: a heat sink, a base 70 x 30 x 4 with 5 fins 60 x 1 x 10 set 5 mm in from
 * its ends, the fins' top edges along x rounded R0.4, with every surface made a B-spline (the
 * kernel's test reshape, as some exporters write every face), as STEP. `sharp` is the sink with no
 * rounds (11,400 mm³). Self-contained (it is sent as text).
 */
async function bsplineSinkInPage(): Promise<RoundedBlockMade> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type R = Record<string, any>;
  const k = (window as unknown as { __CAD__: { services: { kernel: { call(op: string, p: R): Promise<{ result: R; buffers: Record<string, ArrayBuffer> }> } } } }).__CAD__.services.kernel;
  const r = async (op: string, p: R) => (await k.call(op, p)).result;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  let sharp = (await r('box', { dx: 70, dy: 30, dz: 4, origin: [0, 0, 0] })).id;
  const ids: number[] = [sharp];
  for (let i = 0; i < 5; i++) {
    const fin = (await r('box', { dx: 60, dy: 1, dz: 10, origin: [5, 3 + 6 * i, 4] })).id;
    sharp = (await r('boolean', { op: 'fuse', targets: [sharp], tools: [fin] })).id;
    ids.push(fin, sharp);
  }
  const tops = ((await r('topo', { id: sharp, faces: 'none', vertices: 'none', edge_ends: true })).edges as R[]).filter((e) => e.type === 'line' && near(e.first[2], 14) && near(e.last[2], 14) && !near(e.first[0], e.last[0])).map((e) => e.i);
  const rounded = (await r('fillet', { id: sharp, edges: tops, r: 0.4 })).id;
  const id = (await r('debug_reshape', { id: rounded, bspline: true })).id;
  const volume = (await r('props', { id, volume: true, bbox: 'none' })).volume;
  const plain = (await r('props', { id: sharp, volume: true, bbox: 'none' })).volume;
  const step = (await k.call('export_step', { shapes: [{ id, name: 'Body 1' }], schema: 'AP214' })).buffers.step;
  await r('release', { ids: [id, rounded, ...ids] });
  let bin = '';
  const u8 = new Uint8Array(step);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), volume, sharp: plain };
}

test("cad:delete-faces-by-size-flat-bspline a heat sink whose every surface is a B-spline: Fillets up to 0.4 mm takes its 10 fin rounds off by OCCT's heal, as before kernel API 9 (its flat fin ends grown 6 times their size are not far-grown), not red, no note, the sharp sink", async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  const made = await importRoundedBlock(page, frame, bsplineSinkInPage);
  expect(Math.abs(made.sharp / 11400 - 1)).toBeLessThan(1e-9);
  await settled(page);
  await expectOneVolume(frame, made.volume);
  const respawns0 = await respawns(page);
  await openEmpty(page, frame);
  await sizeInput(frame, 'fillets').fill('0.4');
  await sizeInput(frame, 'fillets').press('Enter');
  await expect(added(frame)).toHaveText('Added 10 faces: 10 fillet chains, R0.4', { timeout: 60_000 });
  await settled(page);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  // OCCT's heal ran first and did it, as before API 9: not red (it was "OCCT's heal did not finish
  // in 2.5 s: it grows 10 small curved faces far past their size; ..." after 3 s).
  await expect(row).not.toHaveAttribute('data-state', 'pending', { timeout: 60_000 });
  await expect(row).not.toHaveAttribute('data-state', 'error');
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  await expect(panel(frame).locator('[data-note]')).toHaveCount(0);
  await expectOneVolume(frame, 11400, 1e-9);
  expect(await cad<number>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces) as never), 'faces').toBe(31);
  expect(await respawns(page), 'kernel restarts').toBe(respawns0);
  await shot(page, 'delete-faces-by-size-flat-bspline');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(seen.errors, 'console errors').toEqual([]);
});
