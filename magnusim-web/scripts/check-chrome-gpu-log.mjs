// Chrome's own log of a browser suite (Playwright's DEBUG=pw:browser written to DEBUG_FILE)
// must not say Chrome lost its GPU. On GitHub's GPU-less Linux runners a WebGPU page can lose
// its GPU while its tests still pass (2026-11-14: the 2D Wind Tunnel's), so CI runs this after
// that suite. No log, or a log with no browser launched in it, fails too: no log is not a pass.
//
//   node scripts/check-chrome-gpu-log.mjs <log file>
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What Chrome writes when its GPU process, or a page's hold on it, is lost. */
export const GPU_LOST = [/Unable to create shared image/, /Instance reference no longer exists/, /Unable to initialize SkSurface/, /GPU process exited unexpectedly/, /GPU process isn't usable/];

/** A log's browsers launched and its lines saying the GPU was lost. */
export function readGpuLog(text) {
  const lines = text.split(/\r?\n/);
  return {
    launched: lines.filter((l) => l.includes('<launched>')).length,
    lost: lines.filter((l) => GPU_LOST.some((re) => re.test(l))),
  };
}

function main() {
  const file = process.argv[2];
  if (!file || !existsSync(file)) {
    console.error(`Chrome's log ${file ?? '(none named)'} was not written: the GPU check cannot be made`);
    return 1;
  }
  const { launched, lost } = readGpuLog(readFileSync(file, 'utf8'));
  if (!launched) {
    console.error(`Chrome's log ${file} has no browser launched in it: the GPU check cannot be made`);
    return 1;
  }
  if (lost.length) {
    console.error(`Chrome lost its GPU (${lost.length} lines):\n  ${lost.slice(0, 10).join('\n  ')}`);
    return 1;
  }
  console.log(`Chrome kept its GPU: ${launched} browsers launched, no line saying the GPU was lost`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
