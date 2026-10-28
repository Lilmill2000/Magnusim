// Settings → Keybinds (src/panels/prefs/KeybindsStep.tsx): what Daniel sees when he sets his own
// keys. The keys-demo plugin (python/tests/fixtures/keybind-plugins) has a Board workspace that
// lists its commands (workspace/commands.json) and a Broken one whose commands file is not there.
// Settings lists the app's own keys, the browser's in a fold, and the plugin's commands with
// their keys; the Broken workspace says why it has none. Change takes the next key press and the
// Board open in another tab shows it and answers to it at once; a key the app or the browser
// keeps is refused, Escape cancels without closing Settings, a key another command has asks
// Replace or Cancel, Reset and Reset all put the defaults back, and the keys hold after a reload.
// The Assistant (the scripted model) reads them any time, but changes one only when Daniel asked
// for it, and only on his Yes in the app's own confirm: Keep it changes nothing.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appReady, dockSend, dockTurn, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const KEY = 'keys-demo';
let host;
let fake;
let project;
let study;

test.describe.configure({ mode: 'serial' });

const api = (path) => `${host.base}${path}`;
const prefsFile = () => join(dirname(host.prefs), '.magnusim-plugin-prefs', `${KEY}.json`);
const storedKeys = () => (existsSync(prefsFile()) ? JSON.parse(readFileSync(prefsFile(), 'utf8')).keybinds ?? null : null);

async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  host = await startHost({
    name: 'keybinds',
    pluginsFrom: 'python/tests/fixtures/keybind-plugins',
    env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base },
  });
  project = (await postOk(request, '/api/project', { title: 'Keys', folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  study = (await postOk(request, '/api/plugin-studies/create', { project_id: project, plugin: KEY, kind: 'board', title: 'Board 1' })).study.id;
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

/** A tab with the Board open: its list of keys and what a press ran. */
async function openBoard(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(api(`/#/p/${project}/ws/${KEY}/board/${study}`));
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('#keys-title')).toHaveText('Board 1', { timeout: 60_000 });
  return { page, frame, key: (id) => frame.locator(`[data-command="${id}"]`), ran: frame.locator('#keys-ran') };
}

/** A tab on Home with Settings open on Keybinds. */
async function openKeybinds(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(api('/#/'));
  await appReady(page);
  await page.locator('#home-prefs').click();
  await page.locator('#wiz-rail li[data-wiz-key="keybinds"]').click();
  const pane = page.locator('#setup-wizard .wiz-pane[data-wiz-key="keybinds"]');
  await expect(pane.locator('[data-keys-plugin="keys-demo"]')).toBeVisible({ timeout: 30_000 });
  const row = (id) => pane.locator(`[data-keys-plugin="keys-demo"] [data-keybind="${id}"]`);
  return { page, pane, row, keys: (id) => row(id).locator('[data-keybind-keys] kbd') };
}

test("gate:keybinds a person sets their own keys in Settings, and the open workspace uses them at once @plugins", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  try {
    const board = await openBoard(context);
    await expect(board.key('sketch.rectangle')).toHaveText('Rectangle: KeyR');
    const s = await openKeybinds(context);

    // What is listed: the app's own keys (nothing to press on them), the browser's in a fold,
    // the plugin's commands with their keys and where they work; the Broken workspace says why.
    await expect(s.pane.locator('[data-keys-plugin="app"] [data-keybind="app.assistant"] kbd').first()).toHaveText('Ctrl+/');
    await expect(s.pane.locator('[data-keys-plugin="app"] button')).toHaveCount(0);
    await expect(s.pane.locator('[data-keys-reserved] summary')).toHaveText('Kept for the browser and the system');
    await expect(s.keys('sketch.rectangle')).toHaveText(['R']);
    await expect(s.row('view.fit')).toContainText('Everywhere');
    await expect(s.pane.locator('[data-keys-workspace="broken"] [data-keys-workspace-error]')).toContainText("Its keys can't be listed: ");
    await expect(s.pane.locator('[data-keys-workspace="broken"] [data-keys-workspace-error]')).toContainText('missing.json');

    // Change: the next press is the key; the Board in the other tab shows it and answers to it.
    await s.row('sketch.rectangle').locator('[data-keybind-change]').click();
    await expect(s.row('sketch.rectangle').getByRole('textbox')).toBeFocused();
    await s.page.keyboard.press('Shift+KeyR');
    await expect(s.keys('sketch.rectangle')).toHaveText(['Shift+R']);
    await expect(s.row('sketch.rectangle').locator('[data-keybind-note="saved"]')).toHaveText('Saved');
    await expect(board.key('sketch.rectangle')).toHaveText('Rectangle: Shift+KeyR');
    await board.frame.locator('#keys-title').click();
    await board.page.keyboard.press('Shift+KeyR');
    await expect(board.ran).toHaveText('Ran: Rectangle (Shift+KeyR)');
    await board.page.keyboard.press('KeyR');
    await expect(board.ran).toHaveText('Ran: nothing (KeyR)');
    expect(storedKeys()).toEqual({ 'sketch.rectangle': ['Shift+KeyR'] });

    // The app's key is refused and the Assistant panel stays shut; Escape cancels, Settings stays.
    await s.row('sketch.line').locator('[data-keybind-change]').click();
    await s.page.keyboard.press('Control+Slash');
    await expect(s.row('sketch.line').locator('[data-keybind-note="error"]')).toHaveText("Ctrl+/ is the app's own key (Open or close the Assistant panel). Press another.");
    await expect(s.page.locator('#assistant-dock')).toBeHidden();
    await s.page.keyboard.press('Escape');
    await expect(s.row('sketch.line').getByRole('textbox')).toHaveCount(0);
    await expect(s.page.locator('#setup-wizard')).toBeVisible();
    await expect(s.keys('sketch.line')).toHaveText(['L']);

    // A key another command has: Replace or Cancel. Replace takes it, and the Board follows.
    await s.row('sketch.line').locator('[data-keybind-change]').click();
    await s.page.keyboard.press('KeyF');
    const conflict = s.row('sketch.line').locator('[data-keybind-conflict]');
    await expect(conflict).toContainText('F is already the key of Fit (Everywhere).');
    await conflict.getByRole('button', { name: 'Replace' }).click();
    await expect(s.keys('sketch.line')).toHaveText(['F']);
    await expect(s.row('view.fit')).toContainText('No key');
    await expect(board.key('view.fit')).toHaveText('Fit: no key');
    await expect(board.key('sketch.line')).toHaveText('Line: KeyF');

    // The same key where the two never meet (sketch and model) is no conflict.
    await s.row('model.extrude').locator('[data-keybind-change]').click();
    await s.page.keyboard.press('KeyR');
    await expect(s.keys('model.extrude')).toHaveText(['R']);

    // The keys hold after a reload; Reset puts one back; Reset all every one, and the Board follows.
    await s.page.reload();
    await appReady(s.page);
    await s.page.locator('#home-prefs').click();
    await s.page.locator('#wiz-rail li[data-wiz-key="keybinds"]').click();
    await expect(s.keys('sketch.line')).toHaveText(['F']);
    // Fit's default (F) is Line's now: Reset asks too, and Replace gives it back.
    await s.row('view.fit').locator('[data-keybind-reset]').click();
    const back = s.row('view.fit').locator('[data-keybind-conflict]');
    await expect(back).toContainText('F is already the key of Line (Sketch).');
    await back.getByRole('button', { name: 'Replace' }).click();
    await expect(s.keys('view.fit')).toHaveText(['F']);
    await expect(s.row('sketch.line')).toContainText('No key');
    await expect(board.key('view.fit')).toHaveText('Fit: KeyF');
    expect(storedKeys()).toEqual({ 'sketch.rectangle': ['Shift+KeyR'], 'sketch.line': [], 'model.extrude': ['KeyR'] });
    await s.pane.locator('[data-keys-plugin="keys-demo"] [data-keys-reset-all]').click();
    await expect(s.keys('sketch.rectangle')).toHaveText(['R']);
    await expect(board.key('sketch.rectangle')).toHaveText('Rectangle: KeyR');
    await expect(board.key('sketch.line')).toHaveText('Line: KeyL');
    expect(storedKeys()).toBeNull();
  } finally {
    await context.close();
  }
});

test("gate:keybinds-ai the Assistant reads the keys any time, and changes one only when asked, on the person's Yes @plugins", async ({ page, request }) => {
  test.setTimeout(180_000);
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  const call = (name, input) => ({ tools: [{ name, input }] });
  const set = (o) => call('core__set_keybind', { plugin: KEY, command: 'sketch.line', action: 'set', keys: 'Shift+L', replace: false, person_asked: true, ...o });
  /** The tool results the model was answered with this request, and the reply that follows them. */
  let seen = [];
  const after = (reply) => (body) => {
    seen.push(...resultsIn(body));
    return reply;
  };
  await page.goto(api('/#/'));
  await appReady(page);
  const confirm = page.locator('#modal-confirm');

  // Not asked for: refused before anything is shown.
  seen = [];
  fake.reply(() => set({ person_asked: false }), after({ text: 'Done.' }));
  await dockSend(page, 'What are my keys?');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  expect(JSON.stringify(seen)).toContain('not_asked');
  await expect(confirm).toBeHidden();

  // Asked for: the app asks; Keep it changes nothing.
  seen = [];
  fake.reply(
    () => call('core__keybinds', { plugin: '', target: 'Line' }),
    after(set({})),
    after({ text: 'Left it.' }),
  );
  await dockSend(page, 'Give Line the key Shift+L');
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#cf-heading')).toHaveText('Change a keybind?');
  await expect(page.locator('#cf-copy')).toHaveText('The Assistant asks to give Line (Keys demo) the key Shift+L.');
  await page.locator('#cf-cancel').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  expect(JSON.stringify(seen)).toContain('"KeyL"');
  expect(JSON.stringify(seen)).toContain('step_declined');
  expect(storedKeys()).toBeNull();

  // Asked for again: the person's Yes (a deliberate click once it is enabled) changes it.
  seen = [];
  fake.reply(() => set({}), after({ text: 'Done.' }));
  await dockSend(page, 'Yes, give Line the key Shift+L');
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#cf-confirm')).toBeEnabled({ timeout: 5_000 });
  await page.locator('#cf-confirm').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  expect(storedKeys()).toEqual({ 'sketch.line': ['Shift+KeyL'] });
  // Settings shows it.
  await page.locator('#home-prefs').click();
  await page.locator('#wiz-rail li[data-wiz-key="keybinds"]').click();
  await expect(page.locator('[data-keys-plugin="keys-demo"] [data-keybind="sketch.line"] [data-keybind-keys] kbd')).toHaveText(['Shift+L'], { timeout: 30_000 });
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});
