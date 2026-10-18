// A sketch the Assistant draws, as the person sees it in the real host frame (D5): an Assistant
// step (doc.assistant, through the test handle; the Assistant's tools come later) starts a sketch
// on the person's path (sketch mode's startSketch with the step) and draws in it. Its panel is
// read-only and badged. The person's Line is refused with "The Assistant is drawing this sketch ·
// Esc takes over" in the panel's foot, and the tool stays Select. A click in the view only looks.
// The toolbar's Undo and Finish sketch say they take it over. Escape (sketch mode's own key),
// Ctrl+Z and Enter take it over: the sketch goes, nothing of it is kept, and the step is marked.
// The step's own Finish keeps it. The page's solver worker analyses a sketch apart
// (analyzeFeature): its free parameters.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const REFUSED = 'The Assistant is drawing this sketch · Esc takes over';
const DONE_REASON = 'The Assistant is filling this in · Esc takes over (the Assistant pauses)';
const TAKE_OVER = 'Take over from the Assistant: its sketch is discarded';

type Step = { owner: string; takenOver: string | null; run<T>(fn: () => T): T; revert(): { ok: boolean }; end(): void };
type SketchLike = { id: string; name: string; type: string; entities: unknown[] };
type Mode = {
  startSketch(support: unknown, opts?: { step?: Step }): Promise<true | string>;
  apply(label: string, make: () => unknown, opts?: { by?: Step }): Promise<{ ok: boolean; reason?: string }>;
  finish(opts?: { step?: Step }): Promise<string | null>;
  idle(): Promise<void>;
  active: boolean;
  state: { get(): { tool: string } };
};
type Solver = { analyzeFeature(f: SketchLike, values: Record<string, number>): Promise<{ solve: { solved: boolean }; analysis: { dof: number; dependentParams: string[] } }> };
type W = {
  __CAD__: {
    services: {
      doc: { assistant: { begin(owner: string): Step }; state: { get(): { doc: { features: SketchLike[] }; history: { undoLabel: string | null } } } };
      apis: { get(): { sketch: Mode; solver: Solver } };
    };
  };
  __step?: Step;
};

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

/** An Assistant step starts a sketch on Top and draws a 40 x 20 rectangle from the origin in it (2 DOF). */
async function assistantSketches(page: Page, owner: string) {
  const r = await cad<{ started: true | string; drawn: boolean | string }>(
    page,
    (async (owner: string) => {
      const w = window as unknown as W;
      const { doc, apis } = w.__CAD__.services;
      const mode = apis.get().sketch;
      const step = doc.assistant.begin(owner);
      w.__step = step;
      const started = await mode.startSketch({ kind: 'plane', plane: 'origin:top' }, { step });
      const drawn = await mode.apply(
        'Draw rectangle',
        () => ({
          points: { a1: [0, 0], a2: [40, 0], a3: [40, 20], a4: [0, 20] },
          entities: [
            { id: 'l1', kind: 'line', p: ['a1', 'a2'] },
            { id: 'l2', kind: 'line', p: ['a2', 'a3'] },
            { id: 'l3', kind: 'line', p: ['a3', 'a4'] },
            { id: 'l4', kind: 'line', p: ['a4', 'a1'] },
          ],
          constraints: [
            { id: 'h1', kind: 'horizontal', refs: ['l1'] },
            { id: 'v2', kind: 'vertical', refs: ['l2'] },
            { id: 'h3', kind: 'horizontal', refs: ['l3'] },
            { id: 'v4', kind: 'vertical', refs: ['l4'] },
            { id: 'c0', kind: 'coincident', refs: ['a1', 'origin'] },
          ],
        }),
        { by: step },
      );
      return { started, drawn: drawn.ok || (drawn.reason ?? 'refused') };
    }) as never,
    owner,
  );
  expect(r).toEqual({ started: true, drawn: true });
}

const takenOver = (page: Page) => cad<string | null>(page, (() => (window as unknown as W).__step!.takenOver) as never);
const sketchActive = (page: Page) => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.active) as never);
const featureNames = (page: Page) => cad<string[]>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.map((f) => f.name)) as never);

/** The call's catch, as the Assistant's own will be: back to the mark, then the end. */
const revertAndEnd = (page: Page) =>
  cad(page, (() => {
    const w = window as unknown as W;
    w.__step!.revert();
    w.__step!.end();
  }) as never);

/** The keyboard in the frame: a click on an empty corner of the view (in a sketch, Select only looks). */
async function keyboardInFrame(page: Page, frame: FrameLocator) {
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
}

/** The sketch is gone with nothing kept: the panel, sketch mode and the tree row. */
async function gone(page: Page, frame: FrameLocator) {
  await expect(frame.locator('[data-cad-panel="sketch"]')).toHaveCount(0);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toHaveCount(0);
  expect(await sketchActive(page)).toBe(false);
  expect(await featureNames(page)).toEqual([]);
}

test('cad:assistant-sketch a sketch the Assistant draws refuses the person\'s Line with the reason, and Escape takes it over keeping nothing', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tip = frame.locator('[data-cad-tip]');
  await assistantSketches(page, 'assistant:e2e-s1');

  // The person's own sketch mode, read-only: the badge, Done disabled with the reason, the DOF.
  const panel = frame.locator('[data-cad-panel="sketch"]');
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
  await expect(panel.locator('[data-panel-badge]')).toHaveText('Assistant');
  await expect(panel.locator('[data-panel-done]')).toHaveAttribute('data-disabled-reason', DONE_REASON);
  await expect(frame.locator('[data-chip="sketch"]')).toContainText('Under defined · 2 DOF');

  // The person's Line: refused, with the reason in the panel's foot; the tool stays Select.
  await tb.locator('[data-command="sketch.line"]').click();
  await expect(panel.locator('[data-run-reason]')).toContainText(REFUSED);
  await expect(tb.locator('[data-command="sketch.line"]')).not.toHaveClass(/is-active/);
  expect(await cad<string>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.state.get().tool) as never)).toBe('select');
  // The toolbar's Undo and Finish sketch say what they do here.
  await tb.locator('[data-command="sketch.undo"]').hover();
  await expect(tip).toContainText(TAKE_OVER);
  await tb.locator('[data-command="sketch.finish"]').hover();
  await expect(tip).toContainText(TAKE_OVER);

  // A click in the view only looks.
  await keyboardInFrame(page, frame);
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
  expect(await takenOver(page)).toBeNull();

  // Escape (sketch mode's own key) takes it over: the sketch goes, nothing of it kept.
  await page.keyboard.press('Escape');
  await gone(page, frame);
  expect(await takenOver(page)).toBe('escape');
  await revertAndEnd(page);
  await expect(frame.locator('[data-cad-tree] [data-feature-row]')).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:assistant-sketch Ctrl+Z and Enter in a sketch the Assistant draws take it over and undo nothing; its own Finish keeps it; the solver analyses a sketch apart', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const undoLabel = () => cad<string | null>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel) as never);
  const before = await undoLabel();

  await assistantSketches(page, 'assistant:e2e-s2');
  await expect(frame.locator('[data-cad-panel="sketch"]')).toHaveAttribute('data-panel-owner', 'assistant');
  await keyboardInFrame(page, frame);
  await page.keyboard.press('Control+z');
  await gone(page, frame);
  expect(await takenOver(page)).toBe('undo');
  expect(await undoLabel()).toBe(before);
  await revertAndEnd(page);

  await assistantSketches(page, 'assistant:e2e-s3');
  await expect(frame.locator('[data-cad-panel="sketch"]')).toHaveAttribute('data-panel-owner', 'assistant');
  await keyboardInFrame(page, frame);
  await page.keyboard.press('Enter');
  await gone(page, frame);
  expect(await takenOver(page)).toBe('enter');
  await revertAndEnd(page);

  // The step's own Finish keeps it: the tree row (under-defined: "(-)"), model mode again.
  await assistantSketches(page, 'assistant:e2e-s4');
  const kept = await cad<string | null>(page, (async () => {
    const w = window as unknown as W;
    const r = await w.__CAD__.services.apis.get().sketch.finish({ step: w.__step });
    w.__step!.end();
    return r;
  }) as never);
  expect(kept).toBeNull();
  await expect(frame.locator('[data-cad-panel="sketch"]')).toHaveCount(0);
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['(-) Sketch 1']);

  // The page's solver worker analyses that sketch apart: 2 DOF, its free parameters named.
  const a = await cad<{ solved: boolean; dof: number; free: string[] }>(page, (async () => {
    const { doc, apis } = (window as unknown as W).__CAD__.services;
    const f = doc.state.get().doc.features[0];
    const r = await apis.get().solver.analyzeFeature(f, {});
    return { solved: r.solve.solved, dof: r.analysis.dof, free: r.analysis.dependentParams };
  }) as never);
  expect(a.solved).toBe(true);
  expect(a.dof).toBe(2);
  expect(a.free.length).toBeGreaterThan(0);
  for (const p of a.free) expect(p).toMatch(/^a[1-4]\.[uv]$/);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
