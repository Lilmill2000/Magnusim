// The Assistant's parity with the person (core host tools spec 16.4): every Tier 0 and Tier 1
// row of the core parity audit has a way for the Assistant to do it, a deferral named in the
// release notes' "Not yet" list, or is the person's alone. The rows are
// scripts/server/assistant/parity-rows.json (spec 1.5). For each row:
//   1. every required row id has exactly one entry, and each entry says how (paths), or why not
//      (deferred, person_only, not_owed);
//   2. each path's tool is a host tool (defaultHostTools) or a core page tool (core__show,
//      core__view, core__keybinds, core__set_keybind, core__appearance, core__set_appearance: src/assistant/coreToolDefs.ts); its `where` values are in the tool's enums (or
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
const REQUIRED = ['H1-H14', 'G1-G18', 'S1-S15', 'M1-M7', 'B1-B10', 'X1-X19', 'R1-R22', 'V1-V25', 'Q1-Q5', 'P2', 'P6', 'P8', 'P23', 'P24', 'L7', 'L9'];

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

// The core page's tools: their definitions as the page registers them (src/assistant/coreToolDefs.ts,
// plain data Node reads), and their handlers in the page's code (browser code: read as text).
const { CORE_TOOLS, KEYBIND_ACTIONS, SHOW_TARGETS, VIEW_ACTIONS } = await import('../../src/assistant/coreToolDefs.ts');
const coreSrc = (file) => readFileSync(join(WEB, 'src', 'assistant', file), 'utf8');
/**
 * Each core page tool: the enum its paths name (key: '' for one with none), its properties, and the
 * file its handler is in (a value counts as handled only there: another tool's `=== 'set'` is not its).
 */
const CORE = {
  core__show: { key: 'target', values: [...SHOW_TARGETS], props: ['target', 'project_id', 'id', 'panel'], src: 'coreTools.ts' },
  core__view: { key: 'action', values: [...VIEW_ACTIONS], props: ['action', 'target_ids', 'aspect', 'size', 'with_legend', 'on', 'save'], src: 'coreTools.ts' },
  core__keybinds: { key: '', values: [], props: ['plugin', 'target'], src: 'keybindTools.ts' },
  core__set_keybind: { key: 'action', values: [...KEYBIND_ACTIONS], props: ['plugin', 'command', 'action', 'keys', 'replace', 'person_asked'], src: 'keybindTools.ts' },
  core__appearance: { key: '', values: [], props: ['with_offered'], src: 'appearanceTool.ts' },
  core__set_appearance: { key: '', values: [], props: ['theme', 'text_scale', 'icon_scale', 'person_asked'], src: 'appearanceTool.ts' },
};
for (const [name, c] of Object.entries(CORE)) {
  const short = name.slice('core__'.length);
  const def = CORE_TOOLS.find((t) => t.name === short);
  assert.ok(def, `CORE_TOOLS registers ${short}`);
  for (const p of c.props) assert.ok(def.inputSchema.required.includes(p), `${name} has ${p}`);
}
/** The page handles this target or action (its own branch or case) in that tool's file. */
const handles = (value, src) => new RegExp(`(?:case |=== ?)'${value}'`).test(coreSrc(src));

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
          else if (!handles(x, core.src)) out.push(`${at}: the page does not handle ${k} "${x}"`);
        }
      }
    }
    if (core.key && !(core.key in where)) out.push(`${at}: a page path names its ${core.key}`);
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
    // A value is handled in the tool's own file only: keybindTools.ts's 'set' is not appearanceTool.ts's.
    assert.equal(handles('set', 'keybindTools.ts'), true);
    assert.equal(handles('set', 'appearanceTool.ts'), false);
    assert.deepEqual(pathProblems('T', { tool: 'compute', where: { action: 'run_start' } }), ['T compute: a path that changes something names its routes']);
  });
});

// Editions (Magnusim CAD, parity both ways): every row and every host and core page tool says
// which editions it is in (never defaulted). In Magnusim CAD the Assistant has a tool and value
// for each row whose control the CAD app has (cad_control, checked in the CAD app by
// e2e-cad/cad-parity.spec.ts), and nothing more: its tools are assistant-routes.ts
// CAD_EDITION_TOOLS, which tool_editions must say exactly.
const { CAD_EDITION_TOOLS } = await import('../server/assistant-routes.ts');
const EDITIONS = ['magnusim', 'cad'];
const REACH = ['home', 'card', 'grid_menu', 'folder_menu', 'new_project', 'project', 'settings'];
const TOOL_EDITIONS = FIXTURE.tool_editions ?? {};
const inCad = (e) => (e.editions ?? []).includes('cad');

describe("the Assistant's parity in each edition", () => {
  it('every row says its editions, and only a Magnusim CAD row names a CAD control', () => {
    const problems = [];
    for (const e of FIXTURE.rows) {
      const eds = e.editions;
      if (!Array.isArray(eds) || !eds.length) problems.push(`${e.row}: no editions`);
      else if (eds.some((x) => !EDITIONS.includes(x)) || new Set(eds).size !== eds.length) problems.push(`${e.row}: editions ${JSON.stringify(eds)}`);
      else if (!eds.includes('magnusim')) problems.push(`${e.row}: an audit row of Magnusim's is in Magnusim`);
      const c = e.cad_control;
      if (inCad(e) && !(c && REACH.includes(c.reach) && typeof c.selector === 'string' && c.selector)) problems.push(`${e.row}: a CAD row names the CAD app's control`);
      if (!inCad(e) && c) problems.push(`${e.row}: a cad_control on a row Magnusim CAD does not have`);
    }
    assert.deepEqual(problems, []);
  });

  it('tool_editions names every host and core page tool, and nothing else', () => {
    const tools = [...host.keys(), ...Object.keys(CORE)].filter((t) => t !== 'test_ui_sync').sort();
    assert.deepEqual(Object.keys(TOOL_EDITIONS).sort(), tools);
    for (const [name, t] of Object.entries(TOOL_EDITIONS)) {
      assert.ok(Array.isArray(t.editions) && t.editions.includes('magnusim') && t.editions.every((x) => EDITIONS.includes(x)), `${name}: its editions`);
      assert.ok(!t.cad_values || t.editions.includes('cad'), `${name}: CAD values on a tool Magnusim CAD does not have`);
    }
  });

  it("tool_editions' Magnusim CAD tools and values are exactly assistant-routes.ts's list", () => {
    const fromFixture = Object.fromEntries(
      Object.entries(TOOL_EDITIONS)
        .filter(([, t]) => t.editions.includes('cad'))
        .map(([name, t]) => [name, t.cad_values ?? {}]),
    );
    const fromCode = Object.fromEntries(Object.entries(CAD_EDITION_TOOLS).map(([name, t]) => [name, t.values ?? {}]));
    assert.deepEqual(fromFixture, fromCode);
  });

  it("a CAD row's paths use only Magnusim CAD's tools and values (the Assistant can do it there)", () => {
    const problems = [];
    for (const e of FIXTURE.rows.filter(inCad)) {
      if (!e.paths?.length) problems.push(`${e.row}: no path`);
      for (const p of e.paths ?? []) {
        const t = TOOL_EDITIONS[p.tool];
        if (!t || !t.editions.includes('cad')) {
          problems.push(`${e.row}: ${p.tool} is not in Magnusim CAD`);
          continue;
        }
        for (const [k, v] of Object.entries(p.where ?? {})) {
          const keep = t.cad_values?.[k];
          if (keep && v !== true) for (const x of asList(v)) if (!keep.includes(x)) problems.push(`${e.row}: ${p.tool} ${k} "${x}" is not kept in Magnusim CAD`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it('every Magnusim CAD tool and kept value is a CAD row\'s (the Assistant can do no more than the person)', () => {
    const problems = [];
    const cadRows = FIXTURE.rows.filter(inCad);
    const usedBy = (rows, tool, key, value) =>
      rows.some((e) => (e.paths ?? []).some((p) => p.tool === tool && (key === null || asList((p.where ?? {})[key] ?? []).includes(value))));
    for (const [name, t] of Object.entries(TOOL_EDITIONS).filter(([, x]) => x.editions.includes('cad'))) {
      if (!usedBy(cadRows, name, null)) problems.push(`${name}: no CAD row uses it`);
      for (const [key, keep] of Object.entries(t.cad_values ?? {})) {
        for (const v of keep) {
          // "" is a field left unused. A value no row of either edition uses is plain navigation
          // both apps have (core__show home); one only Magnusim's rows use is not CAD's.
          if (v === '' || usedBy(cadRows, name, key, v) || !usedBy(FIXTURE.rows, name, key, v)) continue;
          problems.push(`${name} ${key} "${v}": only Magnusim's rows use it`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});
