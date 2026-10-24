// The core page of every app tab (core host tools spec C5, C7): its registration in the
// registry's core slot (only core__show and core__view, at their own risk; offered to the tab's
// own turns in its project; the same tools keep their ToolDefs when the tab moves), the relay's
// slot 'core' (no plugin or epoch check, its calls marked and its error codes kept, dormant with
// its link), turns that bind to their window from Home and the workbench and follow it to another
// project (the conversation moves, the new project's privacy is asked before the next request),
// another project's read and the project list asked about per call (Don't send: the call is
// refused, the turn goes on), and a local model never asked.
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-core-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { makeManager, relayServer, demoTools, DEMO_WORKSPACE, runTool, startTurn, settled, eventsOf, answerGates, until, hostTool } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const { createToolRegistry, CORE_TOOLS, toolTokens } = await import('../assistant/registry.ts');
const { sourceLabel, otherProjectOf } = await import('../assistant/runner.ts');
const { consentCount, defaultSettings, withConsent } = await import('../assistant/settings.ts');
const { LIST_CONSENT_KEY } = await import('../assistant/privacy.ts');

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
/** The core page's tools as the page registers them (src/assistant/coreTools.ts, in short). */
const coreTools = (o = {}) => [
  { name: 'show', title: 'Show a place in Magnusim', description: 'Moves this window.', inputSchema: EMPTY, risk: 'edit', timeoutS: 120, ...(o.show || {}) },
  { name: 'view', title: 'Picture or move the view', description: 'A picture of the view.', inputSchema: EMPTY, risk: 'read', timeoutS: 60, ...(o.view || {}) },
];
const core = (o = {}) => ({ projectId: 'p1', studyId: 's1', place: 'workbench', tools: coreTools(), ...o });
const ctx = (o = {}) => ({ tab: 'T1', projectId: 'p1', simulationId: 's1', cloud: false, local: true, ...o });
const names = (tools) => tools.map((t) => t.name);

describe('the registry: core slot', () => {
  it('only core__show and core__view, at their own risk and priority; any other name is refused', () => {
    const r = createToolRegistry();
    const v = r.setCore('T1', 'L1', core({ tools: [...coreTools({ show: { risk: 'read' }, view: { risk: 'destructive' } }), { name: 'wipe', description: 'x', inputSchema: EMPTY, risk: 'read' }] }));
    assert.deepEqual(v.accepted, ['show', 'view']);
    assert.deepEqual(v.refused.map((x) => [x.name, x.code]), [['wipe', 'bad_name']]);
    const tools = r.toolsFor(ctx());
    assert.deepEqual(names(tools), ['core__show', 'core__view']);
    assert.deepEqual(tools.map((t) => [t.risk, t.priority, t.source.kind]), [
      ['edit', CORE_TOOLS.show.priority, 'core'],
      ['read', CORE_TOOLS.view.priority, 'core'],
    ]);
    assert.equal(sourceLabel(tools[0].source), 'Magnusim');
    // §12.3, §15: core__show is pinned (how the model reaches another place) and offered everywhere; core__view not in a workspace.
    assert.deepEqual(tools.map((t) => [t.pinned === true, [...t.contexts]]), [
      [true, ['home', 'workbench', 'workspace']],
      [false, ['home', 'workbench']],
    ]);
    // A local budget too small for the rest keeps core__show.
    assert.equal(r.selectTools(ctx({ local: true, budgetTokens: 1 })).tooSmall, true);
    assert.deepEqual(names(r.selectTools(ctx({ local: true, budgetTokens: toolTokens(tools[0]) })).tools), ['core__show']);
    assert.equal(r.fenced(tools[0].source), false, 'no plugin, no fence');
    assert.deepEqual(r.coreOf('T1'), { link: 'L1', connected: true, projectId: 'p1', studyId: 's1', place: 'workbench', tools: ['core__show', 'core__view'], refused: v.refused, guide: '' });
    assert.deepEqual(r.coreTabIds(), ['T1']);
  });

  it("offered only to the tab's own turn in its project; never tab-less; core__view not in a workspace; nothing while dormant", () => {
    const r = createToolRegistry({ hostTools: [hostTool('app_status')] });
    r.setCore('T1', 'L1', core());
    assert.deepEqual(names(r.toolsFor(ctx())), ['app_status', 'core__show', 'core__view']);
    assert.deepEqual(names(r.toolsFor(ctx({ tab: null, projectId: null }))), ['app_status'], 'a tab-less MCP client');
    assert.deepEqual(names(r.toolsFor(ctx({ tab: 'T2' }))), ['app_status'], 'another tab');
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: 'p2' }))), ['app_status'], 'another project');
    r.setCore('T1', 'L1', core({ place: 'workspace' }));
    assert.deepEqual(names(r.toolsFor(ctx())), ['app_status', 'core__show']);
    r.setCore('T1', 'L1', core({ projectId: '', studyId: '', place: 'home' }));
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: null }))), ['app_status', 'core__show', 'core__view'], 'Home');
    r.setCoreConnected('T1', 'L1', false);
    assert.deepEqual(names(r.toolsFor(ctx({ projectId: null }))), ['app_status']);
    r.setCoreConnected('T1', 'L1', true);
    r.setCore('T1', 'L1', null);
    assert.deepEqual([r.coreOf('T1'), names(r.toolsFor(ctx({ projectId: null })))], [null, ['app_status']]);
  });

  it('the same tools on the same link keep their ToolDefs as the tab moves; a project opened since the step began waits for the next step; a new link makes new ones', async () => {
    const r = createToolRegistry();
    const calls = [];
    const invoke = async (c) => {
      calls.push([c.tool, c.timeoutS, c.turn]);
      return { ok: true, summary: 'shown' };
    };
    r.setCore('T1', 'L1', core({ invoke }));
    const [show] = r.toolsFor(ctx());
    r.setCore('T1', 'L1', core({ studyId: 's2', invoke }));
    assert.equal(r.toolsFor(ctx())[0], show, 'the same object');
    assert.equal((await runTool(show, {}, ctx()).promise).ok, true);
    assert.deepEqual(calls, [['show', 120, 't-test']]);
    r.setCore('T1', 'L1', core({ projectId: 'p2', invoke }));
    assert.equal(show.available(ctx()), 'This window opened another project; its tools are offered again from the next step.');
    const out = await runTool(show, {}, ctx()).promise;
    assert.deepEqual([out.ok, out.error.code], [false, 'unavailable']);
    assert.equal(show.available(ctx({ projectId: 'p2' })), true, "the next step's context");
    r.setCore('T1', 'L2', core({ projectId: 'p2', invoke }));
    assert.notEqual(r.toolsFor(ctx({ projectId: 'p2' }))[0], show);
    assert.equal(show.available(ctx({ projectId: 'p2' })), 'This Magnusim window is no longer open.', 'its link went');
  });

  it("core__show's escalation and card come from the page's registration, and the runner's card shows them (C3)", async () => {
    const r = createToolRegistry();
    const asked = [];
    r.setCore('T1', 'L1', core({ escalate: (tool, input) => (asked.push([tool, input.target]), tool === 'show' ? { risk: 'compute', note: 'sends the design', title: 'Allow it?', copy: 'Leaves the part.', detail: [{ label: 'Geometry', value: 'Plate' }] } : null) }));
    const [show, view] = r.toolsFor(ctx());
    const input = { target: 'project' };
    const a = await show.escalate(input);
    assert.deepEqual(a, { risk: 'compute', note: 'Leaves the part.', detail: [{ label: 'Geometry', value: 'Plate' }] });
    assert.deepEqual(show.gateText(input, a), { title: 'Allow it?', copy: 'Leaves the part.', detail: [{ label: 'Geometry', value: 'Plate' }] });
    assert.equal(await view.escalate({ action: 'fit' }), null);
    assert.deepEqual(asked, [['show', 'project'], ['view', undefined]]);
    // Through the runner (which keeps only an escalation's risk, note and rows): the card is the page's.
    const { ToolRunner } = await import('../assistant/runner.ts');
    const cards = [];
    const runner = new ToolRunner({ gates: { ask: async (req) => (cards.push(req), 'deny') } });
    const out = await runner.run({ type: 'tool_call', callId: 'c-show', name: show.name, input: {} }, { owner: { kind: 'turn', id: 't', tab: 'T1' }, ctx: ctx(), signal: new AbortController().signal, offered: new Map([[show.name, show]]) });
    assert.equal(out.code, 'declined');
    assert.deepEqual([cards[0].title, cards[0].copy, cards[0].risk, cards[0].detail], ['Allow it?', 'Leaves the part.', 'compute', [{ label: 'Geometry', value: 'Plate' }]]);
  });
});

// ---------------------------------------------------------------- the relay's core slot

const PROJECTS = { p1: { id: 'p1', title: 'Wing', created_at: null }, p2: { id: 'p2', title: 'Tail', created_at: '2026-10-01T00:00:00Z' } };

async function setup(o = {}) {
  const m = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: PROJECTS, ...(o.manager || {}) });
  const s = await relayServer(m, o);
  servers.push(s);
  return { m, s };
}

const CORE_WHERE = { project_id: 'p1', plugin: 'core', workspace: 'app', title: 'Magnusim', study_id: 's1' };
const registerCore = (s, link, rev, extra = {}) => s.post('/api/assistant/relay/tools', { link, rev, slot: 'core', workspace: { ...CORE_WHERE }, place: 'workbench', tools: coreTools(), ...extra });
const coreTool = (m, tab, localName, projectId = 'p1') => m.registry.toolsFor(ctx({ tab, projectId })).find((t) => t.source.kind === 'core' && t.localName === localName);

describe('the relay: slot core', { timeout: 30_000 }, () => {
  it('taken with no plugin loaded and no epoch; plugin "core", a place and ids or 400; /tabs and the test state show it', async () => {
    const { m, s } = await setup({ loaded: { on: false, doc: {} } });
    const page = await s.page();
    const link = await page.open();
    for (const [what, extra] of [
      ['another plugin', { workspace: { ...CORE_WHERE, plugin: 'ai-demo' } }],
      ['no place', { place: undefined }],
      ['a place that is none', { place: 'cad' }],
      ['Home with a project', { place: 'home' }],
      ['the workbench without one', { workspace: { ...CORE_WHERE, project_id: '' } }],
      ['a bad slot', { slot: 'frame' }],
    ]) {
      const r = await registerCore(s, link, 1, extra);
      assert.equal(r.status, 400, what);
    }
    const r = await registerCore(s, link, 2);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.accepted, r.json.epoch], [['show', 'view'], 'core']);
    const [tab] = await s.tabs();
    assert.deepEqual([tab.tab, tab.connected, tab.workspace, tab.tools], [page.tab, true, null, []]);
    assert.deepEqual(tab.core, { connected: true, project_id: 'p1', study_id: 's1', place: 'workbench', tools: ['core__show', 'core__view'] });
    assert.equal(s.relay.snapshot()[page.tab].core, true);
    // Home: no project.
    assert.equal((await registerCore(s, link, 3, { workspace: { ...CORE_WHERE, project_id: '', study_id: '' }, place: 'home' })).status, 200);
    assert.deepEqual(m.registry.coreOf(page.tab).place, 'home');
    // A lower rev of the slot: stale; the workspace slot keeps its own revs.
    assert.deepEqual([(await registerCore(s, link, 2)).json.code], ['stale_rev']);
    // tools []: withdrawn.
    assert.equal((await registerCore(s, link, 4, { tools: [] })).status, 200);
    assert.equal(m.registry.coreOf(page.tab), null);
  });

  it('beside a workspace registration: both offered to the tab, one call at a time per tab; a core call is invoked with slot core and keeps its own error codes', async () => {
    const { m, s } = await setup();
    const page = await s.page();
    const link = await page.open();
    assert.equal((await s.register(link, 1)).status, 200);
    assert.equal((await registerCore(s, link, 2, { place: 'workspace' })).status, 200);
    // In a workspace (§12.4): its tools first, then the app's; core__view is the workbench's.
    const offered = names(m.registry.toolsFor(ctx({ tab: page.tab })));
    assert.deepEqual(offered, ['ai-demo__add', 'ai-demo__get_count', 'ai-demo__reset', 'ai-demo__slow_add', 'core__show']);
    const show = coreTool(m, page.tab, 'show');
    const call = runTool(show, { target: 'study' }, ctx({ tab: page.tab }));
    const inv = await page.frame('invoke');
    assert.deepEqual([inv.tool, inv.slot, inv.timeout_s], ['show', 'core', 120]);
    // The workspace's call waits its turn: one call at a time per tab.
    const add = m.registry.toolsFor(ctx({ tab: page.tab })).find((t) => t.localName === 'add');
    const busy = await runTool(add, { by: 1 }, ctx({ tab: page.tab })).promise;
    assert.deepEqual([busy.ok, busy.error.code], [false, 'busy']);
    await s.progress(link, inv.call, { ack: true });
    await s.result(link, inv.call, { ok: false, error: { code: 'person_busy', message: 'The person is using the view.', hint: 'Try again in a moment.' } });
    const out = await call.promise;
    assert.deepEqual([out.error.code, out.error.hint], ['person_busy', 'Try again in a moment.']);
    // A workspace page may not claim a core code.
    const wcall = runTool(add, { by: 1 }, ctx({ tab: page.tab }));
    const winv = await page.frame('invoke', 1);
    assert.equal(winv.slot, undefined);
    await s.result(link, winv.call, { ok: false, error: { code: 'person_busy', message: 'x' } });
    assert.equal((await wcall.promise).error.code, 'failed');
  });

  it("a plugin turned off ('*') fails the workspace's call, never the core page's", async () => {
    const { m, s } = await setup();
    const page = await s.page();
    const link = await page.open();
    await registerCore(s, link, 1);
    const call = runTool(coreTool(m, page.tab, 'view'), { action: 'fit' }, ctx({ tab: page.tab }));
    const inv = await page.frame('invoke');
    const { bumpPluginEpoch } = await import('../../foam-runner.js');
    bumpPluginEpoch('*');
    await s.progress(link, inv.call, { ack: true });
    await s.result(link, inv.call, { ok: true, result: { data: { done: 'Fitted the view' }, summary: 'Fitted the view' } });
    const out = await call.promise;
    assert.deepEqual([out.ok, out.summary], [true, 'Fitted the view']);
    assert.equal(m.registry.coreOf(page.tab).connected, true);
  });

  it('a link that goes leaves the core registration dormant (offered to nobody, a turn on it 409 tab_hidden); the next link and re-POST bring it back; past the dormant time it goes', async () => {
    const { m, s } = await setup();
    const page = await s.page();
    const link = await page.open();
    await registerCore(s, link, 1);
    page.serverDrop();
    await until(() => m.registry.coreOf(page.tab)?.connected === false);
    assert.equal(coreTool(m, page.tab, 'show'), undefined);
    assert.deepEqual([m.manager.resolveTab(page.tab).status, m.manager.resolveTab(page.tab).body.code], [409, 'tab_hidden']);
    const again = await s.page(page.tab);
    const link2 = await again.open();
    await registerCore(s, link2, 2);
    assert.ok(coreTool(m, page.tab, 'show'));
    again.serverDrop();
    await until(() => m.registry.coreOf(page.tab)?.connected === false);
    m.clock.advance(s.relay.dormantMs);
    assert.equal(m.registry.coreOf(page.tab), null);
  });

  it("leaving a workspace whose plugin links geometry escalates core__show to a computation; staying, or a plugin that links none, doesn't", async () => {
    const flags = { links: true };
    const { m, s } = await setup({ relay: { pluginLoaded: (key) => (key === 'ai-demo' ? { key, name: 'Workspace demo', links_geometry: flags.links } : null) } });
    const page = await s.page();
    const link = await page.open();
    await s.register(link, 1);
    await registerCore(s, link, 2, { place: 'workspace' });
    const show = coreTool(m, page.tab, 'show');
    const leave = { target: 'project', project_id: '', id: '', panel: '' };
    const up = await show.escalate(leave);
    assert.equal(up?.risk, 'compute');
    assert.match(show.gateText(leave, up).title, /send your design to the simulation/);
    assert.equal(await show.escalate({ target: 'workspace', project_id: '', id: DEMO_WORKSPACE.study_id, panel: '' }), null, 'the same workspace');
    flags.links = false;
    assert.equal(await show.escalate({ target: 'home', project_id: '', id: '', panel: '' }), null);
    await registerCore(s, link, 3);
    flags.links = true;
    assert.equal(await show.escalate({ target: 'home', project_id: '', id: '', panel: '' }), null, 'in the workbench nothing leaves');
  });

  it('the leave card names the study, the project, the geometry it updates and how many studies use it (spec 14.2); a new geometry says so; unknown: the general words', async () => {
    let target = { project: 'Wing', study: 'Plate', geometry: { id: 'g2', name: 'Plate', studies: 2 } };
    const asked = [];
    const { m, s } = await setup({
      relay: {
        pluginLoaded: (key) => (key === 'ai-demo' ? { key, name: 'Workspace demo', links_geometry: true } : null),
        leaveTarget: async (...args) => (asked.push(args), target),
      },
    });
    const page = await s.page();
    const link = await page.open();
    await s.register(link, 1);
    await registerCore(s, link, 2, { place: 'workspace' });
    const show = coreTool(m, page.tab, 'show');
    const back = { target: 'project', project_id: '', id: '', panel: '' };
    // The card as the runner shows it (the runner keeps an escalation's risk, note and rows).
    const { ToolRunner } = await import('../assistant/runner.ts');
    const cards = [];
    const runner = new ToolRunner({ gates: { ask: async (req) => (cards.push(req), 'deny') } });
    const card = async () => {
      // The test page's tools take no input (coreTools above); the leave is what escalates.
      await runner.run({ type: 'tool_call', callId: `c-${cards.length}`, name: show.name, input: {} }, { owner: { kind: 'turn', id: 't', tab: page.tab }, ctx: ctx({ tab: page.tab }), signal: new AbortController().signal, offered: new Map([[show.name, show]]) });
      return cards.at(-1);
    };
    let c = await card();
    assert.deepEqual(asked, [['p1', 'ai-demo', DEMO_WORKSPACE.study_id]]);
    assert.equal(c.risk, 'compute');
    assert.equal(c.title, 'Allow the Assistant to send your design to the simulation?');
    assert.match(c.copy, /^Leaves the Workspace demo \S.* "Plate" and sends its design to project "Wing": it updates geometry "Plate" \(2 studies use it\)\. You may be asked how to update it\.$/);
    assert.deepEqual(c.detail, [
      { label: 'Geometry', value: 'Plate' },
      { label: 'Studies using it', value: '2' },
    ]);
    target = { ...target, geometry: { id: 'g2', name: 'Plate', studies: 1 } };
    assert.match((await card()).copy, /\(1 study uses it\)/);
    target = { ...target, geometry: null };
    c = await card();
    assert.match(c.copy, /sends its design to project "Wing" as a new geometry\.$/);
    assert.deepEqual(c.detail, [{ label: 'Geometry', value: 'a new one' }]);
    target = null;
    c = await card();
    assert.equal(c.title, 'Allow the Assistant to send your design to the simulation?');
    assert.match(c.copy, /it updates the geometry it links, or adds a new one/);
  });

  it("a Back that answers its link job (link.<gl-…>) is recorded for the turn with the workspace's plugin and study, so wait follows it", async () => {
    const { jobHint, startedJobs } = await import('../assistant/host/turn-jobs.ts');
    const { createJobTools } = await import('../assistant/host/job-tools.ts');
    const { grants } = await import('../assistant/grants.ts');
    const { m, s } = await setup({ relay: { pluginLoaded: (key) => (key === 'ai-demo' ? { key, name: 'Workspace demo', links_geometry: true } : null), leaveTarget: async () => null } });
    const page = await s.page();
    const link = await page.open();
    await s.register(link, 1);
    await registerCore(s, link, 2, { place: 'workspace' });
    const show = coreTool(m, page.tab, 'show');
    const call = runTool(show, { target: 'project', project_id: '', id: '', panel: '' }, ctx({ tab: page.tab }), { turn: 't-back' });
    const inv = await page.frame('invoke');
    await s.progress(link, inv.call, { ack: true });
    await s.result(link, inv.call, { ok: true, result: { data: { shown: { place: 'workbench', project_id: 'p1' }, job: 'link.gl-abc123' }, summary: 'Back to the project' } });
    assert.equal((await call.promise).ok, true);
    const hint = jobHint('p1', 'link.gl-abc123');
    assert.deepEqual([hint?.kind, hint?.plugin, hint?.study_id, hint?.project_id], ['link', 'ai-demo', DEMO_WORKSPACE.study_id, 'p1']);
    assert.match(hint.name, /^Geometry update from Workspace demo /);
    assert.deepEqual(startedJobs('t-back').map((j) => j.job_id), ['link.gl-abc123'], "the turn's end names it while it runs");
    // wait reads it from the link's status route, by that plugin and study.
    const seen = [];
    const [, wait] = createJobTools({
      call: async (id, args) => {
        seen.push([id, args]);
        if (id === 'link.status') return { ok: true, job: { status: 'done', geometryName: 'Plate' } };
        throw new Error(`unexpected ${id}`);
      },
      sleep: async () => {},
    });
    const out = await wait.run({ project_id: '', job_ids: ['link.gl-abc123'], until: 'all', timeout_s: 10 }, { signal: new AbortController().signal, ctx: ctx({ tab: page.tab }), turn: 't-back', progress() {} });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.data.jobs.map((j) => [j.job_id, j.status, j.result]), [['link.gl-abc123', 'done', { geometry: 'Plate' }]]);
    assert.deepEqual(seen, [['link.status', { project_id: 'p1', plugin: 'ai-demo', study_id: DEMO_WORKSPACE.study_id, job_id: 'gl-abc123' }]]);
    // A Back that answers no job, or another call, records nothing.
    const other = runTool(show, { target: 'study', project_id: '', id: 's2', panel: '' }, ctx({ tab: page.tab }), { turn: 't-other' });
    const inv2 = await page.frame('invoke', 1);
    await s.progress(link, inv2.call, { ack: true });
    await s.result(link, inv2.call, { ok: true, result: { data: { shown: { place: 'workbench' } }, summary: 'Showed it' } });
    await other.promise;
    assert.deepEqual(startedJobs('t-other'), []);
    grants().end('t-back');
  });
});

// ---------------------------------------------------------------- turns bind to their window

describe('turns bind to their window and follow it', { timeout: 30_000 }, () => {
  it("tab 'auto' and a tab id count a window by its core page: Home binds with no project, the workbench with its project", async () => {
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: PROJECTS });
    m.registry.setCore('T1', 'L1', core({ projectId: '', studyId: '', place: 'home' }));
    assert.deepEqual(m.manager.resolveTab('auto'), { tab: 'T1', projectId: '', studyId: '', place: 'home' });
    m.provider.script({ text: 'From Home.' });
    const home = await startTurn(m, { text: 'x', tab: 'T1' });
    assert.equal(home.status, 202, JSON.stringify(home.body));
    await settled(home.turn);
    assert.deepEqual([home.turn.tab, home.turn.projectId], ['T1', null]);
    m.registry.setCore('T1', 'L1', core());
    assert.deepEqual(m.manager.resolveTab('T1'), { tab: 'T1', projectId: 'p1', studyId: 's1', place: 'workbench' });
    m.registry.setCore('T2', 'L2', core({ projectId: 'p2', studyId: '' }));
    assert.equal(m.manager.resolveTab('auto').body.code, 'ambiguous_tab');
    assert.deepEqual(m.manager.resolveTabForProject('p2'), { tab: 'T2', projectId: 'p2', studyId: '', place: 'workbench' });
    m.registry.setCore('T3', 'L3', core({ projectId: 'p2', studyId: '' }));
    assert.equal(m.manager.resolveTabForProject('p2'), null, 'two windows show it');
    const tabs = (await m.manager.tabs()).body.tabs;
    assert.deepEqual(tabs.map((t) => [t.tab, t.core.place, t.workspace]), [['T1', 'workbench', null], ['T2', 'workbench', null], ['T3', 'workbench', null]]);
  });

  it('core__show opening another project: the next step is that project\'s, asked about first; the conversation moves and says so; the window\'s next message continues it', async () => {
    const m = makeManager({ dir: ROOT, provider: 'anthropic', projects: PROJECTS, hostTools: [hostTool('look', { projectData: true })] });
    m.state.settings = withConsent(m.state.settings, 'p1', null, 'anthropic');
    // The page: core__show opens p2 (its registration says so before the call answers).
    m.registry.setCore('T1', 'L1', core({
      invoke: async () => {
        m.registry.setCore('T1', 'L1', core({ projectId: 'p2', studyId: 's9', invoke: undefined }));
        return { ok: true, data: { shown: { place: 'workbench', project_id: 'p2' } }, summary: 'Showed the project' };
      },
    }));
    m.provider.script({ tools: [{ name: 'core__show', input: {} }] }, (req) => {
      assert.ok(req.tools.some((t) => t.name === 'look'));
      return { text: 'Now in Tail.' };
    });
    const r = await startTurn(m, { text: 'Open the tail', tab: 'T1' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const gates = [];
    answerGates(m, r.turn, (g) => (gates.push(g), true));
    await settled(r.turn);
    assert.equal(r.turn.state, 'done', r.turn.message);
    assert.deepEqual(gates.map((g) => [g.kind, g.title]), [['privacy', 'Send project "Tail" to Anthropic?']]);
    assert.equal(m.provider.requests.length, 2, 'the second request went once Tail was allowed');
    assert.deepEqual([r.turn.projectId, r.turn.simulationId, r.turn.conv.projectId], ['p2', 's9', 'p2']);
    assert.ok(eventsOf(r.turn).some((e) => e.type === 'note' && e.text === 'Moved to project "Tail".'));
    assert.deepEqual(m.consents.map((c) => c.projectId), ['p2']);
    // The window, now on Tail, continues the conversation.
    m.registry.setCore('T1', 'L1', core({ projectId: 'p2', studyId: 's9' }));
    m.provider.script({ text: 'Still here.' });
    const next = await startTurn(m, { text: 'And now?', tab: 'T1', conversation: r.turn.conv.id });
    assert.equal(next.status, 202, JSON.stringify(next.body));
    await settled(next.turn);
    const listed = (await m.manager.conversationsView('p2')).body.conversations.map((c) => c.id);
    assert.deepEqual(listed, [r.turn.conv.id], 'listed under its new project');
  });

  it("Don't send for the newly opened project ends the turn before its next request: nothing of it was sent", async () => {
    const m = makeManager({ dir: ROOT, provider: 'anthropic', projects: PROJECTS });
    m.state.settings = withConsent(m.state.settings, 'p1', null, 'anthropic');
    m.registry.setCore('T1', 'L1', core({
      invoke: async () => {
        m.registry.setCore('T1', 'L1', core({ projectId: 'p2', studyId: '' }));
        return { ok: true, summary: 'Showed the project' };
      },
    }));
    m.provider.script({ tools: [{ name: 'core__show', input: {} }] });
    const r = await startTurn(m, { text: 'Open the tail', tab: 'T1' });
    answerGates(m, r.turn, () => false);
    await settled(r.turn);
    assert.deepEqual([r.turn.state, r.turn.endReason, r.turn.message], ['stopped', 'privacy', 'Nothing more was sent.']);
    assert.equal(m.provider.requests.length, 1);
  });

  it('a tab that goes Home: the turn reads by id from then on (no project), and says so', async () => {
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: PROJECTS });
    m.registry.setCore('T1', 'L1', core({
      invoke: async () => {
        m.registry.setCore('T1', 'L1', core({ projectId: '', studyId: '', place: 'home' }));
        return { ok: true, summary: 'Showed Home' };
      },
    }));
    m.provider.script({ tools: [{ name: 'core__show', input: {} }] }, { text: 'Home.' });
    const r = await startTurn(m, { text: 'Go home', tab: 'T1' });
    await settled(r.turn);
    assert.deepEqual([r.turn.state, r.turn.projectId, r.turn.conv.projectId], ['done', null, null]);
    assert.ok(eventsOf(r.turn).some((e) => e.type === 'note' && e.text === 'Moved to Home.'));
  });
});

// ---------------------------------------------------------------- another project, and the list

describe('privacy per call (C5, §9.2, §9.3)', { timeout: 30_000 }, () => {
  /** A read of the project its input names (projectOf, as lane E's tools give it). */
  const reader = (calls) =>
    Object.assign(hostTool('read_other', { projectData: true, schema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'], additionalProperties: false }, run: async (input) => (calls.push(input.project_id), { ok: true, data: { read: input.project_id }, summary: 'read' }) }), {
      projectOf: (input, c) => (input.project_id ? String(input.project_id) : c.projectId),
    });
  const lister = (calls) =>
    Object.assign(hostTool('projects', { run: async () => (calls.push('list'), { ok: true, data: { projects: [] }, summary: 'listed' }) }), {
      projectOf: () => LIST_CONSENT_KEY,
    });

  it("another project's read asks for that project; Don't send refuses the call and the turn goes on; Send is remembered", async () => {
    const calls = [];
    const m = makeManager({ dir: ROOT, provider: 'anthropic', projects: PROJECTS, hostTools: [reader(calls)] });
    m.state.settings = withConsent(m.state.settings, 'p1', null, 'anthropic');
    m.registry.setCore('T1', 'L1', core());
    m.provider.script(
      { tools: [{ name: 'read_other', input: { project_id: 'p2' } }] },
      (req) => {
        const last = req.messages[req.messages.length - 1];
        assert.match(last.parts[0].text, /"code":"privacy_declined"/);
        assert.match(last.parts[0].text, /The person chose not to send project p2\./);
        assert.ok(!last.parts[0].text.includes('Tail'), "the declined project's title is its data: never sent");
        return { tools: [{ name: 'read_other', input: { project_id: 'p1' } }, { name: 'read_other', input: { project_id: 'p2' } }] };
      },
      { text: 'Done.' },
    );
    const r = await startTurn(m, { text: 'Compare', tab: 'T1' });
    const answers = [false, true];
    const asked = [];
    answerGates(m, r.turn, (g) => (asked.push(g.title), answers.shift()));
    await settled(r.turn);
    assert.equal(r.turn.state, 'done', r.turn.message);
    assert.deepEqual(asked, ['Send project "Tail" to Anthropic?', 'Send project "Tail" to Anthropic?']);
    assert.deepEqual(calls, ['p1', 'p2'], 'the declined call did not run; its own project needs no question');
    assert.deepEqual(m.consents.map((c) => [c.projectId, c.createdAt]), [['p2', '2026-10-01T00:00:00Z']]);
  });

  it('the project list is asked about once per destination; the answer is kept under its own key and is not a project in the count', async () => {
    const calls = [];
    const m = makeManager({ dir: ROOT, provider: 'anthropic', projects: PROJECTS, hostTools: [lister(calls)] });
    m.registry.setCore('T1', 'L1', core({ projectId: '', studyId: '', place: 'home' }));
    m.provider.script({ tools: [{ name: 'projects', input: {} }] }, { text: 'Two projects.' }, { tools: [{ name: 'projects', input: {} }] }, { text: 'Again.' });
    const asked = [];
    const first = await startTurn(m, { text: 'List them', tab: 'T1' });
    answerGates(m, first.turn, (g) => (asked.push([g.title, g.yes, g.no]), true));
    await settled(first.turn);
    const second = await startTurn(m, { text: 'Again', tab: 'T1', conversation: first.turn.conv.id });
    answerGates(m, second.turn, (g) => (asked.push([g.title]), true));
    await settled(second.turn);
    assert.deepEqual(asked, [['Let the Assistant read your project list?', 'Send', "Don't send"]]);
    assert.deepEqual(calls, ['list', 'list']);
    assert.deepEqual(m.consents, [{ projectId: LIST_CONSENT_KEY, createdAt: null, destination: 'anthropic' }]);
    assert.equal(consentCount(m.state.settings), 0);
    assert.equal(consentCount(withConsent(m.state.settings, 'p1', null, 'anthropic')), 1);
  });

  it('a local model on this PC is never asked; Never send refuses the call (privacy_denied)', async () => {
    const calls = [];
    const local = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: PROJECTS, hostTools: [reader(calls), lister(calls)] });
    local.registry.setCore('T1', 'L1', core());
    local.provider.script({ tools: [{ name: 'read_other', input: { project_id: 'p2' } }, { name: 'projects', input: {} }] }, { text: 'ok' });
    const r = await startTurn(local, { text: 'x', tab: 'T1' });
    await settled(r.turn);
    assert.deepEqual([r.turn.state, calls, eventsOf(r.turn).filter((e) => e.type === 'gate').length], ['done', ['p2', 'list'], 0]);
    calls.length = 0;
    const deny = makeManager({ dir: ROOT, provider: 'anthropic', projects: PROJECTS, hostTools: [lister(calls)] });
    deny.state.settings = { ...deny.state.settings, privacy: 'deny' };
    deny.registry.setCore('T1', 'L1', core({ projectId: '', studyId: '', place: 'home' }));
    deny.provider.script({ tools: [{ name: 'projects', input: {} }] }, { text: 'ok' });
    const d = await startTurn(deny, { text: 'x', tab: 'T1' });
    await settled(d.turn);
    assert.deepEqual(calls, []);
    assert.ok(eventsOf(d.turn).some((e) => e.type === 'tool_result' && e.code === 'privacy_denied'));
  });

  it("otherProjectOf: only a project other than the turn's, and a throwing projectOf counts as none", () => {
    const def = { ...hostTool('x'), projectOf: (i) => i.p };
    assert.equal(otherProjectOf(def, { p: 'p2' }, ctx()), 'p2');
    assert.equal(otherProjectOf(def, { p: 'p1' }, ctx()), null);
    assert.equal(otherProjectOf(def, { p: '' }, ctx()), null);
    assert.equal(otherProjectOf(hostTool('y'), { p: 'p2' }, ctx()), null);
    assert.equal(otherProjectOf({ ...hostTool('z'), projectOf: () => { throw new Error('x'); } }, {}, ctx()), null);
    assert.equal(defaultSettings().privacy, 'ask');
  });
});
