// The project list's question in the dock (core host tools spec C5, 9.3, 14.1): the Assistant's
// `projects` tool sends every project's title, folder and dates, so with a cloud provider and
// "Ask" the person is asked once per destination: "Let the Assistant read your project list?".
// Send is remembered (the next request's list asks nothing); another cloud provider is another
// destination and asks again; Don't send fails only that call: the step says
// privacy_declined, nothing of the list is sent, and the turn goes on to its next call.
// Its own server with the Assistant's test switches (a test home, never this PC's keys) and the
// scripted model (support/fake-llm.mjs), in its two cloud dialects. No WSL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const STEP = { timeout: 30_000 };
const TITLES = ['List Alpha', 'List Beta'];
const LIST_TITLE = 'Let the Assistant read your project list?';
/** The second cloud dialect, with a test key. */
const OPENAI = { provider: 'openai', model: 'gpt-6.1-sol', key: 'sk-e2e-project-list-0123456789abcdef' };

let host;
let fake;

const api = (path) => `${host.base}${path}`;
async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

const projects = { name: 'projects', input: { folder: '', search: '', sort: 'name', limit: 0 } };
const chats = () => fake.requests().filter((r) => r.kind === 'chat');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  host = await startHost({ name: 'assistant-core-projects', env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base } });
  for (const title of TITLES) await postOk(request, '/api/project', { title, folder: 'My Projects', units: 'Metric', category: 'Other' });
  // A fresh test home: no answer about the list is remembered yet.
  await postOk(request, '/api/test/assistant/reset', { files: true });
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(() => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

async function openHome(page) {
  await page.goto(api('/#/'));
  await openDock(page);
}

/** A new conversation in the dock: it takes the provider Settings has now. */
async function newConversation(page) {
  const neu = page.locator('#assistant-dock [data-dock-new]').first();
  if (await neu.isVisible()) await neu.click();
}

test('Send is remembered: the first list asks, the next request lists them with no question', async ({ page, request }) => {
  test.setTimeout(180_000);
  await useScriptedModel(request, host.base, fake, 'cloud');
  await postOk(request, '/api/assistant/settings', { privacy: 'ask' });
  await openHome(page);

  fake.reply({ tools: [projects] }, { text: 'You have two projects.' });
  await dockSend(page, 'Which projects do I have?');
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText(LIST_TITLE, STEP);
  await expect(card.locator('.dock-gate-copy')).toContainText('The Assistant is about to send the names, folders and dates of all your projects to ');
  await expect(card.locator('.dock-gate-copy')).toContainText(', a cloud provider. A local server keeps them on this PC. Settings → Assistant can change this.');
  await expect(card.locator('[data-gate-answer="yes"]')).toHaveText('Send');
  await expect(card.locator('[data-gate-answer="no"]')).toHaveText("Don't send");
  // Nothing of the list went before the answer.
  expect(JSON.stringify(chats())).not.toContain(TITLES[0]);
  await card.locator('[data-gate-answer="yes"]').click(STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(dockTurn(page)).toContainText('You have two projects.');
  const listed = resultsIn(chats().at(-1))[0];
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  expect(listed.data.projects.map((p) => p.title)).toEqual(expect.arrayContaining(TITLES));

  // A second request: the answer is remembered for this provider, so no question.
  fake.reply({ tools: [projects] }, { text: 'Still two.' });
  await dockSend(page, 'And now?');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(dockTurn(page)).toContainText('Still two.');
  await expect(dockTurn(page).locator('[data-dock-line="gate"]')).toHaveCount(0);
  await expect(page.locator('#assistant-dock [data-gate]')).toHaveCount(0);
  expect(resultsIn(chats().at(-1))[0].ok).toBe(true);
});

test("another cloud provider asks again; Don't send fails only that call, and the turn goes on", async ({ page, request }) => {
  test.setTimeout(180_000);
  // The second cloud dialect: another destination.
  await postOk(request, '/api/assistant/settings', { provider: OPENAI.provider, model: OPENAI.model, privacy: 'ask' });
  await postOk(request, '/api/assistant/key', { provider: OPENAI.provider, key: OPENAI.key });
  await openHome(page);
  await newConversation(page);
  const before = chats().length;

  fake.reply({ tools: [projects] }, { tools: [{ name: 'app_status', input: {} }] }, { text: 'I may not read the list; Magnusim is fine.' });
  await dockSend(page, 'Which projects do I have, and is the app fine?');
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText(LIST_TITLE, STEP);
  await card.locator('[data-gate-answer="no"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  // Only the list's call failed, saying why; the next call ran and the answer came.
  const steps = dockTurn(page).locator('[data-dock-step]');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toHaveAttribute('data-dock-step-state', 'failed');
  await expect(steps.nth(0).locator('.dock-step-code')).toHaveText('privacy_declined');
  await expect(steps.nth(1)).not.toHaveAttribute('data-dock-step-state', 'failed');
  await expect(dockTurn(page)).toContainText('I may not read the list; Magnusim is fine.');
  // None of the titles went to this provider.
  const sent = chats().slice(before);
  expect(sent.every((r) => r.dialect === 'openai'), JSON.stringify(sent.map((r) => r.dialect))).toBe(true);
  for (const title of TITLES) expect(JSON.stringify(sent)).not.toContain(title);
});
