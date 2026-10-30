// Sketch Copy and Paste in the real host frame, asserting what the person sees: a rectangle with a
// dimension, its four lines selected, Ctrl+C (the panel's foot says what was copied), Ctrl+V: the
// copy follows the pointer (its middle under it), a click places it: four more lines, the dimension
// on the copy too ("30 mm" twice), the DOF chip grows by the original's own (3 -> 6), and Ctrl+Z
// takes the whole paste out. Escape while pasting adds nothing. Ctrl+C in the dimension's value field
// copies the field's text, never the selected lines. Another sketch, on the Front plane, takes the
// same 2D shape with its dimension and the original's DOF, as one undo step. From the right-click menu (Copy on the
// selection, Paste anywhere in the sketch): a rectangle from the origin is pasted, and the foot says
// its tie to the origin was left out. Settings > Keybinds lists Copy and Paste under Sketch with
// Ctrl+C and Ctrl+V (the commands file the app's Settings reads). With the lines selected and the
// panel's red reason drag-selected, Ctrl+C copies that text (the browser's copy), and the reason
// stays; the text let go (a click on the panel's hint), Ctrl+C copies the lines, still selected. A bottom dimensioned "2*15" in a mm Part,
// pasted into a Part of an Imperial project, keeps 30 mm (as "30 mm"; "2*15" would be 762 mm in
// inches) and the foot says so.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { bytesOf, DXF_BINARY } from '../tests/sketch/import/fixtures';
import { baseUrl, ensureCadOn, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V2 = [number, number];
type V3 = [number, number, number];
type Api = {
  idle?(): Promise<void>;
  draft(): { entities: { id: string; kind: string }[]; constraints: { kind: string; expr?: string }[] } | null;
  view: { get(): { preview: { lines: [V2, V2][] } | null } };
  state: { get(): { tool: string } };
};
type W = { __CAD__: { services: { apis: { get(): { sketch: Api } }; viewport: { get(): { handle: { project(p: number[]): [number, number] | null; state: { get(): { animating: boolean } } } | null } } } } };

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** Page coordinates of a model point. */
async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await workspaceFrame(page).evaluate((pt) => (window as unknown as W).__CAD__.services.viewport.get().handle?.project(pt) ?? null, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

async function settled(page: Page) {
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
}

async function sketchIdle(page: Page) {
  await workspaceFrame(page).evaluate(async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch.idle?.();
  });
}

const clickAt = async (page: Page, p: V3, o: { shift?: boolean; button?: 'right' } = {}) => {
  const [x, y] = await at(page, p);
  if (o.shift) await page.keyboard.down('Shift');
  await page.mouse.click(x, y, o.button ? { button: o.button } : {});
  if (o.shift) await page.keyboard.up('Shift');
};
const moveTo = async (page: Page, p: V3) => {
  const [x, y] = await at(page, p);
  await page.mouse.move(x, y, { steps: 4 });
};

const chip = (frame: FrameLocator) => frame.locator('[data-chip="sketch"]');
const foot = (frame: FrameLocator) => frame.locator('[data-cad-panel="sketch"] [data-run-reason]');
const dims = (frame: FrameLocator) => frame.locator('[data-sketch-dim]');

/** The sketch's lines, and its dimensions' expressions. */
const drawn = (page: Page) =>
  workspaceFrame(page).evaluate(() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    return { lines: d?.entities.filter((e) => e.kind === 'line').length ?? 0, dims: (d?.constraints ?? []).filter((c) => c.expr != null).map((c) => c.expr) };
  });

/** The middle of the paste's preview (sketch u/v), or null when none shows. */
const previewMiddle = (page: Page) =>
  workspaceFrame(page).evaluate(() => {
    const p = (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().preview;
    if (!p || !p.lines.length) return null;
    const pts = p.lines.flat();
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    return [Math.round(((Math.min(...xs) + Math.max(...xs)) / 2) * 100) / 100, Math.round(((Math.min(...ys) + Math.max(...ys)) / 2) * 100) / 100];
  });
const toolNow = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.apis.get().sketch.state.get().tool);

async function enterSketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

/** A rectangle by two corners (R), then Select again. */
async function rectangle(page: Page, frame: FrameLocator, a: V3, b: V3) {
  await page.keyboard.press('r');
  await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.rectangle"]')).toHaveClass(/is-active/);
  await clickAt(page, a);
  await clickAt(page, b);
  await sketchIdle(page);
  await page.keyboard.press('r');
  await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.rectangle"]')).not.toHaveClass(/is-active/);
}

test('cad:sketch-copy-paste a rectangle with a dimension: Ctrl+C, Ctrl+V, the copy follows the pointer, a click places it with its dimension and the same DOF; Ctrl+Z takes it out; Escape adds nothing; Ctrl+C in the value field copies text', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await rectangle(page, frame, [10, 10, 0], [40, 30, 0]);
  await expect(chip(frame)).toHaveText('Under defined · 4 DOF');
  // Its bottom dimensioned: 3 DOF.
  await page.keyboard.press('d');
  await clickAt(page, [25, 10, 0]);
  await clickAt(page, [25, 3, 0]);
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await edit.fill('30');
  await edit.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('d');
  await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.dimension"]')).not.toHaveClass(/is-active/);
  await expect(chip(frame)).toHaveText('Under defined · 3 DOF');
  await expect(dims(frame)).toHaveText(['30 mm']);

  // The four lines selected.
  await clickAt(page, [25, 10, 0]);
  for (const p of [[40, 20, 0], [25, 30, 0], [10, 20, 0]] as V3[]) await clickAt(page, p, { shift: true });

  // Ctrl+C in the dimension's value field (Ctrl+double-click keeps the lines selected): the
  // field's text is copied, not the lines.
  await workspaceFrame(page).evaluate(() => {
    const w = window as unknown as { __copied?: string[] };
    w.__copied = [];
    document.addEventListener('copy', (e) => w.__copied!.push((e.target as Element).tagName), true);
  });
  const label = dims(frame).first();
  await label.dblclick({ modifiers: ['Control'] });
  await expect(edit).toBeFocused();
  await edit.selectText();
  await page.keyboard.press('Control+c');
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __copied?: string[] }).__copied)).toEqual(['INPUT']);
  await expect(foot(frame)).toHaveCount(0);
  await edit.press('Escape');
  await expect(edit).toHaveCount(0);

  // Ctrl+C on the sketch: the lines, with their relations and the dimension.
  await page.keyboard.press('Control+c');
  await expect(foot(frame)).toHaveText('Copied 4 lines, 4 relations and 1 dimension.');
  expect(await workspaceFrame(page).evaluate(() => (window as unknown as { __copied?: string[] }).__copied)).toEqual(['INPUT']);

  // Ctrl+V: the copy follows the pointer, held by its middle; nothing added yet.
  await page.keyboard.press('Control+v');
  await expect.poll(() => toolNow(page)).toBe('paste');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-hint]')).toHaveAttribute('data-hint-full', /^Paste 4 lines, 4 relations and 1 dimension: click where the middle of the copy goes/);
  await moveTo(page, [100, 50, 0]);
  await expect.poll(() => previewMiddle(page)).toEqual([100, 50]);
  await moveTo(page, [110, 60, 0]);
  await expect.poll(() => previewMiddle(page)).toEqual([110, 60]);
  expect((await drawn(page)).lines).toBe(4);
  // A click places it: four more lines, the dimension on the copy, the same 3 DOF again.
  await clickAt(page, [110, 60, 0]);
  await sketchIdle(page);
  expect(await drawn(page)).toEqual({ lines: 8, dims: ['30 mm', '30 mm'] });
  await expect(dims(frame)).toHaveText(['30 mm', '30 mm']);
  await expect(chip(frame)).toHaveText('Under defined · 6 DOF');
  expect(await toolNow(page)).toBe('select');
  expect(await previewMiddle(page)).toBeNull();
  // One undo step: Ctrl+Z takes the whole paste out.
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  expect(await drawn(page)).toEqual({ lines: 4, dims: ['30 mm'] });
  await expect(chip(frame)).toHaveText('Under defined · 3 DOF');

  // Escape while pasting: nothing added.
  await page.keyboard.press('Control+v');
  await expect.poll(() => toolNow(page)).toBe('paste');
  await moveTo(page, [90, 20, 0]);
  await expect.poll(() => previewMiddle(page)).toEqual([90, 20]);
  await page.keyboard.press('Escape');
  await expect.poll(() => toolNow(page)).toBe('select');
  expect(await previewMiddle(page)).toBeNull();
  await clickAt(page, [90, 20, 0]);
  await sketchIdle(page);
  expect(await drawn(page)).toEqual({ lines: 4, dims: ['30 mm'] });
  await expect(chip(frame)).toHaveText('Under defined · 3 DOF');

  // Another sketch, on the Front plane: Ctrl+V pastes the same 2D shape in its own u, v, its DOF
  // chip as the original's; its one undo step leaves the sketch empty, with nothing more to undo.
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await frame.locator('[data-tree-node="origin:front"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-panel="sketch"] [data-panel-title]')).toHaveText('Sketch 2');
  await settled(page);
  await expect(chip(frame)).toHaveText('No geometry yet');
  await page.keyboard.press('Control+v');
  await expect.poll(() => toolNow(page)).toBe('paste');
  await moveTo(page, [-20, 0, 15]);
  await expect.poll(() => previewMiddle(page)).toEqual([-20, 15]);
  await clickAt(page, [-20, 0, 15]);
  await sketchIdle(page);
  expect(await drawn(page)).toEqual({ lines: 4, dims: ['30 mm'] });
  await expect(dims(frame)).toHaveText(['30 mm']);
  await expect(chip(frame)).toHaveText('Under defined · 3 DOF');
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  expect(await drawn(page)).toEqual({ lines: 0, dims: [] });
  await expect(chip(frame)).toHaveText('No geometry yet');
  await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.undo"]')).toHaveAttribute('aria-disabled', 'true');
  expect(seen.errors).toEqual([]);
});

test("cad:sketch-copy-paste-menu Copy and Paste from the right-click menu: a rectangle from the origin; the foot says its tie to the origin was left out; Settings lists Ctrl+C and Ctrl+V", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await rectangle(page, frame, [0, 0, 0], [40.3, 20.2, 0]);
  await expect(chip(frame)).toHaveText('Under defined · 2 DOF');
  await clickAt(page, [20, 0, 0]);
  for (const p of [[40.3, 10, 0], [20, 20.2, 0], [0, 10, 0]] as V3[]) await clickAt(page, p, { shift: true });
  const menu = frame.locator('[data-cad-menu] [data-menu-item]');
  await clickAt(page, [20, 20.2, 0], { button: 'right' });
  await expect(menu).toHaveText(['Construction', 'Copy', 'Delete', 'Set keybind for Delete…', 'Paste', 'Normal to', 'Finish sketch', 'Set keybind for Copy…', 'Set keybind for Paste…', 'Set keybind for Finish sketch…', 'Set keybind for Place or finish…']);
  await frame.locator('[data-cad-menu] [data-menu-item="copy"]').click();
  await expect(foot(frame)).toHaveText('Copied 4 lines and 4 relations; 1 relation to other geometry will be left out.');
  // Paste from the menu of an empty place (nothing selected): the copy follows the pointer; a click places it.
  await page.keyboard.press('Escape');
  await clickAt(page, [80, -30, 0], { button: 'right' });
  await expect(menu).toHaveText(['Paste', 'Normal to', 'Finish sketch', 'Set keybind for Paste…', 'Set keybind for Finish sketch…', 'Set keybind for Place or finish…']);
  await frame.locator('[data-cad-menu] [data-menu-item="paste"]').click();
  await expect.poll(() => toolNow(page)).toBe('paste');
  await expect(frame.locator('[data-sketch-options="paste"] [data-sketch-option="left-out"]')).toHaveText('1 relation to other geometry will be left out');
  await moveTo(page, [80, -30, 0]);
  await expect.poll(() => previewMiddle(page)).toEqual([80, -30]);
  await clickAt(page, [80, -30, 0]);
  await sketchIdle(page);
  expect((await drawn(page)).lines).toBe(8);
  await expect(foot(frame)).toHaveText('Pasted 4 lines and 4 relations: 1 relation to other geometry was left out.');
  // The original's 2 DOF, and the copy's 4: its corner is no longer held at the origin.
  await expect(chip(frame)).toHaveText('Under defined · 6 DOF');
  // Settings > Keybinds reads the Part's commands file: Copy and Paste under Sketch.
  const file = (await (await request.get(`${baseUrl()}/plugins/cad/workspace/commands.json`)).json()) as { commands: { id: string; label: string; context: string; keys: string[] }[] };
  expect(file.commands.filter((c) => c.id === 'sketch.copy' || c.id === 'sketch.paste').map((c) => [c.label, c.context, c.keys])).toEqual([
    ['Copy', 'sketch', ['Ctrl+KeyC']],
    ['Paste', 'sketch', ['Ctrl+KeyV']],
  ]);
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-copy-paste-text-units Ctrl+C with the red reason selected copies that text, not the lines; a "2*15" dimension pasted into an inch Part keeps 30 mm, and the foot says so', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await rectangle(page, frame, [10, 10, 0], [40, 30, 0]);
  // Its bottom dimensioned with a unitless expression: 30 in this mm Part.
  await page.keyboard.press('d');
  await clickAt(page, [25, 10, 0]);
  await clickAt(page, [25, 3, 0]);
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await edit.fill('2*15');
  await edit.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('d');
  await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.dimension"]')).not.toHaveClass(/is-active/);
  expect((await drawn(page)).dims).toEqual(['2*15']);
  const selectLines = async () => {
    await clickAt(page, [25, 10, 0]);
    for (const p of [[40, 20, 0], [25, 30, 0], [10, 20, 0]] as V3[]) await clickAt(page, p, { shift: true });
  };
  await selectLines();
  await page.keyboard.press('Control+c');
  await expect(foot(frame)).toHaveText('Copied 4 lines, 4 relations and 1 dimension.');

  // A red reason in the foot (a binary DXF refused), the lines still selected; the person selects the reason's text and presses Ctrl+C.
  const chooser = page.waitForEvent('filechooser');
  await runCommand(frame, 'sketch.import');
  await (await chooser).setFiles({ name: 'b.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from(DXF_BINARY) });
  const said = 'Not imported: b.dxf is a binary DXF: save it as an ASCII DXF (R12 or later) and import that';
  await expect(foot(frame)).toHaveText(said);
  await workspaceFrame(page).evaluate(() => {
    const w = window as unknown as { __copiedText?: string[] };
    w.__copiedText = [];
    document.addEventListener('copy', () => w.__copiedText!.push(document.getSelection()?.toString().trim() ?? ''), true);
  });
  await foot(frame).click({ clickCount: 3 });
  await page.keyboard.press('Control+c');
  // The browser copied the text; the foot still says the reason (Copy did not take the key).
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __copiedText?: string[] }).__copiedText)).toEqual([said]);
  await expect(foot(frame)).toHaveText(said);
  // The lines clicked again in the view: the text is let go, and Ctrl+C copies them.
  await selectLines();
  expect(await workspaceFrame(page).evaluate(() => document.getSelection()?.toString() ?? '')).toBe('');
  await page.keyboard.press('Control+c');
  await expect(foot(frame)).toHaveText('Copied 4 lines, 4 relations and 1 dimension.');
  expect(await workspaceFrame(page).evaluate(() => (window as unknown as { __copiedText?: string[] }).__copiedText)).toEqual([said]);

  // A Part of an Imperial project (inches): Ctrl+V, a click places it; the dimension keeps 30 mm, said in the foot.
  await ensureCadOn(request);
  const r = await request.post(`${baseUrl()}/api/project`, { data: { title: `CAD e2e inches ${Date.now()}`, category: 'Other', units: 'Imperial' } });
  expect(r.ok(), await r.text()).toBe(true);
  await openProject(page, String((await r.json()).id));
  await newPartFromTree(page, 'Part 1');
  const inch = await partOpened(page);
  await expect(inch.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await enterSketchOnTop(page, inch);
  await page.keyboard.press('Control+v');
  await expect.poll(() => toolNow(page)).toBe('paste');
  await moveTo(page, [20, 10, 0]);
  await expect.poll(() => previewMiddle(page)).toEqual([20, 10]);
  await clickAt(page, [20, 10, 0]);
  await sketchIdle(page);
  expect(await drawn(page)).toEqual({ lines: 4, dims: ['30 mm'] });
  await expect(foot(inch)).toHaveText('Pasted 4 lines, 4 relations and 1 dimension: 1 dimension took the value it had (its expression "2*15" reads otherwise here).');
  expect(seen.errors).toEqual([]);
});
