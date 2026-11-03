// INSPECT > Find of fillets and drilled holes by their shape (S4, kernel API 8), as the person sees
// it on a STEP part made in the test (e2e/rounded-block.ts: R5 verticals, R2 round the top, four
// 6 mm holes and a 6/10 mm counterbore) and imported with FILE > Import STEP:
//   1. "Body 1 faces fillet <= 2 mm": "8 faces match ...", every row's type "fillet R2", and the
//      hint to check the lit faces;
//   2. Select all: the dock's chip reads 8 faces; the Delete key: Delete faces 1 is ok and the
//      volume chip shows the sharp reference's volume (the R2 round the top gone);
//   3. "Body 1 faces hole <= 6 mm": "4 faces match ... (4 holes)", rows "hole Ø6 through"; "<= 10
//      mm" adds the counterbore, "hole Ø6–Ø10 through" (5 holes); "fillet <= 1 mm" matches nothing
//      and says what the body has ("Body 1 has 4 fillet faces, R5");
//   4. "Body 1 edges fillet": the words "fillet filters faces: Body 1 faces fillet <= 2 mm";
//   5. with the page's face limits lowered (window.__CAD__.recognition: fillets and holes each have
//      one, kernel API 9), "Body 1 faces fillet": the words name Body 1, its faces and both limits,
//      the fillets' first, and say to select its faces in the view instead: no count line, no empty
//      list; with only the holes' limit under the body, fillets are found and a sized hole is
//      refused, the holes' limit named first; "fillet <= 1 mm" still says what the body has (its
//      fillets are searched without holes; review 2026-11-02: no test held it).
// Without S4, "fillet" is a bad selector and step 1 fails; step 5 fails if the body answers an
// empty list instead of the words.
// Review 2026-11-02:
//   3b. "edges of (Body 1 faces hole <= 6 mm)": "12 edges match ..." with no hole count (it said
//       "(0 holes)") and no hint about lit faces; "hole <= 5.95 mm" matches nothing (<= gets no 1 %:
//       it took the 6 mm holes);
//   6.  with a Fillet 1 in the Part, "Fillet 1 facs" gets the words at its column, not "a filter goes
//       after its scope, as in "Body 1 faces Fillet 1 facs"";
//   find-fillets-holes-words: on a Part in inches, a no-match gives the sizes in inches as Delete
//       faces' Add line does (it gave mm numbers with no unit), and a body with three round voids
//       has 1 drilled hole and 3 round hollows (it said "4 drilled holes").
// Kernel API 9 (two face limits, the real ones):
//   find-fillets-holes-limits: a STEP part of 2,739 faces (the L-block with every edge R2 and a
//       2,700-sided prism on it), between the holes' limit (2,600) and the fillets' (5,000): "Body 1
//       faces fillet <= 2 mm" finds its 30 fillet faces (one limit of 2,000 refused it), and "Body 1
//       faces hole <= 6 mm" is refused in words naming both limits, the holes' first; the Delete
//       faces panel's Holes up to Add says the same words and adds nothing.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseUrl, ensureCadOn, featureRowNamed, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';
import { importRoundedBlock, voidBlockInPage } from './rounded-block';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; recognition: { maxFilletFaces: number; maxHoleFaces: number } } };

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(
      () =>
        workspaceFrame(page).evaluate(() => {
          const st = (window as unknown as W).__CAD__.services.doc.state.get();
          return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const toolPanel = (frame: FrameLocator) => frame.locator('[data-cad-panel="tool"]');
const featurePanel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const chipVolumes = (frame: FrameLocator) => frame.locator('[data-chip="volume"] [data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

/** Find a query in the open Find panel. */
async function find(frame: FrameLocator, q: string) {
  const p = toolPanel(frame);
  await p.locator('[data-find-query]').fill(q);
  await p.locator('[data-find-query]').press('Enter');
}

test('cad:find-fillets-holes Find fillets and holes by size on an imported STEP part: rows, Select all, Delete to the sharp part, holes counted, refusals in words', async ({ page, request }) => {
  test.setTimeout(300_000);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const made = await importRoundedBlock(page, frame);
  await settled(page);
  await expect.poll(() => chipVolumes(frame)).toEqual([expect.closeTo(made.volume, 0)]);

  // 1. Fillets up to 2 mm: the 8 faces round the top, each "fillet R2", and the hint.
  await runCommand(frame, 'inspect.find');
  const panel = toolPanel(frame);
  await expect(panel.locator('[data-tool-panel="inspect.find"]')).toBeVisible();
  await find(frame, 'Body 1 faces fillet <= 2 mm');
  const count = panel.locator('[data-find-count]');
  await expect(count).toHaveText('8 faces match Body 1 faces fillet <= 2 mm', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row]')).toHaveCount(8);
  await expect(panel.locator('[data-find-row] [data-find-type]')).toHaveText(Array(8).fill('fillet R2'));
  await expect(panel.locator('[data-find-shape-hint]')).toHaveText('Found by their shape, whatever made them (chamfers are not fillets): check the lit faces before you delete them.');
  // The example chips teach both forms.
  await expect(panel.locator('[data-find-example="Body 1 faces fillet <= 2 mm"]')).toBeVisible();
  await expect(panel.locator('[data-find-example="Body 1 faces hole <= 6 mm"]')).toBeVisible();
  await shot(page, 'find-fillets');

  // 2. Select all, then the Delete key: Delete faces 1 is ok at the sharp part's volume.
  await panel.locator('[data-find-select-all]').click();
  await expect(frame.locator('[data-chip="selection"] [data-selection-count]')).toHaveText('8 faces');
  await page.keyboard.press('Delete');
  await expect(featurePanel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect(featurePanel(frame).locator('[data-run-reason]')).toHaveCount(0);
  await expect.poll(async () => Math.abs((await chipVolumes(frame))[0] / made.sharp - 1), { timeout: 30_000 }).toBeLessThan(1e-6);
  await featurePanel(frame).locator('[data-panel-done]').click();
  await expect(featurePanel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');

  // 3. Holes by size: whole holes, counted.
  await runCommand(frame, 'inspect.find');
  await find(frame, 'Body 1 faces hole <= 6 mm');
  await expect(count).toHaveText('4 faces match Body 1 faces hole <= 6 mm (4 holes)', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row] [data-find-type]')).toHaveText(Array(4).fill('hole Ø6 through'));
  await expect(panel.locator('[data-find-shape-hint]')).toBeVisible();
  await find(frame, 'Body 1 faces hole <= 10 mm');
  await expect(count).toHaveText('7 faces match Body 1 faces hole <= 10 mm (5 holes)', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row] [data-find-type]').filter({ hasText: 'hole Ø6–Ø10 through' })).toHaveCount(3);
  await shot(page, 'find-holes');
  // 3b. Their edges: no hole count, no hint about lit faces. A size just under the bores: nothing.
  await find(frame, 'edges of (Body 1 faces hole <= 6 mm)');
  await expect(count).toHaveText('12 edges match edges of (Body 1 faces hole <= 6 mm)', { timeout: 30_000 });
  await expect(count).not.toHaveAttribute('data-find-holes', /./);
  await expect(panel.locator('[data-find-shape-hint]')).toHaveCount(0);
  await find(frame, 'Body 1 faces hole <= 5.95 mm');
  await expect(panel.locator('[data-find-nothing]')).toHaveText('"Body 1 faces hole <= 5.95 mm" matches nothing: Body 1 has 5 drilled holes, Ø6 to Ø10.', { timeout: 30_000 });
  // A plain query: no hint, its type cell as before.
  await find(frame, 'Body 1 faces >Z');
  await expect(count).toHaveText('1 face match Body 1 faces >Z', { timeout: 30_000 });
  await expect(panel.locator('[data-find-shape-hint]')).toHaveCount(0);
  await expect(panel.locator('[data-find-row] [data-find-type]')).toHaveText(['plane']);
  // Nothing up to 1 mm: the words say what the body has (the R2s are gone; the R5 verticals stay).
  await find(frame, 'Body 1 faces fillet <= 1 mm');
  await expect(panel.locator('[data-find-nothing]')).toHaveText('"Body 1 faces fillet <= 1 mm" matches nothing: Body 1 has 4 fillet faces, R5.', { timeout: 30_000 });
  await expect(panel.locator('[data-find-row]')).toHaveCount(0);

  // 4. Edges: fillet filters faces.
  await find(frame, 'Body 1 edges fillet');
  await expect(panel.locator('[data-run-reason]')).toContainText('fillet filters faces: Body 1 faces fillet <= 2 mm', { timeout: 30_000 });
  await expect(count).toHaveCount(0);

  // 5. A body over the face limits (the page's limits lowered): words naming both, never an empty list.
  const faces = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces as number);
  await workspaceFrame(page).evaluate(() => {
    Object.assign((window as unknown as W).__CAD__.recognition, { maxFilletFaces: 10, maxHoleFaces: 8 });
  });
  try {
    await find(frame, 'Body 1 faces fillet');
    await expect(panel.locator('[data-run-reason]')).toHaveText(`Body 1 has ${faces} faces: fillets are found on bodies of up to 10 faces and holes on bodies of up to 8 faces. Select its faces in the view instead.`, { timeout: 30_000 });
    await expect(count).toHaveCount(0);
    await expect(panel.locator('[data-find-row]')).toHaveCount(0);
    await shot(page, 'find-over-limit');
    // Only the holes' limit under the body: fillets are found, a sized hole is refused (the holes' limit first).
    await workspaceFrame(page).evaluate(() => {
      (window as unknown as W).__CAD__.recognition.maxFilletFaces = 5000;
    });
    await find(frame, 'Body 1 faces fillet');
    await expect(count).toHaveText('4 faces match Body 1 faces fillet', { timeout: 30_000 });
    // A fillet query that matches nothing: what Body 1 has, as within both limits.
    await find(frame, 'Body 1 faces fillet <= 1 mm');
    await expect(panel.locator('[data-find-nothing]')).toHaveText('"Body 1 faces fillet <= 1 mm" matches nothing: Body 1 has 4 fillet faces, R5.', { timeout: 30_000 });
    await expect(panel.locator('[data-find-row]')).toHaveCount(0);
    await find(frame, 'Body 1 faces hole <= 6 mm');
    await expect(panel.locator('[data-run-reason]')).toHaveText(`Body 1 has ${faces} faces: holes are found on bodies of up to 8 faces and fillets on bodies of up to 5,000 faces. Select its faces in the view instead.`, { timeout: 30_000 });
    await expect(count).toHaveCount(0);
    await expect(panel.locator('[data-find-row]')).toHaveCount(0);
  } finally {
    await workspaceFrame(page).evaluate(() => {
      Object.assign((window as unknown as W).__CAD__.recognition, { maxFilletFaces: 5000, maxHoleFaces: 2600 });
    });
  }

  // 6. A Fillet 1 (one hole's two rims, R0.5), then "Fillet 1 facs": the words at its column, not the bare filter's.
  await panel.locator('[data-panel-done]').click();
  await workspaceFrame(page).evaluate(async () => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true })).result;
    const wall = t.faces.find((f: { type: string; radius?: number; centroid?: number[] }) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 3) < 1e-6 && Math.abs((f.centroid?.[0] ?? 0) - 15) < 1e-6 && Math.abs((f.centroid?.[1] ?? 0) - 12) < 1e-6);
    s.selection.set((st: object) => ({ ...st, items: [{ kind: 'face', body: b.id, index: wall.i }] }));
  });
  await runCommand(frame, 'modify.fillet');
  await expect(featurePanel(frame).locator('[data-panel-title]')).toHaveText('Fillet 1');
  const radius = featurePanel(frame).locator('.nui[data-field="radius"] input');
  await radius.fill('0.5');
  await radius.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
  await featurePanel(frame).locator('[data-panel-done]').click();
  await expect(featurePanel(frame)).toHaveCount(0);
  await runCommand(frame, 'inspect.find');
  await find(frame, 'Fillet 1 facs');
  const slip = panel.locator('[data-run-reason]');
  await expect(slip).toContainText('(column 10 of "Fillet 1 facs").', { timeout: 30_000 });
  await expect(slip).not.toContainText('a filter goes after its scope');
  await find(frame, 'fillet <= 2 mm');
  await expect(slip).toContainText('a filter goes after its scope, as in "Body 1 faces fillet <= 2 mm"', { timeout: 30_000 });
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen.csp, 'CSP violations').toEqual([]);
});

test('cad:find-fillets-holes-words on a Part in inches a no-match says the sizes in inches; a body with three round voids has 1 drilled hole and 3 round hollows, not 4 drilled holes', async ({ page, request }) => {
  test.setTimeout(300_000);
  const seen = await watchPage(page);
  await ensureCadOn(request);
  const r = await request.post(`${baseUrl()}/api/project`, { data: { title: `CAD e2e ${Date.now()}`, category: 'Other', units: 'Imperial' } });
  expect(r.ok(), await r.text()).toBe(true);
  await openProject(page, String((await r.json()).id));
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await importRoundedBlock(page, frame);
  await settled(page);

  // Inches: the sizes in the Part's unit, as the type cells and Delete faces' Add line give them (it said "R2 to R5").
  await runCommand(frame, 'inspect.find');
  const panel = toolPanel(frame);
  await find(frame, 'Body 1 faces fillet <= 1 mm');
  await expect(panel.locator('[data-find-nothing]')).toHaveText('"Body 1 faces fillet <= 1 mm" matches nothing: Body 1 has 12 fillet faces, R0.07874 to R0.1969 in.', { timeout: 30_000 });
  await find(frame, 'Body 1 faces hole <= 1 mm');
  await expect(panel.locator('[data-find-nothing]')).toHaveText('"Body 1 faces hole <= 1 mm" matches nothing: Body 1 has 5 drilled holes, Ø0.2362 to Ø0.3937 in.', { timeout: 30_000 });
  await find(frame, 'Body 1 faces fillet <= 2 mm');
  await expect(panel.locator('[data-find-row] [data-find-type]').first()).toHaveText(/^fillet R0\.0787\d* in$/, { timeout: 30_000 });
  await shot(page, 'find-words-inches');
  await panel.locator('[data-panel-done]').click();

  // A second body: a box with one 6 mm hole and three round voids inside (recognition reads each void as a hole with no cylinder).
  await importRoundedBlock(page, frame, voidBlockInPage);
  await settled(page);
  const names = await workspaceFrame(page).evaluate(() => {
    const st = (window as unknown as W).__CAD__.services.doc.state.get();
    return st.rebuild.bodies.map((b: { id: string; name?: string }) => st.doc.bodies[b.id]?.name ?? b.name) as string[];
  });
  expect(names).toHaveLength(2);
  const second = names[1];
  await runCommand(frame, 'inspect.find');
  const q = `${second} faces hole <= 1 mm`;
  await find(frame, q);
  await expect(panel.locator('[data-find-nothing]')).toHaveText(`"${q}" matches nothing: ${second} has 1 drilled hole, Ø0.2362 in, and 3 round hollows with no cylinder, which no size matches.`, { timeout: 30_000 });
  await shot(page, 'find-words-voids');
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen.csp, 'CSP violations').toEqual([]);
});

test('cad:find-fillets-holes-limits on a STEP part of 2,739 faces (between the two face limits) Find finds its fillets and refuses a sized hole in words naming both limits, as Add by size does', async ({ page, request }) => {
  test.setTimeout(300_000);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  // Made in code with the app's kernel: the L-block with every edge R2 and a 2,700-sided prism standing on its top (one solid), as STEP.
  const b64 = await workspaceFrame(page).evaluate(async () => {
    const k = (window as unknown as W).__CAD__.services.kernel;
    const c = async (op: string, p: Record<string, unknown>) => (await k.call(op, p)).result;
    const box = async (d: number[], o: number[]) => (await c('box', { dx: d[0], dy: d[1], dz: d[2], origin: o })).id;
    const L = (await c('boolean', { op: 'cut', targets: [await box([60, 40, 20], [0, 0, 0])], tools: [await box([31, 42, 11], [30, -1, 10])] })).id;
    const es = (await c('topo', { id: L, faces: 'none', edges: 'all', vertices: 'none' })).edges.map((e: { i: number }) => e.i);
    const fl = (await c('fillet', { id: L, edges: es, r: 2 })).id;
    const n = 2700;
    const pt = (i: number) => [15 + 8 * Math.cos((2 * Math.PI * i) / n), 20 + 8 * Math.sin((2 * Math.PI * i) / n)];
    const loop = Array.from({ length: n }, (_, i) => ({ id: `l${i}`, kind: 'line', a: pt(i), b: pt((i + 1) % n) }));
    const prism = (await c('extrude', { profile: { plane: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] }, loops: [loop] }, extent: { kind: 'blind', d: 10 } })).id;
    const both = (await c('boolean', { op: 'fuse', targets: [fl], tools: [prism] })).id;
    const step = (await k.call('export_step', { shapes: [{ id: both, name: 'Body 1' }], schema: 'AP214' })).buffers.step as ArrayBuffer;
    let bin = '';
    const u8 = new Uint8Array(step);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  const file = join(tmpdir(), `cad-e2e-limits-${process.pid}-${Date.now()}.step`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  const chooser = page.waitForEvent('filechooser');
  await frame.locator('[data-cad-toolbar] [data-command="file.import-step"]').click();
  await (await chooser).setFiles(file);
  await expect(featurePanel(frame).locator('[data-feature-panel="import"]')).toBeVisible();
  await expect(featurePanel(frame).locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await featurePanel(frame).locator('[data-panel-done]').click();
  await expect(featurePanel(frame)).toHaveCount(0);
  await settled(page);
  const faces = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces as number);
  expect(faces).toBe(2739);

  // Fillets: found (within the fillets' 5,000), every one R2.
  await runCommand(frame, 'inspect.find');
  const panel = toolPanel(frame);
  await find(frame, 'Body 1 faces fillet <= 2 mm');
  const count = panel.locator('[data-find-count]');
  await expect(count).toHaveText('30 faces match Body 1 faces fillet <= 2 mm', { timeout: 60_000 });
  await expect(panel.locator('[data-find-row] [data-find-type]').first()).toHaveText('fillet R2');
  await expect(panel.locator('[data-run-reason]')).toHaveCount(0);
  await shot(page, 'find-limits-fillets');
  // A sized hole: refused (over the holes' 2,600), both limits named, the holes' first.
  const words = 'Body 1 has 2,739 faces: holes are found on bodies of up to 2,600 faces and fillets on bodies of up to 5,000 faces. Select its faces in the view instead.';
  await find(frame, 'Body 1 faces hole <= 6 mm');
  await expect(panel.locator('[data-run-reason]')).toHaveText(words, { timeout: 60_000 });
  await expect(count).toHaveCount(0);
  await expect(panel.locator('[data-find-row]')).toHaveCount(0);
  await shot(page, 'find-limits');
  await panel.locator('[data-panel-done]').click();

  // Delete faces with nothing selected, Holes up to Ø 6, Add: the same words, nothing added.
  await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.selection.set((st: object) => ({ ...st, items: [] })));
  await runCommand(frame, 'modify.delete-faces');
  await expect(featurePanel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  const holes = featurePanel(frame).locator('.nui[data-field="add-holes"] input');
  await holes.fill('6');
  await featurePanel(frame).locator('[data-delete-add="holes"]').click();
  await expect(featurePanel(frame).locator('[data-delete-added]')).toHaveText(words, { timeout: 60_000 });
  await expect(featurePanel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(0);
  await shot(page, 'find-limits-add');
  // The page's own limits, untouched: the real ones said all that.
  expect(await workspaceFrame(page).evaluate(() => ({ ...(window as unknown as W).__CAD__.recognition }))).toEqual({ maxFilletFaces: 5000, maxHoleFaces: 2600 });
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen.csp, 'CSP violations').toEqual([]);
});
