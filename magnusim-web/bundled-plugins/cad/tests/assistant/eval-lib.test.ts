// @vitest-environment node
// The evaluation harness apart from the app (CAD tools spec §12.5): the questions it answers and
// the ones it leaves (a delete denied unless the task allows it, a privacy question only for a
// project this run made), a turn followed to its end through the turn routes (a stand-in server),
// what a run's turns used, the parameter walk putting the first value back, the summary, the
// command line (one driver; a profile kept outside the repository; the run's limits; run as a
// person runs it: --help, and a bad line refused before anything starts), a --tab that does not
// show the run's project refused (tabShowing), the
// references (each call names a Part tool and gives every field its schema lists), the records'
// folder ignored by git, and no vendor word in any of the harness's files.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVAL_DIR,
  fakeSteps,
  gateAnswer,
  imagesSent,
  lastText,
  loadReference,
  loadTask,
  PLUGIN_DIR,
  referenceCalls,
  RESULTS_DIR,
  reviewRounds,
  runFolder,
  runTurn,
  runWalks,
  scriptedDriver,
  summaryMd,
  tabShowing,
  taskIds,
  turnUse,
  type RunRecord,
  type TurnEvent,
} from '../../eval/lib.mjs';
import { capsWords, DEBUG_LOG_ENV, logLines, parseArgs, probeStrict, PROFILE_CAPS, profileSettings, readProfile, readReference, REFERENCES_MAX } from '../../eval/run.mjs';
import { CAD_TOOLS } from '../../src/assistant/schemas';
import type { EvalFacts } from '../../src/assistant/eval-types';
import { namesVendor } from './vendor';

describe('the questions a turn asks', () => {
  const task = loadTask('plate-holes');
  const created = new Set(['p-made']);
  it('a confirmation follows the task: a delete is denied unless the task allows it', () => {
    expect(gateAnswer({ kind: 'confirm', tool: 'cad__delete' }, task, created)).toBe(false);
    expect(gateAnswer({ kind: 'confirm', tool: 'cad__delete' }, { gates: { delete: 'allow' } }, created)).toBe(true);
    expect(gateAnswer({ kind: 'confirm', tool: 'other__reset' }, { gates: {} }, created)).toBe(false);
  });
  it('a privacy question is answered only for a project this run made', () => {
    expect(gateAnswer({ kind: 'privacy', project: { id: 'p-made', title: 'Eval · plate-holes' } }, task, created)).toBe(true);
    expect(gateAnswer({ kind: 'privacy', project: { id: 'p-theirs', title: 'Pump' } }, task, created)).toBeNull();
    expect(gateAnswer({ kind: 'privacy' }, task, created)).toBeNull();
  });
});

describe('the scripted driver', () => {
  it("queues each turn's reference steps, a plain answer for a repair it has none for, and refuses answers left over", () => {
    const queued: unknown[][] = [];
    let left = 0;
    const d = scriptedDriver({ reply: (...s: unknown[]) => void queued.push(s), pending: () => left });
    const task = loadTask('edit-plate');
    d.beforeTurn!(task, 1);
    expect(queued[0]).toEqual(fakeSteps(loadReference('edit-plate'), 1));
    d.beforeRepair!(task);
    expect(queued[1]).toEqual([{ text: 'No repair is scripted for this task.' }]);
    left = 2;
    expect(() => d.beforeTurn!(task, 0)).toThrow('the scripted model still holds 2 answer(s) of an earlier turn');
    expect(queued).toHaveLength(2);
  });
});

describe('a tab named on the command line (--tab)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  it("is taken only when its registration names the run's project; another Part's tab, or none, is refused with why", async () => {
    const tabs = [
      { tab: 'tab-run', connected: true, tools: [], workspace: { project_id: 'p-run' } },
      { tab: 'tab-person', connected: true, tools: [], workspace: { project_id: 'p-person' } },
      { tab: 'tab-home', connected: true, tools: [], workspace: null },
    ];
    server = createServer((req, res) => {
      res.writeHead(req.url === '/api/assistant/tabs' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/assistant/tabs' ? { ok: true, tabs } : { ok: false }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(await tabShowing(base, 'tab-run', 'p-run', 'Eval · spacer')).toBe('tab-run');
    for (const tab of ['tab-person', 'tab-home', 'tab-gone']) {
      await expect(tabShowing(base, tab, 'p-run', 'Eval · spacer')).rejects.toThrow(`tab ${tab} does not show the project this run made (Eval · spacer): its turns would edit another Part`);
    }
  });
});

describe('a turn, followed through the turn routes', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });
  const body = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((r) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => r(s ? JSON.parse(s) : {}));
    });

  it('starts it on the tab, long-polls its log to the end and answers its questions by the policy', async () => {
    const gate = (id: string, kind: string, extra: Record<string, unknown>) => ({ type: 'gate', gate: { id, kind, title: `Question ${id}`, yes: 'Allow', no: "Don't", ...extra } });
    const log: Record<string, unknown>[] = [
      { type: 'state', state: 'running' },
      { type: 'tool_call', step: 1, call: 'c1', tool: 'cad__delete', input_preview: '{}' },
      gate('g1', 'confirm', { tool: 'cad__delete' }),
      gate('g2', 'privacy', { project: { id: 'p-theirs', title: 'Pump' } }),
      gate('g3', 'privacy', { project: { id: 'p-made', title: 'Eval · x' } }),
      { type: 'tool_result', call: 'c1', ok: false, code: 'busy', summary: 'declined', ms: 3 },
      { type: 'text', step: 2, text: 'I did not delete it.' },
      { type: 'end', state: 'done', reason: 'end_turn', message: null },
    ];
    const started: Record<string, unknown>[] = [];
    const answers: { gate: string; allow: unknown }[] = [];
    let polls = 0;
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (status: number, j: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
      };
      if (req.method === 'POST' && url.pathname === '/api/assistant/turns') {
        started.push(await body(req));
        return send(202, { ok: true, turn: 't1', conversation: 'c1' });
      }
      if (req.method === 'GET' && url.pathname === '/api/assistant/turns/t1') {
        polls++;
        const since = Number(url.searchParams.get('since'));
        // Two batches: the questions come in the first, the end only after the answers.
        const upTo = answers.length >= 2 ? log.length : 5;
        return send(200, { ok: true, turn: { id: 't1', state: upTo === log.length ? 'done' : 'running', served_by: 'm' }, events: log.slice(since, upTo), next: upTo, ended: upTo === log.length });
      }
      const g = /^\/api\/assistant\/gates\/(\w+)$/.exec(url.pathname);
      if (req.method === 'POST' && g) {
        answers.push({ gate: g[1], allow: (await body(req)).allow });
        return send(200, { ok: true });
      }
      return send(404, { ok: false });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const lines: string[] = [];
    const t = await runTurn(base, { text: 'Delete it.', tab: 'tab-1' }, { answer: (gq) => gateAnswer(gq, { gates: {} }, new Set(['p-made'])), ms: 20_000, log: (l) => lines.push(l) });
    expect(started).toEqual([{ text: 'Delete it.', tab: 'tab-1' }]);
    expect(answers).toEqual([
      { gate: 'g1', allow: false },
      { gate: 'g3', allow: true },
    ]);
    expect(t).toMatchObject({ id: 't1', conversation: 'c1', turn: { state: 'done' } });
    expect(t.events.map((e) => e.type)).toEqual(log.map((e) => e.type));
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(lines).toContain('  cad__delete {}');
    expect(lines).toContain('    -> busy: declined');
    expect(lines).toContain('  question "Question g1": Don\'t');
    expect(lastText(t.events)).toBe('I did not delete it.');
  });

  it('a turn that does not start says why', async () => {
    server = createServer((_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'tab_busy' }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await expect(runTurn(base, { text: 'x', tab: 't' })).rejects.toThrow(/the turn did not start \(409\): .*tab_busy/);
  });
});

describe("what a run's turns used", () => {
  it('counts steps by tool, failed results by code, money, tokens, the largest request, notes and ends', () => {
    const turns: { events: TurnEvent[] }[] = [
      {
        events: [
          { type: 'tool_call', tool: 'cad__sketch' },
          { type: 'usage', tokens: 1000, turn_usd: 0.01 },
          { type: 'tool_result', ok: false, code: 'invalid_input' },
          { type: 'tool_call', tool: 'cad__sketch' },
          { type: 'usage', tokens: 2500, turn_usd: 0.03 },
          { type: 'note', text: 'The local model does not read images.' },
          { type: 'end', state: 'done', reason: 'end_turn' },
        ],
      },
      {
        events: [
          { type: 'tool_call', tool: 'cad__extrude' },
          { type: 'usage', tokens: 1200, turn_usd: 0.02 },
          { type: 'note', text: 'The local model does not read images.' },
          { type: 'end', state: 'capped', reason: 'steps' },
        ],
      },
    ];
    expect(turnUse(turns)).toEqual({
      steps: 3,
      calls_by_tool: { cad__sketch: 2, cad__extrude: 1 },
      errors_by_code: { invalid_input: 1 },
      usd: 0.05,
      tokens: 3700,
      max_request_tokens: 1500,
      notes: ['The local model does not read images.'],
      ends: [
        { state: 'done', reason: 'end_turn' },
        { state: 'capped', reason: 'steps' },
      ],
    });
  });

  it("the last words are the last step's text; a discarded step's text goes", () => {
    expect(lastText([{ type: 'text', step: 1, text: 'Building.' }, { type: 'text', step: 3, text: 'Done ' }, { type: 'text', step: 3, text: 'now.' }])).toBe('Done now.');
    expect(lastText([{ type: 'text', step: 1, text: 'Kept.' }, { type: 'text', step: 2, text: 'Gone.' }, { type: 'discard', step: 2 }])).toBe('Kept.');
    expect(lastText([])).toBe('');
    // A review round's bare confirmation is not the turn's last words; a review round that said more is.
    expect(lastText([{ type: 'text', step: 4, text: 'Built the chip.' }, { type: 'review', round: 1, of: 3 }, { type: 'text', step: 5, text: 'Review: no changes' }])).toBe('Built the chip.');
    expect(lastText([{ type: 'text', step: 4, text: 'Built.' }, { type: 'text', step: 6, text: 'Moved the spots in by 1 mm.' }])).toBe('Moved the spots in by 1 mm.');
  });

  it("the review rounds the app ran, by turn", () => {
    const turns = [
      { events: [{ type: 'text', step: 1, text: 'x' }, { type: 'review', round: 1, of: 3 }, { type: 'review', round: 2, of: 3 }] },
      { events: [{ type: 'end', state: 'done' }] },
      { repair: true, events: [{ type: 'review', round: 1, of: 3 }] },
    ];
    expect(reviewRounds(turns)).toEqual([
      { turn: 1, repair: false, round: 1, of: 3 },
      { turn: 1, repair: false, round: 2, of: 3 },
      { turn: 3, repair: true, round: 1, of: 3 },
    ]);
  });

  it('every reference turn that edits the Part ends with the review round\'s "Review: no changes"', () => {
    const reads = new Set(['cad__get_model', 'cad__find', 'cad__measure', 'cad__view', 'cad__help']);
    for (const id of taskIds()) {
      const ref = loadReference(id);
      ref.turns.forEach((steps, i) => {
        const edits = steps.some((x) => (x.tools ?? []).some((t) => !reads.has(t.name)));
        if (edits) expect(steps.at(-1), `${id} turn ${i}`).toEqual({ text: 'Review: no changes' });
      });
    }
  });

  it('counts the images the tool results carried: views and edits alike, failed calls none', () => {
    const calls = [
      { tool: 'get_model', ok: true },
      { tool: 'sketch', ok: true, images: 1 },
      { tool: 'extrude', ok: false, images: 1 },
      { tool: 'view', ok: true, images: 1 },
      { tool: 'extrude', ok: true, images: 1 },
    ];
    expect(imagesSent(calls)).toBe(3);
    expect(imagesSent([])).toBe(0);
  });
});

describe('the parameter walk', () => {
  const facts = (t: number, failing = false) =>
    ({ params: [{ name: 't', kind: 'length', expr: `${t} mm`, value: t }], bodies: [{ volume: 100 * t }], features: [{ name: 'Plate', state: failing ? 'error' : 'ok' }] }) as unknown as EvalFacts;
  it('sets each value, reads the volume and what fails, and puts the first value back', async () => {
    let t = 8;
    const set: string[] = [];
    const io = {
      facts: async () => facts(t, t > 20),
      setParam: async (_n: string, e: string) => {
        set.push(e);
        t = Number.parseFloat(e);
        return { ok: true };
      },
    };
    const task = { checks: [{ id: 'w', kind: 'walk' as const, param: 't', steps: [{ expr: '12 mm', volume_ratio: 1.5 }, { expr: '30 mm' }] }] };
    const walk = await runWalks(task, io);
    expect(walk.w).toEqual({
      param: 't',
      from: '8 mm',
      base: 800,
      steps: [
        { expr: '12 mm', ok: true, volume: 1200, failing: [] },
        { expr: '30 mm', ok: true, volume: 3000, failing: ['Plate'] },
      ],
    });
    // The first value goes back after the last step.
    expect(set).toEqual(['12 mm', '30 mm', '8 mm']);
  });

  it('a parameter that is not there, and a value the Part refuses, are recorded', async () => {
    const io = { facts: async () => facts(8), setParam: async () => ({ ok: false, reason: 'refused' }) };
    expect(await runWalks({ checks: [{ id: 'w', kind: 'walk', param: 'thk', steps: [{ expr: '1 mm' }] }] }, io)).toEqual({ w: { error: 'no parameter named thk (parameters: t)' } });
    const walk = await runWalks({ checks: [{ id: 'w', kind: 'walk', param: 't', steps: [{ expr: '8 mm' }] }] }, io);
    expect(walk.w.steps).toEqual([{ expr: '8 mm', ok: false, reason: 'refused', volume: 800, failing: [] }]);
  });
});

describe('the records', () => {
  it('go to .cache/assistant-eval/<stamp>-<label>, which git ignores', () => {
    const dir = runFolder('cloud high / first pass!', new Date('2026-10-18T09:30:05.123Z'));
    expect(relative(RESULTS_DIR, dir)).toBe('20261018T093005Z-cloud-high-first-pass');
    expect(relative(PLUGIN_DIR, RESULTS_DIR).replace(/\\/g, '/')).toBe('.cache/assistant-eval');
    const r = spawnSync('git', ['check-ignore', '-q', '.cache/assistant-eval/20261018T093005Z-x/runs.jsonl'], { cwd: PLUGIN_DIR, windowsHide: true });
    if (r.error) {
      // No git (a copy without the history): the plugin's own ignore file lists .cache/.
      expect(readFileSync(join(PLUGIN_DIR, '.gitignore'), 'utf8').split(/\r?\n/)).toContain('.cache/');
    } else expect(r.status).toBe(0);
  });

  it('summary.md tabulates each run, then the failed checks, the heuristic ones and the notes', () => {
    const rec = (task: string, pass: boolean): RunRecord =>
      ({
        task,
        tier: 'L1',
        run: 1,
        model: { provider: 'p', model: 'm', effort: 'high', served_by: ['m'] },
        first_shot: { pass: false, passed: 3, counted: 4, failed: ['volume'] },
        final: { pass, passed: pass ? 4 : 3, counted: 4, failed: pass ? [] : ['volume'] },
        checks: [
          { id: 'volume', kind: 'volume', heuristic: false, pass, got: 1, why: pass ? '' : 'volume 1 mm3, not 2' },
          { id: 'named', kind: 'last_text', heuristic: true, pass: false, got: '', why: 'the last words do not match /blend/' },
        ],
        steps: 9,
        invalid_input: 1,
        errors_by_reason: { bad_selector: 1 },
        usd: 0.5,
        tokens: 1000,
        max_request_tokens: 600,
        wall_s: 30,
        health: { health: 'warn', words: ['1 sketch under-defined'] },
        notes: ['a note'],
      }) as unknown as RunRecord;
    const md = summaryMd([rec('spacer', true), rec('plate-holes', false)], { label: 'try', when: 'now', driver: 'scripted', caps: capsWords({ steps: 120, turn_usd: 8, turn_minutes: 60, day_usd: 15 }) });
    expect(md).toContain('# Assistant CAD eval: try');
    expect(md).toContain('Model: p / m / high');
    expect(md).toContain('Limits: 120 steps, $8 a turn, 60 minutes, $15 a day');
    expect(md).toContain('| spacer | L1 | 1 | fail 3/4 | pass 4/4 | 9 | 1 | bad_selector 1 | 0.5 | 1000 | 600 | 30 | warn: 1 sketch under-defined |');
    expect(md).toContain('First shot: 0 of 2. Final: 1 of 2.');
    expect(md).toContain('- plate-holes (run 1) volume: volume 1 mm3, not 2');
    expect(md).toContain('- spacer (run 1) named: no (the last words do not match /blend/)');
    expect(md).toContain('## Notes\n\n- a note');
  });
});

describe("the probe's strict record", () => {
  // The app's notes (scripts/server/assistant/providers/common.ts strictReducedNote, strictFallbackNote).
  const SAID = 'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.';
  const reduced = (said: string) =>
    `The cloud provider could not compile all these tools strictly${said ? ` (it said: ${said})` : ''}: 15 of 21 are checked by the provider, the rest are sent unchecked (cad__extrude, cad__pattern, cad__revolve, cad__sketch, cad__sweep_loft, cad__view); the app still checks every input.`;
  const loose = `The cloud provider could not compile these tools strictly; they are sent unchecked by the provider; the app still checks every input. The provider said: ${SAID}`;

  it('accepted with no strict note; reduced with the count and the unchecked tools; refused when all went unchecked', () => {
    expect(probeStrict([])).toBe('accepted');
    expect(probeStrict(['Left out 1 picture.'])).toBe('accepted');
    const want = 'reduced: 15 of 21 strict (unchecked: cad__extrude, cad__pattern, cad__revolve, cad__sketch, cad__sweep_loft, cad__view)';
    expect(probeStrict([reduced(SAID)])).toBe(want);
    expect(probeStrict([reduced('')])).toBe(want);
    // Words with brackets and colons of their own are still read from the end.
    expect(probeStrict([reduced('tools (a): too large: 3 of 4 are checked by the provider')])).toBe(want);
    expect(probeStrict([loose])).toBe('refused: all unchecked');
    expect(probeStrict(['The cloud provider could not compile these tools strictly; they are sent unchecked by the provider; the app still checks every input.'])).toBe('refused: all unchecked');
  });
});

describe('the command line', () => {
  it('takes one driver and checks its options', () => {
    expect(parseArgs(['--scripted', '--tasks', 'plate-holes,flange', '--runs', '2', '--label', 'ci'])).toMatchObject({ driver: 'scripted', tasks: 'plate-holes,flange', runs: 2, label: 'ci', pace: 'fast', toolset: 'all', repair: true });
    expect(parseArgs(['--attach=http://127.0.0.1:8082/', '--tab', 'tab-1', '--clean', '--toolset', 'core', '--pace', 'watch', '--no-repair'])).toMatchObject({ driver: 'attach', attach: 'http://127.0.0.1:8082', tab: 'tab-1', clean: true, toolset: 'core', pace: 'watch', repair: false });
    expect(parseArgs(['--profile', 'x.json', '--headed', '--turn-minutes', '45'])).toMatchObject({ driver: 'profile', profile: 'x.json', headed: true, turnMs: 45 * 60_000 });
    expect(parseArgs(['--profile', 'x.json', '--headed', '--keep-open'])).toMatchObject({ headed: true, keepOpen: true });
    expect(parseArgs(['--scripted']).keepOpen).toBe(false);
    expect(() => parseArgs(['--tasks', 'all'])).toThrow(/choose one driver: --profile, --attach, --scripted/);
    expect(() => parseArgs(['--scripted', '--attach', 'http://127.0.0.1:1'])).toThrow(/choose one driver/);
    expect(() => parseArgs(['--scripted', '--tab', 't'])).toThrow(/--tab goes with --attach/);
    expect(() => parseArgs(['--attach', 'http://127.0.0.1:1', '--tab', 'auto'])).toThrow(/never bound to "auto"/);
    expect(() => parseArgs(['--scripted', '--clean'])).toThrow(/--clean goes with --attach/);
    expect(() => parseArgs(['--attach', '127.0.0.1:8082'])).toThrow(/the app address/);
    expect(() => parseArgs(['--scripted', '--runs', '0'])).toThrow(/--runs is a whole number/);
    expect(() => parseArgs(['--scripted', '--pace', 'slow'])).toThrow(/--pace is fast or watch/);
    expect(() => parseArgs(['--scripted', '--label'])).toThrow(/--label needs a value/);
    expect(() => parseArgs(['--scripted', '--nope'])).toThrow(/unknown option --nope/);
    // Reference pictures (repeatable, at most 4) and the review switch.
    expect(parseArgs(['--scripted'])).toMatchObject({ references: [], review: true });
    expect(parseArgs(['--scripted', '--reference', 'a.png', '--reference=b.jpg', '--review', 'off'])).toMatchObject({ references: ['a.png', 'b.jpg'], review: false });
    expect(REFERENCES_MAX).toBe(4);
    expect(() => parseArgs(['--scripted', ...Array.from({ length: 5 }, (_, i) => ['--reference', `${i}.png`]).flat()])).toThrow(/at most 4 --reference pictures/);
    expect(() => parseArgs(['--scripted', '--review', 'maybe'])).toThrow(/--review is on or off/);
  });

  it('reads a reference picture only from outside the repository: its path, SHA-256, type and bytes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cad-eval-repo-'));
    const outside = mkdtempSync(join(tmpdir(), 'cad-eval-pic-'));
    try {
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
      writeFileSync(join(repo, 'chip.png'), bytes);
      expect(() => readReference(join(repo, 'chip.png'), repo)).toThrow(/is inside the repository: keep it outside/);
      writeFileSync(join(outside, 'chip.PNG'), bytes);
      expect(readReference(join(outside, 'chip.PNG'), repo)).toEqual({
        path: join(outside, 'chip.PNG'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        media_type: 'image/png',
        data: bytes.toString('base64'),
      });
      writeFileSync(join(outside, 'chip.jpeg'), bytes);
      expect(readReference(join(outside, 'chip.jpeg'), repo).media_type).toBe('image/jpeg');
      writeFileSync(join(outside, 'chip.gif'), bytes);
      expect(() => readReference(join(outside, 'chip.gif'), repo)).toThrow(/is not a \.png, \.jpg, \.jpeg or \.webp file/);
      expect(() => readReference(join(outside, 'none.png'), repo)).toThrow(/no reference picture/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('run as a person runs it: --help prints the usage (exit 0); a bad line says why (exit 2) before anything starts', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [join(EVAL_DIR, 'run.mjs'), ...args], { cwd: PLUGIN_DIR, encoding: 'utf8', timeout: 60_000 });
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^node eval\/run\.mjs --tasks <ids\|all\|probe>/);
    for (const [args, why] of [
      [['--tasks', 'spacer'], /choose one driver/],
      [['--scripted', '--tab', 'tab-1'], /--tab goes with --attach/],
      [['--scripted', '--clean'], /--clean goes with --attach/],
      [['--attach', 'http://127.0.0.1:1', '--tab', 'auto'], /never bound to "auto"/],
    ] as const) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(why);
      expect(r.stdout, args.join(' ')).not.toContain('[eval] starting');
    }
  });

  it("names the logs its own server left: the server's output and the provider log, with their sizes", () => {
    expect(DEBUG_LOG_ENV).toBe('MAGNUSIM_ASSISTANT_DEBUG_LOG');
    const dir = mkdtempSync(join(tmpdir(), 'cad-eval-logs-'));
    try {
      const logs = { server: join(dir, 'server.log'), debug: join(dir, 'debug') };
      expect(logLines(logs)).toEqual([`provider log: none in ${logs.debug} (no model request was sent)`]);
      writeFileSync(logs.server, 'abc');
      mkdirSync(logs.debug);
      writeFileSync(join(logs.debug, 'provider.jsonl'), '{}\n');
      expect(logLines(logs)).toEqual([`server log: ${logs.server} (3 bytes)`, `provider log: ${join(logs.debug, 'provider.jsonl')} (3 bytes, a row per model request)`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a profile only from outside the repository, and posts privacy allow with the run limits under its own', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cad-eval-repo-'));
    const outside = mkdtempSync(join(tmpdir(), 'cad-eval-profile-'));
    try {
      writeFileSync(join(repo, 'p.json'), JSON.stringify({ provider: 'p', model: 'm' }));
      expect(() => readProfile(join(repo, 'p.json'), repo)).toThrow(/is inside the repository: keep profiles \(and keys\) outside it/);
      writeFileSync(join(outside, 'p.json'), JSON.stringify({ provider: 'p', model: 'm', effort: 'high', key_env: 'EVAL_KEY', caps: { turn_usd: 4 } }));
      const p = readProfile(join(outside, 'p.json'), repo);
      expect(profileSettings(p)).toEqual({ provider: 'p', model: 'm', effort: 'high', privacy: 'allow', caps: { ...PROFILE_CAPS, turn_usd: 4 } });
      expect(PROFILE_CAPS).toEqual({ steps: 150, turn_usd: 8, turn_minutes: 60, day_usd: 50 });
      // A day never below the turn.
      expect(profileSettings({ provider: 'p', model: 'm', caps: { turn_usd: 80, day_usd: 20 } }).caps.day_usd).toBe(80);
      writeFileSync(join(outside, 'bad.json'), JSON.stringify({ provider: 'p', model: 'm', key_env: 'not a name' }));
      expect(() => readProfile(join(outside, 'bad.json'), repo)).toThrow(/key_env is the name of an environment variable/);
      writeFileSync(join(outside, 'none.json'), JSON.stringify({ model: 'm' }));
      expect(() => readProfile(join(outside, 'none.json'), repo)).toThrow(/names no provider/);
      expect(() => readProfile(join(outside, 'missing.json'), repo)).toThrow(/no profile file/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('the references', () => {
  /** The fields of `schema` the input lacks or adds, at every depth (every CAD field is required). */
  function fieldProblems(schema: Record<string, unknown>, value: unknown, path: string): string[] {
    if (schema.type === 'object') {
      const props = schema.properties as Record<string, Record<string, unknown>>;
      const v = value as Record<string, unknown>;
      const out: string[] = [];
      for (const k of Object.keys(props)) if (!(k in v)) out.push(`${path}.${k} is missing`);
      for (const k of Object.keys(v)) if (!(k in props)) out.push(`${path}.${k} is not a field`);
      for (const k of Object.keys(props)) if (k in v) out.push(...fieldProblems(props[k], v[k], `${path}.${k}`));
      return out;
    }
    if (schema.type === 'array') return (value as unknown[]).flatMap((x, i) => fieldProblems(schema.items as Record<string, unknown>, x, `${path}[${i}]`));
    if (schema.enum && !(schema.enum as unknown[]).includes(value)) return [`${path} is not one of ${(schema.enum as unknown[]).join(', ')}`];
    return [];
  }

  it("each call names one of the Part's tools and gives every field its schema lists; the scripted model gets only its steps", () => {
    const tools = new Map(CAD_TOOLS.map((t) => [t.name, t]));
    for (const id of taskIds()) {
      const ref = loadReference(id);
      ref.turns.forEach((_turn, k) => {
        for (const c of referenceCalls(ref, k)) {
          const tool = tools.get(c.tool);
          expect(tool, `${id}: ${c.tool}`).toBeTruthy();
          expect(fieldProblems(tool!.inputSchema as unknown as Record<string, unknown>, c.input, `${id} ${c.tool}`)).toEqual([]);
        }
        // Each turn ends with the model's words, and its steps carry no harness fields.
        const steps = fakeSteps(ref, k);
        expect(steps[steps.length - 1].text, `${id} turn ${k} ends with words`).toBeTruthy();
        for (const s of steps) expect(Object.keys(s).every((key) => key === 'tools' || key === 'text')).toBe(true);
      });
    }
  });
});

describe('vendor words', () => {
  it("none in the harness's files, the facts module or the developer reference", () => {
    const files = [
      ...readdirSync(EVAL_DIR, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => join(d.parentPath, d.name)),
      join(PLUGIN_DIR, 'src', 'assistant', 'eval-facts.ts'),
      join(PLUGIN_DIR, 'src', 'assistant', 'eval-types.ts'),
      join(PLUGIN_DIR, 'docs', 'assistant.md'),
      join(PLUGIN_DIR, 'e2e', 'cad-assistant-eval.spec.ts'),
    ];
    expect(files.length).toBeGreaterThan(20);
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => (namesVendor(line) ? `${relative(PLUGIN_DIR, f)}:${i + 1}` : null))
        .filter(Boolean),
    );
    expect(hits).toEqual([]);
  });
});
