/**
 * The Assistant in Magnusim CAD: the registry built with assistant-routes.ts's
 * CAD_EDITION_TOOLS offers only the host and core page tools Magnusim CAD has, each with the
 * values (and the words) its person has controls for; a dropped value is refused before a tool
 * runs; the workspace's own tools are untouched. Magnusim's registry is byte-identical with and
 * without the edition code path. And app_status says what Magnusim CAD is, as do the system
 * prompt, the coding agents' note and the MCP instructions: no simulation in Magnusim CAD.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-cad-assistant-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
delete process.env.MAGNUSIM_EDITION;

const { createToolRegistry, localBudget, LOCAL_BUDGET } = await import('../assistant/registry.ts');
const { defaultHostTools, createHostTools } = await import('../assistant/host-tools.ts');
const { validateInput } = await import('../assistant/schema.ts');
const { CAD_EDITION_TOOLS, cadEditionTool } = await import('../assistant-routes.ts');
const { CORE_TOOLS } = await import('../../../src/assistant/coreToolDefs.ts');
const { createHostTransport } = await import('../assistant/host-call.ts');
const { paced } = await import('../assistant/host/common.ts');
const { startFakeApp, makeRt } = await import('./assistant-host-harness.js');
const { SYSTEM_PROMPT, systemPrompt } = await import('../assistant/prompt.ts');
const { AGENT_NOTE, agentNote } = await import('../assistant/agents/acp.ts');
const { MCP_INSTRUCTIONS, mcpInstructions } = await import('../assistant/mcp/server.ts');

const host = () => defaultHostTools(() => null);
// In a project (its page in Magnusim CAD, the workbench in Magnusim) unless a test says where.
const ctx = (o = {}) => ({ tab: 'T1', projectId: 'p1', simulationId: 's1', place: 'workbench', cloud: true, local: false, ...o });
const core = (o = {}) => ({ projectId: 'p1', studyId: '', place: 'workbench', tools: CORE_TOOLS, ...o });
const shown = (r, c = ctx()) =>
  r
    .toolsFor(c)
    .map((t) => ({ name: t.name, description: t.description, schema: t.schema, risk: t.risk, contexts: t.contexts ?? null }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

function registries() {
  const plain = createToolRegistry({ hostTools: host() });
  const cad = createToolRegistry({ hostTools: host(), edition: cadEditionTool });
  for (const r of [plain, cad]) r.setCore('T1', 'L1', core());
  return { plain, cad };
}

describe('the Assistant in Magnusim', () => {
  it('is byte-identical with and without the edition code path', () => {
    const without = createToolRegistry({ hostTools: host() });
    const identity = createToolRegistry({ hostTools: host(), edition: (d) => d });
    for (const r of [without, identity]) r.setCore('T1', 'L1', core());
    for (const place of [ctx({ place: 'home', projectId: null }), ctx(), ctx({ place: 'workspace' })]) {
      assert.equal(JSON.stringify(shown(identity, place)), JSON.stringify(shown(without, place)));
    }
    assert.ok(shown(without).some((t) => t.name === 'compute'), 'Magnusim has its simulation tools');
  });
});

describe('the Assistant in Magnusim CAD', () => {
  it('offers only the listed host and core tools', () => {
    const { cad } = registries();
    const names = shown(cad).map((t) => t.name);
    // In a project: every listed tool (each is offered there).
    assert.deepEqual(names, Object.keys(CAD_EDITION_TOOLS).sort());
    for (const gone of ['catalog', 'explain_ready', 'read_results', 'setup_edit', 'import_file', 'compute', 'wait', 'jobs', 'core__view']) {
      assert.ok(!names.includes(gone), `${gone} is not in Magnusim CAD`);
    }
  });

  it('narrows each listed value set, in its schema and its words', () => {
    const { plain, cad } = registries();
    const before = Object.fromEntries(shown(plain).map((t) => [t.name, t]));
    for (const t of shown(cad)) {
      const spec = CAD_EDITION_TOOLS[t.name];
      for (const [key, keep] of Object.entries(spec.values ?? {})) {
        assert.deepEqual(t.schema.properties[key].enum, keep, `${t.name}.${key}`);
        // A dropped value that is also a property's name (core__show's "panel") is said as that property.
        const props = Object.keys(t.schema.properties);
        const dropped = before[t.name].schema.properties[key].enum.filter((v) => !keep.includes(v) && String(v).length > 2 && !props.includes(v));
        const words = [t.description, ...Object.values(t.schema.properties).map((p) => p.description ?? '')].join(' ');
        for (const v of dropped) assert.doesNotMatch(words, new RegExp(`\\b${v}\\b`), `${t.name} still names "${v}"`);
      }
      // Everything else of the tool is Magnusim's.
      assert.deepEqual(Object.keys(t.schema.properties), Object.keys(before[t.name].schema.properties), t.name);
      assert.equal(t.risk, before[t.name].risk);
    }
    // Units stay: CAD's Settings and New project have them.
    const edit = shown(cad).find((t) => t.name === 'project_edit');
    assert.deepEqual(edit.schema.properties.units.enum, ['', 'Metric', 'Imperial']);
  });

  it('refuses a dropped value before the tool runs', () => {
    const { cad } = registries();
    const lookup = (n) => cad.lookup(ctx(), n);
    const bad = [
      ['project_edit', { action: 'from_sample' }],
      ['delete', { kind: 'mesh' }],
      ['study_edit', { action: 'create' }],
      ['core__show', { target: 'results' }],
    ];
    for (const [name, input] of bad) {
      const def = lookup(name);
      const full = Object.fromEntries(Object.entries(def.schema.properties).map(([k, p]) => [k, p.enum ? p.enum[0] : p.type === 'boolean' ? false : p.type === 'integer' || p.type === 'number' ? 0 : p.type === 'array' ? [] : '']));
      assert.equal(validateInput(def.schema, { ...full }).ok, true, `${name}: a kept value is valid`);
      assert.equal(validateInput(def.schema, { ...full, ...input }).ok, false, `${name}: ${JSON.stringify(input)} refused`);
    }
  });

  it('refuses core__view from the page, and keeps a workspace\'s tools as they are', () => {
    const cad = createToolRegistry({ hostTools: host(), edition: cadEditionTool });
    const v = cad.setCore('T1', 'L1', core());
    assert.deepEqual(v.accepted, ['appearance', 'keybinds', 'set_appearance', 'set_keybind', 'show']);
    assert.deepEqual(v.refused.map((x) => [x.name, x.code]), [['view', 'not_in_edition']]);
    const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
    cad.setWorkspace('T1', 'L1', { plugin: 'cad', pluginName: 'Magnusim CAD', workspace: 'part', projectId: 'p1', studyId: 's1', tools: [{ name: 'sketch', description: 'Draws.', inputSchema: EMPTY, risk: 'edit' }] });
    assert.ok(cad.toolsFor(ctx()).some((t) => t.name === 'cad__sketch'), 'the plugin\'s tool is offered as in Magnusim');
  });

  it('fits a local budget at least as well as Magnusim does', () => {
    const { plain, cad } = registries();
    for (const budget of [LOCAL_BUDGET.unknown, localBudget(8192)]) {
      const c = ctx({ cloud: false, local: true, budgetTokens: budget });
      const m = plain.selectTools(c);
      const k = cad.selectTools(c);
      assert.equal(k.tooSmall, false, `CAD fits ${budget}`);
      assert.ok(k.dropped.length <= m.dropped.length, `CAD drops no more than Magnusim at ${budget}`);
    }
    assert.deepEqual(cad.selectTools(ctx({ cloud: false, local: true })).dropped, [], 'nothing dropped at the unknown budget');
  });
});

describe('app_status', () => {
  let app;
  before(async () => {
    app = await startFakeApp();
  });
  after(async () => {
    await app.stop();
    rmSync(ROOT, { recursive: true, force: true });
  });
  const status = async () => {
    const tools = createHostTools({
      hostCall: paced(createHostTransport({ port: () => app.port, now: () => 0 }).call, async () => {}),
      assistant: async () => ({ provider: 'cloud', model: 'm' }),
      version: async () => '0.5.0',
      plugins: () => [],
    });
    const out = await tools.find((t) => t.name === 'app_status').run({}, makeRt());
    assert.equal(out.ok, true, JSON.stringify(out));
    return out;
  };

  it('in Magnusim: hardware, the compute queue and plugin environments, as before', async () => {
    const out = await status();
    assert.equal(out.data.edition, undefined);
    assert.ok(out.data.hardware && out.data.compute);
    assert.ok(out.data.plugins.every((p) => 'env' in p));
  });

  it('in Magnusim CAD: says so, with no hardware, queue, OpenFOAM, WSL or Python', async () => {
    process.env.MAGNUSIM_EDITION = 'cad';
    try {
      const out = await status();
      assert.equal(out.data.edition, 'cad');
      assert.equal(out.data.simulation, 'Not in Magnusim CAD');
      assert.equal(out.data.hardware, undefined);
      assert.equal(out.data.compute, undefined);
      assert.ok(out.data.plugins.every((p) => !('env' in p)));
      assert.doesNotMatch(JSON.stringify(out.data), /openfoam|wsl|python/i);
    } finally {
      delete process.env.MAGNUSIM_EDITION;
    }
  });
});

describe('what the model is told the app is', () => {
  // A word a person of Magnusim CAD never sees: the app simulates nothing (Daniel: hide all).
  const SIMULATION = /CFD|simulat|converg|\bstud(y|ies)\b|geometr|\bmesh|solver/i;

  it("in Magnusim: the system prompt, the coding agents' note and the MCP instructions are as before", () => {
    assert.equal(systemPrompt(), SYSTEM_PROMPT, 'no edition: Magnusim');
    assert.equal(systemPrompt(false), SYSTEM_PROMPT);
    assert.ok(SYSTEM_PROMPT.startsWith('You are the Magnusim Assistant, working inside Magnusim, a CFD and CAD app, for the person at this PC.'));
    assert.ok(SYSTEM_PROMPT.includes('(names of projects, studies, geometries, faces and files;'));
    assert.ok(SYSTEM_PROMPT.includes('Say plainly when a result is not converged, not ready, or an estimate.'));
    assert.equal(agentNote(), AGENT_NOTE);
    assert.ok(AGENT_NOTE.startsWith('You are working inside Magnusim, a CFD and CAD app, for the person at this PC.'));
    assert.equal(mcpInstructions(), MCP_INSTRUCTIONS);
    assert.ok(MCP_INSTRUCTIONS.startsWith("These are Magnusim's tools. Magnusim is a CFD and CAD app on this PC, and the tools act in it for the person at this PC.\n"));
  });

  it('in Magnusim CAD: each names Magnusim CAD, a CAD app, and no simulation', () => {
    const texts = { system: systemPrompt(true), agent: agentNote(true), mcp: mcpInstructions(true) };
    assert.ok(texts.system.startsWith('You are the Magnusim Assistant, working inside Magnusim CAD, a CAD app for designing parts, for the person at this PC.'));
    assert.ok(texts.system.includes('(names of projects, Parts, features, faces and files;'));
    assert.ok(texts.system.includes('Say plainly when a result is not ready or an estimate.'));
    assert.ok(texts.agent.startsWith('You are working inside Magnusim CAD, a CAD app for designing parts, for the person at this PC.'));
    assert.ok(texts.mcp.startsWith("These are Magnusim CAD's tools. Magnusim CAD is a CAD app for designing parts on this PC, and the tools act in it for the person at this PC.\n"));
    for (const [which, text] of Object.entries(texts)) assert.doesNotMatch(text, SIMULATION, which);
    // Only the words differ: the same rules, one for one.
    assert.equal(texts.system.split('\n').length, SYSTEM_PROMPT.split('\n').length);
    assert.equal(texts.mcp.split('\n').length, MCP_INSTRUCTIONS.split('\n').length);
    // MAGNUSIM_EDITION=cad (Magnusim CAD's server) picks them.
    process.env.MAGNUSIM_EDITION = 'cad';
    try {
      assert.deepEqual({ system: systemPrompt(), agent: agentNote(), mcp: mcpInstructions() }, texts);
    } finally {
      delete process.env.MAGNUSIM_EDITION;
    }
  });
});

// Last: it starts Magnusim CAD's server, which sets MAGNUSIM_EDITION=cad for the rest of the file.
describe('a project the Assistant creates in Magnusim CAD', () => {
  it("has the person's category (Other), as New project with no Category makes it", async () => {
    const { startCadServer } = await import('../cad-edition/serve.mjs');
    const server = await startCadServer({});
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const tools = createHostTools({
        hostCall: createHostTransport({ port: () => server.port }).call,
        assistant: async () => ({ provider: 'cloud', model: 'm' }),
        version: async () => '0.5.0',
        plugins: () => [],
      });
      const def = cadEditionTool(tools.find((t) => t.name === 'project_edit'));
      const input = { action: 'create', project_id: '', title: 'By the Assistant', description: '', category: '', units: '', folder: '', plugin: '', key: '' };
      assert.equal(validateInput(def.schema, input).ok, true, 'a CAD project_edit create');
      const out = await def.run(input, makeRt());
      assert.equal(out.ok, true, JSON.stringify(out));
      // The person's: CAD's New project sends Other (src/cad-edition/shell.ts createProject).
      const person = await fetch(`${base}/api/project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ title: 'By the person', category: 'Other', units: 'Metric' }),
      });
      assert.equal(person.status, 201);
      const listed = (await (await fetch(`${base}/api/projects`)).json()).projects;
      const cat = (title) => listed.find((p) => p.title === title)?.category;
      assert.equal(cat('By the Assistant'), 'Other');
      assert.equal(cat('By the Assistant'), cat('By the person'));
    } finally {
      await server.close();
    }
  });
});
