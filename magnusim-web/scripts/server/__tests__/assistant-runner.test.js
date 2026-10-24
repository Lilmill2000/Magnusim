// The tool runner's input step (Foundation spec 6.3 step 3, Phase 2 H9): every problem with
// an input reaches the model in one invalid_input, and a local model's call of a workspace or
// host tool gets "", [] or false for the required fields it left out or sent as null (never a
// number, an enum, a const or an object; never for another plugin's tools or cloud turns).
// Checked on ToolRunner itself and through a local turn on a tab, where the page's invoke
// receives the filled input.
// Its risk step (core host tools spec C3): escalate raises a call's risk and never lowers it,
// one that throws, answers out of shape or takes past 10 s counts as destructive; the card is
// the tool's own (gateText) with the escalation's rows; the log's tool_call carries the risk.
// Chain grants: one card covers a declared chain; a later compute call of the same owner on a
// chained job runs with no card and a note, once; an id not chained, a call that escalates to
// destructive and another owner's call still ask; the grant ends with its owner.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-runner-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { ToolRunner, confirmGate, maxRisk, COVERED_NOTE, ESCALATE_FAILED_NOTE, ESCALATE_MAX_MS } = await import('../assistant/runner.ts');
const { createGrants, CHAIN_MAX, GRANT_MAX_MS } = await import('../assistant/grants.ts');
const { makeManager, startTurn, settled, answerGates, FakeClock } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');

after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

/** A workspace tool's schema as a page writes it: every field required, "" / [] / false when unused. */
const SHAPE = obj({
  name: { type: 'string', maxLength: 64 },
  tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  mirror: { type: 'boolean' },
  side: { type: 'string', enum: ['left', 'right'] },
  depth: { type: 'number', minimum: 0 },
  at: obj({ x: { type: 'number' }, y: { type: 'number' } }),
  rows: { type: 'array', items: obj({ label: { type: 'string' }, on: { type: 'boolean' } }) },
});
const WORKSPACE = { kind: 'workspace', plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'Counter', tab: 'T1', link: 'L1', projectId: 'p1', studyId: 's1', epoch: 'e1' };
const ALL_MISSING = 'the input is missing name, tags, mirror, side, depth, at, rows (send "", [] or false when unused).';

/** A tool of `source` whose runs are recorded. */
function tool(source, runs) {
  return {
    name: source.kind === 'workspace' ? 'ai-demo__shape' : 'shape',
    localName: 'shape',
    title: 'Shape',
    description: 'A test tool.',
    schema: SHAPE,
    risk: 'edit',
    source,
    projectData: false,
    stallMs: 60_000,
    workerBacked: false,
    available: () => true,
    run: async (input) => {
      runs.push(input);
      return { ok: true, data: { got: input }, summary: 'Shaped' };
    },
  };
}

/** Runs one call of `def` with `input` on a local or cloud turn: {result, error, runs}. */
async function runOnce(source, input, { local }) {
  const runs = [];
  const def = tool(source, runs);
  const runner = new ToolRunner({ gates: { ask: async () => 'allow' } });
  const r = await runner.run(
    { type: 'tool_call', callId: 'c1', name: def.name, input },
    {
      owner: { kind: 'turn', id: 't1', tab: 'T1' },
      ctx: { tab: 'T1', projectId: 'p1', simulationId: null, cloud: !local, local },
      signal: new AbortController().signal,
      offered: new Map([[def.name, def]]),
    },
  );
  return { result: r, body: JSON.parse(r.part.text), runs };
}

describe('the runner: the local fill', () => {
  it("a local model's workspace call gets \"\", [] and false for the strings, lists and booleans it left out or sent as null, at every depth", async () => {
    const input = { side: 'left', depth: 2, at: { x: 1, y: 2 }, rows: [{ label: 'a' }, { on: true, label: null }], name: null };
    const { result, runs } = await runOnce(WORKSPACE, input, { local: true });
    assert.equal(result.ok, true, JSON.stringify(result.part.text));
    assert.deepEqual(runs, [
      { side: 'left', depth: 2, at: { x: 1, y: 2 }, rows: [{ label: 'a', on: false }, { on: true, label: '' }], name: '', tags: [], mirror: false },
    ]);
    assert.deepEqual(input, { side: 'left', depth: 2, at: { x: 1, y: 2 }, rows: [{ label: 'a' }, { on: true, label: null }], name: null }, "the model's input is not changed");
  });

  it('numbers, enums and objects are never guessed: what is left is one invalid_input naming them all, and nothing runs', async () => {
    const { result, body, runs } = await runOnce(WORKSPACE, {}, { local: true });
    assert.deepEqual([result.ok, result.code, runs.length], [false, 'invalid_input', 0]);
    assert.equal(body.error.message, 'the input is missing side, depth, at.');
  });

  it('a cloud turn is never filled, whatever the tool: every missing field is named at once, with the empty values to send', async () => {
    for (const source of [WORKSPACE, { kind: 'host' }]) {
      const { result, body, runs } = await runOnce(source, {}, { local: false });
      assert.deepEqual([result.ok, result.code, runs.length], [false, 'invalid_input', 0], source.kind);
      assert.equal(body.error.message, ALL_MISSING);
      assert.equal(result.summary, ALL_MISSING, "the log's line is the message");
    }
  });

  it("a host tool on a local turn is filled as a workspace tool is (core host tools spec §2.2); another plugin's tool never", async () => {
    const input = { side: 'left', depth: 2, at: { x: 1, y: 2 }, rows: [{ label: 'a' }], name: null };
    const { result, runs } = await runOnce({ kind: 'host' }, input, { local: true });
    assert.equal(result.ok, true, JSON.stringify(result.part.text));
    assert.deepEqual(runs, [{ side: 'left', depth: 2, at: { x: 1, y: 2 }, rows: [{ label: 'a', on: false }], name: '', tags: [], mirror: false }]);
    const plugin = await runOnce({ kind: 'plugin', plugin: 'heat', method: 'report', epoch: '1' }, {}, { local: true });
    assert.deepEqual([plugin.result.ok, plugin.result.code, plugin.runs.length], [false, 'invalid_input', 0]);
    assert.equal(plugin.body.error.message, ALL_MISSING);
  });
});

describe('the runner: every problem at once', () => {
  it('missing, unknown, type, enum, range and size problems at every depth come back in one result, in the schema order', async () => {
    const input = { bogus: true, rows: [{ label: 'x', on: 'yes', extra: 1 }], at: { x: 'a' }, depth: -1, side: 'up', tags: ['a', 3], name: 5 };
    const { result, body, runs } = await runOnce(WORKSPACE, input, { local: true });
    assert.deepEqual([result.ok, result.code, runs.length], [false, 'invalid_input', 0]);
    assert.equal(
      body.error.message,
      'the input has an unknown field "bogus"; name must be a string; tags[1] must be a string; side must be one of "left", "right"; ' +
        'depth must be at least 0; at is missing y; at.x must be a number; rows[0] has an unknown field "extra"; rows[0].on must be a boolean.',
    );
  });
});

describe('through a local turn on a tab', () => {
  it("the page's invoke receives the filled input; a call still missing numbers is refused once, naming them all", async () => {
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: { p1: { id: 'p1', title: 'Wing', created_at: '2026-10-01T10:00:00Z' } } });
    const invoked = [];
    m.registry.setWorkspace('T1', 'L1', {
      plugin: 'ai-demo',
      pluginName: 'Workspace demo',
      workspace: 'Counter',
      projectId: 'p1',
      studyId: 's1',
      tools: [{ name: 'shape', description: 'Shape the counter.', inputSchema: SHAPE, risk: 'edit' }],
      invoke: async (call) => {
        invoked.push(call.input);
        return { ok: true, data: { shaped: true }, summary: 'Shaped' };
      },
    });
    m.provider.script(
      {
        tools: [
          { name: 'ai-demo__shape', input: { side: 'right', depth: 1, at: { x: 0, y: 0 } } },
          { name: 'ai-demo__shape', input: { name: 'n', rows: [{}] } },
        ],
      },
      { text: 'Done.' },
    );
    const r = await startTurn(m, { text: 'Shape it', tab: 'T1' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await settled(r.turn);
    assert.equal(r.turn.state, 'done');
    assert.deepEqual(invoked, [{ side: 'right', depth: 1, at: { x: 0, y: 0 }, name: '', tags: [], mirror: false, rows: [] }]);
    const results = m.provider.requests[1].req.messages[2].parts.filter((p) => p.type === 'tool_result').map((p) => JSON.parse(p.text));
    assert.deepEqual(
      results.map((x) => [x.ok, x.ok ? x.data : x.error.code]),
      [
        [true, { shaped: true }],
        [false, 'invalid_input'],
      ],
    );
    assert.equal(results[1].error.message, 'the input is missing side, depth, at.', 'what the fill left (rows[0] was filled)');
  });
});

// ---------------------------------------------------------------- C3: escalate, gateText, chain grants

const EMPTY = obj({});
const CHAINED = obj({ job: { type: 'string', maxLength: 100 }, chain: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 100 } } });

/** A host tool of `risk` whose runs are recorded, with the C3 hooks given in `extra`. */
function c3Tool(name, risk, runs, extra = {}) {
  return {
    name,
    localName: name,
    title: `Do ${name}`,
    description: 'A test tool.',
    schema: EMPTY,
    risk,
    source: { kind: 'host' },
    projectData: false,
    stallMs: 60_000,
    workerBacked: false,
    available: () => true,
    run: async (input) => {
      runs.push({ name, input });
      return { ok: true, data: { done: name }, summary: `${name} ran` };
    },
    ...extra,
  };
}

/** A runner whose questions are answered by `answer` (each recorded), with its own grants and clock. */
function c3Runner(answer = 'allow', o = {}) {
  const asked = [];
  const clock = o.clock ?? new FakeClock();
  const grants = o.grants ?? createGrants({ now: () => clock.now() });
  const runner = new ToolRunner({ gates: { ask: async (req) => (asked.push(req), typeof answer === 'function' ? answer(req) : answer) }, clock, grants });
  return { runner, asked, grants, clock };
}

/** A turn's log as the runner fills it. */
function logTurn(id = 't1') {
  const events = [];
  const notes = [];
  return { id, step: 1, events, notes, emit: (e) => events.push(e), setState() {}, pause() {}, resume() {}, note: (t) => notes.push(t) };
}

async function c3Run(runner, def, input = {}, { turn = logTurn(), callTurn, app, ctx } = {}) {
  return runner.run(
    { type: 'tool_call', callId: `c-${Math.random().toString(36).slice(2, 8)}`, name: def.name, input },
    {
      owner: turn ? { kind: 'turn', id: turn.id, tab: 'T1' } : { kind: 'mcp', session: 's1', tab: null },
      ctx: ctx ?? { tab: 'T1', projectId: 'p1', simulationId: null, cloud: true, local: false, place: 'workbench', budgetTokens: null, prompt: 'x' },
      signal: new AbortController().signal,
      offered: new Map([[def.name, def]]),
      ...(turn ? { turn } : {}),
      ...(callTurn ? { callTurn } : {}),
      ...(app ? { app } : {}),
    },
  );
}

describe('the runner: escalate (raise-only risk per call)', () => {
  it('maxRisk orders read < edit < compute < destructive; an unknown one is destructive', () => {
    assert.equal(maxRisk('read', 'edit'), 'edit');
    assert.equal(maxRisk('destructive', 'edit'), 'destructive');
    assert.equal(maxRisk('compute', null), 'compute');
    assert.equal(maxRisk('edit', 'bogus'), 'destructive');
  });

  it('raises an edit call to destructive (a card with its note and rows); never lowers a compute tool to edit; the log carries the risk', async () => {
    const runs = [];
    const { runner, asked } = c3Runner('allow');
    const up = c3Tool('units', 'edit', runs, {
      escalate: async (input, rt) => {
        assert.equal(rt.turn, 't1');
        assert.ok(rt.signal instanceof AbortSignal);
        return input.go ? { risk: 'destructive', note: 'Converts 7 boundary conditions.', detail: [{ label: 'BCs', value: '7' }] } : null;
      },
      schema: obj({ go: { type: 'boolean' } }),
    });
    let turn = logTurn();
    let r = await c3Run(runner, up, { go: false }, { turn });
    assert.equal(r.ok, true);
    assert.equal(asked.length, 0, 'an edit that does not escalate asks nothing');
    assert.equal(turn.events.find((e) => e.type === 'tool_call').risk, 'edit');
    turn = logTurn();
    r = await c3Run(runner, up, { go: true }, { turn });
    assert.equal(r.ok, true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].risk, 'destructive');
    assert.match(asked[0].copy, /Converts 7 boundary conditions\. What it sent: \{"go":true\}/);
    assert.deepEqual(asked[0].detail, [{ label: 'BCs', value: '7' }]);
    assert.deepEqual(turn.events.map((e) => e.type), ['tool_call', 'tool_result']);
    assert.equal(turn.events[0].risk, 'destructive', 'the log carries the escalated risk');
    // A compute tool told "edit" stays compute.
    const down = c3Tool('mesh', 'compute', runs, { escalate: async () => ({ risk: 'edit', note: 'nothing', detail: [] }) });
    asked.length = 0;
    await c3Run(runner, down);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].risk, 'compute');
  });

  it('an escalate that throws, answers out of shape or takes past 10 s counts as destructive, and says it could not check', async () => {
    const runs = [];
    for (const escalate of [async () => Promise.reject(new Error('boom')), async () => ({ risk: 'huge' }), () => new Promise(() => {})]) {
      const { runner, asked, clock } = c3Runner('deny');
      const def = c3Tool('edit_it', 'edit', runs, { escalate });
      const p = c3Run(runner, def);
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      clock.advance(ESCALATE_MAX_MS);
      const r = await p;
      assert.deepEqual([r.ok, r.code], [false, 'declined']);
      assert.equal(asked[0].risk, 'destructive');
      assert.match(asked[0].copy, new RegExp(ESCALATE_FAILED_NOTE.replace(/[.]/g, '\\.')));
    }
    assert.equal(runs.length, 0);
  });

  it("gateText gives the card's title, copy and rows; another app's card says so", async () => {
    const runs = [];
    const def = c3Tool('compute_it', 'compute', runs, {
      gateText: (input, a) => ({ title: 'Allow the Assistant to generate a mesh?', copy: `Generates "Mesh 1"${a ? ' again' : ''}.`, detail: [{ label: 'Engine', value: 'Standard' }] }),
    });
    const own = confirmGate(def, {}, 't1');
    assert.deepEqual([own.title, own.copy, own.detail, own.risk, own.yes, own.no], ['Allow the Assistant to generate a mesh?', 'Generates "Mesh 1".', [{ label: 'Engine', value: 'Standard' }], 'compute', 'Allow', "Don't"]);
    const app = confirmGate(def, {}, null, 'Claude Desktop', { risk: 'destructive', assessed: { risk: 'destructive', note: 'n', detail: [] } });
    assert.deepEqual([app.title, app.copy, app.risk], ['Allow an app on this PC to generate a mesh?', 'Claude Desktop asks for this. Generates "Mesh 1" again.', 'destructive']);
    // A gateText that throws: the generic card.
    const broken = confirmGate({ ...def, gateText: () => { throw new Error('x'); } }, {}, 't1');
    assert.match(broken.copy, /starts a computation\. What it sent: \{\}/);
    const { runner, asked } = c3Runner('allow');
    await c3Run(runner, def);
    assert.equal(asked[0].title, 'Allow the Assistant to generate a mesh?');
  });

  it("a tool that words its own card gets what its escalation found whole (cleaned, at most 600 characters); the generic card's note stays a confirm note's 120", async () => {
    const runs = [];
    const long = `Converts the values you entered in 7 boundary conditions and 3 mesh refinements from Metric to US units ${'x'.repeat(200)} end.`;
    const escalate = async (input) => ({ risk: 'destructive', note: input.huge ? `${long}\u0007${'y'.repeat(900)}` : long, detail: [] });
    const own = c3Tool('units', 'edit', runs, { schema: obj({ huge: { type: 'boolean' } }), escalate, gateText: (_input, a) => ({ title: 'Allow the Assistant to change the units?', copy: a.note }) });
    const { runner, asked } = c3Runner('deny');
    await c3Run(runner, own, { huge: false });
    assert.equal(asked[0].copy, long, 'the whole note, past 120 characters');
    await c3Run(runner, own, { huge: true });
    assert.equal(asked[1].copy.length, 600, 'at most 600');
    assert.ok(!asked[1].copy.includes('\u0007'), 'cleaned');
    const generic = c3Tool('units2', 'edit', runs, { schema: obj({ huge: { type: 'boolean' } }), escalate });
    await c3Run(runner, generic, { huge: false });
    assert.ok(asked[2].copy.includes(`· ${long.slice(0, 120)}. What it sent`), asked[2].copy);
    assert.equal(runs.length, 0);
  });
});

describe('the runner: chain grants', () => {
  const computeTool = (runs, extra = {}) =>
    c3Tool('compute', 'compute', runs, {
      schema: CHAINED,
      chainKey: (input) => input.job,
      describe: (input) => ({ line: input.job === 'solve.r-2' ? 'Run 1' : input.job }),
      ...extra,
    });

  it('one card for a declared chain; the chained call runs with no card and a note, once; an id not chained asks', async () => {
    const runs = [];
    const { runner, asked, grants } = c3Runner('allow');
    const def = computeTool(runs);
    const turn = logTurn('t1');
    let r = await c3Run(runner, def, { job: 'mesh.m-1', chain: ['mesh.m-1', 'solve.r-2'] }, { turn });
    assert.equal(r.ok, true);
    assert.equal(asked.length, 1);
    assert.equal(grants.holds('t1', 'solve.r-2'), true);
    assert.equal(grants.holds('t1', 'mesh.m-1'), false, "the call's own job is not granted again");
    r = await c3Run(runner, def, { job: 'solve.r-2', chain: [] }, { turn });
    assert.equal(r.ok, true);
    assert.equal(asked.length, 1, 'no second card');
    assert.deepEqual(turn.notes, [`${COVERED_NOTE}Run 1`]);
    assert.equal(COVERED_NOTE, 'Covered by your earlier approval: ');
    // Used once.
    await c3Run(runner, def, { job: 'solve.r-2', chain: [] }, { turn });
    assert.equal(asked.length, 2);
    // An id never chained asks.
    await c3Run(runner, def, { job: 'export.job-1', chain: [] }, { turn });
    assert.equal(asked.length, 3);
    assert.equal(runs.length, 4);
  });

  it("the covered call's note names the job as the card did (escalate's labels), not the call", async () => {
    const runs = [];
    const { runner } = c3Runner('allow');
    const def = computeTool(runs, {
      describe: (input) => ({ line: `compute ${input.job}` }),
      escalate: async (input) =>
        input.chain.length ? { risk: 'compute', note: 'Covers these steps, each once.', detail: [], labels: { 'solve.r-2': 'Start "Run 1"', 'solve.r-3': '' } } : null,
    });
    const turn = logTurn('t1');
    await c3Run(runner, def, { job: 'mesh.m-1', chain: ['solve.r-2', 'solve.r-3'] }, { turn });
    await c3Run(runner, def, { job: 'solve.r-2', chain: [] }, { turn });
    // A job the card had no name for: the call's own line.
    await c3Run(runner, def, { job: 'solve.r-3', chain: [] }, { turn });
    assert.deepEqual(turn.notes, [`${COVERED_NOTE}Start "Run 1"`, `${COVERED_NOTE}compute solve.r-3`]);
  });

  it('never covered: a call that escalates to destructive, another turn, a declined card; the grant ends with its owner', async () => {
    const runs = [];
    const { runner, asked, grants } = c3Runner((req) => (req.risk === 'destructive' || asked.length < 2 ? 'allow' : 'allow'));
    const again = computeTool(runs, { escalate: async (input) => (input.job === 'mesh.m-9' ? { risk: 'destructive', note: 'It replaces the mesh Run 1 used.', detail: [] } : null) });
    const t1 = logTurn('t1');
    await c3Run(runner, again, { job: 'solve.r-2', chain: ['mesh.m-9', 'solve.r-3', 'solve.r-4'] }, { turn: t1 });
    assert.equal(asked.length, 1);
    // Escalated to destructive: asks, and keeps nothing of the grant for it.
    await c3Run(runner, again, { job: 'mesh.m-9', chain: [] }, { turn: t1 });
    assert.equal(asked.length, 2);
    assert.equal(asked[1].risk, 'destructive');
    assert.equal(grants.holds('t1', 'mesh.m-9'), true, 'a destructive call consumes no grant');
    // Another turn's call asks.
    await c3Run(runner, again, { job: 'solve.r-3', chain: [] }, { turn: logTurn('t2') });
    assert.equal(asked.length, 3);
    // The grant ends with its turn.
    grants.end('t1');
    await c3Run(runner, again, { job: 'solve.r-3', chain: [] }, { turn: t1 });
    assert.equal(asked.length, 4);
    // A declined card grants nothing.
    const no = c3Runner('deny');
    await c3Run(no.runner, computeTool([]), { job: 'mesh.m-1', chain: ['solve.r-2'] }, { turn: logTurn('t3') });
    assert.equal(no.grants.holds('t3', 'solve.r-2'), false);
  });

  it("another app's calls (mcp:<connection>) hold their own grants; at most 4 ids; a tool with no chainKey grants nothing", async () => {
    const runs = [];
    const { runner, asked, grants } = c3Runner('allow');
    // A schema that lets more through: the runner still keeps 4.
    const wide = computeTool(runs, { schema: obj({ job: { type: 'string' }, chain: { type: 'array', items: { type: 'string' } } }) });
    await c3Run(runner, wide, { job: 'mesh.m-1', chain: ['a.1', 'a.2', 'a.3', 'a.4', 'a.5'] }, { turn: null, callTurn: 'mcp:s1' });
    assert.deepEqual(['a.1', 'a.2', 'a.3', 'a.4', 'a.5'].map((j) => grants.holds('mcp:s1', j)), [true, true, true, true, false]);
    assert.equal(CHAIN_MAX, 4);
    await c3Run(runner, computeTool(runs), { job: 'a.1', chain: [] }, { turn: null, callTurn: 'mcp:s1' });
    assert.equal(asked.length, 1);
    const plain = c3Tool('plain', 'compute', runs, { schema: CHAINED });
    await c3Run(runner, plain, { job: 'x', chain: ['b.1'] }, { turn: logTurn('t5') });
    assert.equal(grants.holds('t5', 'b.1'), false);
  });

  it('a store of grants and started jobs: per owner, ended with it, gone after GRANT_MAX_MS', () => {
    let now = 0;
    const g = createGrants({ now: () => now });
    g.grant('t1', ['solve.r-2', '', 'x'.repeat(101), 'solve.r-2'], { 'solve.r-2': 'Run 1' });
    assert.equal(g.consume('t2', 'solve.r-2'), null, "another owner's");
    assert.equal(g.consume('t1', 'solve.r-2'), 'Run 1');
    assert.equal(g.consume('t1', 'solve.r-2'), null, 'once');
    g.started('t1', { job: 'mesh.m-1', label: 'Mesh 1' });
    g.started('t1', { job: 'mesh.m-1', label: 'Mesh 1' });
    assert.deepEqual(g.startedBy('t1'), [{ job: 'mesh.m-1', label: 'Mesh 1' }]);
    g.grant('t1', ['solve.r-3']);
    now += GRANT_MAX_MS + 1;
    assert.equal(g.holds('t1', 'solve.r-3'), false);
    assert.deepEqual(g.startedBy('t1'), []);
    g.grant('t4', ['solve.r-3']);
    g.end('t4');
    assert.equal(g.holds('t4', 'solve.r-3'), false);
  });
});

describe('through turns: chain grants end with their turn', () => {
  it('a later turn of the same conversation is asked again', async () => {
    const m = makeManager({ dir: ROOT });
    const runs = [];
    const asked = [];
    const def = c3Tool('compute', 'compute', runs, { schema: CHAINED, chainKey: (input) => input.job });
    m.registry.addHostTool(def);
    m.provider.script({ tools: [{ name: 'compute', input: { job: 'mesh.m-1', chain: ['solve.r-2'] } }] }, { text: 'Meshing.' }, { tools: [{ name: 'compute', input: { job: 'solve.r-2', chain: [] } }] }, { text: 'Running.' });
    const a = await startTurn(m, 'Mesh it.');
    const offA = answerGates(m, a.turn, (gate) => (asked.push(gate.title), true));
    await settled(a.turn);
    offA?.();
    const b = await startTurn(m, { text: 'Run it.', conversation: a.body.conversation });
    const offB = answerGates(m, b.turn, (gate) => (asked.push(gate.title), true));
    await settled(b.turn);
    offB?.();
    assert.deepEqual(runs.map((x) => x.input.job), ['mesh.m-1', 'solve.r-2']);
    assert.equal(asked.length, 2, 'the second turn asked again: the grant ended with the first');
  });
});
