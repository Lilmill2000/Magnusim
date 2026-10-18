// The Part's tools for the app's Assistant, as the person and the model meet them (CAD tools spec
// §12.3 watch 1, T1): a Part open in its workspace offers its 18 tools on its tab; a turn there
// offers 21 (the app's 3 first, then the Part's by name), the first 20 strict and cad__view not;
// the system text holds the CAD notes; the tools go out byte for byte the same in the next turn.
// get_model answers the model with the Part in data; a tool not in this build answers not_ready
// "not in this build yet" with its hint. The dock's chip and the frame's data-assistant say what
// the Assistant does: thinking while the model answers, working while a call runs ("Read the
// Part"), then "Assistant: <request> · done".
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { GUIDE } from '../src/assistant/guide';
import {
  cadFrame,
  chats,
  newProject,
  offeredTools,
  openNewPart,
  readRecord,
  recordShown,
  resetAssistant,
  resultsIn,
  startAssistantHost,
  startTurn,
  STEP,
  STEP_MS,
  tabRow,
  useScriptedModel,
  type AssistantHost,
} from './assistant-helpers';
import { addSolid } from './helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-watch', 60);
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
  // A scripted answer left: the turns did not go as the test wrote them.
  expect(host.fake.pending(), 'scripted answers left unused').toBe(0);
});

/** The Part's 18 tools by name, as the app names them (src/assistant/schemas.ts). */
const CAD = ['body', 'combine', 'delete', 'edit_feature', 'extrude', 'find', 'get_model', 'help', 'hole', 'measure', 'modify', 'pattern', 'revolve', 'set_params', 'sketch', 'sweep_loft', 'undo', 'view'].map((n) => `cad__${n}`);
const HOST_TOOLS = ['app_status', 'explain_ready', 'project_summary'];

test('cad:assistant-watch-registration the Part offers its 18 tools; a turn offers 21, the first 20 strict, with the CAD notes, the same bytes every turn', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant registration');
  const { tab } = await openNewPart(page, request, host, pid);
  const row = await tabRow(request, host, tab);
  expect(row).toMatchObject({ connected: true, refused: [] });
  expect(row!.tools).toEqual(CAD);

  const before = chats(host).length;
  host.fake.reply({ text: 'Hello.' }, { text: 'Hello again.' });
  const t1 = await startTurn(request, host, { text: 'Say hello.', tab });
  expect((await t1.ended(STEP_MS)).turn.state).toBe('done');
  const t2 = await startTurn(request, host, { text: 'Say hello again.', tab });
  expect((await t2.ended(STEP_MS)).turn.state).toBe('done');
  const [first, second] = chats(host).slice(before);
  // The app's own tools first (by name), then the Part's by name: 21, the first 20 strict.
  expect(offeredTools(first)).toEqual([...HOST_TOOLS, ...CAD].map((name) => ({ name, strict: name !== 'cad__view' })));
  // The CAD notes are the second system block, line breaks kept.
  const system = (first.body.system as { text: string }[]).map((s) => s.text).join('\n');
  expect(system).toContain(GUIDE);
  // The same tools, byte for byte, in the next turn (one registration for the page's life).
  expect(JSON.stringify(second.body.tools)).toBe(JSON.stringify(first.body.tools));
});

test("cad:assistant-watch-get-model get_model reads the Part to the model; a tool not in this build says so; the chip and data-assistant follow the turn", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant get_model');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const app = frame.locator('[data-cad-app]');
  const chip = frame.locator('[data-chip="assistant"]');
  await expect(app).toHaveAttribute('data-assistant', 'idle', STEP);
  await expect(chip).toHaveCount(0);
  await recordShown(page, 'phase', '[data-cad-app]', 'data-assistant');

  const before = chats(host).length;
  host.fake.reply(
    // The model is still answering: the chip says the Assistant thinks.
    { hold: 'think', tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '' } }] },
    { tools: [{ name: 'cad__extrude', input: { edit: '', name: '', sketch: 'Sketch 1', regions: ['all'], extent: 'blind', distance: '5 mm', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '' } }] },
    { text: 'The Part is empty, and I cannot extrude yet.' },
  );
  // The read stops where the Part has settled, so the chip is seen working.
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { hold(p: string): void } } }).__CAD__.assistant.hold('after-settled'));
  const t = await startTurn(request, host, { text: 'Read the Part, then extrude Sketch 1.', tab });
  await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
  await expect(chip).toHaveText(/^Assistant · thinking · \d+ of 120 steps$/, STEP);
  await expect(app).toHaveAttribute('data-assistant', 'thinking');
  host.fake.release('think');
  await expect(chip).toHaveAttribute('data-assistant-state', 'working', STEP);
  await expect(chip).toHaveText(/^Assistant · Read the Part · \d+ of 120 steps$/);
  await expect(app).toHaveAttribute('data-assistant', 'working');
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { release(p: string): void } } }).__CAD__.assistant.release('after-settled'));
  const { turn } = await t.ended(STEP_MS * 2);
  expect(turn.state).toBe('done');
  await expect(chip).toHaveAttribute('data-assistant-state', 'ended', STEP);
  await expect(chip).toHaveText('Assistant: Read the Part, then extrude Sketch 1. · done');
  await expect(app).toHaveAttribute('data-assistant', 'ended');
  // Every phase the frame showed, in order (the second call answers at once: its working may not be drawn).
  const shown = await readRecord(page, 'phase');
  expect(shown.slice(0, 4)).toEqual(['idle', 'thinking', 'working', 'thinking']);
  expect(shown[shown.length - 1]).toBe('ended');
  expect(shown.every((p) => ['idle', 'thinking', 'working', 'ended'].includes(p)), shown.join(' ')).toBe(true);

  // What the model got back.
  const [, afterRead, afterExtrude] = chats(host).slice(before);
  const [read] = resultsIn(afterRead);
  expect(read).toMatchObject({
    tool: 'cad__get_model',
    ok: true,
    data: { part: 'Part 1', units: { length: 'mm', angle: 'deg' }, editable: true, rolled_back: null, person: null, features: [], bodies: [], params: [], notes: 'If you have no notes from the CAD workspace, read help guide' },
  });
  expect(typeof read.data!.rev).toBe('number');
  const [extrude] = resultsIn(afterExtrude);
  expect(extrude).toMatchObject({
    tool: 'cad__extrude',
    ok: false,
    error: { code: 'not_ready', message: 'not_built: extrude is not in this build yet.', hint: 'This tool is not in this build yet: use the tools that answer, and tell the person what is missing.', detail: { reason: 'not_built', tool: 'extrude' } },
  });
  // The page's ledger: what the eval counts.
  const calls = await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { calls: { tool: string; ok: boolean; reason?: string; key: string }[] } } }).__CAD__.assistant.calls.map((c) => ({ tool: c.tool, ok: c.ok, reason: c.reason ?? null, key: c.key })));
  expect(calls).toEqual([
    { tool: 'get_model', ok: true, reason: null, key: `turn:${t.id}` },
    { tool: 'extrude', ok: false, reason: 'not_built', key: `turn:${t.id}` },
  ]);
});

// ---- T3: find (CAD tools spec §3.2.2, §5; §12.3 honest 6, kept here beside the other read tools)

/** The view's flash calls, recorded in the frame (the viewport lights what it is handed). */
async function recordFlashes(page: Page): Promise<void> {
  await cadFrame(page).evaluate(() => {
    const w = window as unknown as { __flashes: unknown[][]; __CAD__: { services: { viewport: { get(): { handle: { flash(items: unknown[]): void } } } } } };
    const handle = w.__CAD__.services.viewport.get().handle;
    const flash = handle.flash.bind(handle);
    w.__flashes = [];
    handle.flash = (items) => {
      w.__flashes.push(items);
      flash(items);
    };
  });
}
const flashes = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as { __flashes: unknown[][] }).__flashes);

test("cad:assistant-watch-find find lists the matches with handles and lights them in the person's view; a miss names the nearest face; a handle of a face the person undid is stale", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant find');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const made = await addSolid(page, { size: [40, 30, 10] });
  const top = await cadFrame(page).evaluate((id) => {
    const s = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { bodies: { id: string; names?: { faces: string[] } | null }[] } } } } } } }).__CAD__.services.doc.state.get();
    const b = s.rebuild.bodies[0];
    return { body: b.id, index: b.names!.faces.indexOf(`F:${id}:end`) };
  }, made.extrude);
  expect(top.index).toBeGreaterThanOrEqual(0);
  await recordFlashes(page);

  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__find', input: { query: 'Body 1 faces >Z', limit: 10 } }] },
    { tools: [{ name: 'cad__find', input: { query: 'Body 1 face at (5, 5, 11)', limit: 10 } }] },
    // The model is still answering while the person undoes the extrude.
    { hold: 'person', tools: [{ name: 'cad__find', input: { query: '#f1', limit: 10 } }] },
    { text: 'The top face is gone now.' },
  );
  const t = await startTurn(request, host, { text: 'Find the top face.', tab });
  await expect.poll(() => chats(host).length - before, { message: 'the third request is held', timeout: STEP_MS }).toBe(3);

  // The match was lit in the view, for a while.
  expect((await flashes(page))[0]).toEqual([{ kind: 'face', body: top.body, index: top.index }]);
  await expect.poll(async () => (await flashes(page)).at(-1), { message: 'the light goes out', timeout: STEP_MS }).toEqual([]);

  // The person undoes the extrude: the face the handle named is gone.
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  await page.keyboard.press('Control+z');
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1'], STEP);
  host.fake.release('person');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');

  const [, afterFind, afterMiss, afterStale] = chats(host).slice(before);
  const [found] = resultsIn(afterFind);
  expect(found).toMatchObject({ tool: 'cad__find', ok: true, data: { query: 'Body 1 faces >Z', kind: 'face', count: 1, more: 0 } });
  expect((found.data!.rows as Record<string, unknown>[])[0]).toMatchObject({
    handle: '#f1',
    kind: 'face',
    label: 'Extrude 1.end',
    words: 'End face of Extrude 1',
    body: 'Body 1',
    feature: 'Extrude 1',
    role: 'end',
    type: 'plane',
    area_mm2: 1200,
    center_mm: [20, 15, 10],
    normal: [0, 0, 1],
    frame: { words: 'u runs +X, v runs +Y, origin (0, 0, 10)' },
  });
  const [miss] = resultsIn(afterMiss);
  expect(miss).toMatchObject({
    tool: 'cad__find',
    ok: false,
    error: { code: 'invalid_input', message: 'nothing_selected: No face of Body 1 at (5, 5, 11): nearest is Extrude 1.end, 1 mm away.', detail: { reason: 'nothing_selected' } },
  });
  expect((miss.error!.detail!.candidates as Record<string, unknown>[])[0]).toMatchObject({ handle: '#f1', label: 'Extrude 1.end', words: 'End face of Extrude 1' });
  const [stale] = resultsIn(afterStale);
  expect(stale).toMatchObject({
    tool: 'cad__find',
    ok: false,
    error: { code: 'invalid_input', message: 'selector_stale: #f1 is gone: Body 1 is not there now; call find again.', hint: 'That handle is gone after a change: call find again.', detail: { reason: 'selector_stale', handle: '#f1' } },
  });
});
