// The tool registry (Foundation spec 7.1, 7.3, 7.5, 10.1; core host tools spec C8): provider-safe
// names and plugin slugs, what a registration may hold and why a tool is refused, stable order
// and bytes (a workspace's tools first in a workspace), places, the cloud cap and the local
// budget, tab, project and connection scoping, and the plugin-epoch fence
// that removes a plugin's tools the moment it is turned off, swapped or reset: with the
// page relay, before the worker answers, and a frame's pinned epoch is refused after.
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-registry-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { createToolRegistry, pluginSlug, workspaceToolName, providerTools, PROVIDER_TOOL_NAME, TOOL_NAME_MAX, REQUEST_MAX_TOOLS, LOCAL_BUDGET, localBudget, placeFor, toolTokens } = await import(
  '../assistant/registry.ts'
);
const { emitSchema } = await import('../assistant/schema.ts');
const { bumpPluginEpoch, pluginEpoch } = await import('../../foam-runner.js');
const { createHostTools, connectionCheckTool } = await import('../assistant/host-tools.ts');

const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
const BY = { type: 'object', properties: { by: { type: 'integer', minimum: -100, maximum: 100 } }, required: ['by'], additionalProperties: false };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const wsTool = (name, extra = {}) => ({ name, description: `Does ${name}.`, inputSchema: EMPTY, risk: 'read', ...extra });
const DEMO = () => [wsTool('get_count'), wsTool('add', { risk: 'edit', inputSchema: BY }), wsTool('reset', { risk: 'destructive' })];
const registration = (o = {}) => ({ plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'Counter', projectId: 'p1', studyId: 's1', tools: DEMO(), ...o });
const ctx = (o = {}) => ({ tab: 'T1', projectId: 'p1', simulationId: 's1', cloud: true, local: false, ...o });

function hostTool(name, priority = 0, available = () => true, extra = {}) {
  return {
    name,
    localName: name,
    title: name,
    description: `Host ${name}.`,
    ...extra,
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

  it("keeps a tool's confirm note (CAD tools spec H10): cleaned and cut to 120 characters; one that is not text, or nothing once cleaned, is none", () => {
    const r = createToolRegistry();
    r.setWorkspace(
      'T1',
      'L1',
      registration({
        tools: [
          wsTool('a', { risk: 'destructive', confirm: 'Deletes\u2028the rows;\u202e Ctrl+Z\u0007 brings them back.' }),
          wsTool('b', { risk: 'destructive', confirm: 'x'.repeat(300) }),
          wsTool('c', { risk: 'destructive', confirm: 5 }),
          wsTool('d', { risk: 'destructive', confirm: ' \u0007\n ' }),
          wsTool('e', { risk: 'destructive' }),
        ],
      }),
    );
    const byName = Object.fromEntries(r.toolsFor(ctx()).map((t) => [t.localName, t]));
    assert.equal(byName.a.confirmNote, 'Deletes the rows; Ctrl+Z brings them back.');
    assert.equal(byName.b.confirmNote, 'x'.repeat(120));
    for (const n of ['c', 'd', 'e']) assert.equal(Object.hasOwn(byName[n], 'confirmNote'), false, n);
  });

  it('cleans and caps the text inside a schema too, and refuses enum or const values and property names with controls', () => {
    const r = createToolRegistry();
    const dirty = `Body \u202espoof\u0007 ${'y'.repeat(3000)}`;
    const schema = {
      type: 'object',
      properties: {
        body: { type: 'string', description: dirty, title: `T\u2028${'t'.repeat(300)}` },
        list: { type: 'array', items: { type: 'object', properties: { leaf: { type: 'integer', description: 'Leaf\u202e.' } }, additionalProperties: false } },
        mode: { type: 'string', enum: ['fast', 'fine'] },
      },
      additionalProperties: false,
    };
    const v = r.setWorkspace(
      'T1',
      'L1',
      registration({
        tools: [
          wsTool('ok', { inputSchema: schema }),
          wsTool('bad_enum', { inputSchema: obj({ m: { type: 'string', enum: ['a', 'b\u202e'] } }) }),
          wsTool('bad_const', { inputSchema: obj({ m: { type: 'string', const: 'c\u0000' } }) }),
          wsTool('bad_prop', { inputSchema: obj({ ['p\u202e']: { type: 'string' } }) }),
        ],
      }),
    );
    assert.deepEqual(v.accepted, ['ok']);
    assert.deepEqual(v.refused.map((x) => [x.name, x.code]), [
      ['bad_enum', 'bad_schema'],
      ['bad_const', 'bad_schema'],
      ['bad_prop', 'bad_schema'],
    ]);
    const [tool] = r.toolsFor(ctx());
    const body = tool.schema.properties.body;
    assert.ok(body.description.startsWith('Body spoof y'), body.description.slice(0, 20));
    assert.equal(body.description.length, 1024);
    assert.equal(body.title.length, 200);
    const strings = [];
    const walk = (v) => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings.push(k), walk(x);
    };
    walk(tool.schema);
    assert.ok(!strings.some((x) => /[\p{Cc}\u2028\u202e]/u.test(x)), 'no control anywhere in what the provider gets');
    assert.equal(tool.schema.properties.list.items.properties.leaf.description, 'Leaf .');
    assert.deepEqual(tool.schema.properties.mode.enum, ['fast', 'fine'], 'values are kept exactly');
    // The page's own object is never changed.
    assert.equal(schema.properties.body.description, dirty);
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
  it('in a workspace its tools first, then the host’s; elsewhere the host’s first; each by name; stable bytes and memoized definitions', () => {
    const r = createToolRegistry({ hostTools: [hostTool('zeta'), hostTool('alpha')] });
    r.setWorkspace('T1', 'L1', registration());
    const first = r.toolsFor(ctx());
    assert.deepEqual(names(first), ['ai-demo__add', 'ai-demo__get_count', 'ai-demo__reset', 'alpha', 'zeta']);
    assert.deepEqual(names(r.toolsFor(ctx({ place: 'workspace' }))), names(first), 'the place given is the same place');
    // Not a workspace (a caller that says so): the host's first.
    assert.deepEqual(names(r.toolsFor(ctx({ place: 'workbench' }))), ['alpha', 'zeta', 'ai-demo__add', 'ai-demo__get_count', 'ai-demo__reset']);
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
    assert.deepEqual(names(r.toolsFor(ctx({ tab: 'T2', projectId: 'p2' }))), ['ai-demo__other', 'alpha']);
    assert.deepEqual(names(r.toolsFor(ctx({ tab: 'T3' }))), ['alpha']);
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null }))), ['alpha']);
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: 'p2' }))), ['alpha'], 'another project');
    r.setConnected('T1', 'L1', false);
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha'], 'a dormant registration offers nothing');
    const add = r.lookup(ctx({ tab: 'T2', projectId: 'p2' }), 'ai-demo__other');
    assert.equal(add.available(ctx({ tab: 'T2', projectId: 'p2' })), true);
    // A new link does not bring the old registration back: the page must register again.
    r.setConnected('T1', 'L9', true);
    assert.deepEqual(names(r.toolsFor(ctx())), ['alpha'], 'a new link offers nothing until the page registers on it');
    assert.deepEqual([r.workspaceOf('T1').link, r.workspaceOf('T1').connected], ['L1', false]);
    // Its own link coming back does.
    r.setConnected('T1', 'L1', true);
    assert.deepEqual(names(r.toolsFor(ctx())), ['ai-demo__add', 'ai-demo__get_count', 'ai-demo__reset', 'alpha']);
    // A registration on the new link replaces it.
    r.setConnected('T1', 'L1', false);
    r.setWorkspace('T1', 'L9', registration({ tools: [wsTool('get_count')] }));
    assert.deepEqual(names(r.toolsFor(ctx())), ['ai-demo__get_count', 'alpha']);
    assert.equal(r.lookup(ctx(), 'ai-demo__get_count').source.link, 'L9');
  });

  it('host tools a context can’t use are not offered', () => {
    const r = createToolRegistry({ hostTools: [hostTool('alpha'), hostTool('needs_project', 0, (c) => (c.projectId ? true : 'Open a project.'))] });
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: null, tab: null }))), ['alpha']);
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null }))), ['alpha', 'needs_project']);
  });

  it('cloud: 40 tools a request; workspace tools kept first, the lowest-priority host tools dropped (pinned ones kept), the workspace first in order', () => {
    const host = Array.from({ length: 30 }, (_, i) => hostTool(`h${String(i).padStart(2, '0')}`, i, undefined, i === 0 ? { pinned: true } : {}));
    const r = createToolRegistry({ hostTools: host });
    r.setWorkspace('T1', 'L1', registration({ tools: Array.from({ length: 20 }, (_, i) => wsTool(`w${String(i).padStart(2, '0')}`)) }));
    const cloud = r.selectTools(ctx());
    assert.deepEqual(REQUEST_MAX_TOOLS, { cloud: 40 }, 'no local count cap');
    assert.equal(cloud.tools.length, REQUEST_MAX_TOOLS.cloud);
    assert.equal(cloud.budget, null);
    assert.equal(cloud.tooSmall, false);
    assert.equal(cloud.tools.filter((t) => t.source.kind === 'workspace').length, 20);
    assert.deepEqual(names(cloud.dropped), host.slice(1, 11).map((t) => t.name), 'the ten lowest priorities, the pinned one kept');
    assert.deepEqual(names(cloud.tools.slice(0, 20)), Array.from({ length: 20 }, (_, i) => `ai-demo__w${String(i).padStart(2, '0')}`), 'the workspace first, by name');
    assert.deepEqual(names(cloud.tools.slice(20)), ['h00', ...host.slice(11).map((t) => t.name)], 'then the host tools, by name');
    assert.deepEqual(cloud.dropped[0].contexts, ['Home', 'Workbench', 'Workspaces'], 'where each is offered');
  });

  it('local: no count cap, a budget of tool tokens: half the context, 16,384 when unknown; 60 small tools fit a 128K context', () => {
    assert.deepEqual([localBudget(131_072), localBudget(8192), localBudget(4096), localBudget(null), localBudget(0), localBudget(undefined)], [65_536, 4096, 2048, 16_384, 16_384, 16_384]);
    assert.equal(LOCAL_BUDGET.unknown, 16_384);
    const host = Array.from({ length: 60 }, (_, i) => hostTool(`h${String(i).padStart(2, '0')}`, i));
    const r = createToolRegistry({ hostTools: host });
    const sel = r.selectTools(ctx({ tab: null, local: true, cloud: false, budgetTokens: localBudget(131_072) }));
    assert.equal(sel.tools.length, 60);
    assert.deepEqual([sel.dropped, sel.budget, sel.tooSmall], [[], 65_536, false]);
    // The same tools with no budget given: the unknown one.
    assert.equal(r.selectTools(ctx({ tab: null, local: true, cloud: false })).budget, LOCAL_BUDGET.unknown);
  });

  it("a tool's tokens: its definition as a local server is sent it, in characters, divided by 3.5, rounded up", () => {
    const t = hostTool('alpha', 0, undefined, { description: 'x'.repeat(500) });
    const chars = JSON.stringify({ type: 'function', function: { name: 'alpha', description: t.description, parameters: emitSchema('openai_compatible', t.schema) } }).length;
    assert.equal(toolTokens(t), Math.ceil(chars / 3.5));
    assert.equal(toolTokens({ ...t }), toolTokens(t), 'the same content, the same count');
  });

  it('local over the budget: host tools go by priority (the later name first on a tie), then the workspace’s by theirs, pinned tools last; each drop names where it is offered', () => {
    // About 300 tokens each.
    const big = (name, priority, extra = {}) => hostTool(name, priority, undefined, { description: `${name} ${'x'.repeat(1000)}`, ...extra });
    const host = [big('h_low', 10, { contexts: ['home', 'workbench', 'workspace'] }), big('h_mid', 50), big('h_tie_a', 30), big('h_tie_b', 30), big('h_pin', 0, { pinned: true })];
    const r = createToolRegistry({ hostTools: host });
    const text = 'y'.repeat(1000);
    r.setWorkspace(
      'T1',
      'L1',
      registration({ pluginName: 'Magnusim CAD', workspace: 'part', workspaceName: 'Part', tools: [wsTool('keep', { description: text, priority: 90 }), wsTool('cheap', { description: text }), wsTool('drop', { description: text, priority: 5 })] }),
    );
    const per = toolTokens(r.lookup(ctx(), 'h_low'));
    const all = r.selectTools(ctx({ local: true, cloud: false, budgetTokens: 100_000 }));
    assert.equal(all.tools.length, 8);
    const total = all.tools.reduce((n, t) => n + toolTokens(t), 0);
    // Room for all but four.
    const sel = r.selectTools(ctx({ local: true, cloud: false, budgetTokens: total - 3 * per - 10 }));
    assert.deepEqual(names(sel.dropped), ['h_low', 'h_tie_b', 'h_tie_a', 'h_mid']);
    assert.deepEqual(sel.dropped[0].contexts, ['Home', 'Workbench', 'Workspaces']);
    assert.deepEqual(names(sel.tools), ['ai-demo__cheap', 'ai-demo__drop', 'ai-demo__keep', 'h_pin'], 'the workspace first in a workspace');
    // Tighter: the workspace's lowest goes next, then its default 50, then its 90; the pinned one last.
    const tight = r.selectTools(ctx({ local: true, cloud: false, budgetTokens: toolTokens(r.lookup(ctx(), 'h_pin')) + 5 }));
    assert.deepEqual(names(tight.dropped).slice(4), ['ai-demo__drop', 'ai-demo__cheap', 'ai-demo__keep']);
    assert.deepEqual(tight.dropped[4].contexts, ['Magnusim CAD Part']);
    assert.deepEqual(names(tight.tools), ['h_pin']);
    assert.equal(tight.tooSmall, false);
    // Not even the pinned one: nothing may be offered.
    const none = r.selectTools(ctx({ local: true, cloud: false, budgetTokens: 10 }));
    assert.deepEqual([none.tools, none.tooSmall, names(none.dropped).at(-1)], [[], true, 'h_pin']);
  });

  it('places: a host tool only where its contexts say; the tab’s workspace tools in their workspace; a tool with no contexts everywhere', () => {
    const r = createToolRegistry({
      hostTools: [
        hostTool('anywhere'),
        hostTool('home_only', 0, undefined, { contexts: ['home'] }),
        hostTool('bench', 0, undefined, { contexts: ['workbench'] }),
        hostTool('space', 0, undefined, { contexts: ['workspace'] }),
        hostTool('bench_space', 0, undefined, { contexts: ['workbench', 'workspace'] }),
      ],
    });
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null, projectId: null }))), ['anywhere', 'home_only'], 'Home');
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null }))), ['anywhere', 'bench', 'bench_space'], 'the workbench');
    r.setWorkspace('T1', 'L1', registration());
    assert.deepEqual(names(r.toolsFor(ctx())), ['ai-demo__add', 'ai-demo__get_count', 'ai-demo__reset', 'anywhere', 'bench_space', 'space'], 'the workspace');
    assert.deepEqual(r.lookup(ctx(), 'ai-demo__add').contexts, ['workspace']);
    // The place a caller gives wins over the tab's (core registration, lane C).
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null, projectId: null, place: 'workbench' }))), ['anywhere', 'bench', 'bench_space']);
    // A dormant registration: the tab is its project's workbench again.
    r.setConnected('T1', 'L1', false);
    assert.equal(r.placeOf('T1', 'p1'), 'workbench');
    assert.deepEqual([placeFor(null, null), placeFor(null, 'p1'), placeFor({ connected: true, reg: { projectId: 'p1' } }, 'p1'), placeFor({ connected: true, reg: { projectId: 'p2' } }, 'p1')], [
      'home',
      'workbench',
      'workspace',
      'workbench',
    ]);
  });

  it('a workspace tool’s priority comes from its registration (0-100, default 50); bytes stay the same from step to step', () => {
    const r = createToolRegistry({ hostTools: [hostTool('alpha')] });
    r.setWorkspace('T1', 'L1', registration({ tools: [wsTool('a', { priority: 0 }), wsTool('b', { priority: 100 }), wsTool('c'), wsTool('d', { priority: 101 }), wsTool('e', { priority: 2.5 })] }));
    assert.deepEqual(
      r.toolsFor(ctx()).filter((t) => t.source.kind === 'workspace').map((t) => [t.localName, t.priority]),
      [
        ['a', 0],
        ['b', 100],
        ['c', 50],
        ['d', 50],
        ['e', 50],
      ],
    );
    const one = JSON.stringify(providerTools(r.selectTools(ctx({ local: true, cloud: false, budgetTokens: 5000 })).tools));
    const two = JSON.stringify(providerTools(r.selectTools(ctx({ local: true, cloud: false, budgetTokens: 5000 })).tools));
    assert.equal(two, one);
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

  it('the host’s own tools, by where the turn is (spec 15), never connection_check', () => {
    const tools = createHostTools({ hostCall: async () => ({}), assistant: async () => ({ provider: 'off', model: '' }), version: async () => '0', plugins: () => [] });
    const r = createToolRegistry({ hostTools: tools });
    // A workspace's tab (ctx() has one).
    assert.deepEqual(names(r.toolsFor(ctx())), ['app_status', 'chat_history', 'explain_ready', 'project_summary', 'read_setup']);
    // The workbench: a project, no workspace tab.
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null }))), [
      'app_status',
      'catalog',
      'chat_history',
      'delete',
      'explain_ready',
      'import_file',
      'project_edit',
      'project_summary',
      'projects',
      'read_results',
      'read_setup',
      'setup_edit',
      'study_edit',
    ]);
    // Home: no project.
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: null, tab: null }))), [
      'app_status',
      'catalog',
      'chat_history',
      'delete',
      'explain_ready',
      'project_edit',
      'project_summary',
      'projects',
      'read_results',
      'read_setup',
    ]);
    assert.equal(r.lookup(ctx(), 'connection_check'), null);
    assert.ok(tools.every((t) => t.source.kind === 'host'));
    const risks = Object.fromEntries(tools.map((t) => [t.name, t.risk]));
    assert.deepEqual(risks, {
      app_status: 'read',
      catalog: 'read',
      projects: 'read',
      project_summary: 'read',
      read_setup: 'read',
      explain_ready: 'read',
      read_results: 'read',
      project_edit: 'edit',
      study_edit: 'edit',
      setup_edit: 'edit',
      import_file: 'compute',
      delete: 'destructive',
      chat_history: 'read',
    });
    assert.equal(connectionCheckTool().name, 'connection_check');
  });

  it('provider definitions mark the workspace’s tools, never the host’s (a cloud provider that cannot compile them strictly gets them without strict, CAD tools spec H8)', () => {
    const r = createToolRegistry({ hostTools: [hostTool('alpha')] });
    r.setWorkspace('T1', 'L1', registration());
    const defs = providerTools(r.toolsFor(ctx()));
    assert.deepEqual(
      defs.map((d) => [d.name, d.workspace ?? null]),
      [
        ['ai-demo__add', true],
        ['ai-demo__get_count', true],
        ['ai-demo__reset', true],
        ['alpha', null],
      ],
    );
    assert.ok(!('workspace' in defs[3]), 'a host tool carries no flag at all');
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

// The fence with the page relay (spec 7.5, 8.4): the relay hears each bump at once and drops
// the plugin's registrations and calls before the worker answers; a frame's pinned epoch then
// stays refused, and a fresh frame needs its plugin loaded.
const { makeManager, relayServer, demoTools, runTool, until } = await import('./assistant-harness.js');
const { beginAssistantLifetime, resetAssistantState } = await import('../assistant/state.ts');
after(() => resetAssistantState());

/** A worker whose call waits until the test releases it (as a slow plugins.disable). */
function heldWorker() {
  const w = { calls: [], answered: false, release: null };
  w.call = (method, params) =>
    new Promise((resolve) => {
      w.calls.push({ method, params });
      w.release = (answer) => {
        w.answered = true;
        resolve(answer);
      };
    });
  return w;
}

/** The plugin-off route's order (routes.ts POST /api/plugins/:key/disable): bump, the worker, bump. */
async function disablePlugin(worker, key) {
  bumpPluginEpoch(key);
  const answer = await worker.call('plugins.disable', { key });
  if (answer.ok) bumpPluginEpoch(key);
  return answer;
}

describe('the fence and the page relay', { timeout: 30_000 }, () => {
  const relayCtx = (tab) => ({ tab, projectId: 'p1', simulationId: 's1', cloud: false, local: true });
  const servers = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it('bumpPluginEpoch removes the tools and fails a pending call before a held fake worker answers; the page hears `unregistered`', async () => {
    // The real plugin-off route bumps before it waits for the worker, as disablePlugin does here.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'routes.ts'), 'utf8');
    const route = src.slice(src.indexOf("router.post('/api/plugins/:key/disable'"));
    const bumpAt = route.indexOf('bumpPluginEpoch(key);');
    const workerAt = route.indexOf("await workerAnswer(deps, 'plugins.disable'");
    assert.ok(bumpAt > 0 && workerAt > bumpAt, 'the route bumps, then waits for the worker');
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible' });
    const s = await relayServer(m);
    servers.push(s);
    const page = await s.page();
    const link = await page.open();
    assert.equal((await s.register(link, 1)).status, 200);
    const c = relayCtx(page.tab);
    const add = m.registry.toolsFor(c).find((t) => t.localName === 'add');
    const call = runTool(add, { by: 1 }, c);
    const inv = await page.frame('invoke');
    await s.progress(link, inv.call, { ack: true });
    let out = null;
    call.promise.then((o) => (out = o));
    const worker = heldWorker();
    const disable = disablePlugin(worker, 'ai-demo');
    await until(() => out, 2000, 'the call to fail');
    assert.equal(worker.answered, false, 'the worker has not answered');
    assert.deepEqual([out.ok, out.error.code, out.error.message], [false, 'plugin_off', 'Workspace demo was turned off or replaced while the tool ran; it may or may not have finished.']);
    assert.deepEqual(m.registry.toolsFor(c), [], 'its tools are gone');
    assert.deepEqual(await s.tabs(), []);
    assert.deepEqual(await page.frame('unregistered'), { reason: 'plugin_off' });
    assert.equal(s.relay.snapshot()[page.tab].pending, 0);
    assert.equal(worker.answered, false, 'all of it before the worker answered');
    assert.deepEqual((await s.result(link, inv.call, { ok: true, result: 'late' })).json, { ok: true, stale: true }, 'its late answer is ignored');
    worker.release({ ok: true });
    assert.deepEqual(await disable, { ok: true });
  });

  it('after the bump a re-POST with the frame’s old epoch is 409 plugin_changed; a fresh POST while pluginLoaded is null is 409 plugin_off; loaded again, a fresh frame registers; after a server restart an old token counts as fresh', async () => {
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible' });
    const s = await relayServer(m);
    servers.push(s);
    const page = await s.page();
    const link = await page.open();
    const first = await s.register(link, 1);
    const token = first.json.epoch;
    assert.equal((await s.register(link, 2, demoTools(), { epoch: token })).status, 200, 'pinned and unchanged: taken');
    const other = await s.register(link, 3, demoTools(), { epoch: token, workspace: { project_id: 'p1', plugin: 'other-plugin', workspace: 'Other', study_id: '' } });
    assert.deepEqual([other.status, other.json.code], [409, 'plugin_changed'], "another plugin's frame can't use it");
    bumpPluginEpoch('ai-demo');
    assert.deepEqual(await page.frame('unregistered', 0), { reason: 'plugin_off' });
    const changed = await s.register(link, 4, demoTools(), { epoch: token });
    assert.deepEqual([changed.status, changed.json.code], [409, 'plugin_changed']);
    assert.match(changed.json.error, /^Workspace demo was turned off, replaced or reset/);
    s.loaded.on = false;
    const fresh = await s.register(link, 5);
    assert.deepEqual([fresh.status, fresh.json.code], [409, 'plugin_off']);
    assert.deepEqual(await s.tabs(), []);
    s.loaded.on = true;
    const back = await s.register(link, 6);
    assert.equal(back.status, 200);
    assert.notEqual(back.json.epoch, token, 'a new token under the new epoch');
    // A server restart in this process (Vite's): another boot id, so the token counts as fresh.
    beginAssistantLifetime();
    s.loaded.on = false;
    const offAfter = await s.register(link, 7, demoTools(), { epoch: back.json.epoch });
    assert.deepEqual([offAfter.status, offAfter.json.code], [409, 'plugin_off']);
    s.loaded.on = true;
    const restarted = await s.register(link, 8, demoTools(), { epoch: back.json.epoch });
    assert.equal(restarted.status, 200);
    assert.notEqual(restarted.json.epoch, back.json.epoch);
    // '*' (Reload) fences every plugin's frames.
    bumpPluginEpoch('*');
    assert.deepEqual(await page.frame('unregistered', 1), { reason: 'plugin_off' });
    assert.equal((await s.register(link, 9, demoTools(), { epoch: restarted.json.epoch })).json.code, 'plugin_changed');
  });

  it('the live registry read again after a plugin change: a frame that registers before that read lands is kept but offered to nobody, then goes (`unregistered`) when its plugin is off, or is offered when it is on; with no live registry loaded, the same', async () => {
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible' });
    const s = await relayServer(m);
    servers.push(s);
    const page = await s.page();
    const link = await page.open();
    assert.equal((await s.register(link, 1)).status, 200);
    const c = relayCtx(page.tab);
    assert.equal(m.registry.toolsFor(c).length, 4);
    // Turned off: bump, the worker (worker.ts says the registry changed as its answer comes), bump.
    const worker = heldWorker();
    const disable = disablePlugin(worker, 'ai-demo');
    assert.deepEqual(await page.frame('unregistered', 0), { reason: 'plugin_off' });
    s.registryChanged();
    worker.release({ ok: true });
    assert.deepEqual(await disable, { ok: true });
    // The live registry is read again a worker round trip later: until then it still lists the plugin.
    const fresh = await s.register(link, 2);
    assert.equal(fresh.status, 200, 'a new frame of it (no epoch): kept, the registry does not say yet');
    assert.deepEqual(m.registry.toolsFor(c), [], 'offered to nobody until it does');
    assert.equal((await s.tabs())[0].tools.length, 4);
    // The read lands: the plugin is off. The registration goes as on a bump, before it is listed.
    s.loaded.on = false;
    s.registryRead();
    assert.deepEqual(await s.tabs(), []);
    assert.deepEqual(await page.frame('unregistered', 1), { reason: 'plugin_off' });
    assert.equal(m.registry.workspaceOf(page.tab), null);
    const off = await s.register(link, 3);
    assert.deepEqual([off.status, off.json.code], [409, 'plugin_off'], 'from then on a fresh frame is refused');
    // On again, then Reload (bump, the worker, bump): the plugin stays on, and a frame that
    // registered before the read landed is offered once it lands.
    s.loaded.on = true;
    s.registryChanged();
    s.registryRead();
    bumpPluginEpoch('*');
    s.registryChanged();
    bumpPluginEpoch('*');
    assert.equal((await s.register(link, 4)).status, 200);
    assert.deepEqual(m.registry.toolsFor(c), []);
    s.registryRead();
    assert.equal(m.registry.toolsFor(c).length, 4, 'offered: the registry says it is on');
    assert.equal(page.of('unregistered').length, 2, 'nothing more said to the page');
    // No live registry loaded at all (its first read failed): kept, offered to nobody, until one is.
    s.loaded.doc = null;
    const none = await s.register(link, 5);
    assert.equal(none.status, 200, 'not refused for good');
    assert.deepEqual(m.registry.toolsFor(c), []);
    s.registryRead();
    assert.equal(m.registry.toolsFor(c).length, 4);
    // Read without its plugin: it goes at the next offer.
    s.loaded.doc = null;
    assert.equal((await s.register(link, 6)).status, 200);
    s.loaded.on = false;
    s.registryRead();
    assert.deepEqual(m.registry.toolsFor(c), []);
    assert.deepEqual(await page.frame('unregistered', 2), { reason: 'plugin_off' });
    assert.equal(m.registry.workspaceOf(page.tab), null);
  });
});
