// Magnusim CAD: Delete faces takes fillets off as fillets where OCCT's heal cannot (kernel API 8,
// Analysis Situs), as in Magnusim (bundled-plugins/cad/e2e/cad-delete-faces-heal.spec.ts
// heal-tblock and heal-rest): a T-block (a bar 60 x 40 x 10 on a stem 20 x 40 x 10) built in a
// new project's Part, Fillet 1 of every face R2, then MODIFY > Delete faces of its fillets.
//  - Every fillet: Delete faces 1 is ok, its panel's note and the tree row's info mark say "Taken off
//    as fillets up to R2 by Analysis Situs: OCCT's heal could not do it cleanly", and the volume chip
//    shows the sharp T-block's 32,000 mm³.
//  - All but one: red with "Every fillet up to R2 on Body 1 is 40 faces and 39 are picked: with all
//    40, Delete faces can take them off as fillets"; Add the rest (+1) makes it the sharp T-block.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from './pw';
import { addSolid, featureRowNamed, partOpened, runCommand, watchPage, workspaceFrame } from '../bundled-plugins/cad/e2e/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
const NOTE = "Taken off as fillets up to R2 by Analysis Situs: OCCT's heal could not do it cleanly";

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const chipVolumes = (frame: FrameLocator) => frame.locator('[data-chip="volume"] [data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(
      () =>
        cad<boolean>(page, (() => {
          const st = (window as unknown as W).__CAD__.services.doc.state.get();
          return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
        }) as never),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** The chip's one volume is `v` (within 1e-6). */
async function expectVolume(frame: FrameLocator, v: number) {
  await expect.poll(async () => ((vs) => (vs.length === 1 ? Math.abs(vs[0] / v - 1) : 1))(await chipVolumes(frame)), { timeout: 30_000 }).toBeLessThan(1e-6);
}

/** Select faces of the one body: every face, or its round faces but the first `skip`. */
async function select(page: Page, which: 'all' | 'round', skip = 0): Promise<number> {
  return cad<number>(page, (async (a: { which: string; skip: number }) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: false })).result;
    const idx = t.faces.filter((f: { type: string }) => a.which === 'all' || f.type !== 'plane').map((f: { i: number }) => f.i).slice(a.skip);
    s.selection.set((st: object) => ({ ...st, items: idx.map((index: number) => ({ kind: 'face', body: b.id, index })) }));
    return idx.length;
  }) as never, { which, skip });
}

/** A new project's Part (Home > New project) with the T-block, Fillet 1 of every face R2 through its panel; Fillet 1's volume. */
async function roundedT(page: Page): Promise<{ frame: FrameLocator; filleted: number }> {
  await page.goto('/');
  await page.locator('#home-new-project').click();
  await page.locator('#modal-new-project #np-title').fill(`Fillets ${Date.now()}`);
  await page.locator('#modal-new-project #np-create').click();
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const bar = await addSolid(page, { at: [0, 0, 10], size: [60, 40, 10] });
  await addSolid(page, { at: [20, 0, 0], size: [20, 40, 10], op: 'join', scope: [bar.body!] });
  await settled(page);
  await expectVolume(frame, 32000);
  expect(await select(page, 'all')).toBe(10);
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
  return { frame, filleted };
}

/** MODIFY > Delete faces of what is selected (Fillet 1's faces: "Delete faces and heal"), its panel open and built. */
async function deleteSelected(page: Page, frame: FrameLocator) {
  await runCommand(frame, 'modify.delete-faces');
  const dlg = frame.locator('[data-cad-dialog]');
  await expect(dlg.locator('h2')).toHaveText('Delete faces of Fillet 1?');
  await dlg.locator('[data-dialog-choice="faces"]').click();
  await expect(panel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
}

test('Delete faces of every fillet of a rounded T-block: ok, taken off as fillets (the note), the chip at the sharp T-block', async ({ page }) => {
  test.setTimeout(180_000);
  const seen = await watchPage(page);
  const { frame } = await roundedT(page);
  expect(await select(page, 'round')).toBe(40);
  await deleteSelected(page, frame);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  await expect(panel(frame).locator('[data-note]')).toHaveText(`Note: ${NOTE}`);
  await expect(row.locator('[data-feature-badge="note"]')).toHaveAttribute('data-message', NOTE);
  await expectVolume(frame, 32000);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  expect(seen.errors).toEqual([]);
});

test("the T-block's fillets but one: red with every fillet up to R2 and how many are picked; Add the rest (+1) makes it the sharp T-block", async ({ page }) => {
  test.setTimeout(180_000);
  const seen = await watchPage(page);
  const { frame, filleted } = await roundedT(page);
  expect(await select(page, 'round', 1)).toBe(39);
  await deleteSelected(page, frame);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(/\. Every fillet up to R2 on Body 1 is 40 faces and 39 are picked: with all 40, Delete faces can take them off as fillets$/);
  await expectVolume(frame, filleted);
  const rest = panel(frame).locator('[data-delete-rest]');
  await expect(rest).toHaveText('Add the rest (+1)');
  await rest.click();
  await settled(page);
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-note]')).toHaveText(`Note: ${NOTE}`);
  await expectVolume(frame, 32000);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});
