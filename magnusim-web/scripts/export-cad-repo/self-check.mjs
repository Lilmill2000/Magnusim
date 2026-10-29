// The Magnusim CAD export's self-check: what the copy must hold and must never hold, checked in
// the written folder itself. scripts/export-cad-repo.mjs runs it after each export (a failed
// check fails the export) and on its own with --check <folder>, say after a build in the copy.
// node_modules and build output are not looked at (SKIPPED); everything else is. Every check
// runs, every offending path or line is listed, and EXPORT.json keeps each check's counts:
//   files    each file is a file of the exported commit (git ls-tree) with the bytes of its git
//            object (so the copy came from git, never from a working tree), or one the export
//            writes (GENERATED); the root files copied from Magnusim are its git objects too; a
//            file the export rewrites (its declared rewrites) is its git object with exactly those
//            edits applied again here, and a file it leaves out is not there; EXPORT.json's
//            "executables" are exactly the copy's files that git has as 100755;
//   ai       no AI-tool files or folders, no Co-Authored-By trailer anywhere, and no AI vendor or
//            tool name in the Markdown the export writes. The Assistant's provider code and
//            packages are the product's own, so its sources are not searched for vendor names;
//   models   no CAD, mesh or scan model, no test fixtures, samples or e2e, no person's model;
//   secrets  no env file, key or certificate file, and no text shaped like a key or a token;
//   paths    no path of this PC (a user's folder, Desktop/Code, a home folder) in any text
//            file, CAD's built workspace among them, but the generic ones in PATH_ALLOWED;
//   names    no private part's name (PRIVATE_NAMES) in any file, binaries too, but the hits in
//            NAMES_ALLOWED;
//   licence  GPL-3.0 in LICENSE and the app's package.json, the CAD plugin's LGPL licences, each
//            SPDX line Magnusim's sources have, and notices naming the kernel, the solver and
//            Electron, and not Python (nothing of Python's ships).
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Not looked at: npm installs, build output and build caches (the copy's .gitignore leaves them out too). */
export const SKIPPED = ['.git (the root)', 'node_modules', '<app>/dist', '<app>/desktop/build', '<app>/desktop/dist', '.cache'];

/** The files the export writes itself, at the copy's root and in the app's folder. */
export const generated = (appDir) => ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'EXPORT.json', '.gitignore', '.gitattributes', `${appDir}/package.json`, `${appDir}/package-lock.json`];

/** The Markdown the export writes (README.md from its folder, the notices it composes). */
const WRITTEN_MARKDOWN = ['README.md', 'THIRD_PARTY_NOTICES.md'];

/**
 * Binary files, by their extension: no text check reads them (the names check reads their
 * bytes). Every other file is text and read by every check, a stray NUL byte in it or not.
 */
export const BINARY = /\.(wasm|bin|webp|png|ico|icns|jpe?g|gif|bmp|tiff?|woff2?|ttf|otf|eot|zip|7z|gz|tgz|xz|bz2|tar|exe|dll|node|msi|pdf|mp[34]|webm|wav)$/i;

const AI_DIRS = new Set(['.claude', '.cursor', '.codex', '.continue']);
const AI_NAMES = /^(claude|agents|gemini)\.md$|^\.(cursorrules|windsurfrules|clinerules)$|^\.aider|\.mdc$/i;
const AI_TRAILER = /co-authored-by|generated with \[?claude code/gi;
/** Vendor and tool names, as names are written: the notices' npm package names (@anthropic-ai/sdk, openai) are lower case. */
const AI_WORDS = /Claude|Cursor|GPT|Copilot|Codex|Anthropic|OpenAI/g;

const MODEL_FILE = /\.(step|stp|iges|igs|brep|stl|obj|ply|3mf|f3d|sldprt|fcstd)$/i;
const DATA_DIR = /fixtures|samples|testdata|e2e/i;
/** A Part's model.json or view.json (the CAD plugin's MODEL_FORMAT, VIEW_FORMAT), or a project's own files by name. */
const MODEL_JSON = /"format"\s*:\s*"magnusim-cad\/[\w-]+"/;
const MODEL_JSON_NAMES = /^(glider|model|view|project)\.json$/i;

const SECRET_FILE = /^\.env|\.(pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)/i;
const SECRET_TEXT = [
  /sk-ant-[A-Za-z0-9-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /"api_key"\s*:\s*"[^"]+"/g,
  /Bearer [A-Za-z0-9._-]{20,}/g,
];

/**
 * This PC's paths: a Windows user's folder (as written, or escaped in a string), the account, the
 * code folder, and a Linux home folder: /home/ that starts a path (src/home/ and ../home/ are
 * the app's own folders).
 */
const MACHINE_PATHS = [/C:(?:\/|\\{1,2})Users(?:\/|\\{1,2})/gi, /\/Users\/drmil/gi, /drmil/gi, /\\{1,2}Desktop\\{1,2}Code/gi, /Desktop\/Code/gi, /(?<![\w.~-])\/home\//g];

/**
 * Paths in the copy that look like a PC's but are no PC's, each with why it may stay: the file
 * (in the copy) and the exact text found there.
 */
export const PATH_ALLOWED = [
  { path: 'magnusim-web/bundled-plugins/cad/workspace/kernel/mk32.mjs', text: 'HOME:"/home/web_user"', reason: "Emscripten's virtual file system in the page: its HOME, the same in every build" },
  { path: 'magnusim-web/bundled-plugins/cad/workspace/solver/planegcs.mjs', text: 'HOME:"/home/web_user"', reason: "Emscripten's virtual file system in the page: its HOME, the same in every build" },
  { path: 'magnusim-web/bundled-plugins/cad/kernel-build/SOURCES.md', text: 'No `/home/...` or other build-machine path', reason: 'the kernel build notes saying no such path is left in mk32.wasm' },
  { path: 'magnusim-web/scripts/server/cad-edition/serve.mjs', text: "'/home/cfddesk/cases'", reason: "Magnusim's built-in default WSL case folder (its own WSL account, the same on every PC), set so the WSL probe never runs" },
  { path: 'magnusim-web/scripts/wsl-env.js', text: "'/home/cfddesk/cases'", reason: "Magnusim's built-in default WSL case folder (its own WSL account, the same on every PC)" },
];

/** The name of Daniel's private part, which tests and notes in Magnusim use: never in the copy. */
const PRIVATE_NAMES = [/vortex/gi];

/**
 * Hits of PRIVATE_NAMES that stay, with why: the file in the copy, how many hits it has (one
 * more, or one fewer, fails the check) and, when given, the text each hit must be inside.
 */
export const NAMES_ALLOWED = [
  {
    path: 'magnusim-web/bundled-plugins/cad/kernel-build/facade/facade.cpp',
    count: 6,
    reason: "comments in the kernel's corresponding source (LGPL), kept as built: kernel-build/mk32.build.txt records the sha256 of facade/ (facade_sources), and an edited comment would no longer match it",
  },
  { path: 'magnusim-web/src/app/shell.html', count: 1, text: 'frames for vortex shedding', reason: "the physics term (a transient run's results), not a part's name" },
];

/**
 * A declared rewrite's edits applied to `text` (a file as the commit has it), in order: { find, put }
 * replaces that text, which must be there exactly once; { from, to, put } replaces the span from
 * `from` (there exactly once) up to the first `to` after it (`to` stays). Throws when one no
 * longer applies, so a rewrite that Magnusim's file outgrew stops the export.
 */
export function applyEdits(text, edits, where = 'a rewrite') {
  let out = text;
  edits.forEach((e, i) => {
    const what = `${where}, edit ${i + 1}`;
    const key = typeof e.find === 'string' ? e.find : e.from;
    if (typeof key !== 'string' || !key || typeof e.put !== 'string') throw new Error(`${what}: not { find, put } or { from, to, put }`);
    const at = out.indexOf(key);
    if (at < 0) throw new Error(`${what}: ${JSON.stringify(key.slice(0, 70))} is not there`);
    if (out.indexOf(key, at + 1) >= 0) throw new Error(`${what}: ${JSON.stringify(key.slice(0, 70))} is there more than once`);
    let end = at + key.length;
    if (typeof e.find !== 'string') {
      if (typeof e.to !== 'string' || !e.to) throw new Error(`${what}: { from } without { to }`);
      end = out.indexOf(e.to, end);
      if (end < 0) throw new Error(`${what}: ${JSON.stringify(e.to.slice(0, 70))} is not after ${JSON.stringify(key.slice(0, 40))}`);
    }
    out = out.slice(0, at) + e.put + out.slice(end);
  });
  return out;
}

/** Python files that may ship, with why: none of Python's runtime or packages ever does. */
const PYTHON_ALLOWED = {
  'bundled-plugins/cad/plugin.py': "the CAD plugin's register() stub for Magnusim's plugin host: it imports nothing, and Magnusim CAD runs no Python (desktop/scripts/build.mjs stages it with the manifest)",
};
const PYTHON_RUNTIME = /(^|\/)(site-packages|__pycache__)\/|\.(pyd|pyc|whl)$|(^|\/)python[\d.]*(\.exe|\.dll)?$|(^|\/)(requirements[\w-]*\.txt|pyproject\.toml|Pipfile)$/i;

const SPDX = /SPDX-License-Identifier:\s*([^\s*]+)/g;
const SOURCE = /\.(ts|tsx|mjs|cjs|js|css)$/;

function walk(out, appDir) {
  const skip = new Set([`${appDir}/dist`, `${appDir}/desktop/build`, `${appDir}/desktop/dist`]);
  const files = [];
  const links = [];
  const visit = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) links.push(r);
      else if (e.isDirectory()) {
        if ((!rel && e.name === '.git') || e.name === 'node_modules' || e.name === '.cache' || skip.has(r)) continue;
        visit(join(dir, e.name), r);
      } else files.push(r);
    }
  };
  visit(out, '');
  return { files: files.sort(), links };
}

/** Git's object id of these bytes (as `git hash-object` gives it). */
const objectId = (data, format) => createHash(format).update(`blob ${data.length}\0`).update(data).digest('hex');

/** `commit`'s files: repository path -> object id (`tree`), and -> git mode (`modes`: 100644, 100755). */
function treeOf(web, commit) {
  const tree = new Map();
  const modes = new Map();
  for (const entry of execFileSync('git', ['-C', web, 'ls-tree', '-r', '-z', '--full-tree', commit], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0')) {
    const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (!m) continue;
    tree.set(m[3], m[2]);
    modes.set(m[3], m[1]);
  }
  return { tree, modes };
}

/** The repository path a copy file comes from (its rewrite's source, a root file's, or the app's own), or null for one the export composes. */
function sourcePath(rel, { prefix, appDir, fromGit, rewrites }) {
  if (rewrites[rel]) return rewrites[rel].source;
  if (fromGit[rel]) return fromGit[rel];
  if (generated(appDir).includes(rel)) return null;
  return rel.startsWith(`${appDir}/`) ? `${prefix}${rel.slice(appDir.length + 1)}` : null;
}

/**
 * The copy's `files` that git has as executable (mode 100755) at `commit`, sorted: EXPORT.json's
 * "executables" (no file system here keeps the bit, so the CAD repository's commit sets it).
 */
export function executablesOf({ web, commit, prefix, appDir, fromGit, rewrites = {}, files }) {
  const { modes } = treeOf(web, commit);
  return files.filter((rel) => modes.get(sourcePath(rel, { prefix, appDir, fromGit, rewrites })) === '100755').sort();
}

/** Blobs by object id, in one git process. */
function blobsOf(web, ids) {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const out = execFileSync('git', ['-C', web, 'cat-file', '--batch'], { input: `${list.join('\n')}\n`, maxBuffer: 1 << 30 });
  const blobs = new Map();
  let pos = 0;
  for (const id of list) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString().split(' ')[2]);
    blobs.set(id, out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return blobs;
}

/** Where `index` is in `text`: its line, and the text around it on one short line. */
function at(text, index, length, mask = false) {
  const line = text.slice(0, index).split('\n').length;
  const found = text.slice(index, index + length);
  const shown = mask ? `${found.slice(0, 7)}... (${found.length} characters)` : found;
  const before = mask ? '' : text.slice(Math.max(0, index - 30), index).replace(/\s+/g, ' ');
  const after = mask ? '' : text.slice(index + length, index + length + 30).replace(/\s+/g, ' ');
  return `line ${line}: ${before}[${shown}]${after}`;
}

/** Each match of each pattern in `text`. */
function* matches(text, patterns) {
  for (const re of patterns) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      yield m;
      if (!re.global) break;
    }
  }
}

/**
 * Runs every check on the copy in `out`, exported from `commit` of the repository at `web`
 * (`prefix`: the app's folder in that repository, `appDir`: in the copy). `fromGit`: the copy's
 * root files that are Magnusim's git files as they are (copy path -> repository path).
 * `uncommitted`: the repository paths an --allow-dirty export took from the working tree (they
 * may differ from the commit). `rewrites`: copy path -> { source (repository path), edits } for
 * each file the export rewrote (applyEdits); `leftOut`: copy paths the export never writes.
 * Returns { passed, checks: { name: { passed, counts, offenders } } }.
 */
export function selfCheck({ out, web, commit, prefix, appDir, fromGit, uncommitted = [], rewrites = {}, leftOut = [] }) {
  const format = execFileSync('git', ['-C', web, 'rev-parse', '--show-object-format'], { encoding: 'utf8' }).trim();
  const { tree, modes } = treeOf(web, commit);
  const { files, links } = walk(out, appDir);
  const gen = new Set(generated(appDir));
  const dirty = new Set(uncommitted);
  const rewriteSources = blobsOf(web, Object.values(rewrites).map((r) => tree.get(r.source)).filter(Boolean));
  const data = new Map(files.map((rel) => [rel, readFileSync(join(out, ...rel.split('/')))]));
  const text = new Map();
  let binaries = 0;
  /** Text files with a NUL byte: read as text all the same (a NUL never makes a file binary). */
  let textWithNul = 0;
  for (const [rel, d] of data) {
    if (BINARY.test(rel)) binaries++;
    else {
      if (d.includes(0)) textWithNul++;
      text.set(rel, d.toString('utf8'));
    }
  }
  const repoPath = (rel) => (rel.startsWith(`${appDir}/`) ? `${prefix}${rel.slice(appDir.length + 1)}` : null);
  const checks = {};
  const check = (name, counts, offenders) => {
    checks[name] = { passed: offenders.length === 0, counts, offenders };
  };

  // files: git's, byte for byte, or the export's own.
  {
    const offenders = links.map((r) => `${r}: a link`);
    const counts = { files: files.length, fromGit: 0, rootFromGit: 0, generated: 0, rewritten: 0, workingTree: 0, leftOut: leftOut.length };
    for (const rel of files) {
      const rw = rewrites[rel];
      if (rw) {
        const id = tree.get(rw.source);
        if (dirty.has(rw.source)) counts.workingTree++;
        else if (!id) offenders.push(`${rel}: ${rw.source} (its rewrite's source) is not a file of ${commit}`);
        else {
          let want = null;
          try {
            want = Buffer.from(applyEdits(rewriteSources.get(id).toString('utf8'), rw.edits, rel), 'utf8');
          } catch (err) {
            offenders.push(`${rel}: its declared rewrite no longer applies to ${rw.source} (${err instanceof Error ? err.message : err})`);
          }
          if (want && !want.equals(data.get(rel))) offenders.push(`${rel}: not ${rw.source} with exactly its declared rewrite (any other change is refused)`);
          else if (want) counts.rewritten++;
        }
        continue;
      }
      if (gen.has(rel)) {
        if (!fromGit[rel]) {
          counts.generated++;
          continue;
        }
        const id = tree.get(fromGit[rel]);
        if (dirty.has(fromGit[rel])) counts.workingTree++;
        else if (!id) offenders.push(`${rel}: ${fromGit[rel]} is not a file of ${commit}`);
        else if (objectId(data.get(rel), format) !== id) offenders.push(`${rel}: not ${fromGit[rel]} as ${commit} has it (from a working tree?)`);
        else counts.rootFromGit++;
        continue;
      }
      const p = repoPath(rel);
      const id = p && tree.get(p);
      if (p && dirty.has(p)) counts.workingTree++;
      else if (!id) offenders.push(`${rel}: not a file of ${commit} (git ls-tree), nor one the export writes`);
      else if (objectId(data.get(rel), format) === id) counts.fromGit++;
      else offenders.push(`${rel}: not as ${commit} has it (from a working tree?)`);
    }
    for (const rel of gen) if (!data.has(rel)) offenders.push(`${rel}: missing (the export writes it)`);
    for (const rel of Object.keys(rewrites)) if (!data.has(rel)) offenders.push(`${rel}: missing (a declared rewrite of the export)`);
    for (const rel of leftOut) if (data.has(rel)) offenders.push(`${rel}: here, and the export leaves it out`);
    // EXPORT.json's executables: exactly the files git has as 100755 (the CAD repository's commit sets the bit from it).
    const want = files.filter((rel) => modes.get(sourcePath(rel, { prefix, appDir, fromGit, rewrites })) === '100755');
    let listed = null;
    try {
      listed = JSON.parse(text.get('EXPORT.json') || 'null')?.executables;
    } catch {
      /* reported below */
    }
    if (!Array.isArray(listed)) offenders.push('EXPORT.json: no "executables" list');
    else {
      for (const rel of want) if (!listed.includes(rel)) offenders.push(`${rel}: git has it as executable (100755), and EXPORT.json's "executables" does not list it`);
      for (const rel of listed) if (!want.includes(rel)) offenders.push(`${rel}: in EXPORT.json's "executables", and ${data.has(rel) ? 'git does not have it as executable' : 'not in the copy'}`);
    }
    counts.executables = want.length;
    check('files', counts, offenders);
  }

  // ai: AI-tool files, trailers, and names in the Markdown the export writes.
  {
    const offenders = [];
    for (const rel of [...files, ...links]) {
      const parts = rel.split('/');
      const name = parts[parts.length - 1];
      if (parts.slice(0, -1).some((d) => AI_DIRS.has(d.toLowerCase()) || /^\.aider/i.test(d))) offenders.push(`${rel}: in an AI tool's folder`);
      else if (AI_NAMES.test(name) || /(^|\/)\.github\/copilot-instructions\.md$/i.test(rel)) offenders.push(`${rel}: an AI tool's file`);
    }
    for (const [rel, t] of text) {
      for (const m of matches(t, [AI_TRAILER])) offenders.push(`${rel}: ${at(t, m.index, m[0].length)} (an AI-tool trailer)`);
    }
    for (const rel of WRITTEN_MARKDOWN) {
      const t = text.get(rel);
      if (t === undefined) continue;
      for (const m of matches(t, [AI_WORDS])) offenders.push(`${rel}: ${at(t, m.index, m[0].length)} (an AI vendor or tool named in the Markdown the export writes)`);
    }
    check('ai', { files: files.length, textFiles: text.size, writtenMarkdown: WRITTEN_MARKDOWN.filter((r) => text.has(r)).length }, offenders);
  }

  // models: model files, test data, a person's models.
  {
    const offenders = [];
    for (const rel of files) {
      const parts = rel.split('/');
      const name = parts[parts.length - 1];
      if (MODEL_FILE.test(name)) offenders.push(`${rel}: a CAD, mesh or scan model file`);
      if (parts.some((s) => DATA_DIR.test(s))) offenders.push(`${rel}: test data (fixtures, samples, testdata or e2e in its path)`);
      if (MODEL_JSON_NAMES.test(name)) offenders.push(`${rel}: named as a person's model or project file`);
      const t = text.get(rel);
      if (t !== undefined && /\.json$/i.test(name) && MODEL_JSON.test(t)) offenders.push(`${rel}: a Part's model JSON ("format": "magnusim-cad/...")`);
      if (t !== undefined && t.startsWith('ISO-10303-21')) offenders.push(`${rel}: a STEP file`);
    }
    check('models', { files: files.length, jsonFiles: files.filter((r) => /\.json$/i.test(r)).length }, offenders);
  }

  // secrets: files and text.
  {
    const offenders = [];
    for (const rel of files) if (SECRET_FILE.test(rel.split('/').pop())) offenders.push(`${rel}: an env, key or certificate file`);
    for (const [rel, t] of text) for (const m of matches(t, SECRET_TEXT)) offenders.push(`${rel}: ${at(t, m.index, m[0].length, true)} (shaped like a key or token)`);
    check('secrets', { files: files.length, textFiles: text.size, binaryFiles: binaries, textFilesWithNul: textWithNul }, offenders);
  }

  // paths: this PC's.
  {
    const offenders = [];
    let allowed = 0;
    for (const [rel, t] of text) {
      for (const m of matches(t, MACHINE_PATHS)) {
        const around = t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
        if (PATH_ALLOWED.some((a) => a.path === rel && around.includes(a.text) && a.text.includes(m[0]))) {
          allowed++;
          continue;
        }
        offenders.push(`${rel}: ${at(t, m.index, m[0].length)} (a path of this PC)`);
      }
    }
    check('paths', { textFiles: text.size, allowed }, offenders);
  }

  // names: a private part's, in every file (binaries read byte for byte).
  {
    const offenders = [];
    let allowed = 0;
    for (const [rel, d] of data) {
      const t = text.get(rel) ?? d.toString('latin1');
      const hits = [...matches(t, PRIVATE_NAMES)];
      if (!hits.length) continue;
      const ok = NAMES_ALLOWED.find((a) => a.path === rel);
      const inText = (m) => !ok.text || t.slice(Math.max(0, m.index - ok.text.length), m.index + ok.text.length).includes(ok.text);
      if (ok && hits.length === ok.count && hits.every(inText)) {
        allowed += hits.length;
        continue;
      }
      if (ok) offenders.push(`${rel}: ${hits.length} hits, and NAMES_ALLOWED allows ${ok.count}${ok.text ? ` inside "${ok.text}"` : ''}`);
      for (const m of hits) offenders.push(`${rel}: ${at(t, m.index, m[0].length)} (a private part's name)`);
    }
    for (const a of NAMES_ALLOWED) if (!data.has(a.path)) offenders.push(`${a.path}: in NAMES_ALLOWED, and not in the copy (drop the entry)`);
    check('names', { files: data.size, allowed }, offenders);
  }

  // licence: GPL-3.0, the CAD plugin's LGPL licences, SPDX lines, the notices.
  {
    const offenders = [];
    const licence = text.get('LICENSE') || '';
    if (!/GNU GENERAL PUBLIC LICENSE/.test(licence) || !/Version 3, 29 June 2007/.test(licence)) offenders.push("LICENSE: not the GNU GPL version 3's text");
    let appLicence = null;
    try {
      appLicence = JSON.parse(text.get(`${appDir}/package.json`) || '{}').license;
    } catch {
      /* reported below */
    }
    if (appLicence !== 'GPL-3.0-or-later') offenders.push(`${appDir}/package.json: license is ${JSON.stringify(appLicence)}, not "GPL-3.0-or-later"`);
    const lic = `${appDir}/bundled-plugins/cad/LICENSES/`;
    const licFiles = files.filter((r) => r.startsWith(lic)).map((r) => r.slice(lic.length));
    const lgpl = (re) => licFiles.some((n) => re.test(n) && /GNU LESSER GENERAL PUBLIC LICENSE/.test(text.get(lic + n) || ''));
    if (!licFiles.length) offenders.push(`${lic}: missing`);
    if (!lgpl(/^OCCT.*LGPL/i)) offenders.push(`${lic}: no OCCT LGPL licence text`);
    if (!licFiles.some((n) => /^OCCT.*EXCEPTION/i.test(n))) offenders.push(`${lic}: no OCCT LGPL exception`);
    if (!lgpl(/^PlaneGCS/i)) offenders.push(`${lic}: no PlaneGCS LGPL licence text`);

    // Each SPDX line of Magnusim's source, in the copy too.
    const sources = files.filter((r) => SOURCE.test(r) && repoPath(r) && tree.has(repoPath(r)));
    const blobs = blobsOf(web, sources.map((r) => tree.get(repoPath(r))));
    let withSpdx = 0;
    for (const rel of sources) {
      const theirs = [...blobs.get(tree.get(repoPath(rel))).toString('utf8').matchAll(SPDX)].map((m) => m[1]);
      if (!theirs.length) continue;
      withSpdx++;
      const ours = [...(text.get(rel) || '').matchAll(SPDX)].map((m) => m[1]);
      if (ours.join(' ') !== theirs.join(' ')) offenders.push(`${rel}: SPDX-License-Identifier ${theirs.join(', ')} in Magnusim, ${ours.join(', ') || 'none'} here`);
    }

    const notices = text.get('THIRD_PARTY_NOTICES.md');
    if (notices === undefined) offenders.push('THIRD_PARTY_NOTICES.md: missing');
    else {
      if (!/OCCT|Open CASCADE/.test(notices)) offenders.push('THIRD_PARTY_NOTICES.md: does not name OCCT');
      if (!/PlaneGCS/.test(notices)) offenders.push('THIRD_PARTY_NOTICES.md: does not name PlaneGCS');
      if (!/Electron/.test(notices)) offenders.push('THIRD_PARTY_NOTICES.md: does not name Electron');
      for (const m of matches(notices, [/\bPython\b/g])) offenders.push(`THIRD_PARTY_NOTICES.md: ${at(notices, m.index, m[0].length)} (names Python, and nothing of Python's ships)`);
    }
    const python = files.filter((r) => (/\.py$/i.test(r) && !PYTHON_ALLOWED[r.slice(appDir.length + 1)]) || PYTHON_RUNTIME.test(r));
    for (const rel of python) offenders.push(`${rel}: Python would ship`);
    check('licence', { licenceFiles: licFiles.length, sources: sources.length, withSpdx, pythonFiles: files.filter((r) => /\.py$/i.test(r)).length }, offenders);
  }

  return { passed: Object.values(checks).every((c) => c.passed), checks };
}

/** The checks for EXPORT.json: each one's result and counts, and how many offenders. */
export function summary(result) {
  return {
    passed: result.passed,
    skipped: SKIPPED,
    checks: Object.fromEntries(Object.entries(result.checks).map(([name, c]) => [name, { passed: c.passed, ...c.counts, offenders: c.offenders.length }])),
  };
}

/** One line per check, then each offender; true when every check passed. */
export function report(result, log = console.log) {
  for (const [name, c] of Object.entries(result.checks)) {
    const counts = Object.entries(c.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    log(`  self-check ${name.padEnd(8)} ${c.passed ? 'passed' : `FAILED (${c.offenders.length})`}: ${counts}`);
    for (const o of c.offenders) log(`    ${o}`);
  }
  return result.passed;
}
