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

  it('rule 8 offers at_continue only where the person gets "Use when continuing": a stopped transient run whose study is still Transient', () => {
    const rule8 = cfdGuideText().split('\n').find((l) => l.startsWith('8. '));
    assert.ok(rule8.startsWith('8. A stopped transient run (its study still Transient): its Max Courant, outer and pressure correctors and max time step can apply on Continue'), rule8);
  });

  it('rule 8 (RH3) says a Continue after a study numerics change needs numerics "new" or "as_was", asked of the person, with no lane tag', () => {
    const rule8 = cfdGuideText().split('\n').find((l) => l.startsWith('8. '));
    assert.ok(rule8.endsWith(' After a study numerics change, run_continue needs numerics "new" or "as_was": ask too.'), rule8);
    // The A2 choice (at_continue or start_over) is the person's as well (RH1).
    assert.ok(rule8.includes('(type "start_over", results deleted): ask the person; later changes of the four join the pending one.'), rule8);
    assert.doesNotMatch(rule8, /\[RH\d\]/);
  });

  it('rule 9 (RH2) names the pre-run check, its what-if values and its cost, with no lane tag', () => {
    const g = cfdGuideText();
    const rule9 = g.split('\n').find((l) => l.startsWith('9. '));
    assert.equal(rule9, '9. Before a run: read_results precheck, with proposed values to compare; give the cost (steps, time) from its estimate.');
    assert.doesNotMatch(g, /\[RH\d\]/);
  });

  it("rule 10 (RH3) ends with the first-order caution's sentence, with no lane tag", () => {
    const rule10 = cfdGuideText().split('\n').find((l) => l.startsWith('10. '));
    assert.ok(rule10.endsWith(' First-order schemes lower accuracy: fix the time step or mesh first.'), rule10);
  });

  it('rule 10 gives only the y+ that were tested: k-omega SST on the developed wedge, not "under 0.5 resolves the wall" for every model', () => {
    const rule10 = cfdGuideText().split('\n').find((l) => l.startsWith('10. '));
    assert.ok(rule10.includes('y+ (field_range of yPlus): k-omega SST: within 4.5% at 5-100 on a clean mesh, 6-9% low at 1-3;'), rule10);
    assert.ok(rule10.includes('wall functions assume 30-300.'), rule10);
    assert.doesNotMatch(rule10, /resolves the wall|any y\+/);
  });

  it("rule 10 says what the Study panel's model help says of Standard's tetrahedra: a pipe from its inlet read 11-18% low, up to 31% with no layers, never 'within 4.5%' alone", () => {
    const rule10 = cfdGuideText().split('\n').find((l) => l.startsWith('10. '));
    assert.ok(rule10.includes('on Standard a pipe read 11-18% low, up to 31% with no layers;'), rule10);
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
