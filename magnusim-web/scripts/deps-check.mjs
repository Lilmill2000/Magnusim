// Are the app's packages installed, each at the version package-lock.json records?
// run.bat and setup/Setup.ps1 ask before they skip an install, so a copy installed
// by an older release gets the packages a newer one added (their old check only
// looked for vite and vtk.js).
//
//   node scripts/deps-check.mjs [web folder]   (default: the folder above this script)
//
// Exit 0: every key of package.json "dependencies" is in node_modules at its lockfile
// version (a key the lockfile gives no version, such as a link, only has to be there).
// Exit 1: one is missing or at another version, or package.json can't be read. Each
// problem is one line on stdout, not stderr: Setup.ps1 runs under Windows PowerShell
// 5.1 with $ErrorActionPreference 'Stop', where a native program's stderr can turn
// into an error.
//
// It reads node_modules/<name>/package.json itself, never through require.resolve:
// a package's "exports" map need not list ./package.json.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * What is wrong with the installed packages of `webRoot`, one plain line each;
 * an empty list when every "dependencies" key is in place.
 * @param {string} webRoot
 * @returns {string[]}
 */
export function depsProblems(webRoot) {
  let deps;
  try {
    deps = readJson(join(webRoot, 'package.json')).dependencies || {};
  } catch (e) {
    return [`package.json can't be read: ${e instanceof Error ? e.message : String(e)}`];
  }
  let locked = {};
  try {
    locked = readJson(join(webRoot, 'package-lock.json')).packages || {};
  } catch {
    // No lockfile (or an unreadable one): each package only has to be there.
  }
  const problems = [];
  for (const name of Object.keys(deps).sort()) {
    const want = locked[`node_modules/${name}`]?.version;
    let have;
    try {
      have = readJson(join(webRoot, 'node_modules', ...name.split('/'), 'package.json')).version;
    } catch {
      problems.push(`${name} is not installed${want ? ` (the lockfile has ${want})` : ''}`);
      continue;
    }
    if (want && have !== want) problems.push(`${name} is ${have ?? 'of no version'}, the lockfile has ${want}`);
  }
  return problems;
}

function main() {
  const problems = depsProblems(resolve(process.argv[2] || WEB_ROOT));
  for (const line of problems) console.log(line);
  return problems.length ? 1 : 0;
}

// exitCode, not exit(): the lines above reach a pipe in full first.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
