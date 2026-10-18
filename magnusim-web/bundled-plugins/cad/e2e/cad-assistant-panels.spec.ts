// A panel the Assistant fills, as the person sees it in the real host frame (D4): an Assistant
// step's session (doc.assistant, through the test handle; the Assistant's tools come later)
// opens the person's own panel, read-only: the "Assistant" badge, no rename, inert fields, no
// Delete, Done disabled with the reason "The Assistant is filling this in · Esc takes over (the
// Assistant pauses)". The body and the volume follow its draft live. A click in the view only
// selects; Escape, Ctrl+Z or the toolbar's Extrude takes the panel over: it goes, nothing of it
// is kept, and the step is marked. The person's open Parameters panel stays theirs and flashes
// the rows an Assistant step changes. A panel taller than its room scrolls under the wheel while
// the Assistant fills it (its fields inert, the body around them not). With the Sketch panel
// collapsed, the rail of the Assistant's sketch says it is the Assistant's and its Finish is
// disabled with the reason: a click there takes nothing over.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSketch, addSolid, forgetRailPrefs, newPartFromTree, newProject, openProject, partOpened, runCommand, singleVolume, watchPage, workspaceFrame } from './helpers';

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
type W = { __CAD__: { services: { doc: CadDoc } }; __step?: Step; __session?: Session; __flashes?: string[] };

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
  // Its fields show the Assistant's values and take no keyboard (they are inert; the body, the scroll container, is not).
  const distance = panel.locator('.nui[data-field="distance"] input');
  await expect(distance).toHaveValue('30');
  expect(await panel.locator('.mgk-panel-body > [data-panel-fields]').evaluate((el) => el.hasAttribute('inert'))).toBe(true);
  expect(await panel.locator('.mgk-panel-body').evaluate((el) => el.hasAttribute('inert'))).toBe(false);
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

test("cad:assistant-panel-scroll a panel the Assistant fills that is taller than its room scrolls under the wheel; its fields stay inert", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const made = await addSolid(page);
  // A short window (the browser pane's 500 px, less): the Extrude panel is taller than its room.
  await page.setViewportSize({ width: 1280, height: 420 });
  await assistantEdits(page, made.extrude, '30 mm', 'assistant:e2e-scroll');
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
  const body = panel.locator('.mgk-panel-body');
  const room = await body.evaluate((el) => ({ over: el.scrollHeight - el.clientHeight, top: el.scrollTop }));
  expect(room.over, 'the body is taller than its room').toBeGreaterThan(20);
  expect(room.top).toBe(0);
  // The wheel over its fields scrolls the body (an inert body took no wheel: nothing moved).
  const box = (await body.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 120);
  await expect.poll(() => body.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(0);
  // Still read-only: the fields take no focus, and the step is the Assistant's.
  const distance = panel.locator('.nui[data-field="distance"] input');
  expect(await distance.evaluate((el: HTMLInputElement) => (el.focus(), document.activeElement === el))).toBe(false);
  expect(await stepState(page)).toEqual({ takenOver: null, open: true });
  await revertAndEnd(page);
  await expect(panel).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test("cad:assistant-panel-rail the collapsed Sketch panel of the Assistant's sketch says it is the Assistant's; its Finish is disabled with the reason and takes nothing over", { tag: '@serial' }, async ({ page, request }) => {
  await forgetRailPrefs(request);
  try {
    const { seen, frame } = await freshPart(page, request);
    const sketch = await addSketch(page, { size: [30, 20] });
    await cad(
      page,
      ((id: string) => {
        const w = window as unknown as W;
        const doc = w.__CAD__.services.doc;
        const step = doc.assistant.begin('assistant:e2e-rail');
        w.__step = step;
        w.__session = step.run(() => doc.beginEdit(id));
      }) as never,
      sketch,
    );
    const panel = frame.locator('[data-cad-panel="sketch"]');
    await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
    // The person collapses the panel (their layout, kept for every sketch).
    await panel.locator('[data-sketch-collapse]').click();
    const rail = frame.locator('[data-cad-rail="sketch"]');
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('data-panel-owner', 'assistant');
    await expect(rail.locator('[data-panel-badge="assistant"]')).toHaveText('Assistant');
    await expect(rail.locator('[data-rail-expand]')).toHaveAccessibleName(/^Show the Sketch 1 panel \(the Assistant is drawing it\)/);
    const finish = rail.locator('[data-rail-done]');
    await expect(finish).toHaveAttribute('aria-disabled', 'true');
    await expect(finish).toHaveAttribute('data-disabled-reason', DONE_REASON);
    await finish.hover();
    await expect(frame.locator('[data-cad-tip]')).toContainText(DONE_REASON);
    // A click on it takes nothing over: the Assistant's sketch stays open, the step unmarked
    // (forced: Playwright waits for an aria-disabled button to be enabled).
    await finish.click({ force: true });
    await expect(rail).toBeVisible();
    expect(await stepState(page)).toEqual({ takenOver: null, open: true });
    await revertAndEnd(page);
    await expect(rail).toHaveCount(0);
    // The person's own sketch, collapsed: its Finish is theirs as always.
    await cad(page, ((id: string) => void (window as unknown as W).__CAD__.services.doc.beginEdit(id)) as never, sketch);
    await expect(rail).toBeVisible();
    await expect(rail).not.toHaveAttribute('data-panel-owner', /.+/);
    await expect(rail.locator('[data-panel-badge]')).toHaveCount(0);
    await expect(rail.locator('[data-rail-done]')).not.toHaveAttribute('aria-disabled', /.+/);
    await rail.locator('[data-rail-done]').click();
    await expect(rail).toHaveCount(0);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  } finally {
    await forgetRailPrefs(request);
  }
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
  // A recorder in the frame, before the edit: every row that gains ("+w") or loses ("-w") the flash,
  // whenever it happens. The flash lasts 1.5 s, so it is read from this log, never raced on a slow runner.
  await cad(page, (() => {
    const w = window as unknown as W;
    const log: string[] = [];
    w.__flashes = log;
    const rowOf = (el: Element) => el.getAttribute('data-param-row') ?? '?';
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element) log.push(`${r.oldValue === null ? '+' : '-'}${rowOf(r.target)}`);
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof Element)) continue;
          for (const el of [n, ...Array.from(n.querySelectorAll('[data-param-row]'))]) if (el.matches('[data-param-row][data-param-changed]')) log.push(`+${rowOf(el)}`);
        }
      }
    }).observe(document.querySelector('[data-cad-panel="params"]')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-param-changed'], attributeOldValue: true });
  }) as never);
  /** The rows the log shows gaining (+) or losing (-) the flash, each once, sorted. */
  const flashes = (sign: '+' | '-') =>
    cad<string[]>(page, ((s: string) => [...new Set(((window as unknown as W).__flashes ?? []).filter((x) => x.startsWith(s)).map((x) => x.slice(1)))].sort()) as never, sign);
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
  // The changed rows flashed (w changed, h added; d did not), then the flash faded, each row's once.
  await expect.poll(() => flashes('+'), { timeout: 15_000 }).toEqual(['h', 'w']);
  await expect.poll(() => flashes('-'), { timeout: 15_000 }).toEqual(['h', 'w']);
  await expect(panel.locator('[data-param-changed]')).toHaveCount(0);
  expect(await flashes('+')).toEqual(['h', 'w']);
  // The new values; the panel is still the person's, and stays open.
  await expect(panel.locator('[data-param-row="w"] [data-param-value]')).toHaveText('30 mm');
  await expect(panel.locator('[data-param-row="h"] [data-param-value]')).toHaveText('8 mm');
  await expect(panel).not.toHaveAttribute('data-panel-owner', /.+/);
  await expect(panel.locator('[data-panel-done]')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(panel).toBeVisible();
  await cad(page, (() => (window as unknown as W).__step!.end()) as never);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
