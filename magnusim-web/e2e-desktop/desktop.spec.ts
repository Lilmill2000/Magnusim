// Magnusim CAD as a desktop app (desktop/main.mjs, Electron): it opens one window on its own
// server with no Python and no WSL to be found, a Part made there runs CAD's kernel, a web link
// opens outside the app, and quitting ends the server. What the server said is in its log in the
// app's user data (logs\server.log), from its start to the quit.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync } from 'node:fs';
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
/** A line of the server's log: its time, its level, its text. */
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (info |warn |error|debug) /;

/** The server's log in that user data ('' while there is none). */
function serverLog(userData: string): string {
  try {
    return readFileSync(join(userData, 'logs', 'server.log'), 'utf8');
  } catch {
    return '';
  }
}

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
  // Its own user data (prefs, desktop.log, the server's log, caches), never the person's Magnusim CAD folder in AppData.
  const userData = join(root, 'user data');
  const app = await electron.launch({ executablePath: EXE, args: [DESKTOP, `--user-data-dir=${userData}`], env });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('Magnusim CAD - Projects', { timeout: 60_000 });
    const url = new URL(page.url());
    expect(url.hostname).toBe('127.0.0.1');
    // The server's own lines, from its start (npm start: the page from source), each with its time.
    const started = serverLog(userData);
    expect(started).toMatch(/^\S+Z info  Magnusim CAD server starting \(the page from source; pid \d+, Node v[\d.]+, Electron [\d.]+\)$/m);
    expect(started).toContain(`info  server listening on 127.0.0.1:${url.port}\n`);
    for (const l of started.split('\n').filter(Boolean)) expect(l).toMatch(LOG_LINE);
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
    // The log goes on to the end: the quit is in it.
    await expect.poll(() => serverLog(userData), { timeout: 15_000 }).toMatch(/^\S+Z info  server closing: the app quits$/m);
  } finally {
    await app.close().catch(() => undefined);
    removeTreeSync(root);
  }
});
