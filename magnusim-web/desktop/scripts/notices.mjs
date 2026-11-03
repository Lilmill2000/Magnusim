// The third-party notices of what Magnusim CAD's installer ships, made from the lockfiles at
// build time (never by hand): every production npm package of the app and of the CAD plugin,
// with its licence text; the CAD plugin's WebAssembly components (from the repository's
// THIRD_PARTY_NOTICES.md, with where their source is); Electron and Chromium. A package with
// no licence, one GPL-3.0-or-later cannot take, or one with no licence text where its licence
// asks for its notice, fails the build.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The MIT licence's permission notice, for a package that names MIT and ships no text of it. */
const MIT_LICENCE = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Licences that ask for no notice: a package under one of them may have no text. */
const NO_NOTICE = new Set(['0BSD', 'CC0-1.0', 'MIT-0', 'Unlicense', 'WTFPL']);

/** A platform's binary package ships no licence of its own: its main package's covers its code (OWN_NOTICES adds what the binary links in). */
const MAIN_PACKAGE = [
  [/^@esbuild\//, 'esbuild'],
  [/^@rollup\/rollup-/, 'rollup'],
];

/** Licence texts no package ships (licence-texts/README.md says where each comes from). */
const TEXTS = join(dirname(fileURLToPath(import.meta.url)), 'licence-texts');

/**
 * Code a package ships under its own authors' notice, besides the package's licence, as checked
 * at `version`: `file` in the package, and its notice, the comments that file opens with or the
 * licence text `text` (in licence-texts/) for what `about` says. A package at another version,
 * or without the file, fails the build until it is checked again.
 */
const OWN_NOTICES = {
  seedrandom: { version: '3.0.5', notices: [{ file: 'lib/alea.js' }] },
  '@kitware/vtk.js': {
    version: '32.14.0',
    notices: [{ file: 'macros2.js', about: "normalizeWheel in macros2.js, from Facebook's fixed-data-table (Copyright (c) 2015, Facebook, Inc.)", text: 'fixed-data-table-LICENSE.txt' }],
  },
  standardwebhooks: {
    version: '1.1.1',
    notices: [{ file: 'dist/timing_safe_equal.js', about: 'dist/timing_safe_equal.js, from the Deno standard library ("Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.")', text: 'deno-std-LICENSE.txt' }],
  },
  '@esbuild/win32-x64': {
    version: '0.25.12',
    notices: [{ file: 'esbuild.exe', about: "esbuild.exe is a Go program: it holds Go 1.23.12's runtime and standard library and golang.org/x/sys, under the Go authors' licence", text: 'go-LICENSE.txt' }],
  },
};

const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();

/** The licence file a package states its licence in (LICENSE, LICENCE or COPYING, .md or .txt): the only one its licence is read from when package.json names none. */
const OWN_LICENCE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/** Every licence file in `dir` (LICENSE, LICENCE or COPYING, any suffix: LICENSE-MIT.txt, LICENSE.BSD; a dual licence has two), in name order. */
function licenceFiles(dir, names = /^(licen[cs]e|copying)([-.][\w.-]*)?$/i) {
  try {
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && names.test(e.name))
      .map((e) => e.name)
      .sort();
    return found.map((n) => readText(join(dir, n))).filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}

/** The licence section of a package's README ("## License", or "LICENSE (MIT)" over a rule), when it holds a copyright notice. */
export function readmeLicence(dir) {
  let lines;
  try {
    const name = readdirSync(dir).find((f) => /^readme(\.(md|markdown|txt))?$/i.test(f));
    if (!name) return '';
    lines = readText(join(dir, name)).split('\n');
  } catch {
    return '';
  }
  const atx = (i) => /^#{1,6}\s/.test(lines[i]);
  const setext = (i) => i + 1 < lines.length && lines[i].trim() !== '' && /^(-{3,}|={3,})\s*$/.test(lines[i + 1]);
  const start = lines.findIndex((l, i) => (atx(i) || setext(i)) && /^(#{1,6}\s*)?licen[cs]e\b/i.test(l));
  if (start < 0) return '';
  let end = start + (setext(start) ? 2 : 1);
  while (end < lines.length && !atx(end) && !setext(end)) end++;
  const section = lines.slice(start, end).join('\n').trim();
  return /copyright/i.test(section) ? section : '';
}

/** The comments a file opens with (`//` lines and block comments, blank lines between them), as text. */
function leadingComment(file) {
  const out = [];
  let block = false;
  for (const line of readText(file).split('\n')) {
    const t = line.trim();
    if (block) {
      out.push(t.replace(/\*\/\s*$/, '').replace(/^\*\s?/, ''));
      if (t.endsWith('*/')) block = false;
    } else if (t === '') out.push('');
    else if (t.startsWith('//')) out.push(t.replace(/^\/\/\s?/, ''));
    else if (t.startsWith('/*')) {
      out.push(t.replace(/^\/\*+\s?/, '').replace(/\*\/\s*$/, ''));
      block = !(t.length > 3 && t.endsWith('*/'));
    } else break;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A package's licence text: its licence files (`files`), else its main package's, else its
 * README's licence section, else MIT's notice for a package that names MIT; then the notices
 * of its files that carry their own (OWN_NOTICES). What OWN_NOTICES cannot find goes to `problems`.
 */
function licenceText(p, licence, pkg, files, problems) {
  let text = files;
  const main = MAIN_PACKAGE.find(([re]) => re.test(p.name));
  if (!text && main) text = licenceFiles(join(p.dir, ...p.name.split('/').map(() => '..'), main[1]));
  if (!text) text = readmeLicence(p.dir);
  if (!text && licence === 'MIT') {
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
    text = `This package ships no licence text. Its package.json gives its licence as MIT${author ? ` and its author as ${author}` : ''}; the MIT licence reads:\n\n${MIT_LICENCE}`;
  }
  const own = OWN_NOTICES[p.name];
  if (own && own.version !== p.version) problems.push(`${p.name}@${p.version}: its own notices (OWN_NOTICES in desktop/scripts/notices.mjs) were checked at ${own.version}; check this version's files and update them`);
  for (const n of own && own.version === p.version ? own.notices : []) {
    const there = existsSync(join(p.dir, n.file));
    const notice = !there ? '' : n.text ? readText(join(TEXTS, n.text)) : leadingComment(join(p.dir, n.file));
    if (notice) text = `${text}\n\n${n.about || n.file}:\n\n${notice}`;
    else problems.push(`${p.name}@${p.version}: no notice for ${n.file} (OWN_NOTICES in desktop/scripts/notices.mjs): ${there ? 'it opens with no comment' : 'the package has no such file'}`);
  }
  return text.trim();
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

/** Each package's licence (its package.json's, else what its licence file says) and its text (licenceText). Throws on a problem. */
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
    const files = licenceFiles(p.dir);
    if (!licence && MIT_TEXT.test(licenceFiles(p.dir, OWN_LICENCE_FILE))) licence = 'MIT';
    const text = licence ? licenceText(p, licence, pkg, files, problems) : '';
    if (!licence) problems.push(`${key}: no licence`);
    else if (!compatible(licence)) problems.push(`${key}: ${licence} cannot ship with GPL-3.0-or-later`);
    else if (!text && !NO_NOTICE.has(licence)) problems.push(`${key}: ${licence}, and no licence text in the package (say where it is in desktop/scripts/notices.mjs)`);
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
