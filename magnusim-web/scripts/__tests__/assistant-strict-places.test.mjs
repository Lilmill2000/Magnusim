// A cloud provider's few strict places (Anthropic: STRICT_LIMITS.tools) go to the tools that
// matter most, not to the first by name: in the workbench the app's tools are offered by name, and
// the places go the pinned first, then by priority (anthropic.ts strictOf). wait, setup_edit,
// study_edit and compute go strict; the Settings tools (the lowest priorities) are the ones left
// loose. In a workspace its own tools still come first, by name. The tools offered, their order
// and their bytes are as before: only which go strict.
// SPDX-License-Identifier: GPL-3.0-or-later
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-strict-places-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { emitSchema } = await import('../server/assistant/schema.ts');
const { strictOf, STRICT_LIMITS } = await import('../server/assistant/providers/anthropic.ts');
const { createToolRegistry, providerTools } = await import('../server/assistant/registry.ts');
const { createHostTools } = await import('../server/assistant/host-tools.ts');
const { createJobTools } = await import('../server/assistant/host/job-tools.ts');
const { CORE_TOOLS } = await import('../../src/assistant/coreToolDefs.ts');

/** A cloud turn at `place` with the app's host tools and the window's core page: its tools, and which go strict. */
function cloudTurn(place, workspaceTools = []) {
  const hostTools = [
    ...createHostTools({ hostCall: async () => ({}), assistant: async () => ({ provider: 'off', model: '' }), version: async () => '0.0.0', plugins: () => [] }),
    ...createJobTools({ call: async () => ({}) }),
  ];
  const registry = createToolRegistry({ hostTools, pluginEpoch: () => 'e1' });
  if (workspaceTools.length) {
    const v = registry.setWorkspace('T1', 'L1', { plugin: 'demo', pluginName: 'Demo', workspace: 'w', workspaceName: 'W', projectId: 'p1', studyId: 's1', tools: workspaceTools });
    assert.deepEqual(v.refused, []);
  }
  assert.deepEqual(registry.setCore('T1', 'L1', { projectId: 'p1', studyId: 's1', place, tools: CORE_TOOLS.map((t) => ({ ...t })), guide: '' }).refused, []);
  const { tools } = registry.selectTools({ tab: 'T1', projectId: 'p1', simulationId: 's1', cloud: true, local: false, place, budgetTokens: null, prompt: null });
  const sent = providerTools(tools);
  const strict = strictOf(sent, sent.map((t) => emitSchema('anthropic', t.schema)), false);
  return { names: tools.map((t) => t.name), strict: new Set(tools.filter((_, i) => strict[i]).map((t) => t.name)), loose: tools.filter((_, i) => !strict[i]).map((t) => t.name), sent };
}

describe('the strict places', () => {
  it('a cloud workbench turn sends wait, setup_edit, study_edit and compute strict; the lowest priorities go loose', () => {
    const turn = cloudTurn('workbench');
    assert.ok(turn.names.length > STRICT_LIMITS.tools, `${turn.names.length} tools: more than the strict places`);
    assert.deepEqual(turn.names, [...turn.names].sort(), 'offered by name, as before');
    for (const name of ['wait', 'setup_edit', 'study_edit', 'compute', 'core__show']) assert.ok(turn.strict.has(name), `${name} strict`);
    assert.equal(turn.strict.size, STRICT_LIMITS.tools);
    assert.deepEqual(turn.loose, ['core__appearance', 'core__set_appearance']);
    // Never sent: what decides it.
    assert.ok(turn.sent.some((t) => t.priority === 82 && t.name === 'wait'));
  });

  it("a workspace's own tools still take the places first, by name", () => {
    const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
    const tools = Array.from({ length: 22 }, (_, i) => ({ name: `t${String(i).padStart(2, '0')}`, description: 'Does a thing.', inputSchema: EMPTY, risk: 'read' }));
    const turn = cloudTurn('workspace', tools);
    const own = turn.names.filter((n) => n.startsWith('demo__'));
    assert.deepEqual(turn.names.slice(0, own.length), own, 'its tools first');
    assert.deepEqual(
      own.filter((n) => turn.strict.has(n)),
      own.slice(0, STRICT_LIMITS.tools),
    );
    assert.equal(turn.strict.size, STRICT_LIMITS.tools);
  });
});
