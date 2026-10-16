// Settings → Assistant (Foundation spec 4.2–4.4): where the step sits in Settings, a
// cloud key that is write-only, an endpoint outside this PC that asks first, privacy and
// limits that save at once, the remote view, and a key save that outlives the step that
// sent it. Its own server with the Assistant's test switch (a test home, never this PC's
// keys); on Windows the real DPAPI helper keeps the key, elsewhere the file protector.
// The model list, the connection Test and the spend after a Test come with the model
// adapters and their own tests.
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { startHost } from './support/host-server.mjs';
import {
  appReady,
  assistantPane,
  assistantStatus,
  chooseProvider,
  closeSettings,
  filesHolding,
  openAssistantStep,
  resetAssistant,
} from './support/assistant.js';
import { expect, test } from './support/stress.js';

const REMOTE_TEXT =
  'The Assistant and its API keys can only be set up and used on the PC running Magnusim. Over remote access it is off.';

let host;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  host = await startHost({ name: 'assistant-settings', env: { MAGNUSIM_TEST_ASSISTANT: '1' } });
});

test.afterAll(() => {
  if (host) host.stop();
});

test.beforeEach(async ({ request }) => {
  await resetAssistant(request, host.base);
});

test('the Assistant step sits between Workspace and Plugins and is Off; Next goes on to Plugins, Finish closes', async ({ page, request }) => {
  await page.goto(`${host.base}/#/`);
  await appReady(page);
  const wizard = page.locator('#setup-wizard');
  await page.locator('#home-prefs').click();
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('#wiz-rail li')).toHaveText(['Welcome', 'Units', 'This PC', 'Port', 'Workspace', 'Assistant', 'Plugins']);
  await expect(wizard.locator('.wiz-pane[data-wiz-key="workspace"]')).toBeVisible();

  await page.locator('#wiz-next').click();
  const pane = assistantPane(page);
  await expect(pane).toBeVisible();
  await expect(pane.locator('h2')).toHaveText('Assistant');
  await expect(wizard.locator('#wiz-rail li.is-on')).toHaveText('Assistant');
  await expect(pane.locator('[data-assistant-provider]')).toHaveAttribute('data-assistant-provider', 'off');
  await expect(pane.locator('[data-assistant-provider-option="off"] input')).toBeChecked();
  await expect(pane.getByRole('radio')).toHaveCount(4);
  await expect(pane.locator('[data-assistant-key], [data-assistant-model], [data-assistant-limits]')).toHaveCount(0);
  expect((await assistantStatus(request, host.base)).provider).toBe('off');
  await expect(page.locator('#wiz-next')).toHaveText('Next');

  await page.locator('#wiz-next').click();
  await expect(wizard.locator('.wiz-pane[data-wiz-key="plugins"]')).toBeVisible();
  // Left, the step is gone from the page (it holds a key field).
  await expect(page.locator('#wiz-assistant [data-assistant-step]')).toHaveCount(0);
  await expect(page.locator('#wiz-next')).toHaveText('Finish');
  await page.locator('#wiz-back').click();
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-assistant-step]')).toHaveCount(1);
  await page.locator('#wiz-next').click();
  await page.locator('#wiz-next').click();
  await expect(wizard).toBeHidden();
  await expect(page.locator('#wiz-assistant [data-assistant-step]')).toHaveCount(0);

  // A link about the Assistant opens Settings on it.
  await page.evaluate(() => window.__CFD_OPEN_WIZARD__({ step: 'assistant' }));
  await expect(pane.locator('[data-assistant-step]')).toHaveCount(1);
  await closeSettings(page);
});

test('a cloud key is write-only: shown by its last 4, never in the page, an answer, the files or the log', async ({ page, request }) => {
  test.setTimeout(120_000);
  const canary = `sk-ant-e2e${randomBytes(10).toString('hex')}1234`;
  const answers = [];
  // Every API answer the page read in full (a stream never finishes, and is left out).
  page.on('requestfinished', (req) => {
    const url = req.url();
    if (!url.includes('/api/')) return;
    answers.push(
      req
        .response()
        .then((r) => (r ? r.text() : ''))
        .then(
          (t) => ({ url, t }),
          () => ({ url, t: '' }),
        ),
    );
  });
  await page.goto(`${host.base}/#/`);
  let pane = await openAssistantStep(page);
  await chooseProvider(page, 'anthropic');
  const input = pane.locator('[data-assistant-key-input]');
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('No key');

  // Password managers neither offer nor save it.
  await expect(input).toHaveAttribute('autocomplete', 'off');
  await expect(input).toHaveAttribute('autocorrect', 'off');
  await expect(input).toHaveAttribute('autocapitalize', 'off');
  await expect(input).toHaveAttribute('spellcheck', 'false');
  await expect(input).toHaveAttribute('data-1p-ignore', '');
  await expect(input).toHaveAttribute('data-lpignore', 'true');
  await expect(input).toHaveAttribute('data-bwignore', '');
  await expect(input).toHaveAttribute('data-form-type', 'other');
  const field = await input.evaluate((el) => ({
    form: !!el.closest('form'),
    name: el.hasAttribute('name'),
    id: el.hasAttribute('id'),
    type: el.type,
    security: getComputedStyle(el).getPropertyValue('-webkit-text-security'),
  }));
  expect(field).toEqual({ form: false, name: false, id: false, type: 'text', security: 'disc' });

  await input.fill(canary);
  await pane.locator('[data-assistant-key-save]').click();
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …1234');
  await expect(input).toHaveValue('');
  const status = await assistantStatus(request, host.base);
  expect(status.keys.anthropic).toMatchObject({ set: true, last4: '1234', state: 'ok' });
  expect(JSON.stringify(status)).not.toContain(canary);

  // Not in the page: its markup, any field, the page's prefs.
  expect(await page.content()).not.toContain(canary);
  const inPage = await page.evaluate(
    (c) =>
      [...document.querySelectorAll('input, textarea')].some((el) => el.value.includes(c)) ||
      JSON.stringify(window.__CFD_PREFS__ || {}).includes(c),
    canary,
  );
  expect(inPage).toBe(false);
  // Not in any file of this server (the key file holds it sealed), nor its log.
  expect(filesHolding(host.tmp, canary)).toEqual([]);
  expect(host.log()).not.toContain(canary);

  // A reload keeps it.
  await page.reload();
  pane = await openAssistantStep(page);
  await expect(pane.locator('[data-assistant-provider]')).toHaveAttribute('data-assistant-provider', 'anthropic');
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …1234');

  // Remove asks first, with Cancel focused; Remove clears it.
  await pane.locator('[data-assistant-key-remove]').click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('No key');
  await expect(pane.locator('[data-assistant-key-remove]')).toHaveCount(0);
  expect((await assistantStatus(request, host.base)).keys.anthropic.set).toBe(false);

  const texts = await Promise.all(answers);
  expect(texts.length).toBeGreaterThan(3);
  expect(texts.filter((a) => a.t.includes(canary)).map((a) => a.url)).toEqual([]);
  expect(filesHolding(host.tmp, canary)).toEqual([]);
  expect(host.log()).not.toContain(canary);
});

test('a server outside this PC asks first; Cancel keeps the old address', async ({ page, request }) => {
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  await chooseProvider(page, 'openai_compatible');
  const field = pane.locator('[data-assistant-endpoint]');
  const dialog = page.locator('#modal-confirm');
  await expect(field).toHaveValue('http://127.0.0.1:1234/v1');
  await expect(pane.locator('[data-assistant-privacy-local]')).toHaveText('On this PC: project data stays here.');
  await expect(pane.locator('[data-assistant-price]')).toHaveText('No cost (runs on this PC).');

  await field.fill('http://192.0.2.10:1234/v1');
  await field.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Use a server on another computer?');
  await expect(page.locator('#cf-copy')).toContainText('http://192.0.2.10:1234/v1 is not on this PC.');
  await expect(page.locator('#cf-cancel')).toBeFocused();
  // Enter answers Cancel here.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(field).toHaveValue('http://127.0.0.1:1234/v1');
  const kept = await assistantStatus(request, host.base);
  expect(kept.base_url).toBe('http://127.0.0.1:1234/v1');
  expect(kept.base_url_is_local).toBe(true);

  // Yes this time: saved, and project data sent there is asked about.
  await field.fill('http://192.0.2.10:1234/v1');
  await field.press('Enter');
  await expect(dialog).toBeVisible();
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => (await assistantStatus(request, host.base)).base_url).toBe('http://192.0.2.10:1234/v1');
  await expect(field).toHaveValue('http://192.0.2.10:1234/v1');
  await expect(pane.locator('[data-assistant-privacy]')).toBeVisible();
  await expect(pane.locator('[data-assistant-privacy-local]')).toHaveCount(0);

  // A server on this PC needs no question; Ollama's port gets its context hint.
  await pane.locator('[data-assistant-endpoint-preset="ollama"]').click();
  await expect(field).toHaveValue('http://127.0.0.1:11434/v1');
  await expect(dialog).toBeHidden();
  await expect(pane.locator('[data-assistant-ollama-hint]')).toBeVisible();
  expect((await assistantStatus(request, host.base)).base_url).toBe('http://127.0.0.1:11434/v1');
});

test('privacy and limits save at once and survive reopening and a reload; an invalid limit says why', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(`${host.base}/#/`);
  let pane = await openAssistantStep(page);
  await chooseProvider(page, 'anthropic');
  await expect(pane.locator('[data-assistant-privacy]')).toHaveAttribute('data-assistant-privacy', 'ask');
  await pane.locator('[data-assistant-privacy-option="allow"] input').check();
  await expect.poll(async () => (await assistantStatus(request, host.base)).privacy).toBe('allow');

  const turn = pane.locator('[data-assistant-cap-turn-usd]');
  await turn.fill('2.5');
  await turn.press('Enter');
  await expect.poll(async () => (await assistantStatus(request, host.base)).caps.turn_usd).toBe(2.5);
  await expect(turn).toHaveValue('2.50');
  const steps = pane.locator('[data-assistant-cap-steps]');
  await steps.fill('20');
  await steps.press('Enter');
  await expect.poll(async () => (await assistantStatus(request, host.base)).caps.steps).toBe(20);

  // Out of range: the reason under the field, what was typed kept, nothing saved.
  const day = pane.locator('[data-assistant-cap-day-usd]');
  await day.fill('0.01');
  await day.press('Enter');
  await expect(pane.locator('[data-assistant-cap-error="day_usd"]')).toHaveText('This limit must be from $0.10 to $1000.00.');
  await expect(day).toHaveValue('0.01');
  expect((await assistantStatus(request, host.base)).caps.day_usd).toBe(15);
  await expect(pane.locator('[data-assistant-spent]')).toHaveText('Spent today: $0.00 of $15.00');
  await expect(pane.locator('[data-assistant-shared-pc]')).toHaveText(
    "Anyone signed in to this PC can use the Assistant through Magnusim (they can't see your key); these limits apply to them too.",
  );

  const expectSaved = async (p) => {
    await expect(p.locator('[data-assistant-provider]')).toHaveAttribute('data-assistant-provider', 'anthropic');
    await expect(p.locator('[data-assistant-privacy-option="allow"] input')).toBeChecked();
    await expect(p.locator('[data-assistant-cap-turn-usd]')).toHaveValue('2.50');
    await expect(p.locator('[data-assistant-cap-steps]')).toHaveValue('20');
    await expect(p.locator('[data-assistant-cap-day-usd]')).toHaveValue('15.00');
    await expect(p.locator('[data-assistant-cap-error="day_usd"]')).toHaveCount(0);
  };
  await closeSettings(page);
  pane = await openAssistantStep(page);
  await expectSaved(pane);
  await page.reload();
  pane = await openAssistantStep(page);
  await expectSaved(pane);
});

test('over remote access the step only says it is off there; the rail still lists it', async ({ browser }) => {
  // Every request of this browser comes through a proxy, as over the public tunnel.
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.9' } });
  try {
    const page = await context.newPage();
    await page.goto(`${host.base}/#/`);
    const pane = await openAssistantStep(page);
    await expect(page.locator('#wiz-rail li[data-wiz-key="assistant"]')).toHaveText('Assistant');
    const only = pane.locator('[data-assistant-local-only]');
    await expect(only).toHaveText(REMOTE_TEXT);
    await expect(page.locator('#wiz-assistant').getByRole('radio')).toHaveCount(0);
    await expect(page.locator('#wiz-assistant input, #wiz-assistant button')).toHaveCount(0);
    await expect(page.locator('#wiz-assistant')).toHaveText(REMOTE_TEXT);
    // The server sees this page as remote.
    const seen = await page.evaluate(async () => {
      const r = await fetch('/api/assistant/status', { cache: 'no-store' });
      return { status: r.status, reason: (await r.json()).reason };
    });
    expect(seen).toEqual({ status: 403, reason: 'remote' });
  } finally {
    await context.close();
  }
});

test('a key save that answers after the step was opened again still shows', async ({ page, request }) => {
  const key = `sk-ant-race${randomBytes(8).toString('hex')}1234`;
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  await chooseProvider(page, 'anthropic');

  // The save is held on its way to the server.
  let sent;
  let releaseSave;
  const saveSent = new Promise((r) => (sent = r));
  const saveReleased = new Promise((r) => (releaseSave = r));
  await page.route('**/api/assistant/key', async (route) => {
    sent();
    await saveReleased;
    await route.continue();
  });
  await pane.locator('[data-assistant-key-input]').fill(key);
  await pane.locator('[data-assistant-key-save]').click();
  await saveSent;
  await expect(pane.locator('[data-assistant-key-input]')).toHaveValue('');

  // The step mounted again reads the status: the server answers it now (no key yet), and
  // that answer reaches the page only after the save's.
  let readAnswered;
  let releaseRead;
  const staleRead = new Promise((r) => (readAnswered = r));
  const readReleased = new Promise((r) => (releaseRead = r));
  await page.route(
    '**/api/assistant/status',
    async (route) => {
      const response = await route.fetch();
      readAnswered();
      await readReleased;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  let statusAnswers = 0;
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/assistant/status') statusAnswers += 1;
  });
  await page.locator('#wiz-rail li[data-wiz-key="plugins"]').click();
  await expect(pane.locator('[data-assistant-step]')).toHaveCount(0);
  await page.locator('#wiz-rail li[data-wiz-key="assistant"]').click();
  await staleRead;

  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/assistant/key');
  releaseSave();
  expect((await saved).status()).toBe(200);
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …1234');
  releaseRead();
  // The stale answer arrives, is dropped, and the status is read again.
  await expect.poll(() => statusAnswers).toBeGreaterThanOrEqual(2);
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …1234');
  expect((await assistantStatus(request, host.base)).keys.anthropic).toMatchObject({ set: true, last4: '1234' });
});
