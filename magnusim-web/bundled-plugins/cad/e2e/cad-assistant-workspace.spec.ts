// The workspace tool as the person sees it (Daniel's rule: whatever a person can do, use or see in
// the CAD program, the Assistant can too), through the app with the scripted model:
// - the rollback bar: roll_back_to rolls Extrude 1 back in the tree (and the Assistant's own edit
//   then answers rolled_back at once), roll_to_end brings it back;
// - the eye: hide takes Body 1 out of the view and the tree's eye says so; body visibility show
//   brings it back; neither is an undo step;
// - the person's camera and the latch: a standard view with no move of the person's turns their
//   view; after their drag in the same request the next one answers view_latched and the camera
//   stays where they put it; with person_asked true it turns the view;
// - Export STEP: the person's own panel opens filled in (format, file name, bodies) and nothing is
//   downloaded until the person clicks Export.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
import { cadFrame, chats, newProject, openNewPart, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';
import { addSolid } from './helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-workspace', 110);
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

const W = (action: string, o: { target?: string; value?: string; items?: string[]; person_asked?: boolean } = {}) => ({
  name: 'cad__workspace',
  input: { action, target: o.target ?? '', value: o.value ?? '', items: o.items ?? [], person_asked: o.person_asked ?? false },
});

type WW = {
  __CAD__: {
    services: {
      viewport: { get(): { handle: { userCameraMoves(): number; camera(): { position: number[]; target: number[]; up: number[] }; state: { get(): { animating: boolean } } } } };
      doc: { state: { get(): { view: { rollback: number | null; hiddenBodies: string[] }; history: { undoLabel: string | null } } } };
    };
  };
};

async function cameraNow(page: Page) {
  await expect.poll(() => cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.viewport.get().handle.state.get().animating), STEP).toBe(false);
  return cadFrame(page).evaluate(() => {
    const c = (window as unknown as WW).__CAD__.services.viewport.get().handle.camera();
    return { position: c.position, target: c.target, up: c.up };
  });
}

/** Where the camera looks (a unit vector). */
const facing = (c: { position: number[]; target: number[] }) => {
  const d = c.target.map((v, i) => v - c.position[i]);
  const n = Math.hypot(...d);
  return d.map((v) => v / n);
};

test('cad:assistant-workspace-rollback-eye the rollback bar and the eye move in the tree as the person would move them, as no undo step', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Workspace rollback');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await addSolid(page, { size: [30, 20, 10] });
  const extrudeRow = frame.locator('[data-feature-row][data-feature-type="extrude"]');
  const bodyRow = frame.locator('[data-body-row]').first();
  await expect(extrudeRow).not.toHaveAttribute('data-rolled-back', '1');
  const undoBefore = await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.doc.state.get().history.undoLabel);
  const before = chats(host).length;
  host.fake.reply(
    { tools: [W('roll_back_to', { target: 'Sketch 1' })] },
    // Its own edit while it rolled the bar back: rolled_back at once, no wait.
    { hold: 'rolled', tools: [{ name: 'cad__set_params', input: { set: [{ name: 'w', kind: 'length', expr: '30 mm', comment: '', rename_to: '' }], remove: [] } }] },
    { hold: 'still', tools: [W('roll_to_end')] },
    { hold: 'end', tools: [W('hide', { target: 'Body 1' })] },
    { hold: 'hidden', tools: [{ name: 'cad__body', input: { body: 'Body 1', rename_to: '', color: '', simulation: 'keep', visibility: 'show' } }] },
    { text: 'Done.' },
  );
  const t = await startTurn(request, host, { text: 'Roll back to the sketch, then forward; hide the body and show it.', tab });
  await expect(extrudeRow).toHaveAttribute('data-rolled-back', '1', STEP);
  host.fake.release('rolled');
  // Its own edit was refused, nothing moved: still rolled back.
  await expect.poll(() => chats(host).length - before, STEP).toBeGreaterThanOrEqual(3);
  await expect(extrudeRow).toHaveAttribute('data-rolled-back', '1');
  host.fake.release('still');
  await expect(extrudeRow).not.toHaveAttribute('data-rolled-back', '1', STEP);
  host.fake.release('end');
  await expect(bodyRow).toHaveAttribute('data-visible', '0', STEP);
  host.fake.release('hidden');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  await expect(bodyRow).toHaveAttribute('data-visible', '1', STEP);
  const r = chats(host).slice(before);
  expect(resultsIn(r[1])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, data: { undo_step: false, rollback: { after: 'Sketch 1' } } });
  expect(resultsIn(r[2])[0]).toMatchObject({ tool: 'cad__set_params', ok: false, error: { code: 'busy', detail: { reason: 'rolled_back' } } });
  expect(resultsIn(r[4])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, text: 'Hid Body 1 in the view' });
  expect(resultsIn(r[5])[0]).toMatchObject({ tool: 'cad__body', ok: true, data: { visibility: 'shown', undo_step: false } });
  // Nothing of it is an undo step.
  expect(await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.doc.state.get().history.undoLabel)).toBe(undoBefore);
});

test("cad:assistant-workspace-camera the person's view: a standard view turns it; after the person's drag in the request it stays (view_latched), unless they asked", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Workspace camera');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await addSolid(page, { size: [30, 20, 10] });
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  const moves = () => cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.viewport.get().handle.userCameraMoves());
  const before = chats(host).length;
  host.fake.reply(
    { tools: [W('standard_view', { value: 'top' })] },
    { hold: 'drag', tools: [W('standard_view', { value: 'front' })] },
    { hold: 'asked', tools: [W('standard_view', { value: 'front', person_asked: true })] },
    { text: 'Looked.' },
  );
  const t = await startTurn(request, host, { text: 'Show me the top, then the front.', tab });
  await expect.poll(async () => facing(await cameraNow(page))[2], STEP).toBeLessThan(-0.999);
  // The person drags the view while the model thinks.
  const m0 = await moves();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(moves, STEP).toBeGreaterThan(m0);
  const theirs = await cameraNow(page);
  host.fake.release('drag');
  await expect.poll(() => chats(host).length - before, STEP).toBeGreaterThanOrEqual(3);
  // The latched call left the view where the person put it.
  expect(await cameraNow(page)).toEqual(theirs);
  host.fake.release('asked');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  const r = chats(host).slice(before);
  expect(resultsIn(r[1])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, text: "Turned the person's view to top" });
  expect(resultsIn(r[2])[0]).toMatchObject({ tool: 'cad__workspace', ok: false, error: { code: 'busy', detail: { reason: 'view_latched' } } });
  expect(resultsIn(r[3])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, data: { person_asked: true } });
  // Asked: the view looks at Front (along +Y).
  expect(facing(await cameraNow(page))[1]).toBeGreaterThan(0.999);
});

test("cad:assistant-workspace-export the person's Export STEP panel opens filled in; nothing downloads until the person clicks Export", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Workspace export');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await addSolid(page, { size: [30, 20, 10] });
  await addSolid(page, { at: [50, 0, 0], size: [10, 10, 10] });
  let downloads = 0;
  page.on('download', () => void downloads++);
  const before = chats(host).length;
  host.fake.reply({ tools: [W('export_step', { target: 'AP242', value: 'plate export', items: ['Body 2'] })] }, { text: 'The Export panel is ready: click Export.' });
  const t = await startTurn(request, host, { text: 'Get Body 2 ready to export as AP242.', tab });
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  const panel = frame.locator('[data-tool-panel="file.export-step"]');
  await expect(panel).toBeVisible(STEP);
  await expect(panel.locator('#cad-export-schema')).toHaveValue('AP242');
  await expect(panel.locator('#cad-export-name')).toHaveValue('plate export.step');
  await expect(panel.locator('[data-export-body] input[aria-label="Body 2"]')).toBeChecked();
  await expect(panel.locator('[data-export-body] input[aria-label="Body 1"]')).not.toBeChecked();
  expect(resultsIn(chats(host)[before + 1])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, data: { file: 'plate export.step', schema: 'AP242', bodies: ['Body 2'], person_clicks: 'Export' } });
  expect(downloads).toBe(0);
  // The person's click is the download.
  const dl = page.waitForEvent('download', { timeout: STEP_MS * 2 });
  await panel.locator('[data-export-run]').click();
  expect((await dl).suggestedFilename()).toBe('plate export.step');
});

// Back from the Part through the app page's core__show (core host tools spec 5.1, 14.2, 8.1): the
// card says what it sends where, as a person's Back would; Allow sends the design, and the model
// follows the link job with wait until the new geometry is in the project.
test('cad:assistant-workspace-back core__show Back asks with a card naming the Part and the project; Allow sends the design, and wait follows its link job to the end', async ({ page, request }) => {
  test.setTimeout(300_000);
  const pid = await newProject(request, host, 'Leave card');
  await openNewPart(page, request, host, pid);
  await addSolid(page, { size: [30, 20, 10] });
  const results: Array<Record<string, unknown>> = [];
  host.fake.reply(
    { tools: [{ name: 'core__show', input: { target: 'project', project_id: '', id: '', panel: '' } }] },
    (body: unknown) => {
      const r = resultsIn(body);
      results.push(...r);
      const job = String((r[0] as { data?: { job?: string } }).data?.job ?? '');
      return { tools: [{ name: 'wait', input: { project_id: '', job_ids: [job || 'link.gl-none'], until: 'all', timeout_s: 240 } }] };
    },
    (body: unknown) => {
      results.push(...resultsIn(body));
      return { text: 'Your design is in the simulation.' };
    },
  );
  await core.dockSend(page, 'Send this to the simulation.');
  // The card names what goes where, before anything leaves.
  const card = core.dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to send your design to the simulation?', STEP);
  await expect(card.locator('.dock-gate-copy')).toHaveText(/^Leaves the .+ Part "Part 1" and sends its design to project "Leave card" as a new geometry\.$/);
  await expect(card.locator('.dock-gate-detail')).toContainText('a new one');
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  await card.locator('[data-gate-answer="yes"]').click();
  // The window goes back to the project, and the turn follows the link job to its end.
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: STEP_MS * 2 });
  await expect(core.dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 300_000 });
  expect(results.map((r) => [r.tool, r.ok])).toEqual([
    ['core__show', true],
    ['wait', true],
  ]);
  expect(String((results[0] as { data: { job: string } }).data.job)).toMatch(/^link\.gl-/);
  const jobs = (results[1] as { data: { ended: boolean; jobs: Array<{ status: string; result: { geometry: string } | null }> } }).data;
  expect(jobs.ended).toBe(true);
  expect(jobs.jobs.map((j) => j.status)).toEqual(['done']);
  // The geometry it names is the project's new one.
  const proj = await (await request.get(`${host.base}/api/project?project_id=${encodeURIComponent(pid)}`)).json();
  const names = ((proj.project?.geometries ?? []) as Array<{ name: string }>).map((g) => g.name);
  expect(names).toContain(jobs.jobs[0].result?.geometry);
});
