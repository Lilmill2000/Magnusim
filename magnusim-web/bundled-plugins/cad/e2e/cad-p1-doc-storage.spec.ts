// The Part document in the real host with the real kernel worker: the model is
// stored outside the study record (the record keeps only a pointer), autosaves,
// and reopens; an edit from a second tab is refused with "Changed in another
// tab" and Reload adopts it, while a rename in the header does not conflict;
// a kernel stopped by its watchdog respawns and the part rebuilds by itself;
// Back right after two edits loses neither: while the save is on its way the
// host asks first (host API 1.2), and once it lands Back just leaves.
// The model goes through ws.files (etag + ifMatch); ws.data reads the same file.
// Document edits are driven through the document service (the panels are
// UI-SHELL's own e2e): solids are sketched and extruded (helpers.ts addSketch /
// addSolid; there is no Box or Cylinder since decision 2026-10-01); what is
// asserted is what the user and the host see: the chips, the stored files, the
// rebuilt volume.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Frame, type Page } from '@playwright/test';
import { addSketch, addSolid, baseUrl, headerTakesKeyboard, holdCommits, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

type Snap = {
  status: string;
  features: string[];
  bodies: { name: string; volume: number | null; valid: boolean }[];
  save: string;
  rebuild: string;
  seq: number;
  respawns: number;
};

/** The document as the frame holds it (state checks only). */
async function snap(frame: Frame): Promise<Snap> {
  return frame.evaluate(() => {
    const s = (window as unknown as { __CAD__: { services: { doc: { state: { get(): any } }; kernel: { status: { get(): any } } } } }).__CAD__.services;
    const d = s.doc.state.get();
    return {
      status: d.status,
      features: d.doc.features.map((f: { name: string }) => f.name),
      bodies: d.rebuild.bodies.map((b: { name: string; volume: number | null; valid: boolean }) => ({ name: b.name, volume: b.volume, valid: b.valid })),
      save: d.save.state,
      rebuild: d.rebuild.status,
      seq: d.rebuild.seq,
      respawns: s.kernel.status.get().respawns,
    };
  });
}


async function studyRecord(request: APIRequestContext, projectId: string, studyId: string) {
  const q = new URLSearchParams({ project_id: projectId, plugin: 'cad', study_id: studyId });
  const r = await request.get(`${baseUrl()}/api/plugin-studies/get?${q}`);
  expect(r.ok()).toBe(true);
  return (await r.json()).study as Record<string, unknown>;
}

async function pluginFile(request: APIRequestContext, projectId: string, rel: string) {
  const r = await request.post(`${baseUrl()}/api/plugin-data/read`, { data: { project_id: projectId, plugin: 'cad', rel } });
  expect(r.ok()).toBe(true);
  return (await r.json()).doc as Record<string, any> | null;
}

function studyIdOf(page: Page): string {
  const m = /\/ws\/cad\/part\/([^/?#]+)/.exec(decodeURIComponent(page.url()));
  if (!m) throw new Error(`not a Part workspace address: ${page.url()}`);
  return m[1];
}

async function waitFor(frame: Frame, fn: (s: Snap) => boolean, what: string, timeout = 30_000) {
  const t0 = Date.now();
  let last: Snap | null = null;
  while (Date.now() - t0 < timeout) {
    last = await snap(frame);
    if (fn(last)) return last;
    await frame.page().waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${what}; last state ${JSON.stringify(last)}`);
}

const saved = (s: Snap) => s.save === 'saved' && s.rebuild === 'done';

test('cad:p1-doc-storage the model lives outside the study record, autosaves and reopens', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frameLoc = await partOpened(page);
  await expect(frameLoc.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const studyId = studyIdOf(page);
  let frame = workspaceFrame(page);

  // Opening a new Part wrote only the pointer into the study record, and an empty model beside it.
  // The empty model is written right after the Part opens: read it once the chip says it is
  // stored (P1.5 review round 1: read at once, it was sometimes not there yet).
  await expect(frameLoc.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });
  const rec = await studyRecord(request, projectId, studyId);
  expect(rec.doc).toEqual({ rel: `studies/${studyId}/model.json`, schema: 1, store: 'files', view: `studies/${studyId}/view.json` });
  const hostFields = ['created_at', 'doc', 'id', 'kind', 'plugin', 'plugin_name', 'plugin_version', 'rev', 'schema_version', 'title', 'updated_at'];
  expect(Object.keys(rec).sort()).toEqual(hostFields);
  const empty = await pluginFile(request, projectId, `studies/${studyId}/model.json`);
  expect(empty).toMatchObject({ format: 'magnusim-cad/model', doc: { schema: 2, units: { length: 'mm', angle: 'deg' }, features: [] } });
  // Written through ws.files: no version token inside (the host's etag is its version).
  expect(empty!.etag).toBeUndefined();
  const stat = await request.get(`${baseUrl()}/api/plugin-files/stat?${new URLSearchParams({ project_id: projectId, plugin: 'cad', rel: `studies/${studyId}/model.json` })}`);
  expect(stat.ok()).toBe(true);
  expect((await stat.json()).file).toMatchObject({ rel: `studies/${studyId}/model.json`, etag: expect.any(String) });

  // A 20 mm cube and a Ø10 circle cut through it (from z = -5, 40 long), sketched and extruded by the real kernel worker.
  await addSolid(page);
  await addSolid(page, { circle: true, at: [10, 10, -5], size: [10, 40], op: 'cut' });
  const s1 = await waitFor(frame, (s) => saved(s) && s.features.length === 4 && s.bodies.length === 1, 'the cut to build and save');
  const expected = 8000 - Math.PI * 25 * 20;
  expect(s1.bodies[0].valid).toBe(true);
  expect(s1.bodies[0].volume!).toBeCloseTo(expected, 6);
  // The user sees it: the history is no longer empty and the volume chip shows the cut body.
  await expect(frameLoc.locator('[data-tree-empty="history"]')).toHaveCount(0);
  const vol = frameLoc.locator('[data-chip="volume"] [data-volume-mm3]');
  await expect(vol).toBeVisible();
  expect(Number(await vol.getAttribute('data-volume-mm3'))).toBeCloseTo(expected, 6);
  await expect(frameLoc.locator('[data-chip="save"]')).toHaveText('Saved');

  // Stored beside study.json; the record still holds only the pointer.
  const model = await pluginFile(request, projectId, `studies/${studyId}/model.json`);
  expect(model!.doc.features.map((f: { name: string }) => f.name)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  expect(Object.keys(await studyRecord(request, projectId, studyId)).sort()).toEqual(hostFields);

  // Back and reopen: the same part, rebuilt.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').first());
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  frame = workspaceFrame(page);
  const s2 = await waitFor(frame, (s) => s.rebuild === 'done' && s.bodies.length === 1, 'the reopened part to rebuild');
  expect(s2.features).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  expect(s2.bodies[0].volume!).toBeCloseTo(expected, 6);

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-doc-conflict an edit from a second tab says "Changed in another tab"; a header rename does not conflict', async ({ page, context, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const aLoc = await partOpened(page);
  await expect(aLoc.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const a = workspaceFrame(page);

  // Rename in the host header, then edit: no conflict.
  await page.locator('#workspace-overlay [data-ws-title]').click();
  await expect(page.locator('#modal-prompt')).toBeVisible();
  await page.locator('#pm-input').fill('Housing');
  await page.locator('#pm-confirm').click();
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toHaveText(/Housing/);
  await addSolid(page);
  await waitFor(a, (s) => saved(s) && s.features.length === 2, 'tab A to save after the rename');
  await expect(aLoc.locator('[data-chip="save"]')).toHaveText('Saved');

  // A second tab opens the same Part (it sees Sketch 1 and Extrude 1).
  const page2 = await context.newPage();
  const seen2 = await watchPage(page2);
  await page2.goto(page.url());
  const bLoc = page2.frameLocator('#workspace-frame');
  await expect(bLoc.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  const b = workspaceFrame(page2);
  await waitFor(b, (s) => s.features.length === 2 && s.rebuild === 'done', 'tab B to load');

  // Tab A edits and saves; tab B, not knowing, edits too (a sketch): B's save is refused.
  await addSolid(page, { at: [50, 0, 0] });
  await waitFor(a, (s) => saved(s) && s.features.length === 4, 'tab A to save its second block');
  await addSketch(page2, { circle: true, at: [0, 60], size: [20] });
  await waitFor(b, (s) => s.save === 'conflict', 'tab B to see the conflict');
  const chip = bLoc.locator('[data-chip="save"][data-state="conflict"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Changed in another tab');
  // Tab A's model is intact.
  const studyId = studyIdOf(page);
  const model = await pluginFile(request, projectId, `studies/${studyId}/model.json`);
  expect(model!.doc.features.map((f: { name: string }) => f.name)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);

  // Reload adopts A's version and B can edit again. Tab B's header takes the
  // keyboard from its frame, so the keys hint shows; the Reload click is the one that
  // focuses the frame again: the hint must not move the Reload button away mid-click
  // (bug found in review round 1's fixes).
  await headerTakesKeyboard(page2);
  await expect(bLoc.locator('[data-chip="keys"]')).toBeVisible();
  await chip.getByRole('button', { name: 'Reload' }).click();
  await expect(bLoc.locator('[data-chip="keys"]')).toHaveCount(0);
  const sb = await waitFor(b, (s) => s.save === 'saved' && s.features.length === 4 && s.rebuild === 'done', 'tab B to reload');
  expect(sb.features).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  await expect(bLoc.locator('[data-chip="save"][data-state="conflict"]')).toHaveCount(0);
  await addSketch(page2, { circle: true, at: [0, 60], size: [20] });
  await waitFor(b, (s) => saved(s) && s.features.length === 5, 'tab B to save after reload');

  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
  // The browser logs the host's 409 answer to tab B's refused write (the conflict made here) as a failed load.
  const conflict409 = /^Failed to load resource: the server responded with a status of 409 \(Conflict\) \(http:\/\/[^/]+\/api\/plugin-files\/uploads(\/[^/]+\/commit)?\)$/;
  expect(seen2.errors.filter((e) => !conflict409.test(e))).toEqual([]);
  await page2.close();
});

test('cad:p1-doc-respawn a kernel stopped by its watchdog respawns and the part rebuilds by itself', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const loc = await partOpened(page);
  await expect(loc.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const frame = workspaceFrame(page);
  await addSolid(page);
  await addSolid(page, { circle: true, at: [10, 10, -5], size: [10, 40], op: 'cut' });
  const s1 = await waitFor(frame, (s) => saved(s) && s.features.length === 4 && s.bodies.length === 1, 'the cut to build');

  // A call stopped by its wall-clock watchdog: the worker is terminated and respawned.
  const err = await frame.evaluate(async () => {
    const s = (window as unknown as { __CAD__: { services: { kernel: any; doc: any } } }).__CAD__.services;
    const body = s.doc.state.get().rebuild.bodies[0];
    try {
      await s.kernel.call('tessellate', { id: body.shape, lin_defl: 0.0005, ang_defl_deg: 0.5 }, { timeoutMs: 1 });
      return null;
    } catch (e) {
      return { kind: (e as { kind: string }).kind, message: String((e as Error).message) };
    }
  });
  expect(err).toMatchObject({ kind: 'watchdog', message: expect.stringMatching(/^tessellate was stopped after \d+\.\d s$/) });
  const s2 = await waitFor(frame, (s) => s.respawns === 1 && s.seq > s1.seq && s.rebuild === 'done' && s.bodies.length === 1, 'the rebuild after the respawn');
  expect(s2.bodies[0].volume!).toBeCloseTo(s1.bodies[0].volume!, 6);
  // The user sees the same volume, and no kernel chip once it is back.
  const vol = page.frameLocator('#workspace-frame').locator('[data-chip="volume"] [data-volume-mm3]');
  expect(Number(await vol.getAttribute('data-volume-mm3'))).toBeCloseTo(s1.bodies[0].volume!, 6);
  await expect(page.frameLocator('#workspace-frame').locator('[data-cad-app]')).toHaveAttribute('data-kernel', 'ready');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// L3 (host API 1.6): the exit hook saves first, so Back with a save on its way no longer asks
// "Leave without saving?": the leave waits for the save (the header says so) and then goes.
test('cad:p1-doc-back-quick Back right after two edits loses neither: the exit waits for the save on its way (the header says so), then leaves', async ({ page, request }) => {
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const loc = await partOpened(page);
  await expect(loc.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const studyId = studyIdOf(page);
  const frame = workspaceFrame(page);
  await waitFor(frame, (s) => s.save === 'saved' && s.rebuild === 'done', 'the empty part');
  // The save is held at its commit, so it is still on its way when Back is clicked.
  const hold = await holdCommits(page);
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  // Two edits: two sketches.
  await addSketch(page);
  await addSketch(page, { circle: true, at: [50, 0], size: [20] });
  await expect.poll(() => hold.held()).toBe(1);
  const back = (await page.locator('#workspace-overlay [data-ws-back]').boundingBox())!;
  await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2, { steps: 10 });
  await page.mouse.down();
  await page.mouse.up();
  // The exit hook saves first: the header says so while the save waits, and nothing asks.
  await expect(page.locator('[data-ws-leave-status]')).toHaveText('Saving Part 1', { timeout: 10_000 });
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await hold.release();
  // The save landed, then the leave went on (an empty Part: nothing to add to the project).
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#modal-confirm')).toBeHidden();
  const model = await pluginFile(request, projectId, `studies/${studyId}/model.json`);
  expect(model!.doc.features.map((f: { name: string }) => f.name)).toEqual(['Sketch 1', 'Sketch 2']);
});
