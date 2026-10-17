/**
 * A coding agent as a process on this PC (phase 3 spec 4.4, 4.11): how it starts, what it
 * gets, and how it and everything it starts stop together.
 *
 * Start
 * - No shell, ever: `argv` comes from discovery or a custom command's split, and the program
 *   starts with shell:false and a hidden window.
 * - Its own working folder: mkdtemp(<os temp>/magnusim-agent-), private (0700) and empty,
 *   removed when the agent ends; leftovers older than a day go at the next start. It is never
 *   inside the repository, the projects root or the Assistant's home (whose parents hold the
 *   MCP token, the settings with the allow records, and the keys), and a start refuses one
 *   that is.
 * - An environment allowlist (agentEnv): the system's own variables, proxies and certificates,
 *   and that agent's own key, folder and prefix variables (plus a custom agent's listed ones and
 *   the catalogue's additions). Everything else, other vendors' keys and every MAGNUSIM_,
 *   CFDDESK_ and npm_ variable, NODE_OPTIONS and ELECTRON_RUN_AS_NODE included, is dropped.
 * - Containment, before the agent reads anything:
 *   - POSIX: the agent leads its own process group (detached). The group's id and its leader's
 *     start time go in <assistant data>/agents/pids.json until it ends, because nothing kills
 *     the group when Magnusim crashes: the next start signals the groups Magnusim left behind.
 *   - Windows: a job object (job-win.ts). The agent starts as launch.mjs (the trampoline), which
 *     waits on fd 3; the trampoline goes in the job first, then gets `go`, so the agent and all
 *     it starts are born inside the job. If the keeper is blocked or fails, the agent starts
 *     without a job and its tree kill is best effort (agentsTreeKill() says so).
 * - stderr is kept as a ring of its last 40 lines of 400 characters, redacted (tail()).
 *
 * Stop (stop(), idempotent; the tree kill):
 * - POSIX: stdin closed, up to 1.2 s to end, SIGTERM to the group, up to 1.2 s more, SIGKILL to
 *   the group. The group is signalled even when the leader already ended: its helpers outlive it.
 * - Windows with a job: stdin closed, up to 1.2 s to end, TerminateJobObject, then the keeper's
 *   stdin closes (KILL_ON_JOB_CLOSE ends anything left).
 * - Windows best effort: `taskkill /T /F` first, while the tree is still linked to its root
 *   (killProcessTreeAsync: an async process, never spawnSync), then stdin closed.
 * When this Node process exits, the live agents' groups get SIGKILL and their keepers' pipes
 * close (the job then ends them).
 *
 * The polite-then-forceful order and the group signalled after its leader ended come from
 * SolidCraft's agent chat (process.rs, MIT/Apache-2.0); the code is our own.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { killProcessTreeAsync } from '../../../proc-tree.js';
import { removeTree } from '../../../remove-tree.js';
import { PROJECTS_ROOT } from '../../../project-isolation.js';
import { ensurePrivateDir, readJsonFile, writeFileAtomic } from '../files.ts';
import { assistantDataDir, assistantHome } from '../home.ts';
import { alog } from '../log.ts';
import { redact } from '../redact.ts';
import { keeperLooksBlocked, noteKeeperOutcome, takeKeeper, type JobKeeper } from './job-win.ts';
import type { ExitInfo } from './rpc.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The trampoline (Windows). */
export const LAUNCH_SCRIPT = join(HERE, 'launch.mjs');
/** magnusim-web/. */
const WEB_ROOT = resolve(HERE, '..', '..', '..', '..');

export const AGENT_GRACE_MS = 1_200;
export const STDERR_LINES = 40;
export const STDERR_LINE_CHARS = 400;
export const WORKDIR_PREFIX = 'magnusim-agent-';
export const WORKDIR_MAX_AGE_MS = 24 * 3600_000;

const WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------------------------

export interface AgentEnvSpec {
  /** The agent's own key variables (catalogue keyVars). */
  keyVars?: readonly string[];
  /** The variable that moves its login folder (catalogue login.dirVar). */
  dirVar?: string | null;
  /** Its own variable prefixes (catalogue envPrefixes). */
  envPrefixes?: readonly string[];
  /** A custom agent's listed variables (keep_env). */
  keepEnv?: readonly string[];
  /** The catalogue's own additions (env()): set as given. */
  extra?: Readonly<Record<string, string>>;
  /** Discovery's search folders, appended to PATH. */
  searchFolders?: readonly string[];
}

/** The system's own variables an agent may see. */
const SYSTEM_NAMES = [
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'TZ',
  'SHELL',
  'USER',
  'USERNAME',
  'TERM',
  'NODE_EXTRA_CA_CERTS',
];
const SYSTEM_PREFIXES = ['LC_', 'XDG_'];
const PROXY_RE = /^(http_proxy|https_proxy|no_proxy)$/i;
/** Never passed, whoever lists it. */
const NEVER_RE = /^(MAGNUSIM_|CFDDESK_|npm_)|^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i;

/**
 * The agent's environment: an allowlist over `base` (spec 4.4). PATH keeps its absolute entries
 * in order, without duplicates, and gets the search folders appended. On Windows names compare
 * without case, as Windows does.
 */
export function agentEnv(spec: AgentEnvSpec = {}, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const win = platform === 'win32';
  const norm = (s: string) => (win ? s.toUpperCase() : s);
  const exact = new Set([...SYSTEM_NAMES, ...(spec.keyVars ?? []), ...(spec.dirVar ? [spec.dirVar] : []), ...(spec.keepEnv ?? [])].map(norm));
  const prefixes = [...SYSTEM_PREFIXES, ...(spec.envPrefixes ?? [])].filter((p) => p.length >= 2).map(norm);
  const out: Record<string, string> = {};
  let pathKey = 'PATH';
  let pathValue = '';
  for (const [name, value] of Object.entries(base)) {
    if (value == null) continue;
    if (norm(name) === 'PATH') {
      pathKey = win ? name : 'PATH';
      pathValue = value;
      continue;
    }
    if (NEVER_RE.test(name)) continue;
    const n = norm(name);
    if (exact.has(n) || PROXY_RE.test(name) || prefixes.some((p) => n.startsWith(p))) out[name] = value;
  }
  const seen = new Set<string>();
  const parts: string[] = [];
  const pathApi = win ? { isAbs: (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p), sep: ';' } : { isAbs: (p: string) => p.startsWith('/'), sep: ':' };
  for (const p of [...pathValue.split(pathApi.sep), ...(spec.searchFolders ?? [])]) {
    const entry = p.trim();
    if (!entry || !pathApi.isAbs(entry)) continue;
    const key = win ? entry.replace(/[\\/]+$/, '').toLowerCase() : entry.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(entry);
  }
  out[pathKey] = parts.join(pathApi.sep);
  for (const [name, value] of Object.entries(spec.extra ?? {})) {
    if (!NEVER_RE.test(name) && typeof value === 'string') out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The working folder
// ---------------------------------------------------------------------------------------------

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

function inside(root: string, p: string): boolean {
  const r = relative(WIN ? root.toLowerCase() : root, WIN ? p.toLowerCase() : p);
  return r === '' || (!isAbsolute(r) && r.split(sep)[0] !== '..');
}

export interface WorkdirRoots {
  repo: string;
  projects: string;
  home: string;
}

/** The folders an agent's working folder must never be in. */
export function forbiddenRoots(): WorkdirRoots {
  return { repo: resolve(WEB_ROOT, '..'), projects: resolve(PROJECTS_ROOT), home: assistantHome() };
}

/** Why `dir` can't be an agent's working folder, or null. */
export async function workdirRefusal(dir: string, roots: WorkdirRoots = forbiddenRoots()): Promise<string | null> {
  const d = await real(dir);
  for (const [what, root] of [
    ['the repository', roots.repo],
    ['the projects folder', roots.projects],
    ["the Assistant's folder", roots.home],
  ] as const) {
    if (inside(await real(root), d) || inside(resolve(root), resolve(dir))) return `the agent's working folder would be inside ${what}`;
  }
  return null;
}

/** A new private, empty working folder for one agent process, under the OS temp folder. */
export async function makeAgentWorkdir(o: { tmp?: string; roots?: WorkdirRoots } = {}): Promise<string> {
  const dir = await mkdtemp(join(o.tmp ?? tmpdir(), WORKDIR_PREFIX));
  await ensurePrivateDir(dir);
  const refusal = await workdirRefusal(dir, o.roots);
  if (refusal) {
    await removeTree(dir).catch(() => {});
    throw new Error(refusal);
  }
  return dir;
}

/** Removes leftover working folders older than a day (a crashed Magnusim's). Returns how many. */
export async function sweepAgentWorkdirs(o: { tmp?: string; now?: number; maxAgeMs?: number } = {}): Promise<number> {
  const tmp = o.tmp ?? tmpdir();
  const now = o.now ?? Date.now();
  const maxAge = o.maxAgeMs ?? WORKDIR_MAX_AGE_MS;
  let names: string[];
  try {
    names = await readdir(tmp);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(WORKDIR_PREFIX)) continue;
    const p = join(tmp, name);
    try {
      const st = await lstat(p);
      if (!st.isDirectory() || st.isSymbolicLink() || now - st.mtimeMs < maxAge) continue;
      await removeTree(p);
      removed += 1;
    } catch {
      /* in use or gone: the next start tries again */
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// POSIX: the groups left behind (pids.json)
// ---------------------------------------------------------------------------------------------

interface GroupRecord {
  pgid: number;
  /** The leader's start time ('linux:<ticks since boot>' or 'ps:<lstart>'), or null if unknown. */
  start: string | null;
  /** The Magnusim process that started it, and its start time. */
  owner: { pid: number; start: string | null };
  label: string;
  at: string;
}

export function pidsFile(): string {
  return join(assistantDataDir(), 'agents', 'pids.json');
}

/** A process's start time as this OS can tell it (null: unknown or gone). Never spawnSync. */
export async function processStart(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // Field 3 (the state) is rest[0]; field 22 (the start time) rest[19].
      return rest[0] === 'Z' ? null : `linux:${rest[19]}`;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') return null;
  return new Promise((done) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn('ps', ['-o', 'lstart=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, 2_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      done(out.trim() ? `ps:${out.trim()}` : null);
    });
  });
}

let pidsChain: Promise<unknown> = Promise.resolve();

async function readGroups(): Promise<GroupRecord[]> {
  const r = await readJsonFile(pidsFile()).catch(() => ({ state: 'missing' as const }));
  if (r.state !== 'ok') return [];
  const groups = (r.value as { groups?: unknown })?.groups;
  return Array.isArray(groups) ? (groups.filter((g) => g && Number.isInteger((g as GroupRecord).pgid) && (g as GroupRecord).pgid > 1) as GroupRecord[]) : [];
}

/** Serialised read-change-write of pids.json. */
function changeGroups(fn: (groups: GroupRecord[]) => GroupRecord[]): Promise<void> {
  const next = pidsChain.then(async () => {
    const before = await readGroups();
    const after = fn(before);
    await writeFileAtomic(pidsFile(), `${JSON.stringify({ version: 1, groups: after }, null, 2)}\n`);
  });
  pidsChain = next.catch((err) => alog('warn', 'pids.json could not be written', { error: String((err as Error)?.message || err).slice(0, 200) }));
  return pidsChain as Promise<void>;
}

/** Whether a process group of this account exists (EPERM: another account's, never ours). */
const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * POSIX: SIGKILL every agent group a Magnusim that is no longer running left behind, when its
 * leader still has the recorded start time, or its leader is gone but the group lives on (a
 * group id can't be taken by a new group while any member of the old one lives). Records of a
 * Magnusim still running (another copy on this account) are kept. Returns the groups signalled.
 */
export async function sweepAgentGroups(): Promise<number[]> {
  if (WIN) return [];
  const signalled: number[] = [];
  const owners = new Map<string, boolean>();
  const ownerAlive = async (o: GroupRecord['owner']): Promise<boolean> => {
    const key = `${o?.pid}:${o?.start}`;
    if (!owners.has(key)) owners.set(key, !!o && o.pid !== process.pid && o.start != null && (await processStart(o.pid)) === o.start);
    return owners.get(key) as boolean;
  };
  const keep: GroupRecord[] = [];
  const groups = await readGroups();
  if (!groups.length) return [];
  for (const g of groups) {
    if (g.owner?.pid === process.pid || (await ownerAlive(g.owner))) {
      keep.push(g);
      continue;
    }
    const leaderStart = await processStart(g.pgid);
    const ours = leaderStart != null ? g.start != null && leaderStart === g.start : groupExists(g.pgid);
    if (!ours) continue;
    try {
      process.kill(-g.pgid, 'SIGKILL');
      signalled.push(g.pgid);
    } catch {
      /* gone meanwhile */
    }
  }
  // Every record of a Magnusim that has ended goes, signalled or not (a group that is gone, or a
  // leader id now used by another program).
  const id = (g: GroupRecord) => `${g.pgid}|${g.owner?.pid}|${g.start}`;
  const handled = new Set(groups.filter((g) => !keep.includes(g)).map(id));
  await changeGroups((now) => now.filter((g) => !handled.has(id(g))));
  if (signalled.length) alog('info', 'agent groups left by an earlier run were stopped', { groups: signalled.length });
  return signalled;
}

let startSweep: Promise<unknown> | null = null;

/** Once per process, before the first agent starts: the old working folders and (POSIX) groups. */
function sweepOnce(): Promise<unknown> {
  if (!startSweep) {
    void sweepAgentWorkdirs().catch(() => 0);
    startSweep = sweepAgentGroups().catch((err) => alog('warn', 'the agent group sweep failed', { error: String((err as Error)?.message || err).slice(0, 200) }));
  }
  return startSweep;
}

// ---------------------------------------------------------------------------------------------
// Tree-kill status
// ---------------------------------------------------------------------------------------------

export type TreeKill = 'job' | 'group' | 'best_effort';
/**
 * How agents' trees are stopped on this PC (status `agents_tree_kill`): best effort once a
 * keeper (a warmed one included) or a job assignment failed, until one works again.
 */
export function agentsTreeKill(): TreeKill {
  if (!WIN) return 'group';
  return keeperLooksBlocked() ? 'best_effort' : 'job';
}

// ---------------------------------------------------------------------------------------------
// The process
// ---------------------------------------------------------------------------------------------

export interface StartAgentOptions {
  /** The resolved command: program first. */
  argv: readonly string[];
  /** For logs and pids.json (the agent's id). */
  label?: string;
  env?: AgentEnvSpec;
  /** Windows: the keeper to use (else a warmed or new one). */
  keeper?: JobKeeper;
  signal?: AbortSignal;
  /** Tests: the environment the allowlist reads (process.env otherwise). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Tests: where the working folder goes (os.tmpdir() otherwise). */
  tmp?: string;
  /** Tests: shorter grace periods. */
  graceMs?: number;
  /** Tests (Windows): runs after the spawn and before the job assignment. */
  beforeAssign?: (pid: number) => Promise<void>;
}

const live = new Set<AgentProcess>();
let exitHook = false;

function onProcessExit(): void {
  for (const a of live) a.dropAtExit();
}

export class AgentProcess {
  readonly label: string;
  /** The process Magnusim started (on Windows with a job: the trampoline). */
  readonly pid: number;
  readonly cwd: string;
  readonly treeKill: TreeKill;
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Resolves when the process Magnusim started has exited. */
  readonly exited: Promise<ExitInfo>;
  exitInfo: ExitInfo | null = null;
  /** Windows: the keeper of this agent's job (null without one). */
  readonly keeper: JobKeeper | null;
  private readonly graceMs: number;
  private readonly ring: string[] = [];
  private partial = '';
  private stopping: Promise<void> | null = null;

  constructor(o: { label: string; child: ChildProcess; exit: ExitWatch; cwd: string; treeKill: TreeKill; keeper: JobKeeper | null; graceMs: number }) {
    this.label = o.label;
    this.pid = o.child.pid as number;
    this.cwd = o.cwd;
    this.treeKill = o.treeKill;
    this.keeper = o.keeper;
    this.graceMs = o.graceMs;
    this.stdin = o.child.stdin as Writable;
    this.stdout = o.child.stdout as Readable;
    this.stdin.on('error', () => {
      /* the agent ended; its exit says so */
    });
    this.exitInfo = o.exit.info();
    this.exited = o.exit.promise.then((info) => {
      this.exitInfo = info;
      return info;
    });
    o.child.stderr?.setEncoding('utf8');
    o.child.stderr?.on('data', (d: string) => this.feedStderr(d));
    o.child.stderr?.on('end', () => this.flushStderr());
    live.add(this);
    if (!exitHook) {
      exitHook = true;
      process.once('exit', onProcessExit);
    }
  }

  /** The agent's last stderr lines (at most 40 of 400 characters), redacted. */
  tail(): string[] {
    const out = [...this.ring];
    if (this.partial.trim()) out.push(redact(this.partial).slice(0, STDERR_LINE_CHARS));
    return out.slice(-STDERR_LINES);
  }

  get stopped(): boolean {
    return this.stopping != null;
  }

  /** The tree kill (see the header). Idempotent: every call waits for the same stop. */
  stop(why = 'stop'): Promise<void> {
    if (!this.stopping) this.stopping = this.runStop(why);
    return this.stopping;
  }

  /** At this process's exit: synchronous only. */
  dropAtExit(): void {
    if (!WIN) {
      try {
        process.kill(-this.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    this.keeper?.close();
  }

  private async runStop(why: string): Promise<void> {
    const t0 = Date.now();
    try {
      if (this.treeKill === 'best_effort') {
        // While the tree is still linked to its root.
        if (!this.exitInfo) await killProcessTreeAsync(this.pid);
        this.closeStdin();
        await this.waitExit(this.graceMs);
      } else if (this.treeKill === 'job') {
        this.closeStdin();
        await this.waitExit(this.graceMs);
        try {
          await (this.keeper as JobKeeper).kill();
        } catch (err) {
          alog('warn', 'the agent job could not be ended; trying taskkill', { agent: this.label, error: String((err as Error)?.message || err).slice(0, 200) });
          if (!this.exitInfo) await killProcessTreeAsync(this.pid);
        }
        this.keeper?.close();
        await this.waitExit(this.graceMs);
      } else {
        this.closeStdin();
        const ended = await this.waitExit(this.graceMs);
        this.signalGroup('SIGTERM');
        if (!ended) await this.waitExit(this.graceMs);
        this.signalGroup('SIGKILL');
        await this.waitExit(this.graceMs);
        await changeGroups((groups) => groups.filter((g) => g.pgid !== this.pid));
      }
    } finally {
      live.delete(this);
      this.keeper?.close();
      await removeTree(this.cwd).catch((err: unknown) => alog('warn', "an agent's working folder could not be removed", { agent: this.label, error: String((err as Error)?.message || err).slice(0, 200) }));
      alog('info', 'agent stopped', { agent: this.label, why, tree_kill: this.treeKill, ms: Date.now() - t0 });
    }
  }

  private closeStdin(): void {
    try {
      this.stdin.end();
    } catch {
      /* gone */
    }
  }

  /** Whether the process ended within `ms`. */
  private waitExit(ms: number): Promise<boolean> {
    if (this.exitInfo) return Promise.resolve(true);
    return new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), ms);
      this.exited.then(() => {
        clearTimeout(timer);
        done(true);
      });
    });
  }

  private signalGroup(signal: NodeJS.Signals): void {
    // Even when the leader ended: its helpers outlive it, and the group id stays theirs while
    // any of them lives.
    try {
      process.kill(-this.pid, signal);
    } catch {
      /* the group is gone */
    }
  }

  private feedStderr(d: string): void {
    this.partial += d;
    let nl: number;
    while ((nl = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, nl).replace(/\r$/, '');
      this.partial = this.partial.slice(nl + 1);
      if (!line.trim()) continue;
      this.ring.push(redact(line).slice(0, STDERR_LINE_CHARS));
      if (this.ring.length > STDERR_LINES) this.ring.shift();
    }
    // A line that never ends is kept to its cap only.
    if (this.partial.length > STDERR_LINE_CHARS * 4) this.partial = this.partial.slice(0, STDERR_LINE_CHARS * 4);
  }

  private flushStderr(): void {
    if (this.partial.trim()) {
      this.ring.push(redact(this.partial).slice(0, STDERR_LINE_CHARS));
      if (this.ring.length > STDERR_LINES) this.ring.shift();
    }
    this.partial = '';
  }
}

interface ExitWatch {
  promise: Promise<ExitInfo>;
  info(): ExitInfo | null;
}

/** Watches for the child's exit from its spawn on, so an early exit is never missed. */
function watchExit(child: ChildProcess): ExitWatch {
  let seen: ExitInfo | null = null;
  const promise = new Promise<ExitInfo>((done) => {
    child.once('exit', (code, signal) => {
      seen = { code, signal };
      done(seen);
    });
  });
  return { promise, info: () => seen };
}

/** Waits for the child's 'spawn' (resolves) or 'error' (rejects). */
function spawned(child: ChildProcess): Promise<void> {
  return new Promise<void>((ok, fail) => {
    child.once('spawn', () => ok());
    child.once('error', (err) => fail(err));
  });
}

export class AgentStartError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentStartError';
    this.code = code;
  }
}

/**
 * Starts the agent, contained (spec 4.4, 4.11). On Windows the job assignment completes before
 * this resolves, so nothing the agent starts can escape it; `initialize` may be sent at once.
 */
export async function startAgentProcess(o: StartAgentOptions): Promise<AgentProcess> {
  const argv = [...o.argv];
  if (!argv.length || !argv[0]) throw new AgentStartError('bad_command', 'no agent command');
  const label = o.label ?? 'agent';
  const graceMs = o.graceMs ?? AGENT_GRACE_MS;
  await sweepOnce();
  if (o.signal?.aborted) throw o.signal.reason ?? new Error('aborted');
  const cwd = await makeAgentWorkdir({ tmp: o.tmp });
  const env = agentEnv(o.env, o.baseEnv ?? process.env);
  const base = { cwd, env, windowsHide: true, shell: false } as const;
  let child: ChildProcess | null = null;
  let exit: ExitWatch | null = null;
  let keeper: JobKeeper | null = null;
  let treeKill: TreeKill = WIN ? 'job' : 'group';
  try {
    if (WIN) {
      keeper = o.keeper ?? takeKeeper();
      try {
        await keeper.ready;
      } catch (err) {
        treeKill = 'best_effort';
        alog('warn', 'the agent job keeper is unavailable; stopping agents is best effort', { error: String((err as Error)?.message || err).slice(0, 200) });
        keeper.close();
        keeper = null;
      }
      if (keeper) {
        const before = Date.now();
        child = spawn(process.execPath, [LAUNCH_SCRIPT, ...argv], { ...base, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        const after = Date.now();
        exit = watchExit(child);
        await spawned(child);
        try {
          await o.beforeAssign?.(child.pid as number);
          await keeper.assign(child.pid as number, before, after);
          noteKeeperOutcome(true);
        } catch (err) {
          // The trampoline has started nothing yet: it still starts, linked, and the tree kill
          // is taskkill /T.
          noteKeeperOutcome(false);
          treeKill = 'best_effort';
          alog('warn', 'the agent could not be put in a job; stopping it is best effort', { agent: label, error: String((err as Error)?.message || err).slice(0, 200) });
          keeper.close();
          keeper = null;
        }
        const control = child.stdio[3] as Writable;
        control.on('error', () => {});
        control.end('go\n');
      } else {
        child = spawn(argv[0], argv.slice(1), { ...base, stdio: ['pipe', 'pipe', 'pipe'] });
        exit = watchExit(child);
        await spawned(child);
      }
    } else {
      child = spawn(argv[0], argv.slice(1), { ...base, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      exit = watchExit(child);
      await spawned(child);
      const pid = child.pid as number;
      const [start, ownerStart] = await Promise.all([processStart(pid), processStart(process.pid)]);
      await changeGroups((groups) => [
        ...groups.filter((g) => g.pgid !== pid),
        { pgid: pid, start, owner: { pid: process.pid, start: ownerStart }, label, at: new Date().toISOString() },
      ]);
    }
  } catch (err) {
    keeper?.close();
    if (child?.pid) {
      try {
        if (WIN) await killProcessTreeAsync(child.pid);
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await removeTree(cwd).catch(() => {});
    const code = String((err as NodeJS.ErrnoException)?.code || '');
    if (code === 'ENOENT') throw new AgentStartError('agent_missing', `${argv[0]} was not found`);
    if (code === 'EACCES' || code === 'EPERM') throw new AgentStartError('cant_start', `${argv[0]} could not be started (${code})`);
    throw err;
  }
  const proc = new AgentProcess({ label, child, exit: exit as ExitWatch, cwd, treeKill, keeper, graceMs });
  alog('info', 'agent started', { agent: label, pid: proc.pid, tree_kill: treeKill });
  if (o.signal) {
    if (o.signal.aborted) {
      await proc.stop('aborted');
      throw o.signal.reason ?? new Error('aborted');
    }
  }
  return proc;
}

/** Stops every live agent process (tests; the agent host's own shutdown). */
export async function stopAllAgentProcesses(why = 'shutdown'): Promise<void> {
  await Promise.all([...live].map((a) => a.stop(why)));
}
