/**
 * A reader holding a file open on Windows: PowerShell opens it for reading without
 * delete sharing (as the worker's field reader does), so Windows refuses to delete it
 * or its folder until the reader lets go.
 */
import { spawn } from 'node:child_process';

/** Skip reason for a test that needs Windows file locks, or false on Windows. */
export const WINDOWS_ONLY = process.platform === 'win32' ? false : 'Windows file locks only';

/**
 * Hold `file` open for `ms`. Resolves once it is held, with `done` (the reader exited).
 * @param {string} file
 * @param {number} ms
 * @returns {Promise<{ done: Promise<unknown> }>}
 */
export function holdOpen(file, ms) {
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$f = [System.IO.File]::Open('${file}', 'Open', 'Read', 'Read'); 'held'; Start-Sleep -Milliseconds ${ms}; $f.Close()`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  );
  const done = new Promise((resolve) => ps.on('exit', resolve));
  return new Promise((resolve, reject) => {
    let out = '';
    ps.stdout.on('data', (d) => {
      out += String(d);
      if (out.includes('held')) resolve({ done });
    });
    ps.on('error', reject);
    ps.on('exit', (code) => reject(new Error(`the reader exited (${code}) before holding ${file}`)));
  });
}
