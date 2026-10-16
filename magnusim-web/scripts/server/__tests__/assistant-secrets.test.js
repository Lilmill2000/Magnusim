// The Assistant's key store (Foundation spec 3): the real file protector and envelope on
// every OS, sealed keys bound to their slot and master, a damaged keys file set aside, a
// blocked or slow helper leaving nothing written, saves serialized, one unwrap however many
// callers wait, status() never decrypting, the key in no other file and never in
// process.env, and the test switch honoured only with MAGNUSIM_TEST_ASSISTANT=1.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-secrets-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const envelope = await import('../assistant/secrets/envelope.ts');
const { fileProtector } = await import('../assistant/secrets/file.ts');
const { pickProtector, ProtectorError } = await import('../assistant/secrets/protector.ts');
const store = await import('../assistant/secrets/store.ts');
const { resetAssistantState } = await import('../assistant/state.ts');
const { redact, registerSecretForRedaction } = await import('../assistant/redact.ts');
const { ProviderError } = await import('../assistant/types.ts');

const CANARY = 'sk-ant-canary-0123456789-ZZtop-9Qa1';
const OTHER = 'sk-other-canary-abcdefghijklmnop';

after(() => {
  resetAssistantState();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

let n = 0;
let dir = '';
beforeEach(() => {
  resetAssistantState();
  n += 1;
  dir = join(ROOT, `secrets-${n}`);
});

/** A protector that counts its calls (and can hold an unwrap until released). */
function spy(inner = fileProtector()) {
  const calls = { protect: 0, unprotect: 0 };
  let gate = null;
  let entered;
  const firstUnwrap = new Promise((r) => (entered = r));
  const p = {
    kind: inner.kind,
    knownUnavailable: inner.knownUnavailable,
    calls,
    /** Resolves when the first unwrap starts. */
    firstUnwrap,
    hold() {
      let release;
      gate = new Promise((r) => (release = r));
      return () => release();
    },
    async protect(m) {
      calls.protect += 1;
      return inner.protect(m);
    },
    async unprotect(doc) {
      calls.unprotect += 1;
      entered();
      if (gate) await gate;
      return inner.unprotect(doc);
    },
  };
  return p;
}

const make = (protector, o = {}) => store.createSecretStore({ dir, picked: { protector, test: null }, ...o });
const keysFile = () => JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8'));
const files = (d = dir) => (existsSync(d) ? readdirSync(d) : []);

/** Every file under `d`, recursively. */
function walk(d) {
  if (!existsSync(d)) return [];
  const out = [];
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('the envelope', () => {
  const master = Buffer.alloc(32, 7);

  it('seals and opens, with a fresh IV each time', () => {
    const a = envelope.seal(master, 'anthropic', CANARY);
    const b = envelope.seal(master, 'anthropic', CANARY);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
    assert.equal(Buffer.from(a.iv, 'base64').length, 12);
    assert.equal(Buffer.from(a.tag, 'base64').length, 16);
    assert.equal(envelope.open(master, 'anthropic', a), CANARY);
    assert.doesNotMatch(JSON.stringify(a), /canary/);
  });

  it('is bound to its slot and its master (AAD), and to every byte', () => {
    const s = envelope.seal(master, 'anthropic', CANARY);
    assert.throws(() => envelope.open(master, 'openai', s));
    assert.throws(() => envelope.open(Buffer.alloc(32, 8), 'anthropic', s));
    const tag = Buffer.from(s.tag, 'base64');
    tag[0] ^= 1;
    assert.throws(() => envelope.open(master, 'anthropic', { ...s, tag: tag.toString('base64') }));
    const ct = Buffer.from(s.ct, 'base64');
    ct[0] ^= 1;
    assert.throws(() => envelope.open(master, 'anthropic', { ...s, ct: ct.toString('base64') }));
    assert.throws(() => envelope.open(master, 'anthropic', { ...s, iv: '' }));
    assert.throws(() => envelope.seal(Buffer.alloc(16), 'anthropic', CANARY));
    assert.match(envelope.masterId(master), /^[0-9a-f]{16}$/);
    assert.equal(envelope.masterId(master), envelope.masterId(Buffer.alloc(32, 7)));
    assert.notEqual(envelope.masterId(master), envelope.masterId(Buffer.alloc(32, 8)));
  });
});

describe('the file protector', () => {
  it('round trip; refuses a master kept another way or damaged', async () => {
    const p = fileProtector();
    const m = Buffer.alloc(32, 3);
    const doc = await p.protect(m);
    assert.equal(doc.protector, 'file');
    assert.deepEqual(await p.unprotect(doc), m);
    await assert.rejects(p.unprotect({ ...doc, protector: 'dpapi', blob: 'x' }), (e) => e instanceof ProtectorError && e.code === 'cant_unlock');
    await assert.rejects(p.unprotect({ ...doc, key: Buffer.alloc(8).toString('base64') }), (e) => e.code === 'cant_unlock');
  });
});

describe('saving, using and removing a key', () => {
  it('round trip through the files; the key is in no file and not in process.env; status shows the last 4', async () => {
    const p = spy();
    const s = make(p);
    await s.load();
    assert.deepEqual(s.status().anthropic, { set: false, last4: null, set_at: null, state: 'none' });
    assert.deepEqual(await s.setKey('anthropic', `  ${CANARY}\n`), {});
    assert.equal(p.calls.protect, 1, 'one protect, on the first save');
    const st = s.status();
    assert.equal(st.anthropic.set, true);
    assert.equal(st.anthropic.last4, '9Qa1');
    assert.equal(st.anthropic.state, 'ok');
    assert.match(st.anthropic.set_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(st.openai.set, false);
    assert.equal(await s.withKey('anthropic', async (k) => k), CANARY, 'trimmed');
    assert.deepEqual(files().sort(), ['keys.json', 'master.json']);
    const doc = keysFile();
    assert.equal(doc.version, 1);
    assert.match(doc.master_id, /^[0-9a-f]{16}$/);
    assert.deepEqual(Object.keys(doc.keys), ['anthropic']);
    for (const f of walk(ROOT)) assert.doesNotMatch(readFileSync(f, 'latin1'), /canary/, f);
    for (const [k, v] of Object.entries(process.env)) assert.ok(!String(v).includes(CANARY), k);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'keys.json')).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, 'master.json')).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
    // Once saved or used, a key is scrubbed from any text, whatever its shape.
    await s.setKey('openai_compatible', 'plain-local-token-77');
    assert.equal(redact('refused plain-local-token-77!'), 'refused [redacted]!');
    resetAssistantState();
    assert.equal(redact('plain-local-token-77'), 'plain-local-token-77', 'a later run knows it only once used');
    assert.equal(await make(spy()).withKey('openai_compatible', async (k) => k), 'plain-local-token-77');
    assert.equal(redact('plain-local-token-77'), '[redacted]');
  });

  it('past 64 secrets, redaction forgets the one registered longest ago, never the longest one', () => {
    const LONG = 'LocalServerToken_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789';
    const OLD = 'old-token-01';
    registerSecretForRedaction(OLD);
    registerSecretForRedaction(LONG);
    const tokens = Array.from({ length: 63 }, (_, i) => `tok${String(i).padStart(7, '0')}`);
    for (const t of tokens) registerSecretForRedaction(t);
    assert.equal(redact(`bad token ${LONG}`), 'bad token [redacted]', 'the long key is still scrubbed');
    assert.equal(redact(OLD), OLD, 'the oldest one went');
    assert.equal(redact(tokens[0]), '[redacted]');
    // Used again, a key counts as new.
    registerSecretForRedaction(LONG);
    registerSecretForRedaction('one-more-token-01');
    assert.equal(redact(LONG), '[redacted]');
    assert.equal(redact(tokens[0]), tokens[0]);
    // A key that holds another is still removed whole, and its escaped forms too.
    registerSecretForRedaction('abc/def+ghi');
    registerSecretForRedaction('abc/def+ghi-and-more');
    assert.equal(redact('k=abc/def+ghi-and-more'), 'k=[redacted]');
    assert.equal(redact(`u=${encodeURIComponent('abc/def+ghi')}`), 'u=[redacted]');
  });

  it('status() never decrypts: a later run reads the files with no helper, and unwraps on first use only', async () => {
    await make(spy()).setKey('anthropic', CANARY);
    resetAssistantState();
    const p = spy();
    const s = make(p);
    await s.load();
    for (let i = 0; i < 5; i += 1) s.status();
    s.storage();
    assert.deepEqual(p.calls, { protect: 0, unprotect: 0 });
    assert.equal(s.status().anthropic.last4, '9Qa1');
    assert.equal(await s.withKey('anthropic', async (k) => k.length), CANARY.length);
    assert.equal(await s.withKey('anthropic', async (k) => k.length), CANARY.length);
    assert.deepEqual(p.calls, { protect: 0, unprotect: 1 }, 'the master is cached');
  });

  it('checks a key without ever repeating it; warns about an unusual cloud key; last4 only for 16+', async () => {
    const s = make(spy());
    for (const [slot, bad] of [['anthropic', 'short'], ['anthropic', 'has space-inside-it'], ['openai', 'x'.repeat(513)], ['openai', ''], ['openai_compatible', 'a b'], ['anthropic', 42]]) {
      await assert.rejects(s.setKey(slot, bad), (e) => {
        assert.ok(e instanceof store.KeyError);
        assert.equal(e.status, 400);
        assert.equal(e.code, 'invalid_key');
        if (typeof bad === 'string' && bad) assert.ok(!e.message.includes(bad), e.message);
        return true;
      });
    }
    await assert.rejects(s.setKey('cloud', CANARY), (e) => e.status === 400 && e.code === 'bad_provider' && !e.message.includes(CANARY));
    assert.equal(files().length, 0, 'nothing written');
    const w = await s.setKey('anthropic', 'abcdefgh12');
    assert.match(w.warning, /sk-ant-/);
    assert.equal(s.status().anthropic.last4, null, 'under 16 characters: no last 4');
    assert.match((await s.setKey('openai', 'key-without-prefix-1234')).warning, /sk-/);
    assert.deepEqual(await s.setKey('openai', 'sk-proj-abcdefghijklmnop'), {});
    assert.deepEqual(await s.setKey('openai_compatible', 't'), {}, 'a local server token may be short');
    assert.equal(s.status().openai_compatible.last4, null);
  });

  it('remove clears the slot and keeps the others; listeners hear saves and removals', async () => {
    const s = make(spy());
    const heard = [];
    const off = s.onKeyChanged((slot) => heard.push(slot));
    await s.setKey('anthropic', CANARY);
    await s.setKey('openai', OTHER);
    await s.removeKey('anthropic');
    assert.equal(s.status().anthropic.set, false);
    assert.equal(s.status().openai.state, 'ok');
    assert.deepEqual(Object.keys(keysFile().keys), ['openai']);
    await assert.rejects(s.withKey('anthropic', async () => 1), (e) => e instanceof ProviderError && e.code === 'no_key');
    await s.removeKey('openai_compatible'); // nothing saved: fine
    off();
    await s.removeKey('openai');
    assert.deepEqual(heard, ['anthropic', 'openai', 'anthropic', 'openai_compatible']);
    await assert.rejects(s.removeKey('nope'), (e) => e.code === 'bad_provider');
  });
});

describe('what goes wrong', () => {
  it('a sealed key moved to another slot does not open (only that slot is unreadable)', async () => {
    await make(spy()).setKey('anthropic', CANARY);
    const doc = keysFile();
    doc.keys.openai = doc.keys.anthropic;
    writeFileSync(join(dir, 'keys.json'), JSON.stringify(doc));
    resetAssistantState();
    const s = make(spy());
    await s.load();
    assert.equal(s.status().openai.state, 'ok', 'status does not decrypt');
    await assert.rejects(s.withKey('openai', async () => 1), (e) => e.code === 'no_key');
    assert.equal(s.status().openai.state, 'unreadable');
    assert.equal(s.status().anthropic.state, 'ok');
    assert.equal(await s.withKey('anthropic', async (k) => k), CANARY);
  });

  it('a damaged keys.json is set aside and read as empty', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keys.json'), '{"version":1,"keys":');
    const s = make(spy());
    await s.load();
    assert.equal(s.notice(), store.SET_ASIDE_NOTICE);
    for (const k of store.KEY_SLOTS) assert.equal(s.status()[k].state, 'none');
    assert.ok(files().some((f) => /^keys\.json\.bad-\d+$/.test(f)), files().join());
    assert.equal(existsSync(join(dir, 'keys.json')), false);
    await s.setKey('anthropic', CANARY);
    assert.equal(s.notice(), null);
  });

  it('keys sealed under another master, or with no master file, are all unreadable; the next save starts afresh', async () => {
    await make(spy()).setKey('anthropic', CANARY);
    await make(spy()).setKey('openai', OTHER);
    const doc = keysFile();
    writeFileSync(join(dir, 'keys.json'), JSON.stringify({ ...doc, master_id: '0000000000000000' }));
    resetAssistantState();
    const s = make(spy());
    await assert.rejects(s.withKey('anthropic', async () => 1), (e) => e.code === 'no_key');
    assert.equal(s.status().anthropic.state, 'unreadable');
    assert.equal(s.status().openai.state, 'unreadable');
    // No master file at all.
    rmSync(join(dir, 'master.json'));
    resetAssistantState();
    const p = spy();
    const t = make(p);
    await t.load();
    assert.equal(t.status().openai.state, 'unreadable');
    await t.setKey('openai', OTHER);
    assert.equal(p.calls.protect, 1, 'a new master');
    assert.deepEqual(Object.keys(keysFile().keys), ['openai'], 'keys of the lost master go');
    assert.equal(t.status().openai.state, 'ok');
    assert.equal(t.status().anthropic.state, 'none');
  });

  it("a master this account can't unlock: every slot unreadable, no second helper run, and the next save makes a new master", async () => {
    await make(spy()).setKey('anthropic', CANARY);
    resetAssistantState();
    const locked = {
      kind: 'file',
      knownUnavailable: null,
      calls: { protect: 0, unprotect: 0 },
      async protect(m) {
        this.calls.protect += 1;
        return fileProtector().protect(m);
      },
      async unprotect() {
        this.calls.unprotect += 1;
        throw new ProtectorError('cant_unlock', 'another account');
      },
    };
    const s = make(locked);
    await assert.rejects(s.withKey('anthropic', async () => 1), (e) => e.code === 'no_key');
    await assert.rejects(s.withKey('anthropic', async () => 1), (e) => e.code === 'no_key');
    assert.equal(locked.calls.unprotect, 1);
    assert.equal(s.status().anthropic.state, 'unreadable');
    await s.setKey('openai', OTHER);
    assert.equal(locked.calls.protect, 1);
    assert.equal(s.status().openai.state, 'ok');
    assert.equal(s.status().anthropic.set, false);
    assert.equal(await s.withKey('openai', async (k) => k), OTHER);
  });

  it('blocked: keys cannot be stored, the reason is known without trying, and nothing is written', async () => {
    const picked = pickProtector({ env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROTECTOR: 'blocked' } });
    assert.equal(picked.test, 'blocked');
    const s = store.createSecretStore({ dir, picked });
    await s.load();
    assert.deepEqual(s.storage(), { kind: 'unavailable', reason: 'blocked', note: store.STORAGE_NOTES.blocked });
    await assert.rejects(s.setKey('anthropic', CANARY), (e) => e.status === 409 && e.code === 'storage_unavailable' && e.message === store.STORAGE_NOTES.blocked);
    assert.equal(existsSync(dir), false, 'nothing written');
  });

  it('a real helper that is blocked when tried: unavailable until restart', async () => {
    const blockedLater = { kind: 'dpapi', knownUnavailable: null, calls: 0, async protect() { this.calls += 1; throw new ProtectorError('blocked', 'language mode'); }, async unprotect() { throw new ProtectorError('blocked'); } };
    const s = make(blockedLater, { now: () => 0 });
    assert.equal(s.storage().kind, 'dpapi');
    await assert.rejects(s.setKey('anthropic', CANARY), (e) => e.code === 'storage_unavailable');
    assert.equal(s.storage().reason, 'blocked');
    await assert.rejects(s.setKey('anthropic', CANARY), (e) => e.code === 'storage_unavailable');
    assert.equal(blockedLater.calls, 1, 'not tried again');
    assert.equal(existsSync(dir), false);
  });

  it('timeout: nothing written; the next save tries again only after 60 s', async () => {
    const picked = pickProtector({ env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROTECTOR: 'timeout' } });
    assert.equal(picked.test, 'timeout');
    let now = 1_000_000;
    let tries = 0;
    const inner = picked.protector;
    const counted = { ...inner, kind: inner.kind, knownUnavailable: null, protect: (m) => (tries += 1, inner.protect(m)), unprotect: (d) => inner.unprotect(d) };
    const s = make(counted, { now: () => now });
    assert.equal(s.storage().reason, null, 'not known before trying');
    await assert.rejects(s.setKey('anthropic', CANARY), (e) => e.code === 'storage_unavailable' && e.message === store.STORAGE_NOTES.timeout);
    assert.deepEqual(s.storage(), { kind: 'unavailable', reason: 'timeout', note: store.STORAGE_NOTES.timeout });
    await assert.rejects(s.setKey('anthropic', CANARY), (e) => e.code === 'storage_unavailable');
    assert.equal(tries, 1, 'no retry within 60 s');
    now += store.RETRY_AFTER_MS;
    assert.equal(s.storage().reason, null);
    await assert.rejects(s.setKey('anthropic', CANARY), (e) => e.code === 'storage_unavailable');
    assert.equal(tries, 2, 'tried again after 60 s');
    assert.equal(existsSync(dir), false, 'nothing written');
  });

  it('a write that fails leaves the files as they were, with a plain 500', async () => {
    const s = make(spy());
    await s.setKey('openai', OTHER);
    const before = readFileSync(join(dir, 'keys.json'), 'utf8');
    // keys.json can't be replaced while a folder of that name blocks the temp file's rename.
    rmSync(join(dir, 'keys.json'));
    mkdirSync(join(dir, 'keys.json'));
    writeFileSync(join(dir, 'keys.json', 'x'), 'x');
    await assert.rejects(s.setKey('anthropic', CANARY), (e) => {
      assert.equal(e.status, 500);
      assert.equal(e.code, 'write_failed');
      assert.match(e.message, /^The key could not be saved: /);
      assert.ok(!e.message.includes(CANARY));
      return true;
    });
    assert.equal(s.status().anthropic.set, false);
    assert.equal(s.status().openai.state, 'ok');
    assert.ok(before.includes('"openai"'));
    assert.deepEqual(files().filter((f) => f.endsWith('.tmp')), []);
  });
});

describe('at the same time', () => {
  it('saves are serialized: none lost, the last one for a slot wins, one master made', async () => {
    const p = spy();
    const s = make(p);
    await Promise.all([
      s.setKey('anthropic', 'sk-ant-first-key-0000000001'),
      s.setKey('openai', OTHER),
      s.setKey('openai_compatible', 'local-token'),
      s.setKey('anthropic', CANARY),
    ]);
    assert.equal(p.calls.protect, 1);
    assert.deepEqual(Object.keys(keysFile().keys).sort(), ['anthropic', 'openai', 'openai_compatible']);
    resetAssistantState();
    const t = make(spy());
    assert.equal(await t.withKey('anthropic', async (k) => k), CANARY);
    assert.equal(await t.withKey('openai_compatible', async (k) => k), 'local-token');
  });

  it('three first uses at once unwrap the master once (single-flight)', async () => {
    await make(spy()).setKey('anthropic', CANARY);
    await make(spy()).setKey('openai', OTHER);
    resetAssistantState();
    const p = spy();
    const release = p.hold();
    const s = make(p);
    const uses = Promise.all([
      s.withKey('anthropic', async (k) => k),
      s.withKey('openai', async (k) => k),
      s.withKey('anthropic', async (k) => k.length),
    ]);
    // The three share one load, so all have asked for the master by the next turn of the loop.
    await p.firstUnwrap;
    await new Promise((r) => setImmediate(r));
    assert.equal(p.calls.unprotect, 1);
    release();
    assert.deepEqual(await uses, [CANARY, OTHER, CANARY.length]);
    assert.equal(p.calls.unprotect, 1);
    // Another store in this server shares the cached master.
    const q = spy();
    assert.equal(await make(q).withKey('openai', async (k) => k), OTHER);
    assert.equal(q.calls.unprotect, 0);
  });

  it('the slow: test switch delays each helper run and keeps the file protector', async () => {
    const picked = pickProtector({ env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROTECTOR: 'slow:60' } });
    assert.equal(picked.test, 'slow:60');
    assert.equal(picked.protector.kind, 'file');
    const t0 = Date.now();
    const doc = await picked.protector.protect(Buffer.alloc(32, 1));
    assert.ok(Date.now() - t0 >= 50);
    assert.deepEqual(await picked.protector.unprotect(doc), Buffer.alloc(32, 1));
  });
});

describe('the test switch needs MAGNUSIM_TEST_ASSISTANT=1', () => {
  function capture(fn) {
    const lines = [];
    const orig = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try {
      return { out: fn(), lines };
    } finally {
      console.warn = orig;
    }
  }

  it('alone it is ignored with a warning: on Windows the DPAPI protector stays (by a spy), and the switch reads null', () => {
    let dpapiMade = 0;
    const dpapi = { kind: 'dpapi', knownUnavailable: null, protect: async () => ({}), unprotect: async () => Buffer.alloc(32) };
    const makeDpapi = () => (dpapiMade += 1, dpapi);
    for (const value of ['file', 'blocked', 'slow:10']) {
      const { out, lines } = capture(() => pickProtector({ env: { MAGNUSIM_TEST_ASSISTANT_PROTECTOR: value }, platform: 'win32', makeDpapi }));
      assert.equal(out.protector, dpapi, value);
      assert.equal(out.test, null, value);
      assert.ok(lines.some((l) => /^\[assistant\] MAGNUSIM_TEST_ASSISTANT_PROTECTOR is ignored/.test(l)), lines.join('\n'));
    }
    assert.equal(dpapiMade, 3);
    const zero = capture(() => pickProtector({ env: { MAGNUSIM_TEST_ASSISTANT: '0', MAGNUSIM_TEST_ASSISTANT_PROTECTOR: 'file' }, platform: 'win32', makeDpapi }));
    assert.equal(zero.out.protector, dpapi);
  });

  it('with it, the switch applies; an unknown value is ignored; unset gives the platform protector', () => {
    const makeDpapi = () => ({ kind: 'dpapi', knownUnavailable: null, protect: async () => ({}), unprotect: async () => Buffer.alloc(32) });
    const on = pickProtector({ env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROTECTOR: 'file' }, platform: 'win32', makeDpapi });
    assert.equal(on.protector.kind, 'file');
    assert.equal(on.test, 'file');
    const blocked = pickProtector({ env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROTECTOR: 'blocked' }, platform: 'win32', makeDpapi });
    assert.equal(blocked.protector.knownUnavailable, 'blocked');
    const odd = capture(() => pickProtector({ env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROTECTOR: 'plaintext' }, platform: 'win32', makeDpapi }));
    assert.equal(odd.out.protector.kind, 'dpapi');
    assert.equal(odd.out.test, null);
    assert.equal(pickProtector({ env: {}, platform: 'win32', makeDpapi }).protector.kind, 'dpapi');
    assert.equal(pickProtector({ env: {}, platform: 'linux' }).protector.kind, 'file');
    assert.equal(pickProtector({ env: {}, platform: 'darwin' }).protector.kind, 'file');
  });

  it("the server's store picks once, from the environment of its first use", async () => {
    process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'blocked';
    try {
      const s = store.secretStore();
      assert.equal(s.testProtector, null, 'ignored without MAGNUSIM_TEST_ASSISTANT=1');
      assert.equal(s.protector.kind, process.platform === 'win32' ? 'dpapi' : 'file');
      assert.equal(s.dir, join(ROOT, 'home', 'secrets'));
      process.env.MAGNUSIM_TEST_ASSISTANT = '1';
      assert.equal(store.secretStore(), s, 'picked once');
      resetAssistantState();
      const t = store.secretStore();
      assert.equal(t.testProtector, 'blocked');
      assert.equal(t.storage().kind, 'unavailable');
    } finally {
      delete process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR;
      delete process.env.MAGNUSIM_TEST_ASSISTANT;
    }
  });
});
