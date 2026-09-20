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

export interface WorkerClientOptions {
  python?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxDeaths?: number;
  backoffMs?: number[];
}

const DEFAULT_BACKOFF = [250, 750, 2000];

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

  constructor(opts: WorkerClientOptions = {}) {
    super();
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
    if (!this.child) this.spawnChild();
  }

  stop(): void {
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
    return new Promise((resolve, reject) => {
      this.queue.push(() => {
        this.send(method, params, timeoutMs).then(resolve, reject);
      });
      this.drain();
    });
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
        this.pending.delete(id);
        reject(new Error(`worker RPC timeout: ${method}`));
      }, wait);
      this.pending.set(id, { resolve, reject, timer });
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
  if (!singleton) singleton = new WorkerClient();
  return singleton;
}

export function setWorkerForTests(client: WorkerClient | null): void {
  singleton = client;
}
