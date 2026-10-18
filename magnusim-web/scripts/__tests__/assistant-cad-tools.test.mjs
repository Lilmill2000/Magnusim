// The CAD Part's 18 Assistant tools against the app's own rules (CAD tools spec §3.0, §12.2): the
// schemas the Part registers (bundled-plugins/cad/src/assistant/schemas.ts, loaded here with
// Node's type stripping, as is its guide) pass the app's schema check; the strict dialects are
// sent only the keywords they take; in a CAD turn the app offers 21 tools (its 3, then the Part's
// 18 by name), the first 20 strict on the first cloud dialect and cad__view not; no CAD property
// is optional; 21 is within the local server's 24 and nothing is cut; the registration is within
// 512 KB; and what a local model reads before the conversation (the tools as sent, the CAD notes,
// the system prompt) is at most 52,000 characters, its estimated tokens printed.
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
const { GUIDE } = await import('../../bundled-plugins/cad/src/assistant/guide.ts');
const { checkSchema, emitSchema, STRICT_KEEP } = await import('../server/assistant/schema.ts');
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
