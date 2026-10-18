// The CAD Part's 18 Assistant tools against the app's own rules (CAD tools spec §3.0, §12.2): the
// schemas the Part registers (bundled-plugins/cad/src/assistant/schemas.ts, loaded here with
// Node's type stripping, as is its guide) pass the app's schema check; the strict dialects are
// sent only the keywords they take; in a CAD turn the app offers 21 tools (its 3, then the Part's
// 18 by name), the first 20 strict on the first cloud dialect and cad__view not; no CAD property
// is optional; 21 is within the local server's 24 and nothing is cut; the registration is within
// 512 KB; and what a local model reads before the conversation (the tools as sent, the CAD notes,
// the system prompt) is at most 52,000 characters, its estimated tokens printed.
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

const { CAD_TOOLS } = await import('../../bundled-plugins/cad/src/assistant/schemas.ts');
const { CORE_TOOLSET, TOOL_NAMES } = await import('../../bundled-plugins/cad/src/assistant/schemas.ts');
const { GUIDE, guideWithout } = await import('../../bundled-plugins/cad/src/assistant/guide.ts');
const { WORKED_PARTS } = await import('../../bundled-plugins/cad/src/assistant/examples.ts');
const sanitizeCopy = await import('../../bundled-plugins/cad/tests/assistant/sanitize-copy.ts');
const { checkSchema, emitSchema, STRICT_KEEP, validateInput } = await import('../server/assistant/schema.ts');
const { JSON_CAPS, resultText, TEXT_CAPS } = await import('../server/assistant/sanitize.ts');
const { strictFlags, STRICT_LIMITS } = await import('../server/assistant/providers/anthropic.ts');
const { createToolRegistry, providerTools, REGISTRATION_MAX_BYTES, REQUEST_MAX_TOOLS } = await import('../server/assistant/registry.ts');
const { createHostTools } = await import('../server/assistant/host-tools.ts');
const { SYSTEM_PROMPT, guideBlock } = await import('../server/assistant/prompt.ts');
const { estimateStep } = await import('../server/assistant/prices.ts');

/** What a local model reads before the conversation, at most (characters). */
const LOCAL_PREFIX_MAX = 52_000;

const hostTools = () =>
  createHostTools({
    hostGet: async () => ({}),
    assistant: async () => ({ provider: 'off', model: '' }),
    version: async () => '0.0.0',
    plugins: () => [],
  });

/** The tools the app offers a turn on the Part's tab, in order (the registry's own selection). */
function offered({ local = false } = {}) {
  const registry = createToolRegistry({ hostTools: hostTools(), pluginEpoch: () => 'e1' });
  const reg = { plugin: 'cad', pluginName: 'Magnusim CAD', workspace: 'part', workspaceName: 'Part', projectId: 'p1', studyId: 's1', tools: CAD_TOOLS.map((t) => ({ ...t })), guide: GUIDE };
  const verdict = registry.setWorkspace('T1', 'L1', reg);
  assert.deepEqual(verdict.refused, []);
  assert.equal(verdict.accepted.length, 18);
  return registry.selectTools({ tab: 'T1', projectId: 'p1', simulationId: 's1', cloud: !local, local });
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
    assert.equal(CAD_TOOLS.length, 18);
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

  it('a CAD turn offers 21: the app\'s 3, then the Part\'s 18 by name; the first 20 strict on the first cloud dialect, cad__view not', () => {
    const { tools, dropped } = offered();
    assert.deepEqual(dropped, []);
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ['app_status', 'explain_ready', 'project_summary', ...CAD_TOOLS.map((t) => `cad__${t.name}`)]);
    const flags = strictFlags(providerTools(tools).map((t) => emitSchema('anthropic', t.schema)));
    assert.deepEqual(flags, names.map((n) => n !== 'cad__view'));
    // The budget is exactly full: 20 strict tools; the host tools' one optional parameter.
    assert.equal(flags.filter(Boolean).length, STRICT_LIMITS.tools);
  });

  it("21 is within the local server's 24: nothing is cut", () => {
    const { tools, dropped } = offered({ local: true });
    assert.equal(tools.length, 21);
    assert.ok(tools.length <= REQUEST_MAX_TOOLS.local);
    assert.deepEqual(dropped, []);
  });

  it('the registration is within 512 KB', () => {
    const bytes = Buffer.byteLength(JSON.stringify({ tools: CAD_TOOLS, guide: GUIDE }), 'utf8');
    assert.ok(bytes <= REGISTRATION_MAX_BYTES, `${bytes} bytes`);
  });

  it(`what a local model reads before the conversation is at most ${LOCAL_PREFIX_MAX} characters`, () => {
    const { tools } = offered({ local: true });
    const sent = providerTools(tools).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: emitSchema('openai_compatible', t.schema) } }));
    const system = `${SYSTEM_PROMPT}\n${guideBlock(GUIDE, 'Magnusim CAD')}`;
    const chars = JSON.stringify(sent).length + system.length;
    const est = estimateStep({
      provider: 'openai_compatible',
      model: 'local',
      cloud: false,
      fallbackTargets: [],
      // As the turn's first request counts it: the system text, and a fixed share per tool.
      newChars: system.length,
      newImages: [],
      toolCount: tools.length,
      firstStep: true,
      prev: null,
      now: Date.now(),
      remainingUsd: 0,
    });
    console.log(`[assistant-cad-tools] local prefix: ${chars} characters (tools ${JSON.stringify(sent).length}, system ${system.length}), about ${est.promptTokens} tokens by the estimate's rule`);
    assert.ok(chars <= LOCAL_PREFIX_MAX, `${chars} characters`);
  });
});

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
