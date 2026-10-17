// Shared helpers for the MCP tests (not a test file itself): three ways to reach the
// listener (phase 3 spec 7.3).
//   - handshake(port, token, o): a raw socket through the greeting (both directions
//     recorded), for handshake and framing cases;
//   - socketClient(port, token, o): the MCP SDK's own Client over such a socket;
//   - bridgeClient(o): the SDK's Client with its StdioClientTransport starting the real
//     scripts/assistant-mcp.mjs: a standard client through our bridge to our server.
// Each client runs in either era: 'legacy' (the client's default, 2025-11-25) or 'modern'
// (pinned to 2026-07-28).
//
// A test sets its temp roots first and then imports this file dynamically.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Client, ReadBuffer, serializeMessage } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

export const MODERN = '2026-07-28';
export const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assistant-mcp.mjs');

export const hmac = (token, text) => createHmac('sha256', token).update(text).digest('hex');

/** The connection file as written. */
export function readInfo(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Client options for an era. */
export const eraOptions = (era) => (era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN } } } : {});

/** Lines of `buf` (complete ones), parsed. */
function lines(buf) {
  return buf
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * A raw socket through the greeting. o: {binding, client, proof (a function of n1 giving the
 * proof to send, or a string), greeting (a whole line to send instead), wait (resolve on the
 * server's greeting only)}. Resolves {sock, hello, answer, rest, sent, received, closed}:
 * `answer` is the server's second line (null when it closed first); `sent`/`received` every
 * byte each way so far (they keep recording).
 */
export function handshake(port, token, o = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const rec = { sock, sent: [], received: [], closed: false, hello: null, answer: null, rest: Buffer.alloc(0) };
    const write = sock.write.bind(sock);
    sock.write = (chunk, ...rest) => {
      rec.sent.push(Buffer.from(chunk));
      return write(chunk, ...rest);
    };
    let buf = Buffer.alloc(0);
    let stage = 'hello';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(rec);
    };
    sock.on('error', (err) => (settled ? undefined : err.code === 'ECONNRESET' ? done() : reject(err)));
    sock.on('close', () => {
      rec.closed = true;
      done();
    });
    sock.on('data', (chunk) => {
      rec.received.push(Buffer.from(chunk));
      if (stage === 'piped') return;
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const msg = JSON.parse(buf.subarray(0, nl).toString('utf8'));
        buf = buf.subarray(nl + 1);
        if (stage === 'hello') {
          rec.hello = msg;
          stage = 'answer';
          if (o.wait) return done();
          const n2 = randomBytes(16).toString('hex');
          rec.n2 = n2;
          const proof = typeof o.proof === 'function' ? o.proof(msg.nonce) : (o.proof ?? hmac(token, `c${msg.nonce}`));
          const greeting = o.greeting ?? `${JSON.stringify({ magnusim_mcp: 1, nonce: n2, proof, binding: o.binding ?? null, client: o.client ?? randomBytes(8).toString('hex') })}\n`;
          sock.write(greeting);
          continue;
        }
        rec.answer = msg;
        rec.rest = buf;
        stage = 'piped';
        return done();
      }
    });
  });
}

/** A client transport over a socket already through the greeting (`rest`: bytes after it). */
export class SocketClientTransport {
  constructor(sock, rest = Buffer.alloc(0)) {
    this.sock = sock;
    this.rest = rest;
    this.buf = new ReadBuffer();
  }
  async start() {
    const feed = (chunk) => {
      this.buf.append(chunk);
      for (let m = this.buf.readMessage(); m !== null; m = this.buf.readMessage()) this.onmessage?.(m);
    };
    // handshake()'s own listener keeps recording what arrives.
    this.sock.on('data', feed);
    this.sock.on('error', (err) => this.onerror?.(err));
    this.sock.on('close', () => this.onclose?.());
    if (this.rest.length) feed(this.rest);
  }
  async send(message) {
    if (this.sock.destroyed) throw new Error('closed');
    this.sock.write(serializeMessage(message));
  }
  async close() {
    this.sock.destroy();
  }
}

/** The SDK's Client over a raw socket: {client, sock, hs, close()}. Throws when the handshake is refused. */
export async function socketClient(port, token, { era = 'legacy', binding = null, name = 'socket-client', listChanged } = {}) {
  const hs = await handshake(port, token, { binding });
  if (!hs.answer?.ok) {
    hs.sock.destroy();
    const err = new Error(`refused: ${hs.answer?.code ?? 'closed'}`);
    err.code = hs.answer?.code ?? 'closed';
    throw err;
  }
  const client = new Client({ name, version: '1.0.0' }, { ...eraOptions(era), ...(listChanged ? { listChanged } : {}) });
  await client.connect(new SocketClientTransport(hs.sock, hs.rest));
  return { client, sock: hs.sock, hs, close: () => client.close().catch(() => {}) };
}

/**
 * The SDK's Client through the real bridge (a child process): {client, transport, stderr(),
 * close()}. o: {info, binding, era, name, env}.
 */
export async function bridgeClient({ info, binding = null, era = 'legacy', name = 'bridge-client', env = {} } = {}) {
  const args = [BRIDGE, '--info', info, ...(binding ? ['--binding', binding] : [])];
  const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe', env });
  let err = '';
  transport.stderr?.on('data', (d) => (err += d));
  const client = new Client({ name, version: '2.0.0' }, eraOptions(era));
  await client.connect(transport);
  return {
    client,
    transport,
    stderr: () => err,
    close: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

/** Parses a tool result's text part. */
export function resultJson(result) {
  return JSON.parse(result.content[0].text);
}

export { lines };
