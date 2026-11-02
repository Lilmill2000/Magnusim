// MODIFY > Delete faces: Add by size and box select while the panel is open (S5, the Analysis Situs
// plan §3.3), as the person sees them.
//  1. by-size     the rounded block (e2e/rounded-block.ts: R5 verticals, R2 round the top, four 6 mm
//                 holes, a 6/10 mm counterbore) made in the page, written to STEP and imported.
//                 Delete faces with nothing selected (the Part's one solid body): the sizes start at
//                 1 mm and Ø 2 mm (its 96.4 mm diagonal / 50 and / 20). Fillets up to 2, Enter:
//                 "Faces to delete (8)", "Added 8 faces: 1 fillet chain, R2", the row ok and the chip
//                 at the sharp block's volume. Holes up to Ø 6, Add: "(4 through)", 12 faces, the
//                 chip with the holes filled. Again: the words of what Body 1 has, nothing added. With
//                 the page's face limit lowered, Add says the limit in Find's words. A Ctrl+drag box
//                 on an R5 vertical while the panel is open adds the faces it touches (the count
//                 rises; without useBoxPicks it stays).
//  2. by-size-tblock  Add by size meets the second way (S6): a T-block, Fillet 1 of every face R2,
//                 then Delete faces with nothing selected, Fillets up to 2, Enter: the 40 fillet
//                 faces; OCCT's heal cannot, they come off as fillets: the row ok with the note
//                 "Taken off as fillets up to R2 by Analysis Situs ...", the chip at 32,000 mm³.
// Without S5 there is no data-delete-add (step 1 fails at once), and the box step fails without
// useBoxPicks.
// Review 2026-11-02: in by-size, Holes up to Ø 5.95 first adds nothing and says what Body 1 has (<=
// had the plain size's 1 %: it added the four 6 mm holes as "4 holes up to Ø5.95 mm (4 through)").
// A known class, not changed here (it needs Daniel's decision against F3, OCCT first): a T-block with
// its non-lateral edges R2 and its lateral edges R1, "Fillets up to 1 mm" adds its 8 R1 faces, and
// OCCT's defeature of them never returns (the same on the API 7 kernel): the kernel's 20 s watchdog
// stops the worker, the Part rebuilds and the row reads "was stopped after 20.0 s"; the second way
// never runs, though suppress_blends alone refuses that pick in words at once.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, featureRowNamed, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';
import { ctrlBox, importRoundedBlock, r5OnPage } from './rounded-block';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; recognition: { maxFaces: number } } };

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

  // With the page's face limit lowered (as a part over 2,000 faces meets it): Find's words, nothing added.
  await cad(page, (() => {
    (window as unknown as W).__CAD__.recognition.maxFaces = 10;
  }) as never);
  try {
    await addButton(frame, 'holes').click();
    await expect(added(frame)).toHaveText('Body 1 has 25 faces: fillets and holes are found on bodies of up to 10 faces. Select its faces in the view instead.', { timeout: 60_000 });
    await expect(picked(frame)).toHaveCount(12);
  } finally {
    await cad(page, (() => {
      (window as unknown as W).__CAD__.recognition.maxFaces = 2000;
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
