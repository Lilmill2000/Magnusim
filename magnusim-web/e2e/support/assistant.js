// Helpers for the Assistant's browser tests: Settings → Assistant, its status, and a test
// home's files. The specs run their own server (startHost) with the Assistant's test
// switches they choose; nothing here touches this PC's real keys.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from './stress.js';

/** The Assistant's pane in Settings. */
export function assistantPane(page) {
  return page.locator('#setup-wizard .wiz-pane[data-wiz-key="assistant"]');
}

/** The app is up: the wizard is wired and the panel islands are registered. */
export async function appReady(page) {
  await page.waitForFunction(() => typeof window.__CFD_OPEN_WIZARD__ === 'function' && window.__CFD_PLUGINS_READY__ === true, null, {
    timeout: 60_000,
  });
}

/**
 * Opens Settings with `button` (Home's by default) and goes to the Assistant step by its
 * rail entry; resolves once the step has read the status (or shows why it can't).
 */
export async function openAssistantStep(page, button = '#home-prefs') {
  await appReady(page);
  const wizard = page.locator('#setup-wizard');
  await page.locator(button).click();
  await expect(wizard).toBeVisible();
  await wizard.locator('#wiz-rail li[data-wiz-key="assistant"]').click();
  const pane = assistantPane(page);
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-assistant-step], [data-assistant-local-only], [data-assistant-error]')).toHaveCount(1, { timeout: 30_000 });
  return pane;
}

/** Closes Settings (the Close button of a returning user's Settings). */
export async function closeSettings(page) {
  await page.locator('#wiz-skip').click();
  await expect(page.locator('#setup-wizard')).toBeHidden();
}

/** A provider's card in the step: every provider's is listed, whatever the default. */
export function providerCard(page, id) {
  return assistantPane(page).locator(`[data-assistant-card="${id}"]`);
}

/** The card of `provider`, or of the default the step shows now. */
async function cardOf(page, provider) {
  const id = provider ?? (await assistantPane(page).locator('[data-assistant-default]').getAttribute('data-assistant-default'));
  return providerCard(page, id);
}

/** Picks the default provider in the step and waits until it is saved; its card opens. Returns the card (null for Off). */
export async function chooseProvider(page, id) {
  const pane = assistantPane(page);
  await pane.locator(`[data-assistant-default-option="${id}"] input`).check();
  await expect(pane.locator('[data-assistant-default]')).toHaveAttribute('data-assistant-default', id);
  if (id === 'off') return null;
  const card = providerCard(page, id);
  await expect(card).toHaveAttribute('data-open', '1');
  return card;
}

/** Opens a provider's card (Set up) without changing the default; returns the card. */
export async function openCard(page, id) {
  const card = providerCard(page, id);
  if ((await card.getAttribute('data-open')) !== '1') await card.locator(`[data-assistant-card-toggle="${id}"]`).click();
  await expect(card).toHaveAttribute('data-open', '1');
  return card;
}

/** Saves `key` in a provider's key field (the default's card without `provider`) and waits until the card shows it by its last 4. */
export async function saveKey(page, key, provider) {
  const card = await cardOf(page, provider);
  await card.locator('[data-assistant-key-input]').fill(key);
  await card.locator('[data-assistant-key-save]').click();
  await expect(card.locator('[data-assistant-key-status]')).toHaveText(`Key set, ends in …${key.slice(-4)}`);
  await expect(card.locator('[data-assistant-key-input]')).toHaveValue('');
}

/**
 * Presses a provider card's Test (the default's without `provider`), waits for the server's
 * answer and returns the result line (`[data-assistant-test-result]`).
 */
export async function pressTest(page, provider) {
  const card = await cardOf(page, provider);
  const result = card.locator('[data-assistant-test-result]');
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/assistant/test' && r.request().method() === 'POST', {
    timeout: 60_000,
  });
  await card.locator('[data-assistant-test]').click();
  await answered;
  await expect(result).toHaveAttribute('data-assistant-test-result', /^(ok|failed)$/);
  return result;
}

/**
 * Collects the text of every API answer the page reads in full from now on (a stream never
 * finishes, and is left out). `all()` resolves to [{url, t}].
 */
export function collectAnswers(page) {
  const answers = [];
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
  return { all: () => Promise.all(answers) };
}

/**
 * Where `secret` appears in one request the fake provider got (fake.requests()):
 * 'header:<name>', 'path', 'query' or 'body', in that order; [] when nowhere.
 */
export function whereInRequest(req, secret) {
  const out = [];
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (String(value).includes(secret)) out.push(`header:${name.toLowerCase()}`);
  }
  if (String(req.path || '').includes(secret)) out.push('path');
  if (String(req.query || '').includes(secret)) out.push('query');
  if (req.body != null && JSON.stringify(req.body).includes(secret)) out.push('body');
  return out;
}

/** GET /api/assistant/status from this PC (the test process). */
export async function assistantStatus(request, base) {
  const r = await request.get(`${base}/api/assistant/status`);
  expect(r.status()).toBe(200);
  return r.json();
}

/**
 * Agent discovery's test switches (with MAGNUSIM_TEST_ASSISTANT=1) pointed at folders in a
 * host's own temp folder `tmp` that hold no agent: Settings → Assistant looks for coding agents
 * there only, never in this PC's PATH, npm folders or home, so no real agent is ever asked its
 * version. For a spec that shows the Assistant step: startHost({tmp, env: {...noAgentsHere(tmp)}}).
 */
export function noAgentsHere(tmp) {
  return {
    MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS: join(tmp, 'no-agents'),
    MAGNUSIM_TEST_ASSISTANT_AGENT_HOME: join(tmp, 'no-agents-home'),
  };
}

/** Forgets the Assistant's state and the test home's files (needs MAGNUSIM_TEST_ASSISTANT=1). */
export async function resetAssistant(request, base) {
  const r = await request.post(`${base}/api/test/assistant/reset`, { data: { files: true } });
  expect(r.status()).toBe(200);
}

/**
 * Files under `dir` whose bytes hold `needle` (as UTF-8, or as UTF-16LE: some Windows
 * writers use it). `skip` names folders left out.
 */
export function filesHolding(dir, needle, { skip = [] } = {}) {
  const hits = [];
  const forms = [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le')];
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!skip.includes(name)) walk(p);
        continue;
      }
      let buf;
      try {
        buf = readFileSync(p);
      } catch {
        continue;
      }
      if (forms.some((f) => buf.includes(f))) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}
