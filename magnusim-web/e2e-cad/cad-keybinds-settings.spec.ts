// Settings → Keybinds in Magnusim CAD with a Part open (the CAD plugin's commands file, manifest
// `[[workspaces]] commands`): the Part's commands are listed with their keys, a key changed in
// Settings in one window is the open Part's at once in another (its tooltip says so), and Reset
// puts the default back there too. The keys are the person's pref on the server: the test puts it back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from './pw';
import { partOpened, watchPage, workspaceFrame } from '../bundled-plugins/cad/e2e/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; keybinds: { model: { current(id: string): readonly string[] } } } };
const keysOf = (page: Page, id: string) => workspaceFrame(page).evaluate((i: string) => [...(window as unknown as W).__CAD__.keybinds.model.current(i)], id);
const shownOf = (page: Page, id: string) =>
  workspaceFrame(page).evaluate((i: string) => ((window as unknown as W).__CAD__.services.commands.get(i)?.shortcut as string | undefined) ?? null, id);

test('a Part key changed in Settings is the open Part\'s at once, and Reset brings the default back', async ({ browser, request }) => {
  const context = await browser.newContext();
  try {
    await request.post('/api/plugin-prefs/remove', { data: { plugin: 'cad', key: 'keybinds' } });
    const made = await request.post('/api/project', { data: { title: 'Keys in Settings', category: 'Other', units: 'Metric' } });
    expect(made.ok()).toBe(true);
    const pid = String((await made.json()).id);
    const st = await request.post('/api/plugin-studies/create', { data: { project_id: pid, plugin: 'cad', kind: 'part', title: 'Part 1' } });
    expect(st.ok()).toBe(true);

    // Window A: the Part open.
    const part = await context.newPage();
    const seen = await watchPage(part);
    await part.goto(`/#/p/${pid}`);
    await part.locator('#cad-project .cad-part-open', { hasText: 'Part 1' }).click();
    await partOpened(part);
    expect(await keysOf(part, 'sketch.rectangle')).toEqual(['KeyR']);

    // Window B: Settings → Keybinds lists the Part's commands under its plugin.
    const settings = await context.newPage();
    await settings.goto('/');
    await settings.locator('#home-prefs').click();
    await settings.locator('#wiz-rail li[data-wiz-key="keybinds"]').click();
    const cad = settings.locator('#setup-wizard [data-keys-plugin="cad"]');
    await expect(cad.locator('.wiz-keys-scope-title')).toHaveText('Magnusim CAD', { timeout: 30_000 });
    await expect(cad.locator('[data-keys-workspace="part"] .wiz-keys-ws-title')).toHaveText('Part workspace');
    const rect = cad.locator('[data-keybind="sketch.rectangle"]');
    await expect(rect.locator('[data-keybind-keys] kbd')).toHaveText(['R']);
    await expect(rect).toContainText('Sketch');

    // Change it there: the open Part takes it, its tooltip too, without reopening.
    await rect.locator('[data-keybind-change]').click();
    await settings.keyboard.press('Shift+KeyT');
    await expect(rect.locator('[data-keybind-keys] kbd')).toHaveText(['Shift+T']);
    await expect.poll(() => keysOf(part, 'sketch.rectangle'), { timeout: 10_000 }).toEqual(['Shift+KeyT']);
    await expect.poll(() => shownOf(part, 'sketch.rectangle')).toBe('Shift+T');

    // Reset there: the default is the Part's again.
    await rect.locator('[data-keybind-reset]').click();
    await expect(rect.locator('[data-keybind-keys] kbd')).toHaveText(['R']);
    await expect.poll(() => keysOf(part, 'sketch.rectangle'), { timeout: 10_000 }).toEqual(['KeyR']);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  } finally {
    await request.post('/api/plugin-prefs/remove', { data: { plugin: 'cad', key: 'keybinds' } });
    await context.close();
  }
});
