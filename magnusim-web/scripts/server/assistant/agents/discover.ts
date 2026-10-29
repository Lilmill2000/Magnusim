/**
 * Coding agents on this PC (phase 3 spec 4.3, 4.9, 5.4): where they are, how each starts
 * without a shell, whether Magnusim may switch its own tools off, whether it looks signed in,
 * and the allow switch's fingerprint. Discovery runs from GET /api/assistant/agents and, when
 * the cache is older than 5 minutes, from a turn's start (ensureAgents); never from the
 * status, which reads the cache only (agentsCache).
 *
 * Search folders: PATH; the npm prefix (%APPDATA%\npm, $NPM_CONFIG_PREFIX[/bin]);
 * ~/.npm-global/bin, ~/.local/bin, ~/.volta/bin, ~/.bun/bin, ~/.grok/bin; every
 * ~/.nvm/versions/node/<v>/bin, newest first; on POSIX /opt/homebrew/bin, /usr/local/bin and
 * /usr/bin; nvm-windows' %NVM_HOME%\<v> and %NVM_SYMLINK%; %LOCALAPPDATA%\Volta\bin. Absolute
 * paths only, without duplicates.
 *
 * Program lookup, in folder order: on Windows <name>.exe, <name>.cmd, <name>.bat (npm's bare
 * Unix shim is never started); on POSIX <name>, executable. Nothing ever runs through a shell:
 * a .cmd or .bat is resolved, never run.
 *   1. Through its npm package: <dir>/node_modules/<package>/package.json (on POSIX also
 *      <dir>/../lib/node_modules/<package> and, for a .bin folder, <dir>/../<package>), whose
 *      `bin` entry for the program gives a script inside the package (on POSIX the program
 *      must be a link to that very script).
 *   2. Otherwise (Windows) npm's cmd-shim line, "%dp0%\node_modules\...": a script inside
 *      <dir>/node_modules.
 *   3. A .js, .cjs or .mjs script, or one without an extension whose first line is a node
 *      #! line, starts as [Magnusim's node, script, ...args]; an .exe starts directly; on
 *      POSIX any other executable starts directly; anything else is cant_start_script.
 * The identity rule: a lockdown other than 'none' (catalogue `lockdown`) holds only when step
 * 1 succeeded with the catalogue's package: its name, a version at or above `checked.
 * minVersion`, and the script's real path inside the package's real path. Anything else (an
 * .exe of the program's name earlier in PATH, a shim parse, a package of another name or an
 * older version, a custom command whatever its name) is class 'none': the allow switch. The
 * rule protects against a program planted under an agent's name, not against a whole package
 * planted beside it in an earlier PATH folder that someone else can write to (a limit of the
 * rule, for SECURITY.md).
 *
 * Version: the catalogue's version arguments (`versionArgs`, in place of the ACP arguments)
 * through process.ts: a fresh private working folder, never Magnusim's own environment or
 * folder, and only the system's variables of the allowlist (a version needs no login, so no
 * key, login-folder or agent-prefix variable); stdin closed, the first 4 KB of stdout, at most
 * 3 s and then the tree kill; the first word starting with a digit (at most 40 characters). At
 * most 4 at once. Only a program discovery may start without a click is asked: a known agent's
 * own verified package, or one whose allow switch is on for that very program (fingerprint).
 * Anything else (a lookalike earlier in PATH, a shim to another package) is never started by
 * discovery, and custom commands are not asked (their Test is). Unchanged programs keep their
 * version between runs unless the person presses Refresh.
 *
 * Signed in: ONLY whether the login file exists ($<dirVar>/<fileInDir> when that variable is
 * set, else ~/<file>), by fs.stat: the file is never opened or read. With no file: 'key' when
 * one of its key variables is set, else 'unknown' when its login may live in a keyring, else
 * 'no'. With no known file: 'unknown'.
 *
 * Fingerprint (the allow switch, spec 4.9): sha256 of [kind, id, realpath(program), realpath
 * (script) or null, ...args], the paths lower-cased on Windows. The version is not in it, so an
 * update in place keeps the switch; a new path or command asks again.
 *
 * Test switches (honoured only with MAGNUSIM_TEST_ASSISTANT=1 in a test home, else ignored
 * with a log line): MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS (the search folders, exactly; a
 * path-delimiter list) and MAGNUSIM_TEST_ASSISTANT_AGENT_HOME (the home login files and the
 * home-relative folders are looked up in; probes' working folders go in its tmp folder). Under
 * the home switch the real environment's agent variables (every catalogue key, login-folder and
 * own-prefix variable) and XDG_CONFIG_HOME / XDG_DATA_HOME are not read, so the test home is the
 * only place looked at and no probe gets the person's keys.
 *
 * Search folders, the probe's limits and the version rule follow SolidCraft's agent chat
 * (discover.rs, MIT/Apache-2.0); the code is our own.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as FS } from 'node:fs';
import { access, mkdir, open, readdir, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { assistantHomeIsOverridden } from '../home.ts';
import { appVersion } from '../host-tools.ts';
import { alog } from '../log.ts';
import { cleanText } from '../sanitize.ts';
import {
  addCustomAgent,
  agentPrefs,
  CUSTOM_ARG_CHARS,
  CUSTOM_ARGV_MAX,
  CUSTOM_AGENTS_MAX,
  CUSTOM_NAME_MAX,
  customNameValid,
  isAgentOf,
  KEEP_ENV_MAX,
  KEEP_ENV_RE,
  loadSettings,
  removeCustomAgent,
  setAgentAllowed,
  type AssistantSettings,
  type CustomAgent,
} from '../settings.ts';
import { assistantState } from '../state.ts';
import { splitCommand, type ModelView, type ModeView } from './acp.ts';
import { KNOWN_AGENTS, knownAgent, policyOf, type KnownAgent, type Lockdown, type LoginSpec } from './known.ts';
import { startAgentProcess, type AgentEnvSpec, type AgentProcess } from './process.ts';
import { agentNode, NEEDS_NODE_CODE, NEEDS_NODE_TEXT, needsNodeText } from './node.ts';

/** A discovery older than this is run again at a turn's start. */
export const AGENT_CACHE_MS = 5 * 60_000;
/** The version probe's limit, after which it is tree-killed. */
export const PROBE_MS = 3_000;
export const PROBE_STDOUT_MAX = 4096;
export const PROBES_AT_ONCE = 4;
export const VERSION_MAX = 40;

const SHIM_MAX = 64 * 1024;
const PACKAGE_JSON_MAX = 1024 * 1024;
const OPENCODE_CONFIG_MAX = 256 * 1024;
const NODE_SCRIPT_EXT = new Set(['.js', '.cjs', '.mjs']);
const WIN_EXTS = ['.exe', '.cmd', '.bat'];

export const CANT_START_TEXT = (file: string) =>
  `Magnusim starts agents without a command shell, so it can't start ${file}. Point it at the program itself (an .exe, or node and a .js file).`;

// ---------------------------------------------------------------------------------------------
// Test switches
// ---------------------------------------------------------------------------------------------

export interface AgentTestSwitches {
  /** The search folders, exactly (null: the real ones). */
  paths: string[] | null;
  /** The home folder (null: the real one). */
  home: string | null;
  /** Why a switch that was set is ignored. */
  ignored: string[];
}

const reported = new Set<string>();

/** MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS and _AGENT_HOME, honoured only with MAGNUSIM_TEST_ASSISTANT=1 in a test home. */
export function agentTestSwitches(env: NodeJS.ProcessEnv = process.env): AgentTestSwitches {
  const rawPaths = String(env.MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS ?? '').trim();
  const rawHome = String(env.MAGNUSIM_TEST_ASSISTANT_AGENT_HOME ?? '').trim();
  const out: AgentTestSwitches = { paths: null, home: null, ignored: [] };
  if (!rawPaths && !rawHome) return out;
  const set = [rawPaths ? 'MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS' : null, rawHome ? 'MAGNUSIM_TEST_ASSISTANT_AGENT_HOME' : null].filter(Boolean);
  if (env.MAGNUSIM_TEST_ASSISTANT !== '1') {
    for (const name of set) out.ignored.push(`${name} is ignored without MAGNUSIM_TEST_ASSISTANT=1`);
    return out;
  }
  if (!assistantHomeIsOverridden({ env })) {
    for (const name of set) out.ignored.push(`${name} is ignored outside a test home (MAGNUSIM_ASSISTANT_HOME or MAGNUSIM_LOCAL_JSON)`);
    return out;
  }
  if (rawPaths) {
    out.paths = [];
    for (const p of rawPaths.split(delimiter)) {
      const d = p.trim();
      if (d && isAbsolute(d) && !out.paths.includes(resolve(d))) out.paths.push(resolve(d));
    }
  }
  if (rawHome) {
    if (isAbsolute(rawHome)) out.home = resolve(rawHome);
    else out.ignored.push('MAGNUSIM_TEST_ASSISTANT_AGENT_HOME is ignored: it is not an absolute path');
  }
  return out;
}

function reportIgnored(sw: AgentTestSwitches): void {
  for (const text of sw.ignored) {
    if (reported.has(text)) continue;
    reported.add(text);
    alog('warn', text);
  }
}

// ---------------------------------------------------------------------------------------------
// Search folders
// ---------------------------------------------------------------------------------------------

export interface FolderOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** Version folder names (v22.12.0, 22.12.0), newest first; others last, by name. */
function newestFirst(names: string[]): string[] {
  const key = (n: string) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(n) ?? []).slice(1).map(Number);
  return [...names].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka.length && kb.length) {
      for (let i = 0; i < 3; i += 1) if (ka[i] !== kb[i]) return kb[i] - ka[i];
      return 0;
    }
    if (ka.length !== kb.length) return kb.length - ka.length;
    return a.localeCompare(b);
  });
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** The folders discovery searches, in order (spec 4.3). */
export async function searchFolders(o: FolderOptions = {}): Promise<string[]> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const win = platform === 'win32';
  const P = win ? win32 : posix;
  const home = o.home ?? homedir();
  const isAbs = (p: string) => (win ? /^[A-Za-z]:[\\/]|^\\\\/.test(p) : p.startsWith('/'));
  const get = (name: string) => {
    const v = env[name];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const list: string[] = [];
  const add = (p: string | null) => {
    if (p && isAbs(p)) list.push(p);
  };
  const pathValue = win ? (Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '') : (env.PATH ?? '');
  for (const p of String(pathValue).split(win ? ';' : ':')) add(p.trim().replace(/^"(.*)"$/, '$1'));
  const appData = get('APPDATA');
  const prefix = get('NPM_CONFIG_PREFIX') ?? get('npm_config_prefix');
  if (win) {
    if (appData) add(P.join(appData, 'npm'));
    if (prefix) add(prefix);
  } else if (prefix) {
    add(P.join(prefix, 'bin'));
  }
  for (const rel of ['.npm-global/bin', '.local/bin', '.volta/bin', '.bun/bin', '.grok/bin']) add(P.join(home, ...rel.split('/')));
  const nvm = P.join(home, '.nvm', 'versions', 'node');
  for (const v of newestFirst(await subfolders(nvm))) add(P.join(nvm, v, 'bin'));
  if (!win) for (const p of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) add(p);
  if (win) {
    const nvmHome = get('NVM_HOME');
    if (nvmHome) for (const v of newestFirst(await subfolders(nvmHome))) add(P.join(nvmHome, v));
    add(get('NVM_SYMLINK'));
    const local = get('LOCALAPPDATA');
    if (local) add(P.join(local, 'Volta', 'bin'));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    const k = win ? p.replace(/[\\/]+$/, '').toLowerCase() : p.replace(/\/+$/, '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Finding and resolving a program
// ---------------------------------------------------------------------------------------------

export interface FoundFile {
  /** The program file as found. */
  path: string;
  dir: string;
  /** Lower-cased extension ('' for none). */
  ext: string;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isExecutable(p: string): Promise<boolean> {
  if (!(await isFile(p))) return false;
  try {
    await access(p, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

function inside(root: string, p: string): boolean {
  const ci = process.platform === 'win32';
  const r = relative(ci ? root.toLowerCase() : root, ci ? p.toLowerCase() : p);
  return r !== '' && !isAbsolute(r) && r.split(sep)[0] !== '..';
}

/** The first `name` in the folders (spec 4.3 program lookup), or null. */
export async function findProgram(name: string, folders: readonly string[], platform: NodeJS.Platform = process.platform): Promise<FoundFile | null> {
  const win = platform === 'win32';
  const given = extname(name).toLowerCase();
  for (const dir of folders) {
    if (win) {
      // A name with its own extension is looked up as it is.
      const names = WIN_EXTS.includes(given) ? [name] : WIN_EXTS.map((e) => name + e);
      for (const n of names) {
        const p = join(dir, n);
        if (await isFile(p)) return { path: p, dir, ext: extname(n).toLowerCase() };
      }
    } else {
      const p = join(dir, name);
      if (await isExecutable(p)) return { path: p, dir, ext: extname(name).toLowerCase() };
    }
  }
  return null;
}

/** The first bytes of a file as text ('' when unreadable). */
async function head(p: string, bytes: number): Promise<string> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(p, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => {});
  }
}

const NODE_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?node(?:\s|$)|\S*[\\/]node(?:\.exe)?(?:\s|$))/;

async function isNodeScript(p: string): Promise<boolean> {
  return NODE_SHEBANG.test((await head(p, 256)).split(/\r?\n/, 1)[0] ?? '');
}

export interface PackageMatch {
  pkgDir: string;
  script: string;
  version: string | null;
  /** At or above the catalogue's minVersion (true when it names none). */
  versionOk: boolean;
}

/** Plain version order (1.2.10 > 1.2.9; a pre-release before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?/.exec(String(v).trim());
    return m ? { n: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? null } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i += 1) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Step 1: `pkgDir` holds the catalogue's package (that `name`) whose `bin` names `program`, with
 * the script's real path inside the package's real path. Null otherwise.
 */
export async function packageMatch(pkgDir: string, name: string, program: string, minVersion: string | null): Promise<PackageMatch | null> {
  const file = join(pkgDir, 'package.json');
  let doc: Record<string, unknown>;
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > PACKAGE_JSON_MAX) return null;
    doc = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || doc.name !== name) return null;
  let rel: unknown = null;
  if (typeof doc.bin === 'string') rel = program === name.split('/').pop() ? doc.bin : null;
  else if (doc.bin && typeof doc.bin === 'object' && Object.hasOwn(doc.bin, program)) rel = (doc.bin as Record<string, unknown>)[program];
  if (typeof rel !== 'string' || !rel || isAbsolute(rel)) return null;
  const script = resolve(pkgDir, ...rel.split(/[\\/]/));
  if (!(await isFile(script))) return null;
  if (!inside(await real(pkgDir), await real(script))) return null;
  const version = typeof doc.version === 'string' ? doc.version.slice(0, VERSION_MAX) : null;
  return { pkgDir, script, version, versionOk: minVersion == null || (version != null && compareVersions(version, minVersion) >= 0) };
}

/** Step 2: the script an npm cmd-shim runs, inside `<dir>/node_modules` (null: none). */
export async function shimTarget(shim: string, dir: string): Promise<string | null> {
  let text: string;
  try {
    const st = await stat(shim);
    if (st.size > SHIM_MAX) return null;
    text = await readFile(shim, 'utf8');
  } catch {
    return null;
  }
  let last: string | null = null;
  for (const m of text.matchAll(/"%~?dp0%?\\([^"%\r\n]+)"/gi)) {
    if (/^node_modules\\/i.test(m[1])) last = m[1];
  }
  if (!last) return null;
  const target = resolve(dir, ...last.split(/[\\/]/).filter(Boolean));
  if (!(await isFile(target))) return null;
  if (!inside(await real(join(dir, 'node_modules')), await real(target))) return null;
  return target;
}

export type Resolution =
  | { ok: true; program: string; script: string | null; base: string[]; verified: boolean; packageVersion: string | null }
  | { ok: false; code: 'cant_start_script'; program: string; script: string | null; error: string };

/** Step 3: how a resolved target starts. */
async function startOf(program: string, target: string, platform: NodeJS.Platform, extra: { verified: boolean; packageVersion: string | null }): Promise<Resolution> {
  const ext = extname(target).toLowerCase();
  const script = target === program ? null : target;
  if (NODE_SCRIPT_EXT.has(ext) || (ext === '' && (await isNodeScript(target)))) {
    return { ok: true, program, script: target, base: [agentNode() ?? process.execPath, target], ...extra };
  }
  if (platform === 'win32') {
    if (ext === '.exe') return { ok: true, program, script, base: [target], ...extra };
    return { ok: false, code: 'cant_start_script', program, script, error: CANT_START_TEXT(basename(target)) };
  }
  // POSIX: a program runs without a shell whatever it is (an executable file), started as found
  // (a program may read the name it was started by).
  return { ok: true, program, script, base: [program], ...extra };
}

/** Resolves a found program (steps 1-3); `pkg` is the catalogue's package for a known agent. */
export async function resolveProgram(
  found: FoundFile,
  programName: string,
  pkg: { name: string; minVersion: string | null } | null,
  platform: NodeJS.Platform = process.platform,
): Promise<Resolution> {
  const none = { verified: false, packageVersion: null };
  if (platform === 'win32') {
    if (found.ext === '.exe') return { ok: true, program: found.path, script: null, base: [found.path], ...none };
    if (found.ext === '.cmd' || found.ext === '.bat') {
      if (pkg) {
        const m = await packageMatch(join(found.dir, 'node_modules', ...pkg.name.split('/')), pkg.name, programName, pkg.minVersion);
        if (m) return startOf(found.path, m.script, platform, { verified: m.versionOk, packageVersion: m.version });
      }
      const target = await shimTarget(found.path, found.dir);
      if (target) return startOf(found.path, target, platform, none);
      return { ok: false, code: 'cant_start_script', program: found.path, script: null, error: CANT_START_TEXT(basename(found.path)) };
    }
    return startOf(found.path, found.path, platform, none);
  }
  const realProgram = await real(found.path);
  if (pkg) {
    const dirs = [join(found.dir, 'node_modules', ...pkg.name.split('/')), join(found.dir, '..', 'lib', 'node_modules', ...pkg.name.split('/'))];
    if (basename(found.dir) === '.bin') dirs.push(join(found.dir, '..', ...pkg.name.split('/')));
    for (const d of dirs) {
      const m = await packageMatch(d, pkg.name, programName, pkg.minVersion);
      // The program must be a link to the package's own script.
      if (m && (await real(m.script)) === realProgram) return startOf(found.path, m.script, platform, { verified: m.versionOk, packageVersion: m.version });
    }
  }
  return startOf(found.path, realProgram, platform, none);
}

// ---------------------------------------------------------------------------------------------
// Login, version, fingerprint
// ---------------------------------------------------------------------------------------------

export type SignedIn = 'yes' | 'key' | 'no' | 'unknown';

export interface LoginOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** The login file's path for this home and environment (null: no known file). */
export function loginFile(login: LoginSpec | undefined, o: LoginOptions): string | null {
  if (!login) return null;
  const env = o.env ?? process.env;
  const dir = login.dirVar ? String(env[login.dirVar] ?? '').trim() : '';
  if (dir && login.fileInDir) return join(dir, login.fileInDir);
  return join(o.home, ...login.file.split('/'));
}

/**
 * Whether the agent looks signed in (spec 4.3): ONLY from whether its login file exists
 * (fs.stat; it is never opened or read), else a key variable, else unknown where the login may
 * live in a keyring, else no. With no known file: unknown (or key).
 */
export async function loginState(login: LoginSpec | undefined, keyVars: readonly string[], o: LoginOptions): Promise<{ signed_in: SignedIn; key_var: string | null }> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const file = loginFile(login, o);
  if (file) {
    try {
      // stat only: the file is never opened, so its content (a token) never enters Magnusim.
      if ((await stat(file)).isFile()) return { signed_in: 'yes', key_var: null };
    } catch {
      /* no file */
    }
  }
  const keyVar = keyVars.find((v) => String(env[v] ?? '').trim() !== '') ?? null;
  if (keyVar) return { signed_in: 'key', key_var: keyVar };
  if (!login) return { signed_in: 'unknown', key_var: null };
  const keyring = login.keyring === true || (Array.isArray(login.keyring) && login.keyring.includes(platform));
  return { signed_in: keyring ? 'unknown' : 'no', key_var: null };
}

/** The version in a program's --version output: the first word starting with a digit, at most 40 characters. */
export function versionOf(text: string): string | null {
  for (const word of String(text).split(/\s+/)) {
    if (/^\d/.test(word)) return cleanText(word, VERSION_MAX) || null;
  }
  return null;
}

/**
 * The allow switch's fingerprint (spec 4.3): the kind, the id, the program's and script's real
 * paths (lower-cased on Windows) and the arguments. Never the version.
 */
export function agentFingerprint(
  kind: 'known' | 'custom',
  id: string,
  program: string,
  script: string | null,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const norm = (p: string) => (platform === 'win32' ? p.toLowerCase() : p);
  return createHash('sha256')
    .update(JSON.stringify([kind, id, norm(program), script ? norm(script) : null, ...args]))
    .digest('hex');
}

export interface ProbeOptions {
  env: AgentEnvSpec;
  label: string;
  /** Tests: the environment the allowlist reads (process.env otherwise). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Where the probe's working folder goes (os.tmpdir() otherwise). */
  tmp?: string;
  timeoutMs?: number;
  graceMs?: number;
}

/**
 * `argv` (a version flag included) run as an agent process (process.ts: no shell, the
 * environment allowlist, a fresh private working folder), stdin closed, at most 4 KB of stdout
 * read, at most `timeoutMs` (3 s) and then the tree kill. Its version, or null.
 */
export async function probeVersion(argv: readonly string[], o: ProbeOptions): Promise<string | null> {
  let proc: AgentProcess;
  try {
    proc = await startAgentProcess({ argv, label: o.label, env: o.env, baseEnv: o.baseEnv, tmp: o.tmp, graceMs: o.graceMs });
  } catch (err) {
    alog('info', 'agent version probe could not start', { agent: o.label, error: cleanText(String((err as Error)?.message ?? err), 200) });
    return null;
  }
  let out = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d: string) => {
    if (out.length < PROBE_STDOUT_MAX) out += d.slice(0, PROBE_STDOUT_MAX - out.length);
  });
  const outEnded = new Promise<void>((done) => {
    proc.stdout.once('end', () => done());
    proc.stdout.once('close', () => done());
  });
  try {
    proc.stdin.end();
  } catch {
    /* gone */
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    Promise.all([proc.exited, outEnded]).then(() => true),
    new Promise<boolean>((done) => {
      timer = setTimeout(() => done(false), o.timeoutMs ?? PROBE_MS);
    }),
  ]);
  clearTimeout(timer);
  // The tree kill: whatever it started goes too (and its working folder).
  await proc.stop(finished ? 'version' : 'version_timeout');
  if (!finished) {
    alog('info', 'agent version probe took too long; stopped', { agent: o.label });
    return null;
  }
  return versionOf(out);
}

/** Runs `fn` over `items`, at most `n` at once. */
async function limited<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

/** One agent as discovery found it (or didn't). */
export interface AgentEntry {
  id: string;
  name: string;
  kind: 'known' | 'custom';
  found: boolean;
  /** The install line, for a known agent not found. */
  install: string | null;
  /** The program file as found (shown in every row). */
  program: string | null;
  /** Its name as found in the folder (the sign-in command shows it). */
  programName: string | null;
  /** The script (or .exe) the program resolves to, when it isn't the program itself. */
  script: string | null;
  /** The launch command: program first, then the agent's own arguments (no shell, ever). */
  argv: string[] | null;
  /** Its version from --version, else from its verified package, else null. */
  version: string | null;
  /** Resolved through the catalogue's package (name, version, real path: the identity rule). */
  verifiedPackage: boolean;
  /** Its class as resolved: the catalogue's lockdown with a verified package, else 'none'. */
  lockdown: Lockdown;
  signedIn: SignedIn;
  keyVar: string | null;
  fingerprint: string | null;
  /** Why it can't start (cant_start_script, bad_command) or wasn't found, with the text. */
  error: { code: string; message: string } | null;
  /** What process.ts's environment allowlist needs. */
  env: AgentEnvSpec;
  /** A custom agent: the command it was resolved from (the cache matches on it). */
  command: string[] | null;
  /** OpenCode: the person's default agent (its permissions are overridden too). */
  defaultAgent: string | null;
}

export interface Discovery {
  checked_at: string;
  took_ms: number;
  folders: string[];
  agents: AgentEntry[];
}

export interface DiscoverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The home folder (the test switch's, else os.homedir()). */
  home?: string;
  /** The search folders (the test switch's, else searchFolders()). */
  folders?: string[];
  /** The settings (the custom agents and the allow switches; loaded otherwise). */
  settings?: AssistantSettings;
  /** The custom agents to resolve (the settings' otherwise). */
  custom?: readonly CustomAgent[];
  /** false: no version probe (tests of resolution). */
  probe?: boolean;
  /** Ask every version again (Refresh). */
  refresh?: boolean;
  /** Where probes' working folders go. */
  tmp?: string;
  probeMs?: number;
  graceMs?: number;
}

interface Ctx {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  folders: string[];
}

function envSpecOf(known: KnownAgent | null, custom: CustomAgent | null, folders: string[]): AgentEnvSpec {
  return {
    keyVars: known ? [...known.keyVars] : [],
    dirVar: known?.login?.dirVar ?? null,
    envPrefixes: known ? [...known.envPrefixes] : [],
    keepEnv: custom ? [...custom.keep_env] : [],
    searchFolders: [...folders],
  };
}

function missing(id: string, name: string, kind: 'known' | 'custom', install: string | null, env: AgentEnvSpec, error: AgentEntry['error'] = null, command: string[] | null = null): AgentEntry {
  return {
    id,
    name,
    kind,
    found: false,
    install,
    program: null,
    programName: null,
    script: null,
    argv: null,
    version: null,
    verifiedPackage: false,
    lockdown: 'none',
    signedIn: 'unknown',
    keyVar: null,
    fingerprint: null,
    error,
    env,
    command,
    defaultAgent: null,
  };
}

async function resolveKnown(k: KnownAgent, c: Ctx): Promise<AgentEntry> {
  const env = envSpecOf(k, null, c.folders);
  let found: FoundFile | null = null;
  let programName = '';
  for (const name of k.programs) {
    found = await findProgram(name, c.folders, c.platform);
    if (found) {
      programName = basename(found.path);
      break;
    }
  }
  if (!found) return missing(k.id, k.name, 'known', k.install, env);
  const pkg = k.npmPackage ? { name: k.npmPackage, minVersion: k.checked && k.checked.package === k.npmPackage ? k.checked.minVersion : null } : null;
  const nameNoExt = c.platform === 'win32' ? programName.replace(/\.(exe|cmd|bat)$/i, '') : programName;
  const r = await resolveProgram(found, nameNoExt, pkg, c.platform);
  const login = await loginState(k.login, k.keyVars, { home: c.home, env: c.env, platform: c.platform });
  const realProgram = await real(found.path);
  const script = r.script ? await real(r.script) : null;
  const entry: AgentEntry = {
    ...missing(k.id, k.name, 'known', null, env),
    found: true,
    program: found.path,
    programName,
    script: r.script,
    signedIn: login.signed_in,
    keyVar: login.key_var,
    fingerprint: agentFingerprint('known', k.id, realProgram, script, k.args, c.platform),
  };
  if (!r.ok) return { ...entry, error: { code: r.code, message: r.error } };
  if (!agentNode()) return { ...entry, error: { code: NEEDS_NODE_CODE, message: needsNodeText() } };
  // tools_off needs its live check; a class other than 'none' only through the verified package.
  const holds = k.lockdown !== 'tools_off' || !!k.checked;
  return {
    ...entry,
    argv: [...r.base, ...k.args],
    version: r.packageVersion,
    verifiedPackage: r.verified,
    lockdown: r.verified && holds ? k.lockdown : 'none',
    defaultAgent: k.id === 'opencode' ? await openCodeDefaultAgent(c) : null,
  };
}

/** Resolves a custom agent's command (no probe: its Test asks it). */
export async function resolveCustom(a: CustomAgent, c: Ctx): Promise<AgentEntry> {
  const env = envSpecOf(null, a, c.folders);
  const command = [...a.argv];
  const prog = a.argv[0];
  const args = a.argv.slice(1);
  const P = c.platform === 'win32' ? win32 : posix;
  let found: FoundFile | null = null;
  if (/[\\/]/.test(prog)) {
    if (!P.isAbsolute(prog)) return missing(a.id, a.name, 'custom', null, env, { code: 'bad_command', message: "Give the program's full path, or a program name found on PATH." }, command);
    if (await isFile(prog)) {
      // POSIX: a program is an executable file (as on PATH); a node script starts with node whatever its mode.
      if (c.platform !== 'win32' && !(await isExecutable(prog)) && !NODE_SCRIPT_EXT.has(extname(prog).toLowerCase()) && !(await isNodeScript(prog))) {
        return missing(a.id, a.name, 'custom', null, env, { code: 'bad_command', message: `Magnusim can't run ${cleanText(basename(prog), 200)}: it isn't marked as a program (executable).` }, command);
      }
      found = { path: prog, dir: dirname(prog), ext: extname(prog).toLowerCase() };
    }
  } else {
    found = await findProgram(prog, c.folders, c.platform);
  }
  if (!found) return missing(a.id, a.name, 'custom', null, env, { code: 'agent_missing', message: `Magnusim can't find ${cleanText(prog, 200)} on this PC.` }, command);
  const r = await resolveProgram(found, basename(found.path), null, c.platform);
  const script = r.script ? await real(r.script) : null;
  const entry: AgentEntry = {
    ...missing(a.id, a.name, 'custom', null, env, null, command),
    found: true,
    program: found.path,
    programName: basename(found.path),
    script: r.script,
    // Magnusim can't tell where a custom agent keeps its login.
    signedIn: 'unknown',
    fingerprint: agentFingerprint('custom', a.id, await real(found.path), script, args, c.platform),
  };
  if (!r.ok) return { ...entry, error: { code: r.code, message: r.error } };
  if (!agentNode()) return { ...entry, error: { code: NEEDS_NODE_CODE, message: needsNodeText() } };
  return { ...entry, argv: [...r.base, ...args] };
}

/** OpenCode's default agent from the person's config, if it names one (read at discovery). */
async function openCodeDefaultAgent(c: Ctx): Promise<string | null> {
  const xdg = String(c.env.XDG_CONFIG_HOME ?? '').trim();
  const dir = xdg && isAbsolute(xdg) ? join(xdg, 'opencode') : join(c.home, '.config', 'opencode');
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = join(dir, name);
    try {
      const st = await stat(file);
      if (!st.isFile() || st.size > OPENCODE_CONFIG_MAX) continue;
      const m = /"default_agent"\s*:\s*"([A-Za-z0-9_-]{1,64})"/.exec(await readFile(file, 'utf8'));
      return m ? m[1] : null;
    } catch {
      /* none here */
    }
  }
  return null;
}

/**
 * The environment discovery reads under the test home switch: the real one without any agent's
 * key, login-folder or own-prefix variable and without XDG_CONFIG_HOME / XDG_DATA_HOME, so login
 * files and configs are looked up only in the test home and no probe gets the person's keys.
 */
export function testHomeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const exact = new Set(['XDG_CONFIG_HOME', 'XDG_DATA_HOME']);
  const prefixes: string[] = [];
  for (const k of KNOWN_AGENTS) {
    for (const v of k.keyVars) exact.add(v.toUpperCase());
    if (k.login?.dirVar) exact.add(k.login.dirVar.toUpperCase());
    for (const p of k.envPrefixes) prefixes.push(p.toUpperCase());
  }
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const n = name.toUpperCase();
    if (exact.has(n) || prefixes.some((p) => n.startsWith(p))) continue;
    out[name] = value;
  }
  return out;
}

/** The context discovery runs in: the switches' folders and home in a test, else this PC's. */
async function contextOf(o: DiscoverOptions): Promise<{ ctx: Ctx; tmp: string | undefined }> {
  const sw = agentTestSwitches(process.env);
  reportIgnored(sw);
  const env = o.env ?? (sw.home ? testHomeEnv(process.env) : process.env);
  const platform = o.platform ?? process.platform;
  const home = o.home ?? sw.home ?? homedir();
  const folders = o.folders ?? sw.paths ?? (await searchFolders({ env, platform, home }));
  let tmp = o.tmp;
  if (!tmp && sw.home) {
    // A test's probes never use (or sweep) the system temp folder.
    tmp = join(sw.home, 'tmp');
    await mkdir(tmp, { recursive: true }).catch(() => {});
  }
  return { ctx: { env, platform, home, folders }, tmp };
}

/**
 * Whether discovery may start this known agent's program to ask its version, with no click:
 * only its own verified package, or a program whose allow switch is on for that very program.
 * A lookalike earlier in PATH, a shim to another package and the like are never started here.
 */
function mayProbe(e: AgentEntry, settings: AssistantSettings): boolean {
  if (e.verifiedPackage) return true;
  const allowed = agentPrefs(settings, e.id).allowed;
  return !!allowed && !!e.fingerprint && allowed.fingerprint === e.fingerprint;
}

function versionKey(e: AgentEntry, mtimes: number[]): string {
  return `${e.fingerprint}|${mtimes.join(',')}`;
}

async function mtimeOf(p: string | null): Promise<number> {
  if (!p) return 0;
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Every known agent and every custom agent, resolved, with known agents' versions asked
 * (spec 4.3). Never throws for one agent: an error leaves it not found.
 */
export async function discoverAgents(o: DiscoverOptions = {}): Promise<Discovery> {
  const t0 = Date.now();
  const { ctx, tmp } = await contextOf(o);
  const settings = o.settings ?? (await loadSettings());
  const custom = o.custom ?? settings.custom_agents;
  const safe = async (fn: () => Promise<AgentEntry>, fallback: () => AgentEntry) => {
    try {
      return await fn();
    } catch (err) {
      alog('warn', 'an agent could not be looked up', { error: cleanText(String((err as Error)?.message ?? err), 200) });
      return fallback();
    }
  };
  const known = await Promise.all(
    KNOWN_AGENTS.map((k) => safe(() => resolveKnown(k, ctx), () => missing(k.id, k.name, 'known', k.install, envSpecOf(k, null, ctx.folders)))),
  );
  const customs = await Promise.all(
    custom.map((a) => safe(() => resolveCustom(a, ctx), () => missing(a.id, a.name, 'custom', null, envSpecOf(null, a, ctx.folders), null, [...a.argv]))),
  );
  if (o.probe !== false) {
    const g = cacheOf();
    const toAsk = known.filter((e) => e.found && !e.error && e.argv && knownAgent(e.id)?.versionArgs && mayProbe(e, settings));
    await limited(toAsk, PROBES_AT_ONCE, async (e) => {
      const k = knownAgent(e.id) as KnownAgent;
      const key = versionKey(e, [await mtimeOf(e.program), await mtimeOf(e.script)]);
      if (!o.refresh && g.versions.has(key)) {
        e.version = g.versions.get(key) ?? e.version;
        return;
      }
      const base = (e.argv as string[]).slice(0, (e.argv as string[]).length - k.args.length);
      // The system's variables only: a version needs no key, login folder or agent variable.
      const v = await probeVersion([...base, ...(k.versionArgs as readonly string[])], {
        env: { searchFolders: ctx.folders },
        label: `${e.id} --version`,
        baseEnv: ctx.env,
        tmp,
        timeoutMs: o.probeMs,
        graceMs: o.graceMs,
      });
      if (v) e.version = v;
      g.versions.set(key, e.version);
    });
  }
  return { checked_at: new Date().toISOString(), took_ms: Date.now() - t0, folders: ctx.folders, agents: [...known, ...customs] };
}

// ---------------------------------------------------------------------------------------------
// The cache and the hooks (globalThis, per Assistant state: a Vite re-import shares it, a
// test reset forgets it)
// ---------------------------------------------------------------------------------------------

/** What a later part of the Assistant tells discovery (agent turns, the Test). */
export interface AgentRunHooks {
  /** Whether any turn (or Test, connect or sign-in) of that agent runs now. */
  running(id: string): boolean;
  /**
   * Stops that agent's running turns with `text` and tree-kills every process of it, idle
   * sessions kept between messages included; resolves once they are gone (the allow switch
   * turned off, a custom agent removed).
   */
  stop(id: string, text: string): Promise<void>;
}

/**
 * What the agent itself said of its login at its last check that got through, or its last
 * auth_required (memory only): 'none' (it isn't signed in), 'signed_in' (it said so, or it
 * answered a Test's message), 'silent' (a connect it said nothing on: it starts, and whether it is
 * signed in isn't known).
 */
export type AgentWord = 'none' | 'signed_in' | 'silent';

/** What the last Test or connect listed (memory only). */
export interface AgentLast {
  modes: ModeView[];
  models: ModelView[];
  at: string;
}

/** What an agent's last initialize said of pictures (promptCapabilities.image), and of which program (memory only). */
export interface AgentImagesWord {
  images: boolean;
  fingerprint: string | null;
}

interface AgentsCache {
  result: Discovery | null;
  /** The discovery running now, and whether it asks every version again. */
  running: { promise: Promise<Discovery>; refresh: boolean } | null;
  /** A Refresh asked while a plain discovery ran: it runs right after that one. */
  queued: Promise<Discovery> | null;
  /**
   * Bumped by every change to the cached entries (a custom agent added or removed, an agent
   * resolved again): a discovery that ends under a newer one takes the settings' custom agents
   * again before it is kept, so it never brings back a removed one or drops a new one.
   */
  gen: number;
  versions: Map<string, string | null>;
  last: Map<string, AgentLast>;
  signIn: Map<string, Record<string, unknown>>;
  word: Map<string, AgentWord>;
  images: Map<string, AgentImagesWord>;
}

interface AgentsGlobal {
  byState: WeakMap<object, AgentsCache>;
  hooks: AgentRunHooks | null;
}

const KEY = Symbol.for('magnusim.assistant.agents');

function globals(): AgentsGlobal {
  const g = globalThis as unknown as Record<symbol, AgentsGlobal | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { byState: new WeakMap(), hooks: null };
    g[KEY] = s;
  }
  return s;
}

function cacheOf(): AgentsCache {
  const key = assistantState();
  const g = globals();
  let c = g.byState.get(key);
  if (!c) {
    c = { result: null, running: null, queued: null, gen: 0, versions: new Map(), last: new Map(), signIn: new Map(), word: new Map(), images: new Map() };
    g.byState.set(key, c);
  }
  return c;
}

/** Agent turns (A4) say which agents run and how to stop them; null forgets. */
export function setAgentRunHooks(h: AgentRunHooks | null): void {
  globals().hooks = h;
}

function hooks(): AgentRunHooks {
  return globals().hooks ?? { running: () => false, stop: async () => {} };
}

/** What the last Test or connect of that agent listed (shown in its row). */
export function rememberAgentLast(id: string, last: AgentLast | null): void {
  if (last) cacheOf().last.set(id, last);
  else cacheOf().last.delete(id);
}

/**
 * Whether the agent said at its last initialize (a turn's start, a Test or a connect) that it
 * takes pictures, for the program it said it of (`fingerprint`); null forgets. The status row
 * shows it; a turn goes by its own session's initialize, never by this.
 */
export function rememberAgentImages(id: string, fingerprint: string | null, images: boolean | null): void {
  if (images === null) cacheOf().images.delete(id);
  else cacheOf().images.set(id, { images, fingerprint });
}

/**
 * Whether the agent takes pictures, as far as Magnusim knows before its next start: its last
 * initialize's word for this very program, else the catalogue's (known.ts `images`), else null.
 */
export function agentTakesImages(id: string, fingerprint: string | null): boolean | null {
  const said = cacheOf().images.get(id);
  if (said && said.fingerprint === fingerprint) return said.images;
  return knownAgent(id)?.images ?? null;
}

/**
 * The sign-in block from the last auth_required, or from a connect it said 'none' to (shown in
 * its row). A block is the agent's word that it isn't signed in; null leaves its word as it is.
 */
export function rememberAgentSignIn(id: string, view: Record<string, unknown> | null): void {
  if (view) {
    cacheOf().signIn.set(id, view);
    cacheOf().word.set(id, 'none');
  } else cacheOf().signIn.delete(id);
}

/** The agent's own word on its login (null: forgotten, its login file decides again). */
export function rememberAgentWord(id: string, word: AgentWord | null): void {
  if (word) cacheOf().word.set(id, word);
  else cacheOf().word.delete(id);
}

/** The last discovery (null: none since the server started). Never runs one. */
export function agentsCache(): Discovery | null {
  return cacheOf().result;
}

/**
 * Runs discovery and keeps it: one at a time, so a caller while one runs gets that one, except
 * that a Refresh (every version asked again) asked while a plain discovery runs gets one Refresh
 * run right after it. `probeMs`: tests' probe limit.
 */
export function refreshAgents(o: { refresh?: boolean; probeMs?: number } = {}): Promise<Discovery> {
  const c = cacheOf();
  const refresh = o.refresh === true;
  if (c.running) {
    if (!refresh || c.running.refresh) return c.running.promise;
    if (!c.queued) {
      const queued: Promise<Discovery> = c.running.promise
        .catch(() => null)
        .then(() => {
          if (c.queued === queued) c.queued = null;
          return refreshAgents({ ...o, refresh: true });
        });
      c.queued = queued;
    }
    return c.queued;
  }
  const gen = c.gen;
  const run = discoverAgents({ refresh, probeMs: o.probeMs }).then((d) => keepDiscovery(c, d, gen));
  c.running = { promise: run, refresh };
  const clear = () => {
    if (c.running?.promise === run) c.running = null;
  };
  run.then(clear, clear);
  return run;
}

/**
 * Keeps a finished discovery. When a custom agent was added or removed (or an agent resolved
 * again) while it ran, its custom entries are taken again from the settings as they are now
 * (each from this run, the cache, or resolved now; no process) before it is kept.
 */
async function keepDiscovery(c: AgentsCache, d: Discovery, startGen: number): Promise<Discovery> {
  let gen = startGen;
  for (let i = 0; c.gen !== gen && i < 8; i += 1) {
    gen = c.gen;
    const [settings, { ctx }] = await Promise.all([loadSettings(), contextOf({})]);
    const before = c.result;
    const customs = await Promise.all(settings.custom_agents.map(async (a) => cachedCustom(d, a) ?? cachedCustom(before, a) ?? resolveCustom(a, ctx)));
    d.agents = [...d.agents.filter((e) => e.kind === 'known'), ...customs];
  }
  c.result = d;
  return d;
}

/** The cached discovery when younger than `maxAgeMs`, else a new one (a turn's start). */
export async function ensureAgents(maxAgeMs: number = AGENT_CACHE_MS): Promise<Discovery> {
  const d = agentsCache();
  if (d && Date.now() - Date.parse(d.checked_at) < maxAgeMs) return d;
  return refreshAgents();
}

/** Puts one entry in the cache (a custom agent added, an agent resolved again), if there is a cache. */
function cacheEntry(e: AgentEntry): void {
  const c = cacheOf();
  c.gen += 1;
  const d = c.result;
  if (!d) return;
  const i = d.agents.findIndex((a) => a.id === e.id);
  if (i >= 0) d.agents[i] = e;
  else d.agents.push(e);
}

function uncacheEntry(id: string): void {
  const c = cacheOf();
  c.gen += 1;
  const d = c.result;
  if (d) d.agents = d.agents.filter((a) => a.id !== id);
}

/** One agent resolved again now (no probe; a known agent keeps its cached version when its program is the same). */
export async function resolveAgentNow(id: string, settings: AssistantSettings): Promise<AgentEntry | null> {
  const { ctx } = await contextOf({});
  const k = knownAgent(id);
  let e: AgentEntry;
  if (k) {
    e = await resolveKnown(k, ctx);
    const before = agentsCache()?.agents.find((a) => a.id === id);
    if (before && before.fingerprint === e.fingerprint && before.version) e.version = before.version;
  } else {
    const c = settings.custom_agents.find((a) => a.id === id);
    if (!c) return null;
    e = await resolveCustom(c, ctx);
  }
  cacheEntry(e);
  return e;
}

// ---------------------------------------------------------------------------------------------
// Rows (GET /api/assistant/agents, the status' providers_ready)
// ---------------------------------------------------------------------------------------------

/** One agent as Settings shows it (spec 5.4). */
export interface AgentRow {
  id: string;
  name: string;
  kind: 'known' | 'custom';
  found: boolean;
  install: string | null;
  program: string | null;
  script: string | null;
  version: string | null;
  verified_package: boolean;
  signed_in: SignedIn;
  key_var: string | null;
  lockdown: Lockdown;
  own_tools: 'off' | 'on';
  needs_allow: boolean;
  allowed: boolean;
  allow_changed: boolean;
  fingerprint: string | null;
  model: string | null;
  mode: string | null;
  /**
   * The modes Magnusim uses with it (the catalogue's allowedModes, spec 4.2): their ids, or
   * 'initial' (only the mode it starts in; a custom command too). The Mode select offers only these.
   */
  allowed_modes: string[] | 'initial';
  last: AgentLast | null;
  sign_in: Record<string, unknown> | null;
  /** What the agent itself said of its login last (AgentWord), or null: no check since the server started. */
  auth_word: AgentWord | null;
  ready: boolean;
  reason: string | null;
  /**
   * Why it can't be started, as the person reads it (cant_start_script: spec 4.3's copy naming
   * the file; bad_command; a custom command not found), else null.
   */
  error: string | null;
}

export interface RowContext {
  settings: AssistantSettings;
  /** Whether the connection agents use can run (the listener can bind, its package is there). */
  mcp: { available: boolean; reason: string | null };
  /** Magnusim's version (a fired lockdown tripwire holds until the next update). */
  appVersion: string;
}

/** An agent's row from its entry and the settings (pure; no file, no process). */
export function agentRow(e: AgentEntry, ctx: RowContext): AgentRow {
  const prefs = agentPrefs(ctx.settings, e.id);
  const tripped = !!prefs.lockdown_failed && prefs.lockdown_failed.version === ctx.appVersion;
  const lockdown: Lockdown = e.found && !e.error && !tripped ? e.lockdown : 'none';
  const needsAllow = lockdown !== 'tools_off';
  const allowed = !!prefs.allowed && !!e.fingerprint && prefs.allowed.fingerprint === e.fingerprint;
  const allowChanged = !!prefs.allowed && !allowed;
  const c = cacheOf();
  const modes = policyOf(e.kind === 'known' ? knownAgent(e.id) : null).allowedModes;
  const row: AgentRow = {
    id: e.id,
    name: e.name,
    kind: e.kind,
    found: e.found,
    install: e.found ? null : e.install,
    program: e.program,
    script: e.script,
    version: e.version,
    verified_package: e.verifiedPackage,
    signed_in: e.signedIn,
    key_var: e.keyVar,
    lockdown,
    own_tools: lockdown === 'tools_off' ? 'off' : 'on',
    needs_allow: needsAllow,
    allowed,
    allow_changed: allowChanged,
    fingerprint: e.fingerprint,
    model: prefs.model,
    mode: prefs.mode,
    allowed_modes: modes === 'initial' ? 'initial' : [...modes],
    last: c.last.get(e.id) ?? null,
    sign_in: c.signIn.get(e.id) ?? null,
    auth_word: c.word.get(e.id) ?? null,
    ready: false,
    reason: null,
    error: e.error?.message ?? null,
  };
  row.reason = readinessReason(row, e, ctx);
  row.ready = row.reason === null;
  return row;
}

/**
 * Whether the agent isn't signed in, as Settings says it: its own word first (its 'none', or the
 * sign-in block of its last auth_required), then its login file; its word that it is signed in,
 * or a connect it said nothing on (it starts; not known), counts over a missing login file.
 * The row's line, its dot, the Default choice and the status agree on it.
 */
export function agentSignedOut(row: Pick<AgentRow, 'sign_in' | 'auth_word' | 'signed_in'>): boolean {
  if (row.sign_in || row.auth_word === 'none') return true;
  if (row.auth_word === 'signed_in' || row.auth_word === 'silent') return false;
  return row.signed_in === 'no';
}

/**
 * Why a turn on this agent can't start now (spec 5.2 readiness), or null: it is ready only when
 * found and startable, signed in or not known to be signed out (agentSignedOut), allowed or
 * with its own tools off, its tool connection can run, and privacy lets it run at all (under
 * "Never send project data" a turn on an agent whose own tools stay on is refused even from
 * Home, spec 4.14).
 */
function readinessReason(row: AgentRow, e: AgentEntry, ctx: RowContext): string | null {
  if (!e.found) return e.error?.code === 'bad_command' ? 'bad_command' : 'agent_missing';
  if (e.error) return e.error.code;
  if (row.needs_allow && !row.allowed) return row.allow_changed ? 'agent_allow_changed' : 'agent_not_allowed';
  if (agentSignedOut(row)) return 'agent_signed_out';
  if (!ctx.mcp.available) return 'mcp_unavailable';
  if (ctx.settings.privacy === 'deny' && row.own_tools === 'on') return 'privacy_denied';
  return null;
}

/** A custom agent's cached entry, when it was resolved from its current command. */
function cachedCustom(d: Discovery | null, a: CustomAgent): AgentEntry | null {
  const e = d?.agents.find((x) => x.id === a.id);
  if (!e || !e.command || e.command.length !== a.argv.length || e.command.some((p, i) => p !== a.argv[i])) return null;
  return { ...e, name: a.name, env: { ...e.env, keepEnv: [...a.keep_env] } };
}

/** Every agent's row from a discovery: the known ones, then the settings' custom ones. */
export function agentRows(d: Discovery, ctx: RowContext): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const k of KNOWN_AGENTS) {
    const e = d.agents.find((a) => a.id === k.id && a.kind === 'known');
    if (e) rows.push(agentRow(e, ctx));
  }
  for (const a of ctx.settings.custom_agents) {
    const e = cachedCustom(d, a);
    if (e) rows.push(agentRow(e, ctx));
  }
  return rows;
}

/** Why a provider row isn't ready, as Settings says it. */
const NOT_READY_DETAIL: Readonly<Record<string, string>> = Object.freeze({
  agent_missing: 'Not installed',
  bad_command: "Its command can't be used",
  cant_start_script: "Magnusim can't start it without a command shell",
  agent_not_allowed: 'Off until you allow it',
  agent_allow_changed: 'Its command changed since you allowed it',
  agent_signed_out: 'Not signed in',
  mcp_unavailable: "Magnusim's tool connection isn't available",
  privacy_denied: 'Off while Never send project data is on',
  not_checked: 'Not looked for yet',
  agent_unknown: 'No such coding agent',
});

const LOGIN_SHORT: Readonly<Record<SignedIn, string>> = Object.freeze({ yes: 'Signed in', key: 'Key from the environment', no: 'Not signed in', unknown: 'Sign-in not known' });

/** A ready row's sign-in as its line says it: the agent's word that it is signed in, a connect it said nothing on with no login file (not known), else the login file. */
function readyLogin(row: AgentRow): SignedIn {
  if (row.auth_word === 'signed_in' && row.signed_in !== 'key') return 'yes';
  if (row.auth_word === 'silent' && row.signed_in === 'no') return 'unknown';
  return row.signed_in;
}

/**
 * The status' providers_ready rows of the coding agents (`agent:<id>`): every found known agent
 * and every custom agent of the last discovery (a custom agent not looked up since it was added:
 * not_checked), and the saved default when it is an agent with no row of its own, so Settings
 * names it and says why it can't run (not looked for yet; looked for and not found: a known
 * agent agent_missing, any other id agent_unknown). Each says whether the agent takes pictures
 * (`images`: agentTakesImages; null not known), which the dock's composer follows. From the
 * cache only: the status never starts a process.
 */
export function agentReadyRows(ctx: RowContext): Record<string, Record<string, unknown>> {
  const d = agentsCache();
  const out: Record<string, Record<string, unknown>> = {};
  const put = (id: string, name: string, row: AgentRow | null) => {
    const reason = row ? row.reason : 'not_checked';
    let detail: string;
    if (row && row.ready) detail = [row.key_var ? `Uses ${row.key_var}` : LOGIN_SHORT[readyLogin(row)], row.version].filter(Boolean).join(' · ');
    else detail = NOT_READY_DETAIL[reason ?? ''] ?? 'Not ready';
    out[`agent:${id}`] = { label: name, kind: 'agent', ready: !!row?.ready, reason, billing: 'agent_account', detail, images: agentTakesImages(id, row?.fingerprint ?? null) };
  };
  if (d) {
    for (const k of KNOWN_AGENTS) {
      const e = d.agents.find((a) => a.id === k.id && a.kind === 'known');
      if (e?.found) put(k.id, k.name, agentRow(e, ctx));
    }
  }
  for (const a of ctx.settings.custom_agents) {
    const e = cachedCustom(d, a);
    put(a.id, a.name, e ? agentRow(e, ctx) : null);
  }
  const saved: string = ctx.settings.provider;
  if (saved.startsWith('agent:') && !Object.hasOwn(out, saved)) {
    const id = saved.slice('agent:'.length);
    const k = KNOWN_AGENTS.find((x) => x.id === id);
    const reason = !d ? 'not_checked' : k ? 'agent_missing' : 'agent_unknown';
    out[saved] = { label: k?.name ?? id, kind: 'agent', ready: false, reason, billing: 'agent_account', detail: NOT_READY_DETAIL[reason], images: k?.images ?? null };
  }
  return out;
}

export type AgentStartPurpose = 'connect' | 'sign_in' | 'test' | 'turn';

/**
 * Whether an agent may be started now for `purpose` (spec 4.12, 4.13, 5.3, 14 S12), or why not.
 * A program whose own tools stay on needs its allow switch for everything. The one exception is
 * the plain connect check and sign-in of a known agent's own verified package whose class isn't
 * 'none' (a documented lockdown not yet checked live: the program the person installed, given
 * Magnusim's lockdown). Class 'none' (an agent whose tools can't be switched off, a fired
 * lockdown tripwire, any program not resolved through its package) and a custom command need
 * the switch for those too.
 */
export function agentStartRefusal(row: AgentRow, purpose: AgentStartPurpose): { code: string; error: string } | null {
  if (row.reason === 'cant_start_script') return { code: row.reason, error: row.error ?? `Magnusim can't start ${row.name} without a command shell.` };
  if (row.reason === NEEDS_NODE_CODE) return { code: row.reason, error: row.error ?? NEEDS_NODE_TEXT };
  if (row.reason === 'bad_command') return { code: row.reason, error: `${row.name}'s command can't be used. ${row.error ?? 'Change it in Settings → Assistant.'}` };
  if (!row.found) {
    return { code: 'agent_missing', error: row.kind === 'custom' && row.error ? row.error : `${row.name} isn't installed on this PC. Settings → Assistant shows how to install it.` };
  }
  if (row.needs_allow && !row.allowed) {
    if ((purpose === 'connect' || purpose === 'sign_in') && row.kind === 'known' && row.verified_package && row.lockdown !== 'none') return null;
    if (row.allow_changed) return { code: 'agent_allow_changed', error: `${row.name}'s command changed since you allowed it. Allow it again in Settings → Assistant.` };
    return { code: 'agent_not_allowed', error: `${row.name} is off until you allow it in Settings → Assistant: its own tools can run commands and change files on this PC.` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The routes' work (assistant-routes.ts checks access and the browser first)
// ---------------------------------------------------------------------------------------------

type Answer = { status: number; body: Record<string, unknown> };

export interface AgentRouteContext {
  mcp: () => Promise<RowContext['mcp']>;
}

async function rowContext(r: AgentRouteContext, settings?: AssistantSettings): Promise<RowContext> {
  const [s, mcp, version] = await Promise.all([settings ?? loadSettings(), r.mcp(), appVersion()]);
  return { settings: s, mcp, appVersion: version };
}

/** GET /api/assistant/agents: discovery (Refresh asks every version again) and every row. */
export async function listAgents(r: AgentRouteContext, o: { refresh?: boolean } = {}): Promise<Answer> {
  const d = await refreshAgents({ refresh: o.refresh });
  const ctx = await rowContext(r);
  return { status: 200, body: { ok: true, checked_at: d.checked_at, took_ms: d.took_ms, agents: agentRows(d, ctx) } };
}

const NEVER_PASSED = /^(MAGNUSIM_|CFDDESK_|npm_)|^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i;

/** POST /api/assistant/agents/custom {name, command, keep_env?}: the new row (needs its switch). */
export async function addCustomAgentRequest(r: AgentRouteContext, body: Record<string, unknown>): Promise<Answer> {
  const refuse = (code: string, error: string, field?: string): Answer => ({ status: 400, body: { ok: false, code, error, ...(field ? { field } : {}) } });
  const name = cleanText(body.name, CUSTOM_NAME_MAX);
  if (!name || !customNameValid(name)) return refuse('bad_name', 'Give the agent a name (up to 40 characters).', 'name');
  if (typeof body.command !== 'string' || body.command.length > CUSTOM_ARGV_MAX * (CUSTOM_ARG_CHARS + 3)) return refuse('bad_command', 'Enter the command that starts the agent.', 'command');
  const argv = splitCommand(body.command);
  if (!argv.length || !argv[0]) return refuse('bad_command', 'Enter the command that starts the agent.', 'command');
  if (argv.length > CUSTOM_ARGV_MAX) return refuse('bad_command', `A command has at most ${CUSTOM_ARGV_MAX} parts.`, 'command');
  if (argv.some((a) => a.length > CUSTOM_ARG_CHARS || a.includes('\0'))) return refuse('bad_command', `Each part of the command has at most ${CUSTOM_ARG_CHARS} characters.`, 'command');
  const keepRaw = body.keep_env ?? [];
  if (!Array.isArray(keepRaw) || keepRaw.length > KEEP_ENV_MAX || !keepRaw.every((k) => typeof k === 'string' && KEEP_ENV_RE.test(k))) {
    return refuse('bad_keep_env', `List at most ${KEEP_ENV_MAX} variable names (letters, digits and _).`, 'keep_env');
  }
  const keep = [...new Set(keepRaw as string[])];
  if (keep.some((k) => NEVER_PASSED.test(k))) return refuse('bad_keep_env', "Magnusim never passes its own variables, npm's, NODE_OPTIONS or ELECTRON_RUN_AS_NODE to an agent.", 'keep_env');
  const settings = await loadSettings();
  if (settings.custom_agents.length >= CUSTOM_AGENTS_MAX) return refuse('too_many', `Magnusim keeps at most ${CUSTOM_AGENTS_MAX} custom agents. Remove one first.`);
  let id = `custom-${randomBytes(3).toString('hex')}`;
  while (isAgentOf(settings, id)) id = `custom-${randomBytes(3).toString('hex')}`;
  const agent: CustomAgent = { id, name, argv, keep_env: keep };
  const { ctx } = await contextOf({});
  const entry = await resolveCustom(agent, ctx);
  if (entry.error) {
    const code = entry.error.code === 'cant_start_script' ? 'cant_start_script' : 'bad_command';
    return refuse(code, entry.error.message, 'command');
  }
  const saved = await addCustomAgent(agent);
  if (!saved.ok) return saved.code === 'too_many' ? refuse('too_many', `Magnusim keeps at most ${CUSTOM_AGENTS_MAX} custom agents. Remove one first.`) : refuse('bad_command', 'That command could not be saved.', 'command');
  cacheEntry(entry);
  alog('info', 'custom agent added', { agent: id });
  return { status: 200, body: { ok: true, agent: agentRow(entry, await rowContext(r, saved.settings)) } };
}

/** POST /api/assistant/agents/custom/remove {id}. */
export async function removeCustomAgentRequest(body: Record<string, unknown>): Promise<Answer> {
  const id = body.id;
  const settings = await loadSettings();
  // The same 404 as the other agent routes' (a known agent is no custom one either).
  const unknown: Answer = { status: 404, body: { ok: false, code: 'agent_unknown', error: `No custom agent called ${cleanText(id, 40) || '(none)'}. Settings → Assistant lists them.` } };
  if (typeof id !== 'string' || !settings.custom_agents.some((c) => c.id === id)) return unknown;
  const name = settings.custom_agents.find((c) => c.id === id)?.name ?? id;
  if (hooks().running(id)) return { status: 409, body: { ok: false, code: 'agent_running', error: `${name} is working on a message. Stop it first.` } };
  if (!(await removeCustomAgent(id))) return unknown;
  uncacheEntry(id);
  rememberAgentLast(id, null);
  rememberAgentSignIn(id, null);
  rememberAgentWord(id, null);
  rememberAgentImages(id, null, null);
  // Saved first, so no new turn starts; then a session kept between messages ends too.
  await hooks().stop(id, `${name} was removed in Settings.`);
  alog('info', 'custom agent removed', { agent: id });
  return { status: 200, body: { ok: true } };
}

/**
 * POST /api/assistant/agents/allow {id, allow, fingerprint?} (spec 4.9). Off is always taken,
 * needs no fingerprint, and stops that agent's turns and processes before it answers. On needs
 * the fingerprint of the command the row shows, and is refused while that agent runs.
 */
export async function allowAgentRequest(r: AgentRouteContext, body: Record<string, unknown>): Promise<Answer> {
  const id = body.id;
  const settings = await loadSettings();
  if (!isAgentOf(settings, id)) return { status: 404, body: { ok: false, code: 'agent_unknown', error: `No coding agent called ${cleanText(id, 40) || '(none)'}. Settings → Assistant lists them.` } };
  if (typeof body.allow !== 'boolean') return { status: 400, body: { ok: false, code: 'bad_request', error: 'allow must be true or false.' } };
  const name = knownAgent(id)?.name ?? settings.custom_agents.find((c) => c.id === id)?.name ?? id;
  if (body.allow === false) {
    // Saved first, so no new turn starts; then what runs stops, even when the save failed:
    // this is the kill switch.
    let next: AssistantSettings | null = null;
    let saveError: unknown = null;
    try {
      next = await setAgentAllowed(id, null);
    } catch (err) {
      saveError = err;
    }
    await hooks().stop(id, `${name} was turned off in Settings.`);
    if (!next) {
      alog('error', 'agent allow switch could not be saved off; the agent was stopped', { agent: id, error: cleanText(String((saveError as Error)?.message ?? saveError), 200) });
      return { status: 500, body: { ok: false, code: 'save_failed', error: `${name} was stopped, but Magnusim couldn't save its switch as off. Turn it off again.` } };
    }
    alog('info', 'agent allow switch off', { agent: id });
    const e = await resolveAgentNow(id, next);
    return { status: 200, body: { ok: true, agent: e ? agentRow(e, await rowContext(r, next)) : null } };
  }
  if (hooks().running(id)) return { status: 409, body: { ok: false, code: 'agent_running', error: `${name} is working on a message. Stop it, then allow it.` } };
  const e = await resolveAgentNow(id, settings);
  if (!e) return { status: 404, body: { ok: false, code: 'agent_unknown', error: `No coding agent called ${cleanText(id, 40)}. Settings → Assistant lists them.` } };
  const ctx = await rowContext(r, settings);
  const row = agentRow(e, ctx);
  if (!e.found) return { status: 409, body: { ok: false, code: 'agent_missing', error: `${name} isn't installed on this PC.`, agent: row } };
  if (e.error) return { status: 409, body: { ok: false, code: e.error.code, error: e.error.message, agent: row } };
  if (!row.needs_allow) return { status: 409, body: { ok: false, code: 'allow_not_needed', error: `${name}'s own tools are off while it works for Magnusim; it needs no switch.`, agent: row } };
  if (typeof body.fingerprint !== 'string' || body.fingerprint !== e.fingerprint) {
    return { status: 409, body: { ok: false, code: 'fingerprint_changed', error: `${name}'s command or program changed. Look at it again before you allow it.`, agent: row } };
  }
  const next = await setAgentAllowed(id, { fingerprint: e.fingerprint as string });
  alog('info', 'agent allow switch on', { agent: id });
  return { status: 200, body: { ok: true, agent: agentRow(e, await rowContext(r, next)) } };
}
