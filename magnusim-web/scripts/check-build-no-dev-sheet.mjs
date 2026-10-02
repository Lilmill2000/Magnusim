// The production build ships no UI kit dev sheet (H14). The sheet's route in
// src/app/main.tsx sits behind import.meta.env.DEV, so `vite build` drops it and
// its page; this fails when any file under dist/ still names it. Run it after
// `npm run build` (CI does).
//
//   node scripts/check-build-no-dev-sheet.mjs [dist folder]
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Text only the dev sheet carries: its specimen attributes and its frame files. */
export const DEV_SHEET_MARKERS = ['data-kit-sheet', 'ui-kit-sheet'];

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/**
 * Every file under `dir` that holds a dev sheet marker, as { file, marker } with
 * the path relative to `dir`. A missing folder throws: no build is not a pass.
 */
export function findDevSheet(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder; run npm run build first`);
  const found = [];
  for (const file of files(dir)) {
    const text = readFileSync(file).toString('latin1');
    for (const marker of DEV_SHEET_MARKERS) {
      if (text.includes(marker)) found.push({ file: relative(dir, file).split(sep).join('/'), marker });
    }
  }
  return found;
}

function main() {
  const dist = resolve(process.argv[2] || join(WEB_ROOT, 'dist'));
  let found;
  try {
    found = findDevSheet(dist);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (found.length) {
    console.error(`the production build holds the UI kit dev sheet:\n  ${found.map((f) => `${f.file}: ${f.marker}`).join('\n  ')}`);
    return 1;
  }
  console.log(`no dev sheet in ${relative(WEB_ROOT, dist) || dist}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
