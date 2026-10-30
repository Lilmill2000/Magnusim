// The person's sketch tools through the Assistant, as the person sees them in the real host frame
// (help sketch_tools): the scripted model draws a wing section as one closed spline through its
// fit points, holds each point with fix (fully defined), and extrudes the region the spline bounds.
// The person's tree shows the sketch and the wing, no panel is left open, the sketch's stored
// entity is the person's fit spline, the volume chip is the section's area times the span, and
// one Undo ("Undo Assistant: <request>") takes both away. A second test rounds a plate's corner
// with fillet and lays a circular pattern of holes; a later turn sets the pattern's count with
// edit_feature and extrudes the plate: the tree and the volume chip show the eight holes. A third
// sketches a 96-tooth wheel (198 regions) and extrudes the region whose id the sketch's answer
// names first: the answer the model got is under 3 KB with the gaps summed, the dock's sketch step
// says 198 regions and the largest's area, and the tree shows the wheel's body, its volume the
// toothed wheel's. A fourth: the person attaches a DXF in the app's Assistant panel; the model
// imports it with the sketch tool's import row (the host's readAttachment) and extrudes its slot:
// made says what the person's Import SVG/DXF panel says, the dock's sketch step names the drawing,
// what it read and what it skipped (the person gets what the model gets), and the tree and the
// volume chip show it.
// A fifth: the model copies a sketch's rectangle into a sketch on another plane with the copy row
// (the person's Copy and Paste) and extrudes it: made says what was copied and what was left out
// (its tie to the origin), the copy keeps its dimension, and the tree and the volume chip show it.
// A sixth: the person copies a sketch's rectangle with Ctrl+C (the foot's note says what was copied); the
// model reads what is held (get_model's clipboard) and pastes it into a sketch on Front with the
// copy row's "from clipboard", then extrudes it: the tree and the volume chip show it.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { historyNames } from './helpers';
import { DXF_PART, DXF_PART_AREAS } from '../tests/sketch/import/fixtures';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
import { cadFrame, chats, chipWords, newProject, openNewPart, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost, type FakeRequest } from './assistant-helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-sketch-tools', 120);
  await useScriptedModel(request, host, 'cloud');
});

test.afterAll(async () => {
  if (host) await host.stop();
});

test.beforeEach(async ({ request }) => {
  await resetAssistant(request, host);
  await useScriptedModel(request, host, 'cloud');
});

test.afterEach(() => {
  expect(host.fake.pending(), 'scripted answers left unused').toBe(0);
});

type Sketchy = { name: string; type: string; entities?: { id: string; kind: string; form?: string; closed?: boolean; pts?: string[] }[]; ties?: { id: string; count: number[]; copies: unknown[] }[] };
type W = {
  __CAD__: {
    services: { doc: { undo(): void; state: { get(): { doc: { features: Sketchy[] }; history: { undoLabel: string | null } } } } };
    assistant: { setPace(p: string | null, scale?: number | null): void };
  };
};
const E = (id: string, kind: string, at: number[]) => ({ id, kind, at, construction: false });
const C = (id: string, kind: string, refs: string[], value = '') => ({ id, kind, refs, value });
const EXTRUDE = (name: string, sketch: string, distance: string, op = 'new') => ({ name: 'cad__extrude', input: { edit: '', name, sketch, regions: ['all'], face: '', direction: '', extent: 'blind', distance, distance2: '', to: '', flip: false, op, bodies: [], body_name: '', color: '' } });
const featureOf = (page: Page, name: string) => cadFrame(page).evaluate((n) => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((f) => f.name === n) ?? null, name);
const undoNow = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel);
const volumeNow = async (page: Page) => Number(await cadFrame(page).locator('[data-chip="volume"] [data-volume-mm3]').getAttribute('data-volume-mm3'));

// A wing section (chord 100 mm): the trailing edge, the upper surface, the leading edge, the lower one.
const SECTION = [100, 0, 70, 4.6, 40, 6, 15, 5, 3, 2.5, 0, 0, 3, -2.5, 15, -5, 40, -6, 70, -4.6, 100, 0];
const POINTS = SECTION.length / 2 - 1;

test('cad:assistant-sketch-tools-airfoil a closed spline the model draws and extrudes: the person sees the sketch and the wing, its volume, one Undo', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant airfoil');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const before = chats(host).length;
  host.fake.reply(
    {
      tools: [
        {
          name: 'cad__sketch',
          input: { edit: '', name: 'Section', on: 'Front', entities: [E('w', 'spline', SECTION)], constraints: Array.from({ length: POINTS }, (_, k) => C(`f${k}`, 'fix', [`w.p${k}`])), infer: false },
        },
      ],
    },
    { tools: [EXTRUDE('Wing', 'Section', '50 mm')] },
    { text: 'The wing section is extruded 50 mm.' },
  );
  const t = await startTurn(request, host, { text: 'Make a wing 50 mm long from a 100 mm section.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, afterSketch, afterExtrude] = chats(host).slice(before);
  const [sketch] = resultsIn(afterSketch);
  expect(sketch).toMatchObject({ tool: 'cad__sketch', ok: true, data: { solver: { state: 'fully', dof: 0 }, feature: { name: 'Section', state: 'ok' } } });
  const regions = sketch.data!.regions as { id: string; area_mm2: number; holes: number }[];
  expect(regions).toEqual([{ id: 'r1', area_mm2: expect.any(Number), at: expect.any(Array), holes: 0 }]);
  const area = regions[0].area_mm2;
  expect(area).toBeGreaterThan(600);
  expect(area).toBeLessThan(1000);
  const [wing] = resultsIn(afterExtrude);
  expect(wing).toMatchObject({ tool: 'cad__extrude', ok: true, data: { feature: { name: 'Wing', state: 'ok' } } });

  // What the person sees: the sketch and the wing in the tree, no panel open, the wing's volume.
  await expect(historyNames(frame)).toHaveText(['Section', 'Wing'], STEP);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  await expect.poll(async () => Math.abs((await volumeNow(page)) - area * 50) < 1, STEP).toBe(true);
  // The person's fit spline, closed, through the model's points.
  const section = await featureOf(page, 'Section');
  expect(section!.entities).toEqual([{ id: 'w', kind: 'spline', form: 'fit', pts: Array.from({ length: POINTS }, (_, k) => `w__p${k}`), degree: 3, closed: true }]);
  await expect(chipWords(frame)).toHaveText('Assistant: Make a wing 50 mm long from a 100 mm section. · done', STEP);
  // One Undo takes the whole request back.
  expect(await undoNow(page)).toBe('Assistant: Make a wing 50 mm long from a 100 mm section.');
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect(historyNames(frame)).toHaveCount(0, STEP);
});

test("cad:assistant-sketch-tools-pattern a fillet and a circular pattern the model adds, the pattern's count set later: the tree and the volume chip show it", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant sketch pattern');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const before = chats(host).length;
  // A 60 x 60 plate with one corner rounded r 10, and six 4 mm holes on a 40 mm circle.
  const plate = {
    edit: '',
    name: 'Plate sketch',
    on: 'Top',
    entities: [E('r', 'center_rect', [0, 0, 60, 60]), E('h', 'circle', [20, 0, 2])],
    constraints: [
      C('c0', 'coincident', ['r.center', 'origin']),
      C('w', 'distance', ['r.bottom'], '60 mm'),
      C('d', 'distance', ['r.left'], '60 mm'),
      C('hx', 'distance_x', ['origin', 'h.center'], '20 mm'),
      C('hy', 'distance_y', ['origin', 'h.center'], '0 mm'),
      C('hd', 'diameter', ['h'], '4 mm'),
      C('f1', 'fillet', ['r.tr'], '10 mm'),
      C('p1', 'circular_pattern', ['origin', 'h'], 'count 6'),
    ],
    infer: false,
  };
  host.fake.reply({ tools: [{ name: 'cad__sketch', input: plate }] }, { text: 'The plate sketch has a rounded corner and six holes.' });
  const t = await startTurn(request, host, { text: 'A 60 mm plate, one corner rounded, six holes on a 40 mm circle.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, afterSketch] = chats(host).slice(before);
  const [sk] = resultsIn(afterSketch);
  expect(sk).toMatchObject({ tool: 'cad__sketch', ok: true, data: { solver: { state: 'fully', dof: 0 }, made: [{ id: 'f1', kind: 'fillet' }, { id: 'p1', kind: 'circular_pattern', values: { count: 6 } }] } });
  await expect(historyNames(frame)).toHaveText(['Plate sketch'], STEP);
  expect((await featureOf(page, 'Plate sketch'))!.ties).toMatchObject([{ id: 'p1', count: [6, 1] }]);
  expect(sk.data!.regions as unknown[]).toHaveLength(7);

  // Later: eight holes, through the pattern's own value, then the plate.
  const later = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__edit_feature', input: { feature: 'Plate sketch', set: [{ field: 'p1.count', value: '8' }], rename_to: '', suppress: 'keep', move: '' } }] },
    { tools: [EXTRUDE('Plate', 'Plate sketch', '5 mm')] },
    { text: 'Eight holes, and the plate is 5 mm thick.' },
  );
  const t2 = await startTurn(request, host, { text: 'Make it eight holes, then the plate 5 mm thick.', tab });
  expect((await t2.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [edit] = resultsIn(chats(host)[later + 1]);
  expect(edit).toMatchObject({ tool: 'cad__edit_feature', ok: true, data: { values: expect.arrayContaining([{ field: 'p1.count', expr: '8' }]) } });
  const sketchNow = await featureOf(page, 'Plate sketch');
  expect(sketchNow!.ties![0].copies).toHaveLength(7);
  // What the person sees: the plate in the tree, its volume with eight holes and the rounded corner.
  await expect(historyNames(frame)).toHaveText(['Plate sketch', 'Plate'], STEP);
  const corner = 100 - 25 * Math.PI;
  const plateVolume = (holes: number) => (3600 - corner - holes * 4 * Math.PI) * 5;
  await expect.poll(async () => Math.abs((await volumeNow(page)) - plateVolume(8)) < 0.5, STEP).toBe(true);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
});

// A 96-tooth wheel as a model draws a clock's great wheel (tests/assistant/sketch-tools.ts gearInput):
// the tip circle, a bore, four spoke windows and one tooth gap across the tip circle, patterned.
const polar = (r: number, deg: number) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)].map((x) => Number(x.toFixed(4)));
const GAP = [polar(29, -0.9), polar(33, -1.3), polar(33, 1.3), polar(29, 0.9), polar(29, -0.9)].flat();
const GEAR = {
  edit: '',
  name: 'Gear sketch',
  on: 'Top',
  entities: [E('o', 'circle', [0, 0, 31.5]), E('b', 'circle', [0, 0, 5]), E('w', 'sector', [0, 0, 10, 22, 10, 80]), E('g', 'polyline', GAP)],
  constraints: [
    C('fo', 'fix', ['o']),
    C('fb', 'fix', ['b']),
    C('fw', 'fix', ['w.inner']),
    C('fv', 'fix', ['w.outer']),
    ...[0, 1, 2, 3].map((k) => C(`f${k}`, 'fix', [`g.p${k}`])),
    C('pw', 'circular_pattern', ['origin', 'w'], 'count 4'),
    C('pg', 'circular_pattern', ['origin', 'g'], 'count 96'),
  ],
  infer: false,
};
/** The bytes of each tool result a request carries (the text the model reads). */
const resultBytes = (req: FakeRequest): number[] => {
  const user = [...(req.body.messages as { role: string; content: unknown }[])].reverse().find((m) => m.role === 'user');
  return ((user?.content ?? []) as { type: string; content: { text: string }[] }[]).filter((b) => b.type === 'tool_result').map((b) => Buffer.byteLength(b.content[0].text, 'utf8'));
};

test("cad:assistant-sketch-tools-gear a 96-tooth wheel: the model gets a short answer naming r1 and extrudes it; the dock's step and the tree show the wheel", async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const pid = await newProject(request, host, 'Assistant gear');
  const { frame } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__sketch', input: GEAR }] },
    // The model takes the region id the sketch's answer names first (the largest).
    (body: unknown) => {
      const [sk] = resultsIn(body);
      const first = (sk.data!.regions as { id?: string }[])[0];
      const x = EXTRUDE('Great Wheel', 'Gear sketch', '4 mm');
      return { tools: [{ ...x, input: { ...x.input, regions: [first.id], body_name: 'Great Wheel' } }] };
    },
    { text: 'The great wheel is 4 mm thick.' },
  );
  await core.dockSend(page, 'A 96-tooth great wheel, 4 mm thick.');
  await expect(core.dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 3 });
  const [, afterSketch, afterExtrude] = chats(host).slice(before);
  // What the model got: under 3 KB, r1 first, the gaps summed with their ids.
  expect(resultBytes(afterSketch)).toHaveLength(1);
  expect(resultBytes(afterSketch)[0]).toBeLessThan(3 * 1024);
  const [sk] = resultsIn(afterSketch);
  const rows = sk.data!.regions as { id?: string; ids?: string; count?: number; area_mm2: number }[];
  expect(rows.map((r) => r.id ?? r.ids)).toEqual(['r1', 'r2..r5', 'r6', 'r7..r102', 'r103..r198']);
  expect(rows[3].count).toBe(96);
  const [ex] = resultsIn(afterExtrude);
  expect(ex).toMatchObject({ tool: 'cad__extrude', ok: true, data: { feature: { name: 'Great Wheel', state: 'ok' } } });
  // What the person sees: the dock's sketch step with the count and the largest's area.
  const step = core.dockTurn(page).locator('[data-dock-step] [data-dock-result]').filter({ hasText: 'regions (largest' });
  await expect(step).toHaveText(new RegExp(`^✓ Sketch "Gear sketch" on Top: fully defined, 198 regions \\(largest ${rows[0].area_mm2} mm²\\) · `), STEP);
  // The tree: the sketch, the extrude, and the wheel's body; its volume is the toothed wheel's.
  await expect(historyNames(frame)).toHaveText(['Gear sketch', 'Great Wheel'], STEP);
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await expect(frame.locator('[data-cad-tree] [data-body-row] .cad-body-name')).toHaveText(['Great Wheel'], STEP);
  await expect.poll(async () => Math.abs((await volumeNow(page)) - rows[0].area_mm2 * 4) < 1, STEP).toBe(true);
});

// Import SVG/DXF through the Assistant: the person attaches a DXF in the app's Assistant panel (a
// drawing chip), the scripted model takes its attachment_id from the person's message and imports
// it with the sketch tool's import row (the host's readAttachment), then extrudes the largest region.
test('cad:assistant-sketch-tools-import a DXF the person attaches in the dock: the model imports it into a sketch and extrudes its slot; the tree, the sketch and the volume chip show it', async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const pid = await newProject(request, host, 'Assistant drawing');
  const { frame } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const before = chats(host).length;
  const attachmentOf = (body: unknown) => /attachment_id (att-[0-9a-f]{16})/.exec(JSON.stringify(body))?.[1] ?? 'att-not-in-the-message';
  host.fake.reply(
    (body: unknown) => ({ tools: [{ name: 'cad__sketch', input: { edit: '', name: 'Drawing', on: 'Top', entities: [], constraints: [C('i1', 'import', [attachmentOf(body)])], infer: false } }] }),
    (body: unknown) => {
      const [sk] = resultsIn(body);
      const first = (sk.data!.regions as { id?: string }[])[0];
      const x = EXTRUDE('Slot', 'Drawing', '10 mm');
      return { tools: [{ ...x, input: { ...x.input, regions: [first?.id ?? 'r1'] } }] };
    },
    { text: 'Your drawing is in the sketch Drawing, and its slot is extruded 10 mm.' },
  );
  // The person's way: the drawing attached in the dock (a drawing chip, never a picture), then the message.
  await core.openDock(page);
  await core.dockPanel(page).locator('[data-dock-file]').setInputFiles({ name: 'part.dxf', mimeType: 'application/dxf', buffer: Buffer.from(DXF_PART) });
  await expect(core.dockPanel(page).locator('[data-dock-file-kind="drawing"]')).toHaveCount(1, STEP);
  const turn = await core.dockSend(page, 'Bring my drawing into a sketch on Top and extrude its slot 10 mm.');
  expect((await core.followTurn(request, host.base, turn).ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, afterSketch, afterExtrude] = chats(host).slice(before);
  const [sk] = resultsIn(afterSketch);
  expect(sk).toMatchObject({ tool: 'cad__sketch', ok: true, data: { feature: { name: 'Drawing', state: 'ok' } } });
  const made = (sk.data!.made as { id: string; kind: string; values: Record<string, unknown> }[])[0];
  expect(made).toMatchObject({ id: 'i1', kind: 'import', values: { file: 'part.dxf', read: 'Read: 8 lines, 3 arcs, 1 circle, 1 ellipse, 1 spline', skipped: 'Skipped: 1 TEXT', open_ends: 0, scale: 'Scale: 1 unit = 25.4 mm ($INSUNITS 1: inches)' } });
  expect(sk.data!.regions as unknown[]).toHaveLength(7);
  expect(sk.data!.open).toEqual([]);
  const [ex] = resultsIn(afterExtrude);
  expect(ex).toMatchObject({ tool: 'cad__extrude', ok: true, data: { feature: { name: 'Slot', state: 'ok' } } });
  // What the person sees in the dock: the sketch step names the drawing, what it read and the TEXT it skipped.
  const step = core.dockTurn(page).locator('[data-dock-step] [data-dock-result]').filter({ hasText: 'Sketch "Drawing"' });
  await expect(step).toHaveText(/^✓ Sketch "Drawing" on Top: imported part\.dxf \(read 14 curves; skipped 1 TEXT\), under-defined \(dof \d+\), 7 regions \(largest [\d.]+ mm²\) · /, STEP);
  // What the person sees: the sketch (under-defined, as imported geometry is: "(-)") and the body in
  // the tree, the sketch's 14 curves, the slot's volume.
  await expect(historyNames(frame)).toHaveText(['(-) Drawing', 'Slot'], STEP);
  expect((await featureOf(page, 'Drawing'))!.entities).toHaveLength(14);
  const slot = DXF_PART_AREAS.slot * 25.4 * 25.4 * 10;
  await expect.poll(async () => Math.abs((await volumeNow(page)) / slot - 1) < 1e-6, STEP).toBe(true);
});

// Copy and Paste through the Assistant: the copy row takes another sketch's rectangle (its dimension
// made again on the copy, its tie to the origin left out and said) into a sketch on Front, moved by
// an offset; the model extrudes the copy.
test("cad:assistant-sketch-tools-copy the model copies a sketch's rectangle into a sketch on Front and extrudes it: made says what was copied and left out; the tree and the volume chip show it", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant copy');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__sketch', input: { edit: '', name: 'Plate', on: 'Top', entities: [E('r', 'rect', [0, 0, 30, 20])], constraints: [C('d1', 'distance', ['r.bottom'], '30 mm'), C('o1', 'coincident', ['r.bl', 'origin'])], infer: false } }] },
    { tools: [{ name: 'cad__sketch', input: { edit: '', name: 'Copy', on: 'Front', entities: [], constraints: [C('k1', 'copy', ['r'], 'from Plate; offset 50, 0')], infer: false } }] },
    { tools: [EXTRUDE('Block', 'Copy', '10 mm')] },
    { text: "Plate's rectangle is copied into Copy on Front, 50 mm along, and extruded 10 mm." },
  );
  const t = await startTurn(request, host, { text: "Copy Plate's rectangle onto the Front plane 50 mm along and extrude it 10 mm.", tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, , afterCopy, afterExtrude] = chats(host).slice(before);
  const [sk] = resultsIn(afterCopy);
  expect(sk).toMatchObject({ tool: 'cad__sketch', ok: true, data: { feature: { name: 'Copy', state: 'ok' } } });
  const made = (sk.data!.made as { id: string; kind: string; entities: string[]; values: Record<string, unknown> }[])[0];
  expect(made).toMatchObject({ id: 'k1', kind: 'copy', entities: ['k1.r.bottom', 'k1.r.right', 'k1.r.top', 'k1.r.left'], values: { from: 'Plate', copied: '4 lines, 4 relations and 1 dimension', kept: '4 relations and 1 dimension', left_out: '1 relation to other geometry' } });
  expect(sk.data!.warnings as string[]).toContain('k1 (copy): 1 relation to other geometry was left out');
  const [ex] = resultsIn(afterExtrude);
  expect(ex).toMatchObject({ tool: 'cad__extrude', ok: true, data: { feature: { name: 'Block', state: 'ok' } } });
  // What the person sees: both sketches (under-defined: "(-)") and the block in the tree, the copy's
  // four lines and its dimension, the block's volume (30 x 20 x 10).
  await expect(historyNames(frame)).toHaveText(['(-) Plate', '(-) Copy', 'Block'], STEP);
  const copy = (await featureOf(page, 'Copy')) as (Sketchy & { constraints: { kind: string; expr?: string }[] }) | null;
  expect(copy!.entities!.map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line']);
  expect(copy!.constraints.filter((c) => c.expr != null).map((c) => c.expr)).toEqual(['30 mm']);
  await expect.poll(async () => Math.abs((await volumeNow(page)) - 6000) < 1e-6, STEP).toBe(true);
});

test('cad:assistant-sketch-tools-clipboard the person copies a rectangle with Ctrl+C; the model reads what is held, pastes it on Front with "from clipboard" and extrudes it: the tree and the volume chip show it', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant clipboard');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  host.fake.reply(
    { tools: [{ name: 'cad__sketch', input: { edit: '', name: 'Plate', on: 'Top', entities: [E('r', 'rect', [0, 0, 30, 20])], constraints: [C('d1', 'distance', ['r.bottom'], '30 mm'), C('o1', 'coincident', ['r.bl', 'origin'])], infer: false } }] },
    { text: 'Plate is a 30 x 20 rectangle on Top.' },
  );
  const t1 = await startTurn(request, host, { text: 'Draw a 30 x 20 rectangle on Top.', tab });
  expect((await t1.ended(STEP_MS * 3)).turn.state).toBe('done');
  await expect(historyNames(frame)).toHaveText(['(-) Plate'], STEP);

  // The person opens Plate, selects its four lines and presses Ctrl+C.
  type V = { __CAD__: { services: { apis: { get(): { sketch: { edit(id: string): void; idle?(): Promise<void> } } }; viewport: { get(): { handle: { project(p: number[]): [number, number] | null; state: { get(): { animating: boolean } } } | null } } } } };
  const plate = (await featureOf(page, 'Plate')) as unknown as { id: string };
  await cadFrame(page).evaluate((id) => (window as unknown as V).__CAD__.services.apis.get().sketch.edit(id), plate.id);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await cadFrame(page).evaluate(async () => (window as unknown as V).__CAD__.services.apis.get().sketch.idle?.());
  await expect.poll(() => cadFrame(page).evaluate(() => (window as unknown as V).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
  const clickAt = async (p: number[], shift = false) => {
    const xy = await cadFrame(page).evaluate((q) => (window as unknown as V).__CAD__.services.viewport.get().handle?.project(q) ?? null, p);
    expect(xy, `model point ${p} is not on screen`).not.toBeNull();
    const box = await page.locator('#workspace-frame').boundingBox();
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(box!.x + xy![0], box!.y + xy![1]);
    if (shift) await page.keyboard.up('Shift');
  };
  await clickAt([15, 0, 0]);
  for (const p of [[30, 10, 0], [15, 20, 0], [0, 10, 0]]) await clickAt(p, true);
  await page.keyboard.press('Control+c');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-panel-note]')).toHaveText('Copied 4 lines, 4 relations and 1 dimension; 1 relation to other geometry will be left out.');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();

  // The model reads what is held, pastes all of it on Front with its middle at (65, 10), and extrudes it.
  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '', regions: 'short' } }] },
    { tools: [{ name: 'cad__sketch', input: { edit: '', name: 'Copy', on: 'Front', entities: [], constraints: [C('k1', 'copy', ['at(65, 10)'], 'from clipboard')], infer: false } }] },
    { tools: [EXTRUDE('Block', 'Copy', '10 mm')] },
    { text: 'What you copied is pasted on Front, 50 mm along, and extruded 10 mm.' },
  );
  const t2 = await startTurn(request, host, { text: 'Paste what I copied onto the Front plane, 50 mm along, and extrude it 10 mm.', tab });
  expect((await t2.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, afterRead, afterCopy, afterExtrude] = chats(host).slice(before);
  const [model] = resultsIn(afterRead);
  expect(model).toMatchObject({ tool: 'cad__get_model', ok: true, data: { clipboard: '4 lines, 4 relations and 1 dimension, copied from Plate' } });
  const [sk] = resultsIn(afterCopy);
  expect(sk).toMatchObject({ tool: 'cad__sketch', ok: true, data: { feature: { name: 'Copy', state: 'ok' } } });
  const made = (sk.data!.made as { id: string; kind: string; entities: string[]; values: Record<string, unknown> }[])[0];
  expect(made).toMatchObject({ id: 'k1', kind: 'copy', entities: ['k1.1', 'k1.2', 'k1.3', 'k1.4'], values: { from: 'the clipboard (copied from Plate)', copied: '4 lines, 4 relations and 1 dimension', left_out: '1 relation to other geometry', middle_at: 'at(65, 10)' } });
  const [ex] = resultsIn(afterExtrude);
  expect(ex).toMatchObject({ tool: 'cad__extrude', ok: true, data: { feature: { name: 'Block', state: 'ok' } } });
  // What the person sees: both sketches and the block in the tree; the block's volume (30 x 20 x 10).
  await expect(historyNames(frame)).toHaveText(['(-) Plate', '(-) Copy', 'Block'], STEP);
  const copy = (await featureOf(page, 'Copy')) as (Sketchy & { constraints: { kind: string; expr?: string }[] }) | null;
  expect(copy!.entities!.map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line']);
  expect(copy!.constraints.filter((c) => c.expr != null).map((c) => c.expr)).toEqual(['30 mm']);
  await expect.poll(async () => Math.abs((await volumeNow(page)) - 6000) < 1e-6, STEP).toBe(true);
});
