/**
 * DPAPI for this Windows account through Windows PowerShell 5.1 (Foundation spec 3.3).
 *
 * Node has no DPAPI of its own, so a fixed script runs in powershell.exe (by its absolute
 * path) as -EncodedCommand. The script holds no secret; the bytes to protect or unprotect
 * travel only on stdin ("<op>\n<base64>"), never in the command line, which any process
 * can read (CIM's Win32_Process), and the answer comes back on stdout.
 *
 * Always an async spawn, never spawnSync (it would stop the server for the whole run):
 * one run takes about 0.4 s. Stdout is capped at 64 KB and stderr at 8 KB; after 20 s
 * the helper is killed. Its failures become ProtectorError codes:
 * - cant_unlock: the master can't be unprotected on this account (another user or PC);
 * - blocked: PowerShell is missing, or Constrained Language Mode, AppLocker/WDAC or an
 *   antivirus stops it;
 * - timeout; failed (anything else).
 * The detail is the first stderr line, redacted.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { redact } from '../redact.ts';
import { ProtectorError, type MasterDoc, type Protector } from './protector.ts';

/** The helper. Exit 3: can't unprotect; exit 4: not in full language mode (blocked). */
export const DPAPI_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  // Progress records would reach stderr as CLIXML.
  `$ProgressPreference = 'SilentlyContinue'`,
  `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { [Console]::Error.WriteLine('blocked: PowerShell language mode is ' + $ExecutionContext.SessionState.LanguageMode); exit 4 }`,
  `try {`,
  `  Add-Type -AssemblyName System.Security`,
  `  $op = [Console]::In.ReadLine()`,
  `  $data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())`,
  `  $entropy = [Text.Encoding]::UTF8.GetBytes('Magnusim assistant master v1')`,
  `  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser`,
  `  if ($op -eq 'protect') { $out = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) }`,
  `  elseif ($op -eq 'unprotect') { $out = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) }`,
  `  else { throw 'unknown operation' }`,
  `  [Console]::Out.Write([Convert]::ToBase64String($out))`,
  `} catch {`,
  `  $e = $_.Exception`,
  `  while ($e) { if ($e -is [Security.Cryptography.CryptographicException]) { [Console]::Error.WriteLine('cant_unlock: ' + $e.Message); exit 3 }; $e = $e.InnerException }`,
  `  [Console]::Error.WriteLine($_.Exception.Message)`,
  `  exit 1`,
  `}`,
].join('\n');

/** -EncodedCommand takes UTF-16LE in base64. A constant: it holds no secret. */
export const SCRIPT_B64 = Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64');

export const POWERSHELL_ARGS: readonly string[] = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  SCRIPT_B64,
]);

const STDOUT_CAP = 64 * 1024;
const STDERR_CAP = 8 * 1024;
export const DPAPI_TIMEOUT_MS = 20_000;

/** Windows PowerShell 5.1, by its absolute path (never whatever `powershell` PATH finds). */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export type SpawnLike = typeof nodeSpawn;

export interface DpapiOptions {
  timeoutMs?: number;
  /** Tests: a spy around child_process.spawn. */
  spawnImpl?: SpawnLike;
}

const BLOCKED_TEXT = /language mode|blocked by (group policy|your system administrator)|has been blocked|applocker|device guard|application control/i;

/** Runs the helper once: protect or unprotect `data`. */
export function runDpapi(op: 'protect' | 'unprotect', data: Buffer, o: DpapiOptions = {}): Promise<Buffer> {
  const spawnImpl = o.spawnImpl ?? nodeSpawn;
  const timeoutMs = o.timeoutMs ?? DPAPI_TIMEOUT_MS;
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (err: ProtectorError | null, out?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out as Buffer);
    };
    let child: ReturnType<SpawnLike>;
    try {
      child = spawnImpl(powershellPath(), [...POWERSHELL_ARGS], { windowsHide: true, stdio: 'pipe' });
    } catch (err) {
      reject(new ProtectorError('blocked', redact(String((err as { code?: string })?.code || (err as Error)?.message || err))));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(new ProtectorError('timeout', `no answer in ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < STDOUT_CAP) stdout += d.slice(0, STDOUT_CAP - stdout.length);
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < STDERR_CAP) stderr += d.slice(0, STDERR_CAP - stderr.length);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      // Not started at all: missing, or refused by policy.
      finish(new ProtectorError('blocked', redact(err.code || err.message)));
    });
    child.stdin?.on('error', () => {
      /* the helper ended before reading; its exit says why */
    });
    child.on('close', (code: number | null) => {
      // The first plain line (PowerShell may wrap records in CLIXML).
      const plain = stderr.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#< CLIXML') && !l.startsWith('<Objs'));
      const firstLine = redact(plain || '').slice(0, 300);
      if (code === 0) {
        const text = stdout.trim();
        if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) finish(null, Buffer.from(text, 'base64'));
        else finish(new ProtectorError('failed', 'the helper answered no data'));
        return;
      }
      if (code === 3 && op === 'unprotect') finish(new ProtectorError('cant_unlock', firstLine));
      else if (code === 4 || BLOCKED_TEXT.test(stderr)) finish(new ProtectorError('blocked', firstLine));
      else finish(new ProtectorError('failed', firstLine || `exit code ${code}`));
    });
    child.stdin?.end(`${op}\n${data.toString('base64')}\n`);
  });
}

export function dpapiProtector(o: DpapiOptions = {}): Protector {
  return {
    kind: 'dpapi',
    knownUnavailable: null,
    async protect(master: Buffer): Promise<MasterDoc> {
      const blob = await runDpapi('protect', master, o);
      return { version: 1, protector: 'dpapi', blob: blob.toString('base64'), created_at: new Date().toISOString() };
    },
    async unprotect(doc: MasterDoc): Promise<Buffer> {
      if (doc.protector !== 'dpapi' || typeof doc.blob !== 'string' || !doc.blob) {
        throw new ProtectorError('cant_unlock', 'the master key was not kept by this account');
      }
      const master = await runDpapi('unprotect', Buffer.from(doc.blob, 'base64'), o);
      if (master.length !== 32) throw new ProtectorError('cant_unlock', 'the master key is damaged');
      return master;
    },
  };
}
