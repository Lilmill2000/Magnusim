// The person's sketch tools through the Assistant, as the person sees them in the real host frame
// (help sketch_tools): the scripted model draws a wing section as one closed spline through its
// fit points, holds each point with fix (fully defined), and extrudes the region the spline bounds.
// The person's tree shows the sketch and the wing, no panel is left open, the sketch's stored
// entity is the person's fit spline, the volume chip is the section's area times the span, and
// one Undo ("Undo Assistant: <request>") takes both away. A second test rounds a plate's corner
// with fillet and lays a circular pattern of holes; a later turn sets the pattern's count with
// edit_feature and extrudes the plate: the tree and the volume chip show the eight holes.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { historyNames } from './helpers';
import { cadFrame, chats, chipWords, newProject, openNewPart, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';

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
  const regions = sketch.data!.regions as { area_mm2: number; bounded_by: string[] }[];
  expect(regions).toHaveLength(1);
  expect(regions[0].bounded_by).toEqual(['w']);
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
