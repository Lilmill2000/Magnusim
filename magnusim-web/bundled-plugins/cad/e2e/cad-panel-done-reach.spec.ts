// A feature panel's Done (and Delete) is always reachable, whatever the platform's font and
// however tall the panel's content: the panel's head and foot stay in view and its body
// scrolls between them (src/ui/ui.css, .tree-detail > .cad-panel).
// Linux CI draws the app in DejaVu Sans, wider and taller than Segoe UI, and at 1280 x 800
// the Enclosure panel of SD review 2's one-note test ran past the room above the dock: the
// whole panel scrolled, so 30 % of Done was out of view (and with it the way to close the
// panel without scrolling). Here a wide, tall font is forced into the Part's page (Verdana
// at 14 px, falling back to DejaVu Sans; a constructable stylesheet, which the page's CSP
// allows) on the tallest panels:
//   - Enclosure with Fixed padding, every side into the part (the note under the sides),
//     then a value the field refuses (its reason too);
//   - Extrude (the second body's) with every option shown: Up to (the target picker and the Offset), Along, Flip,
//     Operation, and the foot's "Not applied" note;
//   - Fillet with every edge the view shows picked (a row each).
// For each: the body really overflows (Enclosure, Extrude: else the check proves nothing), Done is wholly in the
// viewport and nothing covers it (the dock's chips included), the body scrolls to its last
// row, and Done closes the panel.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

type V3 = [number, number, number];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${esc(name)}$`) }) });

type CadWin = {
  __CAD__: {
    services: {
      doc: { state: { get(): { rebuild: { status: string } } } };
      viewport: { get(): { handle: { project(p: V3): [number, number] | null; pick(x: number, y: number): { item: { kind: string } } | null; state: { get(): { animating: boolean } } } } };
    };
  };
};
const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

async function settled(page: Page) {
  await expect.poll(() => cad<string>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().rebuild.status) as never)).toBe('done');
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.state.get().animating) as never)).toBe(false);
}

/** A wide, tall font over the whole Part page (as Linux CI's DejaVu Sans, and more). */
async function forceWideFont(page: Page) {
  await workspaceFrame(page).evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('* { font-family: Verdana, "DejaVu Sans", sans-serif !important; font-size: 14px !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
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
  await forceWideFont(page);
  return { seen, frame };
}

/**
 * The open panel overflows its room (unless `mustOverflow` is false), Done is whole in the
 * viewport and on top (nothing covers its centre or corners), and the body scrolls to its last row.
 */
async function doneReachable(frame: FrameLocator, name: string, mustOverflow = true) {
  const p = panel(frame);
  const done = p.locator('[data-panel-done]');
  await expect(done, `${name}: Done in view`).toBeInViewport({ ratio: 1 });
  const r = await done.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const pts: [number, number][] = [
      [(b.left + b.right) / 2, (b.top + b.bottom) / 2],
      [b.left + 2, b.top + 2],
      [b.right - 2, b.top + 2],
      [b.left + 2, b.bottom - 2],
      [b.right - 2, b.bottom - 2],
    ];
    const covered = pts.filter(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !hit || (hit !== el && !el.contains(hit));
    });
    const body = el.closest('.cad-panel')!.querySelector<HTMLElement>('.mgk-panel-body')!;
    return { covered: covered.length, inWindow: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth, overflow: body.scrollHeight - body.clientHeight };
  });
  expect(r.covered, `${name}: something covers Done`).toBe(0);
  expect(r.inWindow, `${name}: Done inside the window`).toBe(true);
  if (mustOverflow) expect(r.overflow, `${name}: the panel's body is taller than its room (the check needs the overflow)`).toBeGreaterThan(20);
  // The body scrolls between the head and the foot: its last row comes into view, Done stays.
  const last = await p.locator('.mgk-panel-body').evaluate((body: HTMLElement) => {
    body.scrollTop = body.scrollHeight;
    const rows = body.querySelectorAll<HTMLElement>('[data-field], [data-pick-row], .cad-field, .mgk-hint');
    const el = rows[rows.length - 1];
    const b = el.getBoundingClientRect();
    const v = body.getBoundingClientRect();
    return { top: b.top - v.top, bottom: v.bottom - b.bottom };
  });
  expect(last.top, `${name}: the last row scrolled into the body`).toBeGreaterThanOrEqual(-1);
  expect(last.bottom, `${name}: the last row scrolled into the body`).toBeGreaterThanOrEqual(-1);
  await expect(done, `${name}: Done in view after scrolling`).toBeInViewport({ ratio: 1 });
}

async function setField(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
}

test('cad:panel-done-reach Enclosure, Extrude with every option and Fillet with every edge: Done stays whole in view at 1280 x 800 with a wide, tall font; the body scrolls between head and foot', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { at: [0, 0, 0], size: [40, 40, 40] });
  await addSolid(page, { at: [60, 0, 0], size: [20, 20, 20] });
  await settled(page);

  // Enclosure: Fixed padding, every side into the part (one note), then a refused value.
  await runCommand(frame, 'cfd.enclosure');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText(/^Enclosure \d+$/);
  await panel(frame).locator('[data-field="padding"] select').selectOption('fixed');
  for (const k of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) await setField(frame, `side-${k}`, '-2');
  await expect(panel(frame).locator('[data-side-note]')).toHaveCount(1);
  await settled(page);
  await doneReachable(frame, 'Enclosure');
  await setField(frame, 'side-nx', '-90');
  await expect(panel(frame).locator('.nui[data-field="side-nx"] [data-nui-error]')).toBeVisible();
  await doneReachable(frame, 'Enclosure with a refused value');
  await shot(page, 'panel-done-reach-enclosure');
  await panel(frame).locator('.nui[data-field="side-nx"] input').press('Escape');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);

  // Extrude 2 (a body before it, so it has an Operation) with every option shown: Up to (target and
  // Offset), Along, Flip, Operation, the foot's note.
  await featureRow(frame, 'Extrude 2').locator('> .tree-row').dblclick();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Extrude 2');
  await panel(frame).locator('[data-field="extent"] select').selectOption('to');
  await expect(panel(frame).locator('.nui[data-field="offset"] input')).toBeVisible();
  await panel(frame).locator('[data-field="op"] select').selectOption('cut');
  await doneReachable(frame, 'Extrude');
  await shot(page, 'panel-done-reach-extrude');
  // Back to how it was (nothing of this is wanted), then Done.
  await panel(frame).locator('[data-field="op"] select').selectOption('new');
  await panel(frame).locator('[data-field="extent"] select').selectOption('blind');
  await expect(panel(frame).locator('.nui[data-field="distance"] input')).toHaveValue('20');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await settled(page);

  // Fillet: every edge of the first block the view shows (picked where the view says an edge is).
  await runCommand(frame, 'modify.fillet');
  await expect(panel(frame).locator('[data-feature-panel="fillet"]')).toBeVisible();
  const edges: V3[] = [];
  for (const a of [0, 40])
    for (const b of [0, 40]) {
      edges.push([20, a, b], [a, 20, b], [a, b, 20]);
    }
  const rows = panel(frame).locator('[data-pick-field="edges"] [data-pick-row]');
  for (const e of edges) {
    const xy = await cad<[number, number] | null>(page, ((q: V3) => {
      const h = (window as unknown as CadWin).__CAD__.services.viewport.get().handle;
      const s = h.project(q);
      return s && h.pick(s[0], s[1])?.item.kind === 'edge' ? s : null;
    }) as never, e);
    if (!xy) continue;
    // Two midpoints can land on one edge on screen (a hidden edge behind a shown one): a click
    // that picks an edge already in the list is not counted.
    const before = await rows.count();
    const box = (await page.locator('#workspace-frame').boundingBox())!;
    await page.mouse.click(box.x + xy[0], box.y + xy[1]);
    await expect.poll(() => rows.count(), { timeout: 3_000 }).not.toBe(before).catch(() => {});
  }
  expect(await rows.count(), 'edges the view shows, picked').toBeGreaterThanOrEqual(6);
  await settled(page);
  // Its rows fit at this size on some fonts: Done is checked whether or not the body scrolls.
  await doneReachable(frame, 'Fillet', false);
  await shot(page, 'panel-done-reach-fillet');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
