// Helpers for the Assistant's browser tests: Settings → Assistant, its status, a test
// home's files, and turns against the scripted model (support/fake-llm.mjs): pointing the
// app at it, starting and following turns, the tab a page links as, what a request offered
// and carried back, and answering the turn's questions; the chat dock (opening it, sending
// from it, its newest request and its question card). The core's specs and the bundled
// plugins' suites share them, so a plugin's spec never names a provider. The specs run
// their own server (startHost) with the Assistant's test switches they choose; nothing here
// touches this PC's real keys.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** The `expect` a bundled plugin's suite handed in (setExpect), or null for the app's. */
let givenExpect = null;
const requireHere = createRequire(import.meta.url);

/**
 * A bundled plugin whose suite runs its own copy of Playwright (CAD's) hands its `expect` here
 * before it uses these helpers: one process loads @playwright/test once (a second copy refuses to
 * load). Unset, the helpers assert with the app's own (the one support/stress.js re-exports).
 */
export function setExpect(e) {
  givenExpect = e;
}

/** @playwright/test's expect, loaded on first use (the app's specs have it loaded already). */
function expect(...args) {
  return (givenExpect ?? requireHere('@playwright/test').expect)(...args);
}

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

// ---------------------------------------------------------------- the scripted model and turns

/** The scripted model's two settings: the first cloud dialect (with a test key) and the local server's. */
const SCRIPTED = {
  cloud: { provider: 'anthropic', model: 'claude-opus-5-5', dialect: 'anthropic', key: 'sk-ant-e2e-scripted-model-0123456789abcdef' },
  local: { provider: 'openai_compatible', model: 'qwen3.8-27b', dialect: 'compat', key: null },
};

async function postOk(request, url, data) {
  const r = await request.post(url, { data });
  const j = await r.json().catch(() => ({}));
  expect(r.status(), `${new URL(url).pathname}: ${JSON.stringify(j)}`).toBe(200);
  return j;
}

/**
 * Sets the Assistant of the server at `base` to the scripted model `fake`
 * (support/fake-llm.mjs), with project data allowed to go to it, so a spec names no provider:
 * - 'cloud': the first cloud dialect, with a test key. The server must run with
 *   MAGNUSIM_TEST_ASSISTANT=1 and MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL=<fake.base> (checked
 *   before any key is saved);
 * - 'local': the local-server dialect at fake.compatBase (no key; nothing asks about privacy).
 * The key is saved only when the status doesn't show it already (a spec may call this before
 * every test). Resolves to {kind, model, dialect} once the Assistant is ready: `dialect` is
 * what the fake's request log calls it (fake.requests()[i].dialect).
 */
export async function useScriptedModel(request, base, fake, kind = 'cloud') {
  const m = SCRIPTED[kind];
  if (!m) throw new Error(`useScriptedModel: 'cloud' or 'local', not ${JSON.stringify(kind)}`);
  let status = await assistantStatus(request, base);
  if (kind === 'cloud') {
    expect(status.test_provider, 'the cloud providers go to the fake: start the server with MAGNUSIM_TEST_ASSISTANT=1 and MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL=<fake.base>').toBe(true);
    status = await postOk(request, `${base}/api/assistant/settings`, { provider: m.provider, model: m.model, privacy: 'allow' });
    const key = status.keys?.[m.provider];
    if (!key?.set || key.last4 !== m.key.slice(-4)) status = await postOk(request, `${base}/api/assistant/key`, { provider: m.provider, key: m.key });
  } else {
    status = await postOk(request, `${base}/api/assistant/settings`, { provider: m.provider, base_url: fake.compatBase, model: m.model, privacy: 'allow' });
  }
  expect(status.ready, `the Assistant is ready for the scripted ${kind} model (${status.ready_reason})`).toBe(true);
  return { kind, model: m.model, dialect: m.dialect };
}

/** The id of `page`'s event stream's tab, from its /api/events?tab= request ('' before one). */
export function trackTab(page) {
  let tab = '';
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/events' && u.searchParams.get('tab')) tab = u.searchParams.get('tab');
  });
  return () => tab;
}

/**
 * Starts a turn on the server at `base` (POST /api/assistant/turns `body`: {text, tab?,
 * conversation?, context?, provider?}; expects 202) and follows it (followTurn, with `opts`), with
 * its `conversation` and the `answerKey` its questions take (the 202 gives it only to whoever
 * started the turn: answerGate sends it).
 */
export async function startTurn(request, base, body, opts = {}) {
  const r = await request.post(`${base}/api/assistant/turns`, { data: body });
  const j = await r.json();
  expect(r.status(), JSON.stringify(j)).toBe(202);
  expect(typeof j.answer_key, `the 202 carries the turn's answer key: ${JSON.stringify(Object.keys(j))}`).toBe('string');
  const t = followTurn(request, base, j.turn, opts);
  t.conversation = j.conversation ?? null;
  t.answerKey = j.answer_key;
  return t;
}

/**
 * The words of the app's note when a cloud provider refused to compile a request's strict
 * tools and the request went again with fewer of them strict, or with the workspace's tools
 * not strict (CAD tools spec H8).
 * Against the fake that means a strict schema broke one of its rules (a limit keyword, the
 * strict budget): the turn still ends well, so ended() fails it unless the test expects it.
 */
const STRICT_FALLBACK = /could not compile (all )?these tools strictly/;

/**
 * Follows turn `id`'s event log through the long-poll (GET /api/assistant/turns/:id).
 * `ended()` throws when the turn got the strict-tools fallback note, unless
 * `opts.strictFallback` is true (a test that makes the provider refuse its schemas).
 */
export function followTurn(request, base, id, { strictFallback = false } = {}) {
  const events = [];
  let next = 0;
  let summary = null;
  let ended = false;
  const pull = async (waitMs) => {
    const r = await request.get(`${base}/api/assistant/turns/${id}?since=${next}&wait_ms=${Math.max(0, Math.floor(waitMs))}`, { timeout: 40_000 });
    expect(r.status()).toBe(200);
    const j = await r.json();
    events.push(...j.events);
    next = j.next;
    summary = j.turn;
    ended = j.ended;
  };
  return {
    id,
    events,
    conversation: null,
    answerKey: null,
    /** The first event `pred` takes, within `ms`. */
    async waitFor(pred, what, ms = 30_000) {
      const until = Date.now() + ms;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (ended) throw new Error(`the turn ended before ${what}: ${JSON.stringify(events.slice(-8))}`);
        if (Date.now() > until) throw new Error(`no ${what} within ${ms} ms: ${JSON.stringify(events.slice(-8))}`);
        await pull(Math.min(5000, until - Date.now()));
      }
    },
    /** The events so far (asked now, without waiting for more). */
    async latest() {
      if (!ended) await pull(0);
      return events;
    },
    /** The turn's summary and events once it ended, within `ms` (see followTurn on the strict-tools note). */
    async ended(ms = 30_000) {
      const until = Date.now() + ms;
      while (!ended) {
        if (Date.now() > until) throw new Error(`the turn did not end within ${ms} ms: ${JSON.stringify(events.slice(-8))}`);
        await pull(Math.min(5000, until - Date.now()));
      }
      const fallback = strictFallback ? null : events.find((e) => e.type === 'note' && STRICT_FALLBACK.test(String(e.text)));
      if (fallback) {
        throw new Error(
          `the provider refused this turn's strict tools and the app sent them again unchecked by it (note: "${fallback.text}"): a strict schema breaks a rule of the provider's, or the strict budget; a test that means it passes {strictFallback: true} to startTurn or followTurn`,
        );
      }
      return { turn: summary, events };
    },
  };
}

/** The questions answerGate answered, per followed turn (a later call never takes one again). */
const answeredGates = new WeakMap();

/**
 * Answers the next question of turn `t` (from startTurn or followTurn) that nobody answered
 * yet, as a click on its Allow (Send) or Don't would, the way the app takes it from whoever may
 * answer:
 * - the program that started the turn: POST /api/assistant/gates/:id {allow, answer_key} with
 *   the turn's answer key (startTurn keeps it from the 202);
 * - the Magnusim window that shows it: `page`'s own dialog, its Allow or Don't clicked (the page
 *   answers on the relay link it was shown on), for a question only the window answers
 *   (`link_only`: a coding agent's own tool, its privacy question) or a turn followed without
 *   its key (followTurn). Without `page` there it throws, and nothing is sent.
 * `kind` ('confirm' | 'privacy') and `tool` (the tool's full name) narrow which question; waits
 * up to `ms` for it. Resolves to the question as the turn's `gate` event shows it ({id, kind,
 * tool?, title, copy, yes, no, link_only?, ...}).
 */
export async function answerGate(request, base, t, allow, { kind, tool, ms = 30_000, page } = {}) {
  let mine = answeredGates.get(t);
  if (!mine) answeredGates.set(t, (mine = new Set()));
  const open = (e) =>
    e.type === 'gate' &&
    !mine.has(e.gate.id) &&
    (!kind || e.gate.kind === kind) &&
    (!tool || e.gate.tool === tool) &&
    !t.events.some((c) => c.type === 'gate_closed' && c.gate === e.gate.id);
  const { gate } = await t.waitFor(open, `a question to answer${kind ? ` (${kind})` : ''}${tool ? ` for ${tool}` : ''}`, ms);
  if (!gate.link_only && t.answerKey) {
    mine.add(gate.id);
    await postOk(request, `${base}/api/assistant/gates/${gate.id}`, { allow, answer_key: t.answerKey });
    return gate;
  }
  // No answer key answers this one: only the window that shows it does.
  const why = gate.link_only ? 'only the Magnusim window answers this question (link_only)' : 'this turn has no answer key (start it with startTurn)';
  if (!page) throw new Error(`answerGate: ${why}: pass {page} to answer it in the dock's card. Question: ${JSON.stringify(gate.title)}`);
  mine.add(gate.id);
  // The one place a window shows the Assistant's questions: the dock's card (never the app's dialog).
  const card = page.locator(`#assistant-dock [data-gate="${gate.id}"]`);
  await expect(card).toBeVisible({ timeout: ms });
  await expect(card.locator('.dock-gate-title')).toHaveText(gate.title, { timeout: ms });
  await expect(page.locator('#modal-confirm'), "an Assistant question never shows as the app's dialog").toBeHidden();
  // Yes takes a click once its guard let it go (it is disabled for its first moment).
  await card.locator(`[data-gate-answer="${allow ? 'yes' : 'no'}"]`).click({ timeout: ms });
  await t.waitFor((e) => e.type === 'gate_closed' && e.gate === gate.id, `question ${gate.id} closed by the window's answer`, ms);
  return gate;
}

// ---------------------------------------------------------------- the chat dock (phase 4)

/** The dock's panel. */
export const dockPanel = (page) => page.locator('#assistant-dock');

/**
 * The dock's open question card: the oldest when several (its parts: '.dock-gate-title',
 * '.dock-gate-copy', '[data-gate-answer="no"]', '[data-gate-answer="yes"]').
 */
export function dockGate(page) {
  return page.locator('#assistant-dock [data-gate]').first();
}

/** The newest request's block in the dock's transcript. */
export function dockTurn(page) {
  return page.locator('#assistant-dock [data-dock-turn]').last();
}

/** Opens the dock with the header button the window shows (Home's, or the workbench's a workspace borrows). */
export async function openDock(page) {
  if (await dockPanel(page).isVisible()) return;
  await appReady(page);
  await page.locator('#wb-assistant:visible, #home-assistant:visible').first().click();
  await expect(dockPanel(page)).toBeVisible();
}

/**
 * Types `text` in the dock's composer (each "\n" as Shift+Enter), attaches `pictures` first
 * ([{name, mimeType, buffer}]) and sends it with Enter; resolves to the started turn's id.
 */
export async function dockSend(page, text, { pictures = [] } = {}) {
  await openDock(page);
  const box = dockPanel(page).getByRole('textbox', { name: 'Message to the Assistant' });
  if (pictures.length) {
    await dockPanel(page).locator('[data-dock-file]').setInputFiles(pictures);
    await expect(dockPanel(page).locator('[data-dock-picture-chip]')).toHaveCount(pictures.length);
  }
  await box.click();
  const lines = text.split('\n');
  for (const [i, l] of lines.entries()) {
    if (i) await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(l);
  }
  const started = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/assistant/turns' && r.request().method() === 'POST');
  await page.keyboard.press('Enter');
  const r = await started;
  const j = await r.json();
  expect(r.status(), JSON.stringify(j)).toBe(202);
  return j.turn;
}

/** A fake.requests() entry's body, or `req` itself when it is a body (what a function step gets). */
const bodyOf = (req) => (req && typeof req === 'object' && 'headers' in req && 'body' in req ? req.body : req);

/**
 * The tools a request to the fake offered, in order: [{name, strict}] (strict: sent as a
 * strict tool). `req` is one of fake.requests() or a request body, in any dialect.
 */
export function offeredTools(req) {
  const body = bodyOf(req);
  return (Array.isArray(body?.tools) ? body.tools : []).map((t) => {
    // The local server's dialect nests each tool in `function`.
    const fn = t.function && typeof t.function === 'object' ? t.function : t;
    return { name: fn.name, strict: fn.strict === true };
  });
}

/**
 * The tool results a request carries for the answer before it, in order: [{tool, ok, data?,
 * text?, error?, images}] (each result's JSON, and the images sent with it). `req` is one of
 * fake.requests() or a request body (what a function step gets), in the first cloud dialect
 * or the local server's; the local dialect sends images apart from their results (one user
 * message after them all), so `images` is [] there.
 */
export function resultsIn(req) {
  const body = bodyOf(req);
  if (!Array.isArray(body?.messages)) throw new Error('resultsIn reads the first cloud dialect and the local server dialect');
  const messages = body.messages;
  const lastAnswer = messages.map((m) => m.role).lastIndexOf('assistant');
  const tools = messages.slice(lastAnswer + 1).filter((m) => m.role === 'tool');
  if (tools.length) {
    return tools.map((m) => ({ ...JSON.parse(typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('')), images: [] }));
  }
  const user = [...messages].reverse().find((m) => m.role === 'user');
  return (Array.isArray(user?.content) ? user.content : [])
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({ ...JSON.parse(b.content[0].text), images: b.content.slice(1) }));
}
