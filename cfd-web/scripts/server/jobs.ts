import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { PYTHON } from '../python-env.js';
import { parseJobLine, spawnJob } from '../job-runner.js';

export type JobKind = 'mesh' | 'solve' | 'cad_import' | 'filter';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  project?: string;
  params: Record<string, unknown>;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: unknown;
  events: object[];
  log_path: string | null;
}

export interface JobManagerOptions {
  cacheDir: string;
  onPersist?: (job: JobRecord) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `job-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export class JobManager extends EventEmitter {
  private readonly dir: string;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly emitters = new Map<string, EventEmitter>();
  private readonly onPersist?: (job: JobRecord) => void;

  constructor(opts: JobManagerOptions) {
    super();
    this.dir = join(opts.cacheDir, 'jobs');
    this.onPersist = opts.onPersist;
    mkdirSync(this.dir, { recursive: true });
    this.loadAll();
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as JobRecord;
        if (rec && rec.id) {
          if (rec.status === 'running' || rec.status === 'queued') {
            rec.status = 'failed';
            rec.error = rec.error || 'server restart — job lost';
            rec.finished_at = rec.finished_at || nowIso();
          }
          this.jobs.set(rec.id, rec);
        }
      } catch {
        /* ignore */
      }
    }
  }

  private persist(job: JobRecord): void {
    try {
      writeFileSync(join(this.dir, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
    if (this.onPersist) {
      try {
        this.onPersist(job);
      } catch {
        /* ignore */
      }
    }
  }

  private bus(id: string): EventEmitter {
    let e = this.emitters.get(id);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(50);
      this.emitters.set(id, e);
    }
    return e;
  }

  pushEvent(id: string, ev: object): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.events.push(ev);
    if (job.events.length > 400) job.events.splice(0, job.events.length - 400);
    this.persist(job);
    this.bus(id).emit('event', ev);
    this.emit('event', id, ev);
  }

  get(id: string): JobRecord | null {
    return this.jobs.get(id) || null;
  }

  list(filter?: { kind?: string; project?: string }): JobRecord[] {
    const out: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (filter?.kind && job.kind !== filter.kind) continue;
      if (filter?.project && job.project !== filter.project) continue;
      out.push(job);
    }
    out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return out;
  }

  create(kind: JobKind, params: Record<string, unknown>, project?: string): JobRecord {
    const job: JobRecord = {
      id: newId(),
      kind,
      status: 'queued',
      project,
      params,
      pid: null,
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      error: null,
      result: null,
      events: [],
      log_path: null,
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    return job;
  }

  attachChild(id: string, child: ChildProcess | { pid?: number | null } | null | undefined): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'running';
    job.started_at = job.started_at || nowIso();
    job.pid = child && child.pid != null ? Number(child.pid) : null;
    if (child && typeof (child as ChildProcess).kill === 'function') {
      this.children.set(id, child as ChildProcess);
    }
    this.persist(job);
    this.pushEvent(id, { event: 'start', job_id: id, kind: job.kind, pid: job.pid });
  }

  finish(id: string, status: 'done' | 'failed' | 'stopped', result?: unknown, error?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = status;
    job.finished_at = nowIso();
    job.pid = null;
    if (result !== undefined) job.result = result;
    if (error) job.error = error;
    this.children.delete(id);
    this.persist(job);
    this.pushEvent(id, {
      event: status === 'done' ? 'result' : 'error',
      job_id: id,
      status,
      result: job.result,
      error: job.error,
    });
    this.bus(id).emit('end', job);
  }

  stop(id: string): JobRecord | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const child = this.children.get(id);
    if (child && child.exitCode == null) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    if (job.status === 'running' || job.status === 'queued') {
      this.finish(id, 'stopped', job.result, 'stopped');
    }
    return this.jobs.get(id) || job;
  }

  onEvents(id: string): EventEmitter {
    return this.bus(id);
  }

  spawnPython(id: string, script: string, args: string[] = [], extra?: { env?: NodeJS.ProcessEnv }): ChildProcess {
    const { child } = spawnJob({
      kind: this.jobs.get(id)?.kind || 'job',
      jobId: id,
      script,
      args,
      env: extra?.env,
      onEvent: (ev: object) => this.pushEvent(id, ev),
      onExit: (code: number | null, signal: NodeJS.Signals | null) => {
        const job = this.jobs.get(id);
        if (!job || job.status === 'stopped') return;
        if (code === 0) this.finish(id, 'done', job.result);
        else this.finish(id, 'failed', job.result, `exit ${code}${signal ? ` ${signal}` : ''}`);
      },
    });
    this.attachChild(id, child);
    return child;
  }

  runSync(
    script: string,
    args: string[] = [],
    opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(PYTHON, [script, ...args], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: opts?.timeoutMs ?? 180_000,
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...(opts?.env || {}) },
    });
    return {
      status: r.status,
      stdout: String(r.stdout || ''),
      stderr: String(r.stderr || ''),
    };
  }
}

export { parseJobLine, spawn };

export function writeSse(res: import('node:http').ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
