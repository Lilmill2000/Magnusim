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
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeSteps, loadReference, loadTask, referenceCalls, runTask, scriptedDriver, type EvalDriver, type RunRecord } from '../eval/lib.mjs';
import { chats, resetAssistant, startAssistantHost, useScriptedModel, type AssistantHost } from './assistant-helpers';
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

/** One task's run with the scripted model and its reference, fast pace, each turn within 100 s. */
const scripted = (page: Page, id: string, out: string | null = null, driver: EvalDriver = scriptedDriver(host.fake)): Promise<RunRecord> =>
  runTask({ base: host.base, page, driver, out }, loadTask(id), { label: 'e2e', pace: 'fast', turnMs: 100_000 });

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
  test.setTimeout(120_000);
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
  test.setTimeout(120_000);
  const r = await scripted(page, 'l-bracket');
  expectPass(r, 'l-bracket');
  expect(r.checks.find((c) => c.id === 'holes')).toMatchObject({ pass: true });
  expect((r.checks.find((c) => c.id === 'holes')!.got as unknown[]).length).toBe(2);
});

test('cad:assistant-eval-flange the flange scores pass at the first shot: six bolt holes on the 60 mm circle and the bore', async ({ page }) => {
  test.setTimeout(120_000);
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
  test.setTimeout(120_000);
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
