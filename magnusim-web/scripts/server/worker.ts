import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PYTHON, PY_ROOT, WEB_ROOT } from '../python-env.js';

export class WorkerUnavailableError extends Error {
  readonly status = 503;
  constructor(message = 'Python worker unavailable') {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// The Python worker answers one request at a time, in the order sent, so the
// oldest unanswered request is the one it is working on and the rest wait on
// it. A request that timed out here is still unanswered there.
const TRACE = process.env.MAGNUSIM_WORKER_TRACE === '1';
const TRACE_SLOW_MS = 1000;

export interface WorkerClientOptions {
  python?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxDeaths?: number;
  backoffMs?: number[];
  /** Label for trace lines. */
  name?: string;
  /** Second worker that takes the slow calls (see isDataLaneMethod). */
  dataLane?: WorkerClient | null;
}

const DEFAULT_BACKOFF = [250, 750, 2000];

/**
 * Result-volume and CAD calls load whole meshes or STEP files and can hold a
 * worker for tens of seconds (opening a transient run's results prefetches
 * every frame). They share in-process caches (volume_cache, cad_cache) with
 * each other and nothing else, so they run in their own worker process and
 * project reads and writes (runs.upsert, project.tree, filter.validate, …)
 * never queue behind them.
 */
export function isDataLaneMethod(method: string): boolean {
  return method.startsWith('cad.') || (method.startsWith('filter.') && method !== 'filter.validate');
}

/**
 * Calls after which the registry in the calling worker changed. The data lane
 * keeps its own registry (plugin result filters), so it reloads too.
 */
const REGISTRY_CHANGES = new Set(['registry.reload', 'plugins.enable', 'plugins.disable']);

export class WorkerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private started = false;
  private stopping = false;
  private deaths = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly maxDeaths: number;
  private readonly backoffMs: number[];
  private readonly python: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private queue: Array<() => void> = [];
  private draining = false;
  private lastReplyAt = 0;
  private readonly inFlight = new Map<number, { method: string; sentAt: number }>();
  private readonly name: string;
  private readonly dataLane: WorkerClient | null;

  constructor(opts: WorkerClientOptions = {}) {
    super();
    this.name = opts.name || 'worker';
    this.dataLane = opts.dataLane || null;
    this.python = opts.python || PYTHON;
    this.cwd = opts.cwd || PY_ROOT;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxDeaths = opts.maxDeaths ?? 3;
    this.backoffMs = opts.backoffMs || DEFAULT_BACKOFF;
    this.env = {
      ...process.env,
      ...(opts.env || {}),
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      CFDDESK_WEB_ROOT: process.env.CFDDESK_WEB_ROOT || WEB_ROOT,
      MAGNUSIM_WEB_ROOT: process.env.MAGNUSIM_WEB_ROOT || WEB_ROOT,
    };
  }

  start(): void {
    this.stopping = false;
    this.deaths = 0;
    this.started = true;
    // The data lane spawns on its first call.
    if (this.dataLane) this.dataLane.stopping = false;
    if (!this.child) this.spawnChild();
  }

  stop(): void {
    this.dataLane?.stop();
    this.stopping = true;
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.killChild();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new WorkerUnavailableError('worker stopped'));
      this.pending.delete(id);
    }
  }

  get alive(): boolean {
    return !!(this.child?.pid && this.child.exitCode == null);
  }

  get unavailable(): boolean {
    return this.deaths >= this.maxDeaths && !this.alive;
  }

  async call(method: string, params: unknown = {}, timeoutMs?: number): Promise<unknown> {
    if (this.dataLane && isDataLaneMethod(method)) {
      return this.dataLane.call(method, params, timeoutMs);
    }
    if (this.stopping) {
      throw new WorkerUnavailableError('worker stopped');
    }
    if (this.unavailable) {
      this.deaths = 0;
      this.started = true;
      this.spawnChild();
    }
    if (!this.started) this.start();
    if (!this.alive) {
      this.spawnChild();
    }
    if (TRACE) this.countCall(method);
    const result = await new Promise((resolve, reject) => {
      this.queue.push(() => {
        this.send(method, params, timeoutMs).then(resolve, reject);
      });
      this.drain();
    });
    if (this.dataLane && this.dataLane.alive && REGISTRY_CHANGES.has(method)) {
      await this.dataLane.call('registry.reload', {}).catch(() => {});
    }
    return result;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    const run = (): void => {
      if (!this.queue.length) {
        this.draining = false;
        return;
      }
      if (!this.alive) {
        if (this.unavailable || this.stopping) {
          const leftover = this.queue.splice(0);
          for (const fn of leftover) {
            try {
              fn();
            } catch {
              /* send() rejects */
            }
          }
          this.draining = false;
          return;
        }
        setTimeout(run, 50);
        return;
      }
      const job = this.queue.shift();
      if (job) job();
      setImmediate(run);
    };
    run();
  }

  private send(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || child.exitCode != null) {
        reject(new WorkerUnavailableError());
        return;
      }
      const id = this.nextId++;
      const wait = timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => {
        const note = this.busyNote(id);
        this.pending.delete(id);
        const err = new Error(`worker RPC timeout: ${method} after ${wait} ms${note}`);
        if (TRACE) console.warn(`[${this.name}]`, err.message);
        reject(err);
      }, wait);
      this.pending.set(id, { resolve, reject, timer });
      this.inFlight.set(id, { method, sentAt: Date.now() });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        child.stdin.write(msg + '\n', (err) => {
          if (!err) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new WorkerUnavailableError(err.message));
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private spawnChild(): void {
    if (this.stopping || this.child) return;
    if (this.deaths >= this.maxDeaths) {
      this.emit('dead');
      return;
    }
    const child = spawn(this.python, ['-m', 'cfddesk.worker'], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });
    this.child = child;
    this.buf = '';
    child.stdin.on('error', () => this.failPending(new WorkerUnavailableError('worker input closed')));
    child.stdout.on('data', (c: Buffer) => this.onStdout(c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => {
      const line = c.toString('utf8').trim();
      if (line) this.emit('stderr', line);
    });
    child.on('error', (err) => {
      if (this.listenerCount('error')) this.emit('error', err);
      this.failPending(new WorkerUnavailableError(err.message));
    });
    child.on('close', () => {
      if (this.child && this.child !== child) return;
      this.child = null;
      this.inFlight.clear();
      this.failPending(new WorkerUnavailableError('worker exited'));
      if (this.stopping) return;
      this.deaths += 1;
      this.emit('exit', this.deaths);
      if (this.deaths >= this.maxDeaths) {
        this.emit('dead');
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.deaths = 0;
          this.spawnChild();
        }, 5000);
        return;
      }
      const delay = this.backoffMs[Math.min(this.deaths - 1, this.backoffMs.length - 1)];
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawnChild();
      }, delay);
    });
  }

  private killChild(): void {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    this.child = null;
    this.inFlight.clear();
  }

  private callCounts = new Map<string, number>();
  private countsSince = Date.now();

  private countCall(method: string): void {
    this.callCounts.set(method, (this.callCounts.get(method) || 0) + 1);
    const now = Date.now();
    if (now - this.countsSince < 30_000) return;
    const rows = [...this.callCounts].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}=${n}`);
    console.warn(`[${this.name}] calls in last ${Math.round((now - this.countsSince) / 1000)} s: ${rows.join(' ')}; ${this.inFlight.size} in flight`);
    this.callCounts.clear();
    this.countsSince = now;
  }

  /** What the worker was doing while request `id` waited, for timeout errors. */
  private busyNote(id: number): string {
    const head = this.inFlight.entries().next().value;
    if (!head) return '';
    const [headId, p] = head;
    const busyFor = Date.now() - Math.max(p.sentAt, this.lastReplyAt);
    if (headId === id) return ` (worker busy with it for ${busyFor} ms)`;
    return ` (worker busy with ${p.method} for ${busyFor} ms, ${this.inFlight.size - 1} request(s) queued behind it)`;
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
      try {
        msg = JSON.parse(trimmed) as typeof msg;
      } catch {
        continue;
      }
      const id = msg.id;
      if (typeof id !== 'number') continue;
      const pending = this.pending.get(id);
      const sent = this.inFlight.get(id);
      this.inFlight.delete(id);
      const now = Date.now();
      if (TRACE && sent) {
        const ran = now - Math.max(sent.sentAt, this.lastReplyAt);
        if (ran >= TRACE_SLOW_MS) {
          console.warn(`[${this.name}] ${sent.method}${pending ? '' : ' (timed out)'} ran ${ran} ms after waiting ${now - sent.sentAt - ran} ms`);
        }
      }
      this.lastReplyAt = now;
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.error) {
        try {
          pending.reject(
            new RpcError(
              Number(msg.error.code || -32000),
              String(msg.error.message || 'RPC error'),
              msg.error.data,
            ),
          );
        } catch {
          /* reject must never throw out of stdout */
        }
        continue;
      }
      try {
        this.deaths = 0;
        pending.resolve(msg.result);
      } catch {
        /* ignore */
      }
    }
  }
}

let singleton: WorkerClient | null = null;

export function getWorker(): WorkerClient {
  if (!singleton) singleton = new WorkerClient({ dataLane: new WorkerClient({ name: 'data-worker' }) });
  return singleton;
}

export function setWorkerForTests(client: WorkerClient | null): void {
  singleton = client;
}
