// The read and edit host tools' definitions (Core host tools spec 2.2): every schema passes
// the app's check, every property is required (unused fields take a sentinel, so a strict
// provider counts no optional parameter), enums stay within 64, and each definition as
// sent strict is at most 2,048 bytes, with short descriptions.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-schemas-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { createHostTools } = await import('../assistant/host-tools.ts');
const { checkSchema, emitSchema } = await import('../assistant/schema.ts');

after(() => rmSync(ROOT, { recursive: true, force: true }));

const TOOLS = createHostTools({ hostCall: async () => ({}), assistant: async () => ({ provider: 'off', model: '' }), version: async () => '0', plugins: () => [] });

function walk(node, path = '(root)', out = []) {
  out.push({ node, path });
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`, out);
  if (node.items) walk(node.items, `${path}[]`, out);
  return out;
}

describe('the host tools’ schemas', () => {
  it('are the twelve of this lane, each with its contexts and priority', () => {
    assert.deepEqual(
      TOOLS.map((t) => [t.name, t.priority, [...t.contexts]]),
      [
        ['app_status', 50, ['home', 'workbench', 'workspace']],
        ['catalog', 74, ['home', 'workbench']],
        ['projects', 40, ['home', 'workbench']],
        ['project_summary', 90, ['home', 'workbench', 'workspace']],
        ['read_setup', 95, ['home', 'workbench', 'workspace']],
        ['explain_ready', 78, ['home', 'workbench', 'workspace']],
        ['read_results', 76, ['home', 'workbench']],
        ['project_edit', 54, ['home', 'workbench']],
        ['study_edit', 86, ['workbench']],
        ['setup_edit', 88, ['workbench']],
        ['import_file', 56, ['workbench']],
        ['delete', 60, ['home', 'workbench']],
      ],
    );
  });

  for (const t of TOOLS) {
    it(`${t.name}: checked, every property required, enums ≤ 64, ≤ 2,048 bytes as sent strict`, () => {
      assert.deepEqual(checkSchema(t.schema), { ok: true });
      for (const { node, path } of walk(t.schema)) {
        if (node.type === 'object') {
          assert.equal(node.additionalProperties, false, path);
          assert.deepEqual([...(node.required ?? [])].sort(), Object.keys(node.properties ?? {}).sort(), `${path}: every property required`);
        }
        if (node.enum) assert.ok(node.enum.length <= 64, path);
        if (node.description) assert.ok(node.description.length <= 160, `${path}: ${node.description.length} characters`);
        for (const bad of ['oneOf', 'anyOf', '$ref', 'pattern', 'format']) assert.equal(node[bad], undefined, `${path}: ${bad}`);
      }
      assert.ok(t.description.length <= 400, `description ${t.description.length}`);
      const sent = JSON.stringify({ name: t.name, description: t.description, input_schema: emitSchema('anthropic', t.schema) });
      assert.ok(Buffer.byteLength(sent, 'utf8') <= 2048, `${t.name}: ${Buffer.byteLength(sent, 'utf8')} bytes`);
    });
  }

  it('the write tools say where changes go and what the sentinels are', () => {
    for (const name of ['study_edit', 'setup_edit', 'import_file']) assert.match(TOOLS.find((t) => t.name === name).description, /open here|Unused/);
    assert.ok(TOOLS.every((t) => t.source.kind === 'host' && t.localName === t.name));
  });
});
