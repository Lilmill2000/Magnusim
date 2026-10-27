// Magnusim CAD as a person installs it: the installer from desktop/dist (npm run dist), put in a
// folder of the test's own, per-user and silent. The installed app runs the built page with no
// Python, makes a Part with CAD's kernel, and carries its licences; its CAD workspace is the
// plugin's, byte for byte (the two apps mirror each other). Uninstalling keeps the person's
// settings and projects.
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '../e2e-cad/pw';
import { drawBlock, historyNames, partOpened } from '../bundled-plugins/cad/e2e/helpers';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(WEB, 'desktop', 'dist');

function files(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p).replace(/\\/g, '/'), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

test('the installed app: built page, a Part with CAD, its licences, the plugin\'s workspace; uninstall keeps settings', async () => {
  test.setTimeout(600_000);
  const setup = existsSync(DIST) ? readdirSync(DIST).find((f) => /^Magnusim-CAD-Setup-.*\.exe$/.test(f)) : undefined;
  test.skip(!setup, 'no installer: run npm run dist in desktop/ first');
  const root = mkdtempSync(join(tmpdir(), 'magnusim-cad-installed-'));
  const dir = join(root, 'Magnusim CAD');
  const userData = join(root, 'user data');
  const projects = join(root, 'projects');
  // Silent, per-user, into the test's folder (/D= comes last, unquoted, as NSIS takes it).
  execFileSync(join(DIST, setup!), ['/S', `/D=${dir}`], { timeout: 300_000, windowsHide: true });
  const exe = join(dir, 'Magnusim CAD.exe');
  try {
    expect(existsSync(exe)).toBe(true);
    // What ships beside it: the licences, the notices, CAD's licence texts; no Python, no tool files.
    const app = join(dir, 'resources', 'app');
    for (const f of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) expect(existsSync(join(dir, f)), f).toBe(true);
    for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'bundled-plugins/cad/LICENSES/OCCT-LGPL-2.1.txt', 'page/index.html']) expect(existsSync(join(app, f)), f).toBe(true);
    expect(readFileSync(join(app, 'LICENSE'), 'utf8')).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 3/);
    const notices = readFileSync(join(app, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    for (const part of ['Open CASCADE Technology 7.9.3', 'PlaneGCS', 'kernel-build', 'LICENSES.chromium.html', 'react ', 'three ']) expect(notices, part).toContain(part);
    expect(existsSync(join(app, 'python'))).toBe(false);
    const shipped = [...files(dir).keys()];
    // No hidden file or folder (a coding tool's own files start with a dot), no agent notes, no Python.
    expect(shipped.filter((f) => /(^|\/)\.[^/]+/.test(f) || /(^|\/)AGENTS\.md$/i.test(f) || (/\.py$/.test(f) && !f.endsWith('bundled-plugins/cad/plugin.py')))).toEqual([]);
    // The CAD workspace is the plugin's own, byte for byte.
    expect(files(join(app, 'bundled-plugins', 'cad', 'workspace'))).toEqual(files(join(WEB, 'bundled-plugins', 'cad', 'workspace')));

    const env = {
      ...process.env,
      MAGNUSIM_PROJECTS_ROOT: projects,
      MAGNUSIM_ASSISTANT_HOME: join(root, 'assistant'),
      PATH: String(process.env.PATH || '')
        .split(delimiter)
        .filter((d) => !/python|windowsapps/i.test(d))
        .join(delimiter),
    } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.MAGNUSIM_LOCAL_JSON;
    const running = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`], env });
    const page = await running.firstWindow();
    await expect(page).toHaveTitle('Magnusim CAD - Projects', { timeout: 60_000 });
    const origin = new URL(page.url()).origin;
    process.env.CAD_E2E_BASE_URL = origin;
    // The built page: no dev server's client.
    const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src));
    expect(scripts.some((s) => s.includes('/@vite/client'))).toBe(false);
    await page.locator('#home-new-project').click();
    await page.locator('#np-title').fill('Installed bench');
    await page.locator('#np-create').click();
    const frame = await partOpened(page);
    await drawBlock(page, frame, 30, 20, 10);
    await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1']);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Part 1']);
    await running.evaluate(({ app: a }) => a.quit());
    await expect.poll(() => fetch(`${origin}/api/plugins`).then(() => 'up', () => 'down'), { timeout: 15_000 }).toBe('down');
    expect(existsSync(join(userData, 'local.json')) || existsSync(join(userData, 'desktop.log'))).toBe(true);
  } finally {
    // Uninstall silently: the settings question answers No; the projects are not the uninstaller's.
    const uninstaller = join(dir, 'Uninstall Magnusim CAD.exe');
    if (existsSync(uninstaller)) execFileSync(uninstaller, ['/S'], { timeout: 120_000, windowsHide: true });
  }
  await expect.poll(() => existsSync(exe), { timeout: 30_000 }).toBe(false);
  expect(existsSync(userData), 'settings kept').toBe(true);
  expect(statSync(projects).isDirectory(), 'projects kept').toBe(true);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});
