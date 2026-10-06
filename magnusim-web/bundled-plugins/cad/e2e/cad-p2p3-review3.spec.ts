// P2+P3 review round 3 (INTEGRATE): one test per finding, each asserting what the
// user sees and failing without its fix. All at 1280 x 800, the reviewer's screen.
// Blockers:
//  1. boxes-chrome      A line's Length and Angle boxes stay clear of the Sketch panel,
//                       the tree, the dock's chips and the view buttons, and of each
//                       other: drawn toward the panel, just above the dock, ending at
//                       the frame's bottom edge, and with 0 typed. The box with the
//                       keyboard is what the page shows at its left, middle and right
//                       (they sat under the panel and the dock, and the Angle box under
//                       the Length box at the bottom edge and for a typed 0).
//  2. dims-reopen       A sketch reopened from the Front view (its framing changes the
//                       scale): a double-click on the 40 opens its editor at the first
//                       try, and a click on a label moves no label; after a wheel zoom
//                       too (every label jumped 9-16 px on the first click, so the
//                       double-click's second click missed).
// (Blocker 3, Daniel's Vortex STEP copied into the plugin, is checked by the unit test
// tests/arch/user-files.test.ts: no file in the plugin has his file's bytes.)
// Polish:
//  3. field-undo        Ctrl+Z with the keyboard still in a panel field after Enter
//                       takes the panel's change back, as it does with the field left
//                       (it undid only the field's text: field 45, the Box still 50).
//  4. missing-face      A Press-pull whose face is gone after Combine 1 is deleted: the
//                       row is marked "not found" in red, and a merged face is named
//                       with both faces it was made of (the row read "Face 6 of Box 1
//                       (merged)" with the normal outline).
//  5. menu-hover        In the tree's menu, hovering the disabled Delete highlights no
//                       other item, and hovering an item highlights only that one
//                       (Edit kept its highlight).
//  6. step-header       The exported STEP's FILE_NAME carries the file's name and a blank
//                       author (it said 'Open CASCADE Shape Model' and 'Author').
//  7. plane-labels      Origin plane labels are never drawn under a floating card ("Right"
//                       showed as "ght" beside a panel).
// window.__CAD__ is used only to project model points to the screen, to wait for sketch
// edits and the camera, to read the DOM's rectangles inside the frame, and (helpers.ts
// addSolid) to set sketched blocks up: there is no Box since decision 2026-10-01.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame, runCommand } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

test.use({ viewport: { width: 1280, height: 800 } });

type V3 = [number, number, number];
type Pt = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
type R = { left: number; top: number; right: number; bottom: number };

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
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  return { seen, frame };
}

const cad = <T, A = undefined>(page: Page, fn: (a: A) => T | Promise<T>, arg?: A) => workspaceFrame(page).evaluate(fn as never, arg) as Promise<T>;
const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel]');
const featureRow = (frame: FrameLocator, name: string) =>
  frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(\\(.\\) )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

async function at(page: Page, p: V3): Promise<Pt> {
  const xy = await cad<Pt | null, V3>(page, (q) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(q), p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + xy![0], box.y + xy![1]];
}

async function clickAt(page: Page, p: V3) {
  const [x, y] = await at(page, p);
  await page.mouse.move(x + 3, y + 3);
  await page.mouse.move(x, y, { steps: 2 });
  await page.mouse.click(x, y);
}

async function sweep(page: Page, from: V3, to: V3, n = 8) {
  for (let k = 1; k <= n; k++) {
    const [x, y] = await at(page, [from[0] + ((to[0] - from[0]) * k) / n, from[1] + ((to[1] - from[1]) * k) / n, from[2] + ((to[2] - from[2]) * k) / n]);
    await page.mouse.move(x, y);
  }
}

async function settled(page: Page) {
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
  // Two more frames: what each frame places (labels, boxes) has been placed.
  await cad(page, () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function sketchIdle(page: Page) {
  await cad(page, async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  });
}

async function sketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

async function finishSketch(frame: FrameLocator) {
  await tb(frame).locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

/** A block (corner, size): a rectangle sketched on Top and extruded (helpers.ts addSolid). */
const addBlock = (page: Page, origin: V3, size: V3) => addSolid(page, { at: origin, size });

/** Combine with one target and one tool picked from the tree; Done. */
async function combine(frame: FrameLocator, op: 'join' | 'cut' | 'intersect', target: number, tool: number, volume: string) {
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  const bodies = frame.locator('[data-cad-tree] [data-body-row]');
  await runCommand(frame, 'modify.combine');
  const p = panel(frame);
  await p.locator('[data-field="op"] select').selectOption(op);
  await p.locator('[data-pick-list="targets"]').click();
  await bodies.nth(target).locator('.tree-row').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  await bodies.nth(tool).locator('.tree-row').first().click();
  await expect(frame.locator('[data-chip="volume"]')).toContainText(volume, { timeout: 30_000 });
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
}

/**
 * The value boxes against what floats over the view (the tree card, the open panel, the
 * dock's chips, the view buttons and triad), each other and the view's edges; and, when a
 * box has the keyboard, what the page shows at its left, middle and right.
 */
const boxProblems = (page: Page, focus: boolean) =>
  cad<{ problems: string[]; boxes: Record<string, R> }, boolean>(page, (needFocus) => {
    const rect = (e: Element): R => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const hit = (a: R, b: R) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const boxes = Array.from(document.querySelectorAll('[data-sketch-box]')).map((i) => ({ id: i.getAttribute('data-sketch-box')!, wrap: i.parentElement!, r: rect(i.parentElement!) }));
    const chrome = [
      ...Array.from(document.querySelectorAll('[data-cad-tree]')).map((e) => ({ what: 'tree', r: rect(e) })),
      ...Array.from(document.querySelectorAll('[data-cad-panel]')).map((e) => ({ what: 'Sketch panel', r: rect(e) })),
      ...Array.from(document.querySelectorAll('[data-cad-dock] > *')).map((e) => ({ what: `dock chip "${(e.textContent ?? '').trim()}"`, r: rect(e) })),
      ...Array.from(document.querySelectorAll('[data-cad-gizmo] > *')).map((e) => ({ what: 'view buttons', r: rect(e) })),
    ].filter((c) => c.r.right > c.r.left && c.r.bottom > c.r.top);
    const stage = rect(document.querySelector('.cad-stage')!);
    const problems: string[] = [];
    const words = (r: R) => `[${[r.left, r.top, r.right, r.bottom].map(Math.round).join(',')}]`;
    if (boxes.length < 2) problems.push(`${boxes.length} value boxes`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i].r, boxes[j].r)) problems.push(`the ${boxes[i].id} box ${words(boxes[i].r)} overlaps the ${boxes[j].id} box ${words(boxes[j].r)}`);
    for (const b of boxes) {
      for (const c of chrome) if (hit(b.r, c.r)) problems.push(`the ${b.id} box ${words(b.r)} is under the ${c.what} ${words(c.r)}`);
      if (b.r.left < stage.left || b.r.top < stage.top || b.r.right > stage.right || b.r.bottom > stage.bottom) problems.push(`the ${b.id} box ${words(b.r)} is outside the view ${words(stage)}`);
    }
    if (needFocus) {
      const f = boxes.find((b) => b.wrap.contains(document.activeElement));
      if (!f) problems.push('no box has the keyboard');
      else {
        const y = (f.r.top + f.r.bottom) / 2;
        for (const [name, x] of [['left', f.r.left + 4], ['middle', (f.r.left + f.r.right) / 2], ['right', f.r.right - 4]] as [string, number][]) {
          const top = document.elementFromPoint(x, y);
          if (!top || !f.wrap.contains(top)) problems.push(`at the ${f.id} box's ${name} the page shows ${top ? top.outerHTML.slice(0, 70) : 'nothing'}`);
        }
      }
    }
    return { problems, boxes: Object.fromEntries(boxes.map((b) => [b.id, b.r])) };
  }, focus);

// ---------------------------------------------------------------- 1

test('cad:p2p3-review3-boxes-chrome the Length and Angle boxes stay clear of the Sketch panel, the dock, the bottom edge and each other; the focused one is seen whole', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  const length = frame.locator('[data-sketch-box="length"]');
  const angle = frame.locator('[data-sketch-box="angle"]');
  // Page px <-> sketch (u, v) on the Top plane, seen straight on.
  const o = await at(page, [0, 0, 0]);
  const ux = await at(page, [10, 0, 0]);
  const vy = await at(page, [0, 10, 0]);
  const ppu = (ux[0] - o[0]) / 10;
  const ppv = (vy[1] - o[1]) / 10;
  const uvOf = (x: number, y: number): V3 => [(x - o[0]) / ppu, (y - o[1]) / ppv, 0];
  const pageRect = async (sel: string) => (await frame.locator(sel).first().boundingBox())!;
  const pnl = await pageRect('[data-cad-panel]');
  const chips = await frame.locator('[data-cad-dock] > *').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })));
  const dockTop = fb.y + Math.min(...chips.map((c) => c.top));
  const dockLeft = fb.x + Math.min(...chips.map((c) => c.left));
  const dockRight = fb.x + Math.max(...chips.map((c) => c.right));
  const gizmo = await pageRect('[data-cad-gizmo]');
  const viewBottom = fb.y + fb.height;
  const cases: { name: string; from: Pt; dir: Pt; px: number; typed?: string }[] = [
    // (a) Toward the Sketch panel, ending 14 px right of it: the boxes' anchor is beside the panel.
    { name: 'toward the Sketch panel', from: [pnl.x + pnl.width + 64, pnl.y + pnl.height - 70], dir: [-1, 0], px: 50 },
    // (b) Down to just above the dock's chips.
    { name: 'just above the dock', from: [dockLeft + 70, dockTop - 46], dir: [0, 1], px: 36 },
    // (c) Down to the view's bottom edge, between the dock and the view buttons.
    { name: 'ending at the bottom edge', from: [(Math.max(dockRight, fb.x + 640) + gizmo.x) / 2, viewBottom - 48], dir: [0, 1], px: 40 },
    // (d) A typed 0: a zero-length preview, low in the view as the reviewer's (84 px above the bottom).
    { name: 'a typed 0', from: [fb.x + 760, viewBottom - 84], dir: [1, 0], px: 40, typed: '0' },
  ];
  await page.keyboard.press('l');
  for (const c of cases) {
    const from = uvOf(c.from[0], c.from[1]);
    const mm = Math.max(2, Math.round(c.px / Math.abs(c.dir[0] ? ppu : ppv)));
    const to: V3 = [from[0] + (c.dir[0] * mm * Math.sign(ppu)), from[1] + (c.dir[1] * mm * Math.sign(ppv)), 0];
    await clickAt(page, from);
    await sweep(page, from, to);
    await expect(length).toBeVisible();
    await expect(angle).toBeVisible();
    let r = await boxProblems(page, false);
    expect.soft(r.problems, `${c.name}, following the pointer: ${JSON.stringify(r.boxes)}`).toEqual([]);
    await page.keyboard.type(c.typed ?? String(mm));
    await expect(length).toBeFocused();
    await expect(length).toHaveValue(c.typed ?? String(mm));
    r = await boxProblems(page, true);
    expect.soft(r.problems, `${c.name}, Length typed: ${JSON.stringify(r.boxes)}`).toEqual([]);
    if (c.name === 'toward the Sketch panel') await shot(page, 'r3-boxes-panel');
    if (c.name === 'just above the dock') await shot(page, 'r3-boxes-dock');
    if (c.name === 'ending at the bottom edge') await shot(page, 'r3-boxes-bottom');
    if (c.typed) await shot(page, 'r3-boxes-typed0');
    await page.keyboard.press('Tab');
    await expect(angle).toBeFocused();
    r = await boxProblems(page, true);
    expect.soft(r.problems, `${c.name}, Angle focused: ${JSON.stringify(r.boxes)}`).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('l');
  }
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 2

/** Every dimension label's text and rectangle (page px). */
const labelRects = (frame: FrameLocator) =>
  frame.locator('[data-sketch-dim]').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { text: e.textContent ?? '', left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  );

function moved(a: { text: string; left: number; top: number; right: number; bottom: number }[], b: typeof a): string[] {
  const out: string[] = [];
  for (const x of a) {
    const y = b.find((k) => k.text === x.text);
    if (!y) out.push(`${x.text} is gone`);
    else if (Math.max(Math.abs(x.left - y.left), Math.abs(x.top - y.top), Math.abs(x.right - y.right), Math.abs(x.bottom - y.bottom)) > 1)
      out.push(`${x.text} moved from ${Math.round(x.left)},${Math.round(x.top)} to ${Math.round(y.left)},${Math.round(y.top)}`);
  }
  return out;
}

test('cad:p2p3-review3-dims-reopen a sketch reopened from the Front view: a double-click on the 40 edits it at once, and a click moves no label (after a wheel zoom too)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  // A rectangle typed 40 x 30 in its value boxes (its dimensions placed where they go by default).
  await page.keyboard.press('r');
  await clickAt(page, [0, 0, 0]);
  await sweep(page, [0, 0, 0], [44, 33, 0], 6);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type('40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('30');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['40', '30']);
  await finishSketch(frame);
  // Extrude 1 uses the rectangle, 10 mm.
  await clickAt(page, [20, 15, 0]);
  await page.keyboard.press('e');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(frame.locator('[data-chip="volume"]')).toContainText('12,000 mm³', { timeout: 30_000 });
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  // The Front view, then the sketch reopened from the history: its framing changes the scale.
  await tb(frame).locator('[data-command="view.front"]').click();
  await settled(page);
  await featureRow(frame, 'Sketch 1').locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['40', '30']);
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  const before = await labelRects(frame);
  await shot(page, 'r3-dims-reopened');
  // A double-click at the 40's centre, once: its editor has the keyboard.
  const l40 = before.find((x) => x.text === '40')!;
  await page.mouse.move(fb.x + (l40.left + l40.right) / 2, fb.y + (l40.top + l40.bottom) / 2);
  await page.mouse.dblclick(fb.x + (l40.left + l40.right) / 2, fb.y + (l40.top + l40.bottom) / 2);
  await expect(frame.locator('[data-sketch-dim-edit]'), 'the 40 editor after one double-click').toBeFocused({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-sketch-dim-edit]')).toHaveCount(0);
  expect(moved(before, await labelRects(frame)), 'labels after the editor closed').toEqual([]);
  // A click on the 30 selects it and moves no label.
  const l30 = before.find((x) => x.text === '30')!;
  await page.mouse.click(fb.x + (l30.left + l30.right) / 2, fb.y + (l30.top + l30.bottom) / 2);
  await expect(frame.locator('[data-sketch-dim]').filter({ hasText: /^30$/ })).toHaveAttribute('aria-pressed', 'true');
  expect(moved(before, await labelRects(frame)), 'labels after a click on the 30').toEqual([]);
  // A wheel zoom in sketch mode, then a click on the 40: no label moves.
  await page.mouse.move(fb.x + 900, fb.y + 420);
  await page.mouse.wheel(0, -360);
  await settled(page);
  const zoomed = await labelRects(frame);
  expect(moved(before, zoomed).length, 'the zoom moved the labels').toBeGreaterThan(0);
  const z40 = zoomed.find((x) => x.text === '40')!;
  await page.mouse.click(fb.x + (z40.left + z40.right) / 2, fb.y + (z40.top + z40.bottom) / 2);
  await expect(frame.locator('[data-sketch-dim]').filter({ hasText: /^40$/ })).toHaveAttribute('aria-pressed', 'true');
  expect(moved(zoomed, await labelRects(frame)), 'labels after a click following the zoom').toEqual([]);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 3

test('cad:p2p3-review3-field-undo Ctrl+Z with the keyboard still in a panel field takes the panel change back, as Undo does', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const volume = frame.locator('[data-chip="volume"]');
  // A 20 mm block, sketched and extruded; its Distance is the field.
  await addSolid(page);
  await expect(volume).toContainText('8000 mm³');
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  const size = panel(frame).locator('.nui[data-field="distance"] input');
  await size.fill('50');
  await size.press('Enter');
  await expect(volume).toContainText('20,000 mm³');
  await expect(size).toBeFocused();
  // The keyboard is still in the field: Ctrl+Z takes the panel's change back (the field showed
  // 20 while the block stayed 50 long).
  await page.keyboard.press('Control+z');
  await expect(panel(frame)).toHaveCount(0);
  await expect(volume).toContainText('8000 mm³');
  await page.keyboard.press('Control+y');
  await expect(volume).toContainText('20,000 mm³');
  // Typed but not applied: Ctrl+Z first drops the typing; the field and the block agree. (Chromium's
  // own text undo lands on 50 here too; tests/ui/number-unit-input.test.tsx checks the field does it.)
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  await size.fill('35');
  await page.keyboard.press('Control+z');
  await expect(size).toHaveValue('50');
  await expect(panel(frame)).toHaveCount(1);
  await expect(volume).toContainText('20,000 mm³');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(volume).toContainText('20,000 mm³');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 4

test('cad:p2p3-review3-missing-face a Press-pull whose merged face is gone after Combine 1 is deleted marks the row "not found" and names both faces', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // Two blocks side by side, joined: their tops merge into one face.
  await addBlock(page, [0, 0, 0], [20, 20, 20]);
  await addBlock(page, [20, 0, 0], [20, 20, 20]);
  await combine(frame, 'join', 0, 1, '16,000 mm³');
  await page.keyboard.press('5');
  await settled(page);
  await clickAt(page, [10, 10, 20]);
  await page.keyboard.press('q');
  const pp = panel(frame);
  const row = pp.locator('[data-pick-field="faces"] [data-pick-row]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.cad-pick-name')).toHaveText(/^Face \d+ of Body 1$/);
  await expect(row).not.toHaveAttribute('data-pick-missing', '1');
  const d = pp.locator('.nui[data-field="distance"] input');
  await d.fill('5');
  await d.press('Enter');
  await expect(frame.locator('[data-chip="volume"]')).toContainText('20,000 mm³', { timeout: 30_000 });
  await pp.locator('[data-panel-done]').click();
  // Combine 1 deleted: Body 1 is Extrude 1's block alone and the merged face is gone.
  await featureRow(frame, 'Combine 1').locator('> .tree-row').click({ button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="delete"]').click();
  await expect(featureRow(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await featureRow(frame, 'Press-pull 1').locator('> .tree-row').dblclick();
  await expect(pp.locator('[data-panel-title]')).toHaveText('Press-pull 1');
  const words = 'End face of Extrude 1 merged with End face of Extrude 2';
  await expect(row).toHaveAttribute('data-pick-missing', '1');
  await expect(row.locator('.cad-pick-name')).toHaveText(words);
  await expect(row.locator('[data-pick-sub]')).toHaveText('not found');
  await expect(row).toHaveAttribute('title', `Not on Body 1 now: ${words}. Remove it and pick the face again, or undo the change that removed it.`);
  // Red, not the normal outline.
  const colours = await row.evaluate((e) => ({ border: getComputedStyle(e).borderTopColor, sub: getComputedStyle(e.querySelector('[data-pick-sub]')!).color }));
  expect(colours).toEqual({ border: 'rgb(180, 35, 24)', sub: 'rgb(180, 35, 24)' });
  await expect(pp).not.toContainText('(merged)');
  await expect(pp).toContainText(`Press-pull 1 failed: ${words} not found on Body 1 after rebuild`);
  await shot(page, 'r3-missing-face');
  await pp.locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 5

test('cad:p2p3-review3-menu-hover hovering the disabled Delete in the tree menu highlights no other item; hovering an item highlights only it', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addBlock(page, [0, 0, 0], [20, 20, 20]);
  await addBlock(page, [10, 0, 0], [20, 20, 20]);
  await combine(frame, 'join', 0, 1, '12,000 mm³');
  // The keyboard was used last (Escape), as when the reviewer opened the menu: the first item it
  // focuses shows the focus ring.
  await page.keyboard.press('Escape');
  await featureRow(frame, 'Extrude 2').locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  const del = menu.locator('[data-menu-item="delete"]');
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  const lit = () =>
    menu.locator('[role="menuitem"]').evaluateAll((els) => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--cad-menu-hover)';
      document.body.append(probe);
      const hover = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return els.filter((e) => getComputedStyle(e).backgroundColor === hover).map((e) => e.getAttribute('data-menu-item'));
    });
  await del.hover();
  await expect(frame.locator('[role="tooltip"]')).toContainText('Delete Extrude 2');
  await expect.poll(lit).toEqual([]);
  await shot(page, 'r3-menu-hover-delete');
  await menu.locator('[data-menu-item="rename"]').hover();
  await expect.poll(lit).toEqual(['rename']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 6

test("cad:p2p3-review3-step-header the exported STEP's FILE_NAME names the file and leaves the author blank", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page);
  await runCommand(frame, 'file.export-step');
  const ex = panel(frame);
  const dl = page.waitForEvent('download');
  await ex.locator('[data-export-run]').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('Part 1.step');
  const path = join(tmpdir(), `cad-r3-header-${Date.now()}.step`);
  await download.saveAs(path);
  const text = readFileSync(path, 'latin1');
  const header = text.slice(0, text.indexOf('ENDSEC;'));
  expect(header).toMatch(/^ISO-10303-21;\r?\nHEADER;/);
  const fileName = /FILE_NAME\(([\s\S]*?)\);/.exec(header)?.[1].replace(/\s*\r?\n\s*/g, '') ?? '';
  expect(fileName).toMatch(/^'Part 1\.step','\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d',\(''\),\(''\),'Open CASCADE STEP processor [\d.]+','Magnusim CAD',''$/);
  expect(header).not.toContain('Open CASCADE Shape Model');
  expect(header).not.toContain("'Author'");
  // The rest of the file is the kernel's, byte for byte in shape: one solid, the data section.
  expect(text).toContain('MANIFOLD_SOLID_BREP');
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
  await ex.locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 7

test('cad:p2p3-review3-plane-labels origin plane labels are never drawn under a floating card (the Right label beside the Parameters panel)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await settled(page);
  const labels = () =>
    cad<{ shown: string[]; problems: string[] }>(page, () => {
      const rect = (e: Element) => e.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll('[data-cad-tree], [data-cad-panel], [data-cad-dock] > *, [data-cad-gizmo] > *')).map(rect).filter((r) => r.width > 0 && r.height > 0);
      const shown = Array.from(document.querySelectorAll<HTMLElement>('[data-plane-label]')).filter((e) => e.style.display !== 'none' && rect(e).width > 0);
      const problems: string[] = [];
      for (const e of shown) {
        const r = rect(e);
        // (Labels take no pointer, so elementFromPoint cannot see them: the rectangles say it.)
        if (cards.some((c) => r.left < c.right && c.left < r.right && r.top < c.bottom && c.top < r.bottom)) problems.push(`${e.textContent} at ${Math.round(r.left)},${Math.round(r.top)} is under a card`);
      }
      return { shown: shown.map((e) => e.textContent ?? ''), problems };
    });
  let s = await labels();
  expect(s.shown.sort()).toEqual(['Front', 'Right', 'Top']);
  expect(s.problems).toEqual([]);
  // The Parameters panel opens over the left of the view.
  await runCommand(frame, 'modify.parameters');
  await expect(panel(frame)).toHaveCount(1);
  await settled(page);
  s = await labels();
  expect(s.problems, `labels shown: ${s.shown.join(', ')}`).toEqual([]);
  expect(s.shown.length, 'labels shown').toBeGreaterThanOrEqual(2);
  await shot(page, 'r3-plane-labels');
  await panel(frame).locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
