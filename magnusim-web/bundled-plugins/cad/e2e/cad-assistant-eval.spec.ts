// The Assistant's evaluation set through the app (CAD tools spec §12.3 eval, §12.5, E1): the
// scripted model answers each task with its reference (eval/references), and the harness
// (eval/lib.mjs runTask, as `npm run eval:assistant -- --scripted` runs it) makes the project and
// its first Part as the person does, runs the task's turn on the tab whose registration names that
// project, reads the Part's facts in the page (window.__CAD__.assistant.evalFacts) and scores them
// (eval/score.mjs). plate-holes (with its parameter walk: t 8 -> 12 -> 8 mm), l-bracket, flange
// and poker-chip each score pass at the first shot; each record holds the steps, the errors by
// reason and the first shot. The run folder holds runs.jsonl, the turn's events, the calls, the
// facts and the final picture (a PNG of the Part). A run whose first shot fails a check gets one
// repair turn naming the failed checks, and a refused call is counted by its reason.
// The command line (eval/run.mjs, as `npm run eval:assistant` runs it, in a temp folder of its
// own): --scripted starts its own app server and scripted model and records the run in runs.jsonl,
// its folder and summary.md; --profile reads the key from the environment variable the profile
// names, and the model gets it as its bearer token while no output or record holds it, and the
// run's temp projects root and Assistant home are gone after it; --attach --clean removes only the
// projects the run made (the person's of the same title stays), and a --tab of the person's own
// Part stops the task and the probe before any turn, the person's Part untouched.
// Each test may take the suite's 240 s like the shard's other tests (a fresh page, the Part, the
// kernel, the turn, the walk and the picture on CI's two slow cores; 120 s was never measured on
// Linux), the repair test two turns' ceiling and a minute, the poker chip 300 s.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error the app's host helper is plain JavaScript
import { killTree } from '../../../e2e/support/host-server.mjs';
import { fakeSteps, loadReference, loadTask, PLUGIN_DIR, referenceCalls, runTask, scriptedDriver, type EvalDriver, type RunRecord } from '../eval/lib.mjs';
import { cadFrame, chats, newProject, openNewPart, resetAssistant, startAssistantHost, tabRow, useScriptedModel, type AssistantHost } from './assistant-helpers';
import { PNG } from './png';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-eval', 90);
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
  // A scripted answer left: the turns did not go as the reference wrote them.
  expect(host.fake.pending(), 'scripted answers left unused').toBe(0);
});

/** A turn's ceiling here. */
const TURN_MS = 100_000;
/** One task's run with the scripted model and its reference, fast pace, each turn within TURN_MS. */
const scripted = (page: Page, id: string, out: string | null = null, driver: EvalDriver = scriptedDriver(host.fake)): Promise<RunRecord> =>
  runTask({ base: host.base, page, driver, out }, loadTask(id), { label: 'e2e', pace: 'fast', turnMs: TURN_MS });

/** A first-shot pass on every counted check, with the record's step, error and first-shot fields. */
function expectPass(r: RunRecord, id: string): void {
  const failed = r.checks.filter((c) => !c.pass && !c.heuristic).map((c) => `${c.id}: ${c.why}`);
  expect(failed, `${id}: the reference fails these checks`).toEqual([]);
  expect(r.first_shot).toEqual({ pass: true, passed: r.checks.filter((c) => !c.heuristic).length, counted: r.checks.filter((c) => !c.heuristic).length, failed: [] });
  expect(r.final.pass).toBe(true);
  expect(r.repaired).toBe(false);
  // Every reference call is one step of the turn, and none was refused.
  expect(r.steps).toBe(referenceCalls(loadReference(id), 0).length);
  expect(r.errors_by_reason).toEqual({});
  expect(r.invalid_input).toBe(0);
  expect(r).toMatchObject({ task: id, driver: 'scripted', label: 'e2e', run: 1, end: [{ state: 'done' }], health: { health: 'ok' }, fact_errors: [] });
  // The scripted model sent the tools strict: no fallback note.
  expect(r.notes).toEqual([]);
}

test('cad:assistant-eval-plate-holes the plate scores pass at the first shot, its walk of t keeps it working; the run folder holds its records and a picture', async ({ page }, info) => {
  test.setTimeout(240_000);
  const out = info.outputPath('eval');
  const r = await scripted(page, 'plate-holes', out);
  expectPass(r, 'plate-holes');
  // The walk: t 12 mm makes the plate 1.5 times its volume, 8 mm brings it back, every feature working.
  expect(r.checks.find((c) => c.id === 'walk_t')).toMatchObject({ pass: true, got: [{ expr: '12 mm', ok: true }, { expr: '8 mm', ok: true }] });
  expect(r.calls_by_tool).toEqual({ cad__get_model: 1, cad__set_params: 1, cad__sketch: 1, cad__extrude: 1, cad__hole: 1, cad__measure: 1 });
  // The run folder: the record as returned, the turn's events, the page's calls, the facts, the picture.
  const lines = readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual(JSON.parse(JSON.stringify(r)));
  const dir = join(out, 'plate-holes-1');
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(events.filter((e) => e.type === 'tool_call').map((e) => e.tool)).toEqual(referenceCalls(loadReference('plate-holes'), 0).map((c) => `cad__${c.tool}`));
  const calls = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8')) as { tool: string; ok: boolean }[];
  expect(calls.map((c) => [c.tool, c.ok])).toEqual(referenceCalls(loadReference('plate-holes'), 0).map((c) => [c.tool, true]));
  const facts = JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf8'));
  expect(facts.bodies).toHaveLength(1);
  expect(facts.params.find((p: { name: string }) => p.name === 't')).toMatchObject({ expr: '8 mm', value: 8 });
  expect(existsSync(join(dir, 'final.png'))).toBe(true);
  const png = PNG.decode(readFileSync(join(dir, 'final.png')));
  expect([png.width, png.height]).toEqual([1024, 768]);
  // The plate is drawn: the middle of the picture is not the background of its corner.
  expect(PNG.at(png, png.width / 2, png.height / 2)).not.toEqual(PNG.at(png, 4, 4));
});

test('cad:assistant-eval-l-bracket the L bracket scores pass at the first shot: its fillet face and a hole centred on each flange', async ({ page }) => {
  test.setTimeout(240_000);
  const r = await scripted(page, 'l-bracket');
  expectPass(r, 'l-bracket');
  expect(r.checks.find((c) => c.id === 'holes')).toMatchObject({ pass: true });
  expect((r.checks.find((c) => c.id === 'holes')!.got as unknown[]).length).toBe(2);
});

test('cad:assistant-eval-flange the flange scores pass at the first shot: six bolt holes on the 60 mm circle and the bore', async ({ page }) => {
  test.setTimeout(240_000);
  const r = await scripted(page, 'flange');
  expectPass(r, 'flange');
  expect((r.checks.find((c) => c.id === 'bolt_holes')!.got as unknown[]).length).toBe(6);
});

test('cad:assistant-eval-poker-chip the poker chip scores pass at the first shot: two bodies touching, the sealed pocket, concentric spots, the colours interlocked', async ({ page }) => {
  test.setTimeout(300_000);
  const r = await scripted(page, 'poker-chip');
  expectPass(r, 'poker-chip');
  expect(r.checks.find((c) => c.id === 'spots')).toMatchObject({ pass: true, got: { count: 6 } });
  expect(r.checks.find((c) => c.id === 'interlock')).toMatchObject({ pass: true });
  expect(r.checks.find((c) => c.id === 'union')).toMatchObject({ pass: true, got: { solids: 1, voids: 1 } });
});

test('cad:assistant-eval-repair a first shot that fails gets one repair turn naming the failed checks; a refused call is counted by its reason', async ({ page }) => {
  test.setTimeout(2 * TURN_MS + 60_000);
  // The spacer's reference with a call to a face that is not there first, and without its extrude:
  // the first shot ends with no body; the repair turn makes it.
  const steps = fakeSteps(loadReference('spacer'), 0);
  const extrude = steps.findIndex((s) => s.tools?.[0]?.name === 'cad__extrude');
  const bad = { tools: [{ name: 'cad__hole', input: { name: '', face: 'Spacer.end', centers: [{ x: '0 mm', y: '0 mm', z: '' }], diameter: '3 mm', depth: 'through', distance: '' } }] };
  const driver: EvalDriver = {
    kind: 'scripted',
    beforeTurn: () => host.fake.reply(bad, ...steps.slice(0, extrude), { text: 'The spacer sketch is ready.' }),
    beforeRepair: () => host.fake.reply(steps[extrude], { text: 'The spacer is extruded now.' }),
  };
  const before = chats(host).length;
  const r = await scripted(page, 'spacer', null, driver);
  expect(r.first_shot.pass).toBe(false);
  expect(r.first_shot.failed).toEqual(expect.arrayContaining(['bodies', 'volume', 'bbox', 'bore']));
  expect(r.final).toMatchObject({ pass: true, failed: [] });
  expect(r.repaired).toBe(true);
  // The refused call: the empty Part has no face to drill.
  expect(r.errors_by_reason).toEqual({ bad_selector: 1 });
  expect(r.invalid_input).toBe(1);
  expect(r.steps).toBe(1 + extrude + 1);
  expect(r.end.map((e) => e.state)).toEqual(['done', 'done']);
  // The repair turn's request names the failed checks.
  const asked = chats(host)
    .slice(before)
    .map((c) => JSON.stringify(c.body.messages))
    .find((m) => m.includes('These checks fail:'));
  expect(asked).toContain('bodies (0 bodies, not 1)');
  expect(asked).toContain('Fix the Part.');
});

// ---- The command line (eval/run.mjs), as a person runs it.

/** Where the command line's own app server starts looking for a port. */
const CLI_PORT = Number(process.env.CAD_E2E_PORT_FROM || 8170) + 110;
/** The folder name prefix of the command line's own app server (e2e/support/host-server.mjs, name cad-eval). */
const HOST_TEMP = 'magnusim-cad-eval-';

/**
 * `node eval/run.mjs <args>` from the plugin folder, with a temp folder of its own (its app server
 * keeps its projects root and the Assistant's home there): its exit code, output, the temp folder,
 * and the app server folders seen there while it ran.
 */
async function evalCli(args: string[], o: { env?: Record<string, string>; ms?: number } = {}): Promise<{ code: number | null; out: string; err: string; tmp: string; hostTemps: string[] }> {
  const tmp = mkdtempSync(join(tmpdir(), 'cad-eval-cli-'));
  const child = spawn(process.execPath, [join(PLUGIN_DIR, 'eval', 'run.mjs'), ...args], {
    cwd: PLUGIN_DIR,
    env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...o.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  const hostTemps = new Set<string>();
  const look = setInterval(() => {
    for (const n of readdirSync(tmp)) if (n.startsWith(HOST_TEMP)) hostTemps.add(n);
  }, 200);
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => killTree(child.pid), o.ms ?? 240_000);
    child.once('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  clearInterval(look);
  return { code, out, err, tmp, hostTemps: [...hostTemps] };
}

/** The records of a run folder (runs.jsonl). */
const recordsIn = (out: string): RunRecord[] => readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
/** Every file under `dir`. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
/** The projects --clean says it removed: [{id, status}]. */
const removedIn = (out: string) => [...out.matchAll(/\[eval\] removed project (\S+): (\d+)/g)].map((m) => ({ id: m[1], status: Number(m[2]) }));

test('cad:assistant-eval-cli-scripted the command line with --scripted: its own app server and scripted model, the run in runs.jsonl, its folder and summary.md; the server and its temp folder gone after', async ({}, info) => {
  test.setTimeout(420_000);
  const out = info.outputPath('cli');
  const r = await evalCli(['--scripted', '--tasks', 'spacer', '--label', 'cli', '--out', out, '--port-from', String(CLI_PORT)], { ms: 360_000 });
  try {
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).toContain('[eval] starting an app server of its own');
    const [rec, ...more] = recordsIn(out);
    expect(more).toEqual([]);
    expect(rec).toMatchObject({ task: 'spacer', driver: 'scripted', label: 'cli', first_shot: { pass: true }, final: { pass: true }, repaired: false, end: [{ state: 'done' }] });
    for (const f of ['events.jsonl', 'calls.json', 'facts.json', 'final.png']) expect(existsSync(join(out, 'spacer-1', f)), f).toBe(true);
    const md = readFileSync(join(out, 'summary.md'), 'utf8');
    expect(md).toContain('# Assistant CAD eval: cli');
    expect(md).toContain('Driver: scripted');
    expect(md).toMatch(/\n\| spacer \| L1 \| 1 \| pass \d+\/\d+ \| pass \d+\/\d+ \|/);
    expect(md).toContain('First shot: 1 of 1. Final: 1 of 1.');
    // The summary is printed too.
    expect(r.out).toContain('First shot: 1 of 1. Final: 1 of 1.');
    // Its own app server kept its projects and the Assistant's home in a temp folder, gone after the run.
    expect(r.hostTemps.length).toBe(1);
    expect(readdirSync(r.tmp).filter((n) => n.startsWith(HOST_TEMP))).toEqual([]);
  } finally {
    rmSync(r.tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("cad:assistant-eval-cli-profile --profile: the key named by key_env reaches the model as its bearer token and no output or record; the run's temp projects root and Assistant home are gone after", async ({ request }, info) => {
  test.setTimeout(420_000);
  // The local server's dialect as the app names it (read from the app's own settings, not written here).
  const local = await useScriptedModel(request, host, 'local');
  const provider = String((await (await request.get(`${host.base}/api/assistant/status`)).json()).provider);
  const dir = mkdtempSync(join(tmpdir(), 'cad-eval-profile-'));
  const token = `evalcli-${randomBytes(16).toString('hex')}`;
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ provider, model: local.model, base_url: host.fake.compatBase, key_env: 'CAD_EVAL_CLI_KEY' }));
  host.fake.reply(...fakeSteps(loadReference('spacer'), 0));
  const seen = host.fake.requests().length;
  const out = info.outputPath('cli');
  const r = await evalCli(['--profile', join(dir, 'profile.json'), '--tasks', 'spacer', '--label', 'cli-profile', '--out', out, '--port-from', String(CLI_PORT)], { env: { CAD_EVAL_CLI_KEY: token }, ms: 360_000 });
  try {
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).toContain('[eval] limits: 150 steps, $8 a turn, 60 minutes, $50 a day');
    const [rec] = recordsIn(out);
    expect(rec).toMatchObject({ task: 'spacer', driver: 'profile', label: 'cli-profile', final: { pass: true }, model: { provider, model: local.model } });
    // The model got the key as its bearer token, on every request of the run...
    const asked = host.fake.requests().slice(seen).filter((q) => q.kind === 'chat');
    expect(asked.length).toBe(fakeSteps(loadReference('spacer'), 0).length);
    for (const q of asked) expect(q.headers.authorization).toBe(`Bearer ${token}`);
    // ... and nothing else holds it: not the output, not a record.
    expect(r.out).not.toContain(token);
    expect(r.err).not.toContain(token);
    const files = filesUnder(out);
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) expect(readFileSync(f).includes(token), f).toBe(false);
    // The run's own app server (its projects root and the Assistant's home, where the key was saved) is gone.
    expect(r.hostTemps.length).toBe(1);
    expect(readdirSync(r.tmp).filter((n) => n.startsWith(HOST_TEMP))).toEqual([]);
  } finally {
    rmSync(r.tmp, { recursive: true, force: true, maxRetries: 3 });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cad:assistant-eval-cli-attach --attach --clean removes only the projects the run made, not the person's of the same title; a --tab of the person's Part stops the task and the probe before any turn", async ({ page, request }, info) => {
  test.setTimeout(420_000);
  // The person's own project, titled as a run's would be, open in its Part on the person's tab.
  const mine = await newProject(request, host, 'Eval · spacer');
  const { tab } = await openNewPart(page, request, host, mine);
  const projects = async () => ((await (await request.get(`${host.base}/api/projects`)).json()).projects as { id: string }[]).map((p) => String(p.id));
  const features = () => cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { state: { get(): { doc: { features: unknown[] } } } } } } }).__CAD__.services.doc.state.get().doc.features.length);
  const temps: string[] = [];
  try {
    // A run with --clean: it makes its own project, scores it, and removes it; the person's stays.
    host.fake.reply(...fakeSteps(loadReference('spacer'), 0));
    const out1 = info.outputPath('attach');
    const r1 = await evalCli(['--attach', host.base, '--tasks', 'spacer', '--clean', '--out', out1]);
    temps.push(r1.tmp);
    expect(r1.code, `${r1.out}\n${r1.err}`).toBe(0);
    const [rec] = recordsIn(out1);
    expect(rec).toMatchObject({ task: 'spacer', driver: 'attach', final: { pass: true } });
    expect(rec.project).not.toBe(mine);
    expect(removedIn(r1.out)).toEqual([{ id: rec.project, status: 200 }]);
    expect(await projects()).toContain(mine);
    expect(await projects()).not.toContain(rec.project);

    // --tab naming the person's tab: the task stops before its first turn, and --clean still removes the run's project.
    const asked = chats(host).length;
    const out2 = info.outputPath('attach-tab');
    const r2 = await evalCli(['--attach', host.base, '--tab', tab, '--tasks', 'spacer', '--clean', '--out', out2]);
    temps.push(r2.tmp);
    expect(r2.code, `${r2.out}\n${r2.err}`).toBe(0);
    expect(readFileSync(join(out2, 'spacer-1.error.txt'), 'utf8')).toContain(`tab ${tab} does not show the project this run made (Eval · spacer): its turns would edit another Part`);
    expect(existsSync(join(out2, 'runs.jsonl'))).toBe(false);
    expect(readFileSync(join(out2, 'summary.md'), 'utf8')).toContain('First shot: 0 of 0. Final: 0 of 0.');
    const [gone2, ...more2] = removedIn(r2.out);
    expect(more2).toEqual([]);
    expect(gone2).toMatchObject({ status: 200 });
    expect(gone2.id).not.toBe(mine);

    // The probe too: it stops (exit 1) before its turn, and --clean removes its project.
    const out3 = info.outputPath('attach-probe');
    const r3 = await evalCli(['--attach', host.base, '--tab', tab, '--tasks', 'probe', '--clean', '--out', out3]);
    temps.push(r3.tmp);
    expect(r3.code, `${r3.out}\n${r3.err}`).toBe(1);
    expect(r3.err).toContain(`[eval] tab ${tab} does not show the project this run made (Eval · probe): its turns would edit another Part`);
    expect(existsSync(join(out3, 'probe.json'))).toBe(false);
    const [gone3, ...more3] = removedIn(r3.out);
    expect(more3).toEqual([]);
    expect(gone3).toMatchObject({ status: 200 });
    expect(gone3.id).not.toBe(mine);
    const left = await projects();
    expect(left).toContain(mine);
    for (const id of [gone2.id, gone3.id]) expect(left).not.toContain(id);

    // No turn reached the model, and the person's Part is as it was: open on its tab, empty.
    expect(chats(host).length).toBe(asked);
    expect(await features()).toBe(0);
    expect(await tabRow(request, host, tab)).toMatchObject({ connected: true });
  } finally {
    for (const t of temps) rmSync(t, { recursive: true, force: true, maxRetries: 3 });
  }
});
