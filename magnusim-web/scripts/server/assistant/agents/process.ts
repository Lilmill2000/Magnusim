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
 *   - POSIX: the agent leads its own process group (detached). The group's id, its leader's
 *     start time, the boot and the working folder go in <assistant data>/agents/pids.json until
 *     it ends (a normal exit takes the records with the groups), because nothing kills the
 *     group when Magnusim crashes: its next agent start signals the groups a crashed Magnusim left
 *     behind, on proof only (sweepAgentGroups): a record of another boot is dropped; a group
 *     whose leader lives must have the recorded start time (spec 4.11); a group whose leader
 *     ended is signalled only on Linux, when a live member works in the agent's own private
 *     folder and none started before the leader. Anything else is left alone.
 *   - Windows: a job object (job-win.ts). The agent starts as launch.mjs (the trampoline), which
 *     waits on fd 3; the trampoline goes in the job first, then gets `go`, so the agent and all
 *     it starts are born inside the job. If the keeper is blocked or fails, the agent starts
 *     without a job and its tree kill is best effort (agentsTreeKill() says so).
 * - stderr is kept as a ring of its last 40 lines of 400 characters, redacted and cleaned of
 *   control characters, terminal escapes' ESC and bidi marks (tail()).
 *
 * Stop (stop(), idempotent; the tree kill):
 * - POSIX: stdin closed, up to 1.2 s for the agent to end, SIGTERM to the group, up to 1.2 s
 *   for the group to empty (its helpers get that grace too), then SIGKILL to what is left. The
 *   group is signalled even when the leader already ended: its helpers outlive it.
 * - Windows with a job: stdin closed, up to 1.2 s to end, TerminateJobObject, then the keeper's
 *   stdin closes (KILL_ON_JOB_CLOSE ends anything left).
 * - Windows best effort: `taskkill /T /F` first, while the tree is still linked to its root
 *   (killProcessTreeAsync: an async process, never spawnSync), then stdin closed.
 * When this Node process exits, the live agents' groups get SIGKILL and their keepers' pipes
 * close (the job then ends them). On POSIX a signal that would end it without its 'exit' event
 * (Ctrl+C, the terminal closing, SIGTERM that nothing else handles) ends the groups first, then
 * takes its default action (installExitHooks). On Windows the keepers' pipes close however
 * Magnusim ends, so the jobs end their trees.
 *
 * A start that is stopped (its signal) while it makes the working folder or (Windows) waits for
 * the keeper starts nothing; on Windows the trampoline gets no `go` once it is stopped, so the
 * agent never runs.
 *
 * The polite-then-forceful order and the group signalled after its leader ended come from
 * SolidCraft's agent chat (process.rs, MIT/Apache-2.0); the code is our own.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, readlink, realpath } from 'node:fs/promises';
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
import { cleanText } from '../sanitize.ts';
import { keeperLooksBlocked, noteKeeperOutcome, takeKeeper, warmKeeper, type JobKeeper } from './job-win.ts';
import type { ExitInfo } from './rpc.ts';
import { agentNode, NEEDS_NODE_CODE, needsNodeText } from './node.ts';

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
/** How often a stop looks whether the agent's process group has emptied (POSIX). */
const GROUP_POLL_MS = 25;

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
  /** The boot it started in (bootId()), or null if unknown. */
  boot?: string | null;
  /** The agent's private working folder (its real path), or null. */
  cwd?: string | null;
  /** The Magnusim process that started it, and its start time. */
  owner: { pid: number; start: string | null };
  label: string;
  at: string;
}

export function pidsFile(): string {
  return join(assistantDataDir(), 'agents', 'pids.json');
}

interface LinuxStat {
  state: string;
  pgrp: number;
  /** Clock ticks since boot. */
  start: number;
}

/** Linux: a process's state, process group and start time from /proc/<pid>/stat (null: gone). */
async function linuxStat(pid: number | string): Promise<LinuxStat | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // After the name (which may hold spaces and parentheses): field 3 (the state) is rest[0],
  // field 5 (the process group) rest[2], field 22 (the start time) rest[19].
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const pgrp = Number(rest[2]);
  const start = Number(rest[19]);
  if (!rest[0] || !Number.isInteger(pgrp) || !Number.isFinite(start)) return null;
  return { state: rest[0], pgrp, start };
}

/** A program's output (null: it failed or took over 2 s). An async process: never spawnSync. */
function outputOf(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
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
      done(out);
    });
  });
}

/** A process's start time as this OS can tell it (null: unknown or gone). Never spawnSync. */
export async function processStart(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    const s = await linuxStat(pid);
    return s && s.state !== 'Z' ? `linux:${s.start}` : null;
  }
  if (process.platform === 'win32') return null;
  const out = (await outputOf('ps', ['-o', 'lstart=', '-p', String(pid)]))?.trim();
  return out ? `ps:${out}` : null;
}

let bootPromise: Promise<string | null> | null = null;

/**
 * This boot (null: unknown): Linux's boot_id, macOS's boot time. Start times count from the
 * boot, and nothing a record of another boot names still runs.
 */
export function bootId(): Promise<string | null> {
  if (!bootPromise) {
    bootPromise = (async () => {
      if (process.platform === 'linux') {
        const id = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim();
        return id ? `linux:${id}` : null;
      }
      if (process.platform === 'darwin') {
        const m = /\bsec\s*=\s*(\d+)/.exec((await outputOf('/usr/sbin/sysctl', ['-n', 'kern.boottime'])) ?? '');
        return m ? `darwin:${m[1]}` : null;
      }
      return null;
    })();
  }
  return bootPromise;
}

interface GroupMember {
  pid: number;
  /** Clock ticks since boot. */
  start: number;
  /** Its working folder (null: unreadable). */
  cwd: string | null;
}

/** Linux: the live members of process group `pgid` this account can see. */
async function groupMembers(pgid: number): Promise<GroupMember[]> {
  let names: string[];
  try {
    names = (await readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  const out: GroupMember[] = [];
  for (let i = 0; i < names.length; i += 64) {
    const batch = await Promise.all(
      names.slice(i, i + 64).map(async (name): Promise<GroupMember | null> => {
        const s = await linuxStat(name);
        if (!s || s.pgrp !== pgid || s.state === 'Z') return null;
        // A folder removed since reads as '<path> (deleted)'.
        const cwd = await readlink(`/proc/${name}/cwd`).then(
          (p) => p.replace(/ \(deleted\)$/, ''),
          () => null,
        );
        return { pid: Number(name), start: s.start, cwd };
      }),
    );
    for (const m of batch) if (m) out.push(m);
  }
  return out;
}

/**
 * Whether the group a record names is still that agent's group, on proof only:
 * - its leader lives and has the recorded start time (spec 4.11; a reused leader id has
 *   another);
 * - Linux, the same boot, the leader ended (its helpers outlive it): a live member works in the
 *   agent's own private working folder, and none started before the recorded leader. A group
 *   id can't be taken while a member of the old group lives, but a stale record may name an
 *   unrelated group that took the id later; nothing of that group works in the agent's folder.
 * Everything else is left alone: elsewhere a group whose leader ended can't be told apart.
 * The caller has dropped records of another boot.
 */
async function provablyOurs(g: GroupRecord, boot: string | null): Promise<boolean> {
  if (g.start == null) return false;
  const leader = await processStart(g.pgid);
  if (leader != null) return leader === g.start;
  if (process.platform !== 'linux' || boot == null || !g.cwd || !g.start.startsWith('linux:')) return false;
  const since = Number(g.start.slice('linux:'.length));
  if (!Number.isFinite(since)) return false;
  const members = await groupMembers(g.pgid);
  const folder = g.cwd;
  return members.length > 0 && members.every((m) => m.start >= since) && members.some((m) => m.cwd != null && inside(folder, m.cwd));
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
 * POSIX: SIGKILL every agent group a Magnusim that is no longer running left behind, when it is
 * provably still that agent's group (provablyOurs). Records of this Magnusim (the same pid and
 * start time) and of another one still running on this account are kept; every other record
 * goes, signalled or not. Returns the groups signalled.
 */
export async function sweepAgentGroups(): Promise<number[]> {
  if (WIN) return [];
  const groups = await readGroups();
  if (!groups.length) return [];
  const [boot, ownStart] = await Promise.all([bootId(), processStart(process.pid)]);
  const signalled: number[] = [];
  const owners = new Map<string, boolean>();
  const ownerAlive = async (o: GroupRecord['owner']): Promise<boolean> => {
    const key = `${o?.pid}:${o?.start}`;
    if (!owners.has(key)) owners.set(key, !!o && o.pid !== process.pid && o.start != null && (await processStart(o.pid)) === o.start);
    return owners.get(key) as boolean;
  };
  const keep: GroupRecord[] = [];
  for (const g of groups) {
    // Of another boot (or not saying, where the boot is known): every process it names is gone.
    if (boot != null && g.boot !== boot) continue;
    // This Magnusim's own only with its start time too: a crashed run may have had this pid.
    if ((g.owner?.pid === process.pid && g.owner.start === ownStart) || (await ownerAlive(g.owner))) {
      keep.push(g);
      continue;
    }
    if (!(await provablyOurs(g, boot))) continue;
    try {
      process.kill(-g.pgid, 'SIGKILL');
      signalled.push(g.pgid);
    } catch {
      /* gone meanwhile */
    }
  }
  const id = (g: GroupRecord) => `${g.pgid}|${g.owner?.pid}|${g.owner?.start}|${g.start}`;
  const handled = new Set(groups.filter((g) => !keep.includes(g)).map(id));
  await changeGroups((now) => now.filter((g) => !handled.has(id(g))));
  if (signalled.length) alog('info', 'agent groups left by an earlier run were stopped', { groups: signalled.length });
  return signalled;
}

let groupSweep: Promise<unknown> | null = null;
const sweptTmp = new Set<string>();

/**
 * Before an agent starts: once per process the groups an earlier run left (POSIX), and once
 * per temp folder its old working folders, after the groups (a crashed run's folder is the
 * proof that its group is an agent's).
 */
function sweepBeforeStart(tmp: string): Promise<unknown> {
  if (!groupSweep) groupSweep = sweepAgentGroups().catch((err) => alog('warn', 'the agent group sweep failed', { error: String((err as Error)?.message || err).slice(0, 200) }));
  if (!sweptTmp.has(tmp)) {
    sweptTmp.add(tmp);
    void groupSweep.then(() => sweepAgentWorkdirs({ tmp })).catch(() => 0);
  }
  return groupSweep;
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
  /** Tests: where the working folder goes, and where old ones are swept (os.tmpdir() otherwise). */
  tmp?: string;
  /** Tests: shorter grace periods. */
  graceMs?: number;
  /** Tests (Windows): runs after the spawn and before the job assignment. */
  beforeAssign?: (pid: number) => Promise<void>;
}

const live = new Set<AgentProcess>();
/** POSIX: groups spawned whose start hasn't finished (no AgentProcess yet): they go at exit too. */
const spawning = new Set<number>();
let exitHooks = false;

/** POSIX: the signals that end Magnusim from a terminal or a service manager. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGHUP', 'SIGTERM'];
/**
 * Marks the stop-signal listener of each copy of this module (a Vite restart loads the server's
 * modules again, and each copy ends its own agents), so no copy takes another's listener for a
 * handler that decides what the signal does.
 */
const STOP_HOOK = Symbol.for('magnusim.assistant.agentStopSignal');

/**
 * Once per process, before its first agent is spawned: the agents go with this process. A
 * normal exit runs the 'exit' hook. On POSIX Node emits no 'exit' when a signal ends it, and
 * each agent leads its own session (the terminal's signals never reach it), so Ctrl+C (SIGINT),
 * the terminal closing (SIGHUP) and SIGTERM end the groups first, then take their default
 * action (onStopSignal). On Windows nothing more is needed: the keepers' pipes close however
 * this process ends, and each job then ends its tree.
 */
function installExitHooks(): void {
  if (exitHooks) return;
  exitHooks = true;
  process.once('exit', onProcessExit);
  if (WIN) return;
  // First in line, so it still sees the other handlers of the signal (Vite's SIGTERM handler
  // is a `once`: it is gone by the time a later listener runs).
  for (const sig of STOP_SIGNALS) process.prependListener(sig, onStopSignal);
}

/**
 * A stop signal (POSIX). When another handler has it too, that one decides (Vite's SIGTERM
 * closes the server and exits; the 'exit' hook then ends the groups). Otherwise the signal would
 * end Node without its 'exit' event: the groups go now, synchronously, and the signal is raised
 * again, which ends this process as it would have (the shell sees the same status) once no copy
 * of this listener is left.
 */
function onStopSignal(sig: NodeJS.Signals): void {
  if (process.listeners(sig).some((l) => !(l as { [STOP_HOOK]?: boolean })[STOP_HOOK])) return;
  onProcessExit();
  for (const s of STOP_SIGNALS) process.removeListener(s, onStopSignal);
  process.kill(process.pid, sig);
}
(onStopSignal as unknown as { [STOP_HOOK]: boolean })[STOP_HOOK] = true;

function onProcessExit(): void {
  const ended = new Set<number>();
  for (const a of live) {
    a.dropAtExit();
    ended.add(a.pid);
  }
  for (const pgid of spawning) {
    killGroup(pgid, 'SIGKILL');
    ended.add(pgid);
  }
  if (!WIN && ended.size) dropRecordsAtExit(ended);
}

/** POSIX: signals process group `pgid` (gone: nothing). */
function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* the group is gone */
  }
}

/**
 * At this process's exit (synchronous only): its records of the groups it has just ended go
 * too, so only a crash leaves records for the next start's sweep.
 */
function dropRecordsAtExit(pgids: Set<number>): void {
  const file = pidsFile();
  try {
    const groups = (JSON.parse(readFileSync(file, 'utf8')) as { groups?: unknown })?.groups;
    if (!Array.isArray(groups)) return;
    const left = groups.filter((g: GroupRecord) => !(g && g.owner?.pid === process.pid && pgids.has(g.pgid)));
    if (left.length === groups.length) return;
    const tmp = `${file}.${process.pid}.exit.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, groups: left }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* the next start's sweep sees the groups gone */
  }
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
    installExitHooks();
    live.add(this);
  }

  /** The agent's last stderr lines (at most 40 of 400 characters), redacted and cleaned. */
  tail(): string[] {
    const out = [...this.ring];
    const last = stderrLine(this.partial);
    if (last) out.push(last);
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
    if (!WIN) killGroup(this.pid, 'SIGKILL');
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
        await this.waitExit(this.graceMs);
        // The group, helpers included, gets its grace after SIGTERM even when the leader ended.
        this.signalGroup('SIGTERM');
        if (!(await this.waitGroupGone(this.graceMs))) this.signalGroup('SIGKILL');
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

  /** POSIX: whether the agent's process group emptied within `ms` (looked at every 25 ms). */
  private async waitGroupGone(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (groupExists(this.pid)) {
      if (Date.now() >= end) return false;
      await new Promise((done) => setTimeout(done, GROUP_POLL_MS));
    }
    return true;
  }

  private signalGroup(signal: NodeJS.Signals): void {
    // Even when the leader ended: its helpers outlive it, and the group id stays theirs while
    // any of them lives.
    killGroup(this.pid, signal);
  }

  private feedStderr(d: string): void {
    this.partial += d;
    let nl: number;
    while ((nl = this.partial.indexOf('\n')) >= 0) {
      const line = stderrLine(this.partial.slice(0, nl));
      this.partial = this.partial.slice(nl + 1);
      if (!line) continue;
      this.ring.push(line);
      if (this.ring.length > STDERR_LINES) this.ring.shift();
    }
    // A line that never ends is kept to its cap only.
    if (this.partial.length > STDERR_LINE_CHARS * 4) this.partial = this.partial.slice(0, STDERR_LINE_CHARS * 4);
  }

  private flushStderr(): void {
    const line = stderrLine(this.partial);
    if (line) {
      this.ring.push(line);
      if (this.ring.length > STDERR_LINES) this.ring.shift();
    }
    this.partial = '';
  }
}

/**
 * One stderr line as kept: redacted, then cleaned (no control characters, terminal escapes'
 * ESC or bidi marks, single spaces), at most 400 characters ('' for nothing left).
 */
function stderrLine(raw: string): string {
  return cleanText(redact(raw), STDERR_LINE_CHARS);
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

/** Waits for the child's exit, at most `ms` (at once when it was never spawned or has exited). */
function waitChild(exit: ExitWatch | null, ms: number): Promise<void> {
  if (!exit || exit.info()) return Promise.resolve();
  return new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    void exit.promise.then(() => {
      clearTimeout(timer);
      done();
    });
  });
}

/**
 * Starts the agent, contained (spec 4.4, 4.11). On Windows the job assignment completes before
 * this resolves, so nothing the agent starts can escape it; `initialize` may be sent at once.
 * `signal` stops the start: before the spawn nothing is started (the working folder goes, and
 * the keeper); on Windows the trampoline then gets no `go`; after it the agent is stopped
 * before this rejects. Either way nothing of it runs once this has rejected.
 */
export async function startAgentProcess(o: StartAgentOptions): Promise<AgentProcess> {
  const argv = [...o.argv];
  if (!argv.length || !argv[0]) throw new AgentStartError('bad_command', 'no agent command');
  const label = o.label ?? 'agent';
  const graceMs = o.graceMs ?? AGENT_GRACE_MS;
  /** Stopped meanwhile (Stop, the switch going off, a lifetime's end): nothing more starts. */
  const halt = (): void => {
    if (o.signal?.aborted) throw o.signal.reason ?? new Error('aborted');
  };
  installExitHooks();
  await sweepBeforeStart(o.tmp ?? tmpdir());
  halt();
  const cwd = await makeAgentWorkdir({ tmp: o.tmp });
  let child: ChildProcess | null = null;
  let exit: ExitWatch | null = null;
  let keeper: JobKeeper | null = null;
  let treeKill: TreeKill = WIN ? 'job' : 'group';
  try {
    const env = agentEnv(o.env, o.baseEnv ?? process.env);
    const base = { cwd, env, windowsHide: true, shell: false } as const;
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
      // Stopped while the folder was made or the keeper got ready: nothing is spawned.
      halt();
      if (keeper) {
        const before = Date.now();
        // The launcher is a Node script: Magnusim's Node, or in the desktop app Node.js from PATH.
        const node = agentNode();
        if (!node) throw new AgentStartError(NEEDS_NODE_CODE, needsNodeText());
        child = spawn(node, [LAUNCH_SCRIPT, ...argv], { ...base, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        const after = Date.now();
        exit = watchExit(child);
        await spawned(child);
        try {
          await o.beforeAssign?.(child.pid as number);
          await keeper.assign(child.pid as number, before, after);
          noteKeeperOutcome(true);
          // The job works here: the next start (a turn's, a Test's, a probe's) finds a keeper
          // warmed ahead (spec 4.11, step 1). One that fails says so in the status at once.
          if (!o.keeper) warmKeeper();
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
        // Stopped while it was put in the job: no `go`, so the trampoline ends without ever
        // starting the agent.
        if (o.signal?.aborted) control.end();
        halt();
        control.end('go\n');
      } else {
        child = spawn(argv[0], argv.slice(1), { ...base, stdio: ['pipe', 'pipe', 'pipe'] });
        exit = watchExit(child);
        await spawned(child);
      }
    } else {
      // Stopped while the folder was made: nothing is spawned.
      halt();
      child = spawn(argv[0], argv.slice(1), { ...base, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      if (child.pid) spawning.add(child.pid);
      exit = watchExit(child);
      await spawned(child);
      const pid = child.pid as number;
      const [start, ownerStart, boot, folder] = await Promise.all([processStart(pid), processStart(process.pid), bootId(), real(cwd)]);
      await changeGroups((groups) => [
        ...groups.filter((g) => g.pgid !== pid),
        { pgid: pid, start, boot, cwd: folder, owner: { pid: process.pid, start: ownerStart }, label, at: new Date().toISOString() },
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
      // Ended before the start says so: nothing of it runs once it has failed.
      await waitChild(exit, graceMs);
      spawning.delete(child.pid);
    }
    await removeTree(cwd).catch(() => {});
    const code = String((err as NodeJS.ErrnoException)?.code || '');
    if (code === 'ENOENT') throw new AgentStartError('agent_missing', `${argv[0]} was not found`);
    if (code === 'EACCES' || code === 'EPERM') throw new AgentStartError('cant_start', `${argv[0]} could not be started (${code})`);
    throw err;
  }
  const proc = new AgentProcess({ label, child, exit: exit as ExitWatch, cwd, treeKill, keeper, graceMs });
  spawning.delete(proc.pid);
  alog('info', 'agent started', { agent: label, pid: proc.pid, tree_kill: treeKill });
  if (o.signal?.aborted) {
    // Stopped once it ran: it is stopped (the tree kill) before the start says so.
    await proc.stop('aborted');
    throw o.signal.reason ?? new Error('aborted');
  }
  return proc;
}

/** Stops every live agent process (tests; the agent host's own shutdown). */
export async function stopAllAgentProcesses(why = 'shutdown'): Promise<void> {
  await Promise.all([...live].map((a) => a.stop(why)));
}
