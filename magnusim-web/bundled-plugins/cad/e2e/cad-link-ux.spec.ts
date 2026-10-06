// LINK phase, UX review fixes, in the real host frame with the real kernel (one
// test per area; U1, typed text after the app's "Stay", is in
// cad-sd-review2-leave.spec.ts, where the real browser runs the frame out of
// process):
//   - u2-float-noise: Enclosure sides with Percent padding show clean numbers
//     (30.48, not 30.480000000000004), also while focused, and Escape puts the
//     clean text back; nothing is stored for an untouched side;
//   - enclosure-polish: "Use padding" stays put in a row with a reason under it;
//     a refused −Z shows only its refusal (not the old "cuts through" note); Done
//     with a refused value keeps the panel open on that field; one arrow drag
//     writes the model once, and while it is dragged the arrow's label, the field
//     and Size say the same number; the reason is said in padding terms;
//   - readouts-and-words: a volume of 7 digits reads as significant figures, not
//     rounded digits passed off as exact; a new Combine's "Pick at least one
//     target" is a plain hint until the user does something, and its filler line
//     is gone; a Split's failure names its offset; the feature menu says
//     "Delete" once; a hidden body says it is still in the simulation;
//   - stale-tab: a tab with no change of its own whose model another tab saved
//     over says "Updated in another tab" when it gets the focus back, not "Saved",
//     with Reload only, and it is not unsaved work (L3 review B1: it said "Changed
//     in another tab", reported dirty and offered Keep mine).
// window.__CAD__ is used to read stored values and to project model points.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, countFileWrites, fileWrites, modelOnPage, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame, runCommand } from './helpers';

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
const sideField = (frame: FrameLocator, key: string) => panel(frame).locator(`.nui[data-field="side-${key}"] input`);
const sideError = (frame: FrameLocator, key: string) => panel(frame).locator(`.nui[data-field="side-${key}"] [data-nui-error]`);
const notes = (frame: FrameLocator) => panel(frame).locator('[data-side-note]');
const sizeLine = (frame: FrameLocator) => panel(frame).locator('[data-enclosure-size]');
const chip = (frame: FrameLocator) => frame.locator('[data-chip="save"]');
const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

type CadWin = {
  __CAD__: {
    services: {
      doc: {
        state: { get(): { doc: { features: { id: string; type: string; name: string; sides?: Record<string, string> }[] }; save: { state: string }; rebuild: { status: string; outputs: Record<string, { type: string; box?: { min: V3; max: V3 }; pad: Record<string, number> }> } } };
        rename(id: string, name: string): unknown;
        beginNew(t: string, init: unknown): { feature: string; commit(): void };
      };
      viewport: { get(): { handle: { pixelSize(p: V3): number; state: { get(): { animating: boolean } } } } };
    };
  };
};

async function settled(page: Page) {
  await expect.poll(() => cad<string>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().rebuild.status) as never)).toBe('done');
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.state.get().animating) as never)).toBe(false);
}

const expectSaved = (frame: FrameLocator) => expect(chip(frame)).toHaveText('Saved', { timeout: 30_000 });

async function openEnclosure(frame: FrameLocator) {
  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText(/^Enclosure \d+$/);
}

async function setField(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
}

/** The stored sides of the (last) Enclosure. */
const storedSides = (page: Page) => cad<Record<string, string>>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().doc.features.filter((f) => f.type === 'enclosure').pop()?.sides ?? {}) as never);

/** Where the open Enclosure's box arrow for `side` starts and the way it points. */
async function arrowOf(page: Page, side: string): Promise<{ base: V3; dir: V3 }> {
  return cad(page, ((sd: string) => {
    const st = (window as unknown as CadWin).__CAD__.services.doc.state.get();
    const f = st.doc.features.filter((x) => x.type === 'enclosure').pop()!;
    const o = st.rebuild.outputs[f.id];
    const k = sd[1] === 'x' ? 0 : sd[1] === 'y' ? 1 : 2;
    const plus = sd[0] === '+';
    const base = [0, 1, 2].map((i) => (o.box!.min[i] + o.box!.max[i]) / 2) as V3;
    base[k] = plus ? o.box!.max[k] : o.box!.min[k];
    const dir: V3 = [0, 0, 0];
    dir[k] = plus ? 1 : -1;
    return { base, dir };
  }) as never, side);
}

// ---------------------------------------------------------------- U2

test('cad:ux-u2-float-noise Percent padding shows clean numbers in the side fields, also while focused; Escape puts the clean text back; nothing is stored', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  // 304.8 x 127 x 63.5 mm (12 x 5 x 2.5 in): 10 % of each is float noise in JavaScript (30.480000000000004).
  await addSolid(page, { size: [304.8, 127, 63.5] });
  await settled(page);
  await openEnclosure(frame);
  await panel(frame).locator('[data-field="padding"] select').selectOption('percent');
  await settled(page);
  const want: Record<string, string> = { px: '30.48', nx: '30.48', py: '12.7', ny: '12.7', pz: '6.35', nz: '6.35' };
  for (const [k, v] of Object.entries(want)) await expect(sideField(frame, k)).toHaveValue(v);
  // Focused, a field shows every digit: still the clean ones.
  for (const [k, v] of Object.entries(want)) {
    await sideField(frame, k).click();
    await expect(sideField(frame, k)).toBeFocused();
    await expect(sideField(frame, k)).toHaveValue(v);
  }
  // Typed, then Escape: the clean text, not 30.480000000000004.
  const nx = sideField(frame, 'nx');
  await nx.click();
  await nx.press('Control+a');
  await page.keyboard.type('7');
  await expect(nx).toHaveValue('7');
  await page.keyboard.press('Escape');
  await expect(nx).toHaveValue('30.48');
  await shot(page, 'ux-u2-escape-clean');
  await page.keyboard.press('Tab');
  await settled(page);
  // Nothing was stored for an untouched side.
  expect(await storedSides(page)).toEqual({});
  await expect(sizeLine(frame)).toContainText('365.76 mm × 152.4 mm × 76.2 mm');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- the Enclosure panel's polish

test('cad:ux-enclosure-polish Use padding stays put under a reason; a refused side shows only its refusal; Done keeps a refused value open; one drag writes once and its numbers agree', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await settled(page);
  await openEnclosure(frame);
  const p = panel(frame);
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  await settled(page);

  // "Use padding" beside +X, then a refused value in +X: the link does not move.
  await setField(frame, 'side-px', '25');
  const link = p.locator('[data-side-reset="px"]');
  await expect(link).toBeVisible();
  const before = (await link.boundingBox())!;
  await setField(frame, 'side-px', '-60');
  await expect(sideError(frame, 'px')).toHaveText('+X would put the enclosure past the part (padding more than −40 mm)');
  const after = (await link.boundingBox())!;
  expect(Math.abs(after.x - before.x), `the link moved from ${before.x} to ${after.x}`).toBeLessThan(0.5);
  expect(Math.abs(after.y - before.y)).toBeLessThan(0.5);
  await shot(page, 'ux-use-padding-stays');
  await sideField(frame, 'px').press('Escape');
  await expect(sideError(frame, 'px')).toHaveCount(0);

  // −Z into the part: the note; then a refused −Z: only the refusal.
  await setField(frame, 'side-nz', '-12');
  await expect(notes(frame)).toHaveText('−Z cuts through Body 1: Combine Cut will leave the cut-off part of Body 1 out of the fluid');
  await setField(frame, 'side-nz', '-40');
  await expect(sideError(frame, 'nz')).toHaveText('−Z would put the enclosure past the part (padding more than −20 mm)');
  await expect(notes(frame)).toHaveCount(0);
  await shot(page, 'ux-refused-only');
  await sideField(frame, 'nz').press('Escape');
  await expect(notes(frame)).toHaveCount(1);

  // Done with a refused value (typed, Enter, refused): the panel stays open on that field, its reason under it.
  await setField(frame, 'side-nx', '-60');
  await expect(sideError(frame, 'nx')).toHaveText('−X would put the enclosure past the part (padding more than −40 mm)');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(1);
  await expect(sideField(frame, 'nx')).toBeFocused();
  await expect(sideError(frame, 'nx')).toHaveText('−X would put the enclosure past the part (padding more than −40 mm)');
  await sideField(frame, 'nx').press('Escape');
  await expect(sideError(frame, 'nx')).toHaveCount(0);
  await expectSaved(frame);

  // One drag of +X: the model is written once (on release); mid-drag, the arrow's label, the field
  // and Size say the same number.
  await countFileWrites(page);
  const { base, dir } = await arrowOf(page, '+x');
  const px = await cad<number>(page, ((pt: V3) => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.pixelSize(pt)) as never, base);
  const g: V3 = [base[0] + dir[0] * 30 * px, base[1] + dir[1] * 30 * px, base[2] + dir[2] * 30 * px];
  const e: V3 = [g[0] + 10, g[1], g[2]];
  const a = await modelOnPage(page, g);
  const b = await modelOnPage(page, e);
  await page.mouse.move(a[0], a[1], { steps: 2 });
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(a[0] + ((b[0] - a[0]) * i) / 16, a[1] + ((b[1] - a[1]) * i) / 16);
  // Mid-drag (the button still down), after the rebuild of the last move.
  await settled(page);
  const label = (await frame.locator('[data-enclosure-value]').textContent()) ?? '';
  const m = /^\+X (-?[\d.]+) mm/.exec(label);
  expect(m, `label "${label}"`).not.toBeNull();
  await expect(sideField(frame, 'px')).toHaveValue(m![1]);
  // Size: −X 10 + 40 + +X along X.
  const sizeX = Number((10 + 40 + Number(m![1])).toPrecision(6));
  await expect(sizeLine(frame)).toContainText(`Size: ${sizeX} mm × 50 mm × `);
  expect((await fileWrites(page)).filter((r) => r.endsWith('/model.json'))).toEqual([]);
  await page.mouse.up();
  await settled(page);
  await expectSaved(frame);
  expect((await fileWrites(page)).filter((r) => r.endsWith('/model.json'))).toHaveLength(1);
  expect((await storedSides(page))['+x']).toBe(`${m![1]} mm`);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- readouts and words

test('cad:ux-readouts-and-words significant figures for a 7-digit volume; a plain hint before any interaction; no filler; the Split offset; "Delete" once; a hidden body is still in the simulation', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  // A cylinder 100 mm across, 200 mm tall: 1,570,796.3 mm³.
  await addSolid(page, { circle: true, size: [100, 200] });
  await settled(page);
  const volume = frame.locator('[data-chip="volume"]');
  await expect(volume).toContainText('1.5708 × 10⁶ mm³');
  await expect(volume).not.toContainText('1,570,8');
  await addSolid(page, { at: [120, 0, 0], size: [20, 20, 20] });
  await settled(page);
  await page.keyboard.press('Escape');

  // A new Combine: what it waits for is a plain hint, not red, and no filler line.
  await runCommand(frame, 'modify.combine');
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Combine 1');
  await expect(p.locator('[data-incomplete-hint]')).toHaveText('Pick at least one target');
  await expect(p.locator('[data-run-reason]')).toHaveCount(0);
  await expect(p).not.toContainText('Works on imported and modelled bodies alike');
  // After an interaction it is a reason.
  await p.locator('[data-field="op"] select').selectOption('cut');
  await expect(p.locator('[data-run-reason]')).toHaveText('Pick at least one target');
  await p.locator('[data-panel-delete]').click();
  await expect(p).toHaveCount(0);

  // A Split by the Right plane 500 mm off cuts nothing: its reason names the offset.
  const body = await cad<string>(page, (() => (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { bodies: { id: string }[] } } } } } } }).__CAD__.services.doc.state.get().rebuild.bodies[0].id) as never);
  await cad(page, ((b: string) => {
    const s = (window as unknown as CadWin).__CAD__.services.doc.beginNew('split', { targets: [b], tool: { kind: 'plane', plane: 'origin:right', offset: '500 mm' } });
    s.commit();
  }) as never, body);
  await settled(page);
  await expect(featureRow(frame, 'Split 1')).toHaveAttribute('data-state', 'error');
  await featureRow(frame, 'Split 1').locator('> .tree-row').dblclick();
  await expect(p.locator('[data-run-reason]').first()).toContainText('Split 1 failed: the Right plane offset by 500 mm does not cut');
  await p.locator('[data-panel-delete]').click();
  await expect(p).toHaveCount(0);

  // The feature menu says "Delete" once, whatever the feature is called.
  const ext = await cad<string>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().doc.features.find((f) => f.type === 'extrude')!.id) as never);
  await cad(page, ((id: string) => (window as unknown as CadWin).__CAD__.services.doc.rename(id, 'Delete faces 1')) as never, ext);
  await featureRow(frame, 'Delete faces 1').locator('> .tree-row').click({ button: 'right' });
  await expect(frame.locator('[data-cad-menu] [data-menu-item="delete"]')).toHaveText('Delete faces 1');
  await page.keyboard.press('Escape');
  await featureRow(frame, 'Extrude 2').locator('> .tree-row').click({ button: 'right' });
  await expect(frame.locator('[data-cad-menu] [data-menu-item="delete"]')).toHaveText('Delete Extrude 2');
  await page.keyboard.press('Escape');

  // A hidden body is still in the simulation, and its row says so.
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row').click();
  const row = frame.locator(`[data-body-row="${body}"]`);
  await row.locator('[data-body-act="visibility"]').click();
  await expect(row).toHaveAttribute('data-visible', '0');
  await expect(row).toHaveAttribute('data-in-simulation', '1');
  await expect(row).toHaveAttribute('data-hidden-in-simulation', '1');
  // The pointer off the eye (within the Part: in real Chrome a move out of the frame and back to the
  // same point brings no new pointer enter), then onto it: its tip.
  await frame.locator('[data-cad-tree]').first().hover({ position: { x: 5, y: 5 } });
  await row.locator('[data-body-act="visibility"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Hidden, still in the simulation');
  await shot(page, 'ux-hidden-in-simulation');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- a tab another tab saved over

test('cad:ux-stale-tab a clean tab whose model another tab saved over says "Updated in another tab" when it gets the focus back: Reload only, and not dirty', async ({ page, context, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await settled(page);
  await expectSaved(frame);
  const url = page.url();
  // Tab B: the same Part, saved state.
  const b = await context.newPage();
  await b.goto(url);
  const bf = await partOpened(b);
  await expect(bf.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(chip(bf)).toHaveText('Saved', { timeout: 30_000 });
  // Tab A saves a change.
  await page.bringToFront();
  await cad(page, (() => {
    const d = (window as unknown as CadWin).__CAD__.services.doc;
    const ext = d.state.get().doc.features.find((f) => f.type === 'extrude')!;
    d.rename(ext.id, 'Base');
  }) as never);
  await expectSaved(frame);
  // Back in tab B (the app's header has the keyboard, then the Part): it says what happened, before any edit.
  await b.bringToFront();
  await b.locator('#workspace-overlay [data-ws-back]').focus();
  await bf.locator('[data-cad-tree]').first().click({ position: { x: 5, y: 5 } });
  await expect(chip(bf)).toContainText('Updated in another tab', { timeout: 30_000 });
  await expect(chip(bf)).toHaveAttribute('data-state', 'updated');
  // Nothing of B's is lost by reloading, and nothing is unsaved: no Keep mine, no unsaved dot.
  await expect(chip(bf).locator('[data-chip-action]')).toHaveText(['Reload']);
  await expect(b.locator('#workspace-overlay [data-ws-dirty]')).toHaveCount(0);
  await b.screenshot({ path: SHOTS ? join(SHOTS, 'ux-stale-tab.png') : undefined }).catch(() => {});
  // Reload: A's version, saved.
  await chip(bf).locator('[data-chip-action="Reload"]').click();
  await expect(chip(bf)).toHaveText('Saved', { timeout: 30_000 });
  await expect(bf.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toContainText(['Base']);
  await b.close();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
