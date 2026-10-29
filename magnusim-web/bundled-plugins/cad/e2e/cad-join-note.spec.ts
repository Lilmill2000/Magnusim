// A Join whose tools do not touch the target (Daniel's two-colour poker chip: an inlay grouped from
// spots and rings, later the tool of a Cut with keep tools). The result is right and often meant, so
// the History row shows a quiet info mark with "Note: ..." in plain words, not the amber warning
// triangle and "What's wrong: Inlay is now 8 separate solids: the tools do not touch it". A Cut that
// splits its target is a real surprise and keeps the warning badge.
// window.__CAD__ is used only to make the four blocks (addSolid, as the other specs do).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const NOTE = "Body 1 holds 2 separate pieces: they don't touch, so they stay apart in one body (fine for a group like an inlay; to fuse pieces, they must overlap)";

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel]');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator(`> .tree-row .tl`, { hasText: new RegExp(`^${name}$`) }) });
const bodyRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-body-row]').filter({ has: frame.locator('.cad-body-name', { hasText: new RegExp(`^${name}$`) }) });

async function openBodies(frame: FrameLocator) {
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
}

/** A new Combine through its panel: the operation, then the target and the tool picked in Bodies. */
async function combine(frame: FrameLocator, op: 'join' | 'cut', target: string, tool: string) {
  await openBodies(frame);
  await runCommand(frame, 'modify.combine');
  const p = panel(frame);
  if (op !== 'join') await p.locator('[data-field="op"] select').selectOption(op);
  await p.locator('[data-pick-list="targets"]').click();
  await bodyRow(frame, target).locator('.tree-row').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  await bodyRow(frame, tool).locator('.tree-row').first().click();
}

async function tipOf(page: Page, frame: FrameLocator, badge: ReturnType<FrameLocator['locator']>): Promise<string> {
  await badge.hover();
  const tip = frame.locator('[data-cad-tip]');
  await expect(tip).toBeVisible();
  const text = (await tip.textContent()) ?? '';
  await page.mouse.move(5, 5);
  await expect(tip).toHaveCount(0);
  return text;
}

test('cad:join-note a Join of blocks that do not touch shows a quiet note, not a warning; a Cut that splits a body still warns', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  // Body 1 and Body 2: two 10 mm cubes 20 mm apart. Body 3: a 30 x 10 bar; Body 4: a 10 x 20 bar
  // across its middle, far from the cubes.
  await addSolid(page, { at: [0, 0, 0], size: [10, 10, 10] });
  await addSolid(page, { at: [30, 0, 0], size: [10, 10, 10] });
  await addSolid(page, { at: [0, 40, 0], size: [30, 10, 10] });
  await addSolid(page, { at: [10, 35, 0], size: [10, 20, 10] });

  // Join Body 2 to Body 1: they stay apart in one body. Said as a note: an info mark, not amber.
  await combine(frame, 'join', 'Body 1', 'Body 2');
  const join = featureRow(frame, 'Combine 1');
  const mark = join.locator('[data-feature-badge]');
  await expect(mark).toHaveAttribute('data-feature-badge', 'note', { timeout: 30_000 });
  await expect(join).toHaveAttribute('data-state', 'ok');
  await expect(join).not.toHaveClass(/is-warning/);
  await expect(join.locator('[data-feature-badge="warning"]')).toHaveCount(0);
  await expect(mark).toHaveAttribute('aria-label', `Note: ${NOTE}`);
  await expect(mark).toHaveClass(/is-note/);
  // The panel's foot says it in plain words, not as a warning.
  const p = panel(frame);
  await expect(p.locator('[data-note]')).toHaveText(`Note: ${NOTE}`);
  await expect(p.locator('[data-warning]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  // Its tooltip: "Note" and the words, no "What's wrong".
  const tip = await tipOf(page, frame, mark);
  expect(tip).toBe(`Note${NOTE}`);
  expect(tip).not.toContain("What's wrong");
  // The info mark is quieter than a warning: not the warning colour.
  const colours = await mark.evaluate((el) => {
    const probe = document.createElement('span');
    probe.className = 'cad-badge is-warning';
    el.parentElement!.appendChild(probe);
    const warn = getComputedStyle(probe).color;
    probe.remove();
    return { note: getComputedStyle(el).color, warn };
  });
  expect(colours.note).not.toBe(colours.warn);

  // Cut Body 4 from Body 3: two pieces where there was one. A real surprise: the warning badge.
  await combine(frame, 'cut', 'Body 3', 'Body 4');
  const cut = featureRow(frame, 'Combine 2');
  await expect(cut).toHaveAttribute('data-state', 'warning', { timeout: 30_000 });
  const badge = cut.locator('[data-feature-badge]');
  await expect(badge).toHaveAttribute('data-feature-badge', 'warning');
  await expect(badge).toHaveAttribute('aria-label', "What's wrong: Body 3 is now in 2 separate pieces");
  await expect(cut.locator('[data-feature-badge="note"]')).toHaveCount(0);
  await expect(p.locator('[data-warning]')).toContainText('Body 3 is now in 2 separate pieces');
  await expect(p.locator('[data-note]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect(await tipOf(page, frame, badge)).toBe("What's wrongBody 3 is now in 2 separate pieces");
  // The Join's note is still there, and still not a warning.
  await expect(join.locator('[data-feature-badge]')).toHaveAttribute('data-feature-badge', 'note');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
