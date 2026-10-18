// The Assistant's edits say honestly what happened, as the person and the model meet them (CAD
// tools spec §12.3 honest 5, T2): on a plate whose top edges are filleted with the parameter r,
// a set_params that would turn the fillet red changes nothing: the model gets failed
// broke_downstream naming Fillet 1, and the person's open Parameters panel still shows r's old
// value. Rows in any order (b uses a, set after it) apply in one step: the model gets each value,
// the panel shows them, and one Undo ("Undo Assistant: <request>") takes both away.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { addSolid, runCommand } from './helpers';
import { cadFrame, chats, newProject, openNewPart, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-honest', 70);
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

type Doc = {
  addParam(p: { name: string; expr: string; quantity: string }): unknown;
  beginNew(type: string, init: unknown): { feature: string; commit(): void };
  beginEdit(id: string): { update(p: unknown): void; commit(): void };
  undo(): void;
  state: { get(): { doc: { params: { name: string; expr: string }[] }; rebuild: { status: string; features: Record<string, { state: string }>; bodies: { id: string; names: { faces: string[] } | null }[] }; history: { undoLabel: string | null } } };
};
type W = { __CAD__: { services: { doc: Doc }; assistant: { setPace(p: string | null, scale?: number | null): void } } };

const row = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });

/** The person's plate: 40 x 30 x t, its top face's edges filleted r (2 mm), every feature built. */
async function filletedPlate(page: Page): Promise<string> {
  const made = await addSolid(page, { size: [40, 30, 6] });
  const fillet = await cadFrame(page).evaluate(
    ({ extrude, body }) => {
      const doc = (window as unknown as W).__CAD__.services.doc;
      doc.addParam({ name: 't', expr: '6 mm', quantity: 'length' });
      doc.addParam({ name: 'r', expr: '2 mm', quantity: 'length' });
      const ex = doc.beginEdit(extrude);
      ex.update({ extent: { kind: 'blind', distance: 't' } });
      ex.commit();
      // The top face by its name (a face reference as the Fillet panel keeps it).
      const ref = { name: `F:${extrude}:end`, signature: { kind: 'face', type: 'plane', at: [20, 15, 6], dir: [0, 0, 1] } };
      const fl = doc.beginNew('fillet', { body, edges: [], faces: [ref], radius: 'r' });
      fl.commit();
      return fl.feature;
    },
    { extrude: made.extrude, body: made.body },
  );
  await expect
    .poll(() => cadFrame(page).evaluate((id) => {
      const r = (window as unknown as W).__CAD__.services.doc.state.get().rebuild;
      return r.status === 'done' ? (r.features[id]?.state ?? null) : null;
    }, fillet), { timeout: STEP_MS * 3 })
    .toBe('ok');
  return fillet;
}

test('cad:assistant-honest-params a set_params that would break the fillet changes nothing; rows in any order apply in one step', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest parameters');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const fillet = await filletedPlate(page);
  // The person's Parameters panel stays open through the turn (an idle one: the calls do not wait).
  await runCommand(frame, 'modify.parameters');
  const panel = frame.locator('[data-cad-panel="params"]');
  await expect(panel.locator('[data-param-row="r"] [data-param-value]')).toHaveText('2 mm', STEP);

  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__set_params', input: { set: [row('r', '10 mm')], remove: [] } }] },
    // b uses a, which comes after it: all rows apply together.
    { tools: [{ name: 'cad__set_params', input: { set: [row('b', 'a * 2'), row('a', '5 mm')], remove: [] } }] },
    { text: 'r stays 2 mm: 10 mm would break the fillet. a and b are set.' },
  );
  const t = await startTurn(request, host, { text: 'Make the fillet 10 mm, and add a and b.', tab });
  const { turn } = await t.ended(STEP_MS * 3);
  expect(turn.state).toBe('done');

  const [, afterBreak, afterRows] = chats(host).slice(before);
  const [broke] = resultsIn(afterBreak);
  expect(broke).toMatchObject({
    tool: 'cad__set_params',
    ok: false,
    error: { code: 'failed', detail: { reason: 'broke_downstream', broke: [{ feature: 'Fillet 1' }] }, hint: 'Nothing changed: pick a value that keeps the features in detail.broke working.' },
  });
  expect(broke.error!.message).toMatch(/^broke_downstream: Nothing changed: after it Fillet 1 would fail \(/);
  // The person sees the old value, and the fillet still builds.
  await expect(panel.locator('[data-param-row="r"] [data-param-value]')).toHaveText('2 mm', STEP);
  expect(await cadFrame(page).evaluate((id) => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.features[id]?.state, fillet)).toBe('ok');

  const [rows] = resultsIn(afterRows);
  expect(rows).toMatchObject({
    tool: 'cad__set_params',
    ok: true,
    data: { params: [{ name: 'b', kind: 'length', expr: 'a * 2', value: 10, unit: 'mm' }, { name: 'a', kind: 'length', expr: '5 mm', value: 5, unit: 'mm' }], broke: [], step: 1 },
  });
  await expect(panel.locator('[data-param-row="a"] [data-param-value]')).toHaveText('5 mm', STEP);
  await expect(panel.locator('[data-param-row="b"] [data-param-value]')).toHaveText('10 mm', STEP);
  // One step: the Undo the person sees names the request, and one Undo takes both rows away.
  const label = () => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel);
  expect(await label()).toBe('Assistant: Make the fillet 10 mm, and add a and b.');
  const chip = frame.locator('[data-chip="assistant"]');
  await expect(chip).toHaveAttribute('data-assistant-state', 'ended', STEP);
  await expect(chip).toHaveText('Assistant: Make the fillet 10 mm, and add a and b. · done');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Undo Assistant: Make the fillet 10 mm, and add a and b.', STEP);
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect
    .poll(() => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.params.map((p) => `${p.name}=${p.expr}`)), STEP)
    .toEqual(['t=6 mm', 'r=2 mm']);
});
