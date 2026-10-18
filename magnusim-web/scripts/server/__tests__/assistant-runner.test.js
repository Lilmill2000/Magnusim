// The tool runner's input step (Foundation spec 6.3 step 3, Phase 2 H9): every problem with
// an input reaches the model in one invalid_input, and a local model's call of a workspace
// tool gets "", [] or false for the required fields it left out or sent as null (never a
// number, an enum, a const or an object; never for host tools or cloud turns). Checked on
// ToolRunner itself and through a local turn on a tab, where the page's invoke receives the
// filled input.
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

const { ToolRunner } = await import('../assistant/runner.ts');
const { makeManager, startTurn, settled } = await import('./assistant-harness.js');
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

  it('a cloud turn, and a host tool on a local turn, are never filled: every missing field is named at once, with the empty values to send', async () => {
    for (const [source, local] of [
      [WORKSPACE, false],
      [{ kind: 'host' }, true],
    ]) {
      const { result, body, runs } = await runOnce(source, {}, { local });
      assert.deepEqual([result.ok, result.code, runs.length], [false, 'invalid_input', 0], `${source.kind}, local ${local}`);
      assert.equal(body.error.message, ALL_MISSING);
      assert.equal(result.summary, ALL_MISSING, "the log's line is the message");
    }
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
