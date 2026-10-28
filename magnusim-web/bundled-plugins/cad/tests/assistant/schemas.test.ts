// @vitest-environment node
// The Part's 20 Assistant tools as the app gets them (CAD tools spec §3, §12.1): names, risks,
// stall windows and confirm note; every object lists every property in `required` (no strict
// optional budget spent); only the schema subset's keywords; descriptions at most 1024
// characters at every depth; each schema at most 6 KB and the registration at most 64 KB; no
// vendor names; and schemas.ts loads nothing at run time (the app's host test imports it with
// Node's type stripping). The app's own checks of the same set: scripts/__tests__/assistant-cad-tools.test.mjs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUIDE } from '../../src/assistant/guide';
import { CAD_TOOLS, CORE_TOOLSET, HELP_TOPICS, toolNamed, TOOL_NAMES } from '../../src/assistant/schemas';
import { namesVendor } from './vendor';

type Node = Record<string, unknown>;

const KEYWORDS: Record<string, string[]> = {
  object: ['type', 'description', 'properties', 'required', 'additionalProperties'],
  string: ['type', 'description', 'enum', 'minLength', 'maxLength'],
  number: ['type', 'description', 'minimum', 'maximum'],
  integer: ['type', 'description', 'minimum', 'maximum'],
  boolean: ['type', 'description'],
  array: ['type', 'description', 'items', 'minItems', 'maxItems'],
};

/** Every schema node with its path and depth (the root is depth 1, as the app counts). */
function nodes(n: Node, path = '', depth = 1): { n: Node; path: string; depth: number }[] {
  const out = [{ n, path: path || '(root)', depth }];
  if (n.type === 'object') for (const [k, v] of Object.entries(n.properties as Record<string, Node>)) out.push(...nodes(v, path ? `${path}.${k}` : k, depth + 1));
  if (n.type === 'array') out.push(...nodes(n.items as Node, `${path}[]`, depth + 1));
  return out;
}


describe('the 21 tools', () => {
  it('are the spec\'s 21, by name, with their titles, risks and stall windows', () => {
    expect(TOOL_NAMES).toEqual(['body', 'combine', 'construct', 'delete', 'direct', 'edit_feature', 'extrude', 'find', 'get_model', 'help', 'hole', 'measure', 'modify', 'pattern', 'revolve', 'set_params', 'sketch', 'sweep_loft', 'undo', 'view', 'workspace']);
    for (const t of CAD_TOOLS) expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    for (const t of CAD_TOOLS) expect(t.name.includes('__'), t.name).toBe(false);
    const risks = Object.fromEntries(CAD_TOOLS.map((t) => [t.name, t.risk]));
    expect(risks).toEqual({
      body: 'edit',
      combine: 'edit',
      construct: 'edit',
      delete: 'destructive',
      direct: 'edit',
      edit_feature: 'edit',
      extrude: 'edit',
      find: 'read',
      get_model: 'read',
      help: 'read',
      hole: 'edit',
      measure: 'read',
      modify: 'edit',
      pattern: 'edit',
      revolve: 'edit',
      set_params: 'edit',
      sketch: 'edit',
      sweep_loft: 'edit',
      undo: 'edit',
      view: 'read',
      workspace: 'edit',
    });
    const windows = Object.fromEntries(CAD_TOOLS.map((t) => [t.name, t.timeoutS]));
    expect(windows).toEqual({
      body: 60,
      combine: 180,
      construct: 180,
      delete: 120,
      direct: 240,
      edit_feature: 180,
      extrude: 180,
      find: 90,
      get_model: 60,
      help: 30,
      hole: 240,
      measure: 120,
      modify: 240,
      pattern: 240,
      revolve: 180,
      set_params: 180,
      sketch: 180,
      sweep_loft: 240,
      undo: 120,
      view: 90,
      workspace: 180,
    });
    expect(toolNamed('get_model')?.title).toBe('Read the Part');
    expect(toolNamed('undo')?.title).toBe('Undo or redo');
    expect(toolNamed('workspace')?.title).toBe('Workspace and view');
    for (const t of CAD_TOOLS) expect(t.title, t.name).toBeTruthy();
  });

  it('delete alone asks, and its question says Ctrl+Z brings the features back (at most 120 characters)', () => {
    expect(CAD_TOOLS.filter((t) => t.confirm).map((t) => t.name)).toEqual(['delete']);
    const note = toolNamed('delete')!.confirm!;
    expect(note).toBe('Deletes features from the Part; one Undo takes back the whole request, this deletion with it.');
    expect(note.length).toBeLessThanOrEqual(120);
  });

  it('every object lists every property in required and says additionalProperties false', () => {
    for (const t of CAD_TOOLS) {
      for (const { n, path } of nodes(t.inputSchema as unknown as Node)) {
        if (n.type !== 'object') continue;
        expect(n.additionalProperties, `${t.name} ${path}`).toBe(false);
        expect([...(n.required as string[])].sort(), `${t.name} ${path}`).toEqual(Object.keys(n.properties as object).sort());
        expect(Object.keys(n.properties as object).length, `${t.name} ${path}`).toBeLessThanOrEqual(16);
      }
    }
  });

  it('use only the subset\'s keywords (no $ref, unions, patterns, formats, defaults, consts, titles or type lists), nest at most 5 deep', () => {
    for (const t of CAD_TOOLS) {
      for (const { n, path, depth } of nodes(t.inputSchema as unknown as Node)) {
        expect(typeof n.type, `${t.name} ${path}`).toBe('string');
        const allowed = KEYWORDS[n.type as string];
        expect(allowed, `${t.name} ${path}: type ${String(n.type)}`).toBeTruthy();
        for (const k of Object.keys(n)) expect(allowed, `${t.name} ${path}: ${k}`).toContain(k);
        expect(depth, `${t.name} ${path}`).toBeLessThanOrEqual(5);
        if (n.enum) expect(new Set(n.enum as string[]).size, `${t.name} ${path}`).toBe((n.enum as string[]).length);
      }
    }
    // The sketch is the deepest: root, entities, an entity, at, a number.
    const at = nodes(toolNamed('sketch')!.inputSchema as unknown as Node).find((x) => x.path === 'entities[].at[]');
    expect(at?.depth).toBe(5);
  });

  it('describe themselves in at most 1024 characters at every depth, on one line, and every field says what it takes', () => {
    for (const t of CAD_TOOLS) {
      expect(t.description.length, t.name).toBeLessThanOrEqual(1024);
      expect(t.description, t.name).not.toMatch(/[\r\n\t]/);
      for (const { n, path } of nodes(t.inputSchema as unknown as Node)) {
        if (path === '(root)') continue;
        // A list's row object is described by its list.
        if (n.type === 'object' && path.endsWith('[]')) continue;
        expect(typeof n.description, `${t.name} ${path}`).toBe('string');
        expect((n.description as string).length, `${t.name} ${path}`).toBeLessThanOrEqual(1024);
      }
    }
  });

  it('are each at most 6 KB, and the whole registration (with the guide) at most 64 KB', () => {
    for (const t of CAD_TOOLS) expect(Buffer.byteLength(JSON.stringify(t.inputSchema)), t.name).toBeLessThanOrEqual(6 * 1024);
    const reg = Buffer.byteLength(JSON.stringify({ tools: CAD_TOOLS, guide: GUIDE }));
    expect(reg).toBeLessThanOrEqual(64 * 1024);
  });

  it('name no vendor', () => {
    expect(namesVendor(JSON.stringify(CAD_TOOLS))).toBe(false);
    expect(namesVendor(readFileSync(fileURLToPath(new URL('../../src/assistant/schemas.ts', import.meta.url)), 'utf8'))).toBe(false);
    // The check bites.
    expect(namesVendor(Buffer.from('dXNlIGNvcGlsb3Q=', 'base64').toString('utf8'))).toBe(true);
  });

  it('the help topics, the core set and the enums the guide uses exist', () => {
    expect(HELP_TOPICS).toEqual(['sketch', 'selectors', 'features', 'parameters', 'checks', 'traps', 'errors', 'examples', 'example_plate', 'example_bracket', 'example_flange', 'example_chip', 'guide', 'sketch_tools', 'details', 'workspace']);
    expect((toolNamed('help')!.inputSchema.properties.topic as { enum: string[] }).enum).toEqual([...HELP_TOPICS]);
    expect(CORE_TOOLSET).toHaveLength(13);
    for (const n of CORE_TOOLSET) expect(TOOL_NAMES).toContain(n);
  });

  it('schemas.ts and guide.ts load nothing at run time (type imports only)', () => {
    for (const file of ['schemas.ts', 'guide.ts']) {
      const src = readFileSync(fileURLToPath(new URL(`../../src/assistant/${file}`, import.meta.url)), 'utf8');
      const imports = [...src.matchAll(/^import\s+(?!type\s)[^;]*;/gm)].map((m) => m[0]);
      expect(imports, file).toEqual([]);
      expect(src, file).not.toMatch(/\brequire\(|\bimport\(/);
    }
  });
});
