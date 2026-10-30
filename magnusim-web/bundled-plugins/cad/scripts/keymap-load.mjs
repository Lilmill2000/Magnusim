// The command and keybinding registry (src/app/keymap.ts) loaded in Node for the build
// (scripts/build.mjs writes workspace/commands.json from it). It is compiled here (esbuild,
// through Vite) rather than read with Node's type stripping, which Node has by default only from
// 22.18, and the plugin's build names no Node version: keymap.ts has no runtime imports, so one
// file is the module.
// tests/app/keymap-load.test.ts loads it with type stripping turned off.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The registry module; `cache` is the folder the compiled copy is written to (under .cache/). */
export async function loadKeymap(cache = 'keymap') {
  const src = join(ROOT, 'src', 'app', 'keymap.ts');
  const { code } = await transformWithEsbuild(readFileSync(src, 'utf8'), src, { loader: 'ts', format: 'esm', target: 'es2022' });
  const dir = join(ROOT, '.cache', cache);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'keymap.mjs');
  writeFileSync(file, code);
  return import(`${pathToFileURL(file).href}?t=${Date.now()}`);
}
