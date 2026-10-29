// The third-party notices of what Magnusim CAD's installer ships, made from the lockfiles at
// build time (never by hand): every production npm package of the app and of the CAD plugin,
// with its licence text; the CAD plugin's WebAssembly components (from the repository's
// THIRD_PARTY_NOTICES.md, with where their source is); Electron and Chromium. A package with
// no licence, or one GPL-3.0-or-later cannot take, fails the build.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Licences GPL-3.0-or-later can take (SPDX ids). */
export const COMPATIBLE = new Set([
  '0BSD',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/** Whether an SPDX expression may ship with a GPL-3.0-or-later app (OR: any side; AND: every side). */
export function compatible(expr) {
  const text = String(expr || '').trim().replace(/^\((.*)\)$/, '$1');
  if (!text) return false;
  if (/\sOR\s/i.test(text)) return text.split(/\s+OR\s+/i).some((x) => compatible(x));
  if (/\sAND\s/i.test(text)) return text.split(/\s+AND\s+/i).every((x) => compatible(x));
  return COMPATIBLE.has(text.replace(/\+$/, ''));
}

const MIT_TEXT = /Permission\s+is\s+hereby\s+granted,\s+free\s+of\s+charge,\s+to\s+any\s+person\s+obtaining\s+a\s+copy/;

function licenceFile(dir) {
  try {
    const name = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
    return name ? readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim() : '';
  } catch {
    return '';
  }
}

/** The production packages of a lockfile (v2/v3): name, version, folder. */
export function productionPackages(lockPath, nodeModules) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || entry.dev || entry.devOptional) continue;
    const at = key.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const name = key.slice(at + 'node_modules/'.length);
    const dir = join(nodeModules, '..', key);
    // A platform's optional binary that is not this PC's (esbuild's) is not installed or shipped.
    if (!existsSync(dir)) continue;
    out.push({ name, version: String(entry.version || ''), dir, declared: entry.license });
  }
  return out;
}

/** Each package's licence: its package.json's, else what its licence file says. Throws on a problem. */
export function licenceRows(packages) {
  const rows = new Map();
  const problems = [];
  for (const p of packages) {
    const key = `${p.name}@${p.version}`;
    if (rows.has(key)) continue;
    let pkg = {};
    try {
      pkg = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
    } catch {
      /* the lockfile's word */
    }
    const field = pkg.license ?? p.declared;
    let licence = typeof field === 'string' ? field : field && typeof field.type === 'string' ? field.type : '';
    // npm's old form: "licenses": [{ "type": "MIT" }, ...] (any of them).
    if (!licence && Array.isArray(pkg.licenses)) licence = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(' OR ');
    const text = licenceFile(p.dir);
    if (!licence && MIT_TEXT.test(text)) licence = 'MIT';
    if (!licence) problems.push(`${key}: no licence`);
    else if (!compatible(licence)) problems.push(`${key}: ${licence} cannot ship with GPL-3.0-or-later`);
    rows.set(key, { name: p.name, version: p.version, licence, text, homepage: String(pkg.homepage || pkg.repository?.url || pkg.repository || '') });
  }
  if (problems.length) throw new Error(`third-party licences:\n  ${problems.join('\n  ')}`);
  return [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
}

/** The repository notices' section on the CAD plugin (its WebAssembly components and their sources). */
export function cadSection(repoNotices) {
  const text = readFileSync(repoNotices, 'utf8').replace(/\r\n/g, '\n');
  const m = /^## Magnusim CAD plugin\n([\s\S]*?)(?=^## )/m.exec(text);
  if (!m) throw new Error(`${repoNotices} has no "## Magnusim CAD plugin" section`);
  return m[1].trim();
}

/**
 * What a copy of Magnusim CAD's code is copied from (`copiedFrom`: repo, label, commit, changed),
 * in words, for the installer's notices and the copy's README: a development snapshot (no commit:
 * not published) by its label, "Magnusim's development version 0.5.0-dev (2026-10-29), <repo>";
 * a release export by its release, when it has one, and its commit, "Magnusim v0.5.0, <repo>, at
 * commit <sha>". `changed`: files an --allow-dirty export took from a working tree.
 */
export function copiedFromWords({ repo, label = '', commit = '', changed = 0 }) {
  const what = commit ? `Magnusim${label ? ` ${label}` : ''}, ${repo}, at commit ${commit}` : `Magnusim's ${label || 'development version'}, ${repo}`;
  return `${what}${changed ? ` (with ${changed} files changed from ${commit ? 'that commit' : 'it'})` : ''}`;
}

/** `text` in lines of at most `width` characters (a longer word gets a line of its own). */
function wrap(text, width = 78) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * THIRD_PARTY_NOTICES.txt as the installer ships it. Its source is `repo` (at `commit`), or, for
 * a build from the Magnusim CAD repository, that repository (`repo`) with what its code was copied
 * from (`copiedFrom`, as copiedFromWords takes it).
 */
export function noticesText({ version, commit, repo, copiedFrom, cad, rows, electron }) {
  const rule = '='.repeat(78);
  const source = copiedFrom ? wrap(`Magnusim CAD repository, ${repo}, whose code is copied from ${copiedFromWords(copiedFrom)}.`) : [`Magnusim repository, ${repo}${commit ? `, at commit ${commit}` : ''}.`];
  const out = [
    `Magnusim CAD ${version}: third-party software`,
    rule,
    '',
    'Magnusim CAD is free software under the GNU General Public License, version 3 or',
    '(at your option) any later version: LICENSE, next to this file. Its source is the',
    ...source,
    '',
    'It ships the software below, each under its own licence.',
    '',
    rule,
    'The CAD workspace: modeling kernel and sketch solver (WebAssembly)',
    rule,
    '',
    cad,
    '',
    'Their licence texts are in resources\\app\\bundled-plugins\\cad\\LICENSES. The',
    'corresponding sources, pinned to exact upstream commits with our patches and the',
    'scripts that rebuild both modules, are in the repository above, under',
    'magnusim-web/bundled-plugins/cad/kernel-build and solver-build.',
    '',
    rule,
    `Electron ${electron} and Chromium`,
    rule,
    '',
    "Electron (MIT): LICENSE.electron.txt. Chromium and the libraries it includes: their",
    'licences are in LICENSES.chromium.html. Both are next to Magnusim CAD.exe.',
    '',
    rule,
    `npm packages (${rows.length})`,
    rule,
  ];
  for (const r of rows) {
    out.push('', '-'.repeat(78), `${r.name} ${r.version}: ${r.licence}${r.homepage ? `\n${r.homepage}` : ''}`, '-'.repeat(78));
    if (r.text) out.push('', r.text);
  }
  return `${out.join('\n')}\n`;
}
