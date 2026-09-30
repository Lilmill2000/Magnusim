/**
 * Plugin environments and services (API 1.1).
 *
 * A plugin with its own environment ([python] in its manifest) runs its backend
 * as a service: `<env python> -I -m magnusim_sdk.service <module>` in the
 * plugin's folder, one process per plugin, so a slow or stuck plugin never
 * holds another plugin or the core's worker. A service:
 * - starts on the first call to it (`/api/plugin/<key>/<method>`);
 * - answers one call at a time; a call has 30 s unless its method declares
 *   more (600 s at most). A call that runs longer ends the service and
 *   everything it started, and the caller gets a timeout;
 * - stops after 10 minutes without calls, and when its plugin is turned off,
 *   reloaded or removed;
 * - after a crash, the call in flight gets the error and the next call starts
 *   it again.
 *
 * The environment itself is built by `tools/plugin_env.py create <key>`, run
 * here in the background while the Plugins settings row polls its progress.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { spawnJob } from '../job-runner.js';
import { isolatedPythonEnv, killProcessTree, ownProcessGroup } from '../proc-tree.js';
import { pyTool } from '../python-env.js';
import { projectDir } from '../w17-sim-catalog.js';
import { RpcError, type WorkerClient } from './worker.ts';

export const SERVICE_IDLE_MS = Number(process.env.MAGNUSIM_PLUGIN_SERVICE_IDLE_MS || 600_000);
const DEFAULT_CALL_MS = 30_000;
const MAX_CALL_MS = 600_000;
const START_MS = 30_000;
const ENV_CACHE_MS = 5_000;

/** A service call that failed; `status` is the HTTP status the route answers with. */
export class PluginServiceError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'PluginServiceError';
    this.status = status;
  }
}

export interface ServiceSpec {
  key: string;
  name: string;
  /** The plugin environment's interpreter. */
  python: string;
  /** Its backend module (manifest [python] service). */
  module: string;
  /** The plugin's folder (the service's working directory). */
  cwd: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PluginService {
  readonly spec: ServiceSpec;
  private readonly idleMs: number;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private declared: Record<string, { timeout_s?: number }> = {};
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail: string[] = [];
  /** What the service reported when it started (sdk, python, prefix). */
  info: Record<string, unknown> = {};
  /** How many times it was started (the tests read it). */
  starts = 0;

  constructor(spec: ServiceSpec, idleMs = SERVICE_IDLE_MS) {
    this.spec = spec;
    this.idleMs = idleMs;
  }

  running(): boolean {
    return !!this.child && this.child.exitCode == null && !this.child.killed;
  }

  pid(): number | null {
    return this.running() && this.child ? this.child.pid ?? null : null;
  }

  /** The methods the running service registered (empty until it started). */
  methods(): string[] {
    return Object.keys(this.declared);
  }

  timeoutFor(method: string): number {
    const secs = Number(this.declared[method]?.timeout_s);
    return Number.isFinite(secs) && secs > 0 ? Math.min(MAX_CALL_MS, secs * 1000) : DEFAULT_CALL_MS;
  }

  async call(method: string, params: unknown, scope: unknown): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child || !child.stdin) throw new PluginServiceError(`${this.spec.name}: its service is not running`);
    const limit = this.timeoutFor(method);
    this.touch();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const why = `${this.spec.name}: ${method} took longer than ${Math.round(limit / 1000)} s`;
        reject(new PluginServiceError(why, 504));
        // One call at a time: a stuck call would hold every later one.
        this.stop(`ended (${method} took longer than ${Math.round(limit / 1000)} s)`);
      }, limit);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { params, scope } }) + '\n', 'utf8');
    });
  }

  /** Start the process (once) and wait for its ready line. */
  start(): Promise<void> {
    if (this.starting && this.running()) return this.starting;
    const name = this.spec.name;
    this.stderrTail = [];
    this.starting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        if (err) reject(err);
        else resolve();
      };
      const child = spawn(this.spec.python, ['-I', '-m', 'magnusim_sdk.service', this.spec.module], {
        cwd: this.spec.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: isolatedPythonEnv({
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          MAGNUSIM_PLUGIN_KEY: this.spec.key,
        }),
        ...ownProcessGroup(),
      });
      this.child = child;
      this.starts += 1;
      const startTimer = setTimeout(() => {
        settle(new PluginServiceError(`${name}: its service did not start within ${START_MS / 1000} s`));
        this.stop('did not start');
      }, START_MS);
      createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line, settle));
      child.stderr!.on('data', (chunk: Buffer) => {
        for (const ln of String(chunk).split(/\r?\n/)) {
          if (!ln.trim()) continue;
          this.stderrTail.push(ln.slice(0, 400));
          if (this.stderrTail.length > 40) this.stderrTail.shift();
        }
      });
      child.on('error', (err) => settle(new PluginServiceError(`${name}: its service could not start: ${err.message}`)));
      child.on('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null;
          this.starting = null;
        }
        const last = this.stderrTail.slice(-3).join(' | ');
        const why = `${name}: its service stopped (exit ${code ?? signal})${last ? `: ${last}` : ''}`;
        settle(new PluginServiceError(why));
        this.failPending(why);
      });
    });
    return this.starting;
  }

  private onLine(line: string, settle: (err?: Error) => void): void {
    let msg: { method?: string; id?: number; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === 'ready') {
      const params = msg.params || {};
      this.declared = (params.methods as Record<string, { timeout_s?: number }>) || {};
      this.info = { sdk: params.sdk, python: params.python, prefix: params.prefix };
      settle();
      return;
    }
    if (msg.method === 'failed') {
      settle(new PluginServiceError(`${this.spec.name}: its service failed to start: ${String(msg.params?.error || '')}`));
      return;
    }
    const pending = msg.id != null ? this.pending.get(msg.id) : undefined;
    if (!pending) return;
    this.pending.delete(msg.id as number);
    clearTimeout(pending.timer);
    this.touch();
    if (msg.error) {
      const status = msg.error.code === -32601 ? 404 : 500;
      pending.reject(new PluginServiceError(String(msg.error.message || 'the plugin method failed'), status));
    } else {
      pending.resolve(msg.result);
    }
  }

  private failPending(why: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new PluginServiceError(why));
      this.pending.delete(id);
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.stop('stopped after being idle');
      else this.touch();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** End the process and everything it started; calls in flight get `reason`. */
  stop(reason = 'stopped'): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child && child.exitCode == null) killProcessTree(child.pid);
    this.failPending(`${this.spec.name}: its service ${reason}`);
  }
}

/** A plugin's environment as the worker reports it (plugins.env). */
export interface PluginEnv {
  state: 'ready' | 'needs_setup' | 'failed';
  python?: string;
  service?: string;
  plugin_dir?: string | null;
  error?: string;
  tail?: string[];
  lock_hash?: string;
  python_version?: string;
}

export class PluginServiceHost {
  private readonly worker: WorkerClient;
  private readonly idleMs: number;
  private services = new Map<string, PluginService>();
  private envs = new Map<string, { at: number; name: string; env: PluginEnv | null }>();

  constructor(worker: WorkerClient, opts: { idleMs?: number } = {}) {
    this.worker = worker;
    this.idleMs = opts.idleMs ?? SERVICE_IDLE_MS;
  }

  /** The plugin's environment (null: none, or the plugin is not loaded). Cached briefly. */
  async envOf(key: string): Promise<{ name: string; env: PluginEnv | null }> {
    const hit = this.envs.get(key);
    if (hit && Date.now() - hit.at < ENV_CACHE_MS) return { name: hit.name, env: hit.env };
    let name = key;
    let env: PluginEnv | null = null;
    try {
      const r = (await this.worker.call('plugins.env', { key })) as { name?: string; env?: PluginEnv | null };
      name = String(r.name || key);
      env = r.env || null;
    } catch (err) {
      // -32004: off, missing or failed to load: no service (the dispatch says why).
      if (!(err instanceof RpcError && err.code === -32004)) throw err;
    }
    this.envs.set(key, { at: Date.now(), name, env });
    return { name, env };
  }

  /**
   * The plugin's service, or null when it has none (its methods, if any, run
   * in the core's plugin lane). Throws 409 when its environment needs setup.
   */
  async serviceFor(key: string): Promise<PluginService | null> {
    const { name, env } = await this.envOf(key);
    if (!env || !env.service) return null;
    if (env.state !== 'ready' || !env.python || !env.plugin_dir) {
      throw new PluginServiceError(`${name} needs setup: install its dependencies in Settings > Plugins`, 409);
    }
    const spec: ServiceSpec = { key, name, python: env.python, module: env.service, cwd: env.plugin_dir };
    let svc = this.services.get(key);
    if (svc && (svc.spec.python !== spec.python || svc.spec.module !== spec.module || svc.spec.cwd !== spec.cwd)) {
      svc.stop('replaced by a new environment');
      svc = undefined;
    }
    if (!svc) {
      svc = new PluginService(spec, this.idleMs);
      this.services.set(key, svc);
    }
    return svc;
  }

  get(key: string): PluginService | undefined {
    return this.services.get(key);
  }

  /** Read the plugin's environment afresh next time (its service keeps running). */
  forgetEnv(key: string): void {
    this.envs.delete(key);
  }

  /** Stop a plugin's service and forget its environment (turned off, reloaded, rebuilt). */
  reset(key: string, reason = 'stopped'): void {
    this.services.get(key)?.stop(reason);
    this.services.delete(key);
    this.envs.delete(key);
    forgetStudyMigrations(key);
  }

  resetAll(reason = 'stopped'): void {
    for (const key of [...this.services.keys()]) this.reset(key, reason);
    this.envs.clear();
  }
}

/** The scope a service method gets: the plugin, and the project (with its folder). */
export function serviceScope(
  key: string,
  scope: { projectId?: string; simulationId?: string; geometryId?: string },
): Record<string, unknown> {
  const pid = String(scope.projectId || '');
  let dir = '';
  try {
    dir = pid ? projectDir(pid) : '';
  } catch {
    dir = '';
  }
  return {
    plugin: key,
    project_id: pid || null,
    project_dir: dir || null,
    simulation_id: scope.simulationId || null,
    geometry_id: scope.geometryId || null,
  };
}

export interface EnvInstall {
  state: 'installing' | 'ready' | 'failed';
  stage: string;
  label: string;
  log: string[];
  error?: string;
  tail?: string[];
  started_at: string;
  finished_at?: string;
}

/** Builds plugin environments in the background (the Install dependencies button). */
export class PluginEnvInstaller {
  private runs = new Map<string, EnvInstall>();
  private readonly onDone: (key: string, run: EnvInstall) => void;

  constructor(onDone: (key: string, run: EnvInstall) => void) {
    this.onDone = onDone;
  }

  get(key: string): EnvInstall | null {
    return this.runs.get(key) || null;
  }

  start(key: string): EnvInstall {
    const current = this.runs.get(key);
    if (current && current.state === 'installing') return current;
    const run: EnvInstall = {
      state: 'installing',
      stage: 'start',
      label: 'Starting',
      log: [],
      started_at: new Date().toISOString(),
    };
    this.runs.set(key, run);
    spawnJob({
      kind: 'plugin_env',
      jobId: `plugin-env-${key}`,
      script: pyTool('plugin_env.py'),
      args: ['create', key],
      onEvent: (ev: Record<string, unknown>) => {
        if (ev.event === 'stage') {
          run.stage = String(ev.stage || run.stage);
          run.label = String(ev.label || run.label);
        } else if (ev.event === 'log' && ev.line) {
          run.log.push(String(ev.line));
          if (run.log.length > 200) run.log.shift();
        } else if (ev.event === 'error') {
          run.error = String(ev.message || 'Setup failed');
          run.tail = Array.isArray(ev.tail) ? ev.tail.map(String) : [];
        }
      },
      onExit: (code: number | null) => {
        run.state = code === 0 && !run.error ? 'ready' : 'failed';
        if (run.state === 'failed' && !run.error) run.error = `Setup failed (exit ${code})`;
        run.finished_at = new Date().toISOString();
        this.onDone(key, run);
      },
    });
    return run;
  }
}

interface StudyRow {
  id: string;
  plugin: string;
  needs_migration?: boolean;
  schema_version?: number;
  kind_schema_version?: number | null;
}

/** Study migrations running, by project/plugin/study (one at a time each). */
const migrating = new Map<string, Promise<boolean>>();
/** Migrations that changed nothing (no service yet, no migrate_study, an error): when. */
const gaveUp = new Map<string, number>();
const MIGRATION_RETRY_MS = 5 * 60_000;

/** Try this plugin's studies again at once (its service or environment changed). */
export function forgetStudyMigrations(plugin: string): void {
  for (const id of [...gaveUp.keys()]) if (id.split('/')[1] === plugin) gaveUp.delete(id);
}

/**
 * Start upgrading, in the background, the studies saved with an older schema of
 * their kind (see migratePluginStudies). The core's reads never wait for a
 * plugin: this returns at once, true while any of this project's studies is
 * still being upgraded (the page reads the list again shortly).
 */
export function startStudyMigrations(
  worker: WorkerClient,
  host: PluginServiceHost,
  projectId: string,
  studies: StudyRow[] | undefined,
): boolean {
  let pending = false;
  for (const row of studies || []) {
    if (!row || !row.needs_migration) continue;
    const id = `${projectId}/${row.plugin}/${row.id}`;
    if (migrating.has(id)) {
      pending = true;
      continue;
    }
    const last = gaveUp.get(id);
    if (last && Date.now() - last < MIGRATION_RETRY_MS) continue;
    pending = true;
    const run = migrateOne(worker, host, projectId, row)
      .then((outcome) => {
        if (outcome === 'skip') gaveUp.set(id, Date.now());
        else gaveUp.delete(id);
        return outcome === 'changed';
      })
      .finally(() => migrating.delete(id));
    migrating.set(id, run);
  }
  return pending;
}

type MigrationOutcome = 'changed' | 'skip' | 'retry';

/**
 * Upgrade one study saved with an older schema of its kind: its plugin's
 * service `migrate_study` gets the record, and the worker stores what it
 * returns (rev-checked). 'skip' when it cannot (the plugin needs setup, has no
 * service or no migrate_study, or the method failed); 'retry' when the service
 * was busy or stopped meanwhile.
 */
async function migrateOne(
  worker: WorkerClient,
  host: PluginServiceHost,
  projectId: string,
  row: StudyRow,
): Promise<MigrationOutcome> {
  try {
    const svc = await host.serviceFor(row.plugin);
    if (!svc) return 'skip';
    await svc.start();
    if (!svc.methods().includes('migrate_study')) return 'skip';
    const got = (await worker.call('plugin_studies.get', {
      project_id: projectId,
      plugin: row.plugin,
      study_id: row.id,
    })) as { study?: Record<string, unknown> };
    if (!got.study) return 'skip';
    const upgraded = await svc.call(
      'migrate_study',
      { study: got.study, from_version: row.schema_version ?? 1, to_version: row.kind_schema_version ?? null },
      serviceScope(row.plugin, { projectId }),
    );
    await worker.call('plugin_studies.migrated', {
      project_id: projectId,
      plugin: row.plugin,
      study_id: row.id,
      rev: got.study.rev,
      study: upgraded,
    });
    return 'changed';
  } catch (err) {
    console.warn(`[plugins] ${row.plugin}: migrate_study for ${row.id} failed:`, err instanceof Error ? err.message : err);
    // Stopped or timed out under another call: try again on the next read.
    const transient = err instanceof PluginServiceError && (err.status === 502 || err.status === 504);
    return transient || (err instanceof RpcError && err.code === -32009) ? 'retry' : 'skip';
  }
}

/** Upgrade every study that needs it now (awaited; the routes use startStudyMigrations). */
export async function migratePluginStudies(
  worker: WorkerClient,
  host: PluginServiceHost,
  projectId: string,
  studies: StudyRow[] | undefined,
): Promise<boolean> {
  let changed = false;
  for (const row of studies || []) {
    if (row && row.needs_migration && (await migrateOne(worker, host, projectId, row)) === 'changed') changed = true;
  }
  return changed;
}
