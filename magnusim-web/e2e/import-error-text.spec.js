import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// "Could not import toothed-bar.brep" said only "[object Object]" (2026-10): the import
// went through, then the part's faces did not load, and the viewer's reader fails with
// a plain object ({ xhr, e }), not an Error. A server reply whose error is an object read
// the same. The dialog now says why, in words.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry');
const stamp = () => Date.now().toString(36);

async function openNewProject(page, title) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    title,
  );
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  return pid;
}

async function expectImportDialog(page, copy) {
  const dialog = page.locator('#modal-confirm');
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#cf-heading')).toHaveText('Could not import elbow.step');
  await expect(page.locator('#cf-copy')).toHaveText(copy);
  await expect(page.locator('#cf-copy')).not.toContainText('[object');
  await page.locator('#cf-confirm').click();
  await expect(dialog).toBeHidden();
}

test("the part's faces fail to load after the import: the dialog gives the server's reason", async ({ page }) => {
  test.setTimeout(180_000);
  await openNewProject(page, `e2e import error faces ${stamp()}`);
  await page.route(/\/api\/geometry\/cad\?.*part=faces/, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no geometry imported' }) }),
  );
  await page.locator('#geometry-file-input').setInputFiles(join(FIXTURES, 'elbow.step'));
  await expectImportDialog(page, 'The server answered 404: no geometry imported');
});

test('an import reply whose error is an object: the dialog shows its message', async ({ page }) => {
  test.setTimeout(120_000);
  await openNewProject(page, `e2e import error body ${stamp()}`);
  await page.route(/\/api\/geometry\/import/, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'The part could not be read' } }),
    }),
  );
  await page.locator('#geometry-file-input').setInputFiles(join(FIXTURES, 'elbow.step'));
  await expectImportDialog(page, 'The part could not be read');
  // Nothing was added.
  await expect(page.locator('#btn-create-simulation')).toBeHidden();
});
