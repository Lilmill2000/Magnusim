// Test support: which of the pids a test file recorded still run as one of its own processes.
// A pid the OS has given to another program since (the full suite starts many processes, and
// Windows reuses pids soon) is none of them, so a file's end signals only these.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Whether `pid` still runs (Linux: not a zombie; EPERM: another account's, still running). */
export function alive(pid) {
  if (!pid) return false;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** The command lines of the running `pids` (pid -> text), or null when the OS can't say. */
export function commandLines(pids) {
  const out = new Map();
  if (!pids.length) return out;
  try {
    if (process.platform === 'linux') {
      for (const pid of pids) {
        try {
          out.set(pid, readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '));
        } catch {
          /* gone */
        }
      }
    } else if (process.platform === 'win32') {
      const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const filter = pids.map((pid) => `ProcessId=${Number(pid)}`).join(' OR ');
      const text = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }`], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      });
      for (const line of text.split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab > 0) out.set(Number(line.slice(0, tab)), line.slice(tab + 1));
      }
    } else {
      for (const pid of pids) {
        try {
          out.set(pid, execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }));
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * Of `pids`, those still running whose command line holds one of `marks` (compared without case,
 * with / for \). When the OS can't say, every running one counts.
 */
export function ownRunning(pids, marks) {
  const running = [...new Set(pids)].filter(alive);
  const lines = commandLines(running);
  if (lines === null) return running;
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, '/');
  const ms = marks.filter(Boolean).map(norm);
  return running.filter((pid) => {
    const line = lines.get(pid);
    return typeof line === 'string' && ms.some((m) => norm(line).includes(m));
  });
}

/** SIGKILL to each of `pids` still running as one of this file's processes (see ownRunning). Returns them. */
export function killOwn(pids, marks) {
  const own = ownRunning(pids, marks);
  for (const pid of own) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  return own;
}
