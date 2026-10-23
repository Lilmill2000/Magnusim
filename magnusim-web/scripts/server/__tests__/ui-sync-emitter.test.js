// The ui_sync emitter's interface (core host tools spec C2 §6.1; the `ui` channel subscribes to
// it): seq increases per boot; an event with no project or no known kind is not sent; kinds are
// the spec's, once each; ids and revs keep only lists of ids and whole revs; a listener's throw
// stops neither the others nor the tool; who made the change comes from the call (an MCP app or a
// coding agent is 'app', the Assistant's own turn 'assistant').
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-ui-sync-emitter-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { uiSync, uiSyncOrigin, UI_SYNC_KINDS } = await import('../ui-sync.ts');

const base = { project_id: 'p1', simulation_id: 's1', kinds: ['bcs'], ids: { bc: ['bc-7'] }, revs: { 'bc-7': 5 }, by: 'assistant', turn: 't1', tool: 'setup_edit.bc.update' };

describe('uiSync.emit', () => {
  it('sends to every listener with an increasing seq; unsubscribe stops it; a throwing listener stops nothing', () => {
    const heard = [];
    const offA = uiSync.subscribe(() => {
      throw new Error('a listener fails');
    });
    const offB = uiSync.subscribe((e) => heard.push(e));
    try {
      const one = uiSync.emit(base);
      const two = uiSync.emit({ ...base, kinds: ['active', 'tree'], active: { study: 's2' } });
      assert.ok(one && two);
      assert.equal(two.seq, one.seq + 1);
      assert.deepEqual(heard, [one, two]);
      assert.deepEqual(one, { seq: one.seq, ...base });
      assert.deepEqual(two.active, { study: 's2' });
    } finally {
      offA();
      offB();
    }
    uiSync.emit(base);
    assert.equal(heard.length, 2, 'unsubscribed');
  });

  it('no project or no known kind: nothing is sent; kinds are kept once, the unknown ones dropped; ids and revs cleaned', () => {
    const heard = [];
    const off = uiSync.subscribe((e) => heard.push(e));
    try {
      assert.equal(uiSync.emit({ ...base, project_id: '' }), null);
      assert.equal(uiSync.emit({ ...base, kinds: ['bogus'] }), null);
      assert.equal(heard.length, 0);
      const e = uiSync.emit({ ...base, simulation_id: '', kinds: ['bcs', 'bcs', 'bogus', 'tree'], ids: { bc: ['bc-1', '', 3], x: 'no' }, revs: { a: 1, b: -1, c: 1.5, d: '2' }, by: 'other', turn: '', tool: 'x'.repeat(300) });
      assert.deepEqual([e.simulation_id, e.kinds, e.ids, e.revs, e.by, e.turn, e.tool.length], [null, ['bcs', 'tree'], { bc: ['bc-1'] }, { a: 1 }, 'assistant', null, 120]);
    } finally {
      off();
    }
    assert.deepEqual([...UI_SYNC_KINDS], ['project', 'geometry', 'study', 'materials', 'bcs', 'bc_defaults', 'mesh', 'refinements', 'runs', 'plugin_studies', 'active', 'tree']);
  });

  it("who made it: the Assistant's turn, another app (mcp:<connection>, or no turn), a coding agent", () => {
    assert.deepEqual(uiSyncOrigin({ turn: 't-1', ctx: { assistant: { provider: 'cloud-provider', model: 'm' } } }), { by: 'assistant', turn: 't-1' });
    assert.deepEqual(uiSyncOrigin({ turn: 'mcp:s-9', ctx: {} }), { by: 'app', turn: 'mcp:s-9' });
    assert.deepEqual(uiSyncOrigin({ turn: null, ctx: {} }), { by: 'app', turn: null });
    assert.deepEqual(uiSyncOrigin({ turn: 't-2', ctx: { assistant: { provider: 'agent:some-agent', model: '' } } }), { by: 'app', turn: 't-2' });
  });
});
