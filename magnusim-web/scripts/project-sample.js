// @ts-check
/**
 * Sample projects (manifest `[[samples]]`, host API 1.8).
 *
 * A sample is a project folder a plugin ships: the files of a project made in the app,
 * inputs only (no mesh case, no runs), its JSON files holding three placeholders where a
 * project holds its own place on this PC:
 *
 * - `{{project_dir}}`: the project's folder, at the start of a path string, its parts
 *   after it joined with '/' (a mesh's case_dir, a geometry's step_path, ...);
 * - `{{projects_root}}`: the projects folder, as a whole string only (a path under it
 *   would lead into other projects);
 * - `{{project_id}}`: the project's id (its folder's name), anywhere in a string.
 *
 * No other string may name a place on a PC (a drive, UNC or absolute POSIX path; the
 * app's own URL paths, /api/..., are not places): a sample opens inside its own folder.
 *
 * Opening a sample (POST /api/project/sample, w16-project-geometry.js) checks the folder
 * (sampleProblem: no links, at most SAMPLE_MAX_BYTES), copies it, checks the copy again
 * and fills the placeholders in for the new project (fillSampleFolder). `node
 * scripts/sample-from-project.mjs` makes a sample folder from a project (sampleText).
 */
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLE_TOKENS = Object.freeze({
  projectDir: '{{project_dir}}',
  projectsRoot: '{{projects_root}}',
  projectId: '{{project_id}}',
});

/** The most a sample's files may hold together (bytes): a sample is inputs, not results. */
export const SAMPLE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {{ projectDir: string, projectsRoot: string, projectId: string }} SamplePlace
 */

/**
 * Every string of a JSON value through `fn` (keys untouched).
 * @param {unknown} value
 * @param {(s: string) => string} fn
 * @returns {unknown}
 */
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

/** JSON as the app writes it (two-space indent, a final newline). */
function asJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * True for a string that names a place on a PC: a drive path (C:\ or C:/), a UNC path
 * (\\server or //server), or an absolute POSIX path. The app's own URL paths (/api/...)
 * are not places.
 * @param {string} s
 */
export function namesAPlace(s) {
  if (/^[A-Za-z]:[\\/]/.test(s) || /^(\\\\|\/\/)/.test(s)) return true;
  return /^\/[^/]/.test(s) && !s.startsWith('/api/');
}

/**
 * One string of a sample, filled in for `place`. A path under `{{project_dir}}` is joined
 * the way this PC writes paths; a path part `..`, a path under `{{projects_root}}` and a
 * string naming a place on a PC are refused (Error).
 * @param {string} s
 * @param {SamplePlace} place
 * @param {(...parts: string[]) => string} joinPath
 */
function fillString(s, place, joinPath) {
  if (namesAPlace(s)) throw new Error(`a sample string names a place outside its project: ${s}`);
  if (s.startsWith(SAMPLE_TOKENS.projectsRoot) && s !== SAMPLE_TOKENS.projectsRoot) {
    throw new Error(`a sample path under ${SAMPLE_TOKENS.projectsRoot} leads into other projects: ${s}`);
  }
  let out = s.split(SAMPLE_TOKENS.projectId).join(place.projectId);
  /** @type {[string, string][]} */
  const folders = [
    [SAMPLE_TOKENS.projectDir, place.projectDir],
    [SAMPLE_TOKENS.projectsRoot, place.projectsRoot],
  ];
  for (const [token, base] of folders) {
    if (!out.startsWith(token)) continue;
    const parts = out.slice(token.length).split('/').filter(Boolean);
    if (parts.some((p) => p === '..' || p.includes('\\') || p.includes(':'))) {
      throw new Error(`a sample path leaves its folder: ${s}`);
    }
    out = parts.length ? joinPath(base, ...parts) : base;
  }
  if (out.includes(SAMPLE_TOKENS.projectDir) || out.includes(SAMPLE_TOKENS.projectsRoot)) {
    throw new Error(`a folder placeholder is not at the start of its path: ${s}`);
  }
  return out;
}

/**
 * A sample's JSON text for a project at `place`: each placeholder filled in. Throws when
 * the text is not JSON or a path leaves its folder.
 * @param {string} text
 * @param {SamplePlace} place
 * @param {(...parts: string[]) => string} [joinPath]
 */
export function fillSampleText(text, place, joinPath = join) {
  return asJson(mapStrings(JSON.parse(text), (s) => fillString(s, place, joinPath)));
}

/**
 * A project's JSON text as a sample holds it: its folder, the projects folder and its id
 * replaced by the placeholders, and the parts of a path under a folder joined with '/'
 * (so the sample opens on any system).
 * @param {string} text
 * @param {SamplePlace} place
 */
export function sampleText(text, place) {
  /** @type {(s: string, base: string, token: string) => string | null} */
  const under = (s, base, token) => {
    if (s !== base && !s.startsWith(`${base}\\`) && !s.startsWith(`${base}/`)) return null;
    return `${token}${s.slice(base.length).replace(/\\/g, '/')}`;
  };
  return asJson(
    mapStrings(JSON.parse(text), (s) => {
      const out = under(s, place.projectDir, SAMPLE_TOKENS.projectDir) ?? under(s, place.projectsRoot, SAMPLE_TOKENS.projectsRoot) ?? s;
      return out.split(place.projectId).join(SAMPLE_TOKENS.projectId);
    }),
  );
}

/**
 * Every file under `dir` (relative paths with '/'), links never followed: a link or a
 * junction (Windows) is listed in `links`.
 * @param {string} dir
 */
export function sampleFiles(dir) {
  /** @type {{ files: { rel: string, size: number }[], links: string[] }} */
  const out = { files: [], links: [] };
  /** @param {string} rel */
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const sub = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, sub));
      if (st.isSymbolicLink()) out.links.push(sub);
      else if (st.isDirectory()) walk(sub);
      else if (st.isFile()) out.files.push({ rel: sub, size: st.size });
    }
  };
  walk('');
  return out;
}

/** Every .json file under `dir` (relative paths with '/'), links never followed. */
export function jsonFiles(dir) {
  return sampleFiles(dir)
    .files.map((f) => f.rel)
    .filter((rel) => rel.toLowerCase().endsWith('.json'));
}

/**
 * Why a sample folder cannot be opened ('' when it can): the folder itself a link or
 * junction, a link or junction in it, or more than `maxBytes` (SAMPLE_MAX_BYTES) of files.
 * @param {string} dir
 * @param {number} [maxBytes]
 */
export function sampleProblem(dir, maxBytes = SAMPLE_MAX_BYTES) {
  if (lstatSync(dir).isSymbolicLink()) return "the sample's folder is a link or junction; a sample is plain files";
  const { files, links } = sampleFiles(dir);
  if (links.length) return `the sample holds a link (${links[0]}); a sample is plain files`;
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > maxBytes) {
    /** @param {number} n */
    const mb = (n) => (n / 1048576).toFixed(n < 1048576 ? 3 : 0);
    return `the sample is ${mb(total)} MB; a sample holds at most ${mb(maxBytes)} MB`;
  }
  return '';
}

/**
 * Fill in the placeholders of every JSON file of a copied sample at `dir`; every JSON file
 * is read and checked, the ones holding a placeholder written back. Throws when a file is
 * not JSON, a path leaves its folder or a string names a place on a PC.
 * @param {string} dir
 * @param {SamplePlace} place
 */
export function fillSampleFolder(dir, place) {
  let files = 0;
  for (const rel of jsonFiles(dir)) {
    const path = join(dir, rel);
    const text = readFileSync(path, 'utf8');
    let filled;
    try {
      filled = fillSampleText(text, place);
    } catch (e) {
      throw new Error(`${rel}: ${String((e && /** @type {Error} */ (e).message) || e)}`);
    }
    if (!text.includes('{{')) continue;
    writeFileSync(path, filled, 'utf8');
    files += 1;
  }
  return files;
}
