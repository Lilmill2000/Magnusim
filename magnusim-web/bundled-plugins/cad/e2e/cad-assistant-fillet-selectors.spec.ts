// The Assistant finds fillets and drilled holes by their shape (S4) with the person's own words,
// as the person sees it: on a STEP part made in the test and imported with FILE > Import STEP
// (e2e/rounded-block.ts: R5 verticals, R2 round the top, four 6 mm holes, a 6/10 mm counterbore),
// a scripted turn calls find "Body 1 faces fillet <= 2 mm" (8 faces, each fillet_mm 2) and
// "Body 1 faces hole <= 6 mm" (4 faces, 4 holes, 6 mm through), and the person's INSPECT > Find
// shows the same counts for the same queries; then direct delete_faces with the same fillet
// selector: the tree shows Delete faces 1 ok and the volume chip the sharp part's volume, as the
// person's Find, Select all and Delete give (cad-find-fillets-holes.spec.ts). A body over the face
// limits (lowered) is refused in the same words the Find panel shows, naming both limits (fillets
// and holes each have one, kernel API 9) with both numbers in the tool's detail, and the dock's
// step says them. Without S4, "fillet" is a bad selector and the find fails.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
import { runCommand } from './helpers';
import { cadFrame, chats, newProject, openNewPart, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';
import { importRoundedBlock } from './rounded-block';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-fillet-selectors', 140);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; recognition: { maxFilletFaces: number; maxHoleFaces: number }; assistant: { setPace(p: string | null, scale?: number | null): void } } };

const DIRECT = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'press_pull', faces: [], distance: '', bodies: [], tool: '', keep_tool: false, move: [], turn: { angle: '', axis: '', pivot: [] }, copy: false, shape: 'box', padding: 'zero', sides: [], ...o });
const FIND = (query: string) => ({ name: 'cad__find', input: { query, limit: 25 } });

/** The tree's feature rows as the person reads them: name, type and state. */
const treeRows = (page: Page) =>
  cadFrame(page).evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-cad-tree] [data-feature-row]'), (e) => `${e.querySelector('.tree-row .tl')?.textContent ?? ''} ${e.dataset.featureType ?? ''} ${e.dataset.state ?? ''}`));
const chipVolume = (page: Page) => cadFrame(page).evaluate(() => Number(document.querySelector('[data-chip="volume"] [data-volume-mm3]')?.getAttribute('data-volume-mm3') ?? NaN));

test('cad:assistant-fillet-selectors find "Body 1 faces fillet <= 2 mm" and "hole <= 6 mm", then delete_faces with the same selector: Delete faces 1 ok at the sharp volume; over the limit, the words', async ({ page, request }) => {
  test.setTimeout(300_000);
  const pid = await newProject(request, host, 'Assistant fillets');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const made = await importRoundedBlock(page, frame);
  await expect.poll(() => treeRows(page), STEP).toEqual([expect.stringMatching(/^Imported 1 .* import ok$/)]);

  const before = chats(host).length;
  host.fake.reply({ tools: [FIND('Body 1 faces fillet <= 2 mm'), FIND('Body 1 faces hole <= 6 mm')] }, { text: '8 fillet faces up to 2 mm, and 4 holes up to 6 mm.' });
  const t = await startTurn(request, host, { text: 'Which fillets and holes are small?', tab });
  expect((await t.ended(STEP_MS * 4)).turn.state).toBe('done');
  const [, afterFind] = chats(host).slice(before);
  const [fillets, holes] = resultsIn(afterFind);
  expect(fillets).toMatchObject({ tool: 'cad__find', ok: true, data: { count: 8, kind: 'face' } });
  expect((fillets.data!.rows as { fillet_mm: number }[]).map((r) => r.fillet_mm)).toEqual(Array(8).fill(2));
  expect(holes).toMatchObject({ tool: 'cad__find', ok: true, data: { count: 4, holes: 4 } });
  expect((holes.data!.rows as { hole_mm: number; through: boolean }[]).map((r) => [r.hole_mm, r.through])).toEqual(Array(4).fill([6, true]));
  expect(holes.text).toBe('find "Body 1 faces hole <= 6 mm": 4 faces (4 holes)');

  // The person's Find: the same counts for the same queries.
  await runCommand(frame, 'inspect.find');
  const panel = frame.locator('[data-cad-panel="tool"]');
  for (const [q, words] of [
    ['Body 1 faces fillet <= 2 mm', '8 faces match Body 1 faces fillet <= 2 mm'],
    ['Body 1 faces hole <= 6 mm', '4 faces match Body 1 faces hole <= 6 mm (4 holes)'],
  ]) {
    await panel.locator('[data-find-query]').fill(q);
    await panel.locator('[data-find-query]').press('Enter');
    await expect(panel.locator('[data-find-count]'), q).toHaveText(words, STEP);
  }
  await expect(panel.locator('[data-find-count]')).toHaveAttribute('data-find-count', String(holes.data!.count));
  await expect(panel.locator('[data-find-count]')).toHaveAttribute('data-find-holes', String(holes.data!.holes));
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);

  // Then the selector in delete_faces.
  const atDelete = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__direct', input: DIRECT({ kind: 'delete_faces', faces: ['Body 1 faces fillet <= 2 mm'] }) }] }, { text: 'The R2 round the top is gone.' });
  const t2 = await startTurn(request, host, { text: 'Take the 2 mm fillets off.', tab });
  expect((await t2.ended(STEP_MS * 4)).turn.state).toBe('done');
  const afterDelete = chats(host)[atDelete + 1];
  const deleted = resultsIn(afterDelete)[0];
  expect(deleted, JSON.stringify(deleted.error ?? null)).toMatchObject({ tool: 'cad__direct', ok: true, data: { feature: { name: 'Delete faces 1', type: 'delete_faces', state: 'ok' } } });

  // What the person sees: the row ok, the chip at the sharp part (the same as their own Find and Delete).
  await expect.poll(() => treeRows(page), STEP).toEqual([expect.stringMatching(/^Imported 1 .* import ok$/), 'Delete faces 1 delete_faces ok']);
  await expect.poll(async () => Math.abs((await chipVolume(page)) / made.sharp - 1), STEP).toBeLessThan(1e-6);

  // Over the face limits: the tool's words, as the Find panel shows them, in the dock's step.
  await cadFrame(page).evaluate(() => {
    Object.assign((window as unknown as W).__CAD__.recognition, { maxFilletFaces: 10, maxHoleFaces: 8 });
  });
  try {
    const n = chats(host).length;
    host.fake.reply({ tools: [FIND('Body 1 faces fillet')] }, { text: 'Body 1 is too large for that.' });
    await core.dockSend(page, 'Find the fillets.');
    await expect(core.dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 4 });
    const [big] = resultsIn(chats(host)[n + 1]);
    const faces = await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces as number);
    const words = `Body 1 has ${faces} faces: fillets are found on bodies of up to 10 faces and holes on bodies of up to 8 faces.`;
    expect(big).toMatchObject({ tool: 'cad__find', ok: false, error: { message: expect.stringContaining(words), detail: { why: 'too_large', faces, over: 'fillets', limit: 10, limits: { fillets: 10, holes: 8 } } } });
    await expect(core.dockTurn(page).locator('[data-dock-step][data-dock-step-state="failed"] [data-dock-result]').filter({ hasText: words })).toBeVisible(STEP);
  } finally {
    await cadFrame(page).evaluate(() => {
      Object.assign((window as unknown as W).__CAD__.recognition, { maxFilletFaces: 5000, maxHoleFaces: 2600 });
    });
  }
});
