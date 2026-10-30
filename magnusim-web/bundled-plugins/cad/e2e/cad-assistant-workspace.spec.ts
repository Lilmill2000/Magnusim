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
//   downloaded until the person clicks Export;
// - the section view (Daniel 2026-10-29: any plane, a construction plane too): section on a
//   construction plane at an angle by its name cuts the person's view on its own normal; the reply's
//   view and get_model name the plane; INSPECT > Section view shows that plane and offset; the plane
//   deleted, get_model says the panel's note; a face's cut comes with its selector, taken back;
// - see-through bodies (Daniel 2026-10-29): see_through marks Body 1 in the tree and the view draws
//   it translucent, get_model's parts say see_through, opaque takes it back; no undo step;
// - keybinds (Daniel: read any time, changed only when the person asks): keybind_get answers;
//   keybind_set without person_asked is not_asked; with it the app's dialog names the exact change,
//   a stray Enter is No (step_declined, nothing changes), a click on Yes changes and stores it.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
import { cadFrame, chats, newProject, openNewPart, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';
import { addSolid, runCommand } from './helpers';

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

test("cad:assistant-workspace-section section on a construction plane at an angle by its name: the person's view is cut on its own normal, the reply and get_model name it, and INSPECT > Section view shows it", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Workspace section');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await addSolid(page, { size: [20, 20, 20] });
  // Tilt: the Top plane turned 30 deg about X (normal (0, -1/2, sqrt 3 / 2)), put in as setup.
  const plane = await cadFrame(page).evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (window as any).__CAD__.services.doc;
    const s = doc.beginNew('ref_plane', { method: 'angle', plane: { kind: 'origin', plane: 'origin:top' }, axis: { kind: 'origin', axis: 'origin:x' }, angle: '30 deg', name: 'Tilt' });
    s.commit();
    return s.feature as string;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cut = () => cadFrame(page).evaluate(() => (window as any).__CAD__.services.viewport.get().handle.state.get().section as { on: boolean; plane: unknown; frame: { normal: number[] }; offset: number; flip: boolean });
  await expect(frame.locator('[data-vp-opens="section"]')).toHaveAttribute('aria-pressed', 'false');
  const before = chats(host).length;
  host.fake.reply(
    { tools: [W('section', { value: 'Tilt offset 2 mm', person_asked: true })] },
    { tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '', regions: 'short' } }] },
    { text: 'Cut on Tilt.' },
  );
  const t = await startTurn(request, host, { text: 'Cut my view on the Tilt plane, 2 mm up.', tab });
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  // The person's view: cut on Tilt itself (its feature), on its own normal, 2 mm along it.
  const c = await cut();
  expect(c).toMatchObject({ on: true, plane: { kind: 'feature', feature: plane }, offset: 2, flip: false });
  expect(c.frame.normal.map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, -0.5, Math.round((Math.sqrt(3) / 2) * 1e6) / 1e6]);
  await expect(frame.locator('[data-vp-opens="section"]')).toHaveAttribute('aria-pressed', 'true');
  const r = chats(host).slice(before);
  const words = { plane: 'Tilt', offset_mm: 2, flip: false, keeps: 'the side against its normal' };
  expect(resultsIn(r[1])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, text: "Section view on in the person's view: Tilt offset 2 mm, keeps the side against its normal", data: { undo_step: false, section: words, view: { section: words } } });
  expect(resultsIn(r[2])[0]).toMatchObject({ tool: 'cad__get_model', ok: true, data: { section: words } });
  // The person's INSPECT > Section view shows the same plane and offset.
  await runCommand(frame, 'inspect.section');
  const panel = frame.locator('[data-tool-panel="inspect.section"]');
  await expect(panel).toBeVisible(STEP);
  await expect(panel.locator('[data-pick-field="section-plane"] .cad-pick-name')).toHaveText(['Tilt']);
  await expect(panel.locator('.nui[data-field="section-offset"] input')).toHaveValue('2');
  expect(await cut()).toMatchObject({ on: true, offset: 2 });

  // The person deletes Tilt: the section turns off and the panel's note says why; get_model says the
  // same words. A cut on the block's top face: get_model gives its selector, and the workspace's
  // section takes it back (offset and side changed on the same face).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(await cadFrame(page).evaluate((id) => (window as any).__CAD__.services.doc.remove(id).ok as boolean, plane)).toBe(true);
  await expect(panel.locator('[data-section-note]')).toHaveText('The section view is off: Tilt was deleted.', STEP);
  const before2 = chats(host).length;
  const model = { name: 'cad__get_model', input: { detail: 'brief', feature: '', regions: 'short' } };
  host.fake.reply(
    { tools: [model] },
    { tools: [W('section', { value: 'Extrude 1.end offset -5 mm', person_asked: true })] },
    { tools: [model] },
    { tools: [W('section', { value: 'Extrude 1.end offset -2 mm flip', person_asked: true })] },
    { text: 'Tilt was deleted; the cut is on the top face now.' },
  );
  const t2 = await startTurn(request, host, { text: 'Why did my section go? Cut on the top face instead.', tab });
  expect((await t2.ended(STEP_MS * 3)).turn.state).toBe('done');
  const r2 = chats(host).slice(before2);
  expect(resultsIn(r2[1])[0]).toMatchObject({ tool: 'cad__get_model', ok: true, data: { section: { on: false, note: 'The section view is off: Tilt was deleted.' } } });
  const face = { plane: 'End face of Extrude 1 on Body 1', selector: 'Extrude 1.end' };
  expect(resultsIn(r2[2])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, data: { view: { section: { ...face, offset_mm: -5, flip: false } } } });
  expect(resultsIn(r2[3])[0]).toMatchObject({ tool: 'cad__get_model', ok: true, data: { section: { ...face, offset_mm: -5, flip: false, keeps: 'z <= 15 mm' } } });
  expect(resultsIn(r2[4])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, data: { view: { section: { ...face, offset_mm: -2, flip: true, keeps: 'z >= 18 mm' } } } });
  expect(await cut()).toMatchObject({ on: true, plane: { kind: 'face' }, offset: -2, flip: true });
  await expect(panel.locator('[data-pick-field="section-plane"] .cad-pick-name')).toHaveText(['End face of Extrude 1']);
  await expect(panel.locator('[data-section-note]')).toHaveCount(0);
});

test("cad:assistant-workspace-see-through see_through draws Body 1 see-through: the tree marks it, the view draws it translucent, get_model says so; opaque takes it back; no undo step", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Workspace see-through');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await addSolid(page, { size: [30, 20, 10] });
  const bodyRow = frame.locator('[data-body-row]').first();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opacity = () => cadFrame(page).evaluate(() => Object.values((window as any).__CAD__.services.viewport.get().handle.stats().opacity) as number[]);
  await expect.poll(opacity, STEP).toEqual([1]);
  const undoBefore = await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.doc.state.get().history.undoLabel);
  const before = chats(host).length;
  host.fake.reply(
    { tools: [W('see_through', { target: 'Body 1' })] },
    { hold: 'seen', tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '', regions: 'short' } }] },
    { hold: 'back', tools: [W('opaque', { target: 'Body 1' })] },
    { text: 'Done.' },
  );
  const t = await startTurn(request, host, { text: 'Make the body see-through, then opaque again.', tab });
  // The person's tree marks it and the view draws it see-through.
  await expect(bodyRow).toHaveAttribute('data-see-through', 'view', STEP);
  await expect(bodyRow.locator('[data-see-through-badge]')).toHaveCount(1);
  await expect.poll(opacity, STEP).toEqual([0.28]);
  host.fake.release('seen');
  await expect.poll(() => chats(host).length - before, STEP).toBeGreaterThanOrEqual(3);
  host.fake.release('back');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  await expect(bodyRow).not.toHaveAttribute('data-see-through', /./, STEP);
  await expect.poll(opacity, STEP).toEqual([1]);
  const r = chats(host).slice(before);
  expect(resultsIn(r[1])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, text: 'Made Body 1 see-through in the view', data: { see_through: true, undo_step: false } });
  expect(resultsIn(r[2])[0]).toMatchObject({ tool: 'cad__get_model', ok: true, data: { parts: [{ name: 'Body 1', see_through: true }] } });
  expect(resultsIn(r[3])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, text: 'Made Body 1 opaque in the view', data: { see_through: false, undo_step: false } });
  // A view state: no undo step.
  expect(await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.doc.state.get().history.undoLabel)).toBe(undoBefore);
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

test("cad:assistant-workspace-keybinds keybinds: read freely; a change only with person_asked and the person's Yes in the app's dialog, which names the exact change", async ({ page, request }) => {
  test.setTimeout(240_000);
  const prefs = (action: 'get' | 'remove') => request.post(`${host.base}/api/plugin-prefs/${action}`, { data: { plugin: 'cad', key: 'keybinds' } });
  expect((await prefs('remove')).ok()).toBe(true);
  try {
    const pid = await newProject(request, host, 'Workspace keybinds');
    const { tab } = await openNewPart(page, request, host, pid);
    const keys = () => cadFrame(page).evaluate(() => [...(window as unknown as { __CAD__: { keybinds: { model: { current(id: string): string[] } } } }).__CAD__.keybinds.model.current('sketch.rectangle')]);
    const before = chats(host).length;
    host.fake.reply(
      { tools: [W('keybind_get', { target: 'sketch.rectangle' })] },
      { tools: [W('keybind_set', { target: 'sketch.rectangle', value: 'Shift+T' })] },
      { tools: [W('keybind_set', { target: 'sketch.rectangle', value: 'Shift+T', person_asked: true })] },
      { tools: [W('keybind_set', { target: 'sketch.rectangle', value: 'Shift+T', person_asked: true })] },
      { text: 'Done.' },
    );
    const t = await startTurn(request, host, { text: 'Make the rectangle shortcut Shift+T.', tab });
    // The app's own dialog, with the exact change: the person says No first.
    const dialog = page.locator('#modal-confirm');
    await expect(dialog).toBeVisible(STEP);
    // The wording the app's Settings and its own keybind tool ask with too.
    await expect(page.locator('#cf-heading')).toHaveText('Change a keybind?');
    await expect(page.locator('#cf-copy')).toHaveText('Magnusim CAD · Rectangle: R → Shift+T');
    await expect(page.locator('#cf-confirm')).toHaveText('Change');
    // A stray Enter never answers Yes (review): the guarded dialog takes it as Cancel.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden(STEP);
    expect(await keys()).toEqual(['KeyR']);
    // Asked again: Yes.
    await expect(dialog).toBeVisible(STEP);
    await expect(page.locator('#cf-copy')).toHaveText('Magnusim CAD · Rectangle: R → Shift+T');
    await page.locator('#cf-confirm').click();
    expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
    expect(await keys()).toEqual(['Shift+KeyT']);
    await expect.poll(async () => (await (await prefs('get')).json()).value ?? null).toEqual({ 'sketch.rectangle': ['Shift+KeyT'] });
    const r = chats(host).slice(before);
    expect(resultsIn(r[1])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, text: 'Rectangle: R', data: { keybind: { keys: ['KeyR'], shown: 'R' } } });
    expect(resultsIn(r[2])[0]).toMatchObject({ tool: 'cad__workspace', ok: false, error: { detail: { reason: 'not_asked' } } });
    expect(resultsIn(r[3])[0]).toMatchObject({ tool: 'cad__workspace', ok: false, error: { code: 'busy', detail: { reason: 'step_declined' } } });
    expect(resultsIn(r[4])[0]).toMatchObject({ tool: 'cad__workspace', ok: true, text: 'Rectangle: Shift+T (was R)', data: { stored: true, undo_step: false } });
  } finally {
    await prefs('remove');
  }
});
