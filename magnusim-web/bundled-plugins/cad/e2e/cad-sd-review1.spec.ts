// SD pass, review round 1: one test per finding, in the real host frame with the
// real kernel (the blockers first, then the polish and the coverage it asked for).
//   - side-past-part: a side typed or dragged past the part's far side is refused
//     (the reason under the field, the arrow stops there); a side into the part
//     is allowed with an amber note; a cylinder's Radius into the part too.
//   - cylinder-sides: a cylinder about Z, X and Y (its ends "+X end" / "−X end"
//     about X), its Radius, Top and Bottom arrows, "Use padding", Percent.
//   - two-bodies: the union of two bodies' boxes, bodies picked in the browser,
//     "All solid bodies" in the field; the fluid (Combine Cut, Keep tools on by
//     default) follows an edit of the Enclosure; its panel says why it has no Delete.
//   - removed-box-used: a P1 Box whose body a Combine uses: Delete is refused with
//     the reason, then works in order.
//   - panel-layout: "Use padding" does not move the field, the Percent field lines
//     up and its "%" stays in line under an error, Padding keeps the sides set,
//     and the CAD panels are the core's 360 px.
//   - see-through: the Enclosure body is translucent: the part inside shows, a
//     click on it picks the part, and at Zero padding no patches fight on the
//     shared faces; Measure names its faces by side.
//   - sketch-pick: Sketch with nothing selected waits for a plane or a flat face
//     (the planes shown, a prompt over the view), as SolidWorks and Fusion do.
// window.__CAD__ is used to project model points to screen pixels and to read
// exact figures (volumes, arrows' places) the panel rounds.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, baseUrl, modelOnPage, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

type V3 = [number, number, number];
type RGB = [number, number, number];

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
const bodyRows = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-body-row]');
const sideField = (frame: FrameLocator, key: string) => panel(frame).locator(`.nui[data-field="side-${key}"] input`);
const sideError = (frame: FrameLocator, key: string) => panel(frame).locator(`.nui[data-field="side-${key}"] [data-nui-error]`);
// One note names every side into the part (SD review round 2): data-side-note lists their keys.
const sideNote = (frame: FrameLocator, key: string) => panel(frame).locator(`[data-side-note~="${key}"]`);
const sizeLine = (frame: FrameLocator) => panel(frame).locator('[data-enclosure-size]');
const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

type CadWin = {
  __CAD__: {
    services: {
      doc: { state: { get(): { doc: { features: { id: string; type: string; name: string }[] }; rebuild: { status: string; bodies: { id: string; name: string; volume: number | null }[]; outputs: Record<string, { type: string; box?: { min: V3; max: V3 }; cylinder?: { base: V3; axis: V3; r: number; h: number }; pad: Record<string, number> }> } } } };
      viewport: { get(): { handle: { pixelSize(p: V3): number; state: { get(): { animating: boolean } } } } };
      selection: { get(): { items: { kind: string; body?: string; index?: number }[] } };
    };
  };
};

/** A body's exact volume (mm³), by name, once the rebuild measured it. */
async function volumeOf(page: Page, name: string): Promise<number> {
  return cad<number>(page, ((n: string) => {
    const r = (window as unknown as CadWin).__CAD__.services.doc.state.get().rebuild;
    const body = r.status === 'done' ? r.bodies.find((x) => x.name === n) : undefined;
    return body?.volume ?? NaN;
  }) as never, name);
}

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
}

async function still(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.state.get().animating) as never)).toBe(false);
}

async function settled(page: Page) {
  await expect.poll(() => cad<string>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().rebuild.status) as never)).toBe('done');
  await still(page);
}

/** Where the open Enclosure's arrow for `side` starts and the way it points (as handles.ts places it). */
async function arrowOf(page: Page, side: string): Promise<{ base: V3; dir: V3 }> {
  return cad(page, ((sd: string) => {
    const st = (window as unknown as CadWin).__CAD__.services.doc.state.get();
    const f = st.doc.features.filter((x) => x.type === 'enclosure').pop()!;
    const o = st.rebuild.outputs[f.id];
    if (o.box) {
      const k = sd[1] === 'x' ? 0 : sd[1] === 'y' ? 1 : 2;
      const plus = sd[0] === '+';
      const base = [0, 1, 2].map((i) => (o.box!.min[i] + o.box!.max[i]) / 2) as V3;
      base[k] = plus ? o.box.max[k] : o.box.min[k];
      const dir: V3 = [0, 0, 0];
      dir[k] = plus ? 1 : -1;
      return { base, dir };
    }
    const cy = o.cylinder!;
    const a = cy.axis;
    const k = a[0] ? 0 : a[1] ? 1 : 2;
    const cross: V3 = [0, 0, 0];
    cross[k === 0 ? 1 : 0] = 1;
    const mid = [0, 1, 2].map((i) => cy.base[i] + (a[i] * cy.h) / 2);
    if (sd === 'radius') return { base: mid.map((v, i) => v + cross[i] * cy.r) as V3, dir: cross };
    if (sd === 'top') return { base: [0, 1, 2].map((i) => cy.base[i] + a[i] * cy.h) as V3, dir: [a[0], a[1], a[2]] as V3 };
    return { base: [cy.base[0], cy.base[1], cy.base[2]] as V3, dir: [-a[0], -a[1], -a[2]] as V3 };
  }) as never, side);
}

/**
 * Drag the open Enclosure's `side` arrow by `mm` (model mm, negative = inwards): taken 30 px
 * along its shaft, released over the exact projection of grab + dir * mm (perspective: both ends
 * projected). `during` runs with the button still down, after the last move.
 */
async function dragSide(page: Page, side: string, mm: number, during?: () => Promise<void>) {
  await settled(page);
  const { base, dir } = await arrowOf(page, side);
  const px = await cad<number>(page, ((p: V3) => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.pixelSize(p)) as never, base);
  const g: V3 = [base[0] + dir[0] * 30 * px, base[1] + dir[1] * 30 * px, base[2] + dir[2] * 30 * px];
  const e: V3 = [g[0] + dir[0] * mm, g[1] + dir[1] * mm, g[2] + dir[2] * mm];
  const a = await modelOnPage(page, g);
  const b = await modelOnPage(page, e);
  await page.mouse.move(a[0], a[1], { steps: 2 });
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a[0] + ((b[0] - a[0]) * i) / 12, a[1] + ((b[1] - a[1]) * i) / 12);
  if (during) await during();
  await page.mouse.up();
  await settled(page);
}

async function pixels(page: Page, pts: [number, number][]): Promise<RGB[]> {
  const img = PNG.decode(await page.screenshot());
  const dpr = img.width / (page.viewportSize()!.width || img.width);
  return pts.map(([x, y]) => {
    const p = PNG.at(img, Math.round(x * dpr), Math.round(y * dpr));
    return [p[0], p[1], p[2]];
  });
}
const dist = (a: RGB, b: RGB) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

async function openEnclosure(frame: FrameLocator) {
  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText(/^Enclosure \d+$/);
}

async function openBodies(frame: FrameLocator) {
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
}

// ---------------------------------------------------------------- blocker 1

test('cad:sd-review1-side-past-part a side typed or dragged past the part is refused (the arrow stops there); a side into the part shows a note', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await openEnclosure(frame);
  const p = panel(frame);
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  await expect(sizeLine(frame)).toHaveText('Size: 60 mm × 50 mm × 40 mm · 120,000 mm³');
  await expectVolume(page, 'Enclosure 1', 120_000);

  // −60 (meant as 60): past the part's +X face. Refused, with the reason; nothing changes.
  await setField(frame, 'side-nx', '-60');
  await expect(sideError(frame, 'nx')).toHaveText('−X would put the enclosure past the part (padding more than −40 mm)');
  await expect(p.locator('.cad-enclosure-side[data-side="-x"]')).toHaveAttribute('data-side-source', 'padding');
  await expect(featureRow(frame, 'Enclosure 1')).toHaveAttribute('data-state', 'ok');
  await settled(page);
  await expectVolume(page, 'Enclosure 1', 120_000);
  // Exactly at the far side: none of the part would be inside either.
  await setField(frame, 'side-nx', '-40');
  await expect(sideError(frame, 'nx')).toHaveText('−X would put the enclosure past the part (padding more than −40 mm)');
  await shot(page, 'sd-r1-side-past-part');

  // −15: into the part (a symmetry plane): taken, with a note on what the fluid will be.
  await setField(frame, 'side-nx', '-15');
  await expect(sideError(frame, 'nx')).toHaveCount(0);
  await expect(sideNote(frame, 'nx')).toHaveText('−X cuts through Body 1: Combine Cut will leave the cut-off part of Body 1 out of the fluid');
  await expectVolume(page, 'Enclosure 1', (40 + 10 - 15) * 50 * 40);
  await expect(sideNote(frame, 'px')).toHaveCount(0);
  await p.locator('[data-side-reset="nx"]').click();
  await expect(sideNote(frame, 'nx')).toHaveCount(0);
  await expectVolume(page, 'Enclosure 1', 120_000);

  // The −X arrow dragged 100 mm inwards stops just inside the part's far side, and says so.
  const label = frame.locator('[data-enclosure-value]');
  await dragSide(page, '-x', -100, async () => {
    await expect(label).toBeVisible();
    await expect(label).toHaveText(/^−X −39\.\d+ mm · as far in as it goes$/);
  });
  const nx = Number(await sideField(frame, 'nx').inputValue());
  expect(nx, `−X dragged to ${nx}`).toBeGreaterThan(-40);
  expect(nx).toBeLessThan(-39);
  await expect(sideError(frame, 'nx')).toHaveCount(0);
  await expect(sideNote(frame, 'nx')).toBeVisible();
  await expectVolume(page, 'Enclosure 1', (40 + 10 + nx) * 50 * 40, 1e-9);
  await expect(featureRow(frame, 'Enclosure 1')).toHaveAttribute('data-state', 'ok');
  await shot(page, 'sd-r1-drag-stops');

  // A cylinder: Radius −20 takes it inside the part (r = 25 + 10 - 20 = 5): allowed, with the note;
  // its Top below the part's bottom is refused.
  await p.locator('[data-side-reset="nx"]').click();
  await p.locator('[data-field="shape"] select').selectOption('cylinder');
  await setField(frame, 'side-radius', '-20');
  await expect(sideError(frame, 'radius')).toHaveCount(0);
  await expect(sideNote(frame, 'radius')).toHaveText('Radius cuts through Body 1: Combine Cut will leave the cut-off part of Body 1 out of the fluid');
  await expectVolume(page, 'Enclosure 1', Math.PI * 5 * 5 * 40, 1e-9);
  await setField(frame, 'side-top', '-25');
  await expect(sideError(frame, 'top')).toHaveText('Top would put the enclosure past the part (padding more than −20 mm)');
  await expectVolume(page, 'Enclosure 1', Math.PI * 5 * 5 * 40, 1e-9);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- coverage: cylinders

test('cad:sd-review1-cylinder-sides a cylinder about Z, X and Y: Radius, Top and Bottom arrows; its ends named by the axis; Use padding; Percent', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await openEnclosure(frame);
  const p = panel(frame);
  await p.locator('[data-field="shape"] select').selectOption('cylinder');
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  // About Z: through the corners (r0 = 25), 10 mm out, z from -10 to 30.
  await expect(p.locator('[data-field-row="side-top"]')).toContainText('Top');
  await expect(p.locator('[data-field-row="side-bottom"]')).toContainText('Bottom');
  await expectVolume(page, 'Enclosure 1', Math.PI * 35 * 35 * 40);
  // The arrows: Radius out 10, Top out 10, Bottom out 15.
  await dragSide(page, 'radius', 10);
  await dragSide(page, 'top', 10);
  await dragSide(page, 'bottom', 15);
  const got = {
    radius: Number(await sideField(frame, 'radius').inputValue()),
    top: Number(await sideField(frame, 'top').inputValue()),
    bottom: Number(await sideField(frame, 'bottom').inputValue()),
  };
  expect(Math.abs(got.radius - 20), `Radius dragged to ${got.radius}`).toBeLessThan(0.3);
  expect(Math.abs(got.top - 20), `Top dragged to ${got.top}`).toBeLessThan(0.3);
  expect(Math.abs(got.bottom - 25), `Bottom dragged to ${got.bottom}`).toBeLessThan(0.3);
  for (const k of ['radius', 'top', 'bottom']) await expect(p.locator(`[data-side-reset="${k}"]`)).toBeVisible();
  await expectVolume(page, 'Enclosure 1', Math.PI * (25 + got.radius) ** 2 * (20 + got.top + got.bottom));
  await shot(page, 'sd-r1-cylinder-z');

  // About X: the ends are "+X end" and "−X end"; the sides keep their values.
  await p.locator('[data-field="axis"] select').selectOption('origin:x');
  await expect(p.locator('[data-field-row="side-top"]')).toContainText('+X end');
  await expect(p.locator('[data-field-row="side-bottom"]')).toContainText('−X end');
  const r0x = Math.hypot(30, 20) / 2;
  await expectVolume(page, 'Enclosure 1', Math.PI * (r0x + got.radius) ** 2 * (40 + got.top + got.bottom));
  // Use padding: each side follows the Fixed 10 mm again.
  for (const k of ['radius', 'top', 'bottom']) await p.locator(`[data-side-reset="${k}"]`).click();
  for (const k of ['radius', 'top', 'bottom']) await expect(sideField(frame, k)).toHaveValue('10');
  await expectVolume(page, 'Enclosure 1', Math.PI * (r0x + 10) ** 2 * 60);
  // Typed past the far end: the reason names the end.
  await setField(frame, 'side-bottom', '-45');
  await expect(sideError(frame, 'bottom')).toHaveText('−X end would put the enclosure past the part (padding more than −40 mm)');
  await shot(page, 'sd-r1-cylinder-x');

  // About Y with Percent: 10 % of r0 on the radius, 10 % of the length on each end.
  await p.locator('[data-field="axis"] select').selectOption('origin:y');
  await expect(p.locator('[data-field-row="side-top"]')).toContainText('+Y end');
  await expect(p.locator('[data-field-row="side-bottom"]')).toContainText('−Y end');
  await p.locator('[data-field="padding"] select').selectOption('percent');
  const r0y = Math.hypot(40, 20) / 2;
  await expectVolume(page, 'Enclosure 1', Math.PI * (r0y * 1.1) ** 2 * 30 * 1.2);
  await expect(sizeLine(frame)).toContainText('× 36 mm ·');
  await featureRow(frame, 'Enclosure 1').waitFor();
  await expect(featureRow(frame, 'Enclosure 1')).toHaveAttribute('data-state', 'ok');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- coverage: two bodies, the fluid follows

test('cad:sd-review1-two-bodies the union of two bodies, bodies picked in the browser, then the fluid follows an edit of the Enclosure; no Delete says why', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  await addSolid(page, { at: [60, 0, 0], size: [20, 20, 20] });
  await openEnclosure(frame);
  const p = panel(frame);
  // Nothing picked: the field itself says it encloses every solid body (it said "(none)").
  const empty = p.locator('[data-pick-field="bodies"] [data-pick-empty]');
  await expect(empty).toHaveText('All solid bodies (2): Body 1, Body 2');
  await expect(sizeLine(frame)).toHaveText('Size: 80 mm × 20 mm × 20 mm · 32,000 mm³');
  // Picked in the browser: Body 2 alone, then both, then Body 1 taken out again.
  await openBodies(frame);
  await p.locator('[data-pick-list="bodies"]').click();
  await bodyRows(frame).nth(1).locator('.tree-row').first().click();
  await expect(p.locator('[data-pick-field="bodies"] [data-pick-row]')).toHaveCount(1);
  await expect(empty).toHaveCount(0);
  await expect(sizeLine(frame)).toHaveText('Size: 20 mm × 20 mm × 20 mm · 8000 mm³');
  await bodyRows(frame).nth(0).locator('.tree-row').first().click();
  await expect(p.locator('[data-pick-field="bodies"] [data-pick-row]')).toHaveCount(2);
  await expect(sizeLine(frame)).toHaveText('Size: 80 mm × 20 mm × 20 mm · 32,000 mm³');
  const rows = p.locator('[data-pick-field="bodies"] [data-pick-row]');
  await rows.first().locator('[data-pick-remove]').click();
  await expect(rows).toHaveCount(1);
  await rows.first().locator('[data-pick-remove]').click();
  await expect(rows).toHaveCount(0);
  await expect(empty).toHaveText('All solid bodies (2): Body 1, Body 2');
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  await setField(frame, 'distance', '5');
  await expectVolume(page, 'Enclosure 1', 90 * 30 * 30);
  await p.locator('[data-panel-done]').click();

  // The fluid: Cut with the Enclosure as the target: Keep the tool bodies comes on by itself.
  await tb(frame).locator('[data-command="modify.combine"]').click();
  await p.locator('[data-field="op"] select').selectOption('cut');
  await p.locator('[data-pick-list="targets"]').click();
  await bodyRows(frame).nth(2).locator('.tree-row').first().click();
  await expect(p.locator('[data-switch="keep-tools"] input')).toBeChecked();
  await p.locator('[data-pick-list="tools"]').click();
  await bodyRows(frame).nth(0).locator('.tree-row').first().click();
  await bodyRows(frame).nth(1).locator('.tree-row').first().click();
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  await expectVolume(page, 'Enclosure 1', 90 * 30 * 30 - 2 * 8000);
  await expectVolume(page, 'Body 1', 8000);
  await expectVolume(page, 'Body 2', 8000);

  // Edit the Enclosure after its Combine: no Delete, and the panel says why; the fluid follows.
  await featureRow(frame, 'Enclosure 1').locator('> .tree-row').dblclick();
  await expect(p.locator('[data-panel-title]')).toHaveText('Enclosure 1');
  await expect(p.locator('[data-panel-delete]')).toHaveCount(0);
  // Enclosure 1's body is named once (SD review round 2: "uses Enclosure 1 of Enclosure 1").
  await expect(p.locator('[data-delete-block]')).toHaveText('Delete is off: Combine 1 uses Enclosure 1: delete Combine 1 or change what it uses first');
  await setField(frame, 'distance', '10');
  await expectVolume(page, 'Enclosure 1', 100 * 40 * 40 - 2 * 8000);
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  await shot(page, 'sd-r1-two-bodies-fluid');
  await p.locator('[data-panel-done]').click();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- coverage: a removed Box a Combine uses

test('cad:sd-review1-removed-box-used a P1 Box whose body a Combine uses: its Delete is refused with the reason; deleted in order it goes', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
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
          bodies: { b_1: { name: 'Body 1', color: '#bdc9db' }, b_2: { name: 'Body 2', color: '#bdc9db' } },
          features: [
            { id: 'f_box1', type: 'box', name: 'Box 1', op: 'new', creates: 'b_1', scope: [], origin: ['0 mm', '0 mm', '0 mm'], size: ['20 mm', '20 mm', '20 mm'] },
            { id: 'f_box2', type: 'box', name: 'Box 2', op: 'new', creates: 'b_2', scope: [], origin: ['10 mm', '10 mm', '10 mm'], size: ['20 mm', '20 mm', '20 mm'] },
            { id: 'f_comb', type: 'combine', name: 'Combine 1', op: 'cut', targets: ['b_1'], tools: ['b_2'], keepTools: false },
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
  const names = frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl');
  await expect(names).toHaveText(['Box 1', 'Box 2', 'Combine 1']);
  for (const n of ['Box 1', 'Box 2']) await expect(featureRow(frame, n).locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', `What's wrong: This part uses a removed feature (${n})`);
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'error');

  // Box 1's body is Combine 1's target: Delete is refused, and says why.
  const menu = frame.locator('[data-cad-menu]');
  await featureRow(frame, 'Box 1').locator('> .tree-row').click({ button: 'right' });
  const del = menu.locator('[data-menu-item="delete"]');
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await del.hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Combine 1 uses Body 1 of Box 1: delete Combine 1 or change what it uses first');
  await del.click({ force: true });
  await expect(names).toHaveText(['Box 1', 'Box 2', 'Combine 1']);
  await page.keyboard.press('Escape');
  await shot(page, 'sd-r1-removed-box-used');
  // In order: Combine 1, then the Boxes.
  for (const n of ['Combine 1', 'Box 1', 'Box 2']) {
    await featureRow(frame, n).locator('> .tree-row').click({ button: 'right' });
    await expect(menu.locator('[data-menu-item="delete"]')).not.toHaveAttribute('aria-disabled', 'true');
    await menu.locator('[data-menu-item="delete"]').click();
    await expect(featureRow(frame, n)).toHaveCount(0);
  }
  await expect(frame.locator('[data-tree-empty="history"]')).toHaveText('No features yet');
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 30_000 });
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- polish: the panel's layout

test('cad:sd-review1-panel-layout Use padding does not move the field; the Percent field lines up and keeps its % in line; Padding keeps the sides set; CAD panels are 360 px', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  const made = await addSolid(page, { size: [40, 30, 20] });
  await openEnclosure(frame);
  const p = panel(frame);
  expect(Math.round((await p.boundingBox())!.width)).toBe(360);
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  const px = sideField(frame, 'px');
  const nx = sideField(frame, 'nx');
  const before = (await px.boundingBox())!;
  // +X set on its own: "Use padding" appears beside it, in a column every row keeps.
  await setField(frame, 'side-px', '20');
  await expect(p.locator('[data-side-reset="px"]')).toBeVisible();
  const after = (await px.boundingBox())!;
  expect(Math.abs(after.x - before.x), `+X field moved from ${before.x} to ${after.x}`).toBeLessThan(0.5);
  expect(Math.abs(after.x - (await nx.boundingBox())!.x)).toBeLessThan(0.5);
  // Padding to Percent keeps +X (and says it is set on its own), the other sides follow.
  await p.locator('[data-field="padding"] select').selectOption('percent');
  await expect(px).toHaveValue('20');
  await expect(p.locator('.cad-enclosure-side[data-side="+x"]')).toHaveAttribute('data-side-source', 'set');
  await expect(nx).toHaveValue('4');
  await expectVolume(page, 'Enclosure 1', (40 + 20 + 4) * 36 * 24);
  // The Percent field in the sides' column, its % where their unit is.
  const pct = p.locator('.nui[data-field="percent"] input');
  const pb = (await pct.boundingBox())!;
  expect(Math.abs(pb.x - (await nx.boundingBox())!.x), `Percent at ${pb.x}`).toBeLessThan(0.5);
  const unit = p.locator('.nui[data-field="percent"] [data-nui-after]');
  const lengthUnit = p.locator('.nui[data-field="side-nx"] [data-nui-after]');
  expect(Math.abs((await unit.boundingBox())!.x - (await lengthUnit.boundingBox())!.x)).toBeLessThan(0.5);
  const centred = async () => {
    const u = (await unit.boundingBox())!;
    const i = (await pct.boundingBox())!;
    return Math.abs(u.y + u.height / 2 - (i.y + i.height / 2));
  };
  expect(await centred()).toBeLessThan(2);
  await setField(frame, 'percent', '-5');
  await expect(p.locator('.nui[data-field="percent"] [data-nui-error]')).toHaveText('Percent must not be negative');
  expect(await centred(), 'the % stays on the input line under an error').toBeLessThan(2);
  await shot(page, 'sd-r1-panel-layout');
  await page.keyboard.press('Escape');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  // Extrude, Sketch and Combine panels: the same 360 px.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  await expect(p.locator('[data-panel-title]')).toHaveText('Extrude 1');
  expect(Math.round((await p.boundingBox())!.width)).toBe(360);
  await p.locator('[data-panel-done]').click();
  await tb(frame).locator('[data-command="modify.combine"]').click();
  await expect(p.locator('[data-panel-title]')).toHaveText('Combine 1');
  expect(Math.round((await p.boundingBox())!.width)).toBe(360);
  await p.locator('[data-panel-delete]').click();
  await expect(p).toHaveCount(0);
  await featureRow(frame, 'Sketch 1').locator('> .tree-row').dblclick();
  const sk = frame.locator('[data-cad-panel]').first();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  expect(Math.round((await sk.boundingBox())!.width)).toBe(360);
  expect(made.body).toBeTruthy();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- polish: see-through; face names

test('cad:sd-review1-see-through the Enclosure body is see-through: the part inside shows and is picked; Zero padding shows no patches; Measure names its faces by side', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await settled(page);
  // The part's top face as it looks alone (five points across it).
  const top: V3[] = [[20, 15, 20], [8, 6, 20], [32, 6, 20], [8, 24, 20], [32, 24, 20]];
  const onPage = async () => Promise.all(top.map((q) => modelOnPage(page, q)));
  const alone = await pixels(page, await onPage());

  // Enclosure at Zero padding: it shares the part's faces. They show the part, evenly tinted at most,
  // never in patches of the enclosure's colour.
  await openEnclosure(frame);
  await panel(frame).locator('[data-panel-done]').click();
  await settled(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  const zero = await pixels(page, await onPage());
  const spread = Math.max(...zero.map((c) => dist(c, zero[0])));
  expect(spread, `top face at Zero padding: ${JSON.stringify(zero)}`).toBeLessThan(10);
  await shot(page, 'sd-r1-see-through-zero');

  // Fixed 10 mm: the part shows through the air around it (close to its own colour, not the enclosure's).
  await featureRow(frame, 'Enclosure 1').locator('> .tree-row').dblclick();
  await panel(frame).locator('[data-field="padding"] select').selectOption('fixed');
  await panel(frame).locator('[data-panel-done]').click();
  await settled(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  const through = await pixels(page, await onPage());
  for (let i = 0; i < top.length; i++) expect(dist(through[i], alone[i]), `part seen through the enclosure at ${top[i]}: ${through[i]} vs ${alone[i]}`).toBeLessThan(60);
  await shot(page, 'sd-r1-see-through-fixed');
  // A click there picks the part's top face, not the enclosure in front of it.
  const c = await modelOnPage(page, [20, 15, 20]);
  await page.mouse.click(c[0], c[1]);
  const picked = await cad<{ kind: string; body?: string }[]>(page, (() => (window as unknown as CadWin).__CAD__.services.selection.get().items) as never);
  const bodies = await cad<{ id: string; name: string }[]>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().rebuild.bodies.map((b) => ({ id: b.id, name: b.name }))) as never);
  expect(picked.map((it) => `${it.kind} ${bodies.find((b) => b.id === it.body)?.name}`)).toEqual(['face Body 1']);
  await page.keyboard.press('Escape');

  // Measure names an Enclosure face by its side: hide the part, click the enclosure's top.
  await openBodies(frame);
  await bodyRows(frame).nth(0).locator('[data-body-act="visibility"]').click({ force: true });
  await expect(bodyRows(frame).nth(0)).toHaveAttribute('data-visible', '0');
  await tb(frame).locator('[data-command="inspect.measure"]').click();
  const m = frame.locator('[data-tool-panel="inspect.measure"]');
  await expect(m).toBeVisible();
  await settled(page);
  const t = await modelOnPage(page, [20, 15, 30]);
  await page.mouse.click(t[0], t[1]);
  await expect(m.locator('[data-pick-row]')).toHaveCount(1);
  await expect(m.locator('[data-pick-row] .cad-pick-name')).toHaveText('+Z face of Enclosure 1');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- polish: Sketch, then pick the plane

test('cad:sd-review1-sketch-pick Sketch with nothing selected waits for a plane or a flat face (planes shown, a prompt); Escape stops waiting', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const sketch = tb(frame).locator('[data-command="sketch.new"]');
  const prompt = frame.locator('[data-sketch-pick]');
  const labels = frame.locator('.cad-vp-label');
  // An empty Part: Sketch is offered (it was greyed "Select a plane or a flat face, then Sketch").
  await expect(sketch).not.toHaveAttribute('aria-disabled', 'true');
  await sketch.hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('A 2D sketch on a plane or a flat face: the one selected, or pick one after');
  await sketch.click();
  await expect(prompt).toHaveText('Select a plane or a flat face for the sketch (Esc stops)');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  // The Top plane picked (here in the tree): sketch mode on it.
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(prompt).toHaveCount(0);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1']);
  // A body now: the planes hide once a body exists (seen from the Isometric view, where their labels show).
  await addSolid(page, { size: [20, 20, 20] });
  await tb(frame).locator('[data-command="view.iso"]').click();
  await settled(page);
  await page.mouse.move(5, 5);
  await expect(labels.filter({ visible: true })).toHaveCount(0);
  // Sketch with nothing selected: the planes show while it waits; Escape stops waiting.
  await sketch.click();
  await expect(prompt).toBeVisible();
  await expect.poll(() => labels.filter({ visible: true }).count()).toBeGreaterThan(0);
  await shot(page, 'sd-r1-sketch-pick');
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(labels.filter({ visible: true })).toHaveCount(0);
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  // Again, and the body's top face picked in the view: a sketch on that face.
  await sketch.click();
  await expect(prompt).toBeVisible();
  const top = await modelOnPage(page, [10, 10, 20]);
  await page.mouse.click(top[0], top[1]);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(prompt).toHaveCount(0);
  const support = await cad<{ kind: string } | null>(page, (() => {
    const st = (window as unknown as CadWin).__CAD__.services.doc.state.get() as unknown as { session: { feature: string } | null; doc: { features: { id: string; support?: { kind: string } }[] } };
    const id = st.session?.feature;
    return st.doc.features.find((f) => f.id === id)?.support ?? null;
  }) as never);
  expect(support?.kind).toBe('face');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
