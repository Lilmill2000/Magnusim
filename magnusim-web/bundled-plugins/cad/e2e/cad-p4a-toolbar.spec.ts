// P4a integration: the toolbar keeps readable labels on Daniel's 1280-1920 px
// screens. What does not fit goes, by a fixed priority, into its group's
// "More ▾" menu (Fusion style), which has the core's menu look, works from the
// keyboard, and lists each command with its icon, shortcut and tooltip.
//   - at 1280 x 800 and 1920 x 1080, in model and in sketch mode, every command
//     of the toolbar is reachable: a labelled button inside the frame, or an item
//     of its group's More menu (label, shortcut, tooltip with the hint or the
//     reason it cannot run); what folds is always the start of the priority list;
//     1920 folds nothing;
//   - the More menu from the keyboard (Enter, Down, Up, arrows, Home, End, Escape
//     back to the button, Enter runs) and the mouse (toggle, a disabled item says
//     why and does not run); a folded command's open panel or tool presses More.
// window.__CAD__ is read only for the registry's list of commands.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';
async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), ...(clip ? { clip } : {}) });
}

/**
 * The decided priority (src/ui/Toolbar.tsx FOLD_ORDER, ARCHITECTURE.md §7 "Toolbar"): the first
 * folds first. Commands not listed never fold.
 */
const FOLD_ORDER = [
  'modify.parameters',
  'inspect.check',
  'construct.point',
  'solid.loft',
  'inspect.mass',
  'modify.split',
  'modify.delete-faces',
  'construct.axis',
  // P4b PATTERN.
  'pattern.circular',
  'pattern.mirror',
  'solid.sweep',
  'modify.shell',
  'file.export-step',
  'solid.revolve',
  'modify.combine',
  'modify.press-pull',
  // P4b fix round 1 (sketch review P2): Intersect and Project first, Daniel's headline tools last.
  'sketch.intersect',
  'sketch.project',
  'sketch.point',
  'sketch.construction',
  'sketch.chamfer',
  'sketch.spline-control',
  'sketch.arc-tangent',
  'sketch.rectangle-center',
  'sketch.extend',
  'sketch.centerline',
  'sketch.offset',
  'sketch.fillet',
  'sketch.pattern-circular',
  'sketch.pattern-linear',
  'sketch.mirror',
  'sketch.spline',
];

/**
 * The model commands on the bar by default (src/ui/Toolbar.tsx KEEP_IN_VIEW's model part; P4b fix
 * round 1, Daniel: the compact layout at every width). Every other model command starts in its
 * group's More menu.
 */
const MODEL_ON_BAR = ['sketch.new', 'solid.extrude', 'pattern.linear', 'modify.fillet', 'modify.chamfer', 'construct.plane', 'cfd.enclosure', 'inspect.measure', 'file.import-step'];

type Cmd = { id: string; label: string; shortcut: string | null; hint: string | null; reason: string | null };
type Grp = { group: string; label: string; commands: Cmd[] };
type W = { __CAD__: { services: { commands: { toolbar(m: string): { group: string; label: string; commands: { id: string; label: string; shortcut?: string; hint?: string; enabled?(s: unknown): true | string }[] }[] } } & Record<string, unknown> } };

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const menu = (frame: FrameLocator) => frame.locator('[data-cad-menu]');
const tip = (frame: FrameLocator) => frame.locator('[data-cad-tip]');

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** The mode's toolbar groups as the registry has them (labels, shortcuts, hints, and why each cannot run now). */
async function registry(page: Page, mode: 'model' | 'sketch'): Promise<Grp[]> {
  return workspaceFrame(page).evaluate((m) => {
    const s = (window as unknown as W).__CAD__.services;
    return s.commands.toolbar(m).map((g) => ({
      group: g.group,
      label: g.label,
      commands: g.commands.map((c) => {
        let ok: true | string = true;
        try {
          ok = c.enabled ? c.enabled(s) : true;
        } catch (e) {
          ok = String(e);
        }
        return { id: c.id, label: c.label, shortcut: c.shortcut ?? null, hint: c.hint ?? null, reason: ok === true ? null : ok };
      }),
    }));
  }, mode);
}

/** Hover a toolbar button or menu item and read its tooltip ("Chamfer", "X", the hint or the reason). */
async function tipOf(frame: FrameLocator, el: ReturnType<FrameLocator['locator']>, label: string): Promise<string> {
  await el.hover();
  // The tooltip of this item (the one before it goes when the pointer leaves it).
  await expect(tip(frame)).toContainText(label);
  return (await tip(frame).innerText()).replace(/\s+/g, ' ').trim();
}

/**
 * Every command of the mode's toolbar is reachable at this size: shown with its label inside the
 * frame (VIEW and EDIT: icons, their label the accessible name), or an item of its group's More
 * menu with its label, shortcut and tooltip. Returns the folded ids, in folding order.
 */
async function expectAllReachable(page: Page, frame: FrameLocator, mode: 'model' | 'sketch', where: string): Promise<string[]> {
  const bar = frame.locator(`[data-cad-toolbar="${mode}"]`);
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth), `${where}: the toolbar scrolls`).toBeLessThanOrEqual(1);
  const fr = (await page.locator('#workspace-frame').boundingBox())!;
  const right = Math.min(fr.x + fr.width, page.viewportSize()!.width);
  const groups = await registry(page, mode);
  expect(groups.length, `${where}: toolbar groups`).toBeGreaterThan(3);
  const folded: string[] = [];
  for (const g of groups) {
    const box = bar.locator(`[data-group="${g.group}"]`);
    const more = box.locator('[data-tb-more]');
    const inMore: Cmd[] = [];
    for (const c of g.commands) {
      const btn = box.locator(`.tb-btn[data-command="${c.id}"]`);
      if (await btn.count()) {
        await expect(btn, `${where}: ${c.id}`).toHaveAttribute('aria-label', c.label);
        const r = (await btn.boundingBox())!;
        expect(r.x >= fr.x - 0.5 && r.x + r.width <= right + 0.5, `${where}: ${c.id} inside the frame`).toBe(true);
        // CONSTRAIN draws its constraints' own glyphs (labels in the tooltips, by design since P3).
        if (g.group !== 'constrain') {
          const label = await btn.locator('.tb-txt').evaluate((t) => {
            const r2 = t.getBoundingClientRect();
            return getComputedStyle(t).position !== 'absolute' && r2.width > 12 ? (t.textContent ?? '') : '';
          });
          expect(label, `${where}: ${c.id} shows its label`).toBe(c.label);
        }
      } else {
        inMore.push(c);
      }
    }
    if (!inMore.length) {
      await expect(more, `${where}: ${g.group} has no More`).toHaveCount(0);
      continue;
    }
    // The group's More holds exactly the commands not shown, in the group's order.
    await expect(more).toHaveAttribute('data-more-commands', inMore.map((c) => c.id).join(' '));
    await expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more.locator('.tb-txt')).toHaveText('More ▾');
    const words = g.label[0] + g.label.slice(1).toLowerCase();
    await expect(more).toHaveAttribute('aria-label', `More ${words} commands`);
    const mr = (await more.boundingBox())!;
    expect(mr.x >= fr.x - 0.5 && mr.x + mr.width <= right + 0.5, `${where}: ${g.group}'s More inside the frame`).toBe(true);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(menu(frame)).toHaveAttribute('aria-label', `More ${words} commands`);
    // ux010: a toggle (Construction) is a menuitemcheckbox.
    const items = menu(frame).locator('button[role^="menuitem"]');
    await expect(items.locator('.cad-menu-label')).toHaveText(inMore.map((c) => c.label));
    for (const c of inMore) {
      const item = menu(frame).locator(`[data-command="${c.id}"]`);
      await expect(item.locator('svg')).toHaveCount(1);
      if (c.shortcut) await expect(item.locator('.cad-menu-key')).toHaveText(c.shortcut);
      else await expect(item.locator('.cad-menu-key')).toHaveCount(0);
      if (c.reason) await expect(item).toHaveAttribute('aria-disabled', 'true');
      else await expect(item).not.toHaveAttribute('aria-disabled', 'true');
      const t = await tipOf(frame, item, c.label);
      expect(t, `${where}: ${c.id}'s tooltip`).toContain(c.label);
      if (c.shortcut) expect(t).toContain(c.shortcut);
      const second = c.reason ?? c.hint;
      if (second) expect(t, `${where}: ${c.id}'s tooltip`).toContain(second);
      folded.push(c.id);
    }
    // Escape closes it and gives the button the keyboard back.
    await page.keyboard.press('Escape');
    await expect(menu(frame)).toHaveCount(0);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(await more.evaluate((el) => el === document.activeElement), `${where}: Escape gives ${g.group}'s More the keyboard`).toBe(true);
  }
  await expect(bar).toHaveAttribute('data-folded', String(folded.length));
  // In More by the default layout (model mode: everything but each group's main command), then what
  // the width folds: always the start of the priority list of the rest (the most-used stay longest).
  const present = groups.flatMap((g) => g.commands.map((c) => c.id));
  const byLayout = mode === 'model' ? present.filter((id) => !MODEL_ON_BAR.includes(id)) : [];
  expect(folded.filter((id) => byLayout.includes(id)).sort(), `${where}: the default layout's More commands`).toEqual([...byLayout].sort());
  const byWidth = folded.filter((id) => !byLayout.includes(id));
  await expect(bar).toHaveAttribute('data-fit-folded', String(byWidth.length));
  const order = FOLD_ORDER.filter((id) => present.includes(id) && !byLayout.includes(id));
  expect([...byWidth].sort((a, b) => order.indexOf(a) - order.indexOf(b)), `${where}: folded in priority order`).toEqual(order.slice(0, byWidth.length));
  return byWidth;
}

async function sketchOnTop(frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
}

async function finishSketch(frame: FrameLocator) {
  await tb(frame).locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

test('cad:p4a-toolbar-reach at 1280 x 800 and 1920 x 1080 every command is a labelled button or an item of its group\'s More menu with its shortcut and tooltip, in model and sketch mode', { tag: '@smoke' }, async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { seen, frame } = await freshPart(page, request);
  // A body, so the MODIFY commands can run (their tooltips then carry hints, not reasons).
  await addSolid(page);
  const result: Record<string, string[]> = {};
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
    result[`model ${size.width}`] = await expectAllReachable(page, frame, 'model', `model at ${size.width}`);
    await shot(page, `toolbar-model-${size.width}`, { x: 0, y: 0, width: size.width, height: 150 });
    await sketchOnTop(frame);
    result[`sketch ${size.width}`] = await expectAllReachable(page, frame, 'sketch', `sketch at ${size.width}`);
    await shot(page, `toolbar-sketch-${size.width}`, { x: 0, y: 0, width: size.width, height: 150 });
    await finishSketch(frame);
  }
  // P4b fix round 1 (Daniel: "I prefer 1280 px (model)"): model mode is the compact layout at both
  // sizes (checked above: everything but each group's main command in More) and the width folds
  // nothing more. Sketch mode keeps every command on the ribbon by default; with one-line labels
  // 1920 px folds at most the six least used (Intersect, Project, Point, Construction, Chamfer,
  // Control-point spline: the start of FOLD_ORDER's sketch part, checked in order above).
  expect(result['model 1920']).toEqual([]);
  expect(result['model 1280']).toEqual([]);
  expect(result['sketch 1920'].length).toBeLessThanOrEqual(6);
  expect(result['sketch 1280'].length).toBeGreaterThan(result['sketch 1920'].length);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p4a-toolbar-more-keys the More menu from the keyboard and the mouse: Enter, Down and Up open it, arrows Home End move, Escape gives the button the keyboard back, Enter runs; a disabled item says why; an open folded command presses More', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { seen, frame } = await freshPart(page, request);
  const more = tb(frame).locator('[data-group="modify"] [data-tb-more]');
  await expect(more).toBeVisible();
  const ids = ((await more.getAttribute('data-more-commands')) ?? '').split(' ');
  expect(ids[0]).toBe('modify.parameters');
  expect(ids).toContain('modify.shell');
  // P4a review: Chamfer never folds; it is a labelled button right after Fillet.
  expect(ids).not.toContain('modify.chamfer');
  const modifyButtons = await tb(frame).locator('[data-group="modify"] .tb-btn[data-command]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
  expect(modifyButtons.slice(0, 2)).toEqual(['modify.fillet', 'modify.chamfer']);
  const focused = () =>
    frame.locator('[data-cad-app]').evaluate(() => {
      const el = document.activeElement;
      return el ? (el.getAttribute('data-command') ?? el.getAttribute('data-tb-more') ?? el.tagName) : null;
    });

  // Enter opens it on its first command that can run (an empty Part: Parameters).
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(menu(frame)).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(focused).toBe('modify.parameters');
  await shot(page, 'toolbar-more-menu-1280', { x: 0, y: 0, width: 1280, height: 420 });
  await page.keyboard.press('ArrowDown');
  await expect.poll(focused).toBe(ids[1]);
  await page.keyboard.press('End');
  await expect.poll(focused).toBe(ids[ids.length - 1]);
  await page.keyboard.press('Home');
  await expect.poll(focused).toBe(ids[0]);
  await page.keyboard.press('Escape');
  await expect(menu(frame)).toHaveCount(0);
  await expect.poll(focused).toBe('modify');
  // Up opens it on its last command; Down on its first.
  await page.keyboard.press('ArrowUp');
  await expect(menu(frame)).toBeVisible();
  await expect.poll(focused).toBe(ids[ids.length - 1]);
  await page.keyboard.press('Tab');
  await expect(menu(frame)).toHaveCount(0);
  await expect.poll(focused).toBe('modify');
  await page.keyboard.press('ArrowDown');
  await expect.poll(focused).toBe('modify.parameters');
  // A command that cannot run says why (its tooltip, as its toolbar button would) and does not run.
  const shell = menu(frame).locator('[data-command="modify.shell"]');
  await expect(shell).toHaveAttribute('aria-disabled', 'true');
  await expect(shell).toHaveAttribute('data-disabled-reason', 'Make or import a body first');
  expect(await tipOf(frame, shell, 'Shell')).toContain('Make or import a body first');
  await shell.click({ force: true });
  await expect(menu(frame)).toBeVisible();
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);
  // Enter runs the focused command: the Parameters panel; More is pressed while it is open.
  await menu(frame).locator('[data-command="modify.parameters"]').focus();
  await page.keyboard.press('Enter');
  await expect(menu(frame)).toHaveCount(0);
  await expect(frame.locator('[data-cad-panel="params"] [data-panel-title]')).toHaveText('Parameters');
  await expect(more).toHaveClass(/is-active/);
  await more.click();
  await expect(menu(frame).locator('[data-command="modify.parameters"]')).toHaveAttribute('aria-current', 'true');
  // A second press on More closes it (a toggle).
  await more.click();
  await expect(menu(frame)).toHaveCount(0);
  await frame.locator('[data-cad-panel="params"] [data-panel-done]').click();
  await expect(more).not.toHaveClass(/is-active/);

  // With a body: Shell from the menu opens its panel, and More is pressed.
  await addSolid(page);
  await more.click();
  await menu(frame).locator('[data-command="modify.shell"]').click();
  await expect(frame.locator('[data-cad-panel="feature"] [data-panel-title]')).toHaveText('Shell 1');
  await expect(more).toHaveClass(/is-active/);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);

  // Sketch mode: DRAW's More lists Construction with its shortcut X; Point from it is the tool in use.
  await sketchOnTop(frame);
  const draw = tb(frame).locator('[data-group="draw"] [data-tb-more]');
  await expect(draw).toBeVisible();
  await draw.click();
  await expect(menu(frame).locator('[data-command="sketch.construction"] .cad-menu-key')).toHaveText('X');
  await menu(frame).locator('[data-command="sketch.point"]').click();
  await expect(menu(frame)).toHaveCount(0);
  await expect(draw).toHaveClass(/is-active/);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
