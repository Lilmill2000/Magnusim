// Magnusim CAD as a desktop app (desktop/main.mjs, Electron): it opens one window on its own
// server with no Python and no WSL to be found, a Part made there runs CAD's kernel, a web link
// opens outside the app, and quitting ends the server.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '../e2e-cad/pw';
import { partOpened, drawBlock, historyNames } from '../bundled-plugins/cad/e2e/helpers';
// @ts-expect-error plain ESM script with no types
import { removeTreeSync } from '../scripts/remove-tree.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(WEB, 'desktop');
const EXE = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('the desktop app: a window on its own server, a Part with CAD running, and Quit ends the server', async () => {
  test.setTimeout(240_000);
  const root = mkdtempSync(join(tmpdir(), 'magnusim-cad-desktop-'));
  const env = {
    ...process.env,
    MAGNUSIM_PROJECTS_ROOT: join(root, 'projects'),
    MAGNUSIM_LOCAL_JSON: join(root, 'local.json'),
    MAGNUSIM_ASSISTANT_HOME: join(root, 'assistant'),
    MAGNUSIM_PYTHON: join(root, 'no-python.exe'),
    PATH: String(process.env.PATH || '')
      .split(delimiter)
      .filter((d) => !/python|windowsapps/i.test(d))
      .join(delimiter),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  // Its own user data (prefs, desktop.log, caches), never the person's Magnusim CAD folder in AppData.
  const app = await electron.launch({ executablePath: EXE, args: [DESKTOP, `--user-data-dir=${join(root, 'user data')}`], env });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('Magnusim CAD - Projects', { timeout: 60_000 });
    const url = new URL(page.url());
    expect(url.hostname).toBe('127.0.0.1');
    // CAD's helpers find the app here.
    process.env.CAD_E2E_BASE_URL = url.origin;

    await page.locator('#home-new-project').click();
    await page.locator('#np-title').fill('Desktop bench');
    await page.locator('#np-create').click();
    const frame = await partOpened(page);
    await drawBlock(page, frame, 30, 20, 10);
    await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1']);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Part 1']);

    // A web link goes to the person's browser, never a second app window. The browser is not
    // really opened here: the app's call to it is caught and kept for the test.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __opened: string[] }).__opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const windows = app.windows().length;
    await page.evaluate(() => window.open('https://example.org/', '_blank'));
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual(['https://example.org/']);
    expect(app.windows().length).toBe(windows);

    // Quit: the window goes and the server stops listening.
    await app.evaluate(({ app: a }) => a.quit());
    await expect.poll(async () => fetch(`${url.origin}/api/plugins`).then(() => 'up', () => 'down'), { timeout: 15_000 }).toBe('down');
  } finally {
    await app.close().catch(() => undefined);
    removeTreeSync(root);
  }
});
