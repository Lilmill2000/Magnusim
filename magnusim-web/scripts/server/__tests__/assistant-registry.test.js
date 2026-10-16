// The tool registry (Foundation spec 7.1, 7.3, 7.5, 10.1): provider-safe names and plugin
// slugs, what a registration may hold and why a tool is refused, stable order and bytes,
// the per-request caps, tab, project and connection scoping, and the plugin-epoch fence
// that removes a plugin's tools the moment it is turned off, swapped or reset.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-registry-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { createToolRegistry, pluginSlug, workspaceToolName, providerTools, PROVIDER_TOOL_NAME, TOOL_NAME_MAX, REQUEST_MAX_TOOLS } = await import('../assistant/registry.ts');
const { bumpPluginEpoch, pluginEpoch } = await import('../../foam-runner.js');
const { createHostTools, connectionCheckTool } = await import('../assistant/host-tools.ts');

const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
const BY = { type: 'object', properties: { by: { type: 'integer', minimum: -100, maximum: 100 } }, required: ['by'], additionalProperties: false };

const wsTool = (name, extra = {}) => ({ name, description: `Does ${name}.`, inputSchema: EMPTY, risk: 'read', ...extra });
const DEMO = () => [wsTool('get_count'), wsTool('add', { risk: 'edit', inputSchema: BY }), wsTool('reset', { risk: 'destructive' })];
const registration = (o = {}) => ({ plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'Counter', projectId: 'p1', studyId: 's1', tools: DEMO(), ...o });
const ctx = (o = {}) => ({ tab: 'T1', projectId: 'p1', simulationId: 's1', cloud: true, local: false, ...o });

function hostTool(name, priority = 0, available = () => true) {
  return {
    name,
    localName: name,
    title: name,
    description: `Host ${name}.`,
    schema: EMPTY,
    risk: 'read',
    source: { kind: 'host' },
    projectData: false,
    stallMs: 30_000,
    workerBacked: false,
    priority,
    available,
    run: async () => ({ ok: true, summary: name }),
  };
}

const names = (tools) => tools.map((t) => t.name);

describe('names', () => {
  it('a plugin key becomes a slug: kept when it is already one, else shortened with a hash', () => {
    assert.equal(pluginSlug('ai-demo'), 'ai-demo');
    assert.equal(pluginSlug('tunnel2d'), 'tunnel2d');
    const upper = pluginSlug('AI-Demo');
    assert.match(upper, /^ai-demo_[0-9a-f]{4}$/);
    assert.notEqual(upper, pluginSlug('ai-demo'), 'two keys never share a slug');
    assert.match(pluginSlug('my plugin'), /^my_plugin_[0-9a-f]{4}$/);
    assert.match(pluginSlug('a__b'), /^a_b_[0-9a-f]{4}$/, 'no double underscore inside a slug');
    const long = pluginSlug('a'.repeat(30));
    assert.equal(long.length, 24);
    assert.notEqual(long, pluginSlug('a'.repeat(31)));
    assert.equal(workspaceToolName('ai-demo', 'add'), 'ai-demo__add');
    const longest = workspaceToolName('x'.repeat(40), `a${'b'.repeat(31)}`);
    assert.equal(longest.length, TOOL_NAME_MAX);
    assert.match(longest, PROVIDER_TOOL_NAME);
  });

  it('host tools are plain snake_case', () => {
    assert.throws(() => createToolRegistry({ hostTools: [hostTool('a__b')] }), /bad host tool name/);
    assert.throws(() => createToolRegistry({ hostTools: [hostTool('App')] }), /bad host tool name/);
    assert.throws(() => createToolRegistry({ hostTools: [hostTool('x'), hostTool('x')] }), /duplicate/);
  });
});

describe('a workspace registration', () => {
  it('accepts good tools, refuses the rest with a code and a reason', () => {
    const r = createToolRegistry();
    const tools = [
      ...DEMO(),
      wsTool('Add'),
      wsTool('a__b'),
      wsTool(`a${'b'.repeat(32)}`),
      wsTool('get_count'),
      wsTool('patterned', { inputSchema: { type: 'object', properties: { s: { type: 'string', pattern: 'x' } }, additionalProperties: false } }),
      wsTool('quiet', { description: '\u0007 ' }),
      'not an object',
    ];
    const v = r.setWorkspace('T1', 'L1', registration({ tools }));
    assert.deepEqual(v.accepted, ['add', 'get_count', 'reset']);
    assert.deepEqual(
      v.refused.map((x) => [x.name, x.code]),
      [
        ['Add', 'bad_name'],
        ['a__b', 'bad_name'],
        [`a${'b'.repeat(32)}`, 'bad_name'],
        ['get_count', 'duplicate'],
        ['patterned', 'bad_schema'],
        ['quiet', 'bad_description'],
        ['', 'bad_tool'],
      ],
    );
    assert.match(v.refused[4].message, /patterns are not supported/);
  });

  it('at most 32 tools and 512 KB', () => {
    const r = createToolRegistry();
    const many = Array.from({ length: 33 }, (_, i) => wsTool(`t${String(i).padStart(2, '0')}`));
    const v = r.setWorkspace('T1', 'L1', registration({ tools: many }));
    assert.equal(v.accepted.length, 32);
    assert.deepEqual(v.refused.map((x) => [x.name, x.code]), [['t32', 'too_many']]);
    const big = r.setWorkspace('T2', 'L2', registration({ tools: [wsTool('a', { description: 'x'.repeat(600 * 1024) })] }));
    assert.deepEqual(big.accepted, []);
    assert.deepEqual(big.refused.map((x) => x.code), ['too_large']);
  });

  it('cleans text, caps it, makes an unknown risk destructive, and bounds the stall window', () => {
    const r = createToolRegistry();
    r.setWorkspace(
      'T1',
      'L1',
      registration({
        pluginName: 'Workspace\u202e demo',
        tools: [
          wsTool('a', { description: `Line one\nline two\u2028and \u202eevil ${'x'.repeat(2000)}`, title: 't'.repeat(300), risk: 'harmless', timeoutS: 0 }),
          wsTool('b', { risk: 'compute', timeoutS: 9999 }),
          wsTool('c'),
        ],
      }),
    );
    const [a, b, c] = r.toolsFor(ctx());
    assert.ok(a.description.startsWith('Line one line two and evil '));
    assert.equal(a.description.length, 1024);
    assert.equal(a.title.length, 200);
    assert.equal(a.risk, 'destructive');
    assert.equal(b.risk, 'compute');
    assert.deepEqual([a.stallMs, b.stallMs, c.stallMs], [1_000, 600_000, 60_000]);
    assert.equal(a.source.pluginName, 'Workspace demo');
    assert.equal(a.projectData, true);
  });

  it('records its plugin epoch; a null registration removes the tab', () => {
    const r = createToolRegistry();
    r.setWorkspace('T1', 'L1', registration());
    assert.equal(r.workspaceOf('T1').epoch, pluginEpoch('ai-demo'));
    r.setWorkspace('T1', 'L1', null);
    assert.equal(r.workspaceOf('T1'), null);
    assert.deepEqual(names(r.toolsFor(ctx())), []);
  });
});

describe('toolsFor', () => {
  it('host tools first, then the tab’s workspace tools, each by name; stable bytes and memoized definitions', () => {
    const r = createToolRegistry({ hostTools: [hostTool('zeta'), hostTool('alpha')] });
    r.setWorkspace('T1', 'L1', registration());
    const first = r.toolsFor(ctx());
    assert.deepEqual(names(first), ['alpha', 'zeta', 'ai-demo__add', 'ai-demo__get_count', 'ai-demo__reset']);
    const defs1 = providerTools(first);
    // The same registration again (a reconnect, a re-POST): the same bytes and the same objects.
    r.setWorkspace('T1', 'L2', registration());
    const defs2 = providerTools(r.toolsFor(ctx()));
    assert.equal(JSON.stringify(defs2), JSON.stringify(defs1));
    defs1.forEach((d, i) => assert.equal(defs2[i], d));
    assert.ok(Object.isFrozen(defs1[0]));
  });

  it('only the turn’s own tab, its own project, and only while its link is connected', () => {
    const r = createToolRegistry({ hostTools: [hostTool('alpha')] });
    r.setWorkspace('T1', 'L1', registration());
    r.setWorkspace('T2', 'L2', registration({ projectId: 'p2', tools: [wsTool('other')] }));
    assert.deepEqual(names(r.toolsFor(ctx({ tab: 'T2', projectId: 'p2' }))), ['alpha', 'ai-demo__other']);
    assert.deepEqual(names(r.toolsFor(ctx({ tab: 'T3' }))), ['alpha']);
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null }))), ['alpha']);
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: 'p2' }))), ['alpha'], 'another project');
    r.setConnected('T1', 'L1', false);
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha'], 'a dormant registration offers nothing');
    const add = r.lookup(ctx({ tab: 'T2', projectId: 'p2' }), 'ai-demo__other');
    assert.equal(add.available(ctx({ tab: 'T2', projectId: 'p2' })), true);
    r.setConnected('T1', 'L9', true);
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha', 'ai-demo__add', 'ai-demo__get_count', 'ai-demo__reset']);
    assert.equal(r.workspaceOf('T1').link, 'L9');
  });

  it('host tools a context can’t use are not offered', () => {
    const r = createToolRegistry({ hostTools: [hostTool('alpha'), hostTool('needs_project', 0, (c) => (c.projectId ? true : 'Open a project.'))] });
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: null, tab: null }))), ['alpha']);
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null }))), ['alpha', 'needs_project']);
  });

  it('per request: 40 tools (cloud) or 24 (local); workspace tools kept first, the lowest-priority host tools dropped', () => {
    const host = Array.from({ length: 30 }, (_, i) => hostTool(`h${String(i).padStart(2, '0')}`, i));
    const r = createToolRegistry({ hostTools: host });
    r.setWorkspace('T1', 'L1', registration({ tools: Array.from({ length: 20 }, (_, i) => wsTool(`w${String(i).padStart(2, '0')}`)) }));
    const cloud = r.selectTools(ctx());
    assert.equal(cloud.tools.length, REQUEST_MAX_TOOLS.cloud);
    assert.equal(cloud.tools.filter((t) => t.source.kind === 'workspace').length, 20);
    assert.deepEqual(cloud.dropped, host.slice(0, 10).map((t) => t.name), 'the ten lowest priorities');
    assert.deepEqual(names(cloud.tools.slice(0, 20)), host.slice(10).map((t) => t.name), 'host tools still first, by name');
    const local = r.selectTools(ctx({ local: true }));
    assert.equal(local.tools.length, REQUEST_MAX_TOOLS.local);
    assert.deepEqual(names(local.tools.filter((t) => t.source.kind === 'host')), ['h26', 'h27', 'h28', 'h29']);
    assert.deepEqual(r.toolsFor(ctx({ local: true })).map((t) => t.name), names(local.tools));
    // A page with more tools than a local request holds: the cap still holds.
    r.setWorkspace('T1', 'L1', registration({ tools: Array.from({ length: 32 }, (_, i) => wsTool(`w${String(i).padStart(2, '0')}`)) }));
    const crowded = r.selectTools(ctx({ local: true }));
    assert.equal(crowded.tools.length, 24);
    assert.equal(crowded.tools.filter((t) => t.source.kind === 'host').length, 0);
    assert.ok(crowded.dropped.includes('ai-demo__w31'));
  });

  it('other sources (a later phase) join through registerToolSource, fenced the same way', () => {
    const r = createToolRegistry({ hostTools: [hostTool('alpha')] });
    const fromPlugin = { ...hostTool('heat__report'), source: { kind: 'plugin', plugin: 'heat', method: 'report', epoch: pluginEpoch('heat') } };
    const off = r.registerToolSource(() => [fromPlugin]);
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha', 'heat__report']);
    bumpPluginEpoch('heat');
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha']);
    off();
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha']);
  });

  it('the host’s own tools: app_status, project_summary, explain_ready, never connection_check', () => {
    const tools = createHostTools({ hostGet: async () => ({}), assistant: async () => ({ provider: 'off', model: '' }), version: async () => '0', plugins: () => [] });
    const r = createToolRegistry({ hostTools: tools });
    assert.deepEqual(names(r.toolsFor(ctx())), ['app_status', 'explain_ready', 'project_summary']);
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: null, tab: null }))), ['app_status']);
    assert.equal(r.lookup(ctx(), 'connection_check'), null);
    assert.ok(tools.every((t) => t.risk === 'read' && t.source.kind === 'host'));
    assert.equal(connectionCheckTool().name, 'connection_check');
  });
});

describe('running a workspace tool', () => {
  it('reaches the page by its own name, with its stall window', async () => {
    const r = createToolRegistry();
    const calls = [];
    r.setWorkspace('T1', 'L1', registration({ tools: [wsTool('add', { inputSchema: BY, timeoutS: 30 })], invoke: async (c) => (calls.push(c), { ok: true, data: { count: 2 }, summary: 'added' }) }));
    const [add] = r.toolsFor(ctx());
    const out = await add.run({ by: 2 }, { signal: new AbortController().signal, ctx: ctx(), turn: 't-1', progress() {} });
    assert.deepEqual(out, { ok: true, data: { count: 2 }, summary: 'added' });
    assert.deepEqual([calls[0].tool, calls[0].input, calls[0].timeoutS, calls[0].turn], ['add', { by: 2 }, 30, 't-1']);
    r.setWorkspace('T1', 'L1', registration({ tools: [wsTool('add')] }));
    const noRelay = await r.toolsFor(ctx())[0].run({}, { signal: new AbortController().signal, ctx: ctx(), turn: 't', progress() {} });
    assert.equal(noRelay.error.code, 'tab_disconnected');
  });
});

describe('the plugin-epoch fence', () => {
  it('turning the plugin off, swapping or resetting it removes its tools at once; another plugin’s change does not', async () => {
    const r = createToolRegistry({ hostTools: [hostTool('alpha')] });
    let invoked = 0;
    r.setWorkspace('T1', 'L1', registration({ invoke: async () => (invoked++, { ok: true, summary: 'ran' }) }));
    const before = r.toolsFor(ctx());
    assert.equal(before.length, 4);
    bumpPluginEpoch('another-plugin');
    assert.equal(r.toolsFor(ctx()).length, 4);
    bumpPluginEpoch('ai-demo');
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha']);
    const add = before.find((t) => t.localName === 'add');
    assert.equal(add.available(ctx()), 'Workspace demo was turned off or replaced.');
    assert.equal(r.lookup(ctx(), 'ai-demo__add'), null);
    // A call resolved before the bump (from the step's offered list) is refused, not run.
    const out = await add.run({ by: 1 }, { signal: new AbortController().signal, ctx: ctx(), turn: 't', progress() {} });
    assert.deepEqual([out.ok, out.error.code], [false, 'plugin_off']);
    assert.equal(invoked, 0);
    // A fresh registration under the new epoch offers them again.
    r.setWorkspace('T1', 'L1', registration());
    assert.equal(r.toolsFor(ctx()).length, 4);
    bumpPluginEpoch('*');
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha'], "'*' fences every plugin");
  });
});
