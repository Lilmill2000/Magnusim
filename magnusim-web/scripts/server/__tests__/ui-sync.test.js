// `ui_sync` (Assistant phase 5, C2): what a host tool wrote reaches the open windows of its
// project on the hub channel kind `ui`, and the turn's log under the call that wrote.
// - the channel: this PC only; params {project_id}; a frame goes to that project's channels
//   only; a channel that ended hears nothing more;
// - emit (lane A's ui-sync.ts): a seq per boot; only known kinds, string ids, whole-number revs,
//   the records' names; nothing sent for a frame with no project or no known kind;
// - through the real hub: a window's subscribe, then the `sync` frame on its stream;
// - the turn: a tool's emit puts {type:'ui_sync', call, project_id, kinds, ids, names} on its
//   turn's log under its call; another app's call (mcp:…) puts nothing on any turn;
// - never from a route: a person's own save through the BC route emits nothing, and no module
//   outside the Assistant's tools calls uiSync.emit (a scan of scripts/).
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-ui-sync-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
mkdirSync(process.env.MAGNUSIM_PROJECTS_ROOT, { recursive: true });
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { uiSync } = await import('../ui-sync.ts');
const { openUiChannel, uiSyncChannelsOpen, registerUiSyncRoutes } = await import('../ui-channel.ts');
const onUiSync = (fn) => uiSync.subscribe(fn);
const { makeManager, startTurn, settled, eventsOf, hostTool, until, relayPage } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const { Router, dispatch } = await import('../router.ts');
const { registerEventHubRoutes } = await import('../event-hub.ts');
const { createGeometryFolder, createStudyFolder, writeJsonAtomic } = await import('../../project-layout.js');
const { handleW19Api } = await import('../../w19-boundary-conditions.js');

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  resetAssistantState();
});
after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

/** A channel as the hub opens one: its frames, and its cleanup. */
function channel(params, local = true) {
  const ch = { frames: [], alive: true };
  const out = openUiChannel(params, (event, payload) => {
    if (!ch.alive) return false;
    ch.frames.push({ event, payload });
    return true;
  }, () => undefined, { local });
  ch.out = out;
  if (out.ok) {
    cleanups.push(() => out.cleanup());
    ch.close = () => {
      ch.alive = false;
      out.cleanup();
    };
  }
  return ch;
}

const sync = (o = {}) => ({ project_id: 'proj-a', simulation_id: 'sim-1', kinds: ['bcs'], ids: { bc: ['bc-7'] }, revs: { 'bc-7': 5 }, by: 'assistant', turn: null, tool: 'setup_edit.bc.update', ...o });

describe('the ui channel', () => {
  it('is for this PC only and needs a project', () => {
    const remote = channel({ project_id: 'proj-a' }, false);
    assert.deepEqual([remote.out.ok, remote.out.status], [false, 403]);
    const none = channel({}, true);
    assert.deepEqual([none.out.ok, none.out.status], [false, 400]);
    assert.equal(channel({ project_id: 'proj-a' }).out.ok, true);
  });

  it("sends a frame to its project's channels only; one that ended hears nothing", () => {
    const a1 = channel({ project_id: 'proj-a' });
    const a2 = channel({ project_id: 'proj-a' });
    const b = channel({ project_id: 'proj-b' });
    assert.equal(uiSyncChannelsOpen('proj-a'), 2);
    const sent = uiSync.emit(sync());
    assert.ok(sent && sent.seq > 0);
    assert.equal(a1.frames.length, 1);
    assert.equal(a2.frames.length, 1);
    assert.equal(b.frames.length, 0);
    assert.equal(a1.frames[0].event, 'sync');
    assert.deepEqual(a1.frames[0].payload, sent);
    a2.close();
    uiSync.emit(sync({ kinds: ['mesh'], ids: { mesh: ['m-1'] }, revs: { 'm-1': 2 } }));
    assert.equal(a1.frames.length, 2);
    assert.equal(a2.frames.length, 1);
    assert.equal(uiSyncChannelsOpen('proj-a'), 1);
  });

  it('emit numbers its frames and cleans them: known kinds, string ids, whole-number revs; nothing for no project or no kind', () => {
    const a = channel({ project_id: 'proj-a' });
    const one = uiSync.emit(sync());
    const two = uiSync.emit(
      sync({
        kinds: ['bcs', 'nonsense', 'active'],
        ids: { bc: ['bc-1', 7] },
        revs: { 'bc-1': 3, bad: 1.5, neg: -1 },
        active: { run: 'run-2' },
        names: { 'bc-1': 'Inlet', blank: '  ' },
        by: 'app',
      }),
    );
    assert.equal(two.seq, one.seq + 1);
    assert.deepEqual(two.kinds, ['bcs', 'active']);
    assert.deepEqual(two.ids, { bc: ['bc-1'] });
    assert.deepEqual(two.revs, { 'bc-1': 3 });
    assert.deepEqual(two.active, { run: 'run-2' });
    assert.deepEqual(two.names, { 'bc-1': 'Inlet' });
    assert.equal(two.by, 'app');
    assert.equal(uiSync.emit(sync({ project_id: '' })), null);
    assert.equal(uiSync.emit(sync({ kinds: ['nonsense'] })), null);
    assert.equal(a.frames.length, 2);
  });

  it('through the real hub: a window subscribes to `ui` and its stream carries the sync frame; another PC is refused', async () => {
    const router = new Router();
    registerEventHubRoutes(router);
    registerUiSyncRoutes(router);
    const server = http.createServer(async (req, res) => {
      if (!(await dispatch(router, req, res))) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await relayPage(base);
    cleanups.push(async () => {
      page.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    });
    const subscribe = async (headers = {}) => {
      const r = await fetch(`${base}/api/events/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ tab: page.tab, conn: page.conn, channels: [{ cid: 'ui:1', kind: 'ui', params: { project_id: 'proj-hub' } }] }),
      });
      return (await r.json()).results[0];
    };
    const far = await subscribe({ 'x-forwarded-for': '203.0.113.9' });
    assert.equal(far.ok, false);
    const row = await subscribe();
    assert.equal(row.ok, true, JSON.stringify(row));
    const sent = uiSync.emit(sync({ project_id: 'proj-hub' }));
    const got = await page.frame('sync', 0, 'ui:1');
    assert.deepEqual(got, sent);
  });
});

describe('the turn', () => {
  it("a tool's write puts ui_sync on its turn's log, under its call", async () => {
    const tool = hostTool('write_bc', {
      risk: 'edit',
      run: async (_input, rt) => {
        uiSync.emit(sync({ turn: rt.turn, names: { 'bc-7': 'Inlet' } }));
        return { ok: true, data: { done: 'BC saved' }, summary: 'saved' };
      },
    });
    const m = makeManager({ dir: ROOT, hostTools: [tool] });
    m.provider.script({ tools: [{ name: 'write_bc' }] }, { text: 'Done.' });
    const { turn: t } = await startTurn(m, 'Set the inlet');
    await settled(t);
    const events = eventsOf(t);
    const call = events.find((e) => e.type === 'tool_call');
    const ui = events.filter((e) => e.type === 'ui_sync');
    assert.equal(ui.length, 1);
    const { seq: _s, at: _a, ...row } = ui[0];
    assert.deepEqual(row, { type: 'ui_sync', call: call.call, project_id: 'proj-a', kinds: ['bcs'], ids: { bc: ['bc-7'] }, names: { 'bc-7': 'Inlet' } });
    const result = events.find((e) => e.type === 'tool_result');
    assert.ok(ui[0].seq > call.seq && ui[0].seq < result.seq, 'between the call and its result');
  });

  it("another app's call (mcp:…) and a turn that ended put nothing on any turn", async () => {
    const m = makeManager({ dir: ROOT, hostTools: [] });
    m.provider.script({ text: 'Hi.' });
    const { turn: t } = await startTurn(m, 'hello');
    await settled(t);
    const before = eventsOf(t).length;
    uiSync.emit(sync({ turn: 'mcp:conn-1' }));
    uiSync.emit(sync({ turn: t.id }));
    assert.equal(eventsOf(t).length, before);
  });
});

describe('never from a route', () => {
  it("a person's own save through the BC route emits nothing", async () => {
    const dir = join(process.env.MAGNUSIM_PROJECTS_ROOT, 'route-proj');
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, 'project.json'), { id: 'route-proj', title: 'R', units: 'Metric', active_geometry_id: 'g', geometries: [{ id: 'g', name: 'Box' }] });
    writeJsonAtomic(join(dir, 'simulations.json'), { active_id: 's', simulations: [{ id: 's', name: 'S', geometry_id: 'g' }] });
    createGeometryFolder(dir, { id: 'g', name: 'Box', original_filename: 'b.step' });
    createStudyFolder(dir, 'g', { id: 's', name: 'S' });
    const heard = [];
    const off = onUiSync((e) => heard.push(e));
    cleanups.push(off);
    const out = {};
    await handleW19Api({ method: 'POST' }, { setHeader() {} }, new URL('http://x/api/bcs'), ['api', 'bcs'], {
      readJsonBody: async () => ({ project_id: 'route-proj', simulation_id: 's', name: 'Inlet', bc_type: 'Velocity inlet', faces: ['face 1@Body1'] }),
      sendJson: (_r, status, json) => Object.assign(out, { status, json }),
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    await until(() => true);
    assert.deepEqual(heard, []);
  });

  it('no module outside the Assistant tools calls uiSync.emit', () => {
    const offenders = [];
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(?:[cm]?[jt]s)$/.test(name)) {
          const rel = relative(SCRIPTS, p).split(sep).join('/');
          // The emitter itself, the channel's test route (MAGNUSIM_TEST_UI_SYNC), and the tools.
          if (rel === 'server/ui-sync.ts' || rel === 'server/ui-channel.ts' || rel.startsWith('server/assistant/')) continue;
          if (/uiSync\s*\.\s*emit\s*\(/.test(readFileSync(p, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(SCRIPTS);
    assert.deepEqual(offenders, []);
  });
});
