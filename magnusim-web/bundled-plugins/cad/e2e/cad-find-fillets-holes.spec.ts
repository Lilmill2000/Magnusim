// INSPECT > Find of fillets and drilled holes by their shape (S4, kernel API 8), as the person sees
// it on a STEP part made in the test (e2e/rounded-block.ts: R5 verticals, R2 round the top, four
// 6 mm holes and a 6/10 mm counterbore) and imported with FILE > Import STEP:
//   1. "Body 1 faces fillet <= 2 mm": "8 faces match ...", every row's type "fillet R2", and the
//      hint to check the lit faces;
//   2. Select all: the dock's chip reads 8 faces; the Delete key: Delete faces 1 is ok and the
//      volume chip shows the sharp reference's volume (the R2 round the top gone);
//   3. "Body 1 faces hole <= 6 mm": "4 faces match ... (4 holes)", rows "hole Ø6 through"; "<= 10
//      mm" adds the counterbore, "hole Ø6–Ø10 through" (5 holes); "fillet <= 1 mm" matches nothing
//      and says what the body has ("Body 1 has 4 fillet faces, R5");
//   4. "Body 1 edges fillet": the words "fillet filters faces: Body 1 faces fillet <= 2 mm";
//   5. with the page's face limit lowered (window.__CAD__.recognition, as a part over 2,000 faces
//      is met), "Body 1 faces fillet": the words name Body 1, its faces and the limit, and say to
//      select its faces in the view instead: no count line, no empty list.
// Without S4, "fillet" is a bad selector and step 1 fails; step 5 fails if the body answers an
// empty list instead of the words.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { featureRowNamed, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';
import { importRoundedBlock } from './rounded-block';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; recognition: { maxFaces: number } } };

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** The rebuild is done and every feature has a state. */
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

const toolPanel = (frame: FrameLocator) => frame.locator('[data-cad-panel="tool"]');
const featurePanel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const chipVolumes = (frame: FrameLocator) => frame.locator('[data-chip="volume"] [data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

/** Find a query in the open Find panel. */
async function find(frame: FrameLocator, q: string) {
  const p = toolPanel(frame);
  await p.locator('[data-find-query]').fill(q);
  await p.locator('[data-find-query]').press('Enter');
}

test('cad:find-fillets-holes Find fillets and holes by size on an imported STEP part: rows, Select all, Delete to the sharp part, holes counted, refusals in words', async ({ page, request }) => {
  test.setTimeout(300_000);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const made = await importRoundedBlock(page, frame);
  await settled(page);
  await expect.poll(() => chipVolumes(frame)).toEqual([expect.closeTo(made.volume, 0)]);

  // 1. Fillets up to 2 mm: the 8 faces round the top, each "fillet R2", and the hint.
  await runCommand(frame, 'inspect.find');
  const panel = toolPanel(frame);
  await expect(panel.locator('[data-tool-panel="inspect.find"]')).toBeVisible();
  await find(frame, 'Body 1 faces fillet <= 2 mm');
  const count = panel.locator('[data-find-count]');
  await expect(count).toHaveText('8 faces match Body 1 faces fillet <= 2 mm', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row]')).toHaveCount(8);
  await expect(panel.locator('[data-find-row] [data-find-type]')).toHaveText(Array(8).fill('fillet R2'));
  await expect(panel.locator('[data-find-shape-hint]')).toHaveText('Found by their shape, whatever made them (chamfers are not fillets): check the lit faces before you delete them.');
  // The example chips teach both forms.
  await expect(panel.locator('[data-find-example="Body 1 faces fillet <= 2 mm"]')).toBeVisible();
  await expect(panel.locator('[data-find-example="Body 1 faces hole <= 6 mm"]')).toBeVisible();
  await shot(page, 'find-fillets');

  // 2. Select all, then the Delete key: Delete faces 1 is ok at the sharp part's volume.
  await panel.locator('[data-find-select-all]').click();
  await expect(frame.locator('[data-chip="selection"] [data-selection-count]')).toHaveText('8 faces');
  await page.keyboard.press('Delete');
  await expect(featurePanel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect(featurePanel(frame).locator('[data-run-reason]')).toHaveCount(0);
  await expect.poll(async () => Math.abs((await chipVolumes(frame))[0] / made.sharp - 1), { timeout: 30_000 }).toBeLessThan(1e-6);
  await featurePanel(frame).locator('[data-panel-done]').click();
  await expect(featurePanel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');

  // 3. Holes by size: whole holes, counted.
  await runCommand(frame, 'inspect.find');
  await find(frame, 'Body 1 faces hole <= 6 mm');
  await expect(count).toHaveText('4 faces match Body 1 faces hole <= 6 mm (4 holes)', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row] [data-find-type]')).toHaveText(Array(4).fill('hole Ø6 through'));
  await expect(panel.locator('[data-find-shape-hint]')).toBeVisible();
  await find(frame, 'Body 1 faces hole <= 10 mm');
  await expect(count).toHaveText('7 faces match Body 1 faces hole <= 10 mm (5 holes)', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row] [data-find-type]').filter({ hasText: 'hole Ø6–Ø10 through' })).toHaveCount(3);
  await shot(page, 'find-holes');
  // A plain query: no hint, its type cell as before.
  await find(frame, 'Body 1 faces >Z');
  await expect(count).toHaveText('1 face match Body 1 faces >Z', { timeout: 30_000 });
  await expect(panel.locator('[data-find-shape-hint]')).toHaveCount(0);
  await expect(panel.locator('[data-find-row] [data-find-type]')).toHaveText(['plane']);
  // Nothing up to 1 mm: the words say what the body has (the R2s are gone; the R5 verticals stay).
  await find(frame, 'Body 1 faces fillet <= 1 mm');
  await expect(panel.locator('[data-find-nothing]')).toHaveText('"Body 1 faces fillet <= 1 mm" matches nothing: Body 1 has 4 fillet faces, R5.', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row]')).toHaveCount(0);

  // 4. Edges: fillet filters faces.
  await find(frame, 'Body 1 edges fillet');
  await expect(panel.locator('[data-run-reason]')).toContainText('fillet filters faces: Body 1 faces fillet <= 2 mm', { timeout: 30_000 });
  await expect(count).toHaveCount(0);

  // 5. A body over the face limit (the page's limit lowered): words, never an empty list.
  const faces = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces as number);
  await workspaceFrame(page).evaluate(() => {
    (window as unknown as W).__CAD__.recognition.maxFaces = 10;
  });
  try {
    await find(frame, 'Body 1 faces fillet');
    await expect(panel.locator('[data-run-reason]')).toHaveText(`Body 1 has ${faces} faces: fillets and holes are found on bodies of up to 10 faces. Select its faces in the view instead.`, { timeout: 30_000 });
    await expect(count).toHaveCount(0);
    await expect(panel.locator('[data-find-row]')).toHaveCount(0);
    await shot(page, 'find-over-limit');
  } finally {
    await workspaceFrame(page).evaluate(() => {
      (window as unknown as W).__CAD__.recognition.maxFaces = 2000;
    });
  }
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen.csp, 'CSP violations').toEqual([]);
});
