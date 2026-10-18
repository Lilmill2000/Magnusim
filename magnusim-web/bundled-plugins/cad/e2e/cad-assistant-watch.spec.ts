// The Part's tools for the app's Assistant, as the person and the model meet them (CAD tools spec
// §12.3 watch 1, T1): a Part open in its workspace offers its 18 tools on its tab; a turn there
// offers 21 (the app's 3 first, then the Part's by name), the first 20 strict and cad__view not;
// the system text holds the CAD notes; the tools go out byte for byte the same in the next turn.
// get_model answers the model with the Part in data; a tool not in this build answers not_ready
// "not in this build yet" with its hint. The dock's chip and the frame's data-assistant say what
// the Assistant does: thinking while the model answers, working while a call runs ("Read the
// Part"), then "Assistant: <request> · done".
// view's handles (the S2 integration): a picture's #f1 is the face find reads as #f1, and its #b1
// renames the block through body, as the person's tree shows.
// measure (watch 6, T10): the chip says "Measure" while it runs; the model gets a block's volume
// and no voids, two separate blocks' distance, no overlap and two solids joined, a cut's area, and
// a face by its label (find's selectors); the turn's log reads each measurement; nothing in the
// Part changes.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { HINTS } from '../src/assistant/errors';
import { GUIDE } from '../src/assistant/guide';
import {
  cadFrame,
  chats,
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
import { addSolid, countFileWrites, fileWrites } from './helpers';
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

/** The Part's 18 tools by name, as the app names them (src/assistant/schemas.ts). */
const CAD = ['body', 'combine', 'delete', 'edit_feature', 'extrude', 'find', 'get_model', 'help', 'hole', 'measure', 'modify', 'pattern', 'revolve', 'set_params', 'sketch', 'sweep_loft', 'undo', 'view'].map((n) => `cad__${n}`);
const HOST_TOOLS = ['app_status', 'explain_ready', 'project_summary'];

test('cad:assistant-watch-registration the Part offers its 18 tools; a turn offers 21, the first 20 strict, with the CAD notes, the same bytes every turn', async ({ page, request }) => {
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
  // The app's own tools first (by name), then the Part's by name: 21, the first 20 strict.
  expect(offeredTools(first)).toEqual([...HOST_TOOLS, ...CAD].map((name) => ({ name, strict: name !== 'cad__view' })));
  // The CAD notes are the second system block, line breaks kept.
  const system = (first.body.system as { text: string }[]).map((s) => s.text).join('\n');
  expect(system).toContain(GUIDE);
  // The same tools, byte for byte, in the next turn (one registration for the page's life).
  expect(JSON.stringify(second.body.tools)).toBe(JSON.stringify(first.body.tools));
});

test("cad:assistant-watch-get-model get_model reads the Part to the model; a tool not in this build says so; the chip and data-assistant follow the turn", async ({ page, request }) => {
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
    { tools: [{ name: 'cad__sweep_loft', input: { edit: '', name: '', kind: 'sweep', profiles: ['Sketch 1'], path: 'Sketch 2', orientation: 'follow', ruled: false, op: 'new', bodies: [], body_name: '', color: '' } }] },
    { text: 'The Part is empty, and I cannot drill yet.' },
  );
  // The read stops where the Part has settled, so the chip is seen working.
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { hold(p: string): void } } }).__CAD__.assistant.hold('after-settled'));
  const t = await startTurn(request, host, { text: 'Read the Part, then drill a hole.', tab });
  await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
  await expect(chip).toHaveText(/^Assistant · thinking · \d+ of 120 steps$/, STEP);
  await expect(app).toHaveAttribute('data-assistant', 'thinking');
  host.fake.release('think');
  await expect(chip).toHaveAttribute('data-assistant-state', 'working', STEP);
  await expect(chip).toHaveText(/^Assistant · Read the Part · \d+ of 120 steps$/);
  await expect(app).toHaveAttribute('data-assistant', 'working');
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { release(p: string): void } } }).__CAD__.assistant.release('after-settled'));
  const { turn } = await t.ended(STEP_MS * 2);
  expect(turn.state).toBe('done');
  await expect(chip).toHaveAttribute('data-assistant-state', 'ended', STEP);
  await expect(chip).toHaveText('Assistant: Read the Part, then drill a hole. · done');
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
    tool: 'cad__sweep_loft',
    ok: false,
    error: { code: 'not_ready', message: 'not_built: sweep_loft is not in this build yet.', hint: 'This tool is not in this build yet: use the tools that answer, and tell the person what is missing.', detail: { reason: 'not_built', tool: 'sweep_loft' } },
  });
  // The page's ledger: what the eval counts.
  const calls = await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { assistant: { calls: { tool: string; ok: boolean; reason?: string; key: string }[] } } }).__CAD__.assistant.calls.map((c) => ({ tool: c.tool, ok: c.ok, reason: c.reason ?? null, key: c.key })));
  expect(calls).toEqual([
    { tool: 'get_model', ok: true, reason: null, key: `turn:${t.id}` },
    { tool: 'sweep_loft', ok: false, reason: 'not_built', key: `turn:${t.id}` },
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
  await expect(chip).toHaveText(/^Assistant · Measure · \d+ of 120 steps$/);
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
  await expect(chip).toHaveText('Assistant: Measure the blocks. · done', STEP);
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
