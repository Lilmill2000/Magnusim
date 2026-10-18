// A panel the Assistant fills, as the person sees it in the real host frame (D4): an Assistant
// step's session (doc.assistant, through the test handle; the Assistant's tools come later)
// opens the person's own panel, read-only: the "Assistant" badge, no rename, inert fields, no
// Delete, Done disabled with the reason "The Assistant is filling this in · Esc takes over (the
// Assistant pauses)". The body and the volume follow its draft live. A click in the view only
// selects; Escape, Ctrl+Z or the toolbar's Extrude takes the panel over: it goes, nothing of it
// is kept, and the step is marked. The person's open Parameters panel stays theirs and flashes
// the rows an Assistant step changes.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, runCommand, singleVolume, watchPage, workspaceFrame } from './helpers';

const DONE_REASON = 'The Assistant is filling this in · Esc takes over (the Assistant pauses)';

type Step = { owner: string; takenOver: string | null; ended: boolean; run<T>(fn: () => T): T; revert(): { ok: boolean }; end(): void };
type Session = { feature: string; open: boolean; update(p: unknown): void };
type CadDoc = {
  assistant: { begin(owner: string): Step };
  beginEdit(id: string): Session;
  addParam(p: { name: string; expr: string; quantity: string }): string | { ok: false; reason: string };
  editParams(rows: { add: unknown[]; change: { id: string; patch: { expr: string } }[]; remove: string[] }): { ok: boolean };
  state: { get(): { doc: { features: { id: string; name: string; extent?: { distance: string } }[] }; history: { undoLabel: string | null } } };
};
type W = { __CAD__: { services: { doc: CadDoc } }; __step?: Step; __session?: Session };

/** The volume chip's one body, to the mm³ (the kernel's volume of a 20 mm cube is 7999.999999999998). */
const volume = async (frame: FrameLocator) => Math.round(await singleVolume(frame));

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** An Assistant step opens the Edit of `feature` and sets its distance (the draft applies live). */
async function assistantEdits(page: Page, feature: string, distance: string, owner: string) {
  await cad(
    page,
    (({ feature, distance, owner }: { feature: string; distance: string; owner: string }) => {
      const w = window as unknown as W;
      const doc = w.__CAD__.services.doc;
      const step = doc.assistant.begin(owner);
      const s = step.run(() => doc.beginEdit(feature));
      s.update({ extent: { kind: 'blind', distance } });
      w.__step = step;
      w.__session = s;
    }) as never,
    { feature, distance, owner },
  );
}

const stepState = (page: Page) =>
  cad<{ takenOver: string | null; open: boolean }>(page, (() => {
    const w = window as unknown as W;
    return { takenOver: w.__step!.takenOver, open: w.__session!.open };
  }) as never);

/** The call's catch, as the Assistant's own will be: back to the mark, then the end. */
const revertAndEnd = (page: Page) =>
  cad(page, (() => {
    const w = window as unknown as W;
    w.__step!.revert();
    w.__step!.end();
  }) as never);

const distanceOf = (page: Page, feature: string) =>
  cad<string | null>(page, ((id: string) => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((f) => f.id === id)?.extent?.distance ?? null) as never, feature);

/** The keyboard in the frame, with nothing chosen: a click on an empty corner of the view (it only clears the selection). */
async function keyboardInFrame(page: Page, frame: FrameLocator) {
  // (A locator's box is in the page's coordinates, the frame's offset included.)
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
}

test('cad:assistant-panel a panel the Assistant fills is read-only and badged, follows its draft live, and Escape takes it over keeping nothing', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const made = await addSolid(page);
  await expect.poll(() => volume(frame), { timeout: 30_000 }).toBe(8000);
  const tip = frame.locator('[data-cad-tip]');

  await assistantEdits(page, made.extrude, '30 mm', 'assistant:e2e-1');
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
  await expect(panel.locator('[data-panel-badge]')).toHaveText('Assistant');
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(panel.locator('[data-rename-btn]')).toHaveCount(0);
  await expect(panel.locator('[data-panel-delete]')).toHaveCount(0);
  // Its fields show the Assistant's values and take no keyboard (the body is inert).
  const distance = panel.locator('.nui[data-field="distance"] input');
  await expect(distance).toHaveValue('30');
  expect(await panel.locator('.mgk-panel-body').evaluate((el) => el.hasAttribute('inert'))).toBe(true);
  expect(await distance.evaluate((el: HTMLInputElement) => (el.focus(), document.activeElement === el))).toBe(false);
  // Done stays in the foot, disabled, and says why; hovering it shows the reason.
  const done = panel.locator('[data-panel-done]');
  await expect(done).toHaveAttribute('aria-disabled', 'true');
  await expect(done).toHaveAttribute('data-disabled-reason', DONE_REASON);
  await done.hover();
  await expect(tip).toContainText(DONE_REASON);
  // The toolbar's Undo says what it does on the Assistant's panel.
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').hover();
  await expect(tip).toContainText('Take over from the Assistant: its open panel is discarded');
  // The person's own path otherwise: the tree row edits, the body and the volume are live.
  await expect(frame.locator(`[data-tree-node="${made.extrude}"]`)).toHaveClass(/is-editing/);
  await expect.poll(() => volume(frame), { timeout: 30_000 }).toBe(12000);

  // A click in the view only selects (looking is not taking over).
  await keyboardInFrame(page, frame);
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
  expect(await stepState(page)).toEqual({ takenOver: null, open: true });

  // Escape takes over: the panel goes, nothing of it is kept, the step is marked.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(await stepState(page)).toEqual({ takenOver: 'escape', open: false });
  expect(await distanceOf(page, made.extrude)).toBe('20 mm');
  await expect.poll(() => volume(frame), { timeout: 30_000 }).toBe(8000);
  await revertAndEnd(page);
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1', 'Extrude 1']);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:assistant-panel Ctrl+Z on the Assistant\'s panel takes it over and undoes nothing; the toolbar\'s Extrude takes it over for the person\'s own', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const made = await addSolid(page);
  const panel = frame.locator('[data-cad-panel="feature"]');
  const undoLabel = () => cad<string | null>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel) as never);
  const before = await undoLabel();

  await assistantEdits(page, made.extrude, '30 mm', 'assistant:e2e-2');
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
  await keyboardInFrame(page, frame);
  await page.keyboard.press('Control+z');
  await expect(panel).toHaveCount(0);
  expect(await stepState(page)).toEqual({ takenOver: 'undo', open: false });
  expect(await distanceOf(page, made.extrude)).toBe('20 mm');
  expect(await undoLabel()).toBe(before);
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1', 'Extrude 1']);
  await revertAndEnd(page);

  await assistantEdits(page, made.extrude, '30 mm', 'assistant:e2e-3');
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
  await runCommand(frame, 'solid.extrude');
  // The person's own new Extrude: not the Assistant's, Done and Delete as always.
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 2');
  await expect(panel).not.toHaveAttribute('data-panel-owner', /.+/);
  await expect(panel.locator('[data-panel-badge]')).toHaveCount(0);
  expect(await stepState(page)).toEqual({ takenOver: 'command', open: false });
  expect(await distanceOf(page, made.extrude)).toBe('20 mm');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await revertAndEnd(page);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:assistant-panel the person\'s Parameters panel stays open and theirs, and flashes the rows an Assistant step changes', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const ids = await cad<string[]>(page, (() => {
    const doc = (window as unknown as W).__CAD__.services.doc;
    return [String(doc.addParam({ name: 'w', expr: '20 mm', quantity: 'length' })), String(doc.addParam({ name: 'd', expr: '5 mm', quantity: 'length' }))];
  }) as never);
  await runCommand(frame, 'modify.parameters');
  const panel = frame.locator('[data-cad-panel="params"]');
  await expect(panel.locator('[data-param-row]')).toHaveCount(2);
  await cad(
    page,
    ((w: string) => {
      const win = window as unknown as W;
      const doc = win.__CAD__.services.doc;
      const step = doc.assistant.begin('assistant:e2e-4');
      step.run(() => doc.editParams({ add: [{ name: 'h', expr: '8 mm', quantity: 'length' }], change: [{ id: w, patch: { expr: '30 mm' } }], remove: [] }));
      win.__step = step;
    }) as never,
    ids[0],
  );
  // The new values at once, the changed rows flashed; the panel is still the person's.
  await expect(panel.locator('[data-param-row="w"] [data-param-value]')).toHaveText('30 mm');
  await expect(panel.locator('[data-param-changed]')).toHaveCount(2);
  await expect(panel.locator('[data-param-row="w"]')).toHaveAttribute('data-param-changed', '1');
  await expect(panel.locator('[data-param-row="h"]')).toHaveAttribute('data-param-changed', '1');
  await expect(panel.locator('[data-param-row="d"]')).not.toHaveAttribute('data-param-changed', /.*/);
  await expect(panel).not.toHaveAttribute('data-panel-owner', /.+/);
  await expect(panel.locator('[data-panel-done]')).not.toHaveAttribute('aria-disabled', 'true');
  // The flash fades (1.5 s); the panel stays open.
  await expect(panel.locator('[data-param-changed]')).toHaveCount(0, { timeout: 15_000 });
  await expect(panel).toBeVisible();
  await cad(page, (() => (window as unknown as W).__step!.end()) as never);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
