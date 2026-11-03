// Magnusim CAD: MODIFY > Delete faces' Add by size and box select while the panel is open (S5,
// kernel API 8), the same as in Magnusim (bundled-plugins/cad/e2e/cad-delete-faces-by-size.spec.ts).
// A new project's Part imports a STEP part made in its page (bundled-plugins/cad/e2e/rounded-block.ts:
// R5 verticals, R2 round the top, four 6 mm holes, a 6/10 mm counterbore); Delete faces with nothing
// selected (the Part's one solid body): Fillets up to 2, Enter, adds the 8 R2 faces ("Added 8 faces:
// 1 fillet chain, R2"), the row ok and the volume chip at the sharp part's; Holes up to Ø 6, Add,
// the 4 holes "(4 through)"; a Ctrl+drag box on an R5 vertical adds the faces it touches. Without S5
// there is no Add row, and the box step fails without useBoxPicks (features/p2/pick.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from './pw';
import { featureRowNamed, partOpened, runCommand, tempFilesRemovedAfterEach, watchPage, workspaceFrame } from '../bundled-plugins/cad/e2e/helpers';
import { ctrlBox, importRoundedBlock, r5OnPage } from '../bundled-plugins/cad/e2e/rounded-block';

const tempFile = tempFilesRemovedAfterEach();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const picked = (frame: FrameLocator) => panel(frame).locator('[data-pick-field="faces"] [data-pick-row]');
const sizeInput = (frame: FrameLocator, kind: 'fillets' | 'holes') => panel(frame).locator(`.nui[data-field="add-${kind}"] input`);
const added = (frame: FrameLocator) => panel(frame).locator('[data-delete-added]');
const chipVolumes = (frame: FrameLocator) => frame.locator('[data-chip="volume"] [data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

async function settled(page: Page) {
  await expect
    .poll(
      () =>
        workspaceFrame(page).evaluate(() => {
          const st = (window as unknown as W).__CAD__.services.doc.state.get();
          return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

test('Delete faces: Fillets up to and Holes up to add faces by size, a Ctrl+drag box adds faces, as in Magnusim', async ({ page }) => {
  test.setTimeout(240_000);
  const seen = await watchPage(page);
  await page.goto('/');
  await page.locator('#home-new-project').click();
  const dialog = page.locator('#modal-new-project');
  await expect(dialog).toBeVisible();
  await dialog.locator('#np-title').fill(`By size ${Date.now()}`);
  await dialog.locator('#np-create').click();
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const made = await importRoundedBlock(page, frame, tempFile);
  await settled(page);

  // MODIFY > Delete faces, nothing selected: the rows, the sizes from the block's box.
  await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.selection.set((s: object) => ({ ...s, items: [] })));
  await runCommand(frame, 'modify.delete-faces');
  await expect(panel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await expect(picked(frame)).toHaveCount(0);
  await expect(sizeInput(frame, 'fillets')).toHaveValue('1');
  await expect(sizeInput(frame, 'holes')).toHaveValue('2');

  await sizeInput(frame, 'fillets').fill('2');
  await sizeInput(frame, 'fillets').press('Enter');
  await expect(added(frame)).toHaveText('Added 8 faces: 1 fillet chain, R2', { timeout: 60_000 });
  await expect(panel(frame).locator('[data-pick-field="faces"] .cad-pick-label')).toHaveText('Faces to delete (8)');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Delete faces 1')).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect.poll(async () => Math.abs((await chipVolumes(frame))[0] / made.sharp - 1), { timeout: 30_000 }).toBeLessThan(1e-6);

  await sizeInput(frame, 'holes').fill('6');
  await panel(frame).locator('[data-delete-add="holes"]').click();
  await expect(added(frame)).toHaveText('Added 4 faces: 4 holes up to Ø6 mm (4 through)', { timeout: 60_000 });
  await expect(picked(frame)).toHaveCount(12);

  // A Ctrl+drag box (right to left: what it touches) on an R5 vertical while the panel is open.
  await settled(page);
  const [x, y] = await r5OnPage(page);
  await ctrlBox(page, frame, [x + 6, y - 6], [x - 6, y + 6]);
  await expect.poll(() => picked(frame).count(), { timeout: 30_000 }).toBeGreaterThan(12);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(seen.errors, 'console errors').toEqual([]);
});
