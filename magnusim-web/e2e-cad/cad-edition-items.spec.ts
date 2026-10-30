// Magnusim CAD hides every project and simulation item of a Part (the host's welcome says
// projectLinks false; in Magnusim each of them is there:
// bundled-plugins/cad/e2e/cad-magnusim-project-items.spec.ts). Here, on the real CAD-edition host,
// as a person meets them:
//   - a new Part: no CFD PREP group and no Enclosure on the toolbar, in its menus or among the
//     Part's commands; the Banana's tooltip says nothing of a simulation; a body's menu has no
//     simulation item and a hidden body no simulation mark; Settings → Keybinds lists every
//     command of the Part but the Enclosure;
//   - the Assistant there is told of none of it: the Part's 22 tools, the workspace's notes and
//     every help topic, as the model gets them (a scripted model behind Settings → Assistant's
//     local server, e2e/support/fake-llm.mjs: nothing leaves this PC);
//   - a Part with an Enclosure made in Magnusim (its model file copied in, as a person copying
//     the project does) still builds its body and shows it read-only; a Combine on its body leaves
//     Keep the tool bodies off; the volume chip lists the biggest bodies; and the Assistant's
//     edit_feature refuses its values with the panel's words while rename, move and suppress work;
//   - a Part whose model file came without its imported STEP says the file "is not with the Part
//     any more" (Magnusim: "in the project"), and its import (brought in by Edit in CAD) has no
//     "From the project" row.
// Settings → Assistant goes back to a new install's (Off) after each test that sets it, even one
// cut short by its time limit; the one thing the settings cannot put back (the local server's
// model id) goes when the test server starts again, as it empties the Assistant's home
// (e2e-cad/server.mjs).
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from './pw';
import { addSolid, baseUrl, historyNames, partOpened, runCommand, watchPage, workspaceFrame } from '../bundled-plugins/cad/e2e/helpers';
// @ts-expect-error the app's Assistant helpers are plain JavaScript
import * as core from '../e2e/support/assistant.js';
// @ts-expect-error the app's scripted model is plain JavaScript
import { startFakeLlm } from '../e2e/support/fake-llm.mjs';

// The helpers assert with this suite's Playwright (a second copy would refuse to load).
core.setExpect(expect);

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a person or a model could read of a simulation or the Enclosure. */
const PROJECT_WORDS = /simulation|enclosure|CFD|fluid|air volume/i;

/** What Magnusim CAD's panel of an Enclosure made in Magnusim says (src/features/enclosure/kept.ts). */
const KEPT_WORDS = 'An Enclosure is changed in Magnusim. Here it stays as it is, with its body: suppress or delete it to take the body away.';

/** The Part's tools, as Magnusim offers them too. */
const PART_TOOLS = ['body', 'check', 'combine', 'construct', 'delete', 'direct', 'edit_feature', 'extrude', 'find', 'get_model', 'help', 'hole', 'measure', 'modify', 'pattern', 'revolve', 'set_params', 'sketch', 'sweep_loft', 'undo', 'view', 'workspace'];

type Schema = { enum?: string[] };
type ToolDef = { name: string; title?: string; description: string; inputSchema: { properties: Record<string, Schema> } };
type Cad = {
  __CAD__: {
    services: { commands: { get(id: string): { hint?: string } | undefined; toolbar(mode: string): { group: string; commands: { id: string }[] }[] } };
    keybinds: { model: { entries(): readonly { id: string }[] } };
    assistant: { registered: ToolDef[]; setReview(on: boolean): Promise<{ available: boolean }>; setPace(p: 'fast' | 'watch' | null, scale?: number | null): void } | null;
  };
};

type Chat = { kind: string; body: { messages: { role: string; content: unknown }[]; tools?: { function: Record<string, unknown> & { name: string } }[] } };
type Result = { tool: string; ok: boolean; data?: { topic?: string; rows?: { about: string }[] } & Record<string, unknown>; error?: { code: string; message: string } };
interface FakeModel {
  reply(...steps: unknown[]): void;
  requests(): Chat[];
  pending(): number;
  models(list: ({ id: string; context?: number; type?: string } | string)[], dialect?: string): void;
  stop(): Promise<void>;
}

/** A project with one Part, made as Home's New project and the project page's New part make them. */
async function projectWithPart(request: APIRequestContext, title: string, part: string): Promise<{ pid: string; sid: string }> {
  const made = await request.post('/api/project', { data: { title, category: 'Other', units: 'Metric' } });
  expect(made.ok()).toBe(true);
  const pid = String((await made.json()).id);
  const st = await request.post('/api/plugin-studies/create', { data: { project_id: pid, plugin: 'cad', kind: 'part', title: part } });
  expect(st.ok()).toBe(true);
  return { pid, sid: String((await st.json()).study.id) };
}

/** The project's page, and the Part opened from there: its frame once its document is read. */
async function openPart(page: Page, pid: string, part: string): Promise<FrameLocator> {
  await page.goto(`/#/p/${pid}`);
  await page.locator('#cad-project .cad-part-open', { hasText: part }).click();
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  return frame;
}

/** The tree's Bodies folder open. */
async function bodiesOpen(frame: FrameLocator): Promise<void> {
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
}

const cad = (page: Page) => workspaceFrame(page);

/** A Part's model file in the test server's projects folder (playwright.cad.config.js MAGNUSIM_PROJECTS_ROOT). */
const modelFile = (pid: string, sid: string) => join(WEB, 'e2e', `.tmp-projects-cad-${new URL(baseUrl()).port}`, pid, 'plugins', 'cad', 'studies', sid, 'model.json');

/** Settings → Assistant as a new install has it (scripts/server/assistant/settings.ts DEFAULTS): Off, Ask, this PC's own server address. */
const ASSISTANT_DEFAULTS = { provider: 'off', privacy: 'ask', base_url: 'http://127.0.0.1:1234/v1' };

/** The running test's scripted model, from the moment Settings → Assistant may point at it. */
let scripted: FakeModel | null = null;

// Settings → Assistant back to a new install's after a test that set it, even after a timeout (a
// finally would not run then: the request is closed by then): the window closed first, so no turn
// of it asks the model again. Not the settings as they were before: a test cut short would leave
// its own for the next run to take as "before".
test.afterEach(async ({ page, request }) => {
  const fake = scripted;
  scripted = null;
  if (!fake) return;
  await page.close();
  try {
    const r = await request.post('/api/assistant/settings', { data: ASSISTANT_DEFAULTS });
    expect(r.ok(), 'Settings → Assistant back to Off').toBe(true);
    const status = (await (await request.get('/api/assistant/status')).json()) as { provider: string; privacy: string; base_url: string };
    expect({ provider: status.provider, privacy: status.privacy, base_url: status.base_url }).toEqual(ASSISTANT_DEFAULTS);
  } finally {
    await fake.stop();
  }
});

/**
 * Settings → Assistant pointed at a local server that is the scripted model, with room for every
 * tool (its model row says a 128K context). The afterEach above puts Off back.
 */
async function scriptedModel(request: APIRequestContext): Promise<{ fake: FakeModel; chats(): Chat[] }> {
  const fake = (await startFakeLlm()) as FakeModel;
  scripted = fake;
  const local = (await core.useScriptedModel(request, baseUrl(), fake, 'local')) as { model: string };
  fake.models([{ id: local.model, context: 131_072, type: 'llm' }], 'compat');
  return { fake, chats: () => fake.requests().filter((r) => r.kind === 'chat') };
}

/** The Part's tools the app's server offers on this page's tab (GET /api/assistant/tabs). */
async function tabTools(request: APIRequestContext, tab: string): Promise<string[]> {
  const j = (await (await request.get('/api/assistant/tabs')).json()) as { tabs: { tab: string; tools: string[] }[] };
  return (j.tabs.find((t) => t.tab === tab)?.tools ?? []).filter((n) => n.startsWith('cad__')).sort();
}

test("a new Part in Magnusim CAD shows no CFD PREP and no Enclosure, the Banana's tip has no simulation, a body none, and Settings lists no Enclosure key", async ({ page, request }) => {
  const seen = await watchPage(page);
  const { pid } = await projectWithPart(request, 'Edition items', 'Part 1');
  const frame = await openPart(page, pid, 'Part 1');
  await addSolid(page, { size: [20, 20, 20] });

  // The toolbar: its groups are there, CFD PREP is not, and no control in the Part has the Enclosure.
  const toolbar = frame.locator('[data-cad-toolbar]');
  await expect(toolbar.locator('.tb-btn[data-command="solid.extrude"]')).toBeVisible();
  await expect(toolbar.locator('.tb-btn[data-command="modify.combine"]')).toBeVisible();
  const groups = await toolbar.locator('.tb-group-label').allTextContents();
  expect(groups).toEqual(expect.arrayContaining(['SOLID', 'MODIFY']));
  expect(groups).not.toContain('CFD PREP');
  await expect(toolbar.locator('.tb-group[data-group="solid"]')).toHaveCount(1);
  await expect(toolbar.locator('[data-group="cfd"]')).toHaveCount(0);
  await expect(frame.locator('[data-command="cfd.enclosure"]')).toHaveCount(0);
  // Nor what the toolbar is drawn from (its buttons, flyouts and More menus), nor the Part's
  // commands and keys (Set keybind, the Assistant's keybind_get).
  const part = await cad(page).evaluate(() => {
    const c = (window as unknown as Cad).__CAD__;
    const bar = c.services.commands.toolbar('model');
    return {
      groups: bar.map((g) => g.group),
      commands: bar.flatMap((g) => g.commands.map((x) => x.id)),
      enclosure: !!c.services.commands.get('cfd.enclosure'),
      banana: c.services.commands.get('scale.banana')?.hint ?? null,
      keys: c.keybinds.model.entries().map((e) => e.id),
    };
  });
  expect(part.groups).toEqual(expect.arrayContaining(['solid', 'modify', 'inspect', 'scale']));
  expect(part.groups).not.toContain('cfd');
  expect(part.commands).toEqual(expect.arrayContaining(['solid.extrude', 'modify.combine', 'scale.banana']));
  expect(part.commands).not.toContain('cfd.enclosure');
  expect(part.enclosure).toBe(false);
  expect(part.keys).toEqual(expect.arrayContaining(['sketch.rectangle', 'modify.combine', 'inspect.measure']));
  expect(part.keys).not.toContain('cfd.enclosure');

  // The Banana's tooltip: what it is, and no word of a simulation.
  expect(part.banana).toBe("Show a banana for scale. It's not part of the model");
  await toolbar.locator('.tb-btn[data-command="scale.banana"]').hover();
  const tip = frame.locator('[data-cad-tip]');
  await expect(tip).toContainText("Show a banana for scale. It's not part of the model");
  await expect(tip).not.toContainText(/simulation/i);
  await page.mouse.move(0, 0);

  // Its body: hidden with its eye, no mark of a simulation it would be left out of; its menu
  // has its own items and no simulation item (cad-app.spec.ts reads the menu's last item).
  await bodiesOpen(frame);
  const body = frame.locator('[data-cad-tree] [data-body-row]');
  await expect(body.locator('.cad-body-name')).toHaveText(['Body 1']);
  await body.locator('[data-body-act="visibility"]').click();
  await expect(body).toHaveAttribute('data-visible', '0');
  await expect(body).not.toHaveAttribute('data-hidden-in-simulation');
  await expect(body).not.toHaveAttribute('data-in-simulation');
  await body.locator('[data-body-act="visibility"]').click();
  await expect(body).toHaveAttribute('data-visible', '1');
  await body.locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu.locator('[data-menu-item="body-delete"]')).toHaveText('Delete Body 1');
  const items = await menu.locator('[data-menu-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-menu-item')));
  expect(items).toEqual(expect.arrayContaining(['body-visibility', 'body-rename', 'body-color', 'body-edit', 'body-delete']));
  expect(items).not.toContain('body-simulation');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Part 1']);

  // Settings → Keybinds: every command of the Part's commands file but the Enclosure, which the
  // file marks "projects": true (Magnusim lists it under CFD prep).
  const file = JSON.parse(readFileSync(join(WEB, 'bundled-plugins', 'cad', 'workspace', 'commands.json'), 'utf8')) as { commands: { id: string; projects?: boolean }[] };
  expect(file.commands.find((c) => c.id === 'cfd.enclosure')?.projects).toBe(true);
  const listed = file.commands.filter((c) => !c.projects).map((c) => c.id);
  await page.goto('/');
  await page.locator('#home-prefs').click();
  await page.locator('#wiz-rail li[data-wiz-key="keybinds"]').click();
  const keys = page.locator('#setup-wizard .wiz-pane[data-wiz-key="keybinds"] [data-keys-plugin="cad"] [data-keys-workspace="part"]');
  await expect(keys.locator('[data-keybind="sketch.rectangle"]')).toBeVisible({ timeout: 30_000 });
  await expect(keys.locator('[data-keybind="inspect.measure"]')).toBeVisible();
  await expect(keys.locator('[data-keybind="scale.banana"]')).toBeVisible();
  await expect(keys.locator('[data-keybind="cfd.enclosure"]')).toHaveCount(0);
  const rows = await keys.locator('[data-keybind]').evaluateAll((els) => els.map((e) => e.getAttribute('data-keybind') ?? ''));
  expect(rows.sort()).toEqual([...listed].sort());
  const titles = await keys.locator('.wiz-keys-group-title').allTextContents();
  expect(titles).toEqual(expect.arrayContaining(['Modify', 'Inspect', 'Scale models']));
  expect(titles).not.toContain('CFD prep');
  await page.locator('#wiz-close').click();

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('the Assistant in a Magnusim CAD Part is told of none of it: its tools, the workspace notes and every help topic', async ({ page, request }) => {
  test.setTimeout(240_000);
  const seen = await watchPage(page);
  const tabOf = core.trackTab(page) as () => string;
  const { pid } = await projectWithPart(request, 'Assistant here', 'Part 1');
  await openPart(page, pid, 'Part 1');
  const model = await scriptedModel(request);

  // The Part's tools as it registered them, whole: the workspace tool without send_to_simulation,
  // the direct tool without the enclosure kind or its fields, the body tool without its
  // simulation field, and not one word of a simulation or the Enclosure in any of them.
  await expect.poll(() => cad(page).evaluate(() => (window as unknown as Cad).__CAD__.assistant?.registered.length ?? 0), { timeout: 30_000 }).toBe(22);
  const tools = await cad(page).evaluate(() => (window as unknown as Cad).__CAD__.assistant!.registered);
  expect(tools.map((t) => t.name)).toEqual(PART_TOOLS);
  const tool = (n: string) => tools.find((t) => t.name === n)!;
  const actions = tool('workspace').inputSchema.properties.action.enum!;
  expect(actions).toHaveLength(39);
  expect(actions).toEqual(expect.arrayContaining(['roll_back_to', 'see_through', 'opaque']));
  expect(actions).not.toContain('send_to_simulation');
  expect(tool('direct').inputSchema.properties.kind.enum).toEqual(['press_pull', 'delete_faces', 'split', 'delete_body', 'move_body', 'repair', 'retry']);
  expect(Object.keys(tool('direct').inputSchema.properties)).toEqual(['edit', 'name', 'kind', 'faces', 'distance', 'bodies', 'tool', 'keep_tool', 'move', 'turn', 'copy']);
  expect(Object.keys(tool('body').inputSchema.properties)).toEqual(['body', 'rename_to', 'color', 'visibility']);
  expect(tools.filter((t) => PROJECT_WORDS.test(JSON.stringify(t))).map((t) => t.name)).toEqual([]);

  // The app's server offers them on this page's tab.
  await expect.poll(tabOf).not.toBe('');
  await expect.poll(() => tabTools(request, tabOf()), { timeout: 30_000 }).toEqual(PART_TOOLS.map((n) => `cad__${n}`));

  // One turn that reads every help topic the help tool lists: the model's request carries the
  // Part's tools and the workspace notes, the next one the help rows.
  const topics = tool('help').inputSchema.properties.topic.enum!;
  expect(topics).toEqual(expect.arrayContaining(['features', 'details', 'errors', 'guide', 'workspace', 'selectors']));
  const from = model.chats().length;
  model.fake.reply({ tools: topics.map((topic) => ({ name: 'cad__help', input: { topic } })) }, { text: 'Read.' });
  const t = await core.startTurn(request, baseUrl(), { text: 'Read the CAD help.', tab: tabOf() });
  expect((await t.ended(60_000)).turn.state).toBe('done');
  const [ask, answered] = model.chats().slice(from);

  const offered = (ask.body.tools ?? []).map((x) => x.function).filter((f) => f.name.startsWith('cad__'));
  expect(offered.map((f) => f.name).sort()).toEqual(PART_TOOLS.map((n) => `cad__${n}`));
  expect(offered.filter((f) => PROJECT_WORDS.test(JSON.stringify(f))).map((f) => f.name)).toEqual([]);

  const system = ask.body.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const at = system.indexOf('Notes from the Magnusim CAD workspace');
  expect(at, 'the workspace notes are in the request').toBeGreaterThanOrEqual(0);
  const notes = system.slice(at);
  expect(notes).toContain('You edit the CAD Part the person has open.');
  expect(notes.match(new RegExp(PROJECT_WORDS.source, 'gi')) ?? []).toEqual([]);

  const results = core.resultsIn(answered) as Result[];
  expect(results.map((r) => [r.tool, r.ok, r.data?.topic])).toEqual(topics.map((topic) => ['cad__help', true, topic]));
  expect(results.every((r) => (r.data?.rows ?? []).length > 0)).toBe(true);
  // Every row of every topic, whole (a hit names its topic and row; checked last, below).
  const hits = results.flatMap((r) =>
    (r.data?.rows ?? []).flatMap((row) => {
      const m = JSON.stringify(row).match(new RegExp(PROJECT_WORDS.source, 'gi'));
      return m ? [`${r.data!.topic} / ${row.about}: ${[...new Set(m)].join(', ')}`] : [];
    }),
  );
  expect(model.fake.pending(), 'scripted answers left unused').toBe(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
  expect(hits, 'help rows that speak of a simulation or the Enclosure').toEqual([]);
});

/** The Part's bodies made earlier, apart on the Top plane: a 5 mm cube, three 20 mm blocks and a 10 mm block. */
const SOLIDS: { at: [number, number, number]; size: number[] }[] = [
  { at: [0, 0, 0], size: [5, 5, 5] },
  { at: [20, 0, 0], size: [20, 20, 20] },
  { at: [50, 0, 0], size: [20, 20, 20] },
  { at: [80, 0, 0], size: [20, 20, 20] },
  { at: [110, 0, 0], size: [10, 10, 10] },
];
const MADE = ['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2', 'Sketch 3', 'Extrude 3', 'Sketch 4', 'Extrude 4', 'Sketch 5', 'Extrude 5'];
/** The Enclosure Magnusim made and its body (ids as Magnusim makes them: a prefix and 12 base-36 characters). */
const ENC = 'f_0magnusimenc';
const ENC_BODY = 'b_0magnusimenc';

test('a Part with an Enclosure made in Magnusim opens read-only in Magnusim CAD and still builds; the Assistant may rename, move and suppress it but not change it', async ({ page, request }) => {
  test.setTimeout(300_000);
  const seen = await watchPage(page);
  const tabOf = core.trackTab(page) as () => string;
  const { pid, sid } = await projectWithPart(request, 'Duct from Magnusim', 'Duct');
  let frame = await openPart(page, pid, 'Duct');
  const bodies: string[] = [];
  for (const s of SOLIDS) bodies.push((await addSolid(page, s)).body!);
  // Closed: Back saved it and the Part is gone (it reads its file while it leaves).
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Duct']);

  // The Part's model file on disk, saved with its ten features. In Magnusim an Enclosure was then
  // added (CFD PREP, Enclosure, Body 1 picked, Fixed 1 mm): the file as Magnusim saves it, copied in.
  const path = modelFile(pid, sid);
  const stored = () => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { source_version?: number; saved_at: string; doc: { features: Record<string, unknown>[]; bodies: Record<string, unknown> } }) : null);
  await expect.poll(() => stored()?.doc.features.length ?? 0, { timeout: 30_000 }).toBe(10);
  const file = stored()!;
  file.doc.features.push({ id: ENC, type: 'enclosure', name: 'Enclosure 1', shape: 'box', axis: 'origin:z', bodies: [bodies[0]], padding: 'fixed', percent: '10', distance: '1 mm', sides: {}, creates: ENC_BODY });
  file.doc.bodies[ENC_BODY] = { name: 'Enclosure 1', color: '#d3e1f2' };
  file.source_version = (file.source_version ?? 0) + 1;
  file.saved_at = new Date().toISOString();
  writeFileSync(path, JSON.stringify(file));

  // Opened here, it builds: Enclosure 1 is in the history with no error, and its body in the tree.
  frame = await openPart(page, pid, 'Duct');
  const enc = frame.locator(`[data-cad-tree] [data-tree-node="${ENC}"]`);
  await expect(enc).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect(historyNames(frame)).toHaveText([...MADE, 'Enclosure 1']);
  await bodiesOpen(frame);
  await expect(frame.locator('[data-cad-tree] [data-body-row] .cad-body-name')).toHaveText(['Body 1', 'Body 2', 'Body 3', 'Body 4', 'Body 5', 'Enclosure 1']);
  await expect(frame.locator(`[data-cad-tree] [data-body-row="${ENC_BODY}"]`)).toHaveCount(1);

  // The volume chip with six bodies lists four: the biggest (the 10 mm block's 1,000 mm³ before
  // the Enclosure's 343 mm³), not the Enclosure first as Magnusim does.
  const chip = frame.locator('[data-chip="volume"]');
  await expect(chip.locator('[data-volume-list]')).toHaveAttribute('data-volume-list', '6', { timeout: 30_000 });
  await expect.poll(() => chip.locator('[data-volume-entry]').evaluateAll((els) => els.map((e) => e.getAttribute('data-volume-entry')))).toEqual(bodies.slice(1));

  // Its panel: shape, bodies and size, read-only, with why; no field, list or choice to change,
  // and no word of the fluid, the air or a simulation.
  await enc.locator('> .tree-row').dblclick();
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-feature-panel="enclosure"]')).toBeVisible();
  await expect(p.locator('[data-enclosure-readout="shape"]')).toHaveText('Box');
  await expect(p.locator('[data-enclosure-readout="bodies"]')).toHaveText('Body 1');
  await expect(p.locator('[data-enclosure-size]')).toHaveText('Size: 7 mm × 7 mm × 7 mm · 343 mm³');
  await expect(p.locator('[data-enclosure-kept]')).toHaveText(KEPT_WORDS);
  await expect(p.locator('[data-field-row="shape"]')).toHaveCount(1);
  await expect(p.locator('input, select, [data-pick-list]')).toHaveCount(0);
  await expect(p.locator('[data-field-row="padding"], [data-field="padding"]')).toHaveCount(0);
  await expect(p).not.toContainText(/fluid|\bair\b|simulation|Combine/i);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  await expect(historyNames(frame)).toHaveText([...MADE, 'Enclosure 1']);

  // A new Combine whose first target is the Enclosure's body: Keep the tool bodies stays off.
  await runCommand(frame, 'modify.combine');
  await expect(p.locator('[data-feature-panel="combine"]')).toBeVisible();
  await p.locator('[data-pick-list="targets"]').click();
  await frame.locator(`[data-cad-tree] [data-body-row="${ENC_BODY}"] > .tree-row`).click();
  await expect(p.locator('[data-pick-list="targets"]')).toContainText('Enclosure 1');
  await expect(p.locator('[data-switch="keep-tools"]')).toBeVisible();
  await expect(p.locator('[data-switch="keep-tools"] input')).not.toBeChecked();
  // Delete discards the new Combine.
  await p.locator('[data-panel-delete]').click();
  await expect(p).toHaveCount(0);
  await expect(historyNames(frame)).toHaveText([...MADE, 'Enclosure 1']);

  // The Assistant: edit_feature refuses the Enclosure's values with the panel's words; rename,
  // move and suppress work.
  await expect.poll(tabOf).not.toBe('');
  const model = await scriptedModel(request);
  await expect.poll(() => tabTools(request, tabOf()), { timeout: 30_000 }).toEqual(PART_TOOLS.map((n) => `cad__${n}`));
  // No review rounds (the turn ends with its own last answer) and no pauses between its steps.
  expect((await cad(page).evaluate(() => (window as unknown as Cad).__CAD__.assistant!.setReview(false))).available).toBe(true);
  await cad(page).evaluate(() => (window as unknown as Cad).__CAD__.assistant!.setPace('fast', 0));
  const edit = (input: Record<string, unknown>) => ({ tools: [{ name: 'cad__edit_feature', input: { feature: 'Enclosure 1', set: [], rename_to: '', suppress: 'keep', move: '', ...input } }] });
  const from = model.chats().length;
  model.fake.reply(
    edit({ set: [{ field: 'padding', value: 'zero' }] }),
    edit({ rename_to: 'Box around' }),
    edit({ feature: 'Box around', move: 'after Extrude 1' }),
    edit({ feature: 'Box around', suppress: 'suppress' }),
    { text: 'Its values stay as Magnusim made them; it is renamed, moved and suppressed.' },
  );
  const t = await core.startTurn(request, baseUrl(), { text: 'Give the enclosure no padding, then call it Box around, put it after Extrude 1 and suppress it.', tab: tabOf() });
  expect((await t.ended(120_000)).turn.state).toBe('done');
  const results = model
    .chats()
    .slice(from + 1)
    .map((r) => (core.resultsIn(r) as Result[])[0]);
  expect(results).toHaveLength(4);
  expect(results[0]).toMatchObject({ tool: 'cad__edit_feature', ok: false, error: { message: `bad_input: set: Enclosure 1: ${KEPT_WORDS} rename_to, suppress and move work.` } });
  expect(results.slice(1).map((r) => [r.tool, r.ok, r.error?.message ?? null])).toEqual([
    ['cad__edit_feature', true, null],
    ['cad__edit_feature', true, null],
    ['cad__edit_feature', true, null],
  ]);
  expect(model.fake.pending(), 'scripted answers left unused').toBe(0);

  // As the person sees it: renamed, after Extrude 1, suppressed, its body gone.
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Box around', ...MADE.slice(2)]);
  await expect(enc).toHaveAttribute('data-suppressed', '1');
  await expect(frame.locator('[data-cad-tree] [data-body-row] .cad-body-name')).toHaveText(['Body 1', 'Body 2', 'Body 3', 'Body 4', 'Body 5']);
  // Saved with its values as Magnusim made them.
  await expect
    .poll(() => stored()?.doc.features.find((f) => f.id === ENC) ?? null, { timeout: 30_000 })
    .toMatchObject({ name: 'Box around', suppressed: true, shape: 'box', bodies: [bodies[0]], padding: 'fixed', distance: '1 mm', creates: ENC_BODY });
  expect(stored()!.doc.features.map((f) => f.name)).toEqual(['Sketch 1', 'Extrude 1', 'Box around', ...MADE.slice(2)]);

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

/** An import Magnusim made when the project's geometry was opened with Edit in CAD, and its body. */
const IMP = 'f_0magnusimimp';
const IMP_BODY = 'b_0magnusimimp';

test("a Part copied from Magnusim without its imported STEP says it is not with the Part any more, and its import names no project geometry", async ({ page, request }) => {
  const seen = await watchPage(page);
  const { pid, sid } = await projectWithPart(request, 'Flange from Magnusim', 'Flange');
  // Its model file copied in alone (the import's files stayed behind), as Magnusim saved it: a
  // STEP brought in by Edit in CAD (its origin the project's geometry), healed and stored.
  const source = 'a'.repeat(64);
  const healed = 'b'.repeat(64);
  const dir = `studies/${sid}/imports/${source}`;
  const now = new Date().toISOString();
  const path = modelFile(pid, sid);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      format: 'magnusim-cad/model',
      saved_at: now,
      source_version: 3,
      doc: {
        schema: 2,
        units: { length: 'mm', angle: 'deg' },
        params: [],
        bodies: { [IMP_BODY]: { name: 'Flange', color: '#bdc9db' } },
        features: [
          {
            id: IMP,
            type: 'import',
            name: 'Import 1',
            source: { rel: `${dir}/source.step`, size: 48_213, sha256: source, fileName: 'flange.step', unit: 'inch' },
            brep: { rel: `${dir}/healed-0.001.brep`, size: 120_544, sha256: healed, occt: '7.9.3' },
            heal: { tolerance: 0.001, sew: false },
            items: [{ body: IMP_BODY, index: 0, stepName: 'Flange', stepColor: null, kind: 'solid', valid: true }],
            origin: { geometryId: 'g_flange', sha256: source },
          },
        ],
        meta: { created_at: now, written_by: '0.2.0-dev' },
      },
    }),
  );

  // Opened here: Import 1 failed, and its red mark says why in this app's words (Magnusim says
  // "in the project"): the stored shapes, or the source STEP when the kernel is another OCCT.
  const frame = await openPart(page, pid, 'Flange');
  const imp = frame.locator(`[data-cad-tree] [data-tree-node="${IMP}"]`);
  await expect(imp).toHaveAttribute('data-state', 'error', { timeout: 60_000 });
  await expect(historyNames(frame)).toHaveText(['Import 1']);
  const badge = imp.locator('[data-feature-badge="error"]');
  await expect(badge).toHaveAttribute('data-message', /not with the Part any more$/);
  const message = (await badge.getAttribute('data-message')) ?? '';
  expect(message).toMatch(/^Import 1 failed: (its stored shapes \(studies\/.+\.brep\) are|it was stored by OCCT 7\.9\.3 and its source STEP \(studies\/.+\.step\) is) not with the Part any more$/);
  expect(message).not.toContain('in the project');
  await badge.hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('not with the Part any more');
  await page.mouse.move(0, 0);

  // Its panel: the file and its unit, and no "From the project" row (Magnusim names the geometry there).
  await imp.locator('> .tree-row').dblclick();
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-feature-panel="import"]')).toBeVisible();
  await expect(p.locator('[data-field-row="file"] [data-import-file]')).toHaveText(/^flange\.step · /);
  await expect(p.locator('[data-field-row="unit"] [data-import-unit]')).toHaveText('inch');
  await expect(p.locator('[data-field-row="origin"], [data-import-origin]')).toHaveCount(0);
  await expect(p).not.toContainText('From the project');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);

  expect(seen.csp, 'CSP violations').toEqual([]);
  // The browser logs the missing file's 404 when the Part asks for it; nothing else.
  const missing = `rel=${encodeURIComponent(`${dir}/`)}`;
  expect(seen.errors.filter((e) => !(e.includes('status of 404') && e.includes('/api/plugin-files/read?') && e.includes(missing))), 'console errors').toEqual([]);
});
