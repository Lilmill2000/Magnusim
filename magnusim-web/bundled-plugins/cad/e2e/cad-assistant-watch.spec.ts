// The Part's tools for the app's Assistant, as the person and the model meet them (CAD tools spec
// §12.3 watch 1, T1): a Part open in its workspace offers its 20 tools on its tab; a turn there
// offers 23 (the app's 3 first, then the Part's by name), the first 20 strict and the last 3 not;
// the system text holds the CAD notes; the tools go out byte for byte the same in the next turn.
// get_model answers the model with the Part in data; a hole on the empty Part answers bad_selector
// with its hint and the Part's names. The dock's chip and the frame's data-assistant say what
// the Assistant does: thinking while the model answers, working while a call runs ("Read the
// Part"), then "Assistant: <request> · done".
// view's handles (the S2 integration): a picture's #f1 is the face find reads as #f1, and its #b1
// renames the block through body, as the person's tree shows.
// measure (watch 6, T10): the chip says "Measure" while it runs; the model gets a block's volume
// and no voids, two separate blocks' distance, no overlap and two solids joined, a cut's area, and
// a face by its label (find's selectors); the turn's log reads each measurement; nothing in the
// Part changes.
// Watch mode (watch 2-4 and 7, T12): a watched build (the watch pace, delays at 0.3) shows the
// Assistant's own read-only panels (its plane, the sketch with Done disabled and the reason, the
// Fillet), the chip working with the step and the steps used, the DOF chip going from under- to
// fully defined as the dimensions go in; the Undo hint names the request, one Ctrl+Z takes it all
// back and Ctrl+Shift+Z brings it again. The person's open Parameters panel during set_params: no
// wait, the new values and the flash, still open. The camera latch: a drag or a tree menu's Normal
// to during the turn keeps the view where the person put it; with no move the sketch turns the
// view to its plane (a plane the view was not facing: Front after the person's Normal to on Top). The chip after the turn: Undo is one Ctrl+Z of the request; the Part's health
// says "· 1 sketch under-defined" (amber) or "· Fillet 1 fails" (red; a click selects its row).
// The guide's plate, watched (watch 2 as the spec has it, the S4 integration once extrude and hole
// were built): the Assistant's Parameters panel, its plate sketch going to fully defined, its
// Extrude panel, then the holes' sketch and their cut; the tree with no "(-)", the volume chip
// about 13,928.8; one Ctrl+Z empties the tree and Ctrl+Shift+Z brings it all back.
// help (T13): the model reads help guide (the CAD notes) and help example_plate whole through the
// app, sends the worked plate's calls as they read, and the person sees the plate built (the tree
// with no "(-)", the volume chip), each reply the line help gives, one Undo for the request.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { HINTS } from '../src/assistant/errors';
import { WORKED_PARTS } from '../src/assistant/examples';
import { GUIDE } from '../src/assistant/guide';
import {
  cadFrame,
  chats,
  chipButton,
  chipWords,
  forcePace,
  newProject,
  offeredTools,
  openNewPart,
  readRecord,
  recordShown,
  resetAssistant,
  resultsIn,
  startAssistantHost,
  startTurn,
  STEP,
  STEP_MS,
  tabRow,
  useScriptedModel,
  type AssistantHost,
} from './assistant-helpers';
import { addSolid, countFileWrites, fileWrites, runCommand, singleVolume } from './helpers';
import { PNG, type Image } from './png';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-watch', 60);
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
  // A scripted answer left: the turns did not go as the test wrote them.
  expect(host.fake.pending(), 'scripted answers left unused').toBe(0);
});

/** The Part's 20 tools by name, as the app names them (src/assistant/schemas.ts). */
const CAD = ['body', 'combine', 'construct', 'delete', 'direct', 'edit_feature', 'extrude', 'find', 'get_model', 'help', 'hole', 'measure', 'modify', 'pattern', 'revolve', 'set_params', 'sketch', 'sweep_loft', 'undo', 'view'].map((n) => `cad__${n}`);
const HOST_TOOLS = ['app_status', 'explain_ready', 'project_summary'];

test('cad:assistant-watch-registration the Part offers its 20 tools; a turn offers 23, the first 20 strict, with the CAD notes, the same bytes every turn', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant registration');
  const { tab } = await openNewPart(page, request, host, pid);
  const row = await tabRow(request, host, tab);
  expect(row).toMatchObject({ connected: true, refused: [] });
  expect(row!.tools).toEqual(CAD);

  const before = chats(host).length;
  host.fake.reply({ text: 'Hello.' }, { text: 'Hello again.' });
  const t1 = await startTurn(request, host, { text: 'Say hello.', tab });
  expect((await t1.ended(STEP_MS)).turn.state).toBe('done');
  const t2 = await startTurn(request, host, { text: 'Say hello again.', tab });
  expect((await t2.ended(STEP_MS)).turn.state).toBe('done');
  const [first, second] = chats(host).slice(before);
  // The app's own tools first (by name), then the Part's by name: 23, the first 20 strict (the provider's budget).
  const loose = ['cad__sweep_loft', 'cad__undo', 'cad__view'];
  expect(offeredTools(first)).toEqual([...HOST_TOOLS, ...CAD].map((name) => ({ name, strict: !loose.includes(name) })));
  // The CAD notes are the second system block, line breaks kept.
  const system = (first.body.system as { text: string }[]).map((s) => s.text).join('\n');
  expect(system).toContain(GUIDE);
  // The same tools, byte for byte, in the next turn (one registration for the page's life).
  expect(JSON.stringify(second.body.tools)).toBe(JSON.stringify(first.body.tools));
});

test("cad:assistant-watch-get-model get_model reads the Part to the model; a hole on the empty Part says why; the chip and data-assistant follow the turn", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant get_model');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const app = frame.locator('[data-cad-app]');
  const chip = frame.locator('[data-chip="assistant"]');
  await expect(app).toHaveAttribute('data-assistant', 'idle', STEP);
  await expect(chip).toHaveCount(0);
  await recordShown(page, 'phase', '[data-cad-app]', 'data-assistant');

  const before = chats(host).length;
  host.fake.reply(
    // The model is still answering: the chip says the Assistant thinks.
    { hold: 'think', tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '' } }] },
    { tools: [{ name: 'cad__hole', input: { name: '', face: 'Extrude 1.end', centers: [{ x: '0 mm', y: '0 mm', z: '' }], diameter: '5 mm', depth: 'through', distance: '' } }] },
    { text: 'The Part is empty, so there is no face to drill yet.' },
  );
  // The read stops where the Part has settled, so the chip is seen working.
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { hold(p: string): void } } }).__CAD__.assistant.hold('after-settled'));
  const t = await startTurn(request, host, { text: 'Read the Part, then drill a hole.', tab });
  await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
  await expect(chipWords(frame)).toHaveText(/^Assistant · thinking · \d+ of 120 steps$/, STEP);
  await expect(app).toHaveAttribute('data-assistant', 'thinking');
  host.fake.release('think');
  await expect(chip).toHaveAttribute('data-assistant-state', 'working', STEP);
  await expect(chipWords(frame)).toHaveText(/^Assistant · Read the Part · \d+ of 120 steps$/);
  await expect(app).toHaveAttribute('data-assistant', 'working');
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { release(p: string): void } } }).__CAD__.assistant.release('after-settled'));
  const { turn } = await t.ended(STEP_MS * 2);
  expect(turn.state).toBe('done');
  await expect(chip).toHaveAttribute('data-assistant-state', 'ended', STEP);
  await expect(chipWords(frame)).toHaveText('Assistant: Read the Part, then drill a hole. · done');
  await expect(app).toHaveAttribute('data-assistant', 'ended');
  // Every phase the frame showed, in order (the second call answers at once: its working may not be drawn).
  const shown = await readRecord(page, 'phase');
  expect(shown.slice(0, 4)).toEqual(['idle', 'thinking', 'working', 'thinking']);
  expect(shown[shown.length - 1]).toBe('ended');
  expect(shown.every((p) => ['idle', 'thinking', 'working', 'ended'].includes(p)), shown.join(' ')).toBe(true);

  // What the model got back.
  const [, afterRead, afterHole] = chats(host).slice(before);
  const [read] = resultsIn(afterRead);
  expect(read).toMatchObject({
    tool: 'cad__get_model',
    ok: true,
    data: { part: 'Part 1', units: { length: 'mm', angle: 'deg' }, editable: true, rolled_back: null, person: null, features: [], bodies: [], params: [], notes: 'If you have no notes from the CAD workspace, read help guide' },
  });
  expect(typeof read.data!.rev).toBe('number');
  const [hole] = resultsIn(afterHole);
  expect(hole).toMatchObject({
    tool: 'cad__hole',
    ok: false,
    error: {
      code: 'invalid_input',
      message: 'bad_selector: face: no body starts here (column 1 of "Extrude 1.end").',
      hint: HINTS.bad_selector,
      detail: { reason: 'bad_selector', field: 'face', selector: 'Extrude 1.end', names: { features: [], bodies: [] } },
    },
  });
  // The page's ledger: what the eval counts.
  const calls = await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { calls: { tool: string; ok: boolean; reason?: string; key: string }[] } } }).__CAD__.assistant.calls.map((c) => ({ tool: c.tool, ok: c.ok, reason: c.reason ?? null, key: c.key })));
  expect(calls).toEqual([
    { tool: 'get_model', ok: true, reason: null, key: `turn:${t.id}` },
    { tool: 'hole', ok: false, reason: 'bad_selector', key: `turn:${t.id}` },
  ]);
});

// ---- T3: find (CAD tools spec §3.2.2, §5; §12.3 honest 6, kept here beside the other read tools)

/** The view's flash calls, recorded in the frame (the viewport lights what it is handed). */
async function recordFlashes(page: Page): Promise<void> {
  await cadFrame(page).evaluate(() => {
    const w = window as unknown as { __flashes: unknown[][]; __CAD__: { services: { viewport: { get(): { handle: { flash(items: unknown[]): void } } } } } };
    const handle = w.__CAD__.services.viewport.get().handle;
    const flash = handle.flash.bind(handle);
    w.__flashes = [];
    handle.flash = (items) => {
      w.__flashes.push(items);
      flash(items);
    };
  });
}
const flashes = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as { __flashes: unknown[][] }).__flashes);

test("cad:assistant-watch-find find lists the matches with handles and lights them in the person's view; a miss names the nearest face; a handle of a face the person undid is stale", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant find');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const made = await addSolid(page, { size: [40, 30, 10] });
  const top = await cadFrame(page).evaluate((id) => {
    const s = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { bodies: { id: string; names?: { faces: string[] } | null }[] } } } } } } }).__CAD__.services.doc.state.get();
    const b = s.rebuild.bodies[0];
    return { body: b.id, index: b.names!.faces.indexOf(`F:${id}:end`) };
  }, made.extrude);
  expect(top.index).toBeGreaterThanOrEqual(0);
  await recordFlashes(page);

  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__find', input: { query: 'Body 1 faces >Z', limit: 10 } }] },
    { tools: [{ name: 'cad__find', input: { query: 'Body 1 face at (5, 5, 11)', limit: 10 } }] },
    // The model is still answering while the person undoes the extrude.
    { hold: 'person', tools: [{ name: 'cad__find', input: { query: '#f1', limit: 10 } }] },
    { text: 'The top face is gone now.' },
  );
  const t = await startTurn(request, host, { text: 'Find the top face.', tab });
  await expect.poll(() => chats(host).length - before, { message: 'the third request is held', timeout: STEP_MS }).toBe(3);

  // The match was lit in the view, for a while.
  expect((await flashes(page))[0]).toEqual([{ kind: 'face', body: top.body, index: top.index }]);
  await expect.poll(async () => (await flashes(page)).at(-1), { message: 'the light goes out', timeout: STEP_MS }).toEqual([]);

  // The person undoes the extrude: the face the handle named is gone.
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  await page.keyboard.press('Control+z');
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1'], STEP);
  host.fake.release('person');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');

  const [, afterFind, afterMiss, afterStale] = chats(host).slice(before);
  const [found] = resultsIn(afterFind);
  expect(found).toMatchObject({ tool: 'cad__find', ok: true, data: { query: 'Body 1 faces >Z', kind: 'face', count: 1, more: 0 } });
  expect((found.data!.rows as Record<string, unknown>[])[0]).toMatchObject({
    handle: '#f1',
    kind: 'face',
    label: 'Extrude 1.end',
    words: 'End face of Extrude 1',
    body: 'Body 1',
    feature: 'Extrude 1',
    role: 'end',
    type: 'plane',
    area_mm2: 1200,
    center_mm: [20, 15, 10],
    normal: [0, 0, 1],
    frame: { words: 'u runs +X, v runs +Y, origin (0, 0, 10)' },
  });
  const [miss] = resultsIn(afterMiss);
  expect(miss).toMatchObject({
    tool: 'cad__find',
    ok: false,
    error: { code: 'invalid_input', message: 'nothing_selected: No face of Body 1 at (5, 5, 11): nearest is Extrude 1.end, 1 mm away.', detail: { reason: 'nothing_selected' } },
  });
  expect((miss.error!.detail!.candidates as Record<string, unknown>[])[0]).toMatchObject({ handle: '#f1', label: 'Extrude 1.end', words: 'End face of Extrude 1' });
  const [stale] = resultsIn(afterStale);
  expect(stale).toMatchObject({
    tool: 'cad__find',
    ok: false,
    error: { code: 'invalid_input', message: 'selector_stale: #f1 is gone: Body 1 is not there now; call find again.', hint: 'That handle is gone after a change: call find again.', detail: { reason: 'selector_stale', handle: '#f1' } },
  });

  // At the fast pace find answers the same way, and nothing lights in the person's view.
  type Pace = { __CAD__: { assistant: { setPace(p: string | null, scale?: number | null): void; calls: { tool: string; ok: boolean }[] } } };
  await cadFrame(page).evaluate(() => (window as unknown as Pace).__CAD__.assistant.setPace('fast'));
  const lit = (await flashes(page)).length;
  const fastFrom = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__find', input: { query: 'Sketch 1 regions', limit: 10 } }] }, { text: 'One region.' });
  expect((await (await startTurn(request, host, { text: 'Find the sketch regions.', tab })).ended(STEP_MS * 2)).turn.state).toBe('done');
  const [regions] = resultsIn(chats(host).slice(fastFrom)[1]);
  expect(regions).toMatchObject({ tool: 'cad__find', ok: true, data: { query: 'Sketch 1 regions', kind: 'region', count: 1 } });
  expect((await flashes(page)).length).toBe(lit);
  await cadFrame(page).evaluate(() => (window as unknown as Pace).__CAD__.assistant.setPace(null));
});

test('cad:assistant-watch-measure measure gives a body its volume and voids, two separate bodies no overlap and two solids joined, a cut its area, a face by its label; the log reads them', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant measure');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  // Two 20 mm blocks, 20 mm apart along X (made as the person makes them: a sketch, then Extrude).
  await addSolid(page);
  await addSolid(page, { at: [40, 0, 0] });
  const chip = frame.locator('[data-chip="assistant"]');
  const features = () => cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { snapshot(): { doc: { features: number; bodies: number } } } }).__CAD__.snapshot().doc);
  expect(await features()).toMatchObject({ features: 4, bodies: 2 });

  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__measure', input: { targets: ['Body 1'], section: '' } }] },
    { tools: [{ name: 'cad__measure', input: { targets: ['Body 1', 'Body 2'], section: '' } }] },
    { tools: [{ name: 'cad__measure', input: { targets: ['Body 2'], section: 'Top offset 10 mm' } }] },
    { tools: [{ name: 'cad__measure', input: { targets: ['Extrude 2.end'], section: '' } }] },
    { text: 'Two separate blocks of 8000 mm3.' },
  );
  // The first measure stops once the Part has settled: the chip says what runs.
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { hold(p: string): void } } }).__CAD__.assistant.hold('after-settled'));
  const t = await startTurn(request, host, { text: 'Measure the blocks.', tab });
  await expect(chip).toHaveAttribute('data-assistant-state', 'working', STEP);
  await expect(chipWords(frame)).toHaveText(/^Assistant · Measure · \d+ of 120 steps$/);
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { release(p: string): void } } }).__CAD__.assistant.release('after-settled'));
  const { turn, events } = await t.ended(STEP_MS * 2);
  expect(turn.state).toBe('done');

  // The turn's log reads each measurement.
  expect(events.filter((e) => e.type === 'tool_result').map((e) => ({ ok: e.ok, summary: e.summary }))).toEqual([
    { ok: true, summary: 'Measured Body 1: volume 8000 mm3, 1 solid, 0 voids' },
    { ok: true, summary: 'Measured Body 1 to Body 2: distance 20 mm, overlap 0 mm3, joined 2 solids and 0 voids' },
    { ok: true, summary: 'Measured Body 2 cut at Top offset 10 mm: area 400 mm2 in 1 piece, 0 holes' },
    { ok: true, summary: 'Measured face Extrude 2.end on Body 2: plane, area 400 mm2' },
  ]);

  // What the model got back.
  const [, afterBody, afterPair, afterSection, afterFace] = chats(host).slice(before);
  const [body] = resultsIn(afterBody);
  expect(body).toMatchObject({
    tool: 'cad__measure',
    ok: true,
    data: { target: 'Body 1', kind: 'body', volume_mm3: 8000, area_mm2: 2400, solids: 1, shells: 1, voids: 0, faces: 6, valid: true, bbox_mm: [[0, 0, 0], [20, 20, 20]] },
  });
  const [pair] = resultsIn(afterPair);
  expect(pair).toMatchObject({ tool: 'cad__measure', ok: true, data: { distance_mm: 20, delta_mm: [20, 0, 0], overlap_mm3: 0, touching: false, union_solids: 2, union_voids: 0 } });
  const [section] = resultsIn(afterSection);
  expect(section).toMatchObject({ tool: 'cad__measure', ok: true, data: { body: 'Body 2', section: { plane: 'Top offset 10 mm', area_mm2: 400, loops: 1, holes: 0, regions: [{ area_mm2: 400, holes: 0 }] } } });
  const [face] = resultsIn(afterFace);
  expect(face).toMatchObject({ tool: 'cad__measure', ok: true, data: { target: 'Extrude 2.end', kind: 'face', body: 'Body 2', type: 'plane', area_mm2: 400, normal: [0, 0, 1], center_mm: [50, 10, 20] } });
  // A read: the Part is as it was (the same revision in every answer, no feature added).
  const revs = [body, pair, section, face].map((r) => r.data!.rev);
  expect(new Set(revs).size).toBe(1);
  expect(await features()).toMatchObject({ features: 4, bodies: 2 });
  await expect(chipWords(frame)).toHaveText('Assistant: Measure the blocks. · done', STEP);
});

// ---- view (spec §12.3 watch 5): pictures drawn off screen reach the model; the person's view stays.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cad = { __CAD__: { services: any; assistant: { turns(): { id: string; images: boolean | null }[]; calls: { tool: string; ok: boolean; reason?: string }[] } } };

/** The view as the person has it: the camera, the Part's saved camera, whether still framed, the count of camera moves. */
const personView = (page: Page) =>
  cadFrame(page).evaluate(() => {
    const s = (window as unknown as Cad).__CAD__.services;
    const h = s.viewport.get().handle;
    return { camera: h.camera(), saved: s.doc.state.get().view.camera ?? null, framed: h.stats().framed, moves: h.userCameraMoves() };
  });

/** No transition, every picking structure built, no rebuild running, the Part saved, two more frames. */
async function stillAndSaved(page: Page) {
  const f = cadFrame(page);
  await f.waitForFunction(
    () => {
      const s = (window as unknown as Cad).__CAD__.services;
      const v = s.viewport.get().handle?.state.get();
      return !!v && !v.animating && v.bvhPending === 0 && s.doc.state.get().rebuild.status !== 'running' && s.doc.state.get().save.state === 'saved';
    },
    null,
    { timeout: 60_000 },
  );
  await f.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Each ws.data write from now on (the Part's view file; the model goes through ws.files). */
async function countDataWrites(page: Page) {
  await cadFrame(page).evaluate(() => {
    const w = window as unknown as Cad & { __dataWrites?: string[] };
    const data = w.__CAD__.services.bridge.data;
    w.__dataWrites = [];
    const write = data.write.bind(data);
    data.write = (...a: unknown[]) => {
      w.__dataWrites!.push(String(a[0]));
      return write(...a);
    };
  });
}

/** An image block of the first cloud dialect, decoded. */
function imageOf(block: unknown): { type: string; img: Image } {
  const b = block as { type: string; source: { type: string; media_type: string; data: string } };
  expect(b.type).toBe('image');
  expect(b.source.type).toBe('base64');
  return { type: b.source.media_type, img: PNG.decode(Buffer.from(b.source.data, 'base64')) };
}

/**
 * What one tile of a 2 x 2 sheet shows (its name's corner, the triad's corner and the lines
 * between tiles left out): the fraction that is not the view's background, and the fraction in
 * the red body's colour family.
 */
function tileSeen(img: Image, tx: number, ty: number, tw: number, th: number) {
  let n = 0;
  let drawn = 0;
  let red = 0;
  for (let y = ty + 2; y < ty + th - 2; y++)
    for (let x = tx + 2; x < tx + tw - 2; x++) {
      if (x < tx + 90 && y < ty + 30) continue;
      if (x >= tx + tw - 90 && y >= ty + th - 90) continue;
      const [r, g, b] = PNG.at(img, x, y);
      n++;
      if (Math.abs(r - 0xf0) > 4 || Math.abs(g - 0xf2) > 4 || Math.abs(b - 0xf7) > 4) drawn++;
      if (r > g + 60 && r > b + 60) red++;
    }
  return { drawn: drawn / n, red: red / n };
}

test("cad:assistant-watch-view view pictures the Part off screen: one image in the next request with the bodies in it, a hidden body left out, the person's view and files unchanged", async ({ page, request }) => {
  test.setTimeout(300_000);
  const pid = await newProject(request, host, 'Assistant view');
  const { tab } = await openNewPart(page, request, host, pid);
  // Two blocks: a grey one at the origin, a red one at +X.
  const a = await addSolid(page, { size: [20, 20, 20] });
  const b = await addSolid(page, { at: [40, 0, 0], size: [20, 20, 20] });
  const f = cadFrame(page);
  await f.evaluate((id) => (window as unknown as Cad).__CAD__.services.doc.setBodyColor(id, '#d02828'), b.body);
  const names = await f.evaluate((ids) => ids.map((id) => (window as unknown as Cad).__CAD__.services.doc.state.get().rebuild.bodies.find((x: { id: string }) => x.id === id).name as string), [a.body!, b.body!]);
  await stillAndSaved(page);
  const before = await personView(page);
  await countFileWrites(page);
  await countDataWrites(page);

  const input = (hide: string[]) => ({ views: ['iso', 'top'], hide, section: '', labels: 'none', size: 'small' });
  const from = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__view', input: input([]) }] }, { tools: [{ name: 'cad__view', input: input([names[1]]) }] }, { text: 'Two blocks; the red one on the right.' });
  const t = await startTurn(request, host, { text: 'Look at the Part.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, afterFirst, afterSecond] = chats(host).slice(from);

  // The first picture: one image block, a 2 x 2 sheet 768 px wide, both blocks in it.
  const [first] = resultsIn(afterFirst);
  expect(first).toMatchObject({ tool: 'cad__view', ok: true, data: { views: [{ view: 'iso' }, { view: 'top' }], shown: names, hidden: [], section: null, labels: [] } });
  expect(first.images).toHaveLength(1);
  const one = imageOf(first.images[0]);
  expect(one.type).toBe('image/png');
  expect([one.img.width, one.img.height]).toEqual([768, 576]);
  const iso = tileSeen(one.img, 0, 0, 384, 288);
  const top = tileSeen(one.img, 384, 0, 384, 288);
  expect(iso.drawn, 'the bodies in the iso picture').toBeGreaterThan(0.02);
  expect(top.drawn, 'the bodies in the top picture').toBeGreaterThan(0.02);
  expect(iso.red, 'the red block in the iso picture').toBeGreaterThan(0.005);
  expect(top.red, 'the red block in the top picture').toBeGreaterThan(0.005);
  // The empty half of the sheet is the view's background.
  expect(tileSeen(one.img, 0, 288, 384, 288).drawn).toBeLessThan(0.001);
  expect(tileSeen(one.img, 384, 288, 384, 288).drawn).toBeLessThan(0.001);

  // The second, with the red block hidden: its colour is gone, the grey one still drawn.
  const [second] = resultsIn(afterSecond);
  expect(second).toMatchObject({ tool: 'cad__view', ok: true, data: { shown: [names[0]], hidden: [names[1]] } });
  expect(second.images).toHaveLength(1);
  const two = imageOf(second.images[0]).img;
  const iso2 = tileSeen(two, 0, 0, 384, 288);
  const top2 = tileSeen(two, 384, 0, 384, 288);
  expect(iso2.red, 'the hidden body is left out of iso').toBeLessThan(iso.red * 0.05);
  expect(top2.red, 'the hidden body is left out of top').toBeLessThan(top.red * 0.05);
  expect(iso2.drawn).toBeGreaterThan(0.02);

  // The person's view as it was: camera, saved camera, framing and the count of moves; nothing written.
  await stillAndSaved(page);
  expect(await personView(page)).toEqual(before);
  expect(await fileWrites(page)).toEqual([]);
  expect(await cadFrame(page).evaluate(() => [...((window as unknown as { __dataWrites?: string[] }).__dataWrites ?? [])])).toEqual([]);
});

test("cad:assistant-watch-view-handles a picture's handles are the request's own: find names its #f1, and body renames the block by its #b1 in the person's tree", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant view handles');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const made = await addSolid(page, { size: [40, 30, 10] });
  const view = (labels: string) => ({ views: ['top'], hide: [], section: '', labels, size: 'small' });
  const from = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__view', input: view('faces') }] },
    { tools: [{ name: 'cad__find', input: { query: '#f1', limit: 10 } }] },
    { tools: [{ name: 'cad__view', input: view('bodies') }] },
    { tools: [{ name: 'cad__body', input: { body: '#b1', rename_to: 'Plate', color: '', simulation: 'keep' } }] },
    { text: 'The block is called Plate now.' },
  );
  const t = await startTurn(request, host, { text: 'Name the block Plate.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, afterFaces, afterFind, afterBodies, afterBody] = chats(host).slice(from);
  // The picture's face handle is the one find reads: the top face.
  const [faces] = resultsIn(afterFaces);
  expect(faces).toMatchObject({ tool: 'cad__view', ok: true, data: { labels: [{ handle: '#f1', words: 'End face of Extrude 1 on Body 1' }] } });
  const [found] = resultsIn(afterFind);
  expect(found).toMatchObject({ tool: 'cad__find', ok: true, data: { query: '#f1', kind: 'face', count: 1, rows: [{ handle: '#f1', label: 'Extrude 1.end', normal: [0, 0, 1] }] } });
  // The picture's body handle names the block in body: the person's tree shows its new name.
  const [bodies] = resultsIn(afterBodies);
  expect(bodies).toMatchObject({ tool: 'cad__view', ok: true, data: { labels: [{ handle: '#b1', words: 'Body 1' }] } });
  const [renamed] = resultsIn(afterBody);
  expect(renamed).toMatchObject({ tool: 'cad__body', ok: true, data: { body: { name: 'Plate' } } });
  await expect(frame.locator(`[data-body-row="${made.body}"]`)).toContainText('Plate', STEP);
});

test('cad:assistant-watch-view-no-images a local model that reads no images is told so in words, and no picture is drawn', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant view text only');
  const { tab } = await openNewPart(page, request, host, pid);
  await addSolid(page, { size: [20, 20, 20] });
  const local = await useScriptedModel(request, host, 'local');
  // The local server says its model is a text model (its row), with room for the CAD tools.
  host.fake.models([{ id: local.model, context: 65_536, type: 'llm' }], 'compat');
  try {
    const from = chats(host).length;
    const input = { views: ['iso'], hide: [], section: '', labels: 'none', size: 'small' };
    host.fake.reply({ hold: 'text-only-view', tools: [{ name: 'cad__view', input }] }, { text: 'I cannot see pictures here; I will measure instead.' });
    const t = await startTurn(request, host, { text: 'Look at the Part.', tab });
    // The page heard that this turn's model reads no images before the call comes.
    await expect
      .poll(() => cadFrame(page).evaluate((id) => (window as unknown as Cad).__CAD__.assistant.turns().find((x) => x.id === id)?.images ?? 'not told', t.id), { ...STEP, message: "the page hears the turn's model reads no images" })
      .toBe(false);
    host.fake.release('text-only-view');
    expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
    const [, after] = chats(host).slice(from);
    const [res] = resultsIn(after);
    expect(res).toMatchObject({
      tool: 'cad__view',
      ok: false,
      error: { code: 'not_ready', message: "no_images: This request's model does not read images, so no picture is drawn.", hint: HINTS.no_images, detail: { reason: 'no_images' } },
    });
    expect(HINTS.no_images).toBe("The model can't read images here: use measure and find.");
    // No picture went to the model, and the page drew none.
    expect(JSON.stringify(chats(host).slice(from).map((r) => r.body))).not.toContain('image_url');
    const calls = await cadFrame(page).evaluate(() => (window as unknown as Cad).__CAD__.assistant.calls.map((c) => ({ tool: c.tool, ok: c.ok, reason: c.reason ?? null })));
    expect(calls.at(-1)).toEqual({ tool: 'view', ok: false, reason: 'no_images' });
  } finally {
    // The scripted model listed again, with no row.
    host.fake.models([local.model], 'compat');
  }
});

// ---- Watch mode (watch 2-4 and 7, T12)

type WW = {
  __CAD__: {
    assistant: { setPace(p: string | null, scale?: number | null): void; calls: { tool: string; ok: boolean; paced?: number }[] };
    services: {
      doc: {
        addParam(p: { name: string; expr: string; quantity: string }): unknown;
        beginNew(type: string, init: unknown): { feature: string; commit(): void };
        undo(): void;
        state: { get(): { doc: { features: { id: string; name: string }[]; params: { name: string; expr: string }[] }; history: { undoLabel: string | null }; rebuild: { status: string; features: Record<string, { state: string }> } } };
      };
      viewport: { get(): { handle: { camera(): { position: number[]; target: number[]; up: number[] }; state: { get(): { animating: boolean } }; userCameraMoves(): number } } };
    };
  };
};
const SE = (id: string, kind: string, at: number[]) => ({ id, kind, at, construction: false });
const SC = (id: string, kind: string, refs: string[], value = '') => ({ id, kind, refs, value });
const sketchOf = (name: string, on: string, constraints = [SC('c0', 'coincident', ['r.center', 'origin']), SC('dw', 'distance', ['r.bottom'], '60 mm'), SC('dh', 'distance', ['r.left'], '40 mm')]) => ({
  name: 'cad__sketch',
  input: { edit: '', name, on, entities: [SE('r', 'center_rect', [0.5, 0.4, 59, 39])], constraints, infer: false },
});
const SETP = (name: string, expr: string) => ({ name: 'cad__set_params', input: { set: [{ name, kind: 'length', expr, comment: '', rename_to: '' }], remove: [] } });
/** The camera once no transition runs. */
async function cameraNow(page: Page) {
  await expect.poll(() => cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.viewport.get().handle.state.get().animating), STEP).toBe(false);
  return cadFrame(page).evaluate(() => {
    const c = (window as unknown as WW).__CAD__.services.viewport.get().handle.camera();
    return { position: c.position, target: c.target, up: c.up };
  });
}
const paramsNow = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.doc.state.get().doc.params.map((p) => p.name));
const undoNow = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.doc.state.get().history.undoLabel);
const watchHistory = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl');

test('cad:assistant-watch-build a watched build: the read-only sketch panel and the DOF going to fully defined, then the Fillet panel; one Ctrl+Z takes the request back, Ctrl+Shift+Z brings it again', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant watched build');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.assistant.setPace('fast', 0));
  await addSolid(page, { size: [40, 30, 10] });
  await expect(watchHistory(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  const label0 = await undoNow(page);
  // What the frame shows, frame by frame: the panels and their owner, Done's reason, the chip, the DOF chip.
  await recordShown(page, 'panel', '[data-cad-panel]', 'data-cad-panel');
  await recordShown(page, 'owner', '[data-cad-panel]', 'data-panel-owner');
  await recordShown(page, 'done', '[data-cad-panel] [data-panel-done]', 'data-disabled-reason');
  await recordShown(page, 'chip', '[data-chip="assistant"]', 'data-assistant-state');
  await recordShown(page, 'words', '[data-chip="assistant"] [data-assistant-text]');
  await recordShown(page, 'dof', '[data-chip="sketch"]', 'data-state');
  // The person's pace: watch, its delays at 0.3.
  await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.assistant.setPace('watch', 0.3));
  const before = chats(host).length;
  host.fake.reply({ tools: [sketchOf('Plate sketch', 'Top offset 10 mm')] }, { tools: [{ name: 'cad__modify', input: { edit: '', name: '', kind: 'fillet', targets: ['Extrude 1.end'], size: '2 mm', size2: '', flip: false, inward: false } }] }, { text: 'The plate sketch and the rounded block are ready.' });
  const t = await startTurn(request, host, { text: 'Build a plate.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  expect(resultsIn(chats(host)[before + 1])[0]).toMatchObject({ tool: 'cad__sketch', ok: true, data: { solver: { state: 'fully', dof: 0 } } });
  expect(resultsIn(chats(host)[before + 2])[0]).toMatchObject({ tool: 'cad__modify', ok: true });
  // The Assistant's own panels, read-only: first its plane, then the sketch, then the Fillet.
  const panels = (await readRecord(page, 'panel')).filter((p) => p !== '(none)');
  expect(panels).toEqual(['feature', 'sketch', 'feature']);
  const owners = (await readRecord(page, 'owner')).filter((o) => o !== '(none)');
  expect(owners.length).toBeGreaterThan(0);
  expect(owners.every((o) => o === 'assistant'), owners.join(' ')).toBe(true);
  expect(await readRecord(page, 'done')).toContain('The Assistant is filling this in · Esc takes over (the Assistant pauses)');
  expect(await readRecord(page, 'chip')).toContain('working');
  expect((await readRecord(page, 'words')).some((w) => /^Assistant · Sketch Plate sketch · \d+ of 120 steps$/.test(w))).toBe(true);
  // The DOF chip went from under-defined to fully defined as the dimensions went in.
  const dof = (await readRecord(page, 'dof')).filter((d) => d === 'under' || d === 'fully');
  expect(dof.indexOf('under')).toBeGreaterThanOrEqual(0);
  expect(dof[dof.length - 1]).toBe('fully');
  expect(dof.indexOf('under')).toBeLessThan(dof.lastIndexOf('fully'));
  // Every step was watched (it waited at its pace points).
  const calls = await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.assistant.calls.map((c) => ({ tool: c.tool, paced: c.paced ?? 0 })));
  expect(calls.filter((c) => c.tool === 'sketch' || c.tool === 'modify').every((c) => c.paced > 0)).toBe(true);
  // The tree, fully defined (no "(-)"); the volume went down with the fillet.
  await expect(watchHistory(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Plate sketch plane', 'Plate sketch', 'Fillet 1'], STEP);
  expect(await singleVolume(frame)).toBeLessThan(12_000);
  // The Undo hint names the request; one Ctrl+Z takes all of it back, Ctrl+Shift+Z brings it again.
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Undo Assistant: Build a plate.', STEP);
  await page.mouse.move(5, 5);
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  await page.keyboard.press('Control+z');
  await expect(watchHistory(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  expect(await undoNow(page)).toBe(label0);
  await page.keyboard.press('Control+Shift+z');
  await expect(watchHistory(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Plate sketch plane', 'Plate sketch', 'Fillet 1'], STEP);
});

const PLATE_PARAM = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });
const PLATE_TREE = ['Plate sketch', 'Plate', 'Hole 1 sketch', 'Hole 1'];
/** The guide's plate with its 4 holes (example 1): 60 x 40 x 6 less 4 x pi 2.5^2 x 6. */
const PLATE_MM3 = 60 * 40 * 6 - 4 * Math.PI * 2.5 * 2.5 * 6;

test("cad:assistant-watch-plate the guide's plate, watched: its sketch going to fully defined, then the Extrude panel, then the holes; one Ctrl+Z empties the tree, Ctrl+Shift+Z brings it all back", async ({ page, request }) => {
  test.setTimeout(300_000);
  const pid = await newProject(request, host, 'Assistant watched plate');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  // What the frame shows, frame by frame: the panels, their titles and owner, Done's reason, the chip's words, the DOF chip.
  await recordShown(page, 'panel', '[data-cad-panel]', 'data-cad-panel');
  await recordShown(page, 'title', '[data-cad-panel]', 'aria-label');
  await recordShown(page, 'owner', '[data-cad-panel]', 'data-panel-owner');
  await recordShown(page, 'done', '[data-cad-panel] [data-panel-done]', 'data-disabled-reason');
  await recordShown(page, 'words', '[data-chip="assistant"] [data-assistant-text]');
  await recordShown(page, 'dof', '[data-chip="sketch"]', 'data-state');
  // The person's pace: watch, its delays at 0.3.
  await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.assistant.setPace('watch', 0.3));
  const ex = 'w/2 - e';
  const ey = 'd/2 - e';
  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__set_params', input: { set: [PLATE_PARAM('w', '60 mm'), PLATE_PARAM('d', '40 mm'), PLATE_PARAM('t', '6 mm'), PLATE_PARAM('hd', '5 mm'), PLATE_PARAM('e', '8 mm')], remove: [] } }] },
    { tools: [sketchOf('Plate sketch', 'Top', [SC('c0', 'coincident', ['r.center', 'origin']), SC('dw', 'distance', ['r.bottom'], 'w'), SC('dh', 'distance', ['r.left'], 'd')])] },
    { tools: [{ name: 'cad__extrude', input: { edit: '', name: 'Plate', sketch: 'Plate sketch', regions: ['all'], face: '', direction: '', extent: 'blind', distance: 't', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '' } }] },
    {
      tools: [
        {
          name: 'cad__hole',
          input: {
            name: '',
            face: 'Plate.end',
            centers: [
              { x: ex, y: ey, z: '' },
              { x: `-(${ex})`, y: ey, z: '' },
              { x: `-(${ex})`, y: `-(${ey})`, z: '' },
              { x: ex, y: `-(${ey})`, z: '' },
            ],
            diameter: 'hd',
            depth: 'through',
            distance: '',
          },
        },
      ],
    },
    { text: 'The plate with its four holes is ready.' },
  );
  const t = await startTurn(request, host, { text: 'A plate with four holes.', tab });
  expect((await t.ended(STEP_MS * 4)).turn.state).toBe('done');
  const replies = chats(host)
    .slice(before + 1, before + 5)
    .map((c) => resultsIn(c)[0]);
  expect(replies.map((r) => ({ tool: r.tool, ok: r.ok }))).toEqual(['cad__set_params', 'cad__sketch', 'cad__extrude', 'cad__hole'].map((tool) => ({ tool, ok: true })));
  expect(replies[1]).toMatchObject({ data: { solver: { state: 'fully', dof: 0 } } });
  expect(replies[3]).toMatchObject({
    data: {
      made: ['Hole 1 sketch', 'Hole 1'],
      centers_mm: [
        [22, 12, 6],
        [-22, 12, 6],
        [-22, -12, 6],
        [22, -12, 6],
      ],
      broke: [],
    },
  });
  // The Assistant's own panels, read-only, in order: its Parameters, the plate's sketch, the plate's
  // Extrude panel, then the holes' sketch and their cut.
  expect((await readRecord(page, 'panel')).filter((p) => p !== '(none)')).toEqual(['params', 'sketch', 'feature', 'sketch', 'feature']);
  const titles = await readRecord(page, 'title');
  expect(titles).toContain('Plate');
  expect(titles).toContain('Hole 1');
  const owners = (await readRecord(page, 'owner')).filter((o) => o !== '(none)');
  expect(owners.length).toBeGreaterThan(0);
  expect(owners.every((o) => o === 'assistant'), owners.join(' ')).toBe(true);
  expect(await readRecord(page, 'done')).toContain('The Assistant is filling this in · Esc takes over (the Assistant pauses)');
  const words = await readRecord(page, 'words');
  for (const step of ['Sketch Plate sketch', 'Extrude Plate', 'Hole 1']) expect(words.some((w) => w.startsWith(`Assistant · ${step} · `) && / of 120 steps$/.test(w)), `${step}: ${words.join(' | ')}`).toBe(true);
  // Each sketch's DOF chip went from under-defined to fully defined as its dimensions went in.
  const dof = (await readRecord(page, 'dof')).filter((d) => d === 'under' || d === 'fully');
  expect(dof.filter((d, i) => d === 'fully' && dof[i - 1] === 'under').length, dof.join(' ')).toBe(2);
  expect(dof[dof.length - 1]).toBe('fully');
  // Every edit was watched (it waited at its pace points).
  const calls = await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.assistant.calls.map((c) => ({ tool: c.tool, ok: c.ok, paced: c.paced ?? 0 })));
  expect(calls.map((c) => c.tool)).toEqual(['set_params', 'sketch', 'extrude', 'hole']);
  expect(calls.every((c) => c.ok && c.paced > 0), JSON.stringify(calls)).toBe(true);
  // The tree, every sketch fully defined (no "(-)"); the volume chip.
  await expect(watchHistory(frame)).toHaveText(PLATE_TREE, STEP);
  await expect.poll(async () => Math.abs((await singleVolume(frame)) - PLATE_MM3), STEP).toBeLessThan(0.5);
  // The Undo hint names the request; one Ctrl+Z empties the tree, Ctrl+Shift+Z brings it all back.
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Undo Assistant: A plate with four holes.', STEP);
  await page.mouse.move(5, 5);
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  await page.keyboard.press('Control+z');
  await expect(watchHistory(frame)).toHaveCount(0, STEP);
  expect(await paramsNow(page)).toEqual([]);
  await page.keyboard.press('Control+Shift+z');
  await expect(watchHistory(frame)).toHaveText(PLATE_TREE, STEP);
  expect(await paramsNow(page)).toEqual(['w', 'd', 't', 'hd', 'e']);
  await expect.poll(async () => Math.abs((await singleVolume(frame)) - PLATE_MM3), STEP).toBeLessThan(0.5);
});

test("cad:assistant-watch-params-panel the person's open Parameters panel during set_params: no wait, the new values shown, the changed rows flash, the panel stays open", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant parameters panel');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => {
    const w = window as unknown as WW;
    w.__CAD__.assistant.setPace('watch', 0);
    w.__CAD__.services.doc.addParam({ name: 'w', expr: '20 mm', quantity: 'length' });
  });
  await runCommand(frame, 'modify.parameters');
  const panel = frame.locator('[data-cad-panel="params"]');
  await expect(panel).toBeVisible();
  await recordShown(page, 'chip', '[data-chip="assistant"]', 'data-assistant-state');
  await recordShown(page, 'flash', '[data-cad-panel="params"] [data-param-changed]', 'data-param-row');
  const before = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__set_params', input: { set: [{ name: 'w', kind: 'length', expr: '30 mm', comment: '', rename_to: '' }, { name: 'h', kind: 'length', expr: 'w/2', comment: '', rename_to: '' }], remove: [] } }] }, { text: 'w and h are set.' });
  const t = await startTurn(request, host, { text: 'Set w and h.', tab });
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  expect(resultsIn(chats(host)[before + 1])[0]).toMatchObject({ tool: 'cad__set_params', ok: true, data: { params: [{ name: 'w', value: 30 }, { name: 'h', value: 15 }] } });
  // It never waited: the person's idle panel is no reason to.
  expect(await readRecord(page, 'chip')).not.toContain('waiting');
  // Still the person's panel, open, with the new values; the changed rows flashed.
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('data-panel-owner', /.+/);
  await expect(panel.locator('[data-param-row="w"] .nui[data-field="expr"] input')).toHaveValue('30 mm');
  await expect(panel.locator('[data-param-row="h"] .nui[data-field="expr"] input')).toHaveValue('w/2');
  expect(await readRecord(page, 'flash')).toContain('w');
});

test('cad:assistant-watch-camera the camera latch: a drag or a tree menu Normal to in the turn keeps the view where the person left it; with no move the sketch turns the view to its plane', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant camera latch');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.assistant.setPace('watch', 0));
  const chip = frame.locator('[data-chip="assistant"]');
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  const moves = () => cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.viewport.get().handle.userCameraMoves());
  const turns: [string, string, (() => Promise<void>) | null][] = [
    [
      'Front',
      'drag',
      async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 8 });
        await page.mouse.up();
      },
    ],
    [
      'Right',
      'menu',
      async () => {
        await frame.locator('[data-tree-node="origin:top"] > .tree-row').click({ button: 'right' });
        await frame.locator('[data-menu-item="normal-to"]').click();
      },
    ],
    // The view looks down -Z now (turn 2's Normal to on Top): Front's sketch must turn it.
    ['Front', 'none', null],
  ];
  /** Where the camera looks (a unit vector). */
  const facing = (c: { position: number[]; target: number[] }) => {
    const d = c.target.map((v, i) => v - c.position[i]);
    const n = Math.hypot(...d);
    return d.map((v) => v / n);
  };
  for (const [i, [on, how, look]] of turns.entries()) {
    host.fake.reply({ hold: `look-${how}`, tools: [sketchOf(`Turn ${i + 1} on ${on}`, on)] }, { text: 'Sketched.' });
    const t = await startTurn(request, host, { text: `Sketch on ${on}.`, tab });
    await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
    const m0 = await moves();
    if (look) {
      await look();
      await expect.poll(moves, STEP).toBeGreaterThan(m0);
    }
    const seen = await cameraNow(page);
    host.fake.release(`look-${how}`);
    expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
    const after = await cameraNow(page);
    if (look) {
      // Latched: the sketch's entry left the view where the person put it.
      expect(after, `${how}: the camera stays`).toEqual(seen);
    } else {
      // No move in the turn: the view turned from where it was (down -Z, the person's Normal to
      // on Top in turn 2) to look straight at Front (along +Y).
      expect(facing(seen)[2], 'the view faced Top before the turn').toBeLessThan(-0.999);
      expect(after, 'the sketch turned the view').not.toEqual(seen);
      expect(facing(after)[1]).toBeGreaterThan(0.999);
    }
  }
});

test("cad:assistant-watch-camera-big a view button in the turn latches it: the Assistant's sketch far past the view leaves the camera where the person put it, through Finish sketch", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant camera big sketch');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.assistant.setPace('watch', 0));
  const chip = frame.locator('[data-chip="assistant"]');
  const moves = () => cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.services.viewport.get().handle.userCameraMoves());
  // A 2 m x 1.5 m plate on Front: far past the view of an empty Part.
  const big = { name: 'cad__sketch', input: { edit: '', name: 'Big plate', on: 'Front', entities: [SE('r', 'center_rect', [0, 0, 2000, 1500])], constraints: [SC('c0', 'coincident', ['r.center', 'origin'])], infer: false } };
  host.fake.reply({ hold: 'look-view-big', tools: [big] }, { text: 'Sketched.' });
  const t = await startTurn(request, host, { text: 'Sketch a big plate on Front.', tab });
  await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
  // The person picks the Front view from the view menu: a framing of theirs (the view stays framed).
  const m0 = await moves();
  await frame.locator('[data-vp-opens="views"]').click();
  await frame.locator('[data-view="front"]').click();
  await expect.poll(moves, STEP).toBeGreaterThan(m0);
  const seen = await cameraNow(page);
  // When sketch mode ends, in the page's clock (bind.ts refits 60 ms after it, once the view is still).
  await cadFrame(page).evaluate(() => {
    const w = window as unknown as { __sketchEnd?: number | null; __CAD__: { services: { mode: { get(): { mode: string }; subscribe(fn: (m: { mode: string }) => void): () => void } } } };
    const mode = w.__CAD__.services.mode;
    let was = mode.get().mode;
    w.__sketchEnd = null;
    mode.subscribe((m) => {
      if (was === 'sketch' && m.mode !== 'sketch') w.__sketchEnd = performance.now();
      was = m.mode;
    });
  });
  host.fake.release('look-view-big');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  await expect(watchHistory(frame)).toHaveText([/Big plate$/], STEP);
  // Past the moment the refit after Finish sketch would run (60 ms after, the view not animating: 400 ms is ample).
  await expect
    .poll(() => cadFrame(page).evaluate(() => {
      const end = (window as unknown as { __sketchEnd?: number | null }).__sketchEnd;
      return typeof end === 'number' && performance.now() - end > 400;
    }), STEP)
    .toBe(true);
  expect(await cameraNow(page), 'the camera stays where the view button put it').toEqual(seen);
});

test("cad:assistant-watch-chip-end the chip after the turn: Undo is one Ctrl+Z of the request; the Part's health names an under-defined sketch, then a failing fillet (a click selects its row)", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant chip at the end');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as WW).__CAD__.assistant.setPace('fast', 0));
  const chip = frame.locator('[data-chip="assistant"]');
  const label0 = await undoNow(page);
  // Undo: the request's group, as one Ctrl+Z.
  host.fake.reply({ tools: [SETP('a', '3 mm')] }, { tools: [SETP('b', '4 mm')] }, { text: 'a and b.' });
  const t1 = await startTurn(request, host, { text: 'Add a and b.', tab });
  expect((await t1.ended(STEP_MS * 2)).turn.state).toBe('done');
  await expect(chip).toHaveAttribute('data-assistant-state', 'ended', STEP);
  await expect(chip).toHaveAttribute('data-assistant-health', 'ok');
  await chipButton(frame, 'undo').click();
  await expect.poll(() => paramsNow(page), STEP).toEqual([]);
  expect(await undoNow(page)).toBe(label0);
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { redo(): void } } } }).__CAD__.services.doc.redo());
  expect(await paramsNow(page)).toEqual(['a', 'b']);
  // A sketch left with dof 2: amber, "1 sketch under-defined".
  host.fake.reply({ tools: [sketchOf('Loose', 'Top', [SC('c0', 'coincident', ['r.center', 'origin'])])] }, { text: 'The sketch still moves.' });
  const t2 = await startTurn(request, host, { text: 'A loose sketch.', tab });
  expect((await t2.ended(STEP_MS * 2)).turn.state).toBe('done');
  await expect(chip).toHaveAttribute('data-assistant-health', 'warn', STEP);
  await expect(chip.locator('[data-assistant-health-text]')).toHaveText('· 1 sketch under-defined');
  await expect(chipWords(frame)).toHaveText('Assistant: A loose sketch. · done');

  // Then a failing fillet of the person's: red, "Fillet 1 fails" first, and a click on it selects its tree row.
  const f2 = frame;
  const tab2 = tab;
  const made = await addSolid(page, { size: [40, 30, 6] });
  await cadFrame(page).evaluate(
    ({ extrude, body }) => {
      const doc = (window as unknown as WW).__CAD__.services.doc;
      const ref = { name: `F:${extrude}:end`, signature: { kind: 'face', type: 'plane', at: [20, 15, 6], dir: [0, 0, 1] } };
      doc.beginNew('fillet', { body, edges: [], faces: [ref], radius: '50 mm' }).commit();
    },
    { extrude: made.extrude, body: made.body },
  );
  await expect(f2.locator('[data-cad-tree] [data-feature-row][data-state="error"]')).toHaveCount(1, { timeout: STEP_MS * 2 });
  host.fake.reply({ tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '' } }] }, { text: 'Fillet 1 fails: its radius is too large.' });
  const t3 = await startTurn(request, host, { text: 'Check the part.', tab: tab2 });
  expect((await t3.ended(STEP_MS * 2)).turn.state).toBe('done');
  const chip2 = f2.locator('[data-chip="assistant"]');
  await expect(chip2).toHaveAttribute('data-assistant-health', 'error', STEP);
  await expect(chip2.locator('[data-assistant-health-text]')).toHaveText('· Fillet 1 fails · 1 sketch under-defined');
  // A read made no group: no Undo.
  await expect(chipButton(f2, 'undo')).toHaveCount(0);
  await chip2.locator('[data-assistant-health-text]').click();
  await expect(f2.locator('[data-cad-tree] [data-feature-row]').filter({ has: f2.locator('> .tree-row .tl', { hasText: /^Fillet 1$/ }) })).toHaveAttribute('aria-selected', 'true');
});

// ---- The guide and help (T13): help's worked plate as the model reads it and sends it back

test("cad:assistant-watch-help help's worked plate reaches the model whole, and its calls sent as they read build the plate: the person's tree, the volume chip, one Undo", async ({ page, request }) => {
  test.setTimeout(300_000);
  const pid = await newProject(request, host, 'Assistant help plate');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  const plate = WORKED_PARTS.find((p) => p.topic === 'example_plate')!;
  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__help', input: { topic: 'guide' } }, { name: 'cad__help', input: { topic: 'example_plate' } }] },
    // The model sends every call of the worked part, each input as the help reply gave it.
    (body: unknown) => {
      const rows = (resultsIn(body)[1].data!.rows as { tool?: string; input?: Record<string, unknown> }[]).filter((r) => r.tool);
      return { tools: rows.map((r) => ({ name: `cad__${r.tool}`, input: r.input })) };
    },
    { text: 'The plate from help is built.' },
  );
  const t = await startTurn(request, host, { text: 'Build the plate from help.', tab });
  expect((await t.ended(STEP_MS * 4)).turn.state).toBe('done');
  const [, afterHelp, afterBuild] = chats(host).slice(before);
  const [guide, example] = resultsIn(afterHelp);
  // help guide is the CAD notes (the app sends its line breaks as spaces), nothing cut.
  expect(guide).toMatchObject({ tool: 'cad__help', ok: true, text: 'help guide: 10 rows' });
  expect(guide).not.toHaveProperty('truncated');
  expect((guide.data!.rows as { text: string }[]).map((r) => r.text).join(' ')).toBe(GUIDE.replace(/\s+/g, ' '));
  // help example_plate reached the model whole: every call's input as the worked part has it (a
  // sketch's at lists too, 7 deep in the data), nothing cut or turned null.
  expect(example).toMatchObject({ tool: 'cad__help', ok: true, text: `help example_plate: ${plate.calls.length + 2} rows` });
  expect(example).not.toHaveProperty('truncated');
  const rows = example.data!.rows as { about: string; tool?: string; input?: unknown; result?: unknown }[];
  expect(rows.filter((r) => r.tool).map(({ tool, input, result }) => ({ tool, input, result }))).toEqual(plate.calls.map(({ tool, input, result }) => ({ tool, input, result })));
  // Each call answered as help says it does: ok, the same line.
  expect(resultsIn(afterBuild).map((r) => ({ tool: r.tool, ok: r.ok, text: r.text }))).toEqual(plate.calls.map((c) => ({ tool: `cad__${c.tool}`, ok: true, text: c.result.text })));
  // What the person sees: the tree with every sketch fully defined (no "(-)"), the volume chip, the chip done.
  await expect(watchHistory(frame)).toHaveText(PLATE_TREE, STEP);
  await expect.poll(async () => Math.abs((await singleVolume(frame)) - PLATE_MM3), STEP).toBeLessThan(0.5);
  await expect(chipWords(frame)).toHaveText('Assistant: Build the plate from help. · done', STEP);
  await expect(frame.locator('[data-chip="assistant"]')).toHaveAttribute('data-assistant-health', 'ok');
  // The whole request is one Undo.
  await chipButton(frame, 'undo').click();
  await expect(watchHistory(frame)).toHaveCount(0, STEP);
  expect(await paramsNow(page)).toEqual([]);
});

// ---- A picture after every edit (pictures.ts): the model's next request carries it; the chip's Pictures turns it off.

type PicsWindow = Cad & { __CAD__: { services: { apis: { get(): { assistant: { actions: { setPictures(v: string): void } } } }; bridge: { prefs: { get(k: string): Promise<unknown> } } } } };

test("cad:assistant-watch-pictures each edit's result carries one iso picture of the Part in the model's next request; the chip's Pictures turns them off and on", async ({ page, request }) => {
  test.setTimeout(300_000);
  const pid = await newProject(request, host, 'Assistant pictures');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  const chip = frame.locator('[data-chip="assistant"]');
  try {
    const from = chats(host).length;
    host.fake.reply(
      { tools: [sketchOf('Plate sketch', 'Top')] },
      { tools: [{ name: 'cad__extrude', input: { edit: '', name: 'Plate', sketch: 'Plate sketch', regions: ['all'], face: '', direction: '', extent: 'blind', distance: '6 mm', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '' } }] },
      { tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '' } }] },
      { text: 'The plate is made.' },
    );
    const t = await startTurn(request, host, { text: 'A plate.', tab });
    expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
    const [, afterSketch, afterExtrude, afterRead] = chats(host).slice(from);
    // The sketch's result: one picture (no body yet: the sketch framed), its line in data.
    const [sketch] = resultsIn(afterSketch);
    expect(sketch).toMatchObject({ tool: 'cad__sketch', ok: true, data: { picture: expect.stringMatching(/^Picture: iso view of the Part framed on the shown sketches/) } });
    expect(sketch.images).toHaveLength(1);
    // The extrude's: one 640 x 480 PNG with the plate in it (coarse: a software renderer draws it on CI).
    const [extrude] = resultsIn(afterExtrude);
    expect(extrude).toMatchObject({ tool: 'cad__extrude', ok: true, data: { picture: expect.stringMatching(/^Picture: iso view of the Part framed on all 1 shown body, 640x480/) } });
    expect(extrude.images).toHaveLength(1);
    const pic = imageOf(extrude.images[0]);
    expect(pic.type).toBe('image/png');
    expect([pic.img.width, pic.img.height]).toEqual([640, 480]);
    expect(tileSeen(pic.img, 0, 0, 640, 480).drawn, 'the plate in the picture').toBeGreaterThan(0.02);
    // A read carries none.
    const [read] = resultsIn(afterRead);
    expect(read).toMatchObject({ tool: 'cad__get_model', ok: true });
    expect(read.images).toEqual([]);
    expect(read.data).not.toHaveProperty('picture');
    // The page's ledger counts them (the eval's record adds them up).
    const ledger = await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { calls: { tool: string; images?: number }[] } } }).__CAD__.assistant.calls.slice(-3).map((c) => [c.tool, c.images ?? 0]));
    expect(ledger).toEqual([
      ['sketch', 1],
      ['extrude', 1],
      ['get_model', 0],
    ]);

    // The chip's Pictures (on, pressed): the person turns it off while the model thinks; the next edit carries none.
    const from2 = chats(host).length;
    host.fake.reply({ hold: 'pics-off', tools: [SETP('w', '30 mm')] }, { text: 'w is set.' });
    const t2 = await startTurn(request, host, { text: 'Set w.', tab });
    await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
    await expect(chip).toHaveAttribute('data-assistant-pictures', 'each');
    await expect(chipButton(frame, 'pictures')).toHaveAttribute('aria-pressed', 'true');
    await chipButton(frame, 'pictures').click();
    await expect(chip).toHaveAttribute('data-assistant-pictures', 'off', STEP);
    await expect(chipButton(frame, 'pictures')).toHaveAttribute('aria-pressed', 'false');
    // The person's choice is kept for the plugin (ws.prefs).
    await expect.poll(() => cadFrame(page).evaluate(() => (window as unknown as PicsWindow).__CAD__.services.bridge.prefs.get('assistant.pictures')), STEP).toBe('off');
    host.fake.release('pics-off');
    expect((await t2.ended(STEP_MS * 2)).turn.state).toBe('done');
    const [setp] = resultsIn(chats(host).slice(from2)[1]);
    expect(setp).toMatchObject({ tool: 'cad__set_params', ok: true });
    expect(setp.images).toEqual([]);
    expect(setp.data).not.toHaveProperty('picture');

    // On again: the next edit carries its picture.
    const from3 = chats(host).length;
    host.fake.reply({ hold: 'pics-on', tools: [SETP('w', '32 mm')] }, { text: 'w is set again.' });
    const t3 = await startTurn(request, host, { text: 'Set w again.', tab });
    await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
    await chipButton(frame, 'pictures').click();
    await expect(chip).toHaveAttribute('data-assistant-pictures', 'each', STEP);
    host.fake.release('pics-on');
    expect((await t3.ended(STEP_MS * 2)).turn.state).toBe('done');
    const [again] = resultsIn(chats(host).slice(from3)[1]);
    expect(again).toMatchObject({ tool: 'cad__set_params', ok: true, data: { picture: expect.stringMatching(/^Picture: iso view/) } });
    expect(again.images).toHaveLength(1);
  } finally {
    // The person's choice back to the default for the tests after this one.
    await cadFrame(page)
      .evaluate(() => (window as unknown as PicsWindow).__CAD__.services.apis.get().assistant.actions.setPictures('each'))
      .catch(() => undefined);
  }
});
