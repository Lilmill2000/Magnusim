// DPAPI through Windows PowerShell 5.1 (Foundation spec 3.3): how the helper's answers
// read (on every OS, with a stand-in process), and on Windows the real thing: a round trip,
// no secret or base64 of it in the command line, and one unwrap however many first uses
// wait for it.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-dpapi-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const dpapi = await import('../assistant/secrets/dpapi.ts');
const { ProtectorError } = await import('../assistant/secrets/protector.ts');
const store = await import('../assistant/secrets/store.ts');
const { resetAssistantState } = await import('../assistant/state.ts');
const { spawn } = await import('node:child_process');

after(() => {
  resetAssistantState();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

/** A stand-in powershell.exe: records what it was given and answers as told. */
function fakeSpawn(answer) {
  const runs = [];
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    let input = '';
    child.stdin = new EventEmitter();
    child.stdin.end = (text) => {
      input += text;
      setImmediate(() => answer(child, input));
    };
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    runs.push({ cmd, args, opts, child, input: () => input });
    return child;
  };
  return { impl, runs };
}

const close = (child, code, { out = '', err = '' } = {}) => {
  if (out) child.stdout.emit('data', out);
  if (err) child.stderr.emit('data', err);
  child.emit('close', code);
};

const SECRET = Buffer.from('0123456789abcdef0123456789ABCDEF');

describe('the helper process (a stand-in, every OS)', () => {
  it('starts Windows PowerShell 5.1 by absolute path, hidden, with the fixed script; the bytes go only on stdin', async () => {
    const f = fakeSpawn((child, input) => {
      const [op, b64] = input.trim().split('\n');
      assert.equal(op, 'protect');
      close(child, 0, { out: `${Buffer.from(b64, 'base64').reverse().toString('base64')}\r\n` });
    });
    const out = await dpapi.runDpapi('protect', SECRET, { spawnImpl: f.impl });
    assert.deepEqual(out, Buffer.from(SECRET).reverse());
    const run = f.runs[0];
    assert.match(run.cmd, /[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    assert.deepEqual(run.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', dpapi.SCRIPT_B64]);
    assert.equal(run.opts.windowsHide, true);
    assert.equal(run.input(), `protect\n${SECRET.toString('base64')}\n`);
    const argv = JSON.stringify([run.cmd, run.args]);
    for (const form of [SECRET.toString('base64'), SECRET.toString('hex'), SECRET.toString('latin1')]) assert.ok(!argv.includes(form), form);
    const script = Buffer.from(dpapi.SCRIPT_B64, 'base64').toString('utf16le');
    assert.equal(script, dpapi.DPAPI_SCRIPT);
    assert.match(script, /\[Console\]::In\.ReadLine\(\)/);
    assert.match(script, /DataProtectionScope\]::CurrentUser/);
  });

  it('reads its failures: cant_unlock, blocked, failed, timeout (and kills it)', async () => {
    const codeOf = async (op, answer, o = {}) => {
      const f = fakeSpawn(answer);
      try {
        await dpapi.runDpapi(op, SECRET, { spawnImpl: f.impl, ...o });
        return { code: 'resolved', f };
      } catch (err) {
        assert.ok(err instanceof ProtectorError, String(err));
        return { code: err.code, detail: err.detail, f };
      }
    };
    let r = await codeOf('unprotect', (c) => close(c, 3, { err: '#< CLIXML\r\ncant_unlock: Key not valid for use in specified state.\r\n' }));
    assert.equal(r.code, 'cant_unlock');
    assert.equal(r.detail, 'cant_unlock: Key not valid for use in specified state.');
    r = await codeOf('unprotect', (c) => close(c, 4, { err: 'blocked: PowerShell language mode is ConstrainedLanguage\r\n' }));
    assert.equal(r.code, 'blocked');
    r = await codeOf('protect', (c) => close(c, 1, { err: 'Cannot invoke method. Method invocation is supported only on core types in this language mode.\r\n' }));
    assert.equal(r.code, 'blocked');
    r = await codeOf('protect', (c) => close(c, 1, { err: 'This program is blocked by group policy.\r\n' }));
    assert.equal(r.code, 'blocked');
    r = await codeOf('protect', (c) => c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    assert.deepEqual([r.code, r.detail], ['blocked', 'ENOENT']);
    r = await codeOf('protect', (c) => close(c, 1, { err: 'Something else broke: sk-ant-abcdefghijklmnop\r\n' }));
    assert.equal(r.code, 'failed');
    assert.doesNotMatch(r.detail, /sk-ant-abcdefgh/, 'redacted');
    r = await codeOf('protect', (c) => close(c, 3, { err: 'cant_unlock: x' }));
    assert.equal(r.code, 'failed', 'only an unprotect can fail to unlock');
    r = await codeOf('protect', (c) => close(c, 0, { out: 'not base64!' }));
    assert.equal(r.code, 'failed');
    r = await codeOf('protect', () => {}, { timeoutMs: 30 });
    assert.equal(r.code, 'timeout');
    assert.equal(r.f.runs[0].child.killed, true);
  });

  it('caps what it reads', async () => {
    const big = 'A'.repeat(200 * 1024);
    const f = fakeSpawn((c) => close(c, 0, { out: big }));
    const out = await dpapi.runDpapi('protect', SECRET, { spawnImpl: f.impl });
    assert.equal(out.length, (64 * 1024 * 3) / 4);
  });

  it('a master kept another way does not reach the helper', async () => {
    const f = fakeSpawn((c) => close(c, 0, { out: 'AAAA' }));
    const p = dpapi.dpapiProtector({ spawnImpl: f.impl });
    await assert.rejects(p.unprotect({ version: 1, protector: 'file', key: 'AAAA', created_at: '' }), (e) => e.code === 'cant_unlock');
    assert.equal(f.runs.length, 0);
  });
});

const onWindows = process.platform === 'win32';

describe('real DPAPI on this Windows account', { skip: onWindows ? false : 'DPAPI exists only on Windows (CI runs the file protector)' }, () => {
  /** The real spawn, recording every command line. */
  function recording() {
    const runs = [];
    const impl = (cmd, args, opts) => {
      runs.push({ cmd, args: [...args], opts });
      return spawn(cmd, args, opts);
    };
    return { impl, runs };
  }

  it('round trip; the bytes never in the command line', async () => {
    const r = recording();
    const p = dpapi.dpapiProtector({ spawnImpl: r.impl });
    const t0 = Date.now();
    const doc = await p.protect(SECRET);
    assert.equal(doc.protector, 'dpapi');
    assert.ok(Buffer.from(doc.blob, 'base64').length > 100);
    assert.ok(!doc.blob.includes(SECRET.toString('base64')));
    assert.deepEqual(await p.unprotect(doc), SECRET);
    assert.equal(r.runs.length, 2);
    for (const run of r.runs) {
      const argv = JSON.stringify(run);
      for (const form of [SECRET.toString('base64'), SECRET.toString('hex'), SECRET.toString('latin1'), doc.blob]) assert.ok(!argv.includes(form), 'no secret in argv');
      assert.equal(run.opts.windowsHide, true);
    }
    // About 0.4 s a run here; the ceiling is for a slow, busy PC.
    assert.ok(Date.now() - t0 < 20_000);
  });

  it("another account's (or a damaged) blob can't be unlocked", async () => {
    await assert.rejects(
      dpapi.dpapiProtector().unprotect({ version: 1, protector: 'dpapi', blob: Buffer.alloc(200, 1).toString('base64'), created_at: '' }),
      (e) => e instanceof ProtectorError && e.code === 'cant_unlock',
    );
  });

  it('the store: one protect on the first save, then one unwrap however many first uses wait', async () => {
    const dir = join(ROOT, 'real');
    const r = recording();
    const picked = { protector: dpapi.dpapiProtector({ spawnImpl: r.impl }), test: null };
    const key = 'sk-ant-dpapi-real-round-trip-0001';
    const a = store.createSecretStore({ dir, picked });
    await a.load();
    assert.equal(r.runs.length, 0, 'none to load or for status');
    a.status();
    await a.setKey('anthropic', key);
    await a.setKey('openai', 'sk-dpapi-real-round-trip-0002');
    assert.equal(r.runs.length, 1, 'one protect');
    assert.equal(a.storage().kind, 'dpapi');
    assert.equal(a.storage().note, store.STORAGE_NOTES.dpapi);
    resetAssistantState();
    const b = store.createSecretStore({ dir, picked });
    const got = await Promise.all([
      b.withKey('anthropic', async (k) => k),
      b.withKey('openai', async (k) => k),
      b.withKey('anthropic', async (k) => k.length),
    ]);
    assert.deepEqual(got, [key, 'sk-dpapi-real-round-trip-0002', key.length]);
    assert.equal(r.runs.length, 2, 'one unwrap for three first uses');
    await b.withKey('anthropic', async () => null);
    assert.equal(r.runs.length, 2);
  });
});
