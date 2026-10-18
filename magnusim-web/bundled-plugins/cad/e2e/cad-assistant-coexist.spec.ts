// The Assistant and the person in one Part (CAD tools spec §12.3 coexist 1, T2): while the person
// types a value in the Parameters panel, the Assistant's edit holds: the dock's chip reads
// "Assistant waits for you: finish the value you are typing in Parameters" and nothing changes;
// the person's Done lets the edit finish, after the person's own value. Left open longer than
// the hold (setHoldS shortens the 10 minutes to 1.5 s here), the call answers busy
// person_editing to the model, and the person's panel is still open with their typed text, with
// nothing committed.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { runCommand } from './helpers';
import { cadFrame, chats, newProject, openNewPart, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';

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
  await expect(chip).toHaveText('Assistant waits for you: finish the value you are typing in Parameters');
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
