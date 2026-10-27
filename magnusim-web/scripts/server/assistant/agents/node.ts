/**
 * The Node.js a coding agent runs on: its script, the Windows launcher (launch.mjs) and the
 * MCP bridge it starts. In Magnusim that is Magnusim's own Node (process.execPath). In the
 * desktop app (Magnusim CAD, Electron) process.execPath is the app itself, which would start a
 * second app window, not Node; ELECTRON_RUN_AS_NODE is never passed to an agent (process.ts
 * NEVER_RE), so the agent runs on the Node.js found on PATH, which an agent installed with npm
 * needs anyway. None there, or only one older than MIN_AGENT_NODE: agents can't start, and say
 * why (needsNodeText).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as FS, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const NEEDS_NODE_CODE = 'needs_node';
export const NEEDS_NODE_TEXT = 'Coding agents need Node.js on this PC. Install it from nodejs.org, then start Magnusim CAD again.';

/**
 * The oldest Node.js the coding agents run on: the highest floor in the known agents' package.json
 * engines (known.ts; read on npm 2026-10-27): @agentclientprotocol/claude-agent-acp 0.98.0 ">=22",
 * @xai-official/grok 1.0.70 ">=20", @google/gemini-cli 0.65.0 ">=20"; @agentclientprotocol/codex-acp
 * and opencode-ai declare none (native programs). launch.mjs and the MCP bridge
 * (scripts/assistant-mcp.mjs) need less: plain ESM with node: modules, ?. and ?? (Node 14).
 */
export const MIN_AGENT_NODE: readonly [number, number, number] = [22, 0, 0];

const MIN_TEXT = MIN_AGENT_NODE[1] || MIN_AGENT_NODE[2] ? MIN_AGENT_NODE.join('.') : String(MIN_AGENT_NODE[0]);

export interface NodeLookup {
  /** process.versions.electron (set: running inside Electron). */
  electron?: string | undefined;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** A node's version as `node --version` prints it, or null when it doesn't run (tests stub it). */
  versionOf?: (path: string) => string | null;
}

function pathOf(env: NodeJS.ProcessEnv, win: boolean): string {
  if (!win) return String(env.PATH ?? '');
  return String(Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '');
}

function runnable(p: string, win: boolean): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!win) accessSync(p, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Run once per node looked at, cached with the PATH (a running app keeps the PATH it started with).
function nodeVersion(p: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env });
    return r.status === 0 ? String(r.stdout).trim() : null;
  } catch {
    return null;
  }
}

/** true or false against MIN_AGENT_NODE; null when the text is not a version. */
function newEnough(version: string): boolean | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== MIN_AGENT_NODE[i]) return v[i] > MIN_AGENT_NODE[i];
  return true;
}

interface Found {
  key: string;
  node: string | null;
  /** With no node taken: the version of the first one passed over as too old. */
  old: string | null;
}

let cached: Found | null = null;

/** Inside Electron: the first node on PATH that runs and is new enough (see the file's note). */
function lookup(o: NodeLookup, execPath: string): Found {
  const platform = o.platform ?? process.platform;
  const win = platform === 'win32';
  const P = win ? win32 : posix;
  const env = o.env ?? process.env;
  const search = pathOf(env, win);
  const key = `${platform}|${execPath}|${search}`;
  if (cached && cached.key === key) return cached;
  const versionOf = o.versionOf ?? ((p: string) => nodeVersion(p, env));
  const same = (a: string, b: string) => (win ? P.resolve(a).toLowerCase() === P.resolve(b).toLowerCase() : P.resolve(a) === P.resolve(b));
  const found: Found = { key, node: null, old: null };
  for (const raw of search.split(win ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !P.isAbsolute(dir)) continue;
    const p = P.join(dir, win ? 'node.exe' : 'node');
    // Never the app itself (a folder holding it named node.exe).
    if (!runnable(p, win) || same(p, execPath)) continue;
    // One that doesn't run or doesn't print a version is not a Node.js.
    const version = versionOf(p);
    const ok = version === null ? null : newEnough(version);
    if (ok === null) continue;
    if (!ok) {
      found.old ??= String(version).replace(/^v/, '');
      continue;
    }
    found.node = p;
    found.old = null;
    break;
  }
  cached = found;
  return found;
}

/** The Node.js agents run on (see the file's note), or null inside Electron with none on PATH new enough. */
export function agentNode(o: NodeLookup = {}): string | null {
  const electron = 'electron' in o ? o.electron : process.versions.electron;
  const execPath = o.execPath ?? process.execPath;
  if (!electron) return execPath;
  return lookup(o, execPath).node;
}

/** Why agents can't start when agentNode() is null: no Node.js on PATH, or only one too old (named). */
export function needsNodeText(o: NodeLookup = {}): string {
  const electron = 'electron' in o ? o.electron : process.versions.electron;
  if (!electron) return NEEDS_NODE_TEXT;
  const { old } = lookup(o, o.execPath ?? process.execPath);
  if (!old) return NEEDS_NODE_TEXT;
  return `Coding agents need Node.js ${MIN_TEXT} or newer on this PC (found ${old}). Install it from nodejs.org, then start Magnusim CAD again.`;
}
