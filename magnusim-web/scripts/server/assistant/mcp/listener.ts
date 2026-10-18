/**
 * The loopback listener other apps and coding agents reach Magnusim's tools on (phase 3
 * spec 3.1): `node scripts/assistant-mcp.mjs` (the bridge an MCP client starts) connects
 * here, proves it holds this launch's token, and from then on the connection carries MCP's
 * stdio framing (newline JSON-RPC) both ways, served by server.ts.
 *
 * - Process-wide, on globalThis: a Vite in-process restart keeps the socket, port and
 *   token. Each server lifetime installs its own handler (setMcpHandler); its disposer
 *   closes the connections that handler served (AssistantHandle.shutdown() calls it,
 *   superseded lifetime or not). It starts on the first of: server start when the
 *   Assistant's settings file exists, Other apps turned on, or (later) a coding agent's
 *   need; then it runs until the process exits.
 * - 127.0.0.1 only; a socket from any other address is destroyed. The port is saved in
 *   settings the first time and bound again later; when it is taken, a new one is bound
 *   and saved.
 * - The token: 32 random bytes, base64url, one per process launch. It is written with the
 *   port and this process's id to `<assistant data>/mcp.json` (0600, atomically) once the
 *   listener is bound, and removed at a clean exit; a leftover file whose process is gone
 *   is removed before the listener binds. It never crosses the socket, never appears in a
 *   log line, a route answer or an agent's arguments: each side proves it holds it.
 * - The handshake (the first line each way, at most 4 KB, within 5 s):
 *     server: {"magnusim_mcp":1,"nonce":n1}
 *     bridge: {"magnusim_mcp":1,"nonce":n2,"proof":HMAC-SHA256(token,"c"+n1),"binding":…|null,"client":<16 hex>}
 *     server: {"ok":true,"proof":HMAC-SHA256(token,"s"+n2)} | {"ok":false,"code","error"}, then close
 *   Anything that isn't such a greeting (an HTTP request, say) is closed with no answer. The
 *   bridge checks the server's proof before it pipes anything, so a program squatting the
 *   port learns nothing and can't pose as Magnusim.
 * - Limits: 16 sockets in their handshake (more are destroyed at once); 8 connections, of
 *   which 4 external (busy past that), so 4 stay for coding agents' bindings.
 * - Other apps turned off closes every external app's connection at once
 *   (closeExternalMcpConnections, from the settings save); coding agents' stay.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readJsonFile, writeFileAtomic } from '../files.ts';
import { assistantDataDir } from '../home.ts';
import { alog } from '../log.ts';
import { loadMcpSdk, MCP_DEPS_MISSING_TEXT } from '../providers/load-sdk.ts';
import { isPort, loadSettings, updateSettings } from '../settings.ts';
import { MCP_SERVER_KEY } from './names.ts';
import { BINDING_RE, newSessionId } from './sessions.ts';

export const MCP_LIMITS = Object.freeze({
  /** Sockets still in their handshake. */
  handshaking: 16,
  /** Authenticated connections. */
  connections: 8,
  /** Of those, external apps' (the rest stay for coding agents). */
  external: 4,
  /** The greeting line's bytes. */
  helloBytes: 4 * 1024,
  /** The greeting's deadline. */
  handshakeMs: 5_000,
});

/** The bridge an MCP client starts. */
export const BRIDGE_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assistant-mcp.mjs');

const NONCE_RE = /^[0-9a-f]{32}$/;
const CLIENT_RE = /^[0-9a-f]{16}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);
/** A refused handshake's code is logged at most this often. */
const REFUSED_LOG_MS = 60_000;

export const CLIENTS_OFF_TEXT = "Other apps can't use Magnusim's tools: turn this on in Settings → Assistant → Other apps (MCP).";
const TOKEN_TEXT = "The connection's proof didn't match: Magnusim restarted since its connection file was read, or the file isn't this Magnusim's.";
const BUSY_TEXT = "Too many apps are connected to Magnusim's tools. Close one, then reconnect.";
const NOT_READY_TEXT = 'Magnusim is starting or stopping. Try again in a moment.';
const BAD_HELLO_TEXT = "That wasn't a Magnusim bridge's greeting.";

export interface McpHello {
  /** This connection's session id (m-…). */
  session: string;
  kind: 'external' | 'agent';
  binding: string | null;
  /** The bridge's random id. */
  client: string;
}

/** One authenticated connection, as server.ts serves it. */
export interface McpConnection {
  readonly id: string;
  readonly kind: 'external' | 'agent';
  /** The bytes from the bridge after its greeting. */
  readonly input: Readable;
  /** The socket. */
  readonly output: Writable;
  /** ms since 1970. */
  readonly opened: number;
  readonly closed: boolean;
  /** What GET /api/assistant/mcp shows of it (server.ts keeps it current). */
  readonly label: { name: string; calls: number };
  /** Ends it; `server: true` when Magnusim ends it (its calls end "The server stopped…"). */
  close(o?: { server?: boolean }): void;
  /** Runs once when it ends, either side. */
  onClose(fn: (o: { server: boolean }) => void): void;
}

export type McpAdmission =
  | { ok: true; serve(conn: McpConnection): void; abandon(): void }
  | { ok: false; code: string; error: string };

/** A server lifetime's way of taking connections (server.ts createMcpService). */
export interface McpHandler {
  admit(hello: McpHello): Promise<McpAdmission>;
}

export interface McpListenerStatus {
  running: boolean;
  /** Why it isn't running (deps_missing, bind_failed, file_failed), else null. */
  reason: string | null;
  port: number | null;
  connected: number;
}

interface Conn extends McpConnection {
  handler: McpHandler;
  socket: Socket;
}

interface ListenerState {
  server: Server | null;
  port: number | null;
  token: string | null;
  infoPath: string | null;
  running: boolean;
  reason: string | null;
  starting: Promise<McpListenerStatus> | null;
  handler: McpHandler | null;
  disposed: WeakSet<McpHandler>;
  handshaking: Set<Socket>;
  conns: Set<Conn>;
  /** Slots taken: live connections plus handshakes being admitted. */
  slots: { all: number; external: number };
  refusedAt: Map<string, number>;
  exitHook: boolean;
  handshakeMs: number;
  /** Bumped each time Other apps is turned off: an external handshake admitted before it is refused. */
  externalCut: number;
}

const KEY = Symbol.for('magnusim.assistant.mcp');

function state(): ListenerState {
  const g = globalThis as unknown as Record<symbol, ListenerState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = {
      server: null,
      port: null,
      token: null,
      infoPath: null,
      running: false,
      reason: null,
      starting: null,
      handler: null,
      disposed: new WeakSet(),
      handshaking: new Set(),
      conns: new Set(),
      slots: { all: 0, external: 0 },
      refusedAt: new Map(),
      exitHook: false,
      handshakeMs: MCP_LIMITS.handshakeMs,
      externalCut: 0,
    };
    g[KEY] = s;
  }
  // A state an earlier copy of this module made (a Vite restart) may lack it.
  if (typeof s.externalCut !== 'number') s.externalCut = 0;
  return s;
}

const hmac = (token: string, text: string) => createHmac('sha256', token).update(text).digest('hex');
const line = (v: unknown) => `${JSON.stringify(v)}\n`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Where this Magnusim writes its connection file (the bridge's --info). */
export function mcpInfoPath(): string {
  return join(assistantDataDir(), 'mcp.json');
}

/** The command an MCP client starts, and the config to paste (no token: the bridge reads it). */
export function mcpClientConfig(): { command: string; args: string[]; snippet: string } {
  const command = process.execPath;
  const args = [BRIDGE_SCRIPT, '--info', mcpInfoPath()];
  const snippet = JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { command, args } } }, null, 2);
  return { command, args, snippet };
}

export function mcpListenerStatus(): McpListenerStatus {
  const st = state();
  return { running: st.running, reason: st.running ? null : st.reason, port: st.running ? st.port : null, connected: st.conns.size };
}

/**
 * Why the tool connection can't run, as every refusal on the server says it (spec 5.7;
 * Settings words it the same: AssistantStepMcp.tsx mcpReasonText). `port` is the one it uses
 * or would bind (the saved one), null when there is none yet.
 */
export function mcpUnavailableText(reason: string | null, port: number | null): string {
  if (reason === 'deps_missing') return MCP_DEPS_MISSING_TEXT;
  const where = typeof port === 'number' ? `port ${port}` : 'its port';
  return `Magnusim couldn't open the connection its tools use (${reason ?? 'not running'}). Restart Magnusim; if it keeps happening, another program may hold ${where}.`;
}

/**
 * Whether `sent` is this launch's token (the CLI's x-magnusim-launch header: the proof that an
 * agent turn's starter is this account, phase 3 spec 5.2). Constant time; false while the
 * listener has no token. The token is never logged or answered.
 */
export function mcpLaunchTokenMatches(sent: unknown): boolean {
  const token = state().token;
  if (!token || !state().running || typeof sent !== 'string' || !sent) return false;
  const a = Buffer.from(sent, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * This launch's answer to the terminal client's check (POST /api/assistant/launch/check), sent
 * before the client sends the token: HMAC-SHA256(token, "l<port>:<nonce>"), where `port` is the
 * app's own port the request reached (its socket's local port, which no client sets). A program
 * on another port that passes the request on to this one gets an answer for this port, which the
 * client refuses. The "l" label is neither of the handshake's ("c", "s"), so an answer never
 * passes for either side of a socket. Null while the listener has no token, or for a bad nonce.
 */
export function mcpLaunchCheck(port: unknown, nonce: unknown): string | null {
  const token = state().token;
  if (!token || !state().running) return null;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return hmac(token, `l${port}:${nonce}`);
}

/** The live connections, oldest first (GET /api/assistant/mcp). */
export function mcpConnections(): Array<{ id: string; kind: 'external' | 'agent'; name: string; since: string; calls: number }> {
  return [...state().conns]
    .sort((a, b) => a.opened - b.opened)
    .map((c) => ({ id: c.id, kind: c.kind, name: c.label.name, since: new Date(c.opened).toISOString(), calls: c.label.calls }));
}

/**
 * Installs a server lifetime's handler: new connections go to it. The disposer closes the
 * connections it served (their calls end "The server stopped…") and, when it is still the
 * current one, leaves new connections refused until the next server installs its own.
 */
export function setMcpHandler(h: McpHandler): () => void {
  const st = state();
  st.handler = h;
  return () => {
    st.disposed.add(h);
    if (st.handler === h) st.handler = null;
    for (const c of [...st.conns]) if (c.handler === h) c.close({ server: true });
  };
}

/**
 * Other apps was turned off: every external app's connection closes now (its calls end "The
 * server stopped…"), and a handshake admitted before this is refused `clients_off`. Coding
 * agents' connections stay. Returns how many closed.
 */
export function closeExternalMcpConnections(): number {
  const st = state();
  st.externalCut += 1;
  let n = 0;
  for (const c of [...st.conns]) {
    if (c.kind !== 'external') continue;
    c.close({ server: true });
    n += 1;
  }
  return n;
}

function logRefused(code: string): void {
  const st = state();
  const now = Date.now();
  const last = st.refusedAt.get(code);
  if (last !== undefined && now - last < REFUSED_LOG_MS) return;
  st.refusedAt.set(code, now);
  alog('warn', 'mcp handshake refused', { code });
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'EPERM';
  }
}

/** A connection file left by a Magnusim that is gone (or an earlier listener of this process). */
async function removeStale(path: string): Promise<void> {
  let r;
  try {
    r = await readJsonFile(path);
  } catch {
    return;
  }
  if (r.state === 'missing') return;
  const pid = r.state === 'ok' && isRecord(r.value) ? r.value.pid : null;
  if (r.state === 'bad' || pid === process.pid || !pidAlive(pid)) {
    await unlink(path).catch(() => {});
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolveListen, reject) => {
    const server = createServer({ noDelay: true }, onSocket);
    const onError = (err: Error) => {
      server.close();
      reject(err);
    };
    server.once('error', onError);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.off('error', onError);
      server.on('error', (err) => alog('warn', 'mcp listener error', { error: String(err?.message ?? err).slice(0, 200) }));
      // It never keeps the process alive by itself.
      server.unref();
      resolveListen(server);
    });
  });
}

/**
 * Starts the listener once (later calls wait for that start, or return at once): the MCP
 * package must load (else `deps_missing`), the saved port is bound or a new one, and the
 * connection file is written. A failed start is tried again by the next call.
 */
export function startMcpListener(): Promise<McpListenerStatus> {
  const st = state();
  if (st.running) return Promise.resolve(mcpListenerStatus());
  if (!st.starting) {
    st.starting = doStart().finally(() => {
      st.starting = null;
    });
  }
  return st.starting;
}

async function doStart(): Promise<McpListenerStatus> {
  const st = state();
  // First: a file nobody serves any more never outlives this start, whatever happens next.
  const infoPath = mcpInfoPath();
  await removeStale(infoPath);
  try {
    await loadMcpSdk();
  } catch {
    st.reason = 'deps_missing';
    alog('warn', 'mcp listener not started', { reason: 'deps_missing' });
    return mcpListenerStatus();
  }
  st.token ??= randomBytes(32).toString('base64url');
  const saved = (await loadSettings()).mcp.port;
  let server: Server;
  try {
    server = await listen(saved ?? 0);
  } catch (err) {
    try {
      if (saved === null) throw err;
      server = await listen(0);
    } catch (err2) {
      st.reason = 'bind_failed';
      alog('warn', 'mcp listener not started', { reason: 'bind_failed', error: String((err2 as Error)?.message ?? err2).slice(0, 200) });
      return mcpListenerStatus();
    }
  }
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  if (port !== saved && isPort(port)) {
    await updateSettings((s) => ({ ...s, mcp: { ...s.mcp, port } })).catch((err: unknown) =>
      alog('warn', 'mcp port not saved', { error: String((err as Error)?.message ?? err).slice(0, 200) }),
    );
  }
  const doc = { version: 1, port, token: st.token, pid: process.pid, started_at: new Date().toISOString() };
  try {
    await writeFileAtomic(infoPath, line(doc), { mode: 0o600 });
  } catch (err) {
    server.close();
    st.reason = 'file_failed';
    alog('warn', 'mcp listener not started', { reason: 'file_failed', error: String((err as Error)?.message ?? err).slice(0, 200) });
    return mcpListenerStatus();
  }
  st.server = server;
  st.port = port;
  st.infoPath = infoPath;
  st.running = true;
  st.reason = null;
  if (!st.exitHook) {
    st.exitHook = true;
    // A clean exit takes the file with it (only this process's own: another copy may have written it since).
    process.once('exit', () => {
      const s = state();
      if (!s.infoPath || !s.token) return;
      try {
        const now = JSON.parse(readFileSync(s.infoPath, 'utf8')) as { pid?: unknown; token?: unknown };
        if (now.pid === process.pid && now.token === s.token) unlinkSync(s.infoPath);
      } catch {
        /* gone already */
      }
    });
  }
  alog('info', 'mcp listener started', { port });
  return mcpListenerStatus();
}

// ---------------------------------------------------------------- one socket

function onSocket(sock: Socket): void {
  const st = state();
  sock.on('error', () => {});
  if (!LOOPBACK.has(String(sock.remoteAddress)) || !st.running || st.handshaking.size >= MCP_LIMITS.handshaking) {
    sock.destroy();
    return;
  }
  st.handshaking.add(sock);
  sock.once('close', () => st.handshaking.delete(sock));
  const n1 = randomBytes(16).toString('hex');
  sock.write(line({ magnusim_mcp: 1, nonce: n1 }));
  const timer = setTimeout(() => sock.destroy(), st.handshakeMs);
  timer.unref();
  let buf: Buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const nl = buf.indexOf(10);
    if (nl < 0) {
      if (buf.length > MCP_LIMITS.helloBytes) {
        clearTimeout(timer);
        sock.destroy();
      }
      return;
    }
    sock.off('data', onData);
    sock.pause();
    clearTimeout(timer);
    if (nl > MCP_LIMITS.helloBytes) {
      sock.destroy();
      return;
    }
    void greeting(sock, n1, buf.subarray(0, nl).toString('utf8'), buf.subarray(nl + 1)).catch(() => sock.destroy());
  };
  sock.on('data', onData);
}

function refuse(sock: Socket, code: string, error: string): void {
  logRefused(code);
  sock.end(line({ ok: false, code, error }), () => sock.destroy());
}

async function greeting(sock: Socket, n1: string, text: string, rest: Buffer): Promise<void> {
  const st = state();
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    sock.destroy();
    return;
  }
  // Not a bridge (an HTTP request, a port scan): no answer at all.
  if (!isRecord(msg) || msg.magnusim_mcp !== 1) {
    sock.destroy();
    return;
  }
  const token = st.token;
  const proof = msg.proof;
  if (!token || typeof proof !== 'string' || !PROOF_RE.test(proof) || !timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(hmac(token, `c${n1}`), 'hex'))) {
    refuse(sock, 'token', TOKEN_TEXT);
    return;
  }
  const n2 = msg.nonce;
  const client = msg.client;
  const binding = msg.binding ?? null;
  if (typeof n2 !== 'string' || !NONCE_RE.test(n2) || typeof client !== 'string' || !CLIENT_RE.test(client) || (binding !== null && (typeof binding !== 'string' || !BINDING_RE.test(binding)))) {
    refuse(sock, 'bad_hello', BAD_HELLO_TEXT);
    return;
  }
  // Authenticated: no longer a handshake slot, now a connection slot.
  st.handshaking.delete(sock);
  const kind: 'external' | 'agent' = binding === null ? 'external' : 'agent';
  if (st.slots.all >= MCP_LIMITS.connections || (kind === 'external' && st.slots.external >= MCP_LIMITS.external)) {
    refuse(sock, 'busy', BUSY_TEXT);
    return;
  }
  st.slots.all += 1;
  if (kind === 'external') st.slots.external += 1;
  let slotHeld = true;
  const freeSlot = () => {
    if (!slotHeld) return;
    slotHeld = false;
    st.slots.all -= 1;
    if (kind === 'external') st.slots.external -= 1;
  };
  const handler = st.handler;
  if (!handler) {
    freeSlot();
    refuse(sock, 'not_ready', NOT_READY_TEXT);
    return;
  }
  const session = newSessionId(Date.now());
  const cut = st.externalCut;
  let admission: McpAdmission;
  try {
    admission = await handler.admit({ session, kind, binding: binding as string | null, client });
  } catch {
    admission = { ok: false, code: 'not_ready', error: NOT_READY_TEXT };
  }
  if (!admission.ok) {
    freeSlot();
    refuse(sock, admission.code, admission.error);
    return;
  }
  if (sock.destroyed || st.disposed.has(handler)) {
    admission.abandon();
    freeSlot();
    if (sock.destroyed) return;
    refuse(sock, 'not_ready', NOT_READY_TEXT);
    return;
  }
  // Other apps went off while it was admitted (on when the handler read it).
  if (kind === 'external' && st.externalCut !== cut) {
    admission.abandon();
    freeSlot();
    refuse(sock, 'clients_off', CLIENTS_OFF_TEXT);
    return;
  }
  sock.write(line({ ok: true, proof: hmac(token, `s${n2}`) }));
  const input = new PassThrough();
  if (rest.length) input.write(rest);
  const closers: Array<(o: { server: boolean }) => void> = [];
  let ended = false;
  const finish = (server: boolean) => {
    if (ended) return;
    ended = true;
    st.conns.delete(conn);
    freeSlot();
    if (!input.writableEnded) input.end();
    for (const fn of closers.splice(0)) {
      try {
        fn({ server });
      } catch {
        /* one listener's failure never stops the others */
      }
    }
  };
  const conn: Conn = {
    id: session,
    kind,
    input,
    output: sock,
    opened: Date.now(),
    label: { name: '', calls: 0 },
    handler,
    socket: sock,
    get closed() {
      return ended;
    },
    close(o) {
      finish(o?.server === true);
      sock.destroy();
    },
    onClose(fn) {
      if (ended) fn({ server: false });
      else closers.push(fn);
    },
  };
  st.conns.add(conn);
  sock.once('close', () => finish(false));
  sock.pipe(input);
  admission.serve(conn);
}

// ---------------------------------------------------------------- tests

/** Tests only: a shorter handshake deadline (null: the default). */
export function setMcpListenerTimingsForTests(o: { handshakeMs?: number | null }): void {
  state().handshakeMs = o.handshakeMs ?? MCP_LIMITS.handshakeMs;
}

/** Tests only: how many sockets are still in their handshake. */
export function mcpHandshakingForTests(): number {
  return state().handshaking.size;
}

/** Tests only: the listener's own socket server (its address), or null. */
export function mcpServerForTests(): Server | null {
  return state().server;
}

/**
 * Tests only: close the listener and every socket, remove the file, forget the token and
 * port (a new launch). The installed handler stays: it is its server lifetime's.
 */
export async function resetMcpListenerForTests(): Promise<void> {
  const st = state();
  await st.starting?.catch(() => {});
  for (const c of [...st.conns]) c.close({ server: true });
  for (const s of [...st.handshaking]) s.destroy();
  const server = st.server;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (st.infoPath) await unlink(st.infoPath).catch(() => {});
  st.server = null;
  st.port = null;
  st.token = null;
  st.infoPath = null;
  st.running = false;
  st.reason = null;
  st.slots = { all: 0, external: 0 };
  st.refusedAt.clear();
  st.handshakeMs = MCP_LIMITS.handshakeMs;
}
