// SD pass, review round 2, the blocker, in the real host frame with the real
// kernel (the polish is in cad-sd-review2.spec.ts; this file has its own
// browser, see below).
//   - typed-then-leave: a value typed in a CAD panel field and not applied yet
//     (no Enter, no Tab) is never lost when the user leaves the workspace: Back
//     to project, the browser's Back. Either the app asks first, or the reopened
//     Part shows the value (an Enclosure side, an Extrude Distance); a value the
//     field refuses keeps the page unsaved, so the app asks.
//     It runs in real Chrome when this PC has it (else Edge, else the bundled
//     Chromium): there the Part's frame runs in its own process, so its field's
//     blur arrives after the host has closed the workspace, which is how the
//     value was lost; the bundled Chromium keeps the frame in the page's process
//     and its blur came in time.
// window.__CAD__ is used to read exact figures the panel rounds.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, answerLeave, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

/** Real Chrome (else Edge) when installed: its frame runs out of process, as a user's does. */
function realBrowser(): string | undefined {
  const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean) as string[];
  if (pf.some((d) => existsSync(join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')))) return 'chrome';
  if (pf.some((d) => existsSync(join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')))) return 'msedge';
  return undefined;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, projectId };
}

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${esc(name)}$`) }) });
const fieldInput = (frame: FrameLocator, key: string) => panel(frame).locator(`.nui[data-field="${key}"] input`);
const partRow = (page: Page) => page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: 'Part 1' }) });
const overlay = (page: Page) => page.locator('#workspace-overlay');
const expectSaved = (frame: FrameLocator) => expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });

async function openEnclosure(frame: FrameLocator) {
  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText(/^Enclosure \d+$/);
}

async function openFeature(frame: FrameLocator, name: string) {
  await featureRow(frame, name).locator('> .tree-row').dblclick();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText(name);
}

/** Type into a panel field and leave it holding the text: no Enter, no Tab, the field keeps focus. */
async function typeOnly(frame: FrameLocator, key: string, text: string) {
  const input = fieldInput(frame, key);
  await input.click();
  await input.fill(text);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(text);
}

/**
 * Leave the Part by `how` with something typed. The app either closes the
 * workspace (the value went with the Part) or asks first; when it asks, the
 * question is the usual one, Stay keeps the user in the Part (the value is then
 * applied and saved), and leaving again closes it. Returns whether it asked.
 */
async function leave(page: Page, frame: FrameLocator, how: () => Promise<void>): Promise<'asked' | 'left'> {
  await how();
  const modal = page.locator('#modal-confirm');
  let seen = 'wait' as 'asked' | 'left' | 'wait';
  await expect
    .poll(async () => {
      seen = (await modal.isVisible()) ? 'asked' : (await overlay(page).isHidden()) ? 'left' : 'wait';
      return seen;
    }, { timeout: 15_000 })
    .not.toBe('wait');
  if (seen === 'left') return 'left';
  await expect(page.locator('#cf-heading')).toHaveText('Leave without saving?');
  await expect(page.locator('#cf-copy')).toHaveText('Magnusim CAD: Changes to Part 1 are not saved yet. Leaving discards them.');
  await answerLeave(page, false);
  await expect(overlay(page)).toBeVisible();
  await expectSaved(frame);
  await how();
  await expect(modal).toBeHidden();
  await expect(overlay(page)).toBeHidden();
  return 'asked';
}

const clickBack = (page: Page) => () => page.locator('#workspace-overlay [data-ws-back]').click();

async function reopen(page: Page): Promise<FrameLocator> {
  const frame = await openPart(page, partRow(page));
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return frame;
}

// ---------------------------------------------------------------- blocker

// The run's own channel (the chrome / msedge projects) stands; the bundled Chromium's runs use real Chrome here.
test.use({ channel: [async ({ channel }: { channel?: string }, use: (c: string | undefined) => Promise<void>) => use(channel || realBrowser()), { scope: 'worker' }] as never });

test('cad:sd-review2-typed-then-leave a value typed and not applied is never lost on leaving: Back keeps an Enclosure side and an Extrude Distance; browser Back too; a refused value asks', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await openEnclosure(frame);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expectSaved(frame);

  // 1. Enclosure +Y: 7 typed, then Back to project (the reviewer's steps).
  await openFeature(frame, 'Enclosure 1');
  await typeOnly(frame, 'side-py', '7');
  const how1 = await leave(page, frame, clickBack(page));
  console.log(`[sd-review2] browser ${page.context().browser()?.version()}: enclosure Back ${how1}`);
  let f = await reopen(page);
  await openFeature(f, 'Enclosure 1');
  await expect(fieldInput(f, 'side-py')).toHaveValue('7');
  await expect(panel(f).locator('.cad-enclosure-side[data-side="+y"]')).toHaveAttribute('data-side-source', 'set');
  await shot(page, 'sd-r2-typed-back-enclosure');
  await panel(f).locator('[data-panel-done]').click();

  // 2. Extrude 1's Distance: 13 typed, then Back.
  await openFeature(f, 'Extrude 1');
  await typeOnly(f, 'distance', '13');
  const how2 = await leave(page, f, clickBack(page));
  console.log(`[sd-review2] extrude Back ${how2}`);
  f = await reopen(page);
  await openFeature(f, 'Extrude 1');
  await expect(fieldInput(f, 'distance')).toHaveValue('13');
  await panel(f).locator('[data-panel-done]').click();

  // 3. The browser's own Back (the pointer never leaves the frame): +Y 9.
  await openFeature(f, 'Enclosure 1');
  await typeOnly(f, 'side-py', '9');
  const how3 = await leave(page, f, async () => {
    await page.goBack();
  });
  console.log(`[sd-review2] browser Back ${how3}`);
  f = await reopen(page);
  await openFeature(f, 'Enclosure 1');
  await expect(fieldInput(f, 'side-py')).toHaveValue('9');

  // 4. A value the field refuses (past the part's far side): the page is not saved, so Back asks,
  // and says what is wrong; Stay keeps the text and its reason.
  await typeOnly(f, 'side-nx', '-60');
  await fieldInput(f, 'side-nx').press('Enter');
  await expect(panel(f).locator('.nui[data-field="side-nx"] [data-nui-error]')).toHaveText('−X would put the enclosure past the part (x ≥ 40 mm)');
  await expect(overlay(page).locator('.ws-shell')).toHaveAttribute('data-workspace-dirty', '1');
  await clickBack(page)();
  await expect(page.locator('#cf-heading')).toHaveText('Leave without saving?');
  await expect(page.locator('#cf-copy')).toHaveText('Magnusim CAD: Changes to Part 1 are not saved: the value typed in −X padding is not applied. −X would put the enclosure past the part (x ≥ 40 mm). Leaving discards them.');
  await shot(page, 'sd-r2-refused-asks');
  await answerLeave(page, false);
  await expect(fieldInput(f, 'side-nx')).toHaveValue('-60');
  // Escape takes the text back: nothing is left unsaved, and Back leaves without a question.
  await fieldInput(f, 'side-nx').focus();
  await fieldInput(f, 'side-nx').press('Escape');
  await expect(panel(f).locator('.nui[data-field="side-nx"] [data-nui-error]')).toHaveCount(0);
  await expect(overlay(page).locator('.ws-shell')).not.toHaveAttribute('data-workspace-dirty', '1');
  await clickBack(page)();
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator('#modal-confirm')).toBeHidden();

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
  void workspaceFrame;
});
