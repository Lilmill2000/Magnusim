// RH1 (spec 3.15, 3.16): the Assistant's CFD guide and the one advice text.
// - In Magnusim the guide is in all four places the model reads its rules: the request's system
//   blocks (after the system prompt, before a workspace's notes), the MCP instructions, an agent
//   whose note goes in its system prompt (session/new's _meta), and an agent's first prompt
//   (right after the note). At most 2,500 characters.
// - In Magnusim CAD it is in none of them: every text passes the simulation-word ban.
// (The advice texts: advice-consistency.test.mjs.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSISTANT = join(WEB, 'scripts', 'server', 'assistant');
const { cfdGuide, cfdGuideText, withCfdGuide, CFD_GUIDE_MAX } = await import('../server/assistant/cfdGuide.ts');
const { buildRequest } = await import('../server/assistant/loop.ts');
const { sessionNewParams, agentNote } = await import('../server/assistant/agents/acp.ts');
const { mcpInstructions } = await import('../server/assistant/mcp/server.ts');
const { systemPrompt } = await import('../server/assistant/prompt.ts');

const SIMULATION = /\b(simulat\w*|CFD|mesh\w*|solv\w*|run(s|ning)?\b|Courant|turbulen\w*)/i;
/** An agent hook whose note goes in its system prompt (as the first agent's does). */
const HOOK = { carriesNote: true, meta: (note) => ({ systemPrompt: { append: note } }) };
const bridge = { command: 'node', script: '/x/assistant-mcp.mjs', binding: 'b-000000000000000000000000', info: '/x/mcp.json' };
const conv = (guide = null) => ({ id: 'c1', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], guide });
const settings = { model: 'm', effort: 'default' };

describe('the CFD guide in Magnusim', () => {
  it('is at most 2,500 characters and names its rules', () => {
    const g = cfdGuideText();
    assert.ok(g.length <= CFD_GUIDE_MAX, `${g.length} characters`);
    assert.ok(g.startsWith('Judging and fixing CFD runs\n1. Is a run healthy:'));
    assert.match(g, /never present it as accurate or converged/);
  });

  it('goes in the system blocks after the prompt, before the workspace notes, with one cache mark', () => {
    const req = buildRequest(conv({ text: 'Notes.', pluginName: 'Demo' }), [], settings);
    assert.equal(req.system.length, 3);
    assert.equal(req.system[0].text, systemPrompt());
    assert.equal(req.system[1].text, cfdGuideText());
    assert.match(req.system[2].text, /Notes\.$/);
  });

  it('goes in the MCP instructions and in an agent note in its system prompt', () => {
    assert.equal(withCfdGuide(mcpInstructions()), `${mcpInstructions()}\n\n${cfdGuideText()}`);
    const meta = sessionNewParams('/w', bridge, { sessionMeta: HOOK })._meta;
    assert.equal(meta.systemPrompt.append, `${agentNote()}\n\n${cfdGuideText()}`);
    // The MCP server and the agents' first prompt use it (one helper each).
    assert.match(readFileSync(join(ASSISTANT, 'mcp', 'server.ts'), 'utf8'), /const rules = withCfdGuide\(mcpInstructions\(\)\);/);
    assert.match(readFileSync(join(ASSISTANT, 'agents', 'turn.ts'), 'utf8'), /out\.push\(noteBlock\(\)\);\n\s+\/\/ RH1[^\n]*\n\s+const cfd = cfdGuide\(\);\n\s+if \(cfd\) out\.push\(\{ type: 'text', text: cfd \}\);/);
  });
});

describe('the CFD guide in Magnusim CAD', () => {
  it('is in none of the places, and every text passes the simulation-word ban', () => {
    process.env.MAGNUSIM_EDITION = 'cad';
    try {
      assert.equal(cfdGuide(), null);
      const req = buildRequest(conv(), [], settings);
      assert.equal(req.system.length, 1);
      for (const s of req.system) assert.doesNotMatch(s.text, SIMULATION);
      const mcp = withCfdGuide(mcpInstructions());
      assert.equal(mcp, mcpInstructions());
      assert.doesNotMatch(mcp, SIMULATION);
      const meta = sessionNewParams('/w', bridge, { sessionMeta: HOOK })._meta;
      assert.equal(meta.systemPrompt.append, agentNote());
      assert.doesNotMatch(meta.systemPrompt.append, SIMULATION);
    } finally {
      delete process.env.MAGNUSIM_EDITION;
    }
  });
});
