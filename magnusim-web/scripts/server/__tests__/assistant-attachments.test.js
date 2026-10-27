// The person's file attachments (core host tools spec 13, C9): POST /api/assistant/attachments
// streams a geometry file to the Assistant's home from a window (its live relay link), sniffed by
// its first bytes and capped at 500 MB (a small cap here); a turn's `attachments` must be kept,
// from that window and unbound or its conversation's, and are bound to it; the model gets one
// line per file; attachments.open(id, conversation) streams only the conversation's own; a
// forgotten conversation's files go, and the sweep takes what nothing can use any more.
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-attachments-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { makeManager, relayServer, settled, until } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const A = await import('../assistant/attachments.ts');
const { AttachmentStore, ATTACHMENT_LIMITS, attachmentStore, attachments, sniffGeometry, sizeText, cleanFileName, attachmentLine, formatOfName } = A;

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------- sample files

const STEP = Buffer.from('ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'bracket\'),\'2;1\');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
const IGES = Buffer.from(`${'Magnusim test IGES'.padEnd(72)}S${'1'.padStart(7)}\n${'1H,,1H;'.padEnd(72)}G${'1'.padStart(7)}\n`);
const BREP = Buffer.from('DBRep_DrawableShape\n\nCASCADE Topology V1, (c) Matra-Datavision\nLocations 0\n');
const ASCII_STL = Buffer.from('solid part\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid part\n');
const OBJ = Buffer.from('# a triangle\n\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const PLY = Buffer.from('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n');
/** A binary STL whose 80-byte header starts with "solid" (as many exporters write it). */
function binaryStl(triangles = 1) {
  const b = Buffer.alloc(84 + 50 * triangles);
  b.write('solid exported by a CAD program', 0, 'ascii');
  b.writeUInt32LE(triangles, 80);
  return b;
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// ---------------------------------------------------------------- pure parts

describe('the pure parts', () => {
  it('sniffGeometry reads each format by its first bytes (a binary STL by its size), and nothing else', () => {
    assert.equal(sniffGeometry(STEP, STEP.length), 'step');
    const bom = Buffer.concat([Buffer.from('\ufeff  \r\n'), STEP]);
    assert.equal(sniffGeometry(bom, bom.length), 'step', 'a BOM and blank lines first');
    assert.equal(sniffGeometry(IGES, IGES.length), 'iges');
    assert.equal(sniffGeometry(BREP, BREP.length), 'brep');
    assert.equal(sniffGeometry(Buffer.from('CASCADE Topology V3, (c) Open Cascade\n'), 38), 'brep');
    assert.equal(sniffGeometry(ASCII_STL, ASCII_STL.length), 'stl');
    const bin = binaryStl(3);
    assert.equal(sniffGeometry(bin, bin.length), 'stl', 'binary, though its header says "solid"');
    assert.equal(sniffGeometry(bin.subarray(0, 84), bin.length), 'stl', 'only the head is read');
    assert.equal(sniffGeometry(bin, bin.length + 1), null, 'a size that is no triangle count');
    assert.equal(sniffGeometry(OBJ, OBJ.length), 'obj');
    assert.equal(sniffGeometry(PLY, PLY.length), 'ply');
    for (const junk of [PNG, Buffer.from('PK\u0003\u0004 a zip'), Buffer.from('hello world\n'), Buffer.from('solid\n'), Buffer.alloc(0), Buffer.from('v 0 0 0\u0000')]) {
      assert.equal(sniffGeometry(junk, junk.length), null, JSON.stringify(junk.toString('latin1').slice(0, 20)));
    }
  });

  it('the name, the size and the model\'s line', () => {
    assert.equal(cleanFileName('C:\\Users\\daniel\\Desktop\\bracket.STEP'), 'bracket.STEP');
    assert.equal(cleanFileName('/home/d/parts/wing.stl'), 'wing.stl');
    assert.equal(cleanFileName('say "hi"\u0007.obj'), "say 'hi' .obj");
    assert.equal(cleanFileName(42), '');
    assert.deepEqual(['a.STP', 'b.igs', 'c.Brep', 'd.brp', 'e.stl', 'f.OBJ', 'g.ply', 'h.zip', 'i.png', 'step'].map(formatOfName), ['step', 'iges', 'brep', 'brep', 'stl', 'obj', 'ply', null, null, null]);
    assert.deepEqual([0, 1, 512, 1024, 12_345, 4.2 * 1024 * 1024, 37.6 * 1024 * 1024, 500 * 1024 * 1024].map(sizeText), ['0 bytes', '1 byte', '512 bytes', '1 KB', '12 KB', '4.2 MB', '38 MB', '500 MB']);
    assert.equal(attachmentLine({ id: 'att-0123456789abcdef', name: 'bracket.step', bytes: 4.2 * 1024 * 1024 }), '[Attached file: "bracket.step", 4.2 MB, attachment_id att-0123456789abcdef]');
    assert.equal(ATTACHMENT_LIMITS.bytes, 500 * 1024 * 1024);
    assert.equal(ATTACHMENT_LIMITS.perMessage, 4);
  });
});

// ---------------------------------------------------------------- the route and the turn

let dirs = 0;
/** A store in its own folder, with a small cap. */
function freshStore(o = {}) {
  dirs += 1;
  return new AttachmentStore({ dir: join(ROOT, `store-${dirs}`), maxBytes: 4096, ...o });
}

async function setup(o = {}) {
  const store = o.store ?? freshStore();
  const m = makeManager({ dir: ROOT, provider: 'openai_compatible' });
  const s = await relayServer(m, { attachments: store });
  servers.push(s);
  return { m, s, store };
}

/** POST /api/assistant/attachments with raw bytes; `chunked`: no Content-Length. */
function upload(s, { link, name, bytes, chunked = false, headers = {}, query } = {}) {
  const url = new URL(`${s.base}/api/assistant/attachments`);
  if (query !== undefined) url.search = query;
  else if (name !== undefined) url.searchParams.set('name', name);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/octet-stream',
          ...(link ? { 'x-magnusim-link': link } : {}),
          ...(chunked ? {} : { 'content-length': bytes.length }),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null, headers: res.headers }));
      },
    );
    // The server may answer before it reads the body (and close the socket).
    req.on('error', (err) => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? undefined : reject(err)));
    if (chunked) {
      for (let i = 0; i < bytes.length; i += 1000) req.write(bytes.subarray(i, i + 1000));
      req.end();
    } else req.end(bytes);
  });
}

const folders = (store) => (existsSync(store.dir) ? readdirSync(store.dir) : []);

async function linked(s) {
  const page = await s.page();
  const link = await page.open();
  return { page, link };
}

describe('POST /api/assistant/attachments', { timeout: 30_000 }, () => {
  it("keeps a geometry file from a window: the answer, its file and meta (sha256, the tab, unbound), private to this account", async () => {
    const { s, store } = await setup();
    const { page, link } = await linked(s);
    const r = await upload(s, { link, name: 'C:\\Users\\d\\bracket.step', bytes: STEP });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.attachment_id, /^att-[0-9a-f]{16}$/);
    assert.deepEqual({ ...r.json, attachment_id: 'x' }, { ok: true, attachment_id: 'x', name: 'bracket.step', bytes: STEP.length, kind: 'geometry', format: 'step' });
    const dir = join(store.dir, r.json.attachment_id);
    assert.deepEqual(readdirSync(dir).sort(), ['file', 'meta.json']);
    assert.deepEqual(readFileSync(join(dir, 'file')), STEP);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual(
      { ...meta, created_at: typeof meta.created_at },
      { name: 'bracket.step', bytes: STEP.length, sha256: createHash('sha256').update(STEP).digest('hex'), format: 'step', link_tab: page.tab, conversation: null, created_at: 'string', pid: process.pid },
    );
    // Each format by its own name.
    for (const [name, bytes, format] of [['a.igs', IGES, 'iges'], ['b.brep', BREP, 'brep'], ['c.stl', ASCII_STL, 'stl'], ['d.STL', binaryStl(2), 'stl'], ['e.obj', OBJ, 'obj'], ['f.ply', PLY, 'ply'], ['g.stp', STEP, 'step']]) {
      const x = await upload(s, { link, name, bytes, chunked: name === 'd.STL' });
      assert.deepEqual([x.status, x.json.format, x.json.bytes], [200, format, bytes.length], name);
    }
    assert.equal(folders(store).length, 8);
  });

  it("refuses without a window's live link, any other type, bytes that aren't what the name says, an empty file, and past the cap: nothing kept", async () => {
    const { s, store } = await setup();
    const { link } = await linked(s);
    const cases = [
      [{ name: 'a.step', bytes: STEP }, 409, 'no_channel', 'This window lost its connection to Magnusim. Try again.'],
      [{ link: 'f'.repeat(24), name: 'a.step', bytes: STEP }, 409, 'no_channel', 'This window lost its connection to Magnusim. Try again.'],
      // A plugin zip is never the AI's to install: it can't even be attached.
      [{ link, name: 'plugin.zip', bytes: Buffer.from('PK\u0003\u0004') }, 400, 'bad_type', 'Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.'],
      [{ link, name: 'notes.txt', bytes: Buffer.from('hi') }, 400, 'bad_type', 'Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.'],
      [{ link, name: 'picture.png', bytes: PNG }, 400, 'bad_type', 'Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.'],
      [{ link, name: 'fake.step', bytes: PNG }, 400, 'bad_type', "fake.step doesn't look like a STEP file."],
      [{ link, name: 'iges.stl', bytes: IGES }, 400, 'bad_type', "iges.stl doesn't look like a STL file."],
      [{ link, name: 'empty.obj', bytes: Buffer.alloc(0) }, 400, 'empty_file', 'empty.obj is empty.'],
      [{ link, query: '', bytes: STEP }, 400, 'bad_name', 'Send the file name as ?name=<file name>.'],
      [{ link, name: 'big.step', bytes: Buffer.concat([STEP, Buffer.alloc(5000, 32)]) }, 413, 'too_large', 'big.step is larger than 500 MB. Import it with + Add geometry.'],
      [{ link, name: 'big.step', bytes: Buffer.concat([STEP, Buffer.alloc(5000, 32)]), chunked: true }, 413, 'too_large', 'big.step is larger than 500 MB. Import it with + Add geometry.'],
    ];
    for (const [o, status, code, error] of cases) {
      const r = await upload(s, o);
      assert.deepEqual([r.status, r.json?.code, r.json?.error], [status, code, error], JSON.stringify({ ...o, bytes: o.bytes.length }));
    }
    // Not JSON's route: JSON is refused (and the tool-call header, as on every Assistant route).
    const json = await upload(s, { link, name: 'a.step', bytes: Buffer.from('{}'), headers: { 'content-type': 'application/json' } });
    assert.deepEqual([json.status, json.json.code], [415, 'octet_only']);
    const tool = await upload(s, { link, name: 'a.step', bytes: STEP, headers: { 'x-magnusim-assistant-turn': 't-1' } });
    assert.deepEqual([tool.status, tool.json.code], [403, 'recursion']);
    const remote = await upload(s, { link, name: 'a.step', bytes: STEP, headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.deepEqual([remote.status, remote.json.reason], [403, 'remote']);
    assert.deepEqual(folders(store), [], 'nothing kept');
  });
});

describe("a turn's attachments", { timeout: 30_000 }, () => {
  it('reach the model as one line each after the prompt, show on the summary, and bind to the conversation; its next turn may name them again', async () => {
    const { m, s, store } = await setup();
    const { link } = await linked(s);
    const a = (await upload(s, { link, name: 'bracket.step', bytes: STEP })).json;
    const b = (await upload(s, { link, name: 'wing.stl', bytes: binaryStl(1) })).json;
    m.provider.script({ text: 'I can import those.' });
    const r = await s.post('/api/assistant/turns', { text: 'Import these', link, attachments: [a.attachment_id, b.attachment_id] });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const t = s.handle.turns.get(r.json.turn);
    await settled(t);
    const first = m.provider.requests[0].messages[0];
    assert.equal(first.role, 'user');
    assert.deepEqual(first.parts.slice(0, 2), [
      { type: 'text', text: 'Import these' },
      { type: 'text', text: `[Attached file: "bracket.step", ${sizeText(STEP.length)}, attachment_id ${a.attachment_id}]\n[Attached file: "wing.stl", 134 bytes, attachment_id ${b.attachment_id}]` },
    ]);
    const poll = await s.get(`/api/assistant/turns/${r.json.turn}`);
    assert.deepEqual(poll.json.turn.attachments, [
      { id: a.attachment_id, name: 'bracket.step', bytes: STEP.length },
      { id: b.attachment_id, name: 'wing.stl', bytes: 134 },
    ]);
    assert.equal(poll.json.turn.prompt, 'Import these', "the person's own text, without the lines");
    assert.deepEqual([store.get(a.attachment_id).conversation, store.get(b.attachment_id).conversation], [r.json.conversation, r.json.conversation]);
    await until(() => JSON.parse(readFileSync(join(store.dir, a.attachment_id, 'meta.json'), 'utf8')).conversation === r.json.conversation, 5000, 'the binding on disk');
    // The same conversation's next turn may name one again.
    m.provider.script({ text: 'Again.' });
    const again = await s.post('/api/assistant/turns', { text: 'Once more', link, conversation: r.json.conversation, attachments: [a.attachment_id] });
    assert.equal(again.status, 202, JSON.stringify(again.json));
    await settled(s.handle.turns.get(again.json.turn));
    // A turn without any: no line, an empty list.
    m.provider.script({ text: 'Plain.' });
    const plain = await s.post('/api/assistant/turns', { text: 'Nothing attached', link, conversation: r.json.conversation });
    await settled(s.handle.turns.get(plain.json.turn));
    assert.deepEqual((await s.get(`/api/assistant/turns/${plain.json.turn}`)).json.turn.attachments, []);
    const last = m.provider.requests.at(-1).messages.at(-1);
    assert.ok(!JSON.stringify(m.provider.requests.at(-1).messages.slice(-1)).includes('Attached file'), JSON.stringify(last));
  });

  it("refused: another conversation's, another window's, from a program (no window), unknown, malformed, a fifth; nothing bound by a refused start", async () => {
    const { m, s, store } = await setup();
    const { link } = await linked(s);
    const other = await linked(s);
    const ids = [];
    for (const n of ['1', '2', '3', '4', '5']) ids.push((await upload(s, { link, name: `p${n}.obj`, bytes: OBJ })).json.attachment_id);
    const theirs = (await upload(s, { link: other.link, name: 'theirs.ply', bytes: PLY })).json.attachment_id;
    m.provider.script({ text: 'A.' });
    const conv = await s.post('/api/assistant/turns', { text: 'Bind the first', link, attachments: [ids[0]] });
    assert.equal(conv.status, 202);
    await settled(s.handle.turns.get(conv.json.turn));
    const GONE = 'An attached file is no longer kept on this PC. Remove it and attach it again.';
    const cases = [
      [{ text: 'x', link, attachments: [ids[0]] }, 409, 'attachment_gone', GONE, "another conversation's (a new one)"],
      [{ text: 'x', link, attachments: [theirs] }, 409, 'attachment_gone', GONE, "another window's"],
      [{ text: 'x', link: other.link, attachments: [ids[1]] }, 409, 'attachment_gone', GONE, 'sent from another window'],
      [{ text: 'x', attachments: [ids[1]] }, 400, 'attachments_need_window', 'Files are attached in the Assistant panel of a Magnusim window, and sent from that window.', 'no window'],
      [{ text: 'x', link, attachments: ['att-0000000000000000'] }, 409, 'attachment_gone', GONE, 'unknown'],
      [{ text: 'x', link, attachments: ['../../secrets'] }, 400, 'bad_attachments', 'attachments is a list of attachment ids (att-…).', 'not an id'],
      [{ text: 'x', link, attachments: ids[1] }, 400, 'bad_attachments', 'attachments is a list of attachment ids (att-…).', 'not a list'],
      [{ text: 'x', link, attachments: [ids[1], ids[1]] }, 400, 'bad_attachments', 'An attachment is listed twice.', 'twice'],
      [{ text: 'x', link, attachments: ids.slice(0, 5) }, 400, 'bad_attachments', 'At most 4 files per message.', 'five'],
    ];
    for (const [body, status, code, error, what] of cases) {
      const r = await s.post('/api/assistant/turns', body);
      assert.deepEqual([r.status, r.json.code, r.json.error], [status, code, error], what);
    }
    assert.deepEqual(
      ids.map((id) => store.get(id).conversation),
      [conv.json.conversation, null, null, null, null],
      'only the started turn bound one',
    );
  });

  it('attachments.open(id, conversation): the bytes for its own conversation only; null for another, an unbound one, an unknown or a bad id', async () => {
    const { m, s, store } = await setup({ store: attachmentStore(join(ROOT, 'home', 'attachments')) });
    const { link } = await linked(s);
    const bound = (await upload(s, { link, name: 'part.step', bytes: STEP })).json.attachment_id;
    const loose = (await upload(s, { link, name: 'loose.step', bytes: STEP })).json.attachment_id;
    m.provider.script({ text: 'Ok.' });
    const r = await s.post('/api/assistant/turns', { text: 'Use it', link, attachments: [bound] });
    await settled(s.handle.turns.get(r.json.turn));
    // The default store (<assistant home>/attachments) is the one import_file opens.
    assert.equal(store, attachmentStore());
    const opened = await attachments.open(bound, r.json.conversation);
    assert.ok(opened);
    assert.deepEqual({ ...opened, stream: null }, { id: bound, name: 'part.step', bytes: STEP.length, sha256: createHash('sha256').update(STEP).digest('hex'), format: 'step', stream: null });
    const chunks = [];
    for await (const c of opened.stream) chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks), STEP);
    assert.equal(await attachments.open(bound, 'c-someone-else'), null, "another conversation's");
    assert.equal(await attachments.open(bound, null), null, 'no conversation');
    assert.equal(await attachments.open(loose, r.json.conversation), null, 'unbound: no conversation has it yet');
    assert.equal(await attachments.open('att-0000000000000000', r.json.conversation), null);
    assert.equal(await attachments.open('../meta', r.json.conversation), null);
    // A file gone from disk (or cut short) is not opened.
    writeFileSync(join(store.dir, bound, 'file'), 'cut');
    assert.equal(await attachments.open(bound, r.json.conversation), null);
    await store.clear();
  });

  it("a forgotten conversation's files go with it", async () => {
    const { m, s, store } = await setup();
    const { link } = await linked(s);
    const id = (await upload(s, { link, name: 'part.brep', bytes: BREP })).json.attachment_id;
    const keep = (await upload(s, { link, name: 'keep.brep', bytes: BREP })).json.attachment_id;
    m.provider.script({ text: 'Ok.' });
    const r = await s.post('/api/assistant/turns', { text: 'Use it', link, attachments: [id] });
    await settled(s.handle.turns.get(r.json.turn));
    assert.deepEqual(folders(store).sort(), [id, keep].sort());
    const f = await s.post(`/api/assistant/conversations/${r.json.conversation}/forget`, {});
    assert.equal(f.status, 200);
    // The record goes last: once rm has settled, after the folder is off the disk (a poll can see
    // the folder gone while the record is still kept), so wait for the record.
    await until(() => store.get(id) === null, 5000, 'the attachment forgotten');
    assert.deepEqual(folders(store), [keep], 'its folder removed; the unbound one stays');
  });
});

describe('the sweep', { timeout: 30_000 }, () => {
  /** A folder as another run (or process) left it. */
  function plant(store, id, meta) {
    mkdirSync(join(store.dir, id), { recursive: true });
    writeFileSync(join(store.dir, id, 'file'), STEP);
    if (meta) writeFileSync(join(store.dir, id, 'meta.json'), JSON.stringify({ name: 'x.step', bytes: STEP.length, sha256: '', format: 'step', link_tab: 'tab-x', conversation: null, ...meta }));
  }

  it("takes anything past 24 h, an ended process's, one bound to a conversation no server has, an unbound one past an hour, a folder with no meta past an hour; keeps the rest", async () => {
    // The real clock: a meta-less folder's age is its folder's.
    const now = Date.now();
    const store = freshStore({ now: () => now });
    const H = 60 * 60 * 1000;
    const iso = (ms) => new Date(now - ms).toISOString();
    // A pid that ran and ended.
    const ended = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
    const live = new Set(['c-live']);
    const unwatch = store.watchConversations((id) => live.has(id));
    plant(store, 'att-00000000000000a1', { pid: process.pid, conversation: 'c-live', created_at: iso(25 * H) });
    plant(store, 'att-00000000000000a2', { pid: ended, created_at: iso(1000) });
    plant(store, 'att-00000000000000a3', { pid: process.ppid, created_at: iso(2 * H) });
    plant(store, 'att-00000000000000a4', { pid: process.pid, conversation: 'c-gone', created_at: iso(1000) });
    plant(store, 'att-00000000000000a5', { pid: process.pid, conversation: 'c-live', created_at: iso(5 * H) });
    plant(store, 'att-00000000000000a6', { pid: process.pid, created_at: iso(2 * H) });
    plant(store, 'att-00000000000000a7', { pid: process.pid, created_at: iso(10 * 60 * 1000) });
    // No meta (a receive cut short).
    plant(store, 'att-00000000000000a8', null);
    plant(store, 'att-00000000000000a9', null);
    utimesSync(join(store.dir, 'att-00000000000000a8'), new Date(now - 2 * H), new Date(now - 2 * H));
    mkdirSync(join(store.dir, 'not-an-attachment'));
    assert.equal(await store.sweep(), 5);
    assert.deepEqual(folders(store).sort(), ['att-00000000000000a3', 'att-00000000000000a5', 'att-00000000000000a7', 'att-00000000000000a9', 'not-an-attachment']);
    // An hour on: the young unbound one and the young meta-less one go; the live conversation's stays while it lives.
    assert.equal(await store.sweep({ later: H + 5000 }), 2);
    assert.deepEqual(folders(store).sort(), ['att-00000000000000a3', 'att-00000000000000a5', 'not-an-attachment']);
    live.delete('c-live');
    unwatch();
    assert.equal(await store.sweep(), 1);
    assert.deepEqual(folders(store).sort(), ['att-00000000000000a3', 'not-an-attachment'], "another running Magnusim's stays (under 24 h)");
    assert.equal(await store.sweep({ later: 23 * H }), 1);
    assert.deepEqual(folders(store), ['not-an-attachment']);
    // No folder at all: nothing to do, and nothing made.
    const none = freshStore();
    assert.equal(await none.sweep(), 0);
    assert.equal(existsSync(none.dir), false);
  });

  it("the server's own: one it received and nobody sent goes after an hour (the test route), a live conversation's stays, a reset with files removes them all", async () => {
    process.env.MAGNUSIM_TEST_ASSISTANT = '1';
    try {
      const { m, s, store } = await setup();
      const { link } = await linked(s);
      const loose = (await upload(s, { link, name: 'loose.ply', bytes: PLY })).json.attachment_id;
      const used = (await upload(s, { link, name: 'used.ply', bytes: PLY })).json.attachment_id;
      m.provider.script({ text: 'Ok.' });
      const r = await s.post('/api/assistant/turns', { text: 'Use it', link, attachments: [used] });
      await settled(s.handle.turns.get(r.json.turn));
      const state = await s.get('/api/test/assistant/state');
      assert.deepEqual(
        state.json.attachments.map((a) => [a.id, a.conversation]).sort(),
        [
          [loose, null],
          [used, r.json.conversation],
        ].sort(),
      );
      assert.deepEqual((await s.post('/api/test/assistant/attachments/sweep', {})).json, { ok: true, removed: 0 });
      assert.deepEqual((await s.post('/api/test/assistant/attachments/sweep', { later_ms: 61 * 60 * 1000 })).json, { ok: true, removed: 1 });
      assert.deepEqual(folders(store), [used]);
      assert.equal((await s.post('/api/test/assistant/reset', { files: true })).status, 200);
      assert.deepEqual(folders(store), []);
    } finally {
      delete process.env.MAGNUSIM_TEST_ASSISTANT;
    }
  });
});
