// P4b fix round 1 (TOOLBAR): Daniel's decision of 2026-10-06, "I prefer 1280 px (model) but let
// people arrange the icons however they want", and the review's toolbar findings, as a user meets
// them:
//   - the model toolbar's default is the compact layout (each group's main command, the rest in its
//     More menu) at 1920, 1600 and 1280 px; PATTERN's More caret sits beside "More" (pattern P5);
//   - the sketch ribbon keeps every command, with one-line labels (sketch P3), MODIFY in the order
//     Trim, Extend, Offset, Fillet, Chamfer, Mirror, Linear pattern, Circular pattern, Project,
//     Intersect (sketch P1), and at 1600 px Project and Intersect fold before Spline, Mirror and the
//     patterns (sketch P2);
//   - right-click Show in toolbar / Move to More / Move left / Move right, a drag along the group,
//     keyboard shortcuts of a command in More, Reset toolbar; the layout kept through a reopen of
//     the Part and in a new Part of the project, in model and sketch mode;
//   - P4b follow-up (host API 1.7 `ws.prefs`): the layout is the user's, in every project: a layout
//     set in project A shows in a new project B; a change in one tab reaches another open tab at
//     once, and so does Reset; a project's old per-project layout (toolbar-layout.json) is copied
//     to the user's prefs once. These tests run in the serial phase: the server keeps one prefs file per plugin,
//     which every test on it would see.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, baseUrl, groupCommandLabels, newPartFromTree, newProject, openPart, openProject, partOpened, runCommand, watchPage } from './helpers';

// ux010: SCALE MODELS' Banana for scale (after VIEW) is on the bar too.
const MODEL_ON_BAR = ['sketch.new', 'solid.extrude', 'pattern.linear', 'modify.fillet', 'modify.chamfer', 'construct.plane', 'cfd.enclosure', 'inspect.measure', 'file.import-step', 'scale.banana'];
const MODEL_MORE: Record<string, string> = {
  solid: 'solid.revolve solid.sweep solid.loft',
  pattern: 'pattern.circular pattern.mirror',
  modify: 'modify.parameters modify.shell modify.press-pull modify.delete-faces modify.split modify.combine',
  construct: 'construct.axis construct.point',
  inspect: 'inspect.mass inspect.check',
  file: 'file.export-step',
};

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const menu = (frame: FrameLocator) => frame.locator('[data-cad-menu]');

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  return { seen, frame, projectId };
}

/** The ids of a group's buttons on the bar, in order. */
async function shownIds(frame: FrameLocator, group: string): Promise<string[]> {
  return tb(frame)
    .locator(`[data-group="${group}"] .tb-btn[data-command]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-command') ?? ''));
}

async function moreIds(frame: FrameLocator, group: string): Promise<string> {
  const more = tb(frame).locator(`[data-tb-more="${group}"]`);
  return (await more.count()) ? ((await more.getAttribute('data-more-commands')) ?? '') : '';
}

/** Right-click a toolbar button and pick an item of its menu. */
async function onButton(frame: FrameLocator, id: string, item: string) {
  await tb(frame).locator(`.tb-btn[data-command="${id}"]`).click({ button: 'right', force: true });
  await expect(menu(frame)).toBeVisible();
  await menu(frame).locator(`[data-menu-item="${item}"]`).click();
  await expect(menu(frame)).toHaveCount(0);
}

/** Open the group's More and right-click one of its items, then pick an item of that menu. */
async function onMoreItem(frame: FrameLocator, group: string, id: string, item: string) {
  const more = tb(frame).locator(`[data-tb-more="${group}"]`);
  await more.click();
  await menu(frame).locator(`[data-command="${id}"]`).click({ button: 'right', force: true });
  await expect(menu(frame)).toHaveAttribute('aria-label', /^Toolbar: /);
  await menu(frame).locator(`[data-menu-item="${item}"]`).click();
  await expect(menu(frame)).toHaveCount(0);
}

/** The user's toolbar layout as the host keeps it (ws.prefs), or null. */
async function userLayout(request: Parameters<typeof newProject>[0], key = 'toolbar-layout'): Promise<unknown> {
  const r = await request.post(`${baseUrl()}/api/plugin-prefs/get`, { data: { plugin: 'cad', key } });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).value ?? null;
}

/** No user layout and no record of a copy: as a user who never arranged the toolbar. */
async function forgetUserLayout(request: Parameters<typeof newProject>[0]) {
  for (const key of ['toolbar-layout', 'toolbar-layout.migrated']) {
    const r = await request.post(`${baseUrl()}/api/plugin-prefs/remove`, { data: { plugin: 'cad', key } });
    expect(r.ok(), await r.text()).toBe(true);
  }
}

async function sketchOnTop(frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await runCommand(frame, 'sketch.new');
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
}

async function finishSketch(frame: FrameLocator) {
  await tb(frame).locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

test('cad:p4b-toolbar-default the model toolbar is compact at 1920, 1600 and 1280 px; the sketch ribbon keeps its commands on one-line labels, MODIFY in order, Project folding before the new tools', async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page);
  for (const width of [1920, 1600, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const bar = frame.locator('[data-cad-toolbar="model"]');
    await expect(bar).toHaveAttribute('data-fit-folded', '0');
    await expect(bar).toHaveAttribute('data-layout', 'default');
    const shown = await bar.locator('.tb-group:not([data-group="view"]):not([data-group="edit"]) .tb-btn[data-command]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
    expect(shown, `labelled at ${width}`).toEqual(MODEL_ON_BAR);
    for (const [g, ids] of Object.entries(MODEL_MORE)) expect(await moreIds(frame, g), `${g}'s More at ${width}`).toBe(ids);
    // PATTERN's More caret sits right of "More", on its line (pattern review P5: it hung under it).
    const caret = await bar.locator('[data-tb-more="pattern"]').evaluate((el) => {
      const txt = el.querySelector('.tb-txt')!;
      const range = document.createRange();
      range.selectNodeContents(txt.firstChild!);
      const word = range.getBoundingClientRect();
      const c = el.querySelector('.tb-caret')!.getBoundingClientRect();
      return { right: c.left >= word.right - 0.5, inLine: c.top < word.bottom && c.bottom > word.top };
    });
    expect(caret, `PATTERN's More caret at ${width}`).toEqual({ right: true, inLine: true });
  }

  // Sketch mode at 1920: MODIFY in the review's order (P1), every label on one line (P3).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await sketchOnTop(frame);
  expect(await groupCommandLabels(frame, 'sketch-modify')).toEqual(['Trim', 'Extend', 'Offset', 'Fillet', 'Chamfer', 'Mirror', 'Linear pattern', 'Circular pattern', 'Project', 'Intersect']);
  const lines = await tb(frame)
    .locator('.tb-btn[data-command] .tb-txt')
    .evaluateAll((els) =>
      els
        .filter((e) => getComputedStyle(e).position !== 'absolute')
        .map((e) => ({ label: e.textContent, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) })),
    );
  expect(lines.filter((l) => l.lines !== 1), 'two-line labels at 1920').toEqual([]);
  expect(lines.map((l) => l.label)).toEqual(expect.arrayContaining(['Center rectangle', 'Linear pattern', 'Circular pattern', 'Finish sketch']));
  // 1600 (P2): Daniel's headline tools stay on the ribbon; Project and Intersect wait in More.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect.poll(() => moreIds(frame, 'sketch-modify')).toContain('sketch.project');
  for (const id of ['sketch.spline', 'sketch.mirror', 'sketch.pattern-linear', 'sketch.pattern-circular'])
    await expect(tb(frame).locator(`.tb-btn[data-command="${id}"]`), `${id} at 1600`).toBeVisible();
  expect(await moreIds(frame, 'sketch-modify')).toContain('sketch.intersect');
  await finishSketch(frame);
  expect(seen.errors, 'console errors').toEqual([]);
});

/** The groups that go to icons one at a time once the model toolbar is still too wide (src/ui/Toolbar.tsx ICON_ORDER). */
const MODEL_ICON_ORDER = ['file', 'inspect', 'construct', 'pattern', 'modify', 'cfd', 'solid'];

/** The model toolbar after the fit has run at this width: its fit steps and what each group shows. */
async function fitAt(page: Page, frame: FrameLocator, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const bar = tb(frame);
  await expect.poll(() => bar.evaluate(() => window.innerWidth)).toBe(width);
  // The fit runs before paint once the toolbar has seen its new width: two frames later it is done.
  await bar.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return bar.evaluate((el) => {
    const labelShown = (t: Element | null) => !!t && getComputedStyle(t).position !== 'absolute' && t.getBoundingClientRect().width > 12;
    const more = el.querySelector('[data-tb-more="pattern"]');
    let caret = null as { right: boolean; inLine: boolean } | null;
    if (more && labelShown(more.querySelector('.tb-txt'))) {
      const range = document.createRange();
      range.selectNodeContents(more.querySelector('.tb-txt')!.firstChild!);
      const word = range.getBoundingClientRect();
      const c = more.querySelector('.tb-caret')!.getBoundingClientRect();
      caret = { right: c.left >= word.right - 0.5, inLine: c.top < word.bottom && c.bottom > word.top };
    }
    return {
      fit: el.getAttribute('data-fit'),
      scale: el.getAttribute('data-fit-scale'),
      tight: el.getAttribute('data-fit-tight'),
      icons: (el.getAttribute('data-fit-icons') ?? '').split(' ').filter(Boolean),
      scroll: el.scrollWidth - el.clientWidth,
      caret,
      groups: Array.from(el.querySelectorAll<HTMLElement>(':scope > .tb-group')).map((g) => ({
        id: g.dataset.group!,
        iconsOnly: g.dataset.icons === '1',
        heading: labelShown(g.querySelector('.tb-group-label')),
        buttons: Array.from(g.querySelectorAll('.tb-btn[data-command]')).map((b) => ({ id: b.getAttribute('data-command')!, name: b.getAttribute('aria-label'), label: labelShown(b.querySelector('.tb-txt')) })),
      })),
    };
  });
}

// Wider text than Segoe UI at 100 % (Windows text scaling or browser zoom, a larger system font,
// Linux's fallback fonts: CI on Linux, 2026-10-13, the release's mirror) never costs Sketch its label
// at 1280 px (P4a, Daniel's 1280 px screen) and never makes the toolbar scroll. SCALE MODELS goes to
// its icon first, then the groups sit closer, then whole groups go to icons one at a time, the least
// used first (FILE, INSPECT, CONSTRUCT, ...), their headings kept; Sketch keeps its label until every
// other group is icons. Here the toolbar's text is 10 % larger, on any platform.
test("cad:p4b-toolbar-wide-text with the toolbar's text 10 % larger: at 1280 px Sketch keeps its label and nothing scrolls, SCALE MODELS goes to its icon first, then the groups sit closer, then groups go to icons one at a time (FILE first), Sketch last; PATTERN's caret beside More while it is labelled", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const { seen, frame } = await freshPart(page, request);
  // 11 px instead of 10 px for the buttons' labels and the groups' headings (a rule added to the
  // CAD's own sheet through the CSSOM, as zoomed or scaled text would be).
  await tb(frame).evaluate(() => {
    const sheet = Array.from(document.styleSheets).find((s) => {
      try {
        return s.cssRules.length > 0;
      } catch {
        return false;
      }
    })!;
    sheet.insertRule('.cad-toolbar .tb-btn, .cad-toolbar .tb-group-label { font-size: 11px; }', sheet.cssRules.length);
  });
  expect(await tb(frame).locator('.tb-btn[data-command="sketch.new"]').evaluate((b) => getComputedStyle(b).fontSize)).toBe('11px');
  const ran = { tight: false, icons: 0 };
  for (const width of [1280, 1100, 1000]) {
    const s = await fitAt(page, frame, width);
    const where = `at ${width} px with 11 px text`;
    expect(s.scroll, `the toolbar scrolls ${where}`).toBeLessThanOrEqual(1);
    // VIEW and EDIT are icons; never every group (that would take Sketch's label).
    expect(s.fit, `fit level ${where}`).toBe('1');
    // The order: SCALE MODELS' icon, then closer groups, then ICON_ORDER's groups one by one.
    expect(s.icons, `the groups gone to icons ${where}`).toEqual(MODEL_ICON_ORDER.slice(0, s.icons.length));
    if (s.icons.length) expect(s.tight, `closer groups before any group goes to icons ${where}`).toBe('1');
    if (s.tight === '1') expect(s.scale, `SCALE MODELS' icon before the groups move closer ${where}`).toBe('1');
    for (const g of s.groups) {
      if (g.id === 'view' || g.id === 'edit') continue;
      // Every heading stays (SCALE MODELS' too).
      expect(g.heading, `${g.id}'s heading ${where}`).toBe(true);
      const iconsOnly = g.id === 'scale' ? s.scale === '1' : s.icons.includes(g.id);
      expect(g.iconsOnly, `${g.id} marked as icons ${where}`).toBe(g.id === 'scale' ? false : iconsOnly);
      for (const b of g.buttons) {
        expect(b.label, `${b.id}'s label ${where}`).toBe(!iconsOnly);
        // As icons, the label is still the accessible name (and the tooltip).
        expect(b.name, `${b.id}'s name ${where}`).toBeTruthy();
      }
    }
    expect(s.groups.find((g) => g.id === 'sketch')!.buttons, `Sketch ${where}`).toEqual([{ id: 'sketch.new', name: 'Sketch', label: true }]);
    if (!s.icons.includes('pattern')) expect(s.caret, `PATTERN's More caret ${where}`).toEqual({ right: true, inLine: true });
    ran.tight ||= s.tight === '1';
    ran.icons = Math.max(ran.icons, s.icons.length);
  }
  // The steps under test really ran: the groups moved closer, and at least FILE went to icons.
  expect(ran.tight).toBe(true);
  expect(ran.icons).toBeGreaterThan(0);
  // Back to 1600 px: everything labelled again but VIEW and EDIT.
  const s = await fitAt(page, frame, 1600);
  expect(s.icons).toEqual([]);
  expect(s.scroll).toBeLessThanOrEqual(1);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test("cad:p4b-toolbar-customize Show in toolbar, Move to More, a drag and Move left reorder; a shortcut of a command in More still runs; kept through a reopen, in a new Part and in a new project (the user's layout); sketch ribbon too; Reset toolbar", { tag: '@serial' }, async ({ page, request }) => {
  await forgetUserLayout(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { seen, frame, projectId } = await freshPart(page, request);
  await addSolid(page);
  const bar = frame.locator('[data-cad-toolbar="model"]');

  // Show in toolbar from SOLID's More: Revolve, then Sweep, after Extrude.
  await onMoreItem(frame, 'solid', 'solid.revolve', 'tb-to-bar');
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.extrude', 'solid.revolve']);
  await onMoreItem(frame, 'solid', 'solid.sweep', 'tb-to-bar');
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.extrude', 'solid.revolve', 'solid.sweep']);
  expect(await moreIds(frame, 'solid')).toBe('solid.loft');
  await expect(bar).toHaveAttribute('data-layout', 'custom');

  // Move to More: Extrude goes into SOLID's More (still runs from there).
  await onButton(frame, 'solid.extrude', 'tb-to-more');
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.revolve', 'solid.sweep']);
  expect(await moreIds(frame, 'solid')).toBe('solid.extrude solid.loft');
  // Press-pull stays in MODIFY's More, and its shortcut Q opens it.
  expect(await moreIds(frame, 'modify')).toContain('modify.press-pull');
  await page.keyboard.press('q');
  await expect(frame.locator('[data-cad-panel="feature"] [data-panel-title]')).toHaveText('Press-pull 1');
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);

  // A drag: Sweep dropped on Revolve's left half goes first; the drop mark shows on the way.
  const rev = (await tb(frame).locator('.tb-btn[data-command="solid.revolve"]').boundingBox())!;
  const swp = (await tb(frame).locator('.tb-btn[data-command="solid.sweep"]').boundingBox())!;
  await page.mouse.move(swp.x + swp.width / 2, swp.y + swp.height / 2);
  await page.mouse.down();
  await page.mouse.move(swp.x + swp.width / 2 - 20, swp.y + swp.height / 2, { steps: 3 });
  await page.mouse.move(rev.x + 6, rev.y + rev.height / 2, { steps: 6 });
  await expect(tb(frame).locator('.tb-btn[data-command="solid.revolve"]')).toHaveClass(/is-drop-before/);
  await expect(tb(frame).locator('.tb-btn[data-command="solid.sweep"]')).toHaveClass(/is-dragging/);
  await page.mouse.up();
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.sweep', 'solid.revolve']);
  // The drag did not run Sweep.
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);
  // Move left from the right-click menu (the keyboard's way too): Revolve first again; first can't go left.
  await onButton(frame, 'solid.revolve', 'tb-left');
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.revolve', 'solid.sweep']);
  await tb(frame).locator('.tb-btn[data-command="solid.revolve"]').click({ button: 'right', force: true });
  await expect(menu(frame).locator('[data-menu-item="tb-left"]')).toHaveAttribute('data-disabled-reason', 'Revolve is the first of its group');
  await page.keyboard.press('Escape');

  // Sketch ribbon: Spline to DRAW's More; kept when the sketch is opened again.
  await sketchOnTop(frame);
  await onButton(frame, 'sketch.spline', 'tb-to-more');
  await expect.poll(() => moreIds(frame, 'draw')).toContain('sketch.spline');
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toHaveAttribute('data-layout', 'custom');
  await finishSketch(frame);

  // Reopen the Part: the same layout.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  let again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').first());
  await expect(tb(again)).toHaveAttribute('data-layout-ready', '1');
  await expect.poll(() => shownIds(again, 'solid')).toEqual(['solid.revolve', 'solid.sweep']);
  expect(await moreIds(again, 'solid')).toBe('solid.extrude solid.loft');

  // A new Part of the same project: the same layout.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  await newPartFromTree(page, 'Part 2', { offered: 'Part 2' });
  again = await partOpened(page);
  await expect(tb(again)).toHaveAttribute('data-layout-ready', '1');
  await expect.poll(() => shownIds(again, 'solid')).toEqual(['solid.revolve', 'solid.sweep']);
  await sketchOnTop(again);
  await expect.poll(() => moreIds(again, 'draw')).toContain('sketch.spline');
  // Show in toolbar from DRAW's More puts Spline back on the ribbon.
  await onMoreItem(again, 'draw', 'sketch.spline', 'tb-to-bar');
  await expect(tb(again).locator('.tb-btn[data-command="sketch.spline"]')).toBeVisible();
  // Reset toolbar (the right-click on the toolbar itself, here VIEW): the sketch ribbon's defaults.
  await tb(again).locator('[data-group="view"] .tb-group-label').click({ button: 'right', force: true });
  await menu(again).locator('[data-menu-item="tb-reset"]').click();
  await expect(again.locator('[data-cad-toolbar="sketch"]')).toHaveAttribute('data-layout', 'default');
  await finishSketch(again);
  // The model toolbar: Reset from a button's menu.
  await onButton(again, 'solid.revolve', 'tb-reset');
  await expect(tb(again)).toHaveAttribute('data-layout', 'default');
  await expect.poll(() => shownIds(again, 'solid')).toEqual(['solid.extrude']);
  expect(await moreIds(again, 'solid')).toBe('solid.revolve solid.sweep solid.loft');
  // At the defaults Reset is greyed with the reason.
  await tb(again).locator('.tb-btn[data-command="solid.extrude"]').click({ button: 'right', force: true });
  await expect(menu(again).locator('[data-menu-item="tb-reset"]')).toHaveAttribute('data-disabled-reason', 'The toolbar is already as it was at first');
  await page.keyboard.press('Escape');

  // The layout is the user's: a new project shows it too (ws.prefs, host API 1.7).
  await onButton(again, 'modify.fillet', 'tb-to-more');
  await expect(tb(again)).toHaveAttribute('data-layout', 'custom');
  await expect.poll(() => userLayout(request)).toMatchObject({ model: { place: { 'modify.fillet': 'more' } } });
  void projectId;
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const other = await newProject(request);
  await openProject(page, other);
  await newPartFromTree(page, 'Part 1');
  const third = await partOpened(page);
  await expect(tb(third)).toHaveAttribute('data-layout-ready', '1');
  await expect(tb(third)).toHaveAttribute('data-layout', 'custom');
  expect(await shownIds(third, 'modify')).toEqual(['modify.chamfer']);
  expect(await moreIds(third, 'modify')).toContain('modify.fillet');
  // Reset there: the defaults, and the user's layout is gone (removed, not an empty one).
  await onButton(third, 'modify.chamfer', 'tb-reset');
  await expect(tb(third)).toHaveAttribute('data-layout', 'default');
  expect(await shownIds(third, 'modify')).toEqual(['modify.fillet', 'modify.chamfer']);
  await expect.poll(() => userLayout(request)).toBeNull();
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p4b-toolbar-tabs a change in one tab reaches another open CAD tab at once (another project); Reset in the other tab brings both back to the defaults', { tag: '@serial' }, async ({ page, request }) => {
  await forgetUserLayout(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const a = await freshPart(page, request);
  const page2 = await page.context().newPage();
  await page2.setViewportSize({ width: 1600, height: 1000 });
  const b = await freshPart(page2, request);
  await expect(tb(b.frame)).toHaveAttribute('data-layout', 'default');
  // Tab A: Extrude to More and Revolve on the bar. Tab B follows without a reload.
  await page.bringToFront();
  await onButton(a.frame, 'solid.extrude', 'tb-to-more');
  await onMoreItem(a.frame, 'solid', 'solid.revolve', 'tb-to-bar');
  await expect.poll(() => shownIds(a.frame, 'solid')).toEqual(['solid.revolve']);
  await expect.poll(() => shownIds(b.frame, 'solid')).toEqual(['solid.revolve']);
  await expect(tb(b.frame)).toHaveAttribute('data-layout', 'custom');
  expect(await moreIds(b.frame, 'solid')).toBe('solid.extrude solid.sweep solid.loft');
  // Tab B: Reset toolbar. Tab A is back at the defaults too, and nothing is stored.
  await page2.bringToFront();
  await onButton(b.frame, 'solid.revolve', 'tb-reset');
  await expect(tb(b.frame)).toHaveAttribute('data-layout', 'default');
  await expect.poll(() => shownIds(a.frame, 'solid')).toEqual(['solid.extrude']);
  await expect(tb(a.frame)).toHaveAttribute('data-layout', 'default');
  await expect.poll(() => userLayout(request)).toBeNull();
  expect(a.seen.errors, 'console errors (tab A)').toEqual([]);
  expect(b.seen.errors, 'console errors (tab B)').toEqual([]);
  await page2.close();
});

test("cad:p4b-toolbar-migrate a project's layout kept per project (toolbar-layout.json, a 1.6 host) becomes the user's once: the Part shows it, a new project too; after a Reset it does not come back", { tag: '@serial' }, async ({ page, request }) => {
  await forgetUserLayout(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const seen = await watchPage(page);
  // A project whose toolbar was arranged on a 1.6 host: Fillet in More, Revolve on the bar.
  const old = await newProject(request);
  const layout = { version: 1, model: { place: { 'modify.fillet': 'more', 'solid.revolve': 'bar' }, order: {} }, sketch: { place: {}, order: {} } };
  const w = await request.post(`${baseUrl()}/api/plugin-data/write`, { data: { project_id: old, plugin: 'cad', rel: 'toolbar-layout.json', doc: layout } });
  expect(w.ok(), await w.text()).toBe(true);
  await openProject(page, old);
  await newPartFromTree(page, 'Part 1');
  let frame = await partOpened(page);
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  await expect(tb(frame)).toHaveAttribute('data-layout', 'custom');
  expect(await shownIds(frame, 'modify')).toEqual(['modify.chamfer']);
  expect(await shownIds(frame, 'solid')).toEqual(['solid.extrude', 'solid.revolve']);
  expect(await userLayout(request)).toEqual(layout);
  expect(await userLayout(request, 'toolbar-layout.migrated')).toBe(true);
  // A new project (no file of its own): the same, the user's layout.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const fresh = await newProject(request);
  await openProject(page, fresh);
  await newPartFromTree(page, 'Part 1');
  frame = await partOpened(page);
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  expect(await shownIds(frame, 'modify')).toEqual(['modify.chamfer']);
  // Reset; then the old project again: its file is not copied a second time.
  await onButton(frame, 'modify.chamfer', 'tb-reset');
  await expect(tb(frame)).toHaveAttribute('data-layout', 'default');
  await expect.poll(() => userLayout(request)).toBeNull();
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  await openProject(page, old);
  frame = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').first());
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  await expect(tb(frame)).toHaveAttribute('data-layout', 'default');
  expect(await shownIds(frame, 'modify')).toEqual(['modify.fillet', 'modify.chamfer']);
  expect(await userLayout(request)).toBeNull();
  expect(seen.errors, 'console errors').toEqual([]);
  await forgetUserLayout(request);
});
