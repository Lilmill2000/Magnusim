// The project and import host tools against a stand-in for the app (Core host tools spec 4.8,
// 4.11, 16.1): every project_edit action sends the exact method, path and body of the spec;
// the card actions go by project_id from anywhere, a units change only in the window's
// project and asking first with what converts; import_file streams a file attached to this
// conversation, or a path the person typed in this message, and nothing else.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-project-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { createHostTransport } = await import('../assistant/host-call.ts');
const { paced } = await import('../assistant/host/common.ts');
const { projectEditTool } = await import('../assistant/host/project-edit.ts');
const { importFileTool } = await import('../assistant/host/import-file.ts');
const { startFakeApp, makeRt, world } = await import('./assistant-host-harness.js');

let app;
// The calls' rate runs on this clock: a call that waits for its slot moves it on, never the test's time.
let fakeNow = 0;
const synced = [];
before(async () => {
  app = await startFakeApp();
});
after(async () => {
  await app.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

const deps = (o = {}) => ({
  hostCall: paced(createHostTransport({ port: () => app.port, now: () => fakeNow }).call, async (ms) => { fakeNow += ms; }),
  assistant: async () => ({ provider: 'anthropic', model: 'm' }),
  version: async () => '0',
  plugins: () => [],
  uiSync: { emit: (e) => synced.push(e) },
  ...o,
});
const fresh = () => {
  Object.assign(app.w, world());
  app.over = null;
  synced.length = 0;
};
const rt = makeRt;

/** Runs a tool and returns {out, writes: [{method, path, keys, body}]} (the writes it sent). */
async function sent(tool, input, r = rt()) {
  const from = app.seen.length;
  const out = await tool.run(input, r);
  const writes = app.writes(from).map((w) => ({ method: w.method, path: w.path, keys: w.body ? Object.keys(w.body).sort() : [], body: w.body, query: w.query }));
  return { out, writes };
}

// ------------------------------------------------------------------ project_edit

const proj = (o) => ({ action: '', project_id: '', title: '', description: '', category: '', units: '', folder: '', plugin: '', key: '', ...o });

describe('project_edit: every action', () => {
  const t = () => projectEditTool(deps());
  it('create (a new folder first), new_folder, from_sample, start_action', async () => {
    fresh();
    let r = await sent(t(), proj({ action: 'create', title: 'Duct 2', folder: 'Ducts', units: 'Imperial' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [
      ['/api/folders', { name: 'Ducts' }],
      ['/api/project', { title: 'Duct 2', description: '', units: 'Imperial', folder: 'Ducts' }],
    ]);
    assert.match(r.out.data.hint, /core__show \{target:'project', project_id\}/);
    r = await sent(t(), proj({ action: 'create', title: 'In Aero', folder: 'Aero' }));
    assert.deepEqual(r.writes.map((w) => w.path), ['/api/project'], 'a folder that exists is not made again');
    r = await sent(t(), proj({ action: 'new_folder', folder: 'Wings' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/folders', { name: 'Wings' }]]);
    r = await sent(t(), proj({ action: 'from_sample', plugin: 'cad', key: 'bracket' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/project/sample', { plugin: 'cad', sample: 'bracket' }]]);
    r = await sent(t(), proj({ action: 'start_action', plugin: 'cad', key: 'part', title: 'My part' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [
      ['/api/project', { title: 'My part', description: '' }],
      ['/api/plugin-studies/create', { project_id: 'p-new', plugin: 'cad', kind: 'part', title: 'Part 1' }],
    ]);
  });
  it('update (only the given fields) and move: by project_id from anywhere (the card actions)', async () => {
    fresh();
    let r = await sent(t(), proj({ action: 'update', project_id: 'p2', title: 'Elbow', description: 'Bent pipe' }), rt({ ctx: { projectId: null, simulationId: null } }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/project/update', { project_id: 'p2', title: 'Elbow', description: 'Bent pipe' }]]);
    r = await sent(t(), proj({ action: 'move', project_id: 'p3', folder: '' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/project/move', { project_id: 'p3', folder: 'My Projects' }]]);
  });
  it('a units change needs the project open here, and asks first naming what converts', async () => {
    fresh();
    let r = await sent(t(), proj({ action: 'update', project_id: 'p2', units: 'Metric' }));
    assert.deepEqual([r.out.error.code, r.writes], ['not_this_project', []]);
    r = await sent(t(), proj({ action: 'update', units: 'Imperial' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/project/update', { project_id: 'p1', units: 'Imperial' }]]);
    const a = await t().escalate(proj({ action: 'update', units: 'Imperial' }), { ctx: rt().ctx, signal: new AbortController().signal, turn: 't' });
    assert.equal(a.risk, 'destructive');
    assert.equal(a.note, 'Converts the values you entered in 2 boundary conditions and 3 mesh refinements from Metric to US units. Results already computed are not converted.');
    assert.equal(t().gateText(proj({}), a).title, 'Allow the Assistant to change the units of this project?');
    // The card the runner shows has the whole copy, past a confirm note's 120 characters.
    const { ToolRunner } = await import('../assistant/runner.ts');
    const cards = [];
    const runner = new ToolRunner({ gates: { ask: async (req) => (cards.push(req), 'deny') } });
    const tool = t();
    const out = await runner.run(
      { type: 'tool_call', callId: 'c-units', name: tool.name, input: proj({ action: 'update', units: 'Imperial' }) },
      { owner: { kind: 'turn', id: 't', tab: null }, ctx: rt().ctx, signal: new AbortController().signal, offered: new Map([[tool.name, tool]]) },
    );
    assert.equal(out.code, 'declined');
    assert.ok(a.note.length > 120);
    assert.equal(cards[0].copy, a.note);
    assert.equal(await t().escalate(proj({ action: 'update', units: 'Metric' }), { ctx: rt().ctx, signal: new AbortController().signal, turn: 't' }), null, 'the same units: nothing converts');
  });
});

// ------------------------------------------------------------------ import_file

const imp = (o) => ({ project_id: '', attachment_id: '', path: '', as: 'geometry', length_unit: '', ...o });

describe('import_file', () => {
  it('an attachment of this conversation streams as the raw import, project in the query, never mode=replace', async () => {
    fresh();
    const file = join(ROOT, 'bracket.step');
    writeFileSync(file, 'ISO-10303-21;\nHEADER;\n'.repeat(50));
    const opened = [];
    const t = importFileTool(
      deps({
        attachments: {
          open: async (id, conv) => {
            opened.push([id, conv]);
            return id === 'att-0123456789abcdef' ? { name: 'bracket.step', bytes: statSync(file).size, stream: createReadStream(file) } : null;
          },
        },
      }),
    );
    const r = await sent(t, imp({ attachment_id: 'att-0123456789abcdef' }), rt({ ctx: { conversation: 'c-1' } }));
    assert.equal(r.out.ok, true, JSON.stringify(r.out));
    assert.deepEqual(opened, [['att-0123456789abcdef', 'c-1']]);
    assert.deepEqual(r.writes.map((w) => [w.method, w.path, w.query]), [['POST', '/api/geometry/import', { project_id: 'p1', filename: 'bracket.step' }]]);
    assert.deepEqual(r.out.data.ids, { geometry: 'geom-new' });
    assert.deepEqual(synced.at(-1).active, { geometry: 'geom-new' });
    const gone = await sent(t, imp({ attachment_id: 'att-ffffffffffffffff' }), rt({ ctx: { conversation: 'c-1' } }));
    assert.deepEqual([gone.out.error.code, gone.writes], ['not_found', []]);
  });
  it('a path only when the person typed it in this message; it must be a file; mesh formats need a unit', async () => {
    fresh();
    const file = join(ROOT, 'part.stl');
    writeFileSync(file, 'solid x\nendsolid x\n');
    const t = importFileTool(deps({ statFile: async (p) => (p === file ? { size: 20, file: true } : null) }));
    let r = await sent(t, imp({ path: file, length_unit: 'mm' }), rt({ ctx: { prompt: 'Import this please' } }));
    assert.deepEqual([r.out.error.code, r.writes], ['path_not_typed', []]);
    assert.match(r.out.error.hint, /paper-clip/);
    r = await sent(t, imp({ path: file, length_unit: 'mm' }), rt({ ctx: { prompt: null } }));
    assert.equal(r.out.error.code, 'path_not_typed', 'an app on this PC or an agent has no message of the person');
    r = await sent(t, imp({ path: file }), rt({ ctx: { prompt: `Import ${file}` } }));
    assert.deepEqual([r.out.error.code, r.writes], ['invalid_input', []]);
    r = await sent(t, imp({ path: file, length_unit: 'in' }), rt({ ctx: { prompt: `Import ${file} please` } }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/geometry/import', { project_id: 'p1', step_path: file, length_unit: 'INCH' }]]);
    r = await sent(t, imp({ path: `${file}x`, length_unit: 'in' }), rt({ ctx: { prompt: `Import ${file}x` } }));
    assert.equal(r.out.error.code, 'invalid_input');
  });
  it('neither a file nor a path: needs_file, with the way the person gives one', async () => {
    const r = await sent(importFileTool(deps()), imp({}));
    assert.equal(r.out.error.code, 'needs_file');
    assert.match(r.out.error.hint, /paper-clip in the Assistant panel, or to use \+ Add geometry/);
  });
});
