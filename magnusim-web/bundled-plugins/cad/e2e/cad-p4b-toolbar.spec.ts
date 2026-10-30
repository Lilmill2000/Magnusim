// P4b fix round 1 (TOOLBAR): Daniel's decision of 2026-10-06, "I prefer 1280 px (model) but let
// people arrange the icons however they want", and the review's toolbar findings, as a user meets
// them:
//   - the model toolbar's default: every command on the bar at 1920, 1600 and 1280 px (v0.5.0
//     ribbon, Daniel: "yes show the rest as small buttons"; before it, the compact layout: each
//     group's main command, the rest in its More), nothing folded, no More;
//   - the sketch ribbon keeps every command (v0.5.0 ribbon: the small buttons' names on one line,
//     sketch P3), MODIFY in the order Trim, Extend, Offset, Fillet, Chamfer, Mirror, Linear pattern,
//     Circular pattern, Project, Intersect (sketch P1), and when the frame is narrow (760 px since
//     the ribbon) Project and Intersect fold before Spline, Mirror and the patterns (sketch P2);
//   - right-click Show in toolbar / Move to More / Move earlier / Move later, a drag along the group,
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

// v0.5.0 ribbon (Daniel 2026-10-27: "yes show the rest as small buttons"): every model command is
// on the bar by default, each group's main command first; nothing in a More (P4b fix round 1 kept
// all but the main command in More).
const MODEL_ON_BAR: Record<string, string[]> = {
  sketch: ['sketch.new'],
  solid: ['solid.extrude', 'solid.revolve', 'solid.sweep', 'solid.loft', 'solid.hole'],
  pattern: ['pattern.linear', 'pattern.circular', 'pattern.mirror'],
  modify: ['modify.fillet', 'modify.chamfer', 'modify.shell', 'modify.press-pull', 'modify.delete-faces', 'modify.split', 'modify.move-body', 'modify.combine', 'modify.parameters'],
  construct: ['construct.plane', 'construct.axis', 'construct.point'],
  cfd: ['cfd.enclosure'],
  inspect: ['inspect.measure', 'inspect.mass', 'inspect.check', 'inspect.find'],
  file: ['file.import-step', 'file.export-step', 'file.picture'],
  scale: ['scale.banana'],
};
const MODIFY = MODEL_ON_BAR.modify;
const SOLID = MODEL_ON_BAR.solid;

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

test('cad:p4b-toolbar-default the model toolbar shows every command at 1920, 1600 and 1280 px, nothing in More; the sketch ribbon keeps its commands as named icons, MODIFY in order, Project folding before the new tools', async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page);
  for (const width of [1920, 1600, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const bar = frame.locator('[data-cad-toolbar="model"]');
    await expect(bar).toHaveAttribute('data-fit-folded', '0');
    await expect(bar).toHaveAttribute('data-layout', 'default');
    await expect.poll(() => bar.evaluate((el) => el.scrollWidth - el.clientWidth), `the toolbar scrolls at ${width}`).toBeLessThanOrEqual(1);
    for (const [g, ids] of Object.entries(MODEL_ON_BAR)) expect(await shownIds(frame, g), `${g} on the bar at ${width}`).toEqual(ids);
    await expect(bar.locator('[data-tb-more]'), `no More at ${width}`).toHaveCount(0);
    await expect(bar).toHaveAttribute('data-folded', '0');
    // Undo and Redo stay in view at the right end.
    for (const id of ['edit.undo', 'edit.redo']) {
      const r = (await bar.locator(`.tb-btn[data-command="${id}"]`).boundingBox())!;
      expect(r.x + r.width, `${id} inside the frame at ${width}`).toBeLessThanOrEqual(width + 0.5);
    }
  }

  // Sketch mode at 1920: MODIFY in the review's order (P1), every small button's name on one line (P3).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await sketchOnTop(frame);
  expect(await groupCommandLabels(frame, 'sketch-modify')).toEqual(['Trim', 'Extend', 'Offset', 'Fillet', 'Chamfer', 'Mirror', 'Linear pattern', 'Circular pattern', 'Project', 'Intersect', 'Import SVG/DXF']);
  const lines = await tb(frame)
    .locator('.tb-btn.is-small[data-command] .tb-txt')
    .evaluateAll((els) =>
      els
        .filter((e) => getComputedStyle(e).position !== 'absolute')
        .map((e) => ({ label: e.textContent, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) })),
    );
  expect(lines.filter((l) => l.lines !== 1), 'two-line labels at 1920').toEqual([]);
  // v0.5.0 ribbon: the small buttons are named (CONSTRAIN's are its glyphs, named by their tooltips).
  expect(lines.map((l) => l.label)).toContain('Linear pattern');
  expect(lines.map((l) => l.label)).toContain('Slot');
  await expect(tb(frame).locator('.tb-btn[data-command="sketch.finish"] .tb-txt')).toBeVisible();
  for (const [id, name] of [
    ['sketch.slot', 'Center-to-center slot'],
    ['sketch.polygon', 'Polygon'],
    ['sketch.pattern-linear', 'Linear pattern'],
    ['sketch.pattern-circular', 'Circular pattern'],
  ])
    await expect(tb(frame).locator(`.tb-btn[data-command="${id}"]`)).toHaveAttribute('aria-label', name);
  // 760 px (P2; 1600 before the compact toolbar, 1440 before the ribbon): Daniel's headline tools
  // stay on the ribbon; Project and Intersect wait in More.
  await page.setViewportSize({ width: 760, height: 1000 });
  await expect.poll(() => moreIds(frame, 'sketch-modify')).toContain('sketch.project');
  for (const id of ['sketch.spline', 'sketch.mirror', 'sketch.pattern-linear', 'sketch.pattern-circular'])
    await expect(tb(frame).locator(`.tb-btn[data-command="${id}"]`), `${id} at 760`).toBeVisible();
  expect(await moreIds(frame, 'sketch-modify')).toContain('sketch.intersect');
  await finishSketch(frame);
  expect(seen.errors, 'console errors').toEqual([]);
});

/**
 * The model groups whose small buttons (More among them) go to icons one at a time, then collapse
 * into one dropdown each, when the model ribbon is too wide (src/ui/Toolbar.tsx SQUEEZE_ORDER).
 */
const MODEL_SQUEEZE_ORDER = ['file', 'inspect', 'construct', 'pattern', 'modify', 'solid'];

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
      tight: el.getAttribute('data-fit-tight'),
      labels: (el.getAttribute('data-fit-labels') ?? '').split(' ').filter(Boolean),
      collapsed: (el.getAttribute('data-fit-collapsed') ?? '').split(' ').filter(Boolean),
      scroll: el.scrollWidth - el.clientWidth,
      caret,
      groups: Array.from(el.querySelectorAll<HTMLElement>(':scope > .tb-group')).map((g) => ({
        id: g.dataset.group!,
        iconsOnly: g.dataset.icons === '1',
        collapsed: g.dataset.collapsed === '1',
        heading: labelShown(g.querySelector('.tb-group-label')),
        menu: !!g.querySelector('[data-tb-group-menu]'),
        buttons: Array.from(g.querySelectorAll('.tb-btn[data-command], .tb-btn[data-tb-more]')).map((b) => ({
          id: b.getAttribute('data-command') ?? `more:${g.dataset.group}`,
          large: b.classList.contains('is-large'),
          name: b.getAttribute('aria-label'),
          label: labelShown(b.querySelector('.tb-txt')),
        })),
      })),
    };
  });
}

// Wider text than Segoe UI at 100 % (Windows text scaling or browser zoom, a larger system font,
// Linux's fallback fonts: CI on Linux, 2026-10-13, the release's mirror) never makes the ribbon
// scroll and never costs Sketch its label before every other group has gone. v0.5.0 ribbon: the
// groups' small buttons (their More) go to icons first, one group at a time, the least used first
// (FILE, INSPECT, CONSTRUCT, ...), the large buttons keep their names; then the groups sit closer;
// then whole groups collapse into one dropdown each in the same order, their headings kept. Here
// the ribbon's text is 2 px larger, on any platform.
test('cad:p4b-toolbar-wide-text with larger text in the ribbon: nothing scrolls down to 720 px; the small buttons go to icons a group at a time (FILE first), then the groups sit closer, then groups collapse into one dropdown (FILE first); Sketch keeps its large labelled button; PATTERN caret beside More while it is labelled', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const { seen, frame } = await freshPart(page, request);
  // 13 px instead of 11 px for the buttons' labels and 12 px for the groups' headings (a rule added
  // to the CAD's own sheet through the CSSOM, as zoomed or scaled text would be).
  await tb(frame).evaluate(() => {
    const sheet = Array.from(document.styleSheets).find((s) => {
      try {
        return s.cssRules.length > 0;
      } catch {
        return false;
      }
    })!;
    sheet.insertRule('.cad-toolbar.is-ribbon .tb-btn { font-size: 13px; }', sheet.cssRules.length);
    sheet.insertRule('.cad-toolbar .tb-group-label { font-size: 12px; }', sheet.cssRules.length);
  });
  expect(await tb(frame).locator('.tb-btn[data-command="sketch.new"]').evaluate((b) => getComputedStyle(b).fontSize)).toBe('13px');
  const ran = { tight: false, labels: 0, collapsed: 0 };
  for (const width of [1280, 1100, 960, 820, 720]) {
    const s = await fitAt(page, frame, width);
    const where = `at ${width} px with larger text`;
    expect(s.scroll, `the toolbar scrolls ${where}`).toBeLessThanOrEqual(1);
    // The order: the groups' small buttons to icons, then closer groups, then collapsed groups.
    expect(s.labels, `the groups gone to icons ${where}`).toEqual(MODEL_SQUEEZE_ORDER.slice(0, s.labels.length));
    expect(s.collapsed, `the groups collapsed ${where}`).toEqual(MODEL_SQUEEZE_ORDER.slice(0, s.collapsed.length));
    if (s.tight === '1') expect(s.labels, `every group's small buttons are icons before the groups move closer ${where}`).toEqual(MODEL_SQUEEZE_ORDER);
    if (s.collapsed.length) expect(s.tight, `closer groups before any group collapses ${where}`).toBe('1');
    if (s.labels.length) expect(s.fit, `VIEW and EDIT icons first ${where}`).toBe('1');
    for (const g of s.groups) {
      if (g.id === 'view' || g.id === 'edit') continue;
      // Every heading stays (SCALE MODELS' too).
      expect(g.heading, `${g.id}'s heading ${where}`).toBe(true);
      expect(g.iconsOnly, `${g.id} marked as icons ${where}`).toBe(s.labels.includes(g.id));
      expect(g.collapsed && g.menu, `${g.id} collapsed ${where}`).toBe(s.collapsed.includes(g.id));
      if (g.collapsed) {
        expect(g.buttons, `${g.id} collapsed: no command button ${where}`).toEqual([]);
        continue;
      }
      for (const b of g.buttons) {
        // A large button keeps its name; a small one shows it unless its group went to icons.
        expect(b.label, `${b.id}'s label ${where}`).toBe(b.large || !g.iconsOnly);
        // As icons, the name is still the accessible name (and the tooltip).
        expect(b.name, `${b.id}'s name ${where}`).toBeTruthy();
      }
    }
    expect(
      s.groups.find((g) => g.id === 'sketch')!.buttons.filter((b) => !b.id.startsWith('more:')),
      `Sketch ${where}`,
    ).toEqual([{ id: 'sketch.new', large: true, name: 'Sketch', label: true }]);
    if (!s.labels.includes('pattern')) expect(s.caret, `PATTERN's More caret ${where}`).toEqual({ right: true, inLine: true });
    ran.tight ||= s.tight === '1';
    ran.labels = Math.max(ran.labels, s.labels.length);
    ran.collapsed = Math.max(ran.collapsed, s.collapsed.length);
  }
  // The steps under test really ran: small buttons to icons, the groups closer, FILE collapsed.
  expect(ran.labels).toBeGreaterThan(0);
  expect(ran.tight).toBe(true);
  expect(ran.collapsed).toBeGreaterThan(0);
  // Back to 1600 px: everything named again.
  const s = await fitAt(page, frame, 1600);
  expect(s.labels).toEqual([]);
  expect(s.collapsed).toEqual([]);
  expect(s.scroll).toBeLessThanOrEqual(1);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test("cad:p4b-toolbar-customize Show in toolbar, Move to More, a drag and Move earlier reorder; a shortcut of a command in More still runs; kept through a reopen, in a new Part and in a new project (the user's layout); sketch ribbon too; Reset toolbar", { tag: '@serial' }, async ({ page, request }) => {
  await forgetUserLayout(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { seen, frame, projectId } = await freshPart(page, request);
  await addSolid(page);
  const bar = frame.locator('[data-cad-toolbar="model"]');

  // Move to More: Loft and Hole go into SOLID's More (every model command starts on the bar).
  await onButton(frame, 'solid.loft', 'tb-to-more');
  await onButton(frame, 'solid.hole', 'tb-to-more');
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.extrude', 'solid.revolve', 'solid.sweep']);
  expect(await moreIds(frame, 'solid')).toBe('solid.loft solid.hole');
  await expect(bar).toHaveAttribute('data-layout', 'custom');
  // Show in toolbar from SOLID's More: Loft comes back.
  await onMoreItem(frame, 'solid', 'solid.loft', 'tb-to-bar');
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.extrude', 'solid.revolve', 'solid.sweep', 'solid.loft']);
  expect(await moreIds(frame, 'solid')).toBe('solid.hole');

  // Move to More: Extrude goes into SOLID's More (still runs from there).
  await onButton(frame, 'solid.extrude', 'tb-to-more');
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.revolve', 'solid.sweep', 'solid.loft']);
  expect(await moreIds(frame, 'solid')).toBe('solid.extrude solid.hole');
  // Press-pull moved to MODIFY's More: its shortcut Q still opens it.
  await onButton(frame, 'modify.press-pull', 'tb-to-more');
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
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.sweep', 'solid.revolve', 'solid.loft']);
  // The drag did not run Sweep.
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);
  // Move earlier from the right-click menu (the keyboard's way too; v0.5.0 ribbon: one step in the
  // reading order, here up its column): Revolve first again; the first can't move earlier.
  await onButton(frame, 'solid.revolve', 'tb-left');
  await expect.poll(() => shownIds(frame, 'solid')).toEqual(['solid.revolve', 'solid.sweep', 'solid.loft']);
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
  await expect.poll(() => shownIds(again, 'solid')).toEqual(['solid.revolve', 'solid.sweep', 'solid.loft']);
  expect(await moreIds(again, 'solid')).toBe('solid.extrude solid.hole');

  // A new Part of the same project: the same layout.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  await newPartFromTree(page, 'Part 2', { offered: 'Part 2' });
  again = await partOpened(page);
  await expect(tb(again)).toHaveAttribute('data-layout-ready', '1');
  await expect.poll(() => shownIds(again, 'solid')).toEqual(['solid.revolve', 'solid.sweep', 'solid.loft']);
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
  await expect.poll(() => shownIds(again, 'solid')).toEqual(SOLID);
  expect(await moreIds(again, 'solid')).toBe('');
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
  expect(await shownIds(third, 'modify')).toEqual(MODIFY.filter((id) => id !== 'modify.fillet'));
  expect(await moreIds(third, 'modify')).toContain('modify.fillet');
  // Reset there: the defaults, and the user's layout is gone (removed, not an empty one).
  await onButton(third, 'modify.chamfer', 'tb-reset');
  await expect(tb(third)).toHaveAttribute('data-layout', 'default');
  expect(await shownIds(third, 'modify')).toEqual(MODIFY);
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
  // Tab A: Extrude and Hole to More. Tab B follows without a reload.
  await page.bringToFront();
  await onButton(a.frame, 'solid.extrude', 'tb-to-more');
  await onButton(a.frame, 'solid.hole', 'tb-to-more');
  await expect.poll(() => shownIds(a.frame, 'solid')).toEqual(['solid.revolve', 'solid.sweep', 'solid.loft']);
  await expect.poll(() => shownIds(b.frame, 'solid')).toEqual(['solid.revolve', 'solid.sweep', 'solid.loft']);
  await expect(tb(b.frame)).toHaveAttribute('data-layout', 'custom');
  expect(await moreIds(b.frame, 'solid')).toBe('solid.extrude solid.hole');
  // Tab B: Reset toolbar. Tab A is back at the defaults too, and nothing is stored.
  await page2.bringToFront();
  await onButton(b.frame, 'solid.revolve', 'tb-reset');
  await expect(tb(b.frame)).toHaveAttribute('data-layout', 'default');
  await expect.poll(() => shownIds(a.frame, 'solid')).toEqual(SOLID);
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
  expect(await shownIds(frame, 'modify')).toEqual(MODIFY.filter((id) => id !== 'modify.fillet'));
  expect(await shownIds(frame, 'solid')).toEqual(SOLID);
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
  expect(await shownIds(frame, 'modify')).toEqual(MODIFY.filter((id) => id !== 'modify.fillet'));
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
  expect(await shownIds(frame, 'modify')).toEqual(MODIFY);
  expect(await userLayout(request)).toBeNull();
  expect(seen.errors, 'console errors').toEqual([]);
  await forgetUserLayout(request);
});
