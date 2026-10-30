// Parity both ways in Magnusim CAD: each parity row the CAD app has (parity-rows.json, editions
// with "cad") names the CAD app's own control a person uses for it, and here each is found the
// way a person reaches it: on Home, a card's details, Home's right-click menus, New project, a
// project's page of Parts, Settings, the Assistant dock's conversation menu. Magnusim's controls
// the CAD app does not have stay away: the compute queue, This PC / Port / Workspace in Settings,
// and "Open a sample…".
// (The Assistant's side: scripts/__tests__/assistant-parity.test.mjs.)
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from './pw';
import { partOpened } from '../bundled-plugins/cad/e2e/helpers';

interface Row {
  row: string;
  editions: string[];
  cad_control?: { reach: string; selector: string };
}

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(readFileSync(join(WEB, 'scripts', 'server', 'assistant', 'parity-rows.json'), 'utf8')) as { rows: Row[] };
const CAD_ROWS = FIXTURE.rows.filter((r) => r.editions.includes('cad'));

const FOLDER = 'Brackets';

async function seed(page: Page) {
  const req = page.request;
  expect((await req.post('/api/folders', { data: { name: FOLDER } })).ok()).toBe(true);
  const made = await req.post('/api/project', { data: { title: 'Parity bench', units: 'Metric', folder: FOLDER } });
  expect(made.ok()).toBe(true);
  const pid = String((await made.json()).id);
  const st = await req.post('/api/plugin-studies/create', { data: { project_id: pid, plugin: 'cad', kind: 'part', title: 'Hinge' } });
  expect(st.ok()).toBe(true);
  return pid;
}

/** Home, freshly drawn, with every project listed. */
async function home(page: Page) {
  await page.goto('/#/');
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('#home-grid .home-card[data-project-id]').first()).toBeVisible();
}

/** Brings the row's control on screen as a person does. */
async function reach(page: Page, where: string, pid: string) {
  switch (where) {
    case 'home':
      return home(page);
    case 'card':
      await home(page);
      await page.locator(`#home-grid .home-card[data-project-id="${pid}"]`).click();
      return;
    case 'grid_menu': {
      await home(page);
      // A point of the grid with no card on it, however many projects the earlier specs made
      // (the bottom-right corner has one when the last row is full).
      const at = await page.evaluate(() => {
        const grid = document.getElementById('home-grid');
        const r = grid?.getBoundingClientRect();
        if (!grid || !r) return null;
        for (let y = r.bottom - 8; y > r.top; y -= 16) {
          for (let x = r.right - 8; x > r.left; x -= 16) {
            const hit = document.elementFromPoint(x, y);
            if (hit && grid.contains(hit) && !hit.closest('.home-card')) return { x, y };
          }
        }
        return null;
      });
      expect(at, 'an empty point of the Home grid').toBeTruthy();
      await page.mouse.click(at!.x, at!.y, { button: 'right' });
      await expect(page.locator('#home-ctx-menu')).toBeVisible();
      return;
    }
    case 'folder_menu':
      await home(page);
      await page.locator(`#home-folder-list .home-nav-child[data-drop-folder="${FOLDER}"]`).click({ button: 'right' });
      await expect(page.locator('#home-ctx-menu')).toBeVisible();
      return;
    case 'new_project':
      await home(page);
      await page.locator('#home-new-project').click();
      await expect(page.locator('#modal-new-project')).toBeVisible();
      return;
    case 'project':
      await page.goto(`/#/p/${pid}`);
      await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Hinge']);
      return;
    case 'settings':
      await home(page);
      await page.locator('#home-prefs').click();
      await expect(page.locator('#setup-wizard')).toBeVisible();
      return;
    case 'dock': {
      // The Assistant on (a local server's model: its menu shows once a provider is ready; nothing
      // is sent), the dock open over the project, its conversation menu open. The local server is
      // the provider whose key is optional.
      const status = (await (await page.request.get('/api/assistant/status')).json()) as { providers: Array<{ id: string; key: string }> };
      const local = status.providers.find((p) => p.key === 'optional')?.id ?? '';
      const set = await page.request.post('/api/assistant/settings', { data: { provider: local, base_url: 'http://127.0.0.1:9/v1', models: { [local]: 'parity' } } });
      expect(set.ok(), await set.text()).toBe(true);
      await page.goto(`/#/p/${pid}`);
      await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Hinge']);
      if (!(await page.locator('#assistant-dock').isVisible())) await page.locator('[data-assistant-pill] .assistant-dock-pill-open').click();
      await page.locator('#assistant-dock [data-dock-menu]').click();
      await expect(page.locator('#assistant-dock [data-dock-menu-list]')).toBeVisible();
      return;
    }
    default:
      throw new Error(`no way to reach "${where}"`);
  }
}

test('each CAD parity row\'s control is in the CAD app, where a person reaches it', async ({ page }) => {
  const pid = await seed(page);
  expect(CAD_ROWS.length).toBeGreaterThan(10);
  try {
    for (const r of CAD_ROWS) {
      await test.step(`${r.row}: ${r.cad_control!.reach} ${r.cad_control!.selector}`, async () => {
        await reach(page, r.cad_control!.reach, pid);
        await expect(page.locator(r.cad_control!.selector).first(), r.row).toBeVisible();
        await page.keyboard.press('Escape');
      });
    }
  } finally {
    // The dock's row turned the Assistant on: off again for the specs after this one.
    await page.request.post('/api/assistant/settings', { data: { provider: 'off' } }).catch(() => undefined);
  }
});

test("Magnusim's controls the CAD app does not have stay away", async ({ page }) => {
  const pid = await seed(page);
  // New project: no "Open a sample…" (no samples in CAD), no Import geometry.
  await reach(page, 'new_project', pid);
  await expect(page.locator('#np-samples-toggle')).toBeHidden();
  await expect(page.locator('#np-start-import')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Settings: no This PC, Port or Workspace.
  await reach(page, 'settings', pid);
  for (const key of ['pc', 'port', 'workspace']) await expect(page.locator(`#wiz-rail li[data-wiz-key="${key}"]`)).toBeHidden();
  await page.locator('#wiz-close').click();
  // No compute queue: not on the project page, nor over a Part.
  await reach(page, 'project', pid);
  await expect(page.locator('#btn-queue')).toBeHidden();
  await page.locator('#cad-project .cad-part-open', { hasText: 'Hinge' }).click();
  await partOpened(page);
  await expect(page.locator('#btn-queue')).toBeHidden();
});
