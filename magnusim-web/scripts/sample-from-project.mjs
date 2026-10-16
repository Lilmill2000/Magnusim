#!/usr/bin/env node
// A sample folder (manifest [[samples]], host API 1.8) from a project made in the app:
//   node scripts/sample-from-project.mjs <project folder> <sample folder>
// Copies the project's inputs (no mesh case folder and no runs: opening the sample gives
// each study a new draft run), writes its JSON files with the placeholders of
// scripts/project-sample.js in place of the project's folder, the projects folder and its
// id, and refuses a project whose mesh was generated, one holding a link or junction or
// more than 64 MB (scripts/project-sample.js SAMPLE_MAX_BYTES), or JSON that still names a
// place on this PC after that.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonFiles, sampleProblem, sampleText } from './project-sample.js';

/** A mesh's case folder and a study's runs: never in a sample. */
function leftOut(rel) {
  const parts = rel.split(/[\\/]/);
  const at = parts.lastIndexOf('case');
  return parts.includes('simulation_runs') || (at > 1 && parts[at - 2] === 'meshes');
}

/**
 * Make the sample. Returns { files, json } (the counts written); throws an Error saying
 * what to fix.
 * @param {string} projectDir
 * @param {string} dest
 */
export function sampleFromProject(projectDir, dest) {
  const src = resolve(projectDir);
  const out = resolve(dest);
  if (!existsSync(join(src, 'project.json'))) throw new Error(`${src} has no project.json`);
  if (existsSync(out)) throw new Error(`${out} already exists; remove it first`);
  const place = { projectDir: src, projectsRoot: dirname(src), projectId: basename(src) };
  cpSync(src, out, { recursive: true, filter: (path) => !leftOut(relative(src, path)) });
  let json = 0;
  const problems = [];
  // No links (a junction on Windows too: copied as links, never followed), and a sane size.
  const problem = sampleProblem(out);
  if (problem) problems.push(problem);
  for (const rel of jsonFiles(out)) {
    const path = join(out, rel);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (rel.endsWith('mesh.json') && rel.includes('/meshes/') && doc.live_mesh_result) {
      problems.push(`${rel}: the mesh was generated (a sample ships no mesh: use a project before Generate)`);
    }
    const text = sampleText(readFileSync(path, 'utf8'), place);
    // Whatever still names a folder on this PC: a drive path, or the user's home; and a
    // path under the projects folder (another project's), which a sample may not hold.
    if (/"[A-Za-z]:\\\\/.test(text) || text.includes(sep === '\\' ? '\\\\Users\\\\' : '/home/') || text.includes('"{{projects_root}}/')) {
      problems.push(`${rel}: still names a folder outside the project`);
    }
    writeFileSync(path, text, 'utf8');
    json += 1;
  }
  if (problems.length) throw new Error(`not a sample yet (${out} kept for a look):\n${problems.join('\n')}`);
  return { json };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: node scripts/sample-from-project.mjs <project folder> <sample folder>');
    process.exit(2);
  }
  try {
    const done = sampleFromProject(from, to);
    console.log(`sample written to ${resolve(to)} (${done.json} JSON files)`);
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(1);
  }
}
