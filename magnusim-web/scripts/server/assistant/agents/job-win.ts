/**
 * The Windows job keeper (phase 3 spec 4.11): a job object for one coding agent, so the agent
 * and everything it starts stop together, even when Magnusim itself is killed.
 *
 * Node has no job objects, so a fixed script runs in Windows PowerShell 5.1 (by its absolute
 * path, as -EncodedCommand, as assistant/secrets/dpapi.ts does). It checks for full language
 * mode (exit 4 = blocked), declares a few kernel32 calls with Add-Type, creates a job with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000) and no breakaway, answers `ready`, then reads
 * one command per line on stdin:
 *   assign <pid> <not before ms> <not after ms>  -> ok | err <text>
 *   kill                                         -> killed   (TerminateJobObject)
 * `assign` opens the process and compares its creation time (GetProcessTimes, as ms since 1970)
 * with the window Node measured around the spawn (Node can't read a process's creation time),
 * so a reused process id never puts an unrelated process in the job.
 *
 * When its stdin ends it exits; its job handle then closes and KILL_ON_JOB_CLOSE ends every
 * process still in the job. Magnusim holds the other end of that pipe, so the agent tree dies
 * with Magnusim, however Magnusim ends.
 *
 * Always an async spawn, never spawnSync. Start-up takes 1-3 s (Add-Type compiles), so a keeper
 * is warmed ahead: each agent start whose keeper got ready warms the next one (warmKeeper, from
 * process.ts), which then waits without holding Node's event loop open (hold()), and the next
 * start (a turn's, a Test's or a discovery probe's) takes it (takeKeeper). There is one per
 * process, whichever copy of this module (a Vite restart loads it again) warmed it, and it ends
 * when the Assistant shuts down. A keeper that is
 * blocked or gives no `ready` in 20 s counts as blocked: the agent then runs without a job, and
 * its tree kill is best effort (taskkill /T).
 * MAGNUSIM_TEST_ASSISTANT_JOB=blocked makes every keeper count as blocked (tests; honoured only
 * with MAGNUSIM_TEST_ASSISTANT=1 in a test home, otherwise ignored with a log line).
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { redact } from '../redact.ts';
import { alog } from '../log.ts';
import { assistantHomeIsOverridden } from '../home.ts';
import { assistantState, onAssistantShutdown } from '../state.ts';
import { powershellPath } from '../secrets/dpapi.ts';

/** The keeper. Exit 4: not in full language mode (blocked). */
export const JOB_KEEPER_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `$ProgressPreference = 'SilentlyContinue'`,
  `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { [Console]::Error.WriteLine('blocked: PowerShell language mode is ' + $ExecutionContext.SessionState.LanguageMode); exit 4 }`,
  `try {`,
  `Add-Type -TypeDefinition @'`,
  `using System;`,
  `using System.Runtime.InteropServices;`,
  `public static class MagnusimAgentJob {`,
  `  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A; public long B; public uint LimitFlags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }`,
  `  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }`,
  `  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr A; public UIntPtr B; public UIntPtr C; public UIntPtr D; }`,
  `  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);`,
  `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);`,
  `  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);`,
  `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);`,
  `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);`,
  `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);`,
  `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);`,
  `  static IntPtr job = IntPtr.Zero;`,
  `  public static void Create() {`,
  `    job = CreateJobObjectW(IntPtr.Zero, null);`,
  `    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());`,
  `    Extended info = new Extended();`,
  `    info.Basic.LimitFlags = 0x2000;`,
  `    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());`,
  `  }`,
  `  public static string Assign(uint pid, long notBefore, long notAfter) {`,
  `    IntPtr p = OpenProcess(0x0001 | 0x0100 | 0x1000, false, pid);`,
  `    if (p == IntPtr.Zero) return "err open " + Marshal.GetLastWin32Error();`,
  `    try {`,
  `      long c, e, k, u;`,
  `      if (!GetProcessTimes(p, out c, out e, out k, out u)) return "err times " + Marshal.GetLastWin32Error();`,
  `      long ms = (c - 116444736000000000L) / 10000L;`,
  `      if (ms < notBefore || ms > notAfter) return "err created at " + ms + ", not in " + notBefore + ".." + notAfter;`,
  `      if (!AssignProcessToJobObject(job, p)) return "err assign " + Marshal.GetLastWin32Error();`,
  `      return "ok";`,
  `    } finally { CloseHandle(p); }`,
  `  }`,
  `  public static void Kill() { TerminateJobObject(job, 1); }`,
  `}`,
  `'@`,
  `[MagnusimAgentJob]::Create()`,
  `[Console]::Out.WriteLine('ready')`,
  `while ($true) {`,
  `  $line = [Console]::In.ReadLine()`,
  `  if ($line -eq $null) { break }`,
  `  $parts = $line.Trim().Split(' ')`,
  `  if ($parts[0] -eq 'assign' -and $parts.Length -eq 4) { [Console]::Out.WriteLine([MagnusimAgentJob]::Assign([uint32]$parts[1], [int64]$parts[2], [int64]$parts[3])) }`,
  `  elseif ($parts[0] -eq 'kill') { [MagnusimAgentJob]::Kill(); [Console]::Out.WriteLine('killed') }`,
  `  else { [Console]::Out.WriteLine('err unknown command') }`,
  `}`,
  `} catch {`,
  `  [Console]::Error.WriteLine($_.Exception.Message)`,
  `  exit 1`,
  `}`,
  `exit 0`,
].join('\n');

/** -EncodedCommand takes UTF-16LE in base64. A constant: it holds no secret. */
export const JOB_KEEPER_B64 = Buffer.from(JOB_KEEPER_SCRIPT, 'utf16le').toString('base64');

export const JOB_KEEPER_ARGS: readonly string[] = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  JOB_KEEPER_B64,
]);

/** How long a keeper may take to answer `ready` (and any later command). */
export const JOB_KEEPER_TIMEOUT_MS = 20_000;
/** Slack around the creation-time window (Windows' clock ticks at about 16 ms). */
const CREATION_SLACK_MS = 1_000;
const BLOCKED_TEXT = /language mode|blocked by (group policy|your system administrator)|has been blocked|applocker|device guard|application control/i;

export type KeeperState = 'starting' | 'ready' | 'blocked' | 'closed';

export class KeeperError extends Error {
  readonly code: 'blocked' | 'timeout' | 'failed' | 'closed';
  constructor(code: 'blocked' | 'timeout' | 'failed' | 'closed', message: string) {
    super(message);
    this.name = 'KeeperError';
    this.code = code;
  }
}

export type SpawnLike = typeof nodeSpawn;

export interface KeeperOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Tests: a spy around child_process.spawn. */
  spawnImpl?: SpawnLike;
}

/**
 * MAGNUSIM_TEST_ASSISTANT_JOB=blocked: every keeper counts as blocked. Honoured only with
 * MAGNUSIM_TEST_ASSISTANT=1 in a test home; `ignored` says why it wasn't.
 */
export function jobTestSwitch(env: NodeJS.ProcessEnv = process.env): { blocked: boolean; ignored: string | null } {
  const raw = String(env.MAGNUSIM_TEST_ASSISTANT_JOB ?? '').trim();
  if (!raw) return { blocked: false, ignored: null };
  if (env.MAGNUSIM_TEST_ASSISTANT !== '1') return { blocked: false, ignored: 'MAGNUSIM_TEST_ASSISTANT_JOB is ignored without MAGNUSIM_TEST_ASSISTANT=1' };
  if (!assistantHomeIsOverridden({ env })) {
    return { blocked: false, ignored: 'MAGNUSIM_TEST_ASSISTANT_JOB is ignored outside a test home (MAGNUSIM_ASSISTANT_HOME or MAGNUSIM_LOCAL_JSON)' };
  }
  if (raw !== 'blocked') return { blocked: false, ignored: 'MAGNUSIM_TEST_ASSISTANT_JOB has an unknown value and is ignored' };
  return { blocked: true, ignored: null };
}

let reportedSwitch = '';

/**
 * The keeper warmed ahead and what the last keeper said about this PC, one of each per process
 * (on globalThis, as state.ts keeps the Assistant's state): a Vite restart loads this module
 * again, and the turns stay on the first copy while Tests and probes move to the new one. Every
 * copy takes the one warmed keeper and none warms a second while it waits, so a copy nothing
 * reaches any more never leaves one running.
 */
interface WarmSlot {
  keeper: JobKeeper | null;
  /** Unregisters its drop at the Assistant's shutdown. */
  off: (() => void) | null;
  lastOutcome: 'ok' | 'failed' | null;
}
const WARM = Symbol.for('magnusim.assistant.agents.keeper');

function slot(): WarmSlot {
  const g = globalThis as unknown as Record<symbol, WarmSlot | undefined>;
  let w = g[WARM];
  if (!w) {
    w = { keeper: null, off: null, lastOutcome: null };
    g[WARM] = w;
  }
  return w;
}

/** The last keeper (or job assignment) worked or failed: what agentsTreeKill() reports. */
export function noteKeeperOutcome(ok: boolean): void {
  slot().lastOutcome = ok ? 'ok' : 'failed';
}

/** Whether the tree kill is best effort on this PC: the test switch, or the last keeper failed. */
export function keeperLooksBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return jobTestSwitch(env).blocked || slot().lastOutcome === 'failed';
}

/** One job object for one agent, kept by a PowerShell process. */
export class JobKeeper {
  state: KeeperState = 'starting';
  readonly pid: number | null;
  private readonly child: ChildProcess | null;
  private readonly timeoutMs: number;
  private buf = '';
  private stderr = '';
  private waiters: Array<{ resolve: (line: string) => void; reject: (e: KeeperError) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private failure: KeeperError | null = null;
  private closedByUs = false;
  /** Whether it keeps Node's event loop open (a warmed keeper waiting to be taken doesn't). */
  private held = true;
  /** Resolves when the keeper answered `ready`; rejects with a KeeperError (blocked, timeout, failed). */
  readonly ready: Promise<void>;
  /** Resolves when the keeper process has ended. */
  readonly ended: Promise<void>;

  private constructor(o: KeeperOptions) {
    this.timeoutMs = o.timeoutMs ?? JOB_KEEPER_TIMEOUT_MS;
    const sw = jobTestSwitch(o.env ?? process.env);
    if (sw.ignored && sw.ignored !== reportedSwitch) {
      reportedSwitch = sw.ignored;
      alog('warn', sw.ignored);
    }
    if (sw.blocked) {
      this.child = null;
      this.pid = null;
      this.state = 'blocked';
      this.failure = new KeeperError('blocked', 'the test switch blocks the job keeper');
      this.ready = Promise.reject(this.failure);
      this.ready.catch(() => {});
      this.ended = Promise.resolve();
      return;
    }
    const spawnImpl = o.spawnImpl ?? nodeSpawn;
    let child: ChildProcess | null = null;
    let startError: KeeperError | null = null;
    try {
      child = spawnImpl(powershellPath(o.env ?? process.env), [...JOB_KEEPER_ARGS], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      startError = new KeeperError('blocked', redact(String((err as { code?: string })?.code || (err as Error)?.message || err)));
    }
    this.child = child;
    this.pid = child?.pid ?? null;
    this.ended = child ? new Promise<void>((resolve) => child.once('close', () => resolve())) : Promise.resolve();
    this.ready = startError ? Promise.reject(startError) : this.next(this.timeoutMs).then((line) => {
      if (line !== 'ready') throw new KeeperError('failed', `the keeper answered ${line.slice(0, 80)}`);
      this.state = 'ready';
      noteKeeperOutcome(true);
    });
    this.ready.catch((e: KeeperError) => {
      // A keeper Magnusim closed itself before it was ready says nothing about this PC.
      if (!this.closedByUs) noteKeeperOutcome(false);
      this.fail(e);
    });
    if (!child) return;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => this.feed(d));
    child.stderr?.on('data', (d: string) => {
      if (this.stderr.length < 8192) this.stderr += d.slice(0, 8192 - this.stderr.length);
    });
    child.stdin?.on('error', () => {
      /* the keeper ended; its exit says why */
    });
    child.on('error', (err: NodeJS.ErrnoException) => this.fail(new KeeperError('blocked', redact(err.code || err.message))));
    child.on('close', (code: number | null) => {
      const plain = this.stderr.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#< CLIXML') && !l.startsWith('<Objs'));
      const first = redact(plain || '').slice(0, 300);
      if (this.state === 'starting' && (code === 4 || BLOCKED_TEXT.test(this.stderr))) this.fail(new KeeperError('blocked', first || 'blocked'));
      else this.fail(new KeeperError('closed', first || `the keeper ended (exit code ${code})`));
    });
  }

  /** Starts a keeper (it is ready once `ready` resolves). */
  static start(o: KeeperOptions = {}): JobKeeper {
    return new JobKeeper(o);
  }

  /**
   * Puts the process `pid` in the job, when it was created between `notBefore` and `notAfter`
   * (ms since 1970, measured around its spawn). Rejects with a KeeperError otherwise.
   */
  async assign(pid: number, notBefore: number, notAfter: number): Promise<void> {
    await this.ready;
    const line = await this.command(`assign ${pid} ${Math.floor(notBefore - CREATION_SLACK_MS)} ${Math.ceil(notAfter + CREATION_SLACK_MS)}`);
    if (line !== 'ok') throw new KeeperError('failed', line.replace(/^err\s*/, '').slice(0, 200));
  }

  /** Ends every process in the job (TerminateJobObject). */
  async kill(): Promise<void> {
    await this.ready;
    const line = await this.command('kill');
    if (line !== 'killed') throw new KeeperError('failed', line.slice(0, 200));
  }

  /**
   * Whether this keeper keeps Node's event loop open: not while it waits, warmed, to be taken
   * (a process with nothing else to do may end meanwhile; its pipe then closes and the keeper
   * exits), again once an agent's start takes it.
   */
  hold(on: boolean): void {
    this.held = on;
    const child = this.child;
    // The process and its pipes (net sockets: ref and unref, which the stream types don't name).
    for (const h of [child, child?.stdin, child?.stdout, child?.stderr] as Array<{ ref?(): unknown; unref?(): unknown } | null | undefined>) {
      if (on) h?.ref?.();
      else h?.unref?.();
    }
    for (const w of this.waiters) {
      if (on) w.timer.ref();
      else w.timer.unref();
    }
  }

  /** Ends the keeper: its stdin closes, it exits, and KILL_ON_JOB_CLOSE ends what is still in the job. */
  close(): void {
    this.closedByUs = true;
    if (this.state !== 'blocked') this.state = 'closed';
    try {
      this.child?.stdin?.end();
    } catch {
      /* already gone */
    }
  }

  /** The failure that ended this keeper, if any. */
  get error(): KeeperError | null {
    return this.failure;
  }

  private command(text: string): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    const answer = this.next(this.timeoutMs);
    try {
      this.child?.stdin?.write(`${text}\n`);
    } catch {
      /* the close handler fails the waiter */
    }
    return answer;
  }

  private next(timeoutMs: number): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((w) => w.timer === timer);
        if (at >= 0) this.waiters.splice(at, 1);
        const e = new KeeperError('timeout', `no answer in ${Math.round(timeoutMs / 1000)} s`);
        reject(e);
        if (this.state === 'starting') this.fail(e);
      }, timeoutMs);
      if (!this.held) timer.unref();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private feed(d: string): void {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      const w = this.waiters.shift();
      if (!w) continue;
      clearTimeout(w.timer);
      w.resolve(line);
    }
  }

  private fail(e: KeeperError): void {
    if (!this.failure) this.failure = e;
    if (this.state === 'starting' && (e.code === 'blocked' || e.code === 'timeout')) this.state = 'blocked';
    else if (this.state !== 'blocked') this.state = 'closed';
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(this.failure);
    }
    if (e.code === 'timeout' || e.code === 'blocked') {
      try {
        this.child?.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/** The warmed keeper, out of the slot (its drop at the Assistant's shutdown unregistered). */
function unwarm(): JobKeeper | null {
  const w = slot();
  const k = w.keeper;
  w.keeper = null;
  w.off?.();
  w.off = null;
  return k;
}

/**
 * Starts a keeper ahead of the next agent start (process.ts calls it once a start's own keeper
 * got ready, so discovery's probes and every later start find one warming or ready). It waits
 * without holding Node's event loop open, and ends when the Assistant shuts down (each lifetime
 * registers its drop again, as shutdownAssistant clears its hooks). Once the Assistant has shut
 * down (a start on its way then), nothing is warmed.
 */
export function warmKeeper(o: KeeperOptions = {}): void {
  const w = slot();
  if (process.platform !== 'win32' || w.keeper || assistantState().shutDown) return;
  const k = JobKeeper.start(o);
  k.hold(false);
  w.keeper = k;
  w.off = onAssistantShutdown(() => {
    if (slot().keeper === k) dropWarmKeeper();
  });
}

/**
 * The warmed keeper (if any, not failed, and the test switch doesn't block keepers now), or a
 * new one. Each agent gets its own.
 */
export function takeKeeper(o: KeeperOptions = {}): JobKeeper {
  const w = unwarm();
  if (w && !w.error && !jobTestSwitch(o.env ?? process.env).blocked) {
    w.hold(true);
    return w;
  }
  w?.close();
  return JobKeeper.start(o);
}

/** Ends a warmed keeper nobody took (the Assistant's shutdown, tests). */
export function dropWarmKeeper(): void {
  unwarm()?.close();
}
