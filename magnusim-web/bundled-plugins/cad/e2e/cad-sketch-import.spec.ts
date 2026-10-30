// Import SVG/DXF in the real host frame, asserting what the person sees: MODIFY's Import SVG/DXF
// opens the browser's file picker; the Sketch panel says what the drawing read (curves by kind,
// what was skipped and why, its size in mm, open ends, its units), the curves preview in the
// sketch, and OK adds them in one undo step; Ctrl+Z takes them out and Ctrl+Y brings them back;
// the outlines close into profiles that Extrude takes (the volume chip is their areas times the
// depth). A DXF's layers are ticked as the file has them (one it has off unticked); leaving a
// layer out, the scale and Centred change what the panel says and what goes in. The DXF (533 mm
// wide, the sketch empty) is framed whole beside the panels when it opens; zoomed in on, Fit
// frames it again; a layer left out keeps the camera where it is (it all shows); a scale that takes
// it out of view frames it again. A hostile SVG:
// nothing of it runs or is fetched, and the panel counts each part it left out. A binary DXF is
// refused in the panel's foot. Files that would stall or break it: an ARC whose angle is 1e300 is
// read at once (that arc counted as unreadable); an SVG whose root is 0 wide and 0 high reads in CSS
// px and says so; a loop of one cubic has no open end; a stray point far off leaves the join
// tolerance at the part's size, and the panel says it; 1,000 arcs are refused with their weight for
// the sketch solver, OK disabled. The drawings are this suite's own (tests/sketch/import/fixtures.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { bytesOf, DXF_BINARY, DXF_PART, dxf, SVG_HOSTILE, SVG_MM, SVG_MM_RECT_AREA } from '../tests/sketch/import/fixtures';
import { chipVolumes, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V2 = [number, number];
type Handle = { project(p: number[]): [number, number] | null; camera(): unknown; state: { get(): { animating: boolean } } };
type W = {
  __CAD__: {
    services: {
      apis: { get(): { sketch: { idle?(): Promise<void>; draft(): { points: Record<string, V2>; entities: { id: string; kind: string; construction?: boolean }[] } | null; view: { get(): { preview: { lines: [V2, V2][] } | null } } } } };
      viewport: { get(): { handle: Handle | null } };
    };
  };
};

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="sketch"]');
const opts = (frame: FrameLocator) => panel(frame).locator('[data-sketch-options="import"]');
const opt = (frame: FrameLocator, id: string) => opts(frame).locator(`[data-sketch-option="${id}"]`);

async function sketchIdle(page: Page) {
  await workspaceFrame(page).evaluate(async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch.idle?.();
  });
}

/** The sketch as drawn now: its entities by kind, and its points. */
async function drawn(page: Page): Promise<{ kinds: Record<string, number>; points: V2[] }> {
  return workspaceFrame(page).evaluate(() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    const kinds: Record<string, number> = {};
    for (const e of d?.entities ?? []) if (!e.construction) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    return { kinds, points: Object.values(d?.points ?? {}) };
  });
}

const previewLines = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().preview?.lines.length ?? 0);

/**
 * Whether the whole preview shows: its box's four corners (a sketch on Top: u, v = x, y), each
 * projected through the view, inside the canvas and right of the panels over it ([data-view-cover]).
 */
const previewInView = (page: Page) =>
  workspaceFrame(page).evaluate(() => {
    const cad = (window as unknown as W).__CAD__.services;
    const p = cad.apis.get().sketch.view.get().preview;
    const h = cad.viewport.get().handle;
    if (!p || !p.lines.length || !h) return 'no preview';
    let [u0, v0, u1, v1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const seg of p.lines)
      for (const [u, v] of seg) {
        u0 = Math.min(u0, u);
        v0 = Math.min(v0, v);
        u1 = Math.max(u1, u);
        v1 = Math.max(v1, v);
      }
    const c = document.querySelector('[data-cad-viewport] canvas')!.getBoundingClientRect();
    let left = c.left;
    for (const el of Array.from(document.querySelectorAll('[data-view-cover]'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) left = Math.max(left, r.right);
    }
    const off = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].filter(([u, v]) => {
      const s = h.project([u, v, 0]);
      return !s || s[0] < left || s[0] > c.right || s[1] < c.top || s[1] > c.bottom;
    });
    return off.length ? `${off.length} of 4 corners off the view: ${JSON.stringify(off)}` : 'in view';
  });

const camera = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle?.camera() ?? null);

async function settled(page: Page) {
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
}

async function enterSketchOnTop(frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
}

/** MODIFY's Import SVG/DXF, the picker given this file. */
async function importFile(page: Page, frame: FrameLocator, name: string, data: Uint8Array, mimeType = 'application/octet-stream') {
  const chooser = page.waitForEvent('filechooser');
  await runCommand(frame, 'sketch.import');
  const c = await chooser;
  expect(c.isMultiple()).toBe(false);
  await c.setFiles({ name, mimeType, buffer: Buffer.from(data) });
}

test('cad:sketch-import-svg an SVG in mm: the panel says what it read, the curves preview, OK adds them in one undo step; its outlines extrude', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(frame);
  await importFile(page, frame, 'plate.svg', bytesOf(SVG_MM), 'image/svg+xml');
  await expect(opt(frame, 'read')).toHaveText('Read: 7 lines, 4 arcs, 1 circle, 1 spline');
  await expect(opt(frame, 'skipped')).toHaveText('Skipped: nothing');
  await expect(opt(frame, 'size')).toHaveText('Size: 75 × 36 mm');
  await expect(opt(frame, 'open')).toHaveText('Open ends: 0');
  await expect(opt(frame, 'units')).toHaveText('Units: width 100mm over a viewBox 100 wide (1 unit = 1 mm)');
  await expect(opts(frame).locator('.nui[data-field="sk-scale"] input')).toHaveValue('1');
  await expect(panel(frame).locator('[data-sketch-hint]')).toContainText('Import plate.svg');
  // Previewed, nothing added yet.
  await expect.poll(() => previewLines(page)).toBeGreaterThan(100);
  expect((await drawn(page)).kinds).toEqual({});
  await opt(frame, 'ok').click();
  await sketchIdle(page);
  await expect(opts(frame)).toHaveCount(0);
  expect((await drawn(page)).kinds).toEqual({ line: 7, arc: 4, circle: 1, spline: 1 });
  expect(await previewLines(page)).toBe(0);
  // One undo step: Ctrl+Z takes all of it out, Ctrl+Y brings it back.
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  expect((await drawn(page)).kinds).toEqual({});
  await page.keyboard.press('Control+y');
  await sketchIdle(page);
  expect((await drawn(page)).kinds).toEqual({ line: 7, arc: 4, circle: 1, spline: 1 });
  await runCommand(frame, 'sketch.finish');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  // Three closed outlines: the rounded rectangle, the circle, the path (a 30 x 6 strip under an S curve).
  const row = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: /^(?:[(]-[)] )?Sketch 1$/ }) });
  await row.locator('> .tree-row').click();
  await runCommand(frame, 'solid.extrude');
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-profile-list] [data-profile]')).toHaveCount(3);
  const dist = p.locator('.nui[data-field="distance"] input');
  await dist.fill('10');
  await dist.press('Enter');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  const want = (SVG_MM_RECT_AREA + Math.PI * 100 + 180) * 10;
  await expect.poll(async () => Math.abs((await chipVolumes(frame)).reduce((a, b) => a + b, 0) / want - 1)).toBeLessThan(1e-6);
  expect(seen.errors).toEqual([]);
});

test("cad:sketch-import-dxf a DXF in inches: its layers ticked as the file has them; leaving one out, the scale and Centred change what the panel says and what goes in", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(frame);
  await importFile(page, frame, 'part.dxf', bytesOf(DXF_PART));
  await expect(opt(frame, 'read')).toHaveText('Read: 8 lines, 3 arcs, 1 circle, 1 ellipse, 1 spline');
  await expect(opt(frame, 'skipped')).toHaveText('Skipped: 1 TEXT');
  await expect(opt(frame, 'units')).toHaveText('Units: $INSUNITS 1: inches (1 unit = 25.4 mm)');
  await expect(opt(frame, 'note-0')).toHaveText('Layers the file has off or frozen are left out: Hidden');
  await expect(opts(frame).locator('.nui[data-field="sk-scale"] input')).toHaveValue('25.4');
  await expect(opts(frame).locator('input[data-sketch-option="layer:0"]')).toBeChecked();
  await expect(opts(frame).locator('input[data-sketch-option="layer:Parts"]')).toBeChecked();
  await expect(opts(frame).locator('input[data-sketch-option="layer:Hidden"]')).not.toBeChecked();
  await expect(opts(frame).locator('label', { hasText: 'Layer Hidden (1) · off in the file' })).toHaveCount(1);
  // The whole drawing shows (533 x 65 mm; the sketch is empty): framed beside the panels as it opened.
  await expect.poll(() => previewInView(page), { timeout: 15_000 }).toBe('in view');
  await settled(page);
  // Zoomed in on its middle, it reaches off the view; Fit frames it whole again (the preview counts).
  const mid = await workspaceFrame(page).evaluate(() => {
    const cad = (window as unknown as W).__CAD__.services;
    const pts = cad.apis.get().sketch.view.get().preview!.lines.flat();
    const at = (k: 0 | 1) => (Math.min(...pts.map((q) => q[k])) + Math.max(...pts.map((q) => q[k]))) / 2;
    return cad.viewport.get().handle!.project([at(0), at(1), 0]);
  });
  const host = (await page.locator('#workspace-frame').boundingBox())!;
  await page.mouse.move(host.x + mid![0], host.y + mid![1]);
  for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
  await settled(page);
  await expect.poll(() => previewInView(page)).toMatch(/corners off the view/);
  await runCommand(frame, 'view.fit');
  await expect.poll(() => previewInView(page), { timeout: 15_000 }).toBe('in view');
  await settled(page);
  const fitted = await camera(page);
  // Only the inserted block's square: 2 x 2 inches; it shows where it is, so the camera stays.
  await opts(frame).locator('input[data-sketch-option="layer:0"]').uncheck();
  await expect(opt(frame, 'read')).toHaveText('Read: 4 lines');
  await expect(opt(frame, 'size')).toHaveText('Size: 50.8 × 50.8 mm');
  await settled(page);
  expect(await previewInView(page)).toBe('in view');
  expect(await camera(page)).toEqual(fitted);
  // 2540 mm per unit takes it far out of view: framed again.
  const scale = opts(frame).locator('.nui[data-field="sk-scale"] input');
  await scale.fill('2540');
  await scale.press('Enter');
  await expect(opt(frame, 'size')).toHaveText('Size: 5080 × 5080 mm');
  await expect.poll(() => previewInView(page), { timeout: 15_000 }).toBe('in view');
  await settled(page);
  // A scale of 1 mm per unit, centred on the origin.
  await scale.fill('1');
  await scale.press('Enter');
  await expect(opt(frame, 'size')).toHaveText('Size: 2 × 2 mm');
  await opts(frame).locator('select').selectOption('centre');
  await opt(frame, 'ok').click();
  await sketchIdle(page);
  const d = await drawn(page);
  expect(d.kinds).toEqual({ line: 4 });
  const xs = d.points.map((q) => q[0]);
  const ys = d.points.map((q) => q[1]);
  expect(Math.min(...xs)).toBeCloseTo(-1, 6);
  expect(Math.max(...xs)).toBeCloseTo(1, 6);
  expect(Math.min(...ys)).toBeCloseTo(-1, 6);
  expect(Math.max(...ys)).toBeCloseTo(1, 6);
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-import-hostile a hostile SVG: nothing of it runs or is fetched; the panel counts what it left out; a binary DXF is refused in the foot', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('example.invalid')) fetched.push(r.url());
  });
  await enterSketchOnTop(frame);
  await importFile(page, frame, 'hostile.svg', bytesOf(SVG_HOSTILE), 'image/svg+xml');
  await expect(opt(frame, 'skipped')).toHaveText(
    'Skipped: 9 entity declarations (never expanded), 3 event attributes (on..., never run), 2 scripts (never run), 3 links to other files (never fetched), 1 embedded page (foreignObject, never shown), 1 image, 1 use reference, 1 style sheet, 1 text, 1 entity reference (never expanded), 1 shape with numbers that cannot be read',
  );
  await expect(opt(frame, 'read')).toHaveText('Read: 5 lines');
  await opt(frame, 'ok').click();
  await sketchIdle(page);
  expect((await drawn(page)).kinds).toEqual({ line: 5 });
  const ran = async () => [await page.evaluate(() => (window as unknown as { __drawingRan?: string }).__drawingRan ?? null), await workspaceFrame(page).evaluate(() => (window as unknown as { __drawingRan?: string }).__drawingRan ?? null)];
  expect(await ran()).toEqual([null, null]);
  expect(fetched).toEqual([]);
  // A binary DXF: refused, in the panel's foot; the sketch keeps what it had.
  await importFile(page, frame, 'b.dxf', DXF_BINARY);
  await expect(panel(frame)).toContainText('Not imported: b.dxf is a binary DXF: save it as an ASCII DXF (R12 or later) and import that');
  await expect(opts(frame)).toHaveCount(0);
  expect((await drawn(page)).kinds).toEqual({ line: 5 });
  expect(await ran()).toEqual([null, null]);
  expect(fetched).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-import-limits files that would stall or break the import: read or refused at once, and the panel says what is true', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(frame);
  const LINE = (a: V2, b: V2) => [0, 'LINE', 8, '0', 10, a[0], 20, a[1], 30, 0, 11, b[0], 21, b[1], 31, 0];
  const entities = (...recs: (string | number)[][]) => dxf([0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...recs.flat(), 0, 'ENDSEC', 0, 'EOF']);
  const square = [LINE([0, 0], [10, 0]), LINE([10, 0], [10, 10]), LINE([10, 10], [0, 10]), LINE([0, 10], [0, 0])];
  // An ARC whose start angle is 1e300 (its sweep never settled before): the square reads at once.
  await importFile(page, frame, 'angles.dxf', bytesOf(entities(...square, [0, 'ARC', 8, '0', 10, 0, 20, 0, 30, 0, 40, 5, 50, 1e300, 51, 90])));
  await expect(opt(frame, 'read')).toHaveText('Read: 4 lines');
  await expect(opt(frame, 'skipped')).toHaveText('Skipped: 1 shape with numbers that cannot be read');
  await expect(opt(frame, 'open')).toHaveText('Open ends: 0');
  await expect(opt(frame, 'join')).toHaveText('Ends joined within 0.0001 mm');
  await expect(opt(frame, 'ok')).toBeEnabled();
  // (Cancel before each next file: Import pressed while its tool is in hand puts the tool down.)
  const cancel = async () => {
    await opt(frame, 'cancel').click();
    await expect(opts(frame)).toHaveCount(0);
  };
  await cancel();
  // A root 0 wide and 0 high (a sprite sheet's): CSS px, said; the panel shows (it threw before).
  await importFile(page, frame, 'sprites.svg', bytesOf('<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" viewBox="0 0 100 100"><rect width="96" height="48"/></svg>'), 'image/svg+xml');
  await expect(opt(frame, 'units')).toHaveText('Units: CSS px, 96 per inch (1 unit = 0.264583 mm)');
  await expect(opt(frame, 'note-0')).toHaveText('Its width or height is 0, so it gives no size: read as CSS px (set the scale)');
  await expect(opt(frame, 'size')).toHaveText('Size: 25.4 × 12.7 mm');
  await cancel();
  // A loop of one cubic: closed, no open end.
  await importFile(page, frame, 'loop.svg', bytesOf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0 C5 5 10 -5 0 0 Z"/></svg>'), 'image/svg+xml');
  await expect(opt(frame, 'read')).toHaveText('Read: 1 spline');
  await expect(opt(frame, 'open')).toHaveText('Open ends: 0');
  await cancel();
  // Two lines 0.02 mm apart and a stray point 100 m off: the gap stays open (4 ends), and the panel says the tolerance and why.
  await importFile(page, frame, 'stray.dxf', bytesOf(entities(LINE([0, 0], [10, 0]), LINE([10.02, 0], [20, 0]), [0, 'POINT', 8, '0', 10, 100000, 20, 100000, 30, 0])));
  await expect(opt(frame, 'open')).toHaveText('Open ends: 4 (where a curve ends and nothing else does)');
  await expect(opt(frame, 'join')).toHaveText('Ends joined within 0.01 mm');
  await expect(opts(frame)).toContainText('A few curves lie far from the rest (it spans 100000 × 100000 mm): ends are joined within 0.01 mm, by the size of its curves');
  await cancel();
  // 1,000 arcs: too heavy for the sketch solver (every later edit would take seconds, 1,500 break it): refused, OK disabled.
  const arcs = entities(...Array.from({ length: 1000 }, (_, i) => [0, 'ARC', 8, '0', 10, (i % 100) * 20, 20, Math.floor(i / 100) * 20, 30, 0, 40, 5, 50, 0, 51, 90]));
  await importFile(page, frame, 'arcs.dxf', bytesOf(arcs));
  await expect(opt(frame, 'read')).toHaveText('Read: 1000 arcs');
  await expect(opt(frame, 'problem')).toHaveText('arcs.dxf is too large for one sketch: its 3,000 points and 1,000 arcs weigh 23,000 for the sketch solver (each point 1, each arc 20 more), at most 10,000');
  await expect(opt(frame, 'ok')).toBeDisabled();
  await cancel();
  expect((await drawn(page)).kinds).toEqual({});
  expect(seen.errors).toEqual([]);
});
