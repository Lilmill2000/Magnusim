// The ribbon (v0.5.0, Daniel: "you can stack them on each other instead of it just being one line
// of stuff", SolidWorks's CommandManager). As the person sees it:
//   - at 1920 x 1000 every sketch command is a button on the ribbon, none in a More menu, no group
//     collapsed: DRAW (Line ▾ large; Rectangle ▾, Circle ▾, Arc ▾, Slot ▾, Polygon, Spline ▾,
//     Ellipse ▾, Point, Construction small), MODIFY (Trim large, the rest small), CONSTRAIN (the
//     glyphs alone), DIMENSION (large), SKETCH (Finish sketch, large), VIEW, SCALE MODELS (large)
//     and EDIT;
//   - a large button is the three rows tall with its name under its icon; a small one is one row
//     with its name beside its icon; the small buttons stack three to a column, column by column;
//     a flyout's arrow sits beside a small button and under a large one;
//   - every button's tooltip gives the name, the shortcut and the hint; the accessible name is the
//     name; Tab goes button to button, Down on a flyout's button opens its list;
//   - the model toolbar is the same ribbon (each group's main command large, More a small button),
//     the same height as the sketch ribbon;
//   - at 1600, 1440 and 1280 px nothing folds (Windows' fonts; elsewhere the drawing groups at
//     least stay); narrower, the groups' small buttons go to their icons (SQUEEZE_ORDER), then
//     commands fold in FOLD_ORDER, then whole groups collapse into one dropdown (model: FILE first);
//   - screenshots of both ribbons at 1920 and 1600 (CAD_E2E_SHOTS).
// window.__CAD__ is read only for the registry's list of commands.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collapseFlyouts } from '../src/ui/flyouts';
import { ensureCadOn, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

test.beforeAll(async ({ request }) => {
  await ensureCadOn(request);
});

const SHOTS = process.env.CAD_E2E_SHOTS || '';
async function shot(page: Page, frame: FrameLocator, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const box = (await frame.locator('[data-cad-toolbar]').boundingBox())!;
  await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: Math.ceil(box.y + box.height + 24) } });
}

const tb = (frame: FrameLocator, mode = 'sketch') => frame.locator(`[data-cad-toolbar="${mode}"]`);
const tip = (frame: FrameLocator) => frame.locator('[data-cad-tip]');

/** The sketch part of the decided fold order (src/ui/Toolbar.tsx FOLD_ORDER): the first folds first. */
const FOLD_ORDER = [
  'sketch.intersect',
  'sketch.project',
  'sketch.point',
  'sketch.construction',
  'sketch.chamfer',
  'sketch.extend',
  'sketch.ellipse',
  'sketch.polygon',
  'sketch.slot',
  'sketch.offset',
  'sketch.fillet',
  'sketch.pattern-circular',
  'sketch.pattern-linear',
  'sketch.mirror',
  'sketch.spline',
];

/** The sketch groups whose small buttons go to icons, in order (src/ui/Toolbar.tsx SQUEEZE_ORDER). */
const SKETCH_LABEL_ORDER = ['sketch-modify', 'draw'];

/** The large buttons of the sketch ribbon (src/ui/Toolbar.tsx RIBBON_LARGE and the primary action). */
const LARGE = ['sketch.line', 'sketch.trim', 'sketch.dimension', 'sketch.finish', 'scale.sketch-banana'];
/** The model ribbon's large buttons: each group's main command. */
const MODEL_LARGE = ['sketch.new', 'solid.extrude', 'pattern.linear', 'modify.fillet', 'construct.plane', 'cfd.enclosure', 'inspect.measure', 'file.import-step', 'scale.banana'];

/** The drawing groups on the bar, in order: each flyout's bar command, and Polygon. */
const DRAW_GROUPS = ['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.slot', 'sketch.polygon', 'sketch.spline', 'sketch.ellipse'];
const FLYOUT_NAMES: Record<string, string> = {
  'sketch.line': 'Line tools',
  'sketch.rectangle': 'Rectangle tools',
  'sketch.circle': 'Circle tools',
  'sketch.arc': 'Arc tools',
  'sketch.slot': 'Slot tools',
  'sketch.spline': 'Spline tools',
  'sketch.ellipse': 'Ellipse tools',
};

interface Cmd {
  id: string;
  label: string;
  shortcut: string | null;
  hint: string | null;
  reason: string | null;
  flyout?: string;
  order?: number;
}

/** Sketch mode's toolbar groups as the registry has them, each flyout collapsed to its bar command. */
async function registry(page: Page): Promise<{ group: string; commands: Cmd[] }[]> {
  const raw = await workspaceFrame(page).evaluate(() => {
    type C = { id: string; label: string; shortcut?: string; hint?: string; flyout?: string; order?: number; enabled?(s: unknown): true | string };
    const s = (window as unknown as { __CAD__: { services: { commands: { toolbar(m: string): { group: string; commands: C[] }[] } } } }).__CAD__.services;
    return s.commands.toolbar('sketch').map((g) => ({
      group: g.group,
      commands: g.commands.map((c) => {
        let ok: true | string = true;
        try {
          ok = c.enabled ? c.enabled(s) : true;
        } catch (e) {
          ok = String(e);
        }
        return { id: c.id, label: c.label, shortcut: c.shortcut ?? null, hint: c.hint ?? null, reason: ok === true ? null : ok, flyout: c.flyout, order: c.order };
      }),
    }));
  });
  return raw.map((g) => ({ group: g.group, commands: collapseFlyouts(g.commands).commands }));
}

/** The toolbar after the fit has run at this width. */
async function resizeTo(page: Page, frame: FrameLocator, width: number, mode = 'sketch') {
  await page.setViewportSize({ width, height: 1000 });
  await expect.poll(() => frame.locator('[data-cad-app]').evaluate(() => window.innerWidth), `the frame at ${width} px`).toBe(width);
  // The fit runs before paint once the toolbar has seen its new width: settled when it no longer scrolls.
  await expect.poll(() => tb(frame, mode).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await frame.locator('[data-cad-app]').evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Every More menu's commands on the toolbar (group -> ids). */
async function moreOf(frame: FrameLocator): Promise<Record<string, string[]>> {
  return tb(frame).evaluate((el) =>
    Object.fromEntries(Array.from(el.querySelectorAll('[data-tb-more]')).map((m) => [m.getAttribute('data-tb-more'), (m.getAttribute('data-more-commands') ?? '').split(' ')])),
  );
}

/** Each button of the ribbon as laid out: its size class, box, and where its name shows. */
async function layoutOf(frame: FrameLocator, mode: string) {
  return tb(frame, mode).evaluate((el) => {
    const items = el.querySelectorAll<HTMLElement>('.tb-btn[data-command], .tb-btn[data-tb-more]');
    return Array.from(items).map((b) => {
      const r = b.getBoundingClientRect();
      const t = b.querySelector<HTMLElement>('.tb-txt')!;
      const tr = t.getBoundingClientRect();
      const ir = b.querySelector<HTMLElement>('.tb-ico')!.getBoundingClientRect();
      return {
        id: b.getAttribute('data-command') ?? `more:${b.getAttribute('data-tb-more')}`,
        group: b.closest('.tb-group')!.getAttribute('data-group')!,
        size: b.classList.contains('is-large') ? 'large' : b.classList.contains('is-small') ? 'small' : '?',
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        named: getComputedStyle(t).position !== 'absolute' && tr.width > 8 ? (t.textContent ?? '') : '',
        nameBelow: tr.top >= ir.bottom - 1,
        nameBeside: tr.left >= ir.right - 1 && Math.abs((tr.top + tr.bottom) / 2 - (ir.top + ir.bottom) / 2) < 4,
        itemsHeight: b.closest('.tb-items')!.getBoundingClientRect().height,
      };
    });
  });
}

test('cad:sketch-toolbar-fit the ribbon: at 1920 x 1000 every sketch group and drawing flyout on it, key tools large, the rest stacked three rows small, tooltips with name, shortcut and hint; the model ribbon the same height; 1600, 1440 and 1280 fold nothing; narrower, names, then folds, then whole groups go', async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const seen = await watchPage(page);
  await openProject(page, await newProject(request));
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');

  // ---- the model ribbon: each group's main command large (name under the icon), More small.
  await expect(tb(frame, 'model')).toHaveAttribute('data-layout-ready', '1');
  await resizeTo(page, frame, 1920, 'model');
  await expect(tb(frame, 'model')).toHaveClass(/is-ribbon/);
  const model = await layoutOf(frame, 'model');
  for (const id of MODEL_LARGE) {
    const b = model.find((x) => x.id === id)!;
    expect(b, `${id} on the model ribbon`).toBeTruthy();
    expect(b.size, `${id} is large`).toBe('large');
    expect(b.height, `${id} is the ribbon's height`).toBeGreaterThanOrEqual(b.itemsHeight - 1);
    expect(b.nameBelow && !!b.named, `${id}'s name under its icon`).toBe(true);
  }
  for (const b of model.filter((x) => !MODEL_LARGE.includes(x.id))) {
    expect(b.size, `${b.id} is small`).toBe('small');
    expect(b.height, `${b.id} is one row`).toBeLessThanOrEqual(21);
  }
  // A group's More stands beside its main command, at the top of the next column.
  const solid = model.find((x) => x.id === 'solid.extrude')!;
  const solidMore = model.find((x) => x.id === 'more:solid')!;
  expect(solidMore.left).toBeGreaterThanOrEqual(solid.right - 0.5);
  expect(Math.abs(solidMore.top - solid.top)).toBeLessThanOrEqual(1);
  await expect(tb(frame, 'model').locator('[data-tb-more="solid"] .tb-txt')).toHaveText('More ▾');
  const modelHeight = (await tb(frame, 'model').boundingBox())!.height;
  expect(modelHeight, 'the ribbon is three rows and the headings').toBeGreaterThan(70);
  expect(modelHeight, 'and no taller').toBeLessThan(96);
  await page.mouse.move(900, 600);
  await shot(page, frame, 'model-ribbon-1920');

  // ---- the sketch ribbon.
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await runCommand(frame, 'sketch.new');
  await expect(tb(frame)).toBeVisible();
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  await resizeTo(page, frame, 1920);
  // The same height in both modes: entering a sketch does not move the view.
  expect(Math.abs((await tb(frame).boundingBox())!.height - modelHeight), 'sketch and model ribbons the same height').toBeLessThanOrEqual(1);

  // SolidWorks's order: drawing, the sketch tools, relations and dimensions; then Finish sketch.
  await expect(tb(frame).locator('.tb-group-label')).toHaveText(['DRAW', 'MODIFY', 'CONSTRAIN', 'DIMENSION', 'SKETCH', 'VIEW', 'SCALE MODELS', 'EDIT']);
  // 1920: nothing folds, no More anywhere, no names hidden for the width, no group collapsed.
  await expect(tb(frame)).toHaveAttribute('data-fit', '0');
  await expect(tb(frame)).toHaveAttribute('data-fit-folded', '0');
  await expect(tb(frame)).toHaveAttribute('data-folded', '0');
  await expect(tb(frame)).toHaveAttribute('data-fit-labels', '');
  await expect(tb(frame)).toHaveAttribute('data-fit-collapsed', '');
  await expect(tb(frame).locator('[data-tb-more]')).toHaveCount(0);
  await expect(tb(frame).locator('[data-tb-group-menu]')).toHaveCount(0);
  const drawShown = await tb(frame)
    .locator('[data-group="draw"] .tb-btn[data-command]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
  expect(drawShown.filter((id) => DRAW_GROUPS.includes(id ?? ''))).toEqual(DRAW_GROUPS);

  // Every command of the registry is a button inside the frame, its name the accessible name.
  const fr = (await page.locator('#workspace-frame').boundingBox())!;
  const groups = await registry(page);
  expect(groups.map((g) => g.group)).toEqual(['draw', 'sketch-modify', 'constrain', 'dimension', 'scale']);
  const lay = await layoutOf(frame, 'sketch');
  for (const g of groups) {
    for (const c of g.commands) {
      const btn = tb(frame).locator(`[data-group="${g.group}"] .tb-btn[data-command="${c.id}"]`);
      await expect(btn, `${c.id} on the ribbon at 1920`).toBeVisible();
      await expect(btn).toHaveAttribute('aria-label', c.label);
      await expect(btn.locator('svg')).toHaveCount(1);
      const b = lay.find((x) => x.id === c.id)!;
      expect(b.left >= fr.x - 0.5 && b.right <= fr.x + fr.width + 0.5, `${c.id} inside the frame`).toBe(true);
      if (LARGE.includes(c.id)) {
        // Large: the ribbon's height (a flyout's arrow strip under it), the name under the icon.
        expect(b.size, `${c.id} is large`).toBe('large');
        expect(b.height, `${c.id} is tall`).toBeGreaterThanOrEqual(b.itemsHeight - 14);
        expect(b.nameBelow && !!b.named, `${c.id}'s name under its icon`).toBe(true);
      } else {
        // Small: one row; its name beside its icon (CONSTRAIN: its glyph alone).
        expect(b.size, `${c.id} is small`).toBe('small');
        expect(b.height, `${c.id} is one row`).toBeLessThanOrEqual(21);
        if (g.group === 'constrain') {
          expect(b.named, `${c.id} is its glyph alone`).toBe('');
          expect(b.width).toBeLessThanOrEqual(24);
        } else {
          expect(b.named, `${c.id} shows its name`).not.toBe('');
          expect(b.nameBeside, `${c.id}'s name beside its icon`).toBe(true);
        }
      }
    }
  }
  // Finish sketch: large, the primary action.
  const finish = lay.find((x) => x.id === 'sketch.finish')!;
  expect(finish.size).toBe('large');
  expect(finish.named).toBe('Finish sketch');
  // The small buttons stack three to a column, column by column (DRAW, MODIFY, CONSTRAIN), each
  // column right of the large button before it.
  for (const group of ['draw', 'sketch-modify', 'constrain']) {
    const small = lay.filter((x) => x.group === group && x.size === 'small');
    const rows = [...new Set(small.map((x) => Math.round(x.top)))];
    expect(rows.length, `${group}: three rows`).toBe(3);
    for (let i = 1; i < small.length; i++) {
      const a = small[i - 1];
      const b = small[i];
      const below = Math.abs(b.left - a.left) < 1 && b.top >= a.bottom - 0.5;
      const nextColumn = b.left >= a.left + 1 && Math.round(b.top) === rows[0] && i % 3 === 0;
      expect(below || nextColumn, `${group}: ${b.id} under ${a.id} or at the top of the next column`).toBe(true);
    }
    const large = lay.filter((x) => x.group === group && x.size === 'large');
    for (const l of large) expect(small.every((s) => s.left >= l.right - 0.5), `${group}: the small buttons right of ${l.id}`).toBe(true);
  }
  // The flyouts: their arrows (named "<Flyout> tools") beside a small button, under a large one.
  for (const [id, name] of Object.entries(FLYOUT_NAMES)) {
    const arrow = tb(frame).locator(`[data-tb-flyout="${id}"]`);
    await expect(arrow, `${id}'s arrow`).toBeVisible();
    await expect(arrow).toHaveAttribute('aria-label', name);
    // In the frame's coordinates, as layoutOf's.
    const a = await arrow.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const b = lay.find((x) => x.id === id)!;
    if (b.size === 'large') {
      expect(a.y, `${id}'s arrow under it`).toBeGreaterThanOrEqual(b.bottom - 0.5);
      expect(a.height).toBeLessThanOrEqual(14);
    } else {
      expect(a.x, `${id}'s arrow beside it`).toBeGreaterThanOrEqual(b.right - 0.5);
      expect(Math.abs(a.y - b.top)).toBeLessThanOrEqual(1);
      expect(a.width).toBeLessThanOrEqual(13);
    }
  }
  await expect(tb(frame).locator('[data-tb-flyout="sketch.polygon"]')).toHaveCount(0);
  // A flyout's small button shows the flyout's own short name (the variant's is its accessible name).
  await expect(tb(frame).locator('.tb-btn[data-command="sketch.slot"] .tb-txt')).toHaveText('Slot');

  // The tooltips carry the name, the shortcut and the hint (or why it cannot run now).
  for (const g of groups.filter((x) => x.group !== 'constrain')) {
    for (const c of g.commands) {
      await tb(frame).locator(`.tb-btn[data-command="${c.id}"]`).hover();
      await expect(tip(frame), `${c.id}'s tooltip`).toContainText(c.label);
      const t = (await tip(frame).innerText()).replace(/\s+/g, ' ');
      if (c.shortcut) expect(t, `${c.id}'s tooltip shortcut`).toContain(c.shortcut);
      const second = c.reason ?? c.hint;
      if (second) expect(t, `${c.id}'s tooltip hint`).toContain(second);
    }
  }
  // CONSTRAIN's glyphs: the first one's tooltip names it.
  const constrain = groups.find((g) => g.group === 'constrain')!.commands[0];
  await tb(frame).locator(`.tb-btn[data-command="${constrain.id}"]`).hover();
  await expect(tip(frame)).toContainText(constrain.label);
  // The Ellipse flyout's arrow lists its variants in its tooltip.
  await tb(frame).locator('[data-tb-flyout="sketch.ellipse"]').hover();
  await expect(tip(frame)).toContainText('Ellipse tools');
  await expect(tip(frame)).toContainText('Ellipse, Partial ellipse, Parabola, Conic');

  // The keyboard: Tab goes from Line to Rectangle (the arrows are out of the Tab order); Down on a
  // flyout's button opens its list.
  await tb(frame).locator('.tb-btn[data-command="sketch.line"]').focus();
  await page.keyboard.press('Tab');
  expect(await frame.locator('[data-cad-app]').evaluate(() => document.activeElement?.getAttribute('data-command'))).toBe('sketch.rectangle');
  await page.keyboard.press('ArrowDown');
  await expect(frame.locator('[data-cad-menu] [role="menuitem"] .cad-menu-label')).toHaveText(['Rectangle', 'Center rectangle', '3-point corner rectangle', '3-point center rectangle', 'Parallelogram']);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-menu]')).toHaveCount(0);
  // The large Line's arrow (under it) opens its list under the pair.
  await tb(frame).locator('[data-tb-flyout="sketch.line"]').click();
  await expect(frame.locator('[data-cad-menu] [role="menuitem"] .cad-menu-label')).toHaveText(['Line', 'Centerline', 'Midpoint line']);
  const menuBox = (await frame.locator('[data-cad-menu]').boundingBox())!;
  expect(menuBox.y).toBeGreaterThanOrEqual((await tb(frame).locator('[data-tb-split="sketch.line"]').boundingBox())!.y + 40);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-menu]')).toHaveCount(0);

  // Screenshots for the review (light: the app has no dark theme).
  await page.mouse.move(900, 600);
  await expect(tip(frame)).toHaveCount(0);
  await frame.locator('[data-cad-app]').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shot(page, frame, 'sketch-ribbon-1920');

  // 1600, 1440, 1280: Windows' fonts fold nothing and keep every name in the drawing groups;
  // whatever the font, every drawing group stays on the ribbon.
  const present = groups.flatMap((g) => g.commands.map((c) => c.id));
  const order = FOLD_ORDER.filter((id) => present.includes(id));
  for (const width of [1600, 1440, 1280]) {
    await resizeTo(page, frame, width);
    if (process.platform === 'win32') {
      await expect(tb(frame)).toHaveAttribute('data-fit-folded', '0');
      await expect(tb(frame)).toHaveAttribute('data-fit-labels', '');
      await expect(tb(frame).locator('[data-tb-more]')).toHaveCount(0);
      // VIEW and EDIT keep their names down to 1440; at 1280 they are icons.
      await expect(tb(frame)).toHaveAttribute('data-fit', width >= 1440 ? '0' : '1');
    }
    for (const id of DRAW_GROUPS) await expect(tb(frame).locator(`.tb-btn[data-command="${id}"]`), `${id} at ${width}`).toBeVisible();
    if (width === 1600) {
      await page.mouse.move(900, 600);
      await shot(page, frame, 'sketch-ribbon-1600');
    }
  }

  // Narrower: the groups' names go first (SQUEEZE_ORDER), then commands fold (FOLD_ORDER's start).
  for (const width of [1000, 760]) {
    await resizeTo(page, frame, width);
    const labels = ((await tb(frame).getAttribute('data-fit-labels')) ?? '').split(' ').filter(Boolean);
    expect(labels, `the groups gone to icons at ${width}`).toEqual(SKETCH_LABEL_ORDER.slice(0, labels.length));
    const n = Number(await tb(frame).getAttribute('data-fit-folded'));
    if (n) expect(labels, `every group's names went before anything folded at ${width}`).toEqual(SKETCH_LABEL_ORDER);
    const more = Object.values(await moreOf(frame)).flat();
    for (const id of order.slice(0, n)) expect(more.some((m) => m === id), `${id} in More at ${width}`).toBe(true);
    for (const id of order.slice(n)) await expect(tb(frame).locator(`.tb-btn[data-command="${id}"]`), `${id} on the bar at ${width}`).toBeVisible();
    if (labels.includes('draw')) {
      // A group gone to icons: its small buttons are icons alone (the name still the accessible name).
      const rect = tb(frame).locator('.tb-btn[data-command="sketch.rectangle"]');
      await expect(rect).toHaveAttribute('aria-label', 'Rectangle');
      expect(await rect.locator('.tb-txt').evaluate((t) => getComputedStyle(t).position)).toBe('absolute');
    }
  }
  if (process.platform === 'win32') {
    // Measured (bundled Chromium, Segoe UI): at 1000 px MODIFY's names go; at 760 DRAW's too and
    // six commands fold (Intersect, Project, Point, Construction, Chamfer, Extend).
    await resizeTo(page, frame, 1000);
    await expect(tb(frame)).toHaveAttribute('data-fit-labels', 'sketch-modify');
    await expect(tb(frame)).toHaveAttribute('data-fit-folded', '0');
    await resizeTo(page, frame, 760);
    await expect(tb(frame)).toHaveAttribute('data-fit-labels', 'sketch-modify draw');
    await expect(tb(frame)).toHaveAttribute('data-fit-folded', '6');
  }

  // ---- back to the model ribbon at 1600, then narrow enough that a whole group collapses: FILE
  // (the first of SQUEEZE_ORDER) is one dropdown with its every command.
  await resizeTo(page, frame, 1920);
  await runCommand(frame, 'sketch.finish');
  await expect(tb(frame, 'model')).toBeVisible();
  await resizeTo(page, frame, 1600, 'model');
  if (process.platform === 'win32') {
    await expect(tb(frame, 'model')).toHaveAttribute('data-fit', '0');
    await expect(tb(frame, 'model')).toHaveAttribute('data-fit-labels', '');
  }
  await page.mouse.move(900, 600);
  await shot(page, frame, 'model-ribbon-1600');
  // The widest frame where a group collapses (Segoe UI: about 770 px): FILE first.
  let collapsed: string[] = [];
  for (let w = 900; w >= 640 && !collapsed.length; w -= 10) {
    await resizeTo(page, frame, w, 'model');
    collapsed = ((await tb(frame, 'model').getAttribute('data-fit-collapsed')) ?? '').split(' ').filter(Boolean);
  }
  expect(collapsed).toEqual(['file']);
  if (collapsed.includes('file')) {
    const fileMenu = tb(frame, 'model').locator('[data-tb-group-menu="file"]');
    await expect(fileMenu).toHaveAttribute('aria-label', 'File commands');
    await expect(fileMenu.locator('.tb-txt')).toHaveText('File ▾');
    await expect(tb(frame, 'model').locator('[data-group="file"] .tb-btn[data-command]')).toHaveCount(0);
    await fileMenu.click();
    await expect(frame.locator('[data-cad-menu] [role="menuitem"] .cad-menu-label')).toHaveText(['Import STEP', 'Export STEP', 'Picture']);
    await page.keyboard.press('Escape');
    await expect(frame.locator('[data-cad-menu]')).toHaveCount(0);
  }
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
