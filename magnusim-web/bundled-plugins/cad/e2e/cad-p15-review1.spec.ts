// P1.5 review round 1, the smaller findings, each as the user meets it in the
// real host frame with the real kernel:
//   - a feature that stopped the kernel is red with the reason and Retry, and
//     Retry builds it (no e2e covered the stopped-feature Retry path);
//   - a P1 Part whose file this version can repair (a parameter with no id)
//     opens with everything in it and moves; one it cannot fully read is not
//     moved or rewritten, and the Part says why (a parameter was dropped
//     silently and the moved Part saved without it, saying Saved);
//   - a field with an unknown parameter says so once, under the field, keeps
//     its unit and stays in line with the other fields (the reason showed three
//     times, and the field lost "mm" and moved right).
// window.__CAD__ is not used: the crash below is a fault injected into the
// frame's own kernel worker (its error event), as a crashed worker raises it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { baseUrl, historyState, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

type Loc = ReturnType<FrameLocator['locator']>;

/** A full-page screenshot into CAD_E2E_SHOTS (when set). */
async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${name}$`) }) });
const expectSaved = (frame: FrameLocator) => expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });
const volumeChip = (frame: FrameLocator) => frame.locator('[data-chip="volume"]');

async function setField(panel: Loc, field: string, value: string) {
  const input = panel.locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel.locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, row, projectId };
}

async function backToProject(page: Page) {
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
}

/** A Part as a P1 build left it: the pointer says "data", and model.json is ws.data's file with its own version token. */
async function p1Part(request: APIRequestContext, projectId: string, title: string, doc: unknown) {
  const created = await (await request.post(`${baseUrl()}/api/plugin-studies/create`, { data: { project_id: projectId, plugin: 'cad', kind: 'part', title } })).json();
  const studyId = String(created.study.id);
  const rel = `studies/${studyId}/model.json`;
  const pointer = { rel, schema: 1, store: 'data', view: `studies/${studyId}/view.json` };
  const rec = await (await request.get(`${baseUrl()}/api/plugin-studies/get?${new URLSearchParams({ project_id: projectId, plugin: 'cad', study_id: studyId })}`)).json();
  const upd = await request.post(`${baseUrl()}/api/plugin-studies/update`, { data: { project_id: projectId, plugin: 'cad', study_id: studyId, rev: rec.study.rev, patch: { doc: pointer } } });
  expect(upd.ok(), await upd.text()).toBe(true);
  const file = { format: 'magnusim-cad/model', etag: '7.s_p1tab', saved_at: '2026-09-30T20:00:00.000Z', doc };
  const w = await request.post(`${baseUrl()}/api/plugin-data/write`, { data: { project_id: projectId, plugin: 'cad', rel, doc: file } });
  expect(w.ok(), await w.text()).toBe(true);
  const bytes = await (await request.get(`${baseUrl()}/api/plugin-files/read?${new URLSearchParams({ project_id: projectId, plugin: 'cad', rel })}`)).text();
  return { studyId, rel, pointer, bytes };
}

const p1Doc = (params: unknown[], size: string[] = ['w', '20 mm', '10 mm']) => ({
  schema: 1,
  units: { length: 'mm', angle: 'deg' },
  params,
  bodies: { b_p1: { name: 'Body 1', color: '#bdc9db' } },
  features: [{ id: 'f_p1', type: 'box', name: 'Old box', op: 'new', creates: 'b_p1', scope: [], origin: ['0 mm', '0 mm', '0 mm'], size }],
  meta: { created_at: '2026-09-30T19:00:00.000Z', written_by: '0.1.0' },
});

const partRow = (page: Page, title: string) => page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: title }) });

async function readFile(request: APIRequestContext, projectId: string, rel: string): Promise<string | null> {
  const r = await request.get(`${baseUrl()}/api/plugin-files/read?${new URLSearchParams({ project_id: projectId, plugin: 'cad', rel })}`);
  return r.ok() ? r.text() : null;
}

async function pointerOf(request: APIRequestContext, projectId: string, studyId: string) {
  return (await (await request.get(`${baseUrl()}/api/plugin-studies/get?${new URLSearchParams({ project_id: projectId, plugin: 'cad', study_id: studyId })}`)).json()).study.doc;
}

test('cad:p15-r1-stopped-feature-retry a feature that stopped the kernel is red with the reason and Retry; Retry builds it', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const panel = frame.locator('[data-cad-panel="feature"]');
  await tb.locator('[data-command="solid.box"]').click();
  await panel.locator('[data-panel-done]').click();
  await tb.locator('[data-command="solid.box"]').click();
  await setField(panel, 'origin.0', '50');
  await panel.locator('[data-panel-done]').click();
  await expect(volumeChip(frame)).toHaveText('VolumeTotal of 2 bodies · 16,000 mm³');
  await expectSaved(frame);
  // The next box the kernel builds crashes its worker (the worker's own error event, while the call is in flight).
  await workspaceFrame(page).evaluate(() => {
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, ...rest: unknown[]) {
      const out = (orig as (...a: unknown[]) => void).call(this, msg, ...rest);
      const m = msg as { type?: string; op?: string } | null;
      if (m && m.type === 'call' && m.op === 'box') {
        Worker.prototype.postMessage = orig;
        const w = this;
        // Right after the call is sent, before any reply can come (a microtask runs before the next event).
        queueMicrotask(() => w.onerror?.(new ErrorEvent('error', { message: 'the worker crashed' })));
      }
      return out;
    } as typeof orig;
  });
  // Box 2 made 30 high: its build is the one that stops the kernel.
  const box2 = featureRow(frame, 'Box 2');
  await box2.locator('> .tree-row').dblclick();
  await setField(panel, 'size.2', '30');
  await panel.locator('[data-panel-done]').click();
  // The kernel restarts, the part rebuilds, and Box 2 waits, red, until the user says.
  await expect(box2).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-kernel', 'ready', { timeout: 60_000 });
  await expect(box2.locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', /^What's wrong: Box 2 stopped the kernel: The kernel crashed during box: the worker crashed$/);
  await expect(featureRow(frame, 'Box 1')).toHaveAttribute('data-state', 'ok');
  await expect(volumeChip(frame)).toHaveText('Volume8000 mm³');
  // Its panel says why, with Retry; Retry builds it.
  await box2.locator('> .tree-row').dblclick();
  const reason = panel.locator('[data-run-reason]');
  await expect(reason.locator('.sim-run-hint-msg')).toHaveText('Box 2 stopped the kernel: The kernel crashed during box: the worker crashed');
  await expect(reason.locator('[data-fix]')).toHaveText(['Retry']);
  await shot(page, 'p15r1-stopped-feature');
  await reason.locator('[data-fix="Retry"]').click();
  await expect(box2).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(reason).toHaveCount(0);
  await panel.locator('[data-panel-done]').click();
  await expect(volumeChip(frame)).toHaveText('VolumeTotal of 2 bodies · 20,000 mm³');
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p15-r1-p1-part-repaired a P1 Part with a parameter that has no id opens with the parameter, and moves with it', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  const p1 = await p1Part(request, projectId, 'Odd part', p1Doc([{ name: 'w', expr: '30 mm', quantity: 'length' }]));
  await openProject(page, projectId);
  const frame = await openPart(page, partRow(page, 'Odd part'));
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  // Everything is there: the parameter, and the box it sizes (30 x 20 x 10).
  await expect(frame.locator('[data-cad-tree] [data-params-row] .tl')).toHaveText('Parameters (1)');
  await expect(featureRow(frame, 'Old box')).toHaveAttribute('data-state', 'ok');
  await expect(volumeChip(frame)).toHaveText('Volume6000 mm³');
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved');
  await frame.locator('[data-cad-toolbar] [data-command="modify.parameters"]').click();
  const params = frame.locator('[data-cad-panel="params"]');
  await expect(params.locator('[data-param-row="w"] [data-param-value]')).toHaveText('30 mm');
  await params.locator('[data-panel-done]').click();
  // Reopened: the same.
  await backToProject(page);
  const again = await openPart(page, partRow(page, 'Odd part'));
  await expect(again.locator('[data-cad-tree] [data-params-row] .tl')).toHaveText('Parameters (1)');
  await expect(volumeChip(again)).toHaveText('Volume6000 mm³');
  // Moved with it: the stored model keeps w (now with an id); the P1 file is kept byte for byte.
  expect(await pointerOf(request, projectId, p1.studyId)).toEqual({ ...p1.pointer, store: 'files' });
  const moved = JSON.parse((await readFile(request, projectId, p1.rel))!);
  expect(moved.doc.params).toEqual([{ name: 'w', expr: '30 mm', quantity: 'length', id: expect.stringMatching(/^p_[0-9a-z]{12}$/) }]);
  expect(await readFile(request, projectId, `studies/${p1.studyId}/model.p1.json`)).toBe(p1.bytes);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p15-r1-p1-part-unreadable a P1 Part this version cannot fully read says why, and its file is not moved or rewritten', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  // A parameter with no id and no quantity: is "w" a length, an angle or a number? Not guessed.
  const p1 = await p1Part(request, projectId, 'Odd part', p1Doc([{ name: 'w', expr: '30 mm' }]));
  await openProject(page, projectId);
  const frame = await openPart(page, partRow(page, 'Odd part'));
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'error');
  const why = frame.locator('[data-cad-tree] [data-tree-error]');
  await expect(why.locator('.sim-run-hint-msg')).toHaveText('Could not read the part: parameter "w" does not say whether it is a length, an angle or a number');
  await expect(why.locator('[data-fix]')).toHaveText(['Try again']);
  await expect(frame.locator('[data-cad-tree] [data-feature-row]')).toHaveCount(0);
  await shot(page, 'p15r1-p1-unreadable');
  // Nothing was written: the model is the P1 file as it was, there is no copy, and the pointer is unchanged.
  expect(await readFile(request, projectId, p1.rel)).toBe(p1.bytes);
  expect(await readFile(request, projectId, `studies/${p1.studyId}/model.p1.json`)).toBeNull();
  expect(await pointerOf(request, projectId, p1.studyId)).toEqual(p1.pointer);
  // Try again reads it again, and says the same.
  await why.locator('[data-fix="Try again"]').click();
  await expect(why.locator('.sim-run-hint-msg')).toHaveText('Could not read the part: parameter "w" does not say whether it is a length, an angle or a number');
  expect(await readFile(request, projectId, p1.rel)).toBe(p1.bytes);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p15-r1-unknown-param-panel a field with an unknown parameter says so once, keeps its unit, and stays in line', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  // A Part whose box's Length is "w", and no parameter w.
  await p1Part(request, projectId, 'Odd part', p1Doc([]));
  await openProject(page, projectId);
  const frame = await openPart(page, partRow(page, 'Odd part'));
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const box = featureRow(frame, 'Old box');
  await expect(box).toHaveAttribute('data-state', 'error');
  await expect(box.locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', 'What\'s wrong: Old box: Length: Unknown parameter "w"');
  await box.locator('> .tree-row').dblclick();
  const panel = frame.locator('[data-cad-panel="feature"]');
  const length = panel.locator('.nui[data-field="size.0"]');
  const width = panel.locator('.nui[data-field="size.1"]');
  await expect(length.locator('input')).toHaveValue('w');
  await expect(length.locator('[data-nui-error]')).toHaveText('Unknown parameter "w"');
  // Said once: under the field, not again in the panel's foot.
  expect(((await panel.innerText()).match(/Unknown parameter "w"/g) ?? []).length, await panel.innerText()).toBe(1);
  await expect(panel.locator('[data-run-reason]')).toHaveCount(0);
  await expect(panel.locator('.cad-not-applied')).toHaveCount(0);
  // The field keeps its unit and its place: in line with Width.
  await expect(length.locator('[data-nui-after]')).toHaveText('mm');
  const lx = (await length.locator('input').boundingBox())!;
  const wx = (await width.locator('input').boundingBox())!;
  expect(Math.abs(lx.x - wx.x), `Length input at x ${lx.x}, Width at ${wx.x}`).toBeLessThanOrEqual(1);
  expect(Math.abs(lx.width - wx.width)).toBeLessThanOrEqual(1);
  await shot(page, 'p15r1-unknown-param-panel');
  // A change to another field cannot apply while Length is broken: that is said (once more is new news).
  await setField(panel, 'size.1', '25');
  await expect(panel.locator('.cad-not-applied')).toHaveText('Not applied: Length: Unknown parameter "w"');
  // Length fixed: both apply.
  await setField(panel, 'size.0', '30');
  await expect(box).toHaveAttribute('data-state', 'ok');
  await expect(panel.locator('.cad-not-applied')).toHaveCount(0);
  await expect(length.locator('[data-nui-error]')).toHaveCount(0);
  await expect(volumeChip(frame)).toHaveText('Volume7500 mm³');
  await panel.locator('[data-panel-done]').click();
  await expectSaved(frame);
  expect(await historyState(frame)).toBe('Old box');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
