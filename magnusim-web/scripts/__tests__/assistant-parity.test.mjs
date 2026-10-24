// The Assistant's parity with the person (core host tools spec 16.4): every Tier 0 and Tier 1
// row of the core parity audit has a way for the Assistant to do it, a deferral named in the
// release notes' "Not yet" list, or is the person's alone. The rows are
// scripts/server/assistant/parity-rows.json (spec 1.5). For each row:
//   1. every required row id has exactly one entry, and each entry says how (paths), or why not
//      (deferred, person_only, not_owed);
//   2. each path's tool is a host tool (defaultHostTools) or a core page tool (core__show,
//      core__view: src/assistant/coreTools.ts); its `where` values are in the tool's enums (or
//      are properties of its schema); its routes are HOST_ROUTES entries its code calls, and a
//      page tool handles the target or action; a path's `context` is one the tool is offered in;
//   3. each deferral is named in the release notes' "Not yet in v0.5.0" list;
//   4. a row that is the person's alone has no tool path.
// So the test fails when a tool loses an enum value, an allowlist entry goes, or a row is added
// with no path.
// SPDX-License-Identifier: GPL-3.0-or-later
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-parity-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSISTANT = join(WEB, 'scripts', 'server', 'assistant');
const FIXTURE = JSON.parse(readFileSync(join(ASSISTANT, 'parity-rows.json'), 'utf8'));

const { defaultHostTools } = await import('../server/assistant/host-tools.ts');
const { HOST_ROUTES } = await import('../server/assistant/host-call.ts');

/** The audit's Tier 0 and Tier 1 rows, and the Tier 2 rows the tools cover (spec 16.4): the fixture's header must say the same. */
const REQUIRED = ['H1-H14', 'G1-G18', 'S1-S15', 'M1-M7', 'B1-B10', 'X1-X19', 'R1-R22', 'V1-V25', 'Q1-Q5', 'P2', 'P6', 'P8', 'L7', 'L9'];

/** "H1-H14" → H1 … H14; "P2" → P2. */
function expand(spec) {
  const m = /^([A-Z])(\d+)(?:-\1?(\d+))?$/.exec(spec);
  assert.ok(m, `a row range: ${spec}`);
  const [, letter, from, to] = m;
  const out = [];
  for (let i = Number(from); i <= Number(to ?? from); i++) out.push(`${letter}${i}`);
  return out;
}

const host = new Map(defaultHostTools(() => null).map((t) => [t.name, t]));

/** Each host tool's code: its own file under host/, and the files it shares (a route id it calls appears in one). */
const HOST_DIR = join(ASSISTANT, 'host');
const sourceOf = new Map();
for (const f of readdirSync(HOST_DIR).filter((n) => n.endsWith('.ts'))) sourceOf.set(f, readFileSync(join(HOST_DIR, f), 'utf8'));
const SHARED = ['common.ts', 'job-common.ts', 'job-state.ts'];
/** The files a tool's code is in (by its name: read_setup → read-setup.ts), shared ones last. */
function filesOf(tool) {
  const own = `${tool.replace(/_/g, '-')}.ts`;
  assert.ok(sourceOf.has(own), `${tool}'s code is host/${own}`);
  return [own, ...SHARED];
}
const calls = (tool, route) => filesOf(tool).some((f) => sourceOf.get(f).includes(`'${route}'`));

// The core page's tools: their schemas and handlers are in the page's code (no Node import: it is browser code).
const CORE_SRC = readFileSync(join(WEB, 'src', 'assistant', 'coreTools.ts'), 'utf8');
function constList(name) {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const`).exec(CORE_SRC);
  assert.ok(m, `coreTools.ts declares ${name}`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}
const CORE = {
  core__show: { key: 'target', values: constList('SHOW_TARGETS'), props: ['target', 'project_id', 'id', 'panel'] },
  core__view: { key: 'action', values: constList('VIEW_ACTIONS'), props: ['action', 'target_ids', 'aspect', 'size', 'with_legend', 'on', 'save'] },
};
for (const [name, c] of Object.entries(CORE)) {
  const short = name.slice('core__'.length);
  assert.match(CORE_SRC, new RegExp(`name: '${short}'`), `CORE_TOOLS registers ${short}`);
  for (const p of c.props) assert.match(CORE_SRC, new RegExp(`required: \\[[^\\]]*'${p}'`), `${name} has ${p}`);
}
/** The page handles this target or action (its own branch or case). */
const handles = (value) => new RegExp(`(?:case |=== ?)'${value}'`).test(CORE_SRC);

/** The release notes' "Not yet in v0.5.0" list (to the next heading). */
function notYetList() {
  const text = readFileSync(join(WEB, FIXTURE.release_notes), 'utf8').replace(/\r\n/g, '\n');
  const at = text.search(/^#+ Not yet in v0\.5\.0\s*$/m);
  assert.ok(at >= 0, `${FIXTURE.release_notes} has a "Not yet in v0.5.0" heading`);
  const rest = text.slice(at).split('\n').slice(1).join('\n');
  const end = rest.search(/^#+ /m);
  return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ').toLowerCase();
}

const asList = (v) => (Array.isArray(v) ? v : [v]);

/** What is wrong with one path (an empty list when nothing). */
function pathProblems(row, p) {
  const out = [];
  const at = `${row} ${p.tool}`;
  const where = p.where ?? {};
  if (p.page) {
    const core = CORE[p.tool];
    if (!core) return [`${at}: no core page tool of that name`];
    for (const [k, v] of Object.entries(where)) {
      if (!core.props.includes(k)) out.push(`${at}: no property ${k}`);
      else if (k === core.key) {
        for (const x of asList(v)) {
          if (!core.values.includes(x)) out.push(`${at}: ${k} "${x}" is not in its enum`);
          else if (!handles(x)) out.push(`${at}: the page does not handle ${k} "${x}"`);
        }
      }
    }
    if (!(core.key in where)) out.push(`${at}: a page path names its ${core.key}`);
    return out;
  }
  const def = host.get(p.tool);
  if (!def) return [`${at}: no host tool of that name`];
  const props = def.schema.properties ?? {};
  for (const [k, v] of Object.entries(where)) {
    const prop = props[k];
    if (!prop) {
      out.push(`${at}: no property ${k}`);
      continue;
    }
    if (v === true) continue;
    if (!prop.enum) {
      out.push(`${at}: ${k} has no enum; say true for "it takes ${k}"`);
      continue;
    }
    for (const x of asList(v)) if (!prop.enum.includes(x)) out.push(`${at}: ${k} "${x}" is not in its enum (${prop.enum.join(', ')})`);
  }
  if (p.context && !(def.contexts ?? []).includes(p.context)) out.push(`${at}: not offered in ${p.context} (${(def.contexts ?? []).join(', ')})`);
  const routes = p.routes ?? [];
  // A read of what the turn already has (app_status) needs no route of its own to name.
  if (!routes.length && def.risk !== 'read') out.push(`${at}: a path that changes something names its routes`);
  for (const r of routes) {
    if (!HOST_ROUTES[r]) out.push(`${at}: ${r} is not a HOST_ROUTES entry`);
    else if (!calls(p.tool, r)) out.push(`${at}: its code never calls ${r}`);
  }
  return out;
}

describe("the Assistant's parity with the person (spec 16.4)", () => {
  it('the fixture covers the rows the spec requires', () => {
    assert.deepEqual(FIXTURE.required, REQUIRED);
  });

  const byRow = new Map();
  for (const e of FIXTURE.rows) {
    for (const id of e.row.split(',').flatMap((s) => expand(s.trim()))) {
      if (!byRow.has(id)) byRow.set(id, []);
      byRow.get(id).push(e);
    }
  }

  it('every required row has exactly one entry, saying how or why not', () => {
    const missing = [];
    const twice = [];
    const empty = [];
    for (const id of REQUIRED.flatMap(expand)) {
      const es = byRow.get(id) ?? [];
      if (!es.length) missing.push(id);
      else if (es.length > 1) twice.push(id);
      else {
        const e = es[0];
        if (!(e.paths?.length || e.deferred || e.person_only || e.not_owed)) empty.push(id);
      }
    }
    assert.deepEqual({ missing, twice, empty }, { missing: [], twice: [], empty: [] });
    // Nor is any other row in it twice.
    assert.deepEqual([...byRow].filter(([, es]) => es.length > 1).map(([id]) => id), []);
  });

  it("each path's tool exists, takes those values, and calls those routes (or the page handles them)", () => {
    const problems = FIXTURE.rows.flatMap((e) => (e.paths ?? []).flatMap((p) => pathProblems(e.row, p)));
    assert.deepEqual(problems, []);
  });

  it("each deferral is in the release notes' Not yet list", () => {
    const list = notYetList();
    const notNamed = FIXTURE.rows.filter((e) => e.deferred).filter((e) => !e.notes || !list.includes(String(e.notes).toLowerCase()));
    assert.deepEqual(notNamed.map((e) => `${e.row}: "${e.notes}"`), []);
    // A deferral of only part of a row says which part, and the rest of it has a path.
    for (const e of FIXTURE.rows.filter((x) => x.deferred && x.paths?.length)) assert.ok(e.part, `${e.row}: which part is deferred`);
  });

  it('a row that is the person\'s alone has no tool path; a part of one names that part', () => {
    for (const e of FIXTURE.rows.filter((x) => x.person_only)) {
      if (e.person_only === true) assert.ok(!e.paths?.length, `${e.row} is person-only but has a path`);
      else assert.ok(typeof e.person_only === 'string' && e.paths?.length, `${e.row}: a person-only part goes with the row's paths`);
    }
  });

  it('every host tool and core page tool is used by some row', () => {
    const used = new Set(FIXTURE.rows.flatMap((e) => (e.paths ?? []).map((p) => p.tool)));
    const unused = [...host.keys(), ...Object.keys(CORE)].filter((t) => !used.has(t) && t !== 'test_ui_sync');
    assert.deepEqual(unused, []);
  });

  it('the checks catch a lost enum value, a lost route and an unhandled target', () => {
    assert.deepEqual(pathProblems('T', { tool: 'setup_edit', where: { kind: 'bc', action: 'teleport' }, routes: ['bcs.upsert'] }), ['T setup_edit: action "teleport" is not in its enum (' + host.get('setup_edit').schema.properties.action.enum.join(', ') + ')']);
    assert.deepEqual(pathProblems('T', { tool: 'delete', where: { kind: 'bc' }, routes: ['bcs.vanish'] }), ['T delete: bcs.vanish is not a HOST_ROUTES entry']);
    assert.deepEqual(pathProblems('T', { tool: 'delete', where: { kind: 'bc' }, routes: ['mesh.generate'] }), ['T delete: its code never calls mesh.generate']);
    assert.deepEqual(pathProblems('T', { tool: 'core__show', where: { target: 'garden' }, page: true }), ['T core__show: target "garden" is not in its enum']);
    assert.deepEqual(pathProblems('T', { tool: 'compute', where: { action: 'run_start' } }), ['T compute: a path that changes something names its routes']);
  });
});
