// Review rounds and reference pictures (v0.5.0 Assistant): a workspace that registered a
// review gets its prompt as the next user message once the model ends its answer after one of
// its edit tools succeeded, round i of n, until a round makes no successful edit or the rounds
// are used up; caps and Stop still win; no review when the workspace didn't ask or nothing was
// edited. A turn's reference pictures are checked at its start (type, size, count), go into its
// first user message only once privacy allows the turn, never to a coding agent, and a local
// model known not to read images gets none (with the note).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-review-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { makeManager, startTurn, settled, eventsOf, answerGates, checkInvariants } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const { reviewText } = await import('../assistant/prompt.ts');
const { capText, REVIEW_NO_ROOM_NOTE } = await import('../assistant/loop.ts');
const { AGENT_IMAGES_TEXT } = await import('../assistant/turns.ts');
const { checkPromptImages, IMAGE_CAPS } = await import('../assistant/sanitize.ts');
const { reviewOf } = await import('../assistant/registry.ts');
const { IMAGES_LEFT_OUT_NOTE } = await import('../assistant/providers/openai-compatible.ts');
const { jsonBodyLimit } = await import('../http.ts');

after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

const WING = { id: 'p1', title: 'Wing', created_at: '2026-10-01T10:00:00Z' };
const PROMPT = 'Look at the whole thing and fix what differs. If nothing needs changing, reply "Review: no changes".';
const NONE = { type: 'object', properties: {}, additionalProperties: false };
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A PNG's signature and IHDR (all checkImage reads) for a picture of `w` x `h`, padded to `pad` bytes. */
function png(w, h, pad = 0) {
  const b = Buffer.alloc(Math.max(33, pad));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
}

const mk = (o = {}) => makeManager({ dir: ROOT, projects: { p1: WING }, settings: { privacy: 'allow' }, ...o });
const ofType = (t, type) => eventsOf(t).filter((e) => e.type === type);
const lastUserText = (req) => {
  const m = req.messages.at(-1);
  assert.equal(m.role, 'user');
  return m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
};

/** The ai-demo workspace on tab T1: `add` (edit; fails while `ctl.fail`), `peek` (read); `review` when given. */
function demo(m, { review, ctl = {} } = {}) {
  const ran = [];
  m.registry.setWorkspace('T1', 'L1', {
    plugin: 'ai-demo',
    pluginName: 'Workspace demo',
    workspace: 'Counter',
    projectId: 'p1',
    studyId: 's1',
    tools: [
      { name: 'add', title: 'Add', description: 'Adds one.', inputSchema: NONE, risk: 'edit' },
      { name: 'peek', title: 'Peek', description: 'Reads it.', inputSchema: NONE, risk: 'read' },
    ],
    ...(review ? { review } : {}),
    invoke: async (c) => {
      ran.push(c.tool);
      ctl.onCall?.(c);
      if (c.tool === 'add' && ctl.fail) return { ok: false, error: { code: 'failed', message: 'No room.' }, summary: 'failed' };
      return { ok: true, data: { tool: c.tool }, summary: `${c.tool} ran` };
    },
  });
  return ran;
}
const ADD = { tools: [{ name: 'ai-demo__add', input: {} }] };
const PEEK = { tools: [{ name: 'ai-demo__peek', input: {} }] };

describe('review rounds', () => {
  it('the model ends after an edit: round 1 of n goes as the next user message; a round with no edit ends the turn done', async () => {
    const m = mk();
    const ran = demo(m, { review: { rounds: 3, prompt: PROMPT } });
    m.provider.script(ADD, { text: 'Done.' }, ADD, { text: 'Fixed the side.' }, PEEK, { text: 'Review: no changes' });
    const r = await startTurn(m, { text: 'Make it', tab: 'T1' });
    await settled(r.turn);
    const t = r.turn;
    assert.deepEqual([t.state, t.endReason], ['done', 'end_turn']);
    assert.deepEqual(ran, ['add', 'add', 'peek']);
    assert.deepEqual(ofType(t, 'review').map((e) => [e.round, e.of]), [[1, 3], [2, 3]]);
    const reqs = m.provider.requests.map((x) => x.req);
    assert.equal(reqs.length, 6);
    assert.equal(lastUserText(reqs[2]), `Review round 1 of 3: ${PROMPT}`);
    assert.equal(lastUserText(reqs[4]), `Review round 2 of 3: ${PROMPT}`);
    // The review event comes after the answer it follows, and the page hears the round.
    const types = eventsOf(t).map((e) => e.type);
    assert.ok(types.indexOf('review') > types.indexOf('text'));
    assert.deepEqual(t.pageView().review, { round: 2, of: 3 });
    checkInvariants(assert, t.conv, m.provider.requests);
  });

  it('every round edits: it stops after the n-th round', async () => {
    const m = mk();
    demo(m, { review: { rounds: 2, prompt: PROMPT } });
    m.provider.script(ADD, { text: 'Done.' }, ADD, { text: 'Better.' }, ADD, { text: 'Best.' });
    const r = await startTurn(m, { text: 'Make it', tab: 'T1' });
    await settled(r.turn);
    assert.deepEqual([r.turn.state, r.turn.endReason], ['done', 'end_turn']);
    assert.deepEqual(ofType(r.turn, 'review').map((e) => [e.round, e.of]), [[1, 2], [2, 2]]);
    assert.equal(m.provider.requests.length, 6);
    assert.equal(m.provider.steps.length, 0);
  });

  it('no review: the workspace did not ask, nothing was edited (reads only), or the edit failed', async () => {
    for (const [what, review, script, fail] of [
      ['not asked', undefined, [ADD, { text: 'Done.' }], false],
      ['reads only', { rounds: 3, prompt: PROMPT }, [PEEK, { text: 'It is 2.' }], false],
      ['edit failed', { rounds: 3, prompt: PROMPT }, [ADD, { text: 'It failed.' }], true],
      ['no tools', { rounds: 3, prompt: PROMPT }, [{ text: 'Hello.' }], false],
    ]) {
      const m = mk();
      demo(m, { review, ctl: { fail } });
      m.provider.script(...script);
      const r = await startTurn(m, { text: 'x', tab: 'T1' });
      await settled(r.turn);
      assert.deepEqual([r.turn.state, ofType(r.turn, 'review').length, m.provider.requests.length], ['done', 0, script.length], what);
      assert.equal(r.turn.pageView().review, undefined, what);
    }
  });

  it('a host tool is not the workspace: its edit starts no review', async () => {
    const { hostTool } = await import('./assistant-harness.js');
    const m = mk({ hostTools: [hostTool('bump', { risk: 'edit' })] });
    demo(m, { review: { rounds: 3, prompt: PROMPT } });
    m.provider.script({ tools: [{ name: 'bump', input: {} }] }, { text: 'Done.' });
    const r = await startTurn(m, { text: 'x', tab: 'T1' });
    await settled(r.turn);
    assert.deepEqual([r.turn.state, ofType(r.turn, 'review').length], ['done', 0]);
  });

  it("the rounds count against the turn's caps: a round's calls past the steps cap end it capped; a turn already at its cap gets no round", async () => {
    const m = mk({ caps: { steps: 2 } });
    demo(m, { review: { rounds: 3, prompt: PROMPT } });
    const TWO = { tools: [{ name: 'ai-demo__add', input: {} }, { name: 'ai-demo__add', input: {} }] };
    m.provider.script(ADD, { text: 'Done.' }, TWO, { text: 'Summing up.' });
    const r = await startTurn(m, { text: 'x', tab: 'T1' });
    await settled(r.turn);
    assert.deepEqual([r.turn.state, r.turn.endReason, r.turn.message], ['capped', 'steps', capText('steps', r.turn.settings.caps)]);
    assert.deepEqual(ofType(r.turn, 'review').map((e) => e.round), [1]);
    checkInvariants(assert, r.turn.conv, m.provider.requests);

    const full = mk({ caps: { steps: 1 } });
    demo(full, { review: { rounds: 3, prompt: PROMPT } });
    full.provider.script(ADD, { text: 'Done.' });
    const f = await startTurn(full, { text: 'x', tab: 'T1' });
    await settled(f.turn);
    assert.deepEqual([f.turn.state, f.turn.endReason, ofType(f.turn, 'review').length], ['done', 'end_turn', 0]);
    assert.deepEqual(ofType(f.turn, 'note').map((e) => e.text), [REVIEW_NO_ROOM_NOTE]);
  });

  it('Stop during a review round ends the turn stopped', async () => {
    const m = mk();
    let turn = null;
    let calls = 0;
    demo(m, {
      review: { rounds: 3, prompt: PROMPT },
      ctl: {
        onCall: () => {
          calls += 1;
          if (calls === 2) turn.stop();
        },
      },
    });
    m.provider.script(ADD, { text: 'Done.' }, ADD, { text: 'never' });
    const r = await startTurn(m, { text: 'x', tab: 'T1' });
    turn = r.turn;
    await settled(r.turn);
    assert.deepEqual([r.turn.state, r.turn.endReason], ['stopped', 'user']);
    assert.equal(ofType(r.turn, 'review').length, 1);
    checkInvariants(assert, r.turn.conv, m.provider.requests);
  });

  it('a review while the tab is not connected is not asked for', async () => {
    const m = mk();
    demo(m, { review: { rounds: 3, prompt: PROMPT }, ctl: { onCall: () => m.registry.setConnected('T1', 'L1', false) } });
    m.provider.script(ADD, { text: 'Done.' });
    const r = await startTurn(m, { text: 'x', tab: 'T1' });
    await settled(r.turn);
    assert.deepEqual([r.turn.state, ofType(r.turn, 'review').length], ['done', 0]);
  });

  it("the review prompt's text: round i of n, the prompt cleaned (its lines kept), and the reference pictures named", () => {
    assert.equal(reviewText(1, 3, 'Check it.', 0), 'Review round 1 of 3: Check it.');
    assert.equal(reviewText(2, 3, 'Check it.\r\nThen fix.', 0), 'Review round 2 of 3: Check it.\nThen fix.');
    assert.equal(reviewText(1, 2, 'Check it.', 1), 'Review round 1 of 2: Check it.\nThe request came with a reference picture (in its first message): compare the result with it too.');
    assert.match(reviewText(1, 2, 'Check it.', 3), /with 3 reference pictures .*compare the result with them too\.$/);
  });

  it("the registry keeps a review only in shape: 1 to 5 rounds and a prompt (cleaned, at most 1500 characters)", () => {
    assert.deepEqual(reviewOf({ rounds: 3, prompt: ' Look.\u0007 ' }), { rounds: 3, prompt: 'Look.' });
    assert.equal(reviewOf({ rounds: 3, prompt: 'x'.repeat(2000) }).prompt.length, 1500);
    for (const bad of [null, undefined, 'x', [], { rounds: 0, prompt: 'x' }, { rounds: 6, prompt: 'x' }, { rounds: 1.5, prompt: 'x' }, { rounds: 2, prompt: '' }, { rounds: 2, prompt: '  ' }, { rounds: '2', prompt: 'x' }]) {
      assert.equal(reviewOf(bad), null, JSON.stringify(bad));
    }
  });
});

describe('reference pictures', () => {
  it('checked at the start: type, base64, the declared type, at most 4, at most 1.5 MB and 2000 px a side', () => {
    const ok = { media_type: 'image/png', data: PNG_1x1 };
    assert.deepEqual(checkPromptImages(undefined), { ok: true, images: [] });
    assert.deepEqual(checkPromptImages([ok]), { ok: true, images: [{ type: 'image', mediaType: 'image/png', base64: PNG_1x1, width: 1, height: 1 }] });
    const code = (raw) => {
      const r = checkPromptImages(raw);
      return r.ok ? 'ok' : r.code;
    };
    assert.equal(code('x'), 'bad_images');
    assert.equal(code([{ media_type: 'image/gif', data: PNG_1x1 }]), 'bad_images');
    assert.equal(code([{ media_type: 'image/jpeg', data: PNG_1x1 }]), 'bad_images', 'not the type it says');
    assert.equal(code([{ media_type: 'image/png', data: 'not base64!' }]), 'bad_images');
    assert.equal(code([{ media_type: 'image/png', data: Buffer.from('hello there').toString('base64') }]), 'bad_images', 'not an image');
    assert.equal(code([{ media_type: 'image/png' }]), 'bad_images');
    assert.equal(code([ok, ok, ok, ok]), 'ok');
    assert.equal(code([ok, ok, ok, ok, ok]), 'images_too_large');
    assert.equal(code([{ media_type: 'image/png', data: png(2001, 10) }]), 'images_too_large');
    assert.equal(code([{ media_type: 'image/png', data: png(2000, 2000) }]), 'ok');
    assert.equal(code([{ media_type: 'image/png', data: png(10, 10, IMAGE_CAPS.bytes + 1) }]), 'images_too_large');
    assert.equal(code([{ media_type: 'image/png', data: png(10, 10, IMAGE_CAPS.bytes) }]), 'ok');
    assert.match(checkPromptImages([ok, { media_type: 'image/png', data: png(3000, 10) }]).message, /^Picture 2 of 2: The image is 3000×10 px/);
  });

  it("the turn route's body may carry them: 10 MB (other assistant routes keep their limits)", () => {
    assert.equal(jsonBodyLimit('/api/assistant/turns'), 10 * 1024 * 1024);
    assert.equal(jsonBodyLimit('/api/assistant/turns/t-1/stop'), 64 * 1024);
  });

  it('a start with bad pictures is refused before anything runs; a coding agent takes none', async () => {
    const m = mk();
    let r = await startTurn(m, { text: 'x', images: [{ media_type: 'image/png', data: png(5000, 5) }] });
    assert.deepEqual([r.status, r.body.code], [400, 'images_too_large']);
    r = await startTurn(m, { text: 'x', images: 'pic' });
    assert.deepEqual([r.status, r.body.code], [400, 'bad_images']);
    r = await startTurn(m, { text: 'x', provider: 'agent:someone', images: [{ media_type: 'image/png', data: PNG_1x1 }] });
    assert.deepEqual([r.status, r.body.code, r.body.error], [400, 'bad_images', AGENT_IMAGES_TEXT]);
    assert.equal(m.provider.requests.length, 0);
  });

  it("they go into the turn's first user message after the prompt; later requests keep them; a review round names them", async () => {
    const m = mk();
    demo(m, { review: { rounds: 1, prompt: PROMPT } });
    m.provider.script(ADD, { text: 'Done.' }, { text: 'Review: no changes' });
    const r = await startTurn(m, { text: 'Like this', tab: 'T1', images: [{ media_type: 'image/png', data: PNG_1x1 }] });
    await settled(r.turn);
    assert.equal(r.turn.state, 'done');
    const first = m.provider.requests[0].req.messages[0];
    assert.deepEqual(first.parts.map((p) => p.type), ['text', 'image', 'text']);
    assert.deepEqual(first.parts[1], { type: 'image', mediaType: 'image/png', base64: PNG_1x1, width: 1, height: 1 });
    assert.deepEqual(m.provider.requests[2].req.messages[0], first);
    assert.match(lastUserText(m.provider.requests[2].req), /^Review round 1 of 1: .*\nThe request came with a reference picture/s);
    // Never in the turn's log.
    assert.ok(!JSON.stringify(eventsOf(r.turn)).includes(PNG_1x1));
    // Let go at its end: the window's copy is the kept p1 (within the picture budgets), not the sent one.
    assert.deepEqual(r.turn.promptImages, [], 'the sent pictures are let go at the end');
    assert.notEqual(r.turn.imageOf('p1'), null);
  });

  it('a cloud turn on a project: nothing goes, pictures included, until privacy allows it; "Don\'t send" keeps them here', async () => {
    const m = mk({ settings: { privacy: 'ask' } });
    m.provider.script({ text: 'never' });
    const r = await startTurn(m, { text: 'x', context: { project_id: 'p1' }, images: [{ media_type: 'image/png', data: PNG_1x1 }] });
    assert.equal(r.status, 202);
    answerGates(m, r.turn, () => false);
    await settled(r.turn);
    assert.deepEqual([r.turn.state, r.turn.endReason], ['stopped', 'privacy']);
    assert.equal(m.provider.requests.length, 0);
    assert.equal(r.turn.conv.messages.length, 0, 'the pictures never entered the conversation');

    const d = mk({ settings: { privacy: 'deny' } });
    const refused = await startTurn(d, { text: 'x', context: { project_id: 'p1' }, images: [{ media_type: 'image/png', data: PNG_1x1 }] });
    assert.deepEqual([refused.status, refused.body.code], [400, 'privacy_denied']);

    const a = mk({ settings: { privacy: 'ask' } });
    a.provider.script({ text: 'sent' });
    const s = await startTurn(a, { text: 'x', context: { project_id: 'p1' }, images: [{ media_type: 'image/png', data: PNG_1x1 }] });
    const order = [];
    s.turn.subscribe((e) => e.type === 'gate' && order.push(['gate', a.provider.requests.length]));
    answerGates(a, s.turn, () => true);
    await settled(s.turn);
    assert.deepEqual(order, [['gate', 0]], 'asked before any request');
    assert.equal(a.provider.requests[0].req.messages[0].parts[1].type, 'image');
  });

  it('a local model known not to read images gets none, with the note once; one not known yet gets them (its adapter decides)', async () => {
    const m = mk({ provider: 'openai_compatible' });
    m.provider.readsImages = () => false;
    m.provider.script({ text: 'No pictures.' });
    const r = await startTurn(m, { text: 'x', images: [{ media_type: 'image/png', data: PNG_1x1 }] });
    await settled(r.turn);
    assert.equal(r.turn.state, 'done');
    assert.deepEqual(m.provider.requests[0].req.messages[0].parts.map((p) => p.type), ['text', 'text']);
    assert.deepEqual(ofType(r.turn, 'note').map((e) => e.text), [IMAGES_LEFT_OUT_NOTE]);

    const u = mk({ provider: 'openai_compatible' });
    u.provider.readsImages = () => null;
    u.provider.script({ text: 'Maybe.' });
    const r2 = await startTurn(u, { text: 'x', images: [{ media_type: 'image/png', data: PNG_1x1 }] });
    await settled(r2.turn);
    assert.deepEqual(u.provider.requests[0].req.messages[0].parts.map((p) => p.type), ['text', 'image', 'text']);
  });

  it("they are kept for the request's window from its start: prompt_images p1..p4 on its summary, the bytes on the turn; none without", async () => {
    const m = mk();
    m.provider.script({ hold: 'h' });
    const one = png(40, 30, 64);
    const two = png(20, 10);
    const heard = [];
    const off = m.manager.onTurnChange((t, kind) => kind === 'started' && heard.push(t.summary().prompt_images));
    const r = await startTurn(m, { text: 'Like these', images: [{ media_type: 'image/png', data: one }, { media_type: 'image/png', data: two }] });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const refs = [
      { n: 'p1', media_type: 'image/png', width: 40, height: 30 },
      { n: 'p2', media_type: 'image/png', width: 20, height: 10 },
    ];
    assert.deepEqual(r.turn.summary().prompt_images, refs);
    assert.deepEqual(heard, [refs], 'already on the summary its start announces');
    assert.deepEqual(r.turn.imageOf('p1').bytes, Buffer.from(one, 'base64'));
    assert.deepEqual(r.turn.imageOf('p2').bytes, Buffer.from(two, 'base64'));
    assert.equal(r.turn.imageOf('p3'), null);
    await m.provider.reached('h');
    r.turn.stop();
    await settled(r.turn);
    off();

    const plain = mk();
    plain.provider.script({ text: 'Done.' });
    const p = await startTurn(plain, { text: 'No pictures' });
    await settled(p.turn);
    assert.deepEqual(p.turn.summary().prompt_images, []);
    assert.equal(p.turn.imageOf('p1'), null);
  });
});
