// CAD 0.1.0 sketch UX round (ux010, PANELS; Daniel 2026-10-07): "it also doesn't need to show the
// full part tree when I'm working on a sketch ... collapse [sideways], not collapse up ... Same with
// the sketch", and the Sketch panel "only show the absolutely necessary information. So if I adjust
// the dimension, it could just show that dimension there".
// - Entering a sketch slides the design tree into a 32 px rail at the left edge (its rows gone);
//   Done brings it back; a click on the rail shows it for that sketch, and it stays.
// - The Sketch panel is compact (head, the tool's hint and inputs, the dimension being edited, Done);
//   Details opens the rest; a problem (the conflicting constraints) shows while compact.
// - The panel's chevron slides it into its own rail (Finish sketch on it), kept for the next sketch
//   and through a reopen (ws.prefs); Ctrl+\ does the same.
// - Model mode's tree chevron is the user's, kept through a reopen; a sketch leaves it as it was.
// - The left column at 1280 x 800 before and after (the numbers are logged), and fit-to-view uses
//   the room the rails free ([data-view-cover]).
// The tests that change the user's prefs run in the serial phase (one prefs file per server) and
// put them back.
// Owner: ux010 PANELS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, baseUrl, cadPref, forgetRailPrefs, modelOnPage, newPartFromTree, newProject, openPart, openProject, openSketchDetails, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

const SHOTS = process.env.CAD_UX010_SHOTS || '';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function idle(page: Page) {
  const f = workspaceFrame(page);
  await expect.poll(() => f.evaluate(() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } | null } } } } }).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
  await f.evaluate(async () => {
    await (window as unknown as { __CAD__: { services: { apis: { get(): { sketch?: { idle?(): Promise<void> } | null } } } } }).__CAD__.services.apis.get().sketch?.idle?.();
  });
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** The left column in the frame (CSS px): what [data-view-cover] covers of the view, and its parts. */
async function leftColumn(page: Page) {
  // The rails slide in (140 ms): measure once nothing moves.
  await page.waitForTimeout(200);
  return workspaceFrame(page).evaluate(() => {
    const c = document.querySelector('[data-cad-viewport] canvas')!.getBoundingClientRect();
    const box = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      return { left: Math.round(r.left - c.left), right: Math.round(r.right - c.left), top: Math.round(r.top - c.top), bottom: Math.round(r.bottom - c.top), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const cover = document.querySelector<HTMLElement>('[data-view-cover]')!.getBoundingClientRect();
    return {
      view: Math.round(c.width),
      cover: Math.round(cover.right - c.left),
      tree: box('[data-cad-tree]'),
      treeRail: box('[data-cad-rail="tree"]'),
      panel: box('[data-cad-panel="sketch"]'),
      panelRail: box('[data-cad-rail="sketch"]'),
    } as { view: number; cover: number; tree: Box | null; treeRail: Box | null; panel: Box | null; panelRail: Box | null };
  });
}

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(frame.locator('[data-cad-left-stack]')).toHaveAttribute('data-rails-ready', '1');
  return { seen, frame };
}

async function sketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
}

/** A sketch with the tree collapsed in model mode: the tree shown to pick the Top plane, its chevron, then Sketch. */
async function sketchOnTopFromRail(page: Page, frame: FrameLocator) {
  await frame.locator('[data-cad-rail="tree"]').click();
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-tree-collapse]').click();
  await expect(frame.locator('[data-cad-rail="tree"]')).toBeVisible();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
}

async function finish(frame: FrameLocator) {
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

/** A W x D rectangle from the origin with the R tool and typed sizes (its two dimensions); then Escape (Select) unless `keepTool`. */
async function rectangle(page: Page, frame: FrameLocator, w: number, d: number, keepTool = false) {
  await page.keyboard.press('r');
  await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.rectangle"]')).toHaveClass(/is-active/);
  const o = await modelOnPage(page, [0, 0, 0]);
  await page.mouse.click(o[0], o[1]);
  const far = await modelOnPage(page, [w * 0.7, d * 0.7, 0]);
  await page.mouse.move(far[0], far[1]);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type(String(w));
  await page.keyboard.press('Tab');
  await page.keyboard.type(String(d));
  await page.keyboard.press('Enter');
  await idle(page);
  if (!keepTool) await page.keyboard.press('Escape');
}

/** What the compact panel's body shows, by part (its visible children). */
async function panelParts(frame: FrameLocator): Promise<string[]> {
  return frame.locator('[data-cad-panel="sketch"] [data-sketch-panel] > *').evaluateAll((els) =>
    els
      .filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => {
        const a = (n: string) => el.hasAttribute(n) || !!el.querySelector(`[${n}]`);
        if (a('data-sketch-hint')) return 'hint';
        if (a('data-sketch-options')) return 'tool-inputs';
        if (a('data-sketch-line-arc')) return 'tool-inputs';
        if (a('data-sketch-dimension')) return 'dimension';
        if (a('data-sketch-plane')) return 'plane';
        if (a('data-sketch-selection')) return 'selection';
        if (a('data-sketch-conflicts')) return 'conflicts';
        if (a('data-sketch-ties') || a('data-tie-notice')) return 'patterns';
        if (a('data-sketch-links')) return 'references';
        return `other: ${(el.textContent ?? '').slice(0, 40)}`;
      }),
  );
}

test('cad:ux010-panels-tree-rail entering a sketch slides the tree into a rail at the left edge (rows gone); a click on the rail shows it for that sketch and it stays; its chevron hides it again; Done brings it back; the next sketch starts with the rail', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const stack = frame.locator('[data-cad-left-stack]');
  const tree = frame.locator('[data-cad-tree]');
  const rail = frame.locator('[data-cad-rail="tree"]');
  // Model mode: the card, 240 px, with its rows.
  await expect(tree).toBeVisible();
  await expect(rail).toHaveCount(0);
  await expect(frame.locator('[data-tree-node="origin:top"] > .tree-row')).toBeVisible();
  const model = await leftColumn(page);
  expect(model.tree!.width).toBe(240);

  await sketchOnTop(page, frame);
  // Sketch mode: a 32 px rail at the left edge, no tree rows; the Sketch panel right beside it.
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAccessibleName('Show the design tree');
  await expect(tree).toHaveCount(0);
  await expect(frame.locator('[data-tree-node]')).toHaveCount(0);
  await expect(stack).toHaveAttribute('data-tree-rail', '1');
  let col = await leftColumn(page);
  expect(col.treeRail!.width).toBe(32);
  expect(col.treeRail!.left).toBe(12);
  expect(col.panel!.left).toBe(col.treeRail!.right + 8);
  expect(col.cover).toBe(col.panel!.right);
  await expect(rail.locator('.cad-rail-label')).toHaveText('Design tree');

  // A click on the rail shows the tree for this sketch: a plane can be picked there.
  await rail.click();
  await expect(tree).toBeVisible();
  await expect(rail).toHaveCount(0);
  await frame.locator('[data-tree-node="origin:front"] > .tree-row').click();
  await expect(frame.locator('[data-tree-node="origin:front"]')).toHaveClass(/selected/);
  col = await leftColumn(page);
  expect(col.panel!.left).toBe(col.tree!.right + 8);
  // Drawing does not take it away (the app never fights the user's click).
  await rectangle(page, frame, 30, 20);
  await expect(tree).toBeVisible();
  // Its chevron hides it again (for this sketch).
  await frame.locator('[data-tree-collapse]').click();
  await expect(rail).toBeVisible();
  await expect(tree).toHaveCount(0);
  await rail.click();
  await expect(tree).toBeVisible();

  // Done: the tree as in model mode.
  await frame.locator('[data-cad-panel="sketch"] [data-panel-done]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await expect(tree).toBeVisible();
  await expect(rail).toHaveCount(0);

  // The next sketch starts with the rail again (showing it was for that sketch), and Done with the rail brings the card back too.
  await sketchOnTop(page, frame);
  await expect(rail).toBeVisible();
  await expect(tree).toHaveCount(0);
  await finish(frame);
  await expect(tree).toBeVisible();
  await expect(frame.locator('[data-feature-row]')).toHaveCount(2);
  // No pref was written: the rail while sketching is not the user's model-mode choice.
  expect(await cadPref(request, 'tree-collapsed')).toBeNull();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// Serial: it reads the Details pref, which another test's openSketchDetails holds for a moment.
test('cad:ux010-panels-error-compact a problem stays in view while the panel is compact: the conflicting constraints and the red state', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  const { seen, frame } = await freshPart(page, request);
  // A sketch saved with a line dimensioned twice (40 and 50): sketch mode opens on it.
  await workspaceFrame(page).evaluate(() => {
    const doc = (window as unknown as { __CAD__: { services: { doc: { beginNew(t: string, init: object): unknown } } } }).__CAD__.services.doc;
    doc.beginNew('sketch', {
      support: { kind: 'plane', plane: 'origin:top' },
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
      points: { a: [0, 0], b: [40, 0] },
      entities: [{ id: 'l1', kind: 'line', p: ['a', 'b'] }],
      constraints: [
        { id: 'd1', kind: 'distance', refs: ['l1'], expr: '40 mm', driving: true, at: [20, -10] },
        { id: 'd2', kind: 'distance', refs: ['l1'], expr: '50 mm', driving: true, at: [20, 10] },
      ],
      solved: { values: { d1: 40, d2: 50 }, dof: 0, state: 'over' },
    });
  });
  const panel = frame.locator('[data-cad-panel="sketch"]');
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(panel.locator('[data-sketch-details]')).toHaveAttribute('data-sketch-details', 'closed');
  await expect(panel.locator('[data-sketch-state]')).toHaveText(/^Over defined · [12] conflicting$/);
  await expect(panel.locator('[data-sketch-state]')).toHaveCSS('color', 'rgb(180, 35, 24)');
  await expect(panel.locator('[data-sketch-conflicts]')).toBeVisible();
  await expect(panel.locator('[data-sketch-conflicts] .cad-field-group-title')).toHaveText('Conflicting constraints');
  await expect(panel.locator('[data-sketch-conflicts] li').first()).toContainText('Distance');
  expect(await panelParts(frame)).toEqual(['hint', 'conflicts']);
  await expect(panel.locator('[data-sketch-plane]')).toHaveCount(0);
  // Fixed from the compact panel: one click deletes one.
  await panel.locator('[data-conflict-delete="d2"]').click();
  await idle(page);
  await expect(panel.locator('[data-sketch-state]')).toHaveText('Under defined · 3 DOF');
  await expect(panel.locator('[data-sketch-conflicts]')).toHaveCount(0);
  await finish(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:ux010-panels-compact compact by default: drawing a line with a dimension being edited shows only the head, the tool hint, that dimension and Done; Details opens the rest and is kept through a reopen', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    await sketchOnTop(page, frame);
    const panel = frame.locator('[data-cad-panel="sketch"]');
    await expect(panel.locator('[data-sketch-details]')).toHaveAttribute('data-sketch-details', 'closed');
    await expect(panel.locator('[data-sketch-details]')).toHaveText('Details ▸');
    // The head: the name, the state dot and words, the chevron.
    await expect(panel.locator('.mgk-panel-head')).toContainText('Sketch 1');
    await expect(panel.locator('.mgk-panel-head [data-sketch-state]')).toHaveText('No geometry yet');
    await expect(panel.locator('.mgk-panel-head [data-sketch-collapse]')).toBeVisible();
    // A line, 30 mm typed (its length dimension).
    await page.keyboard.press('l');
    const o = await modelOnPage(page, [0, 0, 0]);
    await page.mouse.click(o[0], o[1]);
    const far = await modelOnPage(page, [20, 0, 0]);
    await page.mouse.move(far[0], far[1]);
    await expect(frame.locator('[data-sketch-box="length"]')).toBeVisible();
    await page.keyboard.type('30');
    await page.keyboard.press('Enter');
    await idle(page);
    // Still drawing (the chain is open): the line tool's hint and its input (Tangent arc next).
    await expect(panel.locator('[data-sketch-line-arc]')).toBeVisible();
    await page.keyboard.press('Escape');
    await idle(page);
    // The dimension's value box opens (double-click its label) while the Line tool is on.
    await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.line"]')).toHaveClass(/is-active/);
    const label = frame.locator('[data-sketch-dim]').first();
    await expect(label).toHaveText('30 mm');
    await label.dblclick();
    const dim = panel.locator('[data-sketch-dimension]');
    await expect(dim).toBeVisible();
    await expect(dim).toHaveAttribute('data-dimension-editing', '1');
    await expect(dim).toContainText('30 mm');
    expect(await panelParts(frame)).toEqual(['hint', 'dimension']);
    await expect(panel.locator('[data-sketch-hint]')).not.toBeEmpty();
    await expect(panel.locator('[data-panel-done]')).toBeVisible();
    // Behind Details: the plane, the tips.
    await expect(panel.locator('[data-sketch-plane]')).toHaveCount(0);
    await expect(panel).not.toContainText('Ctrl while drawing adds no constraints');
    await shot(page, 'compact-dimension-1280x800');
    // A new value: the panel follows.
    await page.keyboard.press('Control+a');
    await page.keyboard.type('45');
    await page.keyboard.press('Enter');
    await idle(page);
    await expect(dim).toContainText('45 mm');
    await expect(dim).toHaveAttribute('data-dimension-editing', '0');
    // Details: the rest (the plane, the tips; a selection and its actions).
    await panel.locator('[data-sketch-details]').click();
    await expect(panel.locator('[data-sketch-details]')).toHaveAttribute('data-sketch-details', 'open');
    await expect(panel.locator('[data-sketch-details]')).toHaveText('Details ▾');
    await expect(panel.locator('[data-sketch-plane]')).toHaveText('Top plane');
    await expect(panel).toContainText('Ctrl while drawing adds no constraints');
    await expect.poll(() => cadPref(request, 'sketch-details-open')).toBe(true);
    await finish(frame);
    // Kept: the next sketch, and a reopen of the Part.
    await sketchOnTop(page, frame);
    await expect(panel.locator('[data-sketch-plane]')).toBeVisible();
    await finish(frame);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#workspace-overlay')).toBeHidden();
    const again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').first());
    await expect(again.locator('[data-cad-left-stack]')).toHaveAttribute('data-rails-ready', '1');
    await sketchOnTop(page, again);
    const p2 = again.locator('[data-cad-panel="sketch"]');
    await expect(p2.locator('[data-sketch-details]')).toHaveAttribute('data-sketch-details', 'open');
    await expect(p2.locator('[data-sketch-plane]')).toBeVisible();
    // Closed again: compact, and kept closed (the pref is removed).
    await p2.locator('[data-sketch-details]').click();
    await expect(p2.locator('[data-sketch-plane]')).toHaveCount(0);
    await expect.poll(() => cadPref(request, 'sketch-details-open')).toBeNull();
    await finish(again);
    expect(seen.csp).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

test('cad:ux010-panels-collapse the Sketch panel collapses to a rail at the left edge (under the tree rail), Finish sketch on it, Ctrl+\\ both ways; kept for the next sketch and through a reopen; a problem marks the rail', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    await sketchOnTop(page, frame);
    await rectangle(page, frame, 30, 20);
    const panel = frame.locator('[data-cad-panel="sketch"]');
    const rail = frame.locator('[data-cad-rail="sketch"]');
    const treeRail = frame.locator('[data-cad-rail="tree"]');
    await panel.locator('[data-sketch-collapse]').click();
    await expect(rail).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(rail).toHaveAttribute('data-sketch-state', 'fully');
    await expect(rail.locator('.cad-rail-label')).toHaveText('Sketch 1');
    let col = await leftColumn(page);
    // Both rails, one above the other at the left edge: the view keeps all but 44 px.
    expect(col.panelRail!.width).toBe(32);
    expect(col.panelRail!.left).toBe(col.treeRail!.left);
    expect(col.panelRail!.top).toBeGreaterThanOrEqual(col.treeRail!.bottom + 8);
    expect(col.cover).toBe(44);
    await shot(page, 'rails-1280x800');
    // Finish sketch on the rail: its tooltip says so.
    await rail.locator('[data-rail-done]').hover();
    await expect(frame.locator('[role="tooltip"]')).toContainText('Finish sketch');
    // Ctrl+\ expands, and collapses again.
    await page.mouse.move(700, 500);
    await page.keyboard.press('Control+\\');
    await expect(panel).toBeVisible();
    await expect(rail).toHaveCount(0);
    await expect.poll(() => cadPref(request, 'sketch-panel-collapsed')).toBeNull();
    await page.keyboard.press('Control+\\');
    await expect(rail).toBeVisible();
    await expect.poll(() => cadPref(request, 'sketch-panel-collapsed')).toBe(true);
    // The rail's Finish sketch ends the sketch: the tree is back.
    await rail.locator('[data-rail-done]').click();
    await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
    await expect(frame.locator('[data-cad-tree]')).toBeVisible();
    await expect(treeRail).toHaveCount(0);

    // Kept: the next sketch opens collapsed; a problem in it marks the rail.
    await workspaceFrame(page).evaluate(() => {
      const doc = (window as unknown as { __CAD__: { services: { doc: { beginNew(t: string, init: object): unknown } } } }).__CAD__.services.doc;
      doc.beginNew('sketch', {
        support: { kind: 'plane', plane: 'origin:top' },
        plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
        points: { a: [0, 0], b: [40, 0] },
        entities: [{ id: 'l1', kind: 'line', p: ['a', 'b'] }],
        constraints: [
          { id: 'd1', kind: 'distance', refs: ['l1'], expr: '40 mm', driving: true, at: [20, -10] },
          { id: 'd2', kind: 'distance', refs: ['l1'], expr: '50 mm', driving: true, at: [20, 10] },
        ],
        solved: { values: { d1: 40, d2: 50 }, dof: 0, state: 'over' },
      });
    });
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('data-sketch-state', 'over');
    await expect(rail.locator('[data-rail-alert]')).toBeVisible();
    await expect(rail.locator('[data-rail-expand]')).toHaveAccessibleName(/^Show the Sketch 2 panel: Over defined · [12] conflicting$/);
    // Expanded from the rail: the conflicts are there; delete one, collapse again, Finish.
    await rail.locator('[data-rail-expand]').click();
    await expect(panel.locator('[data-sketch-conflicts]')).toBeVisible();
    await panel.locator('[data-conflict-delete="d2"]').click();
    await idle(page);
    await expect(panel.locator('[data-sketch-state]')).toHaveText('Under defined · 3 DOF');
    await panel.locator('[data-sketch-collapse]').click();
    await expect(rail.locator('[data-rail-alert]')).toHaveCount(0);
    await rail.locator('[data-rail-done]').click();
    await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();

    // Through a reopen of the Part: still collapsed (the user's pref).
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#workspace-overlay')).toBeHidden();
    const again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').first());
    await expect(again.locator('[data-cad-left-stack]')).toHaveAttribute('data-rails-ready', '1');
    await sketchOnTop(page, again);
    await expect(again.locator('[data-cad-rail="sketch"]')).toBeVisible();
    await expect(again.locator('[data-cad-panel="sketch"]')).toHaveCount(0);
    await again.locator('[data-cad-rail="sketch"] [data-rail-expand]').click();
    await expect(again.locator('[data-cad-panel="sketch"]')).toBeVisible();
    await expect.poll(() => cadPref(request, 'sketch-panel-collapsed')).toBeNull();
    await finish(again);
    expect(seen.csp).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

test("cad:ux010-panels-model-tree model mode's tree chevron is the user's: a rail kept through a reopen; a sketch leaves it a rail after Done; a click on the rail brings it back for good", { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    const tree = frame.locator('[data-cad-tree]');
    const rail = frame.locator('[data-cad-rail="tree"]');
    await frame.locator('[data-tree-collapse]').click();
    await expect(rail).toBeVisible();
    await expect(tree).toHaveCount(0);
    await expect.poll(() => cadPref(request, 'tree-collapsed')).toBe(true);
    const col = await leftColumn(page);
    expect(col.treeRail!.width).toBe(32);
    expect(col.cover).toBe(44);
    // A sketch (the tree shown to pick the plane, then its chevron): the rail; Done: the rail again (the user's choice).
    await sketchOnTopFromRail(page, frame);
    await expect(rail).toBeVisible();
    await expect(tree).toHaveCount(0);
    await finish(frame);
    await expect(rail).toBeVisible();
    await expect(tree).toHaveCount(0);
    // Ctrl+\ in model mode: the tree.
    await page.mouse.move(700, 500);
    await page.keyboard.press('Control+\\');
    await expect(tree).toBeVisible();
    await page.keyboard.press('Control+\\');
    await expect(rail).toBeVisible();
    // Through a reopen.
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#workspace-overlay')).toBeHidden();
    const again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').first());
    await expect(again.locator('[data-cad-left-stack]')).toHaveAttribute('data-rails-ready', '1');
    await expect(again.locator('[data-cad-rail="tree"]')).toBeVisible();
    await expect(again.locator('[data-cad-tree]')).toHaveCount(0);
    // The rail brings it back for good.
    await again.locator('[data-cad-rail="tree"]').click();
    await expect(again.locator('[data-cad-tree]')).toBeVisible();
    await expect.poll(() => cadPref(request, 'tree-collapsed')).toBeNull();
    expect(seen.csp).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

test('cad:ux010-panels-measure the left column at 1280 x 800: model, sketch (tree rail and compact panel), both rails; Fit centres the sketch in the room left free', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  const { frame } = await freshPart(page, request);
  const model = await leftColumn(page);
  await sketchOnTop(page, frame);
  // As the "before" shot was taken: the Rectangle tool still on after a 40 x 25 rectangle.
  await rectangle(page, frame, 40, 25, true);
  const sketch = await leftColumn(page);
  console.log(`[ux010] model ${JSON.stringify(model)}`);
  console.log(`[ux010] sketch ${JSON.stringify(sketch)}`);
  await shot(page, `sketch-1280x800-${process.env.CAD_UX010_TAG || 'after'}`);
  // Before ux010 (measured on the same frame): the tree card 240 px + the Sketch panel 360 px covered 620 px.
  expect(sketch.view).toBe(1280);
  expect(model.cover).toBe(252);
  expect(sketch.panel!.width).toBe(288);
  expect(sketch.cover).toBe(12 + 32 + 8 + 288);
  // Fit (F) centres the framed sketch (its curves and dimensions: the camera's target) in what the column leaves free.
  await page.keyboard.press('f');
  await idle(page);
  const centre = () =>
    workspaceFrame(page).evaluate(() => {
      const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { camera(): { target: number[] }; project(p: number[]): [number, number] | null } } } } } }).__CAD__.services.viewport.get().handle;
      return h.project(h.camera().target)![0];
    });
  const free = (cover: number, view: number) => cover + (view - cover) / 2;
  expect(Math.abs((await centre()) - free(sketch.cover, sketch.view))).toBeLessThan(2);
  // Fit with both rails: the free room is wider, and the rectangle centres in it.
  await page.keyboard.press('Control+\\');
  await expect(frame.locator('[data-cad-rail="sketch"]')).toBeVisible();
  const rails = await leftColumn(page);
  expect(rails.cover).toBe(44);
  console.log(`[ux010] rails ${JSON.stringify(rails)}`);
  await page.keyboard.press('f');
  await idle(page);
  expect(Math.abs((await centre()) - free(rails.cover, rails.view))).toBeLessThan(2);
  await page.keyboard.press('Control+\\');
  await expect(frame.locator('[data-cad-panel="sketch"]')).toBeVisible();
  await finish(frame);
  // Ctrl+\ wrote the user's pref and took it back.
  await expect.poll(() => cadPref(request, 'sketch-panel-collapsed')).toBeNull();
});

/** The sketch's points' smallest and largest u (sketch mode's draft). */
async function uRange(page: Page): Promise<[number, number]> {
  return workspaceFrame(page).evaluate(() => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { draft(): { points: Record<string, [number, number]> } | null } } } } } }).__CAD__.services.apis.get().sketch;
    const us = Object.values(api.draft()?.points ?? {}).map((p) => p[0]);
    return [Math.min(...us), Math.max(...us)];
  });
}

test('cad:ux010-panels-tool-card the collapsed panel shows the active tool\'s inputs in a tool card beside its rail (Offset: the distance typed there is the one placed); gone when the tool ends; in the panel again when it opens', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    await sketchOnTop(page, frame);
    await rectangle(page, frame, 30, 20);
    const panel = frame.locator('[data-cad-panel="sketch"]');
    const rail = frame.locator('[data-cad-rail="sketch"]');
    const card = frame.locator('[data-sketch-tool-card]');
    await panel.locator('[data-sketch-collapse]').click();
    await expect(rail).toBeVisible();
    // Select has no inputs: no card.
    await expect(card).toHaveCount(0);
    // Offset: its card, beside the rail, with its one-line hint and its own fields only.
    await page.mouse.move(700, 500);
    await page.keyboard.press('o');
    await expect(card).toHaveAttribute('data-sketch-tool-card', 'offset');
    await expect(card).toBeVisible();
    await expect(card.locator('[data-sketch-hint]')).toHaveText('Point at a curve, then click to place the offset.');
    await expect(card.locator('[data-sketch-hint]')).toHaveAttribute('title', "Point at a curve: its chain is offset to the pointer's side. Click to place it.");
    await expect(card.locator('[data-sketch-options="offset"] [data-field-row]')).toHaveCount(1);
    await expect(card.locator('[data-sketch-option="both"]')).toBeVisible();
    await expect(card.locator('[data-panel-done], [data-sketch-details], .mgk-panel-head')).toHaveCount(0);
    const col = await leftColumn(page);
    const cardBox = await card.boundingBox();
    const frameBox = (await page.locator('#workspace-frame').boundingBox())!;
    expect(Math.round(cardBox!.x - frameBox.x)).toBe(col.panelRail!.right + 8);
    expect(col.cover).toBe(col.panelRail!.right + 8 + Math.round(cardBox!.width));
    await shot(page, 'tool-card-1280x800');
    // 3 mm typed in the card: the offset placed outside the rectangle is 3 mm away.
    const dist = card.locator('.nui[data-field="sk-distance"] input');
    await dist.fill('3');
    await dist.press('Enter');
    const [x, y] = await modelOnPage(page, [15, -2, 0]);
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await idle(page);
    const [u0, u1] = await uRange(page);
    expect(u0).toBeCloseTo(-3, 6);
    expect(u1).toBeCloseTo(33, 6);
    // The tool ends: the card goes.
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    // Offset again, then the panel opened: its inputs are in the panel, no card.
    await page.keyboard.press('o');
    await expect(card).toBeVisible();
    await rail.locator('[data-rail-expand]').click();
    await expect(card).toHaveCount(0);
    await expect(panel.locator('[data-sketch-options="offset"] .nui[data-field="sk-distance"] input')).toBeVisible();
    await page.keyboard.press('Escape');
    await finish(frame);
    expect(seen.csp).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

test('cad:ux010-panels-hint-line the compact panel shows a hint in one line (the tool\'s short version or its first sentence), the full hint as its tooltip and under Details', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    await sketchOnTop(page, frame);
    const panel = frame.locator('[data-cad-panel="sketch"]');
    const hint = panel.locator('[data-sketch-hint]');
    const oneLine = async () => {
      const h = await hint.evaluate((el) => {
        const t = el.firstElementChild as HTMLElement;
        return { h: t.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(t).lineHeight) || parseFloat(getComputedStyle(t).fontSize) * 1.5 };
      });
      expect(h.h, 'one line').toBeLessThanOrEqual(h.lh + 1);
    };
    // Select (5 lines in full): its short version.
    await expect(hint).toHaveText('Click to select; Ctrl+drag to box select.');
    await expect(hint).toHaveAttribute('title', /^Click to select \(Ctrl toggles, Shift adds; .+drag elsewhere to orbit\.$/);
    await oneLine();
    // Line, chain open: the short version; before the first click: the first sentence.
    await page.keyboard.press('l');
    await expect(hint).toHaveText('Click where the line starts.');
    await expect(hint).toHaveAttribute('title', 'Click where the line starts. Ctrl draws without inferred constraints.');
    await oneLine();
    const o = await modelOnPage(page, [0, 0, 0]);
    await page.mouse.click(o[0], o[1]);
    await expect(hint).toHaveText('Click the next point, or type a length.');
    await oneLine();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // Rectangle, second corner: the short version.
    await page.keyboard.press('r');
    await page.mouse.click(o[0], o[1]);
    await expect(hint).toHaveText('Click the opposite corner, or type its size.');
    await oneLine();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // Details: the hint in full.
    await panel.locator('[data-sketch-details]').click();
    await expect(hint).toHaveText(/^Click to select \(Ctrl toggles, Shift adds; .+drag elsewhere to orbit\.$/);
    await panel.locator('[data-sketch-details]').click();
    await finish(frame);
    expect(seen.csp).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

// ---------------------------------------------------------------- review round (review-panels.md)

/** A sketch saved with a line dimensioned twice (40 and 50): sketch mode opens on it. */
async function conflictingSketch(page: Page) {
  await workspaceFrame(page).evaluate(() => {
    const doc = (window as unknown as { __CAD__: { services: { doc: { beginNew(t: string, init: object): unknown } } } }).__CAD__.services.doc;
    doc.beginNew('sketch', {
      support: { kind: 'plane', plane: 'origin:top' },
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
      points: { a: [0, 0], b: [40, 0] },
      entities: [{ id: 'l1', kind: 'line', p: ['a', 'b'] }],
      constraints: [
        { id: 'd1', kind: 'distance', refs: ['l1'], expr: '40 mm', driving: true, at: [20, -10] },
        { id: 'd2', kind: 'distance', refs: ['l1'], expr: '50 mm', driving: true, at: [20, 10] },
      ],
      solved: { values: { d1: 40, d2: 50 }, dof: 0, state: 'over' },
    });
  });
}

test('cad:ux010-panels-review-delete-head a used sketch\'s compact panel says why there is no Delete; the head keeps the state words whole and cuts a long name (one line, the full name as its tooltip)', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page);
    const panel = frame.locator('[data-cad-panel="sketch"]');
    // Review 1 (blocker): Extrude 1 uses Sketch 1: no Delete, and the reason, while compact.
    await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"] > .tree-row').dblclick();
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await expect(panel.locator('[data-sketch-details]')).toHaveAttribute('data-sketch-details', 'closed');
    await expect(panel.locator('[data-panel-delete]')).toHaveCount(0);
    await expect(panel.locator('[data-delete-block]')).toBeVisible();
    await expect(panel.locator('[data-delete-block]')).toHaveText('Delete is off: Extrude 1 uses Sketch 1: delete Extrude 1 or change what it uses first');
    await finish(frame);
    // Review 2: an over-defined sketch with a long name, at 288 px.
    await conflictingSketch(page);
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    const state = panel.locator('.mgk-panel-head [data-sketch-state]');
    await expect(state).toHaveText(/^Over defined · [12] conflicting$/);
    const whole = () => state.locator('.cad-sk-state-words').evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().width > 0);
    expect(await whole(), 'the state words are not cut').toBe(true);
    const long = 'Mounting bracket outline with slots and fillets';
    await panel.locator('.mgk-panel-head [data-rename-btn]').click();
    await panel.locator('.mgk-panel-head .mesh-rename-input').fill(long);
    await panel.locator('.mgk-panel-head .mesh-rename-input').press('Enter');
    const name = panel.locator('.mgk-panel-head [data-panel-title]');
    await expect(name).toHaveText(long);
    expect(await whole(), 'the state words are not cut by a long name').toBe(true);
    const nameBox = await name.evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.4, cut: el.scrollWidth > el.clientWidth + 1 }));
    expect(nameBox.h, 'the name stays on one line').toBeLessThanOrEqual(nameBox.lh + 1);
    expect(nameBox.cut, 'the name takes the ellipsis').toBe(true);
    await name.hover();
    await expect(name).toHaveAttribute('title', long);
    await expect(panel.locator('.mgk-panel-head [data-rename-btn]')).toBeVisible();
    await finish(frame);
    expect(seen.csp).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

test('cad:ux010-panels-review-notice a pattern note ("now starts from") stays with its sketch: another sketch opened after it shows none', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  const panel = frame.locator('[data-cad-panel="sketch"]');
  // A 10 mm circle at the origin, a linear pattern of 4, then the source deleted.
  await page.keyboard.press('c');
  const o = await modelOnPage(page, [0, 0, 0]);
  await page.mouse.click(o[0], o[1]);
  const r = await modelOnPage(page, [10, 0, 0]);
  await page.mouse.move(r[0], r[1]);
  await expect(frame.locator('[data-sketch-box="diameter"]')).toBeVisible();
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  await idle(page);
  await page.keyboard.press('Escape');
  // Fit: the circle large enough to click its curve (left of the centre, away from its glyph and label).
  await page.keyboard.press('f');
  await idle(page);
  await runCommand(frame, 'sketch.pattern-linear');
  const edge = await modelOnPage(page, [-5, 0, 0]);
  await page.mouse.click(edge[0], edge[1]);
  const opts = panel.locator('[data-sketch-options="pattern-linear"]');
  const count = opts.locator('.nui[data-field="sk-count"] input');
  await count.fill('4');
  await count.press('Enter');
  await opts.locator('[data-sketch-option="place"]').click();
  await idle(page);
  await page.keyboard.press('Escape');
  await page.mouse.click(edge[0], edge[1]);
  await page.keyboard.press('Delete');
  await idle(page);
  await expect(panel.locator('[data-tie-notice]')).toContainText('Linear pattern 1 now starts from Circle 1');
  await finish(frame);
  // Another sketch: no note from the last one.
  await frame.locator('[data-tree-node="origin:front"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
  await expect(panel.locator('[data-sketch-hint]')).toBeVisible();
  await expect(frame.locator('[data-tie-notice]')).toHaveCount(0);
  await finish(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:ux010-panels-review-keyboard each toggle hands the keyboard to the control that replaces it, with the kit\'s focus ring; aria-expanded / aria-controls; Ctrl+Alt with the Backslash key (AltGr layouts) toggles too', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    const active = () => workspaceFrame(page).evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const attr = ['data-tree-collapse', 'data-cad-rail', 'data-rail-expand', 'data-sketch-collapse'].find((a) => el.hasAttribute(a));
      return attr ? `${attr}=${el.getAttribute(attr)}` : el.tagName;
    });
    const ring = () => workspaceFrame(page).evaluate(() => getComputedStyle(document.activeElement as HTMLElement).boxShadow);
    // Model mode: the tree's chevron -> its rail -> the chevron again.
    const chevron = frame.locator('[data-tree-collapse]');
    await expect(chevron).toHaveAttribute('aria-expanded', 'true');
    await chevron.focus();
    await page.keyboard.press('Enter');
    await expect(frame.locator('[data-cad-rail="tree"]')).toBeVisible();
    await expect.poll(active).toBe('data-cad-rail=tree');
    await page.keyboard.press('Enter');
    await expect(chevron).toBeVisible();
    await expect.poll(active).toBe('data-tree-collapse=1');
    expect(await ring(), 'the kit focus ring on the chevron').toMatch(/rgb.*0px 0px 0px 2px/);
    await expect.poll(() => cadPref(request, 'tree-collapsed')).toBeNull();
    // The Sketch panel's chevron -> the rail's expand button -> the chevron again.
    await sketchOnTop(page, frame);
    const panel = frame.locator('[data-cad-panel="sketch"]');
    const collapse = panel.locator('[data-sketch-collapse]');
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    const controls = await panel.locator('[data-sketch-details]').getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    await expect(panel.locator(`#${controls}`)).toHaveAttribute('data-sketch-panel', /.+/);
    // Space presses a focused button (a programmatic focus() is not a keyboard focus, so Enter here would
    // still be Finish sketch's: src/app/keyboard.ts). Tab + Enter is checked on Details below.
    await collapse.focus();
    await page.keyboard.press('Space');
    await expect(frame.locator('[data-cad-rail="sketch"]')).toBeVisible();
    await expect.poll(active).toBe('data-rail-expand=1');
    await page.keyboard.press('Space');
    await expect(panel).toBeVisible();
    await expect.poll(active).toBe('data-sketch-collapse=1');
    expect(await ring()).toMatch(/rgb.*0px 0px 0px 2px/);
    // Details: the same ring.
    await panel.locator('[data-sketch-details]').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await ring()).toMatch(/rgb.*0px 0px 0px 2px/);
    // INTEGRATE: Enter on a button the keyboard reached presses it; the sketch stays open.
    const details = panel.locator('[data-sketch-details]');
    const was = await details.getAttribute('data-sketch-details');
    await page.keyboard.press('Enter');
    await expect(details).not.toHaveAttribute('data-sketch-details', was ?? '');
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(details).toHaveAttribute('data-sketch-details', was ?? '');
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    // The event a layout with the backslash on AltGr sends (Ctrl+Alt, code Backslash; Playwright's own
    // Ctrl+Alt press does not reach the page on Windows, where it is AltGr): collapses, and again expands.
    const altGr = () =>
      workspaceFrame(page).evaluate(() => {
        const t = document.querySelector('[data-cad-viewport] canvas') ?? document.body;
        t.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(92), code: 'Backslash', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      });
    await altGr();
    await expect(frame.locator('[data-cad-rail="sketch"]')).toBeVisible();
    await altGr();
    await expect(panel).toBeVisible();
    await finish(frame);
    expect(seen.csp).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

test('cad:ux010-panels-review-short-frame on an 800 x 500 page both rails fit above the dock (a long name is cut) and Finish sketch on the rail still works', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    await page.setViewportSize({ width: 800, height: 500 });
    await sketchOnTop(page, frame);
    const panel = frame.locator('[data-cad-panel="sketch"]');
    await panel.locator('.mgk-panel-head [data-rename-btn]').click();
    await panel.locator('.mgk-panel-head .mesh-rename-input').fill('Mounting bracket outline with slots and fillets');
    await panel.locator('.mgk-panel-head .mesh-rename-input').press('Enter');
    await panel.locator('[data-sketch-collapse]').click();
    const rail = frame.locator('[data-cad-rail="sketch"]');
    await expect(rail).toBeVisible();
    await page.waitForTimeout(200);
    const m = await workspaceFrame(page).evaluate(() => {
      const r = document.querySelector('[data-cad-rail="sketch"]')!.getBoundingClientRect();
      const done = document.querySelector('[data-rail-done]')!.getBoundingClientRect();
      const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-cad-dock] > *')).map((c) => c.getBoundingClientRect()).filter((c) => c.width > 0);
      const dockTop = Math.min(...chips.map((c) => c.top));
      const at = document.elementFromPoint(done.left + done.width / 2, done.top + done.height / 2);
      return { bottom: r.bottom, dockTop, doneOnTop: !!at?.closest('[data-rail-done]') };
    });
    expect(m.bottom, `the rail ends at ${m.bottom}, above the dock at ${m.dockTop}`).toBeLessThanOrEqual(m.dockTop);
    expect(m.doneOnTop, 'Finish sketch is not covered').toBe(true);
    await rail.locator('[data-rail-done]').click();
    await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
    expect(seen.csp).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

test('cad:ux010-panels-review-no-flash with the tree stored as a rail, the tree card is never drawn while the Part opens', { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const r = await request.post(`${baseUrl()}/api/plugin-prefs/set`, { data: { plugin: 'cad', key: 'tree-collapsed', value: true } });
    expect(r.ok(), await r.text()).toBe(true);
    // In every frame from its first script: was the tree card ever shown (drawn, its column not pending)?
    await page.addInitScript(() => {
      const w = window as unknown as { __treeCardShown?: boolean };
      w.__treeCardShown = false;
      const check = () => {
        const tree = document.querySelector('[data-cad-tree]');
        if (tree && getComputedStyle(tree).visibility !== 'hidden') w.__treeCardShown = true;
      };
      new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true });
    });
    const { seen, frame } = await freshPart(page, request);
    await expect(frame.locator('[data-cad-rail="tree"]')).toBeVisible();
    expect(await workspaceFrame(page).evaluate(() => (window as unknown as { __treeCardShown?: boolean }).__treeCardShown)).toBe(false);
    expect(seen.errors).toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
});

test('cad:ux010-panels-review-params Parameters in the tree during a sketch is refused in words; the sketch stays open; after Finish it opens', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { addParam(p: object): unknown } } } }).__CAD__.services.doc.addParam({ name: 'width', expr: '20 mm', quantity: 'length' }));
  await sketchOnTop(page, frame);
  await frame.locator('[data-cad-rail="tree"]').click();
  await frame.locator('[data-params-row] > .tree-row').click();
  const panel = frame.locator('[data-cad-panel="sketch"]');
  await expect(panel.locator('[data-run-reason]')).toContainText('Finish Sketch 1 first to open Parameters');
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(panel).toBeVisible();
  await finish(frame);
  await frame.locator('[data-params-row] > .tree-row').click();
  await expect(frame.locator('[data-cad-panel="params"]')).toBeVisible();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
