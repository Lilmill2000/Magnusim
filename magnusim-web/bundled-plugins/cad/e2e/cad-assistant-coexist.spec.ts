// The Assistant and the person in one Part (CAD tools spec §12.3 coexist 1, T2): while the person
// types a value in the Parameters panel, the Assistant's edit holds: the dock's chip reads
// "Assistant waits for you: finish the value you are typing in Parameters" and nothing changes;
// the person's Done lets the edit finish, after the person's own value. Left open longer than
// the hold (setHoldS shortens the 10 minutes to 1.5 s here), the call answers busy
// person_editing to the model, and the person's panel is still open with their typed text, with
// nothing committed.
// Watch mode (coexist 2-8, T12), each race forced at a hold point or a held answer of the model:
// a person's edit between two calls makes two undo groups and the next result says what changed;
// Stop at before-commit from the chip and through the route ends the turn stopped, that call not
// kept and the earlier one kept, no further request; Back or a reload half way through a watched
// sketch leaves nothing of it (the save hold), the model hearing "its page is closing" or
// tab_disconnected; a hidden window with no animation frames runs a watched build with no waits
// and says so, and view still draws; the chip's Pause holds an edit and Resume lets it go; a
// second turn on the tab is refused 409 tab_busy.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { openPart, partOpened, runCommand } from './helpers';
import {
  cadFrame,
  chats,
  chipButton,
  chipWords,
  forcePace,
  holdAt,
  newProject,
  openNewPart,
  reachedHold,
  releaseHold,
  resetAssistant,
  resultsIn,
  startAssistantHost,
  startTurn,
  STEP,
  STEP_MS,
  storedModel,
  studyOf,
  useScriptedModel,
  type AssistantHost,
} from './assistant-helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-coexist', 80);
  await useScriptedModel(request, host, 'cloud');
});

test.afterAll(async () => {
  if (host) await host.stop();
});

test.beforeEach(async ({ request }) => {
  await resetAssistant(request, host);
  await useScriptedModel(request, host, 'cloud');
});

test.afterEach(() => {
  expect(host.fake.pending(), 'scripted answers left unused').toBe(0);
});

type W = {
  __CAD__: {
    services: { doc: { addParam(p: { name: string; expr: string; quantity: string }): unknown; state: { get(): { doc: { params: { name: string; expr: string }[] } } } } };
    assistant: { setPace(p: string | null, scale?: number | null): void; setHoldS(s: number | null): void; calls: { tool: string; ok: boolean; reason?: string }[] };
  };
};

const row = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });

test('cad:assistant-coexist-busy an edit waits while the person types in Parameters, and answers busy once it waited as long as it may', { tag: '@serial' }, async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant waits for the person');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const params = () => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.params.map((p) => `${p.name}=${p.expr}`));
  await cadFrame(page).evaluate(() => {
    const w = window as unknown as W;
    w.__CAD__.assistant.setPace('fast', 0);
    w.__CAD__.services.doc.addParam({ name: 'w', expr: '20 mm', quantity: 'length' });
  });
  await runCommand(frame, 'modify.parameters');
  const panel = frame.locator('[data-cad-panel="params"]');
  const field = panel.locator('[data-param-row="w"] .nui[data-field="expr"] input');
  // The person types a new value and has not applied it yet.
  await field.fill('35 mm');
  const chip = frame.locator('[data-chip="assistant"]');

  const before = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__set_params', input: { set: [row('h', '5 mm')], remove: [] } }] }, { text: 'h is set.' });
  const t = await startTurn(request, host, { text: 'Add h.', tab });
  // The edit holds: the chip says what it waits for, and nothing changed.
  await expect(chip).toHaveAttribute('data-assistant-state', 'waiting', STEP);
  await expect(chipWords(frame)).toHaveText('Assistant waits for you: finish the value you are typing in Parameters');
  expect(await params()).toEqual(['w=20 mm']);
  await expect(field).toHaveValue('35 mm');
  // The person's Done (their value first): the edit goes on.
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  expect(await params()).toEqual(['w=35 mm', 'h=5 mm']);
  const [done] = resultsIn(chats(host).slice(before)[1]);
  expect(done).toMatchObject({ tool: 'cad__set_params', ok: true, data: { params: [{ name: 'h', value: 5 }] } });

  // Again, with the hold shortened to 1.5 s and the panel left open: busy, and nothing committed.
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setHoldS(1.5));
  await runCommand(frame, 'modify.parameters');
  await field.fill('40 mm');
  const before2 = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__set_params', input: { set: [row('h2', '6 mm')], remove: [] } }] }, { text: 'The person is busy: tell them what I need.' });
  const t2 = await startTurn(request, host, { text: 'Add h2.', tab });
  expect((await t2.ended(STEP_MS * 2)).turn.state).toBe('done');
  const [busy] = resultsIn(chats(host).slice(before2)[1]);
  expect(busy).toMatchObject({
    tool: 'cad__set_params',
    ok: false,
    error: {
      code: 'busy',
      message: expect.stringMatching(/^person_editing: The call waited \d+(\.\d)? s for the person: typing a value in Parameters\.$/),
      hint: 'The call already waited 10 minutes for the person: say what you need and end your turn.',
      detail: { reason: 'person_editing', person: 'typing a value in Parameters' },
    },
  });
  // The person's panel is still open with their text, and nothing was committed.
  await expect(panel).toBeVisible();
  await expect(field).toHaveValue('40 mm');
  expect(await params()).toEqual(['w=35 mm', 'h=5 mm']);
  await expect(chip).not.toHaveAttribute('data-assistant-state', 'waiting', STEP);
  expect(await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.calls.map((c) => `${c.tool}:${c.ok ? 'ok' : c.reason}`))).toEqual(['set_params:ok', 'set_params:person_editing']);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setHoldS(null));
});

// ---- Watch mode (T12): each race forced at a hold point in the frame or a held answer of the model.

const E = (id: string, kind: string, at: number[]) => ({ id, kind, at, construction: false });
const C = (id: string, kind: string, refs: string[], value = '') => ({ id, kind, refs, value });
/** A plate with a hole: two entities, so sketch-step:2 is a sketch half drawn at the watch pace. */
const PLATE = {
  name: 'cad__sketch',
  input: {
    edit: '',
    name: 'Plate sketch',
    on: 'Top',
    entities: [E('r', 'center_rect', [0, 0, 60, 40]), E('h', 'circle', [10, 0, 3])],
    constraints: [C('c0', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], '60 mm'), C('dh', 'distance', ['r.left'], '40 mm')],
    infer: false,
  },
};
const SET = (name: string, expr: string) => ({ name: 'cad__set_params', input: { set: [row(name, expr)], remove: [] } });
type W2 = {
  __CAD__: {
    services: { doc: { addParam(p: { name: string; expr: string; quantity: string }): unknown; undo(): void; state: { get(): { doc: { features: { name: string }[]; params: { name: string }[] }; history: { undoLabel: string | null } } } } };
    assistant: { calls: { tool: string; ok: boolean; reason?: string; paced?: number }[]; state(): { call: unknown } };
  };
};
const names = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as W2).__CAD__.services.doc.state.get().doc.features.map((f) => f.name));
const paramNames = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as W2).__CAD__.services.doc.state.get().doc.params.map((p) => p.name));
const undoLabel = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as W2).__CAD__.services.doc.state.get().history.undoLabel);
/** The model's n-th request from `before` has come (a held answer counts once its request is in). */
async function nthRequest(n: number, before: number) {
  await expect.poll(() => chats(host).length, { message: `the model's request ${n}`, timeout: STEP_MS * 2 }).toBeGreaterThanOrEqual(before + n);
  return chats(host)[before + n - 1];
}

test("cad:assistant-coexist-between a person's edit between two calls of a turn: two undo groups, and the next result says what the person changed", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant person between calls');
  const { tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  const before = chats(host).length;
  host.fake.reply({ tools: [SET('a', '3 mm')] }, { hold: 'between', tools: [SET('b', '4 mm')] }, { text: 'a and b are set.' });
  const t = await startTurn(request, host, { text: 'Add a and b.', tab });
  await nthRequest(2, before);
  expect(await paramNames(page)).toEqual(['a']);
  // The person adds a parameter of their own while the model thinks.
  await cadFrame(page).evaluate(() => (window as unknown as W2).__CAD__.services.doc.addParam({ name: 'mine', expr: '1 mm', quantity: 'length' }));
  host.fake.release('between');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  const [b] = resultsIn(chats(host)[before + 2]);
  expect(b).toMatchObject({ tool: 'cad__set_params', ok: true, data: { user_changes: ['added parameter mine = 1 mm'] } });
  // Two groups with the request's name, the person's step between them, never absorbed.
  expect(await undoLabel(page)).toBe('Assistant: Add a and b.');
  const undo = () => cadFrame(page).evaluate(() => (window as unknown as W2).__CAD__.services.doc.undo());
  await undo();
  expect(await paramNames(page)).toEqual(['a', 'mine']);
  await undo();
  expect(await paramNames(page)).toEqual(['a']);
  expect(await undoLabel(page)).toBe('Assistant: Add a and b.');
  await undo();
  expect(await paramNames(page)).toEqual([]);
});

test('cad:assistant-coexist-stop Stop at before-commit, from the pill and through the route: the turn ends stopped, that call is not kept, the earlier one is', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant stop');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  for (const how of ['pill', 'route'] as const) {
    const before = chats(host).length;
    // (A hold's name stays released in the scripted model: one name per turn.)
    host.fake.reply({ tools: [SET(`${how}1`, '3 mm')] }, { hold: `second-${how}`, tools: [SET(`${how}2`, '4 mm')] });
    const t = await startTurn(request, host, { text: `Stop me (${how}).`, tab });
    await nthRequest(2, before);
    const label = await undoLabel(page);
    await holdAt(page, 'before-commit');
    host.fake.release(`second-${how}`);
    await reachedHold(page, 'before-commit');
    expect(await paramNames(page)).toContain(`${how}2`);
    if (how === 'pill') {
      // The app's dock has Stop (the chip leaves it there); closed, its pill offers it.
      await expect(chipButton(frame, 'stop')).toHaveCount(0);
      await page.locator('[data-assistant-pill]').getByRole('button', { name: 'Stop the Assistant' }).click();
    } else {
      const r = await request.post(`${host.base}/api/assistant/turns/${t.id}/stop`, { data: {} });
      expect(r.ok(), await r.text()).toBe(true);
    }
    expect((await t.ended(STEP_MS * 2)).turn.state).toBe('stopped');
    await releaseHold(page, 'before-commit');
    // The stopped call is not kept; the earlier one stays, with its undo step.
    await expect.poll(() => paramNames(page), STEP).not.toContain(`${how}2`);
    expect(await paramNames(page)).toContain(`${how}1`);
    expect(await undoLabel(page)).toBe(label);
    // No further request went to the model.
    expect(chats(host).length).toBe(before + 2);
    await expect(frame.locator('[data-chip="assistant"]')).toHaveAttribute('data-assistant-state', 'ended', STEP);
    await expect(chipWords(frame)).toHaveText(`Assistant: Stop me (${how}). · stopped`);
  }
});

for (const how of ['back', 'reload'] as const) {
  test(`cad:assistant-coexist-${how} ${how === 'back' ? 'Back' : 'a reload'} at sketch-step:2: the model hears ${how === 'back' ? 'its page is closing' : 'tab_disconnected'}, and the reopened Part has no half sketch`, async ({ page, request }) => {
    test.setTimeout(240_000);
    const pid = await newProject(request, host, `Assistant ${how} mid-call`);
    const { frame, tab } = await openNewPart(page, request, host, pid);
    const sid = studyOf(page);
    await forcePace(page, 'watch', 0);
    await holdAt(page, 'sketch-step:2');
    const before = chats(host).length;
    host.fake.reply({ tools: [PLATE] }, { text: 'The page went away.' });
    const t = await startTurn(request, host, { text: 'Sketch a plate.', tab });
    await reachedHold(page, 'sketch-step:2');
    await expect(frame.locator('[data-cad-panel="sketch"]')).toHaveAttribute('data-panel-owner', 'assistant', STEP);
    let again;
    if (how === 'back') {
      await page.locator('#workspace-overlay [data-ws-back]').click();
      await expect(page.locator('#workspace-overlay')).toBeHidden(STEP);
      expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
      const [r] = resultsIn(chats(host)[before + 1]);
      expect(r).toMatchObject({ tool: 'cad__sketch', ok: false, error: { message: expect.stringContaining('its page is closing') } });
      again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').first());
    } else {
      await page.reload();
      expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
      const [r] = resultsIn(chats(host)[before + 1]);
      expect(r).toMatchObject({ tool: 'cad__sketch', ok: false, error: { code: 'tab_disconnected' } });
      again = await partOpened(page);
    }
    await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
    // The save hold kept the step out of the stored model: nothing of the half sketch, reopened or stored.
    expect(await names(page)).toEqual([]);
    expect((await storedModel(request, host, pid, sid))?.features ?? []).toEqual([]);
  });
}

test('cad:assistant-coexist-hidden a hidden window with no animation frames: a watched build runs with no waits and says so; view still answers with a picture', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant hidden window');
  const { tab } = await openNewPart(page, request, host, pid);
  // The window is hidden (or covered): document.hidden, and requestAnimationFrame never fires.
  await cadFrame(page).evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.requestAnimationFrame = () => 0;
  });
  // The person chose watch, with every delay as it is.
  await forcePace(page, 'watch', 1);
  const before = chats(host).length;
  host.fake.reply({ tools: [PLATE] }, { tools: [SET('t', '8 mm')] }, { tools: [{ name: 'cad__view', input: { views: ['iso'], hide: [], section: '', labels: 'none', size: 'small', display: 'shaded_edges', projection: 'orthographic' } }] }, { text: 'Built.' });
  const t = await startTurn(request, host, { text: 'Build it while I look away.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [sketched] = resultsIn(chats(host)[before + 1]);
  const [set] = resultsIn(chats(host)[before + 2]);
  const [viewed] = resultsIn(chats(host)[before + 3]);
  expect(sketched).toMatchObject({ tool: 'cad__sketch', ok: true, data: { note: 'ran without animation: the window was hidden or covered' } });
  expect(set).toMatchObject({ tool: 'cad__set_params', ok: true, data: { note: 'ran without animation: the window was hidden or covered' } });
  expect(viewed).toMatchObject({ tool: 'cad__view', ok: true, data: { note: expect.stringContaining('hidden') } });
  expect(viewed.images).toHaveLength(1);
  // No pace point waited.
  const calls = await cadFrame(page).evaluate(() => (window as unknown as W2).__CAD__.assistant.calls.map((c) => ({ tool: c.tool, paced: c.paced ?? null })));
  expect(calls.filter((c) => c.tool === 'sketch' || c.tool === 'set_params')).toEqual([
    { tool: 'sketch', paced: 0 },
    { tool: 'set_params', paced: 0 },
  ]);
});

test("cad:assistant-coexist-pause the chip's Pause makes the Assistant's edit wait, Resume lets it run", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant pause');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  const chip = frame.locator('[data-chip="assistant"]');
  const before = chats(host).length;
  host.fake.reply({ hold: 'think', tools: [SET('a', '3 mm')] }, { text: 'a is set.' });
  const t = await startTurn(request, host, { text: 'Add a.', tab });
  await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
  await chipButton(frame, 'pause').click();
  await expect(chip).toHaveAttribute('data-assistant-state', 'paused', STEP);
  await expect(chipWords(frame)).toHaveText('Assistant paused');
  host.fake.release('think');
  await nthRequest(1, before);
  // The edit has come and waits: nothing changes while paused.
  await expect.poll(() => cadFrame(page).evaluate(() => (window as unknown as W2).__CAD__.assistant.state().call !== null), STEP).toBe(true);
  await expect(chip).toHaveAttribute('data-assistant-state', 'paused');
  expect(await paramNames(page)).toEqual([]);
  await chipButton(frame, 'resume').click();
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  expect(await paramNames(page)).toEqual(['a']);
  expect(resultsIn(chats(host)[before + 1])[0]).toMatchObject({ tool: 'cad__set_params', ok: true });
});

test('cad:assistant-coexist-two-turns a second turn on the tab while one works is refused 409 tab_busy', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant two turns');
  const { tab } = await openNewPart(page, request, host, pid);
  host.fake.reply({ hold: 'one', text: 'The first.' });
  const t = await startTurn(request, host, { text: 'The first.', tab });
  const r = await request.post(`${host.base}/api/assistant/turns`, { data: { text: 'The second.', tab } });
  expect(r.status()).toBe(409);
  expect(await r.json()).toEqual({ ok: false, code: 'tab_busy', error: 'A turn is already working in that tab: wait for it or stop it.' });
  host.fake.release('one');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
});
