// Settings → Assistant (Foundation spec 4.2–4.4, 5.6): where the step sits in Settings, a
// local server's address, models and connection Test, a cloud key that is write-only and
// reaches the provider only in its own header, a cloud Test and the spend it adds, an
// endpoint outside this PC that asks first, privacy and limits that save at once, the
// remote view, a key save that outlives the step that sent it, leaving the step (a pasted
// key saved, its warning kept on screen, a change on its way waited for, a Test nobody
// waits for stopped), an address on another computer worded as such, and the Default
// choice with every provider's card listed: keys and models kept across default changes,
// a card's Test its own provider's. Its own server with
// the Assistant's test switches (a test home, never this PC's keys): both cloud providers
// go to a scripted fake provider in this process (support/fake-llm.mjs), and the local
// server is another fake of its own. On Windows the real DPAPI helper keeps the key,
// elsewhere the file protector.
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import {
  appReady,
  assistantPane,
  assistantStatus,
  chooseProvider,
  closeSettings,
  collectAnswers,
  filesHolding,
  noAgentsHere,
  openAssistantStep,
  openCard,
  pressTest,
  resetAssistant,
  saveKey,
  whereInRequest,
} from './support/assistant.js';
import { expect, test } from './support/stress.js';

/** Whether a switch shows the keyboard focus it has: its slider is outlined (the input itself is drawn invisible). */
const focusRingShown = (sw) =>
  sw.evaluate((el) => {
    const s = getComputedStyle(el.nextElementSibling);
    return el.matches(':focus-visible') && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1;
  });

const REMOTE_TEXT =
  'The Assistant and its API keys can only be set up and used on the PC running Magnusim. Over remote access it is off.';

/** A model that calls the test tool, then answers once its result came back (the Test's two requests). */
const callsTheTool = (usage) => [
  { tools: [{ name: 'connection_check', input: { word: 'ok' } }], ...(usage ? { usage } : {}) },
  { text: 'Connected.', ...(usage ? { usage } : {}) },
];

let host;
/** Both cloud providers' fake (MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL). */
let fake;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fake = await startFakeLlm();
  // The step looks for coding agents: only in empty folders of this server's own.
  const tmp = e2eTemp('assistant-settings');
  host = await startHost({
    name: 'assistant-settings',
    tmp,
    env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base, ...noAgentsHere(tmp) },
  });
  // The server ignores the provider switch unless every condition for it holds, and then the
  // cloud providers are the real ones: stop here, before any test saves a key.
  const r = await fetch(`${host.base}/api/assistant/status`);
  expect(r.status, 'status').toBe(200);
  expect((await r.json()).test_provider, 'the cloud providers go to the fake').toBe(true);
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

test.beforeEach(async ({ request }) => {
  await resetAssistant(request, host.base);
});

test.afterEach(() => {
  // An answer left queued would answer the next test's request.
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
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
  await expect(pane.locator('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'off');
  await expect(pane.locator('[data-assistant-default-option="off"] input')).toBeChecked();
  await expect(pane.getByRole('radiogroup', { name: 'Default provider' }).getByRole('radio')).toHaveCount(4);
  // Every provider's card is listed whatever the default; with none, none is open.
  await expect(pane.locator('[data-assistant-card]')).toHaveCount(3);
  await expect(pane.locator('[data-assistant-card][data-open="1"]')).toHaveCount(0);
  await expect(pane.locator('[data-assistant-key], [data-assistant-model]')).toHaveCount(0);
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

test("the Other apps switch shows the keyboard focus (WCAG 2.4.7): tabbed to, its slider is outlined", async ({ page }) => {
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  const sw = pane.getByRole('switch', { name: "Let other AI apps on this PC use Magnusim's tools" });
  await expect(sw).toHaveCount(1);
  // From the control before it, Tab: the focus is on the switch, and seen.
  await pane.locator('[data-assistant-agent-add-open]').focus();
  await page.keyboard.press('Tab');
  await expect(sw).toBeFocused();
  expect(await focusRingShown(sw), 'the Other apps switch shows its focus').toBe(true);
});

test('a local server: its address and models; Test says tool calling works, names the chat template when a call comes as text, and says when nothing answers', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const local = await startFakeLlm();
  try {
    local.models(['qwen3.8-27b', 'gemma-4-31b'], 'compat');
    // Saved before the step opens: a closed port on this PC, so the first list has nothing to ask.
    const closed = 'http://127.0.0.1:9/v1';
    const set = await request.post(`${host.base}/api/assistant/settings`, { data: { base_url: closed } });
    expect(set.status()).toBe(200);
    await page.goto(`${host.base}/#/`);
    const pane = await openAssistantStep(page);
    await chooseProvider(page, 'openai_compatible');
    const field = pane.locator('[data-assistant-endpoint]');
    const select = pane.locator('select[data-assistant-model]');
    const listError = pane.locator('[data-assistant-models-error]');
    await expect(field).toHaveValue(closed);
    await expect(listError).toHaveText(
      `Couldn't list the models: Nothing answered at ${closed}. Start the server (LM Studio: Developer → Start server; Ollama: ollama serve) and test again.`,
    );
    await expect(listError.locator('code')).toHaveText('ollama serve');

    // The fake server's address: on this PC, so no question; its models are listed.
    await field.fill(local.compatBase);
    await field.press('Enter');
    await expect.poll(async () => (await assistantStatus(request, host.base)).base_url).toBe(local.compatBase);
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await expect(select.locator('option')).toHaveText(['Choose a model', 'qwen3.8-27b', 'gemma-4-31b', 'Other model id…']);
    await expect(listError).toHaveCount(0);
    expect(local.requests().filter((r) => r.method === 'GET' && r.path === '/compat/v1/models').length).toBeGreaterThan(0);
    await select.selectOption('qwen3.8-27b');
    await expect(select).toHaveAttribute('data-assistant-model', 'qwen3.8-27b');
    expect((await assistantStatus(request, host.base)).models.openai_compatible).toBe('qwen3.8-27b');
    await expect(pane.locator('[data-assistant-price]')).toHaveText('No cost (runs on this PC).');
    await expect(pane.locator('[data-assistant-privacy-local]')).toHaveText('On this PC: project data stays here.');

    // The model calls the test tool, gets its result back and answers: two requests.
    local.reply(...callsTheTool());
    let result = await pressTest(page);
    await expect(result).toHaveText(/^Connected to qwen3\.8-27b in \d+\.\d s\. Tool calling works\.$/);
    await expect(result).toHaveAttribute('data-assistant-test-result', 'ok');
    const chats = local.requests().filter((r) => r.kind === 'chat');
    expect(chats.map((r) => r.refused ?? null)).toEqual([null, null]);
    expect(chats[0].body.model).toBe('qwen3.8-27b');
    expect(chats[0].body.tools.map((t) => t.function.name)).toEqual(['connection_check']);
    expect(chats[1].body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: expect.any(String) });
    // A local server costs nothing: today's (cloud) spend is unchanged.
    await expect(pane.locator('[data-assistant-spent]')).toHaveText('Spent today (API keys): $0.00 of $15.00');
    expect((await assistantStatus(request, host.base)).spent_today_usd).toBe(0);

    // A model whose chat template has no tool calls writes the call as text.
    local.reply({ rawToolText: '<tool_call>{"name": "connection_check", "arguments": {"word": "ok"}}</tool_call>' });
    result = await pressTest(page);
    await expect(result).toHaveText(
      /^Connected to qwen3\.8-27b in \d+\.\d s\. But the model wrote the tool call as text instead of making it: its chat template doesn't support tool calls, so Magnusim's tools won't work with it\. In LM Studio, pick a model marked for tool use or load a template that has them\.$/,
    );
    await expect(result).toHaveAttribute('data-assistant-test-result', 'failed');
    expect(local.requests().filter((r) => r.kind === 'chat')).toHaveLength(3);

    // The server stops: nothing answers there.
    await local.stop();
    result = await pressTest(page);
    await expect(result).toHaveText(
      `Nothing answered at ${local.compatBase}. Start the server (LM Studio: Developer → Start server; Ollama: ollama serve) and test again.`,
    );
    await expect(result.locator('code')).toHaveText('ollama serve');
    await expect(result).toHaveAttribute('data-assistant-test-result', 'failed');
    // A long result wraps beside the Test button, not under it.
    const button = await pane.locator('[data-assistant-test]').boundingBox();
    const line = await result.boundingBox();
    expect(line.height).toBeGreaterThan(button.height / 2);
    expect(line.x).toBeGreaterThanOrEqual(button.x + button.width);
    expect(line.y).toBeLessThan(button.y + button.height);
  } finally {
    await local.stop();
  }
});

test('a cloud key is write-only: shown by its last 4, never in the page, an answer, the files or the log', async ({ page, request }) => {
  test.setTimeout(120_000);
  const canary = `sk-ant-e2e${randomBytes(10).toString('hex')}1234`;
  const answers = collectAnswers(page);
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
  await expect(pane.locator('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'anthropic');
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …1234');

  // Remove asks first, with Cancel focused; Remove clears it.
  await pane.locator('[data-assistant-key-remove]').click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('No key');
  await expect(pane.locator('[data-assistant-key-remove]')).toHaveCount(0);
  // Remove went with the key: focus is on the key field, not left on the closed dialog.
  await expect(pane.locator('[data-assistant-key-input]')).toBeFocused();
  expect((await assistantStatus(request, host.base)).keys.anthropic.set).toBe(false);

  const texts = await answers.all();
  expect(texts.length).toBeGreaterThan(3);
  expect(texts.filter((a) => a.t.includes(canary)).map((a) => a.url)).toEqual([]);
  expect(filesHolding(host.tmp, canary)).toEqual([]);
  expect(host.log()).not.toContain(canary);
});

test('a saved cloud key reaches the provider only in its own header, and is nowhere else', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = randomBytes(8).toString('hex');
  const keys = { anthropic: `sk-ant-e2e${id}1111`, openai: `sk-e2e${id}2222` };
  const served = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol' };
  const from = fake.requests().length;
  const answers = collectAnswers(page);
  await page.goto(`${host.base}/#/`);
  await openAssistantStep(page);
  for (const provider of ['anthropic', 'openai']) {
    await chooseProvider(page, provider);
    await saveKey(page, keys[provider]);
    // With its key, the provider lists its models, and the Test reaches it.
    const dialect = (r) => r.dialect === provider;
    await expect.poll(() => fake.requests().slice(from).filter((r) => dialect(r) && r.path.endsWith('/v1/models')).length).toBeGreaterThan(0);
    fake.reply(...callsTheTool());
    const result = await pressTest(page);
    await expect(result).toHaveText(new RegExp(`^Connected to ${served[provider].replace(/\./g, '\\.')} in \\d+\\.\\d s \\(\\$0\\.\\d{4}\\)\\. Tool calling works\\.$`));
    expect(fake.requests().slice(from).filter((r) => dialect(r) && r.kind === 'chat')).toHaveLength(2);
  }

  const sent = fake.requests().slice(from);
  const first = sent.filter((r) => r.dialect === 'anthropic');
  const second = sent.filter((r) => r.dialect === 'openai');
  expect(first.length).toBeGreaterThanOrEqual(3);
  expect(second.length).toBeGreaterThanOrEqual(3);
  expect(sent.map((r) => r.dialect).filter((d) => d !== 'anthropic' && d !== 'openai')).toEqual([]);
  expect(sent.filter((r) => r.refused).map((r) => r.refused)).toEqual([]);
  // The first cloud dialect: exactly x-api-key, never a bearer token.
  for (const r of first) {
    expect(whereInRequest(r, keys.anthropic), `${r.method} ${r.path}`).toEqual(['header:x-api-key']);
    expect(r.headers['x-api-key']).toBe(keys.anthropic);
    expect(r.headers.authorization).toBeUndefined();
    expect(whereInRequest(r, keys.openai)).toEqual([]);
  }
  // The second: exactly Authorization: Bearer.
  for (const r of second) {
    expect(whereInRequest(r, keys.openai), `${r.method} ${r.path}`).toEqual(['header:authorization']);
    expect(r.headers.authorization).toBe(`Bearer ${keys.openai}`);
    expect(r.headers['x-api-key']).toBeUndefined();
    expect(whereInRequest(r, keys.anthropic)).toEqual([]);
  }

  // Nowhere else: not in the page, any answer, this server's log, or its files except sealed in keys.json.
  const html = await page.content();
  const texts = await answers.all();
  expect(texts.length).toBeGreaterThan(5);
  const sealed = JSON.parse(readFileSync(join(host.tmp, 'assistant', 'secrets', 'keys.json'), 'utf8'));
  for (const [provider, key] of Object.entries(keys)) {
    expect(html).not.toContain(key);
    expect(texts.filter((a) => a.t.includes(key)).map((a) => a.url)).toEqual([]);
    expect(host.log()).not.toContain(key);
    expect(filesHolding(host.tmp, key)).toEqual([]);
    expect(filesHolding(host.tmp, Buffer.from(key).toString('base64'))).toEqual([]);
    expect(sealed.keys[provider]).toMatchObject({ ct: expect.any(String), iv: expect.any(String), tag: expect.any(String), last4: key.slice(-4) });
  }
  const status = await assistantStatus(request, host.base);
  expect(status.keys.anthropic).toMatchObject({ set: true, last4: '1111' });
  expect(status.keys.openai).toMatchObject({ set: true, last4: '2222' });
  expect(JSON.stringify(status)).not.toMatch(new RegExp(id));
});

test("a cloud Test: the result line, and today's spend counts it; a refused key gets the refusal text", async ({ page, request }) => {
  test.setTimeout(120_000);
  const from = fake.requests().length;
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  await chooseProvider(page, 'anthropic');
  const spent = pane.locator('[data-assistant-spent]');
  await expect(spent).toHaveText('Spent today (API keys): $0.00 of $15.00');
  await saveKey(page, `sk-ant-e2e${randomBytes(8).toString('hex')}5678`);
  // The model list read with the new key has come back (the refusal below is for the Test).
  await expect.poll(() => fake.requests().slice(from).filter((r) => r.path === '/anthropic/v1/models').length).toBeGreaterThan(0);
  await expect(pane.locator('[data-assistant-models-refresh]')).toHaveText('Refresh list');

  // Two requests of 2000 tokens in and 400 out at $4 / $20 per million: $0.032.
  fake.reply(...callsTheTool({ input: 2000, output: 400 }));
  const result = await pressTest(page);
  await expect(result).toHaveText(/^Connected to claude-opus-5-5 in \d+\.\d s \(\$0\.0320\)\. Tool calling works\.$/);
  await expect(result).toHaveAttribute('data-assistant-test-result', 'ok');
  await expect(spent).toHaveText('Spent today (API keys): $0.03 of $15.00');
  expect((await assistantStatus(request, host.base)).spent_today_usd).toBeCloseTo(0.032, 6);
  // The four limits share one row (three and one left over before).
  const tops = await pane.locator('[data-assistant-limits] .wiz-assistant-cap input').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(tops).toHaveLength(4);
  expect(new Set(tops).size).toBe(1);

  // The provider refuses the key: its words are not shown, the plain refusal is.
  fake.failNext({ status: 401, dialect: 'anthropic', body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-leak' } } });
  const refused = await pressTest(page);
  await expect(refused).toHaveText('Anthropic refused the key. Check it in Settings → Assistant.');
  await expect(refused).toHaveAttribute('data-assistant-test-result', 'failed');
  await expect(spent).toHaveText('Spent today (API keys): $0.03 of $15.00');
  expect(await page.content()).not.toContain('sk-ant-leak');
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
  // Enter answers Cancel here, and focus is back on the address (not on the closed dialog).
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(field).toHaveValue('http://127.0.0.1:1234/v1');
  await expect(field).toBeFocused();
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
  // Said as it is: not on this PC, no price Magnusim could know, no $ limits that would apply.
  const choice = pane.locator('[data-assistant-card-copy="openai_compatible"]');
  await expect(choice).toContainText('Your server at 192.0.2.10:1234, not on this PC. Project data you ask about goes there.');
  await expect(choice).not.toContainText('stays here');
  await expect(pane.locator('[data-assistant-price]')).toHaveText("Magnusim doesn't know what this server charges, and today's spend doesn't count it.");
  await expect(pane.locator('[data-assistant-server-limits]')).toHaveText(
    "Magnusim can't price a server that isn't on this PC, so the $ limits don't apply to it; the step and time limits do.",
  );
  await expect(pane.locator('[data-assistant-local-limits]')).toHaveCount(0);

  // A server on this PC needs no question; Ollama's port gets its context hint.
  await pane.locator('[data-assistant-endpoint-preset="ollama"]').click();
  await expect(field).toHaveValue('http://127.0.0.1:11434/v1');
  await expect(dialog).toBeHidden();
  await expect(pane.locator('[data-assistant-ollama-hint]')).toBeVisible();
  expect((await assistantStatus(request, host.base)).base_url).toBe('http://127.0.0.1:11434/v1');
  await expect(choice).toContainText('LM Studio or Ollama on this PC. Project data stays here.');
  await expect(pane.locator('[data-assistant-price]')).toHaveText('No cost (runs on this PC).');
});

test('privacy and limits save at once and survive reopening and a reload; an invalid limit says why', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(`${host.base}/#/`);
  let pane = await openAssistantStep(page);
  await chooseProvider(page, 'anthropic');
  // The default limits leave room for a watched build: $8.00 a turn, $15.00 a day, 120 steps, 60 minutes.
  await expect(pane.locator('[data-assistant-cap-turn-usd]')).toHaveValue('8.00');
  await expect(pane.locator('[data-assistant-cap-day-usd]')).toHaveValue('15.00');
  await expect(pane.locator('[data-assistant-cap-steps]')).toHaveValue('120');
  await expect(pane.locator('[data-assistant-cap-minutes]')).toHaveValue('60');
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
  await expect(pane.locator('[data-assistant-spent]')).toHaveText('Spent today (API keys): $0.00 of $15.00');
  await expect(pane.locator('[data-assistant-shared-pc]')).toHaveText(
    "Anyone signed in to this PC can use the Assistant through Magnusim (they can't see your key); these limits apply to them too.",
  );

  const expectSaved = async (p) => {
    await expect(p.locator('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'anthropic');
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
  // Pressing Plugins waits for the save on its way: the step stays.
  await page.locator('#wiz-rail li[data-wiz-key="plugins"]').click();
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-assistant-step]')).toHaveCount(1);
  // A link about plugins moves the wizard at once (it waits for nothing), and the Assistant's
  // entry shows the step again: another showing, which the waiting press no longer moves.
  await page.evaluate(() => window.__CFD_OPEN_WIZARD__({ step: 'plugins' }));
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
  await expect(pane).toBeVisible();
});

test('Next saves a key pasted but not saved, and waits for a change on its way: refused, the step stays with its reason', async ({ page, request }) => {
  test.setTimeout(120_000);
  const key = `sk-ant-next${randomBytes(8).toString('hex')}4321`;
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  await chooseProvider(page, 'anthropic');
  const plugins = page.locator('#setup-wizard .wiz-pane[data-wiz-key="plugins"]');

  // Pasted, never saved, and Next pressed: the key is saved, then the wizard goes on.
  await pane.locator('[data-assistant-key-input]').fill(key);
  await page.locator('#wiz-next').click();
  await expect(plugins).toBeVisible();
  expect((await assistantStatus(request, host.base)).keys.anthropic).toMatchObject({ set: true, last4: '4321' });
  await page.locator('#wiz-back').click();
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …4321');
  await expect(pane.locator('[data-assistant-key-input]')).toHaveValue('');

  // A limit typed and Next pressed: the field's save (sent as it lost focus) is held on its way.
  let sent;
  let release;
  const saveSent = new Promise((r) => (sent = r));
  const released = new Promise((r) => (release = r));
  await page.route(
    '**/api/assistant/settings',
    async (route) => {
      sent();
      await released;
      await route.continue();
    },
    { times: 1 },
  );
  const steps = pane.locator('[data-assistant-cap-steps]');
  await steps.fill('500');
  await page.locator('#wiz-next').click();
  await saveSent;
  // The wizard waits for it.
  await expect(pane.locator('[data-assistant-step]')).toHaveCount(1);
  await expect(plugins).toBeHidden();
  release();
  // Refused: the step stays, the reason under the field and what was typed kept.
  await expect(pane.locator('[data-assistant-cap-error="steps"]')).toHaveText('This limit must be a whole number from 1 to 200.');
  await expect(steps).toHaveValue('500');
  await expect(pane).toBeVisible();
  expect((await assistantStatus(request, host.base)).caps.steps).toBe(120);
  // Pressed again with nothing on its way: the wizard goes on.
  await page.locator('#wiz-next').click();
  await expect(plugins).toBeVisible();
  await expect(page.locator('#wiz-assistant [data-assistant-step]')).toHaveCount(0);
  expect((await assistantStatus(request, host.base)).caps.steps).toBe(120);
});

test("Next with a key that isn't the provider's kind: saved, the step stays with the warning, and Next again goes on", async ({ page, request }) => {
  test.setTimeout(120_000);
  // Another provider's kind of key under Anthropic: the server saves it and says so.
  const key = `sk-proj-e2e${randomBytes(8).toString('hex')}9999`;
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  await chooseProvider(page, 'anthropic');
  const plugins = page.locator('#setup-wizard .wiz-pane[data-wiz-key="plugins"]');

  await pane.locator('[data-assistant-key-input]').fill(key);
  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/assistant/key');
  await page.locator('#wiz-next').click();
  expect((await saved).status()).toBe(200);
  // The step stays, the warning under the key field, and the key is saved.
  await expect(pane.locator('[data-assistant-key-warning]')).toHaveText(
    "This doesn't look like an Anthropic key (they start with sk-ant-). It was saved anyway.",
  );
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …9999');
  await expect(pane).toBeVisible();
  await expect(plugins).toBeHidden();
  expect((await assistantStatus(request, host.base)).keys.anthropic).toMatchObject({ set: true, last4: '9999' });
  expect(await page.content()).not.toContain(key);

  // Read, and Next pressed again: the wizard goes on.
  await page.locator('#wiz-next').click();
  await expect(plugins).toBeVisible();
  await expect(page.locator('#wiz-assistant [data-assistant-step]')).toHaveCount(0);
});

test("every provider keeps its key and model across default changes and a reload; a card that isn't the default tests its own provider", async ({ page, request }) => {
  test.setTimeout(120_000);
  const key = `sk-ant-e2e${randomBytes(8).toString('hex')}7777`;
  const from = fake.requests().length;
  await page.goto(`${host.base}/#/`);
  let pane = await openAssistantStep(page);
  // The default's card: its key and its model.
  const anthropic = await chooseProvider(page, 'anthropic');
  await saveKey(page, key);
  await anthropic.locator('select[data-assistant-model]').selectOption('claude-sonnet-5-5');
  await expect(anthropic.locator('select[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'claude-sonnet-5-5');
  // Another card's model is its own: the default's stays.
  const openai = await openCard(page, 'openai');
  await openai.locator('select[data-assistant-model]').selectOption('gpt-6-luna');
  await expect(openai.locator('select[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'gpt-6-luna');
  let status = await assistantStatus(request, host.base);
  expect([status.provider, status.models.anthropic, status.models.openai]).toEqual(['anthropic', 'claude-sonnet-5-5', 'gpt-6-luna']);

  // The default moves on, and is Off at last: nothing of any card is removed.
  await chooseProvider(page, 'openai_compatible');
  await chooseProvider(page, 'off');
  await page.reload();
  pane = await openAssistantStep(page);
  await expect(pane.locator('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'off');
  const card = pane.locator('[data-assistant-card="anthropic"]');
  await expect(card).toHaveAttribute('data-ready', '1');
  await expect(card.locator('[data-assistant-card-state]')).toHaveText(`Key set, ends in …7777 · claude-sonnet-5-5`);
  await expect(pane.locator('[data-assistant-default-option="anthropic"]')).toContainText('Key set, ends in …7777 · claude-sonnet-5-5');
  status = await assistantStatus(request, host.base);
  expect(status.keys.anthropic).toMatchObject({ set: true, last4: '7777' });
  expect(status.models).toMatchObject({ anthropic: 'claude-sonnet-5-5', openai: 'gpt-6-luna' });
  expect([status.providers_ready.anthropic.ready, status.providers_ready.openai.reason]).toEqual([true, 'no_key']);

  // With no default, the card's own Test reaches its own provider, with its own model.
  await openCard(page, 'anthropic');
  await expect(card.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …7777');
  fake.reply(...callsTheTool());
  const result = await pressTest(page, 'anthropic');
  await expect(result).toHaveText(/^Connected to claude-sonnet-5-5 in \d+\.\d s \(\$0\.\d{4}\)\. Tool calling works\.$/);
  const tested = fake.requests().slice(from).filter((r) => r.kind === 'chat');
  expect(tested.map((r) => [r.dialect, r.body.model])).toEqual([
    ['anthropic', 'claude-sonnet-5-5'],
    ['anthropic', 'claude-sonnet-5-5'],
  ]);

  // Chosen again: the card as it was left.
  await chooseProvider(page, 'anthropic');
  await expect(card.locator('[data-assistant-key-status]')).toHaveText('Key set, ends in …7777');
  await expect(card.locator('select[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'claude-sonnet-5-5');
});

test('a Test nobody waits for stops: left during a slow Test, the step can test again at once', async ({ page, request }) => {
  test.setTimeout(120_000);
  const local = await startFakeLlm();
  try {
    local.models(['qwen3.8-27b'], 'compat');
    for (const data of [{ provider: 'openai_compatible' }, { base_url: local.compatBase }, { model: 'qwen3.8-27b' }]) {
      expect((await request.post(`${host.base}/api/assistant/settings`, { data })).status()).toBe(200);
    }
    await page.goto(`${host.base}/#/`);
    const pane = await openAssistantStep(page);
    await expect(pane.locator('select[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'qwen3.8-27b');
    const chats = () => local.requests().filter((r) => r.kind === 'chat').length;

    // A model still loading: its answer stops after the first chunk.
    local.reply({ text: 'Loading', hold: 'slow-test' });
    await pane.locator('[data-assistant-test]').click();
    await expect(pane.locator('[data-assistant-test-result]')).toHaveAttribute('data-assistant-test-result', 'running');
    await expect.poll(chats).toBe(1);

    // Left: nobody waits for that Test, so the server stops it and lets the model's request go.
    await page.locator('#wiz-next').click();
    await expect(page.locator('#wiz-assistant [data-assistant-step]')).toHaveCount(0);
    await expect.poll(() => local.disconnects()).toBe(1);

    // Back on the step, a Test runs at once (not "A test is already running.").
    await page.locator('#wiz-back').click();
    local.reply(...callsTheTool());
    const result = await pressTest(page);
    await expect(result).toHaveText(/^Connected to qwen3\.8-27b in \d+\.\d s\. Tool calling works\.$/);
    expect(chats()).toBe(3);
  } finally {
    local.release('slow-test');
    await local.stop();
  }
});
