#!/usr/bin/env node
// The bridge an MCP client (another app on this PC, or a coding agent Magnusim starts) runs
// to reach Magnusim's tools:
//
//   node scripts/assistant-mcp.mjs [--info <path of mcp.json>] [--binding <id>]
//
// It reads Magnusim's connection file (mcp.json: the port and this launch's token), connects
// to 127.0.0.1:<port>, and proves both ways that each side holds the token without sending
// it: the server greets with a nonce, the bridge answers with HMAC-SHA256(token, "c"+nonce)
// and a nonce of its own, and checks the server's HMAC-SHA256(token, "s"+its nonce) before
// it passes anything on. Then it pipes stdin to the socket and the socket to stdout (MCP's
// stdio framing, newline JSON-RPC) until either side ends: stdin's end closes the socket
// and exits 0; the socket's end exits 0. It writes nothing else to stdout, at most three
// lines to stderr, and never the token.
//
// Without --info it finds mcp.json as Magnusim's server does (scripts/server/assistant/
// home.ts, duplicated here because the bridge runs on Node 22.12 without type stripping;
// a test keeps the two equal): MAGNUSIM_ASSISTANT_HOME, else beside MAGNUSIM_LOCAL_JSON,
// else the user's application-data folder. An app that starts the bridge has neither
// variable, so Settings' snippet always passes --info.
//
// Plain ESM with Node's own modules only.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOT_RUNNING_TEXT =
  "Magnusim isn't running, or Settings → Assistant → Other apps (MCP) is off. Start it or turn that on, then reconnect.";
export const NOT_MAGNUSIM_TEXT = 'Something other than Magnusim answered on its port.';
const USAGE = 'Usage: assistant-mcp.mjs [--info <path of mcp.json>] [--binding <id>]';
/** The greeting line's bytes, and how long each greeting may take. */
const HELLO_MAX = 4 * 1024;
const HELLO_MS = 10_000;
/** After stdin ends, how long the server gets to close its side. */
export const END_MS = 10_000;
const BINDING_RE = /^b-[0-9a-f]{24}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;

/** MAGNUSIM_<suffix>, else the legacy CFDDESK_<suffix> (as home.ts envOf). */
function envOf(env, suffix) {
  for (const prefix of ['MAGNUSIM_', 'CFDDESK_']) {
    const v = env[prefix + suffix];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
  }
  return undefined;
}

/** The Assistant's home folder, by home.ts's rules (assistantHome). */
export function bridgeHome(o = {}) {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const override = envOf(env, 'ASSISTANT_HOME');
  if (override) return resolve(override);
  const local = envOf(env, 'LOCAL_JSON');
  if (local) {
    const p = resolve(local);
    return join(dirname(p), basename(p).replace(/\.json$/i, '') + '.assistant');
  }
  const home = o.home ?? homedir();
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Magnusim');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Magnusim');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'magnusim');
}

/** Where mcp.json is: --info when given, else under the home. */
export function bridgeInfoPath(info, o = {}) {
  return info ? resolve(info) : join(bridgeHome(o), 'assistant', 'mcp.json');
}

/** {info, binding} from the arguments, or {error}. */
export function parseArgs(argv) {
  const out = { info: null, binding: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--info' || a === '--binding') && i + 1 < argv.length) {
      out[a.slice(2)] = argv[(i += 1)];
    } else return { error: USAGE };
  }
  if (out.binding !== null && !BINDING_RE.test(out.binding)) return { error: USAGE };
  return out;
}

/** The connection file, or null when there is none or it isn't one. */
function readInfo(path) {
  let doc;
  try {
    const raw = readFileSync(path, 'utf8');
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const { port, token, pid } = doc;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token) return null;
  return { port, token, pid };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const hmac = (token, text) => createHmac('sha256', token).update(text).digest('hex');

/** Plain text of at most one short line (what a server says is shown as data). */
function plain(text) {
  return String(text ?? '')
    .replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * One connection attempt. Resolves {ok:true, sock, rest} (rest: bytes after the server's
 * answer), {ok:false, code, error} for a refusal, or {fail:'not_running'|'not_magnusim'}.
 */
function attempt(file, binding) {
  return new Promise((done) => {
    const sock = connect({ port: file.port, host: '127.0.0.1' });
    sock.setNoDelay(true);
    let settled = false;
    let stage = 'hello';
    let n2 = '';
    let buf = Buffer.alloc(0);
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.off('data', onData);
      if (!r.ok) sock.destroy();
      done(r);
    };
    const timer = setTimeout(() => finish({ fail: 'not_magnusim' }), HELLO_MS);
    sock.on('error', (err) => finish({ fail: err?.code === 'ECONNREFUSED' ? 'not_running' : 'not_magnusim' }));
    sock.on('close', () => finish({ fail: stage === 'hello' && !buf.length ? 'not_running' : 'not_magnusim' }));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) {
          if (buf.length > HELLO_MAX) finish({ fail: 'not_magnusim' });
          return;
        }
        if (nl > HELLO_MAX) return finish({ fail: 'not_magnusim' });
        let msg;
        try {
          msg = JSON.parse(buf.subarray(0, nl).toString('utf8'));
        } catch {
          return finish({ fail: 'not_magnusim' });
        }
        buf = buf.subarray(nl + 1);
        if (stage === 'hello') {
          if (!msg || msg.magnusim_mcp !== 1 || typeof msg.nonce !== 'string' || !NONCE_RE.test(msg.nonce)) return finish({ fail: 'not_magnusim' });
          n2 = randomBytes(16).toString('hex');
          const client = randomBytes(8).toString('hex');
          sock.write(`${JSON.stringify({ magnusim_mcp: 1, nonce: n2, proof: hmac(file.token, `c${msg.nonce}`), binding, client })}\n`);
          stage = 'answer';
          continue;
        }
        if (msg && msg.ok === true) {
          const proof = typeof msg.proof === 'string' && PROOF_RE.test(msg.proof) ? Buffer.from(msg.proof, 'hex') : null;
          const want = Buffer.from(hmac(file.token, `s${n2}`), 'hex');
          if (!proof || !timingSafeEqual(proof, want)) return finish({ fail: 'not_magnusim' });
          sock.pause();
          return finish({ ok: true, sock, rest: buf });
        }
        if (msg && msg.ok === false) return finish({ ok: false, code: plain(msg.code), error: plain(msg.error) });
        return finish({ fail: 'not_magnusim' });
      }
    };
    sock.on('data', onData);
  });
}

/** Exits with `code` once stdout has taken what it was given. */
function exit(code) {
  process.stdout.write('', () => process.exit(code));
}

function fail(text) {
  process.stderr.write(`${text}\n`);
  exit(1);
}

/** Pipes stdin to the socket and the socket to stdout until either side ends. */
function pipe(sock, rest) {
  sock.on('error', () => {});
  sock.on('close', () => exit(0));
  process.stdout.on('error', () => {
    sock.destroy();
    process.exit(0);
  });
  if (rest.length) process.stdout.write(rest);
  sock.on('data', (chunk) => process.stdout.write(chunk));
  sock.resume();
  process.stdin.on('data', (chunk) => sock.write(chunk));
  process.stdin.on('end', () => {
    sock.end();
    setTimeout(() => {
      sock.destroy();
      process.exit(0);
    }, END_MS).unref();
  });
  process.stdin.on('error', () => sock.end());
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n`);
    exit(2);
    return;
  }
  const path = bridgeInfoPath(args.info);
  for (let tries = 0; ; tries += 1) {
    const file = readInfo(path);
    if (!file || !pidAlive(file.pid)) return fail(NOT_RUNNING_TEXT);
    const r = await attempt(file, args.binding);
    if (r.ok) return pipe(r.sock, r.rest);
    if (r.fail === 'not_running') return fail(NOT_RUNNING_TEXT);
    if (r.fail) return fail(NOT_MAGNUSIM_TEXT);
    // Magnusim restarted since the file was read: read it once more.
    if (r.code === 'token' && tries === 0) continue;
    return fail(`Magnusim refused the connection: ${r.error || r.code || 'no reason given'}`);
  }
}

/** Run as a program (not imported by a test): compare real paths, as a junction or link may lead here. */
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) void main();
