// The SD pass (decision 2026-10-01, "fully sketch-driven"): no one-click solid
// primitives, and Enclosure (CFD PREP) as the only box or cylinder, in the real
// host frame with the real kernel.
//   - The toolbar has no Box or Cylinder: SOLID is Extrude; CFD PREP comes after
//     the modelling groups; Enclosure is greyed with "Add or import a body
//     first" until a body exists (a sketch is not one).
//   - A block drawn with the mouse and keyboard (Sketch, R, typed size, Extrude)
//     -> Enclosure: Zero padding by default, exactly the block's exact bounding
//     box; Percent and Fixed; dragging the +X arrow adds that much volume;
//     editing the block grows the enclosure and keeps the dragged side; a
//     Cylinder about Z; then the fluid as a separate Combine Cut with Keep tools
//     (enclosure minus part, analytic).
//   - Daniel's Vortex (CAD_E2E_VORTEX_STEP): Enclosure, Fixed 100 mm, then
//     Combine Cut with Keep tools: 213,286,252.06 mm³ within 1e-6.
//   - A Part saved with a Box and a Cylinder (P1) opens: each row is red with
//     "This part uses a removed feature (Box 1)", Edit says the
//     same, Delete removes it; nothing crashes and nothing is dropped silently.
// window.__CAD__ is used only to project model points to screen pixels and to
// read the exact figures the chips round.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSolid, baseUrl, drawBlock, modelOnPage, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame, runCommand, groupCommandLabels } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = JSON.parse(readFileSync(resolve(HERE, '..', 'fixtures', 'kernel', 'reference.json'), 'utf8'));
const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';
const SHOTS = process.env.CAD_E2E_SHOTS || '';

type V3 = [number, number, number];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, projectId };
}

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${esc(name)}$`) }) });
const bodiesLabel = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl');
const bodyRows = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-body-row]');
const sideField = (frame: FrameLocator, key: string) => panel(frame).locator(`.nui[data-field="side-${key}"] input`);
const sizeLine = (frame: FrameLocator) => panel(frame).locator('[data-enclosure-size]');
const expectSaved = (frame: FrameLocator) => expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 30_000 });
const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

/** A body's exact volume (mm³), by name, once the rebuild measured it. */
async function volumeOf(page: Page, name: string): Promise<number> {
  let v = NaN;
  await expect
    .poll(async () => {
      v = await cad<number>(page, ((n: string) => {
        const b = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { status: string; bodies: { name: string; volume: number | null }[] } } } } } } }).__CAD__.services.doc.state.get().rebuild;
        const body = b.status === 'done' ? b.bodies.find((x) => x.name === n) : undefined;
        return body?.volume ?? NaN;
      }) as never, name);
      return Number.isFinite(v);
    }, { timeout: 60_000 })
    .toBe(true);
  return v;
}

/** The volume of `name` is `mm3` within `rel` (polled: it follows a rebuild). */
async function expectVolume(page: Page, name: string, mm3: number, rel = 1e-9, timeout = 60_000) {
  await expect
    .poll(async () => {
      const v = await volumeOf(page, name).catch(() => NaN);
      return Math.abs(v / mm3 - 1) <= rel ? 'ok' : `${v} (want ${mm3} within ${rel})`;
    }, { timeout })
    .toBe('ok');
}

async function setField(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel(frame).locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

async function still(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } } } } } }).__CAD__.services.viewport.get().handle.state.get().animating) as never)).toBe(false);
}

/**
 * Drag the arrow that starts at `base` and points along `dir` by `mm` (model mm): taken
 * `grabPx` px along its shaft, released over the exact projection of grab + dir * mm. The
 * camera is perspective, so a millimetre is not the same number of pixels all along the arrow:
 * both ends are projected (SD review round 1: a linear "px per mm" drag of 25 mm stored 22.7).
 * The moves between run along the straight screen line, which is the arrow's own line.
 */
async function dragArrow(page: Page, base: V3, dir: V3, mm: number, { grabPx = 30, steps = 10 } = {}) {
  await still(page);
  const px = await cad<number>(page, ((p: V3) => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { pixelSize(p: V3): number } } } } } }).__CAD__.services.viewport.get().handle.pixelSize(p)) as never, base);
  const g: V3 = [base[0] + dir[0] * grabPx * px, base[1] + dir[1] * grabPx * px, base[2] + dir[2] * grabPx * px];
  const e: V3 = [g[0] + dir[0] * mm, g[1] + dir[1] * mm, g[2] + dir[2] * mm];
  const a = await modelOnPage(page, g);
  const b = await modelOnPage(page, e);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps);
  await page.mouse.up();
}

// ---------------------------------------------------------------- 1. no one-click solids; Enclosure greyed

test('cad:sd-no-one-click-solids the toolbar has no Box or Cylinder; CFD PREP (Enclosure) comes after the modelling groups, greyed "Add or import a body first" until a body exists', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const labels = await tb(frame).locator('.tb-group-label').allTextContents();
  expect(labels).toEqual(['SKETCH', 'SOLID', 'PATTERN', 'MODIFY', 'CONSTRUCT', 'CFD PREP', 'INSPECT', 'FILE', 'VIEW', 'SCALE MODELS', 'EDIT']);
  expect(await groupCommandLabels(frame, 'solid')).toEqual(['Extrude', 'Revolve', 'Sweep', 'Loft']);
  await expect(tb(frame).locator('[data-group="cfd"] .tb-txt')).toHaveText(['Enclosure']);
  await expect(tb(frame).locator('[data-command="solid.box"], [data-command="solid.cylinder"]')).toHaveCount(0);
  const enc = tb(frame).locator('[data-command="cfd.enclosure"]');
  await expect(enc).toHaveAttribute('aria-disabled', 'true');
  await expect(enc).toHaveAttribute('data-disabled-reason', 'Add or import a body first');
  await enc.hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Add or import a body first');
  await enc.click({ force: true });
  await expect(panel(frame)).toHaveCount(0);
  await shot(page, 'sd-toolbar-enclosure-greyed');
  // A sketch alone is not a body; the extruded block is.
  await page.mouse.move(5, 5);
  await addSolid(page, { size: [20, 20, 20] });
  await expect(bodiesLabel(frame)).toHaveText('Bodies (1)');
  await expect(enc).not.toHaveAttribute('aria-disabled', 'true');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 2. Enclosure around a sketched block

test('cad:sd-enclosure-box a drawn block -> Enclosure: Zero padding is its exact bounding box; Percent; Fixed; dragging +X adds that much volume; editing the block grows it and keeps +X; a Cylinder about Z; then Combine Cut with Keep tools is the fluid', { tag: '@smoke' }, async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  // 40 x 30 x 20, drawn as a user draws it.
  await drawBlock(page, frame, 40, 30, 20);
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1', 'Extrude 1']);
  await expectVolume(page, 'Body 1', 24_000);

  // Enclosure: a new body, tight to the part. No Operation: it only makes a body.
  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Enclosure 1');
  await expect(p.locator('[data-field-row="op"]')).toHaveCount(0);
  await expect(p.locator('[data-field="shape"] select')).toHaveValue('box');
  await expect(p.locator('[data-field="padding"] select')).toHaveValue('zero');
  await expect(p.locator('[data-pick-field="bodies"] [data-pick-empty]')).toHaveText('All solid bodies (1): Body 1');
  for (const k of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) await expect(sideField(frame, k)).toHaveValue('0');
  await expect(sizeLine(frame)).toHaveText('Size: 40 mm × 30 mm × 20 mm · 24,000 mm³');
  await expect(featureRow(frame, 'Enclosure 1')).toHaveAttribute('data-state', 'ok');
  await expect(bodiesLabel(frame)).toHaveText('Bodies (2)');
  await expectVolume(page, 'Enclosure 1', 24_000);
  // Exactly the block's exact bounding box (the kernel's exact one, not the padded fast one).
  const boxes = await cad<{ out: number[]; part: number[] }>(page, (async () => {
    const s = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { bodies: { id: string; name: string }[]; outputs: Record<string, { type: string; bbox?: number[] }> } } }; measure(id: string): Promise<{ bbox: number[] }> } } } }).__CAD__.services.doc;
    const r = s.state.get().rebuild;
    const out = Object.values(r.outputs).find((o) => o.type === 'enclosure')!.bbox!;
    const part = (await s.measure(r.bodies.find((b) => b.name === 'Body 1')!.id)).bbox;
    return { out, part };
  }) as never);
  expect(boxes.out).toEqual(boxes.part);
  expect(boxes.out.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 0, 40, 30, 20]);
  await shot(page, 'sd-enclosure-zero');

  // Percent of the part's size in each direction: 10 % -> 4, 3, 2 mm a side.
  await p.locator('[data-field="padding"] select').selectOption('percent');
  await expect(p.locator('.nui[data-field="percent"] input')).toHaveValue('10');
  await expect(sizeLine(frame)).toHaveText('Size: 48 mm × 36 mm × 24 mm · 41,472 mm³');
  await expect(sideField(frame, 'px')).toHaveValue('4');
  await expectVolume(page, 'Enclosure 1', 48 * 36 * 24);
  // Fixed: 10 mm a side.
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  await expect(p.locator('.nui[data-field="distance"] input')).toHaveValue('10');
  await expect(sizeLine(frame)).toHaveText('Size: 60 mm × 50 mm × 40 mm · 120,000 mm³');
  await expectVolume(page, 'Enclosure 1', 120_000);

  // Drag +X out by 25 mm (the arrow starts on the +X face, at (50, 15, 10)): that side alone moves.
  await dragArrow(page, [50, 15, 10], [1, 0, 0], 25);
  await expect(p.locator('.cad-enclosure-side[data-side="+x"]')).toHaveAttribute('data-side-source', 'set');
  const px = Number(await sideField(frame, 'px').inputValue());
  expect(Math.abs(px - 35), `+X dragged to ${px} mm`).toBeLessThan(0.3);
  // Exactly that much more air: (px - 10) x 50 x 40.
  await expectVolume(page, 'Enclosure 1', 120_000 + (px - 10) * 50 * 40);
  for (const k of ['nx', 'py', 'ny', 'pz', 'nz']) await expect(sideField(frame, k)).toHaveValue('10');
  await shot(page, 'sd-enclosure-arrows');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);

  // The block gets taller (20 -> 30): the enclosure follows, +X keeps its own value.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  await expect(p.locator('[data-panel-title]')).toHaveText('Extrude 1');
  await setField(frame, 'distance', '30');
  await p.locator('[data-panel-done]').click();
  await expectVolume(page, 'Enclosure 1', (60 + px - 10) * 50 * 50);
  await featureRow(frame, 'Enclosure 1').locator('> .tree-row').dblclick();
  await expect(sizeLine(frame)).toContainText('× 50 mm × 50 mm');
  await expect(sideField(frame, 'px')).toHaveValue(String(px));

  // A Cylinder about Z: through the block's corners (r0 = 25) plus 10, from z = -10 to 40.
  await p.locator('[data-field="shape"] select').selectOption('cylinder');
  await expect(p.locator('[data-field="axis"] select')).toHaveValue('origin:z');
  for (const k of ['radius', 'top', 'bottom']) await expect(sideField(frame, k)).toHaveValue('10');
  const cyl = Math.PI * 35 * 35 * 50;
  await expectVolume(page, 'Enclosure 1', cyl);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);

  // The fluid: a separate Combine, Cut, the enclosure minus the block, keeping the block.
  await runCommand(frame, 'modify.combine');
  await expect(p.locator('[data-feature-panel="combine"]')).toBeVisible();
  await p.locator('[data-field="op"] select').selectOption('cut');
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await expect(bodyRows(frame).locator('.cad-body-name')).toHaveText(['Body 1', 'Enclosure 1']);
  await p.locator('[data-pick-list="targets"]').click();
  await bodyRows(frame).nth(1).locator('.tree-row').first().click();
  // An Enclosure's body as the target turns Keep the tool bodies on (SD review round 1).
  await expect(p.locator('[data-switch="keep-tools"] input')).toBeChecked();
  await p.locator('[data-pick-list="tools"]').click();
  await bodyRows(frame).nth(0).locator('.tree-row').first().click();
  await expect(p.locator('[data-switch="keep-tools"] input')).toBeChecked();
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  await expect(bodiesLabel(frame)).toHaveText('Bodies (2)');
  await expectVolume(page, 'Enclosure 1', cyl - 40 * 30 * 30);
  await expectVolume(page, 'Body 1', 36_000);
  await expectSaved(frame);
  await shot(page, 'sd-enclosure-fluid');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 3. Daniel's Vortex

test("cad:sd-enclosure-vortex Daniel's Vortex: Enclosure, Fixed 100 mm, is the reference fluid box; Combine Cut with Keep tools is 213,286,252.06 mm³ within 1e-6", async ({ page, request }) => {
  test.setTimeout(600_000);
  test.skip(!VORTEX, "needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step");
  expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP is set but there is no file at ${VORTEX}`).toBe(true);
  const { seen, frame } = await freshPart(page, request);
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(VORTEX);
  const p = panel(frame);
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  const name = REF.vortex.import.name as string;
  await expectVolume(page, name, REF.vortex.import.volume, 1e-6);

  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  await expect(p.locator('[data-panel-title]')).toHaveText('Enclosure 1');
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  await setField(frame, 'distance', '100');
  const fb = REF.fluid_box;
  await expect(sizeLine(frame)).toHaveText(/^Size: 504\.8 mm × 504\.8 mm × 1012\.8 mm · /);
  await expectVolume(page, 'Enclosure 1', fb.V_box_native, 1e-9);
  await shot(page, 'sd-enclosure-vortex');
  await p.locator('[data-panel-done]').click();

  await runCommand(frame, 'modify.combine');
  await p.locator('[data-field="op"] select').selectOption('cut');
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await expect(bodyRows(frame).locator('.cad-body-name')).toHaveText([name, 'Enclosure 1']);
  await p.locator('[data-pick-list="targets"]').click();
  await bodyRows(frame).nth(1).locator('.tree-row').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  await bodyRows(frame).nth(0).locator('.tree-row').first().click();
  await expect(p.locator('[data-switch="keep-tools"] input')).toBeChecked();
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok', { timeout: 240_000 });
  await expectVolume(page, 'Enclosure 1', REF.cut_fluid.volume, 1e-6, 240_000);
  await expect(bodyRows(frame).locator('.cad-body-name')).toHaveText([name, 'Enclosure 1']);
  await shot(page, 'sd-enclosure-vortex-fluid');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 4. a Part with removed features

test('cad:sd-removed-feature a Part saved with a Box and a Cylinder opens: each row is red "This part uses a removed feature (Box 1)"; Edit says so; Delete removes it', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  // A Part as P1 left it (only Box and Cylinder existed then): the pointer says "data".
  const created = await (await request.post(`${baseUrl()}/api/plugin-studies/create`, { data: { project_id: projectId, plugin: 'cad', kind: 'part', title: 'Old part' } })).json();
  const studyId = created.study.id;
  const rel = `studies/${studyId}/model.json`;
  const rec = await (await request.get(`${baseUrl()}/api/plugin-studies/get?${new URLSearchParams({ project_id: projectId, plugin: 'cad', study_id: studyId })}`)).json();
  const upd = await request.post(`${baseUrl()}/api/plugin-studies/update`, { data: { project_id: projectId, plugin: 'cad', study_id: studyId, rev: rec.study.rev, patch: { doc: { rel, schema: 1, store: 'data', view: `studies/${studyId}/view.json` } } } });
  expect(upd.ok(), await upd.text()).toBe(true);
  const w = await request.post(`${baseUrl()}/api/plugin-data/write`, {
    data: {
      project_id: projectId,
      plugin: 'cad',
      rel,
      doc: {
        format: 'magnusim-cad/model',
        etag: '3.s_old',
        saved_at: '2026-09-30T20:00:00.000Z',
        doc: {
          schema: 1,
          units: { length: 'mm', angle: 'deg' },
          params: [],
          bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } },
          features: [
            { id: 'f_box', type: 'box', name: 'Box 1', op: 'new', creates: 'b_1', scope: [], origin: ['0 mm', '0 mm', '0 mm'], size: ['20 mm', '20 mm', '20 mm'] },
            { id: 'f_cyl', type: 'cylinder', name: 'Cylinder 1', op: 'cut', creates: null, scope: [], origin: ['10 mm', '10 mm', '-5 mm'], axis: 'origin:z', diameter: '10 mm', height: '40 mm' },
          ],
          meta: { created_at: '2026-09-30T19:00:00.000Z', written_by: '0.1.0' },
        },
      },
    },
  });
  expect(w.ok(), await w.text()).toBe(true);

  await openProject(page, projectId);
  const row = page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: 'Old part' }) });
  const frame = await openPart(page, row);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  // Both rows are there, in red, saying why; nothing was dropped and nothing builds them.
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Box 1', 'Cylinder 1']);
  for (const n of ['Box 1', 'Cylinder 1']) {
    await expect(featureRow(frame, n)).toHaveAttribute('data-state', 'error');
    await expect(featureRow(frame, n).locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', `What's wrong: This part uses a removed feature (${n})`);
  }
  await expect(bodiesLabel(frame)).toHaveText('Bodies (0)');
  await shot(page, 'sd-removed-features');
  // Edit is offered disabled with the reason; a double-click says the same.
  await featureRow(frame, 'Box 1').locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu.locator('[data-menu-item="edit"]')).toHaveAttribute('aria-disabled', 'true');
  await menu.locator('[data-menu-item="edit"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('This part uses a removed feature (Box 1). Solids come from sketches now: delete it, then sketch the shape and extrude it');
  await expect(menu.locator('[data-menu-item="delete"]')).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await featureRow(frame, 'Cylinder 1').locator('> .tree-row').dblclick();
  await expect(page.locator('#workspace-overlay [data-ws-toast]')).toHaveText(/^This part uses a removed feature \(Cylinder 1\)\. Solids come from sketches now: delete it, then sketch the shape and extrude it\./);
  await expect(panel(frame)).toHaveCount(0);
  // Delete removes them (one at a time, each undoable); then the Part works as any other.
  await featureRow(frame, 'Cylinder 1').locator('> .tree-row').click({ button: 'right' });
  await menu.locator('[data-menu-item="delete"]').click();
  await featureRow(frame, 'Box 1').locator('> .tree-row').click({ button: 'right' });
  await menu.locator('[data-menu-item="delete"]').click();
  await expect(frame.locator('[data-tree-empty="history"]')).toHaveText('No features yet');
  await addSolid(page, { size: [20, 20, 20] });
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1', 'Extrude 1']);
  await expectVolume(page, 'Body 1', 8000);
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
