// Magnusim CAD: INSPECT > Find of fillets by their shape (S4, kernel API 8), the same as in
// Magnusim. A new project's Part imports a STEP part made in its page (bundled-plugins/cad/e2e/
// rounded-block.ts: R5 verticals, R2 round the top, four 6 mm holes, a 6/10 mm counterbore);
// "Body 1 faces fillet <= 2 mm" lists its 8 faces as "fillet R2" with the hint to check them;
// Select all, then the Delete key: Delete faces 1 is ok and the volume chip shows the sharp
// part's volume; "Body 1 faces hole <= 6 mm" counts 4 holes. Without S4, "fillet" is a bad
// selector there.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from './pw';
import { featureRowNamed, partOpened, runCommand, watchPage, workspaceFrame } from '../bundled-plugins/cad/e2e/helpers';
import { importRoundedBlock } from '../bundled-plugins/cad/e2e/rounded-block';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

const toolPanel = (frame: FrameLocator) => frame.locator('[data-cad-panel="tool"]');
const featurePanel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
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

test('Find of fillets and holes by size, Select all, Delete: the sharp part, as in Magnusim', async ({ page }) => {
  test.setTimeout(240_000);
  const seen = await watchPage(page);
  await page.goto('/');
  await page.locator('#home-new-project').click();
  const dialog = page.locator('#modal-new-project');
  await expect(dialog).toBeVisible();
  await dialog.locator('#np-title').fill('Rounded block');
  await dialog.locator('#np-create').click();
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const made = await importRoundedBlock(page, frame);
  await settled(page);

  await runCommand(frame, 'inspect.find');
  const panel = toolPanel(frame);
  await panel.locator('[data-find-query]').fill('Body 1 faces fillet <= 2 mm');
  await panel.locator('[data-find-query]').press('Enter');
  await expect(panel.locator('[data-find-count]')).toHaveText('8 faces match Body 1 faces fillet <= 2 mm', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row] [data-find-type]')).toHaveText(Array(8).fill('fillet R2'));
  await expect(panel.locator('[data-find-shape-hint]')).toBeVisible();

  await panel.locator('[data-find-select-all]').click();
  await expect(frame.locator('[data-chip="selection"] [data-selection-count]')).toHaveText('8 faces');
  await page.keyboard.press('Delete');
  await expect(featurePanel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Delete faces 1')).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect.poll(async () => Math.abs((await chipVolumes(frame))[0] / made.sharp - 1), { timeout: 30_000 }).toBeLessThan(1e-6);
  await featurePanel(frame).locator('[data-panel-done]').click();
  await expect(featurePanel(frame)).toHaveCount(0);

  await runCommand(frame, 'inspect.find');
  await panel.locator('[data-find-query]').fill('Body 1 faces hole <= 6 mm');
  await panel.locator('[data-find-query]').press('Enter');
  await expect(panel.locator('[data-find-count]')).toHaveText('4 faces match Body 1 faces hole <= 6 mm (4 holes)', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row] [data-find-type]')).toHaveText(Array(4).fill('hole Ø6 through'));
  expect(seen.errors, 'console errors').toEqual([]);
});
