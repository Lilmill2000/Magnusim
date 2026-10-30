// The CAD Part's 22 Assistant tools against the app's own rules (CAD tools spec §3.0, §12.2): the
// schemas the Part registers (bundled-plugins/cad/src/assistant/schemas.ts, loaded here with
// Node's type stripping, as is its guide) pass the app's schema check; the strict dialects are
// sent only the keywords they take; in a CAD turn the app offers 31 tools (the Part's 22 by name
// first, then its 9 host and core tools by name: core host tools spec §12.4, §15), strict as
// strictOf grants them (the workspace's first, by name) on the first cloud dialect; no CAD property is optional;
// each CAD schema's size is printed and stays within the app's 16 KB; the registration is within
// 512 KB. What a local model reads before the conversation, in Magnusim and in Magnusim CAD
// (projectLinks false: the tools without a simulation's or the Enclosure's fields, so shorter), by
// the runtime's own rule (registry.ts LOCAL_BUDGET: a local request's tools take at most half the
// model's context, 16,384 tokens for an unknown (32K) model, counted as toolTokens counts them at
// LOCAL_BUDGET.charsPerToken characters a token): the 31 as sent fit that budget and nothing is cut
// at it; the system text (the prompt and the CAD notes) is at most 6,000 characters. Both are
// printed with their share, and past 90% of the tool budget a warning is printed, so the next
// squeeze is seen before a tool is cut.
// The CAD suite's hand copies of the app's rules stay the app's: tests/assistant/sanitize-copy.ts
// (help.test.ts checks every help reply through it) has the server's caps and gives what
// resultText gives, on replies shaped as help sends them (the guide, the core set's guide, every
// worked part) and on samples past every cap; every worked part's input (help example_*, which
// guide.test.ts checks with its own copy of the rules) passes the server's validateInput.
// SPDX-License-Identifier: GPL-3.0-or-later
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-cad-tools-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { CAD_TOOLS, cadToolsFor } = await import('../../bundled-plugins/cad/src/assistant/schemas.ts');
const { CORE_TOOLSET, TOOL_NAMES } = await import('../../bundled-plugins/cad/src/assistant/schemas.ts');
const { GUIDE, guideWithout } = await import('../../bundled-plugins/cad/src/assistant/guide.ts');
const { WORKED_PARTS } = await import('../../bundled-plugins/cad/src/assistant/examples.ts');
const sanitizeCopy = await import('../../bundled-plugins/cad/tests/assistant/sanitize-copy.ts');
const { checkSchema, emitSchema, STRICT_KEEP, validateInput } = await import('../server/assistant/schema.ts');
const { JSON_CAPS, resultText, TEXT_CAPS } = await import('../server/assistant/sanitize.ts');
const { strictOf, STRICT_LIMITS } = await import('../server/assistant/providers/anthropic.ts');
const { createToolRegistry, LOCAL_BUDGET, localBudget, providerTools, REGISTRATION_MAX_BYTES, toolTokens } = await import('../server/assistant/registry.ts');
const { createHostTools } = await import('../server/assistant/host-tools.ts');
const { createJobTools } = await import('../server/assistant/host/job-tools.ts');
const { CORE_TOOLS } = await import('../../src/assistant/coreToolDefs.ts');
const { guideBlock, systemPrompt } = await import('../server/assistant/prompt.ts');

/**
 * The tools as sent to a local model, at most (characters): the registry's budget for a model of
 * unknown (32K) context, at the registry's characters a token (a deliberate over-count).
 */
const TOOLS_MAX_CHARS = LOCAL_BUDGET.unknown * LOCAL_BUDGET.charsPerToken;
/** The system text a local model reads (the prompt and the CAD notes), at most (characters). */
const SYSTEM_MAX = 6_000;
/** Past this share of the tool budget a warning is printed. */
const WARN_SHARE = 0.9;

/** The app's host tools as the server makes them (defaultHostTools: the host tools, then the job tools). */
const hostTools = () => [
  ...createHostTools({
    hostCall: async () => ({}),
    assistant: async () => ({ provider: 'off', model: '' }),
    version: async () => '0.0.0',
    plugins: () => [],
  }),
  ...createJobTools({ call: async () => ({}) }),
];

/** The app's tools a workspace turn is offered, by name (core host tools spec §15): 5 host tools and the core page's core__show and Settings → Appearance's two. */
const HOST_IN_WORKSPACE = ['app_status', 'chat_history', 'core__appearance', 'core__set_appearance', 'core__show', 'explain_ready', 'project_summary', 'read_setup', 'wait'];

/**
 * The tools the app offers a turn on the Part's tab, in order (the registry's own selection); `tools`
 * the Part's (Magnusim's by default); a local turn's budget is a 32K model's unless `budgetTokens`.
 */
function offered({ local = false, tools: cad = CAD_TOOLS, budgetTokens = localBudget(32_768) } = {}) {
  const registry = createToolRegistry({ hostTools: hostTools(), pluginEpoch: () => 'e1' });
  const reg = { plugin: 'cad', pluginName: 'Magnusim CAD', workspace: 'part', workspaceName: 'Part', projectId: 'p1', studyId: 's1', tools: cad.map((t) => ({ ...t })), guide: GUIDE };
  const verdict = registry.setWorkspace('T1', 'L1', reg);
  assert.deepEqual(verdict.refused, []);
  assert.equal(verdict.accepted.length, 22);
  // The app page's own registration in the same tab (C7), where it is: the Part's workspace.
  const core = registry.setCore('T1', 'L1', { projectId: 'p1', studyId: 's1', place: 'workspace', tools: CORE_TOOLS.map((t) => ({ ...t })), guide: '' });
  assert.deepEqual(core.refused, []);
  return registry.selectTools({ tab: 'T1', projectId: 'p1', simulationId: 's1', cloud: !local, local, place: 'workspace', budgetTokens: local ? budgetTokens : null, prompt: null });
}

/** Every schema node, with its path. */
function walk(node, path = '(root)', out = []) {
  out.push({ node, path });
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`, out);
  if (node.items) walk(node.items, `${path}[]`, out);
  return out;
}

describe("the CAD Part's tools by the app's rules", () => {
  it('every schema passes the app\'s check', () => {
    assert.equal(CAD_TOOLS.length, 22);
    for (const t of CAD_TOOLS) assert.deepEqual(checkSchema(t.inputSchema), { ok: true }, t.name);
  });

  it('the strict dialects are sent only the keywords they take, and no CAD property is optional', () => {
    for (const dialect of ['anthropic', 'openai']) {
      for (const t of CAD_TOOLS) {
        for (const { node, path } of walk(emitSchema(dialect, t.inputSchema))) {
          for (const k of Object.keys(node)) assert.ok(STRICT_KEEP[dialect].includes(k), `${dialect} ${t.name} ${path}: ${k}`);
          if (node.type === 'object') assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${dialect} ${t.name} ${path}`);
        }
      }
    }
  });

  it("a CAD turn offers 31: the Part's 22 by name first, then the app's 9 for a workspace; strict as strictOf grants them: the Part's first, by name", () => {
    const { tools, dropped } = offered();
    assert.deepEqual(dropped, []);
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, [...CAD_TOOLS.map((t) => `cad__${t.name}`), ...HOST_IN_WORKSPACE]);
    const sent = providerTools(tools);
    const flags = strictOf(sent, sent.map((t) => emitSchema('anthropic', t.schema)), false);
    // The strict budget goes to the Part's tools first: its first 20 by name; the rest go loose.
    assert.deepEqual(flags, names.map((_, i) => i < STRICT_LIMITS.tools));
    assert.equal(flags.filter(Boolean).length, STRICT_LIMITS.tools);
  });

  for (const [edition, projectLinks] of [['Magnusim', true], ['Magnusim CAD', false]]) {
    it(`${edition}: the 31 as sent fit a 32K local model's tool budget (nothing is cut) and the system text is at most ${SYSTEM_MAX} characters`, () => {
      const tools = projectLinks ? CAD_TOOLS : cadToolsFor({ projectLinks });
      // Measured on all 31, whatever the budget would cut.
      const all = offered({ local: true, tools, budgetTokens: Number.MAX_SAFE_INTEGER });
      assert.equal(all.tools.length, 31);
      const r = readBefore(all.tools, !projectLinks);
      const budget = LOCAL_BUDGET.unknown;
      const share = r.tokens / budget;
      const pct = (n) => `${(100 * n).toFixed(1)}%`;
      console.log(
        `[assistant-cad-tools] ${edition}: tools as sent ${r.chars} characters, ${r.tokens} tokens of ${budget} (${pct(share)}; at most ${TOOLS_MAX_CHARS} characters); system text ${r.system} of ${SYSTEM_MAX} characters (${pct(r.system / SYSTEM_MAX)})`,
      );
      if (share > WARN_SHARE) {
        console.warn(`[assistant-cad-tools] WARNING ${edition}: the tools take ${pct(share)} of a 32K local model's tool budget, past ${pct(WARN_SHARE)}: ${budget - r.tokens} tokens are left before the registry cuts a tool`);
      }
      assert.ok(r.tokens <= budget, `${edition}: ${r.tokens} tokens of ${budget}`);
      assert.ok(r.chars <= TOOLS_MAX_CHARS, `${edition}: ${r.chars} characters of ${TOOLS_MAX_CHARS}`);
      assert.ok(r.system <= SYSTEM_MAX, `${edition}: system text ${r.system} characters of ${SYSTEM_MAX}`);
      // The hard rule: at a 32K model's budget (and an unknown model's, the same) nothing is cut.
      assert.equal(localBudget(32_768), budget);
      const { tools: sent, dropped, budget: given } = offered({ local: true, tools });
      assert.equal(given, budget);
      assert.deepEqual(dropped, []);
      assert.equal(sent.length, 31);
    });
  }

  it('each CAD schema as sent is within the app\'s 16 KB (sizes printed)', () => {
    const sizes = CAD_TOOLS.map((t) => [t.name, Buffer.byteLength(JSON.stringify(t.inputSchema), 'utf8'), Buffer.byteLength(JSON.stringify(emitSchema('anthropic', t.inputSchema)), 'utf8')]);
    console.log(`[assistant-cad-tools] schema bytes (as registered, as sent strict): ${sizes.map(([n, a, b]) => `${n} ${a}/${b}`).join(', ')}`);
    for (const [n, a] of sizes) assert.ok(a <= 16 * 1024, `${n} ${a} bytes`);
  });

  it('the registration is within 512 KB', () => {
    const bytes = Buffer.byteLength(JSON.stringify({ tools: CAD_TOOLS, guide: GUIDE }), 'utf8');
    assert.ok(bytes <= REGISTRATION_MAX_BYTES, `${bytes} bytes`);
  });

  it("in Magnusim CAD (projectLinks false) the Part's tools as sent are shorter: the same 22, without a simulation's or the Enclosure's fields", () => {
    const edition = cadToolsFor({ projectLinks: false });
    assert.deepEqual(edition.map((t) => t.name), CAD_TOOLS.map((t) => t.name));
    for (const t of edition) assert.deepEqual(checkSchema(t.inputSchema), { ok: true }, t.name);
    const magnusim = readBefore(offered({ local: true }).tools, false).chars;
    const { chars } = readBefore(offered({ local: true, tools: edition }).tools, true);
    console.log(`[assistant-cad-tools] tools as sent in Magnusim CAD: ${chars} characters (Magnusim ${magnusim}, ${magnusim - chars} fewer)`);
    assert.ok(chars < magnusim, `${chars} characters, Magnusim ${magnusim}`);
  });
});

/**
 * What a local model reads before the conversation: the tools as sent, in characters and in
 * tokens, each as the registry counts it (toolTokens: one definition's JSON, rounded up per tool),
 * and the system text's characters (the edition's prompt and the CAD notes).
 */
function readBefore(tools, cad) {
  const chars = providerTools(tools).reduce((n, t) => n + JSON.stringify({ type: 'function', function: { name: t.name, description: t.description, parameters: emitSchema('openai_compatible', t.schema) } }).length, 0);
  const tokens = tools.reduce((n, t) => n + toolTokens(t), 0);
  const system = `${systemPrompt(cad)}\n${guideBlock(GUIDE, 'Magnusim CAD')}`;
  return { chars, tokens, system: system.length };
}

/** A help reply's data as the help tool gives it (CAD's help.ts), rev first as the call handler adds it. */
const helpData = (topic, rows) => ({ rev: 3, topic, rows });
const guideRows = (guide) => guide.split(/\n\n+/).map((part) => ({ about: (/^([A-Z]{3,})\b/.exec(part)?.[1] ?? 'introduction').toLowerCase(), text: part }));
/** A worked part as help's example topic gives it: the plan, every call in its row, the checks. */
const exampleRows = (p) => [{ about: 'the part', text: p.part }, ...p.calls.map((c) => ({ about: c.about, text: c.text, tool: c.tool, input: c.input, result: c.result })), { about: 'checks', text: p.checks }];

/** `depth` lists inside each other around `leaf`. */
const nest = (depth, leaf) => (depth === 0 ? leaf : [nest(depth - 1, leaf)]);

describe("the CAD suite's copies of the app's rules", () => {
  it("sanitize-copy.ts has the server's caps", () => {
    assert.deepEqual({ ...sanitizeCopy.TEXT_CAPS }, { ...TEXT_CAPS });
    assert.deepEqual({ ...sanitizeCopy.JSON_CAPS }, { ...JSON_CAPS });
  });

  it("sanitize-copy.ts gives what the server's resultText gives: help's replies and samples past every cap", () => {
    const samples = [
      // Help's replies, as the help tool shapes them.
      ['guide', { text: 'help guide: 10 rows', data: helpData('guide', guideRows(GUIDE)) }],
      ['core guide', { text: 'help guide: 10 rows', data: helpData('guide', guideRows(guideWithout(TOOL_NAMES.filter((n) => !CORE_TOOLSET.includes(n))))) }],
      ...WORKED_PARTS.map((p) => [p.topic, { text: `help ${p.topic}: ${p.calls.length + 2} rows`, data: helpData(p.topic, exampleRows(p)) }]),
      // Past the caps: depth, keys, items, string length, total size, text size.
      ...[6, 7, 8, 9, 12].map((d) => [`lists ${d} deep`, { text: 'deep', data: { rows: nest(d, 1) } }]),
      ['250 keys', { text: 'keys', data: Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, i])) }],
      ['250 items', { text: 'items', data: { list: Array.from({ length: 250 }, (_, i) => i) } }],
      ['a long string', { text: 'long', data: { s: 'ab cd '.repeat(600) } }],
      ['a string split at a surrogate pair', { text: 'pair', data: { s: `${'x'.repeat(1999)}\u{1F600}y` } }],
      ['40 KB of rows', { text: 'big', data: { rows: Array.from({ length: 120 }, (_, i) => ({ about: `row ${i}`, text: 'w'.repeat(320) })) } }],
      ['a long text', { text: 'line '.repeat(5000), data: { n: 1 } }],
      ['controls and spaces', { text: ' a\tb\nc\u0007d\u202ee  ', data: { s: 'x\r\ny\u2028z', [' key\u0000 ']: [Infinity, NaN, -0, null, true] } }],
      ['undefined and functions', { text: 't', data: { a: undefined, f: () => 1, list: [undefined, () => 2, 3] } }],
    ];
    for (const [what, r] of samples) {
      const app = JSON.parse(resultText('cad__help', { ok: true, ...r }));
      assert.deepEqual(sanitizeCopy.resultAsSent('cad__help', r), app, what);
    }
    // The samples reach every cap (else they would prove nothing about it).
    const cut = samples.filter(([, r]) => JSON.parse(resultText('cad__help', { ok: true, ...r })).truncated).map(([w]) => w);
    assert.deepEqual(cut, ['lists 8 deep', 'lists 9 deep', 'lists 12 deep', '250 keys', '250 items', 'a long string', 'a string split at a surrogate pair', '40 KB of rows', 'a long text']);
  });

  it("every worked part's input passes the server's validateInput for its tool", () => {
    let n = 0;
    for (const p of WORKED_PARTS) {
      for (const c of p.calls) {
        const t = CAD_TOOLS.find((x) => x.name === c.tool);
        assert.ok(t, `${p.topic} ${c.about}: no tool ${c.tool}`);
        assert.deepEqual(validateInput(t.inputSchema, c.input), { ok: true }, `${p.topic} ${c.about} ${c.tool}`);
        n += 1;
      }
    }
    assert.ok(n >= 20, `${n} calls`);
  });
});
