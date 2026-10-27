// The compact sketch toolbar (v0.5.0, Daniel: the sketch toolbar as SolidWorks's Sketch tab shows
// it, every drawing group on the bar at 1920 px). As the person sees it:
//   - at 1920 x 1000 every sketch command is a button on the bar, none in a More menu: the drawing
//     groups Line ▾, Rectangle ▾, Circle ▾, Arc ▾, Slot ▾, Polygon, Spline ▾, Ellipse ▾ (each flyout
//     with its narrow arrow), then MODIFY, CONSTRAIN, DIMENSION, Finish sketch, VIEW, SCALE MODELS
//     and EDIT;
//   - the buttons are icons (Finish sketch keeps its label): the name is the accessible name and
//     the tooltip gives the name, the shortcut and the hint; Tab goes button to button, Down on a
//     flyout's button opens its list;
//   - at 1600 px nothing folds (Windows' fonts; elsewhere the drawing groups at least stay), at
//     1440 and 1280 px what folds is the start of FOLD_ORDER (1280: Slot, Polygon and Ellipse go to
//     DRAW's More);
//   - screenshots at 1920 with a light and a dark preferred colour scheme (CAD_E2E_SHOTS).
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
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: 170 } });
}

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar="sketch"]');
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
async function resizeTo(page: Page, frame: FrameLocator, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await expect.poll(() => frame.locator('[data-cad-app]').evaluate(() => window.innerWidth), `the frame at ${width} px`).toBe(width);
  // The fit runs before paint once the toolbar has seen its new width: settled when it no longer scrolls.
  await expect.poll(() => tb(frame).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await frame.locator('[data-cad-app]').evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Every More menu's commands on the sketch toolbar (group -> ids). */
async function moreOf(frame: FrameLocator): Promise<Record<string, string[]>> {
  return tb(frame).evaluate((el) =>
    Object.fromEntries(Array.from(el.querySelectorAll('[data-tb-more]')).map((m) => [m.getAttribute('data-tb-more'), (m.getAttribute('data-more-commands') ?? '').split(' ')])),
  );
}

test('cad:sketch-toolbar-fit at 1920 x 1000 every sketch group (Ellipse flyout too) is an icon on the bar, none in More, its tooltip with name, shortcut and hint; 1600 folds nothing; 1440 and 1280 fold in FOLD_ORDER', async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const seen = await watchPage(page);
  await openProject(page, await newProject(request));
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  // The model toolbar keeps its labels (not compact).
  await expect(frame.locator('[data-cad-toolbar="model"]')).not.toHaveAttribute('data-compact', '1');
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await runCommand(frame, 'sketch.new');
  await expect(tb(frame)).toBeVisible();
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  await expect(tb(frame)).toHaveAttribute('data-compact', '1');
  await resizeTo(page, frame, 1920);

  // SolidWorks's order: drawing, the sketch tools, relations and dimensions; then Finish sketch.
  await expect(tb(frame).locator('.tb-group-label')).toHaveText(['DRAW', 'MODIFY', 'CONSTRAIN', 'DIMENSION', 'SKETCH', 'VIEW', 'SCALE MODELS', 'EDIT']);
  // 1920: nothing folds, no More anywhere.
  await expect(tb(frame)).toHaveAttribute('data-fit-folded', '0');
  await expect(tb(frame)).toHaveAttribute('data-folded', '0');
  await expect(tb(frame).locator('[data-tb-more]')).toHaveCount(0);
  const drawShown = await tb(frame)
    .locator('[data-group="draw"] .tb-btn[data-command]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
  expect(drawShown.filter((id) => DRAW_GROUPS.includes(id ?? ''))).toEqual(DRAW_GROUPS);
  for (const [id, name] of Object.entries(FLYOUT_NAMES)) {
    const arrow = tb(frame).locator(`[data-tb-flyout="${id}"]`);
    await expect(arrow, `${id}'s arrow`).toBeVisible();
    await expect(arrow).toHaveAttribute('aria-label', name);
    expect((await arrow.boundingBox())!.width, `${id}'s arrow is narrow`).toBeLessThanOrEqual(12);
  }
  await expect(tb(frame).locator('[data-tb-flyout="sketch.polygon"]')).toHaveCount(0);

  // Every command of the registry is a button inside the frame: an icon with its name as the
  // accessible name (the label visually hidden), 26-28 px wide; Finish sketch keeps its label.
  const fr = (await page.locator('#workspace-frame').boundingBox())!;
  const groups = await registry(page);
  expect(groups.map((g) => g.group)).toEqual(['draw', 'sketch-modify', 'constrain', 'dimension', 'scale']);
  for (const g of groups) {
    for (const c of g.commands) {
      const btn = tb(frame).locator(`[data-group="${g.group}"] .tb-btn[data-command="${c.id}"]`);
      await expect(btn, `${c.id} on the bar at 1920`).toBeVisible();
      await expect(btn).toHaveAttribute('aria-label', c.label);
      const b = (await btn.boundingBox())!;
      expect(b.x >= fr.x - 0.5 && b.x + b.width <= fr.x + fr.width + 0.5, `${c.id} inside the frame`).toBe(true);
      expect(b.width, `${c.id} is compact`).toBeLessThanOrEqual(28);
      const hidden = await btn.locator('.tb-txt').evaluate((t) => getComputedStyle(t).position === 'absolute' && t.getBoundingClientRect().width <= 1);
      expect(hidden, `${c.id} shows its icon alone`).toBe(true);
      await expect(btn.locator('svg')).toHaveCount(1);
    }
  }
  const finish = tb(frame).locator('.tb-btn[data-command="sketch.finish"]');
  expect(await finish.locator('.tb-txt').evaluate((t) => (getComputedStyle(t).position !== 'absolute' ? t.textContent : ''))).toBe('Finish sketch');

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
  // CONSTRAIN's glyphs: the first one's tooltip names it and says what it needs.
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

  // Screenshots for the review: light, then a dark preferred colour scheme.
  await page.mouse.move(900, 600);
  await expect(tip(frame)).toHaveCount(0);
  await frame.locator('[data-cad-app]').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, 'sketch-toolbar-1920-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'sketch-toolbar-1920-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // 1600: Windows' fonts fold nothing; whatever the font, every drawing group stays on the bar.
  await resizeTo(page, frame, 1600);
  if (process.platform === 'win32') {
    await expect(tb(frame)).toHaveAttribute('data-fit-folded', '0');
    await expect(tb(frame).locator('[data-tb-more]')).toHaveCount(0);
  }
  for (const id of DRAW_GROUPS) await expect(tb(frame).locator(`.tb-btn[data-command="${id}"]`), `${id} at 1600`).toBeVisible();
  await shot(page, 'sketch-toolbar-1600-light');

  // Narrower: what folds is always the start of FOLD_ORDER's sketch part.
  const present = groups.flatMap((g) => g.commands.map((c) => c.id));
  const order = FOLD_ORDER.filter((id) => present.includes(id));
  const foldedAt: Record<number, string[]> = {};
  for (const width of [1440, 1280]) {
    await resizeTo(page, frame, width);
    const n = Number(await tb(frame).getAttribute('data-fit-folded'));
    foldedAt[width] = order.slice(0, n);
    const more = Object.values(await moreOf(frame)).flat();
    for (const id of foldedAt[width]) expect(more.some((m) => m === id), `${id} in More at ${width}`).toBe(true);
    for (const id of order.slice(n)) await expect(tb(frame).locator(`.tb-btn[data-command="${id}"]`), `${id} on the bar at ${width}`).toBeVisible();
  }
  if (process.platform === 'win32') {
    // Measured (bundled Chromium, Segoe UI): 1440 folds five, the drawing groups all stay;
    // 1280 ten: Slot, Polygon and Ellipse go to DRAW's More.
    expect(foldedAt[1440]).toEqual(['sketch.intersect', 'sketch.project', 'sketch.point', 'sketch.construction', 'sketch.chamfer']);
    expect(foldedAt[1280]).toEqual(['sketch.intersect', 'sketch.project', 'sketch.point', 'sketch.construction', 'sketch.chamfer', 'sketch.extend', 'sketch.ellipse', 'sketch.polygon', 'sketch.slot', 'sketch.offset']);
  }
  expect(foldedAt[1280].length).toBeGreaterThanOrEqual(foldedAt[1440].length);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
